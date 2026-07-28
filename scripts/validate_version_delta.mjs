#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  hasValue,
  parseRatio,
  readJson,
  resolveFrom,
  sha256File,
} from "./kacha_utils.mjs";

const LAYERS = new Set([
  "visual",
  "dialogue",
  "bgm",
  "sfx",
  "subtitles",
  "covers",
  "metadata",
]);
const TIMED_LAYERS = ["visual", "dialogue", "bgm", "sfx", "subtitles"];
const INTENTS = new Set(["preview", "candidate", "release_candidate"]);
const STRATEGIES = new Set([
  "auto",
  "no_video_render",
  "metadata_rewrap",
  "stream_copy_video",
  "stream_copy_audio",
  "layer_rebuild",
  "segment_rebuild",
  "full_rebuild",
]);
const CHANGE_LAYER_REQUIREMENTS = {
  metadata_rewrap: ["metadata"],
  cover_only: ["covers"],
  subtitle_only: ["subtitles"],
  bgm_adjust: ["bgm"],
  sfx_adjust: ["sfx"],
  dialogue_adjust: ["dialogue"],
  beauty_adjust: ["visual"],
  color_adjust: ["visual"],
  visual_interval: ["visual"],
  insert_replace: ["visual"],
  remove_interval: TIMED_LAYERS,
  reorder: TIMED_LAYERS,
  geometry_change: ["visual", "metadata"],
  style_change: ["visual", "subtitles"],
  timing_sync: ["visual", "sfx"],
  popup_layout: ["visual"],
  connection_repair: ["visual", "sfx"],
};
const STRUCTURAL_TYPES = new Set([
  "remove_interval",
  "reorder",
  "geometry_change",
]);
const SHA256 = /^[a-f0-9]{64}$/i;

function required(object, fields, label, errors) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    errors.push(`${label}: 必须是对象`);
    return;
  }
  for (const field of fields) {
    if (!hasValue(object[field])) errors.push(`${label}: 缺少 ${field}`);
  }
}

function frameAligned(value, fps) {
  return Number.isFinite(value)
    && Math.abs(value * fps - Math.round(value * fps)) <= 0.001;
}

const args = process.argv.slice(2);
const input = args.find((item) => !item.startsWith("--"));
const template = args.includes("--template");
if (!input) {
  console.error("用法：validate_version_delta.mjs <version-delta.json> [--template]");
  process.exit(2);
}

const deltaFile = path.resolve(input);
let delta;
try {
  delta = readJson(deltaFile);
} catch (error) {
  console.error(`无法读取 version delta：${error.message}`);
  process.exit(2);
}

const errors = [];
if (delta.schemaVersion !== "3.0") errors.push("schemaVersion 必须为 3.0");
required(
  delta,
  [
    "projectContext",
    "contextSha256",
    "baseVersionId",
    "newVersion",
    "changeSet",
    "render",
    "deliverables",
    "reviewReportPath",
  ],
  "delta",
  errors,
);

let context = null;
let contextFile = null;
if (!template && hasValue(delta.projectContext)) {
  contextFile = resolveFrom(deltaFile, delta.projectContext);
  if (!contextFile || !fs.existsSync(contextFile)) {
    errors.push(`projectContext 不存在：${contextFile ?? delta.projectContext}`);
  } else {
    try {
      context = readJson(contextFile);
      if (
        !SHA256.test(delta.contextSha256 ?? "")
        || sha256File(contextFile).toLowerCase() !== delta.contextSha256.toLowerCase()
      ) {
        errors.push("contextSha256 与 projectContext 不一致");
      }
      if (context.schemaVersion !== "3.0") {
        errors.push("projectContext.schemaVersion 必须为 3.0");
      }
      if (context.baseline?.versionId !== delta.baseVersionId) {
        errors.push("baseVersionId 与 projectContext.baseline.versionId 不一致");
      }
    } catch (error) {
      errors.push(`无法解析 projectContext：${error.message}`);
    }
  }
}

required(
  delta.newVersion,
  ["id", "intent", "overwriteBase"],
  "newVersion",
  errors,
);
if (!INTENTS.has(delta.newVersion?.intent)) {
  errors.push(`newVersion.intent 无效：${delta.newVersion?.intent}`);
}
if (delta.newVersion?.overwriteBase !== false) {
  errors.push("newVersion.overwriteBase 必须为 false");
}
if (delta.newVersion?.id === delta.baseVersionId) {
  errors.push("newVersion.id 不得等于 baseVersionId");
}

