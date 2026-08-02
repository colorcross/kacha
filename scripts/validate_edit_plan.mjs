#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  asArray,
  hasValue,
  parseTimecode,
  readJson,
  sha256File,
  sha256Value,
} from "./kacha_utils.mjs";
import { resolveDesignSystem } from "./design_system.mjs";

const CUT_REASONS = new Set(["information", "emotion", "perspective"]);
const EFFECT_FUNCTIONS = new Set([
  "information",
  "emotion",
  "perspective",
  "continuity",
  "attention",
  "safety",
]);
const TRANSITION_TYPES = new Set([
  "clean_cut",
  "action_cut",
  "eyeline_cut",
  "match_cut",
  "j_cut",
  "l_cut",
  "sound_bridge",
  "cutaway",
  "graphic_transition",
  "dissolve",
  "directional_transition",
  "whip_transition",
]);
const TRANSITION_BASES = new Set([
  "information",
  "action",
  "eyeline",
  "sound",
  "time",
  "space",
  "graphic",
  "emotion",
]);
const STYLIZED_TRANSITIONS = new Set([
  "graphic_transition",
  "dissolve",
  "directional_transition",
  "whip_transition",
]);
const HEAD_FRAMING = new Set([
  "clear",
  "intentional_extreme_close",
  "not_applicable",
]);
const INFORMATION_LAYOUT_MODES = new Set(["full_screen", "subject_safe"]);
const PROGRESSIVE_UPDATE_MODES = new Set(["local_highlight", "local_reveal"]);
const DESIGN_ARTIFACT_MODES = new Set(["local_styleframe", "figma"]);
const DESIGN_FONT_ROLES = [
  "display",
  "subtitlePrimary",
  "subtitleSecondary",
  "label",
  "body",
  "coverTitle",
];
let validationBaseDirectory = process.cwd();
const skillRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function resolveDesignArtifactRef(reference) {
  const value = String(reference ?? "");
  if (value.startsWith("kacha://")) {
    const relative = value.slice("kacha://".length);
    if (
      !relative
      || path.isAbsolute(relative)
      || relative.split(/[\\/]/).includes("..")
    ) {
      throw new Error(`无效的 kacha 设计资产引用：${value}`);
    }
    return path.join(skillRoot, relative);
  }
  return path.resolve(validationBaseDirectory, value);
}
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

function normalizedRect(value) {
  if (!value || typeof value !== "object") return null;
  const rect = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  };
  if (
    !Object.values(rect).every(Number.isFinite)
    || rect.x < 0
    || rect.y < 0
    || rect.width <= 0
    || rect.height <= 0
    || rect.x + rect.width > 1.000001
    || rect.y + rect.height > 1.000001
  ) {
    return null;
  }
  return rect;
}

function expandedRect(rect, margin) {
  return {
    x: Math.max(0, rect.x - margin),
    y: Math.max(0, rect.y - margin),
    width: Math.min(1, rect.x + rect.width + margin) - Math.max(0, rect.x - margin),
    height: Math.min(1, rect.y + rect.height + margin) - Math.max(0, rect.y - margin),
  };
}

