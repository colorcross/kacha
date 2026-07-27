#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  hasValue,
  ffprobe,
  parseRatio,
  readJson,
  resolveFrom,
  sha256File,
} from "./kacha_utils.mjs";

const REQUIRED_MANUAL_CHECKS = [
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
const SHA256 = /^[a-f0-9]{64}$/i;

function outputPathOf(entry) {
  return typeof entry === "string" ? entry : entry?.path;
}

function verifyArtifact(entry, label, ownerFile, errors) {
  const candidate = outputPathOf(entry);
  if (!hasValue(candidate)) {
    errors.push(`${label}: 缺少 path`);
    return null;
  }
  const resolved = resolveFrom(ownerFile, candidate);
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    errors.push(`${label}: 文件不存在：${resolved ?? candidate}`);
    return null;
  }
  if (fs.statSync(resolved).size <= 0) {
    errors.push(`${label}: 文件为空`);
    return null;
  }
  if (!SHA256.test(entry?.sha256 ?? "")) {
    errors.push(`${label}: 必须记录真实 sha256`);
  } else if (sha256File(resolved).toLowerCase() !== entry.sha256.toLowerCase()) {
    errors.push(`${label}: sha256 与文件内容不一致`);
  }
  return resolved;
}

const [, , input] = process.argv;
if (!input) {
  console.error("用法：validate_release_report.mjs <project-manifest.json>");
  process.exit(2);
}

const projectFile = path.resolve(input);
let project;
try {
  project = readJson(projectFile);
} catch (error) {
  console.error(`无法读取项目 manifest：${error.message}`);
  process.exit(2);
}
const releaseFile = resolveFrom(
  projectFile,
  outputPathOf(project.outputs?.releaseReport),
);
if (!releaseFile || !fs.existsSync(releaseFile)) {
  console.error(`release report 不存在：${releaseFile ?? "(missing path)"}`);
  process.exit(2);
}

let release;
let technical;
try {
  release = readJson(releaseFile);
  const technicalFile = resolveFrom(
    projectFile,
    outputPathOf(project.outputs?.technicalQcReport),
  );
  technical = readJson(technicalFile);
} catch (error) {
  console.error(`无法读取 QC 报告：${error.message}`);
  process.exit(2);
}

const errors = [];
if (release.schemaVersion !== "2.0") errors.push("release.schemaVersion 必须为 2.0");
if (release.projectId !== project.projectId) errors.push("release.projectId 与项目不一致");
if (release.status !== "approved_local_release") {
  errors.push("release.status 必须为 approved_local_release");
}
for (const field of ["reviewedAt", "reviewer", "limitations"]) {
  if (!hasValue(release[field])) errors.push(`release 缺少 ${field}`);
}
if (!["pass", "pass_with_review"].includes(technical.status)) {
  errors.push(`technical QC 未通过：${technical.status}`);
}

const finalVideo = verifyArtifact(
  project.outputs?.finalVideo,
  "outputs.finalVideo",
  projectFile,
  errors,
);
if (
  finalVideo
  && technical.sha256 !== sha256File(finalVideo)
) {
  errors.push("technical QC 报告对应的不是当前最终视频");
}
if (
  finalVideo
  && release.finalVideoSha256 !== sha256File(finalVideo)
) {
  errors.push("release.finalVideoSha256 与当前最终视频不一致");
}

const covers = Array.isArray(project.outputs?.covers) ? project.outputs.covers : [];
for (const ratio of project.requiredCoverAspectRatios ?? []) {
  const entry = covers.find((cover) => cover.aspectRatio === ratio);
  if (!entry) {
    errors.push(`缺少 ${ratio} 封面`);
  } else {
    const coverFile = verifyArtifact(
      entry,
      `outputs.covers[${ratio}]`,
      projectFile,
      errors,
    );
    if (coverFile) {
      try {
        const probe = ffprobe(coverFile);
        const stream = probe.streams?.find((item) => item.codec_type === "video");
        const expectedRatio = parseRatio(ratio);
        const actualRatio = Number(stream?.width) / Number(stream?.height);
        if (
          !expectedRatio
          || !Number.isFinite(actualRatio)
          || Math.abs(actualRatio - expectedRatio.value) > 0.0001
        ) {
          errors.push(
            `outputs.covers[${ratio}]: 实际尺寸 ${stream?.width}x${stream?.height} 不符合 ${ratio}`,
          );
        }
      } catch (error) {
        errors.push(`outputs.covers[${ratio}]: 无法解码：${error.message}`);
      }
    }
  }
}
for (const [index, subtitle] of (project.outputs?.subtitles ?? []).entries()) {
  verifyArtifact(subtitle, `outputs.subtitles[${index}]`, projectFile, errors);
}

for (const id of REQUIRED_MANUAL_CHECKS) {
  const item = release.manualChecks?.[id];
  if (item?.status !== "pass") {
    errors.push(`manualChecks.${id}.status 必须为 pass`);
  }
  if (!Array.isArray(item?.evidence) || item.evidence.length === 0) {
    errors.push(`manualChecks.${id}.evidence 必须是非空数组`);
  }
}

if (errors.length > 0) {
  console.error(`发布门禁失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      project: project.projectId,
      finalVideo,
      technicalQc: technical.status,
      manualChecks: REQUIRED_MANUAL_CHECKS.length,
      release: releaseFile,
    },
    null,
    2,
  ),
);
