## GOALS 17 — Fix the probe final status, the host-test input headroom, and the G2.2 attestation path (Gerente de empresa IA fix)

Format: executor-v1

Grounded against commit 1d9e00e on branch `claude/bootstrap-62e46c` on 2026-11-09. The full probe passes 22 of 22 checks but always reports `status=BLOCKED`, the host process-tree test input is 16,108 of 16,384 bytes, and no code writes the G2.2 attestation that `bench/evaluator/isolation-attestation.mjs` reads. This plan fixes those defects, adds a rule against broad process kills, reruns the probe once, and leaves the attestation approval and Git alignment to the owner.

### Stage map

| Stage | Items | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| Probe final status | G17.1 | Archived GOALS 16 | G17.3, G17.4 |
| Host-test input headroom | G17.2 | G17.1 | G17.3, G17.4 |
| Process-kill rule | G17.3 | none | G17.1, G17.2, G17.4 |
| Attestation writer | G17.4 | none | G17.1, G17.2, G17.3 |
| Local validation and independent review | G17.5 | G17.1–G17.4 | None |
| Bounded probe rerun | G17.6 | G17.5 | None |
| Owner attestation approval | G17.7 | G17.6 | G17.8, G17.9 |
| Owner Git alignment | G17.8 | none | G17.7, G17.9 |
| Owner context map refresh | G17.9 | G17.8 | G17.7 |

<!-- item-contract: v1 -->

### Decisions

- Root cause of the status defect: `run-probes.ps1` sets `$report.status = Get-ProbeFinalStatus $checkValues` at the end of the `try` block. At that point `appcontainer_profile_cleanup` and `temporary_files_cleanup` still hold their initial `UNKNOWN`. The `finally` block sets them later, and the final block after it can only lower the status. So a clean run cannot print `PASS`.
- Fix the status with one function, `Get-ProbeReportFinalStatus`, called once after the cleanup checks are set. It returns `PASS` only when the full probe reached the end of the `try` block, no failure is recorded, and every check is `PASS`. It never changes `gate_status` or `g2_2_attestation`.
- Keep the diagnostic-only modes on their current statuses. They never reach the end of the full probe path.
- Fix the host-test headroom by sending each embedded script once. Use host-test input `schema_version: 2` with `child_script`, `grandchild_script`, and per-case `child_role` and `grandchild_role`. The runner builds the five arguments itself. Reject `schema_version: 1`. Keep the 16,384-byte input limit and the existing hash pins.
- Do not raise the 16,384-byte limit. The base64 input travels on a PowerShell command line, and Windows limits a command line to 32,767 characters.
- The attestation is the existing file `runtime/diagnostics/g2-isolation-evidence.json`, with the schema that `validateG2IsolationAttestation` enforces. A new writer creates it from the probe report only when the owner passes the report SHA-256 on the command line. The probe script must not write it, because `probe-contract.test.mjs` asserts that it never names that file.
- `package.json`, `run-probes.ps1`, and the evaluator files feed `getRuntimeFingerprint`. Any change to them changes `runner_sha256`. Therefore G17.6 reruns the probe after every code change, and the attestation must use that new report.
- The broad process kill that happened during GOALS 16 cannot be undone. Prevent a repeat with a rule in `AGENTS.md`.
- Do not mark G6.13 or G2.2 in this plan. The owner marks them after G17.7.

### Fix — probe status and host-test input

