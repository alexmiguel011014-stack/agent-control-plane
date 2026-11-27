import type { TaskEnvelopeV1 } from './task.ts';

/** Operations the control plane can classify and authorize. */
export const TASK_OPERATIONS = ['read', 'write', 'process', 'network'] as const;

export type TaskOperation = (typeof TASK_OPERATIONS)[number];

/** A narrow approval kept separate from the envelope to avoid a hash cycle. */
export interface ApprovalGrantV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly envelopeSha256: string;
  readonly operations: readonly TaskOperation[];
  readonly expiresAt: string;
  readonly confirmed: true;
}

export type PolicyDecision =
  | Readonly<{ outcome: 'allow'; reasonCode: string }>
  | Readonly<{ outcome: 'deny'; reasonCode: string }>
  | Readonly<{ outcome: 'requires_approval'; reasonCode: string }>;

/** Runtime policy evaluation is implemented by the policy adapter in G1.4. */
export interface PolicyEvaluationInput {
  readonly envelope: TaskEnvelopeV1;
  /** Trusted digest loaded from the task repository and verified by the application. */
  readonly envelopeSha256: string;
  readonly approval?: ApprovalGrantV1;
  readonly now: string;
}
