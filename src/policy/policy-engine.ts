import { TASK_OPERATIONS, type ApprovalGrantV1, type PolicyDecision, type PolicyEvaluationInput, type TaskOperation } from '../domain/policy.ts';
import { isValidTaskId } from '../domain/task.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;
const WINDOWS_DEVICE_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const OPERATION_SET = new Set<string>(TASK_OPERATIONS);
const BLOCKED_DIRECTORY_SEGMENTS = new Set([
  '.git', '.agentctl', '.ssh', '.aws', '.venv', 'node_modules', '.npmrc', '.pypirc', '.netrc',
]);
const CREDENTIAL_BASENAMES = new Set(['credentials', 'secrets', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']);
const PRIVATE_KEY_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.ppk']);

/**
 * Return a canonical workspace-relative path pattern, or null when it is
 * ambiguous, escapes lexically, or explicitly selects a protected path. Glob
 * results are filtered by the workspace and tool adapters after expansion.
 */
export function normalizeAllowedPath(path: string): string | null {
  if (
    path.length === 0
    || /[\u0000-\u001f\u007f]/.test(path)
    || path.includes('\\')
    || path.includes(':')
    || /[<>"|?]/.test(path)
    || path.startsWith('/')
    || /^[a-zA-Z]:/.test(path)
  ) {
    return null;
  }

  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null;
  if (segments.some((segment) => segment.startsWith(' ') || segment.endsWith('.') || segment.endsWith(' '))) return null;

  if (segments.some((segment) => {
    if (segment.includes('*')) return false;
    const lower = segment.toLowerCase();
    const extensionIndex = lower.lastIndexOf('.');
    const extension = extensionIndex < 0 ? '' : lower.slice(extensionIndex);
    const firstDotIndex = lower.indexOf('.');
    const nameBeforeFirstDot = firstDotIndex > 0 ? lower.slice(0, firstDotIndex) : lower;
    return lower === '.env'
      || lower.startsWith('.env')
      || BLOCKED_DIRECTORY_SEGMENTS.has(lower)
      || CREDENTIAL_BASENAMES.has(nameBeforeFirstDot)
      || PRIVATE_KEY_EXTENSIONS.has(extension)
      || /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/i.test(segment)
      || WINDOWS_DEVICE_SEGMENT_PATTERN.test(segment);
  })) {
    return null;
  }

  return path;
}

function deny(reasonCode: string): PolicyDecision {
  return Object.freeze({ outcome: 'deny', reasonCode });
}

function requiresApproval(reasonCode: string): PolicyDecision {
  return Object.freeze({ outcome: 'requires_approval', reasonCode });
}

function allow(reasonCode: string): PolicyDecision {
  return Object.freeze({ outcome: 'allow', reasonCode });
}

function isOperation(value: unknown): value is TaskOperation {
  return typeof value === 'string' && OPERATION_SET.has(value);
}

function isValidUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
}

function sameOperations(left: readonly TaskOperation[], right: readonly TaskOperation[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((operation, index) => operation === sortedRight[index]);
}

function isMatchingApproval(input: PolicyEvaluationInput): input is PolicyEvaluationInput & { approval: ApprovalGrantV1 } {
  const { approval, envelope, envelopeSha256, now } = input;
  if (!approval || typeof approval !== 'object') return false;
  if (approval.schemaVersion !== 1 || approval.confirmed !== true) return false;
  if (approval.taskId !== envelope.taskId || approval.envelopeSha256 !== envelopeSha256) return false;
  if (!Array.isArray(approval.operations) || approval.operations.some((operation) => !isOperation(operation))) return false;
  if (new Set(approval.operations).size !== approval.operations.length) return false;
  if (!sameOperations(approval.operations, envelope.requestedOperations)) return false;
  if (!isValidUtcTimestamp(now) || !isValidUtcTimestamp(approval.expiresAt)) return false;
  return Date.parse(approval.expiresAt) > Date.parse(now);
}

/** PolicyEvaluatorPort adapter. It classifies only; it never executes tools. */
export function createPolicyEngine(): { evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision> } {
  return Object.freeze({
    async evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision> {
      const { envelope, envelopeSha256 } = input;
      if (
        envelope.schemaVersion !== 1
        || !isValidTaskId(envelope.taskId)
        || !SHA256_PATTERN.test(envelopeSha256)
        || !Array.isArray(envelope.requestedOperations)
        || envelope.requestedOperations.length === 0
        || envelope.requestedOperations.some((operation) => !isOperation(operation))
        || new Set(envelope.requestedOperations).size !== envelope.requestedOperations.length
      ) {
        return deny('invalid_task_envelope');
      }

      if (!Array.isArray(envelope.allowedPaths) || envelope.allowedPaths.some((path) => typeof path !== 'string' || normalizeAllowedPath(path) === null)) {
        return deny('path_policy_denied');
      }

      if (envelope.requestedOperations.includes('network')) return deny('network_not_allowed');

      const requiresWriteApproval = envelope.requestedOperations.some(
        (operation) => operation === 'write' || operation === 'process',
      );
      if (!requiresWriteApproval) return allow('policy_allowed');
      if (!isMatchingApproval(input)) return requiresApproval('approval_required');
      return allow('approval_valid');
    },
  });
}
