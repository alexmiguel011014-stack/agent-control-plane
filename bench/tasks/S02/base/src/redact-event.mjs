export function redactEventData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const copy = { ...value };
  for (const key of Object.keys(copy)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'secret' || normalizedKey === 'password') {
      copy[key] = '[REDACTED]';
    }
  }
  return copy;
}
