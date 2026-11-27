import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovalGrantV1, TaskOperation } from '../domain/policy.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import type { ToolRequest } from '../domain/tools.ts';
import type {
  WorkspacePathAccessPort,
  WorkspacePathOperation,
  WorkspacePathReference,
  WorkspaceReference,
} from '../application/ports/index.ts';
import { createPolicyEngine } from '../policy/policy-engine.ts';
import { ClosedToolGateway, parseAgentProposal, parseToolRequest, parseUnifiedDiff, ToolGatewayError } from './tool-gateway.ts';

const envelopeHash = 'a'.repeat(64);
const workspace: WorkspaceReference = Object.freeze({ workspaceId: 'opaque-workspace' });
const safeDiff = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
].join('\n');

function makeEnvelope(
  operations: readonly TaskOperation[] = ['read'],
  declaredTests: TaskEnvelopeV1['declaredTests'] = [{ id: 'smoke', profile: 'host-json-v1' }],
): TaskEnvelopeV1 {
  return Object.freeze({
    schemaVersion: 1,
    taskId: 'gateway-task',
    prompt: 'Inspect the disposable fixture.',
    requestedOperations: Object.freeze([...operations]),
    allowedPaths: Object.freeze(['src/**/*.ts', 'tests/**/*.mjs']),
    declaredTests: Object.freeze([...declaredTests]),
    baseSnapshotSha256: 'b'.repeat(64),
  });
}

function approval(envelope: TaskEnvelopeV1, expiresAt = '2099-01-01T00:00:00.000Z'): ApprovalGrantV1 {
  return Object.freeze({
    schemaVersion: 1,
    taskId: envelope.taskId,
    envelopeSha256: envelopeHash,
    operations: Object.freeze([...envelope.requestedOperations]),
    expiresAt,
    confirmed: true,
  });
}

function patternMatches(relativePath: string, pattern: string): boolean {
  const concrete = relativePath.split('/');
  const parts = pattern.split('/');
  const match = (i: number, j: number): boolean => {
    if (j === parts.length) return i === concrete.length;
    if (parts[j] === '**') return match(i, j + 1) || (i < concrete.length && match(i + 1, j));
    if (i >= concrete.length) return false;
    const regex = new RegExp(`^${parts[j]!.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`, 'i');
    return regex.test(concrete[i]!) && match(i + 1, j + 1);
  };
  return match(0, 0);
}

class FakeWorkspacePaths implements WorkspacePathAccessPort {
  readonly resolutions: Array<{ relativePath: string; operation: WorkspacePathOperation }> = [];
  readonly reads: string[] = [];
  readonly diffs: Array<readonly string[] | undefined> = [];
  readonly listLimits: number[] = [];
  readonly listPrefixes: Array<string | undefined> = [];
  listedPaths: readonly string[] | undefined;

  async listAllowed(input: {
    readonly workspace: WorkspaceReference;
    readonly allowedPatterns: readonly string[];
    readonly maxResults: number;
    readonly prefix?: string;
  }): Promise<readonly string[]> {
    this.listLimits.push(input.maxResults);
    this.listPrefixes.push(input.prefix);
    const candidates = this.listedPaths ?? ['src/app.ts', 'src/.env', 'src/credentials.prod.json', 'tests/smoke.mjs', 'docs/outside.ts'];
    const prefix = input.prefix?.toLowerCase();
    const scoped = prefix === undefined ? candidates : candidates.filter((relativePath) => {
      const candidate = relativePath.toLowerCase();
      return candidate === prefix || candidate.startsWith(`${prefix}/`);
    });
    return scoped.slice(0, input.maxResults + 1);
  }

  async resolveAllowed(input: {
    readonly workspace: WorkspaceReference;
    readonly relativePath: string;
    readonly operation: WorkspacePathOperation;
    readonly allowedPatterns: readonly string[];
  }): Promise<WorkspacePathReference | null> {
    this.resolutions.push({ relativePath: input.relativePath, operation: input.operation });
    if (!input.allowedPatterns.some((pattern) => patternMatches(input.relativePath, pattern))) return null;
    if (input.relativePath.includes('.env') || input.relativePath.includes('credentials')) return null;
    return Object.freeze({ relativePath: input.relativePath, token: `${input.operation}:opaque` });
  }

