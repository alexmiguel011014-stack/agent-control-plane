import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createIsolatedWorkerRunner, IsolatedWorkerError } from '../isolation/host-runner.mjs';
import {
  createSnapshotManifest,
  restoreSnapshot,
  snapshotId,
  validateSnapshotManifest,
  verifySnapshot,
} from '../snapshots/index.mjs';
import { TaskManifestValidationError, validateTaskManifest } from './schema/task-manifest.mjs';
import { PUBLIC_TEST_REGISTRY } from './public-test-registry.mjs';
import { readG2IsolationAttestation } from './isolation-attestation.mjs';
import { runHostCases } from './host-harness.mjs';
import {
  assertApprovedStateUnchanged,
  assertG0ReviewSetApproval,
  assertReviewIndexMatches,
  atomicWrite,
  g0Decision,
  isExpectedNullControlFailure,
  loadCorpus,
  parseArguments,
  readApprovalContext,
  readJunctionEvidence,
} from './g0-report.mjs';
import { G0_PROTOCOL_VERSION, G0_REVIEW_DIGEST_FIELDS, g0ReviewSetSha256 } from './g0-review-contract.mjs';
import { registeredOraclePath } from './oracle-runner.mjs';

export { isExpectedNullControlFailure };
import { parseCaseData } from './case-data.mjs';
import {
  applyUnifiedPatch,
  matchesPathGlobs,
  PatchFormatError,
  PatchPolicyError,
} from './unified-diff.mjs';

const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TASK_ID_PATTERN = /^[PBIS][0-9]{2}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TASK_IDS = Object.keys(PUBLIC_TEST_REGISTRY).sort();
const APPROVED_DIGEST_FIELDS = G0_REVIEW_DIGEST_FIELDS;
const RESULT_STATUSES = new Set([
  'PASS',
  'FAIL',
  'POLICY_VIOLATION',
  'TIMEOUT',
  'CRASH',
  'RUNNER_FAILURE',
]);
class PolicyViolation extends Error {
  constructor() {
    super('Evaluation policy violation');
    this.name = 'PolicyViolation';
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isSamePath(left, right) {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function assertOrdinaryDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new PolicyViolation();
  return realpath(directory);
}

// Model-workspace only: every entry under the supplied root must be an ordinary directory or a
// regular file with a single link. Links are never followed, so a hard link, symlink, junction, or
// other special entry cannot make a later ACL change or read reach a file outside the workspace.
async function assertOnlyUnlinkedOrdinaryEntries(directory) {
  for (const entry of await readdir(directory)) {
    const entryPath = path.join(directory, entry);
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) throw new PolicyViolation();
    if (info.isDirectory()) {
      await assertOnlyUnlinkedOrdinaryEntries(entryPath);
    } else if (!info.isFile() || info.nlink !== 1) {
      throw new PolicyViolation();
    }
  }
}

async function readOrdinaryFileUnder(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const realRoot = await assertOrdinaryDirectory(absoluteRoot);
  const parts = relativePath.split('/');
  let current = absoluteRoot;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    const isFile = index === parts.length - 1;
    if (info.isSymbolicLink() || (isFile ? !info.isFile() : !info.isDirectory())) {
      throw new PolicyViolation();
    }
    const resolved = await realpath(current);
    if (!isWithin(realRoot, resolved)) throw new PolicyViolation();
  }

  return { absolutePath: current, bytes: await readFile(current) };
}

async function assertNoTaskLocalOracleDirectories(taskDirectory) {
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.toLowerCase() === 'oracle') throw new PolicyViolation();
      const childPath = path.join(directory, entry.name);
      const info = await lstat(childPath);
      if (info.isSymbolicLink()) throw new PolicyViolation();
      if (info.isDirectory()) await visit(childPath);
    }
  }
  await visit(taskDirectory);
}

