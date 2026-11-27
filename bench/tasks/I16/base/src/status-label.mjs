import { STATUS_LABELS } from './status-table.mjs';

export function statusLabel(code) {
  return STATUS_LABELS[code] || 'Unknown (' + code + ')';
}
