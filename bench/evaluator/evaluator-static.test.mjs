import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  approvedRecordMatches,
  aggregateEvaluationStatus,
  createModelWorkspaceEvaluator,
  isExpectedNullControlFailure,
} from './index.mjs';
import {
  G2_ISOLATION_EVIDENCE_RELATIVE_PATH,
  G2_ISOLATION_REQUIRED_CHECKS,
  validateG2IsolationAttestation,
} from './isolation-attestation.mjs';
import { PUBLIC_TEST_REGISTRY } from './public-test-registry.mjs';
import { registeredOraclePath } from './oracle-runner.mjs';
import { getRuntimeFingerprint, RUNTIME_FINGERPRINT_FILES } from './runtime-fingerprint.mjs';
import { parseCaseData } from './case-data.mjs';
import { buildReferenceReviewMarkdown, loadCorpus, readApprovalContext } from './g0-report.mjs';
import { g0ReviewSetSha256 } from './g0-review-contract.mjs';
import { readSnapshotManifest, restoreSnapshot } from '../snapshots/index.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function validAttestation() {
  return {
    schema_version: 1,
    status: 'PASS',
    verified_at: '2026-10-24T14:16:45.578Z',
    platform: 'win32',
    baseline_sha256: HASH_A,
    runner_sha256: HASH_B,
    mechanism: 'Windows Job Object and restricted token',
    checks: Object.fromEntries(G2_ISOLATION_REQUIRED_CHECKS.map((check) => [check, true])),
  };
}

test('approved task digest helper rejects any changed or malformed digest', () => {
  const approved = Object.fromEntries([
    'task_manifest_sha256', 'snapshot_manifest_sha256', 'snapshot_id', 'base_snapshot_sha256',
    'oracle_sha256', 'public_test_sha256', 'reference_patch_sha256', 'null_patch_sha256',
  ].map((field) => [field, HASH_A]));
  assert.equal(approvedRecordMatches(approved, { ...approved }), true);
  assert.equal(approvedRecordMatches(approved, { ...approved, oracle_sha256: HASH_B }), false);
  assert.equal(approvedRecordMatches(approved, { ...approved, snapshot_id: 'not-a-hash' }), false);
});

test('aggregate PASS requires both public test and hidden oracle to pass', () => {
  assert.equal(aggregateEvaluationStatus('PASS', 'PASS'), 'PASS');
  assert.equal(aggregateEvaluationStatus('FAIL', 'PASS'), 'FAIL');
  assert.equal(aggregateEvaluationStatus('PASS', 'FAIL'), 'FAIL');
  assert.equal(aggregateEvaluationStatus('PASS', 'RUNNER_FAILURE'), 'RUNNER_FAILURE');
  assert.equal(aggregateEvaluationStatus('UNKNOWN', 'PASS'), 'RUNNER_FAILURE');
});

test('a null control counts as failing as expected only for FAIL or CRASH', () => {
  assert.equal(isExpectedNullControlFailure('FAIL'), true);
  assert.equal(isExpectedNullControlFailure('CRASH'), true);
  for (const status of ['PASS', 'RUNNER_FAILURE', 'TIMEOUT', 'POLICY_VIOLATION', 'UNKNOWN', undefined, null, '']) {
    assert.equal(isExpectedNullControlFailure(status), false, String(status));
  }
});

test('G2.2 attestation requires every isolation check and current hashes', () => {
  const expected = { platform: 'win32', baseline_sha256: HASH_A, runner_sha256: HASH_B };
  assert.doesNotThrow(() => validateG2IsolationAttestation(validAttestation(), expected));

  for (const check of G2_ISOLATION_REQUIRED_CHECKS) {
    const changed = validAttestation();
    changed.checks[check] = false;
    assert.throws(() => validateG2IsolationAttestation(changed, expected), new RegExp(check));
  }

  const staleRunner = validAttestation();
  staleRunner.runner_sha256 = 'c'.repeat(64);
  assert.throws(() => validateG2IsolationAttestation(staleRunner, expected), /runner_sha256.*current/i);
  const extraField = { ...validAttestation(), note: 'unreviewed' };
  assert.throws(() => validateG2IsolationAttestation(extraField, expected), /undeclared fields/i);
});

