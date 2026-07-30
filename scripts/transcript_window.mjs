#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readJson, sha256File } from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const action = args[0];
const transcriptInput = args[1];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

if (!["index", "slice"].includes(action) || !transcriptInput) {
  fail(
    "用法：kacha.mjs transcript index TRANSCRIPT.json [--window-seconds 90]\n"
      + "  kacha.mjs transcript slice TRANSCRIPT.json --start SEC --end SEC "
      + "[--review-only] [--include-words]",
    2,
  );
}
const transcriptFile = path.resolve(transcriptInput);
if (!fs.existsSync(transcriptFile) || !fs.statSync(transcriptFile).isFile()) {
  fail(`转写文件不存在：${transcriptFile}`, 2);
}
let transcript;
try {
  transcript = readJson(transcriptFile);
} catch (error) {
  fail(`转写 JSON 无法解析：${error.message}`, 2);
}
const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
const duration = Number(
  transcript.durationSeconds
    ?? segments.at(-1)?.end
    ?? 0,
);
if (!(duration >= 0)) fail("转写 durationSeconds 无效", 2);

if (action === "index") {
  const windowSeconds = Number(option("--window-seconds", "90"));
  if (!Number.isFinite(windowSeconds) || windowSeconds < 15 || windowSeconds > 180) {
    fail("--window-seconds 必须在 15–180 秒之间", 2);
  }
  const windows = [];
  for (let start = 0; start < duration || (duration === 0 && start === 0); start += windowSeconds) {
    const end = duration === 0 ? 0 : Math.min(duration, start + windowSeconds);
    const selected = segments.filter(
      (segment) => Number(segment.end) > start && Number(segment.start) < end,
    );
    windows.push({
      id: `window-${String(windows.length + 1).padStart(4, "0")}`,
      start,
      end,
      segmentCount: selected.length,
      lowConfidenceCount: selected.filter(
        (segment) => segment.confidence === "low"
          || (segment.reasons ?? []).length > 0,
      ).length,
      firstSegmentId: selected[0]?.id ?? null,
      lastSegmentId: selected.at(-1)?.id ?? null,
    });
    if (duration === 0) break;
  }
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    transcript: transcriptFile,
    sha256: sha256File(transcriptFile),
    language: transcript.language ?? null,
    durationSeconds: duration,
    segmentCount: segments.length,
    lowConfidenceCount: segments.filter(
      (segment) => segment.confidence === "low"
        || (segment.reasons ?? []).length > 0,
    ).length,
    windowSeconds,
    windows,
    textIncluded: false,
    wordsIncluded: false,
  }, null, 2));
  process.exit(0);
}

const start = Number(option("--start"));
const end = Number(option("--end"));
if (
  !Number.isFinite(start)
  || !Number.isFinite(end)
  || start < 0
  || end <= start
  || end > duration + 0.001
  || end - start > 180
) {
  fail("slice 必须满足 0 <= start < end <= duration，且单次不超过 180 秒", 2);
}
const reviewOnly = args.includes("--review-only");
const includeWords = args.includes("--include-words");
const selected = segments
  .filter((segment) => Number(segment.end) > start && Number(segment.start) < end)
  .filter((segment) => !reviewOnly
    || segment.confidence === "low"
    || (segment.reasons ?? []).length > 0)
  .map((segment) => ({
    id: segment.id,
    start: Number(segment.start),
    end: Number(segment.end),
    text: String(segment.text ?? ""),
    confidence: segment.confidence ?? "unknown",
    reasons: segment.reasons ?? [],
    ...(includeWords ? { words: segment.words ?? [] } : {}),
  }));
const characters = selected.reduce((sum, segment) => sum + [...segment.text].length, 0);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: "pass",
  transcript: transcriptFile,
  sha256: sha256File(transcriptFile),
  range: { start, end },
  reviewOnly,
  segments: selected,
  segmentCount: selected.length,
  textCharacters: characters,
  approximateTextTokens: Math.ceil(characters / 2.5),
  wordsIncluded: includeWords,
}, null, 2));
