#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  asArray,
  daysBetween,
  ffprobe,
  hasValue,
  parseRatio,
  readJson,
  resolveFrom,
  sha256File,
} from "./kacha_utils.mjs";

const MODES = new Set([
  "text_to_video",
  "image_to_video",
  "start_end_frame",
  "subject_reference",
  "multimodal_reference",
]);
const AUDIO_POLICIES = new Set([
  "none",
  "ambience_only",
  "model_audio",
  "local_post",
]);
const ASSET_TYPES = new Set(["image", "video", "audio"]);
const ASSET_ROLES = new Set([
  "first_frame",
  "last_frame",
  "subject",
  "character",
  "scene",
  "action",
  "camera",
  "composition",
  "style",
  "material",
  "audio",
]);
const QC_TARGETS = new Set([
  "semantic",
  "identity",
  "continuity",
  "geometry",
  "physics",
  "camera",
  "temporal",
  "style",
  "framing",
  "editHandles",
  "audio",
  "technical",
  "traceability",
]);
const REQUIRED_QC_GROUPS = [
  ["semantic"],
  ["identity", "continuity"],
  ["geometry", "physics"],
  ["camera", "temporal"],
  ["style"],
  ["framing", "editHandles"],
  ["audio"],
  ["technical", "traceability"],
];
const SHA256 = /^[a-f0-9]{64}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function pushMissing(errors, label, object, fields) {
  for (const field of fields) {
    if (!hasValue(object?.[field])) errors.push(`${label}: 缺少 ${field}`);
  }
}

function normalizedRatioMatches(value, supported) {
  const target = parseRatio(value);
  if (!target) return false;
  return asArray(supported).some((candidate) => {
    const ratio = parseRatio(candidate);
    return ratio && Math.abs(ratio.value - target.value) < 0.0001;
  });
}

function validateCapabilitySnapshot(snapshot, errors, maxAgeDays, templateMode) {
  if (!hasValue(snapshot)) {
    errors.push("缺少 capabilitySnapshot；生成前必须记录当前模型与接口能力");
    return;
  }
  if (!ISO_DATE.test(snapshot.verifiedAt ?? "")) {
    errors.push("capabilitySnapshot.verifiedAt 必须是 YYYY-MM-DD");
  } else if (!templateMode) {
    const age = daysBetween(snapshot.verifiedAt);
    if (!Number.isFinite(age) || age < 0) {
      errors.push("capabilitySnapshot.verifiedAt 不得晚于今天");
    } else if (age > maxAgeDays) {
      errors.push(
        `capabilitySnapshot 已过期：${age} 天前验证，最大允许 ${maxAgeDays} 天`,
      );
    }
  }
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length === 0) {
    errors.push("capabilitySnapshot.sources 至少包含一个官方或本机运行时来源");
  }
  if (
    snapshot.providers === null
    || typeof snapshot.providers !== "object"
    || Array.isArray(snapshot.providers)
    || Object.keys(snapshot.providers).length === 0
  ) {
    errors.push("capabilitySnapshot.providers 不能为空");
    return;
  }

  for (const [providerName, provider] of Object.entries(snapshot.providers)) {
    const label = `capabilitySnapshot.providers.${providerName}`;
    pushMissing(errors, label, provider, [
      "transport",
      "models",
      "supportedModes",
      "supportedDurations",
      "supportedResolutions",
      "supportedAspectRatios",
      "exposedParameters",
      "runtimeEvidence",
    ]);
    for (const field of [
      "models",
      "supportedModes",
      "supportedDurations",
      "supportedResolutions",
      "supportedAspectRatios",
      "exposedParameters",
    ]) {
      if (!Array.isArray(provider?.[field]) || provider[field].length === 0) {
        errors.push(`${label}.${field} 必须是非空数组`);
      }
    }
    for (const mode of asArray(provider?.supportedModes)) {
      if (!MODES.has(mode)) errors.push(`${label}: 未知 supportedMode：${mode}`);
    }
    for (const duration of asArray(provider?.supportedDurations)) {
      if (!Number.isFinite(duration) || duration <= 0) {
        errors.push(`${label}: supportedDurations 必须全部为正数`);
      }
    }
    for (const ratio of asArray(provider?.supportedAspectRatios)) {
      if (!parseRatio(ratio)) {
        errors.push(`${label}: 无效 supportedAspectRatio：${ratio}`);
      }
    }
    if (provider?.nativeAudio !== true && provider?.nativeAudio !== false) {
      errors.push(`${label}: nativeAudio 必须为 boolean`);
    }
  }
}

