import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentInvocationResult } from '../application/ports/index.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import { parseAgentProposal } from '../tools/tool-gateway.ts';
import {
  OllamaAgentAdapter,
  OllamaAgentError,
  buildLocalizationNote,
  parseLocalization,
  voteLocalization,
  type OllamaAgentAdapterOptions,
  type OllamaContextFile,
  type OllamaContextReader,
  type OllamaInvocationMetadata,
} from './ollama.ts';

const MODEL_TAG = 'qwen2.5-coder:1.5b';
const MODEL_DIGEST = 'b'.repeat(64);
const SNAPSHOT_SHA = 'c'.repeat(64);
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const WORKSPACE = Object.freeze({ workspaceId: 'ws-secret-id' });

type QueueItem = Response | Error | ((init?: RequestInit) => Promise<Response>);

function envelope(prompt = 'Fix the add function in src/math.ts.'): TaskEnvelopeV1 {
  return Object.freeze({
    schemaVersion: 1,
    taskId: 'task-1',
    prompt,
    requestedOperations: Object.freeze(['read', 'write'] as const),
    allowedPaths: Object.freeze(['src/**']),
    declaredTests: Object.freeze([Object.freeze({ id: 'unit-math', profile: 'host-json-v1' as const })]),
    baseSnapshotSha256: SNAPSHOT_SHA,
  });
}

function fetchQueue(items: readonly QueueItem[]) {
  const queue = [...items];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error('unexpected_local_request');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(init);
    return next;
  };
  return { fetcher, calls };
}

function runtimeResponses(): Response[] {
  return [
    Response.json({ version: '0.12.0' }),
    Response.json({ models: [{ name: 'other:latest', digest: 'd'.repeat(64) }, { name: MODEL_TAG, digest: MODEL_DIGEST }] }),
  ];
}

function chat(content: unknown, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Response {
  return Response.json({
    model: MODEL_TAG,
    done: true,
    message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content), ...extra },
    ...top,
  });
}

/** A body stream whose cancel() never settles; optionally enqueues one chunk of the given size first. */
function hungCancelBody(chunkBytes: number | null, onCancel: () => void = () => undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunkBytes !== null) controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      onCancel();
      return new Promise<void>(() => undefined);
    },
  });
}

/** A body that streams the given total size in 64 KiB chunks, with no content-length header. */
function streamedBody(totalBytes: number): ReadableStream<Uint8Array> {
  let remaining = totalBytes;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(65_536, remaining);
      remaining -= size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}

function adapter(items: readonly QueueItem[], options: Omit<OllamaAgentAdapterOptions, 'fetcher'> = {}) {
  const fetch = fetchQueue(items);
  const observed: OllamaInvocationMetadata[] = [];
  const instance = new OllamaAgentAdapter({ onInvocation: (metadata) => observed.push(metadata), ...options, fetcher: fetch.fetcher });
  return { instance, fetch, observed };
}

function assertRefusal(result: AgentInvocationResult, reasonCode: string): void {
  assert.deepEqual(result, { kind: 'refusal', reasonCode });
  assert.match(reasonCode, REASON_CODE_PATTERN);
}

async function assertAgentError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof OllamaAgentError && error.code === code
    && error.message === `ollama_agent_${code}`);
}

const VALID_PROPOSAL = {
  proposalId: 'p-1',
  toolRequests: [
    { operation: 'read_text', path: 'src/math.ts' },
    { operation: 'list_files' },
    { operation: 'run_declared_test', testId: 'unit-math' },
    { operation: 'git_diff', paths: ['src/math.ts'] },
  ],
};

