#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const fileHashCache = new Map();
const mediaProbeCache = new Map();
const streamHashCache = new Map();
const commandCache = new Map();

function statCacheKey(file) {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  return [
    resolved,
    stat.size,
    Math.trunc(stat.mtimeMs * 1000),
    Math.trunc(stat.ctimeMs * 1000),
    stat.ino ?? 0,
  ].join(":");
}

function persistentMediaCacheFile(kind, key) {
  if (process.env.KACHA_DISABLE_MEDIA_CACHE === "1") return null;
  const root = process.env.XDG_CACHE_HOME
    || path.join(os.homedir(), ".cache");
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(root, "kacha", kind, "v1", `${digest}.json`);
}

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

export function writeJsonAtomic(file, value, { mode = null } = {}) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify(value, null, 2)}\n`,
    mode === null ? undefined : { mode },
  );
  fs.renameSync(temporary, resolved);
}

export function acquireFileLock(
  file,
  {
    staleAfterMs = 6 * 60 * 60 * 1000,
    purpose = "kacha-operation",
  } = {},
) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const attempt = () => {
    const descriptor = fs.openSync(resolved, "wx", 0o600);
    const payload = {
      schemaVersion: "1.0",
      pid: process.pid,
      host: osHostname(),
      purpose,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`);
    fs.closeSync(descriptor);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(fs.readFileSync(resolved, "utf8"));
        if (current.pid === process.pid && current.host === payload.host) {
          fs.unlinkSync(resolved);
        }
      } catch {
        // A missing or externally replaced lock must not be deleted blindly.
      }
    };
  };
  try {
    return attempt();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  let existing = null;
  let stat = null;
  try {
    existing = JSON.parse(fs.readFileSync(resolved, "utf8"));
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`operation lock exists and is unreadable: ${resolved}`);
  }
  const sameHost = existing.host === osHostname();
  let ownerAlive = true;
  if (sameHost && Number.isInteger(existing.pid)) {
    try {
      process.kill(existing.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") ownerAlive = false;
    }
  }
  const stale = Date.now() - stat.mtimeMs > staleAfterMs;
  if (sameHost && !ownerAlive) {
    fs.unlinkSync(resolved);
    return attempt();
  }
  throw new Error(
    `operation lock is active: ${resolved} `
      + `(pid=${existing.pid ?? "unknown"}, purpose=${existing.purpose ?? "unknown"}, `
      + `stale=${stale})`,
  );
}

function osHostname() {
  return os.hostname()
    || process.env.HOSTNAME
    || process.env.COMPUTERNAME
    || "local";
}

export function resolveFrom(ownerFile, candidate) {
  if (!hasValue(candidate)) return null;
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(path.dirname(path.resolve(ownerFile)), candidate);
}

