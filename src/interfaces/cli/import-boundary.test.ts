import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(process.cwd());

test('production CLI facade exposes no test bypass and keeps core imports within application boundaries', async () => {
  const facade = await readFile(join(root, 'src/interfaces/cli/agentctl.ts'), 'utf8');
  const facadeImports = [...new Set([...facade.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]!))];
  assert.deepEqual(facadeImports, ['./agentctl-core.ts']);
  assert.doesNotMatch(facade, /export\s+function\s+runCliForNoToolFakeTest|allowTestOnlyRun/);
  assert.match(facade, /runCliInternal\(argv,\s*createApplication,\s*false\)/);

  const core = await readFile(join(root, 'src/interfaces/cli/agentctl-core.ts'), 'utf8');
  const coreImports = [...core.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  assert.ok(coreImports.length > 0);
  for (const specifier of coreImports) {
    assert.match(specifier, /^(?:node:|\.\.\/\.\.\/(?:application|domain)\/)/, specifier);
  }
});

test('production CLI composition wires only the G2.1 read-only Ollama smoke port', async () => {
  const source = await readFile(join(root, 'src/composition/local-cli.ts'), 'utf8');
  assert.match(source, /testRegistry:\s*\{\s*isRegistered:\s*\(\)\s*=>\s*false\s*\}/);
  assert.match(source, /OllamaReadOnlySmokeAdapter/);
  assert.doesNotMatch(source, /generatedCodeGate\s*:|patches\s*:|testRunner\s*:|FakeAgentAdapter|OllamaAgentAdapter|Claude|Codex/);
  assert.match(source, /local_runtime_unavailable/);
  assert.match(source, /external_evaluator_unavailable/);
});
