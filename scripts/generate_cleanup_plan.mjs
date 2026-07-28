#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  readJson,
  resolveFrom,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const CATEGORY_BY_TYPE = {
  cache: "cache",
  render_scratch: "render_scratch",
  preview: "duplicate_preview",
  duplicate_preview: "duplicate_preview",
  extracted_frame_cache: "extracted_frame_cache",
  rejected_test_render: "rejected_test_render",
  proxy: "proxy",
  mask_cache: "mask_cache",
  render_shard: "render_shard",
  intermediate_encode: "intermediate_encode",
  temporary_audio: "temporary_audio",
  temporary_overlay: "temporary_overlay",
  rejected_generated_candidate: "rejected_generated_candidate",
};

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== ""
    && !relative.startsWith("..")
    && !path.isAbsolute(relative);
}

const args = process.argv.slice(2);
const positional = args.filter((item) => !item.startsWith("--"));
const modeIndex = args.indexOf("--mode");
const outputIndex = args.indexOf("--output");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : "routine";
const finalConfirmed = args.includes("--final-confirmed");
const noFurtherEdits = args.includes("--no-further-edits");
const evidenceIndex = args.indexOf("--evidence");
const evidence = evidenceIndex >= 0 ? args[evidenceIndex + 1] : "";
if (
  positional.length < 2
  || outputIndex < 0
  || !args[outputIndex + 1]
  || !["routine", "final"].includes(mode)
) {
  console.error(
    "用法：generate_cleanup_plan.mjs PROJECT-CONTEXT.json ARTIFACT-INDEX.json "
      + "--output cleanup-plan.json [--mode routine|final] "
      + "[--final-confirmed --no-further-edits --evidence TEXT]",
  );
  process.exit(2);
}

const [contextInput, indexInput] = positional;
const contextFile = path.resolve(contextInput);
const indexFile = path.resolve(indexInput);
const outputFile = path.resolve(args[outputIndex + 1]);
if (fs.existsSync(outputFile)) {
  console.error(`拒绝覆盖已有 cleanup plan：${outputFile}`);
  process.exit(2);
}
let context;
let index;
try {
  context = readJson(contextFile);
  index = readJson(indexFile);
} catch (error) {
  console.error(`无法读取 cleanup 输入：${error.message}`);
  process.exit(2);
}

const projectRoot = resolveFrom(contextFile, context.projectRoot);
if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
  console.error(`projectRoot 不存在：${projectRoot ?? context.projectRoot}`);
  process.exit(2);
}

const requiredByProtectedArtifact = new Set();
const byId = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]));
function protectDependencies(id) {
  if (requiredByProtectedArtifact.has(id)) return;
  requiredByProtectedArtifact.add(id);
  for (const dependency of byId.get(id)?.dependencies ?? []) {
    protectDependencies(dependency);
  }
}
for (const artifact of index.artifacts) {
  if (
    artifact.status === "ready"
    && (
      artifact.retention?.userNeeds === true
      || artifact.retention?.requiredForIteration === true
    )
  ) {
    protectDependencies(artifact.id);
  }
}

const protectedAbsolute = new Set([
  path.resolve(contextFile),
  path.resolve(indexFile),
  resolveFrom(contextFile, context.source.path),
  resolveFrom(contextFile, context.baseline.video.path),
]);
for (const artifact of index.artifacts) {
  if (requiredByProtectedArtifact.has(artifact.id)) {
    protectedAbsolute.add(resolveFrom(indexFile, artifact.path));
  }
}
const protectedPaths = [...protectedAbsolute]
  .filter((entry) => entry && isInside(projectRoot, entry))
  .map((entry) => path.relative(projectRoot, entry));
if (protectedPaths.length === 0) {
  protectedPaths.push(
    path.relative(projectRoot, contextFile),
    path.relative(projectRoot, indexFile),
  );
}

const candidates = [];
for (const artifact of index.artifacts) {
  const target = resolveFrom(indexFile, artifact.path);
  const retention = artifact.retention ?? {};
  const regeneration = retention.regeneration ?? {};
  const category = CATEGORY_BY_TYPE[artifact.type];
  if (!target || !isInside(projectRoot, target) || !category) continue;
  if (requiredByProtectedArtifact.has(artifact.id)) continue;
  if (retention.userNeeds !== false) continue;
  if (mode === "routine") {
    if (
      retention.requiredForIteration !== false
      || retention.paidOrRemote === true
      || retention.humanCalibrated === true
      || regeneration.verified !== true
      || regeneration.speed !== "fast"
    ) {
      continue;
    }
  }
  candidates.push({
    path: path.relative(projectRoot, target),
    category,
    reproducible: regeneration.verified === true,
    requiredForIteration: retention.requiredForIteration,
    userNeeds: retention.userNeeds,
    regeneration,
    finalDispositionApproved: mode === "final"
      ? finalConfirmed && noFurtherEdits
      : false,
    reason: `artifact ${artifact.id} 未被当前受保护版本引用`,
  });
}

const plan = {
  schemaVersion: "1.0",
  projectRoot,
  mode,
  authorization: {
    routineCleanupAllowed: true,
    finalCleanupConfirmed: mode === "final" && finalConfirmed,
    noFurtherEdits: mode === "final" && noFurtherEdits,
    evidence: mode === "final" ? evidence : "artifact index 自动生成的 dry-run 候选",
    confirmedAt: mode === "final" && finalConfirmed
      ? new Date().toISOString()
      : "not_applicable",
  },
  protectedPaths,
  candidates,
  reportPath: path.relative(
    projectRoot,
    path.join(path.dirname(outputFile), "cleanup-report.json"),
  ),
};
writeJsonAtomic(outputFile, plan);
console.log(
  JSON.stringify(
    {
      status: "pass",
      output: outputFile,
      mode,
      protectedPaths: protectedPaths.length,
      candidates: candidates.length,
      applied: false,
    },
    null,
    2,
  ),
);
