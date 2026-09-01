#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  readJson,
  resolveFrom,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { buildTimelineProjection } from "./timeline_projection.mjs";

const PROFILE_DEFINITIONS = Object.freeze({
  "h264-master": { container: "mp4", codecs: ["h264_videotoolbox", "libx264"], pixelFormat: "yuv420p", audio: "aac", use: "通用发布与审片" },
  "h265-master": { container: "mp4", codecs: ["hevc_videotoolbox", "libx265"], pixelFormat: "yuv420p", audio: "aac", use: "高压缩比交付" },
  "prores-422-hq": { container: "mov", codecs: ["prores_ks"], pixelFormat: "yuv422p10le", audio: "pcm_s24le", use: "专业中间片与归档" },
});

let runtimeEvidence = null;
function ffmpegListing(flag) {
  const result = spawnSync("ffmpeg", ["-hide_banner", flag], {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  });
  return { available: result.status === 0, text: result.status === 0 ? `${result.stdout}\n${result.stderr}` : "" };
}

function deliveryRuntime() {
  if (runtimeEvidence) return runtimeEvidence;
  const encoders = ffmpegListing("-encoders");
  const muxers = ffmpegListing("-muxers");
  const pixelFormats = ffmpegListing("-pix_fmts");
  runtimeEvidence = { encoders, muxers, pixelFormats };
  return runtimeEvidence;
}

function exactToken(text, token) {
  return new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "m").test(text);
}

function availableEncoder(candidates, runtime = deliveryRuntime()) {
  return candidates.find((candidate) => exactToken(runtime.encoders.text, candidate)) ?? null;
}

export function listDeliveryProfiles({ refresh = false } = {}) {
  if (refresh) runtimeEvidence = null;
  const profiles = Object.entries(PROFILE_DEFINITIONS).map(([id, profile]) => {
    const runtime = deliveryRuntime();
    const encoder = availableEncoder(profile.codecs, runtime);
    const audioEncoder = availableEncoder([profile.audio], runtime);
    const checks = {
      videoEncoder: Boolean(encoder),
      audioEncoder: Boolean(audioEncoder),
      muxer: runtime.muxers.available && exactToken(runtime.muxers.text, profile.container),
      pixelFormat: runtime.pixelFormats.available && exactToken(runtime.pixelFormats.text, profile.pixelFormat),
    };
    const blockedReasons = Object.entries(checks).filter(([, pass]) => !pass).map(([requirement]) => requirement);
    return {
      id, ...profile,
      status: blockedReasons.length === 0 ? "available" : "blocked",
      selectedEncoder: encoder,
      selectedAudioEncoder: audioEncoder,
      runtimeChecks: checks,
      blockedReasons,
      limitation: blockedReasons.length === 0 ? null : `当前 FFmpeg 运行时缺少：${blockedReasons.join(", ")}`,
    };
  });
  const value = {
    schemaVersion: "1.0", kind: "kacha-delivery-profiles", status: "pass_with_runtime_gates",
    profiles,
    invariants: ["浏览器不直接执行正式导出", "正式导出仍需 Timeline validate、Render Graph、QC 与人工审片", "输出文件不覆盖"],
  };
  value.digest = sha256Value(value);
  return value;
}

