import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canTransitionTaskState,
  InvalidTaskTransitionError,
  isTerminalTaskState,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  transitionTaskState,
  type TaskState,
} from './state.ts';
import { TASK_STATE_CHANGED_EVENT, type TaskEventMetadata } from './event.ts';

const metadata: TaskEventMetadata = {
  eventId: 'evt-001',
  taskId: 'task-001',
  occurredAt: '2026-10-26T12:00:00.000Z',
  actor: 'system',
  reasonCode: 'classified',
  envelopeSha256: 'a'.repeat(64),
};

const allowedTransitions: readonly (readonly [TaskState, TaskState])[] = [
  ['DRAFT', 'CLASSIFIED'],
  ['DRAFT', 'REJECTED'],
  ['DRAFT', 'CANCELLED'],
  ['CLASSIFIED', 'WAITING_APPROVAL'],
  ['CLASSIFIED', 'QUEUED'],
  ['CLASSIFIED', 'REJECTED'],
  ['CLASSIFIED', 'CANCELLED'],
  ['WAITING_APPROVAL', 'QUEUED'],
  ['WAITING_APPROVAL', 'REJECTED'],
  ['WAITING_APPROVAL', 'CANCELLED'],
  ['QUEUED', 'RUNNING'],
  ['QUEUED', 'WAITING_APPROVAL'],
  ['QUEUED', 'REJECTED'],
  ['QUEUED', 'CANCELLED'],
  ['QUEUED', 'INTERRUPTED'],
  ['RUNNING', 'VERIFYING'],
  ['RUNNING', 'FAILED'],
  ['RUNNING', 'CANCELLED'],
  ['RUNNING', 'INTERRUPTED'],
  ['VERIFYING', 'SUCCEEDED'],
  ['VERIFYING', 'FAILED'],
  ['VERIFYING', 'CANCELLED'],
  ['VERIFYING', 'INTERRUPTED'],
  ['INTERRUPTED', 'QUEUED'],
  ['INTERRUPTED', 'WAITING_APPROVAL'],
  ['INTERRUPTED', 'CANCELLED'],
];
const allowedTransitionKeys = new Set(allowedTransitions.map(([from, to]) => `${from}->${to}`));

test('allows every declared transition and emits a complete immutable event', () => {
  for (const from of TASK_STATES) {
    for (const to of TASK_STATES) {
      assert.equal(
        canTransitionTaskState(from, to),
        allowedTransitionKeys.has(`${from}->${to}`),
        `${from} -> ${to}`,
      );
    }
  }

  for (const [from, to] of allowedTransitions) {
    assert.equal(canTransitionTaskState(from, to), true, `${from} -> ${to}`);
    const result = transitionTaskState(from, to, metadata);

    assert.equal(result.state, to);
    assert.deepEqual(result.event, {
      type: TASK_STATE_CHANGED_EVENT,
      ...metadata,
      from,
      to,
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.event), true);
  }
});

test('rejects direct execution and invalid terminal recovery', () => {
  assert.equal(canTransitionTaskState('DRAFT', 'RUNNING'), false);
  assert.throws(
    () => transitionTaskState('DRAFT', 'RUNNING', metadata),
    (error: unknown) => error instanceof InvalidTaskTransitionError
      && error.from === 'DRAFT'
      && error.to === 'RUNNING',
  );

  assert.equal(canTransitionTaskState('FAILED', 'SUCCEEDED'), false);
  assert.throws(() => transitionTaskState('FAILED', 'SUCCEEDED', metadata), InvalidTaskTransitionError);
});

test('terminal states have no outgoing transitions', () => {
  for (const terminal of TERMINAL_TASK_STATES) {
    assert.equal(isTerminalTaskState(terminal), true);
    for (const next of TASK_STATES) {
      assert.equal(canTransitionTaskState(terminal, next), false, `${terminal} -> ${next}`);
      assert.throws(() => transitionTaskState(terminal, next, metadata), InvalidTaskTransitionError);
    }
  }

  assert.equal(isTerminalTaskState('INTERRUPTED'), false);
});

test('does not mutate transition metadata or the input state', () => {
  const original = Object.freeze({ state: 'CLASSIFIED' as const });
  const inputMetadata = { ...metadata };
  const result = transitionTaskState(original.state, 'QUEUED', inputMetadata);

  assert.equal(original.state, 'CLASSIFIED');
  assert.deepEqual(inputMetadata, metadata);
  assert.throws(() => {
    (result.event as { to: TaskState }).to = 'FAILED';
  }, TypeError);
});
