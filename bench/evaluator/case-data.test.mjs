import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { encodeValue } from '../isolation/protocol.mjs';
import { parseCaseData } from './case-data.mjs';

function documentWith(nodes, args) {
  return {
    schemaVersion: 1,
    nodes,
    cases: [{
      id: 'graph-fixture',
      operationId: 'call',
      args,
      expected: { ok: true },
    }],
  };
}

function parseDocument(document) {
  return parseCaseData(Buffer.from(JSON.stringify(document), 'utf8'));
}

test('materializes bounded refs, aliases, cycles, Maps, built-in Errors, BigInt and undefined', () => {
  const cases = parseDocument(documentWith([
    { id: 'n0', kind: 'object', properties: [['self', { $ref: 'n0' }], ['shared', { $ref: 'n1' }]] },
    { id: 'n1', kind: 'array', items: [{ $value: 'bigint', text: '9007199254740993' }, { $value: 'undefined' }] },
    { id: 'n2', kind: 'map', entries: [['key', { $ref: 'n1' }]] },
    { id: 'n3', kind: 'error', name: 'AppError', message: 'gone', properties: [['code', 'NOT_FOUND'], ['status', 404]] },
    { id: 'n4', kind: 'error', name: 'TypeError', message: 'invalid', properties: [] },
    { id: 'n5', kind: 'noop-function' },
  ], [
    { $ref: 'n0' }, { $ref: 'n1' }, { $ref: 'n2' }, { $ref: 'n3' }, { $ref: 'n4' }, { $ref: 'n5' },
  ]));
  const [root, values, map, appError, typeError, noop] = cases[0].args;

  assert.equal(root.self, root);
  assert.equal(root.shared, values);
  assert.equal(values[0], 9007199254740993n);
  assert.equal(values[1], undefined);
  assert.equal(map.get('key'), values);
  assert.ok(appError instanceof Error);
  assert.equal(appError.name, 'AppError');
  assert.equal(appError.code, 'NOT_FOUND');
  assert.equal(appError.status, 404);
  assert.ok(typeError instanceof TypeError);
  assert.equal(typeError.message, 'invalid');
  assert.equal(typeof noop, 'function');
  assert.equal(noop(), undefined);
  assert.equal(encodeValue(noop)[0], 'noop-function');
});

test('defines prototype-sensitive keys as own data properties without changing the prototype', () => {
  const cases = parseDocument(documentWith([
    { id: 'n0', kind: 'object', properties: [
      ['__proto__', 'own proto key'], ['constructor', 'own constructor'], ['prototype', 'own prototype'],
    ] },
  ], [{ $ref: 'n0' }]));
  const value = cases[0].args[0];

  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const [key, expected] of [
    ['__proto__', 'own proto key'], ['constructor', 'own constructor'], ['prototype', 'own prototype'],
  ]) {
    assert.equal(Object.hasOwn(value, key), true);
    assert.equal(value[key], expected);
  }
});

test('preserves the original I02 offset strings and expected rollover/rejection fixtures', async () => {
  const publicCases = parseCaseData(await readFile(new URL('../tasks/I02/public-tests/test.json', import.meta.url)));
  const oracleCases = parseCaseData(await readFile(new URL('../oracles/I02.json', import.meta.url)));

  assert.deepEqual(publicCases.map((testCase) => testCase.args[0]), [
    '2025-04-01T01:00:00+03:00',
    '2025-04-01T12:00:00Z',
    '2025-04-01',
    '2025-02-29T12:00:00Z',
    '2016-12-31T23:59:60Z',
    '2025-04-01T12:00:00-00:00',
  ]);
  assert.deepEqual(publicCases.slice(2).map((testCase) => testCase.expected.error.instanceOf), [
    'TypeError', 'TypeError', 'TypeError', 'TypeError',
  ]);
  assert.equal(oracleCases[0].args[0], '2025-01-01T00:30:00+02:00');
  assert.equal(oracleCases[0].expected.value, '2024-12-31');
  assert.equal(oracleCases[1].args[0], '2025-01-01T23:30:00-02:00');
  assert.equal(oracleCases[1].expected.value, '2025-01-02');
  assert.equal(oracleCases[5].args[0], '2025-01-01T00:00:00-00:00');
  assert.equal(oracleCases[5].expected.error.instanceOf, 'TypeError');
});

test('materializes B06 frozen input objects while keeping nested values shallowly mutable', async () => {
  const cases = parseCaseData(await readFile(new URL('../oracles/B06.json', import.meta.url)));
  const [defaults, override] = cases[0].args;

  assert.equal(Object.isFrozen(defaults), true);
  assert.equal(Object.isFrozen(override), true);
  assert.equal(Object.isFrozen(defaults.nested), false);
  assert.deepEqual(cases[0].expectedArgsAfterProjections.map(({ value }) => value), [4, 0]);
  assert.throws(() => parseDocument(documentWith([
    { id: 'n0', kind: 'array', frozen: true, items: [] },
  ], [{ $ref: 'n0' }])), /node is invalid/);
  assert.throws(() => parseDocument(documentWith([
    { id: 'n0', kind: 'object', frozen: 'yes', properties: [] },
  ], [{ $ref: 'n0' }])), /node is invalid/);
});

test('rejects unknown node kinds, dangling refs, executable-shaped metadata and oversized input', () => {
  assert.throws(() => parseDocument(documentWith([{ id: 'n0', kind: 'constructor', code: 'x' }], [{ $ref: 'n0' }])), /node is invalid/);
  assert.throws(() => parseDocument(documentWith([], [{ $ref: 'n0' }])), /cases are invalid/);
  const executable = documentWith([], []);
  executable.cases = [{ id: 'x', operationId: 'call', args: [], expected: { ok: true }, callback: 'process.exit()' }];
  assert.throws(() => parseDocument(executable), /cases are invalid/);
  assert.throws(() => parseCaseData(Buffer.alloc(1024 * 1024 + 1)), /byte limit/);
});
