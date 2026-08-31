#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = path.join(repositoryRoot, "scripts", "kacha_mcp_server.mjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-mcp-"));
const projectRoot = path.join(temporary, "project");
fs.mkdirSync(projectRoot, { recursive: true });
const timeline = path.join(projectRoot, "timeline.json");
fs.writeFileSync(timeline, `${JSON.stringify({
  schemaVersion: "1.0",
  projectId: "mcp-contract-test",
  mode: "preview",
  source: { path: "missing-source.mp4" },
  edl: [{ id: "main", sourceStart: 0, sourceEnd: 4 }],
  visual: { breathing: [], overlays: [] },
  audio: { sfx: [] },
  output: { path: "preview.mp4", width: 1280, height: 720, fps: 25 },
}, null, 2)}\n`);
const outsideTimeline = path.join(temporary, "outside.json");
fs.copyFileSync(timeline, outsideTimeline);

const child = spawn(process.execPath, [serverScript, "--root", projectRoot], {
  cwd: repositoryRoot,
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
let stdoutBuffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();
  for (;;) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch (error) {
      for (const entry of pending.values()) entry.reject(new Error(`MCP stdout 非 JSON：${line}\n${error.message}`));
      pending.clear();
      continue;
    }
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      entry.resolve(message);
    }
  }
});

