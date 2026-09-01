#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireFileLock,
  fileIdentity,
  readJson,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  assertProjectionSourceCurrent,
  assertSourceVerificationCacheStable,
  buildTimelineProjection,
} from "./timeline_projection.mjs";
import { rebaseTimelineInputs } from "./timeline_paths.mjs";

function auditString(value, label, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} 必须是 1–${maximum} 个无控制符字符`);
  }
  return value.trim();
}

function relativeContained(ownerFile, candidate, { mustExist = true } = {}) {
  const ownerRootPath = path.dirname(path.resolve(ownerFile));
  const ownerRoot = fs.realpathSync(ownerRootPath);
  const requested = path.resolve(ownerRootPath, candidate);
  let resolved = requested;
  if (mustExist) resolved = fs.realpathSync(requested);
  else {
    let ancestor = path.dirname(requested);
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const realAncestor = fs.realpathSync(ancestor);
    const ancestorRelative = path.relative(ownerRoot, realAncestor);
    if (ancestorRelative.startsWith("..") || path.isAbsolute(ancestorRelative)) {
      throw new Error(`Workspace 目标父目录通过链接越出工程：${candidate}`);
    }
  }
  const relative = path.relative(ownerRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Workspace 路径必须位于工程目录内：${candidate}`);
  }
  if (mustExist && (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())) {
    throw new Error(`Workspace Timeline 不存在：${resolved}`);
  }
  return { resolved, relative: relative.split(path.sep).join("/") };
}

function workspaceDigest(workspace) {
  const copy = structuredClone(workspace);
  delete copy.digest;
  return sha256Value(copy);
}

function fileMatchesSha(file, sha256) {
  try {
    return Boolean(sha256) && fs.existsSync(file) && fs.statSync(file).isFile() && fileIdentity(file).sha256 === sha256;
  } catch {
    return false;
  }
}

function validateTimelineEntry(workspaceFile, entry, seen, sourceCache) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Workspace timeline entry 必须是 object");
  const allowed = new Set(["id", "label", "path", "role", "aspect", "createdFrom", "createdAt"]);
  const unknown = Object.keys(entry).filter((field) => !allowed.has(field));
  if (unknown.length) throw new Error(`Workspace timeline entry 包含未知字段：${unknown.join(", ")}`);
  const id = auditString(entry.id, "timeline.id");
  if (seen.has(id)) throw new Error(`Workspace timeline id 重复：${id}`);
  seen.add(id);
  const target = relativeContained(workspaceFile, auditString(entry.path, `timeline ${id}.path`, 1000));
  const before = fileIdentity(target.resolved);
  const projection = buildTimelineProjection(target.resolved);
  const after = fileIdentity(target.resolved);
  if (before.sha256 !== after.sha256 || projection.timeline.sha256 !== after.sha256) {
    throw new Error(`timeline ${id} 在 Workspace 校验期间已变化`);
  }
  const sourceVerification = assertProjectionSourceCurrent(projection, { cache: sourceCache });
  if (!["primary", "version", "aspect", "candidate"].includes(entry.role)) {
    throw new Error(`timeline ${id}.role 非法：${entry.role ?? "missing"}`);
  }
  const aspect = auditString(entry.aspect ?? `${projection.output.width}:${projection.output.height}`, `timeline ${id}.aspect`, 32);
  if (aspect !== `${projection.output.width}:${projection.output.height}`) {
    throw new Error(`timeline ${id}.aspect 与 Timeline output 不一致`);
  }
  const createdFrom = entry.createdFrom === null || entry.createdFrom === undefined
    ? null
    : auditString(entry.createdFrom, `timeline ${id}.createdFrom`);
  const createdAt = entry.createdAt === null || entry.createdAt === undefined
    ? null
    : auditString(entry.createdAt, `timeline ${id}.createdAt`, 64);
  if (createdAt !== null && Number.isNaN(Date.parse(createdAt))) throw new Error(`timeline ${id}.createdAt 不是有效时间`);
  return {
    id,
    label: auditString(entry.label ?? id, `timeline ${id}.label`),
    path: target.relative,
    absolutePath: target.resolved,
    role: entry.role,
    aspect,
    createdFrom,
    createdAt,
    timeline: after,
    projection: {
      projectId: projection.projectId,
      durationSeconds: projection.durationSeconds,
      width: projection.output.width,
      height: projection.output.height,
      fps: projection.timebase.frameRate,
      sourceVerification: sourceVerification.status,
    },
  };
}

