import { compareEntries } from './compare.mjs';

export function rankScores(entries) {
  const sorted = entries.map((entry) => ({ name: entry.name, score: entry.score })).sort(compareEntries);
  let rank = 0;
  return sorted.map((entry, index) => {
    if (index === 0 || entry.score !== sorted[index - 1].score) rank = index + 1;
    return { name: entry.name, score: entry.score, rank };
  });
}
