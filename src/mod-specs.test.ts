import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The specs of the manager panel mod (dev/mods/gerente-painel/spec) and of the ledger script run inside
// `npm test`, so `npm run verify` and the CI cover them without a new npm script. A new script would change
// package.json, and package.json is part of the G2.2 runner fingerprint: any edit there invalidates the
// isolation attestation and the approved review-set hash.

function repositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      if (statSync(join(current, 'package.json')).isFile() && statSync(join(current, 'dev')).isDirectory()) return current;
    } catch { /* keep walking up */ }
    const parent = dirname(current);
    if (parent === current) throw new Error('repository root not found');
    current = parent;
  }
}

test('the panel mod specs and the ledger script test pass', () => {
  const root = repositoryRoot();
  const specDirectory = join(root, 'dev', 'mods', 'gerente-painel', 'spec');
  const ledgerTest = join(root, 'dev', 'offload', 'ledger.test.mjs');
  const files = [
    ...(existsSync(specDirectory) ? readdirSync(specDirectory).filter((name) => name.endsWith('.spec.ts')).sort().map((name) => join(specDirectory, name)) : []),
    ...(existsSync(ledgerTest) ? [ledgerTest] : []),
  ];
  assert.ok(files.length > 0, 'no spec files found');
  // A nested test run must not inherit the parent runner's context variable.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(-4000));
});
