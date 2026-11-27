import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(
  readFileSync(new URL('./task.schema.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

const validTask = {
  task_id: 'P01',
  prompt: 'Implement the stated behavior without changing unrelated files.',
  base_snapshot_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  allowed_globs: ['src/**/*.ts', 'test/**/*.ts'],
  allowed_operations: ['read_text', 'list_files', 'apply_unified_diff', 'run_declared_test', 'git_diff'],
  public_test_command_id: 'p01-public-tests',
  timeout_ms: 600000,
  max_changed_files: 4,
  oracle_version: 'oracle-v1',
  risk_class: 'write',
};

function isValid(task) {
  return validate(task);
}

test('accepts a complete valid benchmark task manifest', () => {
  assert.equal(isValid(validTask), true, JSON.stringify(validate.errors));
});

test('rejects malformed task IDs', () => {
  assert.equal(isValid({ ...validTask, task_id: '../P01' }), false);
});

test('rejects operations outside the closed tool gateway', () => {
  assert.equal(isValid({ ...validTask, allowed_operations: ['run_shell'] }), false);
});

test('rejects absolute, non-normalized, and secret-bearing globs', () => {
  for (const path of ['/etc/passwd', 'C:/secrets/**', '../outside/**', 'src/.env.local', '.git/config', 'src//file.ts', 'src/./file.ts', 'src\\file.ts']) {
    assert.equal(isValid({ ...validTask, allowed_globs: [path] }), false, path);
  }
});

test('accepts only a registered test command identifier, never a shell command', () => {
  assert.equal(isValid({ ...validTask, public_test_command_id: 'npm test && whoami' }), false);
});

test('rejects undeclared fields', () => {
  assert.equal(isValid({ ...validTask, shell_command: 'whoami' }), false);
});

test('accepts only lowercase SHA-256 base snapshot IDs', () => {
  for (const base_snapshot_sha256 of ['not-a-snapshot-hash', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.equal(isValid({ ...validTask, base_snapshot_sha256 }), false, base_snapshot_sha256);
  }
  assert.equal(isValid({ ...validTask, base_snapshot_sha256: 'f'.repeat(64) }), true);
});

test('requires the snapshot ID field and rejects the legacy commit field', () => {
  const missingSnapshot = { ...validTask };
  delete missingSnapshot.base_snapshot_sha256;
  assert.equal(isValid(missingSnapshot), false);
  assert.equal(isValid({ ...validTask, base_commit: 'a'.repeat(40) }), false);
});
