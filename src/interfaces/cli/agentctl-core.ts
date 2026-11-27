import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TaskEvent } from '../../domain/event.ts';
import { TASK_OPERATIONS, type ApprovalGrantV1, type TaskOperation } from '../../domain/policy.ts';
import { isValidTaskId, validateTaskEnvelopeV1 } from '../../domain/task.ts';
import type { SnapshotCaptureReceipt } from '../../domain/snapshot.ts';
import { ApplicationServiceError } from '../../application/errors.ts';
import type {
  LocalLockConflictDetails,
} from '../../application/ports/index.ts';
import type { SnapshotApplicationServices } from '../../application/snapshot-services.ts';
import type { RuntimeApplicationServices } from '../../application/runtime-services.ts';
import type { TaskApplicationServices, TaskStatus } from '../../application/task-services.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TASK_FILE_BYTES = 1_048_576;

export type CliCommand =
  | Readonly<{ kind: 'version' }>
  | Readonly<{ kind: 'snapshot.create'; sourceDirectory: string; format: CliFormat }>
  | Readonly<{ kind: 'task.validate'; file: string; format: CliFormat }>
  | Readonly<{ kind: 'task.create'; file: string; format: CliFormat }>
  | Readonly<{ kind: 'task.status'; taskId: string; format: CliFormat }>
  | Readonly<{ kind: 'task.events'; taskId: string; after?: string; format: CliFormat }>
  | Readonly<{ kind: 'task.approve'; taskId: string; envelopeSha256: string; operations: readonly TaskOperation[]; expiresAt: string; format: CliFormat }>
  | Readonly<{ kind: 'task.run'; taskId: string; envelopeSha256: string; format: CliFormat }>
  | Readonly<{ kind: 'task.cancel'; taskId: string; reasonCode?: string; format: CliFormat }>
  | Readonly<{ kind: 'task.recover'; taskId: string; mode: 'inspect' | 'resume'; format: CliFormat }>
  | Readonly<{ kind: 'benchmark.list'; format: CliFormat }>
  | Readonly<{ kind: 'benchmark.run'; suiteId: string; taskId?: string; repetitions?: number; approvedReviewSetSha256: string; model?: string; answerFormat?: 'json' | 'blocks'; format: CliFormat }>
  | Readonly<{ kind: 'benchmark.report'; runId: string; format: CliFormat }>
  | Readonly<{ kind: 'runtime.diagnose'; format: CliFormat }>
  | Readonly<{ kind: 'runtime.smoke'; model: string; format: CliFormat }>
  | Readonly<{ kind: 'watch'; once: boolean; intervalSeconds: number; color: boolean; format: CliFormat }>
  | Readonly<{ kind: 'comparison.export'; taskId: string; output: string; format: CliFormat }>
  | Readonly<{ kind: 'comparison.import'; packagePath: string; patchPath: string; logPath: string; format: CliFormat }>;

export type CliFormat = 'human' | 'json';

export type CliParseResult =
  | Readonly<{ ok: true; command: CliCommand }>
  | Readonly<{ ok: false; message: string; format: CliFormat }>;

export type CliStartup =
  | Readonly<{ state: 'ready' }>
  | Readonly<{ state: 'lease_busy'; lockConflict: LocalLockConflictDetails }>;

/** Counts of one benchmark report row, as returned by the benchmark service. */
export interface CliBenchmarkReportCounts {
  readonly attempts: number;
  readonly resolved_hidden: number;
  readonly public_pass: number;
  readonly policy_clean: number;
  readonly timeout: number;
  readonly runner_failure: number;
}

/** Minimal structural view of the benchmark application services that the CLI needs. */
export interface CliBenchmarkServices {
  list(): Promise<readonly Readonly<{ suiteId: string; taskIds: readonly string[] }>[]>;
  run(request: Readonly<{ suiteId: string; taskId?: string; repetitions: number; approvedReviewSetSha256: string }>): Promise<Readonly<{
    runId: string;
    suiteId: string;
    attempts: readonly Readonly<{ benchmarkTaskId: string; attempt: number; status: string }>[];
  }>>;
  report(runId: string): Promise<Readonly<{
    runId: string;
    totals: CliBenchmarkReportCounts;
    tasks: Readonly<Record<string, CliBenchmarkReportCounts>>;
  }>>;
}

/** Minimal structural view of the comparison application services (G3.3). */
export interface CliComparisonServices {
  exportPackage(request: Readonly<{ taskId: string; outputPath: string }>): Promise<unknown>;
  importArtifacts(request: Readonly<{ packagePath: string; patchPath: string; logPath: string }>): Promise<unknown>;
}

