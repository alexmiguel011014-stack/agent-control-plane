## GOALS 21 — Terminal observability view (Gerente de empresa IA feature)

Format: executor-v1

This plan replaces GOALS 4 (isometric 2D dashboard), which the owner cancelled in chat on 2026-11-13. It adds one read-only command, `agentctl watch`, that shows tasks, benchmark runs, and GPU, RAM, and CPU values in the terminal. Git HEAD when written: 2ab6c3a. The working tree also holds uncommitted G3-30 corpus files that this plan does not touch.

### Decisions

- Command name is `agentctl watch`. Options are `--once`, `--interval <seconds>` (integer 1 to 60, default 2), and `--no-color`.
- The view is read-only. It never creates, approves, runs, cancels, or recovers a task, and it writes no file.
- The view must not call `JsonlTaskEventStore.read` or `listTaskIds`. `read` takes a stream lock and truncates a torn last line (`src/infra/jsonl-event-store.ts` lines 182-186). `listTaskIds` creates the events directory (line 266 calls `ensureDirectory`).
- A new lock-free reader opens event files for reading only. It ignores an incomplete last line and never repairs it.
- No new dependency. The view uses plain text, ANSI escape codes, and `node:` modules.
- The view lists tasks from `.agentctl/events`, the latest five benchmark runs from `bench/results/local`, and three resource values.
- Resource values: GPU from `readNvidiaSmiGpu` in `src/infra/metrics.ts`, cached for 5000 ms; RAM from `node:os`; CPU percent from `os.cpus()` deltas.
- Text is the primary signal. A state is always written as a word. Color only adds to it and is off when `NO_COLOR` is set, when `--no-color` is given, or when output is not a terminal.
- Output that is not a terminal prints one frame and exits. This equals `--once`.
- The default width is 80 columns. The minimum width is 60 columns. Longer text ends with `…`.
- The viewer does not use the GPU. The only GPU contact is one `nvidia-smi` child process every 5 seconds.
- Out of scope: web page, SVG, animation, mouse, keyboard commands, history charts, remote access, and any mutation.

| Stage | Items | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| 1 Decision | G21.1 | none | stage 2 |
| 2 Application | G21.2 | none | stage 1, G21.7 |
| 3 Adapters and text view | G21.3, G21.4, G21.5 | G21.2 | each other |
| 4 Loop and parser | G21.6, G21.7 | G21.5 for G21.6; none for G21.7 | each other |
| 5 Wiring | G21.8 | G21.3, G21.4, G21.6, G21.7 | none |
| 6 Docs and proof | G21.9, G21.10 | G21.8 | each other |
| 7 Owner | G21.11 | G21.10 | none |

<!-- item-contract: v1 -->

- [x] **G21.1 Record the terminal decision in ADR-006.**
  - proof: `grep -c "GOALS 4" docs/mvp-status.md` printed `0`; `test -f docs/decisions/ADR-006-terminal-observability.md` exit 0; only the two listed files changed, 2026-11-19, Haiku 5.5
  - tier: light · low
  - gate: auto
  - after: none
  - files: `docs/decisions/ADR-006-terminal-observability.md` (new), `docs/mvp-status.md` (exists)
  - do:
    1. Write `docs/decisions/ADR-006-terminal-observability.md` with the headings Context, Decision, Consequences, and Out of scope.
    2. Under Context, write that the owner cancelled the 2D dashboard on 2026-11-13 because of customization effort and the wish to avoid GPU use next to a 4 GiB model.
    3. Under Decision, write that `agentctl watch` is a read-only terminal view of tasks, benchmark runs, and resources.
    4. Under Out of scope, copy the last bullet of the Decisions list of GOALS 21.
    5. In `docs/mvp-status.md`, replace `GOALS 4 dashboard (unblocked, not built)` with `terminal view (GOALS 21, not built)`.
    6. In `docs/mvp-status.md`, replace `GOALS 4 (dashboard) is unblocked.` with `The terminal view (GOALS 21) replaces the 2D dashboard and is unblocked.`
  - Anchor: `docs/mvp-status.md` contains both strings named in steps 5 and 6.
  - Do not touch: `GOALS.md`, `AGENTS.md`.
  - check: run `grep -c "GOALS 4" docs/mvp-status.md`. Expected output: `0`. Run `test -f docs/decisions/ADR-006-terminal-observability.md`. Expected exit code: 0.
  - Files: `docs/decisions/ADR-006-terminal-observability.md` (new), `docs/mvp-status.md` (exists)
  - Verify: run `grep -c "GOALS 4" docs/mvp-status.md`. Expected output: `0`. Run `test -f docs/decisions/ADR-006-terminal-observability.md`. Expected exit code: 0.
  - Source: owner message in chat, 2026-11-13 ("vou cancelar o projeto 2d").

