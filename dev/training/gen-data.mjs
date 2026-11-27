// Generates synthetic single-defect repair examples for the G20.6 QLoRA pilot.
// Usage: node dev/training/gen-data.mjs <outDir> <count> [seed]
// Output (outside the repository): <outDir>/train.jsonl and <outDir>/val.jsonl in chat-message format
// that reproduces the adapter's file_edits prompt exactly. Every example is checked: the fixed file
// passes all cases and the buggy file fails at least one. The templates avoid the domains of the
// measurement tasks (B*, P*, I*, S*): no range-inclusion, ratio, slugify, unique-in-order, config
// merge, cache invalidation, priority sort, duration parsing, CSV escaping, option precedence or
// date conversion.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [outArg, countArg, seedArg] = process.argv.slice(2);
if (!outArg || !/^[0-9]+$/.test(countArg ?? '')) throw new Error('Usage: gen-data.mjs <outDir> <count> [seed]');
const outDir = resolve(outArg);
if (outDir.includes(`${resolve('.')}`) && !outDir.includes('agentcp-train')) throw new Error('outDir must be outside the repository');
const COUNT = Math.min(300, Number(countArg));

let state = (Number(seedArg ?? 20261110) >>> 0) || 1;
function rand() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const FN = {
  clamp: ['clampValue', 'limitToBounds', 'boundNumber', 'keepBetween'],
  sum: ['totalOf', 'addAll', 'sumItems', 'accumulate'],
  mean: ['averageOf', 'meanValue', 'avgOf', 'computeMean'],
  pal: ['isPalindrome', 'readsSame', 'isMirrorText', 'checkPalindrome'],
  cap: ['capitalizeWords', 'titleCase', 'upperFirstEach', 'toWordCase'],
  bool: ['parseFlag', 'toBoolean', 'readBool', 'flagFromText'],
  chunk: ['chunkList', 'splitIntoGroups', 'batchItems', 'partition'],
  trunc: ['truncateText', 'shorten', 'cutWithEllipsis', 'limitLength'],
  sort: ['sortNumbers', 'orderAscending', 'numericSort', 'ascendingCopy'],
  nested: ['readPath', 'getDeep', 'lookupPath', 'pluck'],
  money: ['formatCents', 'centsToText', 'showPrice', 'moneyLabel'],
  leap: ['isLeapYear', 'leapCheck', 'hasLeapDay', 'yearIsLeap'],
  median: ['medianOf', 'middleValue', 'computeMedian', 'medianValue'],
  flat: ['flattenOnce', 'flattenLevel', 'unnest', 'flatList'],
  pages: ['pageCount', 'totalPages', 'countPages', 'pagesNeeded'],
  pct: ['percentOf', 'toPercent', 'sharePercent', 'percentage'],
  snake: ['toSnakeCase', 'camelToSnake', 'snakeCase', 'underscored'],
  maxby: ['maxOf', 'largestValue', 'findMax', 'topValue'],
  queue: ['makeQueue', 'createFifo', 'newQueue', 'buildQueue'],
  vowels: ['countVowels', 'vowelTotal', 'howManyVowels', 'vowelCount'],
  rev: ['reverseWords', 'wordsBackwards', 'flipWordOrder', 'reverseSentence'],
  pad: ['padLeftZeros', 'zeroPad', 'leftPad', 'padNumber'],
  last: ['lastItems', 'takeLast', 'tailOf', 'endSlice'],
  anyAll: ['allPositive', 'everyPositive', 'noneNegative', 'positivesOnly'],
  swap: ['swapPair', 'exchange', 'flipPair', 'swapEnds'],
  cmp: ['compareVersions', 'versionOrder', 'cmpVersion', 'orderVersions'],
  wrap: ['wrapIndex', 'circularIndex', 'loopIndex', 'ringIndex'],
  count: ['countOccurrences', 'tallyValue', 'howMany', 'occurrencesOf'],
  trim: ['trimEdges', 'stripMarks', 'cleanEnds', 'removeEdgeChars'],
  tern: ['signLabel', 'signName', 'describeSign', 'signOf'],
};

