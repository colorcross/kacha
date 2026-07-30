#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  acquireFileLock,
  directoryIdentity,
  fileIdentity,
  fileIdentityMatches,
  mediaSummary,
  readJson,
  resolveFrom,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";
import { acquireResourceLeases } from "./resource_pool.mjs";

const args = process.argv.slice(2);
const action = firstPositional(args, [
  "--plan",
  "--graph",
  "--output",
  "--mode",
  "--range-start",
  "--range-end",
  "--config",
  "--secrets",
]) ?? "help";

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function between(value, minimum, maximum) {
  return finite(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function mediaPath(owner, entry) {
  const candidate = typeof entry === "string" ? entry : entry?.path;
  return candidate ? resolveFrom(owner, candidate) : null;
}

function assetIdentity(owner, entry) {
  const file = existingFile(owner, entry);
  return file ? fileIdentity(file) : null;
}

function existingFile(owner, entry) {
  const file = mediaPath(owner, entry);
  return file && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function ffmpegFilterPath(file) {
  return path.resolve(file)
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

function codecAvailable(name) {
  const result = run("ffmpeg", ["-hide_banner", "-encoders"]);
  return result.status === 0 && `${result.stdout}\n${result.stderr}`.includes(name);
}

function filterAvailable(name) {
  const result = run("ffmpeg", ["-hide_banner", "-filters"]);
  return result.status === 0
    && `${result.stdout}\n${result.stderr}`.split("\n")
      .some((line) => new RegExp(`\\b${name}\\b`).test(line));
}

function formatNumber(value) {
  return Number(value).toFixed(6).replace(/\.?0+$/, "");
}

function normalizeEdl(plan, summary) {
  const sourceDuration = summary.videoDuration || summary.duration;
  const entries = Array.isArray(plan.edl) && plan.edl.length > 0
    ? plan.edl
    : [{ id: "source-full", sourceStart: 0, sourceEnd: sourceDuration }];
  return entries.map((entry, index) => ({
    id: entry.id || `segment-${String(index + 1).padStart(3, "0")}`,
    sourceStart: Number(entry.sourceStart),
    sourceEnd: Number(entry.sourceEnd),
    duration: Number(entry.sourceEnd) - Number(entry.sourceStart),
  }));
}

function outputDuration(edl) {
  return edl.reduce((sum, item) => sum + item.duration, 0);
}

function previewRange(totalDuration, mode) {
  const rawStart = option("--range-start");
  const rawEnd = option("--range-end");
  if (rawStart === null && rawEnd === null) return null;
  if (rawStart === null || rawEnd === null) {
    throw new Error("--range-start 与 --range-end 必须同时提供");
  }
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (
    mode !== "preview"
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || start < 0
    || end <= start
    || end > totalDuration + 0.001
  ) {
    throw new Error("局部区间只允许 preview，且必须满足 0 <= start < end <= 总时长");
  }
  if (!option("--output")) {
    throw new Error("局部预览必须显式提供独立 --output，禁止覆盖正式输出");
  }
  return {
    start,
    end,
    duration: end - start,
    sourceTimelineDuration: totalDuration,
  };
}

function sliceEdl(edl, range) {
  if (!range) return edl;
  const sliced = [];
  let outputStart = 0;
  for (const segment of edl) {
    const outputEnd = outputStart + segment.duration;
    const intersectionStart = Math.max(outputStart, range.start);
    const intersectionEnd = Math.min(outputEnd, range.end);
    if (intersectionEnd > intersectionStart + 0.000001) {
      const sourceStart = segment.sourceStart + (intersectionStart - outputStart);
      const sourceEnd = segment.sourceStart + (intersectionEnd - outputStart);
      sliced.push({
        id: `${segment.id}-range-${String(sliced.length + 1).padStart(3, "0")}`,
        sourceStart,
        sourceEnd,
        duration: sourceEnd - sourceStart,
      });
    }
    outputStart = outputEnd;
  }
  if (sliced.length === 0) {
    throw new Error("局部预览区间没有命中任何 EDL 片段");
  }
  return sliced;
}

function sliceTimedEvents(events, range, startField = "start", endField = "end") {
  if (!range) return events;
  return events.flatMap((event) => {
    const start = Math.max(Number(event[startField]), range.start);
    const end = Math.min(Number(event[endField]), range.end);
    if (end <= start + 0.000001) return [];
    return [{
      ...event,
      [startField]: start - range.start,
      [endField]: end - range.start,
    }];
  });
}

function validatePlan(planFile) {
  const errors = [];
  let plan = null;
  try {
    plan = readJson(planFile);
  } catch (error) {
    return { plan: null, errors: [`时间线 JSON 无法解析：${error.message}`] };
  }
  if (plan.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (!plan.projectId) errors.push("projectId 不能为空");
  if (!["preview", "final"].includes(plan.mode)) errors.push("mode 必须为 preview 或 final");
  for (const [name, entry] of Object.entries(plan.contracts ?? {})) {
    const file = existingFile(planFile, entry);
    if (!file) {
      errors.push(`contracts.${name}.path 不存在`);
    } else if (!entry.sha256 || entry.sha256 !== sha256File(file)) {
      errors.push(`contracts.${name}.sha256 已失效`);
    }
  }
  const source = existingFile(planFile, plan.source);
  if (!source) errors.push(`源视频不存在：${mediaPath(planFile, plan.source) ?? "missing"}`);
  let summary = null;
  if (source) {
    try {
      summary = mediaSummary(source);
      if (!summary.video) errors.push("源文件必须包含视频轨");
      if (plan.source?.sha256 && plan.source.sha256 !== sha256File(source)) {
        errors.push("源视频 SHA-256 已失效");
      }
    } catch (error) {
      errors.push(`源视频无法探测：${error.message}`);
    }
  }
  let edl = [];
  if (summary) {
    edl = normalizeEdl(plan, summary);
    const duration = summary.videoDuration || summary.duration;
    edl.forEach((entry, index) => {
      if (
        !finite(entry.sourceStart)
        || !finite(entry.sourceEnd)
        || entry.sourceStart < 0
        || entry.sourceEnd <= entry.sourceStart
        || entry.sourceEnd > duration + 0.001
      ) {
        errors.push(`edl[${index}] 区间无效`);
      }
    });
  }
  const duration = outputDuration(edl);
  if (plan.decisionPlan) {
    const decisionFile = existingFile(planFile, plan.decisionPlan);
    if (!decisionFile) {
      errors.push("decisionPlan.path 不存在");
    } else {
      try {
        const decision = readJson(decisionFile);
        if (
          plan.decisionPlan.sha256 !== sha256File(decisionFile)
          || plan.decisionPlan.digest !== decision.digest
        ) {
          errors.push("decisionPlan SHA/digest 已失效");
        }
        if (
          plan.mode === "final"
          && Number(decision.quality?.escalationCount ?? 0) > 0
        ) {
          errors.push("最终时间线不得包含未解决的弱模型升级项");
        }
      } catch (error) {
        errors.push(`decisionPlan 无法解析：${error.message}`);
      }
    }
  }
  const breathing = plan.visual?.breathing ?? [];
  const sortedBreathing = [...breathing].sort((a, b) => Number(a.start) - Number(b.start));
  sortedBreathing.forEach((event, index) => {
    if (
      !finite(event.start)
      || !finite(event.end)
      || Number(event.start) < 0
      || Number(event.end) <= Number(event.start)
      || Number(event.end) > duration + 0.001
      || !between(event.scale, 1, 1.2)
      || !between(event.anchorX ?? 0.5, 0, 1)
      || !between(event.anchorY ?? 0.5, 0, 1)
      || !between(event.entryRatio ?? 0.3, 0.05, 0.8)
      || !between(event.exitRatio ?? 0.3, 0.05, 0.8)
      || Number(event.entryRatio ?? 0.3) + Number(event.exitRatio ?? 0.3) > 0.95
    ) {
      errors.push(`visual.breathing[${index}] 合同无效`);
    }
    if (
      index > 0
      && Number(event.start) < Number(sortedBreathing[index - 1].end) - 0.0001
    ) {
      errors.push("visual.breathing 事件不得重叠");
    }
  });
  (plan.visual?.overlays ?? []).forEach((event, index) => {
    const file = existingFile(planFile, event);
    if (!file) errors.push(`visual.overlays[${index}] 素材不存在`);
    if (file && event.sha256 && event.sha256 !== sha256File(file)) {
      errors.push(`visual.overlays[${index}] SHA-256 已失效`);
    }
    if (!["image", "video"].includes(event.kind)) {
      errors.push(`visual.overlays[${index}].kind 必须为 image 或 video`);
    }
    if (
      !finite(event.start)
      || !finite(event.end)
      || Number(event.start) < 0
      || Number(event.end) <= Number(event.start)
      || Number(event.end) > duration + 0.001
      || !between(event.opacity ?? 1, 0, 1)
    ) {
      errors.push(`visual.overlays[${index}] 时间或透明度无效`);
    }
    for (const field of ["x", "y", "width", "height"]) {
      if (!finite(event[field]) || Number(event[field]) < 0) {
        errors.push(`visual.overlays[${index}].${field} 无效`);
      }
    }
    const outputWidth = finite(plan.output?.width)
      ? Number(plan.output.width)
      : Number(summary?.width);
    const outputHeight = finite(plan.output?.height)
      ? Number(plan.output.height)
      : Number(summary?.height);
    if (
      finite(event.x)
      && finite(event.y)
      && finite(event.width)
      && finite(event.height)
      && (
        Number(event.x) + Number(event.width) > outputWidth + 0.001
        || Number(event.y) + Number(event.height) > outputHeight + 0.001
      )
    ) {
      errors.push(`visual.overlays[${index}] 超出输出画布`);
    }
  });
  if (plan.visual?.subtitles) {
    const subtitles = plan.visual.subtitles;
    const subtitleFile = existingFile(planFile, subtitles);
    const subtitleKind = subtitles.kind
      ?? (path.extname(mediaPath(planFile, subtitles) ?? "").toLowerCase() === ".ass"
        ? "ass"
        : "overlay_video");
    if (!subtitleFile) errors.push("visual.subtitles.path 不存在");
    if (
      subtitleFile
      && subtitles.sha256
      && subtitles.sha256 !== sha256File(subtitleFile)
    ) {
      errors.push("visual.subtitles SHA-256 已失效");
    }
    if (!["ass", "overlay_video"].includes(subtitleKind)) {
      errors.push("visual.subtitles.kind 必须为 ass 或 overlay_video");
    } else if (subtitleKind === "ass" && !filterAvailable("subtitles")) {
      errors.push(
        "当前 FFmpeg 不含 libass subtitles filter；请先生成透明字幕层并使用 overlay_video",
      );
    } else if (subtitleKind === "overlay_video" && subtitleFile) {
      try {
        const subtitleSummary = mediaSummary(subtitleFile);
        if (!subtitleSummary.video) errors.push("overlay_video 字幕层必须包含视频轨");
        if (subtitleSummary.videoDuration + 0.001 < duration) {
          errors.push("overlay_video 字幕层不得短于时间线");
        }
      } catch (error) {
        errors.push(`overlay_video 字幕层无法探测：${error.message}`);
      }
    }
  }
  if (
    plan.visual?.subtitles?.fontsDirectory
    && !fs.existsSync(resolveFrom(planFile, plan.visual.subtitles.fontsDirectory))
  ) {
    errors.push("visual.subtitles.fontsDirectory 不存在");
  }
  for (const [label, entry] of [
    ["audio.dialogue", plan.audio?.dialogue],
    ["audio.bgm", plan.audio?.bgm],
  ]) {
    if (entry && !existingFile(planFile, entry)) errors.push(`${label} 不存在`);
    const file = entry ? existingFile(planFile, entry) : null;
    if (file && entry.sha256 && entry.sha256 !== sha256File(file)) {
      errors.push(`${label} SHA-256 已失效`);
    }
  }
  (plan.audio?.sfx ?? []).forEach((event, index) => {
    const file = existingFile(planFile, event);
    if (!file) errors.push(`audio.sfx[${index}] 不存在`);
    if (file && event.sha256 && event.sha256 !== sha256File(file)) {
      errors.push(`audio.sfx[${index}] SHA-256 已失效`);
    }
    if (!finite(event.time) || Number(event.time) < 0 || Number(event.time) > duration) {
      errors.push(`audio.sfx[${index}].time 无效`);
    }
  });
  const output = mediaPath(planFile, option("--output", plan.output));
  if (!output) errors.push("output.path 不能为空");
  if (source && output && path.resolve(source) === path.resolve(output)) {
    errors.push("输出不能覆盖源视频");
  }
  return {
    plan,
    source,
    summary,
    edl,
    duration,
    output,
    errors,
  };
}

function easeExpression(frame, start, end) {
  const denominator = Math.max(1, end - start);
  return `(0.5-0.5*cos(PI*(${frame}-${start})/${denominator}))`;
}

function breathingExpression(events, fps, field) {
  let expression = field === "scale" ? "1" : "0.5";
  for (const event of [...events].reverse()) {
    const start = Math.round(Number(event.start) * fps);
    const end = Math.round(Number(event.end) * fps);
    const length = Math.max(1, end - start);
    const entryEnd = start + Math.max(1, Math.round(length * Number(event.entryRatio ?? 0.3)));
    const exitStart = end - Math.max(1, Math.round(length * Number(event.exitRatio ?? 0.3)));
    let value;
    if (field === "scale") {
      const target = Number(event.scale);
      const enter = `1+(${formatNumber(target - 1)})*${easeExpression("on", start, entryEnd)}`;
      const exit = `${formatNumber(target)}-(${formatNumber(target - 1)})*`
        + `${easeExpression("on", exitStart, end)}`;
      value = `if(lte(on,${entryEnd}),${enter},if(lt(on,${exitStart}),`
        + `${formatNumber(target)},${exit}))`;
    } else {
      value = formatNumber(Number(event[field] ?? 0.5));
    }
    expression = `if(between(on,${start},${end}),${value},${expression})`;
  }
  return expression;
}

function compileGraph(validated, loadedConfig) {
  const { plan, source, summary, edl, duration, output } = validated;
  const mode = option("--mode", plan.mode);
  const range = previewRange(duration, mode);
  const renderEdl = sliceEdl(edl, range);
  const renderDuration = range?.duration ?? duration;
  const configured = loadedConfig.config.execution.unifiedRender;
  const sourceWidth = summary.width;
  const sourceHeight = summary.height;
  const sourceFps = summary.averageFps || summary.declaredFps || summary.fps;
  const previewMaximum = configured.preview.maxWidth;
  const requestedWidth = Number(plan.output?.width);
  const requestedHeight = Number(plan.output?.height);
  const desiredWidth = finite(requestedWidth) ? requestedWidth : sourceWidth;
  const desiredHeight = finite(requestedHeight) ? requestedHeight : sourceHeight;
  const previewScale = mode === "preview" && desiredWidth > previewMaximum
    ? previewMaximum / desiredWidth
    : 1;
  const width = Math.max(2, Math.round((desiredWidth * previewScale) / 2) * 2);
  const height = Math.max(2, Math.round((desiredHeight * previewScale) / 2) * 2);
  const fps = finite(plan.output?.fps) ? Number(plan.output.fps) : sourceFps;
  const breathing = sliceTimedEvents(plan.visual?.breathing ?? [], range);
  const overlays = sliceTimedEvents(plan.visual?.overlays ?? [], range);
  const sfx = (plan.audio?.sfx ?? []).flatMap((entry) => {
    if (!range) return [entry];
    const time = Number(entry.time);
    return time >= range.start && time <= range.end
      ? [{ ...entry, time: time - range.start }]
      : [];
  });
  const graph = {
    schemaVersion: "1.0",
    projectId: plan.projectId,
    mode,
    contracts: Object.fromEntries(
      Object.entries(plan.contracts ?? {}).map(([name, entry]) => {
        const file = existingFile(validated.planFile, entry);
        return [name, { ...entry, path: file, identity: fileIdentity(file) }];
      }),
    ),
    source: fileIdentity(source),
    sourceMedia: {
      width: sourceWidth,
      height: sourceHeight,
      fps: sourceFps,
      durationSeconds: summary.videoDuration || summary.duration,
      hasAudio: Boolean(summary.audio),
    },
    edl: renderEdl,
    durationSeconds: renderDuration,
    previewRange: range,
    geometry: { width, height, fps },
    visual: {
      breathing,
      overlays: overlays.map((entry) => ({
        ...entry,
        x: Number(entry.x) * previewScale,
        y: Number(entry.y) * previewScale,
        width: Number(entry.width) * previewScale,
        height: Number(entry.height) * previewScale,
        path: existingFile(validated.planFile ?? "", entry)
          ?? mediaPath(validated.planFile ?? "", entry),
        identity: assetIdentity(validated.planFile ?? "", entry),
      })),
      subtitles: plan.visual?.subtitles
        ? {
            ...plan.visual.subtitles,
            kind: plan.visual.subtitles.kind
              ?? (path.extname(mediaPath(validated.planFile, plan.visual.subtitles))
                .toLowerCase() === ".ass"
                ? "ass"
                : "overlay_video"),
            path: existingFile(validated.planFile ?? "", plan.visual.subtitles),
            identity: assetIdentity(
              validated.planFile ?? "",
              plan.visual.subtitles,
            ),
            fontsDirectory: plan.visual.subtitles.fontsDirectory
              ? resolveFrom(validated.planFile, plan.visual.subtitles.fontsDirectory)
              : null,
            fontsIdentity: plan.visual.subtitles.fontsDirectory
              ? directoryIdentity(
                  resolveFrom(validated.planFile, plan.visual.subtitles.fontsDirectory),
                )
              : null,
          }
        : null,
    },
    audio: {
      dialogue: plan.audio?.dialogue
        ? {
            ...plan.audio.dialogue,
            path: existingFile(validated.planFile, plan.audio.dialogue),
            identity: assetIdentity(validated.planFile, plan.audio.dialogue),
          }
        : null,
      bgm: plan.audio?.bgm
        ? {
            ...plan.audio.bgm,
            path: existingFile(validated.planFile, plan.audio.bgm),
            identity: assetIdentity(validated.planFile, plan.audio.bgm),
          }
        : null,
      sfx: sfx.map((entry) => ({
        ...entry,
        path: existingFile(validated.planFile, entry),
        identity: assetIdentity(validated.planFile, entry),
      })),
    },
    output: {
      path: output,
      dialogueStem: !range && plan.output?.dialogueStem
        ? resolveFrom(validated.planFile, plan.output.dialogueStem)
        : null,
      bgmStem: !range && plan.output?.bgmStem
        ? resolveFrom(validated.planFile, plan.output.bgmStem)
        : null,
      sfxStem: !range && plan.output?.sfxStem
        ? resolveFrom(validated.planFile, plan.output.sfxStem)
        : null,
      mixStem: !range && plan.output?.mixStem
        ? resolveFrom(validated.planFile, plan.output.mixStem)
        : null,
    },
    encoding: mode === "preview"
      ? {
          requested: configured.preview.encoder,
          fallback: configured.preview.fallbackEncoder,
          preset: configured.preview.preset,
          crf: configured.preview.crf,
        }
      : {
          requested: configured.final.encoder,
          fallback: configured.final.fallbackEncoder,
          preset: configured.final.preset,
          crf: configured.final.crf,
        },
    quality: {
      singleVideoEncodeRequired: true,
      preserveSourceGeometryInFinal: mode === "final",
      requiresFinalQc: mode === "final",
    },
    decisionPlan: plan.decisionPlan
      ? {
          path: existingFile(validated.planFile, plan.decisionPlan),
          sha256: plan.decisionPlan.sha256,
          digest: plan.decisionPlan.digest,
          escalationCount: plan.decisionPlan.escalationCount,
        }
      : null,
    configurationDigest: loadedConfig.digest,
  };
  graph.digest = sha256Value({ ...graph, digest: undefined });
  return graph;
}

function buildRenderCommand(graph) {
  const command = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", graph.source.path];
  const inputIndexes = {
    overlays: [],
    subtitles: null,
    dialogue: null,
    bgm: null,
    sfx: [],
  };
  let inputIndex = 1;
  for (const overlay of graph.visual.overlays) {
    if (overlay.kind === "image") command.push("-loop", "1", "-framerate", String(graph.geometry.fps));
    else command.push("-stream_loop", "-1");
    command.push("-i", overlay.path);
    inputIndexes.overlays.push(inputIndex);
    inputIndex += 1;
  }
  if (graph.visual.subtitles?.kind === "overlay_video") {
    command.push("-stream_loop", "-1", "-i", graph.visual.subtitles.path);
    inputIndexes.subtitles = inputIndex;
    inputIndex += 1;
  }
  if (graph.audio.dialogue) {
    command.push("-i", graph.audio.dialogue.path);
    inputIndexes.dialogue = inputIndex;
    inputIndex += 1;
  }
  if (graph.audio.bgm) {
    command.push("-stream_loop", "-1", "-i", graph.audio.bgm.path);
    inputIndexes.bgm = inputIndex;
    inputIndex += 1;
  }
  for (const sfx of graph.audio.sfx) {
    command.push("-i", sfx.path);
    inputIndexes.sfx.push(inputIndex);
    inputIndex += 1;
  }

  const filters = [];
  const videoSegments = [];
  const audioSegments = [];
  graph.edl.forEach((segment, index) => {
    filters.push(
      `[0:v]trim=start=${formatNumber(segment.sourceStart)}:`
        + `end=${formatNumber(segment.sourceEnd)},setpts=PTS-STARTPTS[vseg${index}]`,
    );
    videoSegments.push(`[vseg${index}]`);
    if (graph.sourceMedia.hasAudio && !graph.audio.dialogue) {
      filters.push(
        `[0:a]atrim=start=${formatNumber(segment.sourceStart)}:`
          + `end=${formatNumber(segment.sourceEnd)},asetpts=PTS-STARTPTS[aseg${index}]`,
      );
      audioSegments.push(`[aseg${index}]`);
    }
  });
  if (videoSegments.length === 1) {
    filters.push(`${videoSegments[0]}null[vcut]`);
  } else {
    filters.push(`${videoSegments.join("")}concat=n=${videoSegments.length}:v=1:a=0[vcut]`);
  }
  if (audioSegments.length === 1) {
    filters.push(`${audioSegments[0]}anull[voiceRaw]`);
  } else if (audioSegments.length > 1) {
    filters.push(`${audioSegments.join("")}concat=n=${audioSegments.length}:v=0:a=1[voiceRaw]`);
  } else if (inputIndexes.dialogue !== null) {
    const dialogueStart = graph.previewRange?.start ?? 0;
    const dialogueEnd = graph.previewRange?.end ?? graph.durationSeconds;
    filters.push(
      `[${inputIndexes.dialogue}:a]atrim=start=${formatNumber(dialogueStart)}:`
        + `end=${formatNumber(dialogueEnd)},`
        + "asetpts=PTS-STARTPTS[voiceRaw]",
    );
  }
  filters.push(
    `[vcut]scale=${graph.geometry.width}:${graph.geometry.height}:`
      + "force_original_aspect_ratio=increase,"
      + `crop=${graph.geometry.width}:${graph.geometry.height},setsar=1[vgeom]`,
  );
  let currentVideo = "vgeom";
  if (graph.visual.breathing.length > 0) {
    const scale = breathingExpression(graph.visual.breathing, graph.geometry.fps, "scale");
    const anchorX = breathingExpression(graph.visual.breathing, graph.geometry.fps, "anchorX");
    const anchorY = breathingExpression(graph.visual.breathing, graph.geometry.fps, "anchorY");
    filters.push(
      `[${currentVideo}]zoompan=z='${scale}':`
        + `x='(iw-iw/zoom)*(${anchorX})':y='(ih-ih/zoom)*(${anchorY})':`
        + `d=1:s=${graph.geometry.width}x${graph.geometry.height}:`
        + `fps=${graph.geometry.fps}[vbreath]`,
    );
    currentVideo = "vbreath";
  }
  graph.visual.overlays.forEach((overlay, index) => {
    const input = inputIndexes.overlays[index];
    const label = `overlay${index}`;
    filters.push(
      `[${input}:v]scale=${Math.round(Number(overlay.width))}:`
        + `${Math.round(Number(overlay.height))}:force_original_aspect_ratio=decrease,`
        + `pad=${Math.round(Number(overlay.width))}:${Math.round(Number(overlay.height))}:`
        + "(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba,"
        + `colorchannelmixer=aa=${formatNumber(overlay.opacity ?? 1)},`
        + `setpts=PTS-STARTPTS+${formatNumber(overlay.start)}/TB[${label}]`,
    );
    const next = `vover${index}`;
    filters.push(
      `[${currentVideo}][${label}]overlay=x=${Math.round(Number(overlay.x))}:`
        + `y=${Math.round(Number(overlay.y))}:`
        + `enable='between(t,${formatNumber(overlay.start)},${formatNumber(overlay.end)})':`
        + `eof_action=pass:shortest=0[${next}]`,
    );
    currentVideo = next;
  });
  if (graph.visual.subtitles?.kind === "overlay_video") {
    const subtitleTrim = graph.previewRange
      ? `trim=start=${formatNumber(graph.previewRange.start)}:`
        + `end=${formatNumber(graph.previewRange.end)},`
      : "";
    filters.push(
      `[${inputIndexes.subtitles}:v]${subtitleTrim}`
        + `scale=${graph.geometry.width}:${graph.geometry.height},`
        + "format=rgba,setpts=PTS-STARTPTS[vsubtitlelayer]",
    );
    filters.push(
      `[${currentVideo}][vsubtitlelayer]overlay=0:0:`
        + "eof_action=pass:shortest=0:format=auto[vsub]",
    );
    currentVideo = "vsub";
  } else if (graph.visual.subtitles?.kind === "ass") {
    const fonts = graph.visual.subtitles.fontsDirectory
      ? `:fontsdir='${ffmpegFilterPath(graph.visual.subtitles.fontsDirectory)}'`
      : "";
    const subtitleOffset = graph.previewRange
      ? `setpts=PTS+${formatNumber(graph.previewRange.start)}/TB,`
      : "";
    const normalizeTimestamp = graph.previewRange ? ",setpts=PTS-STARTPTS" : "";
    filters.push(
      `[${currentVideo}]${subtitleOffset}subtitles=filename='`
        + `${ffmpegFilterPath(graph.visual.subtitles.path)}'${fonts}`
        + `${normalizeTimestamp}[vsub]`,
    );
    currentVideo = "vsub";
  }
  filters.push(`[${currentVideo}]fps=${graph.geometry.fps},format=yuv420p[vout]`);

  const hasVoice = audioSegments.length > 0 || inputIndexes.dialogue !== null;
  let voiceForMix = null;
  const stemMaps = [];
  if (hasVoice) {
    const needStem = Boolean(graph.output.dialogueStem);
    const needSidechain = Boolean(
      inputIndexes.bgm !== null && graph.audio.bgm.sidechain !== false,
    );
    const branches = ["voiceMix"];
    if (needSidechain) branches.push("voiceSidechain");
    if (needStem) branches.push("voiceStem");
    const branchFilter = branches.length === 1
      ? `[${branches[0]}]`
      : `,asplit=${branches.length}${branches.map((label) => `[${label}]`).join("")}`;
    filters.push(
      `[voiceRaw]aresample=48000:async=0:first_pts=0,`
        + `atrim=0:${formatNumber(graph.durationSeconds)},`
        + `aformat=sample_rates=48000:channel_layouts=stereo`
        + branchFilter,
    );
    voiceForMix = "voiceMix";
    if (needStem) stemMaps.push({ label: "voiceStem", path: graph.output.dialogueStem });
  }

  let bgmForMix = null;
  if (inputIndexes.bgm !== null) {
    const level = -Math.abs(Number(graph.audio.bgm.levelBelowDialogueDb ?? 16));
    const bgmStart = graph.previewRange?.start ?? 0;
    const bgmEnd = graph.previewRange?.end ?? graph.durationSeconds;
    filters.push(
      `[${inputIndexes.bgm}:a]atrim=start=${formatNumber(bgmStart)}:`
        + `end=${formatNumber(bgmEnd)},`
        + "asetpts=PTS-STARTPTS,aresample=48000:async=0:first_pts=0,"
        + `aformat=sample_rates=48000:channel_layouts=stereo,volume=${level}dB[bgmRaw]`,
    );
    if (graph.audio.bgm.sidechain !== false && hasVoice) {
      filters.push(
        "[bgmRaw][voiceSidechain]sidechaincompress=threshold=0.03:ratio=4:"
          + "attack=20:release=280[bgmDucked]",
      );
      bgmForMix = "bgmDucked";
    } else {
      bgmForMix = "bgmRaw";
    }
    if (graph.output.bgmStem) {
      filters.push(`[${bgmForMix}]asplit=2[bgmMix][bgmStem]`);
      bgmForMix = "bgmMix";
      stemMaps.push({ label: "bgmStem", path: graph.output.bgmStem });
    }
  }

  const sfxLabels = [];
  graph.audio.sfx.forEach((sfx, index) => {
    const delay = Math.max(0, Math.round(Number(sfx.time) * 1000));
    const level = -Math.abs(Number(sfx.levelBelowDialogueDb ?? 10));
    const label = `sfx${index}`;
    filters.push(
      `[${inputIndexes.sfx[index]}:a]aresample=48000,`
        + "aformat=sample_rates=48000:channel_layouts=stereo,"
        + `adelay=${delay}|${delay},volume=${level}dB[${label}]`,
    );
    sfxLabels.push(`[${label}]`);
  });
  let sfxForMix = null;
  if (sfxLabels.length > 0) {
    filters.push(
      `${sfxLabels.join("")}amix=inputs=${sfxLabels.length}:normalize=0:`
        + `duration=longest,atrim=0:${formatNumber(graph.durationSeconds)}[sfxRaw]`,
    );
    sfxForMix = "sfxRaw";
    if (graph.output.sfxStem) {
      filters.push("[sfxRaw]asplit=2[sfxMix][sfxStem]");
      sfxForMix = "sfxMix";
      stemMaps.push({ label: "sfxStem", path: graph.output.sfxStem });
    }
  }
  const mixLabels = [
    voiceForMix ? `[${voiceForMix}]` : null,
    bgmForMix ? `[${bgmForMix}]` : null,
    sfxForMix ? `[${sfxForMix}]` : null,
  ].filter(Boolean);
  if (mixLabels.length > 0) {
    filters.push(
      `${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0:`
        + `duration=longest:dropout_transition=0,`
        + `atrim=0:${formatNumber(graph.durationSeconds)},`
        + "alimiter=limit=0.95[mixLimited]",
    );
    if (graph.output.mixStem) {
      filters.push("[mixLimited]asplit=2[aout][mixStem]");
      stemMaps.push({ label: "mixStem", path: graph.output.mixStem });
    } else {
      filters.push("[mixLimited]anull[aout]");
    }
  }

  command.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (mixLabels.length > 0) command.push("-map", "[aout]");
  let encoder = graph.encoding.requested;
  if (!codecAvailable(encoder)) encoder = graph.encoding.fallback;
  command.push("-c:v", encoder);
  if (encoder === "libx264" || encoder === "libx265") {
    command.push("-preset", graph.encoding.preset, "-crf", String(graph.encoding.crf));
  } else {
    command.push("-b:v", "0", "-q:v", graph.mode === "preview" ? "60" : "75");
  }
  command.push("-pix_fmt", "yuv420p");
  if (mixLabels.length > 0) {
    command.push("-c:a", "aac", "-b:a", "256k", "-ar", "48000");
  } else {
    command.push("-an");
  }
  command.push(
    "-t", formatNumber(graph.durationSeconds),
    "-movflags", "+faststart",
    graph.output.path,
  );
  for (const stem of stemMaps) {
    fs.mkdirSync(path.dirname(stem.path), { recursive: true });
    command.push("-map", `[${stem.label}]`, "-c:a", "pcm_s24le", stem.path);
  }
  return { command, encoder, filters, stemMaps };
}

function render(validated, graph, graphFile, loadedConfig) {
  const output = graph.output.path;
  const manifestFile = `${output}.manifest.json`;
  if (fs.existsSync(output)) {
    if (fs.existsSync(manifestFile)) {
      try {
        const existing = readJson(manifestFile);
        const expectedStems = [
          graph.output.dialogueStem,
          graph.output.bgmStem,
          graph.output.sfxStem,
          graph.output.mixStem,
        ].filter(Boolean);
        const stemsMatch = expectedStems.every((file) => {
          const identity = existing.outputStems?.find(
            (item) => path.resolve(item.path) === path.resolve(file),
          );
          return identity && fileIdentityMatches(file, identity);
        });
        if (
          existing.graph?.digest === graph.digest
          && existing.output?.sha256 === sha256File(output)
          && stemsMatch
        ) {
          return {
            status: "reused",
            output,
            manifest: manifestFile,
            graph: graphFile,
            videoEncodes: 0,
          };
        }
      } catch {
        // Existing output is rejected below.
      }
    }
    throw new Error(`拒绝覆盖已有输出：${output}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const release = acquireFileLock(`${output}.lock`, {
    purpose: `timeline-render:${graph.projectId}`,
  });
  let resourceLeases = null;
  try {
    resourceLeases = acquireResourceLeases({
      config: loadedConfig.config,
      projectRoot: path.dirname(validated.planFile),
      resources: ["cpuHeavy", "videoEncode"],
      purpose: `timeline-render:${graph.projectId}`,
    });
    const built = buildRenderCommand(graph);
    const result = run("ffmpeg", built.command);
    if (result.status !== 0) {
      if (fs.existsSync(output)) fs.unlinkSync(output);
      throw new Error(result.stderr.trim() || "统一时间线渲染失败");
    }
    const rendered = mediaSummary(output);
    const durationTolerance = 1.5 / graph.geometry.fps;
    if (
      rendered.width !== graph.geometry.width
      || rendered.height !== graph.geometry.height
      || Math.abs(rendered.averageFps - graph.geometry.fps) > 0.02
      || Math.abs(rendered.videoDuration - graph.durationSeconds) > durationTolerance
    ) {
      fs.unlinkSync(output);
      throw new Error("统一渲染未保持几何、有效帧率或时长合同");
    }
    const manifest = {
      schemaVersion: "1.0",
      status: graph.mode === "final" ? "rendered_requires_final_qc" : "preview_ready",
      generatedAt: new Date().toISOString(),
      graph: {
        path: graphFile,
        digest: graph.digest,
        sha256: sha256File(graphFile),
      },
      input: graph.source,
      output: {
        ...fileIdentity(output),
        width: rendered.width,
        height: rendered.height,
        fps: rendered.averageFps,
        durationSeconds: rendered.videoDuration,
      },
      outputStems: built.stemMaps.map((item) => fileIdentity(item.path)),
      execution: {
        requestedEncoder: graph.encoding.requested,
        fallbackEncoder: graph.encoding.fallback,
        encoder: built.encoder,
        encoderFallbackUsed: built.encoder !== graph.encoding.requested,
        videoEncodes: 1,
        fullDecodePerformed: false,
        finalQcRequired: graph.mode === "final",
        stemOutputs: built.stemMaps.map((item) => item.path),
        resourceLeases: resourceLeases.leases.map((item) => ({
          resource: item.resource,
          slot: item.slot,
        })),
        resourceWaitSeconds: resourceLeases.waitedSeconds,
        previewRange: graph.previewRange,
      },
      quality: graph.quality,
      configurationDigest: graph.configurationDigest,
    };
    writeJsonAtomic(manifestFile, manifest);
    return {
      status: manifest.status,
      output,
      manifest: manifestFile,
      graph: graphFile,
      videoEncodes: 1,
      durationSeconds: rendered.videoDuration,
      encoder: built.encoder,
    };
  } finally {
    resourceLeases?.release();
    release();
  }
}

if (!["validate", "compile", "render"].includes(action)) {
  fail(
    "用法：kacha.mjs timeline validate|compile|render --plan TIMELINE.json "
      + "[--graph RENDER-GRAPH.json] [--output VIDEO] [--mode preview|final] "
      + "[--range-start SEC --range-end SEC（仅 preview）]",
    2,
  );
}
const planInput = option("--plan");
if (!planInput) fail("--plan 不能为空", 2);
const planFile = path.resolve(planInput);
const validated = validatePlan(planFile);
validated.planFile = planFile;
if (validated.errors.length > 0) {
  console.error(`Timeline IR 检查失败：${validated.errors.length} 项`);
  validated.errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: planFile,
    includeSecrets: false,
  });
} catch (error) {
  fail(`配置无效：${error.message}`, 2);
}
const graph = compileGraph(validated, loadedConfig);
const graphFile = path.resolve(
  option("--graph", `${validated.output}.render-graph.json`),
);
if (action === "validate") {
  console.log(JSON.stringify({
    status: "pass",
    plan: planFile,
    durationSeconds: validated.duration,
    renderDurationSeconds: graph.durationSeconds,
    previewRange: graph.previewRange,
    events: {
      edl: validated.edl.length,
      breathing: validated.plan.visual?.breathing?.length ?? 0,
      overlays: validated.plan.visual?.overlays?.length ?? 0,
      sfx: validated.plan.audio?.sfx?.length ?? 0,
    },
    graphDigest: graph.digest,
  }, null, 2));
  process.exit(0);
}
writeJsonAtomic(graphFile, graph);
if (action === "compile") {
  console.log(JSON.stringify({
    status: "pass",
    plan: planFile,
    output: graphFile,
    graphDigest: graph.digest,
    durationSeconds: graph.durationSeconds,
  }, null, 2));
  process.exit(0);
}
try {
  const result = render(validated, graph, graphFile, loadedConfig);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  fail(error.message);
}
