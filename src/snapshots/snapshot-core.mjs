import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MANIFEST_KEYS = ['schemaVersion', 'files'];
const FILE_KEYS = ['path', 'sizeBytes', 'sha256'];
export const DEFAULT_SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: 50_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
});

function fail(message) {
  throw new Error(`Invalid snapshot: ${message}`);
}

function samePath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isSameOrChild(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const WINDOWS_DEVICE_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const BLOCKED_SEGMENTS = new Set(['.git', '.agentctl', '.ssh', '.aws', '.venv', 'node_modules', '.npmrc', '.pypirc', '.netrc']);
const PRIVATE_KEY_NAMES = new Set(['credentials', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'secrets']);
const PRIVATE_KEY_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.ppk']);

export function assertSnapshotPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) fail('path must be a non-empty relative string');
  if (Buffer.from(relativePath, 'utf8').toString('utf8') !== relativePath) fail('path contains invalid Unicode');
  if (
    relativePath.includes('\\')
    || relativePath.includes(':')
    || /[\u0000-\u001f\u007f<>"|?*]/.test(relativePath)
    || relativePath.startsWith('/')
    || path.posix.isAbsolute(relativePath)
    || relativePath.length > 32_000
  ) {
    fail('path contains an absolute form or an unsupported character');
  }

  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) fail('path contains traversal');
  for (const segment of segments) {
    if (segment.length > 255 || segment.startsWith(' ') || segment.endsWith('.') || segment.endsWith(' ')) {
      fail('path has an unsupported Windows component');
    }
    const lower = segment.toLowerCase();
    const extensionIndex = lower.lastIndexOf('.');
    const extension = extensionIndex < 0 ? '' : lower.slice(extensionIndex);
    const baseName = extensionIndex < 0 ? lower : lower.slice(0, extensionIndex);
    const firstDotIndex = lower.indexOf('.');
    const nameBeforeFirstDot = firstDotIndex > 0 ? lower.slice(0, firstDotIndex) : lower;
    if (
      lower.startsWith('.env')
      || BLOCKED_SEGMENTS.has(lower)
      || PRIVATE_KEY_NAMES.has(nameBeforeFirstDot)
      || PRIVATE_KEY_EXTENSIONS.has(extension)
      || /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/i.test(segment)
      || WINDOWS_DEVICE_SEGMENT_PATTERN.test(segment)
    ) {
      fail('path selects a protected or credential-like name');
    }
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(baseName)) {
      fail('path selects a reserved Windows device name');
    }
  }
  return relativePath;
}

export function normalizeSnapshotManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest must be an object');
  if (Object.keys(manifest).sort().join('\0') !== [...MANIFEST_KEYS].sort().join('\0')) {
    fail('manifest has missing or undeclared fields');
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) fail('unsupported schema version or invalid files list');

  const seen = new Set();
  const files = manifest.files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) fail('file record must be an object');
    if (Object.keys(file).sort().join('\0') !== [...FILE_KEYS].sort().join('\0')) {
      fail('file record has missing or undeclared fields');
    }
    assertSnapshotPath(file.path);
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) fail('file has an invalid byte size');
    if (typeof file.sha256 !== 'string' || !HASH_PATTERN.test(file.sha256)) fail('file has an invalid SHA-256');

    const collisionKey = file.path.toLowerCase();
    if (seen.has(collisionKey)) fail('manifest contains a case-insensitive path collision');
    seen.add(collisionKey);
    return { path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 };
  });

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { schemaVersion: 1, files };
}

export async function sha256File(filePath, maxBytes = Number.MAX_SAFE_INTEGER) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.length;
    if (sizeBytes > maxBytes) fail('file exceeds the configured size limit');
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

export function snapshotId(manifest) {
  const canonical = normalizeSnapshotManifest(manifest);
  return createHash('sha256').update(Buffer.from(JSON.stringify(canonical), 'utf8')).digest('hex');
}

async function assertOrdinaryDirectory(directory) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('directory is a reparse point or not a directory');
  const resolved = await realpath(directory);
  if (!samePath(resolved, directory)) fail('directory resolves to another path');
  return resolved;
}

