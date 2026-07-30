#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  hasValue,
  readJson,
  resolveFrom,
  sha256File,
} from "./kacha_utils.mjs";

const TASK_PATHS = new Set([
  "proposal_review",
  "source_edit",
  "content_generation",
  "local_optimization",
]);
const AUTHORIZATION_MODES = new Set([
  "proposal_only",
  "plan_then_execute",
  "approved_plan",
  "local_change",
]);
const MODULE_STATUSES = new Set(["enabled", "not_applicable"]);
const SERIES_STATUSES = new Set(["detected", "not_series", "undetermined"]);
const STAGE_STATUSES = new Set([
  "pending",
  "in_progress",
  "passed",
  "not_applicable",
  "blocked",
]);
const SHA256 = /^[a-f0-9]{64}$/i;

const REQUIRED_MODULES = [
  "cutsAndShotScale",
  "retentionAndRhythm",
  "visuals",
  "subtitles",
  "dialogueAudio",
  "finalMix",
  "color",
  "beautyAndMasks",
  "generatedMedia",
  "cover",
  "output",
  "qc",
];

const STAGES_BY_SCHEMA = {
  "2.0": [
    "inventory",
    "transcript_structure",
    "rough_cut",
    "dialogue_preprocess",
    "connection_qc",
    "fine_cut",
    "visual_packaging",
    "subtitles",
    "final_mix",
    "cover",
    "preview_render",
    "final_qc",
    "release_package",
  ],
};

function requireFields(object, fields, label, errors) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) {
    errors.push(`${label}: 必须是对象`);
    return;
  }
  for (const field of fields) {
    if (!hasValue(object[field])) errors.push(`${label}: 缺少 ${field}`);
  }
}

function validateAuthorization(plan, errors) {
  const value = plan.authorization;
  requireFields(
    value,
    [
      "mode",
      "canExecute",
      "externalUploadAllowed",
      "paidGenerationAllowed",
      "evidence",
    ],
    "authorization",
    errors,
  );
  if (!value || typeof value !== "object") return;

  if (!AUTHORIZATION_MODES.has(value.mode)) {
    errors.push(`authorization.mode 无效：${value.mode}`);
  }
  for (const field of [
    "canExecute",
    "externalUploadAllowed",
    "paidGenerationAllowed",
  ]) {
    if (typeof value[field] !== "boolean") {
      errors.push(`authorization.${field} 必须是 boolean`);
    }
  }

  const expectedByMode = {
    proposal_only: false,
    plan_then_execute: true,
    approved_plan: true,
    local_change: true,
  };
  if (
    Object.hasOwn(expectedByMode, value.mode)
    && value.canExecute !== expectedByMode[value.mode]
  ) {
    errors.push(
      `authorization.mode=${value.mode} 时 canExecute 必须为 ${expectedByMode[value.mode]}`,
    );
  }

  const allowedModesByTask = {
    proposal_review: new Set(["proposal_only"]),
    source_edit: new Set(["proposal_only", "plan_then_execute", "approved_plan"]),
    content_generation: new Set([
      "proposal_only",
      "plan_then_execute",
      "approved_plan",
    ]),
    local_optimization: new Set(["proposal_only", "local_change", "approved_plan"]),
  };
  if (
    allowedModesByTask[plan.taskPath]
    && !allowedModesByTask[plan.taskPath].has(value.mode)
  ) {
    errors.push(
      `taskPath=${plan.taskPath} 与 authorization.mode=${value.mode} 不兼容`,
    );
  }

  if (value.externalUploadAllowed && !value.canExecute) {
    errors.push("externalUploadAllowed=true 时必须允许执行");
  }
  if (value.paidGenerationAllowed && !value.canExecute) {
    errors.push("paidGenerationAllowed=true 时必须允许执行");
  }
  if (
    value.externalUploadAllowed
    && !plan.approvedScope?.some((item) => /上传|发布|upload|publish/i.test(item))
  ) {
    errors.push("允许外部上传时 approvedScope 必须明确包含上传或发布");
  }
  if (
    value.paidGenerationAllowed
    && !plan.approvedScope?.some((item) => /付费|生成|paid|generation/i.test(item))
  ) {
    errors.push("允许付费生成时 approvedScope 必须明确包含付费生成");
  }
}

