#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  deepMerge,
  loadKachaConfig,
} from "./kacha_config.mjs";
import { resolveDesignSystem } from "./design_system.mjs";
import { initializeProject } from "./project_orchestrator.mjs";
import {
  mediaSummary,
  readJson,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const registryFile = path.join(skillRoot, "config", "production-studio.json");
const openingFile = path.join(skillRoot, "config", "effects", "openings.json");
const transitionFile = path.join(skillRoot, "config", "effects", "transitions.json");
const captionFile = path.join(
  skillRoot,
  "config",
  "effects",
  "spoken-caption-layouts.json",
);
const breathingFile = path.join(
  skillRoot,
  "config",
  "effects",
  "visual-breathing.json",
);
const netstyleFile = path.join(
  skillRoot,
  "config",
  "effects",
  "z-en-netstyle.json",
);
const productionMotionPolicyFile = path.join(
  skillRoot,
  "config",
  "effects",
  "production-motion-policy.json",
);
const scenesFile = path.join(
  skillRoot,
  "config",
  "design-system",
  "scenes.json",
);
const visualLanguagesFile = path.join(
  skillRoot,
  "config",
  "design-system",
  "visual-languages.json",
);

const VIDEO_EXTENSIONS = new Set([
  ".mov",
  ".mp4",
  ".m4v",
  ".mkv",
  ".avi",
  ".webm",
]);
const CAPTION_TEMPLATE_IDS = new Set([
  "editorial-readable",
  "clean-sans",
  "tech-sans",
  "editorial-serif",
]);
const AUDIO_PRESET_IDS = new Set(["natural", "warm", "warm-soft", "clear"]);
const BGM_PRESET_IDS = new Set([
  "none",
  "quiet-knowledge",
  "minimal-piano",
  "modern-electronic",
  "ambient-documentary",
]);
const EFFECT_DENSITIES = new Set(["restrained", "balanced", "active"]);
const VISUAL_LANGUAGE_SELECTION_MODES = new Set(["automatic", "preferred"]);
const BEAUTY_PROFILES = new Set(["natural", "visible"]);
const TASKS = new Set(["source_edit", "content_generation", "local_optimization"]);
const LANGUAGES = new Set(["zh", "en", "bilingual"]);
const SHOWS = new Set(["tool-share", "book-talk", "infinite-game", "very-ai"]);
const PLATFORMS = new Set([
  "douyin",
  "xiaohongshu",
  "wechat-channels",
  "bilibili",
  "youtube",
  "general",
]);
const OUTPUT_PRESETS = new Set(["preserve-source", "platform-mov", "platform-mp4"]);
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "authorization",
  "approval",
  "canexecute",
  "canpublish",
  "canupload",
  "externaluploadallowed",
  "paidgenerationallowed",
  "publishallowed",
  "skipgates",
  "skipqc",
  "overwritesource",
  "uploadallowed",
]);

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null),
  );
}

function rejectAuthority(value, label = "value") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectAuthority(entry, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (FORBIDDEN_AUTHORITY_KEYS.has(normalized)) {
      throw new Error(`${label}.${key} 属于逐项目授权或质量门禁，生产风格不能设置`);
    }
    rejectAuthority(child, `${label}.${key}`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

function finiteNumber(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 至 ${maximum} 的数值`);
  }
  return number;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是 boolean`);
  return value;
}

function idValue(value, label) {
  const id = nonEmptyString(value, label);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error(`${label} 只能使用小写字母、数字和连字符`);
  }
  return id;
}

function colorValue(value, label) {
  const color = nonEmptyString(value, label).toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) throw new Error(`${label} 必须是六位十六进制颜色`);
  return color;
}

