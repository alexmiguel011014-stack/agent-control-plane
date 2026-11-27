import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_EDITS_BLOCKS_SYSTEM_PROMPT,
  parseFileEditBlocks,
  parseOllamaFileEditsResponse,
} from './ollama.ts';

const MODEL = 'qwen2.5-coder:1.5b';
const files = [
  { path: 'src/a.mjs', text: "export const a = 'x';\n" },
  { path: 'src/b.mjs', text: 'export const b = 1;\n' },
];
const chat = (content: string) => ({ model: MODEL, done: true, message: { role: 'assistant', content } });

test('protocol v4 blocks carry quotes and backslashes without any escaping', () => {
  const answer = '<<<FILE src/a.mjs\nexport const a = "q\\\\" + \'\\\\\';\n>>>END\n';
  const blocks = parseFileEditBlocks(answer);
  assert.deepEqual(blocks, [{ path: 'src/a.mjs', content: 'export const a = "q\\\\" + \'\\\\\';\n' }]);
  const result = parseOllamaFileEditsResponse(chat(answer), MODEL, files, undefined, 'blocks');
  assert.equal(result.kind, 'proposal');
});

test('protocol v4 refuses text without a complete block, an unknown path, and a repeated path', () => {
  for (const bad of ['', 'no blocks here', '<<<FILE src/a.mjs\nnever closed', '<<<FILE src/zzz.mjs\nx\n>>>END\n',
    '<<<FILE src/a.mjs\nx\n>>>END\n<<<FILE src/a.mjs\ny\n>>>END\n']) {
    const result = parseOllamaFileEditsResponse(chat(bad), MODEL, files, undefined, 'blocks');
    assert.equal(result.kind, 'refusal', bad);
  }
});

test('protocol v4 answers identical to the original are a no_change_proposed refusal', () => {
  const result = parseOllamaFileEditsResponse(chat('<<<FILE src/b.mjs\nexport const b = 1;\n>>>END\n'), MODEL, files, undefined, 'blocks');
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' ? result.reasonCode : '', 'no_change_proposed');
});

test('protocol v4 accepts CRLF answers and tolerates a missing trailing newline marker spacing', () => {
  const result = parseOllamaFileEditsResponse(chat('<<<FILE src/b.mjs\r\nexport const b = 2;\r\n>>>END\r\n'), MODEL, files, undefined, 'blocks');
  assert.equal(result.kind, 'proposal');
});

test('the json path is unchanged and a JSON answer is refused in blocks mode', () => {
  const json = JSON.stringify({ proposalId: 'p', edits: [{ path: 'src/b.mjs', content: 'export const b = 2;\n' }] });
  assert.equal(parseOllamaFileEditsResponse(chat(json), MODEL, files).kind, 'proposal');
  assert.equal(parseOllamaFileEditsResponse(chat(json), MODEL, files, undefined, 'blocks').kind, 'refusal');
});

test('the v4 prompt describes the block format and the one-file rule', () => {
  assert.match(FILE_EDITS_BLOCKS_SYSTEM_PROMPT, /<<<FILE <path>/);
  assert.match(FILE_EDITS_BLOCKS_SYSTEM_PROMPT, />>>END/);
  assert.match(FILE_EDITS_BLOCKS_SYSTEM_PROMPT, /Change only the file that contains the defect/);
});
