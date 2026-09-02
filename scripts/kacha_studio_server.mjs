#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  compileProductionRequest,
  inspectProductionVideo,
  loadProductionCatalog,
  saveCustomStyle,
} from "./kacha_studio.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";
import { fastIdentityMatches, fileIdentityMatches, readJson, sha256File } from "./kacha_utils.mjs";
import { buildFlightSnapshot } from "./production_flight_recorder.mjs";
import {
  buildPreferenceCandidate,
  loadReviewBundle,
  recordReviewDecision,
  resolveReviewMedia,
} from "./kacha_review.mjs";
import { observeProject } from "./kacha_intelligence.mjs";
import { initializeProject, projectStatus, runProject } from "./project_orchestrator.mjs";
import {
  approveReleaseReview,
  initializeReleaseReview,
  openReleaseReview,
  recordReleaseCheck,
} from "./release_review.mjs";
import {
  applyEditorCommand,
  editorHistory,
  openEditorProject,
  redoEditorCommand,
  undoEditorCommand,
} from "./editor_command_journal.mjs";
import { listPreviewProviders } from "./preview_provider.mjs";
import { listProjectBin } from "./project_bin.mjs";
import { professionalCapabilityMap } from "./professional_capabilities.mjs";
import {
  duplicateWorkspaceTimeline,
  loadEditorWorkspace,
  resolveWorkspaceTimeline,
} from "./editor_workspace.mjs";
import {
  createDeliveryPlan,
  createSelfContainedBundle,
  listDeliveryProfiles,
} from "./kacha_delivery.mjs";
import { exportNle } from "./kacha_nle.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const studioRoot = path.join(skillRoot, "studio");
const brandLogo = path.join(skillRoot, "assets", "brand", "kacha-logo.png");
const MAX_BODY_BYTES = 1024 * 1024;
const editorSessions = new Map();
const EDITOR_SESSION_LIMIT = 32;
const EDITOR_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const EDITOR_EVENT_CLIENT_LIMIT = 64;
const waveformCache = new Map();
const waveformPending = new Map();
const WAVEFORM_CACHE_LIMIT = 24;
const WAVEFORM_CONCURRENCY_LIMIT = 2;
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; "
      + "font-src 'self'; form-action 'none'; frame-ancestors 'none'; "
      + "img-src 'self' data:; object-src 'none'; script-src 'self'; "
      + "style-src 'self' 'unsafe-inline'; media-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

class HttpRequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpRequestError";
    this.statusCode = statusCode;
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

