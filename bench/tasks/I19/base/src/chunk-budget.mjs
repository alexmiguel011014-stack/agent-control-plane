import { sizeOf } from './size.mjs';

export function chunkByBudget(items, budget) {
  const chunks = [];
  let current = [];
  let used = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && used + size >= budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