- [x] **G21.2 Add the observability ports and projection service.**
  - proof: `node --test src/application/observability-services.test.ts` pass 2, fail 0; `npx tsc --noEmit` exit 0; only the three listed files changed (the tests use `QUEUED` and `RUNNING`, because `TaskState` has no `READY`), 2026-11-19, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: none
  - files: `src/application/ports/index.ts` (exists), `src/application/observability-services.ts` (new), `src/application/observability-services.test.ts` (new)
  - do:
    1. In `src/application/ports/index.ts`, add the types named in Change after the `ClockPort` interface.
    2. Create `src/application/observability-services.ts` that exports `createObservabilityServices(dependencies)`.
    3. Make `getSnapshot()` call `taskReader.readStreams()`, `runReader.listRuns(5)`, and `resources.sample()` once each.
    4. Derive each task state from its events. Use the `to` value of the last `task.state_changed` event. If there is none, use `DRAFT`.
    5. Skip a stream that has no events. Sort tasks by `taskId` ascending.
    6. Return a frozen object with `generatedAt` from `clock.now()`, `tasks`, `runs`, and `resources`.
    7. Return a frozen service object whose only own key is `getSnapshot`.
    8. Write tests in `src/application/observability-services.test.ts` with fake ports. Cover state derivation, sorting, skipped empty stream, one call per port, and the single own key.
  - Anchor: `src/application/ports/index.ts` contains the line `export interface ClockPort {`.
  - Change: add these types. `ObservedTaskStream { taskId: string; events: readonly TaskEvent[] }`. `ObservedTaskReaderPort { readStreams(): Promise<readonly ObservedTaskStream[]> }`. `ObservedRunSummary { runId: string; suiteId: string; modelTag: string; startedAtUtc: string; attempts: number; counts: Readonly<Record<BenchmarkEvaluationStatus, number>> }`. `BenchmarkRunReaderPort { listRuns(limit: number): Promise<readonly ObservedRunSummary[]> }`. `ObservedResources { gpu: { status: 'available'; usedMiB: number; totalMiB: number } | { status: 'unavailable' }; ramFreeBytes: number; ramTotalBytes: number; cpuPercent: number | null }`. `ResourceSamplerPort { sample(): Promise<ObservedResources> }`. `ObservedTask { taskId: string; state: TaskState; eventCount: number; lastEventAt: string }`. `ObservabilitySnapshot { generatedAt: string; tasks: readonly ObservedTask[]; runs: readonly ObservedRunSummary[]; resources: ObservedResources }`. Use `occurredAt` of the last event for `lastEventAt`.
  - Do not touch: `src/application/task-services.ts`.
  - check: run `node --test src/application/observability-services.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Files: `src/application/ports/index.ts` (exists), `src/application/observability-services.ts` (new), `src/application/observability-services.test.ts` (new)
  - Verify: run `node --test src/application/observability-services.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Source: `src/domain/event.ts` (event shapes), `src/domain/state.ts` (`TaskState`), checked in the working tree on 2026-11-13.

