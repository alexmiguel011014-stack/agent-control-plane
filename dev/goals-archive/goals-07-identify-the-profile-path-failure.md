## GOALS 7 — Identify the profile path failure

Grounded against commit `4438128` and the current uncommitted workspace on 2026-10-29. This goal precedes G6.13. The failed full probe recorded line 4357. The report's script and launcher hashes match the current files. That line calls `GetProfilePath` after `CreateProfile` returned. The exact failing operation inside `GetProfilePath` remains unknown. The API HRESULT is absent. The report does not establish whether the profile registration remains. The earlier human-readable report must be corrected.

### Stage map

| Stage | Items | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| Correct the evidence | G7.1 | Owner approval of this revised plan | None |
| Instrument path failures | G7.2 | Correct the evidence | None |
| Inspect the observed profile | G7.3 | Instrument path failures and independent review | None |
| Select a cause-specific plan | G7.4 | Inspect the observed profile | None |

```mermaid
flowchart LR
  A[Correct the evidence] --> B[Instrument path failures]
  B --> C[Inspect the observed profile]
  C --> D[Select a cause-specific plan]
  D --> E[Revised isolation acceptance plan]
```

<!-- item-contract: v1 -->

### Decisions

- Use the report and exact source hashes to establish the failed call. Do not infer the internal cause.
- Improve diagnostic visibility with fixed categories and synthetic checks. Preserve the existing failure and cleanup decisions.
- Query only the profile identified by the captured failed report. Do not enumerate unrelated profiles to select a target.
- Treat missing, denied, unstable, or contradictory evidence as `UNKNOWN`. Preserve profiles when cleanup is uncertain.
- Keep G6.13 and G2.2 open. Require G8 review and separate owner authorization before another live profile diagnostic.
- Do not execute candidates, patches, task tests, oracle modules, evaluator cases, or models during this goal.

- [x] **G7.1 Correct the human-readable failure record.**
  - Files: `runtime/diagnostics/appcontainer-probe-failure-20261029.md` (exists).
  - Anchor: `O relatório não permite determinar se a falha ocorreu ao criar o perfil ou ao resolver o caminho do perfil.`; `Não se deve concluir que a criação falhou, que o perfil foi criado por completo ou que houve resíduo no Registro.`
  - Change: Compare the report's `probe_script_sha256` and `launcher_sha256` with the two current files. Confirm `diagnostic.powershell_line` is 4357 and that line calls `GetProfilePath`. Confirm `CreateProfile` returned before that call. Replace the first anchored sentence with: `O script chegou à chamada GetProfilePath após CreateProfile retornar. A condição interna que falhou permanece desconhecida.` Replace the second anchored sentence with: `O retorno de CreateProfile é comprovado pelo fluxo e pela linha registrada. A permanência do registro e a causa interna de GetProfilePath não foram comprovadas.` Stop without changing the report if either hash or the line differs. Do not print or record a profile ID, SID, or private path.
  - Do not touch: The JSON report, Windows profiles, registry, ACLs, launcher, or probe behavior.
  - Verify: Confirm both hashes match, the corrected sentences occur once, and the old anchored sentence is absent. Confirm the Markdown report remains Git-ignored.
  - Source: Local failed-probe report and the hash-matched source files. The report is ignored runtime evidence.

  > Execution evidence: report script and launcher hashes matched the JSON. The recorded source line was 4357 and called `GetProfilePath`; `CreateProfile` had returned. Both report sentences were corrected exactly once, both old sentences were absent, and Git confirmed the report remained ignored. The internal path failure and registration state remain unknown.

