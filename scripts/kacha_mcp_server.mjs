#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEditorCommand,
  editorHistory,
  openEditorProject,
  redoEditorCommand,
  undoEditorCommand,
} from "./editor_command_journal.mjs";
import { projectStatus } from "./project_orchestrator.mjs";
import { listProjectBin } from "./project_bin.mjs";
import { buildTimelineProjection } from "./timeline_projection.mjs";

const SERVER_INFO = Object.freeze({
  name: "kacha-local",
  title: "咔嚓本地人机共编控制面",
  version: "1.2.0",
  description: "Local-first, SHA-locked Kacha planning and timeline correction tools.",
});
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const MAX_LINE_BYTES = 1024 * 1024;

function option(name, fallback = null) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const configuredRoot = option("--root", process.env.KACHA_PROJECT_ROOT ?? null);
if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
  process.stderr.write("咔嚓 MCP 需要 --root /absolute/project 或 KACHA_PROJECT_ROOT\n");
  process.exit(2);
}
if (!fs.existsSync(configuredRoot) || !fs.statSync(configuredRoot).isDirectory()) {
  process.stderr.write(`咔嚓 MCP 项目根目录不存在：${configuredRoot}\n`);
  process.exit(2);
}
const projectRoot = fs.realpathSync(configuredRoot);

function withinRoot(candidate) {
  const relative = path.relative(projectRoot, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveExisting(value, label, kind = "file") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空`);
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
  if (!fs.existsSync(candidate)) throw new Error(`${label} 不存在：${candidate}`);
  const resolved = fs.realpathSync(candidate);
  if (!withinRoot(resolved)) throw new Error(`${label} 越出 MCP 项目根目录`);
  const stat = fs.statSync(resolved);
  if (kind === "file" && !stat.isFile()) throw new Error(`${label} 必须是文件`);
  if (kind === "directory" && !stat.isDirectory()) throw new Error(`${label} 必须是目录`);
  return resolved;
}

const timelineProperty = {
  type: "string",
  minLength: 1,
  maxLength: 4096,
  description: "Timeline IR path, absolute or relative to the configured MCP project root.",
};

const EDITOR_OPERATIONS = new Set(["batch", "move", "trim", "split", "reorder", "marker_set", "marker_remove", "work_area_set", "work_area_clear", "keyframe_set", "keyframe_remove", "delivery_frames_set", "replace_media"]);

const TOOLS = Object.freeze([
  {
    name: "kacha_editor_apply",
    title: "Apply a safe Kacha editor command",
    description: "Apply one SHA-locked allowlisted scalar or typed operation through the Command Journal. Never overwrites a whole project.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["timeline", "baseSha256"],
      oneOf: [
        { required: ["itemId", "changes"], not: { anyOf: [{ required: ["operation"] }, { required: ["arguments"] }] } },
        { required: ["operation", "arguments"], not: { required: ["changes"] } },
      ],
      properties: {
        timeline: timelineProperty,
        baseSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        itemId: { type: "string", minLength: 1, maxLength: 200 },
        changes: { type: "object", additionalProperties: { type: "number" }, minProperties: 1, maxProperties: 32 },
        operation: { enum: [...EDITOR_OPERATIONS] },
        arguments: { type: "object", maxProperties: 16 },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
  },
  {
    name: "kacha_editor_history",
    title: "Read Kacha editor history",
    description: "Read the compact digest-chained command history and recovery status for one Timeline IR.",
    inputSchema: { type: "object", additionalProperties: false, required: ["timeline"], properties: { timeline: timelineProperty } },
  },
  {
    name: "kacha_editor_redo",
    title: "Redo one Kacha editor command",
    description: "Redo the latest reversible command through the same SHA-locked journal path.",
    inputSchema: { type: "object", additionalProperties: false, required: ["timeline", "baseSha256"], properties: { timeline: timelineProperty, baseSha256: { type: "string", pattern: "^[a-f0-9]{64}$" } } },
  },
  {
    name: "kacha_editor_undo",
    title: "Undo one Kacha editor command",
    description: "Undo the latest reversible command through the same SHA-locked journal path.",
    inputSchema: { type: "object", additionalProperties: false, required: ["timeline", "baseSha256"], properties: { timeline: timelineProperty, baseSha256: { type: "string", pattern: "^[a-f0-9]{64}$" } } },
  },
  {
    name: "kacha_project_bin",
    title: "Search the current Kacha Project Bin",
    description: "Search strong-identity local indexed assets with license and provenance disclosure.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["timeline"],
      properties: {
        timeline: timelineProperty,
        query: { type: "string", maxLength: 500 },
        kind: { enum: ["video", "image", "audio"] },
        license: { type: "string", minLength: 1, maxLength: 100 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "kacha_project_status",
    title: "Read Kacha project status",
    description: "Read the canonical project state and next action under the configured project root.",
    inputSchema: { type: "object", additionalProperties: false, properties: { project: { type: "string", minLength: 1, maxLength: 4096, description: "Project directory relative to the configured MCP root; defaults to root." } } },
  },
  {
    name: "kacha_timeline_inspect",
    title: "Inspect Kacha Timeline IR",
    description: "Return compact timebase, duration, track counts, SHA and projection digest without returning the whole project.",
    inputSchema: { type: "object", additionalProperties: false, required: ["timeline"], properties: { timeline: timelineProperty } },
  },
  {
    name: "kacha_timeline_query",
    title: "Query Kacha Timeline items",
    description: "Return a bounded filtered set of projected timeline items with edit allowlists and source pointers.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["timeline"],
      properties: {
        timeline: timelineProperty,
        track: { type: "string", minLength: 1, maxLength: 100 },
        type: { type: "string", minLength: 1, maxLength: 100 },
        itemId: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
].sort((left, right) => left.name.localeCompare(right.name)));

function assertPlainArguments(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("tool arguments 必须是 object");
  }
  return value;
}

function assertBoundedString(value, label, { minimum = 1, maximum = 500, optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || (minimum > 0 && !value.trim())) {
    throw new Error(`${label} 必须是 ${minimum}–${maximum} 字符字符串`);
  }
}

function assertPlainRecord(value, label, { minimum = 0, maximum = 32 } = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} 必须是 object`);
  }
  const keys = Object.keys(value);
  if (keys.length < minimum || keys.length > maximum) throw new Error(`${label} 必须包含 ${minimum}–${maximum} 个字段`);
  return keys;
}

