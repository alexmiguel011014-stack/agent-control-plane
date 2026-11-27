import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dirname, 'ledger.mjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const tmp = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'sub', 'l.jsonl');

test('valid line', () => {
  const f = tmp();
  const r = run('output', 'me/k-1', '--version', '3', '--status', 'COMPLETE', '--gpu-seconds', '120', '--note', 'ok', '--file', f);
  assert.equal(r.status, 0);
  const o = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepEqual(Object.keys(o), ['ts', 'kernel', 'version', 'event', 'status', 'gpuSeconds', 'note']);
  assert.equal(o.kernel, 'me/k-1');
  assert.equal(o.version, 3);
  assert.equal(o.event, 'output');
  assert.equal(o.status, 'COMPLETE');
  assert.equal(o.gpuSeconds, 120);
  assert.equal(o.note, 'ok');
  assert.match(o.ts, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(r.stdout, readFileSync(f, 'utf8'));
});

test('defaults are null and empty note', () => {
  const f = tmp();
  assert.equal(run('push', 'me/k', '--file', f).status, 0);
  const o = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(o.version, null);
  assert.equal(o.status, null);
  assert.equal(o.gpuSeconds, null);
  assert.equal(o.note, '');
});

test('refusals exit 1 and write nothing', () => {
  const f = tmp();
  const bad = [
    ['nope', 'me/k'],
    ['push', 'Me/k'],
    ['push', 'me'],
    ['push', '-me/k'],
    ['push', 'me/k', '--status', 'complete'],
    ['push', 'me/k', '--status', 'A'.repeat(25)],
    ['push', 'me/k', '--version', '-1'],
    ['push', 'me/k', '--version', '1.5'],
    ['push', 'me/k', '--gpu-seconds', 'x'],
    ['push', 'me/k', '--note', 'x'.repeat(201)],
    ['push', 'me/k', '--note', 'a\nb'],
    ['push', 'me/k', '--bogus', '1'],
    ['push'],
  ];
  for (const a of bad) {
    const r = run(...a, '--file', f);
    assert.equal(r.status, 1, a.join(' '));
    assert.ok(r.stderr.trim().length > 0);
  }
  assert.equal(existsSync(f), false);
});

test('two appends keep order; missing folder is created', () => {
  const f = tmp();
  run('push', 'me/k', '--file', f);
  run('delete', 'me/k', '--file', f);
  const lines = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['push', 'delete']);
});
