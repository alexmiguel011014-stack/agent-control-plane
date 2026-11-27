import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FakeAgentAdapter, type FakeAgentScenario } from '../adapters/fake-agent.ts';
import {
  TASK_APPROVAL_RECORDED_EVENT,
  TASK_CANCEL_REQUESTED_EVENT,
  TASK_CREATED_EVENT,
  TASK_STATE_CHANGED_EVENT,
  createTaskCancelRequestedEvent,
  taskEventSemanticKey,
  type TaskEvent,
} from '../domain/event.ts';
import type { ApprovalGrantV1, PolicyDecision, TaskOperation } from '../domain/policy.ts';
import { transitionTaskState, type TaskState } from '../domain/state.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import { ApplicationServiceError } from './errors.ts';
import { createTaskApplicationServices, type TaskApplicationDependencies } from './task-services.ts';
import { EventStoreConflictError, TaskExecutionLeaseBusyError } from './ports/index.ts';
import { LocalTaskExecutionLease } from '../infra/task-execution-lease.ts';
import { parseAgentProposal } from '../tools/tool-gateway.ts';
import type {
  EventAppendOptions,
  StoredTaskEnvelope,
  TaskExecutionLease,
  TaskExecutionLeaseKind,
  TaskExecutionLeasePort,
  TaskEventStorePort,
  TaskRepositoryPort,
  WorkspaceIntegrityPhase,
} from './ports/index.ts';

const now = '2026-10-26T12:00:00.000Z';
const snapshotHash = 'a'.repeat(64);

function input(taskId = 'task-001', operations: readonly TaskOperation[] = ['read']): TaskEnvelopeV1 {
  return {
    schemaVersion: 1,
    taskId,
    prompt: 'Summarize the local fixture.',
    requestedOperations: operations,
    allowedPaths: ['src/example.ts'],
    declaredTests: [],
    baseSnapshotSha256: snapshotHash,
  };
}

function digest(envelope: TaskEnvelopeV1): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

class MemoryTaskRepository implements TaskRepositoryPort {
  readonly items = new Map<string, StoredTaskEnvelope>();
  failNextSave = false;

  async saveIfAbsent(envelope: TaskEnvelopeV1, envelopeSha256: string): Promise<'created' | 'already_exists' | 'conflict'> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('storage unavailable');
    }
    const existing = this.items.get(envelope.taskId);
    if (existing) return existing.envelopeSha256 === envelopeSha256 ? 'already_exists' : 'conflict';
    this.items.set(envelope.taskId, Object.freeze({ envelope, envelopeSha256 }));
    return 'created';
  }

  async get(taskId: string): Promise<StoredTaskEnvelope | null> {
    return this.items.get(taskId) ?? null;
  }
}

class MemoryEventStore implements TaskEventStorePort {
  readonly streams = new Map<string, TaskEvent[]>();
  readonly byIdempotencyKey = new Map<string, TaskEvent>();
  failNextBeforeAppend = false;
  loseNextAppendAcknowledgment = false;
  conflictNextAppend = false;
  beforeCancelRequestAppend?: () => Promise<void>;
  beforeCancelStateAppend?: () => Promise<void>;

  async append(event: TaskEvent, options: EventAppendOptions): Promise<TaskEvent> {
    const prior = this.byIdempotencyKey.get(options.idempotencyKey);
    if (prior) {
      if (taskEventSemanticKey(prior) !== taskEventSemanticKey(event)) throw new EventStoreConflictError();
      return prior;
    }
    if (this.failNextBeforeAppend) {
      this.failNextBeforeAppend = false;
      throw new Error('append failed before commit');
    }
    if (event.type === TASK_CANCEL_REQUESTED_EVENT && this.beforeCancelRequestAppend) {
      const beforeAppend = this.beforeCancelRequestAppend;
      this.beforeCancelRequestAppend = undefined;
      await beforeAppend();
    }
    if (event.type === TASK_STATE_CHANGED_EVENT && event.to === 'CANCELLED' && this.beforeCancelStateAppend) {
      const beforeAppend = this.beforeCancelStateAppend;
      this.beforeCancelStateAppend = undefined;
      await beforeAppend();
    }
    if (this.conflictNextAppend) {
      this.conflictNextAppend = false;
      throw new EventStoreConflictError();
    }
    const stream = this.streams.get(event.taskId) ?? [];
    if (stream.length !== options.expectedVersion) throw new EventStoreConflictError();
    stream.push(event);
    this.streams.set(event.taskId, stream);
    this.byIdempotencyKey.set(options.idempotencyKey, event);
    if (this.loseNextAppendAcknowledgment) {
      this.loseNextAppendAcknowledgment = false;
      throw new Error('append committed but acknowledgment was lost');
    }
    return event;
  }

  async read(taskId: string, afterEventId?: string): Promise<readonly TaskEvent[]> {
    const stream = this.streams.get(taskId) ?? [];
    if (!afterEventId) return Object.freeze([...stream]);
    const index = stream.findIndex((event) => event.eventId === afterEventId);
    return Object.freeze(index < 0 ? [] : stream.slice(index + 1));
  }

  async listTaskIds(): Promise<readonly string[]> {
    return Object.freeze([...this.streams.entries()]
      .filter(([, stream]) => stream[0]?.type === TASK_CREATED_EVENT)
      .map(([taskId]) => taskId)
      .sort());
  }
}

class MemoryExecutionLease implements TaskExecutionLeasePort {
  private held = false;

  async tryAcquire(_kind: TaskExecutionLeaseKind): Promise<TaskExecutionLease> {
    if (this.held) throw new TaskExecutionLeaseBusyError();
    this.held = true;
    let released = false;
    return Object.freeze({
      release: async () => {
        if (released || !this.held) throw new Error('lease ownership lost');
        released = true;
        this.held = false;
      },
    });
  }
}

interface Harness {
  readonly app: ReturnType<typeof createTaskApplicationServices>;
  readonly repository: MemoryTaskRepository;
  readonly eventStore: MemoryEventStore;
  readonly executionLease: MemoryExecutionLease;
  createApp(lease?: TaskExecutionLeasePort): ReturnType<typeof createTaskApplicationServices>;
  readonly counters: { agent: number; tools: number; cancel: number; evaluate: number };
  readonly allocationExecutionIds: string[];
  readonly toolExecutionContexts: Array<{ readonly envelopeSha256: string; readonly approval?: ApprovalGrantV1 }>;
  setNow(value: string): void;
  setDecision(value: PolicyDecision): void;
  setIntegrityDenial(value: 'before_run' | WorkspaceIntegrityPhase | null): void;
  setIntegrityFailure(value: 'before_run' | WorkspaceIntegrityPhase | null): void;
  setStopConfirmed(value: boolean): void;
  setAgentScenario(value: FakeAgentScenario): void;
  setEvaluatorPassed(value: boolean): void;
  pauseWorkspace(): { readonly started: Promise<void>; release(): void };
  pauseAgent(): { readonly started: Promise<void>; release(): void };
  pauseEvaluator(): { readonly started: Promise<void>; release(): void };
}