test('success uses fixed loopback endpoints, no tools, bounded options, and returns only the proposal', async () => {
  const { instance, fetch, observed } = adapter([...runtimeResponses(), chat(VALID_PROPOSAL)], { seed: 7 });
  assert.equal(fetch.calls.length, 0, 'construction contacts nothing');

  const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(result.kind, 'proposal');
  assert.ok(Object.isFrozen(result));
  const proposal = (result as { proposal: Record<string, unknown> }).proposal;
  assert.deepEqual(Object.keys(proposal).sort(), ['proposalId', 'toolRequests']);
  assert.deepEqual(proposal, VALID_PROPOSAL);

  assert.deepEqual(fetch.calls.map((call) => call.url), [
    'http://127.0.0.1:11434/api/version',
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:11434/api/chat',
  ]);
  assert.ok(fetch.calls.every((call) => call.init?.redirect === 'error' && call.init.signal instanceof AbortSignal));
  const body = JSON.parse(String(fetch.calls[2]?.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, MODEL_TAG);
  assert.equal(body.stream, false);
  assert.equal(body.keep_alive, '0s');
  assert.equal('tools' in body, false);
  assert.deepEqual(body.options, { temperature: 0, num_ctx: 4_096, num_predict: 1_024, seed: 7 });
  const format = body.format as Record<string, unknown>;
  assert.equal(format.additionalProperties, false);
  assert.deepEqual(format.required, ['proposalId', 'toolRequests']);

  const serialized = String(fetch.calls[2]?.init?.body);
  assert.ok(!serialized.includes(SNAPSHOT_SHA), 'snapshot hash is not sent');
  assert.ok(!serialized.includes(WORKSPACE.workspaceId), 'workspace reference is not sent');
  const messages = body.messages as Array<{ content: string }>;
  assert.deepEqual(JSON.parse(messages[1]?.content ?? ''), {
    task: 'Fix the add function in src/math.ts.',
    allowedPaths: ['src/**'],
    requestedOperations: ['read', 'write'],
    declaredTestIds: ['unit-math'],
  });

  assert.equal(observed.length, 1);
  const metadata = observed[0];
  assert.ok(metadata && Object.isFrozen(metadata));
  assert.equal(metadata?.modelTag, MODEL_TAG);
  assert.equal(metadata?.modelDigest, MODEL_DIGEST);
  assert.equal(metadata?.runtimeVersion, '0.12.0');
  assert.equal(metadata?.outcome, 'proposal');
  assert.equal(metadata?.seeded, true);
  assert.equal(metadata?.promptTokensKnown, false);
  assert.ok(typeof metadata?.durationMs === 'number' && metadata.durationMs >= 0);
});

test('seed is omitted from options when not configured', async () => {
  const { instance, fetch, observed } = adapter([...runtimeResponses(), chat({ proposalId: 'p', toolRequests: [] })]);
  await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  const body = JSON.parse(String(fetch.calls[2]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(body.options, { temperature: 0, num_ctx: 4_096, num_predict: 1_024 });
  assert.equal(observed[0]?.seeded, false);
});

test('malformed or schema-violating model output is refused, never proposed', async () => {
  const cases: Array<[string, Response, string]> = [
    ['not json', chat('{"proposalId": "p", toolRequests'), 'invalid_structured_output'],
    ['json array', chat([]), 'invalid_structured_output'],
    ['extra key', chat({ ...VALID_PROPOSAL, model: 'x' }), 'invalid_structured_output'],
    ['missing key', chat({ proposalId: 'p' }), 'invalid_structured_output'],
    ['non-string proposalId', chat({ proposalId: 7, toolRequests: [] }), 'invalid_structured_output'],
    ['native tool calls', chat(VALID_PROPOSAL, { tool_calls: [{ function: { name: 'read_text', arguments: {} } }] }), 'invalid_structured_output'],
    ['malformed tool_calls', chat(VALID_PROPOSAL, { tool_calls: 'run' }), 'invalid_structured_output'],
    ['unknown operation', chat({ proposalId: 'p', toolRequests: [{ operation: 'shell', command: 'rm -rf /' }] }), 'invalid_structured_output'],
    ['wrong type', chat({ proposalId: 'p', toolRequests: [{ operation: 'read_text', path: 42 }] }), 'invalid_structured_output'],
    ['missing field', chat({ proposalId: 'p', toolRequests: [{ operation: 'run_declared_test' }] }), 'invalid_structured_output'],
    ['extra tool key', chat({ proposalId: 'p', toolRequests: [{ operation: 'list_files', recursive: true }] }), 'invalid_structured_output'],
    ['overlong path', chat({ proposalId: 'p', toolRequests: [{ operation: 'read_text', path: `${'a/'.repeat(600)}x.ts` }] }), 'invalid_structured_output'],
    ['traversal path', chat({ proposalId: 'p', toolRequests: [{ operation: 'read_text', path: '../secret.txt' }] }), 'invalid_structured_output'],
    ['bad diff', chat({ proposalId: 'p', toolRequests: [{ operation: 'apply_unified_diff', diff: 'not a diff' }] }), 'invalid_structured_output'],
    ['too many requests', chat({ proposalId: 'p', toolRequests: Array.from({ length: 9 }, (_, index) => ({ operation: 'read_text', path: `src/f${index}.ts` })) }), 'tool_call_limit_exceeded'],
  ];
  for (const [label, response, reasonCode] of cases) {
    const { instance, observed } = adapter([...runtimeResponses(), response]);
    const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
    assertRefusal(result, reasonCode);
    assert.equal(observed[0]?.outcome, reasonCode, label);
  }
});

test('the tool request count bound follows maxToolRequests', async () => {
  const toolRequests = [{ operation: 'read_text', path: 'src/a.ts' }, { operation: 'read_text', path: 'src/b.ts' }];
  const limited = adapter([...runtimeResponses(), chat({ proposalId: 'p', toolRequests })], { maxToolRequests: 1 });
  assertRefusal(await limited.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'tool_call_limit_exceeded');
  const body = JSON.parse(String(limited.fetch.calls[2]?.init?.body)) as { format: { properties: { toolRequests: { maxItems: number } } } };
  assert.equal(body.format.properties.toolRequests.maxItems, 1);
});

test('runtime unavailable, model missing, and invalid runtime responses fail closed with typed errors', async () => {
  const cases: Array<[QueueItem[], string]> = [
    [[new TypeError('fetch failed')], 'runtime_unavailable'],
    [[new Response('nope', { status: 500 })], 'runtime_unavailable'],
    [[runtimeResponses()[0] as Response, new Response('nope', { status: 503 })], 'runtime_unavailable'],
    [[...runtimeResponses(), new Response('nope', { status: 500 })], 'runtime_unavailable'],
    [[Response.json({ version: '0.12.0' }), Response.json({ models: [] })], 'model_missing'],
    [[Response.json({ version: '$(whoami)' })], 'invalid_runtime_response'],
    [[new Response('not json', { status: 200 })], 'invalid_runtime_response'],
    [[Response.json({ version: '0.12.0' }), Response.json({ models: [{ name: MODEL_TAG, digest: 'sha256:zz' }] })], 'invalid_runtime_response'],
    [[Response.json({ version: '0.12.0' }), Response.json({ models: 'all' })], 'invalid_runtime_response'],
    [[...runtimeResponses(), Response.json({ model: 'other', done: true, message: { role: 'assistant', content: '{}' } })], 'invalid_runtime_response'],
    [[...runtimeResponses(), Response.json({ model: MODEL_TAG, done: false })], 'invalid_runtime_response'],
  ];
  for (const [items, code] of cases) {
    const { instance, observed } = adapter(items);
    await assertAgentError(instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), code);
    assert.equal(observed[0]?.outcome, code);
    assert.equal(instance.busy, false);
  }
});

test('a model-missing invocation never attempts chat or a model download', async () => {
  const { instance, fetch } = adapter([Response.json({ version: '0.12.0' }), Response.json({ models: [] })]);
  await assertAgentError(instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'model_missing');
  assert.equal(fetch.calls.length, 2);
  assert.ok(fetch.calls.every((call) => !call.url.endsWith('/api/chat') && !call.url.endsWith('/api/pull')));
});

test('timeout errors map to a typed timeout, including a hung fetch and a hung body', async () => {
  const timeoutError = new DOMException('timed out', 'TimeoutError');
  const rejected = adapter([timeoutError]);
  await assertAgentError(rejected.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'timeout');
  assert.equal(rejected.observed[0]?.outcome, 'timeout');

  const signalAware = adapter([
    ...runtimeResponses(),
    (init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  ], { timeoutMs: 1_000 });
  await assertAgentError(signalAware.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'timeout');

  const ignoresSignal = adapter([() => new Promise<Response>(() => undefined)], { timeoutMs: 1_000 });
  await assertAgentError(ignoresSignal.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'timeout');

  const hungBody = adapter([
    ...runtimeResponses(),
    new Response(new ReadableStream<Uint8Array>({ start() { /* never enqueues or closes */ } }), { status: 200 }),
  ], { timeoutMs: 1_000 });
  await assertAgentError(hungBody.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'timeout');
  assert.equal(hungBody.instance.busy, false);
});

test('context overflow is refused before any runtime request', async () => {
  const big = adapter([]);
  assertRefusal(await big.instance.invoke({ envelope: envelope('x'.repeat(70_000)), workspace: WORKSPACE }), 'context_overflow');
  assert.equal(big.fetch.calls.length, 0);
  assert.equal(big.observed[0]?.outcome, 'context_overflow');

  const smallCtx = adapter([], { numCtx: 1_024, numPredict: 512 });
  assertRefusal(await smallCtx.instance.invoke({ envelope: envelope('y'.repeat(1_500)), workspace: WORKSPACE }), 'context_overflow');
  assert.equal(smallCtx.fetch.calls.length, 0);
  assert.equal(smallCtx.instance.busy, false);
});

test('a concurrent invocation is rejected while the first completes, and the flag is released', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { instance } = adapter([
    async () => { await gate; return Response.json({ version: '0.12.0' }); },
    runtimeResponses()[1] as Response,
    chat({ proposalId: 'first', toolRequests: [] }),
    ...runtimeResponses(),
    chat({ proposalId: 'second', toolRequests: [] }),
  ]);
  const first = instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(instance.busy, true);
  await assertAgentError(instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'agent_busy');
  release();
  const firstResult = await first;
  assert.equal((firstResult as { proposal: { proposalId: string } }).proposal.proposalId, 'first');
  assert.equal(instance.busy, false);
  const later = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal((later as { proposal: { proposalId: string } }).proposal.proposalId, 'second');
});

test('the active-run flag is released after error and timeout', async () => {
  const { instance } = adapter([
    new TypeError('fetch failed'),
    () => new Promise<Response>(() => undefined),
    ...runtimeResponses(),
    chat({ proposalId: 'after', toolRequests: [] }),
  ], { timeoutMs: 1_000 });
  await assertAgentError(instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'runtime_unavailable');
  await assertAgentError(instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'timeout');
  const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(result.kind, 'proposal');
});

test('a throwing observer cannot change the result', async () => {
  const fetch = fetchQueue([...runtimeResponses(), chat({ proposalId: 'p', toolRequests: [] })]);
  const instance = new OllamaAgentAdapter({ fetcher: fetch.fetcher, onInvocation: () => { throw new Error('observer'); } });
  assert.equal((await instance.invoke({ envelope: envelope(), workspace: WORKSPACE })).kind, 'proposal');
});

test('constructor validates options and offers no base URL override', () => {
  const fetcher = fetchQueue([]).fetcher;
  const invalid: OllamaAgentAdapterOptions[] = [
    { timeoutMs: 999 },
    { timeoutMs: 600_001 },
    { timeoutMs: 1.5 },
    { maxToolRequests: 33 },
    { maxToolRequests: 0 },
    { numCtx: 100 },
    { numPredict: 10 },
    { numCtx: 1_024, numPredict: 1_024 },
    { seed: -1 },
    { seed: 0.5 },
    { modelTag: 'bad tag; rm' },
  ];
  for (const options of invalid) {
    assert.throws(() => new OllamaAgentAdapter({ ...options, fetcher }), (error: unknown) =>
      error instanceof OllamaAgentError && error.code === 'invalid_configuration');
  }
  assert.doesNotThrow(() => new OllamaAgentAdapter({ fetcher, maxToolRequests: 32, timeoutMs: 1_000 }));
});

test('unknown options cannot redirect requests off loopback', async () => {
  const fetch = fetchQueue([...runtimeResponses(), chat({ proposalId: 'p', toolRequests: [] })]);
  const instance = new OllamaAgentAdapter({ fetcher: fetch.fetcher, baseUrl: 'http://example.com' } as OllamaAgentAdapterOptions);
  await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.ok(fetch.calls.every((call) => call.url.startsWith('http://127.0.0.1:11434/')));
});

test('a reported prompt_eval_count above numCtx - numPredict is refused as possible truncation', async () => {
  const over = adapter([...runtimeResponses(), chat(VALID_PROPOSAL, {}, { prompt_eval_count: 3_073 })]);
  const refused = await over.instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assertRefusal(refused, 'context_overflow');
  assert.equal('proposal' in refused, false);
  assert.equal(over.observed[0]?.outcome, 'context_overflow');
  assert.equal(over.observed[0]?.promptTokensKnown, true);

  const atLimit = adapter([...runtimeResponses(), chat(VALID_PROPOSAL, {}, { prompt_eval_count: 3_072 })]);
  const accepted = await atLimit.instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(accepted.kind, 'proposal');
  assert.equal(atLimit.observed[0]?.promptTokensKnown, true);
  assert.ok(Object.isFrozen(atLimit.observed[0]));

  const smaller = adapter([...runtimeResponses(), chat(VALID_PROPOSAL, {}, { prompt_eval_count: 513 })], { numCtx: 1_024, numPredict: 512 });
  assertRefusal(await smaller.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'context_overflow');
});

test('an absent or non-integer prompt_eval_count is accepted and recorded as unknown', async () => {
  const cases: Array<Record<string, unknown>> = [{}, { prompt_eval_count: 12.5 }, { prompt_eval_count: '99999' }, { prompt_eval_count: null }];
  for (const top of cases) {
    const { instance, observed } = adapter([...runtimeResponses(), chat(VALID_PROPOSAL, {}, top)]);
    const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
    assert.equal(result.kind, 'proposal', JSON.stringify(top));
    assert.equal(observed[0]?.promptTokensKnown, false);
    assert.ok(Object.isFrozen(observed[0]));
  }
});

test('oversized bodies are bounded: chat is refused and version is an invalid runtime response', async () => {
  const bigChat = adapter([...runtimeResponses(), new Response(streamedBody(2_097_153), { status: 200 })]);
  assertRefusal(await bigChat.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'invalid_structured_output');
  assert.equal(bigChat.observed[0]?.outcome, 'invalid_structured_output');

  const bigVersion = adapter([new Response(streamedBody(4_097), { status: 200 })]);
  await assertAgentError(bigVersion.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'invalid_runtime_response');
  assert.equal(bigVersion.fetch.calls.length, 1);
});

test('a declared content-length over the cap gives the same bounded outcome as a real oversized body', async () => {
  const declaredChat = adapter([
    ...runtimeResponses(),
    new Response(JSON.stringify({ model: MODEL_TAG }), { status: 200, headers: { 'content-length': '2097153' } }),
  ]);
  assertRefusal(await declaredChat.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'invalid_structured_output');

  const declaredVersion = adapter([
    new Response(JSON.stringify({ version: '0.12.0' }), { status: 200, headers: { 'content-length': '4097' } }),
  ]);
  await assertAgentError(declaredVersion.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'invalid_runtime_response');
});

test('a body cancel that never settles cannot hang invoke past its bound or leave it busy', async () => {
  const oversized = adapter([
    ...runtimeResponses(),
    new Response(hungCancelBody(2_097_153), { status: 200 }),
    ...runtimeResponses(),
    chat({ proposalId: 'after-oversized', toolRequests: [] }),
  ], { timeoutMs: 1_000 });
  assertRefusal(await oversized.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'invalid_structured_output');
  assert.equal(oversized.instance.busy, false);
  const next = await oversized.instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal((next as { proposal: { proposalId: string } }).proposal.proposalId, 'after-oversized');

  const notOk = adapter([new Response(hungCancelBody(16), { status: 500 })], { timeoutMs: 1_000 });
  await assertAgentError(notOk.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'runtime_unavailable');
  assert.equal(notOk.instance.busy, false);

  const declared = adapter([new Response(hungCancelBody(16), { status: 200, headers: { 'content-length': '4097' } })], { timeoutMs: 1_000 });
  await assertAgentError(declared.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'invalid_runtime_response');
  assert.equal(declared.instance.busy, false);

  const aborted = adapter([
    ...runtimeResponses(),
    new Response(hungCancelBody(null), { status: 200 }),
    ...runtimeResponses(),
    chat({ proposalId: 'after-timeout', toolRequests: [] }),
  ], { timeoutMs: 1_000 });
  const abortStarted = Date.now();
  await assertAgentError(aborted.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'timeout');
  assert.ok(Date.now() - abortStarted < 2_000, 'timeout stays bounded despite a hung cancel');
  assert.equal(aborted.instance.busy, false);
  const later = await aborted.instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal((later as { proposal: { proposalId: string } }).proposal.proposalId, 'after-timeout');
});

test('a response that resolves after the deadline has its body cancelled without being awaited', async () => {
  let cancelled = false;
  const late = adapter([
    () => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(hungCancelBody(16, () => { cancelled = true; }), { status: 200 })), 1_200);
    }),
  ], { timeoutMs: 1_000 });
  await assertAgentError(late.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'timeout');
  assert.equal(late.instance.busy, false);
  await new Promise<void>((resolve) => { setTimeout(resolve, 400); });
  assert.equal(cancelled, true);
});

