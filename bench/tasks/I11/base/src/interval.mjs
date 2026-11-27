export function overlaps(a, b) {
  return a.end > b.start && b.end > a.start;
}