function validateSources(plan, proposalFile, errors) {
  const sources = plan.sourceInventory;
  if (!Array.isArray(sources) || sources.length === 0) {
    errors.push("sourceInventory: 至少包含一个只读源或输入记录");
    return;
  }

  sources.forEach((source, index) => {
    const label = `sourceInventory[${index}]`;
    requireFields(source, ["path", "role", "readOnly", "probeEvidence"], label, errors);
    if (source?.readOnly !== true) errors.push(`${label}.readOnly 必须为 true`);
    if (!Array.isArray(source?.probeEvidence) || source.probeEvidence.length === 0) {
      errors.push(`${label}.probeEvidence 必须是非空数组`);
    }

    if (!plan.authorization?.canExecute) return;
    const resolved = resolveFrom(proposalFile, source.path);
    if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      errors.push(`${label}: 执行方案的本地源文件不存在：${resolved ?? source.path}`);
      return;
    }
    if (!SHA256.test(source.sha256 ?? "")) {
      errors.push(`${label}: 执行方案必须记录真实 sha256`);
    } else {
      const actual = sha256File(resolved);
      if (actual.toLowerCase() !== source.sha256.toLowerCase()) {
        errors.push(`${label}: sha256 与源文件不一致`);
      }
    }
    if (source.existsVerified !== true) {
      errors.push(`${label}: 执行方案必须设置 existsVerified=true`);
    }
    if (!hasValue(source.probedAt)) {
      errors.push(`${label}: 执行方案必须记录 probedAt`);
    }
  });
}

function validateModules(plan, errors) {
  const modules = plan.planModules;
  if (modules === null || typeof modules !== "object" || Array.isArray(modules)) {
    errors.push("planModules: 必须是对象");
    return;
  }

  for (const name of REQUIRED_MODULES) {
    const module = modules[name];
    const label = `planModules.${name}`;
    requireFields(module, ["status", "rationale", "successCriteria"], label, errors);
    if (!module || typeof module !== "object") continue;
    if (!MODULE_STATUSES.has(module.status)) {
      errors.push(`${label}.status 必须是 enabled 或 not_applicable`);
    }
    if (module.status === "enabled" && !hasValue(module.actions)) {
      errors.push(`${label}: enabled 时必须提供 actions`);
    }
    if (module.status === "not_applicable" && hasValue(module.actions)) {
      errors.push(`${label}: not_applicable 时不得保留待执行 actions`);
    }
  }
}

