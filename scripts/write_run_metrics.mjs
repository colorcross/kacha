#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  readJson,
  resolveFrom,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

function numberOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const args = process.argv.slice(2);
const input = args.find((item) => !item.startsWith("--"));
const outputIndex = args.indexOf("--output");
if (!input || outputIndex < 0 || !args[outputIndex + 1]) {
  console.error(
    "用法：write_run_metrics.mjs incremental-project.json --output run-metrics.json "
      + "[--render-seconds N] [--qc-seconds N] [--test-seconds N] "
      + "[--prompt-characters N] [--input-tokens N] [--peak-bytes N]",
  );
  process.exit(2);
}

const projectFile = path.resolve(input);
const outputFile = path.resolve(args[outputIndex + 1]);
let project;
let context;
let delta;
let plan;
let qc = null;
try {
  project = readJson(projectFile);
  const contextFile = resolveFrom(projectFile, project.context);
  const deltaFile = resolveFrom(projectFile, project.delta);
  context = readJson(contextFile);
  delta = readJson(deltaFile);
  plan = readJson(resolveFrom(projectFile, project.outputs.incrementalPlan));
  const qcFile = resolveFrom(projectFile, project.outputs.deltaQcReport);
  if (qcFile && fs.existsSync(qcFile)) qc = readJson(qcFile);
} catch (error) {
  console.error(`无法读取 metrics 输入：${error.message}`);
  process.exit(2);
}

const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  projectId: project.projectId,
  versionId: delta.newVersion.id,
  intent: delta.newVersion.intent,
  context: {
    contextBytes: fs.statSync(resolveFrom(projectFile, project.context)).size,
    deltaBytes: fs.statSync(resolveFrom(projectFile, project.delta)).size,
    promptCharacters: numberOption(args, "--prompt-characters"),
    inputTokens: numberOption(args, "--input-tokens"),
  },
  change: {
    impactLevel: plan.impact.level,
    changedLayers: plan.impact.changedLayers,
    affectedDurationSeconds: plan.impact.affectedDurationSeconds,
    totalDurationSeconds: plan.metrics.totalDurationSeconds,
    affectedRatio: plan.impact.affectedRatio,
  },
  cache: {
    available: plan.metrics.cachedArtifactsAvailable,
    invalidated: plan.metrics.artifactsInvalidated,
    hitRatio: (
      plan.metrics.cachedArtifactsAvailable + plan.metrics.artifactsInvalidated
    ) > 0
      ? Number((
          plan.metrics.cachedArtifactsAvailable
          / (
            plan.metrics.cachedArtifactsAvailable
            + plan.metrics.artifactsInvalidated
          )
        ).toFixed(6))
      : null,
  },
  qc: {
    status: qc?.status ?? "not_run",
    executed: qc?.executedChecks?.length ?? 0,
    inherited: qc?.inheritedEvidence?.length ?? 0,
    manualRequired: plan.qcProfile.manualChecks.length,
  },
  timingSeconds: {
    render: numberOption(args, "--render-seconds"),
    qc: numberOption(args, "--qc-seconds"),
    tests: numberOption(args, "--test-seconds"),
  },
  storage: {
    peakBytes: numberOption(args, "--peak-bytes"),
  },
  baseline: {
    sourceDurationSeconds: context.source.media.durationSeconds,
    renderRatioTarget: plan.impact.affectedRatio,
  },
};
writeJsonAtomic(outputFile, report);
console.log(JSON.stringify({ status: "pass", output: outputFile, report }, null, 2));