required(
  delta.changeSet,
  [
    "summary",
    "types",
    "changedLayers",
    "scope",
    "durationChange",
    "outputDurationSeconds",
    "reason",
    "acceptanceCriteria",
  ],
  "changeSet",
  errors,
);
const types = Array.isArray(delta.changeSet?.types) ? delta.changeSet.types : [];
const changedLayers = Array.isArray(delta.changeSet?.changedLayers)
  ? delta.changeSet.changedLayers
  : [];
if (types.length === 0) errors.push("changeSet.types 不能为空");
if (changedLayers.length === 0) errors.push("changeSet.changedLayers 不能为空");
for (const type of types) {
  if (!Object.hasOwn(CHANGE_LAYER_REQUIREMENTS, type)) {
    errors.push(`changeSet.types 包含未知类型：${type}`);
    continue;
  }
  for (const layer of CHANGE_LAYER_REQUIREMENTS[type]) {
    if (!changedLayers.includes(layer)) {
      errors.push(`change type ${type} 要求 changedLayers 包含 ${layer}`);
    }
  }
}
for (const layer of changedLayers) {
  if (!LAYERS.has(layer)) errors.push(`未知 changed layer：${layer}`);
}
if (new Set(changedLayers).size !== changedLayers.length) {
  errors.push("changeSet.changedLayers 不得重复");
}
if (typeof delta.changeSet?.durationChange !== "boolean") {
  errors.push("changeSet.durationChange 必须是 boolean");
}
if (!(Number(delta.changeSet?.outputDurationSeconds) > 0)) {
  errors.push("changeSet.outputDurationSeconds 必须为正数");
}
if (
  !Array.isArray(delta.changeSet?.acceptanceCriteria)
  || delta.changeSet.acceptanceCriteria.length === 0
) {
  errors.push("changeSet.acceptanceCriteria 必须是非空数组");
}

required(delta.changeSet?.scope, ["kind"], "changeSet.scope", errors);
const scopeKind = delta.changeSet?.scope?.kind;
if (!["full", "intervals", "no_timeline"].includes(scopeKind)) {
  errors.push("changeSet.scope.kind 必须为 full、intervals 或 no_timeline");
}
const intervals = Array.isArray(delta.changeSet?.scope?.intervals)
  ? delta.changeSet.scope.intervals
  : [];
const fps = Number(context?.source?.media?.fps);
const baseDuration = Number(context?.source?.media?.durationSeconds);
if (scopeKind === "intervals" && intervals.length === 0) {
  errors.push("intervals scope 必须提供至少一个区间");
}
if (scopeKind !== "intervals" && intervals.length > 0) {
  errors.push("只有 intervals scope 可以包含 intervals");
}
if (!template && scopeKind === "intervals") {
  for (const [index, interval] of intervals.entries()) {
    const start = Number(interval?.startSeconds);
    const end = Number(interval?.endSeconds);
    if (
      !frameAligned(start, fps)
      || !frameAligned(end, fps)
      || !(end > start)
      || end > baseDuration + 0.0005
    ) {
      errors.push(`changeSet.scope.intervals[${index}] 必须有效、帧对齐且不越界`);
    }
  }
}
if (
  types.every((type) => ["cover_only", "metadata_rewrap"].includes(type))
  && scopeKind !== "no_timeline"
) {
  errors.push("纯封面或元数据变化必须使用 no_timeline scope");
}
if (
  types.some((type) => STRUCTURAL_TYPES.has(type))
  && delta.changeSet?.durationChange !== true
  && types.some((type) => ["remove_interval", "reorder"].includes(type))
) {
  errors.push("删除或重排必须设置 durationChange=true");
}
if (
  !template
  && context
  && delta.changeSet?.durationChange === false
  && Math.abs(Number(delta.changeSet.outputDurationSeconds) - baseDuration) > 0.5 / fps
) {
  errors.push("未改变时长时 outputDurationSeconds 必须等于基线时长");
}

required(delta.render, ["requestedStrategy", "handleFrames"], "render", errors);
if (!STRATEGIES.has(delta.render?.requestedStrategy)) {
  errors.push(`render.requestedStrategy 无效：${delta.render?.requestedStrategy}`);
}
if (
  !Number.isInteger(delta.render?.handleFrames)
  || delta.render.handleFrames < 0
  || delta.render.handleFrames > 250
) {
  errors.push("render.handleFrames 必须是 0 至 250 的整数");
}
if (
  Object.hasOwn(delta, "reuseRequests")
  && !Array.isArray(delta.reuseRequests)
) {
  errors.push("reuseRequests 必须是数组");
}
for (const [index, request] of (delta.reuseRequests ?? []).entries()) {
  required(
    request,
    ["artifactId", "fingerprint"],
    `reuseRequests[${index}]`,
    errors,
  );
  if (!template && !SHA256.test(request?.fingerprint ?? "")) {
    errors.push(`reuseRequests[${index}].fingerprint 必须是真实 SHA-256`);
  }
}

