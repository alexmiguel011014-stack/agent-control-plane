import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import { LocalTaskEnvelopeStore, TaskEnvelopeStoreIntegrityError } from './task-envelope-store.ts';

function envelope(taskId = 'task-store-1', prompt = 'Summarize the fixture.'): TaskEnvelopeV1 {
  return {
    schemaVersion: 1,
    taskId,
    prompt,
    requestedOperations: ['read'],
    allowedPaths: ['src/example.ts'],
    declaredTests: [],
    baseSnapshotSha256: 'b'.repeat(64),
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const parent = join(process.cwd(), 'runtime', 'test-temp');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

test('publishes immutable envelopes without overwriting task IDs', async (t) => {
  const root = await temporaryRoot('agentctl-envelope-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalTaskEnvelopeStore(join(root, 'runtime', 'tasks'));
  const task = envelope();
  const digest = 'a'.repeat(64);

  assert.equal(await store.saveIfAbsent(task, digest), 'created');
  assert.equal(await store.saveIfAbsent(task, digest), 'already_exists');
  assert.equal(await store.saveIfAbsent(envelope(task.taskId, 'changed'), 'c'.repeat(64)), 'conflict');
  const stored = await store.get(task.taskId);
  assert.equal(stored?.envelopeSha256, digest);
  assert.equal(stored?.envelope.prompt, task.prompt);
  assert.equal(Object.isFrozen(stored?.envelope), true);
  assert.equal(Object.isFrozen(stored?.envelope.requestedOperations), true);
  assert.deepEqual(stored?.envelope.declaredTests, []);
  assert.equal((await readFile(join(root, 'runtime', 'tasks', task.taskId, 'envelope.json'), 'utf8')).includes(task.prompt), true);
});

test('normalizes a legacy envelope without declaredTests and preserves its empty-list meaning', async (t) => {
  const root = await temporaryRoot('agentctl-envelope-legacy-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalTaskEnvelopeStore(join(root, 'tasks'));
  const task = envelope('task-store-legacy');
  await store.saveIfAbsent(task, 'a'.repeat(64));

  const file = join(root, 'tasks', task.taskId, 'envelope.json');
  const record = JSON.parse(await readFile(file, 'utf8')) as { envelope: Record<string, unknown> };
  delete record.envelope.declaredTests;
  await writeFile(file, `${JSON.stringify(record)}\n`, 'utf8');

  const stored = await store.get(task.taskId);
  assert.deepEqual(stored?.envelope.declaredTests, []);
});

test('persists pathless host harness IDs and rejects duplicate declarations', async (t) => {
  const root = await temporaryRoot('agentctl-envelope-tests-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalTaskEnvelopeStore(join(root, 'tasks'));
  const task = {
    ...envelope('task-store-test-declaration'),
    declaredTests: [{ id: 'smoke', profile: 'host-json-v1' as const }],
  };
  assert.equal(await store.saveIfAbsent(task, 'a'.repeat(64)), 'created');
  assert.deepEqual((await store.get(task.taskId))?.envelope.declaredTests, task.declaredTests);

  const file = join(root, 'tasks', task.taskId, 'envelope.json');
  const record = JSON.parse(await readFile(file, 'utf8')) as { envelope: Record<string, unknown> };
  record.envelope.declaredTests = [
    { id: 'same', profile: 'host-json-v1' },
    { id: 'same', profile: 'host-json-v1' },
  ];
  await writeFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  await assert.rejects(store.get(task.taskId), TaskEnvelopeStoreIntegrityError);
});

test('keeps legacy path-based declarations readable without rewriting them', async (t) => {
  const root = await temporaryRoot('agentctl-envelope-legacy-tests-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalTaskEnvelopeStore(join(root, 'tasks'));
  const task: TaskEnvelopeV1 = {
    ...envelope('task-store-legacy-test'),
    declaredTests: [{ id: 'smoke', profile: 'node-test', path: 'tests/smoke.mjs' }],
  };
  const digest = 'c'.repeat(64);
  assert.equal(await store.saveIfAbsent(task, digest), 'created');
  const stored = await store.get(task.taskId);
  assert.equal(stored?.envelopeSha256, digest);
  assert.deepEqual(stored?.envelope.declaredTests, task.declaredTests);
});

test('concurrent same-ID saves publish one canonical envelope', async (t) => {
  const root = await temporaryRoot('agentctl-envelope-race-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalTaskEnvelopeStore(join(root, 'tasks'));
  const task = envelope('task-store-race');
  const results = await Promise.all([
    store.saveIfAbsent(task, 'd'.repeat(64)),
    store.saveIfAbsent(task, 'd'.repeat(64)),
  ]);
  assert.deepEqual(results.sort(), ['already_exists', 'created']);
  assert.equal((await store.get(task.taskId))?.envelope.prompt, task.prompt);
});

test('fails closed and preserves a pre-existing empty task directory', async (t) => {
  const root = await temporaryRoot('agentctl-envelope-empty-target-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'tasks');
  const task = envelope('task-empty-target');
  const taskDirectory = join(directory, task.taskId);
  const store = new LocalTaskEnvelopeStore(directory);
  await mkdir(taskDirectory, { recursive: true });

  await assert.rejects(store.saveIfAbsent(task, 'e'.repeat(64)), TaskEnvelopeStoreIntegrityError);
  assert.deepEqual(await readdir(taskDirectory), []);
});

test('rejects unsafe IDs, hashes, and corrupt envelope records', async (t) => {
  const root = await temporaryRoot('agentctl-envelope-invalid-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'tasks');
  const store = new LocalTaskEnvelopeStore(directory);
  await assert.rejects(store.saveIfAbsent(envelope('../escape'), 'a'.repeat(64)), TaskEnvelopeStoreIntegrityError);
  await assert.rejects(store.saveIfAbsent(envelope('Task-Uppercase'), 'a'.repeat(64)), TaskEnvelopeStoreIntegrityError);
  await assert.rejects(store.saveIfAbsent(envelope(), 'bad-hash'), TaskEnvelopeStoreIntegrityError);

  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, 'task-store-1'));
  await writeFile(join(directory, 'task-store-1', 'envelope.json'), '{"schemaVersion":1}\n', 'utf8');
  await assert.rejects(store.get('task-store-1'), TaskEnvelopeStoreIntegrityError);
});

test('rejects a symlinked storage directory where the host permits creating one', async (t) => {
  const root = await temporaryRoot('agentctl-envelope-link-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  const linkDirectory = join(root, 'linked');
  await mkdir(outside);
  try {
    await symlink(outside, linkDirectory, 'junction');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
      t.skip('host denies creating a directory symlink or junction');
      return;
    }
    throw error;
  }
  const store = new LocalTaskEnvelopeStore(linkDirectory);
  await assert.rejects(store.saveIfAbsent(envelope(), 'a'.repeat(64)));
});

test('rejects a symlinked ancestor before creating storage beneath it', async (t) => {
  const root = await temporaryRoot('agentctl-envelope-link-parent-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  const linkDirectory = join(root, 'linked-parent');
  await mkdir(outside);
  try {
    await symlink(outside, linkDirectory, 'junction');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
      t.skip('host denies creating a directory symlink or junction');
      return;
    }
    throw error;
  }
  const store = new LocalTaskEnvelopeStore(join(linkDirectory, 'tasks'));
  await assert.rejects(store.saveIfAbsent(envelope(), 'a'.repeat(64)));
  await assert.rejects(readFile(join(outside, 'tasks'), 'utf8'), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT');
});
