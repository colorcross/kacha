#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  hasValue,
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
const CHANGE_TYPES = new Set([
  "audio_asset_replace",
  "remove_interval",
  "subtitle_only",
  "cover_only",
  "visual_interval",
  "semantic_netstyle",
  "visual_breathing",
  "caption_layout",
  "metadata_only",
]);
const RENDER_STRATEGIES = new Set([
  "stream_copy_video",
  "frozen_master_rebuild",
  "gop_splice",
  "metadata_rewrap",
]);
const REQUIRED_AUDIT = [
  "proposal",
  "editPlan",
  "projectManifest",
  "technicalQc",
  "releaseReport",
];
const SHA256 = /^[a-f0-9]{64}$/i;

function usage() {
  console.error(
    "用法：validate_local_change_plan.mjs <local-change-plan.json> [--template]",
  );
}

function required(object, fields, label, errors) {
  for (const field of fields) {
    if (!hasValue(object?.[field])) errors.push(`${label}: 缺少 ${field}`);
  }
}

function frameAligned(value, fps) {
  return Number.isFinite(value)
    && Math.abs(value * fps - Math.round(value * fps)) <= 0.001;
}

function validateIntervals(intervals, fps, duration, label, errors) {
  if (!Array.isArray(intervals) || intervals.length === 0) {
    errors.push(`${label}: affectedIntervals 必须是非空数组`);
    return;
  }
  intervals.forEach((interval, index) => {
    const itemLabel = `${label}.affectedIntervals[${index}]`;
    const start = Number(interval?.startSeconds);
    const end = Number(interval?.endSeconds);
    if (
      !frameAligned(start, fps)
      || !frameAligned(end, fps)
      || !(end > start)
    ) {
      errors.push(`${itemLabel}: 起止时间必须有效并对齐帧边界`);
    }
    if (Number.isFinite(duration) && end > duration + 0.0005) {
      errors.push(`${itemLabel}: 超过基础版本时长`);
    }
  });
}

function containsTime(intervals, time) {
  return intervals.some((interval) => (
    time >= Number(interval.startSeconds) - 0.0005
    && time <= Number(interval.endSeconds) + 0.0005
  ));
}

function validateAsset(change, planFile, template, errors) {
  const label = `changes[${change.__index}].asset`;
  required(
    change.asset,
    ["manifestPath", "assetId", "readySha256"],
    label,
    errors,
  );
  if (template || !change.asset) return;
  const manifestFile = resolveFrom(planFile, change.asset.manifestPath);
  if (!manifestFile || !fs.existsSync(manifestFile)) {
    errors.push(`${label}: 音效库 manifest 不存在`);
    return;
  }
  let manifest;
  try {
    manifest = readJson(manifestFile);
  } catch (error) {
    errors.push(`${label}: 无法读取 manifest：${error.message}`);
    return;
  }
  const asset = (manifest.assets ?? []).find(
    (candidate) => candidate.id === change.asset.assetId,
  );
  if (!asset) {
    errors.push(`${label}: assetId 不存在：${change.asset.assetId}`);
    return;
  }
  if (
    !SHA256.test(change.asset.readySha256)
    || asset.ready_sha256 !== change.asset.readySha256
  ) {
    errors.push(`${label}: 计划中的 readySha256 与 manifest 不一致`);
  }
  const readyFile = resolveFrom(manifestFile, asset.ready_file);
  if (!readyFile || !fs.existsSync(readyFile)) {
    errors.push(`${label}: ready_file 不存在`);
  } else if (sha256File(readyFile) !== asset.ready_sha256) {
    errors.push(`${label}: ready_file 内容与 manifest 哈希不一致`);
  }
}

const args = process.argv.slice(2);
const input = args.find((argument) => !argument.startsWith("--"));
const template = args.includes("--template");
if (!input) {
  usage();
  process.exit(2);
}

const planFile = path.resolve(input);
let plan;
try {
  plan = readJson(planFile);
} catch (error) {
  console.error(`无法读取局部优化计划：${error.message}`);
  process.exit(2);
}