- [x] **G17.1 Make the full probe report PASS when every check passes.**
  - tier: strong · high
  - gate: auto
  - after: none
  - Files: bench/isolation/run-probes.ps1 (exists); bench/isolation/probe-contract.test.mjs (exists).
  - files: bench/isolation/run-probes.ps1 (exists); bench/isolation/probe-contract.test.mjs (exists).
  - Anchor: `    $report.status = Get-ProbeFinalStatus $checkValues`; `    if ($PreflightOnly) { $report.status = 'BLOCKED' }`; `    if ((Get-ProbeFinalStatus @('PASS', 'PASS')) -ne 'PASS' -or`
  - Change: Record that the full probe path completed. Replace the three-line final status block with one call to a new function that can also return `PASS`.
  - Do not touch: `Get-ProbeFinalStatus`, any `Set-Check` call, cleanup logic, `gate_status`, `g2_2_attestation`, diagnostic-only modes, hash pins, or the launcher.
  - do:
    1. Repro: write a regression test in `probe-contract.test.mjs` that runs `run-probes.ps1 -SelfTest` and requires the new synthetic message `Synthetic final report status self-test failed.` to be absent with exit code 0. Run it before the fix and record that the new self-test cases do not exist yet.
    2. Initialize `$fullProbeChecksComputed = $false` beside the other script-scope state near `$stageNode = $null`.
    3. Set `$fullProbeChecksComputed = $true` on the line after `$report.status = Get-ProbeFinalStatus $checkValues`.
    4. Add function `Get-ProbeReportFinalStatus([bool]$PreflightOnly, [bool]$ChecksComputed, $Failure, [object[]]$Values)` beside `Get-ProbeFinalStatus`.
    5. Return `BLOCKED` if `$PreflightOnly`. Return `FAIL` if any value is `FAIL`. Return `BLOCKED` if any value is `BLOCKED` or `UNKNOWN`.
    6. Return `PASS` only if `$ChecksComputed` is true, `$Failure` is `$null`, and every value is `PASS`. Otherwise return `BLOCKED`.
    7. Replace the three lines that start at `    if ($PreflightOnly) { $report.status = 'BLOCKED' }` with one assignment that calls the new function with `@($report.checks.Values)`.
    8. Add `-SelfTest` cases beside the `Get-ProbeFinalStatus` cases. Cover all-PASS with completion, all-PASS without completion, all-PASS with a failure, one `UNKNOWN`, one `FAIL`, and preflight. Throw `Synthetic final report status self-test failed.` on any mismatch.
    9. Add a source assertion in `probe-contract.test.mjs` that the final block calls `Get-ProbeReportFinalStatus` and that `report-write` failure still sets `BLOCKED`.
  - check: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-probes.ps1 -SelfTest prints PASS, and npm run test:isolation-probe exits 0.
  - Verify: The synthetic all-PASS-with-completion case returns `PASS`. Every other synthetic case returns `BLOCKED` or `FAIL`. `gate_status` and `g2_2_attestation` assignments are unchanged.
  - Source: Code reading of `run-probes.ps1` at commit 1d9e00e: status assignment at the end of the `try` block, cleanup `Set-Check` calls in `finally`, and the lowering-only final block before `Write-SafeReport`.
  - proof: -SelfTest PASS (six new synthetic status cases); test:isolation-probe 30/30; Get-ProbeReportFinalStatus is the only status writer after cleanup; gate_status and g2_2_attestation lines unchanged; the step 1 repro test passed vacuously because the new self-test cases did not exist before the fix, 2026-11-09, Opus 5.5

