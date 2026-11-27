import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedWorkerRunner } from './host-runner.mjs';

const TASK_ID = 'B01';
const FIXTURE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'tasks', 'B01', 'base',
);

if (process.platform !== 'win32') {
  console.error('smoke launch requires win32');
  process.exit(1);
}

let tempRoot;
let exitCode = 1;
try {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-control-smoke-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  await cp(FIXTURE_DIRECTORY, workspaceRoot, { recursive: true });

  const runWorkerBatch = createIsolatedWorkerRunner({
    authorizeWorkspace: ({ workspaceRoot: candidate, taskId }) => (
      taskId === TASK_ID && candidate === workspaceRoot
    ),
  });

  let line;
  try {
    const outcome = await runWorkerBatch({
      workspaceRoot,
      taskId: TASK_ID,
      calls: [{ callId: 'c1', operationId: 'call', args: [[1, 2, 3], 0, 2] }],
      timeoutMs: 10_000,
    });
    line = { ok: true, evidence: { ...outcome.evidence } };
    exitCode = 0;
  } catch (error) {
    line = { ok: false, code: error?.code ?? 'unknown_error' };
  }
  console.log(JSON.stringify(line));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.code ?? 'smoke_setup_failed' }));
} finally {
  if (tempRoot !== undefined) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      console.error(`warning: could not remove ${tempRoot}`);
    }
  }
}
process.exitCode = exitCode;
