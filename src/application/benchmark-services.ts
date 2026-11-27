import { TASK_STATE_CHANGED_EVENT, type TaskEvent } from '../domain/event.ts';
import type { ApprovalGrantV1 } from '../domain/policy.ts';
import { TASK_ID_PATTERN } from '../domain/task.ts';
import { TOOL_OPERATIONS, type ToolOperationName } from '../domain/tools.ts';
import type {
  BenchmarkAgentOutcome,
  BenchmarkAttemptObservation,
  BenchmarkAttemptObserverPort,
  BenchmarkCatalogPort,
  BenchmarkEvaluationStatus,
  BenchmarkModelDescriptor,
  BenchmarkPatchFacts,
  BenchmarkResultBuilderPort,
  BenchmarkResultRecord,
  BenchmarkResultSinkPort,
  BenchmarkRunMetrics,
  BenchmarkSeed,
  BenchmarkSuiteSummary,
  BenchmarkSuiteTask,
  BenchmarkToolCallCounts,
  ClockPort,
  IdGeneratorPort,
  RunMetricsCollectorFactoryPort,
  RunMetricsCollectorPort,
} from './ports/index.ts';
import type { TaskApplicationServices } from './task-services.ts';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_REPETITIONS = 100;
/** Mirrors the result validator's count ceiling. */
const MAX_PATCH_COUNT = 10_000_000;
const APPROVAL_TTL_MS = 15 * 60_000;
/** apply_unified_diff needs the `write` task operation and nothing else. */
const APPROVED_TASK_OPERATIONS = Object.freeze(['write'] as const);
const AGENT_OUTCOMES = new Set<string>(['proposal', 'refusal', 'error', 'none']);
const TOOL_OPERATION_SET = new Set<string>(TOOL_OPERATIONS);
const NO_PATCH: BenchmarkPatchFacts = Object.freeze({ changedFiles: 0, linesAdded: 0, linesRemoved: 0, sha256: null });

/** Tool failures that mean the proposal did not apply: public FAIL, no oracle verdict. */
const PUBLIC_FAIL_TOOL_CODES = new Set(['hunk_mismatch', 'invalid_tool_request', 'tool_output_too_large']);
/** Tool failures that are policy denials: POLICY_VIOLATION, listed in policyDenials. */
const POLICY_TOOL_CODES = new Set(['tool_policy_denied', 'approval_required', 'g2_isolation_required', 'tool_unavailable']);
/** Evaluator reason codes that map to the same-named evaluator status. */
const EVALUATOR_STATUS_CODES: Readonly<Record<string, BenchmarkEvaluationStatus>> = Object.freeze({
  timeout: 'TIMEOUT',
  crash: 'CRASH',
  runner_failure: 'RUNNER_FAILURE',
  policy_violation: 'POLICY_VIOLATION',
});

export type BenchmarkServiceErrorCode =
  | 'approval_hash_invalid'
  | 'invalid_run_id'
  | 'invalid_repetitions'
  | 'unknown_suite'
  | 'unknown_task'
  | 'unsupported_envelope'
  | 'catalog_unavailable'
  | 'result_invalid'
  | 'result_sink_failed';

/** Fixed-code service error; never carries adapter output, paths, or prompts. */
export class BenchmarkServiceError extends Error {
  readonly code: BenchmarkServiceErrorCode;

  constructor(code: BenchmarkServiceErrorCode) {
    super(code);
    this.name = 'BenchmarkServiceError';
    this.code = code;
  }
}

export interface BenchmarkRunRequest {
  readonly suiteId: string;
  readonly taskId?: string;
  /** Several tasks of the suite (diagnostic subsets); ignored when `taskId` is set. Unknown IDs are rejected. */
  readonly taskIds?: readonly string[];
  readonly repetitions: number;
  /** Generated with the ID port when omitted. */
  readonly runId?: string;
  readonly approvedReviewSetSha256: string;
}

export interface BenchmarkAttemptSummary {
  readonly attemptTaskId: string;
  readonly benchmarkTaskId: string;
  readonly attempt: number;
  readonly status: BenchmarkEvaluationStatus;
}

