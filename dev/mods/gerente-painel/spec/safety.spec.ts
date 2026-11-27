import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const hooks = join(import.meta.dirname, '..', 'hooks');
const libDir = join(hooks, 'lib');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const registerText = stripComments(readFileSync(join(hooks, 'register.tsx'), 'utf8'));
const libFiles = readdirSync(libDir).filter((f) => f.endsWith('.ts'));
const libTexts = libFiles.map((f) => ({ name: `lib/${f}`, text: stripComments(readFileSync(join(libDir, f), 'utf8')) }));
const scanned = [{ name: 'register.tsx', text: registerText }, ...libTexts];

const FORBIDDEN = ['fs.write', '.http', '.settings', 'tool.register', '$.agent', '$.model', 'token'];

// Text from `$.process.run(` to its matching `)`, or undefined when absent.
function runArgs(src: string): string | undefined {
  const start = src.indexOf('$.process.run(');
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start + '$.process.run'.length; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1);
  }
  return undefined;
}

function violations(files: { name: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const word of FORBIDDEN) if (f.text.includes(word)) out.push(`${f.name}: ${word}`);
    const args = runArgs(f.text);
    if (args !== undefined && /kaggle/i.test(args)) out.push(`${f.name}: kaggle in $.process.run`);
  }
  return out;
}

test('lib files were found', () => {
  assert.ok(libFiles.length > 0);
});

test('no forbidden call or word in register.tsx and lib/*.ts', () => {
  assert.deepEqual(violations(scanned), []);
});

test('detector fires on a forbidden call (negative self-test)', () => {
  assert.deepEqual(violations([{ name: 'x.ts', text: "await $.fs.write('a', 'b')" }]), ['x.ts: fs.write']);
  assert.deepEqual(violations([{ name: 'y.ts', text: "$.process.run(['kaggle', 'x'])" }]), ['y.ts: kaggle in $.process.run']);
});

test('comments are ignored by the scan', () => {
  assert.deepEqual(violations([{ name: 'c.ts', text: stripComments('// fs.write token\n/* $.agent */ const a = 1') }]), []);
});

test('register.tsx makes exactly one process call, a read-only agentctl watch', () => {
  assert.equal(registerText.split('$.process').length - 1, 1);
  const args = runArgs(registerText);
  assert.ok(args !== undefined);
  // The command array is held in a constant that the call passes by name.
  const ref = /\$\.process\.run\(\s*(\w+)/.exec(args)?.[1];
  assert.ok(ref);
  const decl = new RegExp(`const ${ref}\\s*=\\s*\\[[^\\]]*\\]`).exec(registerText)?.[0] ?? '';
  const command = args.includes('agentctl.ts') ? args : decl;
  for (const part of ['agentctl.ts', 'watch', '--once', '--json']) assert.ok(command.includes(part), part);
  // The declaration of the command array is part of the call: it must not name the Kaggle CLI either.
  assert.ok(!/kaggle/i.test(command), 'the process command must not name the Kaggle CLI');
});

test('lib files import nothing from claude-code', () => {
  for (const f of libTexts) assert.ok(!/claude-code/.test(f.text), f.name);
});

test('ledger.mjs is not imported or named in the mod', () => {
  for (const f of scanned) assert.ok(!f.text.includes('ledger.mjs'), f.name);
});