// --- file_edits output mode (G19.2) ---

/** Stands in for a host workspace root; it lives only in the test and must never reach a request. */
const HOST_ROOT_MARKER = 'host-only-workspace-root';
const MATH_BEFORE = '// math\nexport function add(a, b) {\n  return a - b;\n}\n';
const MATH_AFTER = '// math\nexport function add(a, b) {\n  return a + b;\n}\n';
const UTIL_BEFORE = 'export const one = 1;\n';
const UTIL_AFTER = 'export const one = 1;\nexport const two = 2;\n';

function staticReader(files: readonly OllamaContextFile[]) {
  const calls: Array<{ envelope: TaskEnvelopeV1; workspace: unknown }> = [];
  const reader: OllamaContextReader = async (input) => {
    calls.push(input);
    return files;
  };
  return { reader, calls };
}

function fileEditsAdapter(items: readonly QueueItem[], reader: OllamaContextReader, options: Omit<OllamaAgentAdapterOptions, 'fetcher'> = {}) {
  return adapter(items, { outputMode: 'file_edits', contextReader: reader, ...options });
}

function readerError(code: string): Error {
  return Object.assign(new Error(`context_reader_${code} at ${HOST_ROOT_MARKER}`), { name: 'ContextReaderError', code });
}

test('file_edits: a single-file edit becomes one apply_unified_diff proposal with the exact diff text', async () => {
  const { reader, calls } = staticReader([{ path: 'src/math.ts', text: MATH_BEFORE }]);
  const { instance, fetch, observed } = fileEditsAdapter(
    [...runtimeResponses(), chat({ proposalId: 'fe-1', edits: [{ path: 'src/math.ts', content: MATH_AFTER }] })],
    reader,
  );
  assert.equal(instance.outputMode, 'file_edits');
  const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.workspace, WORKSPACE);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(result, {
    kind: 'proposal',
    proposal: {
      proposalId: 'fe-1',
      toolRequests: [{
        operation: 'apply_unified_diff',
        diff: [
          'diff --git a/src/math.ts b/src/math.ts',
          '--- a/src/math.ts',
          '+++ b/src/math.ts',
          '@@ -1,4 +1,4 @@',
          ' // math',
          ' export function add(a, b) {',
          '-  return a - b;',
          '+  return a + b;',
          ' }',
          '',
        ].join('\n'),
      }],
    },
  });
  const proposal = (result as { proposal: Record<string, unknown> }).proposal;
  assert.ok(Object.isFrozen(proposal));
  assert.deepEqual(Object.keys(proposal).sort(), ['proposalId', 'toolRequests']);
  assert.equal(fetch.calls.length, 3);
  assert.equal(observed[0]?.outcome, 'proposal');
  assert.equal(observed[0]?.outputMode, 'file_edits');
});

