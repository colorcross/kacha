// Shared primitives for the local production studio pages. Pages keep their
// own presentation helpers (toast timing, status DOM) because their layouts
// differ; this module only centralizes escaping and the fetch/error contract.

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function studioHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "X-Kacha-Studio": "1",
    ...(extra ?? {}),
  };
}

export function jsonErrorMessage(value, response, { includeStatus = false } = {}) {
  if (value?.error) return value.error;
  return includeStatus ? `请求失败：${response.status}` : "请求失败";
}
