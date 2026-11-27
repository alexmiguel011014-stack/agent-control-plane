import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CliApplication, CliStartup } from './agentctl.ts';
import { parseCliArgs, runCli } from './agentctl.ts';
import type { TaskEnvelopeV1 } from '../../domain/task.ts';
import type { TaskStatus } from '../../application/task-services.ts';
import { ApplicationServiceError } from '../../application/errors.ts';

const envelope: TaskEnvelopeV1 = Object.freeze({
  schemaVersion: 1,
  taskId: 'task-001',
  prompt: 'Never echo this prompt in CLI output.',
  requestedOperations: Object.freeze(['read'] as const),
  allowedPaths: Object.freeze(['src/**/*.ts']),
  declaredTests: Object.freeze([]),
  baseSnapshotSha256: 'a'.repeat(64),
});

function status(state: TaskStatus['state'] = 'DRAFT'): TaskStatus {
  return Object.freeze({
    taskId: envelope.taskId,
    envelopeSha256: 'b'.repeat(64),
    state,
    version: 1,
    lastEventId: 'event-1',
  });
}

function fakeApplication(startup: CliStartup = { state: 'ready' }) {
  const calls = {
    validate: 0, create: 0, classify: 0, status: 0, events: 0, approve: 0,
    run: 0, cancel: 0, recover: 0, recoverAfterRestart: 0, snapshot: 0,
    runtimeDiagnose: 0, runtimeSmoke: 0,
  };
  const app = {
    startup,
    tasks: {
      validateTask: () => { calls.validate += 1; return { valid: true as const, envelope }; },
      createTask: async () => { calls.create += 1; return status('DRAFT'); },
      classifyTask: async () => { calls.classify += 1; return status('WAITING_APPROVAL'); },
      approveTask: async () => { calls.approve += 1; return status('QUEUED'); },
      queueTask: async () => status('QUEUED'),
      runTask: async () => { calls.run += 1; return status('SUCCEEDED'); },
      cancelTask: async () => { calls.cancel += 1; return { status: status('INTERRUPTED'), outcome: 'stop_unconfirmed' as const }; },
      recoverTask: async (_taskId: string, mode: 'inspect' | 'resume') => { calls.recover += 1; return status(mode === 'inspect' ? 'INTERRUPTED' : 'QUEUED'); },
      recoverAfterRestart: async () => { calls.recoverAfterRestart += 1; return []; },
      getTaskStatus: async () => { calls.status += 1; return status('WAITING_APPROVAL'); },
      getTaskEvents: async () => { calls.events += 1; return []; },
    },
    snapshots: {
      createSnapshot: async () => {
        calls.snapshot += 1;
        return { snapshotSha256: 'c'.repeat(64), fileCount: 4, totalBytes: 100, excludedPaths: ['.git'], reused: false };
      },
    },
    runtime: {
      diagnose: async () => {
        calls.runtimeDiagnose += 1;
        return { status: 'ready', runtimeVersion: '0.12.0', modelTag: 'qwen2.5-coder:1.5b', modelDigest: `sha256:${'a'.repeat(64)}` };
      },
      smoke: async (modelTag: string) => {
        calls.runtimeSmoke += 1;
        return {
          status: 'passed', runtimeVersion: '0.12.0', modelTag, modelDigest: `sha256:${'a'.repeat(64)}`,
          output: { schemaVersion: 1, ready: true, summary: 'local-smoke-ok' },
        };
      },
    },
  } as unknown as CliApplication;
  return { app, calls };
}

function jsonOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

