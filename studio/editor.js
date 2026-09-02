const $ = (selector) => document.querySelector(selector);
import { studioHeaders, jsonErrorMessage } from "/shared.js";

const state = {
  project: null,
  sessionId: null,
  selectedIds: new Set(),
  selectedAssetRef: null,
  activePictureId: null,
  outputTick: 0,
  zoom: 1,
  snap: true,
  pendingInTick: null,
  eventSource: null,
  mutationInFlight: false,
  openGeneration: 0,
  projectGeneration: 0,
  binGeneration: 0,
  workspace: null,
  capabilities: null,
  deliveryProfiles: null,
};

async function api(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: studioHeaders(),
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.status === "blocked") throw new Error(jsonErrorMessage(value, response));
  return value;
}

function setStatus(message, error = false) {
  $("#status").textContent = message;
  $("#status").classList.toggle("error", error);
}

function setLive(mode, label) {
  $("#liveDot").className = `live-dot ${mode}`;
  $("#liveState").textContent = label;
}

function timecode(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const totalMillis = Math.round(safe * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":")
    + `.${String(millis).padStart(3, "0")}`;
}

function projection() { return state.project?.projection ?? null; }
function ticksToSeconds(tick) { return Number(tick) / projection().timebase.ticksPerSecond; }
function frameTick() { return projection().timebase.ticksPerFrame; }
function alignFrame(tick) { return Math.round(Number(tick) / frameTick()) * frameTick(); }
function itemById(id) { return projection()?.items.find((item) => item.id === id) ?? null; }
function selectedItems() { return [...state.selectedIds].map(itemById).filter(Boolean); }
function pictureItems() { return projection().items.filter((item) => item.type === "picture").sort((a, b) => a.startTick - b.startTick); }

const drawers = [
  ["#capabilitiesButton", "#capabilityDrawer"],
  ["#deliveryButton", "#deliveryDrawer"],
  ["#activityButton", "#activityDrawer"],
];

function toggleDrawer(buttonSelector, drawerSelector) {
  const button = $(buttonSelector); const drawer = $(drawerSelector); const opening = drawer.hidden;
  for (const [otherButtonSelector, otherDrawerSelector] of drawers) {
    $(otherDrawerSelector).hidden = true;
    $(otherButtonSelector).setAttribute("aria-expanded", "false");
  }
  drawer.hidden = !opening;
  button.setAttribute("aria-expanded", String(opening));
}

function renderWorkspace(workspace) {
  state.workspace = workspace ?? null;
  const switcher = $("#timelineSwitcher"); switcher.innerHTML = "";
  if (!workspace) {
    const option = document.createElement("option"); option.value = ""; option.textContent = "独立 Timeline"; switcher.append(option);
    switcher.disabled = true; $("#duplicateTimelineButton").disabled = true; $("#workspaceLabel").textContent = "独立 Timeline"; return;
  }
  $("#workspaceLabel").textContent = workspace.label;
  for (const timeline of workspace.timelines) {
    const option = document.createElement("option"); option.value = timeline.id;
    option.textContent = `${timeline.label} · ${timeline.role} · ${timeline.projection.width}×${timeline.projection.height}`;
    switcher.append(option);
  }
  const activePath = state.project?.session?.timelinePath;
  switcher.value = workspace.timelines.find((timeline) => timeline.absolutePath === activePath)?.id ?? workspace.activeTimelineId;
  switcher.disabled = false; $("#duplicateTimelineButton").disabled = false;
}

function renderCapabilities(value) {
  state.capabilities = value; const grid = $("#capabilityGrid"); grid.innerHTML = "";
  const counts = value.counts ?? {}; $("#capabilityMeta").textContent = `AVAILABLE ${counts.available ?? 0} · PARTIAL ${counts.partial ?? 0} · PLANNED ${counts.planned ?? 0} · BLOCKED ${counts.blocked ?? 0}`;
  for (const capability of value.capabilities ?? []) {
    const card = document.createElement("article"); card.className = "capability-card";
    const head = document.createElement("div"); head.className = "capability-head";
    const title = document.createElement("h3"); title.textContent = capability.label;
    const pill = document.createElement("span"); pill.className = `status-pill ${capability.status}`; pill.textContent = capability.status.toUpperCase(); head.append(title, pill);
    const category = document.createElement("div"); category.className = "capability-category"; category.textContent = capability.category;
    const limitation = document.createElement("p"); limitation.textContent = capability.limitations?.[0] ?? "无已知局限";
    const evidence = document.createElement("p"); evidence.className = "capability-evidence"; evidence.textContent = capability.evidence?.length ? `证据：${capability.evidence.join(" · ")}` : "证据：尚无可执行证据";
    const entry = document.createElement("p"); entry.className = "capability-entry"; entry.textContent = capability.entryPoints?.length ? `入口：${capability.entryPoints.join(" · ")}` : "解锁前无执行入口";
    card.append(head, category, limitation, evidence, entry); grid.append(card);
  }
}

function renderDeliveryProfiles(value) {
  state.deliveryProfiles = value; const select = $("#deliveryProfile"); select.innerHTML = "";
  let firstAvailable = null;
  for (const profile of value.profiles ?? []) {
    const option = document.createElement("option"); option.value = profile.id; option.disabled = profile.status !== "available";
    if (profile.status === "available" && firstAvailable === null) firstAvailable = profile.id;
    const runtime = profile.status === "available"
      ? `${profile.selectedEncoder} + ${profile.selectedAudioEncoder}`
      : `blocked: ${(profile.blockedReasons ?? []).join(", ") || "runtime"}`;
    option.textContent = `${profile.id} · ${runtime} · ${profile.container.toUpperCase()}`; select.append(option);
  }
  if (firstAvailable !== null) select.value = firstAvailable;
  const submit = $("#deliveryPlanForm")?.querySelector('button[type="submit"]');
  if (submit) submit.disabled = firstAvailable === null;
}

