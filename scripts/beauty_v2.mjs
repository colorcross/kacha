import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File, sha256Value } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const IMPLEMENTATION_FILES = [
  "generate_vision_masks.swift",
  "build_mask_video.mjs",
  "apply_beauty_v2.sh",
  "beauty_qc.mjs",
  "beauty_v2.mjs",
  "kacha_beauty.mjs",
  "assert_media_alignment.mjs",
];
export const beautyConfigFile = path.join(
  path.resolve(scriptDirectory, ".."),
  "config",
  "beauty-v2.json",
);
const EXPECTED_SCOPE = [
  "skin_smoothing",
  "whitening",
  "tone_evening",
  "nasolabial_softening",
];
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "engine",
  "defaultEnabled",
  "scope",
  "profiles",
  "hardLimits",
  "qc",
]);
const HARD_LIMIT_KEYS = new Set([
  "maximumBrightness",
  "maximumGamma",
  "maximumSmoothingSigmaR",
  "maximumTemporalMaskFrames",
  "forbidFaceGeometryChange",
  "forbidEyeOrNoseReshape",
  "forbidCloudProcessing",
]);
const QC_KEYS = new Set([
  "minimumPrimaryFaceCoverage",
  "minimumLandmarkCoverage",
  "maximumAmbiguousFrameRatio",
  "maximumTrackingJumpRatio",
  "requiredFrames",
  "requireSameFrameAB",
  "requireTemporalFlickerReview",
  "requireSkinNeckContinuityReview",
  "requireVideoStreamPreservationWhenDisabled",
]);
const ABSOLUTE_LIMITS = Object.freeze({
  maximumBrightness: 0.02,
  maximumGamma: 1.04,
  maximumSmoothingSigmaR: 0.08,
  maximumTemporalMaskFrames: 5,
});
const PROFILE_IDS = new Set(["natural", "visible"]);
const PROFILE_KEYS = new Set(["description", "skin", "nasolabial"]);
const SKIN_KEYS = new Set([
  "smoothingSigmaS",
  "smoothingSigmaR",
  "chromaSigmaS",
  "chromaSigmaR",
  "brightness",
  "gamma",
  "saturation",
  "detailAmount",
  "maskBlur",
  "maskTemporalFrames",
]);
const NASOLABIAL_KEYS = new Set([
  "smoothingSigmaS",
  "smoothingSigmaR",
  "brightness",
  "gamma",
  "maskBlur",
  "maskTemporalFrames",
]);

function rejectUnknownKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value ?? {})) {
    if (!allowed.has(key)) errors.push(`${label}.${key} 不受 Beauty v2 支持`);
  }
}

function finite(value, label, errors) {
  if (!Number.isFinite(Number(value))) errors.push(`${label} 必须是有限数字`);
}

function bounded(value, label, minimum, maximum, errors, { integer = false } = {}) {
  const actual = Number(value);
  if (
    !Number.isFinite(actual)
    || actual < minimum
    || actual > maximum
    || (integer && !Number.isInteger(actual))
  ) {
    errors.push(`${label} 必须是 ${minimum} 至 ${maximum} 的${integer ? "整数" : "数值"}`);
  }
}

function validateSkin(section, label, limits, errors) {
  rejectUnknownKeys(section, SKIN_KEYS, label, errors);
  bounded(section?.smoothingSigmaS, `${label}.smoothingSigmaS`, 0, 5, errors);
  bounded(
    section?.smoothingSigmaR,
    `${label}.smoothingSigmaR`,
    0,
    Math.min(limits.maximumSmoothingSigmaR, ABSOLUTE_LIMITS.maximumSmoothingSigmaR),
    errors,
  );
  bounded(section?.chromaSigmaS, `${label}.chromaSigmaS`, 0, 8, errors);
  bounded(section?.chromaSigmaR, `${label}.chromaSigmaR`, 0, 0.1, errors);
  bounded(
    section?.brightness,
    `${label}.brightness`,
    0,
    Math.min(limits.maximumBrightness, ABSOLUTE_LIMITS.maximumBrightness),
    errors,
  );
  bounded(
    section?.gamma,
    `${label}.gamma`,
    1,
    Math.min(limits.maximumGamma, ABSOLUTE_LIMITS.maximumGamma),
    errors,
  );
  bounded(section?.saturation, `${label}.saturation`, 0.98, 1.02, errors);
  bounded(section?.detailAmount, `${label}.detailAmount`, 0, 0.25, errors);
  bounded(section?.maskBlur, `${label}.maskBlur`, 0, 30, errors);
  bounded(
    section?.maskTemporalFrames,
    `${label}.maskTemporalFrames`,
    1,
    Math.min(
      limits.maximumTemporalMaskFrames,
      ABSOLUTE_LIMITS.maximumTemporalMaskFrames,
    ),
    errors,
    { integer: true },
  );
}

