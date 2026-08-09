#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  readJson,
  sha256File,
  unique,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";
import {
  selectIncrementalRepresentativeRanges,
  validateEfficiencyPolicy,
} from "./quality_efficiency.mjs";

const ALL_LAYERS = [
  "visual",
  "dialogue",
  "bgm",
  "sfx",
  "subtitles",
  "covers",
  "metadata",
];
const AUDIO_LAYERS = new Set(["dialogue", "bgm", "sfx"]);
const VIDEO_LAYERS = new Set(["visual", "subtitles"]);
const STRUCTURAL_TYPES = new Set([
  "remove_interval",
  "reorder",
  "geometry_change",
]);
const FULL_REBUILD_TYPES = new Set(["style_change"]);
const FULL_MANUAL_CHECKS = [
  "contentIntegrity",
  "connectionPlayback",
  "subtitleAccuracy",
  "subtitleLayout",
  "visualContinuity",
  "assetSemanticsAndLicenses",
  "maskTrackingBeautyAndPip",
  "audioStemAndDeviceListening",
  "coverAndBrand",
  "openingEndingAndFullPlayback",
  "technicalFindingsDisposition",
];
const INVALIDATION_BY_TYPE = {
  metadata_rewrap: ["metadata_snapshot"],
  cover_only: ["cover"],
  subtitle_only: ["subtitle", "subtitle_overlay", "video_master"],
  bgm_adjust: ["bgm_stem", "final_mix", "audio_master", "video_master"],
  sfx_adjust: ["sfx_stem", "final_mix", "audio_master", "video_master"],
  dialogue_adjust: ["dialogue_stem", "final_mix", "audio_master", "video_master"],
  beauty_adjust: ["beauty_master", "video_master"],
  color_adjust: ["color_master", "video_master"],
  visual_interval: ["visual_segment", "video_master"],
  semantic_netstyle: ["visual_segment", "sfx_stem", "final_mix", "video_master"],
  visual_breathing: ["visual_segment", "sfx_stem", "final_mix", "video_master"],
  caption_layout: [
    "subtitle",
    "subtitle_overlay",
    "sfx_stem",
    "final_mix",
    "video_master",
  ],
  insert_replace: ["visual_segment", "subtitle_overlay", "final_mix", "video_master"],
  remove_interval: [
    "timeline",
    "dialogue_stem",
    "bgm_stem",
    "sfx_stem",
    "subtitle",
    "subtitle_overlay",
    "mask_video",
    "final_mix",
    "video_master",
  ],
  reorder: [
    "timeline",
    "dialogue_stem",
    "bgm_stem",
    "sfx_stem",
    "subtitle",
    "subtitle_overlay",
    "mask_video",
    "final_mix",
    "video_master",
  ],
  geometry_change: [
    "layout",
    "mask_video",
    "subtitle_overlay",
    "cover",
    "video_master",
  ],
  style_change: [
    "style_profile",
    "layout",
    "visual_segment",
    "subtitle_overlay",
    "cover",
    "video_master",
  ],
  timing_sync: ["visual_segment", "sfx_stem", "final_mix", "video_master"],
  popup_layout: ["layout", "visual_segment", "video_master"],
  connection_repair: ["timeline", "visual_segment", "sfx_stem", "final_mix", "video_master"],
};

function usage() {
  console.error(
    "用法：plan_incremental_build.mjs <project-context.json> "
      + "<version-delta.json> <artifact-index.json> --output incremental-plan.json",
  );
}

function inferImpact(delta) {
  const types = delta.changeSet.types;
  const layers = delta.changeSet.changedLayers;
  if (
    delta.changeSet.durationChange
    || types.some((type) => STRUCTURAL_TYPES.has(type))
  ) {
    return "L3";
  }
  if (layers.length === 1 && layers[0] === "metadata") return "L0";
  if (delta.changeSet.scope.kind === "intervals" || layers.length > 1) return "L2";
  return "L1";
}

function defaultRenderStrategy(delta, impact) {
  const changed = new Set(delta.changeSet.changedLayers);
  const audioChanged = [...changed].some((layer) => AUDIO_LAYERS.has(layer));
  const videoChanged = [...changed].some((layer) => VIDEO_LAYERS.has(layer));
  if (changed.size === 1 && changed.has("covers")) return "no_video_render";
  if (impact === "L0") return "metadata_rewrap";
  if (delta.changeSet.types.some((type) => FULL_REBUILD_TYPES.has(type))) {
    return "full_rebuild";
  }
  if (impact === "L3") return "full_rebuild";
  if (impact === "L2") return "segment_rebuild";
  if (audioChanged && !videoChanged) return "stream_copy_video";
  if (videoChanged && !audioChanged) return "layer_rebuild";
  return "layer_rebuild";
}

