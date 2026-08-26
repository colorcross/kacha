const $ = (selector) => document.querySelector(selector);
const state = {
  project: null,
  sessionId: null,
  selectedId: null,
  activePictureId: null,
  outputTick: 0,
  zoom: 1,
};

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Kacha-Studio": "1" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok || value.status === "blocked") throw new Error(value.error ?? "请求失败");
  return value;
}

function setStatus(message, error = false) {
  $("#status").textContent = message;
  $("#status").classList.toggle("error", error);
}

function timecode(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe - Math.floor(safe)) * 1000);
  return [hours, minutes, secs].map((v) => String(v).padStart(2, "0")).join(":")
    + `.${String(millis).padStart(3, "0")}`;
}

function currentProjection() { return state.project?.projection; }
function ticksToSeconds(tick) { return Number(tick) / currentProjection().timebase.ticksPerSecond; }

function pictureItems() {
  return currentProjection().items
    .filter((item) => item.type === "picture")
    .sort((left, right) => left.startTick - right.startTick);
}

function pictureAt(outputTick) {
  return pictureItems()
    .filter((item) => item.startTick <= outputTick && outputTick < item.endTick)
    .at(-1) ?? null;
}

function updatePlayhead() {
  const projection = currentProjection();
  if (!projection) return;
  const ratio = state.outputTick / Math.max(1, projection.durationTick);
  const lane = document.querySelector(".track-lane");
  $("#timecode").textContent = timecode(ticksToSeconds(state.outputTick));
  $("#playhead").style.left = `${154 + ratio * (lane?.clientWidth ?? 0)}px`;
  renderOverlayProjection();
}

function seekOutputTick(outputTick) {
  const projection = currentProjection();
  if (!projection) return;
  state.outputTick = Math.max(0, Math.min(Number(outputTick) || 0, projection.durationTick));
  const picture = pictureAt(state.outputTick);
  state.activePictureId = picture?.id ?? null;
  if (picture && $("#video").src) {
    const sourceTick = picture.metadata.sourceStartTick + (state.outputTick - picture.startTick);
    const sourceSeconds = ticksToSeconds(sourceTick);
    if (Math.abs($("#video").currentTime - sourceSeconds) > 0.02) {
      $("#video").currentTime = sourceSeconds;
    }
  }
  updatePlayhead();
}

function renderRuler() {
  const ruler = $("#ruler");
  ruler.innerHTML = "";
  const duration = Math.max(1, currentProjection().durationSeconds);
  const count = 10;
  for (let index = 0; index <= count; index += 1) {
    const tick = document.createElement("span");
    tick.className = "ruler-tick";
    tick.style.left = `${index / count * 100}%`;
    tick.textContent = timecode(duration * index / count).slice(0, 8);
    ruler.append(tick);
  }
}

function selectItem(itemId) {
  state.selectedId = itemId;
  document.querySelectorAll(".clip").forEach((clip) => clip.classList.toggle("selected", clip.dataset.id === itemId));
  const item = currentProjection().items.find((candidate) => candidate.id === itemId);
  $("#emptyInspector").hidden = true;
  $("#inspector").hidden = false;
  $("#itemLabel").textContent = item.label;
  $("#itemType").textContent = item.type;
  $("#sourcePointer").textContent = item.sourcePointer;
  const fields = $("#fieldList");
  fields.innerHTML = "";
  for (const field of item.editableFields) {
    const label = document.createElement("label");
    const title = document.createElement("span");
    title.textContent = field;
    const input = document.createElement("input");
    input.type = "number";
    const binding = item.editBindings[field];
    input.step = field.endsWith("Tick")
      ? String(binding?.frameAligned ? currentProjection().timebase.ticksPerFrame : 1)
      : "0.01";
    input.name = field;
    input.value = item.metadata[field] ?? item[field] ?? "";
    input.dataset.original = input.value;
    label.append(title, input);
    fields.append(label);
  }
  const readOnly = item.readOnlyReasons?.join("；") ?? "";
  $("#readonlyReason").hidden = !readOnly;
  $("#readonlyReason").textContent = readOnly;
  $("#applyButton").disabled = item.readOnly;
  renderOverlayProjection();
}

