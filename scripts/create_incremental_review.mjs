#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  readJson,
  resolveFrom,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const [, , input] = process.argv;
if (!input) {
  console.error("用法：create_incremental_review.mjs <incremental-project.json>");
  process.exit(2);
}

const projectFile = path.resolve(input);
let project;
let delta;
let plan;
let qc;
try {
  project = readJson(projectFile);
  delta = readJson(resolveFrom(projectFile, project.delta));
  plan = readJson(resolveFrom(projectFile, project.outputs.incrementalPlan));
  qc = readJson(resolveFrom(projectFile, project.outputs.deltaQcReport));
} catch (error) {
  console.error(`无法读取 review 模板输入：${error.message}`);
  process.exit(2);
}
if (!["pass", "pass_with_review"].includes(qc.status)) {
  console.error(`delta QC 尚未通过：${qc.status}`);
  process.exit(1);
}

const outputFile = resolveFrom(projectFile, project.outputs.reviewReport);
if (fs.existsSync(outputFile)) {
  console.error(`拒绝覆盖已有人工审片报告：${outputFile}`);
  process.exit(2);
}
const manualChecks = [...plan.qcProfile.manualChecks];
if (
  qc.status === "pass_with_review"
  && !manualChecks.includes("technicalFindingsDisposition")
) {
  manualChecks.push("technicalFindingsDisposition");
}
const report = {
  schemaVersion: "3.0",
  projectId: project.projectId,
  versionId: delta.newVersion.id,
  intent: delta.newVersion.intent,
  status: "not_reviewed",
  reviewedAt: "replace-after-review",
  reviewer: "replace-with-reviewer",
  outputSha256: qc.output?.sha256 ?? qc.deliverableDigest,
  limitations: ["列出当前候选限制；没有时明确写 none。"],
  manualChecks: Object.fromEntries(
    manualChecks.map((id) => [
      id,
      { status: "pending", evidence: [] },
    ]),
  ),
};
writeJsonAtomic(outputFile, report);
console.log(
  JSON.stringify(
    {
      status: "pass",
      output: outputFile,
      intent: delta.newVersion.intent,
      manualChecks,
      nextStatus: delta.newVersion.intent === "release_candidate"
        ? "approved_local_release"
        : "approved_candidate",
    },
    null,
    2,
  ),
);
