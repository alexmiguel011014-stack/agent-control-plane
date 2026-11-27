import { cleanToken } from './text-utils.mjs';

export function normalizeTags(input) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(input).split(',')) {
    const tag = cleanToken(raw);
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length === 5) break;
  }
  return tags;
}
