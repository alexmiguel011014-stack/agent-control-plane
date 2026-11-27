import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  AgentInvocationPort,
  AgentInvocationResult,
  BenchmarkCatalogPort,
  GeneratedCodeExecutionGatePort,
  RunMetricsCollectorFactoryPort,
  ToolExecutionPort,
} from '../application/ports/index.ts';
import type { EvaluateWorkspace } from '../adapters/g0-model-evaluator.ts';
import { createUnifiedDiff } from '../adapters/line-diff.ts';
import { BenchmarkCatalogError, type BenchmarkCatalogShape } from '../infra/benchmark-catalog.ts';
import type { LocalRunResultV1 } from '../infra/benchmark-result.ts';
import { ToolGatewayError } from '../tools/tool-gateway.ts';
import { WorkspacePatchError } from '../workspace/snapshot-manager.ts';
import {
  adaptBenchmarkCatalog,
  BenchmarkCompositionError,
  createBenchmarkApplication,
  createBenchmarkAttemptObservers,
  proposalPatchFacts,
  proposalToolOperations,
  toolFailureCodeOf,
} from './benchmark-cli.ts';

const APPROVED_HASH = 'a'.repeat(64);
const SUITE_ID = 'test-suite';
const TARGET = 'src/value.mjs';
const BEFORE = 'export function value() {\n  return 1;\n}\n';
const AFTER = 'export function value() {\n  return 2;\n}\n';
const DIFF = createUnifiedDiff(TARGET, BEFORE, AFTER);
const NO_METRICS: RunMetricsCollectorFactoryPort = { create: () => { throw new Error('metrics_disabled_in_tests'); } };

function fakeCatalog(snapshot: () => string): BenchmarkCatalogPort {
  const attempts = new Map<string, string>();
  return {
    listSuites: async () => [{ suiteId: SUITE_ID, taskIds: ['X01'] }],
    getSuite: async (suiteId) => (suiteId !== SUITE_ID ? null : {
      suiteId,
      tasks: [{
        taskId: 'X01',
        envelopeInput: {
          prompt: 'Make value return 2.',
          requestedOperations: ['write'],
          allowedPaths: [TARGET],
          declaredTests: [],
          baseSnapshotSha256: snapshot(),
        },
      }],
    }),
    registerAttempt: async ({ benchmarkTaskId, attemptTaskId }) => { attempts.set(attemptTaskId, benchmarkTaskId); },
    benchmarkTaskIdFor: (attemptTaskId) => attempts.get(attemptTaskId) ?? null,
  };
}

function proposal(diff: string = DIFF): AgentInvocationResult {
  return { kind: 'proposal', proposal: { proposalId: 'p1', toolRequests: [{ operation: 'apply_unified_diff', diff }] } };
}

interface Harness {
  readonly root: string;
  readonly app: Awaited<ReturnType<typeof createBenchmarkApplication>>;
  readonly workspaces: string[];
  readonly order: string[];
}

async function harness(
  t: TestContext,
  respond: () => Promise<AgentInvocationResult>,
  seams: { gate?: GeneratedCodeExecutionGatePort; evaluate?: EvaluateWorkspace } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-benchmark-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const base = join(root, 'fixture-base');
  await mkdir(join(base, 'src'), { recursive: true });
  await writeFile(join(base, TARGET), BEFORE, 'utf8');

  const workspaces: string[] = [];
  const order: string[] = [];
  const agent: AgentInvocationPort = {
    async invoke(input) {
      order.push('agent');
      workspaces.push(input.workspace.workspaceId);
      return respond();
    },
  };
  let snapshot = '';
  const gate = seams.gate;
  const app = await createBenchmarkApplication(
    { repositoryRoot: root, approvedReviewSetSha256: APPROVED_HASH, agentOverride: agent },
    {
      catalog: fakeCatalog(() => snapshot),
      metrics: NO_METRICS,
      ...(gate ? { generatedCodeGate: { isOpen: async () => { order.push('gate'); return gate.isOpen(); } } } : {}),
      createEvaluator: async () => {
        order.push('create_evaluator');
        return async (request) => {
          order.push('evaluate');
          if (!seams.evaluate) throw new Error('evaluator_not_expected');
          return seams.evaluate(request);
        };
      },
    },
  );
  snapshot = (await app.snapshots.createSnapshot({ sourceDirectory: base, confirmedDisposable: true })).snapshotSha256;
  return { root, app, workspaces, order };
}

