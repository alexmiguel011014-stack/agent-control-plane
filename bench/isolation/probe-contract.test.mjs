import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyAccessError, MAX_PROBE_REQUEST_BYTES, parseProbeRequest } from './probe-contract.mjs';

const WORKSPACE = 'C:\\probe\\stage\\workspace';
const CANARIES = Object.freeze({
  runtime: { readPath: 'C:\\probe\\runtime\\read.txt', writePath: 'C:\\probe\\runtime\\write.txt' },
  repository: { readPath: 'C:\\repo\\read.txt', writePath: 'C:\\repo\\write.txt' },
  oracle: { readPath: 'C:\\repo\\bench\\oracles\\read.txt', writePath: 'C:\\repo\\bench\\oracles\\write.txt' },
  ownerProfile: { readPath: 'C:\\Users\\owner\\AppData\\Local\\probe\\read.txt', writePath: 'C:\\Users\\owner\\AppData\\Local\\probe\\write.txt' },
});

function request(value) {
  return parseProbeRequest(Buffer.from(JSON.stringify(value), 'utf8'), WORKSPACE);
}

test('filesystem probe request accepts only fixed external nonce canaries', () => {
  const parsed = request({ mode: 'filesystem', canaries: CANARIES, writeMarker: 'probe-write:nonce' });
  assert.equal(parsed.mode, 'filesystem');
  assert.deepEqual(Object.keys(parsed.canaries), ['runtime', 'repository', 'oracle', 'ownerProfile']);
  assert.equal(parsed.canaries.oracle.readPath, CANARIES.oracle.readPath);
  assert.equal(Object.isFrozen(parsed.canaries), true);
});

test('filesystem probe request rejects malformed, oversized, duplicate, and workspace paths', () => {
  const valid = { mode: 'filesystem', canaries: CANARIES, writeMarker: 'probe-write:nonce' };
  assert.throws(() => parseProbeRequest(Buffer.alloc(MAX_PROBE_REQUEST_BYTES + 1), WORKSPACE), /byte limit/);
  assert.throws(() => parseProbeRequest(Buffer.from([0xff]), WORKSPACE), /UTF-8 JSON/);
  assert.throws(() => request({ ...valid, extra: true }), /fields/);
  assert.throws(() => request({ ...valid, canaries: { ...CANARIES, extra: {} } }), /fields/);
  assert.throws(() => request({ ...valid, writeMarker: 'not safe\n' }), /fields/);
  assert.throws(() => request({ ...valid, canaries: { ...CANARIES, runtime: { readPath: `${WORKSPACE}\\read.txt`, writePath: `${WORKSPACE}\\write.txt` } } }), /outside the staged workspace/);
  assert.throws(() => request({ ...valid, canaries: { ...CANARIES, runtime: { readPath: 'C:\\repo\\..\\secret', writePath: 'C:\\probe\\write.txt' } } }), /traversal/);
  assert.throws(() => request({ ...valid, canaries: { ...CANARIES, runtime: { readPath: 'C:\\repo\\same.txt', writePath: 'c:\\REPO\\same.txt' } } }), /differ/);
});

test('network probe is limited to the controlled IPv4 loopback listener and bounded port/time', () => {
  assert.deepEqual(request({ mode: 'network', host: '127.0.0.1', port: 41321, timeoutMs: 1500 }), {
    mode: 'network', host: '127.0.0.1', port: 41321, timeoutMs: 1500,
  });
  for (const changed of [
    { host: 'localhost' }, { host: '::1' }, { host: '8.8.8.8' },
    { port: 0 }, { port: 65_536 }, { timeoutMs: 199 }, { timeoutMs: 3001 }, { extra: true },
  ]) {
    assert.throws(() => request({ mode: 'network', host: '127.0.0.1', port: 41321, timeoutMs: 1500, ...changed }), /loopback network/);
  }
});

test('process-tree request rejects additional control fields', () => {
  assert.deepEqual(request({ mode: 'process-tree' }), { mode: 'process-tree' });
  assert.throws(() => request({ mode: 'process-tree', command: 'not-allowed' }), /fields/);
  assert.throws(() => request({ mode: 'unknown' }), /Unknown probe mode/);
});

test('only explicit access-control errors classify as denied', () => {
  assert.equal(classifyAccessError('EACCES'), 'DENIED');
  assert.equal(classifyAccessError('EPERM'), 'DENIED');
  assert.equal(classifyAccessError('READ_ALLOWED'), 'ALLOWED');
  assert.equal(classifyAccessError('WRITE_ALLOWED'), 'ALLOWED');
  assert.equal(classifyAccessError('CONNECTED'), 'ALLOWED');
  for (const code of ['ENOENT', 'EEXIST', 'ECONNREFUSED', 'TIMEOUT', 'UNKNOWN']) {
    assert.equal(classifyAccessError(code), 'UNKNOWN', code);
  }
});

test('probe report is bound to the exact evaluator runtime fingerprint without creating attestation', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const worker = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  const documentation = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(source, /runner_sha256\s*=\s*Get-RuntimeFingerprint\s+\$nodeSource\s+\$repoRoot/);
  assert.match(source, /getRuntimeFingerprint\(root\)/);
  assert.match(source, /probe_components_sha256/);
  assert.match(source, /stageProbeContract\s*=\s*Join-Path\s+\$toolsRoot\s+'probe-contract\.mjs'/);
  assert.match(source, /Copy-SafeFile\s+\$probeContractSource\s+\$toolsRoot\s+\$stageProbeContract/);
  assert.match(source, /stagedProbeContractHash\s+-ne\s+\$probeContractHash/);
  assert.match(source, /g2_2_attestation\s*=\s*\$false/);
  assert.match(source, /gate_status\s*=\s*'PENDING_OWNER_REVIEW'/);
  assert.doesNotMatch(source, /g2-isolation-evidence\.json/);
  assert.doesNotMatch(worker, /bench[\\/]oracles|oracle-runner|public-test-registry/);
  assert.match(documentation, /trusted host's full runner fingerprint[\s\S]*?hash[\s\S]*?oracle JSON[\s\S]*?bytes/u);
});

test('probe-contract module has declarations only at top level for the staged diagnostic import', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./probe-contract.mjs', import.meta.url), 'utf8');
  const topLevel = source.split(/\r?\n/u).filter((line) => line.length > 0 && !/^\s/u.test(line));
  const allowed = /^(?:import path from 'node:path';|(?:export )?const [A-Z0-9_]+ = .*;|(?:export )?function [A-Za-z][A-Za-z0-9]*\(.*\) \{|\})$/u;
  assert.deepEqual(topLevel.filter((line) => !allowed.test(line)), []);
  assert.equal((source.match(/^import /gmu) ?? []).length, 1);
  assert.doesNotMatch(source, /\b(?:node:fs|node:child_process|node:net|process\.env|console\.)/u);
});

