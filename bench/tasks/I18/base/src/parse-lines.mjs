import { splitOnce } from './split.mjs';

export function parseKeyValueLines(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [key, value] = splitOnce(line, '=');
    if (key.trim() === '') continue;
    result[key.trim()] = value.trim();
  }
  return result;
}
