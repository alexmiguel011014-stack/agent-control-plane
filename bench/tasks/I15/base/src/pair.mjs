export function encodePair(key, value) {
  return key + '=' + encodeURIComponent(String(value));
}
