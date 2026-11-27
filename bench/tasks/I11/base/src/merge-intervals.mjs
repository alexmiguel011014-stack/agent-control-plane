import { overlaps } from './interval.mjs';

export function mergeIntervals(intervals) {
  const sorted = intervals.map((item) => ({ start: item.start, end: item.end })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && overlaps(last, item)) last.end = Math.max(last.end, item.end);
    else merged.push(item);
  }
  return merged;
}