export interface CliApplication {
  readonly tasks: TaskApplicationServices;
  readonly snapshots: SnapshotApplicationServices;
  readonly runtime: RuntimeApplicationServices;
  readonly startup: CliStartup;
  /** Present only in the benchmark composition. */
  readonly benchmark?: CliBenchmarkServices;
  /** Present only in the benchmark composition. */
  readonly comparison?: CliComparisonServices;
  /** Present only in the isolated G1.9 harness composition. */
  readonly testOnlyNoToolFakeRun?: true;
}

export interface CliExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface OptionSpec {
  readonly value?: boolean;
  readonly repeat?: boolean;
  readonly required?: boolean;
}

interface Grammar {
  readonly prefix: readonly string[];
  readonly kind: CliCommand['kind'];
  readonly options: Readonly<Record<string, OptionSpec>>;
}

const GRAMMARS: readonly Grammar[] = [
  { prefix: ['snapshot', 'create'], kind: 'snapshot.create', options: { '--source': { value: true, required: true }, '--confirm-disposable': {} } },
  { prefix: ['task', 'validate'], kind: 'task.validate', options: { '--file': { value: true, required: true } } },
  { prefix: ['task', 'create'], kind: 'task.create', options: { '--file': { value: true, required: true } } },
  { prefix: ['task', 'status'], kind: 'task.status', options: { '--task-id': { value: true, required: true } } },
  { prefix: ['task', 'events'], kind: 'task.events', options: { '--task-id': { value: true, required: true }, '--after': { value: true } } },
  { prefix: ['task', 'approve'], kind: 'task.approve', options: {
    '--task-id': { value: true, required: true }, '--envelope-sha256': { value: true, required: true },
    '--operation': { value: true, repeat: true, required: true }, '--expires-at': { value: true, required: true }, '--confirm': {},
  } },
  { prefix: ['task', 'run'], kind: 'task.run', options: { '--task-id': { value: true, required: true }, '--envelope-sha256': { value: true, required: true } } },
  { prefix: ['task', 'cancel'], kind: 'task.cancel', options: { '--task-id': { value: true, required: true }, '--reason-code': { value: true } } },
  { prefix: ['task', 'recover'], kind: 'task.recover', options: { '--task-id': { value: true, required: true }, '--mode': { value: true, required: true } } },
  { prefix: ['benchmark', 'list'], kind: 'benchmark.list', options: {} },
  { prefix: ['benchmark', 'run'], kind: 'benchmark.run', options: {
    '--suite': { value: true, required: true }, '--task-id': { value: true }, '--repetitions': { value: true },
    '--approve-review-set-sha256': { value: true, required: true }, '--model': { value: true }, '--answer-format': { value: true },
  } },
  { prefix: ['benchmark', 'report'], kind: 'benchmark.report', options: { '--run-id': { value: true, required: true } } },
  { prefix: ['runtime', 'diagnose'], kind: 'runtime.diagnose', options: {} },
  { prefix: ['watch'], kind: 'watch', options: { '--once': {}, '--interval': { value: true }, '--no-color': {} } },
  { prefix: ['runtime', 'smoke'], kind: 'runtime.smoke', options: { '--model': { value: true, required: true } } },
  { prefix: ['comparison', 'export'], kind: 'comparison.export', options: {
    '--task-id': { value: true, required: true }, '--output': { value: true, required: true },
  } },
  { prefix: ['comparison', 'import'], kind: 'comparison.import', options: {
    '--package': { value: true, required: true }, '--patch': { value: true, required: true }, '--log': { value: true, required: true },
  } },
];

function invalid(format: CliFormat): CliParseResult {
  return Object.freeze({ ok: false, message: 'Comando, opção ou valor inválido para o contrato agentctl v1.', format });
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !value.includes('\0');
}

function readJsonMode(argv: readonly string[]): { readonly format: CliFormat; readonly args: readonly string[] } | null {
  const count = argv.filter((argument) => argument === '--json').length;
  if (count > 1 || (count === 1 && argv.at(-1) !== '--json')) return null;
  return {
    format: count === 1 ? 'json' : 'human',
    args: count === 1 ? argv.slice(0, -1) : argv,
  };
}

function isValidUtcTimestamp(value: string): boolean {
  if (!UTC_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59 || second! > 59) return false;
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function parseOptions(tokens: readonly string[], grammar: Grammar): Record<string, string | string[] | true> | null {
  const values: Record<string, string | string[] | true> = Object.create(null) as Record<string, string | string[] | true>;
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index]!;
    const spec = grammar.options[option];
    if (!spec || Object.hasOwn(values, option)) {
      if (!spec || !spec.repeat) return null;
    }
    if (!spec) return null;
    if (spec.value) {
      const value = tokens[index + 1];
      if (!nonEmpty(value) || value.startsWith('--')) return null;
      if (spec.repeat) {
        const existing = values[option];
        const list = Array.isArray(existing) ? existing : [];
        list.push(value);
        values[option] = list;
      } else {
        if (Object.hasOwn(values, option)) return null;
        values[option] = value;
      }
      index += 1;
    } else {
      if (Object.hasOwn(values, option)) return null;
      values[option] = true;
    }
  }
  for (const [option, spec] of Object.entries(grammar.options)) {
    if (spec.required && !Object.hasOwn(values, option)) return null;
  }
  return values;
}

