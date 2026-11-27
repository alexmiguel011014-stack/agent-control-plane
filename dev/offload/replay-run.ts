// Replays offloaded model results through the normal benchmark pipeline, with no model call.
// Usage: node dev/offload/replay-run.ts <reviewSetSha256> <bundleDir> <resultsFile>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentInvocationPort, AgentInvocationResult } from '../../src/application/ports/index.ts';
import { OffloadError, ReplayAgentAdapter, parseOffloadResultLine } from '../../src/adapters/offload-agents.ts';
import { createBenchmarkApplication } from '../../src/composition/benchmark-cli.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [approved, bundleDir, resultsFile] = process.argv.slice(2);
if (!approved || !/^[0-9a-f]{64}$/.test(approved) || !bundleDir || !resultsFile) {
  fail('Usage: replay-run.ts <reviewSetSha256> <bundleDir> <resultsFile>');
}

let manifest: { suiteId: string; taskIds: string[] | null; modelTag: string; reviewSetSha256: string };
try {
  manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
  // taskIds is null when the capture covered the whole suite.
  if (typeof manifest.suiteId !== 'string' || (manifest.taskIds !== null && !Array.isArray(manifest.taskIds)) || typeof manifest.modelTag !== 'string') {
    throw new Error('manifest_invalid');
  }
} catch {
  fail('replay-run: manifest.json is unreadable or invalid');
}
if (manifest.reviewSetSha256 !== approved) fail('replay-run: manifest reviewSetSha256 does not match the argument');

let resultsBytes: Buffer;
let results;
try {
  resultsBytes = readFileSync(resultsFile);
  results = resultsBytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').map(parseOffloadResultLine);
} catch (error) {
  fail(error instanceof OffloadError ? `replay-run: ${error.message}` : 'replay-run: results file is unreadable');
}

const runId = `offload-replay-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
let replay: ReplayAgentAdapter;
try {
  replay = new ReplayAgentAdapter({ runId, results });
} catch (error) {
  fail(error instanceof OffloadError ? `replay-run: ${error.message}` : 'replay-run: replay setup failed');
}
let missing = 0;
const counting: AgentInvocationPort = {
  async invoke(input): Promise<AgentInvocationResult> {
    const result = await replay.invoke(input);
    if (result.kind === 'refusal' && result.reasonCode === 'offload_missing') missing += 1;
    return result;
  },
};

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const app = await createBenchmarkApplication({
  repositoryRoot,
  approvedReviewSetSha256: approved,
  modelTag: manifest.modelTag,
  agentOverride: counting,
});
const summary = await app.benchmark.run({
  suiteId: manifest.suiteId,
  ...(manifest.taskIds === null ? {} : { taskIds: manifest.taskIds }),
  repetitions: 1,
  approvedReviewSetSha256: approved,
  runId,
});
console.log(JSON.stringify({
  runId: summary.runId,
  // The run summary lists attempts; count them by status.
  statusCounts: summary.attempts.reduce<Record<string, number>>((counts, attempt) => {
    counts[attempt.status] = (counts[attempt.status] ?? 0) + 1;
    return counts;
  }, {}),
  offloadMissing: missing,
  resultsSha256: createHash('sha256').update(resultsBytes).digest('hex'),
}));
