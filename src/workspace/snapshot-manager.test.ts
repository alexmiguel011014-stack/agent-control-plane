import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertSnapshotPath, createSnapshotInventory, readSnapshotManifest } from '../snapshots/snapshot-core.mjs';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import { LocalSnapshotStore } from '../infra/local-snapshot-store.ts';
import { parseUnifiedDiff } from '../tools/tool-gateway.ts';
import { SnapshotWorkspaceManager, WorkspaceExportError, WorkspacePatchError } from './snapshot-manager.ts';

const repositoryRoot = process.cwd();

async function temporaryDirectory(): Promise<string> {
  const runtimeDirectory = path.join(repositoryRoot, '.agentctl');
  await mkdir(runtimeDirectory, { recursive: true });
  return mkdtemp(path.join(runtimeDirectory, 'g1-workspace-test-'));
}

async function createSource(root: string): Promise<string> {
  const source = path.join(root, 'source space ü');
  await mkdir(path.join(source, 'src', 'nested'), { recursive: true });
  await mkdir(path.join(source, 'docs'), { recursive: true });
  await writeFile(path.join(source, 'src', 'nested', 'ação module.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(path.join(source, 'docs', 'Guide α.md'), 'guide\n', 'utf8');
  for (const name of ['.git', '.agentctl', 'node_modules', '.venv']) {
    await mkdir(path.join(source, name), { recursive: true });
    await writeFile(path.join(source, name, 'excluded.txt'), 'excluded', 'utf8');
  }
  return source;
}

function envelope(snapshotSha256: string, taskId = 'workspace-task'): TaskEnvelopeV1 {
  return Object.freeze({
    schemaVersion: 1,
    taskId,
    prompt: 'private prompt must never enter the audit file',
    requestedOperations: Object.freeze(['read', 'write'] as const),
    allowedPaths: Object.freeze(['src/**/*.ts']),
    declaredTests: Object.freeze([]),
    baseSnapshotSha256: snapshotSha256,
  });
}

async function setup(source?: string) {
  const root = await temporaryDirectory();
  const sourceDirectory = source ?? await createSource(root);
  const stateDirectory = path.join(root, '.agentctl');
  const snapshots = new LocalSnapshotStore(path.join(stateDirectory, 'snapshots'));
  const receipt = await snapshots.capture(sourceDirectory);
  const manager = new SnapshotWorkspaceManager({ stateDirectory, snapshots });
  return { root, sourceDirectory, stateDirectory, snapshots, receipt, manager };
}

test('captures safe local files by content hash, reports exclusions, and keeps source bytes unchanged', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createSource(root);
  const original = await readFile(path.join(source, 'src', 'nested', 'ação module.ts'), 'utf8');
  const store = new LocalSnapshotStore(path.join(root, '.agentctl', 'snapshots'));

  const first = await store.capture(source);
  const retry = await store.capture(source);
  assert.match(first.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.excludedPaths, ['.agentctl', '.git', '.venv', 'node_modules']);
  assert.equal(first.reused, false);
  assert.equal(retry.reused, true);
  assert.equal(await readFile(path.join(source, 'src', 'nested', 'ação module.ts'), 'utf8'), original);
  assert.equal(JSON.stringify(first).includes(source), false);
  assert.equal((await store.resolve(first.snapshotSha256))?.snapshotSha256, first.snapshotSha256);
});

test('publishes concurrent same-hash captures without replacing stored bytes', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createSource(root);
  const storeRoot = path.join(root, '.agentctl', 'snapshots-race');
  await mkdir(storeRoot, { recursive: true });
  const store = new LocalSnapshotStore(storeRoot);

  const receipts = await Promise.all([store.capture(source), store.capture(source)]);
  assert.equal(receipts[0].snapshotSha256, receipts[1].snapshotSha256);
  assert.equal((await store.resolve(receipts[0].snapshotSha256))?.snapshotSha256, receipts[0].snapshotSha256);
});

