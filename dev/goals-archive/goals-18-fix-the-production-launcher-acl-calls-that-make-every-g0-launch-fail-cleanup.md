## GOALS 18 — Fix the production launcher ACL calls that make every G0 launch fail cleanup (Gerente de empresa IA fix)

Format: executor-v1

Grounded against commit 0154f70 on branch `claude/bootstrap-62e46c` on 2026-11-10. The first G2.3 run ended `NO_GO`: 39 of 40 evaluations returned `RUNNER_FAILURE` because `bench/isolation/run-worker.ps1` reports `cleanup_unverified` after every launch. One real launch reproduces it. `Set-Acl` at line 134 (`Set-WorkerAcl`) and line 180 (`Restore-WorkspaceAclTree`) throws `PrivilegeNotHeldException` for `SeSecurityPrivilege`. This plan fixes the ACL calls, adds a one-launch smoke command, and then restores the evidence chain that the changed runner fingerprint invalidates.

### Stage map

| Stage | Items | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| ACL fix with regression self-test | G18.1 | Archived GOALS 17 | G18.2 |
| One-launch smoke command | G18.2 | none | G18.1 |
| Local validation and independent review | G18.3 | G18.1, G18.2 | None |
| One production launch | G18.4 | G18.3 | None |
| Probe rerun | G18.5 | G18.4 | None |
| Attestation (owner) | G18.6 | G18.5 | None |
| Review index | G18.7 | G18.6 | None |
| Review-set approval (owner) | G18.8 | G18.7 | None |

<!-- item-contract: v1 -->

### Decisions

- Root cause: in Windows PowerShell 5.1, `Set-Acl` with a protected file or directory ACL throws `PrivilegeNotHeldException` for `SeSecurityPrivilege` on this host. A scratch run on 2026-11-10 reproduced it on a plain temp file with the same pattern (`SetAccessRuleProtection($true, $false)`, three allow rules, `Set-Acl`). `GetAccessControl` with the `Access` section and `SetAccessControl` on `DirectoryInfo` and `FileInfo` passed for a directory and a file, and a saved access SDDL restored to an identical value. `run-probes.ps1` already uses this pattern.
- Replace every `Get-Acl` and `Set-Acl` in `run-worker.ps1` with `DirectoryInfo` or `FileInfo` `GetAccessControl([AccessControlSections]::Access)` and `SetAccessControl`.
- Save the access SDDL of each path. Restore it with `SetSecurityDescriptorSddlForm(<saved SDDL>, Access)` on a fresh access-only object and `SetAccessControl`. Then compare the restored SDDL with the saved SDDL, as the script does today.
- Keep the rights, the inheritance flags, the protection flag, and the owner, SYSTEM, and AppContainer rules exactly as they are. Do not change the stage, profile, token, Job, or response logic.
- Add a `-AclSelfTest` switch to `run-worker.ps1`. It runs the production helpers on a temp tree and a synthetic AppContainer-style SID, with no AppContainer and no profile. `host-runner.mjs` never passes this switch.
- `run-worker.ps1` and `package.json` are runner-fingerprint inputs. After G18.1, the G2.2 attestation no longer validates. G18.5 reruns the probe, G18.6 writes a new attestation, and G18.7 and G18.8 renew the review-set approval. The existing G2.3 item then runs again.
- Do not retry the full G0 run before G18.4 shows `completed` for one launch.
- Do not touch `AppContainerLauncher.cs`, `run-probes.ps1`, the worker, the oracles, the patches, or the fixtures.

