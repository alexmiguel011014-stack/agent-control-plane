export function resolveOptions({
  defaults = {},
  fileOptions = {},
  cliOptions = {},
} = {}) {
  return { ...cliOptions, ...fileOptions, ...defaults };
}