test('parses every version 1 command family with its exact required options', () => {
  const commands = [
    ['snapshot', 'create', '--source', 'copy', '--confirm-disposable'],
    ['task', 'validate', '--file', 'task.json'],
    ['task', 'create', '--file', 'task.json'],
    ['task', 'status', '--task-id', 'task-001'],
    ['task', 'events', '--task-id', 'task-001', '--after', 'event-1'],
    ['task', 'approve', '--task-id', 'task-001', '--envelope-sha256', 'b'.repeat(64), '--operation', 'read', '--operation', 'write', '--expires-at', '2099-01-01T00:00:00Z', '--confirm'],
    ['task', 'run', '--task-id', 'task-001', '--envelope-sha256', 'b'.repeat(64)],
    ['task', 'cancel', '--task-id', 'task-001'],
    ['task', 'recover', '--task-id', 'task-001', '--mode', 'resume-read-only'],
    ['benchmark', 'list'],
    ['benchmark', 'run', '--suite', 'smoke', '--task-id', 'task-001', '--repetitions', '3', '--approve-review-set-sha256', 'd'.repeat(64)],
    ['benchmark', 'report', '--run-id', 'run-001'],
    ['runtime', 'diagnose'],
    ['runtime', 'smoke', '--model', 'qwen2.5-coder:1.5b'],
    ['comparison', 'export', '--task-id', 'task-001', '--output', 'package.json'],
    ['comparison', 'import', '--package', 'package.json', '--patch', 'patch.diff', '--log', 'run.log'],
  ];
  for (const args of commands) assert.equal(parseCliArgs(args).ok, true, args.join(' '));
});

test('rejects unknown, missing, duplicate, malformed, and wrongly repeated options', () => {
  const invalidCommands = [
    ['task', 'status', '--task-id', 'task-001', '--nope'],
    ['task', 'status', '--task-id'],
    ['task', 'status', '--task-id', 'task-001', '--task-id', 'task-002'],
    ['task', 'status', '--task-id', 'TASK-001'],
    ['task', 'approve', '--task-id', 'task-001', '--envelope-sha256', 'b'.repeat(64), '--operation', 'read', '--expires-at', '2099-01-01T00:00:00Z'],
    ['task', 'approve', '--task-id', 'task-001', '--envelope-sha256', 'b'.repeat(64), '--operation', 'read', '--operation', 'read', '--expires-at', '2099-01-01T00:00:00Z', '--confirm'],
    ['task', 'approve', '--task-id', 'task-001', '--envelope-sha256', 'b'.repeat(64), '--operation', 'shell', '--expires-at', '2099-01-01T00:00:00Z', '--confirm'],
    ['task', 'recover', '--task-id', 'task-001', '--mode', 'resume'],
    ['task', 'status', '--task-id', 'task-001', '--json', '--after', 'event-1'],
    ['task', 'status', '--task-id', 'task-001', '--task-id', 'task-002', '--json'],
    ['task', 'status', '--task-id', 'task-001', '--json', '--json'],
    ['--version', '--json'],
  ];
  for (const args of invalidCommands) assert.equal(parseCliArgs(args).ok, false, args.join(' '));
});

test('invalid commands and version never initialize application services', async () => {
  let initialized = 0;
  const factory = async () => { initialized += 1; return fakeApplication().app; };
  const invalid = await runCli(['task', 'status', '--task-id', 'BAD'], factory);
  assert.equal(invalid.exitCode, 2);
  assert.equal(initialized, 0);
  const version = await runCli(['--version'], factory);
  assert.equal(version.stdout, 'agentctl 0.1.0 (contract v1)\n');
  assert.equal(initialized, 0);
});

test('JSON task creation validates, creates, classifies, and never echoes the prompt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-cli-task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskFile = join(root, 'task.json');
  await writeFile(taskFile, JSON.stringify(envelope), 'utf8');
  const { app, calls } = fakeApplication();
  const result = await runCli(['task', 'create', '--file', taskFile, '--json'], async () => app);
  assert.equal(result.exitCode, 0);
  const output = jsonOutput(result.stdout);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.ok, true);
  assert.equal(output.command, 'task.create');
  assert.equal((output.data as Record<string, unknown>).state, 'WAITING_APPROVAL');
  assert.equal(result.stdout.includes(envelope.prompt), false);
  assert.deepEqual(calls, {
    validate: 0, create: 1, classify: 1, status: 0, events: 0, approve: 0,
    run: 0, cancel: 0, recover: 0, recoverAfterRestart: 0, snapshot: 0,
    runtimeDiagnose: 0, runtimeSmoke: 0,
  });
});

