#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  mediaSummary,
  readJson,
  resolveFrom,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";

function usage() {
  console.error(
    "用法：validate_sfx_library.mjs [manifest.json] "
      + "[--asset-id ID | --title TITLE] [--output selection.json] "
      + "[--require-public-distribution] [--config FILE]",
  );
}

const args = process.argv.slice(2);
const input = firstPositional(args, [
  "--asset-id",
  "--title",
  "--output",
  "--config",
  "--secrets",
]);
const assetIdIndex = args.indexOf("--asset-id");
const titleIndex = args.indexOf("--title");
const outputIndex = args.indexOf("--output");
const requirePublicDistribution = args.includes("--require-public-distribution");
if (
  (assetIdIndex >= 0 && !args[assetIdIndex + 1])
  || (titleIndex >= 0 && !args[titleIndex + 1])
  || (outputIndex >= 0 && !args[outputIndex + 1])
  || (assetIdIndex >= 0 && titleIndex >= 0)
) {
  usage();
  process.exit(2);
}

let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: input || process.cwd(),
    includeSecrets: false,
  });
} catch (error) {
  console.error(`配置无效：${error.message}`);
  process.exit(2);
}
const configuredLibrary = loadedConfig.config.tools.sfxLibrary;
const manifestInput = input || (
  configuredLibrary
    ? fs.existsSync(configuredLibrary) && fs.statSync(configuredLibrary).isDirectory()
      ? path.join(configuredLibrary, "manifest.json")
      : configuredLibrary
    : null
);
if (!manifestInput) {
  usage();
  process.exit(2);
}
const manifestFile = path.resolve(manifestInput);
let manifest;
try {
  manifest = readJson(manifestFile);
} catch (error) {
  console.error(`无法读取音效库 manifest：${error.message}`);
  process.exit(2);
}

const allAssets = Array.isArray(manifest.assets) ? manifest.assets : [];
const requestedId = assetIdIndex >= 0 ? args[assetIdIndex + 1] : null;
const requestedTitle = titleIndex >= 0 ? args[titleIndex + 1] : null;
const assets = requestedId
  ? allAssets.filter((asset) => asset.id === requestedId)
  : requestedTitle
    ? allAssets.filter(
      (asset) => asset.title === requestedTitle
        || (Array.isArray(asset.aliases) && asset.aliases.includes(requestedTitle)),
    )
    : allAssets;
const errors = [];

if (allAssets.length === 0) errors.push("manifest.assets 不能为空");
if ((requestedId || requestedTitle) && assets.length !== 1) {
  errors.push(
    requestedId
      ? `assetId 必须唯一命中：${requestedId}`
      : `title 必须唯一命中：${requestedTitle}`,
  );
}

function distributionFor(asset) {
  if (typeof asset.distribution === "string" && asset.distribution.trim()) {
    return asset.distribution;
  }
  if (asset.provider === "user_local" || asset.license_ref === "user_local") {
    return manifest.additional_sources?.user_local?.distribution
      ?? "project_private_only";
  }
  if (
    asset.provider === "user_project_private"
    || asset.license_ref === "project_private"
  ) {
    return manifest.additional_sources?.user_project_private?.distribution
      ?? "project_private_only";
  }
  if (manifest.license?.standalone_redistribution_allowed === true) {
    return "public_distribution_allowed";
  }
  return "project_use_only_no_standalone_redistribution";
}

function publiclyDistributable(distribution) {
  return [
    "public_distribution_allowed",
    "public_distribution_with_kacha_authorized",
  ].includes(distribution);
}