test('restores two independent workspaces, filters concrete protected paths, and audits without prompts or host paths', async (t) => {
  const setupResult = await setup();
  t.after(() => rm(setupResult.root, { recursive: true, force: true }));
  const { manager, receipt, stateDirectory } = setupResult;
  const firstEnvelope = envelope(receipt.snapshotSha256, 'task-one');
  const first = await manager.allocate(firstEnvelope, 'exec-one');
  const second = await manager.allocate(envelope(receipt.snapshotSha256, 'task-two'), 'exec-two');
  const workspaceDirectories = await readdir(path.join(stateDirectory, 'workspaces'));
  const firstDirectory = path.join(stateDirectory, 'workspaces', workspaceDirectories.find((name) => name === first.workspaceId)!);
  const secondDirectory = path.join(stateDirectory, 'workspaces', workspaceDirectories.find((name) => name === second.workspaceId)!);
  const file = path.join(firstDirectory, 'src', 'nested', 'ação module.ts');

  assert.equal((await manager.verifyBeforeRun({ envelope: firstEnvelope, workspace: first, executionId: 'exec-one' })).outcome, 'allow');
  await writeFile(file, 'export const value = 2;\n', 'utf8');
  assert.equal(await readFile(path.join(secondDirectory, 'src', 'nested', 'ação module.ts'), 'utf8'), 'export const value = 1;\n');
  const afterTools = await manager.verifyAfterPhase({
    envelope: firstEnvelope,
    workspace: first,
    executionId: 'exec-one',
    phase: 'after_tools',
  });
  assert.deepEqual(afterTools, { outcome: 'allow', changedPaths: ['src/nested/ação module.ts'] });
  await writeFile(file, 'export const value = 3;\n', 'utf8');
  assert.deepEqual(await manager.verifyAfterPhase({
    envelope: firstEnvelope,
    workspace: first,
    executionId: 'exec-one',
    phase: 'after_evaluator',
  }), {
    outcome: 'deny',
    reasonCode: 'workspace_changed_after_tools',
    changedPaths: ['src/nested/ação module.ts'],
  });

  await writeFile(path.join(firstDirectory, '.env'), 'should not expose', 'utf8');
  await writeFile(path.join(firstDirectory, '.env.local'), 'should not list', 'utf8');
  await writeFile(path.join(firstDirectory, 'COM¹.txt'), 'device alias', 'utf8');
  await mkdir(path.join(firstDirectory, '.git'), { recursive: true });
  await writeFile(path.join(firstDirectory, '.git', 'config'), 'protected', 'utf8');
  for (const name of ['credentials.json', 'credentials.prod.json', 'secrets.yaml', 'secrets.backup.yaml', '.npmrc', '.pypirc', '.netrc']) {
    await writeFile(path.join(firstDirectory, name), 'protected', 'utf8');
  }
  const visible = await manager.listAllowed({ workspace: first, allowedPatterns: ['**/*'], maxResults: 10_000 });
  assert.deepEqual(visible, ['docs/Guide α.md', 'src/nested/ação module.ts']);
  for (const relativePath of [
    ' .git/config', ' .env', 'credentials.json', 'credentials.prod.json',
    'secrets.yaml', 'secrets.backup.yaml', '.npmrc', '.pypirc', '.netrc',
  ]) {
    assert.equal(await manager.resolveAllowed({
      workspace: first,
      relativePath,
      operation: 'read',
      allowedPatterns: ['**/*'],
    }), null, relativePath);
  }
  const allowed = await manager.resolveAllowed({
    workspace: first,
    relativePath: 'src/nested/ação module.ts',
    operation: 'read',
    allowedPatterns: ['src/**/*.ts'],
  });
  assert.ok(allowed);
  assert.equal(allowed.relativePath, 'src/nested/ação module.ts');
  assert.equal(allowed.token.includes(stateDirectory), false);

  const audit = await readFile(path.join(stateDirectory, 'workspace-audit', 'integrity.jsonl'), 'utf8');
  assert.equal(audit.includes(firstEnvelope.prompt), false);
  assert.equal(audit.includes(stateDirectory), false);
  assert.equal(audit.includes(`"snapshotSha256":"${receipt.snapshotSha256}"`), true);
  assert.equal(audit.includes(`"workspaceRelativePath":"workspaces/${first.workspaceId}"`), true);
  assert.equal(audit.includes('src/nested/ação module.ts'), true);
});