export interface BenchmarkRunSummary {
  readonly runId: string;
  readonly suiteId: string;
  readonly attempts: readonly BenchmarkAttemptSummary[];
}

export interface BenchmarkReportCounts {
  readonly attempts: number;
  readonly resolved_hidden: number;
  readonly public_pass: number;
  readonly policy_clean: number;
  readonly timeout: number;
  readonly runner_failure: number;
}

export interface BenchmarkReport {
  readonly runId: string;
  readonly totals: BenchmarkReportCounts;
  readonly tasks: Readonly<Record<string, BenchmarkReportCounts>>;
}

export interface BenchmarkApplicationDependencies {
  readonly tasks: TaskApplicationServices;
  readonly catalog: BenchmarkCatalogPort;
  readonly results: BenchmarkResultSinkPort;
  readonly resultBuilder: BenchmarkResultBuilderPort;
  readonly metrics: RunMetricsCollectorFactoryPort;
  readonly observer: BenchmarkAttemptObserverPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly model: BenchmarkModelDescriptor;
  readonly seed: BenchmarkSeed;
}

export interface BenchmarkApplicationServices {
  list(): Promise<readonly BenchmarkSuiteSummary[]>;
  run(request: BenchmarkRunRequest): Promise<BenchmarkRunSummary>;
  report(runId: string): Promise<BenchmarkReport>;
}

/** Inputs from which one attempt's outcome is derived. */
export interface BenchmarkOutcomeInputs {
  readonly events: readonly TaskEvent[];
  readonly observation: BenchmarkAttemptObservation | null;
}

export interface BenchmarkOutcomeDecision {
  readonly publicStatus: BenchmarkEvaluationStatus | null;
  readonly oracleStatus: BenchmarkEvaluationStatus | null;
  readonly failureStatus: BenchmarkEvaluationStatus;
  readonly policyDenialCodes: readonly string[];
}

function decision(
  publicStatus: BenchmarkEvaluationStatus | null,
  oracleStatus: BenchmarkEvaluationStatus | null,
  failureStatus: BenchmarkEvaluationStatus = 'RUNNER_FAILURE',
  policyDenialCodes: readonly string[] = [],
): BenchmarkOutcomeDecision {
  return Object.freeze({ publicStatus, oracleStatus, failureStatus, policyDenialCodes: Object.freeze([...policyDenialCodes]) });
}

/**
 * Applies the plan's outcome mapping: an evaluator verdict from the events wins; otherwise the
 * observer's tool failure code, then its agent outcome; anything else is a runner failure.
 */
export function deriveBenchmarkOutcome(inputs: BenchmarkOutcomeInputs): BenchmarkOutcomeDecision {
  let terminal: TaskEvent | undefined;
  for (const event of inputs.events) {
    if (event.type === TASK_STATE_CHANGED_EVENT) terminal = event;
  }
  if (terminal?.type === TASK_STATE_CHANGED_EVENT && terminal.actor === 'evaluator') {
    if (terminal.to === 'SUCCEEDED' && terminal.reasonCode === 'verification_passed') return decision('PASS', 'PASS');
    if (terminal.to === 'FAILED') {
      const code = terminal.reasonCode ?? '';
      if (code === 'oracle_fail') return decision('PASS', 'FAIL');
      if (code === 'public_fail') return decision('FAIL', null);
      const status = Object.hasOwn(EVALUATOR_STATUS_CODES, code) ? EVALUATOR_STATUS_CODES[code] : undefined;
      if (status) return decision(status, null, status);
      return decision(null, null, 'RUNNER_FAILURE');
    }
  }
  const observation = inputs.observation;
  if (observation?.toolFailureCode) {
    const code = observation.toolFailureCode;
    if (PUBLIC_FAIL_TOOL_CODES.has(code)) return decision('FAIL', null);
    if (POLICY_TOOL_CODES.has(code)) return decision(null, null, 'POLICY_VIOLATION', [code]);
    return decision(null, null, 'RUNNER_FAILURE');
  }
  if (observation?.agentOutcome === 'refusal') return decision('FAIL', null);
  return decision(null, null, 'RUNNER_FAILURE');
}

