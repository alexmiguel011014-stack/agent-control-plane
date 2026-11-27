import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getRuntimeFingerprint } from './runtime-fingerprint.mjs';

export const G2_ISOLATION_EVIDENCE_RELATIVE_PATH = 'runtime/diagnostics/g2-isolation-evidence.json';
export const G2_ISOLATION_REQUIRED_CHECKS = Object.freeze([
  'filesystem_containment',
  'network_denied',
  'child_process_tree_terminated',
  'oracle_inaccessible',
]);

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EVIDENCE_KEYS = Object.freeze([
  'schema_version',
  'status',
  'verified_at',
  'platform',
  'baseline_sha256',
  'runner_sha256',
  'mechanism',
  'checks',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function fail(reason) {
  throw new Error(`Invalid G2.2 isolation attestation: ${reason}`);
}

export function validateG2IsolationAttestation(attestation, expected) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    fail('expected an object');
  }
  if (Object.keys(attestation).sort().join('\0') !== [...EVIDENCE_KEYS].sort().join('\0')) {
    fail('missing or undeclared fields');
  }
  if (attestation.schema_version !== 1 || attestation.status !== 'PASS') fail('status must be PASS for schema version 1');
  if (attestation.platform !== 'win32' || expected?.platform !== 'win32') fail('the verified host must be Windows');
  if (typeof attestation.verified_at !== 'string' || !Number.isFinite(Date.parse(attestation.verified_at))) {
    fail('verified_at must be an ISO timestamp');
  }
  if (typeof attestation.mechanism !== 'string' || !attestation.mechanism.trim() || attestation.mechanism.length > 160) {
    fail('mechanism must be a short non-empty description');
  }
  for (const key of ['baseline_sha256', 'runner_sha256']) {
    if (typeof attestation[key] !== 'string' || !HASH_PATTERN.test(attestation[key])) fail(`${key} must be lowercase SHA-256`);
    if (attestation[key] !== expected?.[key]) fail(`${key} does not match the current host or runner`);
  }
  if (!attestation.checks || typeof attestation.checks !== 'object' || Array.isArray(attestation.checks)) {
    fail('checks must be an object');
  }
  if (Object.keys(attestation.checks).sort().join('\0') !== [...G2_ISOLATION_REQUIRED_CHECKS].sort().join('\0')) {
    fail('checks are incomplete or contain undeclared fields');
  }
  for (const check of G2_ISOLATION_REQUIRED_CHECKS) {
    if (attestation.checks[check] !== true) fail(`${check} must be true`);
  }
  return attestation;
}

async function readOrdinaryFile(repositoryRoot, relativePath) {
  const root = path.resolve(repositoryRoot);
  const canonicalRoot = await realpath(root);
  const parts = relativePath.split('/');
  let current = root;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await lstat(current);
    const final = index === parts.length - 1;
    if (stat.isSymbolicLink() || (final ? !stat.isFile() : !stat.isDirectory())) {
      fail(`input is not an ordinary file: ${relativePath}`);
    }
    const resolved = await realpath(current);
    if (!isWithin(canonicalRoot, resolved)) fail(`input escapes the repository: ${relativePath}`);
  }

  return { absolutePath: current, bytes: await readFile(current) };
}

export async function readG2IsolationAttestation(repositoryRoot) {
  if (process.platform !== 'win32') fail('unsupported platform');
  const baseline = await readOrdinaryFile(repositoryRoot, 'runtime/diagnostics/hardware-baseline.json');
  const evidence = await readOrdinaryFile(repositoryRoot, G2_ISOLATION_EVIDENCE_RELATIVE_PATH);
  const runtime = await getRuntimeFingerprint(repositoryRoot);
  let parsed;
  try {
    parsed = JSON.parse(evidence.bytes.toString('utf8'));
  } catch {
    fail('JSON is malformed');
  }
  const expected = {
    platform: process.platform,
    baseline_sha256: sha256(baseline.bytes),
    runner_sha256: runtime.sha256,
  };
  return {
    evidence: validateG2IsolationAttestation(parsed, expected),
    evidence_sha256: sha256(evidence.bytes),
    runner: runtime,
    baseline_sha256: expected.baseline_sha256,
  };
}