let requestId = 0;
function request(method, params = undefined) {
  requestId += 1;
  const id = requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP 请求超时：${method}\n${stderr}`));
    }, 5000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
  });
}

function modernMeta() {
  return { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
}

try {
  const discovery = await request("server/discover");
  assert.equal(discovery.result.resultType, "complete");
  assert.equal(discovery.result._meta["io.modelcontextprotocol/serverInfo"].name, "kacha-local");
  assert.ok(discovery.result.supportedVersions.includes("2025-11-25"));

  const listed = await request("tools/list", modernMeta());
  assert.equal(listed.result.resultType, "complete");
  assert.equal(listed.result.cacheScope, "private");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [...listed.result.tools.map((tool) => tool.name)].sort(),
  );
  for (const toolName of ["kacha_editor_undo", "kacha_editor_redo"]) {
    const schema = listed.result.tools.find((tool) => tool.name === toolName)?.inputSchema;
    assert.ok(schema?.required?.includes("baseSha256"), `${toolName} must require the caller's current Timeline SHA`);
  }

  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "kacha-test", version: "1.0.0" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  assert.equal(initialized.result.serverInfo.title, "咔嚓本地人机共编控制面");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const inspected = await request("tools/call", {
    name: "kacha_timeline_inspect",
    arguments: { timeline: "timeline.json" },
    ...modernMeta(),
  });
  assert.equal(inspected.result.resultType, "complete");
  assert.equal(inspected.result.structuredContent.status, "pass");
  const baseSha256 = inspected.result.structuredContent.session.currentSha256;
  assert.match(baseSha256, /^[a-f0-9]{64}$/);

  const applied = await request("tools/call", {
    name: "kacha_editor_apply",
    arguments: {
      timeline: "timeline.json",
      baseSha256,
      operation: "marker_set",
      arguments: { marker: { id: "mcp-mark", tick: 4800, label: "MCP" } },
      reason: "MCP contract test",
    },
    ...modernMeta(),
  });
  assert.equal(applied.result.structuredContent.status, "pass");
  assert.equal(JSON.parse(fs.readFileSync(timeline, "utf8")).editor.markers[0].id, "mcp-mark");

  const history = await request("tools/call", {
    name: "kacha_editor_history",
    arguments: { timeline: "timeline.json" },
  });
  assert.equal(history.result.structuredContent.chainStatus, "valid");
  assert.equal(history.result.structuredContent.records.at(-1).operation, "marker_set");

  const staleUndo = await request("tools/call", {
    name: "kacha_editor_undo",
    arguments: { timeline: "timeline.json", baseSha256 },
  });
  assert.equal(staleUndo.result.isError, true);
  assert.match(staleUndo.result.structuredContent.error, /过期|expected/);
  const undone = await request("tools/call", {
    name: "kacha_editor_undo",
    arguments: { timeline: "timeline.json", baseSha256: applied.result.structuredContent.timelineSha256 },
  });
  assert.equal(undone.result.structuredContent.status, "pass");
  const redone = await request("tools/call", {
    name: "kacha_editor_redo",
    arguments: { timeline: "timeline.json", baseSha256: undone.result.structuredContent.timelineSha256 },
  });
  assert.equal(redone.result.structuredContent.status, "pass");

  const beforeInvalidArguments = fs.readFileSync(timeline, "utf8");
  const invalidCalls = [
    {
      name: "kacha_editor_apply",
      arguments: { timeline: "timeline.json", baseSha256: redone.result.structuredContent.timelineSha256, itemId: "picture:main", changes: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, index])) },
      error: /changes.*1–32/,
    },
    {
      name: "kacha_editor_apply",
      arguments: { timeline: "timeline.json", baseSha256: redone.result.structuredContent.timelineSha256, operation: "marker_set", arguments: {}, reason: "x".repeat(501) },
      error: /reason.*1–500/,
    },
    {
      name: "kacha_editor_apply",
      arguments: { timeline: "timeline.json", baseSha256: redone.result.structuredContent.timelineSha256, operation: "force_overwrite", arguments: {} },
      error: /operation.*允许列表/,
    },
    {
      name: "kacha_editor_apply",
      arguments: { timeline: "timeline.json", baseSha256: redone.result.structuredContent.timelineSha256, operation: "marker_set", arguments: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`field${index}`, index])) },
      error: /arguments.*0–16/,
    },
    {
      name: "kacha_editor_apply",
      arguments: { timeline: "timeline.json", baseSha256: redone.result.structuredContent.timelineSha256, itemId: "picture:main", changes: { sourceStartTick: 0 }, arguments: {} },
      error: /不能同时提供/,
    },
    {
      name: "kacha_editor_apply",
      arguments: { timeline: "timeline.json", baseSha256: redone.result.structuredContent.timelineSha256, operation: "marker_set" },
      error: /同时提供 operation \+ arguments/,
    },
    { name: "kacha_project_bin", arguments: { timeline: "timeline.json", query: { forged: true } }, error: /query.*字符串/ },
    { name: "kacha_timeline_query", arguments: { timeline: "timeline.json", limit: "40" }, error: /limit.*整数/ },
    { name: "kacha_timeline_inspect", arguments: { timeline: "x".repeat(4097) }, error: /timeline.*1–4096/ },
  ];
  for (const invalid of invalidCalls) {
    const response = await request("tools/call", { name: invalid.name, arguments: invalid.arguments });
    assert.equal(response.result.isError, true, `${invalid.name} must reject its invalid runtime arguments`);
    assert.match(response.result.structuredContent.error, invalid.error);
    assert.equal(fs.readFileSync(timeline, "utf8"), beforeInvalidArguments, "invalid MCP arguments must not mutate Timeline IR");
  }

  await new Promise((resolve, reject) => {
    child.stdin.write(`${"x".repeat(1024 * 1024 + 1)}\n`, (error) => error ? reject(error) : resolve());
  });
  const afterOversize = await request("ping");
  assert.deepEqual(afterOversize.result, {});

  const escaped = await request("tools/call", {
    name: "kacha_timeline_inspect",
    arguments: { timeline: "../outside.json" },
  });
  assert.equal(escaped.result.isError, true);
  assert.match(escaped.result.structuredContent.error, /越出 MCP 项目根目录/);

  const unknownArgument = await request("tools/call", {
    name: "kacha_timeline_inspect",
    arguments: { timeline: "timeline.json", arbitraryPath: outsideTimeline },
  });
  assert.equal(unknownArgument.result.isError, true);
  assert.match(unknownArgument.result.structuredContent.error, /不接受参数/);

  const unknownTool = await request("tools/call", { name: "kacha_force_overwrite", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);

  const missingRoot = spawnSync(process.execPath, [serverScript], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(missingRoot.status, 2);
  assert.match(missingRoot.stderr, /需要 --root/);
  assert.match(stderr, /confined root/);
  process.stdout.write("MCP server tests passed: modern discovery, legacy initialize, SHA mutation/history, bounded framing, root confinement, closed arguments.\n");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  fs.rmSync(temporary, { recursive: true, force: true });
}
