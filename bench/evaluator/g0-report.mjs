import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { G0_PROTOCOL_VERSION, G0_REVIEW_DIGEST_FIELDS, g0ReviewSetSha256 } from './g0-review-contract.mjs';
import { readG2IsolationAttestation } from './isolation-attestation.mjs';
import { PUBLIC_TEST_REGISTRY } from './public-test-registry.mjs';
import { getRuntimeFingerprint } from './runtime-fingerprint.mjs';
import { parseCaseData } from './case-data.mjs';
import { validateTaskManifest } from './schema/task-manifest.mjs';
import { parseUnifiedPatch } from './unified-diff.mjs';
import { readSnapshotManifest, restoreSnapshot, verifySnapshot } from '../snapshots/index.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TASK_IDS = Object.keys(PUBLIC_TEST_REGISTRY).sort();
const HASH_PATTERN = /^[a-f0-9]{64}$/;
export { G0_PROTOCOL_VERSION, g0ReviewSetSha256 };
const REVIEW_DIGEST_FIELDS = G0_REVIEW_DIGEST_FIELDS;
const REQUIRED_JUNCTION_CHECKS = [
  'base_junction_created',
  'base_junction_rejected',
  'destination_junction_created',
  'destination_junction_rejected',
  'target_unchanged',
  'source_unchanged',
  'temporary_workspace_removed',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function samePath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function readOrdinaryFile(repositoryRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)) {
    throw new Error('Report input path is not a repository-relative POSIX path');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Report input path contains an unsafe component');
  }

  const root = path.resolve(repositoryRoot);
  const canonicalRoot = await realpath(root);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    const finalComponent = index === parts.length - 1;
    if (info.isSymbolicLink() || (finalComponent ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`Report input is not an ordinary file: ${relativePath}`);
    }
    const resolved = await realpath(current);
    if (!isWithin(canonicalRoot, resolved) || !samePath(current, resolved)) {
      throw new Error(`Report input resolves through a filesystem alias: ${relativePath}`);
    }
  }
  return { absolutePath: current, bytes: await readFile(current) };
}

function requireHash(value, name) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new Error(`${name} must be a lowercase SHA-256`);
  return value;
}

export function assertG0ReviewSetApproval(expectedSha256, suppliedSha256) {
  requireHash(expectedSha256, 'expected G0 review-set hash');
  if (typeof suppliedSha256 !== 'string' || !HASH_PATTERN.test(suppliedSha256) || suppliedSha256 !== expectedSha256) {
    throw new Error('G0 review-set approval is missing or does not match the current review set');
  }
}

export function validateReferencePatch(patchText, allowedGlobs) {
  const parsed = parseUnifiedPatch(patchText, allowedGlobs);
  if (parsed.length === 0) throw new Error('Reference patch must contain at least one file change');
  return parsed.length;
}

function promptSummary(prompt) {
  const singleLine = String(prompt).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const escaped = singleLine.replaceAll('|', '\\|');
  return escaped.length > 220 ? `${escaped.slice(0, 217)}...` : escaped;
}

function validateCaseDataDocument(bytes, relativePath) {
  parseCaseData(bytes, relativePath);
}

