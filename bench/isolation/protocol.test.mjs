import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ARRAY_ITEMS,
  MAX_CALLS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_STRING_BYTES,
  MAX_VALUE_NODES,
  WORKER_PROTOCOL_VERSION,
  WorkerProtocolError,
  createNoopFunctionFixture,
  createWorkerRequest,
  createWorkerResponse,
  decodeValue,
  encodeValue,
  isUnserializableWorkerValue,
  parseWorkerRequest,
  parseWorkerResponse,
  serializeWorkerRequest,
  serializeWorkerResponse,
} from './protocol.mjs';
import { getTaskOperation, isRegisteredTaskId, TASK_OPERATION_REGISTRY } from './task-operations.mjs';

function assertProtocolCode(action, code) {
  assert.throws(action, (error) => error instanceof WorkerProtocolError && error.code === code);
}

test('tagged values preserve undefined, special numbers, maps, errors, and cyclic references', () => {
  const shared = { value: undefined };
  const input = {
    undefinedValue: undefined,
    numbers: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
    map: new Map([[undefined, shared], ['self', null]]),
    shared,
  };
  input.self = input;
  input.map.set('self', input.map);
  const error = new Error('private detail');
  error.name = 'AppError';
  error.code = 'NOT_FOUND';
  error.status = 404;
  input.error = error;

  const decoded = decodeValue(encodeValue(input), {
    errorConstructors: {
      AppError: ({ message, properties }) => {
        const appError = new Error(message);
        appError.code = properties.code;
        appError.status = properties.status;
        return appError;
      },
    },
    rejectUnknownErrorKinds: true,
  });

  assert.equal(decoded.undefinedValue, undefined);
  assert.ok(Number.isNaN(decoded.numbers[0]));
  assert.equal(decoded.numbers[1], Number.POSITIVE_INFINITY);
  assert.equal(decoded.numbers[2], Number.NEGATIVE_INFINITY);
  assert.ok(Object.is(decoded.numbers[3], -0));
  assert.equal(decoded.self, decoded);
  assert.equal(decoded.shared, decoded.map.get(undefined));
  assert.equal(decoded.map.get('self'), decoded.map);
  assert.ok(decoded.error instanceof Error);
  assert.equal(decoded.error.name, 'AppError');
  assert.equal(decoded.error.code, 'NOT_FOUND');
  assert.equal(decoded.error.status, 404);
  assert.equal(decoded.error.stack.includes('private detail'), true);
});

test('null-prototype objects retain their prototype and graph references', () => {
  const input = Object.create(null);
  const nested = Object.create(null);
  input.self = input;
  input.nested = nested;
  input.plain = { value: 1 };
  nested.parent = input;

  const decoded = decodeValue(encodeValue(input));

  assert.equal(Object.getPrototypeOf(decoded), null);
  assert.equal(Object.getPrototypeOf(decoded.nested), null);
  assert.equal(Object.getPrototypeOf(decoded.plain), Object.prototype);
  assert.equal(decoded.self, decoded);
  assert.equal(decoded.nested.parent, decoded);
});

test('frozen plain objects retain shallow freeze and cyclic references across the wire', () => {
  const nested = { value: 1 };
  const input = { nested };
  input.self = input;
  Object.freeze(input);

  const encoded = encodeValue(input);
  assert.equal(encoded[0], 'frozen-object');
  const decoded = decodeValue(encoded);

  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(decoded.self, decoded);
  assert.equal(Object.isFrozen(decoded.nested), false);
  assert.throws(() => { decoded.nested = {}; }, TypeError);
});

test('error decoding rejects a custom kind without a fixed constructor', () => {
  const error = new Error('record missing');
  error.name = 'AppError';
  error.code = 'NOT_FOUND';
  assertProtocolCode(() => decodeValue(encodeValue(error), { rejectUnknownErrorKinds: true }), 'unknown_error_kind');
});

test('cyclic Error-property graphs are rejected before they reach the wire', () => {
  const error = new Error('cycle');
  const nested = { parent: error };
  error.details = nested;

  assertProtocolCode(() => encodeValue(error), 'cyclic_error_properties');
});

