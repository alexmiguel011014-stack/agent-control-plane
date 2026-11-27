# AppContainer isolation probes

`run-probes.ps1` is a diagnostic probe for the manual G2.2 gate. A `PASS` means
the synthetic probes and cleanup completed on this host; it is not an evaluator
attestation and does not authorize benchmark patches or candidate tests. The
report always keeps `g2_2_attestation=false` and `gate_status=PENDING_OWNER_REVIEW`.

The full probe creates a temporary AppContainer profile and Job Object, then
stages the Node executable, fixed worker modules, and disposable workspace in
`<profilePath>\Temp\agentcp-run-<nonce>\{tools,workspace}`. Here `<profilePath>`
is the API-validated profile directory ending in `AC`, so the staging is under
the profile's `AC\Temp`. It exercises only these worker modes:

- filesystem read/write inside the staged workspace;
- read and create denial against nonce-scoped synthetic canaries in ignored
  `runtime/diagnostics`, the repository root, a child directory of
  `bench/oracles`, and the current user's `%LOCALAPPDATA%` root;
- a single TCP connection attempt to a host-controlled listener bound only to
  `127.0.0.1`;
- a synthetic child/grandchild process tree that the Job Object must terminate.

The canaries contain only fixed synthetic markers. The worker never opens a
registered oracle file, task fixture, patch, public test, or expected value. The
trusted host's full runner fingerprint does hash the registered runtime inputs,
including oracle JSON, as bytes because that is the exact contract used by
`readG2IsolationAttestation`; it does not parse, print, or execute those values.
No external network target is contacted. AppContainer still shares the Windows
kernel, and path checks cannot eliminate concurrent same-user filesystem races.

The full probe requires the new profile's `Temp` path to be an ordinary empty
directory before it creates the nonce-owned run tree. Runtime files and the
workspace stay in that subtree; repository, oracle, owner-profile, and runtime
canaries stay outside it. The host does not change ACLs on ancestors of this
profile-local staging tree. Cleanup removes and verifies the nonce tree before
the host attempts profile deletion; uncertainty preserves the profile. The
report records only path-validation and cleanup booleans/statuses, never these
absolute paths. This layout is a remediation hypothesis for the previous
`EPERM/lstat` on staging ancestors outside the profile. It does not prove that
Node ESM import will succeed or pass G2.2; the next full probe needs separate
owner authorization and must still demonstrate every gate behavior.

The filesystem, network, and process-tree workers use a fixed `--input-type=module
-e` bootstrap in `RunNodeWithModuleHooks`. The bootstrap imports only built-ins,
reads the staged `module-hook.mjs` bytes directly, imports those bytes through a
`data:` URL, and calls its exported `startModuleWorker`. It does not pass the
hook file as Node's local main module. The hook registers synchronous
`node:module.registerHooks()` before dynamically importing the selected worker.
The actual staged Node runtime fails closed if `registerHooks()` is unavailable.
The resolver delegates only recognized built-ins to Node's resolver. Probe mode permits only
`worker.mjs` and `probe-contract.mjs` from staging; production mode permits
only `production-worker.mjs`, `protocol.mjs`, and `task-operations.mjs`.
Candidate modules must be `.mjs` files under the host-validated workspace.
Relative dependencies such as the I04 error module and I05 startup/config
cycle resolve from their importing module within that workspace.

For every local module, the hook checks the trusted root and each descendant
with `lstat`, rejects reparse points and unexpected file types, reads source
directly with a 1 MiB limit, and returns it with `shortCircuit`. It never calls
Node's default resolver or loader for local files. Bare packages, absolute
path specifiers, UNC/device paths, out-of-root imports, and unlisted staging
modules are rejected. These checks avoid walking inaccessible ancestors above
the chosen root; AppContainer and the Job Object remain the OS isolation
boundary. The diagnostic and production root workers share the same hook. For
the process-tree probe, only the root worker loads that hook; descendants use
fixed built-in-only `node -e` child and grandchild scripts. They do not import
local modules or replay the module-hook bootstrap. The C# launcher quotes the
hook path and validates the fixed `probe` and `production` modes before creating
the root worker process.

The process-tree probe defaults to a 10-second Job timeout, within the
existing bounded parameter range, and uses an 8-second child/grandchild startup
window. Its report records only fixed
spawn/readiness statuses (including `child_spawn_status` and
`grandchild_spawn_status`), `readiness_stage`, and allowlisted error codes, so a
timeout can distinguish child creation from module-hook readiness. Numeric
child and grandchild PIDs are retained only to verify that both are absent
after the Job drains; when a PID was not observed, its absence is `null`
instead of a false claim.

