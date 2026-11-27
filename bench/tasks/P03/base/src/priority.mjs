export function sortByPriority(items) {
  return items.sort((left, right) =>
    left.priority - right.priority || left.name.localeCompare(right.name),
  );
}