async function refreshActivity() {
  if (!state.sessionId) return;
  const result = await api("/api/editor/history", { sessionId: state.sessionId });
  const list = $("#activityList"); list.innerHTML = "";
  const records = [...(result.records ?? [])].reverse().slice(0, 50);
  if (!records.length) { list.innerHTML = '<p class="empty compact">Command Journal 尚无写入。</p>'; return; }
  for (const record of records) {
    const row = document.createElement("article"); row.className = "activity-item";
    const at = document.createElement("span"); at.textContent = record.at;
    const body = document.createElement("code"); body.textContent = `${record.action} / ${record.operation} / ${record.commandId}`;
    const meta = document.createElement("span"); meta.textContent = `${record.actor ?? "unknown"} · QC ${(record.requiredQc ?? []).join(", ") || "none"}`;
    row.append(at, body, meta); list.append(row);
  }
}

function pictureAt(tick) {
  return pictureItems().filter((item) => item.startTick <= tick && tick < item.endTick).at(-1) ?? null;
}

function timelineLaneWidth() { return document.querySelector(".track-lane")?.clientWidth ?? 1100 * state.zoom; }

function snapTick(raw, ignoredIds = new Set()) {
  let tick = alignFrame(Math.max(0, Math.min(raw, projection().durationTick)));
  if (!state.snap) return tick;
  const threshold = projection().durationTick / Math.max(1, timelineLaneWidth()) * 8;
  const candidates = [0, projection().durationTick];
  for (const item of projection().items) if (!ignoredIds.has(item.id)) candidates.push(item.startTick, item.endTick);
  for (const marker of projection().editor?.markers ?? []) candidates.push(marker.tick);
  const nearest = candidates.reduce((best, candidate) => (
    Math.abs(candidate - tick) < Math.abs(best - tick) ? candidate : best
  ), tick);
  return Math.abs(nearest - tick) <= threshold ? nearest : tick;
}

function interpolate(points, tick, fallback) {
  if (!Array.isArray(points) || points.length === 0) return Number(fallback);
  if (tick <= points[0].tick) return Number(points[0].value);
  if (tick >= points.at(-1).tick) return Number(points.at(-1).value);
  const rightIndex = points.findIndex((point) => point.tick >= tick);
  const left = points[rightIndex - 1]; const right = points[rightIndex];
  const ratio = (tick - left.tick) / Math.max(1, right.tick - left.tick);
  return Number(left.value) + (Number(right.value) - Number(left.value)) * ratio;
}

function updatePlayhead() {
  const value = projection();
  if (!value) return;
  const ratio = state.outputTick / Math.max(1, value.durationTick);
  $("#timecode").textContent = timecode(ticksToSeconds(state.outputTick));
  $("#playhead").style.left = `calc(var(--track-label) + ${ratio * timelineLaneWidth()}px)`;
  renderOverlayProjection();
  renderKeyframes();
}

function seekOutputTick(outputTick) {
  const value = projection();
  if (!value) return;
  state.outputTick = Math.max(0, Math.min(Number(outputTick) || 0, value.durationTick));
  const picture = pictureAt(state.outputTick);
  state.activePictureId = picture?.id ?? null;
  if (picture && $("#video").src) {
    const sourceTick = picture.metadata.sourceStartTick + state.outputTick - picture.startTick;
    const sourceSeconds = ticksToSeconds(sourceTick);
    if (Math.abs($("#video").currentTime - sourceSeconds) > .02) $("#video").currentTime = sourceSeconds;
  }
  updatePlayhead();
}

function renderRuler() {
  const ruler = $("#ruler"); ruler.innerHTML = "";
  const duration = Math.max(1, projection().durationSeconds);
  for (let index = 0; index <= 10; index += 1) {
    const tick = document.createElement("span");
    tick.className = "ruler-tick"; tick.style.left = `${index * 10}%`;
    tick.textContent = timecode(duration * index / 10).slice(0, 8); ruler.append(tick);
  }
  ruler.onclick = (event) => {
    const bounds = ruler.getBoundingClientRect();
    const x = Math.max(0, Math.min(event.clientX - bounds.left, bounds.width));
    seekOutputTick(snapTick(x / Math.max(1, bounds.width) * projection().durationTick));
  };
}

function selectItem(itemId, additive = false) {
  if (!additive) state.selectedIds.clear();
  if (additive && state.selectedIds.has(itemId)) state.selectedIds.delete(itemId);
  else state.selectedIds.add(itemId);
  renderSelection();
}

