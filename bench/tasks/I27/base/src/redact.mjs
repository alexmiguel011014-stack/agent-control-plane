import { isSecretKey } from './secret-key.mjs';

export function redactConfig(value) {
  if (Array.isArray(value)) return value.map((item) => redactConfig(item));
  if (value !== null && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = isSecretKey(key) ? '***' : redactConfig(item);
    }
    return copy;
  }
  return value;
}