The process-tree observation also records `deadline_active_processes` and
`deadline_query_error_code`. The count is sampled from Job accounting at the
deadline before the timeout decision or any required termination; on the
failing timeout path, the query is immediately before `TerminateJobObject`.
A count above one means multiple processes were active in the Job at that
sample, but it does not identify their roles or establish readiness. A count
of one does not rule out a child that exited before the sample, and zero is a
valid sample rather than proof of a particular termination outcome. When the
query fails, the count is `null` and the numeric query error is recorded; when
it succeeds, the query error is `null`. These fields contain no process IDs.

The hooked root worker also emits one-key JSON phase records with an
`agentcp_stage` enum around request dispatch, child spawn, readiness, and final
response. The host accepts at most 32 records from a fixed allowlist, stores
only those enum values, and parses the process-tree response separately. It
never copies worker output, paths, environment values, or PIDs into these phase
records. Missing dispatch or spawn-return markers narrow where the worker
stalled; they do not prove a process was created or terminated.

The local regression test runs the exact fixed child/grandchild scripts and
arguments with test roles that emit readiness and exit. It checks the readiness
schema, tracks both PIDs, and kills the process tree in `finally` if the bounded
test does not finish. This verifies those fixed descendant scripts only. It
does not prove hook loading in descendants, behavior of arbitrary candidate
subprocesses, AppContainer containment, or Windows Job Object behavior; the full
host probe remains necessary for those results.

The production launcher creates a fresh profile first, then stages Node and
the fixed modules under that profile's `AC\Temp`. It validates the selected
workspace with the host no-reparse walk and grants the worker `ReadAndExecute`
only. The original workspace DACL is captured before that temporary change and
restored and compared during cleanup. Staging is removed before the fresh
profile; any uncertain workspace DACL or stage cleanup prevents profile
deletion and leaves the run failed closed.

The report is written atomically to the ignored
`runtime/diagnostics/appcontainer-probe-report.json`. The earlier
`appcontainer-spike-report.json` remains untouched. `runner_sha256` is the
complete `getRuntimeFingerprint` digest expected by the evaluator. Separate
fields record the host baseline, Node version/hash, launcher, worker,
module-hook, and diagnostic-component fingerprint. Each worker Job Object has the configured
1 GiB committed-memory limit and eight-process limit; this is not a physical-RAM
ceiling.

Process completion uses the root process handle only to observe the root. The
launcher confirms the whole tree by polling Job Object ActiveProcesses until it
reaches zero; a Job handle signal is not treated as a drain barrier. On normal
completion it waits for the root, closes the root process and thread handles,
then polls ActiveProcesses. At the task deadline, or when the accounting query
fails, it terminates the Job, waits up to five seconds for the root, closes the
root handles, then polls ActiveProcesses at intervals of at most 25 ms for up
to five seconds. The report records root signaling, final ActiveProcesses,
query/poll errors, and a bounded diagnostic. Query failure or a nonzero count
at the drain bound leaves cleanup unconfirmed and fails closed. Polling can
exceed its nominal bound by scheduler latency; it does not use a completion
port as sole evidence. In `RunNodeCore`, each ActiveProcesses poll also drains
the redirected stdout and stderr pipes, using the existing 65,536-byte per-pipe
per-tick budget and 1 MiB combined capture limit, including after termination
and during fail-closed cleanup.

The suspended-startup diagnostic supplies both `PROC_THREAD_ATTRIBUTE_JOB_LIST`
and, for the AppContainer variant, `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`
in the same attribute list before `CreateProcess`. This places the process in
its Job at creation and avoids a suspended interval outside the Job. Its report
records whether the Job-list attribute was prepared separately from verified
Job membership. Attribute setup, process creation, or cleanup failure reports
`FAIL` without claiming cleanup was confirmed.

Before startup, the report also inventories only App SID ACEs for the fixed
labels `stageRoot`, `toolsRoot`, `workspaceRoot`, `stagedNode`, `workerModule`,
`probeContract`, and `moduleHook`. It records rights, allow/deny, and inherited/explicit
status without absolute paths or other principals. The minimum-ACE and module
Read/Traverse fields describe DACL entries only; they are not an effective
token-access check and do not change permissions. Missing or unreadable minimum
entries stop startup and remain visible in the report.

While the AppContainer process remains suspended, the diagnostic queries
whether `SeChangeNotifyPrivilege` is present and enabled without changing token
privileges. It performs separate `AccessCheck(FILE_TRAVERSE)` and
`AccessCheck(FILE_READ_ATTRIBUTES)` checks against the same host-read security
descriptor for each directory ancestor from the volume root through `runRoot`
(the profile `Temp` parent in the full probe), `stageRoot`, and `toolsRoot`,
using an impersonation duplicate of that exact process token. The report keeps
`status` for `FILE_TRAVERSE` and adds `read_attributes_status` for
`FILE_READ_ATTRIBUTES`; both contain only fixed labels and `ALLOW`, `DENY`, or
`UNKNOWN`. The last recorded suspended-token sample had
`SeChangeNotifyPrivilege` present and enabled. Since Windows can bypass normal
traverse checks when this privilege is enabled, the `FILE_TRAVERSE` result is
diagnostic context, not proof of actual path traversal. These observations do
not affect the gate result. Unsupported token, descriptor, or access-check
queries remain `UNKNOWN`.

