#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ffprobe,
  fileIdentity,
  fileIdentityMatches,
  run,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const MAX_ANALYSIS_SECONDS = 2 * 60 * 60;
const AUDIO_SAMPLE_RATE = 2000;
const ENVELOPE_HZ = 20;

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

function mediaDuration(probe) {
  const candidates = [probe.format?.duration, ...(probe.streams ?? []).map((stream) => stream.duration)]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

function topSeparated(points, { limit, minimumGapSeconds }) {
  const selected = [];
  for (const point of [...points].sort((left, right) => right.strength - left.strength || left.timeSeconds - right.timeSeconds)) {
    if (selected.every((entry) => Math.abs(entry.timeSeconds - point.timeSeconds) >= minimumGapSeconds)) {
      selected.push(point);
      if (selected.length >= limit) break;
    }
  }
  return selected.sort((left, right) => left.timeSeconds - right.timeSeconds);
}

function analyzeAudio(file, durationSeconds, maxEvents) {
  const boundedDuration = Math.min(durationSeconds || MAX_ANALYSIS_SECONDS, MAX_ANALYSIS_SECONDS);
  const result = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", file,
    "-t", String(boundedDuration), "-vn", "-ac", "1", "-ar", String(AUDIO_SAMPLE_RATE),
    "-f", "s16le", "pipe:1",
  ], { encoding: null, maxBuffer: 32 * 1024 * 1024, timeout: 45_000 });
  if (result.status !== 0) {
    const message = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr);
    if (/does not contain any stream|matches no streams|Output file #0 does not contain/.test(message)) {
      return { available: false, reason: "no-audio-stream", energyEnvelope: [], onsetCandidates: [], dropCandidates: [], bpmCandidates: [] };
    }
    throw new Error(message.trim() || "ffmpeg audio rhythm decode failed");
  }
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout, "binary");
  const samplesPerWindow = Math.round(AUDIO_SAMPLE_RATE / ENVELOPE_HZ);
  const envelope = [];
  for (let offset = 0; offset + samplesPerWindow * 2 <= bytes.length; offset += samplesPerWindow * 2) {
    let energy = 0;
    for (let index = 0; index < samplesPerWindow; index += 1) {
      const sample = bytes.readInt16LE(offset + index * 2) / 32768;
      energy += sample * sample;
    }
    envelope.push(Math.sqrt(energy / samplesPerWindow));
  }
  if (!envelope.length) return { available: false, reason: "empty-audio-decode", energyEnvelope: [], onsetCandidates: [], dropCandidates: [], bpmCandidates: [] };
  const mean = envelope.reduce((sum, value) => sum + value, 0) / envelope.length;
  const variance = envelope.reduce((sum, value) => sum + (value - mean) ** 2, 0) / envelope.length;
  const deviation = Math.sqrt(variance);
  const derivatives = envelope.map((value, index) => index === 0 ? 0 : value - envelope[index - 1]);
  const positive = derivatives.filter((value) => value > 0);
  const positiveMean = positive.length ? positive.reduce((sum, value) => sum + value, 0) / positive.length : 0;
  const positiveVariance = positive.length ? positive.reduce((sum, value) => sum + (value - positiveMean) ** 2, 0) / positive.length : 0;
  const onsetThreshold = positiveMean + Math.sqrt(positiveVariance) * 1.25;
  const onsetCandidates = topSeparated(derivatives.flatMap((value, index) => (
    value >= onsetThreshold && value > 0
      ? [{ timeSeconds: round(index / ENVELOPE_HZ, 3), strength: round(value / Math.max(deviation, 1e-9)) }]
      : []
  )), { limit: maxEvents, minimumGapSeconds: 0.12 });
  const dropCandidates = topSeparated(derivatives.flatMap((value, index) => (
    -value >= onsetThreshold && value < 0
      ? [{ timeSeconds: round(index / ENVELOPE_HZ, 3), strength: round((-value) / Math.max(deviation, 1e-9)) }]
      : []
  )), { limit: Math.min(maxEvents, 100), minimumGapSeconds: 0.25 });
  const centered = envelope.map((value) => value - mean);
  const bpmCandidates = [];
  for (let bpm = 60; bpm <= 180; bpm += 1) {
    const lag = Math.max(1, Math.round((60 * ENVELOPE_HZ) / bpm));
    let numerator = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = lag; index < centered.length; index += 1) {
      numerator += centered[index] * centered[index - lag];
      leftEnergy += centered[index] ** 2;
      rightEnergy += centered[index - lag] ** 2;
    }
    const score = leftEnergy && rightEnergy ? numerator / Math.sqrt(leftEnergy * rightEnergy) : 0;
    bpmCandidates.push({ bpm, score });
  }
  const topBpm = topSeparated(
    bpmCandidates.filter((item) => item.score > 0).map((item) => ({ timeSeconds: item.bpm, strength: item.score })),
    { limit: 3, minimumGapSeconds: 4 },
  ).map((item) => ({ bpm: item.timeSeconds, confidence: round(Math.max(0, Math.min(1, item.strength))) }));
  const compactEnvelope = envelope.length <= 600
    ? envelope
    : Array.from({ length: 600 }, (_, index) => envelope[Math.min(envelope.length - 1, Math.floor(index * envelope.length / 600))]);
  return {
    available: true,
    analyzedSeconds: round(envelope.length / ENVELOPE_HZ, 3),
    energy: { meanRms: round(mean), peakRms: round(Math.max(...envelope)), sampleHz: ENVELOPE_HZ },
    energyEnvelope: compactEnvelope.map((value, index) => ({ timeSeconds: round(index * envelope.length / compactEnvelope.length / ENVELOPE_HZ, 3), rms: round(value) })),
    onsetCandidates,
    dropCandidates,
    bpmCandidates: topBpm,
  };
}

