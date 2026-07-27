#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  parseRatio,
  readJson,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

function fail(message) {
  console.error(message);
  process.exit(2);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseAnchor(value) {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) fail("--subject-anchor 必须形如 0.50,0.35，坐标范围为 0–1");
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
    fail("--subject-anchor 坐标必须在 0–1 之间");
  }
  return { x, y };
}

function faceGeometry(face) {
  const x = Number(face.x);
  const y = Number(face.y);
  const width = Number(face.width);
  const height = Number(face.height);
  return {
    face,
    x,
    y,
    width,
    height,
    area: width * height,
    centerX: x + width / 2,
    centerYTop: 1 - (y + height / 2),
  };
}

function reliableFaces(faces, confidenceFloor) {
  return (Array.isArray(faces) ? faces : [])
    .filter((face) => {
      return Number(face.confidence) >= confidenceFloor
        && Number(face.width) > 0
        && Number(face.height) > 0;
    })
    .map(faceGeometry);
}

function distanceToAnchor(face, anchor) {
  return Math.hypot(face.centerX - anchor.x, face.centerYTop - anchor.y);
}

function trackingCost(face, previousFace) {
  const distance = Math.hypot(
    face.centerX - previousFace.centerX,
    face.centerYTop - previousFace.centerYTop,
  );
  const areaPenalty = Math.abs(Math.log(face.area / previousFace.area)) * 0.18;
  return distance + areaPenalty;
}

const args = process.argv.slice(2);
const positional = [];
let subjectAnchor = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--subject-anchor") {
    subjectAnchor = parseAnchor(args[index + 1]);
    index += 1;
  } else if (args[index].startsWith("--")) {
    fail(`未知参数：${args[index]}`);
  } else {
    positional.push(args[index]);
  }
}
if (positional.length !== 3) {
  fail(
    "用法：plan_subject_reframe.mjs <vision-manifest.json> <target_aspect> "
      + "<output.json> [--subject-anchor x,y]",
  );
}

const [input, aspectInput, outputInput] = positional;
const inputFile = path.resolve(input);
const outputFile = path.resolve(outputInput);
let manifest;
try {
  manifest = readJson(inputFile);
} catch (error) {
  fail(`无法读取 Vision manifest：${error.message}`);
}
const targetAspect = parseRatio(aspectInput);
if (!targetAspect) fail("target_aspect 必须是两个正数，例如 9:16、3:4、4:3 或 16:9");

const sourceWidth = Number(manifest.sourceWidth);
const sourceHeight = Number(manifest.sourceHeight);
const sampleFPS = Number(manifest.sampleFPS);
const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
if (!(sourceWidth > 0 && sourceHeight > 0 && sampleFPS > 0 && frames.length > 0)) {
  fail("manifest 缺少有效 sourceWidth/sourceHeight/sampleFPS/frames");
}

let previousFrameTime = -Infinity;
frames.forEach((frame, index) => {
  if (
    !Number.isFinite(Number(frame.timeSeconds))
    || Number(frame.timeSeconds) <= previousFrameTime
  ) {
    fail(`frames[${index}].timeSeconds 必须严格递增`);
  }
  previousFrameTime = Number(frame.timeSeconds);
});

const sourceAspect = sourceWidth / sourceHeight;
const cropWidth = sourceAspect >= targetAspect.value
  ? sourceHeight * targetAspect.value
  : sourceWidth;
const cropHeight = sourceAspect >= targetAspect.value
  ? sourceHeight
  : sourceWidth / targetAspect.value;
const halfW = cropWidth / 2;
const halfH = cropHeight / 2;
const confidenceFloor = 0.35;
const smoothingPerNominalFrame = 0.22;
const maxTravelPerSecond = cropWidth * 0.55;
const lowerBodyBias = cropHeight * 0.18;
const maximumTrackingCost = 0.32;
const ambiguityMargin = 0.055;
const maximumCarrySeconds = 0.75;
const defaultCenter = { x: sourceWidth / 2, y: sourceHeight / 2 };

let previousCropCenter = { ...defaultCenter };
let trackedFace = null;
let lastAcceptedFaceTime = null;
let detected = 0;
let fallback = 0;
let lowConfidence = 0;
let multiFaceFrames = 0;
let ambiguousFrames = 0;
let subjectSwitchRisks = 0;
let maximumGapSeconds = 0;
let currentGapSeconds = 0;
let priorTime = Number(frames[0].timeSeconds);

