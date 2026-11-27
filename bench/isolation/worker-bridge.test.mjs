import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess, spawnSync } from 'node:child_process';
import fsModule, { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext, Script } from 'node:vm';
import {
  MAX_REQUEST_BYTES,
  createNoopFunctionFixture,
  createWorkerRequest,
  createWorkerResponse,
  decodeValue,
  parseWorkerRequest,
  parseWorkerResponse,
  serializeWorkerResponse,
  isUnserializableWorkerValue,
  WorkerProtocolError,
} from './protocol.mjs';
import { createIsolatedWorkerRunner, IsolatedWorkerError, parseLauncherStdout } from './host-runner.mjs';
import { executeWorkerRequest, parseWorkerStdin, safeWorkerErrorCode } from './production-worker.mjs';
import { createModuleHookHandlers, registerWorkerHooks, startModuleWorker } from './module-hook.mjs';
import {
  buildProcessTreeChildArguments,
  createFileLineReader,
  createJsonLineReader,
  PROCESS_TREE_CHILD_READY_FILE,
  PROCESS_TREE_CHILD_SCRIPT,
  PROCESS_TREE_GRANDCHILD_READY_FILE,
  PROCESS_TREE_GRANDCHILD_SCRIPT,
  processTreeReadyFilePath,
} from './worker.mjs';

const ISOLATION_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BASE_WORKSPACE = path.resolve(ISOLATION_DIRECTORY, '..', 'tasks', 'P01', 'base');
const B06_WORKSPACE = path.resolve(ISOLATION_DIRECTORY, '..', 'tasks', 'B06', 'base');
const I04_WORKSPACE = path.resolve(ISOLATION_DIRECTORY, '..', 'tasks', 'I04', 'base');
const I05_WORKSPACE = path.resolve(ISOLATION_DIRECTORY, '..', 'tasks', 'I05', 'base');

function moduleParent(filePath) {
  return pathToFileURL(filePath).href;
}

function resolveModule(hooks, specifier, parentURL) {
  return hooks.resolve(specifier, { parentURL }, () => {
    throw new Error('default resolver must not receive a local or unknown module');
  });
}

function loadModule(hooks, url) {
  return hooks.load(url, {}, () => {
    throw new Error('default loader must not receive a local module');
  });
}

async function readCSharpStringConstant(filePath, constantName) {
  const source = await readFile(filePath, 'utf8');
  const marker = `private const string ${constantName} =`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `C# constant ${constantName} must exist`);
  let cursor = source.indexOf('=', start) + 1;
  const literals = [];
  while (cursor < source.length) {
    while (/\s|\+/u.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] === ';') break;
    assert.equal(source[cursor], '"', `C# constant ${constantName} must use regular string literals`);
    cursor += 1;
    let literal = '';
    let closed = false;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === '\\') {
        literal += character + (source[cursor + 1] ?? '');
        cursor += 2;
      } else if (character === '"') {
        cursor += 1;
        closed = true;
        break;
      } else {
        literal += character;
        cursor += 1;
      }
    }
    assert.ok(closed, `C# constant ${constantName} string literal must close`);
    literals.push(JSON.parse(`"${literal}"`));
  }
  assert.equal(source[cursor], ';', `C# constant ${constantName} must end with a semicolon`);
  assert.ok(literals.length > 0, `C# constant ${constantName} must contain string literals`);
  return literals.join('');
}

test('module hook passes builtins and loads only fixed production modules plus workspace descendants', async (t) => {
  const hooks = createModuleHookHandlers({
    mode: 'production',
    toolsRoot: ISOLATION_DIRECTORY,
    workspaceRoot: I04_WORKSPACE,
  });
  const workerUrl = moduleParent(path.join(ISOLATION_DIRECTORY, 'production-worker.mjs'));
  const builtinCalls = [];
  const builtin = hooks.resolve('node:path', { parentURL: workerUrl }, (specifier) => {
    builtinCalls.push(specifier);
    return { url: specifier };
  });
  assert.deepEqual(builtin, { url: 'node:path' });
  assert.deepEqual(builtinCalls, ['node:path']);

  const protocol = resolveModule(hooks, './protocol.mjs', workerUrl);
  assert.equal(protocol.url, moduleParent(path.join(ISOLATION_DIRECTORY, 'protocol.mjs')));
  assert.equal(loadModule(hooks, protocol.url).format, 'module');
  const unlistedToolModule = moduleParent(path.join(ISOLATION_DIRECTORY, 'probe-contract.mjs'));
  assert.throws(() => resolveModule(hooks, unlistedToolModule, workerUrl), /MODULE_PATH_DENIED/u);

  const probeHooks = createModuleHookHandlers({
    mode: 'probe',
    toolsRoot: ISOLATION_DIRECTORY,
    workspaceRoot: I04_WORKSPACE,
  });
  const probeWorkerUrl = moduleParent(path.join(ISOLATION_DIRECTORY, 'worker.mjs'));
  assert.equal(resolveModule(probeHooks, probeWorkerUrl, workerUrl).url, probeWorkerUrl);
  assert.equal(resolveModule(probeHooks, './probe-contract.mjs', probeWorkerUrl).url,
    moduleParent(path.join(ISOLATION_DIRECTORY, 'probe-contract.mjs')));
  assert.throws(() => resolveModule(probeHooks, workerUrl, probeWorkerUrl), /MODULE_PATH_DENIED/u);

  const entry = moduleParent(path.join(I04_WORKSPACE, 'src', 'error-response.mjs'));
  const entrySource = loadModule(hooks, resolveModule(hooks, entry, workerUrl).url).source.toString('utf8');
  assert.match(entrySource, /from '\.\/app-error\.mjs'/u);
  const dependency = resolveModule(hooks, './app-error.mjs', entry);
  assert.equal(dependency.url, moduleParent(path.join(I04_WORKSPACE, 'src', 'app-error.mjs')));
  assert.match(loadModule(hooks, dependency.url).source.toString('utf8'), /export class AppError/u);
});

test('module hook resolves I05 relative dependency cycle without executing workspace source', () => {
  const hooks = createModuleHookHandlers({
    mode: 'production',
    toolsRoot: ISOLATION_DIRECTORY,
    workspaceRoot: I05_WORKSPACE,
  });
  const startup = moduleParent(path.join(I05_WORKSPACE, 'src', 'startup.mjs'));
  const startupSource = loadModule(hooks, resolveModule(hooks, startup, moduleParent(path.join(ISOLATION_DIRECTORY, 'production-worker.mjs'))).url)
    .source.toString('utf8');
  assert.match(startupSource, /from '\.\/defaults\.mjs'/u);
  assert.match(startupSource, /from '\.\/config\.mjs'/u);
  const defaults = resolveModule(hooks, './defaults.mjs', startup).url;
  const config = resolveModule(hooks, './config.mjs', startup).url;
  assert.match(loadModule(hooks, defaults).source.toString('utf8'), /from '\.\/config\.mjs'/u);
  assert.match(loadModule(hooks, config).source.toString('utf8'), /from '\.\/defaults\.mjs'/u);
});