The descriptor-based `AccessCheck` results do not reproduce the worker's actual
filesystem walk. The earlier unhooked Node `lstat` and `realpath` results are
historical evidence for the original loader failure. The shared module hook now
uses `lstat` only on each validated root and its descendants; the post-fix full
probe must still demonstrate successful module loading and path containment.

The same suspended-token diagnostic checks `FILE_READ_ATTRIBUTES` and
`FILE_READ_DATA` against host-read file descriptors for the exact staged
`worker.mjs` and `probe-contract.mjs`, reported only as `workerModule` and
`probeContract`. These file-object AccessCheck results are DACL/token
authorization calculations; they are not an end-to-end `CreateFile` or
`ReadFile` test and can become stale if a staged file changes after descriptor
capture. The results stay outside gate checks. Worker stderr also gets a
`stderr_target` enum only when its text contains exactly one current staged path
as a complete single- or double-quoted token (`worker.mjs`,
`probe-contract.mjs`, `module-hook.mjs`, or `node.exe`); prefixes, suffixes, missing quotes, and
ambiguous matches produce `unknown`. Raw stderr and paths are not added to that
observation.

The full probe also runs one compile-time CommonJS `node -e` negative control through
the existing AppContainer and Job launcher. Its 4 KiB JSON input has exactly
the canonical staged `worker.mjs` and `probe-contract.mjs` paths under the
current stage's `tools` directory. It uses `lstat` to require regular files,
then reads and discards at most 256 KiB per file in bounded chunks. Only when
both checks pass does it dynamically import the exact staged
`probe-contract.mjs`; it never imports `worker.mjs` or accepts a script/path
chosen by the request. A failed lstat/read skips the import. It also checks the
derived drive-root-to-`tools` ancestor chain with built-in `lstat` and `realpath`
calls only, capped at 32 entries; an invalid or deeper chain is reported as
`UNKNOWN`. Import failures expose only an allowlisted `syscall` and an exact
`error.path` match to `workerModule`, `probeContract`, or one of the fixed
`ancestor00`–`ancestor31` labels. Local drive paths and local file URLs are
normalized before equality matching; valid local extended drive paths such as
`\\?\C:\...` normalize to the drive path. UNC paths and non-drive device forms
such as `\\.\...` and `\\?\UNC\...`, along with relative, ambiguous, and
unmatched paths, remain unknown. No raw path, URL, message, or stack is emitted.
The diagnostic emits at most 4 KiB of fixed operation,
status, label, and allowlisted error-code JSON. The host validates that schema
and records it as a separate diagnostic observation, not gate evidence. The module
import is safe for this diagnostic because
`probe-contract.mjs` only imports `node:path`, defines constants/functions,
and has no top-level probe execution.
This negative control intentionally uses Node's default local ESM loader. Its
`EPERM/lstat` at `ancestor00` may recur and is reported separately; it is not
evidence that the `data:` bootstrap or registered hook ran, and it does not
replace the worker's post-fix result.

`-ProfileBootstrapDiagnosticOnly` is a separate, one-shot diagnostic for the
AppContainer profile creation/path bootstrap. Before `CreateProfile`, it checks
that the caller token is full-trust and derives a candidate under that caller's
canonical `LocalApplicationData\Packages\<generated profile id>\AC`; it rejects
the nested `Packages\sandbox.*\AC` caller path and any existing reparse point.
It does not create that path or change its ACL from the host. After profile
creation, it compares the returned SID with
`DeriveAppContainerSidFromAppContainerName` using `EqualSid`, then starts one
fixed inline Node script through the existing AppContainer and Job Object
launcher with the nonce-owned staged `tools` directory as its working directory;
it does not use the workspace as its current directory. The script checks only
the environment path shape, creates `Temp` and a nonce marker from inside the
worker, writes/reads/deletes that marker, and
leaves only an empty `Temp` directory for host verification. It accepts only a
bounded nonce JSON request and returns bounded status/error-code fields; it
does not import a module or run a candidate, task, patch, oracle, or evaluator.

To let the bootstrap-only diagnostic process start, the host temporarily grants
the App SID `Traverse` on its nonce-owned external `stageRoot` and
`ReadAndExecute` on `toolsRoot`, inherited by the staged files. This ACL setup
applies only to `-ProfileBootstrapDiagnosticOnly`; the full probe stages inside
the new profile's `Temp` and does not change ACLs on the repository or staging
ancestors. Before bootstrap launch it checks the expected allow ACEs on
`stageRoot`, `toolsRoot`, and staged `node.exe`; this is DACL inventory, not
effective token access. The bootstrap diagnostic's disposable staging tree is
removed during cleanup. ACL cleanup is `REMOVED_WITH_STAGE` only when that
nonce staging tree is confirmed absent; if removal cannot be confirmed, the
report records `NOT_CONFIRMED` and temporary-file cleanup fails closed.

