import type { QueueItem } from './goals.ts';
import type { RunRow } from './runs.ts';
import type { kaggleSummary } from './ledger.ts';

export type PanelData = {
  generatedAt: string;
  queue: QueueItem[];
  runs: RunRow[];
  kaggle: ReturnType<typeof kaggleSummary>;
  resources: string | null;
};

const MAX_EXECUTABLE = 8;
const MAX_OWNER = 6;

function fit(line: string, width: number): string {
  const chars = Array.from(line);
  if (chars.length <= width) return line;
  return chars.slice(0, Math.max(0, width - 1)).join('') + '…';
}

export function panelLines(data: PanelData, width: number): string[] {
  const executable = data.queue.filter((q) => q.kind === 'executable');
  const owner = data.queue.filter((q) => q.kind === 'owner');
  const lines: string[] = [];

  lines.push(`Gerente painel  ${data.generatedAt}`);

  lines.push(`QUEUE  executable ${executable.length}  owner ${owner.length}`);
  for (const q of executable.slice(0, MAX_EXECUTABLE)) lines.push(`  ${q.id}  ${q.title}`);
  for (const q of owner.slice(0, MAX_OWNER)) lines.push(`  ${q.id}  ${q.title}`);

  lines.push(`RUNS (latest ${data.runs.length})`);
  if (data.runs.length === 0) lines.push('  none');
  for (const r of data.runs) {
    lines.push(`  ${r.shortId}  ${r.suiteId}  ${r.modelTag}  ${r.pass}/${r.attempts}  ${r.startedAtUtc}`);
  }

  lines.push('KAGGLE');
  if (data.kaggle.latest.length === 0) lines.push('  none');
  for (const k of data.kaggle.latest) {
    lines.push(`  ${k.kernel} v${k.version ?? '?'} ${k.status ?? '?'}`);
  }
  lines.push(`  week ${data.kaggle.weekHours.toFixed(1)} of 30 h (estimate)`);

  lines.push('RESOURCES');
  if (data.resources === null) lines.push('  unavailable');
  else for (const l of data.resources.split(/\r?\n/)) lines.push(`  ${l}`);

  return lines.map((l) => fit(l, width));
}

export function fila(queue: QueueItem[]): string {
  const out: string[] = [];
  for (const kind of ['executable', 'owner'] as const) {
    const items = queue.filter((q) => q.kind === kind);
    out.push(`${kind} (${items.length})`);
    if (items.length === 0) out.push('  none');
    for (const q of items) out.push(`  ${q.id}  ${q.title}`);
  }
  return out.join('\n');
}
