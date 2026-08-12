#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasValue,
  readJson,
  resolveFrom,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { alignSfxPeak } from "./sfx_peak_alignment.mjs";

const STAGES = new Set(["plan", "execution", "release"]);
const JOIN_TYPES = new Set([
  "clean_cut",
  "j_cut",
  "l_cut",
  "action_cut",
  "match_cut",
  "sound_bridge",
  "cutaway",
  "transition",
  "pip_bridge",
  "broll_bridge",
]);
const RELATIONS = new Set(["contrast", "cause", "hierarchy", "progression"]);
const ALLOWED_FONTS = ["细体", "金陵体", "华光标题黑", "封神榜书"];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const antiWebPolicyFile = path.resolve(
  scriptDirectory,
  "..",
  "config",
  "design-system",
  "anti-web.json",
);
const BOUNDED_CONTAINER_TYPES = new Set([
  "source_plate",
  "comparison_surface",
  "progressive_list_surface",
  "card",
  "popup",
  "grid",
  "dashboard",
]);

function antiWebPolicy() {
  return readJson(antiWebPolicyFile);
}

function usage() {
  console.error(
    "用法：\n"
      + "  production_quality_contract.mjs template --project-id ID --output FILE\n"
      + "  production_quality_contract.mjs validate --contract FILE --stage plan|execution|release\n"
      + "  production_quality_contract.mjs anti-web-audit --contract FILE [--write]",
  );
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function template(projectId) {
  const cinematic = antiWebPolicy();
  return {
    schemaVersion: "1.0",
    kind: "kacha-production-quality-contract",
    projectId,
    policies: {
      semanticEdit: {
        fragmentPolicy: "keep_or_remove_complete_unit",
        pausePolicy: "remove_unintentional_preserve_intentional",
        wordTimedEvidenceRequired: true,
      },
      connections: {
        enumerateEveryFinalJoin: true,
        motivatedDecisionRequired: true,
        wrongCutMustBeReedited: true,
      },
      opening: {
        exactlyOnePrimaryEffect: true,
        firstVisibleChangeBySeconds: 0.5,
        promiseBySeconds: 3,
        frameZeroFullCoverForClosedReveal: true,
        partialSubjectApertureForbidden: true,
      },
      effects: {
        semanticTriggerRequired: true,
        maxConcurrentPrimary: 1,
        progressiveLists: true,
        individualSfxPerItem: true,
        behindSubjectDefaultChineseCharacters: 4,
        behindSubjectMaxChineseCharacters: 7,
      },
      typography: {
        allowedFonts: ALLOWED_FONTS,
        regularSubtitle: {
          font: "金陵体",
          background: "none",
          outline: "none",
          shadowOpacity: 0.6,
        },
        displayFont: "华光标题黑",
        coverTitleFont: "封神榜书",
        sequentialMultilineOnly: true,
      },
      overlays: {
        threeStateCollisionCheck: true,
        protectFaceHeadSubtitlesAndPlatformUi: true,
        pipInformationDifferenceRequired: true,
        maxCardBorderPxAt4k: 4,
      },
      externalAssets: {
        semanticFiveTupleRequired: true,
        provenanceRequired: true,
        illustrativeLabel: "情境示意",
      },
      audio: {
        adaptiveBgmRequired: true,
        rhythmEmotionContentAnalysisRequired: true,
        professionalPromptFields: [
          "instrumentation", "style", "tempo", "timbre", "harmony", "lowFrequency", "highFrequency",
        ],
        stemsRequired: ["dialogue", "bgm", "sfx", "mix"],
        minimumCoverageRatio: 0.95,
        sfxWaveformPeakEvidenceRequired: true,
        sfxAutoPeakAlignmentRequired: true,
        semanticLandingIsTimelineAuthority: true,
        sfxPeakToleranceFrames: 1,
      },
      cover: {
        approved3dTurnaroundDefaultGenerationAnchor: true,
        defaultGenerationInputMode: "turnaround_only_real_photo_qc",
        realPhotoGenerationInputForbiddenByDefault: true,
        realPhotoPriority: "post_generation_identity_qc_only",
        turnaroundPriority: "generation_identity_body_clothing_continuity",
        turnaroundPoseForbiddenForDisplay: true,
        sceneSpecificPoseContractRequired: true,
        poseReuseForbidden: true,
        allowedGenerationInputModes: ["dual_anchor", "turnaround_only_real_photo_qc"],
        dualAnchorRequiresExplicitAuthorization: true,
        requiredPoseFields: [
          "sceneSignal", "narrativeIntent", "bodyAction", "gaze", "expression",
          "propInteraction", "weightShift", "clothingAdaptation", "clothingContinuity",
        ],
      },
      firstMinute: {
        windowSeconds: 60,
        minimumMotivatedEffects: 5,
        minimumDistinctMechanisms: 4,
        minimumPeakAlignedSfx: 3,
        maximumPrimaryEventsPer10Seconds: 3,
        minimumHumanPresenceRatio: 0.55,
        maximumFullScreenTakeoverRatio: 0.35,
        minimumBreathingRoomRatio: 0.2,
        openingHookRequired: true,
        audioVisualIntentMustMatch: true,
        normalSpeedPreviewRequired: true,
      },
      cinematicEditorial: {
        policyId: cinematic.id,
        policyVersion: cinematic.version,
        policySha256: sha256File(antiWebPolicyFile),
        selectionOrder: cinematic.selectionOrder,
        cinematicMechanisms: cinematic.cinematicMechanisms,
        sourceTypes: cinematic.sourceTypes,
        containerTypes: cinematic.containerTypes,
        boundedSurfaceReasons: cinematic.boundedSurfaceReasons,
        forbiddenPatterns: cinematic.forbiddenPatterns,
        globalRules: cinematic.globalRules,
        showBudgets: cinematic.showBudgets,
        styleGrammarMechanisms: cinematic.styleGrammarMechanisms,
      },
      review: {
        representativeNormalSpeedRequired: true,
        fullNormalSpeedPlaybackRequired: true,
        staticEvidenceIsNotAcceptance: true,
      },
    },
    execution: {
      semanticEdit: {
        wordTimedSource: null,
        reviewedThroughSeconds: null,
        cutDecisions: [],
        unresolvedFragments: null,
      },
      connections: {
        detectedCount: null,
        cutSheetCount: null,
        auditedCount: null,
        unresolvedCount: null,
        events: [],
      },
      opening: {
        primaryEffectCount: null,
        firstVisibleChangeSeconds: null,
        promiseSeconds: null,
        effectId: null,
        dynamicPreview: null,
        revealStartsClosed: null,
        frameZeroCoverage: null,
        partialSubjectAperture: null,
      },
      effects: {
        maxConcurrentPrimary: null,
        progressiveLists: [],
        behindSubjectText: [],
      },
      captions: {
        regularStyle: {
          font: "金陵体",
          background: "none",
          outline: "none",
          shadowOpacity: 0.6,
        },
        relationshipGroups: [],
      },
      overlays: { events: [] },
      pip: { events: [] },
      externalAssets: { items: [] },
      audio: {
        adaptivePlan: null,
        timelineFps: null,
        promptFields: {},
        intentionalSilences: [],
        sfxEvents: [],
      },
      cover: { mode: "live_action" },
      firstMinute: {
        motivatedEffects: [],
        humanPresenceRatio: null,
        fullScreenTakeoverRatio: null,
        breathingRoomRatio: null,
        peakAlignedSfxEventIds: [],
        humanReactionWindows: [],
        normalSpeedPreview: null,
      },
      cinematicEditorial: {
        showId: null,
        durationSeconds: null,
        events: [],
        auditMetrics: null,
        normalSpeedPreview: null,
        phoneSizeReview: { status: "pending", evidence: null },
        webLikenessReview: { status: "pending", evidence: null },
      },
    },
    release: {
      finalTimeline: null,
      stems: { dialogue: null, bgm: null, sfx: null, mix: null },
      programDurationSeconds: null,
      bgmCoverageRatio: null,
      representativeNormalSpeed: { status: "pending", evidence: null },
      fullPlayback: { status: "pending", evidence: null },
      deviceListening: { status: "pending", evidence: null },
    },
  };
}

function exactArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function increasing(values) {
  return values.every((value, index) => Number.isFinite(value)
    && value >= 0
    && (index === 0 || value > values[index - 1]));
}

function intervalUnionDuration(intervals, durationSeconds) {
  const normalized = intervals
    .map((interval) => ({
      start: Math.max(0, Number(interval.startSeconds)),
      end: Math.min(durationSeconds, Number(interval.endSeconds)),
    }))
    .filter((interval) => Number.isFinite(interval.start)
      && Number.isFinite(interval.end)
      && interval.end > interval.start)
    .sort((left, right) => left.start - right.start);
  let total = 0;
  let currentStart = null;
  let currentEnd = null;
  for (const interval of normalized) {
    if (currentStart === null) {
      currentStart = interval.start;
      currentEnd = interval.end;
    } else if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }
  if (currentStart !== null) total += currentEnd - currentStart;
  return total;
}

function roundedMetric(value) {
  return Math.round(value * 10000) / 10000;
}

export function calculateCinematicEditorialMetrics(record) {
  const durationSeconds = Number(record?.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("cinematicEditorial.durationSeconds 必须大于 0");
  }
  const events = Array.isArray(record?.events) ? record.events : [];
  const realTypes = new Set([
    "a_roll",
    "real_world_footage",
    "project_evidence",
    "screen_recording",
    "licensed_external_media",
  ]);
  const coverageDuration = intervalUnionDuration(events, durationSeconds);
  const realPictureDuration = intervalUnionDuration(
    events.filter((event) => realTypes.has(event.sourceType)),
    durationSeconds,
  );
  const boundedDuration = intervalUnionDuration(
    events.filter((event) => BOUNDED_CONTAINER_TYPES.has(event.containerType)),
    durationSeconds,
  );
  const dashboardDuration = intervalUnionDuration(
    events.filter((event) => event.containerType === "dashboard"),
    durationSeconds,
  );
  const mechanismDurations = new Map();
  for (const mechanism of new Set(events.map((event) => event.mechanism).filter(hasValue))) {
    mechanismDurations.set(
      mechanism,
      intervalUnionDuration(events.filter((event) => event.mechanism === mechanism), durationSeconds),
    );
  }
  const nonCleanMechanismDurations = [...mechanismDurations.entries()]
    .filter(([mechanism]) => mechanism !== "clean_a_roll")
    .map(([, value]) => value);
  const nonCleanDuration = nonCleanMechanismDurations.reduce((sum, value) => sum + value, 0);
  return {
    timelineCoverageRatio: roundedMetric(coverageDuration / durationSeconds),
    realPictureRatio: roundedMetric(realPictureDuration / durationSeconds),
    boundedSurfaceRatio: roundedMetric(boundedDuration / durationSeconds),
    dashboardRatio: roundedMetric(dashboardDuration / durationSeconds),
    distinctMechanismCount: mechanismDurations.size,
    maximumSingleMechanismShare: roundedMetric(
      nonCleanDuration > 0 ? Math.max(...nonCleanMechanismDurations) / nonCleanDuration : 1,
    ),
  };
}

function chineseLength(value) {
  return [...String(value ?? "").replace(/\s+/g, "")].length;
}

function identityFile(contractFile, identity, label, errors) {
  if (!identity?.path || !identity?.sha256) {
    errors.push(`${label} 必须记录 path 与 sha256`);
    return null;
  }
  const file = resolveFrom(contractFile, identity.path);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    errors.push(`${label} 文件不存在`);
    return null;
  }
  if (fs.lstatSync(file).isSymbolicLink()) {
    errors.push(`${label} 不得使用符号链接`);
    return null;
  }
  if (sha256File(file) !== identity.sha256) errors.push(`${label} sha256 与当前文件不一致`);
  return file;
}