After SID verification and before launching the worker, the host validates the
candidate and calls `GetAppContainerFolderPath` read-only. After the worker
exits, the host revalidates the same candidate and repeats the API observation
for the same SID and nonce. The report records `before_bootstrap` and
`after_bootstrap`, each with candidate-validation status, API-call status,
HRESULT, and candidate match. A failed candidate check records `NOT_CALLED`
with no HRESULT; an exception inside the launcher records `UNKNOWN` because it
does not establish whether the native API ran. The profile is preserved when
these observations cannot be made safely. There is no API-path precondition
for launching the bootstrap check. An API `FILE_NOT_FOUND` result is recorded
as an observation and does not block the bootstrap operation by itself. The report contains only the opaque generated
profile id and boolean/status fields, not absolute paths. Cleanup removes the
verified nonce marker, removes `Temp` only if this diagnostic created it and it
is empty, then deletes a newly created profile only when SID, launch, and cleanup
evidence are complete. Any uncertainty preserves the profile. This diagnostic
does not promote the G2.2 gate; its results remain outside gate checks.

Run this mode only after independent review and separate owner approval, because
it creates a temporary AppContainer profile and writes a nonce marker inside it:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\bench\isolation\run-probes.ps1 -ProfileBootstrapDiagnosticOnly
```

After this diagnostic code receives independent review and separate owner
approval, `-ProfileContractImportDiagnosticOnly` runs a one-shot profile-local
check. It copies only the already hash-verified `probe-contract.mjs` into
`<profilePath>\Temp\profile-contract-<nonce>\probe-contract.mjs`, verifies the
copy hash, then uses one fixed inline CommonJS script through the existing
AppContainer and Job Object launcher. That script checks the exact profile
module with bounded `lstat`, `realpath`, and hash-verified read operations before
importing only that module. It has no caller-selected script or path input. This
mode makes no ACL changes for the profile copy, creates no canaries, opens no
listener, and does not import or execute `worker.mjs`, a candidate, a task,
patch, oracle, or evaluator. It still performs the shared suspended-startup
diagnostics required by the existing launcher path. If the profile `Temp`
directory is absent, the mode creates it and records that fact. Cleanup removes
and verifies the nonce-scoped copy first, then removes only an empty `Temp`
directory created by this mode. If either cleanup step fails or cannot be
verified, it preserves the profile for inspection and reports cleanup as
`FAIL`/`UNKNOWN`; it does not delete the profile. Its observations remain outside gate checks, so
`g2_2_attestation` stays false and `gate_status` stays
`PENDING_OWNER_REVIEW`.

The target profile path comes from `GetAppContainerFolderPath` and is validated
as a local-drive path with the exact `Packages\<generated profile id>\AC`
suffix, with reparse-point checks. This deliberately does not compare the API
result with the caller's `LocalApplicationData`, which can refer to a different
profile in sandboxed or redirected environments. The report records only the
generated opaque `profile_id` and `profile_local_write_attempted` boolean; it
does not emit the profile path. A newly created profile is deleted after a
pre-write failure. Once a profile-local write is attempted, deletion requires
verified nonce-stage cleanup and, when Temp creation was attempted, verified
Temp cleanup; otherwise the profile is preserved for inspection.

Before deleting any newly created profile, the host performs a bounded,
read-only search under the HKCU AppContainer Mappings subtree and requires
exactly one complete mapping
whose `DisplayName` and `Moniker` exactly match the generated profile id. It
reads only those two value names and caps traversal at four levels and 2,048
keys. Child names are enumerated incrementally through a fixed-size native
buffer and stop at the remaining key budget plus one; enumeration errors and
concurrent changes produce `UNKNOWN`. A recursive name/value-change notification
and before/after root metadata checks classify the observation as stable. This is
an observed stable scan for this Windows layout, not a public registry schema
contract. After `DeleteAppContainerProfile`, a second complete scan must
find no matching or partial mapping, and the profile folder, Temp, and staging
tree must all be absent before `appcontainer_profile_cleanup` can pass. A single
complete mapping that remains is `FAIL`; partial/duplicate matches or an
incomplete, limited, or inaccessible scan are `UNKNOWN`. Reports include only
scan status, fixed issue codes, and counts; they omit registry key names and
values.

To inspect a previously preserved profile, pass the exact profile ID recovered
from its captured report. The ID must be `AgentCP` followed by 17 lowercase
hexadecimal characters. This mode never reads the current probe report because
later runs can overwrite it. It requires a full-trust PowerShell caller before
it calls `GetAppContainerFolderPath` or opens the HKCU mapping subtree. The
token check establishes only that the caller is not itself an AppContainer; it
does not prove the process is outside every managed sandbox restriction. The
diagnostic reports the API result, bounded `DisplayName`/`Moniker` match counts
(exact versus case-only for each field), and a separate candidate-path
observation derived from the full-trust caller's
`%LOCALAPPDATA%\Packages\<id>\AC`. It reads only attributes along that path
and its ancestors. It stops at the first absent, non-directory, reparse, or
inaccessible component; it never enumerates a directory or opens file content.
These independent observations do not establish a cause when they differ or an
observation is incomplete. The mode does not create or delete profiles, write
files or registry values, change ACLs, start a worker, or write a report.
Output omits the ID, SID, paths, registry names and values.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\bench\isolation\run-probes.ps1 -ProfileMappingReadOnlyDiagnosticOnly -ProfileMappingReadOnlyProfileId <exact-profile-id>
```

