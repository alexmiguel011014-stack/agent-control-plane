import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = join(import.meta.dirname, 'check-contamination.mjs');
const root = mkdtempSync(join(tmpdir(), 'contam-'));
const tasks = join(root, 'tasks');
mkdirSync(join(tasks, 'T01', 'base', 'src'), { recursive: true });
writeFileSync(join(tasks, 'T01', 'base', 'src', 'a.mjs'),
  'export function reserveStock(a) {}\nexport const maxLimit = 3;\nexport const ab = 1;\n');
writeFileSync(join(tasks, 'T01', 'task.json'), JSON.stringify({ prompt: 'Make the widget frobnicate twice.' }));

function run(rowText) {
  const dir = mkdtempSync(join(root, 'data-'));
  writeFileSync(join(dir, 'train.jsonl'), JSON.stringify({ text: rowText }) + '\n');
  writeFileSync(join(dir, 'val.jsonl'), '');
  const r = spawnSync(process.execPath, [script, dir, tasks], { encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()) };
}

test('clean row passes', () => {
  const r = run('add two numbers; ab is short and reserveStockX is a different word');
  assert.equal(r.code, 0);
  assert.equal(r.out.rows, 1);
  assert.equal(r.out.forbiddenNames, 2);
  assert.equal(r.out.forbiddenSentences, 1);
  assert.deepEqual(r.out.hits, []);
});

test('name hit fails', () => {
  const r = run('call reserveStock(x) here');
  assert.equal(r.code, 1);
  assert.equal(r.out.hits[0].kind, 'name');
});

test('sentence hit fails', () => {
  const r = run('Please: Make the widget frobnicate twice. Thanks');
  assert.equal(r.code, 1);
  assert.equal(r.out.hits[0].kind, 'sentence');
});

function runChat(messages) {
  const dir = mkdtempSync(join(root, 'data-'));
  writeFileSync(join(dir, 'train.jsonl'), `${JSON.stringify({ messages })}\n`);
  writeFileSync(join(dir, 'val.jsonl'), '');
  const r = spawnSync(process.execPath, [script, dir, tasks], { encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()) };
}

test('a forbidden name in a system message is ignored', () => {
  const r = runChat([
    { role: 'system', content: 'You review code. Example: reserveStock(x) is a fixed adapter prompt.' },
    { role: 'user', content: 'Fix the total.' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.hits, []);
});

test('a forbidden name in a user or assistant message fails', () => {
  const r = runChat([
    { role: 'system', content: 'prompt' },
    { role: 'user', content: 'Fix reserveStock now.' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.equal(r.code, 1);
  assert.equal(r.out.hits[0].kind, 'name');
});

test.after(() => rmSync(root, { recursive: true, force: true }));
