#!/usr/bin/env node

import path from "node:path";
import {
  asArray,
  hasValue,
  parseTimecode,
  readJson,
} from "./kacha_utils.mjs";

const CUT_REASONS = new Set(["information", "emotion", "perspective"]);
const EFFECT_FUNCTIONS = new Set([
  "information",
  "emotion",
  "perspective",
  "continuity",
  "attention",
  "safety",
]);
const SCALE_ALIASES = new Map([
  ["extreme_wide", "extreme_wide"],
  ["远景", "wide"],
  ["全景", "wide"],
  ["wide", "wide"],
  ["long", "wide"],
  ["中景", "medium"],
  ["medium", "medium"],
  ["近景", "close"],
  ["close", "close"],
  ["特写", "extreme_close"],
  ["大特写", "extreme_close"],
  ["extreme_close", "extreme_close"],
  ["detail", "extreme_close"],
  ["插入镜头", "insert"],
  ["insert", "insert"],
  ["图解", "graphic"],
  ["graphic", "graphic"],
  ["主观镜头", "pov"],
  ["pov", "pov"],
  ["不适用", "not_applicable"],
  ["not_applicable", "not_applicable"],
]);

function normalizeScale(value) {
  if (typeof value !== "string") return null;
  return SCALE_ALIASES.get(value.trim()) ?? null;
}

function techniqueIncludes(effect, terms) {
  const technique = typeof effect.technique === "string"
    ? effect.technique.toLowerCase()
    : "";
  return terms.some((term) => technique.includes(term.toLowerCase()));
}

function validActiveInterval(value) {
  return value !== null
    && typeof value === "object"
    && Number.isFinite(value.startSeconds)
    && Number.isFinite(value.endSeconds)
    && value.startSeconds >= 0
    && value.endSeconds > value.startSeconds;
}

function effectiveTime(item, fps, label, errors) {
  const fromSeconds = Number.isFinite(item.timeSeconds) ? item.timeSeconds : null;
  const fromTimecode = hasValue(item.timecode)
    ? parseTimecode(item.timecode, fps)
    : null;
  if (hasValue(item.timecode) && fromTimecode === null) {
    errors.push(`${label}: timecode 无效：${item.timecode}`);
  }
  if (fromSeconds === null && fromTimecode === null) {
    errors.push(`${label}: 缺少有效 timecode 或 timeSeconds`);
    return null;
  }
  if (
    fromSeconds !== null
    && fromTimecode !== null
    && Math.abs(fromSeconds - fromTimecode) > Math.max(0.002, 0.5 / fps)
  ) {
    errors.push(`${label}: timeSeconds 与 timecode 不一致`);
  }
  const value = fromSeconds ?? fromTimecode;
  if (!(value >= 0)) {
    errors.push(`${label}: 时间不得为负数`);
    return null;
  }
  return value;
}

function requireFields(object, fields, label, errors) {
  for (const field of fields) {
    if (!hasValue(object?.[field])) errors.push(`${label}: 缺少 ${field}`);
  }
}

function validateCuts(cuts, plan, errors) {
  const fps = Number(plan.timelineFPS);
  const duration = Number(plan.timelineDurationSeconds);
  let previousTime = -Infinity;

  cuts.forEach((cut, index) => {
    const label = `cuts[${index}]`;
    const before = normalizeScale(cut.shotScaleBefore);
    const after = normalizeScale(cut.shotScaleAfter);
    const reasons = asArray(cut.cutReason);
    const time = effectiveTime(cut, fps, label, errors);

    if (time !== null) {
      if (time <= previousTime) {
        errors.push(`${label}: 切点时间必须严格递增`);
      }
      if (Number.isFinite(duration) && time > duration) {
        errors.push(`${label}: 切点超过 timelineDurationSeconds`);
      }
      previousTime = time;
    }
    if (!before) errors.push(`${label}: shotScaleBefore 无效或缺失`);
    if (!after) errors.push(`${label}: shotScaleAfter 无效或缺失`);
    requireFields(
      cut,
      [
        "subjectBefore",
        "subjectAfter",
        "change",
        "anchor",
        "continuityTreatment",
        "failureCondition",
        "qcEvidence",
      ],
      label,
      errors,
    );

    const sameSubject = hasValue(cut.subjectBefore)
      && hasValue(cut.subjectAfter)
      && cut.subjectBefore === cut.subjectAfter;
    if (
      before
      && after
      && before === after
      && before !== "not_applicable"
      && sameSubject
    ) {
      errors.push(
        `${label}: 同一主体相邻镜头景别相同（${cut.shotScaleBefore} → ${cut.shotScaleAfter}）`,
      );
    }

    if (reasons.length === 0) {
      errors.push(`${label}: cutReason 至少包含 information、emotion、perspective 之一`);
    }
    for (const reason of reasons) {
      if (!CUT_REASONS.has(reason)) {
        errors.push(`${label}: 未知 cutReason：${reason}`);
      }
    }
    if (reasons.includes("perspective")) {
      requireFields(cut, ["perspectiveBefore", "perspectiveAfter"], label, errors);
      if (
        hasValue(cut.perspectiveBefore)
        && cut.perspectiveBefore === cut.perspectiveAfter
      ) {
        errors.push(`${label}: perspective 理由要求前后视角真实变化`);
      }
    }
    if (
      asArray(cut.qcEvidence).some((item) => /待补|todo|tbd/i.test(String(item)))
    ) {
      errors.push(`${label}: qcEvidence 不得使用待补占位`);
    }
  });
}

