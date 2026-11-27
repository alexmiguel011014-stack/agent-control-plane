/** Operator-created content-addressed source snapshot metadata. On Windows only unnamed/default streams are copied; existing NTFS alternate data streams are not enumerated. */
export interface SnapshotCaptureReceipt {
  readonly snapshotSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Relative exclusions only; the source's absolute path is never returned. */
  readonly excludedPaths: readonly string[];
  readonly reused: boolean;
}
