#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const defaultRegistry = path.join(scriptDirectory, "..", "config", "capabilities", "provider-registry.json");
const allowedProbeCommands = new Set(["ffmpeg", "ffprobe", "xcrun"]);
const trustedProbeRoots = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const trustedProbePrefixes = ["/usr/bin", "/bin", "/usr/local", "/opt/homebrew"];
const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function flag(name) { return args.includes(name); }

function fail(message, code = 1) {
  console.error(JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2));
  process.exit(code);
}

function loadRegistry() {
  const file = path.resolve(option("--registry", defaultRegistry));
  if (!fs.existsSync(file)) fail(`registry does not exist: ${file}`, 2);
  return { file, value: readJson(file) };
}

function validateRegistry(registry) {
  const errors = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return ["provider registry root must be an object"];
  if (registry.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (!Array.isArray(registry.providers) || registry.providers.length === 0) errors.push("providers must not be empty");
  const ids = new Set();
  const required = ["id", "version", "maturity", "capabilities", "runtime", "privacy", "license", "sideEffects", "determinism", "resume", "retry", "supportedModes", "costModel", "scores"];
  const weights = registry.policy?.weights;
  if (!Number.isFinite(registry.policy?.evidenceMaxAgeHours) || registry.policy.evidenceMaxAgeHours <= 0) {
    errors.push("policy.evidenceMaxAgeHours must be > 0");
  }
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) errors.push("policy.weights must be an object");
  for (const [index, provider] of (registry.providers ?? []).entries()) {
    for (const field of required) if (provider[field] === undefined) errors.push(`providers[${index}].${field} is required`);
    if (ids.has(provider.id)) errors.push(`duplicate provider id: ${provider.id}`);
    ids.add(provider.id);
    if (!Array.isArray(provider.capabilities) || provider.capabilities.length === 0) errors.push(`${provider.id}.capabilities must not be empty`);
    else if (provider.capabilities.some((item) => typeof item !== "string" || !item.trim())) errors.push(`${provider.id}.capabilities must contain non-empty strings`);
    if (!Array.isArray(provider.supportedModes) || provider.supportedModes.length === 0) errors.push(`${provider.id}.supportedModes must not be empty`);
    else if (provider.supportedModes.some((item) => typeof item !== "string" || !item.trim())) errors.push(`${provider.id}.supportedModes must contain non-empty strings`);
    if (!Array.isArray(provider.sideEffects) || provider.sideEffects.some((item) => typeof item !== "string" || !item.trim())) errors.push(`${provider.id}.sideEffects must be an array of strings`);
    if (!new Set(["local", "external-upload"]).has(provider.privacy)) errors.push(`${provider.id}.privacy is invalid`);
    if (!provider.license || typeof provider.license.use !== "string" || !provider.license.use) errors.push(`${provider.id}.license.use is required`);
    if (![true, false].includes(provider.resume) || ![true, false].includes(provider.retry)) errors.push(`${provider.id}.resume and retry must be booleans`);
    const runtime = provider.runtime;
    if (!runtime || !new Set(["binary", "platform", "environment", "path", "workspace-binary"]).has(runtime.kind)) errors.push(`${provider.id}.runtime.kind is invalid`);
    if (["binary", "platform"].includes(runtime?.kind) && (!allowedProbeCommands.has(runtime.command) || !Array.isArray(runtime.probeArgs))) errors.push(`${provider.id}.runtime command or probeArgs is invalid`);
    if (runtime?.kind === "platform" && (typeof runtime.platform !== "string" || !runtime.platform)) errors.push(`${provider.id}.runtime.platform is required`);
    if (["environment", "path"].includes(runtime?.kind) && !/^[A-Z_][A-Z0-9_]*$/.test(runtime.environment ?? "")) errors.push(`${provider.id}.runtime.environment is invalid`);
    if (runtime?.kind === "workspace-binary" && (typeof runtime.path !== "string" || !runtime.path || path.isAbsolute(runtime.path) || !Array.isArray(runtime.probeArgs))) errors.push(`${provider.id}.workspace binary definition is invalid`);
    if (!provider.costModel || typeof provider.costModel.kind !== "string" || typeof provider.costModel.currency !== "string" || (provider.costModel.unitCost !== null && (!Number.isFinite(provider.costModel.unitCost) || provider.costModel.unitCost < 0))) errors.push(`${provider.id}.costModel is invalid`);
    for (const dimension of Object.keys(weights ?? {})) {
      const value = dimension === "taskFit" ? 1 : provider.scores?.[dimension];
      if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`${provider.id}.scores.${dimension} must be 0..1`);
    }
  }
  for (const [dimension, weight] of Object.entries(weights ?? {})) {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) errors.push(`policy.weights.${dimension} must be 0..1`);
  }
  const weightTotal = Object.values(weights ?? {}).reduce((sum, value) => sum + Number(value), 0);
  if (Math.abs(weightTotal - 1) > 0.000001) errors.push(`policy.weights must sum to 1, got ${weightTotal}`);
  return errors;
}