async function protectedHashes(repositoryRoot, taskId, taskDirectory, registryTestPath, oracleRelativePath) {
  const hashes = new Map();
  const protectedFiles = [
    `bench/tasks/${taskId}/task.json`,
    `bench/tasks/${taskId}/snapshot.json`,
    `bench/tasks/${taskId}/null.patch`,
    `bench/tasks/${taskId}/reference.patch`,
  ];

  for (const relativePath of protectedFiles) {
    const file = await readOrdinaryFileUnder(repositoryRoot, relativePath);
    hashes.set(relativePath, sha256(file.bytes));
  }

  const taskRelative = path.relative(repositoryRoot, taskDirectory).split(path.sep).join('/');
  const testRelative = path.relative(taskDirectory, registryTestPath).split(path.sep).join('/');
  const testFile = await readOrdinaryFileUnder(taskDirectory, testRelative);
  hashes.set(`${taskRelative}/${testRelative}`, sha256(testFile.bytes));

  const globalOracle = oracleRelativePath;
  await assertNoTaskLocalOracleDirectories(taskDirectory);
  let oracleFile;
  try {
    oracleFile = await readOrdinaryFileUnder(repositoryRoot, globalOracle);
  } catch {
    throw new PolicyViolation();
  }
  hashes.set(globalOracle, sha256(oracleFile.bytes));
  return hashes;
}

function sameHashes(left, right) {
  if (left.size !== right.size) return false;
  for (const [filePath, digest] of left) {
    if (right.get(filePath) !== digest) return false;
  }
  return true;
}

export function approvedRecordMatches(approved, current) {
  return APPROVED_DIGEST_FIELDS.every((field) => HASH_PATTERN.test(approved?.[field] ?? '')
    && approved[field] === current?.[field]);
}

function copyApprovedRecords(records) {
  if (!Array.isArray(records) || records.length !== TASK_IDS.length) {
    throw new Error('G0 evaluator requires the exact approved 20-task corpus');
  }
  const byTask = new Map();
  for (const record of records) {
    if (!record || typeof record.task_id !== 'string' || !TASK_IDS.includes(record.task_id) || byTask.has(record.task_id)) {
      throw new Error('G0 evaluator received an invalid approved task record');
    }
    const copied = { task_id: record.task_id };
    for (const field of APPROVED_DIGEST_FIELDS) {
      if (!HASH_PATTERN.test(record[field] ?? '')) throw new Error(`G0 evaluator received an invalid ${field}`);
      copied[field] = record[field];
    }
    byTask.set(record.task_id, Object.freeze(copied));
  }
  if (TASK_IDS.some((taskId) => !byTask.has(taskId))) {
    throw new Error('G0 evaluator received an incomplete approved task set');
  }
  return byTask;
}

function changedPaths(beforeManifest, afterManifest) {
  const before = new Map(beforeManifest.files.map((file) => [file.path, file.sha256]));
  const after = new Map(afterManifest.files.map((file) => [file.path, file.sha256]));
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  return [...allPaths]
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .sort();
}

function validateRegistryEntry(taskId, task) {
  const entry = PUBLIC_TEST_REGISTRY[taskId];
  if (!entry || task.public_test_command_id !== entry.commandId) throw new PolicyViolation();
  if (typeof entry.relativePath !== 'string' || entry.relativePath.startsWith('/') || entry.relativePath.includes('\\')) {
    throw new PolicyViolation();
  }
  const parts = entry.relativePath.split('/');
  if (parts.length !== 2 || parts[0] !== 'public-tests' || !/^[A-Za-z0-9_.-]+\.json$/.test(parts[1])) {
    throw new PolicyViolation();
  }
  if (entry.oracleRelativePath !== `bench/oracles/${taskId}.json`) throw new PolicyViolation();
  return entry;
}

async function loadCaseData(repositoryRoot, relativePath, expectedHash) {
  let file;
  try {
    file = await readOrdinaryFileUnder(repositoryRoot, relativePath);
  } catch {
    throw new PolicyViolation();
  }
  if (sha256(file.bytes) !== expectedHash) throw new PolicyViolation();
  try {
    return parseCaseData(file.bytes, relativePath);
  } catch {
    throw new PolicyViolation();
  }
}

