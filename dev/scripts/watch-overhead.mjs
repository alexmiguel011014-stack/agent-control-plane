// G21.10: measure the cost of `agentctl watch --once` (wall time and VRAM).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const RUNS = 10;
const MAX_MEAN_MS = 1500;
const MAX_VRAM_DELTA_MIB = 8;

function readVram() {
  const r = spawnSync(
    'nvidia-smi',
    ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.error || r.status !== 0) return null;
  const values = String(r.stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(Number);
  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) return null;
  return values.reduce((a, b) => a + b, 0);
}

const before = readVram();
const walls = [];
for (let i = 0; i < RUNS; i += 1) {
  const start = process.hrtime.bigint();
  const r = spawnSync(
    process.execPath,
    ['src/bin/agentctl.ts', 'watch', '--once', '--no-color'],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (r.error || r.status !== 0) {
    console.log(`watch run ${i + 1} failed: exit code ${r.status ?? 'none'}${r.error ? ` (${r.error.message})` : ''}`);
    if (r.stderr) console.log(String(r.stderr).trim());
    process.exit(1);
  }
  walls.push(ms);
}
const after = readVram();

const mean = walls.reduce((a, b) => a + b, 0) / walls.length;
console.log(`mean_wall_ms: ${mean.toFixed(0)}`);
let fail = mean > MAX_MEAN_MS;
if (before === null || after === null) {
  console.log('no nvidia-smi: vram check skipped');
} else {
  const delta = after - before;
  console.log(`vram_before_mib: ${before}`);
  console.log(`vram_after_mib: ${after}`);
  console.log(`vram_delta_mib: ${delta}`);
  if (delta > MAX_VRAM_DELTA_MIB) fail = true;
}
process.exit(fail ? 1 : 0);
