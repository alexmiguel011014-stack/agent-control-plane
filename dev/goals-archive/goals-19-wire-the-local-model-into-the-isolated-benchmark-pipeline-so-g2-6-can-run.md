## GOALS 19 — Wire the local model into the isolated benchmark pipeline so G2.6 can run (Gerente de empresa IA feature)

Format: executor-v1

Grounded against commit 0154f70 and the uncommitted workspace on 2026-11-10. Today `agentctl benchmark` is a stub, the local composition has a throwing agent and evaluator, the Ollama adapter cannot see source files, and the evaluator refuses `source=model`. This plan adds the missing parts one layer at a time, proves the whole path with a scripted reference patch before any model runs, and keeps every model-generated patch behind the G2.2 attestation and the owner's review-set approval.

### Stage map

| Stage | Items | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| Diff generator | G19.1 | none | G19.3, G19.5 |
| Adapter input and output | G19.2 | G19.1 | G19.4 |
| Context reader | G19.3 | none | G19.1, G19.5 |
| Workspace apply and export | G19.4 | none | G19.2 |
| Generated-code gate | G19.5 | none | G19.1, G19.3 |
| Model workspace evaluation (changes runner fingerprint) | G19.6 | none | None |
| Evaluator adapter | G19.7 | G19.4, G19.6 | G19.8 |
| Benchmark service | G19.8 | none | G19.7 |
| Catalog | G19.9 | none | G19.8 |
| Composition | G19.10 | G19.2–G19.9 | None |
| CLI commands | G19.11 | G19.8, G19.10 | None |
| Pipeline smoke script | G19.12 | G19.10 | None |
| Local checks and independent review | G19.13 | G19.1–G19.12 | None |
| Evidence chain after the fingerprint change | G19.14–G19.18 | G19.13 | None |
| Pipeline smoke run | G19.19 | G19.18 | None |
| Owner authorization of model runs | G19.20 | G19.19 | None |

<!-- item-contract: v1 -->

### Decisions

- Model input: the adapter reads the task's allowed source files through a read-only context reader and puts them in the prompt. Without file text a 1.5B model cannot produce a patch that applies. The reader uses `WorkspacePathAccessPort`, so policy and path safety stay in one place. Limits: 16 KiB per file and 24 KiB in total. Over a limit, the adapter refuses with `context_overflow`.
- Prompt format: each file is sent as `FILE <path> BYTES <n>` on one line, then exactly `n` bytes of text. File text is data, never instructions, and the length prefix means file content cannot forge a delimiter.
- Model output: the model returns whole-file replacements, `{ "proposalId": string, "edits": [{ "path": string, "content": string }] }`, at most 2 edits. A 1.5B model cannot write exact hunks. The adapter computes the unified diff itself with a deterministic line differ and returns one `apply_unified_diff` request. An edit path must be one of the files it was given. Output with no real change is refused as `no_change_proposed`. The existing `tool_requests` mode stays the default and unchanged.
- Line endings: the differ and the file-edit mode support LF text only. A file with CR, or text without a final newline, is refused as `unsupported_text_format`.
- Applying the diff: `SnapshotWorkspaceManager` gets an `apply` method that implements `UnifiedDiffApplicationPort`. It re-validates every path with its own `write` checks, checks each hunk context against the current file text, and writes each file with a temp file and a rename. Any mismatch changes nothing.
- Evaluator input: the evaluator never receives a host path from the application layer. The manager gets `exportWorkspace(workspace, destinationDirectory)`, which copies the verified workspace tree into an empty directory that trusted host code created. The evaluator adapter runs the evaluation on that copy and deletes it.
- Evaluator policy: the model path stays inside the approved evaluator closure. `createModelWorkspaceEvaluator` needs the owner-approved review-set hash, recomputes it, and requires the G2.2 attestation, exactly like `runG0`. For a model workspace it restores the base snapshot, computes the changed paths against it, enforces the task `allowed_globs` and `max_changed_files`, checks the protected hashes before and after, runs the public cases and then the hidden oracle through the isolated runner, and checks that the workspace manifest did not change during the tests. `evaluateTask` keeps refusing `source=model`.
- Gate: `GeneratedCodeExecutionGatePort` is implemented by reading the G2.2 attestation on every call, with no cache. Any error means the gate is closed.
- Approval: `benchmark run` needs `--approve-review-set-sha256 <hash>`. The benchmark service builds one `ApprovalGrantV1` per attempt, limited to the task operation `write` (the operation the gateway checks for `apply_unified_diff`; `ApprovalGrantV1.operations` only accepts `read`, `write`, `process`, and `network`), bound to that attempt's envelope hash, expiring in 15 minutes. Benchmark envelopes carry `requestedOperations: ["write"]`. The owner's flag is the human approval. The model adapter never approves anything.
- Attempts: sequential, concurrency 1, one fresh workspace per attempt from the validated base snapshot. Attempt task IDs are `<lowercase benchmark task ID>-<run ID>-<attempt>`. The catalog maps an attempt task ID back to the benchmark task ID for the evaluator.
- Outcome mapping from evaluator reason codes: `resolved_hidden` is public PASS and oracle PASS; `oracle_fail` is public PASS and oracle FAIL; `public_fail` is public FAIL with no oracle verdict; `timeout`, `crash`, `runner_failure`, and `policy_violation` map to the same-named evaluator status. A model refusal or a diff that does not apply is public FAIL with no oracle verdict. An unreachable runtime is `RUNNER_FAILURE`. Results are written with `createLocalRunResultWriter` to `bench/results/local/<run ID>/`.
- Observation: task events do not record tool calls, tool failures, or policy denials, and a thrown agent error and a thrown tool error both end as `runner_failure`. The benchmark composition (G19.10) therefore wraps the agent port and the tool execution port with observers that record, per attempt task ID: the agent outcome (`proposal`, `refusal`, or `error`), the tool operations of the proposal (parsed defensively; unknown shapes count as none), the tool failure code, and the patch facts of the proposal (lines added, lines removed, changed file count, and the SHA-256 of the diff text, or null when there is no diff). The application service reads these through `BenchmarkAttemptObserverPort`. The task service and `src/domain/event.ts` are not changed. Tool failure codes map as follows: `hunk_mismatch`, `invalid_tool_request`, and `tool_output_too_large` are public FAIL with no oracle verdict; `tool_policy_denied`, `approval_required`, `g2_isolation_required`, and `tool_unavailable` are `POLICY_VIOLATION` and are listed in `policyDenials`; any other failure is `RUNNER_FAILURE`.
- Fingerprint: files in `RUNTIME_FINGERPRINT_FILES` change the G2.2 attestation binding. This plan changes only `bench/evaluator/index.mjs` and its tests among them. G19.14 to G19.18 rebuild the evidence chain once, after all fingerprint-affecting edits. No other item edits `package.json`, `AGENTS.md`, `README.md`, or any file under `bench/evaluator` or `bench/isolation`.
- Do not touch the oracles, the tasks, the patches, the launcher, the probe, or the instructions in `AGENTS.md`. Do not run a model or any model-generated patch before G19.20.

