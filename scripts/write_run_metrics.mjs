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

function stringOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const input = args.find((item) => !item.startsWith("--"));
const outputIndex = args.indexOf("--output");
const packetInput = stringOption(args, "--agent-packet");
const evidenceInput = stringOption(args, "--visual-evidence");
const modelTier = stringOption(args, "--model-tier");
if (!input || outputIndex < 0 || !args[outputIndex + 1]) {
  console.error(
    "用法：write_run_metrics.mjs incremental-project.json --output run-metrics.json "
      + "[--render-seconds N] [--qc-seconds N] [--test-seconds N] "
      + "[--prompt-characters N] [--input-tokens N] [--peak-bytes N] "
      + "[--agent-packet FILE] [--visual-evidence FILE] "
      + "[--model-tier frontier|balanced|economy]",
  );
  process.exit(2);
}
if (modelTier && !["frontier", "balanced", "economy"].includes(modelTier)) {
  console.error("--model-tier 必须为 frontier、balanced 或 economy");
  process.exit(2);
}

const projectFile = path.resolve(input);
const outputFile = path.resolve(args[outputIndex + 1]);
let project;
let context;
let delta;
let plan;
let qc = null;
let agentPacket = null;
let visualEvidence = null;
try {
  project = readJson(projectFile);
  const contextFile = resolveFrom(projectFile, project.context);
  const deltaFile = resolveFrom(projectFile, project.delta);
  context = readJson(contextFile);
  delta = readJson(deltaFile);
  plan = readJson(resolveFrom(projectFile, project.outputs.incrementalPlan));
  const qcFile = resolveFrom(projectFile, project.outputs.deltaQcReport);
  if (qcFile && fs.existsSync(qcFile)) qc = readJson(qcFile);
  if (packetInput) {
    const packetFile = path.resolve(packetInput);
    if (!fs.existsSync(packetFile)) throw new Error(`agent packet 不存在：${packetFile}`);
    agentPacket = readJson(packetFile);
  }
  if (evidenceInput) {
    const evidenceFile = path.resolve(evidenceInput);
    if (!fs.existsSync(evidenceFile)) {
      throw new Error(`visual evidence 不存在：${evidenceFile}`);
    }
    visualEvidence = readJson(evidenceFile);
  }
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
    routedFiles: agentPacket?.contextBudget?.files ?? null,
    routedApproximateTokens:
      agentPacket?.contextBudget?.approximateInputTokens ?? null,
    modelTier,
    configurationDigest:
      agentPacket?.configuration?.digest
      ?? qc?.configuration?.digest
      ?? null,
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
  visualEvidence: visualEvidence
    ? {
        status: visualEvidence.status,
        mode: visualEvidence.sampling?.mode ?? null,
        frames: visualEvidence.frames?.length ?? 0,
        localSemantic: visualEvidence.analysis?.localSemantic ?? null,
        remoteSemantic: visualEvidence.analysis?.remoteSemantic ?? null,
        remoteFrames:
          visualEvidence.analysis?.remoteSemanticFrames ?? 0,
        wholeVideoUploaded:
          visualEvidence.provenance?.wholeVideoUploaded ?? false,
      }
    : null,
  baseline: {
    sourceDurationSeconds: context.source.media.durationSeconds,
    renderRatioTarget: plan.impact.affectedRatio,
  },
};
writeJsonAtomic(outputFile, report);
console.log(JSON.stringify({ status: "pass", output: outputFile, report }, null, 2));
