import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_TEST_REGISTRY } from './public-test-registry.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TASK_ID_PATTERN = /^[PBIS][0-9]{2}$/;

/** Resolve only the declarative oracle data file named by the fixed registry. */
export function registeredOraclePath(taskId, repositoryRoot = REPOSITORY_ROOT) {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    throw new Error('Invalid fixed-registry task ID');
  }
  const entry = PUBLIC_TEST_REGISTRY[taskId];
  if (!entry || entry.oracleRelativePath !== `bench/oracles/${taskId}.json`) {
    throw new Error('Task has no fixed-registry oracle');
  }
  const root = path.resolve(repositoryRoot);
  const oraclePath = path.resolve(root, ...entry.oracleRelativePath.split('/'));
  const relative = path.relative(root, oraclePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Oracle path escapes the repository');
  return oraclePath;
}