- [x] **G19.1 Add a deterministic line differ that produces gateway-valid unified diffs.**
  - tier: strong · high
  - gate: auto
  - after: none
  - Files: src/adapters/line-diff.ts (new); src/adapters/line-diff.test.ts (new).
  - files: src/adapters/line-diff.ts (new); src/adapters/line-diff.test.ts (new).
  - Anchor: `export function parseAgentProposal(` in src/tools/tool-gateway.ts; `export async function applyUnifiedPatch(workspaceRoot, patchText, allowedGlobs) {` in bench/evaluator/unified-diff.mjs
  - Change: Add `createUnifiedDiff(relativePath, before, after)` and a typed `LineDiffError`. It returns diff text in the same layout as `bench/tasks/B01/reference.patch`.
  - Do not touch: The gateway, the evaluator, or any existing file.
  - do:
    1. Read `bench/tasks/B01/reference.patch` and `bench/tasks/I02/reference.patch` for the exact layout: `diff --git`, `---`, `+++`, then hunks.
    2. Implement a line-based LCS differ with 3 lines of context. Merge hunks whose context overlaps.
    3. Write correct hunk headers `@@ -<start>,<count> +<start>,<count> @@`. A zero count uses the preceding line number.
    4. Throw `LineDiffError('unsupported_text_format')` if either text contains CR or does not end in LF. Throw `LineDiffError('input_too_large')` over 2,000 lines or 64 KiB. Throw `LineDiffError('no_change')` if the texts are equal.
    5. Validate the path with the same rules as `isSafeDeclaredTestPath` in src/domain/tools.ts and throw `LineDiffError('invalid_path')` otherwise.
    6. Test with real round trips: apply the produced diff with `applyUnifiedPatch` from bench/evaluator/unified-diff.mjs to a temp copy and compare with `after` for these cases: one changed line, two distant hunks, add at the start, add at the end, delete lines, replace all lines.
    7. Test that `parseAgentProposal` accepts a proposal that holds the produced diff.
    8. Test each error code.
  - check: npm run typecheck exits 0 and npm test exits 0 with the new tests passing.
  - Verify: Every round-trip case reproduces `after` byte for byte.
  - Source: Local code at commit 0154f70: bench/evaluator/unified-diff.mjs and src/tools/tool-gateway.ts.
  - proof: src/adapters/line-diff.ts with 14 tests: every round trip through the evaluator applyUnifiedPatch reproduces the after text byte for byte, parseAgentProposal accepts the output, all four error codes tested; the output uses 3 context lines so it is not byte-identical to the hand-written reference patches (same headers and change rows); npm run verify exit 0 (294 tests, 293 pass, 1 skipped for symlink creation, 0 fail), 2026-11-10, Opus 5.5

- [x] **G19.2 Let the Ollama adapter read approved files and return whole-file edits as a diff.**
  - tier: strong · high
  - gate: auto
  - after: G19.1
  - Files: src/adapters/ollama.ts (exists); src/adapters/ollama.test.ts (exists).
  - files: src/adapters/ollama.ts (exists); src/adapters/ollama.test.ts (exists).
  - Anchor: `export class OllamaAgentAdapter implements AgentInvocationPort {`; `export function buildOllamaContext(`
  - Change: Add an `outputMode` option and an injected `contextReader`. In `file_edits` mode, build the prompt with the files, ask for edits, and return one `apply_unified_diff` proposal.
  - Do not touch: The `tool_requests` mode behavior, the fixed loopback URL, the busy flag, the timeout logic, `src/adapters/ollama-smoke.ts`, or any other file.
  - do:
    1. Add option `outputMode: 'tool_requests' | 'file_edits'`, default `tool_requests`. Reject other values with `invalid_configuration`.
    2. Add option `contextReader`, a function `(input: { envelope, workspace }) => Promise<readonly { path: string; text: string }[]>`. It is required in `file_edits` mode and ignored in the other mode.
    3. In `file_edits` mode call the reader inside the busy section and inside the timeout. A reader error throws `OllamaAgentError('context_unavailable')`. Add that code to the error code type.
    4. Build the file blocks as `FILE <path> BYTES <n>` plus the exact text. Refuse with `context_overflow` over 16 KiB per file or 24 KiB in total, before any request. Include the estimated token check for the whole prompt.
    5. Change the JSON schema for this mode to `{ proposalId, edits: [{ path, content }] }` with `maxItems: 2`, `additionalProperties: false`, and no `tools` field.
    6. Parse the answer fail-closed: exact keys, string proposalId, at most 2 edits, each path equal to a given file path, each content at most 32 KiB, LF only. Violations are refusals `invalid_structured_output`.
    7. Compute each diff with `createUnifiedDiff`. Map `no_change` to a refusal `no_change_proposed` and `unsupported_text_format` to `unsupported_text_format`. Join the file diffs and return a frozen proposal with exactly `proposalId` and one `apply_unified_diff` request, validated by `parseAgentProposal`.
    8. Keep the `prompt_eval_count` guard and the metadata observer. Add `outputMode` to the observer metadata.
    9. Add tests: a successful single-file edit with the exact diff text; two edits; a path outside the given files; unchanged content; CR in a file; a file over its limit; reader failure; the reader is never called in `tool_requests` mode; all existing tests still pass.
  - check: npm run typecheck exits 0, npx biome lint src/adapters/ollama.ts src/adapters/ollama.test.ts reports no diagnostics, and npm test exits 0.
  - Verify: The request body never contains workspace paths, the snapshot hash, or any text that is not envelope data or approved file text.
  - Source: Local code at commit 0154f70: src/adapters/ollama.ts and the G2.4 review notes in GOALS 2.
  - proof: src/adapters/ollama.ts file_edits mode and contextReader option, 29 tests (19 old plus 10 new): exact diff text, two-file diff accepted by parseAgentProposal with one diff --git line, fail-closed refusals, context_overflow before any request, context_unavailable, hung reader gives timeout, reader never called in tool_requests mode, request body has length-prefixed file blocks and no workspace id, snapshot hash, host path, or tools field; lint clean; a given file with CR is refused only when the model edits it (one chat call is made); npm run verify exit 0 (294 tests, 293 pass, 1 skipped for symlink creation, 0 fail), 2026-11-10, Opus 5.5

