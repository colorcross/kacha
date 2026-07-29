#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mediaSummary,
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const registryFile = path.join(skillDirectory, "config", "effects", "visual-breathing.json");
const bundledSfxRoot = path.join(skillDirectory, "assets", "sfx");
const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(name) {
  return args.includes(name);
}

function fail(message, code = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    error: message,
  }, null, 2));
  process.exit(code);
}

function execute(command, commandArgs) {
  const result = run(command, commandArgs);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} 失败\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
  return result;
}

const sfxPeakCache = new Map();
function sfxPeakSeconds(file) {
  if (sfxPeakCache.has(file)) return sfxPeakCache.get(file);
  const measurement = run("ffmpeg", [
    "-hide_banner", "-loglevel", "info",
    "-i", file,
    "-af",
    "asetnsamples=n=1024:p=0,astats=metadata=1:reset=1,ametadata=print",
    "-f", "null", "-",
  ]);
  const lines = String(measurement.stderr ?? "").split(/\r?\n/);
  let time = 0;
  let bestTime = 0;
  let bestLevel = -Infinity;
  for (const line of lines) {
    const timeMatch = /pts_time:([0-9.]+)/.exec(line);
    if (timeMatch) time = Number(timeMatch[1]);
    const peakMatch = /lavfi\.astats\.Overall\.Peak_level=([-+0-9.]+)/.exec(line);
    if (peakMatch && Number(peakMatch[1]) > bestLevel) {
      bestLevel = Number(peakMatch[1]);
      bestTime = time;
    }
  }
  const value = Number.isFinite(bestLevel) ? bestTime : 0;
  sfxPeakCache.set(file, value);
  return value;
}

function parseTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const text = String(value ?? "").trim().replace(",", ".");
  const match = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text);
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseSrt(text) {
  return text.trim().split(/\r?\n\r?\n+/).map((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return null;
    const [start, end] = lines[timingIndex].split("-->").map(parseTimestamp);
    return { start, end, text: lines.slice(timingIndex + 1).join(" ").trim() };
  }).filter(Boolean);
}

function readTranscript(file) {
  const raw = path.extname(file).toLowerCase() === ".srt"
    ? parseSrt(fs.readFileSync(file, "utf8"))
    : (() => {
      const value = readJson(file);
      return Array.isArray(value) ? value : value.cues ?? value.segments ?? value.items ?? [];
    })();
  return raw.map((cue, index) => ({
    ...cue,
    id: String(cue.id ?? `cue-${String(index + 1).padStart(4, "0")}`),
    start: parseTimestamp(cue.start ?? cue.startSeconds ?? cue.begin),
    end: parseTimestamp(cue.end ?? cue.endSeconds ?? cue.finish),
    text: String(cue.text ?? cue.transcript ?? cue.content ?? "").replace(/\s+/g, " ").trim(),
  })).filter((cue) => (
    Number.isFinite(cue.start)
    && Number.isFinite(cue.end)
    && cue.end > cue.start
    && cue.text
  )).sort((left, right) => left.start - right.start);
}

function explicitMotion(cue, motionsById) {
  const id = String(cue.breathingIntent ?? cue.motionIntent ?? "").trim();
  if (!id || id === "auto" || id === "none") return null;
  if (!motionsById.has(id)) throw new Error(`cue ${cue.id} 指定了不存在的呼吸动效：${id}`);
  return { id, evidence: "explicit" };
}

function automaticMotion(cue, index) {
  const text = cue.text;
  if (index === 0 && cue.end - cue.start >= 2) {
    return { id: "slow_push_in", evidence: "opening_attention_build" };
  }
  if (/其实|说实话|回头看|也许|可能|想一想|反过来|in fact|honestly|perhaps/i.test(text)) {
    return { id: "slow_pull_back", evidence: "reflective_release" };
  }
  if (
    /所以|因此|结论|关键|最重要|真正|记住|就是|意味着|\d+(?:\.\d+)?%?|therefore|the point|important/i.test(text)
    && text.length <= 22
  ) {
    return { id: "emphasis_punch_settle", evidence: "short_logical_peak" };
  }
  if (/[?？]|为什么|怎么|what|why|how/i.test(text)) {
    return { id: "slow_push_in", evidence: "question_attention_build" };
  }
  if (
    cue.visualSpace === "left"
    || cue.visualSpace === "right"
    || /左边|右边|这边|另一边|on the left|on the right/i.test(text)
  ) {
    return { id: "lateral_drift", evidence: "real_directional_space" };
  }
  return null;
}