async function runOnce(h: Harness, runId: string): Promise<LocalRunResultV1> {
  const summary = await h.app.benchmark.run({ suiteId: SUITE_ID, repetitions: 1, runId, approvedReviewSetSha256: APPROVED_HASH });
  assert.equal(summary.attempts.length, 1);
  assert.equal(summary.attempts[0]?.attemptTaskId, `x01-${runId}-1`);
  const file = join(h.root, 'bench', 'results', 'local', runId, 'x01-attempt-1.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

async function workspaceText(h: Harness): Promise<string> {
  assert.equal(h.workspaces.length, 1);
  return readFile(join(h.root, '.agentctl', 'benchmark', 'workspaces', h.workspaces[0] as string, TARGET), 'utf8');
}

test('createBenchmarkApplication refuses a malformed hash and a relative root before touching the filesystem', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agentctl-benchmark-refuse-'));
  try {
    const root = join(parent, 'missing-root');
    for (const hash of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), undefined]) {
      await assert.rejects(
        createBenchmarkApplication({ repositoryRoot: root, approvedReviewSetSha256: hash as string }),
        (error: unknown) => error instanceof BenchmarkCompositionError && error.code === 'approval_hash_invalid',
      );
    }
    for (const repositoryRoot of ['relative/root', '.', '', 'C:relative']) {
      await assert.rejects(
        createBenchmarkApplication({ repositoryRoot, approvedReviewSetSha256: APPROVED_HASH }),
        (error: unknown) => error instanceof BenchmarkCompositionError && error.code === 'repository_root_invalid',
      );
    }
    await assert.rejects(stat(root), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('a review-set hash the evaluator factory rejects stops the composition before any agent call or state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-benchmark-approval-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  let agentCalls = 0;
  const agent: AgentInvocationPort = { invoke: async () => { agentCalls += 1; return proposal(); } };
  const seams = [
    async () => { throw new Error('review set mismatch: secret path C:\\owner\\file'); },
    async () => 'not a function' as unknown as EvaluateWorkspace,
  ];
  for (const createEvaluator of seams) {
    await assert.rejects(
      createBenchmarkApplication(
        { repositoryRoot: root, approvedReviewSetSha256: APPROVED_HASH, agentOverride: agent },
        { catalog: fakeCatalog(() => ''), metrics: NO_METRICS, createEvaluator },
      ),
      (error: unknown) => error instanceof BenchmarkCompositionError
        && error.code === 'approval_hash_invalid'
        && error.message === 'approval_hash_invalid',
    );
  }
  assert.equal(agentCalls, 0);
  await assert.rejects(stat(join(root, '.agentctl')), { code: 'ENOENT' });
});

test('agentFactory is refused with agentOverride or when it is not a function', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-benchmark-factory-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const agent: AgentInvocationPort = { invoke: async () => proposal() };
  const seams = { catalog: fakeCatalog(() => ''), metrics: NO_METRICS, createEvaluator: async () => (async () => { throw new Error('unused'); }) as EvaluateWorkspace };
  const bad = [
    { agentOverride: agent, agentFactory: () => agent },
    { agentFactory: 'nope' as unknown as () => AgentInvocationPort },
  ];
  for (const extra of bad) {
    await assert.rejects(
      createBenchmarkApplication({ repositoryRoot: root, approvedReviewSetSha256: APPROVED_HASH, ...extra }, seams),
      (error: unknown) => error instanceof BenchmarkCompositionError && error.code === 'agent_override_invalid',
    );
  }
});

test('agentFactory receives a callable contextReader and its result is the agent used', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-benchmark-factory-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const base = join(root, 'fixture-base');
  await mkdir(join(base, 'src'), { recursive: true });
  await writeFile(join(base, TARGET), BEFORE, 'utf8');
  let reader: unknown;
  let calls = 0;
  let snapshot = '';
  const app = await createBenchmarkApplication(
    {
      repositoryRoot: root,
      approvedReviewSetSha256: APPROVED_HASH,
      agentFactory: (tools) => {
        reader = tools.contextReader;
        return { invoke: async () => { calls += 1; return { kind: 'refusal', reasonCode: 'no_change_proposed' }; } };
      },
    },
    {
      catalog: fakeCatalog(() => snapshot),
      metrics: NO_METRICS,
      createEvaluator: async () => (async () => { throw new Error('evaluator_not_expected'); }) as EvaluateWorkspace,
    },
  );
  assert.equal(typeof reader, 'function');
  snapshot = (await app.snapshots.createSnapshot({ sourceDirectory: base, confirmedDisposable: true })).snapshotSha256;
  await app.benchmark.run({ suiteId: SUITE_ID, repetitions: 1, runId: 'fac1', approvedReviewSetSha256: APPROVED_HASH });
  assert.equal(calls, 1);
});