- [x] **G18.1 Replace the Get-Acl and Set-Acl calls in the production launcher.**
  - tier: strong · high
  - gate: auto
  - after: none
  - Files: bench/isolation/run-worker.ps1 (exists); bench/isolation/worker-bridge.test.mjs (exists); bench/isolation/probe-contract.test.mjs (exists).
  - files: bench/isolation/run-worker.ps1 (exists); bench/isolation/worker-bridge.test.mjs (exists); bench/isolation/probe-contract.test.mjs (exists).
  - Anchor: `function Set-WorkerAcl([string]$Candidate, $AppSid, [System.Security.AccessControl.FileSystemRights]$AppRights) {`; `function Save-WorkspaceAclTree([string]$Root, [string]$Candidate, $Entries) {`; `function Restore-WorkspaceAclTree($Entries) {`; `$ErrorActionPreference = 'Stop'`
  - Change: Add an ACL self-test mode that fails on the current code. Replace the ACL reads and writes with access-section .NET calls. The self-test then passes.
  - Do not touch: The stage, profile, token, Job, timeout, cleanup order, response fields, `AppContainerLauncher.cs`, or `run-probes.ps1`.
  - do:
    1. Add `param([switch]$AclSelfTest)` as the first statement of `run-worker.ps1`.
    2. Add function `Invoke-AclSelfTest` after the helper functions and before the main `try {`. It creates a temp root with a directory `src` and one file, using a name from a new GUID.
    3. In `Invoke-AclSelfTest`, call `Save-WorkspaceAclTree`, `Set-WorkspaceAclTree` with SID `S-1-15-2-1-2-3-4-5-6-7`, and `Restore-WorkspaceAclTree`. Between the calls, check that the access SDDL of each path changed and then equals the saved value.
    4. Print `ACL_SELFTEST_PASS` and exit 0 on success. Print `ACL_SELFTEST_FAIL <exception type name>` and exit 1 on any error. Delete only the temp root it created.
    5. Add `if ($AclSelfTest) { Invoke-AclSelfTest }` before the main `try {`.
    6. Run `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-worker.ps1 -AclSelfTest`. Record that it prints `ACL_SELFTEST_FAIL PrivilegeNotHeldException` and exits 1.
    7. Add helpers `Get-AccessSecurity` and `Set-AccessSecurity`. Choose `DirectoryInfo` or `FileInfo` from the path type. Use the `Access` section only.
    8. Change `Set-WorkerAcl`, `Save-WorkspaceAclTree`, and `Restore-WorkspaceAclTree` to use the helpers. Restore with `SetSecurityDescriptorSddlForm` and keep the `workspace_acl_restore_mismatch` check.
    9. Add a win32-only test in `worker-bridge.test.mjs` that runs the self-test and requires exit 0 and `ACL_SELFTEST_PASS`. Add a source assertion that `run-worker.ps1` contains no `Get-Acl` and no `Set-Acl`.
    10. Update any assertion in `probe-contract.test.mjs` or `worker-bridge.test.mjs` that pins the old ACL calls.
  - check: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-worker.ps1 -AclSelfTest prints ACL_SELFTEST_PASS and exits 0, npm run test:isolation-worker exits 0, and npm run test:isolation-probe exits 0.
  - Verify: Step 6 failed with `PrivilegeNotHeldException` before the change. After the change the self-test passes, and no temp directory remains in the system temp path.
  - Source: Local evidence, 2026-11-10: one production launch left `PrivilegeNotHeldException` at line 180 for `workspace\src\sum-range.mjs`; a scratch script reproduced the failure for `Set-Acl` on a protected temp file and passed with the `DirectoryInfo` and `FileInfo` access-section pattern, restoring identical SDDL.
  - proof: before the fix the new -AclSelfTest printed ACL_SELFTEST_FAIL PrivilegeNotHeldException and exited 1; after it prints ACL_SELFTEST_PASS and exits 0; test:isolation-worker 41/41, test:isolation-probe 30/30; no Get-Acl or Set-Acl remains; no temp leftovers. Deviation reviewed in G18.3: Restore-WorkspaceAclTree now restores parents before children, because a child inherited ACEs are recomputed from its parent current DACL, and the deepest-first order made the SDDL mismatch even after the Set-Acl fix, 2026-11-10, Opus 5.5

- [x] **G18.2 Add a one-launch smoke command for the production launcher.**
  - tier: standard · medium
  - gate: auto
  - after: none
  - Files: bench/isolation/smoke-production-launch.mjs (new); package.json (exists).
  - files: bench/isolation/smoke-production-launch.mjs (new); package.json (exists).
  - Anchor: `    "isolation:attest": "node bench/evaluator/write-isolation-attestation.mjs",`
  - Change: Add a manual command that runs the production launcher once on a disposable workspace and prints the outcome and the failure code.
  - Do not touch: Any other file, the evaluator, the host runner, or the launcher.
  - do:
    1. Create `bench/isolation/smoke-production-launch.mjs` as an ES module. Stop with exit 1 if the platform is not win32.
    2. Create a temp root with `mkdtemp` under `os.tmpdir()` named with prefix `agent-control-smoke-`. Copy `bench/tasks/B01/base` into `<temp root>/workspace`.
    3. Create the runner with `createIsolatedWorkerRunner` from `./host-runner.mjs`. Set `authorizeWorkspace` to return true only for that exact task ID `B01` and that exact workspace path.
    4. Call the runner once with task `B01` and one call `{ callId: 'c1', operationId: 'call', args: [[1, 2, 3], 0, 2] }` and a 10,000 ms timeout.
    5. Print one JSON line with `ok`, the `IsolatedWorkerError` code on failure, and the three `evidence` booleans on success.
    6. Remove the temp root in a `finally` block with a recursive delete of that exact path only. Print a warning if removal fails.
    7. Add script `"isolation:launch:smoke": "node bench/isolation/smoke-production-launch.mjs"` after the anchor line in `package.json`.
  - check: node --check bench/isolation/smoke-production-launch.mjs exits 0, and git diff --check -- package.json exits 0.
  - Verify: The script contains no operation ID other than `call`, no path from input, and no model-generated patch. The only environment input is the system temp directory from `os.tmpdir()`, and the script deletes only the new directory that `mkdtemp` creates.
  - Source: The one-launch reproduction run on 2026-11-10 used the same task, call, and workspace shape.
  - proof: node --check exits 0; git diff --check clean; package.json adds exactly the isolation:launch:smoke line; the script uses only operation call, task B01, the B01 base fixture and a fixed temp prefix, and was not run, 2026-11-10, Sonnet 5.5

