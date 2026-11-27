import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

interface JsonEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: Record<string, unknown> | readonly Record<string, unknown>[];
  readonly error?: { readonly code: string; readonly message: string };
}

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const compiledCli = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/agentctl-test.js');

function parseResult(result: ProcessResult): JsonEnvelope {
  assert.notEqual(result.stdout.trim(), '', `CLI produced no JSON. stderr=${result.stderr}`);
  return JSON.parse(result.stdout) as JsonEnvelope;
}

function invokeCli(
  cwd: string,
  args: readonly string[],
  options: { readonly holdAgent?: boolean } = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [compiledCli, ...args, '--json'], {
      cwd,
      env: {
        ...process.env,
        ...(options.holdAgent ? { AGENTCTL_TEST_HOLD_AGENT: '1' } : { AGENTCTL_TEST_HOLD_AGENT: '0' }),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolveResult(Object.freeze({ code, stdout, stderr })));
  });
}

function startRun(cwd: string, taskId: string, envelopeSha256: string) {
  const child = spawn(process.execPath, [compiledCli, 'task', 'run', '--task-id', taskId, '--envelope-sha256', envelopeSha256, '--json'], {
    cwd,
    env: { ...process.env, AGENTCTL_TEST_HOLD_AGENT: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const closed = new Promise<ProcessResult>((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveResult(Object.freeze({ code, stdout, stderr })));
  });
  return Object.freeze({ child, closed });
}

function taskEnvelope(taskId: string, snapshotSha256: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId,
    prompt: 'Missão no-op: validar o ciclo de vida sem solicitar ferramentas.',
    requestedOperations: ['write'],
    allowedPaths: ['src/example.ts'],
    declaredTests: [],
    baseSnapshotSha256: snapshotSha256,
  };
}

async function createTask(cwd: string, root: string, taskId: string, snapshotSha256: string): Promise<string> {
  const file = join(root, `${taskId}.json`);
  await writeFile(file, `${JSON.stringify(taskEnvelope(taskId, snapshotSha256))}\n`, 'utf8');
  const created = parseResult(await invokeCli(cwd, ['task', 'create', '--file', file]));
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.command, 'task.create');
  const data = created.data as Record<string, unknown>;
  assert.equal(data.state, 'WAITING_APPROVAL');
  assert.equal(typeof data.envelopeSha256, 'string');
  return data.envelopeSha256 as string;
}

async function approveTask(cwd: string, taskId: string, envelopeSha256: string): Promise<void> {
  const approved = parseResult(await invokeCli(cwd, [
    'task', 'approve', '--task-id', taskId, '--envelope-sha256', envelopeSha256,
    '--operation', 'write', '--expires-at', '2099-01-01T00:00:00Z', '--confirm',
  ]));
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal((approved.data as Record<string, unknown>).state, 'QUEUED');
}

