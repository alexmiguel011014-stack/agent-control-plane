import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskEvent } from '../domain/event.ts';
import { createObservabilityServices } from './observability-services.ts';
import type { ObservedResources, ObservedRunSummary, ObservedTaskStream } from './ports/index.ts';

const created = (taskId: string, at: string): TaskEvent => ({
  type: 'task.created', eventId: `${taskId}-c`, taskId, occurredAt: at, actor: 'operator', envelopeSha256: 'a'.repeat(64),
});
const changed = (taskId: string, to: 'QUEUED' | 'RUNNING', at: string): TaskEvent => ({
  type: 'task.state_changed', eventId: `${taskId}-${to}`, taskId, occurredAt: at, actor: 'system', from: 'DRAFT', to,
});

function setup(streams: readonly ObservedTaskStream[]) {
  const calls: string[] = [];
  const runs: ObservedRunSummary[] = [];
  const resources: ObservedResources = { gpu: { status: 'unavailable' }, ramFreeBytes: 1, ramTotalBytes: 2, cpuPercent: null };
  const services = createObservabilityServices({
    taskReader: { async readStreams() { calls.push('streams'); return streams; } },
    runReader: { async listRuns(limit) { calls.push(`runs:${limit}`); return runs; } },
    resources: { async sample() { calls.push('sample'); return resources; } },
    clock: { now: () => '2026-01-01T00:00:00.000Z' },
  });
  return { services, calls, runs, resources };
}

test('snapshot derives state, sorts tasks, skips empty streams and calls each port once', async () => {
  const { services, calls, runs, resources } = setup([
    { taskId: 'b', events: [created('b', 't1'), changed('b', 'QUEUED', 't2'), changed('b', 'RUNNING', 't3')] },
    { taskId: 'empty', events: [] },
    { taskId: 'a', events: [created('a', 't0')] },
  ]);
  const snapshot = await services.getSnapshot();
  assert.deepEqual(calls, ['streams', 'runs:5', 'sample']);
  assert.equal(snapshot.generatedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(snapshot.tasks, [
    { taskId: 'a', state: 'DRAFT', eventCount: 1, lastEventAt: 't0' },
    { taskId: 'b', state: 'RUNNING', eventCount: 3, lastEventAt: 't3' },
  ]);
  assert.equal(snapshot.runs, runs);
  assert.equal(snapshot.resources, resources);
  assert.ok(Object.isFrozen(snapshot));
});

test('service object is frozen with getSnapshot as its only own key', () => {
  const { services } = setup([]);
  assert.deepEqual(Object.keys(services), ['getSnapshot']);
  assert.ok(Object.isFrozen(services));
});