function one(options: Record<string, string | string[] | true>, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  const mode = readJsonMode(argv);
  if (!mode) return invalid(argv.at(-1) === '--json' ? 'json' : 'human');
  const args = mode.args;
  if (args.length === 1 && args[0] === '--version' && mode.format === 'human') {
    return Object.freeze({ ok: true as const, command: { kind: 'version' as const } });
  }
  if (args.some((argument) => argument === '--version') || (args.length < 2 && args[0] !== 'watch')) return invalid(mode.format);

  const grammar = GRAMMARS.find((entry) => entry.prefix.every((token, index) => args[index] === token));
  if (!grammar) return invalid(mode.format);
  const options = parseOptions(args.slice(grammar.prefix.length), grammar);
  if (!options) return invalid(mode.format);
  const format = mode.format;

  switch (grammar.kind) {
    case 'snapshot.create': {
      const sourceDirectory = one(options, '--source');
      if (!sourceDirectory || options['--confirm-disposable'] !== true) return invalid(format);
      return Object.freeze({ ok: true, command: { kind: grammar.kind, sourceDirectory, format } });
    }
    case 'task.validate':
    case 'task.create': {
      const file = one(options, '--file');
      if (!file) return invalid(format);
      return Object.freeze({ ok: true, command: { kind: grammar.kind, file, format } });
    }
    case 'task.status':
    case 'task.run': {
      const taskId = one(options, '--task-id');
      if (!taskId || !isValidTaskId(taskId)) return invalid(format);
      if (grammar.kind === 'task.status') return Object.freeze({ ok: true, command: { kind: grammar.kind, taskId, format } });
      const envelopeSha256 = one(options, '--envelope-sha256');
      if (!envelopeSha256 || !SHA256_PATTERN.test(envelopeSha256)) return invalid(format);
      return Object.freeze({ ok: true, command: { kind: grammar.kind, taskId, envelopeSha256, format } });
    }
    case 'task.events': {
      const taskId = one(options, '--task-id');
      const after = one(options, '--after');
      if (!taskId || !isValidTaskId(taskId) || (after !== undefined && !EVENT_ID_PATTERN.test(after))) return invalid(format);
      return Object.freeze({ ok: true, command: { kind: grammar.kind, taskId, ...(after === undefined ? {} : { after }), format } });
    }
    case 'task.approve': {
      const taskId = one(options, '--task-id');
      const envelopeSha256 = one(options, '--envelope-sha256');
      const operations = options['--operation'];
      const expiresAt = one(options, '--expires-at');
      if (!taskId || !isValidTaskId(taskId) || !envelopeSha256 || !SHA256_PATTERN.test(envelopeSha256)
        || !Array.isArray(operations) || operations.length === 0
        || operations.some((operation) => !TASK_OPERATIONS.includes(operation as TaskOperation))
        || new Set(operations).size !== operations.length
        || !expiresAt || !isValidUtcTimestamp(expiresAt)
        || options['--confirm'] !== true) return invalid(format);
      return Object.freeze({ ok: true, command: {
        kind: grammar.kind, taskId, envelopeSha256,
        operations: Object.freeze(operations as TaskOperation[]), expiresAt, format,
      } });
    }
    case 'task.cancel': {
      const taskId = one(options, '--task-id');
      const reasonCode = one(options, '--reason-code');
      if (!taskId || !isValidTaskId(taskId) || (reasonCode !== undefined && !REASON_CODE_PATTERN.test(reasonCode))) return invalid(format);
      return Object.freeze({ ok: true, command: { kind: grammar.kind, taskId, ...(reasonCode === undefined ? {} : { reasonCode }), format } });
    }
    case 'task.recover': {
      const taskId = one(options, '--task-id');
      const mode = one(options, '--mode');
      if (!taskId || !isValidTaskId(taskId) || (mode !== 'inspect' && mode !== 'resume-read-only')) return invalid(format);
      const recoverMode: 'inspect' | 'resume' = mode === 'inspect' ? 'inspect' : 'resume';
      return Object.freeze({ ok: true as const, command: { kind: 'task.recover' as const, taskId, mode: recoverMode, format } });
    }
    case 'benchmark.list':
    case 'runtime.diagnose':
      return Object.freeze({ ok: true, command: { kind: grammar.kind, format } });
    case 'benchmark.run': {
      const suiteId = one(options, '--suite');
      const taskId = one(options, '--task-id');
      const rawRepetitions = one(options, '--repetitions');
      const repetitions = rawRepetitions === undefined ? undefined : Number(rawRepetitions);
      const approvedReviewSetSha256 = one(options, '--approve-review-set-sha256');
      const model = one(options, '--model');
      const answerFormat = one(options, '--answer-format');
      if (!suiteId || !SAFE_ID_PATTERN.test(suiteId) || (taskId !== undefined && !isValidTaskId(taskId))
        || (rawRepetitions !== undefined && (!Number.isInteger(repetitions) || repetitions! < 1 || repetitions! > 100))
        || !approvedReviewSetSha256 || !SHA256_PATTERN.test(approvedReviewSetSha256)
        || (answerFormat !== undefined && answerFormat !== 'json' && answerFormat !== 'blocks')
        || (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model))) return invalid(format);
      return Object.freeze({ ok: true, command: {
        kind: grammar.kind, suiteId, ...(taskId === undefined ? {} : { taskId }), ...(repetitions === undefined ? {} : { repetitions }),
        approvedReviewSetSha256, ...(model === undefined ? {} : { model }),
        ...(answerFormat === undefined ? {} : { answerFormat: answerFormat as 'json' | 'blocks' }), format,
      } });
    }
    case 'benchmark.report': {
      const runId = one(options, '--run-id');
      if (!runId || !SAFE_ID_PATTERN.test(runId)) return invalid(format);
      return Object.freeze({ ok: true, command: { kind: grammar.kind, runId, format } });
    }
    case 'runtime.smoke': {
      const model = one(options, '--model');
      if (!model || model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) return invalid(format);
      return Object.freeze({ ok: true, command: { kind: grammar.kind, model, format } });
    }
    case 'watch': {
      const rawInterval = one(options, '--interval');
      const intervalSeconds = rawInterval === undefined ? 2 : Number(rawInterval);
      if (!/^\d+$/.test(rawInterval ?? '2') || !Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 60) return invalid(format);
      return Object.freeze({ ok: true, command: {
        kind: grammar.kind, once: options['--once'] === true, intervalSeconds, color: options['--no-color'] !== true, format,
      } });
    }
    case 'comparison.export': {
      const taskId = one(options, '--task-id');
      const output = one(options, '--output');
      if (!taskId || !isValidTaskId(taskId) || !output) return invalid(format);
      return Object.freeze({ ok: true, command: { kind: grammar.kind, taskId, output, format } });
    }
    case 'comparison.import': {
      const packagePath = one(options, '--package');
      const patchPath = one(options, '--patch');
      const logPath = one(options, '--log');
      if (!packagePath || !patchPath || !logPath) return invalid(format);
      return Object.freeze({ ok: true, command: { kind: grammar.kind, packagePath, patchPath, logPath, format } });
    }
  }
  return invalid(format);
}