test('file_edits: two edits produce one diff that parseAgentProposal accepts', async () => {
  const { reader } = staticReader([{ path: 'src/math.ts', text: MATH_BEFORE }, { path: 'src/util.ts', text: UTIL_BEFORE }]);
  const { instance } = fileEditsAdapter([...runtimeResponses(), chat({
    proposalId: 'fe-2',
    edits: [{ path: 'src/math.ts', content: MATH_AFTER }, { path: 'src/util.ts', content: UTIL_AFTER }],
  })], reader);
  const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(result.kind, 'proposal');
  const proposal = (result as { proposal: { proposalId: string; toolRequests: Array<{ operation: string; diff: string }> } }).proposal;
  assert.equal(proposal.toolRequests.length, 1);
  const diff = proposal.toolRequests[0]?.diff ?? '';
  assert.equal(proposal.toolRequests[0]?.operation, 'apply_unified_diff');
  assert.equal(diff.split('\n').filter((line) => line.startsWith('diff --git ')).length, 1);
  assert.ok(diff.startsWith('diff --git a/src/math.ts b/src/math.ts\n'));
  assert.ok(diff.endsWith('\n }\n--- a/src/util.ts\n+++ b/src/util.ts\n@@ -1,1 +1,2 @@\n export const one = 1;\n+export const two = 2;\n'));
  const reparsed = parseAgentProposal({ proposalId: proposal.proposalId, toolRequests: proposal.toolRequests });
  assert.deepEqual(reparsed.toolRequests, proposal.toolRequests);
});

