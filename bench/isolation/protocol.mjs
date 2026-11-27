import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { getTaskOperation, isRegisteredTaskId } from './task-operations.mjs';

export const WORKER_PROTOCOL_VERSION = 2;
export const MAX_REQUEST_BYTES = 65_536;
export const MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_CALLS = 128;
export const MAX_ARGUMENTS = 64;
export const MAX_VALUE_DEPTH = 48;
export const MAX_VALUE_NODES = 20_000;
export const MAX_ARRAY_ITEMS = MAX_VALUE_NODES;
export const MAX_STRING_BYTES = 262_144;
const MAX_BIGINT_PRECHECK_BITS = BigInt(Math.ceil(MAX_STRING_BYTES * Math.log2(10)) + 1);
const MAX_BIGINT_PRECHECK_MAGNITUDE = 1n << MAX_BIGINT_PRECHECK_BITS;
const MIN_BIGINT_PRECHECK_MAGNITUDE = -MAX_BIGINT_PRECHECK_MAGNITUDE;
const NOOP_FUNCTION_FIXTURES = new WeakSet();
const NATIVE_ERROR = Error;
const NATIVE_TYPE_ERROR = TypeError;
const NATIVE_HAS_OWN = Object.hasOwn;
const NATIVE_OBJECT_CREATE = Object.create;
const NATIVE_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const NATIVE_OBJECT_FREEZE = Object.freeze;
const NATIVE_OBJECT_IS_FROZEN = Object.isFrozen;
const NATIVE_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const NATIVE_GET_OWN_PROPERTY_SYMBOLS = Object.getOwnPropertySymbols;
const NATIVE_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const NATIVE_OBJECT_PROTOTYPE = Object.prototype;
const UNSERIALIZABLE_VALUE_KINDS = new Set(['function', 'symbol', 'proxy', 'object', 'symbol-key']);
const UNSERIALIZABLE_VALUES = new WeakSet();

const REQUEST_KEYS = ['calls', 'requestId', 'schemaVersion', 'taskId'];
const REQUEST_CALL_KEYS = ['args', 'callId', 'operationId'];
const RESPONSE_KEYS = ['requestId', 'results', 'schemaVersion', 'taskId'];
const RESPONSE_SUCCESS_KEYS = ['argsAfter', 'callId', 'ok', 'sameAsArgs', 'value'];
const RESPONSE_FAILURE_KEYS = ['argsAfter', 'callId', 'error', 'ok'];
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class WorkerProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkerProtocolError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkerProtocolError(code, message);
}

/** Creates a branded, frozen no-op function fixture for protocol test inputs. */
export function createNoopFunctionFixture() {
  const fixture = NATIVE_OBJECT_FREEZE(() => undefined);
  NOOP_FUNCTION_FIXTURES.add(fixture);
  return fixture;
}

function createUnserializableWorkerValue(kind) {
  const value = NATIVE_OBJECT_CREATE(null);
  NATIVE_OBJECT_DEFINE_PROPERTY(value, 'kind', { value: kind, enumerable: true });
  NATIVE_OBJECT_FREEZE(value);
  UNSERIALIZABLE_VALUES.add(value);
  return value;
}

export function isUnserializableWorkerValue(value) {
  return typeof value === 'object' && value !== null && UNSERIALIZABLE_VALUES.has(value);
}

function isRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = NATIVE_GET_PROTOTYPE_OF(value);
  return prototype === NATIVE_OBJECT_PROTOTYPE || prototype === null;
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail('invalid_identifier', `${label} is invalid`);
  }
}

function assertJsonByteLimit(value, maxBytes, code, label) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    fail(code, `${label} is not serializable JSON`);
  }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) fail(code, `${label} exceeds its byte limit`);
  return json;
}

