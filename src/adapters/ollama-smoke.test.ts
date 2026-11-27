import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaReadOnlySmokeAdapter } from './ollama-smoke.ts';

const MODEL_TAG = 'qwen2.5-coder:1.5b';
const MODEL_DIGEST = 'a'.repeat(64);
const OUTPUT = { schemaVersion: 1, ready: true, summary: 'local-smoke-ok' };

function response(value: unknown): Response {
  return Response.json(value);
}

function fetchQueue(items: readonly (Response | Error)[]) {
  const queue = [...items];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error('unexpected_local_request');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetcher, calls };
}

function diagnosisResponses(): Response[] {
  return [
    response({ version: '0.12.0' }),
    response({ models: [{ name: MODEL_TAG, digest: MODEL_DIGEST }] }),
  ];
}

test('Ollama read-only smoke uses only fixed loopback endpoints and bounded no-tool JSON', async () => {
  const fetch = fetchQueue([
    ...diagnosisResponses(),
    response({ model: MODEL_TAG, done: true, message: { role: 'assistant', content: JSON.stringify(OUTPUT) } }),
  ]);
  const adapter = new OllamaReadOnlySmokeAdapter(fetch.fetcher);
  assert.equal(fetch.calls.length, 0, 'construction does not contact Ollama');

  const result = await adapter.smoke(MODEL_TAG);
  assert.deepEqual(result, {
    status: 'passed',
    runtimeVersion: '0.12.0',
    modelTag: MODEL_TAG,
    modelDigest: MODEL_DIGEST,
    output: OUTPUT,
  });
  assert.deepEqual(fetch.calls.map((call) => call.url), [
    'http://127.0.0.1:11434/api/version',
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:11434/api/chat',
  ]);
  assert.ok(fetch.calls.every((call) => call.init?.redirect === 'error'));
  const request = JSON.parse(String(fetch.calls[2]?.init?.body)) as Record<string, unknown>;
  assert.equal(request.model, MODEL_TAG);
  assert.equal(request.stream, false);
  assert.equal(request.keep_alive, '0s');
  assert.equal('tools' in request, false);
  assert.deepEqual(request.options, { temperature: 0, num_ctx: 2_048, num_predict: 64 });
  assert.ok(typeof request.format === 'object' && request.format !== null);
});

test('diagnose reports a missing model and smoke never attempts inference or downloads', async () => {
  const fetch = fetchQueue([
    response({ version: '0.12.0' }),
    response({ models: [] }),
    ...diagnosisResponses().slice(0, 1),
    response({ models: [] }),
  ]);
  const adapter = new OllamaReadOnlySmokeAdapter(fetch.fetcher);
  assert.deepEqual(await adapter.diagnose(MODEL_TAG), { status: 'model_missing', runtimeVersion: '0.12.0', modelTag: MODEL_TAG });
  assert.deepEqual(await adapter.smoke(MODEL_TAG), { status: 'blocked', reasonCode: 'model_missing', modelTag: MODEL_TAG });
  assert.equal(fetch.calls.length, 4);
  assert.ok(fetch.calls.every((call) => !call.url.endsWith('/api/pull')));
});

test('a runtime redirect is rejected without issuing a request to its location', async () => {
  const fetch = fetchQueue([new Response(null, {
    status: 302,
    headers: { location: 'https://example.invalid/api/version' },
  })]);
  const result = await new OllamaReadOnlySmokeAdapter(fetch.fetcher).diagnose(MODEL_TAG);
  assert.deepEqual(result, { status: 'runtime_unavailable', modelTag: MODEL_TAG });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0]?.url, 'http://127.0.0.1:11434/api/version');
  assert.equal(fetch.calls[0]?.init?.redirect, 'error');
});

test('smoke rejects malformed output and any model tool call without exposing raw content', async () => {
  const fetch = fetchQueue([
    ...diagnosisResponses(),
    response({ model: MODEL_TAG, done: true, message: { role: 'assistant', content: JSON.stringify({ ...OUTPUT, extra: 'secret' }), tool_calls: [{ function: { name: 'run' } }] } }),
  ]);
  const result = await new OllamaReadOnlySmokeAdapter(fetch.fetcher).smoke(MODEL_TAG);
  assert.deepEqual(result, { status: 'failed', reasonCode: 'invalid_structured_output', modelTag: MODEL_TAG });
  assert.doesNotMatch(JSON.stringify(result), /secret|run/);
});

test('smoke rejects an oversized response body without returning its content', async () => {
  const fetch = fetchQueue([
    ...diagnosisResponses(),
    response({ model: MODEL_TAG, done: true, message: { role: 'assistant', content: 'x'.repeat(70_000) } }),
  ]);
  const result = await new OllamaReadOnlySmokeAdapter(fetch.fetcher).smoke(MODEL_TAG);
  assert.deepEqual(result, { status: 'failed', reasonCode: 'invalid_structured_output', modelTag: MODEL_TAG });
  assert.ok(JSON.stringify(result).length < 200);
});

test('smoke maps a bounded timeout to a redacted failure', async () => {
  const fetch = fetchQueue([
    ...diagnosisResponses(),
    new DOMException('request timed out', 'TimeoutError'),
  ]);
  const result = await new OllamaReadOnlySmokeAdapter(fetch.fetcher).smoke(MODEL_TAG);
  assert.deepEqual(result, { status: 'failed', reasonCode: 'timeout', modelTag: MODEL_TAG });
});

test('smoke maps a body-read timeout to a redacted failure', async () => {
  const timedOutBody = new Response(new ReadableStream({
    start(controller) {
      controller.error(new DOMException('request timed out', 'TimeoutError'));
    },
  }));
  const fetch = fetchQueue([...diagnosisResponses(), timedOutBody]);
  const result = await new OllamaReadOnlySmokeAdapter(fetch.fetcher).smoke(MODEL_TAG);
  assert.deepEqual(result, { status: 'failed', reasonCode: 'timeout', modelTag: MODEL_TAG });
});

test('diagnosis uses no inference request and rejects malformed runtime provenance', async () => {
  const fetch = fetchQueue([response({ version: '0.12.0' }), response({ models: [{ name: MODEL_TAG, digest: 'bad-digest' }] })]);
  const result = await new OllamaReadOnlySmokeAdapter(fetch.fetcher).diagnose(MODEL_TAG);
  assert.deepEqual(result, { status: 'invalid_runtime_response', modelTag: MODEL_TAG });
  assert.equal(fetch.calls.length, 2);
  assert.ok(fetch.calls.every((call) => !call.url.endsWith('/api/chat')));
});

test('diagnosis treats a model-tag request timeout as runtime unavailable', async () => {
  const fetch = fetchQueue([response({ version: '0.12.0' }), new DOMException('request timed out', 'TimeoutError')]);
  const result = await new OllamaReadOnlySmokeAdapter(fetch.fetcher).diagnose(MODEL_TAG);
  assert.deepEqual(result, { status: 'runtime_unavailable', modelTag: MODEL_TAG });
});
