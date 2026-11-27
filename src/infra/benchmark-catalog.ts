import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BENCHMARK_SUITE_ID = 'g2-local-pure-localized';
export const DEFAULT_BENCHMARK_TASK_IDS: readonly string[] = Object.freeze([
  'P01', 'P02', 'P03', 'P04', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06',
]);

export const G3_BENCHMARK_SUITE_ID = 'g3-local-small-integrations';
export const G3_BENCHMARK_TASK_IDS: readonly string[] = Object.freeze(['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09', 'I10', 'I11', 'I12', 'I13', 'I14', 'I15', 'I16', 'I17', 'I18', 'I19', 'I20', 'I21', 'I22', 'I23', 'I24', 'I25', 'I26', 'I27', 'I28', 'I29', 'I30']);
/** Held-out tuning suite (G20.2): S01-S04 never appear in a measurement suite. */
export const G20_TUNING_SUITE_ID = 'g20-tuning-policy';
export const G20_TUNING_TASK_IDS: readonly string[] = Object.freeze(['S01', 'S02', 'S03', 'S04']);
const KNOWN_SUITES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [DEFAULT_BENCHMARK_SUITE_ID]: DEFAULT_BENCHMARK_TASK_IDS,
  [G3_BENCHMARK_SUITE_ID]: G3_BENCHMARK_TASK_IDS,
  [G20_TUNING_SUITE_ID]: G20_TUNING_TASK_IDS,
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TASK_ID_PATTERN = /^[A-Z][0-9]{2}$/;
const ATTEMPT_PATTERN = /^([a-z][0-9]{2})-([a-z0-9][a-z0-9_.-]*)-([1-9][0-9]*)$/;
const MAX_JSON_BYTES = 64 * 1024;

export type BenchmarkCatalogErrorCode =
  | 'unknown_suite'
  | 'unknown_task'
  | 'catalog_file_unsafe'
  | 'catalog_file_invalid'
  | 'snapshot_mismatch'
  | 'invalid_attempt_id'
  | 'attempt_task_mismatch'
  | 'attempt_conflict'
  | 'unknown_attempt';

export class BenchmarkCatalogError extends Error {
  readonly code: BenchmarkCatalogErrorCode;
  constructor(code: BenchmarkCatalogErrorCode) {
    super(code);
    this.name = 'BenchmarkCatalogError';
    this.code = code;
  }
}

/** Envelope fields the catalog supplies; the caller adds the attempt task ID. */
export interface BenchmarkEnvelopeInput {
  readonly schemaVersion: 1;
  readonly prompt: string;
  readonly requestedOperations: readonly ['write'];
  readonly allowedPaths: readonly string[];
  readonly declaredTests: readonly [];
  readonly baseSnapshotSha256: string;
}

export interface BenchmarkCatalogTask {
  readonly benchmarkTaskId: string;
  readonly envelopeInput: BenchmarkEnvelopeInput;
  readonly execution?: BenchmarkCatalogExecution;
}

export interface BenchmarkCatalogExecution {
  readonly timeoutMs: number;
  readonly publicTestCommandId: string;
}

export interface BenchmarkCatalogSuite {
  readonly suiteId: string;
  readonly tasks: readonly BenchmarkCatalogTask[];
}

export interface BenchmarkSuiteSummary {
  readonly suiteId: string;
  readonly taskIds: readonly string[];
}

/** Minimal capture surface (structurally satisfied by LocalSnapshotStore). */
export interface BenchmarkCatalogSnapshotStore {
  capture(sourceDirectory: string): Promise<{ readonly snapshotSha256: string }>;
}

export interface LocalBenchmarkCatalogOptions {
  readonly repositoryRoot: string;
  readonly snapshots: BenchmarkCatalogSnapshotStore;
  readonly suiteId?: string;
  readonly taskIds?: readonly string[];
}

/** Local shape of the catalog methods the benchmark service calls. */
export interface BenchmarkCatalogShape {
  listSuites(): Promise<readonly BenchmarkSuiteSummary[]>;
  getSuite(suiteId: string): Promise<BenchmarkCatalogSuite>;
  registerAttempt(attemptTaskId: string, benchmarkTaskId: string): void;
  benchmarkTaskIdFor(attemptTaskId: string): string;
}

export class LocalBenchmarkCatalog implements BenchmarkCatalogShape {
  readonly #root: string;
  readonly #snapshots: BenchmarkCatalogSnapshotStore;
  readonly #suites: ReadonlyMap<string, readonly string[]>;
  readonly #allTaskIds: readonly string[];
  readonly #attempts = new Map<string, string>();
  readonly #tasks = new Map<string, Promise<BenchmarkCatalogTask>>();

  constructor(options: LocalBenchmarkCatalogOptions) {
    this.#root = path.resolve(options.repositoryRoot);
    this.#snapshots = options.snapshots;
    // Without options the catalog serves every known suite; an explicit suiteId/taskIds pair serves only that one.
    const entries: Array<[string, readonly string[]]> = options.suiteId === undefined && options.taskIds === undefined
      ? Object.entries(KNOWN_SUITES)
      : [[options.suiteId ?? DEFAULT_BENCHMARK_SUITE_ID, options.taskIds ?? DEFAULT_BENCHMARK_TASK_IDS]];
    this.#suites = new Map(entries.map(([id, ids]) => [id, Object.freeze([...ids])]));
    this.#allTaskIds = Object.freeze([...new Set([...this.#suites.values()].flat())]);
    for (const id of this.#allTaskIds) {
      if (!TASK_ID_PATTERN.test(id)) throw new BenchmarkCatalogError('unknown_task');
    }
  }

