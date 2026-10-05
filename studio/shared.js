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

export async function studioRequest(url, { body, signal, rejectBlocked = false } = {}) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: studioHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  let value;
  try { value = await response.json(); }
  catch { throw new Error(`服务响应无法读取 (${response.status})；请检查本地服务，写入操作请先核对当前状态。`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("服务返回了无效数据，请重新读取当前状态。");
  if (!response.ok || (rejectBlocked && value.status === "blocked")) throw new Error(jsonErrorMessage(value, response, { includeStatus: true }));
  return value;
}

// One pointer owns a gesture. Cancellation never commits a preview as a command.
const pointerOwners = new WeakSet();
export function trackPointer(node, event, { move, commit, cancel }) {
  if (pointerOwners.has(node) || event.isPrimary === false || event.button !== 0) return false;
  pointerOwners.add(node);
  const id = event.pointerId;
  let finished = false;
  const finish = (callback) => {
    if (finished) return;
    finished = true;
    node.removeEventListener("pointermove", onMove);
    node.removeEventListener("pointerup", onUp);
    node.removeEventListener("pointercancel", onCancel);
    node.removeEventListener("lostpointercapture", onCancel);
    document.removeEventListener("lostpointercapture", onCancel, true);
    window.removeEventListener("blur", onBlur);
    pointerOwners.delete(node);
    if (node.hasPointerCapture(id)) node.releasePointerCapture(id);
    callback();
  };
  const onMove = (next) => { if (next.pointerId === id) move(next); };
  const onUp = (next) => { if (next.pointerId === id) finish(commit); };
  const onCancel = (next) => { if (next.pointerId === id) finish(cancel); };
  const onBlur = () => finish(cancel);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onCancel);
  node.addEventListener("lostpointercapture", onCancel);
  // Browsers retarget capture loss to document when the node was removed.
  document.addEventListener("lostpointercapture", onCancel, true);
  window.addEventListener("blur", onBlur);
  try { node.setPointerCapture(id); } catch { finish(cancel); return false; }
  return true;
}
