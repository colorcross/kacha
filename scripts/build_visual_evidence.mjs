#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acquireFileLock,
  commandExists,
  fileIdentity,
  mediaSummary,
  resolveRuntimeCommand,
  run,
  runtimeEnvironment,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";
import { diagnostic } from "./kacha_error_catalog.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const input = firstPositional(args, [
  "--output-dir",
  "--mode",
  "--max-frames",
  "--timestamp",
  "--scene-threshold",
  "--workers",
  "--config",
  "--secrets",
]);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function repeated(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function fail(code, detail, exitCode = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    diagnostics: [diagnostic(code, detail)],
  }, null, 2));
  process.exit(exitCode);
}

let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: input || process.cwd(),
    includeSecrets: false,
  });
} catch (error) {
  fail("KACHA-E140", `配置无效：${error.message}`);
}
const visualConfig = loadedConfig.config.execution.visualEvidence;
const outputDirectoryArgument = option("--output-dir");
const mode = option("--mode", visualConfig.defaultMode);
const maxFrames = Number(option(
  "--max-frames",
  String(visualConfig.maxFrames[mode] ?? visualConfig.maxFrames.fast),
));
const sceneThreshold = Number(option(
  "--scene-threshold",
  String(visualConfig.sceneThreshold),
));
const force = args.includes("--force");
const skipAppleVision = args.includes("--skip-apple-vision");
const explicitTimestamps = repeated("--timestamp").map(Number);
const requestedWorkers = Number(
  option("--workers", String(Math.min(visualConfig.workers, os.cpus().length))),
);
const concurrency = Math.max(1, Math.min(8, requestedWorkers));
const maxImageEdge = visualConfig.maxImageEdge;
const preferredHardwareDecode = process.platform === "darwin"
  ? ["-hwaccel", "videotoolbox"]
  : [];

if (
  !input
  || !outputDirectoryArgument
  || !["fast", "review", "release"].includes(mode)
  || !(Number.isInteger(maxFrames) && maxFrames >= 3 && maxFrames <= 48)
  || !(sceneThreshold > 0 && sceneThreshold < 1)
  || !(Number.isInteger(requestedWorkers) && requestedWorkers >= 1 && requestedWorkers <= 8)
  || explicitTimestamps.some((value) => !Number.isFinite(value) || value < 0)
) {
  fail(
    "KACHA-E140",
    "用法：kacha.mjs visual-evidence VIDEO --output-dir DIR "
      + "[--mode fast|review|release] [--max-frames 8..48] "
      + "[--timestamp SEC] [--scene-threshold 0.34] "
      + "[--workers 1..8] [--config FILE] "
      + "[--skip-apple-vision] [--force]",
    2,
  );
}
if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
  fail("KACHA-E130", "visual-evidence 需要 ffmpeg 和 ffprobe");
}

const source = path.resolve(input);
const outputDirectory = path.resolve(outputDirectoryArgument);
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
  fail("KACHA-E100", `视频不存在：${source}`);
}
let releaseLock = null;
try {
  releaseLock = acquireFileLock(`${outputDirectory}.lock`, {
    purpose: `visual-evidence:${path.basename(source)}`,
  });
} catch (error) {
  fail("KACHA-E500", error.message);
}
process.on("exit", () => releaseLock?.());
let summary;
try {
  summary = mediaSummary(source);
} catch (error) {
  fail("KACHA-E500", `媒体探测失败：${error.message}`);
}
if (!summary.video || !(summary.duration > 0)) {
  fail("KACHA-E140", "visual-evidence 输入必须包含可解码视频轨");
}
const identity = fileIdentity(source);
const optionsIdentity = {
  mode,
  maxFrames,
  sceneThreshold,
  explicitTimestamps,
  skipAppleVision,
  maxImageEdge,
  decodePolicy: preferredHardwareDecode.length > 0
    ? "videotoolbox_then_software"
    : "software",
  scriptVersion: "1.1.0",
};
const cacheKey = sha256Value({
  sourceSha256: identity.sha256,
  options: optionsIdentity,
});
const evidenceFile = path.join(outputDirectory, "visual-evidence.json");
const markdownFile = path.join(outputDirectory, "visual-evidence.md");
if (!force && fs.existsSync(evidenceFile)) {
  try {
    const cached = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
    if (cached.cacheKey === cacheKey && cached.source?.sha256 === identity.sha256) {
      console.log(JSON.stringify({
        status: "reused",
        evidence: evidenceFile,
        markdown: markdownFile,
        contactSheet: cached.contactSheet?.path ?? null,
        cacheKey,
        frames: cached.frames?.length ?? 0,
      }, null, 2));
      releaseLock?.();
      releaseLock = null;
      process.exit(0);
    }
  } catch {
    // Invalid cache is replaced only after a full successful rebuild.
  }
}