- [x] **G19.3 Add a bounded context reader over the workspace path port.**
  - tier: standard · medium
  - gate: auto
  - after: none
  - Files: src/adapters/workspace-context-reader.ts (new); src/adapters/workspace-context-reader.test.ts (new).
  - files: src/adapters/workspace-context-reader.ts (new); src/adapters/workspace-context-reader.test.ts (new).
  - Anchor: `export interface WorkspacePathAccessPort {` in src/application/ports/index.ts
  - Change: Add `createWorkspaceContextReader(paths, limits)`. It returns the function that the adapter expects.
  - Do not touch: Any existing file.
  - do:
    1. Call `paths.listAllowed` with the envelope `allowedPaths` and `maxResults` 65. If 65 paths return, throw `ContextReaderError('too_many_files')`.
    2. Keep only paths that end in `.mjs`, `.js`, `.ts`, or `.json`. Sort them in code-point order.
    3. Read each with `paths.readText` and `maxBytes` 16,384 plus 1. A file over the limit throws `ContextReaderError('file_too_large')`.
    4. Stop with `ContextReaderError('context_too_large')` when the total passes 24,576 bytes.
    5. Return a frozen list of `{ path, text }`. Never read a path that the port did not list.
    6. Never include the host path, the workspace ID, or the snapshot hash in any output or error message.
    7. Test with a fake port: sorted order, extension filter, each error code, and that a non-listed path is never read.
  - check: npm run typecheck exits 0 and npm test exits 0 with the new tests passing.
  - Verify: The fake port records every call, and no `readText` call names a path that `listAllowed` did not return.
  - Source: Local code at commit 0154f70: src/application/ports/index.ts.
  - proof: src/adapters/workspace-context-reader.ts with 6 tests: allowed-path listing, extension filter, sorted order, per-file 16 KiB and total 24 KiB limits, every port error mapped to a code without paths (extra code read_failed), no read of a path the port did not list; npm run verify exit 0 (294 tests, 293 pass, 1 skipped for symlink creation, 0 fail), 2026-11-10, Sonnet 5.5

- [x] **G19.4 Make the workspace manager apply diffs and export a verified copy.**
  - tier: strong · xhigh
  - gate: auto
  - after: none
  - Files: src/workspace/snapshot-manager.ts (exists); src/workspace/snapshot-manager.test.ts (exists).
  - files: src/workspace/snapshot-manager.ts (exists); src/workspace/snapshot-manager.test.ts (exists).
  - Anchor: `export class SnapshotWorkspaceManager implements WorkspaceAllocationPort, WorkspaceIntegrityPort, WorkspacePathAccessPort {`
  - Change: Implement `UnifiedDiffApplicationPort` on the manager and add `exportWorkspace`. Both reuse the manager's existing path inspection.
  - Do not touch: `allocate`, the integrity checks, the audit records, the snapshot store, or any other file.
  - do:
    1. Add `async apply(input: { workspace, plan, paths })` and declare that the class implements `UnifiedDiffApplicationPort`.
    2. Require the set of `paths` relative paths to equal the plan `changedPaths`. Re-inspect each path with the existing concrete-path check for `write`. Reject symlinks, junctions, and anything outside the workspace record.
    3. For a `modify` file read the current UTF-8 text and apply each hunk. Each hunk context and removed line must equal the current text at the stated position. Any mismatch throws `WorkspacePatchError('hunk_mismatch')` before any file is written.
    4. For a `create` file require that the file does not exist.
    5. Compute all new file texts first. Then write each file with a temp file in the same directory and a rename. Remove temp files on failure.
    6. Add `async exportWorkspace(workspace, destinationDirectory)`. It requires an absolute, existing, empty, ordinary directory. It re-runs the inventory check, then copies regular files only, and verifies that the copy manifest equals the workspace manifest.
    7. Make both methods append the same kind of audit record that other manager operations append, with no path text beyond the relative path.
    8. Test apply: one-file modify, multi-hunk, create, context mismatch changes nothing, a path not in the plan is refused, a symlink target is refused where the OS allows one, no temp file remains.
    9. Test export: a faithful copy, a non-empty destination is refused, a symlink inside the workspace is refused where the OS allows one.
  - check: npm run typecheck exits 0, npm test exits 0, and npx biome lint src/workspace reports no new diagnostics.
  - Verify: Every failing apply test leaves the workspace manifest equal to its manifest before the call.
  - Source: Local code at commit 0154f70: src/workspace/snapshot-manager.ts and the `UnifiedDiffApplicationPort` in src/application/ports/index.ts.
  - proof: SnapshotWorkspaceManager.apply and exportWorkspace with 6 new tests (18 total in snapshot-manager.test.ts): strict hunk context checks, path-set equality, junction refusal, temp file plus rename with rollback, audit records, faithful export copy; findings carried forward: audit records carry empty taskId and executionId, create needs an existing parent directory, a failed export can leave files in the caller destination, the gateway parser accepts a diff --git header only before the first file; independent review still pending (G19.13); npm run verify exit 0 (294 tests, 293 pass, 1 skipped for symlink creation, 0 fail), 2026-11-10, Opus 5.5

- [x] **G19.5 Open the generated-code gate only from a valid G2.2 attestation.**
  - tier: standard · medium
  - gate: auto
  - after: none
  - Files: src/adapters/attestation-gate.ts (new); src/adapters/attestation-gate.test.ts (new).
  - files: src/adapters/attestation-gate.ts (new); src/adapters/attestation-gate.test.ts (new).
  - Anchor: `export interface GeneratedCodeExecutionGatePort {` in src/application/ports/index.ts
  - Change: Add `AttestationGeneratedCodeGate`. It reads the attestation on every `isOpen` call and returns false on any error.
  - Do not touch: bench/evaluator/isolation-attestation.mjs or any existing file.
  - do:
    1. Take a repository root and an optional reader. The default reader is `readG2IsolationAttestation` from bench/evaluator/isolation-attestation.mjs.
    2. `isOpen` returns true only when the reader resolves and its evidence status is `PASS`. Any throw, rejection, or other value returns false.
    3. Do not cache. Do not log. Never throw.
    4. Test with injected readers: valid, rejecting, throwing, wrong status, and that two calls read twice.
  - check: npm run typecheck exits 0 and npm test exits 0 with the new tests passing.
  - Verify: A gate built with the default reader returns false when `runtime/diagnostics/g2-isolation-evidence.json` is absent (use a temp repository root).
  - Source: Local code at commit 0154f70: bench/evaluator/isolation-attestation.mjs.
  - proof: src/adapters/attestation-gate.ts with 6 tests: opens only when the reader resolves with evidence status PASS, reads on every call, never throws, default reader returns false for a repository root without the attestation file; npm run verify exit 0 (294 tests, 293 pass, 1 skipped for symlink creation, 0 fail), 2026-11-10, Sonnet 5.5

