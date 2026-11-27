import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createSnapshotManifest, snapshotId } from './index.mjs';

const EXPECTED_TASK_IDS = Object.freeze([
  ...Array.from({ length: 4 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 6 }, (_, index) => `B${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 30 }, (_, index) => `I${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`),
]);
const taskRoot = path.resolve(fileURLToPath(new URL('../tasks/', import.meta.url)));
const schemaPath = new URL('../schema/task.schema.json', import.meta.url);
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const validateTask = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function samePath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function validateTaskInventory(directoryNames) {
  const seen = new Set();
  const folded = new Set();
  const duplicates = [];
  const unexpected = [];

  for (const name of directoryNames) {
    if (typeof name !== 'string') throw new Error('Task directory names must be strings');
    const lower = name.toLowerCase();
    if (folded.has(lower) || seen.has(name)) duplicates.push(name);
    folded.add(lower);
    seen.add(name);
    if (!EXPECTED_TASK_IDS.includes(name)) unexpected.push(name);
  }

  const missing = EXPECTED_TASK_IDS.filter((taskId) => !seen.has(taskId));
  if (duplicates.length || unexpected.length || missing.length) {
    const details = [
      duplicates.length && `duplicate: ${duplicates.join(', ')}`,
      unexpected.length && `unexpected: ${unexpected.join(', ')}`,
      missing.length && `missing: ${missing.join(', ')}`,
    ].filter(Boolean).join('; ');
    throw new Error(`Task inventory must contain exactly ${EXPECTED_TASK_IDS.join(', ')} (${details})`);
  }
  return [...EXPECTED_TASK_IDS].sort();
}

async function assertRealDirectory(target, expectedPath) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Not an ordinary task directory: ${target}`);
  const resolved = await realpath(target);
  if (!samePath(resolved, expectedPath)) throw new Error(`Task path resolves outside its expected location: ${target}`);
}

async function assertRegularFile(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Not an ordinary file: ${target}`);
  const resolved = await realpath(target);
  if (!samePath(resolved, target)) throw new Error(`File path is redirected: ${target}`);
}

async function taskDirectories() {
  await assertRealDirectory(taskRoot, taskRoot);
  const entries = await readdir(taskRoot, { withFileTypes: true });
  const directoryNames = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink/reparse entry under bench/tasks: ${entry.name}`);
    if (entry.isDirectory()) directoryNames.push(entry.name);
    else if (!entry.isFile()) throw new Error(`Unexpected filesystem entry under bench/tasks: ${entry.name}`);
  }
  return validateTaskInventory(directoryNames);
}

async function inspectTask(taskId, checkOnly) {
  const taskDir = path.join(taskRoot, taskId);
  await assertRealDirectory(taskDir, taskDir);
  const baseDir = path.join(taskDir, 'base');
  const taskFile = path.join(taskDir, 'task.json');
  const snapshotFile = path.join(taskDir, 'snapshot.json');
  await assertRegularFile(taskFile);

  const manifest = await createSnapshotManifest(baseDir);
  const id = snapshotId(manifest);
  const task = JSON.parse(await readFile(taskFile, 'utf8'));
  if (task.task_id !== taskId) throw new Error(`${taskId}/task.json task_id does not match its directory`);
  const updatedTask = { ...task, base_snapshot_sha256: id };
  if (!validateTask(updatedTask)) {
    throw new Error(`${taskId}/task.json fails task.schema.json: ${JSON.stringify(validateTask.errors)}`);
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const taskText = `${JSON.stringify(updatedTask, null, 2)}\n`;
  let currentManifest;
  try {
    await assertRegularFile(snapshotFile);
    currentManifest = await readFile(snapshotFile, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const manifestChanged = currentManifest !== manifestText;
  const taskChanged = task.base_snapshot_sha256 !== id;
  if (checkOnly) {
    return { taskId, id, manifestChanged, taskChanged };
  }

  if (manifestChanged) await writeFile(snapshotFile, manifestText, 'utf8');
  if (taskChanged) await writeFile(taskFile, taskText, 'utf8');
  return { taskId, id, manifestChanged, taskChanged };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node bench/snapshots/seal.mjs [--check]');
  }
  const checkOnly = args[0] === '--check';
  const taskIds = await taskDirectories();
  if (taskIds.length === 0) throw new Error(`No task fixture directories found under ${taskRoot}`);

  const results = [];
  for (const taskId of taskIds) results.push(await inspectTask(taskId, checkOnly));
  for (const result of results) {
    if (checkOnly) {
      const status = result.manifestChanged || result.taskChanged ? 'STALE' : 'OK';
      process.stdout.write(`${result.taskId} ${status} ${result.id}\n`);
    } else {
      const changed = [result.manifestChanged && 'snapshot.json', result.taskChanged && 'task.json'].filter(Boolean);
      process.stdout.write(`${result.taskId} ${changed.length ? `updated ${changed.join(', ')}` : 'unchanged'} ${result.id}\n`);
    }
  }
  if (checkOnly && results.some((result) => result.manifestChanged || result.taskChanged)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