  async readText(input: {
    readonly workspace: WorkspaceReference;
    readonly relativePath: string;
    readonly allowedPatterns: readonly string[];
    readonly maxBytes: number;
  }): Promise<string> {
    this.reads.push(input.relativePath);
    return 'const safe = true;\n';
  }

  async gitDiff(input: {
    readonly workspace: WorkspaceReference;
    readonly allowedPatterns: readonly string[];
    readonly relativePaths?: readonly string[];
    readonly maxOutputBytes: number;
  }): Promise<string> {
    this.diffs.push(input.relativePaths);
    return 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n';
  }
}

function gateway(paths = new FakeWorkspacePaths(), counters = { writes: 0, tests: 0 }) {
  const policy = createPolicyEngine();
  const app = new ClosedToolGateway({
    paths,
    policy,
    clock: { now: () => '2026-10-27T12:00:00.000Z' },
    patches: { apply: async () => { counters.writes += 1; } },
    testRegistry: { isRegistered: (testId) => testId === 'smoke' },
    testRunner: { run: async () => { counters.tests += 1; return { passed: true }; } },
  });
  return { app, paths, counters };
}

function context(envelope = makeEnvelope(), grant?: ApprovalGrantV1) {
  return Object.freeze({
    envelope,
    envelopeSha256: envelopeHash,
    ...(grant === undefined ? {} : { approval: grant }),
    workspace,
  });
}

test('strictly parses the five closed requests and rejects shell fields and unsupported operations', () => {
  assert.deepEqual(parseToolRequest({ operation: 'read_text', path: 'src/app.ts' }), {
    operation: 'read_text', path: 'src/app.ts',
  });
  assert.deepEqual(parseToolRequest({ operation: 'run_declared_test', testId: 'smoke' }), {
    operation: 'run_declared_test', testId: 'smoke',
  });
  for (const invalid of [
    { operation: 'run_shell', command: 'node test.js' },
    { operation: 'read_text', path: 'src/app.ts', args: ['unexpected'] },
    { operation: 'run_declared_test', testId: 'smoke', command: 'node --test tests/smoke.mjs' },
    { operation: 'read_text', path: '.env' },
    { operation: 'git_diff', paths: ['src/app.ts', 'src/app.ts'] },
  ]) {
    assert.throws(() => parseToolRequest(invalid), (error: unknown) =>
      error instanceof ToolGatewayError && error.code === 'invalid_tool_request');
  }
});

test('parses the full structured proposal before any request can execute', async () => {
  const proposal = { proposalId: 'proposal-1', toolRequests: [{ operation: 'read_text', path: 'src/app.ts' }] };
  assert.deepEqual(parseAgentProposal(proposal), {
    proposalId: 'proposal-1',
    toolRequests: [{ operation: 'read_text', path: 'src/app.ts' }],
  });

  const { app, paths } = gateway();
  await assert.rejects(app.execute({
    ...context(),
    proposal: {
      proposalId: 'proposal-malformed',
      toolRequests: [
        { operation: 'read_text', path: 'src/app.ts' },
        { operation: 'run_shell', command: 'node test.js' },
      ],
    },
  }), ToolGatewayError);
  assert.deepEqual(paths.reads, []);
});

test('rejects duplicate normalized requests before executing the first request', async () => {
  const { app, paths } = gateway();
  await assert.rejects(app.execute({
    ...context(),
    proposal: {
      proposalId: 'proposal-repeat',
      toolRequests: [
        { operation: 'read_text', path: 'src/app.ts' },
        { operation: 'read_text', path: 'SRC/APP.TS' },
      ],
    },
  }), (error: unknown) => error instanceof ToolGatewayError && error.code === 'invalid_tool_request');
  assert.deepEqual(paths.reads, []);
});

