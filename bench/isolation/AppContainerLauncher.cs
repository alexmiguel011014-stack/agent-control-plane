using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;

public sealed class AppContainerRunResult
{
    public int ExitCode { get; set; }
    public bool TimedOut { get; set; }
    public bool RootProcessSignaled { get; set; }
    public bool JobDrained { get; set; }
    public uint? ActiveProcessesAfterDrain { get; set; }
    public int ActiveProcessQueryErrorCode { get; set; }
    public int DrainPollWaitCode { get; set; }
    public string DrainDiagnostic { get; set; }
    public bool WorkerTokenVerified { get; set; }
    public string AppContainerCapabilitiesStatus { get; set; }
    public uint? AppContainerCapabilityCount { get; set; }
    public uint? AppContainerNetworkCapabilityCount { get; set; }
    public int? AppContainerCapabilitiesErrorCode { get; set; }
    public bool JobMembershipVerified { get; set; }
    public bool OutputTruncated { get; set; }
    public long DurationMs { get; set; }
    public string DeadlineDecision { get; set; }
    public uint? DeadlineActiveProcesses { get; set; }
    public int? DeadlineQueryErrorCode { get; set; }
    public string DeadlineDiagnostic { get; set; }
    public string JobMemberDiagnosticsStatus { get; set; }
    public bool? JobMemberJobSetStable { get; set; }
    public uint? JobMemberAssignedCount { get; set; }
    public uint? JobMemberReturnedCount { get; set; }
    public uint? JobMemberOpenCount { get; set; }
    public uint? JobMemberMembershipVerifiedCount { get; set; }
    public uint? JobMemberNotInJobCount { get; set; }
    public uint? JobMemberMembershipUnknownCount { get; set; }
    public uint? JobMemberNodeImageCount { get; set; }
    public uint? JobMemberConsoleHostImageCount { get; set; }
    public uint? JobMemberCommandShellImageCount { get; set; }
    public uint? JobMemberOtherImageCount { get; set; }
    public uint? JobMemberImageUnknownCount { get; set; }
    public uint? JobMemberMetadataUnknownCount { get; set; }
    public int? JobMemberCleanupErrorCode { get; set; }
    public int? JobMemberQueryErrorCode { get; set; }
    public string ProcessTreeStage { get; set; }
    public string ProcessTreeFailureStage { get; set; }
    public string ProcessTreeFailureExceptionType { get; set; }
    public int? ProcessTreeFailureHResult { get; set; }
    public int? ProcessTreeFailureWin32Code { get; set; }
    public string ProcessTreeCleanupFailureStage { get; set; }
    public string ProcessTreeCleanupFailureExceptionType { get; set; }
    public int? ProcessTreeCleanupFailureHResult { get; set; }
    public int? ProcessTreeCleanupFailureWin32Code { get; set; }
    public string ProcessTreeStatus { get; set; }
    public string Stdout { get; set; }
    public string Stderr { get; set; }

    public AppContainerRunResult()
    {
        JobMemberDiagnosticsStatus = "UNKNOWN";
        AppContainerCapabilitiesStatus = "UNKNOWN";
        ProcessTreeStage = "PREFLIGHT";
        ProcessTreeFailureStage = "NONE";
        ProcessTreeStatus = "UNKNOWN";
    }
}

public sealed class LoopbackConfigChildRunResult
{
    public bool ProcessCreated { get; set; }
    public bool TimedOut { get; set; }
    public bool OutputTruncated { get; set; }
    public bool RootProcessSignaled { get; set; }
    public bool JobDrained { get; set; }
    public bool TerminateJobSucceeded { get; set; }
    public bool CleanupConfirmed { get; set; }
    public int? ExitCode { get; set; }
    public int? ErrorCode { get; set; }
    public long DurationMs { get; set; }
    public string Stdout { get; set; }

    public LoopbackConfigChildRunResult()
    {
        Stdout = String.Empty;
    }
}

public sealed class LoopbackConfigObservation
{
    public int schema_version { get; set; }
    public string loopback_exemption { get; set; }
    public uint? entry_count { get; set; }
    public int? error_code { get; set; }
    public string cleanup_status { get; set; }
    public int? cleanup_error_code { get; set; }

    public LoopbackConfigObservation()
    {
        schema_version = 1;
        loopback_exemption = "UNKNOWN";
        cleanup_status = "UNKNOWN";
    }
}

internal delegate bool LoopbackHeapFreeDelegate(IntPtr heap, IntPtr memory);
internal delegate int LoopbackHeapFreeErrorDelegate();

public sealed class JobMemberSnapshotEvidence
{
    public bool QuerySucceeded { get; set; }
    public bool QueryComplete { get; set; }
    public uint AssignedCount { get; set; }
    public uint ReturnedCount { get; set; }
    public bool? JobSetStable { get; set; }
    public bool MembershipMismatch { get; set; }
    public uint OpenCount { get; set; }
    public uint MembershipVerifiedCount { get; set; }
    public uint NotInJobCount { get; set; }
    public uint MembershipUnknownCount { get; set; }
    public bool MetadataSnapshotComplete { get; set; }
    public uint MetadataUnknownCount { get; set; }
    public int QueryErrorCode { get; set; }
    public int CleanupErrorCode { get; set; }
}

public sealed class HostProcessTreeTestRunResult
{
    public string Stage { get; set; }
    public bool ProcessCreated { get; set; }
    public bool RootPidValid { get; set; }
    public uint RootProcessIdForComparison { get; set; }
    public bool JobMembershipVerified { get; set; }
    public bool TimedOut { get; set; }
    public bool TerminateJobSucceeded { get; set; }
    public bool RootProcessSignaled { get; set; }
    public int? RootExitCode { get; set; }
    public uint? ActiveProcessesAtDeadline { get; set; }
    public bool ActiveProcessLimitQuerySucceeded { get; set; }
    public bool EffectiveActiveProcessLimitEnabled { get; set; }
    public uint? EffectiveActiveProcessLimit { get; set; }
    public int ActiveProcessLimitQueryErrorCode { get; set; }
    public bool JobAccountingQuerySucceeded { get; set; }
    public uint? TotalProcessesAtDeadline { get; set; }
    public uint? TotalTerminatedProcessesAtDeadline { get; set; }
    public uint? AccountingExcessOverJobPidListCount { get; set; }
    public bool AccountingExcessCoveredByTerminationCount { get; set; }
    public int JobAccountingQueryErrorCode { get; set; }
    public bool JobProcessIdListQuerySucceeded { get; set; }
    public bool JobProcessIdListComplete { get; set; }
    public uint? JobProcessIdAssignedCount { get; set; }
    public uint? JobProcessIdReturnedCount { get; set; }
    public int JobProcessIdListQueryErrorCode { get; set; }
    public uint[] JobProcessIdsAtDeadline { get; set; }
    public string JobMemberDiagnosticsStatus { get; set; }
    public bool? JobMemberJobSetStable { get; set; }
    public uint? JobMemberOpenCount { get; set; }
    public uint? JobMemberMembershipVerifiedCount { get; set; }
    public uint? JobMemberNotInJobCount { get; set; }
    public uint? JobMemberMembershipUnknownCount { get; set; }
    public uint? JobMemberNodeImageCount { get; set; }
    public uint? JobMemberConsoleHostImageCount { get; set; }
    public uint? JobMemberCommandShellImageCount { get; set; }
    public uint? JobMemberOtherImageCount { get; set; }
    public uint? JobMemberImageUnknownCount { get; set; }
    public uint? JobMemberParentIdMatchesJobMemberCount { get; set; }
    public uint? JobMemberMetadataUnknownCount { get; set; }
    public int? JobMemberCleanupErrorCode { get; set; }
    public bool JobDrained { get; set; }
    public uint? ActiveProcessesAfterDrain { get; set; }
    public bool OutputTruncated { get; set; }
    public bool CleanupConfirmed { get; set; }
    public int? ErrorCode { get; set; }
    public string Stdout { get; set; }

    public HostProcessTreeTestRunResult()
    {
        Stage = "PREFLIGHT";
        CleanupConfirmed = true;
        Stdout = String.Empty;
        JobProcessIdsAtDeadline = new uint[0];
        JobMemberDiagnosticsStatus = "UNKNOWN";
    }
}

public sealed class ProfilePathDiagnosticResult
{
    public int ApiHResult { get; set; }
    public bool CandidateMatched { get; set; }
}

public sealed class ProfileMappingReadOnlyResult
{
    public int? SidDerivationHResult { get; set; }
    public int? ApiHResult { get; set; }
    public bool PathPresent { get; set; }
}

public sealed class ProcessTokenChainDiagnosticRow
{
    public int depth { get; set; }
    public string link_status { get; set; }
    public string token_is_appcontainer { get; set; }
    public string appcontainer_sid_presence { get; set; }
    public string package_identity { get; set; }
}

public sealed class ProcessTokenChainDiagnosticResult
{
    public int schema_version { get; set; }
    public string status { get; set; }
    public string stage { get; set; }
    public bool truncated { get; set; }
    public ProcessTokenChainDiagnosticRow[] processes { get; set; }

    public ProcessTokenChainDiagnosticResult()
    {
        schema_version = 1;
        status = "UNKNOWN";
        stage = "PROCESS_SNAPSHOT";
        processes = new ProcessTokenChainDiagnosticRow[0];
    }
}

public sealed class BoundedRegistryStringValueResult
{
    public string Status { get; set; }
    public string Value { get; set; }
    public int ByteLength { get; set; }
}

public sealed class BoundedRegistryKeyNameResult
{
    public string Status { get; set; }
    public string Name { get; set; }
}

public sealed class ProfileMappingScanChangeMonitor : IDisposable
{
    internal SafeWaitHandle EventHandle { get; set; }
    internal uint InitialSubKeyCount { get; set; }
    internal ulong InitialLastWriteTime { get; set; }
    public string Status { get; set; }

    public void Dispose()
    {
        if (EventHandle != null)
        {
            EventHandle.Dispose();
            EventHandle = null;
        }
    }
}

public sealed class SuspendedStartupVariantResult
{
    public bool Attempted { get; set; }
    public bool ProcessCreated { get; set; }
    public bool JobListAttributeAttempted { get; set; }
    public bool JobListAttributeSucceeded { get; set; }
    public bool JobMembershipVerified { get; set; }
    public bool AppContainerTokenVerified { get; set; }
    public bool SeChangeNotifyPrivilegeQuerySucceeded { get; set; }
    public bool? SeChangeNotifyPrivilegePresent { get; set; }
    public bool? SeChangeNotifyPrivilegeEnabled { get; set; }
    public DirectoryTraverseAccessDiagnostic[] DirectoryTraverseDiagnostics { get; set; }
    public StagedFileReadDiagnostic[] StagedFileReadDiagnostics { get; set; }
    public bool TerminateJobSucceeded { get; set; }
    public bool TerminateProcessSucceeded { get; set; }
    public bool FallbackUsed { get; set; }
    public bool JobClosedForFallback { get; set; }
    public bool CleanupConfirmed { get; set; }
    public string CleanupStatus { get; set; }
    public bool Passed { get; set; }
    public int SetupErrorCode { get; set; }
    public int CreateErrorCode { get; set; }
    public int JobListAttributeErrorCode { get; set; }
    public int MembershipErrorCode { get; set; }
    public int TokenErrorCode { get; set; }
    public int TerminateJobErrorCode { get; set; }
    public int ProcessWaitCode { get; set; }
    public bool RootProcessSignaled { get; set; }
    public bool JobDrained { get; set; }
    public uint? ActiveProcessesAfterDrain { get; set; }
    public int ActiveProcessQueryErrorCode { get; set; }
    public int DrainPollWaitCode { get; set; }
    public string DrainDiagnostic { get; set; }
    public int RetryTerminateErrorCode { get; set; }
    public int RetryTerminateProcessErrorCode { get; set; }
    public int TerminateProcessErrorCode { get; set; }
    public int FallbackProcessWaitCode { get; set; }
    public int FinalProcessWaitCode { get; set; }
    public int JobCloseErrorCode { get; set; }
    public int ResourceCleanupErrorCode { get; set; }
    public bool FallbackRootProcessSignaled { get; set; }
    public bool FinalRootProcessSignaled { get; set; }

    public SuspendedStartupVariantResult()
    {
        CleanupStatus = "UNKNOWN";
        DirectoryTraverseDiagnostics = new DirectoryTraverseAccessDiagnostic[0];
        StagedFileReadDiagnostics = new StagedFileReadDiagnostic[0];
    }
}

public sealed class StartupAttributeDiagnosticResult
{
    public SuspendedStartupVariantResult Control { get; set; }
    public SuspendedStartupVariantResult AppContainer { get; set; }

    public StartupAttributeDiagnosticResult()
    {
        Control = new SuspendedStartupVariantResult();
        AppContainer = new SuspendedStartupVariantResult();
    }
}

public sealed class DirectoryTraverseAccessDiagnostic
{
    public string Label { get; set; }
    public string Status { get; set; }
    public string ReadAttributesStatus { get; set; }
}

public sealed class StagedFileReadDiagnostic
{
    public string Label { get; set; }
    public string ReadAttributesStatus { get; set; }
    public string ReadDataStatus { get; set; }
}

public static class AppContainerLauncher
{
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    private const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const string PROCESS_TREE_CHILD_SCRIPT_SHA256 = "dccb219a1c028dcec74060b7f7ff8ce8c45c68ebb81e0d88d47bec4497825518";
    private const string PROCESS_TREE_GRANDCHILD_SCRIPT_SHA256 = "9356e6b9c3d7fdc50fef5fe9071b20e920b88e790a91be5bca3f07663f5e83ed";
    private static readonly UIntPtr MAX_JOB_MEMORY_BYTES = new UIntPtr(1024UL * 1024UL * 1024UL);
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicLimitInformation = 2;
    private const int JobObjectBasicProcessIdList = 3;
    private const int MAX_JOB_PROCESS_ID_LIST_CAPACITY = 8;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const int ERROR_NO_MORE_ITEMS = 259;
    private const int ERROR_NO_MORE_FILES = 18;
    private const int ERROR_MORE_DATA = 234;
    private const uint ERROR_BROKEN_PIPE = 109;
    private const int ERROR_SUCCESS = 0;
    private const int ERROR_FILE_NOT_FOUND = 2;
    private const uint REG_SZ = 1;
    private const int MAX_PROFILE_MAPPING_VALUE_BYTES = 512;
    private const int MAX_PROFILE_MAPPING_KEYS = 2048;
    private const int MAX_PROFILE_MAPPING_KEY_NAME_CHARS = 256;
    private const uint REG_NOTIFY_CHANGE_NAME = 0x00000001;
    private const uint REG_NOTIFY_CHANGE_LAST_SET = 0x00000004;
    private const uint THREAD_TERMINATE = 0x0001;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint TOKEN_DUPLICATE = 0x0002;
    private const uint TOKEN_IMPERSONATE = 0x0004;
    private const uint SE_PRIVILEGE_ENABLED = 0x00000002;
    private const uint FILE_TRAVERSE = 0x00000020;
    private const uint FILE_READ_DATA = 0x00000001;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const int TokenPrivileges = 3;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    private const int ERROR_INVALID_DATA = 13;
    private const int SecurityImpersonation = 2;
    private const int TokenImpersonation = 2;
    private const int TokenIsAppContainer = 29;
    private const int TokenCapabilities = 30;
    private const int TokenAppContainerSid = 31;
    private const int APPMODEL_ERROR_NO_PACKAGE = 15700;
    private const int MAX_PROCESS_CHAIN_ENTRIES = 4096;
    private const int MAX_PROCESS_CHAIN_ENUMERATION = 4097;
    private const int MAX_PROCESS_CHAIN_ANCESTORS = 8;
    private const int MAX_PROCESS_CHAIN_TOKEN_BUFFER_BYTES = 1024;
    private const int MAX_WORKER_TOKEN_BUFFER_BYTES = 65536;
    private const int MAX_WORKER_TOKEN_CAPABILITIES = 256;
    private const int MAX_DERIVED_CAPABILITY_SIDS = 16;
    private const int MAX_DERIVED_CAPABILITY_CLEANUP_SIDS = 16384;
    private const int MAX_DERIVED_CAPABILITY_ARRAY_BYTES = 65536;
    private const int MAX_LOOPBACK_CONFIG_ENTRIES = 4096;
    private const int MAX_LOOPBACK_CONFIG_TRAVERSAL_MS = 250;
    private const int LOOPBACK_CONFIG_CHILD_TIMEOUT_MS = 5000;
    private const int MAX_LOOPBACK_CONFIG_INPUT_BYTES = 256;
    private const int MAX_LOOPBACK_CONFIG_OUTPUT_BYTES = 4096;
    private const int MAX_INPUT_JSON_BYTES = 65536;
    private const int MAX_CAPTURE_BYTES = 1048576;
    private const uint MAX_PIPE_DRAIN_PER_TICK = 65536;
    private const uint MAX_TASK_TIMEOUT_MS = 600000;
    private const string INLINE_STDIO_SMOKE_INPUT_JSON = "{\"probe\":\"stdio-smoke\"}";
    private const string INLINE_STDIO_SMOKE_SCRIPT =
        "let n=0,tooLarge=false;" +
        "process.stdin.on('data',b=>{n+=b.length;if(n>65537){tooLarge=true;process.exitCode=2;process.stdin.destroy();}});" +
        "process.stdin.on('error',()=>{process.exitCode=1;});" +
        "process.stdin.on('end',()=>{if(!tooLarge)process.stdout.write('INPUT_OK:'+n+'\\n',e=>{if(e)process.exitCode=1;if(typeof process.stdin.pause==='function')process.stdin.pause();if(typeof process.stdin.unref==='function')process.stdin.unref();if(typeof process.stdout.unref==='function')process.stdout.unref();});});" +
        "process.stdout.write('BOOT\\n',e=>{if(e){process.exitCode=1;return;}process.stdin.resume();});";
    private const string MODULE_HOOK_BOOTSTRAP =
        "import { readFileSync } from 'node:fs';" +
        "import path from 'node:path';" +
        "const [hookPath, mode, ...workerArguments] = process.argv.slice(1);" +
        "const argsValid = (mode === 'probe' && workerArguments.length <= 1 && workerArguments.every((argument) => argument === '--child' || argument === '--grandchild')) || (mode === 'production' && workerArguments.length === 0);" +
        "async function start() { if (!argsValid || typeof hookPath !== 'string' || hookPath.length === 0) throw new Error(); const hookBytes = readFileSync(hookPath); if (hookBytes.byteLength > 262144) throw new Error(); const hook = await import('data:text/javascript;base64,' + hookBytes.toString('base64')); if (typeof hook.startModuleWorker !== 'function') throw new Error(); await hook.startModuleWorker({ mode, toolsRoot: path.dirname(path.resolve(hookPath)), workspaceRoot: process.cwd(), workerArguments }); }" +
        "start().catch(() => { process.stdout.write('{\"mode\":\"error\",\"code\":\"MODULE_HOOK_FAILURE\"}\\n'); process.exitCode = 2; });";
    private const int MAX_STAGED_READ_DIAGNOSTIC_INPUT_BYTES = 4095;
    private const int MAX_PROFILE_CONTRACT_DIAGNOSTIC_INPUT_BYTES = 255;
    private const int MAX_PROFILE_BOOTSTRAP_DIAGNOSTIC_INPUT_BYTES = 64;
    private const string PROFILE_BOOTSTRAP_DIAGNOSTIC_SCRIPT =
        "'use strict';" +
        "const fs=require('node:fs/promises'),path=require('node:path');" +
        "const MAX_INPUT=64,MAX_OUTPUT=2048,CODES=new Set(['EACCES','EPERM','ENOENT','EEXIST','EBADF','EISDIR','ENOTDIR','ELOOP','EBUSY','INVALID_REQUEST','LIMIT_EXCEEDED','INVALID_PROFILE_PATH','NOT_DIRECTORY','SYMLINK','TEMP_CREATE_FAILED','MARKER_EXISTS','MARKER_MISMATCH','UNKNOWN']);" +
        "const blank=(code='NOT_RUN')=>({schema_version:1,status:'FAIL',profile_path_shape:'SKIPPED',profile_path_checks:{local_drive_absolute:null,local_no_stream:null,local_canonical:null,local_leaf_is_ac:null,parent_matches_nonce_name:null,parent_matches_nonce_name_ordinal_ignore_case:null,grandparent_is_packages:null,temp_matches_local_child:null,tmp_matches_local_child:null},temp_existed_before:null,temp_create_status:'NOT_RUN',temp_created_by_diagnostic:false,marker_created_by_diagnostic:false,marker_write_status:'NOT_RUN',marker_read_status:'NOT_RUN',marker_delete_status:'NOT_RUN',marker_absent:null,error_code:code});" +
        "function safeCode(error){let code;try{code=error&&error.code;}catch{}return typeof code==='string'&&CODES.has(code)?code:'UNKNOWN';}" +
        "async function readInput(){const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>MAX_INPUT)throw Object.assign(new Error(),{code:'LIMIT_EXCEEDED'});chunks.push(chunk);}return Buffer.concat(chunks,size);}" +
        "function exactKeys(value,keys){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\\0')===[...keys].sort().join('\\0');}" +
        "function isMissing(error){return safeCode(error)==='ENOENT'||safeCode(error)==='ENOTDIR';}" +
        "function getProfilePathChecks(local,tempEnv,tmpEnv,name){const localIsString=typeof local==='string',localBounded=localIsString&&local.length<=32767,parent=localIsString?path.win32.basename(path.win32.dirname(local)):null;function ordinalIgnoreCaseAscii(left,right){if(typeof left!=='string'||typeof right!=='string'||left.length!==right.length)return false;for(let index=0;index<left.length;index++){let a=left.charCodeAt(index),b=right.charCodeAt(index);if(a>=97&&a<=122)a-=32;if(b>=97&&b<=122)b-=32;if(a!==b)return false;}return true;}return{local_drive_absolute:localBounded&&/^[a-zA-Z]:\\\\/.test(local),local_no_stream:localIsString&&local.indexOf(':',2)===-1,local_canonical:localBounded&&path.win32.resolve(local).toLowerCase()===local.toLowerCase(),local_leaf_is_ac:localIsString&&path.win32.basename(local)==='AC',parent_matches_nonce_name:localIsString&&parent===name,parent_matches_nonce_name_ordinal_ignore_case:localIsString&&ordinalIgnoreCaseAscii(parent,name),grandparent_is_packages:localIsString&&path.win32.basename(path.win32.dirname(path.win32.dirname(local)))==='Packages',temp_matches_local_child:localBounded&&typeof tempEnv==='string'&&path.win32.resolve(tempEnv).toLowerCase()===path.win32.join(local,'Temp').toLowerCase(),tmp_matches_local_child:localBounded&&typeof tmpEnv==='string'&&path.win32.resolve(tmpEnv).toLowerCase()===path.win32.join(local,'Temp').toLowerCase()};}function profilePathAccepted(checks){return checks.local_drive_absolute===true&&checks.local_no_stream===true&&checks.local_canonical===true&&checks.local_leaf_is_ac===true&&checks.parent_matches_nonce_name_ordinal_ignore_case===true&&checks.grandparent_is_packages===true&&checks.temp_matches_local_child===true&&checks.tmp_matches_local_child===true;}" +
        "async function main(){let request;try{request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readInput()));}catch(error){return blank(safeCode(error)==='LIMIT_EXCEEDED'?'LIMIT_EXCEEDED':'INVALID_REQUEST');}if(!exactKeys(request,['nonce'])||typeof request.nonce!=='string'||!/^[0-9a-f]{32}$/.test(request.nonce))return blank('INVALID_REQUEST');const local=process.env.LOCALAPPDATA,tempEnv=process.env.TEMP,tmpEnv=process.env.TMP,name='AgentCP'+request.nonce.slice(0,17);const profilePathChecks=getProfilePathChecks(local,tempEnv,tmpEnv,name);if(!profilePathAccepted(profilePathChecks)){const failed=blank('INVALID_PROFILE_PATH');failed.profile_path_shape='FAIL';failed.profile_path_checks=profilePathChecks;return failed;}const result={...blank(null),status:'FAIL',profile_path_shape:'PASS',profile_path_checks:profilePathChecks,temp_existed_before:null,temp_create_status:'NOT_RUN',temp_created_by_diagnostic:false,marker_created_by_diagnostic:false,marker_write_status:'NOT_RUN',marker_read_status:'NOT_RUN',marker_delete_status:'NOT_RUN',marker_absent:null,error_code:null};const temp=path.win32.join(local,'Temp'),marker=path.win32.join(temp,'agentcp-bootstrap-'+request.nonce+'.marker'),markerText='AgentCPBootstrapMarker:'+request.nonce;let markerHandle=null,markerOwned=false;try{try{const stat=await fs.lstat(temp);result.temp_existed_before=true;if(stat.isSymbolicLink()||!stat.isDirectory()){result.temp_create_status='FAIL';result.error_code=stat.isSymbolicLink()?'SYMLINK':'NOT_DIRECTORY';return result;}result.temp_create_status='ALREADY_PRESENT';}catch(error){if(!isMissing(error))throw error;result.temp_existed_before=false;await fs.mkdir(local,{recursive:true});await fs.mkdir(temp);result.temp_created_by_diagnostic=true;result.temp_create_status='CREATED';}try{await fs.lstat(marker);result.error_code='MARKER_EXISTS';result.temp_create_status=result.temp_create_status==='NOT_RUN'?'FAIL':result.temp_create_status;return result;}catch(error){if(!isMissing(error))throw error;}markerHandle=await fs.open(marker,'wx');markerOwned=true;result.marker_created_by_diagnostic=true;await markerHandle.writeFile(markerText,'utf8');await markerHandle.close();markerHandle=null;result.marker_write_status='PASS';const observed=await fs.readFile(marker,'utf8');if(observed!==markerText){result.marker_read_status='FAIL';result.error_code='MARKER_MISMATCH';}else result.marker_read_status='PASS';if(result.error_code===null){await fs.unlink(marker);markerOwned=false;result.marker_delete_status='PASS';}else result.marker_delete_status='FAIL';try{await fs.lstat(marker);result.marker_absent=false;}catch(error){result.marker_absent=isMissing(error);if(!result.marker_absent&&result.error_code===null)result.error_code=safeCode(error);}if(result.error_code===null&&result.marker_absent)result.status='PASS';}catch(error){result.error_code=safeCode(error);if(result.temp_create_status==='NOT_RUN')result.temp_create_status='FAIL';if(markerHandle){try{await markerHandle.close();}catch{}markerHandle=null;}if(markerOwned){try{const existing=await fs.readFile(marker,'utf8');if(existing===markerText){await fs.unlink(marker);result.marker_delete_status='PASS';markerOwned=false;}else result.marker_delete_status='FAIL';}catch(cleanupError){result.marker_delete_status='FAIL';}}try{await fs.lstat(marker);result.marker_absent=false;}catch(missingError){result.marker_absent=isMissing(missingError);}}return result;}" +
        "function emit(result){let output=JSON.stringify(result);if(Buffer.byteLength(output,'utf8')+1>MAX_OUTPUT)output=JSON.stringify(blank('LIMIT_EXCEEDED'));process.stdout.write(output+'\\n');}" +
        "main().then(emit,()=>emit(blank('UNKNOWN')));";
    private const string STAGED_FILE_READ_DIAGNOSTIC_SCRIPT =
        "'use strict';" +
        "const fs=require('node:fs/promises'),path=require('node:path'),{pathToFileURL}=require('node:url');" +
        "const LABELS=['workerModule','probeContract'],MAX_INPUT=4096,MAX_FILE=262144,MAX_OUTPUT=4096,MAX_ANCESTORS=32;" +
        "const CODES=new Set(['EACCES','EPERM','ENOENT','EBADF','EISDIR','ENOTDIR','ELOOP','EMFILE','ENFILE','ERR_MODULE_NOT_FOUND','ERR_UNKNOWN_FILE_EXTENSION','ERR_UNSUPPORTED_DIR_IMPORT','NOT_RUN','NOT_REGULAR','NOT_DIRECTORY','SYMLINK','TOO_LARGE','FILE_CHANGED','INCOMPLETE','INVALID_PATH','PATH_MISMATCH','CHAIN_TOO_DEEP','LIMIT_EXCEEDED','INVALID_REQUEST','EXPORT_SHAPE','UNKNOWN']);" +
        "const IMPORT_SYSCALLS=new Set(['access','lstat','open','read','readlink','realpath','stat']);" +
        "const op=(operation,status,error_code)=>({operation,status,error_code});" +
        "const tuple=(operation,status,error_code)=>[operation,status,error_code];" +
        "const importOp=(status,error_code=null,syscall=null,path_label=null)=>({operation:'import',status,error_code,syscall,path_label});" +
        "const blankResult=(code='NOT_RUN')=>({schema_version:1,files:LABELS.map(label=>({label,lstat:op('lstat','SKIPPED',code),read:op('read','SKIPPED',code)})),ancestor_chain:op('ancestor_chain','SKIPPED',code),ancestors:[],import:importOp('SKIPPED',code)});" +
        "function safeCode(error){let code;try{code=error&&error.code;}catch{}return typeof code==='string'&&CODES.has(code)?code:'UNKNOWN';}" +
        "function failed(operation,error){const code=safeCode(error);return op(operation,code==='EACCES'||code==='EPERM'?'DENIED':'FAIL',code);}" +
        "async function readInput(){const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>MAX_INPUT)throw Object.assign(new Error(),{code:'LIMIT_EXCEEDED'});chunks.push(chunk);}return Buffer.concat(chunks,size);}" +
        "function exactKeys(value,keys){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\\0')===[...keys].sort().join('\\0');}" +
        "function normalizeLocalPath(value){try{if(typeof value!=='string'||value.length===0||value.length>32767)return null;let candidate=value;if(candidate.slice(0,5).toLowerCase()==='file:'){const url=new URL(candidate);if(url.protocol!=='file:'||(url.hostname!==''&&url.hostname.toLowerCase()!=='localhost')||url.username||url.password||url.port||url.search||url.hash)return null;const decoded=decodeURIComponent(url.pathname);if(decoded[0]!=='/'||!/[a-z]/i.test(decoded[1]||'')||decoded[2]!==':'||decoded[3]!=='/')return null;candidate=decoded.slice(1).replace(/\\//g,'\\\\');}else if(candidate.charCodeAt(0)===92&&candidate.charCodeAt(1)===92&&candidate[2]==='?'&&candidate.charCodeAt(3)===92)candidate=candidate.slice(4);if(!/[a-z]/i.test(candidate[0]||'')||candidate[1]!==':'||candidate.length<3||(candidate[2]!=='/'&&candidate.charCodeAt(2)!==92)||(candidate.charCodeAt(0)===92&&candidate.charCodeAt(1)===92))return null;const normalized=path.win32.resolve(candidate).toLowerCase(),root=path.win32.parse(normalized).root;if(!/[a-z]/i.test(root[0]||'')||root[1]!==':'||root.length!==3||root.charCodeAt(2)!==92)return null;return normalized;}catch{return null;}}" +
        "function mapImportPath(value,expectedWorker,expectedContract,ancestorPaths){const normalized=normalizeLocalPath(value);if(!normalized)return null;const candidates=[['workerModule',normalizeLocalPath(expectedWorker)],['probeContract',normalizeLocalPath(expectedContract)]];if(Array.isArray(ancestorPaths)&&ancestorPaths.length<=MAX_ANCESTORS)for(let index=0;index<ancestorPaths.length;index++)candidates.push(['ancestor'+String(index).padStart(2,'0'),normalizeLocalPath(ancestorPaths[index])]);const matches=candidates.filter(entry=>entry[1]!==null&&entry[1]===normalized);return matches.length===1?matches[0][0]:null;}" +
        "function importFailure(error,expectedWorker,expectedContract,ancestorPaths){const code=safeCode(error);let rawSyscall=null,rawPath=null;try{rawSyscall=error&&error.syscall;}catch{}try{rawPath=error&&error.path;}catch{}const syscall=typeof rawSyscall==='string'&&IMPORT_SYSCALLS.has(rawSyscall)?rawSyscall:null,path_label=mapImportPath(rawPath,expectedWorker,expectedContract,ancestorPaths);return importOp(code==='EACCES'||code==='EPERM'?'DENIED':'FAIL',code,syscall,path_label);}" +
        "function buildAncestorPaths(toolsRoot){const normalized=normalizeLocalPath(toolsRoot);if(!normalized)return{paths:null,error:'INVALID_PATH'};let current=path.win32.resolve(normalized);const root=path.win32.parse(current).root;if(!/[a-z]/i.test(root[0]||'')||root[1]!==':'||root.length!==3||root.charCodeAt(2)!==92)return{paths:null,error:'INVALID_PATH'};const reversed=[];for(;;){if(reversed.length>=MAX_ANCESTORS)return{paths:null,error:'CHAIN_TOO_DEEP'};reversed.push(current);if(current.toLowerCase()===root.toLowerCase())return{paths:reversed.reverse(),error:null};const parent=path.win32.dirname(current);if(parent.toLowerCase()===current.toLowerCase())return{paths:null,error:'INVALID_PATH'};current=parent;}}" +
        "async function inspectAncestor(label,filePath){let lstatResult,realpathResult;try{const stat=await fs.lstat(filePath);lstatResult=stat.isSymbolicLink()?tuple('lstat','FAIL','SYMLINK'):stat.isDirectory()?tuple('lstat','PASS',null):tuple('lstat','FAIL','NOT_DIRECTORY');}catch(error){const result=failed('lstat',error);lstatResult=tuple(result.operation,result.status,result.error_code);}try{const actual=normalizeLocalPath(await fs.realpath(filePath)),expected=normalizeLocalPath(filePath);realpathResult=actual!==null&&actual===expected?tuple('realpath','PASS',null):tuple('realpath','FAIL','PATH_MISMATCH');}catch(error){const result=failed('realpath',error);realpathResult=tuple(result.operation,result.status,result.error_code);}return{label,lstat:lstatResult,realpath:realpathResult};}" +
        "async function inspectAncestors(toolsRoot){const chain=buildAncestorPaths(toolsRoot);if(!chain.paths)return{status:'UNKNOWN',error_code:chain.error,ancestors:[],paths:null};const ancestors=[];for(let index=0;index<chain.paths.length;index++)ancestors.push(await inspectAncestor('ancestor'+String(index).padStart(2,'0'),chain.paths[index]));return{status:'PASS',error_code:null,ancestors,paths:chain.paths};}" +
        "async function readBounded(filePath,statSize){if(!Number.isSafeInteger(statSize)||statSize<0)return op('read','FAIL','UNKNOWN');if(statSize>MAX_FILE)return op('read','FAIL','TOO_LARGE');let handle=null,buffer=null,result=null;try{handle=await fs.open(filePath,'r');const opened=await handle.stat();if(!opened.isFile())result=op('read','FAIL','NOT_REGULAR');else if(opened.size>MAX_FILE)result=op('read','FAIL','TOO_LARGE');else if(opened.size!==statSize)result=op('read','FAIL','FILE_CHANGED');else{buffer=Buffer.alloc(16384);let total=0;while(total<statSize){const remaining=statSize-total;const{bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,remaining),null);if(bytesRead===0){result=op('read','FAIL','INCOMPLETE');break;}total+=bytesRead;}if(!result){const finalStat=await handle.stat();result=finalStat.size===statSize?op('read','PASS',null):op('read','FAIL','FILE_CHANGED');}}}catch(error){result=failed('read',error);}finally{if(buffer)buffer.fill(0);if(handle)try{await handle.close();}catch(error){if(result&&result.status==='PASS')result=failed('read',error);}}return result||op('read','FAIL','UNKNOWN');}" +
        "async function inspect(label,filePath){let stat;try{stat=await fs.lstat(filePath);}catch(error){return{label,lstat:failed('lstat',error),read:op('read','SKIPPED','NOT_RUN')};}if(!stat.isFile()||stat.isSymbolicLink())return{label,lstat:op('lstat','FAIL','NOT_REGULAR'),read:op('read','SKIPPED','NOT_RUN')};const lstat=op('lstat','PASS',null),read=await readBounded(filePath,stat.size);return{label,lstat,read};}" +
        "async function main(){let request,bytes;try{bytes=await readInput();request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(error){return blankResult(error&&error.code==='LIMIT_EXCEEDED'?'LIMIT_EXCEEDED':'INVALID_REQUEST');}" +
        "if(!exactKeys(request,['workerModule','probeContract'])||typeof request.workerModule!=='string'||typeof request.probeContract!=='string')return blankResult('INVALID_REQUEST');" +
        "const expectedTools=path.win32.resolve(path.win32.dirname(process.cwd()),'tools'),expectedWorker=path.win32.join(expectedTools,'worker.mjs'),expectedContract=path.win32.join(expectedTools,'probe-contract.mjs');" +
        "if(path.win32.resolve(request.workerModule).toLowerCase()!==expectedWorker.toLowerCase()||path.win32.resolve(request.probeContract).toLowerCase()!==expectedContract.toLowerCase())return blankResult('INVALID_REQUEST');" +
        "const files=[await inspect(LABELS[0],expectedWorker),await inspect(LABELS[1],expectedContract)],ancestorResult=await inspectAncestors(expectedTools);let importResult=importOp('SKIPPED','NOT_RUN');" +
        "if(files.every(file=>file.lstat.status==='PASS'&&file.read.status==='PASS')){try{const module=await import(pathToFileURL(expectedContract).href);importResult=typeof module.parseProbeRequest==='function'&&typeof module.classifyAccessError==='function'?importOp('PASS',null):importOp('FAIL','EXPORT_SHAPE');}catch(error){importResult=importFailure(error,expectedWorker,expectedContract,ancestorResult.paths);}}" +
        "return{schema_version:1,files,ancestor_chain:op('ancestor_chain',ancestorResult.status,ancestorResult.error_code),ancestors:ancestorResult.ancestors,import:importResult};}" +
        "function emit(result){let output=JSON.stringify(result);if(Buffer.byteLength(output,'utf8')+1>MAX_OUTPUT)output=JSON.stringify(blankResult('LIMIT_EXCEEDED'));process.stdout.write(output+'\\n');}" +
        "main().then(emit,()=>emit(blankResult('UNKNOWN')));";
    private const string PROFILE_CONTRACT_IMPORT_DIAGNOSTIC_SCRIPT =
        "'use strict';" +
        "const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto'),{pathToFileURL}=require('node:url');" +
        "const LABEL='profileContractTemp',MAX_INPUT=256,MAX_FILE=262144,MAX_OUTPUT=2048;" +
        "const CODES=new Set(['EACCES','EPERM','ENOENT','EBADF','EISDIR','ENOTDIR','ELOOP','EMFILE','ENFILE','ERR_MODULE_NOT_FOUND','ERR_UNKNOWN_FILE_EXTENSION','ERR_UNSUPPORTED_DIR_IMPORT','NOT_RUN','NOT_REGULAR','NOT_DIRECTORY','SYMLINK','INVALID_PROFILE_PATH','TOO_LARGE','FILE_CHANGED','INCOMPLETE','HASH_MISMATCH','INVALID_REQUEST','LIMIT_EXCEEDED','EXPORT_SHAPE','UNKNOWN']);" +
        "const IMPORT_SYSCALLS=new Set(['access','lstat','open','read','readlink','realpath','stat']);" +
        "const op=(operation,status,error_code)=>({operation,status,error_code});" +
        "const importOp=(status,error_code=null,syscall=null,path_label=null)=>({operation:'import',status,error_code,syscall,path_label});" +
        "const blankResult=(code='NOT_RUN')=>({schema_version:1,label:LABEL,lstat:op('lstat','SKIPPED',code),realpath:op('realpath','SKIPPED',code),read:op('read','SKIPPED',code),import:importOp('SKIPPED',code)});" +
        "function safeCode(error){let code;try{code=error&&error.code;}catch{}return typeof code==='string'&&CODES.has(code)?code:'UNKNOWN';}" +
        "function failed(operation,error){const code=safeCode(error);return op(operation,code==='EACCES'||code==='EPERM'?'DENIED':'FAIL',code);}" +
        "function normalizeLocalPath(value){try{if(typeof value!=='string'||value.length===0||value.length>32767)return null;let candidate=value;if(candidate.charCodeAt(0)===92&&candidate.charCodeAt(1)===92&&candidate[2]==='?'&&candidate.charCodeAt(3)===92)candidate=candidate.slice(4);if(!/[a-z]/i.test(candidate[0]||'')||candidate[1]!==':'||candidate.length<3||(candidate[2]!=='/'&&candidate.charCodeAt(2)!==92)||(candidate.charCodeAt(0)===92&&candidate.charCodeAt(1)===92))return null;const normalized=path.win32.resolve(candidate).toLowerCase(),root=path.win32.parse(normalized).root;if(!/[a-z]/i.test(root[0]||'')||root[1]!==':'||root.length!==3||root.charCodeAt(2)!==92)return null;return normalized;}catch{return null;}}" +
        "async function readInput(){const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>MAX_INPUT)throw Object.assign(new Error(),{code:'LIMIT_EXCEEDED'});chunks.push(chunk);}return Buffer.concat(chunks,size);}" +
        "function exactKeys(value,keys){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\\0')===[...keys].sort().join('\\0');}" +
        "function importFailure(error,expectedPath){const code=safeCode(error);let rawPath=null,rawSyscall=null;try{rawPath=error&&error.path;}catch{}try{rawSyscall=error&&error.syscall;}catch{}const path_label=normalizeLocalPath(rawPath)===normalizeLocalPath(expectedPath)?LABEL:null,syscall=typeof rawSyscall==='string'&&IMPORT_SYSCALLS.has(rawSyscall)?rawSyscall:null;return importOp(code==='EACCES'||code==='EPERM'?'DENIED':'FAIL',code,syscall,path_label);}" +
        "async function readBounded(filePath,statSize,expectedSha256){if(!Number.isSafeInteger(statSize)||statSize<0)return op('read','FAIL','UNKNOWN');if(statSize>MAX_FILE)return op('read','FAIL','TOO_LARGE');let handle=null,buffer=null,result=null;try{handle=await fs.open(filePath,'r');const opened=await handle.stat();if(!opened.isFile())result=op('read','FAIL','NOT_REGULAR');else if(opened.size>MAX_FILE)result=op('read','FAIL','TOO_LARGE');else if(opened.size!==statSize)result=op('read','FAIL','FILE_CHANGED');else{buffer=Buffer.alloc(16384);const hash=createHash('sha256');let total=0;while(total<statSize){const remaining=statSize-total;const{bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,remaining),null);if(bytesRead===0){result=op('read','FAIL','INCOMPLETE');break;}hash.update(buffer.subarray(0,bytesRead));total+=bytesRead;}if(!result){const finalStat=await handle.stat();if(finalStat.size!==statSize)result=op('read','FAIL','FILE_CHANGED');else result=hash.digest('hex')===expectedSha256.toLowerCase()?op('read','PASS',null):op('read','FAIL','HASH_MISMATCH');}}}catch(error){result=failed('read',error);}finally{if(buffer)buffer.fill(0);if(handle)try{await handle.close();}catch(error){if(result&&result.status==='PASS')result=failed('read',error);}}return result||op('read','FAIL','UNKNOWN');}" +
        "async function main(){let request,bytes;try{bytes=await readInput();request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(error){return blankResult(error&&error.code==='LIMIT_EXCEEDED'?'LIMIT_EXCEEDED':'INVALID_REQUEST');}if(!exactKeys(request,['nonce','expectedSha256'])||typeof request.nonce!=='string'||!/^[0-9a-f]{32}$/.test(request.nonce)||typeof request.expectedSha256!=='string'||!/^[0-9a-f]{64}$/i.test(request.expectedSha256))return blankResult('INVALID_REQUEST');const profilePath=normalizeLocalPath(process.env.LOCALAPPDATA);if(!profilePath)return blankResult('INVALID_PROFILE_PATH');const contractPath=path.win32.join(profilePath,'Temp','profile-contract-'+request.nonce,'probe-contract.mjs');let lstatResult,realpathResult,readResult=op('read','SKIPPED','NOT_RUN');try{const stat=await fs.lstat(contractPath);lstatResult=stat.isSymbolicLink()?op('lstat','FAIL','SYMLINK'):stat.isFile()?op('lstat','PASS',null):op('lstat','FAIL','NOT_REGULAR');}catch(error){lstatResult=failed('lstat',error);}try{const real=normalizeLocalPath(await fs.realpath(contractPath)),expected=normalizeLocalPath(contractPath);realpathResult=real!==null&&real===expected?op('realpath','PASS',null):op('realpath','FAIL','FILE_CHANGED');}catch(error){realpathResult=failed('realpath',error);}if(lstatResult.status==='PASS'&&realpathResult.status==='PASS'){let size;try{size=(await fs.lstat(contractPath)).size;readResult=await readBounded(contractPath,size,request.expectedSha256);}catch(error){readResult=failed('read',error);}}let importResult=importOp('SKIPPED','NOT_RUN');if(lstatResult.status==='PASS'&&realpathResult.status==='PASS'&&readResult.status==='PASS'){try{const module=await import(pathToFileURL(contractPath).href);importResult=typeof module.parseProbeRequest==='function'&&typeof module.classifyAccessError==='function'?importOp('PASS',null):importOp('FAIL','EXPORT_SHAPE');}catch(error){importResult=importFailure(error,contractPath);}}return{schema_version:1,label:LABEL,lstat:lstatResult,realpath:realpathResult,read:readResult,import:importResult};}" +
        "function emit(result){let output=JSON.stringify(result);if(Buffer.byteLength(output,'utf8')+1>MAX_OUTPUT)output=JSON.stringify(blankResult('LIMIT_EXCEEDED'));process.stdout.write(output+'\\n');}" +
        "main().then(emit,()=>emit(blankResult('UNKNOWN')));";

