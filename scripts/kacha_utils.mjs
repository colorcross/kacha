#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function hasValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return value !== undefined && value !== null;
}

export function asArray(value) {
  return Array.isArray(value) ? value : hasValue(value) ? [value] : [];
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJsonAtomic(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, resolved);
}

export function resolveFrom(ownerFile, candidate) {
  if (!hasValue(candidate)) return null;
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(path.dirname(path.resolve(ownerFile)), candidate);
}

export function sha256File(file) {
  const digest = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes > 0) digest.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

export function parseTimecode(value, fps = null) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  let match = /^(\d{1,3}):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/.exec(text);
  if (match) {
    const [, hours, minutes, seconds, fraction = ""] = match;
    const fractional = fraction.length > 0
      ? Number(`0.${fraction}`)
      : 0;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + fractional;
  }

  match = /^(\d{1,3}):([0-5]\d):([0-5]\d):(\d{1,3})$/.exec(text);
  if (match && Number.isFinite(fps) && fps > 0) {
    const [, hours, minutes, seconds, frames] = match;
    if (Number(frames) >= fps) return null;
    return Number(hours) * 3600
      + Number(minutes) * 60
      + Number(seconds)
      + Number(frames) / fps;
  }
  return null;
}

export function parseRatio(value) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value ?? "");
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0 && height > 0)) return null;
  return {
    width,
    height,
    value: width / height,
    normalized: `${width}:${height}`,
  };
}

export function rationalToNumber(value) {
  if (Number.isFinite(value)) return Number(value);
  if (typeof value !== "string") return NaN;
  if (!value.includes("/")) return Number(value);
  const [numerator, denominator] = value.split("/").map(Number);
  return denominator ? numerator / denominator : NaN;
}

export function commandExists(command) {
  const result = spawnSync("/usr/bin/env", ["bash", "-lc", `command -v "${command}"`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return result;
}

export function ffprobe(file) {
  const result = run("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    file,
  ]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `ffprobe failed for ${file}`);
  }
  return JSON.parse(result.stdout);
}

export function mediaSummary(file) {
  const probe = ffprobe(file);
  const video = probe.streams?.find((stream) => stream.codec_type === "video") ?? null;
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio") ?? null;
  const formatDuration = Number(probe.format?.duration);
  const videoDuration = Number(video?.duration);
  const audioDuration = Number(audio?.duration);
  const duration = Number.isFinite(formatDuration)
    ? formatDuration
    : Number.isFinite(videoDuration)
      ? videoDuration
      : audioDuration;
  return {
    file: path.resolve(file),
    probe,
    video,
    audio,
    duration,
    videoDuration: Number.isFinite(videoDuration) ? videoDuration : duration,
    audioDuration: Number.isFinite(audioDuration) ? audioDuration : duration,
    fps: rationalToNumber(video?.avg_frame_rate || video?.r_frame_rate),
    averageFps: rationalToNumber(video?.avg_frame_rate),
    declaredFps: rationalToNumber(video?.r_frame_rate),
    width: Number(video?.width),
    height: Number(video?.height),
    sampleRate: Number(audio?.sample_rate),
    channels: Number(audio?.channels),
    channelLayout: audio?.channel_layout ?? null,
    startTime: Number(probe.format?.start_time ?? 0),
  };
}

export function daysBetween(dateText, now = new Date()) {
  if (typeof dateText !== "string") return NaN;
  const timestamp = Date.parse(`${dateText}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return NaN;
  return Math.floor((now.getTime() - timestamp) / 86_400_000);
}

export function unique(values) {
  return [...new Set(values)];
}