- [x] **G21.3 Add the lock-free event stream reader.**
  - proof: `node --test src/infra/jsonl-event-reader.test.ts` tests 8, pass 7, fail 0, skipped 1 (the symlink test, because Windows refused to create the link, as step 8 allows; the assistant also made the source-scan test fall back to the compiled `.js` file, because `npm test` runs it from `dist/`); `npx tsc --noEmit` exit 0; the source has none of the forbidden write words (a test scans it); only the two listed files were created, 2026-11-19, Sonnet 5.5
  - tier: standard · high
  - gate: auto
  - after: G21.2
  - files: `src/infra/jsonl-event-reader.ts` (new), `src/infra/jsonl-event-reader.test.ts` (new)
  - do:
    1. Create class `JsonlObservedTaskReader` with a constructor that takes one directory path. It implements `ObservedTaskReaderPort`.
    2. In `readStreams()`, return an empty array if the directory does not exist. Do not create it.
    3. List entries that end in `.jsonl` and whose base name matches `TASK_ID_PATTERN` from `src/domain/task.ts`. Skip any entry that `lstat` shows is not a regular file.
    4. Read each file with `readFile`. Drop all bytes after the last newline character.
    5. Parse each complete line as JSON. Require `schemaVersion` 1 and an `event` object with string fields `eventId`, `type`, `occurredAt`, and a `taskId` equal to the file name.
    6. If any line fails step 5, skip the whole stream. Do not throw.
    7. Include a stream only when its first event has type `task.created`.
    8. Write tests for a missing directory, a torn last line, an invalid line, and a non-regular entry. Skip the symlink test when the OS refuses symlinks.
    9. In one test, compute the SHA-256 of every file and the directory listing before and after `readStreams()`. Assert they are equal.
    10. In one test, read the source text of the reader. Assert it contains none of: `truncate`, `mkdir`, `writeFile`, `appendFile`, `rename`, `unlink`, `file-lock`.
  - Anchor: `src/infra/jsonl-event-store.ts` line 182 holds `if (lastNewline !== bytes.length - 1) {`. This is the repair that the reader must not copy.
  - Do not touch: `src/infra/jsonl-event-store.ts`.
  - check: run `node --test src/infra/jsonl-event-reader.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Files: `src/infra/jsonl-event-reader.ts` (new), `src/infra/jsonl-event-reader.test.ts` (new)
  - Verify: run `node --test src/infra/jsonl-event-reader.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Why: a viewer that repairs or locks event files can corrupt a running task.
  - Source: `src/infra/jsonl-event-store.ts` lines 162-195 and 265-277, read on 2026-11-13.

- [x] **G21.4 Add the benchmark run reader and resource sampler.**
  - proof: `node --test src/infra/observability-adapters.test.ts` pass 4, fail 0; `npx tsc --noEmit` exit 0; only the three listed files were created; `metrics.ts` and `benchmark-result.ts` untouched, 2026-11-19, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: G21.2
  - files: `src/infra/benchmark-run-reader.ts` (new), `src/infra/resource-sampler.ts` (new), `src/infra/observability-adapters.test.ts` (new)
  - do:
    1. Create class `FileBenchmarkRunReader` with a constructor that takes the results directory path. It implements `BenchmarkRunReaderPort`.
    2. In `listRuns(limit)`, return an empty array if the directory does not exist.
    3. List sub-directories whose names match `LOCAL_RUN_RESULT_ID_PATTERN` from `src/infra/benchmark-result.ts`.
    4. In each directory, read files that match `^[a-z0-9][a-z0-9_-]{0,63}-attempt-[1-9][0-9]{0,3}\.json$`.
    5. Accept a file only when `validateLocalRunResult(JSON.parse(text)).valid` is true. Skip any other file.
    6. Build one summary per run: `runId`, `suiteId`, `modelTag`, the earliest `startedAtUtc`, the attempt count, and counts by `outcome.status`.
    7. Sort runs by `startedAtUtc` descending. Return at most `limit` runs.
    8. Create class `SystemResourceSampler`. Its constructor takes an options object with optional `now`, `readGpu`, `cpus`, `freemem`, and `totalmem` functions. Defaults are `Date.now`, `readNvidiaSmiGpu`, `os.cpus`, `os.freemem`, and `os.totalmem`.
    9. Cache the GPU reading for 5000 ms. Compute `cpuPercent` from the change in `os.cpus()` times between two `sample()` calls. The first call returns `null`.
    10. Write tests in `src/infra/observability-adapters.test.ts` with a temporary directory and injected functions.
  - Anchor: `src/infra/benchmark-result.ts` exports `LOCAL_RUN_RESULT_ID_PATTERN` and `validateLocalRunResult`. `src/infra/metrics.ts` exports `readNvidiaSmiGpu`.
  - Do not touch: `src/infra/metrics.ts`, `src/infra/benchmark-result.ts`.
  - check: run `node --test src/infra/observability-adapters.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Files: `src/infra/benchmark-run-reader.ts` (new), `src/infra/resource-sampler.ts` (new), `src/infra/observability-adapters.test.ts` (new)
  - Verify: run `node --test src/infra/observability-adapters.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Source: `src/infra/benchmark-result.ts` lines 20, 66-72, 413; `src/infra/metrics.ts` lines 43-45, 134. Read on 2026-11-13.