interface CliEnvelope {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly command: string;
  readonly requestId: string;
  readonly data?: unknown;
  readonly error?: Readonly<{ code: string; message: string }>;
}

interface CliFailure {
  readonly code: string;
  readonly message: string;
  readonly exitCode: number;
}

function lockMessage(lockConflict: LocalLockConflictDetails): string {
  const lockPath = lockConflict.lockPath ?? '(caminho desconhecido)';
  const owner = lockConflict.owner
    ? `PID ${lockConflict.owner.pid}, tipo ${lockConflict.owner.kind}`
    : 'dono desconhecido';
  const ownerStep = lockConflict.owner
    ? `Verifique se o PID ${lockConflict.owner.pid} terminou e feche as outras instâncias`
    : 'Confirme manualmente que nenhuma instância do agentctl está ativa';
  return `Execução bloqueada pelo lock ${lockPath} (${owner}). ${ownerStep}, depois remova manualmente somente esse arquivo; o agentctl não limpa locks.`;
}

/** Fixed user-facing results for the benchmark service's error codes; never carries error text. */
const BENCHMARK_FAILURES: Readonly<Record<string, CliFailure>> = Object.freeze({
  approval_hash_invalid: { code: 'invalid_input', message: 'O hash de aprovação do conjunto de revisão é inválido.', exitCode: 2 },
  invalid_run_id: { code: 'invalid_input', message: 'O ID da execução é inválido.', exitCode: 2 },
  invalid_repetitions: { code: 'invalid_input', message: 'O número de repetições é inválido.', exitCode: 2 },
  unknown_suite: { code: 'benchmark_suite_not_found', message: 'A suíte de benchmark não foi encontrada.', exitCode: 2 },
  unknown_task: { code: 'benchmark_task_not_found', message: 'A tarefa de benchmark não foi encontrada na suíte.', exitCode: 2 },
  unsupported_envelope: { code: 'benchmark_task_unsupported', message: 'A tarefa de benchmark pede operações não suportadas.', exitCode: 3 },
  catalog_unavailable: { code: 'catalog_unavailable', message: 'O catálogo de benchmark está indisponível.', exitCode: 5 },
  result_invalid: { code: 'result_invalid', message: 'O resultado da tentativa não passou na validação; a execução parou.', exitCode: 5 },
  result_sink_failed: { code: 'result_unavailable', message: 'Os resultados não puderam ser gravados ou lidos.', exitCode: 5 },
});