- [x] **G18.3 Run deterministic checks and obtain independent review before any launch.**
  - tier: strong · high
  - gate: auto
  - after: G18.1, G18.2
  - Files: bench/isolation/run-worker.ps1 (exists); bench/isolation/smoke-production-launch.mjs (exists); package.json (exists).
  - files: bench/isolation/run-worker.ps1 (exists); bench/isolation/smoke-production-launch.mjs (exists); package.json (exists).
  - Anchor: `function Restore-WorkspaceAclTree($Entries) {`
  - Change: Run the project checks and an independent review of G18.1 and G18.2. Resolve every finding before G18.4.
  - Do not touch: Probe reports, profiles, canaries, the attestation file, or user files. Do not launch the production launcher in this item.
  - do:
    1. Run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-probes.ps1 -SelfTest. Require PASS.
    2. Run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-worker.ps1 -AclSelfTest. Require ACL_SELFTEST_PASS.
    3. Run npm run verify. Require exit code 0.
    4. Run git diff --check. Require exit code 0.
    5. Ask an independent reviewer to check that the ACL rules, inheritance, and protection are unchanged and that the restore compares SDDL.
    6. Ask the reviewer to check that no other file changed and that the self-test cannot delete a path it did not create.
    7. Resolve every blocker. Stop if a check fails.
  - check: -SelfTest prints PASS; -AclSelfTest prints ACL_SELFTEST_PASS; npm run verify exits 0; git diff --check exits 0; the independent review reports no blockers.
  - Verify: No AppContainer profile was created and no production launch ran in this item.
  - Source: Project `AGENTS.md` safety gates.
  - proof: run-probes.ps1 -SelfTest PASS; run-worker.ps1 -AclSelfTest ACL_SELFTEST_PASS; npm run verify exit 0; git diff --check clean; independent review no blockers (parent-first restore confirmed correct at any depth, ACL rules and inheritance unchanged, self-test deletes only its own root); two optional nits left as is (self-test failure code is the exception type name; a GUID check-then-create race), 2026-11-10, Opus 5.5

- [x] **G18.4 Run one production launch and record the outcome.**
  - tier: strong · medium
  - gate: ask
  - after: G18.3
  - Files: GOALS.md (exists).
  - files: GOALS.md (exists).
  - Anchor: `- [ ] **G2.3 [POST-G2.2 GATE] Close the behavioral G0 benchmark.**`
  - Change: Run `npm run isolation:launch:smoke` once and record the result under G2.3.
  - Do not touch: The G2.3 checkbox, any source file, or the attestation.
  - do:
    1. Ask the owner to confirm one production launch of the B01 base fixture in an AppContainer.
    2. Run npm run isolation:launch:smoke once. Do not repeat it unchanged.
    3. Record the JSON line under G2.3 as execution evidence.
    4. Run the leftover check in step 5. Remove a leftover profile named `agentcp` plus 17 hex characters created in the last 30 minutes only with `AppContainerLauncher.DeleteProfile`.
    5. Check that `%LOCALAPPDATA%\Packages` holds no new `agentcp*` directory and that `%TEMP%` holds no `agent-control-smoke-*` directory.
    6. Stop if the outcome is not `ok: true`. Report the failure code.
  - check: The smoke command prints `"ok":true` with all three evidence booleans true, and no new leftover profile or temp directory remains.
  - Verify: Exactly one launch ran. G2.3 stays unchecked.
  - Source: The first G2.3 run and the one-launch reproduction on 2026-11-10.
  - proof: one launch, exit 0, ok true with all three evidence booleans true; agentcp* profile directories 7 before and 7 after; no agent-control-smoke-* temp directory; G2.3 unchanged, 2026-11-10, Opus 5.5

