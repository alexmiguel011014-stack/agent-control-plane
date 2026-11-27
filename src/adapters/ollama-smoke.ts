import type { LocalRuntimeDiagnostic, LocalRuntimeSmoke, LocalRuntimeSmokeOutput, LocalRuntimeSmokePort } from '../application/ports/index.ts';

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DIAGNOSE_TIMEOUT_MS = 2_000;
const SMOKE_TIMEOUT_MS = 90_000;
const MAX_VERSION_BYTES = 4_096;
const MAX_TAGS_BYTES = 1_048_576;
const MAX_SMOKE_BYTES = 65_536;
const MAX_MODEL_COUNT = 4_096;
const MODEL_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const smokeOutputSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    schemaVersion: Object.freeze({ type: 'integer', const: 1 }),
    ready: Object.freeze({ type: 'boolean', const: true }),
    summary: Object.freeze({ type: 'string', const: 'local-smoke-ok' }),
  }),
  required: Object.freeze(['schemaVersion', 'ready', 'summary']),
  additionalProperties: false,
});

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type JsonRead =
  | Readonly<{ kind: 'ok'; value: unknown }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'timeout' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'too_large' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(value);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maxBytes) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function readJson(fetcher: FetchPort, path: string, timeoutMs: number, maxBytes: number, init?: RequestInit): Promise<JsonRead> {
  let response: Response;
  try {
    response = await fetcher(`${OLLAMA_BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    if (isTimeout(error)) return Object.freeze({ kind: 'timeout' });
    return Object.freeze({ kind: 'unavailable' });
  }
  if (!response.ok) return Object.freeze({ kind: 'unavailable' });
  let text: string | null;
  try {
    text = await readBoundedText(response, maxBytes);
  } catch (error) {
    if (isTimeout(error)) return Object.freeze({ kind: 'timeout' });
    return Object.freeze({ kind: 'unavailable' });
  }
  if (text === null) return Object.freeze({ kind: 'too_large' });
  try {
    return Object.freeze({ kind: 'ok', value: JSON.parse(text) as unknown });
  } catch {
    return Object.freeze({ kind: 'invalid' });
  }
}

function parseDiagnostic(versionValue: unknown, tagsValue: unknown, modelTag: string): LocalRuntimeDiagnostic {
  if (!isRecord(versionValue) || !safeVersion(versionValue.version)) {
    return Object.freeze({ status: 'invalid_runtime_response', modelTag });
  }
  if (!isRecord(tagsValue) || !Array.isArray(tagsValue.models) || tagsValue.models.length > MAX_MODEL_COUNT) {
    return Object.freeze({ status: 'invalid_runtime_response', modelTag });
  }
  const model = tagsValue.models.find((entry) => isRecord(entry) && entry.name === modelTag);
  if (!model) return Object.freeze({ status: 'model_missing', runtimeVersion: versionValue.version, modelTag });
  if (!isRecord(model) || typeof model.digest !== 'string' || !MODEL_DIGEST_PATTERN.test(model.digest)) {
    return Object.freeze({ status: 'invalid_runtime_response', modelTag });
  }
  return Object.freeze({ status: 'ready', runtimeVersion: versionValue.version, modelTag, modelDigest: model.digest });
}

function parseSmokeResponse(value: unknown, modelTag: string): LocalRuntimeSmokeOutput | null {
  if (!isRecord(value) || value.model !== modelTag || value.done !== true || !isRecord(value.message)
    || value.message.role !== 'assistant' || typeof value.message.content !== 'string'
    || Buffer.byteLength(value.message.content, 'utf8') > 1_024) return null;
  if ('tool_calls' in value.message && value.message.tool_calls !== undefined && value.message.tool_calls !== null
    && (!Array.isArray(value.message.tool_calls) || value.message.tool_calls.length > 0)) return null;
  let content: unknown;
  try {
    content = JSON.parse(value.message.content) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(content)
    || Object.keys(content).length !== 3
    || content.schemaVersion !== 1
    || content.ready !== true
    || content.summary !== 'local-smoke-ok') return null;
  return Object.freeze({ schemaVersion: 1, ready: true, summary: 'local-smoke-ok' });
}

/** G2.1 read-only probe. It never starts Ollama, downloads models, or submits tools. */
export class OllamaReadOnlySmokeAdapter implements LocalRuntimeSmokePort {
  readonly #fetch: FetchPort;

  constructor(fetcher: FetchPort = globalThis.fetch) {
    this.#fetch = fetcher;
  }

  async diagnose(modelTag: string): Promise<LocalRuntimeDiagnostic> {
    const version = await readJson(this.#fetch, '/api/version', DIAGNOSE_TIMEOUT_MS, MAX_VERSION_BYTES);
    if (version.kind === 'unavailable' || version.kind === 'timeout') return Object.freeze({ status: 'runtime_unavailable', modelTag });
    if (version.kind !== 'ok') return Object.freeze({ status: 'invalid_runtime_response', modelTag });
    const tags = await readJson(this.#fetch, '/api/tags', DIAGNOSE_TIMEOUT_MS, MAX_TAGS_BYTES);
    if (tags.kind === 'unavailable' || tags.kind === 'timeout') return Object.freeze({ status: 'runtime_unavailable', modelTag });
    if (tags.kind !== 'ok') return Object.freeze({ status: 'invalid_runtime_response', modelTag });
    return parseDiagnostic(version.value, tags.value, modelTag);
  }

  async smoke(modelTag: string): Promise<LocalRuntimeSmoke> {
    const diagnostic = await this.diagnose(modelTag);
    if (diagnostic.status !== 'ready') {
      return Object.freeze({ status: 'blocked', reasonCode: diagnostic.status, modelTag });
    }

    const requestBody = Object.freeze({
      model: modelTag,
      messages: Object.freeze([
        Object.freeze({ role: 'system', content: 'Return only the JSON object required by the schema. This is a read-only runtime check; do not request tools or produce code.' }),
        Object.freeze({ role: 'user', content: 'Return the required readiness object.' }),
      ]),
      stream: false,
      format: smokeOutputSchema,
      options: Object.freeze({ temperature: 0, num_ctx: 2_048, num_predict: 64 }),
      keep_alive: '0s',
    });

    const response = await readJson(this.#fetch, '/api/chat', SMOKE_TIMEOUT_MS, MAX_SMOKE_BYTES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (response.kind === 'timeout') return Object.freeze({ status: 'failed', reasonCode: 'timeout', modelTag });
    if (response.kind === 'unavailable') {
      return Object.freeze({ status: 'failed', reasonCode: 'runtime_request_failed', modelTag });
    }
    if (response.kind === 'too_large' || response.kind === 'invalid') {
      return Object.freeze({ status: 'failed', reasonCode: 'invalid_structured_output', modelTag });
    }
    const output = parseSmokeResponse(response.value, modelTag);
    if (!output) return Object.freeze({ status: 'failed', reasonCode: 'invalid_structured_output', modelTag });
    return Object.freeze({
      status: 'passed',
      runtimeVersion: diagnostic.runtimeVersion,
      modelTag,
      modelDigest: diagnostic.modelDigest,
      output,
    });
  }
}