function validatePolicies(contract, errors) {
  const policy = contract.policies ?? {};
  if (policy.semanticEdit?.fragmentPolicy !== "keep_or_remove_complete_unit") {
    errors.push("policies.semanticEdit 必须禁止半句话残片");
  }
  if (
    policy.connections?.enumerateEveryFinalJoin !== true
    || policy.connections?.motivatedDecisionRequired !== true
    || policy.connections?.wrongCutMustBeReedited !== true
  ) errors.push("policies.connections 必须枚举全部连接点、说明动机并返剪错误剪点");
  const firstVisibleBy = Number(policy.opening?.firstVisibleChangeBySeconds);
  const promiseBy = Number(policy.opening?.promiseBySeconds);
  if (
    policy.opening?.exactlyOnePrimaryEffect !== true
    || !Number.isFinite(firstVisibleBy)
    || firstVisibleBy < 0
    || firstVisibleBy > 0.5
    || !Number.isFinite(promiseBy)
    || promiseBy <= 0
    || promiseBy > 3
    || policy.opening?.frameZeroFullCoverForClosedReveal !== true
    || policy.opening?.partialSubjectApertureForbidden !== true
  ) errors.push("policies.opening 必须约束唯一开场、0.5 秒可见变化、3 秒承诺和闭合揭幕首帧完整覆盖");
  if (
    policy.effects?.semanticTriggerRequired !== true
    || Number(policy.effects?.maxConcurrentPrimary) !== 1
    || policy.effects?.progressiveLists !== true
    || policy.effects?.individualSfxPerItem !== true
    || Number(policy.effects?.behindSubjectMaxChineseCharacters) > 7
  ) errors.push("policies.effects 未落实语义触发、单主效果、逐项清单或人物身后短词限制");
  if (
    !exactArray(policy.typography?.allowedFonts, ALLOWED_FONTS)
    || policy.typography?.regularSubtitle?.font !== "金陵体"
    || policy.typography?.regularSubtitle?.background !== "none"
    || policy.typography?.regularSubtitle?.outline !== "none"
    || Number(policy.typography?.regularSubtitle?.shadowOpacity) !== 0.6
    || policy.typography?.displayFont !== "华光标题黑"
    || policy.typography?.coverTitleFont !== "封神榜书"
  ) errors.push("policies.typography 与行者字体、字幕背景、描边和阴影合同不一致");
  const maxBorder = Number(policy.overlays?.maxCardBorderPxAt4k);
  if (
    policy.overlays?.threeStateCollisionCheck !== true
    || policy.overlays?.protectFaceHeadSubtitlesAndPlatformUi !== true
    || policy.overlays?.pipInformationDifferenceRequired !== true
    || !Number.isFinite(maxBorder)
    || maxBorder < 0
    || maxBorder > 4
  ) errors.push("policies.overlays 未落实三态避碰、信息差画中画或克制描边");
  if (
    policy.externalAssets?.semanticFiveTupleRequired !== true
    || policy.externalAssets?.provenanceRequired !== true
    || policy.externalAssets?.illustrativeLabel !== "情境示意"
  ) errors.push("policies.externalAssets 未落实语义五元组、来源和情境示意标记");
  const requiredPromptFields = template("fixture").policies.audio.professionalPromptFields;
  if (
    policy.audio?.adaptiveBgmRequired !== true
    || policy.audio?.rhythmEmotionContentAnalysisRequired !== true
    || !requiredPromptFields.every((field) => policy.audio?.professionalPromptFields?.includes(field))
    || !Number.isFinite(Number(policy.audio?.minimumCoverageRatio))
    || Number(policy.audio?.minimumCoverageRatio) < 0.95
    || policy.audio?.sfxWaveformPeakEvidenceRequired !== true
    || policy.audio?.sfxAutoPeakAlignmentRequired !== true
    || policy.audio?.semanticLandingIsTimelineAuthority !== true
    || Number(policy.audio?.sfxPeakToleranceFrames) !== 1
  ) errors.push("policies.audio 未落实自适应配乐、专业提示词字段或连续覆盖");
  if (
    policy.cover?.approved3dTurnaroundDefaultGenerationAnchor !== true
    || policy.cover?.defaultGenerationInputMode !== "turnaround_only_real_photo_qc"
    || policy.cover?.realPhotoGenerationInputForbiddenByDefault !== true
    || policy.cover?.realPhotoPriority !== "post_generation_identity_qc_only"
    || policy.cover?.turnaroundPriority !== "generation_identity_body_clothing_continuity"
    || policy.cover?.turnaroundPoseForbiddenForDisplay !== true
    || policy.cover?.sceneSpecificPoseContractRequired !== true
    || policy.cover?.poseReuseForbidden !== true
    || !exactArray(policy.cover?.allowedGenerationInputModes, ["dual_anchor", "turnaround_only_real_photo_qc"])
    || policy.cover?.dualAnchorRequiresExplicitAuthorization !== true
    || !exactArray(policy.cover?.requiredPoseFields, template("fixture").policies.cover.requiredPoseFields)
  ) errors.push("policies.cover 未落实获批 3D 三视图默认生成锚点、真人仅后置 QC 和展示姿态转换");
  const firstMinute = policy.firstMinute ?? {};
  if (
    Number(firstMinute.windowSeconds) !== 60
    || Number(firstMinute.minimumMotivatedEffects) < 5
    || Number(firstMinute.minimumDistinctMechanisms) < 4
    || Number(firstMinute.minimumPeakAlignedSfx) < 3
    || Number(firstMinute.maximumPrimaryEventsPer10Seconds) > 3
    || Number(firstMinute.minimumHumanPresenceRatio) < 0.55
    || Number(firstMinute.maximumFullScreenTakeoverRatio) > 0.35
    || Number(firstMinute.minimumBreathingRoomRatio) < 0.2
    || firstMinute.openingHookRequired !== true
    || firstMinute.audioVisualIntentMustMatch !== true
    || firstMinute.normalSpeedPreviewRequired !== true
  ) errors.push("policies.firstMinute 未落实前 60 秒吸引力、丰富度、高级感和活人感门槛");
  const currentCinematic = antiWebPolicy();
  const cinematic = policy.cinematicEditorial ?? {};
  if (
    cinematic.policyId !== currentCinematic.id
    || cinematic.policyVersion !== currentCinematic.version
    || cinematic.policySha256 !== sha256File(antiWebPolicyFile)
    || !exactArray(cinematic.selectionOrder, currentCinematic.selectionOrder)
    || !exactArray(cinematic.cinematicMechanisms, currentCinematic.cinematicMechanisms)
    || !exactArray(cinematic.sourceTypes, currentCinematic.sourceTypes)
    || !exactArray(cinematic.containerTypes, currentCinematic.containerTypes)
    || !exactArray(cinematic.boundedSurfaceReasons, currentCinematic.boundedSurfaceReasons)
    || !exactArray(cinematic.forbiddenPatterns, currentCinematic.forbiddenPatterns)
    || cinematic.globalRules?.realPictureBeforeGraphicContainer !== true
    || cinematic.globalRules?.boundarylessBeforeBounded !== true
    || cinematic.globalRules?.noAdjacentBoundedSurfaces !== true
    || cinematic.globalRules?.staticPeakFrameIsNotAcceptance !== true
    || JSON.stringify(cinematic.showBudgets) !== JSON.stringify(currentCinematic.showBudgets)
    || JSON.stringify(cinematic.styleGrammarMechanisms)
      !== JSON.stringify(currentCinematic.styleGrammarMechanisms)
  ) errors.push("policies.cinematicEditorial 必须绑定当前行者风 3.0 电影化编辑与反网页合同");
  if (
    policy.review?.representativeNormalSpeedRequired !== true
    || policy.review?.fullNormalSpeedPlaybackRequired !== true
    || policy.review?.staticEvidenceIsNotAcceptance !== true
  ) errors.push("policies.review 不得用静态帧或自动 QC 代替正常速度人工验片");
}