function rectanglesOverlap(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function validateHeadFraming(cut, side, scale, label, errors) {
  const suffix = side === "before" ? "Before" : "After";
  const humanPresence = cut[`humanPresence${suffix}`];
  const framing = cut[`headFraming${suffix}`];
  const margin = Number(cut[`headTopMargin${suffix}`]);
  const sideLabel = `${label}.${side}`;

  if (typeof humanPresence !== "boolean") {
    errors.push(`${sideLabel}: humanPresence${suffix} 必须为布尔值`);
    return;
  }
  if (!HEAD_FRAMING.has(framing)) {
    errors.push(`${sideLabel}: headFraming${suffix} 无效或缺失`);
    return;
  }
  if (!humanPresence) {
    if (framing !== "not_applicable") {
      errors.push(`${sideLabel}: 无人物时 headFraming${suffix} 必须为 not_applicable`);
    }
    return;
  }
  if (framing === "not_applicable") {
    errors.push(`${sideLabel}: 有人物时不得跳过头部完整性检查`);
    return;
  }
  if (framing === "intentional_extreme_close") {
    if (scale !== "extreme_close") {
      errors.push(`${sideLabel}: 只有特写/大特写允许有意裁切头部`);
    }
    if (!hasValue(cut[`extremeCloseIntent${suffix}`])) {
      errors.push(`${sideLabel}: 有意裁切头部必须说明 extremeCloseIntent${suffix}`);
    }
    return;
  }
  if (!Number.isFinite(margin) || margin < 0.015 || margin > 0.5) {
    errors.push(
      `${sideLabel}: 普通人物镜头 headTopMargin${suffix} 必须为 0.015 至 0.5 的归一化余量`,
    );
  }
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

function validateDesignPreflight(value, label, errors) {
  if (!value || typeof value !== "object") {
    errors.push(`${label}: 缺少设计预检；必须先设计展示、动效和音效再实施`);
    return;
  }
  requireFields(
    value,
    [
      "designSystemId",
      "designSystemVersion",
      "designDigest",
      "sceneId",
      "componentIds",
      "modeSelection",
      "status",
      "artifactMode",
      "artifactRef",
      "artifactSha256",
      "implementationManifestRef",
      "implementationManifestSha256",
      "layoutSpec",
      "motionSpec",
      "soundSpec",
      "stateFrames",
      "implementationHandoff",
      "qcEvidence",
    ],
    label,
    errors,
  );
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(value.designSystemId ?? ""))) {
    errors.push(`${label}: designSystemId 格式无效`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(value.designSystemVersion ?? ""))) {
    errors.push(`${label}: designSystemVersion 必须使用 x.y.z`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.designDigest ?? ""))) {
    errors.push(`${label}: designDigest 必须是 64 位 SHA-256`);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(value.sceneId ?? ""))) {
    errors.push(`${label}: sceneId 格式无效`);
  }
  if (!Array.isArray(value.componentIds) || value.componentIds.length === 0) {
    errors.push(`${label}: componentIds 至少包含一个已注册组件`);
  } else if (
    value.componentIds.some(
      (id) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(id)),
    )
  ) {
    errors.push(`${label}: componentIds 包含格式无效的组件 id`);
  }
  const requiredModes = [
    "show",
    "aspectRatio",
    "language",
    "surface",
    "density",
  ];
  if (!value.modeSelection || typeof value.modeSelection !== "object") {
    errors.push(`${label}: modeSelection 必须记录五个设计模式`);
  } else {
    requireFields(value.modeSelection, requiredModes, `${label}.modeSelection`, errors);
  }
  let resolved = null;
  try {
    resolved = resolveDesignSystem({
      system: value.designSystemId,
      modes: value.modeSelection,
    });
  } catch (error) {
    errors.push(`${label}: 设计合同无法解析：${error.message}`);
  }
  if (resolved) {
    if (value.designSystemVersion !== resolved.system.version) {
      errors.push(
        `${label}: designSystemVersion 已失效；应为 ${resolved.system.version}`,
      );
    }
    if (value.designDigest !== resolved.digest) {
      errors.push(`${label}: designDigest 与当前系统、模式和风格不一致`);
    }
    const scene = resolved.scenes.find((item) => item.id === value.sceneId);
    if (!scene) {
      errors.push(`${label}: sceneId 未注册：${value.sceneId}`);
    }
    const componentIds = Array.isArray(value.componentIds) ? value.componentIds : [];
    for (const componentId of componentIds) {
      if (!resolved.components.some((item) => item.id === componentId)) {
        errors.push(`${label}: componentId 未注册：${componentId}`);
      } else if (scene && !scene.components.includes(componentId)) {
        errors.push(
          `${label}: componentId ${componentId} 不属于场景 ${scene.id}`,
        );
      }
    }
    const handoff = value.implementationHandoff;
    if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
      errors.push(`${label}.implementationHandoff 必须是 object`);
    } else {
      requireFields(
        handoff,
        ["resolvedFonts", "fontResolutionDigest", "tokenRefs"],
        `${label}.implementationHandoff`,
        errors,
      );
      if (handoff.fontResolutionDigest !== sha256Value(handoff.resolvedFonts)) {
        errors.push(
          `${label}.implementationHandoff.fontResolutionDigest `
          + "与 resolvedFonts 选择摘要不一致",
        );
      }
      if (
        !handoff.resolvedFonts
        || typeof handoff.resolvedFonts !== "object"
        || Array.isArray(handoff.resolvedFonts)
      ) {
        errors.push(`${label}.implementationHandoff.resolvedFonts 必须是 object`);
      } else {
        requireFields(
          handoff.resolvedFonts,
          DESIGN_FONT_ROLES,
          `${label}.implementationHandoff.resolvedFonts`,
          errors,
        );
        for (const role of Object.keys(handoff.resolvedFonts)) {
          if (!DESIGN_FONT_ROLES.includes(role)) {
            errors.push(
              `${label}.implementationHandoff.resolvedFonts 包含未知角色：${role}`,
            );
          }
        }
      }
      for (const [role, selectedFont] of Object.entries(
        handoff.resolvedFonts ?? {},
      )) {
        const candidates = resolved.style.typography?.[role]?.families ?? [];
        if (!candidates.includes(selectedFont)) {
          errors.push(
            `${label}.implementationHandoff.resolvedFonts.${role} `
            + `不在设计系统候选字体中：${selectedFont}`,
          );
        }
      }
      const declaredTokenRefs = new Set(asArray(handoff.tokenRefs));
      const requiredTokenRefs = new Set(
        componentIds.flatMap(
          (componentId) => resolved.components.find(
            (item) => item.id === componentId,
          )?.tokenRefs ?? [],
        ),
      );
      for (const tokenRef of requiredTokenRefs) {
        if (!declaredTokenRefs.has(tokenRef)) {
          errors.push(
            `${label}.implementationHandoff.tokenRefs 缺少 ${tokenRef}`,
          );
        }
      }
    }
  }
  if (value.status !== "approved_for_implementation") {
    errors.push(`${label}: status 必须为 approved_for_implementation`);
  }
  if (!DESIGN_ARTIFACT_MODES.has(value.artifactMode)) {
    errors.push(`${label}: artifactMode 必须为 local_styleframe 或 figma`);
  }
  if (!Array.isArray(value.stateFrames) || value.stateFrames.length < 3) {
    errors.push(`${label}: stateFrames 至少包含进入、信息最满/停稳和退出三种状态`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.artifactSha256 ?? ""))) {
    errors.push(`${label}: artifactSha256 必须是 64 位 SHA-256`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.implementationManifestSha256 ?? ""))) {
    errors.push(`${label}: implementationManifestSha256 必须是 64 位 SHA-256`);
  }
  if (value.artifactMode === "local_styleframe") {
    let artifact;
    let manifestFile;
    try {
      artifact = resolveDesignArtifactRef(value.artifactRef);
      manifestFile = resolveDesignArtifactRef(value.implementationManifestRef);
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      return;
    }
    if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
      errors.push(`${label}: 本地样式帧不存在：${artifact}`);
    } else if (sha256File(artifact) !== value.artifactSha256) {
      errors.push(`${label}: 本地样式帧 SHA-256 不一致`);
    }
    if (!fs.existsSync(manifestFile) || !fs.statSync(manifestFile).isFile()) {
      errors.push(`${label}: 实施清单不存在：${manifestFile}`);
    } else {
      if (sha256File(manifestFile) !== value.implementationManifestSha256) {
        errors.push(`${label}: 实施清单 SHA-256 不一致`);
      }
      try {
        const manifest = readJson(manifestFile);
        if (manifest.status !== "rendered") {
          errors.push(`${label}: 实施清单状态必须为 rendered`);
        }
        if (
          manifest.designDigest !== value.designDigest
          || manifest.sceneId !== value.sceneId
        ) {
          errors.push(`${label}: 实施清单与 designDigest/sceneId 不一致`);
        }
        if (
          manifest.rendererCodeSha256 !== resolved.rendererCodeSha256
          || manifest.implementationDigest !== resolved.implementationDigest
        ) {
          errors.push(`${label}: 实施清单代码摘要与当前实现不一致`);
        }
        const actualComponentIds = new Set(manifest.componentIds ?? []);
        for (const componentId of value.componentIds ?? []) {
          if (!actualComponentIds.has(componentId)) {
            errors.push(`${label}: 实施清单缺少组件 ${componentId}`);
          }
        }
        if (
          sha256Value(manifest.resolvedFonts ?? {})
          !== value.implementationHandoff?.fontResolutionDigest
        ) {
          errors.push(`${label}: 实施清单字体解析与 implementationHandoff 不一致`);
        }
      } catch (error) {
        errors.push(`${label}: 实施清单无法读取：${error.message}`);
      }
    }
  }
  if (value.artifactMode === "figma") {
    requireFields(
      value,
      ["figmaFileUrl", "figmaNodeIds", "exportEvidence"],
      label,
      errors,
    );
    if (!/^https:\/\/(?:www\.)?figma\.com\//i.test(String(value.figmaFileUrl ?? ""))) {
      errors.push(`${label}: figmaFileUrl 必须是有效的 figma.com 链接`);
    }
    if (!Array.isArray(value.figmaNodeIds) || value.figmaNodeIds.length === 0) {
      errors.push(`${label}: Figma 设计必须记录至少一个 node ID`);
    }
  }
}