function countWindow(events, time, seconds = 10) {
  return events.filter((event) => (
    event.startSeconds >= time - seconds && event.startSeconds <= time
  )).length;
}

function buildPlan({ input, transcript, output }) {
  const registry = readJson(registryFile);
  const motionsById = new Map(registry.motions.map((motion) => [motion.id, motion]));
  const summary = mediaSummary(input);
  const cues = readTranscript(transcript);
  if (cues.length === 0) throw new Error("转写中没有有效 cue");
  const config = loadKachaConfig({ args, anchorPath: input, includeSecrets: false }).config;
  const configured = config.execution.visualBreathing ?? {};
  const maximumPer10 = Number(option(
    "--max-events-per-10",
    configured.maximumPrimaryEventsPer10Seconds
      ?? registry.policy.maximumPrimaryEventsPer10Seconds,
  ));
  const minimumGapSeconds = Number(option(
    "--minimum-gap",
    configured.minimumGapSeconds ?? registry.policy.minimumGapSeconds,
  ));
  const fps = summary.averageFps;
  const totalFrames = Math.round(summary.videoDuration * fps);
  const events = [];
  const dropped = [];
  let previousEndSeconds = -minimumGapSeconds;
  let movingFrames = 0;

  for (const [index, cue] of cues.entries()) {
    const selected = explicitMotion(cue, motionsById) ?? automaticMotion(cue, index);
    if (!selected) continue;
    const motion = motionsById.get(selected.id);
    const startSeconds = Math.max(0, cue.start);
    if (startSeconds < previousEndSeconds + minimumGapSeconds) {
      dropped.push({ cueId: cue.id, motionId: motion.id, reason: "距离上一运动过近" });
      continue;
    }
    if (countWindow(events, startSeconds) >= maximumPer10) {
      dropped.push({ cueId: cue.id, motionId: motion.id, reason: "超过每10秒运动密度上限" });
      continue;
    }
    const duration = Math.min(
      registry.policy.maximumMotionSeconds,
      Math.max(registry.policy.minimumMotionSeconds, cue.end - cue.start),
    );
    const startFrame = Math.round(startSeconds * fps);
    const endFrame = Math.min(totalFrames, startFrame + Math.round(duration * fps));
    if (endFrame - startFrame < Math.round(registry.policy.minimumMotionSeconds * fps)) {
      dropped.push({ cueId: cue.id, motionId: motion.id, reason: "有效区间太短" });
      continue;
    }
    const projectedMoving = movingFrames + endFrame - startFrame;
    if (projectedMoving / totalFrames > registry.policy.maximumMotionCoverageRatio) {
      dropped.push({ cueId: cue.id, motionId: motion.id, reason: "运动覆盖率超过上限" });
      continue;
    }
    const peakFrame = motion.id === "emphasis_punch_settle"
      ? startFrame + Math.round((endFrame - startFrame) * 0.25)
      : endFrame - 1;
    const focusXRatio = Number(cue.focusXRatio ?? registry.policy.defaultFocusXRatio);
    const focusYRatio = Number(cue.focusYRatio ?? registry.policy.defaultFocusYRatio);
    events.push({
      id: `breath-${String(events.length + 1).padStart(4, "0")}`,
      cueId: cue.id,
      motionId: motion.id,
      trigger: motion.trigger,
      function: motion.function,
      selectionEvidence: selected.evidence,
      startFrame,
      endFrame,
      peakFrame,
      startSeconds: startFrame / fps,
      endSeconds: endFrame / fps,
      peakSeconds: peakFrame / fps,
      focusXRatio,
      focusYRatio,
      startScale: motion.startScale,
      endScale: motion.endScale,
      peakScale: motion.peakScale ?? null,
      curve: motion.curve,
      sound: motion.soundTrigger
        ? {
          trigger: motion.soundTrigger,
          peakFrame,
          peakSeconds: peakFrame / fps,
          levelRelativeToDialogueDb:
            registry.soundPalette[motion.soundTrigger].levelRelativeToDialogueDb,
        }
        : null,
      fallback: motion.fallback,
      failureModes: motion.failureModes,
    });
    movingFrames = projectedMoving;
    previousEndSeconds = endFrame / fps;
  }
  if (events.length === 0) {
    throw new Error("没有形成有效呼吸动效；可在带时间文稿中显式填写 breathingIntent");
  }
  const plan = {
    schemaVersion: "1.0",
    kind: "kacha_visual_breathing_timeline",
    status: "planned_not_rendered",
    generatedAt: new Date().toISOString(),
    source: {
      input: {
        path: path.resolve(input),
        sha256: sha256File(input),
        width: summary.width,
        height: summary.height,
        fps,
        duration: summary.videoDuration,
      },
      transcript: {
        path: path.resolve(transcript),
        sha256: sha256File(transcript),
        cueCount: cues.length,
      },
    },
    policy: {
      ...registry.policy,
      maximumPrimaryEventsPer10Seconds: maximumPer10,
      minimumGapSeconds,
      preserveSourceGeometry: true,
      preserveSourceAudioAtUnityGain: true,
    },
    coverage: {
      movingFrames,
      stillFrames: totalFrames - movingFrames,
      motionRatio: movingFrames / totalFrames,
      stillRatio: (totalFrames - movingFrames) / totalFrames,
    },
    events,
    droppedCandidates: dropped,
    registry: { id: registry.id, sha256: sha256File(registryFile) },
  };
  plan.digest = sha256Value({ ...plan, digest: undefined });
  writeJsonAtomic(output, plan);
  return plan;
}

