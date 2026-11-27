import { isDeepStrictEqual } from 'node:util';
import {
  MAX_CALLS,
  createNoopFunctionFixture,
  encodeValue,
} from '../isolation/protocol.mjs';

function isPlainRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function materializeHostValue(value, seen = new Map()) {
  if (typeof value === 'function' || typeof value === 'symbol' || value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) return seen.get(value);

  if (hasOnlyKeys(value, ['$fixture']) && value.$fixture === 'noop-function-v1') {
    const fixture = createNoopFunctionFixture();
    seen.set(value, fixture);
    return fixture;
  }

  if (value instanceof Error) {
    const copy = new Error(value.message);
    seen.set(value, copy);
    copy.name = value.name;
    for (const key of Object.keys(value)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      copy[key] = materializeHostValue(value[key], seen);
    }
    return copy;
  }

  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, item] of value) copy.set(materializeHostValue(key, seen), materializeHostValue(item, seen));
    return copy;
  }

  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(materializeHostValue(item, seen));
    return copy;
  }

  if (isPlainRecord(value)) {
    const copy = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) copy[key] = materializeHostValue(value[key], seen);
    return copy;
  }

  return value;
}

function projectValue(value, projection) {
  if (projection === undefined) return { ok: true, value };
  if (!isPlainRecord(projection) || typeof projection.kind !== 'string') {
    return { ok: false, code: 'invalid_projection' };
  }

  if (projection.kind === 'json-parse' && hasOnlyKeys(projection, ['kind'])) {
    if (typeof value !== 'string') return { ok: false, code: 'projection_type_mismatch' };
    try { return { ok: true, value: JSON.parse(value) }; }
    catch { return { ok: false, code: 'projection_failed' }; }
  }

  if (projection.kind === 'map-property'
    && hasOnlyKeys(projection, ['kind', 'property'])
    && typeof projection.property === 'string'
    && projection.property.length > 0) {
    if (!Array.isArray(value)) return { ok: false, code: 'projection_type_mismatch' };
    const projected = [];
    for (const item of value) {
      if (!isPlainRecord(item) || !Object.hasOwn(item, projection.property)) {
        return { ok: false, code: 'projection_path_missing' };
      }
      projected.push(item[projection.property]);
    }
    return { ok: true, value: projected };
  }

  if (projection.kind === 'path'
    && hasOnlyKeys(projection, ['kind', 'path'])
    && Array.isArray(projection.path)
    && projection.path.every((part) => typeof part === 'string')) {
    let current = value;
    for (const part of projection.path) {
      if ((typeof current !== 'object' && typeof current !== 'function')
        || current === null || !Object.hasOwn(current, part)) {
        return { ok: false, code: 'projection_path_missing' };
      }
      current = current[part];
    }
    return { ok: true, value: current };
  }

  return { ok: false, code: 'invalid_projection' };
}

function compareEncoded(actual, expected) {
  try { return isDeepStrictEqual(encodeValue(actual), encodeValue(expected)); }
  catch { return false; }
}

