import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createLocalCliApplication } from './local-cli.ts';

test('startup recovery respects valid and malformed existing leases without clearing them', async (t) => {
  for (const entry of [
    {
      name: 'valid owner',
      contents: JSON.stringify({ schemaVersion: 1, pid: 321, token: '00000000-0000-4000-8000-000000000000', kind: 'run' }),
      owner: { pid: 321, kind: 'run' },
    },
    { name: 'malformed owner', contents: '{invalid', owner: undefined },
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'agentctl-startup-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const lockPath = join(root, 'task-execution.lock');
    await writeFile(lockPath, entry.contents, 'utf8');

    const app = await createLocalCliApplication(root);
    assert.equal(app.startup.state, 'lease_busy', entry.name);
    if (app.startup.state === 'lease_busy') {
      assert.equal(app.startup.lockConflict.lockPath, resolve(lockPath));
      assert.deepEqual(app.startup.lockConflict.owner, entry.owner);
    }
    assert.equal(await readFile(lockPath, 'utf8'), entry.contents, entry.name);
  }
});
