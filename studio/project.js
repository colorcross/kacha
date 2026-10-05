const $ = (id) => document.getElementById(id);
import { escapeHtml, studioRequest } from "/shared.js";

const state = { status: null, busy: false, loadedPath: null };
const api = (path, body) => studioRequest(path, { body });
const getApi = (path) => studioRequest(path);

function updateControls() {
  const matched = state.loadedPath === $("projectRoot").value.trim();
  $("runProject").disabled = state.busy || !matched || !state.status?.nextAction
    || state.status.nextAction.state === "blocked";
  for (const id of ["loadProject", "observeProject", "refreshProject", "projectRoot", "includeRender"]) $(id).disabled = state.busy;
  $("projectShell").setAttribute("aria-busy", String(state.busy));
}

function invalidateProject() {
  state.status = null;
  state.loadedPath = null;
  $("projectShell").hidden = true;
  $("observationCard").hidden = true;
  $("includeRender").checked = false;
  $("loadStatus").textContent = "目录已变更，请读取当前项目。";
  updateControls();
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

function clock(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const remainder = Math.floor(value % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function renderEfficiency(efficiency) {
  const card = $("efficiencyCard");
  card.hidden = !efficiency;
  if (!efficiency) return;
  const ranges = efficiency.representativePreview?.ranges ?? [];
  const waves = efficiency.schedule?.waves ?? [];
  const parallel = waves.filter((wave) => wave.parallel);
  const risk = efficiency.risk ?? { level: "unknown", score: 0, factors: [] };
  $("efficiencyRisk").textContent = `${String(risk.level).toUpperCase()} · ${risk.score}`;
  $("efficiencyRiskDetail").textContent = risk.factors?.length
    ? risk.factors.map((factor) => factor.id).join(" · ")
    : "当前没有额外风险信号";
  $("efficiencyRangeCount").textContent = String(ranges.length);
  $("efficiencyRanges").textContent = ranges.length
    ? ranges.map((range) => (
      `${clock(range.startSeconds)}–${clock(range.endSeconds)} ${(range.categories ?? [range.category]).join("/")}`
    )).join(" · ")
    : "等待源媒体或当前区间证据";
  $("efficiencyWaveCount").textContent = `${parallel.length} / ${waves.length}`;
  $("efficiencyWaves").textContent = parallel.length
    ? parallel.map((wave) => wave.stages.join(" + ")).join(" · ")
    : "当前阶段没有可并行工作";
  const cache = efficiency.cache ?? {};
  $("efficiencyCache").textContent = cache.productionReady
    ? "强指纹就绪"
    : cache.applicabilityStatus === "unknown"
      ? "待声明适用项"
      : "证据待补";
  const cacheKinds = cache.kinds ?? [];
  $("efficiencyCacheDetail").textContent = cacheKinds.length
    ? cacheKinds.filter((item) => item.applicability === "applicable")
      .map((item) => `${item.kind}:${item.status}`).join(" · ") || "当前没有已声明适用项"
    : "执行高成本阶段前声明 ASR、分离、蒙版等适用缓存";
  $("efficiencyBoundary").textContent = efficiency.evidenceBoundary?.reason
    || "单项目计划不构成提速证据。";
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
  renderEfficiency(status.efficiency);

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
  updateControls();

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

function renderFlight(flight) {
  const events = flight.events ?? [];
  const counts = Object.entries(flight.counts ?? {})
    .map(([source, count]) => `${source} ${count}`)
    .join(" · ");
  $("flightSummary").textContent = events.length
    ? `${events.length} 个标准化事件 · ${counts || "本地证据"}`
    : "当前项目还没有可读取的运行事件。";
  const list = $("flightList");
  const allowedStatusClasses = new Set(["pass", "complete", "reconciled", "blocked", "fail"]);
  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "flight-empty";
    empty.textContent = "暂无事件；该观察器不会创建或修改生产状态。";
    list.replaceChildren(empty);
    return;
  }
  const nodes = events.slice(-8).reverse().map((event) => {
    const article = document.createElement("article");
    const time = document.createElement("time");
    time.dateTime = event.at;
    time.textContent = new Date(event.at).toLocaleString("zh-CN", { hour12: false });
    const type = document.createElement("strong");
    type.textContent = event.type;
    const status = document.createElement("span");
    status.textContent = event.status || event.source;
    if (allowedStatusClasses.has(event.status)) status.className = event.status;
    const detail = document.createElement("p");
    detail.textContent = event.subject || event.summary || event.sourceRef;
    article.append(time, type, status, detail);
    return article;
  });
  list.replaceChildren(...nodes);
}

async function loadFlight(projectRoot) {
  $("flightSummary").textContent = "正在汇总项目事件、任务、费用和决策证据…";
  try {
    const url = new URL("/api/flight", window.location.origin);
    url.searchParams.set("projectRoot", projectRoot);
    renderFlight(await getApi(url));
  } catch (error) {
    $("flightSummary").textContent = `飞行记录读取失败：${error.message}`;
    const empty = document.createElement("p");
    empty.className = "flight-empty";
    empty.textContent = "观察器保持只读；项目执行不受影响。";
    $("flightList").replaceChildren(empty);
  }
}

async function loadProject({ quiet = false, observe = false } = {}) {
  if (state.busy) return;
  const projectRoot = $("projectRoot").value.trim();
  if (!projectRoot.startsWith("/")) {
    invalidateProject();
    $("loadStatus").textContent = "请填写项目的绝对路径";
    $("projectRoot").focus();
    return;
  }
  invalidateProject();
  state.busy = true;
  updateControls();
  $("loadStatus").textContent = observe ? "正在读取已记录进度…" : "正在核对输入身份、运行版本和项目证据…";
  try {
    const status = await api(observe ? "/api/project/observe" : "/api/project/status", { projectRoot });
    if (observe) {
      $("observationCard").hidden = false;
      $("observationTitle").textContent = status.projectId || projectRoot;
      $("observationSummary").textContent = `${status.progress.complete} / ${status.progress.total} 阶段已记录完成 · ${status.jobs.length} 个近期任务`;
      $("observationBoundary").textContent = status.evidenceBoundary;
      $("observationWarnings").textContent = (status.warnings ?? []).join(" · ");
      $("loadStatus").textContent = "已读取进度；继续执行前请点击“核验并读取”。";
    } else {
      state.loadedPath = projectRoot;
      render(status);
      await loadFlight(status.projectRoot);
      $("loadStatus").textContent = `已核验 · ${status.lifecycle.status}`;
    }
    if (!quiet) toast(observe ? "已读取进度，尚未核验执行条件" : "项目状态已刷新");
  } catch (error) {
    invalidateProject();
    $("loadStatus").textContent = error.message;
    toast(error.message, true);
  } finally { state.busy = false; updateControls(); }
}

async function runCurrent() {
  if (state.busy || !state.status || state.loadedPath !== $("projectRoot").value.trim()
      || !state.status.nextAction || state.status.nextAction.state === "blocked") return;
  const projectRoot = state.status.projectRoot;
  state.busy = true;
  updateControls();
  const button = $("runProject");
  button.textContent = "正在执行安全步骤…";
  try {
    const status = await api("/api/project/run", {
      projectRoot,
      confirmExecute: true,
      includeRender: $("includeRender").checked,
    });
    render(status);
    await loadFlight(projectRoot);
    toast("已保存执行状态；可随时退出后恢复");
  } catch (error) {
    invalidateProject();
    $("loadStatus").textContent = `执行结果需重新核对：${error.message}`;
    toast(error.message, true);
  } finally { state.busy = false; button.textContent = "确认并继续"; updateControls(); }
}

const queryPath = new URLSearchParams(window.location.search).get("path");
if (queryPath) { $("projectRoot").value = queryPath; loadProject({ quiet: true, observe: true }); }
$("projectRoot").addEventListener("input", invalidateProject);
$("projectRoot").addEventListener("keydown", (event) => { if (event.key === "Enter") loadProject({ observe: true }); });
$("loadProject").addEventListener("click", () => loadProject());
$("observeProject").addEventListener("click", () => loadProject({ observe: true }));
$("refreshProject").addEventListener("click", () => loadProject({ observe: true }));
$("runProject").addEventListener("click", runCurrent);
updateControls();
