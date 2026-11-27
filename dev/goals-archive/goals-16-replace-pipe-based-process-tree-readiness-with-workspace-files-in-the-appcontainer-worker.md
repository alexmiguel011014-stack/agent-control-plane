## GOALS 16 — Replace pipe-based process-tree readiness with workspace files in the AppContainer worker (Gerente de empresa IA feature)

Format: executor-v1

Grounded against the current uncommitted workspace on 2026-11-09. The latest G6.13 probe passed every check except `process_tree_terminated` and `child_process_tree_terminated`. The worker emitted `CHILD_SPAWN_CALL_BEGIN` and never returned from `child_process.spawn`. Diagnosis in a disposable scratch copy (project files unchanged): inside the AppContainer worker, `spawn` blocks whenever any stdio slot is `pipe` or `ipc`, with or without `windowsHide`. It returns at once and the child exits 0 with `stdio: ignore`, `inherit`, or a file descriptor opened in the workspace. A second scratch run proved the replacement: a child that writes one JSON line to a workspace file and a grandchild that does the same were both read by the worker within about 115 ms, with the child still alive. Timeout cleanup (Job snapshot, termination, drain) already works and is unchanged by this plan.

### Stage map

| Stage | Items | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| File-based readiness transport | G16.1 | Archived G15, G6.13 diagnosis | None |
| Documentation | G16.2 | G16.1 | None |
| Local validation and independent review | G16.3 | G16.1–G16.2 | None |
| Bounded probe rerun and evidence | G16.4 | G16.1–G16.3 | None |

<!-- item-contract: v1 -->

### Decisions

- Keep the process-tree test design: worker, child, and grandchild processes, readiness reported, then timeout, Job termination, drain, and PID absence. Change only how readiness crosses a process boundary.
- Use fixed file names inside the disposable workspace (`process.cwd()`), never names or paths from the request. The worker creates `pt-child-ready.jsonl`; the child creates `pt-grandchild-ready.jsonl`. Create each with exclusive-create (`wx`) so a stale file fails closed.
- The worker creates `pt-child-ready.jsonl` with exclusive-create, passes its descriptor as the child's stdout, and ignores stdin and stderr. The child spawns the grandchild with `stdio: ['ignore', 'ignore', 'ignore']`; the grandchild opens `pt-grandchild-ready.jsonl` itself with exclusive-create and writes its ready line with a synchronous write. A grandchild given an inherited fd shares its parent's console (libuv sets CREATE_NO_WINDOW only when no stdio slot is an inherited fd), which changes the Job process counts pinned by the host timeout case (4 processes, 2 console hosts). Do not change those pinned counts. Readers read only bytes appended after a tracked offset. No `pipe` or `ipc` stdio in any AppContainer role.
- Keep the host harness roles `child-test` and `grandchild-test` on pipes. They run in the trusted host Node, not in an AppContainer.
- Keep the readiness line schema, size limit (2,048 bytes), status values, readiness codes, phase markers, and report fields unchanged, so the host parser and report need no change.
- The child and grandchild scripts are pinned by SHA-256 in `run-probes.ps1` (`$scriptHashChild`, `$scriptHashGrandchild`) and `AppContainerLauncher.cs` (`PROCESS_TREE_CHILD_SCRIPT_SHA256`, `PROCESS_TREE_GRANDCHILD_SCRIPT_SHA256`). The owner approved widening this plan on 2026-11-09 to update those pins and nothing else in those two files except the host-test working directory below. A pin may change only for a script whose text changed, and both files must carry the same value.
- Keep the host-test argument shape: exactly five arguments with the same roles. The file location comes from the working directory, never from a new argument.
- The host process-tree test runs each case in its own freshly created, empty, uniquely named directory under the system temp directory, so a timeout cannot leave a stale file for the next run. The runner removes only a directory it created and whose name it generated, after the test ends.
- Do not touch Job limits, timeouts, ACLs, profiles, other launcher or runner logic, or G2.2 status. Do not run candidate code, patches, task tests, oracle cases, or models. G6.13 and G2.2 stay open until the rerun passes and the owner reviews it.