function strategyAllowed(requested, delta, impact) {
  if (requested === "auto") return true;
  if (requested === "full_rebuild") {
    return impact === "L3"
      || delta.changeSet.types.some((type) => FULL_REBUILD_TYPES.has(type));
  }
  if (delta.changeSet.types.some((type) => FULL_REBUILD_TYPES.has(type))) {
    return false;
  }
  const changed = new Set(delta.changeSet.changedLayers);
  const audioChanged = [...changed].some((layer) => AUDIO_LAYERS.has(layer));
  const videoChanged = [...changed].some((layer) => VIDEO_LAYERS.has(layer));
  if (impact === "L3") return requested === "full_rebuild";
  if (requested === "no_video_render") {
    return changed.size === 1 && changed.has("covers");
  }
  if (requested === "metadata_rewrap") {
    return impact === "L0";
  }
  if (requested === "stream_copy_video") {
    return !videoChanged && audioChanged;
  }
  if (requested === "stream_copy_audio") {
    return videoChanged && !audioChanged;
  }
  if (requested === "segment_rebuild") {
    return impact === "L2";
  }
  return requested === "layer_rebuild" && ["L1", "L2"].includes(impact);
}

function affectedDuration(delta, fullDuration) {
  if (delta.changeSet.scope.kind === "full") return fullDuration;
  if (delta.changeSet.scope.kind === "no_timeline") return 0;
  return (delta.changeSet.scope.intervals ?? []).reduce(
    (total, interval) => total
      + Number(interval.endSeconds)
      - Number(interval.startSeconds),
    0,
  );
}

const args = process.argv.slice(2);
const positional = args.filter((item) => !item.startsWith("--"));
const outputIndex = args.indexOf("--output");
if (positional.length < 3 || outputIndex < 0 || !args[outputIndex + 1]) {
  usage();
  process.exit(2);
}

const [contextInput, deltaInput, indexInput] = positional;
const contextFile = path.resolve(contextInput);
const deltaFile = path.resolve(deltaInput);
const indexFile = path.resolve(indexInput);
const outputFile = path.resolve(args[outputIndex + 1]);
let context;
let delta;
let index;
try {
  context = readJson(contextFile);
  delta = readJson(deltaFile);
  index = readJson(indexFile);
} catch (error) {
  console.error(`无法读取增量输入：${error.message}`);
  process.exit(2);
}

if (
  context.projectId !== index.projectId
  || context.projectId === undefined
  || delta.baseVersionId !== context.baseline?.versionId
) {
  console.error("context、delta 和 artifact index 不属于同一基线");
  process.exit(1);
}

const impact = inferImpact(delta);
const recommendedStrategy = defaultRenderStrategy(delta, impact);
const requestedStrategy = delta.render.requestedStrategy;
if (!strategyAllowed(requestedStrategy, delta, impact)) {
  console.error(
    `请求的渲染策略 ${requestedStrategy} 低于 ${impact} 风险要求；`
      + `建议 ${recommendedStrategy}`,
  );
  process.exit(1);
}
const renderStrategy = requestedStrategy === "auto"
  ? recommendedStrategy
  : requestedStrategy;
const renderBudget = loadKachaConfig({
  args,
  anchorPath: contextFile,
  includeSecrets: false,
}).config.execution.incremental.renderBudget;

const changedLayers = delta.changeSet.changedLayers;
const frozenLayers = ALL_LAYERS.filter((layer) => !changedLayers.includes(layer));
const invalidatedTypes = new Set(
  delta.changeSet.types.flatMap((type) => INVALIDATION_BY_TYPE[type] ?? []),
);
const invalidatedIds = new Set(
  index.artifacts
    .filter((artifact) => invalidatedTypes.has(artifact.type))
    .map((artifact) => artifact.id),
);
const explicitReuse = [];
for (const request of delta.reuseRequests ?? []) {
  const artifact = index.artifacts.find(
    (candidate) => candidate.id === request.artifactId,
  );
  if (
    artifact?.status === "ready"
    && artifact.fingerprint === request.fingerprint
  ) {
    explicitReuse.push(artifact.id);
  } else {
    console.error(
      `显式缓存请求未命中或指纹不一致：${request.artifactId}`,
    );
    process.exit(1);
  }
}
let propagating = true;
while (propagating) {
  propagating = false;
  for (const artifact of index.artifacts) {
    if (
      !invalidatedIds.has(artifact.id)
      && (artifact.dependencies ?? []).some((dependency) => invalidatedIds.has(dependency))
    ) {
      invalidatedIds.add(artifact.id);
      propagating = true;
    }
  }
}
for (const id of explicitReuse) {
  if (invalidatedIds.has(id)) {
    console.error(
      `显式缓存请求 ${id} 已被本轮变化或其依赖失效，不能用指纹请求绕过失效规则`,
    );
    process.exit(1);
  }
}

