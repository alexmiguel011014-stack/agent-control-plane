// G20.1 diagnostic: runs one attempt each of the given tasks with the real model and keeps the
// proposed diff text in a scratch folder OUTSIDE the repository, then checks it statically
// (`git apply` + `node --check`, which parse but never execute the code).
// Usage: node dev/scripts/g20-diagnose.ts <outDir> <reviewSetSha256> <model> <TASK>...
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBenchmarkApplication } from '../../src/composition/benchmark-cli.ts';

const [outArg, approved, model, ...tasks] = process.argv.slice(2);
if (!outArg || !approved || !/^[0-9a-f]{64}$/.test(approved) || !model || tasks.length === 0 || !tasks.every((t) => /^[A-Z][0-9]{2}$/.test(t))) {
  throw new Error('Usage: g20-diagnose.ts <outDir> <reviewSetSha256> <model> <TASK>...');
}
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const outDir = resolve(outArg);
if (outDir.startsWith(repositoryRoot)) throw new Error('outDir must be outside the repository');
mkdirSync(outDir, { recursive: true });

for (const task of tasks) {
  const diffs: string[] = [];
  const app = await createBenchmarkApplication({
    repositoryRoot, approvedReviewSetSha256: approved, modelTag: model,
    proposalSink: (result) => {
      if (result.kind === 'proposal') {
        for (const request of result.proposal.toolRequests) if (request.operation === 'apply_unified_diff') diffs.push(request.diff);
      } else diffs.push(`REFUSAL ${result.reasonCode}`);
    },
  });
  const summary = await app.benchmark.run({ suiteId: 'g3-local-small-integrations', taskId: task, repetitions: 1, approvedReviewSetSha256: approved });
  const status = summary.attempts.map((a) => a.status).join(',');
  const diff = diffs[0] ?? '(no proposal)';
  writeFileSync(join(outDir, `${task}.diff`), diff);
  // Static check in a scratch copy of the public base tree; nothing is executed.
  const work = join(outDir, `${task}-work`);
  cpSync(join(repositoryRoot, 'bench', 'tasks', task, 'base'), work, { recursive: true });
  let applied = 'not_applied';
  let syntax = 'n/a';
  try {
    execFileSync('git', ['apply', '--whitespace=nowarn', join(outDir, `${task}.diff`)], { cwd: work, stdio: 'pipe' });
    applied = 'applied';
    const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!);
    syntax = 'ok';
    for (const file of files) {
      try { execFileSync(process.execPath, ['--check', join(work, file)], { stdio: 'pipe' }); } catch (error) {
        syntax = `SYNTAX_ERROR in ${file}: ${String((error as { stderr?: Buffer }).stderr ?? '').split('\n').slice(0, 5).join(' | ')}`;
      }
    }
  } catch (error) {
    applied = `git apply failed: ${String((error as { stderr?: Buffer }).stderr ?? '').slice(0, 200)}`;
  }
  console.log(JSON.stringify({ task, status, applied, syntax, diffFile: join(outDir, `${task}.diff`) }));
}
