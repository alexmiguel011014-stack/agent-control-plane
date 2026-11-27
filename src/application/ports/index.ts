import type { TaskEvent } from '../../domain/event.ts';
import type { TaskState } from '../../domain/state.ts';
import type { ApprovalGrantV1, PolicyDecision, PolicyEvaluationInput } from '../../domain/policy.ts';
import type { SnapshotCaptureReceipt } from '../../domain/snapshot.ts';
import type { TaskEnvelopeV1 } from '../../domain/task.ts';
import type { ToolOperationName, ToolRequest, ToolResponse, UnifiedDiffPlan } from '../../domain/tools.ts';

export interface EventAppendOptions {
  readonly idempotencyKey: string;
  /** Number of already committed events in this task stream. */
  readonly expectedVersion: number;
}

export class EventStoreConflictError extends Error {
  constructor() {
    super('Event stream conflict');
    this.name = 'EventStoreConflictError';
  }
}

export class EventStoreBusyError extends Error {
  readonly lockConflict: LocalLockConflictDetails;

  constructor(lockPath?: string, owner?: LocalLockOwner) {
    super('Event store is busy');
    this.name = 'EventStoreBusyError';
    this.lockConflict = Object.freeze({
      ...(lockPath === undefined ? {} : { lockPath }),
      ...(owner === undefined ? {} : { owner }),
    });
  }
}

export interface TaskEventStorePort {
  /**
   * Resolve the idempotency key before checking expectedVersion. The same key and
   * semantic payload returns the original event, including its original ID/time.
   * A conflicting payload or stream version fails.
   */
  append(event: TaskEvent, options: EventAppendOptions): Promise<TaskEvent>;
  read(taskId: string, afterEventId?: string): Promise<readonly TaskEvent[]>;
  /** Enumerate only task streams whose first committed event is task.created. */
  listTaskIds(): Promise<readonly string[]>;
}

export interface TaskExecutionLease {
  /** Release only the lease acquired by this handle. */
  release(): Promise<void>;
}

export type TaskExecutionLeaseKind = 'run' | 'recovery';

export interface LocalLockOwner {
  readonly pid: number;
  readonly kind: string;
}

export interface LocalLockConflictDetails {
  readonly lockPath?: string;
  readonly owner?: LocalLockOwner;
}

export class TaskExecutionLeaseBusyError extends Error {
  readonly lockConflict: LocalLockConflictDetails;

  constructor(lockPath?: string, owner?: LocalLockOwner) {
    super('A local execution lock exists and blocks the requested operation');
    this.name = 'TaskExecutionLeaseBusyError';
    this.lockConflict = Object.freeze({
      ...(lockPath === undefined ? {} : { lockPath }),
      ...(owner === undefined ? {} : { owner }),
    });
  }
}

export interface TaskExecutionLeasePort {
  /** Try an exclusive cross-process lease; any existing lock fails closed. */
  tryAcquire(kind: TaskExecutionLeaseKind): Promise<TaskExecutionLease>;
}

export interface StoredTaskEnvelope {
  readonly envelope: TaskEnvelopeV1;
  readonly envelopeSha256: string;
}

export type SaveTaskResult = 'created' | 'already_exists' | 'conflict';

export interface TaskRepositoryPort {
  /** Create-if-absent by taskId; a reused ID with another hash is a conflict. */
  saveIfAbsent(envelope: TaskEnvelopeV1, envelopeSha256: string): Promise<SaveTaskResult>;
  get(taskId: string): Promise<StoredTaskEnvelope | null>;
}

export interface EnvelopeHasherPort {
  hash(envelope: TaskEnvelopeV1): Promise<string>;
}

/** Reads one explicitly selected disposable directory and publishes its safe files by content hash. */
export interface SnapshotCapturePort {
  capture(sourceDirectory: string): Promise<SnapshotCaptureReceipt>;
}

export interface PolicyEvaluatorPort {
  evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision>;
}

export interface ClockPort {
  now(): string;
}

export interface ObservedTaskStream {
  readonly taskId: string;
  readonly events: readonly TaskEvent[];
}

export interface ObservedTaskReaderPort {
  readStreams(): Promise<readonly ObservedTaskStream[]>;
}

export interface ObservedRunSummary {
  readonly runId: string;
  readonly suiteId: string;
  readonly modelTag: string;
  readonly startedAtUtc: string;
  readonly attempts: number;
  readonly counts: Readonly<Record<BenchmarkEvaluationStatus, number>>;
}

export interface BenchmarkRunReaderPort {
  listRuns(limit: number): Promise<readonly ObservedRunSummary[]>;
}