function renderTracks() {
  const projection = currentProjection();
  const tracks = $("#tracks");
  tracks.innerHTML = "";
  const duration = Math.max(1, projection.durationTick);
  for (const track of projection.tracks) {
    const row = document.createElement("div");
    row.className = "track";
    const label = document.createElement("div");
    label.className = "track-label";
    label.textContent = `${track.label} · ${track.itemIds.length}`;
    const lane = document.createElement("div");
    lane.className = "track-lane";
    lane.addEventListener("pointerdown", (event) => {
      if (event.target !== lane) return;
      const ratio = event.offsetX / lane.clientWidth;
      seekOutputTick(projection.durationTick * ratio);
    });
    for (const itemId of track.itemIds) {
      const item = projection.items.find((candidate) => candidate.id === itemId);
      const clip = document.createElement("button");
      clip.type = "button";
      clip.className = "clip";
      clip.dataset.id = item.id;
      clip.dataset.type = item.type;
      clip.style.left = `${item.startTick / duration * 100}%`;
      clip.style.width = `${Math.max(.4, (item.endTick - item.startTick) / duration * 100)}%`;
      clip.textContent = item.label;
      clip.title = `${item.label}\n${timecode(ticksToSeconds(item.startTick))} – ${timecode(ticksToSeconds(item.endTick))}`;
      clip.addEventListener("click", () => {
        selectItem(item.id);
        if (state.outputTick < item.startTick || state.outputTick >= item.endTick) seekOutputTick(item.startTick);
      });
      lane.append(clip);
    }
    row.append(label, lane);
    tracks.append(row);
  }
}

function renderOverlayProjection() {
  const layer = $("#overlayLayer");
  const video = $("#video");
  layer.innerHTML = "";
  const projection = currentProjection();
  const outputWidth = Number(projection.output.width || video.videoWidth || 1);
  const outputHeight = Number(projection.output.height || video.videoHeight || 1);
  const displayedWidth = video.clientWidth;
  const displayedHeight = video.clientHeight;
  layer.style.width = `${displayedWidth}px`;
  layer.style.height = `${displayedHeight}px`;
  const currentTick = state.outputTick;
  for (const item of projection.items.filter((candidate) => candidate.type === "overlay")) {
    if (currentTick < item.startTick || currentTick >= item.endTick) continue;
    const box = document.createElement("div");
    box.className = "overlay-box";
    box.dataset.label = item.label;
    box.style.left = `${Number(item.metadata.x) / outputWidth * displayedWidth}px`;
    box.style.top = `${Number(item.metadata.y) / outputHeight * displayedHeight}px`;
    box.style.width = `${Number(item.metadata.width) / outputWidth * displayedWidth}px`;
    box.style.height = `${Number(item.metadata.height) / outputHeight * displayedHeight}px`;
    box.style.opacity = String(item.metadata.opacity ?? 1);
    box.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      selectItem(item.id);
      const origin = { x: event.clientX, y: event.clientY, left: Number(item.metadata.x), top: Number(item.metadata.y) };
      box.setPointerCapture(event.pointerId);
      const move = (next) => {
        const x = Math.min(
          outputWidth - Number(item.metadata.width),
          Math.max(0, origin.left + (next.clientX - origin.x) * outputWidth / displayedWidth),
        );
        const y = Math.min(
          outputHeight - Number(item.metadata.height),
          Math.max(0, origin.top + (next.clientY - origin.y) * outputHeight / displayedHeight),
        );
        const xInput = $("#fieldList input[name='x']");
        const yInput = $("#fieldList input[name='y']");
        if (xInput) xInput.value = x.toFixed(2);
        if (yInput) yInput.value = y.toFixed(2);
        box.style.left = `${x / outputWidth * displayedWidth}px`;
        box.style.top = `${y / outputHeight * displayedHeight}px`;
      };
      box.addEventListener("pointermove", move);
      box.addEventListener("pointerup", () => box.removeEventListener("pointermove", move), { once: true });
    });
    layer.append(box);
  }
}

