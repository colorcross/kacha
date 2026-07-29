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
      + "style-src 'self' 'unsafe-inline'",
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

function requireLocalMutation(request, port) {
  if (!sameOrigin(request, port)) throw new Error("拒绝跨站请求");
  if (request.headers["x-kacha-studio"] !== "1") {
    throw new Error("缺少本地生产台请求标记");
  }
  if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new Error("只接受 application/json");
  }
}

function nativePick(kind) {
  if (process.platform !== "darwin") {
    throw new Error("原生路径选择当前只支持 macOS；可以直接粘贴绝对路径");
  }
  const script = kind === "directory"
    ? 'POSIX path of (choose folder with prompt "选择咔嚓项目输出目录")'
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

function safeStaticFile(urlPath) {
  const routes = {
    "/": path.join(studioRoot, "index.html"),
    "/index.html": path.join(studioRoot, "index.html"),
    "/app.css": path.join(studioRoot, "app.css"),
    "/app.js": path.join(studioRoot, "app.js"),
    "/brand/kacha-logo.png": brandLogo,
  };
  return routes[urlPath] ?? null;
}

async function handleApi(request, response, pathname, port) {
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
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url.pathname, requestedPort);
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
