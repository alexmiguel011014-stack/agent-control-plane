// Generates synthetic two-file "integration" repair examples for the G20.6 training rounds 2 and 3
// (round 3 adds quote/backslash escaping templates and prompts that do not name the faulty file).
// Usage: node dev/training/gen-data-integration.mjs <outDir> <count> [seed] [mixDir mixCount]
// Each example shows an entry module and a helper module; exactly one of them holds the defect and
// the answer rewrites only that file (the shape of the G3 tasks: right file, right change, other file
// untouched). Every example is checked: the fixed pair passes all cases, the buggy pair fails.
// The domains avoid the measurement tasks (B*, P*, I*, S*): no option precedence, config merge,
// import cycle, CSV, slug, duration, range, ratio, unique-in-order, cache, priority sort or dates.
// A 6th argument `blocks` writes protocol v4 rows (plain-text FILE blocks and the v4 system prompt);
// `v5` writes two rows per example (a review row naming the defect file, then a one-block edit row).
// Output goes outside the repository. With mixDir, `mixCount` rows of an earlier single-file
// train.jsonl are appended so single-file skills are kept.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const [outArg, countArg, seedArg, mixArg, mixCountArg, formatArg] = process.argv.slice(2);
const BLOCKS = formatArg === 'blocks';
const V5 = formatArg === 'v5';
if (!outArg || !/^[0-9]+$/.test(countArg ?? '')) throw new Error('Usage: gen-data-integration.mjs <outDir> <count> [seed] [mixDir mixCount]');
const outDir = resolve(outArg);
if (!outDir.includes('agentcp-train')) throw new Error('outDir must be outside the repository (agentcp-train)');
const COUNT = Math.min(300, Number(countArg));

let state = (Number(seedArg ?? 20261111) >>> 0) || 1;
function rand() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const ENTRY_FILES = ['src/main.mjs', 'src/service.mjs', 'src/report.mjs', 'src/handler.mjs', 'src/api.mjs'];
const HELPER_FILES = ['src/helpers.mjs', 'src/tools.mjs', 'src/support.mjs', 'src/rules.mjs', 'src/calc.mjs'];
const ENTRY_NAMES = ['summarize', 'buildReport', 'processBatch', 'computeResult', 'prepareOutput', 'runCheck', 'collectStats', 'assemble'];
const HELPER_NAMES = ['applyStep', 'normalizeValue', 'convertItem', 'evaluateOne', 'transformEntry', 'adjustAmount', 'measureUnit', 'resolveItem'];

