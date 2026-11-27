import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { approvedRecordMatches, aggregateEvaluationStatus, createModelWorkspaceEvaluator } from './index.mjs';
import { applyUnifiedPatch } from './unified-diff.mjs';
import { readSnapshotManifest, restoreSnapshot, snapshotId, validateSnapshotManifest } from '../snapshots/index.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const DIGEST_FIELDS = Object.freeze([
  'task_manifest_sha256',
  'snapshot_manifest_sha256',
  'snapshot_id',
  'base_snapshot_sha256',
  'oracle_sha256',
  'public_test_sha256',
  'reference_patch_sha256',
  'null_patch_sha256',
]);

test('approved corpus comparison binds every task and input digest', () => {
  const approved = Object.fromEntries(DIGEST_FIELDS.map((field) => [field, HASH_A]));
  assert.equal(approvedRecordMatches(approved, { ...approved }), true);

  for (const field of DIGEST_FIELDS) {
    assert.equal(approvedRecordMatches(approved, { ...approved, [field]: HASH_B }), false, field);
  }
  assert.equal(approvedRecordMatches(approved, { ...approved, public_test_sha256: 'invalid' }), false);
});

test('approved snapshot comparison derives ID from the normalized manifest', () => {
  const manifest = validateSnapshotManifest({ schemaVersion: 1, files: [] });
  assert.equal(Object.hasOwn(manifest, 'snapshotId'), false);
  const expectedSnapshotId = snapshotId(manifest);
  const approved = Object.fromEntries(DIGEST_FIELDS.map((field) => [field, HASH_A]));
  approved.snapshot_id = expectedSnapshotId;
  assert.equal(approvedRecordMatches(approved, { ...approved, snapshot_id: snapshotId(manifest) }), true);
});

test('aggregate PASS requires public and oracle case sets to both pass', () => {
  assert.equal(aggregateEvaluationStatus('PASS', 'PASS'), 'PASS');
  assert.equal(aggregateEvaluationStatus('FAIL', 'PASS'), 'FAIL');
  assert.equal(aggregateEvaluationStatus('PASS', 'FAIL'), 'FAIL');
  assert.equal(aggregateEvaluationStatus('PASS', 'RUNNER_FAILURE'), 'RUNNER_FAILURE');
  assert.equal(aggregateEvaluationStatus('UNKNOWN', 'PASS'), 'RUNNER_FAILURE');
});

// Isolated model-workspace tests. They run only through `npm run test:evaluator:post-g2.2`, which
// requires a valid G2.2 attestation for the current runner fingerprint first.
async function ownerApprovedReviewSetSha256() {
  const reviewIndex = await readFile(path.join(REPOSITORY_ROOT, 'bench', 'review', 'reference-patches.md'), 'utf8');
  const match = /^G0 review-set approval SHA-256: `([a-f0-9]{64})`$/m.exec(reviewIndex);
  assert.ok(match, 'the owner review index must state the approved review-set hash');
  return match[1];
}

async function withRestoredB01Workspace(prepare, run) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-control-model-eval-test-'));
  try {
    const taskRoot = path.join(REPOSITORY_ROOT, 'bench', 'tasks', 'B01');
    const task = JSON.parse(await readFile(path.join(taskRoot, 'task.json'), 'utf8'));
    const manifest = await readSnapshotManifest(path.join(taskRoot, 'snapshot.json'));
    const workspaceRoot = path.join(scratch, 'workspace');
    await restoreSnapshot(path.join(taskRoot, 'base'), manifest, workspaceRoot, task.base_snapshot_sha256);
    await prepare({ task, taskRoot, workspaceRoot });
    return await run(workspaceRoot);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('model workspace with the B01 reference patch passes public cases and the hidden oracle', async () => {
  const evaluateWorkspace = await createModelWorkspaceEvaluator({
    repositoryRoot: REPOSITORY_ROOT,
    approvedReviewSetSha256: await ownerApprovedReviewSetSha256(),
  });
  const result = await withRestoredB01Workspace(
    async ({ task, taskRoot, workspaceRoot }) => {
      const patchText = await readFile(path.join(taskRoot, 'reference.patch'), 'utf8');
      await applyUnifiedPatch(workspaceRoot, patchText, task.allowed_globs);
    },
    (workspaceRoot) => evaluateWorkspace({ taskId: 'B01', workspaceRoot }),
  );
  assert.deepEqual(result, { status: 'PASS', public_status: 'PASS', oracle_status: 'PASS' });
});

test('unmodified B01 base workspace fails the public cases', async () => {
  const evaluateWorkspace = await createModelWorkspaceEvaluator({
    repositoryRoot: REPOSITORY_ROOT,
    approvedReviewSetSha256: await ownerApprovedReviewSetSha256(),
  });
  const result = await withRestoredB01Workspace(
    async () => {},
    (workspaceRoot) => evaluateWorkspace({ taskId: 'B01', workspaceRoot }),
  );
  assert.equal(result.public_status, 'FAIL');
  assert.equal(result.status, 'FAIL');
});
