#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}
function flag(name) { return args.includes(name); }
function list(name) { return String(option(name, "")).split(",").map((item) => item.trim()).filter(Boolean); }
function fail(message, code = 1) {
  console.error(JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2));
  process.exit(code);
}

function validateRequest(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["composition request root must be an object"];
  if (value.schemaVersion !== "1.0" || value.kind !== "kacha-composition-request") errors.push("invalid request identity");
  if (!new Set(["series", "hero"]).has(value.mode)) errors.push("mode must be series or hero");
  if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.length === 0) errors.push("requiredCapabilities must not be empty");
  else if (new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length || value.requiredCapabilities.some((item) => typeof item !== "string" || !item.trim())) errors.push("requiredCapabilities must contain unique non-empty strings");
  if (!value.constraints || typeof value.constraints !== "object" || Array.isArray(value.constraints)) errors.push("constraints are required");
  else {
    for (const key of ["localOnly", "externalUploadAllowed", "knownCostRequired"]) if (typeof value.constraints[key] !== "boolean") errors.push(`constraints.${key} must be boolean`);
    if (!new Set(["preview", "final"]).has(value.constraints.renderMode)) errors.push("constraints.renderMode must be preview or final");
    if (value.constraints.localOnly && value.constraints.externalUploadAllowed) errors.push("localOnly cannot be combined with externalUploadAllowed");
  }
  return errors;
}

function validateDecision(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["composition decision root must be an object"];
  if (value.schemaVersion !== "1.0" || value.kind !== "kacha-composition-decision") errors.push("invalid decision identity");
  if (!new Set(["pass", "blocked"]).has(value.status)) errors.push("invalid decision status");
  if (!value.request || !Array.isArray(value.alternatives)) errors.push("request and alternatives are required");
  else errors.push(...validateRequest(value.request).map((error) => `request: ${error}`));
  if (value.status === "pass" && !value.chosenEngine) errors.push("passing decision requires chosenEngine");
  if (value.status === "blocked" && (value.chosenEngine || value.engineHandoff)) errors.push("blocked decision cannot contain an engine handoff");
  const providerIds = new Set();
  for (const alternative of value.alternatives ?? []) {
    if (!alternative?.providerId || providerIds.has(alternative.providerId)) errors.push("alternatives must have unique providerId values");
    providerIds.add(alternative?.providerId);
    if (typeof alternative?.eligible !== "boolean" || !Array.isArray(alternative?.exclusions)) errors.push(`${alternative?.providerId ?? "unknown"}: invalid alternative`);
  }
  if (value.status === "pass") {
    const chosen = (value.alternatives ?? []).find((item) => item.providerId === value.chosenEngine);
    if (!chosen || chosen.eligible !== true || chosen.exclusions.length > 0) errors.push("chosenEngine must reference an eligible exclusion-free alternative");
    if (value.engineHandoff?.providerId !== value.chosenEngine || value.engineHandoff?.renderMode !== value.request?.constraints?.renderMode) errors.push("engineHandoff does not match the chosen engine or render mode");
  }
  if (!value.capabilityDecisionDigest) errors.push("capabilityDecisionDigest is required");
  if (value.silentFallbackAllowed !== false) errors.push("silentFallbackAllowed must be false");
  if (!/^[a-f0-9]{64}$/i.test(value.decisionDigest ?? "")) errors.push("decisionDigest is required");
  if (value.decisionDigest) {
    const copy = structuredClone(value);
    delete copy.decisionDigest;
    if (value.decisionDigest !== sha256Value(copy)) errors.push("decisionDigest mismatch");
  }
  return errors;
}

if (!new Set(["template", "route", "validate"]).has(action)) fail("usage: kacha.mjs composition template|route|validate [options]", 2);