export interface ObservedResources {
  readonly gpu: { readonly status: 'available'; readonly usedMiB: number; readonly totalMiB: number } | { readonly status: 'unavailable' };
  readonly ramFreeBytes: number;
  readonly ramTotalBytes: number;
  readonly cpuPercent: number | null;
}

export interface ResourceSamplerPort {
  sample(): Promise<ObservedResources>;
}

export interface ObservedTask {
  readonly taskId: string;
  readonly state: TaskState;
  readonly eventCount: number;
  readonly lastEventAt: string;
}

export interface ObservabilitySnapshot {
  readonly generatedAt: string;
  readonly tasks: readonly ObservedTask[];
  readonly runs: readonly ObservedRunSummary[];
  readonly resources: ObservedResources;
}

export interface IdGeneratorPort {
  next(): string;
}

export interface WorkspaceReference {
  /** Opaque ID; the application does not handle host filesystem paths. */
  readonly workspaceId: string;
}

export interface WorkspaceAllocationPort {
  allocate(envelope: TaskEnvelopeV1, executionId: string): Promise<WorkspaceReference>;
}

export type WorkspaceIntegrityPhase = 'after_tools' | 'after_evaluator';

export type WorkspaceIntegrityResult =
  | Readonly<{ outcome: 'allow'; changedPaths: readonly string[] }>
  | Readonly<{ outcome: 'deny'; reasonCode: string; changedPaths: readonly string[] }>;

export interface WorkspaceIntegrityPort {
  /** Verifies the restored baseline before the run is recorded or an agent starts. */
  verifyBeforeRun(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
    readonly executionId: string;
  }): Promise<WorkspaceIntegrityResult>;
  /** Checks concrete changes after tools and again after the evaluator. */
  verifyAfterPhase(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
    readonly executionId: string;
    readonly phase: WorkspaceIntegrityPhase;
  }): Promise<WorkspaceIntegrityResult>;
}

export type WorkspacePathOperation = 'read' | 'write' | 'list' | 'diff';

/** Opaque path token that never contains a host absolute path. */
export interface WorkspacePathReference {
  readonly relativePath: string;
  readonly token: string;
}

export interface WorkspacePathAccessPort {
  /** Returns at most maxResults + 1 paths; a maxResults + 1 result signals overflow. */
  listAllowed(input: {
    readonly workspace: WorkspaceReference;
    readonly allowedPatterns: readonly string[];
    readonly maxResults: number;
    readonly prefix?: string;
  }): Promise<readonly string[]>;
  resolveAllowed(input: {
    readonly workspace: WorkspaceReference;
    readonly relativePath: string;
    readonly operation: WorkspacePathOperation;
    readonly allowedPatterns: readonly string[];
  }): Promise<WorkspacePathReference | null>;
  readText(input: {
    readonly workspace: WorkspaceReference;
    readonly relativePath: string;
    readonly allowedPatterns: readonly string[];
    readonly maxBytes: number;
  }): Promise<string>;
  gitDiff(input: {
    readonly workspace: WorkspaceReference;
    readonly allowedPatterns: readonly string[];
    readonly relativePaths?: readonly string[];
    readonly maxOutputBytes: number;
  }): Promise<string>;
}

export interface UnifiedDiffApplicationPort {
  apply(input: {
    readonly workspace: WorkspaceReference;
    readonly plan: UnifiedDiffPlan;
    readonly paths: readonly WorkspacePathReference[];
  }): Promise<void>;
}