### Preserved-profile follow-up

On 2026-10-29, the bounded read-only check of the previously preserved profile
returned `0x80070002` from `GetAppContainerFolderPath`. Its registry scan was
complete and stable: one exact `DisplayName` match, one case-only `Moniker`
match, and no other matching or malformed pairs. The lexically validated
candidate directory was absent, with no reparse point observed. A separate
fresh-profile comparison had resolved the API path before and after the fixed
bootstrap worker.

These observations localize the discrepancy to the preserved profile state but
do not prove why its directory is absent or why the API returned
`ERROR_FILE_NOT_FOUND`. The owner chose to preserve that profile and continue
without changing bootstrap behavior. The old profile was not modified. The
full G2.2 probe must use a new profile and still requires separate owner
authorization; this follow-up does not pass G2.2.

### Fresh-profile path-resolution diagnostic

This is a new sample for a newly generated profile name. The first read-only
follow-up above recorded one exact `DisplayName` match and one case-only
`Moniker` match; the later owner-run bounded query recorded zero matches. Keep
those as separate observations from different runs. This diagnostic does not
reconcile them or establish the cause of the earlier path failure.

Run this mode only after independent review and separate owner authorization for
one invocation. It creates a nonce-named profile and a unique ignored report at
`runtime/diagnostics/appcontainer-profile-path-<run-id>.jsonl`. It reserves the
path with `FileMode.CreateNew` and `FileShare.None`, then keeps that stream open
while it appends compact JSON records. It never opens, reads, replaces, or
removes an occupied target. Each newline-terminated record contains the run ID,
schema version, sequence, diagnostic phase, and execution state. The records
exclude `report_persisted`, `report_write_status`, and
`last_persisted_sequence`; a record cannot confirm its own write. The report may
retain the generated name, SID, API/candidate paths, HRESULTs, and bounded
observations for review.

Stdout contains one sanitized JSON receipt with these fields: `status`, `phase`,
`report_write_attempted`, `report_write_status`, `report_persisted`,
`last_persisted_sequence`, `profile_create_attempted`, and `report_path`. The
receipt never prints the profile name, SID, absolute paths, exception text, or
registry values. `report_path` is null until this run reserves the stream; it
stays non-null if a later append fails. `report_persisted` becomes true only
after a complete newline-terminated record and `Flush(true)` succeed. If it is
false, the latest attempted record is unconfirmed: complete bytes may exist,
but the diagnostic result is unknown and the prior confirmed sequence remains
the last trusted record. If it is true, `last_persisted_sequence` identifies
the latest complete record, whose diagnostic phase and state match the receipt.
Treat incomplete tails, invalid records, sequence mismatches, or a missing
receipt as unknown. A persisted `CREATE_ATTEMPTED` record with
`profile_create_attempted=false` records intent only; a later record confirms
whether the profile-create callback returned or threw. If that later record is
not confirmed, treat the callback outcome as unknown. A failure in the one-time
parent or lexical path validation before `CreateNew` returns
`UNKNOWN/PREPARATION_FAILED`, with `report_write_attempted=false`,
`report_write_status=NOT_ATTEMPTED`, `report_persisted=false`,
`last_persisted_sequence=0`, `profile_create_attempted=false`, and
`report_path=null`. Full-trust and preparation failures do not call profile
creation.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\bench\isolation\run-probes.ps1 -ProfilePathResolveDiagnosticOnly
```

Only when `CreateProfileDiagnostic` returns `S_OK` does the mode inspect the
generated name. After the callback returns, the mode persists a journal snapshot
that records its result. With a valid SID, `GetProfilePath` runs immediately
after that snapshot, before another observation. A collision
(`HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)`), any non-`S_OK` result, or a
missing HRESULT stops without querying the API, registry, or candidate path.
If creation returns `S_OK` but SID conversion fails, the mode skips
`GetProfilePath` and deletion; it may make only the independent read-only API,
bounded registry, and candidate-path observations for the profile created by
that call.

Allowed observations are the profile-path API result, the current user's
AppContainer mapping scan (maximum depth 4 and 2,048 keys), candidate-path
attributes and API/candidate comparison, followed by cleanup checks. A
candidate may be `PRESENT` as an ordinary non-reparse directory or `ABSENT`
after its shape and existing ancestors are safely checked. Deletion is
attempted only with proven ownership, successful `GetProfilePath`, matching
SID/name and API/candidate path, a complete stable unique registration scan, a
successful independent API observation, and no diagnostic writes under the
candidate path. The script
never runs a worker or Job Object, creates staging, changes ACLs, creates
canaries, opens a listener, or runs task tests, oracles, the evaluator, or a
model.

Registration state (`PRESENT`, `ABSENT`, or `UNKNOWN`), candidate-path status,
and cleanup action are separate results. `NOT_ATTEMPTED` means the delete API
was not called; it does not prove that a profile remains or was removed. An
interruption, an unconfirmed journal append after profile creation, or an
uncertain cleanup result may leave the new profile or its registration behind.
Fail-stop behavior prevents later observations or deletion after a journal
write failure. Do not retry or remove a residual profile manually. A clean sample
shows only that this new run resolved and cleaned up successfully; it does not
explain the earlier failure or pass G2.2.

### Process-token chain diagnostic

This diagnostic observes the process running the diagnostic and up to eight
parent processes. Open an ordinary interactive Windows PowerShell 5.1 session
outside the managed Codex shell and set its current directory to the project
root. From that session, run:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\bench\isolation\run-probes.ps1 -ProcessTokenChainDiagnosticOnly
```

