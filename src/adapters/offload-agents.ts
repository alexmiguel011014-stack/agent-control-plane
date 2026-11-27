import { createHash } from 'node:crypto';
import type { AgentInvocationPort, AgentInvocationResult, WorkspaceReference } from '../application/ports/index.ts';
import { type TaskEnvelopeV1, validateTaskEnvelopeV1 } from '../domain/task.ts';
import type { OllamaContextFile, OllamaContextReader } from './ollama.ts';

export const OFFLOAD_BUNDLE_VERSION = 1;

const MAX_LINE_CHARS = 4_194_304;
const ATTEMPT_PATTERN = /^[1-9][0-9]{0,2}$/;

export class OffloadError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`offload_${code}`);
    this.name = 'OffloadError';
    this.code = code;
  }
}

export interface OffloadInvocationRecordV1 {
  readonly version: 1;
  readonly key: string;
  readonly envelope: TaskEnvelopeV1;
  readonly files: readonly OllamaContextFile[];
}

export interface OffloadResultRecordV1 {
  readonly version: 1;
  readonly key: string;
  readonly result: AgentInvocationResult;
  readonly durationMs: number;
  readonly modelTag: string;
  readonly modelDigest: string | null;
  readonly runtimeVersion: string | null;
}

/** Stable key: lowercase benchmark task id, attempt, base snapshot, and prompt hash. */
export function offloadKey(envelope: TaskEnvelopeV1, runId: string): string {
  const marker = `-${runId}-`;
  const at = envelope.taskId.lastIndexOf(marker);
  if (at < 1) throw new OffloadError('task_id_unparsed');
  const prefix = envelope.taskId.slice(0, at);
  const attempt = envelope.taskId.slice(at + marker.length);
  if (prefix !== prefix.toLowerCase() || !ATTEMPT_PATTERN.test(attempt)) {
    throw new OffloadError('task_id_unparsed');
  }
  const promptHash = createHash('sha256').update(envelope.prompt, 'utf8').digest('hex');
  return `${prefix}|${attempt}|${envelope.baseSnapshotSha256}|${promptHash}`;
}

/** Context reader that always returns the same files, for replaying captured context. */
export function fixedContextReader(files: readonly OllamaContextFile[]): OllamaContextReader {
  return async () => files;
}

/** Records each invocation and its context files, then refuses; it never produces a proposal. */
export class CaptureAgentAdapter implements AgentInvocationPort {
  readonly #runId: string;
  readonly #contextReader: OllamaContextReader;
  readonly #records = new Map<string, OffloadInvocationRecordV1>();

  constructor(options: { readonly runId: string; readonly contextReader: OllamaContextReader }) {
    this.#runId = options.runId;
    this.#contextReader = options.contextReader;
  }

  records(): readonly OffloadInvocationRecordV1[] {
    return [...this.#records.values()];
  }

  async invoke(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
  }): Promise<AgentInvocationResult> {
    const key = offloadKey(input.envelope, this.#runId);
    if (this.#records.has(key)) throw new OffloadError('duplicate_key');
    const files = await this.#contextReader(input);
    this.#records.set(
      key,
      Object.freeze({
        version: 1 as const,
        key,
        envelope: input.envelope,
        files: Object.freeze(files.map((file) => Object.freeze({ path: file.path, text: file.text }))),
      }),
    );
    return Object.freeze({ kind: 'refusal', reasonCode: 'offload_captured' });
  }
}

/** Returns stored results by key; a missing key is a refusal, never a model call. */
export class ReplayAgentAdapter implements AgentInvocationPort {
  readonly #runId: string;
  readonly #results = new Map<string, OffloadResultRecordV1>();

  constructor(options: { readonly runId: string; readonly results: readonly OffloadResultRecordV1[] }) {
    this.#runId = options.runId;
    for (const record of options.results) {
      if (this.#results.has(record.key)) throw new OffloadError('duplicate_key');
      this.#results.set(record.key, record);
    }
  }

  async invoke(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
  }): Promise<AgentInvocationResult> {
    const record = this.#results.get(offloadKey(input.envelope, this.#runId));
    return record?.result ?? Object.freeze({ kind: 'refusal', reasonCode: 'offload_missing' });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function parseBase(line: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof line !== 'string' || line.length > MAX_LINE_CHARS) throw new OffloadError('line_invalid');
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new OffloadError('line_invalid');
  }
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) throw new OffloadError('line_invalid');
  if (value.version !== OFFLOAD_BUNDLE_VERSION) throw new OffloadError('line_invalid');
  if (typeof value.key !== 'string' || value.key.length < 1 || value.key.length > 512) {
    throw new OffloadError('line_invalid');
  }
  return value;
}

export function parseOffloadInvocationLine(line: string): OffloadInvocationRecordV1 {
  const record = parseBase(line, ['version', 'key', 'envelope', 'files']);
  if (!isPlainObject(record.envelope) || !Array.isArray(record.files)) throw new OffloadError('line_invalid');
  if (!validateTaskEnvelopeV1(record.envelope).valid) throw new OffloadError('line_invalid');
  for (const file of record.files) {
    if (!isPlainObject(file) || !hasExactKeys(file, ['path', 'text'])) throw new OffloadError('line_invalid');
    if (typeof file.path !== 'string' || typeof file.text !== 'string') throw new OffloadError('line_invalid');
  }
  return record as unknown as OffloadInvocationRecordV1;
}

export function parseOffloadResultLine(line: string): OffloadResultRecordV1 {
  const record = parseBase(line, [
    'version',
    'key',
    'result',
    'durationMs',
    'modelTag',
    'modelDigest',
    'runtimeVersion',
  ]);
  const result = record.result;
  if (!isPlainObject(result)) throw new OffloadError('line_invalid');
  if (result.kind === 'refusal') {
    const reason = result.reasonCode;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length < 1 || reason.length > 64)) {
      throw new OffloadError('line_invalid');
    }
  } else if (result.kind !== 'proposal') {
    throw new OffloadError('line_invalid');
  }
  if (typeof record.durationMs !== 'number' || !Number.isFinite(record.durationMs) || record.durationMs < 0) {
    throw new OffloadError('line_invalid');
  }
  if (typeof record.modelTag !== 'string') throw new OffloadError('line_invalid');
  if (record.modelDigest !== null && typeof record.modelDigest !== 'string') throw new OffloadError('line_invalid');
  if (record.runtimeVersion !== null && typeof record.runtimeVersion !== 'string') {
    throw new OffloadError('line_invalid');
  }
  return record as unknown as OffloadResultRecordV1;
}
