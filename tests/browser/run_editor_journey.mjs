#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (!process.env.KACHA_PLAYWRIGHT_MODULE) throw new Error("Set KACHA_PLAYWRIGHT_MODULE to the installed Playwright index.mjs before make check-browser.");
await import(process.env.KACHA_PLAYWRIGHT_MODULE);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-browser-"));
const artifacts = path.join(root, "output", "playwright", `editor-${Date.now()}`);
const socket = net.createServer();
await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
let server;
function execute(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `command failed: ${result.signal}`);
  return result.stdout;
}
try {
  execute(["examples/first-run/demo.mjs", "--output-dir", temporary]);
  const workspace = path.join(temporary, "workspace.json");
  execute(["scripts/kacha.mjs", "workspace", "create", "--output", workspace, "--timeline", path.join(temporary, "timeline.json")]);
  server = spawn(process.execPath, ["scripts/kacha.mjs", "studio", "serve", "--port", String(port), "--no-open"], { cwd: root, stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
  let serverError = "";
  server.stderr.on("data", (chunk) => { serverError = (serverError + chunk).slice(-8000); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(serverError || "Studio exited before startup");
    try { if ((await fetch(`${origin}/editor`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Studio did not start: ${serverError}`);
  process.stdout.write(execute(["tests/browser/studio_state_journey.mjs", origin, artifacts]));
  process.stdout.write(execute(["tests/browser/content_editor_state_journey.mjs", origin, workspace, artifacts]));
  process.stdout.write(execute(["tests/browser/editor_v3_journey.mjs", origin, workspace, artifacts]));
} finally {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    try { process.kill(process.platform !== "win32" ? -server.pid : server.pid, "SIGTERM"); } catch {}
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    try { process.kill(process.platform !== "win32" ? -server.pid : server.pid, "SIGKILL"); } catch {}
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
