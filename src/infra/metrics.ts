import { execFile } from 'node:child_process';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { TOOL_OPERATIONS, type ToolOperationName } from '../domain/tools.ts';

/**
 * Best-effort resource instrumentation for one local run.
 *
 * Metrics are observational only: every reader call is isolated so a failure
 * becomes an `unavailable` record, no collector method throws or rejects, and
 * no method returns a value the caller needs for control flow. Unavailable
 * metrics are never encoded as zero or as a null number.
 */

export const METRICS_LIMITS = Object.freeze({
  minSampleIntervalMs: 250,
  maxSampleIntervalMs: 10_000,
  defaultSampleIntervalMs: 1_000,
  defaultMaxSamples: 600,
  maxMaxSamples: 10_000,
  gpuReadTimeoutMs: 2_000,
  gpuMaxBufferBytes: 4_096,
});

export const METRIC_UNAVAILABLE_REASONS = ['not_sampled', 'error'] as const;
export type MetricUnavailableReason = (typeof METRIC_UNAVAILABLE_REASONS)[number];
export const GPU_UNAVAILABLE_REASONS = ['tool_missing', 'timeout', 'invalid_output', 'error', 'not_sampled'] as const;
export type GpuUnavailableReason = (typeof GPU_UNAVAILABLE_REASONS)[number];
export type GpuSampleUnavailableReason = Exclude<GpuUnavailableReason, 'not_sampled'>;

/** Cumulative process CPU time, in milliseconds. */
export interface CpuReading {
  readonly userMs: number;
  readonly systemMs: number;
}

export interface MemoryReading {
  readonly rssBytes: number;
  readonly systemFreeBytes: number;
  readonly systemTotalBytes: number;
}

export type GpuSample =
  | Readonly<{ status: 'unavailable'; reason: GpuSampleUnavailableReason }>
  | Readonly<{ status: 'available'; usedMiB: number; totalMiB: number }>;

export type CpuSummary =
  | Readonly<{ status: 'unavailable'; reason: MetricUnavailableReason }>
  | Readonly<{ status: 'available'; userMs: number; systemMs: number; peakPercent: number | null }>;

export type RamSummary =
  | Readonly<{ status: 'unavailable'; reason: MetricUnavailableReason }>
  | Readonly<{ status: 'available'; peakRssBytes: number; minSystemFreeBytes: number; systemTotalBytes: number }>;

export type GpuSummary =
  | Readonly<{ status: 'unavailable'; reason: GpuUnavailableReason }>
  | Readonly<{ status: 'available'; peakUsedMiB: number; totalMiB: number; samples: number }>;

export interface RunMetricsSummary {
  readonly wallMs: number;
  readonly firstOutputMs: number | null;
  readonly sampleCount: number;
  readonly cpu: CpuSummary;
  readonly ram: RamSummary;
  readonly gpu: GpuSummary;
  readonly truncated: boolean;
}

export type ToolCallCounts = Readonly<Record<ToolOperationName, number>>;

export interface RunMetricsSnapshot {
  readonly metrics: RunMetricsSummary;
  readonly toolCalls: Readonly<{ total: number; byOperation: ToolCallCounts }>;
}

export interface RunMetricsCollector {
  /** Begin timing and sampling. Calls after the first, or after stop(), are ignored. */
  start(): void;
  /** Record time to first output. Only the first call while running counts. */
  markFirstOutput(): void;
  /** Count one tool call. Unknown operation names and calls after stop() are ignored. */
  recordToolCall(operation: unknown): void;
  /** Stop sampling. Idempotent; resolves within the GPU read bound and never rejects. */
  stop(): Promise<void>;
  /** Pure view of the recorded state; it takes no readings and has no side effects. */
  snapshot(): RunMetricsSnapshot;
}