function analyzeVideoCuts(file, durationSeconds, threshold, maxEvents) {
  const boundedDuration = Math.min(durationSeconds || MAX_ANALYSIS_SECONDS, MAX_ANALYSIS_SECONDS);
  const result = run("ffmpeg", [
    "-hide_banner", "-loglevel", "info", "-i", file, "-t", String(boundedDuration),
    "-an", "-vf", `select='gt(scene,${threshold})',showinfo`, "-vsync", "vfr", "-f", "null", "-",
  ], { timeout: 45_000, maxBuffer: 32 * 1024 * 1024 });
  const stderr = String(result.stderr ?? "");
  if (result.status !== 0 && !/does not contain any stream|matches no streams|Output file #0 does not contain/.test(stderr)) {
    throw new Error(stderr.trim() || "ffmpeg scene analysis failed");
  }
  const cuts = [];
  for (const match of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0 && !cuts.some((entry) => Math.abs(entry.timeSeconds - value) < 0.04)) {
      cuts.push({ timeSeconds: round(value, 3), method: "ffmpeg-scene-score-threshold" });
      if (cuts.length >= maxEvents) break;
    }
  }
  return { available: !/does not contain any stream|matches no streams|Output file #0 does not contain/.test(stderr), threshold, candidates: cuts };
}

export function rhythmEvidenceDigest(value) {
  const copy = structuredClone(value);
  delete copy.evidenceDigest;
  return sha256Value(copy);
}

export function validateRhythmEvidence(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["rhythm evidence root must be an object"];
  if (value.schemaVersion !== "1.0" || value.kind !== "kacha-technical-rhythm-evidence") errors.push("invalid rhythm evidence identity");
  if (!value.source?.identity?.sha256 || !fileIdentityMatches(value.source.identity.path, value.source.identity)) errors.push("rhythm source identity is stale or unavailable");
  const durationSeconds = Number(value.technical?.durationSeconds);
  const analyzedSeconds = Number(value.technical?.analyzedSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) errors.push("technical duration is required");
  if (!Number.isFinite(analyzedSeconds) || analyzedSeconds < 0 || analyzedSeconds > Math.min(durationSeconds, MAX_ANALYSIS_SECONDS) + 0.1) errors.push("technical analyzedSeconds is invalid");
  if (value.technical?.truncated !== (durationSeconds > MAX_ANALYSIS_SECONDS)) errors.push("technical truncated flag is inconsistent");
  const boundedEvents = (entries, label, { maximum = 2000, strength = false } = {}) => {
    if (!Array.isArray(entries) || entries.length > maximum) {
      errors.push(`${label} must be an array with at most ${maximum} entries`);
      return;
    }
    let previousTime = -1;
    for (const entry of entries) {
      const time = Number(entry?.timeSeconds);
      if (!Number.isFinite(time) || time < 0 || time > analyzedSeconds + 0.1 || time < previousTime) errors.push(`${label} contains an invalid or unsorted time`);
      if (strength && (!Number.isFinite(Number(entry?.strength)) || Number(entry.strength) < 0)) errors.push(`${label} contains an invalid strength`);
      previousTime = time;
    }
  };
  boundedEvents(value.video?.sceneCutCandidates, "video.sceneCutCandidates");
  boundedEvents(value.audio?.onsetCandidates, "audio.onsetCandidates", { strength: true });
  boundedEvents(value.audio?.dropCandidates, "audio.dropCandidates", { maximum: 100, strength: true });
  boundedEvents(value.audio?.energyEnvelope, "audio.energyEnvelope", { maximum: 600 });
  for (const entry of Array.isArray(value.audio?.energyEnvelope) ? value.audio.energyEnvelope : []) {
    if (!Number.isFinite(Number(entry?.rms)) || Number(entry.rms) < 0 || Number(entry.rms) > 1) errors.push("audio.energyEnvelope contains an invalid rms");
  }
  if (!Array.isArray(value.audio?.bpmCandidates) || value.audio.bpmCandidates.length > 3) errors.push("audio.bpmCandidates must contain at most 3 entries");
  for (const entry of Array.isArray(value.audio?.bpmCandidates) ? value.audio.bpmCandidates : []) {
    if (!Number.isFinite(Number(entry?.bpm)) || Number(entry.bpm) < 60 || Number(entry.bpm) > 180 || !Number.isFinite(Number(entry?.confidence)) || Number(entry.confidence) < 0 || Number(entry.confidence) > 1) {
      errors.push("audio.bpmCandidates contains an invalid bpm or confidence");
    }
  }
  if (value.claims?.semanticUnderstanding !== false || value.claims?.beatGridIsAuthoritative !== false) errors.push("rhythm evidence must not claim semantic or authoritative beat understanding");
  if (!/^[a-f0-9]{64}$/.test(value.evidenceDigest ?? "")) errors.push("evidenceDigest is required");
  else if (value.evidenceDigest !== rhythmEvidenceDigest(value)) errors.push("evidenceDigest mismatch");
  return errors;
}

