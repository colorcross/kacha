import { escapeHtml, studioHeaders, jsonErrorMessage } from "/shared.js";

const state = {
  bundlePath: null,
  bundle: null,
  session: null,
  activeId: null,
  release: null,
  releaseActiveId: null,
};

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: studioHeaders(),
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.status === "blocked") throw new Error(jsonErrorMessage(value, response));
  return value;
}

function toast(message, error = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("is-error", error);
  element.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("is-visible"), 3600);
}

function sessionRecord(id) {
  return state.session?.decisions?.find((item) => item.decisionId === id) ?? null;
}

function activeDecision() {
  return state.bundle?.decisions.find((item) => item.id === state.activeId) ?? null;
}

function formatSeconds(value) {
  const seconds = Number(value);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

function renderList() {
  $("decisionList").innerHTML = state.bundle.decisions.map((decision, index) => {
    const record = sessionRecord(decision.id);
    return `
      <button
        type="button"
        class="decision-item${decision.id === state.activeId ? " is-active" : ""}"
        data-id="${escapeHtml(decision.id)}"
        data-outcome="${escapeHtml(record?.outcome ?? "pending")}"
      >
        <b>${record ? record.outcome.slice(0, 1).toUpperCase() : String(index + 1).padStart(2, "0")}</b>
        <span><strong>${escapeHtml(decision.title)}</strong><span>${escapeHtml(decision.category)}</span></span>
      </button>
    `;
  }).join("");
  document.querySelectorAll(".decision-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeId = button.dataset.id;
      render();
    });
  });
}

function renderDecision() {
  const decision = activeDecision();
  if (!decision) return;
  $("decisionCategory").textContent = decision.category.toUpperCase();
  $("decisionTitle").textContent = decision.title;
  $("decisionRationale").textContent = decision.rationale;
  $("rangeMeta").textContent = `${formatSeconds(decision.range.start)} — ${formatSeconds(decision.range.end)}`;
  $("proposedValue").textContent = JSON.stringify(decision.proposed);
  $("confidenceValue").textContent = `${Math.round(Number(decision.confidence) * 100)}%`;
  $("fallbackValue").textContent = decision.fallback;
  const record = sessionRecord(decision.id);
  $("reviewNote").value = record?.note ?? "";
  $("adjustedValue").value = record?.adjustedValue ?? "";
  $("resolutionEvidence").value = record?.resolutionEvidence?.path ?? "";
  $("decisionStatus").textContent = record
    ? `已记录：${record.outcome} · ${record.reviewedAt}`
    : "尚未作出判断";
  const hasPreview = Boolean(decision.preview?.after);
  $("noPreview").hidden = hasPreview;
  $("reviewVideo").hidden = !hasPreview;
  if (hasPreview) {
    const url = new URL("/api/review/media", window.location.origin);
    url.searchParams.set("bundle", state.bundlePath);
    url.searchParams.set("decision", decision.id);
    url.searchParams.set("variant", "after");
    const video = $("reviewVideo");
    video.defaultPlaybackRate = 1;
    video.playbackRate = 1;
    if (video.src !== url.href) video.src = url.href;
  } else {
    $("reviewVideo").removeAttribute("src");
    $("reviewVideo").load();
  }
}

function renderEvidence() {
  const summary = state.session?.summary ?? {
    total: state.bundle.decisions.length,
    decided: 0,
    unresolvedChanges: 0,
    readyForCandidate: false,
  };
  $("decisionProgress").textContent = `${summary.decided} / ${summary.total}`;
  $("totalDecisions").textContent = state.bundle.summary.total;
  $("previewDecisions").textContent = state.bundle.summary.withNormalSpeedPreview;
  $("unresolvedChanges").textContent = summary.unresolvedChanges;
  $("candidateReady").textContent = summary.readyForCandidate ? "是" : "否";
  $("projectMeta").textContent = [
    state.bundle.project.id,
    state.bundle.project.showId,
    state.bundle.project.styleId,
  ].join(" · ");
}

function render() {
  renderList();
  renderDecision();
  renderEvidence();
}

async function openBundle() {
  const bundlePath = $("bundlePath").value.trim();
  if (!bundlePath) throw new Error("请先填写审片包路径");
  const result = await api("/api/review/open", { bundlePath });
  state.bundlePath = bundlePath;
  state.bundle = result.bundle;
  state.session = result.session;
  state.activeId = state.bundle.decisions[0]?.id ?? null;
  $("reviewShell").hidden = false;
  $("loadStatus").textContent = `已读取：${result.bundle.project.id}`;
  const guessedRoot = bundlePath.split("/.kacha/")[0];
  if (guessedRoot !== bundlePath) $("projectRoot").value = guessedRoot;
  if (guessedRoot !== bundlePath) {
    $("releaseManifest").value = `${guessedRoot}/contracts/project-manifest.json`;
  }
  render();
}

function activeReleaseCheck() {
  return state.release?.checks?.find((item) => item.id === state.releaseActiveId) ?? null;
}

