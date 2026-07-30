#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  daysBetween,
  hasValue,
  readJson,
  resolveFrom,
  run,
  sha256File,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs doctor [--profile core|claude-vision|full]\n"
      + "  kacha.mjs config show|validate|get|init [options]\n"
      + "  kacha.mjs design validate|list|show|resolve|preview|render|qc [options]\n"
      + "  kacha.mjs styleframe render --scene ID --output FILE [options]\n"
      + "  kacha.mjs beauty validate|show|authorize|render|qc [options]\n"
      + "  kacha.mjs effects list|show|validate|preview [options]\n"
      + "  kacha.mjs fonts scan|validate|resolve|preview [options]\n"
      + "  kacha.mjs captions plan|validate|render [options]\n"
      + "  kacha.mjs breathing plan|validate|render [options]\n"
      + "  kacha.mjs studio catalog|validate|probe|save-style|compile|serve [options]\n"
      + "  kacha.mjs netstyle list|validate|preview|showcase [options]\n"
      + "  kacha.mjs netstyle plan|validate-plan|render-plan [options]\n"
      + "  kacha.mjs connections VIDEO --output connection-candidates.json\n"
      + "  kacha.mjs prepare --task TASK [--modules a,b] [--agent codex|claude]\n"
      + "  kacha.mjs next <project-manifest.json>\n"
      + "  kacha.mjs compile-change <change-request.json> [--output-dir DIR]\n"
      + "  kacha.mjs visual-evidence <video> --output-dir DIR [--mode fast|review|release]\n"
      + "  kacha.mjs vision-enrich <visual-evidence.json> --context CONTEXT --allow-external-upload\n"
      + "  kacha.mjs metrics run|summarize [options]\n"
      + "  kacha.mjs resources status|run [options]\n"
      + "  kacha.mjs cache key|run|inspect [options]\n"
      + "  kacha.mjs transcribe INPUT --output TRANSCRIPT.json [options]\n"
      + "  kacha.mjs transcript index|slice TRANSCRIPT.json [options]\n"
      + "  kacha.mjs masks INPUT --output-dir DIR [options]\n"
      + "  kacha.mjs generated-cache run --plan PLAN --shot ID --output VIDEO -- COMMAND\n"
      + "  kacha.mjs rules validate|query|compile|apply [options]\n"
      + "  kacha.mjs state snapshot|record [options]\n"
      + "  kacha.mjs golden real --video VIDEO --output-dir DIR [options]\n"
      + "  kacha.mjs optimization-audit run --golden-report FILE --test-report FILE "
        + "--asr-report FILE --install-report FILE\n"
      + "  kacha.mjs timeline validate|compile|render --plan TIMELINE.json [options]\n"
      + "  kacha.mjs render <project-manifest.json> [--mode preview|final]\n"
      + "  kacha.mjs gate-plan <project-manifest.json>\n"
      + "  kacha.mjs gate-render <project-manifest.json>\n"
      + "  kacha.mjs qc <project-manifest.json>\n"
      + "  kacha.mjs gate-candidate <incremental-project.json>\n"
      + "  kacha.mjs gate-release <project-manifest.json>",
  );
}

function entryPath(entry) {
  return typeof entry === "string" ? entry : entry?.path;
}

function requireProjectPath(projectFile, entry, label) {
  const candidate = entryPath(entry);
  if (!hasValue(candidate)) throw new Error(`${label} 缺少 path`);
  const resolved = resolveFrom(projectFile, candidate);
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error(`${label} 不存在：${resolved ?? candidate}`);
  }
  return resolved;
}

function projectPath(projectFile, entry, label) {
  const candidate = entryPath(entry);
  if (!hasValue(candidate)) throw new Error(`${label} 缺少 path`);
  return resolveFrom(projectFile, candidate);
}

