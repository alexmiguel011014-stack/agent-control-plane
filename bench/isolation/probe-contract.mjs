import path from 'node:path';

export const MAX_PROBE_REQUEST_BYTES = 65_536;
const CANARY_NAMES = Object.freeze(['runtime', 'repository', 'oracle', 'ownerProfile']);

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function absoluteCanaryPath(value, workspaceRoot) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 1024
    || /[\u0000-\u001f\u007f]/u.test(value)
    || !path.win32.isAbsolute(value)
    || value.startsWith('\\\\') || value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) {
    throw new Error('Invalid canary path');
  }
  const components = value.split(/[\\/]+/u);
  if (components.includes('..')) throw new Error('Canary path traversal is not allowed');
  const normalized = path.win32.normalize(value);
  const relative = path.win32.relative(path.win32.resolve(workspaceRoot), path.win32.resolve(normalized));
  const insideWorkspace = relative === '' || (
    relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative)
  );
  if (insideWorkspace) throw new Error('Canary path must be outside the staged workspace');
  return normalized;
}

export function parseProbeRequest(input, workspaceRoot = process.cwd()) {
  if (!Buffer.isBuffer(input) && typeof input !== 'string') throw new Error('Probe request must be bytes or text');
  if ((Buffer.isBuffer(input) ? input.length : Buffer.byteLength(input, 'utf8')) > MAX_PROBE_REQUEST_BYTES) {
    throw new Error('Probe request exceeds the byte limit');
  }
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  let request;
  try {
    request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Probe request is not valid UTF-8 JSON');
  }

  if (request?.mode === 'process-tree') {
    if (!exactKeys(request, ['mode'])) throw new Error('Invalid process-tree request fields');
    return request;
  }

  if (request?.mode === 'filesystem') {
    if (!exactKeys(request, ['mode', 'canaries', 'writeMarker'])
      || !exactKeys(request.canaries, CANARY_NAMES)
      || typeof request.writeMarker !== 'string'
      || !/^[A-Za-z0-9:_-]{1,128}$/u.test(request.writeMarker)) {
      throw new Error('Invalid filesystem request fields');
    }
    const paths = [];
    const canaries = {};
    for (const name of CANARY_NAMES) {
      const canary = request.canaries[name];
      if (!exactKeys(canary, ['readPath', 'writePath'])) throw new Error('Invalid canary fields');
      const readPath = absoluteCanaryPath(canary.readPath, workspaceRoot);
      const writePath = absoluteCanaryPath(canary.writePath, workspaceRoot);
      if (readPath.toLowerCase() === writePath.toLowerCase()) throw new Error('Canary read/write paths must differ');
      paths.push(readPath.toLowerCase(), writePath.toLowerCase());
      canaries[name] = Object.freeze({ readPath, writePath });
    }
    if (new Set(paths).size !== paths.length) throw new Error('Canary paths must be unique');
    return Object.freeze({ mode: 'filesystem', canaries: Object.freeze(canaries), writeMarker: request.writeMarker });
  }

  if (request?.mode === 'network') {
    if (!exactKeys(request, ['mode', 'host', 'port', 'timeoutMs'])
      || request.host !== '127.0.0.1'
      || !Number.isInteger(request.port) || request.port < 1 || request.port > 65_535
      || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 200 || request.timeoutMs > 3_000) {
      throw new Error('Invalid loopback network request');
    }
    return request;
  }

  throw new Error('Unknown probe mode');
}

export function classifyAccessError(code) {
  if (code === 'EACCES' || code === 'EPERM') return 'DENIED';
  if (code === 'READ_ALLOWED' || code === 'WRITE_ALLOWED' || code === 'CONNECTED') return 'ALLOWED';
  return 'UNKNOWN';
}
