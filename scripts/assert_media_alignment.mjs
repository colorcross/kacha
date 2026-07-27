#!/usr/bin/env node

import path from "node:path";
import {
  mediaSummary,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

function usage() {
  console.error(
    "用法：assert_media_alignment.mjs BASE OTHER [OTHER...] "
      + "[--allow-size-mismatch] [--duration-tolerance-frames N] [--output report.json]",
  );
}

const args = process.argv.slice(2);
const files = [];
let allowSizeMismatch = false;
let toleranceFrames = 1;
let output = null;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--allow-size-mismatch") {
    allowSizeMismatch = true;
  } else if (argument === "--duration-tolerance-frames") {
    toleranceFrames = Number(args[index + 1]);
    index += 1;
  } else if (argument === "--output") {
    output = args[index + 1];
    index += 1;
  } else if (argument.startsWith("--")) {
    usage();
    process.exit(2);
  } else {
    files.push(path.resolve(argument));
  }
}
if (
  files.length < 2
  || !Number.isFinite(toleranceFrames)
  || toleranceFrames < 0
) {
  usage();
  process.exit(2);
}

let summaries;
try {
  summaries = files.map(mediaSummary);
} catch (error) {
  console.error(`媒体探测失败：${error.message}`);
  process.exit(2);
}

const base = summaries[0];
const errors = [];
if (!base.video || !(base.fps > 0) || !(base.duration > 0)) {
  errors.push("基准文件缺少有效视频、帧率或时长");
}
const toleranceSeconds = base.fps > 0
  ? toleranceFrames / base.fps + 0.0005
  : 0;

for (const item of summaries.slice(1)) {
  const label = path.basename(item.file);
  if (!item.video) {
    errors.push(`${label}: 缺少视频轨`);
    continue;
  }
  if (
    !allowSizeMismatch
    && (item.width !== base.width || item.height !== base.height)
  ) {
    errors.push(
      `${label}: 尺寸 ${item.width}x${item.height} 与基准 ${base.width}x${base.height} 不一致`,
    );
  }
  if (!(item.fps > 0) || Math.abs(item.fps - base.fps) > 0.001) {
    errors.push(`${label}: 帧率 ${item.fps} 与基准 ${base.fps} 不一致`);
  }
  if (
    !Number.isFinite(item.duration)
    || Math.abs(item.duration - base.duration) > toleranceSeconds
  ) {
    errors.push(
      `${label}: 时长 ${item.duration} 与基准 ${base.duration} 相差超过 ${toleranceFrames} 帧`,
    );
  }
  if (
    Number.isFinite(item.startTime)
    && Number.isFinite(base.startTime)
    && Math.abs(item.startTime - base.startTime) > toleranceSeconds
  ) {
    errors.push(`${label}: 起始 PTS 与基准相差超过 ${toleranceFrames} 帧`);
  }
}

const report = {
  schemaVersion: "2.0",
  status: errors.length === 0 ? "pass" : "fail",
  toleranceFrames,
  toleranceSeconds,
  allowSizeMismatch,
  base: {
    file: base.file,
    width: base.width,
    height: base.height,
    fps: base.fps,
    duration: base.duration,
    startTime: base.startTime,
  },
  compared: summaries.slice(1).map((item) => ({
    file: item.file,
    width: item.width,
    height: item.height,
    fps: item.fps,
    duration: item.duration,
    startTime: item.startTime,
  })),
  errors,
};
if (output) writeJsonAtomic(path.resolve(output), report);

if (errors.length > 0) {
  console.error(`媒体时间线对齐失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