test('file_edits: invalid edits are refused fail-closed', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }];
  const cases: Array<[string, unknown, string]> = [
    ['path outside the given files', { proposalId: 'p', edits: [{ path: 'src/other.ts', content: MATH_AFTER }] }, 'invalid_structured_output'],
    ['traversal path', { proposalId: 'p', edits: [{ path: '../src/math.ts', content: MATH_AFTER }] }, 'invalid_structured_output'],
    ['duplicate path', { proposalId: 'p', edits: [{ path: 'src/math.ts', content: MATH_AFTER }, { path: 'src/math.ts', content: MATH_AFTER }] }, 'invalid_structured_output'],
    ['extra key', { proposalId: 'p', edits: [], toolRequests: [] }, 'invalid_structured_output'],
    ['extra edit key', { proposalId: 'p', edits: [{ path: 'src/math.ts', content: MATH_AFTER, mode: 'create' }] }, 'invalid_structured_output'],
    ['non-string proposalId', { proposalId: 1, edits: [] }, 'invalid_structured_output'],
    ['three edits', { proposalId: 'p', edits: [1, 2, 3].map(() => ({ path: 'src/math.ts', content: MATH_AFTER })) }, 'invalid_structured_output'],
    ['bare CR in content', { proposalId: 'p', edits: [{ path: 'src/math.ts', content: MATH_AFTER.replace('a + b', 'a + b\rx') }] }, 'invalid_structured_output'],
    ['oversized content', { proposalId: 'p', edits: [{ path: 'src/math.ts', content: `${'x'.repeat(32_769)}\n` }] }, 'invalid_structured_output'],
    ['unchanged content', { proposalId: 'p', edits: [{ path: 'src/math.ts', content: MATH_BEFORE }] }, 'no_change_proposed'],
    ['no edits', { proposalId: 'p', edits: [] }, 'no_change_proposed'],
  ];
  for (const [label, content, reasonCode] of cases) {
    const responses = reasonCode === 'no_change_proposed'
      ? [...runtimeResponses(), chat(content), ...runtimeResponses(), chat(content)]
      : [...runtimeResponses(), chat(content)];
    const { instance, observed } = fileEditsAdapter(responses, staticReader(files).reader);
    const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
    assert.deepEqual(result, { kind: 'refusal', reasonCode }, label);
    assert.equal(observed[0]?.outcome, reasonCode, label);
  }
});

test('file_edits: an unchanged first answer gets exactly one retry that can succeed', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }];
  const { instance, observed } = fileEditsAdapter([
    ...runtimeResponses(), chat({ proposalId: 'p', edits: [{ path: 'src/math.ts', content: MATH_BEFORE }] }),
    ...runtimeResponses(), chat({ proposalId: 'p2', edits: [{ path: 'src/math.ts', content: MATH_AFTER }] }),
  ], staticReader(files).reader);
  const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(result.kind, 'proposal');
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.outcome, 'proposal');
});

test('file_edits: CRLF and a missing final newline in model content are normalized to the same proposal', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }];
  const run = async (content: string) => {
    const { instance } = fileEditsAdapter([...runtimeResponses(), chat({ proposalId: 'p', edits: [{ path: 'src/math.ts', content }] })], staticReader(files).reader);
    return instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  };
  const expected = await run(MATH_AFTER);
  assert.equal(expected.kind, 'proposal');
  for (const variant of [MATH_AFTER.slice(0, -1), MATH_AFTER.replaceAll('\n', '\r\n'), MATH_AFTER.replaceAll('\n', '\r\n').slice(0, -2)]) {
    assert.deepEqual(await run(variant), expected);
  }
});

