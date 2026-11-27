export function toUtcIsoDate(value) {
  if (typeof value !== 'string' || value.length < 10) {
    throw new TypeError('Expected an RFC 3339 timestamp');
  }

  return value.slice(0, 10);
}
