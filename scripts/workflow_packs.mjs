#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = args[0];
const defaultRegistry = path.join(scriptDirectory, "..", "config", "workflow-packs.json");
const knownCommands = new Set([
  "reference", "start", "transcribe", "media", "corpus", "handoff", "visual-evidence", "captions", "timeline",
  "run", "resume", "status", "gate-plan", "gate-render", "qc", "gate-candidate", "gate-release", "capabilities", "cost", "flight", "composition",
  "whiteboard"
]);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}
function fail(message, code = 1) {
  console.error(JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2));
  process.exit(code);
}
function registry() {
  const file = path.resolve(option("--registry", defaultRegistry));
  if (!fs.existsSync(file)) fail(`workflow registry does not exist: ${file}`, 2);
  return { file, value: readJson(file) };
}
function validate(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["workflow registry root must be an object"];
  if (value.schemaVersion !== "1.0" || value.kind !== "kacha-workflow-pack-registry") errors.push("invalid registry identity");
  if (!Array.isArray(value.packs) || value.packs.length === 0) errors.push("packs must not be empty");
  const ids = new Set();
  for (const pack of value.packs ?? []) {
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) { errors.push("every pack must be an object"); continue; }
    if (!pack.id || ids.has(pack.id)) errors.push(`duplicate or missing pack id: ${pack.id}`);
    ids.add(pack.id);
    for (const field of ["version", "label", "intent", "requiredInputs", "humanGates", "steps", "exitGates", "prohibitions"]) if (pack[field] === undefined) errors.push(`${pack.id}.${field} is required`);
    for (const field of ["requiredInputs", "humanGates", "steps", "exitGates", "prohibitions"]) if (!Array.isArray(pack[field]) || pack[field].length === 0) errors.push(`${pack.id}.${field} must be a non-empty array`);
    const requiredInputs = Array.isArray(pack.requiredInputs) ? pack.requiredInputs : [];
    if (new Set(requiredInputs).size !== requiredInputs.length || requiredInputs.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key))) errors.push(`${pack.id}.requiredInputs must contain unique uppercase identifiers`);
    for (const field of ["humanGates", "exitGates", "prohibitions"]) {
      if (Array.isArray(pack[field]) && pack[field].some((item) => typeof item !== "string" || !item.trim())) errors.push(`${pack.id}.${field} must contain non-empty strings`);
    }
    const stepIds = new Set();
    const steps = Array.isArray(pack.steps) ? pack.steps : [];
    for (const step of steps) {
      if (!step || typeof step !== "object" || Array.isArray(step)) { errors.push(`${pack.id}: every step must be an object`); continue; }
      if (!step.id || stepIds.has(step.id)) errors.push(`${pack.id}: duplicate or missing step id ${step.id}`);
      stepIds.add(step.id);
      if (typeof step.command !== "string" || /[\0\r\n]/.test(step.command)) { errors.push(`${pack.id}.${step.id}: command must be a single-line string`); continue; }
      const match = /^kacha\s+([a-z0-9-]+)(?:\s|$)/.exec(step.command);
      if (!match) errors.push(`${pack.id}.${step.id}: command must start with kacha`);
      else if (!knownCommands.has(match[1])) errors.push(`${pack.id}.${step.id}: unknown Kacha command ${match[1]}`);
      const templateFree = step.command.replace(/\{\{[A-Z0-9_]+\}\}/g, "VALUE");
      if (/[;&|`$<>\\]/.test(templateFree)) errors.push(`${pack.id}.${step.id}: shell control operators are not allowed in workflow commands`);
    }
    const placeholders = new Set(steps.flatMap((step) => typeof step.command === "string" ? [...step.command.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1]) : []));
    for (const placeholder of placeholders) if (!requiredInputs.includes(placeholder)) errors.push(`${pack.id}: placeholder ${placeholder} is not declared`);
    for (const required of requiredInputs) if (!placeholders.has(required)) errors.push(`${pack.id}: required input ${required} is not used by a step`);
  }
  return errors;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

if (!new Set(["validate", "list", "show", "resolve"]).has(action)) fail("usage: kacha.mjs workflows validate|list|show|resolve [options]", 2);
const { file, value } = registry();
const errors = validate(value);
if (errors.length) fail(errors.join("; "));
if (path.resolve(file) !== path.resolve(defaultRegistry) && action === "resolve") {
  fail("custom workflow registries are read-only; resolve only accepts the governed built-in registry", 2);
}
if (action === "validate") {
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", registry: file, packs: value.packs.length, digest: sha256Value(value) }, null, 2));
  process.exit(0);
}
if (action === "list") {
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", packs: value.packs.map(({ id, version, label, intent }) => ({ id, version, label, intent })) }, null, 2));
  process.exit(0);
}
const packId = option("--pack") ?? args[1];
const pack = value.packs.find((item) => item.id === packId);
if (!pack) fail(`workflow pack does not exist: ${packId}`, 2);
if (action === "show") {
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", pack }, null, 2));
  process.exit(0);
}
const varsFile = option("--vars");
const output = option("--output");
if (!varsFile || !output) fail("resolve requires --vars and --output", 2);
const variables = readJson(path.resolve(varsFile));
if (!variables || typeof variables !== "object" || Array.isArray(variables)) fail("workflow variables must be a JSON object", 2);
const invalidVariables = pack.requiredInputs.filter((key) => {
  const value = variables[key];
  return value !== undefined && value !== null && (typeof value === "object" || /[\0\r\n]/.test(String(value)));
});
if (invalidVariables.length) fail(`workflow variables must be single-line scalar values: ${invalidVariables.join(", ")}`, 2);
if (path.resolve(output) === path.resolve(varsFile) || path.resolve(output) === path.resolve(file)) fail("workflow output must not overwrite its variables or registry", 2);
const unresolved = [];
const steps = pack.steps.map((step) => ({
  ...step,
  command: step.command.replace(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, key) => {
    if (variables[key] === undefined || variables[key] === null || variables[key] === "") { unresolved.push(key); return placeholder; }
    return shellQuote(variables[key]);
  })
}));
const resolved = {
  schemaVersion: "1.0",
  kind: "kacha-workflow-pack-instance",
  status: unresolved.length ? "blocked" : "ready",
  pack: { id: pack.id, version: pack.version, registryDigest: sha256Value(value) },
  resolvedAt: new Date().toISOString(),
  humanGates: pack.humanGates,
  steps,
  exitGates: pack.exitGates,
  prohibitions: pack.prohibitions,
  unresolved: [...new Set(unresolved)],
  executionBoundary: "This is an auditable, POSIX-shell-quoted command checklist. Existing Kacha commands remain the only executors."
};
resolved.instanceDigest = sha256Value(resolved);
writeJsonAtomic(output, resolved);
console.log(JSON.stringify({ schemaVersion: "1.0", status: resolved.status, output: path.resolve(output), pack: resolved.pack, unresolved: resolved.unresolved, instanceDigest: resolved.instanceDigest }, null, 2));
process.exit(unresolved.length ? 1 : 0);
