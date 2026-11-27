import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertG0ReviewSetApproval,
  assertReviewIndexMatches,
  buildReferenceReviewMarkdown,
  g0Decision,
  parseArguments,
  g0ReviewSetSha256,
  G0_PROTOCOL_VERSION,
  validateReferencePatch,
} from './g0-report.mjs';

const I_IDS = Array.from({ length: 30 }, (_, index) => `I${String(index + 1).padStart(2, '0')}`);
const PATCH_A = 'a'.repeat(64);
const PATCH_B = 'b'.repeat(64);
const REVIEW_IDS = [
  'B01', 'B02', 'B03', 'B04', 'B05', 'B06',
  ...I_IDS,
  'P01', 'P02', 'P03', 'P04',
  'S01', 'S02', 'S03', 'S04',
];
const REVIEW_DIGEST_FIELDS = [
  'task_manifest_sha256',
  'snapshot_manifest_sha256',
  'snapshot_id',
  'base_snapshot_sha256',
  'oracle_sha256',
  'public_test_sha256',
  'reference_patch_sha256',
  'null_patch_sha256',
];
const REVIEW_CONTEXT = {
  protocol_version: G0_PROTOCOL_VERSION,
  baseline_id: PATCH_A,
  evaluator_fingerprint_sha256: PATCH_B,
};
const VALID_PATCH = [
  'diff --git a/src/value.mjs b/src/value.mjs',
  '--- a/src/value.mjs',
  '+++ b/src/value.mjs',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  '',
].join('\n');

function reviewRecords() {
  const fieldValues = ['a', 'b', 'c', 'd', 'e', 'f', '0', '1'];
  return REVIEW_IDS.map((task_id, taskIndex) => ({
    task_id,
    prompt: `Public prompt for ${task_id}`,
    ...Object.fromEntries(REVIEW_DIGEST_FIELDS.map((field, fieldIndex) => [
      field,
      fieldValues[fieldIndex].repeat(64),
    ])),
    task_manifest_sha256: `${String(taskIndex % 10)}${'a'.repeat(63)}`,
    snapshot_id: `${String(taskIndex % 10)}${'b'.repeat(63)}`,
  }));
}

test('G0 review-set hash binds every required digest and is order-independent', () => {
  const records = reviewRecords();
  const digest = g0ReviewSetSha256(records, REVIEW_CONTEXT);
  assert.equal(g0ReviewSetSha256([...records].reverse(), REVIEW_CONTEXT), digest);

  for (const field of REVIEW_DIGEST_FIELDS) {
    const changed = records.map((record) => ({ ...record }));
    changed[0][field] = changed[0][field] === PATCH_B ? PATCH_A : PATCH_B;
    const changedDigest = g0ReviewSetSha256(changed, REVIEW_CONTEXT);
    assert.notEqual(changedDigest, digest, `${field} must be bound to the review hash`);
    assert.throws(() => assertG0ReviewSetApproval(changedDigest, digest), /G0 review-set approval.*does not match/i);
  }

  for (const field of ['baseline_id', 'evaluator_fingerprint_sha256']) {
    const changedContext = { ...REVIEW_CONTEXT, [field]: 'c'.repeat(64) };
    assert.notEqual(g0ReviewSetSha256(records, changedContext), digest, `${field} must be bound to the review hash`);
  }
  assert.throws(() => g0ReviewSetSha256(records, {
    ...REVIEW_CONTEXT,
    protocol_version: 'changed-protocol',
  }), /protocol version/i);
});

test('G0 review-set rejects missing digest fields, missing approval, and stale approval', () => {
  const records = reviewRecords();
  const expected = g0ReviewSetSha256(records, REVIEW_CONTEXT);
  assert.doesNotThrow(() => assertG0ReviewSetApproval(expected, expected));
  assert.throws(() => assertG0ReviewSetApproval(expected, PATCH_B), /G0 review-set approval.*does not match/i);
  assert.throws(() => assertG0ReviewSetApproval(expected, undefined), /G0 review-set approval.*missing/i);

  const missingDigest = records.map((record) => ({ ...record }));
  delete missingDigest[0].oracle_sha256;
  assert.throws(() => g0ReviewSetSha256(missingDigest, REVIEW_CONTEXT), /oracle_sha256 must be a lowercase SHA-256/);
  assert.throws(() => g0ReviewSetSha256(records.slice(1), REVIEW_CONTEXT), /exactly the fixed registry tasks/);
});

test('reference patch preflight parses valid format without applying it', () => {
  assert.equal(validateReferencePatch(VALID_PATCH, ['src/**/*.mjs']), 1);
});

test('reference patch preflight rejects non-Git format and paths outside task globs', () => {
  const missingGitHeader = VALID_PATCH.replace('diff --git a/src/value.mjs b/src/value.mjs\n', '');
  assert.throws(() => validateReferencePatch(missingGitHeader, ['src/**/*.mjs']), /Expected a git-style unified diff/);

  const outsideAllowedGlob = VALID_PATCH
    .replaceAll('src/value.mjs', 'docs/value.mjs');
  assert.throws(() => validateReferencePatch(outsideAllowedGlob, ['src/**/*.mjs']), /outside the declared allowlist/);
});

