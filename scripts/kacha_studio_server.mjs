#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compileProductionRequest,
  inspectProductionVideo,
  loadProductionCatalog,
  saveCustomStyle,
} from "./kacha_studio.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";
import { readJson } from "./kacha_utils.mjs";
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

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const studioRoot = path.join(skillRoot, "studio");
const brandLogo = path.join(skillRoot, "website", "public", "brand", "kacha-logo.png");
const MAX_BODY_BYTES = 1024 * 1024;
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
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("请求内容超过 1 MB"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("请求必须是有效 JSON"));
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

function nativePick(kind) {
  if (process.platform !== "darwin") {
    throw new Error("原生路径选择当前只支持 macOS；可以直接粘贴绝对路径");
  }
  const script = kind === "directory"
    ? 'POSIX path of (choose folder with prompt "选择咔嚓项目输出目录")'
    : kind === "document"
      ? 'POSIX path of (choose file with prompt "选择脚本或内容文档")'
      : 'POSIX path of (choose file with prompt "选择要剪辑的视频")';
  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    stdio: ["ignore", "pipe", "pipe"],
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
    const media = resolveReviewMedia(
      url.searchParams.get("bundle"),
      url.searchParams.get("decision"),
      url.searchParams.get("variant") ?? "after",
    );
    serveMedia(request, response, media);
    return;
  }
  if (request.method !== "POST") {
    json(response, 405, { status: "blocked", error: "Method not allowed" });
    return;
  }
  requireLocalMutation(request, port);
  const body = await readRequestBody(request);
  if (pathname === "/api/pick-video") {
    json(response, 200, { status: "pass", ...nativePick("video") });
    return;
  }
  if (pathname === "/api/pick-output") {
    json(response, 200, { status: "pass", ...nativePick("directory") });
    return;
  }
  if (pathname === "/api/pick-document") {
    json(response, 200, { status: "pass", ...nativePick("document") });
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
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${requestedPort}`);
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
      json(response, 400, {
        schemaVersion: "1.0",
        status: "blocked",
        error: error.message,
      });
    }
  });
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