- [x] **G7.2 Classify path failures and verify the diagnostic.**
  - Files: `bench/isolation/AppContainerLauncher.cs` (exists); `bench/isolation/run-probes.ps1` (exists); `bench/isolation/probe-contract.test.mjs` (exists).
  - Anchor: `private static string GetProfileLocalAppDataPath(string profileSid, string profileName)`; `public static string GetProfilePath(string profileSid, string profileName, string nonce)`; `function Set-Diagnostic([string]$Phase, $ErrorRecord, $ScriptLine) {`; `$profilePath = [AppContainerLauncher]::GetProfilePath($profileSidText, $profileName, $nonce)`; `test('read-only profile diagnostic is bounded, sanitized, and precedes probe effects', async () => {`.
  - Change: Set `$currentPhase` to `profile-path-resolve` immediately before the existing `GetProfilePath` call. Preserve `profile-create` for `CreateProfile`. Attach only fixed `profile_path_stage` values to exceptions at nonce validation, SID/name validation, API call, canonical path validation, suffix validation, and reparse validation. Use the values `NONCE`, `SID_NAME`, `API`, `CANONICAL`, `SUFFIX`, and `REPARSE`. Preserve the original exception, existing diagnostic fields, HRESULT metadata, checks, and cleanup decisions. Extend `Set-Diagnostic` to accept only those values from the exception chain. Record `UNKNOWN` for absent or unrecognized values. Do not add free-form exception metadata, messages, paths, IDs, SIDs, or registry data to output. Add synthetic fault injection at each of the six actual C# stages. Exercise the real stage wrappers and their propagation through PowerShell `Set-Diagnostic`. Include wrapped API HRESULTs and malformed metadata. Verify that the original exception is rethrown and malformed metadata cannot escape the allowlist. Assert that every production operation is enclosed by its assigned stage. Document the diagnostic fields in the existing probe contract test.
  - Do not touch: Actual profile creation/deletion, ACLs, worker execution, isolation policy, benchmark gates, or the existing report. Do not expose synthetic fault injection to worker inputs or operational probe options.
  - Verify: Run `npm run test:isolation-probe`, `npm run test:isolation-worker`, `npm run typecheck`, and `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bench/isolation/run-probes.ps1 -SelfTest`. Each exits 0. Synthetic checks create no profiles, access no live registry, open no listeners, and start no worker process. An independent reviewer reports no blockers.
  - Source: Local source and [GetAppContainerFolderPath](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-getappcontainerfolderpath), accessed 2026-10-29. The API returns an HRESULT and allocates the returned path.

  > Execution evidence: `test:isolation-probe` passed 18/18, `test:isolation-worker` passed 23/23, `typecheck` passed, PowerShell `-SelfTest` passed, and `git diff --check` passed. The independent reviewer confirmed the six production stages, exception/HRESULT preservation, allowlisted propagation, and synthetic tests for absent and malformed metadata. Lint reported the same 68 baseline warnings. No live profile, registry, worker, or full probe was run.

- [x] **G7.3 Inspect the profile identified by the failed report.**
  - Files: none (manual).
  - Verify: After owner approval of this revised plan and G7.2 review, use the existing bounded `-ProfileMappingReadOnlyDiagnosticOnly` mode once. Require SHA-256 `5532eabc0343a5173919a4d9c4c6999eb93c16fbc94170a36167131645d07f7e` for `runtime/diagnostics/appcontainer-probe-report.json` before reading `profile_id`. Obtain that ID only from this report in process memory. Pass it as `-ProfileMappingReadOnlyProfileId`; never print or persist it. Stop if the report hash or ID validation fails. The registry scan can visit other mappings and read their `DisplayName` and `Moniker` values. It is limited to four levels and 2,048 keys. Do not emit names or values. Record only sanitized API results, registry counts, candidate-path status, guard status, exit code, and unchanged report hash. Record guard `PASS` only if observational output follows the guard. Record `FULL_TRUST_REQUIRED` as `FAIL`. Record startup or diagnostic failure as `UNKNOWN`. The guard proves only a non-AppContainer token. Do not infer that other sandbox restrictions are absent. The check may read only registry metadata and path attributes. It must not create or delete profiles, write files or registry values, change ACLs, enumerate filesystem directories, launch a worker, or write a report. Treat incomplete or denied observations as `UNKNOWN`. Do not retry automatically or select another profile.

  > Execution evidence: the owner ran one full-trust PowerShell invocation after the current process failed the caller guard. It exited 1 with `status=UNKNOWN`; the guard passed because the API, registry, and candidate observations followed it. `GetAppContainerFolderPath` returned `0x80070002` (`-2147024894`) with no path. The registry scan was complete and stable across 273 keys, with zero complete, partial, case-only, missing, different, or malformed matches and issue `NONE`. The validated candidate path was `ABSENT`, with `exists=false`, `is_directory=false`, and `reparse_point=false`. The report hash stayed unchanged and the profile ID was not echoed. The API failure and absent mapping/path do not prove the original cause. This diagnostic item is complete; G2.2 remains blocked.

- [x] **G7.4 Select the next plan from the evidence.**
  - Files: none (manual).
  - Verify: Review G7.1–G7.3 with the owner. Separate observed profile state from the original exception's cause. Select a cause-specific fix plan if evidence proves the cause. Select a narrow diagnostic plan or stop if the cause remains unknown. Treat plan selection as preparation only. Do not create a profile. Keep G2.2 closed until full isolation and cleanup evidence passes.

  > Owner decision: on 2026-10-29, the owner selected preparation of a narrow fresh-profile diagnostic. This decision authorizes plan preparation only. It does not authorize a new profile, a worker, or the full probe.

