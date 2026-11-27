import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkspaceReference } from '../application/ports/index.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import {
  type EvaluateWorkspace,
  G0ModelWorkspaceEvaluator,
  type G0ModelWorkspaceEvaluatorOptions,
  MODEL_EVAL_TEMP_PREFIX,
  mapEvaluationDetail,
} from './g0-model-evaluator.ts';

const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ATTEMPT_ID = 'b01-run1-1';
const BENCHMARK_ID = 'B01';
const WORKSPACE: WorkspaceReference = Object.freeze({ workspaceId: 'ws-1' });
const ENVELOPE: TaskEnvelopeV1 = Object.freeze({
  schemaVersion: 1,
  taskId: ATTEMPT_ID,
  prompt: 'Fix it.',
  requestedOperations: Object.freeze(['write'] as const),
  allowedPaths: Object.freeze(['src/**']),
  declaredTests: Object.freeze([]),
  baseSnapshotSha256: 'a'.repeat(64),
});

async function withTempRoot(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'g0-model-eval-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function systemPrefixEntries(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(MODEL_EVAL_TEMP_PREFIX)).sort();
}

interface Recorder {
  exports: { workspace: WorkspaceReference; destination: string; entriesBefore: string[] }[];
  requests: { taskId: string; workspaceRoot: string; files: string[] }[];
}

function options(
  root: string,
  recorder: Recorder,
  detail: unknown | (() => Promise<unknown>),
  overrides: Partial<G0ModelWorkspaceEvaluatorOptions> = {},
): G0ModelWorkspaceEvaluatorOptions {
  const evaluateWorkspace: EvaluateWorkspace = async (request) => {
    recorder.requests.push({ ...request, files: await readdir(request.workspaceRoot) });
    return typeof detail === 'function' ? (detail as () => Promise<unknown>)() : detail;
  };
  return {
    exportWorkspace: async (workspace, destination) => {
      recorder.exports.push({ workspace, destination, entriesBefore: await readdir(destination) });
      await writeFile(path.join(destination, 'index.mjs'), 'export {};\n');
    },
    createEvaluator: async () => evaluateWorkspace,
    resolveBenchmarkTaskId: (taskId) => (taskId === ATTEMPT_ID ? BENCHMARK_ID : Promise.reject(new Error('unknown'))),
    tempRoot: root,
    ...overrides,
  };
}

const newRecorder = (): Recorder => ({ exports: [], requests: [] });

test('maps every evaluator status to a reason code that matches the task-service pattern', () => {
  const cases: [unknown, boolean, string][] = [
    [{ status: 'PASS', public_status: 'PASS', oracle_status: 'PASS' }, true, 'resolved_hidden'],
    [{ status: 'FAIL', public_status: 'PASS', oracle_status: 'FAIL' }, false, 'oracle_fail'],
    [{ public_status: 'PASS', oracle_status: 'TIMEOUT' }, false, 'oracle_fail'],
    [{ public_status: 'PASS', oracle_status: 'CRASH' }, false, 'oracle_fail'],
    [{ public_status: 'PASS', oracle_status: 'NOT_RUN' }, false, 'oracle_fail'],
    [{ public_status: 'PASS' }, false, 'oracle_fail'],
    [{ public_status: 'FAIL', oracle_status: 'NOT_RUN' }, false, 'public_fail'],
    [{ public_status: 'TIMEOUT', oracle_status: 'NOT_RUN' }, false, 'timeout'],
    [{ public_status: 'CRASH', oracle_status: 'NOT_RUN' }, false, 'crash'],
    [{ public_status: 'POLICY_VIOLATION', oracle_status: 'POLICY_VIOLATION' }, false, 'policy_violation'],
    [{ public_status: 'RUNNER_FAILURE', oracle_status: 'RUNNER_FAILURE' }, false, 'runner_failure'],
    [{ public_status: 'pass', oracle_status: 'PASS' }, false, 'runner_failure'],
    [{ status: 'PASS' }, false, 'runner_failure'],
    [{}, false, 'runner_failure'],
    [null, false, 'runner_failure'],
    [undefined, false, 'runner_failure'],
    ['PASS', false, 'runner_failure'],
  ];
  for (const [detail, passed, reasonCode] of cases) {
    const mapped = mapEvaluationDetail(detail);
    assert.deepEqual(mapped, { passed, reasonCode }, JSON.stringify(detail));
    assert.match(mapped.reasonCode, REASON_CODE_PATTERN);
    assert.ok(Object.isFrozen(mapped));
  }
});

test('evaluate exports into an empty workspace child of a fresh temp directory and passes the benchmark task ID', async (t) => {
  const root = await withTempRoot(t);
  const recorder = newRecorder();
  const evaluator = new G0ModelWorkspaceEvaluator(
    options(root, recorder, { status: 'PASS', public_status: 'PASS', oracle_status: 'PASS' }),
  );
  assert.deepEqual(await evaluator.evaluate({ envelope: ENVELOPE, workspace: WORKSPACE }), {
    passed: true,
    reasonCode: 'resolved_hidden',
  });
  assert.equal(recorder.exports.length, 1);
  const [exported] = recorder.exports;
  assert.equal(exported?.workspace, WORKSPACE);
  assert.deepEqual(exported?.entriesBefore, []);
  assert.ok(path.isAbsolute(exported?.destination ?? ''));
  assert.equal(path.basename(exported?.destination ?? ''), 'workspace');
  const parent = path.dirname(exported?.destination ?? '');
  assert.equal(path.dirname(parent), root);
  assert.ok(path.basename(parent).startsWith(MODEL_EVAL_TEMP_PREFIX));
  assert.deepEqual(recorder.requests, [
    { taskId: BENCHMARK_ID, workspaceRoot: exported?.destination, files: ['index.mjs'] },
  ]);
  assert.notEqual(recorder.requests[0]?.taskId, ATTEMPT_ID);
  await assert.rejects(stat(parent), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), []);
});

