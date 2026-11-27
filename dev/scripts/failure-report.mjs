// Groups the stored attempts of one local benchmark run by task and evaluator outcome.
// Usage: node dev/scripts/failure-report.mjs <runId>
// Reads result files only; writes bench/results/g20-failures.md (gitignored). Runs nothing.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runId = process.argv[2];
if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[a-z0-9][a-z0-9_-]{0,63}$/.test(runId)) {
  throw new Error('Usage: node dev/scripts/failure-report.mjs <runId>');
}
const directory = path.join(ROOT, 'bench', 'results', 'local', runId);
const rows = [];
for (const name of (await readdir(directory)).sort()) {
  if (/^[a-z0-9]+-attempt-[0-9]+\.json$/.test(name)) rows.push(JSON.parse(await readFile(path.join(directory, name), 'utf8')));
}
if (rows.length === 0) throw new Error('No results found');

const byTask = new Map();
for (const r of rows) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);

const lines = [
  `# Failure classification for run ${runId}`, '',
  `Model: ${rows[0].model.tag}. Source: stored result files only (no patch text, no evaluator logs are kept).`, '',
  '| Task | Attempts | Statuses | Distinct patches | Lines +/- (attempt 1) | Median wall ms | Public test log stored |',
  '|---|---|---|---|---|---|---|',
];
for (const [taskId, list] of byTask) {
  const statuses = {};
  for (const r of list) statuses[r.outcome.status] = (statuses[r.outcome.status] ?? 0) + 1;
  const patches = new Set(list.map((r) => r.patch?.sha256 ?? 'none'));
  const wall = list.map((r) => r.metrics.wallMs).sort((a, b) => a - b);
  const first = list[0].patch;
  lines.push(`| ${taskId} | ${list.length} | ${Object.entries(statuses).map(([k, v]) => `${k} ${v}`).join(', ')} | ${patches.size} | ${first ? `+${first.linesAdded}/-${first.linesRemoved}` : 'n/a'} | ${Math.round(wall[Math.floor(wall.length / 2)])} | ${list.some((r) => r.logSha256) ? 'yes' : 'no'} |`);
}
const crashed = [...byTask].filter(([, list]) => list.some((r) => r.outcome.status === 'CRASH')).map(([id]) => id);
lines.push('', '## What the stored evidence can and cannot say', '',
  '- `CRASH` means the isolated worker exited without a verified result (evaluator `worker_exit_unverified`). That covers a syntax error, an import error, or an exception before the tests report; the stored data does not tell them apart.',
  `- Tasks with a CRASH: ${crashed.length ? crashed.join(', ') : 'none'}. The syntax versus runtime question is therefore **undetermined from stored evidence**: no log hash is stored and the patch text is not kept.`,
  '- Identical patch hashes across repetitions mean the model is deterministic at temperature 0, so repeating the same prompt adds no information.', '');
await mkdir(path.join(ROOT, 'bench', 'results'), { recursive: true });
await writeFile(path.join(ROOT, 'bench', 'results', 'g20-failures.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
