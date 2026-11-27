import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const applicationRoot = path.dirname(fileURLToPath(import.meta.url));
const forbiddenImport = /^(?:\.\.?\/)*(?:infra|interfaces|cli)(?:\/|$)|^(?:node:|child_process$|fs$|fs\/|ollama$)/i;

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(fullPath));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(fullPath);
  }
  return files;
}

test('application modules depend only on domain types and application ports', async () => {
  const violations: string[] = [];
  for (const file of await sourceFiles(applicationRoot)) {
    const source = await readFile(file, 'utf8');
    const imports = source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g);
    for (const [, specifier] of imports) {
      if (forbiddenImport.test(specifier)) violations.push(`${path.relative(applicationRoot, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});
