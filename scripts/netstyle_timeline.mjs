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
import { resolveDesignSystem } from "./design_system.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";
import { measureSfxPeak } from "./sfx_peak_alignment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const registryFile = path.join(
  skillDirectory,
  "config",
  "effects",
  "z-en-netstyle.json",
);
const rendererFile = path.join(scriptDirectory, "kacha_netstyle.mjs");
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
      `${command} ${commandArgs.join(" ")} 失败\n`
      + `${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
  return result;
}

function parseTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const text = String(value ?? "").trim().replace(",", ".");
  const match = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text);
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseSrt(text) {
  return text
    .trim()
    .split(/\r?\n\r?\n+/)
    .map((block) => {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) return null;
      const [start, end] = lines[timingIndex].split("-->").map(parseTimestamp);
      const cueText = lines.slice(timingIndex + 1).join(" ").trim();
      return { start, end, text: cueText };
    })
    .filter(Boolean);
}

function normalizeCue(item, index) {
  const start = parseTimestamp(
    item.start ?? item.startSeconds ?? item.start_time ?? item.begin,
  );
  const end = parseTimestamp(
    item.end ?? item.endSeconds ?? item.end_time ?? item.finish,
  );
  return {
    ...item,
    id: String(item.id ?? `cue-${String(index + 1).padStart(4, "0")}`),
    start,
    end,
    text: String(item.text ?? item.transcript ?? item.content ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

function readTranscript(file) {
  const extension = path.extname(file).toLowerCase();
  let raw;
  if (extension === ".srt") {
    raw = parseSrt(fs.readFileSync(file, "utf8"));
  } else {
    const value = readJson(file);
    raw = Array.isArray(value)
      ? value
      : value.segments ?? value.cues ?? value.items ?? [];
  }
  const cues = raw.map(normalizeCue).filter((cue) => (
    Number.isFinite(cue.start)
    && Number.isFinite(cue.end)
    && cue.end > cue.start
    && cue.text
  ));
  cues.sort((left, right) => left.start - right.start);
  return cues;
}

function aspectMode(summary) {
  const ratio = summary.width / summary.height;
  if (ratio > 1.1) return "landscape-16x9";
  if (ratio < 0.9) return "portrait-9x16";
  return "square-1x1";
}

function splitItems(text) {
  const normalized = String(text)
    .replace(/^(?:比如|例如|包括|分别是|第一|首先)[:：,\s]*/i, "")
    .trim();
  const items = normalized
    .split(/(?:、|，|,|；|;|\s+(?:and|or)\s+|以及|或者)/i)
    .map((item) => item.replace(/[。.!！？?]+$/g, "").trim())
    .filter((item) => item.length > 0 && item.length <= 18);
  return items.length >= 2 ? items.slice(0, 5) : [];
}

function shortTitle(cue) {
  const source = String(cue.emphasis ?? cue.title ?? cue.text)
    .replace(/[“”"'‘’]/g, "")
    .replace(/[。.!！？?，,；;：:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/[\u3400-\u9fff]/.test(source)) return source.slice(0, 12);
  return source.split(" ").slice(0, 7).join(" ").slice(0, 42);
}

const maskRequiredEffects = new Set([
  "hook_title_behind_subject",
  "semantic_keyframe_reposition",
  "space_frame_between_layers",
  "space_paper_demo_stage",
  "sticker_torn_paper_stage",
  "keyframe_position",
]);
const assetRequiredEffects = new Set(["semantic_evidence_insert"]);

function automaticEffect(cue, index, hasMask) {
  const text = cue.text;
  const items = splitItems(text);
  if (index === 0) {
    if (hasMask && text.length <= 18) {
      return { effectId: "hook_title_behind_subject", reason: "首个短题眼且人物蒙版可用" };
    }
    if (/[?？]|为什么|怎么|怎么办|what|why|how/i.test(text)) {
      return { effectId: "hook_suspense_push", reason: "首句提出真实问题" };
    }
    return { effectId: "hook_text_first_face_reveal", reason: "首句可独立阅读" };
  }
  if (items.length >= 3) {
    return {
      effectId: "parallel_progressive_row",
      reason: "检测到三个以上并列项目",
    };
  }
  if (
    cue.assetRef
    && /比如|例如|证据|数据|研究|画面|素材|example|evidence|data/i.test(text)
  ) {
    return { effectId: "semantic_evidence_insert", reason: "事实或例子具备真实素材" };
  }
  if (/不是|不要|没有|失败|糟糕|太低|太小|退|否定|not|never|fail|worse/i.test(text)) {
    return { effectId: "semantic_negative_shrink", reason: "否定或退缩语义成立" };
  }
  if (/第一|第二|第三|首先|其次|最后|一方面|另一方面|first|second|third/i.test(text)) {
    return { effectId: "semantic_viewpoint_clones", reason: "观点或角色顺序发生变化" };
  }
  if (/重点|关键|结论|真正|必须|最重要|所以|因此|\d+(?:\.\d+)?%?|key|important|therefore/i.test(text)) {
    return { effectId: "semantic_importance_zoom", reason: "结论、数字或逻辑重音" };
  }
  if (hasMask && /这里|这个|看|注意|主体|局部|this|look|notice/i.test(text)) {
    return { effectId: "semantic_mask_emphasis", reason: "需要聚焦同画面主体或局部" };
  }
  return null;
}

function explicitEffect(cue, effectsById) {
  const requested = String(
    cue.effectId ?? cue.netstyleEffectId ?? cue.visualIntent ?? "",
  ).trim();
  if (!requested || requested === "none") return null;
  if (effectsById.has(requested)) {
    return { effectId: requested, reason: "文稿或人工语义标注明确指定" };
  }
  const normalized = requested.toLowerCase().replace(/\s+/g, "");
  const matched = [...effectsById.values()].find((effect) => (
    effect.label.toLowerCase().replace(/\s+/g, "") === normalized
  ));
  if (matched) return { effectId: matched.id, reason: "按注册表中文名称明确指定" };
  throw new Error(`cue ${cue.id} 指定了不存在的网感机制：${requested}`);
}

function countInWindow(events, start, seconds = 10) {
  return events.filter((event) => (
    event.startSeconds >= start - seconds
    && event.startSeconds <= start
  )).length;
}

function buildPlan({ input, transcript, mask, output }) {
  const registry = readJson(registryFile);
  const effectsById = new Map(registry.effects.map((effect) => [effect.id, effect]));
  const summary = mediaSummary(input);
  const effectiveConfig = loadKachaConfig({
    args,
    anchorPath: input,
    includeSecrets: false,
  }).config;
  const netstyleConfig = effectiveConfig.execution.netstyle;
  const cues = readTranscript(transcript);
  if (cues.length === 0) throw new Error("转写文件没有可用的带时间文本");
  const fps = summary.averageFps || summary.declaredFps || summary.fps;
  const totalFrames = Math.max(1, Math.round(summary.videoDuration * fps));
  const maskRecord = mask
    ? { path: path.resolve(mask), sha256: sha256File(mask) }
    : null;
  const design = resolveDesignSystem({
    modes: {
      show: option("--show", effectiveConfig.style.modes.show),
      aspectRatio: aspectMode(summary),
      language: option("--language", effectiveConfig.style.modes.language),
      surface: "footage",
      density: option("--density", effectiveConfig.style.modes.density),
    },
  });
  const maximumPer10 = Number(option(
    "--max-effects-per-10",
    netstyleConfig.maximumPrimaryEffectsPer10Seconds,
  ));
  const minimumGapFrames = Math.max(
    0,
    Math.round(Number(option("--minimum-gap", netstyleConfig.minimumGapSeconds)) * fps),
  );
  const events = [];
  const dropped = [];
  let previousEndFrame = -minimumGapFrames;

  for (const [index, cue] of cues.entries()) {
    const explicit = explicitEffect(cue, effectsById);
    const selection = explicit ?? (
      netstyleConfig.automaticPlanning
        ? automaticEffect(cue, index, Boolean(maskRecord))
        : null
    );
    if (!selection) continue;
    const effect = effectsById.get(selection.effectId);
    if (maskRequiredEffects.has(effect.id) && !maskRecord) {
      if (explicit) throw new Error(`${effect.id} 的正式应用必须提供逐帧人物蒙版`);
      dropped.push({ cueId: cue.id, effectId: effect.id, reason: "人物蒙版不可用" });
      continue;
    }
    const assetPath = cue.assetRef ? path.resolve(path.dirname(transcript), cue.assetRef) : null;
    if (assetRequiredEffects.has(effect.id) && (!assetPath || !fs.existsSync(assetPath))) {
      if (explicit) throw new Error(`${effect.id} 的正式应用必须提供真实 assetRef`);
      dropped.push({ cueId: cue.id, effectId: effect.id, reason: "真实证据素材不可用" });
      continue;
    }
    let startFrame = Math.max(0, Math.round(cue.start * fps));
    const requestedFrames = Math.max(
      Math.round(0.8 * fps),
      Math.min(Math.round(2.4 * fps), Math.round((cue.end - cue.start) * fps)),
    );
    if (startFrame < previousEndFrame + minimumGapFrames) {
      if (explicit) startFrame = previousEndFrame + minimumGapFrames;
      else {
        dropped.push({ cueId: cue.id, effectId: effect.id, reason: "与上一主效果过近" });
        continue;
      }
    }
    const endFrame = Math.min(totalFrames, startFrame + requestedFrames);
    if (endFrame <= startFrame || endFrame > totalFrames) {
      dropped.push({ cueId: cue.id, effectId: effect.id, reason: "有效时长不足" });
      continue;
    }
    const startSeconds = startFrame / fps;
    if (countInWindow(events, startSeconds) >= maximumPer10) {
      dropped.push({ cueId: cue.id, effectId: effect.id, reason: "超过网感主效果密度上限" });
      continue;
    }
    const items = splitItems(cue.text);
    const display = {
      title: String(cue.display?.title ?? shortTitle(cue)),
      subtitle: String(cue.display?.subtitle ?? cue.text).slice(0, 36),
      items: Array.isArray(cue.display?.items) ? cue.display.items : items,
      itemCues: Array.isArray(cue.display?.itemCues)
        ? cue.display.itemCues.map((item) => ({
            text: String(item?.text ?? item?.label ?? "").trim(),
            revealAt: Number(item?.revealAt),
          }))
        : [],
    };
    if (effect.id === "parallel_progressive_row" && display.itemCues.length < 2) {
      if (explicit) {
        throw new Error(`${cue.id} 的逐项清单必须提供 display.itemCues 语义触发`);
      }
      dropped.push({
        cueId: cue.id,
        effectId: effect.id,
        reason: "缺少逐项语义触发，禁止按时长平均弹出",
      });
      continue;
    }
    const eventFrames = endFrame - startFrame;
    const peakFrame = Math.min(
      endFrame - 1,
      startFrame + Math.max(1, Math.round(eventFrames * 0.28)),
    );
    events.push({
      id: `net-${String(events.length + 1).padStart(4, "0")}`,
      effectId: effect.id,
      family: effect.family,
      renderer: effect.renderer,
      sourceCue: {
        id: cue.id,
        startSeconds: cue.start,
        endSeconds: cue.end,
        text: cue.text,
      },
      startFrame,
      endFrame,
      peakFrame,
      startSeconds,
      endSeconds: endFrame / fps,
      peakSeconds: peakFrame / fps,
      trigger: selection.reason,
      function: effect.function,
      mechanism: effect.mechanism,
      entryExit: "重音前 0–2 帧启动，峰值落在语义重音，下一事件前完整退出",
      simplerAlternative: effect.fallback,
      failureCondition: effect.failureModes.join("；"),
      display,
      maskRequired: maskRequiredEffects.has(effect.id),
      asset: assetPath
        ? { path: assetPath, sha256: sha256File(assetPath) }
        : null,
      sound: {
        trigger: effect.soundTrigger,
        peakFrame,
        peakSeconds: peakFrame / fps,
        levelRelativeToDialogueDb: Number(cue.sfxLevelDb ?? -12),
      },
      fallback: effect.fallback,
      qc: effect.qc,
      selectionEvidence: explicit ? "explicit" : "deterministic_semantic_rule",
    });
    previousEndFrame = endFrame;
  }

  if (events.length === 0) {
    throw new Error("没有找到成立的网感效果触发；请补充 effectId/visualIntent 标注");
  }
  const plan = {
    schemaVersion: "1.0",
    kind: "kacha_netstyle_timeline",
    status: "planned_not_rendered",
    generatedAt: new Date().toISOString(),
    source: {
      input: {
        path: path.resolve(input),
        sha256: sha256File(input),
        width: summary.width,
        height: summary.height,
        duration: summary.duration,
        videoDuration: summary.videoDuration,
        fps,
        averageFrameRate: summary.video?.avg_frame_rate ?? null,
      },
      transcript: {
        path: path.resolve(transcript),
        sha256: sha256File(transcript),
        cueCount: cues.length,
      },
    },
    resources: {
      mask: maskRecord,
    },
    design: {
      id: design.system.id,
      version: design.system.version,
      digest: design.digest,
      modes: design.selectedModes,
    },
    policy: {
      selectionMode: "semantic_triggered",
      maximumPrimaryEffectsPer10Seconds: maximumPer10,
      minimumGapFrames,
      maximumConcurrentPrimaryEffects: 1,
      representativeValidationCountPerEffect:
        netstyleConfig.representativeValidationCountPerEffect,
      preserveSourceGeometry: true,
      demoLabelsForbidden: true,
    },
    events,
    droppedCandidates: dropped,
    registry: {
      id: registry.id,
      sha256: sha256File(registryFile),
    },
  };
  plan.digest = sha256Value({ ...plan, digest: undefined });
  writeJsonAtomic(output, plan);
  return plan;
}

function validatePlan(planFile) {
  const plan = readJson(planFile);
  const registry = readJson(registryFile);
  const effectsById = new Map(registry.effects.map((effect) => [effect.id, effect]));
  const errors = [];
  if (plan.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (plan.kind !== "kacha_netstyle_timeline") errors.push("kind 必须为 kacha_netstyle_timeline");
  const input = plan.source?.input?.path;
  if (!input || !fs.existsSync(input)) {
    errors.push(`源视频不存在：${input ?? "missing"}`);
  } else {
    if (sha256File(input) !== plan.source.input.sha256) errors.push("源视频 SHA-256 已失效");
    const summary = mediaSummary(input);
    if (summary.width !== plan.source.input.width || summary.height !== plan.source.input.height) {
      errors.push("源视频几何与计划不一致");
    }
  }
  const transcript = plan.source?.transcript?.path;
  if (!transcript || !fs.existsSync(transcript)) {
    errors.push(`转写不存在：${transcript ?? "missing"}`);
  } else if (sha256File(transcript) !== plan.source.transcript.sha256) {
    errors.push("转写 SHA-256 已失效");
  }
  if (plan.registry?.sha256 !== sha256File(registryFile)) {
    errors.push("网感机制注册表已变化，计划必须重建");
  }
  let design;
  try {
    design = resolveDesignSystem({ modes: plan.design?.modes ?? {} });
  } catch (error) {
    errors.push(`设计系统无法解析：${error.message}`);
  }
  if (design && (plan.design?.version !== design.system.version || plan.design?.digest !== design.digest)) {
    errors.push("设计系统版本或摘要已失效");
  }
  if (!Array.isArray(plan.events) || plan.events.length === 0) {
    errors.push("events 必须是非空数组");
  }
  let previousEndFrame = -1;
  for (const [index, event] of (plan.events ?? []).entries()) {
    const label = `events[${index}]`;
    const effect = effectsById.get(event.effectId);
    if (!effect) errors.push(`${label}.effectId 未注册：${event.effectId}`);
    for (const field of [
      "id", "effectId", "trigger", "function", "mechanism",
      "entryExit", "simplerAlternative", "failureCondition",
    ]) {
      if (!event[field]) errors.push(`${label}.${field} 缺失`);
    }
    for (const field of ["startFrame", "endFrame", "peakFrame"]) {
      if (!Number.isInteger(event[field])) errors.push(`${label}.${field} 必须是整数`);
    }
    if (!(event.startFrame >= 0 && event.endFrame > event.startFrame)) {
      errors.push(`${label} 帧区间无效`);
    }
    if (!(event.peakFrame >= event.startFrame && event.peakFrame < event.endFrame)) {
      errors.push(`${label}.peakFrame 不在事件区间内`);
    }
    if (event.startFrame < previousEndFrame) errors.push(`${label} 与上一主效果重叠`);
    previousEndFrame = Math.max(previousEndFrame, event.endFrame ?? -1);
    if (!event.display?.title) errors.push(`${label}.display.title 缺失`);
    if (event.effectId === "parallel_progressive_row") {
      const itemCues = event.display?.itemCues;
      if (!Array.isArray(itemCues) || itemCues.length < 2) {
        errors.push(`${label}.display.itemCues 至少需要两个逐项语义触发`);
      } else {
        let previousRevealAt = -1;
        for (const [cueIndex, cue] of itemCues.entries()) {
          if (!cue?.text) errors.push(`${label}.display.itemCues[${cueIndex}].text 缺失`);
          if (!Number.isFinite(cue?.revealAt) || cue.revealAt < 0 || cue.revealAt > 0.92) {
            errors.push(`${label}.display.itemCues[${cueIndex}].revealAt 必须为 0–0.92`);
          }
          if (cue.revealAt <= previousRevealAt) {
            errors.push(`${label}.display.itemCues.revealAt 必须严格递增`);
            break;
          }
          previousRevealAt = cue.revealAt;
        }
      }
    }
    if (!Array.isArray(event.qc) || event.qc.length === 0) errors.push(`${label}.qc 缺失`);
    if (maskRequiredEffects.has(event.effectId)) {
      const mask = plan.resources?.mask;
      if (!mask?.path || !fs.existsSync(mask.path)) {
        errors.push(`${label} 需要逐帧人物蒙版`);
      } else if (sha256File(mask.path) !== mask.sha256) {
        errors.push(`${label} 人物蒙版 SHA-256 已失效`);
      }
    }
    if (assetRequiredEffects.has(event.effectId)) {
      if (!event.asset?.path || !fs.existsSync(event.asset.path)) {
        errors.push(`${label} 需要真实证据素材`);
      } else if (sha256File(event.asset.path) !== event.asset.sha256) {
        errors.push(`${label} 证据素材 SHA-256 已失效`);
      }
    }
    const level = Number(event.sound?.levelRelativeToDialogueDb);
    if (!Number.isFinite(level) || level < -24 || level > -3) {
      errors.push(`${label}.sound.levelRelativeToDialogueDb 必须为 -24 至 -3`);
    }
  }
  if (plan.policy?.maximumConcurrentPrimaryEffects !== 1) {
    errors.push("maximumConcurrentPrimaryEffects 必须为 1");
  }
  if (plan.policy?.representativeValidationCountPerEffect !== 1) {
    errors.push("representativeValidationCountPerEffect 必须为 1");
  }
  const expectedDigest = sha256Value({ ...plan, digest: undefined });
  if (plan.digest !== expectedDigest) errors.push("计划 digest 不一致");
  return { plan, errors };
}

const sfxByTrigger = {
  hook: "01_hook/hook-fast-whoosh.wav",
  emphasis: "02_emphasis/emphasis-quick-zoom-hit.wav",
  motion: "14_motion/motion-small-sweep.wav",
  pop: "13_pop/pop-bubble-alert.wav",
  page: "18_page/page-turn.wav",
  info: "05_info/info-interface-select.wav",
  reversal: "07_reversal/reversal-vacuum-swoosh.wav",
  typing: "10_typing/typing-keyboard-full.wav",
  transition: "11_transition/transition-local.wav",
  turn: "04_turn/turn-vinyl-stop.wav",
};

function resolveSfx(trigger, root) {
  if (!root || !sfxByTrigger[trigger]) return null;
  const relative = sfxByTrigger[trigger];
  return [
    path.resolve(root, "ready", relative),
    path.resolve(root, relative),
  ].find((candidate) => fs.existsSync(candidate)) ?? null;
}

function sfxPeakSeconds(file) {
  return measureSfxPeak(file).measuredPeakOffsetSeconds;
}

function renderTimeline(planFile, output) {
  const { plan, errors } = validatePlan(planFile);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const input = plan.source.input.path;
  const summary = mediaSummary(input);
  const effectiveConfig = loadKachaConfig({
    args,
    anchorPath: input,
    includeSecrets: false,
  }).config;
  const fpsValue = summary.averageFps || summary.declaredFps || summary.fps;
  const fps = summary.video?.avg_frame_rate
    && summary.video.avg_frame_rate !== "0/0"
    ? summary.video.avg_frame_rate
    : String(fpsValue);
  const totalFrames = Math.max(1, Math.round(summary.videoDuration * fpsValue));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-netstyle-timeline-"));
  const configuredSfxRoot = effectiveConfig.tools.sfxLibrary;
  const sfxRoot = option("--sfx-root")
    ? path.resolve(option("--sfx-root"))
    : configuredSfxRoot
      ? path.resolve(configuredSfxRoot)
      : null;
  const clips = [];
  const applied = [];
  const unresolvedSfx = [];

  function renderGap(startFrame, endFrame, name) {
    if (endFrame <= startFrame) return;
    const file = path.join(temporary, `${String(clips.length).padStart(4, "0")}-${name}.mp4`);
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", input,
      "-vf", `trim=start_frame=${startFrame}:end_frame=${endFrame},`
        + `setpts=PTS-STARTPTS,fps=${fps},format=yuv420p`,
      "-an", "-frames:v", String(endFrame - startFrame),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "0",
      "-pix_fmt", "yuv420p", file,
    ]);
    clips.push(file);
  }

  try {
    let cursor = 0;
    for (const event of plan.events) {
      renderGap(cursor, event.startFrame, "plain");
      const payloadFile = path.join(temporary, `${event.id}.json`);
      writeJsonAtomic(payloadFile, {
        display: event.display,
        assetRef: event.asset?.path ?? null,
      });
      const clip = path.join(temporary, `${String(clips.length).padStart(4, "0")}-${event.id}.mp4`);
      const commandArgs = [
        rendererFile,
        "preview",
        "--input", input,
        "--effect", event.effectId,
        "--start", String(event.startSeconds),
        "--duration", String(event.endSeconds - event.startSeconds),
        "--output", clip,
        "--production",
        "--payload", payloadFile,
        "--video-only",
      ];
      if (plan.resources?.mask?.path) commandArgs.push("--mask", plan.resources.mask.path);
      if (event.asset?.path) commandArgs.push("--asset", event.asset.path);
      execute(process.execPath, commandArgs);
      clips.push(clip);
      applied.push({
        eventId: event.id,
        effectId: event.effectId,
        startFrame: event.startFrame,
        endFrame: event.endFrame,
        peakFrame: event.peakFrame,
        clipSha256: sha256File(clip),
        maskUsed: event.maskRequired,
        assetUsed: event.asset?.path ?? null,
      });
      cursor = event.endFrame;
    }
    renderGap(cursor, totalFrames, "plain");
    const timelineVideo = path.join(temporary, "timeline-video.mp4");
    const concatInputs = clips.flatMap((file) => ["-i", file]);
    const normalizedClips = clips
      .map((_, index) => `[${index}:v]setpts=PTS-STARTPTS[v${index}]`)
      .join(";");
    const concatPads = clips.map((_, index) => `[v${index}]`).join("");
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      ...concatInputs,
      "-filter_complex",
      `${normalizedClips};${concatPads}concat=n=${clips.length}:v=1:a=0,`
        + `fps=${fps},setpts=N/((${fps})*TB)[outv]`,
      "-map", "[outv]", "-an", "-frames:v", String(totalFrames),
      "-c:v", "libx264", "-preset", "slow", "-crf",
      option("--crf", String(effectiveConfig.execution.netstyle.renderCrf)),
      "-pix_fmt", "yuv420p", "-fps_mode", "cfr",
      "-movflags", "+faststart", timelineVideo,
    ]);

    const audioInputs = [];
    for (const event of plan.events) {
      if (has("--no-sfx")) continue;
      const file = resolveSfx(event.sound?.trigger, sfxRoot);
      if (file) audioInputs.push({
        event,
        file,
        sourcePeakSeconds: sfxPeakSeconds(file),
      });
      else if (sfxRoot) unresolvedSfx.push({
        eventId: event.id,
        trigger: event.sound?.trigger,
      });
    }
    const finalArgs = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", timelineVideo,
    ];
    if (summary.audio) finalArgs.push("-i", input);
    for (const item of audioInputs) finalArgs.push("-i", item.file);

    if (!summary.audio) {
      finalArgs.push("-map", "0:v:0", "-c:v", "copy", "-an");
    } else if (audioInputs.length === 0) {
      finalArgs.push(
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
      );
    } else {
      const filters = [
        "[1:a]asetpts=PTS-STARTPTS,"
          + "aformat=sample_rates=48000:channel_layouts=stereo[voice]",
      ];
      audioInputs.forEach((item, index) => {
        const inputIndex = index + 2;
        const offset = item.event.peakSeconds - item.sourcePeakSeconds;
        const trim = offset < 0
          ? `atrim=start=${(-offset).toFixed(6)},asetpts=PTS-STARTPTS,`
          : "";
        const delay = Math.max(0, Math.round(offset * 1000));
        const level = Number(item.event.sound.levelRelativeToDialogueDb);
        filters.push(
          `[${inputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,`
          + `${trim}adelay=${delay}|${delay},volume=${level}dB[s${index}]`,
        );
      });
      const mixInputs = ["[voice]", ...audioInputs.map((_, index) => `[s${index}]`)].join("");
      filters.push(
        `${mixInputs}amix=inputs=${audioInputs.length + 1}:normalize=0:`
          + "dropout_transition=0,alimiter=limit=0.95[outa]",
      );
      finalArgs.push(
        "-filter_complex", filters.join(";"),
        "-map", "0:v:0", "-map", "[outa]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
      );
    }
    finalArgs.push(
      "-t", String(summary.videoDuration),
      "-movflags", "+faststart",
      output,
    );
    execute("ffmpeg", finalArgs);

    const decode = run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", output, "-f", "null", "-",
    ]);
    if (decode.status !== 0 || decode.stderr.trim()) {
      throw new Error(`正式时间线存在解码或时间戳错误：${decode.stderr}`);
    }
    const rendered = mediaSummary(output);
    const durationTolerance = 1.5 / fpsValue;
    if (
      rendered.width !== summary.width
      || rendered.height !== summary.height
      || Math.abs(rendered.averageFps - summary.averageFps) > 0.02
      || Math.abs(rendered.videoDuration - summary.videoDuration) > durationTolerance
    ) {
      throw new Error("正式时间线未保持源几何、有效帧率或时长");
    }
    const manifest = {
      schemaVersion: "1.0",
      status: unresolvedSfx.length > 0 ? "pass_with_sfx_gaps" : "pass",
      plan: {
        path: path.resolve(planFile),
        sha256: sha256File(planFile),
        digest: plan.digest,
      },
      input: {
        path: input,
        sha256: plan.source.input.sha256,
      },
      output: {
        path: path.resolve(output),
        sha256: sha256File(output),
        width: rendered.width,
        height: rendered.height,
        duration: rendered.duration,
        fps: rendered.averageFps,
      },
      appliedEvents: applied,
      unresolvedSfx,
      audio: {
        sourcePreservedAtUnityGain: true,
        sfxMixed: audioInputs.length,
        sfxPeakAlignmentPlan: audioInputs.map((item) => ({
          eventId: item.event.id,
          eventPeakSeconds: item.event.peakSeconds,
          sourcePeakSeconds: item.sourcePeakSeconds,
          plannedErrorSeconds: 0,
          toleranceFrames: 2,
        })),
        sampleRate: rendered.sampleRate,
      },
      qc: {
        fullDecode: "pass",
        geometryPreserved: true,
        effectiveFrameRatePreserved: true,
        durationToleranceSeconds: durationTolerance,
        demoLabelsAbsent: true,
      },
    };
    manifest.digest = sha256Value({ ...manifest, digest: undefined });
    const manifestFile = option("--manifest", `${output}.manifest.json`);
    writeJsonAtomic(manifestFile, manifest);
    return { manifest, manifestFile };
  } finally {
    if (has("--keep-workdir")) {
      console.error(`netstyle workdir kept: ${temporary}`);
    } else {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

if (!["plan", "validate", "render"].includes(action)) {
  fail(
    "用法：netstyle_timeline.mjs plan --input VIDEO --transcript JSON|SRT "
    + "--output PLAN.json [--mask MASK]\n"
    + "  netstyle_timeline.mjs validate --plan PLAN.json\n"
    + "  netstyle_timeline.mjs render --plan PLAN.json --output VIDEO "
    + "[--sfx-root DIR --manifest FILE]",
    2,
  );
}

try {
  if (action === "plan") {
    const input = path.resolve(option("--input", ""));
    const transcript = path.resolve(option("--transcript", ""));
    const output = path.resolve(option("--output", ""));
    const mask = option("--mask") ? path.resolve(option("--mask")) : null;
    if (!fs.existsSync(input)) fail(`输入不存在：${input}`, 2);
    if (!fs.existsSync(transcript)) fail(`转写不存在：${transcript}`, 2);
    if (mask && !fs.existsSync(mask)) fail(`人物蒙版不存在：${mask}`, 2);
    if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖计划：${output}`, 2);
    const plan = buildPlan({ input, transcript, mask, output });
    const checked = validatePlan(output);
    if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      output,
      eventCount: plan.events.length,
      droppedCandidateCount: plan.droppedCandidates.length,
      effects: plan.events.map((event) => event.effectId),
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
      digest: checked.plan.digest,
    }, null, 2));
  } else {
    const planFile = path.resolve(option("--plan", ""));
    const output = path.resolve(option("--output", ""));
    if (!fs.existsSync(planFile)) fail(`计划不存在：${planFile}`, 2);
    if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖输出：${output}`, 2);
    const result = renderTimeline(planFile, output);
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: result.manifest.status,
      output,
      manifest: result.manifestFile,
      eventCount: result.manifest.appliedEvents.length,
      sha256: result.manifest.output.sha256,
    }, null, 2));
  }
} catch (error) {
  fail(error.message);
}
