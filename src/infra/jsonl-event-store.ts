import { open, lstat, readFile, readdir, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  TASK_APPROVAL_RECORDED_EVENT,
  TASK_CANCEL_REQUESTED_EVENT,
  TASK_CREATED_EVENT,
  TASK_STATE_CHANGED_EVENT,
  taskEventSemanticKey,
  type TaskActor,
  type TaskEvent,
} from '../domain/event.ts';
import type { TaskOperation } from '../domain/policy.ts';
import { TASK_STATES, type TaskState } from '../domain/state.ts';
import { isValidTaskId } from '../domain/task.ts';
import {
  EventStoreBusyError,
  EventStoreConflictError,
  type EventAppendOptions,
  type TaskEventStorePort,
} from '../application/ports/index.ts';
import { FileLockBusyError, tryAcquireExclusiveFileLock } from './file-lock.ts';
import { ensureOrdinaryDirectory } from './path-safety.ts';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._,+-]{0,511}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;
const ACTORS = new Set<TaskActor>(['operator', 'system', 'agent', 'evaluator']);
const OPERATIONS = new Set<TaskOperation>(['read', 'write', 'process', 'network']);
const STATES = new Set<TaskState>(TASK_STATES);

interface EventLogRecord {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly event: TaskEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function parseTaskEvent(value: unknown, taskId: string): TaskEvent {
  if (!isRecord(value)
    || typeof value.type !== 'string'
    || typeof value.eventId !== 'string'
    || !EVENT_ID_PATTERN.test(value.eventId)
    || value.taskId !== taskId
    || !validTimestamp(value.occurredAt)
    || typeof value.actor !== 'string'
    || !ACTORS.has(value.actor as TaskActor)) {
    throw new EventStoreConflictError();
  }

  const common = {
    eventId: value.eventId,
    taskId,
    occurredAt: value.occurredAt,
    actor: value.actor as TaskActor,
  };
  switch (value.type) {
    case TASK_CREATED_EVENT:
      if (!hasOnlyKeys(value, ['type', 'eventId', 'taskId', 'occurredAt', 'actor', 'envelopeSha256'])
        || typeof value.envelopeSha256 !== 'string'
        || !HASH_PATTERN.test(value.envelopeSha256)) throw new EventStoreConflictError();
      return Object.freeze({ ...common, type: TASK_CREATED_EVENT, envelopeSha256: value.envelopeSha256 });
    case TASK_APPROVAL_RECORDED_EVENT:
      if (!hasOnlyKeys(value, ['type', 'eventId', 'taskId', 'occurredAt', 'actor', 'envelopeSha256', 'operations', 'expiresAt', 'confirmed'])
        || typeof value.envelopeSha256 !== 'string'
        || !HASH_PATTERN.test(value.envelopeSha256)
        || !Array.isArray(value.operations)
        || value.operations.length === 0
        || !value.operations.every((operation) => typeof operation === 'string' && OPERATIONS.has(operation as TaskOperation))
        || !validTimestamp(value.expiresAt)
        || value.confirmed !== true) throw new EventStoreConflictError();
      return Object.freeze({
        ...common,
        type: TASK_APPROVAL_RECORDED_EVENT,
        envelopeSha256: value.envelopeSha256,
        operations: Object.freeze([...(value.operations as TaskOperation[])]),
        expiresAt: value.expiresAt,
        confirmed: true,
      });
    case TASK_CANCEL_REQUESTED_EVENT:
      if (!hasOnlyKeys(value, ['type', 'eventId', 'taskId', 'occurredAt', 'actor', 'envelopeSha256', 'executionId'])
        || typeof value.envelopeSha256 !== 'string'
        || !HASH_PATTERN.test(value.envelopeSha256)
        || typeof value.executionId !== 'string'
        || !EVENT_ID_PATTERN.test(value.executionId)) throw new EventStoreConflictError();
      return Object.freeze({ ...common, type: TASK_CANCEL_REQUESTED_EVENT, envelopeSha256: value.envelopeSha256, executionId: value.executionId });
    case TASK_STATE_CHANGED_EVENT: {
      const allowed = ['type', 'eventId', 'taskId', 'occurredAt', 'actor', 'from', 'to', 'reasonCode', 'envelopeSha256', 'executionId'];
      if (!hasOnlyKeys(value, allowed)
        || typeof value.from !== 'string'
        || !STATES.has(value.from as TaskState)
        || typeof value.to !== 'string'
        || !STATES.has(value.to as TaskState)
        || (value.reasonCode !== undefined && (typeof value.reasonCode !== 'string' || !REASON_CODE_PATTERN.test(value.reasonCode)))
        || (value.envelopeSha256 !== undefined && (typeof value.envelopeSha256 !== 'string' || !HASH_PATTERN.test(value.envelopeSha256)))
        || (value.executionId !== undefined && (typeof value.executionId !== 'string' || !EVENT_ID_PATTERN.test(value.executionId)))) {
        throw new EventStoreConflictError();
      }
      return Object.freeze({
        ...common,
        type: TASK_STATE_CHANGED_EVENT,
        from: value.from as TaskState,
        to: value.to as TaskState,
        ...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode as string }),
        ...(value.envelopeSha256 === undefined ? {} : { envelopeSha256: value.envelopeSha256 as string }),
        ...(value.executionId === undefined ? {} : { executionId: value.executionId as string }),
      });
    }
    default:
      throw new EventStoreConflictError();
  }
}