function json(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function text(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function readRequestBody(request) {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const normalized = String(declaredLength);
    if (!/^\d+$/.test(normalized)) {
      request.resume();
      return Promise.reject(new HttpRequestError(400, "Content-Length 必须是非负整数"));
    }
    if (Number(normalized) > MAX_BODY_BYTES) {
      request.resume();
      return Promise.reject(new HttpRequestError(413, "请求内容超过 1 MB"));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let rejectedForSize = false;
    request.on("data", (chunk) => {
      if (rejectedForSize) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        rejectedForSize = true;
        chunks.length = 0;
        reject(new HttpRequestError(413, "请求内容超过 1 MB"));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (rejectedForSize) return;
      try {
        const body = chunks.length > 0
          ? JSON.parse(Buffer.concat(chunks, receivedBytes).toString("utf8"))
          : {};
        if (
          body === null
          || Array.isArray(body)
          || typeof body !== "object"
          || Object.getPrototypeOf(body) !== Object.prototype
        ) {
          reject(new HttpRequestError(400, "请求 JSON 根节点必须是 object"));
          return;
        }
        resolve(body);
      } catch {
        reject(new HttpRequestError(400, "请求必须是有效 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sameOrigin(request, port) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]).has(origin);
}

function validLoopbackHost(request, port) {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]).has(String(request.headers.host ?? "").toLowerCase());
}

function requireLocalMutation(request, port) {
  if (!sameOrigin(request, port)) throw new Error("拒绝跨站请求");
  if (request.headers["x-kacha-studio"] !== "1") {
    throw new Error("缺少本地生产台请求标记");
  }
  if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new Error("只接受 application/json");
  }
}

function requireLocalRead(request, port) {
  if (!sameOrigin(request, port)) throw new Error("拒绝跨站读取");
  if (request.headers["x-kacha-studio"] !== "1") throw new Error("缺少本地生产台读取标记");
}

export function editorSessionExpired(session, atMs = Date.now()) {
  return atMs - Number(session?.openedAtMs ?? 0) > EDITOR_SESSION_MAX_AGE_MS;
}

function activeEditorSession(sessionId) {
  const session = editorSessions.get(sessionId);
  if (!session) throw new Error("Editor browser session 已失效，请重新打开 Timeline");
  if (editorSessionExpired(session)) {
    disposeEditorSession(sessionId);
    throw new Error("Editor browser session 已过期，请重新打开 Timeline");
  }
  return session;
}

function disposeEditorSession(sessionId) {
  const session = editorSessions.get(sessionId);
  for (const response of session?.eventClients ?? []) {
    try { response.end(); } catch {}
  }
  session?.eventClients?.clear();
  editorSessions.delete(sessionId);
}

function editorSourceCurrent(session) {
  if (!session.source) return true;
  if (session.sourceCompromised) return false;
  try {
    const current = fastIdentityMatches(session.source.path, session.source.identity);
    if (!current) session.sourceCompromised = true;
    return current;
  } catch {
    session.sourceCompromised = true;
    return false;
  }
}

function assertEditorSourceCurrent(session) {
  if (!editorSourceCurrent(session)) throw new HttpRequestError(409, "源媒体身份已变化，请重新打开 Timeline 后再编辑");
}

function browserEditorProject(session, { includeWorkspace = true } = {}) {
  const project = openEditorProject(session.timelinePath);
  const workspace = includeWorkspace && session.workspacePath ? loadEditorWorkspace(session.workspacePath) : null;
  if (editorSourceCurrent(session)) return { ...project, workspace };
  return {
    ...project,
    workspace,
    status: "conflict",
    session: { ...project.session, synchronized: false },
    sourceIntegrity: {
      status: "conflict",
      reason: "source_identity_changed",
      error: "源媒体身份已变化，请重新打开 Timeline 后再编辑",
    },
  };
}

function editorRevision(session) {
  try {
    const timelineSha256 = sha256File(session.timelinePath);
    const project = browserEditorProject(session, { includeWorkspace: false });
    return {
      schemaVersion: "1.0",
      kind: "kacha-editor-revision",
      status: project.status,
      timelineSha256,
      sessionSha256: project.session.currentSha256,
      projectionDigest: project.projection.digest,
      conflict: project.status !== "pass",
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    let timelineSha256 = null;
    try { timelineSha256 = sha256File(session.timelinePath); } catch {}
    return {
      schemaVersion: "1.0",
      kind: "kacha-editor-revision",
      status: "blocked",
      timelineSha256,
      projectionDigest: null,
      conflict: true,
      error: error.message,
      observedAt: new Date().toISOString(),
    };
  }
}

function writeEditorEvent(response, event, payload) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function notifyEditorSession(session, reason = "mutation") {
  const revision = { ...editorRevision(session), reason };
  session.lastRevisionSha256 = revision.timelineSha256;
  for (const response of session.eventClients ?? []) {
    try { writeEditorEvent(response, "revision", revision); } catch {}
  }
}

function serveEditorEvents(request, response, session, sessionId) {
  const totalClients = [...editorSessions.values()].reduce(
    (sum, candidate) => sum + Number(candidate.eventClients?.size ?? 0), 0,
  );
  if (totalClients >= EDITOR_EVENT_CLIENT_LIMIT) throw new HttpRequestError(429, "Editor 实时连接已达上限");
  session.eventClients ??= new Set();
  session.eventClients.add(response);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const initial = editorRevision(session);
  session.lastRevisionSha256 = initial.timelineSha256;
  writeEditorEvent(response, "revision", { ...initial, reason: "connected" });
  const interval = setInterval(() => {
    try {
      if (editorSessionExpired(session)) {
        writeEditorEvent(response, "revision", {
          schemaVersion: "1.0", status: "expired", conflict: true,
          error: "Editor browser session 已过期，请重新打开 Timeline",
          reason: "session_expired", observedAt: new Date().toISOString(),
        });
        disposeEditorSession(sessionId);
        return;
      }
      const current = sha256File(session.timelinePath);
      if (!editorSourceCurrent(session) && !session.sourceDriftNotified) {
        session.sourceDriftNotified = true;
        notifyEditorSession(session, "source_identity_changed");
      } else if (current !== session.lastRevisionSha256) notifyEditorSession(session, "external_change");
      else response.write(": heartbeat\n\n");
    } catch (error) {
      writeEditorEvent(response, "revision", {
        schemaVersion: "1.0", status: "blocked", conflict: true,
        error: error.message, reason: "poll_failed", observedAt: new Date().toISOString(),
      });
    }
  }, 1000);
  interval.unref();
  const close = () => {
    clearInterval(interval);
    session.eventClients?.delete(response);
  };
  request.once("close", close);
  response.once("close", close);
}

function waveformKey(session, width) {
  const identity = session.source?.identity ?? {};
  return [identity.path, identity.sizeBytes, identity.mtimeMs, identity.ctimeMs, identity.inode, width].join(":");
}

function generateWaveform(session, width) {
  if (!session.source?.path || !fileIdentityMatches(session.source.path, session.source.identity)) {
    return Promise.reject(new HttpRequestError(409, "源媒体身份已变化，请重新打开 Timeline"));
  }
  const key = waveformKey(session, width);
  if (waveformCache.has(key)) return Promise.resolve(waveformCache.get(key));
  if (waveformPending.has(key)) return waveformPending.get(key);
  if (waveformPending.size >= WAVEFORM_CONCURRENCY_LIMIT) {
    return Promise.reject(new HttpRequestError(429, "Editor 波形生成繁忙，请稍后重试"));
  }
  const task = new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", session.source.path,
      "-filter_complex", `aformat=channel_layouts=mono,showwavespic=s=${width}x96:colors=0xD59A52`,
      "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    let outputBytes = 0;
    let errorBytes = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= 4 * 1024 * 1024) output.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes <= 64 * 1024) errors.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || signal || outputBytes === 0 || outputBytes > 4 * 1024 * 1024) {
        reject(new HttpRequestError(422, Buffer.concat(errors).toString("utf8").trim() || "源媒体没有可生成的音频波形"));
        return;
      }
      if (!fileIdentityMatches(session.source.path, session.source.identity)) {
        reject(new HttpRequestError(409, "波形生成期间源媒体身份发生变化，请重新打开 Timeline"));
        return;
      }
      const buffer = Buffer.concat(output);
      waveformCache.set(key, buffer);
      while (waveformCache.size > WAVEFORM_CACHE_LIMIT) waveformCache.delete(waveformCache.keys().next().value);
      resolve(buffer);
    });
  }).finally(() => waveformPending.delete(key));
  waveformPending.set(key, task);
  return task;
}

