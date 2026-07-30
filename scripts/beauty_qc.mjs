#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { loadBeautyV2 } from "./beauty_v2.mjs";
import {
  readJson,
  run,
  sha256File,
  sha256Value,
} from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const has = (name) => args.includes(name);
const valueOptions = new Set([
  "--skin-mask",
  "--nasolabial-mask",
  "--profile",
  "--vision-manifest",
  "--manual-review",
  "--output",
  "--ab-dir",
]);
const positionals = [];
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (valueOptions.has(value)) {
    index += 1;
  } else if (!value.startsWith("--")) {
    positionals.push(value);
  }
}

function fail(message, code = 2) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    error: message,
  }, null, 2));
  process.exit(code);
}

function probe(file, countFrames = false) {
  const invocation = run("ffprobe", [
    "-v", "error",
    ...(countFrames ? ["-count_frames"] : []),
    "-show_streams",
    "-show_format",
    "-show_chapters",
    "-of", "json",
    file,
  ]);
  if (invocation.status !== 0) {
    throw new Error(`ffprobe 失败：${file}\n${invocation.stderr}`);
  }
  const parsed = JSON.parse(invocation.stdout);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error(`媒体没有视频流：${file}`);
  return {
    raw: parsed,
    video,
    audioStreams: parsed.streams?.filter((stream) => stream.codec_type === "audio") ?? [],
    subtitleStreams:
      parsed.streams?.filter((stream) => stream.codec_type === "subtitle") ?? [],
    dataStreams: parsed.streams?.filter((stream) => stream.codec_type === "data") ?? [],
    chapters: parsed.chapters ?? [],
    duration: Number(parsed.format?.duration ?? video.duration),
    frames: Number(video.nb_read_frames ?? video.nb_frames),
  };
}