function dataEntries(value, excludedKeys = []) {
  let prototype = NATIVE_GET_PROTOTYPE_OF(value);
  let prototypeDepth = 0;
  while (prototype !== null) {
    if (utilTypes.isProxy(prototype)) fail('unsupported_value', 'Proxy prototypes are not supported by the worker protocol');
    prototypeDepth += 1;
    if (prototypeDepth > MAX_VALUE_DEPTH) fail('value_too_deep', 'Object prototype chain exceeds the depth limit');
    prototype = NATIVE_GET_PROTOTYPE_OF(prototype);
  }
  const excluded = new Set(excludedKeys);
  const entries = [];
  let enumerated = 0;
  for (const key in value) {
    enumerated += 1;
    if (enumerated > MAX_VALUE_NODES) fail('value_too_large', 'Object exceeds the property limit');
    if (!NATIVE_HAS_OWN(value, key)) continue;
    if (excluded.has(key)) continue;
    const descriptor = NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
    if (!descriptor || !NATIVE_HAS_OWN(descriptor, 'value')) {
      fail('unsupported_value', 'Accessor properties are not supported by the worker protocol');
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function hasEnumerableSymbolKey(value) {
  const keys = NATIVE_GET_OWN_PROPERTY_SYMBOLS(value);
  if (keys.length > MAX_VALUE_NODES) fail('value_too_large', 'Object exceeds the symbol property limit');
  for (let index = 0; index < keys.length; index += 1) {
    if (NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value, keys[index])?.enumerable === true) return true;
  }
  return false;
}

/** Encode JavaScript values into a bounded, JSON-only graph format. */
function encodeValueInternal(value, allowUnserializable = false) {
  const references = new Map();
  const activeErrorProperties = new WeakSet();
  let nextReferenceId = 0;
  let nodes = 0;

  function unsupported(kind, message) {
    if (allowUnserializable) return ['unserializable', kind];
    fail('unsupported_value', message);
  }

  function encode(current, depth) {
    nodes += 1;
    if (nodes > MAX_VALUE_NODES) fail('value_too_large', 'Value exceeds the node limit');
    if (depth > MAX_VALUE_DEPTH) fail('value_too_deep', 'Value exceeds the depth limit');

    if (current === undefined) return ['undefined'];
    if (current === null) return ['null'];
    if (typeof current === 'boolean') return ['boolean', current];
    if (typeof current === 'string') {
      if (Buffer.byteLength(current, 'utf8') > MAX_STRING_BYTES) fail('value_too_large', 'String exceeds the byte limit');
      return ['string', current];
    }
    if (typeof current === 'number') {
      return ['number', Number.isNaN(current) ? 'NaN' : Object.is(current, -0) ? '-0' : String(current)];
    }
    if (typeof current === 'bigint') {
      if (current >= MAX_BIGINT_PRECHECK_MAGNITUDE || current <= MIN_BIGINT_PRECHECK_MAGNITUDE) {
        fail('value_too_large', 'BigInt exceeds the decimal string limit');
      }
      const decimal = current.toString(10);
      if (Buffer.byteLength(decimal, 'utf8') > MAX_STRING_BYTES) fail('value_too_large', 'BigInt exceeds the decimal string limit');
      return ['bigint', decimal];
    }
    if (typeof current === 'object' && current !== null && utilTypes.isProxy(current)) {
      return unsupported('proxy', 'Proxy objects are not supported by the worker protocol');
    }
    if (typeof current === 'object' && current !== null) {
      let prototype = NATIVE_GET_PROTOTYPE_OF(current);
      let prototypeDepth = 0;
      while (prototype !== null) {
        if (utilTypes.isProxy(prototype)) {
          return unsupported('proxy', 'Proxy prototypes are not supported by the worker protocol');
        }
        prototypeDepth += 1;
        if (prototypeDepth > MAX_VALUE_DEPTH) fail('value_too_deep', 'Object prototype chain exceeds the depth limit');
        prototype = NATIVE_GET_PROTOTYPE_OF(prototype);
      }
      if (hasEnumerableSymbolKey(current)) {
        return unsupported('symbol-key', 'Enumerable symbol-keyed properties are not supported');
      }
    }
    if (typeof current === 'function') {
      if (!NOOP_FUNCTION_FIXTURES.has(current)) {
        return unsupported('function', 'Only branded no-op function fixtures are supported');
      }
      const priorId = references.get(current);
      if (priorId !== undefined) return ['reference', priorId];
      const id = nextReferenceId++;
      references.set(current, id);
      return ['noop-function', id];
    }
    if (typeof current === 'symbol') {
      return unsupported('symbol', 'Symbols are not supported by the worker protocol');
    }

    if (current instanceof Error && activeErrorProperties.has(current)) {
      if (allowUnserializable) return ['unserializable', 'object'];
      fail('cyclic_error_properties', 'Cyclic Error-property graphs are not supported');
    }
    const priorId = references.get(current);
    if (priorId !== undefined) return ['reference', priorId];
    const id = nextReferenceId++;
    references.set(current, id);

    if (current instanceof Error) {
      const name = typeof current.name === 'string' ? current.name : 'Error';
      const message = typeof current.message === 'string' ? current.message : String(current.message ?? '');
      if (Buffer.byteLength(name, 'utf8') > 128 || Buffer.byteLength(message, 'utf8') > MAX_STRING_BYTES) {
        fail('value_too_large', 'Error fields exceed the byte limit');
      }
      let properties;
      try { properties = Object.fromEntries(dataEntries(current, ['name', 'message', 'stack'])); }
      catch (error) {
        if (allowUnserializable && error instanceof WorkerProtocolError && error.code === 'unsupported_value') {
          references.delete(current);
          return ['unserializable', 'object'];
        }
        throw error;
      }
      activeErrorProperties.add(current);
      let propertiesEncoding;
      try { propertiesEncoding = encode(properties, depth + 1); }
      finally { activeErrorProperties.delete(current); }
      return ['error', id, name, message, propertiesEncoding];
    }

    if (Array.isArray(current)) {
      if (current.length > MAX_ARRAY_ITEMS) fail('value_too_large', 'Array exceeds the item limit');
      return ['array', id, current.map((item) => encode(item, depth + 1))];
    }

    if (current instanceof Map) {
      if (current.size > MAX_VALUE_NODES) fail('value_too_large', 'Map exceeds the entry limit');
      return ['map', id, [...current.entries()].map(([key, item]) => [encode(key, depth + 1), encode(item, depth + 1)])];
    }

    if (!isRecord(current)) {
      references.delete(current);
      return unsupported('object', 'Only plain objects, arrays, maps, errors, and primitives are supported');
    }
    let entries;
    try { entries = dataEntries(current); }
    catch (error) {
      if (allowUnserializable && error instanceof WorkerProtocolError && error.code === 'unsupported_value') {
        references.delete(current);
        return ['unserializable', 'object'];
      }
      throw error;
    }
    if (entries.length > MAX_VALUE_NODES) fail('value_too_large', 'Object exceeds the property limit');
    const nullPrototype = NATIVE_GET_PROTOTYPE_OF(current) === null;
    const frozen = NATIVE_OBJECT_IS_FROZEN(current);
    const tag = frozen
      ? (nullPrototype ? 'frozen-null-object' : 'frozen-object')
      : (nullPrototype ? 'null-object' : 'object');
    return [tag, id, entries.map(([key, item]) => {
      if (Buffer.byteLength(key, 'utf8') > MAX_STRING_BYTES) fail('value_too_large', 'Object key exceeds the byte limit');
      return [key, encode(item, depth + 1)];
    })];
  }

  return encode(value, 0);
}

export function encodeValue(value) {
  return encodeValueInternal(value);
}

function encodeCandidateOutputValue(value) {
  return encodeValueInternal(value, true);
}

/** Decode a graph produced by encodeValue. Custom Error factories are supplied by fixed host registry code. */
export function decodeValue(encoded, {
  errorConstructors = Object.create(null),
  rejectUnknownErrorKinds = false,
  allowUnserializable = false,
} = {}) {
  const references = new Map();
  let nextReferenceId = 0;
  let nodes = 0;

  function decode(current, depth) {
    nodes += 1;
    if (nodes > MAX_VALUE_NODES) fail('value_too_large', 'Value exceeds the node limit');
    if (depth > MAX_VALUE_DEPTH) fail('value_too_deep', 'Value exceeds the depth limit');
    if (!Array.isArray(current) || typeof current[0] !== 'string') fail('invalid_value', 'Encoded value must use a tagged array');

    const [tag, ...parts] = current;
    if (tag === 'undefined' && parts.length === 0) return undefined;
    if (tag === 'null' && parts.length === 0) return null;
    if (tag === 'boolean' && parts.length === 1 && typeof parts[0] === 'boolean') return parts[0];
    if (tag === 'string' && parts.length === 1 && typeof parts[0] === 'string') {
      if (Buffer.byteLength(parts[0], 'utf8') > MAX_STRING_BYTES) fail('value_too_large', 'String exceeds the byte limit');
      return parts[0];
    }
    if (tag === 'number' && parts.length === 1 && typeof parts[0] === 'string') {
      const token = parts[0];
      if (token === 'NaN') return Number.NaN;
      if (token === 'Infinity') return Number.POSITIVE_INFINITY;
      if (token === '-Infinity') return Number.NEGATIVE_INFINITY;
      if (token === '-0') return -0;
      const number = Number(token);
      if (!Number.isFinite(number) || String(number) !== token) fail('invalid_value', 'Invalid number encoding');
      return number;
    }
    if (tag === 'bigint' && parts.length === 1 && typeof parts[0] === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(parts[0])) {
      return BigInt(parts[0]);
    }
    if (tag === 'reference' && parts.length === 1 && Number.isSafeInteger(parts[0]) && references.has(parts[0])) {
      return references.get(parts[0]);
    }
    if (tag === 'unserializable') {
      if (!allowUnserializable || parts.length !== 1 || !UNSERIALIZABLE_VALUE_KINDS.has(parts[0])) {
        fail('invalid_value', 'Unserializable sentinel is not allowed in this protocol direction');
      }
      return createUnserializableWorkerValue(parts[0]);
    }

    if (tag === 'array' || tag === 'object' || tag === 'null-object'
      || tag === 'frozen-object' || tag === 'frozen-null-object'
      || tag === 'map' || tag === 'error' || tag === 'noop-function') {
      const id = parts[0];
      if (!Number.isSafeInteger(id) || id !== nextReferenceId || references.has(id)) fail('invalid_value', 'Invalid graph reference definition');
      nextReferenceId += 1;

      if (tag === 'noop-function' && parts.length === 1) {
        const result = createNoopFunctionFixture();
        references.set(id, result);
        return result;
      }

      if (tag === 'array' && parts.length === 2 && Array.isArray(parts[1])) {
        if (parts[1].length > MAX_VALUE_NODES) fail('value_too_large', 'Array exceeds the element limit');
        const result = [];
        references.set(id, result);
        for (const item of parts[1]) result.push(decode(item, depth + 1));
        return result;
      }

      if ((tag === 'object' || tag === 'null-object' || tag === 'frozen-object' || tag === 'frozen-null-object')
        && parts.length === 2 && Array.isArray(parts[1])) {
        if (parts[1].length > MAX_VALUE_NODES) fail('value_too_large', 'Object exceeds the property limit');
        const nullPrototype = tag === 'null-object' || tag === 'frozen-null-object';
        const frozen = tag === 'frozen-object' || tag === 'frozen-null-object';
        const result = nullPrototype ? NATIVE_OBJECT_CREATE(null) : {};
        references.set(id, result);
        const seenKeys = new Set();
        for (const entry of parts[1]) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || seenKeys.has(entry[0])) {
            fail('invalid_value', 'Invalid object property encoding');
          }
          seenKeys.add(entry[0]);
          Object.defineProperty(result, entry[0], { value: decode(entry[1], depth + 1), enumerable: true, writable: true, configurable: true });
        }
        if (frozen) NATIVE_OBJECT_FREEZE(result);
        return result;
      }

      if (tag === 'map' && parts.length === 2 && Array.isArray(parts[1])) {
        if (parts[1].length > MAX_VALUE_NODES) fail('value_too_large', 'Map exceeds the entry limit');
        const result = new Map();
        references.set(id, result);
        for (const entry of parts[1]) {
          if (!Array.isArray(entry) || entry.length !== 2) fail('invalid_value', 'Invalid map entry encoding');
          result.set(decode(entry[0], depth + 1), decode(entry[1], depth + 1));
        }
        return result;
      }

      if (tag === 'error' && parts.length === 4 && typeof parts[1] === 'string' && typeof parts[2] === 'string') {
        const [, name, message, propertiesEncoding] = parts;
        const properties = decode(propertiesEncoding, depth + 1);
        if (!isRecord(properties)) fail('invalid_value', 'Error properties must be a plain object');
        const constructor = Object.hasOwn(errorConstructors, name) ? errorConstructors[name] : undefined;
        if (rejectUnknownErrorKinds && name !== 'Error' && name !== 'TypeError' && !constructor) {
          fail('unknown_error_kind', 'Error kind is not registered for this operation');
        }
        const result = constructor
          ? constructor({ name, message, properties })
          : name === 'TypeError'
            ? new NATIVE_TYPE_ERROR(message)
            : new NATIVE_ERROR(message);
        if (!(result instanceof Error)) fail('invalid_error_constructor', 'Registered error constructor did not return an Error');
        result.name = name;
        references.set(id, result);
        for (const [key, value] of Object.entries(properties)) {
          Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
        }
        return result;
      }
    }

    fail('invalid_value', `Unknown or malformed value tag: ${tag}`);
  }

  return decode(encoded, 0);
}