test('stops workspace listing after the requested cap plus one overflow sentinel', async (t) => {
  const setupResult = await setup();
  t.after(() => rm(setupResult.root, { recursive: true, force: true }));
  const { manager, receipt, stateDirectory } = setupResult;
  const workspace = await manager.allocate(envelope(receipt.snapshotSha256), 'exec-list-cap');
  const directory = path.join(stateDirectory, 'workspaces', workspace.workspaceId, 'src');
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) {
    await writeFile(path.join(directory, name), name, 'utf8');
  }

  const listed = await manager.listAllowed({
    workspace,
    allowedPatterns: ['src/**/*.ts'],
    maxResults: 2,
  });
  assert.equal(listed.length, 3);
  assert.ok(listed.every((relativePath) => relativePath.startsWith('src/')));
});

test('scopes the listing cap to a requested directory while ignoring many files elsewhere', async (t) => {
  const setupResult = await setup();
  t.after(() => rm(setupResult.root, { recursive: true, force: true }));
  const { manager, receipt, stateDirectory } = setupResult;
  const workspace = await manager.allocate(envelope(receipt.snapshotSha256), 'exec-list-prefix');
  const directory = path.join(stateDirectory, 'workspaces', workspace.workspaceId);
  await writeFile(path.join(directory, 'src', 'small.ts'), 'inside', 'utf8');
  for (let index = 0; index < 6; index += 1) {
    await writeFile(path.join(directory, 'docs', `outside-${index}.md`), 'outside', 'utf8');
  }

  const listed = await manager.listAllowed({
    workspace,
    allowedPatterns: ['**/*'],
    maxResults: 2,
    prefix: 'src',
  });
  assert.deepEqual(listed, ['src/nested/ação module.ts', 'src/small.ts']);
});

test('denies modifications outside allowed paths, deletions, and protected or redirected workspaces', async (t) => {
  const setupResult = await setup();
  t.after(() => rm(setupResult.root, { recursive: true, force: true }));
  const { manager, receipt, stateDirectory } = setupResult;
  const task = envelope(receipt.snapshotSha256, 'task-outside-path');
  const workspace = await manager.allocate(task, 'exec-outside');
  const workspaceDirectory = path.join(stateDirectory, 'workspaces', workspace.workspaceId);
  await writeFile(path.join(workspaceDirectory, 'outside.txt'), 'not allowed', 'utf8');
  const result = await manager.verifyAfterPhase({ envelope: task, workspace, executionId: 'exec-two', phase: 'after_tools' });
  assert.deepEqual(result, {
    outcome: 'deny',
    reasonCode: 'workspace_change_outside_policy',
    changedPaths: ['outside.txt'],
  });

  const second = await manager.allocate(envelope(receipt.snapshotSha256, 'task-delete'), 'exec-delete');
  const secondDirectory = path.join(stateDirectory, 'workspaces', second.workspaceId);
  await rm(path.join(secondDirectory, 'docs', 'Guide α.md'));
  const deleted = await manager.verifyAfterPhase({
    envelope: envelope(receipt.snapshotSha256, 'task-delete'),
    workspace: second,
    executionId: 'exec-three',
    phase: 'after_tools',
  });
  assert.equal(deleted.outcome, 'deny');
  if (deleted.outcome === 'deny') assert.equal(deleted.reasonCode, 'workspace_change_outside_policy');
});

