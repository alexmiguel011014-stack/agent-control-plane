import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AttestationGeneratedCodeGate } from './attestation-gate.ts';

test('opens for a PASS attestation', async () => {
  const gate = new AttestationGeneratedCodeGate('root', async () => ({ evidence: { status: 'PASS' } }));
  assert.equal(await gate.isOpen(), true);
});

test('closes on a rejecting reader', async () => {
  const gate = new AttestationGeneratedCodeGate('root', async () => {
    throw new Error('boom');
  });
  assert.equal(await gate.isOpen(), false);
});

test('closes on a synchronously throwing reader', async () => {
  const gate = new AttestationGeneratedCodeGate('root', (() => {
    throw new Error('boom');
  }) as never);
  assert.equal(await gate.isOpen(), false);
});

test('closes on a wrong status or shape', async () => {
  for (const value of [{ evidence: { status: 'FAIL' } }, { evidence: {} }, {}, null, undefined, 'PASS']) {
    const gate = new AttestationGeneratedCodeGate('root', async () => value);
    assert.equal(await gate.isOpen(), false);
  }
});

test('does not cache: two calls read twice', async () => {
  let reads = 0;
  const gate = new AttestationGeneratedCodeGate('root', async () => {
    reads += 1;
    return { evidence: { status: 'PASS' } };
  });
  await gate.isOpen();
  await gate.isOpen();
  assert.equal(reads, 2);
});

test('default reader is closed when the attestation file is absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'attestation-gate-'));
  try {
    assert.equal(await new AttestationGeneratedCodeGate(root).isOpen(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