function validateRequestObject(request) {
  if (!hasExactKeys(request, REQUEST_KEYS)) fail('invalid_request', 'Request has missing or undeclared fields');
  if (request.schemaVersion !== WORKER_PROTOCOL_VERSION) fail('invalid_version', 'Unsupported worker protocol version');
  assertIdentifier(request.requestId, 'requestId');
  if (!isRegisteredTaskId(request.taskId)) fail('unknown_task', 'Task is not in the fixed operation registry');
  if (!Array.isArray(request.calls) || request.calls.length === 0 || request.calls.length > MAX_CALLS) {
    fail('invalid_calls', 'Request must contain a bounded non-empty call list');
  }
  const seenIds = new Set();
  for (const call of request.calls) {
    if (!hasExactKeys(call, REQUEST_CALL_KEYS)) fail('invalid_call', 'Call has missing or undeclared fields');
    assertIdentifier(call.callId, 'callId');
    assertIdentifier(call.operationId, 'operationId');
    if (seenIds.has(call.callId)) fail('duplicate_call_id', 'Call IDs must be unique');
    seenIds.add(call.callId);
    if (!getTaskOperation(request.taskId, call.operationId)) fail('unknown_operation', 'Operation is not registered for this task');
    const args = decodeValue(call.args, { rejectUnknownErrorKinds: false });
    if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) fail('invalid_arguments', 'Call arguments must be a bounded array');
  }
  assertJsonByteLimit(request, MAX_REQUEST_BYTES, 'request_too_large', 'Request');
  return request;
}

