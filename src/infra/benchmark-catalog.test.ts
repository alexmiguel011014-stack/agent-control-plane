import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BenchmarkCatalogError, LocalBenchmarkCatalog } from './benchmark-catalog.ts';
import { validateTaskEnvelopeV1 } from '../domain/task.ts';
import { LocalSnapshotStore } from './local-snapshot-store.ts';

/** Walks up from this file (src/infra or dist/src/infra) to the repository root that holds bench/tasks. */
function findRepositoryRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, 'package.json')) && existsSync(path.join(current, 'bench', 'tasks'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('repository_root_not_found');
}

let temp: string;
let root: string;
let store: LocalSnapshotStore;
const hashes: Record<string, string> = {};

async function makeTask(id: string, options: { hash?: string } = {}): Promise<void> {
  const dir = path.join(root, 'bench', 'tasks', id);
  await mkdir(path.join(dir, 'base', 'src'), { recursive: true });
  await writeFile(path.join(dir, 'base', 'src', 'a.mjs'), `export const id = '${id}';\n`);
  const scratch = new LocalSnapshotStore(path.join(temp, `scratch-${id}`));
  const receipt = await scratch.capture(path.join(dir, 'base'));
  hashes[id] = receipt.snapshotSha256;
  await writeFile(path.join(dir, 'snapshot.json'), JSON.stringify({ schemaVersion: 1, files: [] }));
  await writeFile(path.join(dir, 'task.json'), JSON.stringify({
    task_id: id,
    prompt: `Fix ${id}.`,
    base_snapshot_sha256: options.hash ?? receipt.snapshotSha256,
    allowed_globs: ['src/**/*.mjs'],
    timeout_ms: 600000,
    public_test_command_id: `${id.toLowerCase()}-public-tests`,
    allowed_operations: ['read_text', 'list_files', 'apply_unified_diff', 'run_declared_test', 'git_diff'],
  }));
}

function catalog(taskIds: readonly string[]): LocalBenchmarkCatalog {
  return new LocalBenchmarkCatalog({ repositoryRoot: root, snapshots: store, taskIds });
}

describe('LocalBenchmarkCatalog', () => {
  before(async () => {
    temp = await realpath(await mkdtemp(path.join(tmpdir(), 'bench-catalog-')));
    root = path.join(temp, 'repo');
    await mkdir(root, { recursive: true });
    store = new LocalSnapshotStore(path.join(temp, 'snapshots'));
    await makeTask('B01');
    await makeTask('B02');
    await makeTask('B03', { hash: 'f'.repeat(64) });
  });

  after(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('serves the G2 and G3 suites by default and an unknown suite is refused', async () => {
    const c = new LocalBenchmarkCatalog({ repositoryRoot: root, snapshots: store });
    const suites = await c.listSuites();
    assert.deepEqual(suites.map((s) => [s.suiteId, s.taskIds.length]), [['g2-local-pure-localized', 10], ['g3-local-small-integrations', 30], ['g20-tuning-policy', 4]]);
    const measured = new Set([...suites[0]!.taskIds, ...suites[1]!.taskIds]);
    assert.ok(suites[2]!.taskIds.every((id) => !measured.has(id)), 'the tuning suite is disjoint from the measurement suites');
    assert.deepEqual(suites[1]!.taskIds, Array.from({ length: 30 }, (_, index) => `I${String(index + 1).padStart(2, '0')}`));
    await assert.rejects(c.getSuite('nope'), { code: 'unknown_suite' });
  });

  it('lists the suite and builds envelope inputs', async () => {
    const c = catalog(['B01', 'B02']);
    const suites = await c.listSuites();
    assert.deepEqual(suites.map((s) => [s.suiteId, s.taskIds]), [['g2-local-pure-localized', ['B01', 'B02']]]);
    const suite = await c.getSuite('g2-local-pure-localized');
    assert.equal(suite.tasks.length, 2);
    const first = suite.tasks[0]!;
    assert.equal(first.benchmarkTaskId, 'B01');
    assert.deepEqual(first.envelopeInput, {
      schemaVersion: 1,
      prompt: 'Fix B01.',
      requestedOperations: ['write'],
      allowedPaths: ['src/**/*.mjs'],
      declaredTests: [],
      baseSnapshotSha256: hashes.B01,
    });
    const text = JSON.stringify(suite);
    for (const banned of ['run_declared_test', 'read_text', 'list_files', 'git_diff']) {
      assert.equal(text.includes(banned), false, banned);
    }
  });

  it('builds envelope inputs that validateTaskEnvelopeV1 accepts', async () => {
    const realRoot = findRepositoryRoot();
    const suites = [
      await catalog(['B01', 'B02']).getSuite('g2-local-pure-localized'),
      await new LocalBenchmarkCatalog({ repositoryRoot: realRoot, snapshots: store, taskIds: ['B01'] })
        .getSuite('g2-local-pure-localized'),
    ];
    for (const suite of suites) {
      for (const task of suite.tasks) {
        const result = validateTaskEnvelopeV1({
          ...task.envelopeInput,
          taskId: `${task.benchmarkTaskId.toLowerCase()}-run-1`,
          schemaVersion: 1,
        });
        assert.equal(result.valid, true, JSON.stringify(result));
      }
    }
  });

  it('refuses a task whose snapshot ID differs from base_snapshot_sha256', async () => {
    await assert.rejects(catalog(['B03']).getSuite('g2-local-pure-localized'), (e: unknown) =>
      e instanceof BenchmarkCatalogError && e.code === 'snapshot_mismatch');
  });

  it('refuses unknown suite and unknown task', async () => {
    await assert.rejects(catalog(['B01']).getSuite('nope'), (e: unknown) =>
      e instanceof BenchmarkCatalogError && e.code === 'unknown_suite');
    await assert.rejects(catalog(['B09']).getSuite('g2-local-pure-localized'), (e: unknown) =>
      e instanceof BenchmarkCatalogError && e.code === 'unknown_task');
  });

  it('refuses a symlinked task.json', async (t) => {
    await makeTask('B04');
    const taskJson = path.join(root, 'bench', 'tasks', 'B04', 'task.json');
    const real = path.join(root, 'bench', 'tasks', 'B04', 'task-real.json');
    await rm(taskJson);
    await writeFile(real, '{}');
    try {
      await symlink(real, taskJson, 'file');
    } catch {
      t.skip('symlink creation not permitted');
      return;
    }
    await assert.rejects(catalog(['B04']).getSuite('g2-local-pure-localized'), (e: unknown) =>
      e instanceof BenchmarkCatalogError && e.code === 'catalog_file_unsafe');
  });

  it('registers attempts and maps them back', () => {
    const c = catalog(['B01', 'B02']);
    c.registerAttempt('b01-run-20261110-1', 'B01');
    c.registerAttempt('b02-run-20261110-2', 'B02');
    c.registerAttempt('b01-run-20261110-1', 'B01');
    assert.equal(c.benchmarkTaskIdFor('b01-run-20261110-1'), 'B01');
    assert.equal(c.benchmarkTaskIdFor('b02-run-20261110-2'), 'B02');
    assert.throws(() => c.benchmarkTaskIdFor('b01-other-1'), /unknown_attempt/);
  });

  it('rejects malformed attempt IDs and tasks outside the suite', () => {
    const c = catalog(['B01']);
    assert.throws(() => c.registerAttempt('B01-run-1', 'B01'), /invalid_attempt_id/);
    assert.throws(() => c.registerAttempt('b01-run', 'B01'), /invalid_attempt_id/);
    assert.throws(() => c.registerAttempt('b01-run-0', 'B01'), /invalid_attempt_id/);
    assert.throws(() => c.registerAttempt('b05-run-1', 'B05'), /unknown_task/);
    assert.throws(() => c.registerAttempt('b02-run-1', 'B01'), /attempt_task_mismatch/);
  });

  it('real B01 snapshot ID equals its base_snapshot_sha256', async () => {
    const realRoot = findRepositoryRoot();
    const real = new LocalBenchmarkCatalog({
      repositoryRoot: realRoot,
      snapshots: store,
      taskIds: ['B01'],
    });
    const suite = await real.getSuite('g2-local-pure-localized');
    assert.equal(suite.tasks[0]!.envelopeInput.baseSnapshotSha256,
      '43a3ae78b85246ae949207a686a88d893aa37ef8d7f30e8bd14a192ff83bdecb');
  });
});