test('hidden oracle path comes only from the fixed task registry', () => {
  assert.match(registeredOraclePath('P01'), /bench[\\/]oracles[\\/]P01\.json$/);
  assert.throws(() => registeredOraclePath('P99'), /fixed-registry/i);
});

test('production G0 evaluator rejects model first and requires authorization and current G2.2 before task lookup', async () => {
  const evaluatorPath = path.join(REPOSITORY_ROOT, 'bench/evaluator/index.mjs');
  const evaluatorSource = await readFile(evaluatorPath, 'utf8');
  const modelGuardIndex = evaluatorSource.indexOf("if (input?.source === 'model')");
  const authorizationGuardIndex = evaluatorSource.indexOf('if (!authorized) return detailResult');
  const gateIndex = evaluatorSource.indexOf('await readG2IsolationAttestation(root);');
  const failClosedIndex = evaluatorSource.indexOf("return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');", gateIndex);
  const taskLookupIndex = evaluatorSource.indexOf('const taskId = input?.taskId;');

  assert.ok(modelGuardIndex >= 0 && modelGuardIndex < authorizationGuardIndex
    && authorizationGuardIndex < taskLookupIndex, 'model must be refused before authorization/task lookup');
  assert.ok(authorizationGuardIndex < gateIndex && gateIndex < failClosedIndex && failClosedIndex < taskLookupIndex,
    'authorization and current G2.2 evidence must fail closed before task lookup');
  assert.match(evaluatorSource, /function createApprovedG0Evaluator/);
  assert.doesNotMatch(evaluatorSource, /export function createApprovedG0Evaluator/);
  assert.match(evaluatorSource, /reviewAuthorization\.reviewSetSha256 === reviewAuthorization\.suppliedReviewSetSha256/);
  assert.match(evaluatorSource, /reviewAuthorization\.reviewSetSha256 === computedReviewSetSha256/);
  assert.match(evaluatorSource, /runHostCases/);
  assert.match(evaluatorSource, /createIsolatedWorkerRunner/);
  assert.match(evaluatorSource, /authorizeWorkspace:/);
  assert.match(evaluatorSource, /loadCaseData/);
  assert.match(evaluatorSource, /approvedRecordMatches\(approvedRecord, currentApprovedDigests\)/);
  assert.match(evaluatorSource, /const actualSnapshotId = snapshotId\(snapshotManifest\)/);
  assert.doesNotMatch(evaluatorSource, /testOnly|createDetailedEvaluator|createEvaluator|export const evaluateTask/);
  assert.doesNotMatch(evaluatorSource, /node:child_process|--test|runPublicTest|runOracleTest/);

  const oracleSource = await readFile(path.join(REPOSITORY_ROOT, 'bench/evaluator/oracle-runner.mjs'), 'utf8');
  assert.match(oracleSource, /registeredOraclePath/);
  assert.doesNotMatch(oracleSource, /readG2IsolationAttestation|\bverify\s*\(|import\s*\(/);

  const g0Source = await readFile(path.join(REPOSITORY_ROOT, 'bench/evaluator/g0-report.mjs'), 'utf8');
  const runSource = await readFile(evaluatorPath, 'utf8');
  const approvedLoadIndex = runSource.indexOf('const corpus = await loadCorpus(repositoryRoot);');
  const approvedHashIndex = runSource.indexOf('assertG0ReviewSetApproval(postApprovalReviewSetSha256, approvalHash);');
  const factoryIndex = runSource.indexOf('const evaluateTask = createApprovedG0Evaluator({');
  assert.ok(approvedLoadIndex >= 0 && approvedHashIndex > approvedLoadIndex && factoryIndex > approvedHashIndex,
    'the private evaluator closure must be created only after CLI approval of the loaded corpus');
  assert.equal((runSource.match(/const evaluateTask = createApprovedG0Evaluator\(\{/g) ?? []).length, 1,
    'only the private G0 CLI run may create the production evaluator');
  assert.match(runSource, /async function runG0\(repositoryRoot, approvalHash\)/);
  assert.doesNotMatch(runSource, /export\s+(?:async\s+)?function\s+(?:runG0|createApprovedG0Evaluator)/);
  assert.match(g0Source, /g0ReviewSetSha256/);
  assert.match(g0Source, /G0_PROTOCOL_VERSION/);
  assert.match(g0Source, /validateCaseDataDocument/);
  assert.match(g0Source, /parseCaseData\(bytes, relativePath\)/);
  assert.match(runSource, /approvedRecords: corpus/);
  assert.match(runSource, /suppliedReviewSetSha256: approvalHash/);
  assert.match(runSource, /assertReviewIndexMatches\(repositoryRoot, corpus, context, reviewSetSha256\)/);
  assert.match(runSource, /await assertApprovedStateUnchanged\(repositoryRoot, corpus, context, reviewSetSha256, approvalHash\);[\s\S]*?const json =/);
  assert.match(g0Source, /reviewIndex\.bytes\.equals\(expected\)/);
});

test('fixed declarative case data is validated and fingerprinted without module imports', async () => {
  const entries = Object.entries(PUBLIC_TEST_REGISTRY);
  assert.equal(entries.length, 44, 'the fixed case registry must cover all benchmark tasks');
  assert.ok(RUNTIME_FINGERPRINT_FILES.includes('bench/evaluator/host-harness.mjs'));
  for (const runtimePath of [
    'bench/isolation/host-runner.mjs',
    'bench/isolation/protocol.mjs',
    'bench/isolation/task-operations.mjs',
    'bench/isolation/run-worker.ps1',
    'bench/isolation/probe-contract.mjs',
    'bench/isolation/probe-contract.test.mjs',
    'bench/isolation/AppContainerLauncher.cs',
    'src/snapshots/snapshot-core.mjs',
    'bench/evaluator/case-data.mjs',
    'bench/evaluator/g0-review-contract.mjs',
  ]) {
    assert.ok(RUNTIME_FINGERPRINT_FILES.includes(runtimePath), runtimePath + ' must be fingerprinted');
  }

  for (const [taskId, entry] of entries) {
    assert.equal(entry.oracleRelativePath, `bench/oracles/${taskId}.json`);
    const publicPath = ['bench/tasks', taskId, entry.relativePath].join('/');
    const paths = [publicPath, entry.oracleRelativePath];
    for (const relativePath of paths) {
      assert.ok(RUNTIME_FINGERPRINT_FILES.includes(relativePath), relativePath + ' must be fingerprinted');
      const source = await readFile(path.join(REPOSITORY_ROOT, relativePath));
      const document = JSON.parse(source.toString('utf8'));
      assert.equal(document.schemaVersion, 1, relativePath + ' must use the declarative case schema');
      assert.ok(Array.isArray(parseCaseData(source, relativePath)), relativePath + ' must parse without executing source');
      await assert.rejects(
        readFile(path.join(REPOSITORY_ROOT, relativePath.replace(/\.json$/, '.mjs'))),
        { code: 'ENOENT' },
        relativePath + ' must not leave an executable legacy case module',
      );
    }
  }
});

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const next = source.slice(start + signature.length).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? source.slice(start) : source.slice(start, start + signature.length + next);
}

test('G0 closure still refuses source=model first and both paths use the shared helpers', async () => {
  const source = await readFile(path.join(REPOSITORY_ROOT, 'bench/evaluator/index.mjs'), 'utf8');
  const g0Factory = functionSource(source, 'function createApprovedG0Evaluator({');
  const modelFactory = functionSource(source, 'export async function createModelWorkspaceEvaluator({');
  const runSource = functionSource(source, 'async function runG0(repositoryRoot, approvalHash) {');

  const closureStart = g0Factory.indexOf('return async function evaluateTask(input) {');
  assert.ok(closureStart >= 0);
  const firstStatement = g0Factory.slice(closureStart).split('\n')[1].trim();
  assert.equal(firstStatement, "if (input?.source === 'model') return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');");

  for (const helper of [
    'createReviewAuthorization(',
    'assertIsolationMatchesAuthorization(',
    'loadApprovedTask(',
    'assertChangesWithinTaskPolicy(',
    'assertProtectedUnchanged(',
    'runApprovedCaseSets(',
    'failureResult(',
    'removeScratchDirectory(',
  ]) {
    assert.ok(g0Factory.includes(helper), `G0 path must call ${helper}`);
    assert.ok(modelFactory.includes(helper), `model path must call ${helper}`);
  }
  assert.ok(runSource.includes('await loadApprovedReviewState('), 'runG0 must use the shared approval loader');
  assert.ok(modelFactory.includes('await loadApprovedReviewState('), 'model path must use the shared approval loader');
  assert.ok(modelFactory.includes('await readG2IsolationAttestation(root);'), 'model path must read G2.2 on every call');
  assert.doesNotMatch(modelFactory, /createApprovedG0Evaluator|\.source\b|applyUnifiedPatch/);
});

const POLICY_VIOLATION = Object.freeze({
  status: 'POLICY_VIOLATION',
  public_status: 'POLICY_VIOLATION',
  oracle_status: 'POLICY_VIOLATION',
});

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

let fixturePromise;
const scratchDirectories = [];

// A disposable repository copy with a synthetic baseline, a G2.2 attestation for that copy's own
// fingerprint, and a matching review index. The real repository's runtime state is never touched.
async function modelFixture() {
  fixturePromise ??= (async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-control-model-static-'));
    scratchDirectories.push(root);
    for (const relativePath of RUNTIME_FINGERPRINT_FILES) {
      const destination = path.join(root, ...relativePath.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(REPOSITORY_ROOT, ...relativePath.split('/')), destination);
    }
    await cp(path.join(REPOSITORY_ROOT, 'bench', 'tasks'), path.join(root, 'bench', 'tasks'), { recursive: true });
    const baselineBytes = Buffer.from('{"fixture":"model-workspace-static"}\n', 'utf8');
    await mkdir(path.join(root, 'runtime', 'diagnostics'), { recursive: true });
    await writeFile(path.join(root, 'runtime', 'diagnostics', 'hardware-baseline.json'), baselineBytes);
    const runtime = await getRuntimeFingerprint(root);
    const attestation = {
      ...validAttestation(),
      baseline_sha256: sha256Hex(baselineBytes),
      runner_sha256: runtime.sha256,
    };
    await writeFile(
      path.join(root, ...G2_ISOLATION_EVIDENCE_RELATIVE_PATH.split('/')),
      `${JSON.stringify(attestation, null, 2)}\n`,
    );
    const { context } = await readApprovalContext(root);
    const corpus = await loadCorpus(root);
    const reviewSetSha256 = g0ReviewSetSha256(corpus, context);
    await mkdir(path.join(root, 'bench', 'review'), { recursive: true });
    await writeFile(
      path.join(root, 'bench', 'review', 'reference-patches.md'),
      buildReferenceReviewMarkdown(corpus, context, reviewSetSha256),
    );
    const evaluateWorkspace = await createModelWorkspaceEvaluator({
      repositoryRoot: root,
      approvedReviewSetSha256: reviewSetSha256,
    });
    return { root, reviewSetSha256, evaluateWorkspace };
  })();
  return fixturePromise;
}

async function restoredB01Workspace(root) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-control-model-workspace-'));
  scratchDirectories.push(scratch);
  const taskRoot = path.join(root, 'bench', 'tasks', 'B01');
  const task = JSON.parse(await readFile(path.join(taskRoot, 'task.json'), 'utf8'));
  const manifest = await readSnapshotManifest(path.join(taskRoot, 'snapshot.json'));
  const workspaceRoot = path.join(scratch, 'workspace');
  await restoreSnapshot(path.join(taskRoot, 'base'), manifest, workspaceRoot, task.base_snapshot_sha256);
  return workspaceRoot;
}

test.after(async () => {
  for (const directory of scratchDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

const windowsOnly = { skip: process.platform !== 'win32' && 'the G2.2 attestation is Windows-only' };

test('model workspace evaluator refuses a missing, malformed, or wrong review-set hash', windowsOnly, async () => {
  const { root, reviewSetSha256 } = await modelFixture();
  for (const approvedReviewSetSha256 of [undefined, null, 42, '', 'a'.repeat(63), 'A'.repeat(64), ` ${reviewSetSha256}`, reviewSetSha256.toUpperCase()]) {
    await assert.rejects(
      createModelWorkspaceEvaluator({ repositoryRoot: root, approvedReviewSetSha256 }),
      /owner-approved lowercase SHA-256/,
      String(approvedReviewSetSha256),
    );
  }
  const wrong = reviewSetSha256 === 'c'.repeat(64) ? 'd'.repeat(64) : 'c'.repeat(64);
  await assert.rejects(
    createModelWorkspaceEvaluator({ repositoryRoot: root, approvedReviewSetSha256: wrong }),
    /review-set approval is missing or does not match/,
  );
  await assert.rejects(createModelWorkspaceEvaluator(), /owner-approved lowercase SHA-256/);
});

test('model workspace evaluator returns POLICY_VIOLATION for an unknown task or an unsafe workspace path', windowsOnly, async () => {
  const { root, evaluateWorkspace } = await modelFixture();
  const workspaceRoot = await restoredB01Workspace(root);
  for (const taskId of ['P99', 'Z01', 'b01', '', undefined, 7]) {
    assert.deepEqual(await evaluateWorkspace({ taskId, workspaceRoot }), POLICY_VIOLATION, String(taskId));
  }
  for (const candidate of [undefined, 'relative/workspace', path.join(root, 'bench', 'tasks', 'B01', 'base'), root]) {
    assert.deepEqual(await evaluateWorkspace({ taskId: 'B01', workspaceRoot: candidate }), POLICY_VIOLATION, String(candidate));
  }
  assert.deepEqual(await evaluateWorkspace(undefined), POLICY_VIOLATION);
});

test('model workspace evaluator returns POLICY_VIOLATION for a changed file outside the task globs', windowsOnly, async () => {
  const { root, evaluateWorkspace } = await modelFixture();
  const workspaceRoot = await restoredB01Workspace(root);
  await writeFile(path.join(workspaceRoot, 'notes.txt'), 'outside the allowed globs\n');
  assert.deepEqual(await evaluateWorkspace({ taskId: 'B01', workspaceRoot }), POLICY_VIOLATION);
});

test('model workspace evaluator returns POLICY_VIOLATION when too many files change', windowsOnly, async () => {
  const { root, evaluateWorkspace } = await modelFixture();
  const workspaceRoot = await restoredB01Workspace(root);
  const target = path.join(workspaceRoot, 'src', 'sum-range.mjs');
  await writeFile(target, (await readFile(target, 'utf8')).replace('index < end', 'index <= end'));
  await writeFile(path.join(workspaceRoot, 'src', 'extra.mjs'), 'export const extra = 1;\n');
  assert.deepEqual(await evaluateWorkspace({ taskId: 'B01', workspaceRoot }), POLICY_VIOLATION);
});

const RUNNER_FAILURE = Object.freeze({
  status: 'RUNNER_FAILURE',
  public_status: 'RUNNER_FAILURE',
  oracle_status: 'RUNNER_FAILURE',
});

// Points the temp directory at a path that does not exist, so the evaluator's base-restore mkdtemp
// fails with an ordinary error (RUNNER_FAILURE). A POLICY_VIOLATION under this guard therefore comes
// from a check that ran before the base restore, and no case can ever run.
async function withMissingTempDirectory(callback) {
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-control-model-missing-temp-'));
  scratchDirectories.push(scratch);
  const missing = path.join(scratch, 'does-not-exist');
  process.env.TEMP = missing;
  process.env.TMP = missing;
  process.env.TMPDIR = missing;
  try {
    assert.equal(os.tmpdir(), missing);
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('model workspace evaluator lets a clean workspace past the link check', windowsOnly, async () => {
  const { root, evaluateWorkspace } = await modelFixture();
  const workspaceRoot = await restoredB01Workspace(root);
  // Past the link check, an unchanged workspace reaches the base restore; with no temp directory it
  // stops there as RUNNER_FAILURE, before any case runs.
  assert.deepEqual(
    await withMissingTempDirectory(() => evaluateWorkspace({ taskId: 'B01', workspaceRoot })),
    RUNNER_FAILURE,
  );
  // With a normal temp directory, a clean but out-of-policy workspace fails later, at the change policy.
  await writeFile(path.join(workspaceRoot, 'notes.txt'), 'outside the allowed globs\n');
  assert.deepEqual(await evaluateWorkspace({ taskId: 'B01', workspaceRoot }), POLICY_VIOLATION);
});

test('model workspace evaluator returns POLICY_VIOLATION for a hard-linked file before any case run', windowsOnly, async () => {
  const { root, evaluateWorkspace } = await modelFixture();
  const workspaceRoot = await restoredB01Workspace(root);
  // The workspace content stays byte-identical to the base; only the link count of one file changes.
  await link(path.join(workspaceRoot, 'src', 'sum-range.mjs'), path.join(path.dirname(workspaceRoot), 'outside-link.mjs'));
  assert.deepEqual(
    await withMissingTempDirectory(() => evaluateWorkspace({ taskId: 'B01', workspaceRoot })),
    POLICY_VIOLATION,
  );
});

test('model workspace evaluator returns POLICY_VIOLATION for a junction or symlink before any case run', windowsOnly, async (t) => {
  const { root, evaluateWorkspace } = await modelFixture();

  const junctionWorkspace = await restoredB01Workspace(root);
  const junctionTarget = path.join(path.dirname(junctionWorkspace), 'junction-target');
  await mkdir(junctionTarget);
  let junctionCreated = true;
  try {
    await symlink(junctionTarget, path.join(junctionWorkspace, 'src', 'linked-dir'), 'junction');
  } catch {
    junctionCreated = false;
    t.diagnostic('skipped the junction case: this OS refused to create a junction');
  }
  if (junctionCreated) {
    assert.deepEqual(
      await withMissingTempDirectory(() => evaluateWorkspace({ taskId: 'B01', workspaceRoot: junctionWorkspace })),
      POLICY_VIOLATION,
    );
  }

  const symlinkWorkspace = await restoredB01Workspace(root);
  const symlinkTarget = path.join(path.dirname(symlinkWorkspace), 'symlink-target.mjs');
  await writeFile(symlinkTarget, 'export const target = 1;\n');
  let symlinkCreated = true;
  try {
    await symlink(symlinkTarget, path.join(symlinkWorkspace, 'src', 'linked-file.mjs'), 'file');
  } catch {
    symlinkCreated = false;
    t.diagnostic('skipped the file symlink case: this OS refused to create a symlink (needs Developer Mode or the privilege)');
  }
  if (symlinkCreated) {
    assert.deepEqual(
      await withMissingTempDirectory(() => evaluateWorkspace({ taskId: 'B01', workspaceRoot: symlinkWorkspace })),
      POLICY_VIOLATION,
    );
  }
  if (!junctionCreated && !symlinkCreated) t.skip('this OS refused to create both a junction and a symlink');
});
