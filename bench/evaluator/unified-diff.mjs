import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RELATIVE_PATH = /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/;
const SAFE_GLOB = /^[A-Za-z0-9_.*?@+-]+(?:\/[A-Za-z0-9_.*?@+-]+)*$/;

export class PatchFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchFormatError';
  }
}

export class PatchPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchPolicyError';
  }
}

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !RELATIVE_PATH.test(relativePath)) {
    throw new PatchPolicyError('Patch contains a non-POSIX or unsupported path');
  }
  if (relativePath.startsWith('/') || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)) {
    throw new PatchPolicyError('Patch contains an absolute path');
  }
  for (const part of relativePath.split('/')) {
    const lower = part.toLowerCase();
    if (part === '.' || part === '..' || lower.startsWith('.env') || lower === '.git') {
      throw new PatchPolicyError('Patch contains a protected path');
    }
  }
}

function globToRegExp(glob) {
  if (typeof glob !== 'string' || !SAFE_GLOB.test(glob)) {
    throw new PatchPolicyError('Declared path glob is unsupported');
  }
  for (const part of glob.split('/')) {
    const lower = part.toLowerCase();
    if (part === '.' || part === '..' || lower.startsWith('.env') || lower === '.git') {
      throw new PatchPolicyError('Declared path glob contains a protected path');
    }
  }
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      index += 1;
      if (glob[index + 1] === '/') {
        index += 1;
        source += '(?:[^/]+/)*';
      } else {
        source += '.*';
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source);
}

export function matchesPathGlobs(relativePath, allowedGlobs) {
  return allowedGlobs.some((glob) => globToRegExp(glob).test(relativePath));
}

function parseGitPath(headerPath, prefix) {
  if (!headerPath.startsWith(prefix)) throw new PatchFormatError('Unexpected unified diff path header');
  const relativePath = headerPath.slice(prefix.length);
  assertSafeRelativePath(relativePath);
  return relativePath;
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
  if (!match) throw new PatchFormatError('Malformed unified diff hunk header');
  const [, oldStartText, oldCountText, newStartText, newCountText] = match;
  const oldStart = Number(oldStartText);
  const oldCount = oldCountText === undefined ? 1 : Number(oldCountText);
  const newStart = Number(newStartText);
  const newCount = newCountText === undefined ? 1 : Number(newCountText);
  if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) {
    throw new PatchFormatError('Unified diff hunk positions exceed supported integers');
  }
  if ((oldStart === 0 && oldCount !== 0) || (newStart === 0 && newCount !== 0)) {
    throw new PatchFormatError('Invalid zero-based unified diff hunk');
  }
  return { oldStart, oldCount, newStart, newCount };
}

export function parseUnifiedPatch(patchText, allowedGlobs) {
  if (typeof patchText !== 'string' || !Array.isArray(allowedGlobs) || allowedGlobs.length === 0) {
    throw new PatchFormatError('Unified diff and path allowlist are required');
  }
  const matchers = allowedGlobs.map(globToRegExp);
  if (patchText.trim() === '') return [];

  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files = [];
  const seen = new Set();
  let cursor = 0;

  while (cursor < lines.length) {
    const fileHeader = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(lines[cursor]);
    if (!fileHeader) throw new PatchFormatError('Expected a git-style unified diff file header');
    const headerOldPath = parseGitPath(`a/${fileHeader[1]}`, 'a/');
    const headerNewPath = parseGitPath(`b/${fileHeader[2]}`, 'b/');
    cursor += 1;

    if (lines[cursor]?.startsWith('index ')) cursor += 1;
    const oldHeader = lines[cursor];
    const newHeader = lines[cursor + 1];
    if (typeof oldHeader !== 'string' || typeof newHeader !== 'string') {
      throw new PatchFormatError('Unified diff is missing file headers');
    }
    const oldPath = parseGitPath(oldHeader, '--- a/');
    const newPath = parseGitPath(newHeader, '+++ b/');
    if (oldPath !== headerOldPath || newPath !== headerNewPath || oldPath !== newPath) {
      throw new PatchPolicyError('File additions, removals, and renames are not permitted');
    }
    if (!matchers.some((matcher) => matcher.test(oldPath))) {
      throw new PatchPolicyError('Patch path is outside the declared allowlist');
    }
    if (seen.has(oldPath.toLowerCase())) throw new PatchPolicyError('Patch contains duplicate file paths');
    seen.add(oldPath.toLowerCase());
    cursor += 2;

    const hunks = [];
    while (cursor < lines.length && lines[cursor].startsWith('@@ ')) {
      const header = parseHunkHeader(lines[cursor]);
      cursor += 1;
      const rows = [];
      let oldSeen = 0;
      let newSeen = 0;
      while (oldSeen < header.oldCount || newSeen < header.newCount) {
        const row = lines[cursor];
        if (typeof row !== 'string' || row.length === 0) throw new PatchFormatError('Truncated unified diff hunk');
        const kind = row[0];
        if (kind === ' ' || kind === '-') oldSeen += 1;
        if (kind === ' ' || kind === '+') newSeen += 1;
        if (![' ', '+', '-'].includes(kind)) throw new PatchFormatError('Unsupported unified diff line marker');
        if (oldSeen > header.oldCount || newSeen > header.newCount) {
          throw new PatchFormatError('Unified diff hunk counts do not match its header');
        }
        rows.push({ kind, text: row.slice(1) });
        cursor += 1;
      }
      hunks.push({ ...header, rows });
    }
    if (hunks.length === 0) throw new PatchFormatError('Unified diff file has no hunks');
    files.push({ path: oldPath, hunks });
  }

  return files;
}

