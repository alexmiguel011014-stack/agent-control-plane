import { redactEventData } from './redact-event.mjs';

export function buildEvent(type, data) {
  return { type, data: redactEventData(data) };
}
