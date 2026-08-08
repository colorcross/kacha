const state = {
  bundlePath: null,
  bundle: null,
  session: null,
  activeId: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Kacha-Studio": "1" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.status === "blocked") throw new Error(value.error || "请求失败");
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
    if ($("reviewVideo").src !== url.href) $("reviewVideo").src = url.href;
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
  render();
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
    $("observeResult").textContent = JSON.stringify({ jobs: result.jobs, metrics: result.metrics, eta: result.eta, cost: result.cost, disk: result.disk }, null, 2);
  } catch (error) { toast(error.message, true); }
});

const query = new URLSearchParams(window.location.search);
if (query.get("bundle")) {
  $("bundlePath").value = query.get("bundle");
  openBundle().catch((error) => toast(error.message, true));
}