function renderSelection() {
  document.querySelectorAll(".clip,.overlay-box").forEach((node) => node.classList.toggle("selected", state.selectedIds.has(node.dataset.id)));
  $("#selectionSummary").textContent = `${state.selectedIds.size} SELECTED`;
  const items = selectedItems();
  if (items.length !== 1) {
    $("#emptyInspector").hidden = false; $("#inspector").hidden = true; $("#keyframePanel").hidden = true;
    $("#emptyInspector").innerHTML = items.length > 1 ? `已选 ${items.length} 项。拖动任一可移动条目进行组合位移。` : `从时间线选择一个条目。<br><kbd>Shift</kbd> 可多选。`;
    return;
  }
  const item = items[0];
  $("#emptyInspector").hidden = true; $("#inspector").hidden = false;
  $("#itemLabel").textContent = item.label; $("#itemType").textContent = item.type; $("#sourcePointer").textContent = item.sourcePointer;
  const fields = $("#fieldList"); fields.innerHTML = "";
  for (const field of item.editableFields) {
    const label = document.createElement("label"); const title = document.createElement("span"); title.textContent = field;
    const input = document.createElement("input"); input.type = "number"; input.required = true;
    const binding = item.editBindings[field]; input.step = field.endsWith("Tick") ? String(binding?.frameAligned ? frameTick() : 1) : ".01";
    input.name = field; input.value = item.metadata[field] ?? item[field] ?? ""; input.dataset.original = input.value;
    label.append(title, input); fields.append(label);
  }
  const readOnly = item.readOnlyReasons?.join("；") ?? "";
  $("#readonlyReason").hidden = !readOnly; $("#readonlyReason").textContent = readOnly;
  $("#keyframePanel").hidden = item.type !== "overlay";
  renderKeyframes();
}

async function runCommand(command, successMessage) {
  if (!projection()) return;
  if (state.mutationInFlight) { setStatus("上一个编辑命令尚未完成。", true); return; }
  const sessionId = state.sessionId;
  state.mutationInFlight = true;
  try {
    const result = await api("/api/editor/command", {
      sessionId,
      command: {
        schemaVersion: "1.0", kind: "kacha-editor-command",
        baseSha256: state.project.session.currentSha256,
        actor: "studio-user", reason: $("#reason").value.trim(), ...command,
      },
    });
    if (state.sessionId !== sessionId) return;
    renderProject(result.project);
    $("#qcNotice").textContent = `需要重新执行：${result.requiredQc.join("、")}`;
    setStatus(`${successMessage}；Command ${result.commandId} 已原子写入，尚未重新渲染。`);
  } catch (error) { if (state.sessionId === sessionId) setStatus(error.message, true); }
  finally { if (state.sessionId === sessionId) state.mutationInFlight = false; }
}

function attachClipDrag(clip, item, lane) {
  const startHandle = document.createElement("span"); startHandle.className = "trim-handle start";
  const endHandle = document.createElement("span"); endHandle.className = "trim-handle end";
  for (const [handle, edge] of [[startHandle, "start"], [endHandle, "end"]]) {
    if (item.type === "sfx" || !item.editableFields.some((field) => field === `${edge}Tick` || field === `source${edge[0].toUpperCase()}${edge.slice(1)}Tick`)) continue;
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault(); event.stopPropagation(); selectItem(item.id);
      const originX = event.clientX; const originTick = edge === "start" ? item.startTick : item.endTick;
      handle.setPointerCapture(event.pointerId);
      const move = (next) => {
        const tick = snapTick(originTick + (next.clientX - originX) / Math.max(1, lane.clientWidth) * projection().durationTick, new Set([item.id]));
        const left = edge === "start" ? tick : item.startTick; const right = edge === "end" ? tick : item.endTick;
        if (right <= left) return;
        clip.style.left = `${left / projection().durationTick * 100}%`; clip.style.width = `${(right - left) / projection().durationTick * 100}%`; clip.dataset.previewTick = String(tick);
      };
      const cleanup = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", cancel);
      };
      const up = () => {
        cleanup();
        const tick = Number(clip.dataset.previewTick ?? originTick); delete clip.dataset.previewTick;
        if (tick !== originTick) runCommand({ itemId: item.id, operation: item.type === "picture" ? "ripple_trim" : "trim", arguments: { edge, outputTick: tick } }, item.type === "picture" ? `已波纹修剪 ${item.label}` : `已修剪 ${item.label}`);
      };
      const cancel = () => { cleanup(); delete clip.dataset.previewTick; renderTracks(); renderSelection(); };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", cancel);
    });
    clip.append(handle);
  }
  if (item.type === "picture" || !item.editableFields.some((field) => ["startTick", "targetLandingTick", "timeTick"].includes(field))) return;
  clip.addEventListener("pointerdown", (event) => {
    if (event.target.classList.contains("trim-handle")) return;
    event.preventDefault(); selectItem(item.id, event.shiftKey || event.metaKey);
    const movable = selectedItems().filter((candidate) => candidate.type !== "picture" && candidate.editableFields.some((field) => ["startTick", "targetLandingTick", "timeTick"].includes(field)));
    if (!movable.some((candidate) => candidate.id === item.id)) return;
    const originX = event.clientX; let deltaTick = 0; clip.setPointerCapture(event.pointerId);
    const move = (next) => {
      const raw = (next.clientX - originX) / Math.max(1, lane.clientWidth) * projection().durationTick;
      deltaTick = snapTick(item.startTick + raw, new Set(movable.map((candidate) => candidate.id))) - item.startTick;
      for (const candidate of movable) {
        const node = document.querySelector(`.clip[data-id="${CSS.escape(candidate.id)}"]`);
        if (node) node.style.transform = `translateX(${deltaTick / projection().durationTick * lane.clientWidth}px)`;
      }
    };
    const cleanup = () => {
      clip.removeEventListener("pointermove", move);
      clip.removeEventListener("pointerup", up);
      clip.removeEventListener("pointercancel", cancel);
      document.querySelectorAll(".clip").forEach((node) => { node.style.transform = ""; });
    };
    const up = () => {
      cleanup();
      if (deltaTick) runCommand({ operation: "move", arguments: { itemIds: movable.map((candidate) => candidate.id), deltaTick } }, `已移动 ${movable.length} 项`);
    };
    const cancel = () => cleanup();
    clip.addEventListener("pointermove", move);
    clip.addEventListener("pointerup", up);
    clip.addEventListener("pointercancel", cancel);
  });
}