export interface DeclaredTestRunnerPort {
  /**
   * Runs a registered host-owned harness case. The host sends bounded, schema-validated JSON to
   * the isolated worker and compares its response against host-side expectations; it never runs
   * a test script from the workspace or sends expected values to the worker.
   */
  run(input: {
    readonly workspace: WorkspaceReference;
    readonly testId: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly passed: boolean }>;
}

export interface DeclaredTestRegistryPort {
  /** True only for immutable test IDs registered by trusted host code. */
  isRegistered(testId: string): boolean;
}

export interface GeneratedCodeExecutionGatePort {
  /** Absent or false before G2.2; callers fail closed. */
  isOpen(): Promise<boolean>;
}

/** Envelope fields a benchmark catalog supplies; the service adds the attempt task ID. */
export interface BenchmarkEnvelopeInput {
  readonly prompt: string;
  readonly requestedOperations: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly declaredTests: readonly unknown[];
  readonly baseSnapshotSha256: string;
}

export interface BenchmarkSuiteTask {
  /** Benchmark task ID as the catalog names it, for example `B01`. */
  readonly taskId: string;
  readonly envelopeInput: BenchmarkEnvelopeInput;
  /** Execution facts of the task manifest; used by the comparison package, not by attempts. */
  readonly execution?: Readonly<{ timeoutMs: number; publicTestCommandId: string }>;
}

export interface BenchmarkSuite {
  readonly suiteId: string;
  /** Tasks in catalog order. */
  readonly tasks: readonly BenchmarkSuiteTask[];
}

export interface BenchmarkSuiteSummary {
  readonly suiteId: string;
  readonly taskIds: readonly string[];
}

export interface BenchmarkCatalogPort {
  listSuites(): Promise<readonly BenchmarkSuiteSummary[]>;
  /** Resolves null for an unknown suite. */
  getSuite(suiteId: string): Promise<BenchmarkSuite | null>;
  /** Records which benchmark task an attempt task ID belongs to; rejects IDs outside the suite. */
  registerAttempt(input: {
    readonly suiteId: string;
    readonly benchmarkTaskId: string;
    readonly attemptTaskId: string;
  }): Promise<void>;
  /** Benchmark task ID for a registered attempt task ID, or null. */
  benchmarkTaskIdFor(attemptTaskId: string): string | null;
}

export type BenchmarkEvaluationStatus = 'PASS' | 'FAIL' | 'POLICY_VIOLATION' | 'TIMEOUT' | 'CRASH' | 'RUNNER_FAILURE';

export interface BenchmarkOutcome {
  readonly status: BenchmarkEvaluationStatus;
  readonly publicStatus: BenchmarkEvaluationStatus | null;
  readonly oracleStatus: BenchmarkEvaluationStatus | null;
  readonly resolvedHidden: boolean;
  readonly publicPass: boolean;
  readonly policyClean: boolean;
  readonly timedOut: boolean;
  readonly runnerFailure: boolean;
}

export interface BenchmarkRunMetrics {
  readonly wallMs: number;
  readonly firstOutputMs: number | null;
  readonly sampleCount: number;
  readonly cpu:
    | Readonly<{ status: 'unavailable'; reason: string }>
    | Readonly<{ status: 'available'; userMs: number; systemMs: number; peakPercent: number | null }>;
  readonly ram:
    | Readonly<{ status: 'unavailable'; reason: string }>
    | Readonly<{ status: 'available'; peakRssBytes: number; minSystemFreeBytes: number; systemTotalBytes: number }>;
  readonly gpu:
    | Readonly<{ status: 'unavailable'; reason: string }>
    | Readonly<{ status: 'available'; peakUsedMiB: number; totalMiB: number; samples: number }>;
  readonly truncated: boolean;
}

export interface BenchmarkToolCallCounts {
  readonly total: number;
  readonly byOperation: Readonly<Record<ToolOperationName, number>>;
}

export interface BenchmarkModelDescriptor {
  readonly tag: string;
  readonly digest: string | null;
  readonly runtimeVersion: string | null;
}

export interface BenchmarkSeed {
  readonly capable: boolean;
  readonly value: number | null;
}

/** Structural copy of the local run result record (schema version 1); ids, counts, and codes only. */
export interface BenchmarkResultRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly suiteId: string;
  readonly startedAtUtc: string;
  readonly model: BenchmarkModelDescriptor;
  readonly seed: BenchmarkSeed;
  readonly outcome: BenchmarkOutcome;
  readonly toolCalls: BenchmarkToolCallCounts;
  readonly changedFiles: number;
  readonly patch: Readonly<{ linesAdded: number; linesRemoved: number; sha256: string | null }>;
  readonly logSha256: string | null;
  readonly policyDenials: Readonly<{ count: number; reasonCodes: readonly string[] }>;
  readonly metrics: BenchmarkRunMetrics;
}

/** Outcome inputs for one attempt; the builder derives the outcome and validates the record. */
export interface BenchmarkResultBuildInput {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly suiteId: string;
  readonly startedAtUtc: string;
  readonly model: BenchmarkModelDescriptor;
  readonly seed: BenchmarkSeed;
  readonly publicStatus: BenchmarkEvaluationStatus | null;
  readonly oracleStatus: BenchmarkEvaluationStatus | null;
  /** Status used when publicStatus is null. */
  readonly failureStatus: BenchmarkEvaluationStatus;
  readonly toolCalls: BenchmarkToolCallCounts;
  readonly changedFiles: number;
  readonly patch: Readonly<{ linesAdded: number; linesRemoved: number; sha256: string | null }>;
  readonly logSha256: string | null;
  readonly policyDenials: Readonly<{ count: number; reasonCodes: readonly string[] }>;
  readonly metrics: BenchmarkRunMetrics;
}

export interface BenchmarkResultBuilderPort {
  /** Returns a validated, frozen record or throws; never returns an invalid record. */
  build(input: BenchmarkResultBuildInput): BenchmarkResultRecord;
}

