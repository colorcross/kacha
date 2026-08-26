import fs from "node:fs";
import path from "node:path";
import {
  fileIdentity,
  readJson,
  resolveFrom,
  sha256File,
  sha256Value,
} from "./kacha_utils.mjs";
import {
  canonicalizeTimelineTime,
  framesToTicks,
  normalizeTimebase,
  secondsToTicks,
  ticksToSeconds,
  timebaseSummary,
} from "./media_time.mjs";

const TRACK_DEFINITIONS = [
  ["effects", "effect", "效果/调整", 70],
  ["captions", "caption", "字幕/空间文字", 60],
  ["overlays", "overlay", "叠加/图形", 50],
  ["picture", "picture", "主画面", 40],
  ["dialogue", "dialogue", "人声", 30],
  ["bgm", "bgm", "背景音乐", 20],
  ["sfx", "sfx", "音效", 10],
];

function safeId(value, fallback) {
  const normalized = String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized || fallback;
}

function sourceFile(timelineFile, source) {
  const candidate = typeof source === "string" ? source : source?.path;
  if (!candidate) return null;
  return resolveFrom(timelineFile, candidate);
}

export function resolveTimelinePath(timelineFile) {
  const resolved = path.resolve(timelineFile);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Timeline 不存在：${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function timeBinding(pointer, secondsField, tickField, { frameAligned = false } = {}) {
  return {
    kind: "time",
    objectPointer: pointer,
    tickField,
    secondsField,
    tickPointer: `${pointer}/${tickField}`,
    secondsPointer: `${pointer}/${secondsField}`,
    frameAligned,
  };
}

function scalarBinding(pointer, field, { minimum = null, maximum = null } = {}) {
  return { kind: "scalar", pointer: `${pointer}/${field}`, minimum, maximum };
}

function makeItem({
  id,
  type,
  trackId,
  label,
  startTick,
  endTick,
  sourcePointer,
  bindings = {},
  metadata = {},
  readOnlyReasons = [],
}) {
  return {
    id,
    type,
    trackId,
    label,
    startTick,
    endTick,
    sourcePointer,
    editableFields: Object.keys(bindings),
    editBindings: bindings,
    readOnly: Object.keys(bindings).length === 0,
    readOnlyReasons,
    metadata,
  };
}

export function buildTimelineProjection(timelineFile, { includeSourceHash = false } = {}) {
  const resolved = resolveTimelinePath(timelineFile);
  const input = readJson(resolved);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Timeline 根节点必须是 object");
  }
  if (!input.projectId || input.schemaVersion !== "1.0") {
    throw new Error("只接受包含 projectId 的 Kacha Timeline IR 1.0");
  }
  const fallbackFps = input.output?.fps ?? input.timebase?.frameRate ?? 25;
  const canonical = canonicalizeTimelineTime(input, fallbackFps);
  if (canonical.errors.length > 0) throw new Error(canonical.errors.join("；"));
  const timeline = canonical.plan;
  const timebase = canonical.timebase ?? normalizeTimebase({}, fallbackFps);
  const items = [];
  let pictureCursor = 0;
  (timeline.edl ?? []).forEach((entry, index) => {
    const pointer = `/edl/${index}`;
    const sourceStartTick = entry.sourceStartTick ?? secondsToTicks(entry.sourceStart, timebase);
    const sourceEndTick = entry.sourceEndTick ?? secondsToTicks(entry.sourceEnd, timebase);
    if (!Number.isSafeInteger(sourceStartTick) || sourceStartTick < 0) {
      throw new Error(`${entry.id ?? `edl[${index}]`}.sourceStartTick 必须是非负安全整数`);
    }
    if (!Number.isSafeInteger(sourceEndTick) || sourceEndTick <= sourceStartTick) {
      throw new Error(`${entry.id ?? `edl[${index}]`}.sourceEndTick 必须大于 sourceStartTick`);
    }
    const transitionFrames = Number(timeline.transitions?.[Math.max(0, index - 1)]?.durationFrames ?? 0);
    if (index > 0 && Number.isSafeInteger(transitionFrames) && transitionFrames > 0) {
      pictureCursor -= framesToTicks(transitionFrames, timebase);
    }
    const duration = sourceEndTick - sourceStartTick;
    items.push(makeItem({
      id: `picture:${safeId(entry.id, `segment-${index + 1}`)}`,
      type: "picture",
      trackId: "picture",
      label: entry.id ?? `主画面 ${index + 1}`,
      startTick: pictureCursor,
      endTick: pictureCursor + duration,
      sourcePointer: pointer,
      bindings: {
        sourceStartTick: timeBinding(pointer, "sourceStart", "sourceStartTick", { frameAligned: true }),
        sourceEndTick: timeBinding(pointer, "sourceEnd", "sourceEndTick", { frameAligned: true }),
      },
      metadata: { sourceStartTick, sourceEndTick, scale: entry.scale ?? 1 },
    }));
    pictureCursor += duration;
  });
  (timeline.visual?.breathing ?? []).forEach((entry, index) => {
    const pointer = `/visual/breathing/${index}`;
    items.push(makeItem({
      id: `effect:${safeId(entry.id, `breathing-${index + 1}`)}`,
      type: "effect",
      trackId: "effects",
      label: entry.id ?? `呼吸运镜 ${index + 1}`,
      startTick: entry.startTick,
      endTick: entry.endTick,
      sourcePointer: pointer,
      bindings: {
        startTick: timeBinding(pointer, "start", "startTick", { frameAligned: true }),
        endTick: timeBinding(pointer, "end", "endTick", { frameAligned: true }),
      },
      metadata: { scale: entry.scale, anchorX: entry.anchorX, anchorY: entry.anchorY },
    }));
  });
  (timeline.visual?.overlays ?? []).forEach((entry, index) => {
    const pointer = `/visual/overlays/${index}`;
    items.push(makeItem({
      id: `overlay:${safeId(entry.id, `overlay-${index + 1}`)}`,
      type: "overlay",
      trackId: "overlays",
      label: entry.id ?? path.basename(entry.path ?? `叠加 ${index + 1}`),
      startTick: entry.startTick,
      endTick: entry.endTick,
      sourcePointer: pointer,
      bindings: {
        startTick: timeBinding(pointer, "start", "startTick", { frameAligned: true }),
        endTick: timeBinding(pointer, "end", "endTick", { frameAligned: true }),
        x: scalarBinding(pointer, "x", { minimum: 0 }),
        y: scalarBinding(pointer, "y", { minimum: 0 }),
        width: scalarBinding(pointer, "width", { minimum: 1 }),
        height: scalarBinding(pointer, "height", { minimum: 1 }),
        opacity: scalarBinding(pointer, "opacity", { minimum: 0, maximum: 1 }),
      },
      metadata: {
        kind: entry.kind,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
        opacity: entry.opacity ?? 1,
      },
    }));
  });
  const totalTick = Math.max(0, pictureCursor);
  if (timeline.visual?.subtitles) {
    items.push(makeItem({
      id: "caption:rendered-layer",
      type: "caption",
      trackId: "captions",
      label: path.basename(timeline.visual.subtitles.path ?? "字幕层"),
      startTick: 0,
      endTick: totalTick,
      sourcePointer: "/visual/subtitles",
      readOnlyReasons: ["当前字幕是已渲染 ASS/视频层；正文与 cue 需回到字幕计划修改"],
    }));
  }
  if (timeline.audio?.dialogue) {
    items.push(makeItem({
      id: "dialogue:main",
      type: "dialogue",
      trackId: "dialogue",
      label: path.basename(timeline.audio.dialogue.path ?? "Dialogue"),
      startTick: 0,
      endTick: totalTick,
      sourcePointer: "/audio/dialogue",
      readOnlyReasons: ["人声源、增益和处理链需通过音频合同修改"],
    }));
  }
  const bgmSegments = timeline.audio?.bgm?.segments;
  if (Array.isArray(bgmSegments)) {
    bgmSegments.forEach((entry, index) => {
      const pointer = `/audio/bgm/segments/${index}`;
      items.push(makeItem({
        id: `bgm:${safeId(entry.id, `segment-${index + 1}`)}`,
        type: "bgm",
        trackId: "bgm",
        label: entry.id ?? path.basename(entry.path ?? `BGM ${index + 1}`),
        startTick: entry.startTick,
        endTick: entry.endTick,
        sourcePointer: pointer,
        bindings: {
          startTick: timeBinding(pointer, "start", "startTick"),
          endTick: timeBinding(pointer, "end", "endTick"),
        },
        metadata: { levelBelowDialogueDb: entry.levelBelowDialogueDb },
      }));
    });
  } else if (timeline.audio?.bgm) {
    items.push(makeItem({
      id: "bgm:main",
      type: "bgm",
      trackId: "bgm",
      label: path.basename(timeline.audio.bgm.path ?? "BGM"),
      startTick: 0,
      endTick: totalTick,
      sourcePointer: "/audio/bgm",
      readOnlyReasons: ["整段 BGM 需先迁移为 segments 才能在工作台调整时序"],
    }));
  }
  (timeline.audio?.sfx ?? []).forEach((entry, index) => {
    const pointer = `/audio/sfx/${index}`;
    const tickField = entry.targetLandingTick !== undefined ? "targetLandingTick" : "timeTick";
    const secondsField = tickField === "targetLandingTick" ? "targetLandingSeconds" : "time";
    const startTick = entry[tickField];
    items.push(makeItem({
      id: `sfx:${safeId(entry.id, `event-${index + 1}`)}`,
      type: "sfx",
      trackId: "sfx",
      label: entry.id ?? path.basename(entry.path ?? `SFX ${index + 1}`),
      startTick,
      endTick: startTick + timebase.ticksPerFrame,
      sourcePointer: pointer,
      bindings: { [tickField]: timeBinding(pointer, secondsField, tickField) },
      metadata: { timingReference: tickField, [tickField]: startTick },
    }));
  });
  const itemIds = items.map((item) => item.id);
  if (new Set(itemIds).size !== itemIds.length) {
    throw new Error("Timeline 投影包含重复 item id；请为同轨条目提供唯一 id");
  }
  const tracks = TRACK_DEFINITIONS.map(([id, type, label, order]) => ({
    id,
    type,
    label,
    order,
    itemIds: items.filter((item) => item.trackId === id).map((item) => item.id),
  })).filter((track) => track.itemIds.length > 0);
  const durationTick = Math.max(totalTick, ...items.map((item) => item.endTick ?? 0), 0);
  for (const item of items) {
    if (!Number.isSafeInteger(item.startTick) || item.startTick < 0) {
      throw new Error(`${item.id}.startTick 必须是非负安全整数`);
    }
    if (!Number.isSafeInteger(item.endTick) || item.endTick <= item.startTick) {
      throw new Error(`${item.id}.endTick 必须大于 startTick`);
    }
    if (item.type === "sfx") {
      if (totalTick > 0 && item.startTick > totalTick) throw new Error(`${item.id} 超出时间线`);
    } else if (totalTick > 0 && item.endTick > totalTick) {
      throw new Error(`${item.id} 超出时间线`);
    }
  }
  const outputWidth = Number(timeline.output?.width);
  const outputHeight = Number(timeline.output?.height);
  if (!Number.isFinite(outputWidth) || outputWidth <= 0 || !Number.isFinite(outputHeight) || outputHeight <= 0) {
    throw new Error("Timeline output.width/output.height 必须是正数");
  }
  for (const item of items.filter((candidate) => candidate.type === "overlay")) {
    const { x, y, width, height, opacity } = item.metadata;
    if (
      ![x, y, width, height, opacity].every((value) => Number.isFinite(Number(value)))
      || Number(x) < 0
      || Number(y) < 0
      || Number(width) <= 0
      || Number(height) <= 0
      || Number(opacity) < 0
      || Number(opacity) > 1
    ) throw new Error(`${item.id} 几何或透明度无效`);
    if (
      Number.isFinite(outputWidth)
      && Number.isFinite(outputHeight)
      && (Number(x) + Number(width) > outputWidth || Number(y) + Number(height) > outputHeight)
    ) throw new Error(`${item.id} 超出输出画布`);
  }
  const media = sourceFile(resolved, timeline.source);
  const sourceIdentity = media && fs.existsSync(media) && fs.statSync(media).isFile()
    ? fileIdentity(fs.realpathSync(media), { includeHash: includeSourceHash })
    : null;
  return {
    schemaVersion: "1.0",
    kind: "kacha-timeline-projection",
    projectId: timeline.projectId,
    timeline: {
      path: resolved,
      sha256: sha256File(resolved),
      source: sourceIdentity?.path ?? null,
      sourceIdentity,
      sourceSha256: sourceIdentity?.sha256 ?? null,
    },
    timebase: timebaseSummary(timebase),
    durationTick,
    durationSeconds: ticksToSeconds(durationTick, timebase),
    output: timeline.output ?? {},
    tracks,
    items,
    digest: sha256Value({ projectId: timeline.projectId, timebase, durationTick, tracks, items }),
  };
}

export function findProjectionItem(projection, itemId) {
  const item = projection.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Timeline item 不存在：${itemId}`);
  return item;
}

export function compileProjectionCommand(projection, command) {
  if (!command || command.schemaVersion !== "1.0" || command.kind !== "kacha-editor-command") {
    throw new Error("command 必须是 kacha-editor-command 1.0");
  }
  if (
    !command.itemId
    || !command.changes
    || typeof command.changes !== "object"
    || Array.isArray(command.changes)
    || Object.keys(command.changes).length === 0
  ) {
    throw new Error("command.itemId/changes 不能为空");
  }
  const allowedFields = new Set([
    "schemaVersion", "kind", "commandId", "baseSha256", "itemId", "changes", "actor", "reason",
  ]);
  const unknownFields = Object.keys(command).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) throw new Error(`command 包含未知字段：${unknownFields.join(", ")}`);
  for (const field of ["commandId", "itemId", "actor", "reason"]) {
    if (command[field] === undefined) continue;
    if (
      typeof command[field] !== "string"
      || command[field].trim().length === 0
      || command[field].length > (field === "actor" || field === "reason" ? 500 : 200)
      || /[\u0000-\u001f\u007f]/.test(command[field])
    ) throw new Error(`command.${field} 合同无效`);
  }
  if (command.baseSha256 !== undefined && !/^[a-f0-9]{64}$/.test(command.baseSha256)) {
    throw new Error("command.baseSha256 必须是小写 SHA-256");
  }
  if (Object.keys(command.changes).length > 32) throw new Error("command.changes 最多包含 32 个字段");
  const item = findProjectionItem(projection, command.itemId);
  const operations = [];
  const timebase = normalizeTimebase({
    ticksPerSecond: projection.timebase.ticksPerSecond,
    frameRate: projection.timebase.frameRate.includes("/")
      ? {
          numerator: Number(projection.timebase.frameRate.split("/")[0]),
          denominator: Number(projection.timebase.frameRate.split("/")[1]),
        }
      : Number(projection.timebase.framesPerSecond),
  });
  for (const [field, raw] of Object.entries(command.changes)) {
    if (!Object.hasOwn(item.editBindings, field)) {
      throw new Error(`${item.id}.${field} 不在可编辑 allowlist`);
    }
    const binding = item.editBindings[field];
    if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`${field} 必须是有限数值`);
    const value = raw;
    if (binding.kind === "time") {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} 必须是非负安全 tick`);
      if (binding.frameAligned && value % timebase.ticksPerFrame !== 0) {
        throw new Error(`${field} 必须落在整帧边界（${timebase.ticksPerFrame} ticks/frame）`);
      }
      operations.push({
        op: "merge",
        path: binding.objectPointer,
        value: {
          [binding.tickField]: value,
          [binding.secondsField]: ticksToSeconds(value, timebase),
        },
      });
    } else {
      if (binding.minimum !== null && value < binding.minimum) throw new Error(`${field} 小于最小值 ${binding.minimum}`);
      if (binding.maximum !== null && value > binding.maximum) throw new Error(`${field} 大于最大值 ${binding.maximum}`);
      operations.push({ op: "replace", path: binding.pointer, value });
    }
  }
  const proposed = { ...item };
  const start = command.changes.sourceStartTick
    ?? command.changes.startTick
    ?? item.metadata.sourceStartTick
    ?? item.startTick;
  const end = command.changes.sourceEndTick
    ?? command.changes.endTick
    ?? item.metadata.sourceEndTick
    ?? item.endTick;
  if (item.type !== "sfx" && Number(end) <= Number(start)) {
    throw new Error("条目 endTick 必须大于 startTick");
  }
  return {
    operations,
    item,
    affectedTracks: [item.trackId],
    requiredQc: [
      "timeline_validate",
      ...(item.type === "picture" ? ["connection_qc"] : []),
      ...(["dialogue", "bgm", "sfx"].includes(item.type) ? ["audio_qc"] : []),
      ...(["overlay", "caption", "effect"].includes(item.type) ? ["visual_dynamic_review"] : []),
    ],
    proposed,
  };
}