function validateCinematicEditorial(contractFile, contract, execution, errors) {
  const policy = contract.policies?.cinematicEditorial ?? {};
  const record = execution.cinematicEditorial ?? {};
  const durationSeconds = Number(record.durationSeconds);
  const budget = policy.showBudgets?.[record.showId];
  const events = Array.isArray(record.events)
    ? [...record.events].sort((left, right) => Number(left.startSeconds) - Number(right.startSeconds))
    : [];
  if (!budget) errors.push("execution.cinematicEditorial.showId 必须是当前五栏目之一");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    errors.push("execution.cinematicEditorial.durationSeconds 必须大于 0");
    return;
  }
  if (events.length === 0) {
    errors.push("execution.cinematicEditorial.events 必须覆盖完整成片镜头区间");
    return;
  }
  const ids = new Set();
  for (const [index, event] of events.entries()) {
    const prefix = `execution.cinematicEditorial.events[${index}]`;
    const start = Number(event.startSeconds);
    const end = Number(event.endSeconds);
    const required = [
      "id", "semanticBeatId", "trigger", "mechanism", "sourceType",
      "containerType", "compositionSignature", "styleId", "simplerAlternative",
    ];
    const missing = required.filter((field) => !hasValue(event[field]));
    if (missing.length > 0) errors.push(`${prefix} 缺少 ${missing.join("、")}`);
    if (ids.has(event.id)) errors.push(`${prefix}.id 重复：${event.id}`);
    ids.add(event.id);
    if (
      !Number.isFinite(start)
      || !Number.isFinite(end)
      || start < 0
      || end <= start
      || end > durationSeconds + 1e-6
    ) errors.push(`${prefix} 时间区间无效`);
    if (!policy.cinematicMechanisms?.includes(event.mechanism)) {
      errors.push(`${prefix}.mechanism 不是已注册电影化机制`);
    }
    if (!policy.sourceTypes?.includes(event.sourceType)) {
      errors.push(`${prefix}.sourceType 不是已注册来源类型`);
    }
    if (!policy.containerTypes?.includes(event.containerType)) {
      errors.push(`${prefix}.containerType 不是已注册容器类型`);
    }
    if (!policy.styleGrammarMechanisms?.[event.styleId]) {
      errors.push(`${prefix}.styleId 不是五套正式视觉语言之一`);
    } else if (
      !["bounded_information_surface", "clean_a_roll"].includes(event.mechanism)
      && !policy.styleGrammarMechanisms[event.styleId].includes(event.mechanism)
    ) {
      errors.push(`${prefix}.mechanism 与所选风格的镜头语法不一致`);
    }
    if ((event.patterns ?? []).some((item) => policy.forbiddenPatterns?.includes(item))) {
      errors.push(`${prefix} 命中网页化禁用模式`);
    }
    if (event.containerType === "dashboard") errors.push(`${prefix} 禁止通用仪表盘构图`);
    if (BOUNDED_CONTAINER_TYPES.has(event.containerType)) {
      if (!policy.boundedSurfaceReasons?.includes(event.boundedSurfaceReason)) {
        errors.push(`${prefix} 有边界表面缺少合法信息理由`);
      }
      const area = Number(event.containerAreaRatio);
      if (
        !Number.isFinite(area)
        || area <= 0
        || area > Number(policy.globalRules?.maximumRoundedContainerAreaRatio)
      ) errors.push(`${prefix}.containerAreaRatio 超过电影化容器面积上限`);
      if (end - start > Number(policy.globalRules?.maximumSingleBoundedSurfaceSeconds)) {
        errors.push(`${prefix} 单个有边界表面停留过长`);
      }
      if (
        end < durationSeconds - 0.001
        && Number(event.cleanReturnSeconds)
          < Number(policy.globalRules?.minimumCleanReturnSecondsAfterBoundedSurface)
      ) errors.push(`${prefix} 后未返回真人、证据或干净画面`);
      if (event.mechanism !== "bounded_information_surface") {
        errors.push(`${prefix} 有边界表面必须明确登记 bounded_information_surface 机制`);
      }
    }
  }
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (
      BOUNDED_CONTAINER_TYPES.has(previous.containerType)
      && BOUNDED_CONTAINER_TYPES.has(current.containerType)
      && Number(current.startSeconds) - Number(previous.endSeconds)
        < Number(policy.globalRules?.minimumCleanReturnSecondsAfterBoundedSurface)
    ) errors.push(`execution.cinematicEditorial.events[${index}] 与前一有边界表面连续，形成卡片接卡片`);
  }
  const byComposition = new Map();
  for (const event of events) {
    if (event.mechanism === "clean_a_roll") continue;
    const previous = byComposition.get(event.compositionSignature);
    if (
      previous
      && Number(event.startSeconds) - Number(previous.startSeconds)
        < Number(policy.globalRules?.compositionCooldownSeconds)
    ) errors.push(`execution.cinematicEditorial 构图 ${event.compositionSignature} 在冷却时间内重复`);
    byComposition.set(event.compositionSignature, event);
  }
  const metrics = calculateCinematicEditorialMetrics(record);
  const expectedDistinct = durationSeconds < 45
    ? 2
    : durationSeconds < 90
      ? Math.min(3, Number(budget?.minimumDistinctMechanismsPer120Seconds ?? 3))
      : Number(budget?.minimumDistinctMechanismsPer120Seconds ?? 3);
  if (metrics.timelineCoverageRatio < 0.98) {
    errors.push("execution.cinematicEditorial 镜头事件未覆盖至少 98% 的成片时间线");
  }
  if (budget && metrics.realPictureRatio < Number(budget.minimumRealPictureRatio)) {
    errors.push("execution.cinematicEditorial 真人、真实空间或可核验证据占比不足");
  }
  if (budget && metrics.boundedSurfaceRatio > Number(budget.maximumBoundedSurfaceRatio)) {
    errors.push("execution.cinematicEditorial 卡片、弹窗或有边界表面累计占比过高");
  }
  if (budget && metrics.dashboardRatio > Number(budget.maximumDashboardRatio)) {
    errors.push("execution.cinematicEditorial 禁止仪表盘式画面接管");
  }
  if (metrics.distinctMechanismCount < expectedDistinct) {
    errors.push("execution.cinematicEditorial 镜头机制多样性不足");
  }
  if (metrics.maximumSingleMechanismShare > Number(policy.globalRules?.sameMechanismMaximumShare)) {
    errors.push("execution.cinematicEditorial 单一镜头机制占比过高");
  }
  if (JSON.stringify(record.auditMetrics) !== JSON.stringify(metrics)) {
    errors.push("execution.cinematicEditorial.auditMetrics 必须由当前事件重新计算，不能沿用旧报告");
  }
  identityFile(
    contractFile,
    record.normalSpeedPreview,
    "execution.cinematicEditorial.normalSpeedPreview",
    errors,
  );
  for (const field of ["phoneSizeReview", "webLikenessReview"]) {
    if (record[field]?.status !== "pass") {
      errors.push(`execution.cinematicEditorial.${field}.status 必须为 pass`);
    }
    identityFile(
      contractFile,
      record[field]?.evidence,
      `execution.cinematicEditorial.${field}.evidence`,
      errors,
    );
  }
}

