import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import test from 'node:test';
import {
  BenchmarkResultError,
  createLocalRunResultWriter,
  deriveLocalRunOutcome,
  validateLocalRunResult,
  type LocalRunResultV1,
} from './benchmark-result.ts';

type Mutable = Record<string, unknown>;

function validResult(overrides: Partial<Record<keyof LocalRunResultV1, unknown>> = {}): Mutable {
  return {
    schemaVersion: 1,
    runId: 'run-2026-11-10',
    taskId: 'i01',
    attempt: 1,
    suiteId: 'g0',
    startedAtUtc: '2026-11-10T12:00:00.000Z',
    model: { tag: 'qwen2.5-coder:1.5b', digest: 'a'.repeat(64), runtimeVersion: '0.12.3' },
    seed: { capable: true, value: 42 },
    outcome: deriveLocalRunOutcome('PASS', 'PASS'),
    toolCalls: {
      total: 4,
      byOperation: { read_text: 2, list_files: 1, apply_unified_diff: 1, run_declared_test: 0, git_diff: 0 },
    },
    changedFiles: 1,
    patch: { linesAdded: 3, linesRemoved: 1, sha256: 'b'.repeat(64) },
    logSha256: 'c'.repeat(64),
    policyDenials: { count: 2, reasonCodes: ['path_not_allowed'] },
    metrics: {
      wallMs: 1234.5,
      firstOutputMs: null,
      sampleCount: 1,
      cpu: { status: 'available', userMs: 10, systemMs: 2, peakPercent: 3.5 },
      ram: { status: 'available', peakRssBytes: 1_000, minSystemFreeBytes: 500, systemTotalBytes: 2_000 },
      gpu: { status: 'unavailable', reason: 'tool_missing' },
      truncated: false,
    },
    ...overrides,
  };
}

function clone(value: unknown): Mutable {
  return JSON.parse(JSON.stringify(value)) as Mutable;
}

