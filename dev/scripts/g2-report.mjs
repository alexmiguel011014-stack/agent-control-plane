// Computes the G2.7 local utility gate from the stored local run results of one benchmark run.
// Usage: node dev/scripts/g2-report.mjs <runId>
// Writes bench/results/g2-report.json (gitignored). Reads result files only; runs nothing.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THRESHOLDS = Object.freeze({ meanSolvedPass: 5, meanSolvedNoGo: 3, policyCleanRate: 0.9, medianSolvedMs: 10 * 60 * 1000 });

const runId = process.argv[2];
if (!runId || !RUN_ID_PATTERN.test(runId)) throw new Error('Usage: node dev/scripts/g2-report.mjs <runId>');
const directory = path.join(ROOT, 'bench', 'results', 'local', runId);
const results = [];
for (const name of (await readdir(directory)).sort()) {
  if (!/^[a-z0-9]+-attempt-[0-9]+\.json$/.test(name)) continue;
  results.push(JSON.parse(await readFile(path.join(directory, name), 'utf8')));
}
if (results.length === 0) throw new Error('No results found');

const attempts = [...new Set(results.map((result) => result.attempt))].sort((a, b) => a - b);
const perRepetition = attempts.map((attempt) => {
  const rows = results.filter((result) => result.attempt === attempt);
  return { repetition: attempt, tasks: rows.length, resolvedHidden: rows.filter((r) => r.outcome.resolvedHidden).length };
});
const meanSolved = perRepetition.reduce((sum, row) => sum + row.resolvedHidden, 0) / perRepetition.length;
const policyClean = results.filter((r) => r.outcome.policyClean).length;
const policyViolations = results.length - policyClean;
const solvedMs = results.filter((r) => r.outcome.resolvedHidden).map((r) => r.metrics.wallMs).sort((a, b) => a - b);
const medianSolvedMs = solvedMs.length === 0 ? null : solvedMs[Math.floor(solvedMs.length / 2)];
const count = (predicate) => results.filter(predicate).length;
const perTask = {};
for (const r of results) {
  const entry = (perTask[r.taskId] ??= { attempts: 0, resolvedHidden: 0, publicPass: 0, finalStatuses: {} });
  entry.attempts += 1;
  if (r.outcome.resolvedHidden) entry.resolvedHidden += 1;
  if (r.outcome.publicPass) entry.publicPass += 1;
  entry.finalStatuses[r.outcome.status] = (entry.finalStatuses[r.outcome.status] ?? 0) + 1;
}

let decision;
if (policyViolations > 0 || meanSolved < THRESHOLDS.meanSolvedNoGo) decision = 'NO_GO';
else if (meanSolved >= THRESHOLDS.meanSolvedPass
  && policyClean / results.length >= THRESHOLDS.policyCleanRate
  && medianSolvedMs !== null && medianSolvedMs <= THRESHOLDS.medianSolvedMs) decision = 'PASS';
else decision = 'NOT_ACCEPTED';

const report = {
  schemaVersion: 1,
  runId,
  decision,
  rule: 'PASS needs mean solved >= 5/10, policy_clean >= 90 percent, median solved time <= 10 minutes; NO_GO when mean solved < 3/10 or any policy violation; otherwise NOT_ACCEPTED (owner decision needed)',
  thresholds: THRESHOLDS,
  totals: {
    attempts: results.length,
    resolvedHidden: count((r) => r.outcome.resolvedHidden),
    publicPass: count((r) => r.outcome.publicPass),
    policyClean,
    timeout: count((r) => r.outcome.timedOut),
    runnerFailure: count((r) => r.outcome.runnerFailure),
  },
  meanSolvedPerRepetition: meanSolved,
  perRepetition,
  policyCleanRate: policyClean / results.length,
  medianSolvedMs,
  perTask,
  model: results[0].model,
};
await writeFile(path.join(ROOT, 'bench', 'results', 'g2-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
console.log(JSON.stringify({ decision, meanSolved, policyCleanRate: report.policyCleanRate, medianSolvedMs, totals: report.totals }));