const records = [];
const seenIds = new Set();
const seenNames = new Map();
for (const [index, asset] of allAssets.entries()) {
  if (seenIds.has(asset?.id)) {
    errors.push(`assets[${index}]: id 重复：${asset?.id}`);
  }
  seenIds.add(asset?.id);
  const names = [asset?.title, ...(Array.isArray(asset?.aliases) ? asset.aliases : [])]
    .filter((value) => typeof value === "string" && value.trim());
  const localNames = new Set();
  for (const name of names) {
    if (localNames.has(name)) {
      errors.push(`assets[${index}]: title/aliases 内部重复：${name}`);
      continue;
    }
    localNames.add(name);
    if (seenNames.has(name) && seenNames.get(name) !== asset?.id) {
      errors.push(
        `assets[${index}]: title/alias 与 ${seenNames.get(name)} 冲突：${name}`,
      );
    } else {
      seenNames.set(name, asset?.id);
    }
  }
}
for (const [index, asset] of assets.entries()) {
  const label = `assets[${index}]`;
  for (const field of [
    "id",
    "title",
    "source_file",
    "source_sha256",
    "ready_file",
    "ready_sha256",
    "duration_s",
  ]) {
    if (asset?.[field] === undefined || asset?.[field] === null || asset[field] === "") {
      errors.push(`${label}: 缺少 ${field}`);
    }
  }
  const readyFile = resolveFrom(manifestFile, asset.ready_file);
  const sourceFile = resolveFrom(manifestFile, asset.source_file);
  let summary = null;
  let actualSha256 = null;
  let actualSourceSha256 = null;
  if (!sourceFile || !fs.existsSync(sourceFile)) {
    errors.push(`${label}: source_file 不存在：${sourceFile ?? asset.source_file}`);
  } else {
    actualSourceSha256 = sha256File(sourceFile);
    if (actualSourceSha256 !== asset.source_sha256) {
      errors.push(`${label}: source_sha256 与文件不一致`);
    }
  }
  if (!readyFile || !fs.existsSync(readyFile)) {
    errors.push(`${label}: ready_file 不存在：${readyFile ?? asset.ready_file}`);
  } else {
    actualSha256 = sha256File(readyFile);
    if (actualSha256 !== asset.ready_sha256) {
      errors.push(`${label}: ready_sha256 与文件不一致`);
    }
    try {
      summary = mediaSummary(readyFile);
      if (!summary.audio) errors.push(`${label}: 缺少音频轨`);
      if (summary.sampleRate !== 48000) {
        errors.push(`${label}: 工作副本必须为48kHz`);
      }
      if (summary.channels !== 2) {
        errors.push(`${label}: 工作副本必须为双声道`);
      }
      if (
        Number.isFinite(Number(asset.duration_s))
        && Math.abs(summary.duration - Number(asset.duration_s)) > 0.02
      ) {
        errors.push(`${label}: duration_s 与文件相差超过20ms`);
      }
    } catch (error) {
      errors.push(`${label}: 无法解码：${error.message}`);
    }
  }
  const distribution = distributionFor(asset);
  if (
    requirePublicDistribution
    && !publiclyDistributable(distribution)
  ) {
    errors.push(`${label}: 授权不允许把音频文件随公开仓库分发`);
  }
  records.push({
    id: asset.id,
    title: asset.title,
    aliases: Array.isArray(asset.aliases) ? asset.aliases : [],
    provider: asset.provider ?? manifest.license?.provider ?? null,
    author: asset.author ?? manifest.author ?? null,
    sourceFile,
    sourceSha256: actualSourceSha256,
    readyFile,
    readySha256: actualSha256,
    durationSeconds: summary?.duration ?? Number(asset.duration_s),
    sampleRate: summary?.sampleRate ?? null,
    channels: summary?.channels ?? null,
    distribution,
  });
}

const report = {
  schemaVersion: "1.0",
  status: errors.length === 0 ? "pass" : "fail",
  manifest: manifestFile,
  selectedBy: requestedId
    ? { assetId: requestedId }
    : requestedTitle
      ? { title: requestedTitle }
      : { all: true },
  assets: records,
  configuration: {
    digest: loadedConfig.digest,
    sources: loadedConfig.sources,
  },
  publicDistributionRequested: requirePublicDistribution,
  errors,
};
if (outputIndex >= 0) {
  writeJsonAtomic(path.resolve(args[outputIndex + 1]), report);
}
if (errors.length > 0) {
  console.error(`音效库检查失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