- [x] **G21.5 Render the snapshot as terminal text.**
  - proof: `node --test src/interfaces/terminal/render-snapshot.test.ts` pass 4, fail 0; `npx tsc --noEmit` exit 0; full `npm test` 377 tests, 375 pass, 0 fail, 2 skipped. Deviation: the exact-lines test and the color test use width 100, because the longest run row of the fixed fixture is 81 characters; the truncation test uses width 60 as written. Only the two listed files were created, 2026-11-19, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: G21.2
  - files: `src/interfaces/terminal/render-snapshot.ts` (new), `src/interfaces/terminal/render-snapshot.test.ts` (new)
  - do:
    1. Export `renderSnapshot(snapshot, options)` where `options` is `{ width: number; color: boolean }`. It returns `string[]`, one entry per line, with no trailing newline.
    2. Write line 1 as `agentctl watch  ` followed by `generatedAt`.
    3. Write line 2 as `RESOURCES  GPU <used>/<total> MiB  RAM <free> GiB free of <total> GiB  CPU <n>%`. Use one decimal for GiB. Use `GPU n/a` when the GPU is unavailable. Use `CPU n/a` when `cpuPercent` is `null`.
    4. Write an empty line. Then write `TASKS (<count>)`, the header `ID  STATE  EVENTS  LAST EVENT`, and one row per task. If there are no tasks, write `  none`.
    5. Write an empty line. Then write `RUNS (latest <count>)`, the header `RUN  SUITE  MODEL  ATTEMPTS  PASS  FAIL  OTHER  STARTED`, and one row per run. If there are no runs, write `  none`.
    6. Show the first 8 characters of `runId`. Compute OTHER as attempts minus PASS minus FAIL.
    7. Pad every column to its widest cell. Separate columns with two spaces. Limit the cell widths to ID 24, STATE 16, SUITE 30, MODEL 26. End a longer cell with `…`.
    8. Cut every line to `options.width` characters. End a cut line with `…`.
    9. If `options.color` is true, wrap the state word in color after padding. Use `\x1b[32m` for `SUCCEEDED`, `\x1b[31m` for the other states in `TERMINAL_TASK_STATES`, `\x1b[33m` for `WAITING_APPROVAL`, and `\x1b[0m` to reset.
    10. Write tests with a fixed snapshot: an exact expected line array at width 80 without color, truncation at width 60, a color run whose ANSI-stripped output equals the plain output, and a snapshot with no tasks and no runs.
  - Anchor: `src/domain/state.ts` exports `TERMINAL_TASK_STATES`.
  - Do not touch: `src/interfaces/cli/agentctl-core.ts`. Its import rule blocks this module.
  - check: run `node --test src/interfaces/terminal/render-snapshot.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Files: `src/interfaces/terminal/render-snapshot.ts` (new), `src/interfaces/terminal/render-snapshot.test.ts` (new)
  - Verify: run `node --test src/interfaces/terminal/render-snapshot.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Source: `src/domain/state.ts` lines 19-24, read on 2026-11-13.