function renderTracks() {
  const tracks = $("#tracks"); tracks.innerHTML = ""; const duration = Math.max(1, projection().durationTick);
  for (const track of projection().tracks) {
    const row = document.createElement("div"); row.className = "track";
    const label = document.createElement("div"); label.className = "track-label"; label.textContent = track.label;
    const lane = document.createElement("div"); lane.className = "track-lane";
    for (const itemId of track.itemIds) {
      const item = itemById(itemId); const clip = document.createElement("button"); clip.type = "button"; clip.className = "clip";
      clip.dataset.id = item.id; clip.dataset.type = item.type; clip.style.left = `${item.startTick / duration * 100}%`; clip.style.width = `${Math.max(.35, (item.endTick - item.startTick) / duration * 100)}%`;
      clip.textContent = item.label; clip.title = `${item.label}\n${timecode(ticksToSeconds(item.startTick))} – ${timecode(ticksToSeconds(item.endTick))}`;
      clip.addEventListener("click", (event) => { selectItem(item.id, event.shiftKey || event.metaKey); if (state.outputTick < item.startTick || state.outputTick >= item.endTick) seekOutputTick(item.startTick); });
      attachClipDrag(clip, item, lane); lane.append(clip);
    }
    row.append(label, lane); tracks.append(row);
  }
}

function renderTimelineOverlays() {
  const markers = $("#markerLayer"); markers.innerHTML = "";
  const current = projection();
  if (!current) { $("#workArea").hidden = true; return; }
  for (const marker of current.editor?.markers ?? []) {
    const node = document.createElement("span"); node.className = "marker"; node.style.left = `${marker.tick / current.durationTick * 100}%`; node.dataset.label = marker.label; markers.append(node);
  }
  const work = current.editor?.workArea; const layer = $("#workArea"); layer.hidden = !work;
  if (work) { layer.style.left = `calc(var(--track-label) + ${work.startTick / current.durationTick * timelineLaneWidth()}px)`; layer.style.width = `${(work.endTick - work.startTick) / current.durationTick * timelineLaneWidth()}px`; }
}

function renderOverlayProjection() {
  const layer = $("#overlayLayer"); const video = $("#video"); layer.innerHTML = "";
  const width = video.clientWidth; const height = video.clientHeight; layer.style.width = `${width}px`; layer.style.height = `${height}px`;
  if (!projection() || width === 0 || height === 0) return;
  const outputWidth = Number(projection().output.width || video.videoWidth || 1); const outputHeight = Number(projection().output.height || video.videoHeight || 1);
  for (const item of projection().items.filter((candidate) => candidate.type === "overlay" && state.outputTick >= candidate.startTick && state.outputTick < candidate.endTick)) {
    const currentX = interpolate(item.metadata.keyframes?.x, state.outputTick, item.metadata.x); const currentY = interpolate(item.metadata.keyframes?.y, state.outputTick, item.metadata.y);
    const box = document.createElement("div"); box.className = "overlay-box"; box.dataset.id = item.id; box.dataset.label = item.label;
    box.style.left = `${currentX / outputWidth * width}px`; box.style.top = `${currentY / outputHeight * height}px`; box.style.width = `${Number(item.metadata.width) / outputWidth * width}px`; box.style.height = `${Number(item.metadata.height) / outputHeight * height}px`; box.style.opacity = String(item.metadata.opacity ?? 1);
    const resize = document.createElement("span"); resize.className = "resize-handle"; box.append(resize);
    const begin = (event, resizing) => {
      event.preventDefault(); selectItem(item.id); const origin = { x: event.clientX, y: event.clientY, left: currentX, top: currentY, width: Number(item.metadata.width), height: Number(item.metadata.height) }; box.setPointerCapture(event.pointerId);
      let changes = {};
      const move = (next) => {
        const dx = (next.clientX - origin.x) * outputWidth / Math.max(1, width); const dy = (next.clientY - origin.y) * outputHeight / Math.max(1, height);
        if (resizing) {
          const nextWidth = Math.max(8, Math.min(outputWidth - origin.left, origin.width + dx)); const nextHeight = Math.max(8, Math.min(outputHeight - origin.top, origin.height + dy)); changes = { width: nextWidth, height: nextHeight }; box.style.width = `${nextWidth / outputWidth * width}px`; box.style.height = `${nextHeight / outputHeight * height}px`;
        } else {
          const x = Math.max(0, Math.min(outputWidth - origin.width, origin.left + dx)); const y = Math.max(0, Math.min(outputHeight - origin.height, origin.top + dy)); changes = { x, y }; box.style.left = `${x / outputWidth * width}px`; box.style.top = `${y / outputHeight * height}px`;
        }
      };
      const cleanup = () => {
        box.removeEventListener("pointermove", move);
        box.removeEventListener("pointerup", up);
        box.removeEventListener("pointercancel", cancel);
      };
      const up = () => {
        cleanup();
        if (!Object.keys(changes).length) return;
        const positionKeyframed = !resizing && ["x", "y"].some((property) => (item.metadata.keyframes?.[property]?.length ?? 0) > 0);
        if (positionKeyframed) {
          runCommand({
            itemId: item.id,
            operation: "keyframe_set",
            arguments: { tick: alignFrame(state.outputTick), values: changes },
          }, "已在当前帧调整叠加层位置关键帧");
        } else {
          runCommand({ itemId: item.id, changes }, resizing ? "已调整叠加层尺寸" : "已调整叠加层位置");
        }
      };
      const cancel = () => { cleanup(); renderOverlayProjection(); };
      box.addEventListener("pointermove", move);
      box.addEventListener("pointerup", up);
      box.addEventListener("pointercancel", cancel);
    };
    box.addEventListener("pointerdown", (event) => begin(event, event.target === resize)); layer.append(box);
  }
  renderSelection();
}

