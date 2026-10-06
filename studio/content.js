import { studioRequest } from "/shared.js";

const $ = (id) => document.getElementById(id);
let mode = "script";
let busy = false;
const api = (path, body) => studioRequest(path, { body });

function status(message, error = false) {
  $("contentStatus").textContent = message;
  $("contentStatus").classList.toggle("error", error);
}
function invalidateResult() {
  $("contentResult").hidden = true;
  $("openProject").removeAttribute("href");
}
function setBusy(value, message) {
  busy = value;
  $("contentFields").disabled = value;
  $("contentForm").setAttribute("aria-busy", String(value));
  $("startContent").textContent = value ? "正在处理…" : "建立内容项目";
  if (message) status(message);
}
function setMode(next) {
  if (busy) return;
  mode = next;
  invalidateResult();
  $("scriptField").hidden = mode !== "script";
  $("topicField").hidden = mode !== "topic";
  document.querySelectorAll("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}
function syncStyles() {
  const legacy = ["tool-share", "book-talk", "infinite-game", "very-ai", "casual-chat"].includes($("show").value);
  for (const option of $("style").options) option.disabled = legacy === (option.value === "dahui-ai");
  if ($("style").selectedOptions[0]?.disabled) $("style").value = legacy ? "xingzhe-light-overlay" : "dahui-ai";
}
document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
$("contentForm").addEventListener("input", invalidateResult);
$("contentForm").addEventListener("change", invalidateResult);
$("show").addEventListener("change", syncStyles);
$("chooseScript").addEventListener("click", async () => {
  if (busy) return;
  invalidateResult(); setBusy(true, "请选择脚本或文稿。");
  try {
    const result = await api("/api/pick-document", {});
    if (!result.cancelled) $("scriptPath").value = result.path;
    status(result.cancelled ? "已取消选择，输入已保留。" : "已选择文稿，填写项目目录后即可建立项目。");
  } catch (error) { status(error.message, true); }
  finally { setBusy(false); }
});
$("contentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  invalidateResult(); setBusy(true, "正在建立内容项目，请等待完成。");
  try {
    const request = {
      scriptPath: mode === "script" ? $("scriptPath").value.trim() : null,
      topic: mode === "topic" ? $("topic").value.trim() : null,
      projectRoot: $("projectRoot").value.trim(), projectId: $("projectId").value.trim() || null,
      show: $("show").value, style: $("style").value, platform: $("platform").value,
    };
    if (!request.projectRoot.startsWith("/")) throw new Error("项目目录必须是绝对路径");
    if (mode === "script" && !request.scriptPath) throw new Error("请选择脚本或文稿");
    if (mode === "topic" && !request.topic) throw new Error("请填写中心选题");
    const result = await api("/api/content/start", request);
    if (typeof result.projectId !== "string" || typeof result.projectRoot !== "string" || !result.projectRoot.startsWith("/")) {
      throw new Error(result.error || "服务未返回有效项目，请核对项目目录后重试。");
    }
    $("resultId").textContent = result.projectId; $("resultPath").textContent = result.projectRoot;
    $("openProject").href = `/project?path=${encodeURIComponent(result.projectRoot)}`;
    $("contentResult").hidden = false;
    status(result.status === "blocked" ? "项目已建立，运行环境尚未就绪。进入项目状态查看待处理项。" : "内容项目已建立。进入项目状态查看录制准备与下一步。");
  } catch (error) { status(error.message, true); }
  finally { setBusy(false); }
});
setMode(mode);
syncStyles();
