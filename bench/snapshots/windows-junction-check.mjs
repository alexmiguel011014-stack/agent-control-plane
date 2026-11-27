import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSnapshotManifest, restoreSnapshot } from './index.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNTIME_ROOT = path.join(REPOSITORY_ROOT, 'runtime');
const EVIDENCE_PATH = path.join(RUNTIME_ROOT, 'diagnostics', 'windows-junction-check.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function ensureOrdinaryDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Runtime path is not an ordinary directory');
  const resolved = await realpath(directory);
  if (path.resolve(directory).toLowerCase() !== resolved.toLowerCase()) {
    throw new Error('Runtime path resolves through a filesystem alias');
  }
}

async function writeEvidence(evidence) {
  const diagnostics = path.dirname(EVIDENCE_PATH);
  await ensureOrdinaryDirectory(RUNTIME_ROOT);
  await ensureOrdinaryDirectory(diagnostics);
  const temporary = `${EVIDENCE_PATH}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, EVIDENCE_PATH);
}

async function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptBytes = await readFile(scriptPath);
  const evidence = {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    platform: process.platform,
    status: 'FAIL',
    script_sha256: sha256(scriptBytes),
    checks: {
      base_junction_created: false,
      base_junction_rejected: false,
      destination_junction_created: false,
      destination_junction_rejected: false,
      target_unchanged: false,
      source_unchanged: false,
      temporary_workspace_removed: false,
    },
  };
  let temporaryRoot;
  let failureCode;

  if (process.platform !== 'win32') {
    evidence.status = 'UNSUPPORTED';
    await writeEvidence(evidence);
    process.stderr.write('Windows junction checks require Windows.\n');
    process.exitCode = 2;
    return;
  }

  try {
    await ensureOrdinaryDirectory(RUNTIME_ROOT);
    const runtimeReal = await realpath(RUNTIME_ROOT);
    temporaryRoot = await mkdtemp(path.join(RUNTIME_ROOT, 'windows-junction-check-'));
    const temporaryReal = await realpath(temporaryRoot);
    if (!within(runtimeReal, temporaryReal)) throw new Error('Temporary junction workspace escaped runtime/');

    const base = path.join(temporaryRoot, 'base');
    const target = path.join(temporaryRoot, 'base-target');
    await mkdir(base);
    await mkdir(target);
    await writeFile(path.join(target, 'outside.txt'), 'contained in runtime probe');
    const baseJunction = path.join(base, 'junction');
    await symlink(target, baseJunction, 'junction');
    evidence.checks.base_junction_created = true;
    try {
      await createSnapshotManifest(base);
    } catch (error) {
      evidence.checks.base_junction_rejected = /symlink|junction|reparse/i.test(error.message);
    }
    if (!evidence.checks.base_junction_rejected) throw new Error('Snapshot manifest accepted a directory junction');

    const source = path.join(temporaryRoot, 'source');
    const destinationTarget = path.join(temporaryRoot, 'destination-target');
    await mkdir(source);
    await mkdir(destinationTarget);
    await writeFile(path.join(source, 'source.txt'), 'snapshot source');
    await writeFile(path.join(destinationTarget, 'keep.txt'), 'destination marker');
    const sourceManifest = await createSnapshotManifest(source);
    const destinationJunction = path.join(temporaryRoot, 'destination-junction');
    await symlink(destinationTarget, destinationJunction, 'junction');
    evidence.checks.destination_junction_created = true;
    const aliasedDestination = path.join(destinationJunction, 'restored');
    try {
      await restoreSnapshot(source, sourceManifest, aliasedDestination);
    } catch (error) {
      evidence.checks.destination_junction_rejected = /symlink|junction|reparse/i.test(error.message);
    }
    const targetNames = await readdir(destinationTarget);
    evidence.checks.target_unchanged = targetNames.length === 1
      && targetNames[0] === 'keep.txt'
      && (await readFile(path.join(destinationTarget, 'keep.txt'), 'utf8')) === 'destination marker';
    const sourceAfter = await createSnapshotManifest(source);
    evidence.checks.source_unchanged = JSON.stringify(sourceAfter) === JSON.stringify(sourceManifest);
    if (!evidence.checks.destination_junction_rejected || !evidence.checks.target_unchanged || !evidence.checks.source_unchanged) {
      throw new Error('Restore did not reject the destination junction without changing either tree');
    }
    evidence.status = 'PASS';
  } catch (error) {
    failureCode = error?.code;
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(failureCode)) {
      evidence.status = 'UNAVAILABLE';
    } else {
      evidence.status = 'FAIL';
    }
    evidence.error_code = failureCode ?? 'CHECK_FAILED';
  } finally {
    if (temporaryRoot) {
      const rootReal = await realpath(RUNTIME_ROOT);
      const tempReal = await realpath(temporaryRoot).catch(() => temporaryRoot);
      if (!within(rootReal, tempReal)) throw new Error('Refusing to clean a path outside runtime/');
      await rm(temporaryRoot, { recursive: true, force: true });
      evidence.checks.temporary_workspace_removed = true;
    }
    await writeEvidence(evidence);
  }

  process.stdout.write(`Junction evidence: ${EVIDENCE_PATH}\nStatus: ${evidence.status}\n`);
  if (evidence.status !== 'PASS') process.exitCode = evidence.status === 'UNAVAILABLE' ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
