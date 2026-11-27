import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalCliApplication } from '../composition/local-cli.ts';
import { parseCliArgs, runCli, type CliApplication } from '../interfaces/cli/agentctl.ts';

/**
 * Hash passed to the benchmark composition for `benchmark list` and `benchmark report`.
 * Read-only commands never evaluate: they only read the catalog and stored results, so this
 * value never reaches the evaluator, which is the only consumer of the approval hash.
 */
const READ_ONLY_REVIEW_SET_SENTINEL = '0'.repeat(64);

/** Repository root from this file: src/bin (source run) or dist/src/bin (compiled run). */
function repositoryRoot(): string {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return basename(parent) === 'dist' ? dirname(parent) : parent;
}

const argv = process.argv.slice(2);
const parsed = parseCliArgs(argv);

if (parsed.ok && parsed.command.kind === 'watch') {
  const command = parsed.command;
  const { createObservabilityComposition } = await import('../composition/observe-cli.ts');
  const { renderSnapshot } = await import('../interfaces/terminal/render-snapshot.ts');
  const { runWatch } = await import('../interfaces/terminal/watch.ts');
  const service = createObservabilityComposition({ repositoryRoot: repositoryRoot() });
  if (command.format === 'json') {
    const snapshot = await service.getSnapshot();
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    process.exitCode = 0;
  } else {
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    const isTty = process.stdout.isTTY === true;
    const color = command.color && process.env.NO_COLOR === undefined && isTty;
    await runWatch({
      getSnapshot: () => service.getSnapshot(),
      render: (snapshot) => renderSnapshot(snapshot, { width: Math.max(60, process.stdout.columns ?? 80), color }),
      write: (text) => { process.stdout.write(text); },
      intervalMs: command.intervalSeconds * 1000,
      once: command.once,
      interactive: isTty && !command.once,
      signal: controller.signal,
    });
    process.exitCode = 0;
  }
}

async function createApplication(): Promise<CliApplication> {
  if (parsed.ok) {
    const command = parsed.command;
    if (command.kind === 'benchmark.run' || command.kind === 'benchmark.report' || command.kind === 'benchmark.list'
      || command.kind === 'comparison.export' || command.kind === 'comparison.import') {
      const { createBenchmarkApplication } = await import('../composition/benchmark-cli.ts');
      return createBenchmarkApplication({
        repositoryRoot: repositoryRoot(),
        approvedReviewSetSha256: command.kind === 'benchmark.run' ? command.approvedReviewSetSha256 : READ_ONLY_REVIEW_SET_SENTINEL,
        // list and report: no upfront approval check, no restart recovery, no evaluator, no run.
        readOnly: command.kind !== 'benchmark.run',
        ...(command.kind === 'benchmark.run' && command.model !== undefined ? { modelTag: command.model } : {}),
        ...(command.kind === 'benchmark.run' && command.answerFormat === 'blocks' ? { adapterTuning: { answerFormat: 'blocks' as const } } : {}),
      });
    }
  }
  return createLocalCliApplication();
}

if (!(parsed.ok && parsed.command.kind === 'watch')) {
  const result = await runCli(argv, createApplication);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
