import { TASK_OPERATIONS, type TaskOperation } from './policy.ts';
import { DECLARED_TEST_ID_PATTERN, type DeclaredTestV1 } from './tools.ts';

/** Stable lowercase ASCII identifier safe for case-insensitive Windows paths. */
export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value);
}

/** Immutable, versioned request data; host paths and approval state stay outside it. */
export interface TaskEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly prompt: string;
  readonly requestedOperations: readonly TaskOperation[];
  /** Workspace-relative paths or globs only; policy validates their contents. */
  readonly allowedPaths: readonly string[];
  /** Closed, harness-owned test profiles; agents may request only these IDs. */
  readonly declaredTests: readonly DeclaredTestV1[];
  readonly baseSnapshotSha256: string;
}

export interface TaskValidationIssue {
  readonly field: string;
  readonly reasonCode: string;
}

export type TaskValidationResult =
  | Readonly<{ valid: true; envelope: TaskEnvelopeV1 }>
  | Readonly<{ valid: false; issues: readonly TaskValidationIssue[] }>;

const TASK_ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'taskId',
  'prompt',
  'requestedOperations',
  'allowedPaths',
  'declaredTests',
  'baseSnapshotSha256',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_SET = new Set<string>(TASK_OPERATIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationIssue(field: string, reasonCode: string): TaskValidationIssue {
  return Object.freeze({ field, reasonCode });
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes('\\') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Pure structural validation shared by the CLI preflight and application service. */
export function validateTaskEnvelopeV1(input: unknown): TaskValidationResult {
  if (!isRecord(input)) return Object.freeze({ valid: false, issues: Object.freeze([validationIssue('envelope', 'object_required')]) });
  const issues: TaskValidationIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!TASK_ENVELOPE_KEYS.has(key)) issues.push(validationIssue(key, 'unknown_field'));
  }

  if (input.schemaVersion !== 1) issues.push(validationIssue('schemaVersion', 'unsupported_version'));
  if (!isValidTaskId(input.taskId)) issues.push(validationIssue('taskId', 'invalid_task_id'));
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0 || input.prompt.length > 20_000) {
    issues.push(validationIssue('prompt', 'invalid_prompt'));
  } else if (input.prompt.includes('\0')) {
    issues.push(validationIssue('prompt', 'invalid_prompt'));
  }
  if (!Array.isArray(input.requestedOperations) || input.requestedOperations.length === 0) {
    issues.push(validationIssue('requestedOperations', 'operations_required'));
  } else {
    const seenOperations = new Set<string>();
    for (const operation of input.requestedOperations) {
      if (typeof operation !== 'string' || !OPERATION_SET.has(operation)) {
        issues.push(validationIssue('requestedOperations', 'unknown_operation'));
        break;
      }
      if (seenOperations.has(operation)) {
        issues.push(validationIssue('requestedOperations', 'duplicate_operation'));
        break;
      }
      seenOperations.add(operation);
    }
  }
  if (!Array.isArray(input.allowedPaths) || input.allowedPaths.some((path) => typeof path !== 'string' || !isSafeRelativePath(path))) {
    issues.push(validationIssue('allowedPaths', 'invalid_relative_path'));
  }
  if (!Array.isArray(input.declaredTests) || input.declaredTests.length > 32) {
    issues.push(validationIssue('declaredTests', 'invalid_declared_tests'));
  } else {
    const declaredTestIds = new Set<string>();
    for (const declaredTest of input.declaredTests) {
      if (!isRecord(declaredTest)
        || Object.keys(declaredTest).length !== 2
        || Object.keys(declaredTest).some((key) => !['id', 'profile'].includes(key))
        || typeof declaredTest.id !== 'string'
        || !DECLARED_TEST_ID_PATTERN.test(declaredTest.id)
        || declaredTest.profile !== 'host-json-v1') {
        issues.push(validationIssue('declaredTests', 'invalid_declared_test'));
        break;
      }
      if (declaredTestIds.has(declaredTest.id)) {
        issues.push(validationIssue('declaredTests', 'duplicate_declared_test_id'));
        break;
      }
      declaredTestIds.add(declaredTest.id);
    }
  }
  if (typeof input.baseSnapshotSha256 !== 'string' || !SHA256_PATTERN.test(input.baseSnapshotSha256)) {
    issues.push(validationIssue('baseSnapshotSha256', 'invalid_sha256'));
  }

  if (issues.length > 0) return Object.freeze({ valid: false, issues: Object.freeze(issues) });
  const envelope: TaskEnvelopeV1 = Object.freeze({
    schemaVersion: 1,
    taskId: input.taskId as string,
    prompt: input.prompt as string,
    requestedOperations: Object.freeze([...(input.requestedOperations as TaskOperation[])]),
    allowedPaths: Object.freeze([...(input.allowedPaths as string[])]),
    declaredTests: Object.freeze((input.declaredTests as DeclaredTestV1[]).map((declaredTest) => Object.freeze({ ...declaredTest }))),
    baseSnapshotSha256: input.baseSnapshotSha256 as string,
  });
  return Object.freeze({ valid: true, envelope });
}
