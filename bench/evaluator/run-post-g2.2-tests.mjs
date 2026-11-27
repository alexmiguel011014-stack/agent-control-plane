import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readG2IsolationAttestation } from './isolation-attestation.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function main() {
  await readG2IsolationAttestation(REPOSITORY_ROOT);
  const testPath = path.join(REPOSITORY_ROOT, 'bench', 'evaluator', 'evaluator.test.mjs');
  const result = spawnSync(process.execPath, ['--test', testPath], {
    cwd: REPOSITORY_ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Post-G2.2 evaluator suite refused or failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
