import { escapeHtml } from './escape.mjs';

export function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name) => {
    return Object.hasOwn(vars, name) ? escapeHtml(vars[name]) : '';
  });
}