test('reads through concrete path revalidation and produces bounded baseline-relative whole-file diffs', async (t) => {
  const setupResult = await setup();
  t.after(() => rm(setupResult.root, { recursive: true, force: true }));
  const { manager, receipt, stateDirectory } = setupResult;
  const task = envelope(receipt.snapshotSha256, 'task-tool-read-diff');
  const workspace = await manager.allocate(task, 'exec-read-diff');
  const relativePath = 'src/nested/ação module.ts';
  const original = await manager.readText({
    workspace,
    relativePath,
    allowedPatterns: task.allowedPaths,
    maxBytes: 1024,
  });
  assert.equal(original, 'export const value = 1;\n');
  await assert.rejects(manager.readText({
    workspace,
    relativePath: '.env',
    allowedPatterns: ['**/*'],
    maxBytes: 1024,
  }));

  const workspaceFile = path.join(stateDirectory, 'workspaces', workspace.workspaceId, 'src', 'nested', 'ação module.ts');
  await writeFile(workspaceFile, 'export const value = 2;\n', 'utf8');
  const diff = await manager.gitDiff({
    workspace,
    allowedPatterns: task.allowedPaths,
    maxOutputBytes: 4096,
  });
  assert.equal(diff.includes(`diff --git a/${relativePath} b/${relativePath}`), true);
  assert.equal(diff.includes('-export const value = 1;'), true);
  assert.equal(diff.includes('+export const value = 2;'), true);
  assert.equal(diff.includes(stateDirectory), false);
  await assert.rejects(manager.gitDiff({
    workspace,
    allowedPatterns: task.allowedPaths,
    relativePaths: ['.env'],
    maxOutputBytes: 4096,
  }));
  await assert.rejects(manager.gitDiff({
    workspace,
    allowedPatterns: task.allowedPaths,
    maxOutputBytes: 1,
  }));
});

test('keeps legacy workspace test paths write-protected and rejects post-tool edits', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createSource(root);
  const testPath = 'tests/smoke.mjs';
  await mkdir(path.join(source, 'tests'), { recursive: true });
  await writeFile(path.join(source, testPath), 'test("fixture", () => {});\n', 'utf8');
  const stateDirectory = path.join(root, '.agentctl');
  const snapshots = new LocalSnapshotStore(path.join(stateDirectory, 'snapshots'));
  const receipt = await snapshots.capture(source);
  const manager = new SnapshotWorkspaceManager({ stateDirectory, snapshots });
  const task: TaskEnvelopeV1 = Object.freeze({
    ...envelope(receipt.snapshotSha256, 'task-test-readonly'),
    requestedOperations: Object.freeze(['read', 'write', 'process'] as const),
    allowedPaths: Object.freeze(['src/**/*.ts', 'tests/**/*.mjs']),
    declaredTests: Object.freeze([{ id: 'smoke', profile: 'node-test' as const, path: testPath }]),
  });
  const workspace = await manager.allocate(task, 'exec-test-readonly');
  assert.equal(await manager.resolveAllowed({
    workspace,
    relativePath: testPath,
    operation: 'write',
    allowedPatterns: ['**/*'],
  }), null);
  assert.equal(await manager.resolveAllowed({
    workspace,
    relativePath: 'TESTS/SMOKE.MJS',
    operation: 'write',
    allowedPatterns: ['**/*'],
  }), null);
  await writeFile(path.join(stateDirectory, 'workspaces', workspace.workspaceId, testPath), 'test("changed", () => {});\n', 'utf8');
  assert.deepEqual(await manager.verifyAfterPhase({
    envelope: task,
    workspace,
    executionId: 'exec-test-readonly',
    phase: 'after_tools',
  }), {
    outcome: 'deny',
    reasonCode: 'workspace_change_outside_policy',
    changedPaths: [testPath],
  });
});

