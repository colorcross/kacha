#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  readJson,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const defaultPolicyFile = path.join(
  skillRoot,
  "config",
  "audio",
  "adaptive-bgm-policy.json",
);

const ROLE_ALIASES = {
  opening: "hook",
  opening_promise: "hook",
  premise: "setup",
  development: "explanation",
  demonstration: "process",
  demo: "process",
  proof: "evidence",
  data: "evidence",
  factual: "evidence",
  verified_result: "result",
  call_to_action: "conclusion",
  cta: "conclusion",
};

function usage() {
  console.error(
    "用法：\n"
      + "  adaptive_bgm.mjs plan --cues CUES.json --show "
      + "tool-share|book-talk|infinite-game|very-ai --output PLAN.json "
      + "[--style STYLE] [--duration SECONDS] [--policy FILE]\n"
      + "  adaptive_bgm.mjs validate --plan PLAN.json [--policy FILE]",
  );
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function finite(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits));

}

function stableDigest(value) {
  const copy = structuredClone(value);
  delete copy.digest;
  delete copy.generatedAt;
  return sha256Value(copy);
}

function normalizedSignals(cue) {
  const values = [
    ...(Array.isArray(cue.signals) ? cue.signals : []),
    ...(Array.isArray(cue.tags) ? cue.tags : []),
  ];
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
}

