#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasValue,
  readJson,
  sha256Value,
} from "./kacha_utils.mjs";
import { resolveDesignSystem } from "./design_system.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const defaultsFile = path.join(skillRoot, "config", "defaults.json");
const TASKS = new Set([
  "all",
  "proposal_review",
  "source_edit",
  "content_generation",
  "local_optimization",
]);
const PRIORITIES = new Set(["low", "normal", "high", "required"]);
const RECIPE_NAMES = new Set([
  "beauty",
  "color",
  "visual_interval",
  "netstyle",
  "caption_layout",
  "visual_breathing",
  "insert_replace",
  "dialogue",
  "bgm",
  "sfx",
  "subtitles",
  "covers",
  "metadata",
  "remove",
  "reorder",
  "geometry",
  "style",
  "timing_sync",
  "popup_layout",
  "connections",
  "facefusion",
]);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "editingDefaults",
  "style",
  "execution",
  "tools",
  "providers",
]);
const EXECUTION_KEYS = new Set([
  "modelTier",
  "telemetry",
  "unifiedRender",
  "artifactCache",
  "resourceScheduling",
  "asr",
  "referenceTokenLimits",
  "incremental",
  "netstyle",
  "visualBreathing",
  "spokenCaptions",
  "fonts",
  "visualEvidence",
  "minimaxVision",
  "qualityControl",
  "sourceSeparation",
  "voiceEnhancement",
  "stockMedia",
]);
const EDITING_KEYS = new Set(["parameters", "instructions", "recipeParameters"]);
const STYLE_KEYS = new Set(["system", "profile", "modes", "overrides"]);
const STYLE_MODE_KEYS = new Set([
  "show",
  "aspectRatio",
  "language",
  "surface",
  "density",
]);
const TOOLS_KEYS = new Set([
  "demucsBin",
  "sfxLibrary",
  "fontRegistry",
  "whisperEndpoint",
  "faceFusionEndpoint",
  "faceFusionTokenFile",
  "resourceCatalog",
]);
const PROVIDER_KEYS = {
  minimax: new Set(["credentialEnv", "region", "baseUrl"]),
  pixabay: new Set(["credentialEnv"]),
  pexels: new Set(["credentialEnv"]),
};
const FORBIDDEN_AUTH_KEYS = new Set([
  "authorization",
  "approval",
  "canexecute",
  "canpublish",
  "canupload",
  "externaluploadallowed",
  "humanreviewcompleted",
  "paidgenerationallowed",
  "publishallowed",
  "releaseapproved",
  "skipgates",
  "skipqc",
  "overwritesource",
  "uploadallowed",
]);
const BEAUTY_PREFERENCE_KEYS = new Set(["enabled", "engine", "profile", "tuning"]);
const BEAUTY_TUNING_KEYS = new Set([
  "smoothing",
  "whitening",
  "toneEvening",
  "nasolabialSoftening",
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

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是 JSON object`);
}

function rejectDangerousKeys(value, label = "config") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectDangerousKeys(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error(`${label} 包含不安全键：${key}`);
    }
    rejectDangerousKeys(child, `${label}.${key}`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} 包含未知字段：${key}`);
  }
}

function assertNumber(value, label, minimum, maximum, integer = false) {
  if (
    !Number.isFinite(value)
    || value < minimum
    || value > maximum
    || (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `${label} 必须是 ${minimum} 至 ${maximum} 的${integer ? "整数" : "数值"}`,
    );
  }
}

function assertString(value, label, { nullable = false, pattern = null } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 必须是非空字符串${nullable ? "或 null" : ""}`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} 格式无效`);
}

function assertPathOrNull(value, label) {
  if (value === null) return;
  assertString(value, label);
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} 必须是绝对路径或 null`);
  }
}

function normalizeStringArray(value, label) {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) throw new Error(`${label} 必须是字符串或字符串数组`);
  const normalized = values.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${label} 只能包含非空字符串`);
    }
    return item.trim();
  });
  return [...new Set(normalized)];
}

