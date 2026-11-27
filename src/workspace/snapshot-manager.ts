import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, opendir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSnapshotInventory, restoreSnapshot, snapshotId, type SnapshotManifestV1 } from '../snapshots/snapshot-core.mjs';
import { assertSnapshotPath } from '../snapshots/snapshot-core.mjs';
import { isLegacyWorkspaceTest, TOOL_REQUEST_LIMITS, type UnifiedDiffPlan } from '../domain/tools.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import type {
  UnifiedDiffApplicationPort,
  WorkspaceAllocationPort,
  WorkspaceIntegrityPhase,
  WorkspaceIntegrityPort,
  WorkspaceIntegrityResult,
  WorkspacePathAccessPort,
  WorkspacePathOperation,
  WorkspacePathReference,
  WorkspaceReference,
} from '../application/ports/index.ts';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PATH_OPERATIONS = new Set<WorkspacePathOperation>(['read', 'write', 'list', 'diff']);

interface ResolvedSnapshot {
  readonly snapshotSha256: string;
  readonly manifest: SnapshotManifestV1;
  readonly baseDirectory: string;
}

export interface SnapshotWorkspaceSource {
  resolve(snapshotSha256: string): Promise<ResolvedSnapshot | null>;
  restore(snapshotSha256: string, destinationDirectory: string): Promise<ResolvedSnapshot>;
}

interface WorkspaceRecord {
  readonly workspaceId: string;
  readonly directory: string;
  readonly snapshotSha256: string;
  readonly baseline: SnapshotManifestV1;
  readonly baselineDirectory: string;
  readonly allowedPaths: readonly string[];
  readonly legacyTestPaths: readonly string[];
  readonly workspaceRelativePath: string;
  afterTools?: SnapshotManifestV1;
}

interface AuditRecord {
  readonly taskId: string;
  readonly executionId: string;
  readonly snapshotSha256: string;
  readonly workspaceRelativePath: string;
  readonly baselineSha256: string;
  readonly phase: 'allocation' | 'before_run' | WorkspaceIntegrityPhase | 'apply_unified_diff' | 'export';
  readonly result: 'started' | 'allow' | 'deny';
  readonly modifiedPaths: readonly string[];
}

export type WorkspacePatchErrorCode =
  | 'invalid_plan'
  | 'path_set_mismatch'
  | 'path_denied'
  | 'target_missing'
  | 'target_exists'
  | 'unsupported_text_format'
  | 'hunk_mismatch'
  | 'file_too_large'
  | 'write_failed';

/** Typed refusal from `apply`; the message is the code and never contains host paths or file text. */
export class WorkspacePatchError extends Error {
  readonly code: WorkspacePatchErrorCode;

  constructor(code: WorkspacePatchErrorCode) {
    super(code);
    this.name = 'WorkspacePatchError';
    this.code = code;
  }
}

export type WorkspaceExportErrorCode =
  | 'destination_invalid'
  | 'destination_not_empty'
  | 'inventory_failed'
  | 'copy_failed'
  | 'verification_failed';

/** Typed refusal from `exportWorkspace`; the message is the code and never contains host paths. */
export class WorkspaceExportError extends Error {
  readonly code: WorkspaceExportErrorCode;

  constructor(code: WorkspaceExportErrorCode) {
    super(code);
    this.name = 'WorkspaceExportError';
    this.code = code;
  }
}

interface PreparedFileWrite {
  readonly relativePath: string;
  readonly mode: 'create' | 'modify';
  readonly absolutePath: string;
  readonly before: string | null;
  readonly after: string;
}

/** Local disposable workspace adapter. Its path checks are workflow controls, not an OS sandbox. */
export class SnapshotWorkspaceManager implements WorkspaceAllocationPort, WorkspaceIntegrityPort, WorkspacePathAccessPort, UnifiedDiffApplicationPort {
  readonly #stateDirectory: string;
  readonly #workspaceDirectory: string;
  readonly #auditDirectory: string;
  readonly #snapshots: SnapshotWorkspaceSource;
  readonly #workspaces = new Map<string, WorkspaceRecord>();

  constructor(input: { readonly stateDirectory: string; readonly snapshots: SnapshotWorkspaceSource }) {
    this.#stateDirectory = path.resolve(input.stateDirectory);
    this.#workspaceDirectory = path.join(this.#stateDirectory, 'workspaces');
    this.#auditDirectory = path.join(this.#stateDirectory, 'workspace-audit');
    this.#snapshots = input.snapshots;
  }

