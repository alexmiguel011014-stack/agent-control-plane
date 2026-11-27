import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentInvocationPort, AgentInvocationResult } from '../application/ports/index.ts';
import type { BenchmarkApplicationServices } from '../application/benchmark-services.ts';
import { createBenchmarkApplication } from './benchmark-cli.ts';
import type { BenchmarkApplicationOptions } from './benchmark-cli.ts';

/**
 * Pipeline smoke: replays a reference patch (attempt 1) and a negative control (attempt 2) through
 * the real benchmark composition via its `agentOverride`. The scripted agent lives only in this
 * file; it is not imported by agentctl or src/bin.
 */

const SUITE_ID = 'g2-local-pure-localized';
const TASK_ID_PATTERN = /^[A-Z][0-9]{2}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const NEGATIVE_CONTROL_COMMENT = '// smoke-negative-control';

export interface SmokeAttemptResult {
  readonly attempt: number;
  readonly category: string;
  readonly reasonCode: string;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly attempts: readonly SmokeAttemptResult[];
}

export interface SmokeOptions {
  readonly repositoryRoot: string;
  readonly approvedReviewSetSha256: string;
  readonly taskId: string;
}

/** Test seam: replaces the real composition so unit tests never run the evaluator, probe, or launcher. */
export interface SmokeSeams {
  readonly createApplication?: (
    options: BenchmarkApplicationOptions,
  ) => Promise<{ readonly benchmark: Pick<BenchmarkApplicationServices, 'run'> }>;
}

export class SmokeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'SmokeError';
    this.code = code;
  }
}

/** Strict flag parsing: both flags known, values required, no duplicates, no extras. */
export function parseSmokeArgs(argv: readonly string[]): { approvedReviewSetSha256: string; taskId: string } {
  let hash: string | undefined;
  let taskId: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new SmokeError('missing_flag_value');
    if (flag === '--approve-review-set-sha256') {
      if (hash !== undefined) throw new SmokeError('duplicate_flag');
      hash = value;
    } else if (flag === '--task-id') {
      if (taskId !== undefined) throw new SmokeError('duplicate_flag');
      taskId = value;
    } else {
      throw new SmokeError('unknown_flag');
    }
  }
  if (hash === undefined) throw new SmokeError('missing_hash');
  if (!HASH_PATTERN.test(hash)) throw new SmokeError('invalid_hash');
  const resolvedTask = taskId ?? 'B01';
  if (!TASK_ID_PATTERN.test(resolvedTask)) throw new SmokeError('invalid_task_id');
  return { approvedReviewSetSha256: hash, taskId: resolvedTask };
}

/** Exit 0 only when attempt 1 is resolved and attempt 2 is not. */
export function decideSmokeOk(resolved: readonly boolean[]): boolean {
  return resolved.length === 2 && resolved[0] === true && resolved[1] === false;
}

function targetPathOf(patch: string): string | null {
  const match = /^\+\+\+ b\/(.+)$/m.exec(patch);
  const path = match?.[1] ?? null;
  if (path === null || path.includes('..') || path.startsWith('/') || path.includes('\\')) return null;
  return path;
}

/**
 * Builds attempt 2's diff from public task data only. Method (documented choice): in the reference
 * patch, the first removed line is followed by its added replacement; the added line is reverted to
 * the removed line's content, so the diff still applies but is a no-op rewrite that cannot fix the
 * task. If the patch has no removed/added pair, append `// smoke-negative-control` to the first
 * target file instead, using the read-only base file text.
 */
export function buildNegativeControlDiff(referencePatch: string, baseFileText?: string): string {
  const lines = referencePatch.split('\n');
  const start = lines.findIndex((line) => line.startsWith('@@'));
  if (start >= 0) {
    for (let index = start; index < lines.length - 1; index += 1) {
      const removed = lines[index] ?? '';
      const added = lines[index + 1] ?? '';
      if (removed.startsWith('-') && !removed.startsWith('---') && added.startsWith('+') && !added.startsWith('+++')) {
        const candidate = [...lines];
        candidate[index + 1] = `+${removed.slice(1)}`;
        const text = candidate.join('\n');
        if (text !== referencePatch) return text;
        break;
      }
    }
  }
  const path = targetPathOf(referencePatch);
  if (baseFileText === undefined || path === null || !baseFileText.endsWith('\n') || baseFileText.includes('\r')) {
    throw new SmokeError('negative_control_unavailable');
  }
  const baseLines = baseFileText.slice(0, -1).split('\n');
  const context = baseLines.slice(-3);
  const oldStart = baseLines.length - context.length + 1;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${context.length} +${oldStart},${context.length + 1} @@`,
    ...context.map((line) => ` ${line}`),
    `+${NEGATIVE_CONTROL_COMMENT}`,
    '',
  ].join('\n');
}

function createScriptedAgent(diffs: readonly [string, string]): AgentInvocationPort {
  let calls = 0;
  return {
    invoke: async (): Promise<AgentInvocationResult> => {
      const index = Math.min(calls, 1);
      calls += 1;
      return {
        kind: 'proposal',
        proposal: {
          proposalId: `smoke-${calls}`,
          toolRequests: [{ operation: 'apply_unified_diff', diff: diffs[index] }],
        },
      };
    },
  };
}

export async function runPipelineSmoke(options: SmokeOptions, seams: SmokeSeams = {}): Promise<SmokeResult> {
  if (!TASK_ID_PATTERN.test(options.taskId)) throw new SmokeError('invalid_task_id');
  const taskDir = join(options.repositoryRoot, 'bench', 'tasks', options.taskId);
  const referencePatch = await readFile(join(taskDir, 'reference.patch'), 'utf8');
  const path = targetPathOf(referencePatch);
  const baseText = path === null
    ? undefined
    : await readFile(join(taskDir, 'base', ...path.split('/')), 'utf8').catch(() => undefined);
  const negative = buildNegativeControlDiff(referencePatch, baseText);
  if (negative.length === 0 || negative === referencePatch) throw new SmokeError('negative_control_unavailable');

  const create = seams.createApplication ?? createBenchmarkApplication;
  const application = await create({
    repositoryRoot: options.repositoryRoot,
    approvedReviewSetSha256: options.approvedReviewSetSha256,
    agentOverride: createScriptedAgent([referencePatch, negative]),
  });
  const summary = await application.benchmark.run({
    suiteId: SUITE_ID,
    taskId: options.taskId,
    repetitions: 2,
    approvedReviewSetSha256: options.approvedReviewSetSha256,
  });
  const ordered = [...summary.attempts].sort((a, b) => a.attempt - b.attempt);
  // The run summary carries the final outcome status: PASS means public and hidden oracle passed.
  const attempts = ordered.map((entry): SmokeAttemptResult => ({
    attempt: entry.attempt,
    category: entry.status === 'PASS' ? 'resolved_hidden' : 'not_resolved',
    reasonCode: entry.status.toLowerCase(),
  }));
  const ok = decideSmokeOk(attempts.map((entry) => entry.category === 'resolved_hidden'));
  return { ok, attempts };
}

function findRepositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, 'package.json')) && existsSync(join(current, 'bench', 'tasks'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new SmokeError('repository_root_not_found');
    current = parent;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const parsed = parseSmokeArgs(argv);
    const result = await runPipelineSmoke({ repositoryRoot: resolve(findRepositoryRoot()), ...parsed });
    for (const attempt of result.attempts) process.stdout.write(`${JSON.stringify(attempt)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    const code = error instanceof SmokeError ? error.code : 'smoke_failed';
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