function enumValue(value, allowed, label) {
  const entry = nonEmptyString(value, label);
  if (!allowed.has(entry)) throw new Error(`${label} 不支持：${entry}`);
  return entry;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} 包含未知字段：${key}`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function configHome(environment = process.env) {
  return environment.KACHA_CONFIG_HOME
    ? path.resolve(environment.KACHA_CONFIG_HOME)
    : path.join(os.homedir(), ".config", "kacha");
}

function customStylesDirectory(environment = process.env) {
  return path.join(configHome(environment), "studio", "styles");
}

function readCustomStyles(environment = process.env) {
  const directory = customStylesDirectory(environment);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = path.join(directory, name);
      const style = readJson(file);
      return { ...style, builtIn: false, source: file };
    });
}

function loadBaseRegistry() {
  const registry = readJson(registryFile);
  if (registry.schemaVersion !== "1.0") {
    throw new Error("production-studio schemaVersion 必须为 1.0");
  }
  if (!Array.isArray(registry.stylePresets) || registry.stylePresets.length < 4) {
    throw new Error("production-studio 至少需要四套内置风格");
  }
  return registry;
}

function loadVisualLanguageRegistry() {
  const registry = readJson(visualLanguagesFile);
  if (
    registry.schemaVersion !== "1.0"
    || registry.kind !== "kacha_visual_language_registry"
    || registry.id !== "kacha-visual-languages"
    || registry.parentProfile !== "xingzhe"
    || registry.defaultSelectionMode !== "automatic"
    || registry.noMatchFallback !== "clean_frame_or_plain_caption"
    || Object.hasOwn(registry, "default")
    || !isPlainObject(registry.languages)
  ) {
    throw new Error("五视觉语言注册表缺少行者风父级、自动选择或干净回退合同");
  }
  const requiredIds = [
    "xingzhe-light-overlay",
    "xingzhe-spatial-lightpath",
    "xingzhe-humor-comic",
    "xingzhe-pixel-editorial",
    "xingzhe-dark-tech",
  ];
  const languages = requiredIds.map((id) => {
    const language = registry.languages[id];
    if (
      !isPlainObject(language)
      || !language.label
      || !language.intent
      || !language.grammarSignature?.id
      || !Array.isArray(language.editingGrammar?.sequence)
      || !language.applicability?.selectionRule
      || !language.applicability?.fallback
    ) {
      throw new Error(`视觉语言 ${id} 缺少名称、语法、选择或回退合同`);
    }
    return {
      id,
      label: language.label,
      intent: language.intent,
      grammarId: language.grammarSignature.id,
      temporalModel: language.grammarSignature.temporalModel,
      spatialModel: language.grammarSignature.spatialModel,
      sequence: clone(language.editingGrammar.sequence),
      selectionRule: language.applicability.selectionRule,
      fallback: language.applicability.fallback,
      runtimeEvidenceRequired: clone(
        language.applicability.runtimeEvidenceRequired ?? [],
      ),
    };
  });
  return {
    parentProfile: registry.parentProfile,
    defaultSelectionMode: registry.defaultSelectionMode,
    noMatchFallback: registry.noMatchFallback,
    languages,
    digest: sha256Value(registry),
  };
}

function effectCatalog() {
  const openings = readJson(openingFile).effects ?? [];
  const transitions = readJson(transitionFile).effects ?? [];
  const captions = readJson(captionFile).layouts ?? [];
  const motions = readJson(breathingFile).motions ?? [];
  const netstyle = readJson(netstyleFile).effects ?? [];
  const scenes = readJson(scenesFile).scenes ?? [];
  return [
    ...openings.map((effect) => ({
      kind: "opening",
      group: "开场",
      id: effect.id,
      label: effect.label,
      trigger: (effect.useWhen ?? []).join("；"),
      production: effect.status === "production",
      source: "core-opening-registry",
      function: "在首个完整语义单元建立问题、冲突、收益或主题",
      mechanism: effect.implementation?.template ?? effect.engine,
      soundFunction: effect.audioFunction,
      fallback: effect.id === "cold_open_marker" ? "clean_cold_open" : "cold_open_marker",
      failureModes: clone(effect.avoidWhen ?? []),
      qc: ["首秒已有可见变化", "3 秒内兑现内容承诺", "人物与字幕安全区无碰撞"],
    })),
    ...transitions.map((effect) => ({
      kind: "transition",
      group: "转场与连接",
      id: effect.id,
      label: effect.label,
      trigger: (effect.useWhen ?? []).join("；"),
      production: effect.status === "production",
    })),
    ...captions.map((effect) => ({
      kind: "caption",
      group: "字幕与文字",
      id: effect.id,
      label: effect.label,
      trigger: effect.trigger,
      production: true,
    })),
    ...motions.map((effect) => ({
      kind: "breathing",
      group: "画面呼吸",
      id: effect.id,
      label: effect.label,
      trigger: effect.trigger,
      production: true,
    })),
    ...netstyle.map((effect) => ({
      kind: effect.family === "opening" ? "opening" : "netstyle",
      group: effect.family === "opening" ? "开场" : "语义动效",
      id: effect.id,
      label: effect.label,
      trigger: effect.trigger,
      production: true,
      source: "z-en-netstyle",
      family: effect.family,
      function: effect.function,
      mechanism: effect.mechanism,
      soundFunction: effect.soundTrigger,
      fallback: effect.fallback,
      failureModes: clone(effect.failureModes ?? []),
      qc: clone(effect.qc ?? []),
      referenceVideo: effect.referenceVideo ?? null,
    })),
    ...scenes.map((scene) => ({
      kind: "scene",
      group: "场景组件",
      id: scene.id,
      label: scene.label,
      trigger: scene.trigger,
      production: true,
    })),
  ];
}

function normalizeCaption(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是 object`);
  return {
    templateId: enumValue(value.templateId, CAPTION_TEMPLATE_IDS, `${label}.templateId`),
    fontRole: nonEmptyString(value.fontRole, `${label}.fontRole`),
    preferredFontFamily: nonEmptyString(
      value.preferredFontFamily,
      `${label}.preferredFontFamily`,
    ),
    fontSizeRatio: finiteNumber(value.fontSizeRatio, `${label}.fontSizeRatio`, 0.028, 0.08),
    maxWidthRatio: finiteNumber(value.maxWidthRatio, `${label}.maxWidthRatio`, 0.5, 0.9),
    baselineYRatio: finiteNumber(value.baselineYRatio, `${label}.baselineYRatio`, 0.5, 0.82),
    primaryColor: colorValue(value.primaryColor, `${label}.primaryColor`),
    emphasisColor: colorValue(value.emphasisColor, `${label}.emphasisColor`),
    shadowOpacity: finiteNumber(value.shadowOpacity, `${label}.shadowOpacity`, 0, 1),
    singleLine: booleanValue(value.singleLine, `${label}.singleLine`),
    background: value.background === "none" ? "none" : nonEmptyString(
      value.background,
      `${label}.background`,
    ),
  };
}

function normalizeAudio(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是 object`);
  return {
    presetId: enumValue(value.presetId, AUDIO_PRESET_IDS, `${label}.presetId`),
    denoise: enumValue(value.denoise, new Set(["off", "light", "medium"]), `${label}.denoise`),
    targetLufs: finiteNumber(value.targetLufs, `${label}.targetLufs`, -30, -12),
    truePeakDbtp: finiteNumber(value.truePeakDbtp, `${label}.truePeakDbtp`, -12, -1),
    channelMode: enumValue(
      value.channelMode,
      new Set(["preserve", "mono", "stereo"]),
      `${label}.channelMode`,
    ),
  };
}

function normalizeBgm(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是 object`);
  const presetId = enumValue(value.presetId, BGM_PRESET_IDS, `${label}.presetId`);
  return {
    enabled: presetId === "none" ? false : booleanValue(value.enabled, `${label}.enabled`),
    presetId,
    targetBelowDialogueDb: finiteNumber(
      value.targetBelowDialogueDb ?? 18,
      `${label}.targetBelowDialogueDb`,
      12,
      30,
    ),
    ducking: enumValue(
      value.ducking ?? "gentle",
      new Set(["off", "gentle", "responsive"]),
      `${label}.ducking`,
    ),
  };
}

function normalizeTuning(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是 object`);
  return {
    smoothing: finiteNumber(value.smoothing, `${label}.smoothing`, 0, 100),
    whitening: finiteNumber(value.whitening, `${label}.whitening`, 0, 100),
    toneEvening: finiteNumber(value.toneEvening, `${label}.toneEvening`, 0, 100),
    nasolabialSoftening: finiteNumber(
      value.nasolabialSoftening,
      `${label}.nasolabialSoftening`,
      0,
      100,
    ),
  };
}

function normalizeBeauty(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是 object`);
  if (value.engine !== "beauty-v2") throw new Error(`${label}.engine 必须为 beauty-v2`);
  return {
    enabled: booleanValue(value.enabled, `${label}.enabled`),
    engine: "beauty-v2",
    profile: enumValue(value.profile, BEAUTY_PROFILES, `${label}.profile`),
    tuning: normalizeTuning(value.tuning, `${label}.tuning`),
  };
}

