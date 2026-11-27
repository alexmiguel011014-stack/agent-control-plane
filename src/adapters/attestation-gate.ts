import type { GeneratedCodeExecutionGatePort } from '../application/ports/index.ts';
import { readG2IsolationAttestation } from '../../bench/evaluator/isolation-attestation.mjs';

export type AttestationReader = (repositoryRoot: string) => Promise<unknown>;

/** Opens only while a valid G2.2 attestation reads back with status PASS. No cache, no logging, never throws. */
export class AttestationGeneratedCodeGate implements GeneratedCodeExecutionGatePort {
  readonly #repositoryRoot: string;
  readonly #reader: AttestationReader;

  constructor(repositoryRoot: string, reader: AttestationReader = readG2IsolationAttestation) {
    this.#repositoryRoot = repositoryRoot;
    this.#reader = reader;
  }

  async isOpen(): Promise<boolean> {
    try {
      const result = (await this.#reader(this.#repositoryRoot)) as { evidence?: { status?: unknown } } | null;
      return result?.evidence?.status === 'PASS';
    } catch {
      return false;
    }
  }
}
