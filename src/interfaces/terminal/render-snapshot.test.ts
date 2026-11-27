import assert from 'node:assert/strict';
import test from 'node:test';

import type { ObservabilitySnapshot } from '../../application/ports/index.ts';
import { renderSnapshot } from './render-snapshot.ts';

const GIB = 1024 ** 3;
const snapshot: ObservabilitySnapshot = {
  generatedAt: '2026-11-13T10:00:00.000Z',
  resources: {
    gpu: { status: 'available', usedMiB: 4096, totalMiB: 8192 },
    ramFreeBytes: 12.34 * GIB,
    ramTotalBytes: 32 * GIB,
    cpuPercent: 17,
  },
  tasks: [
    { taskId: 'task-1', state: 'SUCCEEDED', eventCount: 12, lastEventAt: '2026-11-13T09:59:00Z' },
    { taskId: 'task-two', state: 'WAITING_APPROVAL', eventCount: 3, lastEventAt: '2026-11-13T09:58:00Z' },
    { taskId: 'task-3', state: 'FAILED', eventCount: 7, lastEventAt: '2026-11-13T09:57:00Z' },
    { taskId: 'task-4', state: 'RUNNING', eventCount: 1, lastEventAt: '2026-11-13T09:56:00Z' },
  ],
  runs: [
    {
      runId: 'abcdef1234567890',
      suiteId: 'g3-integration',
      modelTag: 'qwen3.5:9b',
      startedAtUtc: '2026-11-13T08:00:00Z',
      attempts: 30,
      counts: { PASS: 20, FAIL: 7, POLICY_VIOLATION: 1, TIMEOUT: 1, CRASH: 1, RUNNER_FAILURE: 0 },
    },
  ],
};

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string): string => s.replace(ANSI, '');

test('renders exact lines without color (width 100, the longest run row is 81 chars)', () => {
  assert.deepEqual(renderSnapshot(snapshot, { width: 100, color: false }), [
    'agentctl watch  2026-11-13T10:00:00.000Z',
    'RESOURCES  GPU 4096/8192 MiB  RAM 12.3 GiB free of 32.0 GiB  CPU 17%',
    '',
    'TASKS (4)',
    'ID        STATE             EVENTS  LAST EVENT',
    'task-1    SUCCEEDED         12      2026-11-13T09:59:00Z',
    'task-two  WAITING_APPROVAL  3       2026-11-13T09:58:00Z',
    'task-3    FAILED            7       2026-11-13T09:57:00Z',
    'task-4    RUNNING           1       2026-11-13T09:56:00Z',
    '',
    'RUNS (latest 1)',
    'RUN       SUITE           MODEL       ATTEMPTS  PASS  FAIL  OTHER  STARTED',
    'abcdef12  g3-integration  qwen3.5:9b  30        20    7     3      2026-11-13T08:00:00Z',
  ]);
});

test('truncates lines to the width with an ellipsis', () => {
  const lines = renderSnapshot(snapshot, { width: 60, color: false });
  for (const line of lines) assert.ok(line.length <= 60, line);
  assert.equal(lines[1], 'RESOURCES  GPU 4096/8192 MiB  RAM 12.3 GiB free of 32.0 GiB…');
  assert.equal(lines[12]?.endsWith('…'), true);
});

test('color output strips back to the plain output and colors states', () => {
  const plain = renderSnapshot(snapshot, { width: 100, color: false });
  const colored = renderSnapshot(snapshot, { width: 100, color: true });
  assert.deepEqual(colored.map(strip), plain);
  assert.ok(colored[5]?.includes('\x1b[32mSUCCEEDED       \x1b[0m'));
  assert.ok(colored[6]?.includes('\x1b[33mWAITING_APPROVAL\x1b[0m'));
  assert.ok(colored[7]?.includes('\x1b[31mFAILED          \x1b[0m'));
  assert.equal(colored[8], plain[8]);
});

test('renders empty tasks, empty runs, and unavailable resources', () => {
  const lines = renderSnapshot(
    { generatedAt: 'T', tasks: [], runs: [], resources: { gpu: { status: 'unavailable' }, ramFreeBytes: GIB, ramTotalBytes: 2 * GIB, cpuPercent: null } },
    { width: 80, color: true },
  );
  assert.deepEqual(lines, [
    'agentctl watch  T',
    'RESOURCES  GPU n/a  RAM 1.0 GiB free of 2.0 GiB  CPU n/a',
    '',
    'TASKS (0)',
    'ID  STATE  EVENTS  LAST EVENT',
    '  none',
    '',
    'RUNS (latest 0)',
    'RUN  SUITE  MODEL  ATTEMPTS  PASS  FAIL  OTHER  STARTED',
    '  none',
  ]);
});
