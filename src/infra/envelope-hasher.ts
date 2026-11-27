import { createHash } from 'node:crypto';
import type { EnvelopeHasherPort } from '../application/ports/index.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';

/** Fixed field order is part of the TaskEnvelopeV1 hash contract. */
export function canonicalTaskEnvelope(envelope: TaskEnvelopeV1): string {
  const declaredTests = envelope.declaredTests ?? [];
  const canonical = {
    schemaVersion: envelope.schemaVersion,
    taskId: envelope.taskId,
    prompt: envelope.prompt,
    requestedOperations: [...envelope.requestedOperations],
    allowedPaths: [...envelope.allowedPaths],
    ...(declaredTests.length === 0 ? {} : {
      declaredTests: declaredTests.map((test) => test.profile === 'node-test'
        ? { id: test.id, profile: test.profile, path: test.path }
        : { id: test.id, profile: test.profile }),
    }),
    baseSnapshotSha256: envelope.baseSnapshotSha256,
  };
  return JSON.stringify(canonical);
}

export class NodeEnvelopeHasher implements EnvelopeHasherPort {
  async hash(envelope: TaskEnvelopeV1): Promise<string> {
    return createHash('sha256').update(canonicalTaskEnvelope(envelope), 'utf8').digest('hex');
  }
}