    private sealed class InputWriteState
    {
        public readonly IntPtr Pipe;
        public readonly byte[] Buffer;
        public readonly System.Threading.ManualResetEvent Completed = new System.Threading.ManualResetEvent(false);
        public int NativeThreadId;
        public bool Succeeded;
        public uint BytesWritten;
        public int ErrorCode;
        public Exception Failure;

        public InputWriteState(IntPtr pipe, byte[] buffer)
        {
            Pipe = pipe;
            Buffer = buffer;
        }
    }

    private sealed class ProcessTokenChainSnapshot
    {
        public readonly Dictionary<uint, uint> ParentByProcessId = new Dictionary<uint, uint>();
        public bool DuplicateId;
        public bool Overflow;
        public string Stage = "COMPLETE";
    }

    private sealed class HostJobProcessMetadata
    {
        public uint ParentProcessId;
        public string ImageName;
    }

    private sealed class ProcessTokenChainEvidence
    {
        public bool HasCreationTime;
        public ulong CreationTime;
        public string TokenIsAppContainer = "UNKNOWN";
        public string AppContainerSidPresence = "UNKNOWN";
        public string PackageIdentity = "UNKNOWN";
        public string Stage = "COMPLETE";
    }

    private interface IProcessTokenChainSource
    {
        uint CurrentProcessId { get; }
        ProcessTokenChainSnapshot ReadSnapshot();
        ProcessTokenChainEvidence InspectProcess(uint processId);
        string ReadCreationTime(uint processId, out ulong creationTime);
    }

    private sealed class SyntheticProcessTokenChainSource : IProcessTokenChainSource
    {
        private readonly uint _currentProcessId;
        private readonly ProcessTokenChainSnapshot _snapshot;
        private readonly Dictionary<uint, ProcessTokenChainEvidence> _evidence;
        private readonly Dictionary<uint, string> _creationTimeFailures;
        private readonly Dictionary<uint, ulong> _creationTimeOverrides;

        public uint CurrentProcessId { get { return _currentProcessId; } }

        public SyntheticProcessTokenChainSource(
            uint currentProcessId,
            ProcessTokenChainSnapshot snapshot,
            Dictionary<uint, ProcessTokenChainEvidence> evidence,
            Dictionary<uint, string> creationTimeFailures,
            Dictionary<uint, ulong> creationTimeOverrides)
        {
            _currentProcessId = currentProcessId;
            _snapshot = snapshot;
            _evidence = evidence;
            _creationTimeFailures = creationTimeFailures;
            _creationTimeOverrides = creationTimeOverrides;
        }

        public ProcessTokenChainSnapshot ReadSnapshot()
        {
            return _snapshot;
        }

        public ProcessTokenChainEvidence InspectProcess(uint processId)
        {
            ProcessTokenChainEvidence evidence;
            return _evidence.TryGetValue(processId, out evidence) ? evidence : null;
        }

        public string ReadCreationTime(uint processId, out ulong creationTime)
        {
            creationTime = 0;
            string failure;
            if (_creationTimeFailures.TryGetValue(processId, out failure)) return failure;
            if (_creationTimeOverrides.TryGetValue(processId, out creationTime)) return "";
            ProcessTokenChainEvidence evidence;
            if (!_evidence.TryGetValue(processId, out evidence) || !evidence.HasCreationTime) return "PROCESS_TIME";
            creationTime = evidence.CreationTime;
            return "";
        }
    }

    private sealed class Win32ProcessTokenChainSource : IProcessTokenChainSource
    {
        public uint CurrentProcessId { get { return GetCurrentProcessId(); } }

        public ProcessTokenChainSnapshot ReadSnapshot()
        {
            ProcessTokenChainSnapshot result = new ProcessTokenChainSnapshot();
            IntPtr snapshot = IntPtr.Zero;
            try
            {
                // Toolhelp allocates the OS snapshot; the application cap below only bounds retained pairs.
                snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
                {
                    result.Stage = "PROCESS_SNAPSHOT";
                    return result;
                }

                PROCESSENTRY32 entry = new PROCESSENTRY32();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (!Process32First(snapshot, ref entry))
                {
                    result.Stage = "PROCESS_ENUMERATION";
                    return result;
                }

                int enumerated = 0;
                while (true)
                {
                    enumerated++;
                    if (enumerated > MAX_PROCESS_CHAIN_ENUMERATION || result.ParentByProcessId.Count >= MAX_PROCESS_CHAIN_ENTRIES)
                    {
                        result.Overflow = true;
                        result.Stage = "PROCESS_ENUMERATION";
                        return result;
                    }
                    if (result.ParentByProcessId.ContainsKey(entry.th32ProcessID))
                    {
                        result.DuplicateId = true;
                        result.Stage = "PROCESS_ENUMERATION";
                        return result;
                    }
                    result.ParentByProcessId.Add(entry.th32ProcessID, entry.th32ParentProcessID);

                    if (!Process32Next(snapshot, ref entry))
                    {
                        if (Marshal.GetLastWin32Error() != ERROR_NO_MORE_FILES)
                            result.Stage = "PROCESS_ENUMERATION";
                        return result;
                    }
                }
            }
            catch
            {
                result.Stage = result.ParentByProcessId.Count == 0 ? "PROCESS_SNAPSHOT" : "PROCESS_ENUMERATION";
                return result;
            }
            finally
            {
                if (snapshot != IntPtr.Zero && snapshot != new IntPtr(-1)) CloseHandle(snapshot);
            }
        }

        public ProcessTokenChainEvidence InspectProcess(uint processId)
        {
            ProcessTokenChainEvidence evidence = new ProcessTokenChainEvidence();
            IntPtr process = IntPtr.Zero;
            IntPtr token = IntPtr.Zero;
            IntPtr tokenValue = IntPtr.Zero;
            string currentStage = "PROCESS_OPEN";
            try
            {
                process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
                if (process == IntPtr.Zero)
                {
                    evidence.Stage = "PROCESS_OPEN";
                    return evidence;
                }

                currentStage = "PROCESS_TIME";
                FILETIME creationTime;
                FILETIME exitTime;
                FILETIME kernelTime;
                FILETIME userTime;
                if (GetProcessTimes(process, out creationTime, out exitTime, out kernelTime, out userTime))
                {
                    evidence.HasCreationTime = true;
                    evidence.CreationTime = ((ulong)creationTime.dwHighDateTime << 32) | creationTime.dwLowDateTime;
                }
                else
                {
                    SetProcessTokenChainFailure(evidence, "PROCESS_TIME");
                }

                currentStage = "TOKEN_OPEN";
                if (!OpenProcessToken(process, TOKEN_QUERY, out token))
                {
                    SetProcessTokenChainFailure(evidence, "TOKEN_OPEN");
                }
                else
                {
                    tokenValue = Marshal.AllocHGlobal(sizeof(int));
                    uint returned;
                    currentStage = "TOKEN_APPCONTAINER";
                    if (!GetTokenInformation(token, TokenIsAppContainer, tokenValue, sizeof(int), out returned) || returned < sizeof(int))
                    {
                        SetProcessTokenChainFailure(evidence, "TOKEN_APPCONTAINER");
                    }
                    else if (Marshal.ReadInt32(tokenValue) == 0)
                    {
                        evidence.TokenIsAppContainer = "FALSE";
                        evidence.AppContainerSidPresence = "ABSENT";
                    }
                    else
                    {
                        evidence.TokenIsAppContainer = "TRUE";
                        currentStage = "TOKEN_SID";
                        evidence.AppContainerSidPresence = ReadAppContainerSidPresence(token, evidence);
                    }
                }

                currentStage = "PACKAGE_IDENTITY";
                uint packageNameLength = 0;
                int packageStatus = GetPackageFamilyName(process, ref packageNameLength, IntPtr.Zero);
                if (packageStatus == ERROR_INSUFFICIENT_BUFFER)
                    evidence.PackageIdentity = "PRESENT";
                else if (packageStatus == APPMODEL_ERROR_NO_PACKAGE)
                    evidence.PackageIdentity = "NO_PACKAGE";
                else
                    SetProcessTokenChainFailure(evidence, "PACKAGE_IDENTITY");
                return evidence;
            }
            catch
            {
                SetProcessTokenChainFailure(evidence, currentStage);
                return evidence;
            }
            finally
            {
                if (tokenValue != IntPtr.Zero) Marshal.FreeHGlobal(tokenValue);
                if (token != IntPtr.Zero) CloseHandle(token);
                if (process != IntPtr.Zero) CloseHandle(process);
            }
        }

        public string ReadCreationTime(uint processId, out ulong creationTime)
        {
            creationTime = 0;
            IntPtr process = IntPtr.Zero;
            try
            {
                process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
                if (process == IntPtr.Zero) return "PROCESS_OPEN";
                FILETIME created;
                FILETIME exited;
                FILETIME kernel;
                FILETIME user;
                if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) return "PROCESS_TIME";
                creationTime = ((ulong)created.dwHighDateTime << 32) | created.dwLowDateTime;
                return "";
            }
            catch
            {
                return process == IntPtr.Zero ? "PROCESS_OPEN" : "PROCESS_TIME";
            }
            finally
            {
                if (process != IntPtr.Zero) CloseHandle(process);
            }
        }

