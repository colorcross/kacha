#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { acquireFileLock, readJson, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function numberOption(name, { required = false, minimum = 0 } = {}) {
  const raw = option(name);
  if (raw === null) {
    if (required) fail(`${name} is required`, 2);
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) fail(`${name} must be a number >= ${minimum}`, 2);
  return value;
}

function fail(message, code = 1) {
  console.error(JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2));
  process.exit(code);
}

const projectRoot = path.resolve(option("--project-root", process.cwd()));
const ledgerFile = path.resolve(option("--ledger", path.join(projectRoot, ".kacha", "cost-ledger.json")));
const lockFile = `${ledgerFile}.lock`;

function initialLedger() {
  const currency = option("--currency", "CNY");
  if (!/^[A-Z]{3}$/.test(currency)) fail("--currency must be a three-letter uppercase code", 2);
  const budget = numberOption("--budget", { required: true });
  const approvalThreshold = numberOption("--approval-threshold") ?? budget;
  return {
    schemaVersion: "1.0",
    kind: "kacha-cost-ledger",
    projectRoot,
    currency,
    budget,
    approvalThreshold,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: [],
    events: []
  };
}

function loadLedger() {
  if (!fs.existsSync(ledgerFile)) fail(`ledger does not exist: ${ledgerFile}; run cost init first`, 2);
  const ledger = readJson(ledgerFile);
  const errors = validateLedger(ledger);
  if (errors.length > 0) fail(errors.join("; "));
  return ledger;
}

function totals(ledger) {
  let reserved = 0;
  let spent = 0;
  let refunded = 0;
  for (const entry of ledger.entries) {
    if (["reserved", "pending_approval", "approved", "reconciliation_required"].includes(entry.status)) reserved += entry.reservedAmount;
    if (["reconciled", "refunded"].includes(entry.status)) spent += entry.actualAmount;
    if (entry.status === "refunded") refunded += entry.refundAmount;
  }
  const netSpent = spent - refunded;
  return {
    budget: ledger.budget,
    reserved: Number(reserved.toFixed(6)),
    grossSpent: Number(spent.toFixed(6)),
    refunded: Number(refunded.toFixed(6)),
    netSpent: Number(netSpent.toFixed(6)),
    available: Number((ledger.budget - reserved - netSpent).toFixed(6))
  };
}

function validateLedger(ledger) {
  const errors = [];
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return ["cost ledger root must be an object"];
  if (ledger.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (ledger.kind !== "kacha-cost-ledger") errors.push("kind must be kacha-cost-ledger");
  if (typeof ledger.projectRoot !== "string" || !path.isAbsolute(ledger.projectRoot)) errors.push("projectRoot must be an absolute path");
  if (typeof ledger.currency !== "string" || !/^[A-Z]{3}$/.test(ledger.currency)) errors.push("currency must be a three-letter uppercase code");
  if (!Number.isFinite(ledger.budget) || ledger.budget < 0) errors.push("budget must be >= 0");
  if (!Number.isFinite(ledger.approvalThreshold) || ledger.approvalThreshold < 0) errors.push("approvalThreshold must be >= 0");
  if (!Array.isArray(ledger.entries) || !Array.isArray(ledger.events)) errors.push("entries and events must be arrays");
  const ids = new Set();
  const states = new Set(["pending_approval", "reserved", "approved", "reconciliation_required", "reconciled", "refunded"]);
  for (const [index, entry] of (Array.isArray(ledger.entries) ? ledger.entries : []).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`entries[${index}] must be an object`);
      continue;
    }
    if (!entry.id || ids.has(entry.id)) errors.push(`duplicate or missing entry id: ${entry.id}`);
    ids.add(entry.id);
    if (!states.has(entry.status)) errors.push(`${entry.id}: invalid status ${entry.status}`);
    if (entry.currency !== ledger.currency) errors.push(`${entry.id}: currency mismatch`);
    if (typeof entry.providerId !== "string" || !entry.providerId || typeof entry.capability !== "string" || !entry.capability) errors.push(`${entry.id}: providerId and capability are required`);
    if (!Number.isFinite(entry.reservedAmount) || entry.reservedAmount < 0) errors.push(`${entry.id}: invalid reservedAmount`);
    const approvalRequired = Number.isFinite(entry.reservedAmount) && entry.reservedAmount >= ledger.approvalThreshold;
    if (entry.approvalRequired !== approvalRequired) errors.push(`${entry.id}: approvalRequired does not match the ledger threshold`);
    if (entry.status === "pending_approval" && entry.approvalRequired !== true) errors.push(`${entry.id}: pending_approval requires approvalRequired=true`);
    if (entry.status === "reserved" && entry.approvalRequired !== false) errors.push(`${entry.id}: reserved entry cannot bypass required approval`);
    if (entry.approvalRequired === true && ["approved", "reconciliation_required", "reconciled", "refunded"].includes(entry.status) && (!entry.approvedAt || !entry.approvalEvidence)) errors.push(`${entry.id}: approved entry requires approval evidence`);
    if (entry.status === "reconciliation_required" && (typeof entry.executionId !== "string" || !entry.executionId || !/^[a-f0-9]{64}$/i.test(entry.executionIntentDigest ?? "") || !entry.executionClaimedAt)) errors.push(`${entry.id}: consumed entry requires execution identity and intent digest`);
    if (["reconciled", "refunded"].includes(entry.status) && (!Number.isFinite(entry.actualAmount) || entry.actualAmount < 0)) errors.push(`${entry.id}: invalid actualAmount`);
    if (!Number.isFinite(entry.refundAmount) || entry.refundAmount < 0) errors.push(`${entry.id}: invalid refundAmount`);
    if (Number.isFinite(entry.actualAmount) && entry.refundAmount > entry.actualAmount) errors.push(`${entry.id}: refundAmount exceeds actualAmount`);
    if (entry.status === "refunded" && !(entry.refundAmount > 0)) errors.push(`${entry.id}: refunded status requires a positive refundAmount`);
  }
  const summary = errors.length === 0 ? totals(ledger) : null;
  if (summary && summary.available < -0.000001) errors.push(`budget exceeded by ${Math.abs(summary.available)}`);
  return errors;
}

