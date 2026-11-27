import { pad2 } from './pad.mjs';

export function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return hours + 'h ' + pad2(minutes) + 'm ' + pad2(seconds) + 's';
  if (minutes > 0) return minutes + 'm ' + pad2(seconds) + 's';
  return seconds + 's';
}