function harness(): Harness {
  const repository = new MemoryTaskRepository();
  const eventStore = new MemoryEventStore();
  const executionLease = new MemoryExecutionLease();
  const counters = { agent: 0, tools: 0, cancel: 0, evaluate: 0 };
  const allocationExecutionIds: string[] = [];
  const toolExecutionContexts: Array<{ readonly envelopeSha256: string; readonly approval?: ApprovalGrantV1 }> = [];
  let currentTime = now;
  let policyDecision: PolicyDecision = { outcome: 'allow', reasonCode: 'policy_allowed' };
  let integrityDenial: 'before_run' | WorkspaceIntegrityPhase | null = null;
  let integrityFailure: 'before_run' | WorkspaceIntegrityPhase | null = null;
  let stopConfirmed = true;
  let evaluatorPassed = true;
  let agentGate: {
    readonly blocker: Promise<void>;
    readonly started: Promise<void>;
    readonly signalStarted: () => void;
    readonly release: () => void;
  } | undefined;
  let evaluatorGate: typeof agentGate;
  let workspaceGate: typeof agentGate;
  const agent = new FakeAgentAdapter({
    beforeInvoke: async () => {
      counters.agent += 1;
      const gate = agentGate;
      if (gate) {
        gate.signalStarted();
        await gate.blocker;
      }
    },
  });
  let nextId = 1;
  const dependencies: TaskApplicationDependencies = {
    events: eventStore,
    tasks: repository,
    hasher: { hash: async (envelope) => digest(envelope) },
    policy: { evaluate: async () => policyDecision },
    workspaces: {
      allocate: async (envelope, executionId) => {
        allocationExecutionIds.push(executionId);
        const gate = workspaceGate;
        if (gate) {
          gate.signalStarted();
          await gate.blocker;
        }
        return { workspaceId: `workspace:${envelope.taskId}` };
      },
    },
    workspaceIntegrity: {
      verifyBeforeRun: async () => {
        if (integrityFailure === 'before_run') throw new Error('workspace probe unavailable');
        return integrityDenial === 'before_run'
          ? { outcome: 'deny' as const, reasonCode: 'workspace_baseline_changed', changedPaths: ['src/example.ts'] }
          : { outcome: 'allow' as const, changedPaths: [] };
      },
      verifyAfterPhase: async ({ phase }) => {
        if (integrityFailure === phase) throw new Error('workspace probe unavailable');
        return integrityDenial === phase
          ? { outcome: 'deny' as const, reasonCode: 'workspace_integrity_violation', changedPaths: ['src/example.ts'] }
          : { outcome: 'allow' as const, changedPaths: [] };
      },
    },
    tools: {
      execute: async ({ proposal, envelopeSha256, approval: currentApproval }) => {
        parseAgentProposal(proposal);
        counters.tools += 1;
        toolExecutionContexts.push(Object.freeze({
          envelopeSha256,
          ...(currentApproval === undefined ? {} : { approval: currentApproval }),
        }));
        return [];
      },
    },
    executionControl: {
      cancelTask: async () => {
        counters.cancel += 1;
        if (stopConfirmed && agentGate) {
          agentGate.release();
          agentGate = undefined;
        }
        if (stopConfirmed && evaluatorGate) {
          evaluatorGate.release();
          evaluatorGate = undefined;
        }
        return { quiescent: stopConfirmed };
      },
    },
    executionLease,
    agent,
    evaluator: {
      evaluate: async () => {
        counters.evaluate += 1;
        const gate = evaluatorGate;
        if (gate) {
          gate.signalStarted();
          await gate.blocker;
        }
        return { passed: evaluatorPassed, reasonCode: evaluatorPassed ? 'verified' : 'fake_verification_failed' };
      },
    },
    clock: { now: () => currentTime },
    ids: { next: () => `event-${nextId++}` },
  };
  const app = createTaskApplicationServices(dependencies);
  return {
    app,
    repository,
    eventStore,
    executionLease,
    createApp: (lease = executionLease) => createTaskApplicationServices({ ...dependencies, executionLease: lease }),
    counters,
    allocationExecutionIds,
    toolExecutionContexts,
    setNow(value) { currentTime = value; },
    setDecision(value) { policyDecision = value; },
    setIntegrityDenial(value) { integrityDenial = value; },
    setIntegrityFailure(value) { integrityFailure = value; },
    setStopConfirmed(value) { stopConfirmed = value; },
    setAgentScenario(value) { agent.setScenario(value); },
    setEvaluatorPassed(value) { evaluatorPassed = value; },
    pauseWorkspace() {
      let signalStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const blocker = new Promise<void>((resolve) => { release = resolve; });
      const gate = { started, blocker, signalStarted, release };
      workspaceGate = gate;
      return {
        started,
        release() {
          gate.release();
          if (workspaceGate === gate) workspaceGate = undefined;
        },
      };
    },
    pauseAgent() {
      let signalStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const blocker = new Promise<void>((resolve) => { release = resolve; });
      const gate = { started, blocker, signalStarted, release };
      agentGate = gate;
      return {
        started,
        release() {
          gate.release();
          if (agentGate === gate) agentGate = undefined;
        },
      };
    },
    pauseEvaluator() {
      let signalStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const blocker = new Promise<void>((resolve) => { release = resolve; });
      const gate = { started, blocker, signalStarted, release };
      evaluatorGate = gate;
      return {
        started,
        release() {
          gate.release();
          if (evaluatorGate === gate) evaluatorGate = undefined;
        },
      };
    },
  };
}

function approval(envelope: TaskEnvelopeV1, expiresAt = '2026-10-26T13:00:00.000Z'): ApprovalGrantV1 {
  return Object.freeze({
    schemaVersion: 1,
    taskId: envelope.taskId,
    envelopeSha256: digest(envelope),
    operations: Object.freeze([...envelope.requestedOperations]),
    expiresAt,
    confirmed: true,
  });
}