async function serveWaveform(response, session, requestedWidth) {
  if (!session.source) throw new HttpRequestError(404, "Editor session 没有源媒体");
  const width = Number(requestedWidth ?? 1200);
  if (!Number.isInteger(width) || width < 240 || width > 2048) throw new HttpRequestError(400, "waveform width 必须是 240–2048 整数");
  const body = await generateWaveform(session, width);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "image/png",
    "Content-Length": body.length,
    "Cache-Control": "private, max-age=300",
  });
  response.end(body);
}

async function nativePick(kind) {
  if (process.platform !== "darwin") {
    throw new Error("原生路径选择当前只支持 macOS；可以直接粘贴绝对路径");
  }
  const script = kind === "directory"
    ? 'POSIX path of (choose folder with prompt "选择咔嚓项目输出目录")'
    : kind === "document"
      ? 'POSIX path of (choose file with prompt "选择脚本或内容文档")'
      : 'POSIX path of (choose file with prompt "选择要剪辑的视频")';
  // Async spawn keeps the single-threaded studio server (other pages, SSE
  // heartbeats) responsive while a native dialog stays open.
  const result = await new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("原生路径选择超时"));
    }, 10 * 60 * 1000);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: stdout.join(""), stderr: stderr.join("") });
    });
  });
  if (result.status !== 0) {
    const message = result.stderr.trim();
    if (/User canceled/i.test(message) || result.status === 1) {
      return { cancelled: true, path: null };
    }
    throw new Error(message || "原生路径选择失败");
  }
  const selectedPath = result.stdout.trim();
  return {
    cancelled: false,
    path: kind === "directory" ? selectedPath.replace(/\/$/, "") : selectedPath,
  };
}

