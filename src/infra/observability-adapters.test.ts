import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileBenchmarkRunReader } from './benchmark-run-reader.ts';
import { SystemResourceSampler } from './resource-sampler.ts';

function result(runId: string, attempt: number, startedAtUtc: string, status: string, suiteId = 'suite-a') {
  const pass = status === 'PASS';
  return {
    schemaVersion: 1,
    runId,
    taskId: 'task-1',
    attempt,
    suiteId,
    startedAtUtc,
    model: { tag: 'qwen:9b', digest: null, runtimeVersion: null },
    seed: { capable: false, value: null },
    outcome: {
      status,
      publicStatus: status,
      oracleStatus: pass ? 'PASS' : null,
      resolvedHidden: pass,
      publicPass: pass,
      policyClean: status !== 'POLICY_VIOLATION',
      timedOut: status === 'TIMEOUT',
      runnerFailure: status === 'RUNNER_FAILURE',
    },
    toolCalls: {
      total: 0,
      byOperation: { read_text: 0, list_files: 0, apply_unified_diff: 0, run_declared_test: 0, git_diff: 0 },
    },
    changedFiles: 0,
    patch: { linesAdded: 0, linesRemoved: 0, sha256: null },
    logSha256: null,
    policyDenials: { count: 0, reasonCodes: [] },
    metrics: {
      wallMs: 10,
      firstOutputMs: null,
      sampleCount: 0,
      cpu: { status: 'unavailable', reason: 'not_sampled' },
      ram: { status: 'unavailable', reason: 'not_sampled' },
      gpu: { status: 'unavailable', reason: 'not_sampled' },
      truncated: false,
    },
  };
}

async function put(dir: string, run: string, file: string, body: unknown): Promise<void> {
  await mkdir(join(dir, run), { recursive: true });
  await writeFile(join(dir, run, file), typeof body === 'string' ? body : JSON.stringify(body));
}

test('reader returns empty for a missing directory', async () => {
  const reader = new FileBenchmarkRunReader(join(tmpdir(), 'no-such-dir-observability-test'));
  assert.deepEqual(await reader.listRuns(5), []);
});

test('reader summarizes valid runs, skips invalid files, sorts and limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-reader-'));
  try {
    await put(dir, 'run-old', 'task-1-attempt-1.json', result('run-old', 1, '2026-01-01T00:00:00Z', 'PASS'));
    await put(dir, 'run-new', 'task-1-attempt-1.json', result('run-new', 1, '2026-02-01T00:00:00Z', 'FAIL'));
    await put(dir, 'run-new', 'task-1-attempt-2.json', result('run-new', 2, '2026-01-15T00:00:00Z', 'PASS'));
    await put(dir, 'run-new', 'task-2-attempt-1.json', '{not json');
    await put(dir, 'run-new', 'task-3-attempt-1.json', { schemaVersion: 1 });
    await put(dir, 'run-new', 'notes.json', result('run-new', 3, '2026-03-01T00:00:00Z', 'PASS'));
    await put(dir, 'Bad Name', 'task-1-attempt-1.json', result('run-old', 1, '2026-04-01T00:00:00Z', 'PASS'));
    await put(dir, 'run-empty', 'task-1-attempt-1.json', '[]');

    const reader = new FileBenchmarkRunReader(dir);
    const runs = await reader.listRuns(10);
    assert.deepEqual(runs.map((r) => r.runId), ['run-new', 'run-old']);
    const second = runs[0]!;
    assert.equal(second.attempts, 2);
    assert.equal(second.startedAtUtc, '2026-01-15T00:00:00Z');
    assert.equal(second.suiteId, 'suite-a');
    assert.equal(second.modelTag, 'qwen:9b');
    assert.equal(second.counts.PASS, 1);
    assert.equal(second.counts.FAIL, 1);
    assert.equal(second.counts.TIMEOUT, 0);
    assert.equal((await reader.listRuns(1)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function cpuTimes(idle: number, user: number) {
  return [{ model: 'x', speed: 1, times: { user, nice: 0, sys: 0, idle, irq: 0 } }];
}

test('sampler computes cpu percent from deltas and caches the GPU reading', async () => {
  let clock = 0;
  let gpuReads = 0;
  let step = 0;
  const readings = [cpuTimes(100, 0), cpuTimes(150, 50), cpuTimes(150, 150)];
  const sampler = new SystemResourceSampler({
    now: () => clock,
    readGpu: async () => {
      gpuReads += 1;
      return { status: 'available', usedMiB: 100, totalMiB: 1000 };
    },
    cpus: () => readings[step++]!,
    freemem: () => 5,
    totalmem: () => 10,
  });

  const first = await sampler.sample();
  assert.equal(first.cpuPercent, null);
  assert.deepEqual(first.gpu, { status: 'available', usedMiB: 100, totalMiB: 1000 });
  assert.equal(first.ramFreeBytes, 5);
  assert.equal(first.ramTotalBytes, 10);

  clock = 1000;
  const second = await sampler.sample();
  assert.equal(second.cpuPercent, 50);
  assert.equal(gpuReads, 1);

  clock = 6000;
  const third = await sampler.sample();
  assert.equal(third.cpuPercent, 100);
  assert.equal(gpuReads, 2);
});

test('sampler reports unavailable GPU when the reader fails', async () => {
  const sampler = new SystemResourceSampler({
    readGpu: async () => ({ status: 'unavailable', reason: 'tool_missing' }),
    cpus: () => cpuTimes(1, 1),
    freemem: () => 1,
    totalmem: () => 2,
  });
  assert.deepEqual((await sampler.sample()).gpu, { status: 'unavailable' });
});
