import type { AgentInvocationPort, AgentInvocationResult, WorkspaceReference } from '../application/ports/index.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';

export type FakeAgentScenario =
  | 'structured'
  | 'malformed_output'
  | 'repeated_tool_request'
  | 'timeout'
  | 'crash'
  | 'refusal';

export class FakeAgentInvocationError extends Error {
  readonly code: 'timeout' | 'crash';

  constructor(code: 'timeout' | 'crash') {
    super(`fake_agent_${code}`);
    this.name = 'FakeAgentInvocationError';
    this.code = code;
  }
}

export interface FakeAgentAdapterOptions {
  readonly scenario?: FakeAgentScenario;
  readonly beforeInvoke?: (input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
  }) => Promise<void>;
}

/** Deterministic test-only agent adapter. It never applies patches or runs candidate code. */
export class FakeAgentAdapter implements AgentInvocationPort {
  readonly #beforeInvoke: FakeAgentAdapterOptions['beforeInvoke'];
  #scenario: FakeAgentScenario;
  #invocations = 0;

  constructor(options: FakeAgentAdapterOptions = {}) {
    this.#scenario = options.scenario ?? 'structured';
    this.#beforeInvoke = options.beforeInvoke;
  }

  get invocationCount(): number {
    return this.#invocations;
  }

  setScenario(scenario: FakeAgentScenario): void {
    this.#scenario = scenario;
  }

  async invoke(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
  }): Promise<AgentInvocationResult> {
    this.#invocations += 1;
    await this.#beforeInvoke?.(input);

    switch (this.#scenario) {
      case 'structured':
        return Object.freeze({
          kind: 'proposal',
          proposal: {
            proposalId: `fake-proposal-${this.#invocations}`,
            toolRequests: [],
          },
        });
      case 'malformed_output':
        return Object.freeze({
          kind: 'proposal',
          proposal: { proposalId: 7, toolRequests: [] },
        });
      case 'repeated_tool_request':
        return Object.freeze({
          kind: 'proposal',
          proposal: {
            proposalId: `fake-proposal-${this.#invocations}`,
            toolRequests: [
              { operation: 'read_text', path: 'src/example.ts' },
              { operation: 'read_text', path: 'SRC/EXAMPLE.TS' },
            ],
          },
        });
      case 'timeout':
      case 'crash':
        throw new FakeAgentInvocationError(this.#scenario);
      case 'refusal':
        return Object.freeze({ kind: 'refusal', reasonCode: 'agent_refused' });
    }
  }
}
