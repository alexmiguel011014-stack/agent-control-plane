import assert from 'node:assert/strict';
import test from 'node:test';

import type { ObservabilitySnapshot } from '../../application/ports/index.ts';
import { runWatch } from './watch.ts';

const snap = { generatedAt: 'x' } as unknown as ObservabilitySnapshot;
const render = (): string[] => ['a', 'b'];

function setup(overrides: Partial<Parameters<typeof runWatch>[0]> = {}) {
  const out: string[] = [];
  const controller = new AbortController();
  const base = {
    getSnapshot: () => snap,
    render,
    write: (t: string) => void out.push(t),
    intervalMs: 10,
    once: false,
    interactive: true,
    signal: controller.signal,
    sleep: async () => {},
  };
  return { out, controller, options: { ...base, ...overrides } };
}

test('once writes a single frame', async () => {
  const { out, options } = setup({ once: true });
  await runWatch(options);
  assert.deepEqual(out, ['\x1b[?25l', '\x1b[H\x1b[2J', 'a\nb\n', '\x1b[?25h']);
});

test('non-interactive returns after one frame without clearing', async () => {
  const { out, options } = setup({ interactive: false });
  await runWatch(options);
  assert.deepEqual(out, ['a\nb\n']);
});

test('three frames then abort restores the cursor', async () => {
  let frames = 0;
  const { out, controller, options } = setup();
  options.sleep = async () => {
    if (++frames === 3) controller.abort();
  };
  await runWatch(options);
  assert.equal(out.filter((t) => t === 'a\nb\n').length, 3);
  assert.equal(out[0], '\x1b[?25l');
  assert.equal(out.at(-1), '\x1b[?25h');
});

test('cursor restored when abort happens during sleep', async () => {
  const { out, controller, options } = setup();
  options.sleep = async () => controller.abort();
  await runWatch(options);
  assert.equal(out.at(-1), '\x1b[?25h');
});

test('snapshot error writes only the error name and continues', async () => {
  let calls = 0;
  const { out, controller, options } = setup({
    getSnapshot: () => {
      if (++calls === 1) throw new TypeError('secret message');
      return snap;
    },
  });
  options.sleep = async () => {
    if (calls >= 2) controller.abort();
  };
  await runWatch(options);
  assert.ok(out.includes('watch error: TypeError\n'));
  assert.ok(!out.join('').includes('secret'));
  assert.ok(out.includes('a\nb\n'));
});

test('error with once returns after that line', async () => {
  const { out, options } = setup({
    once: true,
    getSnapshot: () => {
      throw new RangeError('boom');
    },
  });
  await runWatch(options);
  assert.ok(out.includes('watch error: RangeError\n'));
  assert.equal(out.at(-1), '\x1b[?25h');
});
