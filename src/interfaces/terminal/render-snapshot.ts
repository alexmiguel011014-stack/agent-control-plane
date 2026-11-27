import type { ObservabilitySnapshot } from '../../application/ports/index.ts';
import { TERMINAL_TASK_STATES, type TaskState } from '../../domain/state.ts';

export interface RenderOptions {
  readonly width: number;
  readonly color: boolean;
}

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

const ID_MAX = 24;
const STATE_MAX = 16;
const SUITE_MAX = 30;
const MODEL_MAX = 26;

function clip(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stateColor(state: string): string | null {
  if (state === 'SUCCEEDED') return GREEN;
  if ((TERMINAL_TASK_STATES as readonly string[]).includes(state)) return RED;
  if (state === 'WAITING_APPROVAL') return YELLOW;
  return null;
}

function formatTable(header: readonly string[], rows: readonly (readonly string[])[], maxes: readonly number[]): string[] {
  const all = [header, ...rows].map((row) => row.map((cell, i) => clip(cell, maxes[i] ?? Infinity)));
  const widths = header.map((_, i) => Math.max(...all.map((row) => (row[i] ?? '').length)));
  return all.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

export function renderSnapshot(snapshot: ObservabilitySnapshot, options: RenderOptions): string[] {
  const { resources } = snapshot;
  const gpu = resources.gpu.status === 'available' ? `${resources.gpu.usedMiB}/${resources.gpu.totalMiB} MiB` : 'n/a';
  const cpu = resources.cpuPercent === null ? 'n/a' : `${resources.cpuPercent}%`;

  const lines: { text: string; state?: TaskState }[] = [];
  const add = (text: string, state?: TaskState): void => {
    lines.push(state === undefined ? { text } : { text, state });
  };

  add(`agentctl watch  ${snapshot.generatedAt}`);
  add(`RESOURCES  GPU ${gpu}  RAM ${gib(resources.ramFreeBytes)} GiB free of ${gib(resources.ramTotalBytes)} GiB  CPU ${cpu}`);
  add('');
  add(`TASKS (${snapshot.tasks.length})`);
  const taskTable = formatTable(
    ['ID', 'STATE', 'EVENTS', 'LAST EVENT'],
    snapshot.tasks.map((t) => [t.taskId, t.state, String(t.eventCount), t.lastEventAt]),
    [ID_MAX, STATE_MAX, Infinity, Infinity],
  );
  add(taskTable[0] as string);
  if (snapshot.tasks.length === 0) add('  none');
  snapshot.tasks.forEach((t, i) => {
    add(taskTable[i + 1] as string, t.state);
  });
  add('');
  add(`RUNS (latest ${snapshot.runs.length})`);
  const runTable = formatTable(
    ['RUN', 'SUITE', 'MODEL', 'ATTEMPTS', 'PASS', 'FAIL', 'OTHER', 'STARTED'],
    snapshot.runs.map((r) => [
      r.runId.slice(0, 8),
      r.suiteId,
      r.modelTag,
      String(r.attempts),
      String(r.counts.PASS),
      String(r.counts.FAIL),
      String(r.attempts - r.counts.PASS - r.counts.FAIL),
      r.startedAtUtc,
    ]),
    [Infinity, SUITE_MAX, MODEL_MAX, Infinity, Infinity, Infinity, Infinity, Infinity],
  );
  add(runTable[0] as string);
  if (snapshot.runs.length === 0) add('  none');
  snapshot.runs.forEach((_, i) => {
    add(runTable[i + 1] as string);
  });

  // The STATE column starts after the ID column and its two-space separator.
  const idWidth = Math.max('ID'.length, ...snapshot.tasks.map((t) => Math.min(t.taskId.length, ID_MAX)));
  const stateWidth = Math.max('STATE'.length, ...snapshot.tasks.map((t) => Math.min(t.state.length, STATE_MAX)));
  const stateStart = idWidth + 2;

  return lines.map(({ text, state }) => {
    const cut = clip(text, options.width);
    if (!options.color || state === undefined) return cut;
    const color = stateColor(state);
    if (color === null) return cut;
    const segment = cut.slice(stateStart, stateStart + stateWidth);
    if (segment === '') return cut;
    return `${cut.slice(0, stateStart)}${color}${segment}${RESET}${cut.slice(stateStart + stateWidth)}`;
  });
}
