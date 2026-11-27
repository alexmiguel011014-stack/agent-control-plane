export function sumRange(values, start, end) {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    total += values[index];
  }
  return total;
}
