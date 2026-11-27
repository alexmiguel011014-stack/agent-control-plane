import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTaskInventory } from './seal.mjs';

const I_IDS = Array.from({ length: 30 }, (_, index) => `I${String(index + 1).padStart(2, '0')}`);
const expectedIds = [
  'P01', 'P02', 'P03', 'P04',
  'B01', 'B02', 'B03', 'B04', 'B05', 'B06',
  ...I_IDS,
  'S01', 'S02', 'S03', 'S04',
];

test('accepts exactly the required benchmark task IDs', () => {
  assert.deepEqual(validateTaskInventory(expectedIds), [...expectedIds].sort());
});

test('rejects a partial task inventory', () => {
  assert.throws(() => validateTaskInventory(expectedIds.slice(0, -1)), /missing: S04/);
});

test('rejects an unexpected task ID', () => {
  assert.throws(() => validateTaskInventory([...expectedIds, 'P05']), /unexpected: P05/);
});

test('rejects duplicate IDs including case-insensitive duplicates', () => {
  assert.throws(() => validateTaskInventory([...expectedIds, 'P01']), /duplicate: P01/);
  assert.throws(() => validateTaskInventory([...expectedIds, 'p01']), /duplicate: p01/);
});
