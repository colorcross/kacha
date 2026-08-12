import fs from "node:fs";
import path from "node:path";
import { fileIdentity, run } from "./kacha_utils.mjs";

const SAMPLE_RATE = 48000;
const WINDOW_MS = 20;
const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_MS / 1000;
const cache = new Map();

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function cacheKey(file) {
  const stat = fs.statSync(file);
  return `${path.resolve(file)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/**
 * Decode the sound effect and locate the loudest 20 ms RMS window.
 * This value is an offset inside the file, never a timeline start time.
 */
export function measureSfxPeak(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`音效文件不存在：${resolved}`);
  }
  const key = cacheKey(resolved);
  if (cache.has(key)) return structuredClone(cache.get(key));
  const result = run("ffmpeg", [
    "-hide_banner", "-loglevel", "info", "-nostdin",
    "-i", resolved,
    "-vn",
    "-af",
    `aresample=${SAMPLE_RATE},aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=mono,`
      + `asetnsamples=n=${WINDOW_SAMPLES}:p=0,astats=metadata=1:reset=1,`
      + "ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-",
  ]);
  if (result.status !== 0) {
    throw new Error(`音效波形解码失败：${resolved}\n${result.stderr || result.stdout}`);
  }
  const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/);
  let ptsTime = 0;
  let peakOffsetSeconds = null;
  let peakRmsDb = -Infinity;
  for (const line of lines) {
    const timeMatch = /pts_time:([-+0-9.eE]+)/.exec(line);
    if (timeMatch) ptsTime = Number(timeMatch[1]);
    const rmsMatch = /lavfi\.astats\.Overall\.RMS_level=([-+0-9.eE]+|-inf)/i.exec(line);
    if (!rmsMatch) continue;
    const level = rmsMatch[1].toLowerCase() === "-inf"
      ? -Infinity
      : Number(rmsMatch[1]);
    if (Number.isFinite(level) && level > peakRmsDb) {
      peakRmsDb = level;
      peakOffsetSeconds = ptsTime;
    }
  }
  if (!Number.isFinite(peakOffsetSeconds) || !Number.isFinite(peakRmsDb)) {
    throw new Error(`音效没有可测量的非静音 RMS 峰值：${resolved}`);
  }
  const measurement = {
    schemaVersion: "1.0",
    measurementMethod: "decoded_20ms_rms_peak",
    sampleRate: SAMPLE_RATE,
    windowMs: WINDOW_MS,
    windowSamples: WINDOW_SAMPLES,
    measuredPeakOffsetSeconds: round(peakOffsetSeconds),
    peakRmsDb: round(peakRmsDb, 3),
    file: fileIdentity(resolved),
  };
  cache.set(key, measurement);
  return structuredClone(measurement);
}

/**
 * Resolve file start/trim from the intended visible or semantic landing.
 * The returned delta is recomputed from decoded audio and cannot be supplied by a plan.
 */
export function alignSfxPeak({
  file,
  targetLandingSeconds,
  fps,
  toleranceFrames = 1,
}) {
  const target = Number(targetLandingSeconds);
  const frameRate = Number(fps);
  if (!Number.isFinite(target) || target < 0) throw new Error("targetLandingSeconds 必须大于等于 0");
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error("fps 必须大于 0");
  const measurement = measureSfxPeak(file);
  const rawStart = target - measurement.measuredPeakOffsetSeconds;
  const fileStartSeconds = Math.max(0, rawStart);
  const sourceTrimSeconds = Math.max(0, -rawStart);
  const resolvedLandingSeconds = fileStartSeconds
    + measurement.measuredPeakOffsetSeconds
    - sourceTrimSeconds;
  const deltaFrames = (resolvedLandingSeconds - target) * frameRate;
  return {
    ...measurement,
    alignmentMode: "waveform_peak",
    targetLandingSeconds: round(target),
    fileStartSeconds: round(fileStartSeconds),
    sourceTrimSeconds: round(sourceTrimSeconds),
    resolvedLandingSeconds: round(resolvedLandingSeconds),
    deltaFrames: round(deltaFrames, 3),
    toleranceFrames: Number(toleranceFrames),
    withinTolerance: Math.abs(deltaFrames) <= Number(toleranceFrames) + 1e-6,
  };
}
