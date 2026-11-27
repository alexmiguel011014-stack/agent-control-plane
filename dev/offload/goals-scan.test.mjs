import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from './goals-scan.mjs';

const item = (id, o = {}) => [
  `- [ ] **${id} Title.**`,
  `  - tier: ${o.tier ?? 'light · low'}`,
  `  - gate: ${o.gate ?? 'auto'}`,
  `  - files: ${o.files ?? '`bench/tasks/a.mjs` (new)'}`,
  `  - check: ${o.check ?? 'run `node a.mjs`. Expected exit code: 0.'}`,
].join('\n');

const text = [
  '# Goals', '',
  item('G22.1'),
  item('G22.2', { tier: 'standard · medium' }),
  item('G22.3', { gate: 'human' }),
  item('G22.4', { files: '`bench/tasks/a.mjs` (new), `bench/tasks/b.mjs` (exists)' }),
  item('G22.5', { files: 'none.' }),
  item('G22.6', { files: '`src/a.mjs` (exists)' }),
  item('G22.7', { check: 'Verify by eye.' }),
  item('G22.8', { files: '`disposable/x/a.mjs` (new)' }),
  '- [x] **G22.9 Done.**', '  - tier: light · low', '',
].join('\n');

test('classifies each rule, skips checked, prints total', () => {
  assert.deepEqual(scan(text), [
    'G22.1 candidate -',
    'G22.2 not_candidate tier_not_light',
    'G22.3 not_candidate gate_not_auto',
    'G22.4 not_candidate not_one_file',
    'G22.5 not_candidate not_one_file',
    'G22.6 not_candidate not_disposable_path',
    'G22.7 not_candidate no_check_command',
    'G22.8 candidate -',
    'total: 8 unchecked, 2 candidate',
  ]);
});

test('empty input gives zero total', () => {
  assert.deepEqual(scan(''), ['total: 0 unchecked, 0 candidate']);
});
