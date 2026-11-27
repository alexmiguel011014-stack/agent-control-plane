import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { G2_ISOLATION_REQUIRED_CHECKS, validateG2IsolationAttestation } from './isolation-attestation.mjs';
import { mkdir, readdir } from 'node:fs/promises';
import {
  buildG2IsolationAttestation,
  parseArguments,
  writeG2IsolationAttestation,
} from './write-isolation-attestation.mjs';

const BASELINE = 'a'.repeat(64);
const RUNNER = 'b'.repeat(64);
const EXPECTED = Object.freeze({ baseline_sha256: BASELINE, runner_sha256: RUNNER });

function syntheticReport(overrides = {}) {
  return {
    platform: 'Win32NT',
    baseline_sha256: BASELINE,
    runner_sha256: RUNNER,
    generated_at: '2026-11-09T12:00:00.000Z',
    checks: {
      filesystem_containment: 'PASS',
      network_denied: 'PASS',
      child_process_tree_terminated: 'PASS',
      oracle_inaccessible: 'PASS',
      temporary_files_cleanup: 'PASS',
    },
    scope: 'dedicated-isolation-probe-only',
    preflight_only: false,
    profile_contract_import_diagnostic_only: false,
    profile_bootstrap_diagnostic_only: false,
    failure: null,
    status: 'PASS',
    ...overrides,
  };
}

async function withSyntheticReportFile(report, run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'g2-attestation-test-'));
  try {
    const reportPath = path.join(directory, 'appcontainer-probe-report.json');
    await writeFile(reportPath, JSON.stringify(report));
    const bytes = await readFile(reportPath);
    const reportSha256 = createHash('sha256').update(bytes).digest('hex');
    await run(JSON.parse(bytes.toString('utf8')), reportSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a valid synthetic report produces an attestation the validator accepts', async () => {
  await withSyntheticReportFile(syntheticReport(), (report, reportSha256) => {
    const attestation = buildG2IsolationAttestation(report, reportSha256, reportSha256, EXPECTED);
    assert.equal(attestation.verified_at, report.generated_at);
    assert.deepEqual(Object.keys(attestation.checks).sort(), [...G2_ISOLATION_REQUIRED_CHECKS].sort());
    assert.equal(validateG2IsolationAttestation(attestation, { platform: 'win32', ...EXPECTED }), attestation);
  });
});

test('refuses an approval that is not lowercase 64-hex', async () => {
  await withSyntheticReportFile(syntheticReport(), (report, reportSha256) => {
    for (const approval of [undefined, '', reportSha256.toUpperCase(), reportSha256.slice(1), `${reportSha256}0`]) {
      assert.throws(() => buildG2IsolationAttestation(report, reportSha256, approval, EXPECTED), /lowercase 64-hex/);
    }
  });
});

test('refuses an approval that does not match the report SHA-256', async () => {
  await withSyntheticReportFile(syntheticReport(), (report, reportSha256) => {
    assert.throws(() => buildG2IsolationAttestation(report, reportSha256, 'c'.repeat(64), EXPECTED), /does not match the probe report/);
  });
});

const REPORT_REFUSALS = [
  ['status BLOCKED', { status: 'BLOCKED' }, /status must be PASS/],
  ['status FAIL', { status: 'FAIL' }, /status must be PASS/],
  ['recorded failure', { failure: 'stage x failed' }, /failure must be null/],
  ['missing failure', { failure: undefined }, /failure must be null/],
  ['non-Windows platform', { platform: 'Unix' }, /platform must be Win32NT/],
  ['UNKNOWN check', { checks: { filesystem_containment: 'PASS', temporary_files_cleanup: 'UNKNOWN' } }, /temporary_files_cleanup is not PASS/],
  ['FAIL check', { checks: { network_denied: 'FAIL' } }, /network_denied is not PASS/],
  ['BLOCKED check', { checks: { oracle_inaccessible: 'BLOCKED' } }, /oracle_inaccessible is not PASS/],
  ['empty checks', { checks: {} }, /non-empty object/],
  ['missing oracle check', { checks: { filesystem_containment: 'PASS', network_denied: 'PASS', child_process_tree_terminated: 'PASS', temporary_files_cleanup: 'PASS' } }, /required probe check oracle_inaccessible is missing/],
  ['only cleanup check', { checks: { temporary_files_cleanup: 'PASS' } }, /required probe check filesystem_containment is missing/],
  ['wrong scope', { scope: 'something-else' }, /scope must be dedicated-isolation-probe-only/],
  ['preflight-only report', { preflight_only: true }, /preflight_only must be false/],
  ['bootstrap diagnostic report', { profile_bootstrap_diagnostic_only: true }, /profile_bootstrap_diagnostic_only must be false/],
  ['missing scope flag', { profile_contract_import_diagnostic_only: undefined }, /profile_contract_import_diagnostic_only must be false/],
  ['wrong baseline', { baseline_sha256: 'd'.repeat(64) }, /baseline_sha256 does not match/],
  ['wrong runner', { runner_sha256: 'e'.repeat(64) }, /runner_sha256 does not match/],
];

for (const [name, overrides, pattern] of REPORT_REFUSALS) {
  test(`refuses a report with ${name}`, async () => {
    await withSyntheticReportFile(syntheticReport(overrides), (report, reportSha256) => {
      assert.throws(() => buildG2IsolationAttestation(report, reportSha256, reportSha256, EXPECTED), pattern);
    });
  });
}