function validateExecution(contractFile, contract, errors) {
  const execution = contract.execution ?? {};
  const semantic = execution.semanticEdit ?? {};
  identityFile(contractFile, semantic.wordTimedSource, "execution.semanticEdit.wordTimedSource", errors);
  if (!(Number(semantic.reviewedThroughSeconds) > 0)) {
    errors.push("execution.semanticEdit.reviewedThroughSeconds 必须大于 0");
  }
  if (Number(semantic.unresolvedFragments) !== 0) errors.push("execution.semanticEdit 仍有半句话残片");
  for (const [index, decision] of (semantic.cutDecisions ?? []).entries()) {
    if (
      decision.semanticUnitComplete !== true
      || !["keep_complete", "remove_complete"].includes(decision.fragmentPolicy)
      || !hasValue(decision.reason)
      || !Number.isFinite(Number(decision.sourceStartSeconds))
      || !Number.isFinite(Number(decision.sourceEndSeconds))
      || Number(decision.sourceEndSeconds) <= Number(decision.sourceStartSeconds)
    ) errors.push(`execution.semanticEdit.cutDecisions[${index}] 不是完整语义单元决策`);
  }

  const joins = execution.connections ?? {};
  const counts = [joins.detectedCount, joins.cutSheetCount, joins.auditedCount].map(Number);
  if (
    !counts.every(Number.isInteger)
    || counts.some((value) => value < 0)
    || !counts.every((value) => value === counts[0])
  ) {
    errors.push("execution.connections 检测数、剪点表数和审计数必须完全一致");
  }
  if (Number(joins.unresolvedCount) !== 0) errors.push("execution.connections 仍有未解决连接点");
  if (Array.isArray(joins.events) && Number.isInteger(counts[0]) && joins.events.length !== counts[0]) {
    errors.push("execution.connections.events 必须覆盖每一个最终连接点");
  }
  for (const [index, event] of (joins.events ?? []).entries()) {
    if (!JOIN_TYPES.has(event.decisionType) || !hasValue(event.motivation)) {
      errors.push(`execution.connections.events[${index}] 缺少专业连接类型或动机`);
    }
    if (event.repairedWrongCut === false) errors.push(`execution.connections.events[${index}] 不能用转场掩盖错误剪点`);
  }

  const opening = execution.opening ?? {};
  if (
    Number(opening.primaryEffectCount) !== 1
    || Number(opening.firstVisibleChangeSeconds) < 0
    || Number(opening.firstVisibleChangeSeconds) > 0.5
    || Number(opening.promiseSeconds) <= 0
    || Number(opening.promiseSeconds) > 3
    || !hasValue(opening.effectId)
  ) errors.push("execution.opening 未落实唯一开场、0.5 秒变化或 3 秒承诺");
  identityFile(contractFile, opening.dynamicPreview, "execution.opening.dynamicPreview", errors);
  if (
    opening.revealStartsClosed === true
    && (opening.frameZeroCoverage !== "full" || opening.partialSubjectAperture !== false)
  ) errors.push("execution.opening 闭合揭幕必须从全覆盖开始，禁止先露出局部人脸小口");

  const effects = execution.effects ?? {};
  if (
    !Number.isInteger(Number(effects.maxConcurrentPrimary))
    || Number(effects.maxConcurrentPrimary) < 0
    || Number(effects.maxConcurrentPrimary) > 1
  ) errors.push("execution.effects 同时出现了多个主效果或没有记录并发密度");
  for (const [index, group] of (effects.progressiveLists ?? []).entries()) {
    const itemCues = group.itemCues ?? [];
    const sfxPeaks = group.sfxPeaks ?? [];
    if (
      !Number.isInteger(group.itemCount)
      || group.itemCount < 1
      || itemCues.length !== group.itemCount
      || sfxPeaks.length !== group.itemCount
      || !increasing(itemCues)
      || !increasing(sfxPeaks)
      || sfxPeaks.some((peak, cueIndex) => Math.abs(peak - itemCues[cueIndex]) > 0.25)
    ) errors.push(`execution.effects.progressiveLists[${index}] 必须逐项随口播出现并逐项落独立音效峰值`);
  }
  for (const [index, item] of (effects.behindSubjectText ?? []).entries()) {
    if (
      chineseLength(item.text) > 7
      || item.font !== "华光标题黑"
      || item.maskVerified !== true
    ) errors.push(`execution.effects.behindSubjectText[${index}] 必须是 7 字以内华光标题黑短词并验证人物遮挡`);
  }

  const regularStyle = execution.captions?.regularStyle ?? {};
  if (
    regularStyle.font !== "金陵体"
    || regularStyle.background !== "none"
    || regularStyle.outline !== "none"
    || Number(regularStyle.shadowOpacity) !== 0.6
  ) errors.push("execution.captions.regularStyle 必须是金陵体、无底色、无描边、60% 阴影");
  for (const [index, group] of (execution.captions?.relationshipGroups ?? []).entries()) {
    if (
      !RELATIONS.has(group.relation)
      || !Array.isArray(group.lines)
      || group.lines.length < 2
      || group.lineCues?.length !== group.lines.length
      || !increasing(group.lineCues)
    ) errors.push(`execution.captions.relationshipGroups[${index}] 不是按语义关系逐行出现的多行字幕`);
  }
  for (const [index, event] of (execution.overlays?.events ?? []).entries()) {
    if (
      !Number.isFinite(Number(event.borderPxAt4k))
      || Number(event.borderPxAt4k) < 0
      || Number(event.borderPxAt4k) > 4
      || event.textOutline !== "none"
      || !["entry", "peak", "exit"].every((state) => event.collisionStates?.[state] === "pass")
    ) errors.push(`execution.overlays.events[${index}] 使用了粗描边或没有通过三态避碰`);
  }
  for (const [index, event] of (execution.pip?.events ?? []).entries()) {
    if (
      event.informationDifference !== true
      || event.selfPip === true
      || !["entry", "peak", "exit"].every((state) => event.collisionStates?.[state] === "pass")
    ) errors.push(`execution.pip.events[${index}] 缺少信息差或三态避碰`);
  }
  for (const [index, item] of (execution.externalAssets?.items ?? []).entries()) {
    const tuple = item.semantic ?? {};
    if (
      !["object", "action", "state", "role", "tense"].every((field) => hasValue(tuple[field]))
      || !hasValue(item.provenance?.kind)
      || !hasValue(item.provenance?.evidence)
      || (item.illustrative === true && item.label !== "情境示意")
    ) errors.push(`execution.externalAssets.items[${index}] 缺少语义五元组、来源或情境示意标记`);
    identityFile(contractFile, item.file, `execution.externalAssets.items[${index}].file`, errors);
  }

  const audio = execution.audio ?? {};
  identityFile(contractFile, audio.adaptivePlan, "execution.audio.adaptivePlan", errors);
  for (const field of contract.policies?.audio?.professionalPromptFields ?? []) {
    if (!hasValue(audio.promptFields?.[field])) errors.push(`execution.audio.promptFields.${field} 缺失`);
  }
  const timelineFps = Number(audio.timelineFps);
  if (!Number.isFinite(timelineFps) || timelineFps <= 0) {
    errors.push("execution.audio.timelineFps 必须记录真实时间线帧率");
  }
  for (const [index, event] of (audio.sfxEvents ?? []).entries()) {
    const file = identityFile(contractFile, event.file, `execution.audio.sfxEvents[${index}].file`, errors);
    try {
      if (!file || !Number.isFinite(timelineFps)) throw new Error("缺少可测量文件或帧率");
      const actual = alignSfxPeak({
        file,
        targetLandingSeconds: event.targetLandingSeconds,
        fps: timelineFps,
        toleranceFrames: contract.policies?.audio?.sfxPeakToleranceFrames ?? 1,
      });
      const frameToleranceSeconds = Number(contract.policies?.audio?.sfxPeakToleranceFrames ?? 1)
        / timelineFps;
      const startMatches = Math.abs(
        Number(event.fileStartSeconds) - actual.fileStartSeconds,
      ) <= frameToleranceSeconds + 1e-6;
      const trimMatches = Math.abs(
        Number(event.sourceTrimSeconds ?? 0) - actual.sourceTrimSeconds,
      ) <= frameToleranceSeconds + 1e-6;
      const peakMatches = Math.abs(
        Number(event.measuredPeakOffsetSeconds) - actual.measuredPeakOffsetSeconds,
      ) <= frameToleranceSeconds + 1e-6;
      if (
        event.alignmentMode !== "waveform_peak"
        || event.measurementMethod !== actual.measurementMethod
        || !startMatches
        || !trimMatches
        || !peakMatches
        || !actual.withinTolerance
      ) throw new Error("实测峰值与合同记录不一致");
    } catch {
      errors.push(`execution.audio.sfxEvents[${index}] 必须由工具解码当前文件并自动反推起播时间，峰值误差不超过 1 帧`);
    }
  }

  const cover = execution.cover ?? {};
  if (cover.mode === "cinematic_3d") {
    identityFile(contractFile, cover.realFaceAnchor, "execution.cover.realFaceAnchor", errors);
    identityFile(contractFile, cover.turnaroundAnchor, "execution.cover.turnaroundAnchor", errors);
    identityFile(contractFile, cover.poseAsset, "execution.cover.poseAsset", errors);
    const allowedModes = contract.policies?.cover?.allowedGenerationInputModes ?? [];
    if (!allowedModes.includes(cover.generationInputMode)) {
      errors.push("execution.cover generationInputMode 不符合电影级 3D 身份输入合同");
    }
    const explicitDualAnchor = cover.explicitDualAnchorOverride?.authorized === true
      && hasValue(cover.explicitDualAnchorOverride?.reason);
    if (
      cover.generationInputMode !== contract.policies?.cover?.defaultGenerationInputMode
      && !explicitDualAnchor
    ) errors.push("execution.cover 默认必须只用获批 3D 三视图生成；双锚点需要逐期显式授权");
    if (cover.generationInputMode === "turnaround_only_real_photo_qc") {
      const references = cover.generationInputReferences ?? [];
      if (
        cover.realFaceAnchorRole !== "post_generation_qc_only"
        || references.length !== 1
        || references[0]?.sha256 !== cover.turnaroundAnchor?.sha256
      ) errors.push("execution.cover 三视图唯一生成模式不得混入真人照片；真人照只能用于生成后辨识 QC");
    }
    if (cover.displayUsesTurnaroundPose !== false || cover.poseAdapted !== true) {
      errors.push("execution.cover 电影级 3D 封面不得直接使用三视图/T-pose 展示姿态");
    }
    const pose = cover.poseContract ?? {};
    const requiredPoseFields = contract.policies?.cover?.requiredPoseFields ?? [];
    const missingPoseFields = requiredPoseFields.filter((field) => !hasValue(pose[field]));
    if (missingPoseFields.length > 0 || pose.reusedApprovedPose !== false) {
      errors.push(`execution.cover 人物动作必须绑定当前场景且不得复用固定姿势：${missingPoseFields.join(", ") || "reusedApprovedPose"}`);
    }
  }

  const firstMinutePolicy = contract.policies?.firstMinute ?? {};
  const firstMinute = execution.firstMinute ?? {};
  const motivated = Array.isArray(firstMinute.motivatedEffects)
    ? firstMinute.motivatedEffects
    : [];
  const windowSeconds = Number(firstMinutePolicy.windowSeconds ?? 60);
  const firstMinuteEffects = motivated.filter((event) => (
    Number.isFinite(Number(event.startSeconds))
    && Number(event.startSeconds) >= 0
    && Number(event.startSeconds) < windowSeconds
  ));
  const mechanisms = new Set(firstMinuteEffects.map((event) => event.mechanism).filter(hasValue));
  const invalidMotivation = firstMinuteEffects.some((event) => (
    !hasValue(event.trigger)
    || !hasValue(event.mechanism)
    || event.audioVisualIntentMatched !== true
  ));
  let overDense = false;
  for (let start = 0; start < windowSeconds; start += 1) {
    const primaryCount = firstMinuteEffects.filter((event) => (
      event.primary !== false
      && Number(event.startSeconds) >= start
      && Number(event.startSeconds) < start + 10
    )).length;
    if (primaryCount > Number(firstMinutePolicy.maximumPrimaryEventsPer10Seconds)) overDense = true;
  }
  if (
    firstMinuteEffects.length < Number(firstMinutePolicy.minimumMotivatedEffects)
    || mechanisms.size < Number(firstMinutePolicy.minimumDistinctMechanisms)
    || invalidMotivation
    || overDense
    || Number(firstMinute.humanPresenceRatio) < Number(firstMinutePolicy.minimumHumanPresenceRatio)
    || Number(firstMinute.fullScreenTakeoverRatio) > Number(firstMinutePolicy.maximumFullScreenTakeoverRatio)
    || Number(firstMinute.breathingRoomRatio) < Number(firstMinutePolicy.minimumBreathingRoomRatio)
    || !Array.isArray(firstMinute.humanReactionWindows)
    || firstMinute.humanReactionWindows.length < 1
  ) errors.push("execution.firstMinute 未同时满足语义动效丰富度、克制密度、呼吸空间与真人在场感");
  const peakAlignedIds = new Set(firstMinute.peakAlignedSfxEventIds ?? []);
  const audioEventIds = new Set((audio.sfxEvents ?? []).map((event) => event.id).filter(hasValue));
  if (
    peakAlignedIds.size < Number(firstMinutePolicy.minimumPeakAlignedSfx)
    || [...peakAlignedIds].some((id) => !audioEventIds.has(id))
  ) errors.push("execution.firstMinute 前 60 秒音效不足，或没有绑定到实际峰值校准事件");
  identityFile(
    contractFile,
    firstMinute.normalSpeedPreview,
    "execution.firstMinute.normalSpeedPreview",
    errors,
  );
  validateCinematicEditorial(contractFile, contract, execution, errors);
}

