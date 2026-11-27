import {
  createTaskApprovalRecordedEvent,
  createTaskCancelRequestedEvent,
  createTaskCreatedEvent,
  createTaskStateChangedEvent,
  TASK_APPROVAL_RECORDED_EVENT,
  TASK_CANCEL_REQUESTED_EVENT,
  TASK_CREATED_EVENT,
  TASK_STATE_CHANGED_EVENT,
  taskEventSemanticKey,
  type TaskEvent,
  type TaskEventMetadata,
} from '../domain/event.ts';
import {
  TASK_OPERATIONS,
  type ApprovalGrantV1,
  type PolicyDecision,
  type TaskOperation,
} from '../domain/policy.ts';
import { isTerminalTaskState, transitionTaskState, type TaskState } from '../domain/state.ts';
import {
  isValidTaskId,
  validateTaskEnvelopeV1 as validateEnvelopeShape,
  type TaskEnvelopeV1,
  type TaskValidationResult,
} from '../domain/task.ts';
export type { TaskValidationIssue, TaskValidationResult } from '../domain/task.ts';
import { ApplicationServiceError } from './errors.ts';
import {
  EventStoreBusyError,
  EventStoreConflictError,
  TaskExecutionLeaseBusyError,
} from './ports/index.ts';
import type {
  AgentInvocationResult,
  AgentInvocationPort,
  ClockPort,
  EnvelopeHasherPort,
  EvaluatorInvocationPort,
  EvaluatorResult,
  IdGeneratorPort,
  PolicyEvaluatorPort,
  TaskExecutionControlPort,
  TaskExecutionLeasePort,
  TaskEventStorePort,
  TaskRepositoryPort,
  ToolExecutionPort,
  WorkspaceAllocationPort,
  WorkspaceIntegrityPort,
  WorkspaceReference,
} from './ports/index.ts';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const OPERATION_SET = new Set<string>(TASK_OPERATIONS);

export interface TaskStatus {
  readonly taskId: string;
  readonly envelopeSha256: string;
  readonly state: TaskState;
  readonly version: number;
  readonly lastEventId: string;
}

export type CancellationOutcome = 'cancelled' | 'already_terminal' | 'stop_unconfirmed';

export interface TaskCancellationResult {
  readonly status: TaskStatus;
  readonly outcome: CancellationOutcome;
}

export interface TaskApplicationDependencies {
  readonly events: TaskEventStorePort;
  readonly tasks: TaskRepositoryPort;
  readonly hasher: EnvelopeHasherPort;
  readonly policy: PolicyEvaluatorPort;
  readonly workspaces: WorkspaceAllocationPort;
  readonly workspaceIntegrity: WorkspaceIntegrityPort;
  readonly tools: ToolExecutionPort;
  readonly executionControl: TaskExecutionControlPort;
  readonly executionLease: TaskExecutionLeasePort;
  readonly agent: AgentInvocationPort;
  readonly evaluator: EvaluatorInvocationPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

export interface TaskApplicationServices {
  validateTask(input: unknown): TaskValidationResult;
  createTask(input: unknown): Promise<TaskStatus>;
  classifyTask(taskId: string): Promise<TaskStatus>;
  approveTask(approval: ApprovalGrantV1): Promise<TaskStatus>;
  queueTask(taskId: string): Promise<TaskStatus>;
  runTask(taskId: string): Promise<TaskStatus>;
  cancelTask(taskId: string, reasonCode?: string): Promise<TaskCancellationResult>;
  recoverTask(taskId: string, mode: 'inspect' | 'resume'): Promise<TaskStatus>;
  recoverAfterRestart(): Promise<readonly TaskStatus[]>;
  getTaskStatus(taskId: string): Promise<TaskStatus>;
  getTaskEvents(taskId: string, afterEventId?: string): Promise<readonly TaskEvent[]>;
}

interface LoadedTask {
  readonly envelope: TaskEnvelopeV1;
  readonly envelopeSha256: string;
  readonly events: readonly TaskEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAgentInvocationResult(value: unknown): value is AgentInvocationResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  const keys = Object.keys(value);
  if (value.kind === 'proposal') {
    return keys.length === 2 && keys.every((key) => key === 'kind' || key === 'proposal')
      && Object.hasOwn(value, 'proposal');
  }
  if (value.kind === 'refusal') {
    return keys.every((key) => key === 'kind' || key === 'reasonCode')
      && (value.reasonCode === undefined
        || (typeof value.reasonCode === 'string' && REASON_CODE_PATTERN.test(value.reasonCode)));
  }
  return false;
}

function isReadOnly(envelope: TaskEnvelopeV1): boolean {
  return envelope.requestedOperations.every((operation) => operation === 'read');
}

function needsApproval(envelope: TaskEnvelopeV1): boolean {
  return envelope.requestedOperations.some((operation) => operation === 'write' || operation === 'process');
}

function currentState(events: readonly TaskEvent[]): TaskState {
  let state: TaskState = 'DRAFT';
  for (const event of events) {
    if (event.type === TASK_STATE_CHANGED_EVENT) state = event.to;
  }
  return state;
}

function freezeEvent(event: TaskEvent): TaskEvent {
  if (event.type === TASK_APPROVAL_RECORDED_EVENT) {
    return Object.freeze({ ...event, operations: Object.freeze([...event.operations]) });
  }
  return Object.freeze({ ...event });
}

function freezeEventStream(events: readonly TaskEvent[]): readonly TaskEvent[] {
  return Object.freeze(events.map(freezeEvent));
}

function latestApproval(events: readonly TaskEvent[]): ApprovalGrantV1 | undefined {
  const boundaryIndex = latestWaitingApprovalBoundaryIndex(events);
  if (boundaryIndex < 0) return undefined;
  let event: TaskEvent | undefined;
  for (let index = events.length - 1; index > boundaryIndex; index -= 1) {
    if (events[index].type === TASK_APPROVAL_RECORDED_EVENT) {
      event = events[index];
      break;
    }
  }
  if (!event || event.type !== TASK_APPROVAL_RECORDED_EVENT) return undefined;
  return Object.freeze({
    schemaVersion: 1,
    taskId: event.taskId,
    envelopeSha256: event.envelopeSha256 ?? '',
    operations: event.operations,
    expiresAt: event.expiresAt,
    confirmed: true,
  });
}

function latestWaitingApprovalBoundaryIndex(events: readonly TaskEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === TASK_STATE_CHANGED_EVENT && event.to === 'WAITING_APPROVAL') return index;
  }
  return -1;
}

