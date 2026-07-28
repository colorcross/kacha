#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  fastIdentityMatches,
  hasValue,
  mediaSummary,
  parseRatio,
  readJson,
  resolveFrom,
  sha256File,
} from "./kacha_utils.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const SERIES_STATUSES = new Set(["detected", "not_series"]);
const DELIVERY_ARTIFACTS = new Set(["video", "covers", "subtitles"]);

function required(object, fields, label, errors) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    errors.push(`${label}: 必须是对象`);
    return;
  }
  for (const field of fields) {
    if (!hasValue(object[field])) errors.push(`${label}: 缺少 ${field}`);
  }
}

function verifyIdentity(entry, ownerFile, label, template, fullHash, errors) {
  required(entry, ["path", "sha256", "sizeBytes", "mtimeMs"], label, errors);
  if (template || !entry?.path) return null;
  const file = resolveFrom(ownerFile, entry.path);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    errors.push(`${label}: 文件不存在：${file ?? entry.path}`);
    return null;
  }
  if (!SHA256.test(entry.sha256 ?? "")) {
    errors.push(`${label}.sha256 必须是真实 SHA-256`);
  }
  if (!fastIdentityMatches(file, entry)) {
    errors.push(`${label}: 文件大小或修改时间与 context 不一致，必须重建基线身份`);
  }
  if (
    fullHash
    && SHA256.test(entry.sha256 ?? "")
    && sha256File(file).toLowerCase() !== entry.sha256.toLowerCase()
  ) {
    errors.push(`${label}: SHA-256 与文件内容不一致`);
  }
  return file;
}

const args = process.argv.slice(2);
const input = args.find((item) => !item.startsWith("--"));
const template = args.includes("--template");
const fullHash = args.includes("--full-hash");
if (!input) {
  console.error(
    "用法：validate_project_context.mjs <project-context.json> "
      + "[--template] [--full-hash]",
  );
  process.exit(2);
}

const contextFile = path.resolve(input);
let context;
try {
  context = readJson(contextFile);
} catch (error) {
  console.error(`无法读取 project context：${error.message}`);
  process.exit(2);
}

const errors = [];
if (context.schemaVersion !== "3.0") errors.push("schemaVersion 必须为 3.0");
required(
  context,
  [
    "projectId",
    "projectRoot",
    "createdAt",
    "authorization",
    "source",
    "creativeLock",
    "seriesIdentity",
    "delivery",
    "policies",
    "baseline",
    "artifactIndex",
  ],
  "context",
  errors,
);

required(
  context.authorization,
  [
    "canExecute",
    "externalUploadAllowed",
    "paidGenerationAllowed",
    "evidence",
  ],
  "authorization",
  errors,
);
for (const field of [
  "canExecute",
  "externalUploadAllowed",
  "paidGenerationAllowed",
]) {
  if (typeof context.authorization?.[field] !== "boolean") {
    errors.push(`authorization.${field} 必须是 boolean`);
  }
}

required(
  context.source,
  ["path", "sha256", "sizeBytes", "mtimeMs", "readOnly", "media"],
  "source",
  errors,
);
if (context.source?.readOnly !== true) errors.push("source.readOnly 必须为 true");
required(
  context.source?.media,
  [
    "durationSeconds",
    "width",
    "height",
    "fps",
    "aspectRatio",
    "hasVideo",
    "hasAudio",
  ],
  "source.media",
  errors,
);
const media = context.source?.media ?? {};
for (const field of ["durationSeconds", "width", "height", "fps"]) {
  if (!(Number(media[field]) > 0)) errors.push(`source.media.${field} 必须为正数`);
}
const ratio = parseRatio(media.aspectRatio);
if (
  !ratio
  || (
    Number(media.width) > 0
    && Number(media.height) > 0
    && Math.abs(Number(media.width) / Number(media.height) - ratio.value) > 0.0001
  )
) {
  errors.push("source.media.aspectRatio 与源尺寸不一致");
}

required(
  context.creativeLock,
  [
    "preserveSourceDimensions",
    "preserveSourceAspectRatio",
    "outputGeometryUserSpecified",
    "outputWidth",
    "outputHeight",
    "outputAspectRatio",
    "primaryNarrativeRole",
    "aiRole",
    "changeRequiresReapproval",
  ],
  "creativeLock",
  errors,
);
const lock = context.creativeLock ?? {};
for (const field of [
  "preserveSourceDimensions",
  "preserveSourceAspectRatio",
  "outputGeometryUserSpecified",
  "changeRequiresReapproval",
]) {
  if (typeof lock[field] !== "boolean") {
    errors.push(`creativeLock.${field} 必须是 boolean`);
  }
}
if (lock.changeRequiresReapproval !== true) {
  errors.push("creativeLock.changeRequiresReapproval 必须为 true");
}
if (lock.outputGeometryUserSpecified === false) {
  if (
    lock.preserveSourceDimensions !== true
    || Number(lock.outputWidth) !== Number(media.width)
    || Number(lock.outputHeight) !== Number(media.height)
  ) {
    errors.push("用户未指定输出几何时必须保持源像素尺寸");
  }
  if (
    lock.preserveSourceAspectRatio !== true
    || lock.outputAspectRatio !== media.aspectRatio
  ) {
    errors.push("用户未指定输出几何时必须保持源宽高比");
  }
}