This starts a noninteractive PowerShell child. `processes[0]` is that
diagnostic child, not the already-open interactive parent. Do not assume their
tokens are equivalent. This is the same child-launch form intended for the
separate profile-path diagnostic, but that later invocation is a different
process and must pass its own guard. This sample does not establish the token
of the parent shell or of any earlier caller.

Stdout is one sanitized JSON object with exactly `schema_version` (`1`),
`status`, `stage`, `truncated`, and `processes`. `status` is `COMPLETE` only
when the sampled chain reaches its root and every observation succeeds;
otherwise it is `UNKNOWN`. `stage` is one of `PROCESS_SNAPSHOT`,
`PROCESS_ENUMERATION`, `ANCESTRY_LINK`, `PROCESS_OPEN`, `PROCESS_TIME`,
`TOKEN_OPEN`, `TOKEN_APPCONTAINER`, `TOKEN_SID`, `PACKAGE_IDENTITY`, or
`COMPLETE`. Each of at most nine `processes` rows contains only `depth` (0–8),
`link_status`, `token_is_appcontainer`, `appcontainer_sid_presence`, and
`package_identity`. Their fixed values are respectively `ROOT`, `VERIFIED`,
`TRUNCATED`, or `UNKNOWN`; `TRUE`, `FALSE`, or `UNKNOWN`; `PRESENT`, `ABSENT`,
or `UNKNOWN`; and `PRESENT`, `NO_PACKAGE`, or `UNKNOWN`. Process IDs, names,
paths, SIDs, package-family names, and raw errors are not emitted.

Toolhelp creates an operating-system snapshot whose allocation is not bounded by
the application cap. The diagnostic enumerates at most 4,097 entries and
retains at most 4,096 process-ID/parent-ID pairs. It opens inspected processes
with `PROCESS_QUERY_LIMITED_INFORMATION`, reads creation times with
`GetProcessTimes`, and requires each observed parent to have been created before
its child. Enumeration failure, duplicate IDs, a missing, inaccessible,
cyclic, reused, or inconsistent parent link, failed token/package observation,
or a chain extending past the eight-ancestor limit produces `UNKNOWN`.

#### Running and interpreting the sample

The first row, `processes[0]`, represents the diagnostic child process. The
sample characterizes the process used by this invocation, not its parent shell
or any earlier call.

Use only `processes[0].token_is_appcontainer` to classify whether the
diagnostic child's process token is AppContainer: `TRUE` or `UNKNOWN` blocks
profile operations. `FALSE` means only that this diagnostic child's process
token was not identified as AppContainer; it does not prove general full trust
or authorize a profile operation. The overall `status: UNKNOWN` may result
from an ancestor link even when the depth-zero token field is known, so it does
not invalidate that field for this one predicate. An overall `COMPLETE` result
does not prove the parent shell's token, general full trust, or the token of an
earlier invocation.

Profile creation, access, or deletion still requires its own gate and explicit
authorization. A `FALSE` result only makes a separately authorized next
diagnostic eligible for consideration; it neither proves the token of that
later child nor authorizes it. The profile-path diagnostic must pass its own
guard.

The diagnostic reads process tokens only. It does not inspect thread
impersonation tokens and does not establish general full trust. One current
sample cannot prove the ancestry or token state of an earlier call. It makes no
explicit writes to repository, profile, registry, report, or canary paths; this
is not a claim of zero filesystem activity. It does not create or inspect
profiles or registry entries, elevate, start a worker, open a listener, or
invoke a model.