function activeExecutionId(events: readonly TaskEvent[]): string | undefined {
  const started = [...events].reverse().find((event) =>
    event.type === TASK_STATE_CHANGED_EVENT && event.to === 'RUNNING');
  return started?.type === TASK_STATE_CHANGED_EVENT ? started.executionId : undefined;
}

function hasCancelRequest(events: readonly TaskEvent[], executionId: string): boolean {
  return events.some((event) => event.type === TASK_CANCEL_REQUESTED_EVENT && event.executionId === executionId);
}

function sameOperations(left: readonly TaskOperation[], right: readonly TaskOperation[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((operation, index) => operation === normalizedRight[index]);
}

function isValidUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
}

function isValidApproval(
  approval: ApprovalGrantV1 | undefined,
  envelope: TaskEnvelopeV1,
  envelopeSha256: string,
  now: string,
): approval is ApprovalGrantV1 {
  if (!approval || approval.schemaVersion !== 1 || approval.confirmed !== true) return false;
  if (approval.taskId !== envelope.taskId || approval.envelopeSha256 !== envelopeSha256) return false;
  if (!Array.isArray(approval.operations)
    || approval.operations.some((operation) => typeof operation !== 'string' || !OPERATION_SET.has(operation))
    || new Set(approval.operations).size !== approval.operations.length) return false;
  if (!sameOperations(approval.operations, envelope.requestedOperations)) return false;
  if (!isValidUtcTimestamp(approval.expiresAt) || !isValidUtcTimestamp(now)) return false;
  const expiry = Date.parse(approval.expiresAt);
  const current = Date.parse(now);
  return expiry > current;
}

function approvalIdempotencyKey(approval: ApprovalGrantV1, waitingBoundaryEventId: string): string {
  return [
    'approval',
    approval.taskId,
    waitingBoundaryEventId,
    approval.envelopeSha256,
    [...approval.operations].sort().join(','),
    approval.expiresAt,
  ].join(':');
}

function decisionNeedsApproval(decision: PolicyDecision): boolean {
  return decision.outcome === 'requires_approval';
}

function decisionDenies(decision: PolicyDecision): boolean {
  return decision.outcome === 'deny';
}

function safeReasonCode(value: string | undefined, fallback: string): string {
  return value && REASON_CODE_PATTERN.test(value) ? value : fallback;
}

async function callPort<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApplicationServiceError) throw error;
    if (error instanceof TaskExecutionLeaseBusyError) {
      throw new ApplicationServiceError('CONCURRENCY_CONFLICT', error.lockConflict);
    }
    if (error instanceof EventStoreBusyError) {
      throw new ApplicationServiceError('CONCURRENCY_CONFLICT', error.lockConflict);
    }
    if (error instanceof EventStoreConflictError) {
      throw new ApplicationServiceError('CONCURRENCY_CONFLICT');
    }
    throw new ApplicationServiceError('RUNNER_FAILURE');
  }
}

