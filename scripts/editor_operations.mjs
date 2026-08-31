import { readJson } from "./kacha_utils.mjs";
import { normalizeTimebase, ticksToSeconds } from "./media_time.mjs";
import { compileProjectionCommand, findProjectionItem } from "./timeline_projection.mjs";
import { resolveIndexedAsset } from "./project_bin.mjs";

const OPERATIONS = new Set([
  "batch", "move", "trim", "split", "reorder",
  "marker_set", "marker_remove", "work_area_set", "work_area_clear",
  "keyframe_set", "keyframe_remove", "delivery_frames_set",
  "replace_media",
]);

const COMMAND_FIELDS = new Set([
  "schemaVersion", "kind", "commandId", "baseSha256", "itemId",
  "operation", "arguments", "actor", "reason",
]);
const ITEM_OPERATIONS = new Set(["trim", "split", "keyframe_set", "keyframe_remove", "replace_media"]);
const OPERATION_ARGUMENT_FIELDS = Object.freeze({
  batch: new Set(["edits"]),
  move: new Set(["itemIds", "deltaTick"]),
  trim: new Set(["edge", "outputTick"]),
  split: new Set(["outputTick", "newId"]),
  reorder: new Set(["itemIds"]),
  marker_set: new Set(["marker"]),
  marker_remove: new Set(["id"]),
  work_area_set: new Set(["startTick", "endTick"]),
  work_area_clear: new Set(),
  keyframe_set: new Set(["property", "tick", "value", "values"]),
  keyframe_remove: new Set(["property", "tick"]),
  delivery_frames_set: new Set(["frames"]),
  replace_media: new Set(["indexPath", "assetRef"]),
});

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} 必须是普通 object`);
  }
  return value;
}

function assertExactFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) throw new Error(`${label} 包含未知字段：${unknown.join(", ")}`);
}

function validateOperationCommand(command) {
  plainObject(command, "command");
  assertExactFields(command, COMMAND_FIELDS, "command");
  if (command.changes !== undefined) throw new Error("typed operation 不能同时提供 changes");
  if (!OPERATIONS.has(command.operation)) throw new Error(`editor operation 不支持：${command.operation}`);
  plainObject(command.arguments, `${command.operation}.arguments`);
  assertExactFields(command.arguments, OPERATION_ARGUMENT_FIELDS[command.operation], `${command.operation}.arguments`);
  for (const [field, maximum] of [["commandId", 200], ["actor", 500], ["reason", 500]]) {
    if (command[field] !== undefined) auditString(command[field], `command.${field}`, maximum);
  }
  if (ITEM_OPERATIONS.has(command.operation)) {
    auditString(command.itemId, `${command.operation}.itemId`);
  } else if (command.itemId !== undefined) {
    throw new Error(`${command.operation} 不接受顶层 itemId`);
  }
}

function auditString(value, label, maximum = 200) {
  if (typeof value !== "string") {
    throw new Error(`${label} 必须是 1–${maximum} 个无控制符字符`);
  }
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} 必须是 1–${maximum} 个无控制符字符`);
  }
  return text;
}

