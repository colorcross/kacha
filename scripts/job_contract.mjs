#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolveContainedPath } from "./agent_workspace_utils.mjs";
import { sha256Value } from "./kacha_utils.mjs";

export function jobSubmissionDigest(value) {
  return sha256Value({
    schemaVersion: value.schemaVersion,
    id: value.id,
    ref: value.ref,
    kind: value.kind,
    createdAt: value.createdAt,
    projectRoot: value.projectRoot,
    command: value.command,
    expectedOutputs: value.expectedOutputs,
    allowNoOutput: value.allowNoOutput,
    placeholder: value.placeholder,
    logs: value.logs,
    runtimePidFile: value.runtimePidFile,
  });
}

export function validateJobContract(jobFile, value) {
  const errors = [];
  const resolvedJobFile = path.resolve(jobFile);
  const jobDirectory = path.dirname(resolvedJobFile);
  const id = path.basename(jobDirectory);
  const derivedProject = path.resolve(jobDirectory, "..", "..", "..");
  let projectRoot = null;
  try {
    if (!fs.lstatSync(resolvedJobFile).isFile()) {
      errors.push("job.json 不能是符号链接或非普通文件");
    }
    projectRoot = fs.realpathSync(derivedProject);
  } catch (error) {
    errors.push(`无法解析任务所属项目：${error.message}`);
  }
  if (value.schemaVersion !== "1.0" || value.id !== id || value.ref !== `@job:${id}`) {
    errors.push("job schema/id/ref 与任务目录不一致");
  }
  if (value.submissionDigest !== jobSubmissionDigest(value)) {
    errors.push("job submissionDigest 已失效，拒绝使用被修改的任务合同");
  }
  if (projectRoot) {
    try {
      if (fs.realpathSync(value.projectRoot ?? "") !== projectRoot) {
        errors.push("job.projectRoot 与任务目录所属项目不一致");
      }
    } catch {
      errors.push("job.projectRoot 不存在或不可解析");
    }
    const exactPaths = [
      [value.placeholder?.path, path.join(projectRoot, ".kacha", "placeholders", `${id}.json`), "placeholder"],
      [value.runtimePidFile, path.join(jobDirectory, "worker.pid"), "runtimePidFile"],
      [value.logs?.stdout, path.join(jobDirectory, "stdout.log"), "stdout log"],
      [value.logs?.stderr, path.join(jobDirectory, "stderr.log"), "stderr log"],
    ];
    for (const [actual, expected, label] of exactPaths) {
      if (path.resolve(actual ?? "") !== path.resolve(expected)) {
        errors.push(`${label} 路径与任务目录不一致`);
      }
    }
    try {
      const cwd = resolveContainedPath(projectRoot, value.command?.cwd, { allowMissing: false });
      if (!fs.statSync(cwd).isDirectory()) errors.push("job command cwd 不是目录");
    } catch (error) {
      errors.push(`job command cwd 越界或不存在：${error.message}`);
    }
    if (!Array.isArray(value.expectedOutputs)) {
      errors.push("job expectedOutputs 必须是数组");
    } else {
      for (const output of value.expectedOutputs) {
        try {
          resolveContainedPath(projectRoot, output);
        } catch (error) {
          errors.push(`expected output 越出项目：${error.message}`);
        }
      }
    }
  }
  const argv = value.command?.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== "string")) {
    errors.push("job command argv 无效");
  } else if (value.command.argvDigest !== sha256Value(argv)) {
    errors.push("job command argvDigest 已失效，拒绝执行被修改的命令");
  }
  if (value.command?.shell !== false) errors.push("job command 必须保持 shell=false");
  if (Array.isArray(value.expectedOutputs) && value.expectedOutputs.length === 0 && value.allowNoOutput !== true) {
    errors.push("job 缺少预期产物合同");
  }
  return errors;
}