function issuesOf(value: unknown): readonly string[] {
  const check = validateLocalRunResult(value);
  assert.equal(check.valid, false, 'expected the result to be rejected');
  return check.valid ? [] : check.issues;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const parent = join(process.cwd(), 'runtime', 'test-temp');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

test('accepts a complete valid result and returns a frozen canonical copy', () => {
  const input = validResult();
  const check = validateLocalRunResult(input);
  assert.equal(check.valid, true, check.valid ? '' : check.issues.join(', '));
  if (!check.valid) return;
  assert.deepEqual(clone(check.result), clone(input));
  assert.notEqual(check.result, input);
  assert.equal(Object.isFrozen(check.result), true);
  assert.equal(Object.isFrozen(check.result.outcome), true);
  assert.equal(Object.isFrozen(check.result.policyDenials.reasonCodes), true);
  assert.equal(Object.isFrozen(check.result.metrics.gpu), true);

  const gpu = validResult({
    seed: { capable: false, value: null },
    model: { tag: 'qwen2.5-coder:1.5b', digest: null, runtimeVersion: null },
    startedAtUtc: '2026-11-10T12:00:00Z',
    metrics: { ...(validResult().metrics as Mutable), firstOutputMs: 10, gpu: { status: 'available', peakUsedMiB: 900, totalMiB: 4096, samples: 3 } },
  });
  assert.equal(validateLocalRunResult(gpu).valid, true);
});

test('derives distinct, consistent outcome categories', () => {
  assert.deepEqual(deriveLocalRunOutcome('PASS', 'PASS'), {
    status: 'PASS', publicStatus: 'PASS', oracleStatus: 'PASS', resolvedHidden: true, publicPass: true, policyClean: true, timedOut: false, runnerFailure: false,
  });
  const publicOnly = deriveLocalRunOutcome('PASS', 'FAIL');
  assert.equal(publicOnly.publicPass, true);
  assert.equal(publicOnly.resolvedHidden, false);
  assert.equal(deriveLocalRunOutcome('POLICY_VIOLATION', null).policyClean, false);
  assert.equal(deriveLocalRunOutcome('TIMEOUT', null).timedOut, true);
  assert.equal(deriveLocalRunOutcome('PASS', null).runnerFailure, true);
  assert.equal(deriveLocalRunOutcome(null, null).runnerFailure, true);
  assert.equal(deriveLocalRunOutcome(null, 'PASS', 'PASS').status, 'RUNNER_FAILURE');
  for (const outcome of [publicOnly, deriveLocalRunOutcome('FAIL', null), deriveLocalRunOutcome('CRASH', 'PASS'),
    deriveLocalRunOutcome(null, null, 'TIMEOUT'), deriveLocalRunOutcome('PASS', null)]) {
    assert.equal(validateLocalRunResult(validResult({ outcome })).valid, true);
  }
});

test('rejects extra and missing keys at every level', () => {
  assert.ok(issuesOf({ ...validResult(), prompt: 'secret' }).includes('result: unexpected_key'));
  const missing = validResult();
  delete missing.logSha256;
  assert.ok(issuesOf(missing).includes('result.logSha256: missing'));
  const nested = validResult();
  (nested.model as Mutable).path = 'C:\\x';
  assert.ok(issuesOf(nested).includes('model: unexpected_key'));
  const metrics = clone(validResult().metrics);
  delete metrics.truncated;
  assert.ok(issuesOf(validResult({ metrics })).includes('metrics.truncated: missing'));
  const gpu = clone(validResult().metrics);
  gpu.gpu = { status: 'unavailable', reason: 'tool_missing', usedMiB: 0 };
  assert.ok(issuesOf(validResult({ metrics: gpu })).includes('metrics.gpu: unexpected_key'));
  for (const value of [null, [], 'x', 1, Object.create({ schemaVersion: 1 })]) assert.ok(issuesOf(value).length > 0);
});

test('rejects wrong types, NaN, Infinity and unsafe integers', () => {
  const cases: Mutable[] = [
    validResult({ schemaVersion: 2 }),
    validResult({ attempt: 0 }),
    validResult({ attempt: 1.5 }),
    validResult({ attempt: '1' }),
    validResult({ changedFiles: Number.NaN }),
    validResult({ changedFiles: Number.MAX_SAFE_INTEGER + 1 }),
    validResult({ seed: { capable: true, value: 1.5 } }),
    validResult({ seed: { capable: false, value: 7 } }),
    validResult({ seed: { capable: 'yes', value: null } }),
    validResult({ startedAtUtc: '2026-11-10 12:00:00' }),
    validResult({ startedAtUtc: '2026-02-30T12:00:00.000Z' }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), wallMs: Number.POSITIVE_INFINITY } }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), wallMs: -1 } }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), firstOutputMs: Number.NaN } }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), firstOutputMs: 99_999 } }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), truncated: 0 } }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), cpu: { status: 'available', userMs: 1, systemMs: Number.NaN, peakPercent: null } } }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), gpu: { status: 'available', peakUsedMiB: 0, totalMiB: 0, samples: 1 } } }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), gpu: { status: 'available', peakUsedMiB: 1, totalMiB: 4, samples: 0 } } }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), gpu: { status: 'unavailable', reason: 'zero' } } }),
    validResult({ metrics: { ...(validResult().metrics as Mutable), gpu: { status: 'available', peakUsedMiB: null, totalMiB: 4, samples: 1 } } }),
  ];
  for (const value of cases) assert.ok(issuesOf(value).length > 0);
});

test('rejects contradictory outcomes', () => {
  const pass = deriveLocalRunOutcome('PASS', 'PASS');
  const violation = deriveLocalRunOutcome('POLICY_VIOLATION', null);
  const cases = [
    { ...deriveLocalRunOutcome('FAIL', null), resolvedHidden: true },
    { ...violation, policyClean: true },
    { ...pass, publicPass: false },
    { ...pass, timedOut: true },
    { ...pass, runnerFailure: true },
    { ...pass, status: 'FAIL' },
    { ...pass, oracleStatus: null },
    { ...deriveLocalRunOutcome('FAIL', null), status: 'PASS', resolvedHidden: true },
    { ...deriveLocalRunOutcome(null, null), oracleStatus: 'PASS' },
    { ...deriveLocalRunOutcome(null, null), status: 'FAIL', runnerFailure: false },
    { ...pass, status: 'ACCEPTED' },
  ];
  for (const outcome of cases) assert.ok(issuesOf(validResult({ outcome })).length > 0, JSON.stringify(outcome));
});

