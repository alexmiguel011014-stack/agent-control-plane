export function splitLong(word, width) {
  const parts = [];
  for (let i = 0; i + width < word.length; i += width) parts.push(word.slice(i, i + width));
  return parts;
}