/** Defensive copy of an observer result; anything malformed counts as no observation. */
function readObservation(value: unknown): BenchmarkAttemptObservation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.agentOutcome !== 'string' || !AGENT_OUTCOMES.has(record.agentOutcome)) return null;
  const operations = Array.isArray(record.toolOperations)
    ? record.toolOperations.filter((operation): operation is string =>
      typeof operation === 'string' && TOOL_OPERATION_SET.has(operation))
    : [];
  const failure = record.toolFailureCode;
  const toolFailureCode = typeof failure === 'string' && REASON_CODE_PATTERN.test(failure) ? failure : null;
  return Object.freeze({
    agentOutcome: record.agentOutcome as BenchmarkAgentOutcome,
    toolOperations: Object.freeze(operations),
    toolFailureCode,
    patch: readPatch(record.patch),
  });
}

function isPatchCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_PATCH_COUNT;
}

/** Defensive copy of observed diff facts; anything malformed or inconsistent counts as no diff. */
function readPatch(value: unknown): BenchmarkPatchFacts {
  if (typeof value !== 'object' || value === null) return NO_PATCH;
  const patch = value as Record<string, unknown>;
  const { changedFiles, linesAdded, linesRemoved, sha256 } = patch;
  if (!isPatchCount(changedFiles) || !isPatchCount(linesAdded) || !isPatchCount(linesRemoved)) return NO_PATCH;
  // A null hash with nonzero counts would fail the result validator, so it also counts as no diff.
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return NO_PATCH;
  return Object.freeze({ changedFiles, linesAdded, linesRemoved, sha256 });
}

function countToolCalls(operations: readonly string[]): BenchmarkToolCallCounts {
  const byOperation = {} as Record<ToolOperationName, number>;
  for (const operation of TOOL_OPERATIONS) byOperation[operation] = 0;
  let total = 0;
  for (const operation of operations) {
    if (!TOOL_OPERATION_SET.has(operation)) continue;
    byOperation[operation as ToolOperationName] += 1;
    total += 1;
  }
  return Object.freeze({ total, byOperation: Object.freeze(byOperation) });
}

const UNAVAILABLE_METRICS: BenchmarkRunMetrics = Object.freeze({
  wallMs: 0,
  firstOutputMs: null,
  sampleCount: 0,
  cpu: Object.freeze({ status: 'unavailable', reason: 'error' }),
  ram: Object.freeze({ status: 'unavailable', reason: 'error' }),
  gpu: Object.freeze({ status: 'unavailable', reason: 'error' }),
  truncated: false,
});

/** Wraps a collector so no failure, thrown or rejected, can reach the run. */
function safeCollector(factory: RunMetricsCollectorFactoryPort): RunMetricsCollectorPort | null {
  try {
    return factory.create() ?? null;
  } catch {
    return null;
  }
}

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    // Metrics and observers never affect the result.
  }
}

async function stopQuietly(collector: RunMetricsCollectorPort | null): Promise<void> {
  if (!collector) return;
  try {
    await collector.stop();
  } catch {
    // Metrics never affect the result.
  }
}

function metricsOf(collector: RunMetricsCollectorPort | null): BenchmarkRunMetrics {
  if (!collector) return UNAVAILABLE_METRICS;
  try {
    const snapshot = collector.snapshot();
    return snapshot?.metrics ?? UNAVAILABLE_METRICS;
  } catch {
    return UNAVAILABLE_METRICS;
  }
}

function expiresAfter(now: string, durationMs: number): string {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) throw new Error('clock_invalid');
  return new Date(current + durationMs).toISOString();
}

function attemptTaskIdFor(benchmarkTaskId: string, runId: string, attempt: number): string {
  return `${benchmarkTaskId.toLowerCase()}-${runId}-${attempt}`;
}

function emptyCounts(): { -readonly [K in keyof BenchmarkReportCounts]: number } {
  return { attempts: 0, resolved_hidden: 0, public_pass: 0, policy_clean: 0, timeout: 0, runner_failure: 0 };
}

