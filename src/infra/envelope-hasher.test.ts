import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import { canonicalTaskEnvelope, NodeEnvelopeHasher } from './envelope-hasher.ts';

const envelope: TaskEnvelopeV1 = {
  schemaVersion: 1,
  taskId: 'task-hash-01',
  prompt: 'Revisar café e código ☕',
  requestedOperations: ['read', 'write'],
  allowedPaths: ['src/arquivo.ts', 'docs/*.md'],
  declaredTests: [],
  baseSnapshotSha256: 'a'.repeat(64),
};

test('hashes TaskEnvelopeV1 using fixed-order compact UTF-8 JSON', async () => {
  const hasher = new NodeEnvelopeHasher();
  assert.equal(
    canonicalTaskEnvelope(envelope),
    `{"schemaVersion":1,"taskId":"task-hash-01","prompt":"Revisar café e código ☕","requestedOperations":["read","write"],"allowedPaths":["src/arquivo.ts","docs/*.md"],"baseSnapshotSha256":"${'a'.repeat(64)}"}`,
  );
  assert.equal(await hasher.hash(envelope), '082a9e09dde0fe1a8a7f63d47292a2f3043ef22ce4149a068e782c355d0c48a3');
});

test('returns the same hash for identical envelope values', async () => {
  const hasher = new NodeEnvelopeHasher();
  assert.equal(await hasher.hash(envelope), await hasher.hash({ ...envelope }));
});

test('keeps legacy path declarations hash-compatible and binds host harness IDs and protocol in order', async () => {
  const hasher = new NodeEnvelopeHasher();
  const { declaredTests: _declaredTests, ...legacy } = envelope;
  assert.equal(canonicalTaskEnvelope(legacy as unknown as TaskEnvelopeV1), canonicalTaskEnvelope(envelope));
  assert.equal(await hasher.hash(legacy as unknown as TaskEnvelopeV1), '082a9e09dde0fe1a8a7f63d47292a2f3043ef22ce4149a068e782c355d0c48a3');

  const withDeclaredTest: TaskEnvelopeV1 = {
    ...envelope,
    declaredTests: [{ id: 'smoke', profile: 'node-test', path: 'tests/smoke.test.mjs' }],
  };
  assert.equal(
    canonicalTaskEnvelope(withDeclaredTest),
    `{"schemaVersion":1,"taskId":"task-hash-01","prompt":"Revisar café e código ☕","requestedOperations":["read","write"],"allowedPaths":["src/arquivo.ts","docs/*.md"],"declaredTests":[{"id":"smoke","profile":"node-test","path":"tests/smoke.test.mjs"}],"baseSnapshotSha256":"${'a'.repeat(64)}"}`,
  );
  assert.equal(await hasher.hash(withDeclaredTest), 'aeeadf3eecb2c2864d7d92d687e6c0faaf25de05d9604b4ac4c343f607722c8f');
  const hostHarness: TaskEnvelopeV1 = {
    ...envelope,
    declaredTests: [{ id: 'smoke', profile: 'host-json-v1' }],
  };
  assert.equal(
    canonicalTaskEnvelope(hostHarness),
    `{"schemaVersion":1,"taskId":"task-hash-01","prompt":"Revisar café e código ☕","requestedOperations":["read","write"],"allowedPaths":["src/arquivo.ts","docs/*.md"],"declaredTests":[{"id":"smoke","profile":"host-json-v1"}],"baseSnapshotSha256":"${'a'.repeat(64)}"}`,
  );
  assert.notEqual(await hasher.hash(hostHarness), await hasher.hash(withDeclaredTest));
  const reordered = { ...hostHarness, declaredTests: [...hostHarness.declaredTests, { id: 'extra', profile: 'host-json-v1' as const }] };
  const reversed = { ...reordered, declaredTests: [...reordered.declaredTests].reverse() };
  assert.notEqual(await hasher.hash(reordered), await hasher.hash(reversed));
});