function assertOptionalLimit(value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 100)) throw new Error("limit 必须是 1–100 整数");
}

const TOOL_ARGUMENT_KEYS = Object.freeze({
  kacha_editor_apply: new Set(["timeline", "baseSha256", "itemId", "changes", "operation", "arguments", "reason"]),
  kacha_editor_history: new Set(["timeline"]),
  kacha_editor_redo: new Set(["timeline", "baseSha256"]),
  kacha_editor_undo: new Set(["timeline", "baseSha256"]),
  kacha_project_bin: new Set(["timeline", "query", "kind", "license", "limit"]),
  kacha_project_status: new Set(["project"]),
  kacha_timeline_inspect: new Set(["timeline"]),
  kacha_timeline_query: new Set(["timeline", "track", "type", "itemId", "limit"]),
});

function assertToolArguments(name, value) {
  const args = assertPlainArguments(value);
  const allowed = TOOL_ARGUMENT_KEYS[name];
  if (!allowed) throw new Error(`未知 MCP tool：${name}`);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`${name} 不接受参数：${key}`);
  }
  const requiresTimeline = name !== "kacha_project_status";
  if (requiresTimeline) assertBoundedString(args.timeline, "timeline", { maximum: 4096 });
  if (name === "kacha_editor_apply") {
    if (typeof args.baseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.baseSha256)) {
      throw new Error("baseSha256 必须是 64 位小写 SHA-256");
    }
    const scalar = args.changes !== undefined;
    const typed = args.operation !== undefined || args.arguments !== undefined;
    if (!scalar && !typed) throw new Error("必须提供 itemId + changes，或 operation + arguments");
    if (scalar && typed) throw new Error("标量 changes 与 typed operation 不能同时提供");
    assertBoundedString(args.reason, "reason", { maximum: 500, optional: true });
    if (scalar) {
      assertBoundedString(args.itemId, "itemId", { maximum: 200 });
      const keys = assertPlainRecord(args.changes, "changes", { minimum: 1, maximum: 32 });
      if (keys.some((key) => typeof args.changes[key] !== "number" || !Number.isFinite(args.changes[key]))) {
        throw new Error("changes 的值必须是有限数字");
      }
    }
    if (typed) {
      if (typeof args.operation !== "string" || args.arguments === undefined) throw new Error("typed operation 必须同时提供 operation + arguments");
      if (!EDITOR_OPERATIONS.has(args.operation)) throw new Error("operation 不在允许列表");
      assertPlainRecord(args.arguments, "arguments", { maximum: 16 });
      assertBoundedString(args.itemId, "itemId", { maximum: 200, optional: true });
    }
  }
  if (["kacha_editor_undo", "kacha_editor_redo"].includes(name)
    && (typeof args.baseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.baseSha256))) {
    throw new Error("baseSha256 必须是 64 位小写 SHA-256");
  }
  if (name === "kacha_project_bin") {
    assertBoundedString(args.query, "query", { minimum: 0, maximum: 500, optional: true });
    if (args.kind !== undefined && !["video", "image", "audio"].includes(args.kind)) throw new Error("kind 必须是 video|image|audio");
    assertBoundedString(args.license, "license", { maximum: 100, optional: true });
    assertOptionalLimit(args.limit);
  }
  if (name === "kacha_timeline_query") {
    assertBoundedString(args.track, "track", { maximum: 100, optional: true });
    assertBoundedString(args.type, "type", { maximum: 100, optional: true });
    assertBoundedString(args.itemId, "itemId", { maximum: 200, optional: true });
    assertOptionalLimit(args.limit);
  }
  if (name === "kacha_project_status") assertBoundedString(args.project, "project", { maximum: 4096, optional: true });
  return args;
}