- [x] **G17.2 Send each host-test script once so the input keeps headroom.**
  - tier: strong · high
  - gate: auto
  - after: G17.1
  - Files: bench/isolation/run-probes.ps1 (exists); bench/isolation/worker-bridge.test.mjs (exists).
  - files: bench/isolation/run-probes.ps1 (exists); bench/isolation/worker-bridge.test.mjs (exists).
  - Anchor: `        if (-not (Test-ExactHostTestJsonProperties $hostTestInput @('schema_version', 'node_path', 'cases')) -or`; `            if (-not (Test-ExactHostTestJsonProperties $case @('name', 'timeout_ms', 'arguments')) -or`; `      { name: 'timeout', timeout_ms: 5_000, arguments: buildProcessTreeChildArguments('child') },`
  - Change: Replace host-test input schema 1 with schema 2. The root holds both scripts once. Each case holds only its name, timeout, and two roles.
  - Do not touch: The 16,384-byte input limit, the 32,768-character base64 limit, `$scriptHashChild`, `$scriptHashGrandchild`, the expected names, roles, and timeouts, the per-case directory logic, or the launcher.
  - do:
    1. Repro: add an assertion in `worker-bridge.test.mjs` that the input sent to `run-probes.ps1` is at most 12,288 UTF-8 bytes. Run it before the fix and record the failure at 16,108 bytes.
    2. Require root properties exactly `schema_version`, `node_path`, `child_script`, `grandchild_script`, and `cases`. Require `schema_version` to equal 2.
    3. Require `child_script` and `grandchild_script` to be strings whose SHA-256 equals `$scriptHashChild` and `$scriptHashGrandchild`.
    4. Require each case to have exactly `name`, `timeout_ms`, `child_role`, and `grandchild_role`. Keep the existing name, timeout, and role checks.
    5. Build each case argument array as `-e`, `child_script`, `child_role`, `grandchild_script`, `grandchild_role`.
    6. Reject any other `schema_version` with `Host-test root schema is invalid.`
    7. In `worker-bridge.test.mjs`, build the schema 2 input from `buildProcessTreeChildArguments('child')`. Take the scripts from index 1 and index 3.
    8. Add a test that a schema 1 input makes `run-probes.ps1 -ProcessTreeHostTestOnly` exit non-zero.
  - check: npm run test:isolation-worker exits 0 and npm run test:isolation-probe exits 0.
  - Verify: The schema 2 input is at most 12,288 bytes. The host process-tree test still passes with 4 Job processes and 2 console hosts in the timeout case.
  - Source: Windows limits a command line to 32,767 characters: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw (lpCommandLine). Accessed 2026-11-09. Measured input size 16,108 bytes at commit 1d9e00e.
  - proof: repro failed at 16108 bytes before the fix; after it the input is 8235 bytes (limit 12288); test:isolation-worker 39/39 (twice), test:isolation-probe 30/30, -SelfTest PASS; timeout case still 4 Job processes and 2 console hosts; no temp leftovers; schema 1 is rejected, 2026-11-09, Opus 5.5

### Fix — operating rule

- [x] **G17.3 Forbid broad process kills in the project instructions.**
  - tier: light · low
  - gate: auto
  - after: none
  - Files: AGENTS.md (exists).
  - files: AGENTS.md (exists).
  - Anchor: `- Preserve user files and research artifacts. Never stage, commit, or publish automatically.`
  - Change: Add one rule line directly above the anchor line.
  - Do not touch: Any other line of `AGENTS.md`.
  - do:
    1. Insert this exact line above the anchor: `- Never run a broad process kill such as \`taskkill /IM\`, \`taskkill /F /IM node.exe\`, or \`Stop-Process -Name\`. Stop only a process this task started, by its handle or PID.`
  - check: git diff --check -- AGENTS.md exits 0, and grep -c "Never run a broad process kill" AGENTS.md prints 1.
  - Verify: The diff of `AGENTS.md` adds exactly one line.
  - Source: GOALS 16 execution record: an executor ran `taskkill /F /IM node.exe` during a host check on 2026-11-09.
  - proof: git diff --check clean; grep count 1; diff adds exactly 1 line to AGENTS.md, 2026-11-09, Sonnet 5.5

### Fix — attestation path

