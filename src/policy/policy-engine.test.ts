import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovalGrantV1, PolicyEvaluationInput, TaskOperation } from '../domain/policy.ts';
import { createPolicyEngine, normalizeAllowedPath } from './policy-engine.ts';

const ENVELOPE_HASH = 'a'.repeat(64);
const NOW = '2026-10-26T12:00:00.000Z';

function makeInput(
  requestedOperations: readonly TaskOperation[],
  allowedPaths: readonly string[] = ['src/example.ts'],
  approval?: ApprovalGrantV1,
  envelopeSha256 = ENVELOPE_HASH,
): PolicyEvaluationInput {
  return {
    envelope: {
      schemaVersion: 1,
      taskId: 'policy-task-1',
      prompt: 'Inspect the requested files.',
      requestedOperations,
      allowedPaths,
      declaredTests: [],
      baseSnapshotSha256: 'b'.repeat(64),
    },
    envelopeSha256,
    ...(approval === undefined ? {} : { approval }),
    now: NOW,
  };
}

function makeApproval(
  operations: readonly TaskOperation[],
  overrides: Partial<ApprovalGrantV1> = {},
): ApprovalGrantV1 {
  return {
    schemaVersion: 1,
    taskId: 'policy-task-1',
    envelopeSha256: ENVELOPE_HASH,
    operations,
    expiresAt: '2026-10-26T13:00:00.000Z',
    confirmed: true,
    ...overrides,
  };
}

const policy = createPolicyEngine();

test('read is allowed without an approval', async () => {
  assert.deepEqual(await policy.evaluate(makeInput(['read'])), {
    outcome: 'allow',
    reasonCode: 'policy_allowed',
  });
});

test('network is denied in v1', async () => {
  assert.deepEqual(await policy.evaluate(makeInput(['network'])), {
    outcome: 'deny',
    reasonCode: 'network_not_allowed',
  });
});

for (const operation of ['write', 'process'] as const) {
  test(`${operation} requires approval`, async () => {
    assert.deepEqual(await policy.evaluate(makeInput([operation])), {
      outcome: 'requires_approval',
      reasonCode: 'approval_required',
    });
  });
}

test('a matching, confirmed, unexpired approval allows its exact operation set', async () => {
  const approval = makeApproval(['process', 'write']);
  assert.deepEqual(await policy.evaluate(makeInput(['write', 'process'], ['src/example.ts'], approval)), {
    outcome: 'allow',
    reasonCode: 'approval_valid',
  });
});

test('approval for another task is not accepted', async () => {
  const approval = makeApproval(['write'], { taskId: 'another-task' });
  assert.equal((await policy.evaluate(makeInput(['write'], ['src/example.ts'], approval))).outcome, 'requires_approval');
});

test('approval for another envelope hash is not accepted', async () => {
  const approval = makeApproval(['write'], { envelopeSha256: 'c'.repeat(64) });
  assert.equal((await policy.evaluate(makeInput(['write'], ['src/example.ts'], approval))).outcome, 'requires_approval');
});

test('approval for a different operation set is not accepted', async () => {
  const approval = makeApproval(['read']);
  assert.equal((await policy.evaluate(makeInput(['write'], ['src/example.ts'], approval))).outcome, 'requires_approval');
});

test('expired and invalid-date approvals are not accepted', async () => {
  const expired = makeApproval(['write'], { expiresAt: '2026-10-26T11:59:59.999Z' });
  const invalidDate = makeApproval(['write'], { expiresAt: '2026-02-30T13:00:00.000Z' });
  assert.equal((await policy.evaluate(makeInput(['write'], ['src/example.ts'], expired))).outcome, 'requires_approval');
  assert.equal((await policy.evaluate(makeInput(['write'], ['src/example.ts'], invalidDate))).outcome, 'requires_approval');
});

test('unconfirmed approval is not accepted', async () => {
  const approval = makeApproval(['write'], { confirmed: false as never });
  assert.equal((await policy.evaluate(makeInput(['write'], ['src/example.ts'], approval))).outcome, 'requires_approval');
});

test('invalid envelope hashes are denied before approval evaluation', async () => {
  assert.deepEqual(await policy.evaluate(makeInput(['read'], ['src/example.ts'], undefined, 'not-a-hash')), {
    outcome: 'deny',
    reasonCode: 'invalid_task_envelope',
  });
});

test('retains supported glob patterns for concrete-path filtering in later goals', async () => {
  for (const pattern of ['docs/*.md', '**/*.ts', '**']) {
    assert.equal(normalizeAllowedPath(pattern), pattern);
    assert.equal((await policy.evaluate(makeInput(['read'], [pattern]))).outcome, 'allow');
  }
});

test('allows nearby but distinct names that are not credential basenames', async () => {
  for (const path of ['credentialsManager.prod.json', 'secretsBackup.yaml']) {
    assert.equal(normalizeAllowedPath(path), path);
    assert.equal((await policy.evaluate(makeInput(['read'], [path]))).outcome, 'allow');
  }
});

const rejectedPaths = [
  ['parent traversal', 'src/../outside.ts'],
  ['absolute POSIX path', '/outside/file.ts'],
  ['drive path', 'C:/outside/file.ts'],
  ['UNC path', '//server/share/file.ts'],
  ['backslash path', 'src\\outside.ts'],
  ['Windows alternate data stream', 'src/file.ts:secret'],
  ['dot segment alias', 'src/./file.ts'],
  ['empty path segment alias', 'src//file.ts'],
  ['glob segment with trailing dot alias', 'src/foo*.'],
  ['glob segment with trailing space alias', 'src/foo*. '],
  ['environment file', '.env'],
  ['environment variant', '.env.production'],
  ['Git directory', 'src/.git/config'],
  ['Git directory with trailing dot alias', 'src/.git./config'],
  ['Git directory with trailing space alias', 'src/.git /config'],
  ['dependency directory', 'node_modules/pkg/index.js'],
  ['Python environment directory', '.venv/pyvenv.cfg'],
  ['Windows reserved device with extension', 'src/NUL.txt'],
  ['Windows reserved device with superscript suffix', 'src/COM¹.txt'],
  ['Windows alternate data stream syntax', 'src/file.ts:secret'],
  ['leading-space Git alias', ' .git/config'],
  ['leading-space environment alias', ' .env'],
  ['leading-space glob segment', 'docs/ *.md'],
  ['trailing-space literal segment', 'docs/name '],
  ['trailing-space glob segment', 'docs/foo*.md '],
  ['credential JSON basename', 'credentials.json'],
  ['credential production JSON basename', 'credentials.prod.json'],
  ['secrets YAML basename', 'secrets.yaml'],
  ['secrets backup YAML basename', 'secrets.backup.yaml'],
  ['npm configuration', '.npmrc'],
  ['PyPI configuration', '.pypirc'],
  ['netrc credentials', '.netrc'],
  ['public key basename', 'id_rsa.pub'],
  ['private key extension', 'server.pem'],
  ['Windows forbidden question mark', 'src/file?.ts'],
] as const;

for (const [label, path] of rejectedPaths) {
  test(`rejects ${label}`, async () => {
    assert.equal(normalizeAllowedPath(path), null);
    const decision = await policy.evaluate(makeInput(['read'], [path]));
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCode, 'path_policy_denied');
    assert.equal(decision.reasonCode.includes(path), false);
  });
}