function validateNasolabial(section, label, limits, errors) {
  rejectUnknownKeys(section, NASOLABIAL_KEYS, label, errors);
  bounded(section?.smoothingSigmaS, `${label}.smoothingSigmaS`, 0, 5, errors);
  bounded(
    section?.smoothingSigmaR,
    `${label}.smoothingSigmaR`,
    0,
    Math.min(limits.maximumSmoothingSigmaR, ABSOLUTE_LIMITS.maximumSmoothingSigmaR),
    errors,
  );
  bounded(
    section?.brightness,
    `${label}.brightness`,
    0,
    Math.min(limits.maximumBrightness, ABSOLUTE_LIMITS.maximumBrightness),
    errors,
  );
  bounded(
    section?.gamma,
    `${label}.gamma`,
    1,
    Math.min(limits.maximumGamma, ABSOLUTE_LIMITS.maximumGamma),
    errors,
  );
  bounded(section?.maskBlur, `${label}.maskBlur`, 0, 30, errors);
  bounded(
    section?.maskTemporalFrames,
    `${label}.maskTemporalFrames`,
    1,
    Math.min(
      limits.maximumTemporalMaskFrames,
      ABSOLUTE_LIMITS.maximumTemporalMaskFrames,
    ),
    errors,
    { integer: true },
  );
}

