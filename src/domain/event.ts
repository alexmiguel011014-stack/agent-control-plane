import type { TaskState } from './state.ts';
import type { ApprovalGrantV1, TaskOperation } from './policy.ts';

export const TASK_STATE_CHANGED_EVENT = 'task.state_changed' as const;
export const TASK_CREATED_EVENT = 'task.created' as const;
export const TASK_APPROVAL_RECORDED_EVENT = 'task.approval_recorded' as const;
export const TASK_CANCEL_REQUESTED_EVENT = 'task.cancel_requested' as const;

export type TaskActor = 'operator' | 'system' | 'agent' | 'evaluator';

export interface TaskEventMetadata {
  readonly eventId: string;
  readonly taskId: string;
  readonly occurredAt: string;
  readonly actor: TaskActor;
  readonly reasonCode?: string;
  readonly envelopeSha256?: string;
  readonly executionId?: string;
}

export interface TaskCreatedEvent extends Omit<TaskEventMetadata, 'envelopeSha256' | 'reasonCode'> {
  readonly type: typeof TASK_CREATED_EVENT;
  readonly envelopeSha256: string;
}

export interface TaskApprovalRecordedEvent extends Omit<TaskEventMetadata, 'reasonCode'> {
  readonly type: typeof TASK_APPROVAL_RECORDED_EVENT;
  readonly operations: readonly TaskOperation[];
  readonly expiresAt: string;
  readonly confirmed: true;
}

export interface TaskCancelRequestedEvent extends Omit<TaskEventMetadata, 'reasonCode' | 'executionId'> {
  readonly type: typeof TASK_CANCEL_REQUESTED_EVENT;
  readonly executionId: string;
}

export interface TaskStateChangedEvent extends TaskEventMetadata {
  readonly type: typeof TASK_STATE_CHANGED_EVENT;
  readonly from: TaskState;
  readonly to: TaskState;
}

export type TaskEvent = TaskCreatedEvent | TaskApprovalRecordedEvent | TaskCancelRequestedEvent | TaskStateChangedEvent;

/** Creation is a prompt-free visibility marker for the separate task repository. */
export function createTaskCreatedEvent(
  metadata: Omit<TaskEventMetadata, 'envelopeSha256' | 'reasonCode'>,
  envelopeSha256: string,
): TaskCreatedEvent {
  return Object.freeze({ type: TASK_CREATED_EVENT, ...metadata, envelopeSha256 });
}

/** Approval events persist only the narrow task/hash/operation/expiry binding. */
export function createTaskApprovalRecordedEvent(
  metadata: Omit<TaskEventMetadata, 'reasonCode' | 'envelopeSha256'>,
  approval: ApprovalGrantV1,
): TaskApprovalRecordedEvent {
  return Object.freeze({
    type: TASK_APPROVAL_RECORDED_EVENT,
    ...metadata,
    envelopeSha256: approval.envelopeSha256,
    operations: Object.freeze([...approval.operations]),
    expiresAt: approval.expiresAt,
    confirmed: approval.confirmed,
  });
}

/** Persist the task-wide cancellation intent without claiming the work has stopped. */
export function createTaskCancelRequestedEvent(
  metadata: Omit<TaskEventMetadata, 'reasonCode' | 'envelopeSha256' | 'executionId'>,
  envelopeSha256: string,
  executionId: string,
): TaskCancelRequestedEvent {
  return Object.freeze({
    type: TASK_CANCEL_REQUESTED_EVENT,
    ...metadata,
    envelopeSha256,
    executionId,
  });
}

/** Create a frozen event using metadata supplied by the application layer. */
export function createTaskStateChangedEvent(
  metadata: TaskEventMetadata,
  from: TaskState,
  to: TaskState,
): TaskStateChangedEvent {
  return Object.freeze({
    type: TASK_STATE_CHANGED_EVENT,
    eventId: metadata.eventId,
    taskId: metadata.taskId,
    occurredAt: metadata.occurredAt,
    actor: metadata.actor,
    ...(metadata.reasonCode === undefined ? {} : { reasonCode: metadata.reasonCode }),
    ...(metadata.envelopeSha256 === undefined ? {} : { envelopeSha256: metadata.envelopeSha256 }),
    ...(metadata.executionId === undefined ? {} : { executionId: metadata.executionId }),
    from,
    to,
  });
}

/** Stable semantic key for idempotent persistence, excluding event ID and time. */
export function taskEventSemanticKey(event: TaskEvent): string {
  switch (event.type) {
    case TASK_CREATED_EVENT:
      return JSON.stringify({
        type: event.type,
        taskId: event.taskId,
        envelopeSha256: event.envelopeSha256,
        actor: event.actor,
        executionId: event.executionId,
      });
    case TASK_APPROVAL_RECORDED_EVENT:
      return JSON.stringify({
        type: event.type,
        taskId: event.taskId,
        envelopeSha256: event.envelopeSha256,
        operations: [...event.operations].sort(),
        expiresAt: event.expiresAt,
        confirmed: event.confirmed,
        actor: event.actor,
        executionId: event.executionId,
      });
    case TASK_CANCEL_REQUESTED_EVENT:
      return JSON.stringify({
        type: event.type,
        taskId: event.taskId,
        envelopeSha256: event.envelopeSha256,
        executionId: event.executionId,
        actor: event.actor,
      });
    case TASK_STATE_CHANGED_EVENT:
      return JSON.stringify({
        type: event.type,
        taskId: event.taskId,
        envelopeSha256: event.envelopeSha256,
        from: event.from,
        to: event.to,
        reasonCode: event.reasonCode,
        actor: event.actor,
        executionId: event.executionId,
      });
  }
}
