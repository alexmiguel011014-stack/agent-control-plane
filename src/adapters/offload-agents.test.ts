import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CaptureAgentAdapter,
  OffloadError,
  ReplayAgentAdapter,
  fixedContextReader,
  offloadKey,
  parseOffloadInvocationLine,
  parseOffloadResultLine,
} from './offload-agents.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import type { WorkspaceReference } from '../application/ports/index.ts';

const workspace = Object.freeze({ workspaceId: 'opaque-workspace' }) satisfies WorkspaceReference;

function envelope(taskId: string, prompt = 'Fix the bug.'): TaskEnvelopeV1 {
  return {
    schemaVersion: 1,
    taskId,
    prompt,
    requestedOperations: ['read'],
    allowedPaths: ['src/**/*.ts'],
    declaredTests: [],
    baseSnapshotSha256: 'b'.repeat(64),
  };
}

const promptHash = createHash('sha256').update('Fix the bug.', 'utf8').digest('hex');

function resultRecord(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    key,
    result: { kind: 'refusal', reasonCode: 'x' },
    durationMs: 5,
    modelTag: 'm',
    modelDigest: null,
    runtimeVersion: null,
    ...extra,
  };
}

test('derives the key from task id, attempt, snapshot, and prompt hash', () => {
  assert.equal(offloadKey(envelope('i01-run1-2'), 'run1'), `i01|2|${'b'.repeat(64)}|${promptHash}`);
});

test('rejects task ids that do not match the attempt suffix rule', () => {
  for (const id of ['i01-run1-0', 'i01-run1-1000', 'i01-run1-x', 'i01-other-1', '-run1-1', 'I01-run1-1']) {
    assert.throws(
      () => offloadKey(envelope(id), 'run1'),
      (error) => error instanceof OffloadError && error.code === 'task_id_unparsed',
      id,
    );
  }
});

test('capture stores a record with context files and refuses', async () => {
  const files = [{ path: 'a.ts', text: 'x' }];
  const capture = new CaptureAgentAdapter({ runId: 'run1', contextReader: fixedContextReader(files) });
  const result = await capture.invoke({ envelope: envelope('i01-run1-1'), workspace });
  assert.deepEqual(result, { kind: 'refusal', reasonCode: 'offload_captured' });
  const records = capture.records();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.version, 1);
  assert.equal(records[0]?.key, offloadKey(envelope('i01-run1-1'), 'run1'));
  assert.deepEqual(records[0]?.files, files);
});

test('capture throws on a duplicate key', async () => {
  const capture = new CaptureAgentAdapter({ runId: 'run1', contextReader: fixedContextReader([]) });
  await capture.invoke({ envelope: envelope('i01-run1-1'), workspace });
  await assert.rejects(
    capture.invoke({ envelope: envelope('i01-run1-1'), workspace }),
    (error) => error instanceof OffloadError && error.code === 'duplicate_key',
  );
});

test('replay returns the stored result, or a refusal on a miss', async () => {
  const key = offloadKey(envelope('i01-run1-1'), 'run1');
  const stored = parseOffloadResultLine(
    JSON.stringify(resultRecord(key, { result: { kind: 'proposal', proposal: { proposalId: 'p', toolRequests: [] } } })),
  );
  const replay = new ReplayAgentAdapter({ runId: 'run1', results: [stored] });
  assert.deepEqual(await replay.invoke({ envelope: envelope('i01-run1-1'), workspace }), stored.result);
  assert.deepEqual(await replay.invoke({ envelope: envelope('i02-run1-1'), workspace }), {
    kind: 'refusal',
    reasonCode: 'offload_missing',
  });
});

test('replay constructor throws on a duplicate key', () => {
  const record = parseOffloadResultLine(JSON.stringify(resultRecord('k')));
  assert.throws(
    () => new ReplayAgentAdapter({ runId: 'run1', results: [record, record] }),
    (error) => error instanceof OffloadError && error.code === 'duplicate_key',
  );
});

test('result parser accepts a valid line and rejects each violation', () => {
  assert.equal(parseOffloadResultLine(JSON.stringify(resultRecord('k'))).key, 'k');
  assert.equal(parseOffloadResultLine(JSON.stringify(resultRecord('k', { result: { kind: 'refusal' } }))).key, 'k');
  const bad: string[] = [
    'x'.repeat(4_194_305),
    'not json',
    '[]',
    JSON.stringify({ ...resultRecord('k'), extra: 1 }),
    JSON.stringify(resultRecord('k', { version: 2 })),
    JSON.stringify(resultRecord('')),
    JSON.stringify(resultRecord('k'.repeat(513))),
    JSON.stringify(resultRecord('k', { result: { kind: 'other' } })),
    JSON.stringify(resultRecord('k', { result: { kind: 'refusal', reasonCode: '' } })),
    JSON.stringify(resultRecord('k', { result: { kind: 'refusal', reasonCode: 'r'.repeat(65) } })),
    JSON.stringify(resultRecord('k', { result: { kind: 'refusal', reasonCode: 3 } })),
    JSON.stringify(resultRecord('k', { durationMs: -1 })),
    JSON.stringify(resultRecord('k', { durationMs: '5' })),
  ];
  for (const line of bad) {
    assert.throws(() => parseOffloadResultLine(line), OffloadError, line.slice(0, 60));
  }
});

test('invocation parser accepts a valid line and rejects each violation', () => {
  const good = { version: 1, key: 'k', envelope: envelope('i01-run1-1'), files: [{ path: 'a', text: 'b' }] };
  assert.equal(parseOffloadInvocationLine(JSON.stringify(good)).files.length, 1);
  const bad: unknown[] = [
    { ...good, extra: 1 },
    { version: 1, key: 'k', envelope: good.envelope },
    { ...good, version: 2 },
    { ...good, key: '' },
    { ...good, envelope: 'x' },
    { ...good, envelope: { ...good.envelope, unknown: 1 } },
    { ...good, envelope: { ...good.envelope, prompt: '' } },
    { ...good, files: [{ path: 'a' }] },
    { ...good, files: [{ path: 'a', text: 'b', more: 1 }] },
    { ...good, files: [{ path: 1, text: 'b' }] },
  ];
  for (const value of bad) {
    assert.throws(() => parseOffloadInvocationLine(JSON.stringify(value)), OffloadError);
  }
  assert.throws(() => parseOffloadInvocationLine('x'.repeat(4_194_305)), OffloadError);
});
