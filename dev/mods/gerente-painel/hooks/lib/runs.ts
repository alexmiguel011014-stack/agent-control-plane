export type RunRow = {
  shortId: string;
  suiteId: string;
  modelTag: string;
  attempts: number;
  pass: number;
  fail: number;
  other: number;
  startedAtUtc: string;
};

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function summarizeRuns(attempts: unknown[], limit: number): RunRow[] {
  const byRun = new Map<string, RunRow>();
  for (const raw of attempts) {
    const a = obj(raw);
    if (!a) continue;
    const runId = str(a.runId);
    const suiteId = str(a.suiteId);
    const startedAtUtc = str(a.startedAtUtc);
    const modelTag = str(obj(a.model)?.tag);
    const status = str(obj(a.outcome)?.status);
    if (runId === null || suiteId === null || startedAtUtc === null || modelTag === null || status === null) continue;
    let row = byRun.get(runId);
    if (!row) {
      row = { shortId: runId.slice(-8), suiteId, modelTag, attempts: 0, pass: 0, fail: 0, other: 0, startedAtUtc };
      byRun.set(runId, row);
    }
    row.attempts++;
    if (status === 'PASS') row.pass++;
    else if (status === 'FAIL') row.fail++;
    else row.other++;
    if (startedAtUtc < row.startedAtUtc) row.startedAtUtc = startedAtUtc;
  }
  return [...byRun.values()]
    .sort((x, y) => (x.startedAtUtc < y.startedAtUtc ? 1 : x.startedAtUtc > y.startedAtUtc ? -1 : 0))
    .slice(0, Math.max(0, limit));
}