test('malformed task JSON and invalid envelope schemas fail before startup composition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-cli-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const malformedFile = join(root, 'malformed.json');
  const invalidSchemaFile = join(root, 'invalid-schema.json');
  await writeFile(malformedFile, '{not-json', 'utf8');
  await writeFile(invalidSchemaFile, JSON.stringify({ ...envelope, unexpected: true }), 'utf8');
  let initialized = 0;
  const factory = async () => { initialized += 1; return fakeApplication().app; };

  for (const [command, file, expectedCode] of [
    ['create', malformedFile, 'invalid_json'],
    ['validate', invalidSchemaFile, 'invalid_task'],
  ] as const) {
    const result = await runCli(['task', command, '--file', file, '--json'], factory);
    assert.equal(result.exitCode, 2);
    assert.equal((jsonOutput(result.stdout).error as Record<string, unknown>).code, expectedCode);
  }
  assert.equal(initialized, 0);
});

test('task validate exposes only validity and task ID', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-cli-validate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskFile = join(root, 'task.json');
  await writeFile(taskFile, JSON.stringify(envelope), 'utf8');
  const { app, calls } = fakeApplication();
  const result = await runCli(['task', 'validate', '--file', taskFile, '--json'], async () => app);
  const output = jsonOutput(result.stdout);
  assert.deepEqual(output.data, { valid: true, taskId: envelope.taskId });
  assert.equal(result.stdout.includes(envelope.prompt), false);
  assert.equal(calls.validate, 1);
  assert.equal(calls.create, 0);
});

test('snapshot output contains only the hash, counts, and relative exclusions', async () => {
  const { app, calls } = fakeApplication();
  const result = await runCli(['snapshot', 'create', '--source', 'C:\\private\\copy', '--confirm-disposable', '--json'], async () => app);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes('C:\\private\\copy'), false);
  assert.equal(calls.snapshot, 1);
  assert.deepEqual(jsonOutput(result.stdout).data, {
    snapshotSha256: 'c'.repeat(64), fileCount: 4, totalBytes: 100, excludedPaths: ['.git'], reused: false,
    streamLimitation: 'NTFS alternate data streams are not enumerated; snapshot v1 copies and hashes only unnamed/default streams.',
  });
});

test('startup lease busy keeps read-only queries available but blocks mutations and model inference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-cli-busy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const startup: CliStartup = { state: 'lease_busy', lockConflict: { lockPath: join(root, 'task-execution.lock'), owner: { pid: 321, kind: 'run' } } };
  const { app, calls } = fakeApplication(startup);
  for (const argv of [
    ['task', 'status', '--task-id', 'task-001'],
    ['task', 'events', '--task-id', 'task-001'],
    ['task', 'recover', '--task-id', 'task-001', '--mode', 'inspect'],
    ['task', 'cancel', '--task-id', 'task-001'],
    ['runtime', 'diagnose'],
  ]) assert.equal((await runCli(argv, async () => app)).exitCode, argv[1] === 'cancel' ? 6 : 0, argv.join(' '));
  assert.equal(calls.status, 1);
  assert.equal(calls.events, 1);
  assert.equal(calls.recover, 1);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.runtimeDiagnose, 1);

  for (const argv of [
    ['snapshot', 'create', '--source', 'copy', '--confirm-disposable', '--json'],
    ['task', 'approve', '--task-id', 'task-001', '--envelope-sha256', 'b'.repeat(64), '--operation', 'read', '--expires-at', '2099-01-01T00:00:00Z', '--confirm', '--json'],
    ['task', 'recover', '--task-id', 'task-001', '--mode', 'resume-read-only', '--json'],
    ['task', 'run', '--task-id', 'task-001', '--envelope-sha256', 'b'.repeat(64), '--json'],
    ['runtime', 'smoke', '--model', 'qwen2.5-coder:1.5b', '--json'],
  ]) {
    const result = await runCli(argv, async () => app);
    assert.equal(result.exitCode, 8);
    const error = jsonOutput(result.stdout).error as Record<string, unknown>;
    assert.equal(error.code, 'execution_lock_busy');
    assert.match(String(error.message), /PID 321/);
    assert.match(String(error.message), /remova manualmente somente esse arquivo/);
  }
  assert.equal(calls.approve, 0);
  assert.equal(calls.run, 0);
  assert.equal(calls.snapshot, 0);
  assert.equal(calls.runtimeSmoke, 0);
});

