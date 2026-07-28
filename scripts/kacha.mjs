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
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs doctor [--profile core|claude-vision|full]\n"
      + "  kacha.mjs config show|validate|get|init [options]\n"
      + "  kacha.mjs prepare --task TASK [--modules a,b] [--agent codex|claude]\n"
      + "  kacha.mjs next <project-manifest.json>\n"
      + "  kacha.mjs compile-change <change-request.json> [--output-dir DIR]\n"
      + "  kacha.mjs visual-evidence <video> --output-dir DIR [--mode fast|review|release]\n"
      + "  kacha.mjs vision-enrich <visual-evidence.json> --context CONTEXT --allow-external-upload\n"
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

function invoke(script, args) {
  const result = run(process.execPath, [path.join(scriptDirectory, script), ...args]);
  if (result.stdout.trim()) process.stdout.write(`${result.stdout.trim()}\n`);
  if (result.status !== 0) {
    if (result.stderr.trim()) process.stderr.write(`${result.stderr.trim()}\n`);
    process.exit(result.status ?? 1);
  }
}

const [, , command, projectInput, ...remainingArguments] = process.argv;
const delegatedCommands = {
  doctor: "kacha_doctor.mjs",
  config: "kacha_config.mjs",
  prepare: "prepare_agent_packet.mjs",
  next: "next_action.mjs",
  "compile-change": "compile_change_request.mjs",
  "visual-evidence": "build_visual_evidence.mjs",
  "vision-enrich": "enrich_visual_evidence_minimax.mjs",
};
if (Object.hasOwn(delegatedCommands, command)) {
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