  async allocate(envelope: TaskEnvelopeV1, executionId: string): Promise<WorkspaceReference> {
    if (!HASH_PATTERN.test(envelope.baseSnapshotSha256)) throw new Error('workspace_snapshot_invalid');
    const workspaceId = randomUUID();
    const workspaceRelativePath = `workspaces/${workspaceId}`;
    await this.#auditAllocation(envelope.taskId, executionId, envelope.baseSnapshotSha256, workspaceRelativePath, 'started');
    let workspace: WorkspaceRecord | undefined;
    try {
      const snapshot = await this.#snapshots.resolve(envelope.baseSnapshotSha256);
      if (!snapshot || snapshot.snapshotSha256 !== envelope.baseSnapshotSha256
        || snapshotId(snapshot.manifest) !== envelope.baseSnapshotSha256) {
        throw new Error('workspace_snapshot_unavailable');
      }

      await this.#ensureOrdinaryDirectory(this.#workspaceDirectory);
      const directory = path.join(this.#workspaceDirectory, workspaceId);
      const restored = await this.#snapshots.restore(envelope.baseSnapshotSha256, directory);
      if (restored.snapshotSha256 !== envelope.baseSnapshotSha256) throw new Error('workspace_snapshot_mismatch');
      const verified = await createSnapshotInventory(directory);
      if (snapshotId(verified.manifest) !== envelope.baseSnapshotSha256) throw new Error('workspace_restore_mismatch');

      workspace = {
        workspaceId,
        directory,
        snapshotSha256: envelope.baseSnapshotSha256,
        baseline: verified.manifest,
        baselineDirectory: snapshot.baseDirectory,
        allowedPaths: Object.freeze([...envelope.allowedPaths]),
        legacyTestPaths: Object.freeze(envelope.declaredTests.flatMap((test) => (
          isLegacyWorkspaceTest(test) ? [test.path.toLowerCase()] : []
        ))),
        workspaceRelativePath,
      };
      await this.#auditAllocation(envelope.taskId, executionId, envelope.baseSnapshotSha256, workspaceRelativePath, 'allow');
      this.#workspaces.set(workspaceId, workspace);
    } catch {
      try {
        await this.#auditAllocation(envelope.taskId, executionId, envelope.baseSnapshotSha256, workspaceRelativePath, 'deny');
      } catch {
        // The initial allocation record remains the evidence that restoration began.
      }
      throw new Error('workspace_allocation_failed');
    }
    return Object.freeze({ workspaceId });
  }

  async verifyBeforeRun(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
    readonly executionId: string;
  }): Promise<WorkspaceIntegrityResult> {
    const record = this.#record(input.workspace);
    let result: WorkspaceIntegrityResult;
    try {
      if (record.snapshotSha256 !== input.envelope.baseSnapshotSha256) throw new Error('workspace_snapshot_mismatch');
      const current = await this.#inventory(record);
      const changedPaths = changedFiles(record.baseline, current);
      result = changedPaths.length === 0
        ? Object.freeze({ outcome: 'allow', changedPaths })
        : Object.freeze({ outcome: 'deny', reasonCode: 'workspace_baseline_changed', changedPaths });
    } catch {
      result = Object.freeze({ outcome: 'deny', reasonCode: 'workspace_integrity_check_failed', changedPaths: Object.freeze([]) });
    }
    await this.#audit(input.envelope.taskId, input.executionId, record, 'before_run', result);
    return result;
  }

