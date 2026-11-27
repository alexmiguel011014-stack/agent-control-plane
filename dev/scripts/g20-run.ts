// Runs one benchmark suite with adapter options the CLI does not expose (for example `think: false` for
// thinking models). It uses the same application services and result files as `agentctl benchmark run`.
// Usage: node dev/scripts/g20-run.ts <reviewSetSha256> <model> <suiteId> <json|blocks> <think:on|off|default> [repetitions]
// Optional env G20_TASK_IDS: comma separated task IDs (for example I01,I03) to run a subset of the suite.
// Optional env G20_TUNING_FILE: path to a JSON file with extra adapter tuning (numCtx, numPredict, timeoutMs, temperature, systemPromptAddendum).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBenchmarkApplication } from '../../src/composition/benchmark-cli.ts';

const [approved, model, suiteId, format, think, repsArg] = process.argv.slice(2);
const repetitions = repsArg === undefined ? 1 : Number(repsArg);
if (!approved || !/^[0-9a-f]{64}$/.test(approved) || !model || !suiteId || (format !== 'json' && format !== 'blocks')
  || (think !== 'on' && think !== 'off' && think !== 'default') || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  throw new Error('Usage: g20-run.ts <reviewSetSha256> <model> <suiteId> <json|blocks> <think:on|off|default> [repetitions]');
}
// Optional env G20_TRACE_DIR: appends every chat request and answer to trace-<counter>.json there (diagnostics only).
const traceDir = process.env.G20_TRACE_DIR;
if (traceDir) mkdirSync(traceDir, { recursive: true });
let traceCounter = 0;
const tracingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init);
  if (traceDir && String(input).endsWith('/api/chat') && typeof init?.body === 'string') {
    const copy = response.clone();
    const answer = await copy.json() as { message?: { content?: string } };
    const request = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    traceCounter += 1;
    appendFileSync(`${traceDir}/chat-${String(traceCounter).padStart(4, '0')}.json`, JSON.stringify({ user: request.messages[1]?.content, answer: answer.message?.content }));
  }
  return response;
};
const extraTuning = process.env.G20_TUNING_FILE ? JSON.parse(readFileSync(process.env.G20_TUNING_FILE, 'utf8')) as Record<string, unknown> : {};
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const app = await createBenchmarkApplication({
  repositoryRoot,
  approvedReviewSetSha256: approved,
  modelTag: model,
  adapterTuning: { ...(traceDir ? { fetcher: tracingFetch } : {}), ...extraTuning, answerFormat: format, ...(think === 'default' ? {} : { think: think === 'on' }) },
});
const taskIds = process.env.G20_TASK_IDS ? process.env.G20_TASK_IDS.split(',').map((id) => id.trim().toUpperCase()).filter((id) => id !== '') : undefined;
const summary = await app.benchmark.run({ suiteId, repetitions, approvedReviewSetSha256: approved, ...(taskIds ? { taskIds } : {}) });
console.log(JSON.stringify({ runId: summary.runId, suiteId, model, format, think, statusCounts: summary.statusCounts }));