// Each template returns { prompt, buggy, fixed, cases: [[args, expected], ...] } for function `f`.
const TEMPLATES = [
  (f) => ({
    fn: f, key: 'clamp',
    prompt: `Fix ${f}(value, min, max) so values below min return min and values above max return max. Values inside the range are returned unchanged.`,
    buggy: `export function ${f}(value, min, max) {\n  if (value < min) return min;\n  if (value > max) return min;\n  return value;\n}\n`,
    fixed: `export function ${f}(value, min, max) {\n  if (value < min) return min;\n  if (value > max) return max;\n  return value;\n}\n`,
    cases: [[[5, 1, 9], 5], [[0, 1, 9], 1], [[12, 1, 9], 9]],
  }),
  (f) => ({
    fn: f, key: 'sum',
    prompt: `Fix ${f}(numbers) so it adds every element of the array, including the last one. An empty array returns 0.`,
    buggy: `export function ${f}(numbers) {\n  let total = 0;\n  for (let i = 0; i < numbers.length - 1; i += 1) {\n    total += numbers[i];\n  }\n  return total;\n}\n`,
    fixed: `export function ${f}(numbers) {\n  let total = 0;\n  for (let i = 0; i < numbers.length; i += 1) {\n    total += numbers[i];\n  }\n  return total;\n}\n`,
    cases: [[[[1, 2, 3]], 6], [[[]], 0], [[[7]], 7]],
  }),
  (f) => ({
    fn: f, key: 'mean',
    prompt: `Fix ${f}(numbers) so an empty array returns 0 instead of NaN. For a non-empty array return the arithmetic mean.`,
    buggy: `export function ${f}(numbers) {\n  const total = numbers.reduce((sum, n) => sum + n, 0);\n  return total / numbers.length;\n}\n`,
    fixed: `export function ${f}(numbers) {\n  if (numbers.length === 0) return 0;\n  const total = numbers.reduce((sum, n) => sum + n, 0);\n  return total / numbers.length;\n}\n`,
    cases: [[[[2, 4, 6]], 4], [[[]], 0], [[[5]], 5]],
  }),
  (f) => ({
    fn: f, key: 'pal',
    prompt: `Fix ${f}(text) so it ignores letter case and any character that is not a letter or digit when checking for a palindrome.`,
    buggy: `export function ${f}(text) {\n  const cleaned = text.replace(/[^a-z0-9]/g, '');\n  return cleaned === [...cleaned].reverse().join('');\n}\n`,
    fixed: `export function ${f}(text) {\n  const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, '');\n  return cleaned === [...cleaned].reverse().join('');\n}\n`,
    cases: [['A man, a plan, a canal: Panama', true], ['Hello', false], ['Noon', true]].map(([a, e]) => [[a], e]),
  }),
  (f) => ({
    fn: f, key: 'cap',
    prompt: `Fix ${f}(sentence) so every word starts with an uppercase letter, not only the first word. Words are separated by single spaces.`,
    buggy: `export function ${f}(sentence) {\n  return sentence.charAt(0).toUpperCase() + sentence.slice(1);\n}\n`,
    fixed: `export function ${f}(sentence) {\n  return sentence\n    .split(' ')\n    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))\n    .join(' ');\n}\n`,
    cases: [[['hello big world'], 'Hello Big World'], [['one'], 'One'], [[''], '']],
  }),
  (f) => ({
    fn: f, key: 'bool',
    prompt: `Fix ${f}(text) so the strings "false", "0", "no" and "off" (any letter case) return false, and "true", "1", "yes" and "on" return true. Any other string returns false.`,
    buggy: `export function ${f}(text) {\n  return Boolean(text);\n}\n`,
    fixed: `export function ${f}(text) {\n  return ['true', '1', 'yes', 'on'].includes(String(text).toLowerCase());\n}\n`,
    cases: [[['false'], false], [['YES'], true], [['Off'], false], [['1'], true], [['maybe'], false]],
  }),
  (f) => {
    const size = int(2, 4);
    return {
      fn: f, key: 'chunk',
      prompt: `Fix ${f}(items) so it splits the array into groups of ${size}, and the final shorter group is kept instead of dropped.`,
      buggy: `export function ${f}(items) {\n  const groups = [];\n  for (let i = 0; i + ${size} <= items.length; i += ${size}) {\n    groups.push(items.slice(i, i + ${size}));\n  }\n  return groups;\n}\n`,
      fixed: `export function ${f}(items) {\n  const groups = [];\n  for (let i = 0; i < items.length; i += ${size}) {\n    groups.push(items.slice(i, i + ${size}));\n  }\n  return groups;\n}\n`,
      cases: [[[[1, 2, 3, 4, 5, 6, 7]], [[1, 2, 3, 4, 5, 6, 7].slice(0, size), ...(() => { const out = []; for (let i = size; i < 7; i += size) out.push([1, 2, 3, 4, 5, 6, 7].slice(i, i + size)); return out; })()]]],
    };
  },
  (f) => {
    const n = int(5, 12);
    return {
      fn: f, key: 'trunc',
      prompt: `Fix ${f}(text) so results never exceed ${n} characters in total. Longer text is cut and ends with "..." (three dots) inside that limit; shorter or equal text is returned unchanged.`,
      buggy: `export function ${f}(text) {\n  if (text.length <= ${n}) return text;\n  return text.slice(0, ${n}) + '...';\n}\n`,
      fixed: `export function ${f}(text) {\n  if (text.length <= ${n}) return text;\n  return text.slice(0, ${n - 3}) + '...';\n}\n`,
      cases: [[['x'.repeat(n)], 'x'.repeat(n)], [['y'.repeat(n + 5)], `${'y'.repeat(n - 3)}...`]],
    };
  },
  (f) => ({
    fn: f, key: 'sort',
    prompt: `Fix ${f}(numbers) so it returns a new array sorted in ascending numeric order (for example 10 comes after 9) and leaves the input array unchanged.`,
    buggy: `export function ${f}(numbers) {\n  return [...numbers].sort();\n}\n`,
    fixed: `export function ${f}(numbers) {\n  return [...numbers].sort((a, b) => a - b);\n}\n`,
    cases: [[[[10, 9, 1, 100]], [1, 9, 10, 100]], [[[3, 2]], [2, 3]]],
  }),
  (f) => ({
    fn: f, key: 'nested',
    prompt: `Fix ${f}(object, keys, fallback) so it follows the list of keys through nested objects and returns fallback only when a key is missing. Values such as 0, false and empty string are real values and must be returned.`,
    buggy: `export function ${f}(object, keys, fallback) {\n  let current = object;\n  for (const key of keys) {\n    if (!current || !current[key]) return fallback;\n    current = current[key];\n  }\n  return current;\n}\n`,
    fixed: `export function ${f}(object, keys, fallback) {\n  let current = object;\n  for (const key of keys) {\n    if (current === null || current === undefined || !(key in Object(current))) return fallback;\n    current = current[key];\n  }\n  return current;\n}\n`,
    cases: [[[{ a: { b: 0 } }, ['a', 'b'], 9], 0], [[{ a: {} }, ['a', 'b'], 9], 9], [[{ a: { b: '' } }, ['a', 'b'], 9], '']],
  }),
  (f) => ({
    fn: f, key: 'money',
    prompt: `Fix ${f}(cents) so it returns a dollar string with two decimals, for example 105 becomes "$1.05" and 5 becomes "$0.05".`,
    buggy: `export function ${f}(cents) {\n  const dollars = Math.floor(cents / 100);\n  const rest = cents % 100;\n  return '$' + dollars + '.' + rest;\n}\n`,
    fixed: `export function ${f}(cents) {\n  const dollars = Math.floor(cents / 100);\n  const rest = String(cents % 100).padStart(2, '0');\n  return '$' + dollars + '.' + rest;\n}\n`,
    cases: [[[105], '$1.05'], [[5], '$0.05'], [[1250], '$12.50']],
  }),
  (f) => ({
    fn: f, key: 'leap',
    prompt: `Fix ${f}(year) so it follows the Gregorian rule: divisible by 4 is a leap year, except years divisible by 100, unless also divisible by 400.`,
    buggy: `export function ${f}(year) {\n  return year % 4 === 0 && year % 100 !== 0;\n}\n`,
    fixed: `export function ${f}(year) {\n  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;\n}\n`,
    cases: [[[2000], true], [[1900], false], [[2024], true], [[2023], false]],
  }),
  (f) => ({
    fn: f, key: 'median',
    prompt: `Fix ${f}(numbers) so it returns the median: the middle value of the sorted numbers, or the mean of the two middle values when the count is even. Do not modify the input array.`,
    buggy: `export function ${f}(numbers) {\n  const sorted = [...numbers].sort((a, b) => a - b);\n  return sorted[Math.floor(sorted.length / 2)];\n}\n`,
    fixed: `export function ${f}(numbers) {\n  const sorted = [...numbers].sort((a, b) => a - b);\n  const middle = Math.floor(sorted.length / 2);\n  if (sorted.length % 2 === 0) return (sorted[middle - 1] + sorted[middle]) / 2;\n  return sorted[middle];\n}\n`,
    cases: [[[[5, 1, 3]], 3], [[[4, 1, 3, 2]], 2.5], [[[8]], 8]],
  }),
  (f) => ({
    fn: f, key: 'flat',
    prompt: `Fix ${f}(lists) so it joins an array of arrays into one flat array, keeping the order. Items that are not arrays are kept as single values.`,
    buggy: `export function ${f}(lists) {\n  const result = [];\n  for (const item of lists) {\n    result.push(...item);\n  }\n  return result;\n}\n`,
    fixed: `export function ${f}(lists) {\n  const result = [];\n  for (const item of lists) {\n    if (Array.isArray(item)) result.push(...item);\n    else result.push(item);\n  }\n  return result;\n}\n`,
    cases: [[[[[1, 2], [3], 4]], [1, 2, 3, 4]], [[[]], []], [[[5, [6]]], [5, 6]]],
  }),
  (f) => {
    const size = pick([5, 10, 20, 25]);
    return {
      fn: f, key: 'pages',
      prompt: `Fix ${f}(totalItems) for pages of ${size} items. A partial last page counts as a page, and zero items need zero pages.`,
      buggy: `export function ${f}(totalItems) {\n  return Math.floor(totalItems / ${size});\n}\n`,
      fixed: `export function ${f}(totalItems) {\n  return Math.ceil(totalItems / ${size});\n}\n`,
      cases: [[[0], 0], [[size], 1], [[size + 1], 2], [[size * 3], 3]],
    };
  },
  (f) => ({
    fn: f, key: 'pct',
    prompt: `Fix ${f}(part, total) so it returns the percentage rounded to one decimal place, and returns 0 when total is 0 instead of Infinity or NaN.`,
    buggy: `export function ${f}(part, total) {\n  return Math.round((part / total) * 1000) / 10;\n}\n`,
    fixed: `export function ${f}(part, total) {\n  if (total === 0) return 0;\n  return Math.round((part / total) * 1000) / 10;\n}\n`,
    cases: [[[1, 8], 12.5], [[0, 0], 0], [[3, 3], 100]],
  }),
  (f) => ({
    fn: f, key: 'snake',
    prompt: `Fix ${f}(name) so camelCase becomes snake_case without a leading underscore: "userName" gives "user_name" and "UserName" also gives "user_name".`,
    buggy: `export function ${f}(name) {\n  return name.replace(/([A-Z])/g, '_$1').toLowerCase();\n}\n`,
    fixed: `export function ${f}(name) {\n  return name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');\n}\n`,
    cases: [[['userName'], 'user_name'], [['UserName'], 'user_name'], [['id'], 'id']],
  }),
  (f) => ({
    fn: f, key: 'maxby',
    prompt: `Fix ${f}(numbers) so it returns the largest number even when every number is negative, and returns undefined for an empty array.`,
    buggy: `export function ${f}(numbers) {\n  let best = 0;\n  for (const n of numbers) {\n    if (n > best) best = n;\n  }\n  return numbers.length === 0 ? undefined : best;\n}\n`,
    fixed: `export function ${f}(numbers) {\n  if (numbers.length === 0) return undefined;\n  let best = numbers[0];\n  for (const n of numbers) {\n    if (n > best) best = n;\n  }\n  return best;\n}\n`,
    cases: [[[[-5, -2, -9]], -2], [[[]], undefined], [[[3, 8, 1]], 8]],
  }),
  (f) => ({
    fn: f, key: 'vowels',
    prompt: `Fix ${f}(text) so it counts vowels a, e, i, o, u in both lower and upper case.`,
    buggy: `export function ${f}(text) {\n  return [...text].filter((c) => 'aeiou'.includes(c)).length;\n}\n`,
    fixed: `export function ${f}(text) {\n  return [...text.toLowerCase()].filter((c) => 'aeiou'.includes(c)).length;\n}\n`,
    cases: [[['Education'], 5], [['XYZ'], 0], [['AEIOU'], 5]],
  }),
  (f) => ({
    fn: f, key: 'rev',
    prompt: `Fix ${f}(sentence) so it reverses the order of the words and keeps each word spelled forwards: "a b c" becomes "c b a".`,
    buggy: `export function ${f}(sentence) {\n  return [...sentence].reverse().join('');\n}\n`,
    fixed: `export function ${f}(sentence) {\n  return sentence.split(' ').reverse().join(' ');\n}\n`,
    cases: [[['a b c'], 'c b a'], [['hello world'], 'world hello'], [['one'], 'one']],
  }),
  (f) => {
    const width = int(3, 6);
    return {
      fn: f, key: 'pad',
      prompt: `Fix ${f}(value) so it returns the number as a string padded on the left with zeros to a width of ${width}. Longer numbers are returned as they are.`,
      buggy: `export function ${f}(value) {\n  return String(value).padEnd(${width}, '0');\n}\n`,
      fixed: `export function ${f}(value) {\n  return String(value).padStart(${width}, '0');\n}\n`,
      cases: [[[7], '7'.padStart(width, '0')], [[12], '12'.padStart(width, '0')], [[10 ** width + 5], String(10 ** width + 5)]],
    };
  },
  (f) => {
    const n = int(2, 4);
    return {
      fn: f, key: 'last',
      prompt: `Fix ${f}(items) so it returns the last ${n} items. If there are fewer than ${n} items, return all of them.`,
      buggy: `export function ${f}(items) {\n  return items.slice(-${n} - 1);\n}\n`,
      fixed: `export function ${f}(items) {\n  return items.slice(-${n});\n}\n`,
      cases: [[[[1, 2, 3, 4, 5, 6]], [1, 2, 3, 4, 5, 6].slice(-n)], [[[9]], [9]]],
    };
  },
  (f) => ({
    fn: f, key: 'anyAll',
    prompt: `Fix ${f}(numbers) so it returns true only when every number is greater than zero. An empty array returns true.`,
    buggy: `export function ${f}(numbers) {\n  return numbers.some((n) => n > 0);\n}\n`,
    fixed: `export function ${f}(numbers) {\n  return numbers.every((n) => n > 0);\n}\n`,
    cases: [[[[1, 2, 3]], true], [[[1, -2, 3]], false], [[[]], true], [[[0]], false]],
  }),
  (f) => ({
    fn: f, key: 'swap',
    prompt: `Fix ${f}(pair) so it returns a new two-element array with the elements in reverse order, without changing the input.`,
    buggy: `export function ${f}(pair) {\n  const copy = pair;\n  copy[0] = pair[1];\n  copy[1] = pair[0];\n  return copy;\n}\n`,
    fixed: `export function ${f}(pair) {\n  return [pair[1], pair[0]];\n}\n`,
    cases: [[[[1, 2]], [2, 1]], [[['a', 'b']], ['b', 'a']]],
  }),
  (f) => ({
    fn: f, key: 'cmp',
    prompt: `Fix ${f}(a, b) for dotted numeric versions like "1.10.0". Return -1 when a is older, 1 when a is newer and 0 when equal. Compare each part as a number, not as text.`,
    buggy: `export function ${f}(a, b) {\n  if (a === b) return 0;\n  return a < b ? -1 : 1;\n}\n`,
    fixed: `export function ${f}(a, b) {\n  const left = a.split('.').map(Number);\n  const right = b.split('.').map(Number);\n  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {\n    const x = left[i] ?? 0;\n    const y = right[i] ?? 0;\n    if (x !== y) return x < y ? -1 : 1;\n  }\n  return 0;\n}\n`,
    cases: [[['1.10.0', '1.9.0'], 1], [['1.2', '1.2.0'], 0], [['0.9', '1.0'], -1]],
  }),
  (f) => ({
    fn: f, key: 'wrap',
    prompt: `Fix ${f}(index, length) so it wraps around in both directions: -1 becomes length - 1 and length becomes 0.`,
    buggy: `export function ${f}(index, length) {\n  return index % length;\n}\n`,
    fixed: `export function ${f}(index, length) {\n  return ((index % length) + length) % length;\n}\n`,
    cases: [[[-1, 5], 4], [[5, 5], 0], [[7, 5], 2], [[-6, 5], 4]],
  }),
  (f) => ({
    fn: f, key: 'count',
    prompt: `Fix ${f}(items, target) so it counts how many times target appears using strict equality, including when target is 0 or an empty string.`,
    buggy: `export function ${f}(items, target) {\n  return items.filter((item) => item == target && target).length;\n}\n`,
    fixed: `export function ${f}(items, target) {\n  return items.filter((item) => item === target).length;\n}\n`,
    cases: [[[[0, 1, 0, 2], 0], 2], [[['', 'a', ''], ''], 2], [[[1, '1'], 1], 1]],
  }),
  (f) => {
    const ch = pick(['-', '_', '/', '*']);
    return {
      fn: f, key: 'trim',
      prompt: `Fix ${f}(text) so it removes every leading and trailing "${ch}" character, not only the first and last one. Characters in the middle stay.`,
      buggy: `export function ${f}(text) {\n  let result = text;\n  if (result.startsWith('${ch}')) result = result.slice(1);\n  if (result.endsWith('${ch}')) result = result.slice(0, -1);\n  return result;\n}\n`,
      fixed: `export function ${f}(text) {\n  let start = 0;\n  let end = text.length;\n  while (start < end && text[start] === '${ch}') start += 1;\n  while (end > start && text[end - 1] === '${ch}') end -= 1;\n  return text.slice(start, end);\n}\n`,
      cases: [[[`${ch}${ch}a${ch}b${ch}${ch}`], `a${ch}b`], [['plain'], 'plain'], [[`${ch}${ch}`], '']],
    };
  },
  (f) => ({
    fn: f, key: 'tern',
    prompt: `Fix ${f}(n) so it returns "negative" below zero, "zero" for exactly zero (including -0) and "positive" above zero.`,
    buggy: `export function ${f}(n) {\n  return n < 0 ? 'negative' : 'positive';\n}\n`,
    fixed: `export function ${f}(n) {\n  if (n < 0) return 'negative';\n  if (n > 0) return 'positive';\n  return 'zero';\n}\n`,
    cases: [[[-3], 'negative'], [[0], 'zero'], [[4], 'positive'], [[-0], 'zero']],
  }),
];