test('file_edits: a given file with CR is refused as unsupported_text_format', async () => {
  const { reader } = staticReader([{ path: 'src/math.ts', text: MATH_BEFORE.replaceAll('\n', '\r\n') }]);
  const { instance } = fileEditsAdapter([...runtimeResponses(), chat({ proposalId: 'p', edits: [{ path: 'src/math.ts', content: MATH_AFTER }] })], reader);
  assertRefusal(await instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'unsupported_text_format');
});

test('file_edits: context over a limit is refused as context_overflow before any request', async () => {
  const cases: Array<[string, OllamaContextReader]> = [
    ['file over 16 KiB', staticReader([{ path: 'src/big.ts', text: `${'a'.repeat(16_384)}\n` }]).reader],
    ['total over 24 KiB', staticReader([
      { path: 'src/a.ts', text: `${'a'.repeat(12_999)}\n` },
      { path: 'src/b.ts', text: `${'b'.repeat(12_999)}\n` },
    ]).reader],
    ['reader file_too_large', async () => { throw readerError('file_too_large'); }],
    ['reader context_too_large', async () => { throw readerError('context_too_large'); }],
  ];
  for (const [label, reader] of cases) {
    const { instance, fetch, observed } = fileEditsAdapter([], reader);
    assertRefusal(await instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'context_overflow');
    assert.equal(fetch.calls.length, 0, label);
    assert.equal(observed[0]?.outcome, 'context_overflow', label);
    assert.equal(instance.busy, false);
  }

  // Within the byte limits but over the estimated token budget of a small context window.
  const tokens = fileEditsAdapter([], staticReader([{ path: 'src/mid.ts', text: `${'m'.repeat(4_000)}\n` }]).reader, { numCtx: 2_048, numPredict: 512 });
  assertRefusal(await tokens.instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'context_overflow');
  assert.equal(tokens.fetch.calls.length, 0);
});

test('file_edits: any other reader failure throws context_unavailable without a request', async () => {
  const cases: Array<[string, OllamaContextReader]> = [
    ['read_failed', async () => { throw readerError('read_failed'); }],
    ['too_many_files', async () => { throw readerError('too_many_files'); }],
    ['plain error', async () => { throw new Error('boom'); }],
    ['synchronous throw', (() => { throw new Error('sync'); }) as unknown as OllamaContextReader],
    ['not an array', (async () => ({ path: 'src/a.ts', text: 'a\n' })) as unknown as OllamaContextReader],
    ['unsafe path', staticReader([{ path: '../escape.ts', text: 'a\n' }]).reader],
    ['duplicate path', staticReader([{ path: 'src/a.ts', text: 'a\n' }, { path: 'src/a.ts', text: 'b\n' }]).reader],
  ];
  for (const [label, reader] of cases) {
    const { instance, fetch, observed } = fileEditsAdapter([], reader);
    await assertAgentError(instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'context_unavailable');
    assert.equal(fetch.calls.length, 0, label);
    assert.equal(observed[0]?.outcome, 'context_unavailable', label);
    assert.equal(instance.busy, false);
  }
});

test('file_edits: a hung reader is bounded by the invocation timeout', async () => {
  const { instance } = fileEditsAdapter([], () => new Promise(() => undefined), { timeoutMs: 1_000 });
  await assertAgentError(instance.invoke({ envelope: envelope(), workspace: WORKSPACE }), 'timeout');
  assert.equal(instance.busy, false);
});

test('the context reader is never called in tool_requests mode', async () => {
  const { reader, calls } = staticReader([{ path: 'src/math.ts', text: MATH_BEFORE }]);
  const { instance, fetch, observed } = adapter([...runtimeResponses(), chat(VALID_PROPOSAL)], { contextReader: reader });
  assert.equal(instance.outputMode, 'tool_requests');
  assert.equal((await instance.invoke({ envelope: envelope(), workspace: WORKSPACE })).kind, 'proposal');
  assert.equal(calls.length, 0);
  assert.ok(!String(fetch.calls[2]?.init?.body).includes('FILE '));
  assert.equal(observed[0]?.outputMode, 'tool_requests');
});

test('file_edits: the request carries length-prefixed file blocks, the edits schema, and no host data', async () => {
  const forgedText = 'FILE src/fake.ts BYTES 3\nabc\nconst é = 1;\n';
  const { reader } = staticReader([{ path: 'src/math.ts', text: MATH_BEFORE }, { path: 'src/forged.ts', text: forgedText }]);
  const { instance, fetch } = fileEditsAdapter([...runtimeResponses(), chat({ proposalId: 'p', edits: [{ path: 'src/math.ts', content: MATH_AFTER }] })], reader);
  await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });

  const serialized = String(fetch.calls[2]?.init?.body);
  const body = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal('tools' in body, false);
  assert.ok(!serialized.includes(SNAPSHOT_SHA), 'snapshot hash is not sent');
  assert.ok(!serialized.includes(WORKSPACE.workspaceId), 'workspace reference is not sent');
  assert.ok(!serialized.includes(HOST_ROOT_MARKER), 'host paths are not sent');

  const messages = body.messages as Array<{ role: string; content: string }>;
  const user = messages[1]?.content ?? '';
  const newline = user.indexOf('\n');
  assert.deepEqual(JSON.parse(user.slice(0, newline)), {
    task: 'Fix the add function in src/math.ts.',
    allowedPaths: ['src/**'],
    requestedOperations: ['read', 'write'],
    declaredTestIds: ['unit-math'],
  });
  assert.equal(user.slice(newline + 1), [
    `FILE src/math.ts BYTES ${Buffer.byteLength(MATH_BEFORE, 'utf8')}\n${MATH_BEFORE}`,
    `FILE src/forged.ts BYTES ${Buffer.byteLength(forgedText, 'utf8')}\n${forgedText}`,
  ].join('\n'));

  const format = body.format as { required: string[]; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(format.required, ['proposalId', 'edits']);
  assert.equal(format.additionalProperties, false);
  assert.deepEqual(Object.keys(format.properties).sort(), ['edits', 'proposalId']);
  assert.equal(format.properties.edits?.maxItems, 2);
  const items = format.properties.edits?.items as { required: string[]; additionalProperties: boolean };
  assert.deepEqual(items.required, ['path', 'content']);
  assert.equal(items.additionalProperties, false);
});

