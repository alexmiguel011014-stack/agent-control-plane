import { isSafeDeclaredTestPath } from '../domain/tools.ts';

export type LineDiffErrorCode = 'unsupported_text_format' | 'input_too_large' | 'no_change' | 'invalid_path';

export class LineDiffError extends Error {
  readonly code: LineDiffErrorCode;

  constructor(code: LineDiffErrorCode) {
    super(code);
    this.name = 'LineDiffError';
    this.code = code;
  }
}

export const LINE_DIFF_LIMITS = Object.freeze({
  contextLines: 3,
  maxLines: 2_000,
  maxBytes: 65_536,
});

type Row = Readonly<{ kind: ' ' | '-' | '+'; text: string }>;

function splitLines(text: unknown): string[] {
  if (typeof text !== 'string' || text.includes('\r') || !text.endsWith('\n')) {
    throw new LineDiffError('unsupported_text_format');
  }
  if (Buffer.byteLength(text, 'utf8') > LINE_DIFF_LIMITS.maxBytes) throw new LineDiffError('input_too_large');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > LINE_DIFF_LIMITS.maxLines) throw new LineDiffError('input_too_large');
  return lines;
}

/** Deterministic LCS edit script; deletions are emitted before insertions at each change point. */
function editScript(before: readonly string[], after: readonly string[]): Row[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;

  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // lcs[i * width + j] = LCS length of a[i..] and b[j..].
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const rows: Row[] = before.slice(0, prefix).map((text) => ({ kind: ' ', text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      rows.push({ kind: ' ', text: a[i]! });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      rows.push({ kind: '-', text: a[i]! });
      i += 1;
    } else {
      rows.push({ kind: '+', text: b[j]! });
      j += 1;
    }
  }
  for (const text of before.slice(before.length - suffix)) rows.push({ kind: ' ', text });
  return rows;
}

function hunkRange(start: number, count: number): string {
  // A zero-length range names the line before it, as git does.
  return `${count === 0 ? start - 1 : start},${count}`;
}

/**
 * Returns a single-file git-style unified diff (`diff --git`, `---`, `+++`, hunks)
 * with 3 lines of context, for LF-terminated text only.
 */
export function createUnifiedDiff(relativePath: string, before: string, after: string): string {
  if (!isSafeDeclaredTestPath(relativePath)) throw new LineDiffError('invalid_path');
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  if (before === after) throw new LineDiffError('no_change');

  const rows = editScript(oldLines, newLines);
  const context = LINE_DIFF_LIMITS.contextLines;
  const changed: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== ' ') changed.push(index);
  });

  // Group change rows into hunk ranges; ranges whose context would touch or overlap are merged.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length, index + context + 1);
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  // 1-based line numbers of the next old and new line before each row.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const row of rows) {
    oldAt.push(oldLine);
    newAt.push(newLine);
    if (row.kind !== '+') oldLine += 1;
    if (row.kind !== '-') newLine += 1;
  }

  const output = [`diff --git a/${relativePath} b/${relativePath}`, `--- a/${relativePath}`, `+++ b/${relativePath}`];
  for (const range of ranges) {
    const slice = rows.slice(range.start, range.end);
    const oldCount = slice.filter((row) => row.kind !== '+').length;
    const newCount = slice.filter((row) => row.kind !== '-').length;
    output.push(`@@ -${hunkRange(oldAt[range.start]!, oldCount)} +${hunkRange(newAt[range.start]!, newCount)} @@`);
    for (const row of slice) output.push(`${row.kind}${row.text}`);
  }
  return `${output.join('\n')}\n`;
}
