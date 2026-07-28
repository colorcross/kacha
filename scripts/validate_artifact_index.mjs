#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  fastIdentityMatches,
  hasValue,
  readJson,
  resolveFrom,
  sha256File,
  sha256Value,
} from "./kacha_utils.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const STATUSES = new Set(["ready", "invalidated", "missing", "rejected"]);
const SCOPE_KINDS = new Set(["full", "intervals", "no_timeline"]);
const SPEEDS = new Set(["fast", "medium", "slow", "remote_or_paid"]);

function required(object, fields, label, errors) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    errors.push(`${label}: 必须是对象`);
    return;
  }
  for (const field of fields) {
    if (!hasValue(object[field])) errors.push(`${label}: 缺少 ${field}`);
  }
}

export function artifactFingerprint(artifact) {
  return sha256Value({
    type: artifact.type,
    versionId: artifact.versionId,
    sha256: artifact.sha256,
    dependencies: [...(artifact.dependencies ?? [])].sort(),
    scope: artifact.scope,
    generator: artifact.generator,
  });
}

const args = process.argv.slice(2);
const input = args.find((item) => !item.startsWith("--"));
const template = args.includes("--template");
const fullHash = args.includes("--full-hash");
if (!input) {
  console.error(
    "用法：validate_artifact_index.mjs <artifact-index.json> "
      + "[--template] [--full-hash]",
  );
  process.exit(2);
}

const indexFile = path.resolve(input);
let index;
try {
  index = readJson(indexFile);
} catch (error) {
  console.error(`无法读取 artifact index：${error.message}`);
  process.exit(2);
}

const errors = [];
if (index.schemaVersion !== "3.0") errors.push("schemaVersion 必须为 3.0");
for (const field of ["projectId", "generatedAt", "artifacts"]) {
  if (!Object.hasOwn(index, field)) errors.push(`index 缺少 ${field}`);
}
if (!Array.isArray(index.artifacts)) errors.push("artifacts 必须是数组");

const ids = new Set();
const byId = new Map();
for (const [position, artifact] of (index.artifacts ?? []).entries()) {
  const label = `artifacts[${position}]`;
  required(
    artifact,
    [
      "id",
      "type",
      "versionId",
      "path",
      "sha256",
      "sizeBytes",
      "mtimeMs",
      "fingerprint",
      "status",
      "scope",
      "generator",
      "retention",
    ],
    label,
    errors,
  );
  if (!Object.hasOwn(artifact ?? {}, "dependencies")) {
    errors.push(`${label}: 缺少 dependencies`);
  }
  if (ids.has(artifact?.id)) errors.push(`${label}.id 重复：${artifact.id}`);
  ids.add(artifact?.id);
  byId.set(artifact?.id, artifact);
  if (!STATUSES.has(artifact?.status)) {
    errors.push(`${label}.status 无效：${artifact?.status}`);
  }
  if (!Array.isArray(artifact?.dependencies)) {
    errors.push(`${label}.dependencies 必须是数组`);
  } else if (artifact.dependencies.includes(artifact.id)) {
    errors.push(`${label} 不能依赖自身`);
  }
  required(artifact?.scope, ["kind"], `${label}.scope`, errors);
  if (!SCOPE_KINDS.has(artifact?.scope?.kind)) {
    errors.push(`${label}.scope.kind 无效`);
  }
  if (
    artifact?.scope?.kind === "intervals"
    && (!Array.isArray(artifact.scope.intervals) || artifact.scope.intervals.length === 0)
  ) {
    errors.push(`${label}.scope.intervals 不能为空`);
  }
  required(
    artifact?.generator,
    ["name", "version", "parametersHash"],
    `${label}.generator`,
    errors,
  );
  required(
    artifact?.retention,
    [
      "userNeeds",
      "requiredForIteration",
      "paidOrRemote",
      "humanCalibrated",
      "regeneration",
    ],
    `${label}.retention`,
    errors,
  );
  for (const field of [
    "userNeeds",
    "requiredForIteration",
    "paidOrRemote",
    "humanCalibrated",
  ]) {
    if (typeof artifact?.retention?.[field] !== "boolean") {
      errors.push(`${label}.retention.${field} 必须是 boolean`);
    }
  }
  required(
    artifact?.retention?.regeneration,
    ["verified", "speed", "estimatedSeconds", "method"],
    `${label}.retention.regeneration`,
    errors,
  );
  if (!SPEEDS.has(artifact?.retention?.regeneration?.speed)) {
    errors.push(`${label}.retention.regeneration.speed 无效`);
  }
  if (!(Number(artifact?.retention?.regeneration?.estimatedSeconds) >= 0)) {
    errors.push(`${label}.retention.regeneration.estimatedSeconds 必须是非负数`);
  }

  if (template) continue;
  const file = resolveFrom(indexFile, artifact?.path);
  if (artifact?.status === "ready") {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      errors.push(`${label}: ready artifact 文件不存在：${file ?? artifact?.path}`);
    } else if (!SHA256.test(artifact.sha256 ?? "")) {
      errors.push(`${label}.sha256 必须是真实 SHA-256`);
    } else if (!fastIdentityMatches(file, artifact)) {
      errors.push(`${label}: 文件大小或修改时间与 artifact index 不一致`);
    } else if (
      fullHash
      && sha256File(file).toLowerCase() !== artifact.sha256.toLowerCase()
    ) {
      errors.push(`${label}.sha256 与文件不一致`);
    }
  }
  if (!SHA256.test(artifact?.generator?.parametersHash ?? "")) {
    errors.push(`${label}.generator.parametersHash 必须是真实 SHA-256`);
  }
  if (
    !SHA256.test(artifact?.fingerprint ?? "")
    || artifactFingerprint(artifact) !== artifact.fingerprint.toLowerCase()
  ) {
    errors.push(`${label}.fingerprint 与 artifact 内容不一致`);
  }
}

for (const [position, artifact] of (index.artifacts ?? []).entries()) {
  for (const dependency of artifact.dependencies ?? []) {
    if (!byId.has(dependency)) {
      errors.push(`artifacts[${position}] 引用了不存在的依赖：${dependency}`);
    }
  }
}

const visiting = new Set();
const visited = new Set();
function visit(id, trail = []) {
  if (visiting.has(id)) {
    errors.push(`artifact 依赖存在循环：${[...trail, id].join(" -> ")}`);
    return;
  }
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of byId.get(id)?.dependencies ?? []) {
    visit(dependency, [...trail, id]);
  }
  visiting.delete(id);
  visited.add(id);
}
for (const id of byId.keys()) visit(id);

if (errors.length > 0) {
  console.error(`artifact index 检查失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      file: indexFile,
      projectId: index.projectId,
      artifacts: index.artifacts.length,
      ready: index.artifacts.filter((artifact) => artifact.status === "ready").length,
      template,
      identityMode: fullHash ? "full_sha256" : template ? "template" : "fast_stat",
    },
    null,
    2,
  ),
);
