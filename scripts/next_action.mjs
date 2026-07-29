#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fastIdentityMatches,
  hasValue,
  readJson,
  resolveFrom,
  run,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  classifyFailure,
  diagnostic,
} from "./kacha_error_catalog.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const input = args.find((item) => !item.startsWith("--"));
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : null;

function emit(report, exitCode = 0) {
  if (output) writeJsonAtomic(path.resolve(output), report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
}

function command(script, scriptArgs = []) {
  return [
    "node",
    path.join(scriptsDirectory, script),
    ...scriptArgs.map((item) => String(item)),
  ];
}

function shellCommand(parts) {
  return parts.map((part) => JSON.stringify(part)).join(" ");
}

function runValidator(script, scriptArgs) {
  const result = run(process.execPath, [
    path.join(scriptsDirectory, script),
    ...scriptArgs,
  ]);
  return {
    pass: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function action(id, state, summary, parts = null, extra = {}) {
  return {
    id,
    state,
    summary,
    command: parts ? shellCommand(parts) : null,
    ...extra,
  };
}

if (!input) {
  emit({
    schemaVersion: "1.0",
    status: "blocked",
    diagnostics: [diagnostic("KACHA-E100", "缺少项目 manifest 路径")],
  }, 2);
}

const projectFile = path.resolve(input);
if (!fs.existsSync(projectFile) || !fs.statSync(projectFile).isFile()) {
  emit({
    schemaVersion: "1.0",
    status: "blocked",
    diagnostics: [diagnostic("KACHA-E100", `项目文件不存在：${projectFile}`)],
  }, 1);
}

let project;
try {
  project = readJson(projectFile);
} catch (error) {
  emit({
    schemaVersion: "1.0",
    status: "blocked",
    diagnostics: [diagnostic("KACHA-E140", `项目 JSON 无法解析：${error.message}`)],
  }, 1);
}

function blockedFromValidation(label, result) {
  const message = result.stderr || result.stdout || `${label} validation failed`;
  const code = classifyFailure(message);
  emit({
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    status: "blocked",
    project: project.projectId ?? null,
    workflow: project.schemaVersion === "3.0" ? "incremental" : "full",
    currentState: "contract_invalid",
    nextAction: action(
      "repair_contract",
      "blocked",
      `修复 ${label} 后重新运行 next`,
      null,
      { owner: "agent", safeToAutoExecute: false },
    ),
    diagnostics: [diagnostic(code, message)],
  }, 1);
}

function resolveEntry(owner, entry) {
  const candidate = typeof entry === "string" ? entry : entry?.path;
  return hasValue(candidate) ? resolveFrom(owner, candidate) : null;
}

function fileReady(file) {
  return Boolean(file)
    && fs.existsSync(file)
    && fs.statSync(file).isFile()
    && fs.statSync(file).size > 0;
}

function nextV3() {
  const projectValidation = runValidator("validate_incremental_project.mjs", [projectFile]);
  if (!projectValidation.pass) blockedFromValidation("incremental project", projectValidation);

  const contextFile = resolveEntry(projectFile, project.context);
  const deltaFile = resolveEntry(projectFile, project.delta);
  const indexFile = resolveEntry(projectFile, project.artifactIndex);
  for (const [label, file] of [
    ["project context", contextFile],
    ["version delta", deltaFile],
    ["artifact index", indexFile],
  ]) {
    if (!fileReady(file)) {
      emit({
        schemaVersion: "1.0",
        status: "blocked",
        project: project.projectId,
        workflow: "incremental",
        currentState: "input_missing",
        nextAction: action(
          "restore_input",
          "blocked",
          `恢复或重建 ${label}`,
          null,
          { owner: "agent", safeToAutoExecute: false },
        ),
        diagnostics: [diagnostic("KACHA-E100", `${label} 不存在：${file}`)],
      }, 1);
    }
  }

  const validations = [
    ["project context", "validate_project_context.mjs", [contextFile]],
    ["version delta", "validate_version_delta.mjs", [deltaFile]],
    ["artifact index", "validate_artifact_index.mjs", [indexFile]],
  ];
  for (const [label, script, scriptArgs] of validations) {
    const result = runValidator(script, scriptArgs);
    if (!result.pass) blockedFromValidation(label, result);
  }

  const delta = readJson(deltaFile);
  const planFile = resolveEntry(projectFile, project.outputs?.incrementalPlan);
  let planCurrent = false;
  if (fileReady(planFile)) {
    try {
      const plan = readJson(planFile);
      planCurrent = plan.inputHashes?.projectContext === sha256File(contextFile)
        && plan.inputHashes?.versionDelta === sha256File(deltaFile)
        && plan.inputHashes?.artifactIndex === sha256File(indexFile);
    } catch {
      planCurrent = false;
    }
  }
  if (!planCurrent) {
    return action(
      "build_incremental_plan",
      "contract_ready",
      "生成或刷新确定性增量计划",
      [
        process.execPath,
        path.join(scriptsDirectory, "kacha.mjs"),
        "gate-plan",
        projectFile,
      ],
      {
        owner: "agent",
        safeToAutoExecute: true,
        expectedOutput: planFile,
      },
    );
  }

  const missingDeliverables = [];
  let candidateVideo = null;
  if (delta.deliverables?.video) {
    candidateVideo = resolveEntry(deltaFile, delta.newVersion?.outputPath);
    if (!fileReady(candidateVideo)) missingDeliverables.push(candidateVideo);
  }
  for (const item of delta.deliverables?.covers ?? []) {
    const file = resolveEntry(deltaFile, item.path);
    if (!fileReady(file)) missingDeliverables.push(file);
  }
  for (const item of delta.deliverables?.subtitles ?? []) {
    const file = resolveEntry(deltaFile, item.path);
    if (!fileReady(file)) missingDeliverables.push(file);
  }
  if (missingDeliverables.length > 0) {
    return action(
      "render_changed_layers",
      "plan_ready",
      "按 incrementalPlan 只渲染变化层并生成独立候选文件",
      null,
      {
        owner: "render_engine",
        safeToAutoExecute: false,
        preflightCommand: shellCommand([
          process.execPath,
          path.join(scriptsDirectory, "kacha.mjs"),
          "gate-render",
          projectFile,
        ]),
        plan: planFile,
        missingDeliverables,
        diagnostics: [diagnostic(
          "KACHA-E200",
          `缺少 ${missingDeliverables.length} 个候选交付物`,
        )],
      },
    );
  }

  const qcFile = resolveEntry(projectFile, project.outputs?.deltaQcReport);
  let qcCurrent = false;
  if (fileReady(qcFile)) {
    try {
      const qc = readJson(qcFile);
      const outputIdentityCurrent = !candidateVideo
        || (
          qc.output?.sha256
          && (
            (qc.output?.sizeBytes && fastIdentityMatches(candidateVideo, qc.output))
            || qc.output.sha256 === sha256File(candidateVideo)
          )
        );
      const deliverablesCurrent = (qc.deliverableEvidence ?? []).every(
        (item) => fileReady(item.path)
          && (
            (item.sizeBytes && fastIdentityMatches(item.path, item))
            || (item.sha256 && item.sha256 === sha256File(item.path))
          ),
      );
      qcCurrent = qc.contextSha256 === sha256File(contextFile)
        && qc.deltaSha256 === sha256File(deltaFile)
        && qc.artifactIndexSha256 === sha256File(indexFile)
        && outputIdentityCurrent
        && deliverablesCurrent
        && ["pass", "pass_with_review"].includes(qc.status);
    } catch {
      qcCurrent = false;
    }
  }
  if (!qcCurrent) {
    return action(
      "run_delta_qc",
      "candidate_rendered",
      "对当前候选执行增量技术 QC 和冻结层哈希证明",
      [
        process.execPath,
        path.join(scriptsDirectory, "kacha.mjs"),
        "qc",
        projectFile,
      ],
      {
        owner: "agent",
        safeToAutoExecute: true,
        expectedOutput: qcFile,
        diagnostics: [diagnostic("KACHA-E210", "当前 delta QC 缺失、失败或已过期")],
      },
    );
  }

  const reviewFile = resolveEntry(
    projectFile,
    project.outputs?.reviewReport ?? delta.reviewReportPath,
  );
  if (!fileReady(reviewFile)) {
    return action(
      "create_review_checklist",
      "technical_qc_ready",
      "从当前 plan/QC 生成动态人工审片清单",
      command("create_incremental_review.mjs", [projectFile]),
      {
        owner: "agent",
        safeToAutoExecute: true,
        expectedOutput: reviewFile,
      },
    );
  }

  let review;
  try {
    review = readJson(reviewFile);
  } catch (error) {
    return action(
      "repair_review",
      "review_invalid",
      "修复无法解析的人工审片文件",
      null,
      {
        owner: "human",
        safeToAutoExecute: false,
        diagnostics: [diagnostic("KACHA-E300", error.message)],
      },
    );
  }
  const incomplete = Object.entries(review.manualChecks ?? {})
    .filter(([, value]) => value?.status !== "pass" || !hasValue(value?.evidence))
    .map(([id]) => id);
  if (incomplete.length > 0) {
    return action(
      "complete_human_review",
      "awaiting_human_review",
      "正常速度审片并填写真实证据",
      null,
      {
        owner: "human",
        safeToAutoExecute: false,
        reviewFile,
        incompleteChecks: incomplete,
        diagnostics: [diagnostic(
          "KACHA-E300",
          `仍有 ${incomplete.length} 项人工检查未通过`,
        )],
      },
    );
  }

  if (delta.newVersion?.intent === "preview") {
    return action(
      "request_preview_feedback",
      "preview_ready",
      "预览已具备当前层证据，等待参数反馈；不得称为发布成片",
      null,
      { owner: "human", safeToAutoExecute: false },
    );
  }
  const gate = delta.newVersion?.intent === "release_candidate"
    ? "gate-release"
    : "gate-candidate";
  return action(
    gate.replace("-", "_"),
    "review_ready",
    gate === "gate-release"
      ? "执行当前最终版本完整发布门禁"
      : "执行候选门禁，保留继续返工能力",
    [
      process.execPath,
      path.join(scriptsDirectory, "kacha.mjs"),
      gate,
      projectFile,
    ],
    {
      owner: "agent",
      safeToAutoExecute: true,
      completionBoundary: gate === "gate-release"
        ? "local_release_ready"
        : "candidate_ready",
    },
  );
}

function nextV2() {
  if (project.schemaVersion !== "2.0") {
    blockedFromValidation("project schema", {
      pass: false,
      stdout: "",
      stderr: `schemaVersion 不支持：${project.schemaVersion}`,
    });
  }
  const proposalFile = resolveEntry(projectFile, project.plans?.proposal);
  const editPlanFile = resolveEntry(projectFile, project.plans?.editPlan);
  for (const [label, script, file] of [
    ["edit proposal", "validate_edit_proposal.mjs", proposalFile],
    ["edit plan", "validate_edit_plan.mjs", editPlanFile],
  ]) {
    if (!fileReady(file)) {
      blockedFromValidation(label, {
        pass: false,
        stdout: "",
        stderr: `${label} 不存在：${file}`,
      });
    }
    const result = runValidator(script, [file]);
    if (!result.pass) blockedFromValidation(label, result);
  }
  const finalVideo = resolveEntry(projectFile, project.outputs?.finalVideo);
  if (!fileReady(finalVideo)) {
    const netstyleTimelines = (project.plans?.netstyleTimelines ?? [])
      .map((entry) => resolveEntry(projectFile, entry))
      .filter(Boolean);
    const visualBreathingTimelines = (
      project.plans?.visualBreathingTimelines ?? []
    ).map((entry) => resolveEntry(projectFile, entry)).filter(Boolean);
    const captionTimelines = (project.plans?.captionTimelines ?? [])
      .map((entry) => resolveEntry(projectFile, entry))
      .filter(Boolean);
    return action(
      "render_full_timeline",
      "plan_ready",
      "先通过 render gate，再按冻结方案渲染独立完整候选",
      null,
      {
        owner: "render_engine",
        safeToAutoExecute: false,
        preflightCommand: shellCommand([
          process.execPath,
          path.join(scriptsDirectory, "kacha.mjs"),
          "gate-render",
          projectFile,
        ]),
        expectedOutput: finalVideo,
        visualPackaging: {
          netstyleTimelines,
          visualBreathingTimelines,
          captionTimelines,
          instruction: [
            netstyleTimelines.length > 0
              ? "画面锁定后执行 netstyle render-plan"
              : null,
            visualBreathingTimelines.length > 0
              ? "按计划执行 breathing render，并在字幕前完成画面呼吸"
              : null,
            captionTimelines.length > 0
              ? "按计划执行 captions render，并在最终混音前完成字幕排版"
              : null,
          ].filter(Boolean).join("；") || "当前项目没有注册视觉包装时间线计划",
          commandTemplates: {
            netstyle: netstyleTimelines.length > 0
              ? shellCommand([
              process.execPath,
              path.join(scriptsDirectory, "kacha.mjs"),
              "netstyle",
              "render-plan",
              "--plan",
              "PLAN.json",
              "--output",
              "VISUAL_PACKAGED.mov",
            ])
              : null,
            visualBreathing: visualBreathingTimelines.length > 0
              ? shellCommand([
                process.execPath,
                path.join(scriptsDirectory, "kacha.mjs"),
                "breathing",
                "render",
                "--plan",
                "BREATHING_PLAN.json",
                "--output",
                "BREATHING.mov",
              ])
              : null,
            captions: captionTimelines.length > 0
              ? shellCommand([
                process.execPath,
                path.join(scriptsDirectory, "kacha.mjs"),
                "captions",
                "render",
                "--plan",
                "CAPTION_PLAN.json",
                "--output",
                "CAPTIONED.mov",
              ])
              : null,
          },
        },
        diagnostics: [diagnostic("KACHA-E200", `最终候选不存在：${finalVideo}`)],
      },
    );
  }
  const qcFile = resolveEntry(projectFile, project.outputs?.technicalQcReport);
  let qcCurrent = false;
  if (fileReady(qcFile)) {
    try {
      const qc = readJson(qcFile);
      const recordedSha = qc.output?.sha256 ?? qc.sha256;
      const recordedIdentity = qc.output?.sizeBytes
        ? qc.output
        : qc.fileIdentity;
      qcCurrent = recordedSha
        && (
          (recordedIdentity?.sizeBytes && fastIdentityMatches(finalVideo, recordedIdentity))
          || recordedSha === sha256File(finalVideo)
        )
        && ["pass", "pass_with_review"].includes(qc.status);
    } catch {
      qcCurrent = false;
    }
  }
  if (!qcCurrent) {
    return action(
      "run_full_qc",
      "candidate_rendered",
      "对当前完整候选执行技术 QC",
      [
        process.execPath,
        path.join(scriptsDirectory, "kacha.mjs"),
        "qc",
        projectFile,
      ],
      {
        owner: "agent",
        safeToAutoExecute: true,
        expectedOutput: qcFile,
        diagnostics: [diagnostic("KACHA-E210", "当前技术 QC 缺失或不属于当前视频")],
      },
    );
  }
  const releaseFile = resolveEntry(projectFile, project.outputs?.releaseReport);
  if (!fileReady(releaseFile)) {
    return action(
      "complete_release_review",
      "technical_qc_ready",
      "完成十一项当前版本人工审片并创建 release report",
      null,
      {
        owner: "human",
        safeToAutoExecute: false,
        expectedOutput: releaseFile,
        diagnostics: [diagnostic("KACHA-E300", "release report 尚未创建")],
      },
    );
  }
  return action(
    "gate_release",
    "review_ready",
    "执行当前完整版本发布门禁",
    [
      process.execPath,
      path.join(scriptsDirectory, "kacha.mjs"),
      "gate-release",
      projectFile,
    ],
    {
      owner: "agent",
      safeToAutoExecute: true,
      completionBoundary: "local_release_ready",
    },
  );
}

const nextAction = project.schemaVersion === "3.0" ? nextV3() : nextV2();
emit({
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  status: nextAction.state === "blocked" ? "blocked" : "ready",
  project: project.projectId ?? null,
  workflow: project.schemaVersion === "3.0" ? "incremental" : "full",
  currentState: nextAction.state,
  nextAction,
  rule: "一次只执行 nextAction；执行完成后重新运行 next，不自行跳级。",
});