function effectSoundAsset(effect) {
  return effect.soundDesign?.assetId
    ?? effect.soundAsset?.assetId
    ?? effect.sfxDesign?.assetId
    ?? null;
}

function validateSfxPlan(plan, effects, errors) {
  const soundEffects = effects
    .map((effect, index) => ({
      index,
      timeSeconds: Number(effect.timeSeconds),
      assetId: effectSoundAsset(effect),
    }))
    .filter((item) => hasValue(item.assetId));
  if (soundEffects.length === 0 && !hasValue(plan.sfxPlan)) return;

  const sfxPlan = plan.sfxPlan;
  const label = "sfxPlan";
  if (!sfxPlan || typeof sfxPlan !== "object") {
    errors.push(`${label}: 使用音效时必须提供整片音效计划`);
    return;
  }
  requireFields(
    sfxPlan,
    [
      "selectionPrinciple",
      "repetitionPolicy",
      "dialogueProtection",
      "palette",
      "events",
      "auditionEvidence",
    ],
    label,
    errors,
  );
  if (!Array.isArray(sfxPlan.palette) || sfxPlan.palette.length === 0) {
    errors.push(`${label}.palette: 必须提供至少一个候选音效`);
  }
  if (!Array.isArray(sfxPlan.events) || sfxPlan.events.length === 0) {
    errors.push(`${label}.events: 必须列出真实音效事件`);
    return;
  }

  const palette = Array.isArray(sfxPlan.palette) ? sfxPlan.palette : [];
  const paletteIds = new Set();
  palette.forEach((asset, index) => {
    requireFields(
      asset,
      ["assetId", "title", "category", "useFor"],
      `${label}.palette[${index}]`,
      errors,
    );
    if (hasValue(asset.assetId)) {
      if (paletteIds.has(asset.assetId)) {
        errors.push(`${label}.palette[${index}]: assetId 重复：${asset.assetId}`);
      }
      paletteIds.add(asset.assetId);
    }
  });

  const events = sfxPlan.events;
  const eventIds = [];
  const categories = new Set();
  let previousTime = -Infinity;
  let consecutiveAsset = null;
  let consecutiveCount = 0;
  events.forEach((event, index) => {
    const eventLabel = `${label}.events[${index}]`;
    requireFields(
      event,
      [
        "timeSeconds",
        "effectRef",
        "assetId",
        "title",
        "category",
        "purpose",
        "syncTarget",
        "levelRelativeToDialogueDb",
      ],
      eventLabel,
      errors,
    );
    const time = Number(event.timeSeconds);
    if (
      !Number.isFinite(time)
      || time < 0
      || time > Number(plan.timelineDurationSeconds)
    ) {
      errors.push(`${eventLabel}: timeSeconds 超出时间线`);
    } else if (time < previousTime) {
      errors.push(`${eventLabel}: 音效事件必须按时间排序`);
    }
    previousTime = Number.isFinite(time) ? time : previousTime;
    if (hasValue(event.assetId) && !paletteIds.has(event.assetId)) {
      errors.push(`${eventLabel}: assetId 未进入 sfxPlan.palette`);
    }
    const level = Number(event.levelRelativeToDialogueDb);
    if (!Number.isFinite(level) || level < -30 || level > 0) {
      errors.push(`${eventLabel}: 相对人声音量必须为 -30 dB 至 0 dB`);
    }
    if (hasValue(event.assetId)) eventIds.push(event.assetId);
    if (hasValue(event.category)) categories.add(event.category);

    if (event.assetId === consecutiveAsset) {
      consecutiveCount += 1;
    } else {
      consecutiveAsset = event.assetId;
      consecutiveCount = 1;
    }
    if (consecutiveCount > 2 && !hasValue(event.patternException)) {
      errors.push(`${eventLabel}: 同一音效不得连续使用超过两次，重复节奏必须说明 patternException`);
    }
  });

  soundEffects.forEach((soundEffect) => {
    const matched = events.some((event) => (
      event.assetId === soundEffect.assetId
      && (
        !Number.isFinite(soundEffect.timeSeconds)
        || Math.abs(Number(event.timeSeconds) - soundEffect.timeSeconds)
          <= Math.max(0.002, 1 / Number(plan.timelineFPS))
      )
    ));
    if (!matched) {
      errors.push(
        `effects[${soundEffect.index}]: sound asset ${soundEffect.assetId} 未映射到 sfxPlan.events`,
      );
    }
  });

  if (events.length >= 4) {
    const uniqueAssets = new Set(eventIds);
    if (uniqueAssets.size < 3) {
      errors.push(`${label}: 4 个及以上音效事件至少使用 3 个真正不同的音效`);
    }
    const counts = new Map();
    for (const assetId of eventIds) {
      counts.set(assetId, (counts.get(assetId) ?? 0) + 1);
    }
    const maxShare = Math.max(...counts.values()) / eventIds.length;
    if (maxShare > 0.5) {
      errors.push(`${label}: 单个音效不得占整片音效事件的 50% 以上`);
    }
    if (categories.size < 2) {
      errors.push(`${label}: 4 个及以上音效事件至少覆盖 2 种声音功能`);
    }
  }
  if (events.length >= 7 && categories.size < 3) {
    errors.push(`${label}: 7 个及以上音效事件至少覆盖 3 种声音功能`);
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
        "transitionDecision",
        "failureCondition",
        "qcEvidence",
      ],
      label,
      errors,
    );
    validateHeadFraming(cut, "before", before, label, errors);
    validateHeadFraming(cut, "after", after, label, errors);

    const transition = cut.transitionDecision;
    if (transition && typeof transition === "object") {
      requireFields(
        transition,
        ["type", "motivation", "continuityBasis", "visualTreatment", "audioTreatment", "fallback", "previewEvidence"],
        `${label}.transitionDecision`,
        errors,
      );
      if (!TRANSITION_TYPES.has(transition.type)) {
        errors.push(`${label}.transitionDecision: 未知切镜/转场类型：${transition.type}`);
      }
      if (!TRANSITION_BASES.has(transition.continuityBasis)) {
        errors.push(
          `${label}.transitionDecision: continuityBasis 必须来自信息、动作、视线、声音、时间、空间、图形或情绪连续性`,
        );
      }
      if (STYLIZED_TRANSITIONS.has(transition.type)) {
        for (const field of ["handleFramesBefore", "handleFramesAfter"]) {
          const frames = Number(transition[field]);
          if (!Number.isInteger(frames) || frames < 3) {
            errors.push(
              `${label}.transitionDecision: 风格化转场 ${field} 必须至少保留 3 帧真实 handle`,
            );
          }
        }
        validateDesignPreflight(
          transition.designPreflight,
          `${label}.transitionDecision.designPreflight`,
          errors,
        );
      }
      if (
        ["directional_transition", "whip_transition"].includes(transition.type)
        && !hasValue(transition.motionDirection)
      ) {
        errors.push(`${label}.transitionDecision: 方向型转场必须声明 motionDirection`);
      }
    }

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

