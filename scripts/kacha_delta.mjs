#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  compactValue,
  ensureFile,
  estimateTokens,
  fail,
  getAtPointer,
  inferObjectType,
  jsonIdentity,
  mergeAtPointer,
  now,
  objectSummary,
  option,
  removeAtPointer,
  setAtPointer,
  shortDigest,
  stableObjectId,
  writeJson,
} from "./agent_workspace_utils.mjs";
import { readJson, sha256File, sha256Value } from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const action = args[0];

function usage() {
  fail(
    "KACHA-E140",
    "用法：kacha.mjs delta diff BEFORE.json AFTER.json [--output delta.json]\n"
      + "  kacha.mjs delta apply TARGET.json MUTATION.json "
      + "--write RESULT.json [--output delta.json] [--in-place]",
    2,
  );
}

function collectDiff(before, after, pointer = "", changes = []) {
  if (Object.is(before, after)) return changes;
  const beforeObject = before !== null && typeof before === "object";
  const afterObject = after !== null && typeof after === "object";
  if (
    !beforeObject
    || !afterObject
    || Array.isArray(before) !== Array.isArray(after)
  ) {
    changes.push({ op: "replace", pointer, before, after });
    return changes;
  }
  if (Array.isArray(before)) {
    const beforeIds = before.map((item) => item?.id);
    const afterIds = after.map((item) => item?.id);
    const idAware = [...beforeIds, ...afterIds].every(
      (id) => typeof id === "string" && id.trim() !== "",
    ) && new Set(beforeIds).size === beforeIds.length
      && new Set(afterIds).size === afterIds.length;
    if (idAware) {
      const beforeById = new Map(beforeIds.map((id, index) => [id, index]));
      const afterById = new Map(afterIds.map((id, index) => [id, index]));
      for (const [id, index] of [...beforeById.entries()].reverse()) {
        if (!afterById.has(id)) {
          changes.push({
            op: "remove",
            pointer: `${pointer}/${index}`,
            before: before[index],
          });
        }
      }
      for (const [id, index] of afterById.entries()) {
        if (!beforeById.has(id)) {
          changes.push({
            op: "add",
            pointer: `${pointer}/${index}`,
            after: after[index],
          });
          continue;
        }
        const beforeIndex = beforeById.get(id);
        if (beforeIndex !== index) {
          changes.push({
            op: "move",
            pointer: `${pointer}/${index}`,
            fromPointer: `${pointer}/${beforeIndex}`,
            before: before[beforeIndex],
            after: after[index],
          });
        }
        collectDiff(before[beforeIndex], after[index], `${pointer}/${index}`, changes);
      }
      return changes;
    }
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
      const child = `${pointer}/${index}`;
      if (index >= before.length) changes.push({ op: "add", pointer: child, after: after[index] });
      else if (index >= after.length) changes.push({ op: "remove", pointer: child, before: before[index] });
      else collectDiff(before[index], after[index], child, changes);
    }
    return changes;
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
    const child = `${pointer}/${escaped}`;
    if (!Object.hasOwn(before, key)) changes.push({ op: "add", pointer: child, after: after[key] });
    else if (!Object.hasOwn(after, key)) changes.push({ op: "remove", pointer: child, before: before[key] });
    else collectDiff(before[key], after[key], child, changes);
  }
  return changes;
}

function affectedLayer(pointer) {
  const match = /^\/(visual|audio|edl|output|contracts|plans|outputs|expectedMedia)(?:\/|$)/
    .exec(pointer);
  return match?.[1] ?? "contract";
}

function nearestObject(root, pointer) {
  const parts = pointer.split("/").filter(Boolean);
  for (let length = parts.length; length >= 0; length -= 1) {
    const candidatePointer = length === 0 ? "" : `/${parts.slice(0, length).join("/")}`;
    const value = getAtPointer(root, candidatePointer);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (
        value.id !== undefined
        || value.effectId !== undefined
        || value.start !== undefined
        || value.time !== undefined
      ) {
        return { pointer: candidatePointer, value };
      }
    }
  }
  return null;
}

function deltaReport(
  beforeFile,
  afterFile,
  before,
  after,
  changes,
  mutation = null,
  identities = null,
) {
  const details = changes.map((change) => {
    const object = change.op === "remove"
      ? nearestObject(before, change.pointer)
      : nearestObject(after, change.pointer) ?? nearestObject(before, change.pointer);
    const type = inferObjectType(object?.pointer ?? change.pointer, object?.value, afterFile);
    return {
      op: change.op,
      pointer: change.pointer,
      fromPointer: change.fromPointer ?? null,
      objectRef: object ? stableObjectId(type, object.value, object.pointer) : null,
      beforeDigest: change.before === undefined ? null : sha256Value(change.before),
      afterDigest: change.after === undefined ? null : sha256Value(change.after),
      before: compactValue(change.before),
      after: compactValue(change.after),
    };
  });
  const report = {
    schemaVersion: "1.0",
    generatedAt: now(),
    status: "pass",
    before: identities?.before ?? jsonIdentity(beforeFile),
    after: identities?.after ?? jsonIdentity(afterFile),
    mutation: mutation
      ? {
          path: mutation,
          sha256: sha256File(mutation),
        }
      : null,
    summary: {
      changed: changes.length,
      added: changes.filter((entry) => entry.op === "add").length,
      removed: changes.filter((entry) => entry.op === "remove").length,
      replaced: changes.filter((entry) => entry.op === "replace").length,
      moved: changes.filter((entry) => entry.op === "move").length,
      truncatedDetails: 0,
      affectedLayers: [...new Set(changes.map((entry) => affectedLayer(entry.pointer)))],
      affectedObjects: [...new Set(details.map((entry) => entry.objectRef).filter(Boolean))],
    },
    changes: details,
    contextContract: {
      readAfterPointers: [...new Set(
        changes
          .filter((entry) => entry.op !== "remove")
          .map((entry) => entry.pointer),
      )].slice(0, 40),
      readWholeAfter: changes.length > 120,
      doNotReloadBefore: true,
    },
  };
  const fullTokens = estimateTokens(after);
  const deltaTokens = estimateTokens(report);
  report.tokenBudget = {
    fullSnapshotEstimatedTokens: fullTokens,
    mutationDeltaEstimatedTokens: deltaTokens,
    estimatedReductionRatio: fullTokens > 0
      ? Number(Math.max(0, 1 - deltaTokens / fullTokens).toFixed(4))
      : 0,
  };
  report.digest = sha256Value({
    before: report.before.sha256,
    after: report.after.sha256,
    changes: details.map(({ op, pointer, fromPointer, beforeDigest, afterDigest }) => ({
      op,
      pointer,
      fromPointer,
      beforeDigest,
      afterDigest,
    })),
  });
  return report;
}

