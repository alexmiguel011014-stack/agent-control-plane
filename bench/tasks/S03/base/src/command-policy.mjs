export function isCommandAllowed(commandId, registeredIds = []) {
  return registeredIds.some((registeredId) => commandId.startsWith(registeredId));
}
