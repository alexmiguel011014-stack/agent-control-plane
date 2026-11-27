import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ComparisonFilePort,
  type ComparisonTask,
  ComparisonServiceError,
  containsSecret,
  createComparisonServices,
  patchTargetPaths,
} from './comparison-services.ts';

const BASE = 'a'.repeat(64);
const TASK: ComparisonTask = Object.freeze({
  taskId: 'B02',
  prompt: 'Fix getLimit so 0 is valid.',
  allowedPaths: ['src/**/*.mjs'],
  baseSnapshotSha256: BASE,
  timeoutMs: 600_000,
  publicTestCommandId: 'b02-public-tests',
});
const GOOD_PATCH = [
  'diff --git a/src/limit.mjs b/src/limit.mjs',
  '--- a/src/limit.mjs',
  '+++ b/src/limit.mjs',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  '',
].join('\n');

function setup(task: ComparisonTask | null = TASK) {
  const files = new Map<string, string>();
  const port: ComparisonFilePort = {
    async readText(path) { return files.get(path) ?? null; },
    async writeNewText(path, text) {
      if (files.has(path)) throw new Error('exists');
      files.set(path, text);
    },
  };
  const services = createComparisonServices({
    tasks: { getTask: async () => task },
    files: port,
    recordDirectory: 'out',
  });
  return { files, services };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof ComparisonServiceError && error.code === code);
}

async function exported(files: Map<string, string>, services: ReturnType<typeof setup>['services']) {
  await services.exportPackage({ taskId: 'B02', outputPath: 'pkg.json' });
  return files.get('pkg.json')!;
}

const IMPORT = { packagePath: 'pkg.json', patchPath: 'p.diff', logPath: 'run.log' } as const;

test('export writes an immutable package with a content hash and refuses to overwrite', async () => {
  const { files, services } = setup();
  const result = await services.exportPackage({ taskId: 'B02', outputPath: 'pkg.json' });
  const pkg = JSON.parse(files.get('pkg.json')!) as Record<string, unknown>;
  assert.equal(pkg.baseSnapshotSha256, BASE);
  assert.equal(pkg.packageSha256, result.packageSha256);
  assert.equal(pkg.publicTestCommandId, 'b02-public-tests');
  await expectCode(services.exportPackage({ taskId: 'B02', outputPath: 'pkg.json' }), 'file_unavailable');
});

test('export refuses an unknown task and a prompt that contains a secret', async () => {
  await expectCode(setup(null).services.exportPackage({ taskId: 'B99', outputPath: 'p.json' }), 'unknown_task');
  const leaky = { ...TASK, prompt: 'use api_key = abcdef123456789' };
  await expectCode(setup(leaky).services.exportPackage({ taskId: 'B02', outputPath: 'p.json' }), 'secret_detected');
});

test('import accepts a valid patch and log and records hashes with the cost label', async () => {
  const { files, services } = setup();
  await exported(files, services);
  files.set('p.diff', GOOD_PATCH);
  files.set('run.log', 'tests: 3 passed\n');
  const { record, recordPath } = await services.importArtifacts(IMPORT);
  assert.equal(record.evaluatorStatus, 'pending');
  assert.equal(record.providerCost, 'unobservable_by_control_plane');
  assert.deepEqual(record.changedPaths, ['src/limit.mjs']);
  assert.match(recordPath, /^out\/b02-[0-9a-f]{12}\.json$/);
  assert.ok(files.has(recordPath));
});

test('import rejects a base snapshot id that no longer matches the catalog', async () => {
  const { files, services } = setup();
  await exported(files, services);
  files.set('p.diff', GOOD_PATCH);
  files.set('run.log', 'ok');
  const moved = createComparisonServices({
    tasks: { getTask: async () => ({ ...TASK, baseSnapshotSha256: 'b'.repeat(64) }) },
    files: { readText: async (p) => files.get(p) ?? null, writeNewText: async (p, t) => { files.set(p, t); } },
    recordDirectory: 'out',
  });
  await expectCode(moved.importArtifacts(IMPORT), 'base_snapshot_mismatch');
});

test('import rejects a tampered package, including a changed base snapshot id inside it', async () => {
  const { files, services } = setup();
  const pkg = JSON.parse(await exported(files, services)) as Record<string, unknown>;
  files.set('p.diff', GOOD_PATCH);
  files.set('run.log', 'ok');
  files.set('pkg.json', JSON.stringify({ ...pkg, baseSnapshotSha256: 'c'.repeat(64) }));
  await expectCode(services.importArtifacts(IMPORT), 'package_invalid');
  files.set('pkg.json', 'not json');
  await expectCode(services.importArtifacts(IMPORT), 'package_invalid');
  await expectCode(services.importArtifacts({ ...IMPORT, packagePath: 'missing.json' }), 'package_invalid');
});

test('import rejects a missing or empty log and a missing patch', async () => {
  const { files, services } = setup();
  await exported(files, services);
  files.set('p.diff', GOOD_PATCH);
  await expectCode(services.importArtifacts(IMPORT), 'log_missing');
  files.set('run.log', '   \n');
  await expectCode(services.importArtifacts(IMPORT), 'log_missing');
  files.set('run.log', 'ok');
  await expectCode(services.importArtifacts({ ...IMPORT, patchPath: 'none.diff' }), 'patch_missing');
});

test('import rejects patches outside the allowlist, deletions, creations and traversal', async () => {
  const { files, services } = setup();
  await exported(files, services);
  files.set('run.log', 'ok');
  const variants = [
    GOOD_PATCH.replaceAll('src/limit.mjs', 'package.json'),
    GOOD_PATCH.replaceAll('src/limit.mjs', 'src/limit.js'),
    GOOD_PATCH.replaceAll('src/limit.mjs', '../src/limit.mjs'),
    GOOD_PATCH.replaceAll('src/limit.mjs', 'src/../tests/x.mjs'),
    GOOD_PATCH.replace('+++ b/src/limit.mjs', '+++ /dev/null'),
    GOOD_PATCH.replace('--- a/src/limit.mjs', '--- /dev/null'),
    'just text without file headers\n',
  ];
  for (const patch of variants) {
    files.set('p.diff', patch);
    await expectCode(services.importArtifacts(IMPORT), 'patch_outside_allowlist');
  }
});

test('import rejects secrets in the patch or the log and writes no record', async () => {
  const { files, services } = setup();
  await exported(files, services);
  files.set('p.diff', `${GOOD_PATCH}+const key = "sk-abcdefghijklmnopqrstuv";\n`);
  files.set('run.log', 'ok');
  const before = files.size;
  await expectCode(services.importArtifacts(IMPORT), 'secret_detected');
  files.set('p.diff', GOOD_PATCH);
  files.set('run.log', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123');
  await expectCode(services.importArtifacts(IMPORT), 'secret_detected');
  assert.equal(files.size, before);
});

test('secret and path helpers', () => {
  assert.equal(containsSecret('-----BEGIN RSA PRIVATE KEY-----'), true);
  assert.equal(containsSecret('AKIAABCDEFGHIJKLMNOP'), true);
  assert.equal(containsSecret('password: hunter2hunter2'), true);
  assert.equal(containsSecret('the token budget is small'), false);
  assert.deepEqual(patchTargetPaths(GOOD_PATCH), ['src/limit.mjs']);
  assert.equal(patchTargetPaths('nothing'), null);
});
