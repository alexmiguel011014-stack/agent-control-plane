import { isNewer } from './newer.mjs';

export function latestByKey(records) {
  const best = new Map();
  for (const record of records) {
    const current = best.get(record.key);
    if (current === undefined || isNewer(record, current)) best.set(record.key, record);
  }
  return [...best.values()].map((record) => ({ key: record.key, version: record.version, payload: record.payload }));
}
