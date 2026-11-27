import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  G2_ISOLATION_EVIDENCE_RELATIVE_PATH,
  G2_ISOLATION_REQUIRED_CHECKS,
  readG2IsolationAttestation,
} from './isolation-attestation.mjs';
import { getRuntimeFingerprint } from './runtime-fingerprint.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROBE_REPORT_RELATIVE_PATH = 'runtime/diagnostics/appcontainer-probe-report.json';
const HARDWARE_BASELINE_RELATIVE_PATH = 'runtime/diagnostics/hardware-baseline.json';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MECHANISM = 'AppContainer + Job Object via bench/isolation/run-probes.ps1';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function refuse(reason) {
  throw new Error(`G2.2 isolation attestation refused: ${reason}`);
}

export function buildG2IsolationAttestation(report, reportSha256, approvedSha256, expected) {
  if (typeof approvedSha256 !== 'string' || !HASH_PATTERN.test(approvedSha256)) {
    refuse('approval must be a lowercase 64-hex SHA-256');
  }
  if (approvedSha256 !== reportSha256) refuse('approval does not match the probe report SHA-256');
  if (!report || typeof report !== 'object' || Array.isArray(report)) refuse('probe report must be an object');
  if (report.status !== 'PASS') refuse('probe report status must be PASS');
  if (report.failure !== null) refuse('probe report failure must be null');
  if (report.platform !== 'Win32NT') refuse('probe report platform must be Win32NT');
  const checks = report.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks) || Object.keys(checks).length === 0) {
    refuse('probe report checks must be a non-empty object');
  }
  for (const [name, value] of Object.entries(checks)) {
    if (value !== 'PASS') refuse(`probe check ${name} is not PASS`);
  }
  for (const required of G2_ISOLATION_REQUIRED_CHECKS) {
    if (checks[required] !== 'PASS') refuse(`required probe check ${required} is missing or not PASS`);
  }
  if (report.scope !== 'dedicated-isolation-probe-only') refuse('probe report scope must be dedicated-isolation-probe-only');
  for (const flag of ['preflight_only', 'profile_contract_import_diagnostic_only', 'profile_bootstrap_diagnostic_only']) {
    if (report[flag] !== false) refuse(`probe report ${flag} must be false`);
  }
  for (const key of ['baseline_sha256', 'runner_sha256']) {
    if (typeof expected?.[key] !== 'string' || report[key] !== expected[key]) {
      refuse(`${key} does not match the current host or runner`);
    }
  }
  return {
    schema_version: 1,
    status: 'PASS',
    verified_at: report.generated_at,
    platform: 'win32',
    baseline_sha256: report.baseline_sha256,
    runner_sha256: report.runner_sha256,
    mechanism: MECHANISM,
    checks: Object.fromEntries(G2_ISOLATION_REQUIRED_CHECKS.map((check) => [check, true])),
  };
}

export function parseArguments(args) {
  if (args.length !== 2 || args[0] !== '--approve-report-sha256') {
    throw new Error('Usage: node bench/evaluator/write-isolation-attestation.mjs --approve-report-sha256 <hex>');
  }
  return { approvedSha256: args[1] };
}

export async function writeG2IsolationAttestation(repositoryRoot, approvedSha256, dependencies = {}) {
  const getFingerprint = dependencies.getFingerprint ?? getRuntimeFingerprint;
  const readAttestation = dependencies.readAttestation ?? readG2IsolationAttestation;
  const reportBytes = await readFile(path.join(repositoryRoot, PROBE_REPORT_RELATIVE_PATH));
  const baselineBytes = await readFile(path.join(repositoryRoot, HARDWARE_BASELINE_RELATIVE_PATH));
  let report;
  try {
    report = JSON.parse(reportBytes.toString('utf8'));
  } catch {
    refuse('probe report JSON is malformed');
  }
  const runtime = await getFingerprint(repositoryRoot);
  const attestation = buildG2IsolationAttestation(report, sha256(reportBytes), approvedSha256, {
    baseline_sha256: sha256(baselineBytes),
    runner_sha256: runtime.sha256,
  });
  const evidencePath = path.join(repositoryRoot, G2_ISOLATION_EVIDENCE_RELATIVE_PATH);
  await writeFile(evidencePath, `${JSON.stringify(attestation, null, 2)}\n`, { flag: 'wx' });
  try {
    const result = await readAttestation(repositoryRoot);
    return result.evidence_sha256;
  } catch (error) {
    await rm(evidencePath, { force: true });
    throw error;
  }
}

async function main() {
  const { approvedSha256 } = parseArguments(process.argv.slice(2));
  const evidenceSha256 = await writeG2IsolationAttestation(REPOSITORY_ROOT, approvedSha256);
  console.log(evidenceSha256);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
