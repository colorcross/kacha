#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  acquireFileLock,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

export function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

export function repeated(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) {
      values.push(args[index + 1]);
    }
  }
  return values;
}

export function fail(code, detail, exitCode = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    diagnostics: [{ code, detail }],
  }, null, 2));
  process.exit(exitCode);
}

export function ensureFile(file, label = "文件") {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail("KACHA-E100", `${label}不存在：${resolved}`, 2);
  }
  return resolved;
}

export function ensureDirectory(directory, { create = false } = {}) {
  const resolved = path.resolve(directory);
  if (create) fs.mkdirSync(resolved, { recursive: true });
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    fail("KACHA-E100", `目录不存在：${resolved}`, 2);
  }
  return resolved;
}

export function isPathInside(root, candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function resolveContainedPath(root, candidate, { allowMissing = true } = {}) {
  const realRoot = fs.realpathSync(path.resolve(root));
  const requested = path.resolve(realRoot, candidate);
  let existing = requested;
  const missingParts = [];
  while (!fs.existsSync(existing)) {
    if (!allowMissing) {
      throw new Error(`路径不存在：${requested}`);
    }
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error(`无法解析路径边界：${requested}`);
    }
    missingParts.unshift(path.basename(existing));
    existing = parent;
  }
  const stat = fs.lstatSync(existing);
  const realExisting = fs.realpathSync(existing);
  if (missingParts.length > 0 && !stat.isDirectory()) {
    throw new Error(`缺失路径的最近已存在父节点不是目录：${existing}`);
  }
  const realCandidate = missingParts.length > 0
    ? path.join(realExisting, ...missingParts)
    : realExisting;
  if (!isPathInside(realRoot, realCandidate)) {
    throw new Error(`路径越出项目目录：${requested} -> ${realCandidate}`);
  }
  return realCandidate;
}

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function withOperationLock(
  lockFile,
  purpose,
  callback,
  { timeoutMs = 3000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let release = null;
    try {
      release = acquireFileLock(lockFile, {
        staleAfterMs: 10 * 60 * 1000,
        purpose,
      });
      try {
        return callback();
      } finally {
        release();
      }
    } catch (error) {
      if (
        !String(error.message).includes("operation lock is active")
        || Date.now() >= deadline
      ) {
        throw error;
      }
      sleepSync(10);
    }
  }
}

export function shortDigest(value, length = 10) {
  return sha256Value(value).slice(0, length);
}

export function safeId(value, fallbackPrefix = "obj") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || `${fallbackPrefix}-${shortDigest(value)}`;
}

export function normalizeObjectRef(value) {
  const match = /^@([a-z][a-z0-9_-]*):([a-z0-9][a-z0-9._-]*)$/i.exec(
    String(value ?? "").trim(),
  );
  return match
    ? { type: match[1].toLowerCase(), id: match[2].toLowerCase(), ref: match[0] }
    : null;
}

export function parseObjectRefs(text) {
  const refs = [];
  const expression = /@([a-z][a-z0-9_-]*):([a-z0-9][a-z0-9._-]*)/gi;
  let match;
  while ((match = expression.exec(String(text ?? ""))) !== null) {
    refs.push({
      type: match[1].toLowerCase(),
      id: match[2].toLowerCase(),
      ref: `@${match[1].toLowerCase()}:${match[2].toLowerCase()}`,
      index: match.index,
    });
  }
  return refs;
}

export function compactValue(value, maxCharacters = 160) {
  if (value === undefined) return null;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length <= maxCharacters
    ? compact
    : `${compact.slice(0, maxCharacters - 1)}…`;
}

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

export function jsonIdentity(file) {
  const stat = fs.statSync(file);
  return {
    path: path.resolve(file),
    sha256: sha256File(file),
    sizeBytes: stat.size,
  };
}

export function writeJson(file, value) {
  writeJsonAtomic(path.resolve(file), value);
}

export function now() {
  return new Date().toISOString();
}

export function objectSummary(value) {
  if (value === null || typeof value !== "object") {
    return { value: compactValue(value) };
  }
  const fields = [
    "id",
    "name",
    "label",
    "title",
    "type",
    "kind",
    "status",
    "path",
    "start",
    "end",
    "time",
    "startSeconds",
    "endSeconds",
    "effectId",
    "recipe",
  ];
  const summary = {};
  for (const field of fields) {
    if (
      Object.hasOwn(value, field)
      && ["string", "number", "boolean"].includes(typeof value[field])
    ) {
      summary[field] = value[field];
    }
  }
  return summary;
}