  async verifyAfterPhase(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly workspace: WorkspaceReference;
    readonly executionId: string;
    readonly phase: WorkspaceIntegrityPhase;
  }): Promise<WorkspaceIntegrityResult> {
    const record = this.#record(input.workspace);
    let result: WorkspaceIntegrityResult;
    try {
      if (record.snapshotSha256 !== input.envelope.baseSnapshotSha256) throw new Error('workspace_snapshot_mismatch');
      const current = await this.#inventory(record);
      const totalChanges = changedFiles(record.baseline, current);
      if (input.phase === 'after_tools') {
        const deletedPaths = new Set(deletedFiles(record.baseline, current));
        const denied = totalChanges.some((relativePath) => (
          !matchesAny(relativePath, input.envelope.allowedPaths)
          || !input.envelope.requestedOperations.includes('write')
          || deletedPaths.has(relativePath)
          || isDeclaredTestPath(input.envelope, relativePath)
        ));
        record.afterTools = current;
        result = denied
          ? Object.freeze({ outcome: 'deny', reasonCode: 'workspace_change_outside_policy', changedPaths: Object.freeze(totalChanges) })
          : Object.freeze({ outcome: 'allow', changedPaths: Object.freeze(totalChanges) });
      } else {
        const reference = record.afterTools ?? record.baseline;
        const phaseChanges = changedFiles(reference, current);
        result = phaseChanges.length > 0
          ? Object.freeze({ outcome: 'deny', reasonCode: 'workspace_changed_after_tools', changedPaths: Object.freeze(totalChanges) })
          : Object.freeze({ outcome: 'allow', changedPaths: Object.freeze(totalChanges) });
      }
    } catch {
      result = Object.freeze({ outcome: 'deny', reasonCode: 'workspace_integrity_check_failed', changedPaths: Object.freeze([]) });
    }
    await this.#audit(input.envelope.taskId, input.executionId, record, input.phase, result);
    return result;
  }

  async listAllowed(input: {
    readonly workspace: WorkspaceReference;
    readonly allowedPatterns: readonly string[];
    readonly maxResults: number;
    readonly prefix?: string;
  }): Promise<readonly string[]> {
    if (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 10_000) {
      throw new Error('workspace_list_limit_invalid');
    }
    const record = this.#record(input.workspace);
    await this.#assertWorkspaceRoot(record);
    const paths: string[] = [];
    let listingDirectory = record.directory;
    let listingParent = '';
    if (input.prefix !== undefined) {
      assertSnapshotPath(input.prefix);
      if (input.prefix.includes('*')) throw new Error('workspace_list_prefix_invalid');
      const prefixTarget = await this.#resolveListingPrefix(record, input.prefix);
      if (prefixTarget === null) return Object.freeze([]);
      if (prefixTarget.kind === 'file') {
        return Object.freeze(matchesAny(input.prefix, input.allowedPatterns) ? [input.prefix] : []);
      }
      listingDirectory = prefixTarget.directory;
      listingParent = input.prefix;
    }
    await this.#visitForListing(listingDirectory, listingParent, paths, input.allowedPatterns, input.maxResults + 1);
    return Object.freeze(paths.sort(comparePaths));
  }

  async resolveAllowed(input: {
    readonly workspace: WorkspaceReference;
    readonly relativePath: string;
    readonly operation: WorkspacePathOperation;
    readonly allowedPatterns: readonly string[];
  }): Promise<WorkspacePathReference | null> {
    if (!PATH_OPERATIONS.has(input.operation)) return null;
    const record = this.#record(input.workspace);
    const relativePath = input.relativePath;
    try {
      assertSnapshotPath(relativePath);
      if (relativePath.includes('*') || !matchesAny(relativePath, input.allowedPatterns)) return null;
      const lowerPath = relativePath.toLowerCase();
      if (input.operation === 'write' && record.legacyTestPaths.includes(lowerPath)) return null;
      await this.#inspectConcretePath(record, relativePath, input.operation);
      return Object.freeze({ relativePath, token: randomUUID() });
    } catch {
      return null;
    }
  }

  async readText(input: {
    readonly workspace: WorkspaceReference;
    readonly relativePath: string;
    readonly allowedPatterns: readonly string[];
    readonly maxBytes: number;
  }): Promise<string> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 1_048_576) {
      throw new Error('workspace_read_limit_invalid');
    }
    const record = this.#record(input.workspace);
    const reference = await this.resolveAllowed({
      workspace: input.workspace,
      relativePath: input.relativePath,
      operation: 'read',
      allowedPatterns: input.allowedPatterns,
    });
    if (!reference) throw new Error('workspace_path_denied');
    await this.#inspectConcretePath(record, reference.relativePath, 'read');
    return readSafeWorkspaceText(record.directory, reference.relativePath, input.maxBytes);
  }

  async gitDiff(input: {
    readonly workspace: WorkspaceReference;
    readonly allowedPatterns: readonly string[];
    readonly relativePaths?: readonly string[];
    readonly maxOutputBytes: number;
  }): Promise<string> {
    if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > 1_048_576) {
      throw new Error('workspace_diff_limit_invalid');
    }
    const record = this.#record(input.workspace);
    await this.#assertWorkspaceRoot(record);
    const current = await this.#inventory(record);
    const baseline = await createSnapshotInventory(record.baselineDirectory);
    if (snapshotId(baseline.manifest) !== record.snapshotSha256) throw new Error('workspace_snapshot_mismatch');

    let requestedPaths: Set<string> | undefined;
    if (input.relativePaths !== undefined) {
      if (!Array.isArray(input.relativePaths) || input.relativePaths.length > 64) throw new Error('workspace_diff_paths_invalid');
      requestedPaths = new Set();
      for (const relativePath of input.relativePaths) {
        assertSnapshotPath(relativePath);
        if (!matchesAny(relativePath, input.allowedPatterns) || requestedPaths.has(relativePath)) {
          throw new Error('workspace_path_denied');
        }
        requestedPaths.add(relativePath);
      }
    }

    const changed = changedFiles(baseline.manifest, current);
    const paths = requestedPaths === undefined
      ? changed
      : changed.filter((relativePath) => requestedPaths!.has(relativePath));
    const output: string[] = [];
    let outputBytes = 0;
    for (const relativePath of paths) {
      assertSnapshotPath(relativePath);
      if (!matchesAny(relativePath, input.allowedPatterns)) continue;
      await this.#inspectConcretePath(record, relativePath, 'diff');
      const beforeFile = baseline.manifest.files.find((file) => file.path === relativePath);
      const afterFile = current.files.find((file) => file.path === relativePath);
      const before = beforeFile ? await readSafeWorkspaceText(record.baselineDirectory, relativePath, 262_144) : null;
      const after = afterFile ? await readSafeWorkspaceText(record.directory, relativePath, 262_144) : null;
      const section = formatWholeFileDiff(relativePath, before, after);
      const sectionBytes = Buffer.byteLength(section, 'utf8');
      outputBytes += sectionBytes;
      if (outputBytes > input.maxOutputBytes) throw new Error('workspace_diff_output_too_large');
      output.push(section);
    }
    return output.join('');
  }

  /**
   * Applies a gateway-parsed unified-diff plan. Every path is re-checked with the manager's own
   * write inspection, every hunk is checked against the current text, and all new texts are
   * computed before any file is written. Writes use a same-directory temp file and a rename.
   */
  async apply(input: {
    readonly workspace: WorkspaceReference;
    readonly plan: UnifiedDiffPlan;
    readonly paths: readonly WorkspacePathReference[];
  }): Promise<void> {
    const record = this.#record(input.workspace);
    let auditedPaths: readonly string[] = Object.freeze([]);
    try {
      const files = validatePatchInput(input.plan, input.paths);
      auditedPaths = Object.freeze(files.map((file) => file.path));
      const prepared: PreparedFileWrite[] = [];
      for (const file of files) prepared.push(await this.#preparePatchedFile(record, file));
      await this.#commitPatchedFiles(record, prepared);
    } catch (error) {
      const refusal = error instanceof WorkspacePatchError ? error : new WorkspacePatchError('write_failed');
      await this.#audit('', '', record, 'apply_unified_diff', Object.freeze({
        outcome: 'deny',
        reasonCode: `workspace_patch_${refusal.code}`,
        changedPaths: auditedPaths,
      }));
      throw refusal;
    }
    await this.#audit('', '', record, 'apply_unified_diff', Object.freeze({ outcome: 'allow', changedPaths: auditedPaths }));
  }

  /**
   * Copies the verified workspace tree (regular files only) into an absolute, existing, empty,
   * ordinary directory created by trusted host code, then verifies the copy manifest.
   */
  async exportWorkspace(workspace: WorkspaceReference, destinationDirectory: string): Promise<void> {
    const record = this.#record(workspace);
    let changedPaths: readonly string[] = Object.freeze([]);
    try {
      if (typeof destinationDirectory !== 'string' || !path.isAbsolute(destinationDirectory)) {
        throw new WorkspaceExportError('destination_invalid');
      }
      const destination = path.resolve(destinationDirectory);
      if (isWithin(this.#workspaceDirectory, destination) || isWithin(destination, this.#workspaceDirectory)) {
        throw new WorkspaceExportError('destination_invalid');
      }
      const info = await lstat(destination).catch(() => {
        throw new WorkspaceExportError('destination_invalid');
      });
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceExportError('destination_invalid');
      let resolved: string;
      try {
        resolved = await realpath(destination);
      } catch {
        throw new WorkspaceExportError('destination_invalid');
      }
      if (!samePath(resolved, destination)) throw new WorkspaceExportError('destination_invalid');
      if ((await readdir(destination)).length !== 0) throw new WorkspaceExportError('destination_not_empty');

      let manifest: SnapshotManifestV1;
      try {
        manifest = await this.#inventory(record);
      } catch {
        throw new WorkspaceExportError('inventory_failed');
      }
      changedPaths = Object.freeze(changedFiles(record.baseline, manifest));
      try {
        await restoreSnapshot(record.directory, manifest, destination);
      } catch {
        throw new WorkspaceExportError('copy_failed');
      }
      let copied: SnapshotManifestV1;
      try {
        copied = (await createSnapshotInventory(destination)).manifest;
      } catch {
        throw new WorkspaceExportError('verification_failed');
      }
      if (snapshotId(copied) !== snapshotId(manifest)) throw new WorkspaceExportError('verification_failed');
    } catch (error) {
      const refusal = error instanceof WorkspaceExportError ? error : new WorkspaceExportError('copy_failed');
      await this.#audit('', '', record, 'export', Object.freeze({
        outcome: 'deny',
        reasonCode: `workspace_export_${refusal.code}`,
        changedPaths,
      }));
      throw refusal;
    }
    await this.#audit('', '', record, 'export', Object.freeze({ outcome: 'allow', changedPaths }));
  }

  async #preparePatchedFile(
    record: WorkspaceRecord,
    file: UnifiedDiffPlan['files'][number],
  ): Promise<PreparedFileWrite> {
    const relativePath = file.path;
    try {
      assertSnapshotPath(relativePath);
    } catch {
      throw new WorkspacePatchError('path_denied');
    }
    if (relativePath.includes('*') || !matchesAny(relativePath, record.allowedPaths)
      || record.legacyTestPaths.includes(relativePath.toLowerCase())) {
      throw new WorkspacePatchError('path_denied');
    }
    try {
      await this.#inspectConcretePath(record, relativePath, 'write');
    } catch {
      throw new WorkspacePatchError('path_denied');
    }
    const absolutePath = path.join(record.directory, ...relativePath.split('/'));
    const existing = await lstatOrNull(absolutePath);
    if (file.mode === 'create') {
      if (existing !== null) throw new WorkspacePatchError('target_exists');
      const after = applyHunks([], file.hunkLines, true);
      return Object.freeze({ relativePath, mode: 'create', absolutePath, before: null, after });
    }
    if (existing === null) throw new WorkspacePatchError('target_missing');
    if (existing.size > TOOL_REQUEST_LIMITS.maxDiffFileBytes) throw new WorkspacePatchError('file_too_large');
    const before = await this.#readPatchTarget(record, relativePath);
    const after = applyHunks(textToLines(before), file.hunkLines, false);
    return Object.freeze({ relativePath, mode: 'modify', absolutePath, before, after });
  }

  async #readPatchTarget(record: WorkspaceRecord, relativePath: string): Promise<string> {
    let text: string;
    try {
      text = await readSafeWorkspaceText(record.directory, relativePath, TOOL_REQUEST_LIMITS.maxDiffFileBytes);
    } catch (error) {
      const message = (error as Error).message;
      if (message === 'workspace_file_too_large_or_unsupported' || message === 'workspace_file_encoding_unsupported') {
        throw new WorkspacePatchError('unsupported_text_format');
      }
      throw new WorkspacePatchError('path_denied');
    }
    if (text.includes('\r') || (text.length > 0 && !text.endsWith('\n'))) {
      throw new WorkspacePatchError('unsupported_text_format');
    }
    return text;
  }

  async #commitPatchedFiles(record: WorkspaceRecord, prepared: readonly PreparedFileWrite[]): Promise<void> {
    const temporaryFiles: string[] = [];
    const staged: { readonly file: PreparedFileWrite; readonly temporaryFile: string }[] = [];
    const committed: PreparedFileWrite[] = [];
    try {
      for (const file of prepared) {
        const temporaryFile = path.join(path.dirname(file.absolutePath), `.apply-${randomUUID()}.tmp`);
        temporaryFiles.push(temporaryFile);
        await writeFile(temporaryFile, file.after, { encoding: 'utf8', flag: 'wx' });
        staged.push({ file, temporaryFile });
      }
      for (const { file, temporaryFile } of staged) {
        try {
          await this.#inspectConcretePath(record, file.relativePath, 'write');
        } catch {
          throw new WorkspacePatchError('path_denied');
        }
        if (file.mode === 'create') {
          if (await lstatOrNull(file.absolutePath) !== null) throw new WorkspacePatchError('target_exists');
        } else if (await this.#readPatchTarget(record, file.relativePath) !== file.before) {
          throw new WorkspacePatchError('hunk_mismatch');
        }
        await rename(temporaryFile, file.absolutePath);
        committed.push(file);
      }
    } catch (error) {
      for (const file of committed.reverse()) {
        try {
          if (file.before === null) {
            await rm(file.absolutePath, { force: true });
          } else {
            const restoreFile = path.join(path.dirname(file.absolutePath), `.apply-${randomUUID()}.tmp`);
            temporaryFiles.push(restoreFile);
            await writeFile(restoreFile, file.before, { encoding: 'utf8', flag: 'wx' });
            await rename(restoreFile, file.absolutePath);
          }
        } catch {
          // Best effort; the after_tools integrity check still reports any residual change.
        }
      }
      for (const temporaryFile of temporaryFiles) {
        try {
          await rm(temporaryFile, { force: true });
        } catch {
          // A remaining temp file is reported by the next inventory check.
        }
      }
      throw error instanceof WorkspacePatchError ? error : new WorkspacePatchError('write_failed');
    }
  }

  async #visitForListing(
    directory: string,
    parent: string,
    paths: string[],
    allowedPatterns: readonly string[],
    maxResultsPlusOne: number,
  ): Promise<void> {
    if (paths.length >= maxResultsPlusOne) return;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (paths.length >= maxResultsPlusOne) return;
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error('workspace_reparse_point');
      let safe = true;
      try {
        assertSnapshotPath(relativePath);
      } catch {
        safe = false;
      }
      const resolved = await realpath(absolutePath);
      if (!samePath(resolved, absolutePath)) throw new Error('workspace_path_redirected');
      if (!safe) continue;
      if (info.isDirectory()) {
        await this.#visitForListing(absolutePath, relativePath, paths, allowedPatterns, maxResultsPlusOne);
      } else if (info.isFile() && matchesAny(relativePath, allowedPatterns)) {
        paths.push(relativePath);
        if (paths.length >= maxResultsPlusOne) return;
      } else if (!info.isFile()) throw new Error('workspace_entry_unsupported');
    }
  }

  async #resolveListingPrefix(
    record: WorkspaceRecord,
    relativePath: string,
  ): Promise<{ readonly kind: 'directory'; readonly directory: string } | { readonly kind: 'file' } | null> {
    let current = record.directory;
    const parts = relativePath.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]!);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('workspace_reparse_point');
      const resolved = await realpath(current);
      if (!samePath(resolved, current) || !isWithin(record.directory, resolved)) throw new Error('workspace_path_escape');
      const final = index === parts.length - 1;
      if (!final && !info.isDirectory()) return null;
      if (final) {
        if (info.isDirectory()) return Object.freeze({ kind: 'directory', directory: current });
        if (info.isFile()) return Object.freeze({ kind: 'file' });
        throw new Error('workspace_entry_unsupported');
      }
    }
    return null;
  }

  async #inspectConcretePath(record: WorkspaceRecord, relativePath: string, operation: WorkspacePathOperation): Promise<void> {
    await this.#assertWorkspaceRoot(record);
    const parts = relativePath.split('/');
    let current = record.directory;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      const final = index === parts.length - 1;
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !final || (operation !== 'write' && operation !== 'diff')) throw error;
        return;
      }
      if (info.isSymbolicLink()) throw new Error('workspace_reparse_point');
      const resolved = await realpath(current);
      if (!samePath(resolved, current) || !isWithin(record.directory, resolved)) throw new Error('workspace_path_escape');
      if (!final && !info.isDirectory()) throw new Error('workspace_parent_not_directory');
      if (final && operation === 'list' && !info.isDirectory()) throw new Error('workspace_list_target_invalid');
      if (final && operation !== 'list' && operation !== 'write' && !info.isFile()) throw new Error('workspace_file_target_invalid');
      if (final && operation === 'write' && !info.isFile()) throw new Error('workspace_write_target_invalid');
    }
  }

  async #inventory(record: WorkspaceRecord): Promise<SnapshotManifestV1> {
    await this.#assertWorkspaceRoot(record);
    return (await createSnapshotInventory(record.directory)).manifest;
  }

  async #assertWorkspaceRoot(record: WorkspaceRecord): Promise<void> {
    const info = await lstat(record.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('workspace_root_unsafe');
    const resolved = await realpath(record.directory);
    if (!samePath(resolved, record.directory) || !isWithin(this.#workspaceDirectory, resolved)) {
      throw new Error('workspace_root_redirected');
    }
  }

  #record(workspace: WorkspaceReference): WorkspaceRecord {
    const record = this.#workspaces.get(workspace.workspaceId);
    if (!record) throw new Error('workspace_unknown');
    return record;
  }

  async #audit(
    taskId: string,
    executionId: string,
    workspace: WorkspaceRecord,
    phase: AuditRecord['phase'],
    result: WorkspaceIntegrityResult,
  ): Promise<void> {
    const record: AuditRecord = Object.freeze({
      taskId,
      executionId,
      snapshotSha256: workspace.snapshotSha256,
      workspaceRelativePath: workspace.workspaceRelativePath,
      baselineSha256: workspace.snapshotSha256,
      phase,
      result: result.outcome,
      modifiedPaths: Object.freeze([...result.changedPaths]),
    });
    await this.#appendAuditRecord(record);
  }

  async #auditAllocation(
    taskId: string,
    executionId: string,
    snapshotSha256: string,
    workspaceRelativePath: string,
    result: 'started' | 'allow' | 'deny',
  ): Promise<void> {
    await this.#appendAuditRecord(Object.freeze({
      taskId,
      executionId,
      snapshotSha256,
      workspaceRelativePath,
      baselineSha256: snapshotSha256,
      phase: 'allocation',
      result,
      modifiedPaths: Object.freeze([]),
    }));
  }

  async #appendAuditRecord(record: AuditRecord): Promise<void> {
    await this.#ensureOrdinaryDirectory(this.#auditDirectory);
    const auditPath = path.join(this.#auditDirectory, 'integrity.jsonl');
    try {
      const info = await lstat(auditPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('workspace_audit_unsafe');
      const resolved = await realpath(auditPath);
      if (!samePath(resolved, auditPath)) throw new Error('workspace_audit_redirected');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await appendFile(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
  }

  async #ensureOrdinaryDirectory(directory: string): Promise<void> {
    const absolute = path.resolve(directory);
    const { root } = path.parse(absolute);
    let current = root;
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(root), root)) {
      throw new Error('workspace_storage_unsafe');
    }
    for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('workspace_storage_unsafe');
        try {
          await mkdir(current);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('workspace_storage_unsafe');
        }
        info = await lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) {
        throw new Error('workspace_storage_unsafe');
      }
    }
  }
}

