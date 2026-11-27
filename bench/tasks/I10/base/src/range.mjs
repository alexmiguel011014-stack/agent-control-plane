import { compareVersions } from './version.mjs';

export function satisfies(version, range) {
  const match = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})$/.exec(range.trim());
  if (!match) return false;
  const order = compareVersions(version, match[2]);
  switch (match[1] ?? '=') {
    case '>=': return order >= 0;
    case '<=': return order <= 0;
    case '>': return order > 0;
    case '<': return order < 0;
    default: return order === 0;
  }
}
