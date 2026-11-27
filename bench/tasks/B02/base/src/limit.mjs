export function getLimit(config, fallback = 10) {
  return config.limit || fallback;
}