function workerFailureStatus(error) {
  if (!(error instanceof IsolatedWorkerError)) return 'RUNNER_FAILURE';
  if (error.code === 'timeout') return 'TIMEOUT';
  if (error.code === 'worker_exit_unverified') return 'CRASH';
  return 'RUNNER_FAILURE';
}

async function evaluateCases({ caseRunner, cases, taskId, workspaceRoot, timeoutMs, workerRunner }) {
  try {
    const report = await caseRunner({ cases, taskId, workspaceRoot, timeoutMs, workerRunner });
    if (!report || typeof report.passed !== 'boolean') return 'RUNNER_FAILURE';
    return report.passed ? 'PASS' : 'FAIL';
  } catch (error) {
    return workerFailureStatus(error);
  }
}

function createWorkspaceAuthorizer(taskId, expectedWorkspaceRoot) {
  return async ({ taskId: requestedTaskId, workspaceRoot: requestedWorkspaceRoot }) => {
    if (requestedTaskId !== taskId || !isSamePath(requestedWorkspaceRoot, expectedWorkspaceRoot)) return false;
    try {
      const canonical = await assertOrdinaryDirectory(expectedWorkspaceRoot);
      return isSamePath(canonical, expectedWorkspaceRoot);
    } catch {
      return false;
    }
  };
}

export function aggregateEvaluationStatus(publicStatus, oracleStatus) {
  if (!RESULT_STATUSES.has(publicStatus) || !RESULT_STATUSES.has(oracleStatus)) return 'RUNNER_FAILURE';
  return publicStatus === 'PASS' ? oracleStatus : publicStatus;
}

function detailResult(publicStatus, oracleStatus) {
  return {
    status: aggregateEvaluationStatus(publicStatus, oracleStatus),
    public_status: publicStatus,
    oracle_status: oracleStatus,
  };
}

// Shared by the G0 closure and the model-workspace closure: binds the closure to the exact approved
// corpus, baseline, and evaluator fingerprint. Neither closure can be created without it.
function createReviewAuthorization(approvedByTask, authorization) {
  const reviewAuthorization = Object.freeze({
    reviewSetSha256: authorization?.reviewSetSha256,
    suppliedReviewSetSha256: authorization?.suppliedReviewSetSha256,
    baselineId: authorization?.baselineId,
    evaluatorFingerprintSha256: authorization?.evaluatorFingerprintSha256,
  });
  const computedReviewSetSha256 = g0ReviewSetSha256([...approvedByTask.values()], {
    protocol_version: G0_PROTOCOL_VERSION,
    baseline_id: reviewAuthorization.baselineId,
    evaluator_fingerprint_sha256: reviewAuthorization.evaluatorFingerprintSha256,
  });
  const authorized = HASH_PATTERN.test(reviewAuthorization.reviewSetSha256 ?? '')
    && reviewAuthorization.reviewSetSha256 === reviewAuthorization.suppliedReviewSetSha256
    && reviewAuthorization.reviewSetSha256 === computedReviewSetSha256
    && HASH_PATTERN.test(reviewAuthorization.baselineId ?? '')
    && HASH_PATTERN.test(reviewAuthorization.evaluatorFingerprintSha256 ?? '');
  return { reviewAuthorization, authorized };
}

// Shared attestation check: the current G2.2 attestation must bind the approved baseline and runner.
function assertIsolationMatchesAuthorization(isolation, reviewAuthorization) {
  if (isolation.baseline_sha256 !== reviewAuthorization.baselineId
    || isolation.runner.sha256 !== reviewAuthorization.evaluatorFingerprintSha256) {
    throw new PolicyViolation();
  }
}

