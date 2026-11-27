import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAX_REQUEST_BYTES,
  WorkerProtocolError,
  createWorkerResponse,
  parseWorkerRequest,
  serializeWorkerRequest,
  serializeWorkerResponse,
  decodeValue,
} from './protocol.mjs';
import { getTaskOperation } from './task-operations.mjs';

const NATIVE_OBJECT_IS = Object.is;
const MAX_WORKER_REQUEST_BYTES = MAX_REQUEST_BYTES;
const SAFE_WORKER_ERROR_CODES = Object.freeze([
  'correlation_mismatch',
  'cyclic_error_properties',
  'duplicate_call_id',
  'invalid_arguments',
  'invalid_call',
  'invalid_calls',
  'invalid_error_constructor',
  'invalid_error_registry',
  'invalid_identifier',
  'invalid_module_path',
  'invalid_operation',
  'invalid_registry',
  'invalid_request',
  'invalid_request_encoding',
  'invalid_request_json',
  'invalid_response',
  'invalid_response_encoding',
  'invalid_response_json',
  'invalid_result',
  'invalid_results',
  'invalid_value',
  'invalid_version',
  'invalid_worker_input',
  'invalid_workspace',
  'missing_export',
  'module_path_denied',
  'reparse_path_denied',
  'request_too_large',
  'response_too_large',
  'unknown_error_kind',
  'unknown_operation',
  'unknown_task',
  'unsupported_value',
  'value_too_deep',
  'value_too_large',
]);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateRegistryPath(modulePath) {
  if (typeof modulePath !== 'string' || modulePath.length === 0 || path.isAbsolute(modulePath)) {
    throw new WorkerProtocolError('invalid_registry', 'Registered module path is invalid');
  }
  const components = modulePath.split('/');
  if (components.some((component) => !component || component === '.' || component === '..' || component.includes('\\'))) {
    throw new WorkerProtocolError('invalid_registry', 'Registered module path is invalid');
  }
  return components;
}

async function resolveCandidateModule(workspaceRoot, modulePath) {
  const root = path.resolve(workspaceRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WorkerProtocolError('invalid_workspace', 'Workspace root is not an ordinary directory');
  }

  let current = root;
  const components = validateRegistryPath(modulePath);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    if (!isWithin(root, current)) {
      throw new WorkerProtocolError('module_path_denied', 'Candidate module path escapes the workspace');
    }
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new WorkerProtocolError('reparse_path_denied', 'Candidate module path contains a symbolic link');
    }
    const isLast = index === components.length - 1;
    if (isLast ? !info.isFile() : !info.isDirectory()) {
      throw new WorkerProtocolError('invalid_module_path', 'Candidate module path has an unexpected file type');
    }
  }

  return current;
}

async function importCandidateModule(workspaceRoot, modulePath, importModule) {
  const resolved = await resolveCandidateModule(workspaceRoot, modulePath);
  return importModule(pathToFileURL(resolved).href);
}

async function createErrorConstructors(workspaceRoot, operation, importModule) {
  const specifications = operation.errorConstructors;
  if (!specifications) return Object.create(null);

  const constructors = Object.create(null);
  for (const [errorName, specification] of Object.entries(specifications)) {
    const module = await importCandidateModule(workspaceRoot, specification.modulePath, importModule);
    const ErrorConstructor = Object.hasOwn(module, specification.exportName)
      ? module[specification.exportName]
      : undefined;
    if (typeof ErrorConstructor !== 'function' || !Array.isArray(specification.argumentOrder)) {
      throw new WorkerProtocolError('invalid_error_registry', 'Registered error constructor is invalid');
    }
    constructors[errorName] = ({ message, properties }) => {
      const args = specification.argumentOrder.map((key) => key === 'message' ? message : properties[key]);
      return new ErrorConstructor(...args);
    };
  }
  return constructors;
}

