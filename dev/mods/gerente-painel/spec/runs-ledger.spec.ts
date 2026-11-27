import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRuns } from '../hooks/lib/runs.ts';
import { parseLedger, kaggleSummary } from '../hooks/lib/ledger.ts';
import type { LedgerLine } from '../hooks/lib/ledger.ts';

const att = (runId: string, status: string, startedAtUtc: string) => ({
  runId,
  suiteId: 's1',
  startedAtUtc,
  model: { tag: 'qwen3.5:9b' },
  outcome: { status },
});

test('groups attempts by run, counts outcomes, earliest start, short id, sort and limit', () => {
  const rows = summarizeRuns(
    [
      att('offload-20261119202657', 'PASS', '2026-11-19T20:30:00Z'),
      att('offload-20261119202657', 'FAIL', '2026-11-19T20:26:57Z'),
      att('offload-20261119202657', 'TIMEOUT', '2026-11-19T20:40:00Z'),
      att('offload-20261120000000', 'PASS', '2026-11-20T00:00:00Z'),
    ],
    10,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].shortId, '20000000');
  assert.equal(rows[1].shortId, '19202657');
  assert.deepEqual(
    [rows[1].attempts, rows[1].pass, rows[1].fail, rows[1].other, rows[1].startedAtUtc],
    [3, 1, 1, 1, '2026-11-19T20:26:57Z'],
  );
  const two = [att('a1234567890', 'PASS', '2026-01-01'), att('b1234567890', 'PASS', '2026-01-02')];
  assert.equal(summarizeRuns(two, 1).length, 1);
});

test('skips attempts with missing fields', () => {
  const base = att('r1', 'PASS', 't');
  const bad = [
    null,
    'x',
    { ...base, runId: undefined },
    { ...base, suiteId: 3 },
    { ...base, startedAtUtc: undefined },
    { ...base, model: {} },
    { ...base, outcome: {} },
  ];
  assert.deepEqual(summarizeRuns(bad, 5), []);
});

test('parseLedger skips malformed lines', () => {
  const good = { ts: '2026-11-20T00:00:00.000Z', kernel: 'a/b', version: 1, event: 'push', status: null, gpuSeconds: null, note: '' };
  const text = [
    JSON.stringify(good),
    'not json',
    JSON.stringify({ ...good, version: '1' }),
    JSON.stringify({ ...good, event: 'nope' }),
    JSON.stringify({ ...good, note: 5 }),
    '',
    '[1]',
  ].join('\n');
  assert.deepEqual(parseLedger(text), [good]);
});

test('kaggleSummary keeps the newest line per kernel and sums 7 days of output', () => {
  const now = Date.parse('2026-11-23T00:00:00Z');
  const L = (ts: string, kernel: string, event: LedgerLine['event'], status: string | null, gpuSeconds: number | null): LedgerLine => ({
    ts,
    kernel,
    version: 1,
    event,
    status,
    gpuSeconds,
    note: '',
  });
  const s = kaggleSummary(
    [
      L('2026-11-22T00:00:00Z', 'o/k1', 'output', 'COMPLETE', 3600),
      L('2026-11-21T00:00:00Z', 'o/k1', 'status', 'RUNNING', null),
      L('2026-11-20T00:00:00Z', 'o/k2', 'output', 'COMPLETE', 1800),
      L('2026-11-10T00:00:00Z', 'o/k2', 'output', 'COMPLETE', 7200),
      L('2026-11-22T00:00:00Z', 'o/k2', 'status', 'RUNNING', 900),
    ],
    now,
  );
  assert.equal(s.latest.length, 2);
  assert.equal(s.latest.find((x) => x.kernel === 'o/k1')?.status, 'COMPLETE');
  assert.equal(s.latest.find((x) => x.kernel === 'o/k2')?.status, 'RUNNING');
  assert.equal(s.weekHours, 1.5);
});