export interface BenchmarkResultSinkPort {
  /** Persists one result without overwriting; rejects on any failure. */
  write(result: BenchmarkResultRecord): Promise<void>;
  list(runId: string): Promise<readonly BenchmarkResultRecord[]>;
}

export interface RunMetricsCollectorPort {
  start(): void;
  markFirstOutput(): void;
  recordToolCall(operation: unknown): void;
  stop(): Promise<void>;
  snapshot(): Readonly<{ metrics: BenchmarkRunMetrics; toolCalls: BenchmarkToolCallCounts }>;
}

export interface RunMetricsCollectorFactoryPort {
  create(): RunMetricsCollectorPort;
}

export type BenchmarkAgentOutcome = 'proposal' | 'refusal' | 'error' | 'none';

export interface BenchmarkAttemptObservation {
  readonly agentOutcome: BenchmarkAgentOutcome;
  /** Tool operations of the proposal; unknown shapes count as none. */
  readonly toolOperations: readonly string[];
  /** Fixed tool failure code, or null when no tool failed. */
  readonly toolFailureCode: string | null;
  /** Diff facts of the proposal; all zero and null when there is no diff. */
  readonly patch: BenchmarkPatchFacts;
}

export interface BenchmarkPatchFacts {
  readonly changedFiles: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** Lowercase hex SHA-256 of the diff, or null when there is no diff. */
  readonly sha256: string | null;
}

/** Facts recorded by the composition's agent and tool observers, per attempt task ID. */
export interface BenchmarkAttemptObserverPort {
  begin(attemptTaskId: string): void;
  finish(attemptTaskId: string): BenchmarkAttemptObservation;
}

export interface AgentProposal {
  /** Opaque, structured proposal handle; never a shell command. */
  readonly proposalId: string;
  /** Strictly parsed requests after the complete proposal passes the gateway boundary. */
  readonly toolRequests: readonly ToolRequest[];
}

/** Agent outcomes are data; proposal payloads remain unknown until the tool gateway validates them. */
export type AgentInvocationResult =
  | Readonly<{ kind: 'proposal'; proposal: unknown }>
  | Readonly<{ kind: 'refusal'; reasonCode?: string }>;

export interface AgentInvocationPort {
  invoke(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
  }): Promise<AgentInvocationResult>;
}

export interface ToolExecutionPort {
  execute(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly envelopeSha256: string;
    readonly approval?: ApprovalGrantV1;
    readonly workspace: WorkspaceReference;
    readonly proposal: unknown;
  }): Promise<readonly ToolResponse[]>;
}

export interface TaskExecutionControlPort {
  /**
   * Must be idempotent for a taskId/executionId and resolve within the adapter's bounded stop deadline. `quiescent: true`
   * means the active agent, tools, evaluator, and owned child processes have all stopped.
   * G1.2 tests use fakes; OS-level proof remains gated by G2.2.
   */
  cancelTask(input: {
    readonly taskId: string;
    readonly executionId: string;
  }): Promise<{ readonly quiescent: boolean }>;
}

export interface EvaluatorResult {
  readonly passed: boolean;
  readonly reasonCode: string;
}

export interface EvaluatorInvocationPort {
  evaluate(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
  }): Promise<EvaluatorResult>;
}

export type LocalRuntimeDiagnostic =
  | Readonly<{ status: 'ready'; runtimeVersion: string; modelTag: string; modelDigest: string }>
  | Readonly<{ status: 'runtime_unavailable'; modelTag: string }>
  | Readonly<{ status: 'model_missing'; runtimeVersion: string; modelTag: string }>
  | Readonly<{ status: 'invalid_runtime_response'; modelTag: string }>;

export interface LocalRuntimeSmokeOutput {
  readonly schemaVersion: 1;
  readonly ready: true;
  readonly summary: 'local-smoke-ok';
}

export type LocalRuntimeSmoke =
  | Readonly<{
    status: 'passed';
    runtimeVersion: string;
    modelTag: string;
    modelDigest: string;
    output: LocalRuntimeSmokeOutput;
  }>
  | Readonly<{ status: 'blocked'; reasonCode: 'runtime_unavailable' | 'model_missing' | 'invalid_runtime_response' | 'model_not_allowed'; modelTag: string }>
  | Readonly<{ status: 'failed'; reasonCode: 'timeout' | 'invalid_structured_output' | 'runtime_request_failed'; modelTag: string }>;

/** G2.1-only local read-only inference probe; it cannot execute tools or candidate code. */
export interface LocalRuntimeSmokePort {
  diagnose(modelTag: string): Promise<LocalRuntimeDiagnostic>;
  smoke(modelTag: string): Promise<LocalRuntimeSmoke>;
}
