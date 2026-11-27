import { spawn } from 'node:child_process';
import fileSystem, { closeSync, openSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyAccessError, MAX_PROBE_REQUEST_BYTES, parseProbeRequest } from './probe-contract.mjs';

async function readRequest() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_PROBE_REQUEST_BYTES) throw new Error('Probe request exceeds the byte limit');
    chunks.push(chunk);
  }
  return parseProbeRequest(Buffer.concat(chunks, length));
}

function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(error.code) ? error.code : 'UNKNOWN';
}

const PROCESS_TREE_STARTUP_TIMEOUT_MS = 8_000;
const PROCESS_TREE_MAX_READINESS_BYTES = 2_048;
const PROCESS_TREE_SPAWN_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EPIPE', 'ETIMEDOUT', 'EINVAL']);
const PROCESS_TREE_READINESS_CODES = new Set([
  'NONE', 'CHILD_SPAWN_FAILED', 'CHILD_SPAWN_TIMEOUT', 'CHILD_START_TIMEOUT',
  'CHILD_WORKER_EXITED', 'CHILD_STREAM_ERROR', 'CHILD_OUTPUT_LIMIT', 'CHILD_READINESS_INVALID',
  'GRANDCHILD_SPAWN_FAILED', 'GRANDCHILD_SPAWN_TIMEOUT', 'GRANDCHILD_START_TIMEOUT',
  'GRANDCHILD_WORKER_EXITED', 'GRANDCHILD_STREAM_ERROR', 'GRANDCHILD_OUTPUT_LIMIT',
  'GRANDCHILD_READINESS_INVALID',
]);
const PROCESS_TREE_SPAWN_CODE_VALUES = new Set([
  'NONE', 'SPAWN_TIMEOUT', 'EACCES', 'EPERM', 'ENOENT', 'EPIPE', 'ETIMEDOUT', 'EINVAL', 'UNKNOWN',
]);
const PROCESS_TREE_PHASE_MARKERS = new Set([
  'PROBE_REQUEST_RECEIVED', 'PROCESS_TREE_REQUEST_DISPATCH', 'CHILD_SPAWN_CALL_BEGIN',
  'CHILD_SPAWN_CALL_RETURN',
  'CHILD_SPAWN_CALL_THROW', 'CHILD_SPAWN_EVENT', 'CHILD_SPAWN_ERROR', 'CHILD_SPAWN_TIMEOUT',
  'CHILD_WORKER_START_WAIT', 'CHILD_WORKER_READY', 'GRANDCHILD_START_WAIT', 'CHILD_READINESS_RESPONSE',
  'PROCESS_TREE_RESPONSE_BEGIN', 'PROCESS_TREE_RESPONSE_FLUSHED',
]);

export const PROCESS_TREE_CHILD_READY_FILE = 'pt-child-ready.jsonl';
export const PROCESS_TREE_GRANDCHILD_READY_FILE = 'pt-grandchild-ready.jsonl';

// Fixed readiness files live only in the disposable workspace (process.cwd()).
export function processTreeReadyFilePath(fileName) {
  if (fileName !== PROCESS_TREE_CHILD_READY_FILE && fileName !== PROCESS_TREE_GRANDCHILD_READY_FILE) {
    throw new TypeError('Unsupported process-tree readiness file');
  }
  return path.join(process.cwd(), fileName);
}