function assertHash(value: string): void {
  if (!SHA256_PATTERN.test(value)) throw new ApplicationServiceError('ENVELOPE_HASH_MISMATCH');
}

function toStatus(events: readonly TaskEvent[]): TaskStatus {
  const created = events.find((event) => event.type === TASK_CREATED_EVENT);
  if (!created || created.type !== TASK_CREATED_EVENT) throw new ApplicationServiceError('TASK_NOT_FOUND');
  const lastEvent = events.at(-1) ?? created;
  return Object.freeze({
    taskId: created.taskId,
    envelopeSha256: created.envelopeSha256,
    state: currentState(events),
    version: events.length,
    lastEventId: lastEvent.eventId,
  });
}

export function createTaskApplicationServices(dependencies: TaskApplicationDependencies): TaskApplicationServices {
  const {
    events: eventStore,
    tasks,
    hasher,
    policy,
    workspaces,
    workspaceIntegrity,
    tools,
    executionControl,
    executionLease,
    agent,
    evaluator,
    clock,
    ids,
  } = dependencies;

  async function readVisibleEvents(taskId: string): Promise<readonly TaskEvent[]> {
    const stream = freezeEventStream(await callPort(() => eventStore.read(taskId)));
    if (!stream.some((event) => event.type === TASK_CREATED_EVENT && event.taskId === taskId)) {
      throw new ApplicationServiceError('TASK_NOT_FOUND');
    }
    return stream;
  }

  async function loadTask(taskId: string): Promise<LoadedTask> {
    const stream = await readVisibleEvents(taskId);
    const created = stream.find((event) => event.type === TASK_CREATED_EVENT);
    if (!created || created.type !== TASK_CREATED_EVENT) throw new ApplicationServiceError('TASK_NOT_FOUND');
    const stored = await callPort(() => tasks.get(taskId));
    if (!stored) throw new ApplicationServiceError('TASK_RECORD_UNAVAILABLE');
    const validation = validateEnvelopeShape(stored.envelope);
    if (!validation.valid || validation.envelope.taskId !== taskId) {
      throw new ApplicationServiceError('ENVELOPE_HASH_MISMATCH');
    }
    const calculatedHash = await callPort(() => hasher.hash(validation.envelope));
    assertHash(calculatedHash);
    if (stored.envelopeSha256 !== created.envelopeSha256 || calculatedHash !== created.envelopeSha256) {
      throw new ApplicationServiceError('ENVELOPE_HASH_MISMATCH');
    }
    return Object.freeze({ envelope: validation.envelope, envelopeSha256: calculatedHash, events: stream });
  }

  async function appendState(
    taskId: string,
    stream: readonly TaskEvent[],
    to: TaskState,
    envelopeSha256: string,
    actor: TaskEventMetadata['actor'],
    reasonCode: string,
    executionId?: string,
    idempotencyKey?: string,
  ): Promise<readonly TaskEvent[]> {
    const from = currentState(stream);
    if (from === to) return stream;
    const metadata: TaskEventMetadata = {
      eventId: ids.next(),
      taskId,
      occurredAt: clock.now(),
      actor,
      reasonCode,
      envelopeSha256,
      ...(executionId === undefined ? {} : { executionId }),
    };
    const event = createTaskStateChangedEvent(
      metadata,
      from,
      to,
    );
    const stored = await callPort(() => eventStore.append(event, {
      idempotencyKey: idempotencyKey ?? `state:${taskId}:${stream.length}:${from}:${to}`,
      expectedVersion: stream.length,
    }));
    return Object.freeze([...stream, freezeEvent(stored)]);
  }

  async function appendCancelRequest(
    taskId: string,
    stream: readonly TaskEvent[],
    envelopeSha256: string,
    executionId: string,
  ): Promise<readonly TaskEvent[]> {
    const event = createTaskCancelRequestedEvent({
      eventId: ids.next(),
      taskId,
      occurredAt: clock.now(),
      actor: 'operator',
    }, envelopeSha256, executionId);
    const key = `cancel-request:${taskId}:${executionId}`;
    try {
      const stored = await callPort(() => eventStore.append(event, {
        idempotencyKey: key,
        expectedVersion: stream.length,
      }));
      if (stream.some((prior) => prior.eventId === stored.eventId)) return stream;
      return Object.freeze([...stream, freezeEvent(stored)]);
    } catch (error) {
      if (!(error instanceof ApplicationServiceError) || error.code !== 'CONCURRENCY_CONFLICT') throw error;
      const latest = await readVisibleEvents(taskId);
      if (isTerminalTaskState(currentState(latest)) || hasCancelRequest(latest, executionId)) return latest;
      const latestExecutionId = activeExecutionId(latest);
      if (latestExecutionId !== executionId) return latest;
      const stored = await callPort(() => eventStore.append(event, {
        idempotencyKey: key,
        expectedVersion: latest.length,
      }));
      if (latest.some((prior) => prior.eventId === stored.eventId)) return latest;
      return Object.freeze([...latest, freezeEvent(stored)]);
    }
  }

  async function transitionRunPhase(
    taskId: string,
    envelopeSha256: string,
    executionId: string,
    to: TaskState,
    actor: TaskEventMetadata['actor'],
    reasonCode: string,
  ): Promise<{ readonly events: readonly TaskEvent[]; readonly stopped: boolean }> {
    const latest = await readVisibleEvents(taskId);
    if (hasCancelRequest(latest, executionId) || isTerminalTaskState(currentState(latest))) {
      return Object.freeze({ events: latest, stopped: true });
    }
    try {
      const updated = await appendState(taskId, latest, to, envelopeSha256, actor, reasonCode, executionId);
      return Object.freeze({ events: updated, stopped: false });
    } catch (error) {
      if (!(error instanceof ApplicationServiceError) || error.code !== 'CONCURRENCY_CONFLICT') throw error;
      const afterConflict = await readVisibleEvents(taskId);
      if (hasCancelRequest(afterConflict, executionId) || isTerminalTaskState(currentState(afterConflict))) {
        return Object.freeze({ events: afterConflict, stopped: true });
      }
      throw error;
    }
  }

  async function evaluatePolicy(
    envelope: TaskEnvelopeV1,
    envelopeSha256: string,
    approval?: ApprovalGrantV1,
  ): Promise<PolicyDecision> {
    return callPort(() => policy.evaluate({ envelope, envelopeSha256, approval, now: clock.now() }));
  }

  async function classifyTask(taskId: string): Promise<TaskStatus> {
    const task = await loadTask(taskId);
    const state = currentState(task.events);
    if (state !== 'DRAFT' && state !== 'CLASSIFIED') return toStatus(task.events);
    const decision = await evaluatePolicy(task.envelope, task.envelopeSha256);
    let stream = state === 'DRAFT'
      ? await appendState(taskId, task.events, 'CLASSIFIED', task.envelopeSha256, 'system', 'classified')
      : task.events;
    let next: TaskState;
    let reason: string;
    if (task.envelope.requestedOperations.includes('network') || decisionDenies(decision)) {
      next = 'REJECTED';
      reason = safeReasonCode(decision.reasonCode, 'policy_denied');
    } else if (needsApproval(task.envelope) || decisionNeedsApproval(decision)) {
      next = 'WAITING_APPROVAL';
      reason = safeReasonCode(decision.reasonCode, 'approval_required');
    } else {
      next = 'QUEUED';
      reason = safeReasonCode(decision.reasonCode, 'policy_allowed');
    }
    stream = await appendState(taskId, stream, next, task.envelopeSha256, 'system', reason);
    return toStatus(stream);
  }

  async function queueTask(taskId: string): Promise<TaskStatus> {
    const task = await loadTask(taskId);
    const state = currentState(task.events);
    if (state !== 'CLASSIFIED' && state !== 'WAITING_APPROVAL' && state !== 'QUEUED') {
      throw new ApplicationServiceError('INVALID_STATE');
    }
    const approval = latestApproval(task.events);
    const validApproval = isValidApproval(approval, task.envelope, task.envelopeSha256, clock.now())
      ? approval
      : undefined;
    const decision = await evaluatePolicy(task.envelope, task.envelopeSha256, validApproval);
    let target: TaskState;
    let reasonCode: string;
    if (task.envelope.requestedOperations.includes('network') || decisionDenies(decision)) {
      target = 'REJECTED';
      reasonCode = safeReasonCode(decision.reasonCode, 'policy_denied');
    } else if (needsApproval(task.envelope) && !validApproval) {
      target = 'WAITING_APPROVAL';
      reasonCode = 'approval_required_or_expired';
    } else if (decisionNeedsApproval(decision)) {
      target = 'WAITING_APPROVAL';
      reasonCode = safeReasonCode(decision.reasonCode, 'approval_required');
    } else {
      target = 'QUEUED';
      reasonCode = safeReasonCode(decision.reasonCode, 'policy_allowed');
    }
    const updated = await appendState(taskId, task.events, target, task.envelopeSha256, 'system', reasonCode);
    return toStatus(updated);
  }

  async function approveTask(approval: ApprovalGrantV1): Promise<TaskStatus> {
    const task = await loadTask(approval.taskId);
    const state = currentState(task.events);
    const priorApproval = latestApproval(task.events);
    if (state === 'QUEUED' && priorApproval && sameGrant(priorApproval, approval)) {
      return queueTask(approval.taskId);
    }
    if (state !== 'WAITING_APPROVAL') throw new ApplicationServiceError('INVALID_STATE');
    const boundaryIndex = latestWaitingApprovalBoundaryIndex(task.events);
    const boundary = task.events[boundaryIndex];
    if (boundaryIndex < 0 || boundary.type !== TASK_STATE_CHANGED_EVENT || boundary.to !== 'WAITING_APPROVAL') {
      throw new ApplicationServiceError('INVALID_STATE');
    }
    if (!isValidApproval(approval, task.envelope, task.envelopeSha256, clock.now())) {
      throw new ApplicationServiceError('APPROVAL_INVALID');
    }
    const approvalEvent = createTaskApprovalRecordedEvent({
      eventId: ids.next(),
      taskId: approval.taskId,
      occurredAt: clock.now(),
      actor: 'operator',
    }, approval);
    await callPort(() => eventStore.append(approvalEvent, {
      idempotencyKey: approvalIdempotencyKey(approval, boundary.eventId),
      expectedVersion: task.events.length,
    }));
    return queueTask(approval.taskId);
  }

  async function runTaskUnlocked(taskId: string): Promise<TaskStatus> {
    await queueTask(taskId);
    const task = await loadTask(taskId);
    if (currentState(task.events) !== 'QUEUED') {
      if (currentState(task.events) === 'WAITING_APPROVAL') throw new ApplicationServiceError('APPROVAL_REQUIRED');
      if (currentState(task.events) === 'REJECTED') throw new ApplicationServiceError('POLICY_DENIED');
      throw new ApplicationServiceError('INVALID_STATE');
    }
    const approval = latestApproval(task.events);
    const validApproval = isValidApproval(approval, task.envelope, task.envelopeSha256, clock.now())
      ? approval
      : undefined;
    const decision = await evaluatePolicy(task.envelope, task.envelopeSha256, validApproval);
    if (task.envelope.requestedOperations.includes('network') || decisionDenies(decision)) {
      const rejected = await appendState(taskId, task.events, 'REJECTED', task.envelopeSha256, 'system', safeReasonCode(decision.reasonCode, 'policy_denied'));
      return toStatus(rejected);
    }
    if ((needsApproval(task.envelope) && !validApproval) || decisionNeedsApproval(decision)) {
      await appendState(taskId, task.events, 'WAITING_APPROVAL', task.envelopeSha256, 'system', 'approval_required_or_expired');
      throw new ApplicationServiceError('APPROVAL_REQUIRED');
    }

    const executionId = ids.next();
    let workspace: WorkspaceReference;
    try {
      workspace = await callPort(() => workspaces.allocate(task.envelope, executionId));
    } catch {
      throw new ApplicationServiceError('RUNNER_FAILURE');
    }

    let live = await readVisibleEvents(taskId);
    if (currentState(live) !== 'QUEUED') return toStatus(live);
    let baselineCheck;
    try {
      baselineCheck = await callPort(() => workspaceIntegrity.verifyBeforeRun({
        envelope: task.envelope,
        workspace,
        executionId,
      }));
    } catch {
      throw new ApplicationServiceError('RUNNER_FAILURE');
    }
    if (!baselineCheck || (baselineCheck.outcome !== 'allow' && baselineCheck.outcome !== 'deny')) {
      throw new ApplicationServiceError('RUNNER_FAILURE');
    }
    if (baselineCheck.outcome === 'deny') {
      if (typeof baselineCheck.reasonCode !== 'string' || !REASON_CODE_PATTERN.test(baselineCheck.reasonCode)
        || baselineCheck.reasonCode === 'workspace_integrity_check_failed') {
        throw new ApplicationServiceError('RUNNER_FAILURE');
      }
      try {
        const rejected = await appendState(
          taskId,
          live,
          'REJECTED',
          task.envelopeSha256,
          'system',
          safeReasonCode(baselineCheck.reasonCode, 'workspace_integrity_denied'),
          executionId,
        );
        return toStatus(rejected);
      } catch (error) {
        if (!(error instanceof ApplicationServiceError) || error.code !== 'CONCURRENCY_CONFLICT') throw error;
        live = await readVisibleEvents(taskId);
        if (isTerminalTaskState(currentState(live))) return toStatus(live);
        throw error;
      }
    }
    live = await readVisibleEvents(taskId);
    if (currentState(live) !== 'QUEUED') return toStatus(live);
    try {
      await appendState(
        taskId,
        live,
        'RUNNING',
        task.envelopeSha256,
        'system',
        'run_started',
        executionId,
        `run:${taskId}:${executionId}`,
      );
    } catch (error) {
      if (!(error instanceof ApplicationServiceError) || error.code !== 'CONCURRENCY_CONFLICT') throw error;
      live = await readVisibleEvents(taskId);
      if (isTerminalTaskState(currentState(live))) return toStatus(live);
      throw error;
    }
    live = await readVisibleEvents(taskId);
    if (hasCancelRequest(live, executionId)) return toStatus(live);

    let invocation: unknown;
    try {
      invocation = await callPort(() => agent.invoke({ envelope: task.envelope, workspace }));
    } catch {
      const failed = await transitionRunPhase(taskId, task.envelopeSha256, executionId, 'FAILED', 'system', 'runner_failure');
      return toStatus(failed.events);
    }
    live = await readVisibleEvents(taskId);
    if (hasCancelRequest(live, executionId) || isTerminalTaskState(currentState(live))) return toStatus(live);

    if (!isAgentInvocationResult(invocation)) {
      const failed = await transitionRunPhase(taskId, task.envelopeSha256, executionId, 'FAILED', 'system', 'agent_output_invalid');
      return toStatus(failed.events);
    }
    if (invocation.kind === 'refusal') {
      const failed = await transitionRunPhase(
        taskId,
        task.envelopeSha256,
        executionId,
        'FAILED',
        'agent',
        safeReasonCode(invocation.reasonCode, 'agent_refused'),
      );
      return toStatus(failed.events);
    }

    let toolFailed = false;
    try {
      await callPort(() => tools.execute({
        envelope: task.envelope,
        envelopeSha256: task.envelopeSha256,
        ...(validApproval === undefined ? {} : { approval: validApproval }),
        workspace,
        proposal: invocation.proposal,
      }));
    } catch {
      toolFailed = true;
    }
    let afterToolsCheck;
    try {
      afterToolsCheck = await callPort(() => workspaceIntegrity.verifyAfterPhase({
        envelope: task.envelope,
        workspace,
        executionId,
        phase: 'after_tools',
      }));
    } catch {
      const failed = await transitionRunPhase(taskId, task.envelopeSha256, executionId, 'FAILED', 'system', 'workspace_integrity_check_failed');
      return toStatus(failed.events);
    }
    if (!afterToolsCheck || afterToolsCheck.outcome !== 'allow') {
      const failed = await transitionRunPhase(taskId, task.envelopeSha256, executionId, 'FAILED', 'system', 'workspace_integrity_violation');
      return toStatus(failed.events);
    }
    if (toolFailed) {
      const failed = await transitionRunPhase(taskId, task.envelopeSha256, executionId, 'FAILED', 'system', 'runner_failure');
      return toStatus(failed.events);
    }
    const verifying = await transitionRunPhase(
      taskId,
      task.envelopeSha256,
      executionId,
      'VERIFYING',
      'system',
      'verification_started',
    );
    if (verifying.stopped) return toStatus(verifying.events);

    live = await readVisibleEvents(taskId);
    if (hasCancelRequest(live, executionId) || isTerminalTaskState(currentState(live))) return toStatus(live);
    let result: EvaluatorResult | undefined;
    let evaluatorFailed = false;
    try {
      result = await callPort(() => evaluator.evaluate({ envelope: task.envelope, workspace }));
    } catch {
      evaluatorFailed = true;
    }
    let afterEvaluatorCheck;
    try {
      afterEvaluatorCheck = await callPort(() => workspaceIntegrity.verifyAfterPhase({
        envelope: task.envelope,
        workspace,
        executionId,
        phase: 'after_evaluator',
      }));
    } catch {
      const failed = await transitionRunPhase(taskId, task.envelopeSha256, executionId, 'FAILED', 'system', 'workspace_integrity_check_failed');
      return toStatus(failed.events);
    }
    if (!afterEvaluatorCheck || afterEvaluatorCheck.outcome !== 'allow') {
      const failed = await transitionRunPhase(taskId, task.envelopeSha256, executionId, 'FAILED', 'system', 'workspace_integrity_violation');
      return toStatus(failed.events);
    }
    if (evaluatorFailed || !result) {
      const failed = await transitionRunPhase(taskId, task.envelopeSha256, executionId, 'FAILED', 'evaluator', 'verification_failure');
      return toStatus(failed.events);
    }
    const completed = await transitionRunPhase(
      taskId,
      task.envelopeSha256,
      executionId,
      result.passed ? 'SUCCEEDED' : 'FAILED',
      'evaluator',
      result.passed ? 'verification_passed' : safeReasonCode(result.reasonCode, 'verification_failed'),
    );
    return toStatus(completed.events);
  }

  async function runTask(taskId: string): Promise<TaskStatus> {
    let lease: Awaited<ReturnType<TaskExecutionLeasePort['tryAcquire']>> | undefined;
    try {
      lease = await callPort(() => executionLease.tryAcquire('run'));
      return await runTaskUnlocked(taskId);
    } finally {
      if (lease) await callPort(() => lease!.release());
    }
  }

  async function cancelTask(taskId: string, reasonCode = 'operator_cancelled'): Promise<TaskCancellationResult> {
    if (!REASON_CODE_PATTERN.test(reasonCode)) throw new ApplicationServiceError('INVALID_TASK');
    const task = await loadTask(taskId);
    let stream = task.events;
    let state = currentState(stream);
    if (isTerminalTaskState(state)) {
      return Object.freeze({ status: toStatus(stream), outcome: state === 'CANCELLED' ? 'cancelled' : 'already_terminal' });
    }

    let executionId: string | undefined;
    if (state === 'RUNNING' || state === 'VERIFYING' || state === 'INTERRUPTED') {
      executionId = activeExecutionId(stream);
      if (!executionId) return Object.freeze({ status: toStatus(stream), outcome: 'stop_unconfirmed' });
      const activeId = executionId;
      try {
        stream = await appendCancelRequest(taskId, stream, task.envelopeSha256, activeId);
      } catch {
        // A failed acknowledgment may follow a committed append. Confirm the
        // visibility marker before asking the execution adapter to stop work.
        stream = await readVisibleEvents(taskId);
        state = currentState(stream);
        if (isTerminalTaskState(state)) {
          return Object.freeze({ status: toStatus(stream), outcome: state === 'CANCELLED' ? 'cancelled' : 'already_terminal' });
        }
        if (!hasCancelRequest(stream, activeId) || activeExecutionId(stream) !== activeId) {
          return Object.freeze({ status: toStatus(stream), outcome: 'stop_unconfirmed' });
        }
      }
      state = currentState(stream);
      if (isTerminalTaskState(state)) {
        return Object.freeze({ status: toStatus(stream), outcome: state === 'CANCELLED' ? 'cancelled' : 'already_terminal' });
      }
      if (!hasCancelRequest(stream, activeId)) {
        return Object.freeze({ status: toStatus(stream), outcome: 'stop_unconfirmed' });
      }

      let quiescent = false;
      try {
        quiescent = (await callPort(() => executionControl.cancelTask({ taskId, executionId: activeId }))).quiescent === true;
      } catch {
        quiescent = false;
      }
      stream = await readVisibleEvents(taskId);
      state = currentState(stream);
      if (isTerminalTaskState(state)) {
        return Object.freeze({ status: toStatus(stream), outcome: state === 'CANCELLED' ? 'cancelled' : 'already_terminal' });
      }
      if (activeExecutionId(stream) !== activeId) {
        return Object.freeze({ status: toStatus(stream), outcome: 'stop_unconfirmed' });
      }
      if (!quiescent) return Object.freeze({ status: toStatus(stream), outcome: 'stop_unconfirmed' });
    }

    try {
      const cancelled = await appendState(
        taskId,
        stream,
        'CANCELLED',
        task.envelopeSha256,
        'operator',
        reasonCode,
        executionId,
      );
      return Object.freeze({ status: toStatus(cancelled), outcome: 'cancelled' });
    } catch (error) {
      if (!(error instanceof ApplicationServiceError) || error.code !== 'CONCURRENCY_CONFLICT') throw error;
      const latest = await readVisibleEvents(taskId);
      const latestState = currentState(latest);
      if (isTerminalTaskState(latestState)) {
        return Object.freeze({ status: toStatus(latest), outcome: latestState === 'CANCELLED' ? 'cancelled' : 'already_terminal' });
      }
      if ((latestState === 'RUNNING' || latestState === 'VERIFYING' || latestState === 'INTERRUPTED')
        && activeExecutionId(latest) === executionId) {
        const retried = await appendState(
          taskId,
          latest,
          'CANCELLED',
          task.envelopeSha256,
          'operator',
          reasonCode,
          activeExecutionId(latest),
        );
        return Object.freeze({ status: toStatus(retried), outcome: 'cancelled' });
      }
      return Object.freeze({ status: toStatus(latest), outcome: 'stop_unconfirmed' });
    }
  }

  async function recoverTask(taskId: string, mode: 'inspect' | 'resume'): Promise<TaskStatus> {
    const task = await loadTask(taskId);
    const state = currentState(task.events);
    if (mode === 'inspect' || state !== 'INTERRUPTED') return toStatus(task.events);
    if (task.envelope.requestedOperations.includes('network')) {
      const rejected = await appendState(taskId, task.events, 'REJECTED', task.envelopeSha256, 'system', 'network_not_allowed');
      return toStatus(rejected);
    }
    const target: TaskState = isReadOnly(task.envelope) ? 'QUEUED' : 'WAITING_APPROVAL';
    const reasonCode = target === 'QUEUED' ? 'read_only_resume_same_hash' : 'write_requires_fresh_approval';
    const resumed = await appendState(taskId, task.events, target, task.envelopeSha256, 'system', reasonCode);
    return toStatus(resumed);
  }

  async function recoverAfterRestart(): Promise<readonly TaskStatus[]> {
    const lease = await callPort(() => executionLease.tryAcquire('recovery'));
    try {
      const taskIds = await callPort(() => eventStore.listTaskIds());
      const recovered: TaskStatus[] = [];
      for (const taskId of taskIds) {
        let task = await loadTask(taskId);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const state = currentState(task.events);
          if (state !== 'RUNNING' && state !== 'VERIFYING') break;
          const executionId = activeExecutionId(task.events);
          const reasonCode = executionId && hasCancelRequest(task.events, executionId)
            ? 'restart_after_cancel_request'
            : 'process_restarted';
          try {
            const events = await appendState(
              taskId,
              task.events,
              'INTERRUPTED',
              task.envelopeSha256,
              'system',
              reasonCode,
              executionId,
            );
            task = Object.freeze({ ...task, events });
            break;
          } catch (error) {
            if (!(error instanceof ApplicationServiceError) || error.code !== 'CONCURRENCY_CONFLICT') throw error;
            task = await loadTask(taskId);
          }
        }
        const finalState = currentState(task.events);
        if (finalState === 'RUNNING' || finalState === 'VERIFYING') {
          throw new ApplicationServiceError('CONCURRENCY_CONFLICT');
        }
        recovered.push(toStatus(task.events));
      }
      return Object.freeze(recovered);
    } finally {
      await callPort(() => lease.release());
    }
  }

  return Object.freeze({
    validateTask: validateEnvelopeShape,
    async createTask(input: unknown): Promise<TaskStatus> {
      const validation = validateEnvelopeShape(input);
      if (!validation.valid) throw new ApplicationServiceError('INVALID_TASK');
      const envelope = validation.envelope;
      const envelopeSha256 = await callPort(() => hasher.hash(envelope));
      assertHash(envelopeSha256);
      const saveResult = await callPort(() => tasks.saveIfAbsent(envelope, envelopeSha256));
      if (saveResult === 'conflict') throw new ApplicationServiceError('TASK_ID_CONFLICT');
      const created = createTaskCreatedEvent({
        eventId: `created:${envelope.taskId}`,
        taskId: envelope.taskId,
        occurredAt: clock.now(),
        actor: 'operator',
      }, envelopeSha256);
      const event = await callPort(() => eventStore.append(created, {
        idempotencyKey: `task.created:${envelope.taskId}`,
        expectedVersion: 0,
      }));
      if (event.type !== TASK_CREATED_EVENT || event.taskId !== envelope.taskId || event.envelopeSha256 !== envelopeSha256) {
        throw new ApplicationServiceError('ENVELOPE_HASH_MISMATCH');
      }
      const persisted = await loadTask(envelope.taskId);
      return toStatus(persisted.events);
    },
    classifyTask,
    approveTask,
    queueTask,
    runTask,
    cancelTask,
    recoverTask,
    recoverAfterRestart,
    async getTaskStatus(taskId: string): Promise<TaskStatus> {
      return toStatus(await readVisibleEvents(taskId));
    },
    async getTaskEvents(taskId: string, afterEventId?: string): Promise<readonly TaskEvent[]> {
      const stream = await readVisibleEvents(taskId);
      if (!afterEventId) return Object.freeze([...stream]);
      const index = stream.findIndex((event) => event.eventId === afterEventId);
      if (index < 0) throw new ApplicationServiceError('INVALID_TASK');
      return freezeEventStream(stream.slice(index + 1));
    },
  });
}

function sameGrant(left: ApprovalGrantV1, right: ApprovalGrantV1): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.taskId === right.taskId
    && left.envelopeSha256 === right.envelopeSha256
    && left.expiresAt === right.expiresAt
    && left.confirmed === right.confirmed
    && sameOperations(left.operations, right.operations);
}