// Shared task and manifest loading plus protected-hash capture. Every input is checked against the
// approved record before any workspace is touched.
async function loadApprovedTask(root, taskId, approvedRecord) {
  const realRepositoryRoot = await assertOrdinaryDirectory(root);
  const taskDirectoryRelative = `bench/tasks/${taskId}`;
  const taskDirectory = path.join(root, ...taskDirectoryRelative.split('/'));
  const realTaskDirectory = await assertOrdinaryDirectory(taskDirectory);
  if (!isWithin(realRepositoryRoot, realTaskDirectory)) throw new PolicyViolation();

  const taskFile = await readOrdinaryFileUnder(root, `${taskDirectoryRelative}/task.json`);
  if (sha256(taskFile.bytes) !== approvedRecord.task_manifest_sha256) throw new PolicyViolation();
  const task = validateTaskManifest(JSON.parse(taskFile.bytes.toString('utf8')));
  if (task.task_id !== taskId) throw new PolicyViolation();
  if (!task.allowed_operations.includes('apply_unified_diff')
    || !task.allowed_operations.includes('run_declared_test')) {
    throw new PolicyViolation();
  }
  const testCommand = validateRegistryEntry(taskId, task);
  const testPath = path.join(taskDirectory, ...testCommand.relativePath.split('/'));
  const testRelative = path.relative(taskDirectory, testPath);
  if (!isWithin(taskDirectory, testPath) || testRelative.startsWith('..')) throw new PolicyViolation();

  const snapshotFile = await readOrdinaryFileUnder(root, `${taskDirectoryRelative}/snapshot.json`);
  if (sha256(snapshotFile.bytes) !== approvedRecord.snapshot_manifest_sha256
    || snapshotFile.bytes.length > 1024 * 1024
    || task.base_snapshot_sha256 !== approvedRecord.base_snapshot_sha256) throw new PolicyViolation();
  let snapshotManifest;
  try {
    snapshotManifest = validateSnapshotManifest(JSON.parse(snapshotFile.bytes.toString('utf8')));
  } catch {
    throw new PolicyViolation();
  }
  const actualSnapshotId = snapshotId(snapshotManifest);
  if (actualSnapshotId !== approvedRecord.snapshot_id) throw new PolicyViolation();
  const baseDirectory = path.join(taskDirectory, 'base');
  try {
    await verifySnapshot(baseDirectory, snapshotManifest, task.base_snapshot_sha256);
  } catch {
    throw new PolicyViolation();
  }
  const beforeProtected = await protectedHashes(
    root,
    taskId,
    taskDirectory,
    testPath,
    testCommand.oracleRelativePath,
  );
  const publicCasesPath = `${taskDirectoryRelative}/${testCommand.relativePath}`;
  const currentApprovedDigests = {
    task_manifest_sha256: beforeProtected.get(`${taskDirectoryRelative}/task.json`),
    snapshot_manifest_sha256: beforeProtected.get(`${taskDirectoryRelative}/snapshot.json`),
    snapshot_id: actualSnapshotId,
    base_snapshot_sha256: task.base_snapshot_sha256,
    oracle_sha256: beforeProtected.get(testCommand.oracleRelativePath),
    public_test_sha256: beforeProtected.get(publicCasesPath),
    reference_patch_sha256: beforeProtected.get(`${taskDirectoryRelative}/reference.patch`),
    null_patch_sha256: beforeProtected.get(`${taskDirectoryRelative}/null.patch`),
  };
  if (!approvedRecordMatches(approvedRecord, currentApprovedDigests)) throw new PolicyViolation();

  return {
    task,
    testCommand,
    testPath,
    taskDirectory,
    taskDirectoryRelative,
    baseDirectory,
    snapshotManifest,
    beforeProtected,
    publicCasesPath,
  };
}

// Shared protected-hash recheck against the hashes captured by loadApprovedTask.
async function assertProtectedUnchanged(root, taskId, approvedTask) {
  const currentProtected = await protectedHashes(
    root,
    taskId,
    approvedTask.taskDirectory,
    approvedTask.testPath,
    approvedTask.testCommand.oracleRelativePath,
  );
  if (!sameHashes(approvedTask.beforeProtected, currentProtected)) throw new PolicyViolation();
}

// Shared change policy: the changed-path count and every changed path must fit the task manifest.
function assertChangesWithinTaskPolicy(changed, task) {
  if (changed.length > task.max_changed_files) throw new PolicyViolation();
  if (changed.some((filePath) => !matchesPathGlobs(filePath, task.allowed_globs))) {
    throw new PolicyViolation();
  }
}

