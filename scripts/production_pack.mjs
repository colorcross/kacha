import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sha256File } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packsDirectory = path.resolve(scriptDirectory, "..", "config", "production-packs");
const designSystemDirectory = path.resolve(scriptDirectory, "..", "config", "design-system");
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_JSON_FILE = /^[a-z0-9][a-z0-9-]*\.json$/;

function merge(base, override) {
  if (Array.isArray(override)) return structuredClone(override);
  if (!override || typeof override !== "object") return override ?? structuredClone(base);
  const result = structuredClone(base ?? {});
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(result[key], value)
      : structuredClone(value);
  }
  return result;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
}

function requireNumber(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < min
    || value > max
    || (integer && !Number.isInteger(value))
  ) throw new Error(`${label} 必须是范围内的${integer ? "整数" : "有限数值"}`);
}

function requireStringArray(value, label, { nonEmpty = true } = {}) {
  if (
    !Array.isArray(value)
    || (nonEmpty && value.length === 0)
    || value.some((item) => typeof item !== "string" || !item.trim())
    || new Set(value).size !== value.length
  ) throw new Error(`${label} 必须是${nonEmpty ? "非空、" : ""}无重复的字符串数组`);
}

function validateTypography(value, label) {
  requireObject(value, label);
  requireStringArray(value.allowedFonts, `${label}.allowedFonts`);
  requireObject(value.regularSubtitle, `${label}.regularSubtitle`);
  for (const field of ["font", "background", "outline"]) {
    requireString(value.regularSubtitle[field], `${label}.regularSubtitle.${field}`);
  }
  if (!value.allowedFonts.includes(value.regularSubtitle.font)) {
    throw new Error(`${label}.regularSubtitle.font 必须包含在 allowedFonts 中`);
  }
  requireNumber(value.regularSubtitle.shadowOpacity, `${label}.regularSubtitle.shadowOpacity`, { min: 0, max: 1 });
  for (const field of ["displayFont", "coverTitleFont"]) {
    requireString(value[field], `${label}.${field}`);
    if (!value.allowedFonts.includes(value[field])) throw new Error(`${label}.${field} 必须包含在 allowedFonts 中`);
  }
  requireBoolean(value.sequentialMultilineOnly, `${label}.sequentialMultilineOnly`);
}

function validateCover(value, label) {
  requireObject(value, label);
  if (!["cinematic_3d", "editorial_2d"].includes(value.mode)) {
    throw new Error(`${label}.mode 必须是 cinematic_3d 或 editorial_2d`);
  }
  requireBoolean(value.sceneSpecificPoseContractRequired, `${label}.sceneSpecificPoseContractRequired`);
  requireBoolean(value.poseReuseForbidden, `${label}.poseReuseForbidden`);
  requireStringArray(value.allowedGenerationInputModes, `${label}.allowedGenerationInputModes`);
  requireStringArray(value.requiredPoseFields, `${label}.requiredPoseFields`, { nonEmpty: value.mode === "cinematic_3d" });
  if (value.mode === "cinematic_3d") {
    for (const field of [
      "approved3dTurnaroundDefaultGenerationAnchor",
      "realPhotoGenerationInputForbiddenByDefault",
      "turnaroundPoseForbiddenForDisplay",
      "dualAnchorRequiresExplicitAuthorization",
    ]) requireBoolean(value[field], `${label}.${field}`);
    for (const field of ["defaultGenerationInputMode", "realPhotoPriority", "turnaroundPriority"]) {
      requireString(value[field], `${label}.${field}`);
    }
    if (!value.allowedGenerationInputModes.includes(value.defaultGenerationInputMode)) {
      throw new Error(`${label}.defaultGenerationInputMode 必须包含在 allowedGenerationInputModes 中`);
    }
  } else {
    requireBoolean(value.identityEvidenceRequired, `${label}.identityEvidenceRequired`);
  }
}

function validateFirstMinute(value, label) {
  requireObject(value, label);
  requireNumber(value.windowSeconds, `${label}.windowSeconds`, { min: 1 });
  for (const field of [
    "minimumMotivatedEffects",
    "minimumDistinctMechanisms",
    "minimumPeakAlignedSfx",
    "minimumHumanReactionWindows",
  ]) requireNumber(value[field], `${label}.${field}`, { min: 0, integer: true });
  requireNumber(value.maximumPrimaryEventsPer10Seconds, `${label}.maximumPrimaryEventsPer10Seconds`, {
    min: 1,
    max: 3,
    integer: true,
  });
  for (const field of [
    "minimumHumanPresenceRatio",
    "maximumFullScreenTakeoverRatio",
    "minimumBreathingRoomRatio",
  ]) requireNumber(value[field], `${label}.${field}`, { min: 0, max: 1 });
  for (const field of ["openingHookRequired", "audioVisualIntentMustMatch", "normalSpeedPreviewRequired"]) {
    requireBoolean(value[field], `${label}.${field}`);
  }
  if (value.minimumDistinctMechanisms > value.minimumMotivatedEffects) {
    throw new Error(`${label}.minimumDistinctMechanisms 不得超过 minimumMotivatedEffects`);
  }
  if (value.minimumPeakAlignedSfx > value.minimumMotivatedEffects) {
    throw new Error(`${label}.minimumPeakAlignedSfx 不得超过 minimumMotivatedEffects`);
  }
}