test('startup lock does not mask read errors and unknown-owner guidance does not invent a PID', async () => {
  const startup: CliStartup = { state: 'lease_busy', lockConflict: { lockPath: 'C:\\runtime\\task-execution.lock' } };
  const { app } = fakeApplication(startup);
  const missingTaskApp = {
    ...app,
    tasks: {
      ...app.tasks,
      getTaskStatus: async () => { throw new ApplicationServiceError('TASK_NOT_FOUND'); },
    },
  } as unknown as CliApplication;
  const missing = await runCli(['task', 'status', '--task-id', 'task-001', '--json'], async () => missingTaskApp);
  assert.equal(missing.exitCode, 2);
  assert.equal((jsonOutput(missing.stdout).error as Record<string, unknown>).code, 'task_not_found');

  const blocked = await runCli(['task', 'approve', '--task-id', 'task-001', '--envelope-sha256', 'b'.repeat(64), '--operation', 'read', '--expires-at', '2099-01-01T00:00:00Z', '--confirm', '--json'], async () => app);
  const message = String((jsonOutput(blocked.stdout).error as Record<string, unknown>).message);
  assert.equal(blocked.exitCode, 8);
  assert.match(message, /dono desconhecido/);
  assert.match(message, /Confirme manualmente que nenhuma instância/);
  assert.doesNotMatch(message, /Verifique se o PID/);
});

test('production task run stays gated and deferred services have a stable unavailable response', async () => {
  const { app, calls } = fakeApplication();
  let initialized = 0;
  const run = await runCli(['task', 'run', '--task-id', 'task-001', '--envelope-sha256', 'b'.repeat(64), '--json'], async () => { initialized += 1; return app; });
  assert.equal(run.exitCode, 8);
  assert.equal((jsonOutput(run.stdout).error as Record<string, unknown>).code, 'safety_gate_closed');
  assert.equal(initialized, 1);
  assert.equal(calls.run, 0);

  // An application without benchmark services answers the benchmark commands as unavailable.
  const unavailable = await runCli(['benchmark', 'list', '--json'], async () => { initialized += 1; return app; });
  assert.equal(unavailable.exitCode, 8);
  assert.equal((jsonOutput(unavailable.stdout).error as Record<string, unknown>).code, 'capability_unavailable');
  assert.equal(initialized, 2);

  for (const argv of [
    ['comparison', 'export', '--task-id', 'task-001', '--output', 'package.json', '--json'],
    ['comparison', 'import', '--package', 'package.json', '--patch', 'patch.diff', '--log', 'run.log', '--json'],
  ]) {
    const comparison = await runCli(argv, async () => { initialized += 1; return app; });
    assert.equal(comparison.exitCode, 8);
    assert.equal((jsonOutput(comparison.stdout).error as Record<string, unknown>).code, 'capability_unavailable');
  }
  assert.equal(initialized, 4);
});

test('comparison commands map service errors to fixed results and pass uppercase task ids', async () => {
  const { ComparisonServiceError } = await import('../../application/comparison-services.ts');
  const seen: unknown[] = [];
  const comparison = {
    exportPackage: async (request: unknown) => { seen.push(request); return { taskId: 'B02', outputPath: 'p.json', packageSha256: HASH }; },
    importArtifacts: async () => { throw new ComparisonServiceError('secret_detected'); },
  };
  const app = { ...fakeApplication().app, comparison } as unknown as CliApplication;
  const exported = await runCli(['comparison', 'export', '--task-id', 'b02', '--output', 'p.json', '--json'], async () => app);
  assert.equal(exported.exitCode, 0);
  assert.deepEqual(seen, [{ taskId: 'B02', outputPath: 'p.json' }]);
  const imported = await runCli(['comparison', 'import', '--package', 'p.json', '--patch', 'x.diff', '--log', 'x.log', '--json'], async () => app);
  assert.equal(imported.exitCode, 3);
  assert.equal((jsonOutput(imported.stdout).error as Record<string, unknown>).code, 'comparison_secret_detected');
});

const HASH = 'e'.repeat(64);