function readOwnPath(root, path) {
  let current = root;
  for (const part of path) {
    if ((typeof current !== 'object' && typeof current !== 'function')
      || current === null || !Object.hasOwn(current, part)) {
      return { exists: false };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function validateCase(testCase, seenIds) {
  if (!isPlainRecord(testCase)
    || typeof testCase.id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(testCase.id)
    || seenIds.has(testCase.id)
    || typeof testCase.operationId !== 'string'
    || !Array.isArray(testCase.args)
    || !isPlainRecord(testCase.expected)
    || typeof testCase.expected.ok !== 'boolean') {
    return false;
  }
  seenIds.add(testCase.id);

  if (Object.hasOwn(testCase.expected, 'valueProjection') && !isPlainRecord(testCase.expected.valueProjection)) return false;
  if (testCase.expected.ok === false && (!isPlainRecord(testCase.expected.error)
    || (Object.hasOwn(testCase.expected.error, 'name') && typeof testCase.expected.error.name !== 'string')
    || (Object.hasOwn(testCase.expected.error, 'message') && typeof testCase.expected.error.message !== 'string')
    || (Object.hasOwn(testCase.expected.error, 'instanceOf')
      && !['Error', 'TypeError'].includes(testCase.expected.error.instanceOf)))) return false;
  if (testCase.expected.ok === true && Object.hasOwn(testCase.expected, 'error')) return false;
  if (Object.hasOwn(testCase, 'expectedArgsAfter') && !Array.isArray(testCase.expectedArgsAfter)) return false;
  if (Object.hasOwn(testCase, 'expectedArgsAfterProjections')
    && (!Array.isArray(testCase.expectedArgsAfterProjections)
      || testCase.expectedArgsAfterProjections.some((projection) => (
        !isPlainRecord(projection)
        || !hasOnlyKeys(projection, ['index', 'path', 'value'])
        || !Number.isInteger(projection.index)
        || projection.index < 0
        || projection.index >= testCase.args.length
        || !Array.isArray(projection.path)
        || !projection.path.every((part) => typeof part === 'string')
      )))) return false;
  if (Object.hasOwn(testCase, 'expectedDistinctFromArgs')
    && (!Array.isArray(testCase.expectedDistinctFromArgs)
      || testCase.expectedDistinctFromArgs.some((index) => !Number.isInteger(index) || index < 0 || index >= testCase.args.length))) {
    return false;
  }
  return true;
}

function compareOne(testCase, result, argsBefore) {
  if (!isPlainRecord(result) || result.callId !== testCase.id || result.ok !== testCase.expected.ok) {
    return 'outcome_mismatch';
  }

  if (testCase.expected.ok) {
    if (Object.hasOwn(testCase.expected, 'value')) {
      const projected = projectValue(result.value, testCase.expected.valueProjection);
      if (!projected.ok) return projected.code;
      if (!isDeepStrictEqual(projected.value, testCase.expected.value)) return 'value_mismatch';
    } else if (Object.hasOwn(testCase.expected, 'valueProjection')) {
      return 'invalid_projection';
    }

    if (!Array.isArray(result.sameAsArgs) || result.sameAsArgs.length !== argsBefore.length) return 'identity_observation_missing';
    for (const index of testCase.expectedDistinctFromArgs ?? []) {
      if (result.sameAsArgs[index] !== false) return 'identity_mismatch';
    }
  } else {
    const expectedError = testCase.expected.error;
    if (!(result.error instanceof Error) || !isPlainRecord(expectedError)) return 'error_mismatch';
    if (Object.hasOwn(expectedError, 'instanceOf')) {
      const builtInErrorTypes = new Map([['Error', Error], ['TypeError', TypeError]]);
      const ErrorType = builtInErrorTypes.get(expectedError.instanceOf);
      if (!ErrorType || !(result.error instanceof ErrorType)) return 'error_instance_mismatch';
    }
    if (typeof expectedError.name === 'string' && result.error.name !== expectedError.name) return 'error_name_mismatch';
    if (Object.hasOwn(expectedError, 'message') && result.error.message !== expectedError.message) return 'error_message_mismatch';
  }

  if (Object.hasOwn(testCase, 'expectedArgsAfter')) {
    const expectedArgsAfter = materializeHostValue(testCase.expectedArgsAfter);
    if (!compareEncoded(result.argsAfter, expectedArgsAfter)) return 'argument_state_mismatch';
  }
  for (const projection of testCase.expectedArgsAfterProjections ?? []) {
    const actual = readOwnPath(result.argsAfter[projection.index], projection.path);
    if (!actual.exists || !compareEncoded(actual.value, materializeHostValue(projection.value))) {
      return 'argument_projection_mismatch';
    }
  }
  return undefined;
}

/** Run trusted host assertions against isolated worker results; expectations never enter worker calls. */
export async function runHostCases({
  cases,
  taskId,
  workspaceRoot,
  timeoutMs,
  workerRunner,
}) {
  if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('cases must be a non-empty array');
  if (typeof taskId !== 'string' || typeof workspaceRoot !== 'string' || typeof workerRunner !== 'function') {
    throw new TypeError('taskId, workspaceRoot, and workerRunner are required');
  }

  const seenIds = new Set();
  if (cases.some((testCase) => !validateCase(testCase, seenIds))) {
    throw new TypeError('case registry contains invalid or duplicate cases');
  }

  const failures = [];
  let caseCount = 0;
  for (let offset = 0; offset < cases.length; offset += MAX_CALLS) {
    const batchCases = cases.slice(offset, offset + MAX_CALLS);
    const argsById = new Map();
    const calls = batchCases.map((testCase) => {
      const args = materializeHostValue(testCase.args);
      argsById.set(testCase.id, args);
      return Object.freeze({
        callId: testCase.id,
        operationId: testCase.operationId,
        args,
      });
    });
    const response = await workerRunner({ workspaceRoot, taskId, calls, timeoutMs });
    if (!isPlainRecord(response) || !Array.isArray(response.results) || response.results.length !== batchCases.length) {
      throw new Error('worker_response_shape_invalid');
    }

    for (let index = 0; index < batchCases.length; index += 1) {
      const testCase = batchCases[index];
      caseCount += 1;
      const code = compareOne(testCase, response.results[index], argsById.get(testCase.id));
      if (code) failures.push(Object.freeze({ caseId: testCase.id, code }));
    }
  }

  return Object.freeze({
    passed: failures.length === 0,
    caseCount,
    failures: Object.freeze(failures),
  });
}