- [x] **G17.4 Add an owner-approved writer for the G2.2 isolation attestation.**
  - tier: strong · high
  - gate: auto
  - after: none
  - Files: bench/evaluator/write-isolation-attestation.mjs (new); bench/evaluator/write-isolation-attestation.test.mjs (new); package.json (exists).
  - files: bench/evaluator/write-isolation-attestation.mjs (new); bench/evaluator/write-isolation-attestation.test.mjs (new); package.json (exists).
  - Anchor: `    "test:evaluator:host-harness": "node --test bench/evaluator/host-harness.test.mjs",`
  - Change: Add a command that builds `runtime/diagnostics/g2-isolation-evidence.json` from the probe report only with an explicit owner approval argument.
  - Do not touch: bench/evaluator/isolation-attestation.mjs, bench/evaluator/runtime-fingerprint.mjs, bench/isolation/run-probes.ps1, or the probe report.
  - do:
    1. Export `buildG2IsolationAttestation(report, reportSha256, approvedSha256, expected)` from the new module. It returns the attestation object or throws.
    2. Throw unless `approvedSha256` is lowercase 64-hex and equals `reportSha256`.
    3. Throw unless `report.status` is `PASS`, `report.failure` is `null`, `report.platform` is `Win32NT`, and every value in `report.checks` is `PASS`.
    4. Throw unless `report.baseline_sha256` and `report.runner_sha256` equal `expected.baseline_sha256` and `expected.runner_sha256`.
    5. Return keys `schema_version: 1`, `status: 'PASS'`, `verified_at: report.generated_at`, `platform: 'win32'`, `baseline_sha256`, `runner_sha256`, `mechanism: 'AppContainer + Job Object via bench/isolation/run-probes.ps1'`, and `checks` with the four `G2_ISOLATION_REQUIRED_CHECKS` set to `true`.
    6. Add a CLI entry that takes only `--approve-report-sha256 <hex>`. It reads `runtime/diagnostics/appcontainer-probe-report.json` and `runtime/diagnostics/hardware-baseline.json`, and calls `getRuntimeFingerprint`.
    7. Write the file with flag `wx`. Stop with exit code 1 if it exists. Then call `readG2IsolationAttestation`. Delete the written file and exit 1 if validation throws.
    8. Print the attestation file SHA-256 on success.
    9. Add script `"isolation:attest": "node bench/evaluator/write-isolation-attestation.mjs"` and `"test:evaluator:attestation": "node --test bench/evaluator/write-isolation-attestation.test.mjs"`. Append `&& npm run test:evaluator:attestation` to `test:benchmark-contract`.
    10. Test every refusal in steps 2–4. Test that a valid synthetic report produces an object that `validateG2IsolationAttestation` accepts.
  - check: npm run test:evaluator:attestation exits 0, and npm run test:benchmark-contract exits 0.
  - Verify: No test writes to `runtime/diagnostics/`. A report with any non-PASS check or a wrong approval hash is refused.
  - Source: Schema enforced by `validateG2IsolationAttestation` and `readG2IsolationAttestation` in `bench/evaluator/isolation-attestation.mjs` at commit 1d9e00e.
  - proof: test:evaluator:attestation 16/16; test:benchmark-contract exit 0 (executor run); runtime/diagnostics/g2-isolation-evidence.json absent; edits limited to the two new files and package.json, 2026-11-09, Opus 5.5

### Regression test — validation and probe rerun

- [x] **G17.5 Run deterministic checks and obtain independent review before the probe rerun.**
  - tier: strong · high
  - gate: auto
  - after: G17.1, G17.2, G17.3, G17.4
  - Files: bench/isolation/run-probes.ps1 (exists); bench/evaluator/write-isolation-attestation.mjs (exists); AGENTS.md (exists).
  - files: bench/isolation/run-probes.ps1 (exists); bench/evaluator/write-isolation-attestation.mjs (exists); AGENTS.md (exists).
  - Anchor: `function Get-ProbeReportFinalStatus(`
  - Change: Run the project checks and an independent review of G17.1–G17.4. Resolve every finding before G17.6.
  - Do not touch: Probe reports, profiles, canaries, `runtime/diagnostics/g2-isolation-evidence.json`, or user files. Do not run the full probe in this item.
  - do:
    1. Run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-probes.ps1 -SelfTest. Require PASS.
    2. Run npm run verify. Require exit code 0.
    3. Run git diff --check. Require exit code 0.
    4. Ask an independent reviewer to check that `PASS` requires completion, no failure, and all checks `PASS`.
    5. Ask the reviewer to check that the writer refuses every invalid report and never runs without the approval argument.
    6. Resolve every blocker. Stop if a check fails.
  - check: -SelfTest prints PASS; npm run verify exits 0; git diff --check exits 0; the independent review reports no blockers.
  - Verify: No probe, candidate, patch, benchmark task, oracle case, or model ran in this item.
  - Source: Project `AGENTS.md` safety gates.
  - proof: -SelfTest PASS; npm run verify exit 0; git diff --check clean; independent review found one defect (attestation writer did not require the four required checks, scope, or the diagnostic-only flags to be present) fixed with 6 new refusal tests, test:evaluator:attestation 22/22; status, host-test schema 2, gate flags and AGENTS.md line confirmed without blockers; writeG2IsolationAttestation I/O path still has no automated test, 2026-11-09, Opus 5.5