// A template returns { key, prompt, entry: source, helper: source, buggyIn: 'entry'|'helper', fixed: source of the buggy file, cases, async? }.
// `E` is the entry function name, `H` the helper function name, `imp` the import specifier of the helper.
const TEMPLATES = [
  // 1 caller passes helper arguments in the wrong order
  (E, H, imp) => {
    const rate = pick([10, 15, 20, 25]);
    const helper = `export function ${H}(amount, percent) {\n  return (amount * (100 - percent)) / 100;\n}\n`;
    const mk = (call) => `import { ${H} } from '${imp}';\n\nexport function ${E}(prices) {\n  let total = 0;\n  for (const price of prices) {\n    total += ${call};\n  }\n  return total;\n}\n`;
    return {
      why: 'caller passes helper arguments in the wrong order', key: 'argorder', buggyIn: 'entry', helper, entry: mk(`${H}(${rate}, price)`), fixed: mk(`${H}(price, ${rate})`),
      prompt: `${E}(prices) should return the sum of every price after a ${rate} percent discount, using ${H}(amount, percent) from the helper module. The helper is correct; fix the caller.`,
      cases: [[[[100, 200]], (300 * (100 - rate)) / 100], [[[]], 0], [[[50]], (50 * (100 - rate)) / 100]],
    };
  },
  // 2 helper returns the wrong thing for negative numbers
  (E, H, imp) => {
    const entry = `import { ${H} } from '${imp}';\n\nexport function ${E}(readings) {\n  return ${H}(readings.map((r) => r.value));\n}\n`;
    return {
      why: 'helper returns the wrong thing for negative numbers', key: 'helpermax', buggyIn: 'helper', entry,
      helper: `export function ${H}(values) {\n  let best = 0;\n  for (const v of values) {\n    if (v > best) best = v;\n  }\n  return best;\n}\n`,
      fixed: `export function ${H}(values) {\n  let best = values[0];\n  for (const v of values) {\n    if (v > best) best = v;\n  }\n  return best;\n}\n`,
      prompt: `${E}(readings) must return the highest value among the readings, even when every value is negative. The bug is in the helper module.`,
      cases: [[[[{ value: -5 }, { value: -2 }, { value: -9 }]], -2], [[[{ value: 3 }, { value: 8 }]], 8]],
    };
  },
  // 3 caller imports a name the helper does not export
  (E, H, imp) => {
    const wrong = `${H}s`;
    const helper = `export function ${H}(text) {\n  return text.trim().toUpperCase();\n}\n`;
    const mk = (name) => `import { ${name} } from '${imp}';\n\nexport function ${E}(items) {\n  return items.map((item) => ${name}(item));\n}\n`;
    return {
      why: 'caller imports a name the helper does not export', key: 'badimport', buggyIn: 'entry', helper, entry: mk(wrong), fixed: mk(H),
      prompt: `Loading the module that exports ${E}(items) fails. It should uppercase and trim every item with the helper module's exported function. Fix the import in the caller.`,
      cases: [[[[' a ', 'bc']], ['A', 'BC']], [[[]], []]],
    };
  },
  // 4 caller mutates its input through the helper
  (E, H, imp) => {
    const helper = `export function ${H}(list) {\n  return list.sort((a, b) => a - b);\n}\n`;
    const mk = (arg) => `import { ${H} } from '${imp}';\n\nexport function ${E}(list) {\n  return { first: ${H}(${arg})[0], original: list };\n}\n`;
    return {
      why: 'caller mutates its input through the helper', key: 'mutation', buggyIn: 'entry', helper, entry: mk('list'), fixed: mk('[...list]'),
      prompt: `${E}(list) returns the smallest number as first and the original list as original. The original list must keep its order, so the caller must not let the helper sort it in place. Fix the caller.`,
      cases: [[[[3, 1, 2]], { first: 1, original: [3, 1, 2] }], [[[9, 4]], { first: 4, original: [9, 4] }]],
    };
  },
  // 5 caller reads the wrong key of the helper result
  (E, H, imp) => {
    const min = int(6, 10);
    const helper = `export function ${H}(text) {\n  if (text.length < ${min}) return { valid: false, reason: 'short' };\n  return { valid: true, reason: '' };\n}\n`;
    const mk = (key) => `import { ${H} } from '${imp}';\n\nexport function ${E}(texts) {\n  return texts.filter((text) => ${H}(text).${key});\n}\n`;
    return {
      why: 'caller reads the wrong key of the helper result', key: 'wrongkey', buggyIn: 'entry', helper, entry: mk('ok'), fixed: mk('valid'),
      prompt: `${E}(texts) must keep only the texts accepted by the helper (the helper marks accepted texts with valid: true; it needs at least ${min} characters). Right now nothing is kept. Fix the caller.`,
      cases: [[[['x'.repeat(min), 'y']], ['x'.repeat(min)]], [[[]], []]],
    };
  },
  // 6 caller computes the slice start/end around a helper offset incorrectly
  (E, H, imp) => {
    const helper = `export function ${H}(page, size) {\n  return (page - 1) * size;\n}\n`;
    const mk = (end) => `import { ${H} } from '${imp}';\n\nexport function ${E}(items, page, size) {\n  const start = ${H}(page, size);\n  return items.slice(start, ${end});\n}\n`;
    return {
      why: 'caller computes the slice start/end around a helper offset incorrectly', key: 'pageend', buggyIn: 'entry', helper, entry: mk('start + size - 1'), fixed: mk('start + size'),
      prompt: `${E}(items, page, size) returns the items of one page (page 1 is the first). Every page must hold exactly size items, except a shorter final page. The helper's start index is correct; fix the caller.`,
      cases: [[[[1, 2, 3, 4, 5, 6, 7], 1, 3], [1, 2, 3]], [[[1, 2, 3, 4, 5, 6, 7], 3, 3], [7]], [[[1, 2, 3, 4], 2, 2], [3, 4]]],
    };
  },
  // 7 helper conversion is incomplete
  (E, H, imp) => {
    const entry = `import { ${H} } from '${imp}';\n\nexport function ${E}(values) {\n  return values.map((v) => \`\${${H}(v)}F\`);\n}\n`;
    return {
      why: 'helper conversion is incomplete', key: 'tempconv', buggyIn: 'helper', entry,
      helper: `export function ${H}(celsius) {\n  return (celsius * 9) / 5;\n}\n`,
      fixed: `export function ${H}(celsius) {\n  return (celsius * 9) / 5 + 32;\n}\n`,
      prompt: `${E}(values) converts Celsius numbers to Fahrenheit text such as "212F". The conversion lives in the helper module and gives wrong numbers; fix the helper.`,
      cases: [[[[0, 100]], ['32F', '212F']], [[[-40]], ['-40F']]],
    };
  },
  // 8 caller must normalize before a strict helper compares
  (E, H, imp) => {
    const helper = `export function ${H}(a, b) {\n  return a === b;\n}\n`;
    const mk = (call) => `import { ${H} } from '${imp}';\n\nexport function ${E}(users, name) {\n  return users.find((user) => ${call}) ?? null;\n}\n`;
    return {
      why: 'caller must normalize before a strict helper compares', key: 'normalize', buggyIn: 'entry', helper, entry: mk(`${H}(user.name, name)`), fixed: mk(`${H}(user.name.trim().toLowerCase(), name.trim().toLowerCase())`),
      prompt: `${E}(users, name) finds the first user whose name equals the given name, ignoring letter case and surrounding spaces, or returns null. The helper does a strict comparison on purpose; fix the caller to normalize both names first.`,
      cases: [[[[{ name: 'Ana' }, { name: 'Bob' }], '  bob '], { name: 'Bob' }], [[[{ name: 'Ana' }], 'zed'], null]],
    };
  },
  // 9 caller drops the helper result
  (E, H, imp) => {
    const helper = `export function ${H}(list, item) {\n  return [...list, item];\n}\n`;
    const mk = (ret) => `import { ${H} } from '${imp}';\n\nexport function ${E}(list, item) {\n  const next = ${H}(list, item);\n  return ${ret};\n}\n`;
    return {
      why: 'caller drops the helper result', key: 'dropresult', buggyIn: 'entry', helper, entry: mk('list'), fixed: mk('next'),
      prompt: `${E}(list, item) must return a new list that ends with item, using the helper that builds it. The input list must not change. Fix the caller.`,
      cases: [[[[1, 2], 3], [1, 2, 3]], [[[], 'a'], ['a']]],
    };
  },
  // 10 async caller forgets to wait
  (E, H, imp) => {
    const helper = `export async function ${H}(id) {\n  return { id, label: \`item-\${id}\` };\n}\n`;
    const mk = (body) => `import { ${H} } from '${imp}';\n\nexport async function ${E}(ids) {\n${body}\n}\n`;
    return {
      why: 'async caller forgets to wait', key: 'noawait', buggyIn: 'entry', async: true, helper,
      entry: mk(`  return ids.map((id) => ${H}(id));`),
      fixed: mk(`  return Promise.all(ids.map((id) => ${H}(id)));`),
      prompt: `${E}(ids) resolves to the array of records the async helper returns for each id, in order. Right now it resolves to an array of pending promises. Fix the caller.`,
      cases: [[[[1, 2]], [{ id: 1, label: 'item-1' }, { id: 2, label: 'item-2' }]], [[[]], []]],
    };
  },
  // 11 default import of a named export
  (E, H, imp) => {
    const helper = `export function ${H}(n) {\n  return n * 2;\n}\n`;
    const mkImport = (line) => `${line}\n\nexport function ${E}(numbers) {\n  return numbers.map(${H});\n}\n`;
    return {
      why: 'default import of a named export', key: 'defaultimport', buggyIn: 'entry', helper, entry: mkImport(`import ${H} from '${imp}';`), fixed: mkImport(`import { ${H} } from '${imp}';`),
      prompt: `Importing the module that exports ${E}(numbers) fails because the helper function is imported the wrong way. It must double every number. The helper module is correct; fix the caller's import.`,
      cases: [[[[1, 2, 3]], [2, 4, 6]], [[[]], []]],
    };
  },
  // 12 caller off-by-one around a helper index
  (E, H, imp) => {
    const helper = `export function ${H}(text) {\n  return text.indexOf(' ');\n}\n`;
    const mk = (rest) => `import { ${H} } from '${imp}';\n\nexport function ${E}(fullName) {\n  const cut = ${H}(fullName);\n  return { first: fullName.slice(0, cut), last: fullName.slice(${rest}) };\n}\n`;
    return {
      why: 'caller off-by-one around a helper index', key: 'splitname', buggyIn: 'entry', helper, entry: mk('cut'), fixed: mk('cut + 1'),
      prompt: `${E}(fullName) splits "First Last" into { first, last } at the first space, using the helper that finds the space. The last part must not start with a space. Fix the caller.`,
      cases: [[['Ada Lovelace'], { first: 'Ada', last: 'Lovelace' }], [['Alan Mathison Turing'], { first: 'Alan', last: 'Mathison Turing' }]],
    };
  },
  // 13 caller forgets to convert text to number
  (E, H, imp) => {
    const helper = `export function ${H}(a, b) {\n  return a + b;\n}\n`;
    const mk = (conv) => `import { ${H} } from '${imp}';\n\nexport function ${E}(values) {\n  let total = 0;\n  for (const value of values) {\n    total = ${H}(total, ${conv});\n  }\n  return total;\n}\n`;
    return {
      why: 'caller forgets to convert text to number', key: 'coerce', buggyIn: 'entry', helper, entry: mk('value'), fixed: mk('Number(value)'),
      prompt: `${E}(values) receives numbers written as text, such as ["1", "2"], and returns their numeric sum. Right now it joins them as text. The helper adds two numbers correctly; fix the caller.`,
      cases: [[[['1', '2', '4']], 7], [[[]], 0], [[['10']], 10]],
    };
  },
  // 14 helper bound is exclusive instead of inclusive
  (E, H, imp) => {
    const limit = int(3, 9);
    const entry = `import { ${H} } from '${imp}';\n\nexport function ${E}(items) {\n  return items.filter((item) => ${H}(item.size));\n}\n`;
    return {
      why: 'helper bound is exclusive instead of inclusive', key: 'helperbound', buggyIn: 'helper', entry,
      helper: `export function ${H}(size) {\n  return size < ${limit};\n}\n`,
      fixed: `export function ${H}(size) {\n  return size <= ${limit};\n}\n`,
      prompt: `${E}(items) keeps the items whose size is at most ${limit} (size ${limit} itself is allowed). Items of exactly size ${limit} are missing. The decision is made in the helper module; fix the helper.`,
      cases: [[[[{ size: limit }, { size: limit + 1 }, { size: 1 }]], [{ size: limit }, { size: 1 }]]],
    };
  },
  // 15 helper forgets the empty case
  (E, H, imp) => {
    const entry = `import { ${H} } from '${imp}';\n\nexport function ${E}(groups) {\n  return groups.map((group) => ${H}(group));\n}\n`;
    return {
      why: 'helper forgets the empty case', key: 'helperempty', buggyIn: 'helper', entry,
      helper: `export function ${H}(numbers) {\n  return numbers.reduce((a, b) => a + b, 0) / numbers.length;\n}\n`,
      fixed: `export function ${H}(numbers) {\n  if (numbers.length === 0) return 0;\n  return numbers.reduce((a, b) => a + b, 0) / numbers.length;\n}\n`,
      prompt: `${E}(groups) returns the average of each group of numbers. An empty group must give 0, not NaN. The averaging lives in the helper module; fix the helper.`,
      cases: [[[[[2, 4], [], [6]]], [3, 0, 6]]],
    };
  },
  // 16 caller loops one element short using helper length
  (E, H, imp) => {
    const helper = `export function ${H}(item) {\n  return item.qty * item.price;\n}\n`;
    const mk = (cond) => `import { ${H} } from '${imp}';\n\nexport function ${E}(lines) {\n  let total = 0;\n  for (let i = 0; ${cond}; i += 1) {\n    total += ${H}(lines[i]);\n  }\n  return total;\n}\n`;
    return {
      why: 'caller loops one element short using helper length', key: 'looplast', buggyIn: 'entry', helper, entry: mk('i < lines.length - 1'), fixed: mk('i < lines.length'),
      prompt: `${E}(lines) returns the total of every line, where one line costs what the helper computes for it. The last line is currently skipped. The helper is correct; fix the caller.`,
      cases: [[[[{ qty: 2, price: 3 }, { qty: 1, price: 5 }]], 11], [[[]], 0], [[[{ qty: 4, price: 2 }]], 8]],
    };
  },
  // 17 helper forgets to escape double quotes for an HTML attribute
  (E, H, imp) => {
    const entry = [`import { ${H} } from '${imp}';`, '', `export function ${E}(items) {`, '  return items.map((item) => `<li title="${' + H + '(item)}"></li>`);', '}', ''].join('\n');
    const mkHelper = (extra) => [`export function ${H}(text) {`, `  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')${extra};`, '}', ''].join('\n');
    return {
      why: 'helper forgets to escape double quotes for an HTML attribute', key: 'htmlquote', buggyIn: 'helper', entry, helper: mkHelper(''), fixed: mkHelper(".replace(/\"/g, '&quot;')"),
      prompt: `${E}(items) builds one list element per item with the item text inside a double-quoted title attribute. Double quotes in the text must become &quot; so the attribute stays valid. The escaping is done in the helper module; fix the helper.`,
      cases: [[[['say "hi"']], ['<li title="say &quot;hi&quot;"></li>']], [[['a<b']], ['<li title="a&lt;b"></li>']]],
    };
  },
  // 18 helper replaces only the first backslash
  (E, H, imp) => {
    const entry = `import { ${H} } from '${imp}';\n\nexport function ${E}(paths) {\n  return paths.map((path) => ${H}(path));\n}\n`;
    const mkHelper = (call) => [`export function ${H}(path) {`, `  return ${call};`, '}', ''].join('\n');
    return {
      why: 'helper replaces only the first backslash', key: 'backslash', buggyIn: 'helper', entry, helper: mkHelper("path.replace('\\\\', '/')"), fixed: mkHelper("path.replaceAll('\\\\', '/')"),
      prompt: `${E}(paths) converts Windows paths such as "a\\b\\c" to forward slashes ("a/b/c"). Every backslash must be converted, not only the first one. The conversion is in the helper module; fix the helper.`,
      cases: [[[['a\\b\\c']], ['a/b/c']], [[['plain', 'x\\y']], ['plain', 'x/y']]],
    };
  },
  // 19 caller joins with the wrong separator
  (E, H, imp) => {
    const helper = [`export function ${H}(line) {`, '  return `> ${line}`;', '}', ''].join('\n');
    const mk = (sep) => `import { ${H} } from '${imp}';\n\nexport function ${E}(lines) {\n  return lines.map(${H}).join(${sep});\n}\n`;
    return {
      why: 'caller joins with the wrong separator', key: 'joinsep', buggyIn: 'entry', helper, entry: mk("' '"), fixed: mk("'\\n'"),
      prompt: `${E}(lines) quotes every line with the helper and returns the quoted lines separated by line breaks (one quoted line per row). Right now they are separated by spaces. The helper is correct; fix the caller.`,
      cases: [[[['a', 'b']], '> a\n> b'], [[['only']], '> only']],
    };
  },
  // 20 helper wraps names in the wrong quote character
  (E, H, imp) => {
    const entry = `import { ${H} } from '${imp}';\n\nexport function ${E}(names) {\n  return names.map(${H}).join(', ');\n}\n`;
    const mkHelper = (q) => [`export function ${H}(name) {`, '  return ' + q + ';', '}', ''].join('\n');
    return {
      why: 'helper wraps names in the wrong quote character', key: 'quotewrap', buggyIn: 'helper', entry, helper: mkHelper("`'${name}'`"), fixed: mkHelper('`"${name}"`'),
      prompt: `${E}(names) returns the names wrapped in double quotes and separated by a comma and a space, for example "a", "b". The wrapping is done in the helper module; it currently uses single quotes. Fix the helper.`,
      cases: [[[['a', 'b']], '"a", "b"'], [[['x']], '"x"']],
    };
  },
  // 21 helper renders a value without quotes
  (E, H, imp) => {
    const entry = `import { ${H} } from '${imp}';\n\nexport function ${E}(object) {\n  const parts = Object.entries(object).map(([key, value]) => ${H}(key, value));\n  return '{ ' + parts.join(', ') + ' }';\n}\n`;
    const mkHelper = (body) => [`export function ${H}(key, value) {`, '  return ' + body + ';', '}', ''].join('\n');
    return {
      why: 'helper renders a value without quotes', key: 'kvquote', buggyIn: 'helper', entry, helper: mkHelper('`"${key}": ${value}`'), fixed: mkHelper('`"${key}": "${value}"`'),
      prompt: `${E}(object) renders an object of strings as { "key": "value", ... } with both keys and values in double quotes. Values currently lose their quotes. The pair formatting lives in the helper module; fix the helper.`,
      cases: [[[{ a: 'x', b: 'y' }], '{ "a": "x", "b": "y" }'], [[{ k: 'v' }], '{ "k": "v" }']],
    };
  },
  // 22 helper strips only the first surrounding quote
  (E, H, imp) => {
    const entry = `import { ${H} } from '${imp}';\n\nexport function ${E}(values) {\n  return values.map((value) => ${H}(value));\n}\n`;
    const mkHelper = (flag) => [`export function ${H}(text) {`, `  return text.replace(/^"|"$/${flag}, '');`, '}', ''].join('\n');
    return {
      why: 'helper strips only the first surrounding quote', key: 'stripquote', buggyIn: 'helper', entry, helper: mkHelper(''), fixed: mkHelper('g'),
      prompt: `${E}(values) removes the double quote at the start and the one at the end of every text, so "abc" becomes abc. Only the first quote is removed today. The removal is in the helper module; fix the helper.`,
      cases: [[[['"abc"', 'plain']], ['abc', 'plain']], [[['"x"']], ['x']]],
    };
  },
  // 23 helper escapes quotes but not backslashes
  (E, H, imp) => {
    const entry = `import { ${H} } from '${imp}';\n\nexport function ${E}(message) {\n  return 'msg="' + ${H}(message) + '"';\n}\n`;
    const mkHelper = (chain) => [`export function ${H}(text) {`, `  return text${chain};`, '}', ''].join('\n');
    return {
      why: 'helper escapes quotes but not backslashes', key: 'escapelog', buggyIn: 'helper', entry, helper: mkHelper(".replace(/\"/g, '\\\\\"')"), fixed: mkHelper(".replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\\\"')"),
      prompt: `${E}(message) writes a log field as msg="..." where inside the quotes every backslash is written twice and every double quote gets a backslash in front. Backslashes are not written twice today. The escaping is in the helper module; fix the helper.`,
      cases: [[['say "hi"'], 'msg="say \\"hi\\""'], [['a\\b'], 'msg="a\\\\b"']],
    };
  },
];