async function interrupt(h: Harness, taskId: string, from: TaskState): Promise<void> {
  const stream = await h.eventStore.read(taskId);
  const event = transitionTaskState(from, 'INTERRUPTED', {
    eventId: `interrupt-${taskId}`,
    taskId,
    occurredAt: now,
    actor: 'system',
    reasonCode: 'process_restart',
  }).event;
  await h.eventStore.append(event, {
    idempotencyKey: `state:${taskId}:${stream.length}:${from}:INTERRUPTED`,
    expectedVersion: stream.length,
  });
}

test('validates a closed immutable TaskEnvelopeV1 without echoing prompt data in errors', () => {
  const h = harness();
  const result = h.app.validateTask(input());
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(Object.isFrozen(result.envelope), true);
    assert.equal(Object.isFrozen(result.envelope.requestedOperations), true);
    assert.equal(Object.isFrozen(result.envelope.declaredTests), true);
  }
  const invalid = h.app.validateTask({ ...input(), prompt: 'must not be echoed', unexpected: true });
  assert.equal(invalid.valid, false);
  if (!invalid.valid) assert.equal(JSON.stringify(invalid.issues).includes('must not be echoed'), false);

  const withDeclaredTest = h.app.validateTask({
    ...input('task-declared-test'),
    declaredTests: [{ id: 'smoke', profile: 'host-json-v1' }],
  });
  assert.equal(withDeclaredTest.valid, true);
  assert.equal(h.app.validateTask({
    ...input('task-host-harness-path'),
    declaredTests: [{ id: 'smoke', profile: 'host-json-v1', path: 'tests/smoke.mjs' }],
  }).valid, false);
  assert.equal(h.app.validateTask({
    ...input('task-duplicate-test'),
    declaredTests: [
      { id: 'same', profile: 'host-json-v1' },
      { id: 'same', profile: 'host-json-v1' },
    ],
  }).valid, false);
  assert.equal(h.app.validateTask({
    ...input('task-invalid-test-profile'),
    declaredTests: [{ id: 'smoke', profile: 'node-script' }],
  }).valid, false);
  assert.equal(h.app.validateTask({
    ...input('task-invalid-test-path'),
    declaredTests: [{ id: 'smoke', profile: 'node-test', path: '../outside.mjs' }],
  }).valid, false);
  assert.equal(h.app.validateTask({
    ...input('task-protected-test-path'),
    declaredTests: [{ id: 'smoke', profile: 'node-test', path: 'tests/credentials.prod.json' }],
  }).valid, false);
});

test('rejects uppercase task IDs before saving or appending events', async () => {
  const h = harness();
  const envelope = input('Task-Uppercase');
  assert.equal(h.app.validateTask(envelope).valid, false);
  await assert.rejects(h.app.createTask(envelope), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'INVALID_TASK');
  assert.equal(h.repository.items.size, 0);
  assert.deepEqual(await h.eventStore.listTaskIds(), []);
});

test('creates, classifies, approves, runs, and verifies using ports; persisted events contain no prompt', async () => {
  const h = harness();
  const envelope = input('task-write', ['read', 'write']);
  assert.equal((await h.app.createTask(envelope)).state, 'DRAFT');
  assert.equal((await h.app.classifyTask(envelope.taskId)).state, 'WAITING_APPROVAL');

  const grant = approval(envelope);
  const invalidGrants: ApprovalGrantV1[] = [
    { ...grant, envelopeSha256: 'b'.repeat(64) },
    { ...grant, operations: ['read'] },
    { ...grant, expiresAt: '2026-10-26T11:59:59.000Z' },
    { ...grant, expiresAt: '2026-02-30T13:00:00.000Z' },
    { ...grant, confirmed: false as true },
  ];
  for (const invalid of invalidGrants) {
    await assert.rejects(h.app.approveTask(invalid), (error: unknown) =>
      error instanceof ApplicationServiceError && error.code === 'APPROVAL_INVALID');
  }
  assert.equal((await h.eventStore.read(envelope.taskId)).some((event) => event.type === TASK_APPROVAL_RECORDED_EVENT), false);
  await assert.rejects(h.app.approveTask({ ...grant, taskId: 'missing-task' }), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'TASK_NOT_FOUND');
  assert.equal((await h.app.getTaskStatus(envelope.taskId)).state, 'WAITING_APPROVAL');

  assert.equal((await h.app.approveTask(grant)).state, 'QUEUED');
  assert.equal((await h.app.runTask(envelope.taskId)).state, 'SUCCEEDED');
  assert.deepEqual(h.counters, { agent: 1, tools: 1, cancel: 0, evaluate: 1 });
  assert.equal(h.toolExecutionContexts[0]?.envelopeSha256, digest(envelope));
  assert.deepEqual(h.toolExecutionContexts[0]?.approval, grant);

  const events = await h.app.getTaskEvents(envelope.taskId);
  assert.equal(events.some((event) => event.type === TASK_CREATED_EVENT), true);
  assert.equal(events.some((event) => event.type === TASK_APPROVAL_RECORDED_EVENT), true);
  assert.equal(events.some((event) => event.type === TASK_STATE_CHANGED_EVENT && event.to === 'SUCCEEDED'), true);
  assert.equal(JSON.stringify(events).includes(envelope.prompt), false);
  assert.equal((await h.app.createTask(envelope)).state, 'SUCCEEDED');
  assert.equal((await h.eventStore.read(envelope.taskId)).filter((event) => event.type === TASK_CREATED_EVENT).length, 1);
});

test('agent refusal fails the task before tools or the evaluator', async () => {
  const h = harness();
  const envelope = input('task-agent-refusal');
  h.setAgentScenario('refusal');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);

  assert.equal((await h.app.runTask(envelope.taskId)).state, 'FAILED');
  assert.deepEqual(h.counters, { agent: 1, tools: 0, cancel: 0, evaluate: 0 });
  const events = await h.app.getTaskEvents(envelope.taskId);
  assert.equal(events.some((event) => event.type === TASK_STATE_CHANGED_EVENT && event.to === 'SUCCEEDED'), false);
  const refusal = events.at(-1);
  assert.equal(refusal?.type === TASK_STATE_CHANGED_EVENT ? refusal.reasonCode : undefined, 'agent_refused');
});