const staging = `${outputDirectory}.staging-${process.pid}-${Date.now()}`;
if (fs.existsSync(staging)) {
  fail("KACHA-E500", `staging 已存在：${staging}`);
}
fs.mkdirSync(path.join(staging, "frames"), { recursive: true });

function spread(values, limit) {
  if (values.length <= limit) return values;
  if (limit <= 1) return [values[Math.floor(values.length / 2)]];
  const selected = [];
  for (let index = 0; index < limit; index += 1) {
    selected.push(values[Math.round(index * (values.length - 1) / (limit - 1))]);
  }
  return selected;
}

function sceneTimes() {
  if (mode === "fast") {
    return { status: "skipped", times: [], error: null };
  }
  const detectorArguments = (hardwareDecode) => [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    ...hardwareDecode,
    "-i",
    source,
    "-an",
    "-vf",
    `scale=320:-2:flags=fast_bilinear,select='gt(scene,${sceneThreshold})',showinfo`,
    "-fps_mode",
    "vfr",
    "-f",
    "null",
    "-",
  ];
  let detector = run("ffmpeg", detectorArguments(preferredHardwareDecode));
  let decoder = preferredHardwareDecode.length > 0 ? "videotoolbox" : "software";
  if (detector.status !== 0 && preferredHardwareDecode.length > 0) {
    detector = run("ffmpeg", detectorArguments([]));
    decoder = "software_fallback";
  }
  if (detector.status !== 0) {
    return {
      status: "fail",
      times: [],
      error: detector.stderr.trim() || "scene detection failed",
    };
  }
  const matches = [...detector.stderr.matchAll(/pts_time:([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return { status: "pass", times: matches, error: null, decoder };
}

const duration = summary.duration;
const edge = Math.min(0.5, Math.max(0.04, duration / 20));
const anchors = [
  edge,
  duration * 0.25,
  duration * 0.5,
  duration * 0.75,
  Math.max(edge, duration - edge),
];
const uniformCount = Math.max(3, Math.min(maxFrames, mode === "fast" ? maxFrames : 8));
for (let index = 0; index < uniformCount; index += 1) {
  anchors.push(edge + (Math.max(edge, duration - edge) - edge) * index / (uniformCount - 1));
}
const sceneDetection = sceneTimes();
const scenes = sceneDetection.times;
const combined = [
  ...explicitTimestamps,
  ...anchors,
  ...spread(scenes, Math.max(0, maxFrames - anchors.length)),
]
  .filter((value) => Number.isFinite(value) && value >= 0 && value < duration)
  .map((value) => Math.round(value * 1000) / 1000)
  .sort((a, b) => a - b);
const deduplicated = [];
const frameInterval = Number.isFinite(summary.fps) && summary.fps > 0
  ? 1 / summary.fps
  : 1 / 25;
for (const timestamp of combined) {
  if (
    deduplicated.length === 0
    || Math.abs(timestamp - deduplicated.at(-1)) >= Math.max(0.08, frameInterval)
  ) {
    deduplicated.push(timestamp);
  }
}
const timestamps = spread(deduplicated, maxFrames);

function runAsync(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(resolveRuntimeCommand(command), commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: runtimeEnvironment(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: error.message }));
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

function timeLabel(value) {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${seconds.toFixed(3).padStart(6, "0")}`;
}

let extracted;
try {
  extracted = await mapLimit(timestamps, concurrency, async (timestamp, index) => {
    const file = path.join(
      staging,
      "frames",
      `frame-${String(index + 1).padStart(3, "0")}.jpg`,
    );
    const extractionArguments = (hardwareDecode) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...hardwareDecode,
      "-ss",
      timestamp.toFixed(6),
      "-i",
      source,
      "-frames:v",
      "1",
      "-vf",
      `scale=${maxImageEdge}:${maxImageEdge}:force_original_aspect_ratio=decrease:flags=lanczos`,
      "-q:v",
      "2",
      "-y",
      file,
    ];
    let result = await runAsync(
      "ffmpeg",
      extractionArguments(preferredHardwareDecode),
    );
    let decoder = preferredHardwareDecode.length > 0 ? "videotoolbox" : "software";
    if (result.status !== 0 && preferredHardwareDecode.length > 0) {
      result = await runAsync("ffmpeg", extractionArguments([]));
      decoder = "software_fallback";
    }
    if (result.status !== 0 || !fs.existsSync(file)) {
      throw new Error(result.stderr.trim() || `frame extraction failed at ${timestamp}`);
    }
    return {
      id: `frame-${String(index + 1).padStart(3, "0")}`,
      timestampSeconds: timestamp,
      timecode: timeLabel(timestamp),
      path: file,
      sha256: sha256File(file),
      decoder,
    };
  });
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  fail("KACHA-E500", `关键帧提取失败：${error.message}`);
}

function technicalMetrics(frame) {
  const result = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    "-i",
    frame.path,
    "-vf",
    "signalstats,metadata=print",
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
  const log = `${result.stdout}\n${result.stderr}`;
  const metric = (key) => {
    const match = new RegExp(`${key}=([-+0-9.]+)`).exec(log);
    return match ? Number(match[1]) : null;
  };
  const yAverage = metric("lavfi.signalstats.YAVG");
  const saturationAverage = metric("lavfi.signalstats.SATAVG");
  return {
    analysisStatus: result.status === 0 ? "pass" : "fail",
    lumaAverage: yAverage,
    lumaNormalized: Number.isFinite(yAverage)
      ? Number((yAverage / 255).toFixed(6))
      : null,
    saturationAverage,
    nearBlack: Number.isFinite(yAverage) ? yAverage < 16 : null,
    overBright: Number.isFinite(yAverage) ? yAverage > 235 : null,
  };
}

for (const frame of extracted) frame.technical = technicalMetrics(frame);

function compileVisionAnalyzer() {
  if (skipAppleVision || process.platform !== "darwin" || !commandExists("swiftc")) {
    return null;
  }
  const sourceFile = path.join(scriptsDirectory, "analyze_visual_frames.swift");
  const swiftVersion = run("swiftc", ["--version"]);
  const binaryKey = crypto.createHash("sha256")
    .update(fs.readFileSync(sourceFile))
    .update(swiftVersion.stdout)
    .digest("hex")
    .slice(0, 16);
  const cacheRoot = path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "kacha",
    "tools",
  );
  fs.mkdirSync(cacheRoot, { recursive: true });
  const binary = path.join(cacheRoot, `visual-frame-analyzer-${binaryKey}`);
  if (fs.existsSync(binary) && fs.statSync(binary).mode & 0o100) return binary;
  const temporary = `${binary}.tmp-${process.pid}`;
  const compile = run("swiftc", [
    "-O",
    sourceFile,
    "-o",
    temporary,
  ]);
  if (compile.status !== 0) return null;
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, binary);
  return binary;
}

let localVisionStatus = "unavailable";
let localVisionError = null;
let analyzer = null;
try {
  analyzer = compileVisionAnalyzer();
} catch (error) {
  localVisionStatus = "fail";
  localVisionError = `Apple Vision setup failed: ${error.message}`;
}
if (analyzer) {
  const vision = run(analyzer, extracted.map((frame) => frame.path));
  if (vision.status === 0) {
    try {
      const results = JSON.parse(vision.stdout);
      const byPath = new Map(results.map((item) => [path.resolve(item.path), item]));
      for (const frame of extracted) {
        frame.localVision = byPath.get(path.resolve(frame.path)) ?? null;
      }
      localVisionStatus = "pass";
    } catch (error) {
      localVisionStatus = "fail";
      localVisionError = `Apple Vision JSON parse failed: ${error.message}`;
    }
  } else {
    localVisionStatus = "fail";
    localVisionError = vision.stderr.trim() || "Apple Vision analyzer failed";
  }
}
if (localVisionStatus !== "pass") {
  for (const frame of extracted) frame.localVision = null;
}

let contactSheet = null;
if (extracted.length > 0) {
  const columns = Math.min(4, extracted.length);
  const rows = Math.ceil(extracted.length / columns);
  const sheet = path.join(staging, "contact-sheet.jpg");
  const tile = run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-framerate",
    "1",
    "-i",
    path.join(staging, "frames", "frame-%03d.jpg"),
    "-vf",
    `scale=480:-2:flags=lanczos,tile=${columns}x${rows}:padding=8:margin=8:color=#F5E4C7`,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    sheet,
  ]);
  if (tile.status === 0 && fs.existsSync(sheet)) {
    contactSheet = {
      path: sheet,
      sha256: sha256File(sheet),
      columns,
      rows,
      frameOrder: extracted.map((frame) => ({
        id: frame.id,
        timecode: frame.timecode,
      })),
    };
  }
}
const contactSheetStatus = contactSheet ? "pass" : "fail";

const findings = [];
function overlapRatio(subject, overlay) {
  const left = Math.max(subject.x, overlay.x);
  const top = Math.max(subject.y, overlay.y);
  const right = Math.min(subject.x + subject.width, overlay.x + overlay.width);
  const bottom = Math.min(subject.y + subject.height, overlay.y + overlay.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const overlayArea = Math.max(0.000001, overlay.width * overlay.height);
  return intersection / overlayArea;
}
for (const frame of extracted) {
  const faces = frame.localVision?.faces ?? [];
  const recognizedText = frame.localVision?.recognizedText ?? [];
  for (const face of faces) {
    if (face.topMargin < 0.015) {
      findings.push({
        severity: "review",
        frameId: frame.id,
        timestampSeconds: frame.timestampSeconds,
        code: "head_margin_low",
        detail: `face top margin ${face.topMargin.toFixed(4)} < 0.015`,
      });
    }
    for (const text of recognizedText) {
      const overlap = overlapRatio(face.bounds, text.bounds);
      if (overlap >= 0.15) {
        findings.push({
          severity: "review",
          frameId: frame.id,
          timestampSeconds: frame.timestampSeconds,
          code: "text_face_overlap",
          detail: `OCR text overlaps face by ${(overlap * 100).toFixed(1)}%: ${text.text.slice(0, 32)}`,
        });
      }
    }
  }
  if (frame.technical.nearBlack) {
    findings.push({
      severity: "review",
      frameId: frame.id,
      timestampSeconds: frame.timestampSeconds,
      code: "near_black_frame",
      detail: `luma average ${frame.technical.lumaAverage}`,
    });
  }
}

const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  cacheKey,
  status: localVisionStatus === "pass" && contactSheetStatus === "pass"
    ? "pass"
    : "pass_with_evidence_gap",
  source: {
    ...identity,
    media: {
      durationSeconds: summary.duration,
      width: summary.width,
      height: summary.height,
      declaredFps: summary.declaredFps,
      averageFps: summary.averageFps,
      aspectRatio: `${summary.width}:${summary.height}`,
    },
  },
  sampling: {
    mode,
    maxFrames,
    selectedFrames: extracted.length,
    explicitTimestamps,
    sceneDetection: mode === "fast"
      ? { enabled: false }
      : {
          enabled: true,
          status: sceneDetection.status,
          threshold: sceneThreshold,
          detected: scenes.length,
          error: sceneDetection.error,
          decoder: sceneDetection.decoder ?? null,
        },
  },
  analysis: {
    localTechnical: "pass",
    localSemantic: localVisionStatus,
    localSemanticEngine: analyzer ? "Apple Vision" : null,
    localSemanticError: localVisionError,
    contactSheet: contactSheetStatus,
    remoteSemantic: "not_requested",
  },
  frames: extracted,
  contactSheet,
  findings,
  provenance: {
    tool: "build_visual_evidence.mjs",
    version: optionsIdentity.scriptVersion,
    configurationDigest: loadedConfig.digest,
    configurationSources: loadedConfig.sources,
    externalUpload: false,
    wholeVideoUploaded: false,
  },
};

function markdown(reportValue) {
  const lines = [
    "# 咔嚓视觉证据",
    "",
    `- 源：\`${reportValue.source.path}\``,
    `- SHA-256：\`${reportValue.source.sha256}\``,
    `- 规格：${reportValue.source.media.width}×${reportValue.source.media.height}，${Number.isFinite(reportValue.source.media.averageFps) ? reportValue.source.media.averageFps.toFixed(3) : "unknown"} fps，${reportValue.source.media.durationSeconds.toFixed(3)} 秒`,
    `- 抽样：${reportValue.sampling.mode}，${reportValue.frames.length} 帧`,
    `- 本地语义分析：${reportValue.analysis.localSemantic}`,
    "",
    "| 时间码 | 人脸 | 人物 | 头顶最小余量 | 亮度 | OCR 摘要 | 证据帧 |",
    "|---|---:|---:|---:|---:|---|---|",
  ];
  for (const frame of reportValue.frames) {
    const faces = frame.localVision?.faces ?? [];
    const humans = frame.localVision?.humans ?? [];
    const topMargin = faces.length > 0
      ? Math.min(...faces.map((item) => item.topMargin)).toFixed(4)
      : "n/a";
    const text = (frame.localVision?.recognizedText ?? [])
      .map((item) => item.text.replaceAll("|", "｜"))
      .join(" / ")
      .slice(0, 80);
    lines.push(
      `| ${frame.timecode} | ${faces.length} | ${humans.length} | ${topMargin} | ${frame.technical.lumaNormalized ?? "n/a"} | ${text || "—"} | \`${path.relative(staging, frame.path)}\` |`,
    );
  }
  if (reportValue.findings.length > 0) {
    lines.push("", "## 需要人工判断", "");
    for (const finding of reportValue.findings) {
      lines.push(
        `- ${finding.frameId} ${finding.timestampSeconds.toFixed(3)}s：${finding.code}，${finding.detail}`,
      );
    }
  }
  lines.push(
    "",
    "> 这份文件是机器可读视觉证据，不替代正常速度通看。Claude Code 可先读本文件和 JSON；只有项目明确授权外传时，才对少量关键帧执行 MiniMax 语义增强。",
    "",
  );
  return lines.join("\n");
}

writeJsonAtomic(path.join(staging, "visual-evidence.json"), report);
fs.writeFileSync(path.join(staging, "visual-evidence.md"), markdown(report));

for (const frame of report.frames) {
  frame.path = path.join(outputDirectory, path.relative(staging, frame.path));
  if (frame.localVision?.path) frame.localVision.path = frame.path;
}
if (report.contactSheet) {
  report.contactSheet.path = path.join(
    outputDirectory,
    path.relative(staging, report.contactSheet.path),
  );
}
writeJsonAtomic(path.join(staging, "visual-evidence.json"), report);
fs.writeFileSync(path.join(staging, "visual-evidence.md"), markdown({
  ...report,
  frames: report.frames.map((frame) => ({
    ...frame,
    path: path.join(staging, path.relative(outputDirectory, frame.path)),
  })),
}));

if (fs.existsSync(outputDirectory)) {
  const backup = `${outputDirectory}.backup-${process.pid}-${Date.now()}`;
  fs.renameSync(outputDirectory, backup);
  try {
    fs.renameSync(staging, outputDirectory);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(outputDirectory)) {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
    fs.renameSync(backup, outputDirectory);
    fail("KACHA-E500", `视觉证据原子替换失败：${error.message}`);
  }
} else {
  try {
    fs.renameSync(staging, outputDirectory);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    fail("KACHA-E500", `视觉证据发布失败：${error.message}`);
  }
}

console.log(JSON.stringify({
  status: report.status,
  evidence: evidenceFile,
  markdown: markdownFile,
  contactSheet: report.contactSheet?.path ?? null,
  cacheKey,
  frames: report.frames.length,
  findings: report.findings.length,
  localSemantic: report.analysis.localSemantic,
  configurationDigest: loadedConfig.digest,
}, null, 2));
releaseLock?.();
releaseLock = null;