- [x] **G17.6 Rerun the bounded probe once and record the evidence.**
  - tier: strong · high
  - gate: ask
  - after: G17.5
  - Files: GOALS.md (exists).
  - files: GOALS.md (exists).
  - Anchor: `- [ ] **G6.13 [MANUAL] Run and review the full isolation probe.**`
  - Change: Run `npm run isolation:appcontainer:probe` once, because the code and the runner fingerprint changed. Record the result under G6.13.
  - Do not touch: G6.13 or G2.2 checkboxes, any source file, or `runtime/diagnostics/g2-isolation-evidence.json`.
  - do:
    1. Ask the owner to confirm that the rerun is covered by the bounded authorization recorded under G6.13.
    2. Run npm run isolation:appcontainer:probe once. Do not repeat it unchanged.
    3. Read the report status, `failure`, every check, and `runner_sha256`.
    4. Record the report SHA-256, the status, the exit code, and each non-PASS check under G6.13.
    5. Stop if the status is not `PASS`. Report the failing stage.
  - check: The probe prints `AppContainer probes: PASS`, exits 0, and the evidence note under G6.13 names the report SHA-256.
  - Verify: Exactly one probe invocation ran. Neither G6.13 nor G2.2 changed state.
  - Source: The bounded session authorization recorded under G6.13.
  - proof: one invocation, exit 0, status PASS, 22 of 22 checks PASS, failure null, report 0a1dc747a282f57f21584b5af1bc878fb999b8ed519c1b392a3638d1a12eabbc; G6.13 and G2.2 unchanged; attestation file not created, 2026-11-09, Sonnet 5.5

### Owner work

- [ ] **G17.7 Review the new report and write the attestation.**
  - tier: user
  - gate: ask
  - after: G17.6
  - Files: none (owner action).
  - files: none.
  - do:
    1. Review the report recorded by G17.6.
    2. Run `npm run isolation:attest -- --approve-report-sha256 <report SHA-256 from G17.6>`.
    3. Mark G6.13 and G2.2 only after the command succeeds and the review is complete.
  - check: manual — the command prints the attestation SHA-256 and `runtime/diagnostics/g2-isolation-evidence.json` exists.
  - Verify: `npm run isolation:attest` exits 0 and `readG2IsolationAttestation` accepts the file.

- [ ] **G17.8 Bring the main checkout to the committed branch.**
  - tier: user
  - gate: ask
  - after: none
  - Files: none (owner action).
  - files: none.
  - do:
    1. In `<repository>`, run `git switch -c backup/main-wip-2026-11-09`.
    2. Run `git add -A` and `git commit -m "wip: main checkout state before alignment"`.
    3. Run `git switch main` and `git merge --ff-only claude/bootstrap-62e46c`.
  - check: manual — `git status` in the main checkout is clean and `git log -1` shows the branch commit.
  - Verify: Branch `backup/main-wip-2026-11-09` holds the previous uncommitted main state, and `main` points at the branch commit.

- [ ] **G17.9 Refresh the context map after alignment.**
  - tier: user
  - gate: ask
  - after: G17.8
  - Files: none (owner action).
  - files: none.
  - do:
    1. Run `/bootstrap` in the main checkout.
  - check: manual — `graphify-out/graph.html` opens and the report lists the current files.
  - Verify: `graphify-out/` is regenerated in the main checkout and stays out of Git.