function benchmarkFailure(error: unknown): CliFailure | undefined {
  if (!(error instanceof Error) || error.name !== 'BenchmarkServiceError') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(BENCHMARK_FAILURES, code) ? BENCHMARK_FAILURES[code] : undefined;
}

/** Fixed user-facing results for the comparison service's error codes; never carries error text. */
const COMPARISON_FAILURES: Readonly<Record<string, CliFailure>> = Object.freeze({
  unknown_task: { code: 'benchmark_task_not_found', message: 'A tarefa de benchmark não foi encontrada.', exitCode: 2 },
  package_invalid: { code: 'comparison_package_invalid', message: 'O pacote de comparação é inválido ou foi alterado.', exitCode: 2 },
  base_snapshot_mismatch: { code: 'comparison_base_mismatch', message: 'O snapshot base do pacote não confere com a tarefa atual.', exitCode: 2 },
  patch_missing: { code: 'comparison_patch_missing', message: 'O patch está ausente ou vazio.', exitCode: 2 },
  log_missing: { code: 'comparison_log_missing', message: 'O log está ausente ou vazio.', exitCode: 2 },
  patch_outside_allowlist: { code: 'comparison_patch_outside_allowlist', message: 'O patch toca caminhos fora da lista permitida.', exitCode: 3 },
  secret_detected: { code: 'comparison_secret_detected', message: 'Foi detectado um possível segredo; nada foi gravado.', exitCode: 3 },
  file_unavailable: { code: 'comparison_file_unavailable', message: 'Um arquivo não pôde ser lido ou criado (caminhos devem ser relativos ao repositório e novos).', exitCode: 5 },
});

function comparisonFailure(error: unknown): CliFailure | undefined {
  if (!(error instanceof Error) || error.name !== 'ComparisonServiceError') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(COMPARISON_FAILURES, code) ? COMPARISON_FAILURES[code] : undefined;
}

function failureFor(error: unknown, startup?: CliStartup): CliFailure {
  const benchmark = benchmarkFailure(error);
  if (benchmark) return benchmark;
  const comparison = comparisonFailure(error);
  if (comparison) return comparison;
  if (!(error instanceof ApplicationServiceError)) {
    return { code: 'internal_error', message: 'Falha interna; detalhes foram omitidos.', exitCode: 70 };
  }
  if (error.code === 'CONCURRENCY_CONFLICT' && startup?.state === 'lease_busy') {
    return { code: 'execution_lock_busy', message: lockMessage(startup.lockConflict), exitCode: 8 };
  }
  switch (error.code) {
    case 'INVALID_TASK': return { code: 'invalid_input', message: 'A entrada da tarefa é inválida.', exitCode: 2 };
    case 'TASK_NOT_FOUND': return { code: 'task_not_found', message: 'A tarefa não foi encontrada.', exitCode: 2 };
    case 'TASK_RECORD_UNAVAILABLE': return { code: 'task_unavailable', message: 'O registro da tarefa está indisponível.', exitCode: 70 };
    case 'TASK_ID_CONFLICT': return { code: 'task_id_conflict', message: 'Esse ID já está vinculado a outra tarefa.', exitCode: 2 };
    case 'ENVELOPE_HASH_MISMATCH': return { code: 'envelope_mismatch', message: 'O hash do envelope não confere.', exitCode: 2 };
    case 'INVALID_STATE': return { code: 'invalid_state', message: 'A tarefa não permite essa operação no estado atual.', exitCode: 5 };
    case 'APPROVAL_REQUIRED':
    case 'APPROVAL_INVALID': return { code: 'approval_required', message: 'Aprovação ausente, expirada ou incompatível.', exitCode: 4 };
    case 'SNAPSHOT_CONFIRMATION_REQUIRED': return { code: 'confirmation_required', message: 'Confirme que a origem contém apenas dados descartáveis.', exitCode: 2 };
    case 'SNAPSHOT_CAPTURE_FAILED': return { code: 'snapshot_failed', message: 'A captura falhou; verifique a origem e os limites permitidos.', exitCode: 5 };
    case 'POLICY_DENIED': return { code: 'policy_denied', message: 'A operação foi negada pela política.', exitCode: 3 };
    case 'CONCURRENCY_CONFLICT': return {
      code: 'execution_lock_busy',
      message: lockMessage(error.lockConflict ?? {}),
      exitCode: 8,
    };
    case 'RUNNER_FAILURE': return { code: 'task_failed', message: 'A execução falhou; detalhes do adaptador foram omitidos.', exitCode: 5 };
  }
}