function integerTick(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全 tick`);
  return value;
}

function projectionTimebase(projection) {
  const [numerator, denominator] = String(projection.timebase.frameRate).split("/").map(Number);
  return normalizeTimebase({
    ticksPerSecond: projection.timebase.ticksPerSecond,
    frameRate: { numerator, denominator },
  });
}

function editorMutation(timeline, key, value) {
  if (timeline.editor && Object.hasOwn(timeline.editor, key)) return { op: "replace", path: `/editor/${key}`, value };
  if (timeline.editor) return { op: "add", path: `/editor/${key}`, value };
  return { op: "add", path: "/editor", value: { [key]: value } };
}

function compiledResult(operations, affectedTracks, requiredQc, proposed = {}) {
  return {
    operations,
    affectedTracks: [...new Set(affectedTracks)],
    requiredQc: [...new Set(["timeline_validate", ...requiredQc])],
    item: null,
    proposed,
  };
}

function compileBatch(projection, command) {
  const edits = command.arguments?.edits;
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 64) {
    throw new Error("batch.arguments.edits 必须包含 1–64 个编辑项");
  }
  const operations = [];
  const tracks = [];
  const qc = [];
  const seen = new Set();
  for (const [index, edit] of edits.entries()) {
    plainObject(edit, `edits[${index}]`);
    assertExactFields(edit, new Set(["itemId", "changes"]), `edits[${index}]`);
    const itemId = auditString(edit.itemId, `edits[${index}].itemId`);
    if (seen.has(itemId)) throw new Error(`batch 包含重复 itemId：${itemId}`);
    seen.add(itemId);
    const compiled = compileProjectionCommand(projection, {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      itemId, changes: edit.changes,
    });
    operations.push(...compiled.operations);
    tracks.push(...compiled.affectedTracks);
    qc.push(...compiled.requiredQc);
  }
  return compiledResult(operations, tracks, qc, { operation: "batch", itemCount: edits.length });
}

function compileMove(projection, command) {
  const itemIds = command.arguments?.itemIds;
  const deltaTick = command.arguments?.deltaTick;
  if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 64 || new Set(itemIds).size !== itemIds.length) {
    throw new Error("move.arguments.itemIds 必须是 1–64 个不重复 item id");
  }
  if (!Number.isSafeInteger(deltaTick) || deltaTick === 0) throw new Error("move.arguments.deltaTick 必须是非零安全整数");
  const keyframeOperations = [];
  const timebase = projectionTimebase(projection);
  const edits = itemIds.map((itemId) => {
    const item = findProjectionItem(projection, itemId);
    if (item.type === "picture") throw new Error("主画面不支持位置 move；请使用 reorder 或 trim");
    const field = Object.hasOwn(item.editBindings, "startTick") ? "startTick"
      : Object.hasOwn(item.editBindings, "targetLandingTick") ? "targetLandingTick"
        : Object.hasOwn(item.editBindings, "timeTick") ? "timeTick" : null;
    if (!field) throw new Error(`${item.id} 没有可移动的时间绑定`);
    const changes = { [field]: integerTick(item.startTick + deltaTick, `${item.id}.${field}`) };
    if (Object.hasOwn(item.editBindings, "endTick")) {
      changes.endTick = integerTick(item.endTick + deltaTick, `${item.id}.endTick`);
      if (changes.endTick > projection.durationTick) throw new Error(`${item.id} 移动后超出时间线`);
    } else if (changes[field] > projection.durationTick) throw new Error(`${item.id} 移动后超出时间线`);
    if (item.type === "overlay" && Object.keys(item.metadata.keyframes ?? {}).length > 0) {
      const shifted = Object.fromEntries(
        Object.entries(item.metadata.keyframes).map(([property, points]) => [
          property,
          points.map((point) => {
            const tick = integerTick(point.tick + deltaTick, `${item.id}.keyframes.${property}.tick`);
            return { ...point, tick, time: ticksToSeconds(tick, timebase) };
          }),
        ]),
      );
      keyframeOperations.push({ op: "replace", path: `${item.sourcePointer}/keyframes`, value: shifted });
    }
    return { itemId, changes };
  });
  const compiled = compileBatch(projection, { arguments: { edits } });
  compiled.operations.push(...keyframeOperations);
  compiled.proposed = { operation: "move", itemCount: itemIds.length, deltaTick };
  return compiled;
}

function compileTrim(projection, command) {
  const item = findProjectionItem(projection, command.itemId);
  const edge = command.arguments?.edge;
  const outputTick = integerTick(command.arguments?.outputTick, "trim.arguments.outputTick");
  if (!["start", "end"].includes(edge)) throw new Error("trim.arguments.edge 必须是 start|end");
  if (outputTick <= item.startTick || outputTick >= item.endTick) throw new Error("trim 必须保留正时长片段");
  let changes;
  if (item.type === "picture") {
    changes = edge === "start"
      ? { sourceStartTick: item.metadata.sourceStartTick + outputTick - item.startTick }
      : { sourceEndTick: item.metadata.sourceStartTick + outputTick - item.startTick };
  } else if (Object.hasOwn(item.editBindings, `${edge}Tick`)) changes = { [`${edge}Tick`]: outputTick };
  else throw new Error(`${item.id} 不支持 ${edge} trim`);
  return compileProjectionCommand(projection, {
    schemaVersion: "1.0", kind: "kacha-editor-command", itemId: item.id, changes,
  });
}

function structuralTransitionReset(timeline) {
  const transitions = timeline.transitions ?? [];
  if (transitions.some((entry) => Number(entry?.durationFrames ?? 0) > 0)) {
    throw new Error("存在已执行转场；请先显式移除或重新设计转场后再做结构编辑");
  }
  return transitions.length ? { op: "replace", path: "/transitions", value: [] } : null;
}

function compileSplit(projection, command, timeline) {
  const item = findProjectionItem(projection, command.itemId);
  if (item.type !== "picture") throw new Error("split 当前只支持主画面 EDL 片段");
  const outputTick = integerTick(command.arguments?.outputTick, "split.arguments.outputTick");
  const timebase = projectionTimebase(projection);
  if (outputTick <= item.startTick || outputTick >= item.endTick) throw new Error("split 点必须位于片段内部");
  if (outputTick % timebase.ticksPerFrame !== 0) throw new Error("split 点必须落在整帧边界");
  const index = Number(item.sourcePointer.split("/").at(-1));
  const original = structuredClone(timeline.edl[index]);
  const sourceSplitTick = item.metadata.sourceStartTick + outputTick - item.startTick;
  const newId = auditString(command.arguments?.newId ?? `${original.id ?? `segment-${index + 1}`}-split`, "split.arguments.newId");
  if ((timeline.edl ?? []).some((entry, entryIndex) => entryIndex !== index && entry.id === newId)) throw new Error(`split 新 id 已存在：${newId}`);
  const left = { ...original, sourceEndTick: sourceSplitTick, sourceEnd: ticksToSeconds(sourceSplitTick, timebase) };
  const right = { ...original, id: newId, sourceStartTick: sourceSplitTick, sourceStart: ticksToSeconds(sourceSplitTick, timebase) };
  const operations = [
    { op: "replace", path: `/edl/${index}`, value: left },
    { op: "add", path: `/edl/${index + 1}`, value: right },
  ];
  const reset = structuralTransitionReset(timeline);
  if (reset) operations.push(reset);
  return compiledResult(operations, ["picture"], ["connection_qc"], { operation: "split", sourceSplitTick });
}

function compileReorder(projection, command, timeline) {
  const itemIds = command.arguments?.itemIds;
  const pictures = projection.items.filter((item) => item.type === "picture");
  if (!Array.isArray(itemIds) || itemIds.length !== pictures.length || new Set(itemIds).size !== itemIds.length) {
    throw new Error("reorder.arguments.itemIds 必须完整列出所有主画面 item id 且不重复");
  }
  const byId = new Map(pictures.map((item) => [item.id, timeline.edl[Number(item.sourcePointer.split("/").at(-1))]]));
  if (itemIds.some((id) => !byId.has(id))) throw new Error("reorder 包含未知主画面 item id");
  const operations = [{ op: "replace", path: "/edl", value: itemIds.map((id) => structuredClone(byId.get(id))) }];
  const reset = structuralTransitionReset(timeline);
  if (reset) operations.push(reset);
  return compiledResult(operations, ["picture"], ["connection_qc"], { operation: "reorder", itemIds });
}

function compileMarker(projection, command, timeline) {
  const current = structuredClone(timeline.editor?.markers ?? []);
  if (!Array.isArray(current)) throw new Error("editor.markers 合同无效");
  if (command.operation === "marker_remove") {
    const id = auditString(command.arguments?.id, "marker_remove.arguments.id");
    const next = current.filter((marker) => marker.id !== id);
    if (next.length === current.length) throw new Error(`marker 不存在：${id}`);
    return compiledResult([editorMutation(timeline, "markers", next)], ["editor"], [], { operation: command.operation, id });
  }
  const marker = command.arguments?.marker;
  plainObject(marker, "marker");
  assertExactFields(marker, new Set(["id", "tick", "label", "color"]), "marker");
  const normalized = {
    id: auditString(marker.id, "marker.id"),
    tick: integerTick(marker.tick, "marker.tick"),
    label: auditString(marker.label, "marker.label", 500),
    color: marker.color === undefined ? "amber" : auditString(marker.color, "marker.color", 32),
  };
  if (normalized.tick > projection.durationTick) throw new Error("marker.tick 超出时间线");
  const index = current.findIndex((entry) => entry.id === normalized.id);
  if (index >= 0) current[index] = normalized; else current.push(normalized);
  current.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
  return compiledResult([editorMutation(timeline, "markers", current)], ["editor"], [], { operation: command.operation, marker: normalized });
}

function compileWorkArea(projection, command, timeline) {
  if (command.operation === "work_area_clear") {
    if (!timeline.editor?.workArea) throw new Error("editor.workArea 不存在");
    return compiledResult([{ op: "remove", path: "/editor/workArea" }], ["editor"], [], { operation: command.operation });
  }
  const startTick = integerTick(command.arguments?.startTick, "work_area_set.arguments.startTick");
  const endTick = integerTick(command.arguments?.endTick, "work_area_set.arguments.endTick");
  if (endTick <= startTick || endTick > projection.durationTick) throw new Error("work area 必须满足 0 <= start < end <= duration");
  return compiledResult([editorMutation(timeline, "workArea", { startTick, endTick })], ["editor"], [], { operation: command.operation, startTick, endTick });
}

function compileDeliveryFrames(command, timeline) {
  const frames = command.arguments?.frames;
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 8) throw new Error("delivery frames 必须包含 1–8 项");
  const ids = new Set();
  const normalized = frames.map((frame, index) => {
    plainObject(frame, `frames[${index}]`);
    assertExactFields(frame, new Set(["id", "label", "width", "height"]), `frames[${index}]`);
    const id = auditString(frame.id, `frames[${index}].id`);
    if (ids.has(id)) throw new Error(`delivery frame id 重复：${id}`);
    ids.add(id);
    const width = frame.width; const height = frame.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 16384 || height > 16384) throw new Error(`frames[${index}] width/height 必须是 64–16384 整数`);
    return { id, label: auditString(frame.label ?? id, `frames[${index}].label`, 120), width, height };
  });
  return compiledResult([editorMutation(timeline, "deliveryFrames", normalized)], ["editor"], [], { operation: command.operation, count: normalized.length });
}

function compileKeyframe(projection, command, timeline) {
  const item = findProjectionItem(projection, command.itemId);
  if (item.type !== "overlay") throw new Error("keyframe 当前只支持 overlay");
  const index = Number(item.sourcePointer.split("/").at(-1));
  const overlay = timeline.visual.overlays[index];
  const keyframes = structuredClone(overlay.keyframes ?? {});
  const tick = integerTick(command.arguments?.tick, "keyframe.tick");
  if (tick < item.startTick || tick > item.endTick) throw new Error("keyframe.tick 必须位于 overlay 区间内");
  let properties;
  if (command.operation === "keyframe_remove") {
    const property = command.arguments?.property;
    if (!["x", "y"].includes(property)) throw new Error("keyframe property 当前只支持 x|y，且会进入 FFmpeg 终渲染");
    const points = Array.isArray(keyframes[property]) ? keyframes[property] : [];
    const next = points.filter((point) => point.tick !== tick);
    if (next.length === points.length) throw new Error("指定 keyframe 不存在");
    if (next.length) keyframes[property] = next; else delete keyframes[property];
    properties = [property];
  } else {
    const hasValues = command.arguments?.values !== undefined;
    if (hasValues && (command.arguments.property !== undefined || command.arguments.value !== undefined)) {
      throw new Error("keyframe_set 必须使用 property + value 或 values，不能混用");
    }
    let entries;
    if (hasValues) {
      const values = plainObject(command.arguments.values, "keyframe.values");
      assertExactFields(values, new Set(["x", "y"]), "keyframe.values");
      entries = Object.entries(values);
      if (entries.length < 1) throw new Error("keyframe.values 至少包含 x 或 y");
    } else {
      const property = command.arguments?.property;
      if (!["x", "y"].includes(property)) throw new Error("keyframe property 当前只支持 x|y，且会进入 FFmpeg 终渲染");
      entries = [[property, command.arguments?.value]];
    }
    const timebase = projectionTimebase(projection);
    for (const [property, rawValue] of entries) {
      if (typeof rawValue !== "number") throw new Error(`keyframe.${property} 必须是有限 number`);
      const value = rawValue;
      const maximum = property === "x"
        ? Number(projection.output.width) - Number(item.metadata.width)
        : Number(projection.output.height) - Number(item.metadata.height);
      if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`keyframe.${property} 超出画布安全范围`);
      const points = Array.isArray(keyframes[property]) ? keyframes[property] : [];
      const point = { tick, time: ticksToSeconds(tick, timebase), value };
      const existing = points.findIndex((entry) => entry.tick === tick);
      if (existing >= 0) points[existing] = point; else points.push(point);
      keyframes[property] = points.sort((left, right) => left.tick - right.tick);
    }
    properties = entries.map(([property]) => property);
  }
  const pointer = `${item.sourcePointer}/keyframes`;
  const operation = overlay.keyframes
    ? Object.keys(keyframes).length ? { op: "replace", path: pointer, value: keyframes } : { op: "remove", path: pointer }
    : { op: "add", path: pointer, value: keyframes };
  return compiledResult([operation], ["overlays"], ["visual_dynamic_review"], {
    operation: command.operation, itemId: item.id, properties, tick,
  });
}

function compileReplaceMedia(projection, command) {
  const item = findProjectionItem(projection, command.itemId);
  const accepted = {
    overlay: new Set(["image", "video"]),
    bgm: new Set(["audio"]),
    sfx: new Set(["audio"]),
  }[item.type];
  if (!accepted) throw new Error(`${item.type} 当前不支持媒体替换`);
  const asset = resolveIndexedAsset(projection.timeline.path, {
    indexPath: command.arguments?.indexPath ?? null,
    assetRef: command.arguments?.assetRef,
  });
  if (!accepted.has(asset.kind)) throw new Error(`${item.type} 不能使用 ${asset.kind} 素材`);
  const value = {
    path: asset.path,
    sha256: asset.identity.sha256,
    license: asset.license,
    provenance: asset.provenance,
  };
  if (item.type === "overlay") value.kind = asset.kind;
  const qc = item.type === "overlay" ? ["visual_dynamic_review"] : ["audio_qc"];
  return compiledResult(
    [{ op: "merge", path: item.sourcePointer, value }],
    [item.trackId],
    qc,
    { operation: "replace_media", itemId: item.id, assetRef: asset.ref },
  );
}

export function compileEditorOperation(projection, command) {
  if (!command || command.schemaVersion !== "1.0" || command.kind !== "kacha-editor-command") throw new Error("command 必须是 kacha-editor-command 1.0");
  validateOperationCommand(command);
  const timeline = readJson(projection.timeline.path);
  if (command.operation === "batch") return compileBatch(projection, command);
  if (command.operation === "move") return compileMove(projection, command);
  if (command.operation === "trim") return compileTrim(projection, command);
  if (command.operation === "split") return compileSplit(projection, command, timeline);
  if (command.operation === "reorder") return compileReorder(projection, command, timeline);
  if (command.operation.startsWith("marker_")) return compileMarker(projection, command, timeline);
  if (command.operation.startsWith("work_area_")) return compileWorkArea(projection, command, timeline);
  if (command.operation.startsWith("keyframe_")) return compileKeyframe(projection, command, timeline);
  if (command.operation === "replace_media") return compileReplaceMedia(projection, command);
  return compileDeliveryFrames(command, timeline);
}
