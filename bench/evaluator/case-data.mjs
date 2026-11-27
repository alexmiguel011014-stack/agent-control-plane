import { createNoopFunctionFixture } from '../isolation/protocol.mjs';

export const CASE_DATA_LIMITS = Object.freeze({
  bytes: 1024 * 1024,
  cases: 128,
  nodes: 4096,
  edges: 8192,
  stringLength: 65536,
  depth: 64,
});

const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NODE_ID_PATTERN = /^n[0-9]{1,6}$/;
const BIGINT_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasUniquePropertyEntries(entries) {
  const keys = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || keys.has(entry[0])) return false;
    keys.add(entry[0]);
  }
  return true;
}

function assertJsonTree(value) {
  let visited = 0;
  function visit(current, depth) {
    visited += 1;
    if (visited > CASE_DATA_LIMITS.edges || depth > CASE_DATA_LIMITS.depth) {
      throw new TypeError('case data exceeds structural limits');
    }
    if (typeof current === 'string' && current.length > CASE_DATA_LIMITS.stringLength) {
      throw new TypeError('case data string exceeds limit');
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else if (isRecord(current)) {
      for (const [key, item] of Object.entries(current)) {
        if (key.length > CASE_DATA_LIMITS.stringLength) throw new TypeError('case data key exceeds limit');
        visit(item, depth + 1);
      }
    } else if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) {
      if (typeof current === 'number' && !Number.isFinite(current)) throw new TypeError('case data number is invalid');
    } else {
      throw new TypeError('case data contains a non-JSON value');
    }
  }
  visit(value, 0);
}

function validateToken(token, nodeIds) {
  if (token === null || typeof token === 'string' || typeof token === 'boolean') return true;
  if (typeof token === 'number') return Number.isFinite(token);
  if (!isRecord(token)) return false;
  if (hasOnlyKeys(token, ['$ref'])) return typeof token.$ref === 'string' && nodeIds.has(token.$ref);
  if (hasOnlyKeys(token, ['$value']) && token.$value === 'undefined') return true;
  return hasOnlyKeys(token, ['$value', 'text'])
    && token.$value === 'bigint'
    && typeof token.text === 'string'
    && token.text.length <= CASE_DATA_LIMITS.stringLength
    && BIGINT_PATTERN.test(token.text);
}

function validateProjection(projection) {
  if (!isRecord(projection) || typeof projection.kind !== 'string') return false;
  if (projection.kind === 'json-parse') return hasOnlyKeys(projection, ['kind']);
  if (projection.kind === 'map-property') {
    return hasOnlyKeys(projection, ['kind', 'property'])
      && typeof projection.property === 'string'
      && projection.property.length > 0
      && projection.property.length <= CASE_DATA_LIMITS.stringLength;
  }
  return projection.kind === 'path'
    && hasOnlyKeys(projection, ['kind', 'path'])
    && Array.isArray(projection.path)
    && projection.path.every((part) => typeof part === 'string' && part.length <= CASE_DATA_LIMITS.stringLength);
}

