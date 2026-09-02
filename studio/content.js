import { studioHeaders, jsonErrorMessage } from "/shared.js";

const $ = (id) => document.getElementById(id);
let mode = "script";
async function api(path, body) {
  const response = await fetch(path, { method: "POST", headers: studioHeaders(), body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(jsonErrorMessage(value, response));
  return value;
}
function toast(message, error = false) {
  const node = $("toast"); node.textContent = message; node.style.background = error ? "#9e3422" : "#1b1a17"; node.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 4000);
}
function setMode(next) {
  mode = next;
  $("scriptField").hidden = mode !== "script";
  $("topicField").hidden = mode !== "topic";
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("is-active", button.dataset.mode === mode));
}
document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
$("chooseScript").addEventListener("click", async () => {
  try { const result = await api("/api/pick-document", {}); if (!result.cancelled) $("scriptPath").value = result.path; }
  catch (error) { toast(error.message, true); }
});
$("startContent").addEventListener("click", async () => {
  const button = $("startContent"); button.disabled = true; button.textContent = "正在冻结内容输入…";
  try {
    if (!$("projectRoot").value.trim().startsWith("/")) throw new Error("项目目录必须是绝对路径");
    if (mode === "script" && !$("scriptPath").value.trim()) throw new Error("请选择脚本或文稿");
    if (mode === "topic" && !$("topic").value.trim()) throw new Error("请填写中心选题");
    const result = await api("/api/content/start", {
      scriptPath: mode === "script" ? $("scriptPath").value.trim() : null,
      topic: mode === "topic" ? $("topic").value.trim() : null,
      projectRoot: $("projectRoot").value.trim(), projectId: $("projectId").value.trim() || null,
      show: $("show").value, style: $("style").value, platform: $("platform").value,
    });
    $("resultId").textContent = result.projectId; $("resultPath").textContent = result.projectRoot;
    $("openProject").href = `/project?path=${encodeURIComponent(result.projectRoot)}`;
    $("contentResult").hidden = false;
    toast(result.status === "blocked" ? "项目已建立，但生产运行版本门禁尚未通过" : "内容项目已建立");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = "建立内容项目"; }
});