- [x] **G19.6 Add model-workspace evaluation inside the approved evaluator closure.**
  - tier: strong · xhigh
  - gate: auto
  - after: none
  - Files: bench/evaluator/index.mjs (exists); bench/evaluator/evaluator-static.test.mjs (exists); bench/evaluator/evaluator.test.mjs (exists).
  - files: bench/evaluator/index.mjs (exists); bench/evaluator/evaluator-static.test.mjs (exists); bench/evaluator/evaluator.test.mjs (exists).
  - Anchor: `if (input?.source === 'model') return detailResult('POLICY_VIOLATION', 'POLICY_VIOLATION');`; `function createApprovedG0Evaluator({`
  - Change: Export `createModelWorkspaceEvaluator`. It evaluates an existing workspace directory against the task's public cases and hidden oracle. `evaluateTask` keeps refusing `source=model`.
  - Do not touch: The `source=model` refusal in `evaluateTask`, the G0 report format, `g0-report.mjs`, the isolated runner, or the oracles.
  - do:
    1. Read `runG0` and `createApprovedG0Evaluator` first. Extract the steps that both paths share (attestation check, task and manifest loading, protected-hash capture, case loading, public cases, oracle cases, manifest-unchanged checks, protected-hash recheck) into internal helpers. The G0 path must behave exactly as before.
    2. Add `export async function createModelWorkspaceEvaluator({ repositoryRoot, approvedReviewSetSha256 })`. It loads the corpus and approval context the way `runG0` does, recomputes the review-set hash, and throws unless it equals the supplied hash and the supplied hash is lowercase 64-hex.
    3. It returns `evaluateWorkspace({ taskId, workspaceRoot })`. The function must read the G2.2 attestation and require that its baseline and runner fingerprint match the approved context, as `evaluateTask` does.
    4. Restore the task base snapshot into a temp directory. Compute the changed paths between the base and `workspaceRoot` with the existing manifest helpers. Return `POLICY_VIOLATION` if any changed path fails `matchesPathGlobs` against the task `allowed_globs`, or if the count passes `max_changed_files`.
    5. Run the public cases, check that the workspace manifest is unchanged, run the oracle cases, check again, and recheck the protected hashes. Return `detailResult(publicStatus, oracleStatus)`.
    6. Remove the temp base directory in a `finally` block. Never return paths, hashes of oracle data, or error text.
    7. In `evaluator-static.test.mjs` add policy tests that need no isolation: a wrong or malformed hash throws, an unknown task returns `POLICY_VIOLATION`, a changed file outside the globs returns `POLICY_VIOLATION`, too many changed files returns `POLICY_VIOLATION`, and `evaluateTask` still refuses `source=model`.
    8. In `evaluator.test.mjs` add two isolated tests: a workspace restored from the base with the reference patch applied returns public PASS and oracle PASS for B01, and the unmodified base returns public FAIL. Do not run these two tests in this item. They need a valid attestation for the new fingerprint.
  - check: node --check bench/evaluator/index.mjs exits 0, npm run test:evaluator:static exits 0, and npm run test:g0-report exits 0.
  - Verify: `createApprovedG0Evaluator` still returns `POLICY_VIOLATION` for `source=model`, and the extracted helpers are used by both paths.
  - Source: Local code at commit 0154f70: bench/evaluator/index.mjs, and the G2.2 text in GOALS 2.
  - proof: createModelWorkspaceEvaluator in bench/evaluator/index.mjs (nine shared helpers extracted; evaluateTask still returns POLICY_VIOLATION for source=model as its first statement); test:evaluator:static 12 of 12 (5 new, Windows-only, in a disposable repository copy), test:g0-report 8 of 8; extra check added by the executor: the workspace and the repository may not contain each other; the two isolated B01 tests in evaluator.test.mjs were written but NOT run (they need the new attestation); G0 behavior equivalence is proven only by the regression rerun in G19.18; npm run verify exit 0 (294 tests, 293 pass, 1 skipped for symlink creation, 0 fail), 2026-11-10, Opus 5.5

- [x] **G19.7 Add the TypeScript evaluator adapter for model workspaces.**
  - tier: strong · high
  - gate: auto
  - after: G19.4, G19.6
  - Files: src/adapters/g0-model-evaluator.ts (new); src/adapters/g0-model-evaluator.test.ts (new).
  - files: src/adapters/g0-model-evaluator.ts (new); src/adapters/g0-model-evaluator.test.ts (new).
  - Anchor: `export interface EvaluatorInvocationPort {` in src/application/ports/index.ts
  - Change: Add `G0ModelWorkspaceEvaluator implements EvaluatorInvocationPort`. It exports the workspace to a temp copy, evaluates the copy, and maps the status to an evaluator result.
  - Do not touch: bench/evaluator/index.mjs or any existing file.
  - do:
    1. Take injected functions: `exportWorkspace(workspace, destination)`, `createEvaluator()` that resolves to `evaluateWorkspace`, and `resolveBenchmarkTaskId(taskId)`. Take an optional temp root that defaults to the system temp directory.
    2. In `evaluate` create a new directory with `mkdtemp` and prefix `agent-control-model-eval-`, export into a `workspace` child directory that is empty, call `evaluateWorkspace` with the benchmark task ID and that child path, and remove the temp directory in a `finally` block.
    3. Map `{ public_status, oracle_status }`: PASS and PASS gives `{ passed: true, reasonCode: 'resolved_hidden' }`; PASS and anything else gives `oracle_fail`; FAIL gives `public_fail`; TIMEOUT gives `timeout`; CRASH gives `crash`; POLICY_VIOLATION gives `policy_violation`; everything else gives `runner_failure`. All reason codes must match the task-service reason-code pattern.
    4. Any thrown error returns `{ passed: false, reasonCode: 'runner_failure' }`. Never include error text.
    5. Test every mapping, the cleanup on success and on failure, and that the benchmark task ID, not the attempt ID, reaches the evaluator.
  - check: npm run typecheck exits 0 and npm test exits 0 with the new tests passing.
  - Verify: No test leaves a directory with the temp prefix in the system temp directory.
  - Source: Local code at commit 0154f70: src/application/ports/index.ts and bench/evaluator/index.mjs `detailResult`.
  - proof: src/adapters/g0-model-evaluator.ts with 6 tests: status mapping to resolved_hidden, oracle_fail, public_fail, timeout, crash, policy_violation, runner_failure; exports into a child directory of a mkdtemp directory with prefix agent-control-model-eval- and removes it in finally; lint clean; no leftover temp directory; npm run verify exit 0 (294 tests, 293 pass, 1 skipped for symlink creation, 0 fail), 2026-11-10, Opus 5.5

