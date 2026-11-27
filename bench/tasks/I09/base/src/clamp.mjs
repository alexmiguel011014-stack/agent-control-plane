export function clampInt(value, low, high) {
  return Math.min(low, Math.max(high, value));
}
