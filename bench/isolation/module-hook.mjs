import { lstatSync, readFileSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_MODULE_BYTES = 1024 * 1024;
const FIXED_MODULES = Object.freeze({
  probe: Object.freeze(['worker.mjs', 'probe-contract.mjs']),
  production: Object.freeze(['production-worker.mjs', 'protocol.mjs', 'task-operations.mjs']),
});

function moduleError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hasDeviceOrNetworkPrefix(value) {
  return value.startsWith('\\\\') || value.startsWith('//') ||
    value.startsWith('\\??\\') || value.startsWith('/??/');
}

function toLocalFilePath(value, parentURL) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw moduleError('MODULE_SPECIFIER_DENIED');
  }

  if (value.startsWith('file:')) {
    let url;
    try { url = new URL(value); } catch { throw moduleError('MODULE_SPECIFIER_DENIED'); }
    if (url.protocol !== 'file:' || url.host || url.search || url.hash) {
      throw moduleError('MODULE_SPECIFIER_DENIED');
    }
    const filePath = fileURLToPath(url);
    if (hasDeviceOrNetworkPrefix(filePath)) throw moduleError('MODULE_SPECIFIER_DENIED');
    return filePath;
  }

  if (value.startsWith('./') || value.startsWith('../')) {
    if (typeof parentURL !== 'string' || !parentURL.startsWith('file:')) {
      throw moduleError('MODULE_SPECIFIER_DENIED');
    }
    let url;
    try { url = new URL(value, parentURL); } catch { throw moduleError('MODULE_SPECIFIER_DENIED'); }
    if (url.protocol !== 'file:' || url.host || url.search || url.hash) {
      throw moduleError('MODULE_SPECIFIER_DENIED');
    }
    const filePath = fileURLToPath(url);
    if (hasDeviceOrNetworkPrefix(filePath)) throw moduleError('MODULE_SPECIFIER_DENIED');
    return filePath;
  }

  throw moduleError('MODULE_SPECIFIER_DENIED');
}

function assertOrdinaryModule(root, candidate, lstat) {
  const canonicalRoot = path.resolve(root);
  const canonicalCandidate = path.resolve(candidate);
  if (!isWithin(canonicalRoot, canonicalCandidate) || canonicalCandidate === canonicalRoot ||
      path.extname(canonicalCandidate) !== '.mjs') {
    throw moduleError('MODULE_PATH_DENIED');
  }

  let rootInfo;
  try { rootInfo = lstat(canonicalRoot); } catch { throw moduleError('MODULE_ROOT_UNAVAILABLE'); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw moduleError('MODULE_ROOT_DENIED');

  const relative = path.relative(canonicalRoot, canonicalCandidate);
  const components = relative.split(path.sep);
  let current = canonicalRoot;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try { info = lstat(current); } catch { throw moduleError('MODULE_PATH_UNAVAILABLE'); }
    if (info.isSymbolicLink()) throw moduleError('MODULE_REPARSE_DENIED');
    const last = index === components.length - 1;
    if (last ? !info.isFile() : !info.isDirectory()) throw moduleError('MODULE_FILE_TYPE_DENIED');
    if (last && (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_MODULE_BYTES)) {
      throw moduleError('MODULE_SIZE_DENIED');
    }
  }
  return canonicalCandidate;
}

function fileURL(filePath) {
  return pathToFileURL(filePath).href;
}