test('evaluate maps each detail result end to end', async (t) => {
  const root = await withTempRoot(t);
  for (const [publicStatus, oracleStatus, reasonCode] of [
    ['PASS', 'FAIL', 'oracle_fail'],
    ['FAIL', 'NOT_RUN', 'public_fail'],
    ['TIMEOUT', 'NOT_RUN', 'timeout'],
    ['CRASH', 'NOT_RUN', 'crash'],
    ['POLICY_VIOLATION', 'POLICY_VIOLATION', 'policy_violation'],
    ['RUNNER_FAILURE', 'RUNNER_FAILURE', 'runner_failure'],
  ] as const) {
    const evaluator = new G0ModelWorkspaceEvaluator(
      options(root, newRecorder(), { public_status: publicStatus, oracle_status: oracleStatus }),
    );
    assert.deepEqual(await evaluator.evaluate({ envelope: ENVELOPE, workspace: WORKSPACE }), {
      passed: false,
      reasonCode,
    });
  }
  assert.deepEqual(await readdir(root), []);
});

test('any thrown error returns runner_failure without error text and cleans up', async (t) => {
  const root = await withTempRoot(t);
  const secret = 'C:\\secret\\host\\path oracle-hash';
  const failures: Partial<G0ModelWorkspaceEvaluatorOptions>[] = [
    { exportWorkspace: async () => { throw new Error(secret); } },
    { createEvaluator: async () => { throw new Error(secret); } },
    { createEvaluator: async () => 'not a function' as never },
    { resolveBenchmarkTaskId: () => { throw new Error(secret); } },
    { resolveBenchmarkTaskId: () => '' },
  ];
  for (const override of failures) {
    const evaluator = new G0ModelWorkspaceEvaluator(options(root, newRecorder(), { public_status: 'PASS', oracle_status: 'PASS' }, override));
    const resultValue = await evaluator.evaluate({ envelope: ENVELOPE, workspace: WORKSPACE });
    assert.deepEqual(resultValue, { passed: false, reasonCode: 'runner_failure' });
    assert.ok(!JSON.stringify(resultValue).includes('secret'));
  }
  const rejecting = new G0ModelWorkspaceEvaluator(options(root, newRecorder(), async () => { throw new Error(secret); }));
  assert.deepEqual(await rejecting.evaluate({ envelope: ENVELOPE, workspace: WORKSPACE }), {
    passed: false,
    reasonCode: 'runner_failure',
  });
  const unknownTask = new G0ModelWorkspaceEvaluator(options(root, newRecorder(), { public_status: 'PASS', oracle_status: 'PASS' }));
  assert.deepEqual(await unknownTask.evaluate({ envelope: { ...ENVELOPE, taskId: 'other-run1-1' }, workspace: WORKSPACE }), {
    passed: false,
    reasonCode: 'runner_failure',
  });
  assert.deepEqual(await readdir(root), []);
});

test('the temp directory is removed after a failing evaluation that wrote into the copy', async (t) => {
  const root = await withTempRoot(t);
  const recorder = newRecorder();
  const evaluator = new G0ModelWorkspaceEvaluator(options(root, recorder, async () => {
    const destination = recorder.exports[0]?.destination ?? '';
    await writeFile(path.join(destination, 'extra.txt'), 'x');
    throw new Error('evaluation crashed');
  }));
  assert.deepEqual(await evaluator.evaluate({ envelope: ENVELOPE, workspace: WORKSPACE }), {
    passed: false,
    reasonCode: 'runner_failure',
  });
  assert.equal(recorder.exports.length, 1);
  assert.deepEqual(await readdir(root), []);
});

test('the default temp root is the system temp directory and leaves no prefixed directory behind', async () => {
  const before = await systemPrefixEntries();
  const recorder = newRecorder();
  const { tempRoot: _ignored, ...defaults } = options('unused', recorder, { public_status: 'FAIL', oracle_status: 'NOT_RUN' });
  const evaluator = new G0ModelWorkspaceEvaluator(defaults);
  assert.deepEqual(await evaluator.evaluate({ envelope: ENVELOPE, workspace: WORKSPACE }), {
    passed: false,
    reasonCode: 'public_fail',
  });
  const parent = path.dirname(recorder.exports[0]?.destination ?? '');
  assert.equal(path.dirname(parent), path.resolve(tmpdir()));
  assert.ok(path.basename(parent).startsWith(MODEL_EVAL_TEMP_PREFIX));
  await assert.rejects(stat(parent), { code: 'ENOENT' });
  assert.deepEqual(await systemPrefixEntries(), before);
});