test('refuses when expected hashes are missing', async () => {
  await withSyntheticReportFile(syntheticReport(), (report, reportSha256) => {
    assert.throws(() => buildG2IsolationAttestation(report, reportSha256, reportSha256, {}), /baseline_sha256 does not match/);
  });
});

test('the CLI accepts only --approve-report-sha256 <hex>', () => {
  const hex = 'f'.repeat(64);
  assert.deepEqual(parseArguments(['--approve-report-sha256', hex]), { approvedSha256: hex });
  assert.throws(() => parseArguments([]), /Usage/);
  assert.throws(() => parseArguments(['--approve-report-sha256']), /Usage/);
  assert.throws(() => parseArguments(['--other', hex]), /Usage/);
  assert.throws(() => parseArguments(['--approve-report-sha256', hex, '--force']), /Usage/);
});

const EVIDENCE_NAME = 'g2-isolation-evidence.json';

async function withTemporaryRepository(report, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'g2-attestation-repo-'));
  try {
    const diagnostics = path.join(root, 'runtime', 'diagnostics');
    await mkdir(diagnostics, { recursive: true });
    await writeFile(path.join(diagnostics, 'appcontainer-probe-report.json'), JSON.stringify(report));
    const baseline = Buffer.from('synthetic baseline');
    await writeFile(path.join(diagnostics, 'hardware-baseline.json'), baseline);
    const reportSha256 = createHash('sha256')
      .update(await readFile(path.join(diagnostics, 'appcontainer-probe-report.json')))
      .digest('hex');
    const baselineSha256 = createHash('sha256').update(baseline).digest('hex');
    await run({ root, diagnostics, reportSha256, baselineSha256 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the writer creates the evidence file only after the validator accepts it', async () => {
  await withTemporaryRepository(syntheticReport(), async (repo) => {
    const report = syntheticReport({ baseline_sha256: repo.baselineSha256 });
    await writeFile(path.join(repo.diagnostics, 'appcontainer-probe-report.json'), JSON.stringify(report));
    const reportSha256 = createHash('sha256')
      .update(await readFile(path.join(repo.diagnostics, 'appcontainer-probe-report.json')))
      .digest('hex');
    let validated = null;
    const evidenceSha256 = await writeG2IsolationAttestation(repo.root, reportSha256, {
      getFingerprint: async () => ({ sha256: RUNNER }),
      readAttestation: async (root) => {
        validated = JSON.parse(await readFile(path.join(root, 'runtime', 'diagnostics', EVIDENCE_NAME), 'utf8'));
        return { evidence_sha256: 'e'.repeat(64) };
      },
    });
    assert.equal(evidenceSha256, 'e'.repeat(64));
    assert.equal(
      validateG2IsolationAttestation(validated, { platform: 'win32', baseline_sha256: repo.baselineSha256, runner_sha256: RUNNER }),
      validated,
    );
  });
});

test('the writer refuses to overwrite an existing evidence file and leaves it unchanged', async () => {
  await withTemporaryRepository(syntheticReport(), async (repo) => {
    const report = syntheticReport({ baseline_sha256: repo.baselineSha256 });
    await writeFile(path.join(repo.diagnostics, 'appcontainer-probe-report.json'), JSON.stringify(report));
    const reportSha256 = createHash('sha256')
      .update(await readFile(path.join(repo.diagnostics, 'appcontainer-probe-report.json')))
      .digest('hex');
    const existing = path.join(repo.diagnostics, EVIDENCE_NAME);
    await writeFile(existing, 'existing evidence');
    await assert.rejects(
      writeG2IsolationAttestation(repo.root, reportSha256, {
        getFingerprint: async () => ({ sha256: RUNNER }),
        readAttestation: async () => ({ evidence_sha256: 'e'.repeat(64) }),
      }),
      { code: 'EEXIST' },
    );
    assert.equal(await readFile(existing, 'utf8'), 'existing evidence');
  });
});

test('the writer deletes the file it created when validation fails', async () => {
  await withTemporaryRepository(syntheticReport(), async (repo) => {
    const report = syntheticReport({ baseline_sha256: repo.baselineSha256 });
    await writeFile(path.join(repo.diagnostics, 'appcontainer-probe-report.json'), JSON.stringify(report));
    const reportSha256 = createHash('sha256')
      .update(await readFile(path.join(repo.diagnostics, 'appcontainer-probe-report.json')))
      .digest('hex');
    await assert.rejects(
      writeG2IsolationAttestation(repo.root, reportSha256, {
        getFingerprint: async () => ({ sha256: RUNNER }),
        readAttestation: async () => { throw new Error('validator rejected'); },
      }),
      /validator rejected/,
    );
    assert.equal((await readdir(repo.diagnostics)).includes(EVIDENCE_NAME), false);
  });
});

test('the writer creates no file when the approval does not match the report', async () => {
  await withTemporaryRepository(syntheticReport(), async (repo) => {
    await assert.rejects(
      writeG2IsolationAttestation(repo.root, 'a'.repeat(64), {
        getFingerprint: async () => ({ sha256: RUNNER }),
        readAttestation: async () => ({ evidence_sha256: 'e'.repeat(64) }),
      }),
      /does not match the probe report/,
    );
    assert.equal((await readdir(repo.diagnostics)).includes(EVIDENCE_NAME), false);
  });
});
