#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  mediaSummary,
  readJson,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const input = args.find((item) => !item.startsWith("--"));
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

if (!input || !option("--output")) {
  console.error(
    "用法：kacha.mjs connections VIDEO --output connection-candidates.json "
      + "[--threshold 0.32] [--cut-list cuts.json]",
  );
  process.exit(2);
}

const inputFile = path.resolve(input);
const outputFile = path.resolve(option("--output"));
if (!fs.existsSync(inputFile) || !fs.statSync(inputFile).isFile()) {
  console.error(`输入视频不存在：${inputFile}`);
  process.exit(1);
}
const threshold = Number(option("--threshold", 0.32));
if (!Number.isFinite(threshold) || threshold < 0.05 || threshold > 0.95) {
  console.error("--threshold 必须在 0.05–0.95 之间");
  process.exit(2);
}

const probe = mediaSummary(inputFile);
const fps = Number(probe.fps || 25);
if (!(fps > 0)) {
  console.error("无法取得有效帧率");
  process.exit(1);
}

const scene = spawnSync("ffmpeg", [
  "-hide_banner", "-nostats", "-i", inputFile,
  "-vf", `select='gt(scene,${threshold})',metadata=print`,
  "-an", "-f", "null", "-",
], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (scene.status !== 0) {
  console.error(scene.stderr || "FFmpeg 场景候选扫描失败");
  process.exit(1);
}

const detected = [];
let pendingTime = null;
for (const line of scene.stderr.split(/\r?\n/)) {
  const timeMatch = /pts_time:([0-9.]+)/.exec(line);
  if (timeMatch) pendingTime = Number(timeMatch[1]);
  const scoreMatch = /lavfi\.scene_score=([0-9.]+)/.exec(line);
  if (scoreMatch && Number.isFinite(pendingTime)) {
    detected.push({
      timeSeconds: pendingTime,
      frame: Math.round(pendingTime * fps),
      score: Number(scoreMatch[1]),
      sources: ["ffmpeg_scene_score"],
    });
    pendingTime = null;
  }
}

const cutListFile = option("--cut-list");
if (cutListFile) {
  const cutList = readJson(path.resolve(cutListFile));
  const values = Array.isArray(cutList)
    ? cutList
    : Array.isArray(cutList.cuts)
      ? cutList.cuts
      : [];
  for (const item of values) {
    const time = Number(
      typeof item === "number"
        ? item
        : item.timeSeconds ?? item.time ?? item.outputTimeSeconds,
    );
    if (Number.isFinite(time) && time > 0 && time < Number(probe.duration)) {
      detected.push({
        timeSeconds: time,
        frame: Math.round(time * fps),
        score: null,
        sources: ["edit_timeline"],
      });
    }
  }
}

detected.sort((left, right) => left.frame - right.frame);
const candidates = [];
for (const item of detected) {
  const previous = candidates.at(-1);
  if (previous && Math.abs(previous.frame - item.frame) <= 2) {
    previous.sources = [...new Set([...previous.sources, ...item.sources])];
    previous.score = Math.max(previous.score ?? 0, item.score ?? 0) || null;
    continue;
  }
  candidates.push({ ...item });
}
candidates.forEach((item, index) => {
  item.id = `J${String(index + 1).padStart(4, "0")}`;
  item.handleStartSeconds = Math.max(0, item.timeSeconds - 1);
  item.handleEndSeconds = Math.min(Number(probe.duration), item.timeSeconds + 1);
  item.reviewRequired = true;
});

const adaptiveDetector = spawnSync("scenedetect", ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const report = {
  schemaVersion: "1.0",
  status: "candidates_require_review",
  input: {
    path: inputFile,
    sha256: sha256File(inputFile),
    durationSeconds: Number(probe.duration),
    fps,
  },
  detection: {
    method: cutListFile
      ? "edit_timeline_union_ffmpeg_scene_score"
      : "ffmpeg_scene_score",
    threshold,
    optionalPySceneDetectAdaptiveAvailable: adaptiveDetector.status === 0,
    note:
      "像素变化只能补充候选；最终连接清单必须与编辑时间线边界合并，并逐点正常速度检查。",
  },
  count: candidates.length,
  candidates,
};
writeJsonAtomic(outputFile, report);
console.log(JSON.stringify({
  status: report.status,
  output: outputFile,
  count: candidates.length,
  method: report.detection.method,
}, null, 2));
