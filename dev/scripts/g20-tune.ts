// G20.3 tuning harness: runs the tuning suite (S01-S04 only) for named prompt/context variants.
// Usage: node dev/scripts/g20-tune.ts <reviewSetSha256> <model> <variant>...
// Variants: v0 (current protocol), v1 (larger output budget), v2 (worked example), v3 (v1 + v2).
// Refuses any suite other than the tuning suite; results go to bench/results/local like any run.
import { resolve } from 'node:path';
import { createBenchmarkApplication } from '../../src/composition/benchmark-cli.ts';

const TUNING_SUITE = 'g20-tuning-policy';
const WORKED_EXAMPLE = [
  'Worked example (unrelated to your task). Task: "Fix add so it returns the sum of its arguments."',
  'FILE src/math.mjs contained: export function add(a, b) { return a - b; }',
  'Correct answer: {"proposalId":"example","edits":[{"path":"src/math.mjs","content":"export function add(a, b) {\\n  return a + b;\\n}\\n"}]}',
  'Always return the complete file, keep unrelated code exactly as it is, and make the smallest change that satisfies every rule in the task, including the edge cases it names.',
].join('\n');

const VARIANTS: Readonly<Record<string, Readonly<{ numCtx?: number; numPredict?: number; systemPromptAddendum?: string }>>> = Object.freeze({
  v0: {},
  v1: { numCtx: 8192, numPredict: 2048 },
  v2: { systemPromptAddendum: WORKED_EXAMPLE },
  v3: { numCtx: 8192, numPredict: 2048, systemPromptAddendum: WORKED_EXAMPLE },
});

const [approved, model, ...names] = process.argv.slice(2);
if (!approved || !/^[0-9a-f]{64}$/.test(approved) || !model || names.length === 0 || !names.every((n) => Object.hasOwn(VARIANTS, n))) {
  throw new Error('Usage: g20-tune.ts <reviewSetSha256> <model> <v0|v1|v2|v3>...');
}
const repositoryRoot = resolve(import.meta.dirname, '..', '..');

for (const name of names) {
  const app = await createBenchmarkApplication({
    repositoryRoot, approvedReviewSetSha256: approved, modelTag: model, adapterTuning: VARIANTS[name]!,
  });
  const summary = await app.benchmark.run({ suiteId: TUNING_SUITE, repetitions: 1, approvedReviewSetSha256: approved });
  const rows = [...summary.attempts].sort((a, b) => a.benchmarkTaskId.localeCompare(b.benchmarkTaskId))
    .map((a) => `${a.benchmarkTaskId}=${a.status}`);
  const solved = summary.attempts.filter((a) => a.status === 'PASS').length;
  console.log(JSON.stringify({ variant: name, runId: summary.runId, solved, of: summary.attempts.length, rows }));
}