export function sha256File(file) {
  const cacheKey = statCacheKey(file);
  if (fileHashCache.has(cacheKey)) return fileHashCache.get(cacheKey);
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
  const value = digest.digest("hex");
  if (statCacheKey(file) !== cacheKey) {
    throw new Error(`file changed while hashing: ${path.resolve(file)}`);
  }
  fileHashCache.set(cacheKey, value);
  return value;
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Value(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function mediaIndexDigest(value) {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  delete copy.digest;
  return sha256Value(copy);
}

export function fileIdentity(file, { includeHash = true } = {}) {
  const resolved = path.resolve(file);
  const beforeKey = statCacheKey(resolved);
  const digest = includeHash ? sha256File(resolved) : null;
  if (statCacheKey(resolved) !== beforeKey) {
    throw new Error(`file changed while building identity: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  return {
    path: resolved,
    sizeBytes: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    ctimeMs: Math.trunc(stat.ctimeMs),
    inode: stat.ino ?? null,
    ...(includeHash ? { sha256: digest } : {}),
  };
}

export function directoryIdentity(directory, { includeHash = true } = {}) {
  const root = path.resolve(directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`directory does not exist: ${root}`);
  }
  const entries = [];
  const visit = (current) => {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (child.isDirectory()) {
        entries.push({ path: `${relative}/`, kind: "directory" });
        visit(absolute);
      } else if (child.isFile()) {
        const stat = fs.statSync(absolute);
        entries.push({
          path: relative,
          kind: "file",
          sizeBytes: stat.size,
          ...(includeHash ? { sha256: sha256File(absolute) } : {}),
        });
      } else if (child.isSymbolicLink()) {
        entries.push({
          path: relative,
          kind: "symlink",
          target: fs.readlinkSync(absolute),
        });
      }
    }
  };
  visit(root);
  return {
    path: root,
    entries: entries.length,
    sha256: sha256Value(entries),
  };
}

export function fileIdentityMatches(file, identity) {
  if (!identity || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  try {
    return fastIdentityMatches(file, identity)
      && (!identity.sha256 || sha256File(file) === identity.sha256);
  } catch {
    return false;
  }
}

export function fastIdentityMatches(file, identity) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const stat = fs.statSync(file);
  const baseMatch = Number(identity?.sizeBytes) === stat.size
    && Math.abs(Number(identity?.mtimeMs) - Math.trunc(stat.mtimeMs)) <= 1;
  if (!baseMatch) return false;
  if (
    Number.isFinite(Number(identity?.ctimeMs))
    && Math.abs(Number(identity.ctimeMs) - Math.trunc(stat.ctimeMs)) > 1
  ) {
    return false;
  }
  if (
    identity?.inode !== undefined
    && identity?.inode !== null
    && Number(identity.inode) !== Number(stat.ino)
  ) {
    return false;
  }
  return true;
}

export function streamSha256(file, kind) {
  if (!["video", "audio"].includes(kind)) {
    throw new Error(`Unsupported stream kind: ${kind}`);
  }
  const sourceCacheKey = statCacheKey(file);
  const cacheKey = `${sourceCacheKey}:${kind}`;
  if (streamHashCache.has(cacheKey)) return streamHashCache.get(cacheKey);
  const map = kind === "video" ? "0:v:0" : "0:a:0";
  const result = run("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-i",
    file,
    "-map",
    map,
    "-c",
    "copy",
    "-f",
    "hash",
    "-hash",
    "sha256",
    "-",
  ]);
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `Could not hash ${kind} stream for ${file}`,
    );
  }
  const match = /SHA256=([a-f0-9]{64})/i.exec(result.stdout);
  if (!match) {
    throw new Error(`FFmpeg returned no SHA-256 for ${kind} stream: ${file}`);
  }
  const value = match[1].toLowerCase();
  if (statCacheKey(file) !== sourceCacheKey) {
    throw new Error(`file changed while hashing ${kind} stream: ${path.resolve(file)}`);
  }
  streamHashCache.set(cacheKey, value);
  return value;
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

export function resolveRuntimeCommand(command) {
  if (command === "ffmpeg") {
    const candidates = [
      process.env.KACHA_FFMPEG_BIN,
      "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
      "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
    ].filter(Boolean);
    const preferred = candidates.find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    );
    if (preferred) return preferred;
  }
  if (command === "ffprobe") {
    const candidates = [
      process.env.KACHA_FFPROBE_BIN,
      process.env.KACHA_FFMPEG_BIN
        ? path.join(path.dirname(process.env.KACHA_FFMPEG_BIN), "ffprobe")
        : null,
      "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe",
      "/usr/local/opt/ffmpeg-full/bin/ffprobe",
    ].filter(Boolean);
    const preferred = candidates.find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    );
    if (preferred) return preferred;
  }
  return command;
}

export function runtimeEnvironment(requestedEnvironment = {}) {
  const environment = {
    ...process.env,
    ...requestedEnvironment,
  };
  const ffmpeg = resolveRuntimeCommand("ffmpeg");
  const ffprobe = resolveRuntimeCommand("ffprobe");
  if (path.isAbsolute(ffmpeg)) {
    const runtimeDirectory = path.dirname(ffmpeg);
    environment.PATH = [
      runtimeDirectory,
      ...(environment.PATH ?? "").split(path.delimiter)
        .filter((entry) => entry && entry !== runtimeDirectory),
    ].join(path.delimiter);
    environment.KACHA_FFMPEG_BIN ??= ffmpeg;
  }
  if (path.isAbsolute(ffprobe)) environment.KACHA_FFPROBE_BIN ??= ffprobe;
  return environment;
}

export function commandExists(command) {
  const resolved = resolveRuntimeCommand(command);
  const cacheKey = `${command}:${resolved}`;
  if (commandCache.has(cacheKey)) return commandCache.get(cacheKey);
  let available;
  if (["ffmpeg", "ffprobe"].includes(command)) {
    available = spawnSync(resolved, ["-version"], {
      encoding: "utf8",
      env: runtimeEnvironment(),
    }).status === 0;
  } else {
    available = path.isAbsolute(resolved)
      ? fs.existsSync(resolved) && fs.statSync(resolved).isFile()
      : spawnSync("/usr/bin/env", ["bash", "-lc", `command -v "${resolved}"`], {
          encoding: "utf8",
          env: runtimeEnvironment(),
        }).status === 0;
  }
  commandCache.set(cacheKey, available);
  return available;
}

export function run(command, args, options = {}) {
  const {
    env: requestedEnvironment,
    ...spawnOptions
  } = options;
  const environment = runtimeEnvironment(requestedEnvironment ?? {});
  const result = spawnSync(resolveRuntimeCommand(command), args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...spawnOptions,
    env: environment,
  });
  return {
    ...result,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function ffprobe(file) {
  const cacheKey = statCacheKey(file);
  if (mediaProbeCache.has(cacheKey)) return mediaProbeCache.get(cacheKey);
  const persistentFile = persistentMediaCacheFile("media-probe", cacheKey);
  if (persistentFile && fs.existsSync(persistentFile)) {
    try {
      const cached = readJson(persistentFile);
      if (
        cached.schemaVersion === "1.0"
        && cached.cacheKey === cacheKey
        && cached.probe
        && statCacheKey(file) === cacheKey
      ) {
        mediaProbeCache.set(cacheKey, cached.probe);
        return cached.probe;
      }
    } catch {
      // Corrupt cache is ignored and replaced after a real probe succeeds.
    }
  }
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
  const value = JSON.parse(result.stdout);
  if (statCacheKey(file) !== cacheKey) {
    throw new Error(`file changed while probing: ${path.resolve(file)}`);
  }
  mediaProbeCache.set(cacheKey, value);
  if (persistentFile) {
    try {
      writeJsonAtomic(persistentFile, {
        schemaVersion: "1.0",
        cacheKey,
        generatedAt: new Date().toISOString(),
        probe: value,
      });
    } catch {
      // Cache writes are optional and must never block media processing.
    }
  }
  return value;
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
