import { join, resolve } from 'node:path';
import {
  createObservabilityServices,
  type ObservabilityApplicationServices,
} from '../application/observability-services.ts';
import type { ResourceSamplerPort } from '../application/ports/index.ts';
import { FileBenchmarkRunReader } from '../infra/benchmark-run-reader.ts';
import { JsonlObservedTaskReader } from '../infra/jsonl-event-reader.ts';
import { SystemResourceSampler } from '../infra/resource-sampler.ts';

export interface ObservabilityCompositionOptions {
  readonly repositoryRoot: string;
  /** Defaults to `<cwd>/.agentctl`. Only ever read: nothing here creates it. */
  readonly stateDirectory?: string;
  /** Test seam; the binary leaves it unset and gets the real system sampler. */
  readonly resources?: ResourceSamplerPort;
}

/** Read-only observability wiring: event streams, local benchmark results, host resources. */
export function createObservabilityComposition(options: ObservabilityCompositionOptions): ObservabilityApplicationServices {
  const stateDirectory = options.stateDirectory ?? resolve(process.cwd(), '.agentctl');
  return createObservabilityServices({
    taskReader: new JsonlObservedTaskReader(join(stateDirectory, 'events')),
    runReader: new FileBenchmarkRunReader(join(options.repositoryRoot, 'bench', 'results', 'local')),
    resources: options.resources ?? new SystemResourceSampler(),
    clock: { now: () => new Date().toISOString() },
  });
}