export function analyzeRhythm(fileInput, { sceneThreshold = 0.3, maxEvents = 500 } = {}) {
  const file = path.resolve(fileInput);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`media file does not exist: ${file}`);
  if (!Number.isFinite(sceneThreshold) || sceneThreshold <= 0 || sceneThreshold >= 1) throw new Error("sceneThreshold must be between 0 and 1");
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 2000) throw new Error("maxEvents must be an integer from 1 to 2000");
  const identity = fileIdentity(file);
  const probe = ffprobe(file);
  const durationSeconds = mediaDuration(probe);
  const hasVideo = probe.streams?.some((stream) => stream.codec_type === "video") ?? false;
  const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  const video = hasVideo ? analyzeVideoCuts(file, durationSeconds, sceneThreshold, maxEvents) : { available: false, threshold: sceneThreshold, candidates: [] };
  const audio = hasAudio ? analyzeAudio(file, durationSeconds, maxEvents) : { available: false, reason: "no-audio-stream", energyEnvelope: [], onsetCandidates: [], dropCandidates: [], bpmCandidates: [] };
  if (!fileIdentityMatches(file, identity)) throw new Error("media changed while rhythm evidence was being generated");
  const value = {
    schemaVersion: "1.0",
    kind: "kacha-technical-rhythm-evidence",
    status: "pass",
    analyzedAt: new Date().toISOString(),
    source: { identity },
    technical: {
      durationSeconds: round(durationSeconds, 3),
      analyzedSeconds: round(Math.min(durationSeconds, MAX_ANALYSIS_SECONDS), 3),
      truncated: durationSeconds > MAX_ANALYSIS_SECONDS,
      sceneThreshold,
      audioSampleRate: AUDIO_SAMPLE_RATE,
      envelopeHz: ENVELOPE_HZ,
    },
    video: { available: video.available, sceneCutCandidates: video.candidates },
    audio,
    claims: {
      semanticUnderstanding: false,
      beatGridIsAuthoritative: false,
      intendedUse: "candidate generation and operator review only",
    },
    limitations: [
      "Scene scores measure pixel change and may treat camera motion or flashes as cuts.",
      "BPM, onset and drop values are technical candidates, not musical or narrative truth.",
      "No speech, object, story or creative-intent semantics are inferred.",
    ],
  };
  value.evidenceDigest = rhythmEvidenceDigest(value);
  return value;
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  process.stderr.write(`${JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2)}\n`);
  process.exit(code);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const action = args[0];
  try {
    if (action === "analyze") {
      const input = option(args, "--input");
      const output = option(args, "--output");
      if (!input || !output) fail("rhythm analyze requires --input MEDIA --output FILE", 2);
      const value = analyzeRhythm(input, {
        sceneThreshold: Number(option(args, "--scene-threshold", 0.3)),
        maxEvents: Number(option(args, "--max-events", 500)),
      });
      writeJsonAtomic(output, value);
      process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", status: "pass", output: path.resolve(output), evidenceDigest: value.evidenceDigest, counts: { sceneCuts: value.video.sceneCutCandidates.length, onsets: value.audio.onsetCandidates.length, drops: value.audio.dropCandidates.length } }, null, 2)}\n`);
    } else if (action === "validate") {
      const input = option(args, "--input") ?? args[1];
      if (!input) fail("rhythm validate requires --input FILE", 2);
      const value = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
      const errors = validateRhythmEvidence(value);
      if (errors.length) fail(errors.join("; "));
      process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", status: "pass", input: path.resolve(input), evidenceDigest: value.evidenceDigest }, null, 2)}\n`);
    } else fail("usage: kacha.mjs rhythm analyze|validate [options]", 2);
  } catch (error) {
    fail(error.message);
  }
}
