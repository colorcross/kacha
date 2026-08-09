#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireFileLock,
  fileIdentity,
  readJson,
  resolveFrom,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const CHECKS = [
  ["contentIntegrity", "内容完整与事实语义"],
  ["connectionPlayback", "所有连接点正常速度播放"],
  ["subtitleAccuracy", "字幕准确性"],
  ["subtitleLayout", "字幕布局与可读性"],
  ["visualContinuity", "视觉连续性与呼吸感"],
  ["assetSemanticsAndLicenses", "素材语义与许可"],
  ["maskTrackingBeautyAndPip", "蒙版、跟踪、美颜与画中画"],
  ["audioStemAndDeviceListening", "音频分轨与设备试听"],
  ["coverAndBrand", "封面、栏目、期号与品牌"],
  ["openingEndingAndFullPlayback", "开头、结尾与完整通看"],
  ["technicalFindingsDisposition", "技术问题处置"],
];

function now() { return new Date().toISOString(); }
function outputPath(entry) { return typeof entry === "string" ? entry : entry?.path; }
function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

function loadProject(projectManifestPath) {
  const manifestPath = path.resolve(requiredString(projectManifestPath, "projectManifestPath"));
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(`项目 manifest 不存在：${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  if (manifest.kind !== "kacha-project-manifest") throw new Error("不是咔嚓项目 manifest");
  const finalVideoPath = resolveFrom(manifestPath, outputPath(manifest.outputs?.finalVideo));
  const releaseReportPath = resolveFrom(manifestPath, outputPath(manifest.outputs?.releaseReport));
  if (!releaseReportPath) throw new Error("manifest 缺少 outputs.releaseReport.path");
  return { manifestPath, manifest, finalVideoPath, releaseReportPath };
}

function finalVideoIdentity(project) {
  if (
    !project.finalVideoPath
    || !fs.existsSync(project.finalVideoPath)
    || !fs.statSync(project.finalVideoPath).isFile()
  ) return null;
  return fileIdentity(project.finalVideoPath);
}

function summary(report) {
  const values = CHECKS.map(([id]) => report?.manualChecks?.[id]?.status ?? "pending");
  return {
    total: CHECKS.length,
    passed: values.filter((value) => value === "pass").length,
    failed: values.filter((value) => value === "fail").length,
    pending: values.filter((value) => value === "pending").length,
    readyForApproval: values.every((value) => value === "pass"),
    approved: report?.status === "approved_local_release",
  };
}

function reportDigest(report) {
  const copy = structuredClone(report);
  delete copy.updatedAt;
  delete copy.digest;
  return sha256Value(copy);
}

function persist(file, report) {
  const value = { ...report, updatedAt: now() };
  delete value.digest;
  value.digest = reportDigest(value);
  writeJsonAtomic(file, value);
  return value;
}

export function openReleaseReview(projectManifestPath) {
  const project = loadProject(projectManifestPath);
  const video = finalVideoIdentity(project);
  const report = fs.existsSync(project.releaseReportPath)
    ? readJson(project.releaseReportPath)
    : null;
  const stale = Boolean(
    report
    && video
    && report.finalVideoSha256
    && report.finalVideoSha256 !== video.sha256
  );
  return {
    schemaVersion: "1.0",
    status: stale ? "blocked" : "pass",
    project: {
      id: project.manifest.projectId,
      manifest: fileIdentity(project.manifestPath),
      finalVideo: video ?? { path: project.finalVideoPath, missing: true },
      releaseReportPath: project.releaseReportPath,
    },
    checks: CHECKS.map(([id, label]) => ({
      id,
      label,
      ...(report?.manualChecks?.[id] ?? { status: "pending", evidence: [] }),
    })),
    report,
    summary: summary(report),
    diagnostics: [
      ...(!video ? ["最终视频尚不存在，不能开始发布审片"] : []),
      ...(stale ? ["release report 绑定的最终视频已变化，必须重新初始化审片"] : []),
    ],
    boundary: "发布审片只批准当前 SHA-256 的本地成片，不授权上传或发布。",
  };
}

export function initializeReleaseReview(projectManifestPath, {
  reviewer,
  confirmReset = false,
} = {}) {
  const project = loadProject(projectManifestPath);
  const video = finalVideoIdentity(project);
  if (!video) throw new Error("最终视频不存在，不能建立发布审片");
  const reviewerName = requiredString(reviewer, "reviewer");
  const releaseDirectory = path.dirname(project.releaseReportPath);
  fs.mkdirSync(releaseDirectory, { recursive: true });
  const lock = `${project.releaseReportPath}.lock`;
  const release = acquireFileLock(lock, { purpose: "release-review-initialize" });
  try {
    if (fs.existsSync(project.releaseReportPath)) {
      const current = readJson(project.releaseReportPath);
      if (current.finalVideoSha256 === video.sha256) return openReleaseReview(project.manifestPath);
      if (!confirmReset) throw new Error("最终视频已变化；需要 confirmReset=true 才能重建审片清单");
      const archive = path.join(
        releaseDirectory,
        `release-report.stale-${Date.now()}.json`,
      );
      fs.renameSync(project.releaseReportPath, archive);
    }
    const manualChecks = Object.fromEntries(CHECKS.map(([id]) => [id, {
      status: "pending",
      evidence: [],
      note: "",
    }]));
    persist(project.releaseReportPath, {
      schemaVersion: "2.0",
      projectId: project.manifest.projectId,
      status: "in_review",
      reviewedAt: null,
      reviewer: reviewerName,
      finalVideoSha256: video.sha256,
      limitations: ["none"],
      manualChecks,
      reviewAudit: [{ at: now(), action: "initialized", reviewer: reviewerName }],
    });
    return openReleaseReview(project.manifestPath);
  } finally { release(); }
}

function changeRequest(project, checkId, entry, reviewer) {
  const directory = path.resolve(
    path.dirname(project.manifestPath),
    "..",
    ".kacha",
    "review",
    "change-requests",
  );
  fs.mkdirSync(directory, { recursive: true });
  const id = `release-${checkId}-${Date.now()}`;
  const file = path.join(directory, `${id}.json`);
  const value = {
    schemaVersion: "1.0",
    kind: "kacha-review-change-request",
    id,
    projectId: project.manifest.projectId,
    source: "release_review",
    checkId,
    requestedAt: now(),
    requestedBy: reviewer,
    note: entry.note,
    evidence: entry.evidence,
    status: "pending_agent_compilation",
    authorityBoundary: "需要 Agent 编译为受约束 change plan；不得直接修改最终视频。",
  };
  value.digest = sha256Value(value);
  writeJsonAtomic(file, value);
  return fileIdentity(file);
}

export function recordReleaseCheck(projectManifestPath, {
  checkId,
  outcome,
  evidence,
  note = "",
  reviewer,
} = {}) {
  const project = loadProject(projectManifestPath);
  if (!CHECKS.some(([id]) => id === checkId)) throw new Error(`未知发布检查项：${checkId}`);
  if (!['pass', 'fail', 'pending'].includes(outcome)) throw new Error("outcome 必须为 pass、fail 或 pending");
  const reviewerName = requiredString(reviewer, "reviewer");
  const evidenceValues = Array.isArray(evidence)
    ? evidence.map((item) => String(item).trim()).filter(Boolean)
    : String(evidence ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (outcome === "pass" && evidenceValues.length === 0) throw new Error("通过检查必须填写非空证据");
  if (outcome === "fail" && !String(note).trim()) throw new Error("未通过检查必须写清问题和预期结果");
  const release = acquireFileLock(`${project.releaseReportPath}.lock`, { purpose: "release-review-record" });
  try {
    if (!fs.existsSync(project.releaseReportPath)) throw new Error("请先初始化发布审片");
    const report = readJson(project.releaseReportPath);
    const video = finalVideoIdentity(project);
    if (!video || report.finalVideoSha256 !== video.sha256) throw new Error("当前最终视频与审片报告不一致");
    const entry = { status: outcome, evidence: evidenceValues, note: String(note).trim(), reviewedAt: now(), reviewer: reviewerName };
    let request = null;
    if (outcome === "fail") request = changeRequest(project, checkId, entry, reviewerName);
    report.manualChecks[checkId] = { ...entry, changeRequest: request };
    report.reviewer = reviewerName;
    report.status = "in_review";
    report.reviewedAt = null;
    report.reviewAudit = [...(report.reviewAudit ?? []), { at: now(), action: "record", checkId, outcome, reviewer: reviewerName }];
    persist(project.releaseReportPath, report);
    return openReleaseReview(project.manifestPath);
  } finally { release(); }
}

export function approveReleaseReview(projectManifestPath, {
  reviewer,
  limitations = ["none"],
} = {}) {
  const project = loadProject(projectManifestPath);
  const reviewerName = requiredString(reviewer, "reviewer");
  const release = acquireFileLock(`${project.releaseReportPath}.lock`, { purpose: "release-review-approve" });
  try {
    if (!fs.existsSync(project.releaseReportPath)) throw new Error("请先初始化发布审片");
    const report = readJson(project.releaseReportPath);
    const video = finalVideoIdentity(project);
    if (!video || report.finalVideoSha256 !== video.sha256) throw new Error("当前最终视频与审片报告不一致");
    if (!summary(report).readyForApproval) throw new Error("十一项人工检查尚未全部通过");
    const cleanLimitations = (Array.isArray(limitations) ? limitations : [limitations])
      .map((item) => String(item).trim()).filter(Boolean);
    if (cleanLimitations.length === 0) throw new Error("limitations 必须明确填写 none 或已知限制");
    report.status = "approved_local_release";
    report.reviewedAt = now();
    report.reviewer = reviewerName;
    report.limitations = cleanLimitations;
    report.reviewAudit = [...(report.reviewAudit ?? []), { at: now(), action: "approved", reviewer: reviewerName }];
    persist(project.releaseReportPath, report);
    return openReleaseReview(project.manifestPath);
  } finally { release(); }
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function main(args) {
  const [command, manifest] = args;
  let result;
  if (command === "open") result = openReleaseReview(manifest);
  else if (command === "init") result = initializeReleaseReview(manifest, { reviewer: option(args, "--reviewer"), confirmReset: args.includes("--confirm-reset") });
  else if (command === "record") result = recordReleaseCheck(manifest, { checkId: option(args, "--check"), outcome: option(args, "--outcome"), evidence: option(args, "--evidence"), note: option(args, "--note", ""), reviewer: option(args, "--reviewer") });
  else if (command === "approve") result = approveReleaseReview(manifest, { reviewer: option(args, "--reviewer"), limitations: option(args, "--limitations", "none") });
  else throw new Error("用法：release_review.mjs open|init|record|approve <project-manifest.json> [options]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