// Self-contained so the same source also runs inside the CommonJS child script.
// Polls every 25 ms, reads only bytes appended after a tracked offset, and
// returns one JSON line per call with the pipe reader's status and code values.
export function createFileLineReader(fs, file, exited, single) {
  let offset = 0;
  let buf = Buffer.alloc(0);
  let term = null;
  let busy = false;
  const fail = code => ({ status: 'FAIL', code });
  const append = () => {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const want = Math.min(fs.fstatSync(fd).size - offset, 4097 - buf.length);
      if (want > 0) {
        const chunk = Buffer.alloc(want);
        const count = fs.readSync(fd, chunk, 0, want, offset);
        offset += count;
        buf = Buffer.concat([buf, chunk.subarray(0, count)]);
      }
      return null;
    } catch (error) {
      return error.code === 'ENOENT' && !offset ? null : 'STREAM_ERROR';
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch {}
    }
  };
  const take = () => {
    if (term) return fail(term);
    const end = buf.indexOf(10);
    if (end < 0) return buf.length > 2048 ? fail(term = 'OUTPUT_LIMIT') : null;
    const line = buf.subarray(0, end);
    buf = buf.subarray(end + 1);
    if (line.length > 2048) return fail('OUTPUT_LIMIT');
    if (single && buf.length) return fail('INVALID_JSON');
    try { return { status: 'PASS', value: JSON.parse(line.toString()) }; }
    catch { return fail('INVALID_JSON'); }
  };
  return ms => new Promise(resolve => {
    if (busy) return resolve(fail('READER_BUSY'));
    busy = true;
    const deadline = Date.now() + ms;
    const poll = () => {
      const dead = exited();
      const error = term ? null : append();
      const result = take() || (error ? fail(term = error) : dead ? fail('STREAM_CLOSED')
        : Date.now() >= deadline ? { status: 'UNKNOWN', code: 'READINESS_TIMEOUT' } : null);
      if (!result) return void setTimeout(poll, 25);
      busy = false;
      resolve(result);
    };
    poll();
  });
}

const FILE_LINE_READER_SOURCE = createFileLineReader.toString().replace(/\r?\n[ \t]*/gu, '\n');

export const PROCESS_TREE_GRANDCHILD_SCRIPT = String.raw`
const role = process.argv[1];
if (role !== 'grandchild' && role !== 'grandchild-test') process.exit(2);
const line = JSON.stringify({ mode: 'process-tree-grandchild-ready' }) + '\n';
if (role === 'grandchild') {
  const fs = require('node:fs');
  const fd = fs.openSync(require('node:path').join(process.cwd(), 'pt-grandchild-ready.jsonl'), 'wx');
  fs.writeSync(fd, line);
  setInterval(() => fd, 1000);
} else process.stdout.write(line, () => process.exit(0));
`;

// Leading indentation is dropped so the pinned host-test input stays under its byte limit.
export const PROCESS_TREE_CHILD_SCRIPT = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const STARTUP_TIMEOUT_MS = 8000;
const MAX_READINESS_BYTES = 2048;
const SPAWN_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EPIPE', 'ETIMEDOUT', 'EINVAL']);
const role = process.argv[1];
const grandchildScript = process.argv[2];
const grandchildRole = process.argv[3];
const testRole = role === 'child-test';
if ((role !== 'child' && !testRole) || typeof grandchildScript !== 'string' || grandchildScript.length > 4096 ||
    grandchildRole !== (testRole ? 'grandchild-test' : 'grandchild')) process.exit(2);
const deadline = Date.now() + STARTUP_TIMEOUT_MS;
const remaining = () => Math.max(0, deadline - Date.now());
const emit = value => new Promise(resolve => process.stdout.write(JSON.stringify(value) + '\n', resolve));
const pidOf = child => Number.isSafeInteger(child && child.pid) && child.pid > 0 ? child.pid : null;
const spawnCode = error => error && SPAWN_CODES.has(error.code) ? error.code : 'UNKNOWN';
const waitForSpawn = (child, timeoutMs) => new Promise(resolve => {
  const timer = setTimeout(resolve, timeoutMs, { status: 'UNKNOWN', code: 'SPAWN_TIMEOUT' });
  const finish = result => { clearTimeout(timer); resolve(result); };
  child.once('spawn', () => finish({ status: 'PASS', code: 'NONE' }));
  child.once('error', error => finish({ status: 'FAIL', code: spawnCode(error) }));
});
function readJsonLine(stream, timeoutMs) {
  return new Promise(resolve => {
    let buffer = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.removeListener('end', onEnd);
      resolve(result);
    };
    const onData = chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_READINESS_BYTES) {
        finish({ status: 'FAIL', code: 'OUTPUT_LIMIT' });
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      if (end !== buffer.length - 1) {
        finish({ status: 'FAIL', code: 'INVALID_JSON' });
        return;
      }
      try { finish({ status: 'PASS', value: JSON.parse(buffer.slice(0, end)) }); }
      catch { finish({ status: 'FAIL', code: 'INVALID_JSON' }); }
    };
    const onError = () => finish({ status: 'FAIL', code: 'STREAM_ERROR' });
    const onEnd = () => finish({ status: 'FAIL', code: 'STREAM_CLOSED' });
    const timer = setTimeout(() => finish({ status: 'UNKNOWN', code: 'READINESS_TIMEOUT' }), timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
  });
}
const waitForExit = (child, timeoutMs) => Number.isInteger(child.exitCode) ? Promise.resolve(child.exitCode)
  : new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs, null);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
