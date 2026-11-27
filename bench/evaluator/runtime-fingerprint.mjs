import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_TEST_REGISTRY } from './public-test-registry.mjs';

const STATIC_RUNTIME_FINGERPRINT_FILES = Object.freeze([
  'AGENTS.md',
  'README.md',
  'bench/evaluator/README.md',
  'bench/evaluator/case-data.mjs',
  'bench/evaluator/case-data.test.mjs',
  'bench/evaluator/evaluator-static.test.mjs',
  'bench/evaluator/evaluator.test.mjs',
  'bench/evaluator/g0-report.mjs',
  'bench/evaluator/g0-review-contract.mjs',
  'bench/evaluator/host-harness.mjs',
  'bench/evaluator/index.mjs',
  'bench/evaluator/isolation-attestation.mjs',
  'bench/evaluator/oracle-runner.mjs',
  'bench/evaluator/public-test-registry.mjs',
  'bench/evaluator/public-test-entry-gate.mjs',
  'bench/evaluator/runtime-fingerprint.mjs',
  'bench/evaluator/run-post-g2.2-tests.mjs',
  'bench/evaluator/schema/task-manifest.mjs',
  'bench/evaluator/unified-diff.mjs',
  'bench/isolation/AppContainerLauncher.cs',
  'bench/isolation/host-runner.mjs',
  'bench/isolation/production-worker.mjs',
  'bench/isolation/protocol.mjs',
  'bench/isolation/run-probes.ps1',
  'bench/isolation/run-worker.ps1',
  'bench/isolation/probe-contract.mjs',
  'bench/isolation/probe-contract.test.mjs',
  'bench/isolation/task-operations.mjs',
  'bench/isolation/worker.mjs',
  'bench/schema/task.schema.json',
  'bench/snapshots/seal.mjs',
  'bench/snapshots/index.mjs',
  'src/snapshots/snapshot-core.mjs',
  'bench/tasks/README.md',
  'package.json',
  'package-lock.json',
]);

export const RUNTIME_FINGERPRINT_FILES = Object.freeze([
  ...STATIC_RUNTIME_FINGERPRINT_FILES,
  ...Object.entries(PUBLIC_TEST_REGISTRY)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([taskId, entry]) => [
      ['bench/tasks', taskId, entry.relativePath].join('/'),
      entry.oracleRelativePath,
    ]),
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function readOrdinaryFile(repositoryRoot, relativePath) {
  const root = path.resolve(repositoryRoot);
  const canonicalRoot = await realpath(root);
  const parts = relativePath.split('/');
  let current = root;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await lstat(current);
    const final = index === parts.length - 1;
    if (stat.isSymbolicLink() || (final ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Runtime fingerprint input is not an ordinary file: ${relativePath}`);
    }
    const resolved = await realpath(current);
    if (!isWithin(canonicalRoot, resolved)) {
      throw new Error(`Runtime fingerprint input escapes the repository: ${relativePath}`);
    }
  }

  return readFile(current);
}

export async function getRuntimeFingerprint(repositoryRoot) {
  const files = [];
  for (const relativePath of RUNTIME_FINGERPRINT_FILES) {
    const bytes = await readOrdinaryFile(repositoryRoot, relativePath);
    files.push({ path: relativePath, sha256: sha256(bytes) });
  }

  return {
    sha256: sha256(Buffer.from(JSON.stringify(files), 'utf8')),
    files,
  };
}
