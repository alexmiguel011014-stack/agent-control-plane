// Generates the extended integration corpus I07-I30 under bench/tasks, bench/oracles and prints the registry
// lines to add. Each task has two modules; exactly one holds the defect (max_changed_files = 1), a two-case public
// test, a four-case hidden oracle, a reference patch and an empty null patch. Every task is self-checked: the fixed
// module passes all cases and the base fails at least one public case and at least one oracle case.
// Domains avoid I01-I06, P/B/S and the synthetic training templates. Usage: node dev/bench/gen-i-tasks.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSnapshotManifest, snapshotId } from '../../src/snapshots/snapshot-core.mjs';
import { createUnifiedDiff } from '../../src/adapters/line-diff.ts';

const root = resolve(import.meta.dirname, '..', '..');
const code = String.raw;
const frozenArgs = true;

const TASKS = [
  {
    id: 'I07', noMutate: true, entry: ['src/reserve.mjs', 'reserveStock'], defective: 'src/reserve.mjs',
    prompt: 'Fix reserveStock(stock, requests). Process the requests in order; each one reserves the smaller of its qty and the units still available for its sku, and any shortfall is reported in shortages. A sku that is missing from stock or has a non-positive count has 0 units. The caller stock object must not be changed. Return { reserved, shortages } keyed by sku, leaving out zero entries.',
    files: {
      'src/stock.mjs': code`export function availableUnits(stock, sku) {
  const units = stock[sku];
  return Number.isInteger(units) && units > 0 ? units : 0;
}
`,
      'src/reserve.mjs': code`import { availableUnits } from './stock.mjs';

export function reserveStock(stock, requests) {
  const reserved = {};
  const shortages = {};
  for (const request of requests) {
    const take = Math.min(request.qty, availableUnits(stock, request.sku));
    stock[request.sku] = availableUnits(stock, request.sku) - take;
    if (take > 0) reserved[request.sku] = (reserved[request.sku] ?? 0) + take;
    if (take < request.qty) shortages[request.sku] = (shortages[request.sku] ?? 0) + (request.qty - take);
  }
  return { reserved, shortages };
}
`,
    },
    fixed: code`import { availableUnits } from './stock.mjs';

export function reserveStock(stock, requests) {
  const remaining = { ...stock };
  const reserved = {};
  const shortages = {};
  for (const request of requests) {
    const take = Math.min(request.qty, availableUnits(remaining, request.sku));
    remaining[request.sku] = availableUnits(remaining, request.sku) - take;
    if (take > 0) reserved[request.sku] = (reserved[request.sku] ?? 0) + take;
    if (take < request.qty) shortages[request.sku] = (shortages[request.sku] ?? 0) + (request.qty - take);
  }
  return { reserved, shortages };
}
`,
    pub: [
      [{ a: 5, b: 1 }, [{ sku: 'a', qty: 3 }, { sku: 'a', qty: 4 }, { sku: 'b', qty: 1 }]],
      [{ x: 2 }, [{ sku: 'x', qty: 1 }]],
    ],
    ora: [
      [{ a: 1 }, [{ sku: 'a', qty: 3 }]],
      [{}, [{ sku: 'z', qty: 2 }]],
      [{ a: -4, b: 2.5 }, [{ sku: 'a', qty: 1 }, { sku: 'b', qty: 1 }]],
      [{ a: 3 }, []],
    ],
  },
  {
    id: 'I08', entry: ['src/tags.mjs', 'normalizeTags'], defective: 'src/text-utils.mjs',
    prompt: 'Fix normalizeTags(input). Split a comma separated string, trim every tag, lowercase it, drop empty tags, drop repeated tags keeping the first occurrence, and return at most five tags in order.',
    files: {
      'src/text-utils.mjs': code`export function cleanToken(raw) {
  return String(raw).toLowerCase();
}
`,
      'src/tags.mjs': code`import { cleanToken } from './text-utils.mjs';

export function normalizeTags(input) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(input).split(',')) {
    const tag = cleanToken(raw);
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length === 5) break;
  }
  return tags;
}
`,
    },
    fixed: code`export function cleanToken(raw) {
  return String(raw).trim().toLowerCase();
}
`,
    pub: [['Red, blue ,RED'], [' a ,b']],
    ora: [['x,,  ,Y'], ['a,b,c,d,e,f,g'], [' A , a ,B'], ['   ']],
  },
  {
    id: 'I09', entry: ['src/pagination.mjs', 'pageWindow'], defective: 'src/clamp.mjs',
    prompt: 'Fix pageWindow(current, total, radius). Clamp the current page into 1..total, then return the consecutive page numbers from current - radius to current + radius, limited to 1..total.',
    files: {
      'src/clamp.mjs': code`export function clampInt(value, low, high) {
  return Math.min(low, Math.max(high, value));
}
`,
      'src/pagination.mjs': code`import { clampInt } from './clamp.mjs';

export function pageWindow(current, total, radius) {
  const page = clampInt(current, 1, total);
  const first = clampInt(page - radius, 1, total);
  const last = clampInt(page + radius, 1, total);
  const pages = [];
  for (let n = first; n <= last; n += 1) pages.push(n);
  return pages;
}
`,
    },
    fixed: code`export function clampInt(value, low, high) {
  return Math.max(low, Math.min(high, value));
}
`,
    pub: [[5, 10, 2], [1, 10, 2]],
    ora: [[0, 10, 1], [99, 10, 1], [4, 3, 5], [2, 1, 3]],
  },
  {
    id: 'I10', entry: ['src/range.mjs', 'satisfies'], defective: 'src/version.mjs',
    prompt: 'Fix satisfies(version, range) for dotted numeric versions such as 1.10.0 and a single comparator range such as >=1.2, <2.0.0, > 1.9 or 1.4.2 (exact match). Compare each part as a number and treat missing parts as 0. Return false when the range is not one comparator followed by a version.',
    files: {
      'src/version.mjs': code`export function parseVersion(text) {
  return String(text).split('.').map((part) => part);
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}
`,
      'src/range.mjs': code`import { compareVersions } from './version.mjs';

export function satisfies(version, range) {
  const match = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})$/.exec(range.trim());
  if (!match) return false;
  const order = compareVersions(version, match[2]);
  switch (match[1] ?? '=') {
    case '>=': return order >= 0;
    case '<=': return order <= 0;
    case '>': return order > 0;
    case '<': return order < 0;
    default: return order === 0;
  }
}
`,
    },
    fixed: code`export function parseVersion(text) {
  const parts = String(text).split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}
`,
    pub: [['1.10.0', '>=1.9.0'], ['1.2', '1.2.0']],
    ora: [['2.0.0', '<1.10'], ['1.9.9', '< 1.10'], ['1.0', 'bad'], ['0.9', '>=1.0.0']],
  },
  {
    id: 'I11', noMutate: true, entry: ['src/merge-intervals.mjs', 'mergeIntervals'], defective: 'src/interval.mjs',
    prompt: 'Fix mergeIntervals(intervals). Return the union of the { start, end } intervals sorted by start. Intervals that overlap or merely touch (one ends where the next starts) become one interval. Do not mutate the input.',
    files: {
      'src/interval.mjs': code`export function overlaps(a, b) {
  return a.end > b.start && b.end > a.start;
}
`,
      'src/merge-intervals.mjs': code`import { overlaps } from './interval.mjs';

export function mergeIntervals(intervals) {
  const sorted = intervals.map((item) => ({ start: item.start, end: item.end })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && overlaps(last, item)) last.end = Math.max(last.end, item.end);
    else merged.push(item);
  }
  return merged;
}
`,
    },
    fixed: code`export function overlaps(a, b) {
  return a.end >= b.start && b.end >= a.start;
}
`,
    pub: [[[{ start: 1, end: 3 }, { start: 3, end: 5 }]], [[{ start: 5, end: 6 }, { start: 1, end: 2 }]]],
    ora: [[[{ start: 1, end: 4 }, { start: 2, end: 3 }]], [[{ start: 1, end: 2 }, { start: 4, end: 5 }]], [[]], [[{ start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }]]],
  },
  {
    id: 'I12', entry: ['src/backoff.mjs', 'nextDelay'], defective: 'src/backoff.mjs',
    prompt: 'Fix nextDelay(attempt, baseMs, capMs). The first attempt waits baseMs, every later attempt doubles the previous wait, and no wait exceeds capMs. An attempt that is not an integer of at least 1 waits 0.',
    files: {
      'src/power.mjs': code`export function doubled(times) {
  let result = 1;
  for (let i = 0; i < times; i += 1) result *= 2;
  return result;
}
`,
      'src/backoff.mjs': code`import { doubled } from './power.mjs';

export function nextDelay(attempt, baseMs, capMs) {
  if (!Number.isInteger(attempt) || attempt < 1) return 0;
  return Math.min(capMs, baseMs * doubled(attempt));
}
`,
    },
    fixed: code`import { doubled } from './power.mjs';

export function nextDelay(attempt, baseMs, capMs) {
  if (!Number.isInteger(attempt) || attempt < 1) return 0;
  return Math.min(capMs, baseMs * doubled(attempt - 1));
}
`,
    pub: [[1, 100, 10000], [4, 100, 10000]],
    ora: [[10, 100, 1000], [0, 100, 1000], [2.5, 100, 1000], [3, 50, 1000]],
  },
  {
    id: 'I13', entry: ['src/wrap.mjs', 'wrapText'], defective: 'src/chunks.mjs',
    prompt: 'Fix wrapText(text, width). Words are separated by spaces. Fill each line greedily with whole words up to width characters, and cut a word longer than width into pieces of at most width characters that then follow the same rules. Ignore repeated spaces. Return the array of lines.',
    files: {
      'src/chunks.mjs': code`export function splitLong(word, width) {
  const parts = [];
  for (let i = 0; i + width < word.length; i += width) parts.push(word.slice(i, i + width));
  return parts;
}
`,
      'src/wrap.mjs': code`import { splitLong } from './chunks.mjs';

export function wrapText(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(' ').filter((w) => w !== '')) {
    for (const piece of word.length > width ? splitLong(word, width) : [word]) {
      if (current === '') current = piece;
      else if (current.length + 1 + piece.length <= width) current += ' ' + piece;
      else {
        lines.push(current);
        current = piece;
      }
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}
`,
    },
    fixed: code`export function splitLong(word, width) {
  const parts = [];
  for (let i = 0; i < word.length; i += width) parts.push(word.slice(i, i + width));
  return parts;
}
`,
    pub: [['the quick brown fox', 10], ['abcdefg', 3]],
    ora: [['abcdefghij', 4], ['a  b', 3], ['', 5], ['xx yyyyyy zz', 3]],
  },
  {
    id: 'I14', noMutate: true, entry: ['src/percentile.mjs', 'percentile'], defective: 'src/sorting.mjs',
    prompt: 'Fix percentile(values, p) using the nearest-rank method: sort the numbers ascending as numbers, take rank = ceil(p / 100 * count) with a minimum of 1, and return the value at that rank. An empty array returns null. Do not mutate the input.',
    files: {
      'src/sorting.mjs': code`export function sortedCopy(values) {
  return [...values].sort();
}
`,
      'src/percentile.mjs': code`import { sortedCopy } from './sorting.mjs';

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = sortedCopy(values);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}
`,
    },
    fixed: code`export function sortedCopy(values) {
  return [...values].sort((a, b) => a - b);
}
`,
    pub: [[[15, 20, 35, 40, 50, 9, 100], 50], [[10, 2], 100]],
    ora: [[[3, 1, 2], 100], [[], 50], [[7], 0], [[10, 2, 33], 50]],
  },
  {
    id: 'I15', entry: ['src/query.mjs', 'buildQuery'], defective: 'src/pair.mjs',
    prompt: 'Fix buildQuery(params). Return the query string with keys sorted alphabetically and joined by &. Skip keys whose value is null or undefined; repeat the key once per array item; percent-encode both keys and values with encodeURIComponent. An empty object gives an empty string.',
    files: {
      'src/pair.mjs': code`export function encodePair(key, value) {
  return key + '=' + encodeURIComponent(String(value));
}
`,
      'src/query.mjs': code`import { encodePair } from './pair.mjs';

export function buildQuery(params) {
  const parts = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) parts.push(encodePair(key, item));
  }
  return parts.join('&');
}
`,
    },
    fixed: code`export function encodePair(key, value) {
  return encodeURIComponent(key) + '=' + encodeURIComponent(String(value));
}
`,
    pub: [[{ 'a b': 'x&y', c: [1, 2] }], [{ q: 'café' }]],
    ora: [[{}], [{ z: 1, a: undefined, m: null }], [{ 'k=1': 'v v' }], [{ t: [] , s: 'ok' }]],
  },
  {
    id: 'I16', entry: ['src/status-label.mjs', 'statusLabel'], defective: 'src/status-label.mjs',
    prompt: 'Fix statusLabel(code). Look the code up in the status table ignoring letter case and surrounding spaces. A code that is not in the table, including inherited names such as constructor and non-text values, returns "Unknown (" followed by the original code and ")".',
    files: {
      'src/status-table.mjs': code`export const STATUS_LABELS = Object.freeze({ open: 'Open', in_progress: 'In progress', done: 'Done' });
`,
      'src/status-label.mjs': code`import { STATUS_LABELS } from './status-table.mjs';

export function statusLabel(code) {
  return STATUS_LABELS[code] || 'Unknown (' + code + ')';
}
`,
    },
    fixed: code`import { STATUS_LABELS } from './status-table.mjs';

export function statusLabel(code) {
  const key = typeof code === 'string' ? code.trim().toLowerCase() : '';
  return Object.hasOwn(STATUS_LABELS, key) ? STATUS_LABELS[key] : 'Unknown (' + code + ')';
}
`,
    pub: [['IN_PROGRESS'], [' done ']],
    ora: [['constructor'], [7], ['Archived'], ['OPEN ']],
  },
  {
    id: 'I17', entry: ['src/discount.mjs', 'applyDiscount'], defective: 'src/percent.mjs',
    prompt: 'Fix applyDiscount(subtotalCents, rule). A percent rule takes rule.value percent of the subtotal rounded to the nearest cent with halves rounded up; a fixed rule takes rule.value cents; any other or missing rule takes 0. The discount never exceeds the subtotal and is never negative. Return { discountCents, totalCents }.',
    files: {
      'src/percent.mjs': code`export function percentOf(cents, percent) {
  return Math.floor((cents * percent) / 100);
}
`,
      'src/discount.mjs': code`import { percentOf } from './percent.mjs';

export function applyDiscount(subtotalCents, rule) {
  let discount = 0;
  if (rule && rule.type === 'percent') discount = percentOf(subtotalCents, rule.value);
  else if (rule && rule.type === 'fixed') discount = rule.value;
  discount = Math.min(Math.max(discount, 0), subtotalCents);
  return { discountCents: discount, totalCents: subtotalCents - discount };
}
`,
    },
    fixed: code`export function percentOf(cents, percent) {
  return Math.round((cents * percent) / 100);
}
`,
    pub: [[1005, { type: 'percent', value: 10 }], [1000, { type: 'fixed', value: 1500 }]],
    ora: [[999, { type: 'percent', value: 15 }], [500, null], [200, { type: 'fixed', value: -5 }], [333, { type: 'percent', value: 50 }]],
  },
  {
    id: 'I18', entry: ['src/parse-lines.mjs', 'parseKeyValueLines'], defective: 'src/split.mjs',
    prompt: 'Fix parseKeyValueLines(text). Each line is key = value. Ignore blank lines and lines starting with #. Split at the first = only, so a value may contain further = signs. Trim key and value, skip lines whose key is empty, let a later duplicate key win, and give a line without = an empty value.',
    files: {
      'src/split.mjs': code`export function splitOnce(line, separator) {
  const parts = line.split(separator);
  return [parts[0], parts[1] ?? ''];
}
`,
      'src/parse-lines.mjs': code`import { splitOnce } from './split.mjs';

export function parseKeyValueLines(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [key, value] = splitOnce(line, '=');
    if (key.trim() === '') continue;
    result[key.trim()] = value.trim();
  }
  return result;
}
`,
    },
    fixed: code`export function splitOnce(line, separator) {
  const index = line.indexOf(separator);
  if (index === -1) return [line, ''];
  return [line.slice(0, index), line.slice(index + separator.length)];
}
`,
    pub: [['a=1\nb = x=y'], ['host = db.local=5432']],
    ora: [['# c\n\nk'], ['a=1\na=2'], ['=v\nq= w '], ['k = v=w\r\nz=1']],
  },
  {
    id: 'I19', entry: ['src/chunk-budget.mjs', 'chunkByBudget'], defective: 'src/chunk-budget.mjs',
    prompt: 'Fix chunkByBudget(items, budget). Group the items in their original order into chunks whose total size (item.size; a missing or negative size counts as 0) does not exceed budget, so a chunk may exactly reach the budget. An item larger than the budget sits alone in its own chunk. Return an array of arrays.',
    files: {
      'src/size.mjs': code`export function sizeOf(item) {
  return typeof item.size === 'number' && item.size > 0 ? item.size : 0;
}
`,
      'src/chunk-budget.mjs': code`import { sizeOf } from './size.mjs';

export function chunkByBudget(items, budget) {
  const chunks = [];
  let current = [];
  let used = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && used + size >= budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
`,
    },
    fixed: code`import { sizeOf } from './size.mjs';

export function chunkByBudget(items, budget) {
  const chunks = [];
  let current = [];
  let used = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && used + size > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
`,
    pub: [[[{ id: 'a', size: 5 }, { id: 'b', size: 5 }, { id: 'c', size: 1 }], 10], [[{ id: 'a', size: 4 }, { id: 'b', size: 4 }, { id: 'c', size: 4 }], 8]],
    ora: [[[{ id: 'big', size: 20 }, { id: 'x', size: 1 }], 10], [[], 10], [[{ id: 'a' }, { id: 'b', size: -3 }], 1], [[{ id: 'a', size: 3 }, { id: 'b', size: 3 }, { id: 'c', size: 4 }], 10]],
  },
  {
    id: 'I20', noMutate: true, entry: ['src/rank.mjs', 'rankScores'], defective: 'src/compare.mjs',
    prompt: 'Fix rankScores(entries). Sort the entries by score from highest to lowest, ties by name ascending, and give each a competition rank: equal scores share a rank and the next rank skips (1, 2, 2, 4). Return new { name, score, rank } objects and do not change the input.',
    files: {
      'src/compare.mjs': code`export function compareEntries(a, b) {
  if (a.score !== b.score) return a.score - b.score;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
`,
      'src/rank.mjs': code`import { compareEntries } from './compare.mjs';

export function rankScores(entries) {
  const sorted = entries.map((entry) => ({ name: entry.name, score: entry.score })).sort(compareEntries);
  let rank = 0;
  return sorted.map((entry, index) => {
    if (index === 0 || entry.score !== sorted[index - 1].score) rank = index + 1;
    return { name: entry.name, score: entry.score, rank };
  });
}
`,
    },
    fixed: code`export function compareEntries(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
`,
    pub: [[[{ name: 'ann', score: 10 }, { name: 'bob', score: 30 }, { name: 'cy', score: 20 }]], [[{ name: 'b', score: 5 }, { name: 'a', score: 5 }]]],
    ora: [[[{ name: 'a', score: 9 }, { name: 'b', score: 7 }, { name: 'c', score: 7 }, { name: 'd', score: 1 }]], [[]], [[{ name: 'z', score: 0 }]], [[{ name: 'q', score: 3 }, { name: 'p', score: 3 }, { name: 'r', score: 3 }]]],
  },
  {
    id: 'I21', entry: ['src/bytes.mjs', 'formatBytes'], defective: 'src/trim.mjs',
    prompt: 'Fix formatBytes(bytes). Use the units B, KB, MB, GB and TB with 1024 per step. Show whole bytes without decimals and larger units with one decimal that is dropped when it is .0 (1536 gives 1.5 KB, 2048 gives 2 KB). A negative or non-finite input returns "invalid".',
    files: {
      'src/trim.mjs': code`export function trimZeros(text) {
  return text.replace(/0+$/, '').replace(/\.$/, '');
}
`,
      'src/bytes.mjs': code`import { trimZeros } from './trim.mjs';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'invalid';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return trimZeros(value.toFixed(unit === 0 ? 0 : 1)) + ' ' + UNITS[unit];
}
`,
    },
    fixed: code`export function trimZeros(text) {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}
`,
    pub: [[1536], [100]],
    ora: [[2048], [0], [10485760], [-1]],
  },
  {
    id: 'I22', entry: ['src/group-by-day.mjs', 'groupByDay'], defective: 'src/day.mjs',
    prompt: 'Fix groupByDay(events). Each event has at (an ISO date-time such as 2026-03-04T23:10:00Z) and a numeric value. Group the events by the calendar date written in the text (its first 10 characters) and return { day, total } objects sorted by day ascending, with the values summed.',
    files: {
      'src/day.mjs': code`export function dayKey(iso) {
  return String(iso).split(' ')[0];
}
`,
      'src/group-by-day.mjs': code`import { dayKey } from './day.mjs';

export function groupByDay(events) {
  const totals = new Map();
  for (const event of events) {
    const key = dayKey(event.at);
    totals.set(key, (totals.get(key) ?? 0) + event.value);
  }
  return [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, total]) => ({ day, total }));
}
`,
    },
    fixed: code`export function dayKey(iso) {
  return String(iso).slice(0, 10);
}
`,
    pub: [[[{ at: '2026-03-04T23:10:00Z', value: 2 }, { at: '2026-03-04T01:00:00Z', value: 3 }]], [[{ at: '2026-03-05T00:00:00Z', value: 1 }, { at: '2026-03-04T12:00:00Z', value: 4 }]]],
    ora: [[[]], [[{ at: '2026-01-31T23:59:59+02:00', value: 5 }]], [[{ at: '2026-02-01T00:00:00Z', value: 1.5 }, { at: '2026-02-01T10:00:00Z', value: 2.5 }]], [[{ at: '2026-12-31T10:00:00Z', value: 1 }, { at: '2026-01-01T10:00:00Z', value: 2 }]]],
  },
  {
    id: 'I23', entry: ['src/access.mjs', 'canAccess'], defective: 'src/roles.mjs',
    prompt: 'Fix canAccess(user, resource, action). A user has a roles array. A disabled user (disabled: true) or a missing user is always denied. The admin role may do anything. The viewer and editor roles may read. An editor may write only when user.orgId equals resource.orgId. Every other action is denied. Return true or false.',
    files: {
      'src/roles.mjs': code`export function hasRole(user, role) {
  return user.role === role;
}
`,
      'src/access.mjs': code`import { hasRole } from './roles.mjs';

export function canAccess(user, resource, action) {
  if (!user || user.disabled === true) return false;
  if (hasRole(user, 'admin')) return true;
  if (action === 'read') return hasRole(user, 'viewer') || hasRole(user, 'editor');
  if (action === 'write') return hasRole(user, 'editor') && user.orgId === resource.orgId;
  return false;
}
`,
    },
    fixed: code`export function hasRole(user, role) {
  return Array.isArray(user.roles) && user.roles.includes(role);
}
`,
    pub: [[{ roles: ['viewer'] }, { orgId: 1 }, 'read'], [{ roles: ['editor'], orgId: 1 }, { orgId: 1 }, 'write']],
    ora: [[{ roles: ['editor'], orgId: 1 }, { orgId: 2 }, 'write'], [{ roles: ['admin'], disabled: true }, { orgId: 1 }, 'read'], [{ roles: ['admin'] }, { orgId: 1 }, 'delete'], [{ roles: ['viewer', 'editor'], orgId: 3 }, { orgId: 3 }, 'write']],
  },
  {
    id: 'I24', entry: ['src/template.mjs', 'renderTemplate'], defective: 'src/escape.mjs',
    prompt: 'Fix renderTemplate(template, vars). Replace each {{name}} (spaces inside the braces are allowed) with the HTML-escaped value of vars[name], escaping &, < and > exactly once; a name missing from vars becomes an empty string. Substituted values are not scanned for further placeholders.',
    files: {
      'src/escape.mjs': code`export function escapeHtml(text) {
  return String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');
}
`,
      'src/template.mjs': code`import { escapeHtml } from './escape.mjs';

export function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name) => {
    return Object.hasOwn(vars, name) ? escapeHtml(vars[name]) : '';
  });
}
`,
    },
    fixed: code`export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
`,
    pub: [['<p>{{ t }}</p>', { t: 'a<b' }], ['{{a}}&{{b}}', { a: 'x', b: 'y' }]],
    ora: [['{{ missing }}!', {}], ['{{a}}', { a: '{{b}}', b: 'no' }], ['{{a}}', { a: 'Tom & "Jerry" > 1' }], ['no placeholders', { a: 1 }]],
  },
  {
    id: 'I25', entry: ['src/latest.mjs', 'latestByKey'], defective: 'src/newer.mjs',
    prompt: 'Fix latestByKey(records). Keep one record per key: the one with the highest version; when versions are equal the record that appears later in the input wins. List the keys in the order they first appear. Return new { key, version, payload } objects.',
    files: {
      'src/newer.mjs': code`export function isNewer(candidate, current) {
  return candidate.version > current.version;
}
`,
      'src/latest.mjs': code`import { isNewer } from './newer.mjs';

export function latestByKey(records) {
  const best = new Map();
  for (const record of records) {
    const current = best.get(record.key);
    if (current === undefined || isNewer(record, current)) best.set(record.key, record);
  }
  return [...best.values()].map((record) => ({ key: record.key, version: record.version, payload: record.payload }));
}
`,
    },
    fixed: code`export function isNewer(candidate, current) {
  return candidate.version >= current.version;
}
`,
    pub: [[[{ key: 'a', version: 1, payload: 'old' }, { key: 'a', version: 1, payload: 'new' }]], [[{ key: 'a', version: 2, payload: 'x' }, { key: 'a', version: 1, payload: 'y' }]]],
    ora: [[[{ key: 'b', version: 1, payload: 1 }, { key: 'a', version: 1, payload: 2 }, { key: 'b', version: 3, payload: 3 }]], [[]], [[{ key: 'k', version: 0, payload: null }]], [[{ key: 'a', version: 5, payload: 'p' }, { key: 'b', version: 5, payload: 'q' }, { key: 'a', version: 5, payload: 'r' }]]],
  },
  {
    id: 'I26', entry: ['src/compress.mjs', 'compressRanges'], defective: 'src/format-range.mjs',
    prompt: 'Fix compressRanges(numbers). Sort the integers and drop duplicates, then write runs of consecutive numbers: a run of three or more as first-last, a run of two as the two numbers separated by a comma, a single number alone, all joined by commas. For example [5,1,2,3,7,8,9,9] gives "1-3,5,7-9" and [1,2,4] gives "1,2,4".',
    files: {
      'src/format-range.mjs': code`export function formatRun(first, last) {
  if (first === last) return String(first);
  return first + '-' + last;
}
`,
      'src/compress.mjs': code`import { formatRun } from './format-range.mjs';

export function compressRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    parts.push(formatRun(sorted[start], sorted[end]));
    start = end + 1;
  }
  return parts.join(',');
}
`,
    },
    fixed: code`export function formatRun(first, last) {
  if (first === last) return String(first);
  if (last === first + 1) return first + ',' + last;
  return first + '-' + last;
}
`,
    pub: [[[5, 1, 2, 3, 7, 8, 9, 9]], [[1, 2, 4]]],
    ora: [[[]], [[4]], [[10, 11]], [[1, 2, 3, 4, 6, 7, 20]]],
  },
  {
    id: 'I27', noMutate: true, entry: ['src/redact.mjs', 'redactConfig'], defective: 'src/secret-key.mjs',
    prompt: 'Fix redactConfig(value). Return a deep copy in which the value of every object key containing password, token or secret in any letter case is replaced by the text ***, also inside nested objects and arrays. Other values are kept as they are and the input is not changed.',
    files: {
      'src/secret-key.mjs': code`export function isSecretKey(key) {
  return /(password|token)/.test(key);
}
`,
      'src/redact.mjs': code`import { isSecretKey } from './secret-key.mjs';

export function redactConfig(value) {
  if (Array.isArray(value)) return value.map((item) => redactConfig(item));
  if (value !== null && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = isSecretKey(key) ? '***' : redactConfig(item);
    }
    return copy;
  }
  return value;
}
`,
    },
    fixed: code`export function isSecretKey(key) {
  return /(password|token|secret)/i.test(key);
}
`,
    pub: [[{ user: 'ann', Password: 'p1' }], [{ db: { clientSecret: 'x', port: 5432 } }]],
    ora: [[{ list: [{ apiToken: 't', name: 'n' }] }], [{ plain: 'ok', n: 1, nothing: null }], [[{ SECRET_KEY: 1 }, 'text']], ['just text']],
  },
  {
    id: 'I28', entry: ['src/duration-text.mjs', 'formatDuration'], defective: 'src/duration-text.mjs',
    prompt: 'Fix formatDuration(ms). Show hours, minutes and seconds from a millisecond count, rounded down to whole seconds, leaving out leading zero units: 3723000 gives "1h 02m 03s", 125000 gives "2m 05s" and 4000 gives "4s". After the first unit, minutes and seconds use two digits.',
    files: {
      'src/pad.mjs': code`export function pad2(n) {
  return String(n).padStart(2, '0');
}
`,
      'src/duration-text.mjs': code`import { pad2 } from './pad.mjs';

export function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return hours + 'h ' + pad2(minutes) + 'm ' + pad2(seconds) + 's';
  if (minutes > 0) return minutes + 'm ' + pad2(seconds) + 's';
  return seconds + 's';
}
`,
    },
    fixed: code`import { pad2 } from './pad.mjs';

export function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  if (hours > 0) return hours + 'h ' + pad2(minutes) + 'm ' + pad2(seconds) + 's';
  if (minutes > 0) return minutes + 'm ' + pad2(seconds) + 's';
  return seconds + 's';
}
`,
    pub: [[3723000], [4000]],
    ora: [[60000], [3600000], [999], [86399000]],
  },
  {
    id: 'I29', entry: ['src/weighted.mjs', 'weightedAverage'], defective: 'src/round.mjs',
    prompt: 'Fix weightedAverage(items). Items are { score, weight }. Ignore items whose weight is not greater than 0 or whose score is not a finite number. Return the weighted mean rounded to two decimals with halves rounded up (1.005 becomes 1.01), or null when no item counts.',
    files: {
      'src/round.mjs': code`export function round2(value) {
  return Math.round(value * 100) / 100;
}
`,
      'src/weighted.mjs': code`import { round2 } from './round.mjs';

export function weightedAverage(items) {
  let total = 0;
  let weights = 0;
  for (const item of items) {
    if (!(item.weight > 0) || !Number.isFinite(item.score)) continue;
    total += item.score * item.weight;
    weights += item.weight;
  }
  return weights === 0 ? null : round2(total / weights);
}
`,
    },
    fixed: code`export function round2(value) {
  const text = String(value);
  if (!Number.isFinite(value) || text.includes('e')) return Math.round(value * 100) / 100;
  return Number(Math.round(Number(text + 'e2')) + 'e-2');
}
`,
    pub: [[[{ score: 1.005, weight: 1 }]], [[{ score: 10, weight: 1 }, { score: 20, weight: 3 }]]],
    ora: [[[{ score: 5, weight: 0 }]], [[{ score: 1, weight: 1 }, { score: 2, weight: 1 }, { score: 2.5, weight: 1 }]], [[{ score: 1.255, weight: 1 }]], [[{ score: 7, weight: 2 }, { score: null, weight: 5 }, { score: 9, weight: -1 }]]],
  },
  {
    id: 'I30', entry: ['src/route.mjs', 'matchRoute'], defective: 'src/path.mjs',
    prompt: 'Fix matchRoute(pattern, path). Segments are separated by /, and repeated or trailing slashes are ignored. A :name segment captures the matching path segment (percent-decoded) into the result; a * segment must be last and captures the remaining segments joined with / as rest (possibly empty); every other segment must match exactly. Return the params object, or null when the path does not match.',
    files: {
      'src/path.mjs': code`export function splitPath(path) {
  return path.split('/');
}
`,
      'src/route.mjs': code`import { splitPath } from './path.mjs';

export function matchRoute(pattern, path) {
  const wanted = splitPath(pattern);
  const actual = splitPath(path);
  const params = {};
  for (let i = 0; i < wanted.length; i += 1) {
    const part = wanted[i];
    if (part === '*') {
      params.rest = actual.slice(i).join('/');
      return params;
    }
    if (i >= actual.length) return null;
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(actual[i]);
    else if (part !== actual[i]) return null;
  }
  return wanted.length === actual.length ? params : null;
}
`,
    },
    fixed: code`export function splitPath(path) {
  return path.split('/').filter((segment) => segment !== '');
}
`,
    pub: [['/users/:id/', '/users/42'], ['/a/b', '/a//b/']],
    ora: [['/files/*', '/files/x/y.txt'], ['/files/*', '/files'], ['/u/:name', '/u/a%20b'], ['//x/:k//', '/x/9/']],
  },
];