${FILE_LINE_READER_SOURCE}
function mapReadinessCode(status, code, prefix) {
  if (status === 'PASS') return 'NONE';
  if (code === 'READINESS_TIMEOUT') return prefix + '_START_TIMEOUT';
  if (code === 'STREAM_CLOSED') return prefix + '_WORKER_EXITED';
  if (code === 'STREAM_ERROR') return prefix + '_STREAM_ERROR';
  if (code === 'OUTPUT_LIMIT') return prefix + '_OUTPUT_LIMIT';
  return prefix + '_READINESS_INVALID';
}
async function main() {
  await emit({ mode: 'process-tree-progress', stage: 'CHILD_WORKER_STARTED' });
  let grandchild = null;
  let grandchildExited = false;
  let spawnResult = { status: 'FAIL', code: 'UNKNOWN' };
  const readyPath = path.join(process.cwd(), 'pt-grandchild-ready.jsonl');
  try {
    if (!testRole && fs.existsSync(readyPath)) throw new Error('stale');
    grandchild = spawn(process.execPath, ['-e', grandchildScript, grandchildRole], {
      detached: false,
      stdio: ['ignore', testRole ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
    });
    grandchild.once('exit', () => { grandchildExited = true; });
  } catch (error) {
    spawnResult = { status: 'FAIL', code: spawnCode(error) };
  }
  if (grandchild) spawnResult = await waitForSpawn(grandchild, remaining());
  const grandchildPid = pidOf(grandchild);
  await emit({
    mode: 'process-tree-progress',
    stage: 'GRANDCHILD_SPAWN_RESULT',
    grandchild_spawn_status: spawnResult.status,
    grandchild_spawn_code: spawnResult.code,
    grandchild_pid: grandchildPid,
  });
  let grandchildStarted = false;
  let readinessStage = 'GRANDCHILD_SPAWN';
  let readinessStatus = spawnResult.status;
  let readinessCode = spawnResult.status === 'FAIL'
    ? 'GRANDCHILD_SPAWN_FAILED'
    : spawnResult.status === 'UNKNOWN' ? 'GRANDCHILD_SPAWN_TIMEOUT' : 'NONE';
  if (spawnResult.status === 'PASS') {
    readinessStage = 'GRANDCHILD_WORKER';
    const ready = testRole
      ? await readJsonLine(grandchild.stdout, remaining())
      : await createFileLineReader(fs, readyPath, () => grandchildExited, true)(remaining());
    if (ready.status === 'PASS' && ready.value && ready.value.mode === 'process-tree-grandchild-ready' &&
        Object.keys(ready.value).length === 1) {
      grandchildStarted = true;
      readinessStage = 'READY';
      readinessStatus = 'PASS';
      readinessCode = 'NONE';
    } else {
      readinessStatus = ready.status;
      readinessCode = mapReadinessCode(ready.status, ready.code, 'GRANDCHILD');
    }
    if (!testRole) try { fs.unlinkSync(readyPath); } catch {}
  }
  await emit({
    mode: 'process-tree-child-ready',
    grandchild_spawn_status: spawnResult.status,
    grandchild_spawn_code: spawnResult.code,
    grandchild_worker_started: grandchildStarted,
    grandchild_pid: grandchildPid,
    readiness_stage: readinessStage,
    readiness_status: readinessStatus,
    readiness_code: readinessCode,
  });
  if (testRole) {
    if (!grandchild || await waitForExit(grandchild, remaining()) !== 0) process.exitCode = 1;
    return;
  }
  await new Promise(() => setInterval(() => {}, 1000));
}
main().catch(() => { process.exitCode = 2; });
`.replace(/\n[ \t]+/gu, '\n');

export function buildProcessTreeChildArguments(role) {
  if (role !== 'child' && role !== 'child-test') throw new TypeError('Unsupported process-tree child role');
  const grandchildRole = role === 'child-test' ? 'grandchild-test' : 'grandchild';
  return ['-e', PROCESS_TREE_CHILD_SCRIPT, role, PROCESS_TREE_GRANDCHILD_SCRIPT, grandchildRole];
}

function emitPhaseMarker(stage, enabled) {
  if (!enabled || !PROCESS_TREE_PHASE_MARKERS.has(stage)) return Promise.resolve();
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify({ agentcp_stage: stage })}\n`, resolve);
  });
}