- [x] **G19.8 Add the benchmark application service and its ports.**
  - tier: strong · high
  - gate: auto
  - after: none
  - Files: src/application/benchmark-services.ts (new); src/application/benchmark-services.test.ts (new); src/application/ports/index.ts (exists).
  - files: src/application/benchmark-services.ts (new); src/application/benchmark-services.test.ts (new); src/application/ports/index.ts (exists).
  - Anchor: `export interface TaskApplicationServices {` in src/application/task-services.ts; `export interface GeneratedCodeExecutionGatePort {` in src/application/ports/index.ts
  - Change: Add `createBenchmarkApplicationServices` with `list`, `run`, and `report`, and the ports it needs. The application layer must not import infra, interfaces, node built-ins, or adapters.
  - Do not touch: `task-services.ts`, the domain files, or the import-boundary test.
  - do:
    1. Add ports `BenchmarkCatalogPort` (`listSuites`, `getSuite`, `registerAttempt`, `benchmarkTaskIdFor`), `BenchmarkResultSinkPort` (`write(result)`, `list(runId)`), `RunMetricsCollectorFactoryPort` (`create()`, returning an object with `start`, `markFirstOutput`, `recordToolCall`, `stop`, `snapshot`), `BenchmarkResultBuilderPort` (builds and validates a result record from the outcome inputs; the composition backs it with `deriveLocalRunOutcome` and `validateLocalRunResult`), and `BenchmarkAttemptObserverPort` (`begin(attemptTaskId)` and `finish(attemptTaskId)`, returning `{ agentOutcome: 'proposal' | 'refusal' | 'error' | 'none', toolOperations: readonly string[], toolFailureCode: string | null }`).
    2. `run({ suiteId, taskId?, repetitions, runId, approvedReviewSetSha256 })` loops tasks in catalog order and attempts 1..repetitions. Reject a missing or malformed approval hash, an unknown suite, an unknown task, and `repetitions` outside 1..100.
    3. Per attempt: build the attempt task ID from the Decisions format, register it with the catalog, create the task from the catalog envelope input, classify, approve with one `ApprovalGrantV1` limited to the task operation `write` and bound to the envelope hash, queue, then run. Use the injected clock and ID ports.
    4. Start the metrics collector before `runTask` and stop it after. A collector failure must not change the result.
    5. After `runTask`, read the final task status and events and call `finish` on the observer. Derive the outcome with the mapping in the Decisions: evaluator reason codes from the events (`verification_passed` is `resolved_hidden`; a FAILED event with actor `evaluator` carries the other codes), the observer's agent outcome, and the observer's tool failure code. Take tool-call counts and policy denial codes from the observer, not from events. Build the record through `BenchmarkResultBuilderPort` so the application layer does not import infra.
    6. Write one result per attempt through the sink. Stop the whole run on a sink failure. Do not retry an attempt.
    7. `report(runId)` returns counts per category (`resolved_hidden`, `public_pass`, `policy_clean`, `timeout`, `runner_failure`) and per task, computed only from stored results.
    8. Tests with fakes: a full run with 2 tasks and 2 repetitions, every outcome mapping including each tool failure code and each agent outcome, an unapproved hash is rejected before any task is created, a sink failure stops the run, a metrics failure does not change the result, an observer that throws does not change the result, attempts run strictly in sequence.
  - check: npm run typecheck exits 0, npm test exits 0 including src/application/import-boundary.test.ts, and npx biome lint src/application reports no new diagnostics.
  - Verify: The import-boundary test passes and no attempt starts before the previous one finished.
  - Source: Local code at commit 0154f70: src/application/task-services.ts, src/infra/benchmark-result.ts, and the G2.6 text in GOALS 2.
  - proof: src/application/benchmark-services.ts and ports with 14 tests (including import-boundary): approval hash format, sequential attempts, approval grant limited to the task operation write, outcome mapping from evaluator events and the attempt observer, observer and metrics failures swallowed, patch facts from the observer with a zero fallback, report counts from stored results; the plan was revised once (observers instead of events) and once more (patch facts); the service checks only the format of the approval hash, the composition passes it to the evaluator which enforces it; npm run verify exit 0 (294 tests, 293 pass, 1 skipped for symlink creation, 0 fail), 2026-11-10, Opus 5.5

- [x] **G19.9 Add the benchmark catalog that reads the verified bench tasks.**
  - tier: standard · high
  - gate: auto
  - after: none
  - Files: src/infra/benchmark-catalog.ts (new); src/infra/benchmark-catalog.test.ts (new).
  - files: src/infra/benchmark-catalog.ts (new); src/infra/benchmark-catalog.test.ts (new).
  - Anchor: `export interface TaskEnvelopeV1 {` in src/domain/task.ts; `export class LocalSnapshotStore` in src/infra/local-snapshot-store.ts
  - Change: Add `LocalBenchmarkCatalog`. It exposes the suite `g2-local-pure-localized` with tasks P01–P04 and B01–B06, and the envelope input for each.
  - Do not touch: bench/tasks, bench/schema, the snapshot store, or any existing file.
  - do:
    1. Read `bench/tasks/<ID>/task.json` and `snapshot.json` through ordinary-file reads under a trusted repository root. Reject any file that is a symlink.
    2. For each task build the envelope input: prompt, `allowedPaths` from `allowed_globs`, `requestedOperations` equal to `["write"]`, no declared tests, and `baseSnapshotSha256`.
    3. Ensure the base snapshot exists in the injected snapshot store. Capture it from `bench/tasks/<ID>/base` and require that the resulting snapshot ID equals `base_snapshot_sha256`. Refuse the task otherwise.
    4. Implement `registerAttempt` and `benchmarkTaskIdFor` with an in-memory map. Reject an attempt ID that is not in the Decisions format or that maps to a task outside the suite.
    5. Test with a temp repository root that has two small fixture tasks: envelope contents, snapshot mismatch refusal, symlink refusal, attempt registration, and unknown suite or task.
  - check: npm run typecheck exits 0 and npm test exits 0 with the new tests passing.
  - Verify: No envelope contains `read`, `process`, or `network`, and `validateTaskEnvelopeV1` accepts every envelope.
  - Source: Local code at commit 0154f70: bench/tasks/B01/task.json and src/infra/local-snapshot-store.ts.
  - proof: src/infra/benchmark-catalog.ts with 8 tests (7 pass, 1 skipped for symlink creation): envelope inputs carry requestedOperations write and are accepted by validateTaskEnvelopeV1 including for the real B01; the real B01 snapshot ID equals its base_snapshot_sha256; symlink refusal is coded but not exercised on this host; its methods are synchronous or throwing, so the composition (G19.10) adapts them to the application port; npm run verify exit 0 (294 tests, 293 pass, 1 skipped for symlink creation, 0 fail), 2026-11-10, Sonnet 5.5