function renderKeyframes() {
  const item = selectedItems().length === 1 ? selectedItems()[0] : null; const list = $("#keyframeList"); list.innerHTML = "";
  if (item?.type !== "overlay") return;
  for (const property of ["x", "y"]) for (const point of item.metadata.keyframes?.[property] ?? []) {
    const row = document.createElement("div"); row.textContent = `${property.toUpperCase()} · ${timecode(ticksToSeconds(point.tick))} · ${Number(point.value).toFixed(1)}`; list.append(row);
  }
}

function renderDeliveryFrames() {
  const select = $("#deliveryFrame"); const current = select.value; select.innerHTML = '<option value="">原始画布</option>';
  for (const frame of projection().editor?.deliveryFrames ?? []) { const option = document.createElement("option"); option.value = frame.id; option.textContent = `${frame.label} · ${frame.width}×${frame.height}`; select.append(option); }
  if ([...select.options].some((option) => option.value === current)) select.value = current; updateDeliveryGuide();
}

function updateDeliveryGuide() {
  const guide = $("#deliveryGuide"); const frame = projection()?.editor?.deliveryFrames?.find((item) => item.id === $("#deliveryFrame").value);
  guide.hidden = !frame; if (!frame) return;
  const video = $("#video"); const width = video.clientWidth; const height = video.clientHeight; const target = frame.width / frame.height; let guideWidth = width; let guideHeight = width / target;
  if (guideHeight > height) { guideHeight = height; guideWidth = height * target; }
  guide.style.width = `${guideWidth}px`; guide.style.height = `${guideHeight}px`; guide.querySelector("span").textContent = `${frame.label} ${frame.width}×${frame.height}`;
}

function renderProject(project) {
  if (project.workspace === undefined && state.workspace) project = { ...project, workspace: state.workspace };
  state.project = project; const value = project.projection; state.outputTick = Math.min(state.outputTick, value.durationTick);
  $("#workspace").hidden = false; $("#projectMeta").textContent = `${value.projectId} · ${value.timebase.frameRate} · ${timecode(value.durationSeconds)}`;
  $("#undoButton").disabled = !project.session.canUndo; $("#redoButton").disabled = !project.session.canRedo;
  $("#timelineViewport").style.setProperty("--timeline-width", `${1100 * state.zoom}px`);
  for (const id of [...state.selectedIds]) if (!value.items.some((item) => item.id === id)) state.selectedIds.delete(id);
  renderWorkspace(project.workspace); renderRuler(); renderTracks(); renderTimelineOverlays(); renderDeliveryFrames(); renderSelection(); seekOutputTick(state.outputTick);
}

async function refreshProject(reason = "external change") {
  const sessionId = state.sessionId;
  const generation = ++state.projectGeneration;
  try {
    const project = await api("/api/editor/project", { sessionId });
    if (sessionId !== state.sessionId || generation !== state.projectGeneration) return;
    renderProject(project);
    if (project.status === "conflict") { setLive("conflict", "CONFLICT"); setStatus(`Timeline 已被其他进程修改（${reason}）；已停止自动写入，请检查 history/reopen。`, true); }
  } catch (error) {
    if (sessionId !== state.sessionId || generation !== state.projectGeneration) return;
    setLive("conflict", "BLOCKED"); setStatus(error.message, true);
  }
}

function connectEvents() {
  state.eventSource?.close();
  const sessionId = state.sessionId;
  const source = new EventSource(`/api/editor/events?session=${encodeURIComponent(sessionId)}`); state.eventSource = source;
  source.addEventListener("revision", (event) => {
    if (source !== state.eventSource || sessionId !== state.sessionId) return;
    const revision = JSON.parse(event.data);
    if (revision.status === "expired" || revision.reason === "session_expired") {
      source.close();
      if (state.eventSource === source) state.eventSource = null;
      setLive("conflict", "EXPIRED");
      setStatus(revision.error ?? "Editor browser session 已过期，请重新打开 Timeline。", true);
      return;
    }
    if (revision.conflict) { setLive("conflict", "CONFLICT"); if (!state.mutationInFlight) refreshProject(revision.reason); return; }
    setLive("live", "LIVE");
    if (!state.mutationInFlight && state.project && revision.timelineSha256 !== state.project.session.currentSha256) refreshProject(revision.reason);
  });
  source.onerror = () => { if (source === state.eventSource && sessionId === state.sessionId) setLive("idle", "RECONNECTING"); };
}

