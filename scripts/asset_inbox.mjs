#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireFileLock,
  fileIdentity,
  fileIdentityMatches,
  readJson,
  resolveFrom,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptFile = fileURLToPath(import.meta.url);

function now() { return new Date().toISOString(); }
function entryPath(entry) { return typeof entry === "string" ? entry : entry?.path; }
function digest(value) {
  const copy = structuredClone(value);
  delete copy.updatedAt;
  delete copy.digest;
  return sha256Value(copy);
}

function projectFiles(projectManifestPath) {
  const manifestPath = path.resolve(projectManifestPath ?? "");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(`项目 manifest 不存在：${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  if (manifest.kind !== "kacha-project-manifest") throw new Error("不是咔嚓项目 manifest");
  const gapPlanPath = resolveFrom(manifestPath, entryPath(manifest.plans?.assetGapPlan));
  if (!gapPlanPath || !fs.existsSync(gapPlanPath)) {
    throw new Error("项目尚未生成 asset gap plan");
  }
  return {
    manifestPath,
    manifest,
    gapPlanPath,
    inboxPath: path.resolve(path.dirname(manifestPath), "..", ".kacha", "asset-inbox.json"),
  };
}

function persist(file, value) {
  const stable = { ...value, updatedAt: now() };
  delete stable.digest;
  stable.digest = digest(stable);
  writeJsonAtomic(file, stable);
  return stable;
}

function inboxSummary(items) {
  return {
    total: items.length,
    resolvedByCurrentPlan: items.filter((item) => item.status === "resolved_by_current_plan").length,
    pendingReindex: items.filter((item) => item.status === "pending_reindex").length,
    needsUserEvidence: items.filter((item) => item.resolution === "user_or_source_evidence_required" && item.status !== "resolved_by_current_plan").length,
    generatableIllustrations: items.filter((item) => item.resolution === "generated_visual_candidate" && item.status !== "resolved_by_current_plan").length,
    productionReady: items.every((item) => item.status === "resolved_by_current_plan"),
  };
}

export function buildAssetInbox(projectManifestPath) {
  const files = projectFiles(projectManifestPath);
  const plan = readJson(files.gapPlanPath);
  if (plan.kind !== "kacha_asset_gap_plan" || !Array.isArray(plan.gaps)) {
    throw new Error("asset gap plan 无效");
  }
  const existing = fs.existsSync(files.inboxPath) ? readJson(files.inboxPath) : null;
  const submissions = new Map((existing?.items ?? []).map((item) => [item.gapId, item.submission ?? null]));
  const items = plan.gaps.map((gap) => {
    const submission = submissions.get(gap.id) ?? null;
    const submissionCurrent = Boolean(
      submission?.identity?.path
      && fs.existsSync(submission.identity.path)
      && fileIdentityMatches(submission.identity.path, submission.identity)
    );
    return {
      gapId: gap.id,
      beatId: gap.beatId,
      range: gap.range,
      query: gap.query,
      evidenceType: gap.evidenceType,
      resolution: gap.resolution,
      status: gap.blocker === false
        ? "resolved_by_current_plan"
        : submissionCurrent ? "pending_reindex" : "awaiting_asset",
      blockerReason: gap.blockerReason,
      generationBrief: gap.generationSpec?.promptBrief ?? null,
      generationBoundary: gap.generationSpec
        ? "只能生成说明性画面；外传、付费生成和人物身份处理均需另行授权。"
        : null,
      currentCandidates: gap.candidates ?? [],
      submission: submissionCurrent ? submission : null,
    };
  });
  const inbox = {
    schemaVersion: "1.0",
    kind: "kacha-asset-inbox",
    projectId: files.manifest.projectId,
    generatedAt: existing?.generatedAt ?? now(),
    projectManifest: fileIdentity(files.manifestPath),
    assetGapPlan: fileIdentity(files.gapPlanPath),
    items,
    summary: inboxSummary(items),
    nextAction: items.some((item) => item.status === "pending_reindex")
      ? "把提交素材纳入项目 media index，重建 asset gap plan 后刷新收件箱。"
      : "按缺口类型补充本地证据，或在明确授权后生成说明性素材。",
  };
  fs.mkdirSync(path.dirname(files.inboxPath), { recursive: true });
  return { path: files.inboxPath, inbox: persist(files.inboxPath, inbox) };
}

export function attachAsset(projectManifestPath, {
  gapId,
  assetPath,
  license,
  provenanceKind,
  provenanceEvidence,
} = {}) {
  if (![gapId, assetPath, license, provenanceKind, provenanceEvidence].every((value) => typeof value === "string" && value.trim())) {
    throw new Error("attach 需要 gapId、assetPath、license、provenanceKind 和 provenanceEvidence");
  }
  if (["unknown", "unverified"].includes(license.trim().toLowerCase())) {
    throw new Error("素材许可不能是 unknown 或 unverified");
  }
  const asset = path.resolve(assetPath);
  if (!fs.existsSync(asset) || !fs.statSync(asset).isFile()) throw new Error(`素材不存在：${asset}`);
  const files = projectFiles(projectManifestPath);
  if (!fs.existsSync(files.inboxPath)) buildAssetInbox(files.manifestPath);
  const release = acquireFileLock(`${files.inboxPath}.lock`, { purpose: "asset-inbox-attach" });
  try {
    const inbox = readJson(files.inboxPath);
    const item = inbox.items.find((candidate) => candidate.gapId === gapId);
    if (!item) throw new Error(`素材缺口不存在：${gapId}`);
    item.submission = {
      identity: fileIdentity(asset),
      license: license.trim(),
      provenance: { kind: provenanceKind.trim(), evidence: provenanceEvidence.trim() },
      submittedAt: now(),
    };
    item.status = "pending_reindex";
    inbox.summary = inboxSummary(inbox.items);
    inbox.nextAction = "把提交素材纳入项目 media index，重建 asset gap plan 后刷新收件箱。";
    return { path: files.inboxPath, inbox: persist(files.inboxPath, inbox), submission: item.submission };
  } finally { release(); }
}

export function validateAssetInbox(inboxPath) {
  const file = path.resolve(inboxPath ?? "");
  const inbox = readJson(file);
  const errors = [];
  if (inbox.schemaVersion !== "1.0" || inbox.kind !== "kacha-asset-inbox") errors.push("素材收件箱 schema 无效");
  if (!Array.isArray(inbox.items)) errors.push("素材收件箱 items 必须是数组");
  for (const item of inbox.items ?? []) {
    if (item.submission && !fileIdentityMatches(item.submission.identity.path, item.submission.identity)) {
      errors.push(`${item.gapId} 提交素材内容已变化`);
    }
  }
  if (JSON.stringify(inboxSummary(inbox.items ?? [])) !== JSON.stringify(inbox.summary)) errors.push("素材收件箱 summary 无效");
  if (digest(inbox) !== inbox.digest) errors.push("素材收件箱 digest 无效");
  return { status: errors.length ? "blocked" : "pass", errors, inbox: file };
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function main(args) {
  const [command, input] = args;
  let result;
  if (command === "build" || command === "refresh") result = buildAssetInbox(input);
  else if (command === "attach") result = attachAsset(input, {
    gapId: option(args, "--gap"), assetPath: option(args, "--asset"), license: option(args, "--license"),
    provenanceKind: option(args, "--provenance-kind"), provenanceEvidence: option(args, "--provenance-evidence"),
  });
  else if (command === "validate") result = validateAssetInbox(input);
  else throw new Error("用法：asset_inbox.mjs build|refresh|attach <project-manifest.json> [options] | validate <asset-inbox.json>");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "blocked") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