// ---- case-data encoding ---------------------------------------------------------------------------------------
function encoder() {
  const nodes = [];
  const token = (value) => {
    if (value === undefined) return { $value: 'undefined' };
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
    const id = `n${nodes.length}`;
    const node = { id };
    nodes.push(node);
    if (Array.isArray(value)) {
      node.kind = 'array';
      node.items = value.map((item) => token(item));
    } else {
      node.kind = 'object';
      node.properties = Object.entries(value).map(([key, item]) => [key, token(item)]);
      if (frozenArgs && node.frozenFlag !== false) node.frozen = true;
    }
    return { $ref: id };
  };
  return { nodes, token };
}

function buildDocument(taskId, label, cases, evaluate, noMutate) {
  const { nodes, token } = encoder();
  const documentCases = cases.map((args, index) => {
    const frozenSet = new Set();
    const encodedArgs = args.map((arg) => token(arg));
    const expectedValue = evaluate(args);
    // Expected values are not frozen: rebuild them with frozen off.
    const expected = { ok: true, value: expectedToken(expectedValue) };
    const testCase = { id: `${taskId.toLowerCase()}-${label}-${index + 1}`, operationId: 'call', args: encodedArgs, expected };
    // The host does not keep arguments frozen, so "do not mutate" tasks check the arguments after the call.
    if (noMutate) testCase.expectedArgsAfter = args.map((arg) => expectedToken(arg));
    return testCase;
  });
  function expectedToken(value) {
    if (value === undefined) return { $value: 'undefined' };
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
    const id = `n${nodes.length}`;
    const node = { id };
    nodes.push(node);
    if (Array.isArray(value)) {
      node.kind = 'array';
      node.items = value.map((item) => expectedToken(item));
    } else {
      node.kind = 'object';
      node.properties = Object.entries(value).map(([key, item]) => [key, expectedToken(item)]);
    }
    return { $ref: id };
  }
  return { schemaVersion: 1, cases: documentCases, nodes };
}