function normalizeDirection(value, label, openingIds) {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是 object`);
  const openingId = nonEmptyString(value.openingId, `${label}.openingId`);
  if (!openingIds.has(openingId)) throw new Error(`${label}.openingId 不存在：${openingId}`);
  return {
    openingId,
    transitionBias: nonEmptyString(value.transitionBias, `${label}.transitionBias`),
    effectDensity: enumValue(
      value.effectDensity,
      EFFECT_DENSITIES,
      `${label}.effectDensity`,
    ),
    automaticProfessionalJudgment: booleanValue(
      value.automaticProfessionalJudgment,
      `${label}.automaticProfessionalJudgment`,
    ),
    visualBreathing: booleanValue(value.visualBreathing, `${label}.visualBreathing`),
  };
}

function normalizeProjectOverrides(value, catalog) {
  if (value === undefined || value === null) {
    return {
      audioPresetId: null,
      bgmPresetId: null,
      effectDensity: null,
      beauty: null,
    };
  }
  if (!isPlainObject(value)) throw new Error("projectOverrides 必须是 object");
  rejectAuthority(value, "projectOverrides");
  const audioPresetIds = new Set(catalog.audioPresets.map((preset) => preset.id));
  const bgmPresetIds = new Set(catalog.bgmPresets.map((preset) => preset.id));
  const beauty = value.beauty === undefined || value.beauty === null
    ? null
    : {
        enabled: booleanValue(value.beauty.enabled, "projectOverrides.beauty.enabled"),
        engine: "beauty-v2",
        profile: enumValue(
          value.beauty.profile ?? "natural",
          BEAUTY_PROFILES,
          "projectOverrides.beauty.profile",
        ),
        tuning: normalizeTuning(
          value.beauty.tuning,
          "projectOverrides.beauty.tuning",
        ),
      };
  return {
    audioPresetId: value.audioPresetId
      ? enumValue(value.audioPresetId, audioPresetIds, "projectOverrides.audioPresetId")
      : null,
    bgmPresetId: value.bgmPresetId
      ? enumValue(value.bgmPresetId, bgmPresetIds, "projectOverrides.bgmPresetId")
      : null,
    effectDensity: value.effectDensity
      ? enumValue(value.effectDensity, EFFECT_DENSITIES, "projectOverrides.effectDensity")
      : null,
    beauty,
  };
}

function normalizeVisualLanguageSelection(value, catalog, style) {
  const policy = catalog.visualLanguagePolicy;
  if (style.design.profile !== policy.parentProfile) {
    throw new Error(
      `五套剪辑视觉语言只适用于 ${policy.parentProfile}，当前基础风格为 ${style.design.profile}`,
    );
  }
  const input = value === undefined || value === null
    ? { mode: policy.defaultSelectionMode }
    : value;
  if (!isPlainObject(input)) throw new Error("visualLanguageSelection 必须是 object");
  rejectUnknownFields(
    input,
    new Set(["mode", "preferredId"]),
    "visualLanguageSelection",
  );
  const mode = enumValue(
    input.mode ?? policy.defaultSelectionMode,
    VISUAL_LANGUAGE_SELECTION_MODES,
    "visualLanguageSelection.mode",
  );
  const languageIds = new Set(catalog.visualLanguages.map((entry) => entry.id));
  let preferred = null;
  if (mode === "preferred") {
    const preferredId = enumValue(
      input.preferredId,
      languageIds,
      "visualLanguageSelection.preferredId",
    );
    preferred = catalog.visualLanguages.find((entry) => entry.id === preferredId);
  } else if (input.preferredId !== undefined && input.preferredId !== null) {
    throw new Error("自动按语义选择时不得同时指定 preferredId");
  }
  return {
    mode,
    parentProfile: policy.parentProfile,
    preferredId: preferred?.id ?? null,
    preferredLabel: preferred?.label ?? null,
    allowedIds: [...languageIds],
    noMatchFallback: policy.noMatchFallback,
    preferredFallback: preferred?.fallback ?? null,
    runtimeEvidenceRequired: [
      "matchedSignal",
      "semanticBeatId",
      "sourceRange",
      "fallbackReasonWhenNotApplied",
    ],
    registryDigest: policy.registryDigest,
  };
}

function applyProjectOverrides(style, overrides, catalog) {
  const resolved = clone(style);
  if (overrides.audioPresetId) {
    const preset = catalog.audioPresets.find(
      (entry) => entry.id === overrides.audioPresetId,
    );
    resolved.audio = {
      ...resolved.audio,
      presetId: preset.id,
      denoise: preset.denoise,
      targetLufs: preset.targetLufs,
      truePeakDbtp: preset.truePeakDbtp,
    };
  }
  if (overrides.bgmPresetId) {
    resolved.bgm = {
      ...resolved.bgm,
      enabled: overrides.bgmPresetId !== "none",
      presetId: overrides.bgmPresetId,
    };
  }
  if (overrides.effectDensity) {
    resolved.direction.effectDensity = overrides.effectDensity;
  }
  if (overrides.beauty) {
    resolved.beauty = clone(overrides.beauty);
  }
  return resolved;
}

function normalizeDesign(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是 object`);
  const normalized = {
    system: nonEmptyString(value.system, `${label}.system`),
    profile: nonEmptyString(value.profile, `${label}.profile`),
    modes: clone(value.modes ?? {}),
    overrides: clone(value.overrides ?? {}),
  };
  rejectAuthority(normalized, label);
  resolveDesignSystem(normalized);
  return normalized;
}

