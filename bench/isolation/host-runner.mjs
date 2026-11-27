import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_RESPONSE_BYTES,
  createWorkerRequest,
  parseWorkerResponse,
  serializeWorkerRequest,
} from './protocol.mjs';

const MAX_TASK_TIMEOUT_MS = 600_000;
const MAX_HOST_REQUEST_BYTES = 131_072;
const MAX_HOST_STDOUT_BYTES = (MAX_RESPONSE_BYTES * 2) + 65_536;
const MAX_HOST_STDERR_BYTES = 65_536;
const HOST_BRIDGE_VERSION = 1;
const WORKER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT_PATH = path.resolve(WORKER_DIRECTORY, 'run-worker.ps1');

export class IsolatedWorkerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'IsolatedWorkerError';
    this.code = code;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0 || !path.isAbsolute(workspaceRoot)) {
    throw new IsolatedWorkerError('invalid_workspace', 'Workspace root must be an absolute path');
  }
  return path.resolve(workspaceRoot);
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TASK_TIMEOUT_MS) {
    throw new IsolatedWorkerError('invalid_timeout', 'Worker timeout is outside the supported range');
  }
}

function appendBounded(chunks, chunk, maximum, label, state) {
  const nextBytes = state.bytes + chunk.byteLength;
  if (nextBytes > maximum) throw new IsolatedWorkerError(`${label}_too_large`, `${label} exceeds its byte limit`);
  chunks.push(Buffer.from(chunk));
  state.bytes = nextBytes;
}

function parseHostEnvelope(output) {
  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch {
    throw new IsolatedWorkerError('invalid_launcher_response', 'Launcher did not return valid JSON');
  }
  const keys = [
    'schema_version', 'state', 'exit_code', 'timed_out', 'job_drained',
    'worker_token_verified', 'job_membership_verified', 'output_truncated',
    'profile_cleanup_verified', 'staging_cleanup_verified', 'response_json', 'failure_code',
  ];
  if (!isObject(envelope) || Object.keys(envelope).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new IsolatedWorkerError('invalid_launcher_response', 'Launcher response has undeclared fields');
  }
  if (envelope.schema_version !== HOST_BRIDGE_VERSION
    || !['completed', 'timeout', 'failed'].includes(envelope.state)
    || typeof envelope.timed_out !== 'boolean'
    || typeof envelope.job_drained !== 'boolean'
    || typeof envelope.worker_token_verified !== 'boolean'
    || typeof envelope.job_membership_verified !== 'boolean'
    || typeof envelope.output_truncated !== 'boolean'
    || typeof envelope.profile_cleanup_verified !== 'boolean'
    || typeof envelope.staging_cleanup_verified !== 'boolean'
    || !(envelope.response_json === null || typeof envelope.response_json === 'string')
    || !(envelope.failure_code === null || typeof envelope.failure_code === 'string')) {
    throw new IsolatedWorkerError('invalid_launcher_response', 'Launcher response has invalid fields');
  }
  return envelope;
}

export function parseLauncherStdout(input) {
  let output;
  try {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    output = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new IsolatedWorkerError('invalid_launcher_encoding', 'Launcher output is not valid UTF-8');
  }
  return parseHostEnvelope(output);
}