export function buildReferenceReviewMarkdown(records, context, reviewSetSha256) {
  requireHash(reviewSetSha256, 'G0 review-set hash');
  requireHash(context.baseline_id, 'baseline_id');
  requireHash(context.evaluator_fingerprint_sha256, 'evaluator_fingerprint_sha256');
  if (context.protocol_version !== G0_PROTOCOL_VERSION) throw new Error('G0 protocol version is stale');
  const rows = [...records]
    .sort((left, right) => (left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0))
    .map((record) => {
      const registration = PUBLIC_TEST_REGISTRY[record.task_id];
      if (!registration) throw new Error(`${record.task_id}: case data is not in the fixed registry`);
      const publicCases = `../tasks/${record.task_id}/${registration.relativePath}`;
      const oracleCases = `../${registration.oracleRelativePath}`;
      return `| ${record.task_id} | ${promptSummary(record.prompt)} | [${registration.relativePath}](${publicCases}) | [${registration.oracleRelativePath}](${oracleCases}) | [reference.patch](../tasks/${record.task_id}/reference.patch) | ${REVIEW_DIGEST_FIELDS.map((field) => `\`${record[field]}\``).join(' | ')} |`;
    });

  return [
    '<!-- Generated by bench/evaluator/g0-report.mjs -- owner-only; do not include in model context. -->',
    '# G0 reference patch review',
    '',
    'Review status: **PENDING OWNER HUMAN REVIEW**.',
    '',
    'These fixtures and reference patches are agent-authored and have independent static review. This index contains only public prompts, declarative JSON case-data paths, and hashes; it contains no oracle contents or patch contents. Review each linked patch before authorizing any post-G2.2 behavioral run.',
    '',
    `Protocol version: \`${context.protocol_version}\``,
    `Baseline ID (SHA-256): \`${context.baseline_id}\``,
    `Evaluator fingerprint (SHA-256): \`${context.evaluator_fingerprint_sha256}\``,
    `G0 review-set approval SHA-256: \`${reviewSetSha256}\``,
    '',
    'This review hash binds all task manifests, snapshot manifests and IDs, public and oracle JSON case data, null/reference patches, the evaluator and protocol fingerprint, and the current host baseline. Behavioral execution also requires a valid `runtime/diagnostics/g2-isolation-evidence.json` attestation for these exact baseline and runner hashes. The evaluator refuses `source=model`.',
    '',
    `| Task | Public prompt summary | Public case data | Oracle case data | Patch | ${REVIEW_DIGEST_FIELDS.join(' | ')} |`,
    `| --- | --- | --- | --- | --- | ${REVIEW_DIGEST_FIELDS.map(() => '---').join(' | ')} |`,
    ...rows,
    '',
  ].join('\n');
}

// A null control must fail its public tests. A CRASH counts as that failure because some fixtures,
// such as an import cycle that throws at module initialization, cannot load without the patch.
// Runner failures, timeouts, policy violations, and passes never count as an expected failure.
export function isExpectedNullControlFailure(status) {
  return status === 'FAIL' || status === 'CRASH';
}

export function g0Decision(taskResults) {
  const actualTaskIds = taskResults.map((result) => result.task_id)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const allExpected = taskResults.length === TASK_IDS.length
    && actualTaskIds.every((taskId, index) => taskId === TASK_IDS[index])
    && taskResults.every((result) => isExpectedNullControlFailure(result.null_status)
      && isExpectedNullControlFailure(result.null_evaluation?.public_status)
      && result.reference_status === 'PASS'
      && result.reference_evaluation?.public_status === 'PASS'
      && result.reference_evaluation?.oracle_status === 'PASS');
  return allExpected ? 'PASS' : 'NO_GO';
}