function serveFile(response, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    text(response, 404, "Not found");
    return;
  }
  const body = fs.readFileSync(file);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": MIME_TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function serveMedia(request, response, media) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(media.path, flags);
  const stat = fs.fstatSync(descriptor);
  if (
    !stat.isFile()
    || stat.size !== Number(media.identity.sizeBytes)
    || Math.abs(Math.trunc(stat.mtimeMs) - Number(media.identity.mtimeMs)) > 1
    || Math.abs(Math.trunc(stat.ctimeMs) - Number(media.identity.ctimeMs)) > 1
    || (
      media.identity.inode !== null
      && media.identity.inode !== undefined
      && Number(stat.ino) !== Number(media.identity.inode)
    )
  ) {
    fs.closeSync(descriptor);
    throw new Error("审片媒体在验证与读取之间发生变化");
  }
  const range = request.headers.range;
  const contentType = MIME_TYPES[path.extname(media.path).toLowerCase()] ?? "application/octet-stream";
  const close = () => {
    try { fs.closeSync(descriptor); } catch {}
  };
  if (!range) {
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Accept-Ranges": "bytes",
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
      close();
      response.end();
    } else fs.createReadStream(null, { fd: descriptor, autoClose: true }).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    close();
    response.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }
  if (!match[1] && !match[2]) {
    close();
    response.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
  const start = suffixLength === null ? Number(match[1]) : Math.max(0, stat.size - suffixLength);
  const end = suffixLength === null && match[2]
    ? Math.min(Number(match[2]), stat.size - 1)
    : stat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
    close();
    response.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...SECURITY_HEADERS,
    "Accept-Ranges": "bytes",
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Content-Length": end - start + 1,
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    close();
    response.end();
  } else fs.createReadStream(null, { fd: descriptor, start, end, autoClose: true }).pipe(response);
}

function safeStaticFile(urlPath) {
  const routes = {
    "/": path.join(studioRoot, "index.html"),
    "/index.html": path.join(studioRoot, "index.html"),
    "/app.css": path.join(studioRoot, "app.css"),
    "/app.js": path.join(studioRoot, "app.js"),
    "/shared.js": path.join(studioRoot, "shared.js"),
    "/review": path.join(studioRoot, "review.html"),
    "/review.html": path.join(studioRoot, "review.html"),
    "/review.css": path.join(studioRoot, "review.css"),
    "/review.js": path.join(studioRoot, "review.js"),
    "/project": path.join(studioRoot, "project.html"),
    "/project.html": path.join(studioRoot, "project.html"),
    "/project.css": path.join(studioRoot, "project.css"),
    "/project.js": path.join(studioRoot, "project.js"),
    "/content": path.join(studioRoot, "content.html"),
    "/content.html": path.join(studioRoot, "content.html"),
    "/content.css": path.join(studioRoot, "content.css"),
    "/content.js": path.join(studioRoot, "content.js"),
    "/editor": path.join(studioRoot, "editor.html"),
    "/editor.html": path.join(studioRoot, "editor.html"),
    "/editor.css": path.join(studioRoot, "editor.css"),
    "/editor.js": path.join(studioRoot, "editor.js"),
    "/brand/kacha-logo.png": brandLogo,
  };
  return routes[urlPath] ?? null;
}

