import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import {
  DEFAULT_SNAPSHOT_LIMITS,
  createSnapshotInventory,
  readSnapshotManifest,
  restoreSnapshot,
  snapshotId,
  verifySnapshot,
  type SnapshotManifestV1,
} from '../snapshots/snapshot-core.mjs';
import type { SnapshotCapturePort } from '../application/ports/index.ts';
import type { SnapshotCaptureReceipt } from '../domain/snapshot.ts';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EXCLUDED_DIRECTORIES = ['.git', '.agentctl', 'node_modules', '.venv'] as const;

interface StoredSnapshot {
  readonly snapshotSha256: string;
  readonly manifest: SnapshotManifestV1;
  readonly baseDirectory: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface KnownSnapshotSource {
  readonly snapshotSha256: string;
  readonly baseDirectory: string;
  readonly manifest: SnapshotManifestV1;
}

export class LocalSnapshotStore implements SnapshotCapturePort {
  readonly #root: string;
  readonly #knownSnapshots: ReadonlyMap<string, KnownSnapshotSource>;

  constructor(rootDirectory: string, options: { readonly knownSnapshots?: readonly KnownSnapshotSource[] } = {}) {
    this.#root = path.resolve(rootDirectory);
    this.#knownSnapshots = new Map((options.knownSnapshots ?? []).map((known) => [known.snapshotSha256, known]));
  }