if (!["diff", "apply"].includes(action)) usage();

if (action === "diff") {
  const beforeFile = ensureFile(args[1], "before JSON");
  const afterFile = ensureFile(args[2], "after JSON");
  let before;
  let after;
  try {
    before = readJson(beforeFile);
    after = readJson(afterFile);
  } catch (error) {
    fail("KACHA-E140", `JSON 无法解析：${error.message}`, 2);
  }
  const report = deltaReport(
    beforeFile,
    afterFile,
    before,
    after,
    collectDiff(before, after),
  );
  const requestedOutput = option(args, "--output");
  const consoleLimit = 20;
  const consoleOmitted = Math.max(0, report.changes.length - consoleLimit);
  const output = requestedOutput
    ?? (consoleOmitted > 0 || report.summary.truncatedDetails > 0
      ? `${afterFile}.mutation-delta.json`
      : null);
  if (output) writeJson(output, report);
  console.log(JSON.stringify({
    ...report,
    changes: report.changes.slice(0, consoleLimit),
    responseWindow: {
      returnedChanges: Math.min(report.changes.length, consoleLimit),
      omittedChanges: consoleOmitted + report.summary.truncatedDetails,
      truncated: consoleOmitted > 0 || report.summary.truncatedDetails > 0,
    },
    fullReport: output ? path.resolve(output) : null,
  }, null, 2));
  process.exit(0);
}

const targetFile = ensureFile(args[1], "目标 JSON");
const mutationFile = ensureFile(args[2], "mutation 合同");
const inPlace = args.includes("--in-place");
const writeTarget = inPlace ? targetFile : option(args, "--write");
if (!writeTarget) usage();
let target;
let mutation;
try {
  target = readJson(targetFile);
  mutation = readJson(mutationFile);
} catch (error) {
  fail("KACHA-E140", `JSON 无法解析：${error.message}`, 2);
}
if (
  mutation.schemaVersion !== "1.0"
  || !Array.isArray(mutation.operations)
  || mutation.operations.length === 0
  || mutation.operations.length > 200
) {
  fail("KACHA-E140", "mutation 必须是 schemaVersion=1.0 且包含 1–200 个 operations", 2);
}
const actualBase = sha256File(targetFile);
const beforeIdentity = jsonIdentity(targetFile);
if (mutation.baseSha256 && mutation.baseSha256 !== actualBase) {
  fail("KACHA-E110", `mutation.baseSha256 与当前目标不一致：${actualBase}`);
}
let next = structuredClone(target);
try {
  for (const [index, operation] of mutation.operations.entries()) {
    if (!["add", "replace", "remove", "merge"].includes(operation.op)) {
      throw new Error(`operations[${index}].op 不支持：${operation.op}`);
    }
    if (typeof operation.path !== "string") {
      throw new Error(`operations[${index}].path 缺失`);
    }
    if (operation.op === "add") {
      next = setAtPointer(next, operation.path, operation.value, { add: true });
    } else if (operation.op === "replace") {
      next = setAtPointer(next, operation.path, operation.value);
    } else if (operation.op === "remove") {
      next = removeAtPointer(next, operation.path);
    } else {
      next = mergeAtPointer(next, operation.path, operation.value);
    }
  }
} catch (error) {
  fail("KACHA-E140", `mutation 无法安全应用：${error.message}`);
}
const resolvedWrite = path.resolve(writeTarget);
if (!inPlace && resolvedWrite === targetFile) {
  fail("KACHA-E120", "覆盖目标必须显式使用 --in-place");
}
writeJson(resolvedWrite, next);
const changes = collectDiff(target, next);
const report = deltaReport(
  targetFile,
  resolvedWrite,
  target,
  next,
  changes,
  mutationFile,
  {
    before: beforeIdentity,
    after: jsonIdentity(resolvedWrite),
  },
);
report.application = {
  mode: inPlace ? "atomic_in_place" : "new_file",
  operationsRequested: mutation.operations.length,
  mutationId: `mut-${shortDigest({
    target: actualBase,
    mutation: sha256File(mutationFile),
  })}`,
};
const output = option(args, "--output", `${resolvedWrite}.mutation-delta.json`);
writeJson(output, report);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: "pass",
  target: resolvedWrite,
  targetSha256: sha256File(resolvedWrite),
  delta: path.resolve(output),
  mutationId: report.application.mutationId,
  summary: report.summary,
  tokenBudget: report.tokenBudget,
  nextReads: report.contextContract.readAfterPointers.slice(0, 12),
}, null, 2));