const errors = [];
if (plan.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
if (plan.taskPath !== "local_optimization") {
  errors.push("taskPath 必须为 local_optimization");
}
required(
  plan,
  [
    "baseVersion",
    "newVersion",
    "renderStrategy",
    "outputDurationSeconds",
    "changes",
    "auditRegeneration",
    "qcPlan",
  ],
  "plan",
  errors,
);

const fps = Number(plan.baseVersion?.fps);
const baseDuration = Number(plan.baseVersion?.durationSeconds);
const outputDuration = Number(plan.outputDurationSeconds);
if (!(fps > 0)) errors.push("baseVersion.fps 必须为正数");
if (!(baseDuration > 0)) errors.push("baseVersion.durationSeconds 必须为正数");
if (!(outputDuration > 0)) errors.push("outputDurationSeconds 必须为正数");
required(
  plan.baseVersion,
  ["path", "sha256", "durationSeconds", "fps"],
  "baseVersion",
  errors,
);
required(
  plan.newVersion,
  ["id", "outputPath", "overwriteBase"],
  "newVersion",
  errors,
);
if (plan.newVersion?.overwriteBase !== false) {
  errors.push("newVersion.overwriteBase 必须为 false");
}
if (
  hasValue(plan.baseVersion?.path)
  && hasValue(plan.newVersion?.outputPath)
  && resolveFrom(planFile, plan.baseVersion.path)
    === resolveFrom(planFile, plan.newVersion.outputPath)
) {
  errors.push("新版本输出不得与基础版本相同");
}
if (!RENDER_STRATEGIES.has(plan.renderStrategy)) {
  errors.push(`renderStrategy 无效：${plan.renderStrategy}`);
}

if (!template) {
  const baseFile = resolveFrom(planFile, plan.baseVersion?.path);
  if (!baseFile || !fs.existsSync(baseFile)) {
    errors.push("baseVersion.path 不存在");
  } else if (
    !SHA256.test(plan.baseVersion.sha256 ?? "")
    || sha256File(baseFile) !== plan.baseVersion.sha256
  ) {
    errors.push("baseVersion.sha256 与基础版本不一致");
  }
}

const changes = Array.isArray(plan.changes) ? plan.changes : [];
if (changes.length === 0) errors.push("changes 必须是非空数组");
const ids = new Set();
let removedDuration = 0;
let hasRemoveInterval = false;

changes.forEach((rawChange, index) => {
  const change = { ...rawChange, __index: index };
  const label = `changes[${index}]`;
  required(
    change,
    [
      "id",
      "type",
      "changedLayers",
      "frozenLayers",
      "affectedIntervals",
      "reason",
      "failureCondition",
      "qcEvidence",
    ],
    label,
    errors,
  );
  if (ids.has(change.id)) errors.push(`${label}: id 重复`);
  ids.add(change.id);
  if (!CHANGE_TYPES.has(change.type)) {
    errors.push(`${label}: type 无效：${change.type}`);
  }
  const changed = Array.isArray(change.changedLayers) ? change.changedLayers : [];
  const frozen = Array.isArray(change.frozenLayers) ? change.frozenLayers : [];
  for (const layer of [...changed, ...frozen]) {
    if (!LAYERS.has(layer)) errors.push(`${label}: 未知 layer：${layer}`);
  }
  for (const layer of changed) {
    if (frozen.includes(layer)) {
      errors.push(`${label}: ${layer} 不能同时 changed 和 frozen`);
    }
  }
  const uncovered = [...LAYERS].filter(
    (layer) => !changed.includes(layer) && !frozen.includes(layer),
  );
  if (uncovered.length > 0) {
    errors.push(`${label}: 未声明冻结状态的 layer：${uncovered.join(", ")}`);
  }
  validateIntervals(change.affectedIntervals, fps, baseDuration, label, errors);

  if (change.type === "audio_asset_replace") {
    if (changed.length !== 1 || changed[0] !== "sfx") {
      errors.push(`${label}: audio_asset_replace 只能修改 sfx layer`);
    }
    required(change, ["asset", "eventTimesSeconds"], label, errors);
    const times = Array.isArray(change.eventTimesSeconds)
      ? change.eventTimesSeconds
      : [];
    if (times.length === 0) errors.push(`${label}: eventTimesSeconds 不能为空`);
    if (times.some((time) => !frameAligned(Number(time), fps))) {
      errors.push(`${label}: 每个音效时点必须对齐帧边界`);
    }
    if (times.some((time) => !containsTime(change.affectedIntervals ?? [], Number(time)))) {
      errors.push(`${label}: 每个音效时点必须落在 affectedIntervals 内`);
    }
    validateAsset(change, planFile, template, errors);
  }

  if (change.type === "remove_interval") {
    hasRemoveInterval = true;
    required(
      change,
      [
        "sourceInterval",
        "semanticJoin",
        "remapAllTimelineLayers",
        "subtitleExitLeadFrames",
      ],
      label,
      errors,
    );
    const start = Number(change.sourceInterval?.startSeconds);
    const end = Number(change.sourceInterval?.endSeconds);
    if (
      !frameAligned(start, fps)
      || !frameAligned(end, fps)
      || !(end > start)
    ) {
      errors.push(`${label}: sourceInterval 必须有效并对齐帧边界`);
    } else {
      removedDuration += end - start;
    }
    if (
      !containsTime(change.affectedIntervals ?? [], start)
      || !containsTime(change.affectedIntervals ?? [], end)
    ) {
      errors.push(`${label}: sourceInterval 必须被 affectedIntervals 完整覆盖`);
    }
    if (change.remapAllTimelineLayers !== true) {
      errors.push(`${label}: 删段必须 remapAllTimelineLayers=true`);
    }
    for (const layer of TIMED_LAYERS) {
      if (!changed.includes(layer)) {
        errors.push(`${label}: 删段必须修改全部时间层，缺少 ${layer}`);
      }
    }
    required(
      change.semanticJoin,
      ["beforeText", "afterText", "boundaryEvidence"],
      `${label}.semanticJoin`,
      errors,
    );
    const lead = Number(change.subtitleExitLeadFrames);
    if (!Number.isInteger(lead) || lead < 1 || lead > 4) {
      errors.push(`${label}: subtitleExitLeadFrames 必须为 1 至 4`);
    }
  }
});

const removedIntervals = changes
  .filter((change) => change.type === "remove_interval")
  .map((change) => ({
    start: Number(change.sourceInterval?.startSeconds),
    end: Number(change.sourceInterval?.endSeconds),
  }))
  .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end))
  .sort((left, right) => left.start - right.start);