        private static string ReadAppContainerSidPresence(IntPtr token, ProcessTokenChainEvidence evidence)
        {
            IntPtr buffer = IntPtr.Zero;
            try
            {
                uint required;
                bool firstCall = GetTokenInformation(token, TokenAppContainerSid, IntPtr.Zero, 0, out required);
                int error = Marshal.GetLastWin32Error();
                int minimum = Marshal.SizeOf(typeof(TOKEN_APPCONTAINER_INFORMATION));
                if (firstCall || error != ERROR_INSUFFICIENT_BUFFER || required < (uint)minimum ||
                    required > MAX_PROCESS_CHAIN_TOKEN_BUFFER_BYTES)
                {
                    SetProcessTokenChainFailure(evidence, "TOKEN_SID");
                    return "UNKNOWN";
                }

                buffer = Marshal.AllocHGlobal((int)required);
                uint returned;
                if (!GetTokenInformation(token, TokenAppContainerSid, buffer, required, out returned) ||
                    returned < (uint)minimum || returned > required)
                {
                    SetProcessTokenChainFailure(evidence, "TOKEN_SID");
                    return "UNKNOWN";
                }
                TOKEN_APPCONTAINER_INFORMATION information = (TOKEN_APPCONTAINER_INFORMATION)Marshal.PtrToStructure(
                    buffer, typeof(TOKEN_APPCONTAINER_INFORMATION));
                return information.TokenAppContainer == IntPtr.Zero ? "ABSENT" : "PRESENT";
            }
            catch
            {
                SetProcessTokenChainFailure(evidence, "TOKEN_SID");
                return "UNKNOWN";
            }
            finally
            {
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public UIntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_APPCONTAINER_INFORMATION
    {
        public IntPtr TokenAppContainer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_GROUPS_FIRST
    {
        public uint GroupCount;
        public SID_AND_ATTRIBUTES FirstGroup;
    }

    private sealed class TokenCapabilitiesEvidence
    {
        public string Status = "UNKNOWN";
        public uint? Count;
        public uint? NetworkCapabilityCount;
        public int? ErrorCode;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID_AND_ATTRIBUTES
    {
        public LUID Luid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct REGISTRY_FILETIME
    {
        public uint LowDateTime;
        public uint HighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GENERIC_MAPPING
    {
        public uint GenericRead;
        public uint GenericWrite;
        public uint GenericExecute;
        public uint GenericAll;
    }

    [DllImport("userenv.dll", EntryPoint = "CreateAppContainerProfile", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int CreateAppContainerProfile(
        IntPtr appContainerName,
        IntPtr displayName,
        IntPtr description,
        IntPtr capabilities,
        uint capabilityCount,
        out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int DeleteAppContainerProfile(string appContainerName);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetAppContainerFolderPath(string appContainerSid, out IntPtr path);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int DeriveAppContainerSidFromAppContainerName(string appContainerName, out IntPtr appContainerSid);

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern void CoTaskMemFree(IntPtr memory);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

    [DllImport("advapi32.dll", EntryPoint = "RegQueryValueExW", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int RegQueryValueEx(
        IntPtr keyHandle,
        string valueName,
        IntPtr reserved,
        out uint valueType,
        IntPtr data,
        ref uint dataSize);

    [DllImport("advapi32.dll", EntryPoint = "RegEnumKeyExW", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int RegEnumKeyEx(
        IntPtr keyHandle,
        uint index,
        StringBuilder name,
        ref uint nameLength,
        IntPtr reserved,
        IntPtr className,
        IntPtr classLength,
        out REGISTRY_FILETIME lastWriteTime);

    [DllImport("advapi32.dll", EntryPoint = "RegQueryInfoKeyW", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int RegQueryInfoKey(
        IntPtr keyHandle,
        IntPtr keyClass,
        IntPtr keyClassLength,
        IntPtr reserved,
        out uint subKeyCount,
        IntPtr maxSubKeyNameLength,
        IntPtr maxClassLength,
        IntPtr valueCount,
        IntPtr maxValueNameLength,
        IntPtr maxValueLength,
        IntPtr securityDescriptorLength,
        out REGISTRY_FILETIME lastWriteTime);

    [DllImport("advapi32.dll", EntryPoint = "RegNotifyChangeKeyValue", ExactSpelling = true)]
    private static extern int RegNotifyChangeKeyValue(
        IntPtr keyHandle,
        [MarshalAs(UnmanagedType.Bool)] bool watchSubtree,
        uint notifyFilter,
        SafeWaitHandle eventHandle,
        [MarshalAs(UnmanagedType.Bool)] bool asynchronous);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UIntPtr LocalSize(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeriveCapabilitySidsFromName(
        string capabilityName,
        out IntPtr capabilityGroupSids,
        out uint capabilityGroupSidCount,
        out IntPtr capabilitySids,
        out uint capabilitySidCount);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        out JOBOBJECT_BASIC_LIMIT_INFORMATION information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        ref SECURITY_ATTRIBUTES attributes,
        uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekNamedPipe(
        IntPtr pipe,
        IntPtr buffer,
        uint bufferSize,
        IntPtr bytesRead,
        out uint totalBytesAvailable,
        IntPtr bytesLeftThisMessage);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(
        IntPtr file,
        byte[] buffer,
        uint bytesToRead,
        out uint bytesRead,
        IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(
        IntPtr file,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        UIntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", EntryPoint = "CreateEventW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeWaitHandle CreateEvent(
        IntPtr eventAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool manualReset,
        [MarshalAs(UnmanagedType.Bool)] bool initialState,
        string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetProcessId(IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsValidSid(IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetLengthSid(IntPtr sid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetProcessHeap();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr HeapAlloc(IntPtr heap, uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool HeapFree(IntPtr heap, uint flags, IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool HeapValidate(IntPtr heap, uint flags, IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UIntPtr HeapSize(IntPtr heap, uint flags, IntPtr memory);

    [DllImport("FirewallAPI.dll", ExactSpelling = true)]
    private static extern uint NetworkIsolationGetAppContainerConfig(out uint count, out IntPtr appContainerSids);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LookupPrivilegeValue(string systemName, string name, out LUID luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateTokenEx(
        IntPtr existingToken,
        uint desiredAccess,
        IntPtr tokenAttributes,
        int impersonationLevel,
        int tokenType,
        out IntPtr newToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AccessCheck(
        IntPtr securityDescriptor,
        IntPtr clientToken,
        uint desiredAccess,
        ref GENERIC_MAPPING genericMapping,
        IntPtr privilegeSet,
        ref uint privilegeSetLength,
        out uint grantedAccess,
        [MarshalAs(UnmanagedType.Bool)] out bool accessStatus);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        IntPtr token,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creationTime,
        out FILETIME exitTime,
        out FILETIME kernelTime,
        out FILETIME userTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetCurrentProcessId();

    [DllImport("kernel32.dll", EntryPoint = "GetPackageFamilyName", ExactSpelling = true)]
    private static extern int GetPackageFamilyName(IntPtr process, ref uint packageFamilyNameLength, IntPtr packageFamilyName);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EqualSid(IntPtr sid1, IntPtr sid2);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenThread(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint threadId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CancelSynchronousIo(IntPtr thread);

    public static string CreateProfile(string profileName)
    {
        ValidateGeneratedProfileName(profileName);
        IntPtr sid = IntPtr.Zero;
        IntPtr text = IntPtr.Zero;
        IntPtr appContainerNamePointer = IntPtr.Zero;
        IntPtr displayNamePointer = IntPtr.Zero;
        IntPtr descriptionPointer = IntPtr.Zero;
        try
        {
            appContainerNamePointer = Marshal.StringToHGlobalUni(profileName);
            displayNamePointer = Marshal.StringToHGlobalUni(profileName);
            descriptionPointer = Marshal.StringToHGlobalUni(profileName);

            int result = CreateAppContainerProfile(appContainerNamePointer, displayNamePointer, descriptionPointer, IntPtr.Zero, 0, out sid);
            if (result < 0)
            {
                InvalidOperationException failure = new InvalidOperationException("CreateAppContainerProfile failed: 0x" + result.ToString("X8"));
                failure.Data["api_hresult"] = result;
                if (result == unchecked((int)0x800700B7))
                    failure.Data["profile_preexisted"] = true;
                throw failure;
            }
            if (!ConvertSidToStringSid(sid, out text)) throw LastError("ConvertSidToStringSid");
            return Marshal.PtrToStringUni(text);
        }
        finally
        {
            if (text != IntPtr.Zero) LocalFree(text);
            if (sid != IntPtr.Zero) FreeSid(sid);
            if (descriptionPointer != IntPtr.Zero) Marshal.FreeHGlobal(descriptionPointer);
            if (displayNamePointer != IntPtr.Zero) Marshal.FreeHGlobal(displayNamePointer);
            if (appContainerNamePointer != IntPtr.Zero) Marshal.FreeHGlobal(appContainerNamePointer);
        }
    }

    public static int CreateProfileDiagnostic(string profileName, out string profileSid)
    {
        ValidateGeneratedProfileName(profileName);
        profileSid = null;
        IntPtr sid = IntPtr.Zero;
        IntPtr text = IntPtr.Zero;
        IntPtr appContainerNamePointer = IntPtr.Zero;
        IntPtr displayNamePointer = IntPtr.Zero;
        IntPtr descriptionPointer = IntPtr.Zero;
        int result = unchecked((int)0x80004005);
        try
        {
            appContainerNamePointer = Marshal.StringToHGlobalUni(profileName);
            displayNamePointer = Marshal.StringToHGlobalUni(profileName);
            descriptionPointer = Marshal.StringToHGlobalUni(profileName);

            result = CreateAppContainerProfile(appContainerNamePointer, displayNamePointer, descriptionPointer,
                IntPtr.Zero, 0, out sid);
            if (result != 0) return result;

            try
            {
                if (!ConvertSidToStringSid(sid, out text)) throw LastError("ConvertSidToStringSid");
                string converted = text == IntPtr.Zero ? null : Marshal.PtrToStringUni(text);
                if (String.IsNullOrEmpty(converted))
                    throw new InvalidOperationException("ConvertSidToStringSid returned an empty SID.");
                profileSid = converted;
                return result;
            }
            catch (Exception failure)
            {
                failure.Data["create_profile_hresult"] = result;
                throw;
            }
        }
        finally
        {
            if (text != IntPtr.Zero) LocalFree(text);
            if (sid != IntPtr.Zero) FreeSid(sid);
            if (descriptionPointer != IntPtr.Zero) Marshal.FreeHGlobal(descriptionPointer);
            if (displayNamePointer != IntPtr.Zero) Marshal.FreeHGlobal(displayNamePointer);
            if (appContainerNamePointer != IntPtr.Zero) Marshal.FreeHGlobal(appContainerNamePointer);
        }
    }

    public static void DeleteProfile(string profileName)
    {
        int result = DeleteAppContainerProfile(profileName);
        if (result < 0 && result != unchecked((int)0x80070002) && result != unchecked((int)0x80070003))
            throw new InvalidOperationException("DeleteAppContainerProfile failed: 0x" + result.ToString("X8"));
    }

    public static int DeleteProfileDiagnostic(string profileName)
    {
        ValidateGeneratedProfileName(profileName);
        return DeleteAppContainerProfile(profileName);
    }

    public static string ClassifyProfileMappingChildEnumerationResult(string status, int index, int remainingKeys)
    {
        if (index < 0 || remainingKeys < 0 || remainingKeys > MAX_PROFILE_MAPPING_KEYS) return "UNKNOWN";
        if (status == "END") return "END";
        if (status != "NAME") return "UNKNOWN";
        return index >= remainingKeys ? "KEY_LIMIT" : "NAME";
    }

    public static string ClassifyProfileMappingScanStability(
        int beforeStatus, uint beforeSubKeyCount, ulong beforeLastWriteTime,
        int afterStatus, uint afterSubKeyCount, ulong afterLastWriteTime,
        uint notificationWaitStatus)
    {
        if (beforeStatus != ERROR_SUCCESS || afterStatus != ERROR_SUCCESS ||
            notificationWaitStatus != WAIT_TIMEOUT ||
            beforeSubKeyCount != afterSubKeyCount || beforeLastWriteTime != afterLastWriteTime)
            return "UNKNOWN";
        return "STABLE";
    }

    public static BoundedRegistryKeyNameResult EnumerateProfileMappingChildName(RegistryKey key, uint index)
    {
        BoundedRegistryKeyNameResult result = new BoundedRegistryKeyNameResult();
        result.Status = "UNKNOWN";
        result.Name = null;
        if (key == null || index > MAX_PROFILE_MAPPING_KEYS) return result;

        SafeRegistryHandle safeKeyHandle = null;
        bool handleReferenceAdded = false;
        try
        {
            safeKeyHandle = key.Handle;
            safeKeyHandle.DangerousAddRef(ref handleReferenceAdded);
            IntPtr keyHandle = safeKeyHandle.DangerousGetHandle();
            StringBuilder name = new StringBuilder(MAX_PROFILE_MAPPING_KEY_NAME_CHARS);
            uint nameLength = MAX_PROFILE_MAPPING_KEY_NAME_CHARS;
            REGISTRY_FILETIME lastWriteTime;
            int status = RegEnumKeyEx(keyHandle, index, name, ref nameLength,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out lastWriteTime);
            if (status == ERROR_NO_MORE_ITEMS)
            {
                result.Status = "END";
                return result;
            }
            if (status == ERROR_MORE_DATA) return result;
            if (status != ERROR_SUCCESS || nameLength >= MAX_PROFILE_MAPPING_KEY_NAME_CHARS) return result;
            result.Status = "NAME";
            result.Name = name.ToString();
            return result;
        }
        catch
        {
            return result;
        }
        finally
        {
            if (handleReferenceAdded) safeKeyHandle.DangerousRelease();
        }
    }

    public static ProfileMappingScanChangeMonitor BeginProfileMappingScanChangeMonitor(RegistryKey key)
    {
        ProfileMappingScanChangeMonitor monitor = new ProfileMappingScanChangeMonitor();
        monitor.Status = "UNKNOWN";
        if (key == null) return monitor;

        SafeRegistryHandle safeKeyHandle = null;
        bool handleReferenceAdded = false;
        try
        {
            monitor.EventHandle = CreateEvent(IntPtr.Zero, true, false, null);
            if (monitor.EventHandle == null || monitor.EventHandle.IsInvalid) return monitor;

            safeKeyHandle = key.Handle;
            safeKeyHandle.DangerousAddRef(ref handleReferenceAdded);
            IntPtr keyHandle = safeKeyHandle.DangerousGetHandle();
            int notifyStatus = RegNotifyChangeKeyValue(keyHandle, true,
                REG_NOTIFY_CHANGE_NAME | REG_NOTIFY_CHANGE_LAST_SET, monitor.EventHandle, true);
            if (notifyStatus != ERROR_SUCCESS) return monitor;

            uint initialSubKeyCount;
            ulong initialLastWriteTime;
            int queryStatus = QueryProfileMappingKeyInfo(keyHandle, out initialSubKeyCount, out initialLastWriteTime);
            if (queryStatus != ERROR_SUCCESS) return monitor;
            monitor.InitialSubKeyCount = initialSubKeyCount;
            monitor.InitialLastWriteTime = initialLastWriteTime;
            monitor.Status = "READY";
            return monitor;
        }
        catch
        {
            return monitor;
        }
        finally
        {
            if (handleReferenceAdded) safeKeyHandle.DangerousRelease();
        }
    }

    public static string CheckProfileMappingScanStability(RegistryKey key, ProfileMappingScanChangeMonitor monitor)
    {
        if (key == null || monitor == null || monitor.Status != "READY" ||
            monitor.EventHandle == null || monitor.EventHandle.IsInvalid) return "UNKNOWN";

        SafeRegistryHandle safeKeyHandle = null;
        bool keyReferenceAdded = false;
        bool eventReferenceAdded = false;
        try
        {
            safeKeyHandle = key.Handle;
            safeKeyHandle.DangerousAddRef(ref keyReferenceAdded);
            monitor.EventHandle.DangerousAddRef(ref eventReferenceAdded);
            uint finalSubKeyCount;
            ulong finalLastWriteTime;
            int queryStatus = QueryProfileMappingKeyInfo(
                safeKeyHandle.DangerousGetHandle(), out finalSubKeyCount, out finalLastWriteTime);
            uint notificationWaitStatus = WaitForSingleObject(monitor.EventHandle.DangerousGetHandle(), 0);
            return ClassifyProfileMappingScanStability(
                ERROR_SUCCESS, monitor.InitialSubKeyCount, monitor.InitialLastWriteTime,
                queryStatus, finalSubKeyCount, finalLastWriteTime, notificationWaitStatus);
        }
        catch
        {
            return "UNKNOWN";
        }
        finally
        {
            if (eventReferenceAdded) monitor.EventHandle.DangerousRelease();
            if (keyReferenceAdded) safeKeyHandle.DangerousRelease();
        }
    }

    private static int QueryProfileMappingKeyInfo(IntPtr keyHandle, out uint subKeyCount, out ulong lastWriteTime)
    {
        REGISTRY_FILETIME nativeLastWriteTime;
        int status = RegQueryInfoKey(keyHandle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
            out subKeyCount, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
            IntPtr.Zero, IntPtr.Zero, out nativeLastWriteTime);
        lastWriteTime = ((ulong)nativeLastWriteTime.HighDateTime << 32) | nativeLastWriteTime.LowDateTime;
        return status;
    }

    public static string ClassifyProfileMappingValueSizeProbe(int status, uint valueType, uint byteCount, int maxBytes)
    {
        if (maxBytes <= 0 || maxBytes > MAX_PROFILE_MAPPING_VALUE_BYTES) return "UNKNOWN";
        if (status == ERROR_FILE_NOT_FOUND) return "MISSING";
        if (status != ERROR_SUCCESS || valueType != REG_SZ || byteCount < 2 ||
            byteCount > (uint)maxBytes || (byteCount & 1) != 0) return "UNKNOWN";
        return "READY";
    }

    public static string ClassifyProfileMappingValueRead(
        int firstStatus, uint firstType, uint firstByteCount,
        int secondStatus, uint secondType, uint secondByteCount,
        uint expectedType, uint expectedByteCount, int maxBytes)
    {
        if (maxBytes <= 0 || maxBytes > MAX_PROFILE_MAPPING_VALUE_BYTES ||
            expectedType != REG_SZ || expectedByteCount < 2 || expectedByteCount > (uint)maxBytes ||
            (expectedByteCount & 1) != 0) return "UNKNOWN";
        if (firstStatus != ERROR_SUCCESS || secondStatus != ERROR_SUCCESS ||
            firstType != expectedType || secondType != expectedType ||
            firstByteCount != expectedByteCount || secondByteCount != expectedByteCount) return "UNKNOWN";
        return "READ";
    }

    public static BoundedRegistryStringValueResult ReadBoundedProfileMappingString(RegistryKey key, string valueName)
    {
        BoundedRegistryStringValueResult result = new BoundedRegistryStringValueResult();
        result.Status = "UNKNOWN";
        result.Value = null;
        result.ByteLength = 0;
        if (key == null || (valueName != "DisplayName" && valueName != "Moniker")) return result;

        SafeRegistryHandle safeKeyHandle = null;
        bool handleReferenceAdded = false;
        try
        {
            safeKeyHandle = key.Handle;
            safeKeyHandle.DangerousAddRef(ref handleReferenceAdded);
            IntPtr keyHandle = safeKeyHandle.DangerousGetHandle();
            uint initialType;
            uint initialByteCount = 0;
            int initialStatus = RegQueryValueEx(keyHandle, valueName, IntPtr.Zero,
                out initialType, IntPtr.Zero, ref initialByteCount);
            string sizeStatus = ClassifyProfileMappingValueSizeProbe(
                initialStatus, initialType, initialByteCount, MAX_PROFILE_MAPPING_VALUE_BYTES);
            if (sizeStatus == "MISSING")
            {
                result.Status = "MISSING";
                return result;
            }
            if (sizeStatus != "READY") return result;

            int length = checked((int)initialByteCount);
            byte[] firstData = new byte[length];
            byte[] secondData = new byte[length];
            uint firstType;
            uint firstByteCount = initialByteCount;
            uint secondType;
            uint secondByteCount = initialByteCount;
            int firstStatus;
            int secondStatus;
            GCHandle firstPin = default(GCHandle);
            GCHandle secondPin = default(GCHandle);
            try
            {
                IntPtr firstPointer = IntPtr.Zero;
                IntPtr secondPointer = IntPtr.Zero;
                if (length > 0)
                {
                    firstPin = GCHandle.Alloc(firstData, GCHandleType.Pinned);
                    secondPin = GCHandle.Alloc(secondData, GCHandleType.Pinned);
                    firstPointer = firstPin.AddrOfPinnedObject();
                    secondPointer = secondPin.AddrOfPinnedObject();
                }
                firstStatus = RegQueryValueEx(keyHandle, valueName, IntPtr.Zero,
                    out firstType, firstPointer, ref firstByteCount);
                secondStatus = RegQueryValueEx(keyHandle, valueName, IntPtr.Zero,
                    out secondType, secondPointer, ref secondByteCount);
            }
            finally
            {
                if (firstPin.IsAllocated) firstPin.Free();
                if (secondPin.IsAllocated) secondPin.Free();
            }

            string readStatus = ClassifyProfileMappingValueRead(
                firstStatus, firstType, firstByteCount,
                secondStatus, secondType, secondByteCount,
                initialType, initialByteCount, MAX_PROFILE_MAPPING_VALUE_BYTES);
            if (readStatus != "READ") return result;
            for (int index = 0; index < length; index++)
            {
                if (firstData[index] != secondData[index]) return result;
            }
            if (length < 2 || firstData[length - 2] != 0 || firstData[length - 1] != 0) return result;

            string value = new UnicodeEncoding(false, true, true).GetString(firstData, 0, length - 2);
            if (value.IndexOf('\0') >= 0) return result;
            result.Status = "READ";
            result.Value = value;
            result.ByteLength = length;
            return result;
        }
        catch
        {
            return result;
        }
        finally
        {
            if (handleReferenceAdded) safeKeyHandle.DangerousRelease();
        }
    }

    private static bool IsAsciiDriveLetter(char value)
    {
        return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
    }

    private static void ValidateGeneratedProfileName(string profileName)
    {
        if (String.IsNullOrWhiteSpace(profileName) || profileName.Length != 24 ||
            !profileName.StartsWith("AgentCP", StringComparison.Ordinal))
            throw new ArgumentException("AppContainer profile name has an invalid generated shape.", "profileName");
        for (int index = 7; index < profileName.Length; index++)
        {
            char character = profileName[index];
            bool hex = (character >= '0' && character <= '9') ||
                (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F');
            if (!hex) throw new ArgumentException("AppContainer profile name has an invalid generated shape.", "profileName");
        }
    }

    private static void ValidateProfileNameForNonce(string profileName, string nonce)
    {
        if (String.IsNullOrWhiteSpace(nonce) || nonce.Length != 32)
            throw new ArgumentException("AppContainer profile nonce has an invalid shape.", "nonce");
        for (int index = 0; index < nonce.Length; index++)
        {
            char character = nonce[index];
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
                throw new ArgumentException("AppContainer profile nonce has an invalid shape.", "nonce");
        }
        string expectedName = "AgentCP" + nonce.Substring(0, 17);
        if (!String.Equals(profileName, expectedName, StringComparison.Ordinal))
            throw new ArgumentException("AppContainer profile name does not match its generated nonce.", "profileName");
    }

    private static string GetCanonicalLocalDrivePath(string value, string parameterName)
    {
        if (String.IsNullOrWhiteSpace(value) || value.Length < 3 ||
            !IsAsciiDriveLetter(value[0]) || value[1] != ':' || value[2] != '\\' ||
            value.IndexOf('\0') >= 0 || value.IndexOf(':', 2) >= 0 || value.StartsWith("\\\\", StringComparison.Ordinal))
            throw new ArgumentException("Path must be an absolute local drive path.", parameterName);

        string fullPath = Path.GetFullPath(value);
        string inputWithoutTrailingSeparator = value.TrimEnd(Path.DirectorySeparatorChar);
        string fullWithoutTrailingSeparator = fullPath.TrimEnd(Path.DirectorySeparatorChar);
        if (!String.Equals(inputWithoutTrailingSeparator, fullWithoutTrailingSeparator, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Path must be canonical and must not use device or traversal syntax.", parameterName);
        return fullWithoutTrailingSeparator;
    }

    private static void EnsureNoReparsePointsInPath(string fullPath)
    {
        string current = fullPath;
        while (!String.IsNullOrWhiteSpace(current))
        {
            string parent = Path.GetDirectoryName(current);
            FileAttributes attributes;
            try
            {
                attributes = File.GetAttributes(current);
            }
            catch (FileNotFoundException)
            {
                if (String.IsNullOrWhiteSpace(parent) || String.Equals(parent, current, StringComparison.OrdinalIgnoreCase))
                    break;
                current = parent;
                continue;
            }
            catch (DirectoryNotFoundException)
            {
                if (String.IsNullOrWhiteSpace(parent) || String.Equals(parent, current, StringComparison.OrdinalIgnoreCase))
                    break;
                current = parent;
                continue;
            }
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("AppContainer profile path contains a reparse point.");

            if (String.IsNullOrWhiteSpace(parent) || String.Equals(parent, current, StringComparison.OrdinalIgnoreCase))
                break;
            current = parent;
        }
    }

    private static string ValidateProfileCandidatePath(string candidatePath, string profileName, string nonce)
    {
        ValidateProfileNameForNonce(profileName, nonce);
        string canonical = GetCanonicalLocalDrivePath(candidatePath, "profileCandidatePath");
        string expectedSuffix = "\\Packages\\" + profileName + "\\AC";
        if (canonical.Length <= expectedSuffix.Length + 3 ||
            !canonical.EndsWith(expectedSuffix, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The generated AppContainer profile candidate has an unexpected path shape.", "candidatePath");
        DirectoryInfo profileDirectory = new DirectoryInfo(canonical);
        if (!String.Equals(profileDirectory.Name, "AC", StringComparison.OrdinalIgnoreCase) ||
            profileDirectory.Parent == null || !String.Equals(profileDirectory.Parent.Name, profileName, StringComparison.Ordinal) ||
            profileDirectory.Parent.Parent == null || !String.Equals(profileDirectory.Parent.Parent.Name, "Packages", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The generated AppContainer profile candidate has an unexpected path shape.", "candidatePath");
        EnsureNoReparsePointsInPath(canonical);
        return canonical;
    }

    private static string GetProfileLocalAppDataPath(string profileSid, string profileName)
    {
        RunProfilePathStage<object>("SID_NAME", () =>
        {
            if (String.IsNullOrWhiteSpace(profileSid))
                throw new InvalidOperationException("AppContainer SID is required to resolve its profile path.");
            ValidateGeneratedProfileName(profileName);
            return null;
        });

        IntPtr path = IntPtr.Zero;
        try
        {
            string value = RunProfilePathStage("API", () =>
            {
                int result = GetAppContainerFolderPath(profileSid, out path);
                if (result < 0)
                {
                    InvalidOperationException failure = new InvalidOperationException(
                        "GetAppContainerFolderPath failed: 0x" + result.ToString("X8"));
                    failure.Data["api_hresult"] = result;
                    failure.Data["api_operation"] = "GetAppContainerFolderPath";
                    throw failure;
                }
                return path == IntPtr.Zero ? null : Marshal.PtrToStringUni(path);
            });

            string fullPath = RunProfilePathStage("CANONICAL", () => GetCanonicalLocalDrivePath(value, "profilePath"));
            string expectedSuffix = "\\Packages\\" + profileName + "\\AC";
            RunProfilePathStage<object>("SUFFIX", () =>
            {
                if (fullPath.Length <= expectedSuffix.Length + 3 ||
                    !fullPath.EndsWith(expectedSuffix, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("GetAppContainerFolderPath returned an unexpected profile path shape.");
                return null;
            });
            RunProfilePathStage("REPARSE", () => EnsureNoReparsePointsInPath(fullPath));
            return fullPath;
        }
        finally
        {
            if (path != IntPtr.Zero) CoTaskMemFree(path);
        }
    }

    public static string GetProfilePath(string profileSid, string profileName, string nonce)
    {
        RunProfilePathStage<object>("NONCE", () =>
        {
            ValidateProfileNameForNonce(profileName, nonce);
            return null;
        });
        return GetProfileLocalAppDataPath(profileSid, profileName);
    }

    private static bool IsProfilePathStage(string stage)
    {
        return stage == "NONCE" || stage == "SID_NAME" || stage == "API" ||
            stage == "CANONICAL" || stage == "SUFFIX" || stage == "REPARSE";
    }

    private static T RunProfilePathStage<T>(string stage, Func<T> operation)
    {
        if (!IsProfilePathStage(stage))
            throw new ArgumentException("Invalid profile path stage.", "stage");
        try
        {
            return operation();
        }
        catch (Exception exception)
        {
            exception.Data["profile_path_stage"] = stage;
            throw;
        }
    }

    private static void RunProfilePathStage(string stage, Action operation)
    {
        RunProfilePathStage<object>(stage, () =>
        {
            operation();
            return null;
        });
    }

    public static Exception CreateProfilePathStageSelfTestException(string stage, bool includeApiHResult)
    {
        if (!IsProfilePathStage(stage))
            throw new ArgumentException("Invalid profile path stage.", "stage");
        Exception expected = new InvalidOperationException("Synthetic private profile path value.");
        if (includeApiHResult)
            expected.Data["api_hresult"] = unchecked((int)0x80070002);
        try
        {
            RunProfilePathStage<object>(stage, () => { throw expected; });
        }
        catch (Exception actual)
        {
            if (!Object.ReferenceEquals(actual, expected) ||
                !actual.Data.Contains("profile_path_stage") ||
                !Object.Equals(actual.Data["profile_path_stage"], stage))
                throw new InvalidOperationException("Synthetic profile path stage self-test failed.");
            return actual;
        }
        throw new InvalidOperationException("Synthetic profile path stage self-test did not throw.");
    }

    public static ProcessTokenChainDiagnosticResult ReadProcessTokenChainDiagnostic()
    {
        try
        {
            return BuildProcessTokenChainDiagnostic(new Win32ProcessTokenChainSource());
        }
        catch
        {
            return CreateUnknownProcessTokenChainResult("PROCESS_SNAPSHOT", false);
        }
    }

    public static ProcessTokenChainDiagnosticResult ProcessTokenChainSyntheticSelfTest()
    {
        ProcessTokenChainSnapshot validSnapshot = NewProcessTokenChainSnapshot(
            new uint[] { 424242, 313131 }, new uint[] { 313131, 0 });
        Dictionary<uint, ProcessTokenChainEvidence> validEvidence = new Dictionary<uint, ProcessTokenChainEvidence>();
        validEvidence.Add(424242, NewKnownProcessTokenChainEvidence(200));
        validEvidence.Add(313131, NewKnownProcessTokenChainEvidence(100));
        ProcessTokenChainDiagnosticResult valid = BuildProcessTokenChainDiagnostic(
            new SyntheticProcessTokenChainSource(424242, validSnapshot, validEvidence,
                new Dictionary<uint, string>(), new Dictionary<uint, ulong>()));
        AssertProcessTokenChainResult(valid.status == "COMPLETE" && valid.stage == "COMPLETE" &&
            valid.processes.Length == 2 && valid.processes[0].link_status == "VERIFIED" &&
            valid.processes[1].link_status == "ROOT", "valid-chain");

        ProcessTokenChainSnapshot missingParent = NewProcessTokenChainSnapshot(new uint[] { 11 }, new uint[] { 12 });
        Dictionary<uint, ProcessTokenChainEvidence> oneEvidence = new Dictionary<uint, ProcessTokenChainEvidence>();
        oneEvidence.Add(11, NewKnownProcessTokenChainEvidence(20));
        ProcessTokenChainDiagnosticResult missing = BuildProcessTokenChainDiagnostic(
            new SyntheticProcessTokenChainSource(11, missingParent, oneEvidence,
                new Dictionary<uint, string>(), new Dictionary<uint, ulong>()));
        AssertProcessTokenChainResult(missing.status == "UNKNOWN" && missing.stage == "ANCESTRY_LINK", "missing-parent");

        ProcessTokenChainSnapshot duplicate = NewProcessTokenChainSnapshot(new uint[] { 13, 13 }, new uint[] { 0, 0 });
        ProcessTokenChainDiagnosticResult duplicateResult = BuildProcessTokenChainDiagnostic(
            new SyntheticProcessTokenChainSource(13, duplicate, oneEvidence,
                new Dictionary<uint, string>(), new Dictionary<uint, ulong>()));
        AssertProcessTokenChainResult(duplicateResult.status == "UNKNOWN" && duplicateResult.stage == "PROCESS_ENUMERATION", "duplicate-id");

        ProcessTokenChainSnapshot cycle = NewProcessTokenChainSnapshot(new uint[] { 21, 22 }, new uint[] { 22, 21 });
        Dictionary<uint, ProcessTokenChainEvidence> cycleEvidence = new Dictionary<uint, ProcessTokenChainEvidence>();
        cycleEvidence.Add(21, NewKnownProcessTokenChainEvidence(10));
        cycleEvidence.Add(22, NewKnownProcessTokenChainEvidence(20));
        ProcessTokenChainDiagnosticResult cycleResult = BuildProcessTokenChainDiagnostic(
            new SyntheticProcessTokenChainSource(22, cycle, cycleEvidence,
                new Dictionary<uint, string>(), new Dictionary<uint, ulong>()));
        AssertProcessTokenChainResult(cycleResult.status == "UNKNOWN" && cycleResult.stage == "ANCESTRY_LINK", "cycle");

        ProcessTokenChainSnapshot reusedPid = NewProcessTokenChainSnapshot(new uint[] { 31, 32 }, new uint[] { 32, 0 });
        Dictionary<uint, ProcessTokenChainEvidence> reusedEvidence = new Dictionary<uint, ProcessTokenChainEvidence>();
        reusedEvidence.Add(31, NewKnownProcessTokenChainEvidence(30));
        reusedEvidence.Add(32, NewKnownProcessTokenChainEvidence(40));
        ProcessTokenChainDiagnosticResult reusedResult = BuildProcessTokenChainDiagnostic(
            new SyntheticProcessTokenChainSource(31, reusedPid, reusedEvidence,
                new Dictionary<uint, string>(), new Dictionary<uint, ulong>()));
        AssertProcessTokenChainResult(reusedResult.status == "UNKNOWN" && reusedResult.stage == "ANCESTRY_LINK", "creation-time-mismatch");

        ProcessTokenChainSnapshot pidReuseSnapshot = NewProcessTokenChainSnapshot(new uint[] { 51, 52, 53 }, new uint[] { 52, 53, 0 });
        Dictionary<uint, ProcessTokenChainEvidence> pidReuseEvidence = new Dictionary<uint, ProcessTokenChainEvidence>();
        pidReuseEvidence.Add(51, NewKnownProcessTokenChainEvidence(300));
        pidReuseEvidence.Add(52, NewKnownProcessTokenChainEvidence(90));
        pidReuseEvidence.Add(53, NewKnownProcessTokenChainEvidence(80));
        Dictionary<uint, ulong> pidReuseCreationTimes = new Dictionary<uint, ulong>();
        pidReuseCreationTimes.Add(52, 200);
        ProcessTokenChainDiagnosticResult pidReuseResult = BuildProcessTokenChainDiagnostic(
            new SyntheticProcessTokenChainSource(51, pidReuseSnapshot, pidReuseEvidence,
                new Dictionary<uint, string>(), pidReuseCreationTimes));
        AssertProcessTokenChainResult(pidReuseResult.status == "UNKNOWN" && pidReuseResult.stage == "ANCESTRY_LINK" &&
            pidReuseResult.processes.Length == 2, "pid-reuse-between-link-and-inspection");

        ProcessTokenChainSnapshot queryFailureSnapshot = NewProcessTokenChainSnapshot(new uint[] { 41 }, new uint[] { 0 });
        Dictionary<uint, ProcessTokenChainEvidence> queryFailureEvidence = new Dictionary<uint, ProcessTokenChainEvidence>();
        ProcessTokenChainEvidence queryFailure = NewKnownProcessTokenChainEvidence(50);
        queryFailure.TokenIsAppContainer = "UNKNOWN";
        queryFailure.AppContainerSidPresence = "UNKNOWN";
        queryFailure.PackageIdentity = "UNKNOWN";
        queryFailure.Stage = "TOKEN_OPEN";
        queryFailureEvidence.Add(41, queryFailure);
        ProcessTokenChainDiagnosticResult queryFailureResult = BuildProcessTokenChainDiagnostic(
            new SyntheticProcessTokenChainSource(41, queryFailureSnapshot, queryFailureEvidence,
                new Dictionary<uint, string>(), new Dictionary<uint, ulong>()));
        AssertProcessTokenChainResult(queryFailureResult.status == "UNKNOWN" && queryFailureResult.stage == "TOKEN_OPEN", "query-failure");

        ProcessTokenChainSnapshot cappedSnapshot = new ProcessTokenChainSnapshot();
        Dictionary<uint, ProcessTokenChainEvidence> cappedEvidence = new Dictionary<uint, ProcessTokenChainEvidence>();
        for (uint id = 1000; id >= 990; id--)
        {
            uint parent = id == 990 ? 0 : id - 1;
            cappedSnapshot.ParentByProcessId.Add(id, parent);
            cappedEvidence.Add(id, NewKnownProcessTokenChainEvidence(id));
            if (id == 990) break;
        }
        ProcessTokenChainDiagnosticResult cappedResult = BuildProcessTokenChainDiagnostic(
            new SyntheticProcessTokenChainSource(1000, cappedSnapshot, cappedEvidence,
                new Dictionary<uint, string>(), new Dictionary<uint, ulong>()));
        AssertProcessTokenChainResult(cappedResult.status == "UNKNOWN" && cappedResult.truncated &&
            cappedResult.processes.Length == 9 && cappedResult.processes[8].link_status == "TRUNCATED", "ancestor-cap");

        ProcessTokenChainSnapshot overflowSnapshot = new ProcessTokenChainSnapshot();
        overflowSnapshot.Overflow = true;
        overflowSnapshot.Stage = "PROCESS_ENUMERATION";
        ProcessTokenChainDiagnosticResult overflowResult = BuildProcessTokenChainDiagnostic(
            new SyntheticProcessTokenChainSource(1000, overflowSnapshot, cappedEvidence,
                new Dictionary<uint, string>(), new Dictionary<uint, ulong>()));
        AssertProcessTokenChainResult(overflowResult.status == "UNKNOWN" && overflowResult.truncated &&
            overflowResult.processes.Length == 0, "snapshot-overflow");

        string serialized = valid.schema_version.ToString() + valid.status + valid.stage + valid.truncated.ToString();
        foreach (ProcessTokenChainDiagnosticRow row in valid.processes)
            serialized += row.depth.ToString() + row.link_status + row.token_is_appcontainer +
                row.appcontainer_sid_presence + row.package_identity;
        AssertProcessTokenChainResult(serialized.IndexOf("424242", StringComparison.Ordinal) < 0 &&
            serialized.IndexOf("313131", StringComparison.Ordinal) < 0 && serialized.IndexOf("S-1-", StringComparison.Ordinal) < 0,
            "result-redaction");
        return valid;
    }

    private static ProcessTokenChainDiagnosticResult BuildProcessTokenChainDiagnostic(IProcessTokenChainSource source)
    {
        if (source == null) return CreateUnknownProcessTokenChainResult("PROCESS_SNAPSHOT", false);
        ProcessTokenChainSnapshot snapshot;
        try { snapshot = source.ReadSnapshot(); }
        catch { return CreateUnknownProcessTokenChainResult("PROCESS_SNAPSHOT", false); }
        if (snapshot == null) return CreateUnknownProcessTokenChainResult("PROCESS_SNAPSHOT", false);
        if (snapshot.Overflow || snapshot.ParentByProcessId.Count > MAX_PROCESS_CHAIN_ENTRIES)
            return CreateUnknownProcessTokenChainResult("PROCESS_ENUMERATION", true);
        if (snapshot.DuplicateId)
            return CreateUnknownProcessTokenChainResult("PROCESS_ENUMERATION", false);
        if (snapshot.Stage != "COMPLETE")
            return CreateUnknownProcessTokenChainResult(NormalizeProcessTokenChainStage(snapshot.Stage), false);

        uint processId;
        try { processId = source.CurrentProcessId; }
        catch { return CreateUnknownProcessTokenChainResult("PROCESS_OPEN", false); }
        if (processId == 0) return CreateUnknownProcessTokenChainResult("ANCESTRY_LINK", false);

        ProcessTokenChainDiagnosticResult result = new ProcessTokenChainDiagnosticResult();
        List<ProcessTokenChainDiagnosticRow> rows = new List<ProcessTokenChainDiagnosticRow>();
        HashSet<uint> visited = new HashSet<uint>();
        ulong? expectedCreationTime = null;
        for (int depth = 0; depth <= MAX_PROCESS_CHAIN_ANCESTORS; depth++)
        {
            if (!visited.Add(processId))
            {
                rows.Add(NewUnknownProcessTokenChainRow(depth, "UNKNOWN"));
                return FinishUnknownProcessTokenChainResult(result, rows, "ANCESTRY_LINK", false);
            }

            uint parentProcessId;
            if (!snapshot.ParentByProcessId.TryGetValue(processId, out parentProcessId))
            {
                rows.Add(NewUnknownProcessTokenChainRow(depth, "UNKNOWN"));
                return FinishUnknownProcessTokenChainResult(result, rows, "ANCESTRY_LINK", false);
            }

            ProcessTokenChainEvidence evidence;
            try { evidence = source.InspectProcess(processId); }
            catch { evidence = null; }
            if (evidence == null)
            {
                rows.Add(NewUnknownProcessTokenChainRow(depth, "UNKNOWN"));
                return FinishUnknownProcessTokenChainResult(result, rows, "PROCESS_OPEN", false);
            }

            if (expectedCreationTime.HasValue && evidence.HasCreationTime &&
                evidence.CreationTime != expectedCreationTime.Value)
            {
                rows.Add(NewUnknownProcessTokenChainRow(depth, "UNKNOWN"));
                return FinishUnknownProcessTokenChainResult(result, rows, "ANCESTRY_LINK", false);
            }

            ProcessTokenChainDiagnosticRow row = NewProcessTokenChainRow(depth, "UNKNOWN", evidence);
            if (!IsProcessTokenChainEvidenceComplete(evidence))
            {
                rows.Add(row);
                string failureStage = evidence.Stage == "COMPLETE" ? "TOKEN_APPCONTAINER" : NormalizeProcessTokenChainStage(evidence.Stage);
                return FinishUnknownProcessTokenChainResult(result, rows, failureStage, false);
            }

            if (parentProcessId == 0)
            {
                row.link_status = "ROOT";
                rows.Add(row);
                result.status = "COMPLETE";
                result.stage = "COMPLETE";
                result.truncated = false;
                result.processes = rows.ToArray();
                return result;
            }

            if (visited.Contains(parentProcessId))
            {
                rows.Add(row);
                return FinishUnknownProcessTokenChainResult(result, rows, "ANCESTRY_LINK", false);
            }

            uint ignoredParentProcessId;
            if (!snapshot.ParentByProcessId.TryGetValue(parentProcessId, out ignoredParentProcessId))
            {
                rows.Add(row);
                return FinishUnknownProcessTokenChainResult(result, rows, "ANCESTRY_LINK", false);
            }

            ulong parentCreationTime;
            string timeStage;
            try { timeStage = source.ReadCreationTime(parentProcessId, out parentCreationTime); }
            catch { parentCreationTime = 0; timeStage = "PROCESS_TIME"; }
            if (!String.IsNullOrEmpty(timeStage))
            {
                rows.Add(row);
                return FinishUnknownProcessTokenChainResult(result, rows, NormalizeProcessTokenChainStage(timeStage), false);
            }
            if (parentCreationTime >= evidence.CreationTime)
            {
                rows.Add(row);
                return FinishUnknownProcessTokenChainResult(result, rows, "ANCESTRY_LINK", false);
            }

            expectedCreationTime = parentCreationTime;

            if (depth == MAX_PROCESS_CHAIN_ANCESTORS)
            {
                row.link_status = "TRUNCATED";
                rows.Add(row);
                return FinishUnknownProcessTokenChainResult(result, rows, "ANCESTRY_LINK", true);
            }

            row.link_status = "VERIFIED";
            rows.Add(row);
            processId = parentProcessId;
        }

        return FinishUnknownProcessTokenChainResult(result, rows, "ANCESTRY_LINK", true);
    }

    private static bool IsProcessTokenChainEvidenceComplete(ProcessTokenChainEvidence evidence)
    {
        return evidence != null && evidence.Stage == "COMPLETE" && evidence.HasCreationTime &&
            (evidence.TokenIsAppContainer == "TRUE" || evidence.TokenIsAppContainer == "FALSE") &&
            (evidence.AppContainerSidPresence == "PRESENT" || evidence.AppContainerSidPresence == "ABSENT") &&
            (evidence.PackageIdentity == "PRESENT" || evidence.PackageIdentity == "NO_PACKAGE");
    }

    private static ProcessTokenChainDiagnosticResult FinishUnknownProcessTokenChainResult(
        ProcessTokenChainDiagnosticResult result,
        List<ProcessTokenChainDiagnosticRow> rows,
        string stage,
        bool truncated)
    {
        result.status = "UNKNOWN";
        result.stage = NormalizeProcessTokenChainStage(stage);
        result.truncated = truncated;
        result.processes = rows.Count > MAX_PROCESS_CHAIN_ANCESTORS + 1
            ? rows.GetRange(0, MAX_PROCESS_CHAIN_ANCESTORS + 1).ToArray()
            : rows.ToArray();
        return result;
    }

    private static ProcessTokenChainDiagnosticResult CreateUnknownProcessTokenChainResult(string stage, bool truncated)
    {
        ProcessTokenChainDiagnosticResult result = new ProcessTokenChainDiagnosticResult();
        result.status = "UNKNOWN";
        result.stage = NormalizeProcessTokenChainStage(stage);
        result.truncated = truncated;
        return result;
    }

    private static ProcessTokenChainDiagnosticRow NewUnknownProcessTokenChainRow(int depth, string linkStatus)
    {
        return new ProcessTokenChainDiagnosticRow {
            depth = depth,
            link_status = NormalizeProcessTokenChainLinkStatus(linkStatus),
            token_is_appcontainer = "UNKNOWN",
            appcontainer_sid_presence = "UNKNOWN",
            package_identity = "UNKNOWN"
        };
    }

    private static ProcessTokenChainDiagnosticRow NewProcessTokenChainRow(
        int depth,
        string linkStatus,
        ProcessTokenChainEvidence evidence)
    {
        return new ProcessTokenChainDiagnosticRow {
            depth = depth,
            link_status = NormalizeProcessTokenChainLinkStatus(linkStatus),
            token_is_appcontainer = NormalizeTokenIsAppContainer(evidence.TokenIsAppContainer),
            appcontainer_sid_presence = NormalizeAppContainerSidPresence(evidence.AppContainerSidPresence),
            package_identity = NormalizePackageIdentity(evidence.PackageIdentity)
        };
    }

    private static string NormalizeProcessTokenChainStage(string value)
    {
        string[] allowed = { "PROCESS_SNAPSHOT", "PROCESS_ENUMERATION", "ANCESTRY_LINK", "PROCESS_OPEN", "PROCESS_TIME",
            "TOKEN_OPEN", "TOKEN_APPCONTAINER", "TOKEN_SID", "PACKAGE_IDENTITY", "COMPLETE" };
        return Array.IndexOf(allowed, value) >= 0 ? value : "PROCESS_SNAPSHOT";
    }

    private static string NormalizeProcessTokenChainLinkStatus(string value)
    {
        return value == "ROOT" || value == "VERIFIED" || value == "TRUNCATED" || value == "UNKNOWN" ? value : "UNKNOWN";
    }

    private static string NormalizeTokenIsAppContainer(string value)
    {
        return value == "TRUE" || value == "FALSE" || value == "UNKNOWN" ? value : "UNKNOWN";
    }

    private static string NormalizeAppContainerSidPresence(string value)
    {
        return value == "PRESENT" || value == "ABSENT" || value == "UNKNOWN" ? value : "UNKNOWN";
    }

    private static string NormalizePackageIdentity(string value)
    {
        return value == "PRESENT" || value == "NO_PACKAGE" || value == "UNKNOWN" ? value : "UNKNOWN";
    }

    private static void SetProcessTokenChainFailure(ProcessTokenChainEvidence evidence, string stage)
    {
        if (evidence.Stage == "COMPLETE") evidence.Stage = NormalizeProcessTokenChainStage(stage);
    }

    private static ProcessTokenChainSnapshot NewProcessTokenChainSnapshot(uint[] processIds, uint[] parentIds)
    {
        ProcessTokenChainSnapshot snapshot = new ProcessTokenChainSnapshot();
        if (processIds.Length != parentIds.Length)
        {
            snapshot.Stage = "PROCESS_ENUMERATION";
            return snapshot;
        }
        for (int index = 0; index < processIds.Length; index++)
        {
            if (snapshot.ParentByProcessId.ContainsKey(processIds[index]))
            {
                snapshot.DuplicateId = true;
                continue;
            }
            snapshot.ParentByProcessId.Add(processIds[index], parentIds[index]);
        }
        return snapshot;
    }

    private static ProcessTokenChainEvidence NewKnownProcessTokenChainEvidence(ulong creationTime)
    {
        return new ProcessTokenChainEvidence {
            HasCreationTime = true,
            CreationTime = creationTime,
            TokenIsAppContainer = "FALSE",
            AppContainerSidPresence = "ABSENT",
            PackageIdentity = "NO_PACKAGE",
            Stage = "COMPLETE"
        };
    }

    private static void AssertProcessTokenChainResult(bool passed, string caseName)
    {
        if (!passed) throw new InvalidOperationException("Synthetic process token chain check failed: " + caseName + ".");
    }

    public static bool IsCurrentProcessFullTrust()
    {
        IntPtr token = IntPtr.Zero;
        IntPtr value = IntPtr.Zero;
        try
        {
            using (Process current = Process.GetCurrentProcess())
            {
                if (!OpenProcessToken(current.Handle, TOKEN_QUERY, out token))
                    throw LastError("OpenProcessToken(current process)");
            }
            value = Marshal.AllocHGlobal(sizeof(int));
            uint returned;
            if (!GetTokenInformation(token, TokenIsAppContainer, value, sizeof(int), out returned))
                throw LastError("GetTokenInformation(current TokenIsAppContainer)");
            return Marshal.ReadInt32(value) == 0;
        }
        finally
        {
            if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    public static ProfileMappingReadOnlyResult ObserveProfileMappingReadOnly(string profileName)
    {
        ValidateGeneratedProfileName(profileName);
        ProfileMappingReadOnlyResult observation = new ProfileMappingReadOnlyResult();
        IntPtr sid = IntPtr.Zero;
        IntPtr sidText = IntPtr.Zero;
        IntPtr path = IntPtr.Zero;
        try
        {
            int deriveResult = DeriveAppContainerSidFromAppContainerName(profileName, out sid);
            observation.SidDerivationHResult = deriveResult;
            if (deriveResult < 0 || sid == IntPtr.Zero) return observation;
            if (!ConvertSidToStringSid(sid, out sidText)) throw LastError("ConvertSidToStringSid");
            string sidString = sidText == IntPtr.Zero ? null : Marshal.PtrToStringUni(sidText);
            if (String.IsNullOrEmpty(sidString)) return observation;
            observation.ApiHResult = GetAppContainerFolderPath(sidString, out path);
            observation.PathPresent = path != IntPtr.Zero;
            return observation;
        }
        finally
        {
            if (path != IntPtr.Zero) CoTaskMemFree(path);
            if (sidText != IntPtr.Zero) LocalFree(sidText);
            if (sid != IntPtr.Zero) FreeSid(sid);
        }
    }

    public static bool ProfileSidMatchesName(string profileSid, string profileName)
    {
        ValidateGeneratedProfileName(profileName);
        if (String.IsNullOrWhiteSpace(profileSid))
            throw new ArgumentException("AppContainer SID is required.", "profileSid");
        IntPtr actualSid = IntPtr.Zero;
        IntPtr derivedSid = IntPtr.Zero;
        try
        {
            if (!ConvertStringSidToSid(profileSid, out actualSid))
                throw LastError("ConvertStringSidToSid(profile SID)");
            int result = DeriveAppContainerSidFromAppContainerName(profileName, out derivedSid);
            if (result < 0)
            {
                InvalidOperationException failure = new InvalidOperationException(
                    "DeriveAppContainerSidFromAppContainerName failed: 0x" + result.ToString("X8"));
                failure.Data["api_hresult"] = result;
                failure.Data["api_operation"] = "DeriveAppContainerSidFromAppContainerName";
                throw failure;
            }
            return derivedSid != IntPtr.Zero && EqualSid(actualSid, derivedSid);
        }
        finally
        {
            if (actualSid != IntPtr.Zero) LocalFree(actualSid);
            if (derivedSid != IntPtr.Zero) FreeSid(derivedSid);
        }
    }

    public static ProfilePathDiagnosticResult ObserveProfilePath(
        string profileSid,
        string profileName,
        string nonce,
        string candidatePath)
    {
        string canonicalCandidate = ValidateProfileCandidatePath(candidatePath, profileName, nonce);
        ProfilePathDiagnosticResult observation = new ProfilePathDiagnosticResult();
        IntPtr path = IntPtr.Zero;
        try
        {
            observation.ApiHResult = GetAppContainerFolderPath(profileSid, out path);
            if (observation.ApiHResult < 0 || path == IntPtr.Zero) return observation;
            try
            {
                string value = Marshal.PtrToStringUni(path);
                string canonicalApiPath = GetCanonicalLocalDrivePath(value, "profileApiPath");
                string expectedSuffix = "\\Packages\\" + profileName + "\\AC";
                if (canonicalApiPath.Length <= expectedSuffix.Length + 3 ||
                    !canonicalApiPath.EndsWith(expectedSuffix, StringComparison.OrdinalIgnoreCase))
                    return observation;
                EnsureNoReparsePointsInPath(canonicalApiPath);
                observation.CandidateMatched = String.Equals(
                    canonicalApiPath, canonicalCandidate, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                observation.CandidateMatched = false;
            }
            return observation;
        }
        finally
        {
            if (path != IntPtr.Zero) CoTaskMemFree(path);
        }
    }

    public static StartupAttributeDiagnosticResult RunStartupAttributeDiagnostics(
        string nodePath,
        string workingDirectory,
        string profileSid,
        string profileName)
    {
        return RunStartupAttributeDiagnostics(nodePath, workingDirectory, profileSid, profileName,
            new string[0], new byte[0][], new string[0], new byte[0][]);
    }

    public static StartupAttributeDiagnosticResult RunStartupAttributeDiagnostics(
        string nodePath,
        string workingDirectory,
        string profileSid,
        string profileName,
        string[] directoryLabels,
        byte[][] directorySecurityDescriptors)
    {
        return RunStartupAttributeDiagnostics(nodePath, workingDirectory, profileSid, profileName,
            directoryLabels, directorySecurityDescriptors, new string[0], new byte[0][]);
    }

    public static StartupAttributeDiagnosticResult RunStartupAttributeDiagnostics(
        string nodePath,
        string workingDirectory,
        string profileSid,
        string profileName,
        string[] directoryLabels,
        byte[][] directorySecurityDescriptors,
        string[] stagedFileLabels,
        byte[][] stagedFileSecurityDescriptors)
    {
        StartupAttributeDiagnosticResult result = new StartupAttributeDiagnosticResult();
        result.Control = RunSuspendedStartupVariant(nodePath, workingDirectory, profileSid, profileName,
            false, directoryLabels, directorySecurityDescriptors, stagedFileLabels, stagedFileSecurityDescriptors);
        if (result.Control.Passed && result.Control.CleanupStatus == "PASS" && !result.Control.FallbackUsed)
            result.AppContainer = RunSuspendedStartupVariant(nodePath, workingDirectory, profileSid, profileName,
                true, directoryLabels, directorySecurityDescriptors, stagedFileLabels, stagedFileSecurityDescriptors);
        return result;
    }

    private static SuspendedStartupVariantResult RunSuspendedStartupVariant(
        string nodePath,
        string workingDirectory,
        string profileSid,
        string profileName,
        bool appContainer,
        string[] directoryLabels,
        byte[][] directorySecurityDescriptors,
        string[] stagedFileLabels,
        byte[][] stagedFileSecurityDescriptors)
    {
        SuspendedStartupVariantResult result = new SuspendedStartupVariantResult();
        result.Attempted = true;
        if (String.IsNullOrWhiteSpace(nodePath) || String.IsNullOrWhiteSpace(workingDirectory) ||
            String.IsNullOrWhiteSpace(profileSid) || String.IsNullOrWhiteSpace(profileName))
        {
            result.SetupErrorCode = unchecked((int)0x80070057);
            return result;
        }

        IntPtr job = IntPtr.Zero;
        IntPtr appSid = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        IntPtr capabilitiesBuffer = IntPtr.Zero;
        IntPtr jobListBuffer = IntPtr.Zero;
        IntPtr limitsBuffer = IntPtr.Zero;
        bool attributesInitialized = false;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();

        try
        {
            try
            {
                if (appContainer && !ConvertStringSidToSid(profileSid, out appSid))
                    throw LastError("ConvertStringSidToSid");

                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw LastError("CreateJobObject");
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
                limits.BasicLimitInformation.ActiveProcessLimit = 8;
                limits.JobMemoryLimit = MAX_JOB_MEMORY_BYTES;
                limitsBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
                Marshal.StructureToPtr(limits, limitsBuffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsBuffer,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                    throw LastError("SetInformationJobObject");

                int attributeCount = appContainer ? 2 : 1;
                IntPtr attributeSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref attributeSize);
                if (attributeSize == IntPtr.Zero) throw LastError("InitializeProcThreadAttributeList(size)");
                attributes = Marshal.AllocHGlobal(attributeSize);
                if (!InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref attributeSize))
                    throw LastError("InitializeProcThreadAttributeList");
                attributesInitialized = true;

                if (appContainer)
                {
                    SECURITY_CAPABILITIES security = new SECURITY_CAPABILITIES();
                    security.AppContainerSid = appSid;
                    security.Capabilities = IntPtr.Zero;
                    security.CapabilityCount = 0;
                    security.Reserved = 0;
                    capabilitiesBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
                    Marshal.StructureToPtr(security, capabilitiesBuffer, false);
                    if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilitiesBuffer,
                        new UIntPtr((uint)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero))
                        throw LastError("UpdateProcThreadAttribute(AppContainer)");
                }

                jobListBuffer = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobListBuffer, job);
                result.JobListAttributeAttempted = true;
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobListBuffer,
                    new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                {
                    result.JobListAttributeErrorCode = Marshal.GetLastWin32Error();
                    throw LastError("UpdateProcThreadAttribute(JobList)");
                }
                result.JobListAttributeSucceeded = true;

                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.lpAttributeList = attributes;
                StringBuilder commandLine = new StringBuilder(Quote(nodePath));
                string profileLocalAppData = appContainer ? GetProfileLocalAppDataPath(profileSid, profileName) : null;
                environment = BuildEnvironment(nodePath, workingDirectory, profileName, profileLocalAppData);
                uint creationFlags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT |
                    CREATE_NO_WINDOW | CREATE_SUSPENDED;
                if (!CreateProcess(nodePath, commandLine, IntPtr.Zero, IntPtr.Zero, false, creationFlags,
                    environment, workingDirectory, ref startup, out process))
                    result.CreateErrorCode = Marshal.GetLastWin32Error();
            }
            catch (Exception error)
            {
                result.SetupErrorCode = GetDiagnosticErrorCode(error);
            }

            if (process.hProcess != IntPtr.Zero)
            {
                result.ProcessCreated = true;
                VerifySuspendedDiagnosticMembership(process.hProcess, job, result);
                if (appContainer)
                {
                    bool tokenVerified = false;
                    try
                    {
                        tokenVerified = VerifyProcessToken(process.hProcess, appSid);
                        result.AppContainerTokenVerified = tokenVerified;
                    }
                    catch (Exception error) { result.TokenErrorCode = GetDiagnosticErrorCode(error); }

                    if (tokenVerified)
                        InspectSuspendedAppContainerToken(process.hProcess, directoryLabels,
                            directorySecurityDescriptors, stagedFileLabels, stagedFileSecurityDescriptors, result);
                    else
                    {
                        result.DirectoryTraverseDiagnostics = CreateUnknownDirectoryTraverseDiagnostics(directoryLabels);
                        result.StagedFileReadDiagnostics = CreateUnknownStagedFileReadDiagnostics(stagedFileLabels);
                    }
                }
                StopSuspendedDiagnosticProcess(ref job, ref process, result);
            }
            else
            {
                result.CleanupStatus = "UNKNOWN";
            }
        }
        finally
        {
            int cleanupError = 0;
            if (!result.CleanupConfirmed)
                EnsureSuspendedDiagnosticCleanup(ref job, ref process, result);
            if (attributesInitialized)
            {
                try { DeleteProcThreadAttributeList(attributes); }
                catch (Exception error) { RecordFirstError(ref cleanupError, GetDiagnosticErrorCode(error)); }
            }
            FreeDiagnosticBuffer(attributes, ref cleanupError);
            FreeDiagnosticBuffer(capabilitiesBuffer, ref cleanupError);
            FreeDiagnosticBuffer(jobListBuffer, ref cleanupError);
            FreeDiagnosticBuffer(limitsBuffer, ref cleanupError);

            if (appSid != IntPtr.Zero)
            {
                try
                {
                    if (LocalFree(appSid) != IntPtr.Zero)
                        RecordFirstError(ref cleanupError, Marshal.GetLastWin32Error());
                }
                catch (Exception error) { RecordFirstError(ref cleanupError, GetDiagnosticErrorCode(error)); }
            }
            FreeDiagnosticBuffer(environment, ref cleanupError);

            CloseDiagnosticHandle(process.hThread, ref cleanupError);
            CloseDiagnosticHandle(process.hProcess, ref cleanupError);
            CloseDiagnosticHandle(job, ref cleanupError);

            if (cleanupError != 0)
            {
                result.ResourceCleanupErrorCode = cleanupError;
                result.CleanupConfirmed = false;
                result.CleanupStatus = "FAIL";
            }
        }

        result.Passed = result.ProcessCreated && result.JobMembershipVerified &&
            result.JobListAttributeSucceeded &&
            (!appContainer || result.AppContainerTokenVerified) && result.TerminateJobSucceeded &&
            result.RootProcessSignaled && result.JobDrained && !result.FallbackUsed &&
            result.CleanupConfirmed && result.CleanupStatus == "PASS" && result.ResourceCleanupErrorCode == 0;
        return result;
    }

    private static void VerifySuspendedDiagnosticMembership(
        IntPtr process,
        IntPtr job,
        SuspendedStartupVariantResult result)
    {
        try
        {
            bool assigned;
            if (!IsProcessInJob(process, job, out assigned))
                result.MembershipErrorCode = Marshal.GetLastWin32Error();
            else
                result.JobMembershipVerified = assigned;
        }
        catch (Exception error)
        {
            result.MembershipErrorCode = GetDiagnosticErrorCode(error);
        }
    }

    private static void StopSuspendedDiagnosticProcess(
        ref IntPtr job,
        ref PROCESS_INFORMATION process,
        SuspendedStartupVariantResult result)
    {
        int errorCode;
        result.TerminateJobSucceeded = TryTerminateJob(job, 125, out errorCode);
        result.TerminateJobErrorCode = errorCode;
        if (result.TerminateJobSucceeded && TryObserveSuspendedCleanup(ref job, ref process, result, false))
            return;

        result.FallbackUsed = true;
        TryTerminateJob(job, 126, out errorCode);
        result.RetryTerminateErrorCode = errorCode;
        if (process.hProcess != IntPtr.Zero)
        {
            TryTerminateProcess(process.hProcess, 126, out errorCode);
            result.TerminateProcessErrorCode = errorCode;
        }
        TryObserveSuspendedCleanup(ref job, ref process, result, true);
    }

    private static void EnsureSuspendedDiagnosticCleanup(
        ref IntPtr job,
        ref PROCESS_INFORMATION process,
        SuspendedStartupVariantResult result)
    {
        result.FallbackUsed = true;
        int errorCode;
        if (job != IntPtr.Zero)
        {
            TryTerminateJob(job, 127, out errorCode);
            result.RetryTerminateErrorCode = FirstError(result.RetryTerminateErrorCode, errorCode);
        }
        if (process.hProcess != IntPtr.Zero)
        {
            TryTerminateProcess(process.hProcess, 127, out errorCode);
            result.RetryTerminateProcessErrorCode = FirstError(result.RetryTerminateProcessErrorCode, errorCode);
        }
        TryObserveSuspendedCleanup(ref job, ref process, result, true);
    }

    private static bool TryObserveSuspendedCleanup(
        ref IntPtr job,
        ref PROCESS_INFORMATION process,
        SuspendedStartupVariantResult result,
        bool fallback)
    {
        int waitCode = 0;
        bool rootSignaled;
        if (process.hProcess == IntPtr.Zero)
        {
            rootSignaled = result.RootProcessSignaled;
            waitCode = rootSignaled ? 0 : 6;
        }
        else
        {
            rootSignaled = TryWaitForProcessSignal(process.hProcess, 5000, out waitCode);
        }
        result.FinalProcessWaitCode = waitCode;
        if (process.hProcess != IntPtr.Zero)
        {
            result.ProcessWaitCode = waitCode;
            if (fallback) result.FallbackProcessWaitCode = waitCode;
        }
        if (!rootSignaled)
        {
            result.DrainDiagnostic = "Root process handle did not signal within the bounded cleanup wait.";
            result.CleanupStatus = "FAIL";
            return false;
        }

        result.RootProcessSignaled = true;
        result.FinalRootProcessSignaled = true;
        if (fallback) result.FallbackRootProcessSignaled = true;

        int closeError;
        if (!TryCloseRootProcessHandles(ref process, out closeError))
        {
            result.ResourceCleanupErrorCode = FirstError(result.ResourceCleanupErrorCode, closeError);
            result.DrainDiagnostic = "Root process/thread handles could not be closed before Job drain polling.";
            result.CleanupStatus = "FAIL";
            return false;
        }

        uint activeProcesses = 0;
        int queryErrorCode = 0;
        int pollWaitCode = 0;
        bool drained = job != IntPtr.Zero &&
            TryWaitForJobDrain(job, 5000, out activeProcesses, out queryErrorCode, out pollWaitCode);
        if (job == IntPtr.Zero)
        {
            activeProcesses = 0;
            queryErrorCode = 6;
            pollWaitCode = 0;
        }
        result.JobDrained = drained;
        result.ActiveProcessesAfterDrain = queryErrorCode == 0 ? (uint?)activeProcesses : null;
        result.ActiveProcessQueryErrorCode = FirstError(result.ActiveProcessQueryErrorCode, queryErrorCode);
        result.DrainPollWaitCode = FirstError(result.DrainPollWaitCode, pollWaitCode);
        result.DrainDiagnostic = drained
            ? "Job ActiveProcesses reached zero after the root process signaled and its handles were closed."
            : queryErrorCode != 0
                ? "Job ActiveProcesses could not be queried; cleanup is unconfirmed."
                : "Job ActiveProcesses did not reach zero before the bounded drain deadline.";
        result.CleanupConfirmed = result.RootProcessSignaled && result.JobDrained;
        result.CleanupStatus = result.CleanupConfirmed ? "PASS" : "FAIL";
        return result.CleanupConfirmed;
    }

    private static bool TryTerminateJob(IntPtr job, uint exitCode, out int errorCode)
    {
        errorCode = 0;
        if (job == IntPtr.Zero)
        {
            errorCode = 6;
            return false;
        }
        try
        {
            if (TerminateJobObject(job, exitCode)) return true;
            errorCode = Marshal.GetLastWin32Error();
        }
        catch (Exception error) { errorCode = GetDiagnosticErrorCode(error); }
        return false;
    }

    private static bool TryTerminateProcess(IntPtr process, uint exitCode, out int errorCode)
    {
        errorCode = 0;
        if (process == IntPtr.Zero)
        {
            errorCode = 6;
            return false;
        }
        try
        {
            if (TerminateProcess(process, exitCode)) return true;
            errorCode = Marshal.GetLastWin32Error();
        }
        catch (Exception error) { errorCode = GetDiagnosticErrorCode(error); }
        return false;
    }

    private static bool TryWaitForProcessSignal(IntPtr process, uint timeoutMs, out int waitCode)
    {
        waitCode = 0;
        if (process == IntPtr.Zero)
        {
            waitCode = 6;
            return false;
        }
        try
        {
            uint wait = WaitForSingleObject(process, timeoutMs);
            if (wait == WAIT_OBJECT_0) return true;
            waitCode = wait == WAIT_FAILED ? Marshal.GetLastWin32Error() : unchecked((int)wait);
        }
        catch (Exception error) { waitCode = GetDiagnosticErrorCode(error); }
        return false;
    }

    private static bool TryCloseRootProcessHandles(ref PROCESS_INFORMATION process, out int errorCode)
    {
        errorCode = 0;
        if (process.hThread != IntPtr.Zero)
        {
            if (!TryCloseHandle(process.hThread, out errorCode)) return false;
            process.hThread = IntPtr.Zero;
        }
        if (process.hProcess != IntPtr.Zero)
        {
            if (!TryCloseHandle(process.hProcess, out errorCode)) return false;
            process.hProcess = IntPtr.Zero;
        }
        return true;
    }

    private static void CloseRootProcessHandlesOrThrow(ref PROCESS_INFORMATION process)
    {
        int errorCode;
        if (!TryCloseRootProcessHandles(ref process, out errorCode))
            throw CreateApiWin32Exception("CloseHandle(root process)", "Could not release root process and thread handles before Job drain verification.", errorCode);
    }

    private static bool TryWaitForJobDrain(
        IntPtr job,
        int timeoutMs,
        out uint activeProcesses,
        out int queryErrorCode,
        out int pollWaitCode,
        Action pump = null)
    {
        activeProcesses = 0;
        queryErrorCode = 0;
        pollWaitCode = 0;
        Stopwatch timer = Stopwatch.StartNew();
        while (true)
        {
            if (pump != null) pump();
            if (!TryGetJobActiveProcessCount(job, out activeProcesses, out queryErrorCode)) return false;
            if (GetJobDrainDecision(true, activeProcesses) == "drained") return true;

            uint waitMilliseconds = GetDeadlineWaitMilliseconds(timer.ElapsedMilliseconds, timeoutMs);
            if (waitMilliseconds == 0)
            {
                pollWaitCode = unchecked((int)WAIT_TIMEOUT);
                return false;
            }
            System.Threading.Thread.Sleep((int)waitMilliseconds);
        }
    }

    private static Exception CreateJobDrainFailure(uint activeProcesses, int queryErrorCode, int pollWaitCode)
    {
        if (queryErrorCode != 0)
            return CreateApiWin32Exception("QueryInformationJobObject",
                "Job ActiveProcesses could not be queried after termination; cleanup is unconfirmed.", queryErrorCode);
        if (pollWaitCode == unchecked((int)WAIT_TIMEOUT))
            return new TimeoutException("Job ActiveProcesses remained nonzero after termination; cleanup is unconfirmed.");
        return new InvalidOperationException("Job drain polling failed; cleanup is unconfirmed (active processes: " +
            activeProcesses.ToString() + ", wait code: " + pollWaitCode.ToString() + ").");
    }

    private static bool TryCloseHandle(IntPtr handle, out int errorCode)
    {
        errorCode = 0;
        if (handle == IntPtr.Zero) return true;
        try
        {
            if (CloseHandle(handle)) return true;
            errorCode = Marshal.GetLastWin32Error();
        }
        catch (Exception error) { errorCode = GetDiagnosticErrorCode(error); }
        return false;
    }

    private static void CloseDiagnosticHandle(IntPtr handle, ref int cleanupError)
    {
        if (handle == IntPtr.Zero) return;
        int errorCode;
        if (TryCloseHandle(handle, out errorCode)) return;
        RecordFirstError(ref cleanupError, errorCode);
        if (!TryCloseHandle(handle, out errorCode))
            RecordFirstError(ref cleanupError, errorCode);
    }

    private static void FreeDiagnosticBuffer(IntPtr buffer, ref int cleanupError)
    {
        if (buffer == IntPtr.Zero) return;
        try { Marshal.FreeHGlobal(buffer); }
        catch (Exception error) { RecordFirstError(ref cleanupError, GetDiagnosticErrorCode(error)); }
    }

    private static void RecordFirstError(ref int target, int errorCode)
    {
        if (target == 0 && errorCode != 0) target = errorCode;
    }

    private static int FirstError(int current, int errorCode)
    {
        return current == 0 ? errorCode : current;
    }

    private static int GetDiagnosticErrorCode(Exception error)
    {
        if (error != null && error.Data != null && error.Data.Contains("api_native_error_code") &&
            error.Data["api_native_error_code"] is int)
            return (int)error.Data["api_native_error_code"];
        if (error is Win32Exception) return ((Win32Exception)error).NativeErrorCode;
        return error == null ? 0 : error.HResult;
    }

    private static bool TryGetJobActiveProcessCount(IntPtr job, out uint activeProcesses, out int errorCode)
    {
        activeProcesses = 0;
        errorCode = 0;
        try
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
            bool queried = QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                out information,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                IntPtr.Zero);
            if (!queried)
            {
                errorCode = Marshal.GetLastWin32Error();
                return false;
            }
            activeProcesses = information.ActiveProcesses;
            return true;
        }
        catch (Exception error)
        {
            errorCode = GetDiagnosticErrorCode(error);
            return false;
        }
    }

    private static bool TryGetJobAccountingSnapshot(
        IntPtr job,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        out int errorCode)
    {
        information = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
        errorCode = 0;
        try
        {
            if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out information,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
                return true;
            errorCode = Marshal.GetLastWin32Error();
        }
        catch (Exception error) { errorCode = GetDiagnosticErrorCode(error); }
        return false;
    }

    private static bool TryGetJobActiveProcessLimit(
        IntPtr job,
        out JOBOBJECT_BASIC_LIMIT_INFORMATION information,
        out int errorCode)
    {
        information = new JOBOBJECT_BASIC_LIMIT_INFORMATION();
        errorCode = 0;
        try
        {
            if (QueryInformationJobObject(job, JobObjectBasicLimitInformation, out information,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION)), IntPtr.Zero))
                return true;
            errorCode = Marshal.GetLastWin32Error();
        }
        catch (Exception error) { errorCode = GetDiagnosticErrorCode(error); }
        return false;
    }

    private static bool TryGetJobProcessIdList(
        IntPtr job,
        out uint assignedCount,
        out uint returnedCount,
        out uint[] processIds,
        out bool complete,
        out int errorCode)
    {
        const int headerSize = sizeof(uint) * 2;
        assignedCount = 0;
        returnedCount = 0;
        processIds = new uint[0];
        complete = false;
        errorCode = 0;
        IntPtr buffer = IntPtr.Zero;
        try
        {
            int bufferSize = checked(headerSize + MAX_JOB_PROCESS_ID_LIST_CAPACITY * IntPtr.Size);
            buffer = Marshal.AllocHGlobal(bufferSize);
            Marshal.Copy(new byte[bufferSize], 0, buffer, bufferSize);
            if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer,
                (uint)bufferSize, IntPtr.Zero))
            {
                errorCode = Marshal.GetLastWin32Error();
                return false;
            }

            assignedCount = unchecked((uint)Marshal.ReadInt32(buffer, 0));
            returnedCount = unchecked((uint)Marshal.ReadInt32(buffer, sizeof(uint)));
            if (returnedCount > MAX_JOB_PROCESS_ID_LIST_CAPACITY ||
                assignedCount > MAX_JOB_PROCESS_ID_LIST_CAPACITY || returnedCount > assignedCount)
            {
                errorCode = ERROR_MORE_DATA;
                return true;
            }

            uint[] observed = new uint[returnedCount];
            for (uint index = 0; index < returnedCount; index++)
            {
                int offset = checked(headerSize + (int)index * IntPtr.Size);
                ulong processId = IntPtr.Size == 8
                    ? unchecked((ulong)Marshal.ReadInt64(buffer, offset))
                    : unchecked((uint)Marshal.ReadInt32(buffer, offset));
                if (processId == 0 || processId > UInt32.MaxValue)
                {
                    errorCode = ERROR_MORE_DATA;
                    processIds = new uint[0];
                    return true;
                }
                observed[index] = (uint)processId;
            }
            processIds = observed;
            complete = assignedCount == returnedCount;
            if (!complete) errorCode = ERROR_MORE_DATA;
            return true;
        }
        catch (Exception error)
        {
            errorCode = GetDiagnosticErrorCode(error);
            processIds = new uint[0];
            complete = false;
            return false;
        }
        finally
        {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool TryReadHostJobProcessMetadata(
        HashSet<uint> processIds,
        out Dictionary<uint, HostJobProcessMetadata> metadata,
        ref int cleanupError)
    {
        metadata = new Dictionary<uint, HostJobProcessMetadata>();
        if (processIds == null || processIds.Count == 0 || processIds.Count > MAX_JOB_PROCESS_ID_LIST_CAPACITY)
            return false;

        IntPtr snapshot = IntPtr.Zero;
        bool complete = false;
        try
        {
            snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return false;

            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snapshot, ref entry)) return false;

            int enumerated = 0;
            while (true)
            {
                enumerated++;
                if (enumerated > MAX_PROCESS_CHAIN_ENUMERATION) return false;
                if (processIds.Contains(entry.th32ProcessID))
                {
                    if (metadata.ContainsKey(entry.th32ProcessID)) return false;
                    HostJobProcessMetadata item = new HostJobProcessMetadata();
                    item.ParentProcessId = entry.th32ParentProcessID;
                    item.ImageName = entry.szExeFile;
                    metadata.Add(entry.th32ProcessID, item);
                    if (metadata.Count == processIds.Count)
                    {
                        complete = true;
                        break;
                    }
                }

                if (!Process32Next(snapshot, ref entry))
                {
                    complete = Marshal.GetLastWin32Error() == ERROR_NO_MORE_FILES &&
                        metadata.Count == processIds.Count;
                    break;
                }
            }
        }
        catch { complete = false; }
        finally
        {
            if (snapshot != IntPtr.Zero && snapshot != new IntPtr(-1))
                CloseDiagnosticHandle(snapshot, ref cleanupError);
        }
        return complete && cleanupError == 0;
    }

    private static string ClassifyHostJobProcessImageName(string imageName)
    {
        if (String.IsNullOrEmpty(imageName)) return "UNKNOWN";
        if (String.Equals(imageName, "node.exe", StringComparison.OrdinalIgnoreCase)) return "NODE";
        if (String.Equals(imageName, "conhost.exe", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(imageName, "OpenConsole.exe", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(imageName, "WindowsTerminal.exe", StringComparison.OrdinalIgnoreCase))
            return "CONSOLE_HOST";
        if (String.Equals(imageName, "cmd.exe", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(imageName, "powershell.exe", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(imageName, "pwsh.exe", StringComparison.OrdinalIgnoreCase))
            return "COMMAND_SHELL";
        return "OTHER";
    }

    private static void CaptureHostJobMemberDiagnostics(IntPtr job, HostProcessTreeTestRunResult result)
    {
        if (!result.JobProcessIdListQuerySucceeded || !result.JobProcessIdListComplete ||
            result.JobProcessIdsAtDeadline == null || result.JobProcessIdsAtDeadline.Length == 0 ||
            result.JobProcessIdsAtDeadline.Length > MAX_JOB_PROCESS_ID_LIST_CAPACITY)
            return;

        uint[] processIds = result.JobProcessIdsAtDeadline;
        HashSet<uint> processIdSet = new HashSet<uint>();
        bool membershipMismatch = false;
        bool observationComplete = true;
        for (int index = 0; index < processIds.Length; index++)
        {
            if (processIds[index] == 0 || !processIdSet.Add(processIds[index])) membershipMismatch = true;
        }

        Dictionary<uint, IntPtr> processHandles = new Dictionary<uint, IntPtr>();
        List<IntPtr> processHandlesToClose = new List<IntPtr>();
        HashSet<uint> membershipVerifiedIds = new HashSet<uint>();
        HashSet<uint> notInJobIds = new HashSet<uint>();
        HashSet<uint> membershipUnknownIds = new HashSet<uint>();
        uint openCount = 0;
        uint membershipVerifiedCount = 0;
        uint notInJobCount = 0;
        uint membershipUnknownCount = (uint)processIds.Length;
        uint nodeImageCount = 0;
        uint consoleHostImageCount = 0;
        uint commandShellImageCount = 0;
        uint otherImageCount = 0;
        uint imageUnknownCount = (uint)processIds.Length;
        uint metadataUnknownCount = (uint)processIds.Length;
        uint? parentIdMatchesJobMemberCount = null;
        bool metadataSnapshotComplete = false;
        bool? jobSetStable = null;
        bool membershipVerificationCompleted = false;
        int diagnosticCleanupError = 0;
        try
        {
            for (int index = 0; index < processIds.Length; index++)
            {
                uint processId = processIds[index];
                if (processId == 0 || processHandles.ContainsKey(processId)) continue;

                IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
                if (process == IntPtr.Zero)
                {
                    membershipUnknownCount++;
                    observationComplete = false;
                    continue;
                }
                processHandlesToClose.Add(process);

                if (GetProcessId(process) != processId)
                {
                    membershipMismatch = true;
                    continue;
                }
                openCount++;
                processHandles.Add(processId, process);
            }

            Dictionary<uint, HostJobProcessMetadata> processMetadata;
            metadataSnapshotComplete = TryReadHostJobProcessMetadata(processIdSet,
                out processMetadata, ref diagnosticCleanupError);

            uint reassignedCount;
            uint requeryReturnedCount;
            uint[] requeryProcessIds;
            bool requeryComplete;
            int requeryError;
            bool requerySucceeded = TryGetJobProcessIdList(job, out reassignedCount,
                out requeryReturnedCount, out requeryProcessIds, out requeryComplete, out requeryError);
            if (!requerySucceeded || requeryError != 0 || !requeryComplete || reassignedCount != (uint)processIds.Length ||
                requeryReturnedCount != (uint)processIds.Length)
            {
                observationComplete = false;
            }
            else
            {
                HashSet<uint> requerySet = new HashSet<uint>();
                bool requerySetValid = true;
                for (int index = 0; index < requeryProcessIds.Length; index++)
                {
                    if (requeryProcessIds[index] == 0 || !requerySet.Add(requeryProcessIds[index]))
                        requerySetValid = false;
                }
                jobSetStable = requerySetValid && processIdSet.Count == processIds.Length &&
                    requerySet.SetEquals(processIdSet);
                if (jobSetStable == false) membershipMismatch = true;
            }

            for (int index = 0; index < processIds.Length; index++)
            {
                uint processId = processIds[index];
                IntPtr process;
                if (processId == 0 || !processHandles.TryGetValue(processId, out process))
                {
                    membershipUnknownIds.Add(processId);
                    continue;
                }

                if (GetProcessId(process) != processId)
                {
                    membershipMismatch = true;
                    continue;
                }

                bool assigned;
                if (!IsProcessInJob(process, job, out assigned))
                {
                    membershipUnknownIds.Add(processId);
                    observationComplete = false;
                }
                else if (assigned) membershipVerifiedIds.Add(processId);
                else
                {
                    notInJobIds.Add(processId);
                    membershipMismatch = true;
                }
            }
            membershipVerificationCompleted = true;

            bool mayAssociateMetadata = metadataSnapshotComplete && jobSetStable == true &&
                membershipVerifiedIds.Count == processIdSet.Count && notInJobIds.Count == 0 &&
                membershipUnknownIds.Count == 0 && !membershipMismatch;
            if (mayAssociateMetadata)
            {
                imageUnknownCount = 0;
                metadataUnknownCount = 0;
                parentIdMatchesJobMemberCount = 0;
                for (int index = 0; index < processIds.Length; index++)
                {
                    HostJobProcessMetadata item;
                    if (!processMetadata.TryGetValue(processIds[index], out item))
                    {
                        metadataUnknownCount++;
                        imageUnknownCount++;
                        continue;
                    }

                    string imageCategory = ClassifyHostJobProcessImageName(item.ImageName);
                    if (imageCategory == "NODE") nodeImageCount++;
                    else if (imageCategory == "CONSOLE_HOST") consoleHostImageCount++;
                    else if (imageCategory == "COMMAND_SHELL") commandShellImageCount++;
                    else if (imageCategory == "OTHER") otherImageCount++;
                    else
                    {
                        metadataUnknownCount++;
                        imageUnknownCount++;
                    }

                    if (item.ParentProcessId != 0 && item.ParentProcessId != processIds[index] &&
                        processIdSet.Contains(item.ParentProcessId))
                        parentIdMatchesJobMemberCount++;
                }

                uint finalAssignedCount;
                uint finalReturnedCount;
                uint[] finalProcessIds;
                bool finalComplete;
                int finalQueryError;
                bool finalQuerySucceeded = TryGetJobProcessIdList(job, out finalAssignedCount,
                    out finalReturnedCount, out finalProcessIds, out finalComplete, out finalQueryError);
                if (!finalQuerySucceeded || finalQueryError != 0 || !finalComplete ||
                    finalAssignedCount != (uint)processIds.Length || finalReturnedCount != (uint)processIds.Length)
                {
                    observationComplete = false;
                    jobSetStable = null;
                }
                else
                {
                    HashSet<uint> finalProcessIdSet = new HashSet<uint>();
                    bool finalSetValid = true;
                    for (int index = 0; index < finalProcessIds.Length; index++)
                    {
                        if (finalProcessIds[index] == 0 || !finalProcessIdSet.Add(finalProcessIds[index]))
                            finalSetValid = false;
                    }
                    jobSetStable = finalSetValid && finalProcessIdSet.SetEquals(processIdSet);
                    if (jobSetStable == false) membershipMismatch = true;
                }

                if (jobSetStable == true)
                {
                    for (int index = 0; index < processIds.Length; index++)
                    {
                        uint processId = processIds[index];
                        IntPtr process;
                        if (processId == 0 || !processHandles.TryGetValue(processId, out process))
                        {
                            membershipUnknownIds.Add(processId);
                            observationComplete = false;
                            continue;
                        }
                        if (GetProcessId(process) != processId)
                        {
                            membershipMismatch = true;
                            continue;
                        }
                        bool assigned;
                        if (!IsProcessInJob(process, job, out assigned))
                        {
                            membershipUnknownIds.Add(processId);
                            observationComplete = false;
                        }
                        else if (!assigned)
                        {
                            notInJobIds.Add(processId);
                            membershipMismatch = true;
                        }
                    }
                }

                if (jobSetStable != true || membershipMismatch || !observationComplete)
                {
                    nodeImageCount = 0;
                    consoleHostImageCount = 0;
                    commandShellImageCount = 0;
                    otherImageCount = 0;
                    imageUnknownCount = (uint)processIds.Length;
                    metadataUnknownCount = (uint)processIds.Length;
                    parentIdMatchesJobMemberCount = null;
                }
            }
        }
        catch
        {
            observationComplete = false;
        }
        finally
        {
            for (int index = 0; index < processHandlesToClose.Count; index++)
                CloseDiagnosticHandle(processHandlesToClose[index], ref diagnosticCleanupError);
            membershipVerifiedCount = (uint)membershipVerifiedIds.Count;
            notInJobCount = (uint)notInJobIds.Count;
            membershipUnknownCount = membershipVerificationCompleted
                ? (uint)membershipUnknownIds.Count
                : (uint)processIds.Length;
        }

        if (diagnosticCleanupError != 0) result.CleanupConfirmed = false;

        result.JobMemberOpenCount = openCount;
        result.JobMemberMembershipVerifiedCount = membershipVerifiedCount;
        result.JobMemberNotInJobCount = notInJobCount;
        result.JobMemberMembershipUnknownCount = membershipUnknownCount;
        result.JobMemberNodeImageCount = nodeImageCount;
        result.JobMemberConsoleHostImageCount = consoleHostImageCount;
        result.JobMemberCommandShellImageCount = commandShellImageCount;
        result.JobMemberOtherImageCount = otherImageCount;
        result.JobMemberImageUnknownCount = imageUnknownCount;
        result.JobMemberParentIdMatchesJobMemberCount = parentIdMatchesJobMemberCount;
        result.JobMemberMetadataUnknownCount = metadataUnknownCount;
        result.JobMemberCleanupErrorCode = diagnosticCleanupError;
        result.JobMemberJobSetStable = jobSetStable;
        result.JobMemberDiagnosticsStatus = membershipMismatch ? "MISMATCH" :
            observationComplete && metadataSnapshotComplete && jobSetStable == true &&
            membershipVerifiedCount == (uint)processIdSet.Count && membershipUnknownCount == 0 &&
            metadataUnknownCount == 0 && diagnosticCleanupError == 0
                ? "COMPLETE"
                : "UNKNOWN";
    }

    private static void CaptureAppContainerJobMemberDiagnostics(IntPtr job, AppContainerRunResult result)
    {
        uint assignedCount;
        uint returnedCount;
        uint[] processIds;
        bool complete;
        int queryErrorCode;
        bool querySucceeded = TryGetJobProcessIdList(job, out assignedCount, out returnedCount,
            out processIds, out complete, out queryErrorCode);
        result.JobMemberQueryErrorCode = queryErrorCode == 0 ? (int?)null : queryErrorCode;
        result.JobMemberAssignedCount = querySucceeded ? (uint?)assignedCount : null;
        result.JobMemberReturnedCount = querySucceeded ? (uint?)returnedCount : null;

        HostProcessTreeTestRunResult snapshot = new HostProcessTreeTestRunResult();
        snapshot.JobProcessIdListQuerySucceeded = querySucceeded && queryErrorCode == 0;
        snapshot.JobProcessIdListComplete = complete;
        snapshot.JobProcessIdAssignedCount = querySucceeded ? (uint?)assignedCount : null;
        snapshot.JobProcessIdReturnedCount = querySucceeded ? (uint?)returnedCount : null;
        snapshot.JobProcessIdListQueryErrorCode = queryErrorCode;
        snapshot.JobProcessIdsAtDeadline = querySucceeded ? processIds : new uint[0];

        if (snapshot.JobProcessIdListQuerySucceeded && snapshot.JobProcessIdListComplete &&
            snapshot.JobProcessIdAssignedCount == snapshot.JobProcessIdReturnedCount &&
            snapshot.JobProcessIdsAtDeadline != null && snapshot.JobProcessIdsAtDeadline.Length > 0 &&
            snapshot.JobProcessIdsAtDeadline.Length <= MAX_JOB_PROCESS_ID_LIST_CAPACITY)
        {
            CaptureHostJobMemberDiagnostics(job, snapshot);
        }

        result.JobMemberJobSetStable = snapshot.JobMemberJobSetStable;
        result.JobMemberOpenCount = snapshot.JobMemberOpenCount;
        result.JobMemberMembershipVerifiedCount = snapshot.JobMemberMembershipVerifiedCount;
        result.JobMemberNotInJobCount = snapshot.JobMemberNotInJobCount;
        result.JobMemberMembershipUnknownCount = snapshot.JobMemberMembershipUnknownCount;
        result.JobMemberNodeImageCount = snapshot.JobMemberNodeImageCount;
        result.JobMemberConsoleHostImageCount = snapshot.JobMemberConsoleHostImageCount;
        result.JobMemberCommandShellImageCount = snapshot.JobMemberCommandShellImageCount;
        result.JobMemberOtherImageCount = snapshot.JobMemberOtherImageCount;
        result.JobMemberImageUnknownCount = snapshot.JobMemberImageUnknownCount;
        result.JobMemberMetadataUnknownCount = snapshot.JobMemberMetadataUnknownCount;
        result.JobMemberCleanupErrorCode = snapshot.JobMemberCleanupErrorCode;

        JobMemberSnapshotEvidence evidence = new JobMemberSnapshotEvidence();
        evidence.QuerySucceeded = snapshot.JobProcessIdListQuerySucceeded;
        evidence.QueryComplete = snapshot.JobProcessIdListComplete;
        evidence.AssignedCount = snapshot.JobProcessIdAssignedCount.GetValueOrDefault();
        evidence.ReturnedCount = snapshot.JobProcessIdReturnedCount.GetValueOrDefault();
        evidence.JobSetStable = snapshot.JobMemberJobSetStable;
        evidence.MembershipMismatch = snapshot.JobMemberDiagnosticsStatus == "MISMATCH";
        evidence.OpenCount = snapshot.JobMemberOpenCount.GetValueOrDefault();
        evidence.MembershipVerifiedCount = snapshot.JobMemberMembershipVerifiedCount.GetValueOrDefault();
        evidence.NotInJobCount = snapshot.JobMemberNotInJobCount.GetValueOrDefault();
        evidence.MembershipUnknownCount = snapshot.JobMemberMembershipUnknownCount.GetValueOrDefault();
        evidence.MetadataSnapshotComplete = snapshot.JobMemberDiagnosticsStatus == "COMPLETE";
        evidence.MetadataUnknownCount = snapshot.JobMemberMetadataUnknownCount.GetValueOrDefault();
        evidence.QueryErrorCode = queryErrorCode;
        evidence.CleanupErrorCode = snapshot.JobMemberCleanupErrorCode.GetValueOrDefault();
        result.JobMemberDiagnosticsStatus = GetJobMemberSnapshotStatus(evidence);
    }

    private static bool IsProcessTreeStage(string stage)
    {
        switch (stage)
        {
            case "PREFLIGHT":
            case "ARGUMENT_CONSTRUCTION":
            case "PROCESS_CREATE":
            case "TOKEN_VERIFICATION":
            case "JOB_MEMBERSHIP":
            case "INPUT_WRITE":
            case "PROCESS_WAIT":
            case "TIMEOUT_QUERY":
            case "JOB_SNAPSHOT":
            case "JOB_TERMINATION":
            case "ROOT_SIGNAL":
            case "JOB_DRAIN":
            case "OUTPUT_CAPTURE":
            case "CLEANUP":
                return true;
            default:
                return false;
        }
    }

    private static void SetProcessTreeStage(AppContainerRunResult result, string stage)
    {
        result.ProcessTreeStage = IsProcessTreeStage(stage) ? stage : "UNKNOWN";
    }

    private static string GetProcessTreeExceptionType(Exception exception)
    {
        if (exception is System.ComponentModel.Win32Exception) return "Win32Exception";
        if (exception is ArgumentException) return "ArgumentException";
        if (exception is InvalidOperationException) return "InvalidOperationException";
        if (exception is TimeoutException) return "TimeoutException";
        if (exception is IOException) return "IOException";
        if (exception is UnauthorizedAccessException) return "UnauthorizedAccessException";
        if (exception is PlatformNotSupportedException) return "PlatformNotSupportedException";
        return "OtherException";
    }

    private static void RecordProcessTreeFailure(AppContainerRunResult result,
        string stage, Exception exception)
    {
        if (result.ProcessTreeFailureStage != "NONE") return;
        result.ProcessTreeFailureStage = IsProcessTreeStage(stage) ? stage : "UNKNOWN";
        result.ProcessTreeFailureExceptionType = GetProcessTreeExceptionType(exception);
        result.ProcessTreeFailureHResult = exception.HResult;
        System.ComponentModel.Win32Exception win32Exception = exception as System.ComponentModel.Win32Exception;
        result.ProcessTreeFailureWin32Code = win32Exception == null
            ? (int?)null
            : win32Exception.NativeErrorCode;
        result.ProcessTreeStatus = "UNKNOWN";
    }

    private static void RecordProcessTreeCleanupFailure(AppContainerRunResult result,
        string stage, Exception exception)
    {
        if (result.ProcessTreeCleanupFailureStage != null) return;
        result.ProcessTreeCleanupFailureStage = IsProcessTreeStage(stage) ? stage : "UNKNOWN";
        result.ProcessTreeCleanupFailureExceptionType = GetProcessTreeExceptionType(exception);
        result.ProcessTreeCleanupFailureHResult = exception.HResult;
        System.ComponentModel.Win32Exception win32Exception = exception as System.ComponentModel.Win32Exception;
        result.ProcessTreeCleanupFailureWin32Code = win32Exception == null
            ? (int?)null
            : win32Exception.NativeErrorCode;
        result.ProcessTreeStatus = "UNKNOWN";
    }

    private static void AttachProcessTreeFailureData(Exception exception,
        AppContainerRunResult result, Exception observedException = null)
    {
        if (exception == null || result == null || result.ProcessTreeFailureStage == "NONE") return;
        Exception diagnosticException = observedException ?? exception;
        exception.Data["agentcp_process_tree_stage"] = IsProcessTreeStage(result.ProcessTreeStage)
            ? result.ProcessTreeStage
            : "UNKNOWN";
        exception.Data["agentcp_process_tree_failure_stage"] = result.ProcessTreeFailureStage;
        exception.Data["agentcp_process_tree_exception_type"] = GetProcessTreeExceptionType(diagnosticException);
        exception.Data["agentcp_process_tree_hresult"] = diagnosticException.HResult;
        System.ComponentModel.Win32Exception win32Exception = diagnosticException as System.ComponentModel.Win32Exception;
        if (win32Exception != null)
            exception.Data["agentcp_process_tree_win32_code"] = win32Exception.NativeErrorCode;
        if (result.ProcessTreeCleanupFailureStage != null)
        {
            exception.Data["agentcp_process_tree_cleanup_stage"] = result.ProcessTreeCleanupFailureStage;
            exception.Data["agentcp_process_tree_cleanup_exception_type"] = result.ProcessTreeCleanupFailureExceptionType;
            exception.Data["agentcp_process_tree_cleanup_hresult"] = result.ProcessTreeCleanupFailureHResult.GetValueOrDefault();
            if (result.ProcessTreeCleanupFailureWin32Code.HasValue)
                exception.Data["agentcp_process_tree_cleanup_win32_code"] = result.ProcessTreeCleanupFailureWin32Code.Value;
        }
    }

    private static Exception WrapProcessTreeCleanupFailure(AppContainerRunResult result,
        Exception originalException, string stage, Exception cleanupException)
    {
        SetProcessTreeStage(result, stage);
        RecordProcessTreeCleanupFailure(result, stage, cleanupException);
        InvalidOperationException wrapper = new InvalidOperationException(
            "Fail-closed process-tree cleanup was not confirmed.", originalException);
        AttachProcessTreeFailureData(wrapper, result, cleanupException);
        return wrapper;
    }

    private static void RunTimeoutCleanup(AppContainerRunResult result,
        bool captureTimeoutJobMembers, Action captureSnapshot, Action terminateJob,
        Action confirmRootSignal, Action drainJob)
    {
        if (captureTimeoutJobMembers && captureSnapshot != null)
        {
            SetProcessTreeStage(result, "JOB_SNAPSHOT");
            try
            {
                captureSnapshot();
            }
            catch (Exception exception)
            {
                result.JobMemberDiagnosticsStatus = "UNKNOWN";
                RecordProcessTreeFailure(result, "JOB_SNAPSHOT", exception);
            }
        }
        else
        {
            result.JobMemberDiagnosticsStatus = "UNKNOWN";
        }

        SetProcessTreeStage(result, "JOB_TERMINATION");
        terminateJob();
        if (confirmRootSignal != null)
        {
            SetProcessTreeStage(result, "ROOT_SIGNAL");
            confirmRootSignal();
        }
        SetProcessTreeStage(result, "JOB_DRAIN");
        drainJob();
        result.ProcessTreeStatus = result.JobMemberDiagnosticsStatus == "COMPLETE" &&
            result.RootProcessSignaled && result.JobDrained ? "COMPLETE" : "UNKNOWN";
    }

    public static bool ProcessTreeTimeoutSnapshotSyntheticSelfTest()
    {
        AppContainerRunResult result = new AppContainerRunResult();
        result.JobMemberDiagnosticsStatus = "COMPLETE";
        List<string> calls = new List<string>();
        RunTimeoutCleanup(result, true,
            delegate()
            {
                calls.Add("snapshot");
                throw new ArgumentException("Synthetic private path C:\\private\\tree; PID 424242.");
            },
            delegate() { calls.Add("terminate"); },
            delegate()
            {
                calls.Add("root-signal");
                result.RootProcessSignaled = true;
            },
            delegate()
            {
                calls.Add("drain");
                result.JobDrained = true;
            });

        if (String.Join(",", calls.ToArray()) != "snapshot,terminate,root-signal,drain" ||
            result.ProcessTreeFailureStage != "JOB_SNAPSHOT" ||
            result.ProcessTreeFailureExceptionType != "ArgumentException" ||
            !result.ProcessTreeFailureHResult.HasValue ||
            result.ProcessTreeFailureWin32Code.HasValue ||
            result.JobMemberDiagnosticsStatus != "UNKNOWN" ||
            result.ProcessTreeStatus != "UNKNOWN" ||
            !result.RootProcessSignaled || !result.JobDrained)
            throw new InvalidOperationException("Synthetic process-tree snapshot cleanup self-test failed.");

        string safeReport = String.Join("|", result.ProcessTreeStage,
            result.ProcessTreeFailureStage, result.ProcessTreeFailureExceptionType,
            result.ProcessTreeFailureHResult.Value.ToString(), result.JobMemberDiagnosticsStatus,
            result.ProcessTreeStatus, result.RootProcessSignaled.ToString(), result.JobDrained.ToString());
        if (safeReport.IndexOf("Synthetic private", StringComparison.Ordinal) >= 0 ||
            safeReport.IndexOf("C:\\private", StringComparison.OrdinalIgnoreCase) >= 0 ||
            safeReport.IndexOf("424242", StringComparison.Ordinal) >= 0)
            throw new InvalidOperationException("Synthetic process-tree snapshot report exposed private diagnostics.");

        AppContainerRunResult cleanupResult = new AppContainerRunResult();
        Exception originalException = new ArgumentException("Synthetic private original path C:\\private\\root; PID 313131.");
        RecordProcessTreeFailure(cleanupResult, "PROCESS_CREATE", originalException);
        Exception cleanupException = new System.ComponentModel.Win32Exception(5,
            "Synthetic private cleanup message C:\\private\\root; PID 313131.");
        Exception wrappedCleanup = WrapProcessTreeCleanupFailure(cleanupResult,
            originalException, "JOB_DRAIN", cleanupException);
        if (!Object.ReferenceEquals(wrappedCleanup.InnerException, originalException) ||
            !wrappedCleanup.Data.Contains("agentcp_process_tree_stage") ||
            !Object.Equals(wrappedCleanup.Data["agentcp_process_tree_stage"], "JOB_DRAIN") ||
            !Object.Equals(wrappedCleanup.Data["agentcp_process_tree_exception_type"], "Win32Exception") ||
            !Object.Equals(wrappedCleanup.Data["agentcp_process_tree_win32_code"], 5) ||
            !Object.Equals(wrappedCleanup.Data["agentcp_process_tree_cleanup_stage"], "JOB_DRAIN"))
            throw new InvalidOperationException("Synthetic fail-closed cleanup diagnostics self-test failed.");
        string cleanupReport = String.Join("|", cleanupResult.ProcessTreeFailureStage,
            cleanupResult.ProcessTreeFailureExceptionType, cleanupResult.ProcessTreeCleanupFailureStage,
            cleanupResult.ProcessTreeCleanupFailureExceptionType,
            cleanupResult.ProcessTreeCleanupFailureHResult.GetValueOrDefault().ToString(),
            cleanupResult.ProcessTreeCleanupFailureWin32Code.GetValueOrDefault().ToString());
        if (cleanupReport.IndexOf("Synthetic private", StringComparison.Ordinal) >= 0 ||
            cleanupReport.IndexOf("C:\\private", StringComparison.OrdinalIgnoreCase) >= 0 ||
            cleanupReport.IndexOf("313131", StringComparison.Ordinal) >= 0)
            throw new InvalidOperationException("Synthetic fail-closed cleanup report exposed private diagnostics.");
        return true;
    }

    private static void CaptureHostJobDeadlineSnapshot(IntPtr job,
        HostProcessTreeTestRunResult result)
    {
        JOBOBJECT_BASIC_LIMIT_INFORMATION limitInformation;
        int limitErrorCode;
        result.ActiveProcessLimitQuerySucceeded = TryGetJobActiveProcessLimit(job, out limitInformation, out limitErrorCode);
        result.ActiveProcessLimitQueryErrorCode = limitErrorCode;
        if (result.ActiveProcessLimitQuerySucceeded)
        {
            result.EffectiveActiveProcessLimitEnabled =
                (limitInformation.LimitFlags & JOB_OBJECT_LIMIT_ACTIVE_PROCESS) != 0;
            result.EffectiveActiveProcessLimit = limitInformation.ActiveProcessLimit;
        }

        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        int accountingErrorCode;
        result.JobAccountingQuerySucceeded = TryGetJobAccountingSnapshot(job, out accounting, out accountingErrorCode);
        result.JobAccountingQueryErrorCode = accountingErrorCode;
        if (result.JobAccountingQuerySucceeded)
        {
            result.TotalProcessesAtDeadline = accounting.TotalProcesses;
            result.ActiveProcessesAtDeadline = accounting.ActiveProcesses;
            result.TotalTerminatedProcessesAtDeadline = accounting.TotalTerminatedProcesses;
        }

        uint assignedCount;
        uint returnedCount;
        uint[] processIds;
        bool complete;
        int processIdErrorCode;
        result.JobProcessIdListQuerySucceeded = TryGetJobProcessIdList(job, out assignedCount,
            out returnedCount, out processIds, out complete, out processIdErrorCode);
        result.JobProcessIdListQueryErrorCode = processIdErrorCode;
        if (result.JobProcessIdListQuerySucceeded)
        {
            result.JobProcessIdAssignedCount = assignedCount;
            result.JobProcessIdReturnedCount = returnedCount;
            result.JobProcessIdListComplete = complete;
            result.JobProcessIdsAtDeadline = processIds;
        }

        CaptureHostJobMemberDiagnostics(job, result);

        if (result.JobAccountingQuerySucceeded && result.JobProcessIdListQuerySucceeded && complete &&
            accounting.ActiveProcesses >= returnedCount)
        {
            uint excess = accounting.ActiveProcesses - returnedCount;
            result.AccountingExcessOverJobPidListCount = excess;
            result.AccountingExcessCoveredByTerminationCount = accounting.TotalTerminatedProcesses >= excess;
        }
    }

    public static string GetJobMemberSnapshotStatus(JobMemberSnapshotEvidence evidence)
    {
        if (evidence == null || !evidence.QuerySucceeded || !evidence.QueryComplete ||
            evidence.QueryErrorCode != 0 || evidence.AssignedCount == 0 ||
            evidence.AssignedCount > MAX_JOB_PROCESS_ID_LIST_CAPACITY ||
            evidence.ReturnedCount != evidence.AssignedCount || evidence.JobSetStable != true ||
            evidence.MembershipMismatch || evidence.OpenCount != evidence.ReturnedCount ||
            evidence.MembershipVerifiedCount != evidence.ReturnedCount ||
            evidence.NotInJobCount != 0 || evidence.MembershipUnknownCount != 0 ||
            !evidence.MetadataSnapshotComplete || evidence.MetadataUnknownCount != 0 ||
            evidence.CleanupErrorCode != 0)
            return "UNKNOWN";

        return "COMPLETE";
    }

    public static string GetDeadlineDecision(bool querySucceeded, uint activeProcesses)
    {
        if (!querySucceeded) return "query_failed_terminate";
        return activeProcesses == 0 ? "completed_at_deadline" : "active_processes_terminate";
    }

    public static string GetJobDrainDecision(bool querySucceeded, uint activeProcesses)
    {
        if (!querySucceeded) return "query_failed";
        return activeProcesses == 0 ? "drained" : "active";
    }

    public static string GetTraverseAccessDecision(bool querySucceeded, bool accessGranted)
    {
        return GetAccessCheckDecision(querySucceeded, accessGranted);
    }

    public static string GetAccessCheckDecision(bool querySucceeded, bool accessGranted)
    {
        if (!querySucceeded) return "UNKNOWN";
        return accessGranted ? "ALLOW" : "DENY";
    }

    public static uint GetDeadlineWaitMilliseconds(long elapsedMilliseconds, int timeoutMs)
    {
        long remainingMilliseconds = timeoutMs - elapsedMilliseconds;
        return remainingMilliseconds <= 0 ? 0U : (uint)Math.Min(25L, remainingMilliseconds);
    }

    private static void WriteInput(InputWriteState state)
    {
        try
        {
            state.NativeThreadId = unchecked((int)GetCurrentThreadId());
            uint bytesWritten;
            bool succeeded = WriteFile(state.Pipe, state.Buffer, (uint)state.Buffer.Length, out bytesWritten, IntPtr.Zero);
            state.Succeeded = succeeded;
            state.BytesWritten = bytesWritten;
            state.ErrorCode = succeeded ? 0 : Marshal.GetLastWin32Error();
        }
        catch (Exception error)
        {
            state.Failure = error;
        }
        finally
        {
            state.Completed.Set();
        }
    }

    private static void EnsureInputWriterStopped(InputWriteState state, System.Threading.Thread writer)
    {
        if (state == null || writer == null) return;
        if (!state.Completed.WaitOne(5000))
        {
            IntPtr threadHandle = OpenThread(THREAD_TERMINATE, false, unchecked((uint)state.NativeThreadId));
            if (threadHandle == IntPtr.Zero)
            {
                int openError = Marshal.GetLastWin32Error();
                if (!state.Completed.WaitOne(5000))
                    throw CreateApiWin32Exception("OpenThread(stdin writer)", "Could not open the bounded stdin writer after Job Object drain.", openError);
            }
            else
            {
                bool canceled = false;
                int cancelError = 0;
                try
                {
                    canceled = CancelSynchronousIo(threadHandle);
                    if (!canceled) cancelError = Marshal.GetLastWin32Error();
                }
                finally { CloseHandle(threadHandle); }

                if (!state.Completed.WaitOne(5000))
                {
                    if (!canceled)
                        throw CreateApiWin32Exception("CancelSynchronousIo(stdin writer)", "Could not cancel the bounded stdin write after Job Object drain.", cancelError);
                    throw new TimeoutException("The stdin writer did not stop after Job Object drain and I/O cancellation.");
                }
            }
        }
        if (!writer.Join(5000))
            throw new TimeoutException("The stdin writer signaled completion but did not exit.");
    }

    public static AppContainerRunResult RunNode(
        string nodePath,
        string workerPath,
        string workingDirectory,
        string profileSid,
        string profileName,
        string inputJson,
        int timeoutMs,
        string profileLocalAppDataPath = null)
    {
        if (String.IsNullOrWhiteSpace(workerPath))
            throw new ArgumentException("A worker path is required.", "workerPath");
        return RunNodeCore(nodePath, Quote(workerPath), workingDirectory, profileSid, profileName,
            inputJson, timeoutMs, profileLocalAppDataPath);
    }

    public static AppContainerRunResult RunNodeWithModuleHooks(
        string nodePath,
        string moduleHookPath,
        string workerMode,
        string workingDirectory,
        string profileSid,
        string profileName,
        string inputJson,
        int timeoutMs,
        string profileLocalAppDataPath = null,
        bool captureTimeoutJobMembers = false)
    {
        return RunNodeCore(nodePath, BuildModuleHookNodeArguments(moduleHookPath, workerMode),
            workingDirectory, profileSid, profileName, inputJson, timeoutMs, profileLocalAppDataPath,
            true, captureTimeoutJobMembers);
    }

    public static HostProcessTreeTestRunResult RunHostProcessTreeTest(
        string nodePath,
        string workingDirectory,
        string[] nodeArguments,
        int timeoutMs)
    {
        HostProcessTreeTestRunResult result = new HostProcessTreeTestRunResult();
        IntPtr job = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        IntPtr jobListBuffer = IntPtr.Zero;
        IntPtr handleListBuffer = IntPtr.Zero;
        IntPtr stdinRead = IntPtr.Zero;
        IntPtr stdinWrite = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        bool attributesInitialized = false;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        MemoryStream stdout = new MemoryStream();
        MemoryStream stderr = new MemoryStream();
        int capturedBytes = 0;
        bool outputTruncated = false;
        int cleanupError = 0;
        Action outputPump = delegate()
        {
            DrainPipe(stdoutRead, stdout, ref capturedBytes, ref outputTruncated, 8192U);
            DrainPipe(stderrRead, stderr, ref capturedBytes, ref outputTruncated, 8192U);
        };

        try
        {
            result.Stage = "PREFLIGHT";
            ValidateHostProcessTreeTestArguments(nodePath, workingDirectory, nodeArguments, timeoutMs);
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException();

            result.Stage = "JOB_CREATE";
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw LastError("CreateJobObject(host process-tree test)");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 4;
            IntPtr limitsBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            try
            {
                Marshal.StructureToPtr(limits, limitsBuffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsBuffer,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                    throw LastError("SetInformationJobObject(host process-tree test)");
            }
            finally { Marshal.FreeHGlobal(limitsBuffer); }

            SECURITY_ATTRIBUTES pipeAttributes = new SECURITY_ATTRIBUTES();
            pipeAttributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            pipeAttributes.bInheritHandle = true;
            if (!CreatePipe(out stdinRead, out stdinWrite, ref pipeAttributes, 0) ||
                !CreatePipe(out stdoutRead, out stdoutWrite, ref pipeAttributes, 0) ||
                !CreatePipe(out stderrRead, out stderrWrite, ref pipeAttributes, 0))
                throw LastError("CreatePipe(host process-tree test)");
            if (!SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0))
                throw LastError("SetHandleInformation(host process-tree test)");

            result.Stage = "JOB_LIST_PREPARE";
            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
            if (attributeSize == IntPtr.Zero) throw LastError("InitializeProcThreadAttributeList(size)");
            attributes = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeSize))
                throw LastError("InitializeProcThreadAttributeList(host process-tree test)");
            attributesInitialized = true;

            jobListBuffer = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobListBuffer, job);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobListBuffer,
                new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw LastError("UpdateProcThreadAttribute(JobList host process-tree test)");

            handleListBuffer = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleListBuffer, 0, stdinRead);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size, stdoutWrite);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size * 2, stderrWrite);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleListBuffer,
                new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero))
                throw LastError("UpdateProcThreadAttribute(HandleList host process-tree test)");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdinRead;
            startup.StartupInfo.hStdOutput = stdoutWrite;
            startup.StartupInfo.hStdError = stderrWrite;
            startup.lpAttributeList = attributes;

            StringBuilder commandLine = new StringBuilder(Quote(nodePath));
            for (int index = 0; index < nodeArguments.Length; index++)
                commandLine.Append(" ").Append(Quote(nodeArguments[index]));

            result.Stage = "PROCESS_CREATE";
            uint creationFlags = EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
            if (!CreateProcess(nodePath, commandLine, IntPtr.Zero, IntPtr.Zero, true, creationFlags,
                IntPtr.Zero, workingDirectory, ref startup, out process))
                throw LastError("CreateProcess(host process-tree test)");
            result.ProcessCreated = true;
            uint rootProcessIdFromHandle = GetProcessId(process.hProcess);
            result.RootPidValid = process.dwProcessId > 0 && rootProcessIdFromHandle > 0 &&
                process.dwProcessId == rootProcessIdFromHandle;
            result.RootProcessIdForComparison = rootProcessIdFromHandle;
            CloseDiagnosticHandle(stdinRead, ref cleanupError); stdinRead = IntPtr.Zero;
            CloseDiagnosticHandle(stdoutWrite, ref cleanupError); stdoutWrite = IntPtr.Zero;
            CloseDiagnosticHandle(stderrWrite, ref cleanupError); stderrWrite = IntPtr.Zero;
            CloseDiagnosticHandle(stdinWrite, ref cleanupError); stdinWrite = IntPtr.Zero;
            if (cleanupError != 0) throw CreateApiWin32Exception("CloseHandle(inherited pipe)",
                "A parent pipe handle could not be closed after process creation.", cleanupError);

            bool assigned;
            if (!IsProcessInJob(process.hProcess, job, out assigned) || !assigned)
                throw LastError("IsProcessInJob(host process-tree test)");
            result.JobMembershipVerified = true;
            result.Stage = "PROCESS_WAIT";
            Stopwatch timer = Stopwatch.StartNew();
            bool finished = false;
            while (!finished)
            {
                outputPump();
                uint waitMilliseconds = GetDeadlineWaitMilliseconds(timer.ElapsedMilliseconds, timeoutMs);
                uint wait = WaitForSingleObject(process.hProcess, waitMilliseconds);
                if (wait == WAIT_FAILED) throw LastError("WaitForSingleObject(host process-tree test)");
                if (wait == WAIT_OBJECT_0)
                {
                    result.RootProcessSignaled = true;
                    uint exitCode;
                    if (!GetExitCodeProcess(process.hProcess, out exitCode))
                        throw LastError("GetExitCodeProcess(host process-tree test)");
                    result.RootExitCode = unchecked((int)exitCode);
                    int remaining = (int)Math.Max(0L, (long)timeoutMs - timer.ElapsedMilliseconds);
                    uint active;
                    int queryError;
                    int pollWait;
                    if (TryWaitForJobDrain(job, remaining, out active, out queryError, out pollWait, outputPump))
                    {
                        result.JobDrained = true;
                        result.ActiveProcessesAfterDrain = 0;
                        finished = true;
                        continue;
                    }
                    if (queryError != 0) result.ErrorCode = queryError;
                    result.TimedOut = true;
                }
                else if (timer.ElapsedMilliseconds >= timeoutMs)
                {
                    result.TimedOut = true;
                }

                if (result.TimedOut)
                {
                    result.Stage = "JOB_DEADLINE_SNAPSHOT";
                    outputPump();
                    CaptureHostJobDeadlineSnapshot(job, result);
                    result.Stage = "JOB_TERMINATE";
                    result.TerminateJobSucceeded = TerminateJobObject(job, 124);
                    if (!result.TerminateJobSucceeded)
                        result.ErrorCode = Marshal.GetLastWin32Error();
                    uint activeAfter = UInt32.MaxValue;
                    int queryAfterError = 0;
                    int pollAfterWait = 0;
                    if (result.TerminateJobSucceeded && TryWaitForJobDrain(job, 5000,
                        out activeAfter, out queryAfterError, out pollAfterWait, outputPump))
                    {
                        result.JobDrained = true;
                        result.ActiveProcessesAfterDrain = 0;
                    }
                    else
                    {
                        if (queryAfterError != 0) result.ErrorCode = queryAfterError;
                        result.CleanupConfirmed = false;
                    }
                    uint rootWait = WaitForSingleObject(process.hProcess, 5000);
                    if (rootWait == WAIT_OBJECT_0)
                    {
                        result.RootProcessSignaled = true;
                        uint exitCode;
                        if (GetExitCodeProcess(process.hProcess, out exitCode))
                            result.RootExitCode = unchecked((int)exitCode);
                        else result.ErrorCode = Marshal.GetLastWin32Error();
                    }
                    else
                    {
                        result.CleanupConfirmed = false;
                        if (rootWait == WAIT_FAILED) result.ErrorCode = Marshal.GetLastWin32Error();
                    }
                    outputPump();
                    finished = true;
                }
            }

            result.OutputTruncated = outputTruncated;
            result.Stdout = Encoding.UTF8.GetString(stdout.ToArray());
            if (result.TimedOut && (!result.TerminateJobSucceeded || !result.RootProcessSignaled || !result.JobDrained))
                result.CleanupConfirmed = false;
        }
        catch (Exception error)
        {
            if (result.ErrorCode == null) result.ErrorCode = GetDiagnosticErrorCode(error);
            result.CleanupConfirmed = false;
            if (job != IntPtr.Zero && process.hProcess != IntPtr.Zero && !result.JobDrained)
            {
                try
                {
                    result.TerminateJobSucceeded = TerminateJobObject(job, 124);
                    uint active;
                    int queryError;
                    int pollWait;
                    if (result.TerminateJobSucceeded && TryWaitForJobDrain(job, 5000,
                        out active, out queryError, out pollWait, outputPump))
                    {
                        result.JobDrained = true;
                        result.ActiveProcessesAfterDrain = 0;
                        result.RootProcessSignaled = WaitForSingleObject(process.hProcess, 5000) == WAIT_OBJECT_0;
                        result.CleanupConfirmed = result.RootProcessSignaled;
                    }
                }
                catch { result.CleanupConfirmed = false; }
            }
            result.OutputTruncated = outputTruncated;
            try { result.Stdout = Encoding.UTF8.GetString(stdout.ToArray()); } catch { result.Stdout = String.Empty; }
        }
        finally
        {
            int finalCleanupError = 0;
            if (job != IntPtr.Zero && process.hProcess != IntPtr.Zero && !result.JobDrained)
            {
                try { TerminateJobObject(job, 124); }
                catch { result.CleanupConfirmed = false; }
            }
            if (attributesInitialized)
            {
                try { DeleteProcThreadAttributeList(attributes); }
                catch (Exception error) { RecordFirstError(ref finalCleanupError, GetDiagnosticErrorCode(error)); }
            }
            FreeDiagnosticBuffer(attributes, ref finalCleanupError);
            FreeDiagnosticBuffer(jobListBuffer, ref finalCleanupError);
            FreeDiagnosticBuffer(handleListBuffer, ref finalCleanupError);
            CloseDiagnosticHandle(stdinRead, ref finalCleanupError);
            CloseDiagnosticHandle(stdinWrite, ref finalCleanupError);
            CloseDiagnosticHandle(stdoutRead, ref finalCleanupError);
            CloseDiagnosticHandle(stdoutWrite, ref finalCleanupError);
            CloseDiagnosticHandle(stderrRead, ref finalCleanupError);
            CloseDiagnosticHandle(stderrWrite, ref finalCleanupError);
            CloseDiagnosticHandle(process.hThread, ref finalCleanupError);
            CloseDiagnosticHandle(process.hProcess, ref finalCleanupError);
            CloseDiagnosticHandle(job, ref finalCleanupError);
            if (finalCleanupError != 0) result.CleanupConfirmed = false;
            stdout.Dispose();
            stderr.Dispose();
        }
        return result;
    }

    public static LoopbackConfigChildRunResult RunLoopbackConfigChild(string scriptPath, string profileSid)
    {
        LoopbackConfigChildRunResult result = new LoopbackConfigChildRunResult();
        IntPtr job = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        IntPtr jobListBuffer = IntPtr.Zero;
        IntPtr handleListBuffer = IntPtr.Zero;
        IntPtr stdinRead = IntPtr.Zero;
        IntPtr stdinWrite = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        bool attributesInitialized = false;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        MemoryStream stdout = new MemoryStream();
        MemoryStream stderr = new MemoryStream();
        int capturedStdoutBytes = 0;
        int discardedStderrBytes = 0;
        bool stdoutTruncated = false;
        bool stderrTruncated = false;
        int cleanupError = 0;
        Stopwatch totalTimer = Stopwatch.StartNew();
        Action outputPump = delegate()
        {
            DrainPipe(stdoutRead, stdout, ref capturedStdoutBytes, ref stdoutTruncated,
                MAX_PIPE_DRAIN_PER_TICK, MAX_LOOPBACK_CONFIG_OUTPUT_BYTES);
            DrainPipe(stderrRead, stderr, ref discardedStderrBytes, ref stderrTruncated,
                MAX_PIPE_DRAIN_PER_TICK, 0);
        };

        try
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException();
            if (!IsCanonicalAppContainerSidText(profileSid))
                throw new ArgumentException("A canonical AppContainer SID is required.", "profileSid");
            if (String.IsNullOrWhiteSpace(scriptPath) || !Path.IsPathRooted(scriptPath) ||
                !String.Equals(Path.GetFileName(scriptPath), "run-probes.ps1", StringComparison.OrdinalIgnoreCase) ||
                !File.Exists(scriptPath))
                throw new ArgumentException("The fixed loopback helper script path is invalid.", "scriptPath");

            string powershellPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell\\v1.0\\powershell.exe");
            if (!Path.IsPathRooted(powershellPath) || !File.Exists(powershellPath))
                throw new FileNotFoundException("The fixed Windows PowerShell executable is unavailable.");
            string canonicalScript = Path.GetFullPath(scriptPath);
            string workingDirectory = Path.GetDirectoryName(canonicalScript);

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw LastError("CreateJobObject(loopback config child)");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 4;
            IntPtr limitsBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            try
            {
                Marshal.StructureToPtr(limits, limitsBuffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsBuffer,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                    throw LastError("SetInformationJobObject(loopback config child)");
            }
            finally { Marshal.FreeHGlobal(limitsBuffer); }

            SECURITY_ATTRIBUTES pipeAttributes = new SECURITY_ATTRIBUTES();
            pipeAttributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            pipeAttributes.bInheritHandle = true;
            if (!CreatePipe(out stdinRead, out stdinWrite, ref pipeAttributes, 0) ||
                !CreatePipe(out stdoutRead, out stdoutWrite, ref pipeAttributes, 0) ||
                !CreatePipe(out stderrRead, out stderrWrite, ref pipeAttributes, 0))
                throw LastError("CreatePipe(loopback config child)");
            if (!SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0))
                throw LastError("SetHandleInformation(loopback config child)");

            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
            if (attributeSize == IntPtr.Zero) throw LastError("InitializeProcThreadAttributeList(loopback size)");
            attributes = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeSize))
                throw LastError("InitializeProcThreadAttributeList(loopback)");
            attributesInitialized = true;

            jobListBuffer = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobListBuffer, job);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobListBuffer,
                new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw LastError("UpdateProcThreadAttribute(loopback JobList)");
            handleListBuffer = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleListBuffer, 0, stdinRead);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size, stdoutWrite);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size * 2, stderrWrite);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleListBuffer,
                new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero))
                throw LastError("UpdateProcThreadAttribute(loopback HandleList)");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdinRead;
            startup.StartupInfo.hStdOutput = stdoutWrite;
            startup.StartupInfo.hStdError = stderrWrite;
            startup.lpAttributeList = attributes;
            StringBuilder commandLine = new StringBuilder(Quote(powershellPath));
            commandLine.Append(" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ");
            commandLine.Append(Quote(canonicalScript)).Append(" -LoopbackConfigChildOnly");
            if (!CreateProcess(powershellPath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                IntPtr.Zero, workingDirectory, ref startup, out process))
                throw LastError("CreateProcess(loopback config child)");
            result.ProcessCreated = true;
            Stopwatch timer = Stopwatch.StartNew();

            CloseDiagnosticHandle(stdinRead, ref cleanupError); stdinRead = IntPtr.Zero;
            CloseDiagnosticHandle(stdoutWrite, ref cleanupError); stdoutWrite = IntPtr.Zero;
            CloseDiagnosticHandle(stderrWrite, ref cleanupError); stderrWrite = IntPtr.Zero;
            if (cleanupError != 0) throw CreateApiWin32Exception("CloseHandle(loopback child pipe)",
                "A child pipe handle could not be closed after process creation.", cleanupError);
            bool assigned;
            if (!IsProcessInJob(process.hProcess, job, out assigned) || !assigned)
                throw LastError("IsProcessInJob(loopback config child)");

            byte[] input = Encoding.UTF8.GetBytes("{\"sid\":\"" + profileSid + "\"}\n");
            if (input.Length > MAX_LOOPBACK_CONFIG_INPUT_BYTES)
                throw new ArgumentOutOfRangeException("profileSid", "Loopback helper input exceeds its byte limit.");
            uint bytesWritten;
            if (!WriteFile(stdinWrite, input, (uint)input.Length, out bytesWritten, IntPtr.Zero) ||
                bytesWritten != input.Length)
                throw LastError("WriteFile(loopback config child stdin)");
            CloseDiagnosticHandle(stdinWrite, ref cleanupError); stdinWrite = IntPtr.Zero;
            if (cleanupError != 0) throw CreateApiWin32Exception("CloseHandle(loopback child stdin)",
                "The loopback helper input pipe could not be closed.", cleanupError);

            bool finished = false;
            bool requireTermination = false;
            while (!finished)
            {
                outputPump();
                if (stdoutTruncated)
                {
                    result.OutputTruncated = true;
                    result.ErrorCode = ERROR_INVALID_DATA;
                    requireTermination = true;
                    break;
                }
                uint wait = WaitForSingleObject(process.hProcess,
                    GetDeadlineWaitMilliseconds(timer.ElapsedMilliseconds, LOOPBACK_CONFIG_CHILD_TIMEOUT_MS));
                if (wait == WAIT_FAILED) throw LastError("WaitForSingleObject(loopback config child)");
                if (wait == WAIT_OBJECT_0)
                {
                    result.RootProcessSignaled = true;
                    uint exitCode;
                    if (!GetExitCodeProcess(process.hProcess, out exitCode))
                        throw LastError("GetExitCodeProcess(loopback config child)");
                    result.ExitCode = unchecked((int)exitCode);
                    int remaining = (int)Math.Max(0L, (long)LOOPBACK_CONFIG_CHILD_TIMEOUT_MS - timer.ElapsedMilliseconds);
                    uint active;
                    int queryError;
                    int pollWait;
                    if (TryWaitForJobDrain(job, remaining, out active, out queryError, out pollWait, outputPump))
                    {
                        result.JobDrained = true;
                        finished = true;
                        continue;
                    }
                    if (queryError != 0) result.ErrorCode = queryError;
                }
                if (timer.ElapsedMilliseconds >= LOOPBACK_CONFIG_CHILD_TIMEOUT_MS)
                {
                    result.TimedOut = true;
                    requireTermination = true;
                    break;
                }
            }

            if (requireTermination)
            {
                result.TerminateJobSucceeded = TerminateJobObject(job, 124);
                if (!result.TerminateJobSucceeded) result.ErrorCode = Marshal.GetLastWin32Error();
                if (result.TerminateJobSucceeded)
                {
                    uint rootWait = WaitForSingleObject(process.hProcess, 5000);
                    if (rootWait == WAIT_OBJECT_0)
                    {
                        result.RootProcessSignaled = true;
                        uint exitCode;
                        if (GetExitCodeProcess(process.hProcess, out exitCode)) result.ExitCode = unchecked((int)exitCode);
                        else result.ErrorCode = Marshal.GetLastWin32Error();
                    }
                    else if (rootWait == WAIT_FAILED) result.ErrorCode = Marshal.GetLastWin32Error();
                    uint activeAfter;
                    int queryAfterError;
                    int pollAfterWait;
                    if (TryWaitForJobDrain(job, 5000, out activeAfter, out queryAfterError,
                        out pollAfterWait, outputPump))
                        result.JobDrained = true;
                    else if (queryAfterError != 0) result.ErrorCode = queryAfterError;
                }
            }

            outputPump();
            result.OutputTruncated = stdoutTruncated;
            if (result.RootProcessSignaled && result.JobDrained && !result.OutputTruncated)
            {
                try { result.Stdout = new UTF8Encoding(false, true).GetString(stdout.ToArray()); }
                catch (DecoderFallbackException) { result.ErrorCode = ERROR_INVALID_DATA; }
            }
            if (result.ProcessCreated && (!result.RootProcessSignaled || !result.JobDrained))
                result.CleanupConfirmed = false;
        }
        catch (Exception error)
        {
            if (result.ErrorCode == null) result.ErrorCode = GetDiagnosticErrorCode(error);
            if (job != IntPtr.Zero && process.hProcess != IntPtr.Zero &&
                (!result.RootProcessSignaled || !result.JobDrained))
            {
                result.TerminateJobSucceeded = TerminateJobObject(job, 124);
                if (result.TerminateJobSucceeded)
                {
                    uint rootWait = WaitForSingleObject(process.hProcess, 5000);
                    result.RootProcessSignaled = rootWait == WAIT_OBJECT_0;
                    uint active;
                    int queryError;
                    int pollWait;
                    result.JobDrained = TryWaitForJobDrain(job, 5000, out active, out queryError, out pollWait, outputPump);
                    if (queryError != 0) result.ErrorCode = queryError;
                }
            }
        }
        finally
        {
            int finalCleanupError = 0;
            if (job != IntPtr.Zero && process.hProcess != IntPtr.Zero &&
                (!result.RootProcessSignaled || !result.JobDrained))
            {
                try { TerminateJobObject(job, 124); }
                catch { result.CleanupConfirmed = false; }
            }
            if (attributesInitialized)
            {
                try { DeleteProcThreadAttributeList(attributes); }
                catch (Exception error) { RecordFirstError(ref finalCleanupError, GetDiagnosticErrorCode(error)); }
            }
            FreeDiagnosticBuffer(attributes, ref finalCleanupError);
            FreeDiagnosticBuffer(jobListBuffer, ref finalCleanupError);
            FreeDiagnosticBuffer(handleListBuffer, ref finalCleanupError);
            CloseDiagnosticHandle(stdinRead, ref finalCleanupError);
            CloseDiagnosticHandle(stdinWrite, ref finalCleanupError);
            CloseDiagnosticHandle(stdoutRead, ref finalCleanupError);
            CloseDiagnosticHandle(stdoutWrite, ref finalCleanupError);
            CloseDiagnosticHandle(stderrRead, ref finalCleanupError);
            CloseDiagnosticHandle(stderrWrite, ref finalCleanupError);
            CloseDiagnosticHandle(process.hThread, ref finalCleanupError);
            CloseDiagnosticHandle(process.hProcess, ref finalCleanupError);
            CloseDiagnosticHandle(job, ref finalCleanupError);
            if (finalCleanupError != 0) result.ErrorCode = finalCleanupError;
            result.DurationMs = totalTimer.ElapsedMilliseconds;
            result.CleanupConfirmed = finalCleanupError == 0 &&
                (!result.ProcessCreated || (result.RootProcessSignaled && result.JobDrained));
            stdout.Dispose();
            stderr.Dispose();
        }
        return result;
    }

    private static void ValidateHostProcessTreeTestArguments(
        string nodePath,
        string workingDirectory,
        string[] nodeArguments,
        int timeoutMs)
    {
        if (String.IsNullOrWhiteSpace(nodePath) || !Path.IsPathRooted(nodePath) ||
            !String.Equals(Path.GetFileName(nodePath), "node.exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(nodePath))
            throw new ArgumentException("A local node.exe path is required.");
        if (String.IsNullOrWhiteSpace(workingDirectory) || !Path.IsPathRooted(workingDirectory) ||
            !Directory.Exists(workingDirectory))
            throw new ArgumentException("A working directory is required.");
        if (timeoutMs < 1000 || timeoutMs > 10000)
            throw new ArgumentOutOfRangeException("timeoutMs");
        if (nodeArguments == null || nodeArguments.Length != 5 || nodeArguments[0] != "-e" ||
            (nodeArguments[2] != "child" && nodeArguments[2] != "child-test") ||
            nodeArguments[4] != (nodeArguments[2] == "child-test" ? "grandchild-test" : "grandchild") ||
            ComputeUtf8Sha256(nodeArguments[1]) != PROCESS_TREE_CHILD_SCRIPT_SHA256 ||
            ComputeUtf8Sha256(nodeArguments[3]) != PROCESS_TREE_GRANDCHILD_SCRIPT_SHA256)
            throw new ArgumentException("Only the fixed process-tree test scripts and roles are supported.");
    }

    private static string ComputeUtf8Sha256(string value)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(value ?? String.Empty));
            return BitConverter.ToString(hash).Replace("-", String.Empty).ToLowerInvariant();
        }
    }

    public static string BuildModuleHookNodeArguments(string moduleHookPath, string workerMode)
    {
        if (String.IsNullOrWhiteSpace(moduleHookPath))
            throw new ArgumentException("A module hook path is required.", "moduleHookPath");
        if (!Path.IsPathRooted(moduleHookPath))
            throw new ArgumentException("The module hook path must be absolute.", "moduleHookPath");
        if (!String.Equals(Path.GetExtension(moduleHookPath), ".mjs", StringComparison.Ordinal))
            throw new ArgumentException("The module hook must be an .mjs file.", "moduleHookPath");
        if (workerMode != "probe" && workerMode != "production")
            throw new ArgumentOutOfRangeException("workerMode", "Only the fixed probe and production worker modes are supported.");

        string canonicalHookPath = Path.GetFullPath(moduleHookPath);
        return "--input-type=module -e " + Quote(MODULE_HOOK_BOOTSTRAP) + " " +
            Quote(canonicalHookPath) + " " + Quote(workerMode);
    }

    public static AppContainerRunResult RunNodeInlineStdioSmoke(
        string nodePath,
        string workingDirectory,
        string profileSid,
        string profileName,
        int timeoutMs,
        string profileLocalAppDataPath = null)
    {
        return RunNodeCore(nodePath, "-e " + Quote(INLINE_STDIO_SMOKE_SCRIPT), workingDirectory,
            profileSid, profileName, INLINE_STDIO_SMOKE_INPUT_JSON, timeoutMs, profileLocalAppDataPath);
    }

    public static AppContainerRunResult RunStagedFileReadDiagnostic(
        string nodePath,
        string workerModulePath,
        string probeContractPath,
        string workingDirectory,
        string profileSid,
        string profileName,
        int timeoutMs,
        string profileLocalAppDataPath = null)
    {
        string inputJson = CreateStagedFileReadDiagnosticInput(
            workerModulePath, probeContractPath, workingDirectory);
        return RunNodeCore(nodePath, "-e " + Quote(STAGED_FILE_READ_DIAGNOSTIC_SCRIPT),
            workingDirectory, profileSid, profileName, inputJson, timeoutMs, profileLocalAppDataPath);
    }

    public static AppContainerRunResult RunProfileContractImportDiagnostic(
        string nodePath,
        string stagedProfileContractPath,
        string workingDirectory,
        string profileSid,
        string profileName,
        string nonce,
        string expectedSha256,
        int timeoutMs,
        string profileLocalAppDataPath)
    {
        string inputJson = CreateProfileContractImportDiagnosticInput(
            stagedProfileContractPath, workingDirectory, profileSid, profileName, nonce, expectedSha256, profileLocalAppDataPath);
        return RunNodeCore(nodePath, "-e " + Quote(PROFILE_CONTRACT_IMPORT_DIAGNOSTIC_SCRIPT),
            workingDirectory, profileSid, profileName, inputJson, timeoutMs, profileLocalAppDataPath);
    }

    public static AppContainerRunResult RunProfileBootstrapDiagnostic(
        string nodePath,
        string toolsDirectory,
        string profileSid,
        string profileName,
        string nonce,
        string profileCandidatePath,
        int timeoutMs)
    {
        string inputJson = CreateProfileBootstrapDiagnosticInput(
            nodePath, toolsDirectory, profileSid, profileName, nonce, profileCandidatePath);
        string canonicalToolsDirectory = ValidateProfileBootstrapToolsDirectory(toolsDirectory, nodePath, nonce);
        return RunNodeCore(nodePath, "-e " + Quote(PROFILE_BOOTSTRAP_DIAGNOSTIC_SCRIPT),
            canonicalToolsDirectory, profileSid, profileName, inputJson, timeoutMs, profileCandidatePath, false);
    }

    private static string CreateProfileBootstrapDiagnosticInput(
        string nodePath,
        string toolsDirectory,
        string profileSid,
        string profileName,
        string nonce,
        string profileCandidatePath)
    {
        if (String.IsNullOrWhiteSpace(toolsDirectory) || String.IsNullOrWhiteSpace(profileSid))
            throw new ArgumentException("The profile bootstrap diagnostic requires staged tools and an AppContainer SID.");
        ValidateProfileCandidatePath(profileCandidatePath, profileName, nonce);
        ValidateProfileBootstrapToolsDirectory(toolsDirectory, nodePath, nonce);
        string inputJson = "{\"nonce\":\"" + nonce + "\"}";
        if (Encoding.UTF8.GetByteCount(inputJson) > MAX_PROFILE_BOOTSTRAP_DIAGNOSTIC_INPUT_BYTES)
            throw new ArgumentOutOfRangeException("nonce", "Profile bootstrap diagnostic JSON exceeds its byte limit.");
        return inputJson;
    }

    private static string ValidateProfileBootstrapToolsDirectory(string toolsDirectory, string nodePath, string nonce)
    {
        if (String.IsNullOrWhiteSpace(nonce) || nonce.Length != 32)
            throw new ArgumentException("The profile bootstrap nonce has an invalid shape.", "nonce");
        for (int index = 0; index < nonce.Length; index++)
        {
            char character = nonce[index];
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
                throw new ArgumentException("The profile bootstrap nonce has an invalid shape.", "nonce");
        }
        string canonicalToolsDirectory = GetCanonicalLocalDrivePath(toolsDirectory, "toolsDirectory");
        DirectoryInfo tools = new DirectoryInfo(canonicalToolsDirectory);
        if (!String.Equals(tools.Name, "tools", StringComparison.OrdinalIgnoreCase) || tools.Parent == null ||
            !String.Equals(tools.Parent.Name, nonce, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The profile bootstrap accepts only the nonce-owned staging tools directory.", "toolsDirectory");
        string expectedNodePath = Path.Combine(canonicalToolsDirectory, "node.exe");
        string canonicalNodePath = GetCanonicalLocalDrivePath(nodePath, "nodePath");
        if (!String.Equals(canonicalNodePath, expectedNodePath, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The profile bootstrap accepts only staged node.exe.", "nodePath");
        EnsureNoReparsePointsInPath(canonicalToolsDirectory);
        EnsureNoReparsePointsInPath(canonicalNodePath);
        return canonicalToolsDirectory;
    }

    private static string CreateProfileContractImportDiagnosticInput(
        string stagedProfileContractPath,
        string workingDirectory,
        string profileSid,
        string profileName,
        string nonce,
        string expectedSha256,
        string profileLocalAppDataPath)
    {
        if (String.IsNullOrWhiteSpace(stagedProfileContractPath) || String.IsNullOrWhiteSpace(workingDirectory) ||
            String.IsNullOrWhiteSpace(profileSid) || String.IsNullOrWhiteSpace(profileName) ||
            String.IsNullOrWhiteSpace(profileLocalAppDataPath))
            throw new ArgumentException("Profile contract diagnostic paths and identity are required.");
        ValidateProfileNameForNonce(profileName, nonce);
        if (String.IsNullOrWhiteSpace(expectedSha256) || expectedSha256.Length != 64)
            throw new ArgumentException("The expected contract SHA-256 has an invalid shape.", "expectedSha256");
        for (int index = 0; index < expectedSha256.Length; index++)
        {
            char character = expectedSha256[index];
            bool hex = (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') ||
                (character >= 'A' && character <= 'F');
            if (!hex) throw new ArgumentException("The expected contract SHA-256 has an invalid shape.", "expectedSha256");
        }

        string canonicalWorkspace = Path.GetFullPath(workingDirectory);
        DirectoryInfo workspaceDirectory = new DirectoryInfo(canonicalWorkspace);
        if (!String.Equals(workspaceDirectory.Name, "workspace", StringComparison.OrdinalIgnoreCase) ||
            workspaceDirectory.Parent == null)
            throw new ArgumentException("The profile contract diagnostic requires the dedicated workspace layout.", "workingDirectory");

        string canonicalProfilePath = GetProfileLocalAppDataPath(profileSid, profileName);
        string canonicalProvidedProfilePath = GetCanonicalLocalDrivePath(profileLocalAppDataPath, "profileLocalAppDataPath");
        if (!String.Equals(canonicalProfilePath, canonicalProvidedProfilePath, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The supplied AppContainer LocalAppData path does not match the profile API result.", "profileLocalAppDataPath");

        string expectedContractPath = Path.GetFullPath(Path.Combine(canonicalProfilePath, "Temp",
            "profile-contract-" + nonce, "probe-contract.mjs"));
        string canonicalModulePath = GetCanonicalLocalDrivePath(stagedProfileContractPath, "stagedProfileContractPath");
        if (!String.Equals(canonicalModulePath, expectedContractPath, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The profile diagnostic accepts only its nonce-scoped contract module path.", "stagedProfileContractPath");

        string inputJson = "{\"nonce\":\"" + nonce + "\",\"expectedSha256\":\"" + expectedSha256.ToLowerInvariant() + "\"}";
        if (Encoding.UTF8.GetByteCount(inputJson) > MAX_PROFILE_CONTRACT_DIAGNOSTIC_INPUT_BYTES)
            throw new ArgumentOutOfRangeException("expectedSha256", "Profile contract diagnostic JSON exceeds its byte limit.");
        return inputJson;
    }

    private static string CreateStagedFileReadDiagnosticInput(
        string workerModulePath,
        string probeContractPath,
        string workingDirectory)
    {
        if (String.IsNullOrWhiteSpace(workerModulePath) || String.IsNullOrWhiteSpace(probeContractPath) ||
            String.IsNullOrWhiteSpace(workingDirectory))
            throw new ArgumentException("Staged diagnostic paths and workspace are required.");

        string canonicalWorkspace = Path.GetFullPath(workingDirectory);
        DirectoryInfo workspaceDirectory = new DirectoryInfo(canonicalWorkspace);
        DirectoryInfo stageDirectory = workspaceDirectory.Parent;
        if (!String.Equals(workspaceDirectory.Name, "workspace", StringComparison.OrdinalIgnoreCase) ||
            stageDirectory == null)
            throw new ArgumentException("The staged diagnostic requires the dedicated workspace layout.", "workingDirectory");

        string toolsRoot = Path.GetFullPath(Path.Combine(stageDirectory.FullName, "tools"));
        string expectedWorker = Path.GetFullPath(Path.Combine(toolsRoot, "worker.mjs"));
        string expectedContract = Path.GetFullPath(Path.Combine(toolsRoot, "probe-contract.mjs"));
        if (!String.Equals(Path.GetFullPath(workerModulePath), expectedWorker, StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(Path.GetFullPath(probeContractPath), expectedContract, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The staged diagnostic accepts only its two fixed staged module paths.");

        string inputJson = "{\"workerModule\":\"" + EscapeJsonString(expectedWorker) +
            "\",\"probeContract\":\"" + EscapeJsonString(expectedContract) + "\"}";
        if (Encoding.UTF8.GetByteCount(inputJson) > MAX_STAGED_READ_DIAGNOSTIC_INPUT_BYTES)
            throw new ArgumentOutOfRangeException("workingDirectory", "Staged diagnostic JSON exceeds its byte limit.");
        return inputJson;
    }

    private static string EscapeJsonString(string value)
    {
        StringBuilder escaped = new StringBuilder(value.Length + 16);
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (character == '\\') escaped.Append("\\\\");
            else if (character == '"') escaped.Append("\\\"");
            else if (character < 0x20) escaped.Append("\\u").Append(((int)character).ToString("x4"));
            else escaped.Append(character);
        }
        return escaped.ToString();
    }

    private static AppContainerRunResult RunNodeCore(
        string nodePath,
        string nodeArguments,
        string workingDirectory,
        string profileSid,
        string profileName,
        string inputJson,
        int timeoutMs,
        string profileLocalAppDataPath,
        bool createProfileDirectories = true,
        bool captureTimeoutJobMembers = false)
    {
        if (String.IsNullOrWhiteSpace(nodePath) || String.IsNullOrWhiteSpace(nodeArguments)
            || String.IsNullOrWhiteSpace(workingDirectory) || String.IsNullOrWhiteSpace(profileSid)
            || String.IsNullOrWhiteSpace(profileName))
            throw new ArgumentException("Node, arguments, workspace, AppContainer SID and profile name are required.");
        if (timeoutMs < 100 || timeoutMs > MAX_TASK_TIMEOUT_MS) throw new ArgumentOutOfRangeException("timeoutMs");
        byte[] jsonBytes = Encoding.UTF8.GetBytes(inputJson ?? "{}");
        if (jsonBytes.Length > MAX_INPUT_JSON_BYTES)
            throw new ArgumentOutOfRangeException("inputJson", "Worker JSON is limited to 65,536 UTF-8 bytes.");
        byte[] input = new byte[jsonBytes.Length + 1];
        Buffer.BlockCopy(jsonBytes, 0, input, 0, jsonBytes.Length);
        input[input.Length - 1] = (byte)'\n';

        AppContainerRunResult result = new AppContainerRunResult();
        MemoryStream stdout = new MemoryStream();
        MemoryStream stderr = new MemoryStream();
        int capturedBytes = 0;
        bool truncated = false;
        IntPtr job = IntPtr.Zero;
        IntPtr stdinRead = IntPtr.Zero;
        IntPtr stdinWrite = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        IntPtr appSid = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        bool attributesInitialized = false;
        IntPtr capabilitiesBuffer = IntPtr.Zero;
        IntPtr jobListBuffer = IntPtr.Zero;
        IntPtr handleListBuffer = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool created = false;
        bool rootProcessSignaled = false;
        InputWriteState inputWriteState = null;
        System.Threading.Thread inputWriter = null;
        Stopwatch timer = Stopwatch.StartNew();
        Action outputPump = delegate()
        {
            DrainPipe(stdoutRead, stdout, ref capturedBytes, ref truncated);
            DrainPipe(stderrRead, stderr, ref capturedBytes, ref truncated);
        };

        try
        {
            if (!ConvertStringSidToSid(profileSid, out appSid)) throw LastError("ConvertStringSidToSid");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw LastError("CreateJobObject");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.BasicLimitInformation.ActiveProcessLimit = 8;
            limits.JobMemoryLimit = MAX_JOB_MEMORY_BYTES;
            IntPtr limitsBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            try
            {
                Marshal.StructureToPtr(limits, limitsBuffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsBuffer,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                    throw LastError("SetInformationJobObject");
            }
            finally { Marshal.FreeHGlobal(limitsBuffer); }

            SECURITY_ATTRIBUTES pipeAttributes = new SECURITY_ATTRIBUTES();
            pipeAttributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            pipeAttributes.bInheritHandle = true;
            if (!CreatePipe(out stdinRead, out stdinWrite, ref pipeAttributes, 0)) throw LastError("CreatePipe(stdin)");
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref pipeAttributes, 0)) throw LastError("CreatePipe(stdout)");
            if (!CreatePipe(out stderrRead, out stderrWrite, ref pipeAttributes, 0)) throw LastError("CreatePipe(stderr)");
            if (!SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0)
                || !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)
                || !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0))
                throw LastError("SetHandleInformation");

            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 3, 0, ref attributeSize);
            attributes = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributes, 3, 0, ref attributeSize))
                throw LastError("InitializeProcThreadAttributeList");
            attributesInitialized = true;

            SECURITY_CAPABILITIES security = new SECURITY_CAPABILITIES();
            security.AppContainerSid = appSid;
            security.Capabilities = IntPtr.Zero;
            security.CapabilityCount = 0;
            security.Reserved = 0;
            capabilitiesBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(security, capabilitiesBuffer, false);

            jobListBuffer = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobListBuffer, job);
            handleListBuffer = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleListBuffer, 0, stdinRead);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size, stdoutWrite);
            Marshal.WriteIntPtr(handleListBuffer, IntPtr.Size * 2, stderrWrite);

            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilitiesBuffer,
                    new UIntPtr((uint)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero))
                throw LastError("UpdateProcThreadAttribute(AppContainer)");
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobListBuffer,
                    new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw LastError("UpdateProcThreadAttribute(JobList)");
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleListBuffer,
                    new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero))
                throw LastError("UpdateProcThreadAttribute(HandleList)");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdinRead;
            startup.StartupInfo.hStdOutput = stdoutWrite;
            startup.StartupInfo.hStdError = stderrWrite;
            startup.lpAttributeList = attributes;

            SetProcessTreeStage(result, "ARGUMENT_CONSTRUCTION");
            string commandLine = Quote(nodePath) + " " + nodeArguments;
            StringBuilder mutableCommandLine = new StringBuilder(commandLine);
            environment = BuildEnvironment(nodePath, workingDirectory, profileName, profileLocalAppDataPath,
                createProfileDirectories);
            uint creationFlags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
            SetProcessTreeStage(result, "PROCESS_CREATE");
            if (!CreateProcess(nodePath, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, true, creationFlags,
                    environment, workingDirectory, ref startup, out process))
                throw LastError("CreateProcess(AppContainer worker)");
            created = true;
            CloseHandle(stdinRead); stdinRead = IntPtr.Zero;
            CloseHandle(stdoutWrite); stdoutWrite = IntPtr.Zero;
            CloseHandle(stderrWrite); stderrWrite = IntPtr.Zero;

            SetProcessTreeStage(result, "TOKEN_VERIFICATION");
            if (!CaptureWorkerAppContainerToken(process.hProcess, appSid, result))
                throw new InvalidOperationException("Worker token is not the requested AppContainer.");
            bool assigned;
            SetProcessTreeStage(result, "JOB_MEMBERSHIP");
            if (!IsProcessInJob(process.hProcess, job, out assigned) || !assigned)
                throw new InvalidOperationException("Worker was not created inside the required Job Object.");
            result.JobMembershipVerified = true;

            SetProcessTreeStage(result, "INPUT_WRITE");
            inputWriteState = new InputWriteState(stdinWrite, input);
            inputWriter = new System.Threading.Thread(delegate() { WriteInput(inputWriteState); });
            inputWriter.IsBackground = true;
            inputWriter.Name = "AppContainer stdin writer";
            inputWriter.Start();

            while (true)
            {
                SetProcessTreeStage(result, "OUTPUT_CAPTURE");
                outputPump();
                if (inputWriteState.Completed.WaitOne(0) && stdinWrite != IntPtr.Zero)
                {
                    EnsureInputWriterStopped(inputWriteState, inputWriter);
                    CloseHandle(stdinWrite); stdinWrite = IntPtr.Zero;
                    if (!inputWriteState.Succeeded || inputWriteState.BytesWritten != input.Length)
                    {
                        if (inputWriteState.Failure != null)
                            throw new InvalidOperationException("The bounded stdin writer failed.", inputWriteState.Failure);
                        throw CreateApiWin32Exception("WriteFile(stdin)", "The worker did not accept the complete JSON request.", inputWriteState.ErrorCode);
                    }
                }
                long elapsedMilliseconds = timer.ElapsedMilliseconds;
                uint waitMilliseconds = GetDeadlineWaitMilliseconds(elapsedMilliseconds, timeoutMs);
                SetProcessTreeStage(result, "PROCESS_WAIT");
                uint wait = rootProcessSignaled
                    ? WAIT_TIMEOUT
                    : WaitForSingleObject(process.hProcess, waitMilliseconds);
                if (wait == WAIT_FAILED) throw LastError("WaitForSingleObject(root process)");

                if (wait == WAIT_OBJECT_0)
                {
                    rootProcessSignaled = true;
                    result.RootProcessSignaled = true;
                    uint rootExitCode;
                    if (!GetExitCodeProcess(process.hProcess, out rootExitCode)) throw LastError("GetExitCodeProcess(root process)");
                    result.ExitCode = unchecked((int)rootExitCode);
                    CloseRootProcessHandlesOrThrow(ref process);
                }

                if (rootProcessSignaled)
                {
                    int remainingMilliseconds = (int)Math.Max(0L, (long)timeoutMs - timer.ElapsedMilliseconds);
                    uint activeProcesses;
                    int queryErrorCode;
                    int pollWaitCode;
                    SetProcessTreeStage(result, "JOB_DRAIN");
                    bool drained = TryWaitForJobDrain(job, remainingMilliseconds,
                        out activeProcesses, out queryErrorCode, out pollWaitCode, outputPump);
                    if (drained)
                    {
                        result.JobDrained = true;
                        result.ActiveProcessesAfterDrain = 0;
                        result.ActiveProcessQueryErrorCode = 0;
                        result.DrainPollWaitCode = 0;
                        result.DrainDiagnostic = "Job ActiveProcesses reached zero after the root signaled and its handles were closed.";
                        if (timer.ElapsedMilliseconds >= timeoutMs)
                        {
                            result.DeadlineDecision = GetDeadlineDecision(true, 0);
                            result.DeadlineActiveProcesses = 0;
                        }
                        EnsureInputWriterStopped(inputWriteState, inputWriter);
                        if (stdinWrite != IntPtr.Zero) { CloseHandle(stdinWrite); stdinWrite = IntPtr.Zero; }
                        if (!inputWriteState.Succeeded || inputWriteState.BytesWritten != input.Length)
                        {
                            if (inputWriteState.Failure != null)
                                throw new InvalidOperationException("The bounded stdin writer failed.", inputWriteState.Failure);
                            throw CreateApiWin32Exception("WriteFile(stdin)", "The worker did not accept the complete JSON request.", inputWriteState.ErrorCode);
                        }
                        break;
                    }

                    result.ActiveProcessesAfterDrain = queryErrorCode == 0 ? (uint?)activeProcesses : null;
                    result.ActiveProcessQueryErrorCode = queryErrorCode;
                    result.DrainPollWaitCode = pollWaitCode;
                    result.DrainDiagnostic = queryErrorCode != 0
                        ? "Job ActiveProcesses query failed during normal drain; cleanup is unconfirmed until termination and a second drain check."
                        : "Job ActiveProcesses remained nonzero at the task deadline; cleanup is unconfirmed until termination and a second drain check.";
                    result.DeadlineDecision = GetDeadlineDecision(queryErrorCode == 0, activeProcesses);
                    result.DeadlineActiveProcesses = queryErrorCode == 0 ? (uint?)activeProcesses : null;
                    result.DeadlineQueryErrorCode = queryErrorCode == 0 ? (int?)null : queryErrorCode;
                    result.TimedOut = true;
                    result.DeadlineDiagnostic = queryErrorCode != 0
                        ? "QueryInformationJobObject failed while confirming normal tree drain; job termination was requested conservatively."
                        : "Active Job processes remained at the task deadline; the Job was terminated.";
                    RunTimeoutCleanup(result, captureTimeoutJobMembers,
                        delegate() { CaptureAppContainerJobMemberDiagnostics(job, result); },
                        delegate()
                        {
                            if (!TerminateJobObject(job, 124)) throw LastError("TerminateJobObject(timeout)");
                        },
                        null,
                        delegate()
                        {
                            uint postKillActiveProcesses;
                            int postKillQueryError;
                            int postKillWaitCode;
                            if (!TryWaitForJobDrain(job, 5000, out postKillActiveProcesses,
                                out postKillQueryError, out postKillWaitCode, outputPump))
                            {
                                result.JobDrained = false;
                                result.ActiveProcessesAfterDrain = postKillQueryError == 0 ? (uint?)postKillActiveProcesses : null;
                                result.ActiveProcessQueryErrorCode = postKillQueryError;
                                result.DrainPollWaitCode = postKillWaitCode;
                                result.DrainDiagnostic = postKillQueryError != 0
                                    ? "Job ActiveProcesses query failed after termination; cleanup is unconfirmed."
                                    : "Job ActiveProcesses did not reach zero within five seconds after termination; cleanup is unconfirmed.";
                                throw CreateJobDrainFailure(postKillActiveProcesses, postKillQueryError, postKillWaitCode);
                            }
                            result.JobDrained = true;
                            result.ActiveProcessesAfterDrain = 0;
                            result.ActiveProcessQueryErrorCode = 0;
                            result.DrainPollWaitCode = 0;
                            result.DrainDiagnostic = "Job ActiveProcesses reached zero after termination and root handles were released.";
                        });
                    EnsureInputWriterStopped(inputWriteState, inputWriter);
                    if (stdinWrite != IntPtr.Zero) { CloseHandle(stdinWrite); stdinWrite = IntPtr.Zero; }
                    break;
                }

                if (wait == WAIT_TIMEOUT && timer.ElapsedMilliseconds >= timeoutMs)
                {
                    uint activeProcesses;
                    int queryErrorCode;
                    SetProcessTreeStage(result, "TIMEOUT_QUERY");
                    bool querySucceeded = TryGetJobActiveProcessCount(job, out activeProcesses, out queryErrorCode);
                    result.DeadlineDecision = GetDeadlineDecision(querySucceeded, activeProcesses);
                    result.DeadlineActiveProcesses = querySucceeded ? (uint?)activeProcesses : null;
                    result.DeadlineQueryErrorCode = querySucceeded ? (int?)null : queryErrorCode;
                    result.ActiveProcessesAfterDrain = querySucceeded ? (uint?)activeProcesses : null;
                    result.ActiveProcessQueryErrorCode = queryErrorCode;
                    if (querySucceeded && activeProcesses == 0)
                    {
                        int rootWaitCode;
                        SetProcessTreeStage(result, "ROOT_SIGNAL");
                        if (!TryWaitForProcessSignal(process.hProcess, 5000, out rootWaitCode))
                            throw CreateApiWin32Exception("WaitForSingleObject(root process)",
                                "Job accounting was empty at the deadline but the root process handle did not signal.", rootWaitCode);
                        rootProcessSignaled = true;
                        result.RootProcessSignaled = true;
                        uint rootExitCode;
                        if (!GetExitCodeProcess(process.hProcess, out rootExitCode)) throw LastError("GetExitCodeProcess(root process)");
                        result.ExitCode = unchecked((int)rootExitCode);
                        CloseRootProcessHandlesOrThrow(ref process);

                        uint postCloseActiveProcesses;
                        int postCloseQueryError;
                        int postCloseWaitCode;
                        if (!TryWaitForJobDrain(job, 5000, out postCloseActiveProcesses,
                            out postCloseQueryError, out postCloseWaitCode, outputPump))
                        {
                            result.JobDrained = false;
                            result.ActiveProcessesAfterDrain = postCloseQueryError == 0 ? (uint?)postCloseActiveProcesses : null;
                            result.ActiveProcessQueryErrorCode = postCloseQueryError;
                            result.DrainPollWaitCode = postCloseWaitCode;
                            result.DrainDiagnostic = postCloseQueryError != 0
                                ? "Job ActiveProcesses query failed after root handles were released; cleanup is unconfirmed."
                                : "Job ActiveProcesses did not reach zero after root handles were released; cleanup is unconfirmed.";
                            throw CreateJobDrainFailure(postCloseActiveProcesses, postCloseQueryError, postCloseWaitCode);
                        }
                        result.JobDrained = true;
                        result.ActiveProcessesAfterDrain = 0;
                        result.ActiveProcessQueryErrorCode = 0;
                        result.DrainPollWaitCode = 0;
                        result.DrainDiagnostic = "Job ActiveProcesses reached zero after the root signaled and its handles were closed.";
                        EnsureInputWriterStopped(inputWriteState, inputWriter);
                        if (stdinWrite != IntPtr.Zero) { CloseHandle(stdinWrite); stdinWrite = IntPtr.Zero; }
                        break;
                    }

                    result.TimedOut = true;
                    result.DeadlineDiagnostic = querySucceeded
                        ? "Active Job processes remained at the task deadline; the Job was terminated."
                        : "QueryInformationJobObject failed at the task deadline; the Job was terminated conservatively.";
                    Action terminateTimedOutJob = delegate()
                    {
                        if (!TerminateJobObject(job, 124)) throw LastError("TerminateJobObject(timeout)");
                    };
                    RunTimeoutCleanup(result, captureTimeoutJobMembers,
                        delegate() { CaptureAppContainerJobMemberDiagnostics(job, result); },
                        terminateTimedOutJob,
                        delegate()
                        {
                            int terminatedRootWaitCode;
                            if (!TryWaitForProcessSignal(process.hProcess, 5000, out terminatedRootWaitCode))
                                throw CreateApiWin32Exception("WaitForSingleObject(root process)",
                                    "Root process did not signal after Job termination.", terminatedRootWaitCode);
                            rootProcessSignaled = true;
                            result.RootProcessSignaled = true;
                            uint terminatedExitCode;
                            if (!GetExitCodeProcess(process.hProcess, out terminatedExitCode)) throw LastError("GetExitCodeProcess(root process)");
                            result.ExitCode = unchecked((int)terminatedExitCode);
                            CloseRootProcessHandlesOrThrow(ref process);
                        },
                        delegate()
                        {
                            uint terminatedActiveProcesses;
                            int terminatedQueryError;
                            int terminatedWaitCode;
                            if (!TryWaitForJobDrain(job, 5000, out terminatedActiveProcesses,
                                out terminatedQueryError, out terminatedWaitCode, outputPump))
                            {
                                result.JobDrained = false;
                                result.ActiveProcessesAfterDrain = terminatedQueryError == 0 ? (uint?)terminatedActiveProcesses : null;
                                result.ActiveProcessQueryErrorCode = terminatedQueryError;
                                result.DrainPollWaitCode = terminatedWaitCode;
                                result.DrainDiagnostic = terminatedQueryError != 0
                                    ? "Job ActiveProcesses query failed after termination; cleanup is unconfirmed."
                                    : "Job ActiveProcesses did not reach zero within five seconds after termination; cleanup is unconfirmed.";
                                throw CreateJobDrainFailure(terminatedActiveProcesses, terminatedQueryError, terminatedWaitCode);
                            }
                            result.JobDrained = true;
                            result.ActiveProcessesAfterDrain = 0;
                            result.ActiveProcessQueryErrorCode = 0;
                            result.DrainPollWaitCode = 0;
                            result.DrainDiagnostic = "Job ActiveProcesses reached zero after termination and root handles were released.";
                        });
                    EnsureInputWriterStopped(inputWriteState, inputWriter);
                    if (stdinWrite != IntPtr.Zero) { CloseHandle(stdinWrite); stdinWrite = IntPtr.Zero; }
                    break;
                }
            }

            SetProcessTreeStage(result, "OUTPUT_CAPTURE");
            DrainPipe(stdoutRead, stdout, ref capturedBytes, ref truncated, UInt32.MaxValue);
            DrainPipe(stderrRead, stderr, ref capturedBytes, ref truncated, UInt32.MaxValue);
            result.OutputTruncated = truncated;
            result.Stdout = new UTF8Encoding(false, true).GetString(stdout.ToArray());
            result.Stderr = Encoding.UTF8.GetString(stderr.ToArray());
            result.DurationMs = timer.ElapsedMilliseconds;
            return result;
        }
        catch (Exception failureException)
        {
            RecordProcessTreeFailure(result, result.ProcessTreeStage, failureException);
            AttachProcessTreeFailureData(failureException, result);
            Exception cleanupFailureException = null;
            if (job != IntPtr.Zero && created)
            {
                int terminateErrorCode;
                SetProcessTreeStage(result, "JOB_TERMINATION");
                if (!TryTerminateJob(job, 125, out terminateErrorCode))
                {
                    cleanupFailureException = CreateApiWin32Exception("TerminateJobObject(fail-closed cleanup)",
                        "Job termination was not confirmed during fail-closed cleanup.", terminateErrorCode);
                    RecordProcessTreeCleanupFailure(result, "JOB_TERMINATION", cleanupFailureException);
                }
                if (process.hProcess != IntPtr.Zero)
                {
                    int rootWaitCode;
                    SetProcessTreeStage(result, "ROOT_SIGNAL");
                    if (!TryWaitForProcessSignal(process.hProcess, 5000, out rootWaitCode))
                    {
                        Exception rootSignalFailure = CreateApiWin32Exception("WaitForSingleObject(root process)",
                            "Root process did not signal during fail-closed cleanup.", rootWaitCode);
                        throw WrapProcessTreeCleanupFailure(result, failureException, "ROOT_SIGNAL", rootSignalFailure);
                    }
                    rootProcessSignaled = true;
                    result.RootProcessSignaled = true;
                    uint rootExitCode;
                    if (GetExitCodeProcess(process.hProcess, out rootExitCode))
                        result.ExitCode = unchecked((int)rootExitCode);
                    CloseRootProcessHandlesOrThrow(ref process);
                }
                if (!rootProcessSignaled)
                    throw WrapProcessTreeCleanupFailure(result, failureException, "ROOT_SIGNAL",
                        new InvalidOperationException("Root process termination was not confirmed during fail-closed cleanup."));
                uint activeProcesses;
                int queryErrorCode;
                int pollWaitCode;
                SetProcessTreeStage(result, "JOB_DRAIN");
                if (!TryWaitForJobDrain(job, 5000, out activeProcesses, out queryErrorCode, out pollWaitCode, outputPump))
                {
                    result.ActiveProcessesAfterDrain = queryErrorCode == 0 ? (uint?)activeProcesses : null;
                    result.ActiveProcessQueryErrorCode = queryErrorCode;
                    result.DrainPollWaitCode = pollWaitCode;
                    result.DrainDiagnostic = queryErrorCode != 0
                        ? "Job ActiveProcesses query failed during fail-closed cleanup; cleanup is unconfirmed."
                        : "Job ActiveProcesses did not reach zero during fail-closed cleanup; cleanup is unconfirmed.";
                    Exception drainFailure = CreateJobDrainFailure(activeProcesses, queryErrorCode, pollWaitCode);
                    throw WrapProcessTreeCleanupFailure(result, failureException, "JOB_DRAIN", drainFailure);
                }
                result.JobDrained = true;
                result.ActiveProcessesAfterDrain = 0;
                result.ActiveProcessQueryErrorCode = 0;
                result.DrainPollWaitCode = 0;
                result.DrainDiagnostic = "Job ActiveProcesses reached zero during fail-closed cleanup.";
                EnsureInputWriterStopped(inputWriteState, inputWriter);
            }
            if (null != cleanupFailureException)
                AttachProcessTreeFailureData(failureException, result, cleanupFailureException);
            throw;
        }
        finally
        {
            SetProcessTreeStage(result, "CLEANUP");
            if (inputWriteState != null && (inputWriter == null || !inputWriter.IsAlive))
                inputWriteState.Completed.Dispose();
            stdout.Dispose();
            stderr.Dispose();
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(attributes);
            }
            if (capabilitiesBuffer != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesBuffer);
            if (jobListBuffer != IntPtr.Zero) Marshal.FreeHGlobal(jobListBuffer);
            if (handleListBuffer != IntPtr.Zero) Marshal.FreeHGlobal(handleListBuffer);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (stdinRead != IntPtr.Zero) CloseHandle(stdinRead);
            if (stdinWrite != IntPtr.Zero) CloseHandle(stdinWrite);
            if (stdoutRead != IntPtr.Zero) CloseHandle(stdoutRead);
            if (stdoutWrite != IntPtr.Zero) CloseHandle(stdoutWrite);
            if (stderrRead != IntPtr.Zero) CloseHandle(stderrRead);
            if (stderrWrite != IntPtr.Zero) CloseHandle(stderrWrite);
            if (appSid != IntPtr.Zero) LocalFree(appSid);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static bool CaptureWorkerAppContainerToken(
        IntPtr process,
        IntPtr expectedSid,
        AppContainerRunResult result)
    {
        IntPtr token = IntPtr.Zero;
        IntPtr appContainerBuffer = IntPtr.Zero;
        IntPtr sidBuffer = IntPtr.Zero;
        bool tokenIsAppContainer = false;
        bool sidMatches = false;
        bool querySucceeded = false;
        bool layoutSucceeded = false;
        bool cleanupSucceeded = true;
        int errorCode = 0;
        uint capabilityCount = 0;
        TokenCapabilitiesEvidence capabilities = new TokenCapabilitiesEvidence();
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out token))
            {
                errorCode = Marshal.GetLastWin32Error();
            }
            else
            {
                appContainerBuffer = Marshal.AllocHGlobal(sizeof(int));
                uint returned;
                if (!GetTokenInformation(token, TokenIsAppContainer, appContainerBuffer, sizeof(int), out returned))
                    errorCode = Marshal.GetLastWin32Error();
                else if (returned != sizeof(int))
                    errorCode = ERROR_INVALID_DATA;
                else
                {
                    tokenIsAppContainer = Marshal.ReadInt32(appContainerBuffer) == 1;
                    if (!tokenIsAppContainer) errorCode = ERROR_INVALID_DATA;
                    else
                    {
                        uint requiredSidBytes;
                        bool sidSizeSucceeded = GetTokenInformation(token, TokenAppContainerSid,
                            IntPtr.Zero, 0, out requiredSidBytes);
                        int sidSizeError = Marshal.GetLastWin32Error();
                        int sidInfoSize = Marshal.SizeOf(typeof(TOKEN_APPCONTAINER_INFORMATION));
                        if (sidSizeSucceeded || sidSizeError != ERROR_INSUFFICIENT_BUFFER ||
                            requiredSidBytes < (uint)sidInfoSize || requiredSidBytes > MAX_WORKER_TOKEN_BUFFER_BYTES)
                            errorCode = sidSizeSucceeded ? ERROR_INVALID_DATA : sidSizeError;
                        else
                        {
                            sidBuffer = Marshal.AllocHGlobal((int)requiredSidBytes);
                            uint returnedSidBytes;
                            if (!GetTokenInformation(token, TokenAppContainerSid, sidBuffer,
                                requiredSidBytes, out returnedSidBytes))
                                errorCode = Marshal.GetLastWin32Error();
                            else if (returnedSidBytes < (uint)sidInfoSize || returnedSidBytes > requiredSidBytes)
                                errorCode = ERROR_INVALID_DATA;
                            else
                            {
                                TOKEN_APPCONTAINER_INFORMATION sidInfo = (TOKEN_APPCONTAINER_INFORMATION)Marshal.PtrToStructure(
                                    sidBuffer, typeof(TOKEN_APPCONTAINER_INFORMATION));
                                if (!IsSidInsideBuffer(sidBuffer, returnedSidBytes, sidInfo.TokenAppContainer))
                                    errorCode = ERROR_INVALID_DATA;
                                else
                                {
                                    sidMatches = EqualSid(sidInfo.TokenAppContainer, expectedSid);
                                    if (!sidMatches) errorCode = ERROR_INVALID_DATA;
                                    else
                                    {
                                        result.WorkerTokenVerified = true;
                                        capabilities = ReadTokenCapabilities(token);
                                        querySucceeded = capabilities.Status == "PASS";
                                        layoutSucceeded = querySucceeded;
                                        capabilityCount = capabilities.Count.GetValueOrDefault();
                                        errorCode = capabilities.ErrorCode.GetValueOrDefault();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        catch (Exception error)
        {
            errorCode = GetDiagnosticErrorCode(error);
        }
        finally
        {
            if (sidBuffer != IntPtr.Zero)
            {
                try { Marshal.FreeHGlobal(sidBuffer); }
                catch (Exception error) { cleanupSucceeded = false; errorCode = GetDiagnosticErrorCode(error); }
            }
            if (appContainerBuffer != IntPtr.Zero)
            {
                try { Marshal.FreeHGlobal(appContainerBuffer); }
                catch (Exception error) { cleanupSucceeded = false; errorCode = GetDiagnosticErrorCode(error); }
            }
            if (token != IntPtr.Zero && !CloseHandle(token))
            {
                cleanupSucceeded = false;
                errorCode = Marshal.GetLastWin32Error();
            }
        }

        if (!cleanupSucceeded)
        {
            result.WorkerTokenVerified = false;
            capabilities = CompleteTokenCapabilitiesEvidence(tokenIsAppContainer, sidMatches,
                querySucceeded, layoutSucceeded, false, capabilityCount, errorCode);
        }
        else if (!result.WorkerTokenVerified)
        {
            capabilities = CompleteTokenCapabilitiesEvidence(tokenIsAppContainer, sidMatches,
                querySucceeded, layoutSucceeded, true, capabilityCount, errorCode);
        }
        result.AppContainerCapabilitiesStatus = capabilities.Status;
        result.AppContainerCapabilityCount = capabilities.Count;
        result.AppContainerNetworkCapabilityCount = capabilities.NetworkCapabilityCount;
        result.AppContainerCapabilitiesErrorCode = capabilities.ErrorCode;
        return result.WorkerTokenVerified;
    }

    private static TokenCapabilitiesEvidence ReadTokenCapabilities(IntPtr token)
    {
        IntPtr buffer = IntPtr.Zero;
        List<IntPtr> networkCapabilitySids = null;
        int errorCode = 0;
        bool querySucceeded = false;
        bool layoutSucceeded = false;
        bool cleanupSucceeded = true;
        uint count = 0;
        uint networkCapabilityCount = 0;
        try
        {
            if (TryDeriveNetworkCapabilitySids(out networkCapabilitySids, out errorCode))
            {
                uint requiredBytes;
                bool sizeSucceeded = GetTokenInformation(token, TokenCapabilities, IntPtr.Zero, 0, out requiredBytes);
                int sizeError = Marshal.GetLastWin32Error();
                if ((!sizeSucceeded && sizeError != ERROR_INSUFFICIENT_BUFFER) ||
                    requiredBytes < sizeof(uint) || requiredBytes > MAX_WORKER_TOKEN_BUFFER_BYTES)
                {
                    errorCode = sizeSucceeded ? ERROR_INVALID_DATA : sizeError;
                }
                else
                {
                    buffer = Marshal.AllocHGlobal((int)requiredBytes);
                    uint returnedBytes;
                    if (!GetTokenInformation(token, TokenCapabilities, buffer, requiredBytes, out returnedBytes))
                        errorCode = Marshal.GetLastWin32Error();
                    else
                    {
                        querySucceeded = true;
                        TokenCapabilitiesEvidence parsed = ParseTokenCapabilitiesBuffer(buffer, returnedBytes, requiredBytes);
                        count = parsed.Count.GetValueOrDefault();
                        if (parsed.Status != "PASS")
                            errorCode = parsed.ErrorCode.GetValueOrDefault();
                        else
                        {
                            int networkMatchErrorCode;
                            layoutSucceeded = TryCountNetworkCapabilityMatches(buffer, returnedBytes, requiredBytes,
                                networkCapabilitySids, out networkCapabilityCount, out networkMatchErrorCode);
                            errorCode = layoutSucceeded ? ERROR_SUCCESS : networkMatchErrorCode;
                        }
                    }
                }
            }
        }
        catch (Exception error)
        {
            errorCode = GetDiagnosticErrorCode(error);
        }
        finally
        {
            if (buffer != IntPtr.Zero)
            {
                try { Marshal.FreeHGlobal(buffer); }
                catch (Exception error) { cleanupSucceeded = false; errorCode = GetDiagnosticErrorCode(error); }
            }
            if (networkCapabilitySids != null)
            {
                int networkSidCleanupError;
                if (!FreeNetworkCapabilitySids(networkCapabilitySids, out networkSidCleanupError))
                {
                    cleanupSucceeded = false;
                    errorCode = networkSidCleanupError;
                }
            }
        }
        TokenCapabilitiesEvidence evidence = CompleteTokenCapabilitiesEvidence(true, true, querySucceeded,
            layoutSucceeded, cleanupSucceeded, count, errorCode);
        if (evidence.Status == "PASS") evidence.NetworkCapabilityCount = networkCapabilityCount;
        return evidence;
    }

    private static bool TryDeriveSingleCapabilitySid(string capabilityName, out IntPtr capabilitySid, out int errorCode)
    {
        IntPtr groupSidArray = IntPtr.Zero;
        IntPtr capabilitySidArray = IntPtr.Zero;
        uint groupSidCount = 0;
        uint capabilitySidCount = 0;
        capabilitySid = IntPtr.Zero;
        errorCode = ERROR_INVALID_DATA;
        bool apiSucceeded = false;
        bool layoutValid = false;
        bool cleanupSucceeded = true;
        bool preserveCapabilitySid = false;
        bool groupArrayValid = false;
        bool capabilityArrayValid = false;
        bool groupArrayComplete = false;
        bool capabilityArrayComplete = false;
        List<IntPtr> ownedSidPointers = new List<IntPtr>();

        try
        {
            apiSucceeded = DeriveCapabilitySidsFromName(capabilityName, out groupSidArray,
                out groupSidCount, out capabilitySidArray, out capabilitySidCount);
            if (!apiSucceeded) errorCode = Marshal.GetLastWin32Error();

            int groupArrayErrorCode;
            groupArrayComplete = TryCollectReturnedCapabilitySids(groupSidArray, groupSidCount,
                ownedSidPointers, out groupArrayValid, out groupArrayErrorCode);
            if (!groupArrayComplete)
            {
                cleanupSucceeded = false;
                if (groupArrayErrorCode != ERROR_SUCCESS) errorCode = groupArrayErrorCode;
            }

            int capabilityArrayErrorCode;
            capabilityArrayComplete = TryCollectReturnedCapabilitySids(capabilitySidArray, capabilitySidCount,
                ownedSidPointers, out capabilityArrayValid, out capabilityArrayErrorCode);
            if (!capabilityArrayComplete)
            {
                cleanupSucceeded = false;
                if (capabilityArrayErrorCode != ERROR_SUCCESS) errorCode = capabilityArrayErrorCode;
            }

            layoutValid = apiSucceeded && groupArrayComplete && capabilityArrayComplete &&
                groupArrayValid && capabilityArrayValid && groupSidCount <= MAX_DERIVED_CAPABILITY_SIDS &&
                capabilitySidCount == 1;

            if (layoutValid)
            {
                capabilitySid = Marshal.ReadIntPtr(capabilitySidArray);
                preserveCapabilitySid = capabilitySid != IntPtr.Zero;
                errorCode = ERROR_SUCCESS;
            }
        }
        catch (Exception error)
        {
            layoutValid = false;
            cleanupSucceeded = false;
            errorCode = GetDiagnosticErrorCode(error);
        }
        finally
        {
            int sidCleanupError;
            if (!FreeCapabilitySidPointers(ownedSidPointers, preserveCapabilitySid ? capabilitySid : IntPtr.Zero,
                out sidCleanupError))
            {
                cleanupSucceeded = false;
                errorCode = sidCleanupError;
            }
            if (groupSidArray != IntPtr.Zero)
            {
                int freeErrorCode = TryLocalFreeCapabilitySid(groupSidArray);
                if (freeErrorCode != ERROR_SUCCESS)
                {
                    cleanupSucceeded = false;
                    errorCode = freeErrorCode;
                }
            }
            if (capabilitySidArray != IntPtr.Zero && capabilitySidArray != groupSidArray)
            {
                int freeErrorCode = TryLocalFreeCapabilitySid(capabilitySidArray);
                if (freeErrorCode != ERROR_SUCCESS)
                {
                    cleanupSucceeded = false;
                    errorCode = freeErrorCode;
                }
            }
        }

        if (!apiSucceeded || !layoutValid || !cleanupSucceeded || capabilitySid == IntPtr.Zero)
        {
            if (preserveCapabilitySid && capabilitySid != IntPtr.Zero)
            {
                int freeErrorCode = TryLocalFreeCapabilitySid(capabilitySid);
                if (freeErrorCode != ERROR_SUCCESS) errorCode = freeErrorCode;
            }
            capabilitySid = IntPtr.Zero;
            if (errorCode == ERROR_SUCCESS) errorCode = ERROR_INVALID_DATA;
            return false;
        }
        return true;
    }

    private static bool TryDeriveNetworkCapabilitySids(out List<IntPtr> capabilitySids, out int errorCode)
    {
        string[] capabilityNames = new string[] {
            "internetClient", "internetClientServer", "privateNetworkClientServer"
        };
        capabilitySids = new List<IntPtr>();
        errorCode = ERROR_SUCCESS;
        for (int index = 0; index < capabilityNames.Length; index++)
        {
            IntPtr sid;
            int deriveErrorCode;
            if (!TryDeriveSingleCapabilitySid(capabilityNames[index], out sid, out deriveErrorCode))
            {
                int cleanupErrorCode;
                if (!FreeNetworkCapabilitySids(capabilitySids, out cleanupErrorCode))
                    deriveErrorCode = cleanupErrorCode;
                capabilitySids = null;
                errorCode = deriveErrorCode;
                return false;
            }
            for (int previous = 0; previous < capabilitySids.Count; previous++)
            {
                if (EqualSid(sid, capabilitySids[previous]))
                {
                    int duplicateCleanupError;
                    if (CleanupDuplicateCapabilitySids(sid, capabilitySids,
                        TryLocalFreeCapabilitySid, out duplicateCleanupError))
                        errorCode = ERROR_INVALID_DATA;
                    else errorCode = duplicateCleanupError;
                    capabilitySids = null;
                    return false;
                }
            }
            capabilitySids.Add(sid);
        }
        return capabilitySids.Count == capabilityNames.Length;
    }

    private static bool AddOwnedCapabilitySid(List<IntPtr> ownedSids, IntPtr sid)
    {
        if (sid == IntPtr.Zero || ownedSids.Contains(sid)) return false;
        ownedSids.Add(sid);
        return true;
    }

    private static bool IsValidDerivedCapabilitySid(IntPtr sid)
    {
        if (sid == IntPtr.Zero || !IsValidSid(sid)) return false;
        uint sidLength = GetLengthSid(sid);
        return sidLength >= 8 && sidLength <= 68;
    }

    private static bool TryCollectReturnedCapabilitySids(
        IntPtr sidArray,
        uint sidCount,
        List<IntPtr> ownedSids,
        out bool layoutValid,
        out int errorCode)
    {
        layoutValid = true;
        errorCode = ERROR_SUCCESS;
        if (ownedSids == null)
        {
            layoutValid = false;
            errorCode = ERROR_INVALID_DATA;
            return false;
        }
        if (sidCount == 0)
        {
            if (sidArray != IntPtr.Zero)
            {
                layoutValid = false;
                errorCode = ERROR_INVALID_DATA;
            }
            return true;
        }
        if (sidArray == IntPtr.Zero)
        {
            layoutValid = false;
            errorCode = ERROR_INVALID_DATA;
            return false;
        }

        UIntPtr allocationSize = LocalSize(sidArray);
        ulong allocationBytes = allocationSize.ToUInt64();
        if (allocationBytes == 0)
        {
            layoutValid = false;
            errorCode = Marshal.GetLastWin32Error();
            if (errorCode == ERROR_SUCCESS) errorCode = ERROR_INVALID_DATA;
            return false;
        }
        ulong arraySlots = allocationBytes / (ulong)IntPtr.Size;
        if (allocationBytes > MAX_DERIVED_CAPABILITY_ARRAY_BYTES ||
            sidCount > MAX_DERIVED_CAPABILITY_SIDS || (ulong)sidCount > arraySlots ||
            sidCount > MAX_DERIVED_CAPABILITY_CLEANUP_SIDS)
        {
            layoutValid = false;
            errorCode = ERROR_INVALID_DATA;
        }

        ulong inspectCount = Math.Min((ulong)sidCount,
            Math.Min(arraySlots, (ulong)MAX_DERIVED_CAPABILITY_CLEANUP_SIDS));
        for (ulong index = 0; index < inspectCount; index++)
        {
            long offset = checked((long)index * IntPtr.Size);
            IntPtr sid = Marshal.ReadIntPtr(sidArray, checked((int)offset));
            if (!AddOwnedCapabilitySid(ownedSids, sid) || !IsValidDerivedCapabilitySid(sid))
            {
                layoutValid = false;
                if (errorCode == ERROR_SUCCESS) errorCode = ERROR_INVALID_DATA;
            }
        }
        return inspectCount == sidCount && (ulong)sidCount <= arraySlots;
    }

    private static bool FreeCapabilitySidPointers(List<IntPtr> ownedSids, IntPtr preserveSid, out int errorCode)
    {
        return FreeCapabilitySidPointers(ownedSids, preserveSid, TryLocalFreeCapabilitySid, out errorCode);
    }

    private static bool FreeCapabilitySidPointers(
        List<IntPtr> ownedSids,
        IntPtr preserveSid,
        Func<IntPtr, int> freeCapabilitySid,
        out int errorCode)
    {
        errorCode = ERROR_SUCCESS;
        bool success = true;
        HashSet<IntPtr> freed = new HashSet<IntPtr>();
        if (ownedSids == null || freeCapabilitySid == null)
        {
            errorCode = ERROR_INVALID_DATA;
            return false;
        }
        foreach (IntPtr sid in ownedSids)
        {
            if (sid == IntPtr.Zero || sid == preserveSid || !freed.Add(sid)) continue;
            int freeErrorCode = freeCapabilitySid(sid);
            if (freeErrorCode != ERROR_SUCCESS)
            {
                success = false;
                errorCode = freeErrorCode;
            }
        }
        return success;
    }

    private static int TryLocalFreeCapabilitySid(IntPtr sid)
    {
        try
        {
            if (LocalFree(sid) == IntPtr.Zero) return ERROR_SUCCESS;
            int errorCode = Marshal.GetLastWin32Error();
            return errorCode == ERROR_SUCCESS ? ERROR_INVALID_DATA : errorCode;
        }
        catch (Exception error)
        {
            int errorCode = GetDiagnosticErrorCode(error);
            return errorCode == ERROR_SUCCESS ? ERROR_INVALID_DATA : errorCode;
        }
    }

    private static bool CleanupDuplicateCapabilitySids(
        IntPtr duplicateSid,
        List<IntPtr> existingSids,
        Func<IntPtr, int> freeCapabilitySid,
        out int errorCode)
    {
        errorCode = ERROR_SUCCESS;
        if (duplicateSid == IntPtr.Zero || existingSids == null || freeCapabilitySid == null)
        {
            errorCode = ERROR_INVALID_DATA;
            return false;
        }

        bool cleanupSucceeded = true;
        if (!existingSids.Contains(duplicateSid))
        {
            int duplicateFreeError = freeCapabilitySid(duplicateSid);
            if (duplicateFreeError != ERROR_SUCCESS)
            {
                cleanupSucceeded = false;
                errorCode = duplicateFreeError;
            }
        }

        int existingFreeError;
        if (!FreeCapabilitySidPointers(existingSids, IntPtr.Zero, freeCapabilitySid, out existingFreeError))
        {
            cleanupSucceeded = false;
            if (errorCode == ERROR_SUCCESS) errorCode = existingFreeError;
        }
        return cleanupSucceeded;
    }

    private static bool FreeNetworkCapabilitySids(
        List<IntPtr> capabilitySids,
        Func<IntPtr, int> freeCapabilitySid,
        out int errorCode)
    {
        return FreeCapabilitySidPointers(capabilitySids, IntPtr.Zero, freeCapabilitySid, out errorCode);
    }

    private static bool FreeNetworkCapabilitySids(List<IntPtr> capabilitySids, out int errorCode)
    {
        return FreeCapabilitySidPointers(capabilitySids, IntPtr.Zero, out errorCode);
    }

    private static bool TryCountNetworkCapabilityMatches(
        IntPtr buffer,
        uint returnedBytes,
        uint allocatedBytes,
        List<IntPtr> networkCapabilitySids,
        out uint matchingCount,
        out int errorCode)
    {
        matchingCount = 0;
        errorCode = ERROR_INVALID_DATA;
        if (networkCapabilitySids == null || networkCapabilitySids.Count != 3) return false;
        for (int index = 0; index < networkCapabilitySids.Count; index++)
            if (!IsValidDerivedCapabilitySid(networkCapabilitySids[index])) return false;

        TokenCapabilitiesEvidence parsed = ParseTokenCapabilitiesBuffer(buffer, returnedBytes, allocatedBytes);
        if (parsed.Status != "PASS")
        {
            errorCode = parsed.ErrorCode.GetValueOrDefault(ERROR_INVALID_DATA);
            return false;
        }

        uint count = unchecked((uint)Marshal.ReadInt32(buffer));
        int firstGroupOffset = Marshal.OffsetOf(typeof(TOKEN_GROUPS_FIRST), "FirstGroup").ToInt32();
        int groupEntrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        for (uint tokenIndex = 0; tokenIndex < count; tokenIndex++)
        {
            long entryOffset = (long)firstGroupOffset + ((long)tokenIndex * (long)groupEntrySize);
            IntPtr entryAddress = new IntPtr(buffer.ToInt64() + entryOffset);
            SID_AND_ATTRIBUTES entry = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(entryAddress, typeof(SID_AND_ATTRIBUTES));
            for (int networkIndex = 0; networkIndex < networkCapabilitySids.Count; networkIndex++)
            {
                if (EqualSid(entry.Sid, networkCapabilitySids[networkIndex]))
                {
                    matchingCount++;
                    break;
                }
            }
        }
        errorCode = ERROR_SUCCESS;
        return true;
    }

    private static TokenCapabilitiesEvidence ParseTokenCapabilitiesBuffer(
        IntPtr buffer,
        uint returnedBytes,
        uint allocatedBytes)
    {
        if (buffer == IntPtr.Zero || allocatedBytes < sizeof(uint) || allocatedBytes > MAX_WORKER_TOKEN_BUFFER_BYTES ||
            returnedBytes < sizeof(uint) || returnedBytes > allocatedBytes)
            return CompleteTokenCapabilitiesEvidence(true, true, true, false, true, 0, ERROR_INVALID_DATA);

        uint count = unchecked((uint)Marshal.ReadInt32(buffer));
        if (count > MAX_WORKER_TOKEN_CAPABILITIES)
            return CompleteTokenCapabilitiesEvidence(true, true, true, false, true, count, ERROR_INVALID_DATA);

        int firstGroupOffset = Marshal.OffsetOf(typeof(TOKEN_GROUPS_FIRST), "FirstGroup").ToInt32();
        int groupEntrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        long requiredLength = count == 0 ? sizeof(uint) :
            (long)firstGroupOffset + ((long)count * (long)groupEntrySize);
        if (firstGroupOffset < sizeof(uint) || groupEntrySize < IntPtr.Size + sizeof(uint) ||
            requiredLength < sizeof(uint) || requiredLength > returnedBytes)
            return CompleteTokenCapabilitiesEvidence(true, true, true, false, true, count, ERROR_INVALID_DATA);

        long bufferStart = buffer.ToInt64();
        long bufferEnd = bufferStart + returnedBytes;
        for (uint index = 0; index < count; index++)
        {
            long entryOffset = (long)firstGroupOffset + ((long)index * (long)groupEntrySize);
            if (entryOffset < 0 || entryOffset + groupEntrySize > returnedBytes)
                return CompleteTokenCapabilitiesEvidence(true, true, true, false, true, count, ERROR_INVALID_DATA);
            IntPtr entryAddress = new IntPtr(bufferStart + entryOffset);
            SID_AND_ATTRIBUTES entry = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(entryAddress, typeof(SID_AND_ATTRIBUTES));
            long sidAddress = entry.Sid.ToInt64();
            long sidOffset = sidAddress - bufferStart;
            if (entry.Sid == IntPtr.Zero || sidOffset < 0 || sidOffset > (long)returnedBytes - 8 ||
                !IsValidSid(entry.Sid))
                return CompleteTokenCapabilitiesEvidence(true, true, true, false, true, count, ERROR_INVALID_DATA);
            uint sidLength = GetLengthSid(entry.Sid);
            if (sidLength < 8 || sidLength > 68 || sidLength > (uint)((long)returnedBytes - sidOffset) ||
                sidAddress > bufferEnd - sidLength)
                return CompleteTokenCapabilitiesEvidence(true, true, true, false, true, count, ERROR_INVALID_DATA);
        }

        return CompleteTokenCapabilitiesEvidence(true, true, true, true, true, count, ERROR_SUCCESS);
    }

    private static TokenCapabilitiesEvidence CompleteTokenCapabilitiesEvidence(
        bool tokenIsAppContainer,
        bool sidMatches,
        bool querySucceeded,
        bool layoutSucceeded,
        bool cleanupSucceeded,
        uint count,
        int errorCode)
    {
        TokenCapabilitiesEvidence evidence = new TokenCapabilitiesEvidence();
        if (!tokenIsAppContainer || !sidMatches || !querySucceeded || !layoutSucceeded || !cleanupSucceeded)
        {
            evidence.Status = "UNKNOWN";
            evidence.Count = null;
            evidence.ErrorCode = errorCode == ERROR_SUCCESS ? ERROR_INVALID_DATA : (int?)errorCode;
            return evidence;
        }
        evidence.Status = "PASS";
        evidence.Count = count;
        evidence.ErrorCode = ERROR_SUCCESS;
        return evidence;
    }

    private static bool IsSidInsideBuffer(IntPtr buffer, uint returnedBytes, IntPtr sid)
    {
        if (buffer == IntPtr.Zero || sid == IntPtr.Zero || returnedBytes < 8) return false;
        long start = buffer.ToInt64();
        long end = start + returnedBytes;
        long address = sid.ToInt64();
        long offset = address - start;
        if (offset < 0 || offset > (long)returnedBytes - 8 || address > end - 8 || !IsValidSid(sid)) return false;
        uint length = GetLengthSid(sid);
        return length >= 8 && length <= 68 && length <= (uint)((long)returnedBytes - offset) && address <= end - length;
    }

    private static bool IsValidHeapSid(IntPtr heap, IntPtr sid, out uint sidLength)
    {
        sidLength = 0;
        if (heap == IntPtr.Zero || sid == IntPtr.Zero || !HeapValidate(heap, 0, sid)) return false;
        UIntPtr allocation = HeapSize(heap, 0, sid);
        ulong allocationBytes = allocation.ToUInt64();
        if (allocationBytes == UInt64.MaxValue || allocationBytes < 8) return false;
        byte subAuthorityCount = Marshal.ReadByte(sid, 1);
        if (subAuthorityCount > 15) return false;
        uint expectedLength = 8U + ((uint)subAuthorityCount * 4U);
        if (expectedLength > allocationBytes || !IsValidSid(sid)) return false;
        sidLength = GetLengthSid(sid);
        return sidLength == expectedLength && sidLength <= 68;
    }

    private static string ClassifyLoopbackConfigObservation(
        bool apiSucceeded,
        bool scanComplete,
        bool cleanupSucceeded,
        uint targetMatchCount)
    {
        if (!apiSucceeded || !scanComplete || !cleanupSucceeded || targetMatchCount > 1) return "UNKNOWN";
        return targetMatchCount == 1 ? "PRESENT" : "ABSENT";
    }

    private static bool IsLoopbackWithinBudget(Func<long> elapsedMilliseconds, ref bool expired)
    {
        if (expired || elapsedMilliseconds == null) { expired = true; return false; }
        try
        {
            if (elapsedMilliseconds() >= MAX_LOOPBACK_CONFIG_TRAVERSAL_MS)
                expired = true;
        }
        catch { expired = true; }
        return !expired;
    }

    private static void SetFirstLoopbackError(ref int target, int value)
    {
        if (target == 0) target = value == 0 ? ERROR_INVALID_DATA : value;
    }

    private static LoopbackConfigObservation InspectAndFreeLoopbackConfigList(
        uint count,
        IntPtr returnedSids,
        IntPtr expectedSid,
        IntPtr processHeap,
        bool apiSucceeded,
        int apiErrorCode,
        Func<long> elapsedMilliseconds,
        LoopbackHeapFreeDelegate heapFree,
        LoopbackHeapFreeErrorDelegate heapFreeError,
        Action entryReadObserver)
    {
        LoopbackConfigObservation observation = new LoopbackConfigObservation();
        bool scanComplete = false;
        bool cleanupSucceeded = true;
        bool listSafeToFree = false;
        bool expired = false;
        int cleanupErrorCode = 0;
        uint targetMatchCount = 0;
        List<IntPtr> ownedSids = new List<IntPtr>();
        HashSet<long> seenSidPointers = new HashSet<long>();
        HashSet<string> seenSidValues = new HashSet<string>(StringComparer.Ordinal);

        try
        {
            if (processHeap == IntPtr.Zero && returnedSids != IntPtr.Zero) processHeap = GetProcessHeap();
            if (returnedSids != IntPtr.Zero)
            {
                bool withinBeforeValidation = IsLoopbackWithinBudget(elapsedMilliseconds, ref expired);
                bool arrayHeapValid = withinBeforeValidation && processHeap != IntPtr.Zero &&
                    HeapValidate(processHeap, 0, returnedSids);
                bool withinAfterValidation = IsLoopbackWithinBudget(elapsedMilliseconds, ref expired);
                listSafeToFree = arrayHeapValid;
                if (!arrayHeapValid)
                {
                    SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                }
                if (!withinBeforeValidation || !withinAfterValidation)
                {
                    scanComplete = false;
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                }
                else if (count > MAX_LOOPBACK_CONFIG_ENTRIES)
                {
                    // The API-owned SID entries are intentionally left for helper-process exit.
                    scanComplete = false;
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                }
                else if (arrayHeapValid && expectedSid != IntPtr.Zero)
                {
                    int entrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
                    bool withinBeforeSize = IsLoopbackWithinBudget(elapsedMilliseconds, ref expired);
                    UIntPtr arrayAllocation = withinBeforeSize ? HeapSize(processHeap, 0, returnedSids) : UIntPtr.Zero;
                    ulong arrayBytes = arrayAllocation.ToUInt64();
                    bool withinAfterSize = IsLoopbackWithinBudget(elapsedMilliseconds, ref expired);
                    ulong requiredArrayBytes = (ulong)count * (ulong)entrySize;
                    if (!withinBeforeSize || !withinAfterSize)
                    {
                        cleanupSucceeded = false;
                        SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                        SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                    }
                    else if (arrayBytes == UInt64.MaxValue || arrayBytes < requiredArrayBytes)
                    {
                        SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                        cleanupSucceeded = false;
                        SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                    }
                    else
                    {
                        scanComplete = true;
                        for (uint index = 0; index < count; index++)
                        {
                            if (!IsLoopbackWithinBudget(elapsedMilliseconds, ref expired))
                            {
                                scanComplete = false;
                                cleanupSucceeded = false;
                                SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                                SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                                break;
                            }

                            try
                            {
                                IntPtr entryAddress = IntPtr.Add(returnedSids,
                                    checked((int)(index * (uint)entrySize)));
                                if (entryReadObserver != null) entryReadObserver();
                                SID_AND_ATTRIBUTES entry = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(
                                    entryAddress, typeof(SID_AND_ATTRIBUTES));
                                if (entry.Sid == IntPtr.Zero || entry.Sid == returnedSids)
                                {
                                    scanComplete = false;
                                    cleanupSucceeded = false;
                                    SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                                }
                                else if (!seenSidPointers.Add(entry.Sid.ToInt64()))
                                {
                                    // Repeated pointers are freed only once, through their first occurrence.
                                    scanComplete = false;
                                    SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                                }
                                else
                                {
                                    uint sidLength;
                                    if (!IsValidHeapSid(processHeap, entry.Sid, out sidLength))
                                    {
                                        scanComplete = false;
                                        cleanupSucceeded = false;
                                        SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                                        SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                                    }
                                    else
                                    {
                                        ownedSids.Add(entry.Sid);
                                        byte[] sidBytes = new byte[(int)sidLength];
                                        Marshal.Copy(entry.Sid, sidBytes, 0, sidBytes.Length);
                                        StringBuilder sidKeyBuilder = new StringBuilder(sidBytes.Length * 2);
                                        for (int byteIndex = 0; byteIndex < sidBytes.Length; byteIndex++)
                                            sidKeyBuilder.Append(sidBytes[byteIndex].ToString("x2"));
                                        if (!seenSidValues.Add(sidKeyBuilder.ToString()))
                                        {
                                            scanComplete = false;
                                            SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                                        }
                                        if (apiSucceeded && EqualSid(entry.Sid, expectedSid)) targetMatchCount++;
                                    }
                                }
                            }
                            catch
                            {
                                scanComplete = false;
                                cleanupSucceeded = false;
                                SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                                SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                            }

                            if (!IsLoopbackWithinBudget(elapsedMilliseconds, ref expired))
                            {
                                scanComplete = false;
                                cleanupSucceeded = false;
                                SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                                SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                                break;
                            }
                        }
                    }
                }
                else
                {
                    scanComplete = false;
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                }
            }
            else if (count == 0 && apiSucceeded && expectedSid != IntPtr.Zero)
            {
                scanComplete = true;
            }
            else
            {
                scanComplete = false;
                SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
            }
        }
        catch
        {
            scanComplete = false;
            cleanupSucceeded = false;
            SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
            SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
        }
        finally
        {
            if (heapFree == null) cleanupSucceeded = false;
            for (int index = 0; index < ownedSids.Count; index++)
            {
                if (!IsLoopbackWithinBudget(elapsedMilliseconds, ref expired))
                {
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                    break;
                }
                bool freed = false;
                try { freed = heapFree(processHeap, ownedSids[index]); }
                catch { SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA); }
                int freeError = 0;
                if (!freed && heapFreeError != null)
                {
                    try { freeError = heapFreeError(); } catch { freeError = ERROR_INVALID_DATA; }
                }
                if (!freed)
                {
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref cleanupErrorCode, freeError);
                }
                if (!IsLoopbackWithinBudget(elapsedMilliseconds, ref expired))
                {
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                    break;
                }
            }

            if (returnedSids != IntPtr.Zero && listSafeToFree)
            {
                // The array was validated before scanning. Release this one safe
                // outer allocation even when a SID free exhausted the scan budget.
                if (!IsLoopbackWithinBudget(elapsedMilliseconds, ref expired))
                {
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                }
                if (heapFree == null)
                {
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                }
                else
                {
                    bool freed = false;
                    try { freed = heapFree(processHeap, returnedSids); }
                    catch { SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA); }
                    int freeError = 0;
                    if (!freed && heapFreeError != null)
                    {
                        try { freeError = heapFreeError(); } catch { freeError = ERROR_INVALID_DATA; }
                    }
                    if (!freed)
                    {
                        cleanupSucceeded = false;
                        SetFirstLoopbackError(ref cleanupErrorCode, freeError);
                    }
                    if (!IsLoopbackWithinBudget(elapsedMilliseconds, ref expired))
                    {
                        cleanupSucceeded = false;
                        SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                    }
                }
            }

            if (expectedSid != IntPtr.Zero)
            {
                if (!IsLoopbackWithinBudget(elapsedMilliseconds, ref expired))
                {
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                }
                // expectedSid is owned by this process, so release it even after
                // the deadline; the post-free check still makes the result UNKNOWN.
                IntPtr localFreeResult = IntPtr.Zero;
                try { localFreeResult = LocalFree(expectedSid); }
                catch { localFreeResult = expectedSid; }
                if (localFreeResult != IntPtr.Zero)
                {
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref cleanupErrorCode, Marshal.GetLastWin32Error());
                }
                if (!IsLoopbackWithinBudget(elapsedMilliseconds, ref expired))
                {
                    cleanupSucceeded = false;
                    SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
                }
            }
        }

        if (expired)
        {
            scanComplete = false;
            cleanupSucceeded = false;
            SetFirstLoopbackError(ref apiErrorCode, ERROR_INVALID_DATA);
            SetFirstLoopbackError(ref cleanupErrorCode, ERROR_INVALID_DATA);
        }
        observation.entry_count = count <= MAX_LOOPBACK_CONFIG_ENTRIES ? (uint?)count : null;
        observation.error_code = apiErrorCode == 0 ? (int?)null : apiErrorCode;
        observation.cleanup_status = cleanupSucceeded ? "PASS" : "UNKNOWN";
        observation.cleanup_error_code = cleanupErrorCode == 0 ? (int?)null : cleanupErrorCode;
        observation.loopback_exemption = ClassifyLoopbackConfigObservation(
            apiSucceeded, scanComplete, cleanupSucceeded, targetMatchCount);
        if (observation.loopback_exemption == "UNKNOWN" && observation.error_code == null && cleanupErrorCode != 0)
            observation.error_code = cleanupErrorCode;
        return observation;
    }

    public static LoopbackConfigObservation ReadLoopbackConfigForAppContainer(string profileSid)
    {
        if (!IsCanonicalAppContainerSidText(profileSid))
        {
            LoopbackConfigObservation invalid = new LoopbackConfigObservation();
            invalid.error_code = ERROR_INVALID_DATA;
            invalid.cleanup_status = "PASS";
            return invalid;
        }

        IntPtr expectedSid = IntPtr.Zero;
        IntPtr returnedSids = IntPtr.Zero;
        uint count = 0;
        int apiErrorCode = 0;
        if (!ConvertStringSidToSid(profileSid, out expectedSid))
        {
            LoopbackConfigObservation invalid = new LoopbackConfigObservation();
            invalid.error_code = Marshal.GetLastWin32Error();
            invalid.cleanup_status = "UNKNOWN";
            invalid.cleanup_error_code = invalid.error_code;
            return invalid;
        }

        IntPtr processHeap = GetProcessHeap();
        uint nativeStatus;
        try
        {
            nativeStatus = NetworkIsolationGetAppContainerConfig(out count, out returnedSids);
        }
        catch (Exception error)
        {
            LoopbackConfigObservation failure = new LoopbackConfigObservation();
            failure.error_code = GetDiagnosticErrorCode(error);
            if (LocalFree(expectedSid) != IntPtr.Zero)
            {
                failure.cleanup_status = "UNKNOWN";
                failure.cleanup_error_code = Marshal.GetLastWin32Error();
            }
            else failure.cleanup_status = "PASS";
            return failure;
        }

        // Start the bounded interval immediately on return from the synchronous API.
        Stopwatch postReturnTimer = Stopwatch.StartNew();
        bool apiSucceeded = nativeStatus == 0;
        if (!apiSucceeded) apiErrorCode = unchecked((int)nativeStatus);
        int lastHeapFreeError = 0;
        LoopbackHeapFreeDelegate free = delegate(IntPtr heap, IntPtr memory)
        {
            bool success = HeapFree(heap, 0, memory);
            if (!success) lastHeapFreeError = Marshal.GetLastWin32Error();
            return success;
        };
        LoopbackHeapFreeErrorDelegate freeError = delegate() { return lastHeapFreeError; };
        return InspectAndFreeLoopbackConfigList(count, returnedSids, expectedSid, processHeap,
            apiSucceeded, apiErrorCode, delegate() { return postReturnTimer.ElapsedMilliseconds; }, free, freeError, null);
    }

    public static bool TokenCapabilitiesSyntheticSelfTest()
    {
        if (!DuplicateCapabilitySidCleanupSyntheticSelfTest())
            throw new InvalidOperationException("Duplicate capability SID cleanup SelfTest failed.");
        if (!OverLimitCapabilitySidCleanupSyntheticSelfTest())
            throw new InvalidOperationException("Over-limit capability SID cleanup SelfTest failed.");

        int firstGroupOffset = Marshal.OffsetOf(typeof(TOKEN_GROUPS_FIRST), "FirstGroup").ToInt32();
        int groupEntrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        const int sidLength = 12;
        int sidOffset = firstGroupOffset + groupEntrySize;
        int totalBytes = sidOffset + sidLength;
        IntPtr validBuffer = Marshal.AllocHGlobal(totalBytes);
        IntPtr zeroBuffer = Marshal.AllocHGlobal(sizeof(uint));
        try
        {
            Marshal.WriteInt32(zeroBuffer, 0);
            TokenCapabilitiesEvidence zero = ParseTokenCapabilitiesBuffer(zeroBuffer, sizeof(uint), sizeof(uint));
            if (zero.Status != "PASS" || zero.Count != 0)
                throw new InvalidOperationException("TokenCapabilities zero-count SelfTest failed.");

            byte[] sidBytes = new byte[] { 1, 1, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0 };
            Marshal.Copy(sidBytes, 0, IntPtr.Add(validBuffer, sidOffset), sidBytes.Length);
            SID_AND_ATTRIBUTES first = new SID_AND_ATTRIBUTES {
                Sid = IntPtr.Add(validBuffer, sidOffset), Attributes = 0
            };
            Marshal.WriteInt32(validBuffer, 1);
            Marshal.StructureToPtr(first, IntPtr.Add(validBuffer, firstGroupOffset), false);
            TokenCapabilitiesEvidence one = ParseTokenCapabilitiesBuffer(validBuffer, (uint)totalBytes, (uint)totalBytes);
            if (one.Status != "PASS" || one.Count != 1)
                throw new InvalidOperationException("TokenCapabilities one-member SelfTest failed.");

            if (ParseTokenCapabilitiesBuffer(validBuffer, (uint)(firstGroupOffset + groupEntrySize),
                (uint)totalBytes).Status != "UNKNOWN")
                throw new InvalidOperationException("TokenCapabilities truncated-buffer SelfTest failed.");
            Marshal.WriteInt32(validBuffer, MAX_WORKER_TOKEN_CAPABILITIES + 1);
            if (ParseTokenCapabilitiesBuffer(validBuffer, (uint)totalBytes, (uint)totalBytes).Status != "UNKNOWN")
                throw new InvalidOperationException("TokenCapabilities group-overflow SelfTest failed.");
            Marshal.WriteInt32(validBuffer, 1);
            first.Sid = IntPtr.Add(validBuffer, totalBytes - 4);
            Marshal.StructureToPtr(first, IntPtr.Add(validBuffer, firstGroupOffset), false);
            if (ParseTokenCapabilitiesBuffer(validBuffer, (uint)totalBytes, (uint)totalBytes).Status != "UNKNOWN")
                throw new InvalidOperationException("TokenCapabilities SID-pointer SelfTest failed.");

            if (CompleteTokenCapabilitiesEvidence(true, true, false, false, true, 0, 5).Status != "UNKNOWN" ||
                CompleteTokenCapabilitiesEvidence(true, false, true, true, true, 1, 0).Status != "UNKNOWN" ||
                CompleteTokenCapabilitiesEvidence(true, true, true, true, false, 1, 0).Status != "UNKNOWN" ||
                CompleteTokenCapabilitiesEvidence(false, true, true, true, true, 1, 0).Status != "UNKNOWN")
                throw new InvalidOperationException("TokenCapabilities fail-closed classification SelfTest failed.");

            List<IntPtr> networkCapabilitySids;
            int derivationErrorCode;
            if (!TryDeriveNetworkCapabilitySids(out networkCapabilitySids, out derivationErrorCode) ||
                networkCapabilitySids == null || networkCapabilitySids.Count != 3)
                throw new InvalidOperationException("Network capability SID derivation SelfTest failed.");
            try
            {
                uint noMatches;
                int noMatchErrorCode;
                if (!TryCountNetworkCapabilityMatches(zeroBuffer, sizeof(uint), sizeof(uint),
                    networkCapabilitySids, out noMatches, out noMatchErrorCode) || noMatches != 0)
                    throw new InvalidOperationException("TokenCapabilities no-network-match SelfTest failed.");

                for (int index = 0; index < networkCapabilitySids.Count; index++)
                {
                    IntPtr expectedSid = networkCapabilitySids[index];
                    int expectedSidLength = checked((int)GetLengthSid(expectedSid));
                    int expectedSidOffset = firstGroupOffset + groupEntrySize;
                    int expectedTotalBytes = expectedSidOffset + expectedSidLength;
                    IntPtr expectedBuffer = Marshal.AllocHGlobal(expectedTotalBytes);
                    try
                    {
                        byte[] expectedSidBytes = new byte[expectedSidLength];
                        Marshal.Copy(expectedSid, expectedSidBytes, 0, expectedSidLength);
                        Marshal.Copy(expectedSidBytes, 0, IntPtr.Add(expectedBuffer, expectedSidOffset), expectedSidLength);
                        Marshal.WriteInt32(expectedBuffer, 1);
                        SID_AND_ATTRIBUTES expectedEntry = new SID_AND_ATTRIBUTES {
                            Sid = IntPtr.Add(expectedBuffer, expectedSidOffset), Attributes = 0
                        };
                        Marshal.StructureToPtr(expectedEntry,
                            IntPtr.Add(expectedBuffer, firstGroupOffset), false);

                        uint matchedCount;
                        int matchedErrorCode;
                        if (!TryCountNetworkCapabilityMatches(expectedBuffer, (uint)expectedTotalBytes,
                            (uint)expectedTotalBytes, networkCapabilitySids, out matchedCount,
                            out matchedErrorCode) || matchedCount != 1)
                            throw new InvalidOperationException("TokenCapabilities network-match SelfTest failed.");
                    }
                    finally { Marshal.FreeHGlobal(expectedBuffer); }
                }
            }
            finally
            {
                int networkSidCleanupError;
                if (!FreeNetworkCapabilitySids(networkCapabilitySids, out networkSidCleanupError))
                    throw new InvalidOperationException("Network capability SID cleanup SelfTest failed.");
            }
            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(zeroBuffer);
            Marshal.FreeHGlobal(validBuffer);
        }
    }

    private static bool DuplicateCapabilitySidCleanupSyntheticSelfTest()
    {
        IntPtr sharedSid = new IntPtr(0x1111);
        List<IntPtr> existingSids = new List<IntPtr> { sharedSid };
        List<IntPtr> freedSids = new List<IntPtr>();
        Func<IntPtr, int> successfulFree = delegate(IntPtr sid) {
            freedSids.Add(sid);
            return ERROR_SUCCESS;
        };
        int errorCode;
        if (!CleanupDuplicateCapabilitySids(sharedSid, existingSids, successfulFree, out errorCode) ||
            errorCode != ERROR_SUCCESS || freedSids.Count != 1 || freedSids[0] != sharedSid)
            return false;

        IntPtr existingSid = new IntPtr(0x2222);
        IntPtr separatelyAllocatedDuplicateSid = new IntPtr(0x3333);
        existingSids = new List<IntPtr> { existingSid };
        freedSids = new List<IntPtr>();
        if (!CleanupDuplicateCapabilitySids(separatelyAllocatedDuplicateSid, existingSids,
            successfulFree, out errorCode) || errorCode != ERROR_SUCCESS || freedSids.Count != 2 ||
            freedSids[0] != separatelyAllocatedDuplicateSid || freedSids[1] != existingSid)
            return false;

        existingSids = new List<IntPtr> { existingSid };
        freedSids = new List<IntPtr>();
        Func<IntPtr, int> failedDuplicateFree = delegate(IntPtr sid) {
            freedSids.Add(sid);
            return sid == separatelyAllocatedDuplicateSid ? ERROR_INVALID_DATA : ERROR_SUCCESS;
        };
        return !CleanupDuplicateCapabilitySids(separatelyAllocatedDuplicateSid, existingSids,
                failedDuplicateFree, out errorCode) && errorCode == ERROR_INVALID_DATA &&
            freedSids.Count == 2;
    }

    private static bool OverLimitCapabilitySidCleanupSyntheticSelfTest()
    {
        uint sidCount = 257;
        UIntPtr arrayBytes = new UIntPtr((ulong)sidCount * (ulong)IntPtr.Size);
        IntPtr sidArray = LocalAlloc(0, arrayBytes);
        if (sidArray == IntPtr.Zero) return false;
        List<IntPtr> allocatedSids = new List<IntPtr>();
        List<IntPtr> ownedSids = new List<IntPtr>();
        List<IntPtr> freeCalls = new List<IntPtr>();
        bool passed = false;
        try
        {
            for (uint index = 0; index < sidCount; index++)
            {
                IntPtr sid;
                if (!ConvertStringSidToSid("S-1-15-2-42", out sid) || sid == IntPtr.Zero) return false;
                allocatedSids.Add(sid);
                Marshal.WriteIntPtr(sidArray, checked((int)index * IntPtr.Size), sid);
            }

            bool layoutValid;
            int errorCode;
            bool complete = TryCollectReturnedCapabilitySids(sidArray, sidCount, ownedSids,
                out layoutValid, out errorCode);
            if (!complete || layoutValid || errorCode != ERROR_INVALID_DATA || ownedSids.Count != sidCount)
                return false;

            Func<IntPtr, int> observeFree = delegate(IntPtr sid) {
                freeCalls.Add(sid);
                return ERROR_SUCCESS;
            };
            if (!FreeCapabilitySidPointers(ownedSids, IntPtr.Zero, observeFree, out errorCode) ||
                errorCode != ERROR_SUCCESS || freeCalls.Count != sidCount)
                return false;
            for (int index = 0; index < allocatedSids.Count; index++)
                if (freeCalls[index] != allocatedSids[index]) return false;
            passed = true;
            return true;
        }
        finally
        {
            foreach (IntPtr sid in allocatedSids)
            {
                int freeErrorCode = TryLocalFreeCapabilitySid(sid);
                if (freeErrorCode != ERROR_SUCCESS)
                    throw new InvalidOperationException("Synthetic capability SID cleanup failed.");
            }
            if (LocalFree(sidArray) != IntPtr.Zero)
                throw new InvalidOperationException("Synthetic capability SID array cleanup failed.");
            if (!passed && freeCalls.Count != 0 && freeCalls.Count != allocatedSids.Count)
                throw new InvalidOperationException("Synthetic capability SID cleanup was incomplete.");
        }
    }

    public static bool LoopbackConfigSyntheticSelfTest()
    {
        IntPtr heap = GetProcessHeap();
        if (heap == IntPtr.Zero) throw new InvalidOperationException("Loopback synthetic process heap is unavailable.");

        IntPtr expectedSid = IntPtr.Zero;
        if (!ConvertStringSidToSid("S-1-15-2-42", out expectedSid))
            throw new InvalidOperationException("Loopback synthetic expected SID could not be allocated.");
        byte[] expectedSidBytes = new byte[GetLengthSid(expectedSid)];
        Marshal.Copy(expectedSid, expectedSidBytes, 0, expectedSidBytes.Length);

        IntPtr presentSid = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr presentArray = AllocateSyntheticLoopbackArray(heap, presentSid);
        List<IntPtr> frees;
        LoopbackConfigObservation present = RunSyntheticLoopbackScan(1, presentArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return 0L; }, IntPtr.Zero, null, null, out frees);
        AssertSyntheticLoopbackResult(present, "PRESENT", "PASS");
        AssertSyntheticFreeCalls(frees, presentSid, presentArray);

        LoopbackConfigObservation absent = RunSyntheticLoopbackScan(0, IntPtr.Zero,
            ConvertSyntheticExpectedSid(), heap, delegate() { return 0L; }, IntPtr.Zero, null, null, out frees);
        AssertSyntheticLoopbackResult(absent, "ABSENT", "PASS");
        AssertSyntheticFreeCalls(frees);

        IntPtr uninspectedSid = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr overflowArray = AllocateSyntheticLoopbackArray(heap, uninspectedSid);
        int overflowEntryReads = 0;
        LoopbackConfigObservation overflow = RunSyntheticLoopbackScan(
            MAX_LOOPBACK_CONFIG_ENTRIES + 1U, overflowArray, ConvertSyntheticExpectedSid(), heap,
            delegate() { return 0L; }, IntPtr.Zero, null, delegate() { overflowEntryReads++; }, out frees);
        AssertSyntheticLoopbackResult(overflow, "UNKNOWN", "UNKNOWN");
        if (overflow.entry_count.HasValue || overflowEntryReads != 0)
            throw new InvalidOperationException("Loopback overflow inspected an entry or exposed an uncapped count.");
        AssertSyntheticFreeCalls(frees, overflowArray);

        IntPtr nullEntryArray = AllocateSyntheticLoopbackArray(heap, IntPtr.Zero);
        LoopbackConfigObservation nullEntry = RunSyntheticLoopbackScan(1, nullEntryArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return 0L; }, IntPtr.Zero, null, null, out frees);
        AssertSyntheticLoopbackResult(nullEntry, "UNKNOWN", "UNKNOWN");
        AssertSyntheticFreeCalls(frees, nullEntryArray);

        IntPtr malformedSid = AllocateSyntheticHeapBlock(heap, new byte[12]);
        IntPtr malformedArray = AllocateSyntheticLoopbackArray(heap, malformedSid);
        LoopbackConfigObservation malformed = RunSyntheticLoopbackScan(1, malformedArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return 0L; }, IntPtr.Zero, null, null, out frees);
        AssertSyntheticLoopbackResult(malformed, "UNKNOWN", "UNKNOWN");
        AssertSyntheticFreeCalls(frees, malformedArray);

        IntPtr invalidSidStorage = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr invalidSidArray = AllocateSyntheticLoopbackArray(heap, IntPtr.Add(invalidSidStorage, 1));
        LoopbackConfigObservation invalidPointer = RunSyntheticLoopbackScan(1, invalidSidArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return 0L; }, IntPtr.Zero, null, null, out frees);
        AssertSyntheticLoopbackResult(invalidPointer, "UNKNOWN", "UNKNOWN");
        AssertSyntheticFreeCalls(frees, invalidSidArray);
        HeapFree(heap, 0, invalidSidStorage);

        IntPtr repeatedSid = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr repeatedArray = AllocateSyntheticLoopbackArray(heap, repeatedSid, repeatedSid);
        LoopbackConfigObservation repeatedPointer = RunSyntheticLoopbackScan(2, repeatedArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return 0L; }, IntPtr.Zero, null, null, out frees);
        AssertSyntheticLoopbackResult(repeatedPointer, "UNKNOWN", "PASS");
        AssertSyntheticFreeCalls(frees, repeatedSid, repeatedArray);

        IntPtr duplicateSidOne = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr duplicateSidTwo = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr duplicateValuesArray = AllocateSyntheticLoopbackArray(heap, duplicateSidOne, duplicateSidTwo);
        LoopbackConfigObservation duplicateValues = RunSyntheticLoopbackScan(2, duplicateValuesArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return 0L; }, IntPtr.Zero, null, null, out frees);
        AssertSyntheticLoopbackResult(duplicateValues, "UNKNOWN", "PASS");
        AssertSyntheticFreeCalls(frees, duplicateSidOne, duplicateSidTwo, duplicateValuesArray);

        IntPtr failedSid = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr failedSidArray = AllocateSyntheticLoopbackArray(heap, failedSid);
        LoopbackConfigObservation sidFreeFailure = RunSyntheticLoopbackScan(1, failedSidArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return 0L; }, failedSid, null, null, out frees);
        AssertSyntheticLoopbackResult(sidFreeFailure, "UNKNOWN", "UNKNOWN");
        AssertSyntheticFreeCalls(frees, failedSid, failedSidArray);
        HeapFree(heap, 0, failedSid);

        IntPtr failedArraySid = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr failedArray = AllocateSyntheticLoopbackArray(heap, failedArraySid);
        LoopbackConfigObservation arrayFreeFailure = RunSyntheticLoopbackScan(1, failedArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return 0L; }, failedArray, null, null, out frees);
        AssertSyntheticLoopbackResult(arrayFreeFailure, "UNKNOWN", "UNKNOWN");
        AssertSyntheticFreeCalls(frees, failedArraySid, failedArray);
        HeapFree(heap, 0, failedArray);

        long sidFreeClock = 0;
        IntPtr slowFinalSid = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr slowFinalArray = AllocateSyntheticLoopbackArray(heap, slowFinalSid);
        LoopbackConfigObservation finalSidDeadline = RunSyntheticLoopbackScan(1, slowFinalArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return sidFreeClock; }, IntPtr.Zero,
            delegate(IntPtr memory) { if (memory == slowFinalSid) sidFreeClock = MAX_LOOPBACK_CONFIG_TRAVERSAL_MS; },
            null, out frees);
        AssertSyntheticLoopbackResult(finalSidDeadline, "UNKNOWN", "UNKNOWN");
        AssertSyntheticFreeCalls(frees, slowFinalSid, slowFinalArray);

        long arrayFreeClock = 0;
        IntPtr slowArraySid = AllocateSyntheticHeapBlock(heap, expectedSidBytes);
        IntPtr slowArray = AllocateSyntheticLoopbackArray(heap, slowArraySid);
        LoopbackConfigObservation arrayDeadline = RunSyntheticLoopbackScan(1, slowArray,
            ConvertSyntheticExpectedSid(), heap, delegate() { return arrayFreeClock; }, IntPtr.Zero,
            delegate(IntPtr memory) { if (memory == slowArray) arrayFreeClock = MAX_LOOPBACK_CONFIG_TRAVERSAL_MS; },
            null, out frees);
        AssertSyntheticLoopbackResult(arrayDeadline, "UNKNOWN", "UNKNOWN");
        AssertSyntheticFreeCalls(frees, slowArraySid, slowArray);

        LocalFree(expectedSid);
        return true;
    }

    private static IntPtr ConvertSyntheticExpectedSid()
    {
        IntPtr sid = IntPtr.Zero;
        if (!ConvertStringSidToSid("S-1-15-2-42", out sid))
            throw new InvalidOperationException("Loopback synthetic expected SID allocation failed.");
        return sid;
    }

    private static IntPtr AllocateSyntheticHeapBlock(IntPtr heap, byte[] bytes)
    {
        IntPtr memory = HeapAlloc(heap, 0, new UIntPtr((uint)bytes.Length));
        if (memory == IntPtr.Zero) throw new InvalidOperationException("Loopback synthetic heap allocation failed.");
        if (bytes.Length > 0) Marshal.Copy(bytes, 0, memory, bytes.Length);
        return memory;
    }

    private static IntPtr AllocateSyntheticLoopbackArray(IntPtr heap, params IntPtr[] sidPointers)
    {
        int entrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        IntPtr array = HeapAlloc(heap, 0, new UIntPtr((uint)(entrySize * sidPointers.Length)));
        if (array == IntPtr.Zero) throw new InvalidOperationException("Loopback synthetic array allocation failed.");
        for (int index = 0; index < sidPointers.Length; index++)
        {
            SID_AND_ATTRIBUTES entry = new SID_AND_ATTRIBUTES { Sid = sidPointers[index], Attributes = 0 };
            Marshal.StructureToPtr(entry, IntPtr.Add(array, index * entrySize), false);
        }
        return array;
    }

    private static LoopbackConfigObservation RunSyntheticLoopbackScan(
        uint count,
        IntPtr array,
        IntPtr expectedSid,
        IntPtr heap,
        Func<long> elapsedMilliseconds,
        IntPtr simulatedFreeFailure,
        Action<IntPtr> afterFree,
        Action entryReadObserver,
        out List<IntPtr> freeCalls)
    {
        int lastFreeError = 0;
        List<IntPtr> recordedFreeCalls = new List<IntPtr>();
        freeCalls = recordedFreeCalls;
        LoopbackHeapFreeDelegate free = delegate(IntPtr targetHeap, IntPtr memory)
        {
            recordedFreeCalls.Add(memory);
            if (memory == simulatedFreeFailure)
            {
                lastFreeError = ERROR_INVALID_DATA;
                return false;
            }
            bool nativeResult = HeapFree(targetHeap, 0, memory);
            if (afterFree != null) afterFree(memory);
            if (!nativeResult) lastFreeError = Marshal.GetLastWin32Error();
            return nativeResult;
        };
        LoopbackHeapFreeErrorDelegate freeError = delegate() { return lastFreeError; };
        return InspectAndFreeLoopbackConfigList(count, array, expectedSid, heap, true, 0,
            elapsedMilliseconds, free, freeError, entryReadObserver);
    }

    private static void AssertSyntheticLoopbackResult(
        LoopbackConfigObservation result,
        string expectedExemption,
        string expectedCleanup)
    {
        if (result.loopback_exemption != expectedExemption || result.cleanup_status != expectedCleanup)
            throw new InvalidOperationException("Loopback synthetic classification or cleanup status failed.");
    }

    private static void AssertSyntheticFreeCalls(List<IntPtr> freeCalls, params IntPtr[] expected)
    {
        if (freeCalls.Count != expected.Length)
            throw new InvalidOperationException("Loopback synthetic allocation free count failed.");
        HashSet<long> actualUnique = new HashSet<long>();
        HashSet<long> expectedUnique = new HashSet<long>();
        for (int index = 0; index < freeCalls.Count; index++)
            if (!actualUnique.Add(freeCalls[index].ToInt64()))
                throw new InvalidOperationException("Loopback synthetic allocation was freed more than once.");
        for (int index = 0; index < expected.Length; index++) expectedUnique.Add(expected[index].ToInt64());
        if (!actualUnique.SetEquals(expectedUnique))
            throw new InvalidOperationException("Loopback synthetic cleanup freed an unexpected allocation.");
    }

    private static bool VerifyProcessToken(IntPtr process, IntPtr expectedSid)
    {
        IntPtr token = IntPtr.Zero;
        IntPtr isContainerBuffer = IntPtr.Zero;
        IntPtr sidBuffer = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw LastError("OpenProcessToken");
            isContainerBuffer = Marshal.AllocHGlobal(sizeof(int));
            uint returned;
            if (!GetTokenInformation(token, TokenIsAppContainer, isContainerBuffer, sizeof(int), out returned))
                throw LastError("GetTokenInformation(TokenIsAppContainer)");
            if (Marshal.ReadInt32(isContainerBuffer) != 1) return false;

            if (GetTokenInformation(token, TokenAppContainerSid, IntPtr.Zero, 0, out returned))
                throw new InvalidOperationException("TokenAppContainerSid unexpectedly returned without a buffer.");
            if (Marshal.GetLastWin32Error() != 122 || returned < (uint)Marshal.SizeOf(typeof(TOKEN_APPCONTAINER_INFORMATION)))
                throw LastError("GetTokenInformation(TokenAppContainerSid size)");
            sidBuffer = Marshal.AllocHGlobal((int)returned);
            if (!GetTokenInformation(token, TokenAppContainerSid, sidBuffer, returned, out returned))
                throw LastError("GetTokenInformation(TokenAppContainerSid)");
            TOKEN_APPCONTAINER_INFORMATION information = (TOKEN_APPCONTAINER_INFORMATION)Marshal.PtrToStructure(
                sidBuffer, typeof(TOKEN_APPCONTAINER_INFORMATION));
            return information.TokenAppContainer != IntPtr.Zero && EqualSid(information.TokenAppContainer, expectedSid);
        }
        finally
        {
            if (sidBuffer != IntPtr.Zero) Marshal.FreeHGlobal(sidBuffer);
            if (isContainerBuffer != IntPtr.Zero) Marshal.FreeHGlobal(isContainerBuffer);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    private static void InspectSuspendedAppContainerToken(
        IntPtr process,
        string[] directoryLabels,
        byte[][] directorySecurityDescriptors,
        string[] stagedFileLabels,
        byte[][] stagedFileSecurityDescriptors,
        SuspendedStartupVariantResult result)
    {
        IntPtr token = IntPtr.Zero;
        IntPtr impersonationToken = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, out token))
            {
                result.DirectoryTraverseDiagnostics = CreateUnknownDirectoryTraverseDiagnostics(directoryLabels);
                result.StagedFileReadDiagnostics = CreateUnknownStagedFileReadDiagnostics(stagedFileLabels);
                return;
            }

            bool privilegePresent;
            bool privilegeEnabled;
            result.SeChangeNotifyPrivilegeQuerySucceeded =
                TryQuerySeChangeNotifyPrivilege(token, out privilegePresent, out privilegeEnabled);
            if (result.SeChangeNotifyPrivilegeQuerySucceeded)
            {
                result.SeChangeNotifyPrivilegePresent = privilegePresent;
                result.SeChangeNotifyPrivilegeEnabled = privilegeEnabled;
            }
            else
            {
                result.SeChangeNotifyPrivilegePresent = null;
                result.SeChangeNotifyPrivilegeEnabled = null;
            }

            if (!DuplicateTokenEx(token, TOKEN_QUERY, IntPtr.Zero, SecurityImpersonation,
                TokenImpersonation, out impersonationToken))
            {
                result.DirectoryTraverseDiagnostics = CreateUnknownDirectoryTraverseDiagnostics(directoryLabels);
                result.StagedFileReadDiagnostics = CreateUnknownStagedFileReadDiagnostics(stagedFileLabels);
                return;
            }

            int count = directoryLabels == null ? 0 : Math.Min(directoryLabels.Length, 512);
            DirectoryTraverseAccessDiagnostic[] diagnostics = new DirectoryTraverseAccessDiagnostic[count];
            for (int index = 0; index < count; index++)
            {
                byte[] descriptor = directorySecurityDescriptors != null &&
                    index < directorySecurityDescriptors.Length ? directorySecurityDescriptors[index] : null;
                bool accessGranted = false;
                bool readAttributesGranted = false;
                bool querySucceeded = TryCheckAccess(impersonationToken, descriptor, FILE_TRAVERSE, out accessGranted);
                bool readAttributesQuerySucceeded = TryCheckAccess(impersonationToken, descriptor,
                    FILE_READ_ATTRIBUTES, out readAttributesGranted);
                diagnostics[index] = new DirectoryTraverseAccessDiagnostic();
                diagnostics[index].Label = SanitizeDirectoryDiagnosticLabel(directoryLabels[index]);
                diagnostics[index].Status = GetAccessCheckDecision(querySucceeded, accessGranted);
                diagnostics[index].ReadAttributesStatus = GetAccessCheckDecision(
                    readAttributesQuerySucceeded, readAttributesGranted);
            }
            result.DirectoryTraverseDiagnostics = diagnostics;

            int fileCount = stagedFileLabels == null ? 0 : Math.Min(stagedFileLabels.Length, 8);
            StagedFileReadDiagnostic[] fileDiagnostics = new StagedFileReadDiagnostic[fileCount];
            for (int index = 0; index < fileCount; index++)
            {
                byte[] descriptor = stagedFileSecurityDescriptors != null &&
                    index < stagedFileSecurityDescriptors.Length ? stagedFileSecurityDescriptors[index] : null;
                bool attributesGranted = false;
                bool dataGranted = false;
                bool attributesQuerySucceeded = TryCheckAccess(impersonationToken, descriptor,
                    FILE_READ_ATTRIBUTES, out attributesGranted);
                bool dataQuerySucceeded = TryCheckAccess(impersonationToken, descriptor,
                    FILE_READ_DATA, out dataGranted);
                fileDiagnostics[index] = new StagedFileReadDiagnostic();
                fileDiagnostics[index].Label = SanitizeStagedFileReadLabel(stagedFileLabels[index]);
                fileDiagnostics[index].ReadAttributesStatus = GetAccessCheckDecision(
                    attributesQuerySucceeded, attributesGranted);
                fileDiagnostics[index].ReadDataStatus = GetAccessCheckDecision(dataQuerySucceeded, dataGranted);
            }
            result.StagedFileReadDiagnostics = fileDiagnostics;
        }
        catch
        {
            result.DirectoryTraverseDiagnostics = CreateUnknownDirectoryTraverseDiagnostics(directoryLabels);
            result.StagedFileReadDiagnostics = CreateUnknownStagedFileReadDiagnostics(stagedFileLabels);
        }
        finally
        {
            if (impersonationToken != IntPtr.Zero) CloseHandle(impersonationToken);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    private static bool TryQuerySeChangeNotifyPrivilege(IntPtr token, out bool present, out bool enabled)
    {
        present = false;
        enabled = false;
        LUID targetPrivilege;
        if (!LookupPrivilegeValue(null, "SeChangeNotifyPrivilege", out targetPrivilege)) return false;

        uint requiredLength;
        if (GetTokenInformation(token, TokenPrivileges, IntPtr.Zero, 0, out requiredLength)) return false;
        if (Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER || requiredLength < sizeof(uint) ||
            requiredLength > 1048576U) return false;

        IntPtr information = IntPtr.Zero;
        try
        {
            information = Marshal.AllocHGlobal((int)requiredLength);
            uint returnedLength;
            if (!GetTokenInformation(token, TokenPrivileges, information, requiredLength, out returnedLength) ||
                returnedLength < sizeof(uint)) return false;

            uint privilegeCount = unchecked((uint)Marshal.ReadInt32(information));
            int entrySize = Marshal.SizeOf(typeof(LUID_AND_ATTRIBUTES));
            uint maxEntries = (returnedLength - sizeof(uint)) / (uint)entrySize;
            if (privilegeCount > maxEntries) return false;

            for (uint index = 0; index < privilegeCount; index++)
            {
                IntPtr entryAddress = IntPtr.Add(information, sizeof(uint) + unchecked((int)(index * (uint)entrySize)));
                LUID_AND_ATTRIBUTES entry = (LUID_AND_ATTRIBUTES)Marshal.PtrToStructure(
                    entryAddress, typeof(LUID_AND_ATTRIBUTES));
                if (entry.Luid.LowPart != targetPrivilege.LowPart || entry.Luid.HighPart != targetPrivilege.HighPart)
                    continue;
                present = true;
                enabled = (entry.Attributes & SE_PRIVILEGE_ENABLED) != 0;
                break;
            }
            return true;
        }
        catch { return false; }
        finally
        {
            if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
        }
    }

    private static bool TryCheckAccess(IntPtr impersonationToken, byte[] securityDescriptor,
        uint desiredAccess, out bool accessGranted)
    {
        accessGranted = false;
        if (securityDescriptor == null || securityDescriptor.Length < 20 || securityDescriptor.Length > 1048576)
            return false;

        IntPtr descriptor = IntPtr.Zero;
        IntPtr privilegeSet = IntPtr.Zero;
        try
        {
            descriptor = Marshal.AllocHGlobal(securityDescriptor.Length);
            Marshal.Copy(securityDescriptor, 0, descriptor, securityDescriptor.Length);
            GENERIC_MAPPING mapping = new GENERIC_MAPPING();
            mapping.GenericRead = 0x00120089;
            mapping.GenericWrite = 0x00120116;
            mapping.GenericExecute = 0x001200A0;
            mapping.GenericAll = 0x001F01FF;
            uint privilegeSetLength = 0;
            uint grantedAccess;
            bool accessStatus;
            bool checkedAccess = AccessCheck(descriptor, impersonationToken, desiredAccess, ref mapping,
                IntPtr.Zero, ref privilegeSetLength, out grantedAccess, out accessStatus);
            if (!checkedAccess)
            {
                if (Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER || privilegeSetLength == 0 ||
                    privilegeSetLength > 65536U) return false;
                privilegeSet = Marshal.AllocHGlobal((int)privilegeSetLength);
                checkedAccess = AccessCheck(descriptor, impersonationToken, desiredAccess, ref mapping,
                    privilegeSet, ref privilegeSetLength, out grantedAccess, out accessStatus);
            }
            if (!checkedAccess) return false;
            accessGranted = accessStatus && (grantedAccess & desiredAccess) == desiredAccess;
            return true;
        }
        catch { return false; }
        finally
        {
            if (privilegeSet != IntPtr.Zero) Marshal.FreeHGlobal(privilegeSet);
            if (descriptor != IntPtr.Zero) Marshal.FreeHGlobal(descriptor);
        }
    }

    private static DirectoryTraverseAccessDiagnostic[] CreateUnknownDirectoryTraverseDiagnostics(string[] labels)
    {
        int count = labels == null ? 0 : Math.Min(labels.Length, 512);
        DirectoryTraverseAccessDiagnostic[] diagnostics = new DirectoryTraverseAccessDiagnostic[count];
        for (int index = 0; index < count; index++)
        {
            diagnostics[index] = new DirectoryTraverseAccessDiagnostic();
            diagnostics[index].Label = SanitizeDirectoryDiagnosticLabel(labels[index]);
            diagnostics[index].Status = "UNKNOWN";
            diagnostics[index].ReadAttributesStatus = "UNKNOWN";
        }
        return diagnostics;
    }

    private static StagedFileReadDiagnostic[] CreateUnknownStagedFileReadDiagnostics(string[] labels)
    {
        int count = labels == null ? 0 : Math.Min(labels.Length, 8);
        StagedFileReadDiagnostic[] diagnostics = new StagedFileReadDiagnostic[count];
        for (int index = 0; index < count; index++)
        {
            diagnostics[index] = new StagedFileReadDiagnostic();
            diagnostics[index].Label = SanitizeStagedFileReadLabel(labels[index]);
            diagnostics[index].ReadAttributesStatus = "UNKNOWN";
            diagnostics[index].ReadDataStatus = "UNKNOWN";
        }
        return diagnostics;
    }

    private static string SanitizeStagedFileReadLabel(string label)
    {
        return label == "workerModule" || label == "probeContract" ? label : "unknown_file";
    }

    private static string SanitizeDirectoryDiagnosticLabel(string label)
    {
        if (label == "volume_root" || label == "runRoot" || label == "stageRoot" || label == "toolsRoot")
            return label;
        if (label == null || label.Length != 12 || !label.StartsWith("ancestor_", StringComparison.Ordinal))
            return "ancestor_unknown";
        for (int index = 9; index < label.Length; index++)
            if (label[index] < '0' || label[index] > '9') return "ancestor_unknown";
        return label;
    }

    private static void DrainPipe(
        IntPtr pipe,
        MemoryStream output,
        ref int capturedBytes,
        ref bool truncated,
        uint maxBytesThisCall = MAX_PIPE_DRAIN_PER_TICK,
        int maxCapturedBytes = MAX_CAPTURE_BYTES)
    {
        if (pipe == IntPtr.Zero) return;
        uint drained = 0;
        while (true)
        {
            if (drained >= maxBytesThisCall) return;
            uint available;
            if (!PeekNamedPipe(pipe, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero))
            {
                uint error = (uint)Marshal.GetLastWin32Error();
                if (error == ERROR_BROKEN_PIPE) return;
                throw CreateApiWin32Exception("PeekNamedPipe", "PeekNamedPipe failed", (int)error);
            }
            if (available == 0) return;
            uint request = Math.Min(Math.Min(available, 4096U), maxBytesThisCall - drained);
            byte[] buffer = new byte[(int)request];
            uint read;
            if (!ReadFile(pipe, buffer, request, out read, IntPtr.Zero))
            {
                uint error = (uint)Marshal.GetLastWin32Error();
                if (error == ERROR_BROKEN_PIPE) return;
                throw CreateApiWin32Exception("ReadFile", "ReadFile(pipe) failed", (int)error);
            }
            if (read == 0) return;
            drained += read;
            int remaining = Math.Max(0, maxCapturedBytes - capturedBytes);
            int toCapture = Math.Min(remaining, (int)read);
            if (toCapture > 0)
            {
                output.Write(buffer, 0, toCapture);
                capturedBytes += toCapture;
            }
            if (toCapture < read) truncated = true;
        }
    }

    private static IntPtr BuildEnvironment(string nodePath, string workspace, string profileName,
        string profileLocalAppData = null, bool createProfileDirectories = true)
    {
        if (String.IsNullOrWhiteSpace(workspace) || workspace.Length < 3 ||
            !((workspace[0] >= 'A' && workspace[0] <= 'Z') || (workspace[0] >= 'a' && workspace[0] <= 'z')) ||
            workspace[1] != ':' || (workspace[2] != '\\' && workspace[2] != '/'))
            throw new InvalidOperationException("Working directory must be a fully qualified local drive path.");

        string fullWorkspace = System.IO.Path.GetFullPath(workspace);
        string driveRoot = System.IO.Path.GetPathRoot(fullWorkspace);
        if (driveRoot == null || driveRoot.Length != 3 ||
            !((driveRoot[0] >= 'A' && driveRoot[0] <= 'Z') || (driveRoot[0] >= 'a' && driveRoot[0] <= 'z')) ||
            driveRoot[1] != ':' || driveRoot[2] != '\\')
            throw new InvalidOperationException("Working directory does not have a supported local drive root.");

        if (String.IsNullOrWhiteSpace(profileName) || profileName.Length != 24 ||
            !profileName.StartsWith("AgentCP", StringComparison.Ordinal))
            throw new InvalidOperationException("AppContainer profile name has an unsupported shape.");
        for (int index = 7; index < profileName.Length; index++)
        {
            char character = profileName[index];
            bool hex = (character >= '0' && character <= '9') ||
                (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F');
            if (!hex) throw new InvalidOperationException("AppContainer profile name has an unsupported shape.");
        }

        string root = Environment.GetEnvironmentVariable("SystemRoot");
        string nodeDirectory = System.IO.Path.GetDirectoryName(nodePath);
        string localAppData = String.IsNullOrEmpty(profileLocalAppData)
            ? System.IO.Path.Combine(fullWorkspace, "localappdata", "Packages", profileName, "AC")
            : System.IO.Path.GetFullPath(profileLocalAppData);
        string temporary = System.IO.Path.Combine(localAppData, "Temp");
        if (createProfileDirectories)
        {
            System.IO.Directory.CreateDirectory(localAppData);
            System.IO.Directory.CreateDirectory(temporary);
        }
        string[] entries = new string[] {
            "=" + driveRoot.Substring(0, 2) + "=" + fullWorkspace,
            "LOCALAPPDATA=" + localAppData,
            "PATH=" + nodeDirectory,
            "SystemRoot=" + root,
            "TEMP=" + temporary,
            "TMP=" + temporary,
            "WINDIR=" + root
        };
        Array.Sort(entries, StringComparer.OrdinalIgnoreCase);
        StringBuilder block = new StringBuilder();
        foreach (string entry in entries) block.Append(entry).Append('\0');
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static bool IsCanonicalAppContainerSidText(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length > MAX_LOOPBACK_CONFIG_INPUT_BYTES ||
            !value.StartsWith("S-1-15-2-", StringComparison.Ordinal)) return false;
        int components = 0;
        bool inDigits = false;
        for (int index = 9; index < value.Length; index++)
        {
            char character = value[index];
            if (character >= '0' && character <= '9') inDigits = true;
            else if (character == '-' && inDigits)
            {
                components++;
                inDigits = false;
            }
            else return false;
        }
        if (!inDigits || components > 14) return false;
        try
        {
            SecurityIdentifier sid = new SecurityIdentifier(value);
            return sid.BinaryLength >= 12 && sid.BinaryLength <= 68 &&
                String.Equals(sid.Value, value, StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private static string Quote(string value)
    {
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0) { quoted.Append('\\', backslashes); backslashes = 0; }
            quoted.Append(character);
        }
        if (backslashes > 0) quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static Exception LastError(string operation)
    {
        int nativeErrorCode = Marshal.GetLastWin32Error();
        return CreateApiWin32Exception(operation, operation + " failed", nativeErrorCode);
    }

    private static Win32Exception CreateApiWin32Exception(string operation, string message, int nativeErrorCode)
    {
        Win32Exception failure = new Win32Exception(nativeErrorCode, message);
        failure.Data["api_operation"] = operation;
        failure.Data["api_native_error_code"] = nativeErrorCode;
        return failure;
    }
}
