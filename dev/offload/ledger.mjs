// Appends one JSON line to the Kaggle ledger. Only this script writes the ledger.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const EVENTS = ['push', 'status', 'output', 'delete'];
const DEFAULT_FILE = resolve(import.meta.dirname, '../../runtime/offload/kaggle-ledger.jsonl');

function fail(msg) {
  process.stderr.write(`ledger: ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (!['version', 'status', 'gpu-seconds', 'note', 'file'].includes(key)) fail(`unknown option ${a}`);
    if (i + 1 >= args.length) fail(`missing value for ${a}`);
    if (key in opts) fail(`duplicate option ${a}`);
    opts[key] = args[++i];
  } else positional.push(a);
}
if (positional.length !== 2) fail('usage: ledger.mjs <event> <kernel> [options]');
const [event, kernel] = positional;
if (!EVENTS.includes(event)) fail(`event must be one of ${EVENTS.join(', ')}`);
if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(kernel)) fail('invalid kernel');
if (opts.status !== undefined && !/^[A-Z_]{1,24}$/.test(opts.status)) fail('invalid --status');
for (const k of ['version', 'gpu-seconds']) {
  if (opts[k] !== undefined && !/^\d+$/.test(opts[k])) fail(`--${k} must be a non-negative integer`);
}
const note = opts.note ?? '';
if (note.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(note)) fail('invalid --note');

const line = JSON.stringify({
  ts: new Date().toISOString(),
  kernel,
  version: opts.version === undefined ? null : Number(opts.version),
  event,
  status: opts.status ?? null,
  gpuSeconds: opts['gpu-seconds'] === undefined ? null : Number(opts['gpu-seconds']),
  note,
});
const file = opts.file ? resolve(opts.file) : DEFAULT_FILE;
mkdirSync(dirname(file), { recursive: true });
appendFileSync(file, line + '\n');
process.stdout.write(line + '\n');
