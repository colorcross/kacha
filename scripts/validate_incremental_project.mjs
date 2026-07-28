#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  hasValue,
  readJson,
  resolveFrom,
} from "./kacha_utils.mjs";

const [, , input, ...rest] = process.argv;
const template = rest.includes("--template");
if (!input) {
  console.error(
    "用法：validate_incremental_project.mjs <incremental-project.json> [--template]",
  );
  process.exit(2);
}

const projectFile = path.resolve(input);
let project;
try {
  project = readJson(projectFile);
} catch (error) {
  console.error(`无法读取 incremental project：${error.message}`);
  process.exit(2);
}

const errors = [];
if (project.schemaVersion !== "3.0") errors.push("schemaVersion 必须为 3.0");
if (project.workflow !== "incremental") errors.push("workflow 必须为 incremental");
for (const field of [
  "projectId",
  "context",
  "delta",
  "artifactIndex",
  "outputs",
]) {
  if (!hasValue(project[field])) errors.push(`project 缺少 ${field}`);
}
if (!Array.isArray(project.requiredCapabilities)) {
  errors.push("requiredCapabilities 必须是数组，可以为空");
}
for (const field of ["incrementalPlan", "deltaQcReport", "reviewReport"]) {
  if (!hasValue(project.outputs?.[field])) {
    errors.push(`outputs 缺少 ${field}`);
  }
}

if (!template) {
  const loaded = {};
  for (const [field, label] of [
    ["context", "project context"],
    ["delta", "version delta"],
    ["artifactIndex", "artifact index"],
  ]) {
    const file = resolveFrom(projectFile, project[field]);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      errors.push(`${label} 不存在：${file ?? project[field]}`);
      continue;
    }
    try {
      loaded[field] = readJson(file);
    } catch (error) {
      errors.push(`${label} 无法解析：${error.message}`);
    }
  }
  if (
    loaded.context?.projectId
    && loaded.context.projectId !== project.projectId
  ) {
    errors.push("context.projectId 与 project.projectId 不一致");
  }
  if (
    loaded.artifactIndex?.projectId
    && loaded.artifactIndex.projectId !== project.projectId
  ) {
    errors.push("artifactIndex.projectId 与 project.projectId 不一致");
  }
  if (
    loaded.delta?.projectContext
    && resolveFrom(
      resolveFrom(projectFile, project.delta),
      loaded.delta.projectContext,
    ) !== resolveFrom(projectFile, project.context)
  ) {
    errors.push("delta.projectContext 与 project.context 不一致");
  }
  if ((project.requiredCapabilities ?? []).length > 0) {
    const capabilityFile = resolveFrom(projectFile, project.capabilityManifest);
    if (!hasValue(project.capabilityManifest) || !fs.existsSync(capabilityFile ?? "")) {
      errors.push("requiredCapabilities 非空时必须提供有效 capabilityManifest");
    }
  }
}

if (errors.length > 0) {
  console.error(`incremental project 检查失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      file: projectFile,
      projectId: project.projectId,
      template,
      requiredCapabilities: project.requiredCapabilities,
    },
    null,
    2,
  ),
);