test('malformed and repeated agent proposals fail before tools or evaluator effects', async () => {
  for (const [scenario, taskId] of [
    ['malformed_output', 'task-agent-malformed'],
    ['repeated_tool_request', 'task-agent-repeated'],
  ] as const) {
    const h = harness();
    const envelope = input(taskId);
    h.setAgentScenario(scenario);
    await h.app.createTask(envelope);
    await h.app.classifyTask(envelope.taskId);

    assert.equal((await h.app.runTask(envelope.taskId)).state, 'FAILED');
    assert.deepEqual(h.counters, { agent: 1, tools: 0, cancel: 0, evaluate: 0 });
    assert.equal((await h.app.getTaskEvents(envelope.taskId)).some((event) =>
      event.type === TASK_STATE_CHANGED_EVENT && event.to === 'SUCCEEDED'), false);
  }
});

test('agent timeout and crash fail the task without reaching tools or evaluator', async () => {
  for (const [scenario, taskId] of [
    ['timeout', 'task-agent-timeout'],
    ['crash', 'task-agent-crash'],
  ] as const) {
    const h = harness();
    const envelope = input(taskId);
    h.setAgentScenario(scenario);
    await h.app.createTask(envelope);
    await h.app.classifyTask(envelope.taskId);

    assert.equal((await h.app.runTask(envelope.taskId)).state, 'FAILED');
    assert.deepEqual(h.counters, { agent: 1, tools: 0, cancel: 0, evaluate: 0 });
    assert.equal((await h.app.getTaskEvents(envelope.taskId)).some((event) =>
      event.type === TASK_STATE_CHANGED_EVENT && event.to === 'SUCCEEDED'), false);
  }
});

test('only a passing external evaluator can produce SUCCEEDED', async () => {
  const h = harness();
  const envelope = input('task-evaluator-rejects');
  h.setEvaluatorPassed(false);
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);

  assert.equal((await h.app.runTask(envelope.taskId)).state, 'FAILED');
  assert.equal(h.counters.evaluate, 1);
  const events = await h.app.getTaskEvents(envelope.taskId);
  assert.equal(events.some((event) => event.type === TASK_STATE_CHANGED_EVENT && event.to === 'SUCCEEDED'), false);
  const finalEvent = events.at(-1);
  assert.equal(finalEvent?.type === TASK_STATE_CHANGED_EVENT ? finalEvent.reasonCode : undefined, 'fake_verification_failed');
});

test('rejects a workspace baseline violation before recording RUNNING or invoking the agent', async () => {
  const h = harness();
  const envelope = input('task-workspace-baseline');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  h.setIntegrityDenial('before_run');

  assert.equal((await h.app.runTask(envelope.taskId)).state, 'REJECTED');
  assert.equal(h.counters.agent, 0);
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).some((event) =>
    event.type === TASK_STATE_CHANGED_EVENT && event.to === 'RUNNING'), false);
});

