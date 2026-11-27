import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseGoals } from '../hooks/lib/goals.ts';

const SAMPLE = [
  '## GOALS 23 — Training',
  '',
  '- [ ] **G23.12 Run the training spike on Kaggle.**',
  '  - tier: standard · medium',
  '  - gate: auto',
  '  - do:',
  '    1. Go.',
  '- [ ] **G23.13 Approve the result.**',
  '  - tier: user',
  '  - gate: ask',
  '- [x] **G23.1 Done already.**',
  '  - tier: standard',
  '## GOALS 3 — Small',
  '- [ ] **G3.4 [MANUAL, OPTIONAL] Run a remote-existing-allowance comparison.** Only after the rest.',
  '## Owner backlog',
  '',
  '- [ ] **G17.7 Review the new report and write the attestation.** (GOALS 17)',
  '  - tier: standard',
  '  - gate: auto',
].join('\n');

test('executor-v1 item', () => {
  const it = parseGoals(SAMPLE).find((i) => i.id === 'G23.12');
  assert.deepEqual(it, {
    id: 'G23.12', title: 'Run the training spike on Kaggle.', kind: 'executable',
    tier: 'standard · medium', gate: 'auto', plan: '23',
  });
});

test('tier user is owner', () => {
  const it = parseGoals(SAMPLE).find((i) => i.id === 'G23.13');
  assert.equal(it?.kind, 'owner');
  assert.equal(it?.tier, 'user');
  assert.equal(it?.gate, 'ask');
});

test('old format MANUAL item', () => {
  const it = parseGoals(SAMPLE).find((i) => i.id === 'G3.4');
  assert.equal(it?.kind, 'owner');
  assert.equal(it?.tier, null);
  assert.equal(it?.gate, null);
  assert.equal(it?.plan, '3');
  assert.equal(it?.title.length, 60);
  assert.ok(it?.title.endsWith('…'));
});

test('checked item is skipped', () => {
  const ids = parseGoals(SAMPLE).map((i) => i.id);
  assert.ok(!ids.includes('G23.1'));
  assert.deepEqual(ids, ['G23.12', 'G23.13', 'G3.4', 'G17.7']);
});

test('owner backlog item', () => {
  const it = parseGoals(SAMPLE).find((i) => i.id === 'G17.7');
  assert.equal(it?.plan, null);
  assert.equal(it?.kind, 'owner');
  assert.equal(it?.title, 'Review the new report and write the attestation.');
});

test('real GOALS.md ids are well formed', () => {
  const file = path.resolve(import.meta.dirname, '../../../../GOALS.md');
  const items = parseGoals(fs.readFileSync(file, 'utf8'));
  assert.ok(items.length > 0);
  for (const it of items) assert.match(it.id, /^G[0-9]+\.[0-9]+$/);
});
