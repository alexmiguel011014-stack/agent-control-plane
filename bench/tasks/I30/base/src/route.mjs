import { splitPath } from './path.mjs';

export function matchRoute(pattern, path) {
  const wanted = splitPath(pattern);
  const actual = splitPath(path);
  const params = {};
  for (let i = 0; i < wanted.length; i += 1) {
    const part = wanted[i];
    if (part === '*') {
      params.rest = actual.slice(i).join('/');
      return params;
    }
    if (i >= actual.length) return null;
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(actual[i]);
    else if (part !== actual[i]) return null;
  }
  return wanted.length === actual.length ? params : null;
}
