#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireFileLock, readJson, writeJsonAtomic } from "./kacha_utils.mjs";
import { resolveProjectRoot } from "./project_orchestrator.mjs";

const scriptFile = fileURLToPath(import.meta.url);
function now() { return new Date().toISOString(); }
function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}
function files(input) {
  const root = resolveProjectRoot(input);
  const spine = path.join(root, "contracts", "content-spine.json");
  const facts = path.join(root, "contracts", "fact-check-tasks.json");
  const inbox = path.join(root, ".kacha", "asset-inbox.json");
  for (const [label, file] of [["content spine", spine], ["fact tasks", facts], ["asset inbox", inbox]]) {
    if (!fs.existsSync(file)) throw new Error(`${label} 不存在：${file}`);
  }
  return { root, spine, facts, inbox };
}

export function contentProjectStatus(input) {
  const current = files(input);
  const spine = readJson(current.spine);
  const facts = readJson(current.facts);
  const inbox = readJson(current.inbox);
  const pendingFacts = (facts.tasks ?? []).filter((task) => !["verified", "waived_with_reason"].includes(task.status));
  const pendingAssets = (inbox.items ?? []).filter((item) => !["resolved", "waived_with_reason"].includes(item.status));
  return {
    schemaVersion: "1.0",
    status: pendingFacts.length === 0 && pendingAssets.length === 0 ? "ready_for_approval" : "needs_evidence",
    projectRoot: current.root,
    spine: { status: spine.status, sections: spine.sections?.length ?? 0 },
    facts: { total: facts.tasks?.length ?? 0, pending: pendingFacts.length },
    assets: { total: inbox.items?.length ?? 0, pending: pendingAssets.length },
    nextAction: pendingFacts.length ? "解决事实核查任务"
      : pendingAssets.length ? "解决内容素材缺口"
        : spine.status === "approved_for_recording" ? "录制或回填源媒体后执行 handoff" : "批准录制内容包",
  };
}

export function recordContentFact(input, {
  factId, status, evidence = null, reason = null, reviewer,
} = {}) {
  const current = files(input);
  if (!["verified", "waived_with_reason"].includes(status)) throw new Error("fact status 必须为 verified 或 waived_with_reason");
  const name = required(reviewer, "reviewer");
  if (status === "verified") required(evidence, "evidence");
  if (status === "waived_with_reason") required(reason, "reason");
  const release = acquireFileLock(`${current.facts}.lock`, { purpose: "content-fact-record" });
  try {
    const value = readJson(current.facts);
    const task = value.tasks?.find((item) => item.id === factId);
    if (!task) throw new Error(`事实任务不存在：${factId}`);
    Object.assign(task, { status, evidence: evidence ? [evidence] : [], reason, reviewer: name, reviewedAt: now() });
    value.summary = {
      total: value.tasks.length,
      pending: value.tasks.filter((item) => !["verified", "waived_with_reason"].includes(item.status)).length,
      verified: value.tasks.filter((item) => item.status === "verified").length,
    };
    writeJsonAtomic(current.facts, value);
    return contentProjectStatus(current.root);
  } finally { release(); }
}

export function recordContentAsset(input, {
  assetId, status, evidence = null, reason = null, reviewer,
} = {}) {
  const current = files(input);
  if (!["resolved", "waived_with_reason"].includes(status)) throw new Error("asset status 必须为 resolved 或 waived_with_reason");
  const name = required(reviewer, "reviewer");
  if (status === "resolved") required(evidence, "evidence");
  if (status === "waived_with_reason") required(reason, "reason");
  const release = acquireFileLock(`${current.inbox}.lock`, { purpose: "content-asset-record" });
  try {
    const value = readJson(current.inbox);
    const item = value.items?.find((entry) => entry.id === assetId);
    if (!item) throw new Error(`内容素材项不存在：${assetId}`);
    Object.assign(item, { status, evidence, reason, reviewer: name, reviewedAt: now() });
    writeJsonAtomic(current.inbox, value);
    return contentProjectStatus(current.root);
  } finally { release(); }
}

export function approveContentProject(input, { reviewer, evidence } = {}) {
  const current = files(input);
  const status = contentProjectStatus(current.root);
  if (status.status !== "ready_for_approval") throw new Error("事实或素材任务尚未解决，不能批准录制");
  const name = required(reviewer, "reviewer");
  const proof = required(evidence, "evidence");
  const release = acquireFileLock(`${current.spine}.lock`, { purpose: "content-approve" });
  try {
    const spine = readJson(current.spine);
    if (!Array.isArray(spine.sections) || spine.sections.length === 0) throw new Error("content spine 没有可录制段落");
    spine.status = "approved_for_recording";
    spine.approval = { reviewer: name, evidence: proof, approvedAt: now() };
    writeJsonAtomic(current.spine, spine);
    const handoffFile = path.join(current.root, "contracts", "source-edit-handoff.json");
    const handoff = readJson(handoffFile);
    handoff.status = "ready_for_source_media";
    handoff.contentApproval = spine.approval;
    writeJsonAtomic(handoffFile, handoff);
    return contentProjectStatus(current.root);
  } finally { release(); }
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
function main(args) {
  const [command, input] = args;
  let result;
  if (command === "status") result = contentProjectStatus(input);
  else if (command === "record-fact") result = recordContentFact(input, { factId: option(args, "--fact"), status: option(args, "--status"), evidence: option(args, "--evidence"), reason: option(args, "--reason"), reviewer: option(args, "--reviewer") });
  else if (command === "record-asset") result = recordContentAsset(input, { assetId: option(args, "--asset"), status: option(args, "--status"), evidence: option(args, "--evidence"), reason: option(args, "--reason"), reviewer: option(args, "--reviewer") });
  else if (command === "approve") result = approveContentProject(input, { reviewer: option(args, "--reviewer"), evidence: option(args, "--evidence") });
  else throw new Error("用法：content_project.mjs status|record-fact|record-asset|approve PROJECT [options]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