test('compiled CLI drives no-tool mission, cancellation, and restart recovery without candidate tests', async (t) => {
  const runtime = join(process.cwd(), 'runtime');
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, 'agentctl-g19-e2e-'));
  let activeRun: ReturnType<typeof startRun> | undefined;
  t.after(async () => {
    if (activeRun) {
      if (activeRun.child.exitCode === null) activeRun.child.kill('SIGTERM');
      await activeRun.closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, 'operator-cwd');
  const source = join(root, 'disposable-source');
  await mkdir(join(source, 'src'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(source, 'src', 'example.ts'), 'export const value = 1;\n', 'utf8');

  const captured = parseResult(await invokeCli(cwd, [
    'snapshot', 'create', '--source', source, '--confirm-disposable',
  ]));
  assert.equal(captured.ok, true, JSON.stringify(captured));
  const snapshotSha256 = (captured.data as Record<string, unknown>).snapshotSha256;
  assert.equal(typeof snapshotSha256, 'string');
  assert.equal((captured.data as Record<string, unknown>).snapshotSha256, snapshotSha256);

  const happyHash = await createTask(cwd, root, 'no-op-happy', snapshotSha256 as string);
  await approveTask(cwd, 'no-op-happy', happyHash);
  const completed = parseResult(await invokeCli(cwd, [
    'task', 'run', '--task-id', 'no-op-happy', '--envelope-sha256', happyHash,
  ]));
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal((completed.data as Record<string, unknown>).state, 'SUCCEEDED');
  const status = parseResult(await invokeCli(cwd, ['task', 'status', '--task-id', 'no-op-happy']));
  assert.equal((status.data as Record<string, unknown>).state, 'SUCCEEDED');
  const events = parseResult(await invokeCli(cwd, ['task', 'events', '--task-id', 'no-op-happy']));
  const eventList = events.data as readonly Record<string, unknown>[];
  assert.ok(eventList.some((event) => event.type === 'task.state_changed' && event.to === 'RUNNING'));
  assert.ok(eventList.some((event) => event.type === 'task.state_changed' && event.to === 'VERIFYING'));
  assert.ok(eventList.some((event) => event.type === 'task.state_changed' && event.to === 'SUCCEEDED'));
  assert.equal(await readFile(join(source, 'src', 'example.ts'), 'utf8'), 'export const value = 1;\n');

  await createTask(cwd, root, 'no-op-cancel', snapshotSha256 as string);
  const cancelled = parseResult(await invokeCli(cwd, ['task', 'cancel', '--task-id', 'no-op-cancel']));
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal((cancelled.data as Record<string, unknown>).outcome, 'cancelled');
  assert.equal(((cancelled.data as Record<string, unknown>).status as Record<string, unknown>).state, 'CANCELLED');

  const recoveryHash = await createTask(cwd, root, 'no-op-recover', snapshotSha256 as string);
  await approveTask(cwd, 'no-op-recover', recoveryHash);
  const cancelUnderLockHash = await createTask(cwd, root, 'no-op-cancel-lock', snapshotSha256 as string);
  activeRun = startRun(cwd, 'no-op-recover', recoveryHash);
  const markerPath = join(cwd, '.agentctl', 'test-agent-ready');
  let agentStarted = false;
  let runResult: ProcessResult | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const childOutcome = await Promise.race([
      activeRun.closed.then((result) => ({ closed: true as const, result })),
      new Promise<{ readonly closed: false }>((resolveDelay) => setTimeout(() => resolveDelay({ closed: false }), 20)),
    ]);
    if (childOutcome.closed) {
      runResult = childOutcome.result;
      break;
    }
    try {
      await readFile(markerPath, 'utf8');
      agentStarted = true;
      break;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
  assert.equal(agentStarted, true, `fake agent did not reach its post-RUNNING hold; task run process=${JSON.stringify(runResult)}`);
  const liveEvents = parseResult(await invokeCli(cwd, ['task', 'events', '--task-id', 'no-op-recover']));
  const liveEventList = liveEvents.data as readonly Record<string, unknown>[];
  assert.ok(liveEventList.some((event) => event.type === 'task.state_changed' && event.to === 'RUNNING'), `events response=${JSON.stringify(liveEvents)}`);
  const liveStatus = parseResult(await invokeCli(cwd, ['task', 'status', '--task-id', 'no-op-recover']));
  assert.equal((liveStatus.data as Record<string, unknown>).state, 'RUNNING', `status must agree with events while leased; response=${JSON.stringify(liveStatus)}`);
  assert.equal(activeRun.child.kill('SIGTERM'), true, 'only the disposable test CLI child is terminated');
  await activeRun.closed;
  activeRun = undefined;

  const lockPath = join(cwd, '.agentctl', 'task-execution.lock');
  const staleLock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number; kind: string };
  const busyStatus = parseResult(await invokeCli(cwd, ['task', 'status', '--task-id', 'no-op-recover']));
  assert.equal((busyStatus.data as Record<string, unknown>).state, 'RUNNING', `busy status response=${JSON.stringify(busyStatus)}`);
  const busyEvents = parseResult(await invokeCli(cwd, ['task', 'events', '--task-id', 'no-op-recover']));
  assert.ok((busyEvents.data as readonly Record<string, unknown>[]).length > 0);

  const cancelUnderLock = parseResult(await invokeCli(cwd, ['task', 'cancel', '--task-id', 'no-op-cancel-lock']));
  assert.equal(cancelUnderLock.ok, true, JSON.stringify(cancelUnderLock));
  assert.equal((cancelUnderLock.data as Record<string, unknown>).outcome, 'cancelled');

  for (const args of [
    ['task', 'run', '--task-id', 'no-op-recover', '--envelope-sha256', recoveryHash],
    ['task', 'recover', '--task-id', 'no-op-recover', '--mode', 'resume-read-only'],
  ]) {
    const blocked = parseResult(await invokeCli(cwd, args));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, 'execution_lock_busy');
    assert.ok(blocked.error?.message.includes(lockPath));
    assert.ok(blocked.error?.message.includes(`PID ${staleLock.pid}`));
    assert.ok(blocked.error?.message.includes('remova manualmente somente esse arquivo'));
  }

  await unlink(lockPath);
  const recovered = parseResult(await invokeCli(cwd, ['task', 'status', '--task-id', 'no-op-recover']));
  assert.equal((recovered.data as Record<string, unknown>).state, 'INTERRUPTED');
  const resume = parseResult(await invokeCli(cwd, ['task', 'recover', '--task-id', 'no-op-recover', '--mode', 'resume-read-only']));
  assert.equal((resume.data as Record<string, unknown>).state, 'WAITING_APPROVAL');
  const recoveredEvents = parseResult(await invokeCli(cwd, ['task', 'events', '--task-id', 'no-op-recover']));
  assert.ok((recoveredEvents.data as readonly Record<string, unknown>[]).some((event) =>
    event.type === 'task.state_changed' && event.to === 'INTERRUPTED' && event.reasonCode === 'process_restarted'));

  await writeFile(lockPath, '{malformed', 'utf8');
  const unknownOwner = parseResult(await invokeCli(cwd, ['task', 'recover', '--task-id', 'no-op-recover', '--mode', 'resume-read-only']));
  assert.equal(unknownOwner.error?.code, 'execution_lock_busy');
  assert.ok(unknownOwner.error?.message.includes('dono desconhecido'));
  assert.ok(unknownOwner.error?.message.includes('Confirme manualmente que nenhuma instância'));
  await unlink(lockPath);
  assert.match(cancelUnderLockHash, /^[a-f0-9]{64}$/);
});