function processTreeErrorCode(error) {
  const code = errorCode(error);
  return PROCESS_TREE_SPAWN_CODES.has(code) ? code : 'UNKNOWN';
}

function processTreePid(child) {
  return Number.isSafeInteger(child?.pid) && child.pid > 0 ? child.pid : null;
}

function waitForSpawn(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('spawn', onSpawn);
      child.off('error', onError);
      resolve(result);
    };
    const onSpawn = () => finish({ status: 'PASS', code: 'NONE' });
    const onError = (error) => finish({ status: 'FAIL', code: processTreeErrorCode(error) });
    const timer = setTimeout(() => finish({ status: 'UNKNOWN', code: 'SPAWN_TIMEOUT' }), timeoutMs);
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

// Pipe reader for trusted host-only roles and tests; AppContainer roles use createFileLineReader.
export function createJsonLineReader(stream) {
  let buffer = '';
  let terminalCode = null;
  let waiter = null;
  stream.setEncoding('utf8');

  const flush = () => {
    if (!waiter) return;
    const lineEnd = buffer.indexOf('\n');
    let result = null;
    if (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (Buffer.byteLength(line, 'utf8') > PROCESS_TREE_MAX_READINESS_BYTES) {
        result = { status: 'FAIL', code: 'OUTPUT_LIMIT' };
      } else {
        try { result = { status: 'PASS', value: JSON.parse(line) }; }
        catch { result = { status: 'FAIL', code: 'INVALID_JSON' }; }
      }
    } else if (buffer.length > PROCESS_TREE_MAX_READINESS_BYTES) {
      buffer = '';
      result = { status: 'FAIL', code: 'OUTPUT_LIMIT' };
    } else if (terminalCode) {
      result = { status: 'FAIL', code: terminalCode };
    }
    if (result) {
      const current = waiter;
      waiter = null;
      clearTimeout(current.timer);
      current.resolve(result);
    }
  };

  stream.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > PROCESS_TREE_MAX_READINESS_BYTES * 2) {
      buffer = '';
      terminalCode = 'OUTPUT_LIMIT';
    }
    flush();
  });
  stream.on('error', () => { terminalCode = 'STREAM_ERROR'; flush(); });
  stream.on('end', () => { terminalCode = 'STREAM_CLOSED'; flush(); });

  return (timeoutMs) => new Promise((resolve) => {
    if (waiter) {
      resolve({ status: 'FAIL', code: 'READER_BUSY' });
      return;
    }
    waiter = {
      resolve,
      timer: setTimeout(() => {
        const current = waiter;
        if (!current) return;
        waiter = null;
        current.resolve({ status: 'UNKNOWN', code: 'READINESS_TIMEOUT' });
      }, timeoutMs),
    };
    flush();
  });
}

async function probeRead(filePath) {
  try {
    await readFile(filePath);
    return { status: 'ALLOWED', code: 'READ_ALLOWED' };
  } catch (error) {
    const code = errorCode(error);
    return { status: classifyAccessError(code), code };
  }
}

async function probeWrite(filePath, marker) {
  let created = false;
  try {
    await writeFile(filePath, marker, { flag: 'wx' });
    created = true;
    return { status: 'ALLOWED', code: 'WRITE_ALLOWED' };
  } catch (error) {
    const code = errorCode(error);
    return { status: classifyAccessError(code), code };
  } finally {
    if (created) {
      try { await unlink(filePath); } catch {}
    }
  }
}

