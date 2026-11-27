import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createSnapshotInventory,
  createSnapshotManifest,
  readSnapshotManifest,
  restoreSnapshot,
  snapshotId,
  validateSnapshotManifest,
  verifySnapshot,
  writeSnapshotManifest,
} from './index.mjs';

const I_IDS = Array.from({ length: 30 }, (_, index) => `I${String(index + 1).padStart(2, '0')}`);
const taskRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tasks');
const fixtureTaskIds = [
  'P01', 'P02', 'P03', 'P04',
  'B01', 'B02', 'B03', 'B04', 'B05', 'B06',
  ...I_IDS,
  'S01', 'S02', 'S03', 'S04',
];

async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-control-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeBase(baseDir, entries) {
  for (const [relativePath, contents] of Object.entries(entries)) {
    const filePath = path.join(baseDir, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
}

async function createJunctionOrSkip(t, target, junctionPath) {
  try {
    await symlink(target, junctionPath, 'junction');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Windows denied junction creation (${error.code})`);
      return false;
    }
    throw error;
  }
}

test('snapshot manifest and ID are stable and use sorted POSIX paths', async (t) => {
  const root = await sandbox(t);
  const one = path.join(root, 'one', 'base');
  const two = path.join(root, 'two', 'base');
  await mkdir(one, { recursive: true });
  await mkdir(two, { recursive: true });
  await writeBase(one, { 'z/file.txt': 'last', 'a.ts': 'first' });
  await writeBase(two, { 'a.ts': 'first', 'z/file.txt': 'last' });

  const first = await createSnapshotManifest(one);
  const second = await createSnapshotManifest(two);
  assert.deepEqual(first, {
    schemaVersion: 1,
    files: [
      { path: 'a.ts', sizeBytes: 5, sha256: 'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e' },
      { path: 'z/file.txt', sizeBytes: 4, sha256: '3547cb112ac4489af2310c0626cdba6f3097a2ad5a3b42ddd3b59c76c7a079a3' },
    ],
  });
  assert.deepEqual(second, first);
  assert.equal(snapshotId(first), snapshotId(second));
  assert.match(snapshotId(first), /^[a-f0-9]{64}$/);
  assert.equal(snapshotId(first), createHash('sha256').update(JSON.stringify(first), 'utf8').digest('hex'));
});

test('writes and reads a deterministic sidecar manifest beside base/', async (t) => {
  const root = await sandbox(t);
  const taskDir = path.join(root, 'P01');
  const base = path.join(taskDir, 'base');
  await mkdir(base, { recursive: true });
  await writeBase(base, { 'src/main.ts': 'export const answer = 42;\n' });

  const written = await writeSnapshotManifest(base);
  assert.equal(written.manifestPath, path.join(taskDir, 'snapshot.json'));
  assert.deepEqual(await readSnapshotManifest(written.manifestPath), written.manifest);
  await assert.rejects(writeSnapshotManifest(base), /already exists|EEXIST/i);
});

test('rejects a snapshot manifest reached through a symlink when the host permits one', async (t) => {
  const root = await sandbox(t);
  const base = path.join(root, 'base');
  await mkdir(base);
  await writeBase(base, { 'src/main.ts': 'export {};' });
  const written = await writeSnapshotManifest(base);
  const linkedManifest = path.join(root, 'linked-snapshot.json');
  try {
    await symlink(written.manifestPath, linkedManifest, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Host denied file symlink creation (${error.code})`);
      return;
    }
    throw error;
  }
  await assert.rejects(readSnapshotManifest(linkedManifest), /manifest is not an ordinary small file/);
});

