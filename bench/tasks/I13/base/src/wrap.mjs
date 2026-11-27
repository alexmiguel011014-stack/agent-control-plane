import { splitLong } from './chunks.mjs';

export function wrapText(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(' ').filter((w) => w !== '')) {
    for (const piece of word.length > width ? splitLong(word, width) : [word]) {
      if (current === '') current = piece;
      else if (current.length + 1 + piece.length <= width) current += ' ' + piece;
      else {
        lines.push(current);
        current = piece;
      }
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}
