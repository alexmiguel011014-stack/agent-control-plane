# ADR-001: MVP scope and operating contract

- **Status:** Accepted for the planning baseline
- **Date:** 2026-10-24
- **Decision owners:** Project owner; implementation partner: Codex

## Context

The project is a greenfield, single-user control plane running locally on the owner's Windows PC. The observed computer has an AMD Ryzen 5 3600 and an NVIDIA GTX 1650 Super with 4 GB VRAM. The 24 GB RAM figure is owner-reported and has not been independently verified. The project must not create a new recurring monetary expense. Electricity and engineering time still have a cost; existing Codex or Claude allowances are neither free inference nor programmatically controlled by this application.

The first proof is whether a local, constrained executor can complete small, reproducible coding tasks with useful quality and an auditable policy boundary. A visual dashboard is not needed to prove that behavior.

## Decisions

1. Use **Node.js LTS and TypeScript** for the controller, benchmark harness, CLI, shared event/query contracts, and eventual browser projection. This keeps contracts in one type system and avoids maintaining separate runtimes for the planned components.
2. Begin with a local, single-user, sequential design (`concurrency = 1`) on the existing Windows PC. Accept only disposable repositories without secrets, personal data, SSH keys, or `.env` files.
3. Interpret **R$0** as no new paid API, subscription, hosted service, or other recurring monetary commitment. The MVP baseline is local-only. Any later provider comparison is a manually run optional experiment using an already authorized official client and allowance.
4. Use the provisional executable name **`agentctl`**. It is the required operator interface for GOALS 0–3 and remains the canonical mutation interface after the dashboard exists. CLI commands call application command/query services only. They do not call infrastructure adapters directly.
5. Defer the browser dashboard until GOALS 4, after the local MVP has passed its gates. The dashboard is a read-only projection and cannot create, approve, run, cancel, or recover missions.
6. Expose no arbitrary shell, PowerShell, `cmd`, package installation, deletion, Git push, or external network operation to an agent. Any later local inference connection is restricted to loopback. No credential is placed in a prompt, fixture, repository file, or log.
7. A Git worktree and tool allowlist are workflow controls, not an operating-system sandbox. The MVP is not approved for hostile code, real repositories with secrets, or sensitive user data.
8. Defer choosing a distribution license. The project remains unpublished and no redistribution permission is granted by this repository until the owner selects a license.
9. Use content-addressed local snapshots as benchmark bases instead of Git commits. Snapshot v1 hashes a canonical UTF-8 compact JSON manifest containing regular-file paths, byte sizes, and SHA-256 values; `snapshot.json` is stored beside `base/`. Snapshot checks provide reproducibility and integrity, not code isolation.
10. Do not execute a model-generated patch through tests until the manual G2 OS-isolation gate passes. The gate must demonstrate filesystem containment, denied network access, termination of child processes at timeout, and oracle inaccessibility. If the boundary is unavailable or fails, stop before generated-code benchmarking.

## CLI contract, version 1

The parser is strict: unknown commands, options, duplicate singleton options, malformed values, and undeclared operations fail before an application service is called. Inputs use UTF-8 JSON where a structured task or artifact is required. The command grammar is:

```text
agentctl --version
agentctl snapshot create --source <directory> --confirm-disposable [--json]
agentctl task validate --file <task.json> [--json]
agentctl task create --file <task.json> [--json]
agentctl task status --task-id <id> [--json]
agentctl task events --task-id <id> [--after <event-id>] [--json]
agentctl task approve --task-id <id> --envelope-sha256 <hex> --operation <allowed-op>... --expires-at <RFC3339> --confirm [--json]
agentctl task run --task-id <id> --envelope-sha256 <hex> [--json]
agentctl task cancel --task-id <id> [--reason-code <code>] [--json]
agentctl task recover --task-id <id> --mode inspect|resume-read-only [--json]
agentctl benchmark list [--json]
agentctl benchmark run --suite <suite-id> [--task-id <id>] [--repetitions <n>] [--json]
agentctl benchmark report --run-id <id> [--json]
agentctl runtime diagnose [--json]
agentctl runtime smoke --model <configured-local-model> [--json]
agentctl comparison export --task-id <id> --output <package-path> [--json]
agentctl comparison import --package <package-path> --patch <patch-path> --log <log-path> [--json]
```