function validateAsset(asset, shotLabel, index, errors, planFile, templateMode) {
  const label = `${shotLabel}.referenceAssets[${index}]`;
  pushMissing(
    errors,
    label,
    asset,
    ["id", "type", "role", "localPath", "sha256", "source", "license"],
  );
  if (!ASSET_TYPES.has(asset?.type)) {
    errors.push(`${label}: type 必须是 image、video 或 audio`);
  }
  if (!ASSET_ROLES.has(asset?.role)) {
    errors.push(`${label}: 未知 role：${asset?.role}`);
  }
  if (hasValue(asset?.sha256) && !SHA256.test(asset.sha256)) {
    errors.push(`${label}: sha256 必须是 64 位十六进制`);
  }
  if (templateMode || !hasValue(asset?.localPath)) return;

  const resolved = resolveFrom(planFile, asset.localPath);
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    errors.push(`${label}: 本地文件不存在：${resolved ?? asset.localPath}`);
    return;
  }
  if (SHA256.test(asset.sha256 ?? "")) {
    const actual = sha256File(resolved);
    if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
      errors.push(`${label}: sha256 与文件内容不一致`);
    }
  }
  try {
    const probe = ffprobe(resolved);
    const videoStreams = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
    const audioStreams = probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
    if (asset.type === "image" && videoStreams.length === 0) {
      errors.push(`${label}: type=image 但文件不是可解码图像`);
    }
    if (asset.type === "video") {
      const duration = Number(probe.format?.duration ?? videoStreams[0]?.duration);
      if (videoStreams.length === 0 || !(duration > 0)) {
        errors.push(`${label}: type=video 但文件不是有效视频`);
      }
    }
    if (asset.type === "audio" && audioStreams.length === 0) {
      errors.push(`${label}: type=audio 但文件不是有效音频`);
    }
  } catch (error) {
    errors.push(`${label}: 参考素材无法解码：${error.message}`);
  }
}

function validateActionBeats(beats, duration, label, errors) {
  if (!Array.isArray(beats) || beats.length === 0) {
    errors.push(`${label}: actionBeats 至少包含一个可见动作`);
    return;
  }
  let previousEnd = 0;
  beats.forEach((beat, index) => {
    const beatLabel = `${label}.actionBeats[${index}]`;
    pushMissing(errors, beatLabel, beat, ["startSeconds", "endSeconds", "action"]);
    if (
      !Number.isFinite(beat?.startSeconds)
      || !Number.isFinite(beat?.endSeconds)
      || beat.startSeconds < 0
      || beat.endSeconds <= beat.startSeconds
    ) {
      errors.push(`${beatLabel}: 时间范围无效`);
      return;
    }
    if (beat.startSeconds < previousEnd) {
      errors.push(`${beatLabel}: actionBeats 不得重叠或逆序`);
    }
    if (Number.isFinite(duration) && beat.endSeconds > duration + 0.001) {
      errors.push(`${beatLabel}: 动作结束时间超过 durationSeconds`);
    }
    previousEnd = beat.endSeconds;
  });
  if (Number.isFinite(duration) && duration <= 6 && beats.length > 3) {
    errors.push(`${label}: 6 秒及以下镜头最多规划 3 个动作节拍；请拆镜`);
  }
}

function validateModeAssets(shot, label, errors) {
  const assets = asArray(shot.referenceAssets);
  const roles = assets.map((asset) => asset.role);
  const uniqueRoles = new Set(roles);
  const ids = assets.map((asset) => asset.id);
  if (ids.length !== new Set(ids).size) {
    errors.push(`${label}: referenceAssets.id 不得重复`);
  }
  for (const singularRole of ["first_frame", "last_frame"]) {
    if (roles.filter((role) => role === singularRole).length > 1) {
      errors.push(`${label}: role=${singularRole} 最多一个`);
    }
  }
  if (shot.mode === "text_to_video" && assets.length > 0) {
    errors.push(`${label}: text_to_video 不得携带参考素材；请改用相应参考模式`);
  }
  if (shot.mode === "image_to_video" && !uniqueRoles.has("first_frame")) {
    errors.push(`${label}: image_to_video 必须提供 role=first_frame`);
  }
  if (
    shot.mode === "start_end_frame"
    && (!uniqueRoles.has("first_frame") || !uniqueRoles.has("last_frame"))
  ) {
    errors.push(`${label}: start_end_frame 必须同时提供 first_frame 与 last_frame`);
  }
  if (
    shot.mode === "subject_reference"
    && !uniqueRoles.has("subject")
    && !uniqueRoles.has("character")
  ) {
    errors.push(`${label}: subject_reference 必须提供 subject 或 character 参考`);
  }
  if (shot.mode === "multimodal_reference" && assets.length < 2) {
    errors.push(`${label}: multimodal_reference 至少提供两个角色明确的参考素材`);
  }
}

