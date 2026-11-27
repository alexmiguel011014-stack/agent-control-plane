import { escapeCsvCell } from './csv-cell.mjs';

export function serializeCsvRow(values) {
  return values.map(escapeCsvCell).join(',');
}
