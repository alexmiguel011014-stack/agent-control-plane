import { formatRun } from './format-range.mjs';

export function compressRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    parts.push(formatRun(sorted[start], sorted[end]));
    start = end + 1;
  }
  return parts.join(',');
}
