import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyGpuReadError,
  createRunMetricsCollector,
  parseNvidiaSmiMemoryOutput,
  type GpuSample,
  type RunMetricsCollectorOptions,
} from './metrics.ts';
import { deriveLocalRunOutcome, validateLocalRunResult } from './benchmark-result.ts';

function resultWith(snapshot: ReturnType<ReturnType<typeof createRunMetricsCollector>['snapshot']>): unknown {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    taskId: 'i01',
    attempt: 1,
    suiteId: 'g0',
    startedAtUtc: '2026-11-10T12:00:00.000Z',
    model: { tag: 'qwen2.5-coder:1.5b', digest: null, runtimeVersion: null },
    seed: { capable: false, value: null },
    outcome: deriveLocalRunOutcome(null, null),
    toolCalls: snapshot.toolCalls,
    changedFiles: 0,
    patch: { linesAdded: 0, linesRemoved: 0, sha256: null },
    logSha256: null,
    policyDenials: { count: 0, reasonCodes: [] },
    metrics: snapshot.metrics,
  };
}

interface FakeTimers {
  readonly options: Pick<RunMetricsCollectorOptions, 'setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout'>;
  tick(): void;
  fireTimeouts(): void;
  readonly state: { intervals: number; cleared: number; unrefs: number; active: boolean };
}

function fakeTimers(): FakeTimers {
  let intervalCallback: (() => void) | null = null;
  const timeouts = new Map<number, () => void>();
  let nextTimeout = 0;
  const state = { intervals: 0, cleared: 0, unrefs: 0, active: false };
  return {
    state,
    options: {
      setInterval: (callback) => {
        state.intervals += 1;
        state.active = true;
        intervalCallback = callback;
        return { unref: () => { state.unrefs += 1; } };
      },
      clearInterval: () => {
        state.cleared += 1;
        state.active = false;
        intervalCallback = null;
      },
      setTimeout: (callback) => {
        nextTimeout += 1;
        timeouts.set(nextTimeout, callback);
        return nextTimeout;
      },
      clearTimeout: (handle) => { timeouts.delete(handle as number); },
    },
    tick: () => intervalCallback?.(),
    fireTimeouts: () => {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const callback of pending) callback();
    },
  };
}

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

test('summarizes wall time, CPU delta, peak RAM, available GPU and first output', async () => {
  const timers = fakeTimers();
  const time = clock();
  const cpu = [{ userMs: 100, systemMs: 50 }, { userMs: 300, systemMs: 100 }, { userMs: 400, systemMs: 150 }];
  const memory = [
    { rssBytes: 1_000, systemFreeBytes: 9_000, systemTotalBytes: 10_000 },
    { rssBytes: 4_000, systemFreeBytes: 6_000, systemTotalBytes: 10_000 },
    { rssBytes: 2_000, systemFreeBytes: 7_000, systemTotalBytes: 10_000 },
  ];
  const gpu: GpuSample[] = [
    { status: 'available', usedMiB: 300, totalMiB: 4096 },
    { status: 'available', usedMiB: 900, totalMiB: 4096 },
  ];
  let cpuIndex = 0;
  let memoryIndex = 0;
  let gpuIndex = 0;
  const collector = createRunMetricsCollector({
    ...timers.options,
    now: time.now,
    cpuCount: 2,
    readCpu: () => cpu[cpuIndex++] ?? cpu[cpu.length - 1],
    readMemory: () => memory[memoryIndex++] ?? memory[memory.length - 1],
    readGpu: async () => gpu[gpuIndex++] ?? gpu[gpu.length - 1],
  });

  assert.equal(collector.snapshot().metrics.firstOutputMs, null);
  collector.start();
  await flush();
  time.advance(250);
  collector.markFirstOutput();
  time.advance(750);
  collector.markFirstOutput();
  timers.tick();
  await flush();
  time.advance(1_000);
  await collector.stop();

  const { metrics } = collector.snapshot();
  assert.equal(metrics.wallMs, 2_000);
  assert.equal(metrics.firstOutputMs, 250);
  assert.equal(metrics.sampleCount, 1);
  // (200 + 50) ms CPU over 1000 ms wall on 2 cores = 12.5 %, then (100 + 50) / 1000 / 2 = 7.5 %.
  assert.deepEqual(metrics.cpu, { status: 'available', userMs: 300, systemMs: 100, peakPercent: 12.5 });
  assert.deepEqual(metrics.ram, { status: 'available', peakRssBytes: 4_000, minSystemFreeBytes: 6_000, systemTotalBytes: 10_000 });
  assert.deepEqual(metrics.gpu, { status: 'available', peakUsedMiB: 900, totalMiB: 4096, samples: 2 });
  assert.equal(metrics.truncated, false);
  assert.equal(Object.isFrozen(metrics), true);
  assert.equal(Object.isFrozen(metrics.gpu), true);
  assert.equal(timers.state.active, false);
});

