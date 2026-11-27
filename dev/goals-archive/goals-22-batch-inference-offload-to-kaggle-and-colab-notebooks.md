## GOALS 22 — Batch inference offload to Kaggle and Colab notebooks (Gerente de empresa IA feature)

Format: executor-v1

This plan runs the same `qwen3.5:9b` protocol v5 inference on a free notebook GPU in batch mode and evaluates the answers locally. It measures how much of the local slowness and the I02 timeout come from the 4 GiB GPU, and it adds a dry-run report of GOALS items that a future dispatcher could offload. Git HEAD when written: `5b1fee2` on branch `claude/kaggle-colab-training-integration-66b6a3`; protocol v5 code exists only on `origin/claude/bootstrap-62e46c` (`6f0821b`), so every anchor below was copied from `6f0821b`.

### Decisions

- Mode is **batch offload, not a tunnel**. The notebook runs Ollama on its own loopback `127.0.0.1:11434`. No Ollama port is exposed. `OLLAMA_BASE_URL` in `src/adapters/ollama.ts` stays `http://127.0.0.1:11434`. The AGENTS.md loopback rule does not change.
- Reasons for rejecting a tunnel: the Colab FAQ disallows "remote control such as SSH shells" and "bypassing the notebook UI" on free runtimes, and "connecting to remote proxies" on all runtimes. Cloudflare quick tunnels are public to anyone with the URL and have no authentication by default. Sources: https://research.google.com/colaboratory/faq.html and https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/ (both accessed 2026-11-17).
- Flow: (1) a local capture run records each agent invocation (envelope and context files) without a model. (2) The bundle goes to a private Kaggle dataset. (3) A Kaggle notebook runs the unchanged `OllamaAgentAdapter` over the bundle. (4) The owner downloads `results.jsonl`. (5) A local replay run feeds the recorded answers through the normal pipeline, so the AppContainer evaluator, policy, and review-set hash stay local and unchanged.
- The model answer is untrusted data. Replay passes it through the same tool gateway and policy as a live answer. A missing answer becomes the refusal `offload_missing`, never a silent pass.
- Kaggle is the primary host because its CLI can push, run, and download a notebook (`kaggle kernels push`, `kaggle kernels status`, `kaggle kernels output`; metadata `enable_gpu`, `enable_internet`, `machine_shape`, `dataset_sources`). Source: https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels.md and https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels_metadata.md (accessed 2026-11-17).
- Colab is a manual fallback only. The owner uploads the bundle zip in the notebook UI, runs the same Python runner in a cell, and downloads the results. Colab does not publish its free limits (FAQ above).
- Quota: Kaggle GPU quota is reported as about 30 hours **per week**, not per month, and is shown in the account settings (unverified — confirm before executing; secondary source https://gpuperhour.com/blog/free-cloud-gpus-and-credits, accessed 2026-11-17). One G3-30 run took 26.6 minutes locally with `keepAlive` (ADR-005 R4), so one run fits in one session.
- The agent never runs the `kaggle` CLI and never reads the Kaggle token. Scripts print the exact commands. The owner runs them. The token lives in the owner profile (`~/.kaggle/access_token` or `KAGGLE_API_TOKEN`), never in the repository (source: https://github.com/Kaggle/kaggle-cli/blob/main/docs/README.md, accessed 2026-11-17).
- What leaves the machine: the bundle only. It holds the synthetic benchmark task files, the prompts, and a copy of `src/` without tests. It holds no `.env`, token, oracle, hidden test, or evaluator file. The Kaggle dataset and notebook are private (`is_private: true`).
- The offload runner uses the R3 final configuration: model `qwen3.5:9b`, `answerFormat: blocks`, `think: false`, `localize: helpers`, `keepAlive: 10m`, temperature 0, `timeoutMs` 120000 (ADR-005 addendum). The same tuning runs on both hosts, so the hardware is the only difference.
- Node on Kaggle is v24.18.0, the same version as the local host. The runner downloads `https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz`. Ollama is installed with `curl -fsSL https://ollama.com/install.sh | sh` (unverified on Kaggle — confirm before executing; G22.12 is the smoke test).
- `qwen3.5:9b` is 6.6 GB to 7.6 GB (https://ollama.com/library/qwen3.5, accessed 2026-11-17). It fits in one 16 GB T4 without CPU offload.
- The GOALS dispatcher is a **dry-run report only** in this goal. AGENTS.md allows disposable repositories only and forbids running model-generated code outside the G2.2 gate, so real repository items are never sent or applied.
- OpenCode is **not** integrated into the product. It is a terminal app with its own shell, edit, and web tools (https://opencode.ai/docs/permissions/), and the Ollama integration asks for a 64k context (https://docs.ollama.com/integrations/opencode), both accessed 2026-11-17. It stays an optional owner-side client (G22.16), outside `src/`.
- ADR number is 007, because GOALS 21 reserves ADR-006.
- Out of scope: tunnels, reverse proxies, exposed Ollama ports, a remote URL in `src/`, automatic `kaggle` CLI calls, Colab automation, training or fine-tuning, and sending real repository items to any host.

| Stage | Items | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| 1 Owner decisions | G22.1, G22.2 | none | each other |
| 2 Decision record | G22.3 | G22.1 | stage 3 |
| 3 Offload agents | G22.4 | G22.2 | G22.3 |
| 4 Composition seam | G22.5 | G22.4 | none |
| 5 Scripts | G22.6, G22.7, G22.8, G22.9 | G22.5 for G22.6 and G22.9; G22.4 for G22.7; none for G22.8 | each other |
| 6 Docs | G22.10 | G22.6, G22.7, G22.8, G22.9 | G22.15 |
| 7 Owner runs | G22.11, G22.12, G22.13, G22.14 | G22.10 | G22.15 |
| 8 Dispatcher report | G22.15 | G22.1 | stages 2 to 7 |
| 9 Optional client | G22.16 | G22.1 | any stage |

<!-- item-contract: v1 -->

- [x] **G22.1 Approve the offload decisions.**
  - proof: owner chose "GOALS 22, I approve G22.1" in the chat: all three points approved (batch mode without a tunnel, private Kaggle dataset and notebook, Colab manual fallback), 2026-11-17, Sonnet 5.5
  - tier: user
  - gate: ask
  - after: none
  - files: none.
  - do:
    1. Read the Decisions list of GOALS 22.
    2. Approve or reject the batch mode without a tunnel.
    3. Approve or reject sending the bundle contents to a private Kaggle dataset and notebook.
    4. Approve or reject the Colab manual fallback.
    5. Tell the assistant the answers in the chat.
  - check: manual — the owner states in the chat which of the three points are approved.
  - Files: none.
  - Do not touch: every file.
  - Verify: if the owner rejects point 2 or 3, stop GOALS 22 and ask for a revised plan.
  - Source: owner request in chat, 2026-11-17.

- [x] **G22.2 Bring protocol v5 into this branch.**
  - proof: the owner asked in chat ("faz o codigo para rodar no terminal daqui") to continue; the assistant ran `git merge --no-ff origin/claude/bootstrap-62e46c` (commit f4385a2, no conflict, local only, no push; GOALS.md WIP was stashed and reapplied). `git merge-base --is-ancestor 6f0821b HEAD` exit 0; `grep -c keepAlive src/adapters/ollama.ts` prints 5; typecheck, lint and test pass (347 pass, 0 fail), 2026-11-17, Sonnet 5.5
  - tier: user
  - gate: ask
  - after: none
  - files: none.
  - do:
    1. In this worktree, run `git fetch origin claude/bootstrap-62e46c`.
    2. Run `git merge --no-ff origin/claude/bootstrap-62e46c`.
    3. If Git reports a conflict, stop and tell the assistant.
  - check: manual — `git merge-base --is-ancestor 6f0821b HEAD` exits 0, and `grep -c "keepAlive" src/adapters/ollama.ts` prints a number greater than 0.
  - Files: none.
  - Do not touch: `origin` branches. Do not push.
  - Verify: `npm run verify` exits 0 after the merge.
  - Source: `git branch -a --contains b47b910` lists only `claude/bootstrap-62e46c` and its remote, 2026-11-17.

- [x] **G22.3 Record the offload decision in ADR-007.**
  - proof: `test -f docs/decisions/ADR-007-offload-batch-inference.md && grep -c "## Offload to notebook hosts" docs/threat-model.md` printed `1`; only the two listed files changed, 2026-11-17, Haiku 5.5
  - tier: light · low
  - gate: auto
  - after: G22.1
  - files: `docs/decisions/ADR-007-offload-batch-inference.md` (new), `docs/threat-model.md` (exists)
  - do:
    1. Create `docs/decisions/ADR-007-offload-batch-inference.md` with the headings Status, Context, Decision, Rejected alternatives, Consequences, and Results.
    2. Under Status, write `Accepted` and the date of the G22.1 approval.
    3. Under Context, write that the local GPU has 4 GiB and that I02 times out at 120 s.
    4. Under Decision, copy the first three bullets of the GOALS 22 Decisions list.
    5. Under Rejected alternatives, write three bullets: a tunnel, OpenCode as executor, and dispatch of real repository items. Copy each reason from the Decisions list.
    6. Under Results, write `Pending G22.13.`
    7. In `docs/threat-model.md`, insert a section `## Offload to notebook hosts` before `## Explicit non-claims`.
    8. In that section, list what leaves the machine, copied from the Decisions bullet "What leaves the machine".
  - Anchor: `docs/threat-model.md` contains the line `## Explicit non-claims`.
  - Do not touch: `AGENTS.md`, `docs/decisions/ADR-003-no-remote-integrations.md`.
  - check: run `test -f docs/decisions/ADR-007-offload-batch-inference.md && grep -c "## Offload to notebook hosts" docs/threat-model.md`. Expected output: `1`.
  - Files: `docs/decisions/ADR-007-offload-batch-inference.md` (new), `docs/threat-model.md` (exists)
  - Verify: run `test -f docs/decisions/ADR-007-offload-batch-inference.md && grep -c "## Offload to notebook hosts" docs/threat-model.md`. Expected output: `1`.
  - Source: GOALS 22 Decisions.

- [x] **G22.4 Add the capture and replay agent adapters.**
  - proof: `npm run typecheck && npm run lint && npm test` exit 0 (356 tests, 355 pass, 0 fail, 1 skipped); the 8 `offload-agents` tests pass. The assistant added `validateTaskEnvelopeV1` to the invocation parser after review, because the executor only checked that the envelope is an object; two new rejection cases cover it. Only the two listed files changed, 2026-11-17, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: G22.2
  - files: `src/adapters/offload-agents.ts` (new), `src/adapters/offload-agents.test.ts` (new)
  - do:
    1. Create `src/adapters/offload-agents.ts` with the exports named in Change.
    2. Implement `offloadKey` with the rule in Change. Throw `OffloadError('task_id_unparsed')` when the suffix does not match.
    3. Implement `CaptureAgentAdapter`. Each `invoke` reads files through the injected reader, stores one record, and returns `{ kind: 'refusal', reasonCode: 'offload_captured' }`.
    4. Make `CaptureAgentAdapter` throw `OffloadError('duplicate_key')` when a key repeats.
    5. Implement `ReplayAgentAdapter`. It returns the stored `result` for the key, or `{ kind: 'refusal', reasonCode: 'offload_missing' }`.
    6. Make the `ReplayAgentAdapter` constructor throw `OffloadError('duplicate_key')` when the input repeats a key.
    7. Implement the two line parsers fail-closed with the rules in Change.
    8. Write tests for: key derivation, unparsed task id, capture record and refusal, duplicate key in capture and replay, replay hit, replay miss, and each parser rejection rule.
  - Change: exports are `OFFLOAD_BUNDLE_VERSION = 1`, `class OffloadError extends Error { code }`, `offloadKey(envelope: TaskEnvelopeV1, runId: string): string`, `interface OffloadInvocationRecordV1 { version: 1; key: string; envelope: TaskEnvelopeV1; files: readonly OllamaContextFile[] }`, `interface OffloadResultRecordV1 { version: 1; key: string; result: AgentInvocationResult; durationMs: number; modelTag: string; modelDigest: string | null; runtimeVersion: string | null }`, `class CaptureAgentAdapter implements AgentInvocationPort` (constructor `{ runId, contextReader: OllamaContextReader }`, method `records(): readonly OffloadInvocationRecordV1[]`), `class ReplayAgentAdapter implements AgentInvocationPort` (constructor `{ runId, results: readonly OffloadResultRecordV1[] }`), `fixedContextReader(files): OllamaContextReader`, `parseOffloadInvocationLine(line: string): OffloadInvocationRecordV1`, `parseOffloadResultLine(line: string): OffloadResultRecordV1`. Key rule: `envelope.taskId` must end with `-${runId}-${attempt}` where attempt matches `[1-9][0-9]{0,2}`; the prefix is the lowercase benchmark task id; the key is `${prefix}|${attempt}|${envelope.baseSnapshotSha256}|${sha256 hex of envelope.prompt}`. Parser rules: line at most 4194304 characters; valid JSON object; exact key set; `version` equals 1; `key` is a string of 1 to 512 characters; `result.kind` is `proposal` or `refusal`; a refusal `reasonCode` is absent or a string of 1 to 64 characters; `durationMs` is a finite number of 0 or more; `files` entries have exactly `path` and `text` strings. Use `createHash` from `node:crypto`. Import types from `../application/ports/index.ts`, `../domain/task.ts`, and `./ollama.ts`.
  - Anchor: `src/adapters/ollama.ts` exports `OllamaContextFile` and `OllamaContextReader` (lines 54 to 63 at `6f0821b`). `src/application/ports/index.ts` exports `AgentInvocationResult` and `AgentInvocationPort` (lines 396 to 405 at `6f0821b`).
  - Do not touch: `src/adapters/ollama.ts`, `src/architecture-no-remote.test.ts`.
  - check: run `npm run typecheck && npm run lint && npm test`. Expected exit code: 0. The test output lists the new `offload-agents` tests as passing.
  - Files: `src/adapters/offload-agents.ts` (new), `src/adapters/offload-agents.test.ts` (new)
  - Verify: run `npm run typecheck && npm run lint && npm test`. Expected exit code: 0. The test output lists the new `offload-agents` tests as passing.
  - Source: `TaskEnvelopeV1` and `attemptTaskIdFor` at `6f0821b` (`src/domain/task.ts` line 12, `src/application/benchmark-services.ts` line 284).

- [x] **G22.5 Add an agent factory option to the benchmark composition.**
  - proof: `npm run typecheck && npm run lint && npm test` exit 0 (358 tests, 357 pass, 0 fail, 1 skipped); two new tests cover both options set, a non-function factory, the factory's `contextReader`, and the factory agent being the one invoked. Only the two listed files changed, 2026-11-17, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: G22.4
  - files: `src/composition/benchmark-cli.ts` (exists), `src/composition/benchmark-cli.test.ts` (exists)
  - do:
    1. In `BenchmarkApplicationOptions`, add `readonly agentFactory?: (tools: { readonly contextReader: OllamaContextReader }) => AgentInvocationPort;` after `agentOverride`.
    2. Add a doc comment: dev scripts only; no CLI code may set it; it cannot be combined with `agentOverride`.
    3. Throw `BenchmarkCompositionError('agent_override_invalid')` when both options are set, or when `agentFactory` is not a function.
    4. At the `const baseAgent` assignment, call `agentFactory` with `{ contextReader: createWorkspaceContextReader(workspaceManager) }` when it is set.
    5. Add tests: both options set is refused; a factory receives a callable `contextReader`; the factory result is the agent used.
  - Anchor: `src/composition/benchmark-cli.ts` contains `const baseAgent: AgentInvocationPort = options.agentOverride ?? new OllamaAgentAdapter({` and `throw new BenchmarkCompositionError('agent_override_invalid');`.
  - Do not touch: `src/interfaces/cli/`, `bench/`.
  - check: run `npm run typecheck && npm run lint && npm test`. Expected exit code: 0.
  - Files: `src/composition/benchmark-cli.ts` (exists), `src/composition/benchmark-cli.test.ts` (exists)
  - Verify: run `npm run typecheck && npm run lint && npm test`. Expected exit code: 0.
  - Source: `src/composition/benchmark-cli.ts` lines 582 to 584 and 642 to 648 at `6f0821b`.

- [x] **G22.6 Write the capture-bundle script.**
  - proof: `node dev/offload/capture-bundle.ts` printed the usage line and exited 1; only `dev/offload/capture-bundle.ts` was created. The real capture, the secret-path refusal and the bundle copy are not exercised yet (they need the owner-approved review-set hash); G22.11 is the first real run, 2026-11-17, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: G22.5
  - files: `dev/offload/capture-bundle.ts` (new)
  - do:
    1. Parse `<reviewSetSha256> <model> <suiteId> <bundleDir>`. Read `G20_TASK_IDS` and `G20_TUNING_FILE` exactly as `dev/scripts/g20-run.ts` does.
    2. Refuse with exit code 1 when `<bundleDir>` exists. Never overwrite.
    3. Set the capture run id to `offload-capture-` plus the UTC time as `YYYYMMDDHHmmss`.
    4. Compose the app with `agentFactory` returning a `CaptureAgentAdapter` with that run id.
    5. Call `app.benchmark.run` with the suite, task ids, `repetitions: 1`, and the capture run id.
    6. Refuse with exit code 1 when any captured file path matches `/(^|\/)\.env|credential|secret|\.pem$|\.key$/i`.
    7. Write `invocations.jsonl` with one record per line.
    8. Write `manifest.json` with the keys in Change.
    9. Copy every file under `src/` except `*.test.ts` and `*.test.mjs` files, plus `package.json` and `dev/offload/run-bundle.ts`, into `<bundleDir>/code/`, keeping relative paths. This includes `src/snapshots/snapshot-core.mjs`, which `src/` code imports at run time.
    10. Print the SHA-256 of `invocations.jsonl` and the bundle path.
  - Change: manifest keys are `version` (1), `bundleId` (the basename of `<bundleDir>`), `captureRunId`, `suiteId`, `taskIds` (array or null), `modelTag`, `tuning` (`answerFormat: blocks`, `think: false`, then the tuning file keys), `reviewSetSha256`, `invocationsSha256`, and `createdAtUtc`.
  - Anchor: `dev/scripts/g20-run.ts` reads `process.env.G20_TASK_IDS` and `process.env.G20_TUNING_FILE`.
  - Do not touch: `dev/scripts/g20-run.ts`.
  - check: run `node dev/offload/capture-bundle.ts`. Expected: a usage error and exit code 1. G22.11 runs the real capture.
  - Files: `dev/offload/capture-bundle.ts` (new)
  - Verify: run `node dev/offload/capture-bundle.ts`. Expected: a usage error and exit code 1. G22.11 runs the real capture.
  - Source: `dev/scripts/g20-run.ts` at `6f0821b`.

- [x] **G22.7 Write the bundle runner for the notebook host.**
  - proof: `node dev/offload/run-bundle.ts` printed `Usage: node dev/offload/run-bundle.ts <bundleDir> <resultsFile>` and exited 1; only `dev/offload/run-bundle.ts` was created; no URL or host option (loopback adapter only). The hash check, resume and adapter paths are not exercised yet; G22.11 is the first real run. A malformed line ends the run through an uncaught `OffloadError` (non-zero exit with a stack trace), 2026-11-17, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: G22.4
  - files: `dev/offload/run-bundle.ts` (new)
  - do:
    1. Parse `<bundleDir> <resultsFile>`. Read `manifest.json` and `invocations.jsonl` with `parseOffloadInvocationLine`.
    2. Refuse with exit code 1 when the SHA-256 of `invocations.jsonl` differs from `manifest.invocationsSha256`.
    3. When `<resultsFile>` exists, parse it and skip every key it already holds. This resumes a cut session.
    4. For each remaining record, in file order, create one `OllamaAgentAdapter` with `modelTag`, `outputMode: 'file_edits'`, `fixedContextReader(record.files)`, the manifest `tuning`, and an `onInvocation` callback.
    5. Call `invoke({ envelope: record.envelope, workspace: { workspaceId: 'offload' } })`.
    6. Append one `OffloadResultRecordV1` line per record. Take `durationMs`, `modelDigest`, and `runtimeVersion` from the last `onInvocation` metadata.
    7. When `invoke` throws, append a refusal with `reasonCode` `offload_runner_error`.
    8. Print one JSON summary line: records, proposals, refusals, total `durationMs`, and median `durationMs`.
  - Anchor: `src/adapters/ollama.ts` exports `OllamaAgentAdapter` and `OllamaInvocationMetadata` with `durationMs`, `modelDigest`, and `runtimeVersion` (line 97 at `6f0821b`).
  - Do not touch: `src/adapters/ollama.ts`. Do not add a URL or host option.
  - check: run `node dev/offload/run-bundle.ts`. Expected: a usage error and exit code 1.
  - Files: `dev/offload/run-bundle.ts` (new)
  - Verify: run `node dev/offload/run-bundle.ts`. Expected: a usage error and exit code 1.
  - Source: `OllamaAgentAdapterOptions` at `6f0821b`, lines 111 to 140.

- [x] **G22.8 Write the Kaggle notebook runner and metadata templates.**
  - proof: `python -I -m py_compile dev/offload/kaggle/offload_runner.py` and `JSON.parse` of the kernel metadata template exit 0; only the three listed files exist (the executor added a `title` field, which Kaggle metadata needs); no token or user name in the files. The runner was not run, and the `/kaggle/input` path, the dataset metadata format and Node type stripping on Kaggle stay unverified until G22.12, 2026-11-17, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: none
  - files: `dev/offload/kaggle/offload_runner.py` (new), `dev/offload/kaggle/kernel-metadata.template.json` (new), `dev/offload/kaggle/dataset-metadata.template.json` (new)
  - do:
    1. In `offload_runner.py`, find the directory under `/kaggle/input` or the first argument that holds `manifest.json`. Exit 1 when none exists.
    2. Write the output of `nvidia-smi` to `/kaggle/working/gpu.txt`, or the current directory outside Kaggle.
    3. Install Ollama with `curl -fsSL https://ollama.com/install.sh | sh`.
    4. Download and extract the Node v24.18.0 tarball named in the Decisions list.
    5. Start `ollama serve` with `OLLAMA_HOST=127.0.0.1:11434`. Poll `http://127.0.0.1:11434/api/version` for at most 60 s.
    6. Run `ollama pull` with the manifest `modelTag`.
    7. Copy the bundle to a writable folder. Run `node code/dev/offload/run-bundle.ts <bundle> <output>/results.jsonl`.
    8. Write `kernel-metadata.template.json` with `id` `<KAGGLE_USER>/agentcp-offload-runner`, `code_file` `offload_runner.py`, `language` `python`, `kernel_type` `script`, `is_private` true, `enable_gpu` true, `enable_internet` true, `machine_shape` `NvidiaTeslaT4`, and `dataset_sources` `["<KAGGLE_USER>/agentcp-offload-bundle"]`.
    9. Write `dataset-metadata.template.json` with `title` `agentcp-offload-bundle`, `id` `<KAGGLE_USER>/agentcp-offload-bundle`, and `licenses` `[{"name": "CC0-1.0"}]`.
  - Do not touch: `src/`. Do not write a token, user name, or e-mail into these files.
  - check: run `python -I -m py_compile dev/offload/kaggle/offload_runner.py && node -e "JSON.parse(require('fs').readFileSync('dev/offload/kaggle/kernel-metadata.template.json','utf8'))"`. Expected exit code: 0.
  - Files: `dev/offload/kaggle/offload_runner.py` (new), `dev/offload/kaggle/kernel-metadata.template.json` (new), `dev/offload/kaggle/dataset-metadata.template.json` (new)
  - Verify: run `python -I -m py_compile dev/offload/kaggle/offload_runner.py && node -e "JSON.parse(require('fs').readFileSync('dev/offload/kaggle/kernel-metadata.template.json','utf8'))"`. Expected exit code: 0.
  - Source: https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels_metadata.md (accessed 2026-11-17). The dataset metadata format and the `/kaggle/input` mount path are unverified — confirm before executing; G22.12 is the smoke test.

- [x] **G22.9 Write the replay script.**
  - proof: `node dev/offload/replay-run.ts` printed the usage line and exited 1 (re-run after the assistant fixed the manifest check to accept `taskIds: null`, which the capture writes for a whole-suite run); only `dev/offload/replay-run.ts` was created. The replay path is not exercised yet; G22.11 is the first real run, 2026-11-17, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: G22.5
  - files: `dev/offload/replay-run.ts` (new)
  - do:
    1. Parse `<reviewSetSha256> <bundleDir> <resultsFile>`. Read `manifest.json`.
    2. Parse every line of `<resultsFile>` with `parseOffloadResultLine`.
    3. Set the replay run id to `offload-replay-` plus the UTC time as `YYYYMMDDHHmmss`.
    4. Compose the app with `agentOverride` set to a `ReplayAgentAdapter` with that run id and the results.
    5. Pass `modelTag` from the manifest so the result files carry the real model tag.
    6. Call `app.benchmark.run` with the manifest suite, task ids, `repetitions: 1`, and the replay run id.
    7. Print one JSON line with `runId`, `statusCounts`, the count of `offload_missing` refusals, and the SHA-256 of `<resultsFile>`.
  - Anchor: `src/composition/benchmark-cli.ts` `BenchmarkApplicationOptions` has `agentOverride` and `modelTag`.
  - Do not touch: `bench/evaluator/`, `bench/isolation/`.
  - check: run `node dev/offload/replay-run.ts`. Expected: a usage error and exit code 1.
  - Files: `dev/offload/replay-run.ts` (new)
  - Verify: run `node dev/offload/replay-run.ts`. Expected: a usage error and exit code 1.
  - Source: `src/composition/benchmark-cli.ts` at `6f0821b`.

- [x] **G22.10 Document the offload procedure.**
  - proof: `grep -c "kaggle kernels output" docs/offload.md` printed `1`; only `docs/offload.md` (new) and one added line in `docs/operations.md` changed. The unverified Kaggle points (phone verification, `--dir-mode zip`, the weekly quota) are marked in the text, 2026-11-17, Haiku 5.5
  - tier: light · low
  - gate: auto
  - after: G22.6, G22.7, G22.8, G22.9
  - files: `docs/offload.md` (new), `docs/operations.md` (exists)
  - do:
    1. Write `docs/offload.md` with the sections Prerequisites, Capture, Kaggle run, Colab run, Replay, and Cleanup.
    2. Under Prerequisites, list: Kaggle account with phone verification for internet, Python 3.11 or later, `pip install kaggle`, and the token in the owner profile.
    3. Under Kaggle run, give these commands in order: `kaggle datasets create -p <bundleDir>`, `kaggle kernels push -p <kernelDir>`, `kaggle kernels status <user>/agentcp-offload-runner`, `kaggle kernels output <user>/agentcp-offload-runner -p <outDir>`.
    4. Under Colab run, give the manual steps: upload the bundle zip, run `!python offload_runner.py <bundle>`, and download `results.jsonl`.
    5. Under Cleanup, tell the owner to delete the Kaggle dataset after the run.
    6. In `docs/operations.md`, add one line under its first heading that links to `docs/offload.md`.
  - Do not touch: `README.md`.
  - check: run `grep -c "kaggle kernels output" docs/offload.md`. Expected output: `1` or more.
  - Files: `docs/offload.md` (new), `docs/operations.md` (exists)
  - Verify: run `grep -c "kaggle kernels output" docs/offload.md`. Expected output: `1` or more.
  - Source: https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels.md (accessed 2026-11-17). The phone-verification requirement and `kaggle datasets create` flags are unverified — confirm before executing.

- [ ] **G22.11 Prove the offload path on the local host.**
  - tier: user
  - gate: ask
  - after: G22.10
  - files: none.
  - do:
    1. Start `ollama serve` locally.
    2. Run `G20_TASK_IDS=I04 node dev/offload/capture-bundle.ts <hash> qwen3.5:9b g3-local-small-integrations runtime/offload/local-i04` with the R3 tuning file `{"localize":"helpers","keepAlive":"10m"}`.
    3. Run `node runtime/offload/local-i04/code/dev/offload/run-bundle.ts runtime/offload/local-i04 runtime/offload/local-i04/results.jsonl`.
    4. Run `node dev/offload/replay-run.ts <hash> runtime/offload/local-i04 runtime/offload/local-i04/results.jsonl`.
    5. Run `node dev/scripts/g3-report.mjs <replay runId>`.
  - check: manual — the replay prints zero `offload_missing`, `policy_clean` is 100 percent, and I04 is `resolved_hidden`.
  - Files: none.
  - Verify: no leftover AppContainer profile or temp directory, and `.agentctl/benchmark/task-execution.lock` is absent after the run.
  - Source: owner rule that model runs need the owner's authorization (AGENTS.md, ADR-005).

- [ ] **G22.12 Run the Kaggle smoke test with one task.**
  - tier: user
  - gate: ask
  - after: G22.11
  - files: none.
  - do:
    1. Copy `runtime/offload/local-i04` to a new folder without `results.jsonl`.
    2. Fill the two Kaggle templates with your user name in a folder outside the repository.
    3. Run the four Kaggle commands from `docs/offload.md`.
    4. Run the replay and the G3 report on the downloaded `results.jsonl`.
  - check: manual — `gpu.txt` shows a T4, `results.jsonl` holds one record, and the replay prints zero `offload_missing`.
  - Files: none.
  - Verify: the owner reports the median `durationMs` from the runner summary in the chat.
  - Source: GOALS 22 Decisions.

- [ ] **G22.13 Run G3-30 on Kaggle and compare it with the local run.**
  - tier: user
  - gate: ask
  - after: G22.12
  - files: none.
  - do:
    1. Capture the full `g3-local-small-integrations` suite with the R3 tuning into a new bundle.
    2. Run the bundle on Kaggle as in G22.12.
    3. Run the replay and `node dev/scripts/g3-report.mjs <replay runId>`.
    4. Tell the assistant the replay run id.
    5. The assistant fills the Results section of ADR-007 with: solved count, I02 status, median and total `durationMs` on Kaggle, and the local R4 wall time of 26.6 minutes.
  - check: manual — ADR-007 Results names the replay run id and the solved count out of 30.
  - Files: none.
  - Verify: the review-set hash in the replay result files equals the hash used by run `3633ec51-…`.
  - Source: ADR-005 addendum at `6f0821b`, lines 40 to 46.

- [ ] **G22.14 [OPTIONAL] Run the same bundle on Colab.**
  - tier: user
  - gate: ask
  - after: G22.12
  - files: none.
  - do:
    1. Open a new Colab notebook with a GPU runtime.
    2. Follow the Colab run section of `docs/offload.md`.
    3. Run the replay on the downloaded results.
  - check: manual — the replay prints zero `offload_missing`.
  - Files: none.
  - Verify: the notebook stays in the Colab UI; no tunnel, SSH, or web UI is started.
  - Source: https://research.google.com/colaboratory/faq.html (accessed 2026-11-17).

- [x] **G22.15 Add the GOALS offload dry-run report.**
  - proof: `node --test dev/offload/goals-scan.test.mjs` exit 0 (2 tests pass); `node dev/offload/goals-scan.mjs GOALS.md` exit 0, last line `total: 28 unchecked, 0 candidate`; only the two listed files were created. The scanner has no write calls, 2026-11-17, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: G22.1
  - files: `dev/offload/goals-scan.mjs` (new), `dev/offload/goals-scan.test.mjs` (new)
  - do:
    1. Read a GOALS file path from the first argument. Default to `GOALS.md`.
    2. Find each unchecked item line that matches `^- \[ \] \*\*(G[0-9]+\.[0-9]+) `.
    3. Read the item fields `tier:`, `gate:`, `files:`, and `check:` up to the next item line or heading.
    4. Mark an item `candidate` only when all rules in Change hold. Otherwise give the first failed rule as the reason.
    5. Print one line per item: id, `candidate` or `not_candidate`, and the reason. Print a total line last.
    6. Never send, write, or change any file.
    7. Write tests with an inline GOALS text. Cover each rule, a checked item that is skipped, and the total line.
  - Change: rules in order: `tier` starts with `light`; `gate` is `auto`; `files:` names exactly one path; that path is under `bench/tasks/` or a disposable repository root; `check:` names a command. Reason codes: `tier_not_light`, `gate_not_auto`, `not_one_file`, `not_disposable_path`, `no_check_command`.
  - Do not touch: `GOALS.md`.
  - check: run `node --test dev/offload/goals-scan.test.mjs`. Expected exit code: 0. Run `node dev/offload/goals-scan.mjs GOALS.md`. Expected: a total line and exit code 0.
  - Files: `dev/offload/goals-scan.mjs` (new), `dev/offload/goals-scan.test.mjs` (new)
  - Verify: run `node --test dev/offload/goals-scan.test.mjs`. Expected exit code: 0. Run `node dev/offload/goals-scan.mjs GOALS.md`. Expected: a total line and exit code 0.
  - Source: AGENTS.md "Use disposable repositories only".

- [ ] **G22.16 [OPTIONAL] Configure OpenCode as an owner-side client.**
  - tier: user
  - gate: ask
  - after: G22.1
  - files: none.
  - do:
    1. Install OpenCode on the owner machine from https://opencode.ai/docs/.
    2. In the owner OpenCode config outside this repository, add an Ollama provider with `baseURL` `http://127.0.0.1:11434/v1`.
    3. Set the `shell`, `edit`, and `webfetch` permissions to `ask` or `deny`.
    4. Use it only on disposable repositories.
  - check: manual — OpenCode lists `qwen3.5:9b` and asks before every shell command.
  - Files: none.
  - Verify: `git status` in this repository shows no OpenCode file.
  - Source: https://opencode.ai/docs/providers/ and https://opencode.ai/docs/permissions/ (accessed 2026-11-17). The npm package name and the V1 or V2 config keys are unverified — confirm before executing.