PowerShell 5.1 `Add-Type` compiles source into an in-memory assembly by default.
This mode does not supply `-OutputAssembly`. The documentation does not
guarantee whether CodeDOM creates transient compiler temp files, so that behavior
is outside the diagnostic's explicit-write contract and was not measured. See
[Microsoft Add-Type documentation for PowerShell 5.1](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type?view=powershell-5.1),
accessed 2026-11-02.

Run this mode only after the separate owner approval for writing and importing
the temporary profile-local module:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\bench\isolation\run-probes.ps1 -ProfileContractImportDiagnosticOnly
```

Run after the implementation has been reviewed and the owner has authorized the
full probe, because it creates and removes temporary canaries in the four
locations above and starts a local TCP listener:

```powershell
npm run isolation:appcontainer:probe
```

To isolate Node startup and inherited JSON stdin/stdout before running the full
probe, use `-ProtocolSmokeOnly`:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\bench\isolation\run-probes.ps1 -ProtocolSmokeOnly
```

This mode creates the temporary staging area and AppContainer profile, then
runs a fixed inline script through `node.exe -e`. The script has no imports,
filesystem or path access, and accepts no caller-supplied code. It emits `BOOT`,
reads the bounded synthetic stdin stream to EOF, and emits `INPUT_OK:<bytes>`.
The host records exact marker booleans, the bounded byte count, process/job/token
flags, and stdout/stderr byte counts and hashes. It does not execute the staged
`stdio-smoke.mjs` diagnostic, create canaries, open the loopback listener, or
start child processes. Its report always remains `BLOCKED` with
`g2_2_attestation=false` and `gate_status=PENDING_OWNER_REVIEW` because this is a
transport diagnostic subset, not G2.2 evidence. The staged module-based smoke
remains available for a later diagnostic step if the inline result supports it.

The report records cleanup of every canary, the stage, the AppContainer profile,
and the loopback listener. Cleanup checks only remove nonce-owned files whose
contents match the generated markers. Unexpected entries or changed markers
cause fail-closed cleanup and remain for inspection.

