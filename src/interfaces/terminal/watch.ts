import type { ObservabilitySnapshot } from '../../application/ports/index.ts';

export interface WatchOptions {
  getSnapshot: () => ObservabilitySnapshot | Promise<ObservabilitySnapshot>;
  render: (snapshot: ObservabilitySnapshot) => string[];
  write: (text: string) => void;
  intervalMs: number;
  once: boolean;
  interactive: boolean;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const CLEAR = '\x1b[H\x1b[2J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function runWatch(options: WatchOptions): Promise<void> {
  const { getSnapshot, render, write, intervalMs, once, interactive, signal } = options;
  const sleep = options.sleep ?? abortableSleep;
  // Cursor codes are control text: write them only for a live terminal, never into piped output.
  if (interactive) write(HIDE_CURSOR);
  try {
    while (!signal.aborted) {
      let frame: string;
      try {
        frame = `${render(await getSnapshot()).join('\n')}\n`;
      } catch (error) {
        frame = `watch error: ${error instanceof Error ? error.name : 'Error'}\n`;
      }
      if (interactive) write(CLEAR);
      write(frame);
      if (once || !interactive) return;
      await sleep(intervalMs, signal);
    }
  } finally {
    if (interactive) write(SHOW_CURSOR);
  }
}