function invoke(script, args, options = {}) {
  const result = run(
    process.execPath,
    [path.join(scriptDirectory, script), ...args],
    options,
  );
  if (result.stdout.trim()) process.stdout.write(`${result.stdout.trim()}\n`);
  if (result.status !== 0) {
    if (result.stderr.trim()) process.stderr.write(`${result.stderr.trim()}\n`);
    process.exit(result.status ?? 1);
  }
}

const [, , command, projectInput, ...remainingArguments] = process.argv;
if (
  command === "netstyle"
  && ["plan", "validate-plan", "render-plan"].includes(projectInput)
) {
  const timelineAction = {
    plan: "plan",
    "validate-plan": "validate",
    "render-plan": "render",
  }[projectInput];
  invoke("netstyle_timeline.mjs", [timelineAction, ...remainingArguments]);
  process.exit(0);
}
const delegatedCommands = {
  doctor: "kacha_doctor.mjs",
  config: "kacha_config.mjs",
  design: "kacha_design.mjs",
  styleframe: "render_styleframe_cached.mjs",
  beauty: "kacha_beauty.mjs",
  effects: "kacha_effects.mjs",
  fonts: "kacha_fonts.mjs",
  captions: "caption_layout.mjs",
  breathing: "visual_breathing.mjs",
  studio: "kacha_studio.mjs",
  netstyle: "kacha_netstyle.mjs",
  connections: "scan_connections.mjs",
  prepare: "prepare_agent_packet.mjs",
  next: "next_action.mjs",
  "compile-change": "compile_change_request.mjs",
  "visual-evidence": "build_visual_evidence.mjs",
  "vision-enrich": "enrich_visual_evidence_minimax.mjs",
  metrics: "run_telemetry.mjs",
  resources: "resource_scheduler.mjs",
  cache: "artifact_cache.mjs",
  transcribe: "transcribe_local.mjs",
  transcript: "transcript_window.mjs",
  masks: "generate_masks_cached.mjs",
  "generated-cache": "run_generated_media_cached.mjs",
  rules: "decision_rules.mjs",
  state: "project_state.mjs",
  golden: "golden_regression.mjs",
  "optimization-audit": "optimization_audit.mjs",
  timeline: "timeline_ir.mjs",
  render: "render_project.mjs",
};
if (Object.hasOwn(delegatedCommands, command)) {
  if (command === "studio" && projectInput === "serve") {
    invoke(
      delegatedCommands[command],
      [projectInput, ...remainingArguments],
      { stdio: "inherit" },
    );
    process.exit(0);
  }
  invoke(
    delegatedCommands[command],
    [projectInput, ...remainingArguments].filter((item) => item !== undefined),
  );
  process.exit(0);
}
if (
  !["gate-plan", "gate-render", "qc", "gate-candidate", "gate-release"].includes(command)
  || !projectInput
) {
  usage();
  process.exit(2);
}

const projectFile = path.resolve(projectInput);
let project;
try {
  project = readJson(projectFile);
} catch (error) {
  console.error(`无法读取项目 manifest：${error.message}`);
  process.exit(2);
}
if (!["2.0", "3.0"].includes(project.schemaVersion)) {
  console.error("project schemaVersion 必须为 2.0 或 3.0");
  process.exit(1);
}
if (project.schemaVersion === "2.0") {
  for (const field of ["projectId", "plans", "outputs", "expectedMedia"]) {
    if (!hasValue(project[field])) {
      console.error(`project 缺少 ${field}`);
      process.exit(1);
    }
  }
  if (!Array.isArray(project.requiredCoverAspectRatios)) {
    console.error("project.requiredCoverAspectRatios 必须是数组，可以为空");
    process.exit(1);
  }
}

