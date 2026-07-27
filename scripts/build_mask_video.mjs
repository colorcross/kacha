#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mediaSummary,
  readJson,
  resolveFrom,
  run,
} from "./kacha_utils.mjs";

function usage() {
  console.error(
    "用法：build_mask_video.mjs <manifest.json> <person|face> <output.mkv>",
  );
}

function quoteConcatPath(file) {
  return `'${file.replaceAll("'", "'\\''")}'`;
}

const [, , manifestInput, kind, outputInput] = process.argv;
if (!manifestInput || !["person", "face"].includes(kind) || !outputInput) {
  usage();
  process.exit(2);
}

const manifestFile = path.resolve(manifestInput);
const outputFile = path.resolve(outputInput);
if (path.extname(outputFile).toLowerCase() !== ".mkv") {
  console.error("蒙版视频必须输出为 .mkv，以使用无损 FFV1 灰度编码");
  process.exit(2);
}
if (fs.existsSync(outputFile)) {
  console.error(`拒绝覆盖已有蒙版视频：${outputFile}`);
  process.exit(2);
}

let manifest;
try {
  manifest = readJson(manifestFile);
} catch (error) {
  console.error(`无法读取 manifest：${error.message}`);
  process.exit(2);
}

const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
const sourceFPS = Number(manifest.sourceFPS);
const sourceWidth = Number(manifest.sourceWidth);
const sourceHeight = Number(manifest.sourceHeight);
let sourceDuration = Number(manifest.sourceDuration);
const sourceFile = resolveFrom(manifestFile, manifest.input);

if (
  frames.length === 0
  || !(sourceFPS > 0)
  || !(sourceWidth > 0)
  || !(sourceHeight > 0)
) {
  console.error("manifest 缺少有效 frames/sourceFPS/sourceWidth/sourceHeight");
  process.exit(2);
}
if (!(sourceDuration > 0) && sourceFile && fs.existsSync(sourceFile)) {
  sourceDuration = mediaSummary(sourceFile).duration;
}
if (!(sourceDuration > 0)) {
  console.error("manifest 缺少 sourceDuration，且无法从 input 探测");
  process.exit(2);
}

const field = kind === "person" ? "personMask" : "faceMask";
const entries = [];
let previousTime = -Infinity;
for (let index = 0; index < frames.length; index += 1) {
  const frame = frames[index];
  const time = Number(frame.timeSeconds);
  if (!Number.isFinite(time) || time < 0 || time <= previousTime) {
    console.error(`frames[${index}].timeSeconds 必须严格递增且不小于 0`);
    process.exit(1);
  }
  const image = resolveFrom(manifestFile, frame[field]);
  if (!image || !fs.existsSync(image) || !fs.statSync(image).isFile()) {
    console.error(`frames[${index}].${field} 文件不存在：${image ?? frame[field]}`);
    process.exit(1);
  }
  entries.push({ time, image });
  previousTime = time;
}

const frameDuration = 1 / sourceFPS;
if (entries[0].time > 0.001) {
  console.error("首张蒙版没有覆盖源视频起点，拒绝使用隐式黑帧或末帧复制补齐");
  process.exit(1);
}
if (entries.at(-1).time >= sourceDuration) {
  console.error("最后一张蒙版时间不得达到或超过源视频时长");
  process.exit(1);
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-mask-"));
const concatFile = path.join(temporaryDirectory, "mask.ffconcat");
try {
  const lines = ["ffconcat version 1.0"];
  entries.forEach((entry, index) => {
    const nextTime = index + 1 < entries.length
      ? entries[index + 1].time
      : sourceDuration;
    const duration = nextTime - entry.time;
    if (!(duration > 0)) {
      throw new Error(`frames[${index}] 的持续时间无效`);
    }
    lines.push(`file ${quoteConcatPath(entry.image)}`);
    lines.push(`duration ${duration.toFixed(9)}`);
  });
  lines.push(`file ${quoteConcatPath(entries.at(-1).image)}`);
  fs.writeFileSync(concatFile, `${lines.join("\n")}\n`);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  const result = run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-vf",
    `scale=${sourceWidth}:${sourceHeight}:flags=bilinear,fps=${sourceFPS},format=gray`,
    "-t",
    sourceDuration.toFixed(9),
    "-an",
    "-c:v",
    "ffv1",
    "-level",
    "3",
    "-pix_fmt",
    "gray",
    outputFile,
  ]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "ffmpeg 蒙版编码失败");
  }
} catch (error) {
  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);

const maskSummary = mediaSummary(outputFile);
const tolerance = 1 / sourceFPS + 0.0005;
const errors = [];
if (
  maskSummary.width !== sourceWidth
  || maskSummary.height !== sourceHeight
) {
  errors.push("输出蒙版尺寸与源视频不一致");
}
if (Math.abs(maskSummary.fps - sourceFPS) > 0.001) {
  errors.push("输出蒙版帧率与源视频不一致");
}
if (Math.abs(maskSummary.duration - sourceDuration) > tolerance) {
  errors.push("输出蒙版时长与源视频相差超过一帧");
}
if (errors.length > 0) {
  fs.unlinkSync(outputFile);
  errors.forEach((error) => console.error(error));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      manifest: manifestFile,
      kind,
      output: outputFile,
      width: maskSummary.width,
      height: maskSummary.height,
      fps: maskSummary.fps,
      duration: maskSummary.duration,
    },
    null,
    2,
  ),
);
