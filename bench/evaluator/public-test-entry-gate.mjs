import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readG2IsolationAttestation } from './isolation-attestation.mjs';
import { PUBLIC_TEST_REGISTRY } from './public-test-registry.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative)
  );
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function assertPublicTestEntryAllowed(publicTestUrl) {
  let publicTestPath;
  try {
    publicTestPath = path.resolve(fileURLToPath(publicTestUrl));
  } catch {
    throw new Error('Public test entry must be a registered file URL');
  }

  const registered = Object.entries(PUBLIC_TEST_REGISTRY).filter(([taskId, entry]) => {
    const expectedPath = path.resolve(
      REPOSITORY_ROOT,
      'bench',
      'tasks',
      taskId,
      ...entry.relativePath.split('/'),
    );
    return comparablePath(expectedPath) === comparablePath(publicTestPath);
  });
  if (registered.length !== 1) throw new Error('Public test entry is not in the fixed registry');

  const root = await realpath(REPOSITORY_ROOT);
  const info = await lstat(publicTestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Public test entry is not an ordinary file');
  const canonicalPath = await realpath(publicTestPath);
  if (!isWithin(root, canonicalPath)) throw new Error('Public test entry escapes the repository');

  try {
    await readG2IsolationAttestation(REPOSITORY_ROOT);
  } catch {
    throw new Error('Direct public-test execution requires current passing G2.2 isolation evidence');
  }
}