test('no-op function fixtures round-trip with graph identity while arbitrary functions are rejected', () => {
  const noop = createNoopFunctionFixture();
  const other = createNoopFunctionFixture();
  const decoded = decodeValue(encodeValue({ first: noop, second: noop, other }));

  assert.equal(decoded.first, decoded.second);
  assert.notEqual(decoded.first, decoded.other);
  assert.equal(decoded.first(), undefined);
  assertProtocolCode(() => encodeValue(() => undefined), 'unsupported_value');
});

test('error constructor lookup ignores inherited prototype properties', () => {
  for (const name of ['constructor', 'toString', 'prototype']) {
    const error = new Error('untrusted error kind');
    error.name = name;
    assertProtocolCode(() => decodeValue(encodeValue(error), { rejectUnknownErrorKinds: true }), 'unknown_error_kind');
  }
});

test('fixed operation registry covers every benchmark task without test expectations', () => {
  const expectedTaskIds = [
    'P01', 'P02', 'P03', 'P04', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06',
    ...Array.from({ length: 30 }, (_, index) => `I${String(index + 1).padStart(2, '0')}`), 'S01', 'S02', 'S03', 'S04',
  ];
  assert.deepEqual(Object.keys(TASK_OPERATION_REGISTRY), expectedTaskIds);
  assert.ok(expectedTaskIds.every(isRegisteredTaskId));
  assert.deepEqual(getTaskOperation('P01', 'call'), {
    kind: 'call', modulePath: 'src/range.mjs', exportName: 'isWithinRange',
  });
  assert.deepEqual(getTaskOperation('I04', 'call').errorConstructors.AppError, {
    modulePath: 'src/app-error.mjs',
    exportName: 'AppError',
    argumentOrder: ['code', 'message', 'status'],
  });
  assert.equal(getTaskOperation('I05', 'read-defaults').kind, 'read-export');
  assert.equal(getTaskOperation('I05', 'read-runtime-config').modulePath, 'src/config.mjs');
  assert.equal(getTaskOperation('B05', 'call').mutatedArgumentIndexes[0], 0);
  assert.doesNotMatch(JSON.stringify(TASK_OPERATION_REGISTRY), /expected|oracle|public[-_ ]?test/i);
  for (const operations of Object.values(TASK_OPERATION_REGISTRY)) {
    for (const spec of Object.values(operations)) {
      assert.match(spec.modulePath, /^src\/[A-Za-z0-9._/-]+\.mjs$/);
      assert.equal(spec.modulePath.includes('..'), false);
      assert.doesNotMatch(spec.modulePath, /^[A-Za-z]:|^\//);
    }
  }
});

test('request builder emits only fixed task operations and encoded arguments', () => {
  const request = createWorkerRequest({
    taskId: 'B02',
    requestId: 'request-1',
    calls: [{ callId: 'limit-0', operationId: 'call', args: [{ limit: undefined }, 6] }],
  });
  const wire = serializeWorkerRequest(request);
  const parsed = parseWorkerRequest(wire);

  assert.deepEqual(Object.keys(parsed).sort(), ['calls', 'requestId', 'schemaVersion', 'taskId']);
  assert.deepEqual(Object.keys(parsed.calls[0]).sort(), ['args', 'callId', 'operationId']);
  assert.equal(parsed.calls[0].operationId, 'call');
  assert.deepEqual(decodeValue(parsed.calls[0].args), [{ limit: undefined }, 6]);
  assert.doesNotMatch(wire, /expected|oracle|modulePath|exportName|command/);
});

test('request builder and parser reject arbitrary expected values, paths, and commands', () => {
  assertProtocolCode(() => createWorkerRequest({
    taskId: 'P01',
    requestId: 'request-2',
    expected: true,
    calls: [{ operationId: 'call', args: [1, 0, 2] }],
  }), 'invalid_request');

  const request = createWorkerRequest({
    taskId: 'P01', requestId: 'request-3',
    calls: [{ operationId: 'call', args: [1, 0, 2] }],
  });
  const hostile = JSON.parse(serializeWorkerRequest(request));
  hostile.calls[0].path = 'C:/private/oracle.mjs';
  hostile.command = 'powershell';
  assertProtocolCode(() => parseWorkerRequest(JSON.stringify(hostile)), 'invalid_request');

  const sentinelInput = JSON.parse(serializeWorkerRequest(request));
  sentinelInput.calls[0].args = ['array', 0, [['unserializable', 'function']]];
  assertProtocolCode(() => parseWorkerRequest(JSON.stringify(sentinelInput)), 'invalid_value');

  const symbolInput = { visible: true };
  Object.defineProperty(symbolInput, Symbol('hidden'), { value: 'sentinel', enumerable: true });
  assertProtocolCode(() => encodeValue(symbolInput), 'unsupported_value');
});

test('unknown tasks and operations are rejected by the fixed registry', () => {
  assertProtocolCode(() => createWorkerRequest({
    taskId: 'X99', requestId: 'request-4', calls: [{ operationId: 'call', args: [] }],
  }), 'unknown_task');
  assertProtocolCode(() => createWorkerRequest({
    taskId: 'P01', requestId: 'request-5', calls: [{ operationId: 'import-anything', args: [] }],
  }), 'unknown_operation');
});

test('prototype-chain task and operation names are not registry entries', () => {
  for (const taskId of ['constructor', 'toString', 'prototype']) {
    assert.equal(isRegisteredTaskId(taskId), false);
    assertProtocolCode(() => createWorkerRequest({
      taskId,
      requestId: `task-${taskId}`,
      calls: [{ operationId: 'call', args: [] }],
    }), 'unknown_task');
  }

  for (const operationId of ['constructor', 'toString', 'prototype']) {
    assert.equal(getTaskOperation('P01', operationId), undefined);
    assertProtocolCode(() => createWorkerRequest({
      taskId: 'P01',
      requestId: `operation-${operationId}`,
      calls: [{ operationId, args: [] }],
    }), 'unknown_operation');
  }
});

test('request schema and call bounds are enforced before transport', () => {
  const request = createWorkerRequest({
    taskId: 'P01', requestId: 'request-6', calls: [{ operationId: 'call', args: [] }],
  });
  const badVersion = { ...request, schemaVersion: WORKER_PROTOCOL_VERSION + 1 };
  assertProtocolCode(() => parseWorkerRequest(JSON.stringify(badVersion)), 'invalid_version');
  const oversizedCalls = Array.from({ length: MAX_CALLS + 1 }, () => ({ operationId: 'call', args: [] }));
  assertProtocolCode(() => createWorkerRequest({ taskId: 'P01', calls: oversizedCalls }), 'invalid_calls');
  assertProtocolCode(() => parseWorkerRequest(Buffer.alloc(MAX_REQUEST_BYTES + 1)), 'request_too_large');
  assertProtocolCode(() => parseWorkerResponse(Buffer.alloc(MAX_RESPONSE_BYTES + 1), request), 'response_too_large');
});

test('host fake transport compares worker results while expected values stay host-side', async () => {
  const expected = 'only-held-by-host';
  const request = createWorkerRequest({
    taskId: 'I03', requestId: 'request-7',
    calls: [{ callId: 'row-1', operationId: 'call', args: [['a,b', undefined]] }],
  });
  const requestBytes = serializeWorkerRequest(request);
  assert.equal(requestBytes.includes(expected), false);

  async function fakeTransport(bytes) {
    const workerRequest = parseWorkerRequest(bytes);
    const args = decodeValue(workerRequest.calls[0].args);
    assert.deepEqual(args, [['a,b', undefined]]);
    return serializeWorkerResponse(createWorkerResponse(workerRequest, [{
      callId: workerRequest.calls[0].callId,
      ok: true,
      argsAfter: args,
      sameAsArgs: [false],
      value: expected,
    }]), workerRequest);
  }

  const response = await fakeTransport(requestBytes);
  const result = parseWorkerResponse(response, request).results[0];
  assert.equal(result.value, expected);
  assert.deepEqual(result.sameAsArgs, [false]);
  assert.deepEqual(result.argsAfter, [['a,b', undefined]]);
  assert.equal(expected, 'only-held-by-host');
});

test('response correlation, call order, and result error values are checked', () => {
  const request = createWorkerRequest({
    taskId: 'P02', requestId: 'request-8',
    calls: [{ callId: 'duration-1', operationId: 'call', args: ['09:15'] }],
  });
  const response = createWorkerResponse(request, [{
    callId: 'duration-1', ok: false, argsAfter: ['09:15'], error: new TypeError('invalid duration'),
  }]);
  const wire = serializeWorkerResponse(response, request);
  const parsed = parseWorkerResponse(wire, request);
  assert.equal(parsed.results[0].ok, false);
  assert.ok(parsed.results[0].error instanceof Error);
  assert.ok(parsed.results[0].error instanceof TypeError);
  assert.equal(parsed.results[0].error.name, 'TypeError');
  assert.equal(parsed.results[0].error.message, 'invalid duration');

  const successRequest = createWorkerRequest({
    taskId: 'P02', requestId: 'request-8b',
    calls: [{ callId: 'duration-2', operationId: 'call', args: ['09:15'] }],
  });
  const invalidIdentity = createWorkerResponse(successRequest, [{
    callId: 'duration-2', ok: true, argsAfter: ['09:15'], sameAsArgs: [false], value: 555,
  }]);
  invalidIdentity.results[0].sameAsArgs = [];
  assertProtocolCode(() => parseWorkerResponse(JSON.stringify(invalidIdentity), successRequest), 'invalid_result');

  const mismatched = { ...response, requestId: 'request-other' };
  assertProtocolCode(() => parseWorkerResponse(JSON.stringify(mismatched), request), 'correlation_mismatch');
});

test('response-only sentinels keep unsupported candidate outputs non-executable and non-matching', () => {
  const request = createWorkerRequest({
    taskId: 'P01', requestId: 'request-output-sentinel',
    calls: [{ callId: 'sentinel-1', operationId: 'call', args: [{}] }],
  });
  const proxy = new Proxy({}, {});
  const symbolKeyedOutput = { visible: true };
  Object.defineProperty(symbolKeyedOutput, Symbol('hidden'), { value: 'sentinel', enumerable: true });
  const response = createWorkerResponse(request, [{
    callId: 'sentinel-1',
    ok: true,
    argsAfter: [{ callback: () => undefined, marker: Symbol('candidate'), symbolKeyedOutput }],
    sameAsArgs: [false],
    value: proxy,
  }]);
  const parsed = parseWorkerResponse(serializeWorkerResponse(response, request), request);
  const value = parsed.results[0].value;
  const callback = parsed.results[0].argsAfter[0].callback;
  const marker = parsed.results[0].argsAfter[0].marker;
  const symbolKeyed = parsed.results[0].argsAfter[0].symbolKeyedOutput;

  assert.equal(isUnserializableWorkerValue(value), true);
  assert.equal(value.kind, 'proxy');
  assert.equal(typeof value, 'object');
  assert.equal(isUnserializableWorkerValue(callback), true);
  assert.equal(callback.kind, 'function');
  assert.equal(isUnserializableWorkerValue(marker), true);
  assert.equal(marker.kind, 'symbol');
  assert.equal(isUnserializableWorkerValue(symbolKeyed), true);
  assert.equal(symbolKeyed.kind, 'symbol-key');
});

test('value and wire size limits reject excessive nesting and payloads', () => {
  let deep = 'leaf';
  for (let index = 0; index < 60; index += 1) deep = [deep];
  assertProtocolCode(() => encodeValue(deep), 'value_too_deep');
  assertProtocolCode(() => encodeValue(new Array(MAX_ARRAY_ITEMS + 1)), 'value_too_large');
  const oversizedObject = Object.create(null);
  for (let index = 0; index <= MAX_VALUE_NODES; index += 1) {
    Object.defineProperty(oversizedObject, `key${index}`, { value: index, enumerable: true });
  }
  assertProtocolCode(() => encodeValue(oversizedObject), 'value_too_large');
  let proxyTraps = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() { proxyTraps += 1; return null; },
    ownKeys() { proxyTraps += 1; return []; },
  });
  assertProtocolCode(() => encodeValue(proxy), 'unsupported_value');
  const proxyPrototypeValue = Object.create(proxy);
  assertProtocolCode(() => encodeValue(proxyPrototypeValue), 'unsupported_value');
  assert.equal(proxyTraps, 0);
  assertProtocolCode(() => encodeValue(10n ** BigInt(MAX_STRING_BYTES)), 'value_too_large');
  const oversizedBigInt = 1n << BigInt(Math.ceil(MAX_STRING_BYTES * Math.log2(10)) + 3);
  assertProtocolCode(() => encodeValue(oversizedBigInt), 'value_too_large');
  assertProtocolCode(() => createWorkerRequest({
    taskId: 'P01', requestId: 'request-9',
    calls: [{ operationId: 'call', args: ['x'.repeat(MAX_REQUEST_BYTES)] }],
  }), 'request_too_large');
});