test('first output stays null when it was never marked', async () => {
  const timers = fakeTimers();
  const time = clock();
  const collector = createRunMetricsCollector({ ...timers.options, now: time.now, readGpu: async () => ({ status: 'unavailable', reason: 'tool_missing' }) });
  collector.start();
  time.advance(40);
  await collector.stop();
  assert.equal(collector.snapshot().metrics.firstOutputMs, null);
  assert.equal(collector.snapshot().metrics.wallMs, 40);
});

test('unavailable GPU is reported with a reason, never as zero', async () => {
  for (const reason of ['tool_missing', 'timeout', 'invalid_output', 'error'] as const) {
    const timers = fakeTimers();
    const collector = createRunMetricsCollector({ ...timers.options, now: clock().now, readGpu: async () => ({ status: 'unavailable', reason }) });
    collector.start();
    await collector.stop();
    const { gpu } = collector.snapshot().metrics;
    assert.deepEqual(gpu, { status: 'unavailable', reason });
    assert.equal(Object.hasOwn(gpu, 'peakUsedMiB'), false);
  }
  const never = createRunMetricsCollector({ ...fakeTimers().options, now: clock().now, readGpu: async () => ({ status: 'available', usedMiB: 1, totalMiB: 2 }) });
  assert.deepEqual(never.snapshot().metrics.gpu, { status: 'unavailable', reason: 'not_sampled' });
});

test('one successful GPU sample makes the summary available', async () => {
  const timers = fakeTimers();
  const samples: GpuSample[] = [{ status: 'unavailable', reason: 'timeout' }, { status: 'available', usedMiB: 512, totalMiB: 4096 }];
  let index = 0;
  const collector = createRunMetricsCollector({ ...timers.options, now: clock().now, readGpu: async () => samples[index++] });
  collector.start();
  await flush();
  timers.tick();
  await collector.stop();
  assert.deepEqual(collector.snapshot().metrics.gpu, { status: 'available', peakUsedMiB: 512, totalMiB: 4096, samples: 1 });
});

test('sampling stops at maxSamples and flags truncation', async () => {
  const timers = fakeTimers();
  let gpuReads = 0;
  const collector = createRunMetricsCollector({
    ...timers.options,
    now: clock().now,
    maxSamples: 3,
    readGpu: async () => {
      gpuReads += 1;
      return { status: 'available', usedMiB: 1, totalMiB: 2 };
    },
  });
  collector.start();
  for (let index = 0; index < 3; index += 1) {
    await flush();
    timers.tick();
  }
  assert.equal(collector.snapshot().metrics.truncated, false);
  await flush();
  timers.tick();
  assert.equal(collector.snapshot().metrics.truncated, true);
  assert.equal(timers.state.active, false);
  timers.tick();
  await collector.stop();
  const { metrics } = collector.snapshot();
  assert.equal(metrics.sampleCount, 3);
  assert.equal(gpuReads, 4);
  assert.equal(metrics.truncated, true);
});

test('stop is idempotent, clears an unref\'d sampler, and later calls are ignored', async () => {
  const timers = fakeTimers();
  const time = clock();
  const collector = createRunMetricsCollector({ ...timers.options, now: time.now, readGpu: async () => ({ status: 'unavailable', reason: 'tool_missing' }) });
  collector.start();
  assert.equal(timers.state.unrefs, 1);
  time.advance(10);
  const first = collector.stop();
  const second = collector.stop();
  assert.equal(first, second);
  await first;
  assert.equal(timers.state.cleared, 1);
  const before = collector.snapshot();
  time.advance(500);
  collector.start();
  collector.markFirstOutput();
  collector.recordToolCall('read_text');
  timers.tick();
  await collector.stop();
  assert.deepEqual(collector.snapshot(), before);
  assert.equal(timers.state.intervals, 1);
});