function mutate(purpose, callback) {
  const release = acquireFileLock(lockFile, { purpose: `cost-${purpose}` });
  const releaseOnExit = () => release();
  process.once("exit", releaseOnExit);
  try {
    const ledger = loadLedger();
    const result = callback(ledger);
    ledger.updatedAt = new Date().toISOString();
    const errors = validateLedger(ledger);
    if (errors.length > 0) fail(errors.join("; "));
    writeJsonAtomic(ledgerFile, ledger);
    return result;
  } finally {
    process.removeListener("exit", releaseOnExit);
    release();
  }
}

function event(ledger, type, entryId, detail = {}) {
  ledger.events.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type,
    entryId,
    actor: option("--actor", "local-user"),
    detail
  });
}

function findEntry(ledger) {
  const id = option("--id");
  if (!id) fail(`${action} requires --id`, 2);
  const entry = ledger.entries.find((item) => item.id === id);
  if (!entry) fail(`cost entry does not exist: ${id}`, 2);
  return entry;
}

if (!new Set(["init", "estimate", "reserve", "approve", "consume", "reconcile", "refund", "status", "validate"]).has(action)) {
  fail("usage: kacha.mjs cost init|estimate|reserve|approve|consume|reconcile|refund|status|validate [options]", 2);
}

if (action === "init") {
  if (fs.existsSync(ledgerFile) && !args.includes("--force")) fail(`ledger already exists: ${ledgerFile}`, 2);
  const release = acquireFileLock(lockFile, { purpose: "cost-init" });
  const releaseOnExit = () => release();
  process.once("exit", releaseOnExit);
  try {
    const ledger = initialLedger();
    ledger.events.push({ id: crypto.randomUUID(), at: ledger.createdAt, type: "ledger_initialized", entryId: null, actor: option("--actor", "local-user"), detail: { budget: ledger.budget, currency: ledger.currency } });
    const errors = validateLedger(ledger);
    if (errors.length > 0) fail(errors.join("; "));
    writeJsonAtomic(ledgerFile, ledger);
    console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", ledger: ledgerFile, totals: totals(ledger) }, null, 2));
  } finally {
    process.removeListener("exit", releaseOnExit);
    release();
  }
  process.exit(0);
}

if (action === "estimate") {
  const providerId = option("--provider");
  const capability = option("--capability");
  const units = numberOption("--units", { required: true });
  const unitCost = numberOption("--unit-cost", { required: true });
  if (!providerId || !capability) fail("estimate requires --provider and --capability", 2);
  const amount = Number((units * unitCost).toFixed(6));
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", kind: "kacha-cost-estimate", providerId, capability, units, unitCost, amount, currency: option("--currency", "CNY"), assumptions: option("--assumptions", "explicit_cli_rate"), estimateDigest: sha256Value({ providerId, capability, units, unitCost, amount }) }, null, 2));
  process.exit(0);
}

if (action === "validate") {
  const ledger = loadLedger();
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", ledger: ledgerFile, entries: ledger.entries.length, totals: totals(ledger), digest: sha256Value(ledger) }, null, 2));
  process.exit(0);
}

if (action === "status") {
  const ledger = loadLedger();
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", ledger: ledgerFile, currency: ledger.currency, totals: totals(ledger), entries: ledger.entries }, null, 2));
  process.exit(0);
}

