export interface SnapshotFileRecordV1 {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface SnapshotManifestV1 {
  readonly schemaVersion: 1;
  readonly files: readonly SnapshotFileRecordV1[];
}

export interface SnapshotScanOptions {
  readonly excludeDirectories?: readonly string[];
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface SnapshotInventory {
  readonly manifest: SnapshotManifestV1;
  readonly excludedPaths: readonly string[];
  readonly totalBytes: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}>;

export function assertSnapshotPath(relativePath: string): string;
export function normalizeSnapshotManifest(manifest: unknown): SnapshotManifestV1;
export function validateSnapshotManifest(manifest: unknown): SnapshotManifestV1;
export function sha256File(filePath: string, maxBytes?: number): Promise<{ sizeBytes: number; sha256: string }>;
export function snapshotId(manifest: SnapshotManifestV1): string;
export function createSnapshotManifest(baseDir: string, options?: SnapshotScanOptions): Promise<SnapshotManifestV1>;
export function createSnapshotInventory(baseDir: string, options?: SnapshotScanOptions): Promise<SnapshotInventory>;
export function writeSnapshotManifest(baseDir: string): Promise<{
  manifestPath: string;
  manifest: SnapshotManifestV1;
  snapshotId: string;
}>;
export function readSnapshotManifest(manifestPath: string): Promise<SnapshotManifestV1>;
export function verifySnapshot(
  baseDir: string,
  manifest: SnapshotManifestV1,
  expectedId?: string,
  options?: SnapshotScanOptions,
): Promise<{ snapshotId: string; manifest: SnapshotManifestV1 }>;
export function restoreSnapshot(
  baseDir: string,
  manifest: SnapshotManifestV1,
  destinationDir: string,
  expectedId?: string,
): Promise<{ snapshotId: string; manifest: SnapshotManifestV1 }>;