function gatePlanV2() {
  const proposal = requireProjectPath(
    projectFile,
    project.plans.proposal,
    "plans.proposal",
  );
  const editPlan = requireProjectPath(
    projectFile,
    project.plans.editPlan,
    "plans.editPlan",
  );
  invoke("validate_edit_proposal.mjs", [proposal]);
  invoke("validate_edit_plan.mjs", [editPlan]);

  for (const entry of project.plans.netstyleTimelines ?? []) {
    const plan = requireProjectPath(
      projectFile,
      entry,
      "plans.netstyleTimelines",
    );
    invoke("netstyle_timeline.mjs", ["validate", "--plan", plan]);
  }

  for (const entry of project.plans.captionTimelines ?? []) {
    const plan = requireProjectPath(
      projectFile,
      entry,
      "plans.captionTimelines",
    );
    invoke("caption_layout.mjs", ["validate", "--plan", plan]);
  }

  for (const entry of project.plans.visualBreathingTimelines ?? []) {
    const plan = requireProjectPath(
      projectFile,
      entry,
      "plans.visualBreathingTimelines",
    );
    invoke("visual_breathing.mjs", ["validate", "--plan", plan]);
  }

  if (project.plans.timeline ?? project.plans.timelineIr) {
    const timeline = requireProjectPath(
      projectFile,
      project.plans.timeline ?? project.plans.timelineIr,
      "plans.timeline",
    );
    invoke("timeline_ir.mjs", ["validate", "--plan", timeline]);
    const timelinePlan = readJson(timeline);
    const proposalPlan = readJson(proposal);
    const editPlanIdentity = sha256File(editPlan);
    const proposalIdentity = sha256File(proposal);
    for (const [name, file, expected] of [
      ["proposal", proposal, proposalIdentity],
      ["editPlan", editPlan, editPlanIdentity],
    ]) {
      const contract = timelinePlan.contracts?.[name];
      const contractFile = contract
        ? resolveFrom(timeline, entryPath(contract))
        : null;
      if (
        !contractFile
        || path.resolve(contractFile) !== path.resolve(file)
        || contract.sha256 !== expected
      ) {
        console.error(
          `Timeline IR contracts.${name} 必须绑定当前项目文件及其真实 SHA-256`,
        );
        process.exit(1);
      }
    }
    const timelineAssets = [
      ...(timelinePlan.visual?.overlays ?? []),
      ...(timelinePlan.visual?.subtitles ? [timelinePlan.visual.subtitles] : []),
      ...(timelinePlan.audio?.dialogue ? [timelinePlan.audio.dialogue] : []),
      ...(timelinePlan.audio?.bgm ? [timelinePlan.audio.bgm] : []),
      ...(timelinePlan.audio?.sfx ?? []),
    ];
    for (const [index, asset] of timelineAssets.entries()) {
      const assetFile = resolveFrom(timeline, entryPath(asset));
      if (
        !assetFile
        || !asset.sha256
        || asset.sha256 !== sha256File(assetFile)
        || !hasValue(asset.provenance?.kind)
        || !hasValue(asset.provenance?.evidence)
      ) {
        console.error(
          `Timeline IR 外部素材[${index}] 必须记录真实 sha256 与 provenance.kind/evidence`,
        );
        process.exit(1);
      }
    }
    const timelineSource = resolveFrom(timeline, entryPath(timelinePlan.source));
    const approvedSources = new Set(
      (proposalPlan.sourceInventory ?? [])
        .map((entry) => resolveFrom(proposal, entryPath(entry)))
        .filter(Boolean)
        .map((entry) => path.resolve(entry)),
    );
    if (!timelineSource || !approvedSources.has(path.resolve(timelineSource))) {
      console.error("Timeline IR 的源视频不在 editProposal 已授权 sourceInventory 中");
      process.exit(1);
    }
    if (timelinePlan.mode !== "final") {
      console.error("登记到完整项目的 Timeline IR 必须声明 mode=final");
      process.exit(1);
    }
    const timelineOutput = resolveFrom(timeline, entryPath(timelinePlan.output));
    const projectOutput = projectPath(
      projectFile,
      project.outputs.finalVideo,
      "outputs.finalVideo",
    );
    if (path.resolve(timelineOutput) !== path.resolve(projectOutput)) {
      console.error("Timeline IR output.path 必须与 project.outputs.finalVideo.path 一致");
      process.exit(1);
    }
    for (const [field, expected] of [
      ["width", project.expectedMedia.width],
      ["height", project.expectedMedia.height],
      ["fps", project.expectedMedia.fps],
    ]) {
      if (
        Number.isFinite(Number(expected))
        && Number(timelinePlan.output?.[field]) !== Number(expected)
      ) {
        console.error(`Timeline IR output.${field} 与 project.expectedMedia.${field} 不一致`);
        process.exit(1);
      }
    }
    for (const [timelineField, projectField] of [
      ["dialogueStem", "dialogue"],
      ["bgmStem", "bgm"],
      ["sfxStem", "sfx"],
      ["mixStem", "mix"],
    ]) {
      const expectedEntry = project.outputs?.audioStems?.[projectField];
      if (!expectedEntry && !timelinePlan.output?.[timelineField]) continue;
      const timelineStem = resolveFrom(timeline, timelinePlan.output?.[timelineField]);
      const projectStem = projectPath(
        projectFile,
        expectedEntry,
        `outputs.audioStems.${projectField}`,
      );
      if (
        !timelineStem
        || !projectStem
        || path.resolve(timelineStem) !== path.resolve(projectStem)
      ) {
        console.error(
          `Timeline IR output.${timelineField} 必须与 outputs.audioStems.${projectField} 一致`,
        );
        process.exit(1);
      }
    }
    if (
      project.expectedMedia?.audioMix?.bgmRequired === true
      && (!timelinePlan.audio?.bgm || !timelinePlan.output?.mixStem)
    ) {
      console.error("项目要求 BGM 时，Timeline IR 必须声明 audio.bgm 与 output.mixStem");
      process.exit(1);
    }
  }

  if (project.plans.localChange) {
    const localChange = requireProjectPath(
      projectFile,
      project.plans.localChange,
      "plans.localChange",
    );
    const argumentsList = [localChange];
    if (
      typeof project.plans.localChange === "object"
      && project.plans.localChange.mode === "template"
    ) {
      argumentsList.push("--template");
    }
    invoke("validate_local_change_plan.mjs", argumentsList);
  }

  for (const entry of project.plans.generatedShotPlans ?? []) {
    const plan = requireProjectPath(projectFile, entry, "generatedShotPlans");
    const argumentsList = [plan];
    if (entry.mode === "template") argumentsList.push("--template");
    invoke("validate_generated_shot_plan.mjs", argumentsList);
  }
}

