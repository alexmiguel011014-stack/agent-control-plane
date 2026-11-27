param([switch]$AclSelfTest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$workerProtocolVersion = 2

$launcherPath = Join-Path $PSScriptRoot 'AppContainerLauncher.cs'
$workerSourcePath = Join-Path $PSScriptRoot 'production-worker.mjs'
$moduleHookSourcePath = Join-Path $PSScriptRoot 'module-hook.mjs'
$protocolSourcePath = Join-Path $PSScriptRoot 'protocol.mjs'
$registrySourcePath = Join-Path $PSScriptRoot 'task-operations.mjs'
$nonce = [Guid]::NewGuid().ToString('N')
$stageRoot = $null
$toolsRoot = $null
$profileName = 'AgentCP' + $nonce.Substring(0, 17)
$profileCreated = $false
$profileCreateAttempted = $false
$profileDeleteSucceeded = $false
$profileSidText = $null
$profileSid = $null
$profilePath = $null
$profileTempPath = $null
$profileTempCreated = $false
$stageCreated = $false
$launchResult = $null
$state = 'failed'
$failureCode = 'launcher_failed'
$responseJson = $null
$profileCleanupVerified = $false
$stagingCleanupVerified = $true
$workspaceAclBackup = [System.Collections.Generic.List[object]]::new()
$workspaceAclRestoreVerified = $true

function Read-BoundedBase64Line([int]$MaximumCharacters) {
    $builder = [System.Text.StringBuilder]::new()
    while ($true) {
        $value = [Console]::In.Read()
        if ($value -lt 0 -or $value -eq 10) { break }
        if ($value -eq 13) { continue }
        if ($builder.Length -ge $MaximumCharacters) { throw 'host_request_too_large' }
        $null = $builder.Append([char]$value)
    }
    if ($builder.Length -eq 0) { throw 'host_request_empty' }
    if ([Console]::In.Peek() -ge 0) { throw 'host_request_has_trailing_data' }
    return $builder.ToString()
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
            throw 'reparse_path_denied'
        }
    }
    return $canonicalCandidate
}

function Assert-ChildPath([string]$Parent, [string]$Candidate) {
    $canonicalParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $canonicalCandidate = Assert-NoReparsePath $Candidate
    if (-not $canonicalCandidate.StartsWith($canonicalParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'path_outside_root'
    }
    return $canonicalCandidate
}

function New-SafeDirectory([string]$Parent, [string]$Candidate) {
    $canonicalParent = Assert-NoReparsePath $Parent
    $canonicalCandidate = Assert-ChildPath $canonicalParent $Candidate
    if (Test-Path -LiteralPath $canonicalCandidate) { throw 'nonce_path_already_exists' }
    $null = [System.IO.Directory]::CreateDirectory($canonicalCandidate)
    $script:stageCreated = $true
    return Assert-ChildPath $canonicalParent $canonicalCandidate
}

function Assert-OrdinaryFile([string]$Candidate) {
    $canonical = Assert-NoReparsePath $Candidate
    $item = Get-Item -LiteralPath $canonical -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'file_not_ordinary'
    }
    return $canonical
}

function Get-FileSha256([string]$Candidate) {
    return (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Copy-OrdinaryFile([string]$Source, [string]$DestinationRoot, [string]$Destination) {
    $canonicalSource = Assert-OrdinaryFile $Source
    $canonicalDestination = Assert-ChildPath $DestinationRoot $Destination
    if (Test-Path -LiteralPath $canonicalDestination) { throw 'staged_file_already_exists' }
    [System.IO.File]::Copy($canonicalSource, $canonicalDestination, $false)
    if ((Get-FileSha256 $canonicalSource) -ne (Get-FileSha256 $canonicalDestination)) {
        throw 'staged_file_hash_mismatch'
    }
}

function Add-AccessRule($Acl, $Sid, [System.Security.AccessControl.FileSystemRights]$Rights,
    [System.Security.AccessControl.InheritanceFlags]$Inheritance,
    [System.Security.AccessControl.PropagationFlags]$Propagation) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $Sid, $Rights, $Inheritance, $Propagation,
        [System.Security.AccessControl.AccessControlType]::Allow)
    $Acl.AddAccessRule($rule)
}

