#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  fileIdentity,
  mediaSummary,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const sourceInput = args.find((item) => !item.startsWith("--"));
const projectId = option(args, "--project-id");
const outputInput = option(args, "--output-dir");
const baselineVersion = option(args, "--baseline-version", "v1");
const seriesStatus = option(args, "--series-status", "not_series");
const seriesTitle = option(args, "--series-title", "not_applicable");
const delivery = option(args, "--delivery", "video")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const coverRatios = option(args, "--cover-ratios", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const lufsMin = Number(option(args, "--lufs-min", "NaN"));
const lufsMax = Number(option(args, "--lufs-max", "NaN"));
const truePeakMax = Number(option(args, "--true-peak-max", "NaN"));

if (!sourceInput || !projectId || !outputInput) {
  console.error(
    "用法：init_incremental_project.mjs SOURCE --project-id ID --output-dir DIR "
      + "[--baseline-version v1] [--delivery video,covers,subtitles] "
      + "[--cover-ratios 3:4,4:3] [--series-status detected|not_series] "
      + "[--series-title TITLE] "
      + "[--lufs-min -21.5 --lufs-max -19 --true-peak-max -3]",
  );
  process.exit(2);
}

const source = path.resolve(sourceInput);
const outputDirectory = path.resolve(outputInput);
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
  console.error(`源文件不存在：${source}`);
  process.exit(2);
}
if (fs.existsSync(outputDirectory) && !fs.statSync(outputDirectory).isDirectory()) {
  console.error(`输出路径不是目录：${outputDirectory}`);
  process.exit(2);
}
fs.mkdirSync(outputDirectory, { recursive: true });
const contextFile = path.join(outputDirectory, "project-context.json");
const indexFile = path.join(outputDirectory, "artifact-index.json");
for (const target of [contextFile, indexFile]) {
  if (fs.existsSync(target)) {
    console.error(`拒绝覆盖已有项目文件：${target}`);
    process.exit(2);
  }
}

let summary;
try {
  summary = mediaSummary(source);
} catch (error) {
  console.error(`无法探测源文件：${error.message}`);
  process.exit(2);
}
if (!summary.video || !(summary.width > 0 && summary.height > 0 && summary.fps > 0)) {
  console.error("v3 增量项目当前要求可探测的视频源");
  process.exit(2);
}
const identity = fileIdentity(source);
const aspectRatio = `${summary.width}:${summary.height}`;
const context = {
  schemaVersion: "3.0",
  projectId,
  projectRoot: ".",
  createdAt: new Date().toISOString(),
  authorization: {
    canExecute: true,
    externalUploadAllowed: false,
    paidGenerationAllowed: false,
    evidence: "本地增量项目初始化；上传和付费生成未授权。",
  },
  source: {
    ...identity,
    readOnly: true,
    media: {
      durationSeconds: summary.duration,
      width: summary.width,
      height: summary.height,
      fps: summary.fps,
      aspectRatio,
      hasVideo: Boolean(summary.video),
      hasAudio: Boolean(summary.audio),
      audioSampleRate: summary.audio ? summary.sampleRate : null,
      audioChannels: summary.audio ? summary.channels : null,
    },
  },
  creativeLock: {
    preserveSourceDimensions: true,
    preserveSourceAspectRatio: true,
    outputGeometryUserSpecified: false,
    outputWidth: summary.width,
    outputHeight: summary.height,
    outputAspectRatio: aspectRatio,
    primaryNarrativeRole: "creator",
    aiRole: "behind_the_scenes",
    changeRequiresReapproval: true,
  },
  seriesIdentity: {
    status: seriesStatus,
    title: seriesStatus === "detected" ? seriesTitle : "not_applicable",
    evidence: [
      seriesStatus === "detected"
        ? "初始化参数明确声明当前项目属于系列。"
        : "初始化参数未声明系列；正式执行前仍应结合目录和用户说明复核。",
    ],
  },
  delivery: {
    artifacts: delivery,
    coverAspectRatios: coverRatios,
    subtitleLanguages: [],
    ...(Number.isFinite(lufsMin)
      && Number.isFinite(lufsMax)
      && Number.isFinite(truePeakMax)
      ? {
          audioContract: {
            integratedLufsMin: lufsMin,
            integratedLufsMax: lufsMax,
            truePeakMax,
          },
        }
      : {}),
  },
  policies: [
    "semantic-integrity-v1",
    "preserve-source-geometry-v1",
    "no-overwrite-v1",
    "delta-qc-v1",
  ],
  baseline: {
    versionId: baselineVersion,
    video: identity,
  },
  artifactIndex: "./artifact-index.json",
};
const artifact = {
  id: `baseline-video-${baselineVersion}`,
  type: "video_master",
  versionId: baselineVersion,
  path: source,
  sha256: identity.sha256,
  sizeBytes: identity.sizeBytes,
  mtimeMs: identity.mtimeMs,
  fingerprint: "",
  status: "ready",
  dependencies: [],
  scope: { kind: "full" },
  generator: {
    name: "existing-approved-version",
    version: baselineVersion,
    parametersHash: sha256Value({
      sourceSha256: identity.sha256,
      role: "baseline",
    }),
  },
  retention: {
    userNeeds: true,
    requiredForIteration: true,
    paidOrRemote: false,
    humanCalibrated: true,
    regeneration: {
      verified: false,
      speed: "slow",
      estimatedSeconds: 0,
      method: "从受保护源和冻结时间线重新渲染",
    },
  },
};
artifact.fingerprint = sha256Value({
  type: artifact.type,
  versionId: artifact.versionId,
  sha256: artifact.sha256,
  dependencies: [],
  scope: artifact.scope,
  generator: artifact.generator,
});
const artifactIndex = {
  schemaVersion: "3.0",
  projectId,
  generatedAt: new Date().toISOString(),
  artifacts: [artifact],
};

writeJsonAtomic(indexFile, artifactIndex);
writeJsonAtomic(contextFile, context);
console.log(
  JSON.stringify(
    {
      status: "pass",
      projectId,
      source,
      sourceSha256: identity.sha256,
      context: contextFile,
      artifactIndex: indexFile,
      geometry: `${summary.width}x${summary.height}`,
      fps: summary.fps,
      durationSeconds: summary.duration,
    },
    null,
    2,
  ),
);
