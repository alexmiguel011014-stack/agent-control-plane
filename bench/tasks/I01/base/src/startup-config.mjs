import { resolveOptions } from './resolve-options.mjs';

export function buildRuntimeOptions({ defaults, fileOptions, cliOptions } = {}) {
  return resolveOptions({ defaults, fileOptions, cliOptions });
}