test('rejects bad ids, hashes, model fields and unknown tool operations', () => {
  const cases: Mutable[] = [
    validResult({ runId: '../escape' }),
    validResult({ runId: 'A' }),
    validResult({ taskId: 'x'.repeat(65) }),
    validResult({ taskId: '' }),
    validResult({ suiteId: 'g0/../x' }),
    validResult({ logSha256: 'C'.repeat(64) }),
    validResult({ logSha256: 'c'.repeat(63) }),
    validResult({ patch: { linesAdded: 1, linesRemoved: 0, sha256: 'z'.repeat(64) } }),
    validResult({ patch: { linesAdded: 1, linesRemoved: 0, sha256: null } }),
    validResult({ model: { tag: 'bad tag', digest: null, runtimeVersion: null } }),
    validResult({ model: { tag: 'ok', digest: 'sha256:abc', runtimeVersion: null } }),
    validResult({ toolCalls: { total: 1, byOperation: { read_text: 1, list_files: 0, apply_unified_diff: 0, run_declared_test: 0, git_diff: 0, shell: 0 } } }),
    validResult({ toolCalls: { total: 1, byOperation: { read_text: 1 } } }),
    validResult({ toolCalls: { total: 9, byOperation: { read_text: 1, list_files: 0, apply_unified_diff: 0, run_declared_test: 0, git_diff: 0 } } }),
  ];
  for (const value of cases) assert.ok(issuesOf(value).length > 0, JSON.stringify(value).slice(0, 120));
});

test('rejects oversize and malformed policy denial lists', () => {
  const codes = Array.from({ length: 33 }, (_, index) => `code_${index}`);
  const cases: Mutable[] = [
    validResult({ policyDenials: { count: 33, reasonCodes: codes } }),
    validResult({ policyDenials: { count: 1, reasonCodes: ['Free text with spaces'] } }),
    validResult({ policyDenials: { count: 2, reasonCodes: ['same', 'same'] } }),
    validResult({ policyDenials: { count: 0, reasonCodes: ['denied'] } }),
    validResult({ policyDenials: { count: 1, reasonCodes: [] } }),
    validResult({ policyDenials: { count: 1, reasonCodes: 'denied' } }),
  ];
  for (const value of cases) assert.ok(issuesOf(value).length > 0);
  assert.equal(validateLocalRunResult(validResult({ policyDenials: { count: 32, reasonCodes: codes.slice(0, 32) } })).valid, true);
});

test('issues never echo result values', () => {
  const issues = issuesOf(validResult({ runId: 'SECRET-VALUE', taskId: 'prompt text' }));
  assert.equal(issues.some((issue) => issue.includes('SECRET') || issue.includes('prompt text')), false);
});

