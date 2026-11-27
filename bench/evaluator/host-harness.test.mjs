import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeValue, MAX_CALLS } from '../isolation/protocol.mjs';
import { runHostCases } from './host-harness.mjs';

function success(call, value, sameAsArgs = call.args.map(() => false), argsAfter = call.args) {
  return { callId: call.callId, ok: true, value, sameAsArgs, argsAfter };
}

function harnessCase(overrides = {}) {
  return {
    id: 'case-1',
    operationId: 'call',
    args: [2],
    expected: { ok: true, value: 3 },
    ...overrides,
  };
}

test('sends only registered call data and keeps host expectations out of worker requests', async () => {
  let received;
  const result = await runHostCases({
    cases: [harnessCase({ expected: { ok: true, value: { value: 3 }, valueProjection: { kind: 'json-parse' } } })],
    taskId: 'P01',
    workspaceRoot: 'C:\\tmp\\workspace',
    timeoutMs: 1000,
    workerRunner: async ({ calls }) => {
      received = calls;
      assert.deepEqual(Object.keys(calls[0]).sort(), ['args', 'callId', 'operationId']);
      assert.equal(Object.hasOwn(calls[0], 'expected'), false);
      assert.equal(Object.hasOwn(calls[0], 'valueProjection'), false);
      return { results: [success(calls[0], '{"value":3}') ] };
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.caseCount, 1);
  assert.equal(received[0].operationId, 'call');
});

test('applies fixed JSON, property, and path projections on the host', async () => {
  const cases = [
    harnessCase({ id: 'json', args: [], expected: { ok: true, value: { ready: true }, valueProjection: { kind: 'json-parse' } } }),
    harnessCase({ id: 'property', args: [], expected: { ok: true, value: ['a', 'b'], valueProjection: { kind: 'map-property', property: 'id' } } }),
    harnessCase({ id: 'path', args: [], expected: { ok: true, value: { status: 'ok' }, valueProjection: { kind: 'path', path: ['result', 'data'] } } }),
  ];

  const result = await runHostCases({
    cases, taskId: 'P01', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => ({ results: [
      success(calls[0], '{"ready":true}'),
      success(calls[1], [{ id: 'a' }, { id: 'b' }]),
      success(calls[2], { result: { data: { status: 'ok' } } }),
    ] }),
  });

  assert.equal(result.passed, true);
  assert.equal(result.caseCount, 3);
});

test('checks mutation and returned-reference identity without importing candidate modules', async () => {
  const before = new Map([['a', 1], ['b', 2]]);
  const after = new Map([['b', 2]]);
  const result = await runHostCases({
    cases: [harnessCase({
      args: [before, 'a'],
      expected: { ok: true, value: true },
      expectedArgsAfter: [after, 'a'],
      expectedDistinctFromArgs: [0],
    })],
    taskId: 'B05', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => ({ results: [success(calls[0], true, [false, false], [after, 'a'])] }),
  });

  assert.equal(result.passed, true);
});

test('matches declared errors by name and optional message', async () => {
  const result = await runHostCases({
    cases: [harnessCase({ args: ['bad'], expected: { ok: false, error: { name: 'TypeError', instanceOf: 'TypeError' } } })],
    taskId: 'I02', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => ({ results: [{
      callId: calls[0].callId,
      ok: false,
      error: new TypeError('invalid input'),
      argsAfter: calls[0].args,
    }] }),
  });

  assert.equal(result.passed, true);
});

test('does not constrain argument state when the host case declares no mutation assertion', async () => {
  const result = await runHostCases({
    cases: [harnessCase({ args: [{ status: 'before' }], expected: { ok: true, value: 'done' } })],
    taskId: 'P01', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => ({ results: [success(calls[0], 'done', [false], [{ status: 'changed' }])] }),
  });

  assert.equal(result.passed, true);
});

test('checks only declared paths in argument-state projections', async () => {
  const result = await runHostCases({
    cases: [harnessCase({
      args: [{ stable: { id: 'same' }, incidental: 'before' }],
      expected: { ok: true },
      expectedArgsAfterProjections: [{ index: 0, path: ['stable', 'id'], value: 'same' }],
    })],
    taskId: 'P01', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => ({ results: [success(
      calls[0], undefined, [false], [{ stable: { id: 'same' }, incidental: 'changed' }],
    )] }),
  });

  assert.equal(result.passed, true);
});

test('rejects a mismatch in a declared argument-state projection', async () => {
  const result = await runHostCases({
    cases: [harnessCase({
      args: [{ stable: { id: 'same' } }],
      expected: { ok: true },
      expectedArgsAfterProjections: [{ index: 0, path: ['stable', 'id'], value: 'same' }],
    })],
    taskId: 'P01', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => ({ results: [success(calls[0], undefined, [false], [{ stable: { id: 'changed' } }])] }),
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [{ caseId: 'case-1', code: 'argument_projection_mismatch' }]);
});

test('supports only allowlisted built-in Error instance assertions', async () => {
  const result = await runHostCases({
    cases: [harnessCase({ args: ['bad'], expected: { ok: false, error: { instanceOf: 'Error' } } })],
    taskId: 'P01', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => ({ results: [{
      callId: calls[0].callId,
      ok: false,
      error: new Error('failed'),
      argsAfter: calls[0].args,
    }] }),
  });

  assert.equal(result.passed, true);
  await assert.rejects(runHostCases({
    cases: [harnessCase({ expected: { ok: false, error: { instanceOf: 'RangeError' } } })],
    taskId: 'P01', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async () => ({ results: [] }),
  }), /invalid or duplicate cases/);
});

test('materializes only the fixed no-op function fixture', async () => {
  const result = await runHostCases({
    cases: [harnessCase({ args: [{ $fixture: 'noop-function-v1' }], expected: { ok: true } })],
    taskId: 'I06', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => {
      assert.equal(typeof calls[0].args[0], 'function');
      assert.equal(calls[0].args[0](), undefined);
      assert.deepEqual(encodeValue(calls[0].args), ['array', 0, [['noop-function', 1]]]);
      return { results: [success(calls[0], undefined)] };
    },
  });

  assert.equal(result.passed, true);
});

test('batches suites at the protocol call limit', async () => {
  let batchCount = 0;
  const cases = Array.from({ length: MAX_CALLS + 1 }, (_, index) => harnessCase({
    id: `case-${index}`,
    args: [],
    expected: { ok: true },
  }));
  const result = await runHostCases({
    cases, taskId: 'P01', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => {
      batchCount += 1;
      assert.ok(calls.length <= MAX_CALLS);
      return { results: calls.map((call) => success(call, undefined)) };
    },
  });

  assert.equal(batchCount, 2);
  assert.equal(result.caseCount, MAX_CALLS + 1);
  assert.equal(result.passed, true);
});

test('rejects invalid or duplicate host cases before invoking the worker', async () => {
  let invoked = false;
  const input = harnessCase();
  await assert.rejects(runHostCases({
    cases: [input, input], taskId: 'P01', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async () => { invoked = true; return { results: [] }; },
  }), /invalid or duplicate cases/);
  assert.equal(invoked, false);
});

test('reports a fixed projection failure without exposing worker output', async () => {
  const result = await runHostCases({
    cases: [harnessCase({ expected: { ok: true, value: [], valueProjection: { kind: 'map-property', property: 'id' } } })],
    taskId: 'P03', workspaceRoot: 'C:\\tmp\\workspace', timeoutMs: 1000,
    workerRunner: async ({ calls }) => ({ results: [success(calls[0], 'not-an-array')] }),
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [{ caseId: 'case-1', code: 'projection_type_mismatch' }]);
  assert.equal(Object.hasOwn(result.failures[0], 'actual'), false);
});
