import { randomUUID } from 'node:crypto';
import { link, lstat, open, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { TOOL_OPERATIONS, type ToolOperationName } from '../domain/tools.ts';
import type { CpuSummary, GpuSummary, RamSummary, RunMetricsSummary } from './metrics.ts';
import { GPU_UNAVAILABLE_REASONS, METRIC_UNAVAILABLE_REASONS } from './metrics.ts';
import { ensureOrdinaryDirectory } from './path-safety.ts';

/**
 * Local benchmark run result, schema version 1.
 *
 * A result records facts about one task attempt only: restricted ids, counts,
 * digests, fixed status/reason codes, and resource metrics. It never carries
 * prompts, patch or file contents, paths, environment values, or free text.
 */

export const EVALUATION_STATUSES = ['PASS', 'FAIL', 'POLICY_VIOLATION', 'TIMEOUT', 'CRASH', 'RUNNER_FAILURE'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export const LOCAL_RUN_RESULT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const POLICY_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MODEL_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUNTIME_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const LOCAL_RUN_RESULT_LIMITS = Object.freeze({
  maxAttempt: 1_000,
  maxReasonCodes: 32,
  maxCount: 10_000_000,
  maxIssues: 64,
});

export interface LocalRunOutcomeV1 {
  readonly status: EvaluationStatus;
  /** null only when evaluation never reached the public tests. */
  readonly publicStatus: EvaluationStatus | null;
  /** null when the hidden oracle did not run. */
  readonly oracleStatus: EvaluationStatus | null;
  /** status is PASS: public and hidden oracle both passed. */
  readonly resolvedHidden: boolean;
  /** publicStatus is PASS. */
  readonly publicPass: boolean;
  /** status is not POLICY_VIOLATION. Blocked tool requests are counted separately in policyDenials. */
  readonly policyClean: boolean;
  readonly timedOut: boolean;
  readonly runnerFailure: boolean;
}

export interface LocalRunResultV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly suiteId: string;
  readonly startedAtUtc: string;
  readonly model: Readonly<{ tag: string; digest: string | null; runtimeVersion: string | null }>;
  readonly seed: Readonly<{ capable: boolean; value: number | null }>;
  readonly outcome: LocalRunOutcomeV1;
  readonly toolCalls: Readonly<{ total: number; byOperation: Readonly<Record<ToolOperationName, number>> }>;
  readonly changedFiles: number;
  readonly patch: Readonly<{ linesAdded: number; linesRemoved: number; sha256: string | null }>;
  readonly logSha256: string | null;
  readonly policyDenials: Readonly<{ count: number; reasonCodes: readonly string[] }>;
  readonly metrics: RunMetricsSummary;
}

export type LocalRunResultValidation =
  | Readonly<{ valid: true; result: LocalRunResultV1 }>
  | Readonly<{ valid: false; issues: readonly string[] }>;

/** Combine the public and oracle phases the same way the evaluator aggregates them. */
export function deriveLocalRunOutcome(
  publicStatus: EvaluationStatus | null,
  oracleStatus: EvaluationStatus | null,
  failureStatus: EvaluationStatus = 'RUNNER_FAILURE',
): LocalRunOutcomeV1 {
  let status: EvaluationStatus;
  let oracle = oracleStatus;
  if (publicStatus === null) {
    status = failureStatus === 'PASS' || failureStatus === 'FAIL' ? 'RUNNER_FAILURE' : failureStatus;
    oracle = null;
  } else if (publicStatus !== 'PASS') {
    status = publicStatus;
  } else {
    // A public pass without an oracle verdict is a runner failure, never a pass.
    oracle = oracleStatus ?? 'RUNNER_FAILURE';
    status = oracle;
  }
  return Object.freeze({
    status,
    publicStatus,
    oracleStatus: oracle,
    resolvedHidden: status === 'PASS',
    publicPass: publicStatus === 'PASS',
    policyClean: status !== 'POLICY_VIOLATION',
    timedOut: status === 'TIMEOUT',
    runnerFailure: status === 'RUNNER_FAILURE',
  });
}

type Issues = string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactRecord(value: unknown, keys: readonly string[], field: string, issues: Issues): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push(`${field}: expected_object`);
    return false;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${field}: unexpected_key`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) issues.push(`${field}.${key}: missing`);
  }
  return true;
}

function count(value: unknown, field: string, issues: Issues, maximum: number = LOCAL_RUN_RESULT_LIMITS.maxCount): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    issues.push(`${field}: invalid_count`);
    return false;
  }
  return true;
}

function finiteNonNegative(value: unknown, field: string, issues: Issues): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    issues.push(`${field}: invalid_number`);
    return false;
  }
  return true;
}

function matches(value: unknown, pattern: RegExp, field: string, issues: Issues): value is string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    issues.push(`${field}: invalid_format`);
    return false;
  }
  return true;
}

function nullableMatches(value: unknown, pattern: RegExp, field: string, issues: Issues): value is string | null {
  return value === null || matches(value, pattern, field, issues);
}

function boolean(value: unknown, field: string, issues: Issues): value is boolean {
  if (typeof value !== 'boolean') {
    issues.push(`${field}: expected_boolean`);
    return false;
  }
  return true;
}

function isStatus(value: unknown): value is EvaluationStatus {
  return (EVALUATION_STATUSES as readonly unknown[]).includes(value);
}

function validateOutcome(value: unknown, issues: Issues): void {
  const keys = ['status', 'publicStatus', 'oracleStatus', 'resolvedHidden', 'publicPass', 'policyClean', 'timedOut', 'runnerFailure'];
  if (!exactRecord(value, keys, 'outcome', issues)) return;
  const before = issues.length;
  if (!isStatus(value.status)) issues.push('outcome.status: invalid_status');
  if (value.publicStatus !== null && !isStatus(value.publicStatus)) issues.push('outcome.publicStatus: invalid_status');
  if (value.oracleStatus !== null && !isStatus(value.oracleStatus)) issues.push('outcome.oracleStatus: invalid_status');
  for (const key of ['resolvedHidden', 'publicPass', 'policyClean', 'timedOut', 'runnerFailure']) {
    boolean(value[key], `outcome.${key}`, issues);
  }
  if (issues.length !== before) return;
  const status = value.status as EvaluationStatus;
  const publicStatus = value.publicStatus as EvaluationStatus | null;
  const oracleStatus = value.oracleStatus as EvaluationStatus | null;
  if (publicStatus === null) {
    if (oracleStatus !== null) issues.push('outcome.oracleStatus: requires_public_status');
    if (status === 'PASS' || status === 'FAIL') issues.push('outcome.status: requires_public_status');
  } else if (publicStatus !== 'PASS') {
    if (status !== publicStatus) issues.push('outcome.status: inconsistent_with_public_status');
  } else if (oracleStatus === null || status !== oracleStatus) {
    issues.push('outcome.status: inconsistent_with_oracle_status');
  }
  if (value.resolvedHidden !== (status === 'PASS')) issues.push('outcome.resolvedHidden: contradictory');
  if (value.publicPass !== (publicStatus === 'PASS')) issues.push('outcome.publicPass: contradictory');
  if (value.policyClean !== (status !== 'POLICY_VIOLATION')) issues.push('outcome.policyClean: contradictory');
  if (value.timedOut !== (status === 'TIMEOUT')) issues.push('outcome.timedOut: contradictory');
  if (value.runnerFailure !== (status === 'RUNNER_FAILURE')) issues.push('outcome.runnerFailure: contradictory');
}

function validateToolCalls(value: unknown, issues: Issues): void {
  if (!exactRecord(value, ['total', 'byOperation'], 'toolCalls', issues)) return;
  const totalValid = count(value.total, 'toolCalls.total', issues);
  if (!exactRecord(value.byOperation, TOOL_OPERATIONS, 'toolCalls.byOperation', issues)) return;
  let sum = 0;
  let allValid = true;
  for (const operation of TOOL_OPERATIONS) {
    if (!Object.hasOwn(value.byOperation, operation)) {
      allValid = false;
      continue;
    }
    const entry = value.byOperation[operation];
    if (count(entry, `toolCalls.byOperation.${operation}`, issues)) sum += entry;
    else allValid = false;
  }
  if (totalValid && allValid && sum !== value.total) issues.push('toolCalls.total: inconsistent_with_operations');
}

function validateUnavailable(value: Record<string, unknown>, reasons: readonly string[], field: string, issues: Issues): void {
  if (!exactRecord(value, ['status', 'reason'], field, issues)) return;
  if (!reasons.includes(value.reason as string)) issues.push(`${field}.reason: invalid_reason`);
}

function validateCpu(value: unknown, issues: Issues): void {
  if (!isRecord(value)) {
    issues.push('metrics.cpu: expected_object');
    return;
  }
  if (value.status === 'unavailable') {
    validateUnavailable(value, METRIC_UNAVAILABLE_REASONS, 'metrics.cpu', issues);
    return;
  }
  if (value.status !== 'available') {
    issues.push('metrics.cpu.status: invalid_status');
    return;
  }
  if (!exactRecord(value, ['status', 'userMs', 'systemMs', 'peakPercent'], 'metrics.cpu', issues)) return;
  finiteNonNegative(value.userMs, 'metrics.cpu.userMs', issues);
  finiteNonNegative(value.systemMs, 'metrics.cpu.systemMs', issues);
  if (value.peakPercent !== null) finiteNonNegative(value.peakPercent, 'metrics.cpu.peakPercent', issues);
}

function validateRam(value: unknown, issues: Issues): void {
  if (!isRecord(value)) {
    issues.push('metrics.ram: expected_object');
    return;
  }
  if (value.status === 'unavailable') {
    validateUnavailable(value, METRIC_UNAVAILABLE_REASONS, 'metrics.ram', issues);
    return;
  }
  if (value.status !== 'available') {
    issues.push('metrics.ram.status: invalid_status');
    return;
  }
  if (!exactRecord(value, ['status', 'peakRssBytes', 'minSystemFreeBytes', 'systemTotalBytes'], 'metrics.ram', issues)) return;
  const max = Number.MAX_SAFE_INTEGER;
  const rss = count(value.peakRssBytes, 'metrics.ram.peakRssBytes', issues, max);
  const free = count(value.minSystemFreeBytes, 'metrics.ram.minSystemFreeBytes', issues, max);
  const total = count(value.systemTotalBytes, 'metrics.ram.systemTotalBytes', issues, max);
  if (total && (value.systemTotalBytes as number) === 0) issues.push('metrics.ram.systemTotalBytes: invalid_count');
  if (rss && free && total && (value.minSystemFreeBytes as number) > (value.systemTotalBytes as number)) {
    issues.push('metrics.ram.minSystemFreeBytes: exceeds_total');
  }
}

function validateGpu(value: unknown, issues: Issues): void {
  if (!isRecord(value)) {
    issues.push('metrics.gpu: expected_object');
    return;
  }
  if (value.status === 'unavailable') {
    validateUnavailable(value, GPU_UNAVAILABLE_REASONS, 'metrics.gpu', issues);
    return;
  }
  if (value.status !== 'available') {
    issues.push('metrics.gpu.status: invalid_status');
    return;
  }
  if (!exactRecord(value, ['status', 'peakUsedMiB', 'totalMiB', 'samples'], 'metrics.gpu', issues)) return;
  const used = count(value.peakUsedMiB, 'metrics.gpu.peakUsedMiB', issues);
  const total = count(value.totalMiB, 'metrics.gpu.totalMiB', issues);
  const samples = count(value.samples, 'metrics.gpu.samples', issues);
  if (total && (value.totalMiB as number) === 0) issues.push('metrics.gpu.totalMiB: invalid_count');
  if (samples && (value.samples as number) === 0) issues.push('metrics.gpu.samples: invalid_count');
  if (used && total && (value.peakUsedMiB as number) > (value.totalMiB as number)) issues.push('metrics.gpu.peakUsedMiB: exceeds_total');
}

function validateMetrics(value: unknown, issues: Issues): void {
  const keys = ['wallMs', 'firstOutputMs', 'sampleCount', 'cpu', 'ram', 'gpu', 'truncated'];
  if (!exactRecord(value, keys, 'metrics', issues)) return;
  const wall = finiteNonNegative(value.wallMs, 'metrics.wallMs', issues);
  if (value.firstOutputMs !== null && finiteNonNegative(value.firstOutputMs, 'metrics.firstOutputMs', issues)
    && wall && (value.firstOutputMs as number) > (value.wallMs as number)) {
    issues.push('metrics.firstOutputMs: exceeds_wall_time');
  }
  count(value.sampleCount, 'metrics.sampleCount', issues);
  validateCpu(value.cpu, issues);
  validateRam(value.ram, issues);
  validateGpu(value.gpu, issues);
  boolean(value.truncated, 'metrics.truncated', issues);
}

function validIsoUtc(value: unknown, issues: Issues): void {
  if (!matches(value, ISO_UTC_PATTERN, 'startedAtUtc', issues)) return;
  const parsed = new Date(value);
  const canonical = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  if (canonical === null || (canonical !== value && canonical.replace('.000Z', 'Z') !== value)) {
    issues.push('startedAtUtc: invalid_format');
  }
}

const RESULT_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'attempt', 'suiteId', 'startedAtUtc', 'model', 'seed', 'outcome',
  'toolCalls', 'changedFiles', 'patch', 'logSha256', 'policyDenials', 'metrics',
] as const;

function collectIssues(value: unknown): Issues {
  const issues: Issues = [];
  if (!exactRecord(value, RESULT_KEYS, 'result', issues)) return issues;
  if (value.schemaVersion !== 1) issues.push('schemaVersion: unsupported');
  matches(value.runId, LOCAL_RUN_RESULT_ID_PATTERN, 'runId', issues);
  matches(value.taskId, LOCAL_RUN_RESULT_ID_PATTERN, 'taskId', issues);
  matches(value.suiteId, LOCAL_RUN_RESULT_ID_PATTERN, 'suiteId', issues);
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1
    || (value.attempt as number) > LOCAL_RUN_RESULT_LIMITS.maxAttempt) issues.push('attempt: invalid_count');
  validIsoUtc(value.startedAtUtc, issues);

  if (exactRecord(value.model, ['tag', 'digest', 'runtimeVersion'], 'model', issues)) {
    matches(value.model.tag, MODEL_TAG_PATTERN, 'model.tag', issues);
    nullableMatches(value.model.digest, SHA256_PATTERN, 'model.digest', issues);
    nullableMatches(value.model.runtimeVersion, RUNTIME_VERSION_PATTERN, 'model.runtimeVersion', issues);
  }
  if (exactRecord(value.seed, ['capable', 'value'], 'seed', issues)) {
    boolean(value.seed.capable, 'seed.capable', issues);
    if (value.seed.value !== null && !Number.isSafeInteger(value.seed.value)) issues.push('seed.value: invalid_integer');
    if (value.seed.capable === false && value.seed.value !== null) issues.push('seed.value: requires_seed_capability');
  }
  validateOutcome(value.outcome, issues);
  validateToolCalls(value.toolCalls, issues);
  const changedValid = count(value.changedFiles, 'changedFiles', issues);
  if (exactRecord(value.patch, ['linesAdded', 'linesRemoved', 'sha256'], 'patch', issues)) {
    const added = count(value.patch.linesAdded, 'patch.linesAdded', issues);
    const removed = count(value.patch.linesRemoved, 'patch.linesRemoved', issues);
    const hashValid = nullableMatches(value.patch.sha256, SHA256_PATTERN, 'patch.sha256', issues);
    if (hashValid && value.patch.sha256 === null && added && removed && changedValid
      && ((value.patch.linesAdded as number) > 0 || (value.patch.linesRemoved as number) > 0 || (value.changedFiles as number) > 0)) {
      issues.push('patch.sha256: required_for_changes');
    }
  }
  nullableMatches(value.logSha256, SHA256_PATTERN, 'logSha256', issues);
  if (exactRecord(value.policyDenials, ['count', 'reasonCodes'], 'policyDenials', issues)) {
    const countValid = count(value.policyDenials.count, 'policyDenials.count', issues);
    const codes = value.policyDenials.reasonCodes;
    if (!Array.isArray(codes) || codes.length > LOCAL_RUN_RESULT_LIMITS.maxReasonCodes) {
      issues.push('policyDenials.reasonCodes: invalid_list');
    } else {
      const before = issues.length;
      codes.forEach((code, index) => { matches(code, POLICY_REASON_CODE_PATTERN, `policyDenials.reasonCodes.${index}`, issues); });
      if (issues.length === before) {
        if (new Set(codes).size !== codes.length) issues.push('policyDenials.reasonCodes: duplicate');
        if (countValid && ((value.policyDenials.count as number) < codes.length
          || ((value.policyDenials.count as number) > 0) !== (codes.length > 0))) {
          issues.push('policyDenials.count: inconsistent_with_reason_codes');
        }
      }
    }
  }
  validateMetrics(value.metrics, issues);
  return issues;
}

function freezeMetrics(value: RunMetricsSummary): RunMetricsSummary {
  return Object.freeze({
    wallMs: value.wallMs,
    firstOutputMs: value.firstOutputMs,
    sampleCount: value.sampleCount,
    cpu: Object.freeze({ ...value.cpu }) as CpuSummary,
    ram: Object.freeze({ ...value.ram }) as RamSummary,
    gpu: Object.freeze({ ...value.gpu }) as GpuSummary,
    truncated: value.truncated,
  });
}

/** Build a frozen copy in canonical key order from an already validated value. */
function normalize(value: LocalRunResultV1): LocalRunResultV1 {
  const byOperation = {} as Record<ToolOperationName, number>;
  for (const operation of TOOL_OPERATIONS) byOperation[operation] = value.toolCalls.byOperation[operation];
  return Object.freeze({
    schemaVersion: 1,
    runId: value.runId,
    taskId: value.taskId,
    attempt: value.attempt,
    suiteId: value.suiteId,
    startedAtUtc: value.startedAtUtc,
    model: Object.freeze({ tag: value.model.tag, digest: value.model.digest, runtimeVersion: value.model.runtimeVersion }),
    seed: Object.freeze({ capable: value.seed.capable, value: value.seed.value }),
    outcome: Object.freeze({
      status: value.outcome.status,
      publicStatus: value.outcome.publicStatus,
      oracleStatus: value.outcome.oracleStatus,
      resolvedHidden: value.outcome.resolvedHidden,
      publicPass: value.outcome.publicPass,
      policyClean: value.outcome.policyClean,
      timedOut: value.outcome.timedOut,
      runnerFailure: value.outcome.runnerFailure,
    }),
    toolCalls: Object.freeze({ total: value.toolCalls.total, byOperation: Object.freeze(byOperation) }),
    changedFiles: value.changedFiles,
    patch: Object.freeze({ linesAdded: value.patch.linesAdded, linesRemoved: value.patch.linesRemoved, sha256: value.patch.sha256 }),
    logSha256: value.logSha256,
    policyDenials: Object.freeze({
      count: value.policyDenials.count,
      reasonCodes: Object.freeze([...value.policyDenials.reasonCodes]),
    }),
    metrics: freezeMetrics(value.metrics),
  });
}

/** Strict structural and consistency check. Issues name fields and fixed codes, never values. */
export function validateLocalRunResult(value: unknown): LocalRunResultValidation {
  let issues: Issues;
  try {
    issues = collectIssues(value);
  } catch {
    issues = ['result: unreadable'];
  }
  if (issues.length > 0) {
    return Object.freeze({ valid: false, issues: Object.freeze(issues.slice(0, LOCAL_RUN_RESULT_LIMITS.maxIssues)) });
  }
  return Object.freeze({ valid: true, result: normalize(value as LocalRunResultV1) });
}

export type BenchmarkResultErrorCode = 'invalid_result' | 'result_exists' | 'unsafe_path' | 'write_failed';

const ERROR_MESSAGES: Readonly<Record<BenchmarkResultErrorCode, string>> = Object.freeze({
  invalid_result: 'Benchmark result is invalid',
  result_exists: 'Benchmark result already exists',
  unsafe_path: 'Benchmark result location is unsafe',
  write_failed: 'Benchmark result could not be written',
});

export class BenchmarkResultError extends Error {
  readonly code: BenchmarkResultErrorCode;

  constructor(code: BenchmarkResultErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'BenchmarkResultError';
    this.code = code;
  }
}

export interface LocalRunResultWriterOptions {
  /**
   * Absolute results root chosen by trusted code (for example the gitignored
   * `bench/results` directory). Never derive it from model output or task data.
   */
  readonly rootDirectory: string;
  /**
   * Test seam: publish the complete temp file at the target without replacing
   * an existing file. Defaults to a hard link, which fails with EEXIST.
   */
  readonly publish?: (temporaryPath: string, targetPath: string) => Promise<void>;
}

export interface LocalRunResultWriter {
  /** Validate then publish one result without overwriting. Resolves to the written file path. */
  write(result: unknown): Promise<Readonly<{ path: string }>>;
}

function isSafeRoot(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.includes('\0')) return false;
  if (!isAbsolute(value)) return false;
  return !value.split(/[\\/]/).some((segment) => segment === '..');
}

export function createLocalRunResultWriter(options: LocalRunResultWriterOptions): LocalRunResultWriter {
  const rootValue = (options as Partial<LocalRunResultWriterOptions> | null)?.rootDirectory;
  if (!isSafeRoot(rootValue)) throw new BenchmarkResultError('unsafe_path');
  const rootDirectory = resolve(rootValue);
  const publish = options.publish ?? ((temporaryPath: string, targetPath: string) => link(temporaryPath, targetPath));
  const unsafe = (): Error => new BenchmarkResultError('unsafe_path');

  async function write(value: unknown): Promise<Readonly<{ path: string }>> {
    const validation = validateLocalRunResult(value);
    if (!validation.valid) throw new BenchmarkResultError('invalid_result');
    const result = validation.result;
    const runDirectory = join(rootDirectory, result.runId);
    const fileName = `${result.taskId}-attempt-${result.attempt}.json`;
    const target = join(runDirectory, fileName);

    try {
      await ensureOrdinaryDirectory(rootDirectory, unsafe);
      await ensureOrdinaryDirectory(runDirectory, unsafe);
    } catch {
      throw new BenchmarkResultError('unsafe_path');
    }
    try {
      await lstat(target);
      throw new BenchmarkResultError('result_exists');
    } catch (error) {
      if (error instanceof BenchmarkResultError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BenchmarkResultError('unsafe_path');
    }

    const temporaryPath = join(runDirectory, `.${fileName}.${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A hard link publishes the complete temp file atomically and, unlike
      // rename, fails with EEXIST instead of replacing an existing result.
      try {
        await publish(temporaryPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BenchmarkResultError('result_exists');
        throw new BenchmarkResultError('write_failed');
      }
      return Object.freeze({ path: target });
    } catch (error) {
      if (error instanceof BenchmarkResultError) throw error;
      throw new BenchmarkResultError('write_failed');
    } finally {
      if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  return Object.freeze({ write });
}
