import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TASK_CREATED_EVENT, type TaskEvent } from '../domain/event.ts';
import { TASK_ID_PATTERN } from '../domain/task.ts';
import type { ObservedTaskReaderPort, ObservedTaskStream } from '../application/ports/index.ts';

const STREAM_SUFFIX = '.jsonl';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the event when the line has the on-disk shape for this task, otherwise null. */
function parseLine(line: string, taskId: string): TaskEvent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null;
  const event = parsed.event;
  if (!isRecord(event)
    || typeof event.eventId !== 'string'
    || typeof event.type !== 'string'
    || typeof event.occurredAt !== 'string'
    || event.taskId !== taskId) return null;
  return event as unknown as TaskEvent;
}

/**
 * Read-only view of the per-task event streams. It takes no lock and never changes a file:
 * an incomplete final line (a write in progress) is ignored, and any stream with an
 * unreadable line is skipped as a whole.
 */
export class JsonlObservedTaskReader implements ObservedTaskReaderPort {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  private async readStream(taskId: string): Promise<ObservedTaskStream | null> {
    const path = join(this.directory, `${taskId}${STREAM_SUFFIX}`);
    let bytes: Buffer;
    try {
      const info = await lstat(path);
      if (!info.isFile()) return null;
      bytes = await readFile(path);
    } catch {
      return null;
    }
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) return null;

    const events: TaskEvent[] = [];
    for (const line of bytes.subarray(0, lastNewline).toString('utf8').split('\n')) {
      const event = parseLine(line, taskId);
      if (!event) return null;
      events.push(event);
    }
    if (events[0]?.type !== TASK_CREATED_EVENT) return null;
    return Object.freeze({ taskId, events: Object.freeze(events) });
  }

  async readStreams(): Promise<readonly ObservedTaskStream[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return Object.freeze([]);
      throw error;
    }
    const streams: ObservedTaskStream[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(STREAM_SUFFIX)) continue;
      const taskId = name.slice(0, -STREAM_SUFFIX.length);
      if (!TASK_ID_PATTERN.test(taskId)) continue;
      const stream = await this.readStream(taskId);
      if (stream) streams.push(stream);
    }
    return Object.freeze(streams);
  }
}
