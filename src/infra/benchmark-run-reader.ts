import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BenchmarkEvaluationStatus,
  BenchmarkRunReaderPort,
  ObservedRunSummary,
} from '../application/ports/index.ts';
import { LOCAL_RUN_RESULT_ID_PATTERN, validateLocalRunResult } from './benchmark-result.ts';

const ATTEMPT_FILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}-attempt-[1-9][0-9]{0,3}\.json$/;

function emptyCounts(): Record<BenchmarkEvaluationStatus, number> {
  return { PASS: 0, FAIL: 0, POLICY_VIOLATION: 0, TIMEOUT: 0, CRASH: 0, RUNNER_FAILURE: 0 };
}

/** Read-only summary of valid local run result files; invalid files are skipped. */
export class FileBenchmarkRunReader implements BenchmarkRunReaderPort {
  readonly #resultsDir: string;

  constructor(resultsDir: string) {
    this.#resultsDir = resultsDir;
  }

  async listRuns(limit: number): Promise<readonly ObservedRunSummary[]> {
    if (!existsSync(this.#resultsDir)) return [];
    const entries = await readdir(this.#resultsDir, { withFileTypes: true });
    const runs: ObservedRunSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !LOCAL_RUN_RESULT_ID_PATTERN.test(entry.name)) continue;
      const summary = await this.#summarize(entry.name);
      if (summary !== null) runs.push(summary);
    }
    runs.sort((a, b) => (a.startedAtUtc < b.startedAtUtc ? 1 : a.startedAtUtc > b.startedAtUtc ? -1 : 0));
    return runs.slice(0, Math.max(0, limit));
  }

  async #summarize(runId: string): Promise<ObservedRunSummary | null> {
    const dir = join(this.#resultsDir, runId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    const counts = emptyCounts();
    let attempts = 0;
    let suiteId = '';
    let modelTag = '';
    let startedAtUtc = '';
    for (const name of names.sort()) {
      if (!ATTEMPT_FILE_PATTERN.test(name)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      const validation = validateLocalRunResult(parsed);
      if (!validation.valid) continue;
      const result = validation.result;
      attempts += 1;
      counts[result.outcome.status] += 1;
      if (startedAtUtc === '' || result.startedAtUtc < startedAtUtc) {
        startedAtUtc = result.startedAtUtc;
        suiteId = result.suiteId;
        modelTag = result.model.tag;
      }
    }
    if (attempts === 0) return null;
    return Object.freeze({ runId, suiteId, modelTag, startedAtUtc, attempts, counts: Object.freeze(counts) });
  }
}
