import type { WorkspacePathAccessPort, WorkspaceReference } from '../application/ports/index.ts';
import type { TaskEnvelopeV1 } from '../domain/task.ts';

export type ContextReaderErrorCode = 'too_many_files' | 'file_too_large' | 'context_too_large' | 'read_failed';

export class ContextReaderError extends Error {
  readonly code: ContextReaderErrorCode;

  constructor(code: ContextReaderErrorCode) {
    super(code);
    this.name = 'ContextReaderError';
    this.code = code;
  }
}

export interface ContextFile {
  readonly path: string;
  readonly text: string;
}

export interface WorkspaceContextReaderLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_CONTEXT_READER_LIMITS: WorkspaceContextReaderLimits = Object.freeze({
  maxFiles: 64,
  maxFileBytes: 16_384,
  maxTotalBytes: 24_576
});

const CONTEXT_EXTENSIONS = ['.mjs', '.js', '.ts', '.json'] as const;

export type WorkspaceContextReader = (input: {
  readonly envelope: TaskEnvelopeV1;
  readonly workspace: WorkspaceReference;
}) => Promise<readonly ContextFile[]>;

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createWorkspaceContextReader(
  paths: WorkspacePathAccessPort,
  limits: WorkspaceContextReaderLimits = DEFAULT_CONTEXT_READER_LIMITS
): WorkspaceContextReader {
  return async ({ envelope, workspace }) => {
    let listed: readonly string[];
    try {
      listed = await paths.listAllowed({
        workspace,
        allowedPatterns: envelope.allowedPaths,
        maxResults: limits.maxFiles + 1
      });
    } catch {
      throw new ContextReaderError('read_failed');
    }
    if (listed.length >= limits.maxFiles + 1) throw new ContextReaderError('too_many_files');

    const selected = listed
      .filter((path) => CONTEXT_EXTENSIONS.some((extension) => path.endsWith(extension)))
      .sort(compareCodePoints);

    const files: ContextFile[] = [];
    let total = 0;
    for (const path of selected) {
      let text: string;
      try {
        text = await paths.readText({
          workspace,
          relativePath: path,
          allowedPatterns: envelope.allowedPaths,
          maxBytes: limits.maxFileBytes + 1
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'workspace_file_too_large_or_unsupported') {
          throw new ContextReaderError('file_too_large');
        }
        throw new ContextReaderError('read_failed');
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > limits.maxFileBytes) throw new ContextReaderError('file_too_large');
      total += bytes;
      if (total > limits.maxTotalBytes) throw new ContextReaderError('context_too_large');
      files.push(Object.freeze({ path, text }));
    }
    return Object.freeze(files);
  };
}