function trustedCommand(command) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : trustedProbeRoots.map((root) => path.join(root, command));
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const real = fs.realpathSync(candidate);
      if (trustedProbePrefixes.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) return real;
    } catch {
      // Missing or unreadable candidates are simply unavailable.
    }
  }
  return null;
}

function probe(provider) {
  const runtime = provider.runtime ?? {};
  const checkedAt = new Date().toISOString();
  if (runtime.kind === "platform" && runtime.platform !== process.platform) {
    return { providerId: provider.id, available: false, checkedAt, reason: `platform_mismatch:${process.platform}` };
  }
  if (["environment", "path"].includes(runtime.kind)) {
    const value = process.env[runtime.environment];
    const available = Boolean(value) && (runtime.kind !== "path" || fs.existsSync(path.resolve(value)));
    return { providerId: provider.id, available, checkedAt, reason: available ? "environment_present" : "environment_missing" };
  }
  if (runtime.kind === "workspace-binary") {
    const command = path.resolve(skillDirectory, runtime.path ?? "");
    if (command !== skillDirectory && !command.startsWith(`${skillDirectory}${path.sep}`)) {
      return { providerId: provider.id, available: false, checkedAt, reason: "workspace_binary_outside_skill" };
    }
    if (!fs.existsSync(command) || !fs.statSync(command).isFile()) {
      return { providerId: provider.id, available: false, checkedAt, reason: "workspace_binary_missing" };
    }
    const realCommand = fs.realpathSync(command);
    if (realCommand !== skillDirectory && !realCommand.startsWith(`${skillDirectory}${path.sep}`)) {
      return { providerId: provider.id, available: false, checkedAt, reason: "workspace_binary_symlink_outside_skill" };
    }
    const result = spawnSync(realCommand, runtime.probeArgs ?? ["--version"], { encoding: "utf8", timeout: 5000 });
    return {
      providerId: provider.id,
      available: result.status === 0,
      checkedAt,
      reason: result.status === 0 ? "probe_passed" : `probe_failed:${result.status ?? "unknown"}`,
      versionEvidence: result.status === 0 ? String(result.stdout || result.stderr).split(/\r?\n/)[0].slice(0, 240) : null
    };
  }
  if (["binary", "platform"].includes(runtime.kind)) {
    if (!allowedProbeCommands.has(runtime.command)) {
      return { providerId: provider.id, available: false, checkedAt, reason: "probe_command_not_allowed" };
    }
    const command = trustedCommand(runtime.command);
    if (!command) return { providerId: provider.id, available: false, checkedAt, reason: "trusted_command_missing" };
    const result = spawnSync(command, runtime.probeArgs ?? ["--version"], { encoding: "utf8", timeout: 5000 });
    return {
      providerId: provider.id,
      available: result.status === 0,
      checkedAt,
      reason: result.status === 0 ? "probe_passed" : result.error?.code === "ENOENT" ? "command_missing" : `probe_failed:${result.status ?? "unknown"}`,
      versionEvidence: result.status === 0 ? String(result.stdout || result.stderr).split(/\r?\n/)[0].slice(0, 240) : null
    };
  }
  return { providerId: provider.id, available: false, checkedAt, reason: `unsupported_runtime:${runtime.kind}` };
}

