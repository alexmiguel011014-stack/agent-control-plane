import { encodePair } from './pair.mjs';

export function buildQuery(params) {
  const parts = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) parts.push(encodePair(key, item));
  }
  return parts.join('&');
}