function validateDialogueSeparation(plan, errors) {
  const module = plan.planModules?.dialogueAudio;
  const goal = plan.goal ?? {};
  if (typeof goal.hasSpokenDialogue !== "boolean") {
    errors.push("goal.hasSpokenDialogue 必须是 boolean");
  }
  if (typeof goal.audioProcessingRequired !== "boolean") {
    errors.push("goal.audioProcessingRequired 必须是 boolean");
  }
  if (
    goal.hasSpokenDialogue === true
    && ["source_edit", "content_generation"].includes(plan.taskPath)
    && goal.audioProcessingRequired !== true
  ) {
    errors.push("含口播的整支剪辑默认必须设置 goal.audioProcessingRequired=true");
  }
  if (goal.audioProcessingRequired !== true) return;
  if (goal.hasSpokenDialogue !== true) {
    errors.push("启用音频处理时 goal.hasSpokenDialogue 必须为 true");
  }
  if (!module || module.status !== "enabled") {
    errors.push("需要处理口播音频时 planModules.dialogueAudio 必须启用");
    return;
  }

  const separation = module.sourceSeparation;
  requireFields(
    separation,
    [
      "required",
      "finalDialogueSource",
      "keepOriginalReference",
      "keepResidualForAudit",
      "mixResidualIntoFinal",
      "cleanAmbienceOnly",
    ],
    "planModules.dialogueAudio.sourceSeparation",
    errors,
  );
  if (separation && typeof separation === "object") {
    if (separation.required !== true) {
      errors.push("人声预处理必须先执行真实源分离");
    }
    if (separation.finalDialogueSource !== "dialogue_isolated") {
      errors.push("最终 dialogue stem 必须来自已验收的 dialogue_isolated");
    }
    if (separation.keepOriginalReference !== true) {
      errors.push("必须保留 original_reference 用于同响度 A/B");
    }
    if (separation.keepResidualForAudit !== true) {
      errors.push("必须保留 non_dialogue_residual 供审计和回退");
    }
    if (separation.mixResidualIntoFinal !== false) {
      errors.push("non_dialogue_residual 不得混入最终成片");
    }
    if (separation.cleanAmbienceOnly !== true) {
      errors.push("需要环境氛围时只能使用独立、干净且无语音泄漏的 ambience stem");
    }
  }

  const actions = Array.isArray(module.actions) ? module.actions : [];
  const successCriteria = Array.isArray(module.successCriteria)
    ? module.successCriteria
    : [];
  const actionText = actions.join("\n");
  const successText = successCriteria.join("\n");

  const actionContracts = [
    {
      pattern: /人声分离|源分离|dialogue[_ -]?isolated|vocal separation/i,
      message: "actions 必须生成独立人声候选",
    },
    {
      pattern: /non[_ -]?dialogue[_ -]?residual|residual|残余轨|非人声/i,
      message: "actions 必须生成并保留非人声 residual",
    },
    {
      pattern: /同响度|loudness[- ]?match|A\/B/i,
      message: "actions 必须包含分离候选的同响度 A/B",
    },
  ];
  for (const contract of actionContracts) {
    if (!contract.pattern.test(actionText)) {
      errors.push(`planModules.dialogueAudio: ${contract.message}`);
    }
  }

  if (
    !/residual|残余轨|非人声/i.test(successText)
    || !/不进入|未进入|不混|剔除|exclude|removed/i.test(successText)
  ) {
    errors.push(
      "planModules.dialogueAudio.successCriteria 必须明确 residual 不进入最终混音",
    );
  }
  if (!/语音泄漏|完整词句|speech leak/i.test(successText)) {
    errors.push(
      "planModules.dialogueAudio.successCriteria 必须检查 residual 的语音泄漏",
    );
  }
}