function compactProject(project) {
  return {
    schemaVersion: project.schemaVersion,
    status: project.status,
    session: project.session,
    projection: {
      projectId: project.projection.projectId,
      timeline: project.projection.timeline,
      timebase: project.projection.timebase,
      durationTick: project.projection.durationTick,
      durationSeconds: project.projection.durationSeconds,
      output: project.projection.output,
      editor: project.projection.editor,
      tracks: project.projection.tracks.map((track) => ({ id: track.id, type: track.type, label: track.label, items: track.itemIds.length })),
      digest: project.projection.digest,
    },
  };
}

function callTool(name, rawArguments) {
  const args = assertToolArguments(name, rawArguments);
  if (name === "kacha_timeline_inspect") return compactProject(openEditorProject(resolveExisting(args.timeline, "timeline")));
  if (name === "kacha_timeline_query") {
    const timeline = resolveExisting(args.timeline, "timeline");
    const value = buildTimelineProjection(timeline);
    const limit = Number(args.limit ?? 40);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit 必须是 1–100 整数");
    const matched = value.items.filter((item) => (
      (!args.track || item.trackId === args.track)
      && (!args.type || item.type === args.type)
      && (!args.itemId || item.id === args.itemId)
    ));
    const items = matched.slice(0, limit);
    return { schemaVersion: "1.0", status: "pass", timelineSha256: value.timeline.sha256, projectionDigest: value.digest, returned: items.length, truncated: matched.length > limit, items };
  }
  if (name === "kacha_editor_apply") {
    const timeline = resolveExisting(args.timeline, "timeline");
    const command = {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      baseSha256: args.baseSha256,
      actor: "mcp-agent",
      reason: args.reason ?? "MCP typed editor operation",
      ...(args.operation ? { operation: args.operation, arguments: args.arguments ?? {}, itemId: args.itemId } : { itemId: args.itemId, changes: args.changes }),
    };
    const result = applyEditorCommand(timeline, command);
    return { schemaVersion: "1.0", status: result.status, commandId: result.commandId, timelineSha256: result.timelineSha256, requiredQc: result.requiredQc, project: compactProject(result.project) };
  }
  if (["kacha_editor_undo", "kacha_editor_redo"].includes(name)) {
    const timeline = resolveExisting(args.timeline, "timeline");
    const result = name.endsWith("undo")
      ? undoEditorCommand(timeline, args.baseSha256)
      : redoEditorCommand(timeline, args.baseSha256);
    return { schemaVersion: "1.0", status: result.status, action: result.action, commandId: result.commandId, timelineSha256: result.timelineSha256, project: compactProject(result.project) };
  }
  if (name === "kacha_editor_history") {
    const value = editorHistory(resolveExisting(args.timeline, "timeline"));
    return { ...value, records: value.records.slice(-100), truncatedForMcp: value.records.length > 100 };
  }
  if (name === "kacha_project_bin") return listProjectBin(resolveExisting(args.timeline, "timeline"), { query: args.query ?? "", kind: args.kind ?? null, license: args.license ?? null, limit: args.limit ?? 40 });
  if (name === "kacha_project_status") {
    const project = args.project ? resolveExisting(args.project, "project", "directory") : projectRoot;
    const value = projectStatus(project);
    return {
      schemaVersion: value.schemaVersion,
      status: value.status,
      projectRoot: project,
      projectId: value.projectId ?? value.project?.projectId ?? null,
      phase: value.phase ?? value.currentPhase ?? null,
      milestone: value.milestone ?? value.currentMilestone ?? null,
      nextAction: value.nextAction ?? null,
      blockers: value.blockers ?? [],
      limitations: value.limitations ?? [],
    };
  }
  throw new Error(`未知 MCP tool：${name}`);
}