Approval is narrow and expires. It must bind the exact task ID, SHA-256 of the current envelope, each allowed operation, an explicit UTC expiration, and the `--confirm` flag. A changed envelope invalidates the approval. `run` cannot silently expand the approved operation list. `recover --mode resume-read-only` is available only when state recovery proves that the same envelope remains read-only; write-capable work returns to approval. The named benchmark suite/test commands are configured by the application, never supplied as arbitrary process strings by a caller or model.

Every command supports either human-readable output (default) or machine-readable output (`--json`). Version 1 JSON is one UTF-8 object per invocation:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "task.status",
  "requestId": "<generated-id>",
  "data": {}
}
```

Errors use `ok: false` and a stable `error.code` plus a redacted, actionable message. Standard output contains only the selected result format; diagnostics go to standard error. Neither stream may contain secrets, full environment values, or untrusted model output by default.

Stable exit-code families for contract version 1:

| Exit code | Meaning |
| ---: | --- |
| `0` | Command completed successfully |
| `2` | Invalid command, option, or input contract |
| `3` | Policy denied the requested operation |
| `4` | Explicit approval is required or invalid |
| `5` | Task completed with a failed verification or terminal failure |
| `6` | Timeout or cancellation |
| `7` | Local runtime/model unavailable |
| `8` | Valid local capability is unavailable or blocked by a documented safety gate |
| `70` | Unexpected internal error; details are redacted |

Breaking grammar, output-schema, or exit-code changes require a new CLI contract major version and migration notes. Within a major version, additions must not reinterpret an existing option or operation. Exit code `8` is additive for a valid command whose capability is deferred to a later goal or blocked by a safety gate; codes `0`–`7` retain their meanings.

## Decision amendment — task persistence (2026-10-26)

- Persist the full `TaskEnvelopeV1` through a separate `TaskRepository` port. The append-only event stream stores only task IDs, envelope hashes, approval bindings, state changes, and redacted reason codes; it never stores the prompt.
- The `task.created` event is the visibility marker. Creation saves the envelope first with create-if-absent semantics, then appends `task.created` using the stable key `task.created:<taskId>`. Same task ID and hash is an idempotent retry; reusing the ID with another hash is rejected. A saved envelope without its creation event remains invisible to status, events, and execution.
- Event append checks the idempotency key before the expected stream version. A retry with the same key and semantic payload returns the original event and its original timestamp/ID. A conflicting payload or stream version fails. This handles a committed append whose acknowledgment was lost without a cross-store transaction.
- The latest state transition into `WAITING_APPROVAL` defines the active approval boundary. A grant is active only if its `task.approval_recorded` event follows that boundary. Its idempotency key is `approval:<taskId>:<waitingBoundaryEventId>:<envelopeHash>:<sortedOperations>:<expiresAt>`; this invalidates grants from before recovery while allowing a lost-ack retry within the same boundary.
- `EnvelopeHasherPort` is implemented by `src/infra/envelope-hasher.ts` with Node's built-in SHA-256 over the canonical compact UTF-8 serialization of `TaskEnvelopeV1` in fixed field order. Deterministic tests lock the serialization-to-hash contract.
- Recheck approval and policy immediately before execution. Expired/missing write or process approval returns queued work to `WAITING_APPROVAL`; a hard policy denial rejects it. Read-only recovery may queue only after the stored envelope still hashes to the original creation event.
- The task repository stores prompt data locally; the existing no-credential rule still applies. Separating storage keeps prompts out of the immutable audit log but does not make task content non-sensitive.
- Cancellation of `RUNNING`, `VERIFYING`, or `INTERRUPTED` work uses the retained execution ID to append or reuse an idempotent `task.cancel_requested` event before calling task-wide execution control. If an interrupted task has no retained execution ID, cancellation stays `INTERRUPTED` with `stop_unconfirmed` and does not invent an execution ID or request. Only confirmed quiescence for the exact execution may append `CANCELLED`; an unconfirmed stop remains in its current nonterminal state. A retry may reuse the request and finish after a later confirmed stop. On a version conflict, cancellation rereads the stream, preserves a committed terminal result, and never cancels a different execution. G1.2 proves this contract with fakes only; the OS-level child-process stop guarantee remains part of G2.2.
- A cancellation-intent event by itself is not evidence that the agent, tools, evaluator, or child processes stopped. G1.3 recovery converts an interrupted active execution to `INTERRUPTED` while retaining its execution ID; later cancellation still requires task-wide quiescence confirmation. Recovery then applies the existing unchanged-hash/read-only or fresh-approval policy if the operator resumes the task.

## Decision amendment — local persistence and exclusive recovery lease (2026-10-26)

- Task IDs are stable lowercase ASCII identifiers matching `^[a-z0-9][a-z0-9_-]{0,63}$`. Uppercase is rejected at application validation and by both persistent adapters; IDs are never silently lowercased because Windows paths are case-insensitive and normalization could alias two requests.
- Use one append-only JSONL event stream per task, plus a separate immutable task-envelope file. The event stream never contains the prompt. `task.created` is the visibility marker; enumeration ignores envelope-only or temporary-file orphans.
- Store canonical events with a stable idempotency key. On append, resolve the key before checking the expected stream version: the same key and semantic payload returns the originally committed event, while a changed payload or a new key at the wrong version fails closed. Repair only an incomplete final JSONL record; malformed complete records and interior corruption are errors.
- Publish each task envelope as a complete same-directory temporary folder and atomically rename the folder into its task ID path; on the Windows target, an existing destination directory causes the rename to fail without replacement. Validate task IDs and reject symlink/reparse-point storage paths. Runtime files belong under ignored local runtime state.
- `TaskExecutionLeasePort.tryAcquire` is backed by an exclusive-create local lock shared by full task runs and restart sweeps. A run holds it through the complete application pipeline; `recoverAfterRestart` holds it for the entire enumeration and interruption sweep. A concurrent run or recovery fails with a concurrency conflict. `cancelTask` remains outside this lease so it can persist cancellation intent and request a stop while work is active; it writes `CANCELLED` only after the execution-control adapter confirms quiescence.
- Any existing lock blocks acquisition, even when its owner PID is gone or the lock record is malformed. The application never deletes a lock automatically and has no TTL cleanup. A valid record's path, PID, and operation kind are diagnostic data. Manual recovery requires the operator to verify that PID is gone, close every other controller instance, remove exactly the corresponding lock file under ignored runtime state, and restart so recovery can run. A malformed record reports an unknown owner and also needs manual review/removal after all instances are confirmed closed.
- Startup wiring that attempts `recoverAfterRestart` before accepting mutations belongs to G1.8/G1.9. While a lock exists, the CLI keeps status/event queries available and blocks run/recovery; cancellation remains available on its independent path. It displays valid owner information or identifies a malformed owner as unknown, and provides the manual recovery steps. This is application-level coordination only. Child-process termination, filesystem containment, network denial, and oracle isolation remain unproven until the manual G2.2 gate.

## Decision amendment — operator snapshot capture and workspace integrity (2026-10-27)

- Add the operator-only command `agentctl snapshot create --source <directory> --confirm-disposable [--json]`. It reads only the explicitly selected source directory, requires the operator's disposable-source confirmation, and stores the captured files by canonical snapshot hash under ignored `.agentctl/snapshots/<hash>`. The task envelope receives only the hash; command output and logs do not include the source's absolute path.
- Capture excludes and reports relative `.git`, `.agentctl`, `node_modules`, and `.venv` directories. It rejects leading/trailing ASCII spaces in every path segment, trailing dots, `.env*`, `.npmrc`, `.pypirc`, `.netrc`, `credentials.*`, `secrets.*`, private-key basenames/extensions, invalid Win32 paths/device names, case-insensitive collisions, and source/workspace reparse points, with streaming hashes/copies and limits of 50,000 files, 256 MiB per file, and 1 GiB total. These name/path checks are best-effort and are not complete secret scanning; operators must still choose a disposable copy without secrets or personal data.
- On Windows, Node directory enumeration does not expose existing NTFS alternate data streams. Snapshot v1 copies and hashes only unnamed/default file streams; it neither enumerates nor copies those alternate streams. A colon in any concrete path remains prohibited, so the agent path API cannot address `file:stream`. The capture summary should disclose this limitation and must not imply that alternate streams were detected.
- A shared snapshot v1 core keeps the 20 benchmark manifest bytes and IDs unchanged. The local store supports an injected catalog of known benchmark snapshots so workspace allocation can resolve those hashes without coupling application services to `bench/` or running candidate code.
- Workspace allocation restores a fresh retained directory after verifying the snapshot hash. It appends a redacted `allocation/started` sidecar record before snapshot resolution/restoration and an `allow` or `deny` result before returning, correlating task ID, execution ID, snapshot hash, and relative workspace path; partial restores remain for diagnosis. Before execution, after tools, and after evaluator, the workspace adapter verifies the baseline, allowed concrete path changes, and physical containment; it rejects junction/symlink/reparse escapes where the host permits a probe. Append-only integrity sidecars are stored outside workspaces with task/execution IDs, snapshot/baseline hashes, relative workspace/path names, phase, and result only; they contain no prompt, file content, or absolute path.
- Source/workspace path validation is vulnerable to filesystem TOCTOU races between checks and later opens/copies. G1.5 does not claim to eliminate that race; preventing hostile concurrent filesystem mutation requires stronger OS-level isolation and remains outside this adapter's guarantee.
- These controls support reproducibility and detect workflow violations but do not create an OS sandbox. The G2.2 isolation gate remains mandatory before any candidate patch/test execution.

## Decision amendment — closed tool gateway (2026-10-27)

- New `TaskEnvelopeV1` declarations are pathless `{ id, profile: "host-json-v1" }` entries. IDs are unique lowercase identifiers and the profile version is part of the canonical hash. The closed host registry port accepts only harness IDs registered by trusted host code. The host harness owns test inputs and expected values, sends only bounded schema-validated JSON to the isolated worker, receives candidate-code JSON responses, and compares them on the host. The worker executes candidate code only; it never imports workspace test scripts, public tests, oracles, expected values, or evaluator logic. The agent supplies only a declared ID and no command or arguments.
- Existing path-based `{ id, profile: "node-test", path }` records remain readable and hash-compatible, but are legacy-only and never executable. Their paths remain write-protected. New task validation rejects path-based declarations. TaskRepository does not rewrite or delete existing `.agentctl` data; legacy envelopes without `declaredTests` still normalize to `[]` with their old empty-list hash.
- The gateway accepts only strict structured requests named `read_text`, `list_files`, `apply_unified_diff`, `run_declared_test`, and `git_diff`; unknown names, extra fields, invalid paths, oversized requests, undeclared tests, malformed diffs, deletion and rename hunks fail closed. Limits are 32 requests per proposal, 1 MiB read and patch input/output, 10,000 listed paths, 64 changed files, 20,000 diff lines, 256 KiB per file for diff reads, and a fixed 60-second declared-test timeout.
- Every write/process call receives the trusted envelope hash and persisted approval context, and policy is evaluated again with the current clock immediately before the adapter call. Expired or mismatched approval is denied. Final concrete paths are revalidated through workspace capabilities before every file operation; path results contain no host absolute paths.
- Legacy declared test paths remain read-only: diffs and workspace-integrity checks reject edits to them. New trusted harness definitions are not stored in the workspace, so candidate code cannot edit its tests or expected values. The independent evaluator remains the only authority that can approve task success.
- The current `git_diff` contract computes a deterministic whole-file unified-hunk preview from the snapshot baseline and workspace using a fixed internal adapter. It does not invoke Git, a shell, or another subprocess. It does not read from the source repository or oracle. The 256 KiB per-file and 1 MiB response caps apply; binary/oversized content fails closed.
- G2.2 has not passed. `apply_unified_diff` and `run_declared_test` therefore fail closed when no verified gate is wired; pre-gate tests validate request parsing, diff analysis, policy, path filtering and prove patch-writer/test-runner spies are not called. The benchmark's current host-spawned public tests and direct oracle imports must also be replaced by the same host-side JSON harness and isolated worker protocol before G2.2 can pass. No synthetic attestation is accepted. The gateway exposes no general shell, PowerShell, cmd, installer, deletion, push, network, or arbitrary process capability.

## Consequences

- A terminal-only flow can create, approve, execute, inspect, cancel, and recover work before any browser UI exists.
- The CLI remains testable end-to-end as the operator would use it and is independent from the future dashboard.
- The local-only cost claim is narrow: no new provider charge is required for the baseline, but energy and engineering time remain.
- Strong isolation and any automated provider integration require separate evidence and a separately approved plan.

## Alternatives considered

- **Python:** viable, but rejected for the first implementation because the controller, terminal contract, benchmark, and future browser projection would need separate type/model boundaries or extra generated interfaces.
- **Browser-first operation:** rejected for the first phases because the command line is simpler to configure and can exercise the same application services directly.
- **Remote API as the baseline:** rejected because it introduces a paid-usage path and cannot satisfy the zero-new-spend requirement.
- **A complete distribution license now:** deferred because there is no publication or external contribution plan yet.
