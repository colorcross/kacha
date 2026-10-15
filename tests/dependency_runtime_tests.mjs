#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { managedRenderVenv, managedRenderPython, resolveRuntimeCommand, runtimeEnvironment, run } from "../scripts/kacha_utils.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fingerprint = crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(root, "scripts/requirements-render.txt")))
  .update(fs.readFileSync(path.join(root, "scripts/whiteboard_engine/requirements.txt")))
  .digest("hex").slice(0, 16);

function isolatedEnvironment(callback) {
  const saved = { ...process.env };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-dependency-"));
  try {
    delete process.env.KACHA_RENDER_VENV;
    delete process.env.KACHA_PYTHON_BIN;
    delete process.env.KACHA_WHITEBOARD_VENV;
    process.env.XDG_DATA_HOME = temp;
    callback(temp);
  } finally {
    process.env = saved;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test("only a completed matching environment becomes the default renderer", () => isolatedEnvironment((temp) => {
  const env = managedRenderVenv();
  assert.equal(env, path.join(temp, "kacha", "render-envs", fingerprint));
  const python = path.join(env, ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, "");
  assert.equal(managedRenderPython(), null);
  fs.writeFileSync(path.join(env, ".kacha-ready"), "stale-lock\n");
  assert.equal(managedRenderPython(), null);
  fs.writeFileSync(path.join(env, ".kacha-ready"), fingerprint + "\n");
  assert.equal(resolveRuntimeCommand("python3"), python);
  assert.equal(runtimeEnvironment().PATH.split(path.delimiter).includes(path.dirname(python)), true);
  assert.equal(runtimeEnvironment().KACHA_PYTHON_BIN, python);
  process.env.KACHA_PYTHON_BIN = path.join(temp, "explicit-python");
  assert.equal(resolveRuntimeCommand("python3"), process.env.KACHA_PYTHON_BIN);
}));

test("environment check is read-only when dependencies have not been prepared", () => isolatedEnvironment((temp) => {
  const result = spawnSync("python3", [path.join(root, "scripts/whiteboard_engine/prepare_env.py"), "--check"], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /虚拟环境尚未建立/);
  assert.equal(fs.existsSync(path.join(temp, "kacha")), false);
}));

test("child-specific interpreter and data-root overrides beat parent settings", { skip: process.platform === "win32" }, () => isolatedEnvironment((temp) => {
  const parent = path.join(temp, "parent-python");
  const child = path.join(temp, "child-python");
  fs.writeFileSync(parent, "#!/bin/sh\nprintf parent", { mode: 0o755 });
  fs.writeFileSync(child, "#!/bin/sh\nprintf child", { mode: 0o755 });
  process.env.KACHA_PYTHON_BIN = parent;
  const result = run("python3", [], { env: { KACHA_PYTHON_BIN: child }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "child");
  assert.equal(managedRenderVenv({ XDG_DATA_HOME: path.join(temp, "child") }), path.join(temp, "child", "kacha", "render-envs", fingerprint));
}));