async function handleApi(request, response, url, port) {
  const pathname = url.pathname;
  if (request.method === "GET" && pathname === "/api/health") {
    json(response, 200, {
      schemaVersion: "1.0",
      status: "pass",
      service: "kacha-production-studio",
      localOnly: true,
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/bootstrap") {
    const catalog = loadProductionCatalog();
    const loaded = loadKachaConfig({ includeSecrets: false });
    json(response, 200, {
      ...catalog,
      runtime: {
        configurationDigest: loaded.digest,
        configurationSources: loaded.sources,
        defaultStyleProfile: loaded.config.style.profile,
        fontRegistry: loaded.config.tools.fontRegistry,
        sourceSeparation: loaded.config.execution.sourceSeparation,
        localOnly: true,
      },
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/flight") {
    requireLocalRead(request, port);
    const projectRoot = url.searchParams.get("projectRoot");
    if (!projectRoot || !path.isAbsolute(projectRoot)) {
      throw new Error("flight projectRoot must be an absolute path");
    }
    json(response, 200, buildFlightSnapshot(projectRoot));
    return;
  }
  if (["GET", "HEAD"].includes(request.method) && pathname === "/api/review/media") {
    if (!sameOrigin(request, port)) throw new Error("拒绝跨站审片媒体读取");
    const media = resolveReviewMedia(
      url.searchParams.get("bundle"),
      url.searchParams.get("decision"),
      url.searchParams.get("variant") ?? "after",
    );
    serveMedia(request, response, media);
    return;
  }
  if (["GET", "HEAD"].includes(request.method) && pathname === "/api/editor/media") {
    const session = activeEditorSession(url.searchParams.get("session"));
    if (!session?.source) throw new Error("Editor session 或源视频不存在");
    serveMedia(request, response, session.source);
    return;
  }
  if (request.method === "GET" && pathname === "/api/editor/events") {
    if (!sameOrigin(request, port)) throw new Error("拒绝跨站 Editor 事件读取");
    const session = activeEditorSession(url.searchParams.get("session"));
    serveEditorEvents(request, response, session, url.searchParams.get("session"));
    return;
  }
  if (request.method === "GET" && pathname === "/api/editor/waveform") {
    if (!sameOrigin(request, port)) throw new Error("拒绝跨站 Editor 波形读取");
    const session = activeEditorSession(url.searchParams.get("session"));
    await serveWaveform(response, session, url.searchParams.get("width"));
    return;
  }
  if (request.method !== "POST") {
    json(response, 405, { status: "blocked", error: "Method not allowed" });
    return;
  }
  requireLocalMutation(request, port);
  const body = await readRequestBody(request);
  if (pathname === "/api/pick-video") {
    json(response, 200, { status: "pass", ...(await nativePick("video")) });
    return;
  }
  if (pathname === "/api/pick-output") {
    json(response, 200, { status: "pass", ...(await nativePick("directory")) });
    return;
  }
  if (pathname === "/api/pick-document") {
    json(response, 200, { status: "pass", ...(await nativePick("document")) });
    return;
  }
  if (pathname === "/api/probe-video") {
    json(response, 200, inspectProductionVideo(body.videoPath));
    return;
  }
  if (pathname === "/api/styles") {
    const saved = saveCustomStyle(body);
    json(response, 201, {
      schemaVersion: "1.0",
      status: "pass",
      style: saved.style,
    });
    return;
  }
  if (pathname === "/api/preview-request") {
    json(response, 200, compileProductionRequest(body, { write: false }));
    return;
  }
  if (pathname === "/api/compile") {
    json(response, 201, compileProductionRequest(body));
    return;
  }
  if (pathname === "/api/project/status") {
    json(response, 200, projectStatus(body.projectRoot));
    return;
  }
  if (pathname === "/api/content/start") {
    if (!body.projectRoot || !path.isAbsolute(body.projectRoot)) {
      throw new Error("内容项目目录必须是非空绝对路径");
    }
    if (!body.scriptPath && !body.topic) {
      throw new Error("请提供脚本路径或中心选题");
    }
    const catalog = loadProductionCatalog();
    const visualLanguageIds = new Set(
      catalog.visualLanguages.map((language) => language.id),
    );
    if (!visualLanguageIds.has(body.style)) {
      throw new Error(`内容项目视觉语言不存在或不是当前五风格权威：${body.style}`);
    }
    json(response, 201, initializeProject({
      script: body.scriptPath || null,
      topic: body.topic || null,
      projectRoot: body.projectRoot,
      projectId: body.projectId,
      task: "content_generation",
      show: body.show,
      style: body.style,
      platform: body.platform,
      language: "zh",
      confirmExecute: false,
      development: false,
    }));
    return;
  }
  if (pathname === "/api/project/run" || pathname === "/api/project/resume") {
    if (body.confirmExecute !== true) {
      throw new Error("执行或恢复项目必须显式设置 confirmExecute=true");
    }
    json(response, 200, runProject(body.projectRoot, {
      confirmExecute: true,
      resume: pathname.endsWith("/resume"),
      includeRender: body.includeRender === true,
      acceptRuntimeUpdate: body.acceptRuntimeUpdate === true,
    }));
    return;
  }
  if (pathname === "/api/review/open") {
    const loaded = loadReviewBundle(body.bundlePath);
    json(response, 200, {
      schemaVersion: "1.0",
      status: "pass",
      bundle: loaded.bundle,
      session: loaded.session ? { ...loaded.session, path: loaded.sessionFile } : null,
    });
    return;
  }
  if (pathname === "/api/review/record") {
    const result = recordReviewDecision(body.bundlePath, body);
    const session = readJson(result.session.path);
    json(response, 200, {
      schemaVersion: "1.0",
      status: "pass",
      decision: result.decision,
      session: { ...session, path: result.session.path },
    });
    return;
  }
  if (pathname === "/api/review/learn") {
    json(response, 201, {
      schemaVersion: "1.0",
      status: "pass",
      ...buildPreferenceCandidate(body.sessionPath, body.outputPath),
    });
    return;
  }
  if (pathname === "/api/release/open") {
    json(response, 200, openReleaseReview(body.projectManifestPath));
    return;
  }
  if (pathname === "/api/release/initialize") {
    json(response, 201, initializeReleaseReview(body.projectManifestPath, body));
    return;
  }
  if (pathname === "/api/release/record") {
    json(response, 200, recordReleaseCheck(body.projectManifestPath, body));
    return;
  }
  if (pathname === "/api/release/approve") {
    json(response, 200, approveReleaseReview(body.projectManifestPath, body));
    return;
  }
  if (pathname === "/api/observe") {
    json(response, 200, { status: "pass", ...observeProject(body.projectRoot) });
    return;
  }
  if (pathname === "/api/editor/open") {
    if (!body.timelinePath || !path.isAbsolute(body.timelinePath)) {
      throw new Error("Timeline 路径必须是绝对路径");
    }
    const currentTime = Date.now();
    for (const [id, session] of editorSessions.entries()) {
      if (currentTime - session.openedAtMs > EDITOR_SESSION_MAX_AGE_MS) disposeEditorSession(id);
    }
    while (editorSessions.size >= EDITOR_SESSION_LIMIT) {
      disposeEditorSession(editorSessions.keys().next().value);
    }
    let timelinePath = body.timelinePath;
    let workspace = null;
    try {
      const requested = readJson(path.resolve(body.timelinePath));
      if (requested?.kind === "kacha-editor-workspace") {
        const resolved = resolveWorkspaceTimeline(body.timelinePath, body.timelineId ?? null);
        workspace = resolved.view;
        timelinePath = resolved.timeline.absolutePath;
      }
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Timeline/Workspace 必须是有效 JSON");
      throw error;
    }
    const project = openEditorProject(timelinePath, { includeSourceHash: true });
    if (project.status !== "pass") {
      throw new Error("Timeline 与既有 editor session 冲突；请先检查 editor history/recovery，再继续写入");
    }
    const sessionId = randomUUID();
    editorSessions.set(sessionId, {
      timelinePath: project.session.timelinePath,
      workspacePath: workspace?.workspace?.path ?? null,
      workspaceTimelineId: workspace
        ? workspace.timelines.find((entry) => entry.absolutePath === project.session.timelinePath)?.id ?? workspace.activeTimelineId
        : null,
      source: project.projection.timeline.sourceIdentity
        ? {
            path: project.projection.timeline.sourceIdentity.path,
            identity: project.projection.timeline.sourceIdentity,
          }
        : null,
      openedAt: new Date().toISOString(),
      openedAtMs: currentTime,
      sourceCompromised: false,
      sourceDriftNotified: false,
      eventClients: new Set(),
      lastRevisionSha256: project.session.currentSha256,
    });
    json(response, 200, {
      ...project,
      workspace,
      browserSessionId: sessionId,
      previewProviders: listPreviewProviders(),
    });
    return;
  }
  if (pathname.startsWith("/api/editor/")) {
    const session = activeEditorSession(body.sessionId);
    if (pathname === "/api/editor/project") {
      json(response, 200, browserEditorProject(session));
      return;
    }
    if (pathname === "/api/editor/command") {
      assertEditorSourceCurrent(session);
      const result = applyEditorCommand(session.timelinePath, body.command);
      notifyEditorSession(session, "command");
      json(response, 200, result);
      return;
    }
    if (pathname === "/api/editor/undo") {
      assertEditorSourceCurrent(session);
      const result = undoEditorCommand(session.timelinePath, body.baseSha256);
      notifyEditorSession(session, "undo");
      json(response, 200, result);
      return;
    }
    if (pathname === "/api/editor/redo") {
      assertEditorSourceCurrent(session);
      const result = redoEditorCommand(session.timelinePath, body.baseSha256);
      notifyEditorSession(session, "redo");
      json(response, 200, result);
      return;
    }
    if (pathname === "/api/editor/history") {
      json(response, 200, editorHistory(session.timelinePath));
      return;
    }
    if (pathname === "/api/editor/capabilities") {
      json(response, 200, professionalCapabilityMap());
      return;
    }
    if (pathname === "/api/editor/delivery-profiles") {
      json(response, 200, listDeliveryProfiles());
      return;
    }
    if (pathname === "/api/editor/delivery-plan") {
      assertEditorSourceCurrent(session);
      json(response, 201, createDeliveryPlan(session.timelinePath, body.profileId, body.outputPath));
      return;
    }
    if (pathname === "/api/editor/delivery-bundle") {
      assertEditorSourceCurrent(session);
      json(response, 201, createSelfContainedBundle(session.timelinePath, body.outputPath, { includeMedia: body.includeMedia === true }));
      return;
    }
    if (pathname === "/api/editor/nle-export") {
      assertEditorSourceCurrent(session);
      json(response, 201, exportNle(session.timelinePath, body.format, body.outputPath));
      return;
    }
    if (pathname === "/api/editor/workspace-duplicate") {
      assertEditorSourceCurrent(session);
      if (!session.workspacePath) throw new Error("当前 Editor session 未从 Workspace 打开");
      const workspace = duplicateWorkspaceTimeline(session.workspacePath, {
        expectedWorkspaceSha256: body.expectedWorkspaceSha256,
        sourceTimelineId: session.workspaceTimelineId,
        newTimelineId: body.newTimelineId,
        label: body.label,
        outputPath: body.outputPath,
        width: body.width,
        height: body.height,
        role: body.role,
      });
      json(response, 201, workspace);
      return;
    }
    if (pathname === "/api/editor/bin") {
      json(response, 200, listProjectBin(session.timelinePath, {
        indexPath: body.indexPath ?? null,
        query: body.query ?? "",
        kind: body.kind ?? null,
        license: body.license ?? null,
        limit: body.limit ?? 40,
      }));
      return;
    }
  }
  json(response, 404, { status: "blocked", error: "Unknown API route" });
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function startStudioServerFromCli(args = process.argv.slice(2)) {
  const requestedPort = Number(option(args, "--port", 4179));
  if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
    throw new Error("--port 必须是 1024 至 65535 的整数");
  }
  if (!fs.existsSync(path.join(studioRoot, "index.html"))) {
    throw new Error(`生产页面缺失：${studioRoot}`);
  }
  // Validate the immutable production catalog before the server announces
  // readiness. Later bootstrap calls reuse that private process-level base,
  // while custom style files are still read on every request.
  loadProductionCatalog();
  const server = http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url ?? "/", `http://127.0.0.1:${requestedPort}`);
    } catch {
      // Malformed request line (e.g. invalid characters) must fail fast with a
      // 400 instead of throwing inside the async handler and hanging the
      // connection until requestTimeout.
      json(response, 400, {
        schemaVersion: "1.0",
        status: "blocked",
        error: "无法解析请求路径",
      });
      return;
    }
    try {
      if (!validLoopbackHost(request, requestedPort)) {
        json(response, 421, {
          schemaVersion: "1.0",
          status: "blocked",
          error: "拒绝非 loopback Host；可能存在 DNS rebinding",
        });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url, requestedPort);
        return;
      }
      const file = safeStaticFile(url.pathname);
      if (!file) {
        text(response, 404, "Not found");
        return;
      }
      serveFile(response, file);
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode)
        && error.statusCode >= 400
        && error.statusCode <= 599
        ? error.statusCode
        : 400;
      json(response, statusCode, {
        schemaVersion: "1.0",
        status: "blocked",
        error: error.message,
      });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.listen(requestedPort, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${requestedPort}`;
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "running",
      url,
      localOnly: true,
      message: "按 Ctrl+C 停止咔嚓本地生产台",
    }, null, 2));
    if (!args.includes("--no-open")) openBrowser(url);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startStudioServerFromCli();
}