// Shared case execution: case loading, public cases, manifest-unchanged check, oracle cases,
// manifest-unchanged check, protected-hash recheck, and base snapshot recheck, in that order.
async function runApprovedCaseSets(root, taskId, approvedTask, workspaceRoot, expectedManifest) {
  const { task, testCommand, baseDirectory, snapshotManifest, beforeProtected, publicCasesPath } = approvedTask;
  const oraclePath = registeredOraclePath(taskId, root);
  if (!isWithin(root, oraclePath)) throw new PolicyViolation();
  const publicCases = await loadCaseData(
    root,
    publicCasesPath,
    beforeProtected.get(publicCasesPath),
  );
  const oracleCases = await loadCaseData(
    root,
    testCommand.oracleRelativePath,
    beforeProtected.get(testCommand.oracleRelativePath),
  );
  const workerRunner = createIsolatedWorkerRunner({
    authorizeWorkspace: createWorkspaceAuthorizer(taskId, workspaceRoot),
  });
  if (typeof workerRunner !== 'function') throw new Error('worker_runner_factory_invalid');

  const testStatus = await evaluateCases({
    caseRunner: runHostCases,
    cases: publicCases,
    taskId,
    workspaceRoot,
    timeoutMs: task.timeout_ms,
    workerRunner,
  });
  const afterTestManifest = await createSnapshotManifest(workspaceRoot);
  if (JSON.stringify(expectedManifest) !== JSON.stringify(afterTestManifest)) throw new PolicyViolation();
  const oracleStatus = await evaluateCases({
    caseRunner: runHostCases,
    cases: oracleCases,
    taskId,
    workspaceRoot,
    timeoutMs: task.timeout_ms,
    workerRunner,
  });
  const afterOracleManifest = await createSnapshotManifest(workspaceRoot);
  if (JSON.stringify(expectedManifest) !== JSON.stringify(afterOracleManifest)) throw new PolicyViolation();
  await assertProtectedUnchanged(root, taskId, approvedTask);
  try {
    await verifySnapshot(baseDirectory, snapshotManifest, task.base_snapshot_sha256);
  } catch {
    throw new PolicyViolation();
  }
  return detailResult(
    RESULT_STATUSES.has(testStatus) ? testStatus : 'RUNNER_FAILURE',
    RESULT_STATUSES.has(oracleStatus) ? oracleStatus : 'RUNNER_FAILURE',
  );
}

// Shared error mapping. It never returns error text, paths, or hashes.
function failureResult(error) {
  if (error instanceof PolicyViolation || error instanceof PatchPolicyError) {
    return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');
  }
  if (error instanceof TaskManifestValidationError) return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');
  if (error instanceof PatchFormatError) return detailResult('RUNNER_FAILURE', 'RUNNER_FAILURE');
  return detailResult('RUNNER_FAILURE', 'RUNNER_FAILURE');
}

async function removeScratchDirectory(directory) {
  if (!directory) return;
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // The scratch directory contains only this evaluation's restored snapshot.
  }
}

