import type { LocalLockConflictDetails } from './ports/index.ts';

export type ApplicationErrorCode =
  | 'INVALID_TASK'
  | 'TASK_NOT_FOUND'
  | 'TASK_RECORD_UNAVAILABLE'
  | 'TASK_ID_CONFLICT'
  | 'ENVELOPE_HASH_MISMATCH'
  | 'INVALID_STATE'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALID'
  | 'SNAPSHOT_CONFIRMATION_REQUIRED'
  | 'SNAPSHOT_CAPTURE_FAILED'
  | 'POLICY_DENIED'
  | 'CONCURRENCY_CONFLICT'
  | 'RUNNER_FAILURE';

/** Stable, redacted service error; never embeds prompt or adapter output. */
export class ApplicationServiceError extends Error {
  readonly code: ApplicationErrorCode;
  readonly lockConflict?: LocalLockConflictDetails;

  constructor(code: ApplicationErrorCode, lockConflict?: LocalLockConflictDetails) {
    super(code);
    this.name = 'ApplicationServiceError';
    this.code = code;
    this.lockConflict = lockConflict;
  }
}