function applyFileHunks(originalText, hunks) {
  const hasCarriageReturns = originalText.includes('\r');
  const hasOnlyWindowsNewlines = !hasCarriageReturns || /^([^\r]|\r\n)*$/.test(originalText);
  if (!hasOnlyWindowsNewlines) throw new PatchFormatError('Mixed or unsupported line endings in patch target');
  const lineEnding = hasCarriageReturns ? '\r\n' : '\n';
  const normalizedText = hasCarriageReturns ? originalText.replace(/\r\n/g, '\n') : originalText;
  const hasFinalNewline = normalizedText.endsWith('\n');
  const lines = normalizedText.split('\n');
  if (hasFinalNewline) lines.pop();
  let offset = 0;

  for (const hunk of hunks) {
    const hunkStart = (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) + offset;
    if (hunkStart < 0 || hunkStart > lines.length) throw new PatchFormatError('Unified diff hunk starts outside the file');

    let cursor = hunkStart;
    const replacement = [];
    for (const row of hunk.rows) {
      if (row.kind === '+') {
        replacement.push(row.text);
        continue;
      }
      if (lines[cursor] !== row.text) throw new PatchFormatError('Unified diff context does not match the restored file');
      if (row.kind === ' ') replacement.push(lines[cursor]);
      cursor += 1;
    }

    const oldLength = cursor - hunkStart;
    lines.splice(hunkStart, oldLength, ...replacement);
    offset += replacement.length - oldLength;
  }

  const result = `${lines.join('\n')}${hasFinalNewline ? '\n' : ''}`;
  return lineEnding === '\n' ? result : result.replace(/\n/g, lineEnding);
}

async function assertPlainTarget(root, relativePath) {
  const rootPath = path.resolve(root);
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new PatchPolicyError('Workspace root must be an ordinary directory');
  const realRoot = await realpath(rootPath);
  let currentPath = rootPath;
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    currentPath = path.join(currentPath, parts[index]);
    const info = await lstat(currentPath);
    const last = index === parts.length - 1;
    if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) {
      throw new PatchPolicyError('Patch target must be an ordinary file beneath the workspace');
    }
    const resolved = await realpath(currentPath);
    const relative = path.relative(realRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new PatchPolicyError('Patch target resolves outside the workspace');
    }
  }
  return currentPath;
}

export async function applyUnifiedPatch(workspaceRoot, patchText, allowedGlobs) {
  const files = parseUnifiedPatch(patchText, allowedGlobs);
  const prepared = [];

  for (const file of files) {
    const absolutePath = await assertPlainTarget(workspaceRoot, file.path);
    const bytes = await readFile(absolutePath);
    let originalText;
    try {
      originalText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new PatchFormatError('Patch target is not valid UTF-8 text');
    }
    if (!Buffer.from(originalText, 'utf8').equals(bytes)) throw new PatchFormatError('Patch target is not canonical UTF-8');
    prepared.push({ absolutePath, content: applyFileHunks(originalText, file.hunks) });
  }

  for (const file of prepared) await writeFile(file.absolutePath, file.content, { flag: 'w' });
  return files.map((file) => file.path);
}