function validateRelease(contractFile, contract, errors) {
  const release = contract.release ?? {};
  identityFile(contractFile, release.finalTimeline, "release.finalTimeline", errors);
  for (const stem of ["dialogue", "bgm", "sfx", "mix"]) {
    identityFile(contractFile, release.stems?.[stem], `release.stems.${stem}`, errors);
  }
  const coverage = Number(release.bgmCoverageRatio);
  const programDuration = Number(release.programDurationSeconds);
  const intentionalSilences = release.intentionalSilences ?? [];
  const intervals = intentionalSilences
    .map((item) => ({ start: Number(item.startSeconds), end: Number(item.endSeconds), reason: item.reason }))
    .filter((item) => Number.isFinite(item.start)
      && Number.isFinite(item.end)
      && item.start >= 0
      && item.end > item.start
      && Number.isFinite(programDuration)
      && item.end <= programDuration)
    .sort((left, right) => left.start - right.start);
  let intentionalDuration = 0;
  let cursor = -Infinity;
  for (const interval of intervals) {
    const start = Math.max(interval.start, cursor);
    if (interval.end > start) intentionalDuration += interval.end - start;
    cursor = Math.max(cursor, interval.end);
  }
  const explainedCoverage = Number.isFinite(programDuration) && programDuration > 0
    ? coverage + intentionalDuration / programDuration
    : NaN;
  if (!Number.isFinite(programDuration) || programDuration <= 0) {
    errors.push("release.programDurationSeconds 必须大于 0");
  }
  if (
    !Number.isFinite(coverage)
    || coverage < 0
    || coverage > 1
    || !Number.isFinite(explainedCoverage)
    || explainedCoverage < Number(contract.policies.audio.minimumCoverageRatio)
    || intervals.length !== intentionalSilences.length
    || intentionalSilences.some((item) => !hasValue(item.reason))
  ) errors.push("release BGM 覆盖不足，且没有逐段记录有意留白原因");
  for (const field of ["representativeNormalSpeed", "fullPlayback", "deviceListening"]) {
    const review = release[field];
    if (review?.status !== "pass") errors.push(`release.${field}.status 必须为 pass`);
    identityFile(contractFile, review?.evidence, `release.${field}.evidence`, errors);
  }
}