test('keeps a queued task nonterminal when the pre-run integrity check fails operationally', async () => {
  const h = harness();
  const envelope = input('task-workspace-check-error');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  h.setIntegrityFailure('before_run');

  await assert.rejects(h.app.runTask(envelope.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'RUNNER_FAILURE');
  assert.equal((await h.app.getTaskStatus(envelope.taskId)).state, 'QUEUED');
  assert.equal(h.counters.agent, 0);
});

test('fails a run when workspace integrity fails after tools or evaluator', async () => {
  for (const phase of ['after_tools', 'after_evaluator'] as const) {
    const h = harness();
    const envelope = input(`task-workspace-${phase}`);
    await h.app.createTask(envelope);
    await h.app.classifyTask(envelope.taskId);
    h.setIntegrityDenial(phase);

    assert.equal((await h.app.runTask(envelope.taskId)).state, 'FAILED');
    assert.equal(h.counters.evaluate, phase === 'after_tools' ? 0 : 1);
  }
});

test('does not publish a task when saving its envelope fails', async () => {
  const h = harness();
  const envelope = input();
  h.repository.failNextSave = true;
  await assert.rejects(h.app.createTask(envelope), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'RUNNER_FAILURE'
      && !error.message.includes(envelope.prompt));
  assert.equal(h.eventStore.streams.has(envelope.taskId), false);
  await assert.rejects(h.app.getTaskStatus(envelope.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'TASK_NOT_FOUND');
});

test('keeps an orphan envelope invisible after append failure and completes the retry once', async () => {
  const h = harness();
  const envelope = input('task-orphan');
  h.eventStore.failNextBeforeAppend = true;
  await assert.rejects(h.app.createTask(envelope), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'RUNNER_FAILURE'
      && !error.message.includes(envelope.prompt));
  assert.equal(h.repository.items.has(envelope.taskId), true);
  assert.equal(h.eventStore.streams.has(envelope.taskId), false);
  await assert.rejects(h.app.getTaskStatus(envelope.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'TASK_NOT_FOUND');

  assert.equal((await h.app.createTask(envelope)).state, 'DRAFT');
  assert.equal((await h.eventStore.read(envelope.taskId)).filter((event) => event.type === TASK_CREATED_EVENT).length, 1);
});

test('a committed create event with a lost acknowledgment is idempotent on retry', async () => {
  const h = harness();
  const envelope = input('task-lost-ack');
  h.eventStore.loseNextAppendAcknowledgment = true;
  await assert.rejects(h.app.createTask(envelope));
  const status = await h.app.createTask(envelope);
  assert.equal(status.state, 'DRAFT');
  assert.equal((await h.eventStore.read(envelope.taskId)).filter((event) => event.type === TASK_CREATED_EVENT).length, 1);
});

test('a committed approval event with a lost acknowledgment is idempotent on retry', async () => {
  const h = harness();
  const envelope = input('task-approval-lost-ack', ['write']);
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  h.eventStore.loseNextAppendAcknowledgment = true;
  const grant = approval(envelope);
  await assert.rejects(h.app.approveTask(grant));
  assert.equal((await h.app.getTaskStatus(envelope.taskId)).state, 'WAITING_APPROVAL');
  assert.equal((await h.app.approveTask(grant)).state, 'QUEUED');
  assert.equal((await h.eventStore.read(envelope.taskId)).filter((event) => event.type === TASK_APPROVAL_RECORDED_EVENT).length, 1);
});

test('a new WAITING_APPROVAL boundary invalidates the prior grant before execution', async () => {
  const h = harness();
  const envelope = input('task-approval-boundary-policy', ['write']);
  const grant = approval(envelope);
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  await h.app.approveTask(grant);
  h.setDecision({ outcome: 'requires_approval', reasonCode: 'renew_approval' });
  assert.equal((await h.app.queueTask(envelope.taskId)).state, 'WAITING_APPROVAL');
  h.setDecision({ outcome: 'allow', reasonCode: 'policy_allowed' });

  await assert.rejects(h.app.runTask(envelope.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'APPROVAL_REQUIRED');
  assert.equal((await h.app.getTaskStatus(envelope.taskId)).state, 'WAITING_APPROVAL');
  assert.equal(h.counters.agent, 0);
});

test('the same grant after a new boundary receives a boundary-specific idempotency key', async () => {
  const h = harness();
  const envelope = input('task-approval-boundary-key', ['write']);
  const grant = approval(envelope);
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  await h.app.approveTask(grant);
  h.setDecision({ outcome: 'requires_approval', reasonCode: 'renew_approval' });
  await h.app.queueTask(envelope.taskId);
  const stream = await h.app.getTaskEvents(envelope.taskId);
  const boundary = [...stream].reverse().find((event) =>
    event.type === TASK_STATE_CHANGED_EVENT && event.to === 'WAITING_APPROVAL');
  assert.ok(boundary && boundary.type === TASK_STATE_CHANGED_EVENT);
  h.setDecision({ outcome: 'allow', reasonCode: 'policy_allowed' });

  assert.equal((await h.app.approveTask(grant)).state, 'QUEUED');
  const approvalKeys = [...h.eventStore.byIdempotencyKey.keys()].filter((key) => key.startsWith('approval:'));
  assert.equal(approvalKeys.length, 2);
  assert.ok(approvalKeys.includes([
    'approval',
    envelope.taskId,
    boundary.eventId,
    grant.envelopeSha256,
    'write',
    grant.expiresAt,
  ].join(':')));
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).filter((event) => event.type === TASK_APPROVAL_RECORDED_EVENT).length, 2);
});

test('a fresh approval committed with a lost acknowledgment retries under the same boundary without duplication', async () => {
  const h = harness();
  const envelope = input('task-approval-boundary-lost-ack', ['write']);
  const grant = approval(envelope);
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  await h.app.approveTask(grant);
  h.setDecision({ outcome: 'requires_approval', reasonCode: 'renew_approval' });
  await h.app.queueTask(envelope.taskId);
  const stream = await h.app.getTaskEvents(envelope.taskId);
  const boundary = [...stream].reverse().find((event) =>
    event.type === TASK_STATE_CHANGED_EVENT && event.to === 'WAITING_APPROVAL');
  assert.ok(boundary && boundary.type === TASK_STATE_CHANGED_EVENT);
  const expectedKey = ['approval', envelope.taskId, boundary.eventId, grant.envelopeSha256, 'write', grant.expiresAt].join(':');
  h.setDecision({ outcome: 'allow', reasonCode: 'policy_allowed' });
  h.eventStore.loseNextAppendAcknowledgment = true;

  await assert.rejects(h.app.approveTask(grant));
  assert.equal((await h.app.getTaskStatus(envelope.taskId)).state, 'WAITING_APPROVAL');
  assert.equal((await h.eventStore.read(envelope.taskId)).filter((event) => event.type === TASK_APPROVAL_RECORDED_EVENT).length, 2);
  assert.equal((await h.app.approveTask(grant)).state, 'QUEUED');
  assert.equal((await h.eventStore.read(envelope.taskId)).filter((event) => event.type === TASK_APPROVAL_RECORDED_EVENT).length, 2);
  assert.equal(h.eventStore.byIdempotencyKey.has(expectedKey), true);
});

test('recovery invalidates the approval that preceded interruption', async () => {
  const h = harness();
  const envelope = input('task-approval-boundary-recovery', ['write']);
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  await h.app.approveTask(approval(envelope));
  await interrupt(h, envelope.taskId, 'QUEUED');
  assert.equal((await h.app.recoverTask(envelope.taskId, 'resume')).state, 'WAITING_APPROVAL');

  await assert.rejects(h.app.runTask(envelope.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'APPROVAL_REQUIRED');
  assert.equal((await h.app.getTaskStatus(envelope.taskId)).state, 'WAITING_APPROVAL');
  assert.equal(h.counters.agent, 0);
});

test('rejects a reused task ID whose envelope hash changed', async () => {
  const h = harness();
  const original = input('task-conflict');
  await h.app.createTask(original);
  await assert.rejects(h.app.createTask({ ...original, prompt: 'changed prompt' }), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'TASK_ID_CONFLICT');
  assert.equal((await h.eventStore.read(original.taskId)).length, 1);
});

test('maps event stream version conflicts to a redacted concurrency error', async () => {
  const h = harness();
  const envelope = input('task-version-conflict');
  await h.app.createTask(envelope);
  h.eventStore.conflictNextAppend = true;
  await assert.rejects(h.app.classifyTask(envelope.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'CONCURRENCY_CONFLICT');
  assert.equal((await h.app.getTaskStatus(envelope.taskId)).state, 'DRAFT');
});

test('rechecks expiry and policy before execution, returning stale or denied work to safe states', async () => {
  const stale = harness();
  const writeEnvelope = input('task-expired', ['write']);
  await stale.app.createTask(writeEnvelope);
  await stale.app.classifyTask(writeEnvelope.taskId);
  await stale.app.approveTask(approval(writeEnvelope, '2026-10-26T12:01:00.000Z'));
  stale.setNow('2026-10-26T12:02:00.000Z');
  await assert.rejects(stale.app.runTask(writeEnvelope.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'APPROVAL_REQUIRED');
  assert.equal((await stale.app.getTaskStatus(writeEnvelope.taskId)).state, 'WAITING_APPROVAL');
  assert.equal(stale.counters.agent, 0);

  const denied = harness();
  const readEnvelope = input('task-denied');
  await denied.app.createTask(readEnvelope);
  await denied.app.classifyTask(readEnvelope.taskId);
  denied.setDecision({ outcome: 'deny', reasonCode: 'policy_changed' });
  await assert.rejects(denied.app.runTask(readEnvelope.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'POLICY_DENIED');
  assert.equal((await denied.app.getTaskStatus(readEnvelope.taskId)).state, 'REJECTED');
  assert.equal(denied.counters.agent, 0);
});

test('cancels queued work and does not start an agent or tool', async () => {
  const h = harness();
  const envelope = input('task-cancel');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const cancellation = await h.app.cancelTask(envelope.taskId);
  assert.equal(cancellation.status.state, 'CANCELLED');
  assert.equal(cancellation.outcome, 'cancelled');
  assert.deepEqual(h.counters, { agent: 0, tools: 0, cancel: 0, evaluate: 0 });
});

test('keeps cancellation during workspace allocation correlated to the execution', async () => {
  const h = harness();
  const envelope = input('task-cancel-during-allocation');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const gate = h.pauseWorkspace();
  const run = h.app.runTask(envelope.taskId);
  await gate.started;

  const cancellation = await h.app.cancelTask(envelope.taskId);
  assert.equal(cancellation.status.state, 'CANCELLED');
  gate.release();

  assert.equal((await run).state, 'CANCELLED');
  assert.equal(h.allocationExecutionIds.length, 1);
  assert.match(h.allocationExecutionIds[0]!, /^event-\d+$/);
  assert.equal(h.counters.agent, 0);
});

test('active cancellation records intent and marks CANCELLED only after quiescence is confirmed', async () => {
  const h = harness();
  const envelope = input('task-cancel-active');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const gate = h.pauseAgent();
  const run = h.app.runTask(envelope.taskId);
  await gate.started;

  const cancellation = await h.app.cancelTask(envelope.taskId);
  const runResult = await run;
  assert.equal(cancellation.outcome, 'cancelled');
  assert.equal(cancellation.status.state, 'CANCELLED');
  assert.ok(['RUNNING', 'CANCELLED'].includes(runResult.state));
  const events = await h.app.getTaskEvents(envelope.taskId);
  assert.equal(events.some((event) => event.type === TASK_CANCEL_REQUESTED_EVENT), true);
  assert.equal(h.counters.cancel, 1);
  assert.equal(h.counters.tools, 0);
});

test('confirms a committed cancellation request when its append acknowledgment is lost', async () => {
  const h = harness();
  const envelope = input('task-cancel-lost-ack');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const gate = h.pauseAgent();
  const run = h.app.runTask(envelope.taskId);
  await gate.started;
  h.eventStore.loseNextAppendAcknowledgment = true;

  const cancellation = await h.app.cancelTask(envelope.taskId);
  assert.equal(cancellation.outcome, 'cancelled');
  assert.equal(cancellation.status.state, 'CANCELLED');
  assert.ok(['RUNNING', 'CANCELLED'].includes((await run).state));
  assert.equal(h.counters.cancel, 1);
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).filter((event) => event.type === TASK_CANCEL_REQUESTED_EVENT).length, 1);
});

test('does not stop active work when the cancellation intent was not persisted', async () => {
  const h = harness();
  const envelope = input('task-cancel-unlogged');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const gate = h.pauseAgent();
  const run = h.app.runTask(envelope.taskId);
  await gate.started;
  h.eventStore.failNextBeforeAppend = true;

  const cancellation = await h.app.cancelTask(envelope.taskId);
  assert.equal(cancellation.outcome, 'stop_unconfirmed');
  assert.equal(cancellation.status.state, 'RUNNING');
  assert.equal(h.counters.cancel, 0);
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).some((event) => event.type === TASK_CANCEL_REQUESTED_EVENT), false);
  gate.release();
  assert.equal((await run).state, 'SUCCEEDED');
});

test('cancels verification only after the evaluator is confirmed quiescent', async () => {
  const h = harness();
  const envelope = input('task-cancel-verifying');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const gate = h.pauseEvaluator();
  const run = h.app.runTask(envelope.taskId);
  await gate.started;

  const cancellation = await h.app.cancelTask(envelope.taskId);
  const events = await h.app.getTaskEvents(envelope.taskId);
  assert.equal(cancellation.outcome, 'cancelled');
  assert.equal(cancellation.status.state, 'CANCELLED');
  assert.ok(['VERIFYING', 'CANCELLED'].includes((await run).state));
  assert.ok(events.some((event) => event.type === TASK_STATE_CHANGED_EVENT && event.from === 'VERIFYING' && event.to === 'CANCELLED'));
  assert.equal(h.counters.cancel, 1);
});

test('unconfirmed active stop returns a stable pending result and leaves the task recoverable', async () => {
  const h = harness();
  const envelope = input('task-cancel-pending');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  h.setStopConfirmed(false);
  const gate = h.pauseAgent();
  const run = h.app.runTask(envelope.taskId);
  await gate.started;

  const cancellation = await h.app.cancelTask(envelope.taskId);
  assert.equal(cancellation.outcome, 'stop_unconfirmed');
  assert.equal(cancellation.status.state, 'RUNNING');
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).some((event) => event.type === TASK_CANCEL_REQUESTED_EVENT), true);
  gate.release();
  assert.equal((await run).state, 'RUNNING');
  assert.equal((await h.app.getTaskStatus(envelope.taskId)).state, 'RUNNING');
  assert.equal(h.counters.tools, 0);
  assert.equal(h.counters.evaluate, 0);
});