function rational(value) {
  if (!value || value === "0/0") return null;
  const [numerator, denominator = "1"] = String(value).split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function close(left, right, tolerance) {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= tolerance;
}

function trackingMetrics(manifest, config) {
  const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
  if (frames.length === 0) {
    return {
      status: "fail",
      errors: ["Vision manifest 没有帧记录"],
    };
  }
  const primaryFrames = frames.filter(
    (frame) => frame.beautyMaskApplied === true
      || (
        !Object.hasOwn(frame, "beautyMaskApplied")
        && Number.isInteger(frame.primaryFaceIndex)
        && frame.primaryTrackingStatus !== "ambiguous"
      ),
  ).length;
  const landmarkFrames = frames.filter(
    (frame) => frame.primaryLandmarksAvailable === true
      || frame.faces?.some(
        (face) => face.isPrimary === true && face.landmarksAvailable === true,
      ),
  ).length;
  const ambiguousFrames = frames.filter(
    (frame) => frame.primaryTrackingStatus === "ambiguous",
  ).length;
  const jumps = frames
    .map((frame) => Number(frame.primaryJumpRatio))
    .filter(Number.isFinite);
  const metrics = {
    frameCount: frames.length,
    primaryFaceCoverage: primaryFrames / frames.length,
    landmarkCoverage: landmarkFrames / frames.length,
    ambiguousFrameRatio: ambiguousFrames / frames.length,
    maximumTrackingJumpRatio: jumps.length > 0 ? Math.max(...jumps) : 0,
    sampleFPS: Number(manifest.sampleFPS),
    sourceFPS: Number(manifest.sourceFPS),
  };
  const errors = [];
  if (metrics.primaryFaceCoverage < config.minimumPrimaryFaceCoverage) {
    errors.push(
      `主脸覆盖率 ${metrics.primaryFaceCoverage.toFixed(4)} 低于 `
        + `${config.minimumPrimaryFaceCoverage}`,
    );
  }
  if (metrics.landmarkCoverage < config.minimumLandmarkCoverage) {
    errors.push(
      `关键点覆盖率 ${metrics.landmarkCoverage.toFixed(4)} 低于 `
        + `${config.minimumLandmarkCoverage}`,
    );
  }
  if (metrics.ambiguousFrameRatio > config.maximumAmbiguousFrameRatio) {
    errors.push(
      `主脸歧义帧比例 ${metrics.ambiguousFrameRatio.toFixed(4)} 高于 `
        + `${config.maximumAmbiguousFrameRatio}`,
    );
  }
  if (metrics.maximumTrackingJumpRatio > config.maximumTrackingJumpRatio) {
    errors.push(
      `主脸最大跳变 ${metrics.maximumTrackingJumpRatio.toFixed(4)} 高于 `
        + `${config.maximumTrackingJumpRatio}`,
    );
  }
  if (!close(metrics.sampleFPS, metrics.sourceFPS, 0.01)) {
    errors.push(
      `最终渲染遮罩必须逐帧生成：sampleFPS=${metrics.sampleFPS} `
        + `sourceFPS=${metrics.sourceFPS}`,
    );
  }
  return {
    status: errors.length === 0 ? "pass" : "fail",
    metrics,
    errors,
  };
}

function manualReviewResult(file, requiredFrames, expected) {
  if (!file) {
    return {
      status: "review_required",
      source: null,
      errors: ["缺少人工动态复核记录"],
    };
  }
  const review = readJson(file);
  const errors = [];
  const evidence = [];
  const resolveEvidence = (reference) => path.resolve(
    path.dirname(path.resolve(file)),
    String(reference ?? ""),
  );
  const verifyEvidence = (reference, expectedHash, label) => {
    const resolved = resolveEvidence(reference);
    if (!reference || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      errors.push(`${label}.evidenceRef 文件不存在：${resolved}`);
      return null;
    }
    const actualHash = sha256File(resolved);
    if (!/^[a-f0-9]{64}$/.test(String(expectedHash ?? ""))) {
      errors.push(`${label}.evidenceSha256 必须是 64 位 SHA-256`);
    } else if (actualHash !== expectedHash) {
      errors.push(`${label}.evidenceSha256 与文件不一致`);
    }
    evidence.push({ label, path: resolved, sha256: actualHash });
    return resolved;
  };
  if (review.schemaVersion !== "1.0") {
    errors.push("人工复核 schemaVersion 必须为 1.0");
  }
  if (typeof review.reviewer !== "string" || !review.reviewer.trim()) {
    errors.push("人工复核 reviewer 必须是非空字符串");
  }
  if (
    typeof review.reviewedAt !== "string"
    || !Number.isFinite(Date.parse(review.reviewedAt))
  ) {
    errors.push("人工复核 reviewedAt 必须是有效 ISO 日期");
  }
  if (review.outputSha256 !== expected.outputSha256) {
    errors.push("人工复核 outputSha256 与当前输出不一致");
  }
  if (review.visionManifestSha256 !== expected.visionManifestSha256) {
    errors.push("人工复核 visionManifestSha256 与当前 Vision manifest 不一致");
  }
  if (review.profile !== expected.profile) {
    errors.push(`人工复核 profile 必须为 ${expected.profile}`);
  }
  for (const key of [
    "sameFrameAB",
    "temporalFlickerReviewed",
    "skinNeckContinuityReviewed",
  ]) {
    if (review[key] !== true) errors.push(`人工复核 ${key} 必须为 true`);
  }
  for (const frame of requiredFrames) {
    const item = review.requiredFrames?.[frame];
    if (!item || typeof item !== "object" || item.status !== "pass") {
      errors.push(`人工复核 requiredFrames.${frame}.status 必须为 pass`);
      continue;
    }
    if (
      !Number.isFinite(Number(item.timeSeconds))
      || Number(item.timeSeconds) < 0
      || Number(item.timeSeconds) >= expected.duration
    ) {
      errors.push(`人工复核 requiredFrames.${frame}.timeSeconds 必须有效`);
    }
    verifyEvidence(
      item.evidenceRef,
      item.evidenceSha256,
      `requiredFrames.${frame}`,
    );
  }
  verifyEvidence(
    review.dynamicReviewRef,
    review.dynamicReviewSha256,
    "dynamicReview",
  );
  return {
    status: errors.length === 0 ? "pass" : "fail",
    source: path.resolve(file),
    evidence,
    errors,
  };
}

function extractAB(source, output, duration, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const times = [0.15, 0.5, 0.85].map((ratio) =>
    Math.max(0, duration * ratio));
  const artifacts = [];
  times.forEach((time, index) => {
    const destination = path.join(
      directory,
      `same-frame-ab-${String(index + 1).padStart(2, "0")}.png`,
    );
    const result = run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-ss", time.toFixed(6), "-i", source,
      "-ss", time.toFixed(6), "-i", output,
      "-filter_complex",
      "[0:v]scale=iw/2:ih/2:flags=lanczos[a];"
        + "[1:v]scale=iw/2:ih/2:flags=lanczos[b];"
        + "[a][b]hstack=inputs=2",
      "-frames:v", "1", destination,
    ]);
    if (result.status !== 0) {
      throw new Error(`同帧 A/B 生成失败：${result.stderr}`);
    }
    artifacts.push({
      timeSeconds: time,
      file: destination,
      sha256: sha256File(destination),
    });
  });
  return artifacts;
}