function validateProviderCompatibility(shot, snapshot, label, errors) {
  const providerName = shot.routing?.provider;
  const provider = snapshot?.providers?.[providerName];
  if (!provider) {
    errors.push(`${label}: routing.provider 未出现在 capabilitySnapshot.providers`);
    return;
  }
  if (shot.routing?.transport !== provider.transport) {
    errors.push(
      `${label}: routing.transport=${shot.routing?.transport} 与能力快照 ${provider.transport} 不一致`,
    );
  }
  if (!asArray(provider.models).includes(shot.routing?.model)) {
    errors.push(`${label}: 模型 ${shot.routing?.model} 未出现在当前能力快照`);
  }
  if (!asArray(provider.supportedModes).includes(shot.mode)) {
    errors.push(`${label}: ${providerName} 当前不支持 mode=${shot.mode}`);
  }
  if (
    Number.isFinite(shot.durationSeconds)
    && !asArray(provider.supportedDurations).includes(shot.durationSeconds)
  ) {
    errors.push(
      `${label}: ${providerName} 当前不支持 durationSeconds=${shot.durationSeconds}`,
    );
  }
  if (
    hasValue(shot.resolutionIntent)
    && !asArray(provider.supportedResolutions).includes(shot.resolutionIntent)
  ) {
    errors.push(
      `${label}: ${providerName} 当前不支持 resolutionIntent=${shot.resolutionIntent}`,
    );
  }
  if (
    hasValue(shot.aspectRatio)
    && !normalizedRatioMatches(shot.aspectRatio, provider.supportedAspectRatios)
  ) {
    errors.push(`${label}: ${providerName} 当前不支持 aspectRatio=${shot.aspectRatio}`);
  }
  for (const parameter of asArray(shot.routing?.requestParameters)) {
    if (!asArray(provider.exposedParameters).includes(parameter)) {
      errors.push(`${label}: 当前 ${provider.transport} 未暴露参数 ${parameter}`);
    }
  }
  if (shot.audioPolicy === "model_audio" && provider.nativeAudio !== true) {
    errors.push(`${label}: 当前 ${providerName} 不支持 model_audio`);
  }
}

function validateShot(shot, index, plan, errors, planFile, templateMode) {
  const label = `generatedShots[${index}]`;
  pushMissing(errors, label, shot, [
    "id",
    "timelineInterval",
    "sourceNarration",
    "purpose",
    "assetSemantics",
    "durationSeconds",
    "aspectRatio",
    "resolutionIntent",
    "mode",
    "actionBeats",
    "camera",
    "styleMatch",
    "continuityIn",
    "continuityOut",
    "audioPolicy",
    "negativeConstraints",
    "routing",
    "compiledPrompt",
    "paidCallPolicy",
    "qcTargets",
  ]);

  if (!MODES.has(shot.mode)) errors.push(`${label}: 未知 mode：${shot.mode}`);
  if (!AUDIO_POLICIES.has(shot.audioPolicy)) {
    errors.push(`${label}: 未知 audioPolicy：${shot.audioPolicy}`);
  }
  if (!Number.isFinite(shot.durationSeconds) || shot.durationSeconds <= 0) {
    errors.push(`${label}: durationSeconds 必须为正数`);
  }
  if (!parseRatio(shot.aspectRatio)) {
    errors.push(`${label}: aspectRatio 必须是两个正数，例如 9:16`);
  }

  const interval = shot.timelineInterval;
  if (
    !Number.isFinite(interval?.startSeconds)
    || !Number.isFinite(interval?.endSeconds)
    || interval.startSeconds < 0
    || interval.endSeconds <= interval.startSeconds
  ) {
    errors.push(`${label}: timelineInterval 无效`);
  } else if (
    Number.isFinite(shot.durationSeconds)
    && interval.endSeconds - interval.startSeconds > shot.durationSeconds + 0.001
  ) {
    errors.push(`${label}: 时间线使用区间不得长于生成镜头时长`);
  }

  pushMissing(errors, `${label}.assetSemantics`, shot.assetSemantics, [
    "object",
    "action",
    "state",
    "role",
    "tense",
  ]);
  pushMissing(errors, `${label}.camera`, shot.camera, [
    "shotScale",
    "position",
    "composition",
    "focus",
    "movement",
    "stability",
  ]);
  pushMissing(errors, `${label}.styleMatch`, shot.styleMatch, [
    "referenceFrames",
    "colorTemperature",
    "exposureContrast",
    "saturation",
    "depthOfField",
    "textureSharpness",
    "motionPace",
  ]);
  pushMissing(errors, `${label}.routing`, shot.routing, [
    "provider",
    "model",
    "transport",
    "reason",
    "requestParameters",
  ]);
  pushMissing(errors, `${label}.paidCallPolicy`, shot.paidCallPolicy, [
    "requiresAuthorization",
    "maxPaidAttempts",
    "changeOneVariable",
    "fallback",
  ]);

  if (shot.paidCallPolicy?.requiresAuthorization !== true) {
    errors.push(`${label}: paidCallPolicy.requiresAuthorization 必须为 true`);
  }
  if (
    !Number.isInteger(shot.paidCallPolicy?.maxPaidAttempts)
    || shot.paidCallPolicy.maxPaidAttempts < 1
  ) {
    errors.push(`${label}: maxPaidAttempts 必须是至少 1 的整数`);
  }
  if (shot.paidCallPolicy?.changeOneVariable !== true) {
    errors.push(`${label}: changeOneVariable 必须为 true`);
  }

  validateActionBeats(shot.actionBeats, shot.durationSeconds, label, errors);
  asArray(shot.referenceAssets).forEach((asset, assetIndex) => {
    validateAsset(asset, label, assetIndex, errors, planFile, templateMode);
  });
  validateModeAssets(shot, label, errors);
  validateProviderCompatibility(shot, plan.capabilitySnapshot, label, errors);

  const qcTargets = new Set(asArray(shot.qcTargets));
  for (const target of qcTargets) {
    if (!QC_TARGETS.has(target)) errors.push(`${label}: 未知 qcTarget：${target}`);
  }
  REQUIRED_QC_GROUPS.forEach((group) => {
    if (!group.some((target) => qcTargets.has(target))) {
      errors.push(`${label}: qcTargets 至少包含 ${group.join(" 或 ")}`);
    }
  });
}