export function validateBeautyV2(config) {
  const errors = [];
  rejectUnknownKeys(config, TOP_LEVEL_KEYS, "beauty-v2", errors);
  if (config?.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (config?.id !== "beauty-v2") errors.push("id 必须为 beauty-v2");
  if (config?.engine !== "apple-vision-plus-ffmpeg") {
    errors.push("engine 必须为 apple-vision-plus-ffmpeg");
  }
  if (config?.defaultEnabled !== false) errors.push("defaultEnabled 必须为 false");
  if (JSON.stringify(config?.scope) !== JSON.stringify(EXPECTED_SCOPE)) {
    errors.push(`scope 只能是 ${EXPECTED_SCOPE.join(", ")}`);
  }
  const limits = config?.hardLimits ?? {};
  rejectUnknownKeys(limits, HARD_LIMIT_KEYS, "hardLimits", errors);
  for (const [key, absoluteMaximum] of Object.entries(ABSOLUTE_LIMITS)) {
    bounded(limits[key], `hardLimits.${key}`, 0, absoluteMaximum, errors, {
      integer: key === "maximumTemporalMaskFrames",
    });
  }
  for (const flag of [
    "forbidFaceGeometryChange",
    "forbidEyeOrNoseReshape",
    "forbidCloudProcessing",
  ]) {
    if (limits[flag] !== true) errors.push(`hardLimits.${flag} 必须为 true`);
  }
  for (const [profileId, profile] of Object.entries(config?.profiles ?? {})) {
    if (!PROFILE_IDS.has(profileId)) {
      errors.push(`profiles.${profileId} 不受 Beauty v2 支持`);
    }
    rejectUnknownKeys(profile, PROFILE_KEYS, `profiles.${profileId}`, errors);
    if (typeof profile?.description !== "string" || !profile.description.trim()) {
      errors.push(`profiles.${profileId}.description 必须是非空字符串`);
    }
    for (const [key, value] of Object.entries(profile.skin ?? {})) {
      finite(value, `profiles.${profileId}.skin.${key}`, errors);
    }
    for (const [key, value] of Object.entries(profile.nasolabial ?? {})) {
      finite(value, `profiles.${profileId}.nasolabial.${key}`, errors);
    }
    validateSkin(profile.skin, `profiles.${profileId}.skin`, limits, errors);
    validateNasolabial(
      profile.nasolabial,
      `profiles.${profileId}.nasolabial`,
      limits,
      errors,
    );
  }
  for (const required of ["natural", "visible"]) {
    if (!config?.profiles?.[required]) errors.push(`缺少 profiles.${required}`);
  }
  rejectUnknownKeys(config?.qc, QC_KEYS, "qc", errors);
  bounded(
    config?.qc?.minimumPrimaryFaceCoverage,
    "qc.minimumPrimaryFaceCoverage",
    0.8,
    1,
    errors,
  );
  bounded(
    config?.qc?.minimumLandmarkCoverage,
    "qc.minimumLandmarkCoverage",
    0.8,
    1,
    errors,
  );
  bounded(
    config?.qc?.maximumAmbiguousFrameRatio,
    "qc.maximumAmbiguousFrameRatio",
    0,
    0.2,
    errors,
  );
  bounded(
    config?.qc?.maximumTrackingJumpRatio,
    "qc.maximumTrackingJumpRatio",
    0.01,
    0.5,
    errors,
  );
  if (
    !Array.isArray(config?.qc?.requiredFrames)
    || config.qc.requiredFrames.length < 6
  ) {
    errors.push("qc.requiredFrames 必须覆盖至少六类动态人脸场景");
  }
  for (const flag of [
    "requireSameFrameAB",
    "requireTemporalFlickerReview",
    "requireSkinNeckContinuityReview",
    "requireVideoStreamPreservationWhenDisabled",
  ]) {
    if (config?.qc?.[flag] !== true) errors.push(`qc.${flag} 必须为 true`);
  }
  return errors;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function tuningScale(value) {
  return 0.55 + (0.9 * Number(value) / 100);
}

function scaledDelta(value, neutral, scale, minimum, maximum) {
  return clamp(neutral + ((Number(value) - neutral) * scale), minimum, maximum);
}

export function resolveBeautyV2Parameters(config, profileId, tuning = null) {
  if (!PROFILE_IDS.has(profileId) || !config?.profiles?.[profileId]) {
    throw new Error(`Beauty v2 档位不存在：${profileId}`);
  }
  const resolved = JSON.parse(JSON.stringify(config.profiles[profileId]));
  if (tuning === null || tuning === undefined) {
    return {
      profileId,
      tuning: null,
      resolved,
      digest: sha256Value({ profileId, tuning: null, resolved }),
    };
  }
  const tuningErrors = [];
  rejectUnknownKeys(tuning, new Set([
    "smoothing",
    "whitening",
    "toneEvening",
    "nasolabialSoftening",
  ]), "tuning", tuningErrors);
  for (const key of [
    "smoothing",
    "whitening",
    "toneEvening",
    "nasolabialSoftening",
  ]) {
    bounded(tuning[key], `tuning.${key}`, 0, 100, tuningErrors);
  }
  if (tuningErrors.length > 0) throw new Error(tuningErrors.join("\n"));

  const smoothing = tuningScale(tuning.smoothing);
  const whitening = tuningScale(tuning.whitening);
  const tone = tuningScale(tuning.toneEvening);
  const nasolabial = tuningScale(tuning.nasolabialSoftening);
  const limits = config.hardLimits;
  const skin = resolved.skin;
  const fold = resolved.nasolabial;

  skin.smoothingSigmaS = clamp(skin.smoothingSigmaS * smoothing, 0, 5);
  skin.smoothingSigmaR = clamp(
    skin.smoothingSigmaR * smoothing,
    0,
    limits.maximumSmoothingSigmaR,
  );
  skin.detailAmount = clamp(skin.detailAmount / smoothing, 0, 0.25);
  skin.brightness = clamp(
    skin.brightness * whitening,
    0,
    limits.maximumBrightness,
  );
  skin.gamma = scaledDelta(
    skin.gamma,
    1,
    whitening,
    1,
    limits.maximumGamma,
  );
  skin.chromaSigmaS = clamp(skin.chromaSigmaS * tone, 0, 8);
  skin.chromaSigmaR = clamp(skin.chromaSigmaR * tone, 0, 0.1);
  skin.saturation = scaledDelta(skin.saturation, 1, tone, 0.98, 1.02);

  fold.smoothingSigmaS = clamp(fold.smoothingSigmaS * nasolabial, 0, 5);
  fold.smoothingSigmaR = clamp(
    fold.smoothingSigmaR * nasolabial,
    0,
    limits.maximumSmoothingSigmaR,
  );
  fold.brightness = clamp(
    fold.brightness * nasolabial,
    0,
    limits.maximumBrightness,
  );
  fold.gamma = scaledDelta(
    fold.gamma,
    1,
    nasolabial,
    1,
    limits.maximumGamma,
  );

  const validationErrors = [];
  validateSkin(skin, "resolved.skin", limits, validationErrors);
  validateNasolabial(fold, "resolved.nasolabial", limits, validationErrors);
  if (validationErrors.length > 0) throw new Error(validationErrors.join("\n"));
  const normalizedTuning = {
    smoothing: Number(tuning.smoothing),
    whitening: Number(tuning.whitening),
    toneEvening: Number(tuning.toneEvening),
    nasolabialSoftening: Number(tuning.nasolabialSoftening),
  };
  return {
    profileId,
    tuning: normalizedTuning,
    resolved,
    digest: sha256Value({ profileId, tuning: normalizedTuning, resolved }),
  };
}

export function loadBeautyV2(file = beautyConfigFile) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const errors = validateBeautyV2(config);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const implementationFiles = IMPLEMENTATION_FILES.map((name) => {
    const source = path.join(scriptDirectory, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`Beauty v2 实现文件缺失：${source}`);
    }
    return {
      name,
      source,
      sha256: sha256File(source),
    };
  });
  const implementation = {
    engine: config.engine,
    files: implementationFiles,
    digest: sha256Value(
      implementationFiles.map(({ name, sha256 }) => ({ name, sha256 })),
    ),
  };
  return { config, source: file, implementation };
}
