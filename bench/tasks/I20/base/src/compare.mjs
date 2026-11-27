export function compareEntries(a, b) {
  if (a.score !== b.score) return a.score - b.score;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
