param(
    [int]$FilesystemTimeoutMs = 7000,
    [int]$TreeTimeoutMs = 10000,
    [switch]$PreflightOnly,
    [switch]$ProtocolSmokeOnly,
    [switch]$ProfileContractImportDiagnosticOnly,
    [switch]$ProfileBootstrapDiagnosticOnly,
    [switch]$ProfilePathResolveDiagnosticOnly,
    [switch]$ProcessTokenChainDiagnosticOnly,
    [switch]$ProfileMappingReadOnlyDiagnosticOnly,
    [switch]$LoopbackConfigChildOnly,
    [string]$ProfileMappingReadOnlyProfileId,
    [switch]$ProcessTreeHostTestOnly,
    [string]$ProcessTreeHostTestInputBase64,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
if ($LoopbackConfigChildOnly -and $PSBoundParameters.Count -ne 1) {
    [Console]::Out.Write('{"schema_version":1,"loopback_exemption":"UNKNOWN","entry_count":null,"error_code":null,"cleanup_status":"UNKNOWN","cleanup_error_code":null}' + "`n")
    exit 1
}
if ($PSBoundParameters.ContainsKey('ProcessTreeHostTestInputBase64') -and -not $ProcessTreeHostTestOnly) {
    [Console]::Out.Write('{"schema_version":1,"status":"ERROR","reason":"MODE_REQUIRED"}' + "`n")
    exit 1
}
if ($ProcessTreeHostTestOnly -and
    ($PSBoundParameters.Count -ne 2 -or
        -not $PSBoundParameters.ContainsKey('ProcessTreeHostTestInputBase64') -or
        $PreflightOnly -or $ProtocolSmokeOnly -or $ProfileContractImportDiagnosticOnly -or
        $ProfileBootstrapDiagnosticOnly -or $ProfilePathResolveDiagnosticOnly -or
        $ProcessTokenChainDiagnosticOnly -or $ProfileMappingReadOnlyDiagnosticOnly -or $SelfTest)) {
    [Console]::Out.Write('{"schema_version":1,"status":"ERROR","reason":"MODE_CONFLICT"}' + "`n")
    exit 1
}
if ($PSBoundParameters.ContainsKey('ProfileMappingReadOnlyProfileId') -and
    -not $ProfileMappingReadOnlyDiagnosticOnly) {
    [Console]::Out.Write('{"status":"ERROR","reason":"MODE_REQUIRED"}' + "`n")
    exit 1
}
if ($ProfilePathResolveDiagnosticOnly -and
    ($PreflightOnly -or $ProtocolSmokeOnly -or $ProfileContractImportDiagnosticOnly -or
        $ProfileBootstrapDiagnosticOnly -or $ProcessTokenChainDiagnosticOnly -or
        $ProfileMappingReadOnlyDiagnosticOnly -or $SelfTest)) {
    [Console]::Out.Write('{"status":"ERROR","reason":"MODE_CONFLICT"}' + "`n")
    exit 1
}
if ($ProcessTokenChainDiagnosticOnly -and
    ($PreflightOnly -or $ProtocolSmokeOnly -or $ProfileContractImportDiagnosticOnly -or
        $ProfileBootstrapDiagnosticOnly -or $ProfilePathResolveDiagnosticOnly -or
        $ProfileMappingReadOnlyDiagnosticOnly -or $SelfTest -or
        $PSBoundParameters.ContainsKey('ProfileMappingReadOnlyProfileId'))) {
    [Console]::Out.Write('{"status":"ERROR","reason":"MODE_CONFLICT"}' + "`n")
    exit 1
}
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$launcherPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'AppContainerLauncher.cs'))
$workerSourcePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'worker.mjs'))
$probeContractSourcePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'probe-contract.mjs'))
$moduleHookSourcePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'module-hook.mjs'))
$stdioSmokeSourcePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'stdio-smoke.mjs'))
$scriptSourcePath = [System.IO.Path]::GetFullPath($PSCommandPath)
$diagnosticsRoot = Join-Path $repoRoot 'runtime\diagnostics'
$runRoot = Join-Path $diagnosticsRoot 'appcontainer-probe-runs'
$reportPath = Join-Path $diagnosticsRoot 'appcontainer-probe-report.json'
$nonce = [Guid]::NewGuid().ToString('N')
$profileContractDiagnosticMaxBytes = 262144
$profileBootstrapMarkerPrefix = 'AgentCPBootstrapMarker:'
$profileMappingRegistrySubKey = 'Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings'
$profileMappingMaxDepth = 4
$profileMappingMaxKeys = 2048
$profileRunStageInTemp = -not ($PreflightOnly -or $ProtocolSmokeOnly -or
    $ProfileContractImportDiagnosticOnly -or $ProfileBootstrapDiagnosticOnly -or
    $ProfilePathResolveDiagnosticOnly -or $ProcessTokenChainDiagnosticOnly)
$stageRootParent = if ($profileRunStageInTemp) { $null } else { $runRoot }
$stageRoot = if ($profileRunStageInTemp) { $null } else { Join-Path $runRoot $nonce }
$toolsRoot = if ($null -eq $stageRoot) { $null } else { Join-Path $stageRoot 'tools' }
$workspaceRoot = if ($null -eq $stageRoot) { $null } else { Join-Path $stageRoot 'workspace' }
$canaryCollectionRoot = Join-Path $diagnosticsRoot 'appcontainer-probe-canaries'
$canaryRoot = Join-Path $canaryCollectionRoot $nonce
$repositoryCanaryRoot = Join-Path $repoRoot ('.appcontainer-probe-' + $nonce)
$oracleCollectionRoot = Join-Path $repoRoot 'bench\oracles'
$oracleCanaryRoot = Join-Path $oracleCollectionRoot ('.appcontainer-probe-' + $nonce)
$ownerProfileCanaryCollectionRoot = if ($ProcessTokenChainDiagnosticOnly) { $null } else {
    [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
}
function Get-OwnerProfileCanaryRoot($CollectionRoot, [string]$Nonce) {
    if ($null -eq $CollectionRoot) { return $null }
    return Join-Path $CollectionRoot ('.appcontainer-probe-' + $Nonce)
}
$ownerProfileCanaryRoot = Get-OwnerProfileCanaryRoot $ownerProfileCanaryCollectionRoot $nonce
$canaryReadPath = Join-Path $canaryRoot 'read-canary.txt'
$canaryWritePath = Join-Path $canaryRoot 'write-canary.txt'
$profileName = 'AgentCP' + $nonce.Substring(0,17)
$stdioSmokeMarkerPath = if ($null -eq $workspaceRoot) { $null } else { Join-Path $workspaceRoot 'stdio-smoke-execution.marker' }
$stdioSmokeMarkerContent = 'appcontainer-stdio-smoke-execution-v1'
$stdioSmokePrimaryStatus = $null
$preserveStageForInspection = $false
$workerTempPath = $null
$stagedWorkerTempPath = if ($null -eq $workspaceRoot) { $null } else {
    Join-Path $workspaceRoot ('localappdata\Packages\' + $profileName + '\AC\Temp')
}
$profileCreated = $false
$profileCreateAttempted = $false
$stageCreated = $false
$canaryCreated = $false
$repositoryCanaryCreated = $false
$oracleCanaryCreated = $false
$ownerProfileCanaryCreated = $false
$probeListener = $null
$probeListenerCleanupConfirmed = $false
$canaryRecords = [ordered]@{}
$profileSid = $null
$profileSidText = $null
$profilePath = $null
$profileContractPaths = $null
$profileTempCanonical = $null
$profileTempCreatedByDiagnostic = $false
$profileTempCleanupVerified = $null
$profileTempCleanupStatus = if ($ProfileContractImportDiagnosticOnly) { 'NOT_STARTED' } else { 'NOT_RUN' }
$profileContractStageRoot = $null
$profileContractModulePath = $null
$profileContractStageCreated = $false
$profileContractStageCleanupVerified = $null
$profileRunStageCleanupVerified = $null
$profileRunStagePathValidated = $false
$profileRunTempExistedBefore = $null
$profileRunTempWasEmptyBefore = $null
$profileRunStageAbsentBefore = $null
$profileRunStageCreated = $false
$profileRunStagePreflightSafe = $false
$profileRunTempCleanupRequired = $false
$profileRunTempCreationAttempted = $false
$profileRunTempCreatedByDiagnostic = $false
$profileRunTempCleanupVerified = $null
$profileLocalWritesAttempted = $false
$profileTempCreationAttempted = $false
$profileTempExistedBeforeDiagnostic = $null
$profileContractHostStagingStatus = if ($ProfileContractImportDiagnosticOnly) { 'NOT_STARTED' } else { 'NOT_RUN' }
$profileContractSourceHashMatched = $null
$profileDeleteSucceeded = $false
$profileDeleteAttempted = $false
$profileRegistrationPreDeleteScan = $null
$profileRegistrationPostDeleteScan = $null
$profileRegistrationPreDeleteDecision = 'NOT_RUN'
$profileRegistrationPostDeleteDecision = 'NOT_RUN'
$profileRegistrationCleanupStatus = 'NOT_RUN'
$profileBootstrapCallerFullTrust = $null
$profileBootstrapOwnerLocalAppData = $null
$profileBootstrapCandidatePath = $null
$profileBootstrapCandidateValidated = $false
$profileBootstrapCandidateAbsentBefore = $null
$profileBootstrapSidMatchesName = $null
$profileBootstrapRun = $null
$profileBootstrapObservation = $null
$profileBootstrapApiPathObservation = $null
$profileBootstrapApiCandidateMatched = $null
$profileBootstrapApiHResult = $null
$profileBootstrapBeforeApiObservation = $null
$profileBootstrapExecutionAttempted = $false
$profileBootstrapCleanupVerified = $null
$profileBootstrapCleanupStatus = if ($ProfileBootstrapDiagnosticOnly) { 'NOT_STARTED' } else { 'NOT_RUN' }
$profileBootstrapStagingAclAttempted = $false
$profileBootstrapStagingAclObservation = $null
$profileBootstrapStagingAclCleanupStatus = 'NOT_APPLIED'
$profileBootstrapMarkerPath = $null
$profileBootstrapTempPath = $null
$profileBootstrapMarkerContent = $null
$profileBootstrapTempCreatedByDiagnostic = $false
$stageNode = $null
$fullProbeChecksComputed = $false
$nodeSource = $null
$stageWorker = $null
$stageProbeContract = $null
$stageModuleHook = $null
$stageStdioSmoke = $null
$runnerFingerprint = $null
$baselineSha256 = $null
$reportWriteTempCleanupStatus = 'NOT_STARTED'
$reportWriteTempCleanupFailure = $null
$reportWriteBackupCleanupStatus = 'NOT_STARTED'
$reportWriteBackupCleanupFailure = $null
$currentPhase = 'preflight'

$report = [ordered]@{
    schema_version = 1
    generated_by = 'bench/isolation/run-probes.ps1'
    generated_at = [DateTime]::UtcNow.ToString('o')
    status = 'BLOCKED'
    scope = 'dedicated-isolation-probe-only'
    g2_2_attestation = $false
    preflight_only = [bool]$PreflightOnly
    profile_contract_import_diagnostic_only = [bool]$ProfileContractImportDiagnosticOnly
    profile_bootstrap_diagnostic_only = [bool]$ProfileBootstrapDiagnosticOnly
    behavioral_execution_performed = $false
    benchmark_patch_executed = $false
    task_public_tests_executed = $false
    benchmark_oracle_executed = $false
    model_source_executed = $false
    platform = [Environment]::OSVersion.Platform.ToString()
    os_version = [Environment]::OSVersion.Version.ToString()
    powershell_version = $PSVersionTable.PSVersion.ToString()
    baseline_sha256 = $null
    runner_sha256 = $null
    probe_components_sha256 = $null
    launcher_sha256 = $null
    probe_script_sha256 = $null
    diagnostic_worker_sha256 = $null
    probe_contract_sha256 = $null
    module_hook_sha256 = $null
    stdio_smoke_sha256 = $null
    profile_cleanup_failure = $null
    profile_preexisted = $false
    profile_id = $profileName
    profile_local_write_attempted = [bool]$profileLocalWritesAttempted
    node_version = 'UNKNOWN'
    node_sha256 = $null
    appcontainer_capabilities_status = 'UNKNOWN'
    appcontainer_capability_count = $null
    appcontainer_capabilities_error_code = $null
    appcontainer_network_capability_count = $null
    job_memory_limit_bytes = 1073741824
    gate_status = 'PENDING_OWNER_REVIEW'
    checks = [ordered]@{
        appcontainer_profile = 'UNKNOWN'
        staging_acl = 'UNKNOWN'
        worker_appcontainer_token = 'UNKNOWN'
        worker_job_membership = 'UNKNOWN'
        workspace_read_write = 'UNKNOWN'
        filesystem_containment = 'UNKNOWN'
        repository_read_denied = 'UNKNOWN'
        repository_write_denied = 'UNKNOWN'
        runtime_canary_read_denied = 'UNKNOWN'
        runtime_canary_write_denied = 'UNKNOWN'
        process_environment_minimal = 'UNKNOWN'
        startup_attribute_control = 'UNKNOWN'
        startup_attribute_appcontainer = 'UNKNOWN'
        process_tree_terminated = 'UNKNOWN'
        child_process_tree_terminated = 'UNKNOWN'
        network_denied = 'UNKNOWN'
        profile_read_denied = 'UNKNOWN'
        profile_write_denied = 'UNKNOWN'
        oracle_inaccessible = 'UNKNOWN'
        appcontainer_profile_cleanup = 'UNKNOWN'
        temporary_files_cleanup = 'UNKNOWN'
    }
    observations = [ordered]@{
        profile_registration = [ordered]@{
            search_scope = 'HKCU_AppContainer_Mappings'
            pre_delete_scan = [ordered]@{
                status = 'NOT_RUN'; scan_complete = $false; keys_visited = 0
                complete_match_count = 0; partial_match_count = 0
                case_only_pair_count = 0; partial_missing_pair_count = 0; partial_different_pair_count = 0
                malformed_value_count = 0
                stability_status = 'NOT_RUN'; issue = 'NOT_RUN'
            }
            pre_delete_decision = 'NOT_RUN'
            post_delete_scan = [ordered]@{
                status = 'NOT_RUN'; scan_complete = $false; keys_visited = 0
                complete_match_count = 0; partial_match_count = 0
                case_only_pair_count = 0; partial_missing_pair_count = 0; partial_different_pair_count = 0
                malformed_value_count = 0
                stability_status = 'NOT_RUN'; issue = 'NOT_RUN'
            }
            post_delete_decision = 'NOT_RUN'
            cleanup_status = 'NOT_RUN'
        }
        profile_bootstrap_diagnostic = [ordered]@{
            attempted = [bool]$ProfileBootstrapDiagnosticOnly
            caller_full_trust = $null
            caller_local_appdata_safe = $null
            candidate_path_validated = $false
            candidate_absent_before_create = $null
            profile_sid_matches_name = $null
            staging_acl = [ordered]@{
                attempted = [bool]$ProfileBootstrapDiagnosticOnly
                status = if ($ProfileBootstrapDiagnosticOnly) { 'NOT_STARTED' } else { 'SKIPPED' }
                scope = @(
                    [ordered]@{ label = 'stageRoot'; rights = 'Traverse'; inheritance = 'none' },
                    [ordered]@{ label = 'toolsRoot'; rights = 'ReadAndExecute'; inheritance = 'staged_files' },
                    [ordered]@{ label = 'stagedNode'; rights = 'ReadAndExecute'; inheritance = 'inherited' }
                )
                labels = @()
                cleanup_status = if ($ProfileBootstrapDiagnosticOnly) { 'NOT_STARTED' } else { 'NOT_APPLIED' }
            }
            launch_status = if ($ProfileBootstrapDiagnosticOnly) { 'NOT_STARTED' } else { 'NOT_RUN' }
            response_status = if ($ProfileBootstrapDiagnosticOnly) { 'UNKNOWN' } else { 'SKIPPED' }
            operation_status = if ($ProfileBootstrapDiagnosticOnly) { 'UNKNOWN' } else { 'SKIPPED' }
            profile_path_shape = if ($ProfileBootstrapDiagnosticOnly) { 'UNKNOWN' } else { 'SKIPPED' }
            profile_path_checks = [ordered]@{
                local_drive_absolute = $null; local_no_stream = $null; local_canonical = $null; local_leaf_is_ac = $null
                parent_matches_nonce_name = $null; parent_matches_nonce_name_ordinal_ignore_case = $null
                grandparent_is_packages = $null
                temp_matches_local_child = $null; tmp_matches_local_child = $null
            }
            api_hresult = $null
            api_candidate_matched = $null
            before_bootstrap = [ordered]@{ candidate_validation = 'NOT_RUN'; api_call = 'NOT_CALLED'; api_hresult = $null; candidate_matched = $null }
            after_bootstrap = [ordered]@{ candidate_validation = 'NOT_RUN'; api_call = 'NOT_CALLED'; api_hresult = $null; candidate_matched = $null }
            temp_existed_before = $null
            temp_create_status = if ($ProfileBootstrapDiagnosticOnly) { 'NOT_RUN' } else { 'SKIPPED' }
            temp_created_by_diagnostic = $false
            marker_created_by_diagnostic = $false
            marker_write_status = if ($ProfileBootstrapDiagnosticOnly) { 'NOT_RUN' } else { 'SKIPPED' }
            marker_read_status = if ($ProfileBootstrapDiagnosticOnly) { 'NOT_RUN' } else { 'SKIPPED' }
            marker_delete_status = if ($ProfileBootstrapDiagnosticOnly) { 'NOT_RUN' } else { 'SKIPPED' }
            marker_absent = $null
            cleanup_status = if ($ProfileBootstrapDiagnosticOnly) { 'NOT_STARTED' } else { 'NOT_RUN' }
        }
        profile_contract_import_diagnostic = [ordered]@{
            attempted = [bool]$ProfileContractImportDiagnosticOnly
            host_staging_status = if ($ProfileContractImportDiagnosticOnly) { 'NOT_STARTED' } else { 'NOT_RUN' }
            source_hash_matched = $null
            response_status = if ($ProfileContractImportDiagnosticOnly) { 'UNKNOWN' } else { 'SKIPPED' }
            label = 'profileContractTemp'
            lstat = [ordered]@{ status = if ($ProfileContractImportDiagnosticOnly) { 'UNKNOWN' } else { 'SKIPPED' }; error_code = if ($ProfileContractImportDiagnosticOnly) { $null } else { 'NOT_RUN' } }
            realpath = [ordered]@{ status = if ($ProfileContractImportDiagnosticOnly) { 'UNKNOWN' } else { 'SKIPPED' }; error_code = if ($ProfileContractImportDiagnosticOnly) { $null } else { 'NOT_RUN' } }
            read = [ordered]@{ status = if ($ProfileContractImportDiagnosticOnly) { 'UNKNOWN' } else { 'SKIPPED' }; error_code = if ($ProfileContractImportDiagnosticOnly) { $null } else { 'NOT_RUN' } }
            import = [ordered]@{ status = if ($ProfileContractImportDiagnosticOnly) { 'UNKNOWN' } else { 'SKIPPED' }; error_code = if ($ProfileContractImportDiagnosticOnly) { $null } else { 'NOT_RUN' }; syscall = $null; path_label = $null }
            cleanup_status = if ($ProfileContractImportDiagnosticOnly) { 'NOT_STARTED' } else { 'NOT_RUN' }
            profile_temp_creation_attempted = [bool]$profileTempCreationAttempted
            profile_temp_existed_before_diagnostic = $profileTempExistedBeforeDiagnostic
            profile_temp_created_by_diagnostic = [bool]$profileTempCreatedByDiagnostic
            profile_temp_cleanup_status = $profileTempCleanupStatus
        }
        profile_run_stage = [ordered]@{
            attempted = [bool]$profileRunStageInTemp
            profile_temp_path_validated = $false
            profile_temp_existed_before = $null
            profile_temp_was_empty_before = $null
            profile_temp_creation_attempted = $false
            profile_temp_created_by_diagnostic = $false
            nonce_stage_absent_before = $null
            stage_created = $false
            stage_cleanup_status = if ($profileRunStageInTemp) { 'NOT_STARTED' } else { 'NOT_RUN' }
            stage_absent_after_cleanup = $null
            profile_temp_cleanup_status = 'NOT_RUN'
        }
    }
    failure = $null
    diagnostic = [ordered]@{
        phase = $null
        powershell_line = $null
        command_name = $null
        fully_qualified_error_id = $null
        exception_type = $null
        hresult = $null
        api_hresult = $null
        api_operation = $null
        api_native_error_code = $null
        profile_path_stage = 'UNKNOWN'
        inner_exception_type = $null
        inner_hresult = $null
    }
    limitations = @(
        'This probe report is not the G2.2 evaluator attestation; owner review and a separately reviewed evidence record remain required.',
        'Only synthetic nonce-scoped canaries are used. No candidate, patch, benchmark case, public test, oracle module, or expected value is loaded or executed.',
        'Oracle containment is tested with a synthetic canary under bench/oracles; no registered oracle file is opened by the worker.',
        'Profile-only contract import diagnostics remain outside gate evidence; their nonce-scoped module copy is removed before profile deletion.',
        'The trusted host runtime fingerprint hashes registered oracle JSON bytes only; it does not parse, expose, or send those values to the worker.',
        'Network denial is tested only against a temporary host-controlled listener bound to 127.0.0.1; no external network target is used.',
        'The report binds runner_sha256 to the complete getRuntimeFingerprint result and records the baseline, Node binary, launcher, and diagnostic worker fingerprints.',
        'The diagnostic launcher bounds JSON input at 65,536 UTF-8 bytes and combined worker output at 1,048,576 bytes; its stdin writer is monitored against the task timeout.',
        'Generated paths are checked for containment and reparse points before use; path-based checks do not prevent concurrent same-user filesystem races.',
        'AppContainer shares the Windows kernel and may read immutable system resources required by Node; this probe does not claim a closed filesystem namespace.'
    )
}

function Set-Check([string]$Name, [string]$Value) {
    $report.checks[$Name] = $Value
}

function Convert-SuspendedStartupObservation($Attempt) {
    return [ordered]@{
        attempted = [bool]$Attempt.Attempted
        process_created = [bool]$Attempt.ProcessCreated
        job_list_attribute_attempted = [bool]$Attempt.JobListAttributeAttempted
        job_list_attribute_succeeded = [bool]$Attempt.JobListAttributeSucceeded
        job_membership_verified = [bool]$Attempt.JobMembershipVerified
        appcontainer_token_verified = [bool]$Attempt.AppContainerTokenVerified
        terminate_job_succeeded = [bool]$Attempt.TerminateJobSucceeded
        terminate_process_succeeded = [bool]$Attempt.TerminateProcessSucceeded
        root_process_signaled = [bool]$Attempt.RootProcessSignaled
        job_drained = [bool]$Attempt.JobDrained
        active_processes_after_drain = $Attempt.ActiveProcessesAfterDrain
        active_process_query_error_code = [int]$Attempt.ActiveProcessQueryErrorCode
        drain_poll_wait_code = [int]$Attempt.DrainPollWaitCode
        drain_diagnostic = [string]$Attempt.DrainDiagnostic
        fallback_used = [bool]$Attempt.FallbackUsed
        fallback_root_process_signaled = [bool]$Attempt.FallbackRootProcessSignaled
        final_root_process_signaled = [bool]$Attempt.FinalRootProcessSignaled
        job_closed_for_fallback = [bool]$Attempt.JobClosedForFallback
        cleanup_confirmed = [bool]$Attempt.CleanupConfirmed
        cleanup_status = [string]$Attempt.CleanupStatus
        passed = [bool]$Attempt.Passed
        codes = [ordered]@{
            setup = [int]$Attempt.SetupErrorCode
            create = [int]$Attempt.CreateErrorCode
            job_list_attribute = [int]$Attempt.JobListAttributeErrorCode
            membership = [int]$Attempt.MembershipErrorCode
            token = [int]$Attempt.TokenErrorCode
            terminate_job = [int]$Attempt.TerminateJobErrorCode
            root_process_wait = [int]$Attempt.ProcessWaitCode
            active_process_query = [int]$Attempt.ActiveProcessQueryErrorCode
            drain_poll_wait = [int]$Attempt.DrainPollWaitCode
            retry_terminate = [int]$Attempt.RetryTerminateErrorCode
            retry_terminate_process = [int]$Attempt.RetryTerminateProcessErrorCode
            terminate_process = [int]$Attempt.TerminateProcessErrorCode
            fallback_root_process_wait = [int]$Attempt.FallbackProcessWaitCode
            final_root_process_wait = [int]$Attempt.FinalProcessWaitCode
            job_close = [int]$Attempt.JobCloseErrorCode
            resource_cleanup = [int]$Attempt.ResourceCleanupErrorCode
        }
    }
}

function Convert-AppContainerTokenDiagnostic($Attempt, [string[]]$ExpectedLabels) {
    $traverse = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Attempt.DirectoryTraverseDiagnostics)) {
        $label = [string]$entry.Label
        if ($label -notmatch '^(volume_root|runRoot|stageRoot|toolsRoot|ancestor_[0-9]{3})$') {
            continue
        }
        $status = [string]$entry.Status
        if ($status -notin @('ALLOW', 'DENY', 'UNKNOWN')) { $status = 'UNKNOWN' }
        $readAttributesStatus = [string]$entry.ReadAttributesStatus
        if ($readAttributesStatus -notin @('ALLOW', 'DENY', 'UNKNOWN')) { $readAttributesStatus = 'UNKNOWN' }
        if ($seen.Add($label)) {
            $traverse.Add([ordered]@{
                label = $label
                status = $status
                read_attributes_status = $readAttributesStatus
            })
        } else {
            foreach ($existing in $traverse) {
                if ($existing.label -ceq $label) {
                    $existing.status = 'UNKNOWN'
                    $existing.read_attributes_status = 'UNKNOWN'
                    break
                }
            }
        }
    }
    foreach ($label in $ExpectedLabels) {
        if ($label -notmatch '^(volume_root|runRoot|stageRoot|toolsRoot|ancestor_[0-9]{3})$') {
            continue
        }
        if (-not $seen.Contains($label)) {
            $traverse.Add([ordered]@{
                label = $label
                status = 'UNKNOWN'
                read_attributes_status = 'UNKNOWN'
            })
        }
    }
    return [ordered]@{
        token_verified = [bool]$Attempt.AppContainerTokenVerified
        se_change_notify_privilege_query_succeeded = [bool]$Attempt.SeChangeNotifyPrivilegeQuerySucceeded
        se_change_notify_privilege_present = $Attempt.SeChangeNotifyPrivilegePresent
        se_change_notify_privilege_enabled = $Attempt.SeChangeNotifyPrivilegeEnabled
        directory_traverse_method = 'AccessCheck(FILE_TRAVERSE) using an impersonation duplicate of the suspended AppContainer token.'
        directory_read_attributes_method = 'AccessCheck(FILE_READ_ATTRIBUTES) using the same suspended AppContainer token and directory security descriptors.'
        directory_ancestors = @($traverse.ToArray())
    }
}

function Convert-StagedFileReadDiagnostic($Attempt, [string[]]$ExpectedLabels) {
    $files = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Attempt.StagedFileReadDiagnostics)) {
        $label = [string]$entry.Label
        if ($label -notin @('workerModule', 'probeContract')) { continue }
        $attributesStatus = [string]$entry.ReadAttributesStatus
        $dataStatus = [string]$entry.ReadDataStatus
        if ($attributesStatus -notin @('ALLOW', 'DENY', 'UNKNOWN')) { $attributesStatus = 'UNKNOWN' }
        if ($dataStatus -notin @('ALLOW', 'DENY', 'UNKNOWN')) { $dataStatus = 'UNKNOWN' }
        if ($seen.Add($label)) {
            $files.Add([ordered]@{
                label = $label
                read_attributes = $attributesStatus
                read_data = $dataStatus
            })
        }
    }
    foreach ($label in $ExpectedLabels) {
        if ($label -notin @('workerModule', 'probeContract')) { continue }
        if (-not $seen.Contains($label)) {
            $files.Add([ordered]@{ label = $label; read_attributes = 'UNKNOWN'; read_data = 'UNKNOWN' })
        }
    }
    return [ordered]@{
        token_verified = [bool]$Attempt.AppContainerTokenVerified
        method = 'AccessCheck(FILE_READ_ATTRIBUTES, FILE_READ_DATA) on host-read file descriptors using an impersonation duplicate of the suspended AppContainer token.'
        files = @($files.ToArray())
    }
}

function Test-StagedReadDiagnosticOperation($Value, [string]$ExpectedOperation) {
    if (-not (Test-ExactObjectKeys $Value @('operation', 'status', 'error_code')) -or
        [string]$Value.operation -cne $ExpectedOperation -or
        [string]$Value.status -notin @('PASS', 'DENIED', 'FAIL', 'SKIPPED')) { return $false }
    $codes = @('EACCES', 'EPERM', 'ENOENT', 'EBADF', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EMFILE', 'ENFILE',
        'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_UNSUPPORTED_DIR_IMPORT', 'NOT_RUN',
        'NOT_REGULAR', 'NOT_DIRECTORY', 'SYMLINK', 'TOO_LARGE', 'FILE_CHANGED', 'INCOMPLETE', 'INVALID_PATH',
        'PATH_MISMATCH', 'CHAIN_TOO_DEEP', 'LIMIT_EXCEEDED', 'INVALID_REQUEST', 'EXPORT_SHAPE', 'UNKNOWN')
    if ($null -ne $Value.error_code -and [string]$Value.error_code -notin $codes) { return $false }
    if ($Value.status -ceq 'PASS' -and $null -ne $Value.error_code) { return $false }
    if ($Value.status -ceq 'DENIED' -and [string]$Value.error_code -notin @('EACCES', 'EPERM')) { return $false }
    if ($Value.status -ceq 'SKIPPED' -and [string]$Value.error_code -notin @('NOT_RUN', 'INVALID_REQUEST', 'LIMIT_EXCEEDED')) { return $false }
    if ($Value.status -in @('DENIED', 'FAIL') -and $null -eq $Value.error_code) { return $false }
    return $true
}

function Test-StagedAncestorOperation($Value, [string]$ExpectedOperation) {
    if ($Value -isnot [System.Array] -or $Value.Count -ne 3 -or
        [string]$Value[0] -cne $ExpectedOperation -or
        [string]$Value[1] -notin @('PASS', 'DENIED', 'FAIL')) { return $false }
    $codes = @('EACCES', 'EPERM', 'ENOENT', 'EBADF', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EMFILE', 'ENFILE',
        'NOT_DIRECTORY', 'SYMLINK', 'PATH_MISMATCH', 'UNKNOWN')
    if ($null -ne $Value[2] -and [string]$Value[2] -notin $codes) { return $false }
    if ($Value[1] -ceq 'PASS' -and $null -ne $Value[2]) { return $false }
    if ($Value[1] -ceq 'DENIED' -and [string]$Value[2] -notin @('EACCES', 'EPERM')) { return $false }
    if ($Value[1] -in @('DENIED', 'FAIL') -and $null -eq $Value[2]) { return $false }
    return $true
}

function Test-StagedAncestorChainOperation($Value) {
    if (-not (Test-ExactObjectKeys $Value @('operation', 'status', 'error_code')) -or
        [string]$Value.operation -cne 'ancestor_chain' -or
        [string]$Value.status -notin @('PASS', 'UNKNOWN', 'SKIPPED')) { return $false }
    if ($Value.status -ceq 'PASS') { return $null -eq $Value.error_code }
    if ($Value.status -ceq 'UNKNOWN') { return [string]$Value.error_code -in @('INVALID_PATH', 'CHAIN_TOO_DEEP') }
    return [string]$Value.error_code -in @('NOT_RUN', 'INVALID_REQUEST', 'LIMIT_EXCEEDED')
}

function Test-StagedImportDiagnostic($Value) {
    if (-not (Test-ExactObjectKeys $Value @('operation', 'status', 'error_code', 'syscall', 'path_label')) -or
        [string]$Value.operation -cne 'import' -or
        [string]$Value.status -notin @('PASS', 'DENIED', 'FAIL', 'SKIPPED')) { return $false }
    $codes = @('EACCES', 'EPERM', 'ENOENT', 'EBADF', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EMFILE', 'ENFILE',
        'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_UNSUPPORTED_DIR_IMPORT', 'NOT_RUN',
        'EXPORT_SHAPE', 'UNKNOWN')
    $syscalls = @('access', 'lstat', 'open', 'read', 'readlink', 'realpath', 'stat')
    if ($null -ne $Value.error_code -and [string]$Value.error_code -notin $codes) { return $false }
    if ($null -ne $Value.syscall -and [string]$Value.syscall -notin $syscalls) { return $false }
    if ($null -ne $Value.path_label -and
        [string]$Value.path_label -notin @('workerModule', 'probeContract') -and
        [string]$Value.path_label -cnotmatch '^ancestor(?:0[0-9]|[12][0-9]|3[01])$') { return $false }
    if ($Value.status -ceq 'PASS') {
        return $null -eq $Value.error_code -and $null -eq $Value.syscall -and $null -eq $Value.path_label
    }
    if ($Value.status -ceq 'SKIPPED') {
        return [string]$Value.error_code -in @('NOT_RUN', 'INVALID_REQUEST', 'LIMIT_EXCEEDED') -and
            $null -eq $Value.syscall -and $null -eq $Value.path_label
    }
    if ($Value.status -ceq 'DENIED' -and [string]$Value.error_code -notin @('EACCES', 'EPERM')) { return $false }
    return $null -ne $Value.error_code
}

function Convert-StagedNodeReadDiagnosticObservation($Run) {
    $defaultFiles = @(
        [ordered]@{ label = 'workerModule'; lstat = [ordered]@{ status = 'UNKNOWN'; error_code = $null }; read = [ordered]@{ status = 'UNKNOWN'; error_code = $null } },
        [ordered]@{ label = 'probeContract'; lstat = [ordered]@{ status = 'UNKNOWN'; error_code = $null }; read = [ordered]@{ status = 'UNKNOWN'; error_code = $null } }
    )
    $launcherAttempted = $null -ne $Run
    $stdout = if ($launcherAttempted) { [string]$Run.Stdout } else { '' }
    $observation = [ordered]@{
        launcher = [ordered]@{
            attempted = $launcherAttempted
            timed_out = if ($launcherAttempted) { [bool]$Run.TimedOut } else { $false }
            exit_code = if ($launcherAttempted) { [int]$Run.ExitCode } else { $null }
            output_truncated = if ($launcherAttempted) { [bool]$Run.OutputTruncated } else { $false }
            root_process_signaled = if ($launcherAttempted) { [bool]$Run.RootProcessSignaled } else { $false }
            job_drained = if ($launcherAttempted) { [bool]$Run.JobDrained } else { $false }
            worker_token_verified = if ($launcherAttempted) { [bool]$Run.WorkerTokenVerified } else { $false }
            job_membership_verified = if ($launcherAttempted) { [bool]$Run.JobMembershipVerified } else { $false }
            duration_ms = if ($launcherAttempted) { [long]$Run.DurationMs } else { $null }
            stdout_bytes = [Text.Encoding]::UTF8.GetByteCount($stdout)
        }
        response_status = if ($launcherAttempted) { 'UNKNOWN' } else { 'SKIPPED' }
        files = $defaultFiles
        ancestor_chain = [ordered]@{ status = if ($launcherAttempted) { 'UNKNOWN' } else { 'SKIPPED' }; error_code = if ($launcherAttempted) { $null } else { 'NOT_RUN' } }
        ancestors = @()
        import = [ordered]@{
            status = if ($launcherAttempted) { 'UNKNOWN' } else { 'SKIPPED' }
            error_code = if ($launcherAttempted) { $null } else { 'NOT_RUN' }
            syscall = $null
            path_label = $null
        }
    }
    if (-not $launcherAttempted) { return $observation }
    if ($Run.TimedOut -or $Run.ExitCode -ne 0 -or $Run.OutputTruncated -or -not $Run.RootProcessSignaled -or
        -not $Run.JobDrained -or -not $Run.WorkerTokenVerified -or -not $Run.JobMembershipVerified -or
        $observation.launcher.stdout_bytes -gt 4096) { return $observation }

    try { $response = $stdout.Trim() | ConvertFrom-Json -ErrorAction Stop }
    catch { $observation.response_status = 'INVALID'; return $observation }
    if (-not (Test-ExactObjectKeys $response @('schema_version', 'files', 'ancestor_chain', 'ancestors', 'import')) -or
        $response.schema_version -ne 1 -or $response.files -isnot [System.Array] -or $response.files.Count -ne 2 -or
        -not (Test-StagedAncestorChainOperation $response.ancestor_chain) -or
        $response.ancestors -isnot [System.Array] -or $response.ancestors.Count -gt 32 -or
        -not (Test-StagedImportDiagnostic $response.import)) {
        $observation.response_status = 'INVALID'
        return $observation
    }

    if (($response.ancestor_chain.status -ceq 'PASS' -and
            ($response.ancestors.Count -lt 1 -or $response.ancestors.Count -gt 32)) -or
        ($response.ancestor_chain.status -ne 'PASS' -and $response.ancestors.Count -ne 0)) {
        $observation.response_status = 'INVALID'
        return $observation
    }

    $expectedLabels = @('workerModule', 'probeContract')
    $validatedFiles = [System.Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $expectedLabels.Count; $index++) {
        $file = $response.files[$index]
        if (-not (Test-ExactObjectKeys $file @('label', 'lstat', 'read')) -or
            [string]$file.label -cne $expectedLabels[$index] -or
            -not (Test-StagedReadDiagnosticOperation $file.lstat 'lstat') -or
            -not (Test-StagedReadDiagnosticOperation $file.read 'read')) {
            $observation.response_status = 'INVALID'
            return $observation
        }
        $validatedFiles.Add([ordered]@{
            label = $expectedLabels[$index]
            lstat = [ordered]@{ status = [string]$file.lstat.status; error_code = $file.lstat.error_code }
            read = [ordered]@{ status = [string]$file.read.status; error_code = $file.read.error_code }
        })
    }
    $validatedAncestors = [System.Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $response.ancestors.Count; $index++) {
        $ancestor = $response.ancestors[$index]
        $expectedAncestorLabel = 'ancestor' + $index.ToString('D2', [Globalization.CultureInfo]::InvariantCulture)
        if (-not (Test-ExactObjectKeys $ancestor @('label', 'lstat', 'realpath')) -or
            [string]$ancestor.label -cne $expectedAncestorLabel -or
            -not (Test-StagedAncestorOperation $ancestor.lstat 'lstat') -or
            -not (Test-StagedAncestorOperation $ancestor.realpath 'realpath')) {
            $observation.response_status = 'INVALID'
            return $observation
        }
        $validatedAncestors.Add([ordered]@{
            label = $expectedAncestorLabel
            lstat = [ordered]@{ operation = [string]$ancestor.lstat[0]; status = [string]$ancestor.lstat[1]; error_code = $ancestor.lstat[2] }
            realpath = [ordered]@{ operation = [string]$ancestor.realpath[0]; status = [string]$ancestor.realpath[1]; error_code = $ancestor.realpath[2] }
        })
    }
    $allFilesReadable = @($validatedFiles | Where-Object { $_.lstat.status -cne 'PASS' -or $_.read.status -cne 'PASS' }).Count -eq 0
    if ((-not $allFilesReadable -and $response.import.status -ceq 'PASS') -or
        ($allFilesReadable -and $response.import.status -ceq 'SKIPPED')) {
        $observation.response_status = 'INVALID'
        return $observation
    }
    $observation.response_status = 'VALID'
    $observation.files = @($validatedFiles.ToArray())
    $observation.ancestor_chain = [ordered]@{ status = [string]$response.ancestor_chain.status; error_code = $response.ancestor_chain.error_code }
    $observation.ancestors = @($validatedAncestors.ToArray())
    $observation.import = [ordered]@{
        status = [string]$response.import.status
        error_code = $response.import.error_code
        syscall = $response.import.syscall
        path_label = $response.import.path_label
    }
    return $observation
}

function Test-ProfileContractDiagnosticOperation($Value, [string]$ExpectedOperation) {
    if (-not (Test-ExactObjectKeys $Value @('operation', 'status', 'error_code')) -or
        [string]$Value.operation -cne $ExpectedOperation -or
        [string]$Value.status -notin @('PASS', 'DENIED', 'FAIL', 'SKIPPED')) { return $false }
    $codes = @('EACCES', 'EPERM', 'ENOENT', 'EBADF', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EMFILE', 'ENFILE',
        'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_UNSUPPORTED_DIR_IMPORT', 'NOT_RUN',
        'NOT_REGULAR', 'NOT_DIRECTORY', 'SYMLINK', 'INVALID_PROFILE_PATH', 'TOO_LARGE', 'FILE_CHANGED',
        'INCOMPLETE', 'HASH_MISMATCH', 'INVALID_REQUEST', 'LIMIT_EXCEEDED', 'EXPORT_SHAPE', 'UNKNOWN')
    if ($null -ne $Value.error_code -and [string]$Value.error_code -notin $codes) { return $false }
    if ($Value.status -ceq 'PASS' -and $null -ne $Value.error_code) { return $false }
    if ($Value.status -ceq 'DENIED' -and [string]$Value.error_code -notin @('EACCES', 'EPERM')) { return $false }
    if ($Value.status -ceq 'SKIPPED' -and [string]$Value.error_code -notin @('NOT_RUN', 'INVALID_REQUEST', 'LIMIT_EXCEEDED')) { return $false }
    if ($Value.status -in @('DENIED', 'FAIL') -and $null -eq $Value.error_code) { return $false }
    return $true
}

function Test-ProfileContractDiagnosticImport($Value) {
    if (-not (Test-ExactObjectKeys $Value @('operation', 'status', 'error_code', 'syscall', 'path_label')) -or
        [string]$Value.operation -cne 'import' -or
        [string]$Value.status -notin @('PASS', 'DENIED', 'FAIL', 'SKIPPED')) { return $false }
    $syscalls = @('access', 'lstat', 'open', 'read', 'readlink', 'realpath', 'stat')
    if ($null -ne $Value.syscall -and [string]$Value.syscall -notin $syscalls) { return $false }
    if ($null -ne $Value.path_label -and [string]$Value.path_label -cne 'profileContractTemp') { return $false }
    if ($Value.status -ceq 'PASS') {
        return $null -eq $Value.error_code -and $null -eq $Value.syscall -and $null -eq $Value.path_label
    }
    if ($Value.status -ceq 'SKIPPED') {
        return [string]$Value.error_code -in @('NOT_RUN', 'INVALID_REQUEST', 'LIMIT_EXCEEDED') -and
            $null -eq $Value.syscall -and $null -eq $Value.path_label
    }
    if ($Value.status -ceq 'DENIED' -and [string]$Value.error_code -notin @('EACCES', 'EPERM')) { return $false }
    return $null -ne $Value.error_code
}

function Convert-ProfileContractImportDiagnosticObservation($Run) {
    $attempted = $null -ne $Run
    $stdout = if ($attempted) { [string]$Run.Stdout } else { '' }
    $observation = [ordered]@{
        attempted = $attempted
        response_status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
        label = 'profileContractTemp'
        lstat = [ordered]@{ status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }; error_code = if ($attempted) { $null } else { 'NOT_RUN' } }
        realpath = [ordered]@{ status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }; error_code = if ($attempted) { $null } else { 'NOT_RUN' } }
        read = [ordered]@{ status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }; error_code = if ($attempted) { $null } else { 'NOT_RUN' } }
        import = [ordered]@{
            status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
            error_code = if ($attempted) { $null } else { 'NOT_RUN' }
            syscall = $null
            path_label = $null
        }
        launcher = [ordered]@{
            timed_out = if ($attempted) { [bool]$Run.TimedOut } else { $false }
            exit_code = if ($attempted) { [int]$Run.ExitCode } else { $null }
            output_truncated = if ($attempted) { [bool]$Run.OutputTruncated } else { $false }
            root_process_signaled = if ($attempted) { [bool]$Run.RootProcessSignaled } else { $false }
            job_drained = if ($attempted) { [bool]$Run.JobDrained } else { $false }
            worker_token_verified = if ($attempted) { [bool]$Run.WorkerTokenVerified } else { $false }
            job_membership_verified = if ($attempted) { [bool]$Run.JobMembershipVerified } else { $false }
            duration_ms = if ($attempted) { [long]$Run.DurationMs } else { $null }
            stdout_bytes = [Text.Encoding]::UTF8.GetByteCount($stdout)
        }
    }
    if (-not $attempted) { return $observation }
    if ($Run.TimedOut -or $Run.ExitCode -ne 0 -or $Run.OutputTruncated -or -not $Run.RootProcessSignaled -or
        -not $Run.JobDrained -or -not $Run.WorkerTokenVerified -or -not $Run.JobMembershipVerified -or
        $observation.launcher.stdout_bytes -gt 2048) { return $observation }
    try { $response = $stdout.Trim() | ConvertFrom-Json -ErrorAction Stop }
    catch { $observation.response_status = 'INVALID'; return $observation }
    if (-not (Test-ExactObjectKeys $response @('schema_version', 'label', 'lstat', 'realpath', 'read', 'import')) -or
        $response.schema_version -ne 1 -or [string]$response.label -cne 'profileContractTemp' -or
        -not (Test-ProfileContractDiagnosticOperation $response.lstat 'lstat') -or
        -not (Test-ProfileContractDiagnosticOperation $response.realpath 'realpath') -or
        -not (Test-ProfileContractDiagnosticOperation $response.read 'read') -or
        -not (Test-ProfileContractDiagnosticImport $response.import)) {
        $observation.response_status = 'INVALID'
        return $observation
    }
    $allChecksPass = $response.lstat.status -ceq 'PASS' -and $response.realpath.status -ceq 'PASS' -and
        $response.read.status -ceq 'PASS'
    if ((-not $allChecksPass -and $response.import.status -ceq 'PASS') -or
        ($allChecksPass -and $response.import.status -ceq 'SKIPPED')) {
        $observation.response_status = 'INVALID'
        return $observation
    }
    $observation.response_status = 'VALID'
    foreach ($operationName in @('lstat', 'realpath', 'read')) {
        $observation[$operationName] = [ordered]@{
            status = [string]$response[$operationName].status
            error_code = $response[$operationName].error_code
        }
    }
    $observation.import = [ordered]@{
        status = [string]$response.import.status
        error_code = $response.import.error_code
        syscall = $response.import.syscall
        path_label = $response.import.path_label
    }
    return $observation
}

function Test-ProfileBootstrapResponseStatus($Value, [string]$FieldName, [string[]]$Allowed) {
    if ($null -eq $Value) { return $false }
    return [string]$Value -cin $Allowed
}

function Test-ProfileBootstrapPathChecks($Value, [string]$Shape) {
    $keys = @('local_drive_absolute', 'local_no_stream', 'local_canonical', 'local_leaf_is_ac',
        'parent_matches_nonce_name', 'parent_matches_nonce_name_ordinal_ignore_case',
        'grandparent_is_packages', 'temp_matches_local_child',
        'tmp_matches_local_child')
    $acceptanceKeys = @('local_drive_absolute', 'local_no_stream', 'local_canonical', 'local_leaf_is_ac',
        'parent_matches_nonce_name_ordinal_ignore_case', 'grandparent_is_packages',
        'temp_matches_local_child', 'tmp_matches_local_child')
    if (-not (Test-ExactObjectKeys $Value $keys)) { return $false }
    $allNull = $true
    $allBoolean = $true
    $allAcceptanceTrue = $true
    $anyAcceptanceFalse = $false
    foreach ($key in $keys) {
        $item = $Value.$key
        if ($null -eq $item) {
            $allBoolean = $false
        } else {
            $allNull = $false
            if ($item -isnot [bool]) { return $false }
            if ($key -cin $acceptanceKeys -and -not $item) {
                $allAcceptanceTrue = $false
                $anyAcceptanceFalse = $true
            }
        }
    }
    if ($Value.parent_matches_nonce_name -eq $true -and
        $Value.parent_matches_nonce_name_ordinal_ignore_case -ne $true) { return $false }
    if ($Shape -ceq 'SKIPPED') { return $allNull }
    if ($Shape -ceq 'PASS') { return $allBoolean -and $allAcceptanceTrue }
    if ($Shape -ceq 'FAIL') { return $allBoolean -and $anyAcceptanceFalse }
    return $false
}

function Invoke-ProfileBootstrapApiObservation([scriptblock]$ValidateCandidate, [scriptblock]$ObserveApi) {
    $observation = [ordered]@{
        candidate_validation = 'NOT_RUN'
        api_call = 'NOT_CALLED'
        api_hresult = $null
        candidate_matched = $null
    }
    try {
        if ((& $ValidateCandidate) -cne $true) {
            $observation.candidate_validation = 'FAIL'
            return $observation
        }
        $observation.candidate_validation = 'PASS'
    } catch {
        $observation.candidate_validation = 'FAIL'
        return $observation
    }
    try {
        # The launcher independently validates the candidate again before the API call.
        # A thrown launcher error cannot prove whether the native API was reached.
        $observation.api_call = 'UNKNOWN'
        $result = & $ObserveApi
        if ($null -eq $result -or $result.ApiHResult -isnot [int] -or $result.CandidateMatched -isnot [bool]) {
            return $observation
        }
        $observation.api_hresult = '0x' + ([int]$result.ApiHResult).ToString('X8')
        $observation.candidate_matched = [bool]$result.CandidateMatched
        $observation.api_call = 'CALLED'
    } catch {
        # Never include raw exception text or assume that the API was called.
    }
    return $observation
}

function Convert-ProfileBootstrapDiagnosticObservation($Run) {
    $attempted = $null -ne $Run
    $stdout = if ($attempted) { [string]$Run.Stdout } else { '' }
    $observation = [ordered]@{
        attempted = $attempted
        launch_status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
        launch_evidence_complete = $false
        response_status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
        operation_status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
        profile_path_shape = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
        profile_path_checks = [ordered]@{
            local_drive_absolute = $null; local_no_stream = $null; local_canonical = $null; local_leaf_is_ac = $null
            parent_matches_nonce_name = $null; parent_matches_nonce_name_ordinal_ignore_case = $null
            grandparent_is_packages = $null
            temp_matches_local_child = $null; tmp_matches_local_child = $null
        }
        before_bootstrap = [ordered]@{ candidate_validation = 'NOT_RUN'; api_call = 'NOT_CALLED'; api_hresult = $null; candidate_matched = $null }
        after_bootstrap = [ordered]@{ candidate_validation = 'NOT_RUN'; api_call = 'NOT_CALLED'; api_hresult = $null; candidate_matched = $null }
        temp_existed_before = $null
        temp_create_status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
        temp_created_by_diagnostic = $false
        marker_created_by_diagnostic = $false
        marker_write_status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
        marker_read_status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
        marker_delete_status = if ($attempted) { 'UNKNOWN' } else { 'SKIPPED' }
        marker_absent = $null
        error_code = $null
        duration_ms = if ($attempted) { [long]$Run.DurationMs } else { $null }
        stdout_bytes = [Text.Encoding]::UTF8.GetByteCount($stdout)
        job_drained = if ($attempted) { [bool]$Run.JobDrained } else { $false }
        worker_token_verified = if ($attempted) { [bool]$Run.WorkerTokenVerified } else { $false }
        job_membership_verified = if ($attempted) { [bool]$Run.JobMembershipVerified } else { $false }
        timed_out = if ($attempted) { [bool]$Run.TimedOut } else { $false }
        output_truncated = if ($attempted) { [bool]$Run.OutputTruncated } else { $false }
        exit_code = if ($attempted) { [int]$Run.ExitCode } else { $null }
    }
    if (-not $attempted) { return $observation }
    $observation.launch_evidence_complete = -not $Run.TimedOut -and -not $Run.OutputTruncated -and
        $Run.RootProcessSignaled -and $Run.JobDrained -and $Run.WorkerTokenVerified -and
        $Run.JobMembershipVerified -and $observation.stdout_bytes -le 2048
    if (-not $observation.launch_evidence_complete) { return $observation }
    $observation.launch_status = if ($Run.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }
    try { $response = $stdout.Trim() | ConvertFrom-Json -ErrorAction Stop }
    catch { $observation.response_status = 'INVALID'; return $observation }
    if (-not (Test-ExactObjectKeys $response @('schema_version', 'status', 'profile_path_shape', 'profile_path_checks',
            'temp_existed_before', 'temp_create_status', 'temp_created_by_diagnostic',
            'marker_created_by_diagnostic', 'marker_write_status', 'marker_read_status',
            'marker_delete_status', 'marker_absent', 'error_code')) -or
        $response.schema_version -ne 1 -or
        -not (Test-ProfileBootstrapResponseStatus $response.status 'status' @('PASS', 'FAIL')) -or
        -not (Test-ProfileBootstrapResponseStatus $response.profile_path_shape 'profile_path_shape' @('PASS', 'FAIL', 'SKIPPED')) -or
        -not (Test-ProfileBootstrapResponseStatus $response.temp_create_status 'temp_create_status' @('CREATED', 'ALREADY_PRESENT', 'FAIL', 'NOT_RUN')) -or
        -not (Test-ProfileBootstrapResponseStatus $response.marker_write_status 'marker_write_status' @('PASS', 'FAIL', 'NOT_RUN')) -or
        -not (Test-ProfileBootstrapResponseStatus $response.marker_read_status 'marker_read_status' @('PASS', 'FAIL', 'NOT_RUN')) -or
        -not (Test-ProfileBootstrapResponseStatus $response.marker_delete_status 'marker_delete_status' @('PASS', 'FAIL', 'NOT_RUN')) -or
        $response.temp_existed_before -isnot [bool] -and $null -ne $response.temp_existed_before -or
        $response.marker_absent -isnot [bool] -and $null -ne $response.marker_absent -or
        $response.temp_created_by_diagnostic -isnot [bool] -or
        $response.marker_created_by_diagnostic -isnot [bool]) {
        $observation.response_status = 'INVALID'
        return $observation
    }
    $allowedCodes = @('EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EBADF', 'EISDIR', 'ENOTDIR', 'ELOOP',
        'EBUSY', 'INVALID_REQUEST', 'LIMIT_EXCEEDED', 'INVALID_PROFILE_PATH', 'NOT_DIRECTORY', 'SYMLINK',
        'TEMP_CREATE_FAILED', 'MARKER_EXISTS', 'MARKER_MISMATCH', 'UNKNOWN')
    if ($null -ne $response.error_code -and [string]$response.error_code -cnotin $allowedCodes) {
        $observation.response_status = 'INVALID'
        return $observation
    }
    $pathChecksValid = Test-ProfileBootstrapPathChecks $response.profile_path_checks ([string]$response.profile_path_shape)
    if (-not $pathChecksValid) {
        $observation.response_status = 'INVALID'
        return $observation
    }
    if (($response.profile_path_shape -ceq 'FAIL') -ne
            ([string]$response.error_code -ceq 'INVALID_PROFILE_PATH') -or
        ($response.profile_path_shape -ceq 'FAIL' -and
            ($response.status -cne 'FAIL' -or $null -ne $response.temp_existed_before -or
                $response.temp_create_status -cne 'NOT_RUN' -or $response.temp_created_by_diagnostic -or
                $response.marker_created_by_diagnostic -or $response.marker_write_status -cne 'NOT_RUN' -or
                $response.marker_read_status -cne 'NOT_RUN' -or $response.marker_delete_status -cne 'NOT_RUN' -or
                $null -ne $response.marker_absent))) {
        $observation.response_status = 'INVALID'
        return $observation
    }
    if (($response.temp_create_status -ceq 'CREATED' -and
            ($response.temp_existed_before -ne $false -or -not $response.temp_created_by_diagnostic)) -or
        ($response.temp_create_status -ceq 'ALREADY_PRESENT' -and
            ($response.temp_existed_before -ne $true -or $response.temp_created_by_diagnostic)) -or
        ($response.marker_delete_status -ceq 'PASS' -and $response.marker_absent -ne $true) -or
        ($response.status -ceq 'PASS' -and ($response.profile_path_shape -cne 'PASS' -or
            $response.temp_create_status -notin @('CREATED', 'ALREADY_PRESENT') -or
            -not $response.marker_created_by_diagnostic -or $response.marker_write_status -cne 'PASS' -or
            $response.marker_read_status -cne 'PASS' -or $response.marker_delete_status -cne 'PASS' -or
            $response.marker_absent -ne $true -or $null -ne $response.error_code))) {
        $observation.response_status = 'INVALID'
        return $observation
    }
    $observation.response_status = 'VALID'
    $observation.operation_status = [string]$response.status
    $observation.profile_path_shape = [string]$response.profile_path_shape
    $observation.profile_path_checks = $response.profile_path_checks
    $observation.temp_existed_before = $response.temp_existed_before
    $observation.temp_create_status = [string]$response.temp_create_status
    $observation.temp_created_by_diagnostic = [bool]$response.temp_created_by_diagnostic
    $observation.marker_created_by_diagnostic = [bool]$response.marker_created_by_diagnostic
    $observation.marker_write_status = [string]$response.marker_write_status
    $observation.marker_read_status = [string]$response.marker_read_status
    $observation.marker_delete_status = [string]$response.marker_delete_status
    $observation.marker_absent = $response.marker_absent
    $observation.error_code = $response.error_code
    return $observation
}

function Get-CallerLineNumber {
    return $MyInvocation.ScriptLineNumber
}

function Get-ProfilePathStage($Exception) {
    $allowedStages = @('NONCE', 'SID_NAME', 'API', 'CANONICAL', 'SUFFIX', 'REPARSE')
    $current = $Exception
    while ($null -ne $current) {
        if ($null -ne $current.Data -and $current.Data.Contains('profile_path_stage')) {
            $candidate = $current.Data['profile_path_stage']
            if ($candidate -is [string] -and $allowedStages -ccontains $candidate) {
                return $candidate
            }
            return 'UNKNOWN'
        }
        $current = $current.InnerException
    }
    return 'UNKNOWN'
}

function Set-Diagnostic([string]$Phase, $ErrorRecord, $ScriptLine) {
    $exception = $ErrorRecord.Exception
    $inner = $exception.InnerException
    $commandName = $null
    $fullyQualifiedErrorId = $null
    if ($exception -is [System.Management.Automation.CommandNotFoundException] -and
        $exception.CommandName -match '^[A-Za-z][A-Za-z0-9-]{0,63}$') {
        $commandName = $exception.CommandName
    }
    $errorIdCandidate = $ErrorRecord.FullyQualifiedErrorId
    if ($errorIdCandidate -is [string] -and $errorIdCandidate.Length -le 160 -and
        $errorIdCandidate -match '^[A-Za-z0-9_.,-]+$') {
        $fullyQualifiedErrorId = $errorIdCandidate
    }
    $apiHresult = $null
    $apiOperation = $null
    $apiNativeErrorCode = $null
    $processTreeStage = $null
    $processTreeFailureStage = $null
    $processTreeExceptionType = $null
    $processTreeHresult = $null
    $processTreeWin32Code = $null
    $processTreeCleanupStage = $null
    $processTreeCleanupExceptionType = $null
    $processTreeCleanupHresult = $null
    $processTreeCleanupWin32Code = $null
    $apiException = $exception
    while ($null -ne $apiException) {
        $exceptionData = $apiException.Data
        if ($null -ne $exceptionData) {
            if ($null -eq $apiHresult -and $exceptionData.Contains('api_hresult') -and
                $exceptionData['api_hresult'] -is [int]) {
                $apiHresult = $exceptionData['api_hresult']
            }
            if ($null -eq $apiOperation -and $exceptionData.Contains('api_operation') -and
                $exceptionData['api_operation'] -is [string]) {
                $apiOperation = $exceptionData['api_operation']
            }
            if ($null -eq $apiNativeErrorCode -and $exceptionData.Contains('api_native_error_code') -and
                $exceptionData['api_native_error_code'] -is [int]) {
                $apiNativeErrorCode = $exceptionData['api_native_error_code']
            }
            if ($null -eq $processTreeStage -and $exceptionData.Contains('agentcp_process_tree_stage') -and
                $exceptionData['agentcp_process_tree_stage'] -is [string] -and
                $exceptionData['agentcp_process_tree_stage'] -in @(
                    'PREFLIGHT', 'ARGUMENT_CONSTRUCTION', 'PROCESS_CREATE', 'TOKEN_VERIFICATION',
                    'JOB_MEMBERSHIP', 'INPUT_WRITE', 'PROCESS_WAIT', 'TIMEOUT_QUERY', 'JOB_SNAPSHOT',
                    'JOB_TERMINATION', 'ROOT_SIGNAL', 'JOB_DRAIN', 'OUTPUT_CAPTURE', 'CLEANUP')) {
                $processTreeStage = $exceptionData['agentcp_process_tree_stage']
            }
            if ($null -eq $processTreeFailureStage -and $exceptionData.Contains('agentcp_process_tree_failure_stage') -and
                $exceptionData['agentcp_process_tree_failure_stage'] -is [string] -and
                ($exceptionData['agentcp_process_tree_failure_stage'] -ceq 'NONE' -or
                    $exceptionData['agentcp_process_tree_failure_stage'] -in @(
                        'PREFLIGHT', 'ARGUMENT_CONSTRUCTION', 'PROCESS_CREATE', 'TOKEN_VERIFICATION',
                        'JOB_MEMBERSHIP', 'INPUT_WRITE', 'PROCESS_WAIT', 'TIMEOUT_QUERY', 'JOB_SNAPSHOT',
                        'JOB_TERMINATION', 'ROOT_SIGNAL', 'JOB_DRAIN', 'OUTPUT_CAPTURE', 'CLEANUP'))) {
                $processTreeFailureStage = $exceptionData['agentcp_process_tree_failure_stage']
            }
            if ($null -eq $processTreeExceptionType -and $exceptionData.Contains('agentcp_process_tree_exception_type') -and
                $exceptionData['agentcp_process_tree_exception_type'] -is [string] -and
                $exceptionData['agentcp_process_tree_exception_type'] -in @(
                    'Win32Exception', 'ArgumentException', 'InvalidOperationException', 'TimeoutException',
                    'IOException', 'UnauthorizedAccessException', 'PlatformNotSupportedException', 'OtherException')) {
                $processTreeExceptionType = $exceptionData['agentcp_process_tree_exception_type']
            }
            if ($null -eq $processTreeHresult -and $exceptionData.Contains('agentcp_process_tree_hresult') -and
                $exceptionData['agentcp_process_tree_hresult'] -is [int]) {
                $processTreeHresult = $exceptionData['agentcp_process_tree_hresult']
            }
            if ($null -eq $processTreeWin32Code -and $exceptionData.Contains('agentcp_process_tree_win32_code') -and
                $exceptionData['agentcp_process_tree_win32_code'] -is [int]) {
                $processTreeWin32Code = $exceptionData['agentcp_process_tree_win32_code']
            }
            if ($null -eq $processTreeCleanupStage -and $exceptionData.Contains('agentcp_process_tree_cleanup_stage') -and
                $exceptionData['agentcp_process_tree_cleanup_stage'] -is [string] -and
                $exceptionData['agentcp_process_tree_cleanup_stage'] -in @(
                    'PREFLIGHT', 'ARGUMENT_CONSTRUCTION', 'PROCESS_CREATE', 'TOKEN_VERIFICATION',
                    'JOB_MEMBERSHIP', 'INPUT_WRITE', 'PROCESS_WAIT', 'TIMEOUT_QUERY', 'JOB_SNAPSHOT',
                    'JOB_TERMINATION', 'ROOT_SIGNAL', 'JOB_DRAIN', 'OUTPUT_CAPTURE', 'CLEANUP')) {
                $processTreeCleanupStage = $exceptionData['agentcp_process_tree_cleanup_stage']
            }
            if ($null -eq $processTreeCleanupExceptionType -and
                $exceptionData.Contains('agentcp_process_tree_cleanup_exception_type') -and
                $exceptionData['agentcp_process_tree_cleanup_exception_type'] -is [string] -and
                $exceptionData['agentcp_process_tree_cleanup_exception_type'] -in @(
                    'Win32Exception', 'ArgumentException', 'InvalidOperationException', 'TimeoutException',
                    'IOException', 'UnauthorizedAccessException', 'PlatformNotSupportedException', 'OtherException')) {
                $processTreeCleanupExceptionType = $exceptionData['agentcp_process_tree_cleanup_exception_type']
            }
            if ($null -eq $processTreeCleanupHresult -and
                $exceptionData.Contains('agentcp_process_tree_cleanup_hresult') -and
                $exceptionData['agentcp_process_tree_cleanup_hresult'] -is [int]) {
                $processTreeCleanupHresult = $exceptionData['agentcp_process_tree_cleanup_hresult']
            }
            if ($null -eq $processTreeCleanupWin32Code -and
                $exceptionData.Contains('agentcp_process_tree_cleanup_win32_code') -and
                $exceptionData['agentcp_process_tree_cleanup_win32_code'] -is [int]) {
                $processTreeCleanupWin32Code = $exceptionData['agentcp_process_tree_cleanup_win32_code']
            }
        }
        $apiException = $apiException.InnerException
    }
    $report.diagnostic = [ordered]@{
        phase = $Phase
        powershell_line = $ScriptLine
        command_name = $commandName
        fully_qualified_error_id = $fullyQualifiedErrorId
        exception_type = $exception.GetType().Name
        hresult = ('0x{0:X8}' -f $exception.HResult)
        api_hresult = $apiHresult
        api_operation = $apiOperation
        api_native_error_code = $apiNativeErrorCode
        profile_path_stage = Get-ProfilePathStage $exception
        inner_exception_type = if ($null -ne $inner) { $inner.GetType().Name } else { $null }
        inner_hresult = if ($null -ne $inner) { '0x{0:X8}' -f $inner.HResult } else { $null }
        process_tree_stage = $processTreeStage
        process_tree_failure_stage = $processTreeFailureStage
        process_tree_exception_type = $processTreeExceptionType
        process_tree_hresult = $processTreeHresult
        process_tree_win32_code = $processTreeWin32Code
        process_tree_cleanup_stage = $processTreeCleanupStage
        process_tree_cleanup_exception_type = $processTreeCleanupExceptionType
        process_tree_cleanup_hresult = $processTreeCleanupHresult
        process_tree_cleanup_win32_code = $processTreeCleanupWin32Code
    }
}

function Test-ExceptionDataFlag($ErrorRecord, [string]$Key) {
    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
        if ($null -ne $exception.Data -and $exception.Data.Contains($Key) -and
            $exception.Data[$Key] -is [bool] -and $exception.Data[$Key]) {
            return $true
        }
        $exception = $exception.InnerException
    }
    return $false
}

function Set-PhaseDiagnostic([string]$Phase, $ScriptLine) {
    $report.diagnostic = [ordered]@{
        phase = $Phase
        powershell_line = $ScriptLine
        command_name = $null
        fully_qualified_error_id = $null
        exception_type = $null
        hresult = $null
        api_hresult = $null
        api_operation = $null
        api_native_error_code = $null
        profile_path_stage = 'UNKNOWN'
        inner_exception_type = $null
        inner_hresult = $null
        process_tree_stage = $null
        process_tree_failure_stage = $null
        process_tree_exception_type = $null
        process_tree_hresult = $null
        process_tree_win32_code = $null
        process_tree_cleanup_stage = $null
        process_tree_cleanup_exception_type = $null
        process_tree_cleanup_hresult = $null
        process_tree_cleanup_win32_code = $null
    }
}

function Get-NodeExecutable {
    $programFilesRoots = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    foreach ($programFilesRoot in $programFilesRoots) {
        $trustedRoot = Assert-NoReparsePath ([System.IO.Path]::GetFullPath($programFilesRoot))
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $trustedRoot 'nodejs\node.exe'))
        $null = Assert-NoReparsePath $candidate
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return Assert-RegularFile $candidate
        }
    }
    throw 'Node.js was not found in a standard Program Files installation; PATH lookup is disabled.'
}

function Assert-RegularFile([string]$Candidate) {
    if (-not [System.IO.Path]::IsPathRooted($Candidate)) {
        throw 'A trusted executable or source path must be absolute.'
    }
    $canonical = Assert-NoReparsePath $Candidate
    $attributes = [System.IO.File]::GetAttributes($canonical)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A trusted source path is not an ordinary file.'
    }
    return $canonical
}

function Assert-RegularChildFile([string]$Parent, [string]$Candidate) {
    if (-not [System.IO.Path]::IsPathRooted($Candidate)) {
        throw 'A trusted source path must be absolute.'
    }
    $canonical = Assert-ChildPath $Parent $Candidate
    $attributes = [System.IO.File]::GetAttributes($canonical)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A trusted source path is not an ordinary file.'
    }
    return $canonical
}

function Read-ValidatedSource([string]$Parent, [string]$Candidate,
    [System.Collections.IDictionary]$Diagnostics = $null) {
    $assertDiagnosticChildFile = $null
    if ($null -eq $Diagnostics) {
        $canonical = Assert-RegularChildFile $Parent $Candidate
    } else {
        $assertDiagnosticChildFile = {
            param([string]$PathParent, [string]$PathCandidate)
            $Diagnostics['substage'] = 'PATH_CONTAINMENT'
            if (-not [System.IO.Path]::IsPathRooted($PathCandidate)) {
                throw 'A trusted source path must be absolute.'
            }
            $canonicalParent = [System.IO.Path]::GetFullPath($PathParent).TrimEnd('\') + '\'
            $Diagnostics['substage'] = 'REPARSE_ATTRIBUTES'
            $canonicalCandidate = Assert-NoReparsePath $PathCandidate
            $Diagnostics['substage'] = 'PATH_CONTAINMENT'
            if (-not $canonicalCandidate.StartsWith($canonicalParent, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Refusing to access a generated path outside its designated root.'
            }
            $Diagnostics['substage'] = 'REPARSE_ATTRIBUTES'
            $attributes = [System.IO.File]::GetAttributes($canonicalCandidate)
            if (($attributes -band [System.IO.FileAttributes]::Directory) -or
                ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw 'A trusted source path is not an ordinary file.'
            }
            return $canonicalCandidate
        }.GetNewClosure()
        $canonical = & $assertDiagnosticChildFile $Parent $Candidate
    }
    $stream = $null
    try {
        if ($null -eq $Diagnostics) {
            $null = Assert-RegularChildFile $Parent $canonical
        } else {
            $null = & $assertDiagnosticChildFile $Parent $canonical
        }
        if ($null -ne $Diagnostics) { $Diagnostics['substage'] = 'FILE_OPEN' }
        $stream = [System.IO.FileStream]::new($canonical, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        if ($null -eq $Diagnostics) {
            $null = Assert-RegularChildFile $Parent $canonical
        } else {
            $null = & $assertDiagnosticChildFile $Parent $canonical
        }
        if ($null -ne $Diagnostics) { $Diagnostics['substage'] = 'BOUNDED_READ_HASH' }
        if ($stream.Length -gt 1048576) { throw 'The launcher source exceeds the 1 MiB static-source limit.' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw 'The launcher source changed or ended during the locked read.' }
            $offset += $read
        }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')).ToLowerInvariant()
        } finally { $sha.Dispose() }
        if ($null -ne $Diagnostics) { $Diagnostics['substage'] = 'UTF8_DECODE' }
        $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        return [pscustomobject]@{ Path = $canonical; Bytes = $bytes; Sha256 = $hash; Text = $text }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Test-ExactHostTestJsonProperties($Value, [string[]]$ExpectedNames) {
    if ($null -eq $Value -or $Value -is [System.Array] -or
        $Value -isnot [System.Management.Automation.PSCustomObject]) { return $false }
    $actualNames = @($Value.PSObject.Properties |
        Where-Object { $_.MemberType -eq 'NoteProperty' } |
        ForEach-Object { [string]$_.Name })
    if ($actualNames.Count -ne $ExpectedNames.Count) { return $false }
    foreach ($expectedName in $ExpectedNames) {
        if ($actualNames -cnotcontains $expectedName) { return $false }
    }
    return $true
}

function Get-HostTestSha256([string]$Value) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))).Replace('-', '')).ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Get-HostProcessTreeReadiness([string]$Stdout) {
    $invalid = [pscustomobject]@{ valid = $false; child_ready = $false; grandchild_ready = $false; grandchild_pid_valid = $false }
    if ([string]::IsNullOrEmpty($Stdout) -or $Stdout.Length -gt 16384) { return $invalid }
    $lines = @($Stdout -split "`n" | Where-Object { $_.Length -gt 0 })
    if ($lines.Count -ne 3) { return $invalid }
    try {
        $start = ConvertFrom-Json -InputObject $lines[0] -ErrorAction Stop
        $spawn = ConvertFrom-Json -InputObject $lines[1] -ErrorAction Stop
        $ready = ConvertFrom-Json -InputObject $lines[2] -ErrorAction Stop
    } catch { return $invalid }
    if (-not (Test-ExactHostTestJsonProperties $start @('mode', 'stage')) -or
        -not (Test-ExactHostTestJsonProperties $spawn @('mode', 'stage', 'grandchild_spawn_status', 'grandchild_spawn_code', 'grandchild_pid')) -or
        -not (Test-ExactHostTestJsonProperties $ready @('mode', 'grandchild_spawn_status', 'grandchild_spawn_code',
            'grandchild_worker_started', 'grandchild_pid', 'readiness_stage', 'readiness_status', 'readiness_code'))) {
        return $invalid
    }
    $pidIsInteger = ($spawn.grandchild_pid -is [int] -or $spawn.grandchild_pid -is [long]) -and
        $spawn.grandchild_pid -gt 0 -and [uint64]$spawn.grandchild_pid -le [uint32]::MaxValue
    $childReady = $start.mode -ceq 'process-tree-progress' -and $start.stage -ceq 'CHILD_WORKER_STARTED' -and
        $spawn.mode -ceq 'process-tree-progress' -and $spawn.stage -ceq 'GRANDCHILD_SPAWN_RESULT' -and
        $spawn.grandchild_spawn_status -ceq 'PASS' -and $spawn.grandchild_spawn_code -ceq 'NONE' -and
        $ready.mode -ceq 'process-tree-child-ready' -and $ready.grandchild_spawn_status -ceq 'PASS' -and
        $ready.grandchild_spawn_code -ceq 'NONE' -and $ready.grandchild_worker_started -eq $true -and
        $ready.readiness_stage -ceq 'READY' -and $ready.readiness_status -ceq 'PASS' -and
        $ready.readiness_code -ceq 'NONE' -and $pidIsInteger -and $ready.grandchild_pid -eq $spawn.grandchild_pid
    return [pscustomobject]@{
        valid = [bool]$childReady
        child_ready = [bool]$childReady
        grandchild_ready = [bool]($ready.grandchild_worker_started -eq $true -and $ready.readiness_status -ceq 'PASS')
        grandchild_pid_valid = [bool]$pidIsInteger
        grandchild_pid = if ($pidIsInteger) { [uint32]$spawn.grandchild_pid } else { $null }
    }
}

function Invoke-ProcessTreeHostTestMode {
    $safeResult = [ordered]@{
        schema_version = 1
        status = 'ERROR'
        reason = 'INVALID_INPUT'
        normal = $null
        timeout = $null
    }
    $sourceReadDiagnostics = [ordered]@{ substage = 'PATH_CONTAINMENT' }
    $stage = 'INPUT_VALIDATION'
    try {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
            [string]::IsNullOrEmpty($ProcessTreeHostTestInputBase64) -or
            $ProcessTreeHostTestInputBase64.Length -gt 32768 -or
            $ProcessTreeHostTestInputBase64 -cnotmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') {
            throw 'Invalid host-test input.'
        }
        $inputBytes = [Convert]::FromBase64String($ProcessTreeHostTestInputBase64)
        if ($inputBytes.Length -gt 16384) { throw 'Host-test input exceeds limit.' }
        $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
        $inputText = $utf8.GetString($inputBytes)
        $hostTestInput = ConvertFrom-Json -InputObject $inputText -ErrorAction Stop
        if (-not (Test-ExactHostTestJsonProperties $hostTestInput @('schema_version', 'node_path', 'child_script', 'grandchild_script', 'cases')) -or
            $hostTestInput.schema_version -isnot [int] -or $hostTestInput.schema_version -ne 2 -or
            -not ($hostTestInput.child_script -is [string]) -or -not ($hostTestInput.grandchild_script -is [string]) -or
            -not ($hostTestInput.node_path -is [string]) -or -not [System.IO.Path]::IsPathRooted($hostTestInput.node_path) -or
            -not [System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetFileName($hostTestInput.node_path), 'node.exe') -or
            -not [System.IO.File]::Exists($hostTestInput.node_path) -or $hostTestInput.cases -isnot [System.Array] -or $hostTestInput.cases.Count -ne 2) {
            throw 'Host-test root schema is invalid.'
        }
        $trustedNodePath = Get-NodeExecutable
        $inputNodePath = [System.IO.Path]::GetFullPath([string]$hostTestInput.node_path)
        if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($inputNodePath, $trustedNodePath)) {
            throw 'Host-test Node path does not match the trusted installation.'
        }

        $expectedNames = @('normal', 'timeout')
        $expectedRoles = @(@('child-test', 'grandchild-test'), @('child', 'grandchild'))
        $expectedTimeouts = @(10000, 5000)
        $scriptHashChild = 'dccb219a1c028dcec74060b7f7ff8ce8c45c68ebb81e0d88d47bec4497825518'
        $scriptHashGrandchild = '9356e6b9c3d7fdc50fef5fe9071b20e920b88e790a91be5bca3f07663f5e83ed'
        $childScript = [string]$hostTestInput.child_script
        $grandchildScript = [string]$hostTestInput.grandchild_script
        if ((Get-HostTestSha256 $childScript) -cne $scriptHashChild -or
            (Get-HostTestSha256 $grandchildScript) -cne $scriptHashGrandchild) {
            throw 'Host-test root schema is invalid.'
        }
        $validatedArguments = New-Object 'System.Collections.Generic.List[object]'
        for ($index = 0; $index -lt 2; $index++) {
            $case = $hostTestInput.cases[$index]
            if (-not (Test-ExactHostTestJsonProperties $case @('name', 'timeout_ms', 'child_role', 'grandchild_role')) -or
                $case.name -cne $expectedNames[$index] -or $case.timeout_ms -isnot [int] -or
                $case.timeout_ms -ne $expectedTimeouts[$index] -or
                -not ($case.child_role -is [string]) -or -not ($case.grandchild_role -is [string]) -or
                $case.child_role -cne $expectedRoles[$index][0] -or
                $case.grandchild_role -cne $expectedRoles[$index][1]) {
                throw 'Host-test case schema is invalid.'
            }
            $caseArguments = [string[]]@('-e', $childScript, [string]$case.child_role, $grandchildScript, [string]$case.grandchild_role)
            if ($caseArguments.Length -ne 5) { throw 'Host-test case schema is invalid.' }
            $validatedArguments.Add([pscustomobject]@{
                Name = $case.name
                TimeoutMs = [int]$case.timeout_ms
                Arguments = $caseArguments
            })
        }

        $stage = 'LAUNCHER_SOURCE_READ'
        $launcherSource = Read-ValidatedSource $PSScriptRoot $launcherPath $sourceReadDiagnostics
        $stage = 'LAUNCHER_COMPILE'
        Add-Type -TypeDefinition $launcherSource.Text -Language CSharp -ErrorAction Stop -WarningAction SilentlyContinue
        $stage = 'TEMP_DIRECTORY_CHECK'
        $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if (-not [System.IO.Directory]::Exists($tempRoot)) { throw 'Temporary working directory is unavailable.' }
        # Each case runs in its own fresh, empty, GUID-named directory so a timed-out tree cannot leave
        # a stale readiness file for the next run. Only that exact generated directory is removed, non-recursively.
        $newCaseDirectory = {
            $caseName = 'agentcp-pt-' + [guid]::NewGuid().ToString('N')
            $casePath = [System.IO.Path]::Combine($tempRoot, $caseName)
            if ([System.IO.Directory]::Exists($casePath) -or [System.IO.File]::Exists($casePath)) {
                throw 'Host-test case directory already exists.'
            }
            $null = [System.IO.DirectoryInfo]::new($tempRoot).CreateSubdirectory($caseName)
            $caseAttributes = [System.IO.File]::GetAttributes($casePath)
            if (-not ($caseAttributes -band [System.IO.FileAttributes]::Directory) -or
                ($caseAttributes -band [System.IO.FileAttributes]::ReparsePoint) -or
                @([System.IO.Directory]::GetFileSystemEntries($casePath)).Count -ne 0) {
                throw 'Host-test case directory is not a fresh empty directory.'
            }
            return $casePath
        }
        $removeCaseDirectory = {
            param([string]$CasePath)
            $caseAttributes = [System.IO.File]::GetAttributes($CasePath)
            if (-not ($caseAttributes -band [System.IO.FileAttributes]::Directory) -or
                ($caseAttributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw 'Host-test case directory is not an ordinary directory.'
            }
            [System.IO.Directory]::Delete($CasePath, $false)
        }
        $stage = 'NORMAL_DIRECTORY'
        $normalDirectory = & $newCaseDirectory
        $normalCleanupFailed = $false
        $stage = 'NORMAL_PROCESS'
        try {
            $normalRun = [AppContainerLauncher]::RunHostProcessTreeTest(
                $trustedNodePath, $normalDirectory, $validatedArguments[0].Arguments, $validatedArguments[0].TimeoutMs)
        } finally {
            try { & $removeCaseDirectory $normalDirectory } catch { $normalCleanupFailed = $true }
        }
        if ($normalCleanupFailed) {
            $stage = 'NORMAL_CLEANUP'
            throw 'Host-test case directory cleanup failed.'
        }
        $stage = 'NORMAL_READINESS'
        $normalReadiness = Get-HostProcessTreeReadiness ([string]$normalRun.Stdout)
        $normalRootPidValue = if ($normalRun.RootPidValid) { [uint32]$normalRun.RootProcessIdForComparison } else { $null }
        $normalGrandchildPidValue = if ($normalReadiness.grandchild_pid_valid) { [uint32]$normalReadiness.grandchild_pid } else { $null }
        $normalProcessIdsDistinct = $null -ne $normalRootPidValue -and $null -ne $normalGrandchildPidValue -and
            $normalRootPidValue -ne $normalGrandchildPidValue
        $normalRootPidAbsentAfterDrain = $normalRun.JobDrained -and $null -ne $normalRootPidValue -and
            [uint64]$normalRootPidValue -le [int]::MaxValue -and
            (Test-ProcessIdAbsent ([int]$normalRootPidValue))
        $normalGrandchildPidAbsentAfterDrain = $normalRun.JobDrained -and $null -ne $normalGrandchildPidValue -and
            [uint64]$normalGrandchildPidValue -le [int]::MaxValue -and
            (Test-ProcessIdAbsent ([int]$normalGrandchildPidValue))
        $normalPass = $normalReadiness.valid -and $normalReadiness.child_ready -and $normalReadiness.grandchild_ready -and
            $normalReadiness.grandchild_pid_valid -and $normalRun.ProcessCreated -and $normalRun.RootPidValid -and
            $normalProcessIdsDistinct -and $normalRootPidAbsentAfterDrain -and $normalGrandchildPidAbsentAfterDrain -and
            $normalRun.JobMembershipVerified -and -not $normalRun.TimedOut -and $normalRun.RootProcessSignaled -and
            $normalRun.RootExitCode -eq 0 -and $normalRun.JobDrained -and $normalRun.ActiveProcessesAfterDrain -eq 0 -and
            $normalRun.CleanupConfirmed -and -not $normalRun.OutputTruncated
        $safeResult.normal = [ordered]@{
            status = if ($normalPass) { 'PASS' } else { 'FAIL' }
            child_ready = [bool]$normalReadiness.child_ready
            grandchild_ready = [bool]$normalReadiness.grandchild_ready
            grandchild_pid_valid = [bool]$normalReadiness.grandchild_pid_valid
            process_ids_distinct = [bool]$normalProcessIdsDistinct
            root_pid_valid = [bool]$normalRun.RootPidValid
            root_pid_absent_after_drain = [bool]$normalRootPidAbsentAfterDrain
            grandchild_pid_absent_after_drain = [bool]$normalGrandchildPidAbsentAfterDrain
            job_membership_verified = [bool]$normalRun.JobMembershipVerified
            timed_out = [bool]$normalRun.TimedOut
            root_exit_observed = [bool]$normalRun.RootProcessSignaled
            root_exit_code = $normalRun.RootExitCode
            job_drained = [bool]$normalRun.JobDrained
            active_processes_after_drain = $normalRun.ActiveProcessesAfterDrain
            cleanup_confirmed = [bool]$normalRun.CleanupConfirmed
            native_stage = if (@('PREFLIGHT', 'JOB_CREATE', 'JOB_LIST_PREPARE', 'PROCESS_CREATE', 'PROCESS_WAIT', 'JOB_DEADLINE_SNAPSHOT', 'JOB_TERMINATE') -ccontains [string]$normalRun.Stage) { [string]$normalRun.Stage } else { 'UNKNOWN' }
            native_error_code = if ($null -ne $normalRun.ErrorCode) { [int]$normalRun.ErrorCode } else { $null }
        }

        $stage = 'TIMEOUT_DIRECTORY'
        $timeoutDirectory = & $newCaseDirectory
        $timeoutCleanupFailed = $false
        $stage = 'TIMEOUT_PROCESS'
        try {
            $timeoutRun = [AppContainerLauncher]::RunHostProcessTreeTest(
                $trustedNodePath, $timeoutDirectory, $validatedArguments[1].Arguments, $validatedArguments[1].TimeoutMs)
        } finally {
            try { & $removeCaseDirectory $timeoutDirectory } catch { $timeoutCleanupFailed = $true }
        }
        if ($timeoutCleanupFailed) {
            $stage = 'TIMEOUT_CLEANUP'
            throw 'Host-test case directory cleanup failed.'
        }
        $stage = 'TIMEOUT_READINESS'
        $timeoutReadiness = Get-HostProcessTreeReadiness ([string]$timeoutRun.Stdout)
        $timeoutJobProcessIds = @($timeoutRun.JobProcessIdsAtDeadline)
        $timeoutRootPidValue = if ($timeoutRun.RootPidValid) { [uint32]$timeoutRun.RootProcessIdForComparison } else { $null }
        $timeoutGrandchildPidValue = if ($timeoutReadiness.grandchild_pid_valid) { [uint32]$timeoutReadiness.grandchild_pid } else { $null }
        $timeoutProcessIdsDistinct = $null -ne $timeoutRootPidValue -and $null -ne $timeoutGrandchildPidValue -and
            $timeoutRootPidValue -ne $timeoutGrandchildPidValue
        $timeoutRootPidAbsentAfterDrain = $timeoutRun.JobDrained -and $null -ne $timeoutRootPidValue -and
            [uint64]$timeoutRootPidValue -le [int]::MaxValue -and
            (Test-ProcessIdAbsent ([int]$timeoutRootPidValue))
        $timeoutGrandchildPidAbsentAfterDrain = $timeoutRun.JobDrained -and $null -ne $timeoutGrandchildPidValue -and
            [uint64]$timeoutGrandchildPidValue -le [int]::MaxValue -and
            (Test-ProcessIdAbsent ([int]$timeoutGrandchildPidValue))
        $timeoutRootPidPresent = $null -ne $timeoutRootPidValue -and $timeoutJobProcessIds -contains $timeoutRootPidValue
        $timeoutGrandchildPidPresent = $null -ne $timeoutGrandchildPidValue -and $timeoutJobProcessIds -contains $timeoutGrandchildPidValue
        $timeoutJobPidListMatchesExpected = $timeoutRun.JobProcessIdListQuerySucceeded -and
            $timeoutRun.JobProcessIdListComplete -and $timeoutRun.JobProcessIdAssignedCount -eq 4 -and
            $timeoutRun.JobProcessIdReturnedCount -eq 4 -and $timeoutJobProcessIds.Count -eq 4 -and
            $timeoutRootPidPresent -and $timeoutGrandchildPidPresent -and
            $timeoutProcessIdsDistinct -and
            $timeoutRun.JobMemberDiagnosticsStatus -ceq 'COMPLETE' -and $timeoutRun.JobMemberJobSetStable -eq $true -and
            $timeoutRun.JobMemberOpenCount -eq 4 -and $timeoutRun.JobMemberMembershipVerifiedCount -eq 4 -and
            $timeoutRun.JobMemberNotInJobCount -eq 0 -and $timeoutRun.JobMemberMembershipUnknownCount -eq 0 -and
            $timeoutRun.JobMemberNodeImageCount -eq 2 -and $timeoutRun.JobMemberConsoleHostImageCount -eq 2 -and
            $timeoutRun.JobMemberCommandShellImageCount -eq 0 -and $timeoutRun.JobMemberOtherImageCount -eq 0 -and
            $timeoutRun.JobMemberImageUnknownCount -eq 0 -and $timeoutRun.JobMemberMetadataUnknownCount -eq 0
        $timeoutActiveProcessLimitVerified = $timeoutRun.ActiveProcessLimitQuerySucceeded -and
            $timeoutRun.EffectiveActiveProcessLimitEnabled -and $timeoutRun.EffectiveActiveProcessLimit -eq 4
        $timeoutPass = $timeoutReadiness.valid -and $timeoutReadiness.child_ready -and
            $timeoutReadiness.grandchild_ready -and $timeoutReadiness.grandchild_pid_valid -and
            $timeoutActiveProcessLimitVerified -and $timeoutRun.JobAccountingQuerySucceeded -and
            $timeoutJobPidListMatchesExpected -and $timeoutRun.AccountingExcessCoveredByTerminationCount -and
            $timeoutRun.ProcessCreated -and $timeoutRun.RootPidValid -and
            $timeoutRun.JobMembershipVerified -and $timeoutRun.TimedOut -and $timeoutRun.TerminateJobSucceeded -and
            $timeoutRun.RootProcessSignaled -and $timeoutRun.RootExitCode -eq 124 -and
            $timeoutRun.JobDrained -and $timeoutRun.ActiveProcessesAfterDrain -eq 0 -and
            $timeoutRootPidAbsentAfterDrain -and $timeoutGrandchildPidAbsentAfterDrain -and
            $timeoutRun.CleanupConfirmed -and -not $timeoutRun.OutputTruncated
        $safeResult.timeout = [ordered]@{
            status = if ($timeoutPass) { 'PASS' } else { 'FAIL' }
            child_ready = [bool]$timeoutReadiness.child_ready
            grandchild_ready = [bool]$timeoutReadiness.grandchild_ready
            grandchild_pid_valid = [bool]$timeoutReadiness.grandchild_pid_valid
            process_ids_distinct = [bool]$timeoutProcessIdsDistinct
            root_pid_valid = [bool]$timeoutRun.RootPidValid
            root_pid_absent_after_drain = [bool]$timeoutRootPidAbsentAfterDrain
            grandchild_pid_absent_after_drain = [bool]$timeoutGrandchildPidAbsentAfterDrain
            job_membership_verified = [bool]$timeoutRun.JobMembershipVerified
            timed_out = [bool]$timeoutRun.TimedOut
            terminate_job_succeeded = [bool]$timeoutRun.TerminateJobSucceeded
            root_exit_observed = [bool]$timeoutRun.RootProcessSignaled
            root_exit_code = $timeoutRun.RootExitCode
            active_processes_at_deadline = $timeoutRun.ActiveProcessesAtDeadline
            active_process_limit_query_succeeded = [bool]$timeoutRun.ActiveProcessLimitQuerySucceeded
            effective_active_process_limit_enabled = [bool]$timeoutRun.EffectiveActiveProcessLimitEnabled
            effective_active_process_limit = $timeoutRun.EffectiveActiveProcessLimit
            active_process_limit_query_error_code = $timeoutRun.ActiveProcessLimitQueryErrorCode
            job_accounting_query_succeeded = [bool]$timeoutRun.JobAccountingQuerySucceeded
            total_processes_at_deadline = $timeoutRun.TotalProcessesAtDeadline
            total_terminated_processes_at_deadline = $timeoutRun.TotalTerminatedProcessesAtDeadline
            job_accounting_query_error_code = $timeoutRun.JobAccountingQueryErrorCode
            accounting_excess_over_pid_list_count = $timeoutRun.AccountingExcessOverJobPidListCount
            accounting_excess_covered_by_termination_count = [bool]$timeoutRun.AccountingExcessCoveredByTerminationCount
            job_pid_list_query_succeeded = [bool]$timeoutRun.JobProcessIdListQuerySucceeded
            job_pid_list_complete = [bool]$timeoutRun.JobProcessIdListComplete
            job_pid_assigned_count = $timeoutRun.JobProcessIdAssignedCount
            job_pid_returned_count = $timeoutRun.JobProcessIdReturnedCount
            job_pid_list_query_error_code = $timeoutRun.JobProcessIdListQueryErrorCode
            root_pid_present_in_job_list = [bool]$timeoutRootPidPresent
            grandchild_pid_present_in_job_list = [bool]$timeoutGrandchildPidPresent
            job_pid_list_matches_expected = [bool]$timeoutJobPidListMatchesExpected
            active_process_limit_verified = [bool]$timeoutActiveProcessLimitVerified
            process_member_diagnostics_status = if (@('COMPLETE', 'MISMATCH', 'UNKNOWN') -ccontains [string]$timeoutRun.JobMemberDiagnosticsStatus) { [string]$timeoutRun.JobMemberDiagnosticsStatus } else { 'UNKNOWN' }
            process_member_job_set_stable = $timeoutRun.JobMemberJobSetStable
            process_member_open_count = $timeoutRun.JobMemberOpenCount
            process_member_membership_verified_count = $timeoutRun.JobMemberMembershipVerifiedCount
            process_member_not_in_job_count = $timeoutRun.JobMemberNotInJobCount
            process_member_membership_unknown_count = $timeoutRun.JobMemberMembershipUnknownCount
            process_member_node_image_count = $timeoutRun.JobMemberNodeImageCount
            process_member_console_host_image_count = $timeoutRun.JobMemberConsoleHostImageCount
            process_member_command_shell_image_count = $timeoutRun.JobMemberCommandShellImageCount
            process_member_other_image_count = $timeoutRun.JobMemberOtherImageCount
            process_member_image_unknown_count = $timeoutRun.JobMemberImageUnknownCount
            process_member_parent_id_matches_job_member_count = $timeoutRun.JobMemberParentIdMatchesJobMemberCount
            process_member_metadata_unknown_count = $timeoutRun.JobMemberMetadataUnknownCount
            job_drained = [bool]$timeoutRun.JobDrained
            active_processes_after_drain = $timeoutRun.ActiveProcessesAfterDrain
            cleanup_confirmed = [bool]$timeoutRun.CleanupConfirmed
            native_stage = if (@('PREFLIGHT', 'JOB_CREATE', 'JOB_LIST_PREPARE', 'PROCESS_CREATE', 'PROCESS_WAIT', 'JOB_DEADLINE_SNAPSHOT', 'JOB_TERMINATE') -ccontains [string]$timeoutRun.Stage) { [string]$timeoutRun.Stage } else { 'UNKNOWN' }
            native_error_code = if ($null -ne $timeoutRun.ErrorCode) { [int]$timeoutRun.ErrorCode } else { $null }
        }
        $safeResult.status = if ($normalPass -and $timeoutPass) { 'PASS' } else { 'FAIL' }
        $safeResult.reason = 'NONE'
    } catch {
        $safeResult.status = 'ERROR'
        $safeResult.reason = 'HOST_TEST_FAILED'
        $safeResult.failed_stage = $stage
        $safeResult.failure_hresult = if ($null -ne $_.Exception) { [int]$_.Exception.HResult } else { $null }
        if ($stage -ceq 'LAUNCHER_SOURCE_READ') {
            $safeResult.failure_substage = if (@('PATH_CONTAINMENT', 'REPARSE_ATTRIBUTES', 'FILE_OPEN',
                'BOUNDED_READ_HASH', 'UTF8_DECODE') -ccontains [string]$sourceReadDiagnostics['substage']) {
                [string]$sourceReadDiagnostics['substage']
            } else { 'UNKNOWN' }
        }
    }
    $stage = 'SERIALIZATION'
    try {
        $json = ConvertTo-Json -InputObject ([pscustomobject]$safeResult) -Depth 6 -Compress -ErrorAction Stop
    } catch {
        $failureHresult = if ($null -ne $_.Exception) { [int]$_.Exception.HResult } else { $null }
        $hresultJson = if ($null -eq $failureHresult) { 'null' } else { $failureHresult.ToString([System.Globalization.CultureInfo]::InvariantCulture) }
        $json = '{"schema_version":1,"status":"ERROR","reason":"HOST_TEST_FAILED","failed_stage":"SERIALIZATION","failure_hresult":' + $hresultJson + '}'
    }
    if ([System.Text.Encoding]::UTF8.GetByteCount($json) -gt 8192) {
        $json = '{"schema_version":1,"status":"ERROR","reason":"OUTPUT_LIMIT"}'
        [Console]::Out.Write($json + "`n")
        exit 1
    }
    [Console]::Out.Write($json + "`n")
    if ($safeResult.status -ceq 'PASS') { exit 0 }
    exit 1
}

function Add-ProbeAccessRule($Acl, [System.Security.Principal.SecurityIdentifier]$Sid,
    [System.Security.AccessControl.FileSystemRights]$Rights,
    [System.Security.AccessControl.InheritanceFlags]$Inheritance,
    [System.Security.AccessControl.PropagationFlags]$Propagation) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $Sid, $Rights, $Inheritance, $Propagation,
        [System.Security.AccessControl.AccessControlType]::Allow)
    $Acl.AddAccessRule($rule)
}

function Set-ProbeAcl([string]$Path, $AppSid,
    [System.Security.AccessControl.FileSystemRights]$AppRights, [bool]$AllowInheritance,
    [bool]$IncludeApp = $true) {
    $directory = [System.IO.DirectoryInfo]::new($Path)
    $acl = $directory.GetAccessControl()
    $acl.SetAccessRuleProtection($true, $false)
    $ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new(
        [System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($AllowInheritance) {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    Add-ProbeAccessRule $acl $ownerSid ([System.Security.AccessControl.FileSystemRights]::FullControl) $inheritance $propagation
    Add-ProbeAccessRule $acl $systemSid ([System.Security.AccessControl.FileSystemRights]::FullControl) $inheritance $propagation
    if ($IncludeApp) {
        Add-ProbeAccessRule $acl $AppSid $AppRights $inheritance $propagation
    }
    $instanceMethod = $directory.GetType().GetMethod('SetAccessControl')
    if ($null -ne $instanceMethod) {
        $directory.SetAccessControl($acl)
        return
    }

    Add-Type -AssemblyName System.IO.FileSystem.AccessControl -ErrorAction Stop
    $aclAssembly = [AppDomain]::CurrentDomain.GetAssemblies() |
        Where-Object { $_.GetName().Name -eq 'System.IO.FileSystem.AccessControl' } |
        Select-Object -First 1
    if ($null -eq $aclAssembly) {
        throw 'The filesystem ACL extension assembly is unavailable.'
    }
    $extensionType = $aclAssembly.GetType('System.IO.FileSystemAclExtensions', $false)
    if ($null -eq $extensionType) {
        throw 'The filesystem ACL extension type is unavailable.'
    }
    $methodFlags = [System.Reflection.BindingFlags]::Public -bor
        [System.Reflection.BindingFlags]::Static
    $extensionMethod = $null
    foreach ($method in $extensionType.GetMethods($methodFlags)) {
        $parameters = $method.GetParameters()
        if ($method.Name -eq 'SetAccessControl' -and $parameters.Length -eq 2 -and
            $parameters[0].ParameterType -eq [System.IO.DirectoryInfo] -and
            $parameters[1].ParameterType -eq [System.Security.AccessControl.DirectorySecurity]) {
            $extensionMethod = $method
            break
        }
    }
    if ($null -eq $extensionMethod) {
        throw 'The filesystem ACL SetAccessControl extension was unavailable.'
    }
    $null = $extensionMethod.Invoke($null, [object[]]@($directory, $acl))
}

function Convert-AppSidDaclSummary([string]$Label, [object[]]$AccessRules,
    [System.Security.Principal.SecurityIdentifier]$AppSid,
    [System.Security.AccessControl.FileSystemRights]$ExpectedRights) {
    $aces = @()
    $minimumMask = [int]$ExpectedRights
    $readTraverseMask = [int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    $minimumAllowAcePresent = $false
    $potentiallyConflictingDenyAcePresent = $false
    $readTraverseAllowAcePresent = $false
    foreach ($rule in $AccessRules) {
        $identitySid = $rule.IdentityReference
        if ($identitySid -isnot [System.Security.Principal.SecurityIdentifier]) {
            try { $identitySid = $identitySid.Translate([System.Security.Principal.SecurityIdentifier]) }
            catch { continue }
        }
        if ($identitySid.Value -cne $AppSid.Value) { continue }

        $rightsValue = [int]$rule.FileSystemRights
        $access = $rule.AccessControlType.ToString().ToLowerInvariant()
        $hasExpectedRights = ($rightsValue -band $minimumMask) -eq $minimumMask
        $hasReadTraverse = ($rightsValue -band $readTraverseMask) -eq $readTraverseMask
        if ($access -ceq 'allow' -and $hasExpectedRights) { $minimumAllowAcePresent = $true }
        if ($access -ceq 'deny' -and ($rightsValue -band $minimumMask) -ne 0) {
            $potentiallyConflictingDenyAcePresent = $true
        }
        if ($access -ceq 'allow' -and $hasReadTraverse) { $readTraverseAllowAcePresent = $true }
        $aces += [ordered]@{
            access = $access
            rights = ([System.Security.AccessControl.FileSystemRights]$rightsValue).ToString()
            rights_value = $rightsValue
            inherited = [bool]$rule.IsInherited
            inheritance = $rule.InheritanceFlags.ToString()
            inheritance_value = [int]$rule.InheritanceFlags
            propagation = $rule.PropagationFlags.ToString()
            propagation_value = [int]$rule.PropagationFlags
        }
    }

    return [ordered]@{
        label = $Label
        status = if ($minimumAllowAcePresent -and -not $potentiallyConflictingDenyAcePresent) { 'PASS' } else { 'FAIL' }
        expected_minimum_rights = $ExpectedRights.ToString()
        minimum_expected_allow_ace_present = $minimumAllowAcePresent
        potentially_conflicting_deny_ace_present = $potentiallyConflictingDenyAcePresent
        read_traverse_allow_ace_present = $readTraverseAllowAcePresent
        app_sid_ace_count = $aces.Count
        app_sid_aces = @($aces)
    }
}

function Get-AppSidDaclSummary([string]$Label, [string]$Path,
    [System.Security.Principal.SecurityIdentifier]$AppSid,
    [System.Security.AccessControl.FileSystemRights]$ExpectedRights) {
    try {
        if ([System.IO.Directory]::Exists($Path)) {
            $acl = [System.IO.DirectoryInfo]::new($Path).GetAccessControl()
        } elseif ([System.IO.File]::Exists($Path)) {
            $acl = [System.IO.FileInfo]::new($Path).GetAccessControl()
        } else {
            throw [System.IO.FileNotFoundException]::new('DACL target was not found.')
        }
        $accessRules = @($acl.Access)
        return (Convert-AppSidDaclSummary -Label $Label -AccessRules $accessRules `
            -AppSid $AppSid -ExpectedRights $ExpectedRights)
    } catch {
        $exceptionDetails = Get-SafeExceptionDiagnosticDetails $_
        return [ordered]@{
            label = $Label
            status = 'UNKNOWN'
            expected_minimum_rights = $ExpectedRights.ToString()
            minimum_expected_allow_ace_present = $false
            potentially_conflicting_deny_ace_present = $false
            read_traverse_allow_ace_present = $false
            app_sid_ace_count = 0
            app_sid_aces = @()
            diagnostic = 'DACL inspection failed; path and exception message are omitted.'
            exception_type = $exceptionDetails.exception_type
            exception_hresult = $exceptionDetails.hresult
            native_win32_code = $exceptionDetails.native_win32_code
        }
    }
}

function Test-ProfileBootstrapStagingAceExact($Summary, [string]$Label,
    [System.Security.AccessControl.FileSystemRights]$Rights, [bool]$Inherited,
    [System.Security.AccessControl.InheritanceFlags]$Inheritance,
    [System.Security.AccessControl.PropagationFlags]$Propagation) {
    try {
        $aces = @($Summary.app_sid_aces | Where-Object { $null -ne $_ })
        if ([int]$Summary.app_sid_ace_count -ne 1 -or $aces.Count -ne 1) { return $false }
        $ace = $aces[0]
        $requestedRights = [int]$Rights
        $allowedRights = $requestedRights -bor [int][System.Security.AccessControl.FileSystemRights]::Synchronize
        $observedRights = [int]$ace.rights_value
        $requestedRightsPresent = ($observedRights -band $requestedRights) -eq $requestedRights
        $rightsWithinAllowlist = ($observedRights -bor $allowedRights) -eq $allowedRights
        return ($ace.access -ceq 'allow' -and
            $requestedRightsPresent -and $rightsWithinAllowlist -and
            [bool]$ace.inherited -eq $Inherited -and
            [int]$ace.inheritance_value -eq [int]$Inheritance -and
            [int]$ace.propagation_value -eq [int]$Propagation)
    } catch {
        return $false
    }
}

function Get-ProfileBootstrapStagingAclStatus($StageRootSummary, $ToolsRootSummary, $StagedNodeSummary) {
    $toolsInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $expected = @(
        [pscustomobject]@{
            summary = $StageRootSummary
            label = 'stageRoot'
            rights = [System.Security.AccessControl.FileSystemRights]::Traverse
            inherited = $false
            inheritance = [System.Security.AccessControl.InheritanceFlags]::None
            propagation = [System.Security.AccessControl.PropagationFlags]::None
        },
        [pscustomobject]@{
            summary = $ToolsRootSummary
            label = 'toolsRoot'
            rights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
            inherited = $false
            inheritance = $toolsInheritance
            propagation = [System.Security.AccessControl.PropagationFlags]::None
        },
        [pscustomobject]@{
            summary = $StagedNodeSummary
            label = 'stagedNode'
            rights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
            inherited = $true
            inheritance = [System.Security.AccessControl.InheritanceFlags]::None
            propagation = [System.Security.AccessControl.PropagationFlags]::None
        }
    )
    foreach ($entry in $expected) {
        if ($null -eq $entry.summary -or $entry.summary.status -ceq 'UNKNOWN') { return 'UNKNOWN' }
        if ($entry.summary.label -cne $entry.label -or $entry.summary.status -cne 'PASS' -or
            -not $entry.summary.minimum_expected_allow_ace_present -or
            $entry.summary.potentially_conflicting_deny_ace_present -or
            -not (Test-ProfileBootstrapStagingAceExact $entry.summary $entry.label $entry.rights `
                $entry.inherited $entry.inheritance $entry.propagation)) { return 'FAIL' }
    }
    return 'PASS'
}

function Get-ProfileBootstrapStagingAclCleanupStatus($Attempted, $StageAbsent) {
    if (-not $Attempted) { return 'NOT_APPLIED' }
    if ($null -eq $StageAbsent -or -not $StageAbsent) { return 'NOT_CONFIRMED' }
    return 'REMOVED_WITH_STAGE'
}

function Set-ProfileBootstrapStagingAcl([string]$RunRoot, [string]$StageRoot, [string]$ToolsRoot,
    [string]$StagedNode, [string]$Nonce, [System.Security.Principal.SecurityIdentifier]$AppSid) {
    if ($Nonce -cnotmatch '^[0-9a-f]{32}$') { throw 'The staging ACL nonce is invalid.' }
    $canonicalRunRoot = Assert-NoReparsePath $RunRoot
    $canonicalStageRoot = Assert-ChildPath $canonicalRunRoot $StageRoot
    $canonicalToolsRoot = Assert-ChildPath $canonicalStageRoot $ToolsRoot
    $canonicalStagedNode = Assert-ChildPath $canonicalToolsRoot $StagedNode
    $expectedStageRoot = [System.IO.Path]::GetFullPath((Join-Path $canonicalRunRoot $Nonce))
    $expectedToolsRoot = [System.IO.Path]::GetFullPath((Join-Path $expectedStageRoot 'tools'))
    $expectedStagedNode = [System.IO.Path]::GetFullPath((Join-Path $expectedToolsRoot 'node.exe'))
    if (-not [string]::Equals($canonicalStageRoot, $expectedStageRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($canonicalToolsRoot, $expectedToolsRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($canonicalStagedNode, $expectedStagedNode, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Bootstrap ACL targets must be limited to nonce-owned staged Node paths.'
    }

    Set-ProbeAcl $canonicalStageRoot $AppSid ([System.Security.AccessControl.FileSystemRights]::Traverse) $false
    Set-ProbeAcl $canonicalToolsRoot $AppSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) $true
    $labels = @(
        (Get-AppSidDaclSummary 'stageRoot' $canonicalStageRoot $AppSid `
            ([System.Security.AccessControl.FileSystemRights]::Traverse)),
        (Get-AppSidDaclSummary 'toolsRoot' $canonicalToolsRoot $AppSid `
            ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)),
        (Get-AppSidDaclSummary 'stagedNode' $canonicalStagedNode $AppSid `
            ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute))
    )
    $status = Get-ProfileBootstrapStagingAclStatus $labels[0] $labels[1] $labels[2]
    return [ordered]@{
        attempted = $true
        status = $status
        scope = @(
            [ordered]@{ label = 'stageRoot'; rights = 'Traverse'; inheritance = 'none' },
            [ordered]@{ label = 'toolsRoot'; rights = 'ReadAndExecute'; inheritance = 'staged_files' },
            [ordered]@{ label = 'stagedNode'; rights = 'ReadAndExecute'; inheritance = 'inherited' }
        )
        labels = $labels
        cleanup_status = 'PENDING_STAGE_REMOVAL'
    }
}

function Get-DirectoryAncestorDescriptorInputs([string]$TargetPath, [string]$RunRoot,
    [string]$StageRoot, [string]$ToolsRoot) {
    $target = [System.IO.Path]::GetFullPath($TargetPath)
    $volumeRoot = [System.IO.Path]::GetPathRoot($target)
    $current = $volumeRoot
    $paths = [System.Collections.Generic.List[string]]::new()
    $paths.Add($current)
    $relative = $target.Substring($volumeRoot.Length).TrimEnd('\', '/')
    foreach ($component in ($relative -split '[\\/]' | Where-Object { $_ })) {
        $current = Join-Path $current $component
        $paths.Add($current)
    }

    $canonicalRunRoot = [System.IO.Path]::GetFullPath($RunRoot).TrimEnd('\', '/')
    $canonicalStageRoot = [System.IO.Path]::GetFullPath($StageRoot).TrimEnd('\', '/')
    $canonicalToolsRoot = [System.IO.Path]::GetFullPath($ToolsRoot).TrimEnd('\', '/')
    $labels = [System.Collections.Generic.List[string]]::new()
    $descriptors = [System.Collections.Generic.List[byte[]]]::new()
    $anonymousIndex = 0
    foreach ($path in $paths) {
        $canonicalPath = [System.IO.Path]::GetFullPath($path).TrimEnd('\', '/')
        if ($path -ceq $volumeRoot) {
            $label = 'volume_root'
        } elseif ($canonicalPath -ieq $canonicalRunRoot) {
            $label = 'runRoot'
        } elseif ($canonicalPath -ieq $canonicalStageRoot) {
            $label = 'stageRoot'
        } elseif ($canonicalPath -ieq $canonicalToolsRoot) {
            $label = 'toolsRoot'
        } else {
            $anonymousIndex++
            $label = 'ancestor_{0:D3}' -f $anonymousIndex
        }

        $descriptor = $null
        try {
            if ([System.IO.Directory]::Exists($path)) {
                $directorySecurity = [System.IO.DirectoryInfo]::new($path).GetAccessControl()
                $descriptor = [byte[]]$directorySecurity.GetSecurityDescriptorBinaryForm()
            }
        } catch { $descriptor = $null }
        $labels.Add($label)
        $descriptors.Add($descriptor)
    }
    return [pscustomobject]@{
        Labels = [string[]]$labels.ToArray()
        Descriptors = [byte[][]]$descriptors.ToArray()
    }
}

function Get-StagedFileDescriptorInputs([string]$WorkerModulePath, [string]$ProbeContractPath) {
    $labels = [System.Collections.Generic.List[string]]::new()
    $descriptors = [System.Collections.Generic.List[byte[]]]::new()
    foreach ($entry in @(
        [pscustomobject]@{ Label = 'workerModule'; Path = $WorkerModulePath },
        [pscustomobject]@{ Label = 'probeContract'; Path = $ProbeContractPath }
    )) {
        $descriptor = $null
        try {
            if ([System.IO.File]::Exists($entry.Path)) {
                $fileSecurity = [System.IO.FileInfo]::new($entry.Path).GetAccessControl()
                $descriptor = [byte[]]$fileSecurity.GetSecurityDescriptorBinaryForm()
            }
        } catch { $descriptor = $null }
        $labels.Add($entry.Label)
        $descriptors.Add($descriptor)
    }
    return [pscustomobject]@{
        Labels = [string[]]$labels.ToArray()
        Descriptors = [byte[][]]$descriptors.ToArray()
    }
}

function Get-SafeExceptionDiagnosticDetails($ErrorRecord) {
    $exception = $ErrorRecord.Exception
    $nativeCode = $null
    $current = $exception
    for ($depth = 0; $null -ne $current -and $depth -lt 5; $depth++) {
        if ($current -is [System.ComponentModel.Win32Exception]) {
            $nativeCode = [int]$current.NativeErrorCode
            break
        }
        $current = $current.InnerException
    }
    $hresultText = if ($null -eq $exception) { $null } else { '0x{0:X8}' -f [int]$exception.HResult }
    if ($null -eq $nativeCode -and $null -ne $hresultText -and $hresultText.StartsWith('0x8007', [StringComparison]::OrdinalIgnoreCase)) {
        $nativeCode = [Convert]::ToInt32($hresultText.Substring(6, 4), 16)
    }
    return [ordered]@{
        exception_type = if ($null -eq $exception) { $null } else { $exception.GetType().Name }
        hresult = $hresultText
        native_win32_code = $nativeCode
    }
}

function Assert-NoReparsePath([string]$Candidate) {
    $canonicalCandidate = [System.IO.Path]::GetFullPath($Candidate)
    $volumeRoot = [System.IO.Path]::GetPathRoot($canonicalCandidate)
    $relative = $canonicalCandidate.Substring($volumeRoot.Length)
    $current = $volumeRoot
    foreach ($component in ($relative -split '[\\/]' | Where-Object { $_ })) {
        $current = Join-Path $current $component
        try { $attributes = [System.IO.File]::GetAttributes($current) }
        catch [System.IO.FileNotFoundException] { break }
        catch [System.IO.DirectoryNotFoundException] { break }
        if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'Refusing to access a path containing a reparse point.'
        }
    }
    return $canonicalCandidate
}

function Assert-ChildPath([string]$Parent, [string]$Candidate) {
    $canonicalParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $canonicalCandidate = Assert-NoReparsePath $Candidate
    if (-not $canonicalCandidate.StartsWith($canonicalParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to access a generated path outside its designated root.'
    }
    return $canonicalCandidate
}

function Test-ProcessIdAbsent([int]$ProcessId) {
    if ($ProcessId -le 0) { return $false }
    try {
        $process = [System.Diagnostics.Process]::GetProcessById($ProcessId)
        try { return $process.HasExited } finally { $process.Dispose() }
    } catch [ArgumentException] {
        return $true
    } catch {
        return $false
    }
}

if ($ProcessTreeHostTestOnly) { Invoke-ProcessTreeHostTestMode }

function Get-CanonicalLocalDrivePath([string]$Path, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -cnotmatch '^[A-Za-z]:\\' -or $Path.IndexOf(':', 2) -ge 0) {
        throw ($Label + ' must be an absolute local drive path.')
    }
    $canonical = [System.IO.Path]::GetFullPath($Path)
    if (-not [string]::Equals($canonical.TrimEnd('\'), $Path.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw ($Label + ' must not use device, traversal, or noncanonical path syntax.')
    }
    return $canonical.TrimEnd('\')
}

function Get-ProfileBootstrapCandidatePath([bool]$CallerFullTrust, [string]$OwnerLocalAppData,
    [string]$ProfileName, [string]$Nonce) {
    if (-not $CallerFullTrust) { throw 'The profile bootstrap diagnostic requires a full-trust caller token.' }
    if ($Nonce -cnotmatch '^[0-9a-f]{32}$' -or $ProfileName -cne ('AgentCP' + $Nonce.Substring(0, 17))) {
        throw 'The generated profile bootstrap identity is invalid.'
    }
    $canonicalOwnerLocalAppData = Get-CanonicalLocalDrivePath $OwnerLocalAppData 'full-trust LocalApplicationData'
    if ($canonicalOwnerLocalAppData -match '\\Packages\\sandbox\.[^\\]+\\AC$') {
        throw 'The caller LocalApplicationData is a nested sandbox profile path.'
    }
    $candidatePath = Get-CanonicalLocalDrivePath `
        (Join-Path $canonicalOwnerLocalAppData ('Packages\' + $ProfileName + '\AC')) 'AppContainer profile candidate'
    $expectedSuffix = '\Packages\' + $ProfileName + '\AC'
    if (-not $candidatePath.EndsWith($expectedSuffix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The generated AppContainer profile candidate has an unexpected Packages/profile/AC shape.'
    }
    $candidateDirectory = [System.IO.DirectoryInfo]::new($candidatePath)
    if ($candidateDirectory.Name -cne 'AC' -or $null -eq $candidateDirectory.Parent -or
        $candidateDirectory.Parent.Name -cne $ProfileName -or $null -eq $candidateDirectory.Parent.Parent -or
        $candidateDirectory.Parent.Parent.Name -cne 'Packages') {
        throw 'The generated AppContainer profile candidate has an unexpected Packages/profile/AC shape.'
    }
    $null = Assert-NoReparsePath $candidatePath
    return $candidatePath
}

function Test-OrdinalIgnoreCasePathComponent([string]$Actual, [string]$Expected) {
    if ([string]::IsNullOrEmpty($Actual) -or [string]::IsNullOrEmpty($Expected)) { return $false }
    return [string]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase)
}

function Get-AppContainerProfilePackagesRoot([string]$ProfilePath, [string]$ProfileName) {
    if ([string]::IsNullOrWhiteSpace($ProfileName) -or $ProfileName -cnotmatch '^AgentCP[0-9a-f]{17}$') {
        throw 'The generated AppContainer profile name is invalid.'
    }
    $canonicalProfile = Get-CanonicalLocalDrivePath $ProfilePath 'AppContainer profile API path'
    $expectedSuffix = '\Packages\' + $ProfileName + '\AC'
    if (-not $canonicalProfile.EndsWith($expectedSuffix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The AppContainer profile API path has an unexpected Packages/profile/AC shape.'
    }
    $profileDirectory = [System.IO.DirectoryInfo]::new($canonicalProfile)
    if (-not (Test-OrdinalIgnoreCasePathComponent $profileDirectory.Name 'AC') -or
        $null -eq $profileDirectory.Parent -or
        -not (Test-OrdinalIgnoreCasePathComponent $profileDirectory.Parent.Name $ProfileName) -or
        $null -eq $profileDirectory.Parent.Parent -or
        -not (Test-OrdinalIgnoreCasePathComponent $profileDirectory.Parent.Parent.Name 'Packages')) {
        throw 'The AppContainer profile API path has an unexpected Packages/profile/AC shape.'
    }
    return Assert-NoReparsePath $profileDirectory.Parent.Parent.FullName
}

function Get-ProfileContractStagePaths([string]$ProfilePath, [string]$ProfileName, [string]$Nonce) {
    if ([string]::IsNullOrWhiteSpace($ProfilePath) -or $Nonce -cnotmatch '^[0-9a-f]{32}$' -or
        $ProfileName -cne ('AgentCP' + $Nonce.Substring(0, 17))) {
        throw 'The profile contract staging identity is invalid.'
    }
    $canonicalProfile = Get-CanonicalLocalDrivePath $ProfilePath 'AppContainer profile API path'
    $packagesRoot = Get-AppContainerProfilePackagesRoot $canonicalProfile $ProfileName
    $canonicalProfile = Assert-ChildPath $packagesRoot $canonicalProfile
    $canonicalProfile = Assert-NoReparsePath $canonicalProfile
    $tempPath = Assert-ChildPath $canonicalProfile (Join-Path $canonicalProfile 'Temp')
    $stageRoot = Assert-ChildPath $tempPath (Join-Path $tempPath ('profile-contract-' + $Nonce))
    $modulePath = Assert-ChildPath $stageRoot (Join-Path $stageRoot 'probe-contract.mjs')
    return [pscustomobject]@{
        ProfilePath = $canonicalProfile
        TempPath = $tempPath
        StageRoot = $stageRoot
        ModulePath = $modulePath
    }
}

function Get-ProfileRunStagePaths([string]$ProfilePath, [string]$ProfileName, [string]$Nonce) {
    if ([string]::IsNullOrWhiteSpace($ProfilePath) -or $Nonce -cnotmatch '^[0-9a-f]{32}$' -or
        $ProfileName -cne ('AgentCP' + $Nonce.Substring(0, 17))) {
        throw 'The per-run AppContainer staging identity is invalid.'
    }
    $canonicalProfile = Get-CanonicalLocalDrivePath $ProfilePath 'AppContainer profile API path'
    $packagesRoot = Get-AppContainerProfilePackagesRoot $canonicalProfile $ProfileName
    $canonicalProfile = Assert-ChildPath $packagesRoot $canonicalProfile
    $tempPath = Assert-ChildPath $canonicalProfile (Join-Path $canonicalProfile 'Temp')
    $stageRoot = Assert-ChildPath $tempPath (Join-Path $tempPath ('agentcp-run-' + $Nonce))
    return [pscustomobject]@{
        ProfilePath = $canonicalProfile
        TempPath = $tempPath
        StageRoot = $stageRoot
        ToolsRoot = Assert-ChildPath $stageRoot (Join-Path $stageRoot 'tools')
        WorkspaceRoot = Assert-ChildPath $stageRoot (Join-Path $stageRoot 'workspace')
        NodePath = Assert-ChildPath (Join-Path $stageRoot 'tools') (Join-Path (Join-Path $stageRoot 'tools') 'node.exe')
        WorkerPath = Assert-ChildPath (Join-Path $stageRoot 'tools') (Join-Path (Join-Path $stageRoot 'tools') 'worker.mjs')
        ProbeContractPath = Assert-ChildPath (Join-Path $stageRoot 'tools') (Join-Path (Join-Path $stageRoot 'tools') 'probe-contract.mjs')
        StdioSmokePath = Assert-ChildPath (Join-Path $stageRoot 'tools') (Join-Path (Join-Path $stageRoot 'tools') 'stdio-smoke.mjs')
    }
}

function Test-ProfileContractHashMatch([string]$ExpectedHash, [string]$ActualHash, [long]$Length) {
    if ($Length -lt 0 -or $Length -gt $script:profileContractDiagnosticMaxBytes -or
        $ExpectedHash -cnotmatch '^[0-9a-f]{64}$' -or $ActualHash -cnotmatch '^[0-9a-f]{64}$') { return $false }
    return [string]::Equals($ExpectedHash, $ActualHash, [StringComparison]::OrdinalIgnoreCase)
}

function Get-ProfileContractCleanupStatus($Requested, $Verified) {
    if (-not $Requested) { return 'NOT_RUN' }
    if ($null -eq $Verified) { return 'UNKNOWN' }
    if ($Verified) { return 'PASS' }
    return 'FAIL'
}

function Get-ProfileTempPreparationDecision([bool]$Exists, [bool]$IsDirectory) {
    if (-not $Exists) { return 'CREATE' }
    if ($IsDirectory) { return 'REUSE' }
    throw 'The AppContainer Temp path exists but is not an ordinary directory.'
}

function Get-ProfileTempCleanupStatus($Requested, $CreationAttempted, $CreatedByDiagnostic, $Verified) {
    if (-not $Requested) { return 'NOT_RUN' }
    if (-not $CreationAttempted) { return 'NOT_CREATED' }
    if ($null -eq $Verified) { return 'UNKNOWN' }
    if ($Verified) { return 'PASS' }
    return 'FAIL'
}

function Get-ProfileDeleteDecision($ProfilePreexisted, $ProfileOnly, $ProfilePathResolved,
    $ProfileLocalWritesAttempted, $StageCleanupVerified, $ProfileTempCreationAttempted,
    $ProfileTempCreatedByDiagnostic, $ProfileTempCleanupVerified) {
    if ($ProfilePreexisted) { return 'PRESERVE_PREEXISTING' }
    if ($ProfileOnly -and -not $ProfilePathResolved) { return 'PRESERVE_PROFILE_PATH_UNKNOWN' }
    if (-not $ProfileOnly) { return 'DELETE' }
    if (-not $ProfileLocalWritesAttempted) { return 'DELETE' }
    if ($null -eq $StageCleanupVerified) { return 'PRESERVE_STAGE_UNKNOWN' }
    if (-not $StageCleanupVerified) { return 'PRESERVE_STAGE_FAILED' }
    if (($ProfileTempCreationAttempted -or $ProfileTempCreatedByDiagnostic) -and $null -eq $ProfileTempCleanupVerified) {
        return 'PRESERVE_TEMP_UNKNOWN'
    }
    if (($ProfileTempCreationAttempted -or $ProfileTempCreatedByDiagnostic) -and -not $ProfileTempCleanupVerified) {
        return 'PRESERVE_TEMP_FAILED'
    }
    return 'DELETE'
}

function Get-ProfileRunDeleteDecision($ProfilePreexisted, $ProfilePathResolved,
    $ProfileTempPathValidated, $ProfileTempWasEmptyBefore, $NonceStageAbsentBefore,
    $StageCleanupVerified, $ProfileTempCleanupRequired, $ProfileTempCreatedByDiagnostic,
    $ProfileTempCleanupVerified) {
    if ($ProfilePreexisted) { return 'PRESERVE_PREEXISTING' }
    if (-not $ProfilePathResolved) { return 'PRESERVE_PROFILE_PATH_UNKNOWN' }
    if (-not $ProfileTempPathValidated) { return 'PRESERVE_TEMP_PATH_UNKNOWN' }
    if ($null -eq $ProfileTempWasEmptyBefore) { return 'PRESERVE_TEMP_PREFLIGHT_UNKNOWN' }
    if (-not $ProfileTempWasEmptyBefore) { return 'PRESERVE_TEMP_PREFLIGHT_FAILED' }
    if ($null -eq $NonceStageAbsentBefore) { return 'PRESERVE_STAGE_PREFLIGHT_UNKNOWN' }
    if (-not $NonceStageAbsentBefore) { return 'PRESERVE_STAGE_PREFLIGHT_FAILED' }
    return Get-ProfileDeleteDecision $false $true $true $true $StageCleanupVerified `
        $ProfileTempCleanupRequired $ProfileTempCreatedByDiagnostic $ProfileTempCleanupVerified
}

function Get-ProfileBootstrapDeleteDecision($ProfilePreexisted, $CandidateValidated, $ProfileSidMatchesName,
    $LaunchEvidenceComplete, $CleanupVerified) {
    if ($ProfilePreexisted) { return 'PRESERVE_PREEXISTING' }
    if (-not $CandidateValidated) { return 'PRESERVE_CANDIDATE_UNKNOWN' }
    if ($null -eq $ProfileSidMatchesName) { return 'PRESERVE_SID_UNKNOWN' }
    if (-not $ProfileSidMatchesName) { return 'PRESERVE_SID_MISMATCH' }
    if (-not $LaunchEvidenceComplete) { return 'PRESERVE_LAUNCH_UNKNOWN' }
    if ($null -eq $CleanupVerified) { return 'PRESERVE_CLEANUP_UNKNOWN' }
    if (-not $CleanupVerified) { return 'PRESERVE_CLEANUP_FAILED' }
    return 'DELETE'
}

function Get-ProfileCleanupGateStatus([string]$DeleteDecision) {
    if ($DeleteDecision -eq 'DELETE') { return 'NOT_RUN' }
    if ($DeleteDecision -in @('PRESERVE_STAGE_FAILED', 'PRESERVE_TEMP_FAILED',
            'PRESERVE_TEMP_PREFLIGHT_FAILED', 'PRESERVE_STAGE_PREFLIGHT_FAILED',
            'PRESERVE_CLEANUP_FAILED', 'PRESERVE_SID_MISMATCH')) { return 'FAIL' }
    return 'UNKNOWN'
}

function Get-ProfileMappingValueObservation([Microsoft.Win32.RegistryKey]$Key, [string]$ValueName) {
    $read = [AppContainerLauncher]::ReadBoundedProfileMappingString($Key, $ValueName)
    return [pscustomobject]@{
        status = [string]$read.Status
        present = ([string]$read.Status -cne 'MISSING')
        string_value = ([string]$read.Status -ceq 'READ')
        value = if ([string]$read.Status -ceq 'READ') { [string]$read.Value } else { $null }
    }
}

function Get-ProfileMappingPairSummary([object[]]$Pairs, [string]$ProfileName) {
    $summary = [ordered]@{
        complete_match_count = 0
        partial_match_count = 0
        case_only_pair_count = 0
        display_name_exact_match_count = 0
        display_name_case_only_match_count = 0
        moniker_exact_match_count = 0
        moniker_case_only_match_count = 0
        partial_missing_pair_count = 0
        partial_different_pair_count = 0
        malformed_value_count = 0
    }
    foreach ($pair in $Pairs) {
        $displayStatus = [string]$pair.displayName.status
        $monikerStatus = [string]$pair.moniker.status
        if (($displayStatus -cnotin @('READ', 'MISSING')) -or
            ($monikerStatus -cnotin @('READ', 'MISSING')) -or
            ($displayStatus -ceq 'READ' -and $pair.displayName.value -isnot [string]) -or
            ($monikerStatus -ceq 'READ' -and $pair.moniker.value -isnot [string])) {
            $summary.malformed_value_count++
            continue
        }

        $displayExact = $displayStatus -ceq 'READ' -and
            [string]::Equals([string]$pair.displayName.value, $ProfileName, [System.StringComparison]::Ordinal)
        $monikerExact = $monikerStatus -ceq 'READ' -and
            [string]::Equals([string]$pair.moniker.value, $ProfileName, [System.StringComparison]::Ordinal)
        $displayIgnoreCase = $displayStatus -ceq 'READ' -and
            [string]::Equals([string]$pair.displayName.value, $ProfileName, [System.StringComparison]::OrdinalIgnoreCase)
        $monikerIgnoreCase = $monikerStatus -ceq 'READ' -and
            [string]::Equals([string]$pair.moniker.value, $ProfileName, [System.StringComparison]::OrdinalIgnoreCase)

        if ($displayExact) { $summary.display_name_exact_match_count++ }
        elseif ($displayIgnoreCase) { $summary.display_name_case_only_match_count++ }
        if ($monikerExact) { $summary.moniker_exact_match_count++ }
        elseif ($monikerIgnoreCase) { $summary.moniker_case_only_match_count++ }

        $caseOnlyPair = $displayStatus -ceq 'READ' -and $monikerStatus -ceq 'READ' -and
            $displayIgnoreCase -and $monikerIgnoreCase -and -not ($displayExact -and $monikerExact)
        $partialMissingPair = ($displayStatus -ceq 'MISSING' -and $monikerStatus -ceq 'READ' -and $monikerIgnoreCase) -or
            ($monikerStatus -ceq 'MISSING' -and $displayStatus -ceq 'READ' -and $displayIgnoreCase)
        $partialDifferentPair = $displayStatus -ceq 'READ' -and $monikerStatus -ceq 'READ' -and
            ($displayIgnoreCase -xor $monikerIgnoreCase)

        if ($displayExact -and $monikerExact) {
            $summary.complete_match_count++
        } elseif ($caseOnlyPair -or $partialMissingPair -or $partialDifferentPair) {
            $summary.partial_match_count++
        }
        if ($caseOnlyPair) {
            $summary.case_only_pair_count++
        }
        if ($partialMissingPair) {
            $summary.partial_missing_pair_count++
        }
        if ($partialDifferentPair) {
            $summary.partial_different_pair_count++
        }
    }
    return [pscustomobject]$summary
}

function Set-ProfileMappingScanException($Scan, [string]$Phase, [System.Exception]$Exception) {
    $Scan.status = 'UNKNOWN'
    $Scan.scan_complete = $false
    $Scan.issue = 'READ_FAILED'
    $Scan.failure_phase = $Phase
    $exception = $Exception.GetBaseException()
    $allowedExceptionTypes = @('UnauthorizedAccessException', 'SecurityException', 'IOException',
        'Win32Exception', 'ArgumentException', 'InvalidOperationException', 'RuntimeException')
    $exceptionType = $exception.GetType().Name
    $Scan.failure_type = if ($exceptionType -cin $allowedExceptionTypes) { $exceptionType } else { 'OTHER' }
    $Scan.failure_code = if ($null -ne $exception.HResult) { [int]$exception.HResult } else { $null }
}

function Invoke-ProfileMappingSelfTestFailure([string]$Phase, [bool]$Cleanup) {
    if (-not $SelfTest -or -not $script:profileMappingSelfTestActive) { return }
    $selected = if ($Cleanup) { $script:profileMappingSelfTestCleanupFailure } else { $script:profileMappingSelfTestFailurePhase }
    if ($selected -ceq $Phase) {
        throw $script:profileMappingSelfTestException
    }
}

function Get-AppContainerProfileMappingScan([string]$ProfileName, [switch]$ReadOnlyDetails) {
    $scanData = [ordered]@{
        status = 'UNKNOWN'
        scan_complete = $false
        keys_visited = 0
        complete_match_count = 0
        partial_match_count = 0
        case_only_pair_count = 0
        partial_missing_pair_count = 0
        partial_different_pair_count = 0
        malformed_value_count = 0
        stability_status = 'UNKNOWN'
        issue = 'UNKNOWN'
        failure_phase = 'NONE'
        failure_type = $null
        failure_code = $null
    }
    if ($ReadOnlyDetails) {
        $scanData.display_name_exact_match_count = 0
        $scanData.display_name_case_only_match_count = 0
        $scanData.moniker_exact_match_count = 0
        $scanData.moniker_case_only_match_count = 0
    }
    $scan = [pscustomobject]$scanData
    if ($ProfileName -cnotmatch '^AgentCP[0-9a-f]{17}$') {
        $scan.issue = 'INVALID_PROFILE_ID'
        return $scan
    }

    $root = $null
    $pathStack = $null
    $changeMonitor = $null
    $failurePhase = 'NONE'
    $syntheticScan = [bool]($SelfTest -and $script:profileMappingSelfTestActive)
    try {
        $failurePhase = 'ROOT'
        Invoke-ProfileMappingSelfTestFailure $failurePhase $false
        if ($syntheticScan) {
            $syntheticChild = [pscustomobject]@{}
            $syntheticChild | Add-Member -MemberType ScriptMethod -Name Close -Value {}
            $root = [pscustomobject]@{ child = $syntheticChild }
            $root | Add-Member -MemberType ScriptMethod -Name Close -Value {}
            $root | Add-Member -MemberType ScriptMethod -Name OpenSubKey -Value { param($Part, $Writable) return $this.child }
        } else {
            $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($profileMappingRegistrySubKey, $false)
        }
        if ($null -eq $root) {
            $scan.issue = 'ROOT_UNAVAILABLE'
            return $scan
        }
        $failurePhase = 'MONITOR'
        Invoke-ProfileMappingSelfTestFailure $failurePhase $false
        if ($syntheticScan) {
            $changeMonitor = [pscustomobject]@{ Status = 'READY' }
            $changeMonitor | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
        } else {
            $changeMonitor = [AppContainerLauncher]::BeginProfileMappingScanChangeMonitor($root)
        }
        if ($null -eq $changeMonitor -or $changeMonitor.Status -cne 'READY') {
            $scan.issue = 'CHANGE_MONITOR_UNKNOWN'
            return $scan
        }
        $failurePhase = 'STACK'
        Invoke-ProfileMappingSelfTestFailure $failurePhase $false
        $pathStack = [System.Collections.Stack]::new()
        if ($syntheticScan) { $pathStack.Push([string[]]@('synthetic')) }
        else { $pathStack.Push([string[]]@()) }
        $scan.issue = 'NONE'

        while ($pathStack.Count -gt 0) {
            if ($scan.keys_visited -ge $profileMappingMaxKeys) {
                $scan.issue = 'KEY_LIMIT'
                break
            }
            $failurePhase = 'STACK'
            Invoke-ProfileMappingSelfTestFailure $failurePhase $false
            $relativePath = [string[]]$pathStack.Pop()
            $currentKey = $root
            try {
                foreach ($part in $relativePath) {
                    $failurePhase = 'OPEN_CHILD'
                    Invoke-ProfileMappingSelfTestFailure $failurePhase $false
                    $nextKey = $currentKey.OpenSubKey($part, $false)
                    if ($null -eq $nextKey) {
                        $scan.issue = 'KEY_UNAVAILABLE'
                        break
                    }
                    if (-not [object]::ReferenceEquals($currentKey, $root)) { $currentKey.Close() }
                    $currentKey = $nextKey
                }
                if ($scan.issue -cne 'NONE') { break }
                $scan.keys_visited++

                $failurePhase = 'VALUE'
                Invoke-ProfileMappingSelfTestFailure $failurePhase $false
                if ($syntheticScan) {
                    $displayName = [pscustomobject]@{ status = 'READ'; value = $ProfileName }
                    $moniker = [pscustomobject]@{ status = 'READ'; value = $ProfileName }
                } else {
                    $displayName = Get-ProfileMappingValueObservation $currentKey 'DisplayName'
                    $moniker = Get-ProfileMappingValueObservation $currentKey 'Moniker'
                }
                $pairSummary = Get-ProfileMappingPairSummary -Pairs @([pscustomobject]@{
                    displayName = $displayName
                    moniker = $moniker
                }) -ProfileName $ProfileName
                $scan.complete_match_count += [int]$pairSummary.complete_match_count
                $scan.partial_match_count += [int]$pairSummary.partial_match_count
                $scan.case_only_pair_count += [int]$pairSummary.case_only_pair_count
                if ($ReadOnlyDetails) {
                    $scan.display_name_exact_match_count += [int]$pairSummary.display_name_exact_match_count
                    $scan.display_name_case_only_match_count += [int]$pairSummary.display_name_case_only_match_count
                    $scan.moniker_exact_match_count += [int]$pairSummary.moniker_exact_match_count
                    $scan.moniker_case_only_match_count += [int]$pairSummary.moniker_case_only_match_count
                }
                $scan.partial_missing_pair_count += [int]$pairSummary.partial_missing_pair_count
                $scan.partial_different_pair_count += [int]$pairSummary.partial_different_pair_count
                $scan.malformed_value_count += [int]$pairSummary.malformed_value_count
                if ($pairSummary.malformed_value_count -gt 0) {
                    $scan.issue = 'VALUE_UNKNOWN'
                    break
                }

                if ($relativePath.Count -ge $profileMappingMaxDepth) {
                    $failurePhase = 'ENUMERATE'
                    Invoke-ProfileMappingSelfTestFailure $failurePhase $false
                    $depthProbe = if ($syntheticScan) { [pscustomobject]@{ Status = 'END' } }
                        else { [AppContainerLauncher]::EnumerateProfileMappingChildName($currentKey, 0) }
                    if ($depthProbe.Status -ceq 'END') { continue }
                    if ($depthProbe.Status -ceq 'NAME') { $scan.issue = 'DEPTH_LIMIT' }
                    else { $scan.issue = 'CHILD_ENUMERATION_UNKNOWN' }
                    break
                }

                $remainingKeys = $profileMappingMaxKeys - $scan.keys_visited - $pathStack.Count
                if ($remainingKeys -lt 0) {
                    $scan.issue = 'KEY_LIMIT'
                    break
                }
                for ($childIndex = 0; $childIndex -le $remainingKeys; $childIndex++) {
                    $failurePhase = 'ENUMERATE'
                    Invoke-ProfileMappingSelfTestFailure $failurePhase $false
                    $childResult = if ($syntheticScan) { [pscustomobject]@{ Status = 'END' } }
                        else { [AppContainerLauncher]::EnumerateProfileMappingChildName($currentKey, [uint32]$childIndex) }
                    $childDecision = [AppContainerLauncher]::ClassifyProfileMappingChildEnumerationResult(
                        [string]$childResult.Status, $childIndex, $remainingKeys)
                    if ($childDecision -ceq 'END') { break }
                    if ($childDecision -ceq 'KEY_LIMIT') {
                        $scan.issue = 'KEY_LIMIT'
                        break
                    }
                    if ($childDecision -cne 'NAME') {
                        $scan.issue = 'CHILD_ENUMERATION_UNKNOWN'
                        break
                    }
                    $childPath = @($relativePath) + @([string]$childResult.Name)
                    $failurePhase = 'STACK'
                    Invoke-ProfileMappingSelfTestFailure $failurePhase $false
                    $pathStack.Push([string[]]$childPath)
                }
                if ($scan.issue -cne 'NONE') { break }
            } finally {
                if (-not [object]::ReferenceEquals($currentKey, $root)) {
                    try {
                        Invoke-ProfileMappingSelfTestFailure 'OPEN_CHILD' $true
                        $currentKey.Close()
                    } catch {
                        $failurePhase = 'OPEN_CHILD'
                        throw
                    }
                }
            }
        }

        if ($scan.issue -ceq 'NONE' -and $scan.malformed_value_count -eq 0) {
            $failurePhase = 'STABILITY'
            Invoke-ProfileMappingSelfTestFailure $failurePhase $false
            $scan.stability_status = if ($syntheticScan) { 'STABLE' }
                else { [AppContainerLauncher]::CheckProfileMappingScanStability($root, $changeMonitor) }
            if ($scan.stability_status -ceq 'STABLE') {
                $scan.status = 'COMPLETE'
                $scan.scan_complete = $true
            } else {
                $scan.issue = 'REGISTRY_CHANGED'
            }
        } elseif ($scan.issue -ceq 'NONE') {
            $scan.issue = 'MALFORMED_VALUE'
        }
    } catch {
        Set-ProfileMappingScanException $scan $failurePhase $_.Exception
    } finally {
        if ($null -ne $changeMonitor) {
            try {
                Invoke-ProfileMappingSelfTestFailure 'MONITOR' $true
                $changeMonitor.Dispose()
            } catch { Set-ProfileMappingScanException $scan 'MONITOR' $_.Exception }
        }
        if ($null -ne $root) {
            try {
                Invoke-ProfileMappingSelfTestFailure 'ROOT' $true
                $root.Close()
            } catch { Set-ProfileMappingScanException $scan 'ROOT' $_.Exception }
        }
    }
    return $scan
}

function Get-ProfileRegistrationScanCounts($Scan) {
    $countNames = @(
        'complete_match_count', 'partial_match_count', 'case_only_pair_count',
        'partial_missing_pair_count', 'partial_different_pair_count', 'malformed_value_count'
    )
    $counts = [ordered]@{}
    foreach ($name in $countNames) {
        $property = $Scan.PSObject.Properties[$name]
        if ($null -eq $property -or $property.Value -isnot [int]) { return $null }
        $counts[$name] = [int]$property.Value
    }
    return [pscustomobject]$counts
}

function Test-ProfileRegistrationScanCountsConsistent($Counts) {
    if ($null -eq $Counts) { return $false }
    $completeMatches = [long]$Counts.complete_match_count
    $partialMatches = [long]$Counts.partial_match_count
    $caseOnlyPairs = [long]$Counts.case_only_pair_count
    $missingPairs = [long]$Counts.partial_missing_pair_count
    $differentPairs = [long]$Counts.partial_different_pair_count
    $malformedValues = [long]$Counts.malformed_value_count
    if ($completeMatches -lt 0 -or $partialMatches -lt 0 -or $caseOnlyPairs -lt 0 -or
        $missingPairs -lt 0 -or $differentPairs -lt 0 -or $malformedValues -lt 0) { return $false }
    return $partialMatches -eq ($caseOnlyPairs + $missingPairs + $differentPairs)
}

function Get-ProfileRegistrationPreDeleteDecision($Scan) {
    if ($null -eq $Scan -or $Scan.status -cne 'COMPLETE' -or -not $Scan.scan_complete -or
        $Scan.stability_status -cne 'STABLE') { return 'UNKNOWN' }
    $counts = Get-ProfileRegistrationScanCounts $Scan
    if (-not (Test-ProfileRegistrationScanCountsConsistent $counts)) { return 'UNKNOWN' }
    if ($counts.malformed_value_count -ne 0 -or $counts.partial_missing_pair_count -ne 0 -or
        $counts.partial_different_pair_count -ne 0) { return 'UNKNOWN' }
    $identityCount = [long]$counts.complete_match_count + [long]$counts.case_only_pair_count
    if ($identityCount -ne 1) { return 'UNKNOWN' }
    return 'PASS'
}

function Get-ProfileRegistrationPostDeleteDecision($Scan) {
    if ($null -eq $Scan -or $Scan.status -cne 'COMPLETE' -or -not $Scan.scan_complete -or
        $Scan.stability_status -cne 'STABLE') { return 'UNKNOWN' }
    $counts = Get-ProfileRegistrationScanCounts $Scan
    if (-not (Test-ProfileRegistrationScanCountsConsistent $counts) -or
        $counts.malformed_value_count -ne 0) { return 'UNKNOWN' }
    if ($counts.complete_match_count -gt 0 -or $counts.case_only_pair_count -gt 0 -or
        $counts.partial_match_count -gt 0) { return 'FAIL' }
    return 'PASS'
}

function Ensure-SafeDirectory([string]$Parent, [string]$Candidate) {
    $canonicalParent = Assert-NoReparsePath $Parent
    $canonicalCandidate = Assert-ChildPath $canonicalParent $Candidate
    if (Test-Path -LiteralPath $canonicalCandidate) {
        $existing = Get-Item -LiteralPath $canonicalCandidate -Force
        if (-not $existing.PSIsContainer) { throw 'A generated directory path is occupied by a non-directory.' }
        return $canonicalCandidate
    }
    [System.IO.Directory]::CreateDirectory($canonicalCandidate) | Out-Null
    $verified = Assert-ChildPath $canonicalParent $canonicalCandidate
    $created = Get-Item -LiteralPath $verified -Force
    if (-not $created.PSIsContainer) { throw 'A generated directory was not created as an ordinary directory.' }
    return $verified
}

function New-SafeDirectory([string]$Parent, [string]$Candidate, [ref]$Created) {
    $canonicalParent = Assert-NoReparsePath $Parent
    $canonicalCandidate = Assert-ChildPath $canonicalParent $Candidate
    if (Test-Path -LiteralPath $canonicalCandidate) {
        throw 'A nonce-scoped generated directory already exists.'
    }
    [System.IO.Directory]::CreateDirectory($canonicalCandidate) | Out-Null
    $Created.Value = $true
    $verified = Assert-ChildPath $canonicalParent $canonicalCandidate
    $createdItem = Get-Item -LiteralPath $verified -Force
    if (-not $createdItem.PSIsContainer) { throw 'A generated directory was not created as an ordinary directory.' }
    return $verified
}

function Test-SafePathAbsent([string]$Parent, [string]$Candidate) {
    $canonical = Assert-ChildPath $Parent $Candidate
    try {
        $null = [System.IO.File]::GetAttributes($canonical)
        return $false
    } catch [System.IO.FileNotFoundException] {
        return $true
    } catch [System.IO.DirectoryNotFoundException] {
        return $true
    }
}

function Test-BackupPlaceholder([string]$Parent, [string]$Candidate, [byte[]]$ExpectedBytes) {
    $canonical = Assert-ChildPath $Parent $Candidate
    $attributes = [System.IO.File]::GetAttributes($canonical)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        return $false
    }
    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new($canonical, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        if ($stream.Length -ne $ExpectedBytes.Length) { return $false }
        $actual = [byte[]]::new($ExpectedBytes.Length)
        $offset = 0
        while ($offset -lt $actual.Length) {
            $read = $stream.Read($actual, $offset, $actual.Length - $offset)
            if ($read -le 0) { return $false }
            $offset += $read
        }
        return Test-ExactByteSequence $actual $ExpectedBytes
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Test-ExactByteSequence([byte[]]$Actual, [byte[]]$Expected) {
    if ($null -eq $Actual -or $null -eq $Expected -or $Actual.Length -ne $Expected.Length) { return $false }
    for ($index = 0; $index -lt $Actual.Length; $index++) {
        if ($Actual[$index] -ne $Expected[$index]) { return $false }
    }
    return $true
}

function Assert-OrdinaryOwnedReport([string]$Path) {
    $canonical = Assert-ChildPath $diagnosticsRoot $Path
    if (-not (Test-Path -LiteralPath $canonical)) { return $false }
    $item = Get-Item -LiteralPath $canonical -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The existing report is not an ordinary file.'
    }
    $existing = [System.IO.File]::ReadAllText($canonical, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    if ($existing.generated_by -ne 'bench/isolation/run-probes.ps1' -or $existing.schema_version -ne 1) {
        throw 'Refusing to replace a report not owned by this generator.'
    }
    return $true
}

function Remove-SafeTree([string]$Parent, [string]$Candidate) {
    $canonical = Assert-ChildPath $Parent $Candidate
    if (-not (Test-Path -LiteralPath $canonical)) { return }
    $item = Get-Item -LiteralPath $canonical -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing to remove a tree containing a reparse point.'
    }
    if ($item.PSIsContainer) {
        foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($canonical)) {
            Remove-SafeTree $canonical $entry
        }
        $null = Assert-ChildPath $Parent $canonical
        [System.IO.Directory]::Delete($canonical, $false)
    } else {
        $null = Assert-ChildPath $Parent $canonical
        [System.IO.File]::Delete($canonical)
    }
}

function Remove-SafeTemporaryFile([string]$Parent, [string]$Candidate) {
    if (Test-SafePathAbsent $Parent $Candidate) { return }
    $canonical = Assert-ChildPath $Parent $Candidate
    $attributes = [System.IO.File]::GetAttributes($canonical)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The temporary report is not an ordinary file.'
    }
    [System.IO.File]::Delete($canonical)
    if (-not (Test-SafePathAbsent $Parent $canonical)) {
        throw 'Temporary report absence could not be confirmed.'
    }
}

function Copy-SafeFile([string]$Source, [string]$DestinationRoot, [string]$Destination) {
    $canonicalSource = Assert-RegularFile $Source
    $canonicalDestination = Assert-ChildPath $DestinationRoot $Destination
    if (Test-Path -LiteralPath $canonicalDestination) {
        throw 'A staged file destination already exists.'
    }
    $inputStream = $null
    $outputStream = $null
    try {
        $inputStream = [System.IO.FileStream]::new($canonicalSource, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $null = Assert-ChildPath $DestinationRoot $canonicalDestination
        $outputStream = [System.IO.FileStream]::new($canonicalDestination, [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $inputStream.CopyTo($outputStream)
        $outputStream.Flush($true)
    } finally {
        if ($null -ne $outputStream) { $outputStream.Dispose() }
        if ($null -ne $inputStream) { $inputStream.Dispose() }
    }
    $attributes = [System.IO.File]::GetAttributes((Assert-ChildPath $DestinationRoot $canonicalDestination))
    if (($attributes -band [System.IO.FileAttributes]::Directory) -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A staged file is not an ordinary file.'
    }
}

function Write-SafeReport([string]$Path) {
    $null = Assert-ChildPath $diagnosticsRoot $Path
    $ownedExisting = Assert-OrdinaryOwnedReport $Path
    $temporaryPath = Join-Path $diagnosticsRoot ('.appcontainer-probe-report.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $backupPath = $null
    $backupMarkerBytes = $null
    if ($ownedExisting) {
        $backupPath = Join-Path $diagnosticsRoot ('.appcontainer-probe-report.' + [Guid]::NewGuid().ToString('N') + '.bak')
        $backupMarkerBytes = [System.Text.UTF8Encoding]::new($false).GetBytes('appcontainer-report-backup:' + [Guid]::NewGuid().ToString('N'))
    }
    $null = Assert-ChildPath $diagnosticsRoot $temporaryPath
    if ($null -ne $backupPath) { $null = Assert-ChildPath $diagnosticsRoot $backupPath }
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes((($report | ConvertTo-Json -Depth 8) + "`n"))
    $stream = $null
    $temporaryCreated = $false
    $backupPlaceholderCreated = $false
    $backupReportCreated = $false
    $script:reportWriteTempCleanupStatus = 'NOT_CREATED'
    $script:reportWriteTempCleanupFailure = $null
    $script:reportWriteBackupCleanupStatus = if ($ownedExisting) { 'NOT_CREATED' } else { 'NOT_USED' }
    $script:reportWriteBackupCleanupFailure = $null
    try {
        $null = Assert-ChildPath $diagnosticsRoot $temporaryPath
        $stream = [System.IO.FileStream]::new($temporaryPath, [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $temporaryCreated = $true
        $script:reportWriteTempCleanupStatus = 'PENDING'
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        $null = Assert-ChildPath $diagnosticsRoot $temporaryPath
        if ($ownedExisting) {
            $null = Assert-OrdinaryOwnedReport $Path
            if (-not (Test-SafePathAbsent $diagnosticsRoot $backupPath)) {
                throw 'The unique report backup path is already occupied.'
            }
            $null = Assert-ChildPath $diagnosticsRoot $backupPath
            $backupStream = $null
            try {
                $backupStream = [System.IO.FileStream]::new($backupPath, [System.IO.FileMode]::CreateNew,
                    [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                $backupPlaceholderCreated = $true
                $script:reportWriteBackupCleanupStatus = 'PENDING'
                $backupStream.Write($backupMarkerBytes, 0, $backupMarkerBytes.Length)
                $backupStream.Flush($true)
            } finally {
                if ($null -ne $backupStream) { $backupStream.Dispose() }
            }
            $null = Assert-ChildPath $diagnosticsRoot $backupPath
            if (-not (Test-BackupPlaceholder $diagnosticsRoot $backupPath $backupMarkerBytes)) {
                throw 'The unique report backup placeholder could not be verified.'
            }
            $null = Assert-OrdinaryOwnedReport $Path
            [System.IO.File]::Replace($temporaryPath, $Path, $backupPath)
            $backupPlaceholderCreated = $false
            $backupReportCreated = $true
            $script:reportWriteBackupCleanupStatus = 'PENDING'
        } else {
            [System.IO.File]::Move($temporaryPath, $Path)
        }
        $temporaryCreated = $false
        $null = Assert-OrdinaryOwnedReport $Path
    } finally {
        $disposeFailure = $null
        if ($null -ne $stream) {
            try { $stream.Dispose() } catch { $disposeFailure = $_.Exception }
        }
        try {
            if ($temporaryCreated) {
                Remove-SafeTemporaryFile $diagnosticsRoot $temporaryPath
                $temporaryCreated = $false
            }
            $tempAbsent = Test-SafePathAbsent $diagnosticsRoot $temporaryPath
            if ($tempAbsent) { $script:reportWriteTempCleanupStatus = 'PASS' }
            else { $script:reportWriteTempCleanupStatus = 'UNKNOWN' }
        } catch {
            $script:reportWriteTempCleanupStatus = 'FAIL'
            $script:reportWriteTempCleanupFailure = $_.Exception
            if ($null -eq $disposeFailure) { $disposeFailure = $_.Exception }
        }
        try {
            if ($null -eq $backupPath) {
                $script:reportWriteBackupCleanupStatus = 'NOT_USED'
            } else {
                $backupPresent = -not (Test-SafePathAbsent $diagnosticsRoot $backupPath)
                if ($backupPlaceholderCreated -and $backupPresent) {
                    $placeholderVerified = Test-BackupPlaceholder $diagnosticsRoot $backupPath $backupMarkerBytes
                    if ($placeholderVerified) {
                        Remove-SafeTemporaryFile $diagnosticsRoot $backupPath
                    } elseif (Assert-OrdinaryOwnedReport $backupPath) {
                        $backupPlaceholderCreated = $false
                        $backupReportCreated = $true
                    } else {
                        throw 'The report backup is neither the owned placeholder nor a generator-owned report.'
                    }
                } elseif ($backupPlaceholderCreated) {
                    $backupPlaceholderCreated = $false
                }
                if ($backupReportCreated -and -not (Test-SafePathAbsent $diagnosticsRoot $backupPath)) {
                    if (-not (Assert-OrdinaryOwnedReport $backupPath)) {
                        throw 'The report backup is not verified as generator-owned.'
                    }
                    Remove-SafeTemporaryFile $diagnosticsRoot $backupPath
                }
                $backupAbsent = Test-SafePathAbsent $diagnosticsRoot $backupPath
                if ($backupAbsent) {
                    $script:reportWriteBackupCleanupStatus = 'PASS'
                    $backupPlaceholderCreated = $false
                    $backupReportCreated = $false
                } else {
                    $script:reportWriteBackupCleanupStatus = 'UNKNOWN'
                }
            }
        } catch {
            $script:reportWriteBackupCleanupStatus = 'FAIL'
            $script:reportWriteBackupCleanupFailure = $_.Exception
            if ($null -eq $disposeFailure) { $disposeFailure = $_.Exception }
        }
        if ($null -ne $disposeFailure) { throw $disposeFailure }
    }
}

function Get-Sha256([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $hash = $sha.ComputeHash($stream)
        return ([BitConverter]::ToString($hash).Replace('-', '')).ToLowerInvariant()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $sha.Dispose()
    }
}

function Get-TextSha256([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))
        return ([BitConverter]::ToString($bytes).Replace('-', '')).ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function New-ProbeCanary([string]$Name, [string]$Parent, [string]$Candidate,
    [string]$ReadMarker, [string]$WriteMarker, [ref]$Created, [bool]$ProtectFromAppContainer = $false) {
    $null = Assert-NoReparsePath $Parent
    $root = New-SafeDirectory $Parent $Candidate $Created
    if ($ProtectFromAppContainer) {
        Set-ProbeAcl $root $null ([System.Security.AccessControl.FileSystemRights]::FullControl) $true $false
    }
    $readPath = Join-Path $root 'read-canary.txt'
    $writePath = Join-Path $root 'write-canary.txt'
    $canaryRecords[$Name] = [ordered]@{
        parent = $Parent
        root = $root
        read_path = $readPath
        write_path = $writePath
        read_marker = $ReadMarker
        write_marker = $WriteMarker
    }
    $readBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($ReadMarker)
    $null = Assert-ChildPath $root $readPath
    $stream = [System.IO.FileStream]::new($readPath, [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $stream.Write($readBytes, 0, $readBytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    $item = Get-Item -LiteralPath (Assert-ChildPath $root $readPath) -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A probe canary is not an ordinary file.'
    }
    return $canaryRecords[$Name]
}

function Test-ProbeCanaryEntrySet([string[]]$Entries, [string]$ExpectedRead, [string]$ExpectedWrite) {
    if ($Entries.Count -lt 1 -or $Entries.Count -gt 2 -or -not ($Entries -icontains $ExpectedRead)) { return $false }
    foreach ($entry in $Entries) {
        if ($entry -ine $ExpectedRead -and $entry -ine $ExpectedWrite) { return $false }
    }
    return $true
}

function Test-ProbeCanaryCleanupSafe([string[]]$Entries, [string]$ExpectedRead, [string]$ExpectedWrite,
    [bool]$ReadMarkerMatches, [bool]$WriteAbsent, [bool]$WriteMarkerMatches) {
    return (Test-ProbeCanaryEntrySet $Entries $ExpectedRead $ExpectedWrite) -and
        $ReadMarkerMatches -and ($WriteAbsent -or $WriteMarkerMatches)
}

function Remove-ProbeCanary($Record) {
    $root = Assert-ChildPath $Record.parent $Record.root
    if (Test-SafePathAbsent $Record.parent $root) { return $true }
    $entries = @([System.IO.Directory]::EnumerateFileSystemEntries($root))
    $expectedRead = Assert-ChildPath $root $Record.read_path
    $expectedWrite = Assert-ChildPath $root $Record.write_path
    $readMarkerBytes = [System.Text.UTF8Encoding]::new($false).GetBytes([string]$Record.read_marker)
    $readMarkerMatches = Test-BackupPlaceholder $root $expectedRead $readMarkerBytes
    $writeAbsent = Test-SafePathAbsent $root $expectedWrite
    $writeMarkerMatches = $true
    if (-not $writeAbsent) {
        $writeMarkerBytes = [System.Text.UTF8Encoding]::new($false).GetBytes([string]$Record.write_marker)
        $writeMarkerMatches = Test-BackupPlaceholder $root $expectedWrite $writeMarkerBytes
    }
    if (-not (Test-ProbeCanaryCleanupSafe $entries $expectedRead $expectedWrite $readMarkerMatches $writeAbsent $writeMarkerMatches)) {
        throw 'Probe canary entries or nonce markers do not match; cleanup stopped.'
    }
    if (-not $writeAbsent) {
        Remove-SafeTemporaryFile $root $expectedWrite
    }
    Remove-SafeTemporaryFile $root $expectedRead
    [System.IO.Directory]::Delete($root, $false)
    return (Test-SafePathAbsent $Record.parent $root)
}

function Get-RuntimeFingerprint([string]$NodePath, [string]$RepositoryRoot) {
    $source = "import path from 'node:path'; import { pathToFileURL } from 'node:url'; const root = process.argv[1]; const { getRuntimeFingerprint } = await import(pathToFileURL(path.join(root, 'bench', 'evaluator', 'runtime-fingerprint.mjs'))); const value = await getRuntimeFingerprint(root); process.stdout.write(JSON.stringify({ sha256: value.sha256 }));"
    $output = @(& $NodePath '--input-type=module' '-e' $source $RepositoryRoot 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'The trusted Node runtime fingerprint helper failed.' }
    $text = [string]::Join('', [string[]]$output)
    if ($text.Length -gt 256) { throw 'The trusted Node runtime fingerprint response exceeded its limit.' }
    $value = $null
    try { $value = $text | ConvertFrom-Json -ErrorAction Stop } catch { throw 'The trusted Node runtime fingerprint response was invalid JSON.' }
    $properties = @($value.PSObject.Properties.Name)
    if ($properties.Count -ne 1 -or $properties[0] -ne 'sha256' -or
        [string]$value.sha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'The trusted Node runtime fingerprint response did not contain one SHA-256 digest.'
    }
    return [string]$value.sha256
}

function Get-ProbeFinalStatus([object[]]$Values) {
    if ($Values -contains 'FAIL') { return 'FAIL' }
    if ($Values -contains 'BLOCKED' -or $Values -contains 'UNKNOWN') { return 'BLOCKED' }
    return 'PASS'
}

function Get-ProbeReportFinalStatus([bool]$PreflightOnly, [bool]$ChecksComputed, $Failure, [object[]]$Values) {
    if ($PreflightOnly) { return 'BLOCKED' }
    if ($Values -contains 'FAIL') { return 'FAIL' }
    if ($Values -contains 'BLOCKED' -or $Values -contains 'UNKNOWN') { return 'BLOCKED' }
    if ($ChecksComputed -and $null -eq $Failure -and
        @($Values | Where-Object { $_ -cne 'PASS' }).Count -eq 0) { return 'PASS' }
    return 'BLOCKED'
}

function Get-AccessProbeStatus($Observation) {
    if ($Observation.status -eq 'DENIED' -and (Test-DenialCode ([string]$Observation.code))) { return 'PASS' }
    if ($Observation.status -eq 'ALLOWED' -or $Observation.code -in @('READ_ALLOWED', 'WRITE_ALLOWED', 'CONNECTED')) {
        return 'FAIL'
    }
    return 'UNKNOWN'
}

function Get-HostLoopbackControlStatus([bool]$Connected, [bool]$Accepted, [bool]$TimedOut) {
    if ($Connected -and $Accepted -and -not $TimedOut) { return 'PASS' }
    return 'UNKNOWN'
}

function Get-NetworkPolicyStatus($Evidence) {
    if ($null -eq $Evidence -or -not [bool]$Evidence.worker_attempted -or
        -not [bool]$Evidence.worker_token_verified -or -not [bool]$Evidence.job_membership_verified -or
        [string]$Evidence.capability_query_status -cne 'PASS' -or
        $null -eq $Evidence.network_capability_count -or $Evidence.capabilities_error_code -ne 0 -or
        [string]$Evidence.loopback_helper_status -cne 'VALID') { return 'UNKNOWN' }
    if ([string]$Evidence.loopback_exemption -ceq 'PRESENT') { return 'UNKNOWN' }
    if ([string]$Evidence.loopback_exemption -cne 'ABSENT') { return 'UNKNOWN' }
    if ([uint32]$Evidence.network_capability_count -gt 0) { return 'FAIL' }
    if ([uint32]$Evidence.network_capability_count -eq 0) { return 'PASS' }
    return 'UNKNOWN'
}

function Get-NetworkDeniedStatus($Evidence) {
    if ($null -eq $Evidence) { return 'UNKNOWN' }
    $observation = $Evidence.observation
    if ($null -eq $Evidence.listener_accepted) { return 'UNKNOWN' }
    if ([bool]$Evidence.listener_accepted -or
        ($null -ne $observation -and ($observation.status -eq 'ALLOWED' -or $observation.code -eq 'CONNECTED'))) {
        return 'FAIL'
    }
    if (-not [bool]$Evidence.worker_attempted) { return 'UNKNOWN' }
    $policyStatus = Get-NetworkPolicyStatus $Evidence
    if ($policyStatus -eq 'FAIL') { return 'FAIL' }
    if ($policyStatus -cne 'PASS' -or [string]$Evidence.host_control_status -cne 'PASS' -or
        -not [bool]$Evidence.target_matches_listener -or
        [string]$Evidence.worker_transport_status -cne 'COMPLETE' -or $null -eq $observation) { return 'UNKNOWN' }
    if ($observation.status -eq 'DENIED' -and (Test-DenialCode ([string]$observation.code))) { return 'PASS' }
    if ($observation.status -eq 'UNKNOWN' -and $observation.code -eq 'ETIMEDOUT') { return 'PASS' }
    return 'UNKNOWN'
}

function ConvertFrom-LoopbackConfigHelperOutput($Run) {
    $result = [pscustomobject]@{
        status = 'UNKNOWN'; uncertain = $false; invalid = $false; exemption = 'UNKNOWN'
        entry_count = $null; error_code = $null; cleanup_status = 'UNKNOWN'; cleanup_error_code = $null
    }
    if ($null -eq $Run) { return $result }
    if ([bool]$Run.ProcessCreated -and
        (-not [bool]$Run.RootProcessSignaled -or -not [bool]$Run.JobDrained -or -not [bool]$Run.CleanupConfirmed)) {
        $result.uncertain = $true
        return $result
    }
    if (-not [bool]$Run.ProcessCreated -or [bool]$Run.TimedOut -or [bool]$Run.OutputTruncated -or
        [int]$Run.ExitCode -ne 0 -or -not [bool]$Run.RootProcessSignaled -or
        -not [bool]$Run.JobDrained -or -not [bool]$Run.CleanupConfirmed) { return $result }
    $text = [string]$Run.Stdout
    if ([string]::IsNullOrEmpty($text) -or [Text.Encoding]::UTF8.GetByteCount($text) -gt 4096 -or
        -not $text.EndsWith("`n", [StringComparison]::Ordinal) -or
        $text.EndsWith("`n`n", [StringComparison]::Ordinal) -or $text.Contains("`r")) {
        $result.invalid = $true
        return $result
    }
    $jsonText = $text.Substring(0, $text.Length - 1)
    if ($jsonText.Contains("`n") -or $jsonText -cnotmatch '\A\{"schema_version":1,"loopback_exemption":"(?:PRESENT|ABSENT|UNKNOWN)","entry_count":(?:null|(?:0|[1-9][0-9]{0,3})),"error_code":(?:null|-?(?:0|[1-9][0-9]{0,9})),"cleanup_status":"(?:PASS|UNKNOWN)","cleanup_error_code":(?:null|-?(?:0|[1-9][0-9]{0,9}))\}\z') {
        $result.invalid = $true
        return $result
    }
    $parsed = $null
    try { $parsed = ConvertFrom-Json -InputObject $jsonText -ErrorAction Stop } catch {
        $result.invalid = $true
        return $result
    }
    if (-not (Test-ExactObjectKeys $parsed @(
            'schema_version', 'loopback_exemption', 'entry_count', 'error_code', 'cleanup_status', 'cleanup_error_code')) -or
        [int]$parsed.schema_version -ne 1 -or
        [string]$parsed.loopback_exemption -notin @('PRESENT', 'ABSENT', 'UNKNOWN') -or
        [string]$parsed.cleanup_status -notin @('PASS', 'UNKNOWN')) {
        $result.invalid = $true
        return $result
    }
    foreach ($field in @('entry_count', 'error_code', 'cleanup_error_code')) {
        $value = $parsed.$field
        if ($null -ne $value -and $value -isnot [int] -and $value -isnot [long]) {
            $result.invalid = $true
            return $result
        }
    }
    if ($null -ne $parsed.entry_count -and ($parsed.entry_count -lt 0 -or $parsed.entry_count -gt 4096)) {
        $result.invalid = $true
        return $result
    }
    $result.exemption = [string]$parsed.loopback_exemption
    $result.entry_count = $parsed.entry_count
    $result.error_code = $parsed.error_code
    $result.cleanup_status = [string]$parsed.cleanup_status
    $result.cleanup_error_code = $parsed.cleanup_error_code
    if ($result.exemption -in @('PRESENT', 'ABSENT') -and $result.cleanup_status -ceq 'PASS') {
        $result.status = 'VALID'
    }
    return $result
}

function Invoke-HostLoopbackControl($Listener) {
    $connected = $false
    $accepted = $false
    $timedOut = $false
    $failureCode = 'UNKNOWN'
    $client = $null
    $acceptedClient = $null
    try {
        $endpoint = [System.Net.IPEndPoint]$Listener.LocalEndpoint
        if ($endpoint.Address -ne [System.Net.IPAddress]::Loopback -or $endpoint.Port -lt 1 -or $endpoint.Port -gt 65535) {
            $failureCode = 'INVALID_LISTENER'
            return [pscustomobject]@{ status = 'UNKNOWN'; connected = $false; accepted = $false; timed_out = $false; failure_code = $failureCode }
        }
        $client = [System.Net.Sockets.TcpClient]::new([System.Net.Sockets.AddressFamily]::InterNetwork)
        $connectTask = $client.ConnectAsync([System.Net.IPAddress]::Loopback, $endpoint.Port)
        if (-not $connectTask.Wait(1000)) {
            $timedOut = $true
            $failureCode = 'CONNECT_TIMEOUT'
        } else {
            $connectTask.GetAwaiter().GetResult()
            $connected = $client.Connected
            if (-not $connected) { $failureCode = 'CONNECT_FAILED' }
            else {
                $acceptTimer = [Diagnostics.Stopwatch]::StartNew()
                while ($acceptTimer.ElapsedMilliseconds -lt 1000 -and -not $Listener.Pending()) {
                    Start-Sleep -Milliseconds 10
                }
                if ($Listener.Pending()) {
                    $acceptedClient = $Listener.AcceptTcpClient()
                    $accepted = $true
                    $failureCode = 'NONE'
                } else {
                    $timedOut = $true
                    $failureCode = 'ACCEPT_TIMEOUT'
                }
            }
        }
    } catch {
        $failureCode = 'CONTROL_FAILED'
    } finally {
        if ($null -ne $acceptedClient) { $acceptedClient.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
    }
    return [pscustomobject]@{
        status = (Get-HostLoopbackControlStatus $connected $accepted $timedOut)
        connected = [bool]$connected; accepted = [bool]$accepted
        timed_out = [bool]$timedOut; failure_code = $failureCode
    }
}

function Write-LoopbackConfigChildOutput($Observation) {
    $safe = [ordered]@{
        schema_version = 1
        loopback_exemption = if ($Observation.loopback_exemption -in @('PRESENT', 'ABSENT')) { $Observation.loopback_exemption } else { 'UNKNOWN' }
        entry_count = if ($Observation.entry_count -ge 0 -and $Observation.entry_count -le 4096) { [uint32]$Observation.entry_count } else { $null }
        error_code = if ($Observation.error_code -is [int]) { [int]$Observation.error_code } else { $null }
        cleanup_status = if ($Observation.cleanup_status -ceq 'PASS') { 'PASS' } else { 'UNKNOWN' }
        cleanup_error_code = if ($Observation.cleanup_error_code -is [int]) { [int]$Observation.cleanup_error_code } else { $null }
    }
    $json = ConvertTo-Json -InputObject $safe -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 4096) {
        $json = '{"schema_version":1,"loopback_exemption":"UNKNOWN","entry_count":null,"error_code":13,"cleanup_status":"UNKNOWN","cleanup_error_code":13}'
        [Console]::Out.Write($json + "`n")
        exit 1
    }
    [Console]::Out.Write($json + "`n")
    if ($safe.loopback_exemption -in @('PRESENT', 'ABSENT') -and $safe.cleanup_status -ceq 'PASS') { exit 0 }
    exit 1
}

function Test-ExactObjectKeys($Value, [string[]]$Expected) {
    if ($null -eq $Value -or $Value -is [System.Array]) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expectedSorted = @($Expected | Sort-Object)
    return [string]::Join("`0", [string[]]$actual) -ceq [string]::Join("`0", [string[]]$expectedSorted)
}

function Get-WorkerStderrClass([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return 'EMPTY' }
    if ($Text.Length -gt 1048576) { return 'OVERSIZE' }

    foreach ($code in @('EACCES', 'EPERM', 'ENOENT', 'EBADF', 'EPIPE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EADDRNOTAVAIL', 'EINVAL')) {
        if ($Text -cmatch ('(?<![A-Za-z0-9_])' + [regex]::Escape($code) + '(?![A-Za-z0-9_])')) {
            return $code
        }
    }
    foreach ($code in @('ERR_INVALID_ARG_TYPE', 'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION', 'MODULE_NOT_FOUND')) {
        if ($Text -cmatch ('(?<![A-Za-z0-9_])' + [regex]::Escape($code) + '(?![A-Za-z0-9_])')) {
            return $code
        }
    }
    if ($Text -cmatch '(?<![A-Za-z0-9_])SyntaxError(?![A-Za-z0-9_])') { return 'NODE_SYNTAX_ERROR' }
    if ($Text -cmatch '(?<![A-Za-z0-9_])TypeError(?![A-Za-z0-9_])') { return 'NODE_TYPE_ERROR' }
    if ($Text -cmatch '(?<![A-Za-z0-9_])ReferenceError(?![A-Za-z0-9_])') { return 'NODE_REFERENCE_ERROR' }
    if ($Text -cmatch '(?<![A-Za-z0-9_])Error(?![A-Za-z0-9_])') { return 'NODE_ERROR' }
    return 'NONEMPTY_UNCLASSIFIED'
}

function Get-WorkerStderrOperation([string]$Text) {
    if ([string]::IsNullOrEmpty($Text) -or $Text.Length -gt 1048576) { return 'UNKNOWN' }

    foreach ($operation in @(
        'access', 'appendFile', 'chmod', 'chown', 'close', 'copyfile', 'faccessat', 'fchmod', 'fchown',
        'fdatasync', 'fstat', 'fsync', 'link', 'lstat', 'lchown', 'mkdir', 'mkdtemp', 'open', 'opendir',
        'read', 'readFile', 'readdir', 'readlink', 'realpath', 'rename', 'rmdir', 'stat', 'statfs',
        'symlink', 'truncate', 'unlink', 'utimes', 'write', 'writeFile', 'spawn', 'connect', 'listen'
    )) {
        $quotedOperation = [regex]::Escape($operation)
        $syscallPattern = '(?<![A-Za-z0-9_])syscall\s*:\s*''' + $quotedOperation + '''(?![A-Za-z0-9_])'
        $nodeFsErrorPattern = "(?<![A-Za-z0-9_])(?:EACCES|EPERM|ENOENT|EBADF|EISDIR|ENOTDIR):[^\r\n]{0,512},\s*$quotedOperation(?=\s|:|$)"
        if ($Text -cmatch $syscallPattern -or $Text -cmatch $nodeFsErrorPattern) { return $operation }
    }
    return 'UNKNOWN'
}

function Get-WorkerStderrTarget([string]$Text, [string]$WorkerModulePath,
    [string]$ProbeContractPath, [string]$StagedNodePath, [string]$ModuleHookPath = $null) {
    if ([string]::IsNullOrEmpty($Text) -or $Text.Length -gt 1048576) { return 'unknown' }
    $matchedTargets = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
        [pscustomobject]@{ Label = 'workerModule'; Path = $WorkerModulePath },
        [pscustomobject]@{ Label = 'probeContract'; Path = $ProbeContractPath },
        [pscustomobject]@{ Label = 'stagedNode'; Path = $StagedNodePath },
        [pscustomobject]@{ Label = 'moduleHook'; Path = $ModuleHookPath }
    )) {
        if ([string]::IsNullOrWhiteSpace($candidate.Path)) { continue }
        $singleQuotedPath = "'" + $candidate.Path + "'"
        $doubleQuotedPath = '"' + $candidate.Path + '"'
        if ($Text.IndexOf($singleQuotedPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $Text.IndexOf($doubleQuotedPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $matchedTargets.Add($candidate.Label)
        }
    }
    if ($matchedTargets.Count -ne 1) { return 'unknown' }
    return $matchedTargets[0]
}

function Get-WorkerLauncherObservation($Result, [string]$WorkerModulePath = $null,
    [string]$ProbeContractPath = $null, [string]$StagedNodePath = $null,
    [string]$ModuleHookPath = $null) {
    $stdout = [string]$Result.Stdout
    $stderr = [string]$Result.Stderr
    $workerErrorCode = $null
    if (-not [string]::IsNullOrWhiteSpace($stdout)) {
        try {
            $errorResponse = $stdout.Trim() | ConvertFrom-Json -ErrorAction Stop
            if ((Test-ExactObjectKeys $errorResponse @('mode', 'code')) -and
                $errorResponse.mode -ceq 'error' -and [string]$errorResponse.code -match '^[A-Z0-9_]{1,32}$') {
                $workerErrorCode = [string]$errorResponse.code
            }
        } catch { }
    }
    return [pscustomobject]([ordered]@{
        timed_out = [bool]$Result.TimedOut
        exit_code = [int]$Result.ExitCode
        output_truncated = [bool]$Result.OutputTruncated
        root_process_signaled = [bool]$Result.RootProcessSignaled
        job_drained = [bool]$Result.JobDrained
        active_processes_after_drain = $Result.ActiveProcessesAfterDrain
        active_process_query_error_code = [int]$Result.ActiveProcessQueryErrorCode
        drain_poll_wait_code = [int]$Result.DrainPollWaitCode
        drain_diagnostic = [string]$Result.DrainDiagnostic
        worker_token_verified = [bool]$Result.WorkerTokenVerified
        job_membership_verified = [bool]$Result.JobMembershipVerified
        duration_ms = [long]$Result.DurationMs
        stdout_bytes = [Text.Encoding]::UTF8.GetByteCount($stdout)
        stderr_bytes = [Text.Encoding]::UTF8.GetByteCount($stderr)
        stdout_sha256 = Get-TextSha256 $stdout
        stderr_sha256 = Get-TextSha256 $stderr
        stderr_class = Get-WorkerStderrClass $stderr
        stderr_operation = Get-WorkerStderrOperation $stderr
        stderr_target = Get-WorkerStderrTarget $stderr $WorkerModulePath $ProbeContractPath $StagedNodePath $ModuleHookPath
        worker_error_code = $workerErrorCode
        appcontainer_capabilities_status = [string]$Result.AppContainerCapabilitiesStatus
        appcontainer_capability_count = $Result.AppContainerCapabilityCount
        appcontainer_capabilities_error_code = $Result.AppContainerCapabilitiesErrorCode
    })
}

function Get-DeadlineJobObservation($Result) {
    $activeProcesses = $null
    if ($null -ne $Result.DeadlineActiveProcesses) {
        $activeProcesses = [uint32]$Result.DeadlineActiveProcesses
    }
    $queryErrorCode = $null
    if ($null -ne $Result.DeadlineQueryErrorCode) {
        $queryErrorCode = [int]$Result.DeadlineQueryErrorCode
    }
    return [pscustomobject]([ordered]@{
        deadline_active_processes = $activeProcesses
        deadline_query_error_code = $queryErrorCode
    })
}

function Get-JobMemberSnapshotObservation($Result) {
    $status = if (@('COMPLETE', 'UNKNOWN') -ccontains [string]$Result.JobMemberDiagnosticsStatus) {
        [string]$Result.JobMemberDiagnosticsStatus
    } else { 'UNKNOWN' }
    $jobSetStable = if ($Result.JobMemberJobSetStable -is [bool]) {
        [bool]$Result.JobMemberJobSetStable
    } else { $null }
    $safeCount = {
        param($Value)
        $parsed = [uint32]0
        if ($null -ne $Value -and [uint32]::TryParse([string]$Value, [ref]$parsed)) { return $parsed }
        return $null
    }
    $safeCode = {
        param($Value)
        $parsed = 0
        if ($null -ne $Value -and [int]::TryParse([string]$Value, [ref]$parsed)) { return $parsed }
        return $null
    }
    return [pscustomobject]([ordered]@{
        status = $status
        job_set_stable = $jobSetStable
        query_error_code = & $safeCode $Result.JobMemberQueryErrorCode
        cleanup_error_code = & $safeCode $Result.JobMemberCleanupErrorCode
        assigned_count = & $safeCount $Result.JobMemberAssignedCount
        returned_count = & $safeCount $Result.JobMemberReturnedCount
        open_count = & $safeCount $Result.JobMemberOpenCount
        membership_verified_count = & $safeCount $Result.JobMemberMembershipVerifiedCount
        not_in_job_count = & $safeCount $Result.JobMemberNotInJobCount
        membership_unknown_count = & $safeCount $Result.JobMemberMembershipUnknownCount
        node_image_count = & $safeCount $Result.JobMemberNodeImageCount
        console_host_image_count = & $safeCount $Result.JobMemberConsoleHostImageCount
        command_shell_image_count = & $safeCount $Result.JobMemberCommandShellImageCount
        other_image_count = & $safeCount $Result.JobMemberOtherImageCount
        image_unknown_count = & $safeCount $Result.JobMemberImageUnknownCount
        metadata_unknown_count = & $safeCount $Result.JobMemberMetadataUnknownCount
    })
}

function Get-ProcessTreeDiagnosticObservation($Result) {
    $allowedStages = @(
        'PREFLIGHT', 'ARGUMENT_CONSTRUCTION', 'PROCESS_CREATE', 'TOKEN_VERIFICATION',
        'JOB_MEMBERSHIP', 'INPUT_WRITE', 'PROCESS_WAIT', 'TIMEOUT_QUERY', 'JOB_SNAPSHOT',
        'JOB_TERMINATION', 'ROOT_SIGNAL', 'JOB_DRAIN', 'OUTPUT_CAPTURE', 'CLEANUP'
    )
    $allowedExceptionTypes = @(
        'Win32Exception', 'ArgumentException', 'InvalidOperationException', 'TimeoutException',
        'IOException', 'UnauthorizedAccessException', 'PlatformNotSupportedException', 'OtherException'
    )
    $stage = if ($allowedStages -ccontains [string]$Result.ProcessTreeStage) { [string]$Result.ProcessTreeStage } else { 'UNKNOWN' }
    $failureStage = if ([string]$Result.ProcessTreeFailureStage -ceq 'NONE') { 'NONE' }
        elseif ($allowedStages -ccontains [string]$Result.ProcessTreeFailureStage) { [string]$Result.ProcessTreeFailureStage }
        else { 'UNKNOWN' }
    $exceptionType = if ($allowedExceptionTypes -ccontains [string]$Result.ProcessTreeFailureExceptionType) {
        [string]$Result.ProcessTreeFailureExceptionType
    } else { $null }
    $hresult = $null
    $win32Code = $null
    $cleanupFailureStage = if ($allowedStages -ccontains [string]$Result.ProcessTreeCleanupFailureStage) {
        [string]$Result.ProcessTreeCleanupFailureStage
    } else { $null }
    $cleanupExceptionType = if ($allowedExceptionTypes -ccontains [string]$Result.ProcessTreeCleanupFailureExceptionType) {
        [string]$Result.ProcessTreeCleanupFailureExceptionType
    } else { $null }
    $cleanupHresult = $null
    $cleanupWin32Code = $null
    $parsedCode = 0
    if ($null -ne $Result.ProcessTreeFailureHResult -and
        [int]::TryParse([string]$Result.ProcessTreeFailureHResult, [ref]$parsedCode)) {
        $hresult = $parsedCode
    }
    $parsedCode = 0
    if ($exceptionType -ceq 'Win32Exception' -and $null -ne $Result.ProcessTreeFailureWin32Code -and
        [int]::TryParse([string]$Result.ProcessTreeFailureWin32Code, [ref]$parsedCode)) {
        $win32Code = $parsedCode
    }
    $parsedCode = 0
    if ($null -ne $Result.ProcessTreeCleanupFailureHResult -and
        [int]::TryParse([string]$Result.ProcessTreeCleanupFailureHResult, [ref]$parsedCode)) {
        $cleanupHresult = $parsedCode
    }
    $parsedCode = 0
    if ($cleanupExceptionType -ceq 'Win32Exception' -and $null -ne $Result.ProcessTreeCleanupFailureWin32Code -and
        [int]::TryParse([string]$Result.ProcessTreeCleanupFailureWin32Code, [ref]$parsedCode)) {
        $cleanupWin32Code = $parsedCode
    }
    $status = if ([string]$Result.ProcessTreeStatus -ceq 'COMPLETE') { 'COMPLETE' } else { 'UNKNOWN' }
    return [ordered]@{
        status = $status
        stage = $stage
        failure_stage = $failureStage
        exception_type = $exceptionType
        hresult = $hresult
        win32_code = $win32Code
        cleanup_failure_stage = $cleanupFailureStage
        cleanup_exception_type = $cleanupExceptionType
        cleanup_hresult = $cleanupHresult
        cleanup_win32_code = $cleanupWin32Code
    }
}

function Test-ProcessTreeMemberEvidenceComplete($Result) {
    return [string]$Result.ProcessTreeStatus -ceq 'COMPLETE' -and
        [string]$Result.JobMemberDiagnosticsStatus -ceq 'COMPLETE'
}

function New-ProcessTreeReportObservation {
    param(
        [bool]$timedOut,
        [bool]$jobDrained,
        $deadlineObservation,
        $jobMemberSnapshot,
        [bool]$phaseMarkerSchemaValid,
        [string[]]$phaseMarkers,
        [bool]$schemaValid,
        $treeObservation,
        [bool]$treeStarted,
        [bool]$childPidValid,
        [int]$childPid,
        [bool]$grandchildPidValid,
        [int]$grandchildPid,
        $childPidAbsent,
        $grandchildPidAbsent,
        [long]$durationMs,
        [bool]$workerTokenVerified,
        [bool]$jobMembershipVerified,
        $processTreeDiagnostic
    )
    $processIdsDistinct = [bool]($childPidValid -and $grandchildPidValid -and $childPid -ne $grandchildPid)
    return [ordered]@{
        timed_out = $timedOut
        job_drained = $jobDrained
        deadline_active_processes = $deadlineObservation.deadline_active_processes
        deadline_query_error_code = $deadlineObservation.deadline_query_error_code
        job_member_snapshot = $jobMemberSnapshot
        phase_marker_schema_valid = $phaseMarkerSchemaValid
        phase_markers = $phaseMarkers
        schema_valid = $schemaValid
        child_spawn_status = if ($schemaValid) { $treeObservation.child_spawn_status } else { 'UNKNOWN' }
        child_spawn_code = if ($schemaValid) { $treeObservation.child_spawn_code } else { 'UNKNOWN' }
        child_worker_started = if ($schemaValid) { [bool]$treeObservation.child_worker_started } else { $false }
        grandchild_spawn_status = if ($schemaValid) { $treeObservation.grandchild_spawn_status } else { 'UNKNOWN' }
        grandchild_spawn_code = if ($schemaValid) { $treeObservation.grandchild_spawn_code } else { 'UNKNOWN' }
        grandchild_worker_started = if ($schemaValid) { [bool]$treeObservation.grandchild_worker_started } else { $false }
        readiness_stage = if ($schemaValid) { $treeObservation.readiness_stage } else { 'UNKNOWN' }
        readiness_status = if ($schemaValid) { $treeObservation.readiness_status } else { 'UNKNOWN' }
        readiness_code = if ($schemaValid) { $treeObservation.readiness_code } else { 'UNKNOWN' }
        worker_and_grandchild_started = $treeStarted
        child_pid_valid = $childPidValid
        grandchild_pid_valid = $grandchildPidValid
        process_ids_distinct = $processIdsDistinct
        child_pid_absent_after_drain = $childPidAbsent
        grandchild_pid_absent_after_drain = $grandchildPidAbsent
        duration_ms = $durationMs
        worker_token_verified = $workerTokenVerified
        job_membership_verified = $jobMembershipVerified
        process_tree_diagnostic = $processTreeDiagnostic
    }
}

function Get-StdioSmokeMarkers([string]$Stdout, [int]$ExpectedInputBytes) {
    $normalized = $Stdout.Replace("`r`n", "`n")
    $bootPresent = $normalized.StartsWith("BOOT`n", [StringComparison]::Ordinal)
    $lines = $normalized.Split([char]10)
    $stageMarkerPresent = $false
    $stageWriteOk = $false
    $stageWriteFail = $false
    if ($lines.Length -ge 2) {
        $stageWriteOk = $lines[1] -ceq 'STAGE_WRITE_OK'
        $stageWriteFail = $lines[1] -ceq 'STAGE_WRITE_FAIL'
        $stageMarkerPresent = $stageWriteOk -or $stageWriteFail
    }
    $inputPresent = $false
    if ($lines.Length -eq 4 -and $lines[3] -ceq '' -and
        $ExpectedInputBytes -ge 0 -and $ExpectedInputBytes -le 65536) {
        $inputPresent = $bootPresent -and $stageMarkerPresent -and
            $lines[2] -ceq "INPUT_OK:$ExpectedInputBytes"
    }
    $bytesRead = if ($inputPresent) { $ExpectedInputBytes } else { $null }
    return [pscustomobject]([ordered]@{
        boot_marker_present = [bool]$bootPresent
        stage_write_marker_present = [bool]$stageMarkerPresent
        stage_write_marker_ok = [bool]$stageWriteOk
        stage_write_marker_fail = [bool]$stageWriteFail
        input_marker_present = [bool]$inputPresent
        bytes_read = $bytesRead
    })
}

function Get-InlineStdioSmokeMarkers([string]$Stdout, [int]$ExpectedInputBytes) {
    $normalized = $Stdout.Replace("`r`n", "`n")
    $bootPresent = $false
    $inputPresent = $false
    $bytesRead = $null
    if ($ExpectedInputBytes -ge 0 -and $ExpectedInputBytes -le 65537) {
        $lines = $normalized.Split([char]10)
        if ($lines.Length -eq 2 -and $lines[0] -ceq 'BOOT' -and $lines[1] -ceq '') {
            $bootPresent = $true
        } elseif ($lines.Length -eq 3 -and $lines[0] -ceq 'BOOT' -and $lines[2] -ceq '' -and
            $lines[1] -cmatch '^INPUT_OK:(0|[1-9][0-9]{0,4})$') {
            $reportedBytes = [int]$Matches[1]
            if ($reportedBytes -le 65537) {
                $bootPresent = $true
                if ($reportedBytes -eq $ExpectedInputBytes) {
                    $inputPresent = $true
                    $bytesRead = $reportedBytes
                }
            }
        }
    }
    return [pscustomobject]([ordered]@{
        boot_marker_present = [bool]$bootPresent
        input_marker_present = [bool]$inputPresent
        bytes_read = $bytesRead
    })
}

function Get-WorkerInputByteCount([string]$InputJson) {
    # AppContainerLauncher.RunNode appends one LF after the JSON bytes.
    return [Text.Encoding]::UTF8.GetByteCount($InputJson) + 1
}

function Get-StdioMarkerStatus([bool]$MarkerPresent, [bool]$ContentMatches, [bool]$AbsentAfterCleanup) {
    return [pscustomobject]([ordered]@{
        script_started = [bool]$MarkerPresent
        stage_write_pass = [bool]($MarkerPresent -and $ContentMatches)
        marker_cleanup = [bool](((-not $MarkerPresent) -or $ContentMatches) -and $AbsentAfterCleanup)
    })
}

function Remove-StdioSmokeMarker([string]$Parent, [string]$Candidate, [string]$ExpectedContent) {
    $markerPresent = -not (Test-SafePathAbsent $Parent $Candidate)
    $contentMatches = $false
    if ($markerPresent) {
        $expectedBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($ExpectedContent)
        $contentMatches = Test-BackupPlaceholder $Parent $Candidate $expectedBytes
        if ($contentMatches) {
            Remove-SafeTemporaryFile $Parent $Candidate
        } else {
            $script:preserveStageForInspection = $true
        }
    }
    $absentAfterCleanup = Test-SafePathAbsent $Parent $Candidate
    $status = Get-StdioMarkerStatus $markerPresent $contentMatches $absentAfterCleanup
    if (-not $status.marker_cleanup) { $script:preserveStageForInspection = $true }
    return $status
}

function Get-StdioSmokePrimaryStatus($Markers, $MarkerStatus) {
    return [pscustomobject]([ordered]@{
        script_started = [bool]($Markers.boot_marker_present -or $MarkerStatus.script_started)
        stage_write_pass = [bool]$MarkerStatus.stage_write_pass
        marker_cleanup = [bool]$MarkerStatus.marker_cleanup
    })
}

function Merge-StdioSmokeFinalStatus($PrimaryStatus, $CleanupStatus) {
    if ($null -eq $PrimaryStatus) { return $CleanupStatus }
    return [pscustomobject]([ordered]@{
        script_started = [bool]$PrimaryStatus.script_started
        stage_write_pass = [bool]$PrimaryStatus.stage_write_pass
        marker_cleanup = [bool]$CleanupStatus.marker_cleanup
    })
}

function Test-ProcessTreePhasePrefix([string[]]$Markers, [bool]$RequireComplete = $false) {
    $branches = @(
        'PROBE_REQUEST_RECEIVED|PROCESS_TREE_REQUEST_DISPATCH|CHILD_SPAWN_CALL_BEGIN|CHILD_SPAWN_CALL_THROW|PROCESS_TREE_RESPONSE_BEGIN|PROCESS_TREE_RESPONSE_FLUSHED',
        'PROBE_REQUEST_RECEIVED|PROCESS_TREE_REQUEST_DISPATCH|CHILD_SPAWN_CALL_BEGIN|CHILD_SPAWN_CALL_RETURN|CHILD_SPAWN_ERROR|PROCESS_TREE_RESPONSE_BEGIN|PROCESS_TREE_RESPONSE_FLUSHED',
        'PROBE_REQUEST_RECEIVED|PROCESS_TREE_REQUEST_DISPATCH|CHILD_SPAWN_CALL_BEGIN|CHILD_SPAWN_CALL_RETURN|CHILD_SPAWN_TIMEOUT|PROCESS_TREE_RESPONSE_BEGIN|PROCESS_TREE_RESPONSE_FLUSHED',
        'PROBE_REQUEST_RECEIVED|PROCESS_TREE_REQUEST_DISPATCH|CHILD_SPAWN_CALL_BEGIN|CHILD_SPAWN_CALL_RETURN|CHILD_SPAWN_EVENT|CHILD_WORKER_START_WAIT|PROCESS_TREE_RESPONSE_BEGIN|PROCESS_TREE_RESPONSE_FLUSHED',
        'PROBE_REQUEST_RECEIVED|PROCESS_TREE_REQUEST_DISPATCH|CHILD_SPAWN_CALL_BEGIN|CHILD_SPAWN_CALL_RETURN|CHILD_SPAWN_EVENT|CHILD_WORKER_START_WAIT|CHILD_WORKER_READY|GRANDCHILD_START_WAIT|CHILD_READINESS_RESPONSE|PROCESS_TREE_RESPONSE_BEGIN|PROCESS_TREE_RESPONSE_FLUSHED'
    )
    foreach ($branchText in $branches) {
        $branch = $branchText.Split([char]'|')
        if ($Markers.Count -gt $branch.Length -or
            ($RequireComplete -and $Markers.Count -ne $branch.Length)) { continue }
        $matches = $true
        for ($index = 0; $index -lt $Markers.Count; $index++) {
            if ($Markers[$index] -cne $branch[$index]) { $matches = $false; break }
        }
        if ($matches) { return $true }
    }
    return $false
}

function ConvertFrom-WorkerProtocolOutput([string]$Text, [string]$ExpectedMode) {
    $allowedStages = @(
        'PROBE_REQUEST_RECEIVED', 'PROCESS_TREE_REQUEST_DISPATCH', 'CHILD_SPAWN_CALL_BEGIN',
        'CHILD_SPAWN_CALL_RETURN', 'CHILD_SPAWN_CALL_THROW', 'CHILD_SPAWN_EVENT',
        'CHILD_SPAWN_ERROR', 'CHILD_SPAWN_TIMEOUT', 'CHILD_WORKER_START_WAIT',
        'CHILD_WORKER_READY', 'GRANDCHILD_START_WAIT', 'CHILD_READINESS_RESPONSE',
        'PROCESS_TREE_RESPONSE_BEGIN', 'PROCESS_TREE_RESPONSE_FLUSHED'
    )
    switch -CaseSensitive ($ExpectedMode) {
        'filesystem' { $expectedResponseKeys = @('mode', 'workspace_read_write', 'workspace_canary_absent', 'canaries', 'environment_keys') }
        'network' { $expectedResponseKeys = @('mode', 'status', 'code') }
        'process-tree' {
            $expectedResponseKeys = @(
                'mode', 'child_spawn_status', 'child_spawn_code', 'child_worker_started',
                'grandchild_spawn_status', 'grandchild_spawn_code', 'grandchild_worker_started',
                'readiness_stage', 'readiness_status', 'readiness_code', 'child_pid', 'grandchild_pid'
            )
        }
        default { $expectedResponseKeys = @() }
    }
    $phaseMarkers = [System.Collections.Generic.List[string]]::new()
    $response = $null
    $schemaValid = $expectedResponseKeys.Count -gt 0
    foreach ($line in [System.Text.RegularExpressions.Regex]::Split($Text, "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line.Length -gt 65536) { $schemaValid = $false; continue }
        $entry = $null
        try { $entry = $line | ConvertFrom-Json -ErrorAction Stop } catch { $schemaValid = $false; continue }
        if (Test-ExactObjectKeys $entry @('agentcp_stage')) {
            if ($phaseMarkers.Count -ge 32 -or $entry.agentcp_stage -isnot [string] -or
                $entry.agentcp_stage -cnotin $allowedStages) {
                $schemaValid = $false
                continue
            }
            $stage = [string]$entry.agentcp_stage
            if ($null -ne $response -and
                ($ExpectedMode -cne 'process-tree' -or $stage -cne 'PROCESS_TREE_RESPONSE_FLUSHED')) {
                $schemaValid = $false
                continue
            }
            if ($ExpectedMode -ceq 'process-tree') {
                if ($stage -ceq 'PROCESS_TREE_RESPONSE_FLUSHED' -and $null -eq $response) {
                    $schemaValid = $false
                }
                $phaseMarkers.Add($stage)
                if (-not (Test-ProcessTreePhasePrefix ([string[]]$phaseMarkers.ToArray()))) {
                    $schemaValid = $false
                }
            } else {
                $phaseMarkers.Add($stage)
                if ($phaseMarkers.Count -ne 1 -or $stage -cne 'PROBE_REQUEST_RECEIVED') {
                    $schemaValid = $false
                }
            }
            continue
        }
        if ($null -ne $response -or $null -eq $entry -or $entry.mode -cne $ExpectedMode -or
            -not (Test-ExactObjectKeys $entry $expectedResponseKeys)) {
            $schemaValid = $false
            continue
        }
        if ($ExpectedMode -ceq 'process-tree') {
            if ($phaseMarkers.Count -eq 0 -or $phaseMarkers[$phaseMarkers.Count - 1] -cne 'PROCESS_TREE_RESPONSE_BEGIN') {
                $schemaValid = $false
            }
        } elseif ($phaseMarkers.Count -ne 1 -or $phaseMarkers[0] -cne 'PROBE_REQUEST_RECEIVED') {
            $schemaValid = $false
        }
        $response = $entry
    }

    if ($phaseMarkers.Count -eq 0 -or $phaseMarkers[0] -cne 'PROBE_REQUEST_RECEIVED') {
        $schemaValid = $false
    }
    if ($ExpectedMode -ceq 'process-tree') {
        if (-not (Test-ProcessTreePhasePrefix ([string[]]$phaseMarkers.ToArray())) -or
            ($null -ne $response -and -not (Test-ProcessTreePhasePrefix ([string[]]$phaseMarkers.ToArray()) $true)) -or
            ($null -ne $response -and $phaseMarkers[$phaseMarkers.Count - 1] -cne 'PROCESS_TREE_RESPONSE_FLUSHED') -or
            ($null -eq $response -and $phaseMarkers[$phaseMarkers.Count - 1] -ceq 'PROCESS_TREE_RESPONSE_FLUSHED')) {
            $schemaValid = $false
        }
    } elseif ($phaseMarkers.Count -ne 1 -or $null -eq $response) {
        $schemaValid = $false
    }

    return [pscustomobject]@{
        schema_valid = $schemaValid
        response = $response
        phase_markers = @($phaseMarkers.ToArray())
    }
}

function Convert-WorkerOutput($Result, [string]$ExpectedMode) {
    if ($Result.TimedOut -or $Result.ExitCode -ne 0 -or $Result.OutputTruncated -or -not $Result.JobDrained) {
        throw 'Probe worker did not complete normally.'
    }
    $protocolOutput = ConvertFrom-WorkerProtocolOutput $Result.Stdout $ExpectedMode
    $observation = $protocolOutput.response
    if (-not $protocolOutput.schema_valid -or $null -eq $observation -or $observation.mode -ne $ExpectedMode) {
        throw 'Probe worker response did not match the requested mode.'
    }
    if ($ExpectedMode -eq 'filesystem') {
        if (-not (Test-ExactObjectKeys $observation @('mode', 'workspace_read_write', 'workspace_canary_absent', 'canaries', 'environment_keys')) -or
            -not (Test-ExactObjectKeys $observation.canaries @('runtime', 'repository', 'oracle', 'ownerProfile')) -or
            $observation.workspace_read_write -isnot [bool] -or $observation.workspace_canary_absent -isnot [bool] -or
            $observation.environment_keys -isnot [System.Array] -or $observation.environment_keys.Count -gt 16) {
            throw 'Filesystem probe response did not match its fixed schema.'
        }
        foreach ($scopeName in @('runtime', 'repository', 'oracle', 'ownerProfile')) {
            $scope = $observation.canaries.$scopeName
            if (-not (Test-ExactObjectKeys $scope @('read', 'write'))) { throw 'Canary response did not match its fixed schema.' }
            foreach ($kind in @('read', 'write')) {
                $entry = $scope.$kind
                if (-not (Test-ExactObjectKeys $entry @('status', 'code')) -or
                    $entry.status -notin @('ALLOWED', 'DENIED', 'UNKNOWN') -or
                    [string]$entry.code -notmatch '^[A-Z0-9_]{1,32}$') {
                    throw 'Canary access response did not match its fixed schema.'
                }
            }
        }
    } elseif ($ExpectedMode -eq 'network') {
        if (-not (Test-ExactObjectKeys $observation @('mode', 'status', 'code')) -or
            $observation.status -notin @('ALLOWED', 'DENIED', 'UNKNOWN') -or
            [string]$observation.code -notmatch '^[A-Z0-9_]{1,32}$') {
            throw 'Network probe response did not match its fixed schema.'
        }
    } else {
        throw 'Unsupported worker response schema.'
    }
    return $observation
}

function Test-DenialCode([string]$Code) {
    return $Code -in @('EACCES', 'EPERM')
}

function Test-ProfileMappingReadOnlyProfileId([AllowNull()][string]$ProfileId) {
    if ($null -eq $ProfileId -or $ProfileId.Length -ne 24) { return $false }
    return [System.Text.RegularExpressions.Regex]::IsMatch(
        $ProfileId, '\AAgentCP[0-9a-f]{17}\z', [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)
}

function Get-ProfileMappingReadOnlyFailureMetadata([System.Exception]$Exception) {
    $baseException = $Exception.GetBaseException()
    $failureType = if ($baseException -is [System.UnauthorizedAccessException]) { 'UnauthorizedAccessException' }
        elseif ($baseException -is [System.Security.SecurityException]) { 'SecurityException' }
        elseif ($baseException -is [System.IO.IOException]) { 'IOException' }
        elseif ($baseException -is [System.ComponentModel.Win32Exception]) { 'Win32Exception' }
        elseif ($baseException -is [System.ArgumentException]) { 'ArgumentException' }
        elseif ($baseException -is [System.InvalidOperationException]) { 'InvalidOperationException' }
        elseif ($baseException -is [System.Management.Automation.RuntimeException]) { 'RuntimeException' }
        else { 'OTHER' }
    return [pscustomobject]@{ failure_type = $failureType; failure_code = [int]$baseException.HResult }
}

function New-ProfileMappingReadOnlyUnknownScan([System.Exception]$Exception) {
    $failure = Get-ProfileMappingReadOnlyFailureMetadata $Exception
    return [pscustomobject][ordered]@{
        status = 'UNKNOWN'; scan_complete = $false; keys_visited = 0; complete_match_count = 0
        partial_match_count = 0; case_only_pair_count = 0; partial_missing_pair_count = 0
        partial_different_pair_count = 0; malformed_value_count = 0; stability_status = 'UNKNOWN'
        issue = 'READ_FAILED'; failure_phase = 'ROOT'; failure_type = $failure.failure_type
        failure_code = $failure.failure_code; display_name_exact_match_count = 0
        display_name_case_only_match_count = 0; moniker_exact_match_count = 0; moniker_case_only_match_count = 0
    }
}

function New-ProfileMappingReadOnlyUnknownCandidate([System.Exception]$Exception) {
    $failure = Get-ProfileMappingReadOnlyFailureMetadata $Exception
    return [pscustomobject]@{
        status = 'UNKNOWN'; shape_valid = $false; candidate_exists = $null
        candidate_is_directory = $null; reparse_point = $null
        failure_type = $failure.failure_type; failure_code = $failure.failure_code
    }
}

function Get-ProfileMappingCandidatePath([bool]$CallerFullTrust, [string]$OwnerLocalAppData, [string]$ProfileName) {
    if (-not $CallerFullTrust) { throw 'A full-trust caller is required.' }
    if (-not (Test-ProfileMappingReadOnlyProfileId $ProfileName)) { throw 'The profile identifier is invalid.' }
    $canonicalOwnerLocalAppData = Get-CanonicalLocalDrivePath $OwnerLocalAppData 'full-trust LocalApplicationData'
    if ($canonicalOwnerLocalAppData -match '\\Packages\\sandbox\.[^\\]+\\AC$') {
        throw 'The caller LocalApplicationData is a nested sandbox profile path.'
    }
    $candidatePath = Get-CanonicalLocalDrivePath `
        (Join-Path $canonicalOwnerLocalAppData ('Packages\' + $ProfileName + '\AC')) 'AppContainer profile candidate'
    $expectedSuffix = '\Packages\' + $ProfileName + '\AC'
    if (-not $candidatePath.EndsWith($expectedSuffix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The AppContainer profile candidate has an unexpected path shape.'
    }
    $candidateDirectory = [System.IO.DirectoryInfo]::new($candidatePath)
    if ($candidateDirectory.Name -cne 'AC' -or $null -eq $candidateDirectory.Parent -or
        $candidateDirectory.Parent.Name -cne $ProfileName -or $null -eq $candidateDirectory.Parent.Parent -or
        $candidateDirectory.Parent.Parent.Name -cne 'Packages') {
        throw 'The AppContainer profile candidate has an unexpected path shape.'
    }
    return $candidatePath
}

function Get-ProfileMappingCandidatePathObservation([bool]$CallerFullTrust, [string]$OwnerLocalAppData,
    [string]$ProfileName, [scriptblock]$AttributeReader) {
    $observation = [pscustomobject]@{
        status = 'UNKNOWN'; shape_valid = $false; candidate_exists = $null
        candidate_is_directory = $null; reparse_point = $null
        failure_type = $null; failure_code = $null
    }
    try {
        $candidatePath = Get-ProfileMappingCandidatePath $CallerFullTrust $OwnerLocalAppData $ProfileName
        $observation.shape_valid = $true
        $reader = if ($null -ne $AttributeReader) { $AttributeReader } else {
            { param($Path) [System.IO.File]::GetAttributes($Path) }
        }
        $volumeRoot = [System.IO.Path]::GetPathRoot($candidatePath)
        $relativePath = $candidatePath.Substring($volumeRoot.Length)
        $currentPath = $volumeRoot
        $components = @($relativePath -split '[\\/]' | Where-Object { $_ })
        for ($index = 0; $index -lt $components.Count; $index++) {
            $currentPath = Join-Path $currentPath $components[$index]
            try {
                $attributes = & $reader $currentPath
            } catch [System.IO.FileNotFoundException] {
                $observation.status = 'ABSENT'
                $observation.candidate_exists = $false
                $observation.candidate_is_directory = $false
                $observation.reparse_point = $false
                return $observation
            } catch [System.IO.DirectoryNotFoundException] {
                $observation.status = 'ABSENT'
                $observation.candidate_exists = $false
                $observation.candidate_is_directory = $false
                $observation.reparse_point = $false
                return $observation
            }
            if ($attributes -isnot [System.IO.FileAttributes]) { throw 'The attribute observation is invalid.' }
            if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                $observation.status = 'REPARSE_POINT'
                $observation.candidate_exists = if ($index -eq $components.Count - 1) { $true } else { $null }
                $observation.candidate_is_directory = if ($attributes -band [System.IO.FileAttributes]::Directory) { $true } else { $null }
                $observation.reparse_point = $true
                return $observation
            }
            if (-not ($attributes -band [System.IO.FileAttributes]::Directory)) {
                $isCandidate = $index -eq $components.Count - 1
                $observation.status = 'NOT_DIRECTORY'
                $observation.candidate_exists = $isCandidate
                $observation.candidate_is_directory = $false
                $observation.reparse_point = $false
                return $observation
            }
        }
        $observation.status = 'PRESENT'
        $observation.candidate_exists = $true
        $observation.candidate_is_directory = $true
        $observation.reparse_point = $false
    } catch {
        $failure = Get-ProfileMappingReadOnlyFailureMetadata $_.Exception
        $observation.status = if (-not $observation.shape_valid) { 'INVALID_SHAPE' } else { 'UNKNOWN' }
        $observation.failure_type = $failure.failure_type
        $observation.failure_code = $failure.failure_code
    }
    return $observation
}

function Invoke-ProfileMappingReadOnlyObservations([scriptblock]$ApiOperation,
    [scriptblock]$RegistryOperation, [scriptblock]$CandidateOperation) {
    try { $api = & $ApiOperation }
    catch { $api = [pscustomobject]@{ SidDerivationHResult = $null; ApiHResult = $null; PathPresent = $false; FailureType = (Get-ProfileMappingReadOnlyFailureMetadata $_.Exception).failure_type; FailureCode = [int]$_.Exception.GetBaseException().HResult } }
    try { $scan = & $RegistryOperation }
    catch { $scan = New-ProfileMappingReadOnlyUnknownScan $_.Exception }
    try { $candidate = & $CandidateOperation }
    catch { $candidate = New-ProfileMappingReadOnlyUnknownCandidate $_.Exception }
    return [pscustomobject]@{ api = $api; registry = $scan; candidate = $candidate }
}

function Convert-ProfileMappingReadOnlyOutput($Api, $Scan, $Candidate) {
    $countNames = @('keys_visited', 'complete_match_count', 'partial_match_count', 'case_only_pair_count',
        'partial_missing_pair_count', 'partial_different_pair_count', 'malformed_value_count',
        'display_name_exact_match_count', 'display_name_case_only_match_count',
        'moniker_exact_match_count', 'moniker_case_only_match_count')
    $allowedFailureTypes = @('UnauthorizedAccessException', 'SecurityException', 'IOException', 'Win32Exception',
        'ArgumentException', 'InvalidOperationException', 'RuntimeException', 'OTHER')
    $candidateStatuses = @('PRESENT', 'ABSENT', 'NOT_DIRECTORY', 'REPARSE_POINT', 'UNKNOWN', 'INVALID_SHAPE')
    if ($null -eq $Api -or $null -eq $Scan -or $Scan.status -cnotin @('COMPLETE', 'UNKNOWN') -or
        $Scan.scan_complete -isnot [bool] -or $Scan.stability_status -cnotin @('STABLE', 'UNKNOWN') -or
        $Scan.issue -cnotin @('NONE', 'UNKNOWN', 'INVALID_PROFILE_ID', 'ROOT_UNAVAILABLE', 'CHANGE_MONITOR_UNKNOWN',
            'KEY_LIMIT', 'KEY_UNAVAILABLE', 'VALUE_UNKNOWN', 'DEPTH_LIMIT', 'CHILD_ENUMERATION_UNKNOWN',
            'REGISTRY_CHANGED', 'MALFORMED_VALUE', 'READ_FAILED') -or
        $Scan.failure_phase -cnotin @('NONE', 'ROOT', 'MONITOR', 'STACK', 'OPEN_CHILD', 'VALUE', 'ENUMERATE', 'STABILITY') -or
        ($null -ne $Scan.failure_type -and $Scan.failure_type -cnotin $allowedFailureTypes) -or
        ($null -ne $Scan.failure_code -and $Scan.failure_code -isnot [int]) -or
        ($null -ne $Api.SidDerivationHResult -and $Api.SidDerivationHResult -isnot [int]) -or
        ($null -ne $Api.ApiHResult -and $Api.ApiHResult -isnot [int]) -or
        $Api.PathPresent -isnot [bool] -or
        ($null -ne $Api.FailureType -and $Api.FailureType -cnotin $allowedFailureTypes) -or
        ($null -ne $Api.FailureCode -and $Api.FailureCode -isnot [int]) -or
        $null -eq $Candidate -or $Candidate.status -cnotin $candidateStatuses -or
        $Candidate.shape_valid -isnot [bool] -or
        ($null -ne $Candidate.candidate_exists -and $Candidate.candidate_exists -isnot [bool]) -or
        ($null -ne $Candidate.candidate_is_directory -and $Candidate.candidate_is_directory -isnot [bool]) -or
        ($null -ne $Candidate.reparse_point -and $Candidate.reparse_point -isnot [bool]) -or
        ($null -ne $Candidate.failure_type -and $Candidate.failure_type -cnotin $allowedFailureTypes) -or
        ($null -ne $Candidate.failure_code -and $Candidate.failure_code -isnot [int])) { throw 'Invalid diagnostic result.' }
    foreach ($name in $countNames) {
        $value = $Scan.PSObject.Properties[$name].Value
        if ($value -isnot [int] -or $value -lt 0 -or $value -gt 2048) { throw 'Invalid scan count.' }
    }
    $complete = $Scan.status -ceq 'COMPLETE' -and $Scan.scan_complete -and
        $Scan.stability_status -ceq 'STABLE' -and $Scan.issue -ceq 'NONE'
    if ($Scan.scan_complete -and -not $complete) { throw 'Invalid scan completeness.' }
    $success = $complete -and $null -eq $Api.FailureType -and
        $null -ne $Api.SidDerivationHResult -and $Api.SidDerivationHResult -eq 0 -and
        $null -ne $Api.ApiHResult -and $Api.ApiHResult -eq 0 -and $Api.PathPresent -and
        $Candidate.status -notin @('UNKNOWN', 'INVALID_SHAPE')
    return [pscustomobject]@{
        status = if ($success) { 'COMPLETE' } else { 'UNKNOWN' }
        sid_derivation_hresult = $Api.SidDerivationHResult
        api_hresult = $Api.ApiHResult
        api_path_present = $Api.PathPresent
        api_failure_type = $Api.FailureType
        api_failure_code = $Api.FailureCode
        registry = [pscustomobject]@{
            status = $Scan.status
            scan_complete = $Scan.scan_complete
            keys_visited = $Scan.keys_visited
            complete_match_count = $Scan.complete_match_count
            partial_match_count = $Scan.partial_match_count
            case_only_pair_count = $Scan.case_only_pair_count
            partial_missing_pair_count = $Scan.partial_missing_pair_count
            partial_different_pair_count = $Scan.partial_different_pair_count
            malformed_value_count = $Scan.malformed_value_count
            display_name_exact_match_count = $Scan.display_name_exact_match_count
            display_name_case_only_match_count = $Scan.display_name_case_only_match_count
            moniker_exact_match_count = $Scan.moniker_exact_match_count
            moniker_case_only_match_count = $Scan.moniker_case_only_match_count
            stability_status = $Scan.stability_status
            issue = $Scan.issue
            failure_phase = $Scan.failure_phase
            failure_type = $Scan.failure_type
            failure_code = $Scan.failure_code
        }
        candidate_path = [pscustomobject]@{
            status = $Candidate.status
            shape_valid = $Candidate.shape_valid
            exists = $Candidate.candidate_exists
            is_directory = $Candidate.candidate_is_directory
            reparse_point = $Candidate.reparse_point
            failure_type = $Candidate.failure_type
            failure_code = $Candidate.failure_code
        }
    }
}

function ConvertTo-ProfileMappingReadOnlyJson($Output) {
    $json = ConvertTo-Json -InputObject $Output -Depth 4 -Compress
    if ([System.Text.Encoding]::UTF8.GetByteCount($json) + 1 -gt 4096) {
        $json = '{"status":"ERROR","reason":"OUTPUT_LIMIT"}'
    }
    return $json
}

function Get-ProfilePathDiagnosticRegistrationState($Scan) {
    if ((Get-ProfileRegistrationPreDeleteDecision $Scan) -ceq 'PASS') { return 'PRESENT' }
    if ((Get-ProfileRegistrationPostDeleteDecision $Scan) -ceq 'PASS') { return 'ABSENT' }
    return 'UNKNOWN'
}

function Get-ProfilePathDiagnosticDeleteDecision($CreateSucceeded, $Preexisted, $PathSucceeded,
    $ApiObservationSucceeded, $SidMatchesName, $DeleteIntentPersisted, $RegistrationDecision, $CandidateObservation,
    $ApiCandidateMatched, $DiagnosticProfilePathWriteAttempted) {
    if ($CreateSucceeded -isnot [bool] -or -not $CreateSucceeded -or
        $Preexisted -isnot [bool] -or $Preexisted -or
        $PathSucceeded -isnot [bool] -or -not $PathSucceeded -or
        $ApiObservationSucceeded -isnot [bool] -or -not $ApiObservationSucceeded -or
        $SidMatchesName -isnot [bool] -or -not $SidMatchesName -or
        $DeleteIntentPersisted -isnot [bool] -or -not $DeleteIntentPersisted -or
        $RegistrationDecision -cne 'PASS' -or $ApiCandidateMatched -isnot [bool] -or
        -not $ApiCandidateMatched -or $DiagnosticProfilePathWriteAttempted -isnot [bool] -or
        $DiagnosticProfilePathWriteAttempted -or $null -eq $CandidateObservation -or
        $CandidateObservation.shape_valid -isnot [bool] -or -not $CandidateObservation.shape_valid -or
        $CandidateObservation.candidate_exists -isnot [bool] -or
        $CandidateObservation.candidate_is_directory -isnot [bool] -or
        $CandidateObservation.reparse_point -isnot [bool] -or $CandidateObservation.reparse_point) {
        return 'NOT_ATTEMPTED'
    }
    $presentCandidate = $CandidateObservation.status -ceq 'PRESENT' -and
        $CandidateObservation.candidate_exists -eq $true -and
        $CandidateObservation.candidate_is_directory -eq $true
    $absentCandidate = $CandidateObservation.status -ceq 'ABSENT' -and
        $CandidateObservation.candidate_exists -eq $false -and
        $CandidateObservation.candidate_is_directory -eq $false
    if (-not ($presentCandidate -or $absentCandidate)) { return 'NOT_ATTEMPTED' }
    return 'DELETE'
}

function Get-ProfilePathDiagnosticCleanupStatus($DeleteAttempted, $DeleteHResult,
    $PostDeleteDecision, $PostCandidateObservation) {
    $candidateStatus = if ($null -eq $PostCandidateObservation) { $null } else { $PostCandidateObservation.status }
    if ($DeleteAttempted -isnot [bool]) { return 'UNKNOWN' }
    if (-not $DeleteAttempted) {
        if ($null -eq $PostDeleteDecision -or $candidateStatus -notin @('PRESENT', 'ABSENT', 'NOT_DIRECTORY', 'REPARSE_POINT', 'UNKNOWN', 'INVALID_SHAPE')) {
            return 'UNKNOWN'
        }
        return 'NOT_ATTEMPTED'
    }
    if ($PostDeleteDecision -ceq 'FAIL' -or
        $candidateStatus -in @('PRESENT', 'NOT_DIRECTORY', 'REPARSE_POINT')) { return 'FAIL' }
    if ($DeleteHResult -isnot [int] -or $DeleteHResult -lt 0 -or
        $PostDeleteDecision -cne 'PASS' -or $candidateStatus -cne 'ABSENT') { return 'UNKNOWN' }
    return 'PASS'
}

function Get-ProfilePathDiagnosticCreateHResult($ErrorRecord) {
    $exception = if ($null -eq $ErrorRecord) { $null } else { $ErrorRecord.Exception }
    for ($depth = 0; $null -ne $exception -and $depth -lt 5; $depth++) {
        if ($null -ne $exception.Data -and $exception.Data.Contains('create_profile_hresult') -and
            $exception.Data['create_profile_hresult'] -is [int]) {
            return [int]$exception.Data['create_profile_hresult']
        }
        $exception = $exception.InnerException
    }
    return $null
}

function Get-ProfilePathDiagnosticExceptionType($ErrorRecord) {
    if ($null -eq $ErrorRecord -or $null -eq $ErrorRecord.Exception) { return 'OTHER' }
    return (Get-ProfileMappingReadOnlyFailureMetadata $ErrorRecord.Exception).failure_type
}

function Convert-ProfilePathDiagnosticSafeResult([string]$Status, [string]$Phase,
    [string]$ReportWriteStatus, [bool]$ReportWriteAttempted, [bool]$ReportPersisted,
    [int]$LastPersistedSequence, [bool]$ProfileCreateAttempted, [bool]$ReportPathReserved,
    [AllowNull()][string]$ReportRelativePath) {
    $safeStatuses = @('COMPLETE', 'FAIL', 'UNKNOWN')
    $safePhases = @(
        'FULL_TRUST_REQUIRED', 'PREPARATION_FAILED', 'REPORT_RESERVATION_FAILED',
        'REPORT_WRITE_FAILED',
        'CREATE_ATTEMPTED', 'CREATE_RESULT_UNKNOWN', 'CREATE_COLLISION', 'CREATE_FAILED',
        'PROFILE_PATH_RESOLVED', 'PROFILE_PATH_FAILED', 'SID_CONVERSION_FAILED',
        'DELETE_INTENT_PERSISTED', 'DELETE_INTENT_WRITE_FAILED', 'CLEANUP_NOT_ATTEMPTED',
        'DELETE_RETURNED', 'DELETE_FAILED', 'OBSERVATIONS_COMPLETE', 'UNEXPECTED_FAILURE', 'UNKNOWN'
    )
    $safeReportWriteStatuses = @('NOT_ATTEMPTED', 'PASS', 'FAIL', 'UNKNOWN')
    $safeStatus = if ($safeStatuses -ccontains $Status) { $Status } else { 'UNKNOWN' }
    $safePhase = if ($safePhases -ccontains $Phase) { $Phase } else { 'UNKNOWN' }
    $safeReportWriteStatus = if ($safeReportWriteStatuses -ccontains $ReportWriteStatus) {
        $ReportWriteStatus
    } else { 'UNKNOWN' }
    $safeRelativePathPattern = '^runtime/diagnostics/appcontainer-profile-path-[0-9a-f]{32}\.jsonl$'
    $safeReportPathReserved = $ReportPathReserved -and
        -not [string]::IsNullOrEmpty($ReportRelativePath) -and
        $ReportRelativePath -cmatch $safeRelativePathPattern
    $safeReportPersisted = $ReportPersisted -and $safeReportPathReserved
    $safeSequence = if ($safeReportPathReserved -and $LastPersistedSequence -ge 0) {
        $LastPersistedSequence
    } else { 0 }
    if (-not $safeReportPathReserved) {
        $safeReportWriteStatus = if ($ReportWriteAttempted) { $safeReportWriteStatus } else { 'NOT_ATTEMPTED' }
    }
    $safeReportPath = if ($safeReportPathReserved) { $ReportRelativePath } else { $null }

    return [pscustomobject][ordered]@{
        status = $safeStatus
        phase = $safePhase
        report_write_attempted = [bool]$ReportWriteAttempted
        report_write_status = $safeReportWriteStatus
        report_persisted = [bool]$safeReportPersisted
        last_persisted_sequence = [int]$safeSequence
        profile_create_attempted = [bool]$ProfileCreateAttempted
        report_path = $safeReportPath
    }
}

function Write-ProfilePathDiagnosticJournalSnapshot([string]$Path, [string]$RunId) {
    $reservationRequired = $null -eq $script:profilePathDiagnosticJournalStream
    $script:profilePathDiagnosticReportWriteAttempted = $false
    $script:profilePathDiagnosticReportPersisted = $false
    $script:profilePathDiagnosticReportWriteStatus = 'NOT_ATTEMPTED'
    $script:profilePathDiagnosticJournalFailurePhase = $null
    $script:report.report_write_attempted = $false
    $script:report.report_persisted = $false
    $script:report.last_persisted_sequence = [int]$script:profilePathDiagnosticLastPersistedSequence
    $script:report.report_write_status = 'NOT_ATTEMPTED'

    if ($reservationRequired) {
        try {
            if ($RunId -cnotmatch '^[0-9a-f]{32}$') {
                throw 'The profile-path diagnostic run ID is invalid.'
            }
            $expectedName = 'appcontainer-profile-path-' + $RunId + '.jsonl'
            $null = Assert-NoReparsePath $diagnosticsRoot
            $canonicalRoot = [System.IO.Path]::GetFullPath($diagnosticsRoot).TrimEnd('\') + '\'
            $canonicalPath = [System.IO.Path]::GetFullPath($Path)
            $expectedPath = [System.IO.Path]::GetFullPath((Join-Path $diagnosticsRoot $expectedName))
            if (-not [string]::Equals($canonicalPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
                -not $canonicalPath.StartsWith($canonicalRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'The profile-path diagnostic journal path is invalid.'
            }
        } catch {
            $script:profilePathDiagnosticJournalFailurePhase = 'PREPARATION_FAILED'
            $script:profilePathDiagnosticReportWriteStatus = 'NOT_ATTEMPTED'
            $script:report.phase = 'PREPARATION_FAILED'
            $script:report.report_write_status = 'NOT_ATTEMPTED'
            throw
        }

        $script:profilePathDiagnosticReportWriteAttempted = $true
        $script:profilePathDiagnosticReportWriteStatus = 'PENDING'
        $script:report.report_write_attempted = $true
        $script:report.report_write_status = 'PENDING'
        try {
            $script:profilePathDiagnosticJournalStream = [System.IO.FileStream]::new(
                $canonicalPath, [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $script:profilePathDiagnosticReportPathReserved = $true
            $script:profilePathDiagnosticJournalRunId = $RunId
        } catch {
            $script:profilePathDiagnosticJournalFailurePhase = 'REPORT_RESERVATION_FAILED'
            $script:profilePathDiagnosticReportWriteStatus = 'FAIL'
            $script:report.phase = 'REPORT_RESERVATION_FAILED'
            $script:report.report_write_status = 'FAIL'
            throw
        }
    } else {
        $script:profilePathDiagnosticReportWriteAttempted = $true
        $script:profilePathDiagnosticReportWriteStatus = 'PENDING'
        $script:report.report_write_attempted = $true
        $script:report.report_write_status = 'PENDING'
    }

    $sequence = [int]($script:profilePathDiagnosticLastPersistedSequence + 1)
    try {
        $snapshot = [ordered]@{
            run_id = $script:profilePathDiagnosticJournalRunId
            schema_version = 1
            sequence = $sequence
            phase = $script:report.phase
            status = $script:report.status
            report = [ordered]@{}
        }
        foreach ($entry in $script:report.GetEnumerator()) {
            if ($entry.Key -notin @('report_persisted', 'report_write_status', 'last_persisted_sequence')) {
                $snapshot.report[$entry.Key] = $entry.Value
            }
        }
        $json = ConvertTo-Json -InputObject $snapshot -Depth 12 -Compress
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
        $script:profilePathDiagnosticJournalStream.Write($bytes, 0, $bytes.Length)
        $script:profilePathDiagnosticJournalStream.Flush($true)
    } catch {
        $script:profilePathDiagnosticJournalFailurePhase = 'REPORT_WRITE_FAILED'
        $script:profilePathDiagnosticReportWriteStatus = 'FAIL'
        $script:report.phase = 'REPORT_WRITE_FAILED'
        $script:report.report_write_status = 'FAIL'
        $script:report.report_persisted = $false
        throw
    }

    $script:profilePathDiagnosticLastPersistedSequence = $sequence
    $script:profilePathDiagnosticLastPersistedStatus = [string]$script:report.status
    $script:profilePathDiagnosticLastPersistedPhase = [string]$script:report.phase
    $script:profilePathDiagnosticReportPersisted = $true
    $script:profilePathDiagnosticReportWriteStatus = 'PASS'
    $script:report.report_write_status = 'PASS'
    $script:report.report_persisted = $true
    $script:report.last_persisted_sequence = $sequence
}

function Close-ProfilePathDiagnosticJournal {
    if ($null -eq $script:profilePathDiagnosticJournalStream) { return }
    $stream = $script:profilePathDiagnosticJournalStream
    $script:profilePathDiagnosticJournalStream = $null
    $script:profilePathDiagnosticJournalRunId = $null
    $stream.Dispose()
}

function Invoke-ProfilePathResolveTransaction([string]$ProfileName, [string]$Nonce,
    [string]$OwnerLocalAppData, [string]$ReportPath, [string]$ReportRelativePath,
    [System.Collections.IDictionary]$Operations,
    [string]$RunId = '0123456789abcdef0123456789abcdef') {
    $requiredOperations = @('WriteReport', 'CreateProfile', 'ResolveProfilePath', 'ObserveApi',
        'ScanRegistry', 'ObserveCandidate', 'GetCandidatePath', 'MatchApiCandidate',
        'SidMatchesName', 'DeleteProfile', 'PostDeleteScan', 'PostDeleteCandidate')
    if ($null -eq $Operations) { throw 'Diagnostic operations are required.' }
    foreach ($operationName in $requiredOperations) {
        if (-not $Operations.Contains($operationName) -or $Operations[$operationName] -isnot [scriptblock]) {
            throw 'Diagnostic operations are incomplete.'
        }
    }

    $profileSidText = $null
    $profilePath = $null
    $candidatePath = $null
    $createHResult = $null
    $createFailure = $null
    $deleteHResult = $null
    $deleteAttempted = $false
    $deleteIntentPersisted = $false
    $script:profilePathDiagnosticReportPersisted = $false
    $script:profilePathDiagnosticCreateAttempted = $false
    $script:profilePathDiagnosticJournalStream = $null
    $script:profilePathDiagnosticJournalRunId = $null
    $script:profilePathDiagnosticReportPathReserved = $false
    $script:profilePathDiagnosticReportWriteAttempted = $false
    $script:profilePathDiagnosticReportWriteStatus = 'NOT_ATTEMPTED'
    $script:profilePathDiagnosticLastPersistedSequence = [int]0
    $script:profilePathDiagnosticLastPersistedStatus = $null
    $script:profilePathDiagnosticLastPersistedPhase = $null
    $script:profilePathDiagnosticJournalFailurePhase = $null
    $script:report.report_write_attempted = $false
    $script:report.report_persisted = $false
    $script:report.last_persisted_sequence = [int]0
    $script:report.profile_create_attempted = $false

    $writeSnapshot = {
        $script:profilePathDiagnosticReportWriteAttempted = $false
        $script:profilePathDiagnosticReportPersisted = $false
        $script:profilePathDiagnosticReportWriteStatus = 'NOT_ATTEMPTED'
        $script:report.report_write_attempted = $false
        $script:report.report_persisted = $false
        $script:report.last_persisted_sequence = [int]$script:profilePathDiagnosticLastPersistedSequence
        $script:report.report_write_status = 'PENDING'
        $script:profilePathDiagnosticJournalFailurePhase = $null
        try {
            $null = & $Operations['WriteReport'] $ReportPath $RunId
            return $true
        } catch {
            $failurePhase = $script:profilePathDiagnosticJournalFailurePhase
            if ($failurePhase -notin @('PREPARATION_FAILED', 'REPORT_RESERVATION_FAILED', 'REPORT_WRITE_FAILED')) {
                $failurePhase = 'REPORT_WRITE_FAILED'
            }
            $script:profilePathDiagnosticJournalFailurePhase = $failurePhase
            $script:profilePathDiagnosticReportPersisted = $false
            $script:report.report_persisted = $false
            $script:report.last_persisted_sequence = [int]$script:profilePathDiagnosticLastPersistedSequence
            $script:report.phase = $failurePhase
            if ($failurePhase -ceq 'PREPARATION_FAILED') {
                $script:profilePathDiagnosticReportWriteStatus = 'NOT_ATTEMPTED'
                $script:report.report_write_status = 'NOT_ATTEMPTED'
            } else {
                $script:profilePathDiagnosticReportWriteStatus = 'FAIL'
                $script:report.report_write_status = 'FAIL'
            }
            return $false
        }
    }

    $newWriteFailureResult = {
        $failurePhase = $script:profilePathDiagnosticJournalFailurePhase
        if ($failurePhase -ceq 'REPORT_RESERVATION_FAILED') {
            $failureStatus = 'FAIL'; $failureWriteStatus = 'FAIL'
        } elseif ($failurePhase -ceq 'PREPARATION_FAILED') {
            $failureStatus = 'UNKNOWN'; $failureWriteStatus = 'NOT_ATTEMPTED'
        } else {
            $failurePhase = 'REPORT_WRITE_FAILED'; $failureStatus = 'UNKNOWN'; $failureWriteStatus = 'FAIL'
        }
        Convert-ProfilePathDiagnosticSafeResult $failureStatus $failurePhase $failureWriteStatus `
            ([bool]$script:profilePathDiagnosticReportWriteAttempted) $false `
            ([int]$script:profilePathDiagnosticLastPersistedSequence) `
            ([bool]$script:profilePathDiagnosticCreateAttempted) `
            ([bool]$script:profilePathDiagnosticReportPathReserved) $ReportRelativePath
    }

    $script:report.phase = 'CREATE_ATTEMPTED'
    if (-not (& $writeSnapshot)) {
        $script:report.status = if ($script:profilePathDiagnosticJournalFailurePhase -ceq 'REPORT_RESERVATION_FAILED') { 'FAIL' } else { 'UNKNOWN' }
        return & $newWriteFailureResult
    }

    try {
        $script:profilePathDiagnosticCreateAttempted = $true
        $script:report.profile_create_attempted = $true
        $createResult = & $Operations['CreateProfile'] $ProfileName
    } catch {
        $createFailure = $_
        $createResult = [pscustomobject]@{
            HResult = Get-ProfilePathDiagnosticCreateHResult $_
            Sid = $null
            FailureType = Get-ProfilePathDiagnosticExceptionType $_
        }
    }
    if ($null -eq $createResult -or $null -eq $createResult.PSObject.Properties['HResult'] -or
        $createResult.HResult -isnot [int]) {
        $script:report.profile_preexisted = 'UNKNOWN'
        $script:report.path_resolution_status = 'UNKNOWN'
        $script:report.registration_state_before_cleanup = 'UNKNOWN'
        $script:report.registration_state_after_cleanup = 'UNKNOWN'
        $script:report.phase = 'CREATE_RESULT_UNKNOWN'
        $script:report.create_hresult = $null
        $script:report.create_exception_type = if ($null -ne $createResult -and
            $null -ne $createResult.PSObject.Properties['FailureType']) { $createResult.FailureType } else {
            Get-ProfilePathDiagnosticExceptionType $createFailure
        }
        $script:report.cleanup_status = 'UNKNOWN'
        $script:report.status = 'UNKNOWN'
        if (-not (& $writeSnapshot)) { return & $newWriteFailureResult }
        return Convert-ProfilePathDiagnosticSafeResult $script:report.status $script:report.phase `
            $script:profilePathDiagnosticReportWriteStatus $script:profilePathDiagnosticReportWriteAttempted `
            $script:profilePathDiagnosticReportPersisted $script:profilePathDiagnosticLastPersistedSequence `
            $script:profilePathDiagnosticCreateAttempted $script:profilePathDiagnosticReportPathReserved $ReportRelativePath
    }

    $createHResult = [int]$createResult.HResult
    $profileSidText = if ($null -ne $createResult.PSObject.Properties['Sid']) { [string]$createResult.Sid } else { $null }
    $createFailure = if ($null -ne $createResult.PSObject.Properties['FailureRecord']) { $createResult.FailureRecord } else { $createFailure }
    $script:report.create_hresult = $createHResult
    $script:report.profile_sid = $profileSidText
    if ($createHResult -ne 0) {
        $script:report.profile_preexisted = if ($createHResult -eq -2147024713) { $true } else { 'UNKNOWN' }
        $script:report.path_resolution_status = 'UNKNOWN'
        $script:report.registration_state_before_cleanup = 'UNKNOWN'
        $script:report.registration_state_after_cleanup = 'UNKNOWN'
        $script:report.phase = if ($createHResult -eq -2147024713) { 'CREATE_COLLISION' } else { 'CREATE_FAILED' }
        $script:report.status = if ($createHResult -lt 0) { 'FAIL' } else { 'UNKNOWN' }
        $script:report.cleanup_status = 'UNKNOWN'
        $script:report.create_exception_type = if ($null -ne $createResult.PSObject.Properties['FailureType']) {
            $createResult.FailureType
        } else { $null }
        if (-not (& $writeSnapshot)) { return & $newWriteFailureResult }
        return Convert-ProfilePathDiagnosticSafeResult $script:report.status $script:report.phase `
            $script:profilePathDiagnosticReportWriteStatus $script:profilePathDiagnosticReportWriteAttempted `
            $script:profilePathDiagnosticReportPersisted $script:profilePathDiagnosticLastPersistedSequence `
            $script:profilePathDiagnosticCreateAttempted $script:profilePathDiagnosticReportPathReserved $ReportRelativePath
    }

    $script:report.profile_preexisted = $false
    if (-not (& $writeSnapshot)) { return & $newWriteFailureResult }
    if (-not [string]::IsNullOrEmpty($profileSidText)) {
        try {
            $profilePath = & $Operations['ResolveProfilePath'] $profileSidText $ProfileName $Nonce
            $script:report.profile_api_path = $profilePath
            $script:report.path_resolution_status = 'PASS'
            $script:report.phase = 'PROFILE_PATH_RESOLVED'
        } catch {
            $script:report.path_resolution_status = 'FAIL'
            $script:report.path_stage = Get-ProfilePathStage $_.Exception
            $script:report.path_exception_type = Get-ProfilePathDiagnosticExceptionType $_
            $script:report.phase = 'PROFILE_PATH_FAILED'
        }
    } else {
        $script:report.path_resolution_status = 'NOT_ATTEMPTED'
        $script:report.path_exception_type = if ($null -ne $createResult.PSObject.Properties['FailureType']) {
            $createResult.FailureType
        } else { Get-ProfilePathDiagnosticExceptionType $createFailure }
        $script:report.phase = 'SID_CONVERSION_FAILED'
    }
    $readOnlyObservations = Invoke-ProfileMappingReadOnlyObservations {
        & $Operations['ObserveApi'] $ProfileName
    } {
        & $Operations['ScanRegistry'] $ProfileName
    } {
        & $Operations['ObserveCandidate'] $OwnerLocalAppData $ProfileName
    }
    $api = $readOnlyObservations.api
    $preDeleteScan = $readOnlyObservations.registry
    $candidateObservation = $readOnlyObservations.candidate
    $apiObservationSucceeded = $api.SidDerivationHResult -is [int] -and
        $api.SidDerivationHResult -eq 0 -and $api.ApiHResult -is [int] -and
        $api.ApiHResult -eq 0 -and $api.PathPresent -is [bool] -and
        $api.PathPresent -and $null -eq $api.FailureType
    $script:report.api_observation_succeeded = [bool]$apiObservationSucceeded
    $preDeleteDecision = Get-ProfileRegistrationPreDeleteDecision $preDeleteScan
    $script:report.registration_state_before_cleanup = Get-ProfilePathDiagnosticRegistrationState $preDeleteScan
    $script:report.api_observation = [ordered]@{
        sid_derivation_hresult = $api.SidDerivationHResult
        api_hresult = $api.ApiHResult
        path_present = [bool]$api.PathPresent
        failure_type = $api.FailureType
        failure_code = $api.FailureCode
    }
    $script:report.registry_observation = [ordered]@{
        status = $preDeleteScan.status
        scan_complete = [bool]$preDeleteScan.scan_complete
        keys_visited = $preDeleteScan.keys_visited
        complete_match_count = $preDeleteScan.complete_match_count
        partial_match_count = $preDeleteScan.partial_match_count
        case_only_pair_count = $preDeleteScan.case_only_pair_count
        partial_missing_pair_count = $preDeleteScan.partial_missing_pair_count
        partial_different_pair_count = $preDeleteScan.partial_different_pair_count
        malformed_value_count = $preDeleteScan.malformed_value_count
        stability_status = $preDeleteScan.stability_status
        issue = $preDeleteScan.issue
        failure_phase = $preDeleteScan.failure_phase
        failure_type = $preDeleteScan.failure_type
        failure_code = $preDeleteScan.failure_code
    }
    $script:report.candidate_observation = [ordered]@{
        status = $candidateObservation.status
        shape_valid = [bool]$candidateObservation.shape_valid
        candidate_exists = $candidateObservation.candidate_exists
        candidate_is_directory = $candidateObservation.candidate_is_directory
        reparse_point = $candidateObservation.reparse_point
        failure_type = $candidateObservation.failure_type
        failure_code = $candidateObservation.failure_code
    }
    try {
        $candidatePath = & $Operations['GetCandidatePath'] $OwnerLocalAppData $ProfileName
        $script:report.profile_candidate_path = $candidatePath
        if (-not [string]::IsNullOrEmpty($profileSidText)) {
            $apiCandidate = & $Operations['MatchApiCandidate'] $profileSidText $ProfileName $Nonce $candidatePath
            if ($apiCandidate.ApiHResult -eq 0) {
                $script:report.api_candidate_match = [bool]$apiCandidate.CandidateMatched
            }
        }
    } catch {
        $script:report.api_candidate_match = $null
    }

    $sidMatchesName = $false
    if (-not [string]::IsNullOrEmpty($profileSidText)) {
        try { $sidMatchesName = [bool](& $Operations['SidMatchesName'] $profileSidText $ProfileName) }
        catch { $sidMatchesName = $false }
    }
    $script:report.sid_matches_name = [bool]$sidMatchesName
    $deleteDecision = Get-ProfilePathDiagnosticDeleteDecision `
        ($createHResult -eq 0 -and -not [string]::IsNullOrEmpty($profileSidText)) `
        $false ($script:report.path_resolution_status -ceq 'PASS') $apiObservationSucceeded $sidMatchesName `
        $true $preDeleteDecision $candidateObservation `
        ($script:report.api_candidate_match -eq $true) ([bool]$script:report.diagnostic_profile_path_write_attempted)
    if ($deleteDecision -ceq 'DELETE') {
        $script:report.phase = 'DELETE_INTENT_PERSISTED'
        $script:report.delete_intent_persisted = $false
        $script:report.registration_state_after_cleanup = $script:report.registration_state_before_cleanup
        try {
            if (-not (& $writeSnapshot)) {
                $script:report.delete_intent_persisted = $false
                $script:report.cleanup_status = 'NOT_ATTEMPTED'
                return & $newWriteFailureResult
            }
            $deleteIntentPersisted = $true
            $script:report.delete_intent_persisted = $true
        } catch {
            $script:report.report_write_status = 'FAIL'
            $script:report.delete_intent_persisted = $false
            $script:report.phase = 'DELETE_INTENT_WRITE_FAILED'
        }
        $deleteDecision = Get-ProfilePathDiagnosticDeleteDecision `
            ($createHResult -eq 0 -and -not [string]::IsNullOrEmpty($profileSidText)) `
            $false ($script:report.path_resolution_status -ceq 'PASS') $apiObservationSucceeded $sidMatchesName `
            $deleteIntentPersisted $preDeleteDecision $candidateObservation `
            ($script:report.api_candidate_match -eq $true) ([bool]$script:report.diagnostic_profile_path_write_attempted)
    } else {
        $script:report.phase = 'CLEANUP_NOT_ATTEMPTED'
    }
    $script:report.delete_decision = $deleteDecision

    if ($deleteDecision -ceq 'DELETE') {
        try {
            $deleteAttempted = $true
            $script:report.delete_attempted = $true
            $deleteHResult = & $Operations['DeleteProfile'] $ProfileName
            $script:report.delete_hresult = [int]$deleteHResult
            $script:report.phase = 'DELETE_RETURNED'
        } catch {
            $script:report.delete_attempted = [bool]$deleteAttempted
            $script:report.delete_hresult = $null
            $script:report.delete_exception_type = Get-ProfilePathDiagnosticExceptionType $_
            $script:report.phase = 'DELETE_FAILED'
        }
        try { $postDeleteScan = & $Operations['PostDeleteScan'] $ProfileName }
        catch { $postDeleteScan = New-ProfileMappingReadOnlyUnknownScan $_.Exception }
        $postDeleteDecision = Get-ProfileRegistrationPostDeleteDecision $postDeleteScan
        try { $postCandidateObservation = & $Operations['PostDeleteCandidate'] $OwnerLocalAppData $ProfileName }
        catch { $postCandidateObservation = New-ProfileMappingReadOnlyUnknownCandidate $_.Exception }
        $script:report.registration_state_after_cleanup = Get-ProfilePathDiagnosticRegistrationState $postDeleteScan
        $script:report.post_delete_observation = [ordered]@{
            registration_decision = $postDeleteDecision
            candidate_status = $postCandidateObservation.status
            candidate_exists = $postCandidateObservation.candidate_exists
            candidate_is_directory = $postCandidateObservation.candidate_is_directory
            reparse_point = $postCandidateObservation.reparse_point
            failure_type = $postCandidateObservation.failure_type
            failure_code = $postCandidateObservation.failure_code
        }
    } else {
        $postDeleteDecision = $preDeleteDecision
        $postCandidateObservation = $candidateObservation
        $script:report.registration_state_after_cleanup = $script:report.registration_state_before_cleanup
        $script:report.post_delete_observation = [ordered]@{
            registration_decision = $preDeleteDecision
            candidate_status = $candidateObservation.status
            candidate_exists = $candidateObservation.candidate_exists
            candidate_is_directory = $candidateObservation.candidate_is_directory
            reparse_point = $candidateObservation.reparse_point
        }
    }
    $script:report.cleanup_status = Get-ProfilePathDiagnosticCleanupStatus `
        $deleteAttempted $deleteHResult $postDeleteDecision $postCandidateObservation
    $script:report.phase = 'OBSERVATIONS_COMPLETE'
    if ($script:report.path_resolution_status -ceq 'PASS' -and
        $apiObservationSucceeded -and
        $script:report.cleanup_status -ceq 'PASS' -and
        $script:report.registration_state_after_cleanup -ceq 'ABSENT') {
        $script:report.status = 'COMPLETE'
    } elseif ($script:report.path_resolution_status -ceq 'FAIL' -or
        $script:report.cleanup_status -ceq 'FAIL') {
        $script:report.status = 'FAIL'
    } elseif ($createFailure -and $null -eq $profileSidText) {
        $script:report.status = 'FAIL'
    } else {
        $script:report.status = 'UNKNOWN'
    }
    $script:report.report_write_status = 'PENDING'
    if (-not (& $writeSnapshot)) { return & $newWriteFailureResult }
    return Convert-ProfilePathDiagnosticSafeResult $script:report.status $script:report.phase `
        $script:profilePathDiagnosticReportWriteStatus $script:profilePathDiagnosticReportWriteAttempted `
        $script:profilePathDiagnosticReportPersisted $script:profilePathDiagnosticLastPersistedSequence `
        $script:profilePathDiagnosticCreateAttempted $script:profilePathDiagnosticReportPathReserved $ReportRelativePath
}

function Invoke-ProfilePathResolveDiagnosticMode {
    $reportRunId = [Guid]::NewGuid().ToString('N')
    $reportRelativePath = 'runtime/diagnostics/appcontainer-profile-path-' + $reportRunId + '.jsonl'
    $diagnosticReportPath = Join-Path $diagnosticsRoot ('appcontainer-profile-path-' + $reportRunId + '.jsonl')
    $script:profilePathDiagnosticReportPath = $diagnosticReportPath
    $script:profilePathDiagnosticReportRelativePath = $reportRelativePath
    $diagnosticProfileName = 'AgentCP' + $nonce.Substring(0, 17)
    $ownerLocalAppData = $null
    $profileSidText = $null
    $profilePath = $null
    $candidatePath = $null
    $createHResult = $null
    $createFailure = $null
    $deleteHResult = $null
    $deleteAttempted = $false
    $deleteIntentPersisted = $false

    $script:report = [ordered]@{
        schema_version = 1
        generated_by = 'bench/isolation/run-probes.ps1'
        generated_at = [DateTime]::UtcNow.ToString('o')
        status = 'UNKNOWN'
        phase = 'PREPARING'
        profile_name = $diagnosticProfileName
        profile_sid = $null
        profile_api_path = $null
        profile_candidate_path = $null
        profile_preexisted = 'UNKNOWN'
        create_hresult = $null
        create_exception_type = $null
        caller_full_trust = $null
        path_resolution_status = 'NOT_RUN'
        path_stage = 'UNKNOWN'
        path_exception_type = $null
        api_observation = $null
        registry_observation = $null
        registration_state_before_cleanup = 'UNKNOWN'
        api_observation_succeeded = $false
        candidate_observation = $null
        api_candidate_match = $null
        sid_matches_name = $null
        diagnostic_profile_path_write_attempted = $false
        delete_decision = 'NOT_ATTEMPTED'
        delete_intent_persisted = $false
        delete_attempted = $false
        delete_hresult = $null
        delete_exception_type = $null
        registration_state_after_cleanup = 'UNKNOWN'
        post_delete_observation = $null
        cleanup_status = 'UNKNOWN'
        report_write_attempted = $false
        report_write_status = 'NOT_ATTEMPTED'
        report_persisted = $false
        last_persisted_sequence = [int]0
        profile_create_attempted = $false
    }

    try {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
            throw 'The AppContainer diagnostic supports Windows only.'
        }
        $null = Assert-NoReparsePath $repoRoot
        $null = Assert-NoReparsePath $PSScriptRoot
        $launcherSource = Read-ValidatedSource $PSScriptRoot $launcherPath
        Add-Type -TypeDefinition $launcherSource.Text -Language CSharp -ErrorAction Stop

        $callerFullTrust = [AppContainerLauncher]::IsCurrentProcessFullTrust()
        $script:report.caller_full_trust = [bool]$callerFullTrust
        if (-not $callerFullTrust) {
            $script:report.status = 'FAIL'
            $script:report.phase = 'FULL_TRUST_REQUIRED'
            $script:report.cleanup_status = 'UNKNOWN'
            return Convert-ProfilePathDiagnosticSafeResult 'FAIL' 'FULL_TRUST_REQUIRED' `
                'NOT_ATTEMPTED' $false $false 0 $false $false $null
        }

        $runtimeRoot = Join-Path $repoRoot 'runtime'
        $null = Ensure-SafeDirectory $repoRoot $runtimeRoot
        $null = Ensure-SafeDirectory $runtimeRoot $diagnosticsRoot
        $null = Assert-NoReparsePath $diagnosticsRoot
        $ownerLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        $script:report.profile_candidate_path = Join-Path $ownerLocalAppData ('Packages\' + $diagnosticProfileName + '\AC')
    } catch {
        $script:report.status = 'UNKNOWN'
        $script:report.phase = 'PREPARATION_FAILED'
        $script:report.create_exception_type = Get-ProfilePathDiagnosticExceptionType $_
        return Convert-ProfilePathDiagnosticSafeResult 'UNKNOWN' 'PREPARATION_FAILED' `
            'NOT_ATTEMPTED' $false $false 0 $false $false $null
    }

    $operations = @{
        WriteReport = { param($Path, $RunId) Write-ProfilePathDiagnosticJournalSnapshot $Path $RunId }
        CreateProfile = {
            param($ProfileName)
            $sid = $null
            try {
                $hresult = [AppContainerLauncher]::CreateProfileDiagnostic($ProfileName, [ref]$sid)
                return [pscustomobject]@{ HResult = [int]$hresult; Sid = $sid; FailureType = $null }
            } catch {
                return [pscustomobject]@{
                    HResult = Get-ProfilePathDiagnosticCreateHResult $_
                    Sid = $sid
                    FailureType = Get-ProfilePathDiagnosticExceptionType $_
                    FailureRecord = $_
                }
            }
        }
        ResolveProfilePath = {
            param($Sid, $ProfileName, $ProfileNonce)
            [AppContainerLauncher]::GetProfilePath($Sid, $ProfileName, $ProfileNonce)
        }
        ObserveApi = { param($ProfileName) [AppContainerLauncher]::ObserveProfileMappingReadOnly($ProfileName) }
        ScanRegistry = { param($ProfileName) Get-AppContainerProfileMappingScan $ProfileName }
        ObserveCandidate = {
            param($OwnerLocalAppData, $ProfileName)
            Get-ProfileMappingCandidatePathObservation $true $OwnerLocalAppData $ProfileName $null
        }
        GetCandidatePath = { param($OwnerLocalAppData, $ProfileName) Get-ProfileMappingCandidatePath $true $OwnerLocalAppData $ProfileName }
        MatchApiCandidate = {
            param($Sid, $ProfileName, $ProfileNonce, $CandidatePath)
            [AppContainerLauncher]::ObserveProfilePath($Sid, $ProfileName, $ProfileNonce, $CandidatePath)
        }
        SidMatchesName = { param($Sid, $ProfileName) [AppContainerLauncher]::ProfileSidMatchesName($Sid, $ProfileName) }
        DeleteProfile = { param($ProfileName) [AppContainerLauncher]::DeleteProfileDiagnostic($ProfileName) }
        PostDeleteScan = { param($ProfileName) Get-AppContainerProfileMappingScan $ProfileName }
        PostDeleteCandidate = {
            param($OwnerLocalAppData, $ProfileName)
            Get-ProfileMappingCandidatePathObservation $true $OwnerLocalAppData $ProfileName $null
        }
    }
    try {
        return Invoke-ProfilePathResolveTransaction $diagnosticProfileName $nonce $ownerLocalAppData `
            $diagnosticReportPath $reportRelativePath $operations $reportRunId
    } finally {
        Close-ProfilePathDiagnosticJournal
    }
}

if ($ProcessTokenChainDiagnosticOnly) {
    $WarningPreference = 'SilentlyContinue'
    $InformationPreference = 'SilentlyContinue'
    $safeResult = [pscustomobject][ordered]@{
        schema_version = 1
        status = 'UNKNOWN'
        stage = 'PROCESS_SNAPSHOT'
        truncated = $false
        processes = @()
    }
    try {
        $diagnosticLauncher = Read-ValidatedSource $PSScriptRoot $launcherPath
        Add-Type -TypeDefinition $diagnosticLauncher.Text -Language CSharp -ErrorAction Stop -WarningAction SilentlyContinue
        $rawResult = [AppContainerLauncher]::ReadProcessTokenChainDiagnostic()
        if ($null -eq $rawResult -or $rawResult.schema_version -ne 1) {
            throw 'Invalid diagnostic result.'
        }
        $allowedStages = @('PROCESS_SNAPSHOT', 'PROCESS_ENUMERATION', 'ANCESTRY_LINK', 'PROCESS_OPEN',
            'PROCESS_TIME', 'TOKEN_OPEN', 'TOKEN_APPCONTAINER', 'TOKEN_SID', 'PACKAGE_IDENTITY', 'COMPLETE')
        $allowedLinks = @('ROOT', 'VERIFIED', 'TRUNCATED', 'UNKNOWN')
        $allowedTokenStates = @('TRUE', 'FALSE', 'UNKNOWN')
        $allowedSidStates = @('PRESENT', 'ABSENT', 'UNKNOWN')
        $allowedPackageStates = @('PRESENT', 'NO_PACKAGE', 'UNKNOWN')
        $safeStage = [string]$rawResult.stage
        if ([Array]::IndexOf([string[]]$allowedStages, $safeStage) -lt 0) { $safeStage = 'PROCESS_SNAPSHOT' }
        $safeRows = [System.Collections.Generic.List[object]]::new()
        $rowsValid = $true
        foreach ($rawRow in @($rawResult.processes)) {
            if ($safeRows.Count -ge 9 -or $null -eq $rawRow) {
                $rowsValid = $false
                break
            }
            $depth = [int]$rawRow.depth
            if ($depth -lt 0 -or $depth -gt 8) {
                $rowsValid = $false
                $depth = $safeRows.Count
            }
            $link = [string]$rawRow.link_status
            $tokenState = [string]$rawRow.token_is_appcontainer
            $sidState = [string]$rawRow.appcontainer_sid_presence
            $packageState = [string]$rawRow.package_identity
            foreach ($pair in @(
                @{ Value = $link; Allowed = $allowedLinks },
                @{ Value = $tokenState; Allowed = $allowedTokenStates },
                @{ Value = $sidState; Allowed = $allowedSidStates },
                @{ Value = $packageState; Allowed = $allowedPackageStates }
            )) {
                if ([Array]::IndexOf([string[]]$pair.Allowed, [string]$pair.Value) -lt 0) { $rowsValid = $false }
            }
            if ([Array]::IndexOf([string[]]$allowedLinks, $link) -lt 0) { $link = 'UNKNOWN' }
            if ([Array]::IndexOf([string[]]$allowedTokenStates, $tokenState) -lt 0) { $tokenState = 'UNKNOWN' }
            if ([Array]::IndexOf([string[]]$allowedSidStates, $sidState) -lt 0) { $sidState = 'UNKNOWN' }
            if ([Array]::IndexOf([string[]]$allowedPackageStates, $packageState) -lt 0) { $packageState = 'UNKNOWN' }
            $safeRows.Add([pscustomobject][ordered]@{
                depth = $depth
                link_status = $link
                token_is_appcontainer = $tokenState
                appcontainer_sid_presence = $sidState
                package_identity = $packageState
            })
        }
        if (@($rawResult.processes).Count -gt 9) { $rowsValid = $false }
        $chainLinksComplete = $safeRows.Count -gt 0
        for ($rowIndex = 0; $rowIndex -lt $safeRows.Count; $rowIndex++) {
            $expectedLink = if ($rowIndex -eq ($safeRows.Count - 1)) { 'ROOT' } else { 'VERIFIED' }
            if ($safeRows[$rowIndex].link_status -cne $expectedLink) { $chainLinksComplete = $false }
        }
        $safeStatus = 'UNKNOWN'
        if ($rawResult.status -ceq 'COMPLETE' -and $safeStage -ceq 'COMPLETE' -and
            -not [bool]$rawResult.truncated -and $rowsValid -and $chainLinksComplete -and
            @($safeRows | Where-Object { $_.token_is_appcontainer -ceq 'UNKNOWN' -or
                $_.appcontainer_sid_presence -ceq 'UNKNOWN' -or $_.package_identity -ceq 'UNKNOWN' }).Count -eq 0) {
            $safeStatus = 'COMPLETE'
        } elseif ($rawResult.status -cne 'UNKNOWN') {
            $safeStage = 'PROCESS_SNAPSHOT'
        }
        $safeResult = [pscustomobject][ordered]@{
            schema_version = 1
            status = $safeStatus
            stage = $safeStage
            truncated = [bool]$rawResult.truncated
            processes = [object[]]$safeRows.ToArray()
        }
    } catch {
        $safeResult = [pscustomobject][ordered]@{
            schema_version = 1
            status = 'UNKNOWN'
            stage = 'PROCESS_SNAPSHOT'
            truncated = $false
            processes = @()
        }
    }
    $json = ConvertTo-Json -InputObject $safeResult -Depth 5 -Compress
    if ([System.Text.Encoding]::UTF8.GetByteCount($json) -gt 4096) {
        $json = '{"schema_version":1,"status":"UNKNOWN","stage":"PROCESS_SNAPSHOT","truncated":false,"processes":[]}'
        [Console]::Out.Write($json + "`n")
        exit 1
    }
    [Console]::Out.Write($json + "`n")
    if ($safeResult.status -ceq 'COMPLETE') { exit 0 }
    exit 1
}

if ($ProfileMappingReadOnlyDiagnosticOnly) {
    $WarningPreference = 'SilentlyContinue'
    $InformationPreference = 'SilentlyContinue'
    try {
        if ($SelfTest -or $PreflightOnly -or $ProtocolSmokeOnly -or
            $ProfileContractImportDiagnosticOnly -or $ProfileBootstrapDiagnosticOnly -or
            $ProfilePathResolveDiagnosticOnly -or $ProcessTokenChainDiagnosticOnly) {
            [Console]::Out.Write((ConvertTo-ProfileMappingReadOnlyJson ([pscustomobject]@{ status = 'ERROR'; reason = 'MODE_CONFLICT' })) + "`n")
            exit 1
        }
        if ([string]::IsNullOrEmpty($ProfileMappingReadOnlyProfileId)) {
            [Console]::Out.Write((ConvertTo-ProfileMappingReadOnlyJson ([pscustomobject]@{ status = 'ERROR'; reason = 'PROFILE_ID_REQUIRED' })) + "`n")
            exit 1
        }
        if (-not (Test-ProfileMappingReadOnlyProfileId $ProfileMappingReadOnlyProfileId)) {
            [Console]::Out.Write((ConvertTo-ProfileMappingReadOnlyJson ([pscustomobject]@{ status = 'ERROR'; reason = 'INVALID_PROFILE_ID' })) + "`n")
            exit 1
        }
        $diagnosticProfileName = $ProfileMappingReadOnlyProfileId
        $diagnosticLauncher = Read-ValidatedSource $PSScriptRoot $launcherPath
        Add-Type -TypeDefinition $diagnosticLauncher.Text -Language CSharp -ErrorAction Stop -WarningAction SilentlyContinue
        if (-not [AppContainerLauncher]::IsCurrentProcessFullTrust()) {
            [Console]::Out.Write((ConvertTo-ProfileMappingReadOnlyJson ([pscustomobject]@{ status = 'ERROR'; reason = 'FULL_TRUST_REQUIRED' })) + "`n")
            exit 1
        }
        $diagnosticObservations = Invoke-ProfileMappingReadOnlyObservations `
            { $apiResult = [AppContainerLauncher]::ObserveProfileMappingReadOnly($diagnosticProfileName); [pscustomobject]@{
                SidDerivationHResult = $apiResult.SidDerivationHResult; ApiHResult = $apiResult.ApiHResult
                PathPresent = [bool]$apiResult.PathPresent; FailureType = $null; FailureCode = $null
            } } `
            { Get-AppContainerProfileMappingScan $diagnosticProfileName -ReadOnlyDetails } `
            { $ownerLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData); `
                Get-ProfileMappingCandidatePathObservation $true $ownerLocalAppData $diagnosticProfileName $null }
        $diagnosticOutput = Convert-ProfileMappingReadOnlyOutput `
            $diagnosticObservations.api $diagnosticObservations.registry $diagnosticObservations.candidate
        $diagnosticJson = ConvertTo-ProfileMappingReadOnlyJson $diagnosticOutput
        [Console]::Out.Write($diagnosticJson + "`n")
        if ($diagnosticOutput.status -ceq 'COMPLETE' -and $diagnosticJson -cne '{"status":"ERROR","reason":"OUTPUT_LIMIT"}') { exit 0 }
        exit 1
    } catch {
        [Console]::Out.Write((ConvertTo-ProfileMappingReadOnlyJson ([pscustomobject]@{ status = 'ERROR'; reason = 'DIAGNOSTIC_FAILED' })) + "`n")
        exit 1
    }
}

if ($LoopbackConfigChildOnly) {
    try {
        $inputStream = [Console]::OpenStandardInput()
        $inputBuffer = New-Object byte[] 257
        $inputLength = 0
        while ($inputLength -lt $inputBuffer.Length) {
            $readCount = $inputStream.Read($inputBuffer, $inputLength, $inputBuffer.Length - $inputLength)
            if ($readCount -le 0) { break }
            $inputLength += $readCount
        }
        if ($inputLength -gt 256) { throw 'INPUT_LIMIT' }
        $inputText = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($inputBuffer, 0, $inputLength)
        if ($inputText -cnotmatch '\A\{"sid":"(S-1-15-2(?:-[0-9]{1,10}){1,14})"\}\n\z') { throw 'INPUT_SCHEMA' }
        $helperSid = [string]$Matches[1]
        $helperSidObject = [System.Security.Principal.SecurityIdentifier]::new($helperSid)
        if ($helperSidObject.Value -cne $helperSid) { throw 'INPUT_SID' }
        $childLauncherSource = Read-ValidatedSource $PSScriptRoot $launcherPath
        Add-Type -TypeDefinition $childLauncherSource.Text -Language CSharp -ErrorAction Stop -WarningAction SilentlyContinue
        if (-not [AppContainerLauncher]::IsCurrentProcessFullTrust()) { throw 'FULL_TRUST_REQUIRED' }
        $childObservation = [AppContainerLauncher]::ReadLoopbackConfigForAppContainer($helperSid)
        Write-LoopbackConfigChildOutput $childObservation
    } catch {
        Write-LoopbackConfigChildOutput ([pscustomobject]@{
            loopback_exemption = 'UNKNOWN'; entry_count = $null; error_code = [int]$_.Exception.HResult
            cleanup_status = 'UNKNOWN'; cleanup_error_code = $null
        })
    }
}

if ($SelfTest) {
    $phaseOnlyPrefix = ConvertFrom-WorkerProtocolOutput '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' 'process-tree'
    if (-not $phaseOnlyPrefix.schema_valid -or $null -ne $phaseOnlyPrefix.response -or
        $phaseOnlyPrefix.phase_markers.Count -ne 1 -or
        $phaseOnlyPrefix.phase_markers[0] -cne 'PROBE_REQUEST_RECEIVED') {
        throw 'Synthetic process-tree early-marker-prefix self-test failed.'
    }
    $emptyPhaseProtocol = ConvertFrom-WorkerProtocolOutput '' 'process-tree'
    if ($emptyPhaseProtocol.schema_valid -or $emptyPhaseProtocol.phase_markers.Count -ne 0) {
        throw 'Synthetic empty process-tree protocol self-test failed.'
    }
    $malformedPhaseProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' + "`n" + '{malformed}') 'process-tree'
    if ($malformedPhaseProtocol.schema_valid) { throw 'Synthetic malformed process-tree protocol self-test failed.' }

    $filesystemProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' + "`n" +
        '{"mode":"filesystem","workspace_read_write":true,"workspace_canary_absent":true,"canaries":{},"environment_keys":[]}') 'filesystem'
    $networkProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' + "`n" +
        '{"mode":"network","status":"UNKNOWN","code":"ETIMEDOUT"}') 'network'
    if (-not $filesystemProtocol.schema_valid -or -not $networkProtocol.schema_valid -or
        $filesystemProtocol.phase_markers.Count -ne 1 -or $networkProtocol.phase_markers.Count -ne 1) {
        throw 'Synthetic filesystem/network request-only marker self-test failed.'
    }
    if ((ConvertFrom-WorkerProtocolOutput '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' 'filesystem').schema_valid) {
        throw 'Synthetic missing filesystem response self-test failed.'
    }

    $treeResponse = [pscustomobject][ordered]@{
        mode = 'process-tree'
        child_spawn_status = 'PASS'
        child_spawn_code = 'NONE'
        child_worker_started = $true
        grandchild_spawn_status = 'PASS'
        grandchild_spawn_code = 'NONE'
        grandchild_worker_started = $true
        readiness_stage = 'READY'
        readiness_status = 'PASS'
        readiness_code = 'NONE'
        child_pid = 123
        grandchild_pid = 456
    }
    $treeResponseJson = $treeResponse | ConvertTo-Json -Compress -Depth 4
    $successfulTreeLines = @(
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}',
        '{"agentcp_stage":"PROCESS_TREE_REQUEST_DISPATCH"}',
        '{"agentcp_stage":"CHILD_SPAWN_CALL_BEGIN"}',
        '{"agentcp_stage":"CHILD_SPAWN_CALL_RETURN"}',
        '{"agentcp_stage":"CHILD_SPAWN_EVENT"}',
        '{"agentcp_stage":"CHILD_WORKER_START_WAIT"}',
        '{"agentcp_stage":"CHILD_WORKER_READY"}',
        '{"agentcp_stage":"GRANDCHILD_START_WAIT"}',
        '{"agentcp_stage":"CHILD_READINESS_RESPONSE"}',
        '{"agentcp_stage":"PROCESS_TREE_RESPONSE_BEGIN"}',
        $treeResponseJson,
        '{"agentcp_stage":"PROCESS_TREE_RESPONSE_FLUSHED"}'
    ) -join "`n"
    $successfulTreeProtocol = ConvertFrom-WorkerProtocolOutput $successfulTreeLines 'process-tree'
    if (-not $successfulTreeProtocol.schema_valid -or
        $successfulTreeProtocol.phase_markers.Count -ne 11 -or
        $successfulTreeProtocol.response.mode -cne 'process-tree') {
        throw 'Synthetic successful process-tree marker order self-test failed.'
    }
    $deadlineMultipleProcesses = Get-DeadlineJobObservation ([pscustomobject]@{
        DeadlineActiveProcesses = [uint32]2
        DeadlineQueryErrorCode = $null
    })
    $deadlineSingleProcess = Get-DeadlineJobObservation ([pscustomobject]@{
        DeadlineActiveProcesses = [uint32]1
        DeadlineQueryErrorCode = $null
    })
    $deadlineQueryFailure = Get-DeadlineJobObservation ([pscustomobject]@{
        DeadlineActiveProcesses = $null
        DeadlineQueryErrorCode = [int]5
    })
    if (-not (Test-ExactObjectKeys $deadlineMultipleProcesses @('deadline_active_processes', 'deadline_query_error_code')) -or
        $deadlineMultipleProcesses.deadline_active_processes -ne 2 -or
        $null -ne $deadlineMultipleProcesses.deadline_query_error_code -or
        $deadlineSingleProcess.deadline_active_processes -ne 1 -or
        $null -ne $deadlineSingleProcess.deadline_query_error_code -or
        $null -ne $deadlineQueryFailure.deadline_active_processes -or
        $deadlineQueryFailure.deadline_query_error_code -ne 5) {
        throw 'Synthetic process-tree deadline Job accounting self-test failed.'
    }
    $treeResponseBeforeBeginLines = @(
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}',
        '{"agentcp_stage":"PROCESS_TREE_REQUEST_DISPATCH"}',
        '{"agentcp_stage":"CHILD_SPAWN_CALL_BEGIN"}',
        '{"agentcp_stage":"CHILD_SPAWN_CALL_RETURN"}',
        '{"agentcp_stage":"CHILD_SPAWN_EVENT"}',
        '{"agentcp_stage":"CHILD_WORKER_START_WAIT"}',
        '{"agentcp_stage":"CHILD_WORKER_READY"}',
        '{"agentcp_stage":"GRANDCHILD_START_WAIT"}',
        '{"agentcp_stage":"CHILD_READINESS_RESPONSE"}',
        $treeResponseJson,
        '{"agentcp_stage":"PROCESS_TREE_RESPONSE_BEGIN"}',
        '{"agentcp_stage":"PROCESS_TREE_RESPONSE_FLUSHED"}'
    ) -join "`n"
    $treeResponseAfterFlushedLines = @(
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}',
        '{"agentcp_stage":"PROCESS_TREE_REQUEST_DISPATCH"}',
        '{"agentcp_stage":"CHILD_SPAWN_CALL_BEGIN"}',
        '{"agentcp_stage":"CHILD_SPAWN_CALL_RETURN"}',
        '{"agentcp_stage":"CHILD_SPAWN_EVENT"}',
        '{"agentcp_stage":"CHILD_WORKER_START_WAIT"}',
        '{"agentcp_stage":"CHILD_WORKER_READY"}',
        '{"agentcp_stage":"GRANDCHILD_START_WAIT"}',
        '{"agentcp_stage":"CHILD_READINESS_RESPONSE"}',
        '{"agentcp_stage":"PROCESS_TREE_RESPONSE_BEGIN"}',
        '{"agentcp_stage":"PROCESS_TREE_RESPONSE_FLUSHED"}',
        $treeResponseJson
    ) -join "`n"
    $treeResponseBeforeBegin = ConvertFrom-WorkerProtocolOutput $treeResponseBeforeBeginLines 'process-tree'
    $treeResponseAfterFlushed = ConvertFrom-WorkerProtocolOutput $treeResponseAfterFlushedLines 'process-tree'
    if ($treeResponseBeforeBegin.schema_valid -or $treeResponseAfterFlushed.schema_valid) {
        throw 'Synthetic process-tree response-position self-test failed.'
    }
    $validSpawnWaitPrefix = @(
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}',
        '{"agentcp_stage":"PROCESS_TREE_REQUEST_DISPATCH"}',
        '{"agentcp_stage":"CHILD_SPAWN_CALL_BEGIN"}',
        '{"agentcp_stage":"CHILD_SPAWN_CALL_RETURN"}',
        '{"agentcp_stage":"CHILD_SPAWN_EVENT"}',
        '{"agentcp_stage":"CHILD_WORKER_START_WAIT"}'
    ) -join "`n"
    if (-not (ConvertFrom-WorkerProtocolOutput $validSpawnWaitPrefix 'process-tree').schema_valid) {
        throw 'Synthetic process-tree valid early-stop branch self-test failed.'
    }
    $duplicateMarkerProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' + "`n" + '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}') 'process-tree'
    $outOfOrderMarkerProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' + "`n" + '{"agentcp_stage":"CHILD_SPAWN_CALL_BEGIN"}') 'process-tree'
    $impossibleBranchProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' + "`n" +
        '{"agentcp_stage":"PROCESS_TREE_REQUEST_DISPATCH"}' + "`n" +
        '{"agentcp_stage":"CHILD_SPAWN_CALL_BEGIN"}' + "`n" +
        '{"agentcp_stage":"CHILD_SPAWN_CALL_THROW"}' + "`n" +
        '{"agentcp_stage":"CHILD_SPAWN_EVENT"}') 'process-tree'
    if ($duplicateMarkerProtocol.schema_valid -or $outOfOrderMarkerProtocol.schema_valid -or
        $impossibleBranchProtocol.schema_valid) {
        throw 'Synthetic duplicate/out-of-order/impossible process-tree marker self-test failed.'
    }

    $privateMarkerText = 'C:\Users\private\secret.txt'
    $escapedPrivateMarkerText = $privateMarkerText.Replace('\', '\\')
    $invalidPhaseProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":"' + $escapedPrivateMarkerText + '"}' + "`n" + '{"mode":"process-tree"}') 'process-tree'
    $invalidPhaseJson = $invalidPhaseProtocol | ConvertTo-Json -Compress -Depth 5
    if ($invalidPhaseProtocol.schema_valid -or $invalidPhaseProtocol.phase_markers.Count -ne 0 -or
        $invalidPhaseJson.Contains($privateMarkerText)) {
        throw 'Synthetic process-tree marker rejection/redaction self-test failed.'
    }
    $nonStringMarkerProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":["PROBE_REQUEST_RECEIVED"]}') 'process-tree'
    if ($nonStringMarkerProtocol.schema_valid -or $nonStringMarkerProtocol.phase_markers.Count -ne 0) {
        throw 'Synthetic non-string process-tree marker self-test failed.'
    }
    $multipleResponseProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' + "`n" +
        '{"mode":"filesystem","workspace_read_write":true,"workspace_canary_absent":true,"canaries":{},"environment_keys":[]}' + "`n" +
        '{"mode":"filesystem","workspace_read_write":true,"workspace_canary_absent":true,"canaries":{},"environment_keys":[]}') 'filesystem'
    $malformedResponseProtocol = ConvertFrom-WorkerProtocolOutput (
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}' + "`n" + '{"mode":"filesystem"}') 'filesystem'
    if ($multipleResponseProtocol.schema_valid -or $malformedResponseProtocol.schema_valid) {
        throw 'Synthetic multiple/malformed worker response self-test failed.'
    }
    $tooManyPhaseLines = @(1..33 | ForEach-Object {
        '{"agentcp_stage":"PROBE_REQUEST_RECEIVED"}'
    }) -join "`n"
    $tooManyPhaseProtocol = ConvertFrom-WorkerProtocolOutput $tooManyPhaseLines 'process-tree'
    if ($tooManyPhaseProtocol.schema_valid -or $tooManyPhaseProtocol.phase_markers.Count -ne 32) {
        throw 'Synthetic process-tree marker count-bound self-test failed.'
    }

    $profilePackagesRootComparisonCases = @(
        [pscustomobject]@{ Actual = 'AC'; Expected = 'AC'; Matches = $true },
        [pscustomobject]@{ Actual = 'ac'; Expected = 'AC'; Matches = $true },
        [pscustomobject]@{ Actual = 'Unexpected'; Expected = 'AC'; Matches = $false }
    )
    foreach ($comparisonCase in $profilePackagesRootComparisonCases) {
        if ((Test-OrdinalIgnoreCasePathComponent $comparisonCase.Actual $comparisonCase.Expected) -ne $comparisonCase.Matches) {
            throw 'Synthetic profile packages-root component comparison self-test failed.'
        }
    }

    $syntheticNullOwnerProfileCanaryRoot = Get-OwnerProfileCanaryRoot $null 'synthetic-nonce'
    $syntheticOwnerProfileCanaryRoot = Get-OwnerProfileCanaryRoot `
        'C:\Users\SyntheticOwner\AppData\Local' 'synthetic-nonce'
    if ($null -ne $syntheticNullOwnerProfileCanaryRoot -or
        $syntheticOwnerProfileCanaryRoot -cne 'C:\Users\SyntheticOwner\AppData\Local\.appcontainer-probe-synthetic-nonce') {
        throw 'Synthetic owner-profile canary root derivation failed.'
    }

    $script:syntheticProfileApiCalls = 0
    $syntheticApiNotCalled = Invoke-ProfileBootstrapApiObservation { $false } {
        $script:syntheticProfileApiCalls++
        throw 'Synthetic private API value'
    }
    $syntheticApiValidationError = Invoke-ProfileBootstrapApiObservation { throw 'Synthetic private candidate path' } {
        $script:syntheticProfileApiCalls++
    }
    if ($syntheticApiNotCalled.candidate_validation -cne 'FAIL' -or
        $syntheticApiNotCalled.api_call -cne 'NOT_CALLED' -or $null -ne $syntheticApiNotCalled.api_hresult -or
        $syntheticApiValidationError.candidate_validation -cne 'FAIL' -or
        $syntheticApiValidationError.api_call -cne 'NOT_CALLED' -or $script:syntheticProfileApiCalls -ne 0) {
        throw 'Synthetic bootstrap candidate failure did not prevent the API call.'
    }
    $syntheticApiMissing = Invoke-ProfileBootstrapApiObservation { $true } {
        [pscustomobject]@{ ApiHResult = [int]-2147024894; CandidateMatched = $false }
    }
    $syntheticApiMatch = Invoke-ProfileBootstrapApiObservation { $true } {
        [pscustomobject]@{ ApiHResult = [int]0; CandidateMatched = $true }
    }
    $syntheticApiUnknown = Invoke-ProfileBootstrapApiObservation { $true } { throw 'Synthetic private API path' }
    if ($syntheticApiMissing.candidate_validation -cne 'PASS' -or $syntheticApiMissing.api_call -cne 'CALLED' -or
        $syntheticApiMissing.api_hresult -cne '0x80070002' -or $syntheticApiMissing.candidate_matched -ne $false -or
        $syntheticApiMatch.api_call -cne 'CALLED' -or $syntheticApiMatch.api_hresult -cne '0x00000000' -or
        $syntheticApiMatch.candidate_matched -ne $true -or $syntheticApiUnknown.api_call -cne 'UNKNOWN' -or
        $null -ne $syntheticApiUnknown.api_hresult -or $null -ne $syntheticApiUnknown.candidate_matched) {
        throw 'Synthetic bootstrap API observation classification failed.'
    }
    $syntheticApiJson = ConvertTo-Json -InputObject @($syntheticApiValidationError, $syntheticApiUnknown) -Compress
    if ($syntheticApiJson -match 'Synthetic private') { throw 'Synthetic bootstrap API observation exposed exception text.' }
    if (-not (Test-DenialCode 'EACCES') -or -not (Test-DenialCode 'EPERM') -or
        (Test-DenialCode 'ENOENT') -or (Test-DenialCode 'ECONNREFUSED')) {
        throw 'Synthetic denial classification self-test failed.'
    }
    if ((Get-AccessProbeStatus ([pscustomobject]@{ status = 'DENIED'; code = 'EACCES' })) -ne 'PASS' -or
        (Get-AccessProbeStatus ([pscustomobject]@{ status = 'ALLOWED'; code = 'READ_ALLOWED' })) -ne 'FAIL' -or
        (Get-AccessProbeStatus ([pscustomobject]@{ status = 'UNKNOWN'; code = 'ENOENT' })) -ne 'UNKNOWN') {
        throw 'Synthetic access probe status self-test failed.'
    }
    if ((Get-ProbeFinalStatus @('PASS', 'PASS')) -ne 'PASS' -or
        (Get-ProbeFinalStatus @('PASS', 'UNKNOWN')) -ne 'BLOCKED' -or
        (Get-ProbeFinalStatus @('PASS', 'FAIL')) -ne 'FAIL') {
        throw 'Synthetic cleanup/status decision self-test failed.'
    }
    $syntheticFailure = [ordered]@{ phase = 'synthetic' }
    if ((Get-ProbeReportFinalStatus $false $true $null @('PASS', 'PASS')) -cne 'PASS' -or
        (Get-ProbeReportFinalStatus $false $false $null @('PASS', 'PASS')) -cne 'BLOCKED' -or
        (Get-ProbeReportFinalStatus $false $true $syntheticFailure @('PASS', 'PASS')) -cne 'BLOCKED' -or
        (Get-ProbeReportFinalStatus $false $true $null @('PASS', 'UNKNOWN')) -cne 'BLOCKED' -or
        (Get-ProbeReportFinalStatus $false $true $null @('PASS', 'FAIL')) -cne 'FAIL' -or
        (Get-ProbeReportFinalStatus $true $true $null @('PASS', 'PASS')) -cne 'BLOCKED') {
        throw 'Synthetic final report status self-test failed.'
    }
    $launcherSourceForSelfTest = Read-ValidatedSource $PSScriptRoot $launcherPath
    Add-Type -TypeDefinition $launcherSourceForSelfTest.Text -Language CSharp -ErrorAction Stop
    $null = [AppContainerLauncher]::TokenCapabilitiesSyntheticSelfTest()
    $null = [AppContainerLauncher]::LoopbackConfigSyntheticSelfTest()
    $null = [AppContainerLauncher]::ProcessTreeTimeoutSnapshotSyntheticSelfTest()
    $syntheticLoopbackSid = 'S-1-15-2-3141592653-2718281828'
    $syntheticLoopbackOutput = '{"schema_version":1,"loopback_exemption":"ABSENT","entry_count":0,"error_code":null,"cleanup_status":"PASS","cleanup_error_code":null}' + "`n"
    $syntheticLoopbackRun = [pscustomobject]@{
        ProcessCreated = $true; TimedOut = $false; OutputTruncated = $false; RootProcessSignaled = $true
        JobDrained = $true; CleanupConfirmed = $true; ExitCode = 0; Stdout = $syntheticLoopbackOutput
    }
    $syntheticLoopbackParsed = ConvertFrom-LoopbackConfigHelperOutput $syntheticLoopbackRun
    $syntheticLoopbackUnknown = ConvertFrom-LoopbackConfigHelperOutput ([pscustomobject]@{
        ProcessCreated = $true; TimedOut = $true; OutputTruncated = $false; RootProcessSignaled = $true
        JobDrained = $true; CleanupConfirmed = $true; ExitCode = 124; Stdout = ''
    })
    $syntheticLoopbackUncertain = ConvertFrom-LoopbackConfigHelperOutput ([pscustomobject]@{
        ProcessCreated = $true; TimedOut = $true; OutputTruncated = $false; RootProcessSignaled = $false
        JobDrained = $false; CleanupConfirmed = $false; ExitCode = $null; Stdout = ''
    })
    $syntheticLoopbackInvalid = ConvertFrom-LoopbackConfigHelperOutput ([pscustomobject]@{
        ProcessCreated = $true; TimedOut = $false; OutputTruncated = $false; RootProcessSignaled = $true
        JobDrained = $true; CleanupConfirmed = $true; ExitCode = 0
        Stdout = '{"schema_version":1,"loopback_exemption":"PRESENT","entry_count":0,"error_code":null,"cleanup_status":"PASS","cleanup_error_code":null,"sid":"' + $syntheticLoopbackSid + '"}' + "`n"
    })
    $syntheticNetworkEvidence = [pscustomobject]@{
        worker_attempted = $true
        worker_token_verified = $true
        job_membership_verified = $true
        capability_query_status = 'PASS'
        network_capability_count = [uint32]0
        capabilities_error_code = 0
        loopback_helper_status = 'VALID'
        loopback_exemption = 'ABSENT'
        host_control_status = 'PASS'
        target_matches_listener = $true
        listener_accepted = $false
        worker_transport_status = 'COMPLETE'
        observation = [pscustomobject]@{ status = 'DENIED'; code = 'EPERM' }
    }
    $syntheticNetworkEvidenceJson = ConvertTo-Json -InputObject ([ordered]@{
        network_policy_status = (Get-NetworkPolicyStatus $syntheticNetworkEvidence)
        network_capability_query_status = $syntheticNetworkEvidence.capability_query_status
        network_capability_count = $syntheticNetworkEvidence.network_capability_count
        network_capabilities_error_code = $syntheticNetworkEvidence.capabilities_error_code
        target_matches_listener = $syntheticNetworkEvidence.target_matches_listener
    }) -Compress
    if ($syntheticLoopbackParsed.status -cne 'VALID' -or $syntheticLoopbackParsed.exemption -cne 'ABSENT' -or
        $syntheticLoopbackUnknown.status -cne 'UNKNOWN' -or $syntheticLoopbackUnknown.uncertain -or
        -not $syntheticLoopbackUncertain.uncertain -or -not $syntheticLoopbackInvalid.invalid -or
        (Get-HostLoopbackControlStatus $true $true $false) -cne 'PASS' -or
        (Get-HostLoopbackControlStatus $false $false $false) -cne 'UNKNOWN' -or
        (Get-HostLoopbackControlStatus $true $false $true) -cne 'UNKNOWN' -or
        (Get-NetworkPolicyStatus $syntheticNetworkEvidence) -cne 'PASS' -or
        (Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'PASS') {
        throw 'Synthetic loopback helper, host-control, network status, or redaction self-test failed.'
    }
    $syntheticNetworkEvidence.observation = [pscustomobject]@{ status = 'UNKNOWN'; code = 'ETIMEDOUT' }
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'PASS') {
        throw 'Synthetic timeout with complete network policy evidence did not pass.'
    }
    $syntheticNetworkEvidence.listener_accepted = $true
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'FAIL') {
        throw 'Synthetic accepted worker connection did not fail.'
    }
    $syntheticNetworkEvidence.listener_accepted = $false
    $syntheticNetworkEvidence.observation = [pscustomobject]@{ status = 'ALLOWED'; code = 'CONNECTED' }
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'FAIL') {
        throw 'Synthetic connected worker transport did not fail.'
    }
    $syntheticNetworkEvidence.observation = [pscustomobject]@{ status = 'DENIED'; code = 'EPERM' }
    $syntheticNetworkEvidence.network_capability_count = [uint32]1
    if ((Get-NetworkPolicyStatus $syntheticNetworkEvidence) -cne 'FAIL' -or
        (Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'FAIL') {
        throw 'Synthetic positive network-capability evidence did not fail closed.'
    }
    $syntheticNetworkEvidence.network_capability_count = [uint32]0
    $syntheticNetworkEvidence.loopback_exemption = 'PRESENT'
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic loopback exemption did not remain unknown.'
    }
    $syntheticNetworkEvidence.loopback_exemption = 'ABSENT'
    $syntheticNetworkEvidence.capability_query_status = 'UNKNOWN'
    $syntheticNetworkEvidence.network_capability_count = $null
    $syntheticNetworkEvidence.capabilities_error_code = 5
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic failed capability derivation did not remain unknown.'
    }
    $syntheticNetworkEvidence.capability_query_status = 'PASS'
    $syntheticNetworkEvidence.network_capability_count = [uint32]0
    $syntheticNetworkEvidence.capabilities_error_code = 0
    $syntheticNetworkEvidence.worker_token_verified = $false
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic unverified worker token did not remain unknown.'
    }
    $syntheticNetworkEvidence.worker_token_verified = $true
    $syntheticNetworkEvidence.job_membership_verified = $false
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic unverified Job membership did not remain unknown.'
    }
    $syntheticNetworkEvidence.job_membership_verified = $true
    $syntheticNetworkEvidence.loopback_helper_status = 'UNKNOWN'
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic incomplete loopback helper evidence did not remain unknown.'
    }
    $syntheticNetworkEvidence.loopback_helper_status = 'VALID'
    $syntheticNetworkEvidence.host_control_status = 'UNKNOWN'
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic failed host control did not remain unknown.'
    }
    $syntheticNetworkEvidence.host_control_status = 'PASS'
    $syntheticNetworkEvidence.target_matches_listener = $false
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic mismatched listener target did not remain unknown.'
    }
    $syntheticNetworkEvidence.target_matches_listener = $true
    $syntheticNetworkEvidence.worker_transport_status = 'UNKNOWN'
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic incomplete worker transport did not remain unknown.'
    }
    $syntheticNetworkEvidence.worker_transport_status = 'COMPLETE'
    $syntheticNetworkEvidence.worker_attempted = $false
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic skipped worker did not remain unknown.'
    }
    $syntheticNetworkEvidence.worker_attempted = $true
    $syntheticNetworkEvidence.observation = [pscustomobject]@{ status = 'DENIED'; code = 'ENOENT' }
    if ((Get-NetworkDeniedStatus $syntheticNetworkEvidence) -cne 'UNKNOWN' -or
        $syntheticNetworkEvidenceJson -match 'S-1-|internetClient|privateNetworkClientServer|internetClientServer' -or
        (ConvertTo-Json -InputObject $syntheticLoopbackParsed -Compress).Contains($syntheticLoopbackSid)) {
        throw 'Synthetic network classification or report-redaction self-test failed.'
    }
    $tokenChainSyntheticResult = [AppContainerLauncher]::ProcessTokenChainSyntheticSelfTest()
    $tokenChainSyntheticJson = ConvertTo-Json -InputObject $tokenChainSyntheticResult -Depth 5 -Compress
    $tokenChainSyntheticParsed = ConvertFrom-Json -InputObject $tokenChainSyntheticJson -ErrorAction Stop
    $tokenChainTopKeys = @($tokenChainSyntheticParsed.PSObject.Properties.Name | Sort-Object) -join ','
    if ($tokenChainTopKeys -cne 'processes,schema_version,stage,status,truncated' -or
        $tokenChainSyntheticParsed.schema_version -ne 1 -or
        $tokenChainSyntheticParsed.status -cne 'COMPLETE' -or
        $tokenChainSyntheticParsed.stage -cne 'COMPLETE' -or
        [bool]$tokenChainSyntheticParsed.truncated -or
        @($tokenChainSyntheticParsed.processes).Count -gt 9 -or
        $tokenChainSyntheticJson -match '424242|313131|S-1-|ProcessId|ParentProcessId') {
        throw 'Synthetic process token-chain schema or redaction self-test failed.'
    }
    foreach ($tokenChainRow in @($tokenChainSyntheticParsed.processes)) {
        $tokenChainRowKeys = @($tokenChainRow.PSObject.Properties.Name | Sort-Object) -join ','
        if ($tokenChainRowKeys -cne 'appcontainer_sid_presence,depth,link_status,package_identity,token_is_appcontainer') {
            throw 'Synthetic process token-chain row contains unexpected fields.'
        }
    }
    $syntheticProfilePathStages = @('NONCE', 'SID_NAME', 'API', 'CANONICAL', 'SUFFIX', 'REPARSE')
    $syntheticProfilePathStageExceptions = [ordered]@{}
    foreach ($syntheticStage in $syntheticProfilePathStages) {
        $syntheticStageException = [AppContainerLauncher]::CreateProfilePathStageSelfTestException(
            $syntheticStage, ($syntheticStage -ceq 'API'))
        $syntheticProfilePathStageExceptions[$syntheticStage] = $syntheticStageException
        $syntheticStageWrapper = [System.Exception]::new('Synthetic outer wrapper.', $syntheticStageException)
        $syntheticStageRecord = [System.Management.Automation.ErrorRecord]::new(
            $syntheticStageWrapper, 'SyntheticProfilePathStage',
            [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
        Set-Diagnostic 'profile-path-resolve' $syntheticStageRecord 1
        if ($report.diagnostic.profile_path_stage -cne $syntheticStage -or
            $report.diagnostic.exception_type -cne 'Exception' -or
            $report.diagnostic.inner_exception_type -cne 'InvalidOperationException' -or
            ($syntheticStage -ceq 'API' -and $report.diagnostic.api_hresult -ne -2147024894) -or
            ($syntheticStage -cne 'API' -and $null -ne $report.diagnostic.api_hresult)) {
            throw 'Synthetic profile path stage propagation self-test failed.'
        }
    }
    $syntheticMalformedStageException = [System.InvalidOperationException]::new('Synthetic private malformed value.')
    $syntheticMalformedStageException.Data['profile_path_stage'] = 'AgentCP0123456789abcdef0'
    $syntheticMalformedStageWrapper = [System.Exception]::new(
        'Synthetic outer wrapper.', $syntheticMalformedStageException)
    $syntheticMalformedStageRecord = [System.Management.Automation.ErrorRecord]::new(
        $syntheticMalformedStageWrapper, 'SyntheticMalformedProfilePathStage',
        [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
    Set-Diagnostic 'profile-path-resolve' $syntheticMalformedStageRecord 1
    $syntheticMalformedStageJson = $report.diagnostic | ConvertTo-Json -Compress
    if ($report.diagnostic.profile_path_stage -cne 'UNKNOWN' -or
        $syntheticMalformedStageJson.Contains('AgentCP0123456789abcdef0') -or
        $syntheticMalformedStageJson.Contains('Synthetic private')) {
        throw 'Malformed profile path stage metadata was accepted or exposed.'
    }
    $syntheticAbsentStageException = [System.InvalidOperationException]::new('Synthetic private missing stage.')
    $syntheticAbsentStageWrapper = [System.Exception]::new(
        'Synthetic outer wrapper.', $syntheticAbsentStageException)
    $syntheticAbsentStageRecord = [System.Management.Automation.ErrorRecord]::new(
        $syntheticAbsentStageWrapper, 'SyntheticAbsentProfilePathStage',
        [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
    Set-Diagnostic 'profile-path-resolve' $syntheticAbsentStageRecord 1
    $syntheticAbsentStageJson = $report.diagnostic | ConvertTo-Json -Compress
    if ($report.diagnostic.profile_path_stage -cne 'UNKNOWN' -or
        $syntheticAbsentStageJson.Contains('Synthetic private')) {
        throw 'Missing profile path stage metadata was not UNKNOWN or was exposed.'
    }
    $syntheticMappingPhases = @('ROOT', 'MONITOR', 'STACK', 'OPEN_CHILD', 'VALUE', 'ENUMERATE', 'STABILITY')
    $syntheticMappingExceptions = @(
        [System.UnauthorizedAccessException]::new('Synthetic private path and value'),
        [System.Security.SecurityException]::new('Synthetic private path and value'),
        [System.IO.IOException]::new('Synthetic private path and value'),
        [System.ComponentModel.Win32Exception]::new(5, 'Synthetic private path and value'),
        [System.ArgumentException]::new('Synthetic private path and value'),
        [System.InvalidOperationException]::new('Synthetic private path and value'),
        [System.Management.Automation.RuntimeException]::new('Synthetic private path and value')
    )
    $syntheticMappingTypes = @('UnauthorizedAccessException', 'SecurityException', 'IOException',
        'Win32Exception', 'ArgumentException', 'InvalidOperationException', 'RuntimeException')
    $script:profileMappingSelfTestActive = $true
    $script:profileMappingSelfTestCleanupFailure = $null
    for ($mappingIndex = 0; $mappingIndex -lt $syntheticMappingPhases.Count; $mappingIndex++) {
        $script:profileMappingSelfTestFailurePhase = $syntheticMappingPhases[$mappingIndex]
        $script:profileMappingSelfTestException = $syntheticMappingExceptions[$mappingIndex]
        $syntheticMappingScan = Get-AppContainerProfileMappingScan 'AgentCP0123456789abcdef0'
        $syntheticMappingJson = $syntheticMappingScan | ConvertTo-Json -Compress
        if ($syntheticMappingScan.status -cne 'UNKNOWN' -or $syntheticMappingScan.scan_complete -or
            $syntheticMappingScan.issue -cne 'READ_FAILED' -or
            $syntheticMappingScan.failure_phase -cne $syntheticMappingPhases[$mappingIndex] -or
            $syntheticMappingScan.failure_type -cne $syntheticMappingTypes[$mappingIndex] -or
            $syntheticMappingScan.failure_code -isnot [int] -or
            (Get-ProfileRegistrationPreDeleteDecision $syntheticMappingScan) -cne 'UNKNOWN' -or
            (Get-ProfileRegistrationPostDeleteDecision $syntheticMappingScan) -cne 'UNKNOWN' -or
            $syntheticMappingJson.Contains('Synthetic private path and value') -or
            $syntheticMappingJson.Contains('AgentCP0123456789abcdef0')) {
            throw ('Synthetic profile mapping failure diagnostics self-test failed: phase=' +
                $syntheticMappingPhases[$mappingIndex] + '; observed_phase=' + $syntheticMappingScan.failure_phase +
                '; observed_type=' + $syntheticMappingScan.failure_type + '; status=' + $syntheticMappingScan.status)
        }
    }
    $script:profileMappingSelfTestFailurePhase = 'ROOT'
    $script:profileMappingSelfTestException = [System.NotSupportedException]::new('Synthetic private path and value')
    $syntheticUnknownMappingFailure = Get-AppContainerProfileMappingScan 'AgentCP0123456789abcdef0' -ReadOnlyDetails
    if ($syntheticUnknownMappingFailure.failure_type -cne 'OTHER' -or
        (Get-ProfileRegistrationPreDeleteDecision $syntheticUnknownMappingFailure) -cne 'UNKNOWN') {
        throw 'Synthetic unknown profile mapping exception self-test failed.'
    }
    $script:profileMappingSelfTestFailurePhase = 'NONE'
    $syntheticCompleteScan = Get-AppContainerProfileMappingScan 'AgentCP0123456789abcdef0' -ReadOnlyDetails
    if ($syntheticCompleteScan.status -cne 'COMPLETE' -or -not $syntheticCompleteScan.scan_complete -or
        $syntheticCompleteScan.keys_visited -ne 1 -or $syntheticCompleteScan.failure_phase -cne 'NONE' -or
        (Get-ProfileRegistrationPreDeleteDecision $syntheticCompleteScan) -cne 'PASS') {
        throw 'Synthetic complete profile mapping scan self-test failed.'
    }
    $syntheticDefaultScan = Get-AppContainerProfileMappingScan 'AgentCP0123456789abcdef0'
    if ($syntheticDefaultScan.PSObject.Properties['display_name_exact_match_count']) {
        throw 'Synthetic default scan exposed read-only detail fields to the full-run shape.'
    }
    $syntheticProfileId = 'AgentCP0123456789abcdef0'
    if (-not (Test-ProfileMappingReadOnlyProfileId $syntheticProfileId)) {
        throw 'Synthetic valid explicit profile identifier self-test failed.'
    }
    foreach ($invalidProfileId in @(
            $null, '', 'AgentCP0123456789ABCDEf0', ('AgentCP0123456789abcdef0' + "`n"),
            'AgentCP0123456789abcdef00', 'AgentCP0123456789abcdef')) {
        if (Test-ProfileMappingReadOnlyProfileId $invalidProfileId) {
            throw 'Synthetic invalid explicit profile identifier self-test failed.'
        }
    }
    $syntheticApi = [pscustomobject]@{
        SidDerivationHResult = [int]0; ApiHResult = [int]0; PathPresent = $true
        FailureType = $null; FailureCode = $null; Path = 'Synthetic private path'; Sid = 'Synthetic private SID'
    }
    $syntheticCandidate = [pscustomobject]@{
        status = 'PRESENT'; shape_valid = $true; candidate_exists = $true
        candidate_is_directory = $true; reparse_point = $false; failure_type = $null; failure_code = $null
    }
    $syntheticOwnerLocalAppData = 'C:\Users\Owner\AppData\Local'
    $syntheticCandidatePath = Get-ProfileMappingCandidatePath $true $syntheticOwnerLocalAppData $syntheticProfileId
    $syntheticPathParts = @($syntheticCandidatePath.Substring(
        [System.IO.Path]::GetPathRoot($syntheticCandidatePath).Length) -split '[\\/]')
    $presentPathObservation = Get-ProfileMappingCandidatePathObservation $true $syntheticOwnerLocalAppData `
        $syntheticProfileId { param($Path) [System.IO.FileAttributes]::Directory }
    if ($presentPathObservation.status -cne 'PRESENT' -or -not $presentPathObservation.shape_valid -or
        -not $presentPathObservation.candidate_exists -or -not $presentPathObservation.candidate_is_directory -or
        $presentPathObservation.reparse_point -or $presentPathObservation.PSObject.Properties['candidate_path']) {
        throw 'Synthetic present candidate path observation self-test failed.'
    }
    foreach ($blockKind in @('ABSENT', 'NOT_DIRECTORY', 'REPARSE_POINT', 'INACCESSIBLE')) {
        for ($blockIndex = 0; $blockIndex -lt $syntheticPathParts.Count; $blockIndex++) {
            $script:syntheticPathReadCount = 0
            $script:syntheticPathBlockIndex = $blockIndex
            $script:syntheticPathBlockKind = $blockKind
            $reader = {
                param($Path)
                $currentIndex = $script:syntheticPathReadCount
                $script:syntheticPathReadCount++
                if ($currentIndex -eq $script:syntheticPathBlockIndex) {
                    switch ($script:syntheticPathBlockKind) {
                        'ABSENT' { throw [System.IO.FileNotFoundException]::new('Synthetic private path') }
                        'NOT_DIRECTORY' { return [System.IO.FileAttributes]::Normal }
                        'REPARSE_POINT' { return [System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint }
                        'INACCESSIBLE' { throw [System.UnauthorizedAccessException]::new('Synthetic private path') }
                    }
                }
                return [System.IO.FileAttributes]::Directory
            }
            $pathObservation = Get-ProfileMappingCandidatePathObservation $true $syntheticOwnerLocalAppData `
                $syntheticProfileId $reader
            $pathObservationJson = ConvertTo-Json -InputObject $pathObservation -Compress
            $expectedPathStatus = switch ($blockKind) {
                'ABSENT' { 'ABSENT' }
                'NOT_DIRECTORY' { 'NOT_DIRECTORY' }
                'REPARSE_POINT' { 'REPARSE_POINT' }
                'INACCESSIBLE' { 'UNKNOWN' }
            }
            if ($pathObservation.status -cne $expectedPathStatus -or -not $pathObservation.shape_valid -or
                $script:syntheticPathReadCount -ne ($blockIndex + 1) -or
                $pathObservationJson -match 'Users|Owner|AgentCP|AppData|Packages') {
                throw ('Synthetic candidate path stop condition failed: ' + $blockKind)
            }
        }
    }
    $script:syntheticReadOnlyObservationOrder = [System.Collections.Generic.List[string]]::new()
    $syntheticIndependentObservations = Invoke-ProfileMappingReadOnlyObservations `
        { $script:syntheticReadOnlyObservationOrder.Add('api'); throw [System.InvalidOperationException]::new('Synthetic private API path') } `
        { $script:syntheticReadOnlyObservationOrder.Add('registry'); $syntheticCompleteScan } `
        { $script:syntheticReadOnlyObservationOrder.Add('candidate'); $syntheticCandidate }
    if (($script:syntheticReadOnlyObservationOrder -join ',') -cne 'api,registry,candidate' -or
        $syntheticIndependentObservations.api.FailureType -cne 'InvalidOperationException' -or
        $syntheticIndependentObservations.registry.status -cne 'COMPLETE' -or
        $syntheticIndependentObservations.candidate.status -cne 'PRESENT') {
        throw 'Synthetic API failure suppressed independent read-only observations.'
    }
    $syntheticIndependentOutput = Convert-ProfileMappingReadOnlyOutput `
        $syntheticIndependentObservations.api $syntheticIndependentObservations.registry `
        $syntheticIndependentObservations.candidate
    if ($syntheticIndependentOutput.status -cne 'UNKNOWN' -or
        $syntheticIndependentOutput.api_failure_type -cne 'InvalidOperationException') {
        throw 'Synthetic API failure was not safely represented in the read-only output.'
    }
    $syntheticOutput = Convert-ProfileMappingReadOnlyOutput $syntheticApi $syntheticCompleteScan $syntheticCandidate
    $syntheticOutputJson = ConvertTo-ProfileMappingReadOnlyJson $syntheticOutput
    if ($syntheticOutput.status -cne 'COMPLETE' -or
        [System.Text.Encoding]::UTF8.GetByteCount($syntheticOutputJson) + 1 -gt 4096 -or
        $syntheticOutputJson.Contains('Synthetic private') -or
        $syntheticOutputJson.Contains('AgentCP0123456789abcdef0')) {
        throw 'Synthetic bounded profile diagnostic output self-test failed.'
    }
    $syntheticApi.ApiHResult = [int]-2147024894
    $syntheticApi.PathPresent = $false
    if ((Convert-ProfileMappingReadOnlyOutput $syntheticApi $syntheticCompleteScan $syntheticCandidate).status -cne 'UNKNOWN' -or
        (Convert-ProfileMappingReadOnlyOutput $syntheticApi $syntheticUnknownMappingFailure $syntheticCandidate).status -cne 'UNKNOWN') {
        throw 'Synthetic inconclusive profile diagnostic self-test failed.'
    }
    $invalidScan = [pscustomobject]@{ status = 'Synthetic private path' }
    $invalidScanRejected = $false
    try { $null = Convert-ProfileMappingReadOnlyOutput $syntheticApi $invalidScan $syntheticCandidate } catch { $invalidScanRejected = $true }
    $emptyDiagnosticJson = ConvertTo-Json -InputObject ([pscustomobject]@{ payload = '' }) -Compress
    $exactPayloadLength = 4095 - [System.Text.Encoding]::UTF8.GetByteCount($emptyDiagnosticJson)
    $exactDiagnosticJson = ConvertTo-ProfileMappingReadOnlyJson ([pscustomobject]@{ payload = ('x' * $exactPayloadLength) })
    $overDiagnosticJson = ConvertTo-ProfileMappingReadOnlyJson ([pscustomobject]@{ payload = ('x' * ($exactPayloadLength + 1)) })
    if (-not $invalidScanRejected -or
        [System.Text.Encoding]::UTF8.GetByteCount($exactDiagnosticJson) + 1 -ne 4096 -or
        $overDiagnosticJson -cne '{"status":"ERROR","reason":"OUTPUT_LIMIT"}' -or
        (ConvertTo-ProfileMappingReadOnlyJson ([pscustomobject]@{ payload = ('x' * 4096) })) -cne
            '{"status":"ERROR","reason":"OUTPUT_LIMIT"}') {
        throw 'Synthetic profile diagnostic sanitization self-test failed.'
    }
    foreach ($cleanupPhase in @('OPEN_CHILD', 'MONITOR', 'ROOT')) {
        $script:profileMappingSelfTestCleanupFailure = $cleanupPhase
        $script:profileMappingSelfTestException = [System.IO.IOException]::new('Synthetic private path and value')
        $syntheticCleanupFailure = Get-AppContainerProfileMappingScan 'AgentCP0123456789abcdef0'
        if ($syntheticCleanupFailure.status -cne 'UNKNOWN' -or $syntheticCleanupFailure.scan_complete -or
            $syntheticCleanupFailure.issue -cne 'READ_FAILED' -or
            $syntheticCleanupFailure.failure_phase -cne $cleanupPhase -or
            $syntheticCleanupFailure.failure_type -cne 'IOException' -or
            (Get-ProfileRegistrationPreDeleteDecision $syntheticCleanupFailure) -cne 'UNKNOWN' -or
            (Get-ProfileRegistrationPostDeleteDecision $syntheticCleanupFailure) -cne 'UNKNOWN' -or
            (($syntheticCleanupFailure | ConvertTo-Json -Compress).Contains('Synthetic private path and value'))) {
            throw 'Synthetic profile mapping cleanup failure self-test failed.'
        }
    }
    $script:profileMappingSelfTestActive = $false
    $script:profileMappingSelfTestCleanupFailure = $null
    $script:profileMappingSelfTestFailurePhase = $null
    $script:profileMappingSelfTestException = $null
    if ([AppContainerLauncher]::GetDeadlineDecision($true, [uint32]0) -cne 'completed_at_deadline' -or
        [AppContainerLauncher]::GetDeadlineDecision($true, [uint32]1) -cne 'active_processes_terminate' -or
        [AppContainerLauncher]::GetDeadlineDecision($false, [uint32]0) -cne 'query_failed_terminate') {
        throw 'Synthetic Job Object deadline decision self-test failed.'
    }
    if ([AppContainerLauncher]::GetJobDrainDecision($true, [uint32]0) -cne 'drained' -or
        [AppContainerLauncher]::GetJobDrainDecision($true, [uint32]1) -cne 'active' -or
        [AppContainerLauncher]::GetJobDrainDecision($false, [uint32]0) -cne 'query_failed') {
        throw 'Synthetic Job ActiveProcesses drain decision self-test failed.'
    }
    $newSyntheticJobMemberEvidence = {
        $evidence = New-Object JobMemberSnapshotEvidence
        $evidence.QuerySucceeded = $true
        $evidence.QueryComplete = $true
        $evidence.AssignedCount = 2
        $evidence.ReturnedCount = 2
        $evidence.JobSetStable = $true
        $evidence.OpenCount = 2
        $evidence.MembershipVerifiedCount = 2
        $evidence.MetadataSnapshotComplete = $true
        return $evidence
    }
    $stableJobMemberEvidence = & $newSyntheticJobMemberEvidence
    $membershipMismatchEvidence = & $newSyntheticJobMemberEvidence
    $membershipMismatchEvidence.MembershipMismatch = $true
    $unstableJobSetEvidence = & $newSyntheticJobMemberEvidence
    $unstableJobSetEvidence.JobSetStable = $false
    $failedHandleEvidence = & $newSyntheticJobMemberEvidence
    $failedHandleEvidence.OpenCount = 1
    $failedImageEvidence = & $newSyntheticJobMemberEvidence
    $failedImageEvidence.MetadataSnapshotComplete = $false
    $unknownImageEvidence = & $newSyntheticJobMemberEvidence
    $unknownImageEvidence.MetadataUnknownCount = 1
    $overflowJobMemberEvidence = & $newSyntheticJobMemberEvidence
    $overflowJobMemberEvidence.AssignedCount = 9
    $overflowJobMemberEvidence.ReturnedCount = 9
    $overflowJobMemberEvidence.OpenCount = 9
    $overflowJobMemberEvidence.MembershipVerifiedCount = 9
    if ([AppContainerLauncher]::GetJobMemberSnapshotStatus($stableJobMemberEvidence) -cne 'COMPLETE' -or
        [AppContainerLauncher]::GetJobMemberSnapshotStatus($membershipMismatchEvidence) -cne 'UNKNOWN' -or
        [AppContainerLauncher]::GetJobMemberSnapshotStatus($unstableJobSetEvidence) -cne 'UNKNOWN' -or
        [AppContainerLauncher]::GetJobMemberSnapshotStatus($failedHandleEvidence) -cne 'UNKNOWN' -or
        [AppContainerLauncher]::GetJobMemberSnapshotStatus($failedImageEvidence) -cne 'UNKNOWN' -or
        [AppContainerLauncher]::GetJobMemberSnapshotStatus($unknownImageEvidence) -cne 'UNKNOWN' -or
        [AppContainerLauncher]::GetJobMemberSnapshotStatus($overflowJobMemberEvidence) -cne 'UNKNOWN') {
        throw 'Synthetic bounded Job member snapshot decision self-test failed.'
    }
    $syntheticJobMemberResult = [pscustomobject]@{
        JobMemberDiagnosticsStatus = 'COMPLETE'; JobMemberJobSetStable = $true
        JobMemberQueryErrorCode = $null; JobMemberCleanupErrorCode = 0
        JobMemberAssignedCount = [uint32]2; JobMemberReturnedCount = [uint32]2
        JobMemberOpenCount = [uint32]2; JobMemberMembershipVerifiedCount = [uint32]2
        JobMemberNotInJobCount = [uint32]0; JobMemberMembershipUnknownCount = [uint32]0
        JobMemberNodeImageCount = [uint32]1; JobMemberConsoleHostImageCount = [uint32]1
        JobMemberCommandShellImageCount = [uint32]0; JobMemberOtherImageCount = [uint32]0
        JobMemberImageUnknownCount = [uint32]0; JobMemberMetadataUnknownCount = [uint32]0
        ProcessId = [uint32]394857; ImageName = 'C:\private\node.exe'
        ProfileId = 'AgentCP0123456789abcdef0'; Sid = 'S-1-15-2-private'
    }
    $syntheticJobMemberObservation = Get-JobMemberSnapshotObservation $syntheticJobMemberResult
    $syntheticJobMemberJson = $syntheticJobMemberObservation | ConvertTo-Json -Compress -Depth 4
    $syntheticJobMemberKeys = @($syntheticJobMemberObservation.PSObject.Properties.Name)
    $expectedJobMemberKeys = @(
        'status', 'job_set_stable', 'query_error_code', 'cleanup_error_code',
        'assigned_count', 'returned_count', 'open_count', 'membership_verified_count',
        'not_in_job_count', 'membership_unknown_count', 'node_image_count',
        'console_host_image_count', 'command_shell_image_count', 'other_image_count',
        'image_unknown_count', 'metadata_unknown_count'
    )
    if (($syntheticJobMemberKeys -join ',') -cne ($expectedJobMemberKeys -join ',') -or
        $syntheticJobMemberJson.Contains('394857') -or
        $syntheticJobMemberJson.Contains('C:\private\node.exe') -or
        $syntheticJobMemberJson.Contains('AgentCP0123456789abcdef0') -or
        $syntheticJobMemberJson.Contains('S-1-15-2-private')) {
        throw 'Synthetic Job member snapshot output redaction self-test failed.'
    }
    $syntheticChildPid = 1345678901
    $syntheticGrandchildPid = 1987654321
    $syntheticTreeObservation = [pscustomobject]@{
        child_spawn_status = 'PASS'; child_spawn_code = 'NONE'; child_worker_started = $true
        grandchild_spawn_status = 'PASS'; grandchild_spawn_code = 'NONE'; grandchild_worker_started = $true
        readiness_stage = 'READY'; readiness_status = 'PASS'; readiness_code = 'NONE'
        child_pid = $syntheticChildPid; grandchild_pid = $syntheticGrandchildPid
    }
    $syntheticTreeDiagnosticResult = [pscustomobject]@{
        ProcessTreeStage = 'CLEANUP'; ProcessTreeFailureStage = 'JOB_SNAPSHOT'
        ProcessTreeFailureExceptionType = 'ArgumentException'; ProcessTreeFailureHResult = [int]-2147024809
        ProcessTreeFailureWin32Code = $null; ProcessTreeStatus = 'UNKNOWN'
        ProcessTreeCleanupFailureStage = 'JOB_TERMINATION'
        ProcessTreeCleanupFailureExceptionType = 'Win32Exception'
        ProcessTreeCleanupFailureHResult = [int]5; ProcessTreeCleanupFailureWin32Code = [int]5
        ProcessId = [uint32]394857; ImageName = 'C:\private\node.exe'
        ExceptionMessage = 'Synthetic private exception message'; ProfileId = 'AgentCP0123456789abcdef0'
    }
    $syntheticTreeDiagnostic = Get-ProcessTreeDiagnosticObservation $syntheticTreeDiagnosticResult
    $syntheticIncompleteTreeResult = [pscustomobject]@{
        ProcessTreeStatus = 'UNKNOWN'; JobMemberDiagnosticsStatus = 'UNKNOWN'
    }
    $syntheticCompleteTreeResult = [pscustomobject]@{
        ProcessTreeStatus = 'COMPLETE'; JobMemberDiagnosticsStatus = 'COMPLETE'
    }
    if ((Test-ProcessTreeMemberEvidenceComplete $syntheticIncompleteTreeResult) -or
        -not (Test-ProcessTreeMemberEvidenceComplete $syntheticCompleteTreeResult)) {
        throw 'Synthetic process-tree completeness gate accepted incomplete member evidence.'
    }
    $syntheticOuterTreeReport = New-ProcessTreeReportObservation `
        $true $true ([pscustomobject]@{ deadline_active_processes = [uint32]2; deadline_query_error_code = $null }) `
        ([pscustomobject]@{ status = 'COMPLETE' }) $true @('PROBE_REQUEST_RECEIVED') $true `
        $syntheticTreeObservation $true $true $syntheticChildPid $true $syntheticGrandchildPid `
        $true $true 1234 $true $true $syntheticTreeDiagnostic
    $syntheticOuterTreeJson = $syntheticOuterTreeReport | ConvertTo-Json -Compress -Depth 8
    $syntheticOuterTreeKeys = @($syntheticOuterTreeReport.Keys)
    if ($syntheticOuterTreeJson.Contains([string]$syntheticChildPid) -or
        $syntheticOuterTreeJson.Contains([string]$syntheticGrandchildPid) -or
        $syntheticOuterTreeKeys -ccontains 'child_pid' -or
        $syntheticOuterTreeKeys -ccontains 'grandchild_pid' -or
        $syntheticOuterTreeReport.child_pid_valid -ne $true -or
        $syntheticOuterTreeReport.grandchild_pid_valid -ne $true -or
        $syntheticOuterTreeReport.process_tree_diagnostic.failure_stage -cne 'JOB_SNAPSHOT' -or
        $syntheticOuterTreeReport.process_tree_diagnostic.exception_type -cne 'ArgumentException' -or
        $syntheticOuterTreeReport.process_tree_diagnostic.status -cne 'UNKNOWN' -or
        $syntheticOuterTreeReport.process_tree_diagnostic.cleanup_failure_stage -cne 'JOB_TERMINATION' -or
        $syntheticOuterTreeReport.process_tree_diagnostic.cleanup_exception_type -cne 'Win32Exception' -or
        $syntheticOuterTreeReport.process_tree_diagnostic.cleanup_win32_code -ne 5 -or
        $syntheticOuterTreeJson.Contains('C:\private\node.exe') -or
        $syntheticOuterTreeJson.Contains('AgentCP0123456789abcdef0') -or
        $syntheticOuterTreeJson.Contains('Synthetic private exception message') -or
        $syntheticOuterTreeReport.process_ids_distinct -ne $true -or
        $syntheticOuterTreeReport.child_pid_absent_after_drain -ne $true -or
        $syntheticOuterTreeReport.grandchild_pid_absent_after_drain -ne $true) {
        throw 'Synthetic process-tree outer report redaction self-test failed.'
    }
    if ([AppContainerLauncher]::GetDeadlineWaitMilliseconds(0, 100) -ne 25 -or
        [AppContainerLauncher]::GetDeadlineWaitMilliseconds(88, 100) -ne 12 -or
        [AppContainerLauncher]::GetDeadlineWaitMilliseconds(101, 100) -ne 0) {
        throw 'Synthetic Job Object deadline wait-budget self-test failed.'
    }
    if ([AppContainerLauncher]::GetTraverseAccessDecision($true, $true) -cne 'ALLOW' -or
        [AppContainerLauncher]::GetTraverseAccessDecision($true, $false) -cne 'DENY' -or
        [AppContainerLauncher]::GetTraverseAccessDecision($false, $true) -cne 'UNKNOWN' -or
        [AppContainerLauncher]::GetAccessCheckDecision($true, $true) -cne 'ALLOW' -or
        [AppContainerLauncher]::GetAccessCheckDecision($true, $false) -cne 'DENY' -or
        [AppContainerLauncher]::GetAccessCheckDecision($false, $true) -cne 'UNKNOWN') {
        throw 'Synthetic FILE_TRAVERSE AccessCheck decision self-test failed.'
    }
    $syntheticTokenDiagnostic = Convert-AppContainerTokenDiagnostic ([pscustomobject]@{
        AppContainerTokenVerified = $true
        SeChangeNotifyPrivilegeQuerySucceeded = $true
        SeChangeNotifyPrivilegePresent = $true
        SeChangeNotifyPrivilegeEnabled = $true
        DirectoryTraverseDiagnostics = @(
            [pscustomobject]@{ Label = 'volume_root'; Status = 'ALLOW'; ReadAttributesStatus = 'DENY' },
            [pscustomobject]@{ Label = 'runRoot'; Status = 'DENY'; ReadAttributesStatus = 'ALLOW' },
            [pscustomobject]@{ Label = 'ancestor_000'; Status = 'ALLOW'; ReadAttributesStatus = 'DENY' },
            [pscustomobject]@{ Label = 'D:\private\secret'; Status = 'ALLOW'; ReadAttributesStatus = 'ALLOW' },
            [pscustomobject]@{ Label = 'stageRoot'; Status = 'unsupported'; ReadAttributesStatus = 'unsupported' },
            [pscustomobject]@{ Label = 'volume_root'; Status = 'ALLOW'; ReadAttributesStatus = 'ALLOW' }
        )
    }) @('volume_root', 'runRoot', 'ancestor_000', 'stageRoot', 'toolsRoot')
    $syntheticTokenDiagnosticJson = $syntheticTokenDiagnostic | ConvertTo-Json -Depth 5 -Compress
    $syntheticAncestorKeys = @($syntheticTokenDiagnostic.directory_ancestors[2].Keys | ForEach-Object { [string]$_ } | Sort-Object)
    if ($syntheticTokenDiagnostic.directory_ancestors.Count -ne 5 -or
        $syntheticTokenDiagnostic.directory_ancestors[0].status -cne 'UNKNOWN' -or
        $syntheticTokenDiagnostic.directory_ancestors[0].read_attributes_status -cne 'UNKNOWN' -or
        $syntheticTokenDiagnostic.directory_ancestors[1].status -cne 'DENY' -or
        $syntheticTokenDiagnostic.directory_ancestors[1].read_attributes_status -cne 'ALLOW' -or
        $syntheticTokenDiagnostic.directory_ancestors[2].status -cne 'ALLOW' -or
        $syntheticTokenDiagnostic.directory_ancestors[2].read_attributes_status -cne 'DENY' -or
        $syntheticTokenDiagnostic.directory_ancestors[3].status -cne 'UNKNOWN' -or
        $syntheticTokenDiagnostic.directory_ancestors[3].read_attributes_status -cne 'UNKNOWN' -or
        $syntheticTokenDiagnostic.directory_ancestors[4].status -cne 'UNKNOWN' -or
        $syntheticTokenDiagnostic.directory_ancestors[4].read_attributes_status -cne 'UNKNOWN' -or
        $syntheticTokenDiagnostic.directory_ancestors[0].label -cne 'volume_root' -or
        $syntheticTokenDiagnostic.directory_ancestors[2].label -cne 'ancestor_000' -or
        $syntheticTokenDiagnostic.directory_ancestors[4].label -cne 'toolsRoot' -or
        $syntheticTokenDiagnostic.directory_read_attributes_method -notmatch 'AccessCheck\(FILE_READ_ATTRIBUTES\)' -or
        $syntheticTokenDiagnostic.directory_traverse_method -notmatch 'AccessCheck\(FILE_TRAVERSE\)' -or
        ($syntheticAncestorKeys -join ',') -cne 'label,read_attributes_status,status' -or
        $syntheticTokenDiagnosticJson.Contains('D:\private\secret') -or
        $syntheticTokenDiagnosticJson.Contains('S-1-')) {
        throw 'Synthetic AppContainer token diagnostics privacy/status self-test failed.'
    }
    $syntheticStagedFileDiagnostic = Convert-StagedFileReadDiagnostic ([pscustomobject]@{
        AppContainerTokenVerified = $true
        StagedFileReadDiagnostics = @(
            [pscustomobject]@{ Label = 'workerModule'; ReadAttributesStatus = 'ALLOW'; ReadDataStatus = 'DENY' },
            [pscustomobject]@{ Label = 'probeContract'; ReadAttributesStatus = 'unsupported'; ReadDataStatus = 'ALLOW' },
            [pscustomobject]@{ Label = 'C:\private\staged-secret.mjs'; ReadAttributesStatus = 'ALLOW'; ReadDataStatus = 'ALLOW' }
        )
    }) @('workerModule', 'probeContract')
    $syntheticStagedFileDiagnosticJson = $syntheticStagedFileDiagnostic | ConvertTo-Json -Depth 5 -Compress
    if ($syntheticStagedFileDiagnostic.files.Count -ne 2 -or
        $syntheticStagedFileDiagnostic.files[0].read_attributes -cne 'ALLOW' -or
        $syntheticStagedFileDiagnostic.files[0].read_data -cne 'DENY' -or
        $syntheticStagedFileDiagnostic.files[1].read_attributes -cne 'UNKNOWN' -or
        $syntheticStagedFileDiagnostic.files[1].read_data -cne 'ALLOW' -or
        $syntheticStagedFileDiagnosticJson.Contains('C:\private\staged-secret.mjs') -or
        $syntheticStagedFileDiagnosticJson.Contains('S-1-')) {
        throw 'Synthetic staged file AccessCheck privacy/status self-test failed.'
    }
    $syntheticStagedReadResponse = [ordered]@{
        schema_version = 1
        files = @(
            [ordered]@{
                label = 'workerModule'
                lstat = [ordered]@{ operation = 'lstat'; status = 'PASS'; error_code = $null }
                read = [ordered]@{ operation = 'read'; status = 'PASS'; error_code = $null }
            },
            [ordered]@{
                label = 'probeContract'
                lstat = [ordered]@{ operation = 'lstat'; status = 'PASS'; error_code = $null }
                read = [ordered]@{ operation = 'read'; status = 'DENIED'; error_code = 'EACCES' }
            }
        )
        ancestor_chain = [ordered]@{ operation = 'ancestor_chain'; status = 'PASS'; error_code = $null }
        ancestors = @(
            [ordered]@{ label = 'ancestor00'; lstat = @('lstat', 'PASS', $null); realpath = @('realpath', 'PASS', $null) },
            [ordered]@{ label = 'ancestor01'; lstat = @('lstat', 'PASS', $null); realpath = @('realpath', 'PASS', $null) }
        )
        import = [ordered]@{ operation = 'import'; status = 'SKIPPED'; error_code = 'NOT_RUN'; syscall = $null; path_label = $null }
    } | ConvertTo-Json -Depth 8 -Compress
    $syntheticStagedReadRun = [pscustomobject]@{
        TimedOut = $false
        ExitCode = 0
        OutputTruncated = $false
        RootProcessSignaled = $true
        JobDrained = $true
        WorkerTokenVerified = $true
        AppContainerCapabilitiesStatus = 'PASS'
        AppContainerCapabilityCount = [uint32]0
        AppContainerCapabilitiesErrorCode = 0
        JobMembershipVerified = $true
        DurationMs = 25
        Stdout = $syntheticStagedReadResponse
        Stderr = 'synthetic stderr with C:\private\no-report.txt'
    }
    $syntheticStagedReadObservation = Convert-StagedNodeReadDiagnosticObservation $syntheticStagedReadRun
    $syntheticStagedReadObservationJson = $syntheticStagedReadObservation | ConvertTo-Json -Depth 8 -Compress
    if ($syntheticStagedReadObservation.response_status -cne 'VALID' -or
        $syntheticStagedReadObservation.files.Count -ne 2 -or
        $syntheticStagedReadObservation.files[0].label -cne 'workerModule' -or
        $syntheticStagedReadObservation.files[1].read.status -cne 'DENIED' -or
        $syntheticStagedReadObservation.ancestor_chain.status -cne 'PASS' -or
        $syntheticStagedReadObservation.ancestors.Count -ne 2 -or
        $syntheticStagedReadObservation.ancestors[1].realpath.status -cne 'PASS' -or
        $syntheticStagedReadObservation.import.status -cne 'SKIPPED' -or
        $syntheticStagedReadObservationJson.Contains('C:\private\no-report.txt') -or
        $syntheticStagedReadObservationJson.Contains($syntheticStagedReadRun.Stderr) -or
        $syntheticStagedReadObservationJson.Contains('S-1-')) {
        throw 'Synthetic staged read runtime output validation/privacy self-test failed.'
    }
    $syntheticImportFailureRun = $syntheticStagedReadRun.PSObject.Copy()
    $syntheticImportFailureOutput = $syntheticStagedReadResponse | ConvertFrom-Json
    $syntheticImportFailureOutput.files[1].read.status = 'PASS'
    $syntheticImportFailureOutput.files[1].read.error_code = $null
    $syntheticImportFailureOutput.import.status = 'FAIL'
    $syntheticImportFailureOutput.import.error_code = 'EACCES'
    $syntheticImportFailureOutput.import.syscall = 'open'
    $syntheticImportFailureOutput.import.path_label = 'ancestor01'
    if (-not (Test-StagedImportDiagnostic $syntheticImportFailureOutput.import)) {
        throw 'Synthetic import fixture failed its allowlist self-test.'
    }
    $syntheticImportFailureRun.Stdout = $syntheticImportFailureOutput | ConvertTo-Json -Depth 8 -Compress
    $syntheticImportFailureObservation = Convert-StagedNodeReadDiagnosticObservation $syntheticImportFailureRun
    $syntheticImportFailureJson = $syntheticImportFailureObservation | ConvertTo-Json -Depth 8 -Compress
    if ($syntheticImportFailureObservation.response_status -cne 'VALID' -or
        $syntheticImportFailureObservation.import.syscall -cne 'open' -or
        $syntheticImportFailureObservation.import.path_label -cne 'ancestor01' -or
        $syntheticImportFailureJson.Contains('C:\private\no-report.txt') -or
        $syntheticImportFailureJson.Contains($syntheticImportFailureRun.Stderr)) {
        throw 'Synthetic import syscall/path-label privacy self-test failed.'
    }
    $syntheticInvalidImportPathRun = $syntheticImportFailureRun.PSObject.Copy()
    $syntheticInvalidImportPathOutput = $syntheticImportFailureRun.Stdout | ConvertFrom-Json
    $syntheticInvalidImportPathOutput.import.path_label = 'C:\private\raw-path'
    $syntheticInvalidImportPathRun.Stdout = $syntheticInvalidImportPathOutput | ConvertTo-Json -Depth 8 -Compress
    $syntheticInvalidImportPathObservation = Convert-StagedNodeReadDiagnosticObservation $syntheticInvalidImportPathRun
    $syntheticInvalidImportPathJson = $syntheticInvalidImportPathObservation | ConvertTo-Json -Depth 8 -Compress
    if ($syntheticInvalidImportPathObservation.response_status -cne 'INVALID' -or
        $syntheticInvalidImportPathJson.Contains('C:\private\raw-path')) {
        throw 'Synthetic import path-label allowlist self-test failed.'
    }
    $syntheticInvalidAncestorLabelRun = $syntheticImportFailureRun.PSObject.Copy()
    $syntheticInvalidAncestorLabelOutput = $syntheticImportFailureRun.Stdout | ConvertFrom-Json
    $syntheticInvalidAncestorLabelOutput.import.path_label = 'ancestor32'
    $syntheticInvalidAncestorLabelRun.Stdout = $syntheticInvalidAncestorLabelOutput | ConvertTo-Json -Depth 8 -Compress
    $syntheticInvalidAncestorLabelObservation = Convert-StagedNodeReadDiagnosticObservation $syntheticInvalidAncestorLabelRun
    if ($syntheticInvalidAncestorLabelObservation.response_status -cne 'INVALID') {
        throw 'Synthetic ancestor label range self-test failed.'
    }
    $syntheticProfileNonce = '0123456789abcdef0123456789abcdef'
    $syntheticProfileName = 'AgentCP' + $syntheticProfileNonce.Substring(0, 17)
    $syntheticOwnerLocalAppData = 'C:\Users\Owner\AppData\Local'
    $syntheticCallerLocalAppData = Join-Path $syntheticOwnerLocalAppData 'Packages\sandbox.synthetic\AC'
    $syntheticAppContainerProfile = Join-Path $syntheticOwnerLocalAppData ('Packages\' + $syntheticProfileName + '\AC')
    $syntheticProfilePaths = Get-ProfileContractStagePaths $syntheticAppContainerProfile $syntheticProfileName $syntheticProfileNonce
    if ($syntheticProfilePaths.TempPath -cne (Join-Path $syntheticAppContainerProfile 'Temp') -or
        $syntheticProfilePaths.StageRoot -cne (Join-Path $syntheticProfilePaths.TempPath ('profile-contract-' + $syntheticProfileNonce)) -or
        $syntheticProfilePaths.ModulePath -cne (Join-Path $syntheticProfilePaths.StageRoot 'probe-contract.mjs') -or
        $syntheticProfilePaths.ProfilePath -cne $syntheticAppContainerProfile -or
        $syntheticProfilePaths.ProfilePath -ceq $syntheticCallerLocalAppData) {
        throw 'Synthetic profile contract exact path self-test failed.'
    }
    $syntheticBootstrapCandidate = Get-ProfileBootstrapCandidatePath $true `
        $syntheticOwnerLocalAppData $syntheticProfileName $syntheticProfileNonce
    $untrustedBootstrapCallerRejected = $false
    try { $null = Get-ProfileBootstrapCandidatePath $false $syntheticOwnerLocalAppData $syntheticProfileName $syntheticProfileNonce }
    catch { $untrustedBootstrapCallerRejected = $true }
    $sandboxBootstrapLocalAppDataRejected = $false
    try {
        $null = Get-ProfileBootstrapCandidatePath $true $syntheticCallerLocalAppData $syntheticProfileName $syntheticProfileNonce
    } catch { $sandboxBootstrapLocalAppDataRejected = $true }
    $wrongBootstrapProfileNameRejected = $false
    try { $null = Get-ProfileBootstrapCandidatePath $true $syntheticOwnerLocalAppData 'AgentCPfffffffffffffffff' $syntheticProfileNonce }
    catch { $wrongBootstrapProfileNameRejected = $true }
    if ($syntheticBootstrapCandidate -cne (Join-Path $syntheticOwnerLocalAppData ('Packages\' + $syntheticProfileName + '\AC')) -or
        -not $untrustedBootstrapCallerRejected -or -not $sandboxBootstrapLocalAppDataRejected -or
        -not $wrongBootstrapProfileNameRejected) {
        throw 'Synthetic profile bootstrap full-trust/path preflight self-test failed.'
    }
    $syntheticBootstrapPathChecks = [ordered]@{
        local_drive_absolute = $true; local_no_stream = $true; local_canonical = $true; local_leaf_is_ac = $true
        parent_matches_nonce_name = $false; parent_matches_nonce_name_ordinal_ignore_case = $true
        grandparent_is_packages = $false
        temp_matches_local_child = $true; tmp_matches_local_child = $true
    }
    $syntheticBootstrapResponse = [ordered]@{
        schema_version = 1; status = 'FAIL'; profile_path_shape = 'FAIL'
        profile_path_checks = $syntheticBootstrapPathChecks
        temp_existed_before = $null; temp_create_status = 'NOT_RUN'; temp_created_by_diagnostic = $false
        marker_created_by_diagnostic = $false; marker_write_status = 'NOT_RUN'; marker_read_status = 'NOT_RUN'
        marker_delete_status = 'NOT_RUN'; marker_absent = $null; error_code = 'INVALID_PROFILE_PATH'
    } | ConvertTo-Json -Depth 5 -Compress
    $syntheticBootstrapRun = [pscustomobject]@{
        TimedOut = $false; OutputTruncated = $false; RootProcessSignaled = $true; JobDrained = $true
        WorkerTokenVerified = $true; JobMembershipVerified = $true; ExitCode = 0; DurationMs = 19
        Stdout = $syntheticBootstrapResponse; Stderr = 'synthetic private path C:\private\hidden'
    }
    $syntheticBootstrapObservation = Convert-ProfileBootstrapDiagnosticObservation $syntheticBootstrapRun
    $syntheticBootstrapObservationJson = $syntheticBootstrapObservation | ConvertTo-Json -Depth 8 -Compress
    if ($syntheticBootstrapObservation.response_status -cne 'VALID' -or
        $syntheticBootstrapObservation.profile_path_shape -cne 'FAIL' -or
        $syntheticBootstrapObservation.profile_path_checks.parent_matches_nonce_name -ne $false -or
        $syntheticBootstrapObservation.profile_path_checks.parent_matches_nonce_name_ordinal_ignore_case -ne $true -or
        $syntheticBootstrapObservation.profile_path_checks.grandparent_is_packages -ne $false -or
        $syntheticBootstrapObservationJson.Contains('C:\private\hidden') -or
        $syntheticBootstrapObservationJson.Contains($syntheticBootstrapRun.Stderr)) {
        throw 'Synthetic profile bootstrap path diagnostic privacy/contract self-test failed.'
    }
    $syntheticBootstrapAccepted = $syntheticBootstrapResponse | ConvertFrom-Json
    $syntheticBootstrapAccepted.profile_path_shape = 'PASS'
    $syntheticBootstrapAccepted.profile_path_checks.grandparent_is_packages = $true
    $syntheticBootstrapAccepted.temp_existed_before = $false
    $syntheticBootstrapAccepted.temp_create_status = 'FAIL'
    $syntheticBootstrapAccepted.error_code = 'EACCES'
    $syntheticBootstrapAcceptedRun = $syntheticBootstrapRun.PSObject.Copy()
    $syntheticBootstrapAcceptedRun.Stdout = ($syntheticBootstrapAccepted | ConvertTo-Json -Depth 5 -Compress)
    $syntheticBootstrapAcceptedObservation = Convert-ProfileBootstrapDiagnosticObservation $syntheticBootstrapAcceptedRun
    if ($syntheticBootstrapAcceptedObservation.response_status -cne 'VALID' -or
        $syntheticBootstrapAcceptedObservation.profile_path_shape -cne 'PASS' -or
        $syntheticBootstrapAcceptedObservation.profile_path_checks.parent_matches_nonce_name -ne $false -or
        $syntheticBootstrapAcceptedObservation.profile_path_checks.parent_matches_nonce_name_ordinal_ignore_case -ne $true) {
        throw 'Synthetic profile bootstrap case-insensitive name acceptance self-test failed.'
    }
    $syntheticBootstrapSkippedChecks = [pscustomobject]@{
        local_drive_absolute = $null; local_no_stream = $null; local_canonical = $null; local_leaf_is_ac = $null
        parent_matches_nonce_name = $null; parent_matches_nonce_name_ordinal_ignore_case = $null
        grandparent_is_packages = $null; temp_matches_local_child = $null; tmp_matches_local_child = $null
    }
    $syntheticBootstrapInvalidType = $syntheticBootstrapResponse | ConvertFrom-Json
    $syntheticBootstrapInvalidType.profile_path_checks.local_drive_absolute = 'true'
    if (-not (Test-ProfileBootstrapPathChecks $syntheticBootstrapSkippedChecks 'SKIPPED') -or
        (Test-ProfileBootstrapPathChecks $syntheticBootstrapInvalidType.profile_path_checks 'FAIL')) {
        throw 'Synthetic profile bootstrap path diagnostic null/type validation self-test failed.'
    }
    $syntheticBootstrapInconsistent = $syntheticBootstrapResponse | ConvertFrom-Json
    $syntheticBootstrapInconsistent.profile_path_checks.parent_matches_nonce_name = $true
    $syntheticBootstrapInconsistent.profile_path_checks.parent_matches_nonce_name_ordinal_ignore_case = $false
    $syntheticBootstrapInconsistentRun = $syntheticBootstrapRun.PSObject.Copy()
    $syntheticBootstrapInconsistentRun.Stdout = ($syntheticBootstrapInconsistent | ConvertTo-Json -Depth 5 -Compress)
    $syntheticBootstrapInconsistentObservation = Convert-ProfileBootstrapDiagnosticObservation $syntheticBootstrapInconsistentRun
    if ($syntheticBootstrapInconsistentObservation.response_status -cne 'INVALID') {
        throw ('Synthetic profile bootstrap ordinal-ignore-case consistency self-test failed: ' +
            [string]$syntheticBootstrapInconsistentObservation.response_status + ', ' +
            [string]$syntheticBootstrapInconsistent.profile_path_checks.parent_matches_nonce_name + ', ' +
            [string]$syntheticBootstrapInconsistent.profile_path_checks.parent_matches_nonce_name_ordinal_ignore_case)
    }
    $syntheticBootstrapWrongName = $syntheticBootstrapResponse | ConvertFrom-Json
    $syntheticBootstrapWrongName.profile_path_checks.grandparent_is_packages = $true
    $syntheticBootstrapWrongName.profile_path_checks.parent_matches_nonce_name_ordinal_ignore_case = $false
    if ((Test-ProfileBootstrapPathChecks $syntheticBootstrapWrongName.profile_path_checks 'PASS') -or
        -not (Test-ProfileBootstrapPathChecks $syntheticBootstrapWrongName.profile_path_checks 'FAIL')) {
        throw 'Synthetic profile bootstrap different-name rejection self-test failed.'
    }
    $invalidProfileNonceRejected = $false
    try { $null = Get-ProfileContractStagePaths $syntheticAppContainerProfile $syntheticProfileName '..\outside' }
    catch { $invalidProfileNonceRejected = $true }
    $wrongProfileNameRejected = $false
    try { $null = Get-ProfileContractStagePaths $syntheticAppContainerProfile 'AgentCPfffffffffffffffff' $syntheticProfileNonce }
    catch { $wrongProfileNameRejected = $true }
    $wrongPathShapeRejected = $false
    try { $null = Get-ProfileContractStagePaths 'C:\Users\Owner\AppData\Local\Packages\OtherProfile\AC' $syntheticProfileName $syntheticProfileNonce }
    catch { $wrongPathShapeRejected = $true }
    $uncProfilePathRejected = $false
    try { $null = Get-ProfileContractStagePaths ('\\server\share\Packages\' + $syntheticProfileName + '\AC') $syntheticProfileName $syntheticProfileNonce }
    catch { $uncProfilePathRejected = $true }
    $deviceProfilePathRejected = $false
    try { $null = Get-ProfileContractStagePaths ('\\?\C:\Users\Owner\AppData\Local\Packages\' + $syntheticProfileName + '\AC') $syntheticProfileName $syntheticProfileNonce }
    catch { $deviceProfilePathRejected = $true }
    if (-not $invalidProfileNonceRejected -or -not $wrongProfileNameRejected -or -not $wrongPathShapeRejected -or
        -not $uncProfilePathRejected -or -not $deviceProfilePathRejected) {
        throw 'Synthetic profile contract containment self-test failed.'
    }
    $missingProfileTempDecision = Get-ProfileTempPreparationDecision $false $false
    $existingProfileTempDecision = Get-ProfileTempPreparationDecision $true $true
    $nonDirectoryProfileTempRejected = $false
    try { $null = Get-ProfileTempPreparationDecision $true $false }
    catch { $nonDirectoryProfileTempRejected = $true }
    $preservePreexistingProfileDecision = Get-ProfileDeleteDecision $true $true $false $false $null $false $false $null
    $unresolvedProfilePathDeleteDecision = Get-ProfileDeleteDecision $false $true $false $false $null $false $false $null
    $preWriteProfileDeleteDecision = Get-ProfileDeleteDecision $false $true $true $false $null $false $false $null
    $reusedTempProfileDeleteDecision = Get-ProfileDeleteDecision $false $true $true $true $true $false $false $null
    $failedProfileStageDeleteDecision = Get-ProfileDeleteDecision $false $true $true $true $false $true $true $false
    $unknownProfileStageDeleteDecision = Get-ProfileDeleteDecision $false $true $true $true $null $true $true $null
    $uncertainTempCreationDeleteDecision = Get-ProfileDeleteDecision $false $true $true $true $true $true $false $null
    $failedTempCleanupDeleteDecision = Get-ProfileDeleteDecision $false $true $true $true $true $true $true $false
    $successfulProfileStageDeleteDecision = Get-ProfileDeleteDecision $false $true $true $true $true $true $true $true
    $unresolvedProfileRunPathDecision = Get-ProfileRunDeleteDecision $false $false $false $null $null $null $true $true $null
    $unvalidatedProfileRunTempPathDecision = Get-ProfileRunDeleteDecision $false $true $false $null $null $null $true $true $null
    $unvalidatedProfileRunTempDecision = Get-ProfileRunDeleteDecision $false $true $true $null $null $null $true $true $null
    $failedProfileRunPreflightDecision = Get-ProfileRunDeleteDecision $false $true $true $true $false $null $true $true $null
    $successfulProfileRunDecision = Get-ProfileRunDeleteDecision $false $true $true $true $true $true $true $true $true
    $syntheticUnvalidatedProfileRunSequence = @()
    if ($unresolvedProfileRunPathDecision -eq 'DELETE') { $syntheticUnvalidatedProfileRunSequence += 'delete-profile' }
    if ($unvalidatedProfileRunTempPathDecision -eq 'DELETE') { $syntheticUnvalidatedProfileRunSequence += 'delete-profile' }
    if ($unvalidatedProfileRunTempDecision -eq 'DELETE') { $syntheticUnvalidatedProfileRunSequence += 'delete-profile' }
    if ($failedProfileRunPreflightDecision -eq 'DELETE') { $syntheticUnvalidatedProfileRunSequence += 'delete-profile' }
    $bootstrapPathMismatchDecision = Get-ProfileBootstrapDeleteDecision $false $false $true $true $true
    $bootstrapSidMismatchDecision = Get-ProfileBootstrapDeleteDecision $false $true $false $true $true
    $bootstrapUnknownCleanupDecision = Get-ProfileBootstrapDeleteDecision $false $true $true $true $null
    $bootstrapFailedCleanupDecision = Get-ProfileBootstrapDeleteDecision $false $true $true $true $false
    $bootstrapDeleteAfterVerifiedCleanupDecision = Get-ProfileBootstrapDeleteDecision $false $true $true $true $true
    function New-SyntheticProfileMappingScan([string]$Status, [bool]$Complete,
        [int]$CompleteMatches, [int]$PartialMatches, [int]$MalformedValues) {
        return [pscustomobject]@{
            status = $Status
            scan_complete = $Complete
            keys_visited = 3
            complete_match_count = $CompleteMatches
            partial_match_count = $PartialMatches
            case_only_pair_count = 0
            partial_missing_pair_count = 0
            partial_different_pair_count = 0
            malformed_value_count = $MalformedValues
            stability_status = if ($Complete) { 'STABLE' } else { 'UNKNOWN' }
            issue = if ($Complete) { 'NONE' } else { 'READ_FAILED' }
        }
    }
    $mappingPreOne = New-SyntheticProfileMappingScan 'COMPLETE' $true 1 0 0
    $mappingPreNone = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 0 0
    $mappingPrePartial = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 1 0
    $mappingPreDuplicate = New-SyntheticProfileMappingScan 'COMPLETE' $true 2 0 0
    $mappingPreUnknown = New-SyntheticProfileMappingScan 'UNKNOWN' $false 1 0 0
    $mappingPreMalformed = New-SyntheticProfileMappingScan 'UNKNOWN' $false 0 0 1
    $mappingPreCaseOnly = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 1 0
    $mappingPreCaseOnly.case_only_pair_count = 1
    $mappingPreMissing = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 1 0
    $mappingPreMissing.partial_missing_pair_count = 1
    $mappingPreDifferent = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 1 0
    $mappingPreDifferent.partial_different_pair_count = 1
    $mappingPreMalformedComplete = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 0 1
    $mappingPreInconsistent = New-SyntheticProfileMappingScan 'COMPLETE' $true 1 1 0
    $mappingPreNegative = New-SyntheticProfileMappingScan 'COMPLETE' $true 1 0 0
    $mappingPreNegative.case_only_pair_count = -1
    $mappingPreUnstable = New-SyntheticProfileMappingScan 'COMPLETE' $true 1 0 0
    $mappingPreUnstable.stability_status = 'UNKNOWN'
    $mappingPostNone = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 0 0
    $mappingPostOne = New-SyntheticProfileMappingScan 'COMPLETE' $true 1 0 0
    $mappingPostPartial = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 1 0
    $mappingPostPartial.partial_missing_pair_count = 1
    $mappingPostDifferent = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 1 0
    $mappingPostDifferent.partial_different_pair_count = 1
    $mappingPostCaseOnly = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 1 0
    $mappingPostCaseOnly.case_only_pair_count = 1
    $mappingPostDuplicate = New-SyntheticProfileMappingScan 'COMPLETE' $true 2 0 0
    $mappingPostUnknown = New-SyntheticProfileMappingScan 'UNKNOWN' $false 0 0 0
    $mappingPostMalformed = New-SyntheticProfileMappingScan 'UNKNOWN' $false 0 0 1
    $mappingPostUnstable = New-SyntheticProfileMappingScan 'COMPLETE' $true 0 0 0
    $mappingPostUnstable.stability_status = 'UNKNOWN'
    function New-SyntheticProfileMappingValue([string]$Status, [string]$Value) {
        return [pscustomobject]@{ status = $Status; value = $Value }
    }
    function New-SyntheticProfileMappingPair($DisplayName, $Moniker, [string]$RegistryKeyMarker) {
        return [pscustomobject]@{
            displayName = $DisplayName
            moniker = $Moniker
            registry_key = $RegistryKeyMarker
        }
    }
    $mappingSyntheticProfileName = 'AgentCP0123456789abcdef0'
    $mappingSyntheticValueMarker = 'SensitiveMappingValueMarker'
    $mappingSyntheticKeyMarker = 'SensitiveRegistryKeyMarker'
    $mappingCaseOnlyPair = New-SyntheticProfileMappingPair `
        (New-SyntheticProfileMappingValue 'READ' $mappingSyntheticProfileName.ToLowerInvariant()) `
        (New-SyntheticProfileMappingValue 'READ' $mappingSyntheticProfileName.ToUpperInvariant()) `
        $mappingSyntheticKeyMarker
    $mappingMissingExactPair = New-SyntheticProfileMappingPair `
        (New-SyntheticProfileMappingValue 'MISSING' $null) `
        (New-SyntheticProfileMappingValue 'READ' $mappingSyntheticProfileName) `
        $mappingSyntheticKeyMarker
    $mappingMissingCasePair = New-SyntheticProfileMappingPair `
        (New-SyntheticProfileMappingValue 'MISSING' $null) `
        (New-SyntheticProfileMappingValue 'READ' $mappingSyntheticProfileName.ToUpperInvariant()) `
        $mappingSyntheticKeyMarker
    $mappingDifferentPair = New-SyntheticProfileMappingPair `
        (New-SyntheticProfileMappingValue 'READ' $mappingSyntheticProfileName) `
        (New-SyntheticProfileMappingValue 'READ' $mappingSyntheticValueMarker) `
        $mappingSyntheticKeyMarker
    $mappingExactPair = New-SyntheticProfileMappingPair `
        (New-SyntheticProfileMappingValue 'READ' $mappingSyntheticProfileName) `
        (New-SyntheticProfileMappingValue 'READ' $mappingSyntheticProfileName) `
        $mappingSyntheticKeyMarker
    $mappingNoMatchPair = New-SyntheticProfileMappingPair `
        (New-SyntheticProfileMappingValue 'READ' 'UnrelatedDisplayMarker') `
        (New-SyntheticProfileMappingValue 'READ' 'UnrelatedMonikerMarker') `
        $mappingSyntheticKeyMarker
    $mappingUnknownPair = New-SyntheticProfileMappingPair `
        (New-SyntheticProfileMappingValue 'UNKNOWN' $null) `
        (New-SyntheticProfileMappingValue 'READ' $mappingSyntheticProfileName) `
        $mappingSyntheticKeyMarker
    $mappingPairDiagnostics = Get-ProfileMappingPairSummary -Pairs @(
        $mappingCaseOnlyPair, $mappingMissingExactPair, $mappingMissingCasePair,
        $mappingDifferentPair, $mappingExactPair, $mappingNoMatchPair, $mappingUnknownPair
    ) -ProfileName $mappingSyntheticProfileName
    $mappingPairDiagnosticsJson = $mappingPairDiagnostics | ConvertTo-Json -Compress
    $mappingNoMatchDiagnostics = Get-ProfileMappingPairSummary -Pairs @($mappingNoMatchPair) `
        -ProfileName $mappingSyntheticProfileName
    $mappingUnknownDiagnostics = Get-ProfileMappingPairSummary -Pairs @($mappingUnknownPair) `
        -ProfileName $mappingSyntheticProfileName
    $mappingAmbiguousDiagnostics = Get-ProfileMappingPairSummary -Pairs @($mappingCaseOnlyPair, $mappingExactPair) `
        -ProfileName $mappingSyntheticProfileName
    if ($mappingPairDiagnostics.complete_match_count -ne 1 -or
        $mappingPairDiagnostics.partial_match_count -ne 4 -or
        $mappingPairDiagnostics.case_only_pair_count -ne 1 -or
        $mappingPairDiagnostics.display_name_exact_match_count -ne 2 -or
        $mappingPairDiagnostics.display_name_case_only_match_count -ne 1 -or
        $mappingPairDiagnostics.moniker_exact_match_count -ne 2 -or
        $mappingPairDiagnostics.moniker_case_only_match_count -ne 2 -or
        $mappingAmbiguousDiagnostics.display_name_exact_match_count -ne 1 -or
        $mappingAmbiguousDiagnostics.display_name_case_only_match_count -ne 1 -or
        $mappingAmbiguousDiagnostics.moniker_exact_match_count -ne 1 -or
        $mappingAmbiguousDiagnostics.moniker_case_only_match_count -ne 1 -or
        $mappingPairDiagnostics.partial_missing_pair_count -ne 2 -or
        $mappingPairDiagnostics.partial_different_pair_count -ne 1 -or
        $mappingPairDiagnostics.malformed_value_count -ne 1 -or
        $mappingNoMatchDiagnostics.complete_match_count -ne 0 -or
        $mappingNoMatchDiagnostics.partial_match_count -ne 0 -or
        $mappingNoMatchDiagnostics.case_only_pair_count -ne 0 -or
        $mappingNoMatchDiagnostics.partial_missing_pair_count -ne 0 -or
        $mappingNoMatchDiagnostics.partial_different_pair_count -ne 0 -or
        $mappingNoMatchDiagnostics.malformed_value_count -ne 0 -or
        $mappingUnknownDiagnostics.complete_match_count -ne 0 -or
        $mappingUnknownDiagnostics.partial_match_count -ne 0 -or
        $mappingUnknownDiagnostics.case_only_pair_count -ne 0 -or
        $mappingUnknownDiagnostics.partial_missing_pair_count -ne 0 -or
        $mappingUnknownDiagnostics.partial_different_pair_count -ne 0 -or
        $mappingUnknownDiagnostics.malformed_value_count -ne 1 -or
        $mappingPairDiagnosticsJson.Contains($mappingSyntheticProfileName) -or
        $mappingPairDiagnosticsJson.Contains($mappingSyntheticValueMarker) -or
        $mappingPairDiagnosticsJson.Contains($mappingSyntheticKeyMarker)) {
        throw 'Synthetic profile mapping pair classification or privacy self-test failed.'
    }
    $mappingPreOneDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreOne
    $mappingPreNoneDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreNone
    $mappingPrePartialDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPrePartial
    $mappingPreDuplicateDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreDuplicate
    $mappingPreUnknownDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreUnknown
    $mappingPreMalformedDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreMalformed
    $mappingPreCaseOnlyDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreCaseOnly
    $mappingPreMissingDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreMissing
    $mappingPreDifferentDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreDifferent
    $mappingPreMalformedCompleteDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreMalformedComplete
    $mappingPreInconsistentDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreInconsistent
    $mappingPreNegativeDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreNegative
    $mappingPreUnstableDecision = Get-ProfileRegistrationPreDeleteDecision $mappingPreUnstable
    $mappingPostNoneDecision = Get-ProfileRegistrationPostDeleteDecision $mappingPostNone
    $mappingPostOneDecision = Get-ProfileRegistrationPostDeleteDecision $mappingPostOne
    $mappingPostPartialDecision = Get-ProfileRegistrationPostDeleteDecision $mappingPostPartial
    $mappingPostDifferentDecision = Get-ProfileRegistrationPostDeleteDecision $mappingPostDifferent
    $mappingPostCaseOnlyDecision = Get-ProfileRegistrationPostDeleteDecision $mappingPostCaseOnly
    $mappingPostDuplicateDecision = Get-ProfileRegistrationPostDeleteDecision $mappingPostDuplicate
    $mappingPostUnknownDecision = Get-ProfileRegistrationPostDeleteDecision $mappingPostUnknown
    $mappingPostMalformedDecision = Get-ProfileRegistrationPostDeleteDecision $mappingPostMalformed
    $mappingPostUnstableDecision = Get-ProfileRegistrationPostDeleteDecision $mappingPostUnstable
    $mappingChildEnumerationAllowed = [AppContainerLauncher]::ClassifyProfileMappingChildEnumerationResult('NAME', 0, 1)
    $mappingChildAtBudget = [AppContainerLauncher]::ClassifyProfileMappingChildEnumerationResult('NAME', 2047, 2048)
    $mappingChildHighFanout = [AppContainerLauncher]::ClassifyProfileMappingChildEnumerationResult('NAME', 2048, 2048)
    $mappingChildEnd = [AppContainerLauncher]::ClassifyProfileMappingChildEnumerationResult('END', 2048, 2048)
    $mappingChildUnknown = [AppContainerLauncher]::ClassifyProfileMappingChildEnumerationResult('UNKNOWN', 0, 1)
    $mappingScanStable = [AppContainerLauncher]::ClassifyProfileMappingScanStability(0, 2, 123, 0, 2, 123, 258)
    $mappingScanChangedCount = [AppContainerLauncher]::ClassifyProfileMappingScanStability(0, 2, 123, 0, 3, 123, 258)
    $mappingScanChangedLastWrite = [AppContainerLauncher]::ClassifyProfileMappingScanStability(0, 2, 123, 0, 2, 124, 258)
    $mappingScanNotified = [AppContainerLauncher]::ClassifyProfileMappingScanStability(0, 2, 123, 0, 2, 123, 0)
    $mappingScanQueryFailed = [AppContainerLauncher]::ClassifyProfileMappingScanStability(0, 2, 123, 5, 2, 123, 258)
    $mappingValueExactSize = [AppContainerLauncher]::ClassifyProfileMappingValueSizeProbe(0, 1, 512, 512)
    $mappingValueOversize = [AppContainerLauncher]::ClassifyProfileMappingValueSizeProbe(0, 1, 514, 512)
    $mappingValueWrongType = [AppContainerLauncher]::ClassifyProfileMappingValueSizeProbe(0, 3, 8, 512)
    $mappingValueReadStable = [AppContainerLauncher]::ClassifyProfileMappingValueRead(0, 1, 512, 0, 1, 512, 1, 512, 512)
    $mappingValueReadChangedSize = [AppContainerLauncher]::ClassifyProfileMappingValueRead(0, 1, 512, 0, 1, 510, 1, 512, 512)
    $mappingValueReadChangedType = [AppContainerLauncher]::ClassifyProfileMappingValueRead(0, 1, 512, 0, 3, 512, 1, 512, 512)
    $mappingValueReadError = [AppContainerLauncher]::ClassifyProfileMappingValueRead(234, 1, 512, 0, 1, 512, 1, 512, 512)
    $mappingValueMissing = [AppContainerLauncher]::ClassifyProfileMappingValueSizeProbe(2, 0, 0, 512)
    function New-SyntheticBootstrapAclSummary([string]$Label,
        [System.Security.AccessControl.FileSystemRights]$Rights, [bool]$Inherited,
        [System.Security.AccessControl.InheritanceFlags]$Inheritance,
        [System.Security.AccessControl.PropagationFlags]$Propagation) {
        return [pscustomobject]@{
            label = $Label
            status = 'PASS'
            minimum_expected_allow_ace_present = $true
            potentially_conflicting_deny_ace_present = $false
            app_sid_ace_count = 1
            app_sid_aces = @([pscustomobject]@{
                access = 'allow'
                rights = $Rights.ToString()
                rights_value = [int]$Rights
                inherited = $Inherited
                inheritance = $Inheritance.ToString()
                inheritance_value = [int]$Inheritance
                propagation = $Propagation.ToString()
                propagation_value = [int]$Propagation
            })
        }
    }
    $syntheticToolsInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $syntheticTraverseRights = [System.Security.AccessControl.FileSystemRights]::Traverse -bor `
        [System.Security.AccessControl.FileSystemRights]::Synchronize
    $syntheticReadExecuteRights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor `
        [System.Security.AccessControl.FileSystemRights]::Synchronize
    $syntheticBootstrapAclStage = New-SyntheticBootstrapAclSummary 'stageRoot' `
        $syntheticTraverseRights $false `
        ([System.Security.AccessControl.InheritanceFlags]::None) `
        ([System.Security.AccessControl.PropagationFlags]::None)
    $syntheticBootstrapAclTools = New-SyntheticBootstrapAclSummary 'toolsRoot' `
        $syntheticReadExecuteRights $false `
        $syntheticToolsInheritance ([System.Security.AccessControl.PropagationFlags]::None)
    $syntheticBootstrapAclNode = New-SyntheticBootstrapAclSummary 'stagedNode' `
        $syntheticReadExecuteRights $true `
        ([System.Security.AccessControl.InheritanceFlags]::None) `
        ([System.Security.AccessControl.PropagationFlags]::None)
    $syntheticBootstrapAclAllowed = Get-ProfileBootstrapStagingAclStatus `
        $syntheticBootstrapAclStage $syntheticBootstrapAclTools $syntheticBootstrapAclNode
    $syntheticBootstrapAclUnknown = [pscustomobject]@{
        label = 'toolsRoot'; status = 'UNKNOWN'; minimum_expected_allow_ace_present = $false
        potentially_conflicting_deny_ace_present = $false
    }
    $syntheticBootstrapAclUnknownDecision = Get-ProfileBootstrapStagingAclStatus `
        $syntheticBootstrapAclStage $syntheticBootstrapAclUnknown $syntheticBootstrapAclNode
    $syntheticBootstrapAclDenied = [pscustomobject]@{
        label = 'stagedNode'; status = 'FAIL'; minimum_expected_allow_ace_present = $false
        potentially_conflicting_deny_ace_present = $true
    }
    $syntheticBootstrapAclDeniedDecision = Get-ProfileBootstrapStagingAclStatus `
        $syntheticBootstrapAclStage $syntheticBootstrapAclTools $syntheticBootstrapAclDenied
    $syntheticBootstrapAclOverbroadNode = New-SyntheticBootstrapAclSummary 'stagedNode' `
        ([System.Security.AccessControl.FileSystemRights]::FullControl) $true `
        ([System.Security.AccessControl.InheritanceFlags]::None) `
        ([System.Security.AccessControl.PropagationFlags]::None)
    $syntheticBootstrapAclOverbroadDecision = Get-ProfileBootstrapStagingAclStatus `
        $syntheticBootstrapAclStage $syntheticBootstrapAclTools $syntheticBootstrapAclOverbroadNode
    $syntheticBootstrapAclWrongToolsInheritance = New-SyntheticBootstrapAclSummary 'toolsRoot' `
        $syntheticReadExecuteRights $false `
        ([System.Security.AccessControl.InheritanceFlags]::None) `
        ([System.Security.AccessControl.PropagationFlags]::None)
    $syntheticBootstrapAclWrongToolsInheritanceDecision = Get-ProfileBootstrapStagingAclStatus `
        $syntheticBootstrapAclStage $syntheticBootstrapAclWrongToolsInheritance $syntheticBootstrapAclNode
    $syntheticBootstrapAclExplicitNode = New-SyntheticBootstrapAclSummary 'stagedNode' `
        $syntheticReadExecuteRights $false `
        ([System.Security.AccessControl.InheritanceFlags]::None) `
        ([System.Security.AccessControl.PropagationFlags]::None)
    $syntheticBootstrapAclExplicitNodeDecision = Get-ProfileBootstrapStagingAclStatus `
        $syntheticBootstrapAclStage $syntheticBootstrapAclTools $syntheticBootstrapAclExplicitNode
    $syntheticBootstrapAclExtraAceStage = $syntheticBootstrapAclStage.PSObject.Copy()
    $syntheticBootstrapAclExtraAceStage.app_sid_aces = @($syntheticBootstrapAclStage.app_sid_aces) + `
        @($syntheticBootstrapAclStage.app_sid_aces[0])
    $syntheticBootstrapAclExtraAceStage.app_sid_ace_count = 2
    $syntheticBootstrapAclExtraAceDecision = Get-ProfileBootstrapStagingAclStatus `
        $syntheticBootstrapAclExtraAceStage $syntheticBootstrapAclTools $syntheticBootstrapAclNode
    $syntheticBootstrapAclWithoutSynchronizeNode = New-SyntheticBootstrapAclSummary 'stagedNode' `
        ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) $true `
        ([System.Security.AccessControl.InheritanceFlags]::None) `
        ([System.Security.AccessControl.PropagationFlags]::None)
    $syntheticBootstrapAclWithoutSynchronizeDecision = Get-ProfileBootstrapStagingAclStatus `
        $syntheticBootstrapAclStage $syntheticBootstrapAclTools $syntheticBootstrapAclWithoutSynchronizeNode
    $syntheticBootstrapAclCleanupNotApplied = Get-ProfileBootstrapStagingAclCleanupStatus $false $null
    $syntheticBootstrapAclCleanupRemoved = Get-ProfileBootstrapStagingAclCleanupStatus $true $true
    $syntheticBootstrapAclCleanupFailed = Get-ProfileBootstrapStagingAclCleanupStatus $true $false
    $syntheticBootstrapAclCleanupUnknown = Get-ProfileBootstrapStagingAclCleanupStatus $true $null
    $syntheticFailedProfileCleanupReport = [ordered]@{
        appcontainer_profile_cleanup = Get-ProfileCleanupGateStatus $failedProfileStageDeleteDecision
        temporary_files_cleanup = if ($failedProfileStageDeleteDecision -ne 'DELETE') { 'FAIL' } else { 'PASS' }
    }
    $syntheticFailedCleanupSequence = @('nonce-child-cleanup-failed')
    if ($failedProfileStageDeleteDecision -eq 'DELETE') { $syntheticFailedCleanupSequence += 'delete-profile' }
    $syntheticUnknownCleanupSequence = @('nonce-child-cleanup-unverified')
    if ($unknownProfileStageDeleteDecision -eq 'DELETE') { $syntheticUnknownCleanupSequence += 'delete-profile' }
    $syntheticSuccessfulCleanupSequence = @('nonce-child-cleanup-pass', 'empty-temp-cleanup-pass')
    if ($successfulProfileStageDeleteDecision -eq 'DELETE') { $syntheticSuccessfulCleanupSequence += 'delete-profile' }
    if ($missingProfileTempDecision -cne 'CREATE' -or $existingProfileTempDecision -cne 'REUSE' -or
        -not $nonDirectoryProfileTempRejected -or
        (Get-ProfileTempCleanupStatus $true $true $true $true) -cne 'PASS' -or
        (Get-ProfileTempCleanupStatus $true $false $false $null) -cne 'NOT_CREATED' -or
        (Get-ProfileTempCleanupStatus $true $true $false $true) -cne 'PASS' -or
        $preservePreexistingProfileDecision -cne 'PRESERVE_PREEXISTING' -or
        $unresolvedProfilePathDeleteDecision -cne 'PRESERVE_PROFILE_PATH_UNKNOWN' -or
        $preWriteProfileDeleteDecision -cne 'DELETE' -or
        $reusedTempProfileDeleteDecision -cne 'DELETE' -or
        $failedProfileStageDeleteDecision -cne 'PRESERVE_STAGE_FAILED' -or
        $syntheticFailedProfileCleanupReport.appcontainer_profile_cleanup -cne 'FAIL' -or
        $syntheticFailedProfileCleanupReport.temporary_files_cleanup -cne 'FAIL' -or
        $syntheticFailedCleanupSequence -contains 'delete-profile' -or
        $unknownProfileStageDeleteDecision -cne 'PRESERVE_STAGE_UNKNOWN' -or
        (Get-ProfileCleanupGateStatus $unknownProfileStageDeleteDecision) -cne 'UNKNOWN' -or
        $syntheticUnknownCleanupSequence -contains 'delete-profile' -or
        $uncertainTempCreationDeleteDecision -cne 'PRESERVE_TEMP_UNKNOWN' -or
        $failedTempCleanupDeleteDecision -cne 'PRESERVE_TEMP_FAILED' -or
        $successfulProfileStageDeleteDecision -cne 'DELETE' -or
        $unresolvedProfileRunPathDecision -cne 'PRESERVE_PROFILE_PATH_UNKNOWN' -or
        $unvalidatedProfileRunTempPathDecision -cne 'PRESERVE_TEMP_PATH_UNKNOWN' -or
        $unvalidatedProfileRunTempDecision -cne 'PRESERVE_TEMP_PREFLIGHT_UNKNOWN' -or
        $failedProfileRunPreflightDecision -cne 'PRESERVE_STAGE_PREFLIGHT_FAILED' -or
        $successfulProfileRunDecision -cne 'DELETE' -or
        $syntheticUnvalidatedProfileRunSequence -contains 'delete-profile' -or
        $bootstrapPathMismatchDecision -cne 'PRESERVE_CANDIDATE_UNKNOWN' -or
        $bootstrapSidMismatchDecision -cne 'PRESERVE_SID_MISMATCH' -or
        $bootstrapUnknownCleanupDecision -cne 'PRESERVE_CLEANUP_UNKNOWN' -or
        $bootstrapFailedCleanupDecision -cne 'PRESERVE_CLEANUP_FAILED' -or
        $bootstrapDeleteAfterVerifiedCleanupDecision -cne 'DELETE' -or
        $mappingPreOneDecision -cne 'PASS' -or
        $mappingPreNoneDecision -cne 'UNKNOWN' -or
        $mappingPrePartialDecision -cne 'UNKNOWN' -or
        $mappingPreDuplicateDecision -cne 'UNKNOWN' -or
        $mappingPreUnknownDecision -cne 'UNKNOWN' -or
        $mappingPreMalformedDecision -cne 'UNKNOWN' -or
        $mappingPreCaseOnlyDecision -cne 'PASS' -or
        $mappingPreMissingDecision -cne 'UNKNOWN' -or
        $mappingPreDifferentDecision -cne 'UNKNOWN' -or
        $mappingPreMalformedCompleteDecision -cne 'UNKNOWN' -or
        $mappingPreInconsistentDecision -cne 'UNKNOWN' -or
        $mappingPreNegativeDecision -cne 'UNKNOWN' -or
        $mappingPreUnstableDecision -cne 'UNKNOWN' -or
        $mappingPostNoneDecision -cne 'PASS' -or
        $mappingPostOneDecision -cne 'FAIL' -or
        $mappingPostPartialDecision -cne 'FAIL' -or
        $mappingPostDifferentDecision -cne 'FAIL' -or
        $mappingPostCaseOnlyDecision -cne 'FAIL' -or
        $mappingPostDuplicateDecision -cne 'FAIL' -or
        $mappingPostUnknownDecision -cne 'UNKNOWN' -or
        $mappingPostMalformedDecision -cne 'UNKNOWN' -or
        $mappingPostUnstableDecision -cne 'UNKNOWN' -or
        $mappingChildEnumerationAllowed -cne 'NAME' -or
        $mappingChildAtBudget -cne 'NAME' -or
        $mappingChildHighFanout -cne 'KEY_LIMIT' -or
        $mappingChildEnd -cne 'END' -or
        $mappingChildUnknown -cne 'UNKNOWN' -or
        $mappingScanStable -cne 'STABLE' -or
        $mappingScanChangedCount -cne 'UNKNOWN' -or
        $mappingScanChangedLastWrite -cne 'UNKNOWN' -or
        $mappingScanNotified -cne 'UNKNOWN' -or
        $mappingScanQueryFailed -cne 'UNKNOWN' -or
        $mappingValueExactSize -cne 'READY' -or
        $mappingValueOversize -cne 'UNKNOWN' -or
        $mappingValueWrongType -cne 'UNKNOWN' -or
        $mappingValueReadStable -cne 'READ' -or
        $mappingValueReadChangedSize -cne 'UNKNOWN' -or
        $mappingValueReadChangedType -cne 'UNKNOWN' -or
        $mappingValueReadError -cne 'UNKNOWN' -or
        $mappingValueMissing -cne 'MISSING' -or
        $syntheticBootstrapAclAllowed -cne 'PASS' -or
        $syntheticBootstrapAclUnknownDecision -cne 'UNKNOWN' -or
        $syntheticBootstrapAclDeniedDecision -cne 'FAIL' -or
        $syntheticBootstrapAclOverbroadDecision -cne 'FAIL' -or
        $syntheticBootstrapAclWrongToolsInheritanceDecision -cne 'FAIL' -or
        $syntheticBootstrapAclExplicitNodeDecision -cne 'FAIL' -or
        $syntheticBootstrapAclExtraAceDecision -cne 'FAIL' -or
        $syntheticBootstrapAclWithoutSynchronizeDecision -cne 'PASS' -or
        $syntheticBootstrapAclCleanupNotApplied -cne 'NOT_APPLIED' -or
        $syntheticBootstrapAclCleanupRemoved -cne 'REMOVED_WITH_STAGE' -or
        $syntheticBootstrapAclCleanupFailed -cne 'NOT_CONFIRMED' -or
        $syntheticBootstrapAclCleanupUnknown -cne 'NOT_CONFIRMED' -or
        ($syntheticSuccessfulCleanupSequence -join ',') -cne 'nonce-child-cleanup-pass,empty-temp-cleanup-pass,delete-profile') {
        throw 'Synthetic profile Temp, staging ACL, registration boundedness, cleanup, and profile preservation self-test failed.'
    }
    $syntheticHash = 'a' * 64
    if (-not (Test-ProfileContractHashMatch $syntheticHash $syntheticHash 262144) -or
        (Test-ProfileContractHashMatch $syntheticHash ('b' * 64) 1) -or
        (Test-ProfileContractHashMatch $syntheticHash $syntheticHash 262145)) {
        throw 'Synthetic profile contract hash and size cap self-test failed.'
    }
    if ((Get-ProfileContractCleanupStatus $false $null) -cne 'NOT_RUN' -or
        (Get-ProfileContractCleanupStatus $true $null) -cne 'UNKNOWN' -or
        (Get-ProfileContractCleanupStatus $true $true) -cne 'PASS' -or
        (Get-ProfileContractCleanupStatus $true $false) -cne 'FAIL') {
        throw 'Synthetic profile contract cleanup status self-test failed.'
    }
    $syntheticProfileResponse = [ordered]@{
        schema_version = 1
        label = 'profileContractTemp'
        lstat = [ordered]@{ operation = 'lstat'; status = 'PASS'; error_code = $null }
        realpath = [ordered]@{ operation = 'realpath'; status = 'PASS'; error_code = $null }
        read = [ordered]@{ operation = 'read'; status = 'PASS'; error_code = $null }
        import = [ordered]@{ operation = 'import'; status = 'PASS'; error_code = $null; syscall = $null; path_label = $null }
    } | ConvertTo-Json -Depth 6 -Compress
    $syntheticProfileRun = [pscustomobject]@{
        TimedOut = $false; ExitCode = 0; OutputTruncated = $false; RootProcessSignaled = $true
        JobDrained = $true; WorkerTokenVerified = $true; JobMembershipVerified = $true; DurationMs = 17
        Stdout = $syntheticProfileResponse; Stderr = 'synthetic profile path C:\private\hidden.mjs'
    }
    $syntheticProfileObservation = Convert-ProfileContractImportDiagnosticObservation $syntheticProfileRun
    $syntheticProfileObservationJson = $syntheticProfileObservation | ConvertTo-Json -Depth 8 -Compress
    if ($syntheticProfileObservation.response_status -cne 'VALID' -or
        $syntheticProfileObservation.label -cne 'profileContractTemp' -or
        $syntheticProfileObservation.import.status -cne 'PASS' -or
        $syntheticProfileObservationJson.Contains('C:\private\hidden.mjs') -or
        $syntheticProfileObservationJson.Contains($syntheticProfileRun.Stderr)) {
        throw 'Synthetic profile contract import diagnostic privacy self-test failed.'
    }
    $syntheticProfileGateMismatchRun = $syntheticProfileRun.PSObject.Copy()
    $syntheticProfileGateMismatch = $syntheticProfileResponse | ConvertFrom-Json
    $syntheticProfileGateMismatch.read.status = 'FAIL'
    $syntheticProfileGateMismatch.read.error_code = 'HASH_MISMATCH'
    $syntheticProfileGateMismatchRun.Stdout = $syntheticProfileGateMismatch | ConvertTo-Json -Depth 6 -Compress
    if ((Convert-ProfileContractImportDiagnosticObservation $syntheticProfileGateMismatchRun).response_status -cne 'INVALID') {
        throw 'Synthetic profile contract hash-gated import self-test failed.'
    }
    $syntheticProfileReport = [ordered]@{ g2_2_attestation = $false; gate_status = 'PENDING_OWNER_REVIEW' }
    if ($syntheticProfileReport.g2_2_attestation -or $syntheticProfileReport.gate_status -cne 'PENDING_OWNER_REVIEW') {
        throw 'Synthetic profile contract diagnostic must not promote the G2.2 gate.'
    }
    $syntheticInvalidGateRun = $syntheticStagedReadRun.PSObject.Copy()
    $syntheticInvalidGateOutput = $syntheticStagedReadResponse | ConvertFrom-Json
    $syntheticInvalidGateOutput.import.status = 'PASS'
    $syntheticInvalidGateOutput.import.error_code = $null
    $syntheticInvalidGateRun.Stdout = $syntheticInvalidGateOutput | ConvertTo-Json -Depth 8 -Compress
    $syntheticInvalidGateObservation = Convert-StagedNodeReadDiagnosticObservation $syntheticInvalidGateRun
    if ($syntheticInvalidGateObservation.response_status -cne 'INVALID') {
        throw 'Synthetic staged read failed-access import-gating self-test failed.'
    }
    $syntheticInvalidStagedReadRun = $syntheticStagedReadRun.PSObject.Copy()
    $syntheticInvalidStagedReadRun.Stdout = '{"schema_version":1,"files":[],"import":{"operation":"import","status":"PASS","error_code":null},"path":"C:\\private\\raw-path"}'
    $syntheticInvalidStagedReadObservation = Convert-StagedNodeReadDiagnosticObservation $syntheticInvalidStagedReadRun
    $syntheticInvalidStagedReadObservationJson = $syntheticInvalidStagedReadObservation | ConvertTo-Json -Depth 8 -Compress
    if ($syntheticInvalidStagedReadObservation.response_status -cne 'INVALID' -or
        $syntheticInvalidStagedReadObservationJson.Contains('C:\private\raw-path')) {
        throw 'Synthetic staged read malformed output rejection self-test failed.'
    }
    $syntheticWorkerModulePath = 'C:\stage\worker.mjs'
    $syntheticProbeContractPath = 'C:\stage\probe-contract.mjs'
    $syntheticStagedNodePath = 'C:\stage\node.exe'
    $syntheticModuleHookPath = 'C:\stage\module-hook.mjs'
    if ((Get-WorkerStderrTarget "Error: '$syntheticWorkerModulePath'" $syntheticWorkerModulePath $syntheticProbeContractPath $syntheticStagedNodePath) -cne 'workerModule' -or
        (Get-WorkerStderrTarget "Error: `"$syntheticProbeContractPath`"" $syntheticWorkerModulePath $syntheticProbeContractPath $syntheticStagedNodePath) -cne 'probeContract' -or
        (Get-WorkerStderrTarget "Error: '$syntheticStagedNodePath'" $syntheticWorkerModulePath $syntheticProbeContractPath $syntheticStagedNodePath) -cne 'stagedNode' -or
        (Get-WorkerStderrTarget "Error: '$syntheticModuleHookPath'" $syntheticWorkerModulePath $syntheticProbeContractPath $syntheticStagedNodePath $syntheticModuleHookPath) -cne 'moduleHook' -or
        (Get-WorkerStderrTarget 'Error: unrelated path' $syntheticWorkerModulePath $syntheticProbeContractPath $syntheticStagedNodePath) -cne 'unknown' -or
        (Get-WorkerStderrTarget "Error: '$syntheticWorkerModulePath.bak'" $syntheticWorkerModulePath $syntheticProbeContractPath $syntheticStagedNodePath) -cne 'unknown' -or
        (Get-WorkerStderrTarget "Error: 'prefix$syntheticWorkerModulePath'" $syntheticWorkerModulePath $syntheticProbeContractPath $syntheticStagedNodePath) -cne 'unknown' -or
        (Get-WorkerStderrTarget "Error: '$syntheticWorkerModulePath' '$syntheticProbeContractPath'" $syntheticWorkerModulePath $syntheticProbeContractPath $syntheticStagedNodePath) -cne 'unknown') {
        throw 'Synthetic exact stderr target classification self-test failed.'
    }
    $syntheticRun = [pscustomobject]@{
        TimedOut = $true
        ExitCode = 2
        OutputTruncated = $false
        JobDrained = $true
        RootProcessSignaled = $true
        ActiveProcessesAfterDrain = [uint32]0
        ActiveProcessQueryErrorCode = 0
        DrainPollWaitCode = 0
        DrainDiagnostic = 'synthetic drain confirmed'
        WorkerTokenVerified = $true
        JobMembershipVerified = $true
        DurationMs = 123
        Stdout = '{"mode":"error","code":"EACCES"}'
        Stderr = 'synthetic-raw-stderr-marker'
    }
    $launcherObservation = Get-WorkerLauncherObservation $syntheticRun
    $launcherJson = $launcherObservation | ConvertTo-Json -Compress
    if (-not (Test-ExactObjectKeys $launcherObservation @('timed_out', 'exit_code', 'output_truncated', 'root_process_signaled', 'job_drained',
            'active_processes_after_drain', 'active_process_query_error_code', 'drain_poll_wait_code', 'drain_diagnostic',
            'worker_token_verified', 'job_membership_verified', 'duration_ms', 'stdout_bytes', 'stderr_bytes',
            'stdout_sha256', 'stderr_sha256', 'stderr_class', 'stderr_operation', 'stderr_target', 'worker_error_code',
            'appcontainer_capabilities_status', 'appcontainer_capability_count', 'appcontainer_capabilities_error_code')) -or
        -not $launcherObservation.timed_out -or $launcherObservation.exit_code -ne 2 -or
        -not $launcherObservation.root_process_signaled -or -not $launcherObservation.job_drained -or
        $launcherObservation.active_processes_after_drain -ne 0 -or
        $launcherObservation.active_process_query_error_code -ne 0 -or
        $launcherObservation.drain_diagnostic -cne 'synthetic drain confirmed' -or
        $launcherObservation.worker_error_code -cne 'EACCES' -or
        $launcherObservation.stderr_operation -cne 'UNKNOWN' -or
        $launcherObservation.stderr_target -cne 'unknown' -or
        $launcherJson.Contains($syntheticRun.Stderr) -or $launcherJson.Contains($syntheticRun.Stdout)) {
        throw 'Synthetic launcher diagnostic privacy self-test failed.'
    }
    if ((Get-WorkerStderrClass 'Error: EACCES while opening C:\Users\private\secrets\file.txt') -cne 'EACCES' -or
        (Get-WorkerStderrClass 'Error: unexpected value at C:\Users\private\secrets\file.txt') -cne 'NODE_ERROR') {
        throw 'Synthetic stderr classification self-test failed.'
    }
    if ((Get-WorkerStderrOperation "Error: EPERM: operation not permitted, read 'C:\Users\private\secrets\file.txt'") -cne 'read' -or
        (Get-WorkerStderrOperation "Error: EPERM: operation not permitted, write 'C:\Users\private\secrets\file.txt'") -cne 'write' -or
        (Get-WorkerStderrOperation "Error: syscall: 'write', path: 'C:\Users\private\secrets\file.txt'") -cne 'write' -or
        (Get-WorkerStderrOperation "Error: EACCES: permission denied, lstat 'C:\Users\private\secrets\link'") -cne 'lstat' -or
        (Get-WorkerStderrOperation "Error: EPERM: operation not permitted, open 'C:\Users\private\secrets\file.txt'") -cne 'open') {
        throw 'Synthetic stderr operation classification self-test failed.'
    }
    $syntheticFsOperations = @(
        (Get-WorkerStderrOperation "Error: EACCES: permission denied, lstat 'C:\Users\private\secrets\link'"),
        (Get-WorkerStderrOperation "Error: EPERM: operation not permitted, open 'C:\Users\private\secrets\file.txt'")
    )
    if ([string]::Join(',', [string[]]$syntheticFsOperations).Contains('C:\Users\private\secrets')) {
        throw 'Synthetic filesystem operation summary exposed a raw path.'
    }
    $syntheticAppSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1001')
    $syntheticOtherSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1002')
    $syntheticRules = @(
        [pscustomobject]@{
            IdentityReference = $syntheticAppSid
            FileSystemRights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
            AccessControlType = [System.Security.AccessControl.AccessControlType]::Allow
            IsInherited = $true
            InheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
            PropagationFlags = [System.Security.AccessControl.PropagationFlags]::None
        },
        [pscustomobject]@{
            IdentityReference = $syntheticAppSid
            FileSystemRights = [System.Security.AccessControl.FileSystemRights]::Delete
            AccessControlType = [System.Security.AccessControl.AccessControlType]::Deny
            IsInherited = $false
            InheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
            PropagationFlags = [System.Security.AccessControl.PropagationFlags]::None
        },
        [pscustomobject]@{
            IdentityReference = $syntheticOtherSid
            FileSystemRights = [System.Security.AccessControl.FileSystemRights]::FullControl
            AccessControlType = [System.Security.AccessControl.AccessControlType]::Allow
            IsInherited = $false
            InheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
            PropagationFlags = [System.Security.AccessControl.PropagationFlags]::None
        }
    )
    $syntheticDaclSummary = Convert-AppSidDaclSummary 'workerModule' $syntheticRules $syntheticAppSid `
        ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    $syntheticDaclJson = $syntheticDaclSummary | ConvertTo-Json -Depth 6 -Compress
    $syntheticDaclInsufficient = Convert-AppSidDaclSummary 'workspaceRoot' $syntheticRules $syntheticAppSid `
        ([System.Security.AccessControl.FileSystemRights]::Modify)
    $syntheticDaclConflict = Convert-AppSidDaclSummary 'workerModule' @($syntheticRules[0], [pscustomobject]@{
        IdentityReference = $syntheticAppSid
        FileSystemRights = [System.Security.AccessControl.FileSystemRights]::Read
        AccessControlType = [System.Security.AccessControl.AccessControlType]::Deny
        IsInherited = $false
        InheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
        PropagationFlags = [System.Security.AccessControl.PropagationFlags]::None
    }) $syntheticAppSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    if ($syntheticDaclSummary.status -cne 'PASS' -or
        -not $syntheticDaclSummary.minimum_expected_allow_ace_present -or
        $syntheticDaclSummary.potentially_conflicting_deny_ace_present -or
        -not $syntheticDaclSummary.read_traverse_allow_ace_present -or
        $syntheticDaclSummary.app_sid_ace_count -ne 2 -or
        -not $syntheticDaclSummary.app_sid_aces[0].inherited -or
        $syntheticDaclSummary.app_sid_aces[1].access -cne 'deny' -or
        $syntheticDaclInsufficient.status -cne 'FAIL' -or
        $syntheticDaclConflict.status -cne 'FAIL' -or
        -not $syntheticDaclConflict.potentially_conflicting_deny_ace_present -or
        $syntheticDaclJson.Contains($syntheticAppSid.Value) -or
        $syntheticDaclJson.Contains('C:\Users\private\secrets')) {
        throw 'Synthetic App SID DACL inventory contract self-test failed.'
    }
    try {
        $hostOnlyAcl = [System.IO.DirectoryInfo]::new($PSScriptRoot).GetAccessControl()
    } catch {
        $hostAclErrorDetails = Get-SafeExceptionDiagnosticDetails $_
        throw ('Host-only DACL read failed; type=' + $hostAclErrorDetails.exception_type +
            '; hresult=' + $hostAclErrorDetails.hresult + '; native_win32_code=' + $hostAclErrorDetails.native_win32_code)
    }
    $hostOnlyRules = @($hostOnlyAcl.Access)
    if ($hostOnlyRules.Count -eq 0) { throw 'Host-only DACL read returned no access rules.' }
    $hostOnlySid = $hostOnlyRules[0].IdentityReference
    if ($hostOnlySid -isnot [System.Security.Principal.SecurityIdentifier]) {
        $hostOnlySid = $hostOnlySid.Translate([System.Security.Principal.SecurityIdentifier])
    }
    $hostOnlyDaclSummary = Get-AppSidDaclSummary -Label 'selftest' -Path $PSScriptRoot `
        -AppSid $hostOnlySid -ExpectedRights ([System.Security.AccessControl.FileSystemRights]::Read)
    if ($hostOnlyDaclSummary.status -ceq 'UNKNOWN') {
        throw ('Host-only DACL query failed; type=' + $hostOnlyDaclSummary.exception_type +
            '; hresult=' + $hostOnlyDaclSummary.exception_hresult + '; native_win32_code=' + $hostOnlyDaclSummary.native_win32_code)
    }
    $hostOnlyDaclJson = $hostOnlyDaclSummary | ConvertTo-Json -Depth 6 -Compress
    if ($hostOnlyDaclSummary.app_sid_ace_count -lt 1 -or
        $hostOnlyDaclSummary.app_sid_aces[0].rights_value -lt 0 -or
        [string]::IsNullOrWhiteSpace([string]$hostOnlyDaclSummary.app_sid_aces[0].rights) -or
        $hostOnlyDaclJson.Contains($PSScriptRoot) -or $hostOnlyDaclJson.Contains($hostOnlySid.Value)) {
        throw 'Host-only DACL integration output did not contain a path-free parsed ACE summary.'
    }
    $syntheticExceptionDetails = Get-SafeExceptionDiagnosticDetails ([pscustomobject]@{
        Exception = [System.UnauthorizedAccessException]::new('synthetic private path')
    })
    $syntheticExceptionJson = $syntheticExceptionDetails | ConvertTo-Json -Compress
    if ($syntheticExceptionDetails.Keys.Count -ne 3 -or
        $syntheticExceptionDetails.Keys -notcontains 'exception_type' -or
        $syntheticExceptionDetails.Keys -notcontains 'hresult' -or
        $syntheticExceptionDetails.Keys -notcontains 'native_win32_code' -or
        $syntheticExceptionDetails.exception_type -cne 'UnauthorizedAccessException' -or
        $null -eq $syntheticExceptionDetails.hresult -or
        $syntheticExceptionJson.Contains('synthetic private path')) {
        throw 'Synthetic DACL exception diagnostic privacy self-test failed.'
    }
    $syntheticPath = 'C:\Users\private\secrets\file.txt'
    $unclassifiedStderr = 'opaque marker ' + $syntheticPath
    $stderrClass = Get-WorkerStderrClass $unclassifiedStderr
    if ($stderrClass -cne 'NONEMPTY_UNCLASSIFIED' -or $stderrClass.Contains($syntheticPath) -or
        (Get-WorkerStderrOperation ('opaque marker ' + $syntheticPath)) -cne 'UNKNOWN') {
        throw 'Synthetic stderr path privacy self-test failed.'
    }
    $stdioInputSample = '{"probe":"stdio-smoke"}'
    $stdioExpectedBytes = Get-WorkerInputByteCount $stdioInputSample
    if ($stdioExpectedBytes -ne 24) { throw 'Synthetic stdio input byte-count self-test failed.' }
    $inlineStdioMarkers = Get-InlineStdioSmokeMarkers "BOOT`nINPUT_OK:24`n" $stdioExpectedBytes
    $inlineStdioJson = $inlineStdioMarkers | ConvertTo-Json -Compress
    if (-not (Test-ExactObjectKeys $inlineStdioMarkers @('boot_marker_present', 'input_marker_present', 'bytes_read')) -or
        -not $inlineStdioMarkers.boot_marker_present -or -not $inlineStdioMarkers.input_marker_present -or
        $inlineStdioMarkers.bytes_read -ne 24 -or $inlineStdioJson.Contains('BOOT') -or $inlineStdioJson.Contains('INPUT_OK')) {
        throw 'Synthetic inline stdio marker self-test failed.'
    }
    $inlineBootOnlyMarkers = Get-InlineStdioSmokeMarkers "BOOT`n" $stdioExpectedBytes
    if (-not $inlineBootOnlyMarkers.boot_marker_present -or $inlineBootOnlyMarkers.input_marker_present -or
        $null -ne $inlineBootOnlyMarkers.bytes_read) {
        throw 'Synthetic inline stdio boot-only self-test failed.'
    }
    $inlineWrongCountMarkers = Get-InlineStdioSmokeMarkers "BOOT`nINPUT_OK:23`n" $stdioExpectedBytes
    if (-not $inlineWrongCountMarkers.boot_marker_present -or $inlineWrongCountMarkers.input_marker_present -or
        $null -ne $inlineWrongCountMarkers.bytes_read) {
        throw 'Synthetic inline stdio exact-count self-test failed.'
    }
    foreach ($invalidInlineOutput in @("BOOT`n`nINPUT_OK:24`n", "BOOT`nINPUT_OK:24`nEXTRA`n")) {
        $invalidInlineMarkers = Get-InlineStdioSmokeMarkers $invalidInlineOutput $stdioExpectedBytes
        if ($invalidInlineMarkers.boot_marker_present -or $invalidInlineMarkers.input_marker_present -or
            $null -ne $invalidInlineMarkers.bytes_read) {
            throw 'Synthetic inline stdio strict-output self-test failed.'
        }
    }
    $stdioMarkers = Get-StdioSmokeMarkers "BOOT`nSTAGE_WRITE_OK`nINPUT_OK:24`n" $stdioExpectedBytes
    $stdioMarkersJson = $stdioMarkers | ConvertTo-Json -Compress
    if (-not (Test-ExactObjectKeys $stdioMarkers @('boot_marker_present', 'stage_write_marker_present',
            'stage_write_marker_ok', 'stage_write_marker_fail', 'input_marker_present', 'bytes_read')) -or
        -not $stdioMarkers.boot_marker_present -or -not $stdioMarkers.stage_write_marker_present -or
        -not $stdioMarkers.stage_write_marker_ok -or $stdioMarkers.stage_write_marker_fail -or
        -not $stdioMarkers.input_marker_present -or
        $stdioMarkers.bytes_read -ne 24 -or $stdioMarkersJson.Contains('INPUT_OK')) {
        throw 'Synthetic stdio smoke marker self-test failed.'
    }
    $stageWriteFailureMarkers = Get-StdioSmokeMarkers "BOOT`nSTAGE_WRITE_FAIL`nINPUT_OK:24`n" $stdioExpectedBytes
    if (-not $stageWriteFailureMarkers.boot_marker_present -or
        -not $stageWriteFailureMarkers.stage_write_marker_present -or
        $stageWriteFailureMarkers.stage_write_marker_ok -or
        -not $stageWriteFailureMarkers.stage_write_marker_fail -or
        -not $stageWriteFailureMarkers.input_marker_present) {
        throw 'Synthetic stdio stage-write failure marker self-test failed.'
    }
    $markerContent = 'appcontainer-stdio-smoke-execution-v1'
    $markerContentBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($markerContent)
    $markerContentCopy = [byte[]]::new($markerContentBytes.Length)
    [Array]::Copy($markerContentBytes, $markerContentCopy, $markerContentBytes.Length)
    $matchingMarkerStatus = Get-StdioMarkerStatus $true (Test-ExactByteSequence $markerContentCopy $markerContentBytes) $true
    $missingMarkerStatus = Get-StdioMarkerStatus $false $false $true
    $mismatchedMarkerStatus = Get-StdioMarkerStatus $true $false $false
    if (-not $matchingMarkerStatus.script_started -or -not $matchingMarkerStatus.stage_write_pass -or
        -not $matchingMarkerStatus.marker_cleanup -or $missingMarkerStatus.script_started -or
        $missingMarkerStatus.stage_write_pass -or -not $missingMarkerStatus.marker_cleanup -or
        -not $mismatchedMarkerStatus.script_started -or $mismatchedMarkerStatus.stage_write_pass -or
        $mismatchedMarkerStatus.marker_cleanup) {
        throw 'Synthetic stage execution marker status/cleanup self-test failed.'
    }
    $noStdoutMarkers = Get-StdioSmokeMarkers '' $stdioExpectedBytes
    $outOfBandStatus = Get-StdioSmokePrimaryStatus $noStdoutMarkers $matchingMarkerStatus
    $earlyReturnStatus = Merge-StdioSmokeFinalStatus $null $matchingMarkerStatus
    $postCleanupStatus = Merge-StdioSmokeFinalStatus $outOfBandStatus $missingMarkerStatus
    if (-not $outOfBandStatus.script_started -or -not $outOfBandStatus.stage_write_pass -or
        $noStdoutMarkers.boot_marker_present -or $noStdoutMarkers.input_marker_present -or
        -not $earlyReturnStatus.script_started -or -not $earlyReturnStatus.stage_write_pass -or
        -not $earlyReturnStatus.marker_cleanup -or -not $postCleanupStatus.script_started -or
        -not $postCleanupStatus.stage_write_pass -or -not $postCleanupStatus.marker_cleanup) {
        throw 'Synthetic out-of-band marker/early-return cleanup self-test failed.'
    }
    if (Test-ExactByteSequence $markerContentBytes ([System.Text.UTF8Encoding]::new($false).GetBytes($markerContent + '-changed'))) {
        throw 'Synthetic stage execution marker content self-test failed.'
    }
    $invalidStdioMarkers = Get-StdioSmokeMarkers "BOOT`nSTAGE_WRITE_OK`nINPUT_OK:23`nC:\Users\private\secrets\file.txt" $stdioExpectedBytes
    $invalidStdioJson = $invalidStdioMarkers | ConvertTo-Json -Compress
    if (-not $invalidStdioMarkers.boot_marker_present -or -not $invalidStdioMarkers.stage_write_marker_ok -or
        $invalidStdioMarkers.input_marker_present -or
        $null -ne $invalidStdioMarkers.bytes_read -or
        $invalidStdioJson.Contains('C:\Users\private\secrets\file.txt')) {
        throw 'Synthetic stdio smoke output privacy self-test failed.'
    }
    $blankStdioMarkers = Get-StdioSmokeMarkers "BOOT`n`nSTAGE_WRITE_OK`nINPUT_OK:24`n" $stdioExpectedBytes
    if (-not $blankStdioMarkers.boot_marker_present -or $blankStdioMarkers.stage_write_marker_present -or
        $blankStdioMarkers.input_marker_present -or
        $null -ne $blankStdioMarkers.bytes_read) {
        throw 'Synthetic stdio smoke blank-line self-test failed.'
    }
    $nonCanonicalStdioMarkers = Get-StdioSmokeMarkers "BOOT`nSTAGE_WRITE_OK`nINPUT_OK:024`n" $stdioExpectedBytes
    if ($nonCanonicalStdioMarkers.input_marker_present -or $null -ne $nonCanonicalStdioMarkers.bytes_read) {
        throw 'Synthetic stdio smoke exact-count self-test failed.'
    }
    $missingBootMarkers = Get-StdioSmokeMarkers "`nSTAGE_WRITE_OK`nINPUT_OK:24`n" $stdioExpectedBytes
    if ($missingBootMarkers.boot_marker_present -or -not $missingBootMarkers.stage_write_marker_present -or
        $missingBootMarkers.input_marker_present) {
        throw 'Synthetic stdio smoke missing-boot self-test failed.'
    }
    $syntheticRun.Stdout = '{"mode":"error","code":"EACCES","raw":"synthetic-raw-stdout-marker"}'
    $launcherObservation = Get-WorkerLauncherObservation $syntheticRun
    $launcherJson = $launcherObservation | ConvertTo-Json -Compress
    if ($null -ne $launcherObservation.worker_error_code -or
        $launcherJson.Contains('synthetic-raw-stdout-marker') -or $launcherJson.Contains($syntheticRun.Stdout)) {
        throw 'Synthetic launcher diagnostic output filtering self-test failed.'
    }
    $syntheticStartup = Convert-SuspendedStartupObservation ([pscustomobject]@{
        Attempted = $true
        ProcessCreated = $true
        JobListAttributeAttempted = $true
        JobListAttributeSucceeded = $true
        JobMembershipVerified = $true
        FinalProcessWaitCode = 258
    })
    $syntheticStartupJson = $syntheticStartup | ConvertTo-Json -Compress
    if (-not $syntheticStartup.job_list_attribute_attempted -or
        -not $syntheticStartup.job_list_attribute_succeeded -or
        $syntheticStartup.codes.final_root_process_wait -ne 258 -or
        $syntheticStartup.PSObject.Properties.Name -contains 'job_assignment_attempted' -or
        -not $syntheticStartupJson.Contains('"final_root_process_wait":258')) {
        throw 'Synthetic startup attribute and final root-wait serialization self-test failed.'
    }
    if (-not (Test-ProbeCanaryEntrySet @('C:\probe\read-canary.txt') 'C:\probe\read-canary.txt' 'C:\probe\write-canary.txt') -or
        -not (Test-ProbeCanaryEntrySet @('C:\probe\read-canary.txt', 'C:\probe\write-canary.txt') 'C:\probe\read-canary.txt' 'C:\probe\write-canary.txt') -or
        (Test-ProbeCanaryEntrySet @('C:\probe\read-canary.txt', 'C:\probe\foreign.txt') 'C:\probe\read-canary.txt' 'C:\probe\write-canary.txt') -or
        (Test-ProbeCanaryEntrySet @('C:\probe\write-canary.txt') 'C:\probe\read-canary.txt' 'C:\probe\write-canary.txt')) {
        throw 'Synthetic canary cleanup boundary self-test failed.'
    }
    if (-not (Test-ProbeCanaryCleanupSafe @('C:\probe\read-canary.txt') 'C:\probe\read-canary.txt' 'C:\probe\write-canary.txt' $true $true $false) -or
        -not (Test-ProbeCanaryCleanupSafe @('C:\probe\read-canary.txt', 'C:\probe\write-canary.txt') 'C:\probe\read-canary.txt' 'C:\probe\write-canary.txt' $true $false $true) -or
        (Test-ProbeCanaryCleanupSafe @('C:\probe\read-canary.txt') 'C:\probe\read-canary.txt' 'C:\probe\write-canary.txt' $false $true $false) -or
        (Test-ProbeCanaryCleanupSafe @('C:\probe\read-canary.txt', 'C:\probe\write-canary.txt') 'C:\probe\read-canary.txt' 'C:\probe\write-canary.txt' $true $false $false)) {
        throw 'Synthetic canary marker cleanup self-test failed.'
    }

    # G8.2 synthetic transaction contract: begin
    $profilePathResolveBuildSyntheticOperations = {
        return @{
            WriteReport = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.WriteReport++
                if ($state.validationFailsBeforeReserve -and -not $state.reserved) {
                    $script:profilePathDiagnosticJournalFailurePhase = 'PREPARATION_FAILED'
                    $script:profilePathDiagnosticReportWriteAttempted = $false
                    $script:profilePathDiagnosticReportPersisted = $false
                    $script:profilePathDiagnosticReportWriteStatus = 'NOT_ATTEMPTED'
                    $script:report.report_write_attempted = $false
                    $script:report.report_persisted = $false
                    $script:report.report_write_status = 'NOT_ATTEMPTED'
                    throw [System.ArgumentException]::new('Synthetic pre-reservation validation failure.')
                }
                $script:profilePathDiagnosticReportWriteAttempted = $true
                $script:profilePathDiagnosticReportPersisted = $false
                $script:profilePathDiagnosticReportWriteStatus = 'PENDING'
                $script:report.report_write_attempted = $true
                $script:report.report_persisted = $false
                $script:report.last_persisted_sequence = [int]$script:profilePathDiagnosticLastPersistedSequence
                if ($state.targetPresent -and -not $state.reserved) {
                    $script:profilePathDiagnosticJournalFailurePhase = 'REPORT_RESERVATION_FAILED'
                    $script:profilePathDiagnosticReportWriteStatus = 'FAIL'
                    $script:report.report_write_status = 'FAIL'
                    throw [System.IO.IOException]::new('Synthetic reservation collision.')
                }
                if (-not $state.reserved) {
                    $state.reserved = $true
                    $state.targetPresent = $true
                    $state.targetBytes = ''
                    $script:profilePathDiagnosticReportPathReserved = $true
                }
                $script:profilePathDiagnosticJournalFailurePhase = $null
                if ($state.failWriteAt -eq $state.counters.WriteReport) {
                    $state.bytesAtFailedAppend = $state.targetBytes
                    $script:profilePathDiagnosticJournalFailurePhase = 'REPORT_WRITE_FAILED'
                    $script:profilePathDiagnosticReportWriteStatus = 'FAIL'
                    $script:report.report_write_status = 'FAIL'
                    throw [System.IO.IOException]::new('Synthetic private report-write failure.')
                }
                $snapshot = [ordered]@{}
                foreach ($entry in $script:report.GetEnumerator()) {
                    if ($entry.Key -notin @('report_persisted', 'report_write_status', 'last_persisted_sequence')) {
                        $snapshot[$entry.Key] = $entry.Value
                    }
                }
                $record = [ordered]@{
                    run_id = '0123456789abcdef0123456789abcdef'
                    schema_version = 1
                    sequence = [int]($script:profilePathDiagnosticLastPersistedSequence + 1)
                    phase = $script:report.phase
                    status = $script:report.status
                    report = [pscustomobject]$snapshot
                }
                $line = ConvertTo-Json -InputObject $record -Depth 12 -Compress
                $state.targetBytes += $line + "`n"
                $state.journalSnapshots.Add([pscustomobject]$record)
                $script:profilePathDiagnosticLastPersistedSequence = [int]$record.sequence
                $script:profilePathDiagnosticLastPersistedStatus = [string]$script:report.status
                $script:profilePathDiagnosticLastPersistedPhase = [string]$script:report.phase
                $script:profilePathDiagnosticReportPersisted = $true
                $script:profilePathDiagnosticReportWriteStatus = 'PASS'
                $script:report.report_write_status = 'PASS'
                $script:report.report_persisted = $true
                $script:report.last_persisted_sequence = [int]$record.sequence
            }
            CreateProfile = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.CreateProfile++
                $state.createSawAttemptedFlag = [bool]$script:profilePathDiagnosticCreateAttempted
                if ($state.throwCreate) { throw [System.OperationCanceledException]::new('Synthetic interrupted create.') }
                $state.createResult
            }
            ResolveProfilePath = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.ResolveProfilePath++
                if ($null -ne $state.pathException) { throw $state.pathException }
                if ($state.throwPath) { throw [System.InvalidOperationException]::new('Synthetic private path failure.') }
                'synthetic-private-profile-path'
            }
            ObserveApi = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.ObserveApi++
                if ($state.throwApi) { throw [System.InvalidOperationException]::new('Synthetic private API failure.') }
                $state.api
            }
            ScanRegistry = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.ScanRegistry++
                $state.scan
            }
            ObserveCandidate = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.ObserveCandidate++
                $state.candidate
            }
            GetCandidatePath = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.GetCandidatePath++
                'synthetic-private-candidate-path'
            }
            MatchApiCandidate = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.MatchApiCandidate++
                $state.apiCandidate
            }
            SidMatchesName = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.SidMatchesName++
                $state.sidMatchesName
            }
            DeleteProfile = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.DeleteProfile++
                if ($state.throwDelete) { throw [System.IO.IOException]::new('Synthetic private delete failure.') }
                $state.deleteHResult
            }
            PostDeleteScan = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.PostDeleteScan++
                $state.postScan
            }
            PostDeleteCandidate = {
                $state = $script:profilePathResolveSelfTestState
                $state.counters.PostDeleteCandidate++
                $state.postCandidate
            }
        }
    }
    $resetProfilePathResolveSyntheticState = {
        param($CreateResult)
        $script:profilePathResolveSelfTestState = [ordered]@{
            counters = [ordered]@{
                WriteReport = 0; CreateProfile = 0; ResolveProfilePath = 0
                ObserveApi = 0; ScanRegistry = 0; ObserveCandidate = 0
                GetCandidatePath = 0; MatchApiCandidate = 0; SidMatchesName = 0
                DeleteProfile = 0; PostDeleteScan = 0; PostDeleteCandidate = 0
            }
            journalSnapshots = [System.Collections.Generic.List[object]]::new()
            targetPresent = $false
            validationFailsBeforeReserve = $false
            targetBytes = ''
            targetGeneratorMetadata = 'synthetic-generator-metadata'
            targetReadCount = 0
            targetRemoveCount = 0
            bytesAtFailedAppend = $null
            reserved = $false
            createSawAttemptedFlag = $false
            createResult = $CreateResult
            failWriteAt = 0
            throwCreate = $false
            throwPath = $false
            pathException = $null
            throwApi = $false
            throwDelete = $false
            api = [pscustomobject]@{
                SidDerivationHResult = [int]0; ApiHResult = [int]0; PathPresent = $true
                FailureType = $null; FailureCode = $null; Path = 'synthetic-private-api-path'
            }
            scan = [pscustomobject]@{
                status = 'COMPLETE'; scan_complete = $true; stability_status = 'STABLE'
                keys_visited = [int]1; complete_match_count = [int]1; partial_match_count = [int]0
                case_only_pair_count = [int]0; partial_missing_pair_count = [int]0
                partial_different_pair_count = [int]0; malformed_value_count = [int]0
                issue = 'NONE'; failure_phase = 'NONE'; failure_type = $null; failure_code = $null
                synthetic_registry_value = 'synthetic-private-registry-value'
            }
            candidate = [pscustomobject]@{
                status = 'PRESENT'; shape_valid = $true; candidate_exists = $true
                candidate_is_directory = $true; reparse_point = $false; failure_type = $null; failure_code = $null
            }
            apiCandidate = [pscustomobject]@{ ApiHResult = [int]0; CandidateMatched = $true }
            sidMatchesName = $true
            deleteHResult = [int]0
            postScan = [pscustomobject]@{
                status = 'COMPLETE'; scan_complete = $true; stability_status = 'STABLE'
                keys_visited = [int]0; complete_match_count = [int]0; partial_match_count = [int]0
                case_only_pair_count = [int]0; partial_missing_pair_count = [int]0
                partial_different_pair_count = [int]0; malformed_value_count = [int]0
                issue = 'NONE'; failure_phase = 'NONE'; failure_type = $null; failure_code = $null
            }
            postCandidate = [pscustomobject]@{
                status = 'ABSENT'; shape_valid = $true; candidate_exists = $false
                candidate_is_directory = $false; reparse_point = $false; failure_type = $null; failure_code = $null
            }
        }
        $script:report = [ordered]@{
            phase = 'PREPARING'; profile_name = 'AgentCP0123456789abcdef0'
            profile_preexisted = 'UNKNOWN'; status = 'UNKNOWN'; cleanup_status = 'UNKNOWN'
            report_write_attempted = $false; report_write_status = 'NOT_ATTEMPTED'
            report_persisted = $false; last_persisted_sequence = [int]0
            profile_create_attempted = $false; diagnostic_profile_path_write_attempted = $false
            delete_decision = 'NOT_ATTEMPTED'
        }
        $script:profilePathDiagnosticReportWriteAttempted = $false
        $script:profilePathDiagnosticReportPersisted = $false
        $script:profilePathDiagnosticReportWriteStatus = 'NOT_ATTEMPTED'
        $script:profilePathDiagnosticReportPathReserved = $false
        $script:profilePathDiagnosticCreateAttempted = $false
        $script:profilePathDiagnosticLastPersistedSequence = [int]0
        $script:profilePathDiagnosticLastPersistedStatus = $null
        $script:profilePathDiagnosticLastPersistedPhase = $null
        $script:profilePathDiagnosticJournalFailurePhase = $null
        $script:profilePathDiagnosticJournalStream = $null
    }
    $profilePathResolveRunSyntheticTransaction = {
        param($CreateResult, [bool]$UsePreparedState = $false)
        if ($UsePreparedState) { $script:profilePathResolveSelfTestState.createResult = $CreateResult }
        else { & $resetProfilePathResolveSyntheticState $CreateResult }
        $operations = & $profilePathResolveBuildSyntheticOperations
        Invoke-ProfilePathResolveTransaction 'AgentCP0123456789abcdef0' '0123456789abcdef0123456789abcdef' `
            'synthetic-owner-local-appdata' 'synthetic-private-report-path' `
            'runtime/diagnostics/appcontainer-profile-path-0123456789abcdef0123456789abcdef.jsonl' $operations
    }

    $preflightCases = @(
        [pscustomobject]@{ status = 'FAIL'; phase = 'FULL_TRUST_REQUIRED' },
        [pscustomobject]@{ status = 'UNKNOWN'; phase = 'PREPARATION_FAILED' }
    )
    foreach ($preflightCase in $preflightCases) {
        & $resetProfilePathResolveSyntheticState $null
        $preflightResult = Convert-ProfilePathDiagnosticSafeResult $preflightCase.status `
            $preflightCase.phase 'NOT_ATTEMPTED' $false $false 0 $false $false $null
        if ($preflightResult.status -cne $preflightCase.status -or
            $preflightResult.phase -cne $preflightCase.phase -or
            $preflightResult.report_write_attempted -or
            $preflightResult.report_write_status -cne 'NOT_ATTEMPTED' -or
            $preflightResult.report_persisted -or $preflightResult.last_persisted_sequence -ne 0 -or
            $preflightResult.profile_create_attempted -or $null -ne $preflightResult.report_path -or
            (@($preflightResult.PSObject.Properties.Name) -join ',') -cne
                'status,phase,report_write_attempted,report_write_status,report_persisted,last_persisted_sequence,profile_create_attempted,report_path' -or
            $script:profilePathResolveSelfTestState.counters.CreateProfile -ne 0 -or
            $script:profilePathResolveSelfTestState.counters.WriteReport -ne 0) {
            throw ('Synthetic preflight safe-result contract failed: ' + $preflightCase.phase + '.')
        }
    }
    $pendingSafeResult = Convert-ProfilePathDiagnosticSafeResult 'PRIVATE' 'PRIVATE' 'PENDING' `
        $true $true 4 $true $true `
        'runtime/diagnostics/appcontainer-profile-path-0123456789abcdef0123456789abcdef.jsonl'
    if ($pendingSafeResult.status -cne 'UNKNOWN' -or $pendingSafeResult.phase -cne 'UNKNOWN' -or
        $pendingSafeResult.report_write_status -cne 'UNKNOWN' -or
        -not $pendingSafeResult.report_path -or
        (@($pendingSafeResult.PSObject.Properties.Name) -join ',') -cne
            'status,phase,report_write_attempted,report_write_status,report_persisted,last_persisted_sequence,profile_create_attempted,report_path') {
        throw 'Synthetic safe-result whitelist or pending-state mapping failed.'
    }

    & $resetProfilePathResolveSyntheticState $null
    $script:profilePathResolveSelfTestState.validationFailsBeforeReserve = $true
    $validationFailureOperations = & $profilePathResolveBuildSyntheticOperations
    $preReservationValidationFailure = Invoke-ProfilePathResolveTransaction 'AgentCP0123456789abcdef0' `
        '0123456789abcdef0123456789abcdef' 'synthetic-owner-local-appdata' `
        'synthetic-private-report-path' `
        'runtime/diagnostics/appcontainer-profile-path-0123456789abcdef0123456789abcdef.jsonl' `
        $validationFailureOperations
    $validationFailureState = $script:profilePathResolveSelfTestState
    if ($preReservationValidationFailure.status -cne 'UNKNOWN' -or
        $preReservationValidationFailure.phase -cne 'PREPARATION_FAILED' -or
        $preReservationValidationFailure.report_write_attempted -or
        $preReservationValidationFailure.report_write_status -cne 'NOT_ATTEMPTED' -or
        $preReservationValidationFailure.report_persisted -or
        $preReservationValidationFailure.last_persisted_sequence -ne 0 -or
        $preReservationValidationFailure.profile_create_attempted -or
        $null -ne $preReservationValidationFailure.report_path -or
        $validationFailureState.counters.WriteReport -ne 1 -or
        $validationFailureState.counters.CreateProfile -ne 0 -or
        $validationFailureState.counters.ResolveProfilePath -ne 0 -or
        $validationFailureState.counters.ObserveApi -ne 0 -or
        $validationFailureState.counters.DeleteProfile -ne 0 -or
        $validationFailureState.reserved -or $validationFailureState.targetPresent -or
        $validationFailureState.targetBytes.Length -ne 0) {
        throw 'Synthetic pre-reservation validation failure attempted a write or continued the transaction.'
    }

    & $resetProfilePathResolveSyntheticState $null
    $script:profilePathResolveSelfTestState.targetPresent = $true
    $script:profilePathResolveSelfTestState.targetBytes =
        $script:profilePathResolveSelfTestState.targetGeneratorMetadata + '|matching-target-bytes'
    $collisionBytesBefore = $script:profilePathResolveSelfTestState.targetBytes
    $collisionOperations = & $profilePathResolveBuildSyntheticOperations
    $reservationCollision = Invoke-ProfilePathResolveTransaction 'AgentCP0123456789abcdef0' `
        '0123456789abcdef0123456789abcdef' 'synthetic-owner-local-appdata' `
        'synthetic-private-report-path' `
        'runtime/diagnostics/appcontainer-profile-path-0123456789abcdef0123456789abcdef.jsonl' `
        $collisionOperations
    $collisionState = $script:profilePathResolveSelfTestState
    if ($reservationCollision.status -cne 'FAIL' -or
        $reservationCollision.phase -cne 'REPORT_RESERVATION_FAILED' -or
        -not $reservationCollision.report_write_attempted -or
        $reservationCollision.report_write_status -cne 'FAIL' -or
        $reservationCollision.report_persisted -or $reservationCollision.last_persisted_sequence -ne 0 -or
        $reservationCollision.profile_create_attempted -or $null -ne $reservationCollision.report_path -or
        $collisionState.counters.CreateProfile -ne 0 -or $collisionState.targetReadCount -ne 0 -or
        $collisionState.targetRemoveCount -ne 0 -or $collisionState.targetBytes -cne $collisionBytesBefore -or
        $collisionState.journalSnapshots.Count -ne 0) {
        throw 'Synthetic CreateNew collision read or changed an occupied target, or allowed profile creation.'
    }

    $validSyntheticCreate = [pscustomobject]@{ HResult = [int]0; Sid = 'S-1-15-2-123'; FailureType = $null }
    $syntheticTransactionResult = & $profilePathResolveRunSyntheticTransaction $validSyntheticCreate
    $syntheticSuccessState = $script:profilePathResolveSelfTestState
    if ($syntheticTransactionResult.status -cne 'COMPLETE' -or
        -not $syntheticTransactionResult.report_path -or
        -not $syntheticTransactionResult.report_persisted -or
        $syntheticTransactionResult.last_persisted_sequence -ne 4 -or
        $script:report.cleanup_status -cne 'PASS' -or $script:report.delete_decision -cne 'DELETE' -or
        $syntheticSuccessState.counters.DeleteProfile -ne 1 -or
        $syntheticSuccessState.counters.PostDeleteScan -ne 1 -or
        $syntheticSuccessState.counters.PostDeleteCandidate -ne 1 -or
        -not $syntheticSuccessState.reserved -or $syntheticSuccessState.targetBytes.Length -eq 0 -or
        -not $syntheticSuccessState.createSawAttemptedFlag -or
        $syntheticSuccessState.journalSnapshots[0].phase -cne 'CREATE_ATTEMPTED' -or
        $syntheticSuccessState.journalSnapshots[0].report.profile_create_attempted -ne $false -or
        $syntheticSuccessState.journalSnapshots[1].report.profile_create_attempted -ne $true -or
        $syntheticSuccessState.journalSnapshots[2].phase -cne 'DELETE_INTENT_PERSISTED' -or
        $syntheticSuccessState.journalSnapshots[3].phase -cne $syntheticTransactionResult.phase -or
        $syntheticSuccessState.journalSnapshots[3].status -cne $syntheticTransactionResult.status -or
        $syntheticSuccessState.journalSnapshots.Count -ne 4) {
        throw 'Synthetic successful profile path transaction or journal ordering failed.'
    }
    foreach ($record in $syntheticSuccessState.journalSnapshots) {
        $recordJson = ConvertTo-Json -InputObject $record -Depth 12 -Compress
        if ($record.run_id -cne '0123456789abcdef0123456789abcdef' -or
            $record.sequence -le 0 -or $record.phase -cne $record.report.phase -or
            $record.status -cne $record.report.status -or
            $recordJson -match 'report_persisted|report_write_status|last_persisted_sequence') {
            throw 'Synthetic JSONL snapshot receipt fields or phase/status correspondence failed.'
        }
    }

    foreach ($writeFailureCase in @('initial', 'delete-intent')) {
        & $resetProfilePathResolveSyntheticState $validSyntheticCreate
        if ($writeFailureCase -ceq 'initial') { $script:profilePathResolveSelfTestState.failWriteAt = 1 }
        else { $script:profilePathResolveSelfTestState.failWriteAt = 3 }
        $operations = & $profilePathResolveBuildSyntheticOperations
        $writeFailureResult = Invoke-ProfilePathResolveTransaction 'AgentCP0123456789abcdef0' `
            '0123456789abcdef0123456789abcdef' 'synthetic-owner-local-appdata' `
            'synthetic-private-report-path' `
            'runtime/diagnostics/appcontainer-profile-path-0123456789abcdef0123456789abcdef.jsonl' $operations
        $writeFailureState = $script:profilePathResolveSelfTestState
        if ($writeFailureCase -ceq 'initial') {
            if ($writeFailureResult.status -cne 'UNKNOWN' -or
                $writeFailureResult.phase -cne 'REPORT_WRITE_FAILED' -or
                $writeFailureResult.report_path -cne 'runtime/diagnostics/appcontainer-profile-path-0123456789abcdef0123456789abcdef.jsonl' -or
                $writeFailureResult.report_persisted -or $writeFailureResult.last_persisted_sequence -ne 0 -or
                $writeFailureState.counters.CreateProfile -ne 0 -or
                $writeFailureState.counters.ResolveProfilePath -ne 0 -or $writeFailureState.counters.ObserveApi -ne 0 -or
                $writeFailureState.counters.ScanRegistry -ne 0 -or $writeFailureState.counters.ObserveCandidate -ne 0 -or
                $writeFailureState.counters.DeleteProfile -ne 0 -or
                $writeFailureState.journalSnapshots.Count -ne 0 -or
                $writeFailureState.targetBytes.Length -ne 0) {
                throw 'Synthetic initial report-write failure did not stop before profile creation.'
            }
        } elseif ($writeFailureResult.status -ceq 'COMPLETE' -or
            $writeFailureResult.phase -cne 'REPORT_WRITE_FAILED' -or
            $writeFailureResult.last_persisted_sequence -ne 2 -or
            $writeFailureResult.report_persisted -or
            $writeFailureState.counters.DeleteProfile -ne 0 -or
            $script:report.delete_decision -cne 'NOT_ATTEMPTED' -or
            $script:report.cleanup_status -cne 'NOT_ATTEMPTED' -or
            $script:report.registration_state_before_cleanup -cne 'PRESENT' -or
            $script:report.registration_state_after_cleanup -cne 'PRESENT' -or
            $writeFailureState.journalSnapshots.Count -ne 2 -or
            $writeFailureState.journalSnapshots[1].report.profile_create_attempted -ne $true) {
            throw 'Synthetic delete-intent report-write failure did not block cleanup.'
        }
    }

    & $resetProfilePathResolveSyntheticState $validSyntheticCreate
    $script:profilePathResolveSelfTestState.failWriteAt = 2
    $laterAppendOperations = & $profilePathResolveBuildSyntheticOperations
    $laterAppendFailure = Invoke-ProfilePathResolveTransaction 'AgentCP0123456789abcdef0' `
        '0123456789abcdef0123456789abcdef' 'synthetic-owner-local-appdata' `
        'synthetic-private-report-path' `
        'runtime/diagnostics/appcontainer-profile-path-0123456789abcdef0123456789abcdef.jsonl' `
        $laterAppendOperations
    $laterAppendState = $script:profilePathResolveSelfTestState
    if ($laterAppendFailure.status -cne 'UNKNOWN' -or
        $laterAppendFailure.phase -cne 'REPORT_WRITE_FAILED' -or
        $laterAppendFailure.report_write_status -cne 'FAIL' -or
        -not $laterAppendFailure.report_write_attempted -or
        $laterAppendFailure.report_persisted -or
        $laterAppendFailure.last_persisted_sequence -ne 1 -or
        $laterAppendFailure.report_path -cne 'runtime/diagnostics/appcontainer-profile-path-0123456789abcdef0123456789abcdef.jsonl' -or
        $laterAppendState.counters.WriteReport -ne 2 -or $laterAppendState.counters.CreateProfile -ne 1 -or
        $laterAppendState.counters.ResolveProfilePath -ne 0 -or $laterAppendState.counters.ObserveApi -ne 0 -or
        $laterAppendState.counters.DeleteProfile -ne 0 -or $laterAppendState.journalSnapshots.Count -ne 1 -or
        $laterAppendState.journalSnapshots[0].sequence -ne 1 -or
        $laterAppendState.targetBytes -cne $laterAppendState.bytesAtFailedAppend) {
        throw 'Synthetic later append failure did not preserve the prior complete line or stop subsequent operations.'
    }

    $createNoObservationCases = @(
        [pscustomobject]@{ name = 'collision'; result = [pscustomobject]@{ HResult = [int]-2147024713; Sid = $null; FailureType = $null }; expectedPreexisted = $true; expectedPhase = 'CREATE_COLLISION' },
        [pscustomobject]@{ name = 'create-failure'; result = [pscustomobject]@{ HResult = [int]-2147024894; Sid = $null; FailureType = 'Win32Exception' }; expectedPreexisted = 'UNKNOWN'; expectedPhase = 'CREATE_FAILED' },
        [pscustomobject]@{ name = 'missing-hresult'; result = [pscustomobject]@{ Sid = $null; FailureType = 'OTHER' }; expectedPreexisted = 'UNKNOWN'; expectedPhase = 'CREATE_RESULT_UNKNOWN' }
    )
    foreach ($case in $createNoObservationCases) {
        $noObservationResult = & $profilePathResolveRunSyntheticTransaction $case.result
        $noObservationState = $script:profilePathResolveSelfTestState
        if ($noObservationResult.status -cne $(if ($case.expectedPhase -ceq 'CREATE_COLLISION') { 'FAIL' } elseif ($case.expectedPhase -ceq 'CREATE_FAILED') { 'FAIL' } else { 'UNKNOWN' }) -or
            $script:report.phase -cne $case.expectedPhase -or $script:report.profile_preexisted -cne $case.expectedPreexisted -or
            $script:report.path_resolution_status -cne 'UNKNOWN' -or
            $script:report.registration_state_before_cleanup -cne 'UNKNOWN' -or
            $script:report.registration_state_after_cleanup -cne 'UNKNOWN' -or
            $noObservationState.counters.ResolveProfilePath -ne 0 -or $noObservationState.counters.ObserveApi -ne 0 -or
            $noObservationState.counters.ScanRegistry -ne 0 -or $noObservationState.counters.ObserveCandidate -ne 0 -or
            $noObservationState.counters.GetCandidatePath -ne 0 -or $noObservationState.counters.MatchApiCandidate -ne 0 -or
            $noObservationState.counters.SidMatchesName -ne 0 -or $noObservationState.counters.DeleteProfile -ne 0 -or
            $noObservationState.counters.PostDeleteScan -ne 0 -or $noObservationState.counters.PostDeleteCandidate -ne 0) {
            throw ('Synthetic create gate allowed an operation after ' + $case.name + ': phase=' +
                $script:report.phase + '; preexisted=' + $script:report.profile_preexisted + '; counters=' +
                ($noObservationState.counters | ConvertTo-Json -Compress) + '.')
        }
        if ($case.name -ceq 'collision' -and $script:report.create_hresult -ne -2147024713 -or
            $case.name -ceq 'create-failure' -and $script:report.create_hresult -ne -2147024894 -or
            $case.name -ceq 'missing-hresult' -and $null -ne $script:report.create_hresult) {
            throw ('Synthetic raw create HRESULT classification failed: ' + $case.name + '.')
        }
    }

    & $resetProfilePathResolveSyntheticState $validSyntheticCreate
    $script:profilePathResolveSelfTestState.throwCreate = $true
    $interruptedOperations = & $profilePathResolveBuildSyntheticOperations
    $interruptedResult = Invoke-ProfilePathResolveTransaction 'AgentCP0123456789abcdef0' `
        '0123456789abcdef0123456789abcdef' 'synthetic-owner-local-appdata' `
        'synthetic-private-report-path' `
        'runtime/diagnostics/appcontainer-profile-path-0123456789abcdef0123456789abcdef.jsonl' $interruptedOperations
    $interruptedState = $script:profilePathResolveSelfTestState
    if ($interruptedState.journalSnapshots[0].phase -cne 'CREATE_ATTEMPTED' -or
        $interruptedState.journalSnapshots.Count -ne 2 -or
        $interruptedState.journalSnapshots[1].phase -cne 'CREATE_RESULT_UNKNOWN' -or
        $interruptedState.journalSnapshots[1].report.profile_create_attempted -ne $true -or
        $interruptedState.counters.CreateProfile -ne 1 -or $interruptedState.counters.ResolveProfilePath -ne 0 -or
        $interruptedState.counters.ObserveApi -ne 0 -or $interruptedState.counters.ScanRegistry -ne 0 -or
        $interruptedState.counters.ObserveCandidate -ne 0 -or $interruptedState.counters.DeleteProfile -ne 0 -or
        $interruptedResult.status -cne 'UNKNOWN') {
        throw 'Synthetic interrupted CREATE_ATTEMPTED state was not preserved fail-closed.'
    }

    foreach ($syntheticStage in $syntheticProfilePathStages) {
        & $resetProfilePathResolveSyntheticState $validSyntheticCreate
        $script:profilePathResolveSelfTestState.pathException =
            $syntheticProfilePathStageExceptions[$syntheticStage]
        $stageTransactionResult = & $profilePathResolveRunSyntheticTransaction $validSyntheticCreate $true
        $stageTransactionJson = $script:report | ConvertTo-Json -Depth 8 -Compress
        if ($stageTransactionResult.status -ceq 'COMPLETE' -or
            $script:report.path_resolution_status -cne 'FAIL' -or
            $script:report.path_stage -cne $syntheticStage -or
            $script:report.path_exception_type -notin @('InvalidOperationException', 'RuntimeException', 'Exception', 'OTHER') -or
            $script:report.delete_decision -cne 'NOT_ATTEMPTED' -or
            $script:report.cleanup_status -cne 'NOT_ATTEMPTED' -or
            $script:profilePathResolveSelfTestState.counters.DeleteProfile -ne 0 -or
            $script:profilePathResolveSelfTestState.counters.PostDeleteScan -ne 0 -or
            $script:profilePathResolveSelfTestState.counters.PostDeleteCandidate -ne 0 -or
            $stageTransactionJson.Contains('Synthetic private profile path value')) {
            throw ('Synthetic transactional profile path stage failed closed or leaked diagnostics: ' +
                $syntheticStage + '.')
        }
    }

    $sidConversionFailure = [pscustomobject]@{
        HResult = [int]0; Sid = $null; FailureType = 'ArgumentException'
        FailureRecord = [System.Management.Automation.ErrorRecord]::new(
            [System.ArgumentException]::new('Synthetic private SID conversion failure.'), 'SyntheticSidConversionFailure',
            [System.Management.Automation.ErrorCategory]::InvalidData, $null)
    }
    $sidConversionResult = & $profilePathResolveRunSyntheticTransaction $sidConversionFailure
    $sidConversionState = $script:profilePathResolveSelfTestState
    if ($sidConversionResult.status -ceq 'COMPLETE' -or $sidConversionState.counters.ResolveProfilePath -ne 0 -or
        $sidConversionState.counters.ObserveApi -ne 1 -or $sidConversionState.counters.ScanRegistry -ne 1 -or
        $sidConversionState.counters.ObserveCandidate -ne 1 -or $sidConversionState.counters.DeleteProfile -ne 0 -or
        $script:report.path_resolution_status -cne 'NOT_ATTEMPTED' -or $script:report.cleanup_status -cne 'NOT_ATTEMPTED') {
        throw 'Synthetic S_OK SID-conversion failure did not permit only read-only observations.'
    }

    $registrationStateCases = @(
        [pscustomobject]@{ name = 'present'; scan = $syntheticSuccessState.scan; expected = 'PRESENT' },
        [pscustomobject]@{ name = 'absent'; scan = $syntheticSuccessState.postScan; expected = 'ABSENT' },
        [pscustomobject]@{ name = 'incomplete'; scan = [pscustomobject]@{ status = 'UNKNOWN'; scan_complete = $false; stability_status = 'UNKNOWN' }; expected = 'UNKNOWN' },
        [pscustomobject]@{ name = 'duplicate'; scan = [pscustomobject]@{ status = 'COMPLETE'; scan_complete = $true; stability_status = 'STABLE'; complete_match_count = [int]2; partial_match_count = [int]0; case_only_pair_count = [int]0; partial_missing_pair_count = [int]0; partial_different_pair_count = [int]0; malformed_value_count = [int]0 }; expected = 'UNKNOWN' },
        [pscustomobject]@{ name = 'malformed'; scan = [pscustomobject]@{ status = 'COMPLETE'; scan_complete = $true; stability_status = 'STABLE'; complete_match_count = [int]1; partial_match_count = [int]0; case_only_pair_count = [int]0; partial_missing_pair_count = [int]0; partial_different_pair_count = [int]0; malformed_value_count = [int]1 }; expected = 'UNKNOWN' }
    )
    foreach ($case in $registrationStateCases) {
        if ((Get-ProfilePathDiagnosticRegistrationState $case.scan) -cne $case.expected -or
            (Get-ProfilePathDiagnosticRegistrationState $case.scan) -ceq 'NOT_ATTEMPTED') {
            throw ('Synthetic registration-state mapping failed: ' + $case.name + '.')
        }
    }

    $transactionBlockCases = @('sid-mismatch', 'incomplete-scan', 'duplicate-scan', 'malformed-scan')
    foreach ($transactionBlockCase in $transactionBlockCases) {
        & $resetProfilePathResolveSyntheticState $validSyntheticCreate
        switch ($transactionBlockCase) {
            'sid-mismatch' { $script:profilePathResolveSelfTestState.sidMatchesName = $false }
            'incomplete-scan' {
                $script:profilePathResolveSelfTestState.scan.status = 'UNKNOWN'
                $script:profilePathResolveSelfTestState.scan.scan_complete = $false
                $script:profilePathResolveSelfTestState.scan.stability_status = 'UNKNOWN'
            }
            'duplicate-scan' { $script:profilePathResolveSelfTestState.scan.complete_match_count = [int]2 }
            'malformed-scan' { $script:profilePathResolveSelfTestState.scan.malformed_value_count = [int]1 }
        }
        $blockedTransactionResult = & $profilePathResolveRunSyntheticTransaction $validSyntheticCreate $true
        $expectedRegistrationState = if ($transactionBlockCase -ceq 'sid-mismatch') { 'PRESENT' } else { 'UNKNOWN' }
        if ($blockedTransactionResult.status -ceq 'COMPLETE' -or
            $script:profilePathResolveSelfTestState.counters.DeleteProfile -ne 0 -or
            $script:report.delete_decision -cne 'NOT_ATTEMPTED' -or
            $script:report.registration_state_before_cleanup -cne $expectedRegistrationState -or
            $script:report.registration_state_after_cleanup -cne $expectedRegistrationState -or
            ($transactionBlockCase -ceq 'sid-mismatch' -and $script:report.sid_matches_name -ne $false)) {
            throw ('Synthetic identity/scan failure did not block deletion: ' + $transactionBlockCase + '.')
        }
    }

    $safePresentCandidate = [pscustomobject]@{
        status = 'PRESENT'; shape_valid = $true; candidate_exists = $true
        candidate_is_directory = $true; reparse_point = $false
    }
    $safeAbsentCandidate = [pscustomobject]@{
        status = 'ABSENT'; shape_valid = $true; candidate_exists = $false
        candidate_is_directory = $false; reparse_point = $false
    }
    $deletePrerequisites = @($true, $false, $true, $true, $true, $true, 'PASS', $safePresentCandidate, $true, $false)
    if ((Get-ProfilePathDiagnosticDeleteDecision @deletePrerequisites) -cne 'DELETE' -or
        (Get-ProfilePathDiagnosticDeleteDecision $true $false $true $true $true $true 'PASS' $safeAbsentCandidate $true $false) -cne 'DELETE') {
        throw 'Synthetic safe PRESENT/ABSENT candidate did not satisfy cleanup ownership.'
    }
    $deletePreconditionCases = @(
        @{ index = 0; value = $false }, @{ index = 1; value = $true }, @{ index = 2; value = $false },
        @{ index = 3; value = $false }, @{ index = 4; value = $false }, @{ index = 5; value = $false },
        @{ index = 6; value = 'UNKNOWN' }, @{ index = 8; value = $false }, @{ index = 9; value = $true }
    )
    foreach ($case in $deletePreconditionCases) {
        $blockedArguments = @($deletePrerequisites)
        $blockedArguments[$case.index] = $case.value
        if ((Get-ProfilePathDiagnosticDeleteDecision @blockedArguments) -cne 'NOT_ATTEMPTED') {
            throw ('Synthetic delete ownership precondition was ignored: index=' + $case.index + '.')
        }
    }
    foreach ($unsafeCandidate in @(
        [pscustomobject]@{ status = 'ABSENT'; shape_valid = $false; candidate_exists = $false; candidate_is_directory = $false; reparse_point = $false },
        [pscustomobject]@{ status = 'ABSENT'; shape_valid = $true; candidate_exists = $true; candidate_is_directory = $false; reparse_point = $false },
        [pscustomobject]@{ status = 'ABSENT'; shape_valid = $true; candidate_exists = $false; candidate_is_directory = $true; reparse_point = $false },
        [pscustomobject]@{ status = 'PRESENT'; shape_valid = $true; candidate_exists = $true; candidate_is_directory = $true; reparse_point = $true },
        [pscustomobject]@{ status = 'NOT_DIRECTORY'; shape_valid = $true; candidate_exists = $true; candidate_is_directory = $false; reparse_point = $false },
        [pscustomobject]@{ status = 'REPARSE_POINT'; shape_valid = $true; candidate_exists = $true; candidate_is_directory = $true; reparse_point = $true },
        [pscustomobject]@{ status = 'UNKNOWN'; shape_valid = $true; candidate_exists = $null; candidate_is_directory = $null; reparse_point = $false }
    )) {
        $unsafeDecision = Get-ProfilePathDiagnosticDeleteDecision $true $false $true $true $true $true 'PASS' $unsafeCandidate $true $false
        if ($unsafeDecision -cne 'NOT_ATTEMPTED') {
            throw ('Synthetic unsafe/unknown candidate authorized deletion: status=' + $unsafeCandidate.status +
                '; shape=' + $unsafeCandidate.shape_valid + '; exists=' + $unsafeCandidate.candidate_exists +
                '; directory=' + $unsafeCandidate.candidate_is_directory + '; reparse=' +
                $unsafeCandidate.reparse_point + '; decision=' + $unsafeDecision + '.')
        }
    }
    if ((Get-ProfilePathDiagnosticCleanupStatus $true ([int]0) 'PASS' $safeAbsentCandidate) -cne 'PASS' -or
        (Get-ProfilePathDiagnosticCleanupStatus $true ([int]1) 'PASS' $safeAbsentCandidate) -cne 'PASS' -or
        (Get-ProfilePathDiagnosticCleanupStatus $false $null 'PASS' $safeAbsentCandidate) -cne 'NOT_ATTEMPTED' -or
        (Get-ProfilePathDiagnosticCleanupStatus $true ([int]0) 'PASS' $safePresentCandidate) -cne 'FAIL' -or
        (Get-ProfilePathDiagnosticCleanupStatus $true ([int]0) 'UNKNOWN' $safeAbsentCandidate) -cne 'UNKNOWN' -or
        (Get-ProfilePathDiagnosticCleanupStatus $true ([int]-2147024894) 'PASS' $safeAbsentCandidate) -cne 'UNKNOWN' -or
        (Get-ProfilePathDiagnosticCleanupStatus $false $null $null $null) -cne 'UNKNOWN') {
        throw 'Synthetic post-delete cleanup status matrix failed.'
    }

    & $resetProfilePathResolveSyntheticState $validSyntheticCreate
    $script:profilePathResolveSelfTestState.api.ApiHResult = [int]-2147024894
    $script:profilePathResolveSelfTestState.api.PathPresent = $false
    $apiFailureResult = & $profilePathResolveRunSyntheticTransaction $validSyntheticCreate $true
    if ($apiFailureResult.status -ceq 'COMPLETE' -or $script:report.cleanup_status -cne 'NOT_ATTEMPTED' -or
        $script:profilePathResolveSelfTestState.counters.DeleteProfile -ne 0 -or
        $script:profilePathResolveSelfTestState.counters.ScanRegistry -ne 1 -or
        $script:profilePathResolveSelfTestState.counters.ObserveCandidate -ne 1) {
        throw 'Synthetic independent API observation failure did not block deletion and COMPLETE.'
    }

    foreach ($postCase in @('negative-delete', 'delete-throws', 'incomplete-post', 'residual-post')) {
        & $resetProfilePathResolveSyntheticState $validSyntheticCreate
        if ($postCase -ceq 'negative-delete') { $script:profilePathResolveSelfTestState.deleteHResult = [int]-2147024894 }
        elseif ($postCase -ceq 'delete-throws') { $script:profilePathResolveSelfTestState.throwDelete = $true }
        elseif ($postCase -ceq 'incomplete-post') {
            $script:profilePathResolveSelfTestState.postScan.status = 'UNKNOWN'
            $script:profilePathResolveSelfTestState.postScan.scan_complete = $false
            $script:profilePathResolveSelfTestState.postScan.stability_status = 'UNKNOWN'
        } else {
            $script:profilePathResolveSelfTestState.postScan.complete_match_count = [int]1
            $script:profilePathResolveSelfTestState.postCandidate.status = 'PRESENT'
            $script:profilePathResolveSelfTestState.postCandidate.candidate_exists = $true
            $script:profilePathResolveSelfTestState.postCandidate.candidate_is_directory = $true
        }
        $postResult = & $profilePathResolveRunSyntheticTransaction $validSyntheticCreate $true
        $expectedCleanup = switch ($postCase) {
            'negative-delete' { 'UNKNOWN' }
            'delete-throws' { 'UNKNOWN' }
            'incomplete-post' { 'UNKNOWN' }
            'residual-post' { 'FAIL' }
        }
        if ($script:profilePathResolveSelfTestState.counters.DeleteProfile -ne 1 -or
            $script:profilePathResolveSelfTestState.counters.PostDeleteScan -ne 1 -or
            $script:report.cleanup_status -cne $expectedCleanup -or
            ($postCase -ceq 'residual-post' -and $postResult.status -cne 'FAIL')) {
            throw ('Synthetic delete/post-observation behavior failed: ' + $postCase + '.')
        }
    }

    & $resetProfilePathResolveSyntheticState $validSyntheticCreate
    $privacyResult = & $profilePathResolveRunSyntheticTransaction $validSyntheticCreate
    $privacyStdout = ConvertTo-Json -InputObject ([ordered]@{
        status = $privacyResult.status
        report_path = $privacyResult.report_path
    }) -Compress
    $privacyReport = $script:report | ConvertTo-Json -Depth 8 -Compress
    if ($privacyStdout -match 'AgentCP0123456789abcdef0|S-1-15-2-123|synthetic-private|Synthetic private' -or
        $privacyReport -notmatch 'AgentCP0123456789abcdef0|S-1-15-2-123|synthetic-private-profile-path|synthetic-private-candidate-path') {
        throw 'Synthetic stdout/report identity separation failed.'
    }
    & $resetProfilePathResolveSyntheticState $validSyntheticCreate
    $script:profilePathResolveSelfTestState.throwPath = $true
    $privacyFailureResult = & $profilePathResolveRunSyntheticTransaction $validSyntheticCreate $true
    $privacyFailureStdout = ConvertTo-Json -InputObject ([ordered]@{
        status = $privacyFailureResult.status
        report_path = $privacyFailureResult.report_path
    }) -Compress
    $privacyFailureReport = $script:report | ConvertTo-Json -Depth 8 -Compress
    if ($privacyFailureStdout -match 'AgentCP0123456789abcdef0|S-1-15-2-123|synthetic-private|Synthetic private' -or
        $privacyFailureReport -match 'Synthetic private path failure|synthetic-private-registry-value' -or
        $privacyFailureReport -notmatch 'InvalidOperationException') {
        throw 'Synthetic private exception or registry value leaked from diagnostic state.'
    }
    # G8.2 synthetic transaction contract: end
    Write-Output 'AppContainer probe synthetic PowerShell contract: PASS'
    exit 0
}

if ($ProfilePathResolveDiagnosticOnly) {
    try {
        $diagnosticResult = Invoke-ProfilePathResolveDiagnosticMode
    } catch {
        try { Close-ProfilePathDiagnosticJournal } catch { }
        $failurePhase = $script:profilePathDiagnosticJournalFailurePhase
        if ($script:profilePathDiagnosticReportPersisted -and
            $failurePhase -notin @('REPORT_RESERVATION_FAILED', 'REPORT_WRITE_FAILED') -and
            $script:profilePathDiagnosticLastPersistedPhase) {
            $failurePhase = $script:profilePathDiagnosticLastPersistedPhase
            $failureStatus = $script:profilePathDiagnosticLastPersistedStatus
            $writeStatus = 'PASS'
        } else {
            if ($failurePhase -notin @('REPORT_RESERVATION_FAILED', 'REPORT_WRITE_FAILED')) {
                $failurePhase = 'UNEXPECTED_FAILURE'
            }
            $failureStatus = if ($failurePhase -ceq 'REPORT_RESERVATION_FAILED') { 'FAIL' } else { 'UNKNOWN' }
            $writeStatus = $script:profilePathDiagnosticReportWriteStatus
        }
        $diagnosticResult = Convert-ProfilePathDiagnosticSafeResult $failureStatus $failurePhase `
            $writeStatus `
            ([bool]$script:profilePathDiagnosticReportWriteAttempted) `
            ([bool]$script:profilePathDiagnosticReportPersisted) `
            ([int]$script:profilePathDiagnosticLastPersistedSequence) `
            ([bool]$script:profilePathDiagnosticCreateAttempted) `
            ([bool]$script:profilePathDiagnosticReportPathReserved) `
            $script:profilePathDiagnosticReportRelativePath
    }

    $safeResult = Convert-ProfilePathDiagnosticSafeResult $diagnosticResult.status $diagnosticResult.phase `
        $diagnosticResult.report_write_status $diagnosticResult.report_write_attempted `
        $diagnosticResult.report_persisted $diagnosticResult.last_persisted_sequence `
        $diagnosticResult.profile_create_attempted ($null -ne $diagnosticResult.report_path) `
        $diagnosticResult.report_path
    [Console]::Out.Write((ConvertTo-Json -InputObject $safeResult -Compress) + "`n")
    $exitCode = if ($safeResult.status -ceq 'COMPLETE' -and
        $null -ne $script:report -and $script:report.cleanup_status -ceq 'PASS') { 0 } else { 1 }
    exit $exitCode
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'The AppContainer probe supports Windows only.'
    }
    if ($FilesystemTimeoutMs -lt 5000 -or $FilesystemTimeoutMs -gt 30000 -or
        $TreeTimeoutMs -lt 1000 -or $TreeTimeoutMs -gt 10000) {
        throw 'Probe timeout values are outside the supported bounded range.'
    }
    if (($PreflightOnly -and $ProtocolSmokeOnly) -or
        ($ProfileContractImportDiagnosticOnly -and ($PreflightOnly -or $ProtocolSmokeOnly -or $ProfileBootstrapDiagnosticOnly)) -or
        ($ProfileBootstrapDiagnosticOnly -and ($PreflightOnly -or $ProtocolSmokeOnly)) -or
        ($ProfilePathResolveDiagnosticOnly -and ($PreflightOnly -or $ProtocolSmokeOnly -or
            $ProfileContractImportDiagnosticOnly -or $ProfileBootstrapDiagnosticOnly -or
            $ProfileMappingReadOnlyDiagnosticOnly -or $SelfTest))) {
        throw 'The selected profile, preflight, and protocol diagnostic modes are mutually exclusive.'
    }

    $currentPhase = 'preflight-paths'
    $null = Assert-NoReparsePath $repoRoot
    $null = Assert-NoReparsePath $PSScriptRoot
    if (Test-Path -LiteralPath $reportPath) { $null = Assert-OrdinaryOwnedReport $reportPath }
    $null = Ensure-SafeDirectory $repoRoot (Join-Path $repoRoot 'runtime')
    $null = Ensure-SafeDirectory (Join-Path $repoRoot 'runtime') $diagnosticsRoot
    $null = Ensure-SafeDirectory $diagnosticsRoot $runRoot
    if (-not ($ProfileContractImportDiagnosticOnly -or $ProfileBootstrapDiagnosticOnly -or
        $ProfilePathResolveDiagnosticOnly)) {
        $null = Ensure-SafeDirectory $diagnosticsRoot $canaryCollectionRoot
    }
    if (-not $profileRunStageInTemp) {
        $null = New-SafeDirectory $runRoot $stageRoot ([ref]$stageCreated)
        $null = Ensure-SafeDirectory $stageRoot $toolsRoot
        $null = Ensure-SafeDirectory $stageRoot $workspaceRoot
    }
    $null = Assert-ChildPath $diagnosticsRoot $reportPath

    $nodeSource = Assert-RegularFile (Get-NodeExecutable)
    $nodeHash = Get-Sha256 $nodeSource
    $report.node_sha256 = $nodeHash
    $workerSource = Assert-RegularChildFile $PSScriptRoot $workerSourcePath
    $probeHash = Get-Sha256 $workerSource
    $probeContractSource = Assert-RegularChildFile $PSScriptRoot $probeContractSourcePath
    $probeContractHash = Get-Sha256 $probeContractSource
    $moduleHookSource = Assert-RegularChildFile $PSScriptRoot $moduleHookSourcePath
    $moduleHookHash = Get-Sha256 $moduleHookSource
    $stdioSmokeSource = Assert-RegularChildFile $PSScriptRoot $stdioSmokeSourcePath
    $stdioSmokeHash = Get-Sha256 $stdioSmokeSource
    $scriptSource = Assert-RegularChildFile $PSScriptRoot $scriptSourcePath
    $scriptHash = Get-Sha256 $scriptSource
    $launcherSource = Read-ValidatedSource $PSScriptRoot $launcherPath
    if ($launcherSource.Text -notmatch 'JOB_OBJECT_LIMIT_JOB_MEMORY' -or
        $launcherSource.Text -notmatch 'MAX_JOB_MEMORY_BYTES\s*=\s*new UIntPtr\(1024UL\s*\*\s*1024UL\s*\*\s*1024UL\)' -or
        ([regex]::Matches($launcherSource.Text, 'JobMemoryLimit\s*=\s*MAX_JOB_MEMORY_BYTES')).Count -lt 2) {
        throw 'The launcher does not bind the required 1 GiB committed Job memory limit to both worker paths.'
    }
    $report.launcher_sha256 = $launcherSource.Sha256
    $report.probe_script_sha256 = $scriptHash
    $report.diagnostic_worker_sha256 = $probeHash
    $report.probe_contract_sha256 = $probeContractHash
    $report.module_hook_sha256 = $moduleHookHash
    $report.stdio_smoke_sha256 = $stdioSmokeHash
    $baselinePath = Join-Path $diagnosticsRoot 'hardware-baseline.json'
    $null = Assert-ChildPath $diagnosticsRoot $baselinePath
    if (Test-Path -LiteralPath $baselinePath -PathType Leaf) {
        $null = Assert-NoReparsePath $baselinePath
        $baselineSha256 = Get-Sha256 $baselinePath
        $report.baseline_sha256 = $baselineSha256
    } else {
        throw 'The host hardware baseline is required to bind the G2.2 probe report.'
    }
    $report.node_version = ([string](& $nodeSource '--version' 2>$null)).Trim()
    if ($LASTEXITCODE -ne 0 -or $report.node_version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
        throw 'The trusted Node version query returned an invalid result.'
    }
    $report.runner_sha256 = Get-RuntimeFingerprint $nodeSource $repoRoot

    if (-not $profileRunStageInTemp) {
        $currentPhase = 'preflight-host-acl'
        $null = Assert-ChildPath $runRoot $stageRoot
        Set-ProbeAcl $stageRoot $null ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) $false $false
        $null = Assert-ChildPath $stageRoot $toolsRoot
        Set-ProbeAcl $toolsRoot $null ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) $true $false
        $null = Assert-ChildPath $stageRoot $workspaceRoot
        Set-ProbeAcl $workspaceRoot $null ([System.Security.AccessControl.FileSystemRights]::Modify) $true $false

        $currentPhase = 'preflight-copy-hashes'
        $stageNode = Join-Path $toolsRoot 'node.exe'
        $stageWorker = Join-Path $toolsRoot 'worker.mjs'
        $stageProbeContract = Join-Path $toolsRoot 'probe-contract.mjs'
        $stageModuleHook = Join-Path $toolsRoot 'module-hook.mjs'
        $stageStdioSmoke = Join-Path $toolsRoot 'stdio-smoke.mjs'
        $null = Assert-ChildPath $toolsRoot $stageNode
        $null = Assert-ChildPath $toolsRoot $stageWorker
        $null = Assert-ChildPath $toolsRoot $stageProbeContract
        $null = Assert-ChildPath $toolsRoot $stageModuleHook
        $null = Assert-ChildPath $toolsRoot $stageStdioSmoke
        Copy-SafeFile $nodeSource $toolsRoot $stageNode
        Copy-SafeFile $workerSource $toolsRoot $stageWorker
        Copy-SafeFile $probeContractSource $toolsRoot $stageProbeContract
        Copy-SafeFile $moduleHookSource $toolsRoot $stageModuleHook
        Copy-SafeFile $stdioSmokeSource $toolsRoot $stageStdioSmoke
        $stagedNodeHash = Get-Sha256 $stageNode
        $stagedWorkerHash = Get-Sha256 $stageWorker
        $stagedProbeContractHash = Get-Sha256 $stageProbeContract
        $stagedModuleHookHash = Get-Sha256 $stageModuleHook
        $stagedStdioSmokeHash = Get-Sha256 $stageStdioSmoke
    } else {
        $stagedNodeHash = $nodeHash
        $stagedWorkerHash = $probeHash
        $stagedProbeContractHash = $probeContractHash
        $stagedModuleHookHash = $moduleHookHash
        $stagedStdioSmokeHash = $stdioSmokeHash
    }
    if ($stagedNodeHash -ne $nodeHash -or $stagedWorkerHash -ne $probeHash -or
        $stagedProbeContractHash -ne $probeContractHash -or $stagedModuleHookHash -ne $moduleHookHash -or
        $stagedStdioSmokeHash -ne $stdioSmokeHash) {
        throw 'Staged runtime fingerprint did not match its source.'
    }
    $fingerprintText = "AppContainerLauncher.cs=$($launcherSource.Sha256)`nrun-probes.ps1=$scriptHash`nworker.mjs=$stagedWorkerHash`nprobe-contract.mjs=$stagedProbeContractHash`nmodule-hook.mjs=$stagedModuleHookHash`nstdio-smoke.mjs=$stagedStdioSmokeHash`nnode.exe=$stagedNodeHash"
    $report.probe_components_sha256 = Get-TextSha256 $fingerprintText

    if ($PreflightOnly) {
        $currentPhase = 'preflight-only-stop'
        $report.status = 'BLOCKED'
        $report.observations.preflight_only = [ordered]@{
            path_validation = 'PASS'
            host_acl_setup = 'PASS'
            copied_artifact_hashes = 'PASS'
            add_type = 'NOT_RUN'
            profile_creation = 'NOT_RUN'
            node_started = 'NOT_RUN'
            worker_started = 'NOT_RUN'
            launcher_pinvoke = 'NOT_RUN'
        }
        $report.diagnostic = [ordered]@{
            phase = $currentPhase
            powershell_line = (Get-CallerLineNumber)
            command_name = $null
            fully_qualified_error_id = $null
            exception_type = $null
            hresult = $null
            api_hresult = $null
            api_operation = $null
            api_native_error_code = $null
            profile_path_stage = 'UNKNOWN'
            inner_exception_type = $null
            inner_hresult = $null
        }
    } else {
    $currentPhase = 'launcher-compile'
    # Compile only the validated in-memory definition; no source path is reopened and no P/Invoke runs here.
    Add-Type -TypeDefinition $launcherSource.Text -Language CSharp -ErrorAction Stop
    if ($ProfileBootstrapDiagnosticOnly) {
        $currentPhase = 'profile-bootstrap-preflight'
        $profileBootstrapCallerFullTrust = [AppContainerLauncher]::IsCurrentProcessFullTrust()
        $profileBootstrapObservation = $report.observations.profile_bootstrap_diagnostic
        $profileBootstrapObservation.caller_full_trust = [bool]$profileBootstrapCallerFullTrust
        if (-not $profileBootstrapCallerFullTrust) {
            throw 'The bootstrap diagnostic requires a full-trust caller process.'
        }
        $profileBootstrapOwnerLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        try {
            $profileBootstrapCandidatePath = Get-ProfileBootstrapCandidatePath $profileBootstrapCallerFullTrust `
                $profileBootstrapOwnerLocalAppData $profileName $nonce
            $profileBootstrapCandidateAbsentBefore = Test-SafePathAbsent `
                (Join-Path $profileBootstrapOwnerLocalAppData 'Packages') $profileBootstrapCandidatePath
            if (-not $profileBootstrapCandidateAbsentBefore) {
                throw 'The nonce-derived profile candidate already exists; refusing to bootstrap into it.'
            }
        } catch {
            $profileBootstrapObservation.before_bootstrap.candidate_validation = 'FAIL'
            throw
        }
        $profileBootstrapCandidateValidated = $true
        $profileBootstrapObservation.caller_local_appdata_safe = $true
        $profileBootstrapObservation.candidate_path_validated = $true
        $profileBootstrapObservation.candidate_absent_before_create = $true
    }
    $currentPhase = 'profile-create'
    $profileCreateAttempted = $true
    $profileSidText = [AppContainerLauncher]::CreateProfile($profileName)
    $profileCreated = $true
    if ($ProfileBootstrapDiagnosticOnly) {
        $report.scope = 'profile-bootstrap-diagnostic-only'
        $currentPhase = 'profile-bootstrap-sid-verify'
        $profileBootstrapSidMatchesName = [AppContainerLauncher]::ProfileSidMatchesName($profileSidText, $profileName)
        $profileBootstrapObservation.profile_sid_matches_name = [bool]$profileBootstrapSidMatchesName
        Set-Check 'appcontainer_profile' 'PASS'
        if (-not $profileBootstrapSidMatchesName) {
            throw 'The created AppContainer SID did not match the SID derived from its generated name.'
        }
        $currentPhase = 'profile-bootstrap-api-before-observation'
        $profileBootstrapBeforeApiObservation = Invoke-ProfileBootstrapApiObservation {
            $checkedCandidate = Get-ProfileBootstrapCandidatePath $profileBootstrapCallerFullTrust `
                $profileBootstrapOwnerLocalAppData $profileName $nonce
            return [string]::Equals($checkedCandidate, $profileBootstrapCandidatePath, [StringComparison]::OrdinalIgnoreCase)
        } {
            [AppContainerLauncher]::ObserveProfilePath($profileSidText, $profileName, $nonce, $profileBootstrapCandidatePath)
        }
        $profileBootstrapObservation.before_bootstrap = $profileBootstrapBeforeApiObservation
        if ($profileBootstrapBeforeApiObservation.candidate_validation -cne 'PASS' -or
            $profileBootstrapBeforeApiObservation.api_call -cne 'CALLED') {
            $profileBootstrapCandidateValidated = $false
            $profileBootstrapObservation.candidate_path_validated = $false
            throw 'The pre-bootstrap profile path observation could not be completed safely.'
        }
        $profileSid = [System.Security.Principal.SecurityIdentifier]::new($profileSidText)
        $currentPhase = 'profile-bootstrap-staging-acl'
        $profileBootstrapStagingAclAttempted = $true
        $profileBootstrapObservation.staging_acl.attempted = $true
        $profileBootstrapObservation.staging_acl.status = 'UNKNOWN'
        $profileBootstrapStagingAclObservation = Set-ProfileBootstrapStagingAcl `
            $runRoot $stageRoot $toolsRoot $stageNode $nonce $profileSid
        $profileBootstrapObservation.staging_acl = $profileBootstrapStagingAclObservation
        if ($profileBootstrapStagingAclObservation.status -cne 'PASS') {
            Set-Check 'staging_acl' ([string]$profileBootstrapStagingAclObservation.status)
            Set-Check 'staging_app_sid_dacl_minimum' ([string]$profileBootstrapStagingAclObservation.status)
            throw 'The bootstrap App SID staging DACL inventory failed; the inline worker was not launched.'
        }
        Set-Check 'staging_acl' 'PASS'
        Set-Check 'staging_app_sid_dacl_minimum' 'PASS'
        $profileBootstrapTempPath = Join-Path $profileBootstrapCandidatePath 'Temp'
        $profileBootstrapMarkerPath = Join-Path $profileBootstrapTempPath ('agentcp-bootstrap-' + $nonce + '.marker')
        $profileBootstrapMarkerContent = $profileBootstrapMarkerPrefix + $nonce
        $null = Assert-ChildPath $profileBootstrapCandidatePath $profileBootstrapTempPath
        $null = Assert-ChildPath $profileBootstrapTempPath $profileBootstrapMarkerPath
        $currentPhase = 'profile-bootstrap-launch'
        $profileBootstrapExecutionAttempted = $true
        $profileLocalWritesAttempted = $true
        $report.profile_local_write_attempted = $true
        $profileBootstrapRun = [AppContainerLauncher]::RunProfileBootstrapDiagnostic(
            $stageNode, $toolsRoot, $profileSidText, $profileName, $nonce,
            $profileBootstrapCandidatePath, $FilesystemTimeoutMs)
        $profileBootstrapObservation = Convert-ProfileBootstrapDiagnosticObservation $profileBootstrapRun
        $profileBootstrapObservation.caller_full_trust = [bool]$profileBootstrapCallerFullTrust
        $profileBootstrapObservation.caller_local_appdata_safe = $true
        $profileBootstrapObservation.candidate_path_validated = [bool]$profileBootstrapCandidateValidated
        $profileBootstrapObservation.candidate_absent_before_create = [bool]$profileBootstrapCandidateAbsentBefore
        $profileBootstrapObservation.profile_sid_matches_name = [bool]$profileBootstrapSidMatchesName
        $profileBootstrapObservation.staging_acl = $profileBootstrapStagingAclObservation
        $profileBootstrapObservation.before_bootstrap = $profileBootstrapBeforeApiObservation
        $report.observations.profile_bootstrap_diagnostic = $profileBootstrapObservation
        $profileBootstrapTempCreatedByDiagnostic = [bool]$profileBootstrapObservation.temp_created_by_diagnostic
        $currentPhase = 'profile-bootstrap-api-path-observation'
        $profileBootstrapApiPathObservation = Invoke-ProfileBootstrapApiObservation {
            $checkedCandidate = Get-ProfileBootstrapCandidatePath $profileBootstrapCallerFullTrust `
                $profileBootstrapOwnerLocalAppData $profileName $nonce
            return [string]::Equals($checkedCandidate, $profileBootstrapCandidatePath, [StringComparison]::OrdinalIgnoreCase)
        } {
            [AppContainerLauncher]::ObserveProfilePath($profileSidText, $profileName, $nonce, $profileBootstrapCandidatePath)
        }
        $profileBootstrapObservation.after_bootstrap = $profileBootstrapApiPathObservation
        $report.observations.profile_bootstrap_diagnostic = $profileBootstrapObservation
        if ($profileBootstrapApiPathObservation.candidate_validation -cne 'PASS' -or
            $profileBootstrapApiPathObservation.api_call -cne 'CALLED') {
            $profileBootstrapCandidateValidated = $false
            $profileBootstrapObservation.candidate_path_validated = $false
            throw 'The post-bootstrap profile path observation could not be completed safely.'
        }
        $profileBootstrapObservation.api_hresult = $profileBootstrapApiPathObservation.api_hresult
        $profileBootstrapObservation.api_candidate_matched = $profileBootstrapApiPathObservation.candidate_matched
        $report.status = 'BLOCKED'
    } else {
    $currentPhase = 'profile-path-resolve'
    $profilePath = [AppContainerLauncher]::GetProfilePath($profileSidText, $profileName, $nonce)
    $workerTempPath = Join-Path $profilePath 'Temp'
    if ($ProfileContractImportDiagnosticOnly) {
        $currentPhase = 'profile-temp-prepare'
        $profileContractPaths = Get-ProfileContractStagePaths $profilePath $profileName $nonce
        if (-not [string]::Equals([System.IO.Path]::GetFullPath($workerTempPath), $profileContractPaths.TempPath,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The resolved AppContainer Temp directory did not match the profile staging path.'
        }
        $profileContractStageRoot = $profileContractPaths.StageRoot
        $profileContractModulePath = $profileContractPaths.ModulePath
        $profileTempCanonical = Assert-NoReparsePath $profileContractPaths.TempPath
        $profileTempExists = -not (Test-SafePathAbsent $profilePath $profileTempCanonical)
        $profileTempExistedBeforeDiagnostic = [bool]$profileTempExists
        $profileTempIsDirectory = $false
        if ($profileTempExists) {
            $profileTempItem = Get-Item -LiteralPath $profileTempCanonical -Force
            $profileTempIsDirectory = [bool]$profileTempItem.PSIsContainer
        }
        $profileTempPreparation = Get-ProfileTempPreparationDecision $profileTempExists $profileTempIsDirectory
        if ($profileTempPreparation -eq 'CREATE') {
            $profileTempCreationAttempted = $true
            $profileLocalWritesAttempted = $true
            $report.profile_local_write_attempted = $true
            $null = New-SafeDirectory $profilePath $profileTempCanonical ([ref]$profileTempCreatedByDiagnostic)
        }
        $profileContractObservation = $report.observations.profile_contract_import_diagnostic
        $profileContractObservation.profile_temp_created_by_diagnostic = [bool]$profileTempCreatedByDiagnostic
    }
    if ($profileRunStageInTemp) {
        $currentPhase = 'profile-run-stage-prepare'
        $profileRunPaths = Get-ProfileRunStagePaths $profilePath $profileName $nonce
        if (-not [string]::Equals([System.IO.Path]::GetFullPath($workerTempPath), $profileRunPaths.TempPath,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The resolved AppContainer Temp directory did not match the per-run staging path.'
        }
        $profileTempCanonical = Assert-NoReparsePath $profileRunPaths.TempPath
        $profileRunStagePathValidated = $true
        $profileRunTempCleanupRequired = $true
        $report.observations.profile_run_stage.profile_temp_path_validated = $true
        $profileRunTempExistedBefore = -not (Test-SafePathAbsent $profilePath $profileTempCanonical)
        $report.observations.profile_run_stage.profile_temp_existed_before = [bool]$profileRunTempExistedBefore
        if ($profileRunTempExistedBefore) {
            $profileTempItem = Get-Item -LiteralPath $profileTempCanonical -Force
            if (-not $profileTempItem.PSIsContainer -or
                ($profileTempItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'The AppContainer Temp path is not an ordinary directory.'
            }
            $tempEntries = @([System.IO.Directory]::EnumerateFileSystemEntries($profileTempCanonical))
            if ($tempEntries.Count -gt 0) {
                throw 'The fresh AppContainer Temp path contains unexpected entries.'
            }
            $profileRunTempWasEmptyBefore = $true
        } else {
            $profileRunTempWasEmptyBefore = $true
            $profileLocalWritesAttempted = $true
            $report.profile_local_write_attempted = $true
            $profileRunTempCreationAttempted = $true
            $report.observations.profile_run_stage.profile_temp_creation_attempted = $true
            $null = New-SafeDirectory $profilePath $profileTempCanonical ([ref]$profileRunTempCreatedByDiagnostic)
            $report.observations.profile_run_stage.profile_temp_created_by_diagnostic = `
                [bool]$profileRunTempCreatedByDiagnostic
        }
        $report.observations.profile_run_stage.profile_temp_was_empty_before = $profileRunTempWasEmptyBefore

        $stageRootParent = $profileTempCanonical
        $stageRoot = $profileRunPaths.StageRoot
        $toolsRoot = $profileRunPaths.ToolsRoot
        $workspaceRoot = $profileRunPaths.WorkspaceRoot
        $profileRunStageAbsentBefore = Test-SafePathAbsent $stageRootParent $stageRoot
        $report.observations.profile_run_stage.nonce_stage_absent_before = [bool]$profileRunStageAbsentBefore
        if (-not $profileRunStageAbsentBefore) {
            throw 'The nonce-scoped AppContainer staging directory already exists.'
        }
        $profileRunStagePreflightSafe = $true
        $stdioSmokeMarkerPath = Join-Path $workspaceRoot 'stdio-smoke-execution.marker'
        $stagedWorkerTempPath = Join-Path $workspaceRoot ('localappdata\Packages\' + $profileName + '\AC\Temp')

        $profileLocalWritesAttempted = $true
        $report.profile_local_write_attempted = $true
        $null = New-SafeDirectory $stageRootParent $stageRoot ([ref]$stageCreated)
        $profileRunStageCreated = [bool]$stageCreated
        $report.observations.profile_run_stage.stage_created = [bool]$profileRunStageCreated
        $null = Ensure-SafeDirectory $stageRoot $toolsRoot
        $null = Ensure-SafeDirectory $stageRoot $workspaceRoot
        $stageNode = $profileRunPaths.NodePath
        $stageWorker = $profileRunPaths.WorkerPath
        $stageProbeContract = $profileRunPaths.ProbeContractPath
        $stageModuleHook = Assert-ChildPath $toolsRoot (Join-Path $toolsRoot 'module-hook.mjs')
        $stageStdioSmoke = $profileRunPaths.StdioSmokePath
        Copy-SafeFile $nodeSource $toolsRoot $stageNode
        Copy-SafeFile $workerSource $toolsRoot $stageWorker
        Copy-SafeFile $probeContractSource $toolsRoot $stageProbeContract
        Copy-SafeFile $moduleHookSource $toolsRoot $stageModuleHook
        Copy-SafeFile $stdioSmokeSource $toolsRoot $stageStdioSmoke
        $stagedNodeHash = Get-Sha256 $stageNode
        $stagedWorkerHash = Get-Sha256 $stageWorker
        $stagedProbeContractHash = Get-Sha256 $stageProbeContract
        $stagedModuleHookHash = Get-Sha256 $stageModuleHook
        $stagedStdioSmokeHash = Get-Sha256 $stageStdioSmoke
        if ($stagedNodeHash -ne $nodeHash -or $stagedWorkerHash -ne $probeHash -or
            $stagedProbeContractHash -ne $probeContractHash -or $stagedModuleHookHash -ne $moduleHookHash -or
            $stagedStdioSmokeHash -ne $stdioSmokeHash) {
            throw 'Per-run AppContainer staging did not match its validated sources.'
        }
    }
    $profileSid = [System.Security.Principal.SecurityIdentifier]::new($profileSidText)
    Set-Check 'appcontainer_profile' 'PASS'

    $currentPhase = 'staging-acl'
    $null = Assert-ChildPath $stageRootParent $stageRoot
    if (-not $profileRunStageInTemp) {
        Set-ProbeAcl $stageRoot $profileSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) $false
    }
    $null = Assert-ChildPath $stageRoot $toolsRoot
    if (-not $profileRunStageInTemp) {
        Set-ProbeAcl $toolsRoot $profileSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) $true
    }
    $null = Assert-ChildPath $stageRoot $workspaceRoot
    if (-not $profileRunStageInTemp) {
        Set-ProbeAcl $workspaceRoot $profileSid ([System.Security.AccessControl.FileSystemRights]::Modify) $true
    }
    Set-Check 'staging_acl' 'PASS'

    $stagingDaclLabels = [ordered]@{
        stageRoot = (Get-AppSidDaclSummary 'stageRoot' $stageRoot $profileSid `
            ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute))
        toolsRoot = (Get-AppSidDaclSummary 'toolsRoot' $toolsRoot $profileSid `
            ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute))
        workspaceRoot = (Get-AppSidDaclSummary 'workspaceRoot' $workspaceRoot $profileSid `
            ([System.Security.AccessControl.FileSystemRights]::Modify))
        stagedNode = (Get-AppSidDaclSummary 'stagedNode' $stageNode $profileSid `
            ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute))
        workerModule = (Get-AppSidDaclSummary 'workerModule' $stageWorker $profileSid `
            ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute))
        probeContract = (Get-AppSidDaclSummary 'probeContract' $stageProbeContract $profileSid `
            ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute))
        moduleHook = (Get-AppSidDaclSummary 'moduleHook' $stageModuleHook $profileSid `
            ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute))
    }
    $stagingDaclValues = @($stagingDaclLabels.Values)
    $stagingDaclFailureCount = @($stagingDaclValues | Where-Object { $_.status -ceq 'FAIL' }).Count
    $stagingDaclUnknownCount = @($stagingDaclValues | Where-Object { $_.status -ceq 'UNKNOWN' }).Count
    $moduleReadTraversePresent = $stagingDaclLabels.stagedNode.read_traverse_allow_ace_present -and
        $stagingDaclLabels.workerModule.read_traverse_allow_ace_present -and
        $stagingDaclLabels.probeContract.read_traverse_allow_ace_present -and
        $stagingDaclLabels.moduleHook.read_traverse_allow_ace_present
    $report.observations.staging_app_sid_dacl = [ordered]@{
        interpretation = 'App SID DACL ACE inventory only; not an effective token access check.'
        module_read_traverse_allow_aces_present = [bool]$moduleReadTraversePresent
        labels = $stagingDaclLabels
    }
    if ($stagingDaclFailureCount -gt 0) {
        Set-Check 'staging_app_sid_dacl_minimum' 'FAIL'
        throw 'App SID DACL inventory did not contain the expected allow ACEs; launcher startup was skipped.'
    }
    if ($stagingDaclUnknownCount -gt 0) {
        Set-Check 'staging_app_sid_dacl_minimum' 'UNKNOWN'
        throw 'App SID DACL inventory was incomplete; launcher startup was skipped.'
    }
    Set-Check 'staging_app_sid_dacl_minimum' 'PASS'

    $currentPhase = 'startup-attribute-diagnostic'
    $directoryTraversalInputs = Get-DirectoryAncestorDescriptorInputs $toolsRoot $stageRootParent $stageRoot $toolsRoot
    $stagedFileInputs = Get-StagedFileDescriptorInputs $stageWorker $stageProbeContract
    $startupAttributeDiagnostic = [AppContainerLauncher]::RunStartupAttributeDiagnostics(
        $stageNode, $workspaceRoot, $profileSidText, $profileName,
        [string[]]$directoryTraversalInputs.Labels, [byte[][]]$directoryTraversalInputs.Descriptors,
        [string[]]$stagedFileInputs.Labels, [byte[][]]$stagedFileInputs.Descriptors)
    $report.observations.startup_attribute_diagnostic = [ordered]@{
        control = Convert-SuspendedStartupObservation $startupAttributeDiagnostic.Control
        appcontainer = Convert-SuspendedStartupObservation $startupAttributeDiagnostic.AppContainer
    }
    $report.observations.appcontainer_token_diagnostic = Convert-AppContainerTokenDiagnostic `
        $startupAttributeDiagnostic.AppContainer $directoryTraversalInputs.Labels
    $report.observations.staged_file_access_diagnostic = Convert-StagedFileReadDiagnostic `
        $startupAttributeDiagnostic.AppContainer $stagedFileInputs.Labels
    $report.observations.staged_file_runtime_diagnostic = Convert-StagedNodeReadDiagnosticObservation $null
    if ($startupAttributeDiagnostic.Control.Passed) {
        Set-Check 'startup_attribute_control' 'PASS'
    } else {
        Set-Check 'startup_attribute_control' 'FAIL'
    }
    if ($startupAttributeDiagnostic.AppContainer.Attempted) {
        if ($startupAttributeDiagnostic.AppContainer.Passed) {
            Set-Check 'startup_attribute_appcontainer' 'PASS'
        } else {
            Set-Check 'startup_attribute_appcontainer' 'FAIL'
        }
    }
    if (-not $startupAttributeDiagnostic.Control.Passed -or
        $startupAttributeDiagnostic.Control.CleanupStatus -ne 'PASS' -or
        $startupAttributeDiagnostic.Control.FallbackUsed) {
        throw 'Startup control did not pass cleanly; later variant and worker probes were skipped.'
    }
    if (-not $startupAttributeDiagnostic.AppContainer.Attempted -or
        -not $startupAttributeDiagnostic.AppContainer.Passed -or
        $startupAttributeDiagnostic.AppContainer.CleanupStatus -ne 'PASS' -or
        $startupAttributeDiagnostic.AppContainer.FallbackUsed) {
        throw 'AppContainer startup variant did not pass cleanly; worker probes were skipped.'
    }
    if ($ProfileContractImportDiagnosticOnly) {
        $report.scope = 'profile-contract-import-diagnostic-only'
        $currentPhase = 'profile-contract-profile-staging'
        $profileContractObservation = $report.observations.profile_contract_import_diagnostic
        $profileContractObservation.host_staging_status = 'RUNNING'
        try {
            if ($null -eq $profileContractPaths -or $null -eq $profileTempCanonical) {
                throw 'The profile Temp directory was not safely prepared.'
            }
            $profileTempItem = Get-Item -LiteralPath $profileTempCanonical -Force
            if (-not $profileTempItem.PSIsContainer) { throw 'The AppContainer Temp path is not a directory.' }
            $profileContractSourceLength = [long](Get-Item -LiteralPath $probeContractSource -Force).Length
            if ($profileContractSourceLength -gt $profileContractDiagnosticMaxBytes) {
                throw 'The verified contract source exceeds the profile diagnostic read limit.'
            }
            $profileLocalWritesAttempted = $true
            $report.profile_local_write_attempted = $true
            $null = New-SafeDirectory $profileContractPaths.TempPath $profileContractStageRoot ([ref]$profileContractStageCreated)
            Copy-SafeFile $probeContractSource $profileContractStageRoot $profileContractModulePath
            $profileContractSourceHashMatched = Test-ProfileContractHashMatch `
                $probeContractHash (Get-Sha256 $profileContractModulePath) $profileContractSourceLength
            if (-not $profileContractSourceHashMatched) {
                throw 'The nonce-scoped profile contract copy did not match its verified source hash.'
            }
            $profileContractHostStagingStatus = 'PASS'
            $profileContractObservation.host_staging_status = 'PASS'
            $profileContractObservation.source_hash_matched = $true
        } catch {
            $profileContractHostStagingStatus = 'FAIL'
            $profileContractObservation.host_staging_status = 'FAIL'
            $profileContractObservation.source_hash_matched = [bool]$profileContractSourceHashMatched
            throw
        }

        $currentPhase = 'profile-contract-import-diagnostic'
        $profileContractRun = [AppContainerLauncher]::RunProfileContractImportDiagnostic(
            $stageNode, $profileContractModulePath, $workspaceRoot, $profileSidText, $profileName,
            $nonce, $probeContractHash, $FilesystemTimeoutMs, $profilePath)
        $profileContractRuntime = Convert-ProfileContractImportDiagnosticObservation $profileContractRun
        $profileContractRuntime.host_staging_status = $profileContractHostStagingStatus
        $profileContractRuntime.source_hash_matched = [bool]$profileContractSourceHashMatched
        $profileContractRuntime.cleanup_status = 'PENDING'
        $report.observations.profile_contract_import_diagnostic = $profileContractRuntime
    } elseif ($ProtocolSmokeOnly) {
        $report.scope = 'inline-stdio-smoke-only'
        $currentPhase = 'inline-stdio-smoke'
        $stdioInput = '{"probe":"stdio-smoke"}'
        $stdioExpectedBytes = Get-WorkerInputByteCount $stdioInput
        $null = Assert-ChildPath $workspaceRoot $stdioSmokeMarkerPath
        if (-not (Test-SafePathAbsent $workspaceRoot $stdioSmokeMarkerPath)) {
            throw 'The staged execution marker path must be absent before the stdio smoke.'
        }
        $stdioRun = [AppContainerLauncher]::RunNodeInlineStdioSmoke(
            $stageNode, $workspaceRoot, $profileSidText, $profileName, $FilesystemTimeoutMs)
        $stdioMarkers = Get-InlineStdioSmokeMarkers ([string]$stdioRun.Stdout) $stdioExpectedBytes
        $deadlineDecision = $stdioRun.DeadlineDecision
        $deadlineActiveProcesses = $null
        if ($null -ne $stdioRun.DeadlineActiveProcesses) {
            $deadlineActiveProcesses = [uint32]$stdioRun.DeadlineActiveProcesses
        }
        $deadlineQueryErrorCode = $null
        if ($null -ne $stdioRun.DeadlineQueryErrorCode) {
            $deadlineQueryErrorCode = [int]$stdioRun.DeadlineQueryErrorCode
        }
        $activeProcessesAfterDrain = $null
        if ($null -ne $stdioRun.ActiveProcessesAfterDrain) {
            $activeProcessesAfterDrain = [uint32]$stdioRun.ActiveProcessesAfterDrain
        }
        $report.observations.protocol_smoke = [ordered]@{
            boot_marker_present = $stdioMarkers.boot_marker_present
            input_marker_present = $stdioMarkers.input_marker_present
            bytes_read = $stdioMarkers.bytes_read
            duration_ms = [long]$stdioRun.DurationMs
            timed_out = [bool]$stdioRun.TimedOut
            exit_code = [int]$stdioRun.ExitCode
            root_process_signaled = [bool]$stdioRun.RootProcessSignaled
            deadline_decision = $deadlineDecision
            deadline_active_processes = $deadlineActiveProcesses
            deadline_query_error_code = $deadlineQueryErrorCode
            deadline_diagnostic = $stdioRun.DeadlineDiagnostic
            output_truncated = [bool]$stdioRun.OutputTruncated
            job_drained = [bool]$stdioRun.JobDrained
            active_processes_after_drain = $activeProcessesAfterDrain
            active_process_query_error_code = [int]$stdioRun.ActiveProcessQueryErrorCode
            drain_poll_wait_code = [int]$stdioRun.DrainPollWaitCode
            drain_diagnostic = [string]$stdioRun.DrainDiagnostic
            worker_token_verified = [bool]$stdioRun.WorkerTokenVerified
            job_membership_verified = [bool]$stdioRun.JobMembershipVerified
            stdout_bytes = [Text.Encoding]::UTF8.GetByteCount([string]$stdioRun.Stdout)
            stderr_bytes = [Text.Encoding]::UTF8.GetByteCount([string]$stdioRun.Stderr)
            stdout_sha256 = Get-TextSha256 ([string]$stdioRun.Stdout)
            stderr_sha256 = Get-TextSha256 ([string]$stdioRun.Stderr)
        }
        if ($stdioRun.WorkerTokenVerified) { Set-Check 'worker_appcontainer_token' 'PASS' }
        if ($stdioRun.JobMembershipVerified) { Set-Check 'worker_job_membership' 'PASS' }
        if ($stdioRun.TimedOut -or $stdioRun.ExitCode -ne 0 -or $stdioRun.OutputTruncated -or
            -not $stdioRun.JobDrained -or -not $stdioMarkers.boot_marker_present -or
            -not $stdioMarkers.input_marker_present -or $stdioMarkers.bytes_read -ne $stdioExpectedBytes) {
            $report.status = 'BLOCKED'
        }
    } else {
    $currentPhase = 'staged-file-runtime-diagnostic'
    $stagedFileRuntimeRun = [AppContainerLauncher]::RunStagedFileReadDiagnostic(
        $stageNode, $stageWorker, $stageProbeContract, $workspaceRoot, $profileSidText, $profileName, $FilesystemTimeoutMs)
    $report.observations.staged_file_runtime_diagnostic = Convert-StagedNodeReadDiagnosticObservation $stagedFileRuntimeRun
    $writeMarker = 'appcontainer-probe-write:' + $nonce
    $runtimeCanary = New-ProbeCanary 'runtime' $canaryCollectionRoot $canaryRoot `
        ('runtime-read:' + $nonce) $writeMarker ([ref]$canaryCreated) $true
    $null = Assert-ChildPath $canaryCollectionRoot $canaryRoot
    $repositoryCanary = New-ProbeCanary 'repository' $repoRoot $repositoryCanaryRoot `
        ('repository-read:' + $nonce) $writeMarker ([ref]$repositoryCanaryCreated)
    $oracleCanary = New-ProbeCanary 'oracle' $oracleCollectionRoot $oracleCanaryRoot `
        ('oracle-read:' + $nonce) $writeMarker ([ref]$oracleCanaryCreated)
    $ownerProfileCanary = New-ProbeCanary 'ownerProfile' $ownerProfileCanaryCollectionRoot $ownerProfileCanaryRoot `
        ('owner-profile-read:' + $nonce) $writeMarker ([ref]$ownerProfileCanaryCreated)
    $canaryReadPath = $runtimeCanary.read_path
    $canaryWritePath = $runtimeCanary.write_path
    $currentPhase = 'filesystem-probe'
    $requestCanaries = [ordered]@{}
    foreach ($scopeName in @('runtime', 'repository', 'oracle', 'ownerProfile')) {
        $record = $canaryRecords[$scopeName]
        $requestCanaries[$scopeName] = [ordered]@{
            readPath = $record.read_path
            writePath = $record.write_path
        }
    }
    $fileInput = [ordered]@{
        mode = 'filesystem'
        canaries = $requestCanaries
        writeMarker = $writeMarker
    } | ConvertTo-Json -Compress -Depth 5
    $fileRun = [AppContainerLauncher]::RunNodeWithModuleHooks(
        $stageNode, $stageModuleHook, 'probe', $workspaceRoot, $profileSidText, $profileName, $fileInput, $FilesystemTimeoutMs)
    $report.observations.filesystem_launcher = Get-WorkerLauncherObservation `
        $fileRun $stageWorker $stageProbeContract $stageNode $stageModuleHook
    $fileObservation = Convert-WorkerOutput $fileRun 'filesystem'
    $workspaceCanaryPath = Join-Path $workspaceRoot 'worker-write-canary.txt'
    $workspaceCanaryAbsent = Test-SafePathAbsent $workspaceRoot $workspaceCanaryPath
    $report.observations.filesystem = [ordered]@{
        worker_token_verified = $fileRun.WorkerTokenVerified
        job_membership_verified = $fileRun.JobMembershipVerified
        worker_stdout_sha256 = Get-TextSha256 $fileRun.Stdout.Trim()
        workspace_read_write = [bool]$fileObservation.workspace_read_write
        workspace_canary_absent = [bool]$fileObservation.workspace_canary_absent -and $workspaceCanaryAbsent
        canaries = [ordered]@{}
    }
    $report.checks.workspace_read_write = if ($fileObservation.workspace_read_write -and
        $fileObservation.workspace_canary_absent -and $workspaceCanaryAbsent) { 'PASS' } else { 'FAIL' }
    $expectedEnvironmentKeys = @('LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR')
    $observedEnvironmentKeys = @($fileObservation.environment_keys)
    $normalEnvironmentKeys = @($observedEnvironmentKeys | Where-Object { -not ([string]$_).StartsWith('=') })
    $pseudoEnvironmentKeys = @($observedEnvironmentKeys | Where-Object { ([string]$_).StartsWith('=') })
    $normalEnvironmentKeysMatch = $normalEnvironmentKeys.Count -eq $expectedEnvironmentKeys.Count
    foreach ($expectedKey in $expectedEnvironmentKeys) {
        $matchingKeyCount = @($normalEnvironmentKeys | Where-Object {
            [string]::Equals([string]$_, $expectedKey, [System.StringComparison]::OrdinalIgnoreCase)
        }).Count
        if ($matchingKeyCount -ne 1) { $normalEnvironmentKeysMatch = $false }
    }
    $workspaceDriveRoot = [System.IO.Path]::GetPathRoot($workspaceRoot)
    $expectedDrivePseudoKey = '=' + $workspaceDriveRoot.Substring(0, 2)
    $pseudoEnvironmentKeysMatch = $pseudoEnvironmentKeys.Count -eq 0
    if ($pseudoEnvironmentKeys.Count -eq 1) {
        $pseudoEnvironmentKeysMatch = [string]::Equals(
            [string]$pseudoEnvironmentKeys[0], $expectedDrivePseudoKey, [System.StringComparison]::OrdinalIgnoreCase)
    }
    if ($normalEnvironmentKeysMatch -and $pseudoEnvironmentKeysMatch) {
        Set-Check 'process_environment_minimal' 'PASS'
    } else { Set-Check 'process_environment_minimal' 'FAIL' }
    $filesystemAccessStatuses = @()
    foreach ($scopeName in @('runtime', 'repository', 'oracle', 'ownerProfile')) {
        $observation = $fileObservation.canaries.$scopeName
        $readStatus = Get-AccessProbeStatus $observation.read
        $writeStatus = Get-AccessProbeStatus $observation.write
        $filesystemAccessStatuses += $readStatus, $writeStatus
        $report.observations.filesystem.canaries[$scopeName] = [ordered]@{
            read_status = $observation.read.status
            read_code = $observation.read.code
            write_status = $observation.write.status
            write_code = $observation.write.code
        }
        if ($scopeName -eq 'runtime') {
            Set-Check 'runtime_canary_read_denied' $readStatus
            Set-Check 'runtime_canary_write_denied' $writeStatus
        } elseif ($scopeName -eq 'repository') {
            Set-Check 'repository_read_denied' $readStatus
            Set-Check 'repository_write_denied' $writeStatus
        } elseif ($scopeName -eq 'oracle') {
            Set-Check 'oracle_inaccessible' (Get-ProbeFinalStatus @($readStatus, $writeStatus))
        } else {
            Set-Check 'profile_read_denied' $readStatus
            Set-Check 'profile_write_denied' $writeStatus
        }
    }

    if ($fileRun.WorkerTokenVerified) { Set-Check 'worker_appcontainer_token' 'PASS' }
    else { Set-Check 'worker_appcontainer_token' 'FAIL' }
    if ($fileRun.JobMembershipVerified) { Set-Check 'worker_job_membership' 'PASS' }
    else { Set-Check 'worker_job_membership' 'FAIL' }
    $report.appcontainer_capabilities_status = [string]$fileRun.AppContainerCapabilitiesStatus
    $report.appcontainer_capability_count = $fileRun.AppContainerCapabilityCount
    $report.appcontainer_capabilities_error_code = $fileRun.AppContainerCapabilitiesErrorCode
    $filesystemStatus = Get-ProbeFinalStatus $filesystemAccessStatuses
    if ($filesystemStatus -eq 'PASS' -and $report.checks.workspace_read_write -eq 'PASS') {
        Set-Check 'filesystem_containment' 'PASS'
    } elseif ($filesystemStatus -eq 'FAIL' -or $report.checks.workspace_read_write -eq 'FAIL') {
        Set-Check 'filesystem_containment' 'FAIL'
    } else { Set-Check 'filesystem_containment' 'UNKNOWN' }

    $currentPhase = 'loopback-network-probe'
    $loopbackHelperRun = [AppContainerLauncher]::RunLoopbackConfigChild($scriptSourcePath, $profileSidText)
    $loopbackHelper = ConvertFrom-LoopbackConfigHelperOutput $loopbackHelperRun
    if ($loopbackHelper.uncertain) {
        $preserveStageForInspection = $true
        Set-Check 'network_denied' 'UNKNOWN'
        $report.observations.network = [ordered]@{
            loopback_exemption = 'UNKNOWN'
            loopback_entry_count = $null
            loopback_error_code = $loopbackHelperRun.ErrorCode
            loopback_cleanup_status = 'UNKNOWN'
            helper_process_created = [bool]$loopbackHelperRun.ProcessCreated
            helper_timed_out = [bool]$loopbackHelperRun.TimedOut
            helper_root_signaled = [bool]$loopbackHelperRun.RootProcessSignaled
            helper_job_drained = [bool]$loopbackHelperRun.JobDrained
            helper_cleanup_confirmed = [bool]$loopbackHelperRun.CleanupConfirmed
            helper_error_code = $loopbackHelperRun.ErrorCode
            host_control_status = 'UNKNOWN'
            host_control_failure_code = 'SKIPPED_UNCERTAIN_HELPER'
            worker_attempted = $false
            network_policy_status = 'UNKNOWN'
            network_capability_query_status = 'UNKNOWN'
            network_capability_count = $null
            network_capabilities_error_code = $null
            target_matches_listener = $false
            worker_transport_status = 'UNKNOWN'
            worker_connection_accepted = $false
        }
        throw 'The loopback configuration helper process termination or Job drain is uncertain.'
    }

    $probeListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $probeListener.Start()
    $loopbackPort = ([System.Net.IPEndPoint]$probeListener.LocalEndpoint).Port
    $hostControl = Invoke-HostLoopbackControl $probeListener
    $networkRun = $null
    $networkObservation = $null
    $networkWorkerAttempted = $false
    $listenerAcceptedConnection = $false
    $networkTargetMatchesListener = $false
    $networkTransportStatus = 'UNKNOWN'
    $networkSkipReason = if ($loopbackHelper.status -cne 'VALID') { 'LOOPBACK_CONFIG_UNKNOWN' } `
        elseif ($hostControl.status -cne 'PASS') { 'HOST_CONTROL_UNKNOWN' } else { 'NONE' }
    if ($loopbackHelper.status -ceq 'VALID' -and $hostControl.status -ceq 'PASS') {
        $networkWorkerAttempted = $true
        $networkRequest = [ordered]@{
            mode = 'network'
            host = '127.0.0.1'
            port = $loopbackPort
            timeoutMs = 1000
        }
        $networkInput = $networkRequest | ConvertTo-Json -Compress
        $listenerEndpoint = [System.Net.IPEndPoint]$probeListener.LocalEndpoint
        $networkTargetMatchesListener = $networkRequest.host -ceq '127.0.0.1' -and
            [int]$networkRequest.port -eq $listenerEndpoint.Port -and
            $listenerEndpoint.Address.Equals([System.Net.IPAddress]::Loopback)
        try {
            $networkRun = [AppContainerLauncher]::RunNodeWithModuleHooks(
                $stageNode, $stageModuleHook, 'probe', $workspaceRoot, $profileSidText, $profileName, $networkInput, $FilesystemTimeoutMs)
            if ($networkRun.WorkerTokenVerified) {
                $report.appcontainer_capabilities_status = [string]$networkRun.AppContainerCapabilitiesStatus
                $report.appcontainer_capability_count = $networkRun.AppContainerCapabilityCount
                $report.appcontainer_capabilities_error_code = $networkRun.AppContainerCapabilitiesErrorCode
                $report.appcontainer_network_capability_count = $networkRun.AppContainerNetworkCapabilityCount
            }
            try {
                $networkObservation = Convert-WorkerOutput $networkRun 'network'
                $networkTransportStatus = 'COMPLETE'
            } catch {
                $networkObservation = [pscustomobject]@{ mode = 'network'; status = 'UNKNOWN'; code = 'INCOMPLETE' }
            }
            $workerAcceptTimer = [Diagnostics.Stopwatch]::StartNew()
            while ($workerAcceptTimer.ElapsedMilliseconds -lt 1000 -and -not $probeListener.Pending()) {
                Start-Sleep -Milliseconds 10
            }
            if ($probeListener.Pending()) {
                $acceptedClient = $probeListener.AcceptTcpClient()
                try { $listenerAcceptedConnection = $true }
                finally { $acceptedClient.Dispose() }
            }
        } catch {
            $networkObservation = [pscustomobject]@{ mode = 'network'; status = 'UNKNOWN'; code = 'LAUNCH_UNKNOWN' }
        }
    }
    $networkEvidence = [pscustomobject]@{
        worker_attempted = [bool]$networkWorkerAttempted
        worker_token_verified = if ($null -ne $networkRun) { [bool]$networkRun.WorkerTokenVerified } else { $false }
        job_membership_verified = if ($null -ne $networkRun) { [bool]$networkRun.JobMembershipVerified } else { $false }
        capability_query_status = if ($null -ne $networkRun) { [string]$networkRun.AppContainerCapabilitiesStatus } else { 'UNKNOWN' }
        network_capability_count = if ($null -ne $networkRun) { $networkRun.AppContainerNetworkCapabilityCount } else { $null }
        capabilities_error_code = if ($null -ne $networkRun) { $networkRun.AppContainerCapabilitiesErrorCode } else { $null }
        loopback_helper_status = [string]$loopbackHelper.status
        loopback_exemption = [string]$loopbackHelper.exemption
        host_control_status = [string]$hostControl.status
        target_matches_listener = [bool]$networkTargetMatchesListener
        listener_accepted = [bool]$listenerAcceptedConnection
        worker_transport_status = [string]$networkTransportStatus
        observation = $networkObservation
    }
    $networkPolicyStatus = Get-NetworkPolicyStatus $networkEvidence
    $networkStatus = Get-NetworkDeniedStatus $networkEvidence
    Set-Check 'network_denied' $networkStatus
    if ($networkWorkerAttempted -and $null -ne $networkRun -and -not $networkRun.WorkerTokenVerified) {
        Set-Check 'worker_appcontainer_token' 'FAIL'
    }
    if ($networkWorkerAttempted -and $null -ne $networkRun -and -not $networkRun.JobMembershipVerified) {
        Set-Check 'worker_job_membership' 'FAIL'
    }
    $workerStatus = if ($null -ne $networkObservation) { [string]$networkObservation.status } else { 'UNKNOWN' }
    $workerCode = if ($null -ne $networkObservation) { [string]$networkObservation.code } else { 'SKIPPED' }
    $report.observations.network = [ordered]@{
        target = '127.0.0.1'
        loopback_exemption = $loopbackHelper.exemption
        loopback_entry_count = $loopbackHelper.entry_count
        loopback_error_code = $loopbackHelper.error_code
        loopback_cleanup_status = $loopbackHelper.cleanup_status
        helper_process_created = [bool]$loopbackHelperRun.ProcessCreated
        helper_timed_out = [bool]$loopbackHelperRun.TimedOut
        helper_root_signaled = [bool]$loopbackHelperRun.RootProcessSignaled
        helper_job_drained = [bool]$loopbackHelperRun.JobDrained
        helper_cleanup_confirmed = [bool]$loopbackHelperRun.CleanupConfirmed
        helper_error_code = $loopbackHelperRun.ErrorCode
        host_control_status = $hostControl.status
        host_control_connected = $hostControl.connected
        host_control_accepted = $hostControl.accepted
        host_control_timed_out = $hostControl.timed_out
        host_control_failure_code = $hostControl.failure_code
        worker_attempted = [bool]$networkWorkerAttempted
        worker_skip_reason = $networkSkipReason
        network_policy_status = $networkPolicyStatus
        network_capability_query_status = $networkEvidence.capability_query_status
        network_capability_count = $networkEvidence.network_capability_count
        network_capabilities_error_code = $networkEvidence.capabilities_error_code
        target_matches_listener = [bool]$networkTargetMatchesListener
        worker_transport_status = $networkTransportStatus
        listener_accepted_connection = $listenerAcceptedConnection
        worker_status = $workerStatus
        worker_code = $workerCode
        worker_token_verified = if ($null -ne $networkRun) { [bool]$networkRun.WorkerTokenVerified } else { $null }
        job_membership_verified = if ($null -ne $networkRun) { [bool]$networkRun.JobMembershipVerified } else { $null }
    }

    $currentPhase = 'process-tree-probe'
    $treeInput = '{"mode":"process-tree"}'
    $treeRun = [AppContainerLauncher]::RunNodeWithModuleHooks(
        $stageNode, $stageModuleHook, 'probe', $workspaceRoot, $profileSidText, $profileName, $treeInput,
        $TreeTimeoutMs, $null, $true)
    $treeProtocolOutput = ConvertFrom-WorkerProtocolOutput $treeRun.Stdout 'process-tree'
    $treeObservation = $treeProtocolOutput.response
    $treePhaseMarkers = @($treeProtocolOutput.phase_markers)
    $treePhaseMarkerSchemaValid = [bool]$treeProtocolOutput.schema_valid
    $treeExpectedKeys = @(
        'mode', 'child_spawn_status', 'child_spawn_code', 'child_worker_started',
        'grandchild_spawn_status', 'grandchild_spawn_code', 'grandchild_worker_started',
        'readiness_stage', 'readiness_status', 'readiness_code', 'child_pid', 'grandchild_pid'
    )
    $treeSchemaValid = $treePhaseMarkerSchemaValid -and $null -ne $treeObservation -and
        (Test-ExactObjectKeys $treeObservation $treeExpectedKeys) -and
        $treeObservation.mode -eq 'process-tree' -and
        $treeObservation.child_spawn_status -in @('PENDING', 'PASS', 'FAIL', 'UNKNOWN') -and
        $treeObservation.child_spawn_code -in @('NONE', 'SPAWN_TIMEOUT', 'EACCES', 'EPERM', 'ENOENT', 'EPIPE', 'ETIMEDOUT', 'EINVAL', 'UNKNOWN') -and
        $treeObservation.child_worker_started -is [bool] -and
        $treeObservation.grandchild_spawn_status -in @('PENDING', 'PASS', 'FAIL', 'UNKNOWN') -and
        $treeObservation.grandchild_spawn_code -in @('NONE', 'SPAWN_TIMEOUT', 'EACCES', 'EPERM', 'ENOENT', 'EPIPE', 'ETIMEDOUT', 'EINVAL', 'UNKNOWN') -and
        $treeObservation.grandchild_worker_started -is [bool] -and
        $treeObservation.readiness_stage -in @('CHILD_SPAWN', 'CHILD_WORKER', 'GRANDCHILD_START', 'GRANDCHILD_SPAWN', 'GRANDCHILD_WORKER', 'READY') -and
        $treeObservation.readiness_status -in @('PASS', 'FAIL', 'UNKNOWN') -and
        $treeObservation.readiness_code -in @(
            'NONE', 'CHILD_SPAWN_FAILED', 'CHILD_SPAWN_TIMEOUT', 'CHILD_START_TIMEOUT',
            'CHILD_WORKER_EXITED', 'CHILD_STREAM_ERROR', 'CHILD_OUTPUT_LIMIT', 'CHILD_READINESS_INVALID',
            'GRANDCHILD_SPAWN_FAILED', 'GRANDCHILD_SPAWN_TIMEOUT', 'GRANDCHILD_START_TIMEOUT',
            'GRANDCHILD_WORKER_EXITED', 'GRANDCHILD_STREAM_ERROR', 'GRANDCHILD_OUTPUT_LIMIT',
            'GRANDCHILD_READINESS_INVALID'
        ) -and
        ($null -eq $treeObservation.child_pid -or [string]$treeObservation.child_pid -match '^\d{1,10}$') -and
        ($null -eq $treeObservation.grandchild_pid -or [string]$treeObservation.grandchild_pid -match '^\d{1,10}$')
    $treeMemberEvidenceComplete = Test-ProcessTreeMemberEvidenceComplete $treeRun
    $treePassed = $treeRun.TimedOut -and $treeRun.JobDrained -and -not $treeRun.OutputTruncated -and
        $treeSchemaValid -and $treeMemberEvidenceComplete
    $childPid = 0
    $grandchildPid = 0
    $childPidValid = $treeSchemaValid -and $null -ne $treeObservation.child_pid -and
        [int]::TryParse([string]$treeObservation.child_pid, [ref]$childPid) -and $childPid -gt 0
    $grandchildPidValid = $treeSchemaValid -and $null -ne $treeObservation.grandchild_pid -and
        [int]::TryParse([string]$treeObservation.grandchild_pid, [ref]$grandchildPid) -and $grandchildPid -gt 0
    $pidsValid = $childPidValid -and $grandchildPidValid
    $treePidsDistinct = [bool]($pidsValid -and $childPid -ne $grandchildPid)
    $childPidAbsent = $null
    $grandchildPidAbsent = $null
    if ($treeRun.JobDrained) {
        if ($childPidValid) { $childPidAbsent = Test-ProcessIdAbsent $childPid }
        if ($grandchildPidValid) { $grandchildPidAbsent = Test-ProcessIdAbsent $grandchildPid }
    }
    $treeStarted = $treeSchemaValid -and [bool]$treeObservation.child_worker_started -and
        [bool]$treeObservation.grandchild_worker_started
    $treePassed = $treePassed -and $treeStarted -and
        $treeObservation.child_spawn_status -eq 'PASS' -and
        $treeObservation.grandchild_spawn_status -eq 'PASS' -and
        $treeObservation.readiness_stage -eq 'READY' -and
        $treeObservation.readiness_status -eq 'PASS' -and
        $treeObservation.readiness_code -eq 'NONE' -and
        $treePidsDistinct -and $childPidAbsent -eq $true -and $grandchildPidAbsent -eq $true
    if ($treePassed) {
        Set-Check 'process_tree_terminated' 'PASS'
        Set-Check 'child_process_tree_terminated' 'PASS'
    } else {
        Set-Check 'process_tree_terminated' 'FAIL'
        Set-Check 'child_process_tree_terminated' 'FAIL'
    }
    $treeDeadlineObservation = Get-DeadlineJobObservation $treeRun
    $treeJobMemberObservation = Get-JobMemberSnapshotObservation $treeRun
    $treeDiagnosticObservation = Get-ProcessTreeDiagnosticObservation $treeRun
    $report.observations.process_tree = New-ProcessTreeReportObservation `
        $treeRun.TimedOut $treeRun.JobDrained $treeDeadlineObservation $treeJobMemberObservation `
        $treePhaseMarkerSchemaValid $treePhaseMarkers $treeSchemaValid $treeObservation $treeStarted `
        $childPidValid $childPid $grandchildPidValid $grandchildPid $childPidAbsent $grandchildPidAbsent `
        $treeRun.DurationMs $treeRun.WorkerTokenVerified $treeRun.JobMembershipVerified $treeDiagnosticObservation
    if (-not $treeRun.WorkerTokenVerified) { Set-Check 'worker_appcontainer_token' 'FAIL' }
    if (-not $treeRun.JobMembershipVerified) { Set-Check 'worker_job_membership' 'FAIL' }

    $checkValues = @($report.checks.Values)
    $report.status = Get-ProbeFinalStatus $checkValues
    $fullProbeChecksComputed = $true
    }
    }
    }
}
catch {
    $report.status = 'BLOCKED'
    if (Test-ExceptionDataFlag $_ 'profile_preexisted') {
        $report.profile_preexisted = $true
        Set-Check 'appcontainer_profile_cleanup' 'UNKNOWN'
    }
    Set-Diagnostic $currentPhase $_ $_.InvocationInfo.ScriptLineNumber
    $report.failure = $report.diagnostic
}
finally {
    $temporaryCleanupError = $false
    if ($ProfileContractImportDiagnosticOnly) {
        if (-not $profileLocalWritesAttempted) {
            $profileContractStageCleanupVerified = $true
            $report.observations.profile_contract_import_diagnostic.cleanup_status = 'PASS'
        } else {
            try {
                if ($null -eq $profileContractStageRoot) {
                    $profileContractStageCleanupVerified = $null
                } else {
                    if ($profileContractStageCreated) {
                        Remove-SafeTree $workerTempPath $profileContractStageRoot
                    }
                    $profileContractStageCleanupVerified = Test-SafePathAbsent $workerTempPath $profileContractStageRoot
                    if (-not $profileContractStageCleanupVerified) {
                        throw 'The nonce-scoped profile contract staging directory remains after cleanup.'
                    }
                }
                $profileContractCleanupStatus = Get-ProfileContractCleanupStatus $ProfileContractImportDiagnosticOnly `
                    $profileContractStageCleanupVerified
                $report.observations.profile_contract_import_diagnostic.cleanup_status = $profileContractCleanupStatus
            } catch {
                $profileContractStageCleanupVerified = $false
                $temporaryCleanupError = $true
                $report.observations.profile_contract_import_diagnostic.cleanup_status = 'FAIL'
                if ($null -eq $report.diagnostic.exception_type) {
                    Set-Diagnostic 'profile-contract-stage-cleanup' $_ $_.InvocationInfo.ScriptLineNumber
                    $report.failure = $report.diagnostic
                }
            }
        }
        if ($profileContractStageCleanupVerified -eq $true -and
            ($profileTempCreationAttempted -or $profileTempCreatedByDiagnostic)) {
            try {
                $profileTempInitiallyAbsent = Test-SafePathAbsent $profilePath $workerTempPath
                if ($profileTempCreatedByDiagnostic -and -not $profileTempInitiallyAbsent) {
                    $profileTempForCleanup = Assert-ChildPath $profilePath $workerTempPath
                    $profileTempCleanupItem = Get-Item -LiteralPath $profileTempForCleanup -Force
                    if (-not $profileTempCleanupItem.PSIsContainer) {
                        throw 'The diagnostic-created AppContainer Temp path is not a directory.'
                    }
                    [System.IO.Directory]::Delete($profileTempForCleanup, $false)
                } elseif (-not $profileTempCreatedByDiagnostic -and -not $profileTempInitiallyAbsent) {
                    throw 'The AppContainer Temp creation outcome is uncertain; preserving the profile.'
                }
                $profileTempCleanupVerified = Test-SafePathAbsent $profilePath $workerTempPath
                if (-not $profileTempCleanupVerified) {
                    throw 'The diagnostic-created AppContainer Temp directory remains after cleanup.'
                }
            } catch {
                $profileTempCleanupVerified = $false
                $temporaryCleanupError = $true
                if ($null -eq $report.diagnostic.exception_type) {
                    Set-Diagnostic 'profile-temp-cleanup' $_ $_.InvocationInfo.ScriptLineNumber
                    $report.failure = $report.diagnostic
                }
            }
        } else {
            $profileTempCleanupVerified = $null
        }
        $profileTempCleanupStatus = Get-ProfileTempCleanupStatus $ProfileContractImportDiagnosticOnly `
            $profileTempCreationAttempted $profileTempCreatedByDiagnostic $profileTempCleanupVerified
        $report.observations.profile_contract_import_diagnostic.profile_temp_created_by_diagnostic = `
            [bool]$profileTempCreatedByDiagnostic
        $report.observations.profile_contract_import_diagnostic.profile_temp_creation_attempted = `
            [bool]$profileTempCreationAttempted
        $report.observations.profile_contract_import_diagnostic.profile_temp_existed_before_diagnostic = `
            $profileTempExistedBeforeDiagnostic
        $report.observations.profile_contract_import_diagnostic.profile_temp_cleanup_status = $profileTempCleanupStatus
    }
    if ($null -ne $probeListener) {
        try {
            $probeListener.Stop()
            $probeListenerCleanupConfirmed = $true
        } catch {
            if ($null -eq $report.diagnostic.exception_type) {
                Set-Diagnostic 'loopback-listener-cleanup' $_ $_.InvocationInfo.ScriptLineNumber
                $report.failure = $report.diagnostic
            }
        }
    }
    if ($ProfileBootstrapDiagnosticOnly) {
        if (-not $profileCreated) {
            $profileBootstrapCleanupVerified = $true
            $profileBootstrapCleanupStatus = 'NOT_RUN'
        } elseif ($profileBootstrapObservation.response_status -ceq 'VALID' -and
            $profileBootstrapObservation.launch_evidence_complete -and $profileBootstrapCandidateValidated -and
            $profileBootstrapSidMatchesName -eq $true) {
            try {
                $markerAbsentBeforeHostCleanup = Test-SafePathAbsent $profileBootstrapTempPath $profileBootstrapMarkerPath
                if (-not $markerAbsentBeforeHostCleanup) {
                    if (-not $profileBootstrapObservation.marker_created_by_diagnostic) {
                        throw 'A bootstrap marker exists without worker ownership evidence.'
                    }
                    $markerCanonical = Assert-ChildPath $profileBootstrapTempPath $profileBootstrapMarkerPath
                    $markerAttributes = [System.IO.File]::GetAttributes($markerCanonical)
                    if (($markerAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                        ($markerAttributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
                        throw 'The nonce marker is not an ordinary file.'
                    }
                    $markerItem = Get-Item -LiteralPath $markerCanonical -Force
                    if ([long]$markerItem.Length -ne [Text.Encoding]::UTF8.GetByteCount($profileBootstrapMarkerContent) -or
                        -not [string]::Equals([System.IO.File]::ReadAllText($markerCanonical),
                            $profileBootstrapMarkerContent, [StringComparison]::Ordinal)) {
                        throw 'The nonce marker content did not match the fixed diagnostic marker.'
                    }
                    [System.IO.File]::Delete($markerCanonical)
                }
                if (-not (Test-SafePathAbsent $profileBootstrapTempPath $profileBootstrapMarkerPath)) {
                    throw 'The nonce marker remains after cleanup.'
                }

                $tempAbsent = Test-SafePathAbsent $profileBootstrapCandidatePath $profileBootstrapTempPath
                if ($profileBootstrapObservation.temp_created_by_diagnostic) {
                    if (-not $tempAbsent) {
                        $tempCanonical = Assert-ChildPath $profileBootstrapCandidatePath $profileBootstrapTempPath
                        $tempAttributes = [System.IO.File]::GetAttributes($tempCanonical)
                        if (($tempAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                            ($tempAttributes -band [System.IO.FileAttributes]::Directory) -eq 0 -or
                            [System.IO.Directory]::GetFileSystemEntries($tempCanonical).Length -ne 0) {
                            throw 'The diagnostic-created Temp directory is not empty and ordinary.'
                        }
                        [System.IO.Directory]::Delete($tempCanonical, $false)
                    }
                    if (-not (Test-SafePathAbsent $profileBootstrapCandidatePath $profileBootstrapTempPath)) {
                        throw 'The diagnostic-created Temp directory remains after cleanup.'
                    }
                } elseif ($profileBootstrapObservation.temp_existed_before -eq $true) {
                    if ($tempAbsent) { throw 'The pre-existing Temp directory is unexpectedly absent.' }
                    $tempCanonical = Assert-ChildPath $profileBootstrapCandidatePath $profileBootstrapTempPath
                    $tempAttributes = [System.IO.File]::GetAttributes($tempCanonical)
                    if (($tempAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                        ($tempAttributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
                        throw 'The pre-existing Temp path is no longer an ordinary directory.'
                    }
                } elseif ($profileBootstrapObservation.temp_existed_before -eq $false) {
                    if (-not $tempAbsent) { throw 'Temp exists without evidence that this diagnostic created it.' }
                } else {
                    throw 'The Temp ownership observation is unknown.'
                }
                $profileBootstrapCleanupVerified = $true
            } catch {
                $profileBootstrapCleanupVerified = $false
                $temporaryCleanupError = $true
                if ($null -eq $report.diagnostic.exception_type) {
                    Set-Diagnostic 'profile-bootstrap-cleanup' $_ $_.InvocationInfo.ScriptLineNumber
                    $report.failure = $report.diagnostic
                }
            }
        } else {
            $profileBootstrapCleanupVerified = $null
            $temporaryCleanupError = $true
        }
        if ($profileCreated) {
            $profileBootstrapCleanupStatus = if ($null -eq $profileBootstrapCleanupVerified) { 'UNKNOWN' } `
                elseif ($profileBootstrapCleanupVerified) { 'PASS' } else { 'FAIL' }
        }
        $report.observations.profile_bootstrap_diagnostic.cleanup_status = $profileBootstrapCleanupStatus
    }
    if ($profileRunStageInTemp) {
        $report.observations.profile_run_stage.stage_cleanup_status = 'UNKNOWN'
        if ($preserveStageForInspection) {
            $profileRunStageCleanupVerified = $null
            $profileRunTempCleanupVerified = $null
            $report.observations.profile_run_stage.stage_absent_after_cleanup = $null
            $report.observations.profile_run_stage.stage_cleanup_status = 'UNKNOWN_PRESERVED'
            $report.observations.profile_run_stage.profile_temp_cleanup_status = 'UNKNOWN_PRESERVED'
            $temporaryCleanupError = $true
        } elseif ($profileRunStagePreflightSafe -and $profileRunStagePathValidated -and
            $null -ne $profileTempCanonical -and $null -ne $stageRoot) {
            try {
                if (-not (Test-SafePathAbsent $profileTempCanonical $stageRoot)) {
                    Remove-SafeTree $profileTempCanonical $stageRoot
                }
                $profileRunStageCleanupVerified = Test-SafePathAbsent $profileTempCanonical $stageRoot
                $report.observations.profile_run_stage.stage_absent_after_cleanup = $profileRunStageCleanupVerified
                if (-not $profileRunStageCleanupVerified) {
                    throw 'The nonce-scoped AppContainer run tree remains after cleanup.'
                }
                $stageCreated = $false

                $tempAbsentBeforeCleanup = Test-SafePathAbsent $profilePath $profileTempCanonical
                if ($profileRunTempCreationAttempted) {
                    if (-not $tempAbsentBeforeCleanup) {
                        $tempCanonical = Assert-ChildPath $profilePath $profileTempCanonical
                        $tempItem = Get-Item -LiteralPath $tempCanonical -Force
                        if (-not $tempItem.PSIsContainer -or
                            ($tempItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                            @([System.IO.Directory]::EnumerateFileSystemEntries($tempCanonical)).Count -ne 0) {
                            throw 'The diagnostic-created Temp directory is not empty and ordinary.'
                        }
                        [System.IO.Directory]::Delete($tempCanonical, $false)
                    }
                    $profileRunTempCleanupVerified = Test-SafePathAbsent $profilePath $profileTempCanonical
                } elseif ($profileRunTempExistedBefore) {
                    if ($tempAbsentBeforeCleanup) {
                        throw 'The pre-existing AppContainer Temp directory is unexpectedly absent.'
                    }
                    $tempCanonical = Assert-ChildPath $profilePath $profileTempCanonical
                    $tempItem = Get-Item -LiteralPath $tempCanonical -Force
                    if (-not $tempItem.PSIsContainer -or
                        ($tempItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                        @([System.IO.Directory]::EnumerateFileSystemEntries($tempCanonical)).Count -ne 0) {
                        throw 'The pre-existing AppContainer Temp directory is not empty and ordinary after cleanup.'
                    }
                    $profileRunTempCleanupVerified = $true
                } else {
                    $profileRunTempCleanupVerified = [bool]$tempAbsentBeforeCleanup
                }
                if (-not $profileRunTempCleanupVerified) {
                    throw 'The per-run AppContainer Temp cleanup could not be confirmed.'
                }
                $report.observations.profile_run_stage.stage_cleanup_status = 'PASS'
                $report.observations.profile_run_stage.profile_temp_cleanup_status = 'PASS'
            } catch {
                if ($null -eq $profileRunStageCleanupVerified) { $profileRunStageCleanupVerified = $false }
                if ($null -eq $profileRunTempCleanupVerified) { $profileRunTempCleanupVerified = $false }
                $report.observations.profile_run_stage.stage_cleanup_status = 'FAIL'
                $report.observations.profile_run_stage.profile_temp_cleanup_status = `
                    if ($profileRunTempCleanupVerified) { 'PASS' } else { 'FAIL' }
                $preserveStageForInspection = $true
                $temporaryCleanupError = $true
                if ($null -eq $report.diagnostic.exception_type) {
                    Set-Diagnostic 'profile-run-stage-cleanup' $_ $_.InvocationInfo.ScriptLineNumber
                    $report.failure = $report.diagnostic
                }
            }
        }
    }
    if ($ProfileBootstrapDiagnosticOnly) {
        $profileDeleteDecision = Get-ProfileBootstrapDeleteDecision $report.profile_preexisted `
            $profileBootstrapCandidateValidated $profileBootstrapSidMatchesName `
            ([bool]($null -ne $profileBootstrapObservation -and $profileBootstrapObservation.launch_evidence_complete -and
                $profileBootstrapObservation.response_status -ceq 'VALID')) $profileBootstrapCleanupVerified
    } elseif ($profileRunStageInTemp) {
        $profileDeleteDecision = Get-ProfileRunDeleteDecision $report.profile_preexisted `
            ($null -ne $profilePath) $profileRunStagePathValidated $profileRunTempWasEmptyBefore `
            $profileRunStageAbsentBefore $profileRunStageCleanupVerified `
            $profileRunTempCleanupRequired $profileRunTempCreatedByDiagnostic $profileRunTempCleanupVerified
    } else {
        $profileDeleteDecision = Get-ProfileDeleteDecision $report.profile_preexisted `
            $ProfileContractImportDiagnosticOnly ($null -ne $profilePath) $profileLocalWritesAttempted `
            $profileContractStageCleanupVerified `
            $profileTempCreationAttempted $profileTempCreatedByDiagnostic $profileTempCleanupVerified
    }
    if ($profileDeleteDecision -eq 'DELETE' -and ($profileCreated -or $profileCreateAttempted)) {
        $profileRegistrationPreDeleteScan = Get-AppContainerProfileMappingScan $profileName
        $profileRegistrationPreDeleteDecision = Get-ProfileRegistrationPreDeleteDecision $profileRegistrationPreDeleteScan
        $report.observations.profile_registration.pre_delete_scan = $profileRegistrationPreDeleteScan
        $report.observations.profile_registration.pre_delete_decision = $profileRegistrationPreDeleteDecision
        if ($profileRegistrationPreDeleteDecision -cne 'PASS') {
            $profileDeleteDecision = 'PRESERVE_REGISTRATION_UNKNOWN'
            $profileRegistrationCleanupStatus = 'UNKNOWN'
            $report.observations.profile_registration.cleanup_status = 'UNKNOWN'
            Set-Check 'appcontainer_profile_cleanup' 'UNKNOWN'
            $report.status = 'BLOCKED'
        }
    }
    if ($profileDeleteDecision -eq 'DELETE' -and ($profileCreated -or $profileCreateAttempted)) {
        $profileDeleteAttempted = $true
        try {
            [AppContainerLauncher]::DeleteProfile($profileName)
            $profileDeleteSucceeded = $true
        } catch {
            Set-Check 'appcontainer_profile_cleanup' 'FAIL'
            if ($null -eq $report.diagnostic.exception_type) {
                Set-Diagnostic 'profile-cleanup' $_ $_.InvocationInfo.ScriptLineNumber
                $report.failure = $report.diagnostic
            }
            $report.profile_cleanup_failure = [ordered]@{
                powershell_line = $_.InvocationInfo.ScriptLineNumber
                exception_type = $_.Exception.GetType().Name
                hresult = ('0x{0:X8}' -f $_.Exception.HResult)
                api_operation = $null
                api_native_error_code = $null
                inner_exception_type = if ($null -ne $_.Exception.InnerException) { $_.Exception.InnerException.GetType().Name } else { $null }
                inner_hresult = if ($null -ne $_.Exception.InnerException) { '0x{0:X8}' -f $_.Exception.InnerException.HResult } else { $null }
            }
            $report.status = 'BLOCKED'
        }
        $profileRegistrationPostDeleteScan = Get-AppContainerProfileMappingScan $profileName
        $profileRegistrationPostDeleteDecision = Get-ProfileRegistrationPostDeleteDecision $profileRegistrationPostDeleteScan
        $profileRegistrationCleanupStatus = $profileRegistrationPostDeleteDecision
        $report.observations.profile_registration.post_delete_scan = $profileRegistrationPostDeleteScan
        $report.observations.profile_registration.post_delete_decision = $profileRegistrationPostDeleteDecision
        $report.observations.profile_registration.cleanup_status = $profileRegistrationCleanupStatus
    } elseif ($profileDeleteDecision -ne 'DELETE') {
        Set-Check 'appcontainer_profile_cleanup' (Get-ProfileCleanupGateStatus $profileDeleteDecision)
        $report.status = 'BLOCKED'
    }
    if ($ProtocolSmokeOnly -and $stageCreated) {
        try {
            if (-not (Test-SafePathAbsent $workspaceRoot $stdioSmokeMarkerPath)) {
                $preserveStageForInspection = $true
                $temporaryCleanupError = $true
            }
        } catch {
            $preserveStageForInspection = $true
            $temporaryCleanupError = $true
            if ($null -eq $report.diagnostic.exception_type) {
                Set-Diagnostic 'inline-stdio-marker-absence-check' $_ $_.InvocationInfo.ScriptLineNumber
                $report.failure = $report.diagnostic
            }
        }
    }
    if ($stageCreated) {
        try {
            if ($preserveStageForInspection) {
                $temporaryCleanupError = $true
            } else {
                Remove-SafeTree $stageRootParent $stageRoot
            }
        } catch {
            $temporaryCleanupError = $true
            if ($null -eq $report.diagnostic.exception_type) {
                Set-Diagnostic 'stage-cleanup' $_ $_.InvocationInfo.ScriptLineNumber
                $report.failure = $report.diagnostic
            }
        }
    }
    $canaryCleanupObservation = [ordered]@{}
    if (-not ($ProfileContractImportDiagnosticOnly -or $ProfileBootstrapDiagnosticOnly)) {
        $canaryLocations = @(
            [pscustomobject]@{ name = 'runtime'; parent = $canaryCollectionRoot; path = $canaryRoot; created = $canaryCreated },
            [pscustomobject]@{ name = 'repository'; parent = $repoRoot; path = $repositoryCanaryRoot; created = $repositoryCanaryCreated },
            [pscustomobject]@{ name = 'oracle'; parent = $oracleCollectionRoot; path = $oracleCanaryRoot; created = $oracleCanaryCreated },
            [pscustomobject]@{ name = 'ownerProfile'; parent = $ownerProfileCanaryCollectionRoot; path = $ownerProfileCanaryRoot; created = $ownerProfileCanaryCreated }
        )
        foreach ($location in $canaryLocations) {
            $absent = $null
            if ($location.created -and $canaryRecords.Contains($location.name)) {
                try { $null = Remove-ProbeCanary $canaryRecords[$location.name] }
                catch {
                    $temporaryCleanupError = $true
                    if ($null -eq $report.diagnostic.exception_type) {
                        Set-Diagnostic ($location.name + '-canary-cleanup') $_ $_.InvocationInfo.ScriptLineNumber
                        $report.failure = $report.diagnostic
                    }
                }
            }
            try { $absent = Test-SafePathAbsent $location.parent $location.path }
            catch {
                $temporaryCleanupError = $true
                if ($null -eq $report.diagnostic.exception_type) {
                    Set-Diagnostic ($location.name + '-canary-cleanup-verification') $_ $_.InvocationInfo.ScriptLineNumber
                    $report.failure = $report.diagnostic
                }
            }
            $canaryCleanupObservation[$location.name + '_absent'] = $absent
            if ($null -eq $absent -or -not $absent) { $temporaryCleanupError = $true }
        }
    }
    $report.observations.canary_cleanup = $canaryCleanupObservation
    $report.observations.loopback_listener_cleanup = [ordered]@{
        created = ($null -ne $probeListener)
        stop_confirmed = if ($null -eq $probeListener) { $null } else { [bool]$probeListenerCleanupConfirmed }
    }
    if ($null -ne $probeListener -and -not $probeListenerCleanupConfirmed) { $temporaryCleanupError = $true }

    $stageAbsent = $null
    $canaryAbsent = if ($ProfileContractImportDiagnosticOnly -or $ProfileBootstrapDiagnosticOnly) { $true } else { $null }
    $workerTempAbsent = $null
    $stagedWorkerTempAbsent = $null
    $profilePathAbsent = $null
    if ($null -eq $stageRoot -or $null -eq $stageRootParent) {
        $stageAbsent = -not $profileRunStagePathValidated
    } else {
        try { $stageAbsent = Test-SafePathAbsent $stageRootParent $stageRoot }
        catch {
            if ($null -eq $report.diagnostic.exception_type) {
                Set-Diagnostic 'stage-cleanup-verification' $_ $_.InvocationInfo.ScriptLineNumber
                $report.failure = $report.diagnostic
            }
        }
    }
    if ($ProfileBootstrapDiagnosticOnly) {
        $profileBootstrapStagingAclCleanupStatus = Get-ProfileBootstrapStagingAclCleanupStatus `
            $profileBootstrapStagingAclAttempted $stageAbsent
        if ($profileBootstrapStagingAclCleanupStatus -ceq 'NOT_CONFIRMED') {
            $temporaryCleanupError = $true
        }
        if ($null -ne $profileBootstrapStagingAclObservation) {
            $profileBootstrapStagingAclObservation.cleanup_status = $profileBootstrapStagingAclCleanupStatus
        }
        $report.observations.profile_bootstrap_diagnostic.staging_acl.cleanup_status = `
            $profileBootstrapStagingAclCleanupStatus
    }
    if (-not ($ProfileContractImportDiagnosticOnly -or $ProfileBootstrapDiagnosticOnly)) {
        try { $canaryAbsent = Test-SafePathAbsent $canaryCollectionRoot $canaryRoot }
        catch {
            if ($null -eq $report.diagnostic.exception_type) {
                Set-Diagnostic 'canary-cleanup-verification' $_ $_.InvocationInfo.ScriptLineNumber
                $report.failure = $report.diagnostic
            }
        }
    }
    if ($null -eq $workspaceRoot -or $null -eq $stagedWorkerTempPath) {
        $stagedWorkerTempAbsent = -not $profileRunStagePreflightSafe
    } else {
        try { $stagedWorkerTempAbsent = Test-SafePathAbsent $workspaceRoot $stagedWorkerTempPath }
        catch {
            if ($null -eq $report.diagnostic.exception_type) {
                Set-Diagnostic 'staged-worker-temp-cleanup-verification' $_ $_.InvocationInfo.ScriptLineNumber
                $report.failure = $report.diagnostic
            }
        }
    }
    $profileCleanupPathForVerification = $profilePath
    $workerTempPathForVerification = $workerTempPath
    $profilePathSource = 'profile_api'
    if ($ProfileBootstrapDiagnosticOnly) {
        $profileCleanupPathForVerification = $profileBootstrapCandidatePath
        $workerTempPathForVerification = $profileBootstrapTempPath
        $profilePathSource = 'validated_candidate'
    }
    if ($null -ne $profileCleanupPathForVerification) {
        try {
            $profilePackagesRoot = Get-AppContainerProfilePackagesRoot $profileCleanupPathForVerification $profileName
            $profilePathAbsent = Test-SafePathAbsent $profilePackagesRoot $profileCleanupPathForVerification
            $workerTempAbsent = Test-SafePathAbsent $profilePackagesRoot $workerTempPathForVerification
        } catch {
            if ($null -eq $report.diagnostic.exception_type) {
                Set-Diagnostic 'appcontainer-profile-temp-cleanup-verification' $_ $_.InvocationInfo.ScriptLineNumber
                $report.failure = $report.diagnostic
            }
        }
    }
    if ($profileRegistrationCleanupStatus -ceq 'FAIL') {
        Set-Check 'appcontainer_profile_cleanup' 'FAIL'
        $report.status = 'BLOCKED'
    } elseif ($profileRegistrationCleanupStatus -ceq 'UNKNOWN') {
        Set-Check 'appcontainer_profile_cleanup' 'UNKNOWN'
        $report.status = 'BLOCKED'
    } elseif ($report.profile_preexisted) {
        Set-Check 'appcontainer_profile_cleanup' 'UNKNOWN'
    } elseif ($profileDeleteSucceeded -and $null -ne $profilePathAbsent -and $profilePathAbsent -and
        $null -ne $workerTempAbsent -and $workerTempAbsent -and
        $null -ne $stagedWorkerTempAbsent -and $stagedWorkerTempAbsent -and
        $null -ne $stageAbsent -and $stageAbsent -and
        $profileRegistrationCleanupStatus -ceq 'PASS') {
        Set-Check 'appcontainer_profile_cleanup' 'PASS'
    } elseif ($profileDeleteSucceeded -and $profilePathAbsent -eq $false) {
        Set-Check 'appcontainer_profile_cleanup' 'FAIL'
        $report.status = 'BLOCKED'
    } elseif ($profileDeleteSucceeded -and $workerTempAbsent -eq $false) {
        Set-Check 'appcontainer_profile_cleanup' 'FAIL'
        $report.status = 'BLOCKED'
    } elseif ($profileDeleteSucceeded -and $stagedWorkerTempAbsent -eq $false) {
        Set-Check 'appcontainer_profile_cleanup' 'FAIL'
        $report.status = 'BLOCKED'
    } elseif ($profileDeleteSucceeded -and $stageAbsent -eq $false) {
        Set-Check 'appcontainer_profile_cleanup' 'FAIL'
        $report.status = 'BLOCKED'
    } elseif (-not $report.checks.appcontainer_profile_cleanup.Equals('FAIL')) {
        Set-Check 'appcontainer_profile_cleanup' 'UNKNOWN'
        $report.status = 'BLOCKED'
    }
    $report.observations.profile_cleanup = [ordered]@{
        delete_attempted = [bool]$profileDeleteAttempted
        delete_succeeded = [bool]$profileDeleteSucceeded
        delete_decision = $profileDeleteDecision
        profile_registration_pre_delete_decision = $profileRegistrationPreDeleteDecision
        profile_registration_post_delete_decision = $profileRegistrationPostDeleteDecision
        profile_registration_cleanup_status = $profileRegistrationCleanupStatus
        profile_local_write_attempted = [bool]$profileLocalWritesAttempted
        profile_path_resolved = ($null -ne $profilePath)
        profile_path_source = $profilePathSource
        profile_path_absent = $profilePathAbsent
        profile_candidate_absent = if ($ProfileBootstrapDiagnosticOnly) { $profilePathAbsent } else { $null }
        profile_temp_creation_attempted = [bool]$profileTempCreationAttempted
        profile_temp_existed_before_diagnostic = $profileTempExistedBeforeDiagnostic
        profile_temp_created_by_diagnostic = [bool]$profileTempCreatedByDiagnostic
        profile_temp_cleanup_status = $profileTempCleanupStatus
        worker_temp_path_absent = $workerTempAbsent
        staged_worker_temp_path_absent = $stagedWorkerTempAbsent
        profile_contract_stage_absent = if ($ProfileContractImportDiagnosticOnly) { $profileContractStageCleanupVerified } else { $null }
    }
    if ($temporaryCleanupError) {
        Set-Check 'temporary_files_cleanup' 'FAIL'
    } elseif ($null -eq $stageAbsent -or $null -eq $canaryAbsent -or $null -eq $stagedWorkerTempAbsent -or
        @($canaryCleanupObservation.Values | Where-Object { $null -eq $_ -or -not $_ }).Count -gt 0) {
        Set-Check 'temporary_files_cleanup' 'UNKNOWN'
        if ($null -eq $report.diagnostic.exception_type) {
            Set-PhaseDiagnostic 'temporary-files-absence-unknown' (Get-CallerLineNumber)
            $report.failure = $report.diagnostic
        }
    } elseif ($stageAbsent -and $canaryAbsent -and $stagedWorkerTempAbsent -and
        @($canaryCleanupObservation.Values | Where-Object { -not $_ }).Count -eq 0 -and
        ($null -eq $probeListener -or $probeListenerCleanupConfirmed) -and
        (-not $ProfileContractImportDiagnosticOnly -or $profileContractStageCleanupVerified) -and
        (-not $ProfileBootstrapDiagnosticOnly -or $profileBootstrapCleanupVerified)) {
        Set-Check 'temporary_files_cleanup' 'PASS'
    } else {
        Set-Check 'temporary_files_cleanup' 'FAIL'
        if ($null -eq $report.diagnostic.exception_type) {
            Set-PhaseDiagnostic 'temporary-files-not-absent' (Get-CallerLineNumber)
            $report.failure = $report.diagnostic
        }
    }
    $report.status = Get-ProbeReportFinalStatus ([bool]$PreflightOnly) $fullProbeChecksComputed $report.failure @($report.checks.Values)

    try {
        $null = Ensure-SafeDirectory $repoRoot (Join-Path $repoRoot 'runtime')
        $null = Ensure-SafeDirectory (Join-Path $repoRoot 'runtime') $diagnosticsRoot
        Write-SafeReport $reportPath
    } catch {
        $report.status = 'BLOCKED'
        $report.g2_2_attestation = $false
        Set-Diagnostic 'report-write' $_ $_.InvocationInfo.ScriptLineNumber
        $report.failure = $report.diagnostic
        $cleanupInner = if ($null -ne $script:reportWriteTempCleanupFailure) { $script:reportWriteTempCleanupFailure.InnerException } else { $null }
        $backupCleanupInner = if ($null -ne $script:reportWriteBackupCleanupFailure) { $script:reportWriteBackupCleanupFailure.InnerException } else { $null }
        $stderrDiagnostic = [ordered]@{
            phase = $report.diagnostic.phase
            powershell_line = $report.diagnostic.powershell_line
            command_name = $report.diagnostic.command_name
            fully_qualified_error_id = $report.diagnostic.fully_qualified_error_id
            exception_type = $report.diagnostic.exception_type
            hresult = $report.diagnostic.hresult
            api_hresult = $report.diagnostic.api_hresult
            api_operation = $report.diagnostic.api_operation
            api_native_error_code = $report.diagnostic.api_native_error_code
            process_tree_stage = $report.diagnostic.process_tree_stage
            process_tree_failure_stage = $report.diagnostic.process_tree_failure_stage
            process_tree_exception_type = $report.diagnostic.process_tree_exception_type
            process_tree_hresult = $report.diagnostic.process_tree_hresult
            process_tree_win32_code = $report.diagnostic.process_tree_win32_code
        process_tree_cleanup_stage = $report.diagnostic.process_tree_cleanup_stage
        process_tree_cleanup_exception_type = $report.diagnostic.process_tree_cleanup_exception_type
        process_tree_cleanup_hresult = $report.diagnostic.process_tree_cleanup_hresult
        process_tree_cleanup_win32_code = $report.diagnostic.process_tree_cleanup_win32_code
            inner_exception_type = $report.diagnostic.inner_exception_type
            inner_hresult = $report.diagnostic.inner_hresult
            temporary_file_cleanup = $script:reportWriteTempCleanupStatus
            temporary_cleanup_exception_type = if ($null -ne $script:reportWriteTempCleanupFailure) { $script:reportWriteTempCleanupFailure.GetType().Name } else { $null }
            temporary_cleanup_hresult = if ($null -ne $script:reportWriteTempCleanupFailure) { '0x{0:X8}' -f $script:reportWriteTempCleanupFailure.HResult } else { $null }
            temporary_cleanup_inner_exception_type = if ($null -ne $cleanupInner) { $cleanupInner.GetType().Name } else { $null }
            temporary_cleanup_inner_hresult = if ($null -ne $cleanupInner) { '0x{0:X8}' -f $cleanupInner.HResult } else { $null }
            backup_file_cleanup = $script:reportWriteBackupCleanupStatus
            backup_cleanup_exception_type = if ($null -ne $script:reportWriteBackupCleanupFailure) { $script:reportWriteBackupCleanupFailure.GetType().Name } else { $null }
            backup_cleanup_hresult = if ($null -ne $script:reportWriteBackupCleanupFailure) { '0x{0:X8}' -f $script:reportWriteBackupCleanupFailure.HResult } else { $null }
            backup_cleanup_inner_exception_type = if ($null -ne $backupCleanupInner) { $backupCleanupInner.GetType().Name } else { $null }
            backup_cleanup_inner_hresult = if ($null -ne $backupCleanupInner) { '0x{0:X8}' -f $backupCleanupInner.HResult } else { $null }
        }
        [System.Console]::Error.WriteLine(($stderrDiagnostic | ConvertTo-Json -Compress))
    }
}

Write-Output ('AppContainer probes: ' + $report.status + '. Report: runtime/diagnostics/appcontainer-probe-report.json')
if ($report.status -eq 'PASS') { exit 0 } else { exit 1 }