test('cancels a restarted interrupted execution only after task-wide stop is confirmed', async () => {
  const h = harness();
  const envelope = input('task-interrupted-cancel-retry');
  const executionId = await seedRunningTask(h, envelope);
  assert.equal((await h.app.recoverAfterRestart())[0].state, 'INTERRUPTED');

  h.setStopConfirmed(false);
  const pending = await h.app.cancelTask(envelope.taskId);
  assert.equal(pending.outcome, 'stop_unconfirmed');
  assert.equal(pending.status.state, 'INTERRUPTED');
  assert.equal(h.counters.cancel, 1);
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).filter((event) =>
    event.type === TASK_CANCEL_REQUESTED_EVENT && event.executionId === executionId).length, 1);

  h.setStopConfirmed(true);
  const completed = await h.app.cancelTask(envelope.taskId);
  assert.equal(completed.outcome, 'cancelled');
  assert.equal(completed.status.state, 'CANCELLED');
  assert.equal(h.counters.cancel, 2);
  const events = await h.app.getTaskEvents(envelope.taskId);
  assert.equal(events.filter((event) => event.type === TASK_CANCEL_REQUESTED_EVENT && event.executionId === executionId).length, 1);
  assert.ok(events.some((event) => event.type === TASK_STATE_CHANGED_EVENT
    && event.from === 'INTERRUPTED'
    && event.to === 'CANCELLED'
    && event.executionId === executionId));
});

test('leaves interrupted work pending when restart history has no execution ID', async () => {
  const h = harness();
  const envelope = input('task-interrupted-missing-execution');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const stream = await h.eventStore.read(envelope.taskId);
  const started = transitionTaskState('QUEUED', 'RUNNING', {
    eventId: 'run-without-execution-id',
    taskId: envelope.taskId,
    occurredAt: now,
    actor: 'system',
    reasonCode: 'execution_started',
  }).event;
  await h.eventStore.append(started, {
    idempotencyKey: 'run-without-execution-id',
    expectedVersion: stream.length,
  });
  assert.equal((await h.app.recoverAfterRestart())[0].state, 'INTERRUPTED');

  const cancellation = await h.app.cancelTask(envelope.taskId);
  assert.equal(cancellation.outcome, 'stop_unconfirmed');
  assert.equal(cancellation.status.state, 'INTERRUPTED');
  assert.equal(h.counters.cancel, 0);
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).some((event) =>
    event.type === TASK_CANCEL_REQUESTED_EVENT), false);
});