  async capture(sourceDirectory: string): Promise<SnapshotCaptureReceipt> {
    const sourceRoot = await this.#inspectSourceRoot(sourceDirectory);
    const inventory = await createSnapshotInventory(sourceRoot, {
      excludeDirectories: EXCLUDED_DIRECTORIES,
    });
    const manifest = inventory.manifest;
    const snapshotSha256 = snapshotId(manifest);
    const root = await this.#ensureOrdinaryDirectory(this.#root);
    const destination = path.join(root, snapshotSha256);
    const existing = await this.#readStoredSnapshot(snapshotSha256);
    if (existing) {
      return this.#receipt(existing, inventory.excludedPaths, true);
    }

    const staging = path.join(root, `.tmp-${snapshotSha256}-${randomUUID()}`);
    await mkdir(staging, { recursive: false });
    try {
      const stagedBase = path.join(staging, 'base');
      await mkdir(stagedBase, { recursive: false });
      for (const file of manifest.files) {
        const sourcePath = path.join(sourceRoot, ...file.path.split('/'));
        const destinationPath = path.join(stagedBase, ...file.path.split('/'));
        await this.#assertOrdinaryFile(sourceRoot, sourcePath, file.path);
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await pipeline(createReadStream(sourcePath), createWriteStream(destinationPath, { flags: 'wx' }));
      }

      await verifySnapshot(stagedBase, manifest, snapshotSha256);
      await verifySnapshot(sourceRoot, manifest, snapshotSha256, {
        excludeDirectories: EXCLUDED_DIRECTORIES,
      });
      await writeFile(
        path.join(staging, 'snapshot.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { flag: 'wx' },
      );

      try {
        await rename(staging, destination);
      } catch (error) {
        if (!this.#isDestinationExists(error)) throw error;
        const raced = await this.#readStoredSnapshot(snapshotSha256);
        if (!raced) throw new Error('snapshot_store_conflict');
        return this.#receipt(raced, inventory.excludedPaths, true);
      }

      const published = await this.#readStoredSnapshot(snapshotSha256);
      if (!published) throw new Error('snapshot_store_publish_failed');
      return this.#receipt(published, inventory.excludedPaths, false);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async resolve(snapshotSha256: string): Promise<StoredSnapshot | null> {
    if (!HASH_PATTERN.test(snapshotSha256)) return null;
    const stored = await this.#readStoredSnapshot(snapshotSha256);
    if (stored) return stored;
    const known = this.#knownSnapshots.get(snapshotSha256);
    if (!known || snapshotId(known.manifest) !== snapshotSha256) return null;
    const verified = await verifySnapshot(known.baseDirectory, known.manifest, snapshotSha256);
    return Object.freeze({
      snapshotSha256,
      manifest: verified.manifest,
      baseDirectory: path.resolve(known.baseDirectory),
      fileCount: verified.manifest.files.length,
      totalBytes: this.#sumBytes(verified.manifest),
    });
  }

  async restore(snapshotSha256: string, destinationDirectory: string): Promise<StoredSnapshot> {
    const stored = await this.resolve(snapshotSha256);
    if (!stored) throw new Error('snapshot_not_found');
    await restoreSnapshot(stored.baseDirectory, stored.manifest, destinationDirectory, snapshotSha256);
    const restored = await verifySnapshot(destinationDirectory, stored.manifest, snapshotSha256);
    return Object.freeze({
      snapshotSha256,
      manifest: restored.manifest,
      baseDirectory: path.resolve(destinationDirectory),
      fileCount: restored.manifest.files.length,
      totalBytes: this.#sumBytes(restored.manifest),
    });
  }

  async #readStoredSnapshot(snapshotSha256: string): Promise<StoredSnapshot | null> {
    const root = await this.#ensureOrdinaryDirectory(this.#root);
    const snapshotDirectory = path.join(root, snapshotSha256);
    let info;
    try {
      info = await lstat(snapshotDirectory);
    } catch (error) {
      if (this.#isMissing(error)) return null;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('snapshot_store_entry_unsafe');
    const resolvedDirectory = await realpath(snapshotDirectory);
    if (!this.#samePath(resolvedDirectory, snapshotDirectory)) throw new Error('snapshot_store_entry_redirected');

    const manifest = await readSnapshotManifest(path.join(snapshotDirectory, 'snapshot.json'));
    if (snapshotId(manifest) !== snapshotSha256) throw new Error('snapshot_store_hash_mismatch');
    const baseDirectory = path.join(snapshotDirectory, 'base');
    const verified = await verifySnapshot(baseDirectory, manifest, snapshotSha256);
    return Object.freeze({
      snapshotSha256,
      manifest: verified.manifest,
      baseDirectory,
      fileCount: verified.manifest.files.length,
      totalBytes: this.#sumBytes(verified.manifest),
    });
  }

  async #inspectSourceRoot(sourceDirectory: string): Promise<string> {
    const requested = path.resolve(sourceDirectory);
    const parsed = path.parse(requested);
    if (this.#samePath(requested, parsed.root)) throw new Error('snapshot_source_root_not_allowed');
    const info = await lstat(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('snapshot_source_not_ordinary_directory');
    const canonical = await realpath(requested);
    if (!this.#samePath(canonical, requested)) throw new Error('snapshot_source_redirected');
    return canonical;
  }

  async #ensureOrdinaryDirectory(directory: string): Promise<string> {
    const absolute = path.resolve(directory);
    const { root } = path.parse(absolute);
    let current = root;
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('snapshot_store_root_unsafe');
    const resolvedRoot = await realpath(root);
    if (!this.#samePath(resolvedRoot, root)) throw new Error('snapshot_store_root_redirected');

    const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
    for (const part of parts) {
      current = path.join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (!this.#isMissing(error)) throw error;
        try {
          await mkdir(current, { recursive: false });
        } catch (mkdirError) {
          if (!this.#isAlreadyExists(mkdirError)) throw mkdirError;
        }
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('snapshot_store_ancestor_unsafe');
      const resolved = await realpath(current);
      if (!this.#samePath(resolved, current)) throw new Error('snapshot_store_ancestor_redirected');
      current = resolved;
    }
    return current;
  }

  async #assertOrdinaryFile(root: string, sourcePath: string, relativePath: string): Promise<void> {
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('snapshot_source_file_unsafe');
    const resolved = await realpath(sourcePath);
    const expected = path.join(root, ...relativePath.split('/'));
    if (!this.#samePath(resolved, expected)) throw new Error('snapshot_source_file_redirected');
  }

  #receipt(snapshot: StoredSnapshot, excludedPaths: readonly string[], reused: boolean): SnapshotCaptureReceipt {
    return Object.freeze({
      snapshotSha256: snapshot.snapshotSha256,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      excludedPaths: Object.freeze([...excludedPaths]),
      reused,
    });
  }

  #sumBytes(manifest: SnapshotManifestV1): number {
    return manifest.files.reduce((total, file) => total + file.sizeBytes, 0);
  }

  #samePath(left: string, right: string): boolean {
    const a = path.normalize(left);
    const b = path.normalize(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  #isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
  }

  #isDestinationExists(error: unknown): boolean {
    return typeof error === 'object'
      && error !== null
      && 'code' in error
      && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code));
  }

  #isAlreadyExists(error: unknown): boolean {
    return typeof error === 'object'
      && error !== null
      && 'code' in error
      && String(error.code) === 'EEXIST';
  }
}

export { DEFAULT_SNAPSHOT_LIMITS };
