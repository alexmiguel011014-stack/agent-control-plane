import type { ApprovalGrantV1 } from '../domain/policy.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';
import { isLegacyWorkspaceTest } from '../domain/tools.ts';
import {
  TOOL_OPERATIONS,
  TOOL_REQUEST_LIMITS,
  type ToolRequest,
  type ToolResponse,
  type UnifiedDiffFilePlan,
  type UnifiedDiffPlan,
} from '../domain/tools.ts';
import type {
  AgentProposal,
  ClockPort,
  DeclaredTestRegistryPort,
  DeclaredTestRunnerPort,
  GeneratedCodeExecutionGatePort,
  PolicyEvaluatorPort,
  ToolExecutionPort,
  UnifiedDiffApplicationPort,
  WorkspacePathAccessPort,
  WorkspacePathReference,
  WorkspaceReference,
} from '../application/ports/index.ts';
import { assertSnapshotPath } from '../snapshots/snapshot-core.mjs';

export type ToolGatewayErrorCode =
  | 'invalid_tool_request'
  | 'tool_policy_denied'
  | 'approval_required'
  | 'g2_isolation_required'
  | 'tool_unavailable'
  | 'tool_output_too_large';

export class ToolGatewayError extends Error {
  readonly code: ToolGatewayErrorCode;

  constructor(code: ToolGatewayErrorCode) {
    super(code);
    this.name = 'ToolGatewayError';
    this.code = code;
  }
}

export interface ToolGatewayContext {
  readonly envelope: TaskEnvelopeV1;
  readonly envelopeSha256: string;
  readonly approval?: ApprovalGrantV1;
  readonly workspace: WorkspaceReference;
}

export interface ToolGatewayDependencies {
  readonly paths: WorkspacePathAccessPort;
  readonly policy: PolicyEvaluatorPort;
  readonly clock: ClockPort;
  /** There is intentionally no implementation before G2.2 passes. */
  readonly generatedCodeGate?: GeneratedCodeExecutionGatePort;
  readonly patches?: UnifiedDiffApplicationPort;
  readonly testRegistry: DeclaredTestRegistryPort;
  readonly testRunner?: DeclaredTestRunnerPort;
}

const TOOL_OPERATION_SET = new Set<string>(TOOL_OPERATIONS);
const TEST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_PATHS_PER_DIFF = TOOL_REQUEST_LIMITS.maxDiffFiles;

function fail(): never {
  throw new ToolGatewayError('invalid_tool_request');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function validPath(value: unknown, allowGlob = false): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > TOOL_REQUEST_LIMITS.maxPathLength) return false;
  try {
    if (allowGlob && value.includes('*')) {
      const parts = value.split('/');
      if (parts.some((part) => part.length === 0 || part.startsWith(' ') || part.endsWith(' ') || part.endsWith('.'))) return false;
      for (const part of parts) assertSnapshotPath(part.replaceAll('*', 'x'));
      return !value.includes('\\') && !value.includes(':') && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value);
    }
    assertSnapshotPath(value);
    return !value.includes('*');
  } catch {
    return false;
  }
}