function changedFiles(before: SnapshotManifestV1, after: SnapshotManifestV1): string[] {
  const previous = new Map(before.files.map((file) => [file.path, file]));
  const current = new Map(after.files.map((file) => [file.path, file]));
  const paths = new Set([...previous.keys(), ...current.keys()]);
  return [...paths]
    .filter((relativePath) => {
      const left = previous.get(relativePath);
      const right = current.get(relativePath);
      return !left || !right || left.sizeBytes !== right.sizeBytes || left.sha256 !== right.sha256;
    })
    .sort(comparePaths);
}

function deletedFiles(before: SnapshotManifestV1, after: SnapshotManifestV1): string[] {
  const pathsAfter = new Set(after.files.map((file) => file.path));
  return before.files.filter((file) => !pathsAfter.has(file.path)).map((file) => file.path);
}

function isDeclaredTestPath(envelope: TaskEnvelopeV1, relativePath: string): boolean {
  const key = relativePath.toLowerCase();
  return envelope.declaredTests.some((test) => isLegacyWorkspaceTest(test) && test.path.toLowerCase() === key);
}

async function readSafeWorkspaceText(root: string, relativePath: string, maxBytes: number): Promise<string> {
  const parts = relativePath.split('/');
  let current = root;
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(root);
  } catch {
    throw new Error('workspace_file_unavailable');
  }
  if (!samePath(rootRealPath, root)) throw new Error('workspace_path_redirected');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new Error('workspace_file_unavailable');
    }
    if (info.isSymbolicLink()) throw new Error('workspace_reparse_point');
    const resolved = await realpath(current);
    if (!samePath(resolved, current) || !isWithin(rootRealPath, resolved)) throw new Error('workspace_path_escape');
    const final = index === parts.length - 1;
    if (!final && !info.isDirectory()) throw new Error('workspace_parent_not_directory');
    if (final && (!info.isFile() || info.size > maxBytes)) throw new Error('workspace_file_too_large_or_unsupported');
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(current);
  } catch {
    throw new Error('workspace_file_unavailable');
  }
  if (bytes.byteLength > maxBytes || bytes.includes(0)) throw new Error('workspace_file_too_large_or_unsupported');
  const afterRead = await lstat(current);
  if (!afterRead.isFile() || afterRead.isSymbolicLink() || afterRead.size !== bytes.byteLength
    || !samePath(await realpath(current), current)) throw new Error('workspace_file_changed_during_read');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('workspace_file_encoding_unsupported');
  return text;
}

