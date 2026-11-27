import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAgentProposal } from '../tools/tool-gateway.ts';
import { createUnifiedDiff, LineDiffError } from './line-diff.ts';

type ApplyUnifiedPatch = (workspaceRoot: string, patchText: string, allowedGlobs: string[]) => Promise<string[]>;

function findRepoRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(directory, 'bench', 'evaluator', 'unified-diff.mjs'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Repository root not found');
    directory = parent;
  }
}

const repoRoot = findRepoRoot();
const { applyUnifiedPatch } = await import(
  pathToFileURL(path.join(repoRoot, 'bench', 'evaluator', 'unified-diff.mjs')).href
) as { applyUnifiedPatch: ApplyUnifiedPatch };

async function roundTrip(relativePath: string, before: string, after: string): Promise<string> {
  const diff = createUnifiedDiff(relativePath, before, after);
  const root = await mkdtemp(path.join(tmpdir(), 'line-diff-'));
  try {
    const target = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, before);
    assert.deepEqual(await applyUnifiedPatch(root, diff, [relativePath]), [relativePath]);
    const result = await readFile(target);
    assert.ok(result.equals(Buffer.from(after, 'utf8')), `round trip mismatch for diff:\n${diff}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return diff;
}

const lines = (count: number, prefix = 'line'): string[] => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
const text = (values: readonly string[]): string => `${values.join('\n')}\n`;
const base = lines(20);

test('uses the B01 reference patch layout', async () => {
  const before = text([
    'export function sumRange(values, start, end) {',
    '  let total = 0;',
    '  for (let index = start; index < end; index += 1) {',
    '    total += values[index];',
    '  }',
    '  return total;',
    '}',
  ]);
  const after = before.replace('index < end', 'index <= end');
  const reference = (await readFile(path.join(repoRoot, 'bench', 'tasks', 'B01', 'reference.patch'), 'utf8'))
    .replace(/\r\n/g, '\n');
  const diff = await roundTrip('src/sum-range.mjs', before, after);
  // Same file headers and change rows; the hand-written reference keeps one extra trailing context line.
  assert.deepEqual(diff.split('\n').slice(0, 3), reference.split('\n').slice(0, 3));
  assert.equal(diff.split('\n')[3], '@@ -1,6 +1,6 @@');
  assert.equal(diff.split('\n').slice(4, -1).join('\n'), reference.split('\n').slice(4, 11).join('\n'));
  assert.ok(diff.endsWith('\n'));
});

test('round trip: one changed line', async () => {
  const after = [...base];
  after[9] = 'changed 10';
  const diff = await roundTrip('src/one.mjs', text(base), text(after));
  assert.match(diff, /^@@ -7,7 \+7,7 @@$/m);
});

test('round trip: two distant hunks', async () => {
  const after = [...base];
  after[1] = 'changed 2';
  after[17] = 'changed 18';
  const diff = await roundTrip('src/two.mjs', text(base), text(after));
  assert.deepEqual(diff.match(/^@@ .* @@$/gm), ['@@ -1,5 +1,5 @@', '@@ -15,6 +15,6 @@']);
});

test('round trip: nearby changes merge into one hunk', async () => {
  const after = [...base];
  after[4] = 'changed 5';
  after[10] = 'changed 11';
  const diff = await roundTrip('src/merge.mjs', text(base), text(after));
  assert.deepEqual(diff.match(/^@@ .* @@$/gm), ['@@ -2,13 +2,13 @@']);
});

test('round trip: add at the start', async () => {
  const diff = await roundTrip('src/start.mjs', text(base), text(['new a', 'new b', ...base]));
  assert.match(diff, /^@@ -1,3 \+1,5 @@$/m);
});

test('round trip: add at the end', async () => {
  const diff = await roundTrip('src/end.mjs', text(base), text([...base, 'new a', 'new b']));
  assert.match(diff, /^@@ -18,3 \+18,5 @@$/m);
});

test('round trip: delete lines', async () => {
  const after = base.filter((_, index) => index < 5 || index > 8);
  const diff = await roundTrip('src/delete.mjs', text(base), text(after));
  assert.match(diff, /^@@ -3,10 \+3,6 @@$/m);
});

test('round trip: replace all lines', async () => {
  await roundTrip('src/replace.mjs', text(base), text(lines(7, 'other')));
});

test('round trip: interleaved edits and blank lines', async () => {
  const before = text(['a', '', 'b', 'c', '', 'd', 'e', 'f', '', 'g', 'h', 'i', 'j', 'k']);
  const after = text(['x', 'a', '', 'c', 'C', '', 'd', 'e', 'f', 'g', '', 'h', 'j', 'k', 'l']);
  await roundTrip('src/mixed.mjs', before, after);
});

test('the tool gateway accepts a proposal that holds the produced diff', () => {
  const after = [...base];
  after[3] = 'changed 4';
  const diff = createUnifiedDiff('src/gateway.mjs', text(base), text(after));
  const proposal = parseAgentProposal({
    proposalId: 'line-diff-proposal',
    toolRequests: [{ operation: 'apply_unified_diff', diff }],
  });
  assert.deepEqual(proposal.toolRequests, [{ operation: 'apply_unified_diff', diff }]);
});

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof LineDiffError && error.code === code);
}

test('refuses CR and text without a final LF as unsupported_text_format', () => {
  assertCode(() => createUnifiedDiff('src/a.mjs', 'a\r\nb\r\n', 'a\n'), 'unsupported_text_format');
  assertCode(() => createUnifiedDiff('src/a.mjs', 'a\n', 'a\rb\n'), 'unsupported_text_format');
  assertCode(() => createUnifiedDiff('src/a.mjs', 'a\nb', 'a\n'), 'unsupported_text_format');
  assertCode(() => createUnifiedDiff('src/a.mjs', 'a\n', 'b'), 'unsupported_text_format');
  assertCode(() => createUnifiedDiff('src/a.mjs', '', 'a\n'), 'unsupported_text_format');
});

test('refuses input over 2,000 lines or 64 KiB as input_too_large', () => {
  assert.doesNotThrow(() => createUnifiedDiff('src/a.mjs', text(lines(2_000)), text(lines(1_999))));
  assertCode(() => createUnifiedDiff('src/a.mjs', text(lines(2_001)), 'a\n'), 'input_too_large');
  assertCode(() => createUnifiedDiff('src/a.mjs', 'a\n', text(lines(2_001))), 'input_too_large');
  assertCode(() => createUnifiedDiff('src/a.mjs', `${'x'.repeat(65_536)}\n`, 'a\n'), 'input_too_large');
});

test('refuses equal texts as no_change', () => {
  assertCode(() => createUnifiedDiff('src/a.mjs', text(base), text(base)), 'no_change');
});

test('refuses unsafe paths as invalid_path', () => {
  for (const unsafe of ['', '/etc/passwd', 'C:/x.mjs', 'src\\a.mjs', '../a.mjs', 'src/./a.mjs', '.env', 'src/.env.local',
    'src//a.mjs', 'src/CON', 'a:b.mjs']) {
    assertCode(() => createUnifiedDiff(unsafe, 'a\n', 'b\n'), 'invalid_path');
  }
});