function validateEffects(effects, plan, errors) {
  const fps = Number(plan.timelineFPS);
  const duration = Number(plan.timelineDurationSeconds);
  let previousTime = -Infinity;

  effects.forEach((effect, index) => {
    const label = `effects[${index}]`;
    const functions = asArray(effect.function);
    const time = effectiveTime(effect, fps, label, errors);
    if (time !== null) {
      if (time < previousTime) {
        errors.push(`${label}: 效果时间不得逆序`);
      }
      if (Number.isFinite(duration) && time > duration) {
        errors.push(`${label}: 效果时间超过 timelineDurationSeconds`);
      }
      previousTime = time;
    }

    requireFields(
      effect,
      [
        "technique",
        "trigger",
        "mechanism",
        "beforeState",
        "afterState",
        "entryExit",
        "simplerAlternative",
        "failureCondition",
        "qcEvidence",
      ],
      label,
      errors,
    );
    if (functions.length === 0) {
      errors.push(
        `${label}: function 至少包含 information、emotion、perspective、continuity、attention、safety 之一`,
      );
    }
    for (const fn of functions) {
      if (!EFFECT_FUNCTIONS.has(fn)) {
        errors.push(`${label}: 未知 function：${fn}`);
      }
    }

    if (validActiveInterval(effect.activeInterval)) {
      if (
        Number.isFinite(duration)
        && effect.activeInterval.endSeconds > duration
      ) {
        errors.push(`${label}: activeInterval 超过时间线时长`);
      }
      if (
        time !== null
        && Math.abs(effect.activeInterval.startSeconds - time) > 1 / fps
      ) {
        errors.push(`${label}: time 与 activeInterval.startSeconds 不一致`);
      }
    }

    const isExternalInsert = techniqueIncludes(effect, [
      "插镜",
      "b-roll",
      "网络素材",
      "图库",
      "外部图片",
      "外部视频",
      "生成镜头",
      "ai video",
      "seedance",
      "minimax",
    ]);
    if (isExternalInsert) {
      requireFields(
        effect.assetSemantics,
        ["object", "action", "state", "role", "tense"],
        `${label}.assetSemantics`,
        errors,
      );
      if (!hasValue(effect.semanticMatchEvidence)) {
        errors.push(`${label}: 外部插镜缺少 semanticMatchEvidence`);
      }
      if (!validActiveInterval(effect.activeInterval)) {
        errors.push(`${label}: 外部插镜必须提供有效 activeInterval`);
      }
      if (!hasValue(effect.visualExit)) {
        errors.push(`${label}: 外部插镜必须提供 visualExit`);
      }
      const exitLead = Number(effect.exitLeadFrames);
      if (!Number.isInteger(exitLead) || exitLead < 1 || exitLead > 4) {
        errors.push(`${label}: 外部插镜 exitLeadFrames 必须为 1 至 4`);
      }
    }

    const isGeneratedInsert = techniqueIncludes(effect, [
      "生成镜头",
      "ai video",
      "seedance",
      "minimax",
    ]);
    if (isGeneratedInsert) {
      if (!hasValue(effect.generatedShotId)) {
        errors.push(`${label}: AI 生成镜头缺少 generatedShotId`);
      }
      requireFields(
        effect.continuityMatch,
        ["entrance", "exit", "motionDirection", "subjectAppearance"],
        `${label}.continuityMatch`,
        errors,
      );
    }

    const isPip = techniqueIncludes(effect, ["画中画", "picture-in-picture", "pip"]);
    if (isPip) {
      if (!validActiveInterval(effect.activeInterval)) {
        errors.push(`${label}: 画中画缺少有效 activeInterval`);
      }
      requireFields(
        effect,
        ["boundaryQC", "duplicateSourcePolicy", "occlusionCheck", "frameTreatment"],
        label,
        errors,
      );
    }

    const isTypewriter = techniqueIncludes(effect, ["打字", "typewriter"]);
    if (isTypewriter) {
      requireFields(
        effect,
        ["characterTiming", "soundAsset"],
        label,
        errors,
      );
      if (effect.characterTiming?.mode !== "per_character") {
        errors.push(`${label}: 打字效果必须逐字符出现`);
      }
      requireFields(
        effect.soundAsset,
        ["assetId", "title", "readySha256"],
        `${label}.soundAsset`,
        errors,
      );
    }

    const isSplitScreen = techniqueIncludes(effect, ["分屏", "split-screen", "split screen"]);
    if (isSplitScreen) {
      requireFields(effect, ["subjectSafeArea"], label, errors);
    }

    const isParallax = techniqueIncludes(effect, ["2.5d", "视差", "parallax"]);
    if (isParallax) {
      requireFields(
        effect,
        ["layerManifest", "alphaAndPtsPreflight", "representativePreview", "fallback"],
        label,
        errors,
      );
    }

    const isMask = techniqueIncludes(effect, [
      "蒙版",
      "mask",
      "人物后置文字",
      "隐私模糊",
      "局部提亮",
    ]);
    if (isMask) {
      requireFields(
        effect,
        ["maskSource", "maskAlignmentEvidence", "fallback"],
        label,
        errors,
      );
    }
  });
}

