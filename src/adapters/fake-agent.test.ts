import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeAgentAdapter, FakeAgentInvocationError } from './fake-agent.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import type { WorkspaceReference } from '../application/ports/index.ts';

const input = Object.freeze({
  envelope: Object.freeze({
    schemaVersion: 1 as const,
    taskId: 'fake-agent-task',
    prompt: 'Use the disposable fixture.',
    requestedOperations: Object.freeze(['read'] as const),
    allowedPaths: Object.freeze(['src/**/*.ts']),
    declaredTests: Object.freeze([]),
    baseSnapshotSha256: 'a'.repeat(64),
  }) satisfies TaskEnvelopeV1,
  workspace: Object.freeze({ workspaceId: 'opaque-workspace' }) satisfies WorkspaceReference,
});

test('returns one deterministic structured proposal without invoking tools', async () => {
  const agent = new FakeAgentAdapter();
  assert.deepEqual(await agent.invoke(input), {
    kind: 'proposal',
    proposal: { proposalId: 'fake-proposal-1', toolRequests: [] },
  });
  assert.equal(agent.invocationCount, 1);
});

test('exposes malformed proposal data for gateway contract testing', async () => {
  const agent = new FakeAgentAdapter({ scenario: 'malformed_output' });
  const result = await agent.invoke(input);
  assert.equal(result.kind, 'proposal');
  if (result.kind === 'proposal') assert.deepEqual(result.proposal, { proposalId: 7, toolRequests: [] });
});

test('can reproduce normalized repeated requests without performing them', async () => {
  const agent = new FakeAgentAdapter({ scenario: 'repeated_tool_request' });
  const result = await agent.invoke(input);
  assert.equal(result.kind, 'proposal');
  if (result.kind === 'proposal') {
    assert.deepEqual(result.proposal, {
      proposalId: 'fake-proposal-1',
      toolRequests: [
        { operation: 'read_text', path: 'src/example.ts' },
        { operation: 'read_text', path: 'SRC/EXAMPLE.TS' },
      ],
    });
  }
  assert.equal(agent.invocationCount, 1);
});

test('represents an invocation timeout deterministically', async () => {
  const agent = new FakeAgentAdapter({ scenario: 'timeout' });
  await assert.rejects(agent.invoke(input), (error: unknown) =>
    error instanceof FakeAgentInvocationError && error.code === 'timeout');
});

test('represents an adapter crash deterministically', async () => {
  const agent = new FakeAgentAdapter({ scenario: 'crash' });
  await assert.rejects(agent.invoke(input), (error: unknown) =>
    error instanceof FakeAgentInvocationError && error.code === 'crash');
});

test('returns a refusal as a separate, non-proposal outcome', async () => {
  const agent = new FakeAgentAdapter({ scenario: 'refusal' });
  assert.deepEqual(await agent.invoke(input), { kind: 'refusal', reasonCode: 'agent_refused' });
});
