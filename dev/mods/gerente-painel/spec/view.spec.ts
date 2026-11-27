import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fila, panelLines } from '../hooks/lib/view.ts';
import type { PanelData } from '../hooks/lib/view.ts';
import type { QueueItem } from '../hooks/lib/goals.ts';

function item(n: number, kind: 'executable' | 'owner'): QueueItem {
  return { id: `G1.${n}`, title: `Title ${n}`, kind, tier: null, gate: null, plan: '1' };
}

const data: PanelData = {
  generatedAt: '2026-11-23T10:00:00Z',
  queue: [item(1, 'executable'), item(2, 'owner'), item(3, 'executable')],
  runs: [
    { shortId: '20202657', suiteId: 'suite-a', modelTag: 'qwen3.5:9b', attempts: 4, pass: 3, fail: 1, other: 0, startedAtUtc: '2026-11-19T20:26:57Z' },
  ],
  kaggle: {
    latest: [{ kernel: 'me/slug', version: 3, status: 'COMPLETE', ts: '2026-11-22T00:00:00Z' }],
    weekHours: 1.25,
  },
  resources: 'gpu 10%\nram 40%',
};

test('panelLines full layout', () => {
  assert.deepEqual(panelLines(data, 100), [
    'Gerente painel  2026-11-23T10:00:00Z',
    'QUEUE  executable 2  owner 1',
    '  G1.1  Title 1',
    '  G1.3  Title 3',
    '  G1.2  Title 2',
    'RUNS (latest 1)',
    '  20202657  suite-a  qwen3.5:9b  3/4  2026-11-19T20:26:57Z',
    'KAGGLE',
    '  me/slug v3 COMPLETE',
    '  week 1.3 of 30 h (estimate)',
    'RESOURCES',
    '  gpu 10%',
    '  ram 40%',
  ]);
});

test('panelLines empty data and unavailable resources', () => {
  const empty: PanelData = { generatedAt: 'T', queue: [], runs: [], kaggle: { latest: [], weekHours: 0 }, resources: null };
  assert.deepEqual(panelLines(empty, 80), [
    'Gerente painel  T',
    'QUEUE  executable 0  owner 0',
    'RUNS (latest 0)',
    '  none',
    'KAGGLE',
    '  none',
    '  week 0.0 of 30 h (estimate)',
    'RESOURCES',
    '  unavailable',
  ]);
});

test('panelLines caps the lists at 8 executable and 6 owner', () => {
  const queue = [
    ...Array.from({ length: 10 }, (_, i) => item(i + 1, 'executable')),
    ...Array.from({ length: 8 }, (_, i) => item(i + 21, 'owner')),
  ];
  const lines = panelLines({ ...data, queue }, 100);
  assert.equal(lines[1], 'QUEUE  executable 10  owner 8');
  assert.deepEqual(lines.slice(2, 16), [
    '  G1.1  Title 1',
    '  G1.2  Title 2',
    '  G1.3  Title 3',
    '  G1.4  Title 4',
    '  G1.5  Title 5',
    '  G1.6  Title 6',
    '  G1.7  Title 7',
    '  G1.8  Title 8',
    '  G1.21  Title 21',
    '  G1.22  Title 22',
    '  G1.23  Title 23',
    '  G1.24  Title 24',
    '  G1.25  Title 25',
    '  G1.26  Title 26',
  ]);
  assert.equal(lines[16], 'RUNS (latest 1)');
});

test('panelLines cuts to width with an ellipsis', () => {
  const lines = panelLines(data, 10);
  assert.equal(lines[0], 'Gerente p…');
  assert.equal(lines[2], '  G1.1  T…');
  assert.equal(lines[3], '  G1.3  T…');
  assert.equal(lines[1], 'QUEUE  ex…');
  assert.equal(lines[5], 'RUNS (lat…');
  assert.equal(lines[7], 'KAGGLE');
  assert.ok(lines.every((l) => Array.from(l).length <= 10));
});

test('fila lists the whole queue', () => {
  const queue = Array.from({ length: 10 }, (_, i) => item(i + 1, 'executable'));
  queue.push(item(50, 'owner'));
  assert.equal(
    fila(queue),
    [
      'executable (10)',
      '  G1.1  Title 1',
      '  G1.2  Title 2',
      '  G1.3  Title 3',
      '  G1.4  Title 4',
      '  G1.5  Title 5',
      '  G1.6  Title 6',
      '  G1.7  Title 7',
      '  G1.8  Title 8',
      '  G1.9  Title 9',
      '  G1.10  Title 10',
      'owner (1)',
      '  G1.50  Title 50',
    ].join('\n'),
  );
  assert.equal(fila([]), 'executable (0)\n  none\nowner (0)\n  none');
});
