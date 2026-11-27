import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskExecutionLeaseBusyError } from '../application/ports/index.ts';
import { LocalTaskExecutionLease } from './task-execution-lease.ts';
import { FileLockOwnershipError } from './file-lock.ts';

test('allows one live run or recovery lease and releases only its own lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'runtime', 'controller.lock');
  const owner = new LocalTaskExecutionLease(path);
  const other = new LocalTaskExecutionLease(path);
  const run = await owner.tryAcquire('run');

  await assert.rejects(other.tryAcquire('recovery'), (error: unknown) =>
    error instanceof TaskExecutionLeaseBusyError
    && error.lockConflict.owner?.pid === process.pid
    && error.lockConflict.owner.kind === 'run');
  await run.release();
  const recovery = await other.tryAcquire('recovery');
  await recovery.release();
  await assert.rejects(readFile(path), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('does not remove a stale lock; explicit owner cleanup permits recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-lease-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'controller.lock');
  const staleRecord = `${JSON.stringify({ schemaVersion: 1, pid: 99_999_999, token: randomUUID(), kind: 'run' })}\n`;
  await writeFile(path, staleRecord, 'utf8');
  const lease = new LocalTaskExecutionLease(path);
  await assert.rejects(lease.tryAcquire('recovery'), (error: unknown) =>
    error instanceof TaskExecutionLeaseBusyError
    && error.lockConflict.lockPath === path
    && error.lockConflict.owner?.pid === 99_999_999);
  assert.equal(await readFile(path, 'utf8'), staleRecord);

  // Test-only simulation of the documented operator procedure after verifying
  // that the recorded PID is gone and all other controller instances are closed.
  await unlink(path);
  const recovered = await lease.tryAcquire('recovery');
  await recovered.release();
});

test('malformed lock remains untouched and blocks until explicit cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-lease-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'controller.lock');
  const malformed = '{not-json}\n';
  await writeFile(path, malformed, 'utf8');
  const lease = new LocalTaskExecutionLease(path);
  await assert.rejects(lease.tryAcquire('run'), (error: unknown) =>
    error instanceof TaskExecutionLeaseBusyError
    && error.lockConflict.lockPath === path
    && error.lockConflict.owner === undefined);
  assert.equal(await readFile(path, 'utf8'), malformed);

  await unlink(path);
  const acquired = await lease.tryAcquire('run');
  await acquired.release();
});

test('does not delete a lock whose owner token changed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-lease-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'controller.lock');
  const lease = new LocalTaskExecutionLease(path);
  const handle = await lease.tryAcquire('run');
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: randomUUID(), kind: 'run' })}\n`, 'utf8');
  await assert.rejects(handle.release(), FileLockOwnershipError);
  const stillOwned = JSON.parse(await readFile(path, 'utf8')) as { token: string };
  assert.equal(typeof stillOwned.token, 'string');
  assert.notEqual(stillOwned.token, '');
});
