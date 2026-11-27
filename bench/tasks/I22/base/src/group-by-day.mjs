import { dayKey } from './day.mjs';

export function groupByDay(events) {
  const totals = new Map();
  for (const event of events) {
    const key = dayKey(event.at);
    totals.set(key, (totals.get(key) ?? 0) + event.value);
  }
  return [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, total]) => ({ day, total }));
}