function exclusiveJson(file, value) {
  const resolved = path.resolve(file ?? "");
  if (!file || fs.existsSync(resolved)) throw new Error(`拒绝覆盖文件：${resolved}`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return fileIdentity(resolved);
}

export function createDeliveryPlan(timelineFile, profileId, outputFile) {
  const projection = buildTimelineProjection(timelineFile, { includeSourceHash: true });
  const timelineIdentity = fileIdentity(path.resolve(timelineFile));
  if (timelineIdentity.sha256 !== projection.timeline.sha256) throw new Error("Timeline 在交付计划校验期间已变化");
  const profile = listDeliveryProfiles({ refresh: true }).profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`未知交付 profile：${profileId}`);
  if (profile.status !== "available") throw new Error(`交付 profile 当前不可用：${profileId}`);
  const output = path.resolve(outputFile ?? "");
  if (!outputFile) throw new Error("delivery plan 必须提供 --output");
  const expectedExtension = `.${profile.container}`;
  if (path.extname(output).toLowerCase() !== expectedExtension) throw new Error(`profile ${profileId} 输出必须是 ${expectedExtension}`);
  if (fs.existsSync(output)) throw new Error(`拒绝覆盖交付输出：${output}`);
  if (fileIdentity(path.resolve(timelineFile)).sha256 !== timelineIdentity.sha256) throw new Error("Timeline 在交付计划生成期间已变化");
  if (projection.timeline.sourceIdentity
    && fileIdentity(projection.timeline.source).sha256 !== projection.timeline.sourceIdentity.sha256) {
    throw new Error("Timeline source 在交付计划生成期间已变化");
  }
  const plan = {
    schemaVersion: "1.0",
    kind: "kacha-delivery-plan",
    status: "planned_not_rendered",
    generatedAt: new Date().toISOString(),
    timeline: timelineIdentity,
    source: projection.timeline.sourceIdentity,
    projectionDigest: projection.digest,
    profile,
    output,
    requiredGates: ["timeline validate", "timeline compile", "timeline render --mode final", "qc", "normal-speed human review"],
    limitations: ["该文件是交付计划，不是已渲染成片", "执行时必须重新探测 encoder 并核对 Timeline SHA"],
  };
  plan.digest = sha256Value(plan);
  return { ...plan, plan: exclusiveJson(`${output}.kacha-delivery.json`, plan) };
}

function assetReference(ownerFile, entry, label) {
  if (!entry) return null;
  const candidate = typeof entry === "string" ? entry : entry.path;
  if (!candidate) return null;
  const resolved = resolveFrom(ownerFile, candidate);
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label} 媒体不存在：${resolved ?? candidate}`);
  const identity = fileIdentity(resolved);
  if (typeof entry === "object" && entry.sha256 && entry.sha256 !== identity.sha256) throw new Error(`${label} SHA-256 已失效`);
  return { label, entry, resolved, identity };
}

function timelineAssets(timelineFile, timeline) {
  const assets = [];
  const add = (entry, label) => { const value = assetReference(timelineFile, entry, label); if (value) assets.push(value); };
  add(timeline.source, "source");
  (timeline.visual?.overlays ?? []).forEach((entry, index) => add(entry, `overlay-${index + 1}`));
  add(timeline.visual?.subtitles, "subtitles");
  add(timeline.audio?.dialogue, "dialogue");
  if (Array.isArray(timeline.audio?.bgm?.segments)) timeline.audio.bgm.segments.forEach((entry, index) => add(entry, `bgm-${index + 1}`));
  else add(timeline.audio?.bgm, "bgm");
  (timeline.audio?.sfx ?? []).forEach((entry, index) => add(entry, `sfx-${index + 1}`));
  return assets;
}

function assertAssetsCurrent(assets) {
  for (const asset of assets) {
    if (fileIdentity(asset.resolved).sha256 !== asset.identity.sha256) {
      throw new Error(`${asset.label} 在工程包生成期间已变化`);
    }
  }
}

function mediaAuthorized(asset) {
  if (!asset.entry || typeof asset.entry !== "object" || Array.isArray(asset.entry)) return false;
  const license = String(asset.entry.license ?? "").trim().toLowerCase();
  const provenanceKind = String(asset.entry.provenance?.kind ?? "").trim().toLowerCase();
  const evidence = asset.entry.provenance?.evidence;
  const evidenceValid = (typeof evidence === "string" && evidence.trim().length > 0)
    || (Array.isArray(evidence) && evidence.length > 0 && evidence.every((entry) => typeof entry === "string" && entry.trim().length > 0));
  const licenseAuthorized = /^(owned|project-owned(?: derivative)?|original|public-domain|cc0|licensed(?:[: _-].+)?|generated(?:[: _-].+)?|cc-by(?:-sa|-nc|-nd)?(?:-[0-9.]+)?)$/.test(license);
  const provenanceAuthorized = /^(owned(?:_local)?|project[-_](?:owned|evidence|sfx_library|generated(?:_[a-z0-9]+)*)|original|(?:local_)?generated(?:[_ -].+)?|licensed(?:[_ -].+)?|documented)$/.test(provenanceKind);
  return Boolean(licenseAuthorized
    && provenanceAuthorized
    && evidenceValid);
}

function publishBundleStage(stage, output) {
  const reservation = randomUUID();
  const marker = path.join(output, ".kacha-bundle-reservation");
  const moved = [];
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  try {
    fs.writeFileSync(marker, reservation, { flag: "wx", mode: 0o600 });
    const entries = fs.readdirSync(stage).sort((left, right) => {
      if (left === "manifest.json") return 1;
      if (right === "manifest.json") return -1;
      return left.localeCompare(right);
    });
    for (const entry of entries) {
      const destination = path.join(output, entry);
      fs.renameSync(path.join(stage, entry), destination);
      moved.push(destination);
    }
    fs.unlinkSync(marker);
    fs.rmdirSync(stage);
  } catch (error) {
    for (const destination of moved.reverse()) {
      try { fs.rmSync(destination, { recursive: true, force: true }); } catch {}
    }
    try {
      if (fs.readFileSync(marker, "utf8") === reservation) fs.unlinkSync(marker);
    } catch {}
    try { fs.rmdirSync(output); } catch {}
    throw error;
  }
}

function replaceAssetPaths(value, ownerFile, mapping) {
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const copy = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
    if (typeof copy.path === "string") {
      const resolved = resolveFrom(ownerFile, copy.path);
      if (mapping.has(resolved)) copy.path = mapping.get(resolved);
    }
    return copy;
  };
  const output = visit(value);
  if (typeof output.source === "string") {
    const resolved = resolveFrom(ownerFile, output.source);
    if (mapping.has(resolved)) output.source = { path: mapping.get(resolved), sha256: sha256File(resolved) };
  }
  return output;
}

function assertPortableValue(value, pointer = "$") {
  if (typeof value === "string" && (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value))) {
    throw new Error(`工程包仍包含绝对本机路径：${pointer}`);
  }
  if (Array.isArray(value)) return value.forEach((entry, index) => assertPortableValue(entry, `${pointer}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) assertPortableValue(child, `${pointer}.${key}`);
  }
}