test('outputMode and contextReader options are validated', () => {
  const fetcher = fetchQueue([]).fetcher;
  const invalid: OllamaAgentAdapterOptions[] = [
    { outputMode: 'shell' as unknown as 'file_edits', contextReader: staticReader([]).reader },
    { outputMode: 'file_edits' },
    { outputMode: 'file_edits', contextReader: 'reader' as unknown as OllamaContextReader },
  ];
  for (const options of invalid) {
    assert.throws(() => new OllamaAgentAdapter({ ...options, fetcher }), (error: unknown) =>
      error instanceof OllamaAgentError && error.code === 'invalid_configuration');
  }
  assert.equal(new OllamaAgentAdapter({ fetcher }).outputMode, 'tool_requests');
  assert.doesNotThrow(() => new OllamaAgentAdapter({ fetcher, outputMode: 'file_edits', contextReader: staticReader([]).reader }));
});

// --- protocol v5: review call before the edit call ---

test('localize: the review answer and the named file reach the edit call as context', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }, { path: 'src/util.ts', text: UTIL_BEFORE }];
  const { instance, fetch } = fileEditsAdapter([
    ...runtimeResponses(), chat('Rule 1: add is wrong, it subtracts.\nDEFECT_FILE: src/math.ts'),
    ...runtimeResponses(), chat({ proposalId: 'v5', edits: [{ path: 'src/math.ts', content: MATH_AFTER }] }),
  ], staticReader(files).reader, { localize: 'trace' });
  const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(result.kind, 'proposal');
  const chats = fetch.calls.filter((call) => call.url.endsWith('/api/chat'));
  assert.equal(chats.length, 2);
  const review = JSON.parse(String(chats[0]?.init?.body)) as { messages: Array<{ content: string }>; format?: unknown };
  const edit = JSON.parse(String(chats[1]?.init?.body)) as { messages: Array<{ content: string }> };
  assert.equal(review.format, undefined);
  assert.match(review.messages[0]?.content ?? '', /DEFECT_FILE/);
  assert.doesNotMatch(edit.messages[1]?.content ?? '', /add is wrong, it subtracts/);
  assert.match(edit.messages[1]?.content ?? '', /The review found the defect in src\/math\.ts\. Answer with exactly one block, for src\/math\.ts, and no other file\./);
  assert.doesNotMatch(edit.messages[1]?.content ?? '', /DEFECT_FILE/);
});

test('localize: an unknown named file adds the analysis but names no file', () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }];
  assert.deepEqual(parseLocalization('looks wrong\nDEFECT_FILE: src/other.ts', files), { analysis: 'looks wrong', path: null });
  assert.deepEqual(parseLocalization('x\nDEFECT_FILE: `src/math.ts`', files), { analysis: 'x', path: 'src/math.ts' });
  assert.deepEqual(parseLocalization('no marker', files), { analysis: 'no marker', path: null });
});

test('buildLocalizationNote: null path gives the review prose, a path gives the pinned note', () => {
  assert.equal(
    buildLocalizationNote({ analysis: 'add subtracts', path: null }),
    '\nReview of the defect (from a separate review step):\nadd subtracts',
  );
  assert.equal(
    buildLocalizationNote({ analysis: 'ignored', path: 'src/math.ts' }),
    '\nThe review found the defect in src/math.ts. Answer with exactly one block, for src/math.ts, and no other file.',
  );
});

test('localize and temperature options are validated', () => {
  const fetcher = fetchQueue([]).fetcher;
  const base = { fetcher, outputMode: 'file_edits' as const, contextReader: staticReader([]).reader };
  assert.throws(() => new OllamaAgentAdapter({ ...base, localize: 'nope' as never }),
    (error: unknown) => error instanceof OllamaAgentError && error.code === 'invalid_configuration');
  for (const temperature of [-0.1, 1.5, Number.NaN, '0' as unknown as number]) {
    assert.throws(() => new OllamaAgentAdapter({ ...base, temperature }),
      (error: unknown) => error instanceof OllamaAgentError && error.code === 'invalid_configuration');
  }
  assert.doesNotThrow(() => new OllamaAgentAdapter({ ...base, localize: 'rules', temperature: 0.3 }));
});

test('verify: the checked answer replaces the first answer, and an unusable check keeps the first answer', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }];
  const wrong = MATH_AFTER.replace('a + b', 'a * b');
  const block = (text: string) => `<<<FILE src/math.ts\n${text}>>>END\n`;
  const run = async (second: string) => {
    const { instance, fetch } = fileEditsAdapter([
      ...runtimeResponses(), chat(block(wrong)),
      ...runtimeResponses(), chat(second),
    ], staticReader(files).reader, { answerFormat: 'blocks', verify: true });
    const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
    return { result, fetch };
  };
  const fixed = await run(block(MATH_AFTER));
  assert.equal(fixed.result.kind, 'proposal');
  const chats = fixed.fetch.calls.filter((call) => call.url.endsWith('/api/chat'));
  assert.equal(chats.length, 2);
  const verifyBody = JSON.parse(String(chats[1]?.init?.body)) as { messages: Array<{ content: string }> };
  assert.match(verifyBody.messages[1]?.content ?? '', /Proposed answer to check/);
  assert.match(verifyBody.messages[1]?.content ?? '', /a \* b/);
  const proposal = fixed.result.kind === 'proposal' ? JSON.stringify(fixed.result.proposal) : '';
  assert.match(proposal, /\+  return a \+ b;/);
  const kept = await run('not a block');
  assert.equal(kept.result.kind, 'proposal');
  assert.match(kept.result.kind === 'proposal' ? JSON.stringify(kept.result.proposal) : '', /a \* b/);
});