async function treeDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const entries = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of entries) hash.update(file).update('\0').update(await readFile(file)).update('\0');
  return hash.digest('hex');
}

test('read-only mode appends no events, never evaluates, never calls the agent, and refuses run', async (t) => {
  let entered!: () => void;
  const agentEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: (result: AgentInvocationResult) => void;
  const h = await harness(t, () => {
    entered();
    return new Promise<AgentInvocationResult>((resolve) => { release = resolve; });
  });
  const running = h.app.benchmark.run({ suiteId: SUITE_ID, repetitions: 1, runId: 'ro1', approvedReviewSetSha256: APPROVED_HASH });
  await agentEntered;
  const taskId = 'x01-ro1-1';
  assert.equal((await h.app.tasks.getTaskStatus(taskId)).state, 'RUNNING');
  const eventsDirectory = join(h.root, '.agentctl', 'benchmark', 'events');
  const before = await treeDigest(eventsDirectory);

  let evaluatorCalls = 0;
  let agentCalls = 0;
  const readOnly = await createBenchmarkApplication(
    {
      repositoryRoot: h.root,
      approvedReviewSetSha256: '0'.repeat(64),
      readOnly: true,
      agentOverride: { invoke: async () => { agentCalls += 1; return { kind: 'refusal' }; } },
    },
    {
      catalog: fakeCatalog(() => ''),
      metrics: NO_METRICS,
      createEvaluator: async () => { evaluatorCalls += 1; throw new Error('must_not_be_called'); },
    },
  );
  assert.deepEqual(readOnly.startup, { state: 'ready' });
  assert.equal((await readOnly.benchmark.list()).length, 1);
  assert.equal((await readOnly.benchmark.report('ro1')).totals.attempts, 0);
  await assert.rejects(
    readOnly.benchmark.run({ suiteId: SUITE_ID, repetitions: 1, runId: 'ro2', approvedReviewSetSha256: APPROVED_HASH }),
    (error: unknown) => error instanceof BenchmarkCompositionError && error.code === 'read_only',
  );
  assert.equal(evaluatorCalls, 0);
  assert.equal(agentCalls, 0);
  // No INTERRUPTED event: the in-flight attempt is untouched.
  assert.equal(await treeDigest(eventsDirectory), before);
  assert.equal((await readOnly.tasks.getTaskStatus(taskId)).state, 'RUNNING');

  release({ kind: 'refusal', reasonCode: 'no_change_proposed' });
  await running;
});

test('a closed attestation gate makes apply_unified_diff fail with g2_isolation_required and leaves the workspace unchanged', async (t) => {
  // No gate seam: the real AttestationGeneratedCodeGate reads a temp repository root that has no attestation.
  const h = await harness(t, async () => proposal());
  const result = await runOnce(h, 'closed1');
  assert.deepEqual(h.order, ['create_evaluator', 'agent']);
  assert.equal(result.outcome.status, 'POLICY_VIOLATION');
  assert.deepEqual(result.policyDenials, { count: 1, reasonCodes: ['g2_isolation_required'] });
  assert.equal(result.toolCalls.byOperation.apply_unified_diff, 1);
  assert.equal(await workspaceText(h), BEFORE);
});