function parsePowerShellExecutable() {
  if (process.platform !== 'win32') throw new IsolatedWorkerError('platform_unsupported');
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (typeof systemRoot !== 'string' || !path.isAbsolute(systemRoot)) {
    throw new IsolatedWorkerError('runtime_unavailable', 'Windows SystemRoot is unavailable');
  }
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function invokeFixedPowerShell({ workspaceRoot, nodePath, requestJson, timeoutMs }) {
  const executable = parsePowerShellExecutable();
  const payloadJson = JSON.stringify({
    schemaVersion: HOST_BRIDGE_VERSION,
    workspaceRoot,
    nodePath,
    timeoutMs,
    requestJson,
  });
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_HOST_REQUEST_BYTES) {
    throw new IsolatedWorkerError('host_request_too_large');
  }
  const payload = Buffer.from(payloadJson, 'utf8').toString('base64');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', WORKER_SCRIPT_PATH,
      ], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new IsolatedWorkerError('launcher_start_failed'));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    let overflow = false;
    let hostTimedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      hostTimedOut = true;
      child.kill();
    }, timeoutMs + 30_000);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    child.stdout.on('data', (chunk) => {
      try { appendBounded(stdoutChunks, chunk, MAX_HOST_STDOUT_BYTES, 'launcher_stdout', stdoutState); }
      catch { overflow = true; child.kill(); }
    });
    child.stderr.on('data', (chunk) => {
      try { appendBounded(stderrChunks, chunk, MAX_HOST_STDERR_BYTES, 'launcher_stderr', stderrState); }
      catch { overflow = true; child.kill(); }
    });
    child.once('error', () => finish(new IsolatedWorkerError('launcher_start_failed')));
    child.once('close', (exitCode) => {
      if (hostTimedOut) return finish(new IsolatedWorkerError('launcher_timeout'));
      if (overflow) return finish(new IsolatedWorkerError('launcher_output_limit'));
      if (exitCode !== 0) return finish(new IsolatedWorkerError('launcher_failed'));
      const stdout = Buffer.concat(stdoutChunks);
      try { finish(null, parseLauncherStdout(stdout)); }
      catch (error) { finish(error); }
    });

    child.stdin.once('error', () => {
      if (!settled) {
        overflow = true;
        child.kill();
      }
    });
    child.stdin.end(`${payload}\n`, 'ascii');
  });
}

function validateLauncherResult(result) {
  if (!isObject(result)) throw new IsolatedWorkerError('invalid_launcher_response');
  if (result.state === 'timeout') {
    if (result.timed_out !== true || result.job_drained !== true) {
      throw new IsolatedWorkerError('job_drain_unverified');
    }
    if (result.profile_cleanup_verified !== true || result.staging_cleanup_verified !== true) {
      throw new IsolatedWorkerError('cleanup_unverified');
    }
    throw new IsolatedWorkerError('timeout');
  }
  if (result.state !== 'completed'
    || result.exit_code !== 0
    || result.timed_out !== false
    || result.job_drained !== true
    || result.worker_token_verified !== true
    || result.job_membership_verified !== true
    || result.output_truncated !== false
    || result.profile_cleanup_verified !== true
    || result.staging_cleanup_verified !== true
    || typeof result.response_json !== 'string') {
    throw new IsolatedWorkerError(result.failure_code ?? 'isolation_runner_failure');
  }
}

/**
 * Create a fixed PowerShell/AppContainer JSON bridge. Production callers must inject a trusted
 * workspace-manager/evaluator authorizer for disposable roots; neither CLI nor model input may
 * choose this callback or a workspace path. Tests may inject only the host transport.
 */
export function createIsolatedWorkerRunner({ transport = invokeFixedPowerShell, authorizeWorkspace } = {}) {
  if (typeof transport !== 'function') throw new TypeError('transport must be a function');
  if (typeof authorizeWorkspace !== 'function') throw new TypeError('trusted workspace authorizer is required');

  return async function runWorkerBatch({ workspaceRoot, taskId, calls, timeoutMs }) {
    const absoluteWorkspaceRoot = validateWorkspaceRoot(workspaceRoot);
    validateTimeout(timeoutMs);
    const request = createWorkerRequest({ taskId, calls });
    if (await authorizeWorkspace({ workspaceRoot: absoluteWorkspaceRoot, taskId }) !== true) {
      throw new IsolatedWorkerError('workspace_not_authorized');
    }
    const requestJson = serializeWorkerRequest(request);
    const transportResult = await transport({
      workspaceRoot: absoluteWorkspaceRoot,
      nodePath: process.execPath,
      timeoutMs,
      requestJson,
    });
    validateLauncherResult(transportResult);
    const response = parseWorkerResponse(transportResult.response_json, request);
    return Object.freeze({
      request,
      results: response.results,
      evidence: Object.freeze({
        jobDrained: transportResult.job_drained,
        workerTokenVerified: transportResult.worker_token_verified,
        jobMembershipVerified: transportResult.job_membership_verified,
      }),
    });
  };
}