function createApprovedG0Evaluator({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  approvedRecords,
  authorization,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const approvedByTask = copyApprovedRecords(approvedRecords);
  const { reviewAuthorization, authorized } = createReviewAuthorization(approvedByTask, authorization);
  if (!authorized) throw new Error('G0 evaluator requires an explicit matching approved review-set authorization');

  return async function evaluateTask(input) {
    if (input?.source === 'model') return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');
    if (input?.source !== 'null' && input?.source !== 'reference') {
      return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');
    }
    if (!authorized) return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');

    try {
      const isolation = await readG2IsolationAttestation(root);
      assertIsolationMatchesAuthorization(isolation, reviewAuthorization);
    } catch {
      return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');
    }

    const taskId = input?.taskId;
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
      return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');
    }

    let temporaryRoot;

    try {
      const approvedRecord = approvedByTask.get(taskId);
      if (!approvedRecord) throw new PolicyViolation();
      const approvedTask = await loadApprovedTask(root, taskId, approvedRecord);
      const {
        task,
        taskDirectory,
        taskDirectoryRelative,
        baseDirectory,
        snapshotManifest,
        beforeProtected,
      } = approvedTask;

      const patchName = input.source === 'null' ? 'null.patch' : 'reference.patch';
      const patchFile = await readOrdinaryFileUnder(taskDirectory, patchName);
      const expectedPatchHash = approvedRecord[patchName === 'null.patch' ? 'null_patch_sha256' : 'reference_patch_sha256'];
      if (sha256(patchFile.bytes) !== expectedPatchHash) throw new PolicyViolation();
      const patchText = new TextDecoder('utf-8', { fatal: true }).decode(patchFile.bytes);
      if (input.source === 'null' && patchText.trim() !== '') throw new PolicyViolation();

      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-control-evaluator-'));
      const workspaceRoot = path.join(temporaryRoot, 'workspace');
      const restored = await restoreSnapshot(
        baseDirectory,
        snapshotManifest,
        workspaceRoot,
        task.base_snapshot_sha256,
      );
      if (restored.snapshotId !== task.base_snapshot_sha256) throw new PolicyViolation();
      const beforePatchManifest = await createSnapshotManifest(workspaceRoot);

      const protectedPatchHash = beforeProtected.get(`${taskDirectoryRelative}/${patchName}`);
      if (!protectedPatchHash || protectedPatchHash !== expectedPatchHash
        || sha256(patchFile.bytes) !== protectedPatchHash) throw new PolicyViolation();
      await applyUnifiedPatch(workspaceRoot, patchText, task.allowed_globs);

      const afterPatchManifest = await createSnapshotManifest(workspaceRoot);
      assertChangesWithinTaskPolicy(changedPaths(beforePatchManifest, afterPatchManifest), task);
      await assertProtectedUnchanged(root, taskId, approvedTask);

      return await runApprovedCaseSets(root, taskId, approvedTask, workspaceRoot, afterPatchManifest);
    } catch (error) {
      return failureResult(error);
    } finally {
      await removeScratchDirectory(temporaryRoot);
    }
  };
}

// Shared approval loading: the G2.2 attestation must match the current baseline and evaluator
// fingerprint, the corpus is loaded twice around the owner's hash, and the review index must match.
async function loadApprovedReviewState(repositoryRoot, approvalHash) {
  const isolation = await readG2IsolationAttestation(repositoryRoot);
  const { context, evaluator } = await readApprovalContext(repositoryRoot);
  if (isolation.baseline_sha256 !== context.baseline_id || isolation.runner.sha256 !== evaluator.sha256) {
    throw new Error('G2.2 attestation does not match the current host baseline and evaluator fingerprint');
  }
  const approvalCorpus = await loadCorpus(repositoryRoot);
  const reviewSetSha256 = g0ReviewSetSha256(approvalCorpus, context);
  assertG0ReviewSetApproval(reviewSetSha256, approvalHash);
  const corpus = await loadCorpus(repositoryRoot);
  const postApprovalReviewSetSha256 = g0ReviewSetSha256(corpus, context);
  assertG0ReviewSetApproval(postApprovalReviewSetSha256, approvalHash);
  if (postApprovalReviewSetSha256 !== reviewSetSha256) {
    throw new Error('Benchmark corpus changed while the approved review set was being loaded');
  }
  await assertReviewIndexMatches(repositoryRoot, corpus, context, reviewSetSha256);
  return { isolation, context, evaluator, corpus, reviewSetSha256 };
}