  async listSuites(): Promise<readonly BenchmarkSuiteSummary[]> {
    return Object.freeze([...this.#suites].map(([suiteId, taskIds]) => Object.freeze({ suiteId, taskIds })));
  }

  async getSuite(suiteId: string): Promise<BenchmarkCatalogSuite> {
    const taskIds = this.#suites.get(suiteId);
    if (taskIds === undefined) throw new BenchmarkCatalogError('unknown_suite');
    const tasks: BenchmarkCatalogTask[] = [];
    for (const id of taskIds) tasks.push(await this.#loadTask(id));
    return Object.freeze({ suiteId, tasks: Object.freeze(tasks) });
  }

  registerAttempt(attemptTaskId: string, benchmarkTaskId: string): void {
    if (typeof attemptTaskId !== 'string' || typeof benchmarkTaskId !== 'string') {
      throw new BenchmarkCatalogError('invalid_attempt_id');
    }
    const match = ATTEMPT_PATTERN.exec(attemptTaskId);
    if (!match) throw new BenchmarkCatalogError('invalid_attempt_id');
    if (!this.#allTaskIds.includes(benchmarkTaskId)) throw new BenchmarkCatalogError('unknown_task');
    if (match[1] !== benchmarkTaskId.toLowerCase()) throw new BenchmarkCatalogError('attempt_task_mismatch');
    const existing = this.#attempts.get(attemptTaskId);
    if (existing !== undefined && existing !== benchmarkTaskId) throw new BenchmarkCatalogError('attempt_conflict');
    this.#attempts.set(attemptTaskId, benchmarkTaskId);
  }

  benchmarkTaskIdFor(attemptTaskId: string): string {
    const found = this.#attempts.get(attemptTaskId);
    if (found === undefined) throw new BenchmarkCatalogError('unknown_attempt');
    return found;
  }

  #loadTask(id: string): Promise<BenchmarkCatalogTask> {
    let pending = this.#tasks.get(id);
    if (!pending) {
      pending = this.#buildTask(id);
      this.#tasks.set(id, pending);
      // Do not cache failures; a fixed task may be retried.
      pending.catch(() => this.#tasks.delete(id));
    }
    return pending;
  }

  async #buildTask(id: string): Promise<BenchmarkCatalogTask> {
    const taskDirectory = path.join(this.#root, 'bench', 'tasks', id);
    await this.#assertOrdinaryDirectory(taskDirectory);
    const task = await this.#readJson(path.join(taskDirectory, 'task.json'));
    const manifest = await this.#readJson(path.join(taskDirectory, 'snapshot.json'));
    if (!isRecord(task) || !isRecord(manifest) || !Array.isArray(manifest.files)) {
      throw new BenchmarkCatalogError('catalog_file_invalid');
    }
    const { task_id: taskId, prompt, base_snapshot_sha256: expected, allowed_globs: globs } = task;
    if (taskId !== id) throw new BenchmarkCatalogError('catalog_file_invalid');
    if (typeof prompt !== 'string' || prompt.length === 0) throw new BenchmarkCatalogError('catalog_file_invalid');
    if (typeof expected !== 'string' || !HASH_PATTERN.test(expected)) throw new BenchmarkCatalogError('catalog_file_invalid');
    if (!Array.isArray(globs) || globs.length === 0 || !globs.every((g) => typeof g === 'string' && g.length > 0)) {
      throw new BenchmarkCatalogError('catalog_file_invalid');
    }

    const baseDirectory = path.join(taskDirectory, 'base');
    await this.#assertOrdinaryDirectory(baseDirectory);
    let receipt;
    try {
      receipt = await this.#snapshots.capture(baseDirectory);
    } catch {
      throw new BenchmarkCatalogError('snapshot_mismatch');
    }
    if (receipt.snapshotSha256 !== expected) throw new BenchmarkCatalogError('snapshot_mismatch');

    const timeoutMs = (task as Record<string, unknown>).timeout_ms;
    const testId = (task as Record<string, unknown>).public_test_command_id;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || typeof testId !== 'string' || testId.length === 0) {
      throw new BenchmarkCatalogError('catalog_file_invalid');
    }
    return Object.freeze({
      benchmarkTaskId: id,
      execution: Object.freeze({ timeoutMs, publicTestCommandId: testId }),
      envelopeInput: Object.freeze({
        schemaVersion: 1 as const,
        prompt,
        requestedOperations: Object.freeze(['write'] as const),
        allowedPaths: Object.freeze([...(globs as string[])]),
        declaredTests: Object.freeze([] as const),
        baseSnapshotSha256: expected,
      }),
    });
  }

  async #assertOrdinaryDirectory(directory: string): Promise<void> {
    let info;
    try {
      info = await lstat(directory);
    } catch {
      throw new BenchmarkCatalogError('unknown_task');
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new BenchmarkCatalogError('catalog_file_unsafe');
    if (!samePath(await realpath(directory), directory)) throw new BenchmarkCatalogError('catalog_file_unsafe');
  }

  async #readJson(file: string): Promise<unknown> {
    let info;
    try {
      info = await lstat(file);
    } catch {
      throw new BenchmarkCatalogError('catalog_file_invalid');
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new BenchmarkCatalogError('catalog_file_unsafe');
    if (info.size > MAX_JSON_BYTES) throw new BenchmarkCatalogError('catalog_file_invalid');
    if (!samePath(await realpath(file), file)) throw new BenchmarkCatalogError('catalog_file_unsafe');
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      throw new BenchmarkCatalogError('catalog_file_invalid');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(left);
  const b = path.normalize(path.resolve(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
