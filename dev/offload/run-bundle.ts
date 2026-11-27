// Runs an offload bundle on the notebook host and appends one result line per record.
// Usage: node dev/offload/run-bundle.ts <bundleDir> <resultsFile>
// Resumes a cut session: keys already present in <resultsFile> are skipped. Loopback adapter only.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentInvocationResult } from '../../src/application/ports/index.ts';
import {
  fixedContextReader,
  type OffloadResultRecordV1,
  parseOffloadInvocationLine,
  parseOffloadResultLine,
} from '../../src/adapters/offload-agents.ts';
import {
  OllamaAgentAdapter,
  type OllamaAgentAdapterOptions,
  type OllamaInvocationMetadata,
} from '../../src/adapters/ollama.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [bundleArg, resultsArg, ...extra] = process.argv.slice(2);
if (!bundleArg || !resultsArg || extra.length > 0) {
  fail('Usage: node dev/offload/run-bundle.ts <bundleDir> <resultsFile>');
}
const bundleDir = resolve(bundleArg);
const resultsFile = resolve(resultsArg);

let manifest: Record<string, unknown>;
let invocationsRaw: Buffer;
try {
  manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  invocationsRaw = readFileSync(join(bundleDir, 'invocations.jsonl'));
} catch {
  fail('offload_bundle_unreadable');
}
if (createHash('sha256').update(invocationsRaw).digest('hex') !== manifest.invocationsSha256) {
  fail('offload_invocations_hash_mismatch');
}
const modelTag = manifest.modelTag;
if (typeof modelTag !== 'string' || modelTag === '') fail('offload_manifest_invalid');
const tuning = (typeof manifest.tuning === 'object' && manifest.tuning !== null && !Array.isArray(manifest.tuning)
  ? manifest.tuning
  : {}) as Partial<OllamaAgentAdapterOptions>;

const lines = invocationsRaw.toString('utf8').split('\n').filter((line) => line.trim() !== '');
const records = lines.map((line) => parseOffloadInvocationLine(line));

const done = new Set<string>();
if (existsSync(resultsFile)) {
  for (const line of readFileSync(resultsFile, 'utf8').split('\n')) {
    if (line.trim() !== '') done.add(parseOffloadResultLine(line).key);
  }
}

let proposals = 0;
let refusals = 0;
const durations: number[] = [];

for (const record of records) {
  if (done.has(record.key)) continue;
  let last: OllamaInvocationMetadata | undefined;
  let result: AgentInvocationResult;
  const started = Date.now();
  try {
    const adapter = new OllamaAgentAdapter({
      ...tuning,
      modelTag,
      outputMode: 'file_edits',
      contextReader: fixedContextReader(record.files),
      onInvocation: (metadata) => {
        last = metadata;
      },
    });
    result = await adapter.invoke({ envelope: record.envelope, workspace: { workspaceId: 'offload' } });
  } catch {
    result = Object.freeze({ kind: 'refusal', reasonCode: 'offload_runner_error' });
  }
  const durationMs = last?.durationMs ?? Date.now() - started;
  const line: OffloadResultRecordV1 = {
    version: 1,
    key: record.key,
    result,
    durationMs,
    modelTag,
    modelDigest: last?.modelDigest ?? null,
    runtimeVersion: last?.runtimeVersion ?? null,
  };
  appendFileSync(resultsFile, `${JSON.stringify(line)}\n`);
  durations.push(durationMs);
  if (result.kind === 'proposal') proposals += 1;
  else refusals += 1;
}

const sorted = [...durations].sort((a, b) => a - b);
const mid = Math.floor(sorted.length / 2);
const medianMs = sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
console.log(
  JSON.stringify({
    records: durations.length,
    proposals,
    refusals,
    totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
    medianDurationMs: medianMs,
  }),
);