export function loadEditorWorkspace(workspaceFile) {
  let resolved = path.resolve(workspaceFile ?? "");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Workspace 不存在：${resolved}`);
  resolved = fs.realpathSync(resolved);
  const workspaceIdentity = fileIdentity(resolved);
  const value = readJson(resolved);
  if (fileIdentity(resolved).sha256 !== workspaceIdentity.sha256) throw new Error("Workspace 在读取期间已变化");
  if (value?.schemaVersion !== "1.0" || value?.kind !== "kacha-editor-workspace") {
    throw new Error("Workspace 必须是 kacha-editor-workspace 1.0");
  }
  const allowed = new Set(["schemaVersion", "kind", "projectId", "label", "activeTimelineId", "timelines", "createdAt", "updatedAt", "digest"]);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) throw new Error(`Workspace 包含未知字段：${unknown.join(", ")}`);
  if (value.digest !== workspaceDigest(value)) throw new Error("Workspace digest 无效或文件已被改写");
  const projectId = auditString(value.projectId, "workspace.projectId");
  const label = auditString(value.label ?? projectId, "workspace.label");
  const createdAt = auditString(value.createdAt, "workspace.createdAt", 64);
  const updatedAt = auditString(value.updatedAt, "workspace.updatedAt", 64);
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt)) || Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Workspace createdAt/updatedAt 必须是有效且单调的时间");
  }
  if (!Array.isArray(value.timelines) || value.timelines.length < 1 || value.timelines.length > 64) {
    throw new Error("Workspace timelines 必须包含 1–64 项");
  }
  const seen = new Set();
  const sourceCache = new Map();
  const timelines = value.timelines.map((entry) => validateTimelineEntry(resolved, entry, seen, sourceCache));
  assertSourceVerificationCacheStable(sourceCache);
  const sourceStatuses = new Set(timelines.map((entry) => entry.projection.sourceVerification));
  const activeTimelineId = auditString(value.activeTimelineId, "workspace.activeTimelineId");
  if (!seen.has(activeTimelineId)) throw new Error("Workspace activeTimelineId 不存在");
  if (timelines.filter((entry) => entry.role === "primary").length !== 1) throw new Error("Workspace 必须且只能有一个 primary timeline");
  if (timelines.some((entry) => entry.projection.projectId !== projectId)) throw new Error("Workspace 不得注册其他 projectId 的 Timeline");
  const byId = new Map(timelines.map((entry) => [entry.id, entry]));
  for (const entry of timelines) {
    if (entry.role === "primary" && entry.createdFrom !== null) throw new Error("primary timeline 不得声明 createdFrom");
    if (entry.role !== "primary" && entry.createdFrom === null) throw new Error(`timeline ${entry.id}.createdFrom 不得为空`);
    if (entry.createdFrom !== null && (!byId.has(entry.createdFrom) || entry.createdFrom === entry.id)) {
      throw new Error(`timeline ${entry.id}.createdFrom 必须引用另一条现有 timeline`);
    }
  }
  for (const entry of timelines) {
    const ancestry = new Set([entry.id]);
    let cursor = entry;
    while (cursor.createdFrom !== null) {
      if (ancestry.has(cursor.createdFrom)) throw new Error(`timeline ${entry.id}.createdFrom 形成循环`);
      ancestry.add(cursor.createdFrom);
      cursor = byId.get(cursor.createdFrom);
    }
  }
  for (const entry of timelines) {
    if (fileIdentity(entry.absolutePath).sha256 !== entry.timeline.sha256) {
      throw new Error(`timeline ${entry.id} 在 Workspace 整体校验期间已变化`);
    }
  }
  if (fileIdentity(resolved).sha256 !== workspaceIdentity.sha256) throw new Error("Workspace 在整体校验期间已变化");
  return {
    schemaVersion: "1.0",
    kind: "kacha-editor-workspace-view",
    status: "pass",
    workspace: workspaceIdentity,
    projectId,
    label,
    createdAt,
    updatedAt,
    activeTimelineId,
    timelines,
    sourceVerification: {
      status: sourceStatuses.size === 1 ? [...sourceStatuses][0] : "mixed",
      uniqueSources: sourceCache.size,
    },
    limitations: ["每个时间线仍是独立 Timeline IR 事实源", "本轮不支持 nested timeline 终渲染"],
  };
}

export function createEditorWorkspace(workspaceFile, timelineFile, options = {}) {
  const output = path.resolve(workspaceFile ?? "");
  if (!workspaceFile || fs.existsSync(output)) throw new Error(`拒绝覆盖 Workspace：${output}`);
  const timeline = relativeContained(output, path.relative(path.dirname(output), path.resolve(timelineFile ?? "")));
  const projection = buildTimelineProjection(timeline.resolved, { includeSourceHash: true });
  const now = new Date().toISOString();
  const projectId = auditString(options.projectId ?? projection.projectId, "projectId");
  if (projectId !== projection.projectId) throw new Error("Workspace projectId 必须与主 Timeline projectId 一致");
  const timelineId = auditString(options.timelineId ?? "main", "timelineId");
  const value = {
    schemaVersion: "1.0",
    kind: "kacha-editor-workspace",
    projectId,
    label: auditString(options.label ?? projection.projectId, "label"),
    activeTimelineId: timelineId,
    timelines: [{
      id: timelineId,
      label: auditString(options.timelineLabel ?? "主时间线", "timelineLabel"),
      path: timeline.relative,
      role: "primary",
      aspect: `${projection.output.width}:${projection.output.height}`,
      createdFrom: null,
      createdAt: now,
    }],
    createdAt: now,
    updatedAt: now,
  };
  value.digest = workspaceDigest(value);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  let created = false;
  let createdSha = null;
  try {
    fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    created = true;
    createdSha = fileIdentity(output).sha256;
    return loadEditorWorkspace(output);
  } catch (error) {
    if (created && fileMatchesSha(output, createdSha)) {
      try { fs.unlinkSync(output); } catch {}
    }
    throw error;
  }
}

export function duplicateWorkspaceTimeline(workspaceFile, options = {}) {
  const requested = path.resolve(workspaceFile ?? "");
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) throw new Error(`Workspace 不存在：${requested}`);
  const resolved = fs.realpathSync(requested);
  const expected = auditString(options.expectedWorkspaceSha256, "expectedWorkspaceSha256", 64);
  if (!/^[a-f0-9]{64}$/.test(expected) || fileIdentity(resolved).sha256 !== expected) {
    throw new Error("Workspace SHA 已过期，拒绝复制时间线");
  }
  const release = acquireFileLock(`${resolved}.lock`, { purpose: "duplicate-editor-timeline" });
  try {
    if (fileIdentity(resolved).sha256 !== expected) throw new Error("Workspace 在加锁期间已变化");
    const view = loadEditorWorkspace(resolved);
    if (view.timelines.length >= 64) throw new Error("Workspace 已达到 64 条 timeline 上限");
    const sourceId = auditString(options.sourceTimelineId ?? view.activeTimelineId, "sourceTimelineId");
    const source = view.timelines.find((entry) => entry.id === sourceId);
    if (!source) throw new Error(`源时间线不存在：${sourceId}`);
    const newId = auditString(options.newTimelineId, "newTimelineId");
    if (view.timelines.some((entry) => entry.id === newId)) throw new Error(`timeline id 已存在：${newId}`);
    const role = options.role ?? "version";
    if (!["version", "aspect", "candidate"].includes(role)) throw new Error(`复制时间线 role 非法：${role}`);
    const destination = relativeContained(resolved, auditString(options.outputPath, "outputPath", 1000), { mustExist: false });
    if (fs.existsSync(destination.resolved)) throw new Error(`拒绝覆盖时间线：${destination.resolved}`);
    if (fileIdentity(source.absolutePath).sha256 !== source.timeline.sha256) {
      throw new Error("源时间线 SHA 已变化，拒绝复制");
    }
    let clone = readJson(source.absolutePath);
    if (fileIdentity(source.absolutePath).sha256 !== source.timeline.sha256) {
      throw new Error("源时间线在读取期间已变化，拒绝复制");
    }
    buildTimelineProjection(source.absolutePath, { includeSourceHash: true });
    if (fileIdentity(source.absolutePath).sha256 !== source.timeline.sha256) {
      throw new Error("源时间线在校验期间已变化，拒绝复制");
    }
    clone = rebaseTimelineInputs(clone, source.absolutePath, destination.resolved);
    const width = options.width === undefined ? Number(clone.output?.width) : Number(options.width);
    const height = options.height === undefined ? Number(clone.output?.height) : Number(options.height);
    if (![width, height].every((value) => Number.isInteger(value) && value >= 64 && value <= 16384)) {
      throw new Error("width/height 必须是 64–16384 整数");
    }
    clone.output = { ...clone.output, width, height };
    if (clone.output.path) {
      const extension = path.extname(clone.output.path) || ".mp4";
      clone.output.path = `./output/${newId}${extension}`;
    }
    for (const field of ["dialogueStem", "bgmStem", "sfxStem", "mixStem"]) {
      if (typeof clone.output[field] === "string") {
        const extension = path.extname(clone.output[field]) || ".wav";
        clone.output[field] = `./output/${newId}-${field}${extension}`;
      }
    }
    fs.mkdirSync(path.dirname(destination.resolved), { recursive: true });
    relativeContained(resolved, destination.relative, { mustExist: false });
    fs.writeFileSync(destination.resolved, `${JSON.stringify(clone, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const destinationSha = fileIdentity(destination.resolved).sha256;
    let workspaceWritten = false;
    let writtenWorkspaceSha = null;
    let previousWorkspace = null;
    try {
      buildTimelineProjection(destination.resolved, { includeSourceHash: true });
      const value = readJson(resolved);
      previousWorkspace = structuredClone(value);
      const now = new Date().toISOString();
      value.timelines.push({
        id: newId,
        label: auditString(options.label ?? newId, "label"),
        path: destination.relative,
        role,
        aspect: `${width}:${height}`,
        createdFrom: sourceId,
        createdAt: now,
      });
      value.activeTimelineId = newId;
      value.updatedAt = now;
      value.digest = workspaceDigest(value);
      writeJsonAtomic(resolved, value, { mode: 0o600 });
      workspaceWritten = true;
      writtenWorkspaceSha = fileIdentity(resolved).sha256;
      return loadEditorWorkspace(resolved);
    } catch (error) {
      if (fileMatchesSha(destination.resolved, destinationSha)) {
        try { fs.unlinkSync(destination.resolved); } catch {}
      }
      if (workspaceWritten && previousWorkspace && fileMatchesSha(resolved, writtenWorkspaceSha)) {
        writeJsonAtomic(resolved, previousWorkspace, { mode: 0o600 });
      }
      throw error;
    }
  } finally {
    release();
  }
}

export function resolveWorkspaceTimeline(workspaceFile, timelineId = null) {
  const view = loadEditorWorkspace(workspaceFile);
  const id = timelineId ?? view.activeTimelineId;
  const timeline = view.timelines.find((entry) => entry.id === id);
  if (!timeline) throw new Error(`Workspace timeline 不存在：${id}`);
  return { view, timeline };
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

export function runWorkspaceCli(args = process.argv.slice(2)) {
  const action = args[0];
  if (action === "create") return createEditorWorkspace(option(args, "--output"), option(args, "--timeline"), {
    projectId: option(args, "--project-id"), label: option(args, "--label"),
  });
  if (action === "show") return loadEditorWorkspace(option(args, "--workspace"));
  if (action === "duplicate") return duplicateWorkspaceTimeline(option(args, "--workspace"), {
    expectedWorkspaceSha256: option(args, "--expected-sha"), sourceTimelineId: option(args, "--source"),
    newTimelineId: option(args, "--id"), label: option(args, "--label"), outputPath: option(args, "--output"),
    width: option(args, "--width") ?? undefined, height: option(args, "--height") ?? undefined,
    role: option(args, "--role", "version"),
  });
  throw new Error("用法：kacha workspace create|show|duplicate [options]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(runWorkspaceCli(), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
