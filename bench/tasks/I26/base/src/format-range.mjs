export function formatRun(first, last) {
  if (first === last) return String(first);
  return first + '-' + last;
}