const workRoot = mkdtempSync(join(tmpdir(), 'agentcp-gen-'));
let counter = 0;

async function runPair(example, entrySource, helperSource, entryPath, helperPath) {
  counter += 1;
  const dir = join(workRoot, `c${counter}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, entryPath), entrySource);
  writeFileSync(join(dir, helperPath), helperSource);
  const mod = await import(`${pathToFileURL(join(dir, entryPath)).href}`);
  const fn = mod[example.E];
  for (const [args, expected] of example.cases) {
    let actual;
    try { actual = await fn(...structuredClone(args)); } catch { return false; }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  return true;
}

const ADAPTER = await import(pathToFileURL(resolve(import.meta.dirname, '..', '..', 'src', 'adapters', 'ollama.ts')).href);
const SYSTEM_PROMPT = BLOCKS ? ADAPTER.FILE_EDITS_BLOCKS_SYSTEM_PROMPT : ADAPTER.FILE_EDITS_SYSTEM_PROMPT;

// Protocol v4 rows: plain-text FILE blocks instead of a JSON answer. Also converts rows read from an earlier JSON file.
function toBlocksRow(row) {
  const edits = JSON.parse(row.messages[2].content).edits;
  const answer = edits.map((e) => `<<<FILE ${e.path}\n${e.content}>>>END`).join('\n');
  return { messages: [{ role: 'system', content: SYSTEM_PROMPT }, row.messages[1], { role: 'assistant', content: answer }] };
}

function block(path, text) { return `FILE ${path} BYTES ${Buffer.byteLength(text, 'utf8')}\n${text}`; }

const rows = [];
const seen = new Set();
let attempts = 0;
while (rows.length < COUNT && attempts < COUNT * 80) {
  attempts += 1;
  const index = attempts % TEMPLATES.length;
  const E = pick(ENTRY_NAMES);
  const H = pick(HELPER_NAMES);
  const entryPath = pick(ENTRY_FILES);
  const helperPath = pick(HELPER_FILES);
  const imp = `./${helperPath.split('/').pop()}`;
  const t = TEMPLATES[index](E, H, imp);
  // Real tasks never say which file is wrong: half of the prompts keep only their first sentence.
  if (!['badimport', 'defaultimport'].includes(t.key) && rand() < 0.5) {
    const cut = t.prompt.indexOf('. ');
    if (cut > 0) t.prompt = t.prompt.slice(0, cut + 1);
  }
  const identity = `${t.key}|${t.prompt}|${entryPath}|${helperPath}`;
  if (seen.has(identity)) continue;
  const example = { E, cases: t.cases };
  const goodEntry = t.buggyIn === 'entry' ? t.fixed : t.entry;
  const goodHelper = t.buggyIn === 'helper' ? t.fixed : t.helper;
  const okFixed = await runPair(example, goodEntry, goodHelper, entryPath, helperPath);
  const okBuggy = await runPair(example, t.entry, t.helper, entryPath, helperPath).catch(() => false);
  if (!okFixed || okBuggy) throw new Error(`template ${t.key} failed its own check (fixed=${okFixed}, buggy=${okBuggy})`);
  seen.add(identity);
  // Files are listed in path order, as the adapter does.
  const files = [{ path: entryPath, text: t.entry }, { path: helperPath, text: t.helper }].sort((a, b) => (a.path < b.path ? -1 : 1));
  const context = `${JSON.stringify({ task: t.prompt, allowedPaths: ['src/**/*.mjs'], requestedOperations: ['write'], declaredTestIds: [] })}\n${files.map((f) => block(f.path, f.text)).join('\n')}`;
  const target = t.buggyIn === 'entry' ? entryPath : helperPath;
  const answer = JSON.stringify({ proposalId: `fix-${t.key}`, edits: [{ path: target, content: t.fixed }] });
  const row = { messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: context }, { role: 'assistant', content: answer }] };
  if (V5) {
    const review = { messages: [{ role: 'system', content: ADAPTER.LOCALIZE_SYSTEM_PROMPTS.helpers }, row.messages[1], { role: 'assistant', content: `${t.why}.\nDEFECT_FILE: ${target}` }] };
    const editUser = `${context}${ADAPTER.buildLocalizationNote({ analysis: '', path: target })}`;
    const edit = { messages: [{ role: 'system', content: ADAPTER.FILE_EDITS_BLOCKS_SYSTEM_PROMPT }, { role: 'user', content: editUser }, { role: 'assistant', content: `<<<FILE ${target}\n${t.fixed}>>>END` }] };
    rows.push({ pair: [review, edit] });
  } else rows.push(BLOCKS ? toBlocksRow(row) : row);
}
rmSync(workRoot, { recursive: true, force: true });

const validationCount = Math.max(10, Math.floor(rows.length / 12));
let mixTrain = [];
if (mixArg && /^[0-9]+$/.test(mixCountArg ?? '')) {
  const old = readFileSync(join(resolve(mixArg), 'train.jsonl'), 'utf8').split('\n').filter(Boolean);
  for (let i = old.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [old[i], old[j]] = [old[j], old[i]]; }
  mixTrain = old.slice(0, Number(mixCountArg)).map((line) => (BLOCKS ? toBlocksRow(JSON.parse(line)) : JSON.parse(line)));
}
for (let i = rows.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rand() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]];
}
const flat = (list) => (V5 ? list.flatMap((r) => r.pair) : list);
const valRows = flat(rows.slice(0, validationCount));
const train = [...flat(rows.slice(validationCount)), ...mixTrain];
for (let i = train.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'val.jsonl'), `${valRows.map((r) => JSON.stringify(r)).join('\n')}\n`);
writeFileSync(join(outDir, 'train.jsonl'), `${train.map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(JSON.stringify({ integration: rows.length, train: train.length, val: validationCount, mixed: mixTrain.length, templates: TEMPLATES.length, ...(V5 ? { v5rows: valRows.length + train.length - mixTrain.length } : {}) }));