const args = process.argv.slice(2);
const input = args.find((argument) => !argument.startsWith("--"));
if (!input) {
  console.error("用法：validate_edit_plan.mjs <edit-plan.json>");
  process.exit(2);
}

const file = path.resolve(input);
let plan;
try {
  plan = readJson(file);
} catch (error) {
  console.error(`无法读取或解析 JSON：${file}`);
  console.error(error.message);
  process.exit(2);
}

const cuts = Array.isArray(plan.cuts)
  ? plan.cuts
  : Array.isArray(plan.cutSheet)
    ? plan.cutSheet
    : [];
const effects = Array.isArray(plan.effects)
  ? plan.effects
  : Array.isArray(plan.effectPlan)
    ? plan.effectPlan
    : [];
const errors = [];

if (plan.schemaVersion !== "2.0") {
  errors.push("schemaVersion 必须为 2.0");
}
if (!Number.isFinite(Number(plan.timelineFPS)) || Number(plan.timelineFPS) <= 0) {
  errors.push("timelineFPS 必须为正数");
}
if (
  !Number.isFinite(Number(plan.timelineDurationSeconds))
  || Number(plan.timelineDurationSeconds) <= 0
) {
  errors.push("timelineDurationSeconds 必须为正数");
}
if (!Array.isArray(plan.cuts) && !Array.isArray(plan.cutSheet)) {
  errors.push("顶层必须提供 cuts 或 cutSheet 数组；没有切点时显式写空数组");
}
if (!Array.isArray(plan.effects) && !Array.isArray(plan.effectPlan)) {
  errors.push("顶层必须提供 effects 或 effectPlan 数组；没有效果时显式写空数组");
}

validateCuts(cuts, plan, errors);
validateEffects(effects, plan, errors);

if (errors.length > 0) {
  console.error(`剪辑方案检查失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      file,
      schemaVersion: plan.schemaVersion,
      timelineFPS: Number(plan.timelineFPS),
      timelineDurationSeconds: Number(plan.timelineDurationSeconds),
      cuts: cuts.length,
      effects: effects.length,
      rules: {
        cutReasons: [...CUT_REASONS],
        sameScale: "forbidden only for the same subject",
        timecodeOrder: "validated",
        effectRationaleContract: "required",
        externalInsertSemanticContract: "conditional",
        maskAlignmentContract: "conditional",
        pipBoundaryContract: "conditional",
      },
    },
    null,
    2,
  ),
);