test('restores exact bytes offline into a new destination and verifies the restored ID', async (t) => {
  const root = await sandbox(t);
  const base = path.join(root, 'P02', 'base');
  const restored = path.join(root, 'restored');
  await mkdir(base, { recursive: true });
  await writeBase(base, { 'src/main.ts': 'export const answer = 42;\n', 'test/main.test.ts': 'assert.equal(42, 42);\n' });
  const manifest = await createSnapshotManifest(base);
  const id = snapshotId(manifest);

  assert.deepEqual(await restoreSnapshot(base, manifest, restored, id), { snapshotId: id, manifest });
  assert.equal(await readFile(path.join(restored, 'src/main.ts'), 'utf8'), 'export const answer = 42;\n');
  assert.equal(await readFile(path.join(restored, 'test/main.test.ts'), 'utf8'), 'assert.equal(42, 42);\n');
  assert.deepEqual(await verifySnapshot(restored, manifest, id), { snapshotId: id, manifest });
});

test('rejects altered and missing source bytes before restoring', async (t) => {
  const root = await sandbox(t);
  const base = path.join(root, 'base');
  await mkdir(base);
  await writeBase(base, { 'src/a.ts': 'original' });
  const manifest = await createSnapshotManifest(base);
  const id = snapshotId(manifest);

  await writeFile(path.join(base, 'src/a.ts'), 'altered');
  await assert.rejects(verifySnapshot(base, manifest, id), /do not match/);
  await writeFile(path.join(base, 'src/a.ts'), 'original');
  await rm(path.join(base, 'src/a.ts'));
  await assert.rejects(restoreSnapshot(base, manifest, path.join(root, 'restore'), id), /do not match/);
});

test('rejects a mismatched ID, malformed paths, secret paths, and case collisions', async () => {
  const validFile = { path: 'src/a.ts', sizeBytes: 1, sha256: 'a'.repeat(64) };
  const manifest = { schemaVersion: 1, files: [validFile] };
  await assert.rejects(verifySnapshot(path.resolve('.'), manifest, 'b'.repeat(64)), /ID does not match/);
  for (const invalidPath of [
    '/absolute.txt', 'C:/absolute.txt', '../outside.txt', 'src/../outside.txt', '.env', '.env.local',
    ' .git/config', ' .env', 'docs/ *.md', 'docs/foo*.md ',
    'src/.git/config', 'src\\file.ts', 'src/file?.ts', 'src/name.', 'src/name ', 'src/NUL.txt',
    'credentials.json', 'credentials.prod.json', 'secrets.yaml', 'secrets.backup.yaml',
    '.npmrc', '.pypirc', '.netrc', 'id_rsa.pub', 'server.pem',
  ]) {
    assert.throws(() => validateSnapshotManifest({ schemaVersion: 1, files: [{ ...validFile, path: invalidPath }] }), /Invalid snapshot/);
  }
  assert.throws(() => validateSnapshotManifest({ schemaVersion: 1, files: [validFile, { ...validFile, path: 'SRC/A.TS' }] }), /case-insensitive path collision/);
});

test('preserves valid spaces and Unicode paths in the canonical v1 manifest', () => {
  const files = [
    { path: 'docs/Notas com espaço.md', sizeBytes: 1, sha256: 'a'.repeat(64) },
    { path: 'src/ação_日本語.ts', sizeBytes: 1, sha256: 'b'.repeat(64) },
    { path: 'src/credentialsManager.prod.json', sizeBytes: 1, sha256: 'c'.repeat(64) },
    { path: 'src/secretsBackup.yaml', sizeBytes: 1, sha256: 'd'.repeat(64) },
  ];
  const manifest = validateSnapshotManifest({ schemaVersion: 1, files });
  assert.deepEqual(manifest.files.map((file) => file.path), [
    'docs/Notas com espaço.md',
    'src/ação_日本語.ts',
    'src/credentialsManager.prod.json',
    'src/secretsBackup.yaml',
  ]);
  assert.equal(snapshotId(manifest).length, 64);
});

test('keeps all benchmark snapshot IDs and manifests unchanged', async () => {
  for (const taskId of fixtureTaskIds) {
    const taskDir = path.join(taskRoot, taskId);
    const task = JSON.parse(await readFile(path.join(taskDir, 'task.json'), 'utf8'));
    const manifest = await readSnapshotManifest(path.join(taskDir, 'snapshot.json'));
    assert.equal(snapshotId(manifest), task.base_snapshot_sha256, `${taskId} manifest ID`);
    assert.deepEqual(await createSnapshotManifest(path.join(taskDir, 'base')), manifest, `${taskId} manifest content`);
  }
});

