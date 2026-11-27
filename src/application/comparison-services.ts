import { createHash } from 'node:crypto';

/**
 * Provider-neutral comparison package (G3.3). The package is an immutable description of one
 * benchmark task; an engineer solves it manually in an official client, and only the resulting
 * patch and log come back. Nothing here talks to a provider, holds a credential, or runs code.
 */

export type ComparisonServiceErrorCode =
  | 'unknown_task'
  | 'package_invalid'
  | 'base_snapshot_mismatch'
  | 'patch_missing'
  | 'log_missing'
  | 'patch_outside_allowlist'
  | 'secret_detected'
  | 'file_unavailable';

export class ComparisonServiceError extends Error {
  readonly code: ComparisonServiceErrorCode;

  constructor(code: ComparisonServiceErrorCode) {
    super(code);
    this.name = 'ComparisonServiceError';
    this.code = code;
  }
}

export interface ComparisonTask {
  readonly taskId: string;
  readonly prompt: string;
  readonly allowedPaths: readonly string[];
  readonly baseSnapshotSha256: string;
  readonly timeoutMs: number;
  readonly publicTestCommandId: string;
}

export interface ComparisonTaskSourcePort {
  /** Resolves the current catalog task, or null when the catalog has no such task. */
  getTask(taskId: string): Promise<ComparisonTask | null>;
}

export interface ComparisonFilePort {
  /** Resolves null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  /** Creates a new file; rejects when it already exists. */
  writeNewText(path: string, text: string): Promise<void>;
}

export interface ComparisonPackageV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly prompt: string;
  readonly baseSnapshotSha256: string;
  readonly allowedPaths: readonly string[];
  readonly timeoutMs: number;
  readonly publicTestCommandId: string;
  readonly patchSubmissionFormat: 'unified-diff-git-relative-paths';
  readonly packageSha256: string;
}

export interface ComparisonImportRecordV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly packageSha256: string;
  readonly baseSnapshotSha256: string;
  readonly patchSha256: string;
  readonly logSha256: string;
  readonly changedPaths: readonly string[];
  readonly evaluatorStatus: 'pending';
  readonly providerCost: 'unobservable_by_control_plane';
}

export interface ComparisonApplicationServices {
  exportPackage(request: Readonly<{ taskId: string; outputPath: string }>): Promise<Readonly<{ taskId: string; outputPath: string; packageSha256: string }>>;
  importArtifacts(request: Readonly<{ packagePath: string; patchPath: string; logPath: string }>): Promise<Readonly<{ recordPath: string; record: ComparisonImportRecordV1 }>>;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /\b(?:api[_-]?key|secret|token|passw(?:or)?d)\b\s*[:=]\s*['"]?[^\s'"]{8,}/i,
]);

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function packageBody(pkg: Omit<ComparisonPackageV1, 'packageSha256'>): string {
  return JSON.stringify({
    schemaVersion: pkg.schemaVersion,
    taskId: pkg.taskId,
    prompt: pkg.prompt,
    baseSnapshotSha256: pkg.baseSnapshotSha256,
    allowedPaths: pkg.allowedPaths,
    timeoutMs: pkg.timeoutMs,
    publicTestCommandId: pkg.publicTestCommandId,
    patchSubmissionFormat: pkg.patchSubmissionFormat,
  });
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Paths a unified diff touches; null when it deletes or creates a file, uses an unsafe path, or names none. */
export function patchTargetPaths(patch: string): readonly string[] | null {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    const header = /^(?:\+\+\+|---) (.+?)\r?$/.exec(line);
    if (!header) continue;
    const raw = header[1]!;
    if (raw === '/dev/null') return null;
    const match = /^[ab]\/(.+)$/.exec(raw);
    if (!match) return null;
    const target = match[1]!;
    if (target.startsWith('/') || /^[A-Za-z]:/.test(target) || target.split('/').some((part) => part === '..' || part === '')) return null;
    paths.add(target);
  }
  return paths.size === 0 ? null : [...paths].sort();
}