async function refreshBin() {
  if (!state.sessionId) return;
  const sessionId = state.sessionId;
  const generation = ++state.binGeneration;
  const request = { sessionId, query: $("#binQuery").value.trim(), kind: $("#binKind").value || null, limit: 40 };
  $("#binItems").innerHTML = '<div class="empty compact">正在核验素材身份……</div>';
  try {
    const result = await api("/api/editor/bin", request);
    if (sessionId !== state.sessionId || generation !== state.binGeneration) return;
    $("#binMeta").textContent = result.mediaIndex
      ? `${result.returned} 项 · ${result.status.toUpperCase()} · ${result.staleExcluded} stale / ${result.outsideRootExcluded ?? 0} outside excluded`
      : result.limitations[0];
    const container = $("#binItems"); container.innerHTML = "";
    if (!result.items.length) { container.innerHTML = '<div class="empty compact">没有匹配的当前有效素材。</div>'; return; }
    for (const asset of result.items) {
      const card = document.createElement("article"); card.className = "bin-item"; card.dataset.ref = asset.ref;
      const safe = asset.replacementEligible === true;
      card.innerHTML = `<div class="bin-title-row"><strong class="bin-name"></strong><span class="kind-badge"></span></div><div class="bin-path"></div><div class="tag-row"></div><button class="replace-button" type="button">替换当前素材</button>`;
      card.querySelector(".bin-name").textContent = asset.name; card.querySelector(".kind-badge").textContent = asset.kind; card.querySelector(".bin-path").textContent = asset.relativePath;
      const tags = card.querySelector(".tag-row"); const license = document.createElement("span"); license.className = `license-badge ${safe ? "safe" : "risk"}`; license.textContent = asset.license; tags.append(license);
      for (const tag of asset.tags.slice(0, 4)) { const span = document.createElement("span"); span.className = "tag"; span.textContent = tag; tags.append(span); }
      card.onclick = () => { state.selectedAssetRef = asset.ref; document.querySelectorAll(".bin-item").forEach((node) => node.classList.toggle("selected", node === card)); };
      const replaceButton = card.querySelector("button"); replaceButton.disabled = !safe; replaceButton.title = safe ? "" : "许可或 provenance 未验证，禁止替换";
      replaceButton.onclick = (event) => { event.stopPropagation(); if (!safe) { setStatus(replaceButton.title, true); return; } const item = selectedItems().length === 1 ? selectedItems()[0] : null; if (!item) { setStatus("请先在时间线选择一个可替换素材。", true); return; } runCommand({ itemId: item.id, operation: "replace_media", arguments: { assetRef: asset.ref } }, `已用 ${asset.name} 替换素材`); };
      container.append(card);
    }
  } catch (error) {
    if (sessionId !== state.sessionId || generation !== state.binGeneration) return;
    $("#binItems").innerHTML = `<div class="empty compact"></div>`; $("#binItems .empty").textContent = error.message;
  }
}

function loadWaveform() {
  const image = $("#waveformImage"); image.hidden = true; $("#waveformState").hidden = false; $("#waveformState").textContent = "异步生成本地波形……";
  image.onload = () => { image.hidden = false; $("#waveformState").hidden = true; };
  image.onerror = () => { image.hidden = true; $("#waveformState").hidden = false; $("#waveformState").textContent = "无可用音频波形"; };
  image.src = `/api/editor/waveform?session=${encodeURIComponent(state.sessionId)}&width=1600&v=${Date.now()}`;
}

async function openProjectPath(timelinePath, timelineId = null) {
  if (state.mutationInFlight) { setStatus("请等当前编辑命令完成后再打开新 Timeline。", true); return; }
  const generation = ++state.openGeneration;
  for (const id of ["#capabilitiesButton", "#deliveryButton", "#activityButton"]) $(id).disabled = true;
  setStatus("正在验证 Timeline IR、源媒体身份、时间基和编辑历史……");
  try {
    const result = await api("/api/editor/open", { timelinePath, timelineId });
    if (generation !== state.openGeneration) return;
    state.projectGeneration += 1; state.binGeneration += 1;
    state.sessionId = result.browserSessionId; state.selectedIds.clear(); state.selectedAssetRef = null; state.pendingInTick = null; state.outputTick = 0; state.activePictureId = null;
    const video = $("#video"); video.src = result.projection.timeline.source ? `/api/editor/media?session=${encodeURIComponent(state.sessionId)}` : ""; renderProject(result);
    $("#activityButton").disabled = false;
    connectEvents(); refreshBin(); if (video.src) loadWaveform(); else updatePlayhead();
    const [capabilities, profiles] = await Promise.all([
      api("/api/editor/capabilities", { sessionId: state.sessionId }),
      api("/api/editor/delivery-profiles", { sessionId: state.sessionId }),
    ]);
    if (generation !== state.openGeneration) return;
    renderCapabilities(capabilities); renderDeliveryProfiles(profiles);
    $("#capabilitiesButton").disabled = false; $("#deliveryButton").disabled = false;
    refreshActivity().catch(() => {});
    setStatus(`已打开 ${result.projection.projectId}；近似预览与正式终渲染边界有效。`);
  } catch (error) { if (generation === state.openGeneration) setStatus(error.message, true); }
}

$("#openForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await openProjectPath($("#timelinePath").value.trim());
});

$("#inspector").addEventListener("submit", (event) => {
  event.preventDefault(); const item = selectedItems()[0];
  if (!item) { setStatus("请先选择一个条目。", true); return; }
  const changes = {};
  for (const field of item.editableFields) {
    const input = $(`#fieldList input[name='${field}']`);
    if (!input || input.value.trim() === "" || !Number.isFinite(input.valueAsNumber)) {
      setStatus(`${field} 必须是有效数字，不能留空。`, true);
      input?.focus();
      return;
    }
    if (input.valueAsNumber !== Number(input.dataset.original)) changes[field] = input.valueAsNumber;
  }
  if (!Object.keys(changes).length) { setStatus("没有检测到需要写入的变化。", true); return; }
  runCommand({ itemId: item.id, changes }, `已更新 ${item.label}`);
});

