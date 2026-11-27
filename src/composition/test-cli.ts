import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApplicationServiceError } from '../application/errors.ts';
import type { TaskApplicationServices } from '../application/task-services.ts';
import type { ToolExecutionPort } from '../application/ports/index.ts';
import { FakeAgentAdapter } from '../adapters/fake-agent.ts';
import { createSnapshotApplicationServices } from '../application/snapshot-services.ts';
import { createTaskApplicationServices } from '../application/task-services.ts';
import { JsonlTaskEventStore } from '../infra/jsonl-event-store.ts';
import { NodeEnvelopeHasher } from '../infra/envelope-hasher.ts';
import { LocalTaskExecutionLease } from '../infra/task-execution-lease.ts';
import { LocalTaskEnvelopeStore } from '../infra/task-envelope-store.ts';
import { LocalSnapshotStore } from '../infra/local-snapshot-store.ts';
import { createPolicyEngine } from '../policy/policy-engine.ts';
import { SnapshotWorkspaceManager } from '../workspace/snapshot-manager.ts';
import type { CliApplication } from '../interfaces/cli/agentctl.ts';

export interface TestCliOptions {
  readonly holdAgentAfterStart?: boolean;
}

function isEmptyFakeProposal(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && typeof record.proposalId === 'string'
    && Array.isArray(record.toolRequests)
    && record.toolRequests.length === 0;
}

/**
 * Isolated G1.9-only composition. It has no patch writer, declared-test runner,
 * model, or oracle. The only accepted proposal has zero tool requests.
 */
export async function createTestCliApplication(
  stateDirectory = resolve(process.cwd(), '.agentctl'),
  options: TestCliOptions = {},
): Promise<CliApplication> {
  const stateRoot = resolve(stateDirectory);
  const snapshots = new LocalSnapshotStore(join(stateRoot, 'snapshots'));
  const events = new JsonlTaskEventStore(join(stateRoot, 'events'));
  const tasks = new LocalTaskEnvelopeStore(join(stateRoot, 'tasks'));
  const executionLease = new LocalTaskExecutionLease(join(stateRoot, 'task-execution.lock'));
  const workspaceManager = new SnapshotWorkspaceManager({ stateDirectory: stateRoot, snapshots });
  const policy = createPolicyEngine();
  const clock = { now: () => new Date().toISOString() };
  const fakeAgent = new FakeAgentAdapter({
    ...(options.holdAgentAfterStart
      ? {
        beforeInvoke: async () => {
          await writeFile(join(stateRoot, 'test-agent-ready'), 'ready\n', { flag: 'wx' });
          await new Promise<void>(() => { setInterval(() => {}, 1_000); });
        },
      }
      : {}),
  });
  const tools: ToolExecutionPort = Object.freeze({
    async execute(input: Parameters<ToolExecutionPort['execute']>[0]) {
      if (!isEmptyFakeProposal(input.proposal)) throw new Error('g1_9_non_empty_tool_proposal_denied');
      return Object.freeze([]);
    },
  });
  const taskServices: TaskApplicationServices = createTaskApplicationServices({
    events,
    tasks,
    hasher: new NodeEnvelopeHasher(),
    policy,
    workspaces: workspaceManager,
    workspaceIntegrity: workspaceManager,
    tools,
    executionControl: { cancelTask: async () => ({ quiescent: false }) },
    executionLease,
    agent: fakeAgent,
    evaluator: { evaluate: async () => ({ passed: true, reasonCode: 'g1_9_fake_evaluator_passed' }) },
    clock,
    ids: { next: () => randomUUID() },
  });

  let startup: CliApplication['startup'] = Object.freeze({ state: 'ready' });
  try {
    await taskServices.recoverAfterRestart();
  } catch (error) {
    if (!(error instanceof ApplicationServiceError) || error.code !== 'CONCURRENCY_CONFLICT') throw error;
    startup = Object.freeze({ state: 'lease_busy', lockConflict: error.lockConflict ?? Object.freeze({}) });
  }

  return Object.freeze({
    tasks: taskServices,
    snapshots: createSnapshotApplicationServices({ snapshots }),
    runtime: {
      diagnose: async () => Object.freeze({ status: 'runtime_unavailable', modelTag: 'qwen2.5-coder:1.5b' }),
      smoke: async (modelTag: string) => Object.freeze({ status: 'blocked', reasonCode: 'runtime_unavailable', modelTag }),
    },
    startup,
    testOnlyNoToolFakeRun: true,
  });
}