export interface RunMetricsCollectorOptions {
  /** Monotonic millisecond clock. */
  readonly now?: () => number;
  readonly sampleIntervalMs?: number;
  readonly maxSamples?: number;
  readonly cpuCount?: number;
  readonly readCpu?: () => CpuReading;
  readonly readMemory?: () => MemoryReading;
  readonly readGpu?: () => Promise<GpuSample>;
  /** Upper bound for one GPU read; clamped to at most 2_000 ms. */
  readonly gpuReadTimeoutMs?: number;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

const NVIDIA_SMI_EXECUTABLE = 'nvidia-smi';
const NVIDIA_SMI_ARGUMENTS = Object.freeze(['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']);
const NVIDIA_SMI_LINE_PATTERN = /^\s*(\d{1,9})\s*,\s*(\d{1,9})\s*$/;

/** Parse the first GPU line of the fixed nvidia-smi memory query. */
export function parseNvidiaSmiMemoryOutput(stdout: unknown): GpuSample {
  if (typeof stdout !== 'string' || stdout.length > METRICS_LIMITS.gpuMaxBufferBytes) {
    return Object.freeze({ status: 'unavailable', reason: 'invalid_output' });
  }
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  const match = firstLine === undefined ? null : NVIDIA_SMI_LINE_PATTERN.exec(firstLine);
  if (!match) return Object.freeze({ status: 'unavailable', reason: 'invalid_output' });
  const usedMiB = Number(match[1]);
  const totalMiB = Number(match[2]);
  if (totalMiB <= 0 || usedMiB > totalMiB) return Object.freeze({ status: 'unavailable', reason: 'invalid_output' });
  return Object.freeze({ status: 'available', usedMiB, totalMiB });
}

/** Map an execFile failure to a fixed reason code; the error itself is never kept. */
export function classifyGpuReadError(error: unknown): GpuSampleUnavailableReason {
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown } | null;
  if (failure?.code === 'ENOENT') return 'tool_missing';
  if (failure?.killed === true || failure?.code === 'ETIMEDOUT' || typeof failure?.signal === 'string') return 'timeout';
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'invalid_output';
  return 'error';
}

/** Default GPU reader: a fixed executable with fixed arguments, no shell, bounded time and output. */
export function readNvidiaSmiGpu(): Promise<GpuSample> {
  return new Promise((resolve) => {
    try {
      execFile(NVIDIA_SMI_EXECUTABLE, [...NVIDIA_SMI_ARGUMENTS], {
        shell: false,
        windowsHide: true,
        timeout: METRICS_LIMITS.gpuReadTimeoutMs,
        maxBuffer: METRICS_LIMITS.gpuMaxBufferBytes,
        encoding: 'utf8',
      }, (error, stdout) => {
        if (error) {
          resolve(Object.freeze({ status: 'unavailable', reason: classifyGpuReadError(error) }));
          return;
        }
        resolve(parseNvidiaSmiMemoryOutput(stdout));
      });
    } catch (error) {
      resolve(Object.freeze({ status: 'unavailable', reason: classifyGpuReadError(error) }));
    }
  });
}

function defaultReadCpu(): CpuReading {
  const usage = process.cpuUsage();
  return { userMs: usage.user / 1_000, systemMs: usage.system / 1_000 };
}

function defaultReadMemory(): MemoryReading {
  return { rssBytes: process.memoryUsage().rss, systemFreeBytes: freemem(), systemTotalBytes: totalmem() };
}