// ---- evaluation -----------------------------------------------------------------------------------------------
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    if (!Array.isArray(value)) Object.freeze(value);
  }
  return value;
}

async function loadEntry(dir, task) {
  const url = `${pathToFileURL(join(dir, task.entry[0])).href}?v=${Math.random()}`;
  return (await import(url))[task.entry[1]];
}

function writeModules(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function evaluate(dir, task, args) {
  const fn = await loadEntry(dir, task);
  const cloned = structuredClone(args);
  if (frozenArgs) deepFreeze(cloned);
  return fn(...cloned);
}

const work = mkdtempSync(join(tmpdir(), 'agentcp-itasks-'));
const registryLines = [];
const operationLines = [];
let n = 0;
for (const task of TASKS) {
  n += 1;
  const fixedDir = join(work, `${task.id}-fixed`);
  const baseDir = join(work, `${task.id}-base`);
  writeModules(baseDir, task.files);
  writeModules(fixedDir, { ...task.files, [task.defective]: task.fixed });

  const expectedPub = [];
  const expectedOra = [];
  for (const args of task.pub) expectedPub.push(await evaluate(fixedDir, task, args));
  for (const args of task.ora) expectedOra.push(await evaluate(fixedDir, task, args));

  let basePubFails = 0;
  let baseOraFails = 0;
  for (const [index, args] of task.pub.entries()) {
    let actual;
    try { actual = await evaluate(baseDir, task, args); } catch { actual = Symbol('threw'); }
    if (typeof actual === 'symbol' || !same(actual, expectedPub[index])) basePubFails += 1;
  }
  for (const [index, args] of task.ora.entries()) {
    let actual;
    try { actual = await evaluate(baseDir, task, args); } catch { actual = Symbol('threw'); }
    if (typeof actual === 'symbol' || !same(actual, expectedOra[index])) baseOraFails += 1;
  }
  if (basePubFails === 0 || baseOraFails === 0) {
    throw new Error(`${task.id}: the base does not fail (public ${basePubFails}, oracle ${baseOraFails})`);
  }

  const taskDir = join(root, 'bench', 'tasks', task.id);
  rmSync(taskDir, { recursive: true, force: true });
  for (const [path, text] of Object.entries(task.files)) {
    mkdirSync(join(taskDir, 'base', path, '..'), { recursive: true });
    writeFileSync(join(taskDir, 'base', path), text);
  }
  const manifest = await createSnapshotManifest(join(taskDir, 'base'));
  writeFileSync(join(taskDir, 'snapshot.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const taskJson = {
    task_id: task.id,
    prompt: task.prompt,
    base_snapshot_sha256: snapshotId(manifest),
    allowed_globs: ['src/**/*.mjs'],
    allowed_operations: ['read_text', 'list_files', 'apply_unified_diff', 'run_declared_test', 'git_diff'],
    public_test_command_id: `${task.id.toLowerCase()}-public-tests`,
    timeout_ms: 600000,
    max_changed_files: 1,
    oracle_version: 'oracle-v1',
    risk_class: 'process',
  };
  writeFileSync(join(taskDir, 'task.json'), `${JSON.stringify(taskJson, null, 2)}\n`);
  mkdirSync(join(taskDir, 'public-tests'), { recursive: true });
  let k = 0;
  const pubDoc = buildDocument(task.id, 'public', task.pub, () => expectedPub[k++], task.noMutate === true);
  k = 0;
  const oraDoc = buildDocument(task.id, 'oracle', task.ora, () => expectedOra[k++], task.noMutate === true);
  writeFileSync(join(taskDir, 'public-tests', 'test.json'), `${JSON.stringify(pubDoc, null, 2)}\n`);
  writeFileSync(join(root, 'bench', 'oracles', `${task.id}.json`), `${JSON.stringify(oraDoc, null, 2)}\n`);
  const diff = createUnifiedDiff(task.defective, task.files[task.defective], task.fixed);
  writeFileSync(join(taskDir, 'reference.patch'), diff);
  writeFileSync(join(taskDir, 'null.patch'), '');

  registryLines.push(`  ['${task.id}', '${task.id.toLowerCase()}-public-tests', 'public-tests/test.json', 'bench/oracles/${task.id}.json'],`);
  operationLines.push(`  ${task.id}: Object.freeze({ call: invoke('${task.entry[0]}', '${task.entry[1]}') }),`);
  console.log(`${task.id}: ok (base fails public ${basePubFails}/${task.pub.length}, oracle ${baseOraFails}/${task.ora.length})`);
  console.log(`  pub -> ${JSON.stringify(expectedPub)}`);
  console.log(`  ora -> ${JSON.stringify(expectedOra)}`);
}
rmSync(work, { recursive: true, force: true });
writeFileSync(join(root, 'dev', 'bench', 'i-registry-lines.txt'), `${registryLines.join('\n')}\n\n${operationLines.join('\n')}\n`);
console.log(`generated ${n} tasks; sha of generator inputs ${createHash('sha256').update(JSON.stringify(TASKS.map((t) => [t.id, t.prompt, t.files, t.fixed]))).digest('hex').slice(0, 12)}`);