test('snapshot inventory excludes only configured directories and reports relative paths', async (t) => {
  const root = await sandbox(t);
  const base = path.join(root, 'source');
  await mkdir(path.join(base, '.git'), { recursive: true });
  await mkdir(path.join(base, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(base, 'src'), { recursive: true });
  await writeFile(path.join(base, '.git', 'config'), 'ignored');
  await writeFile(path.join(base, 'node_modules', 'pkg', 'index.js'), 'ignored');
  await writeFile(path.join(base, 'src', 'main.ts'), 'included');

  const inventory = await createSnapshotInventory(base, { excludeDirectories: ['.git', 'node_modules'] });
  assert.deepEqual(inventory.excludedPaths, ['.git', 'node_modules']);
  assert.deepEqual(inventory.manifest.files.map((file) => file.path), ['src/main.ts']);
});

test('rejects symlinks and junction-style links', async (t) => {
  const root = await sandbox(t);
  const base = path.join(root, 'base');
  const outside = path.join(root, 'outside.txt');
  await mkdir(base);
  await writeFile(outside, 'outside');
  try {
    await symlink(outside, path.join(base, 'link.txt'));
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('Windows symlink creation is unavailable in this environment');
      return;
    }
    throw error;
  }
  await assert.rejects(createSnapshotManifest(base), /symlink or junction/);
});

test('rejects a directory junction inside the snapshot base', async (t) => {
  const root = await sandbox(t);
  const base = path.join(root, 'base');
  const target = path.join(root, 'target');
  await mkdir(base);
  await mkdir(target);
  await writeFile(path.join(target, 'outside.ts'), 'kept inside temp');
  if (!(await createJunctionOrSkip(t, target, path.join(base, 'junction')))) return;

  await assert.rejects(createSnapshotManifest(base), /symlink|junction|reparse/i);
});

test('refuses to overwrite a non-empty destination', async (t) => {
  const root = await sandbox(t);
  const ordinaryBase = path.join(root, 'ordinary');
  const destination = path.join(root, 'existing');
  await mkdir(ordinaryBase);
  await mkdir(destination);
  await writeFile(path.join(ordinaryBase, 'a.txt'), 'safe');
  await writeFile(path.join(destination, 'keep.txt'), 'keep');
  const manifest = await createSnapshotManifest(ordinaryBase);
  await assert.rejects(restoreSnapshot(ordinaryBase, manifest, destination), /destination must be empty/);
  assert.equal(await readFile(path.join(destination, 'keep.txt'), 'utf8'), 'keep');
});

test('refuses a destination nested inside the source base', async (t) => {
  const root = await sandbox(t);
  const base = path.join(root, 'base');
  await mkdir(base);
  await writeFile(path.join(base, 'a.txt'), 'safe');
  const manifest = await createSnapshotManifest(base);

  await assert.rejects(restoreSnapshot(base, manifest, path.join(base, 'restored')), /overlap the source base/);
  assert.deepEqual(await createSnapshotManifest(base), manifest);
});

test('rejects a destination reached through an ancestral directory junction', async (t) => {
  const root = await sandbox(t);
  const base = path.join(root, 'base');
  const alias = path.join(root, 'base-alias');
  await mkdir(base);
  await writeFile(path.join(base, 'a.txt'), 'safe');
  const manifest = await createSnapshotManifest(base);
  if (!(await createJunctionOrSkip(t, base, alias))) return;

  const aliasedDestination = path.join(alias, 'restore');
  await assert.rejects(restoreSnapshot(base, manifest, aliasedDestination), /symlink|junction|reparse/i);
  await assert.rejects(lstat(path.join(base, 'restore')), { code: 'ENOENT' });
  assert.deepEqual(await createSnapshotManifest(base), manifest);
});