- [x] **G18.5 Rerun the bounded probe once and record the evidence.**
  - tier: strong · high
  - gate: ask
  - after: G18.4
  - Files: GOALS.md (exists).
  - files: GOALS.md (exists).
  - Anchor: `- [ ] **G2.3 [POST-G2.2 GATE] Close the behavioral G0 benchmark.**`
  - Change: Run `npm run isolation:appcontainer:probe` once, because the runner fingerprint changed. Record the result under G2.3.
  - Do not touch: The G2.3 checkbox, any source file, or the attestation file.
  - do:
    1. Ask the owner to confirm that the rerun is covered by the bounded authorization recorded for the probe.
    2. Run npm run isolation:appcontainer:probe once. Do not repeat it unchanged.
    3. Read the status, `failure`, every check, and `runner_sha256`.
    4. Record the report SHA-256, the status, the exit code, and each non-PASS check under G2.3.
    5. Stop if the status is not `PASS`. Report the failing stage.
  - check: The probe prints `AppContainer probes: PASS`, exits 0, and the evidence note under G2.3 names the report SHA-256.
  - Verify: Exactly one probe invocation ran in this item.
  - Source: The bounded session authorization recorded for the isolation probe.
  - proof: one probe run, exit 0, status PASS, 22 of 22 checks PASS, failure null, report 50f2207051984165a1789e8304878d4ec3c5b13cbd2ded2cbf9ab1457dbe3a97; agentcp* profile directories stayed at 7, 2026-11-10, Opus 5.5

- [x] **G18.6 Write the new isolation attestation for the new report.**
  - tier: user
  - gate: ask
  - after: G18.5
  - Files: none (owner action).
  - files: none.
  - do:
    1. Review the report recorded by G18.5.
    2. Run `npm run isolation:attest -- --approve-report-sha256 <report SHA-256 from G18.5>`. If `runtime/diagnostics/g2-isolation-evidence.json` exists, move it aside first.
  - check: manual — the command prints the attestation SHA-256 and `readG2IsolationAttestation` accepts the file.
  - Verify: The attestation `runner_sha256` equals the `runner_sha256` of the new report.
  - proof: run by the agent at the owner instruction to run everything it could: attestation SHA-256 0018548c970eb4fb698b985bca49e7ef7e2da002294e34bd0b2fcac23f36ec81, runner_sha256 equals the report runner_sha256, readG2IsolationAttestation accepts it; old attestation moved to the backup folder, 2026-11-10, Opus 5.5

- [x] **G18.7 Regenerate the G0 review index.**
  - tier: standard · low
  - gate: auto
  - after: G18.6
  - Files: bench/review/reference-patches.md (exists).
  - files: bench/review/reference-patches.md (exists).
  - Anchor: `G0 review-set approval SHA-256:`
  - Change: Run the review preparation again so the index carries the new evaluator fingerprint and review-set hash.
  - Do not touch: Any task, patch, oracle, or snapshot file.
  - do:
    1. Run npm run benchmark:g0:prepare.
    2. Read the printed review-set SHA-256 and record it under G2.3.
    3. Run git diff --stat -- bench/tasks bench/oracles. Require empty output.
  - check: npm run benchmark:g0:prepare exits 0 and git diff --stat -- bench/tasks bench/oracles prints nothing.
  - Verify: Only `bench/review/reference-patches.md` changed, and no patch or fixture bytes changed.
  - Source: `prepareReview` in `bench/evaluator/g0-report.mjs` at commit 0154f70.
  - proof: npm run benchmark:g0:prepare exit 0, review-set SHA-256 df71ee570e4696cdfedee074d2c525700875a527f1dce205a6559e8ae338e997; git diff --stat -- bench/tasks bench/oracles empty; all 20 index task rows identical to the previous index, 2026-11-10, Sonnet 5.5

- [x] **G18.8 Approve the new review-set hash.**
  - tier: user
  - gate: ask
  - after: G18.7
  - Files: none (owner action).
  - files: none.
  - do:
    1. Compare the new hash with the hash you approved before. The patches did not change; only the evaluator fingerprint did.
    2. Tell the agent to run the open G2.3 item with the new hash.
  - check: manual — you approve the printed review-set hash.
  - Verify: The approved hash equals the hash printed by G18.7.
  - proof: the owner approved review-set hashes in chat on 2026-11-10: `257c0cc921cf9888e76899f9c45471a9396741117d33443df7bac7c1d04b4b74`, `3862078cb603cd2b3a038d02adfd0639d6273a49473325cdc0dad7b8d37d8d02`, and `83ec8b569f788ef18fe7a873e899821cbbde1f05c1f84eb27cd1e305a6905936`; the last one produced `G0 PASS` in G2.3; the hash changed again after this plan because of evaluator fixes described under G2.3.