/** Strict JSON boundary: no shell strings, extra keys, or implicit coercions. */
export function parseToolRequest(input: unknown): ToolRequest {
  if (!isRecord(input) || typeof input.operation !== 'string' || !TOOL_OPERATION_SET.has(input.operation)) return fail();
  switch (input.operation) {
    case 'read_text':
      if (!exactKeys(input, ['operation', 'path']) || !validPath(input.path)) return fail();
      return Object.freeze({ operation: 'read_text', path: input.path });
    case 'list_files':
      if (!exactKeys(input, ['operation'], ['path']) || (input.path !== undefined && !validPath(input.path))) return fail();
      return Object.freeze({ operation: 'list_files', ...(input.path === undefined ? {} : { path: input.path }) });
    case 'apply_unified_diff':
      if (!exactKeys(input, ['operation', 'diff']) || typeof input.diff !== 'string'
        || Buffer.byteLength(input.diff, 'utf8') > TOOL_REQUEST_LIMITS.maxDiffBytes) return fail();
      parseUnifiedDiff(input.diff);
      return Object.freeze({ operation: 'apply_unified_diff', diff: input.diff });
    case 'run_declared_test':
      if (!exactKeys(input, ['operation', 'testId']) || typeof input.testId !== 'string'
        || !TEST_ID_PATTERN.test(input.testId) || input.testId.length > TOOL_REQUEST_LIMITS.maxTestIdLength) return fail();
      return Object.freeze({ operation: 'run_declared_test', testId: input.testId });
    case 'git_diff':
      if (!exactKeys(input, ['operation'], ['paths'])) return fail();
      if (input.paths === undefined) return Object.freeze({ operation: 'git_diff' });
      if (!Array.isArray(input.paths) || input.paths.length > MAX_PATHS_PER_DIFF
        || input.paths.some((relativePath) => !validPath(relativePath))
        || new Set(input.paths).size !== input.paths.length) return fail();
      return Object.freeze({ operation: 'git_diff', paths: Object.freeze([...input.paths] as string[]) });
  }
  return fail();
}

/** Parses a deliberately small unified-diff subset without writing files. */
export function parseUnifiedDiff(value: string): UnifiedDiffPlan {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') === 0
    || Buffer.byteLength(value, 'utf8') > TOOL_REQUEST_LIMITS.maxDiffBytes || value.includes('\0')) return fail();
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length > TOOL_REQUEST_LIMITS.maxDiffLines) return fail();
  const files: UnifiedDiffFilePlan[] = [];
  let index = 0;

  while (index < lines.length) {
    let gitHeader: { oldPath: string; newPath: string } | undefined;
    if (lines[index]?.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[index]!);
      if (!match || match[1] !== match[2]) return fail();
      gitHeader = { oldPath: match[1]!, newPath: match[2]! };
      index += 1;
    }
    const oldHeader = /^--- (.+)$/.exec(lines[index] ?? '');
    const newHeader = /^\+\+\+ (.+)$/.exec(lines[index + 1] ?? '');
    if (!oldHeader || !newHeader) return fail();
    index += 2;
    const oldPath = oldHeader[1] === '/dev/null' ? null : parseDiffPath(oldHeader[1]!, 'a/');
    const newPath = newHeader[1] === '/dev/null' ? null : parseDiffPath(newHeader[1]!, 'b/');
    if (newPath === null || (oldPath !== null && oldPath !== newPath)
      || (gitHeader && (oldPath !== gitHeader.oldPath || newPath !== gitHeader.newPath))) return fail();
    const target = newPath;
    if (!validPath(target) || files.some((file) => file.path === target)) return fail();

    const hunkLines: string[] = [];
    let sawHunk = false;
    while (index < lines.length && !lines[index]!.startsWith('--- ')) {
      const hunkHeader = lines[index]!;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(hunkHeader);
      if (!match) return fail();
      sawHunk = true;
      const expectedOld = match[2] === undefined ? 1 : Number(match[2]);
      const expectedNew = match[4] === undefined ? 1 : Number(match[4]);
      if (![expectedOld, expectedNew].every((count) => Number.isSafeInteger(count) && count >= 0)) return fail();
      hunkLines.push(hunkHeader);
      index += 1;
      let consumedOld = 0;
      let consumedNew = 0;
      while (consumedOld < expectedOld || consumedNew < expectedNew) {
        if (index >= lines.length) return fail();
        const line = lines[index]!;
        if (line.startsWith(' ')) {
          consumedOld += 1;
          consumedNew += 1;
          hunkLines.push(line);
        } else if (line.startsWith('-')) {
          consumedOld += 1;
          hunkLines.push(line);
        } else if (line.startsWith('+')) {
          consumedNew += 1;
          hunkLines.push(line);
        } else {
          return fail();
        }
        index += 1;
      }
      if (consumedOld !== expectedOld || consumedNew !== expectedNew) return fail();
      while (lines[index] === '\\ No newline at end of file') {
        hunkLines.push(lines[index]!);
        index += 1;
      }
    }
    if (!sawHunk) return fail();
    files.push(Object.freeze({
      path: target,
      mode: oldPath === null ? 'create' : 'modify',
      hunkLines: Object.freeze(hunkLines),
    }));
    if (files.length > TOOL_REQUEST_LIMITS.maxDiffFiles) return fail();
  }
  if (files.length === 0) return fail();
  return Object.freeze({ files: Object.freeze(files), changedPaths: Object.freeze(files.map((file) => file.path)) });
}