function validatePatchInput(
  plan: UnifiedDiffPlan,
  paths: readonly WorkspacePathReference[],
): readonly UnifiedDiffPlan['files'][number][] {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.files) || !Array.isArray(plan.changedPaths)
    || plan.files.length === 0 || plan.files.length > TOOL_REQUEST_LIMITS.maxDiffFiles
    || plan.changedPaths.length !== plan.files.length) {
    throw new WorkspacePatchError('invalid_plan');
  }
  const seen = new Set<string>();
  for (const [index, file] of plan.files.entries()) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string'
      || (file.mode !== 'create' && file.mode !== 'modify')
      || !Array.isArray(file.hunkLines) || file.hunkLines.length === 0
      || !file.hunkLines.every((line: unknown) => typeof line === 'string')
      || plan.changedPaths[index] !== file.path) {
      throw new WorkspacePatchError('invalid_plan');
    }
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new WorkspacePatchError('invalid_plan');
    seen.add(key);
  }
  if (!Array.isArray(paths) || paths.length !== plan.changedPaths.length) throw new WorkspacePatchError('path_set_mismatch');
  const expected = new Set(plan.changedPaths);
  const supplied = new Set<string>();
  for (const reference of paths) {
    const relativePath = reference?.relativePath;
    if (typeof relativePath !== 'string' || !expected.has(relativePath) || supplied.has(relativePath)) {
      throw new WorkspacePatchError('path_set_mismatch');
    }
    supplied.add(relativePath);
  }
  return plan.files;
}