function Get-AccessSecurity([string]$Candidate) {
    $attributes = [System.IO.File]::GetAttributes($Candidate)
    $sections = [System.Security.AccessControl.AccessControlSections]::Access
    if ($attributes -band [System.IO.FileAttributes]::Directory) {
        return [System.IO.DirectoryInfo]::new($Candidate).GetAccessControl($sections)
    }
    return [System.IO.FileInfo]::new($Candidate).GetAccessControl($sections)
}

function Set-AccessSecurity([string]$Candidate, $Acl) {
    $attributes = [System.IO.File]::GetAttributes($Candidate)
    if ($attributes -band [System.IO.FileAttributes]::Directory) {
        [System.IO.DirectoryInfo]::new($Candidate).SetAccessControl([System.Security.AccessControl.DirectorySecurity]$Acl)
    } else {
        [System.IO.FileInfo]::new($Candidate).SetAccessControl([System.Security.AccessControl.FileSecurity]$Acl)
    }
}

function Set-WorkerAcl([string]$Candidate, $AppSid, [System.Security.AccessControl.FileSystemRights]$AppRights) {
    $canonical = Assert-NoReparsePath $Candidate
    $attributes = [System.IO.File]::GetAttributes($canonical)
    if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'acl_path_reparse_denied' }
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    $acl = Get-AccessSecurity $canonical
    $acl.SetAccessRuleProtection($true, $false)
    $ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new(
        [System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($isDirectory) {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    Add-AccessRule $acl $ownerSid ([System.Security.AccessControl.FileSystemRights]::FullControl) $inheritance $propagation
    Add-AccessRule $acl $systemSid ([System.Security.AccessControl.FileSystemRights]::FullControl) $inheritance $propagation
    Add-AccessRule $acl $AppSid $AppRights $inheritance $propagation
    Set-AccessSecurity $canonical $acl
}

function Set-WorkspaceAclTree([string]$Root, [string]$Candidate, $AppSid) {
    $canonicalRoot = Assert-NoReparsePath $Root
    $canonical = Assert-NoReparsePath $Candidate
    $rootPrefix = $canonicalRoot.TrimEnd('\') + '\'
    if (-not $canonical.Equals($canonicalRoot, [StringComparison]::OrdinalIgnoreCase) -and
        -not $canonical.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'workspace_path_outside_root'
    }
    $null = Set-WorkerAcl $canonical $AppSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    $attributes = [System.IO.File]::GetAttributes($canonical)
    if (-not ($attributes -band [System.IO.FileAttributes]::Directory)) { return }
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($canonical)) {
        $entryPath = Assert-ChildPath $Root $entry
        $entryAttributes = [System.IO.File]::GetAttributes($entryPath)
        if ($entryAttributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'workspace_reparse_path_denied' }
        Set-WorkspaceAclTree $Root $entryPath $AppSid
    }
}

function Save-WorkspaceAclTree([string]$Root, [string]$Candidate, $Entries) {
    $canonicalRoot = Assert-NoReparsePath $Root
    $canonical = Assert-NoReparsePath $Candidate
    $rootPrefix = $canonicalRoot.TrimEnd('\') + '\'
    if (-not $canonical.Equals($canonicalRoot, [StringComparison]::OrdinalIgnoreCase) -and
        -not $canonical.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'workspace_path_outside_root'
    }
    $attributes = [System.IO.File]::GetAttributes($canonical)
    if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'workspace_reparse_path_denied' }
    $sddl = (Get-AccessSecurity $canonical).GetSecurityDescriptorSddlForm(
        [System.Security.AccessControl.AccessControlSections]::Access)
    $Entries.Add([pscustomobject]@{ Path = $canonical; Sddl = $sddl })
    if (-not ($attributes -band [System.IO.FileAttributes]::Directory)) { return }
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($canonical)) {
        $entryPath = Assert-ChildPath $Root $entry
        Save-WorkspaceAclTree $Root $entryPath $Entries
    }
}

function Restore-WorkspaceAclTree($Entries) {
    # Parent first: a child's inherited ACEs are recomputed from its parent's current DACL when it is restored.
    for ($index = 0; $index -lt $Entries.Count; $index++) {
        $entry = $Entries[$index]
        $null = Assert-NoReparsePath $entry.Path
        $acl = Get-AccessSecurity $entry.Path
        $acl.SetSecurityDescriptorSddlForm([string]$entry.Sddl,
            [System.Security.AccessControl.AccessControlSections]::Access)
        Set-AccessSecurity $entry.Path $acl
        $restoredSddl = (Get-AccessSecurity $entry.Path).GetSecurityDescriptorSddlForm(
            [System.Security.AccessControl.AccessControlSections]::Access)
        if (-not [string]::Equals($restoredSddl, [string]$entry.Sddl, [StringComparison]::Ordinal)) {
            throw 'workspace_acl_restore_mismatch'
        }
    }
}

function Remove-SafeTree([string]$Parent, [string]$Candidate) {
    $canonical = Assert-ChildPath $Parent $Candidate
    if (-not (Test-Path -LiteralPath $canonical)) { return }
    $attributes = [System.IO.File]::GetAttributes($canonical)
    if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'cleanup_reparse_path_denied' }
    if ($attributes -band [System.IO.FileAttributes]::Directory) {
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

function Emit-Result($Result) {
    $json = ConvertTo-Json -InputObject $Result -Depth 5 -Compress
    [Console]::Out.WriteLine($json)
}

function Invoke-AclSelfTest {
    $tempBase = $null
    $root = $null
    $failure = $null
    try {
        $tempBase = Assert-NoReparsePath ([System.IO.Path]::GetTempPath())
        $candidate = Assert-ChildPath $tempBase (Join-Path $tempBase ('agentcp-acl-selftest-' + [Guid]::NewGuid().ToString('N')))
        if (Test-Path -LiteralPath $candidate) { throw 'nonce_path_already_exists' }
        $null = [System.IO.Directory]::CreateDirectory($candidate)
        $root = $candidate
        $sourceDirectory = Assert-ChildPath $root (Join-Path $root 'src')
        $null = [System.IO.Directory]::CreateDirectory($sourceDirectory)
        $sourceFile = Assert-ChildPath $root (Join-Path $sourceDirectory 'sum-range.mjs')
        [System.IO.File]::WriteAllText($sourceFile, "export const value = 1;`n", [System.Text.UTF8Encoding]::new($false))
        $entries = [System.Collections.Generic.List[object]]::new()
        Save-WorkspaceAclTree $root $root $entries
        if ($entries.Count -ne 3) { throw 'acl_selftest_entry_count_mismatch' }
        $appSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-15-2-1-2-3-4-5-6-7')
        Set-WorkspaceAclTree $root $root $appSid
        foreach ($entry in $entries) {
            $currentSddl = (Get-AccessSecurity $entry.Path).GetSecurityDescriptorSddlForm(
                [System.Security.AccessControl.AccessControlSections]::Access)
            if ([string]::Equals($currentSddl, [string]$entry.Sddl, [StringComparison]::Ordinal)) {
                throw 'acl_selftest_acl_unchanged'
            }
        }
        Restore-WorkspaceAclTree $entries
        foreach ($entry in $entries) {
            $currentSddl = (Get-AccessSecurity $entry.Path).GetSecurityDescriptorSddlForm(
                [System.Security.AccessControl.AccessControlSections]::Access)
            if (-not [string]::Equals($currentSddl, [string]$entry.Sddl, [StringComparison]::Ordinal)) {
                throw 'acl_selftest_restore_mismatch'
            }
        }
    } catch {
        $failure = $_.Exception.GetType().Name
    }
    if ($null -ne $root) {
        try {
            Remove-SafeTree $tempBase $root
            if (-not (Test-SafePathAbsent $tempBase $root)) { throw 'acl_selftest_cleanup_unverified' }
        } catch {
            if ($null -eq $failure) { $failure = $_.Exception.GetType().Name }
        }
    }
    if ($null -eq $failure) {
        [Console]::Out.WriteLine('ACL_SELFTEST_PASS')
        exit 0
    }
    [Console]::Out.WriteLine('ACL_SELFTEST_FAIL ' + $failure)
    exit 1
}

if ($AclSelfTest) { Invoke-AclSelfTest }

try {
    $encodedInput = Read-BoundedBase64Line 262144
    $requestBytes = [Convert]::FromBase64String($encodedInput)
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $requestText = $utf8.GetString($requestBytes)
    if ([System.Text.Encoding]::UTF8.GetByteCount($requestText) -gt 131072) { throw 'host_request_too_large' }
    $hostRequest = ConvertFrom-Json -InputObject $requestText -ErrorAction Stop
    $hostKeys = @($hostRequest.PSObject.Properties.Name | Sort-Object)
    $expectedHostKeys = @('nodePath', 'requestJson', 'schemaVersion', 'timeoutMs', 'workspaceRoot')
    $expectedHostKeys = @($expectedHostKeys | Sort-Object)
    if (($hostKeys -join '|') -cne ($expectedHostKeys -join '|') -or $hostRequest.schemaVersion -ne 1) {
        throw 'host_request_invalid'
    }
    if (-not ($hostRequest.workspaceRoot -is [string]) -or -not [System.IO.Path]::IsPathRooted($hostRequest.workspaceRoot)) {
        throw 'workspace_root_invalid'
    }
    if (-not ($hostRequest.nodePath -is [string]) -or -not [System.IO.Path]::IsPathRooted($hostRequest.nodePath)) {
        throw 'node_path_invalid'
    }
    if (-not ($hostRequest.requestJson -is [string]) -or
        [System.Text.Encoding]::UTF8.GetByteCount($hostRequest.requestJson) -gt 65536) {
        throw 'worker_request_invalid'
    }
    $timeoutValue = 0
    if (-not [int]::TryParse([string]$hostRequest.timeoutMs, [ref]$timeoutValue) -or
        $timeoutValue -lt 100 -or $timeoutValue -gt 600000) {
        throw 'timeout_invalid'
    }
    $workerRequest = ConvertFrom-Json -InputObject $hostRequest.requestJson -ErrorAction Stop
    $workerRequestKeys = @($workerRequest.PSObject.Properties.Name | Sort-Object)
    $expectedWorkerKeys = @('calls', 'requestId', 'schemaVersion', 'taskId')
    $expectedWorkerKeys = @($expectedWorkerKeys | Sort-Object)
    if (($workerRequestKeys -join '|') -cne ($expectedWorkerKeys -join '|') -or
        $workerRequest.schemaVersion -ne $workerProtocolVersion -or
        -not ($workerRequest.taskId -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') -or
        -not ($workerRequest.calls -is [array]) -or
        $workerRequest.calls.Count -lt 1 -or $workerRequest.calls.Count -gt 128) {
        throw 'worker_request_invalid'
    }

    $workspaceRoot = Assert-NoReparsePath $hostRequest.workspaceRoot
    $workspaceItem = Get-Item -LiteralPath $workspaceRoot -Force
    if (-not $workspaceItem.PSIsContainer -or ($workspaceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'workspace_root_not_ordinary'
    }
    $nodeSource = Assert-OrdinaryFile $hostRequest.nodePath
    $launcherSource = Assert-OrdinaryFile $launcherPath
    $workerSource = Assert-OrdinaryFile $workerSourcePath
    $moduleHookSource = Assert-OrdinaryFile $moduleHookSourcePath
    $protocolSource = Assert-OrdinaryFile $protocolSourcePath
    $registrySource = Assert-OrdinaryFile $registrySourcePath

    $launcherSourceText = [System.IO.File]::ReadAllText($launcherSource, [System.Text.Encoding]::UTF8)
    Add-Type -TypeDefinition $launcherSourceText -Language CSharp -ErrorAction Stop
    $profileCreateAttempted = $true
    $profileSidText = [AppContainerLauncher]::CreateProfile($profileName)
    $profileCreated = $true
    $profileSid = [System.Security.Principal.SecurityIdentifier]::new($profileSidText)
    $profilePath = [AppContainerLauncher]::GetProfilePath($profileSidText, $profileName, $nonce)
    $profilePackagesRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Packages'
    $profilePath = Assert-ChildPath $profilePackagesRoot $profilePath

    $profileTempPath = Assert-ChildPath $profilePath (Join-Path $profilePath 'Temp')
    if (Test-Path -LiteralPath $profileTempPath) {
        $profileTempItem = Get-Item -LiteralPath $profileTempPath -Force
        if (-not $profileTempItem.PSIsContainer -or
            ($profileTempItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'profile_temp_not_ordinary'
        }
    } else {
        [System.IO.Directory]::CreateDirectory($profileTempPath) | Out-Null
        $profileTempCreated = $true
        $profileTempPath = Assert-ChildPath $profilePath $profileTempPath
    }
    $stageRoot = Join-Path $profileTempPath ('agentcp-worker-' + $nonce)
    $stageRoot = Assert-ChildPath $profileTempPath $stageRoot
    if (-not (Test-SafePathAbsent $profileTempPath $stageRoot)) { throw 'nonce_path_already_exists' }
    $null = New-SafeDirectory $profileTempPath $stageRoot
    $toolsRoot = Assert-ChildPath $stageRoot (Join-Path $stageRoot 'tools')
    [System.IO.Directory]::CreateDirectory($toolsRoot) | Out-Null
    $toolsRoot = Assert-ChildPath $stageRoot $toolsRoot

    Set-WorkerAcl $stageRoot $profileSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    Set-WorkerAcl $toolsRoot $profileSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    Copy-OrdinaryFile $nodeSource $toolsRoot (Join-Path $toolsRoot 'node.exe')
    Copy-OrdinaryFile $workerSource $toolsRoot (Join-Path $toolsRoot 'production-worker.mjs')
    Copy-OrdinaryFile $moduleHookSource $toolsRoot (Join-Path $toolsRoot 'module-hook.mjs')
    Copy-OrdinaryFile $protocolSource $toolsRoot (Join-Path $toolsRoot 'protocol.mjs')
    Copy-OrdinaryFile $registrySource $toolsRoot (Join-Path $toolsRoot 'task-operations.mjs')
    Set-WorkerAcl (Join-Path $toolsRoot 'node.exe') $profileSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    Set-WorkerAcl (Join-Path $toolsRoot 'production-worker.mjs') $profileSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    Set-WorkerAcl (Join-Path $toolsRoot 'module-hook.mjs') $profileSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    Set-WorkerAcl (Join-Path $toolsRoot 'protocol.mjs') $profileSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
    Set-WorkerAcl (Join-Path $toolsRoot 'task-operations.mjs') $profileSid ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)

    Save-WorkspaceAclTree $workspaceRoot $workspaceRoot $workspaceAclBackup
    Set-WorkspaceAclTree $workspaceRoot $workspaceRoot $profileSid

    $stageNode = Join-Path $toolsRoot 'node.exe'
    $stageModuleHook = Join-Path $toolsRoot 'module-hook.mjs'
    $run = [AppContainerLauncher]::RunNodeWithModuleHooks(
        $stageNode, $stageModuleHook, 'production', $workspaceRoot, $profileSidText, $profileName,
        $hostRequest.requestJson, $timeoutValue, $profilePath)

    $launchResult = $run
    if ($run.TimedOut -and $run.JobDrained) {
        $state = 'timeout'
        $failureCode = 'timeout'
    } elseif (-not $run.TimedOut -and $run.ExitCode -eq 0 -and $run.JobDrained -and
        $run.WorkerTokenVerified -and $run.JobMembershipVerified -and -not $run.OutputTruncated) {
        $state = 'completed'
        $failureCode = $null
        $responseJson = $run.Stdout
    } else {
        $state = 'failed'
        $failureCode = 'worker_exit_unverified'
    }
} catch {
    $state = 'failed'
    $failureCode = if ($_.Exception.Data.Contains('profile_preexisted')) { 'profile_preexisted' } else { 'launcher_failed' }
} finally {
    if ($stageCreated -and $null -ne $profileTempPath -and $null -ne $stageRoot) {
        try {
            Remove-SafeTree $profileTempPath $stageRoot
            $stagingCleanupVerified = Test-SafePathAbsent $profileTempPath $stageRoot
        } catch { $stagingCleanupVerified = $false }
    }
    if ($workspaceAclBackup.Count -gt 0) {
        try {
            Restore-WorkspaceAclTree $workspaceAclBackup
            $workspaceAclRestoreVerified = $true
        } catch { $workspaceAclRestoreVerified = $false }
    }
    if ($profileTempCreated -and $null -ne $profilePath -and $stagingCleanupVerified) {
        try {
            $tempEntries = @([System.IO.Directory]::EnumerateFileSystemEntries($profileTempPath))
            if ($tempEntries.Count -ne 0) { throw 'profile_temp_not_empty_after_stage_cleanup' }
            [System.IO.Directory]::Delete($profileTempPath, $false)
            $profileTempCleanupVerified = Test-SafePathAbsent $profilePath $profileTempPath
        } catch { $profileTempCleanupVerified = $false }
    } else {
        $profileTempCleanupVerified = $true
    }
    $stagingCleanupVerified = $stagingCleanupVerified -and $workspaceAclRestoreVerified -and $profileTempCleanupVerified

    if ($profileCreateAttempted -and -not $profileCreated) {
        $profileCleanupVerified = $false
    } elseif ($profileCreated -and $stagingCleanupVerified -and $null -ne $profilePath) {
        try {
            [AppContainerLauncher]::DeleteProfile($profileName)
            $profileDeleteSucceeded = $true
        } catch { $profileCleanupVerified = $false }
    } elseif (-not $profileCreateAttempted) {
        $profileCleanupVerified = $true
    }
    if ($profileCreated -and $profileDeleteSucceeded -and $null -ne $profilePath) {
        try {
            $profilePackagesRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Packages'
            $profilePathAbsent = Test-SafePathAbsent $profilePackagesRoot $profilePath
            $profileTempAbsent = Test-SafePathAbsent $profilePackagesRoot (Join-Path $profilePath 'Temp')
            $profileCleanupVerified = $profilePathAbsent -and $profileTempAbsent
        } catch { $profileCleanupVerified = $false }
    }
}

if (($state -eq 'completed' -or $state -eq 'timeout') -and
    (-not $profileCleanupVerified -or -not $stagingCleanupVerified)) {
    $state = 'failed'
    $failureCode = 'cleanup_unverified'
    $responseJson = $null
}

Emit-Result ([ordered]@{
    schema_version = 1
    state = $state
    exit_code = if ($null -ne $launchResult) { [int]$launchResult.ExitCode } else { $null }
    timed_out = if ($null -ne $launchResult) { [bool]$launchResult.TimedOut } else { $false }
    job_drained = if ($null -ne $launchResult) { [bool]$launchResult.JobDrained } else { $false }
    worker_token_verified = if ($null -ne $launchResult) { [bool]$launchResult.WorkerTokenVerified } else { $false }
    job_membership_verified = if ($null -ne $launchResult) { [bool]$launchResult.JobMembershipVerified } else { $false }
    output_truncated = if ($null -ne $launchResult) { [bool]$launchResult.OutputTruncated } else { $false }
    profile_cleanup_verified = [bool]$profileCleanupVerified
    staging_cleanup_verified = [bool]$stagingCleanupVerified
    response_json = $responseJson
    failure_code = $failureCode
})
