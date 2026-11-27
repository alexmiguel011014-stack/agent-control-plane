export function isNewer(candidate, current) {
  return candidate.version > current.version;
}