test('does not cancel a new execution when interrupted cancellation loses a version race', async () => {
  const h = harness();
  const envelope = input('task-interrupted-cancel-race');
  const previousExecutionId = await seedRunningTask(h, envelope);
  await h.app.recoverAfterRestart();
  h.eventStore.beforeCancelStateAppend = async () => {
    let stream = await h.eventStore.read(envelope.taskId);
    const changes = [
      { from: 'INTERRUPTED', to: 'QUEUED' },
      { from: 'QUEUED', to: 'RUNNING', executionId: 'execution-after-interruption' },
    ] as const;
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      const event = transitionTaskState(change.from, change.to, {
        eventId: `interrupted-race-${index}`,
        taskId: envelope.taskId,
        occurredAt: now,
        actor: 'system',
        reasonCode: 'new_execution_race',
        ...('executionId' in change && change.executionId ? { executionId: change.executionId } : {}),
      }).event;
      await h.eventStore.append(event, {
        idempotencyKey: `interrupted-race:${index}`,
        expectedVersion: stream.length,
      });
      stream = await h.eventStore.read(envelope.taskId);
    }
  };

  const cancellation = await h.app.cancelTask(envelope.taskId);
  assert.equal(cancellation.outcome, 'stop_unconfirmed');
  assert.equal(cancellation.status.state, 'RUNNING');
  assert.notEqual(previousExecutionId, 'execution-after-interruption');
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).some((event) =>
    event.type === TASK_STATE_CHANGED_EVENT && event.to === 'CANCELLED'), false);
});

test('preserves a committed terminal result when cancellation loses the race', async () => {
  const h = harness();
  const envelope = input('task-cancel-race');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const gate = h.pauseAgent();
  const run = h.app.runTask(envelope.taskId);
  await gate.started;
  h.eventStore.beforeCancelRequestAppend = async () => {
    gate.release();
    await run;
  };

  const cancellation = await h.app.cancelTask(envelope.taskId);
  assert.equal(cancellation.outcome, 'already_terminal');
  assert.equal(cancellation.status.state, 'SUCCEEDED');
  assert.equal(h.counters.cancel, 0);
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).some((event) => event.type === TASK_CANCEL_REQUESTED_EVENT), false);
});

test('does not cancel a different execution after the confirmed stop races with recovery', async () => {
  const h = harness();
  const envelope = input('task-cancel-new-execution');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const gate = h.pauseAgent();
  const run = h.app.runTask(envelope.taskId);
  await gate.started;
  h.eventStore.beforeCancelStateAppend = async () => {
    let stream = await h.eventStore.read(envelope.taskId);
    const running = [...stream].reverse().find((event) => event.type === TASK_STATE_CHANGED_EVENT && event.to === 'RUNNING');
    assert.ok(running && running.type === TASK_STATE_CHANGED_EVENT && running.executionId);
    const changes = [
      { from: 'RUNNING', to: 'INTERRUPTED', executionId: running.executionId },
      { from: 'INTERRUPTED', to: 'QUEUED' },
      { from: 'QUEUED', to: 'RUNNING', executionId: 'execution-recovered' },
    ] as const;
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      const event = transitionTaskState(change.from, change.to, {
        eventId: `recovery-race-${index}`,
        taskId: envelope.taskId,
        occurredAt: now,
        actor: 'system',
        reasonCode: 'recovery_race',
        ...('executionId' in change && change.executionId ? { executionId: change.executionId } : {}),
      }).event;
      await h.eventStore.append(event, {
        idempotencyKey: `recovery-race:${index}`,
        expectedVersion: stream.length,
      });
      stream = await h.eventStore.read(envelope.taskId);
    }
  };

  const cancellation = await h.app.cancelTask(envelope.taskId);
  assert.equal(cancellation.outcome, 'stop_unconfirmed');
  assert.equal(cancellation.status.state, 'RUNNING');
  assert.equal((await run).state, 'RUNNING');
  assert.equal((await h.app.getTaskEvents(envelope.taskId)).some((event) =>
    event.type === TASK_STATE_CHANGED_EVENT && event.to === 'CANCELLED'), false);
});