/** Applies hunks to LF-only lines; every context and removed line must match at its stated position. */
function applyHunks(oldLines: readonly string[], hunkLines: readonly string[], create: boolean): string {
  const output: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < hunkLines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(hunkLines[index] ?? '');
    if (!header) throw new WorkspacePatchError('invalid_plan');
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    if (![oldStart, oldCount, newStart, newCount].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new WorkspacePatchError('invalid_plan');
    }
    if (create && (oldStart !== 0 || oldCount !== 0)) throw new WorkspacePatchError('hunk_mismatch');
    if (oldCount > 0 && oldStart === 0) throw new WorkspacePatchError('hunk_mismatch');
    const position = oldCount === 0 ? oldStart : oldStart - 1;
    if (position < cursor || position > oldLines.length) throw new WorkspacePatchError('hunk_mismatch');
    output.push(...oldLines.slice(cursor, position));
    const expectedNewStart = newCount === 0 ? output.length : output.length + 1;
    if (newStart !== expectedNewStart) throw new WorkspacePatchError('hunk_mismatch');

    let oldPosition = position;
    let consumedOld = 0;
    let consumedNew = 0;
    index += 1;
    for (; index < hunkLines.length; index += 1) {
      const line = hunkLines[index] ?? '';
      if (line.startsWith('@@')) break;
      if (line === '\\ No newline at end of file') throw new WorkspacePatchError('unsupported_text_format');
      const marker = line[0];
      const text = line.slice(1);
      if (text.includes('\r')) throw new WorkspacePatchError('unsupported_text_format');
      if (marker === ' ' || marker === '-') {
        if (oldPosition >= oldLines.length || oldLines[oldPosition] !== text) throw new WorkspacePatchError('hunk_mismatch');
        oldPosition += 1;
        consumedOld += 1;
        if (marker === ' ') {
          output.push(text);
          consumedNew += 1;
        }
      } else if (marker === '+') {
        output.push(text);
        consumedNew += 1;
      } else {
        throw new WorkspacePatchError('invalid_plan');
      }
    }
    if (consumedOld !== oldCount || consumedNew !== newCount) throw new WorkspacePatchError('hunk_mismatch');
    cursor = oldPosition;
  }
  output.push(...oldLines.slice(cursor));
  const text = output.length === 0 ? '' : `${output.join('\n')}\n`;
  if (Buffer.byteLength(text, 'utf8') > TOOL_REQUEST_LIMITS.maxDiffFileBytes) throw new WorkspacePatchError('file_too_large');
  return text;
}

