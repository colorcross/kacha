#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  compactValue,
  ensureFile,
  fail,
  inferObjectType,
  jsonIdentity,
  normalizeObjectRef,
  now,
  objectSummary,
  option,
  parseObjectRefs,
  safeId,
  stableObjectId,
  writeJson,
} from "./agent_workspace_utils.mjs";
import { readJson, sha256File, sha256Value } from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const action = args[0];

function usage() {
  fail(
    "KACHA-E140",
    "用法：kacha.mjs refs index JSON [JSON ...] --output object-index.json\n"
      + "  kacha.mjs refs resolve @TYPE:ID --index object-index.json [--include-value]\n"
      + "  kacha.mjs refs parse TEXT --index object-index.json",
    2,
  );
}

function escaped(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function collect(value, owner, pointer = "", output = []) {
  if (value === null || typeof value !== "object") return output;
  if (!Array.isArray(value)) {
    const type = inferObjectType(pointer, value, owner);
    const hasIdentity = (
      value.id !== undefined
      || value.effectId !== undefined
      || value.name !== undefined
      || value.start !== undefined
      || value.time !== undefined
      || value.path !== undefined
      || value.status !== undefined
    );
    if (hasIdentity && pointer !== "") {
      const ref = stableObjectId(type, value, pointer);
      output.push({
        ref,
        type,
        id: ref.split(":").slice(1).join(":"),
        owner,
        ownerSha256: sha256File(owner),
        pointer,
        valueDigest: sha256Value(value),
        summary: objectSummary(value),
      });
    }
    for (const [key, child] of Object.entries(value)) {
      collect(child, owner, `${pointer}/${escaped(key)}`, output);
    }
  } else {
    value.forEach((child, index) => collect(child, owner, `${pointer}/${index}`, output));
  }
  return output;
}

function get(root, pointer) {
  if (pointer === "") return root;
  return pointer.slice(1).split("/").reduce(
    (current, part) => current?.[part.replace(/~1/g, "/").replace(/~0/g, "~")],
    root,
  );
}

if (!["index", "resolve", "parse"].includes(action)) usage();

if (action === "index") {
  const output = option(args, "--output");
  const optionIndex = args.indexOf("--output");
  const inputs = args.slice(1, optionIndex >= 0 ? optionIndex : args.length)
    .filter((item) => !item.startsWith("--"));
  if (!output || inputs.length === 0) usage();
  const owners = inputs.map((input) => ensureFile(input, "对象源"));
  const records = [];
  for (const owner of owners) {
    let value;
    try {
      value = readJson(owner);
    } catch (error) {
      fail("KACHA-E140", `对象源 JSON 无法解析：${owner}: ${error.message}`, 2);
    }
    collect(value, owner, "", records);
  }
  const byRef = new Map();
  const collisions = [];
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.ref)) groups.set(record.ref, []);
    groups.get(record.ref).push(record);
  }
  for (const [baseRef, group] of [...groups.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const unique = [...new Map(group.map((record) => [
      `${record.owner}:${record.pointer}:${record.valueDigest}`,
      record,
    ])).values()].sort((left, right) => (
      left.owner.localeCompare(right.owner)
      || left.pointer.localeCompare(right.pointer)
      || left.valueDigest.localeCompare(right.valueDigest)
    ));
    if (unique.length === 1) {
      byRef.set(baseRef, unique[0]);
      continue;
    }
    collisions.push(baseRef);
    for (const record of unique) {
      const suffix = sha256Value({
        owner: record.owner,
        pointer: record.pointer,
      }).slice(0, 8);
      const rewritten = {
        ...record,
        id: `${record.id}-${suffix}`,
      };
      rewritten.ref = `@${rewritten.type}:${rewritten.id}`;
      if (byRef.has(rewritten.ref)) {
        fail("KACHA-E500", `对象引用后缀仍发生碰撞：${rewritten.ref}`);
      }
      byRef.set(rewritten.ref, rewritten);
    }
  }
  const report = {
    schemaVersion: "1.0",
    generatedAt: now(),
    status: "pass",
    owners: owners.map(jsonIdentity),
    objects: [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref)),
    collisionsResolved: [...new Set(collisions)],
  };
  report.digest = sha256Value(report.objects);
  writeJson(output, report);
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    index: path.resolve(output),
    digest: report.digest,
    objects: report.objects.length,
    byType: Object.fromEntries(
      [...new Set(report.objects.map((item) => item.type))]
        .map((type) => [type, report.objects.filter((item) => item.type === type).length]),
    ),
    collisionsResolved: report.collisionsResolved,
  }, null, 2));
  process.exit(0);
}

const indexFile = ensureFile(option(args, "--index"), "对象索引");
const index = readJson(indexFile);
if (index.schemaVersion !== "1.0" || !Array.isArray(index.objects)) {
  fail("KACHA-E140", "对象索引格式无效", 2);
}

function resolveOne(refValue, includeValue = false) {
  const normalized = normalizeObjectRef(refValue);
  if (!normalized) return { ref: refValue, status: "invalid_ref" };
  const record = index.objects.find((item) => item.ref.toLowerCase() === normalized.ref);
  if (!record) return { ref: normalized.ref, status: "not_found" };
  if (!fs.existsSync(record.owner)) {
    return {
      ref: normalized.ref,
      status: "stale_index",
      remediation: `重新索引 ${record.owner}`,
    };
  }
  const currentOwnerSha256 = sha256File(record.owner);
  const root = readJson(record.owner);
  const value = get(root, record.pointer);
  if (sha256Value(value) !== record.valueDigest) {
    return {
      ref: normalized.ref,
      status: "stale_object",
      remediation: `重新索引 ${record.owner}`,
    };
  }
  return {
    ref: normalized.ref,
    status: "resolved",
    type: record.type,
    owner: record.owner,
    ownerSha256: currentOwnerSha256,
    indexedOwnerSha256: record.ownerSha256,
    ownerChanged: currentOwnerSha256 !== record.ownerSha256,
    pointer: record.pointer,
    valueDigest: record.valueDigest,
    summary: record.summary,
    readContract: {
      wholeOwnerRequired: false,
      jsonPointer: record.pointer,
    },
    ...(includeValue ? { value } : {}),
  };
}

if (action === "resolve") {
  const ref = args[1];
  if (!ref) usage();
  const result = resolveOne(ref, args.includes("--include-value"));
  if (result.status !== "resolved") {
    fail("KACHA-E110", `${ref} 解析失败：${result.status}`, 1);
  }
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    object: result,
  }, null, 2));
  process.exit(0);
}

const indexOption = args.indexOf("--index");
const text = args.slice(1, indexOption >= 0 ? indexOption : args.length).join(" ");
if (!text) usage();
const mentions = parseObjectRefs(text);
const resolved = mentions.map((mention) => resolveOne(mention.ref, false));
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: resolved.some((item) => item.status !== "resolved")
    ? "pass_with_unresolved_mentions"
    : "pass",
  textPreview: compactValue(text, 180),
  mentions: resolved,
  resolved: resolved.filter((item) => item.status === "resolved").length,
  unresolved: resolved.filter((item) => item.status !== "resolved").length,
}, null, 2));
