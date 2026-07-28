#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasValue,
  readJson,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const ROUTINE_CATEGORIES = new Set([
  "cache",
  "render_scratch",
  "duplicate_preview",
  "extracted_frame_cache",
  "rejected_test_render",
]);
const FINAL_CATEGORIES = new Set([
  ...ROUTINE_CATEGORIES,
  "proxy",
  "mask_cache",
  "render_shard",
  "intermediate_encode",
  "temporary_audio",
  "temporary_overlay",
  "rejected_generated_candidate",
]);
const NEVER_DELETE_CATEGORIES = new Set([
  "source",
  "final_deliverable",
  "approved_cover",
  "approved_subtitle",
  "edit_project",
  "plan",
  "manifest",
  "release_evidence",
  "license_asset",
  "approved_generated_asset",
  "approved_dialogue_stem",
]);

function usage() {
  console.error("用法：cleanup_project.mjs <cleanup-plan.json> [--apply]");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function measure(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { files: 1, directories: 0, bytes: stat.size };
  }
  let files = 0;
  let directories = 1;
  let bytes = stat.size;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    const value = measure(child);
    files += value.files;
    directories += value.directories;
    bytes += value.bytes;
  }
  return { files, directories, bytes };
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const input = args.find((argument) => !argument.startsWith("--"));
if (!input) {
  usage();
  process.exit(2);
}

const planFile = path.resolve(input);
let plan;
try {
  plan = readJson(planFile);
} catch (error) {
  console.error(`无法读取清理方案：${error.message}`);
  process.exit(2);
}

const errors = [];
if (plan.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
if (!["routine", "final"].includes(plan.mode)) {
  errors.push("mode 必须为 routine 或 final");
}
if (!hasValue(plan.projectRoot)) errors.push("缺少 projectRoot");
if (!Array.isArray(plan.protectedPaths) || plan.protectedPaths.length === 0) {
  errors.push("protectedPaths 必须是非空数组");
}
if (!Array.isArray(plan.candidates)) errors.push("candidates 必须是数组");
if (!hasValue(plan.reportPath)) errors.push("缺少 reportPath");

const projectRoot = path.resolve(path.dirname(planFile), plan.projectRoot ?? ".");
const home = path.resolve(os.homedir());
if (projectRoot === path.parse(projectRoot).root || projectRoot === home) {
  errors.push("projectRoot 不得是文件系统根目录或用户主目录");
}
if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
  errors.push(`projectRoot 不存在或不是目录：${projectRoot}`);
}

const authorization = plan.authorization ?? {};
if (authorization.routineCleanupAllowed !== true) {
  errors.push("authorization.routineCleanupAllowed 必须为 true");
}
if (plan.mode === "final") {
  if (authorization.finalCleanupConfirmed !== true) {
    errors.push("final 模式必须有用户明确确认");
  }
  if (authorization.noFurtherEdits !== true) {
    errors.push("final 模式必须确认 noFurtherEdits=true");
  }
  if (!hasValue(authorization.evidence) || !hasValue(authorization.confirmedAt)) {
    errors.push("final 模式必须记录用户原话证据和确认时间");
  }
}

function resolveRelative(candidate, label) {
  if (!hasValue(candidate) || path.isAbsolute(candidate)) {
    errors.push(`${label} 必须是项目根目录内的相对路径`);
    return null;
  }
  const resolved = path.resolve(projectRoot, candidate);
  if (!isInside(projectRoot, resolved) || resolved === projectRoot) {
    errors.push(`${label} 不能指向项目外或项目根目录`);
    return null;
  }
  return resolved;
}

const reportPath = resolveRelative(plan.reportPath, "reportPath");
const protectedEntries = (plan.protectedPaths ?? [])
  .map((candidate, index) => resolveRelative(candidate, `protectedPaths[${index}]`))
  .filter(Boolean);
if (reportPath) protectedEntries.push(reportPath);

