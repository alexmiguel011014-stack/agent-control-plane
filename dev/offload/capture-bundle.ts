// Captures the benchmark invocations (envelopes and context files) into an offload bundle without any model call.
// Usage: node dev/offload/capture-bundle.ts <reviewSetSha256> <model> <suiteId> <bundleDir>
// Optional env G20_TASK_IDS: comma separated task IDs (for example I01,I03) to run a subset of the suite.
// Optional env G20_TUNING_FILE: path to a JSON file with extra adapter tuning, recorded in the manifest.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { CaptureAgentAdapter, OFFLOAD_BUNDLE_VERSION } from '../../src/adapters/offload-agents.ts';
import { createBenchmarkApplication } from '../../src/composition/benchmark-cli.ts';

const SECRET_PATH = /(^|\/)\.env|credential|secret|\.pem$|\.key$/i;
// Optional env OFFLOAD_ALLOW_PATHS: comma separated exact paths that match SECRET_PATH but are synthetic fixtures
// (for example src/secret-key.mjs of task I27, a regex helper with no secret). Each one is recorded in the manifest.
const allowedPaths = new Set((process.env.OFFLOAD_ALLOW_PATHS ?? '').split(',').map((path) => path.trim()).filter((path) => path !== ''));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [approved, model, suiteId, bundleArg] = process.argv.slice(2);
if (!approved || !/^[0-9a-f]{64}$/.test(approved) || !model || !suiteId || !bundleArg) {
  fail('Usage: capture-bundle.ts <reviewSetSha256> <model> <suiteId> <bundleDir>');
}
const bundleDir = resolve(bundleArg);
if (existsSync(bundleDir)) fail(`Refusing to overwrite existing bundle directory: ${bundleDir}`);

const extraTuning = process.env.G20_TUNING_FILE ? JSON.parse(readFileSync(process.env.G20_TUNING_FILE, 'utf8')) as Record<string, unknown> : {};
const taskIds = process.env.G20_TASK_IDS ? process.env.G20_TASK_IDS.split(',').map((id) => id.trim().toUpperCase()).filter((id) => id !== '') : undefined;
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const createdAt = new Date();
const captureRunId = `offload-capture-${createdAt.toISOString().replace(/\.\d+Z$/, '').replace(/[-:T]/g, '')}`;

let adapter: CaptureAgentAdapter | undefined;
const app = await createBenchmarkApplication({
  repositoryRoot,
  approvedReviewSetSha256: approved,
  modelTag: model,
  agentFactory: ({ contextReader }) => {
    adapter = new CaptureAgentAdapter({ runId: captureRunId, contextReader });
    return adapter;
  },
});
// Every attempt ends in an `offload_captured` refusal; that is expected.
await app.benchmark.run({ suiteId, repetitions: 1, approvedReviewSetSha256: approved, runId: captureRunId, ...(taskIds ? { taskIds } : {}) });
if (adapter === undefined) fail('Capture adapter was never created.');
const records = adapter.records();

const unsafe = records.flatMap((record) => record.files.map((file) => file.path)).filter((path) => SECRET_PATH.test(path) && !allowedPaths.has(path));
if (unsafe.length > 0) fail(`Refusing to write bundle: captured paths look like secrets: ${[...new Set(unsafe)].join(', ')}`);

mkdirSync(bundleDir, { recursive: true });
const invocations = records.map((record) => `${JSON.stringify(record)}\n`).join('');
const invocationsSha256 = createHash('sha256').update(invocations, 'utf8').digest('hex');
writeFileSync(join(bundleDir, 'invocations.jsonl'), invocations, 'utf8');
writeFileSync(join(bundleDir, 'manifest.json'), `${JSON.stringify({
  version: OFFLOAD_BUNDLE_VERSION,
  bundleId: basename(bundleDir),
  captureRunId,
  suiteId,
  taskIds: taskIds ?? null,
  modelTag: model,
  tuning: { answerFormat: 'blocks', think: false, ...extraTuning },
  reviewSetSha256: approved,
  invocationsSha256,
  allowedSecretLikePaths: [...allowedPaths],
  createdAtUtc: createdAt.toISOString(),
}, null, 2)}\n`, 'utf8');

const codeDir = join(bundleDir, 'code');
const srcDir = join(repositoryRoot, 'src');
cpSync(srcDir, join(codeDir, 'src'), {
  recursive: true,
  filter: (source) => statSync(source).isDirectory() || !/\.test\.(ts|mjs)$/.test(relative(srcDir, source)),
});
cpSync(join(repositoryRoot, 'package.json'), join(codeDir, 'package.json'));
mkdirSync(join(codeDir, 'dev', 'offload'), { recursive: true });
cpSync(join(repositoryRoot, 'dev', 'offload', 'run-bundle.ts'), join(codeDir, 'dev', 'offload', 'run-bundle.ts'));

console.log(`invocations.jsonl sha256 ${invocationsSha256} (${records.length} records)`);
console.log(`bundle ${bundleDir} (${readdirSync(bundleDir).join(', ')})`);
