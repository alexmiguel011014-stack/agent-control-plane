import { writeFile } from 'node:fs/promises';

const MAX_INPUT_BYTES = 65_536;
const EXECUTION_MARKER = 'appcontainer-stdio-smoke-execution-v1';

async function writeMarker(value) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${value}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  let stageWriteSucceeded = false;
  try {
    const executionMarkerUrl = new URL('../workspace/stdio-smoke-execution.marker', import.meta.url);
    await writeFile(executionMarkerUrl, EXECUTION_MARKER, { flag: 'wx' });
    stageWriteSucceeded = true;
  } catch {
    stageWriteSucceeded = false;
  }
  try { await writeMarker('BOOT'); } catch {}
  try { await writeMarker(stageWriteSucceeded ? 'STAGE_WRITE_OK' : 'STAGE_WRITE_FAIL'); } catch {}

  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    inputBytes += chunk.length;
    if (inputBytes > MAX_INPUT_BYTES) {
      process.exitCode = 2;
      return;
    }
  }
  try { await writeMarker(`INPUT_OK:${inputBytes}`); } catch { process.exitCode = 1; }
}

main().catch(() => {
  process.exitCode = 1;
});
