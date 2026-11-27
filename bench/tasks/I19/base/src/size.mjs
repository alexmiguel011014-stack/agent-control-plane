export function sizeOf(item) {
  return typeof item.size === 'number' && item.size > 0 ? item.size : 0;
}
