import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EvaluatorInvocationPort, EvaluatorResult, WorkspaceReference } from '../application/ports/index.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';

export const MODEL_EVAL_TEMP_PREFIX = 'agent-control-model-eval-';

export type G0ModelEvaluatorReasonCode =
  | 'resolved_hidden'
  | 'oracle_fail'
  | 'public_fail'
  | 'timeout'
  | 'crash'
  | 'policy_violation'
  | 'runner_failure';

export type EvaluateWorkspace = (request: {
  readonly taskId: string;
  readonly workspaceRoot: string;
}) => Promise<unknown>;

export interface G0ModelWorkspaceEvaluatorOptions {
  /** Copies the verified workspace tree into an existing, empty, absolute directory. */
  readonly exportWorkspace: (workspace: WorkspaceReference, destinationDirectory: string) => Promise<void>;
  /** Resolves to the approved evaluator closure's `evaluateWorkspace`. */
  readonly createEvaluator: () => Promise<EvaluateWorkspace>;
  /** Maps an attempt task ID back to its benchmark task ID. */
  readonly resolveBenchmarkTaskId: (taskId: string) => string | Promise<string>;
  /** Parent directory for the temp copy; defaults to the system temp directory. */
  readonly tempRoot?: string;
}

function result(passed: boolean, reasonCode: G0ModelEvaluatorReasonCode): EvaluatorResult {
  return Object.freeze({ passed, reasonCode });
}

const RUNNER_FAILURE = result(false, 'runner_failure');

/** Maps an evaluator detail result `{ public_status, oracle_status }` to an evaluator port result. */
export function mapEvaluationDetail(detail: unknown): EvaluatorResult {
  if (typeof detail !== 'object' || detail === null) return RUNNER_FAILURE;
  const { public_status: publicStatus, oracle_status: oracleStatus } = detail as Record<string, unknown>;
  switch (publicStatus) {
    case 'PASS':
      return oracleStatus === 'PASS' ? result(true, 'resolved_hidden') : result(false, 'oracle_fail');
    case 'FAIL':
      return result(false, 'public_fail');
    case 'TIMEOUT':
      return result(false, 'timeout');
    case 'CRASH':
      return result(false, 'crash');
    case 'POLICY_VIOLATION':
      return result(false, 'policy_violation');
    default:
      return RUNNER_FAILURE;
  }
}

/** Exports the workspace to a fresh temp copy, evaluates the copy, and always removes it. */
export class G0ModelWorkspaceEvaluator implements EvaluatorInvocationPort {
  readonly #exportWorkspace: G0ModelWorkspaceEvaluatorOptions['exportWorkspace'];
  readonly #createEvaluator: G0ModelWorkspaceEvaluatorOptions['createEvaluator'];
  readonly #resolveBenchmarkTaskId: G0ModelWorkspaceEvaluatorOptions['resolveBenchmarkTaskId'];
  readonly #tempRoot: string;

  constructor(options: G0ModelWorkspaceEvaluatorOptions) {
    this.#exportWorkspace = options.exportWorkspace;
    this.#createEvaluator = options.createEvaluator;
    this.#resolveBenchmarkTaskId = options.resolveBenchmarkTaskId;
    this.#tempRoot = options.tempRoot ?? tmpdir();
  }

  async evaluate(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
  }): Promise<EvaluatorResult> {
    let tempDirectory: string | undefined;
    try {
      const benchmarkTaskId = await this.#resolveBenchmarkTaskId(input.envelope.taskId);
      if (typeof benchmarkTaskId !== 'string' || benchmarkTaskId.length === 0) return RUNNER_FAILURE;
      const evaluateWorkspace = await this.#createEvaluator();
      if (typeof evaluateWorkspace !== 'function') return RUNNER_FAILURE;
      tempDirectory = await mkdtemp(path.join(path.resolve(this.#tempRoot), MODEL_EVAL_TEMP_PREFIX));
      const workspaceRoot = path.join(tempDirectory, 'workspace');
      await mkdir(workspaceRoot);
      await this.#exportWorkspace(input.workspace, workspaceRoot);
      return mapEvaluationDetail(await evaluateWorkspace({ taskId: benchmarkTaskId, workspaceRoot }));
    } catch {
      return RUNNER_FAILURE;
    } finally {
      if (tempDirectory !== undefined) {
        await rm(tempDirectory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
    }
  }
}