function requiredList(name) {
  const raw = option(name, "");
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function scoreProvider(provider, request, probeResult, weights) {
  const exclusions = [];
  if (!probeResult.available) exclusions.push(probeResult.reason);
  if (!provider.capabilities.includes(request.capability)) exclusions.push("capability_mismatch");
  for (const capability of request.requiredCapabilities) {
    if (!provider.capabilities.includes(capability)) exclusions.push(`required_capability_missing:${capability}`);
  }
  for (const mode of request.modes) if (!provider.supportedModes.includes(mode)) exclusions.push(`mode_unsupported:${mode}`);
  if (request.localOnly && provider.privacy !== "local") exclusions.push("privacy_requires_local");
  if (!request.allowExternalUpload && provider.sideEffects.includes("external-upload")) exclusions.push("external_upload_not_authorized");
  if (request.deniedLicenses.includes(provider.license?.use)) exclusions.push(`license_denied:${provider.license?.use}`);
  if (request.requireKnownCost && provider.costModel?.unitCost === null) exclusions.push("cost_unknown");
  const requestedCapabilities = [...new Set([request.capability, ...request.requiredCapabilities])];
  const capabilityFit = requestedCapabilities.filter((capability) => provider.capabilities.includes(capability)).length / requestedCapabilities.length;
  const taskFit = capabilityFit * (request.modes.every((mode) => provider.supportedModes.includes(mode)) ? 1 : 0.5);
  const dimensions = { taskFit, ...provider.scores };
  let total = 0;
  for (const [dimension, weight] of Object.entries(weights)) total += Number(dimensions[dimension] ?? 0) * Number(weight);
  return {
    providerId: provider.id,
    eligible: exclusions.length === 0,
    exclusions: [...new Set(exclusions)],
    score: Number(total.toFixed(6)),
    dimensions,
    probe: probeResult,
    evidenceFreshness: {
      status: "current",
      checkedAt: probeResult.checkedAt,
      maximumAgeHours: registry.policy.evidenceMaxAgeHours
    },
    maturity: provider.maturity,
    privacy: provider.privacy,
    costModel: provider.costModel
  };
}

if (!new Set(["validate", "list", "probe", "rank"]).has(action)) {
  fail("usage: kacha.mjs capabilities validate|list|probe|rank [options]", 2);
}

const { file, value: registry } = loadRegistry();
const errors = validateRegistry(registry);
if (errors.length > 0) fail(errors.join("; "));
if (path.resolve(file) !== path.resolve(defaultRegistry) && ["probe", "rank"].includes(action)) {
  fail("custom provider registries are read-only; probe/rank only execute the governed built-in registry", 2);
}

if (action === "validate") {
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", registry: file, providers: registry.providers.length, digest: sha256Value(registry) }, null, 2));
  process.exit(0);
}

if (action === "list") {
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", providers: registry.providers.map((provider) => ({ id: provider.id, maturity: provider.maturity, capabilities: provider.capabilities, privacy: provider.privacy, costModel: provider.costModel })) }, null, 2));
  process.exit(0);
}

const probeResults = registry.providers.map(probe);
if (action === "probe") {
  const output = { schemaVersion: "1.0", status: "pass", observedAt: new Date().toISOString(), results: probeResults };
  const outputFile = option("--output");
  if (outputFile) writeJsonAtomic(outputFile, output);
  console.log(JSON.stringify({ ...output, output: outputFile ? path.resolve(outputFile) : null }, null, 2));
  process.exit(0);
}

const capability = option("--capability");
if (!capability) fail("rank requires --capability", 2);
const request = {
  capability,
  requiredCapabilities: requiredList("--require-capabilities"),
  modes: requiredList("--modes"),
  localOnly: flag("--local-only"),
  allowExternalUpload: flag("--allow-external-upload"),
  requireKnownCost: flag("--require-known-cost"),
  deniedLicenses: requiredList("--deny-license")
};
const results = registry.providers
  .map((provider) => scoreProvider(provider, request, probeResults.find((item) => item.providerId === provider.id), registry.policy.weights))
  .sort((left, right) => Number(right.eligible) - Number(left.eligible) || right.score - left.score || left.providerId.localeCompare(right.providerId));
const chosen = results.find((item) => item.eligible) ?? null;
const decision = {
  schemaVersion: "1.0",
  kind: "kacha-capability-decision",
  status: chosen ? "pass" : "blocked",
  decidedAt: new Date().toISOString(),
  request,
  chosenProviderId: chosen?.providerId ?? null,
  alternatives: results,
  registry: { path: file, digest: sha256Value(registry) },
  decisionDigest: sha256Value({ request, results })
};
const outputFile = option("--output");
if (outputFile) writeJsonAtomic(outputFile, decision);
console.log(JSON.stringify({ ...decision, output: outputFile ? path.resolve(outputFile) : null }, null, 2));
process.exit(chosen ? 0 : 1);