test('audits a partial allocation failure and preserves its workspace for inspection', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createSource(root);
  const snapshots = new LocalSnapshotStore(path.join(root, '.agentctl', 'snapshots'));
  const receipt = await snapshots.capture(source);
  const stateDirectory = path.join(root, '.agentctl');
  let allocationStartedBeforeResolve = false;
  const failingSnapshots = {
    resolve: async (snapshotSha256: string) => {
      const auditPath = path.join(stateDirectory, 'workspace-audit', 'integrity.jsonl');
      const audit = await readFile(auditPath, 'utf8');
      allocationStartedBeforeResolve = audit.includes('"phase":"allocation","result":"started"');
      return snapshots.resolve(snapshotSha256);
    },
    restore: async (_snapshotSha256: string, destinationDirectory: string) => {
      await mkdir(destinationDirectory, { recursive: true });
      await writeFile(path.join(destinationDirectory, 'partial.txt'), 'partial restore', 'utf8');
      throw new Error('restore failed with a host path that must not be logged');
    },
  };
  const manager = new SnapshotWorkspaceManager({ stateDirectory, snapshots: failingSnapshots });
  const task = envelope(receipt.snapshotSha256, 'task-partial-restore');

  await assert.rejects(manager.allocate(task, 'exec-partial'), /workspace_allocation_failed/);
  assert.equal(allocationStartedBeforeResolve, true);
  const auditPath = path.join(stateDirectory, 'workspace-audit', 'integrity.jsonl');
  const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
    taskId: string;
    executionId: string;
    snapshotSha256: string;
    workspaceRelativePath: string;
    phase: string;
    result: string;
  });
  assert.deepEqual(audit.map(({ phase, result }) => [phase, result]), [
    ['allocation', 'started'],
    ['allocation', 'deny'],
  ]);
  assert.ok(audit.every((record) => record.taskId === task.taskId && record.executionId === 'exec-partial'));
  assert.ok(audit.every((record) => record.snapshotSha256 === receipt.snapshotSha256));
  assert.match(audit[0]!.workspaceRelativePath, /^workspaces\/[a-f0-9-]+$/);
  const partialDirectory = path.join(stateDirectory, audit[0]!.workspaceRelativePath);
  assert.equal(await readFile(path.join(partialDirectory, 'partial.txt'), 'utf8'), 'partial restore');
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(task.prompt), false);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes('restore failed'), false);
});

test('rejects unsafe source names, corrupt stored snapshots, unknown hashes, and restore overwrite', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const unsafeRoot = path.join(root, 'unsafe');
  await mkdir(unsafeRoot);
  const store = new LocalSnapshotStore(path.join(root, '.agentctl', 'snapshots'));
  const manager = new SnapshotWorkspaceManager({ stateDirectory: path.join(root, '.agentctl'), snapshots: store });
  await assert.rejects(manager.allocate(envelope('f'.repeat(64), 'task-unknown-hash'), 'exec-unknown'));
  for (const name of [
    '.env.local', ' .env', 'id_rsa', 'id_rsa.pub', 'COM¹.txt', 'name.',
    'credentials.json', 'credentials.prod.json', 'secrets.yaml', 'secrets.backup.yaml',
    '.npmrc', '.pypirc', '.netrc', 'server.pem',
  ]) {
    const source = path.join(unsafeRoot, name);
    await writeFile(source, 'private', 'utf8');
    await assert.rejects(store.capture(unsafeRoot));
    await rm(source);
  }
  const leadingGitDirectory = path.join(unsafeRoot, ' .git');
  await mkdir(leadingGitDirectory);
  await writeFile(path.join(leadingGitDirectory, 'config'), 'must not capture', 'utf8');
  await assert.rejects(store.capture(unsafeRoot));
  await rm(leadingGitDirectory, { recursive: true, force: true });

  const leadingSpaceGlobDirectory = path.join(unsafeRoot, ' docs');
  await mkdir(leadingSpaceGlobDirectory);
  await writeFile(path.join(leadingSpaceGlobDirectory, 'example.md'), 'must not capture', 'utf8');
  await assert.rejects(store.capture(unsafeRoot));
  await rm(leadingSpaceGlobDirectory, { recursive: true, force: true });
  assert.throws(() => assertSnapshotPath('stream.txt:secret'));

  if (process.platform === 'win32') {
    const adsSource = path.join(root, 'ads-source');
    await mkdir(adsSource);
    await writeFile(path.join(adsSource, 'ordinary.txt'), 'default stream', 'utf8');
    await writeFile(`${path.join(adsSource, 'ordinary.txt')}:secret`, 'must not be copied', 'utf8');
    const adsReceipt = await store.capture(adsSource);
    assert.equal(adsReceipt.fileCount, 1);
    assert.equal(adsReceipt.totalBytes, Buffer.byteLength('default stream'));
    const storedFile = path.join(root, '.agentctl', 'snapshots', adsReceipt.snapshotSha256, 'base', 'ordinary.txt');
    assert.equal(await readFile(storedFile, 'utf8'), 'default stream');
    await assert.rejects(readFile(`${storedFile}:secret`));
    const restoredDirectory = path.join(root, 'restored-ads');
    await store.restore(adsReceipt.snapshotSha256, restoredDirectory);
    await assert.rejects(readFile(`${path.join(restoredDirectory, 'ordinary.txt')}:secret`));
  }

  const source = await createSource(root);
  const receipt = await store.capture(source);
  assert.equal(await store.resolve('f'.repeat(64)), null);
  const existingDestination = path.join(root, 'occupied');
  await mkdir(existingDestination);
  await writeFile(path.join(existingDestination, 'keep.txt'), 'keep', 'utf8');
  await assert.rejects(store.restore(receipt.snapshotSha256, existingDestination));
  assert.equal(await readFile(path.join(existingDestination, 'keep.txt'), 'utf8'), 'keep');

  const storedFile = path.join(root, '.agentctl', 'snapshots', receipt.snapshotSha256, 'base', 'docs', 'Guide α.md');
  await writeFile(storedFile, 'corrupted', 'utf8');
  await assert.rejects(store.resolve(receipt.snapshotSha256));
});

