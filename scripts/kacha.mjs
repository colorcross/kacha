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
      + "  kacha.mjs gate-plan <project-manifest.json>\n"
      + "  kacha.mjs gate-render <project-manifest.json>\n"
      + "  kacha.mjs qc <project-manifest.json>\n"
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

function invoke(script, args) {
  const result = run(process.execPath, [path.join(scriptDirectory, script), ...args]);
  if (result.stdout.trim()) process.stdout.write(`${result.stdout.trim()}\n`);
  if (result.status !== 0) {
    if (result.stderr.trim()) process.stderr.write(`${result.stderr.trim()}\n`);
    process.exit(result.status ?? 1);
  }
}

const [, , command, projectInput] = process.argv;
if (
  !["gate-plan", "gate-render", "qc", "gate-release"].includes(command)
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
if (project.schemaVersion !== "2.0") {
  console.error("project schemaVersion 必须为 2.0");
  process.exit(1);
}
for (const field of [
  "projectId",
  "plans",
  "outputs",
  "expectedMedia",
  "requiredCoverAspectRatios",
]) {
  if (!hasValue(project[field])) {
    console.error(`project 缺少 ${field}`);
    process.exit(1);
  }
}

function gatePlan() {
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

if (command === "gate-plan") {
  gatePlan();
} else if (command === "gate-render") {
  gatePlan();
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
} else if (command === "qc") {
  invoke("qc_media.mjs", [projectFile]);
} else if (command === "gate-release") {
  gatePlan();
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