export async function loadCorpus(repositoryRoot) {
  const records = [];
  const taskRoot = path.join(repositoryRoot, 'bench', 'tasks');
  const taskRootInfo = await lstat(taskRoot);
  if (!taskRootInfo.isDirectory() || taskRootInfo.isSymbolicLink()) throw new Error('Task root must be an ordinary directory');
  const taskEntries = await readdir(taskRoot, { withFileTypes: true });
  if (taskEntries.some((entry) => entry.isSymbolicLink()
    || (!entry.isDirectory() && !(entry.isFile() && entry.name === 'README.md')))) {
    throw new Error('Task root contains an unexpected filesystem entry');
  }
  const actualTaskIds = taskEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (JSON.stringify(actualTaskIds) !== JSON.stringify(TASK_IDS)) {
    throw new Error('Task root must contain exactly the fixed benchmark IDs of the registry');
  }

  for (const taskId of TASK_IDS) {
    const taskRelative = `bench/tasks/${taskId}`;
    const taskFile = await readOrdinaryFile(repositoryRoot, `${taskRelative}/task.json`);
    const task = validateTaskManifest(JSON.parse(taskFile.bytes.toString('utf8')));
    if (task.task_id !== taskId) throw new Error(`${taskId}: task manifest ID mismatch`);

    const registration = PUBLIC_TEST_REGISTRY[taskId];
    if (!registration || task.public_test_command_id !== registration.commandId) {
      throw new Error(`${taskId}: public test command does not match the fixed registry`);
    }
    if (registration.oracleRelativePath !== `bench/oracles/${taskId}.json`) {
      throw new Error(`${taskId}: case data paths do not match the fixed registry`);
    }
    const snapshotFile = await readOrdinaryFile(repositoryRoot, `${taskRelative}/snapshot.json`);
    const snapshot = await readSnapshotManifest(snapshotFile.absolutePath);
    await verifySnapshot(path.join(repositoryRoot, taskRelative, 'base'), snapshot, task.base_snapshot_sha256);

    const oracleFile = await readOrdinaryFile(repositoryRoot, registration.oracleRelativePath);
    const publicTestFile = await readOrdinaryFile(repositoryRoot, `${taskRelative}/${registration.relativePath}`);
    validateCaseDataDocument(oracleFile.bytes, registration.oracleRelativePath);
    validateCaseDataDocument(publicTestFile.bytes, `${taskRelative}/${registration.relativePath}`);
    const referencePatchFile = await readOrdinaryFile(repositoryRoot, `${taskRelative}/reference.patch`);
    const nullPatchFile = await readOrdinaryFile(repositoryRoot, `${taskRelative}/null.patch`);
    if (nullPatchFile.bytes.length !== 0) throw new Error(`${taskId}: null.patch must be empty`);
    try {
      const patchText = new TextDecoder('utf-8', { fatal: true }).decode(referencePatchFile.bytes);
      validateReferencePatch(patchText, task.allowed_globs);
    } catch (error) {
      throw new Error(`${taskId}: reference.patch failed format or allowlist validation (${error.name})`);
    }

    records.push({
      task_id: taskId,
      prompt: task.prompt,
      public_test_command_id: registration.commandId,
      base_snapshot_sha256: task.base_snapshot_sha256,
      task_manifest_sha256: sha256(taskFile.bytes),
      snapshot_manifest_sha256: sha256(snapshotFile.bytes),
      snapshot_id: task.base_snapshot_sha256,
      oracle_sha256: sha256(oracleFile.bytes),
      public_test_sha256: sha256(publicTestFile.bytes),
      reference_patch_sha256: sha256(referencePatchFile.bytes),
      reference_patch_syntax_valid: true,
      null_patch_sha256: sha256(nullPatchFile.bytes),
    });
  }

  if (records.length !== TASK_IDS.length || new Set(records.map((record) => record.task_id)).size !== TASK_IDS.length) {
    throw new Error('Benchmark corpus must contain exactly the registered task IDs');
  }
  await restoreCorpusOffline(repositoryRoot, records);
  return records;
}