function validateCapabilities() {
  if ((project.requiredCapabilities ?? []).length === 0) {
    console.log(
      JSON.stringify(
        {
          status: "pass",
          capabilityManifest: null,
          requiredCapabilities: [],
          reused: true,
        },
        null,
        2,
      ),
    );
    return;
  }
  const capabilityFile = requireProjectPath(
    projectFile,
    project.capabilityManifest,
    "capabilityManifest",
  );
  const manifest = readJson(capabilityFile);
  const errors = [];
  if (manifest.schemaVersion !== "2.0") errors.push("能力 manifest schemaVersion 必须为 2.0");
  if (manifest.status !== "pass") errors.push("能力探测状态不是 pass");
  const generatedDate = String(manifest.generatedAt ?? "").slice(0, 10);
  const age = daysBetween(generatedDate);
  if (!Number.isFinite(age) || age < 0 || age > 2) {
    errors.push("能力探测结果必须在两天内生成");
  }
  const checks = new Map((manifest.checks ?? []).map((item) => [item.id, item]));
  for (const capability of project.requiredCapabilities ?? []) {
    if (checks.get(capability)?.available !== true) {
      errors.push(`项目所需能力不可用：${capability}`);
    }
  }
  if (errors.length > 0) {
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        status: "pass",
        capabilityManifest: capabilityFile,
        requiredCapabilities: project.requiredCapabilities ?? [],
      },
      null,
      2,
    ),
  );
}