- [x] **G16.1 Move AppContainer process-tree readiness from pipes to workspace files.**
  - tier: strong · xhigh
  - gate: auto
  - after: none
  - Files: bench/isolation/worker.mjs (exists); bench/isolation/worker-bridge.test.mjs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/probe-contract.test.mjs (exists).
  - files: bench/isolation/worker.mjs (exists); bench/isolation/worker-bridge.test.mjs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/probe-contract.test.mjs (exists).
  - Anchor: function createJsonLineReader(stream) {; export function buildProcessTreeChildArguments(role) {; $scriptHashChild = 'a9a23e36f400d6f26fbdd08a3ce8e803d5ac7d389dd8deedc71cfa91474aab9f'; private const string PROCESS_TREE_CHILD_SCRIPT_SHA256
  - Change: In the `child` and `grandchild` roles, replace pipe stdout with an exclusive-create workspace file descriptor and replace the pipe line readers with an offset-tracking file line reader. Keep `child-test` and `grandchild-test` on pipes.
  - Do not touch: In AppContainerLauncher.cs and run-probes.ps1, anything except the four hash constants and the host process-tree test working directory. Also not Job limits, timeouts, the 2,048-byte limit, the response schema, readiness codes, phase markers, other probe modes, or G2.2 status.
  - do:
    1. Add fixed constants for the two file names. Derive them only from `process.cwd()`. Reject any other source.
    2. In the worker main path, create the child file with flag `wx`, spawn the child with `stdio: ['ignore', fd, 'ignore']`, then close the worker's copy of the descriptor. Treat a create failure as `child_spawn_status: FAIL` with the existing failure code mapping.
    3. In the child script for the AppContainer roles, spawn the grandchild with all-ignore stdio. In the grandchild script for the AppContainer role, open the fixed `pt-grandchild-ready.jsonl` file in `process.cwd()` with `wx`, write the ready line with a synchronous write, and keep the descriptor open while the process lives. The child reads that file with the file line reader and watches the grandchild `exit` event.
    4. Implement one file line reader that polls every 25 ms, reads only appended bytes at a tracked offset, and returns lines in order. Enforce single-line framing and the 2,048-byte limit exactly as the pipe reader does.
    5. Map outcomes to the existing values: READINESS_TIMEOUT at the deadline, STREAM_CLOSED when the owning process exited and no complete line remains, STREAM_ERROR for read errors other than a missing file before creation, OUTPUT_LIMIT, INVALID_JSON.
    6. Track child and grandchild exit through the `exit` event so a dead process ends the wait early.
    7. Keep `child-test` and `grandchild-test` on the current pipe reader.
    8. Recompute the SHA-256 of each embedded script (UTF-8 bytes of the exact string the host-test passes as `arguments[1]` and `arguments[3]`). Update `$scriptHashChild` and `$scriptHashGrandchild` in run-probes.ps1 and the two `*_SCRIPT_SHA256` constants in AppContainerLauncher.cs only for scripts whose text changed. Both files must carry identical values. Keep exactly five host-test arguments.
    9. In the host process-tree test of run-probes.ps1, replace the shared system temp working directory with a fresh empty directory named with a new GUID under the system temp directory, one per case. Create it with a non-recursive create, verify it is empty and not a reparse point before use, and remove it after the case with a non-recursive delete of that exact path only. Surface a cleanup failure as a test failure.
    10. Update any probe-contract.test.mjs assertion that pins the old hashes or the shared temp directory. Keep every other assertion.
    11. Add tests: ordered lines, a partial line completed later, invalid JSON, oversize line, exit without a line, timeout, and refusal of a pre-existing file. Add a source assertion that no AppContainer role passes `pipe` or `ipc` to `spawn`.
  - check: npm run test:isolation-worker exits 0 and npm run test:isolation-probe exits 0, and powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-probes.ps1 -SelfTest prints PASS.
  - Verify: The pinned hashes in both files equal the SHA-256 of the current scripts. The host test passes twice in a row with no leftover directory, and its timeout case still sees 4 Job processes and 2 console hosts, unchanged. The AppContainer roles contain no `pipe` or `ipc` stdio. A stale file is refused. The new reader returns the same status and code values as the pipe reader for every case in the test list.
  - Source:
    - Local evidence: the G6.13 diagnosis recorded in GOALS 6 (stdio `pipe` and `ipc` block inside the AppContainer worker; `ignore`, `inherit`, and file descriptors do not) and the scratch run that read child and grandchild lines from workspace files in about 115 ms.
    - Node.js documents the `stdio` option of `child_process.spawn`, including integer file descriptors: https://nodejs.org/api/child_process.html#optionsstdio.
  - proof: test:isolation-worker 38/38 (twice), test:isolation-probe 28/28, run-probes.ps1 -SelfTest PASS, hash pins identical in both files, host timeout pins (4 processes, 2 console hosts) unchanged, no temp leftovers, 2026-11-09, Opus 5.5

- [x] **G16.2 Document the readiness transport and the pipe limitation.**
  - tier: standard · medium
  - gate: auto
  - after: G16.1
  - Files: bench/isolation/README.md (exists).
  - files: bench/isolation/README.md (exists).
  - Anchor: #### Process-tree stage fields (G15.2)
  - Change: Add a short section after the process-tree stage fields that states how child and grandchild readiness is reported and why files replace pipes.
  - Do not touch: Probe behavior, launcher code, profiles, ACLs, benchmark policy, or the network and stage-field sections.
  - do:
    1. State that in the AppContainer worker, `spawn` with `pipe` or `ipc` stdio blocked in the observed environment and `ignore`, `inherit`, and file descriptors did not. Label this an observation on the tested host, not a documented Windows rule.
    2. State the two fixed file names, exclusive create, the append-only offset reader, and the unchanged 2,048-byte line limit.
    3. State that the host harness roles still use pipes and run outside an AppContainer.
    4. State that files live only in the disposable workspace and are removed with it.
    5. State that the transport change does not alter the termination evidence: Job snapshot, termination, drain, and PID absence.
  - check: git diff --check -- bench/isolation/README.md exits 0. The section contains no claim that pipes are forbidden by Windows or by Microsoft documentation.
  - Verify: The README distinguishes the observed blocking from any documented guarantee and names the unchanged evidence path.
  - Source: Local evidence recorded in GOALS 6 and G16.1.
  - proof: git diff --check clean; README section states the pipe blocking as an observation, names fixed files, exclusive create, offset reader, host roles on pipes, unchanged termination evidence; reviewer nit applied, 2026-11-09, Opus 5.5

- [x] **G16.3 Run deterministic checks and obtain independent review before the probe rerun.**
  - tier: strong · high
  - gate: auto
  - after: G16.1, G16.2
  - Files: bench/isolation/worker.mjs (exists); bench/isolation/worker-bridge.test.mjs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/probe-contract.test.mjs (exists); bench/isolation/README.md (exists).
  - files: bench/isolation/worker.mjs (exists); bench/isolation/worker-bridge.test.mjs (exists); bench/isolation/run-probes.ps1 (exists); bench/isolation/AppContainerLauncher.cs (exists); bench/isolation/probe-contract.test.mjs (exists); bench/isolation/README.md (exists).
  - Anchor: PROCESS_TREE_STARTUP_TIMEOUT_MS = 8_000;
  - Change: Run the deterministic project checks and an independent review of the transport change. Resolve every finding before G16.4.
  - Do not touch: Probe reports, profiles, canaries, or user files. Do not run the full probe in this item.
  - do:
    1. Run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-probes.ps1 -SelfTest. Require PASS.
    2. Run npm run verify and require exit code 0.
    3. Run git diff --check on the six listed files. Require exit code 0.
    4. Ask an independent reviewer to confirm that the only changes in run-probes.ps1 and AppContainerLauncher.cs are the hash constants and the host-test directory, that no AppContainer role uses `pipe` or `ipc`, that file names are fixed and exclusive-create, that the line limit and framing are unchanged, and that the README makes no unsupported claim.
    5. Resolve every blocker. Stop if a check fails.
    6. Leave G6.13 and G2.2 unchecked.
  - check: -SelfTest prints PASS; npm run verify exits 0; git diff --check exits 0; the independent review reports no blockers.
  - Verify: No candidate, patch, benchmark task, oracle case, model, or live probe ran in this item.
  - Source: Project AGENTS.md safety gates.
  - proof: -SelfTest PASS; npm run verify exit 0; git diff --check clean on the six files; independent review no blockers (one README nit fixed); no probe ran, 2026-11-09, Opus 5.5

- [x] **G16.4 Rerun the bounded probe once and record the evidence.**
  - tier: strong · high
  - gate: ask
  - after: G16.3
  - Files: GOALS.md (exists).
  - files: GOALS.md (exists).
  - Anchor: - [ ] **G6.13 [MANUAL] Run and review the full isolation probe.**
  - Change: Run `npm run isolation:appcontainer:probe` once under the existing bounded owner authorization, because the code changed since the last run. Read the report and record the result under G6.13.
  - Do not touch: G6.13 or G2.2 checkboxes, reports other than reading them, profiles, or any source file.
  - do:
    1. Confirm with the owner that the rerun is covered by the bounded authorization recorded under G6.13.
    2. Run npm run isolation:appcontainer:probe once. Do not repeat it unchanged.
    3. Read the report status and every check. Record the report SHA-256, the status, and each non-PASS check under G6.13 as execution evidence.
    4. If `process_tree_terminated` and `child_process_tree_terminated` pass, state that owner review of the full report is still required. Do not mark G6.13 or G2.2.
    5. If any check fails or is unknown, stop and report the failing stage. Do not retry without a changed hypothesis.
  - check: The report exists and the evidence note under G6.13 names its SHA-256, status, and every non-PASS check.
  - Verify: Neither G6.13 nor G2.2 changed state. Exactly one probe invocation ran in this item.
  - Source: The bounded session authorization recorded under G6.13.
  - proof: one probe invocation, report df7d1bed5d761bfcad37247d8780bbb1cf28bde37415de5e3912ac5b01c1b19f recorded under G6.13 with status BLOCKED, all 22 checks PASS, no failure; G6.13 and G2.2 unchanged, 2026-11-09, Opus 5.5