const keyframes = frames.map((frame, index) => {
  const time = Number(frame.timeSeconds);
  const dt = index === 0
    ? 1 / sampleFPS
    : Math.max(1 / (sampleFPS * 4), time - priorTime);
  priorTime = time;
  const faces = reliableFaces(frame.faces, confidenceFloor);
  if (faces.length > 1) multiFaceFrames += 1;
  if (Array.isArray(frame.faces) && frame.faces.length > 0 && faces.length === 0) {
    lowConfidence += 1;
  }

  let selected = null;
  let trackingState = "carry_forward";
  let trackingCostValue = null;
  let ambiguous = false;

  if (!trackedFace && faces.length > 0) {
    if (subjectAnchor) {
      const ranked = faces
        .map((face) => ({ face, cost: distanceToAnchor(face, subjectAnchor) }))
        .sort((left, right) => left.cost - right.cost);
      selected = ranked[0].face;
      trackingCostValue = ranked[0].cost;
      ambiguous = ranked.length > 1
        && ranked[1].cost - ranked[0].cost < ambiguityMargin;
      trackingState = "anchor_lock";
    } else {
      const ranked = [...faces].sort((left, right) => right.area - left.area);
      selected = ranked[0];
      ambiguous = ranked.length > 1;
      trackingState = "initial_largest_face";
    }
  } else if (trackedFace && faces.length > 0) {
    const ranked = faces
      .map((face) => ({ face, cost: trackingCost(face, trackedFace) }))
      .sort((left, right) => left.cost - right.cost);
    trackingCostValue = ranked[0].cost;
    ambiguous = ranked.length > 1
      && ranked[1].cost - ranked[0].cost < ambiguityMargin;
    if (ranked[0].cost <= maximumTrackingCost && !ambiguous) {
      selected = ranked[0].face;
      trackingState = "identity_track";
    } else {
      subjectSwitchRisks += 1;
      trackingState = ambiguous ? "ambiguous_subject" : "subject_jump_rejected";
    }
  }

  if (ambiguous) ambiguousFrames += 1;
  let requested = { ...previousCropCenter };
  let confidence = 0;
  if (selected) {
    trackedFace = selected;
    lastAcceptedFaceTime = time;
    detected += 1;
    currentGapSeconds = 0;
    confidence = Number(selected.face.confidence);
    requested = {
      x: selected.centerX * sourceWidth,
      y: selected.centerYTop * sourceHeight + lowerBodyBias,
    };
  } else {
    fallback += 1;
    currentGapSeconds += dt;
    maximumGapSeconds = Math.max(maximumGapSeconds, currentGapSeconds);
    if (
      lastAcceptedFaceTime !== null
      && time - lastAcceptedFaceTime > maximumCarrySeconds
    ) {
      trackingState = "manual_fallback_required";
    }
  }

  requested.x = clamp(requested.x, halfW, sourceWidth - halfW);
  requested.y = clamp(requested.y, halfH, sourceHeight - halfH);
  const smoothing = 1 - (1 - smoothingPerNominalFrame) ** (dt * sampleFPS);
  let next = {
    x: previousCropCenter.x + (requested.x - previousCropCenter.x) * smoothing,
    y: previousCropCenter.y + (requested.y - previousCropCenter.y) * smoothing,
  };
  const dx = next.x - previousCropCenter.x;
  const dy = next.y - previousCropCenter.y;
  const distance = Math.hypot(dx, dy);
  const maxTravel = maxTravelPerSecond * dt;
  if (distance > maxTravel) {
    const scale = maxTravel / distance;
    next = {
      x: previousCropCenter.x + dx * scale,
      y: previousCropCenter.y + dy * scale,
    };
  }
  next.x = clamp(next.x, halfW, sourceWidth - halfW);
  next.y = clamp(next.y, halfH, sourceHeight - halfH);
  previousCropCenter = next;

  return {
    timeSeconds: time,
    crop: {
      x: Math.round(next.x - halfW),
      y: Math.round(next.y - halfH),
      width: Math.round(cropWidth),
      height: Math.round(cropHeight),
    },
    trackingState,
    confidence,
    reliableFaceCount: faces.length,
    ambiguous,
    trackingCost: trackingCostValue === null
      ? null
      : Number(trackingCostValue.toFixed(5)),
  };
});

const detectionRate = detected / frames.length;
const manualReasons = [];
if (detectionRate < 0.9) manualReasons.push("subject detection rate below 90%");
if (multiFaceFrames > 0 && !subjectAnchor) {
  manualReasons.push("multiple faces detected without an explicit subject anchor");
}
if (ambiguousFrames > 0) manualReasons.push("ambiguous face association");
if (subjectSwitchRisks > 0) manualReasons.push("possible subject jump rejected");
if (maximumGapSeconds > maximumCarrySeconds) {
  manualReasons.push("subject missing longer than carry-forward limit");
}

const result = {
  schemaVersion: "2.0",
  sourceManifest: inputFile,
  targetAspect: aspectInput,
  sourceSize: { width: sourceWidth, height: sourceHeight },
  cropSize: { width: Math.round(cropWidth), height: Math.round(cropHeight) },
  sampleFPS,
  policy: {
    subjectLockMode: subjectAnchor ? "explicit_anchor" : "initial_largest_face",
    subjectAnchor,
    confidenceFloor,
    smoothingPerNominalFrame,
    maxTravelPerSecondPixels: Math.round(maxTravelPerSecond),
    lowerBodyBiasPixels: Math.round(lowerBodyBias),
    maximumTrackingCost,
    ambiguityMargin,
    maximumCarrySeconds,
  },
  summary: {
    frames: frames.length,
    detected,
    fallback,
    lowConfidence,
    multiFaceFrames,
    ambiguousFrames,
    subjectSwitchRisks,
    maximumGapSeconds: Number(maximumGapSeconds.toFixed(4)),
    detectionRate: Number(detectionRate.toFixed(4)),
    disposition: manualReasons.length === 0
      ? "candidate_for_preview"
      : "manual_keyframes_or_safe_fallback_required",
    manualReasons,
  },
  keyframes,
  qcRequired: [
    "手机尺寸检查头顶、眼睛、手势、证据物和字幕安全区",
    "检查多人、遮挡、快速转头、进入和退出画面的区间",
    "检查裁切轨迹是否突然横跳或持续追脸造成眩晕",
    "自动结果只可作为预览候选；正式渲染仍需人工确认主体身份",
  ],
};

writeJsonAtomic(outputFile, result);
console.log(
  JSON.stringify(
    {
      status: "pass",
      output: outputFile,
      targetAspect: aspectInput,
      detectionRate: result.summary.detectionRate,
      disposition: result.summary.disposition,
      manualReasons,
    },
    null,
    2,
  ),
);