/** Execute one already-registered operation batch inside the isolated worker process. */
export async function executeWorkerRequest(requestInput, {
  workspaceRoot = process.cwd(),
  importModule = (url) => import(url),
} = {}) {
  const requestJson = typeof requestInput === 'string' || Buffer.isBuffer(requestInput)
    ? requestInput
    : serializeWorkerRequest(requestInput);
  const request = parseWorkerRequest(requestJson);
  const outcomes = [];

  for (const call of request.calls) {
    const operation = getTaskOperation(request.taskId, call.operationId);
    if (!operation) throw new WorkerProtocolError('unknown_operation', 'Operation is not registered for this task');

    const errorConstructors = await createErrorConstructors(workspaceRoot, operation, importModule);
    const args = decodeValue(call.args, {
      errorConstructors,
      rejectUnknownErrorKinds: true,
    });
    const candidateModule = await importCandidateModule(workspaceRoot, operation.modulePath, importModule);
    const exported = Object.hasOwn(candidateModule, operation.exportName)
      ? candidateModule[operation.exportName]
      : undefined;
    if (exported === undefined) {
      throw new WorkerProtocolError('missing_export', 'Registered candidate export is unavailable');
    }

    if (operation.kind === 'read-export') {
      outcomes.push({ callId: call.callId, ok: true, argsAfter: args, sameAsArgs: [], value: exported });
      continue;
    }
    if (operation.kind !== 'call' || typeof exported !== 'function') {
      throw new WorkerProtocolError('invalid_operation', 'Registered candidate operation is not callable');
    }

    try {
      const value = await exported(...args);
      const sameAsArgs = args.map((argument) => NATIVE_OBJECT_IS(value, argument));
      outcomes.push({ callId: call.callId, ok: true, argsAfter: args, sameAsArgs, value });
    } catch (error) {
      const safeError = error instanceof Error ? error : new Error('Candidate operation threw a non-Error value');
      outcomes.push({ callId: call.callId, ok: false, argsAfter: args, error: safeError });
    }
  }

  return createWorkerResponse(request, outcomes);
}

export function parseWorkerStdin(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.byteLength > MAX_REQUEST_BYTES + 1) {
    throw new WorkerProtocolError('request_too_large', 'Worker input exceeds its byte limit');
  }
  const hasTransportNewline = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0a;
  const requestBytes = hasTransportNewline ? bytes.subarray(0, -1) : bytes;
  if (requestBytes.byteLength > MAX_REQUEST_BYTES || requestBytes.includes(0x0a) || requestBytes.includes(0x0d)) {
    throw new WorkerProtocolError('invalid_worker_input', 'Worker input has excess trailing data');
  }
  return parseWorkerRequest(requestBytes);
}

async function readBoundedRequest() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    byteLength += chunk.byteLength;
    if (byteLength > MAX_WORKER_REQUEST_BYTES + 1) {
      throw new WorkerProtocolError('request_too_large', 'Worker input exceeds its byte limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, byteLength);
}

function writeAndFlush(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => error ? reject(error) : resolve());
  });
}

function releaseStdio() {
  if (typeof process.stdin.pause === 'function') process.stdin.pause();
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    if (typeof stream.unref === 'function') stream.unref();
  }
}

export function safeWorkerErrorCode(error) {
  try {
    if (!(error instanceof WorkerProtocolError)) return 'worker_failure';
    const code = error.code;
    return SAFE_WORKER_ERROR_CODES.includes(code) ? code : 'worker_failure';
  } catch {
    return 'worker_failure';
  }
}

export async function main() {
  try {
    const request = parseWorkerStdin(await readBoundedRequest());
    const response = await executeWorkerRequest(request);
    const responseJson = serializeWorkerResponse(response, request);
    await writeAndFlush(process.stdout, responseJson);
    releaseStdio();
  } catch (error) {
    const code = safeWorkerErrorCode(error);
    process.exitCode = 2;
    try {
      await writeAndFlush(process.stderr, `isolated_worker_failed:${code}\n`);
    } catch {
      // Keep the sanitized exit code when stderr itself is unavailable.
    }
    releaseStdio();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