function normalizeStylePreset(value, {
  label = "style",
  builtIn = false,
  base = null,
  openingIds = null,
} = {}) {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是 object`);
  rejectAuthority(value, label);
  const merged = base ? deepMerge(base, value) : clone(value);
  const ids = openingIds ?? new Set(
    (readJson(openingFile).effects ?? []).map((effect) => effect.id),
  );
  return {
    schemaVersion: "1.0",
    id: idValue(merged.id, `${label}.id`),
    name: nonEmptyString(merged.name, `${label}.name`),
    tagline: nonEmptyString(merged.tagline, `${label}.tagline`),
    description: nonEmptyString(merged.description, `${label}.description`),
    builtIn,
    baseStyleId: merged.baseStyleId ?? null,
    design: normalizeDesign(merged.design, `${label}.design`),
    caption: normalizeCaption(merged.caption, `${label}.caption`),
    audio: normalizeAudio(merged.audio, `${label}.audio`),
    bgm: normalizeBgm(merged.bgm, `${label}.bgm`),
    beauty: normalizeBeauty(merged.beauty, `${label}.beauty`),
    direction: normalizeDirection(merged.direction, `${label}.direction`, ids),
  };
}

export function loadProductionCatalog({
  environment = process.env,
  includeCustom = true,
} = {}) {
  const registry = loadBaseRegistry();
  const visualLanguageRegistry = loadVisualLanguageRegistry();
  const effects = effectCatalog();
  const openings = effects.filter((effect) => effect.kind === "opening");
  const openingIds = new Set(openings.map((effect) => effect.id));
  const builtIns = registry.stylePresets.map((style, index) => normalizeStylePreset(
    style,
    { label: `stylePresets[${index}]`, builtIn: true, openingIds },
  ));
  const builtInById = new Map(builtIns.map((style) => [style.id, style]));
  const custom = includeCustom
    ? readCustomStyles(environment).map((style, index) => {
      const baseId = style.baseStyleId ?? registry.defaultStyleId;
      const base = builtInById.get(baseId);
      if (!base) throw new Error(`customStyles[${index}].baseStyleId 不存在：${baseId}`);
      return normalizeStylePreset(style, {
        label: `customStyles[${index}]`,
        builtIn: false,
        base,
        openingIds,
      });
    })
    : [];
  const styles = [...builtIns, ...custom];
  const duplicateIds = styles
    .map((style) => style.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) throw new Error(`风格 ID 重复：${duplicateIds.join(", ")}`);
  if (!styles.some((style) => style.id === registry.defaultStyleId)) {
    throw new Error(`默认风格不存在：${registry.defaultStyleId}`);
  }
  const productionMotionPolicy = readJson(productionMotionPolicyFile);
  return {
    schemaVersion: "1.0",
    status: "pass",
    id: registry.id,
    name: registry.name,
    defaultStyleId: registry.defaultStyleId,
    authorityBoundary: registry.authorityBoundary,
    styles,
    visualLanguagePolicy: {
      parentProfile: visualLanguageRegistry.parentProfile,
      defaultSelectionMode: visualLanguageRegistry.defaultSelectionMode,
      noMatchFallback: visualLanguageRegistry.noMatchFallback,
      registryDigest: visualLanguageRegistry.digest,
    },
    visualLanguages: clone(visualLanguageRegistry.languages),
    captionTemplates: clone(registry.captionTemplates),
    audioPresets: clone(registry.audioPresets),
    bgmPresets: clone(registry.bgmPresets),
    outputPresets: clone(registry.outputPresets),
    openings: effects.filter((effect) => effect.kind === "opening"),
    assignableEffects: effects,
    productionMotionPolicy: clone(productionMotionPolicy),
    professionalAutoDirector: clone(registry.professionalAutoDirector),
    digest: sha256Value({
      registry,
      effects,
      productionMotionPolicy,
      visualLanguageRegistry,
      custom: custom.map(({ source: _source, ...style }) => style),
    }),
  };
}

function slugify(value, fallback = "style") {
  const ascii = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const normalized = ascii.replace(/[^\p{Script=Han}a-z0-9-]/gu, "").slice(0, 48);
  return normalized || fallback;
}

export function saveCustomStyle(input, { environment = process.env } = {}) {
  const catalog = loadProductionCatalog({ environment, includeCustom: false });
  const baseId = input.baseStyleId ?? catalog.defaultStyleId;
  const base = catalog.styles.find((style) => style.id === baseId);
  if (!base) throw new Error(`基础风格不存在：${baseId}`);
  const id = input.id
    ? idValue(input.id, "style.id")
    : `custom-${slugify(input.name, "video-style")}`;
  if (catalog.styles.some((style) => style.id === id)) {
    throw new Error(`不能覆盖内置风格：${id}`);
  }
  const normalized = normalizeStylePreset(
    {
      ...input,
      schemaVersion: "1.0",
      id,
      baseStyleId: baseId,
    },
    {
      label: "style",
      builtIn: false,
      base,
      openingIds: new Set(catalog.openings.map((entry) => entry.id)),
    },
  );
  const directory = customStylesDirectory(environment);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${normalized.id}.json`);
  if (fs.existsSync(file)) {
    throw new Error(
      `自定义风格“${normalized.name}”已经存在；请修改名称后另存，咔嚓不会静默覆盖`,
    );
  }
  writeJsonAtomic(file, {
    ...normalized,
    builtIn: false,
    source: undefined,
  });
  return { style: normalized, file };
}

function probeVideo(videoPath) {
  const resolved = path.resolve(nonEmptyString(videoPath, "videoPath"));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`视频不存在：${resolved}`);
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new Error(`不支持的视频扩展名：${path.extname(resolved) || "<none>"}`);
  }
  const summary = mediaSummary(resolved);
  if (!summary.video || !Number.isFinite(summary.duration) || summary.duration <= 0) {
    throw new Error(`无法读取有效视频轨或时长：${resolved}`);
  }
  return {
    path: resolved,
    fileName: path.basename(resolved),
    width: summary.width,
    height: summary.height,
    aspectRatio: summary.width / summary.height,
    fps: summary.fps,
    durationSeconds: summary.duration,
    videoCodec: summary.video.codec_name ?? null,
    pixelFormat: summary.video.pix_fmt ?? null,
    colorSpace: summary.video.color_space ?? null,
    audioCodec: summary.audio?.codec_name ?? null,
    sampleRate: summary.sampleRate || null,
    channels: summary.channels || null,
    channelLayout: summary.channelLayout,
  };
}

export function inspectProductionVideo(videoPath) {
  return {
    schemaVersion: "1.0",
    status: "pass",
    media: probeVideo(videoPath),
  };
}

function deriveAspectMode(media) {
  const ratio = media.width / media.height;
  if (ratio > 1.25) return "landscape-16x9";
  if (ratio < 0.8) return "portrait-9x16";
  return "square-1x1";
}

