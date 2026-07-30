#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  loadOrInitializeV2State,
  recordV2Stage,
  V2_STAGE_IDS,
} from "./workflow_state.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function snapshot(projectFile, output) {
  const project = readJson(projectFile);
  if (project.schemaVersion === "2.0") {
    const initialized = loadOrInitializeV2State(projectFile, output);
    const next = run(process.execPath, [
      path.join(scriptDirectory, "next_action.mjs"),
      projectFile,
    ]);
    let nextAction = null;
    let issues = [];
    try {
      const parsed = JSON.parse(next.stdout);
      nextAction = parsed.nextAction ?? null;
      issues = parsed.diagnostics ?? [];
    } catch {
      issues = [{ code: "KACHA-E500", detail: next.stderr.trim() }];
    }
    const stable = {
      ...initialized.state,
      issues,
      nextAction,
      currentState: nextAction?.state ?? "unknown",
      completionBoundary: nextAction?.completionBoundary ?? null,
    };
    delete stable.digest;
    delete stable.updatedAt;
    stable.digest = sha256Value(stable);
    const report = { ...stable, updatedAt: new Date().toISOString() };
    writeJsonAtomic(output, report);
    return report;
  }
  const next = run(process.execPath, [
    path.join(scriptDirectory, "next_action.mjs"),
    projectFile,
  ]);
  let nextAction;
  try {
    nextAction = JSON.parse(next.stdout);
  } catch {
    nextAction = {
      status: "blocked",
      diagnostics: [{
        code: "KACHA-E500",
        detail: next.stderr.trim() || "next action 无法解析",
      }],
    };
  }
  let previous = null;
  if (fs.existsSync(output)) {
    try {
      previous = readJson(output);
    } catch {
      previous = null;
    }
  }
  const stable = {
    schemaVersion: "1.0",
    kind: "kacha_project_state",
    projectId: project.projectId,
    project: fileIdentity(projectFile),
    workflow: project.schemaVersion === "3.0" ? "incremental" : "full",
    stages: previous?.projectId === project.projectId
      ? previous.stages ?? {}
      : {},
    decisions: previous?.projectId === project.projectId
      ? previous.decisions ?? []
      : [],
    issues: nextAction.diagnostics ?? [],
    nextAction: nextAction.nextAction ?? null,
    currentState: nextAction.currentState ?? "unknown",
    completionBoundary: nextAction.nextAction?.completionBoundary ?? null,
  };
  stable.digest = sha256Value(stable);
  const report = { ...stable, updatedAt: new Date().toISOString() };
  writeJsonAtomic(output, report);
  return report;
}

if (action === "snapshot") {
  const projectInput = args[1];
  if (!projectInput) {
    fail("用法：kacha.mjs state snapshot PROJECT.json [--output STATE.json]", 2);
  }
  const projectFile = path.resolve(projectInput);
  if (!fs.existsSync(projectFile) || !fs.statSync(projectFile).isFile()) {
    fail(`项目不存在：${projectFile}`, 2);
  }
  const output = path.resolve(
    option("--output", path.join(path.dirname(projectFile), ".kacha", "project-state.json")),
  );
  const report = snapshot(projectFile, output);
  console.log(JSON.stringify({
    status: "pass",
    output,
    digest: report.digest,
    currentState: report.currentState,
    nextAction: report.nextAction,
  }, null, 2));
  process.exit(0);
}

if (action !== "record") {
  fail(
    "用法：kacha.mjs state snapshot PROJECT.json [--output STATE.json]\n"
      + "  kacha.mjs state record STATE.json --stage STAGE "
      + "--status complete|blocked --evidence FILE [--decision TEXT]",
    2,
  );
}
const stateInput = args[1];
const stage = option("--stage");
const status = option("--status");
const evidenceFile = option("--evidence");
if (
  !stateInput
  || ![
    ...V2_STAGE_IDS,
    "content",
    "edit",
    "visual_audio",
    "release",
  ].includes(stage)
  || !["complete", "blocked"].includes(status)
  || !evidenceFile
) {
  fail("state record 参数无效", 2);
}
const stateFile = path.resolve(stateInput);
const evidence = path.resolve(evidenceFile);
if (
  !fs.existsSync(stateFile)
  || !fs.statSync(stateFile).isFile()
  || !fs.existsSync(evidence)
  || !fs.statSync(evidence).isFile()
) {
  fail("state 或 evidence 文件不存在", 2);
}
const state = readJson(stateFile);
if (state.kind !== "kacha_project_state") fail("state 文件类型无效", 2);
if (state.schemaVersion === "2.0" && V2_STAGE_IDS.includes(stage)) {
  try {
    const recorded = recordV2Stage({
      stateFile,
      stage,
      status,
      evidenceFile: evidence,
      decision: option("--decision"),
    });
    console.log(JSON.stringify({
      status: "pass",
      output: stateFile,
      stage,
      stageStatus: status,
      digest: recorded.digest,
    }, null, 2));
    process.exit(0);
  } catch (error) {
    fail(error.message, 1);
  }
}
state.stages = {
  ...state.stages,
  [stage]: {
    status,
    recordedAt: new Date().toISOString(),
    evidence: fileIdentity(evidence),
  },
};
const decision = option("--decision");
if (decision) {
  state.decisions = [
    ...(state.decisions ?? []),
    {
      stage,
      text: decision,
      evidenceSha256: sha256File(evidence),
    },
  ];
}
delete state.digest;
delete state.updatedAt;
state.digest = sha256Value(state);
state.updatedAt = new Date().toISOString();
writeJsonAtomic(stateFile, state);
console.log(JSON.stringify({
  status: "pass",
  output: stateFile,
  stage,
  stageStatus: status,
  digest: state.digest,
}, null, 2));