function benchmarkApplication(startup: CliStartup = { state: 'ready' }) {
  const base = fakeApplication(startup);
  const calls = { list: 0, run: [] as unknown[], report: [] as string[] };
  let failure: unknown;
  const benchmark = {
    list: async () => {
      calls.list += 1;
      if (failure) throw failure;
      return [{ suiteId: 'g0', taskIds: ['B01', 'I02'], extra: 'C:\\private\\never-shown' }];
    },
    run: async (request: unknown) => {
      calls.run.push(request);
      if (failure) throw failure;
      return {
        runId: 'run-001',
        suiteId: 'g0',
        attempts: [
          { attemptTaskId: 'b01-run-001-1', benchmarkTaskId: 'B01', attempt: 1, status: 'PASS' },
          { attemptTaskId: 'b01-run-001-2', benchmarkTaskId: 'B01', attempt: 2, status: 'FAIL' },
          { attemptTaskId: 'i02-run-001-1', benchmarkTaskId: 'I02', attempt: 1, status: 'PASS' },
        ],
      };
    },
    report: async (runId: string) => {
      calls.report.push(runId);
      if (failure) throw failure;
      const counts = { attempts: 2, resolved_hidden: 1, public_pass: 2, policy_clean: 2, timeout: 0, runner_failure: 0 };
      return { runId, totals: counts, tasks: { b01: counts } };
    },
  };
  const app = { ...base.app, benchmark } as CliApplication;
  return { app, calls, base: base.calls, fail: (error: unknown) => { failure = error; } };
}

class BenchmarkServiceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'BenchmarkServiceError';
    this.code = code;
  }
}

test('benchmark run requires a well-formed review-set approval hash and creates nothing without it', async () => {
  const base = ['benchmark', 'run', '--suite', 'g0'];
  for (const args of [
    base,
    [...base, '--approve-review-set-sha256'],
    [...base, '--approve-review-set-sha256', 'E'.repeat(64)],
    [...base, '--approve-review-set-sha256', 'e'.repeat(63)],
    [...base, '--approve-review-set-sha256', `${'e'.repeat(63)}g`],
    [...base, '--approve-review-set-sha256', HASH, '--approve-review-set-sha256', HASH],
    [...base, '--approve-review-set-sha256', HASH, '--model', 'bad model;rm'],
    [...base, '--approve-review-set-sha256', HASH, '--answer-format', 'xml'],
  ]) assert.equal(parseCliArgs(args).ok, false, args.join(' '));
  const parsed = parseCliArgs([...base, '--approve-review-set-sha256', HASH]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.command.kind === 'benchmark.run' && parsed.command.approvedReviewSetSha256, HASH);

  let initialized = 0;
  const { app, calls } = benchmarkApplication();
  const factory = async () => { initialized += 1; return app; };
  for (const args of [[...base, '--json'], [...base, '--approve-review-set-sha256', 'x'.repeat(64), '--json']]) {
    const result = await runCli(args, factory);
    assert.equal(result.exitCode, 2);
    assert.equal((jsonOutput(result.stdout).error as Record<string, unknown>).code, 'invalid_command');
  }
  assert.equal(initialized, 0);
  assert.equal(calls.run.length, 0);
});

test('benchmark run passes the hash and options through and prints a short summary', async () => {
  const { app, calls, base } = benchmarkApplication();
  const json = await runCli(['benchmark', 'run', '--suite', 'g0', '--task-id', 'b01', '--repetitions', '2', '--approve-review-set-sha256', HASH, '--json'], async () => app);
  assert.equal(json.exitCode, 0);
  assert.deepEqual(calls.run, [{ suiteId: 'g0', taskId: 'B01', repetitions: 2, approvedReviewSetSha256: HASH }]);
  const output = jsonOutput(json.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, 'benchmark.run');
  assert.deepEqual(output.data, {
    runId: 'run-001', suiteId: 'g0', attempts: 3, statusCounts: { FAIL: 1, PASS: 2 }, resultDirectory: 'bench/results/local/run-001/',
  });
  assert.equal(base.create, 0);

  const human = await runCli(['benchmark', 'run', '--suite', 'g0', '--approve-review-set-sha256', HASH], async () => app);
  assert.equal(human.exitCode, 0);
  assert.deepEqual(calls.run[1], { suiteId: 'g0', repetitions: 1, approvedReviewSetSha256: HASH });
  assert.equal(human.stdout, 'benchmark.run: execução run-001; 3 tentativa(s); FAIL=1, PASS=2; resultados em bench/results/local/run-001/\n');
});

