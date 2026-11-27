import assert from 'node:assert/strict';
import test from 'node:test';
import type { SnapshotCaptureReceipt } from '../domain/snapshot.ts';
import { ApplicationServiceError } from './errors.ts';
import { createSnapshotApplicationServices } from './snapshot-services.ts';

const receipt: SnapshotCaptureReceipt = Object.freeze({
  snapshotSha256: 'a'.repeat(64),
  fileCount: 2,
  totalBytes: 17,
  excludedPaths: Object.freeze(['.git', 'node_modules']),
  reused: false,
});

test('requires explicit disposable-source confirmation before capture', async () => {
  let calls = 0;
  const services = createSnapshotApplicationServices({
    snapshots: { capture: async () => { calls += 1; return receipt; } },
  });
  await assert.rejects(services.createSnapshot({ sourceDirectory: 'C:\\work\\copy', confirmedDisposable: false }), (error: unknown) =>
    error instanceof ApplicationServiceError && error.code === 'SNAPSHOT_CONFIRMATION_REQUIRED');
  assert.equal(calls, 0);
});

test('returns capture metadata and redacts adapter errors', async () => {
  const pathSecret = 'C:\\Users\\owner\\private';
  let receivedSource = '';
  const services = createSnapshotApplicationServices({
    snapshots: {
      capture: async (sourceDirectory) => {
        receivedSource = sourceDirectory;
        return receipt;
      },
    },
  });
  assert.deepEqual(await services.createSnapshot({ sourceDirectory: pathSecret, confirmedDisposable: true }), receipt);
  assert.equal(receivedSource, pathSecret);

  const failing = createSnapshotApplicationServices({
    snapshots: { capture: async () => { throw new Error(`failure at ${pathSecret}`); } },
  });
  await assert.rejects(failing.createSnapshot({ sourceDirectory: pathSecret, confirmedDisposable: true }), (error: unknown) =>
    error instanceof ApplicationServiceError
      && error.code === 'SNAPSHOT_CAPTURE_FAILED'
      && !error.message.includes(pathSecret));
});