export async function createModelWorkspaceEvaluator({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  approvedReviewSetSha256,
} = {}) {
  if (typeof approvedReviewSetSha256 !== 'string' || !HASH_PATTERN.test(approvedReviewSetSha256)) {
    throw new Error('Model workspace evaluator requires the owner-approved lowercase SHA-256 review-set hash');
  }
  const root = path.resolve(repositoryRoot);
  const { context, corpus, reviewSetSha256 } = await loadApprovedReviewState(root, approvedReviewSetSha256);
  const approvedByTask = copyApprovedRecords(corpus);
  const { reviewAuthorization, authorized } = createReviewAuthorization(approvedByTask, {
    reviewSetSha256,
    suppliedReviewSetSha256: approvedReviewSetSha256,
    baselineId: context.baseline_id,
    evaluatorFingerprintSha256: context.evaluator_fingerprint_sha256,
  });
  if (!authorized) throw new Error('Model workspace evaluator requires an explicit matching approved review-set authorization');

  return async function evaluateWorkspace(request) {
    if (!authorized) return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');

    try {
      const currentIsolation = await readG2IsolationAttestation(root);
      assertIsolationMatchesAuthorization(currentIsolation, reviewAuthorization);
    } catch {
      return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');
    }

    const requestedTaskId = request?.taskId;
    if (typeof requestedTaskId !== 'string' || !TASK_ID_PATTERN.test(requestedTaskId)) {
      return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');
    }
    const requestedWorkspaceRoot = request?.workspaceRoot;
    if (typeof requestedWorkspaceRoot !== 'string' || !path.isAbsolute(requestedWorkspaceRoot)) {
      return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');
    }

    let temporaryBaseRoot;

    try {
      const approvedRecord = approvedByTask.get(requestedTaskId);
      if (!approvedRecord) throw new PolicyViolation();

      const workspaceRoot = path.resolve(requestedWorkspaceRoot);
      let canonicalWorkspaceRoot;
      try {
        canonicalWorkspaceRoot = await assertOrdinaryDirectory(workspaceRoot);
      } catch {
        throw new PolicyViolation();
      }
      if (!isSamePath(canonicalWorkspaceRoot, workspaceRoot)) throw new PolicyViolation();
      const canonicalRepositoryRoot = await assertOrdinaryDirectory(root);
      if (isWithin(canonicalRepositoryRoot, canonicalWorkspaceRoot)
        || isWithin(canonicalWorkspaceRoot, canonicalRepositoryRoot)) {
        throw new PolicyViolation();
      }
      try {
        await assertOnlyUnlinkedOrdinaryEntries(workspaceRoot);
      } catch {
        throw new PolicyViolation();
      }

      const approvedTask = await loadApprovedTask(root, requestedTaskId, approvedRecord);
      const { task, baseDirectory, snapshotManifest } = approvedTask;

      temporaryBaseRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-control-model-base-'));
      const baseRoot = path.join(temporaryBaseRoot, 'base');
      const restored = await restoreSnapshot(
        baseDirectory,
        snapshotManifest,
        baseRoot,
        task.base_snapshot_sha256,
      );
      if (restored.snapshotId !== task.base_snapshot_sha256) throw new PolicyViolation();
      const baseManifest = await createSnapshotManifest(baseRoot);
      let workspaceManifest;
      try {
        workspaceManifest = await createSnapshotManifest(workspaceRoot);
      } catch {
        throw new PolicyViolation();
      }
      assertChangesWithinTaskPolicy(changedPaths(baseManifest, workspaceManifest), task);
      await assertProtectedUnchanged(root, requestedTaskId, approvedTask);

      return await runApprovedCaseSets(root, requestedTaskId, approvedTask, workspaceRoot, workspaceManifest);
    } catch (error) {
      return failureResult(error);
    } finally {
      await removeScratchDirectory(temporaryBaseRoot);
    }
  };
}