export function createModuleHookHandlers({
  mode,
  toolsRoot,
  workspaceRoot,
  lstat = lstatSync,
  readFile = readFileSync,
  builtin = isBuiltin,
} = {}) {
  const fixedNames = FIXED_MODULES[mode];
  if (!fixedNames || typeof toolsRoot !== 'string' || typeof workspaceRoot !== 'string' ||
      !path.isAbsolute(toolsRoot) || !path.isAbsolute(workspaceRoot)) {
    throw moduleError('MODULE_HOOK_CONFIGURATION_DENIED');
  }

  const canonicalToolsRoot = path.resolve(toolsRoot);
  const canonicalWorkspaceRoot = path.resolve(workspaceRoot);
  if (canonicalToolsRoot === canonicalWorkspaceRoot || isWithin(canonicalToolsRoot, canonicalWorkspaceRoot) ||
      isWithin(canonicalWorkspaceRoot, canonicalToolsRoot)) {
    throw moduleError('MODULE_ROOT_OVERLAP_DENIED');
  }
  const fixedPaths = new Set(fixedNames.map((name) => path.resolve(canonicalToolsRoot, name)));

  function resolveFile(filePath) {
    const candidate = path.resolve(filePath);
    if (fixedPaths.has(candidate)) {
      return { root: canonicalToolsRoot, path: candidate };
    }
    if (path.extname(candidate) === '.mjs' && isWithin(canonicalWorkspaceRoot, candidate) && candidate !== canonicalWorkspaceRoot) {
      return { root: canonicalWorkspaceRoot, path: candidate };
    }
    throw moduleError('MODULE_PATH_DENIED');
  }

  function resolve(specifier, context, nextResolve) {
    if (typeof specifier === 'string' && builtin(specifier)) return nextResolve(specifier, context);
    const filePath = toLocalFilePath(specifier, context?.parentURL);
    const allowed = resolveFile(filePath);
    const checked = assertOrdinaryModule(allowed.root, allowed.path, lstat);
    return { url: fileURL(checked), shortCircuit: true };
  }

  function load(url, context, nextLoad) {
    if (typeof url === 'string' && url.startsWith('node:') && builtin(url)) return nextLoad(url, context);
    const filePath = toLocalFilePath(url, undefined);
    const allowed = resolveFile(filePath);
    const checked = assertOrdinaryModule(allowed.root, allowed.path, lstat);
    let source;
    try { source = readFile(checked); } catch { throw moduleError('MODULE_READ_DENIED'); }
    if (!Buffer.isBuffer(source)) source = Buffer.from(source);
    if (source.byteLength > MAX_MODULE_BYTES) throw moduleError('MODULE_SIZE_DENIED');
    return { format: 'module', source, shortCircuit: true };
  }

  return { resolve, load };
}

export function registerWorkerHooks(configuration, register = registerHooks) {
  if (typeof register !== 'function') throw moduleError('MODULE_HOOKS_UNAVAILABLE');
  const handlers = createModuleHookHandlers(configuration);
  register(handlers);
  return handlers;
}

export async function startModuleWorker({ mode, toolsRoot, workspaceRoot = process.cwd(), workerArguments = [] } = {}) {
  const fixedNames = FIXED_MODULES[mode];
  if (!fixedNames || typeof toolsRoot !== 'string' || !Array.isArray(workerArguments) ||
      workerArguments.some((argument) => typeof argument !== 'string') ||
      workerArguments.length !== 0) {
    throw moduleError('MODULE_HOOK_MODE_DENIED');
  }
  if (typeof registerHooks !== 'function') throw moduleError('MODULE_HOOKS_UNAVAILABLE');

  const handlers = createModuleHookHandlers({ mode, toolsRoot, workspaceRoot });
  registerHooks(handlers);

  const workerPath = path.join(toolsRoot, fixedNames[0]);
  const worker = await import(fileURL(workerPath));
  if (typeof worker.main !== 'function') throw moduleError('MODULE_ENTRY_INVALID');
  await worker.main(workerArguments, { throughModuleHook: true });
}

async function startWorker() {
  const mode = process.argv[2];
  if (mode === 'production' && process.argv.length !== 3) throw moduleError('MODULE_HOOK_MODE_DENIED');
  const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
  const workerArguments = mode === 'probe' ? process.argv.slice(3) : [];
  await startModuleWorker({ mode, toolsRoot, workspaceRoot: process.cwd(), workerArguments });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startWorker().catch(() => {
    process.stdout.write(`${JSON.stringify({ mode: 'error', code: 'MODULE_HOOK_FAILURE' })}\n`);
    process.exitCode = 2;
  });
}