- [x] **G19.10 Compose the benchmark application.**
  - tier: strong · high
  - gate: auto
  - after: G19.2, G19.3, G19.4, G19.5, G19.7, G19.8, G19.9
  - Files: src/composition/benchmark-cli.ts (new); src/composition/benchmark-cli.test.ts (new).
  - files: src/composition/benchmark-cli.ts (new); src/composition/benchmark-cli.test.ts (new).
  - Anchor: `agent: { invoke: async () => { throw new Error('local_runtime_unavailable'); } },` in src/composition/local-cli.ts
  - Change: Add `createBenchmarkApplication`. It builds the real pipeline: stores, workspace manager, tool gateway with the diff applier and the gate, the file-edit Ollama adapter, the model evaluator adapter, the catalog, the result writer, and the metrics collector.
  - Do not touch: src/composition/local-cli.ts or any existing file.
  - do:
    1. Mirror `createLocalCliApplication` for the stores, lease, policy, clock, and workspace manager. Use a separate state directory `.agentctl/benchmark` under the repository root.
    2. Build `ClosedToolGateway` with `paths` and `patches` set to the workspace manager, `generatedCodeGate` set to `AttestationGeneratedCodeGate`, and `testRegistry` that registers nothing.
    3. Build `OllamaAgentAdapter` with `outputMode: 'file_edits'`, the default model tag, and the context reader from G19.3.
    4. Build `G0ModelWorkspaceEvaluator` with `exportWorkspace` from the manager, `createEvaluator` that calls `createModelWorkspaceEvaluator` with the approved hash, and `resolveBenchmarkTaskId` from the catalog.
    5. Adapt the catalog to the application `BenchmarkCatalogPort` with a thin wrapper in the same file: map the catalog's synchronous or throwing methods to the port's promise and null shapes (`getSuite` returns null for an unknown suite; `benchmarkTaskIdFor` returns null for an unknown attempt; `registerAttempt` takes the port's object argument). Do not change the catalog.
    6. Wrap the agent port and the tool execution port with observers that implement `BenchmarkAttemptObserverPort` as described in the Decisions. Parse the operations of a proposal defensively (only a plain object with a `toolRequests` array of plain objects with a known `operation` string counts). Record the tool failure code from `ToolGatewayError.code` or the workspace patch error code, and never keep error text. Provide the `BenchmarkResultBuilderPort` from `deriveLocalRunOutcome` and `validateLocalRunResult`.
    7. The function takes `{ repositoryRoot, approvedReviewSetSha256, agentOverride? }`. `agentOverride` replaces only the agent port. It exists for the pipeline smoke script (G19.12) and no CLI code may set it. The function must refuse a malformed hash and a non-absolute root.
    8. Return the existing task, snapshot, and runtime services plus the benchmark services.
    9. Test with injected fakes for the agent, evaluator, gate, and catalog: the wiring order is correct, the gateway holds the gate, a closed gate makes `apply_unified_diff` fail with `g2_isolation_required` and the observer records that code, an agent error is recorded as `error`, an unparseable proposal records no operations, and a malformed hash is refused.
  - check: npm run typecheck exits 0 and npm test exits 0 with the new tests passing.
  - Verify: With the gate closed, no workspace file changes in the closed-gate test.
  - Source: Local code at commit 0154f70: src/composition/local-cli.ts and src/composition/test-cli.ts.
  - proof: src/composition/benchmark-cli.ts with 9 tests (typecheck 0, lint clean, full npm test 303 tests with 302 pass and 1 skipped, 0 fail): `createBenchmarkApplication({ repositoryRoot, approvedReviewSetSha256, agentOverride? }, testSeams?)` refuses a malformed hash and a relative root before touching the filesystem; the gateway holds `AttestationGeneratedCodeGate`, and with no attestation an `apply_unified_diff` attempt ends POLICY_VIOLATION with `g2_isolation_required` and an unchanged workspace; the evaluator is loaded by file URL at call time and recomputes the review-set hash per attempt; observers record agent outcome, operations, tool failure code and patch facts (1 changed file, lines, diff SHA-256) without keeping diff or error text; catalog adapted to the application port; result sink `list` written in the composition (ordinary files only, validated); no process spawn in the composition; no real Ollama, evaluator, probe or launcher was run, 2026-11-10, Opus 5.5

- [x] **G19.11 Implement the benchmark commands in agentctl.**
  - tier: strong · high
  - gate: auto
  - after: G19.8, G19.10
  - Files: src/interfaces/cli/agentctl-core.ts (exists); src/interfaces/cli/agentctl.test.ts (exists); src/bin/agentctl.ts (exists).
  - files: src/interfaces/cli/agentctl-core.ts (exists); src/interfaces/cli/agentctl.test.ts (exists); src/bin/agentctl.ts (exists).
  - Anchor: `{ prefix: ['benchmark', 'run'], kind: 'benchmark.run', options: {`; `    case 'benchmark.list':`
  - Change: Replace the three benchmark stubs. `run` takes a required `--approve-review-set-sha256`.
  - Do not touch: The other commands, their option grammar, the exit codes of other commands, or `src/composition/local-cli.ts`.
  - do:
    1. Read `src/bin/agentctl.ts`, `agentctl-core.ts`, and the CLI tests first.
    2. Add the required option `--approve-review-set-sha256` to `benchmark run` and validate 64 lowercase hex characters. Carry it in the parsed command.
    3. Add an optional `benchmark` member to `CliApplication`. Implement `benchmark.list`, `benchmark.run`, and `benchmark.report` by calling it. Keep `comparison.*` as unavailable.
    4. `benchmark.run` requires `startup.state === 'ready'` and the existing mutation lock rules. If the application has no `benchmark` member, return the existing `capability_unavailable` result.
    5. In `src/bin/agentctl.ts` create the benchmark application only for `benchmark run` and `benchmark report`, with the repository root from the file location, and the existing local application otherwise.
    6. Human output stays short: run ID, counts per category, and the result directory. JSON output uses the existing envelope format.
    7. Tests: parse errors for a missing or malformed hash; `list` and `report` with a fake service; `run` passes the hash through; an application without a benchmark service returns `capability_unavailable`; the `comparison.*` commands are unchanged.
  - check: npm run typecheck exits 0, npm test exits 0, and npx biome lint src/interfaces reports no new diagnostics.
  - Verify: `benchmark run` without the approval option exits with the existing invalid-arguments exit code and creates no task.
  - Source: Local code at commit 0154f70: src/interfaces/cli/agentctl-core.ts lines for the benchmark commands.
  - proof: agentctl benchmark list, run and report implemented in src/interfaces/cli/agentctl-core.ts and src/bin/agentctl.ts with 19 CLI tests: `benchmark run` requires `--approve-review-set-sha256` (64 lowercase hex; a missing or malformed value gives invalid_command, exit 2, and no application or task is created); run is blocked while the lease is busy; comparison commands stay capability_unavailable; BenchmarkServiceError codes map to fixed Portuguese messages with no error text, path or stack; the CLI never sets agentOverride (grep over src/interfaces and src/bin finds no agentOverride, benchmark-smoke or scripted); decisions: `benchmark list` also gets the benchmark composition, task IDs are uppercased before the service call, `list` and `report` pass an all-zero sentinel hash that cannot reach an evaluator because the evaluator is built lazily and those commands never run a task; two existing CLI tests were adjusted; npm run verify exit 0 (314 tests, 313 pass, 1 skipped for symlink creation, 0 fail), git diff --check clean, 2026-11-10, Opus 5.5

- [x] **G19.12 Add the pipeline smoke script that replays one reference patch through the real path.**
  - tier: standard · high
  - gate: auto
  - after: G19.10
  - Files: src/composition/benchmark-smoke.ts (new); src/composition/benchmark-smoke.test.ts (new).
  - files: src/composition/benchmark-smoke.ts (new); src/composition/benchmark-smoke.test.ts (new).
  - Anchor: `createBenchmarkApplication(` in src/composition/benchmark-cli.ts
  - Change: Add a script that builds the benchmark application with a scripted agent in place of the model, then runs one task twice: once with the reference patch and once with a wrong patch.
  - Do not touch: The production CLI entry. The scripted agent must not be reachable from `agentctl`.
  - do:
    1. Export `runPipelineSmoke({ repositoryRoot, approvedReviewSetSha256, taskId })`. Add a `main` that reads the hash from `--approve-review-set-sha256` and the task from `--task-id` (default `B01`) when the file runs directly.
    2. Build the benchmark application through `createBenchmarkApplication` with its `agentOverride` option (added in G19.10) set to the scripted agent. Do not change the composition.
    3. The scripted agent returns one `apply_unified_diff` proposal. Attempt 1 uses the text of `bench/tasks/<ID>/reference.patch`. Attempt 2 uses a diff that changes a different line, so it applies but does not fix the task.
    4. Print one JSON line per attempt with the outcome category and the evaluator reason code. Print nothing from the patch or the oracle.
    5. Exit 0 only when attempt 1 is `resolved_hidden` and attempt 2 is not.
    6. Unit test the script logic with fakes: the exit decision for each outcome combination.
  - check: npm run typecheck exits 0 and npm test exits 0 with the new tests passing.
  - Verify: `rg "scripted" src/interfaces src/bin` finds no use of the scripted agent in the production CLI.
  - Source: Local code at commit 0154f70: bench/tasks/B01/reference.patch and src/composition/test-cli.ts.
  - proof: src/composition/benchmark-smoke.ts with 5 tests: `runPipelineSmoke` runs one task twice with a scripted agent (attempt 1 sends the reference patch, attempt 2 a no-op rewrite built from public data), `ok` only when attempt 1 is resolved and attempt 2 is not, strict flag parsing, output is one JSON line per attempt with no patch text, oracle data or paths, exit codes 0, 1 and 2; the smoke was NOT run (it needs the new attestation); the scripted agent is reachable only from this file; npm run verify exit 0 (314 tests, 313 pass, 1 skipped for symlink creation, 0 fail), git diff --check clean, 2026-11-10, Sonnet 5.5

- [x] **G19.13 Run deterministic checks and obtain an independent security review.**
  - tier: strong · high
  - gate: auto
  - after: G19.1, G19.2, G19.3, G19.4, G19.5, G19.6, G19.7, G19.8, G19.9, G19.10, G19.11, G19.12
  - Files: src/workspace/snapshot-manager.ts (exists); bench/evaluator/index.mjs (exists); src/adapters/ollama.ts (exists).
  - files: src/workspace/snapshot-manager.ts (exists); bench/evaluator/index.mjs (exists); src/adapters/ollama.ts (exists).
  - Anchor: `createModelWorkspaceEvaluator(`
  - Change: Run the project checks and an independent review of the new path. Resolve every finding before the evidence chain.
  - Do not touch: Probe reports, profiles, the attestation file, or user files. Do not run the probe, the evaluator on a workspace, or a model in this item.
  - do:
    1. Run npm run verify. Require exit code 0.
    2. Run git diff --check. Require exit code 0.
    3. Ask an independent reviewer to check that no model-generated text reaches a shell, a file path, or the evaluator without validation.
    4. Ask the reviewer to check the workspace `apply` for path traversal, symlink handling, and partial writes.
    5. Ask the reviewer to check that `evaluateTask` still refuses `source=model` and that the G0 path is behavior-identical after the refactor.
    6. Ask the reviewer to check the approval grant, the closed-gate behavior, and that the model adapter cannot approve work or write events.
    7. Resolve every blocker. Stop if a check fails.
  - check: npm run verify exits 0; git diff --check exits 0; the independent review reports no blockers.
  - Verify: No model, probe, or isolated evaluation ran in this item.
  - Source: Project `AGENTS.md` safety gates.
  - proof: npm run verify exit 0 (316 tests, 315 pass, 1 skipped for symlink creation, 0 fail); git diff --check clean; independent security review found no blockers and one should-fix plus four notes. Fixed: (1) the owner review-set hash is now checked upfront for `benchmark run` by awaiting the evaluator factory before any store or agent call, and a failure ends as `approval_hash_invalid` (new `readOnly` option for list and report skips that check and also skips recovery, so those commands write no events); (2) the model workspace evaluator rejects symlinks, junctions, special entries and any regular file with a link count other than 1 before restoring the base or running a case, with 3 new Windows-only tests (the file-symlink case was skipped on this host); (4) a workspace `path_denied` now counts as `tool_policy_denied` and ends POLICY_VIOLATION. Left open on purpose: note 3 (the evaluator runs on a caller-owned directory; the manifest checks catch persistent changes but not a change reverted mid-run by host code; the shipped pipeline gives it a private copy). Not verified yet: the real isolated evaluator path (G19.18), the real evaluator loader in the composition, and the smoke script run (G19.19). G19.12 smoke unit tests were not rerun after the upfront check was added; they passed in the final verify, 2026-11-10, Opus 5.5

- [x] **G19.14 Rerun the bounded probe once because the runner fingerprint changed.**
  - tier: strong · high
  - gate: ask
  - after: G19.13
  - Files: GOALS.md (exists).
  - files: GOALS.md (exists).
  - Anchor: `- [x] **G2.3 [POST-G2.2 GATE] Close the behavioral G0 benchmark.**`
  - Change: Run `npm run isolation:appcontainer:probe` once and record the result under G2.6.
  - Do not touch: Any source file, the G2.6 checkbox, or the attestation file.
  - do:
    1. Ask the owner to confirm the rerun under the bounded authorization for the probe.
    2. Run npm run isolation:appcontainer:probe once. Do not repeat it unchanged.
    3. Read the status, `failure`, every check, and `runner_sha256`.
    4. Record the report SHA-256 and the result under G2.6.
    5. Stop if the status is not `PASS`.
  - check: The probe prints `AppContainer probes: PASS` and exits 0.
  - Verify: Exactly one probe invocation ran.
  - Source: The bounded authorization for the probe recorded in GOALS 6.
  - proof: one probe invocation, exit 0, status PASS, 22 of 22 checks PASS, failure null, report 90a9e78628fbdc81e56bc410127368d880c752d533faa8a39e79caabe87ee5e9, runner fingerprint b36913f612bb2113aa6676a7be6c7a0474b4971621b85e58e8d2eb182e3efdca; -SelfTest PASS before it; agentcp* profile directories 7 before and after, 2026-11-10, Opus 5.5

- [x] **G19.15 Write the new isolation attestation.**
  - tier: standard · low
  - gate: ask
  - after: G19.14
  - Files: GOALS.md (exists).
  - files: GOALS.md (exists).
  - Anchor: `- [x] **G2.3 [POST-G2.2 GATE] Close the behavioral G0 benchmark.**`
  - Change: Write the attestation for the report from G19.14.
  - Do not touch: The probe report or any source file.
  - do:
    1. Ask the owner to confirm that the agent may write the attestation for the reviewed report.
    2. Move the existing `runtime/diagnostics/g2-isolation-evidence.json` into the backup folder `<work>\backup-agentcp-2026-11-09`.
    3. Run `npm run isolation:attest -- --approve-report-sha256 <report SHA-256 from G19.14>`.
    4. Record the attestation SHA-256 under G2.6.
  - check: The command exits 0 and `runner_sha256` in the attestation equals `runner_sha256` in the report.
  - Verify: The new attestation validates through `readG2IsolationAttestation`.
  - Source: GOALS 17 owner items.
  - proof: run by the agent after the owner confirmed running G19.14 to G19.16: attestation SHA-256 7bdfb19697c67c6fca3c44e54c6fd21efd2dbdc87eb14338a5a8a58be99cbcea, runner_sha256 equals the report runner_sha256, status PASS; old attestation moved to the backup folder, 2026-11-10, Opus 5.5

- [x] **G19.16 Regenerate the G0 review index.**
  - tier: standard · low
  - gate: auto
  - after: G19.15
  - Files: bench/review/reference-patches.md (exists).
  - files: bench/review/reference-patches.md (exists).
  - Anchor: `G0 review-set approval SHA-256:`
  - Change: Run the review preparation so the index carries the new evaluator fingerprint and hash.
  - Do not touch: Any task, patch, oracle, or snapshot file.
  - do:
    1. Run npm run benchmark:g0:prepare.
    2. Record the printed review-set SHA-256 under G2.6.
    3. Check that all 20 task rows in the index equal the previous index.
  - check: npm run benchmark:g0:prepare exits 0 and git diff --stat -- bench/tasks bench/oracles prints nothing new.
  - Verify: Only the fingerprint and the hash changed in the index.
  - Source: `prepareReview` in bench/evaluator/g0-report.mjs.
  - proof: npm run benchmark:g0:prepare exit 0, review-set SHA-256 c9a82e5e503da49f4189cfe70ae8d6debfa93edb735c43f47952b9acdb3bce65; all 20 task rows identical to the previous index; the only tracked changes under bench/tasks are the two reference.patch hunk-header fixes made and approved earlier, 2026-11-10, Opus 5.5

- [x] **G19.17 Approve the new review-set hash.**
  - tier: user
  - gate: ask
  - after: G19.16
  - Files: none (owner action).
  - files: none.
  - do:
    1. Compare the printed hash with the hash you approved last. The tasks and patches did not change; the evaluator did.
    2. Tell the agent the hash you approve.
  - check: manual — you state the approved hash in the chat.
  - Verify: The approved hash equals the hash printed by G19.16.
  - proof: the owner approved review-set hash c9a82e5e503da49f4189cfe70ae8d6debfa93edb735c43f47952b9acdb3bce65 in chat on 2026-11-10 ("Approve and run"); it equals the hash printed by G19.16

- [x] **G19.18 Rerun the G0 benchmark as a regression test of the changed evaluator.**
  - tier: strong · medium
  - gate: ask
  - after: G19.17
  - Files: GOALS.md (exists).
  - files: GOALS.md (exists).
  - Anchor: `- [x] **G2.3 [POST-G2.2 GATE] Close the behavioral G0 benchmark.**`
  - Change: Run the G0 benchmark once with the approved hash and record the result under G2.6.
  - Do not touch: Any source file or the G2.3 checkbox.
  - do:
    1. Run node bench/evaluator/index.mjs --run --approve-review-set-sha256 <hash from G19.17> once.
    2. Require `G0 PASS`, 20 of 20 references PASS, and 20 of 20 null controls failing.
    3. Check that no `agentcp*` profile or evaluator temp directory remains.
    4. Run npm run test:evaluator:post-g2.2 once and require exit 0. It covers the two isolated tests from G19.6.
    5. Stop if anything fails. Report the failing stage.
  - check: The command prints `G0 PASS` and exits 0, and `npm run test:evaluator:post-g2.2` exits 0.
  - Verify: The model path did not change the G0 result.
  - Source: GOALS 2 G2.3 evidence.
  - proof: `node bench/evaluator/index.mjs --run --approve-review-set-sha256 c9a82e5e503da49f4189cfe70ae8d6debfa93edb735c43f47952b9acdb3bce65` printed G0 PASS, exit 0 (report f83eddb1891214f0649289b4c04267df37cacee7f3889a4e5da8a91078a9d2fa); 20 of 20 references PASS and 20 of 20 null controls failed; `npm run test:evaluator:post-g2.2` 5 of 5 pass including the two isolated model-workspace tests; no leftover profile or temp directory; the refactored evaluator did not change the G0 result, 2026-11-10, Opus 5.5

- [x] **G19.19 Run the pipeline smoke with the scripted reference patch.**
  - tier: strong · medium
  - gate: ask
  - after: G19.18
  - Files: GOALS.md (exists).
  - files: GOALS.md (exists).
  - Anchor: `- [ ] **G2.6 Run the 1.5B local benchmark under the defined protocol.**`
  - Change: Run `node src/composition/benchmark-smoke.ts --approve-review-set-sha256 <hash> --task-id B01` once and record the result under G2.6.
  - Do not touch: Any source file or the G2.6 checkbox. No model runs in this item.
  - do:
    1. Ask the owner to confirm one run of the real pipeline with the scripted agent.
    2. Run the command once.
    3. Require attempt 1 `resolved_hidden` and attempt 2 not resolved, and exit 0.
    4. Check that no `agentcp*` profile or temp directory remains.
    5. Record both outcome lines under G2.6.
  - check: The script exits 0 and prints one `resolved_hidden` attempt and one unresolved attempt.
  - Verify: The result files for both attempts exist under `bench/results/local/` and validate through `validateLocalRunResult`.
  - Source: The pipeline smoke script from G19.12.
  - proof: node src/composition/benchmark-smoke.ts ran once: attempt 1 resolved_hidden (reference patch), attempt 2 not_resolved (no-op rewrite), exit 0; both result files validate and contain no patch text or paths; no leftover profile or temp directory; no model ran, 2026-11-10, Opus 5.5

- [ ] **G19.20 Authorize the first model-generated runs.**
  - tier: user
  - gate: ask
  - after: G19.19
  - Files: none (owner action).
  - files: none.
  - do:
    1. Read the smoke result under G2.6. It shows the full path with a known-good and a known-bad patch.
    2. Tell the agent in the chat that the model-generated runs may start, with the review-set hash.
    3. The existing G2.6 item then runs `agentctl benchmark run` for P01–P04 and B01–B06 with three repetitions.
  - check: manual — you state the authorization and the hash in the chat.
  - Verify: The hash equals the approved hash from G19.17.