test('resolves and restores the benchmark fixture catalog without changing its snapshot IDs', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const tasksDirectory = path.join(repositoryRoot, 'bench', 'tasks');
  const entries = await readdir(tasksDirectory, { withFileTypes: true });
  const knownSnapshots = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const taskDirectory = path.join(tasksDirectory, entry.name);
    const task = JSON.parse(await readFile(path.join(taskDirectory, 'task.json'), 'utf8')) as { base_snapshot_sha256: string };
    knownSnapshots.push({
      snapshotSha256: task.base_snapshot_sha256,
      baseDirectory: path.join(taskDirectory, 'base'),
      manifest: await readSnapshotManifest(path.join(taskDirectory, 'snapshot.json')),
    });
  }
  assert.equal(knownSnapshots.length, 44);
  const store = new LocalSnapshotStore(path.join(root, '.agentctl', 'snapshots'), { knownSnapshots });
  for (const known of knownSnapshots) {
    assert.equal((await store.resolve(known.snapshotSha256))?.snapshotSha256, known.snapshotSha256);
  }
});

test('rejects a source symlink or junction when the host permits creating one', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside');
  await mkdir(source);
  await mkdir(outside);
  await writeFile(path.join(outside, 'outside.txt'), 'outside', 'utf8');
  try {
    await symlink(outside, path.join(source, 'redirect'), 'junction');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip('host does not permit creating a directory junction');
      return;
    }
    throw error;
  }
  const store = new LocalSnapshotStore(path.join(root, '.agentctl', 'snapshots'));
  await assert.rejects(store.capture(source));
});

const MULTI_LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

async function setupPatchWorkspace(t: test.TestContext) {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createSource(root);
  await writeFile(path.join(source, 'src', 'multi.ts'), `${MULTI_LINES.join('\n')}\n`, 'utf8');
  const result = await setup(source);
  const task = envelope(result.receipt.snapshotSha256, 'task-apply');
  const workspace = await result.manager.allocate(task, 'exec-apply');
  const directory = path.join(result.stateDirectory, 'workspaces', workspace.workspaceId);
  return { ...result, task, workspace, directory };
}

function patchInput(workspace: { workspaceId: string }, diff: string, paths?: readonly string[]) {
  const plan = parseUnifiedDiff(diff);
  return {
    workspace,
    plan,
    paths: (paths ?? plan.changedPaths).map((relativePath) => ({ relativePath, token: 'test-token' })),
  };
}

async function manifestOf(directory: string): Promise<string> {
  return JSON.stringify((await createSnapshotInventory(directory)).manifest);
}

async function temporaryNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true });
  return entries.filter((name) => name.endsWith('.tmp'));
}

