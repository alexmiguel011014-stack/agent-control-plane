// Training-data contamination check: fails when a row in train.jsonl/val.jsonl
// contains a bench symbol name (whole word) or a bench task prompt.
// Usage: node dev/training/check-contamination.mjs <dataDir> [tasksRoot]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const [dataDir, tasksArg] = process.argv.slice(2);
if (!dataDir) {
  console.error('usage: check-contamination.mjs <dataDir> [tasksRoot]');
  process.exit(2);
}
const tasksRoot = tasksArg ? resolve(tasksArg) : join(repoRoot, 'bench', 'tasks');

const rows = [];
for (const file of ['train.jsonl', 'val.jsonl']) {
  const p = join(dataDir, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (line.trim()) rows.push({ file, line });
  }
}

const names = new Set();
const sentences = new Set();
for (const t of readdirSync(tasksRoot, { withFileTypes: true })) {
  if (!t.isDirectory()) continue;
  const src = join(tasksRoot, t.name, 'base', 'src');
  if (existsSync(src)) {
    for (const f of readdirSync(src)) {
      if (!f.endsWith('.mjs')) continue;
      const text = readFileSync(join(src, f), 'utf8');
      for (const m of text.matchAll(/^\s*export\s+(?:function|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
        names.add(m[1]);
      }
    }
  }
  const tj = join(tasksRoot, t.name, 'task.json');
  if (existsSync(tj)) {
    const prompt = JSON.parse(readFileSync(tj, 'utf8')).prompt;
    if (typeof prompt === 'string' && prompt.trim()) sentences.add(prompt);
  }
}

const usable = [...names].filter((n) => n.length >= 4);
const skipped = names.size - usable.length;
const regexes = usable.map((n) => [n, new RegExp(`(?<![A-Za-z0-9_$])${n.replace(/\$/g, '\$')}(?![A-Za-z0-9_$])`)]);

const hits = [];
rows.forEach((row, i) => {
  // System messages are the adapter's fixed prompts, not generated content, so they are not scanned.
  // Chat rows are scanned by their non-system messages; any other row shape is scanned as a whole line.
  let source = null;
  try {
    const value = JSON.parse(row.line);
    if (value && Array.isArray(value.messages)) source = value.messages.filter((m) => m && m.role !== 'system');
    else source = value;
  } catch { /* keep the raw line only */ }
  const walk = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? Object.values(v).map(walk).join(' ') : '');
  // Match against the raw text and the decoded text so JSON escaping cannot hide a hit.
  const hay = source === null
    ? [row.line]
    : [JSON.stringify(source), walk(source) || JSON.stringify(source)];
  for (const [n, re] of regexes) {
    if (hay.some((h) => re.test(h))) hits.push({ file: row.file, row: i + 1, kind: 'name', match: n });
  }
  for (const s of sentences) {
    if (hay.some((h) => h.includes(s))) hits.push({ file: row.file, row: i + 1, kind: 'sentence', match: s.slice(0, 60) });
  }
});

console.log(JSON.stringify({
  rows: rows.length,
  forbiddenNames: usable.length,
  skippedShortNames: skipped,
  forbiddenSentences: sentences.size,
  hits,
}));
process.exit(hits.length ? 1 : 0);
