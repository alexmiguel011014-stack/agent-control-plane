// Dry-run report: which unchecked GOALS items could be offloaded. Read-only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A "disposable repository root" is the path prefix `disposable/`.
const DISPOSABLE_PREFIXES = ['bench/tasks/', 'disposable/'];
const ITEM_RE = /^- \[ \] \*\*(G[0-9]+\.[0-9]+) /;

export function parseItems(text) {
  const items = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = ITEM_RE.exec(line);
    if (m) {
      cur = { id: m[1], fields: {} };
      items.push(cur);
      continue;
    }
    if (/^- \[[xX]\] /.test(line) || /^#/.test(line)) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    const f = /^ {2}- (tier|gate|files|check):\s*(.*)$/.exec(line);
    if (f && !(f[1] in cur.fields)) cur.fields[f[1]] = f[2];
  }
  return items;
}

export function filePaths(value = '') {
  return [...value.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
}

export function classify({ fields }) {
  if (!(fields.tier ?? '').startsWith('light')) return 'tier_not_light';
  if ((fields.gate ?? '').trim() !== 'auto') return 'gate_not_auto';
  const paths = filePaths(fields.files);
  if (paths.length !== 1) return 'not_one_file';
  if (!DISPOSABLE_PREFIXES.some((p) => paths[0].startsWith(p))) return 'not_disposable_path';
  const check = fields.check ?? '';
  if (!(/`[^`]+`/.test(check) || /\brun\b/.test(check))) return 'no_check_command';
  return null;
}

export function scan(text) {
  const items = parseItems(text);
  const lines = [];
  let cands = 0;
  for (const it of items) {
    const reason = classify(it);
    if (reason) lines.push(`${it.id} not_candidate ${reason}`);
    else { cands++; lines.push(`${it.id} candidate -`); }
  }
  lines.push(`total: ${items.length} unchecked, ${cands} candidate`);
  return lines;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(scan(readFileSync(process.argv[2] ?? 'GOALS.md', 'utf8')).join('\n'));
}