// Stateful template (queue): checked separately through a call script.
function queueExample(f) {
  const buggy = `export function ${f}() {\n  const items = [];\n  return {\n    enqueue(value) { items.push(value); },\n    dequeue() { return items.pop(); },\n    size() { return items.length; },\n  };\n}\n`;
  const fixed = `export function ${f}() {\n  const items = [];\n  return {\n    enqueue(value) { items.push(value); },\n    dequeue() { return items.shift(); },\n    size() { return items.length; },\n  };\n}\n`;
  return { fn: f, key: 'queue', prompt: `Fix ${f}() so dequeue removes the oldest value first (first in, first out) and returns undefined when the queue is empty.`, buggy, fixed, custom: true };
}

async function load(source) {
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(url);
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b) && Object.is(a, b) === Object.is(a, b); }

async function passes(example, source) {
  const mod = await load(source);
  const fn = mod[example.fn];
  if (example.custom) {
    const q = fn();
    q.enqueue(1); q.enqueue(2);
    return q.dequeue() === 1 && q.size() === 1 && q.dequeue() === 2 && q.dequeue() === undefined;
  }
  for (const [args, expected] of example.cases) {
    let actual;
    try { actual = fn(...structuredClone(args)); } catch { return false; }
    if (!same(actual, expected)) return false;
  }
  return true;
}

