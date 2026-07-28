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
]);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "editingDefaults",
  "execution",
  "tools",
  "providers",
]);
const EXECUTION_KEYS = new Set([
  "modelTier",
  "referenceTokenLimits",
  "incremental",
  "visualEvidence",
  "minimaxVision",
  "qualityControl",
  "sourceSeparation",
  "voiceEnhancement",
  "stockMedia",
]);
const EDITING_KEYS = new Set(["parameters", "instructions", "recipeParameters"]);
const TOOLS_KEYS = new Set(["demucsBin", "sfxLibrary"]);
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
  if (!["economy", "balanced", "frontier"].includes(config.execution.modelTier)) {
    throw new Error("execution.modelTier 必须为 economy、balanced 或 frontier");
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
  if (!["natural", "warm", "clear"].includes(voice.preset)) {
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
  const report = {
    schemaVersion: "1.0",
    status: "pass",
    digest: loaded.digest,
    sources: loaded.sources,
    secrets: loaded.secrets,
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
