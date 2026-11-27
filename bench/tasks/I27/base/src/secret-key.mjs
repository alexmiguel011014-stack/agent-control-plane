export function isSecretKey(key) {
  return /(password|token)/.test(key);
}
