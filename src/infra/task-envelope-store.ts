import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  SaveTaskResult,
  StoredTaskEnvelope,
  TaskRepositoryPort,
} from '../application/ports/index.ts';
import type { TaskOperation } from '../domain/policy.ts';
import { isValidTaskId, type TaskEnvelopeV1 } from '../domain/task.ts';
import { DECLARED_TEST_ID_PATTERN, isSafeDeclaredTestPath, type DeclaredTestV1 } from '../domain/tools.ts';
import { canonicalTaskEnvelope } from './envelope-hasher.ts';
import { ensureOrdinaryDirectory } from './path-safety.ts';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

interface StoredEnvelopeFile {
  readonly schemaVersion: 1;
  readonly envelopeSha256: string;
  readonly envelope: TaskEnvelopeV1;
}

export class TaskEnvelopeStoreIntegrityError extends Error {
  constructor() {
    super('Task envelope storage is invalid or unsafe');
    this.name = 'TaskEnvelopeStoreIntegrityError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeEnvelope(value: TaskEnvelopeV1): TaskEnvelopeV1 {
  return Object.freeze({
    schemaVersion: 1,
    taskId: value.taskId,
    prompt: value.prompt,
    requestedOperations: Object.freeze([...value.requestedOperations]),
    allowedPaths: Object.freeze([...value.allowedPaths]),
    declaredTests: Object.freeze(value.declaredTests.map((test) => Object.freeze({ ...test }))),
    baseSnapshotSha256: value.baseSnapshotSha256,
  });
}

function parseEnvelopeFile(value: unknown, expectedTaskId: string): StoredTaskEnvelope {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.envelope)) {
    throw new TaskEnvelopeStoreIntegrityError();
  }
  const envelope = value.envelope;
  const legacyEnvelopeKeys = new Set(['schemaVersion', 'taskId', 'prompt', 'requestedOperations', 'allowedPaths', 'baseSnapshotSha256']);
  const envelopeKeys = new Set([...legacyEnvelopeKeys, 'declaredTests']);
  const hasDeclaredTests = Object.hasOwn(envelope, 'declaredTests');
  if (envelope.schemaVersion !== 1
    || Object.keys(envelope).some((key) => !envelopeKeys.has(key))
    || (hasDeclaredTests ? Object.keys(envelope).length !== envelopeKeys.size : Object.keys(envelope).length !== legacyEnvelopeKeys.size)
    || envelope.taskId !== expectedTaskId
    || typeof envelope.prompt !== 'string'
    || !Array.isArray(envelope.requestedOperations)
    || !envelope.requestedOperations.every((operation) =>
      operation === 'read' || operation === 'write' || operation === 'process' || operation === 'network')
    || !Array.isArray(envelope.allowedPaths)
    || !envelope.allowedPaths.every((path) => typeof path === 'string')
    || (hasDeclaredTests && !areValidDeclaredTests(envelope.declaredTests))
    || typeof envelope.baseSnapshotSha256 !== 'string'
    || !HASH_PATTERN.test(envelope.baseSnapshotSha256)
    || typeof value.envelopeSha256 !== 'string'
    || !HASH_PATTERN.test(value.envelopeSha256)) {
    throw new TaskEnvelopeStoreIntegrityError();
  }
  const typedEnvelope: TaskEnvelopeV1 = {
    schemaVersion: 1,
    taskId: expectedTaskId,
    prompt: envelope.prompt,
    requestedOperations: envelope.requestedOperations as TaskOperation[],
    allowedPaths: envelope.allowedPaths,
    declaredTests: (hasDeclaredTests ? envelope.declaredTests : []) as DeclaredTestV1[],
    baseSnapshotSha256: envelope.baseSnapshotSha256,
  };
  return Object.freeze({
    envelope: freezeEnvelope(typedEnvelope),
    envelopeSha256: value.envelopeSha256,
  });
}

function isDeclaredTestRecord(value: unknown): value is DeclaredTestV1 {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !DECLARED_TEST_ID_PATTERN.test(value.id)) return false;
  if (value.profile === 'host-json-v1') {
    return Object.keys(value).length === 2
      && Object.keys(value).every((key) => key === 'id' || key === 'profile');
  }
  if (value.profile !== 'node-test') return false;
  return Object.keys(value).length === 3
    && Object.keys(value).every((key) => key === 'id' || key === 'profile' || key === 'path')
    && isSafeDeclaredTestPath(value.path);
}

function areValidDeclaredTests(value: unknown): value is DeclaredTestV1[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  const ids = new Set<string>();
  for (const test of value) {
    if (!isDeclaredTestRecord(test) || ids.has(test.id)) return false;
    ids.add(test.id);
  }
  return true;
}

export class LocalTaskEnvelopeStore implements TaskRepositoryPort {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  private async ensureDirectory(): Promise<void> {
    await ensureOrdinaryDirectory(this.directory, () => new TaskEnvelopeStoreIntegrityError());
  }

  private filePath(taskId: string): string {
    if (!isValidTaskId(taskId)) throw new TaskEnvelopeStoreIntegrityError();
    return join(this.directory, taskId, 'envelope.json');
  }

  private async readStored(taskId: string): Promise<StoredTaskEnvelope | null> {
    const target = this.filePath(taskId);
    try {
      const directoryInfo = await lstat(join(this.directory, taskId));
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new TaskEnvelopeStoreIntegrityError();
      }
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new TaskEnvelopeStoreIntegrityError();
      const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
      return parseEnvelopeFile(parsed, taskId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveIfAbsent(envelope: TaskEnvelopeV1, envelopeSha256: string): Promise<SaveTaskResult> {
    const target = this.filePath(envelope.taskId);
    if (!HASH_PATTERN.test(envelopeSha256)) throw new TaskEnvelopeStoreIntegrityError();
    await this.ensureDirectory();

    const current = await this.readStored(envelope.taskId);
    if (current) {
      return current.envelopeSha256 === envelopeSha256
        && canonicalTaskEnvelope(current.envelope) === canonicalTaskEnvelope(envelope)
        ? 'already_exists'
        : 'conflict';
    }

    const temporaryDirectory = join(this.directory, `.${envelope.taskId}.${randomUUID()}.tmp`);
    const temporaryPath = join(temporaryDirectory, 'envelope.json');
    const record: StoredEnvelopeFile = {
      schemaVersion: 1,
      envelopeSha256,
      envelope: freezeEnvelope(envelope),
    };
    let temporaryCreated = false;
    try {
      await mkdir(temporaryDirectory);
      temporaryCreated = true;
      const temporary = await open(temporaryPath, 'wx', 0o600);
      try {
        await temporary.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await temporary.sync();
      } finally {
        await temporary.close();
      }

      try {
        // A complete temp directory is atomically published by same-directory
        // rename. Windows refuses to replace an existing destination directory.
        await rename(temporaryDirectory, join(this.directory, envelope.taskId));
        return 'created';
      } catch {
        const raced = await this.readStored(envelope.taskId);
        if (!raced) throw new TaskEnvelopeStoreIntegrityError();
        return raced.envelopeSha256 === envelopeSha256
          && canonicalTaskEnvelope(raced.envelope) === canonicalTaskEnvelope(envelope)
          ? 'already_exists'
          : 'conflict';
      }
    } finally {
      if (temporaryCreated) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async get(taskId: string): Promise<StoredTaskEnvelope | null> {
    await this.ensureDirectory();
    return this.readStored(taskId);
  }
}