function validatePlan(planFile) {
  const plan = readJson(planFile);
  const registry = readJson(registryFile);
  const motionsById = new Map(registry.motions.map((motion) => [motion.id, motion]));
  const errors = [];
  if (plan.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (plan.kind !== "kacha_visual_breathing_timeline") {
    errors.push("kind 必须为 kacha_visual_breathing_timeline");
  }
  for (const [label, item] of [
    ["input", plan.source?.input],
    ["transcript", plan.source?.transcript],
  ]) {
    if (!item?.path || !fs.existsSync(item.path)) errors.push(`${label} 不存在`);
    else if (sha256File(item.path) !== item.sha256) errors.push(`${label} SHA-256 已失效`);
  }
  if (plan.registry?.sha256 !== sha256File(registryFile)) {
    errors.push("呼吸动效注册表已变化，计划必须重建");
  }
  let previousEnd = -1;
  let previousDirection = null;
  for (const [index, event] of (plan.events ?? []).entries()) {
    const label = `events[${index}]`;
    if (!motionsById.has(event.motionId)) errors.push(`${label}.motionId 未注册`);
    if (!(event.startFrame >= 0 && event.endFrame > event.startFrame)) {
      errors.push(`${label} 帧区间无效`);
    }
    if (event.startFrame < previousEnd) errors.push(`${label} 与上一动效重叠`);
    previousEnd = event.endFrame;
    for (const field of ["focusXRatio", "focusYRatio"]) {
      if (!(event[field] >= 0.1 && event[field] <= 0.9)) {
        errors.push(`${label}.${field} 必须在 0.1–0.9`);
      }
    }
    const maximum = Math.max(event.startScale, event.endScale, event.peakScale ?? 1);
    if (maximum > plan.policy.maximumScale) errors.push(`${label} 缩放超过上限`);
    const direction = event.endScale > event.startScale
      ? "in"
      : event.endScale < event.startScale
        ? "out"
        : event.motionId === "lateral_drift"
          ? "side"
          : "hold";
    if (direction === previousDirection && ["in", "out", "side"].includes(direction)) {
      errors.push(`${label} 与上一运动连续同向，缺少释放`);
    }
    previousDirection = direction;
  }
  if (!Array.isArray(plan.events) || plan.events.length === 0) errors.push("events 不能为空");
  if (plan.coverage?.motionRatio > plan.policy.maximumMotionCoverageRatio + 1e-6) {
    errors.push("运动覆盖率超过上限");
  }
  if (plan.coverage?.stillRatio < plan.policy.minimumStillCoverageRatio - 1e-6) {
    errors.push("停稳覆盖率不足");
  }
  if (plan.policy?.ordinarySlowMotionSfx !== "none") {
    errors.push("普通慢推拉不得默认配音效");
  }
  const expectedDigest = sha256Value({ ...plan, digest: undefined });
  if (expectedDigest !== plan.digest) errors.push("计划 digest 不一致");
  return { plan, errors };
}

function zoomExpression(event, frames) {
  const denominator = Math.max(1, frames - 1);
  const progress = `min(on\\/${denominator},1)`;
  if (event.motionId === "slow_push_in") {
    return `${event.startScale}+(${event.endScale - event.startScale})*`
      + `(1-cos(PI*${progress}))/2`;
  }
  if (event.motionId === "slow_pull_back") {
    return `${event.startScale}-(${event.startScale - event.endScale})*`
      + `(1-cos(PI*${progress}))/2`;
  }
  if (event.motionId === "emphasis_punch_settle") {
    return `if(lt(${progress},0.25),`
      + `${event.startScale}+(${event.peakScale - event.startScale})*${progress}/0.25,`
      + `${event.peakScale}-(${event.peakScale - event.endScale})*(${progress}-0.25)/0.75)`;
  }
  return String(event.startScale);
}

function segmentFilter(index, startFrame, endFrame, event, plan) {
  const frames = endFrame - startFrame;
  const width = plan.source.input.width;
  const height = plan.source.input.height;
  const fps = plan.source.input.fps;
  if (!event) {
    return `[0:v]trim=start_frame=${startFrame}:end_frame=${endFrame},`
      + `setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[v${index}]`;
  }
  const zoom = zoomExpression(event, frames);
  const focusX = event.focusXRatio;
  const focusY = event.focusYRatio;
  const progress = `min(on\\/${Math.max(1, frames - 1)},1)`;
  const x = event.motionId === "lateral_drift"
    ? `(iw-iw/zoom)*${progress}`
    : `min(max(iw*${focusX}-iw/zoom/2,0),iw-iw/zoom)`;
  const y = `min(max(ih*${focusY}-ih/zoom/2,0),ih-ih/zoom)`;
  return `[0:v]trim=start_frame=${startFrame}:end_frame=${endFrame},`
    + "setpts=PTS-STARTPTS,"
    + `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps},`
    + `trim=end_frame=${frames},setpts=N/(${fps}*TB),format=yuv420p[v${index}]`;
}

function resolveSfx(trigger, root) {
  if (!trigger || !root) return null;
  const palette = readJson(registryFile).soundPalette[trigger];
  const manifestFile = path.join(root, "manifest.json");
  if (!palette || !fs.existsSync(manifestFile)) return null;
  const manifest = readJson(manifestFile);
  for (const id of palette.preferredAssetIds) {
    const asset = (manifest.assets ?? []).find((item) => item.id === id);
    if (!asset) continue;
    const candidates = [
      path.resolve(root, asset.ready_file),
      path.resolve(root, "ready", asset.ready_file),
    ];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (file) return { asset, file };
  }
  return null;
}

function renderPlan(planFile, output) {
  const checked = validatePlan(planFile);
  if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
  const { plan } = checked;
  const input = plan.source.input.path;
  const summary = mediaSummary(input);
  const totalFrames = Math.round(summary.videoDuration * summary.averageFps);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-breathing-"));
  try {
    const segments = [];
    let cursor = 0;
    for (const event of plan.events) {
      if (event.startFrame > cursor) {
        segments.push({ startFrame: cursor, endFrame: event.startFrame, event: null });
      }
      segments.push({ startFrame: event.startFrame, endFrame: event.endFrame, event });
      cursor = event.endFrame;
    }
    if (cursor < totalFrames) segments.push({ startFrame: cursor, endFrame: totalFrames, event: null });
    const filters = segments.map((segment, index) => (
      segmentFilter(index, segment.startFrame, segment.endFrame, segment.event, plan)
    ));
    filters.push(
      `${segments.map((_, index) => `[v${index}]`).join("")}`
        + `concat=n=${segments.length}:v=1:a=0,`
        + `fps=${summary.averageFps},setpts=N/(${summary.averageFps}*TB)[outv]`,
    );
    const videoOnly = path.join(temporary, "breathing-video.mp4");
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", input,
      "-filter_complex", filters.join(";"),
      "-map", "[outv]", "-an", "-frames:v", String(totalFrames),
      "-c:v", "libx264", "-preset", "slow", "-crf", option("--crf", "16"),
      "-pix_fmt", "yuv420p", "-fps_mode", "cfr",
      "-movflags", "+faststart", videoOnly,
    ]);
    const config = loadKachaConfig({ args, anchorPath: input, includeSecrets: false }).config;
    const sfxRoot = option("--sfx-root")
      ? path.resolve(option("--sfx-root"))
      : config.tools.sfxLibrary
        ? path.resolve(config.tools.sfxLibrary)
        : bundledSfxRoot;
    const sfxItems = has("--no-sfx")
      ? []
      : plan.events.map((event) => {
        const asset = resolveSfx(event.sound?.trigger, sfxRoot);
        return asset
          ? { event, ...asset, sourcePeakSeconds: sfxPeakSeconds(asset.file) }
          : null;
      }).filter(Boolean);
    const finalArgs = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", videoOnly,
    ];
    if (summary.audio) finalArgs.push("-i", input);
    for (const item of sfxItems) finalArgs.push("-i", item.file);
    if (!summary.audio) {
      finalArgs.push("-map", "0:v:0", "-c:v", "copy", "-an");
    } else if (sfxItems.length === 0) {
      finalArgs.push(
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
      );
    } else {
      const audioFilters = [
        "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,"
          + "asetpts=PTS-STARTPTS[voice]",
      ];
      sfxItems.forEach((item, index) => {
        const offset = item.event.sound.peakSeconds - item.sourcePeakSeconds;
        const trim = offset < 0
          ? `atrim=start=${(-offset).toFixed(6)},asetpts=PTS-STARTPTS,`
          : "";
        const delay = Math.max(0, Math.round(offset * 1000));
        audioFilters.push(
          `[${index + 2}:a]aformat=sample_rates=48000:channel_layouts=stereo,`
          + `${trim}adelay=${delay}|${delay},`
          + `volume=${item.event.sound.levelRelativeToDialogueDb}dB`
          + `[s${index}]`,
        );
      });
      audioFilters.push(
        `${["[voice]", ...sfxItems.map((_, index) => `[s${index}]`)].join("")}`
          + `amix=inputs=${sfxItems.length + 1}:normalize=0:dropout_transition=0,`
          + "alimiter=limit=0.95[outa]",
      );
      finalArgs.push(
        "-filter_complex", audioFilters.join(";"),
        "-map", "0:v:0", "-map", "[outa]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
      );
    }
    finalArgs.push("-t", String(summary.videoDuration), "-movflags", "+faststart", output);
    execute("ffmpeg", finalArgs);
    const decode = run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", output, "-f", "null", "-",
    ]);
    if (decode.status !== 0 || decode.stderr.trim()) {
      throw new Error(`呼吸版解码失败：${decode.stderr}`);
    }
    const rendered = mediaSummary(output);
    if (
      rendered.width !== summary.width
      || rendered.height !== summary.height
      || Math.abs(rendered.videoDuration - summary.videoDuration) > 2 / summary.averageFps
    ) {
      throw new Error("呼吸版未保持源几何或时长");
    }
    const manifest = {
      schemaVersion: "1.0",
      status: "pass",
      plan: { path: path.resolve(planFile), sha256: sha256File(planFile), digest: plan.digest },
      output: {
        path: path.resolve(output),
        sha256: sha256File(output),
        width: rendered.width,
        height: rendered.height,
        fps: rendered.averageFps,
        duration: rendered.videoDuration,
      },
      appliedEvents: plan.events.map((event) => ({
        id: event.id,
        motionId: event.motionId,
        startFrame: event.startFrame,
        endFrame: event.endFrame,
        peakFrame: event.peakFrame,
        soundAssetId: resolveSfx(event.sound?.trigger, sfxRoot)?.asset.id ?? null,
      })),
      sfxPeakAlignmentPlan: sfxItems.map((item) => ({
        eventId: item.event.id,
        eventPeakSeconds: item.event.sound.peakSeconds,
        sourcePeakSeconds: item.sourcePeakSeconds,
        placedAtSeconds: Math.max(
          0,
          item.event.sound.peakSeconds - item.sourcePeakSeconds,
        ),
      })),
      coverage: plan.coverage,
      qc: {
        fullDecode: "pass",
        sourceGeometryPreserved: true,
        sourceDurationPreserved: true,
        stillCoveragePass: plan.coverage.stillRatio >= plan.policy.minimumStillCoverageRatio,
        slowMotionSfxAbsent: plan.events
          .filter((event) => ["slow_push_in", "slow_pull_back", "lateral_drift"].includes(event.motionId))
          .every((event) => !event.sound),
        headSafetyVisualReview: "required",
        normalSpeedRhythmReview: "required",
      },
    };
    manifest.digest = sha256Value({ ...manifest, digest: undefined });
    const manifestFile = option("--manifest", `${output}.manifest.json`);
    writeJsonAtomic(manifestFile, manifest);
    return { manifest, manifestFile };
  } finally {
    if (has("--keep-workdir")) console.error(`breathing workdir kept: ${temporary}`);
    else fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (!["plan", "validate", "render"].includes(action)) {
  fail(
    "用法：visual_breathing.mjs plan --input VIDEO --transcript JSON|SRT --output PLAN\n"
      + "  visual_breathing.mjs validate --plan PLAN\n"
      + "  visual_breathing.mjs render --plan PLAN --output VIDEO [--sfx-root DIR]",
    2,
  );
}

try {
  if (action === "plan") {
    const input = path.resolve(option("--input", ""));
    const transcript = path.resolve(option("--transcript", ""));
    const output = path.resolve(option("--output", ""));
    if (!fs.existsSync(input)) fail(`输入不存在：${input}`, 2);
    if (!fs.existsSync(transcript)) fail(`转写不存在：${transcript}`, 2);
    if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖计划：${output}`, 2);
    const plan = buildPlan({ input, transcript, output });
    const checked = validatePlan(output);
    if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      output,
      eventCount: plan.events.length,
      motions: plan.events.map((event) => event.motionId),
      coverage: plan.coverage,
      droppedCandidateCount: plan.droppedCandidates.length,
      digest: plan.digest,
    }, null, 2));
  } else if (action === "validate") {
    const planFile = path.resolve(option("--plan", ""));
    if (!fs.existsSync(planFile)) fail(`计划不存在：${planFile}`, 2);
    const checked = validatePlan(planFile);
    if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      plan: planFile,
      eventCount: checked.plan.events.length,
      coverage: checked.plan.coverage,
      digest: checked.plan.digest,
    }, null, 2));
  } else {
    const planFile = path.resolve(option("--plan", ""));
    const output = path.resolve(option("--output", ""));
    if (!fs.existsSync(planFile)) fail(`计划不存在：${planFile}`, 2);
    if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖输出：${output}`, 2);
    const result = renderPlan(planFile, output);
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: result.manifest.status,
      output,
      manifest: result.manifestFile,
      eventCount: result.manifest.appliedEvents.length,
      coverage: result.manifest.coverage,
      sha256: result.manifest.output.sha256,
    }, null, 2));
  }
} catch (error) {
  fail(error.message);
}
