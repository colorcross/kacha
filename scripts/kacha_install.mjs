#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  fail,
  option,
} from "./agent_workspace_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = args[0];

function usage() {
  fail(
    "KACHA-E140",
    "用法：kacha.mjs install status [--source REPO] "
      + "[--agent codex|claude|both] [--home HOME]\n"
      + "  kacha.mjs install sync [同上] [--overlay DIR] [--apply]",
    2,
  );
}

if (!["status", "sync"].includes(action)) usage();
const source = path.resolve(option(args, "--source", path.join(scriptDirectory, "..")));
const home = path.resolve(option(args, "--home", os.homedir()));
const agent = option(args, "--agent", "both");
if (!["codex", "claude", "both"].includes(agent)) usage();
const targetPaths = [
  ...(agent === "codex" || agent === "both"
    ? [{ agent: "codex", path: path.join(home, ".codex", "skills", "kacha") }]
    : []),
  ...(agent === "claude" || agent === "both"
    ? [{ agent: "claude", path: path.join(home, ".claude", "skills", "kacha") }]
    : []),
];

function installedVersion(directory) {
  const file = path.join(directory, ".kacha-version");
  if (!fs.existsSync(file)) return null;
  const result = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

const installedBefore = Object.fromEntries(
  targetPaths.map((target) => [target.agent, installedVersion(target.path)]),
);
const installedOverlays = Object.values(installedBefore)
  .map((value) => value?.overlay)
  .filter((value) => value && value !== "none");
if (
  action === "sync"
  && args.includes("--apply")
  && !option(args, "--overlay")
  && installedOverlays.length > 0
) {
  fail(
    "KACHA-E120",
    `当前安装包含私有 overlay（${[...new Set(installedOverlays)].join(", ")}）；`
      + "必须传入同一 --overlay，不能静默移除",
  );
}
const command = [
  path.join(scriptDirectory, "sync_skill_installs.mjs"),
  "--source", source,
  "--home", home,
  "--agent", agent,
  "--verify-only",
];
const overlay = option(args, "--overlay");
if (overlay) command.push("--overlay", path.resolve(overlay));
if (action === "sync" && args.includes("--apply")) {
  const verifyIndex = command.indexOf("--verify-only");
  command.splice(verifyIndex, 1);
  command.push("--apply");
}
const result = spawnSync(process.execPath, command, {
  cwd: source,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}
let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  fail("KACHA-E500", `安装状态无法解析：${error.message}`);
}
const targets = (report.targets ?? []).map((target) => ({
  agent: target.agent,
  path: target.path,
  exists: target.exists ?? fs.existsSync(target.path),
  state: target.action === "unchanged" ? "current"
    : target.action === "replaced" ? "synchronized"
      : "out_of_sync",
  digest: target.digest,
  installedVersion: installedVersion(target.path),
}));
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: targets.every((target) => ["current", "synchronized"].includes(target.state))
    ? "pass"
    : "sync_required",
  mode: action === "status" ? "read_only_status"
    : args.includes("--apply") ? "applied" : "dry_run",
  source,
  sourceRef: report.core?.ref ?? null,
  sourceDirty: report.core?.dirty ?? null,
  bundleDigest: report.bundleDigest,
  overlay: report.overlay,
  targets,
  backupRoot: report.backupRoot ?? null,
  nextAction: targets.some((target) => target.state === "out_of_sync")
    ? "完成代码验证后，由 Agent 显式执行 install sync --apply"
    : "none",
}, null, 2));