function validateResponseObject(response, request) {
  if (!hasExactKeys(response, RESPONSE_KEYS)) fail('invalid_response', 'Response has missing or undeclared fields');
  if (response.schemaVersion !== WORKER_PROTOCOL_VERSION) fail('invalid_version', 'Unsupported worker protocol version');
  if (response.requestId !== request.requestId || response.taskId !== request.taskId) {
    fail('correlation_mismatch', 'Response does not match its request');
  }
  if (!Array.isArray(response.results) || response.results.length !== request.calls.length) {
    fail('invalid_results', 'Response must contain one result for each requested call');
  }
  for (let index = 0; index < response.results.length; index += 1) {
    const result = response.results[index];
    const requestCall = request.calls[index];
    if (!isRecord(result) || result.callId !== requestCall.callId || typeof result.ok !== 'boolean') {
      fail('invalid_result', 'Response result does not match the requested call order');
    }
    const keys = result.ok ? RESPONSE_SUCCESS_KEYS : RESPONSE_FAILURE_KEYS;
    if (!hasExactKeys(result, keys)) fail('invalid_result', 'Result has missing or undeclared fields');
    const argsAfter = decodeValue(result.argsAfter, { allowUnserializable: true });
    const argsBefore = decodeValue(requestCall.args);
    if (!Array.isArray(argsAfter) || argsAfter.length !== argsBefore.length) fail('invalid_result', 'Result argument state does not match the request');
    if (result.ok) {
      if (!Array.isArray(result.sameAsArgs) || result.sameAsArgs.length !== argsBefore.length
        || result.sameAsArgs.some((value) => typeof value !== 'boolean')) {
        fail('invalid_result', 'Result identity observations do not match the request arguments');
      }
      decodeValue(result.value, { allowUnserializable: true });
    } else decodeValue(result.error, { allowUnserializable: true });
  }
  assertJsonByteLimit(response, MAX_RESPONSE_BYTES, 'response_too_large', 'Response');
  return response;
}