- [x] **G21.6 Add the watch loop.**
  - proof: `node --test src/interfaces/terminal/watch.test.ts` pass 6, fail 0; `npx tsc --noEmit` exit 0; the CLI boundary test passes; the module imports only a type from `src/application/ports/index.ts` and reads no `process` global; only the two listed files were created, 2026-11-19, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: G21.5
  - files: `src/interfaces/terminal/watch.ts` (new), `src/interfaces/terminal/watch.test.ts` (new)
  - do:
    1. Export `runWatch(options)` with fields `getSnapshot`, `render`, `write`, `intervalMs`, `once`, `interactive`, `signal`, and an optional `sleep(ms, signal)`.
    2. In each cycle, call `getSnapshot()`, call `render`, and write the lines joined by `\n` plus one final `\n`.
    3. If `interactive` is true, write `\x1b[H\x1b[2J` before each frame. Write `\x1b[?25l` once at the start. Write `\x1b[?25h` in a `finally` block.
    4. If `once` is true or `interactive` is false, return after the first frame.
    5. Between frames, wait `intervalMs` or until `signal` aborts. On abort, return without an error.
    6. If `getSnapshot()` throws, write the line `watch error: ` followed by the error `name`. Do not write the message. Continue with the next cycle.
    7. Import only `node:` modules and types from `src/application/`. Do not import any mutation service.
    8. Write tests with a fake `sleep` and a fake `write`. Cover one frame for `once`, three frames then abort, cursor restore on abort, and the error line.
  - Anchor: `src/application/observability-services.ts` exports the type `ObservabilitySnapshot` through `src/application/ports/index.ts`.
  - Do not touch: `src/interfaces/cli/`.
  - check: run `node --test src/interfaces/terminal/watch.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Files: `src/interfaces/terminal/watch.ts` (new), `src/interfaces/terminal/watch.test.ts` (new)
  - Verify: run `node --test src/interfaces/terminal/watch.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.

