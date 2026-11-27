import { createHash } from 'node:crypto';
import { PUBLIC_TEST_REGISTRY } from './public-test-registry.mjs';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TASK_ID_PATTERN = /^[PBIS][0-9]{2}$/;
const TASK_IDS = Object.keys(PUBLIC_TEST_REGISTRY).sort();

export const G0_PROTOCOL_VERSION = 'g0-host-json-case-data-appcontainer-v1';
export const G0_REVIEW_DIGEST_FIELDS = Object.freeze([
  'task_manifest_sha256',
  'snapshot_manifest_sha256',
  'snapshot_id',
  'base_snapshot_sha256',
  'oracle_sha256',
  'public_test_sha256',
  'reference_patch_sha256',
  'null_patch_sha256',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Bind the fixed task corpus, case-data digest, runner fingerprint, and host baseline. */
export function g0ReviewSetSha256(records, context) {
  if (!Array.isArray(records) || records.length !== TASK_IDS.length) {
    throw new Error('G0 review set must contain exactly the fixed registry tasks');
  }
  if (!context || context.protocol_version !== G0_PROTOCOL_VERSION) {
    throw new Error(`G0 protocol version must be ${G0_PROTOCOL_VERSION}`);
  }
  const baselineId = context.baseline_id;
  const evaluatorFingerprint = context.evaluator_fingerprint_sha256;
  if (!HASH_PATTERN.test(baselineId ?? '')) throw new Error('baseline_id must be a lowercase SHA-256');
  if (!HASH_PATTERN.test(evaluatorFingerprint ?? '')) {
    throw new Error('evaluator_fingerprint_sha256 must be a lowercase SHA-256');
  }
  const ids = new Set();
  const canonical = records.map((record) => {
    const taskId = record?.task_id;
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId) || ids.has(taskId)) {
      throw new Error('G0 review set contains an invalid or duplicate task ID');
    }
    ids.add(taskId);
    const canonicalRecord = { task_id: taskId };
    for (const field of G0_REVIEW_DIGEST_FIELDS) {
      if (!HASH_PATTERN.test(record[field] ?? '')) throw new Error(`${field} must be a lowercase SHA-256`);
      canonicalRecord[field] = record[field];
    }
    return canonicalRecord;
  }).sort((left, right) => (left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0));
  if (!TASK_IDS.every((taskId, index) => canonical[index].task_id === taskId)) {
    throw new Error('G0 review set task IDs do not match the fixed registry');
  }
  return sha256(Buffer.from(JSON.stringify({
    protocol_version: context.protocol_version,
    baseline_id: baselineId,
    evaluator_fingerprint_sha256: evaluatorFingerprint,
    tasks: canonical,
  }), 'utf8'));
}
