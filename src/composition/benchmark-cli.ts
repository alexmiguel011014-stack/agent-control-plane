import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApplicationServiceError } from '../application/errors.ts';
import {
  type BenchmarkApplicationServices,
  createBenchmarkApplicationServices,
} from '../application/benchmark-services.ts';
import type {
  AgentInvocationPort,
  AgentInvocationResult,
  BenchmarkAgentOutcome,
  BenchmarkAttemptObservation,
  BenchmarkAttemptObserverPort,
  BenchmarkCatalogPort,
  BenchmarkModelDescriptor,
  BenchmarkPatchFacts,
  BenchmarkResultBuilderPort,
  BenchmarkResultRecord,
  BenchmarkResultSinkPort,
  GeneratedCodeExecutionGatePort,
  RunMetricsCollectorFactoryPort,
  ToolExecutionPort,
} from '../application/ports/index.ts';
import {
  type ComparisonApplicationServices,
  type ComparisonFilePort,
  type ComparisonTaskSourcePort,
  createComparisonServices,
} from '../application/comparison-services.ts';
import { createRuntimeApplicationServices } from '../application/runtime-services.ts';
import { createSnapshotApplicationServices } from '../application/snapshot-services.ts';
import { createTaskApplicationServices } from '../application/task-services.ts';
import { AttestationGeneratedCodeGate } from '../adapters/attestation-gate.ts';
import { type EvaluateWorkspace, G0ModelWorkspaceEvaluator } from '../adapters/g0-model-evaluator.ts';
import { OLLAMA_AGENT_DEFAULTS, OllamaAgentAdapter, type OllamaContextReader, type OllamaInvocationMetadata } from '../adapters/ollama.ts';
import { OllamaReadOnlySmokeAdapter } from '../adapters/ollama-smoke.ts';
import { createWorkspaceContextReader } from '../adapters/workspace-context-reader.ts';
import { TOOL_OPERATIONS, TOOL_REQUEST_LIMITS } from '../domain/tools.ts';
import { BenchmarkCatalogError, type BenchmarkCatalogShape, LocalBenchmarkCatalog } from '../infra/benchmark-catalog.ts';
import {
  createLocalRunResultWriter,
  deriveLocalRunOutcome,
  LOCAL_RUN_RESULT_ID_PATTERN,
  validateLocalRunResult,
} from '../infra/benchmark-result.ts';
import { NodeEnvelopeHasher } from '../infra/envelope-hasher.ts';
import { JsonlTaskEventStore } from '../infra/jsonl-event-store.ts';
import { LocalSnapshotStore } from '../infra/local-snapshot-store.ts';
import { createRunMetricsCollector } from '../infra/metrics.ts';
import { LocalTaskExecutionLease } from '../infra/task-execution-lease.ts';
import { LocalTaskEnvelopeStore } from '../infra/task-envelope-store.ts';
import type { CliApplication } from '../interfaces/cli/agentctl.ts';
import { createPolicyEngine } from '../policy/policy-engine.ts';
import { ClosedToolGateway, ToolGatewayError } from '../tools/tool-gateway.ts';
import { SnapshotWorkspaceManager, WorkspacePatchError } from '../workspace/snapshot-manager.ts';

/** State directory of the benchmark composition, relative to the repository root (gitignored). */
export const BENCHMARK_STATE_RELATIVE_PATH = Object.freeze(['.agentctl', 'benchmark'] as const);
/** Result root of local benchmark runs, relative to the repository root (gitignored). */
export const BENCHMARK_RESULTS_RELATIVE_PATH = Object.freeze(['bench', 'results', 'local'] as const);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RESULT_FILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}-attempt-[1-9][0-9]{0,3}\.json$/;
const MAX_RESULT_FILE_BYTES = 1_048_576;
const RUNTIME_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const TOOL_OPERATION_SET = new Set<string>(TOOL_OPERATIONS);
const TOOL_GATEWAY_FAILURE_CODES = new Set<string>([
  'invalid_tool_request',
  'tool_policy_denied',
  'approval_required',
  'g2_isolation_required',
  'tool_unavailable',
  'tool_output_too_large',
]);
/** Fixed code for any tool failure that is neither a gateway refusal nor a hunk mismatch. */
const GENERIC_TOOL_FAILURE_CODE = 'tool_error';
const NO_PATCH: BenchmarkPatchFacts = Object.freeze({ changedFiles: 0, linesAdded: 0, linesRemoved: 0, sha256: null });