function normalizeInstruction(value, index, label) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) throw new Error(`${label}[${index}] 不能为空`);
    return {
      id: `instruction-${sha256Value(text).slice(0, 12)}`,
      text,
      appliesTo: ["all"],
      modules: [],
      priority: "normal",
    };
  }
  assertPlainObject(value, `${label}[${index}]`);
  const allowed = new Set(["id", "text", "appliesTo", "modules", "priority"]);
  rejectUnknownKeys(value, allowed, `${label}[${index}]`);
  assertString(value.text, `${label}[${index}].text`);
  const text = value.text.trim();
  const id = hasValue(value.id)
    ? String(value.id).trim()
    : `instruction-${sha256Value(text).slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`${label}[${index}].id 格式无效`);
  }
  const appliesTo = normalizeStringArray(
    value.appliesTo ?? ["all"],
    `${label}[${index}].appliesTo`,
  );
  for (const task of appliesTo) {
    if (!TASKS.has(task)) throw new Error(`${label}[${index}].appliesTo 未知：${task}`);
  }
  const modules = normalizeStringArray(
    value.modules ?? [],
    `${label}[${index}].modules`,
  );
  const priority = value.priority ?? "normal";
  if (!PRIORITIES.has(priority)) {
    throw new Error(`${label}[${index}].priority 未知：${priority}`);
  }
  return { id, text, appliesTo, modules, priority };
}

function normalizeInstructions(value, label) {
  const values = value === undefined
    ? []
    : typeof value === "string"
      ? [value]
      : value;
  if (!Array.isArray(values)) throw new Error(`${label} 必须是字符串或数组`);
  return values.map((item, index) => normalizeInstruction(item, index, label));
}

function assertNoAuthorityOverride(value, label = "editingDefaults.parameters") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAuthorityOverride(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (FORBIDDEN_AUTH_KEYS.has(normalizedKey)) {
      throw new Error(
        `${label}.${key} 属于逐项目授权/门禁，不能由默认配置设置`,
      );
    }
    assertNoAuthorityOverride(child, `${label}.${key}`);
  }
}

function validateBeautyPreference(value, label, { complete = false } = {}) {
  assertPlainObject(value, label);
  rejectUnknownKeys(value, BEAUTY_PREFERENCE_KEYS, label);
  if (complete || value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new Error(`${label}.enabled 必须是 boolean`);
    }
  }
  if (complete || value.engine !== undefined) {
    if (value.engine !== "beauty-v2") {
      throw new Error(`${label}.engine 必须为 beauty-v2`);
    }
  }
  if (complete || value.profile !== undefined) {
    if (!["natural", "visible"].includes(value.profile)) {
      throw new Error(`${label}.profile 必须为 natural 或 visible`);
    }
  }
  if (value.tuning !== undefined) {
    assertPlainObject(value.tuning, `${label}.tuning`);
    rejectUnknownKeys(value.tuning, BEAUTY_TUNING_KEYS, `${label}.tuning`);
    for (const key of BEAUTY_TUNING_KEYS) {
      assertNumber(value.tuning[key], `${label}.tuning.${key}`, 0, 100);
    }
  }
}

function validateConfigLayer(value, label) {
  rejectDangerousKeys(value, label);
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, label);
  if (value.schemaVersion !== "1.0") {
    throw new Error(`${label}.schemaVersion 必须为 1.0`);
  }
  if (value.editingDefaults !== undefined) {
    rejectUnknownKeys(value.editingDefaults, EDITING_KEYS, `${label}.editingDefaults`);
    if (value.editingDefaults.parameters !== undefined) {
      assertPlainObject(
        value.editingDefaults.parameters,
        `${label}.editingDefaults.parameters`,
      );
      assertNoAuthorityOverride(
        value.editingDefaults.parameters,
        `${label}.editingDefaults.parameters`,
      );
      if (value.editingDefaults.parameters.beauty !== undefined) {
        validateBeautyPreference(
          value.editingDefaults.parameters.beauty,
          `${label}.editingDefaults.parameters.beauty`,
        );
      }
    }
    normalizeInstructions(
      value.editingDefaults.instructions,
      `${label}.editingDefaults.instructions`,
    );
    if (value.editingDefaults.recipeParameters !== undefined) {
      assertPlainObject(
        value.editingDefaults.recipeParameters,
        `${label}.editingDefaults.recipeParameters`,
      );
      for (const [recipe, parameters] of Object.entries(
        value.editingDefaults.recipeParameters,
      )) {
        if (!RECIPE_NAMES.has(recipe)) {
          throw new Error(
            `${label}.editingDefaults.recipeParameters 未知配方：${recipe}`,
          );
        }
        assertPlainObject(
          parameters,
          `${label}.editingDefaults.recipeParameters.${recipe}`,
        );
        assertNoAuthorityOverride(
          parameters,
          `${label}.editingDefaults.recipeParameters.${recipe}`,
        );
      }
    }
  }
  if (value.style !== undefined) {
    rejectUnknownKeys(value.style, STYLE_KEYS, `${label}.style`);
    if (value.style.system !== undefined) {
      assertString(value.style.system, `${label}.style.system`, {
        pattern: /^[a-z0-9][a-z0-9-]{0,63}$/,
      });
    }
    if (value.style.profile !== undefined) {
      assertString(value.style.profile, `${label}.style.profile`, {
        pattern: /^[a-z0-9][a-z0-9-]{0,63}$/,
      });
    }
    if (value.style.modes !== undefined) {
      rejectUnknownKeys(value.style.modes, STYLE_MODE_KEYS, `${label}.style.modes`);
      for (const [dimension, mode] of Object.entries(value.style.modes)) {
        assertString(mode, `${label}.style.modes.${dimension}`, {
          pattern: /^[a-z0-9][a-z0-9-]{0,63}$/,
        });
      }
    }
    if (value.style.overrides !== undefined) {
      assertPlainObject(value.style.overrides, `${label}.style.overrides`);
      assertNoAuthorityOverride(value.style.overrides, `${label}.style.overrides`);
    }
  }
  if (value.execution !== undefined) {
    rejectUnknownKeys(value.execution, EXECUTION_KEYS, `${label}.execution`);
  }
  if (value.tools !== undefined) {
    rejectUnknownKeys(value.tools, TOOLS_KEYS, `${label}.tools`);
  }
  if (value.providers !== undefined) {
    assertPlainObject(value.providers, `${label}.providers`);
    for (const [provider, config] of Object.entries(value.providers)) {
      if (!Object.hasOwn(PROVIDER_KEYS, provider)) {
        throw new Error(`${label}.providers 未知 provider：${provider}`);
      }
      rejectUnknownKeys(
        config,
        PROVIDER_KEYS[provider],
        `${label}.providers.${provider}`,
      );
    }
  }
}

function validateLayerTrust(value, scope) {
  if (!["project", "project_local"].includes(scope)) return;
  if (value.providers !== undefined) {
    throw new Error(
      `${scope} 配置不能设置 providers；凭证环境名、区域和 API 地址只能放在用户配置或显式 --config 中`,
    );
  }
  if (value.tools !== undefined) {
    throw new Error(
      `${scope} 配置不能设置 tools；可执行程序和本机素材库路径只能放在用户配置或显式 --config 中`,
    );
  }
}

function validateEffectiveConfig(config) {
  validateConfigLayer(config, "effectiveConfig");
  validateBeautyPreference(
    config.editingDefaults.parameters.beauty,
    "effectiveConfig.editingDefaults.parameters.beauty",
    { complete: true },
  );
  resolveDesignSystem(config.style);
  if (!["economy", "balanced", "frontier"].includes(config.execution.modelTier)) {
    throw new Error("execution.modelTier 必须为 economy、balanced 或 frontier");
  }
  const telemetry = config.execution.telemetry;
  rejectUnknownKeys(
    telemetry,
    new Set([
      "enabled",
      "scope",
      "directory",
      "compactToolOutput",
      "maxLogBytes",
      "maxFailureSummaryCharacters",
    ]),
    "execution.telemetry",
  );
  if (telemetry.enabled !== true) {
    throw new Error("execution.telemetry.enabled 必须保持 true");
  }
  assertString(telemetry.directory, "execution.telemetry.directory");
  if (path.isAbsolute(telemetry.directory) || telemetry.directory.split(/[\\/]/).includes("..")) {
    throw new Error("execution.telemetry.directory 必须是项目内安全相对路径");
  }
  if (telemetry.compactToolOutput !== true) {
    throw new Error("execution.telemetry.compactToolOutput 必须保持 true");
  }
  assertNumber(telemetry.maxLogBytes, "execution.telemetry.maxLogBytes", 1024, 1_073_741_824, true);
  assertNumber(
    telemetry.maxFailureSummaryCharacters,
    "execution.telemetry.maxFailureSummaryCharacters",
    120,
    10_000,
    true,
  );
  const unifiedRender = config.execution.unifiedRender;
  rejectUnknownKeys(
    unifiedRender,
    new Set(["enabled", "singleFinalVideoEncode", "preview", "final"]),
    "execution.unifiedRender",
  );
  if (unifiedRender.enabled !== true) {
    throw new Error("execution.unifiedRender.enabled 必须保持 true");
  }
  if (unifiedRender.singleFinalVideoEncode !== true) {
    throw new Error("execution.unifiedRender.singleFinalVideoEncode 必须保持 true");
  }
  for (const profile of ["preview", "final"]) {
    const current = unifiedRender[profile];
    const keys = profile === "preview"
      ? ["maxWidth", "encoder", "fallbackEncoder", "preset", "crf"]
      : ["encoder", "fallbackEncoder", "preset", "crf"];
    rejectUnknownKeys(current, new Set(keys), `execution.unifiedRender.${profile}`);
    if (profile === "preview") {
      assertNumber(current.maxWidth, "execution.unifiedRender.preview.maxWidth", 320, 3840, true);
    }
    assertString(current.encoder, `execution.unifiedRender.${profile}.encoder`);
    assertString(current.fallbackEncoder, `execution.unifiedRender.${profile}.fallbackEncoder`);
    assertString(current.preset, `execution.unifiedRender.${profile}.preset`);
    assertNumber(current.crf, `execution.unifiedRender.${profile}.crf`, 0, 40, true);
  }
  const artifactCache = config.execution.artifactCache;
  rejectUnknownKeys(
    artifactCache,
    new Set([
      "enabled",
      "directory",
      "materialization",
      "verifySha256",
      "maximumBytes",
      "highValueKinds",
    ]),
    "execution.artifactCache",
  );
  if (artifactCache.enabled !== true) {
    throw new Error("execution.artifactCache.enabled 必须保持 true");
  }
  assertString(artifactCache.directory, "execution.artifactCache.directory");
  if (
    path.isAbsolute(artifactCache.directory)
    || artifactCache.directory.split(/[\\/]/).includes("..")
  ) {
    throw new Error("execution.artifactCache.directory 必须是项目内安全相对路径");
  }
  if (!["copy", "hardlink"].includes(artifactCache.materialization)) {
    throw new Error("execution.artifactCache.materialization 必须为 copy 或 hardlink");
  }
  if (artifactCache.verifySha256 !== true) {
    throw new Error("execution.artifactCache.verifySha256 必须保持 true");
  }
  assertNumber(
    artifactCache.maximumBytes,
    "execution.artifactCache.maximumBytes",
    1024 * 1024,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  const cacheKinds = normalizeStringArray(
    artifactCache.highValueKinds,
    "execution.artifactCache.highValueKinds",
  );
  for (const required of [
    "source_separation",
    "asr",
    "mask",
    "tracking",
    "beauty",
    "styleframe",
    "generated_media",
  ]) {
    if (!cacheKinds.includes(required)) {
      throw new Error(`artifactCache.highValueKinds 缺少 ${required}`);
    }
  }
  const resourceScheduling = config.execution.resourceScheduling;
  rejectUnknownKeys(
    resourceScheduling,
    new Set([
      "enabled",
      "scope",
      "directory",
      "waitTimeoutSeconds",
      "pollIntervalMs",
      "capacities",
    ]),
    "execution.resourceScheduling",
  );
  if (resourceScheduling.enabled !== true) {
    throw new Error("execution.resourceScheduling.enabled 必须保持 true");
  }
  if (!["host", "project"].includes(resourceScheduling.scope)) {
    throw new Error("execution.resourceScheduling.scope 必须为 host 或 project");
  }
  assertString(resourceScheduling.directory, "execution.resourceScheduling.directory");
  if (
    path.isAbsolute(resourceScheduling.directory)
    || resourceScheduling.directory.split(/[\\/]/).includes("..")
  ) {
    throw new Error("execution.resourceScheduling.directory 必须是安全相对路径");
  }
  assertNumber(
    resourceScheduling.waitTimeoutSeconds,
    "execution.resourceScheduling.waitTimeoutSeconds",
    1,
    86_400,
    true,
  );
  assertNumber(
    resourceScheduling.pollIntervalMs,
    "execution.resourceScheduling.pollIntervalMs",
    25,
    5_000,
    true,
  );
  rejectUnknownKeys(
    resourceScheduling.capacities,
    new Set(["cpuHeavy", "mps", "videoEncode", "network", "ioHeavy"]),
    "execution.resourceScheduling.capacities",
  );
  for (const resource of ["cpuHeavy", "mps", "videoEncode", "network", "ioHeavy"]) {
    assertNumber(
      resourceScheduling.capacities[resource],
      `execution.resourceScheduling.capacities.${resource}`,
      1,
      64,
      true,
    );
  }
  if (resourceScheduling.capacities.mps !== 1) {
    throw new Error("resourceScheduling.capacities.mps 必须保持 1");
  }
  if (resourceScheduling.capacities.videoEncode !== 1) {
    throw new Error("resourceScheduling.capacities.videoEncode 必须保持 1");
  }
  const asr = config.execution.asr;
  rejectUnknownKeys(
    asr,
    new Set([
      "enabled",
      "provider",
      "language",
      "responseFormat",
      "wordTimestamps",
      "temperature",
      "conditionOnPreviousText",
      "audioStreamIndex",
      "normalizationSampleRate",
      "normalizationChannels",
      "timeoutSeconds",
      "cache",
      "lowConfidence",
    ]),
    "execution.asr",
  );
  if (asr.enabled !== true || asr.provider !== "local_whisper_mlx") {
    throw new Error("execution.asr 必须启用 local_whisper_mlx");
  }
  assertString(asr.language, "execution.asr.language");
  if (!["json", "verbose_json"].includes(asr.responseFormat)) {
    throw new Error("execution.asr.responseFormat 必须为 json 或 verbose_json");
  }
  if (
    typeof asr.wordTimestamps !== "boolean"
    || typeof asr.conditionOnPreviousText !== "boolean"
    || asr.cache !== true
  ) {
    throw new Error("execution.asr 的 wordTimestamps/conditionOnPreviousText/cache 无效");
  }
  assertNumber(asr.temperature, "execution.asr.temperature", 0, 1);
  assertNumber(
    asr.audioStreamIndex,
    "execution.asr.audioStreamIndex",
    0,
    31,
    true,
  );
  assertNumber(
    asr.normalizationSampleRate,
    "execution.asr.normalizationSampleRate",
    8_000,
    48_000,
    true,
  );
  assertNumber(
    asr.normalizationChannels,
    "execution.asr.normalizationChannels",
    1,
    2,
    true,
  );
  assertNumber(asr.timeoutSeconds, "execution.asr.timeoutSeconds", 10, 86_400, true);
  rejectUnknownKeys(
    asr.lowConfidence,
    new Set([
      "averageLogProbabilityBelow",
      "noSpeechProbabilityAbove",
      "compressionRatioAbove",
    ]),
    "execution.asr.lowConfidence",
  );
  assertNumber(
    asr.lowConfidence.averageLogProbabilityBelow,
    "execution.asr.lowConfidence.averageLogProbabilityBelow",
    -10,
    0,
  );
  assertNumber(
    asr.lowConfidence.noSpeechProbabilityAbove,
    "execution.asr.lowConfidence.noSpeechProbabilityAbove",
    0,
    1,
  );
  assertNumber(
    asr.lowConfidence.compressionRatioAbove,
    "execution.asr.lowConfidence.compressionRatioAbove",
    1,
    10,
  );
  assertString(config.tools.whisperEndpoint, "tools.whisperEndpoint");
  let whisperEndpoint;
  try {
    whisperEndpoint = new URL(config.tools.whisperEndpoint);
  } catch {
    throw new Error("tools.whisperEndpoint 必须是有效 URL");
  }
  if (
    whisperEndpoint.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1"].includes(whisperEndpoint.hostname)
  ) {
    throw new Error("tools.whisperEndpoint 必须是本机 loopback HTTP 地址");
  }
  assertString(config.tools.faceFusionEndpoint, "tools.faceFusionEndpoint");
  let faceFusionEndpoint;
  try {
    faceFusionEndpoint = new URL(config.tools.faceFusionEndpoint);
  } catch {
    throw new Error("tools.faceFusionEndpoint 必须是有效 URL");
  }
  if (
    faceFusionEndpoint.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1"].includes(faceFusionEndpoint.hostname)
  ) {
    throw new Error("tools.faceFusionEndpoint 必须是本机 loopback HTTP 地址");
  }
  rejectUnknownKeys(
    config.execution.referenceTokenLimits,
    new Set(["economy", "balanced", "frontier"]),
    "execution.referenceTokenLimits",
  );
  for (const tier of ["economy", "balanced", "frontier"]) {
    assertNumber(
      config.execution.referenceTokenLimits[tier],
      `execution.referenceTokenLimits.${tier}`,
      1000,
      2_000_000,
      true,
    );
  }
  rejectUnknownKeys(
    config.execution.incremental,
    new Set(["handleFrames"]),
    "execution.incremental",
  );
  assertNumber(
    config.execution.incremental.handleFrames,
    "execution.incremental.handleFrames",
    0,
    250,
    true,
  );
  const netstyle = config.execution.netstyle;
  rejectUnknownKeys(
    netstyle,
    new Set([
      "automaticPlanning",
      "maximumPrimaryEffectsPer10Seconds",
      "minimumGapSeconds",
      "maximumConcurrentPrimaryEffects",
      "representativeValidationCountPerEffect",
      "renderCrf",
    ]),
    "execution.netstyle",
  );
  if (typeof netstyle.automaticPlanning !== "boolean") {
    throw new Error("execution.netstyle.automaticPlanning 必须是 boolean");
  }
  assertNumber(
    netstyle.maximumPrimaryEffectsPer10Seconds,
    "execution.netstyle.maximumPrimaryEffectsPer10Seconds",
    0.5,
    6,
  );
  assertNumber(
    netstyle.minimumGapSeconds,
    "execution.netstyle.minimumGapSeconds",
    0,
    5,
  );
  assertNumber(
    netstyle.maximumConcurrentPrimaryEffects,
    "execution.netstyle.maximumConcurrentPrimaryEffects",
    1,
    1,
    true,
  );
  assertNumber(
    netstyle.representativeValidationCountPerEffect,
    "execution.netstyle.representativeValidationCountPerEffect",
    1,
    1,
    true,
  );
  assertNumber(netstyle.renderCrf, "execution.netstyle.renderCrf", 0, 28, true);
  const breathing = config.execution.visualBreathing;
  rejectUnknownKeys(
    breathing,
    new Set([
      "automaticPlanning",
      "maximumPrimaryEventsPer10Seconds",
      "minimumGapSeconds",
      "maximumMotionCoverageRatio",
      "minimumStillCoverageRatio",
      "renderCrf",
    ]),
    "execution.visualBreathing",
  );
  if (typeof breathing.automaticPlanning !== "boolean") {
    throw new Error("execution.visualBreathing.automaticPlanning 必须是 boolean");
  }
  assertNumber(
    breathing.maximumPrimaryEventsPer10Seconds,
    "execution.visualBreathing.maximumPrimaryEventsPer10Seconds",
    0.25,
    4,
  );
  assertNumber(
    breathing.minimumGapSeconds,
    "execution.visualBreathing.minimumGapSeconds",
    0.2,
    8,
  );
  assertNumber(
    breathing.maximumMotionCoverageRatio,
    "execution.visualBreathing.maximumMotionCoverageRatio",
    0.1,
    0.8,
  );
  assertNumber(
    breathing.minimumStillCoverageRatio,
    "execution.visualBreathing.minimumStillCoverageRatio",
    0.2,
    0.9,
  );
  if (
    breathing.maximumMotionCoverageRatio + breathing.minimumStillCoverageRatio < 0.99
    || breathing.maximumMotionCoverageRatio + breathing.minimumStillCoverageRatio > 1.01
  ) {
    throw new Error("visualBreathing 的运动与停稳覆盖率必须合计为 1");
  }
  assertNumber(breathing.renderCrf, "execution.visualBreathing.renderCrf", 0, 28, true);
  const captions = config.execution.spokenCaptions;
  rejectUnknownKeys(
    captions,
    new Set([
      "automaticLayout",
      "defaultLayout",
      "maximumSimultaneousReadingZones",
      "ordinarySubtitleSfx",
      "renderCrf",
    ]),
    "execution.spokenCaptions",
  );
  if (typeof captions.automaticLayout !== "boolean") {
    throw new Error("execution.spokenCaptions.automaticLayout 必须是 boolean");
  }
  assertString(captions.defaultLayout, "execution.spokenCaptions.defaultLayout");
  assertNumber(
    captions.maximumSimultaneousReadingZones,
    "execution.spokenCaptions.maximumSimultaneousReadingZones",
    1,
    3,
    true,
  );
  if (captions.ordinarySubtitleSfx !== "none") {
    throw new Error("execution.spokenCaptions.ordinarySubtitleSfx 必须为 none");
  }
  assertNumber(captions.renderCrf, "execution.spokenCaptions.renderCrf", 0, 28, true);
  const fonts = config.execution.fonts;
  rejectUnknownKeys(
    fonts,
    new Set([
      "autoDiscoverProjectFonts",
      "directories",
      "allowRestrictedByDefault",
      "publicRedistribution",
      "routingProfile",
    ]),
    "execution.fonts",
  );
  if (typeof fonts.autoDiscoverProjectFonts !== "boolean") {
    throw new Error("execution.fonts.autoDiscoverProjectFonts 必须是 boolean");
  }
  normalizeStringArray(fonts.directories, "execution.fonts.directories");
  if (typeof fonts.allowRestrictedByDefault !== "boolean") {
    throw new Error("execution.fonts.allowRestrictedByDefault 必须是 boolean");
  }
  if (fonts.allowRestrictedByDefault) {
    throw new Error("execution.fonts.allowRestrictedByDefault 必须保持 false");
  }
  if (fonts.publicRedistribution !== false) {
    throw new Error("execution.fonts.publicRedistribution 必须保持 false");
  }
  assertString(fonts.routingProfile, "execution.fonts.routingProfile");
  rejectUnknownKeys(
    config.execution.visualEvidence,
    new Set(["defaultMode", "maxFrames", "sceneThreshold", "workers", "maxImageEdge"]),
    "execution.visualEvidence",
  );
  if (!["fast", "review", "release"].includes(config.execution.visualEvidence.defaultMode)) {
    throw new Error("execution.visualEvidence.defaultMode 无效");
  }
  rejectUnknownKeys(
    config.execution.visualEvidence.maxFrames,
    new Set(["fast", "review", "release"]),
    "execution.visualEvidence.maxFrames",
  );
  for (const mode of ["fast", "review", "release"]) {
    assertNumber(
      config.execution.visualEvidence.maxFrames[mode],
      `execution.visualEvidence.maxFrames.${mode}`,
      3,
      48,
      true,
    );
  }
  assertNumber(
    config.execution.visualEvidence.sceneThreshold,
    "execution.visualEvidence.sceneThreshold",
    0.01,
    0.99,
  );
  assertNumber(
    config.execution.visualEvidence.workers,
    "execution.visualEvidence.workers",
    1,
    8,
    true,
  );
  assertNumber(
    config.execution.visualEvidence.maxImageEdge,
    "execution.visualEvidence.maxImageEdge",
    320,
    4096,
    true,
  );
  rejectUnknownKeys(
    config.execution.minimaxVision,
    new Set([
      "maxFrames",
      "hardMaxFrames",
      "timeoutSeconds",
      "maxImageBytes",
      "networkMode",
    ]),
    "execution.minimaxVision",
  );
  assertNumber(
    config.execution.minimaxVision.maxFrames,
    "execution.minimaxVision.maxFrames",
    1,
    12,
    true,
  );
  assertNumber(
    config.execution.minimaxVision.hardMaxFrames,
    "execution.minimaxVision.hardMaxFrames",
    config.execution.minimaxVision.maxFrames,
    12,
    true,
  );
  assertNumber(
    config.execution.minimaxVision.timeoutSeconds,
    "execution.minimaxVision.timeoutSeconds",
    10,
    600,
    true,
  );
  assertNumber(
    config.execution.minimaxVision.maxImageBytes,
    "execution.minimaxVision.maxImageBytes",
    1024,
    20 * 1024 * 1024,
    true,
  );
  if (!["direct_no_proxy", "configured_environment"].includes(
    config.execution.minimaxVision.networkMode,
  )) {
    throw new Error("execution.minimaxVision.networkMode 无效");
  }
  const qc = config.execution.qualityControl;
  rejectUnknownKeys(
    qc,
    new Set([
      "blackDurationSeconds",
      "blackPixelThreshold",
      "freezeNoiseDb",
      "freezeDurationSeconds",
      "silenceNoiseDb",
      "silenceDurationSeconds",
      "measurementTargetLufs",
      "measurementTruePeakDbtp",
      "measurementLoudnessRange",
      "bgmBelowDialogueMinDb",
      "bgmBelowDialogueMaxDb",
      "bgmMinimumCoverageRatio",
      "mixStemReconstructionPsnrMinDb",
      "finalMixPsnrMinDb",
    ]),
    "execution.qualityControl",
  );
  assertNumber(qc.blackDurationSeconds, "qualityControl.blackDurationSeconds", 0.01, 10);
  assertNumber(qc.blackPixelThreshold, "qualityControl.blackPixelThreshold", 0, 1);
  assertNumber(qc.freezeNoiseDb, "qualityControl.freezeNoiseDb", -120, 0);
  assertNumber(qc.freezeDurationSeconds, "qualityControl.freezeDurationSeconds", 0.05, 60);
  assertNumber(qc.silenceNoiseDb, "qualityControl.silenceNoiseDb", -120, 0);
  assertNumber(qc.silenceDurationSeconds, "qualityControl.silenceDurationSeconds", 0.05, 60);
  assertNumber(qc.measurementTargetLufs, "qualityControl.measurementTargetLufs", -70, -5);
  assertNumber(qc.measurementTruePeakDbtp, "qualityControl.measurementTruePeakDbtp", -20, 0);
  assertNumber(qc.measurementLoudnessRange, "qualityControl.measurementLoudnessRange", 1, 50);
  assertNumber(qc.bgmBelowDialogueMinDb, "qualityControl.bgmBelowDialogueMinDb", 0, 40);
  assertNumber(qc.bgmBelowDialogueMaxDb, "qualityControl.bgmBelowDialogueMaxDb", 0, 40);
  if (qc.bgmBelowDialogueMinDb > qc.bgmBelowDialogueMaxDb) {
    throw new Error("qualityControl 的 BGM 最小差值不能大于最大差值");
  }
  assertNumber(qc.bgmMinimumCoverageRatio, "qualityControl.bgmMinimumCoverageRatio", 0, 1);
  assertNumber(
    qc.mixStemReconstructionPsnrMinDb,
    "qualityControl.mixStemReconstructionPsnrMinDb",
    20,
    200,
  );
  assertNumber(
    qc.finalMixPsnrMinDb,
    "qualityControl.finalMixPsnrMinDb",
    10,
    100,
  );
  const sourceSeparation = config.execution.sourceSeparation;
  rejectUnknownKeys(
    sourceSeparation,
    new Set(["model", "device", "maxDurationDiffSeconds"]),
    "execution.sourceSeparation",
  );
  assertString(sourceSeparation.model, "execution.sourceSeparation.model");
  if (!["auto", "cpu", "cuda", "mps"].includes(sourceSeparation.device)) {
    throw new Error("execution.sourceSeparation.device 无效");
  }
  assertNumber(
    sourceSeparation.maxDurationDiffSeconds,
    "execution.sourceSeparation.maxDurationDiffSeconds",
    0,
    2,
  );
  const voice = config.execution.voiceEnhancement;
  rejectUnknownKeys(
    voice,
    new Set(["preset", "denoise", "declick", "targetLufs", "truePeakDbtp", "channelMode"]),
    "execution.voiceEnhancement",
  );
  if (!["natural", "warm", "warm-soft", "clear"].includes(voice.preset)) {
    throw new Error("execution.voiceEnhancement.preset 无效");
  }
  if (!["off", "light", "medium"].includes(voice.denoise)) {
    throw new Error("execution.voiceEnhancement.denoise 无效");
  }
  if (typeof voice.declick !== "boolean") {
    throw new Error("execution.voiceEnhancement.declick 必须是 boolean");
  }
  assertNumber(voice.targetLufs, "execution.voiceEnhancement.targetLufs", -40, -5);
  assertNumber(voice.truePeakDbtp, "execution.voiceEnhancement.truePeakDbtp", -20, 0);
  if (!["preserve", "mono", "stereo"].includes(voice.channelMode)) {
    throw new Error("execution.voiceEnhancement.channelMode 无效");
  }
  const stock = config.execution.stockMedia;
  rejectUnknownKeys(
    stock,
    new Set([
      "defaultLimit",
      "maximumLimit",
      "searchTimeoutSeconds",
      "downloadTimeoutSeconds",
    ]),
    "execution.stockMedia",
  );
  assertNumber(stock.defaultLimit, "execution.stockMedia.defaultLimit", 1, 5, true);
  assertNumber(stock.maximumLimit, "execution.stockMedia.maximumLimit", stock.defaultLimit, 5, true);
  assertNumber(stock.searchTimeoutSeconds, "execution.stockMedia.searchTimeoutSeconds", 5, 300, true);
  assertNumber(stock.downloadTimeoutSeconds, "execution.stockMedia.downloadTimeoutSeconds", 5, 900, true);
  assertPathOrNull(config.tools.demucsBin, "tools.demucsBin");
  assertPathOrNull(config.tools.sfxLibrary, "tools.sfxLibrary");
  assertPathOrNull(config.tools.fontRegistry, "tools.fontRegistry");
  assertPathOrNull(config.tools.faceFusionTokenFile, "tools.faceFusionTokenFile");
  assertPathOrNull(config.tools.resourceCatalog, "tools.resourceCatalog");
  for (const provider of ["minimax", "pixabay", "pexels"]) {
    assertString(
      config.providers[provider].credentialEnv,
      `providers.${provider}.credentialEnv`,
      { pattern: /^[A-Z_][A-Z0-9_]*$/ },
    );
  }
  if (!["cn", "global"].includes(config.providers.minimax.region)) {
    throw new Error("providers.minimax.region 必须为 cn 或 global");
  }
  if (
    config.providers.minimax.baseUrl !== null
    && !/^https:\/\/[^/\s]+(?:\/.*)?$/i.test(config.providers.minimax.baseUrl)
  ) {
    throw new Error("providers.minimax.baseUrl 必须是 https URL 或 null");
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function deepMerge(left, right, keyPath = []) {
  if (!isPlainObject(left) || !isPlainObject(right)) return deepClone(right);
  const merged = deepClone(left);
  for (const [key, value] of Object.entries(right)) {
    const currentPath = [...keyPath, key];
    if (currentPath.join(".") === "editingDefaults.instructions") {
      const current = normalizeInstructions(merged[key], "instructions");
      const additions = normalizeInstructions(value, "instructions");
      const byId = new Map(current.map((item) => [item.id, item]));
      for (const item of additions) {
        for (const [existingId, existing] of byId.entries()) {
          if (existing.text === item.text && existingId !== item.id) {
            byId.delete(existingId);
          }
        }
        byId.set(item.id, item);
      }
      merged[key] = [...byId.values()];
    } else if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMerge(merged[key], value, currentPath);
    } else {
      merged[key] = deepClone(value);
    }
  }
  return merged;
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

export function firstPositional(args, valueOptions = []) {
  const consumesValue = new Set(valueOptions);
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (consumesValue.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("--")) positionals.push(value);
  }
  return positionals[0] ?? null;
}

export function configRoot(environment = process.env) {
  if (hasValue(environment.KACHA_CONFIG_HOME)) {
    return path.resolve(environment.KACHA_CONFIG_HOME);
  }
  if (hasValue(environment.XDG_CONFIG_HOME)) {
    return path.resolve(environment.XDG_CONFIG_HOME, "kacha");
  }
  return path.join(os.homedir(), ".config", "kacha");
}

function anchorDirectory(anchorPath, cwd) {
  if (!hasValue(anchorPath)) return path.resolve(cwd);
  const resolved = path.resolve(anchorPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  return path.dirname(resolved);
}

function projectConfigCandidates(anchor) {
  const directories = [];
  let current = path.resolve(anchor);
  const home = path.resolve(os.homedir());
  while (true) {
    directories.push(current);
    if (current === home || current === path.dirname(current)) break;
    current = path.dirname(current);
  }
  return directories.reverse().flatMap((directory) => ([
    {
      scope: "project",
      path: path.join(directory, "kacha.config.json"),
      required: false,
    },
    {
      scope: "project_local",
      path: path.join(directory, "kacha.local.json"),
      required: false,
    },
  ]));
}

function readConfigFile(file, scope, { required = false } = {}) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`${scope} 配置不存在：${file}`);
    return null;
  }
  if (!fs.statSync(file).isFile()) throw new Error(`${scope} 配置不是文件：${file}`);
  let value;
  try {
    value = readJson(file);
  } catch (error) {
    throw new Error(`${scope} 配置 JSON 无法解析：${error.message}`);
  }
  validateConfigLayer(value, scope);
  validateLayerTrust(value, scope);
  value.editingDefaults = {
    ...(value.editingDefaults ?? {}),
    instructions: normalizeInstructions(
      value.editingDefaults?.instructions,
      `${scope}.editingDefaults.instructions`,
    ),
  };
  return {
    scope,
    path: path.resolve(file),
    value,
  };
}

function ensurePrivateSecretPermissions(file) {
  if (process.platform === "win32") return "not_applicable";
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `密钥文件权限过宽：${file} mode=${mode.toString(8)}；请执行 chmod 600`,
    );
  }
  return mode.toString(8).padStart(3, "0");
}

function readSecrets(file, { required = false } = {}) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`密钥文件不存在：${file}`);
    return {
      path: path.resolve(file),
      exists: false,
      permissions: null,
      values: {},
    };
  }
  if (!fs.statSync(file).isFile()) throw new Error(`密钥路径不是文件：${file}`);
  const permissions = ensurePrivateSecretPermissions(file);
  let value;
  try {
    value = readJson(file);
  } catch (error) {
    throw new Error(`密钥文件 JSON 无法解析：${error.message}`);
  }
  rejectDangerousKeys(value, "secrets");
  rejectUnknownKeys(value, new Set(["schemaVersion", "providers"]), "secrets");
  if (value.schemaVersion !== "1.0") throw new Error("secrets.schemaVersion 必须为 1.0");
  assertPlainObject(value.providers ?? {}, "secrets.providers");
  const values = {};
  for (const [provider, providerSecrets] of Object.entries(value.providers ?? {})) {
    if (!Object.hasOwn(PROVIDER_KEYS, provider)) {
      throw new Error(`secrets.providers 未知 provider：${provider}`);
    }
    rejectUnknownKeys(providerSecrets, new Set(["apiKey"]), `secrets.providers.${provider}`);
    if (providerSecrets.apiKey !== undefined && providerSecrets.apiKey !== "") {
      assertString(providerSecrets.apiKey, `secrets.providers.${provider}.apiKey`);
      values[provider] = providerSecrets.apiKey;
    }
  }
  return {
    path: path.resolve(file),
    exists: true,
    permissions,
    values,
  };
}

function uniqueFiles(entries) {
  const lastIndex = new Map();
  entries.forEach((entry, index) => {
    const resolved = path.resolve(entry.path);
    lastIndex.set(resolved, index);
  });
  return entries.filter(
    (entry, index) => lastIndex.get(path.resolve(entry.path)) === index,
  );
}

export function loadKachaConfig({
  args = [],
  anchorPath = null,
  cwd = process.cwd(),
  environment = process.env,
  includeSecrets = true,
} = {}) {
  const explicitConfig = option(args, "--config")
    || environment.KACHA_CONFIG
    || null;
  const explicitSecrets = option(args, "--secrets")
    || environment.KACHA_SECRETS_FILE
    || null;
  const root = configRoot(environment);
  const anchor = anchorDirectory(anchorPath, cwd);
  const candidates = [{
    scope: "built_in",
    path: defaultsFile,
    required: true,
  }];
  if (environment.KACHA_DISABLE_USER_CONFIG !== "1") {
    candidates.push({
      scope: "user",
      path: path.join(root, "config.json"),
      required: false,
    });
  }
  candidates.push(...projectConfigCandidates(anchor));
  if (explicitConfig) {
    candidates.push({
      scope: "explicit",
      path: path.resolve(explicitConfig),
      required: true,
    });
  }
  const layers = [];
  for (const candidate of uniqueFiles(candidates)) {
    const loaded = readConfigFile(candidate.path, candidate.scope, {
      required: candidate.required,
    });
    if (loaded) layers.push(loaded);
  }
  let config = {};
  for (const layer of layers) config = deepMerge(config, layer.value);
  validateEffectiveConfig(config);
  const secretsFile = explicitSecrets
    ? path.resolve(explicitSecrets)
    : path.join(root, "secrets.json");
  const secrets = includeSecrets
    ? readSecrets(secretsFile, { required: Boolean(explicitSecrets) })
    : {
        path: secretsFile,
        exists: fs.existsSync(secretsFile),
        permissions: null,
        values: {},
      };
  const credentialStatus = {};
  for (const provider of Object.keys(PROVIDER_KEYS)) {
    const envName = config.providers[provider].credentialEnv;
    const fromEnvironment = hasValue(environment[envName]);
    const fromSecrets = hasValue(secrets.values[provider]);
    credentialStatus[provider] = {
      env: envName,
      available: fromEnvironment || fromSecrets ? true : null,
      source: fromEnvironment
        ? "environment"
        : fromSecrets
          ? "secrets_file"
          : provider === "minimax"
            ? "delegated_to_mmx_auth_store"
            : "not_configured",
    };
  }
  const result = {
    schemaVersion: "1.0",
    config,
    digest: sha256Value(config),
    sources: layers.map((layer) => ({
      scope: layer.scope,
      path: layer.path,
    })),
    secrets: {
      path: secrets.path,
      exists: secrets.exists,
      permissions: secrets.permissions,
      credentials: credentialStatus,
    },
  };
  Object.defineProperty(result, "_secretValues", {
    enumerable: false,
    configurable: false,
    writable: false,
    value: secrets.values,
  });
  return result;
}

export function providerEnvironment(
  loaded,
  provider,
  baseEnvironment = process.env,
) {
  if (!Object.hasOwn(PROVIDER_KEYS, provider)) {
    throw new Error(`未知 provider：${provider}`);
  }
  const environment = { ...baseEnvironment };
  const providerConfig = loaded.config.providers[provider];
  const envName = providerConfig.credentialEnv;
  let source = hasValue(environment[envName]) ? "environment" : null;
  if (!source && hasValue(loaded._secretValues?.[provider])) {
    environment[envName] = loaded._secretValues[provider];
    source = "secrets_file";
  }
  return {
    environment,
    credential: {
      env: envName,
      source: source || (
        provider === "minimax"
          ? "delegated_to_mmx_auth_store"
          : "not_configured"
      ),
      available: source ? true : null,
    },
  };
}

export function applicableEditingDefaults(
  loaded,
  { task = "all", modules = [] } = {},
) {
  if (!TASKS.has(task)) throw new Error(`未知 task：${task}`);
  const moduleSet = new Set(modules);
  const instructions = loaded.config.editingDefaults.instructions.filter((item) => {
    const taskMatch = item.appliesTo.includes("all") || item.appliesTo.includes(task);
    const moduleMatch = item.modules.length === 0
      || item.modules.some((module) => moduleSet.has(module));
    return taskMatch && moduleMatch;
  });
  return {
    parameters: deepClone(loaded.config.editingDefaults.parameters),
    instructions: deepClone(instructions),
    recipeParameters: deepClone(loaded.config.editingDefaults.recipeParameters),
    style: {
      system: loaded.config.style.system,
      id: loaded.config.style.profile,
      modes: deepClone(loaded.config.style.modes),
      overrides: deepClone(loaded.config.style.overrides),
      digest: resolveDesignSystem(loaded.config.style).digest,
    },
    authorityBoundary:
      "默认要求是偏好与实施输入，不构成上传、付费、发布、覆盖源文件或跳过门禁的授权。",
  };
}

function valueAtPath(value, keyPath) {
  if (!hasValue(keyPath)) return value;
  let current = value;
  for (const key of keyPath.split(".")) {
    if (current === null || current === undefined || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function userConfigTemplate() {
  return {
    schemaVersion: "1.0",
    style: {
      system: "dahui-video-system",
      profile: "xingzhe",
      modes: {
        show: "tool-share",
        aspectRatio: "landscape-16x9",
        language: "zh",
        surface: "footage",
        density: "standard",
      },
      overrides: {},
    },
    editingDefaults: {
      parameters: {},
      instructions: [],
      recipeParameters: {},
    },
  };
}

function projectConfigTemplate() {
  return {
    schemaVersion: "1.0",
    style: {
      modes: {},
      overrides: {},
    },
    editingDefaults: {
      parameters: {},
      instructions: [],
      recipeParameters: {},
    },
  };
}

function secretsTemplate() {
  return {
    schemaVersion: "1.0",
    providers: {
      minimax: { apiKey: "" },
      pixabay: { apiKey: "" },
      pexels: { apiKey: "" },
    },
  };
}

function writeNewJson(file, value, mode = 0o644) {
  const resolved = path.resolve(file);
  if (fs.existsSync(resolved)) throw new Error(`拒绝覆盖已有文件：${resolved}`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode,
  });
  return resolved;
}

function cliUsage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs config show [--anchor PATH] [--config FILE] [--secrets FILE]\n"
      + "  kacha.mjs config validate [--anchor PATH] [--config FILE] [--secrets FILE]\n"
      + "  kacha.mjs config get --key dotted.path [--anchor PATH] [--output json|text]\n"
      + "  kacha.mjs config init --scope user|project [--output FILE]",
  );
}

function validateCliOptions(args, action) {
  const valueFlags = new Set([
    "--anchor",
    "--config",
    "--key",
    "--output",
    "--scope",
    "--secrets",
  ]);
  const allowedByAction = {
    show: new Set(["--anchor", "--config", "--secrets", "--no-secrets"]),
    validate: new Set(["--anchor", "--config", "--secrets", "--no-secrets"]),
    get: new Set([
      "--anchor",
      "--config",
      "--key",
      "--output",
      "--secrets",
      "--no-secrets",
    ]),
    init: new Set(["--scope", "--output"]),
  };
  const allowed = allowedByAction[action];
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag)) throw new Error(`未知参数：${flag}`);
    if (valueFlags.has(flag)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} 缺少参数值`);
      }
      index += 1;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];
  if (!["show", "validate", "get", "init"].includes(action)) {
    cliUsage();
    process.exit(2);
  }
  validateCliOptions(args, action);
  if (action === "init") {
    const scope = option(args, "--scope");
    const output = option(args, "--output");
    if (!["user", "project"].includes(scope)) {
      cliUsage();
      process.exit(2);
    }
    const root = configRoot();
    const configFile = output
      ? path.resolve(output)
      : scope === "user"
        ? path.join(root, "config.json")
        : path.resolve("kacha.config.json");
    const actions = [];
    if (fs.existsSync(configFile)) {
      readConfigFile(configFile, scope === "user" ? "user" : "project", {
        required: true,
      });
      actions.push({ path: path.resolve(configFile), action: "unchanged" });
    } else {
      actions.push({
        path: writeNewJson(
          configFile,
          scope === "user" ? userConfigTemplate() : projectConfigTemplate(),
        ),
        action: "created",
      });
    }
    if (scope === "user") {
      const secretFile = path.join(root, "secrets.json");
      if (fs.existsSync(secretFile)) {
        readSecrets(secretFile, { required: true });
        actions.push({ path: path.resolve(secretFile), action: "unchanged" });
      } else {
        actions.push({
          path: writeNewJson(secretFile, secretsTemplate(), 0o600),
          action: "created",
        });
      }
    }
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: actions.some((item) => item.action === "created")
        ? "created"
        : "unchanged",
      scope,
      files: actions.map((item) => item.path),
      actions,
    }, null, 2));
    return;
  }
  const anchor = option(args, "--anchor");
  let loaded;
  try {
    loaded = loadKachaConfig({
      args,
      anchorPath: anchor,
      includeSecrets: !args.includes("--no-secrets"),
    });
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: "1.0",
      status: "blocked",
      error: error.message,
    }, null, 2));
    process.exit(1);
  }
  if (action === "get") {
    const key = option(args, "--key");
    const output = option(args, "--output", "text");
    if (!key || !["text", "json"].includes(output)) {
      cliUsage();
      process.exit(2);
    }
    const value = valueAtPath(loaded.config, key);
    if (value === undefined || value === null) {
      if (output === "json") console.log("null");
      return;
    }
    if (output === "json" || typeof value !== "string") {
      console.log(JSON.stringify(value, null, 2));
    } else {
      console.log(value);
    }
    return;
  }
  const resolvedStyle = resolveDesignSystem(loaded.config.style);
  const report = {
    schemaVersion: "1.0",
    status: "pass",
    digest: loaded.digest,
    sources: loaded.sources,
    secrets: loaded.secrets,
    style: {
      system: resolvedStyle.system.id,
      systemVersion: resolvedStyle.system.version,
      id: resolvedStyle.style.id,
      modes: resolvedStyle.selectedModes,
      digest: resolvedStyle.digest,
      source: resolvedStyle.styleSource,
      ...(action === "show" ? {
        profile: resolvedStyle.style,
        layout: resolvedStyle.layout,
      } : {}),
    },
    ...(action === "show" ? { config: loaded.config } : {}),
  };
  console.log(JSON.stringify(report, null, 2));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: "1.0",
      status: "blocked",
      error: error.message,
    }, null, 2));
    process.exitCode = 1;
  }
}