if (!delta.deliverables || typeof delta.deliverables !== "object") {
  errors.push("deliverables 必须是对象");
}
for (const field of ["video", "covers", "subtitles"]) {
  if (!Object.hasOwn(delta.deliverables ?? {}, field)) {
    errors.push(`deliverables 缺少 ${field}`);
  }
}
if (typeof delta.deliverables?.video !== "boolean") {
  errors.push("deliverables.video 必须是 boolean");
}
if (!Array.isArray(delta.deliverables?.covers)) {
  errors.push("deliverables.covers 必须是数组");
}
if (!Array.isArray(delta.deliverables?.subtitles)) {
  errors.push("deliverables.subtitles 必须是数组");
}
if (delta.deliverables?.video && !hasValue(delta.newVersion?.outputPath)) {
  errors.push("交付视频时 newVersion.outputPath 不能为空");
}
if (
  !delta.deliverables?.video
  && (changedLayers.includes("visual")
    || changedLayers.includes("dialogue")
    || changedLayers.includes("bgm")
    || changedLayers.includes("sfx")
    || changedLayers.includes("subtitles"))
) {
  errors.push("修改时间线媒体层时 deliverables.video 必须为 true");
}
if (
  types.includes("metadata_rewrap")
  && delta.deliverables?.video !== true
) {
  errors.push("metadata_rewrap 必须交付独立重封装视频");
}
if (
  delta.deliverables?.video !== true
  && (delta.deliverables?.covers ?? []).length === 0
  && (delta.deliverables?.subtitles ?? []).length === 0
) {
  errors.push("本轮至少要交付视频、封面或字幕中的一种");
}
for (const [index, cover] of (delta.deliverables?.covers ?? []).entries()) {
  required(cover, ["aspectRatio", "path"], `deliverables.covers[${index}]`, errors);
  if (!parseRatio(cover?.aspectRatio)) {
    errors.push(`deliverables.covers[${index}].aspectRatio 无效`);
  }
}
for (const [index, subtitle] of (delta.deliverables?.subtitles ?? []).entries()) {
  required(subtitle, ["language", "path"], `deliverables.subtitles[${index}]`, errors);
}
if (changedLayers.includes("covers") && (delta.deliverables?.covers ?? []).length === 0) {
  errors.push("修改 covers layer 时必须提供 deliverables.covers");
}

if (!template && context) {
  const stableArtifacts = new Set(context.delivery?.artifacts ?? []);
  if (delta.deliverables?.video && !stableArtifacts.has("video")) {
    errors.push("当前 project context 未授权 video 交付物");
  }
  if ((delta.deliverables?.covers ?? []).length > 0 && !stableArtifacts.has("covers")) {
    errors.push("当前 project context 未授权 covers 交付物");
  }
  if (
    (delta.deliverables?.subtitles ?? []).length > 0
    && !stableArtifacts.has("subtitles")
  ) {
    errors.push("当前 project context 未授权 subtitles 交付物");
  }
  const allowedRatios = new Set(context.delivery?.coverAspectRatios ?? []);
  for (const cover of delta.deliverables?.covers ?? []) {
    if (!allowedRatios.has(cover.aspectRatio)) {
      errors.push(`封面画幅未包含在 project context：${cover.aspectRatio}`);
    }
  }
  const allowedLanguages = new Set(context.delivery?.subtitleLanguages ?? []);
  for (const subtitle of delta.deliverables?.subtitles ?? []) {
    if (!allowedLanguages.has(subtitle.language)) {
      errors.push(`字幕语言未包含在 project context：${subtitle.language}`);
    }
  }
  if (delta.deliverables?.video) {
    const output = resolveFrom(deltaFile, delta.newVersion.outputPath);
    const baseline = resolveFrom(contextFile, context.baseline?.video?.path);
    if (output === baseline) errors.push("newVersion.outputPath 不得覆盖基线视频");
  }
}

if (errors.length > 0) {
  console.error(`version delta 检查失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      file: deltaFile,
      template,
      baseVersionId: delta.baseVersionId,
      newVersionId: delta.newVersion.id,
      intent: delta.newVersion.intent,
      changedLayers,
      inferredFrozenLayers: [...LAYERS].filter(
        (layer) => !changedLayers.includes(layer),
      ),
    },
    null,
    2,
  ),
);