function validateCreativeLock(plan, errors) {
  const lock = plan.creativeLock;
  requireFields(
    lock,
    [
      "sourceAspectRatio",
      "outputAspectRatio",
      "sourceWidth",
      "sourceHeight",
      "outputWidth",
      "outputHeight",
      "outputGeometryUserSpecified",
      "preserveSourceDimensions",
      "preserveSourceAspectRatio",
      "preserveSourceFormat",
      "primaryNarrativeRole",
      "aiRole",
      "frozenDecisions",
      "changeRequiresReapproval",
    ],
    "creativeLock",
    errors,
  );
  if (!lock || typeof lock !== "object") return;
  if (typeof lock.preserveSourceFormat !== "boolean") {
    errors.push("creativeLock.preserveSourceFormat 必须是 boolean");
  }
  for (const field of [
    "outputGeometryUserSpecified",
    "preserveSourceDimensions",
    "preserveSourceAspectRatio",
  ]) {
    if (typeof lock[field] !== "boolean") {
      errors.push(`creativeLock.${field} 必须是 boolean`);
    }
  }
  if (!Array.isArray(lock.frozenDecisions) || lock.frozenDecisions.length === 0) {
    errors.push("creativeLock.frozenDecisions 必须是非空数组");
  }
  if (lock.changeRequiresReapproval !== true) {
    errors.push("creativeLock.changeRequiresReapproval 必须为 true");
  }
  const targetRatios = Array.isArray(plan.goal?.videoAspectRatios)
    ? plan.goal.videoAspectRatios
    : [];
  if (
    hasValue(lock.outputAspectRatio)
    && targetRatios.length > 0
    && !targetRatios.includes(lock.outputAspectRatio)
  ) {
    errors.push("creativeLock.outputAspectRatio 必须出现在 goal.videoAspectRatios");
  }

  const geometryFields = [
    "sourceWidth",
    "sourceHeight",
    "outputWidth",
    "outputHeight",
  ];
  if (plan.authorization?.canExecute === true) {
    for (const field of geometryFields) {
      if (!Number.isFinite(lock[field]) || lock[field] <= 0) {
        errors.push(`执行方案 creativeLock.${field} 必须是探测得到的正数`);
      }
    }
  }

  if (lock.outputGeometryUserSpecified === false) {
    if (lock.preserveSourceDimensions !== true) {
      errors.push("用户未指定新尺寸时必须保持原视频尺寸");
    }
    if (lock.preserveSourceAspectRatio !== true) {
      errors.push("用户未指定新画幅时必须保持原视频宽高比");
    }
    if (
      Number.isFinite(lock.sourceWidth)
      && Number.isFinite(lock.outputWidth)
      && lock.sourceWidth !== lock.outputWidth
    ) {
      errors.push("用户未指定新尺寸时 outputWidth 必须等于 sourceWidth");
    }
    if (
      Number.isFinite(lock.sourceHeight)
      && Number.isFinite(lock.outputHeight)
      && lock.sourceHeight !== lock.outputHeight
    ) {
      errors.push("用户未指定新尺寸时 outputHeight 必须等于 sourceHeight");
    }
    if (
      hasValue(lock.sourceAspectRatio)
      && hasValue(lock.outputAspectRatio)
      && lock.sourceAspectRatio !== lock.outputAspectRatio
    ) {
      errors.push("用户未指定新画幅时 outputAspectRatio 必须等于 sourceAspectRatio");
    }
  } else if (!hasValue(lock.outputGeometryAuthorizationEvidence)) {
    errors.push("用户指定新尺寸或画幅时必须记录 outputGeometryAuthorizationEvidence");
  }
}

function validateSeriesIdentity(plan, errors) {
  const series = plan.seriesIdentity;
  requireFields(
    series,
    ["status", "detectionEvidence", "videoMark", "coverMark"],
    "seriesIdentity",
    errors,
  );
  if (!series || typeof series !== "object") return;
  if (!SERIES_STATUSES.has(series.status)) {
    errors.push(`seriesIdentity.status 无效：${series.status}`);
  }
  if (
    !Array.isArray(series.detectionEvidence)
    || series.detectionEvidence.length === 0
  ) {
    errors.push("seriesIdentity.detectionEvidence 必须记录项目目录、既有成片或用户说明等证据");
  }
  if (series.status === "undetermined" && plan.authorization?.canExecute === true) {
    errors.push("执行前必须判断当前项目是否属于系列视频");
  }

  for (const markName of ["videoMark", "coverMark"]) {
    const mark = series[markName];
    requireFields(mark, ["enabled"], `seriesIdentity.${markName}`, errors);
    if (mark && typeof mark.enabled !== "boolean") {
      errors.push(`seriesIdentity.${markName}.enabled 必须是 boolean`);
    }
  }

  if (series.status === "detected") {
    if (!hasValue(series.seriesTitle)) {
      errors.push("检测到系列视频时必须设置 seriesIdentity.seriesTitle");
    }
    for (const markName of ["videoMark", "coverMark"]) {
      const mark = series[markName];
      if (mark?.enabled !== true) {
        errors.push(`检测到系列视频时 seriesIdentity.${markName}.enabled 必须为 true`);
        continue;
      }
      requireFields(
        mark,
        ["placement", "styleVariant", "safeAreaEvidence"],
        `seriesIdentity.${markName}`,
        errors,
      );
      if (
        !Array.isArray(mark.safeAreaEvidence)
        || mark.safeAreaEvidence.length === 0
      ) {
        errors.push(`seriesIdentity.${markName}.safeAreaEvidence 必须是非空数组`);
      }
    }
    if (!hasValue(series.videoMark?.interval)) {
      errors.push("系列视频标识必须记录 videoMark.interval");
    }
  }

  if (
    series.status === "not_series"
    && (series.videoMark?.enabled !== false || series.coverMark?.enabled !== false)
  ) {
    errors.push("非系列项目不得启用系列标识");
  }
}