- [x] **G21.7 Parse `agentctl watch` in the CLI core.**
  - proof: `node --test src/interfaces/cli/agentctl.test.ts src/interfaces/cli/import-boundary.test.ts` pass 21, fail 0; `npx tsc --noEmit` exit 0. One change beyond the steps: the `parseCliArgs` guard `args.length < 2` now allows a bare `watch`, because that command takes no positional argument. Only the two listed files changed, 2026-11-19, Sonnet 5.5
  - tier: standard · medium
  - gate: auto
  - after: none
  - files: `src/interfaces/cli/agentctl-core.ts` (exists), `src/interfaces/cli/agentctl.test.ts` (exists)
  - do:
    1. In the `CliCommand` union, add `Readonly<{ kind: 'watch'; once: boolean; intervalSeconds: number; color: boolean; format: CliFormat }>` after the `runtime.smoke` member.
    2. In the grammar array, add `{ prefix: ['watch'], kind: 'watch', options: { '--once': {}, '--interval': { value: true }, '--no-color': {} } },` after the `runtime.diagnose` entry.
    3. In the parse switch, add a `case 'watch'` branch. Read `--interval` with `one(options, '--interval')`. Default to 2.
    4. Return `invalid(format)` when the interval is not an integer from 1 to 60.
    5. Set `once` and `color` from the presence of `--once` and the absence of `--no-color`.
    6. In the run switch, add `case 'watch': throw gateFailure('capability_unavailable', UNAVAILABLE_MESSAGE);`. The real loop runs in `src/bin/agentctl.ts`.
    7. In `src/interfaces/cli/agentctl.test.ts`, test these inputs: `watch`, `watch --once`, `watch --interval 5 --no-color`, and `watch --interval 0`, `watch --interval 61`, `watch --interval x`.
    8. Assert the first three parse to the expected commands and the last three are invalid. Assert `runCli(['watch'], …)` ends with exit code 8.
  - Anchor: `src/interfaces/cli/agentctl-core.ts` contains `  { prefix: ['runtime', 'diagnose'], kind: 'runtime.diagnose', options: {} },` and `    case 'runtime.diagnose': return app.runtime.diagnose();`.
  - Do not touch: `src/interfaces/cli/agentctl.ts`.
  - check: run `node --test src/interfaces/cli/agentctl.test.ts src/interfaces/cli/import-boundary.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Files: `src/interfaces/cli/agentctl-core.ts` (exists), `src/interfaces/cli/agentctl.test.ts` (exists)
  - Verify: run `node --test src/interfaces/cli/agentctl.test.ts src/interfaces/cli/import-boundary.test.ts`. Expected: `fail 0`. Run `npx tsc --noEmit`. Expected exit code: 0.
  - Source: `src/interfaces/cli/agentctl-core.ts` lines 22-37, 132, 204-207, 280-282, 497, 602, read on 2026-11-13.

- [x] **G21.8 Wire `watch` into the production binary.**
  - proof: `node --test src/composition/observe-cli.test.ts` pass 1, fail 0 (with `src/interfaces/terminal/watch.test.ts`: 7 pass, 0 fail); the real run from an empty temporary directory printed a frame with `TASKS (0)` and `ls -A` printed nothing; `npx tsc --noEmit` exit 0. The binary reads run rows from the repository's `bench/results/local`, not from the working directory. After review the assistant changed `watch.ts` to write the cursor hide and show codes only in interactive mode, so piped output holds no control codes; the matching test was updated. Only the three listed files changed for this item (plus that fix in G21.6's files), 2026-11-19, Sonnet 5.5
  - tier: standard · high
  - gate: notify
  - after: G21.3, G21.4, G21.6, G21.7
  - files: `src/composition/observe-cli.ts` (new), `src/bin/agentctl.ts` (exists), `src/composition/observe-cli.test.ts` (new)
  - do:
    1. In `src/composition/observe-cli.ts`, export `createObservabilityComposition(options)` with `repositoryRoot` and an optional `stateDirectory`. The default state directory is `resolve(process.cwd(), '.agentctl')`.
    2. Build the services with `JsonlObservedTaskReader(join(stateDirectory, 'events'))`, `FileBenchmarkRunReader(join(repositoryRoot, 'bench', 'results', 'local'))`, `new SystemResourceSampler()`, and a clock `{ now: () => new Date().toISOString() }`.
    3. In `src/bin/agentctl.ts`, after `const parsed = parseCliArgs(argv);`, add a branch for `parsed.ok && parsed.command.kind === 'watch'`.
    4. In that branch, create an `AbortController` and abort it on `SIGINT`.
    5. Call `runWatch` with `interactive: process.stdout.isTTY === true && !command.once`, `intervalMs: command.intervalSeconds * 1000`, and `once: command.once`.
    6. Render with width `Math.max(60, process.stdout.columns ?? 80)` and color true only when `command.color` is true, `NO_COLOR` is unset, and `process.stdout.isTTY === true`.
    7. Write with `process.stdout.write`. Set `process.exitCode = 0` and return. Keep the existing path for every other command.
    8. In `src/composition/observe-cli.test.ts`, build the composition on an empty temporary directory. Assert `getSnapshot()` returns no tasks and no runs. Assert the temporary directory is still empty.
  - Anchor: `src/bin/agentctl.ts` contains `const parsed = parseCliArgs(argv);`.
  - Do not touch: `src/composition/local-cli.ts`, `src/composition/benchmark-cli.ts`.
  - check: run `node --test src/composition/observe-cli.test.ts`. Expected: `fail 0`. Run `d=$(mktemp -d) && (cd "$d" && node "$OLDPWD/src/bin/agentctl.ts" watch --once --no-color) && ls -A "$d"`. Expected: a frame that contains `TASKS (0)`, then an empty directory listing.
  - Files: `src/composition/observe-cli.ts` (new), `src/bin/agentctl.ts` (exists), `src/composition/observe-cli.test.ts` (new)
  - Verify: run `node --test src/composition/observe-cli.test.ts`. Expected: `fail 0`. Run `d=$(mktemp -d) && (cd "$d" && node "$OLDPWD/src/bin/agentctl.ts" watch --once --no-color) && ls -A "$d"`. Expected: a frame that contains `TASKS (0)`, then an empty directory listing.
  - Source: `src/bin/agentctl.ts` lines 14-17 and 20-48, read on 2026-11-13.

- [x] **G21.9 Register the command in the operations and threat-model documents.**
  - proof: `grep -c "agentctl watch" docs/operations.md docs/threat-model.md` printed 2 and 1; `grep -c "future dashboard" docs/threat-model.md` printed 0; no `dashboard` word is left in either file; only the two listed files changed for this item, 2026-11-19, Haiku 5.5
  - tier: light · low
  - gate: auto
  - after: G21.8
  - files: `docs/operations.md` (exists), `docs/threat-model.md` (exists)
  - do:
    1. In `docs/operations.md`, add a table row after the `Check the local runtime` row: ``| Watch tasks, runs and resources | `agentctl watch [--once] [--interval <seconds>] [--no-color]` | ``.
    2. In `docs/operations.md`, replace the bullet that starts `- The dashboard, when it exists` with: `- The terminal view (agentctl watch) is read-only. It reads event files and result files without locks, never repairs or writes them, and cannot create, approve, run, cancel or recover a task.`
    3. In `docs/threat-model.md`, replace `the future dashboard is read-only.` with `agentctl watch is read-only and uses a lock-free reader that never writes.`
  - Anchor: `docs/operations.md` contains `| Check the local runtime | `agentctl runtime diagnose` |`. `docs/threat-model.md` contains `the future dashboard is read-only.`
  - Do not touch: `AGENTS.md`.
  - check: run `grep -c "agentctl watch" docs/operations.md docs/threat-model.md`. Expected: a count of at least 1 for each file. Run `grep -c "future dashboard" docs/threat-model.md`. Expected output: `0`.
  - Files: `docs/operations.md` (exists), `docs/threat-model.md` (exists)
  - Verify: run `grep -c "agentctl watch" docs/operations.md docs/threat-model.md`. Expected: a count of at least 1 for each file. Run `grep -c "future dashboard" docs/threat-model.md`. Expected output: `0`.

- [x] **G21.10 Measure the cost of the viewer.**
  - proof: `node dev/scripts/watch-overhead.mjs` exit 0 (run by the assistant after the executor's own run): `mean_wall_ms` 268, `vram_before_mib` 1335, `vram_after_mib` 1327, `vram_delta_mib` -8 (limits 1500 ms and 8 MiB). The VRAM figure moves with the Ollama model on this PC; the viewer starts one `nvidia-smi` process per frame and uses no GPU memory itself. Only `dev/scripts/watch-overhead.mjs` was created, 2026-11-19, Sonnet 5.5
  - tier: standard · medium
  - gate: notify
  - after: G21.8
  - files: `dev/scripts/watch-overhead.mjs` (new)
  - do:
    1. Create `dev/scripts/watch-overhead.mjs`. It reads `nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits` and stores the value as `before`.
    2. Run `node src/bin/agentctl.ts watch --once --no-color` ten times in sequence with `spawnSync`. Record each wall time.
    3. Read `nvidia-smi` again and store the value as `after`.
    4. Print `mean_wall_ms`, `vram_before_mib`, `vram_after_mib`, and `vram_delta_mib`.
    5. Exit with code 1 when `mean_wall_ms` is above 1500 or when `vram_delta_mib` is above 8.
    6. Print the line `no nvidia-smi: vram check skipped` and skip the VRAM limit when `nvidia-smi` is missing.
  - Anchor: `dev/scripts/` exists and holds `g20-run.ts`.
  - Do not touch: `src/`.
  - check: run `node dev/scripts/watch-overhead.mjs`. Expected: exit code 0 and a printed `vram_delta_mib` of 8 or less.
  - Files: `dev/scripts/watch-overhead.mjs` (new)
  - Verify: run `node dev/scripts/watch-overhead.mjs`. Expected: exit code 0 and a printed `vram_delta_mib` of 8 or less.
  - Source: owner concern about GPU use, chat 2026-11-13.

- [ ] **G21.11 Use the view during a real benchmark run (`manual`).**
  - tier: user
  - gate: ask
  - after: G21.10
  - files: none
  - do:
    1. Open a second terminal window in the project folder.
    2. Run `npm run agentctl -- watch` in the second window.
    3. Start any benchmark run in the first window.
    4. Look at the second window for one minute. Press Ctrl+C to leave.
    5. Tell the assistant which column, color, or order to change.
  - check: manual — the owner sees the run row appear within 4 seconds, sees the GPU, RAM, and CPU values change, and sees the cursor return after Ctrl+C.
  - Files: none
  - Verify: manual — the owner sees the run row appear within 4 seconds, sees the GPU, RAM, and CPU values change, and sees the cursor return after Ctrl+C.
