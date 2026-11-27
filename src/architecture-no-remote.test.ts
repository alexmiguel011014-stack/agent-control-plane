import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// G3.5: the product has no remote-provider adapter and no remote credential/configuration path.
// Only the loopback Ollama adapter may open a network connection.

function sourceRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      if (statSync(join(current, 'package.json')).isFile() && statSync(join(current, 'src')).isDirectory()) return join(current, 'src');
    } catch { /* keep walking up */ }
    const parent = dirname(current);
    if (parent === current) throw new Error('src not found');
    current = parent;
  }
}

function productionFiles(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) productionFiles(full, found);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) found.push(full);
  }
  return found;
}

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['remote provider SDK import', /from\s+['"](?:@anthropic-ai|@openai|openai|@modelcontextprotocol)[^'"]*['"]/],
  ['remote provider host', /api\.(?:openai|anthropic)\.com|chatgpt\.com|claude\.ai/],
  ['provider credential variable', /(?:OPENAI|ANTHROPIC|CODEX|CLAUDE)[A-Z_]*(?:API_KEY|TOKEN|AUTH)/],
  ['generic API key lookup', /process\.env\.[A-Z_]*(?:API_KEY|SECRET|TOKEN)/],
];

test('production sources contain no remote adapter, provider host, or credential path', () => {
  const root = sourceRoot();
  const violations: string[] = [];
  for (const file of productionFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const [label, pattern] of FORBIDDEN) if (pattern.test(text)) violations.push(`${relative(root, file)}: ${label}`);
  }
  assert.deepEqual(violations, []);
});

test('only the loopback Ollama adapters reference a network address', () => {
  const root = sourceRoot();
  const hosts = /https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])[a-z0-9.-]+/i;
  const offenders = productionFiles(root)
    .filter((file) => hosts.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file));
  assert.deepEqual(offenders, []);
});
