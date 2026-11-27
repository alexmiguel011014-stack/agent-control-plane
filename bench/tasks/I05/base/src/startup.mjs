import { defaults } from './defaults.mjs';
import { normalizeConfig } from './config.mjs';

export function createStartupConfig(overrides = {}) {
  return normalizeConfig({ ...defaults, ...overrides });
}