async function auditRecords(stateDirectory: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(stateDirectory, 'workspace-audit', 'integrity.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function assertPatchRefused(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof WorkspacePatchError && error.code === code);
}

const ONE_FILE_DIFF = [
  'diff --git a/src/nested/ação module.ts b/src/nested/ação module.ts',
  '--- a/src/nested/ação module.ts',
  '+++ b/src/nested/ação module.ts',
  '@@ -1,1 +1,1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
].join('\n');

const MULTI_HUNK_DIFF = [
  'diff --git a/src/multi.ts b/src/multi.ts',
  '--- a/src/multi.ts',
  '+++ b/src/multi.ts',
  '@@ -1,5 +1,5 @@',
  ' line 1',
  '-line 2',
  '+LINE 2',
  ' line 3',
  ' line 4',
  ' line 5',
  '@@ -15,6 +15,7 @@',
  ' line 15',
  ' line 16',
  ' line 17',
  '-line 18',
  '+LINE 18',
  '+line 18.5',
  ' line 19',
  ' line 20',
  '',
].join('\n');

test('apply modifies one file, audits the relative path only, and leaves no temp file', async (t) => {
  const { manager, workspace, directory, stateDirectory } = await setupPatchWorkspace(t);
  await manager.apply(patchInput(workspace, ONE_FILE_DIFF));
  assert.equal(await readFile(path.join(directory, 'src', 'nested', 'ação module.ts'), 'utf8'), 'export const value = 2;\n');
  assert.deepEqual(await temporaryNames(directory), []);
  const last = (await auditRecords(stateDirectory)).at(-1) ?? {};
  assert.equal(last.phase, 'apply_unified_diff');
  assert.equal(last.result, 'allow');
  assert.deepEqual(last.modifiedPaths, ['src/nested/ação module.ts']);
  assert.equal(JSON.stringify(last).includes(stateDirectory), false);
});

test('apply handles multiple hunks and creates a new file', async (t) => {
  const { manager, workspace, directory } = await setupPatchWorkspace(t);
  await manager.apply(patchInput(workspace, MULTI_HUNK_DIFF));
  const expected = [...MULTI_LINES];
  expected[1] = 'LINE 2';
  expected.splice(17, 1, 'LINE 18', 'line 18.5');
  assert.equal(await readFile(path.join(directory, 'src', 'multi.ts'), 'utf8'), `${expected.join('\n')}\n`);

  await manager.apply(patchInput(workspace, [
    '--- /dev/null',
    '+++ b/src/created.ts',
    '@@ -0,0 +1,2 @@',
    '+export const a = 1;',
    '+export const b = 2;',
    '',
  ].join('\n')));
  assert.equal(await readFile(path.join(directory, 'src', 'created.ts'), 'utf8'), 'export const a = 1;\nexport const b = 2;\n');
  await assertPatchRefused(manager.apply(patchInput(workspace, [
    '--- /dev/null',
    '+++ b/src/created.ts',
    '@@ -0,0 +1,1 @@',
    '+again',
    '',
  ].join('\n'))), 'target_exists');
  assert.deepEqual(await temporaryNames(directory), []);
});

test('apply refuses a context mismatch, a path set mismatch, and a policy path without changing the workspace', async (t) => {
  const { manager, workspace, directory, stateDirectory } = await setupPatchWorkspace(t);
  const before = await manifestOf(directory);
  // The gateway parser accepts a `diff --git` header only before the first file section.
  const secondFile = MULTI_HUNK_DIFF.split('\n').slice(1).join('\n').replace(' line 17', ' line seventeen');
  const mismatched = `${ONE_FILE_DIFF}${secondFile}`;
  assert.equal(parseUnifiedDiff(mismatched).changedPaths.length, 2);
  await assertPatchRefused(manager.apply(patchInput(workspace, mismatched)), 'hunk_mismatch');
  assert.equal(await manifestOf(directory), before);

  await assertPatchRefused(manager.apply(patchInput(workspace, ONE_FILE_DIFF, ['src/multi.ts'])), 'path_set_mismatch');
  await assertPatchRefused(
    manager.apply(patchInput(workspace, ONE_FILE_DIFF, ['src/nested/ação module.ts', 'src/multi.ts'])),
    'path_set_mismatch',
  );
  assert.equal(await manifestOf(directory), before);

  await assertPatchRefused(manager.apply(patchInput(workspace, [
    '--- a/docs/Guide α.md',
    '+++ b/docs/Guide α.md',
    '@@ -1,1 +1,1 @@',
    '-guide',
    '+changed',
    '',
  ].join('\n'))), 'path_denied');
  assert.equal(await manifestOf(directory), before);

  await writeFile(path.join(directory, 'src', 'crlf.ts'), 'a\r\nb\r\n', 'utf8');
  const withCrlf = await manifestOf(directory);
  await assertPatchRefused(manager.apply(patchInput(workspace, [
    '--- a/src/crlf.ts',
    '+++ b/src/crlf.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+c',
    '',
  ].join('\n'))), 'unsupported_text_format');
  assert.equal(await manifestOf(directory), withCrlf);
  assert.deepEqual(await temporaryNames(directory), []);
  const denied = (await auditRecords(stateDirectory)).filter((record) => record.phase === 'apply_unified_diff');
  assert.ok(denied.length >= 5 && denied.every((record) => record.result === 'deny'));
});

test('apply refuses a target behind a junction when the host permits creating one', async (t) => {
  const { root, manager, workspace, directory } = await setupPatchWorkspace(t);
  const outside = path.join(root, 'outside-target');
  await mkdir(outside);
  await writeFile(path.join(outside, 'x.ts'), 'outside\n', 'utf8');
  try {
    await symlink(outside, path.join(directory, 'src', 'redirect'), 'junction');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip('host does not permit creating a directory junction');
      return;
    }
    throw error;
  }
  await assertPatchRefused(manager.apply(patchInput(workspace, [
    '--- a/src/redirect/x.ts',
    '+++ b/src/redirect/x.ts',
    '@@ -1,1 +1,1 @@',
    '-outside',
    '+escaped',
    '',
  ].join('\n'))), 'path_denied');
  assert.equal(await readFile(path.join(outside, 'x.ts'), 'utf8'), 'outside\n');
  assert.deepEqual(await readdir(outside), ['x.ts']);
});

