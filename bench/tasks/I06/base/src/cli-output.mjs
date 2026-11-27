import { formatResult } from './format-result.mjs';

export function serializeCliOutput(result) {
  return formatResult({ schemaVersion: 1, result });
}