test('module hook rejects bare, absolute, UNC, device, out-of-root, and reparse module paths', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agentcp-module-hook-'));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const toolsRoot = path.join(temporaryRoot, 'tools');
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  await mkdir(toolsRoot);
  await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  const workerPath = path.join(toolsRoot, 'production-worker.mjs');
  const candidatePath = path.join(workspaceRoot, 'src', 'candidate.mjs');
  await writeFile(workerPath, 'export async function main() {}\n');
  await writeFile(candidatePath, 'export const value = 1;\n');

  const hooks = createModuleHookHandlers({ mode: 'production', toolsRoot, workspaceRoot });
  const workerUrl = moduleParent(workerPath);
  for (const specifier of [
    'unlisted-package',
    candidatePath,
    String.raw`\\server\share\candidate.mjs`,
    String.raw`\\?\C:\private\candidate.mjs`,
    String.raw`\\.\C:\private\candidate.mjs`,
    String.raw`\??\C:\private\candidate.mjs`,
    'file://server/share/candidate.mjs',
    moduleParent(path.join(temporaryRoot, 'outside.mjs')),
    '../../../outside.mjs',
  ]) {
    const parentURL = specifier === '../../../outside.mjs'
      ? moduleParent(candidatePath)
      : workerUrl;
    assert.throws(() => resolveModule(hooks, specifier, parentURL), /MODULE_(?:PATH|SPECIFIER)_DENIED/u);
  }

  const visited = [];
  const reparseHooks = createModuleHookHandlers({
    mode: 'production',
    toolsRoot,
    workspaceRoot,
    lstat(candidate) {
      visited.push(path.resolve(candidate));
      if (path.resolve(candidate) === path.resolve(candidatePath)) {
        return { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true, size: 0 };
      }
      return lstatSync(candidate);
    },
  });
  assert.throws(() => resolveModule(reparseHooks, moduleParent(candidatePath), workerUrl), /MODULE_REPARSE_DENIED/u);
  assert.ok(visited.length > 0);
  assert.ok(visited.every((candidate) => candidate === path.resolve(workspaceRoot) ||
    candidate.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`)));
});

test('module hook fails closed when synchronous registerHooks is unavailable', () => {
  assert.throws(() => registerWorkerHooks({
    mode: 'probe',
    toolsRoot: ISOLATION_DIRECTORY,
    workspaceRoot: BASE_WORKSPACE,
  }, null), /MODULE_HOOKS_UNAVAILABLE/u);
  assert.equal(isBuiltin('node:module'), true);
});

test('module hook refuses descendant roles because process-tree children use fixed inline scripts', async () => {
  await assert.rejects(startModuleWorker({
    mode: 'probe',
    toolsRoot: ISOLATION_DIRECTORY,
    workspaceRoot: BASE_WORKSPACE,
    workerArguments: ['--child'],
  }), (error) => error?.code === 'MODULE_HOOK_MODE_DENIED');
  await assert.rejects(startModuleWorker({
    mode: 'probe',
    toolsRoot: ISOLATION_DIRECTORY,
    workspaceRoot: BASE_WORKSPACE,
    workerArguments: ['--grandchild'],
  }), (error) => error?.code === 'MODULE_HOOK_MODE_DENIED');
});

test('Node registerHooks loads fixed and synthetic workspace ESM modules after registration', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agentcp-module-hook-runtime-'));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  const candidatePath = path.join(workspaceRoot, 'src', 'value.mjs');
  await writeFile(candidatePath, 'export const syntheticValue = 42;\n');

  const moduleHookUrl = moduleParent(path.join(ISOLATION_DIRECTORY, 'module-hook.mjs'));
  const productionWorkerUrl = moduleParent(path.join(ISOLATION_DIRECTORY, 'production-worker.mjs'));
  const candidateUrl = moduleParent(candidatePath);
  const script = [
    `import { registerWorkerHooks } from ${JSON.stringify(moduleHookUrl)};`,
    `registerWorkerHooks({ mode: 'production', toolsRoot: ${JSON.stringify(ISOLATION_DIRECTORY)}, workspaceRoot: ${JSON.stringify(workspaceRoot)} });`,
    `const worker = await import(${JSON.stringify(productionWorkerUrl)});`,
    `const candidate = await import(${JSON.stringify(candidateUrl)});`,
    "if (typeof worker.main !== 'function' || candidate.syntheticValue !== 42) process.exit(3);",
    "process.stdout.write('MODULE_HOOK_RUNTIME_PASS\\n');",
  ].join('\n');
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(stdout, 'MODULE_HOOK_RUNTIME_PASS\n');
});

test('the exact C# bootstrap reads hook bytes, imports data URL, then registers before local imports', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agentcp-data-hook-bootstrap-'));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const toolsRoot = path.join(temporaryRoot, 'tools');
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  await mkdir(toolsRoot);
  await mkdir(workspaceRoot);
  const hookPath = path.join(toolsRoot, 'module-hook.mjs');
  const hookSource = await readFile(new URL('./module-hook.mjs', import.meta.url));
  await writeFile(hookPath, hookSource);
  await writeFile(path.join(toolsRoot, 'protocol.mjs'), [
    "import path from 'node:path';",
    "export const protocolMarker = path.basename('protocol-ready');",
  ].join('\n'));
  await writeFile(path.join(toolsRoot, 'task-operations.mjs'), "export const registryMarker = 'registry-ready';\n");
  await writeFile(path.join(toolsRoot, 'unlisted.mjs'), "export const shouldBeDenied = true;\n");
  await writeFile(path.join(toolsRoot, 'production-worker.mjs'), [
    "import { protocolMarker } from './protocol.mjs';",
    "import { registryMarker } from './task-operations.mjs';",
    'export async function main() {',
    "  if (protocolMarker !== 'protocol-ready' || registryMarker !== 'registry-ready') throw new Error('fixed_import_failed');",
    '  let denied = false;',
    "  try { await import('./unlisted.mjs'); } catch (error) { denied = error?.code === 'MODULE_PATH_DENIED'; }",
    "  if (!denied) throw new Error('unlisted_module_was_loaded');",
    "  process.stdout.write('DATA_HOOK_BOOTSTRAP_PASS\\n');",
    '}',
  ].join('\n'));

  const launcherPath = fileURLToPath(new URL('./AppContainerLauncher.cs', import.meta.url));
  const bootstrap = await readCSharpStringConstant(launcherPath, 'MODULE_HOOK_BOOTSTRAP');
  const hookRead = bootstrap.indexOf('readFileSync(hookPath)');
  const dataImport = bootstrap.indexOf("import('data:text/javascript;base64,'");
  const workerCall = bootstrap.indexOf('hook.startModuleWorker(');
  assert.ok(hookRead !== -1 && dataImport > hookRead && workerCall > dataImport,
    'the fixed bootstrap must read hook bytes, import the data URL, then call the hook');

  const stdout = execFileSync(process.execPath, [
    '--input-type=module', '-e', bootstrap, hookPath, 'production',
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(stdout, 'DATA_HOOK_BOOTSTRAP_PASS\n');
});

function runProcessTreeHostTest(input) {
  const inputBase64 = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ISOLATION_DIRECTORY, 'run-probes.ps1'),
    '-ProcessTreeHostTestOnly', '-ProcessTreeHostTestInputBase64', inputBase64,
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384, windowsHide: true });
}

function buildProcessTreeHostTestInput() {
  const childArguments = buildProcessTreeChildArguments('child');
  return {
    schema_version: 2,
    node_path: process.execPath,
    child_script: childArguments[1],
    grandchild_script: childArguments[3],
    cases: [
      { name: 'normal', timeout_ms: 10_000, child_role: 'child-test', grandchild_role: 'grandchild-test' },
      { name: 'timeout', timeout_ms: 5_000, child_role: 'child', grandchild_role: 'grandchild' },
    ],
  };
}

test('host-only process-tree mode rejects a schema 1 input', { skip: process.platform !== 'win32' }, () => {
  const input = {
    schema_version: 1,
    node_path: process.execPath,
    cases: [
      { name: 'normal', timeout_ms: 10_000, arguments: buildProcessTreeChildArguments('child-test') },
      { name: 'timeout', timeout_ms: 5_000, arguments: buildProcessTreeChildArguments('child') },
    ],
  };
  let failure;
  try {
    runProcessTreeHostTest(input);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'a schema 1 host-test input must make run-probes.ps1 exit non-zero');
  assert.notEqual(failure.status, 0);
  assert.ok(Number.isInteger(failure.status), 'the host-only runner must exit with a status, not time out');
});

test('fixed process tree exits naturally and a Job Object timeout drains both processes', { skip: process.platform !== 'win32' }, () => {
  const input = buildProcessTreeHostTestInput();
  const inputBytes = Buffer.from(JSON.stringify(input), 'utf8');
  assert.ok(inputBytes.length <= 12_288, `host-test input must keep headroom: ${inputBytes.length} bytes`);
  let stdout;
  try {
    stdout = runProcessTreeHostTest(input);
  } catch (error) {
    const output = Buffer.isBuffer(error.stdout) ? error.stdout.toString('utf8') : String(error.stdout ?? '');
    assert.fail(`host-only Job process-tree test failed (exit ${error.status ?? 'unknown'}): ${output}`);
  }

  const report = JSON.parse(stdout);
  assert.deepEqual(Object.keys(report).sort(), ['normal', 'reason', 'schema_version', 'status', 'timeout']);
  assert.equal(report.schema_version, 1);
  assert.equal(report.status, 'PASS');
  assert.equal(report.reason, 'NONE');
  assert.doesNotMatch(stdout, /"(?:grandchild_pid|pid)"\s*:/i, 'the host runner must not expose numeric process IDs');

  assert.equal(report.normal.status, 'PASS');
  assert.equal(report.normal.child_ready, true);
  assert.equal(report.normal.grandchild_ready, true);
  assert.equal(report.normal.grandchild_pid_valid, true);
  assert.equal(report.normal.process_ids_distinct, true);
  assert.equal(report.normal.root_pid_valid, true);
  assert.equal(report.normal.root_pid_absent_after_drain, true);
  assert.equal(report.normal.grandchild_pid_absent_after_drain, true);
  assert.equal(report.normal.job_membership_verified, true);
  assert.equal(report.normal.timed_out, false);
  assert.equal(report.normal.root_exit_observed, true);
  assert.equal(report.normal.root_exit_code, 0);
  assert.equal(report.normal.job_drained, true);
  assert.equal(report.normal.active_processes_after_drain, 0);
  assert.equal(report.normal.cleanup_confirmed, true);

  assert.equal(report.timeout.status, 'PASS');
  assert.equal(report.timeout.child_ready, true);
  assert.equal(report.timeout.grandchild_ready, true);
  assert.equal(report.timeout.grandchild_pid_valid, true);
  assert.equal(report.timeout.process_ids_distinct, true);
  assert.equal(report.timeout.root_pid_valid, true);
  assert.equal(report.timeout.root_pid_absent_after_drain, true);
  assert.equal(report.timeout.grandchild_pid_absent_after_drain, true);
  assert.equal(report.timeout.job_membership_verified, true);
  assert.equal(report.timeout.timed_out, true);
  assert.equal(report.timeout.terminate_job_succeeded, true);
  assert.equal(report.timeout.root_exit_observed, true);
  assert.equal(report.timeout.active_process_limit_query_succeeded, true);
  assert.equal(report.timeout.effective_active_process_limit_enabled, true);
  assert.equal(report.timeout.effective_active_process_limit, 4);
  assert.equal(report.timeout.active_process_limit_verified, true);
  assert.equal(report.timeout.job_accounting_query_succeeded, true);
  assert.ok(Number.isInteger(report.timeout.total_processes_at_deadline));
  assert.ok(Number.isInteger(report.timeout.active_processes_at_deadline));
  assert.ok(Number.isInteger(report.timeout.total_terminated_processes_at_deadline));
  assert.equal(report.timeout.job_pid_list_query_succeeded, true);
  assert.equal(report.timeout.job_pid_list_complete, true);
  assert.equal(report.timeout.job_pid_assigned_count, 4);
  assert.equal(report.timeout.job_pid_returned_count, 4);
  assert.equal(report.timeout.root_pid_present_in_job_list, true);
  assert.equal(report.timeout.grandchild_pid_present_in_job_list, true);
  assert.equal(report.timeout.job_pid_list_matches_expected, true);
  assert.equal(report.timeout.process_member_diagnostics_status, 'COMPLETE');
  assert.equal(report.timeout.process_member_job_set_stable, true);
  assert.equal(report.timeout.process_member_open_count, report.timeout.job_pid_returned_count);
  assert.equal(report.timeout.process_member_membership_verified_count, report.timeout.job_pid_returned_count);
  assert.equal(report.timeout.process_member_not_in_job_count, 0);
  assert.equal(report.timeout.process_member_membership_unknown_count, 0);
  assert.ok(Number.isInteger(report.timeout.process_member_node_image_count));
  assert.ok(Number.isInteger(report.timeout.process_member_console_host_image_count));
  assert.ok(Number.isInteger(report.timeout.process_member_command_shell_image_count));
  assert.ok(Number.isInteger(report.timeout.process_member_other_image_count));
  assert.equal(report.timeout.process_member_node_image_count, 2);
  assert.equal(report.timeout.process_member_console_host_image_count, 2);
  assert.equal(report.timeout.process_member_command_shell_image_count, 0);
  assert.equal(report.timeout.process_member_other_image_count, 0);
  assert.equal(report.timeout.process_member_image_unknown_count, 0);
  assert.ok(Number.isInteger(report.timeout.process_member_parent_id_matches_job_member_count));
  assert.equal(report.timeout.process_member_metadata_unknown_count, 0);
  assert.equal(report.timeout.accounting_excess_over_pid_list_count,
    report.timeout.active_processes_at_deadline - report.timeout.job_pid_returned_count);
  assert.ok(report.timeout.total_terminated_processes_at_deadline >= report.timeout.accounting_excess_over_pid_list_count);
  assert.equal(report.timeout.accounting_excess_covered_by_termination_count, true);
  assert.equal(report.timeout.job_drained, true);
  assert.equal(report.timeout.active_processes_after_drain, 0);
  assert.equal(report.timeout.cleanup_confirmed, true);
  assert.doesNotMatch(stdout, /"(?:root_process_id|job_process_ids|grandchild_pid)"\s*:/i,
    'raw process IDs must remain in memory and never enter the report');
  assert.doesNotMatch(stdout, /"(?:process_ids|parent_process_id|image_name|image_path)"\s*:/i,
    'host process metadata must be reduced to sanitized counts before serialization');
  assert.doesNotMatch(stdout, /\b(?:conhost\.exe|OpenConsole\.exe|WindowsTerminal\.exe|cmd\.exe|powershell\.exe|pwsh\.exe)\b/i,
    'fixed image categories must not serialize executable names');
});

async function withReaderDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentcp-reader-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

// Runs the same byte sequence through the file reader and the pipe reader and returns both results.
async function readBothWays(directory, chunks, { exited = false, timeoutMs = 2_000, reads = 1 } = {}) {
  const filePath = path.join(directory, `case-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(filePath, '', { flag: 'wx' });
  const fileReader = createFileLineReader(fsModule, filePath, () => exited, false);
  const stream = new PassThrough();
  const pipeReader = createJsonLineReader(stream);
  const writes = (async () => {
    for (const chunk of chunks) {
      appendFileSync(filePath, chunk);
      stream.write(chunk);
      await delay(60);
    }
    if (exited) stream.end();
  })();
  const fileResults = [];
  const pipeResults = [];
  for (let index = 0; index < reads; index += 1) {
    fileResults.push(await fileReader(timeoutMs));
    pipeResults.push(await pipeReader(timeoutMs));
  }
  await writes;
  return { fileResults, pipeResults };
}

test('file line reader returns pipe-reader status and code values for every readiness case', async () => {
  await withReaderDirectory(async (directory) => {
    const ordered = await readBothWays(directory, ['{"n":1}\n{"n":2}\n'], { reads: 2 });
    assert.deepEqual(ordered.fileResults, [{ status: 'PASS', value: { n: 1 } }, { status: 'PASS', value: { n: 2 } }]);
    assert.deepEqual(ordered.fileResults, ordered.pipeResults);

    const partial = await readBothWays(directory, ['{"n":', '3}\n']);
    assert.deepEqual(partial.fileResults, [{ status: 'PASS', value: { n: 3 } }]);
    assert.deepEqual(partial.fileResults, partial.pipeResults);

    const invalid = await readBothWays(directory, ['not-json\n']);
    assert.deepEqual(invalid.fileResults, [{ status: 'FAIL', code: 'INVALID_JSON' }]);
    assert.deepEqual(invalid.fileResults, invalid.pipeResults);

    const oversizeLine = await readBothWays(directory, [`"${'x'.repeat(2_048)}"\n`]);
    assert.deepEqual(oversizeLine.fileResults, [{ status: 'FAIL', code: 'OUTPUT_LIMIT' }]);
    assert.deepEqual(oversizeLine.fileResults, oversizeLine.pipeResults);

    const oversizeUnterminated = await readBothWays(directory, ['x'.repeat(2_049)]);
    assert.deepEqual(oversizeUnterminated.fileResults, [{ status: 'FAIL', code: 'OUTPUT_LIMIT' }]);
    assert.deepEqual(oversizeUnterminated.fileResults, oversizeUnterminated.pipeResults);

    const exitedWithoutLine = await readBothWays(directory, ['{"partial":'], { exited: true });
    assert.deepEqual(exitedWithoutLine.fileResults, [{ status: 'FAIL', code: 'STREAM_CLOSED' }]);
    assert.deepEqual(exitedWithoutLine.fileResults, exitedWithoutLine.pipeResults);

    const timedOut = await readBothWays(directory, [], { timeoutMs: 100 });
    assert.deepEqual(timedOut.fileResults, [{ status: 'UNKNOWN', code: 'READINESS_TIMEOUT' }]);
    assert.deepEqual(timedOut.fileResults, timedOut.pipeResults);
  });
});

test('file line reader reads only appended bytes and enforces single-line framing', async () => {
  await withReaderDirectory(async (directory) => {
    const filePath = path.join(directory, 'single.jsonl');
    writeFileSync(filePath, '{"a":1}\n{"b":2}\n', { flag: 'wx' });
    const single = createFileLineReader(fsModule, filePath, () => false, true);
    assert.deepEqual(await single(500), { status: 'FAIL', code: 'INVALID_JSON' });

    const appendedPath = path.join(directory, 'appended.jsonl');
    writeFileSync(appendedPath, '{"a":1}\n', { flag: 'wx' });
    const reader = createFileLineReader(fsModule, appendedPath, () => false, false);
    assert.deepEqual(await reader(500), { status: 'PASS', value: { a: 1 } });
    appendFileSync(appendedPath, '{"b":2}\n');
    assert.deepEqual(await reader(500), { status: 'PASS', value: { b: 2 } });
    assert.deepEqual(await reader(100), { status: 'UNKNOWN', code: 'READINESS_TIMEOUT' });

    const missing = createFileLineReader(fsModule, path.join(directory, 'missing.jsonl'), () => false, false);
    assert.deepEqual(await missing(100), { status: 'UNKNOWN', code: 'READINESS_TIMEOUT' },
      'a file that does not exist yet is not a stream error');
  });
});

test('readiness files use fixed names under process.cwd() only', () => {
  assert.equal(processTreeReadyFilePath(PROCESS_TREE_CHILD_READY_FILE), path.join(process.cwd(), 'pt-child-ready.jsonl'));
  assert.equal(processTreeReadyFilePath(PROCESS_TREE_GRANDCHILD_READY_FILE),
    path.join(process.cwd(), 'pt-grandchild-ready.jsonl'));
  for (const name of ['../pt-child-ready.jsonl', 'other.jsonl', path.join(os.tmpdir(), 'pt-child-ready.jsonl'), undefined]) {
    assert.throws(() => processTreeReadyFilePath(name), TypeError);
  }
});

function runUntilLines(command, args, { cwd, input = null, lines }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out: ${output}`)); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const complete = output.split('\n').filter(Boolean);
      if (!child.killed && output.endsWith('\n') && complete.length >= lines) {
        clearTimeout(timer);
        // Wait for exit so the process no longer holds the directory before cleanup.
        child.once('exit', () => resolve(complete.map((line) => JSON.parse(line))));
        child.kill();
      }
    });
    child.once('error', reject);
    child.stdin.end(input ?? '');
  });
}

test('a stale child readiness file fails closed as a child spawn failure', async () => {
  await withReaderDirectory(async (directory) => {
    const stale = path.join(directory, 'pt-child-ready.jsonl');
    writeFileSync(stale, 'stale\n', { flag: 'wx' });
    const [response] = await runUntilLines(process.execPath, [path.join(ISOLATION_DIRECTORY, 'worker.mjs')], {
      cwd: directory, input: JSON.stringify({ mode: 'process-tree' }), lines: 1,
    });
    assert.equal(response.mode, 'process-tree');
    assert.equal(response.child_spawn_status, 'FAIL');
    assert.equal(response.child_spawn_code, 'UNKNOWN');
    assert.equal(response.readiness_code, 'CHILD_SPAWN_FAILED');
    assert.equal(response.child_pid, null);
    assert.equal(readFileSync(stale, 'utf8'), 'stale\n', 'the stale file must be refused, not reused or replaced');
  });
});

test('a stale grandchild readiness file fails closed in the child role', async () => {
  await withReaderDirectory(async (directory) => {
    const stale = path.join(directory, 'pt-grandchild-ready.jsonl');
    writeFileSync(stale, 'stale\n', { flag: 'wx' });
    const lines = await runUntilLines(process.execPath, buildProcessTreeChildArguments('child'), { cwd: directory, lines: 3 });
    assert.deepEqual(lines[0], { mode: 'process-tree-progress', stage: 'CHILD_WORKER_STARTED' });
    assert.equal(lines[1].grandchild_spawn_status, 'FAIL');
    assert.equal(lines[1].grandchild_pid, null);
    assert.equal(lines[2].mode, 'process-tree-child-ready');
    assert.equal(lines[2].readiness_code, 'GRANDCHILD_SPAWN_FAILED');
    assert.equal(readFileSync(stale, 'utf8'), 'stale\n');
  });
});

test('the grandchild opens its own readiness file with exclusive create and refuses a stale file', async () => {
  const grandchildArgs = ['-e', PROCESS_TREE_GRANDCHILD_SCRIPT, 'grandchild'];
  await withReaderDirectory(async (directory) => {
    const stale = path.join(directory, 'pt-grandchild-ready.jsonl');
    writeFileSync(stale, 'stale\n', { flag: 'wx' });
    const result = spawnSync(process.execPath, grandchildArgs, {
      cwd: directory, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000, windowsHide: true,
    });
    assert.notEqual(result.status, 0, 'the grandchild must exit with an error on a pre-existing file');
    assert.equal(readFileSync(stale, 'utf8'), 'stale\n', 'the stale file must be refused, not reused or replaced');
  });
  await withReaderDirectory(async (directory) => {
    const grandchild = spawnProcess(process.execPath, grandchildArgs, {
      cwd: directory, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
    });
    let exited = false;
    const exit = new Promise((resolve) => grandchild.once('exit', () => { exited = true; resolve(); }));
    try {
      const reader = createFileLineReader(fsModule, path.join(directory, 'pt-grandchild-ready.jsonl'), () => exited, true);
      assert.deepEqual(await reader(8_000), { status: 'PASS', value: { mode: 'process-tree-grandchild-ready' } });
      assert.equal(exited, false, 'the grandchild stays alive after reporting readiness');
    } finally {
      grandchild.kill();
      await exit;
    }
  });
});

test('AppContainer process-tree roles never pass pipe or ipc stdio to spawn', async () => {
  const worker = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  const probeStart = worker.indexOf('async function processTreeProbe(');
  const probeEnd = worker.indexOf('\nasync function networkProbe(', probeStart);
  assert.ok(probeStart !== -1 && probeEnd > probeStart);
  const workerProbe = worker.slice(probeStart, probeEnd);
  assert.match(workerProbe, /stdio: \['ignore', childFd, 'ignore'\]/u);
  assert.match(workerProbe, /openSync\(childReadyPath, 'wx'\)/u);
  assert.doesNotMatch(workerProbe, /'pipe'|'ipc'|"pipe"|"ipc"|createJsonLineReader/u);

  // The only pipe left in the child script is the trusted host-only child-test branch.
  // The AppContainer grandchild gets all-ignore stdio so it keeps its own console (no inherited fd).
  assert.match(PROCESS_TREE_CHILD_SCRIPT, /stdio: \['ignore', testRole \? 'pipe' : 'ignore', 'ignore'\]/u);
  assert.match(PROCESS_TREE_CHILD_SCRIPT, /if \(!testRole && fs\.existsSync\(readyPath\)\) throw/u);
  assert.doesNotMatch(PROCESS_TREE_CHILD_SCRIPT, /openSync\(readyPath/u, 'the child must not create the grandchild file');
  const appContainerChild = PROCESS_TREE_CHILD_SCRIPT.replace("testRole ? 'pipe' : 'ignore'", "'ignore'");
  assert.doesNotMatch(appContainerChild, /'pipe'|'ipc'|"pipe"|"ipc"/u);
  assert.doesNotMatch(PROCESS_TREE_GRANDCHILD_SCRIPT, /spawn|'pipe'|'ipc'/u);
  assert.match(PROCESS_TREE_GRANDCHILD_SCRIPT, /openSync\([^\n]*'pt-grandchild-ready\.jsonl'\), 'wx'\)/u);
  assert.match(PROCESS_TREE_GRANDCHILD_SCRIPT, /fs\.writeSync\(fd, line\)/u);
  assert.doesNotMatch(PROCESS_TREE_GRANDCHILD_SCRIPT, /writeSync\(1,|closeSync/u);
});

test('worker failure diagnostics never emit candidate-controlled codes or messages', () => {
  const candidateError = new Error('candidate private diagnostic');
  candidateError.code = 'candidate_private_code';
  const emittedCandidateDiagnostic = 'isolated_worker_failed:' + safeWorkerErrorCode(candidateError) + String.fromCharCode(10);

  assert.equal(emittedCandidateDiagnostic, 'isolated_worker_failed:worker_failure\n');
  assert.doesNotMatch(emittedCandidateDiagnostic, /candidate private diagnostic|candidate_private_code/);
  assert.equal(safeWorkerErrorCode(Object.assign(new Error('candidate private diagnostic'), { code: 'invalid_request' })), 'worker_failure');
  assert.equal(safeWorkerErrorCode(new WorkerProtocolError('invalid_request', 'worker message')), 'invalid_request');
  assert.equal(safeWorkerErrorCode(new WorkerProtocolError('candidate_private_code', 'worker message')), 'worker_failure');
  const changingCodeError = new WorkerProtocolError('invalid_request', 'worker message');
  let codeReads = 0;
  Object.defineProperty(changingCodeError, 'code', {
    get() {
      codeReads += 1;
      return codeReads === 1 ? 'invalid_request' : 'candidate_private_code';
    },
  });
  assert.equal(safeWorkerErrorCode(changingCodeError), 'invalid_request');
  assert.equal(codeReads, 1);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(safeWorkerErrorCode(revoked.proxy), 'worker_failure');
});

function completedTransport(responseJson) {
  return async () => ({
    state: 'completed',
    exit_code: 0,
    timed_out: false,
    job_drained: true,
    worker_token_verified: true,
    job_membership_verified: true,
    output_truncated: false,
    profile_cleanup_verified: true,
    staging_cleanup_verified: true,
    response_json: responseJson,
    failure_code: null,
  });
}

test('production worker dispatches only registry operations through an injected fake module loader', async () => {
  const request = createWorkerRequest({
    taskId: 'P01',
    calls: [{ callId: 'range-1', operationId: 'call', args: [2, 1, 3] }],
  });
  const imported = [];
  const response = await executeWorkerRequest(request, {
    workspaceRoot: BASE_WORKSPACE,
    importModule: async (url) => {
      imported.push(url);
      return { isWithinRange: (value, lower, upper) => value > lower && value < upper };
    },
  });
  const parsed = parseWorkerResponse(JSON.stringify(response), request);

  assert.deepEqual(imported, [pathToFileURL(path.join(BASE_WORKSPACE, 'src', 'range.mjs')).href]);
  assert.equal(parsed.results[0].ok, true);
  assert.equal(parsed.results[0].value, true);
  assert.deepEqual(parsed.results[0].sameAsArgs, [false, false, false]);
  assert.deepEqual(parsed.results[0].argsAfter, [2, 1, 3]);
});

test('B06 worker bridge preserves shallow frozen inputs across the JSON protocol', async () => {
  const defaults = Object.freeze({ nested: { limit: 3 } });
  const override = Object.freeze({ nested: { limit: 5 } });
  const request = createWorkerRequest({
    taskId: 'B06',
    calls: [{ callId: 'frozen-config-1', operationId: 'call', args: [defaults, override] }],
  });
  const response = await executeWorkerRequest(request, {
    workspaceRoot: B06_WORKSPACE,
    importModule: async () => ({
      mergeConfig: (workerDefaults, workerOverride) => {
        assert.equal(Object.isFrozen(workerDefaults), true);
        assert.equal(Object.isFrozen(workerOverride), true);
        assert.equal(Object.isFrozen(workerDefaults.nested), false);
        workerDefaults.nested.limit = 4;
        assert.equal(workerDefaults.nested.limit, 4);
        return { defaultsFrozen: Object.isFrozen(workerDefaults), nestedLimit: workerDefaults.nested.limit };
      },
    }),
  });
  const parsed = parseWorkerResponse(JSON.stringify(response), request);

  assert.equal(parsed.results[0].ok, true);
  assert.equal(parsed.results[0].value.defaultsFrozen, true);
  assert.equal(parsed.results[0].value.nestedLimit, 4);
});

test('PowerShell worker launcher checks the current worker protocol version', async () => {
  const launcher = await readFile(new URL('./run-worker.ps1', import.meta.url), 'utf8');
  const match = launcher.match(/^\$workerProtocolVersion = ([0-9]+)$/m);
  assert.ok(match, 'launcher must declare its worker protocol version');
  const protocol = await import('./protocol.mjs');
  assert.equal(Number(match[1]), protocol.WORKER_PROTOCOL_VERSION);
  assert.match(launcher, /workerRequest\.schemaVersion -ne \$workerProtocolVersion/);
});

test('PowerShell worker launcher uses access-section .NET ACL calls only', async () => {
  const launcher = await readFile(new URL('./run-worker.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(launcher, /Get-Acl/i);
  assert.doesNotMatch(launcher, /Set-Acl/i);
  assert.match(launcher, /^param\(\[switch\]\$AclSelfTest\)\r?$/m);
  assert.match(launcher, /GetAccessControl\(\$sections\)/);
  assert.match(launcher, /SetSecurityDescriptorSddlForm\(/);
  assert.match(launcher, /throw 'workspace_acl_restore_mismatch'/);
  assert.match(launcher, /if \(\$AclSelfTest\) \{ Invoke-AclSelfTest \}\r?\n\r?\ntry \{/);
});

test('PowerShell worker launcher ACL self-test saves, sets, and restores a temp tree', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ISOLATION_DIRECTORY, 'run-worker.ps1'), '-AclSelfTest',
  ], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stdout, /^ACL_SELFTEST_PASS\r?$/m);
});

test('worker preserves branded no-op inputs and reports identity with captured native Object.is', async () => {
  const noop = createNoopFunctionFixture();
  const request = createWorkerRequest({
    taskId: 'P01',
    calls: [{ callId: 'identity-1', operationId: 'call', args: [noop] }],
  });
  const originalObjectIs = Object.is;
  let response;
  try {
    response = await executeWorkerRequest(request, {
      workspaceRoot: BASE_WORKSPACE,
      importModule: async () => {
        Object.is = () => false;
        return { isWithinRange: (value) => value };
      },
    });
  } finally {
    Object.is = originalObjectIs;
  }

  const parsed = parseWorkerResponse(JSON.stringify(response), request);
  assert.deepEqual(parsed.results[0].sameAsArgs, [true]);
  assert.equal(typeof parsed.results[0].value, 'function');
  assert.equal(parsed.results[0].value(), undefined);
});

test('worker returns a safe mismatch sentinel for an arbitrary function output', async () => {
  const request = createWorkerRequest({
    taskId: 'P01',
    calls: [{ callId: 'unserializable-1', operationId: 'call', args: [] }],
  });
  const response = await executeWorkerRequest(request, {
    workspaceRoot: BASE_WORKSPACE,
    importModule: async () => ({ isWithinRange: () => () => undefined }),
  });
  const parsed = parseWorkerResponse(JSON.stringify(response), request);

  assert.equal(isUnserializableWorkerValue(parsed.results[0].value), true);
  assert.equal(parsed.results[0].value.kind, 'function');
  assert.equal(typeof parsed.results[0].value, 'object');
});

test('host bridge sends only bounded task inputs and keeps expected values out of the worker request', async () => {
  let captured;
  const runner = createIsolatedWorkerRunner({
    authorizeWorkspace: async ({ workspaceRoot, taskId }) => workspaceRoot === BASE_WORKSPACE && taskId === 'P01',
    transport: async (input) => {
      captured = input;
      const request = parseWorkerRequest(input.requestJson);
      assert.equal(Object.hasOwn(request, 'expected'), false);
      assert.deepEqual(Object.keys(request.calls[0]).sort(), ['args', 'callId', 'operationId']);
      const response = createWorkerResponse(request, [{
        callId: request.calls[0].callId,
        ok: true,
        argsAfter: decodeValue(request.calls[0].args),
        sameAsArgs: [false, false, false],
        value: true,
      }]);
      return {
        state: 'completed',
        exit_code: 0,
        timed_out: false,
        job_drained: true,
        worker_token_verified: true,
        job_membership_verified: true,
        output_truncated: false,
        profile_cleanup_verified: true,
        staging_cleanup_verified: true,
        response_json: serializeWorkerResponse(response, request),
        failure_code: null,
      };
    },
  });

  const result = await runner({
    workspaceRoot: BASE_WORKSPACE,
    taskId: 'P01',
    timeoutMs: 10_000,
    calls: [{ callId: 'range-1', operationId: 'call', args: [2, 1, 3] }],
  });

  assert.equal(captured.workspaceRoot, BASE_WORKSPACE);
  assert.equal(captured.timeoutMs, 10_000);
  assert.equal(Buffer.byteLength(captured.requestJson, 'utf8') <= MAX_REQUEST_BYTES, true);
  assert.equal(result.results[0].value, true);
  assert.equal(result.evidence.workerTokenVerified, true);
});

test('host bridge fails closed when launcher evidence or cleanup is incomplete', async () => {
  const runner = createIsolatedWorkerRunner({
    authorizeWorkspace: async ({ workspaceRoot }) => workspaceRoot === BASE_WORKSPACE,
    transport: async () => ({
      state: 'completed',
      exit_code: 0,
      timed_out: false,
      job_drained: true,
      worker_token_verified: true,
      job_membership_verified: true,
      output_truncated: false,
      profile_cleanup_verified: false,
      staging_cleanup_verified: true,
      response_json: '{}',
      failure_code: null,
    }),
  });

  await assert.rejects(runner({
    workspaceRoot: BASE_WORKSPACE,
    taskId: 'P01',
    timeoutMs: 10_000,
    calls: [{ operationId: 'call', args: [] }],
  }), (error) => error instanceof IsolatedWorkerError && error.code === 'isolation_runner_failure');
});

test('host bridge maps only a drained AppContainer timeout to task timeout', async () => {
  const runner = createIsolatedWorkerRunner({
    authorizeWorkspace: async ({ workspaceRoot }) => workspaceRoot === BASE_WORKSPACE,
    transport: async () => ({
      state: 'timeout',
      timed_out: true,
      job_drained: true,
      profile_cleanup_verified: true,
      staging_cleanup_verified: true,
    }),
  });

  await assert.rejects(runner({
    workspaceRoot: BASE_WORKSPACE,
    taskId: 'P01',
    timeoutMs: 1_000,
    calls: [{ operationId: 'call', args: [] }],
  }), (error) => error instanceof IsolatedWorkerError && error.code === 'timeout');
});

test('host bridge does not treat a timeout with unverified cleanup as an ordinary task timeout', async () => {
  const runner = createIsolatedWorkerRunner({
    authorizeWorkspace: async ({ workspaceRoot }) => workspaceRoot === BASE_WORKSPACE,
    transport: async () => ({
      state: 'timeout',
      timed_out: true,
      job_drained: true,
      profile_cleanup_verified: false,
      staging_cleanup_verified: true,
    }),
  });

  await assert.rejects(runner({
    workspaceRoot: BASE_WORKSPACE,
    taskId: 'P01',
    timeoutMs: 1_000,
    calls: [{ operationId: 'call', args: [] }],
  }), (error) => error instanceof IsolatedWorkerError && error.code === 'cleanup_unverified');
});

test('host bridge rejects relative workspace roots and unregistered request fields', async () => {
  const runner = createIsolatedWorkerRunner({
    authorizeWorkspace: async ({ workspaceRoot }) => workspaceRoot === BASE_WORKSPACE,
    transport: async () => { throw new Error('transport should not run'); },
  });

  await assert.rejects(runner({
    workspaceRoot: 'relative/workspace',
    taskId: 'P01',
    timeoutMs: 1_000,
    calls: [{ operationId: 'call', args: [] }],
  }), (error) => error instanceof IsolatedWorkerError && error.code === 'invalid_workspace');

  assert.throws(() => createWorkerRequest({
    taskId: 'P01',
    calls: [{ operationId: 'call', args: [], expected: true }],
  }));
});

test('host bridge requires a trusted workspace authorizer and rejects an unmanaged root before launch', async () => {
  assert.throws(() => createIsolatedWorkerRunner({ transport: async () => ({}) }), /workspace authorizer is required/);
  const runner = createIsolatedWorkerRunner({
    authorizeWorkspace: async () => false,
    transport: async () => { throw new Error('transport should not run'); },
  });

  await assert.rejects(runner({
    workspaceRoot: BASE_WORKSPACE,
    taskId: 'P01',
    timeoutMs: 1_000,
    calls: [{ operationId: 'call', args: [] }],
  }), (error) => error instanceof IsolatedWorkerError && error.code === 'workspace_not_authorized');
});

test('launcher stdout decoding rejects malformed UTF-8', () => {
  assert.throws(() => parseLauncherStdout(Buffer.from([0x7b, 0xff, 0x7d])), (error) =>
    error instanceof IsolatedWorkerError && error.code === 'invalid_launcher_encoding');
});

test('AppContainer launcher decodes worker stdout with strict UTF-8', async () => {
  const source = await readFile(path.resolve(ISOLATION_DIRECTORY, 'AppContainerLauncher.cs'), 'utf8');
  assert.match(source, /new UTF8Encoding\(false,\s*true\)\.GetString\(stdout\.ToArray\(\)\)/);
});

test('inline stdio smoke releases stdin and stdout only after its final marker flush', async () => {
  const source = await readFile(path.resolve(ISOLATION_DIRECTORY, 'AppContainerLauncher.cs'), 'utf8');
  const scriptStart = source.indexOf('private const string INLINE_STDIO_SMOKE_SCRIPT =');
  const scriptEnd = source.indexOf('private sealed class InputWriteState', scriptStart);
  assert.notEqual(scriptStart, -1);
  assert.ok(scriptEnd > scriptStart);
  const script = source.slice(scriptStart, scriptEnd);
  const markerWrite = script.indexOf("process.stdout.write('INPUT_OK:'");
  const writeCallback = script.indexOf(',e=>{', markerWrite);
  const stdinPause = script.indexOf('process.stdin.pause()', markerWrite);
  const stdinUnref = script.indexOf('process.stdin.unref()', markerWrite);
  const stdoutUnref = script.indexOf('process.stdout.unref()', markerWrite);
  const callbackEnd = script.indexOf('});', stdoutUnref);

  assert.notEqual(markerWrite, -1);
  assert.ok(writeCallback > markerWrite);
  assert.ok(stdinPause > writeCallback);
  assert.ok(stdinUnref > stdinPause);
  assert.ok(stdoutUnref > stdinUnref);
  assert.ok(callbackEnd > stdoutUnref);
  assert.match(script, /typeof process\.stdout\.unref==='function'/);
  assert.doesNotMatch(script, /process\.exit\(/);
});

test('production worker flushes its single response before releasing stdio handles', async () => {
  const source = await readFile(path.resolve(ISOLATION_DIRECTORY, 'production-worker.mjs'), 'utf8');
  const responseFlush = source.indexOf('await writeAndFlush(process.stdout, responseJson);');
  const responseRelease = source.indexOf('releaseStdio();', responseFlush);
  const errorFlush = source.indexOf('await writeAndFlush(process.stderr, `isolated_worker_failed:${code}\\n`);');
  const errorRelease = source.indexOf('releaseStdio();', errorFlush);

  assert.notEqual(responseFlush, -1);
  assert.ok(responseRelease > responseFlush);
  assert.notEqual(errorFlush, -1);
  assert.match(source, /const code = safeWorkerErrorCode\(error\)/);
  assert.ok(errorRelease > errorFlush);
  assert.match(source, /if \(typeof process\.stdin\.pause === 'function'\) process\.stdin\.pause\(\)/);
  assert.match(source, /for \(const stream of \[process\.stdin, process\.stdout, process\.stderr\]\)[\s\S]*?stream\.unref\(\)/);
  assert.doesNotMatch(source, /process\.exit\(/);
});

test('both AppContainer Job Objects enforce the 1 GiB memory limit and fail closed', async () => {
  const source = await readFile(path.resolve(ISOLATION_DIRECTORY, 'AppContainerLauncher.cs'), 'utf8');
  assert.match(source, /JOB_OBJECT_LIMIT_JOB_MEMORY\s*=\s*0x00000200/);
  assert.match(source, /MAX_JOB_MEMORY_BYTES\s*=\s*new UIntPtr\(1024UL\s*\*\s*1024UL\s*\*\s*1024UL\)/);

  const methodBody = (methodStart) => {
    const start = source.indexOf(methodStart);
    assert.notEqual(start, -1, `missing method ${methodStart}`);
    const nextMethod = source.indexOf('\n    private static ', start + methodStart.length);
    const nextPublicMethod = source.indexOf('\n    public static ', start + methodStart.length);
    const ends = [nextMethod, nextPublicMethod].filter((index) => index !== -1);
    return source.slice(start, ends.length ? Math.min(...ends) : source.length);
  };
  const nodeWrapper = methodBody('public static AppContainerRunResult RunNode(');
  assert.match(nodeWrapper, /return RunNodeCore\(nodePath,\s*Quote\(workerPath\)/);
  const paths = [
    methodBody('private static SuspendedStartupVariantResult RunSuspendedStartupVariant('),
    methodBody('private static AppContainerRunResult RunNodeCore('),
  ];

  for (const body of paths) {
    assert.match(body, /LimitFlags\s*=\s*JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE\s*\|\s*JOB_OBJECT_LIMIT_ACTIVE_PROCESS\s*\|\s*JOB_OBJECT_LIMIT_JOB_MEMORY/);
    assert.match(body, /limits\.JobMemoryLimit\s*=\s*MAX_JOB_MEMORY_BYTES/);
    assert.match(body, /if\s*\(!SetInformationJobObject\(job,\s*JobObjectExtendedLimitInformation,[\s\S]{0,180}?\)\)\s*throw LastError\("SetInformationJobObject"\)/);
  }
});

test('launcher resolves the deadline race from Job active-process accounting and reports the decision', async () => {
  const source = await readFile(path.resolve(ISOLATION_DIRECTORY, 'AppContainerLauncher.cs'), 'utf8');
  const probeScript = await readFile(path.resolve(ISOLATION_DIRECTORY, 'run-probes.ps1'), 'utf8');
  const methodBody = (methodStart) => {
    const start = source.indexOf(methodStart);
    assert.notEqual(start, -1, `missing method ${methodStart}`);
    const nextMethod = source.indexOf('\n    private static ', start + methodStart.length);
    const nextPublicMethod = source.indexOf('\n    public static ', start + methodStart.length);
    const ends = [nextMethod, nextPublicMethod].filter((index) => index !== -1);
    return source.slice(start, ends.length ? Math.min(...ends) : source.length);
  };
  const core = methodBody('private static AppContainerRunResult RunNodeCore(');
  const startup = methodBody('private static SuspendedStartupVariantResult RunSuspendedStartupVariant(');
  const startupCleanup = methodBody('private static bool TryObserveSuspendedCleanup(');
  const jobDrain = methodBody('private static bool TryWaitForJobDrain(');

  assert.match(source, /JobObjectBasicAccountingInformation\s*=\s*1/);
  assert.match(source, /private static extern bool QueryInformationJobObject\(/);
  assert.match(source, /public static string GetDeadlineDecision\(bool querySucceeded,\s*uint activeProcesses\)/);
  assert.match(source, /public static string GetJobDrainDecision\(bool querySucceeded,\s*uint activeProcesses\)/);
  assert.match(source, /public static uint GetDeadlineWaitMilliseconds\(long elapsedMilliseconds,\s*int timeoutMs\)/);
  assert.match(source, /private static bool TryWaitForJobDrain\([\s\S]{0,900}?TryGetJobActiveProcessCount\(job,\s*out activeProcesses,\s*out queryErrorCode\)/);
  assert.match(core, /WaitForSingleObject\(process\.hProcess,\s*waitMilliseconds\)/);
  assert.match(core, /TryWaitForJobDrain\(job,\s*remainingMilliseconds/);
  assert.match(core, /Action outputPump = delegate\(\)[\s\S]{0,220}?DrainPipe\(stdoutRead[\s\S]{0,120}?DrainPipe\(stderrRead/);
  const coreDrainCalls = core.match(/TryWaitForJobDrain\([\s\S]*?\);/g) || [];
  assert.ok(coreDrainCalls.length >= 4);
  for (const call of coreDrainCalls) assert.match(call, /outputPump\s*\)/);
  assert.ok(jobDrain.indexOf('if (pump != null) pump();') < jobDrain.indexOf('TryGetJobActiveProcessCount'));
  assert.ok(jobDrain.indexOf('if (pump != null) pump();') < jobDrain.indexOf('Thread.Sleep'));
  assert.doesNotMatch(source, /WaitForSingleObject\s*\(\s*job\s*,/);
  assert.doesNotMatch(source, /JobSignaled|FallbackJobSignaled|JobWaitCode|FallbackJobWaitCode/);
  assert.ok(core.indexOf('CloseRootProcessHandlesOrThrow(ref process)') < core.indexOf('TryWaitForJobDrain(job, remainingMilliseconds'));
  assert.ok(startupCleanup.indexOf('TryWaitForProcessSignal(process.hProcess') < startupCleanup.indexOf('TryCloseRootProcessHandles(ref process'));
  assert.ok(startupCleanup.indexOf('TryCloseRootProcessHandles(ref process') < startupCleanup.indexOf('TryWaitForJobDrain(job, 5000'));
  assert.match(startupCleanup, /result\.CleanupConfirmed\s*=\s*result\.RootProcessSignaled\s*&&\s*result\.JobDrained/);
  assert.match(startupCleanup, /result\.FinalProcessWaitCode\s*=\s*waitCode/);
  assert.match(startup, /int attributeCount = appContainer \? 2 : 1/);
  assert.match(startup, /UpdateProcThreadAttribute\(attributes, 0, new IntPtr\(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES\)/);
  assert.match(startup, /UpdateProcThreadAttribute\(attributes, 0, new IntPtr\(PROC_THREAD_ATTRIBUTE_JOB_LIST\)/);
  assert.ok(startup.indexOf('PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES') < startup.indexOf('PROC_THREAD_ATTRIBUTE_JOB_LIST'));
  assert.ok(startup.indexOf('PROC_THREAD_ATTRIBUTE_JOB_LIST') < startup.indexOf('CreateProcess('));
  assert.match(source, /public static string GetTraverseAccessDecision\(bool querySucceeded, bool accessGranted\)/);
  assert.match(source, /public static string GetAccessCheckDecision\(bool querySucceeded, bool accessGranted\)/);
  assert.match(source, /private static extern bool DuplicateTokenEx\(/);
  assert.match(source, /private static extern bool AccessCheck\(/);
  assert.match(source, /private static extern bool LookupPrivilegeValue\(/);
  assert.match(source, /TryQuerySeChangeNotifyPrivilege\(token, out privilegePresent, out privilegeEnabled\)/);
  assert.match(source, /LookupPrivilegeValue\(null, "SeChangeNotifyPrivilege", out targetPrivilege\)/);
  assert.match(source, /GetTokenInformation\(token, TokenPrivileges,/);
  assert.match(source, /TryCheckAccess\(impersonationToken, descriptor, FILE_TRAVERSE, out accessGranted\)/);
  assert.match(source, /AccessCheck\(descriptor, impersonationToken, desiredAccess/);
  assert.match(source, /FILE_READ_ATTRIBUTES = 0x00000080/);
  assert.match(source, /FILE_READ_DATA = 0x00000001/);
  assert.match(source, /TryCheckAccess\(impersonationToken, descriptor,[\s\S]{0,220}?FILE_READ_ATTRIBUTES/);
  assert.match(source, /TryCheckAccess\(impersonationToken, descriptor,[\s\S]{0,220}?FILE_READ_DATA/);
  assert.match(source, /SanitizeStagedFileReadLabel\(stagedFileLabels\[index\]\)/);
  assert.match(source, /CreateUnknownStagedFileReadDiagnostics\(stagedFileLabels\)/);
  assert.ok(startup.indexOf('InspectSuspendedAppContainerToken(process.hProcess') < startup.indexOf('StopSuspendedDiagnosticProcess(ref job, ref process, result)'));
  const passedExpression = startup.slice(startup.indexOf('result.Passed ='), startup.indexOf('return result;', startup.indexOf('result.Passed =')));
  assert.doesNotMatch(passedExpression, /SeChangeNotify|DirectoryTraverse|TraverseAccess/);
  assert.doesNotMatch(passedExpression, /StagedFileRead|FILE_READ_ATTRIBUTES|FILE_READ_DATA/);
  assert.doesNotMatch(startup, /AssignProcessToJobObject/);
  assert.doesNotMatch(source, /JobAssignmentAttempted|JobAssignmentSucceeded|JobAssignmentErrorCode|AssignProcessToJobObject/);
  assert.match(source, /result\.DeadlineDecision\s*=\s*GetDeadlineDecision\(querySucceeded,\s*activeProcesses\)/);
  assert.match(source, /result\.DeadlineActiveProcesses\s*=\s*querySucceeded\s*\?\s*\(uint\?\)activeProcesses\s*:\s*null/);
  assert.match(core, /result\.DeadlineDiagnostic\s*=\s*querySucceeded[\s\S]{0,400}?TerminateJobObject\(job,\s*124\)/);
  assert.match(source, /ActiveProcessesAfterDrain/);
  assert.match(source, /DrainDiagnostic/);
  assert.match(probeScript, /deadline_decision\s*=\s*\$deadlineDecision/);
  assert.match(probeScript, /deadline_active_processes\s*=\s*\$deadlineActiveProcesses/);
  assert.match(probeScript, /deadline_query_error_code\s*=\s*\$deadlineQueryErrorCode/);
  assert.match(probeScript, /duration_ms\s*=\s*\[long\]\$stdioRun\.DurationMs/);
  assert.match(probeScript, /active_process_query_error_code\s*=\s*\[int\]\$stdioRun\.ActiveProcessQueryErrorCode/);
  assert.match(probeScript, /drain_diagnostic\s*=\s*\[string\]\$stdioRun\.DrainDiagnostic/);
  assert.match(probeScript, /job_list_attribute_attempted\s*=\s*\[bool\]\$Attempt\.JobListAttributeAttempted/);
  assert.match(probeScript, /job_list_attribute_succeeded\s*=\s*\[bool\]\$Attempt\.JobListAttributeSucceeded/);
  assert.match(probeScript, /job_list_attribute\s*=\s*\[int\]\$Attempt\.JobListAttributeErrorCode/);
  assert.match(probeScript, /final_root_process_wait\s*=\s*\[int\]\$Attempt\.FinalProcessWaitCode/);
  assert.match(probeScript, /Synthetic startup attribute and final root-wait serialization self-test failed/);
  assert.match(probeScript, /GetDeadlineDecision\(\$true,\s*\[uint32\]0\)[\s\S]{0,260}?GetDeadlineDecision\(\$false,\s*\[uint32\]0\)/);
  assert.match(probeScript, /GetJobDrainDecision\(\$true,\s*\[uint32\]0\)[\s\S]{0,260}?GetJobDrainDecision\(\$false,\s*\[uint32\]0\)/);
  assert.match(probeScript, /GetDeadlineWaitMilliseconds\(0,\s*100\)[\s\S]{0,180}?GetDeadlineWaitMilliseconds\(88,\s*100\)[\s\S]{0,180}?GetDeadlineWaitMilliseconds\(101,\s*100\)/);
});

test('staged read diagnostic uses one fixed CJS script through the AppContainer Job path', async () => {
  const source = await readFile(path.resolve(ISOLATION_DIRECTORY, 'AppContainerLauncher.cs'), 'utf8');
  const constantStart = source.indexOf('private const string STAGED_FILE_READ_DIAGNOSTIC_SCRIPT =');
  const constantEnd = source.indexOf('private const string PROFILE_CONTRACT_IMPORT_DIAGNOSTIC_SCRIPT =', constantStart);
  const script = source.slice(constantStart, constantEnd);
  const wrapperStart = source.indexOf('public static AppContainerRunResult RunStagedFileReadDiagnostic(');
  const wrapperEnd = source.indexOf('\n    private static string CreateStagedFileReadDiagnosticInput(', wrapperStart);
  const wrapper = source.slice(wrapperStart, wrapperEnd);
  const inputStart = wrapperEnd;
  const inputEnd = source.indexOf('\n    private static AppContainerRunResult RunNodeCore(', inputStart);
  const inputBuilder = source.slice(inputStart, inputEnd);
  assert.ok(constantStart !== -1 && constantEnd > constantStart);
  assert.ok(wrapperStart !== -1 && wrapperEnd > wrapperStart);
  assert.ok(inputEnd > inputStart);
  assert.match(wrapper, /RunNodeCore\(nodePath, "-e " \+ Quote\(STAGED_FILE_READ_DIAGNOSTIC_SCRIPT\)/);
  assert.doesNotMatch(wrapper, /RunNode\(/);
  assert.match(inputBuilder, /Path\.GetFullPath\(Path\.Combine\(toolsRoot, "worker\.mjs"\)\)/);
  assert.match(inputBuilder, /Path\.GetFullPath\(Path\.Combine\(toolsRoot, "probe-contract\.mjs"\)\)/);
  assert.match(inputBuilder, /MAX_STAGED_READ_DIAGNOSTIC_INPUT_BYTES/);
  assert.match(source, /MAX_STAGED_READ_DIAGNOSTIC_INPUT_BYTES = 4095/);
  assert.match(inputBuilder, /EscapeJsonString\(expectedWorker\)/);
  assert.match(inputBuilder, /EscapeJsonString\(expectedContract\)/);
  assert.match(script, /MAX_INPUT=4096,MAX_FILE=262144,MAX_OUTPUT=4096/);
  assert.match(script, /Buffer\.byteLength\(output,'utf8'\)\+1>MAX_OUTPUT/);
  assert.match(script, /fs\.lstat\(filePath\)/);
  assert.match(script, /stat\.isFile\(\).*stat\.isSymbolicLink\(\)/);
  assert.match(script, /fs\.open\(filePath,'r'\)/);
  assert.match(script, /handle\.read\(buffer,0,Math\.min\(buffer\.length,remaining\),null\)/);
  const readStart = script.indexOf('async function readBounded(');
  const readEnd = script.indexOf('async function inspect(', readStart);
  assert.ok(readStart !== -1 && readEnd > readStart);
  const readBounded = script.slice(readStart, readEnd);
  assert.match(readBounded, /if\(statSize>MAX_FILE\)return op\('read','FAIL','TOO_LARGE'\)/);
  assert.ok(readBounded.indexOf('if(statSize>MAX_FILE)') < readBounded.indexOf("handle=await fs.open(filePath,'r')"));
  assert.match(readBounded, /opened\.size!==statSize/);
  assert.match(readBounded, /while\(total<statSize\)/);
  assert.match(readBounded, /const remaining=statSize-total/);
  assert.match(readBounded, /finalStat\.size===statSize/);
  assert.doesNotMatch(readBounded, /MAX_FILE\s*\+\s*1/);
  assert.match(script, /buffer\.fill\(0\)/);
  assert.match(script, /exactKeys\(request,\['workerModule','probeContract'\]\)/);
  assert.match(script, /path\.win32\.resolve\(request\.workerModule\)/);
  assert.match(script, /path\.win32\.resolve\(request\.probeContract\)/);
  assert.match(script, /schema_version:1,files,ancestor_chain:op\('ancestor_chain',ancestorResult\.status,ancestorResult\.error_code\),ancestors:ancestorResult\.ancestors,import:importResult/);
  const ancestorStart = script.indexOf('async function inspectAncestor(');
  const ancestorEnd = script.indexOf('async function inspectAncestors(', ancestorStart);
  const ancestorFunction = script.slice(ancestorStart, ancestorEnd);
  assert.ok(ancestorStart !== -1 && ancestorEnd > ancestorStart);
  assert.match(script, /MAX_ANCESTORS=32/);
  assert.match(script, /CHAIN_TOO_DEEP/);
  assert.doesNotMatch(script, /fs\.(?:readdir|opendir)\(/);
  assert.match(ancestorFunction, /fs\.lstat\(filePath\)/);
  assert.match(ancestorFunction, /fs\.realpath\(filePath\)/);
  assert.doesNotMatch(ancestorFunction, /fs\.(?:readdir|opendir|open|readFile|read)\(/);
  assert.match(script, /IMPORT_SYSCALLS\.has\(rawSyscall\)/);
  assert.match(script, /mapImportPath\(rawPath,expectedWorker,expectedContract,ancestorPaths\)/);
  assert.match(script, /importFailure\(error,expectedWorker,expectedContract,ancestorResult\.paths\)/);
  assert.match(script, /entry\[1\]===normalized/);
  assert.doesNotMatch(script, /JSON\.stringify\((?:error|rawPath)|\bpath\s*:\s*rawPath/);
  assert.ok(script.indexOf("if(files.every(file=>file.lstat.status==='PASS'&&file.read.status==='PASS'))") <
    script.indexOf('await import(pathToFileURL(expectedContract).href)'));
  assert.doesNotMatch(script, /import\(pathToFileURL\(expectedWorker\)|import\(request\.workerModule/);
  assert.doesNotMatch(script, /\beval\s*\(|new Function|child_process|process\.env|execFile|spawn\(/);
  assert.doesNotMatch(script, /error\.message|error\.stack|console\./);
  assert.match(script, /process\.stdout\.write\(output\+/);
});

test('profile-only contract import uses a fixed bounded AppContainer Job diagnostic', async () => {
  const source = await readFile(path.resolve(ISOLATION_DIRECTORY, 'AppContainerLauncher.cs'), 'utf8');
  const constantStart = source.indexOf('private const string PROFILE_CONTRACT_IMPORT_DIAGNOSTIC_SCRIPT =');
  const constantEnd = source.indexOf('private sealed class InputWriteState', constantStart);
  const fragments = source.slice(constantStart, constantEnd).split(/\r?\n/u).slice(1)
    .map(line => line.trim())
    .filter(line => line.startsWith('"'))
    .map(line => {
      const match = line.match(/^("(?:\\.|[^"\\])*")\s*\+?;?$/u);
      assert.ok(match, `could not decode C# script literal: ${line.slice(0, 48)}`);
      return JSON.parse(match[1]);
    });
  const script = fragments.join('');
  const wrapperStart = source.indexOf('public static AppContainerRunResult RunProfileContractImportDiagnostic(');
  const wrapperEnd = source.indexOf('\n    private static string CreateProfileContractImportDiagnosticInput(', wrapperStart);
  const inputStart = wrapperEnd;
  const inputEnd = source.indexOf('\n    private static string CreateStagedFileReadDiagnosticInput(', inputStart);
  const wrapper = source.slice(wrapperStart, wrapperEnd);
  const inputBuilder = source.slice(inputStart, inputEnd);
  const profilePathGuardStart = source.indexOf('private static string GetProfileLocalAppDataPath(');
  const profilePathGuardEnd = source.indexOf('\n    public static string GetProfilePath(', profilePathGuardStart);
  const profilePathGuard = source.slice(profilePathGuardStart, profilePathGuardEnd);
  const reparseWalkStart = source.indexOf('private static void EnsureNoReparsePointsInPath(');
  const reparseWalkEnd = source.indexOf('\n    private static string GetProfileLocalAppDataPath(', reparseWalkStart);
  const reparsePathWalk = source.slice(reparseWalkStart, reparseWalkEnd);

  assert.ok(constantStart !== -1 && constantEnd > constantStart);
  assert.ok(wrapperStart !== -1 && wrapperEnd > wrapperStart);
  assert.ok(inputEnd > inputStart);
  assert.ok(profilePathGuardStart !== -1 && profilePathGuardEnd > profilePathGuardStart);
  assert.ok(reparseWalkStart !== -1 && reparseWalkEnd > reparseWalkStart);
  assert.match(wrapper, /RunNodeCore\(nodePath, "-e " \+ Quote\(PROFILE_CONTRACT_IMPORT_DIAGNOSTIC_SCRIPT\)/);
  assert.doesNotMatch(wrapper, /RunNode\(/);
  assert.match(inputBuilder, /GetProfileLocalAppDataPath\(profileSid, profileName\)/);
  assert.doesNotMatch(inputBuilder, /ownerLocalAppData|LocalApplicationData|Environment\.GetFolderPath/);
  assert.match(profilePathGuard, /GetAppContainerFolderPath\(profileSid, out path\)/);
  assert.match(profilePathGuard, /GetCanonicalLocalDrivePath\(value, "profilePath"\)/);
  assert.match(profilePathGuard, /string expectedSuffix = "\\\\Packages\\\\" \+ profileName \+ "\\\\AC"/);
  assert.match(profilePathGuard, /EndsWith\(expectedSuffix, StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(profilePathGuard, /EnsureNoReparsePointsInPath\(fullPath\)/);
  assert.match(reparsePathWalk, /string parent = Path\.GetDirectoryName\(current\);[\s\S]*?catch \(FileNotFoundException\)\s*\{[\s\S]*?current = parent;\s*continue;\s*\}[\s\S]*?catch \(DirectoryNotFoundException\)\s*\{[\s\S]*?current = parent;\s*continue;\s*\}/);
  assert.match(reparsePathWalk, /\(attributes & FileAttributes\.ReparsePoint\) != 0/);
  assert.doesNotMatch(reparsePathWalk, /catch\s*\(Exception/);
  assert.match(inputBuilder, /"profile-contract-" \+ nonce/);
  assert.match(inputBuilder, /MAX_PROFILE_CONTRACT_DIAGNOSTIC_INPUT_BYTES/);
  assert.match(source, /MAX_PROFILE_CONTRACT_DIAGNOSTIC_INPUT_BYTES = 255/);
  assert.match(script, /MAX_INPUT=256,MAX_FILE=262144,MAX_OUTPUT=2048/);
  assert.match(script, /exactKeys\(request,\['nonce','expectedSha256'\]\)/);
  assert.match(script, /process\.env\.LOCALAPPDATA/);
  assert.match(script, /'Temp','profile-contract-'\+request\.nonce,'probe-contract\.mjs'/);
  assert.match(script, /fs\.lstat\(contractPath\)/);
  assert.match(script, /fs\.realpath\(contractPath\)/);
  assert.match(script, /fs\.open\(filePath,'r'\)/);
  assert.match(script, /handle\.read\(buffer,0,Math\.min\(buffer\.length,remaining\),null\)/);
  const readStart = script.indexOf('async function readBounded(');
  const readEnd = script.indexOf('async function main(', readStart);
  const boundedRead = script.slice(readStart, readEnd);
  assert.ok(readStart !== -1 && readEnd > readStart);
  assert.match(boundedRead, /if\(statSize>MAX_FILE\)return op\('read','FAIL','TOO_LARGE'\)/);
  assert.ok(boundedRead.indexOf('if(statSize>MAX_FILE)') < boundedRead.indexOf("handle=await fs.open(filePath,'r')"));
  assert.match(boundedRead, /while\(total<statSize\)/);
  assert.match(boundedRead, /const remaining=statSize-total/);
  assert.match(boundedRead, /hash\.digest\('hex'\)===expectedSha256\.toLowerCase\(\)/);
  assert.doesNotMatch(boundedRead, /MAX_FILE\s*\+\s*1/);
  assert.match(script, /lstatResult\.status==='PASS'&&realpathResult\.status==='PASS'&&readResult\.status==='PASS'\)\{try\{const module=await import\(pathToFileURL\(contractPath\)\.href\)/);
  assert.doesNotMatch(script, /worker\.mjs|bench[\\/]oracles|oracle-runner|public-test-registry|\beval\s*\(|new Function|child_process|execFile|spawn\(|fs\.(?:readdir|opendir)\(/);
  assert.doesNotMatch(script, /error\.message|error\.stack|console\.|JSON\.stringify\(error|JSON\.stringify\(rawPath/);
  assert.match(script, /process\.stdout\.write\(output\+/);
});

test('profile bootstrap diagnostic is fixed, bounded, full-trust gated, and cleans only owned paths', async () => {
  const launcher = await readFile(path.resolve(ISOLATION_DIRECTORY, 'AppContainerLauncher.cs'), 'utf8');
  const probe = await readFile(path.resolve(ISOLATION_DIRECTORY, 'run-probes.ps1'), 'utf8');
  const documentation = await readFile(path.resolve(ISOLATION_DIRECTORY, 'README.md'), 'utf8');
  const scriptStart = launcher.indexOf('private const string PROFILE_BOOTSTRAP_DIAGNOSTIC_SCRIPT =');
  const scriptEnd = launcher.indexOf('private const string STAGED_FILE_READ_DIAGNOSTIC_SCRIPT =', scriptStart);
  const scriptLines = launcher.slice(scriptStart, scriptEnd).split(/\r?\n/u).slice(1)
    .map(line => line.trim()).filter(line => line.startsWith('"'));
  const script = scriptLines.map(line => {
    const match = line.match(/^("(?:\\.|[^"\\])*")\s*\+?;?$/u);
    assert.ok(match, `could not decode C# bootstrap script literal: ${line.slice(0, 48)}`);
    return JSON.parse(match[1]);
  }).join('');
  assert.doesNotThrow(() => new Script(script), 'bootstrap inline JavaScript must parse before it is launched');
  const pathChecksStart = script.indexOf('function getProfilePathChecks(');
  const pathChecksEnd = script.indexOf('async function main()', pathChecksStart);
  assert.ok(pathChecksStart !== -1 && pathChecksEnd > pathChecksStart);
  const pathChecksContext = { path };
  runInNewContext(script.slice(pathChecksStart, pathChecksEnd), pathChecksContext);
  const nonce = '0123456789abcdef0123456789abcdef';
  const profileName = `AgentCP${nonce.slice(0, 17)}`;
  const localAppData = path.win32.join('C:\\Users\\Owner\\AppData\\Local', 'Packages', profileName, 'AC');
  const checksFor = (local, temp, tmp) => JSON.parse(JSON.stringify(
    pathChecksContext.getProfilePathChecks(local, temp, tmp, profileName)));
  const allTrueChecks = checksFor(localAppData, path.win32.join(localAppData, 'Temp'), path.win32.join(localAppData, 'Temp'));
  assert.ok(Object.values(allTrueChecks).every(value => value === true));
  assert.equal(pathChecksContext.profilePathAccepted(allTrueChecks), true);
  const mixedCaseProfileName = profileName.toUpperCase();
  const mixedCaseLocalAppData = path.win32.join('C:\\Users\\Owner\\AppData\\Local', 'Packages', mixedCaseProfileName, 'AC');
  const mixedCaseChecks = checksFor(mixedCaseLocalAppData, path.win32.join(mixedCaseLocalAppData, 'Temp'),
    path.win32.join(mixedCaseLocalAppData, 'Temp'));
  assert.equal(mixedCaseChecks.parent_matches_nonce_name, false);
  assert.equal(mixedCaseChecks.parent_matches_nonce_name_ordinal_ignore_case, true);
  assert.equal(pathChecksContext.profilePathAccepted(mixedCaseChecks), true);
  assert.equal(checksFor('\\Users\\Owner\\AppData\\Local\\Packages\\AgentCP01234567890123456\\AC', '', '').local_drive_absolute, false);
  const nonCanonicalLocal = `${path.win32.dirname(localAppData)}\\ignored\\..\\AC`;
  assert.equal(checksFor(nonCanonicalLocal, path.win32.join(nonCanonicalLocal, 'Temp'),
    path.win32.join(nonCanonicalLocal, 'Temp')).local_canonical, false);
  assert.equal(checksFor(`${localAppData}:stream`, `${localAppData}:stream\\Temp`, `${localAppData}:stream\\Temp`).local_no_stream, false);
  const wrongParentLocal = path.win32.join(path.win32.dirname(path.win32.dirname(localAppData)), 'Other', 'AC');
  assert.equal(checksFor(wrongParentLocal, path.win32.join(wrongParentLocal, 'Temp'),
    path.win32.join(wrongParentLocal, 'Temp')).parent_matches_nonce_name, false);
  assert.equal(checksFor(wrongParentLocal, path.win32.join(wrongParentLocal, 'Temp'),
    path.win32.join(wrongParentLocal, 'Temp')).parent_matches_nonce_name_ordinal_ignore_case, false);
  assert.equal(pathChecksContext.profilePathAccepted(checksFor(wrongParentLocal,
    path.win32.join(wrongParentLocal, 'Temp'), path.win32.join(wrongParentLocal, 'Temp'))), false);
  const wrongGrandparentLocal = path.win32.join(path.win32.dirname(path.win32.dirname(path.win32.dirname(localAppData))),
    'Packages', 'Other', profileName, 'AC');
  assert.equal(checksFor(wrongGrandparentLocal, path.win32.join(wrongGrandparentLocal, 'Temp'),
    path.win32.join(wrongGrandparentLocal, 'Temp')).grandparent_is_packages, false);
  assert.equal(checksFor(path.win32.join(path.win32.dirname(localAppData), 'OTHER'),
    path.win32.join(path.win32.dirname(localAppData), 'OTHER', 'Temp'),
    path.win32.join(path.win32.dirname(localAppData), 'OTHER', 'Temp')).local_leaf_is_ac, false);
  assert.equal(checksFor(localAppData, 'D:\\Temp', path.win32.join(localAppData, 'Temp')).temp_matches_local_child, false);
  assert.equal(checksFor(localAppData, path.win32.join(localAppData, 'Temp'), 'D:\\Temp').tmp_matches_local_child, false);
  assert.match(script, /failed\.profile_path_shape='FAIL';failed\.profile_path_checks=profilePathChecks/);
  assert.match(script, /profile_path_checks:profilePathChecks/);
  assert.match(script, /parent_matches_nonce_name_ordinal_ignore_case:localIsString&&ordinalIgnoreCaseAscii\(parent,name\)/);
  assert.match(script, /parent_matches_nonce_name_ordinal_ignore_case:null/);
  assert.match(script, /if\(!profilePathAccepted\(profilePathChecks\)\)/);
  const runStart = launcher.indexOf('public static AppContainerRunResult RunProfileBootstrapDiagnostic(');
  const runEnd = launcher.indexOf('\n    private static string CreateProfileBootstrapDiagnosticInput(', runStart);
  const runMethod = launcher.slice(runStart, runEnd);
  const inputStart = runEnd;
  const inputEnd = launcher.indexOf('\n    private static string CreateProfileContractImportDiagnosticInput(', inputStart);
  const inputBuilder = launcher.slice(inputStart, inputEnd);
  const candidateStart = probe.indexOf('function Get-ProfileBootstrapCandidatePath(');
  const candidateEnd = probe.indexOf('\nfunction Get-AppContainerProfilePackagesRoot(', candidateStart);
  const candidateBuilder = probe.slice(candidateStart, candidateEnd);
  const stagingAclStart = probe.indexOf('function Set-ProfileBootstrapStagingAcl(');
  const stagingAclEnd = probe.indexOf('\nfunction Get-DirectoryAncestorDescriptorInputs(', stagingAclStart);
  const stagingAclHelper = probe.slice(stagingAclStart, stagingAclEnd);
  const stagingAclDecisionStart = probe.indexOf('function Get-ProfileBootstrapStagingAclStatus(');
  const stagingAclDecisionEnd = probe.indexOf('\nfunction Set-ProfileBootstrapStagingAcl(', stagingAclDecisionStart);
  const stagingAclDecision = probe.slice(stagingAclDecisionStart, stagingAclDecisionEnd);
  const createProfile = probe.indexOf('[AppContainerLauncher]::CreateProfile($profileName)');
  const preflightStart = probe.lastIndexOf('if ($ProfileBootstrapDiagnosticOnly) {', createProfile);
  const preflight = probe.slice(preflightStart, createProfile);
  const launchStart = probe.indexOf('if ($ProfileBootstrapDiagnosticOnly) {', createProfile);
  const normalProfileStart = probe.indexOf('$profilePath = [AppContainerLauncher]::GetProfilePath', launchStart);
  const bootstrapBranch = probe.slice(launchStart, normalProfileStart);
  const finallyStart = probe.indexOf('\nfinally {');
  const bootstrapCleanupStart = probe.indexOf('if ($ProfileBootstrapDiagnosticOnly) {', finallyStart);
  const bootstrapCleanupEnd = probe.indexOf('\n    if ($profileRunStageInTemp) {', bootstrapCleanupStart + 1);
  const bootstrapCleanup = probe.slice(bootstrapCleanupStart, bootstrapCleanupEnd);
  const buildEnvironmentStart = launcher.indexOf('private static IntPtr BuildEnvironment(');
  const buildEnvironmentEnd = launcher.indexOf('\n    private static string Quote(', buildEnvironmentStart);
  const buildEnvironment = launcher.slice(buildEnvironmentStart, buildEnvironmentEnd);
  const profileTrustStart = launcher.indexOf('public static bool IsCurrentProcessFullTrust()');
  const profileTrustEnd = launcher.indexOf('\n    public static bool ProfileSidMatchesName(', profileTrustStart);
  const profileTrust = launcher.slice(profileTrustStart, profileTrustEnd);
  const sidStart = launcher.indexOf('public static bool ProfileSidMatchesName(');
  const sidEnd = launcher.indexOf('\n    public static ProfilePathDiagnosticResult ObserveProfilePath(', sidStart);
  const sidCheck = launcher.slice(sidStart, sidEnd);
  const apiObserveStart = launcher.indexOf('public static ProfilePathDiagnosticResult ObserveProfilePath(');
  const apiObserveEnd = launcher.indexOf('\n    public static StartupAttributeDiagnosticResult RunStartupAttributeDiagnostics(', apiObserveStart);
  const apiObserve = launcher.slice(apiObserveStart, apiObserveEnd);

  assert.ok(scriptStart !== -1 && scriptEnd > scriptStart);
  assert.ok(runStart !== -1 && runEnd > runStart && inputEnd > inputStart);
  assert.ok(candidateStart !== -1 && candidateEnd > candidateStart);
  assert.ok(stagingAclStart !== -1 && stagingAclEnd > stagingAclStart);
  assert.ok(stagingAclDecisionStart !== -1 && stagingAclDecisionEnd > stagingAclDecisionStart);
  assert.ok(preflightStart !== -1 && launchStart !== -1 && normalProfileStart > launchStart);
  assert.ok(bootstrapCleanupStart !== -1 && bootstrapCleanupEnd > bootstrapCleanupStart);
  assert.match(runMethod, /CreateProfileBootstrapDiagnosticInput\(/);
  assert.match(runMethod, /RunNodeCore\(nodePath, "-e " \+ Quote\(PROFILE_BOOTSTRAP_DIAGNOSTIC_SCRIPT\)/);
  assert.match(runMethod, /RunNodeCore\([\s\S]*?canonicalToolsDirectory, profileSid/);
  assert.match(runMethod, /profileCandidatePath, false\)/);
  assert.doesNotMatch(runMethod, /GetProfileLocalAppDataPath|GetAppContainerFolderPath|CreateDirectory/);
  assert.match(inputBuilder, /ValidateProfileCandidatePath\(profileCandidatePath, profileName, nonce\)/);
  assert.match(inputBuilder, /ValidateProfileBootstrapToolsDirectory\(toolsDirectory, nodePath, nonce\)/);
  assert.match(launcher, /ValidateProfileBootstrapToolsDirectory[\s\S]*?tools\.Name, "tools"[\s\S]*?tools\.Parent\.Name, nonce[\s\S]*?Path\.Combine\(canonicalToolsDirectory, "node\.exe"\)/);
  assert.match(inputBuilder, /"\{\\"nonce\\":\\"" \+ nonce \+ "\\"\}"/);
  assert.match(inputBuilder, /MAX_PROFILE_BOOTSTRAP_DIAGNOSTIC_INPUT_BYTES/);
  assert.match(candidateBuilder, /if \(-not \$CallerFullTrust\)/);
  assert.match(candidateBuilder, /Packages\\\\sandbox/);
  assert.match(candidateBuilder, /Assert-NoReparsePath \$candidatePath/);
  assert.doesNotMatch(candidateBuilder, /New-SafeDirectory|Directory\]::CreateDirectory|Set-ProbeAcl|SetAccessControl/);
  assert.match(stagingAclHelper, /Set-ProbeAcl \$canonicalStageRoot \$AppSid[^\r\n]*FileSystemRights\]::Traverse\) \$false/);
  assert.match(stagingAclHelper, /Set-ProbeAcl \$canonicalToolsRoot \$AppSid[^\r\n]*FileSystemRights\]::ReadAndExecute\) \$true/);
  assert.match(stagingAclHelper, /Get-AppSidDaclSummary 'stageRoot'[\s\S]*?FileSystemRights\]::Traverse/);
  assert.match(stagingAclHelper, /Get-AppSidDaclSummary 'toolsRoot'[\s\S]*?FileSystemRights\]::ReadAndExecute/);
  assert.match(stagingAclHelper, /Get-AppSidDaclSummary 'stagedNode'[\s\S]*?FileSystemRights\]::ReadAndExecute/);
  assert.match(stagingAclHelper, /expectedStageRoot[\s\S]*?expectedToolsRoot[\s\S]*?expectedStagedNode/);
  assert.doesNotMatch(stagingAclHelper, /workspaceRoot|profileCandidatePath|bench[\\/]oracles|Set-ProbeAcl \$workspaceRoot/);
  assert.match(stagingAclDecision, /status -ceq 'UNKNOWN'[\s\S]*?status -cne 'PASS'[\s\S]*?potentially_conflicting_deny_ace_present/);
  assert.match(preflight, /IsCurrentProcessFullTrust\(\)/);
  assert.match(preflight, /Get-ProfileBootstrapCandidatePath/);
  assert.doesNotMatch(preflight, /CreateProfile\(|GetProfilePath\(|GetAppContainerFolderPath/);
  assert.match(bootstrapBranch, /ProfileSidMatchesName\(\$profileSidText, \$profileName\)/);
  assert.match(bootstrapBranch, /candidate_absent_before_create = \[bool\]\$profileBootstrapCandidateAbsentBefore/);
  assert.ok(bootstrapBranch.indexOf('Set-ProfileBootstrapStagingAcl') < bootstrapBranch.indexOf('RunProfileBootstrapDiagnostic('));
  assert.match(bootstrapBranch, /staging_acl\.status = 'UNKNOWN'/);
  assert.match(bootstrapBranch, /profileBootstrapStagingAclObservation\.status -cne 'PASS'/);
  assert.match(bootstrapBranch, /RunProfileBootstrapDiagnostic\(\s*\$stageNode,\s*\$toolsRoot,/s);
  assert.doesNotMatch(bootstrapBranch, /\$workspaceRoot/);
  const beforeApi = bootstrapBranch.indexOf('ObserveProfilePath(');
  const bootstrapRun = bootstrapBranch.indexOf('RunProfileBootstrapDiagnostic(');
  const afterApi = bootstrapBranch.lastIndexOf('ObserveProfilePath(');
  assert.ok(bootstrapBranch.indexOf('ProfileSidMatchesName(') < beforeApi);
  assert.ok(beforeApi !== -1 && beforeApi < bootstrapRun && bootstrapRun < afterApi);
  assert.equal((bootstrapBranch.match(/ObserveProfilePath\(\$profileSidText, \$profileName, \$nonce, \$profileBootstrapCandidatePath\)/g) ?? []).length, 2);
  assert.match(bootstrapBranch, /before_bootstrap = \$profileBootstrapBeforeApiObservation/);
  assert.match(bootstrapBranch, /after_bootstrap = \$profileBootstrapApiPathObservation/);
  assert.match(bootstrapBranch, /candidate_validation -cne 'PASS'[\s\S]*?api_call -cne 'CALLED'[\s\S]*?\$profileBootstrapCandidateValidated = \$false/);
  assert.match(probe, /before_bootstrap = \[ordered\]@\{ candidate_validation = 'NOT_RUN'; api_call = 'NOT_CALLED'; api_hresult = \$null; candidate_matched = \$null \}/);
  assert.match(probe, /after_bootstrap = \[ordered\]@\{ candidate_validation = 'NOT_RUN'; api_call = 'NOT_CALLED'; api_hresult = \$null; candidate_matched = \$null \}/);
  assert.match(probe, /syntheticApiValidationError[\s\S]*?api_call -cne 'NOT_CALLED'[\s\S]*?syntheticProfileApiCalls -ne 0/);
  assert.match(probe, /syntheticApiMissing[\s\S]*?0x80070002[\s\S]*?syntheticApiMatch[\s\S]*?0x00000000/);
  assert.doesNotMatch(bootstrapBranch, /GetProfilePath\(|Set-ProbeAcl|SetAccessControl|New-ProbeCanary|probeListener|RunNode\(/);
  assert.match(profileTrust, /OpenProcessToken\(current\.Handle, TOKEN_QUERY/);
  assert.match(profileTrust, /GetTokenInformation\(token, TokenIsAppContainer/);
  assert.match(profileTrust, /Marshal\.ReadInt32\(value\) == 0/);
  assert.match(sidCheck, /DeriveAppContainerSidFromAppContainerName\(profileName, out derivedSid\)/);
  assert.match(sidCheck, /EqualSid\(actualSid, derivedSid\)/);
  assert.match(apiObserve, /GetAppContainerFolderPath\(profileSid, out path\)/);
  assert.match(apiObserve, /CandidateMatched = String\.Equals/);
  assert.doesNotMatch(apiObserve, /CreateDirectory|SetAccessControl|Set-ProbeAcl/);
  assert.match(script, /MAX_INPUT=64,MAX_OUTPUT=2048/);
  assert.match(script, /exactKeys\(request,\['nonce'\]\)/);
  assert.match(script, /process\.env\.LOCALAPPDATA/);
  assert.match(script, /parent_matches_nonce_name:localIsString&&parent===name/);
  assert.match(script, /fs\.mkdir\(local,\{recursive:true\}\)/);
  assert.match(script, /fs\.mkdir\(temp\)/);
  assert.match(script, /fs\.open\(marker,'wx'\)/);
  assert.match(script, /fs\.readFile\(marker,'utf8'\)/);
  assert.match(script, /fs\.unlink\(marker\)/);
  assert.doesNotMatch(script, /worker\.mjs|probe-contract\.mjs|candidate|oracle|child_process|node:net|import\s*\(|eval\s*\(|console\.|JSON\.stringify\(error|error\.message|error\.stack/);
  assert.match(script, /Buffer\.byteLength\(output,'utf8'\)\+1>MAX_OUTPUT/);
  assert.match(buildEnvironment, /if \(createProfileDirectories\)/);
  assert.match(bootstrapCleanup, /marker_created_by_diagnostic/);
  assert.match(bootstrapCleanup, /ReadAllText\(\$markerCanonical\)/);
  assert.match(bootstrapCleanup, /Directory\]::GetFileSystemEntries\(\$tempCanonical\)\.Length -ne 0/);
  assert.match(bootstrapCleanup, /Directory\]::Delete\(\$tempCanonical, \$false\)/);
  assert.doesNotMatch(bootstrapCleanup, /Remove-SafeTree|Delete\(.*true\)/);
  assert.match(probe, /function Get-ProfileBootstrapStagingAclCleanupStatus[\s\S]*?NOT_CONFIRMED[\s\S]*?REMOVED_WITH_STAGE/);
  assert.match(probe, /profileBootstrapStagingAclCleanupStatus = Get-ProfileBootstrapStagingAclCleanupStatus/);
  assert.match(probe, /staging_acl\.cleanup_status = `\s*\$profileBootstrapStagingAclCleanupStatus/);
  assert.match(probe, /Get-ProfileBootstrapDeleteDecision/);
  assert.match(documentation, /-ProfileBootstrapDiagnosticOnly/);
  assert.match(documentation, /GetAppContainerFolderPath[\s\S]*?candidate match[\s\S]*?FILE_NOT_FOUND/u);
  assert.match(documentation, /no API-path precondition[\s\S]*?empty `Temp`/u);
  assert.match(documentation, /App SID `Traverse`[\s\S]*?`stageRoot`[\s\S]*?`ReadAndExecute`[\s\S]*?`toolsRoot`[\s\S]*?staged files/u);
  assert.match(documentation, /applies only to `-ProfileBootstrapDiagnosticOnly`; the full probe stages inside\s+the new profile's `Temp` and does not change ACLs on the repository or staging\s+ancestors/u);
  assert.match(documentation, /ACL\s+cleanup is `REMOVED_WITH_STAGE` only when that\s+nonce staging tree is confirmed absent[\s\S]*?`NOT_CONFIRMED`/u);
});

test('staged diagnostic maps only normalized exact local import paths to fixed labels', async () => {
  const source = await readFile(path.resolve(ISOLATION_DIRECTORY, 'AppContainerLauncher.cs'), 'utf8');
  const constantStart = source.indexOf('private const string STAGED_FILE_READ_DIAGNOSTIC_SCRIPT =');
  const constantEnd = source.indexOf('private sealed class InputWriteState', constantStart);
  assert.ok(constantStart !== -1 && constantEnd > constantStart);
  const fragments = source.slice(constantStart, constantEnd).split(/\r?\n/).slice(1)
    .map(line => line.trim())
    .filter(line => line.startsWith('"'))
    .map(line => {
      const match = line.match(/^("(?:\\.|[^"\\])*")\s*\+?;?$/u);
      assert.ok(match, `could not decode C# script literal: ${line.slice(0, 48)}`);
      return JSON.parse(match[1]);
    });
  const script = fragments.join('');
  const helperStart = script.indexOf('function normalizeLocalPath(');
  const helperEnd = script.indexOf('function importFailure(', helperStart);
  assert.ok(helperStart !== -1 && helperEnd > helperStart);
  const helperSource = script.slice(helperStart, helperEnd) +
    '\n;globalThis.normalizeLocalPathForTest=normalizeLocalPath;globalThis.mapImportPathForTest=mapImportPath;';
  const context = { path: { win32: path.win32 }, URL, MAX_ANCESTORS: 32 };
  runInNewContext(helperSource, context, { timeout: 1000 });

  const worker = String.raw`C:\Stage\tools\worker.mjs`;
  const contract = String.raw`C:\Stage\tools\probe-contract.mjs`;
  const ancestorPaths = [String.raw`C:\Stage`, String.raw`C:\Stage\tools`];
  assert.equal(context.mapImportPathForTest(String.raw`c:/stage/tools/WORKER.mjs`, worker, contract), 'workerModule');
  assert.equal(context.mapImportPathForTest('file:///C:/stage/tools/probe-contract.mjs', worker, contract), 'probeContract');
  assert.equal(context.mapImportPathForTest(String.raw`\\?\C:\stage\tools\worker.mjs`, worker, contract), 'workerModule');
  assert.equal(context.mapImportPathForTest(String.raw`c:/STAGE`, worker, contract, ancestorPaths), 'ancestor00');
  assert.equal(context.mapImportPathForTest('file:///C:/stage/tools', worker, contract, ancestorPaths), 'ancestor01');
  assert.equal(context.mapImportPathForTest(String.raw`\\?\C:\stage\tools`, worker, contract, ancestorPaths), 'ancestor01');
  assert.equal(context.mapImportPathForTest(String.raw`\\server\share\worker.mjs`, worker, contract), null);
  assert.equal(context.mapImportPathForTest('file://server/share/worker.mjs', worker, contract), null);
  assert.equal(context.mapImportPathForTest(String.raw`\\.\C:\Stage\tools\worker.mjs`, worker, contract), null);
  assert.equal(context.mapImportPathForTest(String.raw`\\?\UNC\server\share\worker.mjs`, worker, contract), null);
  assert.equal(context.mapImportPathForTest('tools/worker.mjs', worker, contract), null);
  assert.equal(context.mapImportPathForTest(String.raw`C:\Stage\tools\worker.mjs.bak`, worker, contract), null);
  assert.equal(context.mapImportPathForTest(String.raw`C:\Stage\tools\worker.mjs-copy`, worker, contract), null);
  assert.equal(context.mapImportPathForTest(String.raw`prefixC:\Stage\tools`, worker, contract, ancestorPaths), null);
  assert.equal(context.mapImportPathForTest(String.raw`C:\Stage\tools.bak`, worker, contract, ancestorPaths), null);
  assert.equal(context.mapImportPathForTest(worker, worker, worker), null);
  assert.equal(context.mapImportPathForTest(worker, worker, contract, [worker]), null);
  const privatePath = String.raw`C:\private\secret-module.mjs`;
  const unmapped = context.mapImportPathForTest(privatePath, worker, contract);
  assert.equal(unmapped, null);
  assert.doesNotMatch(JSON.stringify(unmapped), /private|secret/u);

  const importHelpersStart = script.indexOf('const CODES=new Set(');
  const importHelpersEnd = script.indexOf('function buildAncestorPaths(', importHelpersStart);
  assert.ok(importHelpersStart !== -1 && importHelpersEnd > importHelpersStart);
  const importContext = { path: { win32: path.win32 }, URL, MAX_ANCESTORS: 32 };
  runInNewContext(script.slice(importHelpersStart, importHelpersEnd) +
    '\n;globalThis.importFailureForTest=importFailure;', importContext, { timeout: 1000 });
  const allowedFailure = importContext.importFailureForTest({ code: 'EACCES', syscall: 'open', path: worker }, worker, contract);
  assert.equal(allowedFailure.operation, 'import');
  assert.equal(allowedFailure.status, 'DENIED');
  assert.equal(allowedFailure.syscall, 'open');
  assert.equal(allowedFailure.path_label, 'workerModule');
  assert.deepEqual(Object.keys(allowedFailure).sort(), ['error_code', 'operation', 'path_label', 'status', 'syscall']);
  const ancestorFailure = importContext.importFailureForTest({ code: 'ENOENT', syscall: 'realpath', path: 'file:///C:/stage/tools' }, worker, contract, ancestorPaths);
  assert.equal(ancestorFailure.path_label, 'ancestor01');
  const rejectedFailure = importContext.importFailureForTest({
    code: 'EACCES', syscall: 'spawn', path: String.raw`C:\private\secret-module.mjs`,
    message: 'private diagnostic', stack: 'private stack',
  }, worker, contract);
  assert.equal(rejectedFailure.syscall, null);
  assert.equal(rejectedFailure.path_label, null);
  assert.doesNotMatch(JSON.stringify(rejectedFailure), /private|secret|spawn/u);
});

test('worker accepts a maximum-size JSON body plus only the launcher newline', () => {
  const baseRequest = createWorkerRequest({
    taskId: 'P01',
    calls: [{ operationId: 'call', args: [''] }],
    requestId: 'r',
  });
  const baseJson = JSON.stringify(baseRequest);
  const paddingLength = MAX_REQUEST_BYTES - Buffer.byteLength(baseJson, 'utf8');
  const exactRequest = createWorkerRequest({
    taskId: 'P01',
    calls: [{ operationId: 'call', args: ['x'.repeat(paddingLength)] }],
    requestId: 'r',
  });
  const exactJson = JSON.stringify(exactRequest);

  assert.equal(Buffer.byteLength(exactJson, 'utf8'), MAX_REQUEST_BYTES);
  assert.equal(parseWorkerStdin(Buffer.from(`${exactJson}\n`, 'utf8')).requestId, 'r');
  assert.equal(parseWorkerStdin(Buffer.from(exactJson, 'utf8')).requestId, 'r');
  assert.throws(() => parseWorkerStdin(Buffer.from(`${exactJson}\n\n`, 'utf8')));
  assert.throws(() => parseWorkerStdin(Buffer.from(`${exactJson}\ntrailing`, 'utf8')));
});