if (action === "template") {
  const output = option("--output");
  if (!output) fail("template requires --output", 2);
  const value = {
    schemaVersion: "1.0",
    kind: "kacha-composition-request",
    mode: option("--mode", "series"),
    requiredCapabilities: list("--requires").length ? list("--requires") : ["video-compose"],
    constraints: {
      localOnly: !flag("--allow-external"),
      externalUploadAllowed: flag("--allow-external-upload"),
      knownCostRequired: !flag("--allow-unknown-cost"),
      renderMode: option("--render-mode", "final")
    },
    rationale: option("--rationale", "explicit production-mode request")
  };
  const errors = validateRequest(value);
  if (errors.length) fail(errors.join("; "));
  writeJsonAtomic(output, value);
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", output: path.resolve(output), request: value }, null, 2));
  process.exit(0);
}

if (action === "validate") {
  const input = option("--input") ?? args[1];
  if (!input) fail("validate requires --input", 2);
  const value = readJson(path.resolve(input));
  const errors = value?.kind === "kacha-composition-request" ? validateRequest(value) : validateDecision(value);
  if (errors.length) fail(errors.join("; "));
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", input: path.resolve(input), kind: value.kind, digest: sha256Value(value) }, null, 2));
  process.exit(0);
}

let request;
const input = option("--input");
if (input) request = readJson(path.resolve(input));
else {
  const mode = option("--mode");
  if (!mode) fail("route requires --input or --mode", 2);
  const capabilities = list("--requires");
  request = {
    schemaVersion: "1.0",
    kind: "kacha-composition-request",
    mode,
    requiredCapabilities: capabilities.length ? capabilities : ["video-compose"],
    constraints: {
      localOnly: !flag("--allow-external"),
      externalUploadAllowed: flag("--allow-external-upload"),
      knownCostRequired: !flag("--allow-unknown-cost"),
      renderMode: option("--render-mode", "final")
    },
    rationale: option("--rationale", "explicit production-mode request")
  };
}
const requestErrors = validateRequest(request);
if (requestErrors.length) fail(requestErrors.join("; "));
const [primary, ...additional] = request.requiredCapabilities;
const brokerArgs = [path.join(scriptDirectory, "capability_broker.mjs"), "rank", "--capability", primary, "--modes", request.mode];
if (additional.length) brokerArgs.push("--require-capabilities", additional.join(","));
if (request.constraints.localOnly) brokerArgs.push("--local-only");
if (request.constraints.externalUploadAllowed) brokerArgs.push("--allow-external-upload");
if (request.constraints.knownCostRequired) brokerArgs.push("--require-known-cost");
const result = spawnSync(process.execPath, brokerArgs, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
let broker;
try { broker = JSON.parse(result.stdout || result.stderr); }
catch { fail(`capability broker returned invalid output: ${String(result.stderr).slice(0, 240)}`); }
if (!["pass", "blocked"].includes(broker.status) || (result.status === 0) !== (broker.status === "pass")) fail("capability broker status and process result disagree");
const decision = {
  schemaVersion: "1.0",
  kind: "kacha-composition-decision",
  status: broker.status,
  decidedAt: new Date().toISOString(),
  request,
  chosenEngine: broker.chosenProviderId ?? null,
  alternatives: broker.alternatives ?? [],
  capabilityDecisionDigest: broker.decisionDigest ?? null,
  silentFallbackAllowed: false,
  changePolicy: "If the chosen engine becomes unavailable, create a new decision and require explicit plan review; never silently substitute.",
  engineHandoff: broker.chosenProviderId ? {
    providerId: broker.chosenProviderId,
    renderMode: request.constraints.renderMode,
    next: "Compile through existing Kacha Timeline IR and render gates."
  } : null
};
decision.decisionDigest = sha256Value(decision);
const decisionErrors = validateDecision(decision);
if (decisionErrors.length) fail(decisionErrors.join("; "));
const output = option("--output");
if (output) writeJsonAtomic(output, decision);
console.log(JSON.stringify({ ...decision, output: output ? path.resolve(output) : null }, null, 2));
process.exit(decision.status === "pass" ? 0 : 1);