for (let index = 1; index < removedIntervals.length; index += 1) {
  if (removedIntervals[index].start < removedIntervals[index - 1].end - 0.0005) {
    errors.push("remove_interval 之间不得重叠");
  }
}

if (
  Number.isFinite(baseDuration)
  && Number.isFinite(outputDuration)
  && Math.abs(baseDuration - removedDuration - outputDuration) > 0.5 / fps
) {
  errors.push("outputDurationSeconds 与删段后的精确时长不一致");
}
if (
  hasRemoveInterval
  && !["frozen_master_rebuild", "gop_splice"].includes(plan.renderStrategy)
) {
  errors.push("包含删段时 renderStrategy 必须为 frozen_master_rebuild 或 gop_splice");
}
if (
  !hasRemoveInterval
  && changes.every((change) => change.type === "audio_asset_replace")
  && plan.renderStrategy !== "stream_copy_video"
) {
  errors.push("纯音效替换必须 stream_copy_video，避免无意义重编码画面");
}

const audit = new Set(plan.auditRegeneration ?? []);
for (const item of REQUIRED_AUDIT) {
  if (!audit.has(item)) errors.push(`auditRegeneration 缺少 ${item}`);
}
required(
  plan.qcPlan,
  [
    "boundaryPreviews",
    "fullDecode",
    "declaredAndAverageFps",
    "audioVideoDrift",
    "frozenRegression",
  ],
  "qcPlan",
  errors,
);

if (errors.length > 0) {
  console.error(`局部优化计划检查失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      file: planFile,
      template,
      changes: changes.length,
      removedDurationSeconds: Number(removedDuration.toFixed(6)),
      outputDurationSeconds: outputDuration,
      renderStrategy: plan.renderStrategy,
      rules: {
        independentVersion: "required",
        explicitChangedAndFrozenLayers: "required",
        semanticFrameAlignedRemoval: "required",
        subtitlePreExit: "1-4 frames",
        auditRegeneration: REQUIRED_AUDIT,
      },
    },
    null,
    2,
  ),
);
