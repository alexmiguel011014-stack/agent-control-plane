import { createTaskStateChangedEvent, type TaskEventMetadata, type TaskStateChangedEvent } from './event.ts';

export const TASK_STATES = Object.freeze([
  'DRAFT',
  'CLASSIFIED',
  'WAITING_APPROVAL',
  'QUEUED',
  'RUNNING',
  'VERIFYING',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'INTERRUPTED',
] as const);

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES = Object.freeze([
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
] as const satisfies readonly TaskState[]);

const ALLOWED_TRANSITIONS = {
  DRAFT: ['CLASSIFIED', 'REJECTED', 'CANCELLED'],
  CLASSIFIED: ['WAITING_APPROVAL', 'QUEUED', 'REJECTED', 'CANCELLED'],
  WAITING_APPROVAL: ['QUEUED', 'REJECTED', 'CANCELLED'],
  // Pre-run rechecks may reject policy changes or return expired approval for renewal.
  QUEUED: ['RUNNING', 'WAITING_APPROVAL', 'REJECTED', 'CANCELLED', 'INTERRUPTED'],
  RUNNING: ['VERIFYING', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  VERIFYING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  SUCCEEDED: [],
  FAILED: [],
  REJECTED: [],
  CANCELLED: [],
  // Recovery services must require an unchanged envelope for read-only resume;
  // write-capable work must return to approval (ADR-001 and G1.3).
  INTERRUPTED: ['QUEUED', 'WAITING_APPROVAL', 'CANCELLED'],
} as const satisfies Record<TaskState, readonly TaskState[]>;

export interface TaskStateTransition {
  readonly state: TaskState;
  readonly event: TaskStateChangedEvent;
}

export class InvalidTaskTransitionError extends Error {
  readonly from: TaskState;
  readonly to: TaskState;

  constructor(from: TaskState, to: TaskState) {
    super(`Task transition ${from} -> ${to} is not allowed`);
    this.name = 'InvalidTaskTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state as (typeof TERMINAL_TASK_STATES)[number]);
}

export function canTransitionTaskState(from: TaskState, to: TaskState): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly TaskState[]).includes(to);
}

/** Pure transition: application code supplies event identity and time. */
export function transitionTaskState(
  from: TaskState,
  to: TaskState,
  metadata: TaskEventMetadata,
): TaskStateTransition {
  if (!canTransitionTaskState(from, to)) {
    throw new InvalidTaskTransitionError(from, to);
  }

  const event = createTaskStateChangedEvent(metadata, from, to);
  return Object.freeze({ state: to, event });
}