function addResult(counts: ReturnType<typeof emptyCounts>, result: BenchmarkResultRecord): void {
  const outcome = result.outcome;
  counts.attempts += 1;
  if (outcome?.resolvedHidden === true) counts.resolved_hidden += 1;
  if (outcome?.publicPass === true) counts.public_pass += 1;
  if (outcome?.policyClean === true) counts.policy_clean += 1;
  if (outcome?.timedOut === true) counts.timeout += 1;
  if (outcome?.runnerFailure === true) counts.runner_failure += 1;
}

export function createBenchmarkApplicationServices(
  dependencies: BenchmarkApplicationDependencies,
): BenchmarkApplicationServices {
  const { tasks, catalog, results, resultBuilder, metrics, observer, clock, ids, model, seed } = dependencies;

  async function list(): Promise<readonly BenchmarkSuiteSummary[]> {
    try {
      return Object.freeze([...await catalog.listSuites()]);
    } catch {
      throw new BenchmarkServiceError('catalog_unavailable');
    }
  }

  /** Creates, classifies, approves, queues, and runs one attempt; returns its terminal events. */
  async function executeAttempt(
    entry: BenchmarkSuiteTask,
    attemptTaskId: string,
    collector: RunMetricsCollectorPort | null,
  ): Promise<readonly TaskEvent[]> {
    try {
      const created = await tasks.createTask({ schemaVersion: 1, taskId: attemptTaskId, ...entry.envelopeInput });
      const classified = await tasks.classifyTask(attemptTaskId);
      if (classified.state !== 'WAITING_APPROVAL') return await tasks.getTaskEvents(attemptTaskId);
      const grant: ApprovalGrantV1 = Object.freeze({
        schemaVersion: 1,
        taskId: attemptTaskId,
        envelopeSha256: created.envelopeSha256,
        operations: APPROVED_TASK_OPERATIONS,
        expiresAt: expiresAfter(clock.now(), APPROVAL_TTL_MS),
        confirmed: true,
      });
      await tasks.approveTask(grant);
      await tasks.queueTask(attemptTaskId);
    } catch {
      return readEventsQuietly(attemptTaskId);
    }
    if (collector) quietly(() => collector.start());
    try {
      await tasks.runTask(attemptTaskId);
    } catch {
      // The outcome is read from the stored events below; an attempt is never retried.
    } finally {
      await stopQuietly(collector);
    }
    return readEventsQuietly(attemptTaskId);
  }

  async function readEventsQuietly(attemptTaskId: string): Promise<readonly TaskEvent[]> {
    try {
      await tasks.getTaskStatus(attemptTaskId);
      return await tasks.getTaskEvents(attemptTaskId);
    } catch {
      return Object.freeze([]);
    }
  }

  async function run(request: BenchmarkRunRequest): Promise<BenchmarkRunSummary> {
    if (typeof request?.approvedReviewSetSha256 !== 'string' || !SHA256_PATTERN.test(request.approvedReviewSetSha256)) {
      throw new BenchmarkServiceError('approval_hash_invalid');
    }
    const repetitions = request.repetitions;
    if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
      throw new BenchmarkServiceError('invalid_repetitions');
    }
    const runId = request.runId === undefined ? ids.next() : request.runId;
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw new BenchmarkServiceError('invalid_run_id');
    if (typeof request.suiteId !== 'string') throw new BenchmarkServiceError('unknown_suite');

    let suite: Awaited<ReturnType<BenchmarkCatalogPort['getSuite']>>;
    try {
      suite = await catalog.getSuite(request.suiteId);
    } catch {
      throw new BenchmarkServiceError('catalog_unavailable');
    }
    if (!suite || suite.suiteId !== request.suiteId) throw new BenchmarkServiceError('unknown_suite');
    const wanted = request.taskId !== undefined ? [request.taskId] : request.taskIds;
    if (wanted !== undefined && (!Array.isArray(wanted) || wanted.length === 0 || wanted.some((id) => typeof id !== 'string'))) {
      throw new BenchmarkServiceError('unknown_task');
    }
    const selected = wanted === undefined
      ? [...suite.tasks]
      : suite.tasks.filter((entry) => wanted.includes(entry.taskId));
    if (selected.length === 0 || (wanted !== undefined && wanted.length !== selected.length)) throw new BenchmarkServiceError('unknown_task');
    for (const entry of selected) {
      const operations = entry.envelopeInput?.requestedOperations;
      if (!Array.isArray(operations) || operations.length !== 1 || operations[0] !== APPROVED_TASK_OPERATIONS[0]) {
        throw new BenchmarkServiceError('unsupported_envelope');
      }
      const resultTaskId = entry.taskId.toLowerCase();
      if (!RUN_ID_PATTERN.test(resultTaskId) || !TASK_ID_PATTERN.test(attemptTaskIdFor(entry.taskId, runId, repetitions))) {
        throw new BenchmarkServiceError('invalid_run_id');
      }
    }

    const attempts: BenchmarkAttemptSummary[] = [];
    for (const entry of selected) {
      for (let attempt = 1; attempt <= repetitions; attempt += 1) {
        const attemptTaskId = attemptTaskIdFor(entry.taskId, runId, attempt);
        const startedAtUtc = clock.now();
        let events: readonly TaskEvent[] = Object.freeze([]);
        let registered = true;
        try {
          await catalog.registerAttempt({ suiteId: suite.suiteId, benchmarkTaskId: entry.taskId, attemptTaskId });
        } catch {
          registered = false;
        }
        quietly(() => observer.begin(attemptTaskId));
        const collector = registered ? safeCollector(metrics) : null;
        if (registered) events = await executeAttempt(entry, attemptTaskId, collector);

        let observation: BenchmarkAttemptObservation | null = null;
        try {
          observation = readObservation(observer.finish(attemptTaskId));
        } catch {
          observation = null;
        }
        const operations = observation?.toolOperations ?? [];
        if (collector) for (const operation of operations) quietly(() => collector.recordToolCall(operation));
        const outcome = deriveBenchmarkOutcome({ events, observation });
        const patch = observation?.patch ?? NO_PATCH;

        let record: BenchmarkResultRecord;
        try {
          record = resultBuilder.build({
            runId,
            taskId: entry.taskId.toLowerCase(),
            attempt,
            suiteId: suite.suiteId,
            startedAtUtc,
            model,
            seed,
            publicStatus: outcome.publicStatus,
            oracleStatus: outcome.oracleStatus,
            failureStatus: outcome.failureStatus,
            toolCalls: countToolCalls(operations),
            changedFiles: patch.changedFiles,
            patch: Object.freeze({ linesAdded: patch.linesAdded, linesRemoved: patch.linesRemoved, sha256: patch.sha256 }),
            logSha256: null,
            policyDenials: Object.freeze({
              count: outcome.policyDenialCodes.length,
              reasonCodes: outcome.policyDenialCodes,
            }),
            metrics: metricsOf(collector),
          });
        } catch {
          throw new BenchmarkServiceError('result_invalid');
        }
        try {
          await results.write(record);
        } catch {
          throw new BenchmarkServiceError('result_sink_failed');
        }
        attempts.push(Object.freeze({
          attemptTaskId,
          benchmarkTaskId: entry.taskId,
          attempt,
          status: record.outcome.status,
        }));
      }
    }
    return Object.freeze({ runId, suiteId: suite.suiteId, attempts: Object.freeze(attempts) });
  }

  async function report(runId: string): Promise<BenchmarkReport> {
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw new BenchmarkServiceError('invalid_run_id');
    let stored: readonly BenchmarkResultRecord[];
    try {
      stored = await results.list(runId);
    } catch {
      throw new BenchmarkServiceError('result_sink_failed');
    }
    const totals = emptyCounts();
    const perTask = new Map<string, ReturnType<typeof emptyCounts>>();
    for (const result of stored) {
      if (result?.runId !== runId || typeof result.taskId !== 'string') continue;
      addResult(totals, result);
      let counts = perTask.get(result.taskId);
      if (!counts) {
        counts = emptyCounts();
        perTask.set(result.taskId, counts);
      }
      addResult(counts, result);
    }
    const tasksReport: Record<string, BenchmarkReportCounts> = {};
    for (const [taskId, counts] of [...perTask.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      tasksReport[taskId] = Object.freeze({ ...counts });
    }
    return Object.freeze({ runId, totals: Object.freeze(totals), tasks: Object.freeze(tasksReport) });
  }

  return Object.freeze({ list, run, report });
}