export type BenchmarkCompositionErrorCode =
  | 'approval_hash_invalid'
  | 'repository_root_invalid'
  | 'agent_override_invalid'
  | 'read_only';

/** Fixed-code composition refusal; never carries paths or caller input. */
export class BenchmarkCompositionError extends Error {
  readonly code: BenchmarkCompositionErrorCode;

  constructor(code: BenchmarkCompositionErrorCode) {
    super(code);
    this.name = 'BenchmarkCompositionError';
    this.code = code;
  }
}

export interface BenchmarkApplicationOptions {
  /** Absolute repository root chosen by trusted host code. */
  readonly repositoryRoot: string;
  /** Owner-approved lowercase SHA-256 of the G0 review set. */
  readonly approvedReviewSetSha256: string;
  /**
   * Replaces only the agent port (the observer still wraps it). It exists for the pipeline
   * smoke script (G19.12); no CLI code may set it.
   */
  readonly agentOverride?: AgentInvocationPort;
  /**
   * Builds the agent from the composition's read-only context reader. Dev scripts only; no CLI
   * code may set it. It cannot be combined with `agentOverride`.
   */
  readonly agentFactory?: (tools: { readonly contextReader: OllamaContextReader }) => AgentInvocationPort;
  /**
   * Read-only composition for `benchmark list` and `benchmark report` (default false). It skips
   * the upfront approval check (those commands pass a sentinel hash and never evaluate), skips
   * `recoverAfterRestart` (no INTERRUPTED events, no recovery lease), never loads the evaluator,
   * and refuses `benchmark.run` with `read_only`.
   *
   * Rule: every composition that is not read-only, with or without the test seams or
   * `agentOverride`, awaits `createEvaluator()` once before it returns and refuses with
   * `approval_hash_invalid` when that fails, so a wrong but well-formed review-set hash stops
   * before any agent call. Each attempt still calls `createEvaluator()` again as the re-check.
   */
  readonly readOnly?: boolean;
  /** Ollama model tag; defaults to OLLAMA_AGENT_DEFAULTS.modelTag. Validated by the adapter. */
  readonly modelTag?: string;
  /**
   * Diagnostic only (never set by agentctl): receives each agent result, including proposed diff
   * text, so a developer script can keep it in a scratch folder. It cannot alter the result.
   */
  /** Tuning only (never set by agentctl): adapter knobs for prompt and context experiments. */
  readonly adapterTuning?: Readonly<{ numCtx?: number; numPredict?: number; systemPromptAddendum?: string; think?: boolean; answerFormat?: 'json' | 'blocks'; temperature?: number; timeoutMs?: number; localize?: 'trace' | 'helpers' | 'rules' | 'calc' | 'probe' | 'ensemble'; verify?: boolean; keepAlive?: string }>;
  readonly proposalSink?: (result: AgentInvocationResult) => void;
}

/**
 * Test-only seams for impure parts the composition builds internally. Not reachable from the
 * CLI: agentctl passes only `BenchmarkApplicationOptions`. Production callers omit this argument.
 */
export interface BenchmarkApplicationTestSeams {
  /** Replaces the catalog port (the real one reads `bench/tasks` under the repository root). */
  readonly catalog?: BenchmarkCatalogPort;
  /** Replaces the G2.2 attestation gate held by the tool gateway. */
  readonly generatedCodeGate?: GeneratedCodeExecutionGatePort;
  /** Replaces the approved evaluator closure factory (the real one loads `bench/evaluator/index.mjs`). */
  readonly createEvaluator?: () => Promise<EvaluateWorkspace>;
  /** Replaces the metrics collector factory (the real one samples the host and `nvidia-smi`). */
  readonly metrics?: RunMetricsCollectorFactoryPort;
}

