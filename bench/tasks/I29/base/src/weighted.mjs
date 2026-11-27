import { round2 } from './round.mjs';

export function weightedAverage(items) {
  let total = 0;
  let weights = 0;
  for (const item of items) {
    if (!(item.weight > 0) || !Number.isFinite(item.score)) continue;
    total += item.score * item.weight;
    weights += item.weight;
  }
  return weights === 0 ? null : round2(total / weights);
}
