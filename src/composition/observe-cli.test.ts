import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createObservabilityComposition } from './observe-cli.ts';

test('observability composition on an empty directory reports nothing and writes nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observe-cli-'));
  try {
    const service = createObservabilityComposition({
      repositoryRoot: directory,
      stateDirectory: join(directory, '.agentctl'),
      resources: {
        sample: async () => ({ gpu: { status: 'unavailable' }, ramFreeBytes: 1, ramTotalBytes: 2, cpuPercent: null }),
      },
    });
    const snapshot = await service.getSnapshot();
    assert.deepEqual(snapshot.tasks, []);
    assert.deepEqual(snapshot.runs, []);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('agentctl watch --once --json prints one snapshot as JSON and writes nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observe-cli-json-'));
  try {
    const binary = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../bin/agentctl.ts' : '../bin/agentctl.js', import.meta.url));
    const result = spawnSync(process.execPath, [binary, 'watch', '--once', '--json'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const key of ['generatedAt', 'tasks', 'runs', 'resources']) assert.ok(key in snapshot, key);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
