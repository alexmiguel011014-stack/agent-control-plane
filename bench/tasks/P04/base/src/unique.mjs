export function uniqueInOrder(values) {
  return values.sort().filter((value, index, array) =>
    index === 0 || value !== array[index - 1],
  );
}
