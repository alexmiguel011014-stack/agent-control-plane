import type {
  BenchmarkRunReaderPort,
  ClockPort,
  ObservabilitySnapshot,
  ObservedTask,
  ObservedTaskReaderPort,
  ResourceSamplerPort,
} from './ports/index.ts';
import { TASK_STATE_CHANGED_EVENT } from '../domain/event.ts';
import type { TaskState } from '../domain/state.ts';

export interface ObservabilityDependencies {
  readonly taskReader: ObservedTaskReaderPort;
  readonly runReader: BenchmarkRunReaderPort;
  readonly resources: ResourceSamplerPort;
  readonly clock: ClockPort;
}

export interface ObservabilityApplicationServices {
  getSnapshot(): Promise<ObservabilitySnapshot>;
}

export function createObservabilityServices(dependencies: ObservabilityDependencies): ObservabilityApplicationServices {
  return Object.freeze({
    async getSnapshot(): Promise<ObservabilitySnapshot> {
      const streams = await dependencies.taskReader.readStreams();
      const runs = await dependencies.runReader.listRuns(5);
      const resources = await dependencies.resources.sample();
      const tasks: ObservedTask[] = [];
      for (const stream of streams) {
        const last = stream.events.at(-1);
        if (last === undefined) continue;
        let state: TaskState = 'DRAFT';
        for (let i = stream.events.length - 1; i >= 0; i -= 1) {
          const event = stream.events[i];
          if (event !== undefined && event.type === TASK_STATE_CHANGED_EVENT) {
            state = event.to;
            break;
          }
        }
        tasks.push(Object.freeze({
          taskId: stream.taskId, state, eventCount: stream.events.length, lastEventAt: last.occurredAt,
        }));
      }
      tasks.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
      return Object.freeze({
        generatedAt: dependencies.clock.now(),
        tasks: Object.freeze(tasks),
        runs,
        resources,
      });
    },
  });
}