export function validateProductionQualityContract(contractFile, stage = "plan") {
  if (!STAGES.has(stage)) throw new Error(`stage 必须为 ${[...STAGES].join("|")}`);
  const resolved = path.resolve(contractFile);
  const contract = readJson(resolved);
  const errors = [];
  if (contract.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (contract.kind !== "kacha-production-quality-contract") errors.push("kind 无效");
  if (!hasValue(contract.projectId)) errors.push("projectId 缺失");
  validatePolicies(contract, errors);
  if (["execution", "release"].includes(stage)) validateExecution(resolved, contract, errors);
  if (stage === "release") validateRelease(resolved, contract, errors);
  return { status: errors.length === 0 ? "pass" : "fail", stage, contract: resolved, errors };
}

const [, , command] = process.argv;
if (command === "template") {
  const projectId = option("--project-id");
  const output = option("--output");
  if (!projectId || !output) {
    usage();
    process.exit(2);
  }
  writeJsonAtomic(output, template(projectId));
  console.log(JSON.stringify({ status: "pass", output: path.resolve(output) }, null, 2));
} else if (command === "validate") {
  const contractFile = option("--contract");
  const stage = option("--stage", "plan");
  if (!contractFile) {
    usage();
    process.exit(2);
  }
  const report = validateProductionQualityContract(contractFile, stage);
  if (report.status !== "pass") report.errors.forEach((error) => console.error(`- ${error}`));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "pass") process.exit(1);
} else if (command === "anti-web-audit") {
  const contractFile = option("--contract");
  if (!contractFile) {
    usage();
    process.exit(2);
  }
  const resolved = path.resolve(contractFile);
  const contract = readJson(resolved);
  const metrics = calculateCinematicEditorialMetrics(
    contract.execution?.cinematicEditorial,
  );
  const shouldWrite = process.argv.includes("--write");
  if (shouldWrite) {
    contract.execution.cinematicEditorial.auditMetrics = metrics;
    writeJsonAtomic(resolved, contract);
  }
  console.log(JSON.stringify({
    status: "pass",
    contract: resolved,
    metrics,
    written: shouldWrite,
  }, null, 2));
} else {
  usage();
  process.exit(2);
}
