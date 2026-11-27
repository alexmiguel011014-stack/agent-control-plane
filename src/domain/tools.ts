/** New declarations identify a trusted host harness; node-test is legacy-only. */
export const DECLARED_TEST_PROFILES = ['host-json-v1'] as const;
export type DeclaredTestProfile = (typeof DECLARED_TEST_PROFILES)[number];
export const DECLARED_TEST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const DECLARED_TEST_BLOCKED_NAMES = new Set([
  '.git', '.agentctl', '.ssh', '.aws', '.venv', 'node_modules', '.npmrc', '.pypirc', '.netrc',
  'credentials', 'secrets', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
]);
const DECLARED_TEST_PRIVATE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.ppk']);
const WINDOWS_DEVICE_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

/** Safe concrete POSIX-relative path syntax for a declared test file. */
export function isSafeDeclaredTestPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024
    || value.includes('\\') || value.includes(':') || /[\u0000-\u001f\u007f<>"|?*]/.test(value)
    || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  return value.split('/').every((segment) => {
    if (segment.length === 0 || segment.length > 255 || segment === '.' || segment === '..'
      || segment.startsWith(' ') || segment.endsWith(' ') || segment.endsWith('.')) return false;
    const lower = segment.toLowerCase();
    const lastDot = lower.lastIndexOf('.');
    const firstDot = lower.indexOf('.');
    const extension = lastDot < 0 ? '' : lower.slice(lastDot);
    const basenameBeforeFirstDot = firstDot > 0 ? lower.slice(0, firstDot) : lower;
    return !lower.startsWith('.env')
      && !DECLARED_TEST_BLOCKED_NAMES.has(lower)
      && !DECLARED_TEST_BLOCKED_NAMES.has(basenameBeforeFirstDot)
      && !DECLARED_TEST_PRIVATE_EXTENSIONS.has(extension)
      && !/^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/i.test(segment)
      && !WINDOWS_DEVICE_SEGMENT_PATTERN.test(segment);
  });
}

export interface HostHarnessTestV1 {
  readonly id: string;
  readonly profile: 'host-json-v1';
}

/** Read-compatible legacy declaration; this path is never executed as a test. */
export interface LegacyWorkspaceTestV1 {
  readonly id: string;
  readonly profile: 'node-test';
  readonly path: string;
}

export type DeclaredTestV1 = HostHarnessTestV1 | LegacyWorkspaceTestV1;

export function isLegacyWorkspaceTest(test: DeclaredTestV1): test is LegacyWorkspaceTestV1 {
  return test.profile === 'node-test';
}

export const TOOL_OPERATIONS = [
  'read_text',
  'list_files',
  'apply_unified_diff',
  'run_declared_test',
  'git_diff',
] as const;
export type ToolOperationName = (typeof TOOL_OPERATIONS)[number];

/** Untrusted structured input from an agent; gateway parsing remains mandatory. */
export type ToolRequest =
  | Readonly<{ operation: 'read_text'; path: string }>
  | Readonly<{ operation: 'list_files'; path?: string }>
  | Readonly<{ operation: 'apply_unified_diff'; diff: string }>
  | Readonly<{ operation: 'run_declared_test'; testId: string }>
  | Readonly<{ operation: 'git_diff'; paths?: readonly string[] }>;

export interface UnifiedDiffFilePlan {
  readonly path: string;
  readonly mode: 'create' | 'modify';
  readonly hunkLines: readonly string[];
}

export interface UnifiedDiffPlan {
  readonly files: readonly UnifiedDiffFilePlan[];
  readonly changedPaths: readonly string[];
}

export type ToolResponse =
  | Readonly<{ operation: 'read_text'; path: string; text: string }>
  | Readonly<{ operation: 'list_files'; paths: readonly string[] }>
  | Readonly<{ operation: 'apply_unified_diff'; changedPaths: readonly string[] }>
  | Readonly<{ operation: 'run_declared_test'; testId: string; outcome: 'PASS' | 'FAIL' }>
  | Readonly<{ operation: 'git_diff'; diff: string }>;

export const TOOL_REQUEST_LIMITS = Object.freeze({
  maxRequests: 32,
  maxPathLength: 1024,
  maxListedFiles: 10_000,
  maxDeclaredTests: 32,
  maxTestIdLength: 64,
  maxDiffBytes: 1_048_576,
  maxDiffFiles: 64,
  maxDiffLines: 20_000,
  maxReadBytes: 1_048_576,
  maxDiffOutputBytes: 1_048_576,
  maxDiffFileBytes: 262_144,
  declaredTestTimeoutMs: 60_000,
});