async function listSnapshotFiles(baseDir, options = {}) {
  const requestedRoot = path.resolve(baseDir);
  const root = await assertOrdinaryDirectory(requestedRoot);
  const excludedNames = new Set((options.excludeDirectories ?? []).map((entry) => entry.toLowerCase()));
  const maxFiles = options.maxFiles ?? DEFAULT_SNAPSHOT_LIMITS.maxFiles;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_SNAPSHOT_LIMITS.maxFileBytes;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SNAPSHOT_LIMITS.maxTotalBytes;
  const records = [];
  const excludedPaths = [];
  let totalBytes = 0;

  async function visit(directory, parentPath) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) fail('source contains a symlink or junction');

      const resolvedPath = await realpath(absolutePath);
      const expectedPath = path.join(root, ...relativePath.split('/'));
      if (!samePath(resolvedPath, expectedPath)) fail('source contains a redirected or reparse path');

      if (excludedNames.has(entry.name.toLowerCase())) {
        excludedPaths.push(relativePath);
        continue;
      }

      assertSnapshotPath(relativePath);
      if (info.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (info.isFile()) {
        if (records.length >= maxFiles) fail('snapshot exceeds the configured file-count limit');
        const result = await sha256File(absolutePath, maxFileBytes);
        totalBytes += result.sizeBytes;
        if (totalBytes > maxTotalBytes) fail('snapshot exceeds the configured total-size limit');
        records.push({ path: relativePath, sizeBytes: result.sizeBytes, sha256: result.sha256 });
      } else {
        fail('source contains an unsupported filesystem entry');
      }
    }
  }

  await visit(root, '');
  return {
    manifest: normalizeSnapshotManifest({ schemaVersion: 1, files: records }),
    excludedPaths: Object.freeze(excludedPaths),
    totalBytes,
  };
}

export async function createSnapshotManifest(baseDir, options = {}) {
  return (await listSnapshotFiles(baseDir, options)).manifest;
}

export async function createSnapshotInventory(baseDir, options = {}) {
  return listSnapshotFiles(baseDir, options);
}

export function validateSnapshotManifest(manifest) {
  return normalizeSnapshotManifest(manifest);
}

export async function writeSnapshotManifest(baseDir) {
  const absoluteBase = path.resolve(baseDir);
  const manifest = await createSnapshotManifest(absoluteBase);
  const manifestPath = path.join(path.dirname(absoluteBase), 'snapshot.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(manifestPath, manifestBytes, { flag: 'wx' });
  return { manifestPath, manifest, snapshotId: snapshotId(manifest) };
}

export async function readSnapshotManifest(manifestPath) {
  const info = await lstat(manifestPath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) fail('manifest is not an ordinary small file');
  return validateSnapshotManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
}

export async function verifySnapshot(baseDir, manifest, expectedId = snapshotId(manifest), options = {}) {
  const canonical = normalizeSnapshotManifest(manifest);
  const actualId = snapshotId(canonical);
  if (typeof expectedId !== 'string' || !HASH_PATTERN.test(expectedId) || actualId !== expectedId) {
    fail('snapshot ID does not match the canonical manifest');
  }

  const inventory = await createSnapshotInventory(baseDir, options);
  if (JSON.stringify(inventory.manifest) !== JSON.stringify(canonical)) fail('base directory bytes or file list do not match the manifest');
  return { snapshotId: actualId, manifest: inventory.manifest };
}

async function inspectDestinationPath(destination) {
  const { root } = path.parse(destination);
  const parts = destination.slice(root.length).split(path.sep).filter(Boolean);
  let current = await realpath(root);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !samePath(current, root)) fail('destination root is unsafe');

  for (const [index, part] of parts.entries()) {
    const candidate = path.join(current, part);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (index !== parts.length - 1) fail('destination ancestors must already exist');
      return { exists: false, canonicalPath: candidate };
    }

    if (info.isSymbolicLink() || !info.isDirectory()) fail('destination contains a reparse point or non-directory ancestor');
    const resolved = await realpath(candidate);
    if (!samePath(resolved, candidate)) fail('destination contains a redirected ancestor');
    current = resolved;
    if (index === parts.length - 1) {
      if ((await readdir(current)).length !== 0) fail('destination must be empty');
      return { exists: true, canonicalPath: current };
    }
  }
  if ((await readdir(current)).length !== 0) fail('destination must be empty');
  return { exists: true, canonicalPath: current };
}

export async function restoreSnapshot(baseDir, manifest, destinationDir, expectedId = snapshotId(manifest)) {
  const canonical = normalizeSnapshotManifest(manifest);
  const verified = await verifySnapshot(baseDir, canonical, expectedId);
  const source = await realpath(path.resolve(baseDir));
  const destination = await inspectDestinationPath(path.resolve(destinationDir));
  const destinationPath = destination.canonicalPath;
  if (isSameOrChild(source, destinationPath) || isSameOrChild(destinationPath, source)) fail('destination must not overlap the source base directory');
  if (!destination.exists) await mkdir(destinationPath, { recursive: false });

  for (const file of verified.manifest.files) {
    const sourcePath = path.join(source, ...file.path.split('/'));
    const targetPath = path.join(destinationPath, ...file.path.split('/'));
    const parent = path.dirname(targetPath);
    await mkdir(parent, { recursive: true });
    await pipeline(createReadStream(sourcePath), createWriteStream(targetPath, { flags: 'wx' }));
  }

  return verifySnapshot(destinationPath, canonical, expectedId);
}