test('allows only one active run in an application instance', async () => {
  const h = harness();
  const first = input('task-sequential-1');
  const second = input('task-sequential-2');
  for (const envelope of [first, second]) {
    await h.app.createTask(envelope);
    await h.app.classifyTask(envelope.taskId);
  }
  const gate = h.pauseAgent();
  const firstRun = h.app.runTask(first.taskId);
  await gate.started;
  await assert.rejects(h.app.runTask(second.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'CONCURRENCY_CONFLICT');
  gate.release();
  assert.equal((await firstRun).state, 'SUCCEEDED');
  assert.equal((await h.app.getTaskStatus(second.taskId)).state, 'QUEUED');
  assert.equal(h.counters.agent, 1);
});

test('recovers read-only work to QUEUED and write-capable work to WAITING_APPROVAL', async () => {
  const read = harness();
  const readEnvelope = input('task-resume-read');
  await read.app.createTask(readEnvelope);
  await read.app.classifyTask(readEnvelope.taskId);
  await interrupt(read, readEnvelope.taskId, 'QUEUED');
  assert.equal((await read.app.recoverTask(readEnvelope.taskId, 'resume')).state, 'QUEUED');

  const write = harness();
  const writeEnvelope = input('task-resume-write', ['write']);
  await write.app.createTask(writeEnvelope);
  await write.app.classifyTask(writeEnvelope.taskId);
  await write.app.approveTask(approval(writeEnvelope));
  await interrupt(write, writeEnvelope.taskId, 'QUEUED');
  assert.equal((await write.app.recoverTask(writeEnvelope.taskId, 'resume')).state, 'WAITING_APPROVAL');
});

test('rejects recovery when the stored envelope no longer matches the creation hash', async () => {
  const h = harness();
  const envelope = input('task-tampered');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  await interrupt(h, envelope.taskId, 'QUEUED');
  const stored = h.repository.items.get(envelope.taskId);
  assert.ok(stored);
  h.repository.items.set(envelope.taskId, Object.freeze({
    ...stored,
    envelope: Object.freeze({ ...stored.envelope, prompt: 'tampered' }),
  }));
  await assert.rejects(h.app.recoverTask(envelope.taskId, 'resume'), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'ENVELOPE_HASH_MISMATCH');
});

test('status and event queries are read-only and never expose the task envelope', async () => {
  const h = harness();
  const envelope = input('task-query');
  await h.app.createTask(envelope);
  const before = await h.eventStore.read(envelope.taskId);
  const status = await h.app.getTaskStatus(envelope.taskId);
  const events = await h.app.getTaskEvents(envelope.taskId);
  assert.equal(status.state, 'DRAFT');
  assert.equal('prompt' in status, false);
  assert.equal(JSON.stringify(events).includes(envelope.prompt), false);
  assert.equal((await h.eventStore.read(envelope.taskId)).length, before.length);
});

async function seedRunningTask(h: Harness, envelope: TaskEnvelopeV1, cancelRequested = false): Promise<string> {
  await h.app.createTask(envelope);
  assert.equal((await h.app.classifyTask(envelope.taskId)).state, 'QUEUED');
  const executionId = `execution-${envelope.taskId}`;
  let stream = await h.eventStore.read(envelope.taskId);
  const started = transitionTaskState('QUEUED', 'RUNNING', {
    eventId: `started-${envelope.taskId}`,
    taskId: envelope.taskId,
    occurredAt: now,
    actor: 'system',
    envelopeSha256: digest(envelope),
    executionId,
  }).event;
  await h.eventStore.append(started, {
    idempotencyKey: `seed-running:${envelope.taskId}`,
    expectedVersion: stream.length,
  });
  if (cancelRequested) {
    stream = await h.eventStore.read(envelope.taskId);
    const cancel = createTaskCancelRequestedEvent({
      eventId: `cancel-request-${envelope.taskId}`,
      taskId: envelope.taskId,
      occurredAt: now,
      actor: 'operator',
    }, digest(envelope), executionId);
    await h.eventStore.append(cancel, {
      idempotencyKey: `seed-cancel:${envelope.taskId}`,
      expectedVersion: stream.length,
    });
  }
  return executionId;
}

test('run lease blocks another run and restart sweep, while cancellation remains available', async () => {
  const h = harness();
  const envelope = input('task-live-lease');
  await h.app.createTask(envelope);
  await h.app.classifyTask(envelope.taskId);
  const otherApp = h.createApp();
  const gate = h.pauseAgent();
  const run = h.app.runTask(envelope.taskId);
  await gate.started;

  await assert.rejects(otherApp.runTask(envelope.taskId), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'CONCURRENCY_CONFLICT');
  await assert.rejects(otherApp.recoverAfterRestart(), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'CONCURRENCY_CONFLICT');

  const cancellation = await otherApp.cancelTask(envelope.taskId);
  assert.equal(cancellation.outcome, 'cancelled');
  await run;
  assert.equal((await otherApp.getTaskStatus(envelope.taskId)).state, 'CANCELLED');
});

test('restart recovery acquires the lease and marks only active visible tasks interrupted', async () => {
  const h = harness();
  const envelope = input('task-restart-visible');
  await seedRunningTask(h, envelope);
  const otherApp = h.createApp();
  const activeRunLease = await h.executionLease.tryAcquire('run');
  await assert.rejects(otherApp.recoverAfterRestart(), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'CONCURRENCY_CONFLICT');
  await activeRunLease.release();

  const recovered = await otherApp.recoverAfterRestart();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].taskId, envelope.taskId);
  assert.equal(recovered[0].state, 'INTERRUPTED');
  const events = await otherApp.getTaskEvents(envelope.taskId);
  const lastEvent = events.at(-1);
  assert.equal(lastEvent?.type, TASK_STATE_CHANGED_EVENT);
  if (lastEvent?.type === TASK_STATE_CHANGED_EVENT) {
    assert.equal(lastEvent.reasonCode, 'process_restarted');
  }
});

test('restart recovery treats persisted cancellation intent as interrupted, never cancelled', async () => {
  const h = harness();
  const envelope = input('task-restart-cancel-intent');
  await seedRunningTask(h, envelope, true);
  const statuses = await h.createApp().recoverAfterRestart();
  assert.equal(statuses[0].state, 'INTERRUPTED');
  const events = await h.app.getTaskEvents(envelope.taskId);
  const last = events.at(-1);
  assert.equal(last?.type, TASK_STATE_CHANGED_EVENT);
  if (last?.type === TASK_STATE_CHANGED_EVENT) assert.equal(last.reasonCode, 'restart_after_cancel_request');
  assert.equal(events.some((event) => event.type === TASK_STATE_CHANGED_EVENT && event.to === 'CANCELLED'), false);
});

test('restart sweep stays blocked on a stale lock until explicit operator cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-recovery-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, 'runtime', 'controller.lock');
  await mkdir(join(root, 'runtime'));
  const staleRecord = `${JSON.stringify({ schemaVersion: 1, pid: 99_999_999, token: randomUUID(), kind: 'run' })}\n`;
  await writeFile(lockPath, staleRecord, 'utf8');

  const h = harness();
  const envelope = input('task-recovery-stale-lock');
  await seedRunningTask(h, envelope);
  const app = h.createApp(new LocalTaskExecutionLease(lockPath));
  await assert.rejects(app.recoverAfterRestart(), (error: unknown) =>
    error instanceof ApplicationServiceError
    && error.code === 'CONCURRENCY_CONFLICT'
    && error.lockConflict?.lockPath === lockPath
    && error.lockConflict.owner?.pid === 99_999_999);
  assert.equal(await readFile(lockPath, 'utf8'), staleRecord);
  assert.equal((await h.app.getTaskStatus(envelope.taskId)).state, 'RUNNING');

  // Test-only simulation of verifying the recorded PID is gone, closing every
  // other controller, and removing this exact runtime lock before restart.
  await unlink(lockPath);
  const recovered = await app.recoverAfterRestart();
  assert.equal(recovered[0].state, 'INTERRUPTED');
});

test('restart sweep never discovers an unreferenced envelope', async () => {
  const h = harness();
  const orphan = input('task-orphan-hidden');
  assert.equal(await h.repository.saveIfAbsent(orphan, digest(orphan)), 'created');
  assert.deepEqual(await h.eventStore.listTaskIds(), []);
  assert.deepEqual(await h.app.recoverAfterRestart(), []);
});
