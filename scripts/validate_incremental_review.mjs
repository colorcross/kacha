#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  hasValue,
  readJson,
  resolveFrom,
  sha256File,
} from "./kacha_utils.mjs";

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
const SHA256 = /^[a-f0-9]{64}$/i;

const args = process.argv.slice(2);
const input = args.find((item) => !item.startsWith("--"));
const modeIndex = args.indexOf("--mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : "candidate";
if (!input || !["candidate", "release"].includes(mode)) {
  console.error(
    "用法：validate_incremental_review.mjs <incremental-project.json> "
      + "--mode candidate|release",
  );
  process.exit(2);
}

const projectFile = path.resolve(input);
let project;
let delta;
let plan;
let qc;
let review;
try {
  project = readJson(projectFile);
  delta = readJson(resolveFrom(projectFile, project.delta));
  plan = readJson(resolveFrom(projectFile, project.outputs.incrementalPlan));
  qc = readJson(resolveFrom(projectFile, project.outputs.deltaQcReport));
  review = readJson(resolveFrom(projectFile, project.outputs.reviewReport));
} catch (error) {
  console.error(`无法读取增量审片证据：${error.message}`);
  process.exit(2);
}

const errors = [];
if (review.schemaVersion !== "3.0") errors.push("review.schemaVersion 必须为 3.0");
if (review.projectId !== project.projectId) errors.push("review.projectId 与项目不一致");
if (review.versionId !== delta.newVersion.id) errors.push("review.versionId 与 delta 不一致");
if (review.intent !== delta.newVersion.intent) errors.push("review.intent 与 delta 不一致");
const expectedStatus = mode === "release"
  ? "approved_local_release"
  : "approved_candidate";
if (review.status !== expectedStatus) {
  errors.push(`review.status 必须为 ${expectedStatus}`);
}
for (const field of ["reviewedAt", "reviewer", "outputSha256", "limitations"]) {
  if (!hasValue(review[field])) errors.push(`review 缺少 ${field}`);
}
if (!Number.isFinite(Date.parse(review.reviewedAt ?? ""))) {
  errors.push("review.reviewedAt 必须是真实 ISO 时间");
}
if (String(review.reviewer ?? "").startsWith("replace-")) {
  errors.push("review.reviewer 仍是占位值");
}
if (!SHA256.test(review.outputSha256 ?? "")) {
  errors.push("review.outputSha256 必须是真实 SHA-256");
}
if (!Array.isArray(review.limitations) || review.limitations.length === 0) {
  errors.push("review.limitations 必须是非空数组；没有限制时填写 none");
}
if (!["pass", "pass_with_review"].includes(qc.status)) {
  errors.push(`delta QC 未通过：${qc.status}`);
}
if (
  qc.projectId !== project.projectId
  || qc.versionId !== delta.newVersion.id
  || qc.intent !== delta.newVersion.intent
) {
  errors.push("delta QC 不属于当前项目版本");
}
const contextFile = resolveFrom(projectFile, project.context);
const deltaFile = resolveFrom(projectFile, project.delta);
const artifactIndexFile = resolveFrom(projectFile, project.artifactIndex);
const planFile = resolveFrom(projectFile, project.outputs.incrementalPlan);
if (
  qc.contextSha256 !== sha256File(contextFile)
  || qc.deltaSha256 !== sha256File(deltaFile)
  || qc.artifactIndexSha256 !== sha256File(artifactIndexFile)
  || qc.planSha256 !== sha256File(planFile)
) {
  errors.push("delta QC 输入身份与当前 context、delta、artifact index 或 plan 不一致");
}

const expectedOutputIdentity = qc.output?.sha256 ?? qc.deliverableDigest;
if (review.outputSha256 !== expectedOutputIdentity) {
  errors.push("review.outputSha256 与当前 QC 交付身份不一致");
}
if (qc.output?.path) {
  if (!fs.existsSync(qc.output.path)) {
    errors.push(`候选视频不存在：${qc.output.path}`);
  } else if (sha256File(qc.output.path) !== qc.output.sha256) {
    errors.push("候选视频在 QC 后发生变化");
  }
}
for (const artifact of qc.deliverableEvidence ?? []) {
  if (!artifact.path || !fs.existsSync(artifact.path)) {
    errors.push(`交付物不存在：${artifact.path ?? artifact.type}`);
  } else if (sha256File(artifact.path) !== artifact.sha256) {
    errors.push(`交付物在 QC 后发生变化：${artifact.path}`);
  }
}

let requiredChecks = mode === "release"
  ? FULL_MANUAL_CHECKS
  : [...plan.qcProfile.manualChecks];
if (
  mode === "candidate"
  && qc.status === "pass_with_review"
  && !requiredChecks.includes("technicalFindingsDisposition")
) {
  requiredChecks.push("technicalFindingsDisposition");
}
requiredChecks = [...new Set(requiredChecks)];
if (mode === "candidate" && delta.newVersion.intent === "preview") {
  errors.push("preview 只能用于样例，不能通过 candidate gate");
}
if (mode === "release" && delta.newVersion.intent !== "release_candidate") {
  errors.push("只有 release_candidate 可以通过 release gate");
}
for (const id of requiredChecks) {
  const item = review.manualChecks?.[id];
  if (item?.status !== "pass") {
    errors.push(`manualChecks.${id}.status 必须为 pass`);
  }
  if (!Array.isArray(item?.evidence) || item.evidence.length === 0) {
    errors.push(`manualChecks.${id}.evidence 必须是非空数组`);
  } else if (item.evidence.some((entry) => !hasValue(entry))) {
    errors.push(`manualChecks.${id}.evidence 不得包含空证据`);
  }
}

if (errors.length > 0) {
  console.error(`增量 ${mode} 门禁失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      mode,
      projectId: project.projectId,
      versionId: delta.newVersion.id,
      qcStatus: qc.status,
      manualChecks: requiredChecks.length,
      review: resolveFrom(projectFile, project.outputs.reviewReport),
    },
    null,
    2,
  ),
);