function parsePackage(text: string | null): ComparisonPackageV1 {
  if (text === null) throw new ComparisonServiceError('package_invalid');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ComparisonServiceError('package_invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ComparisonServiceError('package_invalid');
  const v = value as Record<string, unknown>;
  const ok = v.schemaVersion === 1
    && typeof v.taskId === 'string' && /^[A-Z][0-9]{2}$/.test(v.taskId)
    && typeof v.prompt === 'string' && v.prompt.length > 0
    && typeof v.baseSnapshotSha256 === 'string' && HASH_PATTERN.test(v.baseSnapshotSha256)
    && Array.isArray(v.allowedPaths) && v.allowedPaths.every((p) => typeof p === 'string')
    && typeof v.timeoutMs === 'number' && Number.isInteger(v.timeoutMs) && v.timeoutMs > 0
    && typeof v.publicTestCommandId === 'string' && v.publicTestCommandId.length > 0
    && v.patchSubmissionFormat === 'unified-diff-git-relative-paths'
    && typeof v.packageSha256 === 'string' && HASH_PATTERN.test(v.packageSha256);
  if (!ok) throw new ComparisonServiceError('package_invalid');
  const pkg = v as unknown as ComparisonPackageV1;
  if (sha256(packageBody(pkg)) !== pkg.packageSha256) throw new ComparisonServiceError('package_invalid');
  return Object.freeze(pkg);
}

export function createComparisonServices(deps: Readonly<{
  tasks: ComparisonTaskSourcePort;
  files: ComparisonFilePort;
  recordDirectory: string;
}>): ComparisonApplicationServices {
  const services: ComparisonApplicationServices = {
    async exportPackage({ taskId, outputPath }) {
      const task = await deps.tasks.getTask(taskId);
      if (!task) throw new ComparisonServiceError('unknown_task');
      if (containsSecret(task.prompt)) throw new ComparisonServiceError('secret_detected');
      const body = {
        schemaVersion: 1 as const,
        taskId: task.taskId,
        prompt: task.prompt,
        baseSnapshotSha256: task.baseSnapshotSha256,
        allowedPaths: Object.freeze([...task.allowedPaths]),
        timeoutMs: task.timeoutMs,
        publicTestCommandId: task.publicTestCommandId,
        patchSubmissionFormat: 'unified-diff-git-relative-paths' as const,
      };
      const packageSha256 = sha256(packageBody(body));
      try {
        await deps.files.writeNewText(outputPath, `${JSON.stringify({ ...body, packageSha256 }, null, 2)}\n`);
      } catch {
        throw new ComparisonServiceError('file_unavailable');
      }
      return Object.freeze({ taskId: task.taskId, outputPath, packageSha256 });
    },

    async importArtifacts({ packagePath, patchPath, logPath }) {
      let packageText: string | null;
      try {
        packageText = await deps.files.readText(packagePath);
      } catch {
        throw new ComparisonServiceError('file_unavailable');
      }
      const pkg = parsePackage(packageText);
      const current = await deps.tasks.getTask(pkg.taskId);
      if (!current) throw new ComparisonServiceError('unknown_task');
      if (current.baseSnapshotSha256 !== pkg.baseSnapshotSha256) throw new ComparisonServiceError('base_snapshot_mismatch');

      let patch: string | null;
      let log: string | null;
      try {
        patch = await deps.files.readText(patchPath);
        log = await deps.files.readText(logPath);
      } catch {
        throw new ComparisonServiceError('file_unavailable');
      }
      if (patch === null || patch.trim().length === 0) throw new ComparisonServiceError('patch_missing');
      if (log === null || log.trim().length === 0) throw new ComparisonServiceError('log_missing');
      if (containsSecret(patch) || containsSecret(log)) throw new ComparisonServiceError('secret_detected');
      const changed = patchTargetPaths(patch);
      const matchers = current.allowedPaths.map(globToRegExp);
      if (changed === null || !changed.every((path) => matchers.some((matcher) => matcher.test(path)))) {
        throw new ComparisonServiceError('patch_outside_allowlist');
      }

      const record: ComparisonImportRecordV1 = Object.freeze({
        schemaVersion: 1 as const,
        taskId: pkg.taskId,
        packageSha256: pkg.packageSha256,
        baseSnapshotSha256: pkg.baseSnapshotSha256,
        patchSha256: sha256(patch),
        logSha256: sha256(log),
        changedPaths: Object.freeze([...changed]),
        evaluatorStatus: 'pending' as const,
        providerCost: 'unobservable_by_control_plane' as const,
      });
      const recordPath = `${deps.recordDirectory}/${pkg.taskId.toLowerCase()}-${record.patchSha256.slice(0, 12)}.json`;
      try {
        await deps.files.writeNewText(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      } catch {
        throw new ComparisonServiceError('file_unavailable');
      }
      return Object.freeze({ recordPath, record });
    },
  };
  return Object.freeze(services);
}
