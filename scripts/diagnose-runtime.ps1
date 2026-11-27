[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-RegistryValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    try {
        return Get-ItemPropertyValue -LiteralPath $Path -Name $Name -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Get-CommandVersion {
    param([Parameter(Mandatory = $true)][string]$Name)

    try {
        $application = Get-Command -Name $Name -CommandType Application -ErrorAction Stop |
            Select-Object -First 1
        $output = @(& $application.Source --version 2>$null)
        if ($LASTEXITCODE -eq 0 -and $output.Count -gt 0) {
            return (($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ }) -join ' ')
        }
    }
    catch {
        # Optional runtimes do not make the diagnostic fail.
    }

    return $null
}

$os = $null
try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
}
catch {
    # The registry fallback works when CIM/WMI is unavailable to this process.
}

$osProduct = if ($os) { [string]$os.Caption } else {
    Get-RegistryValue -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'ProductName'
}
$osDisplayVersion = if ($os) { [string]$os.Version } else {
    Get-RegistryValue -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'DisplayVersion'
}
$osBuild = if ($os) { [string]$os.BuildNumber } else {
    $build = Get-RegistryValue -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'CurrentBuild'
    $revision = Get-RegistryValue -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'UBR'
    if ($null -ne $revision) { "$build.$revision" } else { $build }
}

$cpuName = $null
$logicalProcessorCount = $null
try {
    $processor = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop |
        Select-Object -First 1
    if ($processor) {
        $cpuName = [string]$processor.Name
        $logicalProcessorCount = [int]$processor.NumberOfLogicalProcessors
    }
}
catch {
    $cpuName = Get-RegistryValue -Path 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -Name 'ProcessorNameString'
    if ($cpuName) { $cpuName = ([string]$cpuName).Trim() }
    $logicalProcessorCount = [Environment]::ProcessorCount
}

$totalMemoryGiB = $null
try {
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
    if ($computer -and $computer.TotalPhysicalMemory -gt 0) {
        $totalMemoryGiB = [math]::Round(([double]$computer.TotalPhysicalMemory / 1GB), 2)
    }
}
catch {
    # Keep the value null rather than reporting process/container memory as physical RAM.
}

$projectVolume = $null
$freeBytes = $null
try {
    $volumeRoot = [System.IO.Path]::GetPathRoot($projectRoot)
    if ($volumeRoot) {
        $projectVolume = $volumeRoot.TrimEnd('\')
        $driveInfo = [System.IO.DriveInfo]::new($volumeRoot)
        $freeBytes = [long]$driveInfo.AvailableFreeSpace
    }
}
catch {
    $projectVolume = $null
    $freeBytes = $null
}

$gpu = $null
try {
    $nvidiaSmi = Get-Command -Name 'nvidia-smi.exe' -CommandType Application -ErrorAction Stop |
        Select-Object -First 1
    $gpuRows = @(& $nvidiaSmi.Source '--query-gpu=name,driver_version,memory.total' '--format=csv,noheader' 2>$null)
    if ($LASTEXITCODE -eq 0 -and $gpuRows.Count -gt 0) {
        $parts = ([string]$gpuRows[0]).Split(',') | ForEach-Object { $_.Trim() }
        if ($parts.Count -ge 3) {
            $memoryMiB = $null
            if ($parts[2] -match '^(\d+)\s*MiB$') {
                $memoryMiB = [int]$Matches[1]
            }
            $gpu = [ordered]@{
                name = $parts[0]
                driverVersion = $parts[1]
                memoryMiB = $memoryMiB
            }
        }
    }
}
catch {
    # GPU telemetry is optional and may not be installed or accessible.
}

$report = [ordered]@{
    schemaVersion = 1
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    operatingSystem = [ordered]@{
        product = $osProduct
        displayVersion = $osDisplayVersion
        build = $osBuild
    }
    processor = [ordered]@{
        model = $cpuName
        logicalProcessorCount = $logicalProcessorCount
    }
    memory = [ordered]@{
        totalGiB = $totalMemoryGiB
        status = if ($null -ne $totalMemoryGiB) { 'measured' } else { 'unavailable' }
    }
    storage = [ordered]@{
        projectVolume = $projectVolume
        freeBytes = $freeBytes
    }
    gpu = $gpu
    runtimes = [ordered]@{
        node = Get-CommandVersion -Name 'node.exe'
        npm = Get-CommandVersion -Name 'npm.cmd'
        git = Get-CommandVersion -Name 'git.exe'
        ollama = Get-CommandVersion -Name 'ollama.exe'
    }
}

$outputDirectory = Join-Path $projectRoot 'runtime/diagnostics'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$outputFile = Join-Path $outputDirectory 'hardware-baseline.json'
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outputFile -Encoding UTF8
Write-Output 'Wrote redacted hardware baseline to runtime/diagnostics/hardware-baseline.json'
