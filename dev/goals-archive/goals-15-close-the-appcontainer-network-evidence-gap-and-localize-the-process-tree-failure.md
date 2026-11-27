## GOALS 15 — Close the AppContainer network-evidence gap and localize the process-tree failure (Gerente de empresa IA feature)

Format: executor-v1

Grounded against commit 4438128 and the current uncommitted workspace on 2026-11-06. G14.3 observed zero worker network capabilities, no loopback exemption, successful host control, and ETIMEDOUT; it recorded process-tree 0x80070057 without a snapshot. Microsoft documents that AppContainers without network capability cannot access networks; this plan adds token-bound proof and process-tree diagnostics without treating ETIMEDOUT alone as proof.

### Stage map

| Stage | Items | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| Network policy proof | G15.1 | Archived G14.2–G14.3 evidence | None |
| Process-tree failure localization | G15.2 | Archived G14.1/G14.3 evidence, G15.1 | None |
| Evidence documentation | G15.3 | G15.1–G15.2 | None |
| Local validation and independent review | G15.4 | G15.1–G15.3 | None |

<!-- item-contract: v1 -->

### Decisions

- Bind network evidence to the verified primary token and this run's AppContainer SID.
- Derive only the fixed internetClient, internetClientServer, and privateNetworkClientServer capability SIDs. Compare them in memory. Never report capability names or SIDs.
- Require the verified worker token and Job membership for network_denied.
- Require zero network capability SIDs and no loopback exemption for the same SID.
- Require successful host control, the current 127.0.0.1 target, and no accepted worker connection.
- Keep ETIMEDOUT alone as UNKNOWN. Treat an accepted worker connection as FAIL.
- Keep explicit EACCES or EPERM denial as PASS only when token, Job membership, and host control pass. Treat incomplete token, SID derivation, listener, helper, or transport evidence as UNKNOWN.
- Record process-tree stage, allowlisted exception type, and numeric error only. Do not assume the timeout snapshot caused the exception. Preserve fail-closed Job termination and drain behavior.
- Keep G6.13 and G2.2 closed until the changed-code probe and owner review pass. Do not run candidate code, patches, task tests, or model inference.

- [x] **G15.1 Classify network denial from the verified worker token and bounded listener evidence.**
  - tier: strong · xhigh
  - gate: auto
  - after: none
  - Files: bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/probe-contract.test.mjs (exists).
  - files: bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/probe-contract.test.mjs (exists).
  - Anchor: private static TokenCapabilitiesEvidence ReadTokenCapabilities(IntPtr token); function Get-NetworkDeniedStatus($Observation, [bool]$WorkerRan, [bool]$ListenerAccepted).
  - Change: Add a token-bound count of the three known network capability SIDs. Use this evidence with the existing same-SID loopback observation and host control to classify the fixed loopback test. Keep transport status separate from policy status.
  - Do not touch: Firewall rules, ACLs, AppContainer capabilities, loopback-exemption settings, external network, profiles, or G2.2 status.
  - do:
    1. Derive the three fixed capability SIDs with DeriveCapabilitySidsFromName after the worker token and AppContainer SID checks pass.
    2. Validate returned arrays and counts. Compare bounded TokenCapabilities entries with each derived SID in memory.
    3. Free every returned SID and array with LocalFree. Treat malformed data or cleanup failure as UNKNOWN.
    4. Report only the matching count, query status, and numeric error. Never report raw SIDs or capability names.
    5. Update Get-NetworkDeniedStatus to require the verified token, Job membership, policy, and listener evidence defined in Decisions.
    6. Return PASS for ETIMEDOUT only when every required token, capability, exemption, host-control, target, and no-accept check passes.
    7. Keep a lone ETIMEDOUT, an incomplete query, an exemption, or failed host control as UNKNOWN.
    8. Keep accepted connections as FAIL. Keep explicit EACCES or EPERM as PASS only when the worker and host control are verified.
    9. Add synthetic cases for every pass, fail, and unknown branch. Assert that reports contain no SID or capability name.
  - check: npm run test:isolation-probe exits 0. Synthetic cases prove each classifier branch and all report-redaction checks pass.
  - Verify: The timeout alone never returns PASS. A missing or failed SID derivation never returns PASS. The matching network-capability count is zero in the approved denial case.
  - Source:
    - Microsoft states that an AppContainer without network capability cannot access the network: https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer. Accessed 2026-11-06.
    - DeriveCapabilitySidsFromName returns capability SIDs. The caller frees each SID and array with LocalFree: https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-derivecapabilitysidsfromname. Accessed 2026-11-06.
    - Microsoft lists network capability names at https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations. Accessed 2026-11-06.
    - NetworkIsolationGetAppContainerConfig returns the loopback exemption list: https://learn.microsoft.com/en-us/windows/win32/api/networkisolation/nf-networkisolation-networkisolationgetappcontainerconfig. Accessed 2026-11-06.
  - proof: npm run test:isolation-probe (27/27); run-probes.ps1 -SelfTest (PASS); independent G15.1 review clear, 2026-11-07, Codex.