function commandName(command: CliCommand): string {
  return command.kind;
}

function successResult(command: CliCommand, data: unknown): Readonly<{ data: unknown; exitCode: number }> {
  if ((command.kind === 'runtime.diagnose' || command.kind === 'runtime.smoke') && data !== null && typeof data === 'object') {
    const status = (data as { status?: unknown }).status;
    if (command.kind === 'runtime.diagnose') return { data, exitCode: status === 'ready' ? 0 : 8 };
    return { data, exitCode: status === 'passed' ? 0 : status === 'blocked' ? 8 : 5 };
  }
  if (data !== null && typeof data === 'object' && 'state' in data) {
    const state = (data as { state?: string }).state;
    if (command.kind === 'task.create' || command.kind === 'task.recover' || command.kind === 'task.approve') {
      if (state === 'FAILED' || state === 'REJECTED') return { data, exitCode: state === 'REJECTED' ? 3 : 5 };
      if (state === 'INTERRUPTED' && command.kind === 'task.recover' && command.mode === 'resume') return { data, exitCode: 6 };
    }
  }
  if (command.kind === 'task.cancel' && data !== null && typeof data === 'object') {
    const outcome = (data as { outcome?: string }).outcome;
    if (outcome === 'cancelled' || outcome === 'stop_unconfirmed') return { data, exitCode: 6 };
  }
  return { data, exitCode: 0 };
}

function statusProjection(status: TaskStatus): Readonly<Record<string, unknown>> {
  return Object.freeze({ taskId: status.taskId, envelopeSha256: status.envelopeSha256, state: status.state, version: status.version, lastEventId: status.lastEventId });
}

function eventProjection(event: TaskEvent): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...event });
}

async function readTaskFile(file: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new CliRaisedError({ code: 'input_file_unavailable', message: 'O arquivo de tarefa não pôde ser lido.', exitCode: 2 });
  }
  if (bytes.byteLength > MAX_TASK_FILE_BYTES) {
    throw new CliRaisedError({ code: 'input_too_large', message: 'O arquivo de tarefa excede 1 MiB.', exitCode: 2 });
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new CliRaisedError({ code: 'invalid_json', message: 'O arquivo de tarefa não contém JSON válido.', exitCode: 2 });
  }
}

class CliRaisedError extends Error {
  readonly failure: CliFailure;

  constructor(failure: CliFailure) {
    super(failure.code);
    this.failure = failure;
  }
}

function gateFailure(code: string, message: string): CliRaisedError {
  return new CliRaisedError({ code, message, exitCode: 8 });
}

function mutationBlocked(command: CliCommand, startup: CliStartup): boolean {
  if (startup.state !== 'lease_busy') return false;
  return command.kind === 'snapshot.create'
    || command.kind === 'task.create'
    || command.kind === 'task.approve'
    || command.kind === 'task.run'
    || command.kind === 'runtime.smoke'
    || command.kind === 'benchmark.run'
    || (command.kind === 'task.recover' && command.mode === 'resume');
}

const UNAVAILABLE_MESSAGE = 'Este comando pertence a uma meta posterior e ainda não está disponível.';
/** Repository-relative result root of local benchmark runs (never an absolute host path). */
const BENCHMARK_RESULT_ROOT = 'bench/results/local';

function requireBenchmark(app: CliApplication): CliBenchmarkServices {
  if (!app.benchmark) throw gateFailure('capability_unavailable', UNAVAILABLE_MESSAGE);
  return app.benchmark;
}