const reusableArtifacts = index.artifacts
  .filter(
    (artifact) => artifact.status === "ready"
      && !invalidatedIds.has(artifact.id)
      && !(artifact.dependencies ?? []).some((dependency) => invalidatedIds.has(dependency)),
  )
  .map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    path: artifact.path,
    sha256: artifact.sha256,
    fingerprint: artifact.fingerprint,
    proof: "ready artifact with unchanged dependency fingerprint",
  }));
const invalidatedArtifacts = index.artifacts
  .filter((artifact) => invalidatedIds.has(artifact.id))
  .map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    reason: "changed layer or dependency invalidated this artifact",
  }));

const changed = new Set(changedLayers);
const audioChanged = [...changed].some((layer) => AUDIO_LAYERS.has(layer));
const videoChanged = [...changed].some((layer) => VIDEO_LAYERS.has(layer));
const hasVideoOutput = delta.deliverables.video === true;
const universalChecks = hasVideoOutput
  ? [
      "output_exists_and_sha256",
      "decode_output",
      "geometry_and_fps",
      "duration_contract",
      "audio_video_drift",
      "base_not_overwritten",
    ]
  : ["deliverable_exists_and_sha256"];
const automaticChecks = [];
const inheritedChecks = [];
if (audioChanged) {
  automaticChecks.push(
    "audio_sample_rate_and_channels",
    "integrated_loudness",
    "true_peak",
  );
} else if (
  hasVideoOutput
  && context.source.media.hasAudio
  && delta.newVersion.intent !== "preview"
) {
  inheritedChecks.push("audio_elementary_stream_sha256");
}
if (videoChanged) {
  automaticChecks.push("black_and_freeze_detection");
} else if (
  hasVideoOutput
  && context.source.media.hasVideo
  && delta.newVersion.intent !== "preview"
) {
  inheritedChecks.push("video_elementary_stream_sha256");
}
if (changed.has("covers")) automaticChecks.push("cover_ratio_and_hash");
if (changed.has("subtitles")) automaticChecks.push("subtitle_files_and_hashes");

let manualChecks = ["changedLayerReview", "frozenLayerProof"];
if (impact === "L2" || impact === "L3") manualChecks.push("boundaryPlayback");
if ((delta.changeSet.regressionScans ?? []).length > 0) {
  manualChecks.push("sameSignatureRegressionScan");
}
if (changed.has("visual")) manualChecks.push("visualContinuity");
if (
  delta.changeSet.types.some((type) => ["beauty_adjust"].includes(type))
) {
  manualChecks.push("maskTrackingBeautyAndPip");
}
if (changed.has("subtitles")) {
  manualChecks.push("subtitleAccuracy", "subtitleLayout");
}
if (audioChanged) manualChecks.push("audioStemAndDeviceListening");
if (changed.has("covers")) manualChecks.push("coverAndBrand");
if (delta.newVersion.intent === "release_candidate") {
  manualChecks = FULL_MANUAL_CHECKS;
}

