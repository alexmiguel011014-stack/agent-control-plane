import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildNegativeControlDiff,
  decideSmokeOk,
  parseSmokeArgs,
  runPipelineSmoke,
} from './benchmark-smoke.ts';

const HASH = 'a'.repeat(64);

function findRepositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, 'package.json')) && existsSync(join(current, 'bench', 'tasks'))) return current;
    const parent = dirname(current);
    assert.notEqual(parent, current);
    current = parent;
  }
}

interface SeenProposal {
  readonly proposal: { readonly toolRequests: readonly { readonly operation: string; readonly diff: string }[] };
}

async function runWith(statuses: readonly string[]) {
  const root = findRepositoryRoot();
  const seen: SeenProposal[] = [];
  const result = await runPipelineSmoke(
    { repositoryRoot: root, approvedReviewSetSha256: HASH, taskId: 'B01' },
    {
      createApplication: async (options) => {
        const agent = options.agentOverride;
        assert.ok(agent);
        return {
          benchmark: {
            run: async () => {
              const attempts = [];
              for (const [index, status] of statuses.entries()) {
                seen.push((await agent.invoke({} as never)) as unknown as SeenProposal);
                attempts.push({ attemptTaskId: `b01-r-${index + 1}`, benchmarkTaskId: 'B01', attempt: index + 1, status });
              }
              return { runId: 'r', suiteId: 'g2-local-pure-localized', attempts } as never;
            },
          },
        };
      },
    },
  );
  return { result, seen };
}

test('exit decision for every outcome combination', async () => {
  const statuses = ['PASS', 'FAIL', 'POLICY_VIOLATION', 'TIMEOUT', 'CRASH', 'RUNNER_FAILURE'];
  for (const first of statuses) {
    for (const second of statuses) {
      const { result } = await runWith([first, second]);
      assert.equal(result.ok, first === 'PASS' && second !== 'PASS', `${first}/${second}`);
    }
  }
  assert.equal(decideSmokeOk([true]), false);
  assert.equal(decideSmokeOk([true, false, false]), false);
  assert.equal(decideSmokeOk([true, false]), true);
});

test('attempts are reported without patch text and the scripted agent serves reference then control', async () => {
  const root = findRepositoryRoot();
  const reference = await readFile(join(root, 'bench', 'tasks', 'B01', 'reference.patch'), 'utf8');
  const { result, seen } = await runWith(['PASS', 'FAIL']);
  assert.deepEqual(result.attempts, [
    { attempt: 1, category: 'resolved_hidden', reasonCode: 'pass' },
    { attempt: 2, category: 'not_resolved', reasonCode: 'fail' },
  ]);
  const diffs = seen.map((entry) => entry.proposal.toolRequests[0]?.diff ?? '');
  assert.equal(diffs[0], reference);
  assert.notEqual(diffs[1], reference);
  assert.ok((diffs[1] ?? '').length > 0);
  assert.equal(seen[0]?.proposal.toolRequests[0]?.operation, 'apply_unified_diff');
});

test('negative control differs from the reference, is non-empty, and has a comment fallback', () => {
  const reference = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n';
  const control = buildNegativeControlDiff(reference);
  assert.notEqual(control, reference);
  assert.ok(control.length > 0);
  assert.match(control, /\n-a\n\+a\n/);
  const noPair = '--- a/x\n+++ b/x\n@@ -1,1 +1,2 @@\n a\n+b\n';
  const fallback = buildNegativeControlDiff(noPair, 'one\ntwo\n');
  assert.match(fallback, /\+\/\/ smoke-negative-control/);
  assert.match(fallback, /@@ -1,2 \+1,3 @@/);
  assert.throws(() => buildNegativeControlDiff(noPair), { code: 'negative_control_unavailable' });
});

test('flag parsing is strict', () => {
  assert.deepEqual(parseSmokeArgs(['--approve-review-set-sha256', HASH]), { approvedReviewSetSha256: HASH, taskId: 'B01' });
  assert.equal(parseSmokeArgs(['--task-id', 'I02', '--approve-review-set-sha256', HASH]).taskId, 'I02');
  const cases: [string[], string][] = [
    [[], 'missing_hash'],
    [['--approve-review-set-sha256'], 'missing_flag_value'],
    [['--approve-review-set-sha256', 'A'.repeat(64)], 'invalid_hash'],
    [['--approve-review-set-sha256', 'abc'], 'invalid_hash'],
    [['--approve-review-set-sha256', HASH, '--task-id', 'b01'], 'invalid_task_id'],
    [['--approve-review-set-sha256', HASH, '--task-id', 'B011'], 'invalid_task_id'],
    [['--approve-review-set-sha256', HASH, '--other', 'x'], 'unknown_flag'],
    [['--approve-review-set-sha256', HASH, '--approve-review-set-sha256', HASH], 'duplicate_flag'],
  ];
  for (const [argv, code] of cases) assert.throws(() => parseSmokeArgs(argv), { code });
});

test('invalid task id is refused before any file access', async () => {
  await assert.rejects(
    runPipelineSmoke({ repositoryRoot: '/nonexistent', approvedReviewSetSha256: HASH, taskId: '../x' }),
    { code: 'invalid_task_id' },
  );
});