function renderRelease() {
  if (!state.release) return;
  $("releaseShell").hidden = false;
  $("releaseStatus").textContent = [
    state.release.project.id,
    `${state.release.summary.passed}/${state.release.summary.total} 通过`,
    state.release.summary.approved ? "当前成片已批准" : "尚未批准",
  ].join(" · ");
  $("releaseList").innerHTML = state.release.checks.map((item, index) => `
    <button type="button" class="release-item${item.id === state.releaseActiveId ? " is-active" : ""}" data-release-id="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}">
      <b>${String(index + 1).padStart(2, "0")}</b><span>${escapeHtml(item.label)}</span><em>${escapeHtml(item.status)}</em>
    </button>
  `).join("");
  document.querySelectorAll("[data-release-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.releaseActiveId = button.dataset.releaseId;
      renderRelease();
    });
  });
  const active = activeReleaseCheck();
  if (!active) return;
  $("releaseCheckId").textContent = active.id.toUpperCase();
  $("releaseCheckTitle").textContent = active.label;
  $("releaseEvidence").value = (active.evidence ?? []).join("\n");
  $("releaseNote").value = active.note ?? "";
  $("approveRelease").disabled = !state.release.summary.readyForApproval
    || state.release.summary.approved;
}

async function openRelease() {
  const projectManifestPath = $("releaseManifest").value.trim();
  if (!projectManifestPath) throw new Error("请填写项目 manifest 路径");
  state.release = await api("/api/release/open", { projectManifestPath });
  state.releaseActiveId = state.release.checks[0]?.id ?? null;
  renderRelease();
}

async function initializeRelease() {
  const projectManifestPath = $("releaseManifest").value.trim();
  const reviewer = $("releaseReviewer").value.trim();
  if (!reviewer) throw new Error("请填写审片人");
  state.release = await api("/api/release/initialize", { projectManifestPath, reviewer });
  state.releaseActiveId = state.release.checks[0]?.id ?? null;
  renderRelease();
  toast("发布审片清单已绑定当前最终视频");
}

async function recordRelease(outcome) {
  const active = activeReleaseCheck();
  if (!active) throw new Error("请先选择检查项");
  const reviewer = $("releaseReviewer").value.trim();
  if (!reviewer) throw new Error("请填写审片人");
  state.release = await api("/api/release/record", {
    projectManifestPath: $("releaseManifest").value.trim(),
    reviewer,
    checkId: active.id,
    outcome,
    evidence: $("releaseEvidence").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    note: $("releaseNote").value.trim(),
  });
  renderRelease();
  toast(outcome === "pass" ? "本项检查已通过" : "已建立待编译的返工请求");
}

async function approveRelease() {
  const reviewer = $("releaseReviewer").value.trim();
  if (!reviewer) throw new Error("请填写审片人");
  state.release = await api("/api/release/approve", {
    projectManifestPath: $("releaseManifest").value.trim(),
    reviewer,
    limitations: $("releaseLimitations").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
  });
  renderRelease();
  toast("当前 SHA-256 的本地成片已批准；上传和发布仍需单独授权");
}

async function recordOutcome(outcome) {
  const decision = activeDecision();
  if (!decision) return;
  const result = await api("/api/review/record", {
    bundlePath: state.bundlePath,
    decisionId: decision.id,
    outcome,
    note: $("reviewNote").value.trim(),
    adjustedValue: $("adjustedValue").value.trim() || null,
    resolutionEvidence: $("resolutionEvidence").value.trim() || null,
  });
  state.session = result.session;
  render();
  toast(`已记录：${outcome}`);
}

$("openBundle").addEventListener("click", () => openBundle().catch((error) => toast(error.message, true)));
document.querySelectorAll("[data-outcome]").forEach((button) => {
  button.addEventListener("click", () => recordOutcome(button.dataset.outcome).catch((error) => toast(error.message, true)));
});
$("learnPreferences").addEventListener("click", async () => {
  try {
    if (!state.session) throw new Error("请先打开审片项目");
    const result = await api("/api/review/learn", { sessionPath: state.session.path });
    toast(`偏好候选已生成：${result.candidate.path}`);
  } catch (error) { toast(error.message, true); }
});
$("loadObserve").addEventListener("click", async () => {
  try {
    const result = await api("/api/observe", { projectRoot: $("projectRoot").value.trim() });
    $("observeResult").textContent = JSON.stringify({ jobs: result.jobs, metrics: result.metrics, efficiency: result.efficiency, eta: result.eta, cost: result.cost, disk: result.disk }, null, 2);
  } catch (error) { toast(error.message, true); }
});
$("reviewVideo").addEventListener("ratechange", () => {
  if ($("reviewVideo").playbackRate !== 1) {
    $("reviewVideo").playbackRate = 1;
    toast("语义审片固定使用正常速度 1×", true);
  }
});
$("openRelease").addEventListener("click", () => openRelease().catch((error) => toast(error.message, true)));
$("initializeRelease").addEventListener("click", () => initializeRelease().catch((error) => toast(error.message, true)));
$("releasePass").addEventListener("click", () => recordRelease("pass").catch((error) => toast(error.message, true)));
$("releaseFail").addEventListener("click", () => recordRelease("fail").catch((error) => toast(error.message, true)));
$("approveRelease").addEventListener("click", () => approveRelease().catch((error) => toast(error.message, true)));

const query = new URLSearchParams(window.location.search);
if (query.get("bundle")) {
  $("bundlePath").value = query.get("bundle");
  openBundle().catch((error) => toast(error.message, true));
}