function validateCase(testCase, nodeIds, seenIds) {
  if (!isRecord(testCase)
    || !hasOnlyKeys(testCase, [
      'id', 'operationId', 'args', 'expected', 'expectedArgsAfter',
      'expectedArgsAfterProjections', 'expectedDistinctFromArgs',
    ].filter((key) => Object.hasOwn(testCase, key)))
    || typeof testCase.id !== 'string'
    || !CASE_ID_PATTERN.test(testCase.id)
    || seenIds.has(testCase.id)
    || typeof testCase.operationId !== 'string'
    || testCase.operationId.length === 0
    || testCase.operationId.length > CASE_DATA_LIMITS.stringLength
    || !Array.isArray(testCase.args)
    || !isRecord(testCase.expected)
    || ![true, false].includes(testCase.expected.ok)) return false;
  seenIds.add(testCase.id);

  const expected = testCase.expected;
  if (!hasOnlyKeys(expected, ['ok', 'value', 'valueProjection', 'error']
    .filter((key) => Object.hasOwn(expected, key)))) return false;
  if (Object.hasOwn(expected, 'value') && !validateToken(expected.value, nodeIds)) return false;
  if (Object.hasOwn(expected, 'valueProjection') && !validateProjection(expected.valueProjection)) return false;
  if (expected.ok === false) {
    if (!hasOnlyKeys(expected, ['ok', 'error']) || !isRecord(expected.error)
      || !hasOnlyKeys(expected.error, ['name', 'message', 'instanceOf']
        .filter((key) => Object.hasOwn(expected.error, key)))
      || Object.keys(expected.error).length === 0
      || (Object.hasOwn(expected.error, 'name') && typeof expected.error.name !== 'string')
      || (Object.hasOwn(expected.error, 'message') && typeof expected.error.message !== 'string')
      || (Object.hasOwn(expected.error, 'instanceOf') && !['Error', 'TypeError'].includes(expected.error.instanceOf))) return false;
  } else if (Object.hasOwn(expected, 'error')) return false;

  if (!testCase.args.every((token) => validateToken(token, nodeIds))) return false;
  if (Object.hasOwn(testCase, 'expectedArgsAfter')
    && (!Array.isArray(testCase.expectedArgsAfter)
      || !testCase.expectedArgsAfter.every((token) => validateToken(token, nodeIds)))) return false;
  if (Object.hasOwn(testCase, 'expectedArgsAfterProjections')
    && (!Array.isArray(testCase.expectedArgsAfterProjections)
      || testCase.expectedArgsAfterProjections.some((projection) => (
        !isRecord(projection)
        || !hasOnlyKeys(projection, ['index', 'path', 'value'])
        || !Number.isInteger(projection.index)
        || projection.index < 0
        || projection.index >= testCase.args.length
        || !Array.isArray(projection.path)
        || !projection.path.every((part) => typeof part === 'string')
        || !validateToken(projection.value, nodeIds)
      )))) return false;
  if (Object.hasOwn(testCase, 'expectedDistinctFromArgs')
    && (!Array.isArray(testCase.expectedDistinctFromArgs)
      || testCase.expectedDistinctFromArgs.some((index) => !Number.isInteger(index)
        || index < 0 || index >= testCase.args.length))) return false;
  return true;
}

function validateNode(node, nodeIds) {
  if (!isRecord(node) || typeof node.kind !== 'string') return false;
  if (node.kind === 'object') {
    return hasOnlyKeys(node, ['id', 'kind', 'properties', 'frozen']
      .filter((key) => Object.hasOwn(node, key)))
      && NODE_ID_PATTERN.test(node.id)
      && (!Object.hasOwn(node, 'frozen') || typeof node.frozen === 'boolean')
      && Array.isArray(node.properties)
      && hasUniquePropertyEntries(node.properties)
      && node.properties.every((entry) => Array.isArray(entry)
        && entry.length === 2
        && typeof entry[0] === 'string'
        && entry[0].length <= CASE_DATA_LIMITS.stringLength
        && validateToken(entry[1], nodeIds));
  }
  if (node.kind === 'array') {
    return hasOnlyKeys(node, ['id', 'kind', 'items'])
      && NODE_ID_PATTERN.test(node.id)
      && Array.isArray(node.items)
      && node.items.every((token) => validateToken(token, nodeIds));
  }
  if (node.kind === 'map') {
    return hasOnlyKeys(node, ['id', 'kind', 'entries'])
      && NODE_ID_PATTERN.test(node.id)
      && Array.isArray(node.entries)
      && node.entries.every((entry) => Array.isArray(entry)
        && entry.length === 2
        && validateToken(entry[0], nodeIds)
        && validateToken(entry[1], nodeIds));
  }
  if (node.kind === 'error') {
    return hasOnlyKeys(node, ['id', 'kind', 'name', 'message', 'properties'])
      && NODE_ID_PATTERN.test(node.id)
      && ['Error', 'TypeError', 'AppError'].includes(node.name)
      && typeof node.message === 'string'
      && node.message.length <= CASE_DATA_LIMITS.stringLength
      && Array.isArray(node.properties)
      && hasUniquePropertyEntries(node.properties)
      && node.properties.every((entry) => Array.isArray(entry)
        && entry.length === 2
        && typeof entry[0] === 'string'
        && entry[0].length <= CASE_DATA_LIMITS.stringLength
        && !['name', 'message', 'stack'].includes(entry[0])
        && validateToken(entry[1], nodeIds));
  }
  return node.kind === 'noop-function'
    && hasOnlyKeys(node, ['id', 'kind'])
    && NODE_ID_PATTERN.test(node.id);
}