function resolveCaptionFontEvidence(style, loadedConfig) {
  const registryPath = loadedConfig.config.tools.fontRegistry;
  if (!registryPath || !fs.existsSync(registryPath)) {
    throw new Error(
      `风格“${style.name}”要求真实字体 ${style.caption.preferredFontFamily}，`
        + "但当前用户配置没有可用的 tools.fontRegistry",
    );
  }
  const registry = readJson(registryPath);
  const requested = style.caption.preferredFontFamily.toLowerCase();
  const record = (registry.records ?? []).find((entry) => {
    const names = [
      ...(entry.families ?? []),
      ...(entry.fullNames ?? []),
      ...(entry.postscriptNames ?? []),
    ].map((name) => String(name).toLowerCase());
    return names.some(
      (name) => name === requested || name.includes(requested) || requested.includes(name),
    );
  });
  if (!record) {
    throw new Error(
      `字体注册表没有命中“${style.caption.preferredFontFamily}”；`
        + "咔嚓不会静默换回替代字体",
    );
  }
  if (
    record.projectAuthorization?.status !== "authorized"
    && record.license?.status !== "open"
  ) {
    throw new Error(`字体“${style.caption.preferredFontFamily}”没有可执行的本地授权记录`);
  }
  if (!fs.existsSync(record.file) || sha256File(record.file) !== record.sha256) {
    throw new Error(`字体文件缺失或 SHA-256 已变化：${record.file}`);
  }
  return {
    requestedFamily: style.caption.preferredFontFamily,
    resolvedFamily: record.families?.[0] ?? style.caption.preferredFontFamily,
    file: record.file,
    sha256: record.sha256,
    authorizationStatus:
      record.projectAuthorization?.status ?? record.license?.status,
    redistributionAllowed: record.redistributionAllowed === true,
    registryPath,
    registryDigest: registry.digest ?? sha256File(registryPath),
  };
}

function normalizeEffectAssignments(value, effectByKey) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("effectAssignments 必须是数组");
  return value.map((assignment, index) => {
    if (!isPlainObject(assignment)) {
      throw new Error(`effectAssignments[${index}] 必须是 object`);
    }
    const positionDescription = nonEmptyString(
      assignment.positionDescription,
      `effectAssignments[${index}].positionDescription`,
    );
    const effectId = nonEmptyString(
      assignment.effectId,
      `effectAssignments[${index}].effectId`,
    );
    const effectKind = nonEmptyString(
      assignment.effectKind,
      `effectAssignments[${index}].effectKind`,
    );
    const effect = effectByKey.get(`${effectKind}:${effectId}`);
    if (!effect) throw new Error(`指定效果不存在：${effectKind}:${effectId}`);
    return {
      id: `effect-${index + 1}`,
      positionDescription,
      effectKind,
      effectId,
      effectLabel: effect.label,
      notes: typeof assignment.notes === "string" ? assignment.notes.trim() : "",
      timingResolution:
        "由最终校准文稿和口播语义定位到帧；动作峰值对齐重音，返回主画面前完整退出。",
      requiresDesignPreflight: ["scene", "netstyle"].includes(effectKind),
    };
  });
}

function normalizeProductionRequest(request, catalog, media) {
  if (!isPlainObject(request)) throw new Error("request 必须是 JSON object");
  rejectAuthority(request, "request");
  if (request.schemaVersion !== "1.0") throw new Error("request.schemaVersion 必须为 1.0");
  const styleId = request.styleId ?? catalog.defaultStyleId;
  const baseStyle = catalog.styles.find((entry) => entry.id === styleId);
  if (!baseStyle) throw new Error(`视频风格不存在：${styleId}`);
  const projectOverrides = normalizeProjectOverrides(request.projectOverrides, catalog);
  const style = applyProjectOverrides(baseStyle, projectOverrides, catalog);
  const visualLanguageSelection = normalizeVisualLanguageSelection(
    request.visualLanguageSelection,
    catalog,
    style,
  );
  const openingId = request.openingId ?? style.direction.openingId;
  const openingEffect = catalog.openings.find((entry) => entry.id === openingId);
  if (!openingEffect) {
    throw new Error(`开场效果不存在：${openingId}`);
  }
  const effectByKey = new Map(
    catalog.assignableEffects.map((effect) => [`${effect.kind}:${effect.id}`, effect]),
  );
  const outputPresetId = request.outputPresetId ?? "preserve-source";
  enumValue(outputPresetId, OUTPUT_PRESETS, "outputPresetId");
  const task = enumValue(request.task ?? "source_edit", TASKS, "task");
  const platform = enumValue(request.platform ?? "general", PLATFORMS, "platform");
  const language = enumValue(request.language ?? "zh", LANGUAGES, "language");
  const show = enumValue(request.show ?? style.design.modes.show, SHOWS, "show");
  return {
    schemaVersion: "1.0",
    projectName: nonEmptyString(
      request.projectName ?? path.parse(media.fileName).name,
      "projectName",
    ),
    videoPath: media.path,
    styleId,
    openingId,
    openingEffect: clone(openingEffect),
    task,
    platform,
    language,
    show,
    outputPresetId,
    targetDuration: typeof request.targetDuration === "string"
      ? request.targetDuration.trim()
      : "",
    preserveSource: request.preserveSource === undefined
      ? true
      : booleanValue(request.preserveSource, "preserveSource"),
    automaticProfessionalJudgment: request.automaticProfessionalJudgment === undefined
      ? style.direction.automaticProfessionalJudgment
      : booleanValue(
        request.automaticProfessionalJudgment,
        "automaticProfessionalJudgment",
      ),
    backgroundMusicEnabled: request.backgroundMusicEnabled === undefined
      ? style.bgm.enabled
      : booleanValue(request.backgroundMusicEnabled, "backgroundMusicEnabled"),
    effectAssignments: normalizeEffectAssignments(
      request.effectAssignments,
      effectByKey,
    ),
    notes: typeof request.notes === "string" ? request.notes.trim() : "",
    outputDirectory: request.outputDirectory
      ? path.resolve(nonEmptyString(request.outputDirectory, "outputDirectory"))
      : path.dirname(media.path),
    projectOverrides,
    visualLanguageSelection,
    style,
  };
}

