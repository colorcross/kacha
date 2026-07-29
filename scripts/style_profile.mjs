import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Value } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const skillRoot = path.resolve(scriptDirectory, "..");
const styleDirectory = path.join(skillRoot, "config", "styles");
const effectDirectory = path.join(skillRoot, "config", "effects");
const HEX = /^#[0-9A-F]{6}$/i;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EFFECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(left, right) {
  if (!isObject(left) || !isObject(right)) return clone(right);
  const result = clone(left);
  for (const [key, value] of Object.entries(right)) {
    result[key] = isObject(value) && isObject(result[key])
      ? merge(result[key], value)
      : clone(value);
  }
  return result;
}

function requireObject(value, label, errors) {
  if (!isObject(value)) errors.push(`${label} 必须是 object`);
}

function requireColor(value, label, errors) {
  if (!HEX.test(String(value ?? ""))) errors.push(`${label} 必须是 #RRGGBB`);
}

function requireRatio(value, label, errors, minimum = 0, maximum = 1) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    errors.push(`${label} 必须在 ${minimum}–${maximum} 之间`);
  }
}

function validateFont(value, label, errors) {
  requireObject(value, label, errors);
  if (!isObject(value)) return;
  if (
    !Array.isArray(value.families)
    || value.families.length === 0
    || value.families.some((font) => typeof font !== "string" || !font.trim())
  ) {
    errors.push(`${label}.families 必须是非空字体数组`);
  }
  if (!Number.isInteger(value.weight) || value.weight < 100 || value.weight > 900) {
    errors.push(`${label}.weight 必须是 100–900 的整数`);
  }
  requireRatio(value.sizeRatio, `${label}.sizeRatio`, errors, 0.005, 0.3);
}

export function listStyleProfiles() {
  if (!fs.existsSync(styleDirectory)) return [];
  return fs.readdirSync(styleDirectory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.basename(entry, ".json"))
    .sort();
}

export function validateStyleProfile(profile) {
  const errors = [];
  requireObject(profile, "styleProfile", errors);
  if (!isObject(profile)) return errors;
  if (profile.schemaVersion !== "1.0") errors.push("styleProfile.schemaVersion 必须为 1.0");
  if (!PROFILE_ID.test(String(profile.id ?? ""))) errors.push("styleProfile.id 格式无效");
  for (const section of [
    "palette",
    "typography",
    "subtitles",
    "popups",
    "pip",
    "cards",
    "brand",
    "motion",
    "defaults",
  ]) {
    requireObject(profile[section], `styleProfile.${section}`, errors);
  }
  if (isObject(profile.palette)) {
    for (const [key, value] of Object.entries(profile.palette)) {
      requireColor(value, `styleProfile.palette.${key}`, errors);
    }
  }
  if (isObject(profile.typography)) {
    for (const [key, value] of Object.entries(profile.typography)) {
      validateFont(value, `styleProfile.typography.${key}`, errors);
    }
  }
  if (isObject(profile.subtitles)) {
    requireRatio(profile.subtitles.maxWidthRatio, "styleProfile.subtitles.maxWidthRatio", errors, 0.3, 0.95);
    requireRatio(profile.subtitles.baselineYRatio, "styleProfile.subtitles.baselineYRatio", errors, 0.2, 0.9);
    if (profile.subtitles.background !== "none") {
      errors.push("默认字幕 background 必须为 none；项目明确授权时才覆盖");
    }
  }
  if (isObject(profile.popups)) {
    requireRatio(profile.popups.maxWidthRatio, "styleProfile.popups.maxWidthRatio", errors, 0.2, 0.9);
    requireRatio(profile.popups.headSafetyMarginRatio, "styleProfile.popups.headSafetyMarginRatio", errors, 0.01, 0.2);
  }
  if (isObject(profile.pip)) {
    if (!Array.isArray(profile.pip.strokes) || profile.pip.strokes.length < 1 || profile.pip.strokes.length > 2) {
      errors.push("styleProfile.pip.strokes 必须包含 1–2 层");
    } else {
      profile.pip.strokes.forEach((stroke, index) => {
        requireColor(stroke?.color, `styleProfile.pip.strokes[${index}].color`, errors);
        requireRatio(stroke?.widthRatio, `styleProfile.pip.strokes[${index}].widthRatio`, errors, 0.004, 0.012);
      });
    }
  }
  if (profile.cards?.persistentBase !== true) {
    errors.push("styleProfile.cards.persistentBase 必须为 true");
  }
  if (profile.cards?.screenFlashPolicy !== "forbid_full_frame_fade") {
    errors.push("styleProfile.cards.screenFlashPolicy 必须禁止整屏淡入淡出");
  }
  return errors;
}