const seen = new Set();
const inspected = [];
for (const [index, candidate] of (plan.candidates ?? []).entries()) {
  const label = `candidates[${index}]`;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    errors.push(`${label} 必须是对象`);
    continue;
  }
  for (const field of [
    "path",
    "category",
    "reproducible",
    "requiredForIteration",
    "userNeeds",
    "regeneration",
    "reason",
  ]) {
    if (!hasValue(candidate[field])) errors.push(`${label} 缺少 ${field}`);
  }
  const target = resolveRelative(candidate.path, `${label}.path`);
  if (!target) continue;
  if (seen.has(target)) {
    errors.push(`${label}.path 重复：${candidate.path}`);
    continue;
  }
  seen.add(target);

  if (NEVER_DELETE_CATEGORIES.has(candidate.category)) {
    errors.push(`${label}.category 属于永久保护类型：${candidate.category}`);
  }
  const allowedCategories = plan.mode === "final"
    ? FINAL_CATEGORIES
    : ROUTINE_CATEGORIES;
  if (!allowedCategories.has(candidate.category)) {
    errors.push(`${label}.category 不允许在 ${plan.mode} 模式删除`);
  }
  if (candidate.reproducible !== true) {
    errors.push(`${label} 只有可重建产物才能删除`);
  }
  if (candidate.userNeeds !== false) {
    errors.push(`${label} 只有确认用户不需要保留时才能删除`);
  }
  if (
    !candidate.regeneration
    || typeof candidate.regeneration !== "object"
    || Array.isArray(candidate.regeneration)
  ) {
    errors.push(`${label}.regeneration 必须是对象`);
  } else {
    for (const field of ["verified", "speed", "estimatedSeconds", "method"]) {
      if (!hasValue(candidate.regeneration[field])) {
        errors.push(`${label}.regeneration 缺少 ${field}`);
      }
    }
    if (candidate.regeneration.verified !== true) {
      errors.push(`${label} 必须实际验证可重建`);
    }
    if (plan.mode === "routine" && candidate.regeneration.speed !== "fast") {
      errors.push(`${label} 例行清理只允许删除可快速重建的缓存`);
    }
    if (
      !Number.isFinite(candidate.regeneration.estimatedSeconds)
      || candidate.regeneration.estimatedSeconds < 0
    ) {
      errors.push(`${label}.regeneration.estimatedSeconds 必须是非负数`);
    }
  }
  if (plan.mode === "routine" && candidate.requiredForIteration !== false) {
    errors.push(`${label} 例行清理不得删除返工或迭代所需产物`);
  }
  if (
    plan.mode === "final"
    && candidate.requiredForIteration === true
    && candidate.finalDispositionApproved !== true
  ) {
    errors.push(`${label} 最终删除迭代资产必须设置 finalDispositionApproved=true`);
  }
  for (const protectedPath of protectedEntries) {
    if (isInside(target, protectedPath) || isInside(protectedPath, target)) {
      errors.push(`${label}.path 与 protected path 冲突：${candidate.path}`);
      break;
    }
  }

  const exists = fs.existsSync(target);
  inspected.push({
    path: candidate.path,
    absolutePath: target,
    category: candidate.category,
    reason: candidate.reason,
    userNeeds: candidate.userNeeds,
    regeneration: candidate.regeneration,
    exists,
    ...(exists ? measure(target) : { files: 0, directories: 0, bytes: 0 }),
  });
}

if (errors.length > 0) {
  console.error(`清理门禁失败：${errors.length} 项`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

const report = {
  schemaVersion: "1.0",
  status: apply ? "applied" : "dry_run",
  generatedAt: new Date().toISOString(),
  plan: planFile,
  mode: plan.mode,
  projectRoot,
  protectedPaths: protectedEntries.map((entry) => path.relative(projectRoot, entry)),
  candidates: inspected,
  totals: {
    candidates: inspected.length,
    existingCandidates: inspected.filter((entry) => entry.exists).length,
    files: inspected.reduce((sum, entry) => sum + entry.files, 0),
    directories: inspected.reduce((sum, entry) => sum + entry.directories, 0),
    bytesPlanned: inspected.reduce((sum, entry) => sum + entry.bytes, 0),
    bytesDeleted: 0,
  },
  failures: [],
};

if (apply) {
  for (const entry of inspected.filter((candidate) => candidate.exists)) {
    try {
      fs.rmSync(entry.absolutePath, { recursive: true, force: false, maxRetries: 2 });
      if (fs.existsSync(entry.absolutePath)) {
        throw new Error("删除后路径仍存在");
      }
      report.totals.bytesDeleted += entry.bytes;
    } catch (error) {
      report.failures.push({ path: entry.path, error: error.message });
    }
  }
  report.status = report.failures.length === 0 ? "applied" : "partial_failure";
}

writeJsonAtomic(reportPath, report);
console.log(JSON.stringify(report, null, 2));
if (report.failures.length > 0) process.exit(1);