required(
  context.seriesIdentity,
  ["status", "evidence"],
  "seriesIdentity",
  errors,
);
if (!SERIES_STATUSES.has(context.seriesIdentity?.status)) {
  errors.push("seriesIdentity.status 必须为 detected 或 not_series");
}
if (
  !Array.isArray(context.seriesIdentity?.evidence)
  || context.seriesIdentity.evidence.length === 0
) {
  errors.push("seriesIdentity.evidence 必须是非空数组");
}
if (
  context.seriesIdentity?.status === "detected"
  && !hasValue(context.seriesIdentity?.title)
) {
  errors.push("检测到系列时必须填写 seriesIdentity.title");
}

required(context.delivery, ["artifacts"], "delivery", errors);
for (const field of ["coverAspectRatios", "subtitleLanguages"]) {
  if (!Object.hasOwn(context.delivery ?? {}, field)) {
    errors.push(`delivery: 缺少 ${field}`);
  } else if (!Array.isArray(context.delivery[field])) {
    errors.push(`delivery.${field} 必须是数组`);
  }
}
const deliveryArtifacts = Array.isArray(context.delivery?.artifacts)
  ? context.delivery.artifacts
  : [];
if (deliveryArtifacts.length === 0) {
  errors.push("delivery.artifacts 至少包含一种交付物");
}
for (const artifact of deliveryArtifacts) {
  if (!DELIVERY_ARTIFACTS.has(artifact)) {
    errors.push(`delivery.artifacts 包含未知类型：${artifact}`);
  }
}
if (
  context.seriesIdentity?.status === "detected"
  && !deliveryArtifacts.includes("covers")
) {
  errors.push("系列项目的稳定交付范围必须包含 covers；局部版本可复用基线封面");
}
for (const coverRatio of context.delivery?.coverAspectRatios ?? []) {
  if (!parseRatio(coverRatio)) errors.push(`无效封面画幅：${coverRatio}`);
}
if (
  deliveryArtifacts.includes("covers")
  && (context.delivery?.coverAspectRatios ?? []).length === 0
) {
  errors.push("delivery 包含 covers 时 coverAspectRatios 不能为空");
}
if (context.delivery?.audioContract) {
  const contract = context.delivery.audioContract;
  for (const field of ["integratedLufsMin", "integratedLufsMax", "truePeakMax"]) {
    if (!Number.isFinite(contract[field])) {
      errors.push(`delivery.audioContract.${field} 必须是数值`);
    }
  }
  if (
    Number.isFinite(contract.integratedLufsMin)
    && Number.isFinite(contract.integratedLufsMax)
    && contract.integratedLufsMin > contract.integratedLufsMax
  ) {
    errors.push("delivery.audioContract 最小响度不得高于最大响度");
  }
}
if (!Array.isArray(context.policies) || context.policies.length === 0) {
  errors.push("policies 必须是非空数组");
}

required(context.baseline, ["versionId", "video"], "baseline", errors);
const sourceFile = verifyIdentity(
  context.source,
  contextFile,
  "source",
  template,
  fullHash,
  errors,
);
const baselineFile = verifyIdentity(
  context.baseline?.video,
  contextFile,
  "baseline.video",
  template,
  fullHash,
  errors,
);

if (!template) {
  const projectRoot = resolveFrom(contextFile, context.projectRoot);
  if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    errors.push(`projectRoot 不存在或不是目录：${projectRoot ?? context.projectRoot}`);
  }
  const artifactIndex = resolveFrom(contextFile, context.artifactIndex);
  if (!artifactIndex || !fs.existsSync(artifactIndex)) {
    errors.push(`artifactIndex 不存在：${artifactIndex ?? context.artifactIndex}`);
  }
  if (sourceFile) {
    try {
      const actual = mediaSummary(sourceFile);
      const tolerance = 1 / Number(media.fps) + 0.0005;
      if (
        actual.width !== Number(media.width)
        || actual.height !== Number(media.height)
        || Math.abs(actual.fps - Number(media.fps)) > 0.001
        || Math.abs(actual.duration - Number(media.durationSeconds)) > tolerance
      ) {
        errors.push("source.media 与实际源文件探测结果不一致");
      }
    } catch (error) {
      errors.push(`无法探测 source：${error.message}`);
    }
  }
  if (
    sourceFile
    && baselineFile
    && path.resolve(sourceFile) === path.resolve(baselineFile)
    && context.baseline?.versionId !== "source"
  ) {
    // This is valid for an untouched source baseline; keep it visible in output only.
  }
}

if (errors.length > 0) {
  console.error(`project context 检查失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      file: contextFile,
      projectId: context.projectId,
      baselineVersion: context.baseline.versionId,
      identityMode: fullHash ? "full_sha256" : template ? "template" : "fast_stat",
      deliveryArtifacts,
    },
    null,
    2,
  ),
);