function validateConnectionAudit(cuts, plan, errors) {
  if (cuts.length === 0) return;
  const audit = plan.connectionAudit;
  if (!audit || typeof audit !== "object") {
    errors.push("connectionAudit: 有切点时必须提供完整连接点审计");
    return;
  }
  requireFields(
    audit,
    [
      "detectionMethod",
      "detectedJoinCount",
      "auditedJoinCount",
      "joinIds",
      "normalSpeedEvidence",
    ],
    "connectionAudit",
    errors,
  );
  const detected = Number(audit.detectedJoinCount);
  const audited = Number(audit.auditedJoinCount);
  const joinIds = asArray(audit.joinIds);
  if (!Number.isInteger(detected) || detected !== cuts.length) {
    errors.push("connectionAudit.detectedJoinCount 必须等于 cuts/cutSheet 的真实连接点数量");
  }
  if (!Number.isInteger(audited) || audited !== detected) {
    errors.push("connectionAudit.auditedJoinCount 必须覆盖全部检测到的连接点");
  }
  if (joinIds.length !== cuts.length || new Set(joinIds).size !== joinIds.length) {
    errors.push("connectionAudit.joinIds 必须唯一并逐项覆盖 cuts/cutSheet");
  }
  if (!Array.isArray(audit.unresolvedJoinIds)) {
    errors.push("connectionAudit.unresolvedJoinIds 必须显式提供数组");
  } else if (audit.unresolvedJoinIds.length > 0) {
    errors.push("connectionAudit.unresolvedJoinIds 必须为空；未解决连接点不得进入渲染");
  }
  if (!Array.isArray(audit.normalSpeedEvidence) || audit.normalSpeedEvidence.length === 0) {
    errors.push("connectionAudit.normalSpeedEvidence 必须提供正常速度试听/观看证据");
  }
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
        [
          "boundaryQC",
          "duplicateSourcePolicy",
          "occlusionCheck",
          "frameTreatment",
          "pipContentSpec",
          "pipBorderSpec",
        ],
        label,
        errors,
      );
      const content = effect.pipContentSpec;
      if (content && typeof content === "object") {
        requireFields(
          content,
          [
            "sourceComposition",
            "fitMode",
            "subjectAnchor",
            "headTopMarginRatio",
            "gestureVisibilityPolicy",
            "stateFrames",
          ],
          `${label}.pipContentSpec`,
          errors,
        );
        if (content.sourceComposition !== "full_frame_fit") {
          errors.push(`${label}.pipContentSpec.sourceComposition 默认必须为 full_frame_fit`);
        }
        if (content.fitMode !== "contain") {
          errors.push(`${label}.pipContentSpec.fitMode 默认必须为 contain`);
        }
        const anchorX = Number(content.subjectAnchor?.x);
        const anchorY = Number(content.subjectAnchor?.y);
        if (
          !Number.isFinite(anchorX)
          || !Number.isFinite(anchorY)
          || anchorX < 0
          || anchorX > 1
          || anchorY < 0
          || anchorY > 1
        ) {
          errors.push(`${label}.pipContentSpec.subjectAnchor 必须是 0 至 1 的归一化坐标`);
        }
        const headTopMarginRatio = Number(content.headTopMarginRatio);
        if (!Number.isFinite(headTopMarginRatio) || headTopMarginRatio < 0.04) {
          errors.push(`${label}.pipContentSpec.headTopMarginRatio 不得小于 0.04`);
        }
        if (!Array.isArray(content.stateFrames) || content.stateFrames.length < 3) {
          errors.push(`${label}.pipContentSpec.stateFrames 至少包含进入、停稳和退出`);
        }
      }
      const border = effect.pipBorderSpec;
      if (border && typeof border === "object") {
        requireFields(
          border,
          [
            "shape",
            "strokes",
            "cornerRadius",
            "shadow",
            "boundsIncluded",
            "stateFrames",
            "collisionEvidence",
            "rationale",
          ],
          `${label}.pipBorderSpec`,
          errors,
        );
        const strokes = asArray(border.strokes);
        if (strokes.length < 1 || strokes.length > 2) {
          errors.push(`${label}.pipBorderSpec: strokes 必须为 1 至 2 层`);
        }
        strokes.forEach((stroke, strokeIndex) => {
          const widthRatio = Number(stroke?.widthRatio);
          if (!hasValue(stroke?.color) || !Number.isFinite(widthRatio)
            || widthRatio < 0.004 || widthRatio > 0.012) {
            errors.push(
              `${label}.pipBorderSpec.strokes[${strokeIndex}]: 必须提供颜色，widthRatio 必须为 0.004 至 0.012`,
            );
          }
        });
        const shadowOpacity = Number(border.shadow?.opacity);
        if (!Number.isFinite(shadowOpacity) || shadowOpacity < 0.2 || shadowOpacity > 0.35) {
          errors.push(`${label}.pipBorderSpec.shadow.opacity 必须为 0.20 至 0.35`);
        }
        if (border.boundsIncluded !== true) {
          errors.push(`${label}.pipBorderSpec.boundsIncluded 必须为 true`);
        }
        if (!Array.isArray(border.stateFrames) || border.stateFrames.length < 3) {
          errors.push(`${label}.pipBorderSpec.stateFrames 至少包含进入、停稳和退出`);
        }
        if (!Array.isArray(border.collisionEvidence) || border.collisionEvidence.length === 0) {
          errors.push(`${label}.pipBorderSpec.collisionEvidence 不得为空`);
        }
      }
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

    const isExplicitSoundEffect = techniqueIncludes(effect, [
      "音效",
      "sfx",
      "tonal hit",
      "whoosh",
      "tick",
      "impact",
    ]);
    if (isExplicitSoundEffect) {
      const sound = effect.soundDesign ?? effect.soundAsset ?? effect.sfxDesign;
      requireFields(
        sound,
        ["assetId", "title", "readySha256"],
        `${label}.soundDesign`,
        errors,
      );
    }

    const isSplitScreen = techniqueIncludes(effect, ["分屏", "split-screen", "split screen"]);
    if (isSplitScreen) {
      requireFields(effect, ["subjectSafeArea", "paneCompositionSpecs"], label, errors);
      const panes = asArray(effect.paneCompositionSpecs);
      if (panes.length < 2) {
        errors.push(`${label}.paneCompositionSpecs 至少包含两个窗格`);
      }
      panes.forEach((pane, paneIndex) => {
        requireFields(
          pane,
          [
            "sourceComposition",
            "fitMode",
            "subjectAnchor",
            "verticalSubjectPosition",
            "headTopMarginRatio",
            "gestureVisibilityPolicy",
            "stateFrames",
          ],
          `${label}.paneCompositionSpecs[${paneIndex}]`,
          errors,
        );
        if (pane?.sourceComposition !== "subject_aware_reframe") {
          errors.push(`${label}.paneCompositionSpecs[${paneIndex}].sourceComposition 必须为 subject_aware_reframe`);
        }
        if (!["contain", "subject_aware_crop"].includes(pane?.fitMode)) {
          errors.push(`${label}.paneCompositionSpecs[${paneIndex}].fitMode 必须为 contain 或 subject_aware_crop`);
        }
        const x = Number(pane?.subjectAnchor?.x);
        const y = Number(pane?.subjectAnchor?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
          errors.push(`${label}.paneCompositionSpecs[${paneIndex}].subjectAnchor 必须是归一化坐标`);
        }
        const vertical = Number(pane?.verticalSubjectPosition);
        if (!Number.isFinite(vertical) || vertical < 0.45 || vertical > 0.55) {
          errors.push(`${label}.paneCompositionSpecs[${paneIndex}].verticalSubjectPosition 必须为 0.45 至 0.55`);
        }
        const margin = Number(pane?.headTopMarginRatio);
        if (!Number.isFinite(margin) || margin < 0.04) {
          errors.push(`${label}.paneCompositionSpecs[${paneIndex}].headTopMarginRatio 不得小于 0.04`);
        }
        if (!Array.isArray(pane?.stateFrames) || pane.stateFrames.length < 3) {
          errors.push(`${label}.paneCompositionSpecs[${paneIndex}].stateFrames 至少包含进入、停稳和退出`);
        }
      });
    }

    const isInformationModule = techniqueIncludes(effect, [
      "信息卡",
      "information card",
      "info card",
      "流程图",
      "flowchart",
      "弹窗",
      "popup",
      "modal",
    ]);
    if (isInformationModule) {
      requireFields(effect, ["layoutMode", "layoutEvidence"], label, errors);
      if (!INFORMATION_LAYOUT_MODES.has(effect.layoutMode)) {
        errors.push(`${label}: 信息卡/流程图/弹窗 layoutMode 必须为 full_screen 或 subject_safe`);
      } else if (effect.layoutMode === "full_screen") {
        if (effect.subjectVisibilityPolicy !== "replace_a_roll") {
          errors.push(`${label}: 全屏信息模块必须替换 A-roll，不得半透明覆盖人物头像`);
        }
        const coverage = Number(effect.fullScreenCoverage);
        if (!Number.isFinite(coverage) || coverage < 0.95 || coverage > 1) {
          errors.push(`${label}: 全屏信息模块 fullScreenCoverage 必须为 0.95 至 1`);
        }
      } else {
        const moduleBounds = normalizedRect(effect.moduleBounds);
        const headBounds = asArray(effect.subjectHeadBounds);
        const margin = Number(effect.headSafetyMargin);
        if (!moduleBounds) {
          errors.push(`${label}: subject_safe 信息模块必须提供有效 moduleBounds`);
        }
        if (
          !Number.isFinite(margin)
          || margin < 0.01
          || margin > 0.15
        ) {
          errors.push(`${label}: headSafetyMargin 必须为 0.01 至 0.15`);
        }
        if (headBounds.length === 0) {
          errors.push(`${label}: subject_safe 信息模块必须提供 subjectHeadBounds`);
        }
        headBounds.forEach((value, headIndex) => {
          const head = normalizedRect(value);
          if (!head) {
            errors.push(`${label}.subjectHeadBounds[${headIndex}]: 必须是有效归一化矩形`);
          } else if (
            moduleBounds
            && Number.isFinite(margin)
            && rectanglesOverlap(moduleBounds, expandedRect(head, margin))
          ) {
            errors.push(`${label}: 信息模块与人物头像安全区发生遮盖`);
          }
        });
      }

      const isProgressiveModule = techniqueIncludes(effect, [
        "流程图",
        "flowchart",
        "workflow",
        "逐项点亮",
        "音频清理",
        "audio cleanup",
      ]);
      if (isProgressiveModule) {
        const progressive = effect.progressiveStateSpec;
        requireFields(
          progressive,
          [
            "persistentBase",
            "updateMode",
            "activeRegionBounds",
            "screenFlashPolicy",
            "stateBoundaryQC",
          ],
          `${label}.progressiveStateSpec`,
          errors,
        );
        if (progressive?.persistentBase !== true) {
          errors.push(`${label}.progressiveStateSpec: persistentBase 必须为 true`);
        }
        if (!PROGRESSIVE_UPDATE_MODES.has(progressive?.updateMode)) {
          errors.push(`${label}.progressiveStateSpec: updateMode 必须为 local_highlight 或 local_reveal`);
        }
        if (progressive?.screenFlashPolicy !== "forbid_full_frame_fade") {
          errors.push(`${label}.progressiveStateSpec: 必须禁止节点切换时整屏淡入淡出`);
        }
        const regions = asArray(progressive?.activeRegionBounds);
        if (regions.length === 0) {
          errors.push(`${label}.progressiveStateSpec: activeRegionBounds 不得为空`);
        }
        regions.forEach((region, regionIndex) => {
          const rect = normalizedRect(region);
          if (!rect || rect.width * rect.height >= 0.9) {
            errors.push(
              `${label}.progressiveStateSpec.activeRegionBounds[${regionIndex}]: 必须是小于全屏 90% 的有效局部区域`,
            );
          }
        });
        if (!Array.isArray(progressive?.stateBoundaryQC)
          || progressive.stateBoundaryQC.length === 0) {
          errors.push(`${label}.progressiveStateSpec: stateBoundaryQC 不得为空`);
        }
      }
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

    const isTextBehindPerson = techniqueIncludes(effect, [
      "人物后置文字",
      "人物后文字",
      "文字从人物背后",
      "text behind person",
    ]);
    if (isTextBehindPerson) {
      requireFields(
        effect,
        ["textDesign", "soundDesign", "layoutEvidence"],
        label,
        errors,
      );
      requireFields(
        effect.textDesign,
        [
          "content",
          "fontFamily",
          "fontWeight",
          "fontLicense",
          "fontSizeRatioToSubtitle",
          "positionRationale",
          "textBounds",
          "subtitleBounds",
          "color",
          "backgroundContrastRatio",
          "visibleAreaRatio",
          "phraseGrouping",
        ],
        `${label}.textDesign`,
        errors,
      );
      const textBounds = normalizedRect(effect.textDesign?.textBounds);
      const subtitleBounds = normalizedRect(effect.textDesign?.subtitleBounds);
      if (!textBounds) {
        errors.push(`${label}.textDesign: textBounds 必须是有效归一化矩形`);
      }
      if (!subtitleBounds) {
        errors.push(`${label}.textDesign: subtitleBounds 必须是有效归一化矩形`);
      }
      if (textBounds && subtitleBounds && rectanglesOverlap(textBounds, subtitleBounds)) {
        errors.push(`${label}.textDesign: 人物后文字不得侵占字幕安全区`);
      }
      const fontWeight = Number(effect.textDesign?.fontWeight);
      if (!Number.isFinite(fontWeight) || fontWeight < 600 || fontWeight > 800) {
        errors.push(`${label}.textDesign: 展示字体 fontWeight 必须为 600 至 800`);
      }
      const sizeRatio = Number(effect.textDesign?.fontSizeRatioToSubtitle);
      if (!Number.isFinite(sizeRatio) || sizeRatio < 1.35 || sizeRatio > 3) {
        errors.push(`${label}.textDesign: 字号必须为普通字幕的 1.35 至 3 倍`);
      }
      if (!/^#[0-9a-f]{6}$/i.test(String(effect.textDesign?.color ?? ""))) {
        errors.push(`${label}.textDesign: color 必须是六位十六进制颜色`);
      }
      const contrast = Number(effect.textDesign?.backgroundContrastRatio);
      if (!Number.isFinite(contrast) || contrast < 4.5) {
        errors.push(`${label}.textDesign: 可见区域背景对比度必须至少为 4.5:1`);
      }
      const visibleArea = Number(effect.textDesign?.visibleAreaRatio);
      if (!Number.isFinite(visibleArea) || visibleArea < 0.65 || visibleArea > 1) {
        errors.push(`${label}.textDesign: 文字可见面积比例必须为 0.65 至 1`);
      }
      if (!Array.isArray(effect.textDesign?.phraseGrouping)
        || effect.textDesign.phraseGrouping.length === 0) {
        errors.push(`${label}.textDesign: phraseGrouping 必须按语义提供至少一个短语`);
      }
      requireFields(
        effect.soundDesign,
        [
          "assetId",
          "title",
          "readySha256",
          "entryCue",
          "motionMatch",
          "syncToleranceFrames",
          "levelRelativeToDialogueDb",
        ],
        `${label}.soundDesign`,
        errors,
      );
      const syncTolerance = Number(effect.soundDesign?.syncToleranceFrames);
      if (!Number.isInteger(syncTolerance) || syncTolerance < 0 || syncTolerance > 2) {
        errors.push(`${label}.soundDesign: 音效与文字落位误差必须在 0 至 2 帧`);
      }
      const sfxLevel = Number(effect.soundDesign?.levelRelativeToDialogueDb);
      if (!Number.isFinite(sfxLevel) || sfxLevel < -18 || sfxLevel > -3) {
        errors.push(`${label}.soundDesign: 音效相对人声电平应位于 -18 dB 至 -3 dB`);
      }
    }

    const isDesignedTransition = techniqueIncludes(effect, [
      "转场",
      "transition",
      "dissolve",
      "wipe",
      "whip",
    ]);
    if (isInformationModule || isMask || isTextBehindPerson || isDesignedTransition) {
      validateDesignPreflight(
        effect.designPreflight,
        `${label}.designPreflight`,
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
validationBaseDirectory = path.dirname(file);
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
validateConnectionAudit(cuts, plan, errors);
validateEffects(effects, plan, errors);
validateSfxPlan(plan, effects, errors);

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
        headIntegrity: "required for every human shot except intentional extreme close-ups",
        transitionDecision: "required and continuity-motivated",
        connectionAudit: "every detected join must be listed, treated and reviewed at normal speed",
        timecodeOrder: "validated",
        effectRationaleContract: "required",
        externalInsertSemanticContract: "conditional",
        maskAlignmentContract: "conditional",
        pipBoundaryContract: "full-frame fit, active interval, duplicate-source policy, designed border and collision evidence required",
        splitScreenComposition: "each pane requires subject-aware centering and complete head visibility",
        informationModuleLayout: "full-screen replacement or verified subject-head avoidance",
        progressiveStateUpdates: "persistent base with local highlight/reveal; full-frame state flashing forbidden",
        textBehindDesign: "font, scale, bounds, contrast, visibility and SFX sync required",
        visualDesignPreflight: "required before implementation for information modules, stylized transitions and masks",
        sfxDiversity: "whole-timeline palette, event mapping and repetition audit required",
      },
    },
    null,
    2,
  ),
);
