import { resolve } from 'node:path';

export function isPathWithinRoot(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  return resolvedCandidate.startsWith(resolvedRoot);
}