test('benchmark run is refused while the startup lease is busy', async () => {
  const startup: CliStartup = { state: 'lease_busy', lockConflict: { lockPath: 'C:\\runtime\\task-execution.lock', owner: { pid: 321, kind: 'run' } } };
  const { app, calls } = benchmarkApplication(startup);
  const result = await runCli(['benchmark', 'run', '--suite', 'g0', '--approve-review-set-sha256', HASH, '--json'], async () => app);
  assert.equal(result.exitCode, 8);
  assert.equal((jsonOutput(result.stdout).error as Record<string, unknown>).code, 'execution_lock_busy');
  assert.equal(calls.run.length, 0);

  // Read-only benchmark commands stay available while the lease is busy.
  assert.equal((await runCli(['benchmark', 'list'], async () => app)).exitCode, 0);
  assert.equal((await runCli(['benchmark', 'report', '--run-id', 'run-001'], async () => app)).exitCode, 0);
});

test('benchmark list and report route through the benchmark service and project only known fields', async () => {
  const { app, calls } = benchmarkApplication();
  const list = await runCli(['benchmark', 'list', '--json'], async () => app);
  assert.equal(list.exitCode, 0);
  assert.deepEqual(jsonOutput(list.stdout).data, [{ suiteId: 'g0', taskIds: ['B01', 'I02'] }]);
  assert.equal(list.stdout.includes('private'), false);
  assert.equal(calls.list, 1);
  const listHuman = await runCli(['benchmark', 'list'], async () => app);
  assert.equal(listHuman.stdout, 'benchmark.list: 1 suíte(s): g0 (2 tarefa(s))\n');

  const report = await runCli(['benchmark', 'report', '--run-id', 'run-001', '--json'], async () => app);
  assert.equal(report.exitCode, 0);
  const counts = { attempts: 2, resolved_hidden: 1, public_pass: 2, policy_clean: 2, timeout: 0, runner_failure: 0 };
  assert.deepEqual(jsonOutput(report.stdout).data, {
    runId: 'run-001', totals: counts, tasks: { b01: counts }, resultDirectory: 'bench/results/local/run-001/',
  });
  assert.deepEqual(calls.report, ['run-001']);
  const reportHuman = await runCli(['benchmark', 'report', '--run-id', 'run-001'], async () => app);
  assert.equal(reportHuman.stdout,
    'benchmark.report: execução run-001; 2 tentativa(s); resolved_hidden=1, public_pass=2, policy_clean=2, timeout=0, runner_failure=0; resultados em bench/results/local/run-001/\n');
});

test('an application without benchmark services answers every benchmark command as unavailable', async () => {
  const { app } = fakeApplication();
  for (const argv of [
    ['benchmark', 'list', '--json'],
    ['benchmark', 'report', '--run-id', 'run-001', '--json'],
    ['benchmark', 'run', '--suite', 'g0', '--approve-review-set-sha256', HASH, '--json'],
  ]) {
    const result = await runCli(argv, async () => app);
    assert.equal(result.exitCode, 8, argv.join(' '));
    assert.equal((jsonOutput(result.stdout).error as Record<string, unknown>).code, 'capability_unavailable');
  }
});

