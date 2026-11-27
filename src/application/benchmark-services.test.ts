import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskActor, TaskEvent } from '../domain/event.ts';
import type { ApprovalGrantV1 } from '../domain/policy.ts';
import type { TaskState } from '../domain/state.ts';
import { deriveLocalRunOutcome, validateLocalRunResult } from '../infra/benchmark-result.ts';
import { createRunMetricsCollector } from '../infra/metrics.ts';
import {
  BenchmarkServiceError,
  createBenchmarkApplicationServices,
  type BenchmarkApplicationDependencies,
} from './benchmark-services.ts';
import type {
  BenchmarkAttemptObservation,
  BenchmarkAttemptObserverPort,
  BenchmarkCatalogPort,
  BenchmarkResultBuilderPort,
  BenchmarkResultRecord,
  BenchmarkResultSinkPort,
  BenchmarkSuite,
  RunMetricsCollectorFactoryPort,
  RunMetricsCollectorPort,
} from './ports/index.ts';
import type { TaskApplicationServices, TaskStatus } from './task-services.ts';

const HASH = 'a'.repeat(64);
const ENVELOPE_HASH = 'b'.repeat(64);
const SUITE_ID = 'g2-local-pure-localized';

function envelopeInput() {
  return {
    prompt: 'Fix the bug.',
    requestedOperations: ['write'],
    allowedPaths: ['src/**'],
    declaredTests: [],
    baseSnapshotSha256: 'c'.repeat(64),
  };
}

function suite(taskIds: readonly string[] = ['B01', 'B02']): BenchmarkSuite {
  return { suiteId: SUITE_ID, tasks: taskIds.map((taskId) => ({ taskId, envelopeInput: envelopeInput() })) };
}

interface Terminal {
  readonly to: TaskState;
  readonly actor: TaskActor;
  readonly reasonCode: string;
}

type Script = (attemptTaskId: string) => Terminal | 'throw';

const RESOLVED: Terminal = { to: 'SUCCEEDED', actor: 'evaluator', reasonCode: 'verification_passed' };

