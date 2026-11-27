import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { JsonlObservedTaskReader } from './jsonl-event-reader.ts';

const timestamp = '2026-10-26T12:00:00.000Z';

function line(taskId: string, type: string, eventId: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    idempotencyKey: `${type}:${eventId}`,
    event: { type, eventId, taskId, occurredAt: timestamp, actor: 'operator' },
  })}\n`;
}

async function setup(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'events');
  await mkdir(directory);
  return directory;
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) {
    result[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
  }
  return result;
}

test('returns no streams for a missing directory and does not create it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentctl-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'absent');
  assert.deepEqual(await new JsonlObservedTaskReader(directory).readStreams(), []);
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('reads complete streams and ignores a torn last line', async (t) => {
  const directory = await setup(t);
  await writeFile(join(directory, 'task-a.jsonl'), line('task-a', 'task.created', 'e1') + line('task-a', 'task.state_changed', 'e2') + '{"schemaVersion":1,"ev');
  const streams = await new JsonlObservedTaskReader(directory).readStreams();
  assert.equal(streams.length, 1);
  assert.equal(streams[0].taskId, 'task-a');
  assert.deepEqual(streams[0].events.map((event) => event.eventId), ['e1', 'e2']);
});

test('skips a stream that has only a torn line or does not start with task.created', async (t) => {
  const directory = await setup(t);
  await writeFile(join(directory, 'torn.jsonl'), '{"schemaVersion":1');
  await writeFile(join(directory, 'empty.jsonl'), '');
  await writeFile(join(directory, 'nocreate.jsonl'), line('nocreate', 'task.state_changed', 'e1'));
  await writeFile(join(directory, 'good.jsonl'), line('good', 'task.created', 'e1'));
  const streams = await new JsonlObservedTaskReader(directory).readStreams();
  assert.deepEqual(streams.map((stream) => stream.taskId), ['good']);
});

test('skips a whole stream when any line is invalid', async (t) => {
  const directory = await setup(t);
  await writeFile(join(directory, 'bad-json.jsonl'), line('bad-json', 'task.created', 'e1') + 'not json\n');
  await writeFile(join(directory, 'bad-version.jsonl'), line('bad-version', 'task.created', 'e1') + line('bad-version', 'task.state_changed', 'e2').replace('"schemaVersion":1', '"schemaVersion":2'));
  await writeFile(join(directory, 'wrong-task.jsonl'), line('wrong-task', 'task.created', 'e1') + line('other', 'task.state_changed', 'e2'));
  await writeFile(join(directory, 'bad-field.jsonl'), line('bad-field', 'task.created', 'e1') + `${JSON.stringify({ schemaVersion: 1, event: { type: 'x', eventId: 5, taskId: 'bad-field', occurredAt: timestamp } })}\n`);
  await writeFile(join(directory, 'blank.jsonl'), `${line('blank', 'task.created', 'e1')}\n`);
  await writeFile(join(directory, 'ok.jsonl'), line('ok', 'task.created', 'e1'));
  const streams = await new JsonlObservedTaskReader(directory).readStreams();
  assert.deepEqual(streams.map((stream) => stream.taskId), ['ok']);
});

test('ignores names that are not task streams and non-regular entries', async (t) => {
  const directory = await setup(t);
  await writeFile(join(directory, 'good.jsonl'), line('good', 'task.created', 'e1'));
  await writeFile(join(directory, 'Bad Name.jsonl'), line('Bad Name', 'task.created', 'e1'));
  await writeFile(join(directory, 'notes.txt'), 'x');
  await writeFile(join(directory, '.good.lock'), 'x');
  await mkdir(join(directory, 'dir.jsonl'));
  const streams = await new JsonlObservedTaskReader(directory).readStreams();
  assert.deepEqual(streams.map((stream) => stream.taskId), ['good']);
});

test('skips a symbolic link entry', async (t) => {
  const directory = await setup(t);
  await writeFile(join(directory, 'real.jsonl'), line('real', 'task.created', 'e1'));
  try {
    await symlink(join(directory, 'real.jsonl'), join(directory, 'link.jsonl'));
  } catch {
    t.skip('symbolic links are not available on this OS');
    return;
  }
  const streams = await new JsonlObservedTaskReader(directory).readStreams();
  assert.deepEqual(streams.map((stream) => stream.taskId), ['real']);
});

test('leaves every file and the directory listing unchanged', async (t) => {
  const directory = await setup(t);
  await writeFile(join(directory, 'task-a.jsonl'), line('task-a', 'task.created', 'e1') + '{"torn');
  await writeFile(join(directory, 'task-b.jsonl'), line('task-b', 'task.created', 'e1') + 'garbage\n');
  await writeFile(join(directory, 'task-c.jsonl'), '{"torn');
  const before = await fingerprint(directory);
  await new JsonlObservedTaskReader(directory).readStreams();
  assert.deepEqual(await fingerprint(directory), before);
  assert.deepEqual(await readdir(directory), Object.keys(before));
});

test('the reader source has no write, repair, or lock calls', async () => {
  // `npm test` runs the compiled copy under dist/, where only the .js file exists.
  const source = await readFile(new URL('./jsonl-event-reader.ts', import.meta.url), 'utf8')
    .catch(() => readFile(new URL('./jsonl-event-reader.js', import.meta.url), 'utf8'));
  for (const word of ['truncate', 'mkdir', 'writeFile', 'appendFile', 'rename', 'unlink', 'file-lock']) {
    assert.equal(source.includes(word), false, `reader source must not contain ${word}`);
  }
});
