import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspacePathAccessPort } from '../application/ports/index.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import { ContextReaderError, createWorkspaceContextReader } from './workspace-context-reader.ts';

const workspace = { workspaceId: 'ws-secret-id' };
const envelope = { allowedPaths: ['src/**'] } as unknown as TaskEnvelopeV1;

function fakePort(files: Record<string, string>, listOverride?: readonly string[]) {
  const reads: string[] = [];
  const listCalls: unknown[] = [];
  const listed = listOverride ?? Object.keys(files);
  const port = {
    async listAllowed(input: unknown) {
      listCalls.push(input);
      return listed;
    },
    async readText(input: { relativePath: string }) {
      reads.push(input.relativePath);
      if (!(input.relativePath in files)) throw new Error('workspace_path_denied');
      return files[input.relativePath] as string;
    }
  } as unknown as WorkspacePathAccessPort;
  return { port, reads, listCalls, listed };
}

test('filters extensions and sorts in code-point order, reading only listed paths', async () => {
  const { port, reads, listCalls, listed } = fakePort({
    'src/b.ts': 'b',
    'src/B.js': 'B',
    'src/a.json': 'a',
    'src/readme.md': 'md',
    'src/c.mjs': 'c'
  });
  const result = await createWorkspaceContextReader(port)({ envelope, workspace });
  assert.deepEqual(result.map((file) => file.path), ['src/B.js', 'src/a.json', 'src/b.ts', 'src/c.mjs']);
  assert.ok(Object.isFrozen(result));
  assert.ok(reads.every((path) => listed.includes(path)));
  assert.ok(!reads.includes('src/readme.md'));
  assert.equal((listCalls[0] as { maxResults: number }).maxResults, 65);
});

test('too_many_files when the port returns 65 paths', async () => {
  const names = Array.from({ length: 65 }, (_, index) => `src/f${index}.ts`);
  const { port, reads } = fakePort({}, names);
  await assert.rejects(
    createWorkspaceContextReader(port)({ envelope, workspace }),
    (error: unknown) => error instanceof ContextReaderError && error.code === 'too_many_files'
  );
  assert.equal(reads.length, 0);
});

test('file_too_large over 16384 bytes', async () => {
  const { port } = fakePort({ 'src/a.ts': 'x'.repeat(16_385) });
  await assert.rejects(
    createWorkspaceContextReader(port)({ envelope, workspace }),
    (error: unknown) => error instanceof ContextReaderError && error.code === 'file_too_large'
  );
});

test('a file of exactly 16384 bytes is accepted', async () => {
  const { port } = fakePort({ 'src/a.ts': 'x'.repeat(16_384) });
  const result = await createWorkspaceContextReader(port)({ envelope, workspace });
  assert.equal(result.length, 1);
});

test('context_too_large when the total passes 24576 bytes', async () => {
  const { port } = fakePort({
    'src/a.ts': 'x'.repeat(12_288),
    'src/b.ts': 'x'.repeat(12_288),
    'src/c.ts': 'x'
  });
  await assert.rejects(
    createWorkspaceContextReader(port)({ envelope, workspace }),
    (error: unknown) => error instanceof ContextReaderError && error.code === 'context_too_large'
  );
});

test('port errors never leak identifiers in the error message', async () => {
  const port = {
    async listAllowed() {
      return ['src/a.ts'];
    },
    async readText() {
      throw new Error('C:\\host\\path ws-secret-id');
    }
  } as unknown as WorkspacePathAccessPort;
  await assert.rejects(
    createWorkspaceContextReader(port)({ envelope, workspace }),
    (error: unknown) =>
      error instanceof ContextReaderError && error.code === 'read_failed' && !/host|ws-secret/.test(error.message)
  );
});
