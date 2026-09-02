#!/usr/bin/env node

// 咔嚓白板手绘动画能力：把 SRT 字幕驱动的线稿渲染成"暖纸底 + 流式笔迹"的
// 白板动画。渲染引擎 vendored 自 geeklee/srt-whiteboard-animation（MIT，
// 见 scripts/whiteboard_engine/README.md），本模块负责咔嚓合同：参数解析、
// 失败关闭的标注校验、真实渲染、技术 QC 与证据留痕。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstPositional } from "./kacha_config.mjs";
import { readJson, run, sha256File, writeJsonAtomic, acquireFileLock } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const engineDirectory = path.join(scriptDirectory, "whiteboard_engine");
const contractFile = path.join(scriptDirectory, "..", "config", "effects", "whiteboard-animation.json");
const args = process.argv.slice(2);
const action = firstPositional(args, [
  "--srt", "--output", "--image", "--annotation", "--video", "--inputs", "--font",
  "--engine-python", "--hand",
]);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function fail(message, code = 1) {
  console.error(`[whiteboard] ${message}`);
  process.exit(code);
}

function numberOption(name, fallback = null) {
  const value = option(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${name} 必须是数字`);
  return parsed;
}

function requireFile(value, label) {
  if (!value) fail(`${label} 必须提供对应文件参数`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail(`${label} 不存在：${resolved}`);
  }
  return resolved;
}

function loadContract() {
  try {
    return readJson(contractFile);
  } catch (error) {
    fail(`白板动画合同不可读：${error.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// 引擎解释器解析：显式参数 > 环境变量 > 引擎虚拟环境
// ──────────────────────────────────────────────────────────────

function engineVenvPython() {
  const override = process.env.KACHA_WHITEBOARD_VENV
    ? path.resolve(process.env.KACHA_WHITEBOARD_VENV)
    : path.join(engineDirectory, ".venv");
  const binary = process.platform.startsWith("win")
    ? path.join(override, "Scripts", "python.exe")
    : path.join(override, "bin", "python");
  return fs.existsSync(binary) ? binary : null;
}

function resolveEnginePython() {
  const explicit = option("--engine-python") ?? process.env.KACHA_WHITEBOARD_PYTHON;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    // 允许裸命令名（如 CI 里的 KACHA_WHITEBOARD_PYTHON=python3）。探测与执行
    // 都通过 login shell 解析，避免"探测通过、执行 ENOENT"的 PATH 错位。
    if (explicit === path.basename(explicit)) {
      const resolvedPath = resolveLoginShellCommand(explicit);
      if (resolvedPath) return resolvedPath;
    }
    fail(`--engine-python 不可用：${explicit}`);
  }
  const venvPython = engineVenvPython();
  if (venvPython) return venvPython;
  fail(
    "白板渲染引擎缺少 Python 环境。先运行：\n"
    + "  node scripts/kacha.mjs whiteboard env-prepare\n"
    + "或用 --engine-python / KACHA_WHITEBOARD_PYTHON 指定已备好的解释器。",
    2,
  );
}

// 与 kacha_utils.commandExists 同源的 login-shell 解析，但返回绝对路径，
// 保证探测到的解释器就是后续 spawn 使用的解释器。
function resolveLoginShellCommand(name) {
  const probe = run("/usr/bin/env", ["bash", "-lc", 'command -v "$1"', "kacha-command-probe", name], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const candidate = probe.stdout.trim();
  return probe.status === 0 && candidate ? candidate : null;
}

// 非渲染子命令的解释器：优先引擎 venv（依赖最全），回落系统 python3。
// env-check/env-prepare 必须用系统 python3（它们的职责就是创建 venv）。
function resolveScriptPython() {
  const explicit = option("--engine-python") ?? process.env.KACHA_WHITEBOARD_PYTHON;
  if (explicit) return resolveEnginePython();
  return engineVenvPython() ?? "python3";
}

function runPython(python, scriptPath, scriptArgs, { capture = false } = {}) {
  const spawnOptions = capture
    ? { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
    : { stdio: ["ignore", "inherit", "inherit"] };
  return run(python, [path.join(engineDirectory, scriptPath), ...scriptArgs], {
    ...spawnOptions,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ──────────────────────────────────────────────────────────────
// 媒体探测与帧采样（QC 用）
// ──────────────────────────────────────────────────────────────

function probeImage(file) {
  const result = run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json", file,
  ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.status !== 0) fail(`无法读取图片信息：${file}`);
  const stream = JSON.parse(result.stdout).streams?.[0];
  if (!stream?.width || !stream?.height) fail(`图片缺少有效尺寸：${file}`);
  return { width: stream.width, height: stream.height };
}

function probeVideo(file) {
  const result = run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json", file,
  ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.status !== 0) fail(`无法读取视频信息：${file}`);
  const parsed = JSON.parse(result.stdout);
  const stream = parsed.streams?.[0];
  if (!stream?.codec_name) fail(`视频没有可解码的视频流：${file}`);
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    frameRate: stream.avg_frame_rate ?? null,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
  };
}

// 抽取指定时刻一帧的原始 RGB，返回 {mean:[r,g,b], buffer}
function frameMeanColor(video, atMs, probe) {
  const seconds = Math.max(0, atMs / 1000);
  const extract = (at) => run("ffmpeg", [
    "-v", "error",
    "-ss", at.toFixed(3),
    "-i", video,
    "-frames:v", "1",
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"], encoding: "binary", maxBuffer: 64 * 1024 * 1024 });
  let result = extract(seconds);
  if (result.status !== 0) fail(`抽帧失败（${video} @ ${seconds}s）：${result.stderr.slice(0, 200)}`);
  let buffer = Buffer.from(result.stdout, "binary");
  const expected = probe.width * probe.height * 3;
  // 末帧附近快速 seek 可能落空，回退 0.5s 再取一次，仍失败则如实报错。
  if (buffer.length < expected && atMs > 500) {
    result = extract(Math.max(0, (atMs - 500) / 1000));
    if (result.status !== 0) fail(`抽帧失败（${video} @ 重试）：${result.stderr.slice(0, 200)}`);
    buffer = Buffer.from(result.stdout, "binary");
  }
  if (buffer.length < expected) fail(`抽帧数据不完整：${buffer.length}/${expected} 字节`);
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = Math.floor(buffer.length / 3);
  for (let index = 0; index < pixels * 3; index += 3) {
    r += buffer[index];
    g += buffer[index + 1];
    b += buffer[index + 2];
  }
  return { mean: [r / pixels, g / pixels, b / pixels], buffer };
}

function regionMeanColor(buffer, probe, region, { scaleX = 1, scaleY = 1 } = {}) {
  const x0 = Math.max(0, Math.round(region.x * scaleX));
  const y0 = Math.max(0, Math.round(region.y * scaleY));
  const x1 = Math.min(probe.width, Math.round((region.x + region.width) * scaleX));
  const y1 = Math.min(probe.height, Math.round((region.y + region.height) * scaleY));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * probe.width + x) * 3;
      r += buffer[offset];
      g += buffer[offset + 1];
      b += buffer[offset + 2];
      count += 1;
    }
  }
  return count === 0 ? null : [r / count, g / count, b / count];
}

// 区域内"墨迹像素"占比：与纸底色距离超过 inkThreshold 的像素比例。
// 线条纤细，区域均值天然接近纸底；覆盖判断必须用像素级占比而不是均值。
function regionInkRatio(buffer, probe, region, { scaleX = 1, scaleY = 1 }, paper, inkThreshold) {
  const x0 = Math.max(0, Math.round(region.x * scaleX));
  const y0 = Math.max(0, Math.round(region.y * scaleY));
  const x1 = Math.min(probe.width, Math.round((region.x + region.width) * scaleX));
  const y1 = Math.min(probe.height, Math.round((region.y + region.height) * scaleY));
  let ink = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * probe.width + x) * 3;
      const pixel = [buffer[offset], buffer[offset + 1], buffer[offset + 2]];
      if (colorDistance(pixel, paper) > inkThreshold) ink += 1;
      count += 1;
    }
  }
  return count === 0 ? 0 : ink / count;
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) fail(`画布底色格式非法：${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function colorDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

// ──────────────────────────────────────────────────────────────
// 标注合同校验：引擎硬合同 → error；创作元数据缺失 → warning
// ──────────────────────────────────────────────────────────────

const REVEAL_DIRECTIONS = new Set([
  "top_to_bottom", "bottom_to_top", "left_to_right", "right_to_left",
]);

function isInt(value) {
  return Number.isInteger(value);
}

function rectErrors(rect, canvas, label, errors) {
  for (const field of ["x", "y", "width", "height"]) {
    if (!isInt(rect?.[field])) {
      errors.push(`${label}.${field} 必须是整数像素`);
      return;
    }
  }
  if (rect.width <= 0 || rect.height <= 0) {
    errors.push(`${label} 宽高必须为正`);
  }
  if (rect.x < 0 || rect.y < 0) errors.push(`${label} 坐标不能为负`);
  if (rect.x + rect.width > canvas.width) errors.push(`${label} 超出画布右边界`);
  if (rect.y + rect.height > canvas.height) errors.push(`${label} 超出画布下边界`);
}

export function validateAnnotation(annotation, imageInfo) {
  const errors = [];
  const warnings = [];
  const canvas = annotation?.canvas;
  if (!canvas || !isInt(canvas.width) || !isInt(canvas.height)) {
    errors.push("canvas.width/height 必须是整数");
    return { errors, warnings };
  }
  if (imageInfo && (canvas.width !== imageInfo.width || canvas.height !== imageInfo.height)) {
    errors.push(
      `canvas ${canvas.width}x${canvas.height} 与图片实际尺寸 ${imageInfo.width}x${imageInfo.height} 不一致`,
    );
  }
  if (!isInt(annotation.sceneDurationMs) || annotation.sceneDurationMs <= 0) {
    errors.push("sceneDurationMs 必须是正整数");
  }
  const elements = annotation.elements;
  if (!Array.isArray(elements) || elements.length === 0) {
    errors.push("elements 必须是非空数组");
    return { errors, warnings };
  }
  const seenIds = new Set();
  const sequences = [];
  elements.forEach((element, index) => {
    const label = `elements[${index}]`;
    if (!element || typeof element !== "object") {
      errors.push(`${label} 必须是对象`);
      return;
    }
    if (typeof element.id !== "string" || !element.id.trim()) errors.push(`${label}.id 必须是非空字符串`);
    else if (seenIds.has(element.id)) errors.push(`${label}.id 重复：${element.id}`);
    else seenIds.add(element.id);
    if (typeof element.label !== "string" || !element.label.trim()) {
      warnings.push(`${label}.label 缺失，检查图将无法显示名称`);
    }
    if (!isInt(element.sequence)) errors.push(`${label}.sequence 必须是整数`);
    else sequences.push(element.sequence);
    if (typeof element.narrativeRole !== "string" || !element.narrativeRole.trim()) {
      warnings.push(`${label}.narrativeRole 缺失，审片时无法对应叙事功能`);
    }
    if (typeof element.subtitle !== "string" || !element.subtitle.trim()) {
      warnings.push(`${label}.subtitle 缺失，无法证明与字幕事件的对齐`);
    }
    rectErrors(element.region, canvas, `${label}.region`, errors);
    const reveal = element.reveal;
    if (!reveal || typeof reveal !== "object") {
      errors.push(`${label}.reveal 必须是对象`);
      return;
    }
    if (!isInt(reveal.startMs) || reveal.startMs < 0) errors.push(`${label}.reveal.startMs 必须是 >=0 的整数`);
    if (!isInt(reveal.durationMs) || reveal.durationMs <= 0) errors.push(`${label}.reveal.durationMs 必须是正整数`);
    if (isInt(reveal.startMs) && isInt(reveal.durationMs) && isInt(annotation.sceneDurationMs)
      && reveal.startMs + reveal.durationMs > annotation.sceneDurationMs) {
      errors.push(`${label}.reveal 超出 sceneDurationMs`);
    }
    if (reveal.direction !== undefined && !REVEAL_DIRECTIONS.has(reveal.direction)) {
      warnings.push(`${label}.reveal.direction "${reveal.direction}" 不在已知方向集合，仅影响检查图展示`);
    }
    if (reveal.protectedRegions !== undefined && !Array.isArray(reveal.protectedRegions)) {
      errors.push(`${label}.reveal.protectedRegions 必须是矩形数组`);
    } else if (Array.isArray(reveal.protectedRegions)) {
      reveal.protectedRegions.forEach((rect, rectIndex) => {
        rectErrors(rect, canvas, `${label}.reveal.protectedRegions[${rectIndex}]`, errors);
      });
    }
    if (reveal.maskPaddingPx !== undefined && (!isInt(reveal.maskPaddingPx) || reveal.maskPaddingPx < 0)) {
      errors.push(`${label}.reveal.maskPaddingPx 必须是 >=0 的整数`);
    }
    const hand = element.handPath;
    if (!hand || !Array.isArray(hand.start) || !Array.isArray(hand.end)
      || hand.start.length !== 2 || hand.end.length !== 2
      || !hand.start.every(isInt) || !hand.end.every(isInt)) {
      warnings.push(`${label}.handPath 缺失或坐标非法，检查图无法画出笔走方向`);
    }
  });
  if (sequences.length === elements.length) {
    const sorted = [...sequences].sort((a, b) => a - b);
    if (sorted.some((value, index) => value !== index + 1)) {
      errors.push("sequence 必须是从 1 开始的连续整数（叙事绘制顺序）");
    }
  }
  if (isInt(annotation.sceneDurationMs) && Array.isArray(elements)) {
    const timed = elements.filter((element) => isInt(element?.reveal?.startMs));
    const bySequence = [...timed].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    for (let index = 1; index < bySequence.length; index += 1) {
      if (bySequence[index].reveal.startMs < bySequence[index - 1].reveal.startMs) {
        errors.push("按 sequence 排序后 startMs 必须非递减（绘制顺序与字幕叙事顺序一致）");
        break;
      }
    }
  }
  return { errors, warnings };
}

// ──────────────────────────────────────────────────────────────
// 子命令
// ──────────────────────────────────────────────────────────────

function parseSrt() {
  const contract = loadContract();
  const srt = requireFile(option("--srt"), "--srt");
  const defaults = contract.defaults ?? {};
  const pythonArgs = [srt];
  for (const [flag, key] of [["--target-sec", "targetSec"], ["--min-sec", "minSec"], ["--max-sec", "maxSec"]]) {
    const value = numberOption(flag) ?? defaults[key];
    if (value !== null && value !== undefined) pythonArgs.push(flag, String(value));
  }
  const result = runPython("python3", "parse_srt.py", pythonArgs, { capture: true });
  if (result.status !== 0) fail(`SRT 解析失败：${result.stderr.slice(0, 400)}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail("SRT 解析输出不是有效 JSON");
  }
  const output = {
    schemaVersion: "1.0",
    kind: "kacha_whiteboard_storyboard_plan",
    source: { path: srt, sha256: sha256File(srt) },
    options: {
      targetSec: numberOption("--target-sec") ?? defaults.targetSec ?? 30,
      minSec: numberOption("--min-sec") ?? defaults.minSec ?? 25,
      maxSec: numberOption("--max-sec") ?? defaults.maxSec ?? 35,
    },
    cues: parsed.cues,
    scenes: parsed.scenes,
  };
  writeOrPrint(output, option("--output"));
}

