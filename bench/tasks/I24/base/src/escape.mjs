export function escapeHtml(text) {
  return String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');
}
