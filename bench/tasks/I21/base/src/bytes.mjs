import { trimZeros } from './trim.mjs';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'invalid';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return trimZeros(value.toFixed(unit === 0 ? 0 : 1)) + ' ' + UNITS[unit];
}
