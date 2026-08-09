const $ = (id) => document.getElementById(id);
const state = { status: null };
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Kacha-Studio": "1" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}

function toast(message, error = false) {
  const node = $("toast");
  node.textContent = message;
  node.style.background = error ? "#9e3422" : "#1b1a17";
  node.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => { node.hidden = true; }, 4500);
}

function flag(node, label, pass) {
  node.textContent = label;
  node.className = pass ? "pass" : "blocked";
}

function render(status) {
  state.status = status;
  $("projectShell").hidden = false;
  $("projectId").textContent = status.projectId;
  $("projectPath").textContent = status.projectRoot;
  $("taskLabel").textContent = status.task.replaceAll("_", " ").toUpperCase();
  const runtimePass = status.runtime.current.productionReady === true
    || status.runtime.locked.mode === "development";
  flag($("runtimeFlag"), runtimePass ? "运行版本一致" : "运行版本已阻断", runtimePass);
  flag($("inputFlag"), status.input.identityStatus === "pass" ? "输入身份一致" : "输入已变化", status.input.identityStatus === "pass");
  const contentFirst = status.task === "content_generation";
  const v6Label = contentFirst && status.intelligenceV6.required !== true
    ? "V6 录制交接时启用"
    : (status.intelligenceV6.required ? "V6 强制启用" : "V6 未启用");
  flag($("v6Flag"), v6Label, contentFirst || status.intelligenceV6.required === true);

  const currentMilestone = status.milestones.find((item) => item.status === "in_progress")
    || status.milestones.find((item) => item.status !== "complete");
  $("milestoneGrid").innerHTML = status.milestones.map((item, index) => {
    const complete = Number(item.completedStages || 0);
    const total = Number(item.totalStages || item.stages?.length || 0);
    const progress = total ? Math.round((complete / total) * 100) : 0;
    return `<article class="milestone ${item.id === currentMilestone?.id ? "is-active" : ""}">
      <span class="milestone-index">0${index + 1} / ${escapeHtml(item.status.toUpperCase())}</span>
      <div><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(item.summary || item.acceptance || "以当前项目证据完成本里程碑。")}</p></div>
      <div><div class="meter"><i style="width:${progress}%"></i></div><p>${complete} / ${total} 阶段完成</p></div>
    </article>`;
  }).join("");

  $("nextTitle").textContent = status.nextAction?.id?.replaceAll("_", " ") || "等待项目状态";
  $("nextSummary").textContent = status.nextAction?.summary || "当前没有可执行动作。";
  $("runProject").disabled = status.nextAction?.state === "blocked";

  $("assetCard").hidden = !status.assetInbox;
  if (status.assetInbox) {
    const summary = status.assetInbox.summary;
    const ready = summary.productionReady === true;
    const pending = summary.pending
      ?? Math.max(0, Number(summary.total ?? 0) - Number(summary.resolvedByCurrentPlan ?? 0));
    $("assetSummary").textContent = `${summary.total ?? 0} 项 · ${ready ? "已满足当前计划" : `${pending} 项仍待处理`}`;
    $("assetNext").textContent = status.assetInbox.nextAction || "按素材语义、许可和来源证据继续处理。";
  }

  $("stageList").innerHTML = status.stages.map((item, index) => {
    const evidence = item.evidence?.length
      ? item.evidence.map((entry) => entry.path || entry).join(" · ")
      : (item.evidenceContract || []).join(" · ") || "等待真实证据";
    return `<article class="stage"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(item.label || item.id)}</strong><span class="${escapeHtml(item.status)}">${escapeHtml(item.status)}</span><p>${escapeHtml(evidence)}</p></article>`;
  }).join("");
}

async function loadProject({ quiet = false } = {}) {
  const projectRoot = $("projectRoot").value.trim();
  if (!projectRoot) throw new Error("请填写项目目录");
  $("loadProject").disabled = true;
  $("loadStatus").textContent = "正在核对输入身份、运行版本和项目证据…";
  try {
    const status = await api("/api/project/status", { projectRoot });
    render(status);
    $("loadStatus").textContent = `已读取 · ${status.lifecycle.status}`;
    if (!quiet) toast("项目状态已刷新");
  } catch (error) {
    $("loadStatus").textContent = error.message;
    toast(error.message, true);
  } finally { $("loadProject").disabled = false; }
}

async function runCurrent() {
  const projectRoot = $("projectRoot").value.trim();
  if (!projectRoot) return;
  const button = $("runProject");
  button.disabled = true;
  button.textContent = "正在执行安全步骤…";
  try {
    const status = await api("/api/project/run", {
      projectRoot,
      confirmExecute: true,
      includeRender: $("includeRender").checked,
    });
    render(status);
    toast("已保存执行状态；可随时退出后恢复");
  } catch (error) { toast(error.message, true); }
  finally { button.textContent = "确认并继续"; button.disabled = state.status?.nextAction?.state === "blocked"; }
}

const queryPath = new URLSearchParams(window.location.search).get("path");
if (queryPath) { $("projectRoot").value = queryPath; loadProject({ quiet: true }); }
$("loadProject").addEventListener("click", () => loadProject());
$("refreshProject").addEventListener("click", () => loadProject());
$("runProject").addEventListener("click", runCurrent);
