import {
  createSnapshotManifest as createSharedSnapshotManifest,
  createSnapshotInventory as createSharedSnapshotInventory,
  readSnapshotManifest as readSharedSnapshotManifest,
  restoreSnapshot as restoreSharedSnapshot,
  snapshotId as sharedSnapshotId,
  validateSnapshotManifest as validateSharedSnapshotManifest,
  verifySnapshot as verifySharedSnapshot,
  writeSnapshotManifest as writeSharedSnapshotManifest,
} from '../../src/snapshots/snapshot-core.mjs';

export async function createSnapshotManifest(baseDir, options = {}) {
  return createSharedSnapshotManifest(baseDir, options);
}

export async function createSnapshotInventory(baseDir, options = {}) {
  return createSharedSnapshotInventory(baseDir, options);
}

export function validateSnapshotManifest(manifest) {
  return validateSharedSnapshotManifest(manifest);
}

export function snapshotId(manifest) {
  return sharedSnapshotId(manifest);
}

export async function writeSnapshotManifest(baseDir) {
  return writeSharedSnapshotManifest(baseDir);
}

export async function readSnapshotManifest(manifestPath) {
  return readSharedSnapshotManifest(manifestPath);
}

export async function verifySnapshot(baseDir, manifest, expectedId = snapshotId(manifest)) {
  return verifySharedSnapshot(baseDir, manifest, expectedId);
}

export async function restoreSnapshot(baseDir, manifest, destinationDir, expectedId = snapshotId(manifest)) {
  return restoreSharedSnapshot(baseDir, manifest, destinationDir, expectedId);
}