function byKey([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resultDirectoryFor(runId: string): string {
  return `${BENCHMARK_RESULT_ROOT}/${runId}/`;
}

function reportCounts(counts: CliBenchmarkReportCounts): CliBenchmarkReportCounts {
  return Object.freeze({
    attempts: counts.attempts,
    resolved_hidden: counts.resolved_hidden,
    public_pass: counts.public_pass,
    policy_clean: counts.policy_clean,
    timeout: counts.timeout,
    runner_failure: counts.runner_failure,
  });
}

function formatCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).filter(([key]) => key !== 'attempts');
  return entries.length === 0 ? 'nenhuma' : entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

/** Short human text for benchmark commands; other commands keep the generic rendering. */
function humanText(command: CliCommand, data: unknown): string {
  if (command.kind === 'benchmark.run') {
    const run = data as { runId: string; attempts: number; statusCounts: Record<string, number>; resultDirectory: string };
    return `benchmark.run: execução ${run.runId}; ${run.attempts} tentativa(s); ${formatCounts(run.statusCounts)}; resultados em ${run.resultDirectory}`;
  }
  if (command.kind === 'benchmark.report') {
    const report = data as { runId: string; totals: CliBenchmarkReportCounts; resultDirectory: string };
    return `benchmark.report: execução ${report.runId}; ${report.totals.attempts} tentativa(s); ${formatCounts({ ...report.totals })}; resultados em ${report.resultDirectory}`;
  }
  if (command.kind === 'benchmark.list') {
    const suites = data as readonly { suiteId: string; taskIds: readonly string[] }[];
    const listed = suites.map((suite) => `${suite.suiteId} (${suite.taskIds.length} tarefa(s))`).join(', ');
    return `benchmark.list: ${suites.length} suíte(s)${listed ? `: ${listed}` : ''}`;
  }
  return `${command.kind}: ${JSON.stringify(data)}`;
}

async function dispatch(command: CliCommand, app: CliApplication, taskFileCandidate?: unknown, allowTestOnlyRun = false): Promise<unknown> {
  if (mutationBlocked(command, app.startup)) {
    const lockConflict = app.startup.state === 'lease_busy' ? app.startup.lockConflict : {};
    throw gateFailure('execution_lock_busy', lockMessage(lockConflict));
  }
  switch (command.kind) {
    case 'version': return { version: '0.1.0', contractVersion: 1 };
    case 'snapshot.create': {
      const receipt: SnapshotCaptureReceipt = await app.snapshots.createSnapshot({ sourceDirectory: command.sourceDirectory, confirmedDisposable: true });
      return Object.freeze({
        snapshotSha256: receipt.snapshotSha256,
        fileCount: receipt.fileCount,
        totalBytes: receipt.totalBytes,
        excludedPaths: receipt.excludedPaths,
        reused: receipt.reused,
        streamLimitation: 'NTFS alternate data streams are not enumerated; snapshot v1 copies and hashes only unnamed/default streams.',
      });
    }
    case 'task.validate': {
      const candidate = taskFileCandidate;
      const result = app.tasks.validateTask(candidate);
      if (!result.valid) throw new CliRaisedError({ code: 'invalid_task', message: 'O conteúdo não atende ao contrato de tarefa.', exitCode: 2 });
      return Object.freeze({ valid: true, taskId: result.envelope.taskId });
    }
    case 'task.create': {
      const candidate = taskFileCandidate;
      const status = await app.tasks.createTask(candidate);
      const classified = status.state === 'DRAFT' ? await app.tasks.classifyTask(status.taskId) : status;
      return statusProjection(classified);
    }
    case 'task.status': return statusProjection(await app.tasks.getTaskStatus(command.taskId));
    case 'task.events': return Object.freeze((await app.tasks.getTaskEvents(command.taskId, command.after)).map(eventProjection));
    case 'task.approve': {
      const grant: ApprovalGrantV1 = Object.freeze({
        schemaVersion: 1,
        taskId: command.taskId,
        envelopeSha256: command.envelopeSha256,
        operations: command.operations,
        expiresAt: command.expiresAt,
        confirmed: true,
      });
      return statusProjection(await app.tasks.approveTask(grant));
    }
    case 'task.run': {
      if (!allowTestOnlyRun || app.testOnlyNoToolFakeRun !== true) {
        throw gateFailure('safety_gate_closed', 'Execução bloqueada até a disponibilidade do runtime e a aprovação do gate G2.2; nenhum estado foi alterado.');
      }
      return statusProjection(await app.tasks.runTask(command.taskId));
    }
    case 'task.cancel': {
      const result = await app.tasks.cancelTask(command.taskId, command.reasonCode);
      return Object.freeze({ status: statusProjection(result.status), outcome: result.outcome });
    }
    case 'task.recover': return statusProjection(await app.tasks.recoverTask(command.taskId, command.mode));
    case 'runtime.diagnose': return app.runtime.diagnose();
    case 'watch': throw gateFailure('capability_unavailable', UNAVAILABLE_MESSAGE);
    case 'runtime.smoke': return app.runtime.smoke(command.model);
    case 'benchmark.list': {
      const suites = await requireBenchmark(app).list();
      return Object.freeze(suites.map((suite) => Object.freeze({ suiteId: suite.suiteId, taskIds: Object.freeze([...suite.taskIds]) })));
    }
    case 'benchmark.run': {
      const benchmark = requireBenchmark(app);
      if (app.startup.state !== 'ready') {
        throw gateFailure('execution_lock_busy', lockMessage(app.startup.state === 'lease_busy' ? app.startup.lockConflict : {}));
      }
      const summary = await benchmark.run({
        suiteId: command.suiteId,
        // The CLI task-ID grammar is lowercase; catalog benchmark task IDs are uppercase (for example P01).
        ...(command.taskId === undefined ? {} : { taskId: command.taskId.toUpperCase() }),
        repetitions: command.repetitions ?? 1,
        approvedReviewSetSha256: command.approvedReviewSetSha256,
      });
      const counts = new Map<string, number>();
      for (const attempt of summary.attempts) counts.set(attempt.status, (counts.get(attempt.status) ?? 0) + 1);
      const statusCounts: Record<string, number> = {};
      for (const [status, count] of [...counts.entries()].sort(byKey)) statusCounts[status] = count;
      return Object.freeze({
        runId: summary.runId,
        suiteId: summary.suiteId,
        attempts: summary.attempts.length,
        statusCounts: Object.freeze(statusCounts),
        resultDirectory: resultDirectoryFor(summary.runId),
      });
    }
    case 'benchmark.report': {
      const report = await requireBenchmark(app).report(command.runId);
      const tasks: Record<string, CliBenchmarkReportCounts> = {};
      for (const [taskId, counts] of Object.entries(report.tasks).sort(byKey)) tasks[taskId] = reportCounts(counts);
      return Object.freeze({
        runId: report.runId,
        totals: reportCounts(report.totals),
        tasks: Object.freeze(tasks),
        resultDirectory: resultDirectoryFor(report.runId),
      });
    }
    case 'comparison.export': {
      if (!app.comparison) throw gateFailure('capability_unavailable', UNAVAILABLE_MESSAGE);
      return app.comparison.exportPackage({ taskId: command.taskId.toUpperCase(), outputPath: command.output });
    }
    case 'comparison.import': {
      if (!app.comparison) throw gateFailure('capability_unavailable', UNAVAILABLE_MESSAGE);
      return app.comparison.importArtifacts({ packagePath: command.packagePath, patchPath: command.patchPath, logPath: command.logPath });
    }
  }
}

function renderEnvelope(envelope: CliEnvelope, format: CliFormat, human: string): CliExecutionResult {
  const exitCode = (envelope as CliEnvelope & { exitCode?: number }).exitCode ?? (envelope.ok ? 0 : 70);
  if (format === 'json') {
    const { exitCode: _exitCode, ...payload } = envelope as CliEnvelope & { exitCode?: number };
    return Object.freeze({ exitCode, stdout: `${JSON.stringify(payload)}\n`, stderr: '' });
  }
  if (envelope.ok) return Object.freeze({ exitCode, stdout: `${human}\n`, stderr: '' });
  const failure = envelope.error!;
  return Object.freeze({ exitCode, stdout: '', stderr: `${failure.code}: ${failure.message}\n` });
}

function renderFailure(command: CliCommand, requestId: string, failure: CliFailure): CliExecutionResult {
  const envelope: CliEnvelope & { exitCode: number } = {
    schemaVersion: 1,
    ok: false,
    command: commandName(command),
    requestId,
    error: { code: failure.code, message: failure.message },
    exitCode: failure.exitCode,
  };
  const format = 'format' in command ? command.format : 'human';
  return renderEnvelope(envelope, format, '');
}

export async function runCliInternal(
  argv: readonly string[],
  createApplication: () => Promise<CliApplication>,
  allowTestOnlyRun: boolean,
): Promise<CliExecutionResult> {
  const requestId = randomUUID();
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    const envelope: CliEnvelope & { exitCode: number } = {
      schemaVersion: 1, ok: false, command: 'invalid', requestId,
      error: { code: 'invalid_command', message: parsed.message }, exitCode: 2,
    };
    return renderEnvelope(envelope, parsed.format, '');
  }
  if (parsed.command.kind === 'version') {
    return Object.freeze({ exitCode: 0, stdout: 'agentctl 0.1.0 (contract v1)\n', stderr: '' });
  }
  let taskFileCandidate: unknown;
  if (parsed.command.kind === 'task.validate' || parsed.command.kind === 'task.create') {
    try {
      taskFileCandidate = await readTaskFile(parsed.command.file);
    } catch (error) {
      const failure = error instanceof CliRaisedError ? error.failure : failureFor(error);
      return renderFailure(parsed.command, requestId, failure);
    }
    if (!validateTaskEnvelopeV1(taskFileCandidate).valid) {
      return renderFailure(parsed.command, requestId, {
        code: 'invalid_task',
        message: 'O conteúdo não atende ao contrato de tarefa.',
        exitCode: 2,
      });
    }
  }

  let app: CliApplication | undefined;
  try {
    app = await createApplication();
    const data = await dispatch(parsed.command, app, taskFileCandidate, allowTestOnlyRun);
    const result = successResult(parsed.command, data);
    const envelope: CliEnvelope & { exitCode: number } = {
      schemaVersion: 1, ok: true, command: commandName(parsed.command), requestId, data: result.data, exitCode: result.exitCode,
    };
    const human = humanText(parsed.command, result.data);
    return renderEnvelope(envelope, parsed.command.format, human);
  } catch (error) {
    const failure = error instanceof CliRaisedError
      ? error.failure
      : failureFor(error, app?.startup);
    return renderFailure(parsed.command, requestId, failure);
  }
}
