#!/usr/bin/env node

import os from "node:os";
import {
  handoffContentProject,
  initializeProject,
  projectStatus,
  runProject,
  validateRecipeRegistry,
} from "./project_orchestrator.mjs";
import { option } from "./agent_workspace_utils.mjs";

const args = process.argv.slice(2);
const action = args[0];

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs start --brief BRIEF [--project-root DIR] [--confirm-execute]\n"
      + "  kacha.mjs start --source VIDEO --project-root DIR [options]\n"
      + "  kacha.mjs start --script FILE|--topic TEXT --task content_generation --project-root DIR\n"
      + "  kacha.mjs run PROJECT [--confirm-execute] [--include-render]\n"
      + "  kacha.mjs resume PROJECT [--confirm-execute] [--include-render]\n"
      + "  kacha.mjs handoff PROJECT --source VIDEO --confirm-content-approved [options]\n"
      + "  kacha.mjs status PROJECT\n"
      + "  kacha.mjs workflow validate",
  );
  process.exit(2);
}

function emit(value, exitCode = 0) {
  console.log(JSON.stringify(value, null, 2));
  process.exit(exitCode);
}

try {
  if (action === "start") {
    emit(initializeProject({
      briefPath: option(args, "--brief"),
      source: option(args, "--source"),
      script: option(args, "--script"),
      topic: option(args, "--topic"),
      projectRoot: option(args, "--project-root"),
      projectId: option(args, "--project-id"),
      task: option(args, "--task"),
      show: option(args, "--show", "tool-share"),
      style: option(args, "--style", "light-warm-overlay"),
      platform: option(args, "--platform", "general"),
      language: option(args, "--language", "zh"),
      confirmExecute: args.includes("--confirm-execute"),
      development: args.includes("--development"),
      home: option(args, "--home", os.homedir()),
    }));
  }
  if (["run", "resume"].includes(action)) {
    const project = args[1];
    if (!project || project.startsWith("--")) usage();
    emit(runProject(project, {
      confirmExecute: args.includes("--confirm-execute"),
      includeRender: args.includes("--include-render"),
      acceptRuntimeUpdate: args.includes("--accept-runtime-update"),
      resume: action === "resume",
      home: option(args, "--home", os.homedir()),
    }));
  }
  if (action === "handoff") {
    const project = args[1];
    const source = option(args, "--source");
    if (!project || project.startsWith("--") || !source) usage();
    emit(handoffContentProject(project, source, {
      targetRoot: option(args, "--project-root"),
      confirmContentApproved: args.includes("--confirm-content-approved"),
      confirmExecute: args.includes("--confirm-execute"),
      development: args.includes("--development"),
      home: option(args, "--home", os.homedir()),
    }));
  }
  if (action === "status") {
    const project = args[1];
    if (!project || project.startsWith("--")) usage();
    const report = projectStatus(project, {
      home: option(args, "--home", os.homedir()),
    });
    emit(report, report.status === "blocked" ? 1 : 0);
  }
  if (action === "validate") emit(validateRecipeRegistry());
  usage();
} catch (error) {
  emit({
    schemaVersion: "1.0",
    status: "blocked",
    diagnostics: [{ code: "KACHA-E500", detail: error.message }],
  }, 1);
}
