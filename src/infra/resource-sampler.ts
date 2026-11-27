import { cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from 'node:os';
import type { ObservedResources, ResourceSamplerPort } from '../application/ports/index.ts';
import { readNvidiaSmiGpu, type GpuSample } from './metrics.ts';

const GPU_CACHE_MS = 5_000;

type CpuTimes = ReturnType<typeof osCpus>;

export interface SystemResourceSamplerOptions {
  readonly now?: () => number;
  readonly readGpu?: () => Promise<GpuSample>;
  readonly cpus?: () => CpuTimes;
  readonly freemem?: () => number;
  readonly totalmem?: () => number;
}

function totals(cpus: CpuTimes): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Best-effort host resource sampler. Never throws; the GPU reading is cached for 5 s. */
export class SystemResourceSampler implements ResourceSamplerPort {
  readonly #now: () => number;
  readonly #readGpu: () => Promise<GpuSample>;
  readonly #cpus: () => CpuTimes;
  readonly #freemem: () => number;
  readonly #totalmem: () => number;
  #previous: { idle: number; total: number } | null = null;
  #gpu: { at: number; value: ObservedResources['gpu'] } | null = null;

  constructor(options: SystemResourceSamplerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#readGpu = options.readGpu ?? readNvidiaSmiGpu;
    this.#cpus = options.cpus ?? osCpus;
    this.#freemem = options.freemem ?? osFreemem;
    this.#totalmem = options.totalmem ?? osTotalmem;
  }

  async sample(): Promise<ObservedResources> {
    const gpu = await this.#gpuReading();
    let cpuPercent: number | null = null;
    try {
      const current = totals(this.#cpus());
      const previous = this.#previous;
      this.#previous = current;
      if (previous !== null) {
        const totalDelta = current.total - previous.total;
        const idleDelta = current.idle - previous.idle;
        if (totalDelta > 0) {
          cpuPercent = Math.min(100, Math.max(0, Math.round(((totalDelta - idleDelta) / totalDelta) * 1000) / 10));
        }
      }
    } catch {
      cpuPercent = null;
    }
    return Object.freeze({
      gpu,
      ramFreeBytes: this.#freemem(),
      ramTotalBytes: this.#totalmem(),
      cpuPercent,
    });
  }

  async #gpuReading(): Promise<ObservedResources['gpu']> {
    const now = this.#now();
    if (this.#gpu !== null && now - this.#gpu.at < GPU_CACHE_MS) return this.#gpu.value;
    let value: ObservedResources['gpu'];
    try {
      const reading = await this.#readGpu();
      value = reading.status === 'available'
        ? Object.freeze({ status: 'available', usedMiB: reading.usedMiB, totalMiB: reading.totalMiB })
        : Object.freeze({ status: 'unavailable' });
    } catch {
      value = Object.freeze({ status: 'unavailable' });
    }
    this.#gpu = { at: now, value };
    return value;
  }
}