export function createWorkerRequest({ taskId, calls, requestId = randomUUID(), ...extra }) {
  if (Object.keys(extra).length > 0) fail('invalid_request', 'Request builder received undeclared fields');
  if (!Array.isArray(calls)) fail('invalid_calls', 'Calls must be an array');
  const request = {
    schemaVersion: WORKER_PROTOCOL_VERSION,
    requestId,
    taskId,
    calls: calls.map((call, index) => {
      if (!isRecord(call)) fail('invalid_call', 'Call must be an object');
      const allowedKeys = ['callId', 'operationId', 'args'];
      if (Object.keys(call).some((key) => !allowedKeys.includes(key))) fail('invalid_call', 'Call has undeclared fields');
      return {
        callId: call.callId ?? `c${index}`,
        operationId: call.operationId,
        args: encodeValue(call.args ?? []),
      };
    }),
  };
  validateRequestObject(request);
  return request;
}

export function serializeWorkerRequest(request) {
  validateRequestObject(request);
  return assertJsonByteLimit(request, MAX_REQUEST_BYTES, 'request_too_large', 'Request');
}

export function parseWorkerRequest(input) {
  let text;
  try {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    if (bytes.byteLength > MAX_REQUEST_BYTES) fail('request_too_large', 'Request exceeds its byte limit');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof WorkerProtocolError) throw error;
    fail('invalid_request_encoding', 'Request is not valid UTF-8');
  }
  let request;
  try { request = JSON.parse(text); }
  catch { fail('invalid_request_json', 'Request is not valid JSON'); }
  validateRequestObject(request);
  return request;
}

