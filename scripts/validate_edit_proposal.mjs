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
  if (!module || module.status !== "enabled") return;

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
}

function validateFlow(plan, errors) {
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
    if (stage.status === "passed" && !hasValue(stage.evidence)) {
      errors.push(`${label}: passed 必须提供 evidence`);
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
      "sourceInventory",
      "goal",
      "contentSpine",
      "editDecisions",
      "creativeLock",
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
  validateSources(plan, proposalFile, errors);
  validateCreativeLock(plan, errors);
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
  validateFlow(plan, errors);

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