`-PreflightOnly` performs path/ACL/copy checks and runs the trusted Node binary
only to get its version and compute the same runtime fingerprint; it creates no
AppContainer profile and does not start the diagnostic worker. It creates only
the nonce staging tree and removes it. `-SelfTest` uses synthetic values to
check request/status/cleanup decisions without creating files, profiles,
listeners, or workers:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\bench\isolation\run-probes.ps1 -SelfTest
```

The worker protocol caps JSON input at 65,536 UTF-8 bytes, and the launcher
limits combined worker output to 1 MiB. Only explicit `EACCES` or `EPERM` counts
as access denial; missing files, timeouts, refused connections, and malformed
responses remain unknown or fail the gate.

### G14.2 read-only token and loopback observations

Each launched worker's primary process token is queried with
`OpenProcessToken` and `GetTokenInformation` for `TokenIsAppContainer`,
`TokenAppContainerSid`, and `TokenCapabilities`. The AppContainer SID must
match the SID created for this run. Token-information buffers are capped at
65,536 bytes and capability groups at 256 entries. The report exposes only the
capability count, query status, and numeric error code; it does not include
capability names or SIDs. The count is descriptive evidence, not a security
decision. See Microsoft's [GetTokenInformation documentation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation)
and [TOKEN_INFORMATION_CLASS documentation](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class).

Before the network worker, the host launches this script in the fixed
`-LoopbackConfigChildOnly` mode in a private kill-on-close Job. The helper gets
only a bounded JSON line containing this run's SID on stdin (at most 256 UTF-8
bytes); the SID is absent from its command line and output. Its stdout is capped
at 4,096 bytes. `NetworkIsolationGetAppContainerConfig` is synchronous and has
no cancellation parameter, so the helper process has a 5,000 ms deadline. The
host parses the response only after confirming the root process signaled and
the Job drained. An uncertain termination or drain preserves the stage and
profile and stops the remaining worker success path.

The API result is traversed only when its count is at most 4,096 and within a
250 ms post-return budget. Each returned SID and the array are released with
`HeapFree(GetProcessHeap())`, following Microsoft's
[NetworkIsolationGetAppContainerConfig documentation](https://learn.microsoft.com/en-us/windows/win32/api/networkisolation/nf-networkisolation-networkisolationgetappcontainerconfig).
Overflow or an interrupted traversal yields `UNKNOWN`; process exit reclaims
any remaining helper-owned heap allocations. This API reports the configured
loopback-exemption list for debugging. It does not report the complete effective
network policy, and the probe never changes that configuration.

The host first validates the local listener with a connect and accept, each
bounded to 1,000 ms, then closes both control sockets before the AppContainer
attempt. A failed host control or unknown loopback observation skips only the
network worker and does not count as a denial. The report records policy,
host-control, and worker-transport evidence separately.

#### `network_denied` decision (G15.1)

Capability evidence comes from the verified worker primary token, not from the
worker's own claim. The launcher derives the capability SIDs for
`internetClient`, `internetClientServer`, and `privateNetworkClientServer` with
[DeriveCapabilitySidsFromName](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-derivecapabilitysidsfromname),
frees each returned SID and the array with `LocalFree`, and counts how many of
them appear in the token's capabilities. Microsoft documents that an
AppContainer without network capabilities cannot reach the network, and lists
the capability names in its
[AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
and
[capability declaration](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)
pages. Reports carry only the count and a status, never SIDs or capability names.

- **`FAIL`**: when the listener-accept result is recorded, the host listener
  accepted the worker connection or the worker observed `CONNECTED`/`ALLOWED`.
  Also `FAIL`: the policy preconditions listed under `PASS` (verified token and
  Job membership, successful capability query, valid helper output, loopback
  exemption `ABSENT`) hold and the verified token holds at least one matching
  network capability.
- **`PASS`**: all of the following hold. The worker ran, its token was verified
  as the requested AppContainer, and Job membership was verified. The capability
  query succeeded with a matching count of zero and no error code. The loopback
  helper output was valid and reported the loopback exemption as `ABSENT`. The
  host control connect and accept passed, the target matches the listener, and
  the worker transport was `COMPLETE`. The worker observation is then either an
  explicit `EACCES`/`EPERM` denial or `ETIMEDOUT`.
- **`UNKNOWN`**: anything else, including a missing listener-accept result, an
  unverified token or Job membership,
  a failed capability derivation or query, an invalid or uncertain loopback
  helper result, a loopback exemption that is `PRESENT` or unknown, a failed
  host control, a listener target mismatch, malformed or incomplete worker
  output, or a worker that was never attempted.

`ETIMEDOUT` alone is inconclusive: it counts toward `PASS` only when the
policy evidence above is complete, and never on its own. The loopback exemption
list reported by
[NetworkIsolationGetAppContainerConfig](https://learn.microsoft.com/en-us/windows/win32/api/networkisolation/nf-networkisolation-networkisolationgetappcontainerconfig)
is a debugging aid, so its absence alone does not prove effective network
denial, and its presence keeps the result `UNKNOWN`.

#### Process-tree stage fields (G15.2)

The launcher records a fixed stage before each launch and timeout step:
`PREFLIGHT`, `ARGUMENT_CONSTRUCTION`, `PROCESS_CREATE`, `TOKEN_VERIFICATION`,
`JOB_MEMBERSHIP`, `INPUT_WRITE`, `PROCESS_WAIT`, `TIMEOUT_QUERY`,
`JOB_SNAPSHOT`, `JOB_TERMINATION`, `ROOT_SIGNAL`, `JOB_DRAIN`,
`OUTPUT_CAPTURE`, and `CLEANUP`. A failure records the stage, an allowlisted
exception type, and a numeric HRESULT or Win32 code. It never records raw
process identifiers, paths, or exception messages. A failure in `JOB_SNAPSHOT`
sets member evidence to `UNKNOWN` and then continues Job termination, root
signal confirmation, and Job drain. Incomplete member evidence never reports
process-tree termination as complete. A recorded stage identifies where a failure
surfaced, not why it happened.

#### Process-tree readiness transport (G16)

In the AppContainer worker on the tested host, `child_process.spawn` blocked
whenever a stdio slot was `pipe` or `ipc`, with and without `windowsHide`. It
returned and the child ran with `ignore`, `inherit`, or an integer file
descriptor opened in the workspace. This is an observation on that host, not a
documented Windows rule. The AppContainer `child` and `grandchild` roles
therefore report readiness through files in the disposable workspace instead of
pipes:

- The worker creates `pt-child-ready.jsonl` with exclusive-create and passes its
  descriptor as the child's stdout. The child spawns the grandchild with all
  stdio set to `ignore`; the grandchild opens `pt-grandchild-ready.jsonl` itself
  with exclusive-create and writes one line. An existing file is refused.
- File names are fixed constants joined to the working directory. No request
  value selects a name or path.
- Readers poll, read only bytes appended after a tracked offset, and apply the
  same single-line framing, status values, and readiness codes as the worker
  pipe reader, and the same 2,048-byte line limit (the file reader does not count
  the trailing newline toward it). A process that exits without a line ends the wait early.
- The host harness roles `child-test` and `grandchild-test` still use pipes and
  run in the trusted host Node, outside an AppContainer. Each host test case runs
  in its own freshly created empty directory, removed afterwards.
- The files live only in the disposable workspace and are removed with it.
- The transport change does not alter the termination evidence: Job snapshot,
  termination, drain, and process-identifier absence are collected as before.

None of these read-only observations auto-passes G6.13; that gate still requires
the independent filesystem, network-denial, process-tree, and
oracle-inaccessibility evidence.