function validateFlow(plan, proposalFile, errors) {
  const flow = plan.executionFlow;
  if (!Array.isArray(flow)) {
    errors.push("executionFlow: 必须是数组");
    return;
  }

  const requiredStages = STAGES_BY_SCHEMA[plan.schemaVersion];
  if (!requiredStages) {
    errors.push(`schemaVersion 不支持：${plan.schemaVersion}`);
    return;
  }
  const ids = flow.map((stage) => stage?.id);
  if (
    ids.length !== requiredStages.length
    || ids.some((id, index) => id !== requiredStages[index])
  ) {
    errors.push(`executionFlow 阶段顺序必须严格为 ${requiredStages.join(" -> ")}`);
  }

  let inProgressCount = 0;
  let encounteredPending = false;
  flow.forEach((stage, index) => {
    const label = `executionFlow[${index}]`;
    requireFields(stage, ["id", "deliverable", "gate", "status"], label, errors);
    if (!STAGE_STATUSES.has(stage?.status)) {
      errors.push(`${label}.status 无效：${stage?.status}`);
      return;
    }
    if (stage.status === "in_progress" && encounteredPending) {
      errors.push(`${label}: 前置阶段仍为 pending 或 blocked，不得开始`);
    }
    if (stage.status === "in_progress") inProgressCount += 1;
    if (stage.status === "pending" || stage.status === "blocked") encounteredPending = true;
    if (stage.status === "passed" && encounteredPending) {
      errors.push(`${label}: 前置阶段尚未通过，不得标记 passed`);
    }
    if (stage.status === "not_applicable" && !hasValue(stage.notApplicableReason)) {
      errors.push(`${label}: not_applicable 必须提供 notApplicableReason`);
    }
    if (stage.status === "passed") {
      const evidence = stage.evidence;
      if (
        !evidence
        || typeof evidence !== "object"
        || Array.isArray(evidence)
        || !hasValue(evidence.path)
        || !SHA256.test(evidence.sha256 ?? "")
      ) {
        errors.push(`${label}: passed 必须提供 {path, sha256} 文件证据`);
      } else {
        const evidenceFile = resolveFrom(proposalFile, evidence.path);
        if (
          !evidenceFile
          || !fs.existsSync(evidenceFile)
          || !fs.statSync(evidenceFile).isFile()
        ) {
          errors.push(`${label}: evidence 文件不存在`);
        } else if (sha256File(evidenceFile) !== evidence.sha256) {
          errors.push(`${label}: evidence SHA-256 已失效`);
        }
      }
    }
  });
  if (inProgressCount > 1) {
    errors.push("executionFlow 同一时刻最多一个阶段为 in_progress");
  }
}