async function filesystemProbe(request) {
  const workspacePath = path.join(process.cwd(), 'worker-write-canary.txt');
  let workspaceReadWrite = false;
  let workspaceCleanup = false;
  let workspaceCreated = false;
  try {
    await writeFile(workspacePath, 'workspace-read-write-ok', { flag: 'wx' });
    workspaceCreated = true;
    workspaceReadWrite = (await readFile(workspacePath, 'utf8')) === 'workspace-read-write-ok';
  } finally {
    if (workspaceCreated) {
      try { await unlink(workspacePath); workspaceCleanup = true; } catch {}
    }
  }

  const canaries = {};
  for (const [name, paths] of Object.entries(request.canaries)) {
    canaries[name] = {
      read: await probeRead(paths.readPath),
      write: await probeWrite(paths.writePath, request.writeMarker),
    };
  }
  return {
    mode: 'filesystem',
    workspace_read_write: workspaceReadWrite,
    workspace_canary_absent: workspaceCleanup,
    canaries,
    environment_keys: Object.keys(process.env).sort(),
  };
}

function waitForever() {
  return new Promise(() => setInterval(() => {}, 1000));
}

async function processTreeProbe(phaseMarkersEnabled) {
  await emitPhaseMarker('PROCESS_TREE_REQUEST_DISPATCH', phaseMarkersEnabled);
  const deadline = Date.now() + PROCESS_TREE_STARTUP_TIMEOUT_MS;
  const remaining = () => Math.max(0, deadline - Date.now());
  const response = {
    mode: 'process-tree',
    child_spawn_status: 'PENDING',
    child_spawn_code: 'NONE',
    child_worker_started: false,
    grandchild_spawn_status: 'PENDING',
    grandchild_spawn_code: 'NONE',
    grandchild_worker_started: false,
    readiness_stage: 'CHILD_SPAWN',
    readiness_status: 'UNKNOWN',
    readiness_code: 'NONE',
    child_pid: null,
    grandchild_pid: null,
  };
  await emitPhaseMarker('CHILD_SPAWN_CALL_BEGIN', phaseMarkersEnabled);
  let child;
  let childExited = false;
  const childReadyPath = processTreeReadyFilePath(PROCESS_TREE_CHILD_READY_FILE);
  let childFd = null;
  let childStartError = null;
  try {
    // Exclusive create: a stale readiness file fails closed as a child spawn failure.
    childFd = openSync(childReadyPath, 'wx');
    child = spawn(process.execPath, buildProcessTreeChildArguments('child'), {
      detached: false,
      stdio: ['ignore', childFd, 'ignore'],
      windowsHide: true,
    });
    child.once('exit', () => { childExited = true; });
  } catch (error) {
    childStartError = error;
  } finally {
    if (childFd !== null) {
      try { closeSync(childFd); } catch {}
    }
  }
  if (!child) {
    await emitPhaseMarker('CHILD_SPAWN_CALL_THROW', phaseMarkersEnabled);
    response.child_spawn_status = 'FAIL';
    response.child_spawn_code = processTreeErrorCode(childStartError);
    response.readiness_status = 'FAIL';
    response.readiness_code = 'CHILD_SPAWN_FAILED';
    await emitPhaseMarker('PROCESS_TREE_RESPONSE_BEGIN', phaseMarkersEnabled);
    await new Promise((resolve) => process.stdout.write(`${JSON.stringify(response)}\n`, resolve));
    await emitPhaseMarker('PROCESS_TREE_RESPONSE_FLUSHED', phaseMarkersEnabled);
    await waitForever();
    return;
  }
  response.child_pid = processTreePid(child);
  const childSpawnPromise = waitForSpawn(child, remaining());
  await emitPhaseMarker('CHILD_SPAWN_CALL_RETURN', phaseMarkersEnabled);
  const childSpawn = await childSpawnPromise;
  response.child_spawn_status = childSpawn.status;
  response.child_spawn_code = childSpawn.code;
  await emitPhaseMarker(childSpawn.status === 'PASS'
    ? 'CHILD_SPAWN_EVENT'
    : childSpawn.status === 'FAIL' ? 'CHILD_SPAWN_ERROR' : 'CHILD_SPAWN_TIMEOUT', phaseMarkersEnabled);
  if (childSpawn.status === 'PASS') {
    const childReader = createFileLineReader(fileSystem, childReadyPath, () => childExited, false);
    await emitPhaseMarker('CHILD_WORKER_START_WAIT', phaseMarkersEnabled);
    const childProgress = await childReader(remaining());
    if (childProgress.status !== 'PASS') {
      response.readiness_stage = 'CHILD_WORKER';
      response.readiness_status = childProgress.status;
      response.readiness_code = childProgress.code === 'READINESS_TIMEOUT'
        ? 'CHILD_START_TIMEOUT'
        : childProgress.code === 'STREAM_CLOSED'
          ? 'CHILD_WORKER_EXITED'
          : childProgress.code === 'STREAM_ERROR'
            ? 'CHILD_STREAM_ERROR'
            : childProgress.code === 'OUTPUT_LIMIT'
              ? 'CHILD_OUTPUT_LIMIT'
              : 'CHILD_READINESS_INVALID';
    } else if (childProgress.value?.mode !== 'process-tree-progress' ||
        childProgress.value?.stage !== 'CHILD_WORKER_STARTED' ||
        Object.keys(childProgress.value).sort().join('\0') !== ['mode', 'stage'].join('\0')) {
      response.readiness_stage = 'CHILD_WORKER';
      response.readiness_status = 'FAIL';
      response.readiness_code = 'CHILD_READINESS_INVALID';
    } else {
      response.child_worker_started = true;
      await emitPhaseMarker('CHILD_WORKER_READY', phaseMarkersEnabled);
      response.readiness_stage = 'GRANDCHILD_START';
      await emitPhaseMarker('GRANDCHILD_START_WAIT', phaseMarkersEnabled);
      const grandchildSpawn = await childReader(remaining());
      if (grandchildSpawn.status !== 'PASS') {
        response.readiness_status = grandchildSpawn.status;
        response.readiness_code = grandchildSpawn.code === 'READINESS_TIMEOUT'
          ? 'GRANDCHILD_SPAWN_TIMEOUT'
          : grandchildSpawn.code === 'STREAM_CLOSED'
            ? 'CHILD_WORKER_EXITED'
            : grandchildSpawn.code === 'STREAM_ERROR'
              ? 'CHILD_STREAM_ERROR'
              : grandchildSpawn.code === 'OUTPUT_LIMIT'
                ? 'CHILD_OUTPUT_LIMIT'
                : 'CHILD_READINESS_INVALID';
      } else if (grandchildSpawn.value?.mode !== 'process-tree-progress' ||
          grandchildSpawn.value?.stage !== 'GRANDCHILD_SPAWN_RESULT' ||
          Object.keys(grandchildSpawn.value).sort().join('\0') !== [
            'grandchild_pid', 'grandchild_spawn_code', 'grandchild_spawn_status', 'mode', 'stage',
          ].sort().join('\0') ||
          !['PENDING', 'PASS', 'FAIL', 'UNKNOWN'].includes(grandchildSpawn.value.grandchild_spawn_status) ||
          typeof grandchildSpawn.value.grandchild_spawn_code !== 'string' ||
          !PROCESS_TREE_SPAWN_CODE_VALUES.has(grandchildSpawn.value.grandchild_spawn_code) ||
          (grandchildSpawn.value.grandchild_pid !== null &&
            (!Number.isSafeInteger(grandchildSpawn.value.grandchild_pid) || grandchildSpawn.value.grandchild_pid <= 0)) ||
          (grandchildSpawn.value.grandchild_spawn_status === 'PASS' &&
            (grandchildSpawn.value.grandchild_spawn_code !== 'NONE' || grandchildSpawn.value.grandchild_pid === null))) {
        response.readiness_status = 'FAIL';
        response.readiness_code = 'CHILD_READINESS_INVALID';
      } else {
        response.grandchild_spawn_status = grandchildSpawn.value.grandchild_spawn_status;
        response.grandchild_spawn_code = grandchildSpawn.value.grandchild_spawn_code;
        response.grandchild_pid = grandchildSpawn.value.grandchild_pid;
        const childReady = await childReader(remaining());
        if (childReady.status !== 'PASS') {
          response.readiness_status = childReady.status;
          response.readiness_code = childReady.code === 'READINESS_TIMEOUT'
            ? 'GRANDCHILD_START_TIMEOUT'
            : childReady.code === 'STREAM_CLOSED'
              ? 'CHILD_WORKER_EXITED'
              : childReady.code === 'STREAM_ERROR'
                ? 'CHILD_STREAM_ERROR'
                : childReady.code === 'OUTPUT_LIMIT'
                  ? 'CHILD_OUTPUT_LIMIT'
                  : 'CHILD_READINESS_INVALID';
        } else if (childReady.value?.mode !== 'process-tree-child-ready' ||
            Object.keys(childReady.value).sort().join('\0') !== [
              'grandchild_pid', 'grandchild_spawn_code', 'grandchild_spawn_status',
              'grandchild_worker_started', 'mode', 'readiness_code', 'readiness_stage', 'readiness_status',
            ].sort().join('\0') ||
            childReady.value.grandchild_spawn_status !== response.grandchild_spawn_status ||
            childReady.value.grandchild_spawn_code !== response.grandchild_spawn_code ||
            childReady.value.grandchild_pid !== response.grandchild_pid ||
            !['PENDING', 'PASS', 'FAIL', 'UNKNOWN'].includes(childReady.value.grandchild_spawn_status) ||
            !['PENDING', 'PASS', 'FAIL', 'UNKNOWN'].includes(childReady.value.readiness_status) ||
            typeof childReady.value.grandchild_worker_started !== 'boolean' ||
            !['GRANDCHILD_SPAWN', 'GRANDCHILD_WORKER', 'READY'].includes(childReady.value.readiness_stage) ||
            typeof childReady.value.readiness_code !== 'string' ||
            !PROCESS_TREE_READINESS_CODES.has(childReady.value.readiness_code) ||
            (childReady.value.grandchild_pid !== null &&
              (!Number.isSafeInteger(childReady.value.grandchild_pid) || childReady.value.grandchild_pid <= 0))) {
          response.readiness_status = 'FAIL';
          response.readiness_code = 'CHILD_READINESS_INVALID';
        } else {
          response.grandchild_worker_started = childReady.value.grandchild_worker_started;
          response.readiness_stage = childReady.value.readiness_stage;
          response.readiness_status = childReady.value.readiness_status;
          response.readiness_code = childReady.value.readiness_code;
        }
      }
      await emitPhaseMarker('CHILD_READINESS_RESPONSE', phaseMarkersEnabled);
    }
  } else {
    response.readiness_status = childSpawn.status;
    response.readiness_code = childSpawn.status === 'FAIL' ? 'CHILD_SPAWN_FAILED' : 'CHILD_SPAWN_TIMEOUT';
  }
  if (response.readiness_stage === 'READY' && response.readiness_status === 'PASS' &&
      response.grandchild_worker_started) {
    response.readiness_code = 'NONE';
  }
  await emitPhaseMarker('PROCESS_TREE_RESPONSE_BEGIN', phaseMarkersEnabled);
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(response)}\n`, resolve));
  await emitPhaseMarker('PROCESS_TREE_RESPONSE_FLUSHED', phaseMarkersEnabled);
  await waitForever();
}

async function networkProbe(request) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: request.host, port: request.port });
    let settled = false;
    const finish = (status, code) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ mode: 'network', status, code });
    };
    socket.setTimeout(request.timeoutMs, () => finish('UNKNOWN', 'TIMEOUT'));
    socket.once('connect', () => finish('ALLOWED', 'CONNECTED'));
    socket.once('error', (error) => {
      const code = errorCode(error);
      finish(classifyAccessError(code), code);
    });
  });
}

export async function main(args = process.argv.slice(2), { throughModuleHook = false } = {}) {
  const phaseMarkersEnabled = throughModuleHook && args.length === 0;
  const request = await readRequest();
  await emitPhaseMarker('PROBE_REQUEST_RECEIVED', phaseMarkersEnabled);
  if (request.mode === 'filesystem') process.stdout.write(`${JSON.stringify(await filesystemProbe(request))}\n`);
  else if (request.mode === 'network') process.stdout.write(`${JSON.stringify(await networkProbe(request))}\n`);
  else if (request.mode === 'process-tree') await processTreeProbe(phaseMarkersEnabled);
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ mode: 'error', code: errorCode(error) })}\n`);
    process.exitCode = 2;
  });
}