export function createWorkerResponse(request, outcomes) {
  validateRequestObject(request);
  if (!Array.isArray(outcomes) || outcomes.length !== request.calls.length) fail('invalid_results', 'Outcome count must match calls');
  const response = {
    schemaVersion: WORKER_PROTOCOL_VERSION,
    requestId: request.requestId,
    taskId: request.taskId,
    results: outcomes.map((outcome, index) => {
      const requestCall = request.calls[index];
      if (!isRecord(outcome) || outcome.callId !== requestCall.callId || typeof outcome.ok !== 'boolean') {
        fail('invalid_result', 'Outcome does not match its requested call');
      }
      if (!Array.isArray(outcome.argsAfter)) fail('invalid_result', 'Outcome must return argument state');
      if (outcome.ok && (!Array.isArray(outcome.sameAsArgs)
        || outcome.sameAsArgs.length !== decodeValue(requestCall.args).length
        || outcome.sameAsArgs.some((value) => typeof value !== 'boolean'))) {
        fail('invalid_result', 'Successful outcome must return bounded identity observations');
      }
      return outcome.ok
        ? {
          callId: outcome.callId,
          ok: true,
          argsAfter: encodeCandidateOutputValue(outcome.argsAfter),
          sameAsArgs: [...outcome.sameAsArgs],
          value: encodeCandidateOutputValue(outcome.value),
        }
        : {
          callId: outcome.callId,
          ok: false,
          argsAfter: encodeCandidateOutputValue(outcome.argsAfter),
          error: encodeCandidateOutputValue(outcome.error),
        };
    }),
  };
  validateResponseObject(response, request);
  return response;
}

export function serializeWorkerResponse(response, request) {
  validateResponseObject(response, request);
  return assertJsonByteLimit(response, MAX_RESPONSE_BYTES, 'response_too_large', 'Response');
}

export function parseWorkerResponse(input, request) {
  let text;
  try {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    if (bytes.byteLength > MAX_RESPONSE_BYTES) fail('response_too_large', 'Response exceeds its byte limit');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof WorkerProtocolError) throw error;
    fail('invalid_response_encoding', 'Response is not valid UTF-8');
  }
  let response;
  try { response = JSON.parse(text); }
  catch { fail('invalid_response_json', 'Response is not valid JSON'); }
  validateResponseObject(response, request);
  return Object.freeze({
    schemaVersion: response.schemaVersion,
    requestId: response.requestId,
    taskId: response.taskId,
    results: Object.freeze(response.results.map((result) => Object.freeze({
      callId: result.callId,
      ok: result.ok,
      argsAfter: decodeValue(result.argsAfter, { allowUnserializable: true }),
      ...(result.ok
        ? {
          sameAsArgs: Object.freeze([...result.sameAsArgs]),
          value: decodeValue(result.value, { allowUnserializable: true }),
        }
        : { error: decodeValue(result.error, { allowUnserializable: true }) }),
    }))),
  });
}
