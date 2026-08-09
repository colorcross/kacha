#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileIdentity, readJson, run, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const APPS = {
  "final-cut-pro": ["/Applications/Final Cut Pro.app", "fcpxml"],
  premiere: ["/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app", "otio"],
  resolve: ["/Applications/DaVinci Resolve/DaVinci Resolve.app", "otio"],
};
function now() { return new Date().toISOString(); }
function stableDigest(value) {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  delete copy.updatedAt;
  delete copy.digest;
  return sha256Value(copy);
}
function detectApp(id) {
  const definition = APPS[id];
  if (!definition) throw new Error(`未知 NLE 应用：${id}`);
  const [appPath, preferredFormat] = definition;
  if (!fs.existsSync(appPath)) return { id, path: appPath, installed: false, version: null, preferredFormat };
  const version = run("mdls", ["-name", "kMDItemVersion", "-raw", appPath]);
  return {
    id,
    path: appPath,
    installed: true,
    version: version.status === 0 ? version.stdout.trim() : "unavailable",
    preferredFormat,
  };
}
export function detectNleApplications() {
  const applications = Object.keys(APPS).map(detectApp);
  return { schemaVersion: "1.0", status: applications.some((item) => item.installed) ? "pass" : "unavailable", applications };
}
function ensureReport(file, kind, label) {
  const resolved = path.resolve(file ?? "");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label}不存在：${resolved}`);
  const value = readJson(resolved);
  if (value.kind !== kind || value.digest !== stableDigest(value)) throw new Error(`${label} schema 或 digest 无效`);
  return { path: resolved, value };
}
export function createNleApplicationSession(exportReportPath, appId, output) {
  const report = ensureReport(exportReportPath, "kacha_nle_export_report", "NLE export report");
  const app = detectApp(appId);
  if (!app.installed) throw new Error(`${appId} 未安装，不能建立真实应用验证`);
  if (report.value.format !== app.preferredFormat) throw new Error(`${appId} 应使用 ${app.preferredFormat} 交换格式`);
  const session = {
    schemaVersion: "1.0",
    kind: "kacha-nle-application-session",
    generatedAt: now(),
    status: "awaiting_application_roundtrip",
    application: app,
    exportReport: fileIdentity(report.path),
    exchangeFile: report.value.output,
    requiredActions: [
      "在声明的真实 NLE 应用中导入交换文件",
      "核对源素材、片段顺序、帧率、语义 ID 和连接点",
      "从应用导出当前交换文件并用 kacha nle import 建立 candidate-only 报告",
      "以正常速度和声音人工复核应用往返候选",
    ],
    boundary: "会话模板不是应用往返通过证据；只有 record 后的真实文件身份与人工复核可通过。",
  };
  session.digest = stableDigest(session);
  const outputFile = path.resolve(output ?? "");
  if (!output) throw new Error("session 需要 --output FILE");
  writeJsonAtomic(outputFile, session);
  return { ...session, path: outputFile };
}
export function recordNleApplicationSession(sessionPath, {
  importReportPath,
  applicationEvidencePath,
  reviewer,
  notes,
  output,
} = {}) {
  const sessionFile = path.resolve(sessionPath ?? "");
  const session = readJson(sessionFile);
  if (session.kind !== "kacha-nle-application-session" || session.digest !== stableDigest(session)) throw new Error("NLE application session 无效");
  const currentApp = detectApp(session.application.id);
  if (!currentApp.installed || currentApp.version !== session.application.version) throw new Error("NLE 应用安装或版本已变化");
  const imported = ensureReport(importReportPath, "kacha_nle_import_report", "NLE import report");
  if (imported.value.format !== session.application.preferredFormat) throw new Error("导入报告格式与应用会话不一致");
  if (imported.value.baseTimeline?.sha256 !== readJson(session.exportReport.path).timeline?.sha256) {
    throw new Error("NLE 往返导入未绑定会话原始 Timeline");
  }
  const evidenceFile = path.resolve(applicationEvidencePath ?? "");
  if (!fs.existsSync(evidenceFile) || !fs.statSync(evidenceFile).isFile()) throw new Error("必须提供真实应用截图、导出记录或项目归档证据文件");
  if (typeof reviewer !== "string" || !reviewer.trim()) throw new Error("reviewer 不能为空");
  if (typeof notes !== "string" || !notes.trim()) throw new Error("notes 必须记录应用内核对结果");
  const result = {
    schemaVersion: "1.0",
    kind: "kacha-nle-application-validation",
    generatedAt: now(),
    status: "pass",
    application: currentApp,
    session: fileIdentity(sessionFile),
    exportReport: session.exportReport,
    importReport: fileIdentity(imported.path),
    candidateTimeline: imported.value.candidateTimeline,
    applicationEvidence: fileIdentity(evidenceFile),
    humanReview: {
      reviewer: reviewer.trim(),
      reviewedAt: now(),
      normalSpeedWithAudio: true,
      sourceBindingChecked: true,
      frameRateAndTimingChecked: true,
      semanticIdsChecked: true,
      notes: notes.trim(),
    },
    boundary: "证明当前应用版本和当前文件的往返，不外推到其他版本、项目或复杂效果重建。",
  };
  result.digest = stableDigest(result);
  const outputFile = path.resolve(output ?? "");
  if (!output) throw new Error("record 需要 --output FILE");
  writeJsonAtomic(outputFile, result);
  return { ...result, path: outputFile };
}
export function validateNleApplicationEvidence(input) {
  const file = path.resolve(input ?? "");
  const value = readJson(file);
  const errors = [];
  if (value.kind !== "kacha-nle-application-validation" || value.digest !== stableDigest(value)) errors.push("NLE application validation schema 或 digest 无效");
  for (const [label, identity] of [["session", value.session], ["exportReport", value.exportReport], ["importReport", value.importReport], ["applicationEvidence", value.applicationEvidence], ["candidateTimeline", value.candidateTimeline]]) {
    try {
      if (!identity?.path || fileIdentity(identity.path).sha256 !== identity.sha256) errors.push(`${label} 当前文件身份不一致`);
    } catch { errors.push(`${label} 当前文件不存在或身份不一致`); }
  }
  if (value.humanReview?.normalSpeedWithAudio !== true) errors.push("缺少正常速度带声音人工复核");
  return { schemaVersion: "1.0", status: errors.length ? "blocked" : "pass", errors, evidence: file };
}
function option(args, name, fallback = null) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; }
function main(args) {
  const [command, input] = args;
  let result;
  if (command === "detect") result = detectNleApplications();
  else if (command === "session") result = createNleApplicationSession(option(args, "--export-report"), option(args, "--app"), option(args, "--output"));
  else if (command === "record") result = recordNleApplicationSession(input, { importReportPath: option(args, "--import-report"), applicationEvidencePath: option(args, "--app-evidence"), reviewer: option(args, "--reviewer"), notes: option(args, "--notes"), output: option(args, "--output") });
  else if (command === "validate") result = validateNleApplicationEvidence(input);
  else throw new Error("用法：nle-app detect | session --export-report FILE --app ID --output FILE | record SESSION [options] | validate FILE");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "blocked") process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