function defaultCpuCount(): number {
  try {
    return availableParallelism();
  } catch {
    return 1;
  }
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function validCpu(value: unknown): CpuReading | null {
  const reading = value as Partial<CpuReading> | null;
  if (typeof reading !== 'object' || reading === null) return null;
  if (!isNonNegativeFinite(reading.userMs) || !isNonNegativeFinite(reading.systemMs)) return null;
  return { userMs: reading.userMs, systemMs: reading.systemMs };
}

function validMemory(value: unknown): MemoryReading | null {
  const reading = value as Partial<MemoryReading> | null;
  if (typeof reading !== 'object' || reading === null) return null;
  if (!isNonNegativeSafeInteger(reading.rssBytes) || !isNonNegativeSafeInteger(reading.systemFreeBytes)
    || !isNonNegativeSafeInteger(reading.systemTotalBytes) || reading.systemTotalBytes <= 0
    || reading.systemFreeBytes > reading.systemTotalBytes) return null;
  return { rssBytes: reading.rssBytes, systemFreeBytes: reading.systemFreeBytes, systemTotalBytes: reading.systemTotalBytes };
}

function validGpu(value: unknown): GpuSample {
  const sample = value as Record<string, unknown> | null;
  if (typeof sample !== 'object' || sample === null) return { status: 'unavailable', reason: 'invalid_output' };
  if (sample.status === 'unavailable'
    && (GPU_UNAVAILABLE_REASONS as readonly unknown[]).includes(sample.reason) && sample.reason !== 'not_sampled') {
    return { status: 'unavailable', reason: sample.reason as GpuSampleUnavailableReason };
  }
  if (sample.status === 'available' && isNonNegativeSafeInteger(sample.usedMiB) && isNonNegativeSafeInteger(sample.totalMiB)
    && sample.totalMiB > 0 && sample.usedMiB <= sample.totalMiB) {
    return { status: 'available', usedMiB: sample.usedMiB, totalMiB: sample.totalMiB };
  }
  return { status: 'unavailable', reason: 'invalid_output' };
}

function emptyToolCounts(): Record<ToolOperationName, number> {
  const counts = {} as Record<ToolOperationName, number>;
  for (const operation of TOOL_OPERATIONS) counts[operation] = 0;
  return counts;
}

export function createRunMetricsCollector(options: RunMetricsCollectorOptions = {}): RunMetricsCollector {
  const now = options.now ?? (() => performance.now());
  const sampleIntervalMs = boundedInteger(options.sampleIntervalMs, METRICS_LIMITS.minSampleIntervalMs,
    METRICS_LIMITS.maxSampleIntervalMs, METRICS_LIMITS.defaultSampleIntervalMs);
  const maxSamples = boundedInteger(options.maxSamples, 1, METRICS_LIMITS.maxMaxSamples, METRICS_LIMITS.defaultMaxSamples);
  const gpuReadTimeoutMs = boundedInteger(options.gpuReadTimeoutMs, 1, METRICS_LIMITS.gpuReadTimeoutMs,
    METRICS_LIMITS.gpuReadTimeoutMs);
  const cpuCount = boundedInteger(options.cpuCount ?? defaultCpuCount(), 1, 4_096, 1);
  const readCpu = options.readCpu ?? defaultReadCpu;
  const readMemory = options.readMemory ?? defaultReadMemory;
  const readGpu = options.readGpu ?? readNvidiaSmiGpu;
  const startInterval = options.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const stopInterval = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  const startTimeout = options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const stopTimeout = options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));

  let phase: 'idle' | 'running' | 'stopped' = 'idle';
  let startedAt: number | null = null;
  let wallMs = 0;
  let firstOutputMs: number | null = null;
  let truncated = false;
  let tickCount = 0;
  let intervalHandle: unknown = null;
  let stopPromise: Promise<void> | null = null;
  let gpuInFlight: Promise<void> | null = null;
  const toolCounts = emptyToolCounts();
  let toolTotal = 0;

  let cpuBaseline: CpuReading | null = null;
  let cpuLast: CpuReading | null = null;
  let cpuLastAt: number | null = null;
  let peakPercent: number | null = null;
  let cpuFailed = false;

  let peakRssBytes: number | null = null;
  let minSystemFreeBytes: number | null = null;
  let systemTotalBytes: number | null = null;
  let ramFailed = false;

  let gpuSuccesses = 0;
  let peakUsedMiB = 0;
  let gpuTotalMiB = 0;
  let lastGpuFailure: GpuSampleUnavailableReason | null = null;

  function readClock(): number | null {
    try {
      const value = now();
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function sampleCpu(at: number | null): void {
    let reading: CpuReading | null;
    try {
      reading = validCpu(readCpu());
    } catch {
      reading = null;
    }
    if (!reading) {
      cpuFailed = true;
      return;
    }
    if (!cpuBaseline) {
      cpuBaseline = reading;
    } else if (cpuLast && at !== null && cpuLastAt !== null && at > cpuLastAt) {
      const deltaCpu = (reading.userMs - cpuLast.userMs) + (reading.systemMs - cpuLast.systemMs);
      const percent = (deltaCpu / (at - cpuLastAt)) * 100 / cpuCount;
      if (Number.isFinite(percent) && percent >= 0) {
        const rounded = Math.round(percent * 100) / 100;
        peakPercent = peakPercent === null ? rounded : Math.max(peakPercent, rounded);
      }
    }
    cpuLast = reading;
    cpuLastAt = at;
  }

  function sampleMemory(): void {
    let reading: MemoryReading | null;
    try {
      reading = validMemory(readMemory());
    } catch {
      reading = null;
    }
    if (!reading) {
      ramFailed = true;
      return;
    }
    peakRssBytes = peakRssBytes === null ? reading.rssBytes : Math.max(peakRssBytes, reading.rssBytes);
    minSystemFreeBytes = minSystemFreeBytes === null
      ? reading.systemFreeBytes
      : Math.min(minSystemFreeBytes, reading.systemFreeBytes);
    systemTotalBytes = reading.systemTotalBytes;
  }

  function recordGpu(sample: GpuSample): void {
    if (sample.status === 'available') {
      gpuSuccesses += 1;
      peakUsedMiB = Math.max(peakUsedMiB, sample.usedMiB);
      gpuTotalMiB = Math.max(gpuTotalMiB, sample.totalMiB);
    } else {
      lastGpuFailure = sample.reason;
    }
  }

  /** Launch one bounded GPU read unless one is already in flight. The caller never awaits it. */
  function launchGpuRead(): void {
    if (gpuInFlight) return;
    const bounded = new Promise<GpuSample>((resolve) => {
      let settled = false;
      let timer: unknown = null;
      const finish = (sample: GpuSample): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          try {
            stopTimeout(timer);
          } catch {
            // A failing timer API cannot affect the run.
          }
        }
        resolve(sample);
      };
      try {
        timer = startTimeout(() => finish({ status: 'unavailable', reason: 'timeout' }), gpuReadTimeoutMs);
        (timer as { unref?: () => void } | null)?.unref?.();
      } catch {
        finish({ status: 'unavailable', reason: 'error' });
        return;
      }
      try {
        Promise.resolve(readGpu()).then(
          (value) => finish(validGpu(value)),
          () => finish({ status: 'unavailable', reason: 'error' }),
        );
      } catch {
        finish({ status: 'unavailable', reason: 'error' });
      }
    });
    gpuInFlight = bounded.then((sample) => {
      recordGpu(sample);
      gpuInFlight = null;
    }, () => {
      gpuInFlight = null;
    });
  }

  function tick(): void {
    if (phase !== 'running') return;
    if (tickCount >= maxSamples) {
      truncated = true;
      clearSampler();
      return;
    }
    tickCount += 1;
    const at = readClock();
    if (at !== null && startedAt !== null && at >= startedAt) wallMs = roundMs(at - startedAt);
    sampleCpu(at);
    sampleMemory();
    launchGpuRead();
  }

  function clearSampler(): void {
    if (intervalHandle === null) return;
    const handle = intervalHandle;
    intervalHandle = null;
    try {
      stopInterval(handle);
    } catch {
      // Ignored: the sampler checks phase before every tick.
    }
  }

  function start(): void {
    if (phase !== 'idle') return;
    const at = readClock();
    if (at === null) return;
    phase = 'running';
    startedAt = at;
    sampleCpu(at);
    sampleMemory();
    launchGpuRead();
    try {
      intervalHandle = startInterval(() => {
        try {
          tick();
        } catch {
          truncated = true;
        }
      }, sampleIntervalMs);
      (intervalHandle as { unref?: () => void } | null)?.unref?.();
    } catch {
      intervalHandle = null;
      truncated = true;
    }
  }

  function markFirstOutput(): void {
    if (phase !== 'running' || firstOutputMs !== null || startedAt === null) return;
    const at = readClock();
    if (at === null || at < startedAt) return;
    firstOutputMs = roundMs(at - startedAt);
  }

  function recordToolCall(operation: unknown): void {
    if (phase === 'stopped' || typeof operation !== 'string') return;
    if (!(TOOL_OPERATIONS as readonly string[]).includes(operation)) return;
    if (toolTotal >= Number.MAX_SAFE_INTEGER) return;
    toolCounts[operation as ToolOperationName] += 1;
    toolTotal += 1;
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    const wasRunning = phase === 'running';
    phase = 'stopped';
    clearSampler();
    if (wasRunning && startedAt !== null) {
      const at = readClock();
      if (at !== null && at >= startedAt) wallMs = roundMs(at - startedAt);
      sampleCpu(at);
      sampleMemory();
    }
    const pending = gpuInFlight;
    stopPromise = (pending ?? Promise.resolve()).then(() => undefined, () => undefined);
    return stopPromise;
  }

  function cpuSummary(): CpuSummary {
    if (cpuBaseline && cpuLast) {
      return Object.freeze({
        status: 'available',
        userMs: roundMs(Math.max(0, cpuLast.userMs - cpuBaseline.userMs)),
        systemMs: roundMs(Math.max(0, cpuLast.systemMs - cpuBaseline.systemMs)),
        peakPercent,
      });
    }
    return Object.freeze({ status: 'unavailable', reason: cpuFailed ? 'error' : 'not_sampled' });
  }

  function ramSummary(): RamSummary {
    if (peakRssBytes !== null && minSystemFreeBytes !== null && systemTotalBytes !== null) {
      return Object.freeze({ status: 'available', peakRssBytes, minSystemFreeBytes, systemTotalBytes });
    }
    return Object.freeze({ status: 'unavailable', reason: ramFailed ? 'error' : 'not_sampled' });
  }

  function gpuSummary(): GpuSummary {
    if (gpuSuccesses > 0) {
      return Object.freeze({ status: 'available', peakUsedMiB, totalMiB: gpuTotalMiB, samples: gpuSuccesses });
    }
    return Object.freeze({ status: 'unavailable', reason: lastGpuFailure ?? 'not_sampled' });
  }

  function snapshot(): RunMetricsSnapshot {
    const byOperation = Object.freeze({ ...toolCounts });
    const metrics: RunMetricsSummary = Object.freeze({
      wallMs,
      firstOutputMs,
      sampleCount: tickCount,
      cpu: cpuSummary(),
      ram: ramSummary(),
      gpu: gpuSummary(),
      truncated,
    });
    return Object.freeze({ metrics, toolCalls: Object.freeze({ total: toolTotal, byOperation }) });
  }

  return Object.freeze({
    start: () => {
      try {
        start();
      } catch {
        truncated = true;
      }
    },
    markFirstOutput: () => {
      try {
        markFirstOutput();
      } catch {
        // Metrics never affect the run.
      }
    },
    recordToolCall: (operation: unknown) => {
      try {
        recordToolCall(operation);
      } catch {
        // Metrics never affect the run.
      }
    },
    stop: () => {
      try {
        return stop();
      } catch {
        return Promise.resolve();
      }
    },
    snapshot,
  });
}
