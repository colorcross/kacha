#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  mediaSummary,
  run,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

function usage() {
  console.error(
    "用法：normalize_mov_timing.mjs INPUT.mov OUTPUT.mov "
      + "[--fps NUMBER] [--tolerance NUMBER] [--report FILE.json]",
  );
}

const args = process.argv.slice(2);
const input = args[0];
const output = args[1];
const fpsIndex = args.indexOf("--fps");
const toleranceIndex = args.indexOf("--tolerance");
const reportIndex = args.indexOf("--report");
if (
  !input
  || !output
  || (fpsIndex >= 0 && !args[fpsIndex + 1])
  || (toleranceIndex >= 0 && !args[toleranceIndex + 1])
  || (reportIndex >= 0 && !args[reportIndex + 1])
) {
  usage();
  process.exit(2);
}

const inputFile = path.resolve(input);
const outputFile = path.resolve(output);
if (path.extname(inputFile).toLowerCase() !== ".mov"
  || path.extname(outputFile).toLowerCase() !== ".mov") {
  console.error("输入和输出都必须是 .mov");
  process.exit(2);
}
if (!fs.existsSync(inputFile)) {
  console.error(`输入不存在：${inputFile}`);
  process.exit(2);
}
if (fs.existsSync(outputFile) || inputFile === outputFile) {
  console.error("输出必须是尚不存在的独立文件");
  process.exit(2);
}

const before = mediaSummary(inputFile);
const targetFps = fpsIndex >= 0
  ? Number(args[fpsIndex + 1])
  : before.declaredFps;
const tolerance = toleranceIndex >= 0 ? Number(args[toleranceIndex + 1]) : 0.001;
if (!(targetFps > 0) || !(tolerance >= 0)) {
  console.error("--fps 必须为正数，--tolerance 必须不小于 0");
  process.exit(2);
}

const timescale = Math.max(1000, Math.round(targetFps * 1000));
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
const result = run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-nostdin",
  "-y",
  "-i",
  inputFile,
  "-map",
  "0",
  "-c",
  "copy",
  "-video_track_timescale",
  String(timescale),
  "-movflags",
  "+faststart",
  outputFile,
]);
if (result.status !== 0) {
  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  console.error(result.stderr.trim() || "MOV 时间基重封装失败");
  process.exit(1);
}

const after = mediaSummary(outputFile);
const errors = [];
if (before.video?.codec_name !== after.video?.codec_name) {
  errors.push("视频编码发生变化，不能证明为 stream copy");
}
if ((before.audio?.codec_name ?? null) !== (after.audio?.codec_name ?? null)) {
  errors.push("音频编码发生变化，不能证明为 stream copy");
}
if (before.width !== after.width || before.height !== after.height) {
  errors.push("画面尺寸发生变化");
}
const frameTolerance = 1 / targetFps + 0.0005;
if (Math.abs(before.duration - after.duration) > frameTolerance) {
  errors.push("重封装前后时长相差超过一帧");
}
if (Math.abs(after.declaredFps - targetFps) > tolerance) {
  errors.push("输出 declared FPS 不符合目标");
}
if (Math.abs(after.averageFps - targetFps) > tolerance) {
  errors.push("输出 average FPS 不符合目标");
}

const report = {
  schemaVersion: "1.0",
  status: errors.length === 0 ? "pass" : "fail",
  input: inputFile,
  output: outputFile,
  streamCopy: true,
  targetFps,
  tolerance,
  trackTimescale: timescale,
  before: {
    duration: before.duration,
    declaredFps: before.declaredFps,
    averageFps: before.averageFps,
    videoCodec: before.video?.codec_name ?? null,
    audioCodec: before.audio?.codec_name ?? null,
  },
  after: {
    duration: after.duration,
    declaredFps: after.declaredFps,
    averageFps: after.averageFps,
    videoCodec: after.video?.codec_name ?? null,
    audioCodec: after.audio?.codec_name ?? null,
  },
  errors,
};
if (reportIndex >= 0) {
  writeJsonAtomic(path.resolve(args[reportIndex + 1]), report);
}
if (errors.length > 0) {
  fs.unlinkSync(outputFile);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