async function restoreCorpusOffline(repositoryRoot, records) {
  const runtimeRoot = path.join(repositoryRoot, 'runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const runtimeInfo = await lstat(runtimeRoot);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) throw new Error('runtime/ must be an ordinary directory');
  const temporaryRoot = await mkdtemp(path.join(runtimeRoot, 'g0-restore-check-'));
  try {
    for (const record of records) {
      const taskRoot = path.join(repositoryRoot, 'bench', 'tasks', record.task_id);
      const manifest = await readSnapshotManifest(path.join(taskRoot, 'snapshot.json'));
      const destination = path.join(temporaryRoot, record.task_id);
      const restored = await restoreSnapshot(
        path.join(taskRoot, 'base'),
        manifest,
        destination,
        record.base_snapshot_sha256,
      );
      if (restored.snapshotId !== record.base_snapshot_sha256) {
        throw new Error(`${record.task_id}: offline restore returned a different snapshot ID`);
      }
    }
  } finally {
    const projectRoot = path.resolve(repositoryRoot);
    const relative = path.relative(projectRoot, temporaryRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Refusing to clean a restore-check path outside the repository');
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function evaluatorFingerprint(repositoryRoot) {
  return getRuntimeFingerprint(repositoryRoot);
}

export async function readApprovalContext(repositoryRoot) {
  const baselineFile = await readOrdinaryFile(repositoryRoot, 'runtime/diagnostics/hardware-baseline.json');
  const evaluator = await evaluatorFingerprint(repositoryRoot);
  return {
    context: {
      protocol_version: G0_PROTOCOL_VERSION,
      baseline_id: sha256(baselineFile.bytes),
      evaluator_fingerprint_sha256: evaluator.sha256,
    },
    baselineFile,
    evaluator,
  };
}

export async function assertReviewIndexMatches(repositoryRoot, records, context, reviewSetSha256) {
  const reviewIndex = await readOrdinaryFile(repositoryRoot, 'bench/review/reference-patches.md');
  const expected = Buffer.from(buildReferenceReviewMarkdown(records, context, reviewSetSha256), 'utf8');
  if (!reviewIndex.bytes.equals(expected)) {
    throw new Error('Owner review index bytes do not exactly match the current approved review set');
  }
}

export async function assertApprovedStateUnchanged(repositoryRoot, approvedRecords, approvedContext, approvedReviewSetSha256, suppliedApprovalHash) {
  const currentRecords = await loadCorpus(repositoryRoot);
  const { context: currentContext } = await readApprovalContext(repositoryRoot);
  const currentReviewSetSha256 = g0ReviewSetSha256(currentRecords, currentContext);
  assertG0ReviewSetApproval(currentReviewSetSha256, suppliedApprovalHash);
  if (currentReviewSetSha256 !== approvedReviewSetSha256
    || currentContext.protocol_version !== approvedContext.protocol_version
    || currentContext.baseline_id !== approvedContext.baseline_id
    || currentContext.evaluator_fingerprint_sha256 !== approvedContext.evaluator_fingerprint_sha256
    || g0ReviewSetSha256(approvedRecords, approvedContext) !== approvedReviewSetSha256) {
    throw new Error('Approved corpus, baseline, or evaluator fingerprint changed during G0 execution');
  }
  const isolation = await readG2IsolationAttestation(repositoryRoot);
  if (isolation.baseline_sha256 !== approvedContext.baseline_id
    || isolation.runner.sha256 !== approvedContext.evaluator_fingerprint_sha256) {
    throw new Error('G2.2 attestation no longer matches the approved baseline and evaluator fingerprint');
  }
  await assertReviewIndexMatches(repositoryRoot, currentRecords, currentContext, currentReviewSetSha256);
}

export async function readJunctionEvidence(repositoryRoot) {
  const evidenceFile = await readOrdinaryFile(repositoryRoot, 'runtime/diagnostics/windows-junction-check.json');
  const scriptFile = await readOrdinaryFile(repositoryRoot, 'bench/snapshots/windows-junction-check.mjs');
  const evidence = JSON.parse(evidenceFile.bytes.toString('utf8'));
  if (evidence.status !== 'PASS' || evidence.script_sha256 !== sha256(scriptFile.bytes)) {
    throw new Error('Windows junction evidence is missing, failed, or belongs to a different script version');
  }
  if (REQUIRED_JUNCTION_CHECKS.some((check) => evidence.checks?.[check] !== true)) {
    throw new Error('Windows junction evidence is incomplete');
  }
  return {
    sha256: sha256(evidenceFile.bytes),
    script_sha256: evidence.script_sha256,
    checked_at: evidence.checked_at,
    checks: evidence.checks,
  };
}

export async function atomicWrite(repositoryRoot, relativePath, contents, generatedMarker) {
  const target = path.resolve(repositoryRoot, ...relativePath.split('/'));
  if (!isWithin(repositoryRoot, target)) throw new Error('Output path escapes the repository');
  const rootInfo = await lstat(repositoryRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Repository root is not an ordinary directory');
  const canonicalRoot = await realpath(repositoryRoot);
  const directory = path.dirname(target);
  const relativeDirectory = path.relative(repositoryRoot, directory);
  let current = repositoryRoot;
  for (const part of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing to write through a reparse-point directory');
    const resolved = await realpath(current);
    if (!samePath(current, resolved) || !isWithin(canonicalRoot, resolved)) {
      throw new Error('Refusing to write through a filesystem alias');
    }
  }
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw new Error('Output target is not an ordinary file');
    if (generatedMarker && !(await readFile(target, 'utf8')).includes(generatedMarker)) {
      throw new Error('Refusing to overwrite an output without this generator marker');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, { flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function prepareReview(repositoryRoot) {
  const records = await loadCorpus(repositoryRoot);
  const { context, evaluator } = await readApprovalContext(repositoryRoot);
  const reviewSetSha256 = g0ReviewSetSha256(records, context);
  const markdown = buildReferenceReviewMarkdown(records, context, reviewSetSha256);
  await atomicWrite(
    repositoryRoot,
    'bench/review/reference-patches.md',
    markdown,
    '<!-- Generated by bench/evaluator/g0-report.mjs',
  );
  const preflight = {
    schema_version: 1,
    generated_by: 'bench/evaluator/g0-report.mjs',
    generated_at: new Date().toISOString(),
    decision: 'PENDING_G2.2',
    behavioral_status: 'BLOCKED_G2.2',
    behavioral_execution_performed: false,
    patch_application_performed: false,
    public_tests_executed: false,
    hidden_oracles_executed: false,
    model_source_executed: false,
    protocol_version: context.protocol_version,
    baseline_id: context.baseline_id,
    evaluator_fingerprint: evaluator,
    g0_review_set_sha256: reviewSetSha256,
    human_review: { status: 'PENDING' },
    validations: {
      task_count_exact: records.length === TASK_IDS.length,
      manifests_and_snapshots_verified: true,
      snapshot_bases_restored_offline: true,
      reference_patch_syntax_valid: records.every((record) => record.reference_patch_syntax_valid),
      null_patch_empty: records.every((record) => record.null_patch_sha256 === sha256(Buffer.alloc(0))),
      public_test_and_oracle_hashes_recorded: records.every((record) => HASH_PATTERN.test(record.public_test_sha256)
        && HASH_PATTERN.test(record.oracle_sha256)),
    },
    tasks: records.map(({ task_id, ...record }) => ({ task_id, ...record })),
    security_boundary: 'Static preflight only. Snapshot restore and patch parsing do not establish OS isolation or execute candidate code.',
  };
  await atomicWrite(
    repositoryRoot,
    'bench/results/g0-preflight-report.json',
    `${JSON.stringify(preflight, null, 2)}\n`,
    '"generated_by": "bench/evaluator/g0-report.mjs"',
  );
  process.stdout.write(`Prepared owner review index and static preflight.\nProtocol: ${context.protocol_version}\nBaseline ID: ${context.baseline_id}\nEvaluator fingerprint: ${evaluator.sha256}\nG0 review-set SHA-256: ${reviewSetSha256}\nBehavioral status: BLOCKED_G2.2\n`);
}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--prepare-review') return { mode: 'prepare-review' };
  if (args[0] === '--run' && args.length === 3
    && args[1] === '--approve-review-set-sha256') {
    return { mode: 'run', approvalHash: args[2] };
  }
  throw new Error('Usage: node bench/evaluator/g0-report.mjs --prepare-review | node bench/evaluator/index.mjs --run --approve-review-set-sha256 <sha256>');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === 'prepare-review') await prepareReview(REPOSITORY_ROOT);
  else throw new Error('G0 execution is available only through bench/evaluator/index.mjs');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