function cueArray(value) {
  const candidates = value.cues ?? value.segments ?? value.transcript?.segments ?? value;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("输入必须包含非空 cues/segments 数组");
  }
  const normalized = candidates.map((cue, index) => {
    const start = finite(cue.start ?? cue.startSeconds);
    const end = finite(cue.end ?? cue.endSeconds);
    if (start === null || end === null || start < 0 || end <= start) {
      throw new Error(`cues[${index}] 时间区间无效`);
    }
    return {
      id: String(cue.id ?? `cue-${String(index + 1).padStart(4, "0")}`),
      start: round(start),
      end: round(end),
      text: String(cue.text ?? cue.transcript ?? "").trim(),
      signals: normalizedSignals(cue),
      explicitRole: cue.narrativeRole ?? cue.role ?? cue.semanticRole ?? null,
      explicitEmotion: cue.emotion ?? cue.tone ?? null,
      confidence: clamp(finite(cue.confidence, 1), 0, 1),
    };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const ids = new Set();
  for (const [index, cue] of normalized.entries()) {
    if (ids.has(cue.id)) throw new Error(`cues[${index}].id 重复：${cue.id}`);
    ids.add(cue.id);
    if (index > 0 && cue.start < normalized[index - 1].end - 0.001) {
      throw new Error(`cues[${index}] 与前一段重叠`);
    }
  }
  return normalized;
}

function classifyRole(cue, index, total) {
  const explicit = String(cue.explicitRole ?? "").trim().toLowerCase();
  if (explicit) return ROLE_ALIASES[explicit] ?? explicit;
  const signals = new Set(cue.signals);
  const text = cue.text;
  if (signals.has("fact_check") || /(?:核验|查证|事实核查|来源是否)/.test(text)) {
    return "fact_check";
  }
  if (
    signals.has("uncertainty")
    || signals.has("low_confidence")
    || /(?:可能|尚不确定|无法确认|证据不足|有待验证)/.test(text)
  ) return "uncertainty";
  if (index === 0 || signals.has("hook") || /^(?:为什么|如果|别急|先别|想象|你有没有)/.test(text)) {
    return "hook";
  }
  if (
    signals.has("evidence")
    || signals.has("fact")
    || signals.has("data")
    || /(?:数据显示|研究发现|报告显示|证据|事实是|根据|\d+(?:\.\d+)?%)/.test(text)
  ) return "evidence";
  if (signals.has("humor") || signals.has("punchline") || /(?:好家伙|离谱|笑死|尴尬)/.test(text)) {
    return "humor";
  }
  if (signals.has("transition") || /(?:接下来|换个角度|再来看|进入下一|另一边)/.test(text)) {
    return "transition";
  }
  if (signals.has("process") || signals.has("screen_demo") || /(?:第一步|第二步|然后|点击|打开|输入|操作)/.test(text)) {
    return "process";
  }
  if (signals.has("example") || /(?:举个例子|比如说|例如|具体来说)/.test(text)) {
    return "example";
  }
  if (signals.has("contrast") || /(?:但是|然而|反而|不是.+而是|问题在于)/.test(text)) {
    return "contrast";
  }
  if (signals.has("reflection") || /(?:回头看|想一想|值得思考|真正的问题)/.test(text)) {
    return "reflection";
  }
  if (signals.has("result") || /(?:结果是|终于|完成了|实际效果|最终得到)/.test(text)) {
    return "result";
  }
  if (signals.has("conclusion") || index === total - 1 || /(?:所以|因此|结论|这意味着)/.test(text)) {
    return "conclusion";
  }
  return index < Math.ceil(total * 0.25) ? "setup" : "explanation";
}

function classifyEmotion(cue, role) {
  const explicit = String(cue.explicitEmotion ?? "").trim().toLowerCase();
  if (explicit) return { id: explicit, source: "explicit", confidence: cue.confidence };
  const text = cue.text;
  let id = "neutral";
  if (role === "humor" || /(?:有趣|好玩|笑|离谱)/.test(text)) id = "playful";
  else if (role === "uncertainty") id = "uncertain";
  else if (role === "reflection" || /(?:遗憾|怀念|慢下来|安静)/.test(text)) id = "reflective";
  else if (role === "contrast" || /(?:危险|焦虑|糟糕|失败|警惕)/.test(text)) id = "tense";
  else if (role === "result" || role === "conclusion") id = "resolved";
  else if (role === "hook") id = "curious";
  return { id, source: "inferred", confidence: round(Math.min(cue.confidence, 0.78), 2) };
}

function densityFor(cue) {
  const duration = Math.max(0.1, cue.end - cue.start);
  const compactLength = cue.text.replace(/\s+/g, "").length;
  const charactersPerSecond = compactLength / duration;
  const numericTokens = (cue.text.match(/\d+(?:\.\d+)?%?/g) ?? []).length;
  const properOrQuoted = (cue.text.match(/[“”《》A-Z][^，。！？；]{1,20}/g) ?? []).length;
  const level = charactersPerSecond >= 5 || numericTokens >= 2 || properOrQuoted >= 2
    ? "high"
    : charactersPerSecond >= 3.2 || numericTokens === 1
      ? "medium"
      : "low";
  return {
    level,
    charactersPerSecond: round(charactersPerSecond, 2),
    numericTokens,
    properOrQuotedTokens: properOrQuoted,
  };
}

function musicDecision(cue, role, density, profile) {
  const signals = new Set(cue.signals);
  if (
    signals.has("music_off")
    || signals.has("silence")
    || signals.has("environment_priority")
    || role === "fact_check"
    || role === "uncertainty"
  ) return { enabled: false, reason: "事实边界、留白或环境声优先" };
  if (!profile.defaultRolesWithMusic.includes(role)) {
    return { enabled: false, reason: "当前栏目在该叙事功能下默认保留纯人声" };
  }
  if (role === "evidence" && density.level !== "low") {
    return { enabled: false, reason: "数据、名称或证据密度较高，音乐退出以保护理解" };
  }
  if (signals.has("music_on")) return { enabled: true, reason: "语义 cue 明确要求音乐进入" };
  return { enabled: true, reason: "栏目音乐语法允许，且能增强当前叙事功能" };
}

function intensityBucket(role, policy) {
  const energy = finite(policy.narrativeFunctions?.[role]?.energy, 0.25);
  if (energy >= 0.58) return "high";
  if (energy >= 0.34) return "medium";
  return "low";
}

function rawScenes(cues, duration, profile, policy) {
  const result = [];
  let cursor = 0;
  const pushSilence = (start, end, reason) => {
    if (end - start <= 0.001) return;
    result.push({
      start: round(start),
      end: round(end),
      mode: "silence",
      roles: ["silence"],
      emotions: ["neutral"],
      density: "low",
      cueIds: [],
      reasons: [reason],
      analysis: [],
    });
  };
  for (const [index, cue] of cues.entries()) {
    if (cue.start > cursor + 0.001) pushSilence(cursor, cue.start, "没有对白语义，保留环境声或真实留白");
    const role = classifyRole(cue, index, cues.length);
    const emotion = classifyEmotion(cue, role);
    const density = densityFor(cue);
    const decision = musicDecision(cue, role, density, profile);
    result.push({
      start: cue.start,
      end: cue.end,
      mode: decision.enabled ? "music" : "silence",
      roles: [role],
      emotions: [emotion.id],
      density: density.level,
      cueIds: [cue.id],
      reasons: [decision.reason],
      analysis: [{
        cueId: cue.id,
        role,
        emotion,
        density,
        confidence: cue.confidence,
      }],
      intensity: decision.enabled ? intensityBucket(role, policy) : "none",
    });
    cursor = cue.end;
  }
  if (cursor < duration - 0.001) pushSilence(cursor, duration, "对白结束后不自动续铺音乐");
  return result;
}

function sceneSignature(scene) {
  if (scene.mode === "silence") return "silence";
  return `${scene.mode}:${scene.intensity}`;
}

function mergeScenes(scenes, minimumSeconds) {
  const merged = [];
  for (const scene of scenes) {
    const previous = merged.at(-1);
    const compatible = previous
      && Math.abs(previous.end - scene.start) <= 0.002
      && sceneSignature(previous) === sceneSignature(scene)
      && (
        previous.mode === "silence"
        || (previous.end - previous.start < minimumSeconds)
        || (scene.end - scene.start < minimumSeconds)
      );
    if (!compatible) {
      merged.push(structuredClone(scene));
      continue;
    }
    previous.end = scene.end;
    previous.roles = [...new Set([...previous.roles, ...scene.roles])];
    previous.emotions = [...new Set([...previous.emotions, ...scene.emotions])];
    previous.cueIds.push(...scene.cueIds);
    previous.reasons = [...new Set([...previous.reasons, ...scene.reasons])];
    previous.analysis.push(...scene.analysis);
    if (scene.density === "high" || (scene.density === "medium" && previous.density === "low")) {
      previous.density = scene.density;
    }
  }
  return merged;
}

function splitLongMusicScenes(scenes, maximumSeconds) {
  const result = [];
  for (const scene of scenes) {
    if (scene.mode !== "music" || scene.end - scene.start <= maximumSeconds + 0.001) {
      result.push(scene);
      continue;
    }
    const count = Math.ceil((scene.end - scene.start) / maximumSeconds);
    const length = (scene.end - scene.start) / count;
    for (let index = 0; index < count; index += 1) {
      result.push({
        ...structuredClone(scene),
        start: round(scene.start + length * index),
        end: round(index === count - 1 ? scene.end : scene.start + length * (index + 1)),
        variationIndex: index,
        reasons: [...scene.reasons, "长段落按乐句拆分编配，避免同一状态持续过久"],
      });
    }
  }
  return result;
}

function enforceCoverage(scenes, duration, maximumRatio) {
  const result = scenes.map((scene) => structuredClone(scene));
  let excess = result
    .filter((scene) => scene.mode === "music")
    .reduce((sum, scene) => sum + scene.end - scene.start, 0)
    - duration * maximumRatio;
  if (excess <= 0.001) return result;
  const removalPriority = [
    "explanation", "setup", "evidence", "example", "process", "reflection",
    "contrast", "transition", "conclusion", "result", "hook",
  ];
  const ranked = result
    .map((scene, index) => ({ scene, index, role: dominantRole(scene) }))
    .filter((entry) => entry.scene.mode === "music")
    .sort((left, right) => (
      removalPriority.indexOf(left.role) - removalPriority.indexOf(right.role)
      || (right.scene.end - right.scene.start) - (left.scene.end - left.scene.start)
    ));
  for (const entry of ranked) {
    if (excess <= 0.001) break;
    const scene = result[entry.index];
    const sceneDuration = scene.end - scene.start;
    if (sceneDuration <= excess + 0.001) {
      scene.mode = "silence";
      scene.intensity = "none";
      scene.reasons.push("为遵守栏目配乐覆盖上限，主动退出音乐并保留叙事呼吸");
      excess -= sceneDuration;
      continue;
    }
    const keepDuration = sceneDuration - excess;
    const musicPart = { ...structuredClone(scene), end: round(scene.start + keepDuration) };
    const silencePart = {
      ...structuredClone(scene),
      start: musicPart.end,
      mode: "silence",
      intensity: "none",
      reasons: [...scene.reasons, "达到栏目配乐覆盖上限后退出音乐"],
    };
    result.splice(entry.index, 1, musicPart, silencePart);
    excess = 0;
  }
  return result.sort((left, right) => left.start - right.start || left.end - right.end);
}

function dominantRole(scene) {
  const priority = [
    "fact_check", "uncertainty", "hook", "result", "contrast", "transition",
    "humor", "reflection", "evidence", "process", "example", "conclusion",
    "setup", "explanation",
  ];
  return priority.find((role) => scene.roles.includes(role)) ?? scene.roles[0] ?? "explanation";
}

function tempoFor(scene, profile) {
  const [minimum, maximum] = profile.bpmRange;
  const baseRatio = scene.intensity === "high" ? 0.78 : scene.intensity === "medium" ? 0.5 : 0.24;
  const fastSpeech = scene.analysis.some((item) => item.density.charactersPerSecond >= 5);
  return Math.round(minimum + (maximum - minimum) * clamp(baseRatio - (fastSpeech ? 0.12 : 0), 0, 1));
}

function targetBelowDialogue(scene, showId, policy) {
  const targets = policy.universal.mix.targetBelowDialogueDb;
  let value = scene.density === "high"
    ? targets.denseOrFactual
    : ["hook", "result"].includes(dominantRole(scene))
      ? targets.hookOrResult
      : targets.ordinary;
  if (showId === "book-talk") value += 2;
  return clamp(value, targets.range[0], targets.range[1]);
}

function promptFor(scene, profile, showId, policy) {
  const role = dominantRole(scene);
  const functionPolicy = policy.narrativeFunctions[role] ?? policy.narrativeFunctions.explanation;
  const bpm = tempoFor(scene, profile);
  const target = targetBelowDialogue(scene, showId, policy);
  const frequency = policy.universal.frequencyStrategy;
  const variation = finite(scene.variationIndex, 0);
  const instruments = variation % 2 === 0
    ? profile.palette
    : [...profile.palette.slice(1), profile.palette[0]];
  const generationPrompt = [
    `Purpose: underscore a ${role} section in a dialogue-led Chinese editorial video; duration ${round(scene.end - scene.start, 1)} seconds; instrumental only, no vocals.`,
    `Style: ${profile.style}. Tempo: ${bpm} BPM. Meter: ${profile.meter}. Groove: ${profile.groove}.`,
    `Shared identity: preserve one recognizable two-to-four-note motif and the same tonal center across the whole video; this is arrangement state ${variation + 1}, not a different song.`,
    `Arrangement: ${functionPolicy.arrangement}. Instruments: ${instruments.join(", ")}.`,
    `Timbre: ${profile.timbre}. Harmony: ${profile.harmony}; for this scene use ${functionPolicy.harmonicMove}.`,
    `Frequency design: ${frequency.sub}; ${frequency.low}; ${frequency.speechBand}; ${frequency.high}.`,
    `Dynamics and dialogue: restrained macro-dynamics, leave narration at least ${target} dB above the music before final loudness matching, no pumping, no sudden impact under words.`,
    `Stereo: ${frequency.stereo}. Keep the image stable and mono-compatible.`,
    "Edit design: clear four- or eight-bar internal phrases, clean entry, one edit-safe midpoint, 0.8-second usable fade handles, and a resolved dry tail without long reverb.",
  ].join(" ");
  return {
    purpose: role,
    durationSeconds: round(scene.end - scene.start),
    bpm,
    meter: profile.meter,
    groove: profile.groove,
    instruments,
    timbre: profile.timbre,
    harmony: `${profile.harmony}; ${functionPolicy.harmonicMove}`,
    frequencyStrategy: frequency,
    dynamics: `dialogue-first, target ${target} dB below narration, restrained macro-dynamics`,
    stereo: frequency.stereo,
    editPoints: "4/8-bar phrases, clean entry, midpoint, fade handles, dry tail",
    generationPrompt,
    negativePrompt: [
      ...policy.universal.negativePrompt,
      ...profile.avoid,
    ].join(", "),
  };
}

function finalizeScenes(scenes, showId, profile, policy) {
  return scenes.map((scene, index) => {
    const id = `bgm-${String(index + 1).padStart(3, "0")}`;
    const role = dominantRole(scene);
    if (scene.mode === "silence") {
      return {
        id,
        start: scene.start,
        end: scene.end,
        mode: "silence",
        narrativeFunctions: scene.roles,
        emotions: scene.emotions,
        speechDensity: scene.density,
        cueIds: scene.cueIds,
        rationale: scene.reasons.join("；"),
        mixAutomation: { gainDb: null, fadeInSeconds: 0, fadeOutSeconds: 0, sidechain: false },
      };
    }
    const target = targetBelowDialogue(scene, showId, policy);
    const fade = policy.universal.mix.fadeSeconds.default;
    const prompt = promptFor(scene, profile, showId, policy);
    return {
      id,
      start: scene.start,
      end: scene.end,
      mode: "music",
      narrativeFunctions: scene.roles,
      dominantFunction: role,
      emotions: scene.emotions,
      speechDensity: scene.density,
      cueIds: scene.cueIds,
      rationale: scene.reasons.join("；"),
      arrangementState: finite(scene.variationIndex, 0) + 1,
      prompt,
      asset: {
        status: "required",
        placeholder: `@bgm:${id}`,
        requiredFormat: "48 kHz stereo WAV, instrumental, clean head and tail",
        provenanceRequired: true,
      },
      mixAutomation: {
        targetBelowDialogueDb: target,
        fadeInSeconds: Math.min(fade, round((scene.end - scene.start) / 4)),
        fadeOutSeconds: Math.min(fade, round((scene.end - scene.start) / 4)),
        sidechain: structuredClone(policy.universal.mix.sidechain),
        phraseSafeEntry: true,
        phraseSafeExit: true,
      },
    };
  });
}

export function buildAdaptiveBgmPlan(cuesFile, options = {}) {
  const sourceFile = path.resolve(cuesFile ?? "");
  if (!cuesFile || !fs.existsSync(sourceFile)) {
    throw new Error(`语义 cues 不存在：${sourceFile}`);
  }
  const policyFile = path.resolve(options.policyFile ?? defaultPolicyFile);
  const policy = readJson(policyFile);
  const showId = options.showId ?? "tool-share";
  const profile = policy.showProfiles?.[showId];
  if (!profile) throw new Error(`未知栏目：${showId}`);
  const cues = cueArray(readJson(sourceFile));
  const cueDuration = Math.max(...cues.map((cue) => cue.end));
  const duration = finite(options.durationSeconds, cueDuration);
  if (duration < cueDuration - 0.001) throw new Error("--duration 不能短于最后一个 cue");
  const rough = rawScenes(cues, duration, profile, policy);
  const merged = mergeScenes(rough, policy.universal.minimumSceneSeconds);
  const split = splitLongMusicScenes(merged, profile.maximumContinuousMusicSeconds);
  const coverageSafe = enforceCoverage(split, duration, profile.coverageMaximum);
  const scenes = finalizeScenes(coverageSafe, showId, profile, policy);
  const musicSeconds = scenes
    .filter((scene) => scene.mode === "music")
    .reduce((sum, scene) => sum + scene.end - scene.start, 0);
  const plan = {
    schemaVersion: "1.0",
    kind: "kacha-adaptive-bgm-plan",
    generatedAt: new Date().toISOString(),
    source: fileIdentity(sourceFile),
    policy: fileIdentity(policyFile),
    showId,
    styleId: options.styleId ?? "xingzhe",
    durationSeconds: round(duration),
    sharedMusicIdentity: {
      required: true,
      motif: "one reusable two-to-four-note motif",
      tonalCenter: "one shared tonal center with controlled modal color changes",
      paletteRule: "keep one instrument family across adjacent scenes; vary density before replacing timbre",
    },
    coverage: {
      musicSeconds: round(musicSeconds),
      silenceSeconds: round(duration - musicSeconds),
      musicRatio: round(musicSeconds / duration, 4),
      maximumForShow: profile.coverageMaximum,
    },
    renderContract: {
      timelineShape: "audio.bgm.segments[]",
      segmentFields: ["path", "start", "end", "sourceStart", "levelBelowDialogueDb", "fadeInSeconds", "fadeOutSeconds", "sha256", "provenance"],
      sidechainAfterProgramMix: true,
      keepDialogueCenterClear: true,
      exportStems: ["dialogue", "bgm", "sfx", "mix"],
      boundary: "生成提示词和规划不等于音乐素材已生成；绑定真实 WAV、SHA-256 与许可后才可进入 final Timeline。",
    },
    scenes,
    review: {
      required: true,
      listenAtNormalSpeed: true,
      contexts: policy.universal.mix.reviewContexts,
      checks: [
        "音乐变化是否跟随内容、情绪和说话节奏，而非固定时间间隔",
        "事实、数字、引用、不确定性和结论有没有被音乐误导或过度渲染",
        "人声清晰度、齿音、呼吸、停顿和环境声是否仍然自然",
        "不同段落是否属于同一声音世界，而不是拼贴歌单",
        "进入、退出、留白和转折是否同时服从语义边界与乐句边界",
      ],
    },
  };
  plan.digest = stableDigest(plan);
  return plan;
}

export function validateAdaptiveBgmPlan(plan, policy = readJson(defaultPolicyFile)) {
  const errors = [];
  const warnings = [];
  if (plan.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (plan.kind !== "kacha-adaptive-bgm-plan") errors.push("kind 必须为 kacha-adaptive-bgm-plan");
  const profile = policy.showProfiles?.[plan.showId];
  if (!profile) errors.push(`未知栏目：${plan.showId}`);
  const duration = finite(plan.durationSeconds);
  if (duration === null || duration <= 0) errors.push("durationSeconds 必须大于 0");
  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) errors.push("scenes 不能为空");
  let cursor = 0;
  let musicSeconds = 0;
  let maximumContinuous = 0;
  let previousMode = null;
  let meaningfulChanges = 0;
  for (const [index, scene] of (plan.scenes ?? []).entries()) {
    const label = `scenes[${index}]`;
    const start = finite(scene.start);
    const end = finite(scene.end);
    if (start === null || end === null || start < 0 || end <= start) {
      errors.push(`${label} 时间区间无效`);
      continue;
    }
    if (Math.abs(start - cursor) > 0.01) errors.push(`${label} 与前一段存在空洞或重叠`);
    cursor = end;
    if (!['music', 'silence'].includes(scene.mode)) errors.push(`${label}.mode 无效`);
    if (previousMode !== null && previousMode !== scene.mode) meaningfulChanges += 1;
    previousMode = scene.mode;
    if (scene.mode === "silence") continue;
    const sceneDuration = end - start;
    musicSeconds += sceneDuration;
    maximumContinuous = Math.max(maximumContinuous, sceneDuration);
    if (["fact_check", "uncertainty"].some((role) => scene.narrativeFunctions?.includes(role))) {
      errors.push(`${label} 在事实核查或不确定性段落中不得配乐`);
    }
    const prompt = scene.prompt ?? {};
    for (const field of [
      "bpm", "meter", "groove", "instruments", "timbre", "harmony",
      "frequencyStrategy", "dynamics", "stereo", "editPoints",
      "generationPrompt", "negativePrompt",
    ]) {
      if (prompt[field] === undefined || prompt[field] === null || prompt[field] === "") {
        errors.push(`${label}.prompt.${field} 缺失`);
      }
    }
    if (!/no vocals|instrumental only/i.test(String(prompt.generationPrompt ?? ""))) {
      errors.push(`${label} 生成提示词必须明确无歌词、无人声`);
    }
    const target = finite(scene.mixAutomation?.targetBelowDialogueDb);
    const range = policy.universal.mix.targetBelowDialogueDb.range;
    if (target === null || target < range[0] || target > range[1]) {
      errors.push(`${label} 相对人声音量超出 ${range[0]}-${range[1]} dB`);
    }
    if (scene.speechDensity === "high" && target < policy.universal.mix.targetBelowDialogueDb.denseOrFactual) {
      errors.push(`${label} 高密度对白的 BGM 不够克制`);
    }
    if (!scene.mixAutomation?.phraseSafeEntry || !scene.mixAutomation?.phraseSafeExit) {
      errors.push(`${label} 必须同时声明语义/乐句安全的进入与退出`);
    }
  }
  if (duration !== null && Math.abs(cursor - duration) > 0.01) {
    errors.push("scenes 必须完整覆盖 durationSeconds，留白也要显式声明");
  }
  const ratio = duration ? musicSeconds / duration : 0;
  if (profile && ratio > profile.coverageMaximum + 0.001) {
    errors.push(`配乐覆盖率 ${round(ratio, 3)} 超过 ${plan.showId} 上限 ${profile.coverageMaximum}`);
  }
  if (profile && maximumContinuous > profile.maximumContinuousMusicSeconds + 0.01) {
    errors.push(`单一音乐状态连续 ${round(maximumContinuous, 1)} 秒，超过栏目上限`);
  }
  if (duration >= policy.universal.longVideoSeconds && ratio >= 0.95) {
    errors.push("长视频不得用一条音乐近乎铺满全片");
  }
  if (
    duration >= policy.universal.longVideoSeconds
    && meaningfulChanges < policy.universal.minimumMeaningfulChangesForLongVideo
  ) {
    warnings.push("长视频的音乐/留白变化较少，需要人工确认内容本身是否确实单一");
  }
  if (plan.digest !== stableDigest(plan)) errors.push("digest 与当前计划内容不一致");
  return {
    schemaVersion: "1.0",
    kind: "kacha-adaptive-bgm-validation",
    status: errors.length === 0 ? "pass" : "fail",
    errors,
    warnings,
    metrics: {
      durationSeconds: duration,
      sceneCount: plan.scenes?.length ?? 0,
      musicSceneCount: (plan.scenes ?? []).filter((scene) => scene.mode === "music").length,
      silenceSceneCount: (plan.scenes ?? []).filter((scene) => scene.mode === "silence").length,
      musicCoverageRatio: duration ? round(ratio, 4) : null,
      maximumContinuousMusicSeconds: round(maximumContinuous),
      musicSilenceChanges: meaningfulChanges,
    },
  };
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  const policyFile = path.resolve(option(args, "--policy", defaultPolicyFile));
  const policy = readJson(policyFile);
  if (action === "plan") {
    const cues = option(args, "--cues");
    const output = option(args, "--output");
    if (!cues || !output) {
      usage();
      process.exit(2);
    }
    const plan = buildAdaptiveBgmPlan(cues, {
      showId: option(args, "--show", "tool-share"),
      styleId: option(args, "--style", "xingzhe"),
      durationSeconds: option(args, "--duration"),
      policyFile,
    });
    const validation = validateAdaptiveBgmPlan(plan, policy);
    if (validation.status !== "pass") {
      console.error(JSON.stringify(validation, null, 2));
      process.exit(1);
    }
    writeJsonAtomic(path.resolve(output), plan);
    console.log(JSON.stringify({
      status: "pass",
      output: path.resolve(output),
      digest: plan.digest,
      coverage: plan.coverage,
      scenes: validation.metrics,
      warnings: validation.warnings,
    }, null, 2));
    return;
  }
  if (action === "validate") {
    const planFile = option(args, "--plan");
    if (!planFile || !fs.existsSync(path.resolve(planFile))) {
      usage();
      process.exit(2);
    }
    const validation = validateAdaptiveBgmPlan(readJson(path.resolve(planFile)), policy);
    console.log(JSON.stringify(validation, null, 2));
    if (validation.status !== "pass") process.exit(1);
    return;
  }
  usage();
  process.exit(2);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
