import { doubled } from './power.mjs';

export function nextDelay(attempt, baseMs, capMs) {
  if (!Number.isInteger(attempt) || attempt < 1) return 0;
  return Math.min(capMs, baseMs * doubled(attempt));
}