/** Splits LF-terminated text; callers have already refused CR and a missing final newline. */
function textToLines(text: string): readonly string[] {
  return text.length === 0 ? [] : text.slice(0, -1).split('\n');
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new WorkspacePatchError('path_denied');
  }
}

function formatWholeFileDiff(relativePath: string, before: string | null, after: string | null): string {
  if (before === after) return '';
  const oldText = before ?? '';
  const newText = after ?? '';
  const oldLines = textLines(oldText);
  const newLines = textLines(newText);
  const oldPath = before === null ? '/dev/null' : `a/${relativePath}`;
  const newPath = after === null ? '/dev/null' : `b/${relativePath}`;
  const oldStart = oldLines.lines.length === 0 ? 0 : 1;
  const newStart = newLines.lines.length === 0 ? 0 : 1;
  const hunk = [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -${oldStart},${oldLines.lines.length} +${newStart},${newLines.lines.length} @@`,
  ];
  for (const line of oldLines.lines) hunk.push(`-${line}`);
  if (oldLines.lines.length > 0 && !oldLines.hasFinalNewline) hunk.push('\\ No newline at end of file');
  for (const line of newLines.lines) hunk.push(`+${line}`);
  if (newLines.lines.length > 0 && !newLines.hasFinalNewline) hunk.push('\\ No newline at end of file');
  return `${hunk.join('\n')}\n`;
}

function textLines(value: string): { readonly lines: readonly string[]; readonly hasFinalNewline: boolean } {
  const normalized = value.replace(/\r\n/g, '\n');
  const hasFinalNewline = normalized.endsWith('\n');
  const content = hasFinalNewline ? normalized.slice(0, -1) : normalized;
  return Object.freeze({
    lines: Object.freeze(content.length === 0 ? [] : content.split('\n')),
    hasFinalNewline,
  });
}

function matchesAny(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(relativePath, pattern));
}

function matchesPattern(relativePath: string, pattern: string): boolean {
  const concrete = relativePath.split('/');
  const patternParts = pattern.split('/');
  const memo = new Map<string, boolean>();
  const match = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${pathIndex}:${patternIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (patternIndex === patternParts.length) result = pathIndex === concrete.length;
    else if (patternParts[patternIndex] === '**') {
      result = match(pathIndex, patternIndex + 1)
        || (pathIndex < concrete.length && match(pathIndex + 1, patternIndex));
    } else if (pathIndex >= concrete.length) result = false;
    else {
      const segment = patternParts[patternIndex];
      if (segment.includes('**') && segment !== '**') result = false;
      else {
        const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
        result = new RegExp(`^${escaped}$`, 'i').test(concrete[pathIndex]) && match(pathIndex + 1, patternIndex + 1);
      }
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
