import type { SnapshotCaptureReceipt } from '../domain/snapshot.ts';
import { ApplicationServiceError } from './errors.ts';
import type { SnapshotCapturePort } from './ports/index.ts';

export interface SnapshotCaptureRequest {
  readonly sourceDirectory: string;
  readonly confirmedDisposable: boolean;
}

export interface SnapshotApplicationServices {
  createSnapshot(input: SnapshotCaptureRequest): Promise<SnapshotCaptureReceipt>;
}

/** Application command for an operator-selected, disposable source directory. */
export function createSnapshotApplicationServices(input: {
  readonly snapshots: SnapshotCapturePort;
}): SnapshotApplicationServices {
  return Object.freeze({
    async createSnapshot(request: SnapshotCaptureRequest): Promise<SnapshotCaptureReceipt> {
      if (!request || typeof request.sourceDirectory !== 'string' || request.sourceDirectory.length === 0 || request.sourceDirectory.includes('\0')) {
        throw new ApplicationServiceError('INVALID_TASK');
      }
      if (request.confirmedDisposable !== true) throw new ApplicationServiceError('SNAPSHOT_CONFIRMATION_REQUIRED');
      try {
        return await input.snapshots.capture(request.sourceDirectory);
      } catch {
        throw new ApplicationServiceError('SNAPSHOT_CAPTURE_FAILED');
      }
    },
  });
}