for (const [selector, endpoint] of [["#undoButton", "undo"], ["#redoButton", "redo"]]) $(selector).onclick = async () => {
  if (state.mutationInFlight) { setStatus("上一个编辑命令尚未完成。", true); return; }
  const sessionId = state.sessionId;
  state.mutationInFlight = true;
  try {
    const result = await api(`/api/editor/${endpoint}`, { sessionId, baseSha256: state.project.session.currentSha256 });
    if (state.sessionId !== sessionId) return;
    renderProject(result.project); setStatus(`${endpoint === "undo" ? "撤销" : "重做"} ${result.commandId} 完成；尚未重新渲染。`);
  } catch (error) { if (state.sessionId === sessionId) setStatus(error.message, true); }
  finally { if (state.sessionId === sessionId) state.mutationInFlight = false; }
};

$("#snapButton").onclick = () => { state.snap = !state.snap; $("#snapButton").classList.toggle("active", state.snap); $("#snapButton").setAttribute("aria-pressed", String(state.snap)); };
$("#markerButton").onclick = () => { const tick = alignFrame(state.outputTick); runCommand({ operation: "marker_set", arguments: { marker: { id: `marker-${tick}`, tick, label: `MARK ${timecode(ticksToSeconds(tick)).slice(3, 8)}` } } }, "已添加标记"); };
$("#inButton").onclick = () => { state.pendingInTick = alignFrame(state.outputTick); setStatus(`工作区入点：${timecode(ticksToSeconds(state.pendingInTick))}`); };
$("#outButton").onclick = () => { const endTick = alignFrame(state.outputTick); if (state.pendingInTick === null || endTick <= state.pendingInTick) { setStatus("请先设置更早的入点。", true); return; } runCommand({ operation: "work_area_set", arguments: { startTick: state.pendingInTick, endTick } }, "已设置工作区"); };
$("#splitButton").onclick = () => { const picture = selectedItems().find((item) => item.type === "picture") ?? pictureAt(state.outputTick); if (!picture || state.outputTick <= picture.startTick || state.outputTick >= picture.endTick) { setStatus("播放头必须位于主画面片段内部。", true); return; } runCommand({ itemId: picture.id, operation: "split", arguments: { outputTick: alignFrame(state.outputTick), newId: `${picture.label}-split-${state.outputTick}` } }, `已分割 ${picture.label}`); };
$("#overwriteButton").onclick = () => {
  const picture = selectedItems().find((item) => item.type === "picture"); const area = projection()?.editor?.workArea;
  if (!picture || !area) { setStatus("覆盖需要选中一个主画面片段，并用 [ / ] 设置工作区。", true); return; }
  const duration = area.endTick - area.startTick; const sourceStartTick = picture.metadata.sourceStartTick; const sourceEndTick = sourceStartTick + duration;
  if (sourceEndTick > picture.metadata.sourceEndTick) { setStatus("已选片段的源区间短于覆盖工作区。", true); return; }
  runCommand({ operation: "overwrite", arguments: {
    outputStartTick: area.startTick, outputEndTick: area.endTick, sourceStartTick, sourceEndTick,
    newId: `overwrite-${area.startTick}-${sourceStartTick}`, sourceDecisionId: null, semanticBeatId: null, reason: "studio work-area overwrite",
  } }, `已用 ${picture.label} 的源区间覆盖工作区`);
};

function reorderPicture(direction) {
  const selected = selectedItems().find((item) => item.type === "picture"); if (!selected) { setStatus("请选择一个主画面片段。", true); return; }
  const ids = pictureItems().map((item) => item.id); const index = ids.indexOf(selected.id); const target = index + direction; if (target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]]; runCommand({ operation: "reorder", arguments: { itemIds: ids } }, `已重排 ${selected.label}`);
}
$("#moveLeftButton").onclick = () => reorderPicture(-1); $("#moveRightButton").onclick = () => reorderPicture(1);

document.querySelectorAll("[data-keyframe]").forEach((button) => button.onclick = () => {
  const item = selectedItems()[0]; const property = button.dataset.keyframe; if (!item || state.outputTick < item.startTick || state.outputTick > item.endTick) { setStatus("播放头必须位于当前叠加层区间内。", true); return; }
  const value = interpolate(item.metadata.keyframes?.[property], state.outputTick, item.metadata[property]); runCommand({ itemId: item.id, operation: "keyframe_set", arguments: { property, tick: alignFrame(state.outputTick), value } }, `已添加 ${property.toUpperCase()} 关键帧`);
});
$("#removeKeyframe").onclick = () => { const item = selectedItems()[0]; if (!item) return; const tick = alignFrame(state.outputTick); const property = ["x", "y"].find((key) => item.metadata.keyframes?.[key]?.some((point) => point.tick === tick)); if (!property) { setStatus("当前帧没有 x/y 关键帧。", true); return; } runCommand({ itemId: item.id, operation: "keyframe_remove", arguments: { property, tick } }, `已移除 ${property.toUpperCase()} 关键帧`); };

$("#binSearch").onsubmit = (event) => { event.preventDefault(); refreshBin(); }; $("#binKind").onchange = refreshBin; $("#refreshBin").onclick = refreshBin;
let searchTimer; $("#binQuery").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(refreshBin, 220); };
$("#deliveryFrame").onchange = updateDeliveryGuide;
$("#zoom").oninput = (event) => { state.zoom = Number(event.target.value); $("#timelineViewport").style.setProperty("--timeline-width", `${1100 * state.zoom}px`); renderTimelineOverlays(); updatePlayhead(); };