test('wiring order: the override agent, then the gate, then the evaluator on an exported copy; patch facts recorded', async (t) => {
  const seen: { taskId?: string; text?: string } = {};
  const h = await harness(t, async () => proposal(), {
    gate: { isOpen: async () => true },
    evaluate: async (request) => {
      seen.taskId = request.taskId;
      seen.text = await readFile(join(request.workspaceRoot, TARGET), 'utf8');
      return { public_status: 'PASS', oracle_status: 'PASS' };
    },
  });
  const result = await runOnce(h, 'wired1');
  // Upfront approval check at composition, then a fresh evaluator per attempt as the re-check.
  assert.deepEqual(h.order, ['create_evaluator', 'agent', 'gate', 'create_evaluator', 'evaluate']);
  assert.equal(seen.taskId, 'X01');
  assert.equal(seen.text, AFTER);
  assert.equal(await workspaceText(h), AFTER);
  assert.equal(result.changedFiles, 1);
  assert.deepEqual(result.patch, {
    linesAdded: 1,
    linesRemoved: 1,
    sha256: createHash('sha256').update(DIFF, 'utf8').digest('hex'),
  });
  assert.equal(result.toolCalls.total, 1);
  assert.deepEqual(result.seed, { capable: true, value: null });
  assert.equal(result.model.tag, 'qwen2.5-coder:1.5b');
  assert.equal(result.policyDenials.count, 0);
  assert.equal(result.outcome.status, 'PASS');
  const report = await h.app.benchmark.report('wired1');
  assert.equal(report.totals.attempts, 1);
});

test('an unparseable proposal records no operations and is a public FAIL', async (t) => {
  const h = await harness(t, async () => ({ kind: 'proposal', proposal: { proposalId: 1, toolRequests: 'nope' } }), {
    gate: { isOpen: async () => true },
  });
  const result = await runOnce(h, 'garbage1');
  assert.deepEqual(h.order, ['create_evaluator', 'agent']);
  assert.equal(result.toolCalls.total, 0);
  assert.equal(result.outcome.publicStatus, 'FAIL');
  assert.equal(result.patch.sha256, null);
  assert.equal(await workspaceText(h), BEFORE);
});

test('a refusal is recorded as a public FAIL with no oracle verdict', async (t) => {
  const h = await harness(t, async () => ({ kind: 'refusal', reasonCode: 'no_change_proposed' }));
  const result = await runOnce(h, 'refusal1');
  assert.equal(result.outcome.status, 'FAIL');
  assert.equal(result.outcome.publicStatus, 'FAIL');
  assert.equal(result.outcome.oracleStatus, null);
  assert.equal(result.toolCalls.total, 0);
});

test('an agent error is a runner failure', async (t) => {
  const h = await harness(t, async () => { throw new Error('runtime_unavailable'); });
  const result = await runOnce(h, 'error1');
  assert.equal(result.outcome.status, 'RUNNER_FAILURE');
});

test('observers record agent outcomes, tool failure codes, and nothing for attempts that did not begin', async () => {
  const observers = createBenchmarkAttemptObservers();
  const envelope = { taskId: 'x01-run-1' } as never;
  const workspace = { workspaceId: 'w' };
  const failing = (error: unknown): ToolExecutionPort => ({ execute: async () => { throw error; } });

  observers.begin('x01-run-1');
  const thrown = new Error('secret text that must not be kept');
  await assert.rejects(observers.wrapAgent({ invoke: async () => { throw thrown; } }).invoke({ envelope, workspace }), (e) => e === thrown);
  assert.deepEqual(observers.finish('x01-run-1'), {
    agentOutcome: 'error', toolOperations: [], toolFailureCode: null,
    patch: { changedFiles: 0, linesAdded: 0, linesRemoved: 0, sha256: null },
  });

  observers.begin('x01-run-1');
  await observers.wrapAgent({ invoke: async () => ({ kind: 'refusal' }) }).invoke({ envelope, workspace });
  assert.equal(observers.finish('x01-run-1').agentOutcome, 'refusal');

  for (const [error, code] of [
    [new ToolGatewayError('g2_isolation_required'), 'g2_isolation_required'],
    [new ToolGatewayError('invalid_tool_request'), 'invalid_tool_request'],
    [new WorkspacePatchError('hunk_mismatch'), 'hunk_mismatch'],
    [new WorkspacePatchError('path_denied'), 'tool_policy_denied'],
    [new WorkspacePatchError('target_exists'), 'tool_error'],
    [new WorkspacePatchError('invalid_plan'), 'tool_error'],
    [new WorkspacePatchError('write_failed'), 'tool_error'],
    [new Error('anything else'), 'tool_error'],
  ] as const) {
    observers.begin('x01-run-1');
    const tools = observers.wrapTools(failing(error));
    await assert.rejects(tools.execute({ envelope, envelopeSha256: 'h', workspace, proposal: 'not a proposal' }));
    const observation = observers.finish('x01-run-1');
    assert.equal(observation.toolFailureCode, code);
    assert.deepEqual(observation.toolOperations, []);
    assert.equal(toolFailureCodeOf(error), code);
  }

  // Not begun: nothing recorded, and finish returns an empty observation.
  await assert.rejects(observers.wrapTools(failing(new Error('x'))).execute({ envelope, envelopeSha256: 'h', workspace, proposal: {} }));
  assert.equal(observers.finish('x01-run-1').toolFailureCode, null);
});

