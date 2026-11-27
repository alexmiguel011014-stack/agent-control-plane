import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createTaskCreatedEvent,
  createTaskStateChangedEvent,
  type TaskEvent,
} from '../domain/event.ts';
import { EventStoreBusyError, EventStoreConflictError } from '../application/ports/index.ts';
import { tryAcquireExclusiveFileLock } from './file-lock.ts';
import { JsonlTaskEventStore } from './jsonl-event-store.ts';

const taskHash = 'a'.repeat(64);
const timestamp = '2026-10-26T12:00:00.000Z';

function created(taskId: string) {
  return createTaskCreatedEvent({
    eventId: `created-${taskId}`,
    taskId,
    occurredAt: timestamp,
    actor: 'operator',
  }, taskHash);
}

function stateChanged(taskId: string) {
  return createTaskStateChangedEvent({
    eventId: `classified-${taskId}`,
    taskId,
    occurredAt: timestamp,
    actor: 'system',
    reasonCode: 'classified',
    envelopeSha256: taskHash,
  }, 'DRAFT', 'CLASSIFIED');
}

async function createStore(t: TestContext): Promise<{ directory: string; store: JsonlTaskEventStore }> {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'runtime', 'events');
  return { directory, store: new JsonlTaskEventStore(directory) };
}

test('appends prompt-free JSONL and resolves idempotency before expected version', async (t) => {
  const { directory, store } = await createStore(t);
  const event = created('task-events-1');
  assert.deepEqual(await store.append(event, { idempotencyKey: 'task.created:task-events-1', expectedVersion: 0 }), event);
  assert.deepEqual(await store.append(event, { idempotencyKey: 'task.created:task-events-1', expectedVersion: 99 }), event);
  await assert.rejects(store.append({ ...event, envelopeSha256: 'b'.repeat(64) }, {
    idempotencyKey: 'task.created:task-events-1',
    expectedVersion: 0,
  }), EventStoreConflictError);
  await assert.rejects(store.append(stateChanged('task-events-1'), {
    idempotencyKey: 'state:task-events-1:wrong-version',
    expectedVersion: 0,
  }), EventStoreConflictError);

  const events = await store.read('task-events-1');
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes('prompt'), false);
  assert.equal((await readFile(join(directory, 'task-events-1.jsonl'), 'utf8')).includes('prompt'), false);
});

test('rejects prompt-bearing event payloads and task IDs that could escape the stream directory', async (t) => {
  const { store } = await createStore(t);
  const event = { ...created('task-event-secret'), prompt: 'must not be logged' } as TaskEvent;
  await assert.rejects(store.append(event, { idempotencyKey: 'task.created:task-event-secret', expectedVersion: 0 }), EventStoreConflictError);
  await assert.rejects(store.read('../outside'), EventStoreConflictError);
  await assert.rejects(store.read('Task-Uppercase'), EventStoreConflictError);
  await assert.rejects(store.append(created('Task-Uppercase'), {
    idempotencyKey: 'task.created:Task-Uppercase',
    expectedVersion: 0,
  }), EventStoreConflictError);
});

test('repairs only an incomplete trailing record before the next append', async (t) => {
  const { directory, store } = await createStore(t);
  const first = created('task-events-tail');
  await store.append(first, { idempotencyKey: 'task.created:task-events-tail', expectedVersion: 0 });
  const path = join(directory, 'task-events-tail.jsonl');
  await appendFile(path, '{"schemaVersion":1,"partial":', 'utf8');

  assert.deepEqual(await store.read('task-events-tail'), [first]);
  const second = stateChanged('task-events-tail');
  await store.append(second, { idempotencyKey: 'state:task-events-tail:1:DRAFT:CLASSIFIED', expectedVersion: 1 });
  assert.deepEqual(await store.read('task-events-tail'), [first, second]);
});

test('fails closed on a malformed complete record', async (t) => {
  const { directory, store } = await createStore(t);
  const first = created('task-events-corrupt');
  await store.append(first, { idempotencyKey: 'task.created:task-events-corrupt', expectedVersion: 0 });
  const path = join(directory, 'task-events-corrupt.jsonl');
  await appendFile(path, '{"bad":}\n', 'utf8');
  await assert.rejects(store.read('task-events-corrupt'), EventStoreConflictError);
  assert.equal((await readFile(path, 'utf8')).endsWith('{"bad":}\n'), true);
});

test('enumerates only task streams with a committed creation event', async (t) => {
  const { directory, store } = await createStore(t);
  const event = created('task-visible');
  await store.append(event, { idempotencyKey: 'task.created:task-visible', expectedVersion: 0 });
  await writeFile(join(directory, 'task-orphan.jsonl'), '{"schemaVersion":1,"partial":', 'utf8');
  assert.deepEqual(await store.listTaskIds(), ['task-visible']);
  assert.equal((await readFile(join(directory, 'task-orphan.jsonl'), 'utf8')).length, 0);
});

test('returns busy rather than interleaving a stream append under a live lock', async (t) => {
  const { directory, store } = await createStore(t);
  const taskId = 'task-events-lock';
  const lockPath = join(directory, `.${taskId}.lock`);
  await store.append(created(taskId), { idempotencyKey: `task.created:${taskId}`, expectedVersion: 0 });
  const lock = await tryAcquireExclusiveFileLock(lockPath, 'event_stream');
  const secondStore = new JsonlTaskEventStore(directory);
  try {
    await assert.rejects(secondStore.append(stateChanged(taskId), {
      idempotencyKey: 'state:task-events-lock:1:DRAFT:CLASSIFIED',
      expectedVersion: 1,
    }), (error: unknown) => error instanceof EventStoreBusyError
      && error.lockConflict.lockPath === lockPath
      && error.lockConflict.owner?.pid === process.pid);
  } finally {
    await lock.release();
  }
  await assert.rejects(readFile(lockPath), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT');
});