export function loadStyleProfile(profileId = "xingzhe", overrides = {}) {
  if (!PROFILE_ID.test(String(profileId))) throw new Error(`风格 profile id 无效：${profileId}`);
  const file = path.join(styleDirectory, `${profileId}.json`);
  if (!fs.existsSync(file)) throw new Error(`风格 profile 不存在：${profileId}`);
  const base = JSON.parse(fs.readFileSync(file, "utf8"));
  const baseErrors = validateStyleProfile(base);
  if (baseErrors.length > 0) throw new Error(baseErrors.join("\n"));
  if (!isObject(overrides)) throw new Error("style.overrides 必须是 object");
  const resolved = merge(base, overrides);
  resolved.id = profileId;
  const errors = validateStyleProfile(resolved);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return {
    profile: resolved,
    source: file,
    digest: sha256Value(resolved),
  };
}

export function loadEffectRegistry(kind) {
  if (!["transition", "opening"].includes(kind)) throw new Error(`未知效果类型：${kind}`);
  const file = path.join(effectDirectory, `${kind}s.json`);
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  const errors = [];
  if (registry.schemaVersion !== "1.0") errors.push(`${kind} registry schemaVersion 必须为 1.0`);
  if (registry.kind !== kind) errors.push(`${kind} registry.kind 不匹配`);
  if (!Array.isArray(registry.effects) || registry.effects.length === 0) {
    errors.push(`${kind} registry.effects 不能为空`);
  }
  const ids = new Set();
  for (const [index, effect] of (registry.effects ?? []).entries()) {
    const label = `${kind}[${index}]`;
    if (!EFFECT_ID.test(String(effect?.id ?? ""))) errors.push(`${label}.id 格式无效`);
    if (ids.has(effect?.id)) errors.push(`${label}.id 重复：${effect?.id}`);
    ids.add(effect?.id);
    if (!["production", "experimental"].includes(effect?.status)) errors.push(`${label}.status 无效`);
    if (!Number.isInteger(effect?.durationFrames) || effect.durationFrames < 0 || effect.durationFrames > 250) {
      errors.push(`${label}.durationFrames 无效`);
    }
    if (!Array.isArray(effect?.useWhen) || effect.useWhen.length === 0) errors.push(`${label}.useWhen 不能为空`);
    if (!effect?.audioFunction) errors.push(`${label}.audioFunction 不能为空`);
    if (kind === "transition" && effect.engine === "ffmpeg_xfade" && !isObject(effect.implementation)) {
      errors.push(`${label}.implementation 缺失`);
    }
    if (kind === "opening" && effect.engine !== "svg_sequence") {
      errors.push(`${label}.engine 必须为 svg_sequence`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return {
    registry,
    source: file,
    digest: sha256Value(registry),
  };
}

export function resolveTransition(effect, direction = null) {
  if (effect.engine !== "ffmpeg_xfade") return null;
  const implementation = effect.implementation;
  if (implementation.transition) return implementation.transition;
  const chosen = direction || effect.directions?.[0];
  if (!chosen || !implementation[chosen]) {
    throw new Error(`${effect.id} 需要方向：${(effect.directions ?? []).join(", ")}`);
  }
  return implementation[chosen];
}