test('parses a bounded unified diff for analysis and rejects deletion, rename, and malformed hunks', () => {
  assert.deepEqual(parseUnifiedDiff(safeDiff).changedPaths, ['src/app.ts']);
  const deletion = ['--- a/src/app.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-old'].join('\n');
  const rename = ['--- a/src/old.ts', '+++ b/src/new.ts', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n');
  const invalidCounts = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,1 @@', '-old', '+new'].join('\n');
  for (const diff of [deletion, rename, invalidCounts]) {
    assert.throws(() => parseUnifiedDiff(diff), (error: unknown) =>
      error instanceof ToolGatewayError && error.code === 'invalid_tool_request');
  }
});

test('reads only physically revalidated allowed paths and filters protected listing results', async () => {
  const { app, paths } = gateway();
  const readContext = context();
  const read = await app.executeRequest(readContext, { operation: 'read_text', path: 'src/app.ts' });
  assert.equal(read.operation, 'read_text');
  if (read.operation === 'read_text') assert.equal(read.text, 'const safe = true;\n');
  assert.deepEqual(paths.reads, ['src/app.ts']);

  const listed = await app.executeRequest(readContext, { operation: 'list_files' });
  assert.deepEqual(listed, { operation: 'list_files', paths: ['src/app.ts', 'tests/smoke.mjs'] });
  assert.ok(paths.resolutions.some((entry) => entry.relativePath === 'src/app.ts' && entry.operation === 'read'));
  assert.equal(paths.resolutions.some((entry) => entry.relativePath === 'src/.env'), false);
  await assert.rejects(app.executeRequest(readContext, { operation: 'read_text', path: 'src/credentials.prod.json' }), ToolGatewayError);
  assert.deepEqual(paths.reads, ['src/app.ts']);
});

test('fails closed on the cap-plus-one listing sentinel before resolving more paths', async () => {
  const paths = new FakeWorkspacePaths();
  paths.listedPaths = Array.from(
    { length: 10_001 },
    (_, index) => `src/file-${String(index).padStart(5, '0')}.ts`,
  );
  const { app } = gateway(paths);
  await assert.rejects(app.executeRequest(context(), { operation: 'list_files' }),
    (error: unknown) => error instanceof ToolGatewayError && error.code === 'tool_output_too_large');
  assert.deepEqual(paths.listLimits, [10_000]);
  assert.deepEqual(paths.listPrefixes, [undefined]);
  assert.equal(paths.resolutions.length, 0);
});

test('scopes the listing limit to the requested prefix', async () => {
  const paths = new FakeWorkspacePaths();
  paths.listedPaths = [
    ...Array.from({ length: 10_001 }, (_, index) => `src/file-${String(index).padStart(5, '0')}.ts`),
    'docs/readme.md',
  ];
  const { app } = gateway(paths);
  const original = makeEnvelope();
  const envelope = Object.freeze({ ...original, allowedPaths: Object.freeze([...original.allowedPaths, 'docs/**/*.md']) });
  const result = await app.executeRequest(context(envelope), { operation: 'list_files', path: 'docs' });
  assert.deepEqual(result, { operation: 'list_files', paths: ['docs/readme.md'] });
  assert.deepEqual(paths.listPrefixes, ['docs']);
  assert.equal(paths.resolutions.length, 1);
});

test('fails when a requested prefix itself exceeds the listing cap', async () => {
  const paths = new FakeWorkspacePaths();
  paths.listedPaths = Array.from(
    { length: 10_001 },
    (_, index) => `src/file-${String(index).padStart(5, '0')}.ts`,
  );
  const { app } = gateway(paths);
  await assert.rejects(app.executeRequest(context(), { operation: 'list_files', path: 'src' }),
    (error: unknown) => error instanceof ToolGatewayError && error.code === 'tool_output_too_large');
  assert.deepEqual(paths.listPrefixes, ['src']);
  assert.equal(paths.resolutions.length, 0);
});

test('blocks patch writing before G2.2 even when a writer adapter is present', async () => {
  const { app, counters } = gateway();
  const envelope = makeEnvelope(['read', 'write']);
  const grant = approval(envelope);
  await assert.rejects(app.executeRequest(context(envelope, grant), { operation: 'apply_unified_diff', diff: safeDiff }),
    (error: unknown) => error instanceof ToolGatewayError && error.code === 'g2_isolation_required');
  assert.equal(counters.writes, 0);
});

test('keeps legacy workspace test paths write-protected without executing them', async () => {
  const { app, paths, counters } = gateway();
  const envelope = makeEnvelope(['read', 'write'], [
    { id: 'legacy-smoke', profile: 'node-test', path: 'tests/smoke.mjs' },
  ]);
  const grant = approval(envelope);
  const diff = [
    '--- a/tests/smoke.mjs',
    '+++ b/tests/smoke.mjs',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
  ].join('\n');
  await assert.rejects(app.executeRequest(context(envelope, grant), { operation: 'apply_unified_diff', diff }),
    (error: unknown) => error instanceof ToolGatewayError && error.code === 'tool_policy_denied');
  const caseAliasDiff = [
    '--- a/TESTS/SMOKE.MJS',
    '+++ b/TESTS/SMOKE.MJS',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
  ].join('\n');
  await assert.rejects(app.executeRequest(context(envelope, grant), { operation: 'apply_unified_diff', diff: caseAliasDiff }),
    (error: unknown) => error instanceof ToolGatewayError && error.code === 'tool_policy_denied');
  assert.equal(paths.resolutions.length, 0);
  assert.equal(counters.writes, 0);
});

test('blocks trusted host-harness execution before G2.2 and rejects unknown IDs', async () => {
  const { app, counters, paths } = gateway();
  const envelope = makeEnvelope(['read', 'process']);
  const grant = approval(envelope);
  await assert.rejects(app.executeRequest(context(envelope, grant), { operation: 'run_declared_test', testId: 'smoke' }),
    (error: unknown) => error instanceof ToolGatewayError && error.code === 'g2_isolation_required');
  await assert.rejects(app.executeRequest(context(envelope, grant), { operation: 'run_declared_test', testId: 'hidden' }), ToolGatewayError);
  assert.equal(counters.tests, 0);
  assert.equal(paths.resolutions.some((entry) => entry.relativePath === 'tests/smoke.mjs'), false);
});

test('never runs a legacy workspace test declaration', async () => {
  const { app, counters, paths } = gateway();
  const envelope = makeEnvelope(['read', 'process'], [
    { id: 'smoke', profile: 'node-test', path: 'tests/smoke.mjs' },
  ]);
  const grant = approval(envelope);
  await assert.rejects(app.executeRequest(context(envelope, grant), { operation: 'run_declared_test', testId: 'smoke' }),
    (error: unknown) => error instanceof ToolGatewayError && error.code === 'invalid_tool_request');
  assert.equal(paths.resolutions.some((entry) => entry.relativePath === 'tests/smoke.mjs'), false);
  assert.equal(counters.tests, 0);
});

test('rejects pathless declared IDs absent from the trusted host registry', async () => {
  const envelope = makeEnvelope(['read', 'process'], [{ id: 'unknown-case', profile: 'host-json-v1' }]);
  const { app, counters, paths } = gateway();
  const grant = approval(envelope);
  await assert.rejects(app.executeRequest(context(envelope, grant), { operation: 'run_declared_test', testId: 'unknown-case' }), ToolGatewayError);
  assert.equal(paths.resolutions.length, 0);
  assert.equal(counters.tests, 0);
});

test('rechecks approval expiration at the tool boundary for write and process', async () => {
  const { app, counters } = gateway();
  for (const operation of ['write', 'process'] as const) {
    const envelope = makeEnvelope(['read', operation]);
    const expired = approval(envelope, '2020-01-01T00:00:00.000Z');
    const request: ToolRequest = operation === 'write'
      ? { operation: 'apply_unified_diff', diff: safeDiff }
      : { operation: 'run_declared_test', testId: 'smoke' };
    await assert.rejects(app.executeRequest(context(envelope, expired), request),
      (error: unknown) => error instanceof ToolGatewayError && error.code === 'approval_required');
  }
  assert.equal(counters.writes, 0);
  assert.equal(counters.tests, 0);
});

test('git_diff uses only the fixed workspace diff port and revalidates requested paths', async () => {
  const { app, paths } = gateway();
  const result = await app.executeRequest(context(), { operation: 'git_diff', paths: ['src/app.ts'] });
  assert.equal(result.operation, 'git_diff');
  assert.deepEqual(paths.diffs, [['src/app.ts']]);
  assert.ok(paths.resolutions.some((entry) => entry.relativePath === 'src/app.ts' && entry.operation === 'diff'));
  if (result.operation === 'git_diff') assert.equal(result.diff.includes('D:\\'), false);
});