test('writes exactly one valid JSON file that round-trips through the validator', async (t) => {
  const root = await temporaryRoot('agentctl-results-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = createLocalRunResultWriter({ rootDirectory: join(root, 'results') });
  const written = await writer.write(validResult({ attempt: 2 }));
  assert.equal(written.path, join(root, 'results', 'run-2026-11-10', 'i01-attempt-2.json'));
  assert.deepEqual(await readdir(join(root, 'results')), ['run-2026-11-10']);
  assert.deepEqual(await readdir(join(root, 'results', 'run-2026-11-10')), ['i01-attempt-2.json']);
  const text = await readFile(written.path, 'utf8');
  assert.equal(text.endsWith('}\n'), true);
  assert.equal(text.includes('\r'), false);
  const check = validateLocalRunResult(JSON.parse(text));
  assert.equal(check.valid, true);
  assert.deepEqual(clone(check.valid ? check.result : null), clone(validResult({ attempt: 2 })));
});

test('refuses to overwrite an existing result and leaves it unchanged', async (t) => {
  const root = await temporaryRoot('agentctl-results-exists-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = createLocalRunResultWriter({ rootDirectory: root });
  const { path } = await writer.write(validResult());
  const original = await readFile(path, 'utf8');
  await assert.rejects(writer.write(validResult({ changedFiles: 2 })), (error: unknown) =>
    error instanceof BenchmarkResultError && error.code === 'result_exists');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(join(root, 'run-2026-11-10')), ['i01-attempt-1.json']);
});

test('validates before writing and never writes or leaves files for invalid results', async (t) => {
  const root = await temporaryRoot('agentctl-results-invalid-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = createLocalRunResultWriter({ rootDirectory: join(root, 'results') });
  await assert.rejects(writer.write(validResult({ prompt: 'leak me' } as never)), (error: unknown) =>
    error instanceof BenchmarkResultError && error.code === 'invalid_result' && !error.message.includes('leak'));
  assert.deepEqual(await readdir(root), []);
});

test('rejects relative and parent-traversal roots', () => {
  for (const rootDirectory of ['bench/results', '.', '', `${process.cwd()}${sep}..${sep}results`, `${process.cwd()}/a/../b`, 42]) {
    assert.throws(() => createLocalRunResultWriter({ rootDirectory: rootDirectory as string }), (error: unknown) =>
      error instanceof BenchmarkResultError && error.code === 'unsafe_path');
  }
});

test('refuses a junction or symlink in the results root and run directory', async (t) => {
  const root = await temporaryRoot('agentctl-results-link-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target');
  await mkdir(target);
  const linked = join(root, 'linked');
  try {
    await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`cannot create a directory link on this host: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
    return;
  }
  await assert.rejects(createLocalRunResultWriter({ rootDirectory: linked }).write(validResult()), (error: unknown) =>
    error instanceof BenchmarkResultError && error.code === 'unsafe_path');
  await assert.rejects(createLocalRunResultWriter({ rootDirectory: join(linked, 'nested') }).write(validResult()), (error: unknown) =>
    error instanceof BenchmarkResultError && error.code === 'unsafe_path');

  const results = join(root, 'results');
  await mkdir(results);
  await symlink(target, join(results, 'run-2026-11-10'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createLocalRunResultWriter({ rootDirectory: results }).write(validResult()), (error: unknown) =>
    error instanceof BenchmarkResultError && error.code === 'unsafe_path');
  assert.deepEqual(await readdir(target), []);
});

test('a failed write leaves no temp file behind', async (t) => {
  const root = await temporaryRoot('agentctl-results-fail-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, 'run-2026-11-10');
  const seen: string[] = [];

  // Publication fails after the temp file was fully written.
  const failing = createLocalRunResultWriter({
    rootDirectory: root,
    publish: async (temporaryPath) => {
      seen.push((await readdir(runDirectory)).join(','));
      assert.equal(validateLocalRunResult(JSON.parse(await readFile(temporaryPath, 'utf8'))).valid, true);
      throw Object.assign(new Error('disk'), { code: 'EIO' });
    },
  });
  await assert.rejects(failing.write(validResult()), (error: unknown) =>
    error instanceof BenchmarkResultError && error.code === 'write_failed' && error.message === 'Benchmark result could not be written');
  assert.match(seen[0], /^\.i01-attempt-1\.json\.[0-9a-f-]+\.tmp$/);
  assert.deepEqual(await readdir(runDirectory), []);

  // A concurrent writer publishing the same result first wins; nothing is replaced or left behind.
  const racing = createLocalRunResultWriter({
    rootDirectory: root,
    publish: async () => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    },
  });
  await assert.rejects(racing.write(validResult()), (error: unknown) =>
    error instanceof BenchmarkResultError && error.code === 'result_exists');
  assert.deepEqual(await readdir(runDirectory), []);

  // A directory at the target name is never replaced.
  await mkdir(join(runDirectory, 'i01-attempt-1.json'));
  const writer = createLocalRunResultWriter({ rootDirectory: root });
  await assert.rejects(writer.write(validResult()), (error: unknown) =>
    error instanceof BenchmarkResultError && error.code === 'result_exists');
  assert.deepEqual(await readdir(runDirectory), ['i01-attempt-1.json']);

  // A run "directory" that is a file fails as unsafe without creating anything.
  await writeFile(join(root, 'run-file'), '');
  await assert.rejects(writer.write(validResult({ runId: 'run-file' })), (error: unknown) =>
    error instanceof BenchmarkResultError && error.code === 'unsafe_path');
  assert.deepEqual((await readdir(root)).sort(), ['run-2026-11-10', 'run-file']);
});