function productionInstructions(request, catalog) {
  const instructions = [
    {
      id: "studio-content-first",
      text: "先完成内容结构、语义切点、连接和音画同步，再做视觉包装；禁止用效果掩盖错误切点。",
      appliesTo: [request.task],
      modules: [],
      priority: "required",
    },
    {
      id: "studio-style-contract",
      text: `全片使用“${request.style.name}”作为基础品牌风格；字幕、字体、颜色、组件、场景、动效与声音从同一配置解析。`,
      appliesTo: [request.task],
      modules: ["visual", "subtitles", "audio", "bgm", "sfx"],
      priority: "high",
    },
    {
      id: "studio-visual-language-contract",
      text: request.visualLanguageSelection.mode === "automatic"
        ? "五套行者风剪辑视觉语言按每个真实语义拍自动选择：浅暖轻浮层用于知识与方法，空间光路用于关系与流程，幽默漫画只用于真实喜剧反差，像素风只用于可核验状态变化，暗黑科技风只用于异常、风险、冲突证据、隐性机制或真伪裁决。每次选择必须记录 matchedSignal、semanticBeatId、sourceRange；没有匹配信号时保持干净画面或普通字幕，不强套风格。"
        : `优先使用“${request.visualLanguageSelection.preferredLabel}”剪辑语法，但只有当前语义拍满足其注册触发时才能应用；不匹配时执行“${request.visualLanguageSelection.preferredFallback}”，并记录 fallbackReasonWhenNotApplied。不得把优先选择解释为整片滤镜。`,
      appliesTo: [request.task],
      modules: ["visual", "subtitles", "audio", "sfx"],
      priority: "required",
    },
    {
      id: "studio-opening",
      text: `每条视频必须且只能选择一个主开场。本片使用已注册效果 \`${request.openingId}\`（${request.openingEffect.label}），从首个有效声音或动作建立变化，3 秒内兑现问题、冲突、收益或主题；不增加静态封面和无意静音。`,
      appliesTo: [request.task],
      modules: ["openings", "visual", "sfx"],
      priority: "required",
    },
  ];
  if (request.automaticProfessionalJudgment) {
    instructions.push({
      id: "studio-auto-director",
      text: `用户未指定的区间由咔嚓专业判断。执行规则：${catalog.professionalAutoDirector.rules.join(" ")}`,
      appliesTo: [request.task],
      modules: [],
      priority: "required",
    });
  }
  for (const assignment of request.effectAssignments) {
    instructions.push({
      id: `studio-${assignment.id}`,
      text: `在“${assignment.positionDescription}”使用已注册的 ${assignment.effectKind} 效果 \`${assignment.effectId}\`（${assignment.effectLabel}）。${assignment.notes || "按语义峰值、人物安全区和最简回退合同执行。"}`,
      appliesTo: [request.task],
      modules: ["visual", "sfx"],
      priority: "required",
    });
  }
  if (request.notes) {
    instructions.push({
      id: `studio-notes-${sha256Value(request.notes).slice(0, 12)}`,
      text: request.notes,
      appliesTo: [request.task],
      modules: [],
      priority: "high",
    });
  }
  return instructions;
}

function buildProjectConfig(request, media, catalog) {
  const style = request.style;
  const outputPreset = catalog.outputPresets.find(
    (entry) => entry.id === request.outputPresetId,
  );
  const aspectRatio = request.preserveSource
    ? deriveAspectMode(media)
    : style.design.modes.aspectRatio;
  const styleOverrides = deepMerge(style.design.overrides, {
    palette: {
      accent: style.caption.emphasisColor,
    },
    typography: {
      subtitlePrimary: {
        sizeRatio: style.caption.fontSizeRatio,
      },
    },
    subtitles: {
      maxWidthRatio: style.caption.maxWidthRatio,
      baselineYRatio: style.caption.baselineYRatio,
      singleLinePerLanguage: style.caption.singleLine,
      background: style.caption.background,
      shadow: {
        opacity: style.caption.shadowOpacity,
      },
    },
  });
  return {
    schemaVersion: "1.0",
    style: {
      system: style.design.system,
      profile: style.design.profile,
      modes: {
        ...style.design.modes,
        show: request.show,
        aspectRatio,
        language: request.language,
      },
      overrides: styleOverrides,
    },
    editingDefaults: {
      parameters: {
        preserveSourceDimensions: request.preserveSource,
        preserveSourceAspectRatio: request.preserveSource,
        preserveEffectiveFrameRate: request.preserveSource,
        subtitle: {
          sourceOfTruth: "final_audio",
          singleLine: style.caption.singleLine,
          stayInsideFrame: true,
          avoidPlatformUi: true,
        },
        captionStyle: clone(style.caption),
        audio: {
          dialogueFirst: true,
          keepResidualMuted: true,
          profile: `${style.audio.presetId}-production`,
          targetIntegratedLufs: style.audio.targetLufs,
          truePeakMaxDbtp: style.audio.truePeakDbtp,
          bgm: {
            enabled: request.backgroundMusicEnabled && style.bgm.presetId !== "none",
            presetId: style.bgm.presetId,
            targetBelowDialogueDb: style.bgm.targetBelowDialogueDb,
            ducking: style.bgm.ducking,
          },
          sfx: {
            defaultBelowDialogueDb: 12,
            highShelfFrequencyHz: 4500,
            highShelfGainDb: -1.5,
          },
        },
        beauty: {
          enabled: style.beauty.enabled,
          engine: "beauty-v2",
          profile: style.beauty.profile,
          tuning: clone(style.beauty.tuning),
        },
        productionStudio: {
          styleId: style.id,
          styleName: style.name,
          visualLanguageSelection: clone(request.visualLanguageSelection),
          openingId: request.openingId,
          openingContract: {
            required: true,
            primaryEffectCount: 1,
            effectId: request.openingId,
            effectLabel: request.openingEffect.label,
            source: request.openingEffect.source ?? "core-opening-registry",
            trigger: request.openingEffect.trigger,
            function: request.openingEffect.function
              ?? "在首个完整语义单元建立内容承诺",
            mechanism: request.openingEffect.mechanism
              ?? "按注册开场模板完成进入、语义峰值、停稳和退出",
            soundFunction: request.openingEffect.soundFunction ?? "visible_landing",
            fallback: request.openingEffect.fallback ?? "cold_open_marker",
            startAtOrBeforeSeconds:
              catalog.productionMotionPolicy.opening.startAtOrBeforeSeconds,
            promiseBySeconds:
              catalog.productionMotionPolicy.opening.promiseBySeconds,
            normalSpeedPreviewRequired: true,
            representativeFrameRequired: true,
          },
          platform: request.platform,
          outputPresetId: request.outputPresetId,
          targetDuration: request.targetDuration || null,
          automaticProfessionalJudgment: request.automaticProfessionalJudgment,
          effectAssignments: clone(request.effectAssignments),
          projectOverrides: clone(request.projectOverrides),
        },
        delivery: {
          platform: request.platform,
          outputPresetId: outputPreset.id,
          container: outputPreset.container,
          quality: outputPreset.quality,
          preserveDimensions: request.preserveSource
            || outputPreset.preserveDimensions === true,
          preserveAspectRatio: request.preserveSource
            || outputPreset.preserveAspectRatio === true,
          preserveFrameRate: request.preserveSource
            || outputPreset.preserveFrameRate === true,
          targetDuration: request.targetDuration || null,
        },
      },
      instructions: productionInstructions(request, catalog),
      recipeParameters: {
        beauty: {
          profile: style.beauty.profile,
          tuning: clone(style.beauty.tuning),
        },
        bgm: {
          presetId: style.bgm.presetId,
          targetBelowDialogueDb: style.bgm.targetBelowDialogueDb,
        },
        sfx: {
          palettePolicy: "functional-and-varied",
        },
        style: {
          presetId: style.id,
          visualLanguageSelection: clone(request.visualLanguageSelection),
        },
      },
    },
    execution: {
      intelligenceV6: {
        required: true,
        compatibilityMode: false,
      },
      netstyle: {
        automaticPlanning: request.automaticProfessionalJudgment,
        maximumPrimaryEffectsPer10Seconds: {
          restrained: 1.5,
          balanced: 2.5,
          active: 3.4,
        }[style.direction.effectDensity],
      },
      visualBreathing: {
        automaticPlanning:
          request.automaticProfessionalJudgment && style.direction.visualBreathing,
      },
      spokenCaptions: {
        automaticLayout: request.automaticProfessionalJudgment,
        defaultLayout: "plain_single",
      },
      voiceEnhancement: {
        preset: style.audio.presetId,
        denoise: style.audio.denoise,
        targetLufs: style.audio.targetLufs,
        truePeakDbtp: style.audio.truePeakDbtp,
        channelMode: style.audio.channelMode,
      },
    },
  };
}