const fullDuration = Number(context.source.media.durationSeconds);
const affected = affectedDuration(delta, fullDuration);
const handleFrames = Number(delta.render.handleFrames);
const handleSeconds = handleFrames / Number(context.source.media.fps);
const representativeRanges = selectIncrementalRepresentativeRanges(delta, fullDuration);
const inputHashes = {
  projectContext: sha256File(contextFile),
  versionDelta: sha256File(deltaFile),
  artifactIndex: sha256File(indexFile),
  qualityEfficiencyPolicy: validateEfficiencyPolicy().policy.sha256,
};
let generatedAt = new Date().toISOString();
if (fs.existsSync(outputFile)) {
  try {
    const previous = readJson(outputFile);
    if (
      previous.schemaVersion === "3.0"
      && previous.inputHashes?.projectContext === inputHashes.projectContext
      && previous.inputHashes?.versionDelta === inputHashes.versionDelta
      && previous.inputHashes?.artifactIndex === inputHashes.artifactIndex
      && previous.inputHashes?.qualityEfficiencyPolicy === inputHashes.qualityEfficiencyPolicy
    ) {
      generatedAt = previous.generatedAt;
    }
  } catch {
    // Replace an unreadable plan only after all current inputs have validated.
  }
}
const plan = {
  schemaVersion: "3.0",
  generatedAt,
  projectId: context.projectId,
  baseVersionId: delta.baseVersionId,
  newVersionId: delta.newVersion.id,
  intent: delta.newVersion.intent,
  inputHashes,
  impact: {
    level: impact,
    changedLayers,
    frozenLayers,
    durationChange: delta.changeSet.durationChange,
    affectedDurationSeconds: Number(affected.toFixed(6)),
    affectedRatio: fullDuration > 0
      ? Number((affected / fullDuration).toFixed(6))
      : null,
  },
  renderPlan: {
    strategy: renderStrategy,
    streamCopy: {
      video: renderStrategy === "stream_copy_video",
      audio: hasVideoOutput && !audioChanged,
    },
    intervals: delta.changeSet.scope.intervals ?? [],
    representativeRanges,
    handleFrames,
    handleSeconds: Number(handleSeconds.toFixed(6)),
    finalAssemblyRequired: ["segment_rebuild", "full_rebuild"].includes(
      renderStrategy,
    ),
    budget: {
      explorationRenderScope: renderBudget.explorationRenderScope,
      representativeRangeCount: {
        minimum: renderBudget.representativeRangeMinimum,
        maximum: renderBudget.representativeRangeMaximum,
        planned: representativeRanges.length,
      },
      representativeApprovalRequired:
        renderBudget.requireRepresentativeApprovalBeforeFullPreview,
      maximumFullPreviewEncodes: renderBudget.maximumFullPreviewEncodesPerVersion,
      maximumFinalEncodes: renderBudget.maximumFinalEncodesPerVersion,
      maximumFullQcRuns: renderBudget.maximumFullQcRunsPerVersion,
      fullRebuildAllowed: impact === "L3"
        || delta.changeSet.types.some((type) => FULL_REBUILD_TYPES.has(type)),
      enforcement: [
        "参数探索只渲染 1–3 个代表区间及 handle",
        "代表区间批准并冻结 EDL/style/capability/audio digest 后，最多一次整片代理",
        "正式版本最多一次视频编码；同 Render Graph 必须零编码复用",
        "candidate 只做 delta QC；完整 QC 只在 release_candidate 执行一次",
      ],
      changeCoverage: {
        required: delta.changeSet.scope.kind === "intervals",
        covered: (delta.changeSet.scope.intervals ?? []).every((interval) => (
          representativeRanges.some((range) => (
            range.startSeconds <= Number(interval.startSeconds)
            && range.endSeconds >= Number(interval.endSeconds)
          ))
        )),
      },
    },
  },
  artifactPlan: {
    invalidatedTypes: [...invalidatedTypes].sort(),
    invalidatedArtifacts,
    reusableArtifacts,
    explicitReuse,
  },
  qcProfile: {
    universalChecks,
    automaticChecks: unique(automaticChecks),
    inheritedChecks: unique(inheritedChecks),
    manualChecks: unique(manualChecks),
    fullReleaseRequired: delta.newVersion.intent === "release_candidate",
  },
  deliverables: delta.deliverables,
  metrics: {
    totalDurationSeconds: fullDuration,
    affectedDurationSeconds: Number(affected.toFixed(6)),
    cachedArtifactsAvailable: reusableArtifacts.length,
    artifactsInvalidated: invalidatedArtifacts.length,
  },
};

writeJsonAtomic(outputFile, plan);
console.log(
  JSON.stringify(
    {
      status: "pass",
      output: outputFile,
      impact: impact,
      renderStrategy,
      changedLayers,
      reusableArtifacts: reusableArtifacts.length,
      invalidatedArtifacts: invalidatedArtifacts.length,
      qcAutomatic: plan.qcProfile.automaticChecks,
      qcInherited: plan.qcProfile.inheritedChecks,
    },
    null,
    2,
  ),
);
