import { isCommandAllowed } from './command-policy.mjs';

export function authorizeToolOperation(commandId, registeredIds) {
  return { allowed: isCommandAllowed(commandId, registeredIds) };
}