function agentInstructions(briefPath, configPath, request) {
  return `# 咔嚓剪辑执行入口

请使用已安装的 \`kacha\` Skill，按 \`${request.task}\` 路径执行。

1. 先完整读取：
   - \`${briefPath}\`
   - \`${configPath}\`
2. 项目已经建立可恢复的四里程碑/十三阶段状态。先运行：
   - \`node scripts/kacha.mjs status ${path.dirname(briefPath)}\`
   - 获得用户本地执行确认后运行 \`node scripts/kacha.mjs run ${path.dirname(briefPath)} --confirm-execute\`
3. 对源视频做只读盘点、转写、内容结构和剪辑方案；没有批准前不得覆盖源文件。
4. 用户明确指定的效果按 brief 中的自然语言位置定位到最终校准口播。
5. 未指定区间启用专业自动判断，但必须遵守每个效果的触发理由、失败条件、最简回退和 QC。
6. 新项目默认启用 V6。先通过方案门禁，再渲染；自动 QC 和人工正常速度审片都通过后，才能称为可发布。

本配置不授权上传、付费生成、发布、覆盖源文件或跳过门禁。
`;
}

function uniqueProjectDirectory(baseDirectory, projectName) {
  fs.mkdirSync(baseDirectory, { recursive: true });
  const stamp = new Date().toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replaceAll(":", "")
    .replace("T", "-");
  const base = `${slugify(projectName, "video")}-kacha-${stamp}`;
  let candidate = path.join(baseDirectory, base);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDirectory, `${base}-${index}`);
    index += 1;
  }
  fs.mkdirSync(candidate, { recursive: false, mode: 0o755 });
  return candidate;
}

function inspectOutputDestination(outputDirectory) {
  let cursor = path.resolve(outputDirectory);
  if (fs.existsSync(cursor) && !fs.statSync(cursor).isDirectory()) {
    throw new Error(`项目输出路径不是目录：${cursor}`);
  }
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!fs.existsSync(cursor) || !fs.statSync(cursor).isDirectory()) {
    throw new Error(`无法找到可用的输出目录父级：${outputDirectory}`);
  }
  try {
    fs.accessSync(cursor, fs.constants.W_OK);
  } catch {
    throw new Error(`项目输出目录不可写：${cursor}`);
  }
  return {
    requestedDirectory: path.resolve(outputDirectory),
    writableParent: cursor,
    willCreateDirectory: !fs.existsSync(path.resolve(outputDirectory)),
  };
}