const args = process.argv.slice(2);
const templateMode = args.includes("--template");
const forExecution = args.includes("--for-execution");
const maxAgeIndex = args.indexOf("--max-age-days");
const maxAgeDays = maxAgeIndex >= 0 ? Number(args[maxAgeIndex + 1]) : 2;
const ignoredIndexes = new Set(
  maxAgeIndex >= 0 ? [maxAgeIndex, maxAgeIndex + 1] : [],
);
const input = args.find(
  (argument, index) => !argument.startsWith("--") && !ignoredIndexes.has(index),
);

if (!input || !Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
  console.error(
    "用法：validate_generated_shot_plan.mjs <plan.json> "
      + "[--for-execution] [--template] [--max-age-days N]",
  );
  process.exit(2);
}
if (templateMode && forExecution) {
  console.error("--template 与 --for-execution 不能同时使用");
  process.exit(2);
}

const file = path.resolve(input);
let plan;
try {
  plan = readJson(file);
} catch (error) {
  console.error(`无法读取或解析 JSON：${file}`);
  console.error(error.message);
  process.exit(2);
}

const shots = Array.isArray(plan.generatedShots) ? plan.generatedShots : [];
const errors = [];
if (plan.schemaVersion !== "2.0") {
  errors.push("schemaVersion 必须为 2.0");
}
if (plan.template === true && !templateMode) {
  errors.push("模板计划必须显式使用 --template，不能进入预检或执行");
}
if (templateMode && plan.template !== true) {
  errors.push("--template 只可用于顶层 template=true 的结构模板");
}
validateCapabilitySnapshot(
  plan.capabilitySnapshot,
  errors,
  maxAgeDays,
  templateMode,
);
if (!Array.isArray(plan.generatedShots)) {
  errors.push("顶层必须提供 generatedShots 数组");
} else if (shots.length === 0) {
  errors.push("generatedShots 不能为空；没有生成镜头时不需要建立该计划");
}

if (forExecution) {
  pushMissing(
    errors,
    "executionAuthorization",
    plan.executionAuthorization,
    ["status", "evidence", "authorizedAt"],
  );
  if (plan.executionAuthorization?.status !== "authorized") {
    errors.push("付费执行前 executionAuthorization.status 必须为 authorized");
  }
}

const ids = new Set();
shots.forEach((shot, index) => {
  if (ids.has(shot.id)) errors.push(`generatedShots[${index}]: id 重复：${shot.id}`);
  ids.add(shot.id);
  validateShot(shot, index, plan, errors, file, templateMode);
});

if (errors.length > 0) {
  console.error(`生成镜头方案检查失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      file,
      schemaVersion: plan.schemaVersion,
      mode: templateMode ? "template" : forExecution ? "execution" : "preflight",
      generatedShots: shots.length,
      providers: [...new Set(shots.map((shot) => shot.routing.provider))],
      filesAndHashesVerified: !templateMode,
      capabilityFreshnessDays: templateMode ? null : maxAgeDays,
      contracts: {
        providerModelTransport: "required",
        aspectDurationResolution: "required by capability snapshot",
        referenceRoles: "required by mode",
        paidExecutionAuthorization: forExecution,
        qcGroups: REQUIRED_QC_GROUPS,
      },
    },
    null,
    2,
  ),
);