- [x] **G15.2 Report the process-tree failure stage and preserve timeout cleanup.**
  - tier: strong · xhigh
  - gate: auto
  - after: G15.1
  - Files: bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/probe-contract.test.mjs (exists).
  - files: bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/probe-contract.test.mjs (exists).
  - Anchor: private static AppContainerRunResult RunNodeCore(
  - Change: Add fixed stage fields around argument construction, process creation, token verification, timeout query, snapshot, termination, root signal, Job drain, output, and cleanup. Preserve the current fail-closed catch. A snapshot exception must produce UNKNOWN and must not skip termination or drain.
  - Do not touch: Process limits, timeout values, unrelated profiles, process identifiers in reports, task fixtures, or G2.2 status.
  - do:
    1. Set an allowlisted stage before each process-tree launch and timeout operation.
    2. Record only the stage, an allowlisted exception type, and a numeric HRESULT or Win32 code.
    3. Catch snapshot exceptions locally. Record UNKNOWN, then continue the mandatory Job termination and drain path.
    4. Preserve the outer cleanup catch for failures outside snapshot collection. Do not suppress its errors.
    5. Add a synthetic timeout seam that injects ArgumentException during snapshot collection.
    6. Assert that the injected failure records JOB_SNAPSHOT, requests Job termination, confirms root signal, and drains the Job.
    7. Assert that incomplete member evidence never passes process-tree termination and reports contain no PIDs, paths, or exception messages.
  - check: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-probes.ps1 -SelfTest exits 0 and prints PASS.
  - Verify: The synthetic snapshot failure produces UNKNOWN member evidence. Job termination and drain still run. The report identifies a stage without claiming that stage caused G14.3.
  - Source: G14.3 report SHA-256 2b35623523c6b12766c03df8f4b5c7b6e3a9ba0be9532617f14aeca13f2b7ec3. The current RunNodeCore catch performs fail-closed termination and drain after an exception.
  - proof: run-probes.ps1 -SelfTest PASS; probe-contract 27/27; synthetic JOB_SNAPSHOT seam verified (snapshot,terminate,root-signal,drain), 2026-11-09, Opus 5.5

- [x] **G15.3 Document the revised network evidence and process-tree diagnostics.**
  - tier: standard · medium
  - gate: auto
  - after: G15.1, G15.2
  - Files: bench/isolation/README.md (exists).
  - files: bench/isolation/README.md (exists).
  - Anchor: The report records policy, host-control, and worker-transport evidence separately.
  - Change: Document the exact conditions for network_denied PASS, FAIL, and UNKNOWN. Explain that ETIMEDOUT alone is inconclusive and capability absence is tied to the verified worker token. Document process-tree stage fields and redaction limits.
  - Do not touch: Probe behavior, profiles, ACLs, firewall configuration, or benchmark policy.
  - do:
    1. State that network capability evidence comes from the verified worker primary token.
    2. List all conditions required for policy-backed PASS and the cases that remain UNKNOWN.
    3. State that loopback exemption absence alone does not prove effective network denial.
    4. Document the fixed process-tree stages and the absence of raw identifiers and exception messages.
    5. Cite each Microsoft API and capability claim with its direct documentation URL.
  - check: git diff --check -- bench/isolation/README.md exits 0. The documentation separates policy evidence from transport evidence.
  - Verify: The README does not claim that a lone timeout or loopback-exemption result proves denial.
  - Source:
    - Microsoft documents AppContainer network isolation at https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer. Accessed 2026-11-06.
    - Microsoft documents the loopback exemption list at https://learn.microsoft.com/en-us/windows/win32/api/networkisolation/nf-networkisolation-networkisolationgetappcontainerconfig. Accessed 2026-11-06.
  - proof: git diff --check clean; README separates policy/host-control/transport evidence, independent review fixes applied, 2026-11-09, Opus 5.5

- [x] **G15.4 Run deterministic checks and obtain independent review before G6.13.**
  - tier: strong · high
  - gate: auto
  - after: G15.1, G15.2, G15.3
  - Files: bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/probe-contract.test.mjs (exists).
  - files: bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/probe-contract.test.mjs (exists).
  - Anchor: npm run verify; npm run test:isolation-probe; npm run test:isolation-worker; G6.13.
  - Change: Run the deterministic project checks and independent review. Resolve every finding before using the existing bounded authorization for G6.13.
  - Do not touch: Ignored runtime reports, profiles, canaries, or user files. Do not run the full probe in this item.
  - do:
    1. Run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-probes.ps1 -SelfTest. Require PASS.
    2. Run npm run verify and require exit code 0.
    3. Run git diff --check on the three code and test files listed above. Require exit code 0.
    4. Ask an independent reviewer to inspect the code, synthetic evidence, and README claims.
    5. Resolve every blocker. Stop if a check fails or the reviewer finds an unsupported network claim.
    6. Leave G6.13 and G2.2 unchecked until their own evidence and review pass.
  - check: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-probes.ps1 -SelfTest prints PASS; npm run verify exits 0; git diff --check exits 0; independent review reports no blockers.
  - Verify: No candidate, patch, benchmark task, oracle case, evaluator case, model, or live probe ran in this item.
  - Source: Project AGENTS.md safety gates and the existing bounded session authorization recorded under G6.13.
  - proof: SelfTest PASS; npm run verify exit 0 (177/177 + benchmark suites); git diff --check clean; independent review no remaining blockers; no probe/candidate/oracle ran, 2026-11-09, Opus 5.5
