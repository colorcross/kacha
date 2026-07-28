#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  fileIdentity,
  readJson,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const indexInput = args.find((item) => !item.startsWith("--"));
const id = option(args, "--id");
const type = option(args, "--type");
const versionId = option(args, "--version");
const artifactInput = option(args, "--path");
const generatorName = option(args, "--generator", "kacha");
const generatorVersion = option(args, "--generator-version", "unknown");
const paramsInput = option(args, "--params", "{}");
const dependencies = option(args, "--dependencies", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const scopeKind = option(args, "--scope", "full");
const userNeeds = args.includes("--user-needs");
const requiredForIteration = args.includes("--required-for-iteration");
const paidOrRemote = args.includes("--paid-or-remote");
const humanCalibrated = args.includes("--human-calibrated");
const regenerationVerified = args.includes("--regeneration-verified");
const regenerationSpeed = option(args, "--regeneration-speed", "slow");
const regenerationSeconds = Number(option(args, "--regeneration-seconds", "0"));
const regenerationMethod = option(
  args,
  "--regeneration-method",
  "从受保护依赖重新生成",
);
const allowedScopes = new Set(["full", "no_timeline"]);
const allowedSpeeds = new Set(["fast", "medium", "slow", "remote_or_paid"]);

if (!indexInput || !id || !type || !versionId || !artifactInput) {
  console.error(
    "用法：register_artifact.mjs INDEX.json --id ID --type TYPE "
      + "--version VERSION --path FILE [--dependencies a,b] "
      + "[--params JSON] [--scope full|no_timeline] "
      + "[--user-needs] [--required-for-iteration] "
      + "[--paid-or-remote] [--human-calibrated] "
      + "[--regeneration-verified] [--regeneration-speed fast|medium|slow|remote_or_paid] "
      + "[--regeneration-seconds N] [--regeneration-method TEXT]",
  );
  process.exit(2);
}
if (!allowedScopes.has(scopeKind)) {
  console.error(`不支持的 artifact scope：${scopeKind}`);
  process.exit(2);
}
if (!allowedSpeeds.has(regenerationSpeed)) {
  console.error(`不支持的 regeneration speed：${regenerationSpeed}`);
  process.exit(2);
}
if (!Number.isFinite(regenerationSeconds) || regenerationSeconds < 0) {
  console.error("regeneration-seconds 必须是非负数");
  process.exit(2);
}

const indexFile = path.resolve(indexInput);
const artifactFile = path.resolve(artifactInput);
if (!fs.existsSync(indexFile)) {
  console.error(`artifact index 不存在：${indexFile}`);
  process.exit(2);
}
if (!fs.existsSync(artifactFile) || !fs.statSync(artifactFile).isFile()) {
  console.error(`artifact 文件不存在：${artifactFile}`);
  process.exit(2);
}

let index;
let parameters;
try {
  index = readJson(indexFile);
  parameters = JSON.parse(paramsInput);
} catch (error) {
  console.error(`无法读取 index 或 params：${error.message}`);
  process.exit(2);
}
if (
  index.schemaVersion !== "3.0"
  || !index.projectId
  || !Array.isArray(index.artifacts)
) {
  console.error("artifact index 不是有效的 v3 索引");
  process.exit(2);
}
if ((index.artifacts ?? []).some((artifact) => artifact.id === id)) {
  console.error(`artifact id 已存在，拒绝静默覆盖：${id}`);
  process.exit(2);
}
const knownIds = new Set((index.artifacts ?? []).map((artifact) => artifact.id));
for (const dependency of dependencies) {
  if (!knownIds.has(dependency)) {
    console.error(`依赖 artifact 不存在：${dependency}`);
    process.exit(2);
  }
}

const identity = fileIdentity(artifactFile);
const artifact = {
  id,
  type,
  versionId,
  path: path.relative(path.dirname(indexFile), artifactFile),
  sha256: identity.sha256,
  sizeBytes: identity.sizeBytes,
  mtimeMs: identity.mtimeMs,
  fingerprint: "",
  status: "ready",
  dependencies,
  scope: { kind: scopeKind },
  generator: {
    name: generatorName,
    version: generatorVersion,
    parametersHash: sha256Value(parameters),
  },
  retention: {
    userNeeds,
    requiredForIteration,
    paidOrRemote,
    humanCalibrated,
    regeneration: {
      verified: regenerationVerified,
      speed: regenerationSpeed,
      estimatedSeconds: regenerationSeconds,
      method: regenerationMethod,
    },
  },
};
artifact.fingerprint = sha256Value({
  type: artifact.type,
  versionId: artifact.versionId,
  sha256: artifact.sha256,
  dependencies: [...artifact.dependencies].sort(),
  scope: artifact.scope,
  generator: artifact.generator,
});
index.artifacts.push(artifact);
index.generatedAt = new Date().toISOString();
writeJsonAtomic(indexFile, index);
console.log(
  JSON.stringify(
    {
      status: "pass",
      index: indexFile,
      artifact: {
        id,
        type,
        versionId,
        sha256: artifact.sha256,
        fingerprint: artifact.fingerprint,
      },
    },
    null,
    2,
  ),
);
