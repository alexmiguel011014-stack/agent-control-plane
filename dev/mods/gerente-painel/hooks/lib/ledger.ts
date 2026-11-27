export type LedgerLine = {
  ts: string;
  kernel: string;
  version: number | null;
  event: 'push' | 'status' | 'output' | 'delete';
  status: string | null;
  gpuSeconds: number | null;
  note: string;
};

const EVENTS = ['push', 'status', 'output', 'delete'];
const WEEK_MS = 7 * 24 * 3600 * 1000;

function numOrNull(v: unknown): boolean {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

export function parseLedger(text: string): LedgerLine[] {
  const out: LedgerLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) continue;
    const r = o as Record<string, unknown>;
    if (
      typeof r.ts !== 'string' ||
      typeof r.kernel !== 'string' ||
      !numOrNull(r.version) ||
      typeof r.event !== 'string' ||
      !EVENTS.includes(r.event) ||
      !(r.status === null || typeof r.status === 'string') ||
      !numOrNull(r.gpuSeconds) ||
      typeof r.note !== 'string'
    )
      continue;
    out.push(r as unknown as LedgerLine);
  }
  return out;
}

export function kaggleSummary(
  lines: LedgerLine[],
  nowMs: number,
): { latest: Array<{ kernel: string; version: number | null; status: string | null; ts: string }>; weekHours: number } {
  const newest = new Map<string, LedgerLine>();
  let seconds = 0;
  for (const l of lines) {
    const prev = newest.get(l.kernel);
    if (!prev || l.ts >= prev.ts) newest.set(l.kernel, l);
    const t = Date.parse(l.ts);
    if (l.event === 'output' && l.gpuSeconds !== null && Number.isFinite(t) && t <= nowMs && nowMs - t <= WEEK_MS) {
      seconds += l.gpuSeconds;
    }
  }
  const latest = [...newest.values()].map((l) => ({ kernel: l.kernel, version: l.version, status: l.status, ts: l.ts }));
  return { latest, weekHours: seconds / 3600 };
}