function fakeTasks(script: Script, log: string[]) {
  const streams = new Map<string, TaskEvent[]>();
  const approvals: ApprovalGrantV1[] = [];
  let active = 0;
  let maxActive = 0;
  let counter = 0;
  const streamOf = (taskId: string): TaskEvent[] => {
    const events = streams.get(taskId);
    if (!events) throw new Error('missing');
    return events;
  };
  const push = (taskId: string, from: TaskState, to: TaskState, actor: TaskActor, reasonCode: string) => {
    counter += 1;
    streamOf(taskId).push({
      type: 'task.state_changed', eventId: `e${counter}`, taskId, occurredAt: '2026-11-10T00:00:00.000Z',
      actor, reasonCode, envelopeSha256: ENVELOPE_HASH, from, to,
    });
  };
  const status = (taskId: string): TaskStatus => {
    const events = streamOf(taskId);
    let state: TaskState = 'DRAFT';
    for (const event of events) if (event.type === 'task.state_changed') state = event.to;
    return { taskId, envelopeSha256: ENVELOPE_HASH, state, version: events.length, lastEventId: events[events.length - 1].eventId };
  };
  const services: TaskApplicationServices = {
    validateTask: () => { throw new Error('unused'); },
    async createTask(input: unknown) {
      const taskId = (input as { taskId: string }).taskId;
      log.push(`create:${taskId}`);
      streams.set(taskId, [{
        type: 'task.created', eventId: `created:${taskId}`, taskId, occurredAt: '2026-11-10T00:00:00.000Z',
        actor: 'operator', envelopeSha256: ENVELOPE_HASH,
      }]);
      return status(taskId);
    },
    async classifyTask(taskId) {
      push(taskId, 'DRAFT', 'CLASSIFIED', 'system', 'classified');
      push(taskId, 'CLASSIFIED', 'WAITING_APPROVAL', 'system', 'approval_required');
      return status(taskId);
    },
    async approveTask(approval) {
      approvals.push(approval);
      push(approval.taskId, 'WAITING_APPROVAL', 'QUEUED', 'system', 'policy_allowed');
      return status(approval.taskId);
    },
    async queueTask(taskId) { return status(taskId); },
    async runTask(taskId) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      log.push(`run-start:${taskId}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      log.push(`run-end:${taskId}`);
      const terminal = script(taskId);
      if (terminal === 'throw') throw new Error('runner');
      push(taskId, 'QUEUED', 'RUNNING', 'system', 'run_started');
      push(taskId, 'RUNNING', terminal.to, terminal.actor, terminal.reasonCode);
      return status(taskId);
    },
    cancelTask: () => { throw new Error('unused'); },
    recoverTask: () => { throw new Error('unused'); },
    recoverAfterRestart: () => { throw new Error('unused'); },
    async getTaskStatus(taskId) { return status(taskId); },
    async getTaskEvents(taskId) { return [...streamOf(taskId)]; },
  };
  return { services, approvals, maxActive: () => maxActive };
}

function fakeCatalog(value: BenchmarkSuite = suite()): BenchmarkCatalogPort & { registered: string[] } {
  const registered: string[] = [];
  const map = new Map<string, string>();
  return {
    registered,
    async listSuites() { return [{ suiteId: value.suiteId, taskIds: value.tasks.map((entry) => entry.taskId) }]; },
    async getSuite(suiteId) { return suiteId === value.suiteId ? value : null; },
    async registerAttempt(input) {
      registered.push(input.attemptTaskId);
      map.set(input.attemptTaskId, input.benchmarkTaskId);
    },
    benchmarkTaskIdFor(attemptTaskId) { return map.get(attemptTaskId) ?? null; },
  };
}

function fakeSink(failOn = -1): BenchmarkResultSinkPort & { written: BenchmarkResultRecord[] } {
  const written: BenchmarkResultRecord[] = [];
  return {
    written,
    async write(result) {
      if (written.length === failOn) throw new Error('disk');
      written.push(result);
    },
    async list(runId) { return written.filter((result) => result.runId === runId); },
  };
}

/** Backed by the real infra functions, as the composition will do. */
const realBuilder: BenchmarkResultBuilderPort = {
  build(input) {
    const validation = validateLocalRunResult({
      schemaVersion: 1,
      runId: input.runId,
      taskId: input.taskId,
      attempt: input.attempt,
      suiteId: input.suiteId,
      startedAtUtc: input.startedAtUtc,
      model: input.model,
      seed: input.seed,
      outcome: deriveLocalRunOutcome(input.publicStatus, input.oracleStatus, input.failureStatus),
      toolCalls: input.toolCalls,
      changedFiles: input.changedFiles,
      patch: input.patch,
      logSha256: input.logSha256,
      policyDenials: input.policyDenials,
      metrics: input.metrics,
    });
    if (!validation.valid) throw new Error(validation.issues.join(','));
    return validation.result;
  },
};

function fakeCollectorFactory(): RunMetricsCollectorFactoryPort & { calls: string[] } {
  const calls: string[] = [];
  let time = 0;
  return {
    calls,
    create(): RunMetricsCollectorPort {
      return createRunMetricsCollector({
        now: () => (time += 5),
        readCpu: () => ({ userMs: 1, systemMs: 1 }),
        readMemory: () => ({ rssBytes: 10, systemFreeBytes: 50, systemTotalBytes: 100 }),
        readGpu: async () => ({ status: 'unavailable', reason: 'tool_missing' }),
        setInterval: () => { calls.push('interval'); return null; },
        clearInterval: () => undefined,
      });
    },
  };
}

function fakeObserver(observe: (attemptTaskId: string) => BenchmarkAttemptObservation): BenchmarkAttemptObserverPort & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    begin(attemptTaskId) { log.push(`begin:${attemptTaskId}`); },
    finish(attemptTaskId) {
      log.push(`finish:${attemptTaskId}`);
      return observe(attemptTaskId);
    },
  };
}

const NO_PATCH = { changedFiles: 0, linesAdded: 0, linesRemoved: 0, sha256: null } as const;
const PROPOSAL: BenchmarkAttemptObservation = { agentOutcome: 'proposal', toolOperations: ['apply_unified_diff'], toolFailureCode: null, patch: NO_PATCH };

interface SetupOptions {
  readonly script?: Script;
  readonly observe?: (attemptTaskId: string) => BenchmarkAttemptObservation;
  readonly observer?: BenchmarkAttemptObserverPort;
  readonly sink?: BenchmarkResultSinkPort & { written: BenchmarkResultRecord[] };
  readonly metrics?: RunMetricsCollectorFactoryPort;
  readonly catalog?: BenchmarkCatalogPort & { registered: string[] };
}

function setup(options: SetupOptions = {}) {
  const log: string[] = [];
  const tasks = fakeTasks(options.script ?? (() => RESOLVED), log);
  const catalog = options.catalog ?? fakeCatalog();
  const sink = options.sink ?? fakeSink();
  const observer = options.observer ?? fakeObserver(options.observe ?? (() => PROPOSAL));
  let id = 0;
  const dependencies: BenchmarkApplicationDependencies = {
    tasks: tasks.services,
    catalog,
    results: sink,
    resultBuilder: realBuilder,
    metrics: options.metrics ?? fakeCollectorFactory(),
    observer,
    clock: { now: () => '2026-11-10T12:00:00.000Z' },
    ids: {
      next: () => {
        id += 1;
        return `gen${id}`;
      },
    },
    model: { tag: 'qwen2.5-coder:1.5b', digest: null, runtimeVersion: null },
    seed: { capable: false, value: null },
  };
  return { service: createBenchmarkApplicationServices(dependencies), log, tasks, catalog, sink };
}

async function single(terminal: Terminal | 'throw', observation: BenchmarkAttemptObservation) {
  const harness = setup({ script: () => terminal, observe: () => observation });
  await harness.service.run({ suiteId: SUITE_ID, taskId: 'B01', repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH });
  assert.equal(harness.sink.written.length, 1);
  return harness.sink.written[0];
}

test('a full run executes 2 tasks x 2 repetitions in sequence and writes one result each', async () => {
  const harness = setup();
  const summary = await harness.service.run({ suiteId: SUITE_ID, repetitions: 2, runId: 'run1', approvedReviewSetSha256: HASH });
  const expected = ['b01-run1-1', 'b01-run1-2', 'b02-run1-1', 'b02-run1-2'];
  assert.deepEqual(summary.attempts.map((attempt) => attempt.attemptTaskId), expected);
  assert.deepEqual(harness.catalog.registered, expected);
  assert.equal(harness.catalog.benchmarkTaskIdFor('b02-run1-2'), 'B02');
  assert.equal(harness.tasks.maxActive(), 1);
  const order = harness.log.filter((entry) => entry.startsWith('run-'));
  assert.deepEqual(order, expected.flatMap((taskId) => [`run-start:${taskId}`, `run-end:${taskId}`]));
  assert.equal(harness.sink.written.length, 4);
  for (const [index, result] of harness.sink.written.entries()) {
    assert.equal(result.runId, 'run1');
    assert.equal(result.taskId, index < 2 ? 'b01' : 'b02');
    assert.equal(result.attempt, (index % 2) + 1);
    assert.equal(result.outcome.status, 'PASS');
    assert.equal(result.toolCalls.total, 1);
    assert.equal(result.toolCalls.byOperation.apply_unified_diff, 1);
  }
  for (const approval of harness.tasks.approvals) {
    assert.deepEqual([...approval.operations], ['write']);
    assert.equal(approval.envelopeSha256, ENVELOPE_HASH);
    assert.equal(approval.expiresAt, '2026-11-10T12:15:00.000Z');
    assert.equal(approval.confirmed, true);
  }
  const report = await harness.service.report('run1');
  assert.deepEqual(report.totals, { attempts: 4, resolved_hidden: 4, public_pass: 4, policy_clean: 4, timeout: 0, runner_failure: 0 });
  assert.deepEqual(Object.keys(report.tasks), ['b01', 'b02']);
  assert.equal(report.tasks.b01.resolved_hidden, 2);
  assert.deepEqual(await harness.service.list(), [{ suiteId: SUITE_ID, taskIds: ['B01', 'B02'] }]);
});

test('evaluator reason codes map to the planned outcomes', async () => {
  const cases: [Terminal, string, string | null, string | null][] = [
    [RESOLVED, 'PASS', 'PASS', 'PASS'],
    [{ to: 'FAILED', actor: 'evaluator', reasonCode: 'oracle_fail' }, 'FAIL', 'PASS', 'FAIL'],
    [{ to: 'FAILED', actor: 'evaluator', reasonCode: 'public_fail' }, 'FAIL', 'FAIL', null],
    [{ to: 'FAILED', actor: 'evaluator', reasonCode: 'timeout' }, 'TIMEOUT', 'TIMEOUT', null],
    [{ to: 'FAILED', actor: 'evaluator', reasonCode: 'crash' }, 'CRASH', 'CRASH', null],
    [{ to: 'FAILED', actor: 'evaluator', reasonCode: 'runner_failure' }, 'RUNNER_FAILURE', 'RUNNER_FAILURE', null],
    [{ to: 'FAILED', actor: 'evaluator', reasonCode: 'policy_violation' }, 'POLICY_VIOLATION', 'POLICY_VIOLATION', null],
    [{ to: 'FAILED', actor: 'evaluator', reasonCode: 'verification_failure' }, 'RUNNER_FAILURE', null, null],
  ];
  for (const [terminal, status, publicStatus, oracleStatus] of cases) {
    const result = await single(terminal, PROPOSAL);
    assert.equal(result.outcome.status, status, terminal.reasonCode);
    assert.equal(result.outcome.publicStatus, publicStatus, terminal.reasonCode);
    assert.equal(result.outcome.oracleStatus, oracleStatus, terminal.reasonCode);
    assert.equal(result.policyDenials.count, 0);
  }
});

test('tool failure codes from the observer map to the planned outcomes', async () => {
  const toolFailed: Terminal = { to: 'FAILED', actor: 'system', reasonCode: 'runner_failure' };
  for (const code of ['hunk_mismatch', 'invalid_tool_request', 'tool_output_too_large']) {
    const result = await single(toolFailed, { ...PROPOSAL, toolFailureCode: code });
    assert.equal(result.outcome.status, 'FAIL', code);
    assert.equal(result.outcome.publicStatus, 'FAIL', code);
    assert.equal(result.outcome.oracleStatus, null, code);
    assert.equal(result.policyDenials.count, 0, code);
  }
  for (const code of ['tool_policy_denied', 'approval_required', 'g2_isolation_required', 'tool_unavailable']) {
    const result = await single(toolFailed, { ...PROPOSAL, toolFailureCode: code });
    assert.equal(result.outcome.status, 'POLICY_VIOLATION', code);
    assert.equal(result.outcome.policyClean, false, code);
    assert.deepEqual(result.policyDenials, { count: 1, reasonCodes: [code] }, code);
  }
  for (const code of ['workspace_write_failed', 'unexpected']) {
    const result = await single(toolFailed, { ...PROPOSAL, toolFailureCode: code });
    assert.equal(result.outcome.status, 'RUNNER_FAILURE', code);
    assert.equal(result.policyDenials.count, 0, code);
  }
});

test('agent outcomes map to the planned outcomes', async () => {
  const refused = await single(
    { to: 'FAILED', actor: 'agent', reasonCode: 'invalid_structured_output' },
    { agentOutcome: 'refusal', toolOperations: [], toolFailureCode: null, patch: NO_PATCH },
  );
  assert.equal(refused.outcome.status, 'FAIL');
  assert.equal(refused.outcome.publicStatus, 'FAIL');
  assert.equal(refused.outcome.oracleStatus, null);
  assert.equal(refused.toolCalls.total, 0);

  const unreachable = await single(
    { to: 'FAILED', actor: 'system', reasonCode: 'runner_failure' },
    { agentOutcome: 'error', toolOperations: [], toolFailureCode: null, patch: NO_PATCH },
  );
  assert.equal(unreachable.outcome.status, 'RUNNER_FAILURE');
  assert.equal(unreachable.outcome.runnerFailure, true);

  const none = await single('throw', { agentOutcome: 'none', toolOperations: [], toolFailureCode: null, patch: NO_PATCH });
  assert.equal(none.outcome.status, 'RUNNER_FAILURE');

  const proposalNoVerdict = await single(
    { to: 'FAILED', actor: 'system', reasonCode: 'workspace_integrity_violation' },
    { agentOutcome: 'proposal', toolOperations: ['apply_unified_diff', 'bogus', 7 as unknown as string], toolFailureCode: null, patch: NO_PATCH },
  );
  assert.equal(proposalNoVerdict.outcome.status, 'RUNNER_FAILURE');
  assert.equal(proposalNoVerdict.toolCalls.total, 1);
});

test('a missing, malformed, or unapproved request is rejected before any task is created', async () => {
  const harness = setup();
  const bad: [Record<string, unknown>, string][] = [
    [{ suiteId: SUITE_ID, repetitions: 1, runId: 'r1' }, 'approval_hash_invalid'],
    [{ suiteId: SUITE_ID, repetitions: 1, runId: 'r1', approvedReviewSetSha256: 'A'.repeat(64) }, 'approval_hash_invalid'],
    [{ suiteId: SUITE_ID, repetitions: 1, runId: 'r1', approvedReviewSetSha256: 'a'.repeat(63) }, 'approval_hash_invalid'],
    [{ suiteId: 'nope', repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH }, 'unknown_suite'],
    [{ suiteId: SUITE_ID, taskId: 'Z99', repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH }, 'unknown_task'],
    [{ suiteId: SUITE_ID, repetitions: 0, runId: 'r1', approvedReviewSetSha256: HASH }, 'invalid_repetitions'],
    [{ suiteId: SUITE_ID, repetitions: 101, runId: 'r1', approvedReviewSetSha256: HASH }, 'invalid_repetitions'],
    [{ suiteId: SUITE_ID, repetitions: 1.5, runId: 'r1', approvedReviewSetSha256: HASH }, 'invalid_repetitions'],
    [{ suiteId: SUITE_ID, repetitions: 1, runId: 'Bad Id', approvedReviewSetSha256: HASH }, 'invalid_run_id'],
  ];
  for (const [request, code] of bad) {
    await assert.rejects(
      harness.service.run(request as never),
      (error: unknown) => error instanceof BenchmarkServiceError && error.code === code,
      code,
    );
  }
  assert.deepEqual(harness.log, []);
  assert.deepEqual(harness.catalog.registered, []);
});

test('an envelope that asks for more than the write operation is refused before any task is created', async () => {
  const value = suite(['B01']);
  const widened: BenchmarkSuite = {
    suiteId: value.suiteId,
    tasks: [{ taskId: 'B01', envelopeInput: { ...envelopeInput(), requestedOperations: ['write', 'process'] } }],
  };
  const harness = setup({ catalog: fakeCatalog(widened) });
  await assert.rejects(
    harness.service.run({ suiteId: SUITE_ID, repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH }),
    (error: unknown) => error instanceof BenchmarkServiceError && error.code === 'unsupported_envelope',
  );
  assert.deepEqual(harness.log, []);
});

test('a sink failure stops the whole run without retrying the attempt', async () => {
  const harness = setup({ sink: fakeSink(1) });
  await assert.rejects(
    harness.service.run({ suiteId: SUITE_ID, repetitions: 2, runId: 'r1', approvedReviewSetSha256: HASH }),
    (error: unknown) => error instanceof BenchmarkServiceError && error.code === 'result_sink_failed',
  );
  assert.equal(harness.sink.written.length, 1);
  assert.deepEqual(harness.log.filter((entry) => entry.startsWith('create:')), ['create:b01-r1-1', 'create:b01-r1-2']);
});

test('a metrics failure does not change the result', async () => {
  const throwingFactory: RunMetricsCollectorFactoryPort = { create: () => { throw new Error('metrics'); } };
  const brokenCollector: RunMetricsCollectorFactoryPort = {
    create: () => ({
      start: () => { throw new Error('start'); },
      markFirstOutput: () => { throw new Error('mark'); },
      recordToolCall: () => { throw new Error('record'); },
      stop: () => Promise.reject(new Error('stop')),
      snapshot: () => { throw new Error('snapshot'); },
    }),
  };
  const baseline = setup();
  await baseline.service.run({ suiteId: SUITE_ID, taskId: 'B01', repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH });
  for (const metrics of [throwingFactory, brokenCollector]) {
    const harness = setup({ metrics });
    await harness.service.run({ suiteId: SUITE_ID, taskId: 'B01', repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH });
    assert.deepEqual(harness.sink.written[0].outcome, baseline.sink.written[0].outcome);
    assert.deepEqual(harness.sink.written[0].toolCalls, baseline.sink.written[0].toolCalls);
    assert.equal(harness.sink.written[0].metrics.cpu.status, 'unavailable');
  }
});

test('an observer that throws does not change an evaluator verdict', async () => {
  const throwing: BenchmarkAttemptObserverPort = {
    begin: () => { throw new Error('begin'); },
    finish: () => { throw new Error('finish'); },
  };
  const malformed: BenchmarkAttemptObserverPort = {
    begin: () => undefined,
    finish: () => ({ agentOutcome: 'weird' }) as unknown as BenchmarkAttemptObservation,
  };
  for (const terminal of [RESOLVED, { to: 'FAILED', actor: 'evaluator', reasonCode: 'oracle_fail' } as Terminal]) {
    const baseline = setup({ script: () => terminal });
    await baseline.service.run({ suiteId: SUITE_ID, taskId: 'B01', repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH });
    for (const observer of [throwing, malformed]) {
      const harness = setup({ script: () => terminal, observer });
      await harness.service.run({ suiteId: SUITE_ID, taskId: 'B01', repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH });
      assert.deepEqual(harness.sink.written[0].outcome, baseline.sink.written[0].outcome);
    }
  }
});

test('observed patch facts are copied into the written record', async () => {
  const facts = { changedFiles: 2, linesAdded: 7, linesRemoved: 3, sha256: 'c'.repeat(64) };
  const result = await single(RESOLVED, { ...PROPOSAL, patch: facts });
  assert.equal(result.changedFiles, 2);
  assert.deepEqual(result.patch, { linesAdded: 7, linesRemoved: 3, sha256: 'c'.repeat(64) });
  assert.equal(result.outcome.status, 'PASS');

  const noDiff = await single(RESOLVED, PROPOSAL);
  assert.equal(noDiff.changedFiles, 0);
  assert.deepEqual(noDiff.patch, { linesAdded: 0, linesRemoved: 0, sha256: null });
});

test('a throwing observer or a missing or malformed patch falls back to no diff', async () => {
  const zero = { linesAdded: 0, linesRemoved: 0, sha256: null };
  const throwing: BenchmarkAttemptObserverPort = {
    begin: () => undefined,
    finish: () => { throw new Error('finish'); },
  };
  const harness = setup({ observer: throwing });
  await harness.service.run({ suiteId: SUITE_ID, taskId: 'B01', repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH });
  assert.equal(harness.sink.written[0].changedFiles, 0);
  assert.deepEqual(harness.sink.written[0].patch, zero);

  const malformed: unknown[] = [
    undefined,
    null,
    'patch',
    { changedFiles: 1, linesAdded: 1, linesRemoved: 0, sha256: null },
    { changedFiles: 1, linesAdded: 1, linesRemoved: 0, sha256: 'C'.repeat(64) },
    { changedFiles: 1, linesAdded: 1, linesRemoved: 0, sha256: 'c'.repeat(63) },
    { changedFiles: -1, linesAdded: 1, linesRemoved: 0, sha256: 'c'.repeat(64) },
    { changedFiles: 1, linesAdded: 1.5, linesRemoved: 0, sha256: 'c'.repeat(64) },
    { changedFiles: 1, linesAdded: 1, linesRemoved: 20_000_000, sha256: 'c'.repeat(64) },
    { changedFiles: '1', linesAdded: 1, linesRemoved: 0, sha256: 'c'.repeat(64) },
  ];
  for (const patch of malformed) {
    const result = await single(RESOLVED, { ...PROPOSAL, patch } as unknown as BenchmarkAttemptObservation);
    assert.equal(result.outcome.status, 'PASS', JSON.stringify(patch));
    assert.equal(result.toolCalls.total, 1, JSON.stringify(patch));
    assert.equal(result.changedFiles, 0, JSON.stringify(patch));
    assert.deepEqual(result.patch, zero, JSON.stringify(patch));
  }
});

test('the observer brackets each attempt and the report counts only stored results', async () => {
  const observer = fakeObserver(() => PROPOSAL);
  let call = 0;
  const harness = setup({
    observer,
    script: () => {
      call += 1;
      return call === 1 ? RESOLVED : { to: 'FAILED', actor: 'evaluator', reasonCode: 'timeout' };
    },
  });
  await harness.service.run({ suiteId: SUITE_ID, taskId: 'B02', repetitions: 2, runId: 'r2', approvedReviewSetSha256: HASH });
  assert.deepEqual(observer.log, ['begin:b02-r2-1', 'finish:b02-r2-1', 'begin:b02-r2-2', 'finish:b02-r2-2']);
  const report = await harness.service.report('r2');
  assert.deepEqual(report.totals, { attempts: 2, resolved_hidden: 1, public_pass: 1, policy_clean: 2, timeout: 1, runner_failure: 0 });
  assert.deepEqual((await harness.service.report('other')).totals.attempts, 0);
  await assert.rejects(harness.service.report('Bad Id'), BenchmarkServiceError);
});

test('an omitted run ID comes from the ID port', async () => {
  const harness = setup();
  const summary = await harness.service.run({ suiteId: SUITE_ID, taskId: 'B01', repetitions: 1, approvedReviewSetSha256: HASH });
  assert.equal(summary.runId, 'gen1');
  assert.equal(summary.attempts[0].attemptTaskId, 'b01-gen1-1');
});

test('a taskIds subset is rejected when it is empty or names an unknown task', async () => {
  const harness = setup();
  for (const taskIds of [[], ['Z99'], ['B01', 'Z99'], ['B01', 'B01']]) {
    await assert.rejects(
      harness.service.run({ suiteId: SUITE_ID, taskIds, repetitions: 1, runId: 'r1', approvedReviewSetSha256: HASH } as never),
      (error: unknown) => error instanceof BenchmarkServiceError && error.code === 'unknown_task',
      JSON.stringify(taskIds),
    );
  }
  assert.deepEqual(harness.log, []);
});