function loadCinematicPolicy(fileName, showId, label, rootDirectory = designSystemDirectory) {
  if (!SAFE_JSON_FILE.test(fileName)) throw new Error(`${label}.cinematicPolicyFile 必须是安全的 JSON 文件名`);
  const file = path.join(rootDirectory, fileName);
  if (!fs.existsSync(file)) throw new Error(`${label}.cinematicPolicyFile 不存在：${fileName}`);
  const source = readJson(file);
  if (source.schemaVersion !== "1.0") throw new Error(`${fileName}.schemaVersion 必须为 1.0`);
  for (const field of ["id", "version", "intent"]) requireString(source[field], `${fileName}.${field}`);
  for (const field of [
    "selectionOrder", "cinematicMechanisms", "sourceTypes", "containerTypes",
    "boundedSurfaceReasons", "forbiddenPatterns",
  ]) requireStringArray(source[field], `${fileName}.${field}`, { nonEmpty: field !== "forbiddenPatterns" });
  requireObject(source.globalRules, `${fileName}.globalRules`);
  for (const field of [
    "realPictureBeforeGraphicContainer",
    "boundarylessBeforeBounded",
    "noAdjacentBoundedSurfaces",
    "staticPeakFrameIsNotAcceptance",
  ]) requireBoolean(source.globalRules[field], `${fileName}.globalRules.${field}`);
  for (const [field, options] of [
    ["compositionCooldownSeconds", { min: 0 }],
    ["maximumSingleBoundedSurfaceSeconds", { min: 0.001 }],
    ["maximumRoundedContainerAreaRatio", { min: 0.001, max: 1 }],
    ["minimumCleanReturnSecondsAfterBoundedSurface", { min: 0 }],
    ["sameMechanismMaximumShare", { min: 0.001, max: 1 }],
  ]) requireNumber(source.globalRules[field], `${fileName}.globalRules.${field}`, options);
  requireObject(source.showBudgets, `${fileName}.showBudgets`);
  const budget = source.showBudgets[showId];
  requireObject(budget, `${fileName}.showBudgets.${showId}`);
  for (const field of ["minimumRealPictureRatio", "maximumBoundedSurfaceRatio", "maximumDashboardRatio"]) {
    requireNumber(budget[field], `${fileName}.showBudgets.${showId}.${field}`, { min: 0, max: 1 });
  }
  requireNumber(
    budget.minimumDistinctMechanismsPer120Seconds,
    `${fileName}.showBudgets.${showId}.minimumDistinctMechanismsPer120Seconds`,
    { min: 1, integer: true },
  );
  requireObject(source.styleGrammarMechanisms, `${fileName}.styleGrammarMechanisms`);
  const styleEntries = Object.entries(source.styleGrammarMechanisms);
  if (styleEntries.length === 0) throw new Error(`${fileName}.styleGrammarMechanisms 不得为空`);
  for (const [styleId, mechanisms] of styleEntries) {
    if (!SAFE_ID.test(styleId)) throw new Error(`${fileName}.styleGrammarMechanisms 包含非法 style id`);
    requireStringArray(mechanisms, `${fileName}.styleGrammarMechanisms.${styleId}`);
    if (mechanisms.some((mechanism) => !source.cinematicMechanisms.includes(mechanism))) {
      throw new Error(`${fileName}.styleGrammarMechanisms.${styleId} 包含未注册机制`);
    }
  }
  return {
    policyId: source.id,
    policyVersion: source.version,
    policySha256: sha256File(file),
    showId,
    selectionOrder: structuredClone(source.selectionOrder),
    cinematicMechanisms: structuredClone(source.cinematicMechanisms),
    sourceTypes: structuredClone(source.sourceTypes),
    containerTypes: structuredClone(source.containerTypes),
    boundedSurfaceReasons: structuredClone(source.boundedSurfaceReasons),
    forbiddenPatterns: structuredClone(source.forbiddenPatterns),
    globalRules: structuredClone(source.globalRules),
    budget: structuredClone(budget),
    styleGrammarMechanisms: structuredClone(source.styleGrammarMechanisms),
  };
}

export function loadProductionPack(packId = "xingzhe-dahui", showId = "tool-share", {
  packRoot = packsDirectory,
  designRoot = designSystemDirectory,
} = {}) {
  if (!SAFE_ID.test(packId) || !SAFE_ID.test(showId)) {
    throw new Error("production pack 与 show id 只能包含小写字母、数字和连字符");
  }
  const file = path.join(packRoot, `${packId}.json`);
  if (!fs.existsSync(file)) throw new Error(`production pack 不存在：${packId}`);
  const source = readJson(file);
  if (source.schemaVersion !== "1.0" || source.id !== packId) {
    throw new Error(`production pack ${packId} 的 schemaVersion 或 id 无效`);
  }
  requireObject(source.base, `${packId}.base`);
  requireObject(source.shows, `${packId}.shows`);
  requireString(source.version, `${packId}.version`);
  if (!source.shows[showId]) throw new Error(`production pack ${packId} 不支持栏目：${showId}`);
  requireObject(source.shows[showId], `${packId}.shows.${showId}`);
  const resolved = merge(source.base, source.shows[showId]);
  const label = `${packId}.${showId}`;
  requireString(resolved.editorialIntent, `${label}.editorialIntent`);
  validateTypography(resolved.typography, `${label}.typography`);
  validateCover(resolved.cover, `${label}.cover`);
  validateFirstMinute(resolved.firstMinute, `${label}.firstMinute`);
  requireString(resolved.cinematicPolicyFile, `${label}.cinematicPolicyFile`);
  const cinematicEditorial = loadCinematicPolicy(resolved.cinematicPolicyFile, showId, label, designRoot);
  return {
    id: source.id,
    version: source.version,
    showId,
    file,
    sha256: sha256File(file),
    supportedShows: Object.keys(source.shows),
    policies: resolved,
    cinematicEditorial,
  };
}

export function productionPacksDirectory() {
  return packsDirectory;
}
