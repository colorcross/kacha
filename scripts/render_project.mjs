#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mediaSummary,
  readJson,
  resolveFrom,
  run,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const projectInput = args.find((item) => !item.startsWith("--"));

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function entryPath(entry) {
  return typeof entry === "string" ? entry : entry?.path;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function execute(script, scriptArgs) {
  const result = run(process.execPath, [path.join(scriptDirectory, script), ...scriptArgs]);
  if (result.status !== 0) {
    fail(result.stderr.trim() || result.stdout.trim() || `${script} 执行失败`, result.status);
  }
  return result;
}

if (!projectInput) {
  fail(
    "用法：kacha.mjs render PROJECT.json [--mode preview|final] "
      + "[--output VIDEO] [--graph RENDER-GRAPH.json] "
      + "[--range-start SEC --range-end SEC（仅 preview）]",
    2,
  );
}

const projectFile = path.resolve(projectInput);
if (!fs.existsSync(projectFile) || !fs.statSync(projectFile).isFile()) {
  fail(`项目 manifest 不存在：${projectFile}`, 2);
}
const project = readJson(projectFile);
if (project.schemaVersion !== "2.0") {
  fail("统一整片 render 当前只接受 schemaVersion 2.0；增量返工继续使用 v3 工作流", 2);
}
const timelineEntry = project.plans?.timeline ?? project.plans?.timelineIr;
const timelineCandidate = entryPath(timelineEntry);
if (!timelineCandidate) {
  fail("project.plans.timeline 缺失；不得回退为多次整片编码", 1);
}
const timelineFile = resolveFrom(projectFile, timelineCandidate);
if (!fs.existsSync(timelineFile) || !fs.statSync(timelineFile).isFile()) {
  fail(`Timeline IR 不存在：${timelineFile}`, 1);
}
const finalCandidate = option("--output", entryPath(project.outputs?.finalVideo));
if (!finalCandidate) fail("project.outputs.finalVideo.path 缺失", 1);
const finalVideo = path.isAbsolute(finalCandidate)
  ? path.normalize(finalCandidate)
  : resolveFrom(projectFile, finalCandidate);
const mode = option("--mode", "final");
if (!["preview", "final"].includes(mode)) fail("--mode 必须为 preview 或 final", 2);
if (mode === "preview" && !option("--output")) {
  fail("preview 必须显式提供独立 --output，禁止占用正式成片路径", 2);
}
const rangeStart = option("--range-start");
const rangeEnd = option("--range-end");
if ((rangeStart === null) !== (rangeEnd === null)) {
  fail("--range-start 与 --range-end 必须同时提供", 2);
}
const graphFile = path.resolve(
  option("--graph", `${finalVideo}.render-graph.json`),
);

execute("kacha.mjs", ["gate-render", projectFile]);
const timeline = readJson(timelineFile);
const sourcePath = resolveFrom(timelineFile, entryPath(timeline.source));
const sourceSeconds = sourcePath && fs.existsSync(sourcePath)
  ? mediaSummary(sourcePath).videoDuration
  : null;
const telemetryArgs = [
  "run",
  "--stage",
  mode === "final" ? "final_render" : "preview_render",
  "--project-root",
  path.dirname(projectFile),
  "--mode",
  mode,
  ...(sourceSeconds ? ["--source-seconds", String(sourceSeconds)] : []),
  "--artifact",
  finalVideo,
  "--",
  process.execPath,
  path.join(scriptDirectory, "timeline_ir.mjs"),
  "render",
  "--plan",
  timelineFile,
  "--output",
  finalVideo,
  "--graph",
  graphFile,
  "--mode",
  mode,
  ...(rangeStart !== null
    ? ["--range-start", rangeStart, "--range-end", rangeEnd]
    : []),
];
const measured = execute("run_telemetry.mjs", telemetryArgs);
let telemetry;
try {
  telemetry = JSON.parse(measured.stdout);
} catch (error) {
  fail(`遥测包装结果无法解析：${error.message}`);
}
if (!fs.existsSync(finalVideo)) fail(`渲染命令未生成目标视频：${finalVideo}`);
const manifestFile = `${finalVideo}.manifest.json`;
if (!fs.existsSync(manifestFile)) fail(`渲染命令未生成 manifest：${manifestFile}`);
const renderManifest = readJson(manifestFile);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: telemetry.result?.status ?? renderManifest.status,
  projectId: project.projectId,
  project: projectFile,
  timeline: timelineFile,
  graph: graphFile,
  output: finalVideo,
  manifest: manifestFile,
  videoEncodes: telemetry.result?.videoEncodes
    ?? renderManifest.execution?.videoEncodes
    ?? 0,
  durationSeconds: renderManifest.output?.durationSeconds,
  metrics: telemetry.metrics,
  gate: "pass",
  completionBoundary: mode === "final"
    ? "rendered_requires_final_qc"
    : "preview_ready",
}, null, 2));