test('proposal facts are parsed defensively', () => {
  const valid = { proposalId: 'p', toolRequests: [{ operation: 'apply_unified_diff', diff: DIFF }, { operation: 'read_text', path: TARGET }] };
  assert.deepEqual(proposalToolOperations(valid), ['apply_unified_diff', 'read_text']);
  assert.deepEqual(proposalPatchFacts(valid), {
    changedFiles: 1, linesAdded: 1, linesRemoved: 1, sha256: createHash('sha256').update(DIFF, 'utf8').digest('hex'),
  });
  const twoFiles = createUnifiedDiff('src/a.mjs', '-- old\n','--- not a header\nb\n') + createUnifiedDiff('src/b.mjs', 'x\ny\n', 'x\n');
  assert.deepEqual(
    { ...proposalPatchFacts({ proposalId: 'p', toolRequests: [{ operation: 'apply_unified_diff', diff: twoFiles }] }), sha256: null },
    { changedFiles: 2, linesAdded: 2, linesRemoved: 2, sha256: null },
  );
  for (const unknown of [
    null, 'text', [], { toolRequests: 'x' }, { toolRequests: [null] }, { toolRequests: [{ operation: 'shell' }] },
    { toolRequests: [new Map()] }, Object.create({ toolRequests: [] }),
  ]) {
    assert.deepEqual(proposalToolOperations(unknown), []);
    assert.equal(proposalPatchFacts(unknown).sha256, null);
  }
  assert.equal(proposalPatchFacts({ toolRequests: [{ operation: 'apply_unified_diff', diff: '@@ broken @@\n+x\n' }] }).sha256, null);
  assert.equal(proposalPatchFacts({ toolRequests: [{ operation: 'list_files' }] }).sha256, null);
});

test('the catalog adapter maps throwing methods to the port shapes', async () => {
  const registered: string[][] = [];
  const shape: BenchmarkCatalogShape = {
    listSuites: async () => [{ suiteId: 'suite', taskIds: ['B01'] }],
    getSuite: async (suiteId) => {
      if (suiteId !== 'suite') throw new BenchmarkCatalogError('unknown_suite');
      return {
        suiteId,
        tasks: [{
          benchmarkTaskId: 'B01',
          envelopeInput: {
            schemaVersion: 1, prompt: 'p', requestedOperations: ['write'], allowedPaths: ['a.mjs'], declaredTests: [], baseSnapshotSha256: 'b'.repeat(64),
          },
        }],
      };
    },
    registerAttempt: (attemptTaskId, benchmarkTaskId) => {
      if (benchmarkTaskId !== 'B01') throw new BenchmarkCatalogError('unknown_task');
      registered.push([attemptTaskId, benchmarkTaskId]);
    },
    benchmarkTaskIdFor: (attemptTaskId) => {
      if (attemptTaskId !== 'b01-r-1') throw new BenchmarkCatalogError('unknown_attempt');
      return 'B01';
    },
  };
  const port = adaptBenchmarkCatalog(shape);
  assert.equal(await port.getSuite('other'), null);
  const suite = await port.getSuite('suite');
  assert.deepEqual(suite?.tasks.map((task) => [task.taskId, task.envelopeInput.requestedOperations]), [['B01', ['write']]]);
  await port.registerAttempt({ suiteId: 'suite', benchmarkTaskId: 'B01', attemptTaskId: 'b01-r-1' });
  assert.deepEqual(registered, [['b01-r-1', 'B01']]);
  await assert.rejects(port.registerAttempt({ suiteId: 'suite', benchmarkTaskId: 'B02', attemptTaskId: 'b02-r-1' }));
  await assert.rejects(port.registerAttempt({ suiteId: 'other', benchmarkTaskId: 'B01', attemptTaskId: 'b01-r-2' }));
  assert.equal(port.benchmarkTaskIdFor('b01-r-1'), 'B01');
  assert.equal(port.benchmarkTaskIdFor('unknown'), null);
});