function gatePlanV3() {
  invoke("validate_incremental_project.mjs", [projectFile]);
  const context = requireProjectPath(projectFile, project.context, "context");
  const delta = requireProjectPath(projectFile, project.delta, "delta");
  const artifactIndex = requireProjectPath(
    projectFile,
    project.artifactIndex,
    "artifactIndex",
  );
  const incrementalPlan = projectPath(
    projectFile,
    project.outputs.incrementalPlan,
    "outputs.incrementalPlan",
  );
  invoke("validate_project_context.mjs", [context]);
  invoke("validate_artifact_index.mjs", [artifactIndex]);
  invoke("validate_version_delta.mjs", [delta]);
  invoke("plan_incremental_build.mjs", [
    context,
    delta,
    artifactIndex,
    "--output",
    incrementalPlan,
  ]);
}

function gatePlan() {
  if (project.schemaVersion === "3.0") gatePlanV3();
  else gatePlanV2();
}

if (command === "gate-plan") {
  gatePlan();
} else if (command === "gate-render") {
  gatePlan();
  if (project.schemaVersion === "3.0") {
    const contextFile = requireProjectPath(projectFile, project.context, "context");
    const context = readJson(contextFile);
    if (context.authorization?.canExecute !== true) {
      console.error("project context 未授权执行，render gate 拒绝通过");
      process.exit(1);
    }
    validateCapabilities();
  } else {
    const proposalFile = requireProjectPath(
      projectFile,
      project.plans.proposal,
      "plans.proposal",
    );
    const proposal = readJson(proposalFile);
    if (proposal.authorization?.canExecute !== true) {
      console.error("方案未授权执行，render gate 拒绝通过");
      process.exit(1);
    }
    if (
      (project.plans.generatedShotPlans ?? []).length > 0
      && proposal.authorization?.paidGenerationAllowed !== true
    ) {
      console.error("项目包含生成镜头，但 editProposal 未授权付费生成");
      process.exit(1);
    }
    validateCapabilities();
    for (const entry of project.plans.generatedShotPlans ?? []) {
      const plan = requireProjectPath(projectFile, entry, "generatedShotPlans");
      invoke("validate_generated_shot_plan.mjs", [plan, "--for-execution"]);
    }
  }
} else if (command === "qc") {
  if (project.schemaVersion === "3.0") {
    gatePlanV3();
    invoke("qc_incremental.mjs", [projectFile, ...remainingArguments]);
  } else {
    invoke("qc_media.mjs", [projectFile, ...remainingArguments]);
  }
} else if (command === "gate-candidate") {
  if (project.schemaVersion !== "3.0") {
    console.error("gate-candidate 只适用于 schemaVersion 3.0 增量项目");
    process.exit(1);
  }
  gatePlanV3();
  invoke("validate_incremental_review.mjs", [
    projectFile,
    "--mode",
    "candidate",
  ]);
} else if (command === "gate-release") {
  gatePlan();
  if (project.schemaVersion === "3.0") {
    const context = requireProjectPath(projectFile, project.context, "context");
    const artifactIndex = requireProjectPath(
      projectFile,
      project.artifactIndex,
      "artifactIndex",
    );
    invoke("validate_project_context.mjs", [context, "--full-hash"]);
    invoke("validate_artifact_index.mjs", [artifactIndex, "--full-hash"]);
    invoke("validate_incremental_review.mjs", [
      projectFile,
      "--mode",
      "release",
    ]);
  } else {
    const proposalFile = requireProjectPath(
      projectFile,
      project.plans.proposal,
      "plans.proposal",
    );
    const proposal = readJson(proposalFile);
    if (proposal.authorization?.canExecute !== true) {
      console.error("方案未授权执行，release gate 拒绝通过");
      process.exit(1);
    }
    invoke("validate_release_report.mjs", [projectFile]);
  }
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      command,
      project: project.projectId,
      manifest: projectFile,
    },
    null,
    2,
  ),
);