async function runG0(repositoryRoot, approvalHash) {
  const { isolation, context, evaluator, corpus, reviewSetSha256 } = await loadApprovedReviewState(
    repositoryRoot,
    approvalHash,
  );
  const junctionEvidence = await readJunctionEvidence(repositoryRoot);
  const evaluateTask = createApprovedG0Evaluator({
    repositoryRoot,
    approvedRecords: corpus,
    authorization: {
      reviewSetSha256,
      suppliedReviewSetSha256: approvalHash,
      baselineId: context.baseline_id,
      evaluatorFingerprintSha256: context.evaluator_fingerprint_sha256,
    },
  });
  const results = [];

  for (const record of corpus) {
    let nullEvaluation = { status: 'RUNNER_FAILURE', public_status: 'RUNNER_FAILURE', oracle_status: 'RUNNER_FAILURE' };
    let referenceEvaluation = { status: 'RUNNER_FAILURE', public_status: 'RUNNER_FAILURE', oracle_status: 'RUNNER_FAILURE' };
    try {
      nullEvaluation = await evaluateTask({ taskId: record.task_id, source: 'null' });
      if (!RESULT_STATUSES.has(nullEvaluation.status)) {
        nullEvaluation = { status: 'RUNNER_FAILURE', public_status: 'RUNNER_FAILURE', oracle_status: 'RUNNER_FAILURE' };
      }
      referenceEvaluation = await evaluateTask({ taskId: record.task_id, source: 'reference' });
      if (!RESULT_STATUSES.has(referenceEvaluation.status)) {
        referenceEvaluation = { status: 'RUNNER_FAILURE', public_status: 'RUNNER_FAILURE', oracle_status: 'RUNNER_FAILURE' };
      }
    } catch {
      nullEvaluation = { status: 'RUNNER_FAILURE', public_status: 'RUNNER_FAILURE', oracle_status: 'RUNNER_FAILURE' };
      referenceEvaluation = { status: 'RUNNER_FAILURE', public_status: 'RUNNER_FAILURE', oracle_status: 'RUNNER_FAILURE' };
    }
    results.push({
      ...record,
      null_status: nullEvaluation.status,
      null_evaluation: nullEvaluation,
      reference_status: referenceEvaluation.status,
      reference_evaluation: referenceEvaluation,
    });
  }

  const decision = g0Decision(results);
  const report = {
    schema_version: 1,
    generated_by: 'bench/evaluator/index.mjs',
    generated_at: new Date().toISOString(),
    decision,
    execution_status: 'post_g2.2_behavioral',
    execution_scope: 'null_and_reference_only',
    model_source_executed: false,
    approved_g0_review_set_sha256: reviewSetSha256,
    protocol_version: context.protocol_version,
    baseline_id: context.baseline_id,
    evaluator_fingerprint: evaluator,
    g2_isolation_attestation: {
      evidence_sha256: isolation.evidence_sha256,
      verified_at: isolation.evidence.verified_at,
      mechanism: isolation.evidence.mechanism,
      checks: isolation.evidence.checks,
    },
    human_review: {
      status: 'approved_by_explicit_review_set_hash_argument',
      approval_method: '--approve-review-set-sha256',
    },
    junction_evidence: junctionEvidence,
    validations: {
      task_count_exact: results.length === TASK_IDS.length,
      task_manifests_and_snapshots_verified: true,
      snapshot_bases_restored_offline_preflight: results.length === TASK_IDS.length,
      reference_patches_syntax_validated: results.every((result) => result.reference_patch_syntax_valid),
      null_controls_expected_to_fail: results.every((result) => isExpectedNullControlFailure(result.null_status)),
      reference_patches_expected_to_pass: results.every((result) => result.reference_status === 'PASS'),
      oracle_and_public_test_hashes_recorded: results.every((result) => HASH_PATTERN.test(result.oracle_sha256)
        && HASH_PATTERN.test(result.public_test_sha256)),
    },
    results,
    security_boundary: 'The evaluator is not an OS sandbox. This report contains no model-generated patch results and proves no isolation of hostile code.',
  };
  await assertApprovedStateUnchanged(repositoryRoot, corpus, context, reviewSetSha256, approvalHash);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await atomicWrite(
    repositoryRoot,
    'bench/results/g0-report.json',
    json,
    '"generated_by": "bench/evaluator/index.mjs"',
  );
  process.stdout.write(`G0 ${decision}: bench/results/g0-report.json\n`);
  if (decision !== 'PASS') process.exitCode = 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode !== 'run') throw new Error('G0 execution is available only through the --run CLI path');
  await runG0(DEFAULT_REPOSITORY_ROOT, options.approvalHash);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
