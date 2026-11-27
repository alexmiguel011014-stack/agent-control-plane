import { defaults } from './defaults.mjs';

export function normalizeConfig(input = {}) {
  return { ...defaults, ...input };
}

export const runtimeConfig = normalizeConfig();
