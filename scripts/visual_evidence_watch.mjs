#!/usr/bin/env node

// Agent 观察回路：对源视频的指定时间窗做局部抽帧，产出带时间戳的
// contact-sheet 观察包，供具备视觉能力的主 Agent 自行读图形成判断。
//
// 窗口台账：按源视频的（路径+大小+mtime）指纹记录已观察过的
// (start, end, fps) 组合；精确重复的窗口返回 skipped_duplicate，不算新的
// 视觉观察（换 fps 重看算新观察；--force 可强制重看）。台账只管理时间窗，
// 不做内容级去重。台账是去重缓存，不是证据链；建议把 .kacha/ 加入项目
// .gitignore。
//
// 边界：观察包是工具产物（帧清单、sheet、媒体元数据、对齐转录）。Agent 读图
// 后的主观摘要、候选片段和风险判断应写入 review 文件，不写回本包。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstPositional } from "./kacha_config.mjs";
import {
  acquireFileLock,
  readJson,
  run,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(`[visual-evidence-watch] ${message}`);
  process.exit(code);
}

function numberOption(name) {
  const value = option(name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${name} 必须是有限数字`);
  return parsed;
}

const action = firstPositional(args, [
  "--video", "--output", "--ledger", "--transcript", "--fps", "--start", "--end",
]);

if (action !== "watch") {
  const usageText = [
    "用法：",
    "  kacha.mjs visual-evidence-watch watch --video SOURCE.mp4 --start SEC --end SEC \\",
    "      [--fps 6] [--force] [--transcript TRANSCRIPT.json] [--output WATCH.json] [--ledger FILE]",
    "",
    "窗口台账默认位于 <cwd>/.kacha/observation-ledger.json，可用 --ledger 覆盖；",
    "观察包默认写入 <cwd>/.kacha/watch/visual-watch-<时间戳>.json，可用 --output 覆盖；",
    "台账与 hook 状态属本机缓存，建议将 .kacha/ 加入项目 .gitignore。",
    "观察包是工具产物；主观判断写入 review 文件，不回写本包。",
  ].join("\n");
  if (args.length > 0) {
    // 有参数但没有 watch 关键字：几乎总是调用错误，不能静默成功。
    console.error(`${usageText}\n\n[visual-evidence-watch] 缺少 watch 子命令。`);
    process.exit(2);
  }
  console.log(usageText);
  process.exit(0);
}

const video = option("--video");
if (!video) fail("--video 必须提供源视频路径");
const videoPath = path.resolve(video);
if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
  fail(`源视频不存在：${videoPath}`);
}
const start = numberOption("--start");
const end = numberOption("--end");
if (start === null || end === null) fail("--start 与 --end 必须提供");
if (start < 0 || end <= start) fail("要求 0 ≤ start < end");

const fps = numberOption("--fps") ?? 6;
if (!Number.isInteger(fps) || fps < 1 || fps > 30) fail("--fps 必须是 1–30 的整数");

// 源视频指纹：路径+大小+mtime（与 VAK 同边界——台账是去重缓存，不是证据链；
// 文件被覆盖后指纹变化，旧窗口自然失效）。
let stat;
try {
  stat = fs.statSync(videoPath);
} catch (error) {
  fail(`无法读取源视频信息：${error.message}`);
}
const fingerprint = `${videoPath}:${stat.size}:${String(stat.mtimeMs)}`;

const probeResult = run("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height,avg_frame_rate",
  "-show_entries", "format=duration",
  "-of", "json", videoPath,
], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
if (probeResult.status !== 0) fail(`无法探测源视频：${probeResult.stderr.slice(0, 200)}`);
const probe = JSON.parse(probeResult.stdout);
const stream = probe.streams?.[0];
if (!stream?.width) fail(`源视频缺少有效视频流：${videoPath}`);
const durationSeconds = Number(probe.format?.duration ?? 0);
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
  fail(`源视频缺少可解析时长：${videoPath}`);
}
// 窗口超出时长时明确报错，不静默截断成更短的观察。
if (end > durationSeconds + 0.05) {
  fail(`窗口 end=${end}s 超出源视频时长 ${durationSeconds.toFixed(3)}s；不静默截断`);
}

const output = path.resolve(option("--output") ?? path.join(process.cwd(), ".kacha", "watch", `visual-watch-${Date.now()}.json`));
const outputDirectory = path.dirname(output);
if (fs.existsSync(output)) fail(`--output 已存在，拒绝覆盖：${output}`);
const ledgerFile = path.resolve(option("--ledger") ?? path.join(process.cwd(), ".kacha", "observation-ledger.json"));

// 抽帧数量上限：超出即要求缩窗或降 fps。静默截断会产生"声明完整窗口、
// 实际只观察到前段"的假观察，且台账会把截断观察当完整观察去重。
const MAX_FRAMES = 96;
const requestedFrames = Math.ceil((end - start) * fps);
if (requestedFrames > MAX_FRAMES) {
  fail(
    `窗口 ${(end - start).toFixed(1)}s @ ${fps}fps 需要约 ${requestedFrames} 帧，超过单次观察上限 ${MAX_FRAMES} 帧。`
    + `请降低 --fps（例如 --fps ${Math.max(1, Math.floor((MAX_FRAMES - 1) / (end - start)))}）`
    + `或缩短窗口（例如 --end ${(start + MAX_FRAMES / fps).toFixed(1)}），`
    + "或分多次窗口观察；不做静默截断。",
  );
}

// 台账读改写全程持锁，防止并发观察丢失更新。锁是 fail-fast 的：被占用时
// 给出干净诊断而不是裸栈，稍后重试即可（死进程锁会被自动回收）。
let releaseLedgerLock = null;
function failLocked(message, code = 1) {
  releaseLedgerLock?.();
  fail(message, code);
}
try {
  releaseLedgerLock = acquireFileLock(`${ledgerFile}.lock`, { purpose: "kacha-visual-watch" });
} catch (error) {
  fail(`台账正被另一个 watch 进程占用，请稍后重试（${String(error.message).split("\n")[0]}）`);
}
// 兜底：任何路径退出（fail、异常、早退）都释放台账锁。
process.on("exit", () => {
  try {
    releaseLedgerLock?.();
  } catch {
    // 退出路径不因锁清理失败而改变退出码。
  }
});

let ledger = { schemaVersion: "1.0", kind: "kacha-observation-ledger", videos: {} };
if (fs.existsSync(ledgerFile)) {
  try {
    const parsed = readJson(ledgerFile);
    if (parsed?.kind !== "kacha-observation-ledger" || typeof parsed.videos !== "object" || parsed.videos === null) {
      fail(`台账结构不符合约定，请修复或删除后重试：${ledgerFile}`);
    }
    ledger = parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes("台账结构")) throw error;
    fail(`台账文件不可解析，请先修复或删除：${ledgerFile}（${error.message}）`);
  }
}

const videoEntry = ledger.videos[fingerprint] ?? { source: videoPath, windows: [] };
if (!Array.isArray(videoEntry.windows)) fail(`台账条目损坏（windows 非数组），请修复或删除：${ledgerFile}`);
const isDuplicate = Boolean(
  !args.includes("--force")
  && videoEntry.windows.find((window) => window.start === start && window.end === end && window.fps === fps),
);
if (isDuplicate) {
  releaseLedgerLock();
  writeJsonAtomic(output, {
    schemaVersion: "1.0",
    kind: "kacha_visual_watch_evidence",
    status: "skipped_duplicate",
    video: { path: videoPath, fingerprint },
    window: { start, end, fps },
    ledger: ledgerFile,
    note: "该窗口已用相同参数观察过；--force 可强制重看。重复观察不构成新的视觉证据。",
  });
  console.log(JSON.stringify({ status: "skipped_duplicate", output }, null, 2));
  process.exit(0);
}

// 源视频 SHA：按指纹缓存进台账（多 GB 源视频同源多窗口观察只算一次）。
if (typeof videoEntry.sha256 !== "string") {
  videoEntry.sha256 = sha256File(videoPath);
}

// 抽帧：等间隔 fps，帧文件按顺序命名直接落在本次运行的独立目录——
// 每次运行目录唯一，重跑不会破坏此前观察包引用的帧文件。
const runId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const staging = path.join(outputDirectory, `${path.basename(output, ".json")}-frames-${runId}`);
try {
  fs.mkdirSync(staging, { recursive: true });
} catch (error) {
  failLocked(`无法创建抽帧目录 ${staging}：${error.message}`);
}
const frameDuration = 1 / fps;
const extracted = [];
for (let index = 0; index < requestedFrames; index += 1) {
  const at = start + index * frameDuration;
  if (at >= end) break;
  const frameFile = path.join(staging, `frame-${String(index + 1).padStart(3, "0")}.jpg`);
  const frame = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", at.toFixed(3), "-i", videoPath,
    "-frames:v", "1", "-q:v", "3", "-y", frameFile,
  ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (frame.status !== 0 || !fs.existsSync(frameFile)) {
    // 末帧附近 seek 落空是正常现象，停止即可。
    break;
  }
  extracted.push({ file: frameFile, time: Number(at.toFixed(3)) });
}
if (extracted.length === 0) failLocked("窗口内没有抽到任何帧");

const columns = Math.min(4, extracted.length);
const rows = Math.ceil(extracted.length / columns);
const sheetFile = path.join(staging, "contact-sheet.jpg");
const tile = run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-nostdin",
  "-framerate", "1",
  "-i", path.join(staging, "frame-%03d.jpg"),
  "-vf", `scale=480:-2:flags=lanczos,tile=${columns}x${rows}:padding=8:margin=8:color=#F5E4C7`,
  "-frames:v", "1", "-q:v", "2", "-y", sheetFile,
], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
if (tile.status !== 0 || !fs.existsSync(sheetFile)) {
  failLocked(`contact sheet 生成失败：${tile.stderr.slice(0, 200)}`);
}

// 转录对齐：只带时间重叠的 segments。兼容秒（start/end）与毫秒
// （startMs/endMs）两种字段；时间不可解析的段跳过，不猜。
let transcriptSegments = null;
const transcriptFile = option("--transcript");
if (transcriptFile) {
  const transcriptPath = path.resolve(transcriptFile);
  if (!fs.existsSync(transcriptPath)) failLocked(`--transcript 不存在：${transcriptPath}`);
  let transcript;
  try {
    transcript = readJson(transcriptPath);
  } catch (error) {
    failLocked(`转录 JSON 不可解析：${error.message}`);
  }
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  transcriptSegments = segments
    .map((segment) => {
      const rawStart = segment.start ?? (Number.isFinite(Number(segment.startMs)) ? Number(segment.startMs) / 1000 : NaN);
      const rawEnd = segment.end ?? (Number.isFinite(Number(segment.endMs)) ? Number(segment.endMs) / 1000 : NaN);
      return {
        start: Number(rawStart),
        end: Number(rawEnd),
        text: typeof segment.text === "string" ? segment.text : "",
      };
    })
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .filter((segment) => segment.end > start && segment.start < end);
}

const evidence = {
  schemaVersion: "1.0",
  kind: "kacha_visual_watch_evidence",
  status: "pass",
  tool: "visual-evidence-watch",
  video: {
    path: videoPath,
    fingerprint,
    sha256: videoEntry.sha256,
    width: stream.width,
    height: stream.height,
    durationSeconds,
  },
  window: { start, end, fps },
  framePaths: extracted.map((frame) => frame.file),
  contactSheet: { path: sheetFile, sha256: sha256File(sheetFile), columns, rows },
  transcriptSegments,
  boundary: "观察包是工具产物；主观摘要与剪辑判断写入 review 文件，不写回本包。",
};
writeJsonAtomic(output, evidence);

videoEntry.windows.push({ start, end, fps, at: new Date().toISOString(), evidence: output });
ledger.videos[fingerprint] = videoEntry;
try {
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeJsonAtomic(ledgerFile, ledger);
} catch (error) {
  failLocked(`台账写入失败：${error.message}`);
}
releaseLedgerLock();

console.log(JSON.stringify({
  status: "pass",
  output,
  frames: extracted.length,
  contactSheet: sheetFile,
  ledger: ledgerFile,
}, null, 2));