test('localize: an answer that changes a different file than the review named gets one retry on the named file', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }, { path: 'src/util.ts', text: UTIL_BEFORE }];
  const { instance, fetch } = fileEditsAdapter([
    ...runtimeResponses(), chat('add subtracts.\nDEFECT_FILE: src/math.ts'),
    ...runtimeResponses(), chat({ proposalId: 'wrong', edits: [{ path: 'src/util.ts', content: UTIL_AFTER }] }),
    ...runtimeResponses(), chat({ proposalId: 'right', edits: [{ path: 'src/math.ts', content: MATH_AFTER }] }),
  ], staticReader(files).reader, { localize: 'helpers' });
  const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(result.kind, 'proposal');
  assert.match(JSON.stringify(result.kind === 'proposal' ? result.proposal : {}), /src\/math\.ts/);
  const chats = fetch.calls.filter((call) => call.url.endsWith('/api/chat'));
  assert.equal(chats.length, 3);
  const retryBody = JSON.parse(String(chats[2]?.init?.body)) as { messages: Array<{ content: string }> };
  assert.match(retryBody.messages[1]?.content ?? '', /changed a different file\. The defect is in src\/math\.ts/);
});

test('localize: when the retry on the named file is unusable the first answer is kept', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }, { path: 'src/util.ts', text: UTIL_BEFORE }];
  const { instance } = fileEditsAdapter([
    ...runtimeResponses(), chat('DEFECT_FILE: src/math.ts'),
    ...runtimeResponses(), chat({ proposalId: 'wrong', edits: [{ path: 'src/util.ts', content: UTIL_AFTER }] }),
    ...runtimeResponses(), chat('garbage'),
  ], staticReader(files).reader, { localize: 'helpers' });
  const result = await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
  assert.equal(result.kind, 'proposal');
  assert.match(JSON.stringify(result.kind === 'proposal' ? result.proposal : {}), /src\/util\.ts/);
});

test('localize: when the review names no usable file its analysis is passed on instead', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }];
  const { instance, fetch } = fileEditsAdapter([
    ...runtimeResponses(), chat('add subtracts instead of adding.\nDEFECT_FILE: unknown.ts'),
    ...runtimeResponses(), chat({ proposalId: 'p', edits: [{ path: 'src/math.ts', content: MATH_AFTER }] }),
  ], staticReader(files).reader, { localize: 'helpers' });
  assert.equal((await instance.invoke({ envelope: envelope(), workspace: WORKSPACE })).kind, 'proposal');
  const chats = fetch.calls.filter((call) => call.url.endsWith('/api/chat'));
  const edit = JSON.parse(String(chats[1]?.init?.body)) as { messages: Array<{ content: string }> };
  assert.match(edit.messages[1]?.content ?? '', /add subtracts instead of adding/);
  assert.doesNotMatch(edit.messages[1]?.content ?? '', /The review found the defect in/);
});

test('keepAlive is sent on every chat call, defaults to 0s, and is validated', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }];
  const run = async (options: Omit<OllamaAgentAdapterOptions, 'fetcher'>) => {
    const { instance, fetch } = fileEditsAdapter([
      ...runtimeResponses(), chat({ proposalId: 'p', edits: [{ path: 'src/math.ts', content: MATH_AFTER }] }),
    ], staticReader(files).reader, options);
    await instance.invoke({ envelope: envelope(), workspace: WORKSPACE });
    const body = JSON.parse(String(fetch.calls.find((call) => call.url.endsWith('/api/chat'))?.init?.body)) as { keep_alive: string };
    return body.keep_alive;
  };
  assert.equal(await run({}), '0s');
  assert.equal(await run({ keepAlive: '10m' }), '10m');
  const fetcher = fetchQueue([]).fetcher;
  for (const bad of ['', '10', '-1m', '99999s', 'forever', '10m; x']) {
    assert.throws(() => new OllamaAgentAdapter({ fetcher, keepAlive: bad }),
      (error: unknown) => error instanceof OllamaAgentError && error.code === 'invalid_configuration', bad);
  }
});

test('voteLocalization picks the most named path and breaks ties by the earliest review', () => {
  assert.equal(voteLocalization(['a.mjs', 'b.mjs', 'b.mjs']), 'b.mjs');
  assert.equal(voteLocalization(['a.mjs', 'b.mjs', null]), 'a.mjs');
  assert.equal(voteLocalization([null, 'b.mjs', 'a.mjs']), 'b.mjs');
  assert.equal(voteLocalization([null, null]), null);
});

test('localize ensemble: three reviews are voted and the winner is pinned for the edit call', async () => {
  const files = [{ path: 'src/math.ts', text: MATH_BEFORE }, { path: 'src/util.ts', text: UTIL_BEFORE }];
  const { instance, fetch } = fileEditsAdapter([
    ...runtimeResponses(), chat('main looks wrong.\nDEFECT_FILE: src/util.ts'),
    ...runtimeResponses(), chat('add subtracts.\nDEFECT_FILE: src/math.ts'),
    ...runtimeResponses(), chat('add returns a-b.\nDEFECT_FILE: src/math.ts'),
    ...runtimeResponses(), chat({ proposalId: 'e', edits: [{ path: 'src/math.ts', content: MATH_AFTER }] }),
  ], staticReader(files).reader, { localize: 'ensemble' });
  assert.equal((await instance.invoke({ envelope: envelope(), workspace: WORKSPACE })).kind, 'proposal');
  const chats = fetch.calls.filter((call) => call.url.endsWith('/api/chat'));
  assert.equal(chats.length, 4);
  const edit = JSON.parse(String(chats[3]?.init?.body)) as { messages: Array<{ content: string }> };
  assert.match(edit.messages[1]?.content ?? '', /The review found the defect in src\/math\.ts\./);
});
