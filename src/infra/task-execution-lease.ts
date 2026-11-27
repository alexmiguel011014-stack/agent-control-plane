import { resolve } from 'node:path';
import type { TaskExecutionLeasePort, TaskExecutionLeaseKind } from '../application/ports/index.ts';
import { TaskExecutionLeaseBusyError } from '../application/ports/index.ts';
import { FileLockBusyError, tryAcquireExclusiveFileLock } from './file-lock.ts';

/** Cross-process lease for full task runs and restart-recovery sweeps. */
export class LocalTaskExecutionLease implements TaskExecutionLeasePort {
  private readonly lockPath: string;

  constructor(lockPath: string) {
    this.lockPath = resolve(lockPath);
  }

  async tryAcquire(kind: TaskExecutionLeaseKind) {
    try {
      const lock = await tryAcquireExclusiveFileLock(this.lockPath, kind);
      return Object.freeze({ release: () => lock.release() });
    } catch (error) {
      if (error instanceof FileLockBusyError) {
        throw new TaskExecutionLeaseBusyError(this.lockPath, error.owner);
      }
      throw new TaskExecutionLeaseBusyError(this.lockPath);
    }
  }
}
