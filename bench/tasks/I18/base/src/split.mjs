export function splitOnce(line, separator) {
  const parts = line.split(separator);
  return [parts[0], parts[1] ?? ''];
}
