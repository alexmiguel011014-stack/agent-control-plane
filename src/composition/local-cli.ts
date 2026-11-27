import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ApplicationServiceError } from '../application/errors.ts';
import { createSnapshotApplicationServices } from '../application/snapshot-services.ts';
import { createTaskApplicationServices } from '../application/task-services.ts';
import { createRuntimeApplicationServices } from '../application/runtime-services.ts';
import { OllamaReadOnlySmokeAdapter } from '../adapters/ollama-smoke.ts';
import { createPolicyEngine } from '../policy/policy-engine.ts';
import { ClosedToolGateway } from '../tools/tool-gateway.ts';
import { SnapshotWorkspaceManager } from '../workspace/snapshot-manager.ts';
import { JsonlTaskEventStore } from '../infra/jsonl-event-store.ts';
import { LocalSnapshotStore } from '../infra/local-snapshot-store.ts';
import { LocalTaskExecutionLease } from '../infra/task-execution-lease.ts';
import { LocalTaskEnvelopeStore } from '../infra/task-envelope-store.ts';
import { NodeEnvelopeHasher } from '../infra/envelope-hasher.ts';
import type { CliApplication } from '../interfaces/cli/agentctl.ts';

/**
 * Production local composition for the terminal Control Plane. Only the bounded
 * read-only G2.1 runtime diagnose/smoke is wired; the full agent adapter, passing
 * evaluator, patch writer, test runner, and generated-code gate remain unavailable.
 */
export async function createLocalCliApplication(stateDirectory = resolve(process.cwd(), '.agentctl')): Promise<CliApplication> {
  const stateRoot = resolve(stateDirectory);
  const snapshots = new LocalSnapshotStore(join(stateRoot, 'snapshots'));
  const events = new JsonlTaskEventStore(join(stateRoot, 'events'));
  const tasks = new LocalTaskEnvelopeStore(join(stateRoot, 'tasks'));
  const executionLease = new LocalTaskExecutionLease(join(stateRoot, 'task-execution.lock'));
  const workspaceManager = new SnapshotWorkspaceManager({ stateDirectory: stateRoot, snapshots });
  const policy = createPolicyEngine();
  const clock = { now: () => new Date().toISOString() };
  const gateway = new ClosedToolGateway({
    paths: workspaceManager,
    policy,
    clock,
    testRegistry: { isRegistered: () => false },
  });

  const taskServices = createTaskApplicationServices({
    events,
    tasks,
    hasher: new NodeEnvelopeHasher(),
    policy,
    workspaces: workspaceManager,
    workspaceIntegrity: workspaceManager,
    tools: gateway,
    executionControl: { cancelTask: async () => ({ quiescent: false }) },
    executionLease,
    agent: { invoke: async () => { throw new Error('local_runtime_unavailable'); } },
    evaluator: { evaluate: async () => { throw new Error('external_evaluator_unavailable'); } },
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
    runtime: createRuntimeApplicationServices(new OllamaReadOnlySmokeAdapter()),
    startup,
  });
}
