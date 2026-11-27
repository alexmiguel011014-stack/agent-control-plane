import { clampInt } from './clamp.mjs';

export function pageWindow(current, total, radius) {
  const page = clampInt(current, 1, total);
  const first = clampInt(page - radius, 1, total);
  const last = clampInt(page + radius, 1, total);
  const pages = [];
  for (let n = first; n <= last; n += 1) pages.push(n);
  return pages;
}