if (action === "reserve") {
  const id = option("--id") ?? crypto.randomUUID();
  const providerId = option("--provider");
  const capability = option("--capability");
  const amount = numberOption("--amount", { required: true });
  if (!providerId || !capability) fail("reserve requires --provider and --capability", 2);
  const result = mutate("reserve", (ledger) => {
    if (ledger.entries.some((item) => item.id === id)) fail(`duplicate cost entry id: ${id}`, 2);
    if (option("--currency", ledger.currency) !== ledger.currency) fail(`currency must be ${ledger.currency}`, 2);
    if (amount > totals(ledger).available) fail(`insufficient budget: requested ${amount}, available ${totals(ledger).available}`);
    const approvalRequired = amount >= ledger.approvalThreshold;
    const entry = {
      id,
      providerId,
      capability,
      status: approvalRequired ? "pending_approval" : "reserved",
      currency: ledger.currency,
      reservedAmount: amount,
      actualAmount: null,
      refundAmount: 0,
      approvalRequired,
      estimateRef: option("--estimate-ref"),
      decisionRef: option("--decision-ref"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    ledger.entries.push(entry);
    event(ledger, "cost_reserved", id, { amount, approvalRequired });
    return entry;
  });
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", ledger: ledgerFile, entry: result }, null, 2));
  process.exit(0);
}

if (action === "approve") {
  const result = mutate("approve", (ledger) => {
    const entry = findEntry(ledger);
    if (entry.status !== "pending_approval") fail(`approve requires pending_approval, got ${entry.status}`);
    const evidence = option("--evidence");
    if (!evidence) fail("approve requires --evidence", 2);
    entry.status = "approved";
    entry.approvedAt = new Date().toISOString();
    entry.approvalEvidence = evidence;
    entry.updatedAt = entry.approvedAt;
    event(ledger, "cost_approved", entry.id, { evidence });
    return entry;
  });
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", entry: result }, null, 2));
  process.exit(0);
}

if (action === "consume") {
  const executionId = option("--execution-id") ?? crypto.randomUUID();
  const intentDigest = option("--intent-digest");
  const expectedProvider = option("--provider");
  const expectedCapability = option("--capability");
  if (!intentDigest || !/^[a-f0-9]{64}$/i.test(intentDigest)) fail("consume requires --intent-digest SHA256", 2);
  if (!expectedProvider || !expectedCapability) fail("consume requires --provider and --capability", 2);
  const result = mutate("consume", (ledger) => {
    const entry = findEntry(ledger);
    if (!new Set(["reserved", "approved"]).has(entry.status)) fail(`consume requires an unused reserved or approved entry, got ${entry.status}`);
    if (entry.providerId !== expectedProvider || entry.capability !== expectedCapability) fail("cost entry provider/capability does not match the execution intent");
    if (entry.approvalRequired === true && entry.status !== "approved") fail("cost entry requires approval before execution");
    if (!(entry.reservedAmount > 0)) fail("consume requires a positive reservedAmount; unknown cost cannot be treated as free");
    entry.status = "reconciliation_required";
    entry.executionId = executionId;
    entry.executionIntentDigest = intentDigest;
    entry.executionClaimedAt = new Date().toISOString();
    entry.updatedAt = entry.executionClaimedAt;
    event(ledger, "cost_consumed", entry.id, { executionId, intentDigest });
    return entry;
  });
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", ledger: ledgerFile, entry: result }, null, 2));
  process.exit(0);
}

if (action === "reconcile") {
  const actual = numberOption("--actual", { required: true });
  const result = mutate("reconcile", (ledger) => {
    const entry = findEntry(ledger);
    if (!new Set(["reserved", "approved", "reconciliation_required"]).has(entry.status)) fail(`reconcile requires reserved, approved or reconciliation_required, got ${entry.status}`);
    const before = totals(ledger);
    const extra = Math.max(0, actual - entry.reservedAmount);
    if (extra > before.available) fail(`actual cost exceeds available budget by ${Number((extra - before.available).toFixed(6))}`);
    entry.status = "reconciled";
    entry.actualAmount = actual;
    entry.reconciledAt = new Date().toISOString();
    entry.receiptRef = option("--receipt-ref");
    entry.updatedAt = entry.reconciledAt;
    event(ledger, "cost_reconciled", entry.id, { reserved: entry.reservedAmount, actual });
    return entry;
  });
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", entry: result }, null, 2));
  process.exit(0);
}

if (action === "refund") {
  const amount = numberOption("--amount", { required: true });
  const result = mutate("refund", (ledger) => {
    const entry = findEntry(ledger);
    if (!new Set(["reconciled", "refunded"]).has(entry.status)) fail(`refund requires reconciled entry, got ${entry.status}`);
    if (entry.refundAmount + amount > entry.actualAmount) fail("refund exceeds actual cost");
    entry.refundAmount = Number((entry.refundAmount + amount).toFixed(6));
    entry.status = "refunded";
    entry.updatedAt = new Date().toISOString();
    event(ledger, "cost_refunded", entry.id, { amount, cumulative: entry.refundAmount });
    return entry;
  });
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", entry: result }, null, 2));
}