export function compileProductionRequest(request, {
  environment = process.env,
  write = true,
} = {}) {
  const catalog = loadProductionCatalog({ environment });
  const media = probeVideo(request.videoPath);
  const normalized = normalizeProductionRequest(request, catalog, media);
  const outputDestination = inspectOutputDestination(normalized.outputDirectory);
  const current = loadKachaConfig({
    anchorPath: path.dirname(media.path),
    environment,
    includeSecrets: false,
  });
  const captionFontEvidence = resolveCaptionFontEvidence(normalized.style, current);
  const projectConfig = buildProjectConfig(normalized, media, catalog);
  projectConfig.editingDefaults.parameters.captionStyle.fontEvidence =
    captionFontEvidence;
  const resolvedDesign = resolveDesignSystem(projectConfig.style);
  const baseBrief = {
    schemaVersion: "1.0",
    kind: "kacha-production-brief",
    generatedAt: new Date().toISOString(),
    projectName: normalized.projectName,
    task: normalized.task,
    source: {
      ...media,
      readOnly: true,
      sha256: write ? sha256File(media.path) : null,
    },
    target: {
      platform: normalized.platform,
      language: normalized.language,
      show: normalized.show,
      outputPresetId: normalized.outputPresetId,
      preserveSource: normalized.preserveSource,
      targetDuration: normalized.targetDuration || null,
    },
    style: {
      id: normalized.style.id,
      name: normalized.style.name,
      builtIn: normalized.style.builtIn,
      designSystemId: resolvedDesign.system.id,
      designSystemVersion: resolvedDesign.system.version,
      designDigest: resolvedDesign.digest,
      modes: resolvedDesign.selectedModes,
      caption: clone(normalized.style.caption),
      captionFontEvidence,
      audio: clone(normalized.style.audio),
      bgm: {
        ...clone(normalized.style.bgm),
        enabled:
          normalized.backgroundMusicEnabled
          && normalized.style.bgm.presetId !== "none",
      },
      beauty: clone(normalized.style.beauty),
      direction: clone(normalized.style.direction),
      projectOverrides: clone(normalized.projectOverrides),
      visualLanguageSelection: clone(normalized.visualLanguageSelection),
    },
    opening: {
      id: normalized.openingId,
      label: normalized.openingEffect.label,
      source: normalized.openingEffect.source ?? "core-opening-registry",
      required: true,
      primaryEffectCount: 1,
      startAtOrBeforeSeconds:
        catalog.productionMotionPolicy.opening.startAtOrBeforeSeconds,
      promiseBySeconds: catalog.productionMotionPolicy.opening.promiseBySeconds,
      normalSpeedPreviewRequired: true,
    },
    effectAssignments: clone(normalized.effectAssignments),
    professionalAutoDirector: {
      enabled: normalized.automaticProfessionalJudgment,
      rules: normalized.automaticProfessionalJudgment
        ? clone(catalog.professionalAutoDirector.rules)
        : [],
      decisionBoundary:
        "自动选择只适用于用户未明确指定的区间；不得越过内容、素材、授权和质量门禁。",
    },
    intelligenceV6: {
      required: true,
      compatibilityMode: false,
      evidenceBoundary:
        "director、asset gap、Timeline、temporal perception 与 semantic review 必须属于同一当前项目证据集。",
    },
    configuration: {
      baselineDigest: current.digest,
      productionCatalogDigest: catalog.digest,
      projectConfigDigest: sha256Value(projectConfig),
      sources: current.sources,
    },
    authorityBoundary: catalog.authorityBoundary,
  };
  if (!write) {
    return {
      schemaVersion: "1.0",
      status: "pass",
      validationDigest: sha256Value({
        request: normalized,
        media: {
          path: media.path,
          width: media.width,
          height: media.height,
          fps: media.fps,
          durationSeconds: media.durationSeconds,
        },
        font: captionFontEvidence.sha256,
        design: resolvedDesign.digest,
      }),
      readiness: {
        sourceReadable: true,
        sourceReadOnly: true,
        outputWritable: true,
        fontAuthorized: true,
        designResolved: true,
        effectsResolved: normalized.effectAssignments.length,
        outputDestination,
      },
      request: normalized,
      brief: baseBrief,
      projectConfig,
    };
  }
  const projectDirectory = uniqueProjectDirectory(
    normalized.outputDirectory,
    normalized.projectName,
  );
  const configPath = path.join(projectDirectory, "kacha.config.json");
  const briefPath = path.join(projectDirectory, "production-brief.json");
  const agentPath = path.join(projectDirectory, "AGENT_INSTRUCTIONS.md");
  writeJsonAtomic(configPath, projectConfig);
  const validated = loadKachaConfig({
    anchorPath: projectDirectory,
    environment,
    includeSecrets: false,
  });
  writeJsonAtomic(briefPath, {
    ...baseBrief,
    configuration: {
      ...baseBrief.configuration,
      effectiveDigest: validated.digest,
      effectiveSources: validated.sources,
    },
    files: {
      projectDirectory,
      configPath,
      agentInstructionsPath: agentPath,
    },
  });
  fs.writeFileSync(
    agentPath,
    agentInstructions(briefPath, configPath, normalized),
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
  const orchestration = initializeProject({
    briefPath,
    projectRoot: projectDirectory,
    projectId: slugify(normalized.projectName, "video"),
    task: normalized.task,
    show: normalized.show,
    style: normalized.style.id,
    platform: normalized.platform,
    language: normalized.language,
    confirmExecute: false,
    development: false,
    enforceRuntime: false,
  });
  return {
    schemaVersion: "1.0",
    status: "pass",
    projectDirectory,
    briefPath,
    configPath,
    agentInstructionsPath: agentPath,
    effectiveConfigurationDigest: validated.digest,
    designDigest: resolveDesignSystem(validated.config.style).digest,
    source: media.path,
    orchestration: {
      status: orchestration.status,
      projectRoot: orchestration.projectRoot,
      lifecycle: orchestration.lifecycle,
      milestones: orchestration.milestones,
      nextAction: orchestration.nextAction,
      manifest: orchestration.files.manifest,
      v6Required: orchestration.intelligenceV6.required,
    },
    authorityBoundary: catalog.authorityBoundary,
  };
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs studio catalog\n"
      + "  kacha.mjs studio validate\n"
      + "  kacha.mjs studio probe --video VIDEO\n"
      + "  kacha.mjs studio save-style --input STYLE.json\n"
      + "  kacha.mjs studio preview --request REQUEST.json\n"
      + "  kacha.mjs studio compile --request REQUEST.json [--output-dir DIR]\n"
      + "  kacha.mjs studio serve [--port 4179] [--no-open]",
  );
}

async function runCli() {
  const args = process.argv.slice(2);
  const action = args[0];
  try {
    if (action === "catalog" || action === "validate") {
      const catalog = loadProductionCatalog();
      console.log(JSON.stringify(
        action === "catalog"
          ? catalog
          : {
              schemaVersion: "1.0",
              status: "pass",
              defaultStyleId: catalog.defaultStyleId,
              builtInStyleCount: catalog.styles.filter((style) => style.builtIn).length,
              customStyleCount: catalog.styles.filter((style) => !style.builtIn).length,
              visualLanguageCount: catalog.visualLanguages.length,
              defaultVisualLanguageSelectionMode:
                catalog.visualLanguagePolicy.defaultSelectionMode,
              visualLanguageParentProfile:
                catalog.visualLanguagePolicy.parentProfile,
              openingCount: catalog.openings.length,
              assignableEffectCount: catalog.assignableEffects.length,
              digest: catalog.digest,
            },
        null,
        2,
      ));
      return;
    }
    if (action === "probe") {
      console.log(JSON.stringify(inspectProductionVideo(option(args, "--video")), null, 2));
      return;
    }
    if (action === "save-style") {
      const input = option(args, "--input");
      if (!input) throw new Error("save-style 需要 --input STYLE.json");
      console.log(JSON.stringify(saveCustomStyle(readJson(path.resolve(input))), null, 2));
      return;
    }
    if (action === "preview" || action === "compile") {
      const requestFile = option(args, "--request");
      if (!requestFile) throw new Error(`${action} 需要 --request REQUEST.json`);
      const request = readJson(path.resolve(requestFile));
      const outputDirectory = option(args, "--output-dir");
      if (outputDirectory) request.outputDirectory = path.resolve(outputDirectory);
      console.log(JSON.stringify(
        compileProductionRequest(request, { write: action === "compile" }),
        null,
        2,
      ));
      return;
    }
    if (action === "serve") {
      const server = path.join(scriptDirectory, "kacha_studio_server.mjs");
      const child = spawn(process.execPath, [server, ...args.slice(1)], {
        stdio: "inherit",
      });
      const status = await new Promise((resolve) => {
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
      });
      process.exitCode = status;
      return;
    }
    usage();
    process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: "1.0",
      status: "blocked",
      error: error.message,
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