function validateProposal(plan, proposalFile) {
  const errors = [];
  requireFields(
    plan,
    [
      "schemaVersion",
      "planVersion",
      "requestSummary",
      "taskPath",
      "authorization",
      "visualCapabilityPolicy",
      "sourceInventory",
      "goal",
      "contentSpine",
      "editDecisions",
      "creativeLock",
      "seriesIdentity",
      "planModules",
      "executionFlow",
      "approvedScope",
      "assumptions",
      "riskFallbacks",
      "deliverables",
    ],
    "proposal",
    errors,
  );

  if (!TASK_PATHS.has(plan.taskPath)) {
    errors.push(`taskPath 无效：${plan.taskPath}`);
  }
  if (!Object.hasOwn(STAGES_BY_SCHEMA, plan.schemaVersion)) {
    errors.push(`schemaVersion 仅支持 ${Object.keys(STAGES_BY_SCHEMA).join("、")}`);
  }

  validateAuthorization(plan, errors);
  requireFields(
    plan.visualCapabilityPolicy,
    [
      "enabledForExecution",
      "styleProfile",
      "coveragePlanRequired",
      "perceptualEvidenceRequired",
    ],
    "visualCapabilityPolicy",
    errors,
  );
  if (plan.visualCapabilityPolicy?.enabledForExecution !== true) {
    errors.push("visualCapabilityPolicy.enabledForExecution 必须为 true");
  }
  if (plan.visualCapabilityPolicy?.coveragePlanRequired !== true) {
    errors.push("visualCapabilityPolicy.coveragePlanRequired 必须为 true");
  }
  if (plan.visualCapabilityPolicy?.perceptualEvidenceRequired !== true) {
    errors.push("visualCapabilityPolicy.perceptualEvidenceRequired 必须为 true");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(
    String(plan.visualCapabilityPolicy?.styleProfile ?? ""),
  )) {
    errors.push("visualCapabilityPolicy.styleProfile 格式无效");
  }
  validateSources(plan, proposalFile, errors);
  validateCreativeLock(plan, errors);
  validateSeriesIdentity(plan, errors);
  requireFields(
    plan.goal,
    [
      "audience",
      "platforms",
      "outcome",
      "targetDuration",
      "language",
      "videoAspectRatios",
      "coverAspectRatios",
      "outputFormat",
      "hasSpokenDialogue",
      "audioProcessingRequired",
    ],
    "goal",
    errors,
  );
  requireFields(
    plan.contentSpine,
    ["openingPromise", "coreQuestion", "keyPoints", "payoff", "ending"],
    "contentSpine",
    errors,
  );
  requireFields(
    plan.editDecisions,
    ["keep", "remove", "reorder", "verify"],
    "editDecisions",
    errors,
  );
  validateModules(plan, errors);
  validateDialogueSeparation(plan, errors);
  validateFlow(plan, proposalFile, errors);

  for (const field of [
    "approvedScope",
    "assumptions",
    "riskFallbacks",
    "deliverables",
  ]) {
    if (!Array.isArray(plan[field]) || plan[field].length === 0) {
      errors.push(`${field}: 必须是非空数组`);
    }
  }
  if (!Array.isArray(plan.deviations)) {
    errors.push("deviations: 必须是数组；没有偏差时显式写空数组");
  }
  return errors;
}

const args = process.argv.slice(2);
const input = args.find((argument) => !argument.startsWith("--"));
if (!input) {
  console.error("用法：validate_edit_proposal.mjs <edit-proposal.json>");
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

const errors = validateProposal(plan, file);
if (errors.length > 0) {
  console.error(`剪辑方案门禁失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

const requiredStages = STAGES_BY_SCHEMA[plan.schemaVersion];
console.log(
  JSON.stringify(
    {
      status: "pass",
      file,
      schemaVersion: plan.schemaVersion,
      planVersion: plan.planVersion,
      taskPath: plan.taskPath,
      authorizationMode: plan.authorization.mode,
      canExecute: plan.authorization.canExecute,
      sourceFilesVerified: plan.authorization.canExecute,
      modules: REQUIRED_MODULES.length,
      stages: requiredStages.length,
    },
    null,
    2,
  ),
);