function defineOwnDataProperty(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function decodeToken(token, allocated) {
  if (token === null || typeof token !== 'object') return token;
  if (Object.hasOwn(token, '$ref')) return allocated.get(token.$ref);
  if (token.$value === 'undefined') return undefined;
  if (token.$value === 'bigint') return BigInt(token.text);
  throw new TypeError('case data token is invalid');
}

function materialize(document) {
  const allocated = new Map();
  for (const node of document.nodes) {
    if (node.kind === 'object') allocated.set(node.id, {});
    else if (node.kind === 'array') allocated.set(node.id, []);
    else if (node.kind === 'map') allocated.set(node.id, new Map());
    else if (node.kind === 'error') {
      const ErrorType = node.name === 'TypeError' ? TypeError : Error;
      const error = new ErrorType(node.message);
      error.name = node.name;
      allocated.set(node.id, error);
    } else allocated.set(node.id, createNoopFunctionFixture());
  }

  for (const node of document.nodes) {
    const value = allocated.get(node.id);
    if (node.kind === 'object' || node.kind === 'error') {
      for (const [key, token] of node.properties) {
        defineOwnDataProperty(value, key, decodeToken(token, allocated));
      }
    } else if (node.kind === 'array') {
      for (const token of node.items) value.push(decodeToken(token, allocated));
    } else if (node.kind === 'map') {
      for (const [key, item] of node.entries) {
        value.set(decodeToken(key, allocated), decodeToken(item, allocated));
      }
    }
  }
  for (const node of document.nodes) {
    if (node.kind === 'object' && node.frozen === true) Object.freeze(allocated.get(node.id));
  }

  const cases = document.cases.map((testCase) => {
    const copy = {
      id: testCase.id,
      operationId: testCase.operationId,
      args: testCase.args.map((token) => decodeToken(token, allocated)),
      expected: { ...testCase.expected },
    };
    if (Object.hasOwn(testCase.expected, 'value')) {
      copy.expected.value = decodeToken(testCase.expected.value, allocated);
    }
    if (Object.hasOwn(testCase, 'expectedArgsAfter')) {
      copy.expectedArgsAfter = testCase.expectedArgsAfter.map((token) => decodeToken(token, allocated));
    }
    if (Object.hasOwn(testCase, 'expectedArgsAfterProjections')) {
      copy.expectedArgsAfterProjections = testCase.expectedArgsAfterProjections.map((projection) => ({
        index: projection.index,
        path: [...projection.path],
        value: decodeToken(projection.value, allocated),
      }));
    }
    if (Object.hasOwn(testCase, 'expectedDistinctFromArgs')) {
      copy.expectedDistinctFromArgs = [...testCase.expectedDistinctFromArgs];
    }
    if (Object.hasOwn(testCase.expected, 'valueProjection')) {
      copy.expected.valueProjection = structuredClone(testCase.expected.valueProjection);
    }
    if (Object.hasOwn(testCase.expected, 'error')) {
      copy.expected.error = { ...testCase.expected.error };
    }
    return copy;
  });
  return cases;
}

/** Parse and materialize a bounded, declarative case graph. File contents never become executable code. */
export function parseCaseData(bytes, sourceName = 'case-data.json') {
  if (!Buffer.isBuffer(bytes) || bytes.length > CASE_DATA_LIMITS.bytes) {
    throw new TypeError(`${sourceName}: case data exceeds byte limit`);
  }
  let document;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    document = JSON.parse(source);
  } catch {
    throw new TypeError(`${sourceName}: case data must be valid UTF-8 JSON`);
  }
  assertJsonTree(document);
  if (!hasOnlyKeys(document, ['schemaVersion', 'cases', 'nodes'])
    || document.schemaVersion !== 1
    || !Array.isArray(document.cases)
    || document.cases.length === 0
    || document.cases.length > CASE_DATA_LIMITS.cases
    || !Array.isArray(document.nodes)
    || document.nodes.length > CASE_DATA_LIMITS.nodes) {
    throw new TypeError(`${sourceName}: case data schema is invalid`);
  }

  const nodeIds = new Set();
  for (const node of document.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !NODE_ID_PATTERN.test(node.id) || nodeIds.has(node.id)) {
      throw new TypeError(`${sourceName}: case data node ID is invalid`);
    }
    nodeIds.add(node.id);
  }
  let edgeCount = 0;
  for (const node of document.nodes) {
    if (!validateNode(node, nodeIds)) throw new TypeError(`${sourceName}: case data node is invalid`);
    if (node.kind === 'object' || node.kind === 'error') edgeCount += node.properties.length;
    else if (node.kind === 'array') edgeCount += node.items.length;
    else if (node.kind === 'map') edgeCount += node.entries.length * 2;
  }
  if (edgeCount > CASE_DATA_LIMITS.edges) throw new TypeError(`${sourceName}: case data graph exceeds edge limit`);
  const seenIds = new Set();
  if (document.cases.some((testCase) => !validateCase(testCase, nodeIds, seenIds))) {
    throw new TypeError(`${sourceName}: case data cases are invalid or duplicated`);
  }
  return materialize(document);
}
