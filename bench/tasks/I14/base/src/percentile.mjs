import { sortedCopy } from './sorting.mjs';

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = sortedCopy(values);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}