test('review index links fixed case data and patches without disclosing oracle contents', () => {
  const records = reviewRecords();
  const first = records[0];
  first.prompt = 'Fix the range boundary.\nDo not use a secret | value.';
  const digest = g0ReviewSetSha256(records, REVIEW_CONTEXT);
  const markdown = buildReferenceReviewMarkdown([first], REVIEW_CONTEXT, digest);

  assert.match(markdown, /PENDING OWNER HUMAN REVIEW/);
  assert.match(markdown, /Fix the range boundary\. Do not use a secret \\\| value\./);
  assert.match(markdown, /\[public-tests\/sum-range\.test\.json\]\(\.\.\/tasks\/B01\/public-tests\/sum-range\.test\.json\)/);
  assert.match(markdown, /\[bench\/oracles\/B01\.json\]\(\.\.\/bench\/oracles\/B01\.json\)/);
  assert.match(markdown, /\[reference\.patch\]\(\.\.\/tasks\/B01\/reference\.patch\)/);
  assert.match(markdown, /G0 review-set approval SHA-256/);
  assert.match(markdown, new RegExp(G0_PROTOCOL_VERSION));
  assert.match(markdown, new RegExp(REVIEW_CONTEXT.baseline_id));
  assert.match(markdown, new RegExp(REVIEW_CONTEXT.evaluator_fingerprint_sha256));
  assert.match(markdown, new RegExp(digest));
  assert.match(markdown, /oracle_sha256/);
  for (const field of REVIEW_DIGEST_FIELDS) assert.match(markdown, new RegExp(first[field]));
  assert.doesNotMatch(markdown, /hidden assertion|diff --git/i);
});

test('G0 decision requires every null control to fail and every reference to pass', () => {
  const ids = [
    'B01', 'B02', 'B03', 'B04', 'B05', 'B06',
    ...I_IDS,
    'P01', 'P02', 'P03', 'P04',
    'S01', 'S02', 'S03', 'S04',
  ];
  assert.equal(g0Decision([
    { null_status: 'FAIL', reference_status: 'PASS' },
    { null_status: 'FAIL', reference_status: 'PASS' },
  ]), 'NO_GO');
  assert.equal(g0Decision(ids.map((task_id) => ({
    task_id,
    null_status: 'FAIL',
    null_evaluation: { public_status: 'FAIL', oracle_status: 'FAIL' },
    reference_status: 'PASS',
    reference_evaluation: { public_status: 'PASS', oracle_status: 'PASS' },
  }))), 'PASS');
  assert.equal(g0Decision(ids.map((task_id) => ({
    task_id,
    null_status: 'PASS',
    null_evaluation: { public_status: 'PASS', oracle_status: 'PASS' },
    reference_status: 'PASS',
    reference_evaluation: { public_status: 'PASS', oracle_status: 'PASS' },
  }))), 'NO_GO');
  const withNull = (nullStatus, publicStatus, referenceStatus = 'PASS') => ids.map((task_id) => ({
    task_id,
    null_status: task_id === 'I05' ? nullStatus : 'FAIL',
    null_evaluation: { public_status: task_id === 'I05' ? publicStatus : 'FAIL', oracle_status: 'FAIL' },
    reference_status: task_id === 'I05' ? referenceStatus : 'PASS',
    reference_evaluation: { public_status: 'PASS', oracle_status: 'PASS' },
  }));
  assert.equal(g0Decision(withNull('CRASH', 'CRASH')), 'PASS');
  assert.equal(g0Decision(withNull('RUNNER_FAILURE', 'RUNNER_FAILURE')), 'NO_GO');
  assert.equal(g0Decision(withNull('TIMEOUT', 'TIMEOUT')), 'NO_GO');
  assert.equal(g0Decision(withNull('CRASH', 'PASS')), 'NO_GO');
  assert.equal(g0Decision(withNull('CRASH', 'CRASH', 'CRASH')), 'NO_GO');
});

test('approved review index must match generated bytes exactly', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'g0-review-index-test-'));
  const reviewDirectory = path.join(repositoryRoot, 'bench', 'review');
  await mkdir(reviewDirectory, { recursive: true });
  try {
    const records = reviewRecords();
    const digest = g0ReviewSetSha256(records, REVIEW_CONTEXT);
    const generated = buildReferenceReviewMarkdown(records, REVIEW_CONTEXT, digest);
    const target = path.join(reviewDirectory, 'reference-patches.md');
    await writeFile(target, generated, 'utf8');
    await assertReviewIndexMatches(repositoryRoot, records, REVIEW_CONTEXT, digest);

    await writeFile(target, `${generated}\nTampered review text\n`, 'utf8');
    await assert.rejects(
      assertReviewIndexMatches(repositoryRoot, records, REVIEW_CONTEXT, digest),
      /bytes do not exactly match/i,
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('CLI requires an explicit G0 review-set hash for a real run', () => {
  assert.deepEqual(parseArguments(['--prepare-review']), { mode: 'prepare-review' });
  assert.deepEqual(parseArguments(['--run', '--approve-review-set-sha256', PATCH_A]), {
    mode: 'run',
    approvalHash: PATCH_A,
  });
  assert.throws(() => parseArguments(['--run', '--approve-reference-sha256', PATCH_A]), /Usage:/);
  assert.throws(() => parseArguments(['--run']), /Usage:/);
  assert.throws(() => parseArguments(['--run', '--source', 'model']), /Usage:/);
});