test('benchmark service error codes map to fixed results without error text', async () => {
  const expected: Record<string, [string, number]> = {
    approval_hash_invalid: ['invalid_input', 2],
    invalid_run_id: ['invalid_input', 2],
    invalid_repetitions: ['invalid_input', 2],
    unknown_suite: ['benchmark_suite_not_found', 2],
    unknown_task: ['benchmark_task_not_found', 2],
    unsupported_envelope: ['benchmark_task_unsupported', 3],
    catalog_unavailable: ['catalog_unavailable', 5],
    result_invalid: ['result_invalid', 5],
    result_sink_failed: ['result_unavailable', 5],
  };
  for (const [serviceCode, [cliCode, exitCode]] of Object.entries(expected)) {
    const { app, fail } = benchmarkApplication();
    fail(new BenchmarkServiceError(serviceCode));
    const result = await runCli(['benchmark', 'run', '--suite', 'g0', '--approve-review-set-sha256', HASH, '--json'], async () => app);
    assert.equal(result.exitCode, exitCode, serviceCode);
    const error = jsonOutput(result.stdout).error as Record<string, unknown>;
    assert.equal(error.code, cliCode, serviceCode);
    assert.equal(String(error.message).includes(serviceCode), false);
  }

  const { app, fail } = benchmarkApplication();
  const leaky = new Error('C:\\private\\path model output');
  fail(leaky);
  const human = await runCli(['benchmark', 'report', '--run-id', 'run-001'], async () => app);
  assert.equal(human.exitCode, 70);
  assert.equal(human.stderr, 'internal_error: Falha interna; detalhes foram omitidos.\n');
  assert.equal(human.stderr.includes('private'), false);

  fail(Object.assign(new BenchmarkServiceError('not_a_known_code'), { stack: 'secret stack' }));
  const unknown = await runCli(['benchmark', 'list', '--json'], async () => app);
  assert.equal(unknown.exitCode, 70);
  assert.equal(unknown.stdout.includes('secret'), false);
});

test('runtime diagnostics and the read-only smoke route through application services', async () => {
  const { app, calls } = fakeApplication();
  const diagnose = await runCli(['runtime', 'diagnose', '--json'], async () => app);
  assert.equal(diagnose.exitCode, 0);
  assert.equal((jsonOutput(diagnose.stdout).data as Record<string, unknown>).status, 'ready');
  assert.equal(calls.runtimeDiagnose, 1);

  const smoke = await runCli(['runtime', 'smoke', '--model', 'qwen2.5-coder:1.5b', '--json'], async () => app);
  assert.equal(smoke.exitCode, 0);
  const smokeData = jsonOutput(smoke.stdout).data as Record<string, unknown>;
  assert.equal(smokeData.status, 'passed');
  assert.deepEqual(smokeData.output, { schemaVersion: 1, ready: true, summary: 'local-smoke-ok' });
  assert.equal(calls.runtimeSmoke, 1);
  assert.equal(calls.run, 0);

  const modelTag = 'qwen2.5-coder:1.5b';
  const blockedApp = {
    ...app,
    runtime: {
      diagnose: async () => ({ status: 'runtime_unavailable', modelTag } as const),
      smoke: async () => ({ status: 'blocked', reasonCode: 'runtime_unavailable', modelTag } as const),
    },
  } as CliApplication;
  const unavailable = await runCli(['runtime', 'diagnose', '--json'], async () => blockedApp);
  assert.equal(unavailable.exitCode, 8);
  assert.equal((jsonOutput(unavailable.stdout).data as Record<string, unknown>).status, 'runtime_unavailable');
  const blockedSmoke = await runCli(['runtime', 'smoke', '--model', modelTag, '--json'], async () => blockedApp);
  assert.equal(blockedSmoke.exitCode, 8);
  assert.equal((jsonOutput(blockedSmoke.stdout).data as Record<string, unknown>).status, 'blocked');
});

test('watch parses its options and is unavailable in the core runner', async () => {
  const parse = (argv: string[]) => parseCliArgs(argv);
  const expected = (once: boolean, intervalSeconds: number, color: boolean) =>
    ({ ok: true, command: { kind: 'watch', once, intervalSeconds, color, format: 'human' } });
  assert.deepEqual(parse(['watch']), expected(false, 2, true));
  assert.deepEqual(parse(['watch', '--once']), expected(true, 2, true));
  assert.deepEqual(parse(['watch', '--interval', '5', '--no-color']), expected(false, 5, false));
  for (const bad of ['0', '61', 'x']) assert.equal(parse(['watch', '--interval', bad]).ok, false, bad);
  const result = await runCli(['watch'], async () => fakeApplication().app);
  assert.equal(result.exitCode, 8);
});