$("#video").addEventListener("timeupdate", () => {
  const video = $("#video"); if (!projection() || !state.activePictureId) return;
  const pictures = pictureItems(); const index = pictures.findIndex((item) => item.id === state.activePictureId); const picture = pictures[index]; if (!picture) return;
  const sourceTick = video.currentTime * projection().timebase.ticksPerSecond; const candidate = picture.startTick + sourceTick - picture.metadata.sourceStartTick; const next = pictures[index + 1]; const boundary = Math.min(picture.endTick, next?.startTick ?? picture.endTick);
  if (next && candidate >= boundary) { const playing = !video.paused; seekOutputTick(boundary); if (playing) video.play().catch(() => {}); return; }
  if (!next && candidate >= boundary) { state.outputTick = boundary; video.pause(); updatePlayhead(); return; }
  state.outputTick = Math.max(picture.startTick, Math.min(candidate, picture.endTick)); updatePlayhead();
});
$("#video").addEventListener("loadedmetadata", () => { seekOutputTick(state.outputTick); updateDeliveryGuide(); });
window.addEventListener("resize", () => { renderOverlayProjection(); updateDeliveryGuide(); renderTimelineOverlays(); });
window.addEventListener("beforeunload", () => state.eventSource?.close());
window.addEventListener("keydown", (event) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (event.code === "Space") { event.preventDefault(); const video = $("#video"); if (video.paused) video.play().catch(() => {}); else video.pause(); }
  else if (event.key.toLowerCase() === "m") $("#markerButton").click();
  else if (event.key.toLowerCase() === "s") $("#splitButton").click();
  else if (event.key === "[") $("#inButton").click();
  else if (event.key === "]") $("#outButton").click();
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); $(event.shiftKey ? "#redoButton" : "#undoButton").click(); }
});

$("#capabilitiesButton").onclick = () => toggleDrawer("#capabilitiesButton", "#capabilityDrawer");
$("#deliveryButton").onclick = () => toggleDrawer("#deliveryButton", "#deliveryDrawer");
$("#activityButton").onclick = () => { toggleDrawer("#activityButton", "#activityDrawer"); if (!$("#activityDrawer").hidden) refreshActivity().catch((error) => setStatus(error.message, true)); };
$("#refreshActivity").onclick = () => refreshActivity().catch((error) => setStatus(error.message, true));

$("#timelineSwitcher").onchange = async (event) => {
  if (!state.workspace || !event.target.value) return;
  await openProjectPath(state.workspace.workspace.path, event.target.value);
};

$("#duplicateTimelineButton").onclick = () => {
  if (!state.workspace) return;
  const source = state.workspace.timelines.find((timeline) => timeline.absolutePath === state.project.session.timelinePath);
  const id = `${source?.id ?? "timeline"}-v${state.workspace.timelines.length + 1}`;
  $("#duplicateId").value = id; $("#duplicateLabel").value = `${source?.label ?? "Timeline"} 副本`;
  $("#duplicatePath").value = `versions/${id}.json`; $("#duplicateWidth").value = projection().output.width; $("#duplicateHeight").value = projection().output.height;
  $("#duplicateDialog").showModal();
};
$("#closeDuplicateDialog").onclick = () => $("#duplicateDialog").close();
$("#duplicateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const newTimelineId = $("#duplicateId").value.trim();
    const result = await api("/api/editor/workspace-duplicate", {
      sessionId: state.sessionId, expectedWorkspaceSha256: state.workspace.workspace.sha256,
      newTimelineId, label: $("#duplicateLabel").value.trim(), outputPath: $("#duplicatePath").value.trim(),
      width: $("#duplicateWidth").valueAsNumber, height: $("#duplicateHeight").valueAsNumber, role: $("#duplicateRole").value,
    });
    $("#duplicateDialog").close(); setStatus(`已创建独立候选 ${newTimelineId}，正在切换。`);
    await openProjectPath(result.workspace.path, result.activeTimelineId);
  } catch (error) { setStatus(error.message, true); }
});

$("#deliveryPlanForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const status = $("#deliveryStatus");
  try {
    const result = await api("/api/editor/delivery-plan", { sessionId: state.sessionId, profileId: $("#deliveryProfile").value, outputPath: $("#deliveryOutput").value.trim() });
    status.classList.remove("error"); status.textContent = `交付计划已写入 ${result.plan.path}；还未渲染成片。`;
  } catch (error) { status.classList.add("error"); status.textContent = error.message; }
});
$("#nleExportForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const status = $("#deliveryStatus");
  try {
    const result = await api("/api/editor/nle-export", { sessionId: state.sessionId, format: $("#nleFormat").value, outputPath: $("#nleOutput").value.trim() });
    status.classList.remove("error"); status.textContent = `NLE 交换候选已写入 ${result.output.path}；需在目标 NLE 真实导入验证。`;
  } catch (error) { status.classList.add("error"); status.textContent = error.message; }
});
$("#bundleForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const status = $("#deliveryStatus");
  try {
    const result = await api("/api/editor/delivery-bundle", { sessionId: state.sessionId, outputPath: $("#bundleOutput").value.trim(), includeMedia: $("#bundleMedia").checked });
    status.classList.remove("error"); status.textContent = `工程包已写入 ${result.output}；状态 ${result.status}。`;
  } catch (error) { status.classList.add("error"); status.textContent = error.message; }
});
