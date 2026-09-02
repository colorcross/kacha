#!/usr/bin/env node

// 咔嚓会话闭环 hook（Claude Code Stop 事件）。
// 只在当前目录是咔嚓项目（存在 contracts/project-manifest.json 且 kind 匹配）
// 时生效；最终成片已产出但发布审片缺失/过期时阻断停止，提醒先走完审片门禁。
//
// 逃生门：项目根或 contracts/ 下存在非空 unresolved.md，说明缺口已记录，放行。
// 防死循环：同一规则同一会话最多阻断 3 次，之后放行并记录违规
// （.kacha/hook-state/violations.jsonl）。
//
// 输入：stdin 的 JSON object（Claude Code hook 协议；session_id 用于隔离
// strike 计数）。输出：阻断时打印 {"decision":"block","reason":...}。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const STRIKE_LIMIT = 3;

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function projectDir() {
  const value = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.resolve(value);
}

function stateDir(project) {
  const dir = path.join(project, ".kacha", "hook-state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeScope(value) {
  const raw = String(value ?? "");
  const cleaned = raw.replace(/[^0-9A-Za-z_.-]/g, "_").slice(0, 80) || "default";
  if (cleaned === raw) return cleaned;
  // 消毒可能引入碰撞（"sess@a" 与 "sess_a" 同名）——附加原始 id 的短哈希隔离。
  const digest = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${cleaned}-${digest}`;
}

// 大文件 SHA 带磁盘缓存（size+mtime 失效键）：Stop hook 每轮结束都会跑，
// 对多 GB 成片逐次全量哈希会拖垮 hook 时限。
function sha256Cached(project, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cacheFile = path.join(stateDir(project), "sha-cache.json");
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch {
    cache = {};
  }
  const key = `${file}:${stat.size}:${String(stat.mtimeMs)}`;
  if (cache[key] && typeof cache[key] === "string") return cache[key];
  try {
    const digest = crypto.createHash("sha256");
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let read = 0;
      while ((read = fs.readSync(handle, buffer)) > 0) {
        digest.update(buffer.subarray(0, read));
      }
    } finally {
      fs.closeSync(handle);
    }
    const hex = digest.digest("hex");
    cache[key] = hex;
    // 容量治理：缓存键随文件变动持续新增，超限时整体清空重建（下次再算），
    // 比逐条淘汰简单且足够。临时文件 + rename，避免并发停止读到半截 JSON。
    const entries = Object.keys(cache);
    if (entries.length > 512) cache = { [key]: hex };
    const temporary = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, JSON.stringify(cache));
    fs.renameSync(temporary, cacheFile);
    return hex;
  } catch {
    return null;
  }
}

function nonemptyFile(file) {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function strike(project, rule, scope) {
  const dir = stateDir(project);
  const counterFile = path.join(dir, `strike_${rule}_${sanitizeScope(scope)}.count`);
  let count = 0;
  try {
    count = Number.parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  if (count >= STRIKE_LIMIT) {
    fs.writeFileSync(counterFile, "0");
    fs.appendFileSync(
      path.join(dir, "violations.jsonl"),
      `${JSON.stringify({ rule, scope, strikes: count, at: new Date().toISOString() })}\n`,
    );
    return { count, released: true };
  }
  fs.writeFileSync(counterFile, String(count));
  return { count, released: false };
}

function blockStop(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason }, null, 2)}\n`);
  process.exit(0);
}

function allow() {
  process.exit(0);
}

const payload = readStdinJson();
const project = projectDir();
const manifestPath = path.join(project, "contracts", "project-manifest.json");
if (!fs.existsSync(manifestPath)) allow();

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch {
  allow();
}
if (!manifest || manifest.kind !== "kacha-project-manifest") allow();

// manifest.outputs 的字段有两种合法形态：字符串或 {path: 字符串}；
// 其他类型（含 {path: 123}）一律视为"未声明"，不参与路径解析。
const outputEntry = (value) => {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)
    && typeof value.path === "string" && value.path.trim()) return value.path;
  return null;
};
const finalVideoRelative = outputEntry(manifest.outputs?.finalVideo);
if (!finalVideoRelative) allow();
// 路径围栏：解析后逃出项目目录的路径不属于本 hook 的检查范围（不做跨目录
// 哈希），放行交由 kacha 自身门禁处理。
const finalVideoPath = path.resolve(project, finalVideoRelative);
// realpath 围栏：符号链接把解析位置指到项目外时，同样不属于本 hook 的
// 检查范围（词法检查拦不住链接，这里按真实位置二次确认）。
let realFinalVideo = null;
try {
  realFinalVideo = fs.realpathSync(finalVideoPath);
} catch {
  allow();
}
if (!realFinalVideo.startsWith(project + path.sep)) allow();
if (!fs.existsSync(finalVideoPath)) allow();

// 逃生门：缺口已显式记录即放行。
if (
  nonemptyFile(path.join(project, "unresolved.md"))
  || nonemptyFile(path.join(project, "contracts", "unresolved.md"))
) {
  allow();
}

const releaseRelative = outputEntry(manifest.outputs?.releaseReport);
if (!releaseRelative) {
  const outcome = strike(project, "closeout", payload.session_id);
  if (outcome.released) allow();
  blockStop(
    "咔嚓项目已产出最终成片，但 manifest 未声明 outputs.releaseReport。"
    + "请运行 release-review 完成统一发布审片，或在 unresolved.md 记录跳过原因。",
  );
}
const releaseReportPath = path.resolve(project, releaseRelative);
if (!releaseReportPath.startsWith(project + path.sep)) allow();
if (!fs.existsSync(releaseReportPath)) {
  const outcome = strike(project, "closeout", payload.session_id);
  if (outcome.released) allow();
  blockStop(
    "咔嚓项目已产出最终成片，但发布审片报告不存在。"
    + "请运行 node scripts/kacha.mjs release-review open 完成十一项人工检查，或在 unresolved.md 记录跳过原因。",
  );
}

let report;
try {
  report = JSON.parse(fs.readFileSync(releaseReportPath, "utf8"));
} catch {
  const outcome = strike(project, "closeout", payload.session_id);
  if (outcome.released) allow();
  blockStop("发布审片报告不可解析，请重新生成后再停止。");
}

const actualSha = sha256Cached(project, finalVideoPath);
// fail-closed：报告未绑定成片 SHA 或哈希不可计算时，新鲜度无法验证，
// 不能当作已通过。
if (!actualSha || !report.finalVideoSha256 || report.finalVideoSha256 !== actualSha) {
  const outcome = strike(project, "closeout", payload.session_id);
  if (outcome.released) allow();
  blockStop(
    "发布审片报告不可验证或已过期：报告未正确绑定当前成片的 SHA-256"
    + "（成片在审片后被改动过，或报告缺失绑定字段）。"
    + "请重新运行 release-review 走完审片门禁。",
  );
}

if (report.status !== "approved_local_release") {
  const outcome = strike(project, "closeout", payload.session_id);
  if (outcome.released) allow();
  blockStop(
    `发布审片尚未批准（当前状态：${report.status ?? "未开始"}）。`
    + "发布门禁要求十一项人工检查全部通过；完成后 release-review approve，或在 unresolved.md 记录缺口。",
  );
}

allow();
