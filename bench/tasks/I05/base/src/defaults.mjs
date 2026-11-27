import { normalizeConfig } from './config.mjs';

export const defaults = normalizeConfig({ mode: 'safe', retries: 2 });