test('real sampler and GPU-bound timers are unref\'d and never keep the process alive', async () => {
  const handles: NodeJS.Timeout[] = [];
  const collector = createRunMetricsCollector({
    setInterval: (callback, ms) => {
      const handle = setInterval(callback, ms);
      handles.push(handle);
      return handle;
    },
    setTimeout: (callback, ms) => {
      const handle = setTimeout(callback, ms);
      handles.push(handle);
      return handle;
    },
    readGpu: async () => ({ status: 'unavailable', reason: 'tool_missing' }),
  });
  collector.start();
  assert.equal(handles.length, 2);
  for (const handle of handles) assert.equal(handle.hasRef(), false);
  await collector.stop();
  const { metrics } = collector.snapshot();
  assert.equal(metrics.cpu.status, 'available');
  assert.equal(metrics.ram.status, 'available');
  assert.equal(validateLocalRunResult(resultWith(collector.snapshot())).valid, true);
});

test('counts only known tool operations and ignores invalid names', () => {
  const collector = createRunMetricsCollector({ ...fakeTimers().options, now: clock().now, readGpu: async () => ({ status: 'unavailable', reason: 'tool_missing' }) });
  collector.recordToolCall('read_text');
  collector.recordToolCall('read_text');
  collector.recordToolCall('apply_unified_diff');
  for (const invalid of ['shell', '', 'READ_TEXT', 42, null, undefined, { toString: () => 'read_text' }, '__proto__', 'constructor']) {
    collector.recordToolCall(invalid);
  }
  const { toolCalls } = collector.snapshot();
  assert.equal(toolCalls.total, 3);
  assert.deepEqual(toolCalls.byOperation, { read_text: 2, list_files: 0, apply_unified_diff: 1, run_declared_test: 0, git_diff: 0 });
});

test('throwing CPU and memory readers become unavailable without throwing', async () => {
  const timers = fakeTimers();
  const collector = createRunMetricsCollector({
    ...timers.options,
    now: clock().now,
    readCpu: () => { throw new Error('cpu boom'); },
    readMemory: () => { throw new Error('memory boom'); },
    readGpu: () => { throw new Error('gpu boom'); },
  });
  collector.start();
  timers.tick();
  await collector.stop();
  const { metrics } = collector.snapshot();
  assert.deepEqual(metrics.cpu, { status: 'unavailable', reason: 'error' });
  assert.deepEqual(metrics.ram, { status: 'unavailable', reason: 'error' });
  assert.deepEqual(metrics.gpu, { status: 'unavailable', reason: 'error' });
});

test('invalid reader values are rejected rather than recorded', async () => {
  const collector = createRunMetricsCollector({
    ...fakeTimers().options,
    now: clock().now,
    readCpu: () => ({ userMs: Number.NaN, systemMs: 1 }),
    readMemory: () => ({ rssBytes: -1, systemFreeBytes: 1, systemTotalBytes: 2 }),
    readGpu: async () => ({ status: 'available', usedMiB: 0, totalMiB: 0 }) as GpuSample,
  });
  collector.start();
  await collector.stop();
  const { metrics } = collector.snapshot();
  assert.equal(metrics.cpu.status, 'unavailable');
  assert.equal(metrics.ram.status, 'unavailable');
  assert.deepEqual(metrics.gpu, { status: 'unavailable', reason: 'invalid_output' });
});

test('a rejected GPU read is swallowed and recorded as unavailable', async () => {
  const collector = createRunMetricsCollector({ ...fakeTimers().options, now: clock().now, readGpu: () => Promise.reject(new Error('rejected')) });
  collector.start();
  await collector.stop();
  assert.deepEqual(collector.snapshot().metrics.gpu, { status: 'unavailable', reason: 'error' });
});