function portableProvenanceSummary(provenance) {
  return {
    kind: typeof provenance?.kind === "string" ? provenance.kind : "documented",
    externalUpload: provenance?.externalUpload === true,
    digest: sha256Value(provenance),
  };
}

export function createSelfContainedBundle(timelineFile, outputDirectory, { includeMedia = false } = {}) {
  const timelinePath = path.resolve(timelineFile ?? "");
  const timelineIdentity = fileIdentity(timelinePath);
  const projection = buildTimelineProjection(timelinePath, { includeSourceHash: true });
  if (projection.timeline.sha256 !== timelineIdentity.sha256) throw new Error("Timeline 在工程包校验期间已变化");
  const output = path.resolve(outputDirectory ?? "");
  if (!outputDirectory || fs.existsSync(output)) throw new Error(`拒绝覆盖工程包：${output}`);
  const timeline = readJson(timelinePath);
  if (fileIdentity(timelinePath).sha256 !== timelineIdentity.sha256) throw new Error("Timeline 在工程包读取期间已变化");
  const assets = timelineAssets(timelinePath, timeline);
  const unauthorized = includeMedia ? assets.filter((asset) => !mediaAuthorized(asset)) : [];
  if (unauthorized.length) throw new Error(`以下媒体缺少 license/provenance，禁止自包含：${unauthorized.map((asset) => asset.label).join(", ")}`);
  const stage = `${output}.stage-${randomUUID()}`;
  fs.mkdirSync(stage, { recursive: false, mode: 0o700 });
  try {
    const mapping = new Map();
    const included = [];
    if (includeMedia) {
      const mediaRoot = path.join(stage, "Media");
      fs.mkdirSync(mediaRoot, { mode: 0o700 });
      const copiedBySha = new Map();
      for (const asset of assets) {
        const extension = path.extname(asset.resolved).toLowerCase();
        let relative = copiedBySha.get(asset.identity.sha256);
        if (!relative) {
          const safeName = `${asset.label.replace(/[^a-zA-Z0-9._-]+/g, "-")}-${asset.identity.sha256.slice(0, 12)}${extension}`;
          const destination = path.join(mediaRoot, safeName);
          fs.copyFileSync(asset.resolved, destination, fs.constants.COPYFILE_EXCL);
          if (sha256File(destination) !== asset.identity.sha256) throw new Error(`媒体复制后 SHA 不一致：${asset.label}`);
          relative = `./Media/${safeName}`;
          copiedBySha.set(asset.identity.sha256, relative);
        }
        mapping.set(asset.resolved, relative);
        included.push({
          label: asset.label, path: relative,
          identity: { sizeBytes: asset.identity.sizeBytes, sha256: asset.identity.sha256 },
          license: asset.entry.license, provenance: portableProvenanceSummary(asset.entry.provenance),
        });
      }
    } else {
      for (const asset of assets) {
        const extension = path.extname(asset.resolved).toLowerCase();
        const safeName = `${asset.label.replace(/[^a-zA-Z0-9._-]+/g, "-")}-${asset.identity.sha256.slice(0, 12)}${extension}`;
        mapping.set(asset.resolved, `./Missing/${safeName}`);
      }
    }
    const portableTimeline = replaceAssetPaths(timeline, timelinePath, mapping);
    assertPortableValue(portableTimeline);
    if (fileIdentity(timelinePath).sha256 !== timelineIdentity.sha256) throw new Error("Timeline 在工程包生成期间已变化");
    assertAssetsCurrent(assets);
    const timelineOutput = path.join(stage, "timeline.json");
    writeJsonAtomic(timelineOutput, portableTimeline, { mode: 0o600 });
    const manifest = {
      schemaVersion: "1.0", kind: "kacha-self-contained-project", status: includeMedia ? "portable_with_authorized_media" : "contract_only",
      generatedAt: new Date().toISOString(), sourceTimeline: {
        sizeBytes: timelineIdentity.sizeBytes,
        sha256: timelineIdentity.sha256,
      },
      timeline: { path: "./timeline.json", sha256: sha256File(timelineOutput) }, includeMedia,
      includedMedia: included,
      excludedMedia: includeMedia ? [] : assets.map((asset) => ({ label: asset.label, sha256: asset.identity.sha256, reason: "media inclusion was not explicitly authorized; Timeline uses a ./Missing placeholder" })),
      limitations: ["不包含 Command Journal、私有音效库源文件或 AppCreate 证据", "导入后必须重新校验路径、SHA、许可与运行时能力"],
    };
    manifest.digest = sha256Value(manifest);
    assertPortableValue(manifest);
    writeJsonAtomic(path.join(stage, "manifest.json"), manifest, { mode: 0o600 });
    if (fileIdentity(timelinePath).sha256 !== timelineIdentity.sha256) throw new Error("Timeline 在工程包发布前已变化");
    assertAssetsCurrent(assets);
    publishBundleStage(stage, output);
    return { ...manifest, bundle: fileIdentity(path.join(output, "manifest.json")), output };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function option(args, name, fallback = null) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; }

export function runDeliveryCli(args = process.argv.slice(2)) {
  const action = args[0];
  if (action === "profiles") return listDeliveryProfiles();
  if (action === "plan") return createDeliveryPlan(option(args, "--timeline"), option(args, "--profile"), option(args, "--output"));
  if (action === "bundle") return createSelfContainedBundle(option(args, "--timeline"), option(args, "--output"), { includeMedia: args.includes("--include-media") });
  throw new Error("用法：kacha delivery profiles | plan --timeline FILE --profile ID --output VIDEO | bundle --timeline FILE --output DIR [--include-media]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(runDeliveryCli(), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