test('profile contract diagnostic is a nonce-scoped one-shot mode with fail-closed cleanup', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const documentation = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const branchMarker = source.indexOf("$report.scope = 'profile-contract-import-diagnostic-only'");
  const branchStart = source.lastIndexOf('if ($ProfileContractImportDiagnosticOnly) {', branchMarker);
  const branchEnd = source.indexOf('} elseif ($ProtocolSmokeOnly) {', branchMarker);
  const branch = source.slice(branchStart, branchEnd);
  const finallyStart = source.indexOf('\nfinally {', branchMarker);
  const stageCleanup = source.indexOf('Remove-SafeTree $workerTempPath $profileContractStageRoot', finallyStart);
  const tempDirectoryDelete = source.indexOf('[System.IO.Directory]::Delete($profileTempForCleanup, $false)', finallyStart);
  const profileDelete = source.indexOf('[AppContainerLauncher]::DeleteProfile($profileName)', finallyStart);
  const cleanupCatch = source.indexOf("Set-Diagnostic 'profile-contract-stage-cleanup'", finallyStart);
  const tempPreparationStart = source.indexOf("$currentPhase = 'profile-temp-prepare'");
  const tempPreparationEnd = source.indexOf("$currentPhase = 'staging-acl'", tempPreparationStart);
  const tempPreparation = source.slice(tempPreparationStart, tempPreparationEnd);
  const deleteDecisionStart = source.indexOf('function Get-ProfileDeleteDecision(');
  const deleteDecisionEnd = source.indexOf('\nfunction Get-ProfileCleanupGateStatus(', deleteDecisionStart);
  const deleteDecisionFunction = source.slice(deleteDecisionStart, deleteDecisionEnd);
  const profilePathFunctionStart = source.indexOf('function Get-AppContainerProfilePackagesRoot(');
  const profilePathFunctionEnd = source.indexOf('\nfunction Get-ProfileContractStagePaths(', profilePathFunctionStart);
  const profilePathFunctions = source.slice(profilePathFunctionStart, profilePathFunctionEnd);
  const profileCleanupVerificationStart = source.indexOf('if ($null -ne $profileCleanupPathForVerification) {', finallyStart);
  const profileCleanupVerificationEnd = source.indexOf('\n    if ($report.profile_preexisted)', profileCleanupVerificationStart);
  const profileCleanupVerification = source.slice(profileCleanupVerificationStart, profileCleanupVerificationEnd);
  const reportStart = source.indexOf('$report = [ordered]@{');
  const reportEnd = source.indexOf('\nfunction Set-Check(', reportStart);
  const reportShape = source.slice(reportStart, reportEnd);
  const pathDiagnosticStart = source.indexOf('function Invoke-ProfilePathResolveDiagnosticMode {');
  const pathDiagnosticEnd = source.indexOf('\nif ($ProcessTokenChainDiagnosticOnly) {', pathDiagnosticStart);
  const pathDiagnosticMode = source.slice(pathDiagnosticStart, pathDiagnosticEnd);

  assert.ok(branchMarker !== -1 && branchStart !== -1 && branchEnd > branchStart);
  assert.match(source, /\[switch\]\$ProfileContractImportDiagnosticOnly/);
  assert.match(source, /\[switch\]\$ProfileBootstrapDiagnosticOnly/);
  assert.match(source, /\[switch\]\$ProfilePathResolveDiagnosticOnly/);
  assert.match(source, /\$ProfileContractImportDiagnosticOnly -and \(\$PreflightOnly -or \$ProtocolSmokeOnly -or \$ProfileBootstrapDiagnosticOnly\)/);
  assert.match(source, /\$ProfileBootstrapDiagnosticOnly -and \(\$PreflightOnly -or \$ProtocolSmokeOnly\)/);
  assert.match(source, /\$profileRunStageInTemp = -not \(\$PreflightOnly -or \$ProtocolSmokeOnly -or\s+\$ProfileContractImportDiagnosticOnly -or \$ProfileBootstrapDiagnosticOnly -or\s+\$ProfilePathResolveDiagnosticOnly -or \$ProcessTokenChainDiagnosticOnly\)/);
  assert.match(source, /if \(-not \(\$ProfileContractImportDiagnosticOnly -or \$ProfileBootstrapDiagnosticOnly -or\s+\$ProfilePathResolveDiagnosticOnly\)\) \{\s*\$null = Ensure-SafeDirectory \$diagnosticsRoot \$canaryCollectionRoot/s);
  assert.ok(pathDiagnosticStart !== -1 && pathDiagnosticEnd > pathDiagnosticStart);
  assert.doesNotMatch(pathDiagnosticMode, /\[Console\]::Out\.Write|Write-Output/);
  assert.ok(tempPreparationStart !== -1 && tempPreparationEnd > tempPreparationStart);
  assert.match(tempPreparation, /Test-SafePathAbsent \$profilePath \$profileTempCanonical/);
  assert.match(tempPreparation, /Get-ProfileTempPreparationDecision \$profileTempExists \$profileTempIsDirectory/);
  assert.match(tempPreparation, /\$profileTempExistedBeforeDiagnostic\s*=\s*\[bool\]\$profileTempExists/);
  assert.match(tempPreparation, /\$profileTempCreationAttempted\s*=\s*\$true[\s\S]*?\$profileLocalWritesAttempted\s*=\s*\$true[\s\S]*?New-SafeDirectory \$profilePath \$profileTempCanonical/);
  assert.match(tempPreparation, /\$report\.profile_local_write_attempted\s*=\s*\$true/);
  assert.match(tempPreparation, /New-SafeDirectory \$profilePath \$profileTempCanonical/);
  assert.doesNotMatch(tempPreparation, /Set-ProbeAcl|SetAccessControl/);
  assert.ok(profilePathFunctionStart !== -1 && profilePathFunctionEnd > profilePathFunctionStart);
  assert.match(profilePathFunctions, /Get-CanonicalLocalDrivePath \$ProfilePath/);
  assert.match(profilePathFunctions, /\\Packages\\' \+ \$ProfileName \+ '\\AC/);
  assert.match(profilePathFunctions, /Assert-NoReparsePath/);
  assert.doesNotMatch(profilePathFunctions, /LocalApplicationData|OwnerLocalAppData/);
  assert.match(source, /\$syntheticCallerLocalAppData[\s\S]*?\$syntheticAppContainerProfile[\s\S]*?ProfilePath -ceq \$syntheticCallerLocalAppData/);
  assert.match(source, /\$ProfileName -cne \('AgentCP' \+ \$Nonce\.Substring\(0, 17\)\)/);
  assert.match(source, /Join-Path \$tempPath \('profile-contract-' \+ \$Nonce\)/);
  assert.match(branch, /New-SafeDirectory \$profileContractPaths\.TempPath \$profileContractStageRoot/);
  assert.match(branch, /Copy-SafeFile \$probeContractSource \$profileContractStageRoot \$profileContractModulePath/);
  assert.match(branch, /Test-ProfileContractHashMatch[\s\S]*?\$probeContractHash[\s\S]*?Get-Sha256 \$profileContractModulePath/);
  assert.match(branch, /RunProfileContractImportDiagnostic\(/);
  assert.doesNotMatch(branch, /Set-ProbeAcl|SetAccessControl|New-ProbeCanary|\$probeListener|RunNode\(|RunStagedFileReadDiagnostic|\.RunNode\(/);
  assert.doesNotMatch(branch, /Set-Check|g2_2_attestation\s*=\s*\$true|gate_status\s*=\s*'PASS'/);
  assert.ok(stageCleanup !== -1 && tempDirectoryDelete > stageCleanup && profileDelete > tempDirectoryDelete,
    'cleanup order must be nonce child, empty Temp directory, then AppContainer profile');
  assert.ok(cleanupCatch > stageCleanup && cleanupCatch < profileDelete);
  assert.match(source, /if \(\$profileContractStageCleanupVerified -eq \$true -and\s*\(\$profileTempCreationAttempted -or \$profileTempCreatedByDiagnostic\)\)/);
  assert.match(source, /The AppContainer Temp creation outcome is uncertain; preserving the profile/);
  assert.match(source, /\[System\.IO\.Directory\]::Delete\(\$profileTempForCleanup, \$false\)/);
  assert.match(deleteDecisionFunction, /if \(-not \$ProfileLocalWritesAttempted\) \{ return 'DELETE' \}/);
  assert.match(deleteDecisionFunction, /if \(\$ProfileOnly -and -not \$ProfilePathResolved\) \{ return 'PRESERVE_PROFILE_PATH_UNKNOWN' \}/);
  assert.match(deleteDecisionFunction, /if \(\$null -eq \$StageCleanupVerified\) \{ return 'PRESERVE_STAGE_UNKNOWN' \}/);
  assert.match(deleteDecisionFunction, /if \(-not \$StageCleanupVerified\) \{ return 'PRESERVE_STAGE_FAILED' \}/);
  assert.match(deleteDecisionFunction, /\$ProfileTempCreationAttempted -or \$ProfileTempCreatedByDiagnostic/);
  assert.match(source, /\$preWriteProfileDeleteDecision -cne 'DELETE'/);
  assert.match(source, /\$unresolvedProfilePathDeleteDecision -cne 'PRESERVE_PROFILE_PATH_UNKNOWN'/);
  assert.match(source, /\$unknownProfileStageDeleteDecision -cne 'PRESERVE_STAGE_UNKNOWN'/);
  assert.match(source, /\$uncertainTempCreationDeleteDecision -cne 'PRESERVE_TEMP_UNKNOWN'/);
  assert.match(source, /\$failedTempCleanupDeleteDecision -cne 'PRESERVE_TEMP_FAILED'/);
  assert.match(source, /if \(\$profileDeleteDecision -eq 'DELETE' -and \(\$profileCreated -or \$profileCreateAttempted\)\)[\s\S]*?\[AppContainerLauncher\]::DeleteProfile/);
  assert.match(source, /profile_id\s*=\s*\$profileName/);
  assert.match(source, /profile_local_write_attempted\s*=\s*\[bool\]\$profileLocalWritesAttempted/);
  assert.match(source, /profile_temp_creation_attempted\s*=\s*\[bool\]\$profileTempCreationAttempted/);
  assert.match(reportShape, /profile_id\s*=\s*\$profileName/);
  assert.match(reportShape, /profile_local_write_attempted\s*=\s*\[bool\]\$profileLocalWritesAttempted/);
  assert.doesNotMatch(reportShape, /^\s*profile_path\s*=/mu);
  assert.match(profileCleanupVerification, /Get-AppContainerProfilePackagesRoot \$profileCleanupPathForVerification \$profileName/);
  assert.doesNotMatch(profileCleanupVerification, /LocalApplicationData/);
  const profileApiPathStart = launcher.indexOf('private static string GetProfileLocalAppDataPath(');
  const profileApiPathEnd = launcher.indexOf('\n    public static string GetProfilePath(', profileApiPathStart);
  const profileApiPath = launcher.slice(profileApiPathStart, profileApiPathEnd);
  assert.ok(profileApiPathStart !== -1 && profileApiPathEnd > profileApiPathStart);
  assert.match(profileApiPath, /GetAppContainerFolderPath\(profileSid, out path\)/);
  assert.match(profileApiPath, /\\\\Packages\\\\" \+ profileName \+ "\\\\AC/);
  assert.match(profileApiPath, /EnsureNoReparsePointsInPath\(fullPath\)/);
  assert.doesNotMatch(profileApiPath, /LocalApplicationData|Environment\.GetFolderPath/);
  assert.match(source, /profile_contract_import_diagnostic\.cleanup_status = 'FAIL'/);
  assert.match(source, /Synthetic profile Temp, staging ACL, registration boundedness, cleanup, and profile preservation self-test failed/);
  assert.match(source, /\$temporaryCleanupError = \$true[\s\S]*?profile_contract_stage_absent/);
  assert.match(documentation, /-ProfileContractImportDiagnosticOnly/);
  assert.match(documentation, /profile-contract-<nonce>[\\/]probe-contract\.mjs/);
  assert.match(documentation, /If the profile `Temp`\s+directory is absent, the mode creates it[\s\S]*?removes only an empty `Temp`\s+directory created by this mode/u);
  assert.match(documentation, /GetAppContainerFolderPath[\s\S]*?Packages[\\/]<generated profile id>[\\/]AC[\s\S]*?does not compare[\s\S]*?caller.?s `LocalApplicationData`/u);
  assert.match(documentation, /`profile_id`[\s\S]*?`profile_local_write_attempted`[\s\S]*?does not emit the profile path/u);
  assert.match(documentation, /If either cleanup step fails or cannot be\s+verified, it preserves the profile for inspection/u);
  assert.match(documentation, /mode makes no ACL changes/u);
  assert.match(documentation, /creates no canaries/u);
  assert.match(documentation, /opens no\s+listener/u);
  assert.match(documentation, /does not import or execute `worker\.mjs`, a candidate/u);
  assert.match(documentation, /observations remain outside gate checks[\s\S]*?gate_status` stays[\s\S]*?PENDING_OWNER_REVIEW/u);
});

test('diagnostic records allowlisted filesystem operations and App SID DACL inventory before startup', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const documentation = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const operationStart = source.indexOf('function Get-WorkerStderrOperation(');
  const operationEnd = source.indexOf('\nfunction Get-WorkerLauncherObservation(', operationStart);
  const operationFunction = source.slice(operationStart, operationEnd);
  const aclStart = source.indexOf('function Convert-AppSidDaclSummary(');
  const aclEnd = source.indexOf('\nfunction Get-ProfileBootstrapStagingAclStatus(', aclStart);
  const aclFunctions = source.slice(aclStart, aclEnd);
  const inventoryStart = source.indexOf('$report.observations.staging_app_sid_dacl');
  const startupLaunch = source.indexOf('[AppContainerLauncher]::RunStartupAttributeDiagnostics', inventoryStart);

  assert.notEqual(operationStart, -1);
  for (const operation of ['lstat', 'stat', 'open', 'read', 'readlink', 'realpath', 'readdir', 'access']) {
    assert.ok(operationFunction.includes(`'${operation}'`), `missing filesystem operation ${operation}`);
  }
  assert.match(operationFunction, /syscallPattern/);
  assert.match(operationFunction, /nodeFsErrorPattern/);
  assert.match(operationFunction, /return \$operation/);
  assert.match(aclFunctions, /IdentityReference/);
  assert.match(aclFunctions, /identitySid\.Value\s+-cne\s+\$AppSid\.Value/);
  assert.match(aclFunctions, /access\s*=\s*\$access/);
  assert.match(aclFunctions, /rights\s*=/);
  assert.match(aclFunctions, /inherited\s*=\s*\[bool\]\$rule\.IsInherited/);
  assert.match(aclFunctions, /minimum_expected_allow_ace_present/);
  assert.match(aclFunctions, /read_traverse_allow_ace_present/);
  assert.match(aclFunctions, /\[System\.IO\.(?:DirectoryInfo|FileInfo)\]::new\(\$Path\)\.GetAccessControl\(\)/);
  assert.match(aclFunctions, /Convert-AppSidDaclSummary\s+-Label\s+\$Label\s+-AccessRules\s+\$accessRules `?\s+-AppSid\s+\$AppSid\s+-ExpectedRights\s+\$ExpectedRights/);
  assert.match(aclFunctions, /exception_type\s*=\s*\$exceptionDetails\.exception_type/);
  assert.match(aclFunctions, /exception_hresult\s*=\s*\$exceptionDetails\.hresult/);
  assert.match(aclFunctions, /native_win32_code\s*=\s*\$exceptionDetails\.native_win32_code/);
  assert.doesNotMatch(aclFunctions, /Set-ProbeAcl|SetAccessControl/);
  assert.match(source, /function Get-DirectoryAncestorDescriptorInputs\(/);
  assert.match(source, /'volume_root'[\s\S]*?'runRoot'[\s\S]*?'stageRoot'[\s\S]*?'toolsRoot'/);
  for (const [label, path] of [
    ['stageRoot', '$stageRoot'], ['toolsRoot', '$toolsRoot'], ['workspaceRoot', '$workspaceRoot'],
    ['stagedNode', '$stageNode'], ['workerModule', '$stageWorker'], ['probeContract', '$stageProbeContract'],
  ]) {
    assert.ok(source.includes(`${label} = (Get-AppSidDaclSummary '${label}' ${path}`), `missing DACL label ${label}`);
  }
  assert.ok(inventoryStart !== -1 && startupLaunch > inventoryStart);
  assert.match(source, /module_read_traverse_allow_aces_present/);
  assert.match(source, /Synthetic App SID DACL inventory contract self-test failed/);
  const tokenDiagnosticStart = source.indexOf('function Convert-AppContainerTokenDiagnostic(');
  const tokenDiagnosticEnd = source.indexOf('\nfunction Get-CallerLineNumber(', tokenDiagnosticStart);
  const tokenDiagnosticFunction = source.slice(tokenDiagnosticStart, tokenDiagnosticEnd);
  assert.match(tokenDiagnosticFunction, /se_change_notify_privilege_query_succeeded/);
  assert.match(tokenDiagnosticFunction, /se_change_notify_privilege_present/);
  assert.match(tokenDiagnosticFunction, /se_change_notify_privilege_enabled/);
  assert.match(tokenDiagnosticFunction, /directory_ancestors/);
  assert.match(tokenDiagnosticFunction, /directory_read_attributes_method/);
  assert.match(tokenDiagnosticFunction, /read_attributes_status/);
  assert.match(launcher, /TryCheckAccess\(impersonationToken,\s*descriptor,\s*FILE_TRAVERSE,\s*out accessGranted\)/);
  assert.match(launcher, /TryCheckAccess\(impersonationToken,\s*descriptor,\s*FILE_READ_ATTRIBUTES,\s*out readAttributesGranted\)/);
  assert.match(launcher, /ReadAttributesStatus = GetAccessCheckDecision\(\s*readAttributesQuerySucceeded,\s*readAttributesGranted\)/);
  assert.match(launcher, /diagnostics\[index\]\.ReadAttributesStatus = "UNKNOWN"/);
  const tokenSyntheticStart = source.indexOf('$syntheticTokenDiagnostic = Convert-AppContainerTokenDiagnostic');
  const tokenSyntheticEnd = source.indexOf('$syntheticStagedFileDiagnostic = Convert-StagedFileReadDiagnostic', tokenSyntheticStart);
  const tokenSynthetic = source.slice(tokenSyntheticStart, tokenSyntheticEnd);
  assert.ok(tokenSyntheticStart !== -1 && tokenSyntheticEnd > tokenSyntheticStart);
  assert.match(tokenSynthetic, /ReadAttributesStatus = 'ALLOW'/);
  assert.match(tokenSynthetic, /ReadAttributesStatus = 'DENY'/);
  assert.match(tokenSynthetic, /ReadAttributesStatus = 'unsupported'/);
  assert.match(tokenSynthetic, /Label = 'volume_root'[\s\S]*?Label = 'volume_root'/);
  assert.match(tokenSynthetic, /'ancestor_000'[\s\S]*?read_attributes_status -cne 'DENY'/);
  assert.match(tokenSynthetic, /read_attributes_status -cne 'ALLOW'/);
  assert.match(tokenSynthetic, /read_attributes_status -cne 'UNKNOWN'/);
  assert.match(tokenSynthetic, /syntheticAncestorKeys -join ','\) -cne 'label,read_attributes_status,status'/);
  assert.match(source, /GetTraverseAccessDecision\(\$true,\s*\$true\)[\s\S]{0,160}?GetTraverseAccessDecision\(\$true,\s*\$false\)[\s\S]{0,160}?GetTraverseAccessDecision\(\$false,\s*\$true\)/);
  assert.match(source, /Get-DirectoryAncestorDescriptorInputs\s+\$toolsRoot\s+\$stageRootParent\s+\$stageRoot\s+\$toolsRoot/);
  assert.match(source, /directoryTraversalInputs\.Labels,[\s\S]{0,120}?directoryTraversalInputs\.Descriptors/);
  assert.match(source, /report\.observations\.appcontainer_token_diagnostic\s*=\s*Convert-AppContainerTokenDiagnostic/);
  const tokenReportPosition = source.indexOf('$report.observations.appcontainer_token_diagnostic');
  const tokenGatePosition = source.indexOf('if ($startupAttributeDiagnostic.Control.Passed)', tokenReportPosition);
  assert.ok(tokenReportPosition !== -1 && tokenGatePosition > tokenReportPosition);
  assert.doesNotMatch(source.slice(tokenReportPosition, tokenGatePosition), /Set-Check/);
  const ancestorStart = source.indexOf('function Get-DirectoryAncestorDescriptorInputs(');
  const ancestorEnd = source.indexOf('\nfunction Get-SafeExceptionDiagnosticDetails(', ancestorStart);
  const ancestorFunction = source.slice(ancestorStart, ancestorEnd);
  assert.ok(ancestorStart !== -1 && ancestorEnd > ancestorStart);
  assert.match(ancestorFunction, /GetPathRoot\(\$target\)/);
  assert.match(ancestorFunction, /volume_root|runRoot|stageRoot|toolsRoot/);
  assert.doesNotMatch(ancestorFunction, /Set-ProbeAcl|SetAccessControl/);
  assert.doesNotMatch(source, /Set-ProbeAcl\s+\$(?:runRoot|volumeRoot|ancestorPath)/);
  const stagedFilesStart = source.indexOf('function Get-StagedFileDescriptorInputs(');
  const stagedFilesEnd = source.indexOf('\nfunction Get-SafeExceptionDiagnosticDetails(', stagedFilesStart);
  const stagedFilesFunction = source.slice(stagedFilesStart, stagedFilesEnd);
  assert.ok(stagedFilesStart !== -1 && stagedFilesEnd > stagedFilesStart);
  assert.match(stagedFilesFunction, /Label = 'workerModule'; Path = \$WorkerModulePath/);
  assert.match(stagedFilesFunction, /Label = 'probeContract'; Path = \$ProbeContractPath/);
  assert.match(stagedFilesFunction, /\[System\.IO\.FileInfo\]::new\(\$entry\.Path\)\.GetAccessControl\(\)/);
  assert.doesNotMatch(stagedFilesFunction, /Set-ProbeAcl|SetAccessControl/);
  const stagedFileDiagnosticStart = source.indexOf('function Convert-StagedFileReadDiagnostic(');
  const stagedFileDiagnosticEnd = source.indexOf('\nfunction Get-CallerLineNumber(', stagedFileDiagnosticStart);
  const stagedFileDiagnosticFunction = source.slice(stagedFileDiagnosticStart, stagedFileDiagnosticEnd);
  assert.match(stagedFileDiagnosticFunction, /read_attributes = \$attributesStatus/);
  assert.match(stagedFileDiagnosticFunction, /read_data = \$dataStatus/);
  assert.match(source, /Get-StagedFileDescriptorInputs \$stageWorker \$stageProbeContract/);
  assert.match(source, /\[string\[\]\]\$stagedFileInputs\.Labels, \[byte\[\]\[\]\]\$stagedFileInputs\.Descriptors/);
  assert.match(source, /report\.observations\.staged_file_access_diagnostic\s*=\s*Convert-StagedFileReadDiagnostic/);
  const stagedDiagnosticPosition = source.indexOf('$report.observations.staged_file_access_diagnostic');
  const stagedGatePosition = source.indexOf('if ($startupAttributeDiagnostic.Control.Passed)', stagedDiagnosticPosition);
  assert.ok(stagedDiagnosticPosition !== -1 && stagedGatePosition > stagedDiagnosticPosition);
  assert.doesNotMatch(source.slice(stagedDiagnosticPosition, stagedGatePosition), /Set-Check/);
  assert.match(launcher, /FILE_READ_ATTRIBUTES = 0x00000080/);
  assert.match(launcher, /FILE_READ_DATA = 0x00000001/);
  assert.match(launcher, /TryCheckAccess\(impersonationToken, descriptor,[\s\S]{0,180}?FILE_READ_ATTRIBUTES/);
  assert.match(launcher, /TryCheckAccess\(impersonationToken, descriptor,[\s\S]{0,180}?FILE_READ_DATA/);
  assert.match(source, /Synthetic staged file AccessCheck privacy\/status self-test failed/);
  const targetFunctionStart = source.indexOf('function Get-WorkerStderrTarget(');
  const targetFunctionEnd = source.indexOf('\nfunction Get-WorkerLauncherObservation(', targetFunctionStart);
  const targetFunction = source.slice(targetFunctionStart, targetFunctionEnd);
  assert.match(targetFunction, /singleQuotedPath = "'" \+ \$candidate\.Path \+ "'"/);
  assert.match(targetFunction, /Text\.IndexOf\(\$singleQuotedPath, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(targetFunction, /Text\.IndexOf\(\$doubleQuotedPath, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.doesNotMatch(targetFunction, /Text\.IndexOf\(\$candidate\.Path/);
  assert.match(targetFunction, /Label = 'workerModule'/);
  assert.match(targetFunction, /Label = 'probeContract'/);
  assert.match(targetFunction, /Label = 'stagedNode'/);
  assert.match(source, /Synthetic exact stderr target classification self-test failed/);
  assert.match(source, /\$syntheticWorkerModulePath\.bak/);
  assert.match(source, /prefix\$syntheticWorkerModulePath/);
  assert.match(source, /stderr_target = Get-WorkerStderrTarget/);
  assert.match(documentation, /FILE_READ_ATTRIBUTES[\s\S]*?FILE_READ_DATA[\s\S]*?not an end-to-end `CreateFile` or[\s\S]*?ReadFile/u);
  assert.match(documentation, /stderr_target[\s\S]*?Raw stderr and paths are not added/u);
  assert.match(source, /Synthetic DACL exception diagnostic privacy self-test failed/);
  assert.match(source, /Synthetic stderr operation classification self-test failed/);
  const runtimeDiagnosticStart = source.indexOf('function Convert-StagedNodeReadDiagnosticObservation(');
  const runtimeDiagnosticEnd = source.indexOf('\nfunction Get-CallerLineNumber {', runtimeDiagnosticStart);
  const runtimeDiagnosticFunction = source.slice(runtimeDiagnosticStart, runtimeDiagnosticEnd);
  assert.ok(runtimeDiagnosticStart !== -1 && runtimeDiagnosticEnd > runtimeDiagnosticStart);
  assert.match(runtimeDiagnosticFunction, /ConvertFrom-Json -ErrorAction Stop/);
  assert.match(runtimeDiagnosticFunction, /Test-ExactObjectKeys \$response @\('schema_version', 'files', 'ancestor_chain', 'ancestors', 'import'\)/);
  assert.match(runtimeDiagnosticFunction, /response\.ancestors\.Count -gt 32/);
  assert.match(runtimeDiagnosticFunction, /Test-StagedAncestorOperation/);
  assert.match(runtimeDiagnosticFunction, /Test-StagedImportDiagnostic/);
  assert.match(source, /function Test-StagedAncestorOperation/);
  assert.match(source, /function Test-StagedImportDiagnostic/);
  assert.match(source, /Synthetic import syscall\/path-label privacy self-test failed/);
  assert.match(source, /Synthetic import path-label allowlist self-test failed/);
  assert.match(runtimeDiagnosticFunction, /stdout_bytes -gt 4096/);
  assert.match(runtimeDiagnosticFunction, /-not \$allFilesReadable[\s\S]*?response\.import\.status -ceq 'PASS'/);
  assert.match(runtimeDiagnosticFunction, /\$allFilesReadable[\s\S]*?response\.import\.status -ceq 'SKIPPED'/);
  assert.match(runtimeDiagnosticFunction, /workerModule[\s\S]*?probeContract/u);
  assert.match(source, /RunStagedFileReadDiagnostic\(/);
  assert.match(source, /report\.observations\.staged_file_runtime_diagnostic\s*=\s*Convert-StagedNodeReadDiagnosticObservation/);
  assert.match(source, /Synthetic staged read runtime output validation\/privacy self-test failed/);
  assert.match(source, /Synthetic staged read malformed output rejection self-test failed/);
  const protocolBranchPosition = source.indexOf('if ($ProtocolSmokeOnly)');
  const fullProbeBranchPosition = source.indexOf('} else {', protocolBranchPosition);
  const runtimePhasePosition = source.indexOf("$currentPhase = 'staged-file-runtime-diagnostic'");
  const runtimeReportPosition = source.indexOf('$report.observations.staged_file_runtime_diagnostic = Convert-StagedNodeReadDiagnosticObservation $stagedFileRuntimeRun');
  const nextFullProbeStep = source.indexOf("$writeMarker = 'appcontainer-probe-write:'", runtimeReportPosition);
  assert.ok(protocolBranchPosition !== -1 && fullProbeBranchPosition > protocolBranchPosition);
  assert.ok(runtimePhasePosition > fullProbeBranchPosition && runtimeReportPosition > runtimePhasePosition);
  assert.ok(nextFullProbeStep > runtimeReportPosition);
  assert.doesNotMatch(source.slice(runtimePhasePosition, nextFullProbeStep), /Set-Check/);
  assert.match(documentation, /CommonJS `node -e`[\s\S]*?lstat[\s\S]*?reads and discards[\s\S]*?never imports `worker\.mjs`/u);
  assert.match(documentation, /failed lstat\/read skips the import[\s\S]*?not gate evidence/u);
  assert.match(documentation, /DACL entries only; they are not an effective[\s\S]*?token-access check/u);
  assert.match(documentation, /AccessCheck\(FILE_TRAVERSE\)[\s\S]*?impersonation duplicate[\s\S]*?UNKNOWN/u);
});

test('full probe stages runtime and workspace under nonce AppContainer Temp and cleans before profile deletion', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const documentation = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  const goals = await readFile(new URL('../../GOALS.md', import.meta.url), 'utf8');
  const pathsStart = source.indexOf('function Get-ProfileRunStagePaths(');
  const pathsEnd = source.indexOf('\nfunction Test-ProfileContractHashMatch(', pathsStart);
  const runStageStart = source.indexOf("$currentPhase = 'profile-run-stage-prepare'");
  const runStageEnd = source.indexOf("$currentPhase = 'staging-acl'", runStageStart);
  const cleanupStart = source.indexOf("$report.observations.profile_run_stage.stage_cleanup_status = 'UNKNOWN'");
  const deleteDecision = source.indexOf('$profileDeleteDecision = Get-ProfileDeleteDecision', cleanupStart);
  const profileDelete = source.indexOf('[AppContainerLauncher]::DeleteProfile($profileName)', deleteDecision);

  assert.ok(pathsStart !== -1 && pathsEnd > pathsStart);
  assert.ok(runStageStart !== -1 && runStageEnd > runStageStart);
  assert.ok(cleanupStart !== -1 && deleteDecision > cleanupStart && profileDelete > deleteDecision);

  const pathBuilder = source.slice(pathsStart, pathsEnd);
  const runStage = source.slice(runStageStart, runStageEnd);
  const cleanup = source.slice(cleanupStart, deleteDecision);
  assert.match(pathBuilder, /Get-AppContainerProfilePackagesRoot/);
  assert.match(pathBuilder, /Join-Path \$canonicalProfile 'Temp'/);
  assert.match(pathBuilder, /'agentcp-run-' \+ \$Nonce/);
  assert.match(pathBuilder, /ToolsRoot = Assert-ChildPath \$stageRoot/);
  assert.match(pathBuilder, /WorkspaceRoot = Assert-ChildPath \$stageRoot/);
  assert.match(runStage, /Get-ProfileRunStagePaths \$profilePath \$profileName \$nonce/);
  assert.match(runStage, /profileTempCanonical = Assert-NoReparsePath/);
  assert.match(runStage, /profileRunStageAbsentBefore = Test-SafePathAbsent/);
  assert.match(runStage, /Copy-SafeFile \$nodeSource \$toolsRoot \$stageNode/);
  assert.match(runStage, /Copy-SafeFile \$workerSource \$toolsRoot \$stageWorker/);
  assert.match(runStage, /Copy-SafeFile \$probeContractSource \$toolsRoot \$stageProbeContract/);
  assert.match(runStage, /Copy-SafeFile \$stdioSmokeSource \$toolsRoot \$stageStdioSmoke/);
  assert.match(runStage, /profileRunTempWasEmptyBefore/);
  assert.doesNotMatch(runStage, /Set-ProbeAcl|SetAccessControl/);
  assert.match(cleanup, /Remove-SafeTree \$profileTempCanonical \$stageRoot/);
  assert.match(cleanup, /Test-SafePathAbsent \$profileTempCanonical \$stageRoot/);
  assert.match(cleanup, /profileRunStageCleanupVerified/);
  assert.match(cleanup, /profileRunTempCleanupVerified/);
  assert.match(source, /Get-ProfileRunDeleteDecision \$report\.profile_preexisted[\s\S]*?\$profileRunStagePathValidated[\s\S]*?\$profileRunTempWasEmptyBefore[\s\S]*?\$profileRunStageAbsentBefore[\s\S]*?\$profileRunStageCleanupVerified/);
  assert.match(source, /repositoryCanaryRoot = Join-Path \$repoRoot/);
  assert.match(source, /oracleCanaryRoot = Join-Path \$oracleCollectionRoot/);
  assert.match(source, /ownerProfileCanaryRoot = Get-OwnerProfileCanaryRoot \$ownerProfileCanaryCollectionRoot \$nonce/);
  assert.match(documentation, /agentcp-run-<nonce>[\s\S]*?profile's `AC\\Temp`/u);
  assert.match(documentation, /does not prove that[\s\S]*?pass G2\.2; the next full probe needs separate\s+owner authorization/u);
  assert.match(goals, /per-run nonce subtree of the newly created profile's `AC\\Temp`/);
});

test('full profile deletion requires validated path and preflight even before writes', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const helperStart = source.indexOf('function Get-ProfileRunDeleteDecision(');
  const helperEnd = source.indexOf('\nfunction Get-ProfileBootstrapDeleteDecision(', helperStart);
  const decisionStart = source.indexOf('$profileDeleteDecision = Get-ProfileRunDeleteDecision');
  const decisionEnd = source.indexOf('\n    } else {', decisionStart);
  const deleteProfile = source.indexOf('[AppContainerLauncher]::DeleteProfile($profileName)', decisionStart);
  const helper = source.slice(helperStart, helperEnd);
  const fullDecision = source.slice(decisionStart, decisionEnd);

  assert.ok(helperStart !== -1 && helperEnd > helperStart);
  assert.ok(decisionStart !== -1 && decisionEnd > decisionStart && deleteProfile > decisionEnd);
  assert.match(helper, /if \(-not \$ProfilePathResolved\)[\s\S]*?return 'PRESERVE_PROFILE_PATH_UNKNOWN'/);
  assert.match(helper, /if \(-not \$ProfileTempPathValidated\)[\s\S]*?return 'PRESERVE_TEMP_PATH_UNKNOWN'/);
  assert.match(helper, /ProfileTempWasEmptyBefore[\s\S]*?PRESERVE_TEMP_PREFLIGHT_UNKNOWN[\s\S]*?PRESERVE_TEMP_PREFLIGHT_FAILED/);
  assert.match(helper, /NonceStageAbsentBefore[\s\S]*?PRESERVE_STAGE_PREFLIGHT_UNKNOWN[\s\S]*?PRESERVE_STAGE_PREFLIGHT_FAILED/);
  assert.match(fullDecision, /profileRunStagePathValidated[\s\S]*profileRunTempWasEmptyBefore[\s\S]*profileRunStageAbsentBefore/);
  assert.match(source, /unresolvedProfileRunPathDecision -cne 'PRESERVE_PROFILE_PATH_UNKNOWN'/);
  assert.match(source, /unvalidatedProfileRunTempPathDecision -cne 'PRESERVE_TEMP_PATH_UNKNOWN'/);
  assert.match(source, /unvalidatedProfileRunTempDecision -cne 'PRESERVE_TEMP_PREFLIGHT_UNKNOWN'/);
  assert.match(source, /failedProfileRunPreflightDecision -cne 'PRESERVE_STAGE_PREFLIGHT_FAILED'/);
  assert.match(source, /syntheticUnvalidatedProfileRunSequence -contains 'delete-profile'/);
});

test('bootstrap staging ACL requires exact App SID rights and inheritance and always reports cleanup status', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  assert.match(source, /inheritance_value = \[int\]\$rule\.InheritanceFlags/);
  assert.match(source, /propagation_value = \[int\]\$rule\.PropagationFlags/);

  const exactStart = source.indexOf('function Test-ProfileBootstrapStagingAceExact(');
  const exactEnd = source.indexOf('\nfunction Get-ProfileBootstrapStagingAclStatus(', exactStart);
  const exactAceFunction = source.slice(exactStart, exactEnd);
  assert.ok(exactStart !== -1 && exactEnd > exactStart);
  assert.match(exactAceFunction, /app_sid_ace_count\s+-ne\s+1/);
  assert.match(exactAceFunction, /allowedRights\s*=\s*\$requestedRights\s+-bor\s+\[int\].*?::Synchronize/);
  assert.match(exactAceFunction, /requestedRightsPresent\s*=\s*\(\$observedRights\s+-band\s+\$requestedRights\)\s+-eq\s+\$requestedRights/);
  assert.match(exactAceFunction, /rightsWithinAllowlist\s*=\s*\(\$observedRights\s+-bor\s+\$allowedRights\)\s+-eq\s+\$allowedRights/);
  assert.match(exactAceFunction, /inherited\s+-eq\s+\$Inherited/);
  assert.match(exactAceFunction, /inheritance_value\s+-eq\s+\[int\]\$Inheritance/);
  assert.match(exactAceFunction, /propagation_value\s+-eq\s+\[int\]\$Propagation/);

  const statusStart = exactEnd;
  const statusEnd = source.indexOf('\nfunction Get-ProfileBootstrapStagingAclCleanupStatus(', statusStart);
  const statusFunction = source.slice(statusStart, statusEnd);
  assert.match(statusFunction, /label = 'stageRoot'[\s\S]*?rights = .*?::Traverse[\s\S]*?inherited = \$false[\s\S]*?inheritance = .*?::None/);
  assert.match(statusFunction, /label = 'toolsRoot'[\s\S]*?rights = .*?::ReadAndExecute[\s\S]*?inheritance = \$toolsInheritance/);
  assert.match(statusFunction, /label = 'stagedNode'[\s\S]*?inherited = \$true/);
  assert.match(statusFunction, /Test-ProfileBootstrapStagingAceExact/);
  assert.match(source, /syntheticBootstrapAclOverbroadDecision\s+-cne\s+'FAIL'/);
  assert.match(source, /syntheticBootstrapAclWrongToolsInheritanceDecision\s+-cne\s+'FAIL'/);
  assert.match(source, /syntheticBootstrapAclExplicitNodeDecision\s+-cne\s+'FAIL'/);
  assert.match(source, /syntheticBootstrapAclExtraAceDecision\s+-cne\s+'FAIL'/);
  assert.match(source, /syntheticBootstrapAclWithoutSynchronizeDecision\s+-cne\s+'PASS'/);
  assert.match(source, /syntheticTraverseRights\s*=[\s\S]*?::Traverse\s+-bor[\s\S]*?::Synchronize/);
  assert.match(source, /syntheticReadExecuteRights\s*=[\s\S]*?::ReadAndExecute\s+-bor[\s\S]*?::Synchronize/);

  const cleanupDecision = source.indexOf('$profileBootstrapStagingAclCleanupStatus = Get-ProfileBootstrapStagingAclCleanupStatus');
  const cleanupReport = source.indexOf('$report.observations.profile_bootstrap_diagnostic.staging_acl.cleanup_status =', cleanupDecision);
  const cleanupBlockStart = source.lastIndexOf('if ($ProfileBootstrapDiagnosticOnly) {', cleanupDecision);
  const cleanupBlockEnd = source.indexOf('\n    if (-not ($ProfileContractImportDiagnosticOnly', cleanupReport);
  const cleanupBlock = source.slice(cleanupBlockStart, cleanupBlockEnd);
  assert.ok(cleanupDecision !== -1 && cleanupReport > cleanupDecision && cleanupBlockEnd > cleanupReport);
  assert.match(cleanupBlock, /if \(\$null -ne \$profileBootstrapStagingAclObservation\) \{[\s\S]*?\}\s*\$report\.observations\.profile_bootstrap_diagnostic\.staging_acl\.cleanup_status/);
});

test('profile cleanup requires a bounded read-only HKCU mapping scan before and after deletion', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const documentation = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const scanStart = source.indexOf('function Get-AppContainerProfileMappingScan(');
  const pairSummaryStart = source.indexOf('function Get-ProfileMappingPairSummary(');
  const pairSummaryEnd = source.indexOf('\nfunction Get-AppContainerProfileMappingScan(', pairSummaryStart);
  const pairSummary = source.slice(pairSummaryStart, pairSummaryEnd);
  const preDecisionStart = source.indexOf('function Get-ProfileRegistrationPreDeleteDecision(', scanStart);
  const postDecisionStart = source.indexOf('function Get-ProfileRegistrationPostDeleteDecision(', preDecisionStart);
  const helperEnd = source.indexOf('\nfunction Ensure-SafeDirectory(', postDecisionStart);
  const mappingHelpers = source.slice(scanStart, helperEnd);
  const valueReaderStart = source.indexOf('function Get-ProfileMappingValueObservation(');
  const valueReaderEnd = scanStart;
  const valueReader = source.slice(valueReaderStart, valueReaderEnd);
  const registrationReportStart = source.indexOf('profile_registration = [ordered]@{');
  const registrationReportEnd = source.indexOf('\n        profile_bootstrap_diagnostic', registrationReportStart);
  const registrationReport = source.slice(registrationReportStart, registrationReportEnd);
  assert.ok(scanStart !== -1 && preDecisionStart > scanStart && postDecisionStart > preDecisionStart && helperEnd > postDecisionStart);
  assert.ok(pairSummaryStart !== -1 && pairSummaryEnd > pairSummaryStart);
  assert.ok(valueReaderStart !== -1 && valueReaderEnd > valueReaderStart);
  assert.ok(registrationReportStart !== -1 && registrationReportEnd > registrationReportStart);
  assert.match(source, /\$profileMappingRegistrySubKey\s*=\s*'Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings'/);
  assert.match(source, /\$profileMappingMaxDepth\s*=\s*4/);
  assert.match(source, /\$profileMappingMaxKeys\s*=\s*2048/);
  assert.match(mappingHelpers, /Registry\]::CurrentUser\.OpenSubKey\(\$profileMappingRegistrySubKey,\s*\$false\)/);
  assert.doesNotMatch(mappingHelpers, /GetSubKeyNames|\.SubKeyCount/);
  assert.match(valueReader, /ReadBoundedProfileMappingString\(\$Key,\s*\$ValueName\)/);
  assert.match(mappingHelpers, /Get-ProfileMappingValueObservation \$currentKey 'DisplayName'/);
  assert.match(mappingHelpers, /Get-ProfileMappingValueObservation \$currentKey 'Moniker'/);
  assert.doesNotMatch(mappingHelpers + valueReader, /Registry\]::LocalMachine|CreateSubKey|DeleteSubKey|DeleteValue|SetValue|GetValue\(|GetValueKind|GetValueNames|Get-ChildItem/);
  assert.match(mappingHelpers, /scan\.keys_visited -ge \$profileMappingMaxKeys/);
  assert.match(mappingHelpers, /BeginProfileMappingScanChangeMonitor\(\$root\)[\s\S]*?remainingKeys = \$profileMappingMaxKeys - \$scan\.keys_visited - \$pathStack\.Count/);
  assert.match(mappingHelpers, /failure_phase = 'NONE'[\s\S]*?failure_type = \$null[\s\S]*?failure_code = \$null/);
  for (const phase of ['ROOT', 'MONITOR', 'STACK', 'OPEN_CHILD', 'VALUE', 'ENUMERATE', 'STABILITY']) {
    assert.ok(mappingHelpers.includes(`$failurePhase = '${phase}'`), `missing scan failure phase ${phase}`);
  }
  assert.match(mappingHelpers, /\$failurePhase = 'ROOT'[\s\S]*?Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false[\s\S]*?\[Microsoft\.Win32\.Registry\]::CurrentUser\.OpenSubKey/);
  assert.match(mappingHelpers, /\$failurePhase = 'MONITOR'[\s\S]*?Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false[\s\S]*?\[AppContainerLauncher\]::BeginProfileMappingScanChangeMonitor/);
  assert.match(mappingHelpers, /\$failurePhase = 'STACK'\s+Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false\s+\$pathStack = \[System\.Collections\.Stack\]::new/);
  assert.match(mappingHelpers, /\$failurePhase = 'STACK'\s+Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false\s+\$relativePath = \[string\[\]\]\$pathStack\.Pop/);
  assert.match(mappingHelpers, /\$failurePhase = 'STACK'\s+Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false\s+\$pathStack\.Push/);
  assert.match(mappingHelpers, /\$failurePhase = 'OPEN_CHILD'\s+Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false\s+\$nextKey = \$currentKey\.OpenSubKey/);
  assert.match(mappingHelpers, /\$failurePhase = 'VALUE'[\s\S]*?Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false[\s\S]*?Get-ProfileMappingValueObservation \$currentKey 'DisplayName'/);
  assert.match(mappingHelpers, /\$failurePhase = 'ENUMERATE'[\s\S]*?Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false[\s\S]*?\[AppContainerLauncher\]::EnumerateProfileMappingChildName\(\$currentKey, 0\)/);
  assert.match(mappingHelpers, /\$failurePhase = 'ENUMERATE'[\s\S]*?Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false[\s\S]*?\[AppContainerLauncher\]::EnumerateProfileMappingChildName\(\$currentKey, \[uint32\]\$childIndex\)/);
  assert.match(mappingHelpers, /\$failurePhase = 'STABILITY'[\s\S]*?Invoke-ProfileMappingSelfTestFailure \$failurePhase \$false[\s\S]*?\[AppContainerLauncher\]::CheckProfileMappingScanStability/);
  assert.match(valueReader, /\$Scan\.status = 'UNKNOWN'[\s\S]*?\$Scan\.scan_complete = \$false[\s\S]*?\$Scan\.issue = 'READ_FAILED'[\s\S]*?\$Scan\.failure_phase = \$Phase/);
  assert.match(valueReader, /\$exceptionType -cin \$allowedExceptionTypes[\s\S]*?else \{ 'OTHER' \}/);
  assert.doesNotMatch(mappingHelpers + valueReader, /\$exception\.Message|\$exception\.StackTrace|\$exception\.ToString\(/);
  assert.match(source, /syntheticMappingPhases[\s\S]*?Get-AppContainerProfileMappingScan 'AgentCP0123456789abcdef0'[\s\S]*?syntheticMappingScan\.failure_phase[\s\S]*?Get-ProfileRegistrationPreDeleteDecision \$syntheticMappingScan[\s\S]*?Get-ProfileRegistrationPostDeleteDecision \$syntheticMappingScan/);
  assert.match(source, /syntheticUnknownMappingFailure\.failure_type -cne 'OTHER'/);
  assert.match(mappingHelpers, /for \(\$childIndex = 0; \$childIndex -le \$remainingKeys; \$childIndex\+\+\)/);
  assert.match(mappingHelpers, /EnumerateProfileMappingChildName[\s\S]*?ClassifyProfileMappingChildEnumerationResult/);
  assert.match(mappingHelpers, /CheckProfileMappingScanStability\(\$root, \$changeMonitor\)[\s\S]*?stability_status -ceq 'STABLE'[\s\S]*?scan_complete = \$true/);
  assert.match(mappingHelpers, /finally \{[\s\S]*?\$changeMonitor\.Dispose\(\)[\s\S]*?\$root\.Close\(\)/);
  assert.match(mappingHelpers, /finally \{[\s\S]*?\$currentKey\.Close\(\)/);
  assert.match(mappingHelpers, /complete_match_count \+= \[int\]\$pairSummary\.complete_match_count/);
  assert.match(mappingHelpers, /partial_match_count \+= \[int\]\$pairSummary\.partial_match_count/);
  assert.match(mappingHelpers, /malformed_value_count \+= \[int\]\$pairSummary\.malformed_value_count/);
  assert.match(pairSummary, /StringComparison\]::Ordinal/);
  assert.match(pairSummary, /StringComparison\]::OrdinalIgnoreCase/);
  assert.match(mappingHelpers, /function Get-ProfileRegistrationPreDeleteDecision[\s\S]*?\$identityCount -ne 1[\s\S]*?return 'PASS'/);
  assert.match(mappingHelpers, /function Get-ProfileRegistrationPostDeleteDecision[\s\S]*?complete_match_count -gt 0[\s\S]*?case_only_pair_count -gt 0[\s\S]*?partial_match_count -gt 0[\s\S]*?return 'PASS'/);
  const preScanPosition = source.indexOf('$profileRegistrationPreDeleteScan = Get-AppContainerProfileMappingScan $profileName');
  const deleteProfilePosition = source.indexOf('[AppContainerLauncher]::DeleteProfile($profileName)', preScanPosition);
  const postScanPosition = source.indexOf('$profileRegistrationPostDeleteScan = Get-AppContainerProfileMappingScan $profileName', deleteProfilePosition);
  assert.ok(preScanPosition !== -1 && deleteProfilePosition > preScanPosition && postScanPosition > deleteProfilePosition);
  assert.match(source.slice(preScanPosition, deleteProfilePosition), /profileRegistrationPreDeleteDecision -cne 'PASS'[\s\S]*?PRESERVE_REGISTRATION_UNKNOWN/);
  assert.match(source, /null -ne \$stageAbsent -and \$stageAbsent -and[\s\S]{0,180}\$profileRegistrationCleanupStatus -ceq 'PASS'/);
  assert.match(source, /profile_registration = \[ordered\]@\{[\s\S]*?pre_delete_scan[\s\S]*?post_delete_scan[\s\S]*?cleanup_status/);
  assert.doesNotMatch(registrationReport, /DisplayName|Moniker|registry_key_path|registry_value|key_names/);
  for (const testCase of [
    'mappingPreOneDecision', 'mappingPreNoneDecision', 'mappingPrePartialDecision',
    'mappingPreDuplicateDecision', 'mappingPreUnknownDecision', 'mappingPreMalformedDecision', 'mappingPreUnstableDecision',
    'mappingPostNoneDecision', 'mappingPostOneDecision', 'mappingPostPartialDecision',
    'mappingPostDuplicateDecision', 'mappingPostUnknownDecision', 'mappingPostMalformedDecision', 'mappingPostUnstableDecision',
    'mappingChildAtBudget', 'mappingChildHighFanout', 'mappingChildEnd', 'mappingChildUnknown',
    'mappingScanStable', 'mappingScanChangedCount', 'mappingScanChangedLastWrite',
    'mappingScanNotified', 'mappingScanQueryFailed',
  ]) {
    assert.ok(source.includes(testCase), `missing synthetic registration decision case ${testCase}`);
  }
  const boundedReaderStart = launcher.indexOf('public static BoundedRegistryStringValueResult ReadBoundedProfileMappingString(');
  const boundedReaderEnd = launcher.indexOf('\n    private static bool IsAsciiDriveLetter(', boundedReaderStart);
  const boundedReader = launcher.slice(boundedReaderStart, boundedReaderEnd);
  const childEnumeratorStart = launcher.indexOf('public static BoundedRegistryKeyNameResult EnumerateProfileMappingChildName(');
  const childEnumeratorEnd = launcher.indexOf('\n    public static ProfileMappingScanChangeMonitor BeginProfileMappingScanChangeMonitor(', childEnumeratorStart);
  const childEnumerator = launcher.slice(childEnumeratorStart, childEnumeratorEnd);
  assert.ok(boundedReaderStart !== -1 && boundedReaderEnd > boundedReaderStart);
  assert.ok(childEnumeratorStart !== -1 && childEnumeratorEnd > childEnumeratorStart);
  assert.match(launcher, /MAX_PROFILE_MAPPING_VALUE_BYTES = 512/);
  assert.match(launcher, /ClassifyProfileMappingValueSizeProbe/);
  assert.match(launcher, /ClassifyProfileMappingValueRead/);
  assert.match(boundedReader, /safeKeyHandle\.DangerousGetHandle\(\)[\s\S]*?RegQueryValueEx\(keyHandle[\s\S]*?initialByteCount/);
  assert.match(boundedReader, /sizeStatus != "READY"[\s\S]*?byte\[length\]/);
  assert.match(boundedReader, /firstStatus = RegQueryValueEx[\s\S]*?secondStatus = RegQueryValueEx/);
  assert.match(boundedReader, /firstData\[index\] != secondData\[index\]/);
  assert.match(boundedReader, /valueName != "DisplayName" && valueName != "Moniker"/);
  assert.match(launcher, /EntryPoint = "RegEnumKeyExW"/);
  assert.match(launcher, /MAX_PROFILE_MAPPING_KEY_NAME_CHARS = 256/);
  assert.match(childEnumerator, /new StringBuilder\(MAX_PROFILE_MAPPING_KEY_NAME_CHARS\)[\s\S]*?ERROR_NO_MORE_ITEMS[\s\S]*?status != ERROR_SUCCESS/);
  assert.match(launcher, /EntryPoint = "RegQueryInfoKeyW"/);
  assert.match(launcher, /EntryPoint = "RegNotifyChangeKeyValue"/);
  assert.match(launcher, /REG_NOTIFY_CHANGE_NAME \| REG_NOTIFY_CHANGE_LAST_SET/);
  assert.match(launcher, /RegNotifyChangeKeyValue\(keyHandle, true,[\s\S]*?monitor\.EventHandle, true\)/);
  assert.match(launcher, /RegNotifyChangeKeyValue\(keyHandle[\s\S]*?QueryProfileMappingKeyInfo\(keyHandle/);
  assert.match(childEnumerator, /DangerousAddRef[\s\S]*?RegEnumKeyEx[\s\S]*?DangerousRelease/);
  assert.match(launcher, /ClassifyProfileMappingScanStability[\s\S]*?notificationWaitStatus != WAIT_TIMEOUT[\s\S]*?beforeSubKeyCount != afterSubKeyCount[\s\S]*?beforeLastWriteTime != afterLastWriteTime/);
  assert.match(source, /mappingChildHighFanout[\s\S]*?mappingScanStable[\s\S]*?mappingScanChangedCount[\s\S]*?mappingValueOversize[\s\S]*?mappingValueReadChangedSize/);
  assert.match(source, /mappingChildHighFanout -cne 'KEY_LIMIT'/);
  assert.match(source, /mappingScanStable -cne 'STABLE'/);
  assert.match(source, /mappingScanChangedCount -cne 'UNKNOWN'/);
  assert.match(source, /mappingValueOversize -cne 'UNKNOWN'/);
  assert.match(source, /mappingValueReadChangedSize -cne 'UNKNOWN'/);
  assert.match(documentation, /HKCU AppContainer Mappings[\s\S]*?DisplayName` and `Moniker[\s\S]*?caps traversal at four levels and 2,048[\s\S]*?keys[\s\S]*?stable scan for this Windows layout, not a public registry schema[\s\S]*?contract[\s\S]*?omit registry key names and[\s\S]*?values/u);
});

test('process-token-chain diagnostic is bounded, read-only, and redacts identifiers', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const modeStart = source.indexOf('\nif ($ProcessTokenChainDiagnosticOnly) {') + 1;
  const modeEnd = source.indexOf('\nif ($ProfileMappingReadOnlyDiagnosticOnly) {', modeStart);
  const mode = source.slice(modeStart, modeEnd);
  const selfTestStart = source.indexOf('\nif ($SelfTest) {');
  const selfTestEnd = source.indexOf('\nif ($ProfilePathResolveDiagnosticOnly) {', selfTestStart);
  const selfTest = source.slice(selfTestStart, selfTestEnd);
  const syntheticStart = launcher.indexOf('public static ProcessTokenChainDiagnosticResult ProcessTokenChainSyntheticSelfTest()');
  const syntheticEnd = launcher.indexOf('\n    private static ProcessTokenChainDiagnosticResult BuildProcessTokenChainDiagnostic', syntheticStart);
  const synthetic = launcher.slice(syntheticStart, syntheticEnd);
  const rowStart = launcher.indexOf('public sealed class ProcessTokenChainDiagnosticRow');
  const resultStart = launcher.indexOf('public sealed class ProcessTokenChainDiagnosticResult', rowStart);
  const rowType = launcher.slice(rowStart, resultStart);
  const resultEnd = launcher.indexOf('\npublic sealed class BoundedRegistryStringValueResult', resultStart);
  const resultType = launcher.slice(resultStart, resultEnd);

  assert.match(source, /\[switch\]\$ProcessTokenChainDiagnosticOnly/);
  assert.match(source, /if \(\$ProcessTokenChainDiagnosticOnly -and[\s\S]*?MODE_CONFLICT/);
  assert.ok(modeStart !== -1 && modeEnd > modeStart);
  assert.ok(modeStart < source.indexOf('\nif ($ProfileMappingReadOnlyDiagnosticOnly) {'));
  assert.ok(modeStart < source.indexOf('\nif ($SelfTest) {'));
  assert.ok(modeStart < source.indexOf('\ntry {\n    if ([Environment]::OSVersion'));
  assert.match(mode, /Read-ValidatedSource[\s\S]*?Add-Type[\s\S]*?ReadProcessTokenChainDiagnostic\(\)/);
  assert.match(mode, /schema_version = 1[\s\S]*?status = 'UNKNOWN'[\s\S]*?stage = 'PROCESS_SNAPSHOT'[\s\S]*?truncated = \$false[\s\S]*?processes = @\(\)/);
  assert.match(mode, /ConvertTo-Json -InputObject \$safeResult -Depth 5 -Compress/);
  assert.match(mode, /GetByteCount\(\$json\) -gt 4096/);
  assert.doesNotMatch(mode, /IsCurrentProcessFullTrust|CreateProfile\(|DeleteProfile\(|Registry|Ensure-SafeDirectory|WriteAllText|Set-ProbeAcl|RunNode\(|RunProfile|probeListener|ollama|model/);
  assert.match(source, /\$ownerProfileCanaryCollectionRoot = if \(\$ProcessTokenChainDiagnosticOnly\) \{ \$null \}/);
  assert.match(source, /function Get-OwnerProfileCanaryRoot\(\$CollectionRoot, \[string\]\$Nonce\) \{\s*if \(\$null -eq \$CollectionRoot\) \{ return \$null \}[\s\S]*?Join-Path \$CollectionRoot/);
  assert.match(source, /\$ownerProfileCanaryRoot = Get-OwnerProfileCanaryRoot \$ownerProfileCanaryCollectionRoot \$nonce/);
  assert.ok(selfTestStart !== -1 && selfTestEnd > selfTestStart);
  assert.ok(selfTest.includes("$syntheticNullOwnerProfileCanaryRoot = Get-OwnerProfileCanaryRoot $null 'synthetic-nonce'"));
  assert.ok(selfTest.includes("'C:\\Users\\SyntheticOwner\\AppData\\Local' 'synthetic-nonce'"));
  assert.ok(selfTest.includes("$syntheticOwnerProfileCanaryRoot -cne 'C:\\Users\\SyntheticOwner\\AppData\\Local\\.appcontainer-probe-synthetic-nonce'"));

  assert.ok(rowStart !== -1 && resultStart > rowStart && resultEnd > resultStart);
  assert.deepEqual([...rowType.matchAll(/public (?:int|string) ([a-z_]+) \{ get; set; \}/gu)].map((match) => match[1]), [
    'depth', 'link_status', 'token_is_appcontainer', 'appcontainer_sid_presence', 'package_identity',
  ]);
  assert.deepEqual([...resultType.matchAll(/public (?:int|string|bool|ProcessTokenChainDiagnosticRow\[\]) ([a-z_]+) \{ get; set; \}/gu)].map((match) => match[1]), [
    'schema_version', 'status', 'stage', 'truncated', 'processes',
  ]);
  assert.match(launcher, /MAX_PROCESS_CHAIN_ENTRIES = 4096/);
  assert.match(launcher, /MAX_PROCESS_CHAIN_ENUMERATION = 4097/);
  assert.match(launcher, /MAX_PROCESS_CHAIN_ANCESTORS = 8/);
  assert.match(launcher, /OpenProcess\(PROCESS_QUERY_LIMITED_INFORMATION, false, processId\)/);
  assert.match(launcher, /OpenProcessToken\(process, TOKEN_QUERY, out token\)/);
  assert.match(launcher, /GetProcessTimes\(process,[\s\S]*?creationTime/);
  assert.match(launcher, /GetPackageFamilyName\(process, ref packageNameLength, IntPtr\.Zero\)/);
  assert.match(launcher, /packageStatus == ERROR_INSUFFICIENT_BUFFER[\s\S]*?"PRESENT"[\s\S]*?packageStatus == APPMODEL_ERROR_NO_PACKAGE[\s\S]*?"NO_PACKAGE"/);
  assert.match(launcher, /CreateToolhelp32Snapshot\(TH32CS_SNAPPROCESS, 0\)/);
  assert.match(launcher, /Process32Next\(snapshot, ref entry\)/);
  assert.match(launcher, /expectedCreationTime\.HasValue[\s\S]*?evidence\.CreationTime != expectedCreationTime\.Value/);
  assert.match(launcher, /parentCreationTime >= evidence\.CreationTime/);
  assert.match(launcher, /TOKEN_APPCONTAINER_INFORMATION[\s\S]*?information\.TokenAppContainer == IntPtr\.Zero \? "ABSENT" : "PRESENT"/);
  assert.match(launcher, /NormalizeProcessTokenChainStage[\s\S]*?"PROCESS_SNAPSHOT", "PROCESS_ENUMERATION", "ANCESTRY_LINK"[\s\S]*?"TOKEN_SID", "PACKAGE_IDENTITY", "COMPLETE"/);
  assert.match(launcher, /NormalizeProcessTokenChainLinkStatus[\s\S]*?"ROOT" \|\| value == "VERIFIED" \|\| value == "TRUNCATED" \|\| value == "UNKNOWN"/);
  assert.ok(syntheticStart !== -1 && syntheticEnd > syntheticStart);
  assert.match(synthetic, /valid-chain/);
  assert.match(synthetic, /missing-parent/);
  assert.match(synthetic, /duplicate-id/);
  assert.match(synthetic, /cycle/);
  assert.match(synthetic, /creation-time-mismatch/);
  assert.match(synthetic, /pid-reuse-between-link-and-inspection/);
  assert.match(synthetic, /ancestor-cap/);
  assert.match(synthetic, /query-failure/);
  assert.match(synthetic, /result-redaction/);
  assert.doesNotMatch(synthetic, /Win32ProcessTokenChainSource|OpenProcess\(|OpenProcessToken\(|GetTokenInformation\(|CreateToolhelp32Snapshot\(|GetPackageFamilyName\(/);
  assert.match(source, /ProcessTokenChainSyntheticSelfTest\(\)[\s\S]*?tokenChainSyntheticJson[\s\S]*?424242\|313131\|S-1-/);
});

test('process-token guidance scopes diagnostic-child invocation and profile blocking', async () => {
  const { readFile } = await import('node:fs/promises');
  const documentation = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  const archivedGoals = await readFile(new URL('../../dev/goals-archive/goals-11-sample-the-powershell-diagnostic-child-before-retrying-profile-diagnostics.md', import.meta.url), 'utf8');
  const sectionStart = documentation.indexOf('### Process-token chain diagnostic');
  const sectionEnd = documentation.indexOf('\nRun this mode only after the separate owner approval for writing', sectionStart);
  assert.ok(sectionStart !== -1 && sectionEnd > sectionStart);
  const section = documentation.slice(sectionStart, sectionEnd).replace(/\s+/gu, ' ');
  const sampleTitle = '**G11.3 [MANUAL] Collect one diagnostic-child token sample without profile effects.**';
  const interpretationTitle = '**G11.4 [MANUAL] Interpret only the diagnostic-child guard input.**';
  const profileSampleTitle = '**G11.5 [MANUAL] Run one separately authorized fresh profile-path diagnostic.**';
  const sampleTitleIndex = archivedGoals.indexOf(sampleTitle);
  const interpretationTitleIndex = archivedGoals.indexOf(interpretationTitle);
  const profileSampleTitleIndex = archivedGoals.indexOf(profileSampleTitle);
  assert.ok(sampleTitleIndex !== -1 && interpretationTitleIndex > sampleTitleIndex && profileSampleTitleIndex > interpretationTitleIndex);
  const sampleStart = archivedGoals.lastIndexOf('- [', sampleTitleIndex);
  const interpretationStart = archivedGoals.lastIndexOf('- [', interpretationTitleIndex);
  const sampleEnd = archivedGoals.indexOf('\n- [', sampleStart);
  const interpretationEnd = archivedGoals.indexOf('\n- [', interpretationStart);
  const sample = archivedGoals.slice(sampleStart, sampleEnd).replace(/\s+/gu, ' ');
  const interpretation = archivedGoals.slice(interpretationStart, interpretationEnd).replace(/\s+/gu, ' ');
  const profileSampleStart = archivedGoals.lastIndexOf('- [', profileSampleTitleIndex);
  const profileSampleEnd = archivedGoals.indexOf('\n- [', profileSampleStart);
  const profileSample = archivedGoals.slice(profileSampleStart, profileSampleEnd).replace(/\s+/gu, ' ');

  assert.match(section, /ordinary interactive Windows PowerShell 5\.1 session outside the managed Codex shell/u);
  assert.match(section, /powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \.\\bench\\isolation\\run-probes\.ps1 -ProcessTokenChainDiagnosticOnly/u);
  assert.match(section, /This starts a noninteractive PowerShell child/u);
  assert.match(section, /`processes\[0\]` is that diagnostic child, not the already-open interactive parent/u);
  assert.match(section, /same child-launch form intended for the separate profile-path diagnostic/u);
  assert.match(section, /Do not assume their tokens are equivalent/u);
  assert.doesNotMatch(section, /Set-ExecutionPolicy|& \.\\bench\\isolation\\run-probes\.ps1/u);
  assert.match(section, /The first row, `processes\[0\]`, represents the diagnostic child process/u);
  assert.match(section, /Use only `processes\[0\]\.token_is_appcontainer`/u);
  assert.match(section, /`TRUE` or `UNKNOWN` blocks profile operations/u);
  assert.match(section, /`FALSE` means only that this diagnostic child's process token was not identified as AppContainer/u);
  assert.match(section, /does not prove the parent shell's token, general full trust, or the token of an earlier invocation/u);
  assert.match(section, /overall `status: UNKNOWN` may result from an ancestor link even when the depth-zero token field is known, so it does not invalidate that field/u);
  assert.match(section, /A `FALSE` result only makes a separately authorized next diagnostic eligible for consideration; it neither proves the token of that later child nor authorizes it/u);
  assert.match(section, /The profile-path diagnostic must pass its own guard/u);
  assert.match(sample, /Run `powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \.\\bench\\isolation\\run-probes\.ps1 -ProcessTokenChainDiagnosticOnly` once/u);
  assert.match(sample, /`processes\[0\]` describes that diagnostic child, not the interactive parent/u);
  assert.match(sample, /same child-launch form intended for the separate G11\.5 profile-path diagnostic/u);
  assert.match(sample, /do not assume token equivalence/u);
  assert.doesNotMatch(sample, /Set-ExecutionPolicy|& \.\\bench\\isolation\\run-probes\.ps1/u);
  assert.match(interpretation, /Record only `processes\[0\]\.token_is_appcontainer` for the diagnostic child/u);
  assert.match(interpretation, /A `FALSE` result makes a separately authorized G11\.5 attempt eligible for consideration only/u);
  assert.match(interpretation, /does not prove the token of that later child and does not authorize it/u);
  assert.match(interpretation, /G11\.5 requires fresh owner authorization and its own guard/u);
  assert.match(profileSample, /G11\.3 sample does not prove that child's token/u);
  assert.match(profileSample, /This starts a separate child process whose own guard determines whether the profile diagnostic proceeds/u);
});

test('read-only profile diagnostic is bounded, sanitized, and precedes probe effects', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const modeStart = source.indexOf('if ($ProfileMappingReadOnlyDiagnosticOnly) {');
  const selfTestStart = source.indexOf('\nif ($SelfTest) {', modeStart);
  const mode = source.slice(modeStart, selfTestStart);
  const idStart = source.indexOf('function Test-ProfileMappingReadOnlyProfileId(');
  const idEnd = source.indexOf('\nfunction Get-ProfileMappingReadOnlyFailureMetadata(', idStart);
  const idValidation = source.slice(idStart, idEnd);
  const candidateStart = source.indexOf('function Get-ProfileMappingCandidatePath(');
  const candidateEnd = source.indexOf('\nfunction Invoke-ProfileMappingReadOnlyObservations(', candidateStart);
  const candidatePath = source.slice(candidateStart, candidateEnd);
  const coordinatorStart = source.indexOf('function Invoke-ProfileMappingReadOnlyObservations(');
  const coordinatorEnd = source.indexOf('\nfunction Convert-ProfileMappingReadOnlyOutput(', coordinatorStart);
  const coordinator = source.slice(coordinatorStart, coordinatorEnd);
  const outputStart = coordinatorEnd;
  const outputEnd = source.indexOf('\nfunction ConvertTo-ProfileMappingReadOnlyJson(', outputStart);
  const output = source.slice(outputStart, outputEnd);
  const pairSummaryStart = source.indexOf('function Get-ProfileMappingPairSummary(');
  const pairSummaryEnd = source.indexOf('\nfunction Set-ProfileMappingScanException(', pairSummaryStart);
  const pairSummary = source.slice(pairSummaryStart, pairSummaryEnd);
  const apiStart = launcher.indexOf('public static ProfileMappingReadOnlyResult ObserveProfileMappingReadOnly(');
  const apiEnd = launcher.indexOf('\n    public static bool ProfileSidMatchesName(', apiStart);
  const api = launcher.slice(apiStart, apiEnd);
  assert.ok(modeStart !== -1 && selfTestStart > modeStart && idStart !== -1 && idEnd > idStart);
  assert.ok(candidateStart !== -1 && candidateEnd > candidateStart && coordinatorStart !== -1 && coordinatorEnd > coordinatorStart);
  assert.ok(outputEnd > outputStart && pairSummaryStart !== -1 && pairSummaryEnd > pairSummaryStart);
  assert.ok(apiStart !== -1 && apiEnd > apiStart);
  assert.match(idValidation, /Length -ne 24[\s\S]*?\\AAgentCP\[0-9a-f\]\{17\}\\z/);
  assert.match(source, /ProfileMappingReadOnlyProfileId[\s\S]*?MODE_REQUIRED/);
  assert.match(mode, /\$SelfTest -or \$PreflightOnly -or \$ProtocolSmokeOnly/);
  assert.match(mode, /\$ProfileContractImportDiagnosticOnly -or \$ProfileBootstrapDiagnosticOnly/);
  assert.match(mode, /Test-ProfileMappingReadOnlyProfileId[\s\S]*?Read-ValidatedSource[\s\S]*?IsCurrentProcessFullTrust\(\)[\s\S]*?Invoke-ProfileMappingReadOnlyObservations[\s\S]*?Get-AppContainerProfileMappingScan[\s\S]*?Get-ProfileMappingCandidatePathObservation/);
  assert.doesNotMatch(mode, /appcontainer-probe-report\.json|Read-ProfileMappingReportId|reportPath/);
  assert.match(mode, /catch \{[\s\S]*?DIAGNOSTIC_FAILED[\s\S]*?exit 1/);
  assert.doesNotMatch(mode, /CreateProfile\(|DeleteProfile\(|Ensure-SafeDirectory|Set-ProbeAcl|RunNode\(|WriteAllText/);
  assert.match(coordinator, /try \{ \$api = & \$ApiOperation \}[\s\S]*?try \{ \$scan = & \$RegistryOperation \}[\s\S]*?try \{ \$candidate = & \$CandidateOperation \}/);
  assert.match(candidatePath, /Get-CanonicalLocalDrivePath[\s\S]*?Packages\\' \+ \$ProfileName \+ '\\AC[\s\S]*?\[System\.IO\.File\]::GetAttributes[\s\S]*?ReparsePoint/);
  assert.doesNotMatch(candidatePath, /Get-ChildItem|Enumerate|Get-Content|ReadAllText|OpenRead|Directory\.GetFiles|Directory\.Enumerate/);
  assert.match(source, /function Get-AppContainerProfileMappingScan\(\[string\]\$ProfileName, \[switch\]\$ReadOnlyDetails\)[\s\S]*?if \(\$ReadOnlyDetails\)[\s\S]*?display_name_exact_match_count/);
  assert.match(mode, /Get-AppContainerProfileMappingScan \$diagnosticProfileName -ReadOnlyDetails/);
  assert.match(output, /display_name_exact_match_count[\s\S]*?display_name_case_only_match_count[\s\S]*?moniker_exact_match_count[\s\S]*?moniker_case_only_match_count[\s\S]*?candidate_path/);
  assert.match(pairSummary, /display_name_exact_match_count[\s\S]*?display_name_case_only_match_count[\s\S]*?moniker_exact_match_count[\s\S]*?moniker_case_only_match_count/);
  assert.match(source, /syntheticDefaultScan[\s\S]*?exposed read-only detail fields/);
  assert.match(source, /foreach \(\$blockKind in @\('ABSENT', 'NOT_DIRECTORY', 'REPARSE_POINT', 'INACCESSIBLE'\)\)/);
  assert.match(source, /Synthetic API failure suppressed independent read-only observations/);
  assert.match(api, /DeriveAppContainerSidFromAppContainerName[\s\S]*?ConvertSidToStringSid[\s\S]*?GetAppContainerFolderPath/);
  assert.match(api, /finally[\s\S]*?CoTaskMemFree\(path\)[\s\S]*?LocalFree\(sidText\)[\s\S]*?FreeSid\(sid\)/);
  assert.doesNotMatch(api, /CreateProfile\(|DeleteProfile\(|CreateDirectory|SetAccessControl/);
  assert.match(source, /syntheticProfileId[\s\S]*?Test-ProfileMappingReadOnlyProfileId[\s\S]*?invalidProfileId/);
  assert.match(source, /syntheticOutputJson\.Contains\('Synthetic private'\)[\s\S]*?syntheticOutputJson\.Contains\('AgentCP0123456789abcdef0'\)/);
  assert.match(source, /OUTPUT_LIMIT/);
});

test('profile path failures use fixed stages and preserve redacted diagnostics', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const pathMethodStart = launcher.indexOf('private static string GetProfileLocalAppDataPath(string profileSid, string profileName)');
  const pathMethodEnd = launcher.indexOf('\n    public static string GetProfilePath(', pathMethodStart);
  const getProfilePathStart = pathMethodEnd;
  const getProfilePathEnd = launcher.indexOf('\n    public static bool IsCurrentProcessFullTrust()', getProfilePathStart);
  const diagnosticStart = source.indexOf('function Get-ProfilePathStage($Exception) {');
  const diagnosticEnd = source.indexOf('\nfunction Set-Diagnostic(', diagnosticStart);
  const selfTestStart = source.indexOf('if ($SelfTest) {');
  const selfTestEnd = source.indexOf('\n}\n\ntry {', selfTestStart);
  const selfTest = source.slice(selfTestStart, selfTestEnd);
  const stages = ['NONCE', 'SID_NAME', 'API', 'CANONICAL', 'SUFFIX', 'REPARSE'];

  assert.ok(pathMethodStart !== -1 && pathMethodEnd > pathMethodStart);
  assert.ok(getProfilePathEnd > getProfilePathStart);
  assert.ok(diagnosticStart !== -1 && diagnosticEnd > diagnosticStart);
  assert.ok(selfTestStart !== -1 && selfTestEnd > selfTestStart);
  const pathMethod = launcher.slice(pathMethodStart, pathMethodEnd);
  const getProfilePath = launcher.slice(getProfilePathStart, getProfilePathEnd);
  for (const stage of stages) {
    assert.match(launcher, new RegExp(`RunProfilePathStage(?:<object>)?\\("${stage}"`));
  }
  assert.match(getProfilePath, /RunProfilePathStage<object>\("NONCE"[\s\S]*?ValidateProfileNameForNonce/);
  assert.match(pathMethod, /RunProfilePathStage<object>\("SID_NAME"[\s\S]*?ValidateGeneratedProfileName/);
  assert.match(pathMethod, /RunProfilePathStage\("API"[\s\S]*?GetAppContainerFolderPath/);
  assert.match(pathMethod, /RunProfilePathStage\("CANONICAL"[\s\S]*?GetCanonicalLocalDrivePath/);
  assert.match(pathMethod, /RunProfilePathStage<object>\("SUFFIX"[\s\S]*?EndsWith/);
  assert.match(pathMethod, /RunProfilePathStage\("REPARSE"[\s\S]*?EnsureNoReparsePointsInPath/);
  assert.match(launcher, /exception\.Data\["profile_path_stage"\] = stage;[\s\S]*?throw;/);
  assert.match(source, /\$currentPhase = 'profile-create'[\s\S]*?CreateProfile\(\$profileName\)[\s\S]*?\$profileCreated = \$true[\s\S]*?\$currentPhase = 'profile-path-resolve'[\s\S]*?GetProfilePath\(/);
  assert.match(source.slice(diagnosticStart, diagnosticEnd), /NONCE[\s\S]*?REPARSE[\s\S]*?return 'UNKNOWN'/);
  assert.match(source.slice(diagnosticEnd, source.indexOf('\nfunction Test-ExceptionDataFlag', diagnosticEnd)), /profile_path_stage = Get-ProfilePathStage \$exception/);
  assert.match(source.slice(source.indexOf('function Set-PhaseDiagnostic'), selfTestStart), /profile_path_stage = 'UNKNOWN'/);
  assert.match(selfTest, /CreateProfilePathStageSelfTestException[\s\S]*?Set-Diagnostic[\s\S]*?syntheticMalformedStageRecord/);
  assert.match(selfTest, /profile_path_stage -cne 'UNKNOWN'[\s\S]*?Contains\('AgentCP0123456789abcdef0'\)/);
  assert.match(selfTest, /syntheticAbsentStageRecord[\s\S]*?Set-Diagnostic[\s\S]*?profile_path_stage -cne 'UNKNOWN'[\s\S]*?Contains\('Synthetic private'\)/);
  assert.equal((source.match(/CreateProfilePathStageSelfTestException\(/g) ?? []).length, 1);
});

test('profile packages-root components compare ordinal-ignore-case with strict path guards', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const helperStart = source.indexOf('function Test-OrdinalIgnoreCasePathComponent(');
  const helperEnd = source.indexOf('\nfunction Get-AppContainerProfilePackagesRoot(', helperStart);
  const rootStart = helperEnd;
  const rootEnd = source.indexOf('\nfunction Get-ProfileContractStagePaths(', rootStart);
  const contractPathsStart = rootEnd;
  const runPathsStart = source.indexOf('\nfunction Get-ProfileRunStagePaths(', contractPathsStart);
  const selfTestStart = source.indexOf('if ($SelfTest) {');
  const selfTestEnd = source.indexOf('\n}\n\ntry {', selfTestStart);

  assert.ok(helperStart !== -1 && helperEnd > helperStart);
  assert.ok(rootStart !== -1 && rootEnd > rootStart);
  assert.ok(contractPathsStart !== -1 && runPathsStart > contractPathsStart);
  assert.ok(selfTestStart !== -1 && selfTestEnd > selfTestStart);
  const helper = source.slice(helperStart, helperEnd);
  const root = source.slice(rootStart, rootEnd);
  const contractPaths = source.slice(contractPathsStart, runPathsStart);
  const runPathsEnd = source.indexOf('\nfunction ', runPathsStart + 1);
  const runPaths = source.slice(runPathsStart, runPathsEnd);
  const selfTest = source.slice(selfTestStart, selfTestEnd);

  assert.match(helper, /\[string\]::Equals\(\$Actual, \$Expected, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(root, /\$ProfileName -cnotmatch '\^AgentCP\[0-9a-f\]\{17\}\$'/);
  assert.match(root, /Get-CanonicalLocalDrivePath \$ProfilePath 'AppContainer profile API path'/);
  assert.match(root, /EndsWith\(\$expectedSuffix, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(root, /Test-OrdinalIgnoreCasePathComponent \$profileDirectory\.Name 'AC'/);
  assert.match(root, /Test-OrdinalIgnoreCasePathComponent \$profileDirectory\.Parent\.Name \$ProfileName/);
  assert.match(root, /Test-OrdinalIgnoreCasePathComponent \$profileDirectory\.Parent\.Parent\.Name 'Packages'/);
  assert.doesNotMatch(root, /\.Name -cne/);
  assert.match(root, /Assert-NoReparsePath \$profileDirectory\.Parent\.Parent\.FullName/);
  assert.match(contractPaths, /\$ProfileName -cne \('AgentCP' \+ \$Nonce\.Substring\(0, 17\)\)/);
  assert.match(contractPaths, /Assert-ChildPath \$packagesRoot \$canonicalProfile/);
  assert.match(runPaths, /\$ProfileName -cne \('AgentCP' \+ \$Nonce\.Substring\(0, 17\)\)/);
  assert.match(runPaths, /Assert-ChildPath \$packagesRoot \$canonicalProfile/);
  assert.match(selfTest, /profilePackagesRootComparisonCases = @\([\s\S]*?Actual = 'AC'; Expected = 'AC'; Matches = \$true[\s\S]*?Actual = 'ac'; Expected = 'AC'; Matches = \$true[\s\S]*?Actual = 'Unexpected'; Expected = 'AC'; Matches = \$false[\s\S]*?Test-OrdinalIgnoreCasePathComponent/);
});

test('fresh-profile transaction safety contract uses synthetic callbacks in SelfTest', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const transactionStart = source.indexOf('function Invoke-ProfilePathResolveTransaction(');
  const transactionEnd = source.indexOf('\nfunction Invoke-ProfilePathResolveDiagnosticMode', transactionStart);
  const deleteDecisionStart = source.indexOf('function Get-ProfilePathDiagnosticDeleteDecision(');
  const deleteDecisionEnd = source.indexOf('\nfunction Get-ProfilePathDiagnosticCleanupStatus', deleteDecisionStart);
  const modeStart = transactionEnd;
  const modeEnd = source.indexOf('\nif ($ProfileMappingReadOnlyDiagnosticOnly)', modeStart);
  const selfTestStart = source.indexOf('\nif ($SelfTest) {');
  const selfTestEnd = source.indexOf('\n}\n\nif ($ProfilePathResolveDiagnosticOnly)', selfTestStart);
  const selfTest = source.slice(selfTestStart, selfTestEnd);
  const syntheticStart = selfTest.indexOf('# G8.2 synthetic transaction contract: begin');
  const syntheticEnd = selfTest.indexOf('# G8.2 synthetic transaction contract: end', syntheticStart);

  assert.ok(transactionStart !== -1 && transactionEnd > transactionStart);
  assert.ok(deleteDecisionStart !== -1 && deleteDecisionEnd > deleteDecisionStart);
  assert.ok(modeEnd > modeStart);
  assert.ok(selfTestStart !== -1 && selfTestEnd > selfTestStart);
  assert.ok(syntheticStart !== -1 && syntheticEnd > syntheticStart);
  const transaction = source.slice(transactionStart, transactionEnd);
  const deleteDecision = source.slice(deleteDecisionStart, deleteDecisionEnd);
  const mode = source.slice(modeStart, modeEnd);
  const synthetic = selfTest.slice(syntheticStart, syntheticEnd);

  for (const operation of ['WriteReport', 'CreateProfile', 'ResolveProfilePath', 'ObserveApi',
    'ScanRegistry', 'ObserveCandidate', 'GetCandidatePath', 'MatchApiCandidate', 'SidMatchesName',
    'DeleteProfile', 'PostDeleteScan', 'PostDeleteCandidate']) {
    assert.match(transaction, new RegExp(`'${operation}'`));
    assert.match(mode, new RegExp(`${operation}\\s*=`));
    assert.match(synthetic, new RegExp(`${operation}\\s*=`));
  }
  assert.match(mode, /CreateProfileDiagnostic\(\$ProfileName, \[ref\]\$sid\)/);
  assert.match(mode, /GetProfilePath\(\$Sid, \$ProfileName, \$ProfileNonce\)/);
  assert.match(mode, /DeleteProfileDiagnostic\(\$ProfileName\)/);
  assert.match(mode, /return Invoke-ProfilePathResolveTransaction/);
  assert.match(synthetic, /foreach \(\$entry in \$script:report\.GetEnumerator\(\)\)[\s\S]*?journalSnapshots\.Add\(\[pscustomobject\]\$record\)/);
  assert.match(synthetic, /counters\.CreateProfile\+\+/);
  assert.match(synthetic, /failWriteAt = 1/);
  assert.match(synthetic, /CREATE_ATTEMPTED/);
  assert.match(synthetic, /FULL_TRUST_REQUIRED[\s\S]*?PREPARATION_FAILED/);
  assert.match(synthetic, /validationFailsBeforeReserve[\s\S]*?PREPARATION_FAILED[\s\S]*?counters\.CreateProfile -ne 0/);
  assert.match(synthetic, /targetGeneratorMetadata[\s\S]*?REPORT_RESERVATION_FAILED/);
  assert.match(synthetic, /bytesAtFailedAppend/);
  assert.match(synthetic, /laterAppendFailure\.last_persisted_sequence -ne 1/);
  assert.match(synthetic, /createSawAttemptedFlag[\s\S]*?profile_create_attempted -ne \$false/);
  assert.match(synthetic, /journalSnapshots\.Add\(\[pscustomobject\]\$record\)/);
  assert.match(synthetic, /record\.phase -cne \$record\.report\.phase[\s\S]*?record\.status -cne \$record\.report\.status/);
  assert.match(synthetic, /report_persisted\|report_write_status\|last_persisted_sequence/);
  assert.match(synthetic, /syntheticProfilePathStageExceptions[\s\S]*?path_stage -cne \$syntheticStage[\s\S]*?counters\.DeleteProfile -ne 0/);
  assert.match(deleteDecision, /candidate_is_directory -eq \$false/);
  assert.match(synthetic, /CREATE_COLLISION/);
  assert.match(synthetic, /CREATE_FAILED/);
  assert.match(synthetic, /missing-hresult/);
  assert.match(synthetic, /sidConversionFailure/);
  assert.match(synthetic, /registrationStateCases/);
  assert.match(synthetic, /transactionBlockCases[\s\S]*?sid-mismatch[\s\S]*?incomplete-scan[\s\S]*?duplicate-scan[\s\S]*?malformed-scan/);
  assert.match(synthetic, /deletePreconditionCases/);
  assert.match(synthetic, /safeAbsentCandidate/);
  assert.match(synthetic, /apiFailureResult/);
  assert.match(synthetic, /negative-delete/);
  assert.match(synthetic, /delete-throws/);
  assert.match(synthetic, /incomplete-post/);
  assert.match(synthetic, /residual-post/);
  assert.match(synthetic, /privacyStdout[\s\S]*?privacyReport/);
  assert.doesNotMatch(synthetic, /CreateProfile\(|DeleteProfile\(|ObserveProfilePath\(|CreateProfileDiagnostic|DeleteProfileDiagnostic|GetProfilePath\(|GetAppContainerProfileMappingScan|ObserveProfileMappingReadOnly|\[Microsoft\.Win32\.Registry\]::|\[System\.IO\]\.(File|Directory)::|Write-SafeReport|SetAccessControl|CreateDirectory/);
  assert.doesNotMatch(synthetic, /Start-Process|ProcessStartInfo|CreateProcess|StartAppContainerWorker|CreateSuspendedAppContainerProcess|TcpListener|UdpClient|Invoke-Evaluator|\bevaluator\b|\bmodel\b|ollama|claude|codex|worker\.mjs/i);
  assert.doesNotMatch(selfTest, /CreateProfile\(|DeleteProfile\(|ObserveProfilePath\(|CreateProfileDiagnostic|DeleteProfileDiagnostic|GetProfilePath\(|GetAppContainerFolderPath|ObserveProfileMappingReadOnly|\[Microsoft\.Win32\.Registry\]::CurrentUser|\[System\.IO\]\.(File|Directory)::|Write-SafeReport|SetAccessControl|CreateDirectory/);
  assert.doesNotMatch(selfTest, /Start-Process|ProcessStartInfo|CreateProcess|StartAppContainerWorker|CreateSuspendedAppContainerProcess|TcpListener|UdpClient|Invoke-Evaluator|\bmodel\b|ollama|claude|codex/i);
  assert.doesNotMatch(source.slice(0, source.indexOf('\n)', source.indexOf('param('))), /ScriptBlock|IDictionary|Operations/);
  const safeResultStart = source.indexOf('function Convert-ProfilePathDiagnosticSafeResult(');
  const safeResultEnd = source.indexOf('\nfunction Write-ProfilePathDiagnosticJournalSnapshot', safeResultStart);
  const journalStart = safeResultEnd;
  const journalEnd = source.indexOf('\nfunction Close-ProfilePathDiagnosticJournal', journalStart);
  assert.ok(safeResultStart !== -1 && safeResultEnd > safeResultStart);
  assert.ok(journalEnd > journalStart);
  const safeResult = source.slice(safeResultStart, safeResultEnd);
  const journal = source.slice(journalStart, journalEnd);
  assert.match(safeResult, /FULL_TRUST_REQUIRED[\s\S]*?REPORT_RESERVATION_FAILED[\s\S]*?REPORT_WRITE_FAILED/);
  assert.match(safeResult, /NOT_ATTEMPTED[\s\S]*?PASS[\s\S]*?FAIL[\s\S]*?UNKNOWN/);
  assert.match(safeResult, /ReportPathReserved[\s\S]*?appcontainer-profile-path-\[0-9a-f\]\{32\}\\\.jsonl/);
  assert.match(journal, /FileMode\]::CreateNew[\s\S]*?FileShare\]::None[\s\S]*?Flush\(\$true\)/);
  assert.match(journal, /phase = \$script:report\.phase[\s\S]*?status = \$script:report\.status/);
  assert.match(journal, /entry\.Key -notin @\('report_persisted', 'report_write_status', 'last_persisted_sequence'\)/);
  const streamOpen = journal.indexOf('[System.IO.FileStream]::new(');
  assert.ok(streamOpen !== -1);
  assert.match(journal.slice(0, streamOpen), /if \(\$reservationRequired\)[\s\S]*?Assert-NoReparsePath \$diagnosticsRoot[\s\S]*?Path\]::GetFullPath/);
  assert.doesNotMatch(journal.slice(streamOpen), /Assert-NoReparsePath|Path\]::GetFullPath|expectedName|canonicalRoot/);
  assert.match(journal, /run_id = \$script:profilePathDiagnosticJournalRunId/);
  assert.doesNotMatch(journal, /JournalRequestPath|RunId -cne|Path -cne/);
  assert.doesNotMatch(journal, /Write-SafeReport|Test-SafePathAbsent|Assert-ChildPath|Get-Item|Test-Path/);
  assert.match(mode, /\.jsonl/);
  assert.doesNotMatch(mode, /Test-SafePathAbsent\s+\$diagnosticsRoot|Write-SafeReport|Assert-ChildPath\s+\$diagnosticsRoot\s+\$diagnosticReportPath/);
  assert.match(mode, /'FULL_TRUST_REQUIRED'[\s\S]*?'NOT_ATTEMPTED'\s+\$false\s+\$false\s+0\s+\$false\s+\$false\s+\$null/);
  assert.match(mode, /'PREPARATION_FAILED'[\s\S]*?'NOT_ATTEMPTED'\s+\$false\s+\$false\s+0\s+\$false\s+\$false\s+\$null/);
  assert.match(source.slice(source.indexOf('if ($ProfilePathResolveDiagnosticOnly) {'), source.indexOf('\ntry {\n    if ([Environment]::OSVersion', source.indexOf('if ($ProfilePathResolveDiagnosticOnly) {'))), /ConvertTo-Json -InputObject \$safeResult -Compress/);
  assert.doesNotMatch(source.slice(source.indexOf('if ($ProfilePathResolveDiagnosticOnly) {'), source.indexOf('\ntry {\n    if ([Environment]::OSVersion', source.indexOf('if ($ProfilePathResolveDiagnosticOnly) {'))), /Write-SafeReport/);
  assert.match(source, /profilePathDiagnosticLastPersistedStatus[\s\S]*?profilePathDiagnosticLastPersistedPhase/);
  assert.match(source, /profilePathDiagnosticReportPersisted -and[\s\S]*?profilePathDiagnosticLastPersistedPhase/);
});

test('read-only profile diagnostic requires a caller-supplied profile ID and hides invalid input', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('./run-probes.ps1', import.meta.url));
  const invoke = (args) => spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ProfileMappingReadOnlyDiagnosticOnly', ...args,
  ], { encoding: 'utf8', timeout: 10_000 });
  const missing = invoke([]);
  assert.equal(missing.error, undefined, missing.error?.message);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, '');
  assert.deepEqual(JSON.parse(missing.stdout), { status: 'ERROR', reason: 'PROFILE_ID_REQUIRED' });

  for (const invalid of ['AgentCPINVALID', 'agentcp0123456789abcdef0',
    'AgentCP0123456789abcdef0\n', 'AgentCP0123456789abcdef00']) {
    const result = invoke(['-ProfileMappingReadOnlyProfileId', invalid]);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { status: 'ERROR', reason: 'INVALID_PROFILE_ID' });
    assert.ok(!result.stdout.includes(invalid));
    assert.ok(Buffer.byteLength(result.stdout) <= 4096);
  }

  const withoutMode = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ProfileMappingReadOnlyProfileId', 'AgentCP0123456789abcdef0',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(withoutMode.error, undefined, withoutMode.error?.message);
  assert.equal(withoutMode.status, 1);
  assert.equal(withoutMode.stderr, '');
  assert.deepEqual(JSON.parse(withoutMode.stdout), { status: 'ERROR', reason: 'MODE_REQUIRED' });
});

test('read-only profile diagnostic rejects conflicting modes before profile inspection', { skip: process.platform !== 'win32' }, () => {
  for (const conflict of ['-SelfTest', '-PreflightOnly', '-ProtocolSmokeOnly',
    '-ProfileContractImportDiagnosticOnly', '-ProfileBootstrapDiagnosticOnly']) {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fileURLToPath(new URL('./run-probes.ps1', import.meta.url)),
      '-ProfileMappingReadOnlyDiagnosticOnly', '-ProfileMappingReadOnlyProfileId', 'AgentCP0123456789abcdef0', conflict,
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { status: 'ERROR', reason: 'MODE_CONFLICT' });
    assert.ok(Buffer.byteLength(result.stdout) <= 4096);
  }
});

test('PowerShell status and canary cleanup decisions pass with synthetic inputs only', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('./run-probes.ps1', import.meta.url)),
    '-SelfTest',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /synthetic PowerShell contract: PASS/);
});

test('G17.1 synthetic final report status self-test passes', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('./run-probes.ps1', import.meta.url)),
    '-SelfTest',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Synthetic final report status self-test failed\./u);
});

test('G17.1 final block uses Get-ProbeReportFinalStatus and report-write failure still blocks', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  assert.match(source, /\$report\.status = Get-ProbeFinalStatus \$checkValues\r?\n\s*\$fullProbeChecksComputed = \$true/u);
  assert.match(source, /\n    \$report\.status = Get-ProbeReportFinalStatus \(\[bool\]\$PreflightOnly\) \$fullProbeChecksComputed \$report\.failure @\(\$report\.checks\.Values\)\r?\n\s*\r?\n    try \{[\s\S]*?Write-SafeReport \$reportPath\r?\n    \} catch \{\r?\n        \$report\.status = 'BLOCKED'\r?\n        \$report\.g2_2_attestation = \$false\r?\n        Set-Diagnostic 'report-write'/u);
  assert.doesNotMatch(source, /if \(\$PreflightOnly\) \{ \$report\.status = 'BLOCKED' \}/u);
  assert.equal((source.match(/Get-ProbeReportFinalStatus \(\[bool\]\$PreflightOnly\)/gu) ?? []).length, 1);
  assert.match(source, /Synthetic final report status self-test failed\./u);
});

test('diagnostic and production workers share the fixed fail-closed module hook', async () => {
  const { readFile } = await import('node:fs/promises');
  const hook = await readFile(new URL('./module-hook.mjs', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const probes = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const production = await readFile(new URL('./run-worker.ps1', import.meta.url), 'utf8');
  const worker = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  const documentation = await readFile(new URL('./README.md', import.meta.url), 'utf8');

  assert.equal((hook.match(/^import /gmu) ?? []).length, 4);
  assert.doesNotMatch(hook, /^import .*from ['"]\.\//mu);
  assert.match(hook, /if \(typeof registerHooks !== 'function'\) throw moduleError\('MODULE_HOOKS_UNAVAILABLE'\)/u);
  assert.match(hook, /workerArguments\.length !== 0/u);
  assert.match(hook, /registerHooks\(handlers\)/u);
  assert.match(hook, /await import\(fileURL\(workerPath\)\)/u);
  assert.match(hook, /return nextResolve\(specifier, context\)/u);
  assert.match(hook, /return \{ format: 'module', source, shortCircuit: true \}/u);
  assert.match(hook, /isSymbolicLink\(\)/u);
  assert.match(hook, /readFile\(checked\)/u);

  assert.match(launcher, /private const string MODULE_HOOK_BOOTSTRAP[\s\S]*?data:text\/javascript;base64,/u);
  assert.match(launcher, /readFileSync\(hookPath\)[\s\S]*?import\('data:text\/javascript;base64,'[\s\S]*?hook\.startModuleWorker\(/u);
  assert.match(launcher, /BuildModuleHookNodeArguments\(moduleHookPath, workerMode\)/u);
  assert.match(launcher, /workerMode != "probe" && workerMode != "production"/u);
  assert.match(launcher, /Quote\(MODULE_HOOK_BOOTSTRAP\)[\s\S]*?Quote\(canonicalHookPath\)[\s\S]*?Quote\(workerMode\)/u);
  assert.equal((probes.match(/\[AppContainerLauncher\]::RunNodeWithModuleHooks\(/g) ?? []).length, 3);
  assert.match(probes, /Copy-SafeFile \$moduleHookSource \$toolsRoot \$stageModuleHook/u);
  assert.match(probes, /\$stagedModuleHookHash -ne \$moduleHookHash/u);
  assert.match(probes, /module-hook\.mjs=\$stagedModuleHookHash/u);
  assert.match(production, /GetProfilePath\(\$profileSidText, \$profileName, \$nonce\)/u);
  assert.match(production, /Join-Path \$profileTempPath \('agentcp-worker-' \+ \$nonce\)/u);
  assert.match(production, /Copy-OrdinaryFile \$moduleHookSource \$toolsRoot/u);
  assert.match(production, /RunNodeWithModuleHooks\([\s\S]*?'production'/u);
  assert.match(production, /FileSystemRights\]::ReadAndExecute\)\s*$/mu);
  assert.match(production, /Save-WorkspaceAclTree[\s\S]*?Set-WorkspaceAclTree/u);
  assert.match(production, /Restore-WorkspaceAclTree[\s\S]*?DeleteProfile/u);
  assert.match(worker, /export async function main\(args = process\.argv\.slice\(2\), \{ throughModuleHook = false \} = \{\}\)/u);
  assert.match(worker, /PROCESS_TREE_GRANDCHILD_SCRIPT = String\.raw`/u);
  assert.match(worker, /PROCESS_TREE_CHILD_SCRIPT = String\.raw`/u);
  assert.match(worker, /buildProcessTreeChildArguments\('child'\)/u);
  assert.doesNotMatch(worker, /process\.execArgv/u);
  assert.match(documentation, /fixed built-in-only `node -e` child and grandchild scripts/iu);
  assert.match(documentation, /does not prove hook loading in descendants,\s*behavior of arbitrary candidate\s*subprocesses/iu);
  assert.match(documentation, /This negative control intentionally uses Node's default local ESM loader/iu);
  assert.match(documentation, /not\s+evidence that the `data:` bootstrap or registered hook ran/iu);
});

test('process-tree timeout stays bounded and reports only fixed bootstrap stages', async () => {
  const { readFile } = await import('node:fs/promises');
  const worker = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  const probes = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const probeLayout = probes.replace(/\r\n/gu, '\n');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const documentation = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  const hostTestStart = probeLayout.indexOf('function Invoke-ProcessTreeHostTestMode');
  const hostTestDispatch = probeLayout.indexOf('if ($ProcessTreeHostTestOnly)', hostTestStart);
  assert.ok(hostTestStart !== -1 && hostTestDispatch > hostTestStart);
  const assertNoReparseStart = probeLayout.indexOf('function Assert-NoReparsePath(');
  const assertChildPathStart = probeLayout.indexOf('function Assert-ChildPath(', assertNoReparseStart);
  const assertChildPathReturn = probeLayout.indexOf('\n    return $canonicalCandidate\n}', assertChildPathStart);
  const assertChildPathCloseEnd = assertChildPathReturn + '\n    return $canonicalCandidate\n}'.length;
  const processIdAbsentHelper = probeLayout.indexOf('function Test-ProcessIdAbsent(', assertChildPathCloseEnd);
  const processIdAbsentHelperEnd = probeLayout.indexOf('\n}\n', processIdAbsentHelper) + '\n}\n'.length;
  const mainProbeTry = probeLayout.indexOf('\ntry {\n', assertChildPathCloseEnd);
  assert.ok(assertNoReparseStart !== -1 && assertChildPathStart > assertNoReparseStart);
  assert.ok(assertChildPathReturn > assertChildPathStart && mainProbeTry > assertChildPathCloseEnd);
  assert.ok(processIdAbsentHelper > assertChildPathCloseEnd && processIdAbsentHelperEnd > processIdAbsentHelper &&
    processIdAbsentHelperEnd < hostTestDispatch,
    'the host-only dispatch must run after Test-ProcessIdAbsent is defined');
  assert.ok(hostTestDispatch > processIdAbsentHelperEnd && hostTestDispatch < mainProbeTry);
  for (const effect of [
    '[AppContainerLauncher]::CreateProfile($profileName)',
    "New-ProbeCanary 'runtime'",
    '[System.Net.Sockets.TcpListener]::new',
    'Write-SafeReport $reportPath',
  ]) {
    const effectIndex = probeLayout.indexOf(effect, mainProbeTry);
    assert.ok(effectIndex > mainProbeTry && hostTestDispatch < effectIndex, `host-only dispatch must precede ${effect}`);
  }
  const hostTestFunctionEnd = probeLayout.indexOf('\nfunction Add-ProbeAccessRule', hostTestStart);
  assert.ok(hostTestFunctionEnd > hostTestStart && hostTestFunctionEnd < hostTestDispatch);
  const hostTestMode = probeLayout.slice(hostTestStart, hostTestFunctionEnd);
  const hostTestCatch = hostTestMode.match(/\}\s*catch\s*\{([\s\S]*?)\}\s*\$stage\s*=\s*'SERIALIZATION'/u)?.[1] ?? '';
  const sourceReadStart = probeLayout.indexOf('function Read-ValidatedSource(');
  const sourceReadEnd = probeLayout.indexOf('\nfunction Test-ExactHostTestJsonProperties', sourceReadStart);
  assert.ok(sourceReadStart !== -1 && sourceReadEnd > sourceReadStart);
  const sourceReadMode = probeLayout.slice(sourceReadStart, sourceReadEnd);
  assert.notEqual(hostTestCatch, '');
  assert.match(hostTestCatch, /\$safeResult\.failed_stage\s*=\s*\$stage/u);
  assert.match(hostTestCatch, /\$safeResult\.failure_hresult\s*=\s*if\s*\(\$null\s*-ne\s*\$_\.Exception\)\s*\{\s*\[int\]\$_.Exception.HResult/u);
  assert.doesNotMatch(hostTestCatch, /Exception\.(?:Message|StackTrace)|ScriptStackTrace|Exception\.Path/u);
  assert.match(hostTestCatch, /if\s*\(\$stage\s*-ceq\s*'LAUNCHER_SOURCE_READ'\)\s*\{[\s\S]*?failure_substage/u);
  assert.match(hostTestCatch, /failure_substage\s*=\s*if\s*\(@\('PATH_CONTAINMENT',\s*'REPARSE_ATTRIBUTES',\s*'FILE_OPEN',\s*'BOUNDED_READ_HASH',\s*'UTF8_DECODE'\)/u);
  assert.match(hostTestMode, /Read-ValidatedSource\s+\$PSScriptRoot\s+\$launcherPath\s+\$sourceReadDiagnostics/u);
  assert.match(hostTestMode, /\$trustedNodePath\s*=\s*Get-NodeExecutable/u);
  assert.match(hostTestMode, /OrdinalIgnoreCase\.Equals\(\$inputNodePath,\s*\$trustedNodePath\)/u);
  assert.match(hostTestMode, /RunHostProcessTreeTest\(\s*\$trustedNodePath/u);
  assert.doesNotMatch(hostTestMode, /RunHostProcessTreeTest\(\s*\[string\]\$hostTestInput\.node_path/u);
  const csharpMethodBody = (methodStart) => {
    const start = launcher.indexOf(methodStart);
    assert.notEqual(start, -1, `missing method ${methodStart}`);
    const nextPrivateMethod = launcher.indexOf('\n    private static ', start + methodStart.length);
    const nextPublicMethod = launcher.indexOf('\n    public static ', start + methodStart.length);
    const ends = [nextPrivateMethod, nextPublicMethod].filter((index) => index !== -1);
    return launcher.slice(start, ends.length ? Math.min(...ends) : launcher.length);
  };
  const hostProcessTreeLauncher = csharpMethodBody('public static HostProcessTreeTestRunResult RunHostProcessTreeTest(');
  const productionRunNodeCore = csharpMethodBody('private static AppContainerRunResult RunNodeCore(');
  const timeoutCleanup = csharpMethodBody('private static void RunTimeoutCleanup(');
  const productionStartupVariant = csharpMethodBody('private static SuspendedStartupVariantResult RunSuspendedStartupVariant(');
  assert.match(hostProcessTreeLauncher, /limits\.BasicLimitInformation\.ActiveProcessLimit\s*=\s*4/u);
  assert.match(productionRunNodeCore, /limits\.BasicLimitInformation\.ActiveProcessLimit\s*=\s*8/u);
  assert.match(productionStartupVariant, /limits\.BasicLimitInformation\.ActiveProcessLimit\s*=\s*8/u);
  assert.match(hostTestMode, /JobProcessIdAssignedCount\s*-eq\s*4[\s\S]*?JobProcessIdReturnedCount\s*-eq\s*4[\s\S]*?\$timeoutJobProcessIds\.Count\s*-eq\s*4/u);
  assert.match(hostTestMode, /JobMemberDiagnosticsStatus\s*-ceq\s*'COMPLETE'[\s\S]*?JobMemberJobSetStable\s*-eq\s*\$true[\s\S]*?JobMemberOpenCount\s*-eq\s*4[\s\S]*?JobMemberMembershipVerifiedCount\s*-eq\s*4[\s\S]*?JobMemberNotInJobCount\s*-eq\s*0[\s\S]*?JobMemberMembershipUnknownCount\s*-eq\s*0[\s\S]*?JobMemberNodeImageCount\s*-eq\s*2[\s\S]*?JobMemberConsoleHostImageCount\s*-eq\s*2[\s\S]*?JobMemberCommandShellImageCount\s*-eq\s*0[\s\S]*?JobMemberOtherImageCount\s*-eq\s*0[\s\S]*?JobMemberImageUnknownCount\s*-eq\s*0[\s\S]*?JobMemberMetadataUnknownCount\s*-eq\s*0/u);
  assert.match(hostTestMode, /EffectiveActiveProcessLimit\s*-eq\s*4/u);
  assert.match(hostTestMode, /Test-ProcessIdAbsent\s*\(\[int\]\$normalRootPidValue\)[\s\S]*?Test-ProcessIdAbsent\s*\(\[int\]\$normalGrandchildPidValue\)/u);
  assert.match(hostTestMode, /Test-ProcessIdAbsent\s*\(\[int\]\$timeoutRootPidValue\)[\s\S]*?Test-ProcessIdAbsent\s*\(\[int\]\$timeoutGrandchildPidValue\)/u);
  assert.match(hostTestMode, /normalProcessIdsDistinct[\s\S]*?normalRootPidAbsentAfterDrain[\s\S]*?normalGrandchildPidAbsentAfterDrain/u);
  assert.match(hostTestMode, /timeoutProcessIdsDistinct[\s\S]*?timeoutRootPidAbsentAfterDrain[\s\S]*?timeoutGrandchildPidAbsentAfterDrain/u);
  assert.match(launcher, /JobObjectBasicLimitInformation\s*=\s*2/u);
  assert.match(launcher, /JobObjectBasicProcessIdList\s*=\s*3/u);
  assert.match(launcher, /MAX_JOB_PROCESS_ID_LIST_CAPACITY\s*=\s*8/u);
  assert.match(launcher, /TryGetJobActiveProcessLimit\(/u);
  assert.match(launcher, /TryGetJobAccountingSnapshot\(/u);
  assert.match(launcher, /TryGetJobProcessIdList\(/u);
  assert.match(launcher, /CaptureHostJobDeadlineSnapshot\(job,\s*result\)[\s\S]*?TerminateJobObject\(job,\s*124\)/u);
  assert.match(launcher, /CaptureHostJobMemberDiagnostics\(job,\s*result\)/u);
  const hostMemberCaptureStart = launcher.indexOf('private static void CaptureHostJobMemberDiagnostics');
  const hostMemberCaptureEnd = launcher.indexOf('\n    private static void CaptureAppContainerJobMemberDiagnostics', hostMemberCaptureStart);
  assert.ok(hostMemberCaptureStart !== -1 && hostMemberCaptureEnd > hostMemberCaptureStart);
  const hostMemberCapture = launcher.slice(hostMemberCaptureStart, hostMemberCaptureEnd);
  const processOpen = hostMemberCapture.indexOf('OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId)');
  const openHandles = hostMemberCapture.indexOf('processHandlesToClose.Add(process)');
  const firstIdentityCheck = hostMemberCapture.indexOf('GetProcessId(process) != processId');
  const metadataSnapshot = hostMemberCapture.indexOf('TryReadHostJobProcessMetadata(processIdSet');
  const jobSetRequery = hostMemberCapture.indexOf('TryGetJobProcessIdList(job');
  const jobSetCompare = hostMemberCapture.indexOf('requerySet.SetEquals(processIdSet)');
  const finalIdentityCheck = hostMemberCapture.lastIndexOf('GetProcessId(process) != processId');
  const initialMembershipCheck = hostMemberCapture.indexOf('IsProcessInJob(process, job');
  const finalJobSetRequery = hostMemberCapture.lastIndexOf('TryGetJobProcessIdList(job');
  const imageClassification = hostMemberCapture.indexOf('ClassifyHostJobProcessImageName(item.ImageName)');
  const finalMembershipCheck = hostMemberCapture.lastIndexOf('IsProcessInJob(process, job');
  const metadataAssociation = hostMemberCapture.indexOf('bool mayAssociateMetadata');
  const handleClose = hostMemberCapture.indexOf('CloseDiagnosticHandle(processHandlesToClose[index], ref diagnosticCleanupError)');
  assert.ok(processOpen !== -1 && processOpen < openHandles && openHandles < firstIdentityCheck &&
    firstIdentityCheck < metadataSnapshot && metadataSnapshot < jobSetRequery &&
    jobSetRequery < jobSetCompare && jobSetCompare < initialMembershipCheck &&
    initialMembershipCheck < metadataAssociation && metadataAssociation < imageClassification &&
    imageClassification < finalJobSetRequery && finalJobSetRequery < finalIdentityCheck &&
    finalIdentityCheck < finalMembershipCheck &&
    finalMembershipCheck < handleClose,
  'job member handles must remain open through snapshot, requery, membership validation, and metadata association');
  assert.match(launcher, /ClassifyHostJobProcessImageName[\s\S]*?imageName,\s*"node\.exe"[\s\S]*?"conhost\.exe"[\s\S]*?"OpenConsole\.exe"[\s\S]*?"WindowsTerminal\.exe"[\s\S]*?"cmd\.exe"[\s\S]*?"powershell\.exe"[\s\S]*?"pwsh\.exe"/u);
  assert.match(hostMemberCapture, /imageCategory\s*==\s*"NODE"[\s\S]*?imageCategory\s*==\s*"CONSOLE_HOST"[\s\S]*?imageCategory\s*==\s*"COMMAND_SHELL"[\s\S]*?imageCategory\s*==\s*"OTHER"/u);
  assert.match(launcher, /parentIdMatchesJobMemberCount\+\+/u);
  assert.match(hostMemberCapture, /bool mayAssociateMetadata\s*=\s*metadataSnapshotComplete\s*&&\s*jobSetStable\s*==\s*true[\s\S]*?membershipVerifiedIds\.Count\s*==\s*processIdSet\.Count[\s\S]*?notInJobIds\.Count\s*==\s*0[\s\S]*?membershipUnknownIds\.Count\s*==\s*0/u);
  assert.doesNotMatch(hostMemberCapture, /bool mayAssociateMetadata\s*=[^;]*(?:membershipVerifiedCount|notInJobCount|membershipUnknownCount)/u);
  assert.match(launcher, /membershipMismatch\s*\?\s*"MISMATCH"[\s\S]*?observationComplete\s*&&\s*metadataSnapshotComplete\s*&&\s*jobSetStable\s*==\s*true[\s\S]*?membershipVerifiedCount\s*==\s*\(uint\)processIdSet\.Count[\s\S]*?metadataUnknownCount\s*==\s*0\s*&&\s*diagnosticCleanupError\s*==\s*0[\s\S]*?"COMPLETE"[\s\S]*?"UNKNOWN"/u);
  assert.match(launcher, /AccountingExcessCoveredByTerminationCount\s*=\s*accounting\.TotalTerminatedProcesses\s*>=\s*excess/u);
  const normalOutputStart = hostTestMode.indexOf('$safeResult.normal = [ordered]@{');
  const normalOutputEnd = hostTestMode.indexOf('\n        }', normalOutputStart);
  const timeoutOutputStart = hostTestMode.indexOf('$safeResult.timeout = [ordered]@{');
  const timeoutOutputEnd = hostTestMode.indexOf('\n        }', timeoutOutputStart);
  assert.ok(normalOutputStart !== -1 && normalOutputEnd > normalOutputStart);
  assert.ok(timeoutOutputStart !== -1 && timeoutOutputEnd > timeoutOutputStart);
  const normalOutput = hostTestMode.slice(normalOutputStart, normalOutputEnd);
  const timeoutOutput = hostTestMode.slice(timeoutOutputStart, timeoutOutputEnd);
  assert.doesNotMatch(normalOutput, /normalRootPidValue|normalGrandchildPidValue|RootProcessIdForComparison|grandchild_pid\s*=|process_id\s*=/u);
  assert.doesNotMatch(timeoutOutput, /JobProcessIdsAtDeadline|RootProcessIdForComparison|grandchild_pid\s*=|ImageName|ParentProcessId|szExeFile|trustedNodePath|conhost\.exe|OpenConsole\.exe|WindowsTerminal\.exe|cmd\.exe|powershell\.exe|pwsh\.exe/u);
  for (const field of ['process_ids_distinct', 'root_pid_absent_after_drain', 'grandchild_pid_absent_after_drain']) {
    assert.match(normalOutput, new RegExp(`${field}\\s*=\\s*\\[bool\\]`, 'u'));
    assert.match(timeoutOutput, new RegExp(`${field}\\s*=\\s*\\[bool\\]`, 'u'));
  }
  for (const field of [
    'process_member_diagnostics_status', 'process_member_job_set_stable', 'process_member_open_count',
    'process_member_membership_verified_count', 'process_member_not_in_job_count',
    'process_member_membership_unknown_count', 'process_member_node_image_count',
    'process_member_console_host_image_count', 'process_member_command_shell_image_count',
    'process_member_other_image_count', 'process_member_image_unknown_count',
    'process_member_parent_id_matches_job_member_count', 'process_member_metadata_unknown_count',
  ]) assert.match(timeoutOutput, new RegExp(`${field}\\s*=`, 'u'));
  assert.match(timeoutOutput, /@\('COMPLETE',\s*'MISMATCH',\s*'UNKNOWN'\)[\s\S]*?else\s*\{\s*'UNKNOWN'\s*\}/u);
  const appContainerMemberCaptureStart = launcher.indexOf('private static void CaptureAppContainerJobMemberDiagnostics(');
  const appContainerMemberCaptureEnd = launcher.indexOf('\n    private static void CaptureHostJobDeadlineSnapshot', appContainerMemberCaptureStart);
  assert.ok(appContainerMemberCaptureStart !== -1 && appContainerMemberCaptureEnd > appContainerMemberCaptureStart);
  const appContainerMemberCapture = launcher.slice(appContainerMemberCaptureStart, appContainerMemberCaptureEnd);
  assert.match(appContainerMemberCapture, /TryGetJobProcessIdList[\s\S]*?CaptureHostJobMemberDiagnostics\(job,\s*snapshot\)/u);
  assert.match(appContainerMemberCapture, /GetJobMemberSnapshotStatus\(evidence\)/u);
  assert.match(productionRunNodeCore, /RunTimeoutCleanup\(result,\s*captureTimeoutJobMembers[\s\S]*?CaptureAppContainerJobMemberDiagnostics\(job,\s*result\)/u);
  assert.match(timeoutCleanup, /SetProcessTreeStage\(result,\s*"JOB_SNAPSHOT"\)[\s\S]*?catch\s*\(Exception exception\)[\s\S]*?JobMemberDiagnosticsStatus\s*=\s*"UNKNOWN"[\s\S]*?RecordProcessTreeFailure[\s\S]*?SetProcessTreeStage\(result,\s*"JOB_TERMINATION"\)[\s\S]*?terminateJob\(\)[\s\S]*?SetProcessTreeStage\(result,\s*"ROOT_SIGNAL"\)[\s\S]*?confirmRootSignal\(\)[\s\S]*?SetProcessTreeStage\(result,\s*"JOB_DRAIN"\)[\s\S]*?drainJob\(\)/u);
  assert.match(launcher, /ProcessTreeTimeoutSnapshotSyntheticSelfTest\(\)[\s\S]*?Synthetic private path[\s\S]*?424242/u);
  assert.match(launcher, /WrapProcessTreeCleanupFailure[\s\S]*?originalException\)[\s\S]*?AttachProcessTreeFailureData\(wrapper, result, cleanupException\)/u);
  assert.match(probes, /ProcessTreeTimeoutSnapshotSyntheticSelfTest\(\)/u);
  assert.match(launcher, /Synthetic fail-closed cleanup diagnostics self-test failed/u);
  assert.match(probeLayout, /RunNodeWithModuleHooks\([\s\S]*?\$treeInput,\s*\$TreeTimeoutMs,\s*\$null,\s*\$true\)/u);
  assert.match(probeLayout, /function Test-ProcessTreeMemberEvidenceComplete\([\s\S]*?ProcessTreeStatus\s*-ceq\s*'COMPLETE'[\s\S]*?JobMemberDiagnosticsStatus\s*-ceq\s*'COMPLETE'/u);
  assert.match(probeLayout, /\$treePassed\s*=\s*\$treeRun\.TimedOut[\s\S]*?\$treeMemberEvidenceComplete/u);
  assert.match(probeLayout, /function Get-ProcessTreeDiagnosticObservation\([\s\S]*?failure_stage\s*=\s*\$failureStage[\s\S]*?exception_type\s*=\s*\$exceptionType[\s\S]*?hresult\s*=\s*\$hresult[\s\S]*?win32_code\s*=\s*\$win32Code[\s\S]*?cleanup_failure_stage\s*=\s*\$cleanupFailureStage[\s\S]*?cleanup_exception_type\s*=\s*\$cleanupExceptionType/u);
  assert.match(probeLayout, /process_tree_diagnostic\s*=\s*\$processTreeDiagnostic/u);
  assert.match(probes, /Synthetic process-tree completeness gate accepted incomplete member evidence/u);
  assert.match(probes, /Synthetic process-tree outer report redaction self-test failed/u);
  const memberObservationStart = probeLayout.indexOf('function Get-JobMemberSnapshotObservation(');
  const memberObservationEnd = probeLayout.indexOf('\nfunction New-ProcessTreeReportObservation', memberObservationStart);
  assert.ok(memberObservationStart !== -1 && memberObservationEnd > memberObservationStart);
  const memberObservation = probeLayout.slice(memberObservationStart, memberObservationEnd);
  for (const field of [
    'status', 'job_set_stable', 'query_error_code', 'cleanup_error_code', 'assigned_count',
    'returned_count', 'open_count', 'membership_verified_count', 'not_in_job_count',
    'membership_unknown_count', 'node_image_count', 'console_host_image_count',
    'command_shell_image_count', 'other_image_count', 'image_unknown_count', 'metadata_unknown_count',
  ]) assert.match(memberObservation, new RegExp(`${field}\\s*=`, 'u'));
  assert.doesNotMatch(memberObservation, /processIds|ProcessId|ImageName|ImagePath|ProfileId|Sid|\.Stdout|\.Stderr/u);
  assert.match(probes, /Synthetic bounded Job member snapshot decision self-test failed/u);
  assert.match(probes, /Synthetic Job member snapshot output redaction self-test failed/u);
  const processTreeReportStart = probeLayout.indexOf('function New-ProcessTreeReportObservation');
  const processTreeReportEnd = probeLayout.indexOf('\nfunction Get-StdioSmokeMarkers', processTreeReportStart);
  assert.ok(processTreeReportStart !== -1 && processTreeReportEnd > processTreeReportStart);
  const processTreeReportBuilder = probeLayout.slice(processTreeReportStart, processTreeReportEnd);
  assert.match(probeLayout, /\$report\.observations\.process_tree\s*=\s*New-ProcessTreeReportObservation/u);
  assert.match(processTreeReportBuilder, /child_pid_valid\s*=\s*\$childPidValid/u);
  assert.match(processTreeReportBuilder, /grandchild_pid_valid\s*=\s*\$grandchildPidValid/u);
  assert.match(processTreeReportBuilder, /process_ids_distinct\s*=\s*\$processIdsDistinct/u);
  assert.doesNotMatch(processTreeReportBuilder, /child_pid\s*=\s*\$childPid\b|grandchild_pid\s*=\s*\$grandchildPid\b/u);
  assert.match(probes, /Synthetic process-tree outer report redaction self-test failed/u);
  for (const substage of ['PATH_CONTAINMENT', 'REPARSE_ATTRIBUTES', 'FILE_OPEN', 'BOUNDED_READ_HASH', 'UTF8_DECODE']) {
    assert.match(sourceReadMode, new RegExp(`'${substage}'`, 'u'));
  }
  for (const stage of [
    'INPUT_VALIDATION', 'LAUNCHER_SOURCE_READ', 'LAUNCHER_COMPILE', 'TEMP_DIRECTORY_CHECK',
    'NORMAL_PROCESS', 'NORMAL_READINESS', 'TIMEOUT_PROCESS', 'TIMEOUT_READINESS', 'SERIALIZATION',
  ]) assert.match(hostTestMode, new RegExp(`'${stage}'`, 'u'));
  assert.match(hostTestMode, /native_stage\s*=\s*if\s*\(@\('PREFLIGHT'[\s\S]*?native_error_code\s*=/u);

  assert.match(worker, /PROCESS_TREE_STARTUP_TIMEOUT_MS = 8_000/u);
  assert.match(worker, /PROCESS_TREE_MAX_READINESS_BYTES = 2_048/u);
  assert.match(worker, /PROCESS_TREE_READINESS_CODES = new Set\(/u);
  assert.match(worker, /CHILD_START_TIMEOUT/u);
  assert.match(worker, /GRANDCHILD_START_TIMEOUT/u);
  assert.match(probes, /\[int\]\$TreeTimeoutMs = 10000/u);
  assert.match(probes, /\$TreeTimeoutMs -gt 10000/u);
  assert.match(probes, /child_spawn_status/u);
  assert.match(probes, /grandchild_spawn_status/u);
  assert.match(probes, /readiness_stage/u);
  assert.match(probes, /child_pid_absent_after_drain = \$childPidAbsent/u);
  assert.match(probes, /\$childPidAbsent = \$null/u);
  assert.match(worker, /const PROCESS_TREE_PHASE_MARKERS = new Set\(/u);
  for (const stage of [
    'PROBE_REQUEST_RECEIVED', 'PROCESS_TREE_REQUEST_DISPATCH', 'CHILD_SPAWN_CALL_BEGIN',
    'CHILD_SPAWN_CALL_RETURN', 'CHILD_SPAWN_CALL_THROW', 'CHILD_SPAWN_EVENT',
    'CHILD_SPAWN_ERROR', 'CHILD_SPAWN_TIMEOUT', 'CHILD_WORKER_START_WAIT',
    'CHILD_WORKER_READY', 'GRANDCHILD_START_WAIT', 'CHILD_READINESS_RESPONSE',
    'PROCESS_TREE_RESPONSE_BEGIN', 'PROCESS_TREE_RESPONSE_FLUSHED',
  ]) {
    assert.match(worker, new RegExp(`'${stage}'`, 'u'));
    assert.match(probes, new RegExp(`'${stage}'`, 'u'));
  }
  assert.match(probes, /\$phaseMarkers\.Count -ge 32/u);
  assert.match(probes, /\$entry\.agentcp_stage -isnot \[string\]/u);
  assert.match(probes, /function Test-ProcessTreePhasePrefix/u);
  assert.match(probes, /Test-ProcessTreePhasePrefix[\s\S]*?\$RequireComplete/u);
  assert.match(probes, /\$phaseMarkers\.Count -eq 0[\s\S]*?PROBE_REQUEST_RECEIVED/u);
  assert.match(probes, /PROCESS_TREE_RESPONSE_BEGIN[\s\S]*?PROCESS_TREE_RESPONSE_FLUSHED/u);
  assert.match(probes, /Synthetic empty process-tree protocol self-test failed/u);
  assert.match(probes, /Synthetic duplicate\/out-of-order\/impossible process-tree marker self-test failed/u);
  assert.match(probes, /Synthetic non-string process-tree marker self-test failed/u);
  assert.match(probes, /Synthetic multiple\/malformed worker response self-test failed/u);
  assert.match(probes, /Synthetic process-tree response-position self-test failed/u);
  assert.match(probes, /function Get-DeadlineJobObservation/u);
  assert.match(processTreeReportBuilder, /deadline_active_processes = \$deadlineObservation\.deadline_active_processes/u);
  assert.match(processTreeReportBuilder, /deadline_query_error_code = \$deadlineObservation\.deadline_query_error_code/u);
  assert.match(probes, /Synthetic process-tree deadline Job accounting self-test failed/u);
  assert.match(processTreeReportBuilder, /phase_marker_schema_valid = \$phaseMarkerSchemaValid/u);
  assert.match(processTreeReportBuilder, /phase_markers = \$phaseMarkers/u);
  assert.match(documentation, /`agentcp_stage`/u);
  assert.match(documentation, /fixed built-in-only `node -e`/u);
  assert.match(documentation, /10-second Job timeout/u);
  assert.match(documentation, /readiness_stage/u);
});

test('G14.2 token and loopback observations are bounded, separated, and redacted', async () => {
  const { readFile } = await import('node:fs/promises');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const probes = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');
  const documentation = await readFile(new URL('./README.md', import.meta.url), 'utf8');

  const tokenCaptureStart = launcher.indexOf('private static bool CaptureWorkerAppContainerToken(');
  const tokenCaptureEnd = launcher.indexOf('\n    private static TokenCapabilitiesEvidence ReadTokenCapabilities', tokenCaptureStart);
  const childStart = launcher.indexOf('public static LoopbackConfigChildRunResult RunLoopbackConfigChild(');
  const childEnd = launcher.indexOf('\n    private static void ValidateHostProcessTreeTestArguments', childStart);
  const loopbackStart = launcher.indexOf('public static LoopbackConfigObservation ReadLoopbackConfigForAppContainer(');
  const loopbackEnd = launcher.indexOf('\n    public static bool TokenCapabilitiesSyntheticSelfTest()', loopbackStart);
  const loopbackCoreStart = launcher.indexOf('private static LoopbackConfigObservation InspectAndFreeLoopbackConfigList(');
  const loopbackCoreEnd = launcher.indexOf('\n    public static LoopbackConfigObservation ReadLoopbackConfigForAppContainer(', loopbackCoreStart);
  const loopbackSyntheticStart = launcher.indexOf('public static bool LoopbackConfigSyntheticSelfTest()');
  const loopbackSyntheticEnd = launcher.indexOf('\n    private static IntPtr ConvertSyntheticExpectedSid()', loopbackSyntheticStart);
  assert.ok(tokenCaptureStart !== -1 && tokenCaptureEnd > tokenCaptureStart);
  assert.ok(childStart !== -1 && childEnd > childStart);
  assert.ok(loopbackStart !== -1 && loopbackEnd > loopbackStart);
  assert.ok(loopbackCoreStart !== -1 && loopbackCoreEnd > loopbackCoreStart);
  assert.ok(loopbackSyntheticStart !== -1 && loopbackSyntheticEnd > loopbackSyntheticStart);
  const tokenCapture = launcher.slice(tokenCaptureStart, tokenCaptureEnd);
  const childLauncher = launcher.slice(childStart, childEnd);
  const loopbackReader = launcher.slice(loopbackStart, loopbackEnd);
  const loopbackCore = launcher.slice(loopbackCoreStart, loopbackCoreEnd);
  const loopbackSynthetic = launcher.slice(loopbackSyntheticStart, loopbackSyntheticEnd);

  assert.match(tokenCapture, /OpenProcessToken\(process, TOKEN_QUERY/u);
  assert.match(tokenCapture, /TokenIsAppContainer/u);
  assert.match(tokenCapture, /TokenAppContainerSid/u);
  assert.match(tokenCapture, /EqualSid\(sidInfo\.TokenAppContainer, expectedSid\)/u);
  assert.match(launcher, /TokenCapabilities = 30/u);
  assert.match(launcher, /MAX_WORKER_TOKEN_BUFFER_BYTES = 65536/u);
  assert.match(launcher, /MAX_WORKER_TOKEN_CAPABILITIES = 256/u);
  assert.match(launcher, /ParseTokenCapabilitiesBuffer[\s\S]*?GetLengthSid[\s\S]*?IsValidSid/u);
  assert.match(launcher, /public static bool TokenCapabilitiesSyntheticSelfTest\(\)/u);

  assert.match(childLauncher, /CreateJobObject[\s\S]*?JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(childLauncher, /PROC_THREAD_ATTRIBUTE_JOB_LIST[\s\S]*?CreateProcess\(/u);
  assert.match(childLauncher, /-LoopbackConfigChildOnly/u);
  assert.match(launcher, /LOOPBACK_CONFIG_CHILD_TIMEOUT_MS = 5000/u);
  assert.match(launcher, /MAX_LOOPBACK_CONFIG_INPUT_BYTES = 256/u);
  assert.match(launcher, /MAX_LOOPBACK_CONFIG_OUTPUT_BYTES = 4096/u);
  assert.match(childLauncher, /TerminateJobObject[\s\S]*?RootProcessSignaled[\s\S]*?JobDrained/u);
  assert.doesNotMatch(childLauncher, /commandLine\.Append\([^\n]*profileSid|Stdout[^\n]*profileSid/u);
  assert.match(launcher, /NetworkIsolationGetAppContainerConfig/u);
  assert.match(launcher, /HeapFree\(heap, 0, memory\)/u);
  assert.match(launcher, /MAX_LOOPBACK_CONFIG_ENTRIES = 4096/u);
  assert.match(launcher, /MAX_LOOPBACK_CONFIG_TRAVERSAL_MS = 250/u);
  assert.match(loopbackReader, /NetworkIsolationGetAppContainerConfig[\s\S]*?Stopwatch postReturnTimer = Stopwatch\.StartNew\(\)[\s\S]*?InspectAndFreeLoopbackConfigList/u);
  assert.equal((launcher.match(/NetworkIsolationGetAppContainerConfig\(/gu) ?? []).length, 2);
  assert.match(loopbackCore, /Func<long> elapsedMilliseconds[\s\S]*?LoopbackHeapFreeDelegate heapFree/u);
  assert.match(loopbackCore, /count > MAX_LOOPBACK_CONFIG_ENTRIES[\s\S]*?entryReadObserver/u);
  assert.match(loopbackCore, /IsLoopbackWithinBudget\(elapsedMilliseconds, ref expired\)[\s\S]*?heapFree\(processHeap, ownedSids\[index\]\)[\s\S]*?IsLoopbackWithinBudget\(elapsedMilliseconds, ref expired\)/u);
  assert.match(loopbackCore, /heapFree\(processHeap, returnedSids\)[\s\S]*?IsLoopbackWithinBudget\(elapsedMilliseconds, ref expired\)/u);
  assert.match(loopbackCore, /LocalFree\(expectedSid\)[\s\S]*?IsLoopbackWithinBudget\(elapsedMilliseconds, ref expired\)/u);
  assert.match(launcher, /public static bool LoopbackConfigSyntheticSelfTest\(\)/u);
  assert.doesNotMatch(loopbackSynthetic, /NetworkIsolationGetAppContainerConfig/u);
  for (const syntheticCase of [
    'overflowArray', 'overflowEntryReads', 'nullEntryArray', 'malformedArray', 'repeatedArray',
    'duplicateValuesArray', 'sidFreeFailure', 'arrayFreeFailure', 'finalSidDeadline', 'arrayDeadline',
  ]) assert.match(loopbackSynthetic, new RegExp(syntheticCase, 'u'));

  const childModeStart = probes.indexOf('\nif ($LoopbackConfigChildOnly) {');
  const childModeEnd = probes.indexOf('\nif ($SelfTest) {', childModeStart);
  const networkStart = probes.indexOf("$currentPhase = 'loopback-network-probe'");
  const networkEnd = probes.indexOf("$currentPhase = 'process-tree-probe'", networkStart);
  const hostControlStart = probes.indexOf('function Invoke-HostLoopbackControl(');
  const helperParserStart = probes.indexOf('function ConvertFrom-LoopbackConfigHelperOutput(');
  const helperParserEnd = probes.indexOf('\nfunction Invoke-HostLoopbackControl(', helperParserStart);
  assert.ok(childModeStart !== -1 && childModeEnd > childModeStart);
  assert.ok(networkStart !== -1 && networkEnd > networkStart);
  assert.ok(hostControlStart !== -1 && helperParserEnd > helperParserStart);
  const childMode = probes.slice(childModeStart, childModeEnd);
  const networkFlow = probes.slice(networkStart, networkEnd);
  const helperParser = probes.slice(helperParserStart, helperParserEnd);
  assert.match(probes, /\[switch\]\$LoopbackConfigChildOnly/u);
  assert.match(probes, /OpenStandardInput\(\)[\s\S]*?inputLength -gt 256[\s\S]*?UTF8Encoding\(\$false,\s*\$true\)/u);
  assert.match(childMode, /ReadLoopbackConfigForAppContainer\(\$helperSid\)/u);
  assert.match(childMode, /Write-LoopbackConfigChildOutput/u);
  assert.doesNotMatch(childMode, /CreateProfile\(|DeleteProfile\(|TcpListener|RunNode|Set-ProbeAcl|SetAccessControl/u);
  assert.match(helperParser, /RootProcessSignaled[\s\S]*?JobDrained[\s\S]*?CleanupConfirmed/u);
  assert.match(helperParser, /Test-ExactObjectKeys[\s\S]*?schema_version[\s\S]*?loopback_exemption[\s\S]*?cleanup_status/u);
  assert.match(networkFlow, /RunLoopbackConfigChild\(\$scriptSourcePath,\s*\$profileSidText\)/u);
  assert.match(networkFlow, /ConvertFrom-LoopbackConfigHelperOutput/u);
  assert.match(networkFlow, /preserveStageForInspection\s*=\s*\$true[\s\S]*?throw 'The loopback configuration helper/u);
  assert.match(networkFlow, /Invoke-HostLoopbackControl[\s\S]*?RunNodeWithModuleHooks/u);
  assert.match(networkFlow, /loopbackHelper\.status -ceq 'VALID' -and \$hostControl\.status -ceq 'PASS'/u);
  assert.match(networkFlow, /timeoutMs\s*=\s*1000/u);
  assert.match(networkFlow, /Get-NetworkDeniedStatus[\s\S]*?Set-Check 'network_denied'/u);
  assert.match(probes, /appcontainer_capabilities_status\s*=\s*\[string\]\$fileRun\.AppContainerCapabilitiesStatus/u);
  assert.match(probes, /appcontainer_capability_count\s*=\s*\$fileRun\.AppContainerCapabilityCount/u);
  assert.doesNotMatch(probes, /appcontainer_capability_count\s*=\s*0/u);
  assert.match(probes, /Synthetic loopback helper, host-control, network status, or redaction self-test failed/u);
  assert.match(documentation, /G14\.2 read-only token and loopback observations/u);
  assert.match(documentation, /`NetworkIsolationGetAppContainerConfig` is synchronous and has\s+no cancellation parameter/u);
  assert.match(documentation, /This API reports the configured\s+loopback-exemption list[\s\S]*does not report the complete effective\s+network policy/u);
  assert.match(documentation, /None of these read-only observations auto-passes\s+G6\.13/u);
});

test('G15.1 network denial requires token-bound policy and listener evidence', async () => {
  const { readFile } = await import('node:fs/promises');
  const launcher = await readFile(new URL('./AppContainerLauncher.cs', import.meta.url), 'utf8');
  const probes = await readFile(new URL('./run-probes.ps1', import.meta.url), 'utf8');

  const deriveStart = launcher.indexOf('private static bool TryDeriveNetworkCapabilitySids(');
  const deriveEnd = launcher.indexOf('\n    private static bool AddOwnedCapabilitySid', deriveStart);
  const tokenReadStart = launcher.indexOf('private static TokenCapabilitiesEvidence ReadTokenCapabilities(');
  const tokenReadEnd = launcher.indexOf('\n    private static bool TryDeriveSingleCapabilitySid', tokenReadStart);
  const policyStart = probes.indexOf('function Get-NetworkPolicyStatus(');
  const policyEnd = probes.indexOf('\nfunction Get-NetworkDeniedStatus', policyStart);
  const denialStart = probes.indexOf('function Get-NetworkDeniedStatus(');
  const denialEnd = probes.indexOf('\nfunction ConvertFrom-LoopbackConfigHelperOutput', denialStart);
  const networkStart = probes.indexOf("$currentPhase = 'loopback-network-probe'");
  const networkEnd = probes.indexOf("$currentPhase = 'process-tree-probe'", networkStart);
  const selfTestStart = probes.indexOf('$syntheticNetworkEvidence = [pscustomobject]@{');
  const selfTestEnd = probes.indexOf('$tokenChainSyntheticResult =', selfTestStart);
  assert.ok(deriveStart !== -1 && deriveEnd > deriveStart);
  assert.ok(tokenReadStart !== -1 && tokenReadEnd > tokenReadStart);
  assert.ok(policyStart !== -1 && policyEnd > policyStart);
  assert.ok(denialStart !== -1 && denialEnd > denialStart);
  assert.ok(networkStart !== -1 && networkEnd > networkStart);
  assert.ok(selfTestStart !== -1 && selfTestEnd > selfTestStart);

  const derivation = launcher.slice(deriveStart, deriveEnd);
  const tokenRead = launcher.slice(tokenReadStart, tokenReadEnd);
  const policy = probes.slice(policyStart, policyEnd);
  const denial = probes.slice(denialStart, denialEnd);
  const network = probes.slice(networkStart, networkEnd);
  const selfTest = probes.slice(selfTestStart, selfTestEnd);

  assert.match(derivation, /internetClient[\s\S]*internetClientServer[\s\S]*privateNetworkClientServer/u);
  assert.match(derivation, /EqualSid\(sid,[\s\S]*CleanupDuplicateCapabilitySids/u);
  assert.match(derivation, /TryDeriveSingleCapabilitySid[\s\S]*FreeNetworkCapabilitySids/u);
  assert.match(launcher, /LocalSize\(IntPtr memory\)/u);
  assert.match(launcher, /MAX_DERIVED_CAPABILITY_CLEANUP_SIDS = 16384/u);
  assert.match(launcher, /TryCollectReturnedCapabilitySids[\s\S]*LocalSize[\s\S]*MAX_DERIVED_CAPABILITY_CLEANUP_SIDS/u);
  assert.match(launcher, /DuplicateCapabilitySidCleanupSyntheticSelfTest\(\)/u);
  assert.match(launcher, /OverLimitCapabilitySidCleanupSyntheticSelfTest\(\)/u);
  assert.match(tokenRead, /TryDeriveNetworkCapabilitySids[\s\S]*TokenCapabilities[\s\S]*TryCountNetworkCapabilityMatches/u);
  assert.match(tokenRead, /AppContainerNetworkCapabilityCount|NetworkCapabilityCount/u);
  assert.match(policy, /worker_token_verified[\s\S]*job_membership_verified[\s\S]*capability_query_status[\s\S]*network_capability_count[\s\S]*loopback_helper_status[\s\S]*loopback_exemption/u);
  assert.match(denial, /listener_accepted[\s\S]*Get-NetworkPolicyStatus[\s\S]*host_control_status[\s\S]*target_matches_listener[\s\S]*worker_transport_status[\s\S]*ETIMEDOUT/u);
  assert.match(network, /networkTargetMatchesListener[\s\S]*AppContainerNetworkCapabilityCount[\s\S]*network_policy_status[\s\S]*network_capability_query_status[\s\S]*network_capability_count[\s\S]*network_capabilities_error_code/u);
  assert.doesNotMatch(network, /S-1-[0-9-]+|internetClientServer|privateNetworkClientServer|internetClient/u);
  for (const branch of [
    'Synthetic timeout with complete network policy evidence did not pass',
    'Synthetic accepted worker connection did not fail',
    'Synthetic positive network-capability evidence did not fail closed',
    'Synthetic loopback exemption did not remain unknown',
    'Synthetic failed capability derivation did not remain unknown',
    'Synthetic unverified worker token did not remain unknown',
    'Synthetic unverified Job membership did not remain unknown',
    'Synthetic failed host control did not remain unknown',
    'Synthetic mismatched listener target did not remain unknown',
  ]) assert.ok(selfTest.includes(branch), `missing synthetic network branch: ${branch}`);
  assert.match(selfTest, /S-1-\|internetClient\|privateNetworkClientServer\|internetClientServer/u);
});

test('AppContainer launcher quotes hook arguments and rejects unsupported worker modes before launch', { skip: process.platform !== 'win32' }, () => {
  const launcherPath = fileURLToPath(new URL('./AppContainerLauncher.cs', import.meta.url)).replace(/'/gu, "''");
  const script = [
    `$launcherSource = [System.IO.File]::ReadAllText('${launcherPath}')`,
    'Add-Type -TypeDefinition $launcherSource -Language CSharp -ErrorAction Stop',
    `$arguments = [AppContainerLauncher]::BuildModuleHookNodeArguments('C:\\quoted path\\module-hook.mjs', 'probe')`,
    `if (-not $arguments.StartsWith('--input-type=module -e "')) { throw 'bootstrap arguments were not quoted' }`,
    `if (-not $arguments.EndsWith(' "C:\\quoted path\\module-hook.mjs" "probe"')) { throw 'hook path or mode quoting changed' }`,
    '$modeRejected = $false',
    `try { [AppContainerLauncher]::BuildModuleHookNodeArguments('C:\\quoted path\\module-hook.mjs', 'unsupported') | Out-Null } catch [System.ArgumentOutOfRangeException] { $modeRejected = $true }`,
    `if (-not $modeRejected) { throw 'unsupported mode was accepted' }`,
    `Write-Output 'MODULE_HOOK_ARGUMENTS_PASS'`,
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /MODULE_HOOK_ARGUMENTS_PASS/u);
});

test('AppContainer environment treats an empty profile LocalAppData override as absent', { skip: process.platform !== 'win32' }, () => {
  // PowerShell converts $null to "" for string method parameters; GetFullPath("") would throw ArgumentException.
  const launcherPath = fileURLToPath(new URL('./AppContainerLauncher.cs', import.meta.url)).replace(/'/gu, "''");
  const script = [
    `$source = [System.IO.File]::ReadAllText('${launcherPath}')`,
    'Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop',
    "$workspace = [string](Join-Path ([System.IO.Path]::GetTempPath()) ('agentcp-env-' + [guid]::NewGuid().ToString('N')))",
    '$null = New-Item -ItemType Directory -Force -Path $workspace',
    "$method = [AppContainerLauncher].GetMethod('BuildEnvironment', [Reflection.BindingFlags]'NonPublic,Static')",
    "try { foreach ($override in @($null, '')) { $ptr = $method.Invoke($null, @('C:\\node\\node.exe', $workspace, 'AgentCP0123456789abcdef0', $override, $true)); [System.Runtime.InteropServices.Marshal]::FreeHGlobal([IntPtr]$ptr) } Write-Output 'EMPTY_OVERRIDE_PASS' } finally { Remove-Item -LiteralPath $workspace -Recurse -Force }",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /EMPTY_OVERRIDE_PASS/u);
});
