# Threat model

Scope: a single-user, Windows-local control plane that lets a small local model propose code changes to disposable repositories. This is not a defense against a hostile model, hostile code or a hostile local user.

## Two kinds of protection, kept apart

**Protected interface behavior** (software policy inside the control plane; verified by deterministic tests):
- The model returns a proposal only; it cannot approve work, write audit events, or pick commands.
- A closed tool gateway allows five operations (`read_text`, `list_files`, `apply_unified_diff`, `run_declared_test`, `git_diff`), checks paths against the task allowlist, bounds the number of changed files, and has no shell, network, package install, deletion, Git push, credential or secret access.
- Only the independent evaluator decides whether a task is resolved. Hidden oracles are never put in a model context.
- Task events are append-only. The CLI and application services are the only mutation path; agentctl watch is read-only and uses a lock-free reader that never writes.
- Snapshots and allowlists are integrity and workflow controls. They do not stop code that is already running from touching the disk.

**OS isolation** (a different mechanism, with its own evidence): candidate code is executed only inside a Windows AppContainer with a Job Object, started by a fixed launcher. The G2.2 probe checked filesystem containment, network denial, termination of a child process tree, oracle inaccessibility and cleanup on this host (22 of 22 checks passed). The attestation is bound to the exact bytes of the evaluator, isolation and protocol files and expires when any of them changes. See `docs/isolation-boundary.md` for what this does and does not prove.

## Assets

Hidden oracles and expected values; the integrity of benchmark results; the operator's files outside the disposable repository; local credentials and personal data (which must never enter the repository, prompts, logs or fixtures).

## Threats and controls

| Threat | Control | Residual |
|---|---|---|
| Model proposes an unsafe operation or path | Closed gateway, allowlist, changed-file limit, policy-violation outcome | A permitted file can still contain wrong or malicious-looking code |
| Model-generated code reads or alters the host | AppContainer plus Job Object for every evaluation; no candidate code runs outside it | Kernel is shared; escape tests cover only the probed behaviors |
| Model reads hidden answers | Oracles live outside the task tree and outside the model context; the worker never opens them | Same-user processes share the account; not hardened against a hostile user |
| Model claims success | Independent evaluator, public tests plus hidden oracle | None known; protocol changes are labeled |
| Secrets or personal data reach a prompt or log | Disposable repositories only; no secret access in tools; result files hold hashes, not text | Filename filters for `.env` and keys are best-effort, not secret scanning |
| Stale approval is reused | Approval binds an exact hash; any bound change invalidates it | Operator must read what the hash covers |
| Remote provider spend or credential leakage | No remote adapter or credential path (ADR-003); manual comparison only, cost `unobservable_by_control_plane` | Manual use is outside the control plane |
| Result tampering after the fact | Result files validate against a schema; hashes recorded | Files are local and editable by the same user |

## Offload to notebook hosts

What leaves the machine: the bundle only. It holds the synthetic benchmark task files, the prompts, and a copy of `src/` without tests. It holds no `.env`, token, oracle, hidden test, or evaluator file. The Kaggle dataset and notebook are private (`is_private: true`).

## Explicit non-claims

No claim of a secure sandbox, of safety against hostile code, of provider credit control, of currency savings or of general-purpose autonomy.