function renderProject(project) {
  state.project = project;
  const projection = project.projection;
  state.outputTick = Math.min(state.outputTick, projection.durationTick);
  $("#workspace").hidden = false;
  $("#projectMeta").textContent = `${projection.projectId} · ${projection.timebase.frameRate} fps · ${timecode(projection.durationSeconds)}`;
  $("#undoButton").disabled = !project.session.canUndo;
  $("#redoButton").disabled = !project.session.canRedo;
  $("#timelineViewport").style.setProperty("--timeline-width", `${1100 * state.zoom}px`);
  renderRuler();
  renderTracks();
  if (state.selectedId && projection.items.some((item) => item.id === state.selectedId)) selectItem(state.selectedId);
  else {
    state.selectedId = null;
    $("#emptyInspector").hidden = false;
    $("#inspector").hidden = true;
  }
  renderOverlayProjection();
  updatePlayhead();
}

$("#openForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("正在验证 Timeline IR、时间基和编辑历史……");
  try {
    const result = await api("/api/editor/open", { timelinePath: $("#timelinePath").value.trim() });
    state.sessionId = result.browserSessionId;
    renderProject(result);
    const video = $("#video");
    video.src = result.projection.timeline.source
      ? `/api/editor/media?session=${encodeURIComponent(state.sessionId)}`
      : "";
    state.outputTick = 0;
    state.activePictureId = null;
    if (!video.src) updatePlayhead();
    setStatus(`已打开 ${result.projection.projectId}；浏览器预览为 approximate，正式成片未改变。`);
  } catch (error) { setStatus(error.message, true); }
});

$("#inspector").addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = currentProjection().items.find((candidate) => candidate.id === state.selectedId);
  const changes = Object.fromEntries(item.editableFields.flatMap((field) => {
    const input = $(`#fieldList input[name='${field}']`);
    return Number(input.value) === Number(input.dataset.original)
      ? []
      : [[field, Number(input.value)]];
  }));
  if (Object.keys(changes).length === 0) {
    setStatus("没有检测到需要写入的变化。", true);
    return;
  }
  try {
    const result = await api("/api/editor/command", {
      sessionId: state.sessionId,
      command: {
        schemaVersion: "1.0",
        kind: "kacha-editor-command",
        baseSha256: state.project.session.currentSha256,
        itemId: item.id,
        changes,
        actor: "studio-user",
        reason: $("#reason").value.trim(),
      },
    });
    renderProject(result.project);
    $("#qcNotice").textContent = `需要重新执行：${result.requiredQc.join("、")}`;
    setStatus(`Command ${result.commandId} 已原子应用；尚未重新渲染成片。`);
  } catch (error) { setStatus(error.message, true); }
});

for (const [id, endpoint] of [["#undoButton", "undo"], ["#redoButton", "redo"]]) {
  $(id).addEventListener("click", async () => {
    try {
      const result = await api(`/api/editor/${endpoint}`, { sessionId: state.sessionId });
      renderProject(result.project);
      setStatus(`${endpoint === "undo" ? "撤销" : "重做"} ${result.commandId} 完成；尚未重新渲染成片。`);
    } catch (error) { setStatus(error.message, true); }
  });
}

$("#video").addEventListener("timeupdate", () => {
  const video = $("#video");
  const projection = currentProjection();
  if (!projection || !state.activePictureId) return;
  const pictures = pictureItems();
  const index = pictures.findIndex((item) => item.id === state.activePictureId);
  const picture = pictures[index];
  if (!picture) return;
  const sourceTick = video.currentTime * projection.timebase.ticksPerSecond;
  const candidate = picture.startTick + sourceTick - picture.metadata.sourceStartTick;
  const next = pictures[index + 1];
  const boundary = Math.min(picture.endTick, next?.startTick ?? picture.endTick);
  if (next && candidate >= boundary) {
    const continuePlaying = !video.paused;
    seekOutputTick(boundary);
    if (continuePlaying) video.play().catch(() => {});
    return;
  }
  if (!next && candidate >= boundary) {
    state.outputTick = boundary;
    video.pause();
    updatePlayhead();
    return;
  }
  state.outputTick = Math.max(picture.startTick, Math.min(candidate, picture.endTick));
  updatePlayhead();
});
$("#video").addEventListener("loadedmetadata", () => seekOutputTick(state.outputTick));
window.addEventListener("resize", renderOverlayProjection);
$("#zoom").addEventListener("input", (event) => {
  state.zoom = Number(event.target.value);
  $("#timelineViewport").style.setProperty("--timeline-width", `${1100 * state.zoom}px`);
});