const SYSTEM_PROMPT = (await import(pathToFileURL(resolve(import.meta.dirname, '..', '..', 'src', 'adapters', 'ollama.ts')).href)).FILE_EDITS_SYSTEM_PROMPT;

function build(example, path) {
  const context = `${JSON.stringify({ task: example.prompt, allowedPaths: ['src/**/*.mjs'], requestedOperations: ['write'], declaredTestIds: [] })}\nFILE ${path} BYTES ${Buffer.byteLength(example.buggy, 'utf8')}\n${example.buggy}`;
  const answer = JSON.stringify({ proposalId: `fix-${example.key}`, edits: [{ path, content: example.fixed }] });
  return { messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: context }, { role: 'assistant', content: answer }] };
}

const generators = [...TEMPLATES.map((t, index) => ({ key: `t${index}`, make: (f) => t(f) })), { key: 'queue', make: queueExample }];
const FNKEYS = Object.keys(FN);
const seen = new Set();
const rows = [];
let attempts = 0;
while (rows.length < COUNT && attempts < COUNT * 60) {
  attempts += 1;
  const generator = generators[attempts % generators.length];
  const names = FN[FNKEYS[Math.floor(rand() * FNKEYS.length)]];
  const f = pick(names);
  const example = generator.make(f);
  const file = pick(['src/index.mjs', 'src/util.mjs', 'src/helpers.mjs', 'src/lib.mjs', 'src/core.mjs']);
  const identity = `${generator.key}|${example.prompt}|${file}`;
  if (seen.has(identity)) continue;
  if (!(await passes(example, example.fixed)) || (await passes(example, example.buggy))) {
    throw new Error(`template ${generator.key} failed its own check`);
  }
  seen.add(identity);
  rows.push(build(example, file));
}
for (let i = rows.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rand() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]];
}
const validationCount = Math.max(10, Math.floor(rows.length / 12));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'val.jsonl'), `${rows.slice(0, validationCount).map((r) => JSON.stringify(r)).join('\n')}\n`);
writeFileSync(join(outDir, 'train.jsonl'), `${rows.slice(validationCount).map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(JSON.stringify({ total: rows.length, train: rows.length - validationCount, val: validationCount, templates: generators.length }));