test('a hung GPU read cannot delay stop beyond its bound (fake timer)', async () => {
  const timers = fakeTimers();
  const time = clock();
  const collector = createRunMetricsCollector({ ...timers.options, now: time.now, readGpu: () => new Promise<GpuSample>(() => undefined) });
  collector.start();
  time.advance(100);
  let stopped = false;
  const stopping = collector.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  timers.fireTimeouts();
  await stopping;
  assert.equal(stopped, true);
  const { metrics } = collector.snapshot();
  assert.equal(metrics.wallMs, 100);
  assert.deepEqual(metrics.gpu, { status: 'unavailable', reason: 'timeout' });
});

test('a hung GPU read with real timers resolves stop within the configured bound', async () => {
  const collector = createRunMetricsCollector({ gpuReadTimeoutMs: 30, readGpu: () => new Promise<GpuSample>(() => undefined) });
  collector.start();
  const startedAt = Date.now();
  await collector.stop();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(collector.snapshot().metrics.gpu, { status: 'unavailable', reason: 'timeout' });
});

test('misuse and failing timer or clock APIs never throw and keep the summary valid', async () => {
  const misuse = createRunMetricsCollector({ ...fakeTimers().options, now: clock().now, readGpu: async () => ({ status: 'unavailable', reason: 'tool_missing' }) });
  misuse.markFirstOutput();
  await misuse.stop();
  misuse.start();
  misuse.markFirstOutput();
  await misuse.stop();
  assert.equal(misuse.snapshot().metrics.wallMs, 0);
  assert.deepEqual(misuse.snapshot().metrics.cpu, { status: 'unavailable', reason: 'not_sampled' });

  const broken = createRunMetricsCollector({
    now: () => { throw new Error('clock'); },
    setInterval: () => { throw new Error('interval'); },
    clearInterval: () => { throw new Error('clear'); },
    setTimeout: () => { throw new Error('timeout'); },
    clearTimeout: () => { throw new Error('clear timeout'); },
    readGpu: async () => ({ status: 'available', usedMiB: 1, totalMiB: 2 }),
    sampleIntervalMs: Number.NaN,
    maxSamples: -5,
  });
  broken.start();
  broken.markFirstOutput();
  broken.recordToolCall('git_diff');
  await broken.stop();

  const flaky = createRunMetricsCollector({
    now: clock().now,
    setInterval: () => { throw new Error('interval'); },
    setTimeout: () => { throw new Error('timeout'); },
    readGpu: async () => ({ status: 'available', usedMiB: 1, totalMiB: 2 }),
  });
  flaky.start();
  await flaky.stop();
  assert.equal(flaky.snapshot().metrics.truncated, true);
  assert.deepEqual(flaky.snapshot().metrics.gpu, { status: 'unavailable', reason: 'error' });

  for (const collector of [misuse, broken, flaky]) {
    const check = validateLocalRunResult(resultWith(collector.snapshot()));
    assert.equal(check.valid, true, check.valid ? '' : check.issues.join(', '));
  }
});

test('parses the fixed nvidia-smi memory query and classifies read failures', () => {
  assert.deepEqual(parseNvidiaSmiMemoryOutput('812, 4096\r\n'), { status: 'available', usedMiB: 812, totalMiB: 4096 });
  assert.deepEqual(parseNvidiaSmiMemoryOutput('\n 10 ,20\n30, 40\n'), { status: 'available', usedMiB: 10, totalMiB: 20 });
  for (const bad of ['', 'N/A, N/A', '5000, 4096', '1, 0', '-1, 10', '1.5, 10', 'x'.repeat(5_000), 42]) {
    assert.deepEqual(parseNvidiaSmiMemoryOutput(bad), { status: 'unavailable', reason: 'invalid_output' });
  }
  assert.equal(classifyGpuReadError({ code: 'ENOENT' }), 'tool_missing');
  assert.equal(classifyGpuReadError({ killed: true, signal: 'SIGTERM' }), 'timeout');
  assert.equal(classifyGpuReadError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'invalid_output');
  assert.equal(classifyGpuReadError({ code: 1 }), 'error');
  assert.equal(classifyGpuReadError(null), 'error');
});
