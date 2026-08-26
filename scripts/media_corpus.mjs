#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ffprobe, fileIdentityMatches, mediaIndexDigest, readJson, sha256File, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function flag(name) { return args.includes(name); }
function fail(message, code = 1) {
  console.error(JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2));
  process.exit(code);
}

function tokenize(text) {
  const normalized = String(text ?? "").toLowerCase().normalize("NFKC");
  const rawWords = normalized.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? [];
  const words = [...rawWords, ...rawWords.flatMap((word) => word.split(/[-_]+/))];
  const chinese = [];
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    const chars = [...run];
    chinese.push(...chars);
    for (let index = 0; index + 1 < chars.length; index += 1) chinese.push(chars[index] + chars[index + 1]);
  }
  return [...new Set([...words, ...chinese].filter(Boolean))];
}

function durationFor(item) {
  if (item.range && Number.isFinite(item.range.start) && Number.isFinite(item.range.end)) return Math.max(0, item.range.end - item.range.start);
  return sourceDuration(item.path);
}

function sourceDuration(file) {
  const probe = ffprobe(file);
  return Number(probe.format?.duration ?? probe.streams?.find((stream) => stream.codec_type === "video")?.duration ?? 0);
}

function motionScore(file, start, duration) {
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-ss", String(start), "-t", String(Math.min(duration, 8)), "-i", file,
    "-vf", "fps=2,scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:file=-",
    "-an", "-f", "null", "-"
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  if (result.status !== 0) return { value: null, evidence: "measurement_failed" };
  const values = [...String(result.stdout).matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
  if (values.length === 0) return { value: null, evidence: "measurement_unavailable" };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { value: Number(Math.min(1, mean / 32).toFixed(4)), evidence: "ffmpeg_frame_difference_yavg" };
}

function validateCorpus(value, { requireDigest = true } = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["media corpus root must be an object"];
  if (value.schemaVersion !== "1.0" || value.kind !== "kacha-media-corpus") errors.push("invalid corpus identity");
  if (!Array.isArray(value.clips) || value.clips.length === 0) errors.push("clips must be a non-empty array");
  try {
    const index = readJson(path.resolve(value.mediaIndex?.path ?? ""));
    if (index.digestVersion !== "2" || index.digest !== mediaIndexDigest(index) || index.digest !== value.mediaIndex?.digest) errors.push("media index identity or digest is stale");
  } catch (error) {
    errors.push(`media index unavailable: ${error.message}`);
  }
  const refs = new Set();
  const sourceDurations = new Map();
  for (const clip of value.clips ?? []) {
    if (!clip.ref || refs.has(clip.ref)) errors.push(`duplicate or missing clip ref: ${clip.ref}`);
    refs.add(clip.ref);
    if (!clip.source?.sha256 || !clip.source?.assetRef) errors.push(`${clip.ref}: source identity required`);
    if (!clip.source?.path || !fs.existsSync(clip.source.path) || !fs.statSync(clip.source.path).isFile()) errors.push(`${clip.ref}: source file unavailable`);
    else {
      try {
        if (sha256File(clip.source.path) !== clip.source.sha256) errors.push(`${clip.ref}: source file identity is stale`);
        if (!sourceDurations.has(clip.source.path)) sourceDurations.set(clip.source.path, sourceDuration(clip.source.path));
        if (Number.isFinite(clip.range?.end) && clip.range.end > sourceDurations.get(clip.source.path) + 0.05) errors.push(`${clip.ref}: range exceeds source duration`);
      } catch (error) {
        errors.push(`${clip.ref}: source verification failed: ${error.message}`);
      }
    }
    if (!Number.isFinite(clip.range?.start) || !Number.isFinite(clip.range?.end) || clip.range.end <= clip.range.start) errors.push(`${clip.ref}: invalid range`);
    if (!Array.isArray(clip.terms)) errors.push(`${clip.ref}: terms required`);
    if (!new Set(["measured", "unavailable"]).has(clip.motion?.status)) errors.push(`${clip.ref}: motion status invalid`);
  }
  if (requireDigest && !/^[a-f0-9]{64}$/i.test(value.digest ?? "")) errors.push("corpus digest is required");
  if (value.digest) {
    const expected = sha256Value({ mediaIndex: value.mediaIndex, configuration: value.configuration, privacy: value.privacy, retrievalCapabilities: value.retrievalCapabilities, limitations: value.limitations, clips: value.clips });
    if (value.digest !== expected) errors.push("corpus digest mismatch");
  }
  return errors;
}

function lexicalScore(queryTerms, clip) {
  const terms = new Set(clip.terms);
  if (queryTerms.length === 0) return 0;
  const matches = queryTerms.filter((term) => terms.has(term)).length;
  return matches / Math.sqrt(queryTerms.length * Math.max(1, terms.size));
}

function similarity(left, right) {
  if (left.source.assetRef === right.source.assetRef) {
    const overlap = Math.max(0, Math.min(left.range.end, right.range.end) - Math.max(left.range.start, right.range.start));
    if (overlap > 0) return 1;
  }
  const a = new Set(left.terms);
  const b = new Set(right.terms);
  const intersection = [...a].filter((term) => b.has(term)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function selectMmr(scored, limit, lambda) {
  const remaining = [...scored];
  const selected = [];
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (const [index, candidate] of remaining.entries()) {
      const redundancy = selected.length ? Math.max(...selected.map((entry) => similarity(candidate.clip, entry.clip))) : 0;
      const value = lambda * candidate.relevance - (1 - lambda) * redundancy;
      if (value > bestScore || (value === bestScore && candidate.clip.ref.localeCompare(remaining[bestIndex].clip.ref) < 0)) {
        bestScore = value;
        bestIndex = index;
      }
    }
    const [winner] = remaining.splice(bestIndex, 1);
    selected.push({ ...winner, mmrScore: Number(bestScore.toFixed(6)) });
  }
  return selected;
}

if (!new Set(["build", "search", "validate"]).has(action)) fail("usage: kacha.mjs corpus build|search|validate [options]", 2);

if (action === "build") {
  const indexFile = option("--index") ?? args[1];
  const output = option("--output");
  if (!indexFile || !output) fail("build requires --index and --output", 2);
  const mediaIndex = readJson(path.resolve(indexFile));
  if (mediaIndex.kind !== "kacha_media_index" || mediaIndex.digestVersion !== "2" || !Array.isArray(mediaIndex.items) || mediaIndex.digest !== mediaIndexDigest(mediaIndex)) fail("invalid or stale Kacha media index", 2);
  const clipSeconds = Number(option("--clip-seconds", 8));
  const maximumClips = Number(option("--max-clips", 10000));
  if (!Number.isFinite(clipSeconds) || clipSeconds < 1 || clipSeconds > 600) fail("--clip-seconds must be 1..600", 2);
  if (!Number.isInteger(maximumClips) || maximumClips < 1 || maximumClips > 100000) fail("--max-clips must be 1..100000", 2);
  const clips = [];
  let truncated = false;
  const itemRefs = new Set();
  for (const item of mediaIndex.items.filter((entry) => entry.kind === "video")) {
    if (!item.ref || itemRefs.has(item.ref)) fail(`media index has duplicate or missing video ref: ${item.ref}`, 2);
    itemRefs.add(item.ref);
    if (!item.path || !item.identity?.sha256 || !fileIdentityMatches(item.path, item.identity)) fail(`media index is stale for ${item.ref}; rebuild it before corpus generation`, 2);
    const baseStart = Number(item.range?.start ?? 0);
    const fullDuration = sourceDuration(item.path);
    if (!Number.isFinite(baseStart) || baseStart < 0 || !Number.isFinite(fullDuration) || fullDuration <= 0) fail(`invalid video duration or range for ${item.ref}`, 2);
    if (item.range && (!Number.isFinite(item.range.end) || item.range.end <= baseStart || item.range.end > fullDuration + 0.05)) fail(`media index range exceeds the current source for ${item.ref}`, 2);
    const duration = durationFor(item);
    if (!(duration > 0)) continue;
    const parts = item.range ? 1 : Math.ceil(duration / clipSeconds);
    for (let index = 0; index < parts; index += 1) {
      if (clips.length >= maximumClips) { truncated = true; break; }
      const start = baseStart + index * clipSeconds;
      const end = item.range?.end ?? Math.min(duration, (index + 1) * clipSeconds);
      if (end <= start) continue;
      const text = Object.values(item.fields ?? {}).join(" ");
      const measured = flag("--measure-motion") ? motionScore(item.path, start, end - start) : { value: null, evidence: "not_requested" };
      const id = `${item.id}-c${String(index + 1).padStart(4, "0")}`;
      clips.push({
        id,
        ref: `@clip:${id}`,
        source: { assetRef: item.ref, path: item.path, sha256: item.identity?.sha256, license: item.license, provenance: item.provenance },
        range: { start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) },
        terms: tokenize(text),
        textEvidence: item.semanticEvidence ?? [],
        motion: { status: measured.value === null ? "unavailable" : "measured", score: measured.value, evidence: measured.evidence }
      });
    }
    if (truncated) break;
  }
  if (clips.length === 0) fail("media index contains no eligible video clips", 2);
  const value = {
    schemaVersion: "1.0",
    kind: "kacha-media-corpus",
    status: truncated ? "limited" : "pass",
    generatedAt: new Date().toISOString(),
    mediaIndex: { path: path.resolve(indexFile), digest: mediaIndex.digest },
    configuration: { clipSeconds, maximumClips, motionMeasurement: flag("--measure-motion") },
    privacy: { localOnly: true, externalUpload: false },
    retrievalCapabilities: { embeddings: false, keyword: true, mmrDiversity: true },
    limitations: [
      "No visual-semantic embedding is claimed; search falls back to indexed text evidence.",
      ...(!flag("--measure-motion") ? ["Motion measurement was not requested and is unavailable."] : []),
      ...(truncated ? [`Corpus truncated at ${maximumClips} clips.`] : [])
    ],
    clips
  };
  const errors = validateCorpus(value, { requireDigest: false });
  if (errors.length > 0) fail(errors.join("; "));
  value.digest = sha256Value({ mediaIndex: value.mediaIndex, configuration: value.configuration, privacy: value.privacy, retrievalCapabilities: value.retrievalCapabilities, limitations: value.limitations, clips });
  writeJsonAtomic(output, value);
  console.log(JSON.stringify({ schemaVersion: "1.0", status: value.status, output: path.resolve(output), clips: clips.length, motionMeasured: clips.filter((clip) => clip.motion.status === "measured").length, digest: value.digest, limitations: value.limitations }, null, 2));
  process.exit(0);
}

const input = option("--input") ?? args[1];
if (!input) fail(`${action} requires --input`, 2);
const corpus = readJson(path.resolve(input));
const errors = validateCorpus(corpus);
if (errors.length > 0) fail(errors.join("; "));
if (action === "validate") {
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", input: path.resolve(input), clips: corpus.clips.length, digest: sha256Value(corpus) }, null, 2));
  process.exit(0);
}

const query = option("--query");
const limit = Number(option("--limit", 8));
const lambda = Number(option("--lambda", 0.72));
if (!query || !Number.isInteger(limit) || limit < 1 || limit > 100) fail("search requires --query and --limit 1..100", 2);
if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) fail("--lambda must be 0..1", 2);
const queryTerms = tokenize(query);
if (queryTerms.length === 0) fail("--query must contain searchable letters, numbers or Chinese characters", 2);
const minimumMotion = option("--min-motion") === null ? null : Number(option("--min-motion"));
if (minimumMotion !== null && (!Number.isFinite(minimumMotion) || minimumMotion < 0 || minimumMotion > 1)) fail("--min-motion must be 0..1", 2);
const eligible = corpus.clips.filter((clip) => {
  if (minimumMotion === null) return true;
  return clip.motion.status === "measured" && clip.motion.score >= minimumMotion;
});
const scored = eligible.map((clip) => ({ clip, relevance: Number(lexicalScore(queryTerms, clip).toFixed(6)) })).filter((entry) => entry.relevance > 0).sort((a, b) => b.relevance - a.relevance || a.clip.ref.localeCompare(b.clip.ref));
const selected = selectMmr(scored, limit, lambda);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  kind: "kacha-corpus-search",
  status: "pass",
  query,
  retrievalMode: "keyword_fallback",
  limitations: ["No compatible embedding evidence was present; result relevance is lexical and must not be described as visual-semantic understanding."],
  diversity: { method: "MMR", lambda },
  filters: { minimumMotion, motionUnavailableExcluded: minimumMotion !== null },
  results: selected.map(({ clip, relevance, mmrScore }) => ({ ref: clip.ref, source: clip.source, range: clip.range, relevance, mmrScore, motion: clip.motion, textEvidence: clip.textEvidence }))
}, null, 2));