function modernRequest(request) {
  return request.method === "server/discover"
    || request.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === MODERN_VERSION;
}

function responseMeta() {
  return { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
}

function completeResult(value, modern) {
  return modern ? { resultType: "complete", ...value, _meta: { ...(value?._meta ?? {}), ...responseMeta() } } : value;
}

function toolResult(value, modern, isError = false) {
  const result = {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
  return completeResult(result, modern);
}

function dispatch(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { error: { code: -32600, message: "Invalid Request" } };
  }
  const modern = modernRequest(request);
  if (request.method === "server/discover") {
    return { result: {
      resultType: "complete",
      supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
      capabilities: { tools: {} },
      instructions: "Use compact read tools first. Every mutation requires the current Timeline SHA. Workbench preview is approximate; FFmpeg/QC/human review remain separate gates.",
      ttlMs: 300000,
      cacheScope: "private",
      _meta: responseMeta(),
    } };
  }
  if (request.method === "initialize") {
    const requested = request.params?.protocolVersion;
    const protocolVersion = LEGACY_VERSIONS.has(requested) ? requested : "2025-11-25";
    return { result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: "Use compact reads and SHA-locked typed mutations." } };
  }
  if (["notifications/initialized", "notifications/cancelled"].includes(request.method)) return { notification: true };
  if (request.method === "ping") return { result: completeResult({}, modern) };
  if (request.method === "tools/list") {
    return { result: completeResult({ tools: TOOLS, ttlMs: 300000, cacheScope: "private" }, modern) };
  }
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (!TOOLS.some((tool) => tool.name === name)) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    try { return { result: toolResult(callTool(name, request.params?.arguments), modern) }; }
    catch (error) { return { result: toolResult({ schemaVersion: "1.0", status: "blocked", error: error.message }, modern, true) }; }
  }
  return { error: { code: -32601, message: "Method not found" } };
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleInputLine(lineBuffer) {
  const normalized = lineBuffer.at(-1) === 13 ? lineBuffer.subarray(0, -1) : lineBuffer;
  if (normalized.length === 0) return;
  let request;
  try { request = JSON.parse(normalized.toString("utf8")); }
  catch { emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
  if (Array.isArray(request)) { emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } }); return; }
  const dispatched = dispatch(request);
  if (dispatched.notification || request.id === undefined) return;
  emit({ jsonrpc: "2.0", id: request.id, ...(dispatched.error ? { error: dispatched.error } : { result: dispatched.result }) });
}

let inputBuffer = Buffer.alloc(0);
let droppingOversizedLine = false;
process.stdin.on("data", (chunk) => {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let offset = 0;
  for (;;) {
    const newline = data.indexOf(10, offset);
    const end = newline < 0 ? data.length : newline;
    const segment = data.subarray(offset, end);
    if (!droppingOversizedLine && inputBuffer.length + segment.length > MAX_LINE_BYTES) {
      inputBuffer = Buffer.alloc(0);
      droppingOversizedLine = true;
      emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request exceeds 1 MB" } });
    } else if (!droppingOversizedLine && segment.length > 0) {
      inputBuffer = inputBuffer.length === 0 ? Buffer.from(segment) : Buffer.concat([inputBuffer, segment]);
    }
    if (newline < 0) break;
    if (!droppingOversizedLine) handleInputLine(inputBuffer);
    inputBuffer = Buffer.alloc(0);
    droppingOversizedLine = false;
    offset = newline + 1;
  }
});
process.stdin.on("end", () => {
  if (!droppingOversizedLine && inputBuffer.length > 0) handleInputLine(inputBuffer);
});

process.stderr.write(`咔嚓 MCP stdio ready; confined root: ${projectRoot}\n`);
