// G20.4 comparison runner: runs one measurement suite for one local model with an optional think flag.
// Usage: node dev/scripts/g20-compare.ts <reviewSetSha256> <model> <suiteId> <repetitions> [think|nothink]
import { resolve } from 'node:path';
import { createBenchmarkApplication } from '../../src/composition/benchmark-cli.ts';

const [approved, model, suiteId, repetitionsText, thinkFlag] = process.argv.slice(2);
const repetitions = Number(repetitionsText);
if (!approved || !/^[0-9a-f]{64}$/.test(approved) || !model || !suiteId || !Number.isInteger(repetitions) || repetitions < 1
  || (thinkFlag !== undefined && thinkFlag !== 'think' && thinkFlag !== 'nothink')) {
  throw new Error('Usage: g20-compare.ts <reviewSetSha256> <model> <suiteId> <repetitions> [think|nothink]');
}
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const app = await createBenchmarkApplication({
  repositoryRoot, approvedReviewSetSha256: approved, modelTag: model,
  ...(thinkFlag === undefined ? {} : { adapterTuning: { think: thinkFlag === 'think' } }),
});
const summary = await app.benchmark.run({ suiteId, repetitions, approvedReviewSetSha256: approved });
const counts: Record<string, number> = {};
for (const a of summary.attempts) counts[a.status] = (counts[a.status] ?? 0) + 1;
console.log(JSON.stringify({ model, suiteId, runId: summary.runId, attempts: summary.attempts.length, counts }));
