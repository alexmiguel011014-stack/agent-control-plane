# Operations

Gerente panel and Kaggle ledger: see [docs/panel.md](panel.md).

Operator guide for the local control plane. All commands go through `agentctl` (`npm run agentctl -- <command>` or `node src/bin/agentctl.ts <command>`); add `--json` for machine-readable output. The application is single-user and sequential: one execution lease at a time.

Batch offload procedure (Kaggle or Colab notebook run): see [docs/offload.md](offload.md).

## Everyday commands

| Goal | Command |
|---|---|
| List benchmark suites | `agentctl benchmark list` |
| Run a suite | `agentctl benchmark run --suite <id> --repetitions <n> [--task-id <id>] [--model <tag>] [--answer-format json|blocks] --approve-review-set-sha256 <hash>` |
| Report one run | `agentctl benchmark report --run-id <id>` |
| Check the local runtime | `agentctl runtime diagnose` |
| Watch tasks, runs and resources | `agentctl watch [--once] [--interval <seconds>] [--no-color]` |
| Export a comparison package | `agentctl comparison export --task-id <id> --output <repo-relative path>` |
| Import a manual patch and log | `agentctl comparison import --package <path> --patch <path> --log <path>` |

Options the CLI does not expose (for example `think:false` for thinking models) go through `node dev/scripts/g20-run.ts <hash> <model> <suite> <json|blocks> <on|off|default> [repetitions]`, which writes the same result files.

Results are written to `bench/results/local/<runId>/` (gitignored); each file holds the evaluator outcome, hashes and resource metrics, never patch text or evaluator logs.

## Approvals the operator gives

- The review-set hash for benchmark runs (`--approve-review-set-sha256`). Without a valid hash nothing runs, and a changed bound file needs a new hash.
- The isolation attestation (`npm run isolation:attest -- --approve-report-sha256 <hash>`), tied to the exact bytes of the evaluator, isolation and protocol files.
- Downloads of models and any dependency install: always the owner's explicit decision.

## Cancel and recover a run

- Cancel a task: `agentctl task cancel --task-id <id> [--reason-code <code>]`. Exit code 6 means it was cancelled or the stop could not be confirmed.
- Inspect an interrupted task: `agentctl task recover --task-id <id> --mode inspect`.
- Resume an interrupted task read-only: `agentctl task recover --task-id <id> --mode resume`. A resume never replays a write without a matching approval; the state machine returns to waiting for approval.
- If a second instance is blocked, the CLI reports `execution_lock_busy` (exit 8) with the lock path and the owner PID. Check that the PID is gone, close other instances, then remove that one lock file manually. The CLI never deletes locks itself.
- After a crash during a benchmark attempt, check for leftovers: an AppContainer profile named `agentcp-*` under the user profile and temp folders under `%TEMP%`. The attempt cleanup removes and verifies them; when it cannot, it keeps the profile on purpose and the benchmark stops.
- Stop only a process you started, by PID or handle. Never use a name-wide kill (`taskkill /IM`, `Stop-Process -Name`).

## Exit codes

0 success; 2 invalid input or unknown task/suite; 3 unsupported or policy rejection; 4 approval missing or invalid; 5 invalid state or unavailable data; 6 interrupted or cancelled; 8 safety gate closed, lock busy or capability unavailable; 70 internal error.

## What is unavailable on purpose

- Remote provider cost is `unobservable_by_control_plane` and is never estimated. No currency saving is claimed.
- There is no remote provider adapter and no credential path (ADR-003).
- The terminal view (agentctl watch) is read-only. It reads event files and result files without locks, never repairs or writes them, and cannot create, approve, run, cancel or recover a task.

## Keeping the checks honest

`npm run ci` runs typecheck, lint, unit tests and the benchmark-contract suites; CI runs the same command. A UI or adapter change must keep the CLI and application contract tests green; it never bypasses them. Checkouts use LF (`.gitattributes`) because snapshot ids and the attestation bind exact bytes.