function writeOrPrint(value, output) {
  if (output) {
    writeJsonAtomic(path.resolve(output), value);
    console.log(JSON.stringify({ status: "pass", output: path.resolve(output) }, null, 2));
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

function envCheck() {
  const result = runPython("python3", "prepare_env.py", ["--check"], { capture: true });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}

function envPrepare() {
  const result = runPython("python3", "prepare_env.py", [], { capture: true });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}

function scaffold() {
  const image = requireFile(option("--image"), "--image");
  const sceneId = option("--scene-id");
  if (!sceneId) fail("--scene-id 必须提供（如 scene-01）");
  const info = probeImage(image);
  const annotation = {
    schemaVersion: "1.0",
    kind: "kacha_whiteboard_annotation",
    sceneId,
    canvas: { width: info.width, height: info.height },
    storyBasis: option("--story-basis") ?? "",
    sceneDurationMs: numberOption("--duration-ms", 0) ?? 0,
    elements: [],
  };
  if (annotation.sceneDurationMs === 0) delete annotation.sceneDurationMs;
  writeOrPrint(annotation, option("--output"));
}

function validate() {
  const image = requireFile(option("--image"), "--image");
  const annotationFile = requireFile(option("--annotation"), "--annotation");
  let annotation;
  try {
    annotation = readJson(annotationFile);
  } catch (error) {
    fail(`标注 JSON 不可读：${error.message}`);
  }
  const info = probeImage(image);
  const { errors, warnings } = validateAnnotation(annotation, info);
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_whiteboard_validation",
    image: { path: image, sha256: sha256File(image), ...info },
    annotation: { path: annotationFile, sha256: sha256File(annotationFile) },
    status: errors.length === 0 ? "pass" : "fail",
    errors,
    warnings,
  };
  if (errors.length === 0) {
    writeOrPrint(report, option("--output"));
  } else {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}

function preview() {
  const image = requireFile(option("--image"), "--image");
  const annotation = requireFile(option("--annotation"), "--annotation");
  const output = option("--output");
  if (!output) fail("--output 必须提供检查图输出路径");
  const pythonArgs = [image, annotation, path.resolve(output)];
  const font = option("--font");
  if (font) pythonArgs.push("--font", font);
  const result = runPython(resolveScriptPython(), "annotation_preview.py", pythonArgs, { capture: true });
  if (result.status !== 0) fail(`检查图生成失败：${result.stderr.slice(0, 400)}`);
  if (!fs.existsSync(path.resolve(output))) fail("检查图未生成");
  console.log(JSON.stringify({ status: "pass", output: path.resolve(output) }, null, 2));
}

function render() {
  const contract = loadContract();
  const image = requireFile(option("--image"), "--image");
  const annotationFile = requireFile(option("--annotation"), "--annotation");
  const output = option("--output");
  if (!output) fail("--output 必须提供成片输出路径");
  const outputPath = path.resolve(output);
  if (fs.existsSync(outputPath)) fail(`输出已存在，拒绝覆盖：${outputPath}`);
  for (const [flag, minimum] of [["--fps", 1], ["--total-ms", 1], ["--cap-long-edge", 16]]) {
    const value = numberOption(flag);
    if (value !== null && (!Number.isInteger(value) || value < minimum)) {
      fail(`${flag} 必须是 ≥${minimum} 的整数`);
    }
  }
  if (hasFlag("--bare-tip") && option("--hand")) {
    console.error("[whiteboard] --bare-tip 与 --hand 同时提供：忽略 --hand（不叠加手部）");
  }
  let annotationValidation = null;
  if (!hasFlag("--skip-validate")) {
    const annotation = readJson(annotationFile);
    const info = probeImage(image);
    annotationValidation = validateAnnotation(annotation, info);
    if (annotationValidation.errors.length > 0) {
      fail(`标注校验失败（可先运行 whiteboard validate 查看明细，或 --skip-validate 跳过）：\n  - ${annotationValidation.errors.join("\n  - ")}`);
    }
  }
  const python = resolveEnginePython();
  const hand = path.resolve(option("--hand") ?? process.env.KACHA_WHITEBOARD_HAND
    ?? path.join(scriptDirectory, "..", "assets", "whiteboard", "drawing-hand.png"));
  const engineArgs = [image, annotationFile, outputPath];
  engineArgs.push(hasFlag("--bare-tip") ? "--bare-tip" : hand);
  const inkPath = option("--ink-path") ?? contract.defaults?.inkPath ?? "grid";
  const colorFill = option("--color-fill") ?? contract.defaults?.colorFill ?? "contour-wipe";
  const pause = option("--pause") ?? contract.defaults?.pause ?? "heavy";
  engineArgs.push("--ink-path", inkPath, "--color-fill", colorFill, "--pause", pause);
  const totalMs = numberOption("--total-ms");
  if (totalMs !== null) engineArgs.push("--total-ms", String(totalMs));
  const fps = numberOption("--fps") ?? contract.defaults?.fps;
  if (fps !== null && fps !== undefined) engineArgs.push("--fps", String(fps));
  const capLongEdge = numberOption("--cap-long-edge") ?? contract.defaults?.capLongEdge;
  if (capLongEdge !== null && capLongEdge !== undefined) engineArgs.push("--cap-long-edge", String(capLongEdge));

  const engineFiles = {
    render: { path: "render_stream_whiteboard.py", sha256: sha256File(path.join(engineDirectory, "render_stream_whiteboard.py")) },
    core: { path: "stream_render.py", sha256: sha256File(path.join(engineDirectory, "stream_render.py")) },
  };
  // 同一输出路径的并发渲染会共享引擎的 <stem>_raw.mp4 中间产物，必须串行。
  const releaseLock = acquireFileLock(`${outputPath}.render-lock`, { purpose: "kacha-whiteboard-render" });
  let result;
  try {
    result = run(python, [
      path.join(engineDirectory, "render_stream_whiteboard.py"), ...engineArgs,
    ], { stdio: ["ignore", "inherit", "inherit"] });
  } finally {
    releaseLock();
  }
  if (result.status !== 0) {
    // 引擎中断会遗留 mp4v 中间产物，清理而不是留给用户猜测。
    const rawPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}_raw.mp4`);
    fs.rmSync(rawPath, { force: true });
    fail(`白板渲染失败（exit ${result.status}）`);
  }
  if (!fs.existsSync(outputPath)) fail("引擎未产出输出文件");

  const probe = probeVideo(outputPath);
  const evidence = {
    schemaVersion: "1.0",
    kind: "kacha_whiteboard_render_evidence",
    engine: { python, ...engineFiles },
    inputs: {
      image: { path: image, sha256: sha256File(image) },
      annotation: { path: annotationFile, sha256: sha256File(annotationFile) },
      hand: hasFlag("--bare-tip") ? null : { path: hand, sha256: fs.existsSync(hand) ? sha256File(hand) : null },
    },
    options: {
      inkPath, colorFill, pause, totalMs, fps, capLongEdge,
      bareTip: hasFlag("--bare-tip"),
      skipValidate: hasFlag("--skip-validate"),
    },
    validation: annotationValidation
      ? { errors: annotationValidation.errors, warnings: annotationValidation.warnings }
      : "skipped",
    output: { path: outputPath, sha256: sha256File(outputPath), bytes: fs.statSync(outputPath).size, probe },
  };
  const evidenceFile = `${outputPath}.whiteboard-evidence.json`;
  writeJsonAtomic(evidenceFile, evidence);
  console.log(JSON.stringify({ status: "pass", output: outputPath, evidence: evidenceFile, probe }, null, 2));
}

function qc() {
  const contract = loadContract();
  const video = requireFile(option("--video"), "--video");
  const paperHex = option("--paper") ?? contract.visualSpec?.paperHex ?? "#F6F1E3";
  const tolerance = numberOption("--tolerance", contract.qc?.paperColorTolerance ?? 28);
  const inkThreshold = numberOption("--ink-threshold", contract.qc?.inkPixelDistanceThreshold ?? 40);
  const minInkRatio = contract.qc?.minRegionInkRatio ?? 0.004;
  const noEarlyInkRatio = contract.qc?.noEarlyInkRatio ?? 0.002;
  const annotationFile = option("--annotation");
  const probe = probeVideo(video);
  const checks = [];
  const evenDimensions = probe.width % 2 === 0 && probe.height % 2 === 0;
  checks.push({ id: "container", pass: Boolean(probe.codec), detail: `codec=${probe.codec} ${probe.width}x${probe.height}` });
  checks.push({ id: "even-dimensions", pass: evenDimensions, detail: `${probe.width}x${probe.height}` });
  checks.push({
    id: "duration-known",
    pass: probe.durationMs > 0,
    detail: probe.durationMs > 0 ? `时长 ${probe.durationMs}ms` : "容器缺少可解析时长，无法做帧级检查",
  });

  const paper = hexToRgb(paperHex);
  const first = frameMeanColor(video, 0, probe);
  const firstDistance = colorDistance(first.mean, paper);
  checks.push({
    id: "first-frame-paper",
    pass: firstDistance <= tolerance,
    detail: `首帧均色与纸底 ${paperHex} 的距离 ${firstDistance.toFixed(1)} ≤ ${tolerance}`,
  });

  if (annotationFile) {
    const annotationPath = requireFile(annotationFile, "--annotation");
    let annotation;
    try {
      annotation = readJson(annotationPath);
    } catch (error) {
      fail(`标注 JSON 不可读：${error.message}`);
    }
    const image = option("--image");
    if (image) {
      const imageInfo = probeImage(requireFile(image, "--image"));
      const { errors } = validateAnnotation(annotation, imageInfo);
      checks.push({ id: "annotation-valid", pass: errors.length === 0, detail: errors.length === 0 ? "标注合同通过" : errors.join("; ") });
    }
    const canvas = annotation.canvas;
    const annotationReady = Array.isArray(annotation.elements) && annotation.elements.length > 0
      && canvas && Number.isInteger(canvas.width) && Number.isInteger(canvas.height);
    if (annotationReady) {
      // 区域级检查只对单幕成片有意义：时长与标注 sceneDurationMs 明显不符
      // 说明这是合并片或别的剪辑，换算出来的时序毫无意义，明确跳过而不是
      // 碰巧通过。
      const sceneDuration = Number.isInteger(annotation.sceneDurationMs) ? annotation.sceneDurationMs : null;
      const durationMatches = sceneDuration === null
        ? false
        : Math.abs(probe.durationMs - sceneDuration) <= Math.max(1500, sceneDuration * 0.1);
      if (sceneDuration !== null && !durationMatches) {
        checks.push({
          id: "duration-match",
          pass: false,
          detail: `成片时长 ${probe.durationMs}ms 与标注 sceneDurationMs ${sceneDuration}ms 不符：区域级检查只适用于单幕成片`,
        });
      } else {
        if (sceneDuration === null) {
          checks.push({ id: "duration-match", pass: false, detail: "标注缺少 sceneDurationMs，无法核对成片时长" });
        }
        // 引擎按 cap-long-edge 缩放输出；QC 的区域级检查用同一比例换算标注坐标。
        const scaleX = probe.width / canvas.width;
        const scaleY = probe.height / canvas.height;
        const byStart = [...annotation.elements]
          .filter((element) => element?.reveal && Number.isInteger(element.reveal.startMs))
          .sort((a, b) => b.reveal.startMs - a.reveal.startMs);
        const last = byStart[0];
        if (last && last.reveal.startMs >= 500) {
          const beforeLast = frameMeanColor(video, last.reveal.startMs - 250, probe);
          const inkRatio = regionInkRatio(beforeLast.buffer, probe, last.region, { scaleX, scaleY }, paper, inkThreshold);
          checks.push({
            id: "no-early-reveal",
            pass: inkRatio < noEarlyInkRatio,
            detail: `末元素 ${last.id ?? ""} 开始前其区域墨迹占比 ${(inkRatio * 100).toFixed(2)}% < ${noEarlyInkRatio * 100}%`,
          });
        }
        const finalFrame = frameMeanColor(video, Math.max(0, (probe.durationMs || sceneDuration || 1000) - 200), probe);
        const uncovered = annotation.elements.filter((element) => {
          if (!element?.region) return true;
          const ratio = regionInkRatio(finalFrame.buffer, probe, element.region, { scaleX, scaleY }, paper, inkThreshold);
          return ratio < minInkRatio;
        });
        checks.push({
          id: "final-frame-covered",
          pass: uncovered.length === 0,
          detail: uncovered.length === 0
            ? `全部 ${annotation.elements.length} 个区域在收尾帧都有笔迹（墨迹占比 ≥ ${minInkRatio * 100}%）`
            : `收尾帧墨迹占比不足的区域：${uncovered.map((element) => element.id ?? "?").join(", ")}`,
        });
      }
    } else {
      checks.push({ id: "annotation-usable", pass: false, detail: "标注缺少可用的 canvas/elements，无法做区域级检查" });
    }
  }

  const failed = checks.filter((check) => !check.pass);
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_whiteboard_qc",
    video: { path: video, sha256: sha256File(video) },
    probe,
    paperHex,
    tolerance,
    status: failed.length === 0 ? "pass" : "fail",
    checks,
  };
  if (failed.length === 0) {
    writeOrPrint(report, option("--output"));
  } else {
    // 失败也要落盘报告（给了 --output 时），返工请求需要完整失败明细。
    if (option("--output")) writeJsonAtomic(path.resolve(option("--output")), report);
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}

function merge() {
  const inputsRaw = option("--inputs");
  if (!inputsRaw) fail("--inputs 必须提供逗号分隔的场景 MP4 列表");
  const inputs = inputsRaw.split(",").map((item) => item.trim()).filter(Boolean).map((item) => requireFile(item, "--inputs"));
  if (inputs.length < 2) fail("合并至少需要两个场景文件");
  const output = option("--output");
  if (!output) fail("--output 必须提供合并输出路径");
  const outputPath = path.resolve(output);
  if (fs.existsSync(outputPath)) fail(`输出已存在，拒绝覆盖：${outputPath}`);
  const result = runPython(resolveScriptPython(), "merge_scenes.py", [
    "--inputs", ...inputs, "--output", outputPath,
  ], { capture: false });
  if (result.status !== 0) fail(`场景合并失败（exit ${result.status}）`);
  if (!fs.existsSync(outputPath)) fail("合并未产出输出文件");
  const probe = probeVideo(outputPath);
  writeJsonAtomic(`${outputPath}.whiteboard-evidence.json`, {
    schemaVersion: "1.0",
    kind: "kacha_whiteboard_merge_evidence",
    inputs: inputs.map((item) => ({ path: item, sha256: sha256File(item) })),
    output: { path: outputPath, sha256: sha256File(outputPath), bytes: fs.statSync(outputPath).size, probe },
  });
  console.log(JSON.stringify({ status: "pass", output: outputPath, probe }, null, 2));
}

// ──────────────────────────────────────────────────────────────
// 分发
// ──────────────────────────────────────────────────────────────

const commands = {
  "parse-srt": parseSrt,
  "env-check": envCheck,
  "env-prepare": envPrepare,
  scaffold,
  validate,
  preview,
  render,
  qc,
  merge,
};

function usage() {
  console.error(
    "用法：\n"
    + "  kacha.mjs whiteboard parse-srt --srt FILE [--target-sec 30] [--min-sec 25] [--max-sec 35] [--output PLAN.json]\n"
    + "  kacha.mjs whiteboard scaffold --image LINEART.png --scene-id scene-01 [--story-basis TEXT] [--duration-ms MS] [--output ANNOTATION.json]\n"
    + "  kacha.mjs whiteboard validate --image LINEART.png --annotation ANNOTATION.json [--output REPORT.json]\n"
    + "  kacha.mjs whiteboard preview --image LINEART.png --annotation ANNOTATION.json --output CHECK.png [--font FILE]\n"
    + "  kacha.mjs whiteboard render --image LINEART.png --annotation ANNOTATION.json --output SCENE.mp4 \\\n"
    + "      [--ink-path grid|skeleton] [--color-fill contour-wipe|brush] [--pause heavy|auto|light|off] \\\n"
    + "      [--total-ms MS] [--fps N] [--cap-long-edge PX] [--bare-tip] [--hand PNG] [--skip-validate] [--engine-python PY]\n"
    + "  kacha.mjs whiteboard qc --video SCENE.mp4 [--annotation ANNOTATION.json] [--image LINEART.png] \\\n"
    + "      [--paper #F6F1E3] [--tolerance N] [--ink-threshold N] [--output REPORT.json]\n"
    + "  kacha.mjs whiteboard merge --inputs S1.mp4,S2.mp4,... --output FINAL.mp4\n"
    + "  kacha.mjs whiteboard env-check | env-prepare\n"
    + "\n"
    + "渲染引擎与工作流约束见 docs/WHITEBOARD_ANIMATION.md；\n"
    + "引擎为本机 vendored 副本（MIT），来源与补丁见 scripts/whiteboard_engine/README.md。",
  );
}

if (!action || !Object.hasOwn(commands, action)) {
  usage();
  process.exit(action ? 2 : 0);
}
commands[action]();