export function inferObjectType(pointer, value, owner = null) {
  const lower = `${pointer} ${owner ?? ""}`.toLowerCase();
  if (/media-index|\/assets?\//.test(lower)) return "asset";
  if (/\/edl\//.test(lower)) return "clip";
  if (/subtitle|caption/.test(lower)) return "caption";
  if (/\/sfx\//.test(lower)) return "sfx";
  if (/overlay|popup|card/.test(lower)) return "overlay";
  if (/transition/.test(lower)) return "transition";
  if (/effect/.test(lower) || value?.effectId) return "effect";
  if (/artifact/.test(lower)) return "artifact";
  if (/version/.test(lower)) return "version";
  if (/job/.test(lower)) return "job";
  if (/range/.test(lower) || (
    Number.isFinite(Number(value?.start))
    && Number.isFinite(Number(value?.end))
  )) return "range";
  return "object";
}

export function escapePointerPart(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerPart(value) {
  return String(value).replace(/~1/g, "/").replace(/~0/g, "~");
}

export function pointerParts(pointer) {
  if (pointer === "") return [];
  if (!String(pointer).startsWith("/")) {
    throw new Error(`JSON Pointer 必须以 / 开头：${pointer}`);
  }
  return String(pointer).slice(1).split("/").map(unescapePointerPart);
}

export function getAtPointer(root, pointer) {
  let current = root;
  for (const part of pointerParts(pointer)) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export function setAtPointer(root, pointer, value, { add = false } = {}) {
  const parts = pointerParts(pointer);
  if (parts.length === 0) return structuredClone(value);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    if (current === null || typeof current !== "object") {
      throw new Error(`JSON Pointer 父节点不是对象：${pointer}`);
    }
    if (!Object.hasOwn(current, part)) {
      throw new Error(`JSON Pointer 父节点不存在：${pointer}`);
    }
    current = current[part];
  }
  const leaf = parts.at(-1);
  if (Array.isArray(current)) {
    if (add && leaf === "-") {
      current.push(structuredClone(value));
      return root;
    }
    const index = Number(leaf);
    if (!Number.isInteger(index) || index < 0 || index > current.length) {
      throw new Error(`数组索引无效：${pointer}`);
    }
    if (add) current.splice(index, 0, structuredClone(value));
    else {
      if (index >= current.length) throw new Error(`数组索引不存在：${pointer}`);
      current[index] = structuredClone(value);
    }
    return root;
  }
  if (current === null || typeof current !== "object") {
    throw new Error(`JSON Pointer 父节点不是对象：${pointer}`);
  }
  if (!add && !Object.hasOwn(current, leaf)) {
    throw new Error(`replace 目标不存在：${pointer}`);
  }
  current[leaf] = structuredClone(value);
  return root;
}

export function removeAtPointer(root, pointer) {
  const parts = pointerParts(pointer);
  if (parts.length === 0) throw new Error("不能删除 JSON 根节点");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) {
      throw new Error(`remove 目标不存在：${pointer}`);
    }
    current = current[part];
  }
  const leaf = parts.at(-1);
  if (Array.isArray(current)) {
    const index = Number(leaf);
    if (!Number.isInteger(index) || index < 0 || index >= current.length) {
      throw new Error(`remove 数组索引不存在：${pointer}`);
    }
    current.splice(index, 1);
  } else {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, leaf)) {
      throw new Error(`remove 目标不存在：${pointer}`);
    }
    delete current[leaf];
  }
  return root;
}

export function mergeAtPointer(root, pointer, value) {
  const current = getAtPointer(root, pointer);
  if (
    current === null
    || typeof current !== "object"
    || Array.isArray(current)
    || value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new Error(`merge 只支持普通对象：${pointer}`);
  }
  const merged = { ...current, ...structuredClone(value) };
  return setAtPointer(root, pointer, merged);
}

export function stableObjectId(type, value, pointer) {
  const explicit = value?.id ?? value?.key ?? value?.name ?? value?.effectId;
  const id = explicit ? safeId(explicit, type) : `${type}-${shortDigest({ pointer, value })}`;
  return `@${type}:${id}`;
}
