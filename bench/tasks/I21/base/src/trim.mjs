export function trimZeros(text) {
  return text.replace(/0+$/, '').replace(/\.$/, '');
}