/** Comparison task lookup over the benchmark catalog port; null when the task or its manifest facts are missing. */
function createComparisonTaskSource(catalog: BenchmarkCatalogPort): ComparisonTaskSourcePort {
  return {
    async getTask(taskId: string) {
      for (const summary of await catalog.listSuites()) {
        if (!summary.taskIds.includes(taskId)) continue;
        const suite = await catalog.getSuite(summary.suiteId);
        const task = suite?.tasks.find((entry) => entry.taskId === taskId);
        if (!task || !task.execution) return null;
        return Object.freeze({
          taskId: task.taskId,
          prompt: task.envelopeInput.prompt,
          allowedPaths: task.envelopeInput.allowedPaths,
          baseSnapshotSha256: task.envelopeInput.baseSnapshotSha256,
          timeoutMs: task.execution.timeoutMs,
          publicTestCommandId: task.execution.publicTestCommandId,
        });
      }
      return null;
    },
  };
}

const COMPARISON_MAX_FILE_BYTES = 1_048_576;

/** Repository-relative file access for comparison artifacts: no absolute paths, no traversal, no overwrite. */
function createRepositoryFilePort(repositoryRoot: string): ComparisonFilePort {
  const resolveSafe = (relative: string): string => {
    const normalized = relative.replaceAll('\\', '/');
    if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
      || normalized.split('/').some((part) => part === '..' || part === '')) {
      throw new Error('unsafe_path');
    }
    return join(repositoryRoot, ...normalized.split('/'));
  };
  return {
    async readText(relative: string) {
      const target = resolveSafe(relative);
      try {
        const info = await stat(target);
        if (!info.isFile() || info.size > COMPARISON_MAX_FILE_BYTES) throw new Error('unreadable_file');
        return await readFile(target, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async writeNewText(relative: string, text: string) {
      const target = resolveSafe(relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, { encoding: 'utf8', flag: 'wx' });
    },
  };
}

export interface BenchmarkCliApplication extends CliApplication {
  readonly benchmark: BenchmarkApplicationServices;
  readonly comparison: ComparisonApplicationServices;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Adapts the local catalog's synchronous or throwing methods to the application port's promise
 * and null shapes. The catalog itself is unchanged.
 */
export function adaptBenchmarkCatalog(catalog: BenchmarkCatalogShape): BenchmarkCatalogPort {
  return Object.freeze({
    async listSuites() {
      return catalog.listSuites();
    },
    async getSuite(suiteId: string) {
      let suite: Awaited<ReturnType<BenchmarkCatalogShape['getSuite']>>;
      try {
        suite = await catalog.getSuite(suiteId);
      } catch (error) {
        if (error instanceof BenchmarkCatalogError && error.code === 'unknown_suite') return null;
        throw error;
      }
      return Object.freeze({
        suiteId: suite.suiteId,
        tasks: Object.freeze(suite.tasks.map((task) => Object.freeze({
          taskId: task.benchmarkTaskId,
          execution: task.execution,
          envelopeInput: Object.freeze({
            prompt: task.envelopeInput.prompt,
            requestedOperations: task.envelopeInput.requestedOperations,
            allowedPaths: task.envelopeInput.allowedPaths,
            declaredTests: task.envelopeInput.declaredTests,
            baseSnapshotSha256: task.envelopeInput.baseSnapshotSha256,
          }),
        }))),
      });
    },
    async registerAttempt(input: { readonly suiteId: string; readonly benchmarkTaskId: string; readonly attemptTaskId: string }) {
      const suites = await catalog.listSuites();
      if (!suites.some((suite) => suite.suiteId === input.suiteId)) throw new BenchmarkCatalogError('unknown_suite');
      catalog.registerAttempt(input.attemptTaskId, input.benchmarkTaskId);
    },
    benchmarkTaskIdFor(attemptTaskId: string) {
      try {
        return catalog.benchmarkTaskIdFor(attemptTaskId);
      } catch {
        return null;
      }
    },
  });
}

function hunkCount(value: string | undefined): number {
  return value === undefined ? 1 : Number.parseInt(value, 10);
}

/**
 * Line facts of one unified diff. Hunk bodies are consumed by their header counts, so the
 * `---`/`+++` file headers are never counted. Any malformed hunk makes the whole diff unknown.
 */
function diffLineFacts(diff: string): { changedFiles: number; linesAdded: number; linesRemoved: number } | null {
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let changedFiles = 0;
  let headerFiles = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    index += 1;
    if (line.startsWith('diff --git ')) {
      changedFiles += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      headerFiles += 1;
      continue;
    }
    if (!line.startsWith('@@')) continue;
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (!header) return null;
    let oldRemaining = hunkCount(header[1]);
    let newRemaining = hunkCount(header[2]);
    while (oldRemaining > 0 || newRemaining > 0) {
      if (index >= lines.length) return null;
      const body = lines[index] as string;
      index += 1;
      if (body.startsWith('\\')) continue;
      const marker = body[0];
      if (marker === '+') {
        if (newRemaining === 0) return null;
        newRemaining -= 1;
        linesAdded += 1;
      } else if (marker === '-') {
        if (oldRemaining === 0) return null;
        oldRemaining -= 1;
        linesRemoved += 1;
      } else if (marker === ' ' || body.length === 0) {
        if (oldRemaining === 0 || newRemaining === 0) return null;
        oldRemaining -= 1;
        newRemaining -= 1;
      } else {
        return null;
      }
    }
  }
  return { changedFiles: changedFiles > 0 ? changedFiles : headerFiles, linesAdded, linesRemoved };
}

/** Known tool requests of a proposal, or null when its shape is unknown. Never throws. */
function proposalRequests(proposal: unknown): readonly Record<string, unknown>[] | null {
  try {
    if (!isPlainRecord(proposal) || !Array.isArray(proposal.toolRequests)) return null;
    const requests = proposal.toolRequests as unknown[];
    if (requests.length > TOOL_REQUEST_LIMITS.maxRequests) return null;
    for (const request of requests) {
      if (!isPlainRecord(request) || typeof request.operation !== 'string' || !TOOL_OPERATION_SET.has(request.operation)) {
        return null;
      }
    }
    return requests as Record<string, unknown>[];
  } catch {
    return null;
  }
}

/** Tool operations of a proposal; unknown shapes count as none. Never throws. */
export function proposalToolOperations(proposal: unknown): readonly string[] {
  const requests = proposalRequests(proposal);
  return Object.freeze(requests ? requests.map((request) => request.operation as string) : []);
}

/**
 * Patch facts of the `apply_unified_diff` requests of a proposal: file sections, added and removed
 * hunk lines, and the SHA-256 of the diff text (of the texts concatenated in order when there are
 * several). Unknown shapes count as no diff. The diff text is never kept. Never throws.
 */
export function proposalPatchFacts(proposal: unknown): BenchmarkPatchFacts {
  try {
    const requests = proposalRequests(proposal);
    if (!requests) return NO_PATCH;
    const diffs: string[] = [];
    for (const request of requests) {
      if (request.operation !== 'apply_unified_diff') continue;
      const diff = request.diff;
      if (typeof diff !== 'string' || diff.length === 0 || Buffer.byteLength(diff, 'utf8') > TOOL_REQUEST_LIMITS.maxDiffBytes) {
        return NO_PATCH;
      }
      diffs.push(diff);
    }
    if (diffs.length === 0) return NO_PATCH;
    let changedFiles = 0;
    let linesAdded = 0;
    let linesRemoved = 0;
    const hash = createHash('sha256');
    for (const diff of diffs) {
      const facts = diffLineFacts(diff);
      if (!facts) return NO_PATCH;
      changedFiles += facts.changedFiles;
      linesAdded += facts.linesAdded;
      linesRemoved += facts.linesRemoved;
      hash.update(diff, 'utf8');
    }
    return Object.freeze({ changedFiles, linesAdded, linesRemoved, sha256: hash.digest('hex') });
  } catch {
    return NO_PATCH;
  }
}

/**
 * Fixed failure code of a tool error; never keeps error text. The applier's own path refusal
 * (`path_denied`) is a policy denial like the gateway's; other applier codes stay generic.
 */
export function toolFailureCodeOf(error: unknown): string {
  if (error instanceof ToolGatewayError && TOOL_GATEWAY_FAILURE_CODES.has(error.code)) return error.code;
  if (error instanceof WorkspacePatchError && error.code === 'hunk_mismatch') return 'hunk_mismatch';
  if (error instanceof WorkspacePatchError && error.code === 'path_denied') return 'tool_policy_denied';
  return GENERIC_TOOL_FAILURE_CODE;
}

interface AttemptState {
  agentOutcome: BenchmarkAgentOutcome;
  toolOperations: readonly string[];
  toolFailureCode: string | null;
  patch: BenchmarkPatchFacts;
}

function freshState(): AttemptState {
  return { agentOutcome: 'none', toolOperations: Object.freeze([]), toolFailureCode: null, patch: NO_PATCH };
}

export interface BenchmarkAttemptObservers extends BenchmarkAttemptObserverPort {
  wrapAgent(agent: AgentInvocationPort): AgentInvocationPort;
  wrapTools(tools: ToolExecutionPort): ToolExecutionPort;
}

/**
 * Records, per attempt task ID, the agent outcome, the proposal's tool operations and patch facts,
 * and the tool failure code. The wrappers take the attempt task ID from each call's envelope and
 * record only for attempts that began. Recording never throws and never changes a port's result.
 */
export function createBenchmarkAttemptObservers(): BenchmarkAttemptObservers {
  const states = new Map<string, AttemptState>();

  function record(envelope: unknown, update: (state: AttemptState) => void): void {
    try {
      const taskId = typeof envelope === 'object' && envelope !== null
        ? (envelope as { taskId?: unknown }).taskId
        : undefined;
      if (typeof taskId !== 'string') return;
      const state = states.get(taskId);
      if (state) update(state);
    } catch {
      // Observation never affects the attempt.
    }
  }

  return Object.freeze({
    begin(attemptTaskId: string) {
      states.set(attemptTaskId, freshState());
    },
    finish(attemptTaskId: string): BenchmarkAttemptObservation {
      const state = states.get(attemptTaskId) ?? freshState();
      states.delete(attemptTaskId);
      return Object.freeze({
        agentOutcome: state.agentOutcome,
        toolOperations: Object.freeze([...state.toolOperations]),
        toolFailureCode: state.toolFailureCode,
        patch: state.patch,
      });
    },
    wrapAgent(agent: AgentInvocationPort): AgentInvocationPort {
      return Object.freeze({
        async invoke(input: Parameters<AgentInvocationPort['invoke']>[0]): Promise<AgentInvocationResult> {
          let result: AgentInvocationResult;
          try {
            result = await agent.invoke(input);
          } catch (error) {
            record(input?.envelope, (state) => { state.agentOutcome = 'error'; });
            throw error;
          }
          record(input?.envelope, (state) => {
            const kind = (result as { kind?: unknown } | null)?.kind;
            if (kind === 'proposal') state.agentOutcome = 'proposal';
            else if (kind === 'refusal') state.agentOutcome = 'refusal';
          });
          return result;
        },
      });
    },
    wrapTools(tools: ToolExecutionPort): ToolExecutionPort {
      return Object.freeze({
        async execute(input: Parameters<ToolExecutionPort['execute']>[0]) {
          record(input?.envelope, (state) => {
            state.toolOperations = proposalToolOperations(input.proposal);
            state.patch = proposalPatchFacts(input.proposal);
          });
          try {
            return await tools.execute(input);
          } catch (error) {
            const code = toolFailureCodeOf(error);
            record(input?.envelope, (state) => { state.toolFailureCode = code; });
            throw error;
          }
        },
      });
    },
  });
}

/** Builds the record with `deriveLocalRunOutcome` and returns it only when `validateLocalRunResult` accepts it. */
export function createLocalResultBuilder(): BenchmarkResultBuilderPort {
  return Object.freeze({
    build(input: Parameters<BenchmarkResultBuilderPort['build']>[0]): BenchmarkResultRecord {
      const candidate = {
        schemaVersion: 1,
        runId: input.runId,
        taskId: input.taskId,
        attempt: input.attempt,
        suiteId: input.suiteId,
        startedAtUtc: input.startedAtUtc,
        model: { tag: input.model.tag, digest: input.model.digest, runtimeVersion: input.model.runtimeVersion },
        seed: { capable: input.seed.capable, value: input.seed.value },
        outcome: deriveLocalRunOutcome(input.publicStatus, input.oracleStatus, input.failureStatus),
        toolCalls: input.toolCalls,
        changedFiles: input.changedFiles,
        patch: input.patch,
        logSha256: input.logSha256,
        policyDenials: input.policyDenials,
        metrics: input.metrics,
      };
      const validation = validateLocalRunResult(candidate);
      if (!validation.valid) throw new Error('result_invalid');
      return validation.result;
    },
  });
}

/**
 * Result sink over `createLocalRunResultWriter`. `list` reads only ordinary result files of one
 * run and fails closed on any unsafe or invalid file.
 */
export function createLocalResultSink(rootDirectory: string): BenchmarkResultSinkPort {
  const writer = createLocalRunResultWriter({ rootDirectory });
  return Object.freeze({
    async write(result: BenchmarkResultRecord) {
      await writer.write(result);
    },
    async list(runId: string) {
      if (typeof runId !== 'string' || !LOCAL_RUN_RESULT_ID_PATTERN.test(runId)) throw new Error('invalid_run_id');
      const runDirectory = join(rootDirectory, runId);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(runDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
        throw new Error('result_root_unreadable');
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('result_root_unsafe');
      const entries = await readdir(runDirectory, { withFileTypes: true });
      const names = entries.map((entry) => entry.name).filter((name) => RESULT_FILE_PATTERN.test(name)).sort();
      const results: BenchmarkResultRecord[] = [];
      for (const name of names) {
        const file = join(runDirectory, name);
        const fileInfo = await lstat(file);
        if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.size > MAX_RESULT_FILE_BYTES) {
          throw new Error('result_file_unsafe');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          throw new Error('result_file_invalid');
        }
        const validation = validateLocalRunResult(parsed);
        if (!validation.valid || validation.result.runId !== runId) throw new Error('result_file_invalid');
        results.push(validation.result);
      }
      return Object.freeze(results);
    },
  });
}

/** Loads the approved evaluator closure from the repository's own `bench/evaluator/index.mjs`. */
async function loadModelWorkspaceEvaluator(repositoryRoot: string, approvedReviewSetSha256: string): Promise<EvaluateWorkspace> {
  const moduleUrl = pathToFileURL(join(repositoryRoot, 'bench', 'evaluator', 'index.mjs')).href;
  const evaluatorModule = (await import(moduleUrl)) as { createModelWorkspaceEvaluator?: unknown };
  const factory = evaluatorModule.createModelWorkspaceEvaluator;
  if (typeof factory !== 'function') throw new Error('evaluator_unavailable');
  const evaluateWorkspace: unknown = await factory({ repositoryRoot, approvedReviewSetSha256 });
  if (typeof evaluateWorkspace !== 'function') throw new Error('evaluator_unavailable');
  return evaluateWorkspace as EvaluateWorkspace;
}

/**
 * Production benchmark composition: stores and workspace manager in `.agentctl/benchmark`, the tool
 * gateway with the diff applier and the G2.2 attestation gate, the file-edit Ollama adapter, the
 * model evaluator adapter, the catalog, the result writer, and the metrics collector. Agent and tool
 * ports are wrapped by the attempt observers. It refuses a malformed approval hash and a
 * non-absolute repository root before touching the filesystem and, unless `readOnly`, an approval
 * hash the evaluator factory rejects before building any state.
 */
export async function createBenchmarkApplication(
  options: BenchmarkApplicationOptions,
  testSeams: BenchmarkApplicationTestSeams = {},
): Promise<BenchmarkCliApplication> {
  const approvedReviewSetSha256 = options?.approvedReviewSetSha256;
  if (typeof approvedReviewSetSha256 !== 'string' || !SHA256_PATTERN.test(approvedReviewSetSha256)) {
    throw new BenchmarkCompositionError('approval_hash_invalid');
  }
  const rootValue = options.repositoryRoot;
  if (typeof rootValue !== 'string' || rootValue.length === 0 || rootValue.includes('\0') || !isAbsolute(rootValue)) {
    throw new BenchmarkCompositionError('repository_root_invalid');
  }
  if (options.agentOverride !== undefined && typeof options.agentOverride?.invoke !== 'function') {
    throw new BenchmarkCompositionError('agent_override_invalid');
  }
  if (options.agentFactory !== undefined
    && (typeof options.agentFactory !== 'function' || options.agentOverride !== undefined)) {
    throw new BenchmarkCompositionError('agent_override_invalid');
  }
  // Only the literal `true` selects read-only; anything else gets the full run composition and its checks.
  const readOnly = options.readOnly === true;
  const repositoryRoot = resolve(rootValue);

  // 0. Approval check before any state is built: a wrong but well-formed review-set hash stops here,
  // before any agent call. The error text is never kept. Read-only compositions never evaluate.
  const loadEvaluator = testSeams.createEvaluator
    ?? (() => loadModelWorkspaceEvaluator(repositoryRoot, approvedReviewSetSha256));
  if (!readOnly) {
    let resolved: unknown;
    try {
      resolved = await loadEvaluator();
    } catch {
      throw new BenchmarkCompositionError('approval_hash_invalid');
    }
    if (typeof resolved !== 'function') throw new BenchmarkCompositionError('approval_hash_invalid');
  }

  const stateRoot = join(repositoryRoot, ...BENCHMARK_STATE_RELATIVE_PATH);
  const resultRoot = join(repositoryRoot, ...BENCHMARK_RESULTS_RELATIVE_PATH);

  // 1. Stores, lease, policy, clock, and workspace manager, as in createLocalCliApplication.
  const snapshots = new LocalSnapshotStore(join(stateRoot, 'snapshots'));
  const events = new JsonlTaskEventStore(join(stateRoot, 'events'));
  const tasks = new LocalTaskEnvelopeStore(join(stateRoot, 'tasks'));
  const executionLease = new LocalTaskExecutionLease(join(stateRoot, 'task-execution.lock'));
  const workspaceManager = new SnapshotWorkspaceManager({ stateDirectory: stateRoot, snapshots });
  const policy = createPolicyEngine();
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: () => randomUUID() };

  // 2. Tool gateway with the diff applier and the generated-code gate; no declared tests.
  const gateway = new ClosedToolGateway({
    paths: workspaceManager,
    patches: workspaceManager,
    policy,
    clock,
    generatedCodeGate: testSeams.generatedCodeGate ?? new AttestationGeneratedCodeGate(repositoryRoot),
    testRegistry: { isRegistered: () => false },
  });

  // 3. File-edit Ollama adapter with the read-only context reader, unless the agent is overridden.
  const modelTag = options.modelTag ?? OLLAMA_AGENT_DEFAULTS.modelTag;
  let modelDigest: string | null = null;
  let runtimeVersion: string | null = null;
  const model: BenchmarkModelDescriptor = Object.freeze({
    tag: modelTag,
    get digest() { return modelDigest; },
    get runtimeVersion() { return runtimeVersion; },
  });
  const onInvocation = (metadata: OllamaInvocationMetadata): void => {
    if (metadata?.modelTag !== modelTag) return;
    if (typeof metadata.modelDigest === 'string' && SHA256_PATTERN.test(metadata.modelDigest)) modelDigest = metadata.modelDigest;
    if (typeof metadata.runtimeVersion === 'string' && RUNTIME_VERSION_PATTERN.test(metadata.runtimeVersion)) {
      runtimeVersion = metadata.runtimeVersion;
    }
  };
  const agentFactory = options.agentFactory;
  const baseAgent: AgentInvocationPort = options.agentOverride
    ?? (agentFactory !== undefined ? agentFactory({ contextReader: createWorkspaceContextReader(workspaceManager) }) : new OllamaAgentAdapter({
    modelTag,
    outputMode: 'file_edits',
    contextReader: createWorkspaceContextReader(workspaceManager),
    onInvocation,
    ...(options.adapterTuning ?? {}),
  }));
  const sink = options.proposalSink;
  const agent: AgentInvocationPort = sink === undefined ? baseAgent : {
    async invoke(input) {
      const result = await baseAgent.invoke(input);
      try { sink(result); } catch { /* the sink cannot change the result */ }
      return result;
    },
  };

  // 5. Catalog adapted to the application port (built before the evaluator, which resolves through it).
  const catalog: BenchmarkCatalogPort = testSeams.catalog
    ?? adaptBenchmarkCatalog(new LocalBenchmarkCatalog({ repositoryRoot, snapshots }));

  // 4. Model evaluator adapter over the approved evaluator closure. Every attempt calls it afresh
  // (the per-attempt re-check); a read-only composition never loads it.
  const createEvaluator = readOnly
    ? async (): Promise<EvaluateWorkspace> => { throw new BenchmarkCompositionError('read_only'); }
    : loadEvaluator;
  const evaluator = new G0ModelWorkspaceEvaluator({
    exportWorkspace: (workspace, destinationDirectory) => workspaceManager.exportWorkspace(workspace, destinationDirectory),
    createEvaluator,
    resolveBenchmarkTaskId: (attemptTaskId) => {
      const benchmarkTaskId = catalog.benchmarkTaskIdFor(attemptTaskId);
      if (benchmarkTaskId === null) throw new Error('unknown_attempt');
      return benchmarkTaskId;
    },
  });

  // 6. Observers around the agent and tool ports; result builder over the local result helpers.
  const observers = createBenchmarkAttemptObservers();

  const taskServices = createTaskApplicationServices({
    events,
    tasks,
    hasher: new NodeEnvelopeHasher(),
    policy,
    workspaces: workspaceManager,
    workspaceIntegrity: workspaceManager,
    tools: observers.wrapTools(gateway),
    executionControl: { cancelTask: async () => ({ quiescent: false }) },
    executionLease,
    agent: observers.wrapAgent(agent),
    evaluator,
    clock,
    ids,
  });

  // 7. Restart recovery appends INTERRUPTED events, so a read-only composition skips it. Its startup
  // stays `ready`: list and report read only the catalog and stored results and need no lease.
  let startup: CliApplication['startup'] = Object.freeze({ state: 'ready' });
  if (!readOnly) {
    try {
      await taskServices.recoverAfterRestart();
    } catch (error) {
      if (!(error instanceof ApplicationServiceError) || error.code !== 'CONCURRENCY_CONFLICT') throw error;
      startup = Object.freeze({ state: 'lease_busy', lockConflict: error.lockConflict ?? Object.freeze({}) });
    }
  }

  const services = createBenchmarkApplicationServices({
    tasks: taskServices,
    catalog,
    results: createLocalResultSink(resultRoot),
    resultBuilder: createLocalResultBuilder(),
    metrics: testSeams.metrics ?? { create: () => createRunMetricsCollector() },
    observer: observers,
    clock,
    ids,
    model,
    seed: Object.freeze({ capable: true, value: null }),
  });
  const benchmark: BenchmarkApplicationServices = readOnly
    ? Object.freeze({
      list: services.list,
      report: services.report,
      run: async () => { throw new BenchmarkCompositionError('read_only'); },
    })
    : services;

  // 8. Existing task, snapshot, and runtime services plus the benchmark services.
  return Object.freeze({
    tasks: taskServices,
    snapshots: createSnapshotApplicationServices({ snapshots }),
    runtime: createRuntimeApplicationServices(new OllamaReadOnlySmokeAdapter()),
    startup,
    benchmark,
    comparison: createComparisonServices({
      tasks: createComparisonTaskSource(catalog),
      files: createRepositoryFilePort(repositoryRoot),
      recordDirectory: 'bench/results/comparison',
    }),
  });
}