function parseDiffPath(value: string, prefix: 'a/' | 'b/'): string | null {
  if (!value.startsWith(prefix)) return null;
  const relativePath = value.slice(prefix.length);
  return validPath(relativePath) ? relativePath : null;
}

function patternMatches(relativePath: string, pattern: string): boolean {
  const concrete = relativePath.split('/');
  const parts = pattern.split('/');
  const memo = new Map<string, boolean>();
  const match = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${pathIndex}:${patternIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (patternIndex === parts.length) result = pathIndex === concrete.length;
    else if (parts[patternIndex] === '**') {
      result = match(pathIndex, patternIndex + 1)
        || (pathIndex < concrete.length && match(pathIndex + 1, patternIndex));
    } else if (pathIndex >= concrete.length) result = false;
    else {
      const segment = parts[patternIndex]!;
      const segmentPattern = new RegExp(`^${segment.split('*').map(escapeRegExp).join('[^/]*')}$`, 'i');
      result = segmentPattern.test(concrete[pathIndex]!) && match(pathIndex + 1, patternIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedToolRequestKey(request: ToolRequest): string {
  switch (request.operation) {
    case 'read_text':
      return JSON.stringify({ operation: request.operation, path: request.path.toLowerCase() });
    case 'list_files':
      return JSON.stringify({ operation: request.operation, path: request.path?.toLowerCase() ?? null });
    case 'apply_unified_diff': {
      const files = parseUnifiedDiff(request.diff).files.map((file) => ({
        path: file.path.toLowerCase(),
        mode: file.mode,
        hunkLines: file.hunkLines,
      })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      return JSON.stringify({ operation: request.operation, files });
    }
    case 'run_declared_test':
      return JSON.stringify({ operation: request.operation, testId: request.testId });
    case 'git_diff':
      return JSON.stringify({
        operation: request.operation,
        paths: request.paths?.map((relativePath) => relativePath.toLowerCase()).sort() ?? null,
      });
  }
}

/** Validates every agent request before any tool is allowed to have an effect. */
export function parseAgentProposal(input: unknown): AgentProposal {
  if (!isRecord(input)
    || !exactKeys(input, ['proposalId', 'toolRequests'])
    || typeof input.proposalId !== 'string'
    || input.proposalId.length === 0 || input.proposalId.length > 128
    || !Array.isArray(input.toolRequests)
    || input.toolRequests.length > TOOL_REQUEST_LIMITS.maxRequests) {
    return fail();
  }
  const requests = input.toolRequests.map(parseToolRequest);
  const identities = new Set<string>();
  for (const request of requests) {
    const identity = normalizedToolRequestKey(request);
    if (identities.has(identity)) return fail();
    identities.add(identity);
  }
  return Object.freeze({
    proposalId: input.proposalId,
    toolRequests: Object.freeze(requests),
  });
}

export class ClosedToolGateway implements ToolExecutionPort {
  readonly #paths: WorkspacePathAccessPort;
  readonly #policy: PolicyEvaluatorPort;
  readonly #clock: ClockPort;
  readonly #generatedCodeGate: GeneratedCodeExecutionGatePort | undefined;
  readonly #patches: UnifiedDiffApplicationPort | undefined;
  readonly #testRegistry: DeclaredTestRegistryPort;
  readonly #testRunner: DeclaredTestRunnerPort | undefined;

  constructor(dependencies: ToolGatewayDependencies) {
    this.#paths = dependencies.paths;
    this.#policy = dependencies.policy;
    this.#clock = dependencies.clock;
    this.#generatedCodeGate = dependencies.generatedCodeGate;
    this.#patches = dependencies.patches;
    this.#testRegistry = dependencies.testRegistry;
    this.#testRunner = dependencies.testRunner;
  }

  async execute(input: {
    readonly envelope: TaskEnvelopeV1;
    readonly envelopeSha256: string;
    readonly approval?: ApprovalGrantV1;
    readonly workspace: WorkspaceReference;
    readonly proposal: unknown;
  }): Promise<readonly ToolResponse[]> {
    const proposal = parseAgentProposal(input.proposal);
    const responses: ToolResponse[] = [];
    for (const request of proposal.toolRequests) {
      responses.push(await this.executeRequest({
        envelope: input.envelope,
        envelopeSha256: input.envelopeSha256,
        ...(input.approval === undefined ? {} : { approval: input.approval }),
        workspace: input.workspace,
      }, request));
    }
    return Object.freeze(responses);
  }

  async executeRequest(context: ToolGatewayContext, rawRequest: unknown): Promise<ToolResponse> {
    const request = parseToolRequest(rawRequest);
    switch (request.operation) {
      case 'read_text': {
        await this.#authorize(context, 'read');
        const text = await this.#paths.readText({
          workspace: context.workspace,
          relativePath: request.path,
          allowedPatterns: context.envelope.allowedPaths,
          maxBytes: TOOL_REQUEST_LIMITS.maxReadBytes,
        });
        if (Buffer.byteLength(text, 'utf8') > TOOL_REQUEST_LIMITS.maxReadBytes) throw new ToolGatewayError('tool_output_too_large');
        return Object.freeze({ operation: 'read_text', path: request.path, text });
      }
      case 'list_files': {
        await this.#authorize(context, 'read');
        if (request.path !== undefined && !validPath(request.path)) return fail();
        const listed = await this.#paths.listAllowed({
          workspace: context.workspace,
          allowedPatterns: context.envelope.allowedPaths,
          maxResults: TOOL_REQUEST_LIMITS.maxListedFiles,
          ...(request.path === undefined ? {} : { prefix: request.path }),
        });
        if (listed.length > TOOL_REQUEST_LIMITS.maxListedFiles) throw new ToolGatewayError('tool_output_too_large');
        const paths: string[] = [];
        for (const relativePath of listed) {
          const requestedPrefix = request.path?.toLowerCase();
          const candidate = relativePath.toLowerCase();
          if (!validPath(relativePath) || (requestedPrefix !== undefined
            && candidate !== requestedPrefix && !candidate.startsWith(`${requestedPrefix}/`))) continue;
          const reference = await this.#paths.resolveAllowed({
            workspace: context.workspace,
            relativePath,
            operation: 'read',
            allowedPatterns: context.envelope.allowedPaths,
          });
          if (reference) paths.push(reference.relativePath);
          if (paths.length > TOOL_REQUEST_LIMITS.maxListedFiles) throw new ToolGatewayError('tool_output_too_large');
        }
        return Object.freeze({ operation: 'list_files', paths: Object.freeze(paths) });
      }
      case 'apply_unified_diff': {
        const plan = parseUnifiedDiff(request.diff);
        if (plan.changedPaths.some((relativePath) => context.envelope.declaredTests.some((test) =>
          isLegacyWorkspaceTest(test) && test.path.toLowerCase() === relativePath.toLowerCase()))) {
          throw new ToolGatewayError('tool_policy_denied');
        }
        await this.#authorize(context, 'write');
        await this.#resolvePaths(context, plan.changedPaths, 'write');
        if (!await this.#generatedCodeGate?.isOpen()) throw new ToolGatewayError('g2_isolation_required');
        if (!this.#patches) throw new ToolGatewayError('tool_unavailable');
        const revalidated = await this.#resolvePaths(context, plan.changedPaths, 'write');
        await this.#authorize(context, 'write');
        await this.#patches.apply({ workspace: context.workspace, plan, paths: revalidated });
        return Object.freeze({ operation: 'apply_unified_diff', changedPaths: plan.changedPaths });
      }
      case 'run_declared_test': {
        const declaration = context.envelope.declaredTests.find((test) => test.id === request.testId);
        if (!declaration || declaration.profile !== 'host-json-v1'
          || !this.#testRegistry.isRegistered(declaration.id)) return fail();
        await this.#authorize(context, 'process');
        if (!await this.#generatedCodeGate?.isOpen()) throw new ToolGatewayError('g2_isolation_required');
        if (!this.#testRunner) throw new ToolGatewayError('tool_unavailable');
        await this.#authorize(context, 'process');
        const result = await this.#testRunner.run({
          workspace: context.workspace,
          testId: declaration.id,
          timeoutMs: TOOL_REQUEST_LIMITS.declaredTestTimeoutMs,
        });
        return Object.freeze({ operation: 'run_declared_test', testId: declaration.id, outcome: result.passed ? 'PASS' : 'FAIL' });
      }
      case 'git_diff': {
        await this.#authorize(context, 'read');
        if (request.paths) {
          for (const relativePath of request.paths) {
            if (!context.envelope.allowedPaths.some((pattern) => patternMatches(relativePath, pattern))) {
              throw new ToolGatewayError('tool_policy_denied');
            }
            const reference = await this.#paths.resolveAllowed({
              workspace: context.workspace,
              relativePath,
              operation: 'diff',
              allowedPatterns: context.envelope.allowedPaths,
            });
            if (!reference) throw new ToolGatewayError('tool_policy_denied');
          }
        }
        const diff = await this.#paths.gitDiff({
          workspace: context.workspace,
          allowedPatterns: context.envelope.allowedPaths,
          ...(request.paths === undefined ? {} : { relativePaths: request.paths }),
          maxOutputBytes: TOOL_REQUEST_LIMITS.maxDiffOutputBytes,
        });
        if (Buffer.byteLength(diff, 'utf8') > TOOL_REQUEST_LIMITS.maxDiffOutputBytes) throw new ToolGatewayError('tool_output_too_large');
        return Object.freeze({ operation: 'git_diff', diff });
      }
    }
    return fail();
  }

  async #resolvePaths(
    context: ToolGatewayContext,
    relativePaths: readonly string[],
    operation: 'write',
  ): Promise<readonly WorkspacePathReference[]> {
    const references: WorkspacePathReference[] = [];
    for (const relativePath of relativePaths) {
      if (!validPath(relativePath) || !context.envelope.allowedPaths.some((pattern) => patternMatches(relativePath, pattern))) {
        throw new ToolGatewayError('tool_policy_denied');
      }
      const reference = await this.#paths.resolveAllowed({
        workspace: context.workspace,
        relativePath,
        operation,
        allowedPatterns: context.envelope.allowedPaths,
      });
      if (!reference) throw new ToolGatewayError('tool_policy_denied');
      references.push(reference);
    }
    return Object.freeze(references);
  }

  async #authorize(context: ToolGatewayContext, requiredOperation: 'read' | 'write' | 'process'): Promise<void> {
    if (!context.envelope.requestedOperations.includes(requiredOperation)) throw new ToolGatewayError('tool_policy_denied');
    const decision = await this.#policy.evaluate({
      envelope: context.envelope,
      envelopeSha256: context.envelopeSha256,
      ...(context.approval === undefined ? {} : { approval: context.approval }),
      now: this.#clock.now(),
    });
    if (decision.outcome === 'requires_approval') throw new ToolGatewayError('approval_required');
    if (decision.outcome !== 'allow') throw new ToolGatewayError('tool_policy_denied');
  }
}