if (positionals.length !== 2) {
  fail(
    "用法：beauty_qc.mjs INPUT OUTPUT --skin-mask FILE "
      + "--nasolabial-mask FILE --vision-manifest FILE "
      + "[--manual-review FILE] [--technical-only] [--ab-dir DIR] "
      + "[--output REPORT.json]",
  );
}
for (const file of [
  positionals[0],
  positionals[1],
  option("--skin-mask"),
  option("--nasolabial-mask"),
  option("--vision-manifest"),
].filter(Boolean)) {
  if (!fs.existsSync(file)) fail(`文件不存在：${file}`);
}
if (!option("--skin-mask") || !option("--nasolabial-mask")) {
  fail("必须提供 --skin-mask 和 --nasolabial-mask");
}
if (!option("--vision-manifest")) {
  fail("必须提供逐帧 Vision manifest");
}

try {
  const {
    config,
    source: configSource,
    implementation,
  } = loadBeautyV2();
  const input = path.resolve(positionals[0]);
  const output = path.resolve(positionals[1]);
  const inputSha256 = sha256File(input);
  const outputSha256 = sha256File(output);
  const visionManifestFile = path.resolve(option("--vision-manifest"));
  const visionManifestSha256 = sha256File(visionManifestFile);
  const profile = option("--profile", "natural");
  if (!config.profiles[profile]) fail(`未知 Beauty v2 档位：${profile}`);
  const inputProbe = probe(input, true);
  const outputProbe = probe(output, true);
  const sourceFPS = rational(
    inputProbe.video.avg_frame_rate || inputProbe.video.r_frame_rate,
  );
  const durationTolerance = sourceFPS ? 1 / sourceFPS + 0.001 : 0.05;
  const technicalErrors = [];
  for (const field of ["width", "height", "sample_aspect_ratio", "field_order"]) {
    if (
      String(inputProbe.video[field] ?? "")
      !== String(outputProbe.video[field] ?? "")
    ) {
      technicalErrors.push(
        `视频字段未保留：${field} source=${inputProbe.video[field]} `
          + `output=${outputProbe.video[field]}`,
      );
    }
  }
  for (const field of [
    "color_range",
    "color_space",
    "color_transfer",
    "color_primaries",
  ]) {
    const sourceValue = inputProbe.video[field];
    const outputValue = outputProbe.video[field];
    if (
      sourceValue
      && !["unknown", "reserved", "unspecified"].includes(sourceValue)
      && sourceValue !== outputValue
    ) {
      technicalErrors.push(
        `色彩元数据未保留：${field} source=${sourceValue} output=${outputValue}`,
      );
    }
  }
  const outputFPS = rational(
    outputProbe.video.avg_frame_rate || outputProbe.video.r_frame_rate,
  );
  if (!close(sourceFPS, outputFPS, 0.001)) {
    technicalErrors.push(`帧率漂移：source=${sourceFPS} output=${outputFPS}`);
  }
  if (!close(inputProbe.duration, outputProbe.duration, durationTolerance)) {
    technicalErrors.push(
      `时长漂移：source=${inputProbe.duration} output=${outputProbe.duration}`,
    );
  }
  if (
    Number.isFinite(inputProbe.frames)
    && Number.isFinite(outputProbe.frames)
    && inputProbe.frames !== outputProbe.frames
  ) {
    technicalErrors.push(
      `帧数漂移：source=${inputProbe.frames} output=${outputProbe.frames}`,
    );
  }
  if (inputProbe.audioStreams.length !== outputProbe.audioStreams.length) {
    technicalErrors.push(
      `音频流数量漂移：source=${inputProbe.audioStreams.length} `
        + `output=${outputProbe.audioStreams.length}`,
    );
  }
  if (inputProbe.subtitleStreams.length !== outputProbe.subtitleStreams.length) {
    technicalErrors.push(
      `字幕流数量漂移：source=${inputProbe.subtitleStreams.length} `
        + `output=${outputProbe.subtitleStreams.length}`,
    );
  }
  if (inputProbe.dataStreams.length !== outputProbe.dataStreams.length) {
    technicalErrors.push(
      `数据流数量漂移：source=${inputProbe.dataStreams.length} `
        + `output=${outputProbe.dataStreams.length}`,
    );
  }
  if (inputProbe.chapters.length !== outputProbe.chapters.length) {
    technicalErrors.push(
      `章节数量漂移：source=${inputProbe.chapters.length} `
        + `output=${outputProbe.chapters.length}`,
    );
  }
  const ignoredMetadata = new Set([
    "major_brand",
    "minor_version",
    "compatible_brands",
    "encoder",
  ]);
  for (const [key, value] of Object.entries(inputProbe.raw.format?.tags ?? {})) {
    if (
      !ignoredMetadata.has(key)
      && String(outputProbe.raw.format?.tags?.[key] ?? "") !== String(value)
    ) {
      technicalErrors.push(`全局元数据未保留：${key}`);
    }
  }
  const visionManifest = readJson(visionManifestFile);
  if (
    typeof visionManifest.input !== "string"
    || !visionManifest.input.trim()
    || path.resolve(visionManifest.input) !== input
  ) {
    technicalErrors.push(
      `Vision manifest 输入不匹配：manifest=${visionManifest.input ?? "<missing>"} `
        + `source=${input}`,
    );
  }
  if (
    !/^[a-f0-9]{64}$/.test(String(visionManifest.sourceSha256 ?? ""))
    || visionManifest.sourceSha256 !== inputSha256
  ) {
    technicalErrors.push("Vision manifest sourceSha256 与当前输入不一致");
  }
  const tracking = trackingMetrics(visionManifest, config.qc);
  technicalErrors.push(...tracking.errors);
  const manual = manualReviewResult(
    option("--manual-review"),
    config.qc.requiredFrames,
    {
      outputSha256,
      visionManifestSha256,
      profile,
      duration: outputProbe.duration,
    },
  );
  const abArtifacts = option("--ab-dir")
    ? extractAB(input, output, inputProbe.duration, path.resolve(option("--ab-dir")))
    : [];
  const technicalStatus = technicalErrors.length === 0 ? "pass" : "fail";
  const status = technicalStatus === "fail"
    ? "fail"
    : manual.status === "pass" && abArtifacts.length >= 3
      ? "pass"
      : has("--technical-only") && manual.status === "review_required"
        ? "pass_with_review"
        : "fail";
  if (
    technicalStatus === "pass"
    && manual.status === "pass"
    && abArtifacts.length < 3
  ) {
    manual.errors.push("正式人工验收必须使用 --ab-dir 生成至少三张同帧 A/B");
    manual.status = "fail";
  }
  const report = {
    schemaVersion: "1.0",
    status,
    technicalStatus,
    manualStatus: manual.status,
    generatedAt: new Date().toISOString(),
    engine: config.id,
    profile,
    configuration: {
      source: configSource,
      digest: sha256Value(config),
    },
    implementation,
    artifacts: {
      input: { path: input, sha256: inputSha256 },
      output: { path: output, sha256: outputSha256 },
      skinMask: {
        path: path.resolve(option("--skin-mask")),
        sha256: sha256File(option("--skin-mask")),
      },
      nasolabialMask: {
        path: path.resolve(option("--nasolabial-mask")),
        sha256: sha256File(option("--nasolabial-mask")),
      },
      visionManifest: {
        path: visionManifestFile,
        sha256: visionManifestSha256,
      },
      sameFrameAB: abArtifacts,
    },
    media: {
      source: {
        width: inputProbe.video.width,
        height: inputProbe.video.height,
        fps: sourceFPS,
        duration: inputProbe.duration,
        frames: inputProbe.frames,
        pixelFormat: inputProbe.video.pix_fmt,
        colorRange: inputProbe.video.color_range,
        colorSpace: inputProbe.video.color_space,
        colorTransfer: inputProbe.video.color_transfer,
        colorPrimaries: inputProbe.video.color_primaries,
        audioStreams: inputProbe.audioStreams.length,
        subtitleStreams: inputProbe.subtitleStreams.length,
        dataStreams: inputProbe.dataStreams.length,
        chapters: inputProbe.chapters.length,
      },
      output: {
        width: outputProbe.video.width,
        height: outputProbe.video.height,
        fps: outputFPS,
        duration: outputProbe.duration,
        frames: outputProbe.frames,
        pixelFormat: outputProbe.video.pix_fmt,
        codec: outputProbe.video.codec_name,
        colorRange: outputProbe.video.color_range,
        colorSpace: outputProbe.video.color_space,
        colorTransfer: outputProbe.video.color_transfer,
        colorPrimaries: outputProbe.video.color_primaries,
        audioStreams: outputProbe.audioStreams.length,
        subtitleStreams: outputProbe.subtitleStreams.length,
        dataStreams: outputProbe.dataStreams.length,
        chapters: outputProbe.chapters.length,
      },
    },
    tracking,
    manualReview: manual,
    errors: [
      ...technicalErrors,
      ...(status === "fail" ? manual.errors : []),
    ],
  };
  const reportFile = option("--output");
  if (reportFile) {
    const destination = path.resolve(reportFile);
    if (fs.existsSync(destination) && !has("--overwrite")) {
      fail(`拒绝覆盖已有报告：${destination}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(status === "fail" ? 1 : 0);
} catch (error) {
  fail(error.message, 1);
}
