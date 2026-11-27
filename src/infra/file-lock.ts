import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ensureOrdinaryDirectory } from './path-safety.ts';

interface LockRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly token: string;
  readonly kind: string;
}

export interface FileLockHandle {
  release(): Promise<void>;
}

export class FileLockBusyError extends Error {
  readonly owner?: Readonly<{ pid: number; kind: string }>;

  constructor(owner?: Readonly<{ pid: number; kind: string }>) {
    super('A local file lock already exists and requires operator review');
    this.name = 'FileLockBusyError';
    this.owner = owner;
  }
}

export class FileLockOwnershipError extends Error {
  constructor() {
    super('The local file lock is no longer owned by this handle');
    this.name = 'FileLockOwnershipError';
  }
}

function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.pid === 'number'
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.token === 'string'
    && /^[a-f0-9-]{36}$/.test(record.token)
    && typeof record.kind === 'string'
    && /^[a-z][a-z0-9_-]{0,31}$/.test(record.kind);
}

async function readOwner(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    return isLockRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Acquire by exclusive create. Any existing lock blocks until operator cleanup. */
export async function tryAcquireExclusiveFileLock(
  lockPath: string,
  kind: string,
): Promise<FileLockHandle> {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) throw new FileLockBusyError();
  const absolutePath = resolve(lockPath);
  await ensureOrdinaryDirectory(dirname(absolutePath), () => new FileLockBusyError());

  const token = randomUUID();
  const record: LockRecord = { schemaVersion: 1, pid: process.pid, token, kind };
  let handle;
  try {
    handle = await open(absolutePath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const owner = await readOwner(absolutePath);
      throw new FileLockBusyError(owner ? { pid: owner.pid, kind: owner.kind } : undefined);
    }
    throw new FileLockBusyError();
  }
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  return Object.freeze({
    async release(): Promise<void> {
      const owner = await readOwner(absolutePath);
      if (!owner || owner.token !== token) throw new FileLockOwnershipError();
      await unlink(absolutePath);
    },
  });
}