test('exportWorkspace writes a faithful copy and refuses unsafe destinations', async (t) => {
  const { root, manager, workspace, directory, stateDirectory } = await setupPatchWorkspace(t);
  await manager.apply(patchInput(workspace, ONE_FILE_DIFF));
  const destination = path.join(root, 'export-copy');
  await mkdir(destination);
  await manager.exportWorkspace(workspace, destination);
  assert.equal(await manifestOf(destination), await manifestOf(directory));
  assert.equal(await readFile(path.join(destination, 'src', 'nested', 'ação module.ts'), 'utf8'), 'export const value = 2;\n');
  const last = (await auditRecords(stateDirectory)).at(-1) ?? {};
  assert.equal(last.phase, 'export');
  assert.equal(last.result, 'allow');
  assert.deepEqual(last.modifiedPaths, ['src/nested/ação module.ts']);
  assert.equal(JSON.stringify(last).includes(root), false);

  const assertExportRefused = (promise: Promise<unknown>, code: string) => assert.rejects(
    promise,
    (error: unknown) => error instanceof WorkspaceExportError && error.code === code,
  );
  await assertExportRefused(manager.exportWorkspace(workspace, destination), 'destination_not_empty');
  await assertExportRefused(manager.exportWorkspace(workspace, 'relative-export'), 'destination_invalid');
  await assertExportRefused(manager.exportWorkspace(workspace, path.join(root, 'missing-export')), 'destination_invalid');
  await assertExportRefused(manager.exportWorkspace(workspace, path.join(directory, 'src')), 'destination_invalid');
});

test('exportWorkspace refuses a junction inside the workspace when the host permits creating one', async (t) => {
  const { root, manager, workspace, directory } = await setupPatchWorkspace(t);
  const outside = path.join(root, 'outside-export');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.ts'), 'outside\n', 'utf8');
  try {
    await symlink(outside, path.join(directory, 'src', 'redirect'), 'junction');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip('host does not permit creating a directory junction');
      return;
    }
    throw error;
  }
  const destination = path.join(root, 'export-junction');
  await mkdir(destination);
  await assert.rejects(
    manager.exportWorkspace(workspace, destination),
    (error: unknown) => error instanceof WorkspaceExportError && error.code === 'inventory_failed',
  );
  assert.deepEqual(await readdir(destination), []);
});