function parseRecord(value: unknown, taskId: string): EventLogRecord {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'idempotencyKey', 'event'])
    || value.schemaVersion !== 1
    || typeof value.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)) throw new EventStoreConflictError();
  return Object.freeze({
    schemaVersion: 1,
    idempotencyKey: value.idempotencyKey,
    event: parseTaskEvent(value.event, taskId),
  });
}

function validateTaskId(taskId: string): void {
  if (!isValidTaskId(taskId)) throw new EventStoreConflictError();
}

/** One append-only, locked JSONL stream per task; event payloads are strictly prompt-free. */
export class JsonlTaskEventStore implements TaskEventStorePort {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  private async ensureDirectory(): Promise<void> {
    await ensureOrdinaryDirectory(this.directory, () => new EventStoreConflictError());
  }

  private streamPath(taskId: string): string {
    validateTaskId(taskId);
    return join(this.directory, `${taskId}.jsonl`);
  }

  private async readRecordsUnlocked(taskId: string): Promise<readonly EventLogRecord[]> {
    const path = this.streamPath(taskId);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new EventStoreConflictError();

    const bytes = await readFile(path);
    if (bytes.length === 0) return Object.freeze([]);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      await truncate(path, 0);
      const handle = await open(path, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      return Object.freeze([]);
    }
    if (lastNewline !== bytes.length - 1) {
      await truncate(path, lastNewline + 1);
      const handle = await open(path, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
    }

    const complete = bytes.subarray(0, lastNewline).toString('utf8');
    if (!complete) throw new EventStoreConflictError();
    const records = complete.split('\n').map((line) => {
      if (!line) throw new EventStoreConflictError();
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new EventStoreConflictError(); }
      return parseRecord(parsed, taskId);
    });
    const keys = new Set<string>();
    const eventIds = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (keys.has(record.idempotencyKey) || eventIds.has(record.event.eventId)) throw new EventStoreConflictError();
      keys.add(record.idempotencyKey);
      eventIds.add(record.event.eventId);
      if ((index === 0) !== (record.event.type === TASK_CREATED_EVENT)) throw new EventStoreConflictError();
    }
    return Object.freeze(records);
  }

  private async withStreamLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lockPath = join(this.directory, `.${taskId}.lock`);
    const lock = await tryAcquireExclusiveFileLock(
      lockPath,
      'event_stream',
    ).catch((error: unknown) => {
      if (error instanceof FileLockBusyError) throw new EventStoreBusyError(lockPath, error.owner);
      throw new EventStoreBusyError(lockPath);
    });
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  async append(event: TaskEvent, options: EventAppendOptions): Promise<TaskEvent> {
    validateTaskId(event.taskId);
    if (!IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey) || !Number.isInteger(options.expectedVersion) || options.expectedVersion < 0) {
      throw new EventStoreConflictError();
    }
    const safeEvent = parseTaskEvent(event, event.taskId);
    const path = this.streamPath(event.taskId);
    return this.withStreamLock(event.taskId, async () => {
      const records = await this.readRecordsUnlocked(event.taskId);
      const prior = records.find((record) => record.idempotencyKey === options.idempotencyKey);
      if (prior) {
        if (taskEventSemanticKey(prior.event) !== taskEventSemanticKey(safeEvent)) throw new EventStoreConflictError();
        return prior.event;
      }
      if (records.length !== options.expectedVersion) throw new EventStoreConflictError();
      if ((records.length === 0) !== (safeEvent.type === TASK_CREATED_EVENT)) throw new EventStoreConflictError();
      if (records.some((record) => record.event.eventId === safeEvent.eventId)) throw new EventStoreConflictError();

      const record: EventLogRecord = Object.freeze({ schemaVersion: 1, idempotencyKey: options.idempotencyKey, event: safeEvent });
      const handle = await open(path, 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return safeEvent;
    });
  }

  async read(taskId: string, afterEventId?: string): Promise<readonly TaskEvent[]> {
    validateTaskId(taskId);
    return this.withStreamLock(taskId, async () => {
      const events = (await this.readRecordsUnlocked(taskId)).map((record) => record.event);
      if (!afterEventId) return Object.freeze(events);
      const index = events.findIndex((event) => event.eventId === afterEventId);
      return Object.freeze(index < 0 ? [] : events.slice(index + 1));
    });
  }

  async listTaskIds(): Promise<readonly string[]> {
    await this.ensureDirectory();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.jsonl')) continue;
      const taskId = entry.name.slice(0, -'.jsonl'.length);
      if (!isValidTaskId(taskId)) continue;
      if (!entry.isFile()) throw new EventStoreConflictError();
      const records = await this.withStreamLock(taskId, () => this.readRecordsUnlocked(taskId));
      if (records[0]?.event.type === TASK_CREATED_EVENT) ids.push(taskId);
    }
    return Object.freeze(ids.sort());
  }
}
