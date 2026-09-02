#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireFileLock } from "./kacha_utils.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function safeRelative(value, label) {
  if (
    typeof value !== "string"
    || value.trim() === ""
    || path.isAbsolute(value)
    || value.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`${label} 不是安全相对路径：${value}`);
  }
  return path.normalize(value);
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} 失败\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function copyCore(source, output) {
  fs.cpSync(source, output, {
    recursive: true,
    errorOnExist: true,
    filter(candidate) {
      const relative = path.relative(source, candidate);
      if (relative === "") return true;
      const segments = relative.split(path.sep);
      // 本机环境产物可能嵌在子目录（如 scripts/whiteboard_engine/.venv），
      // 任何层级出现都不进入安装副本。
      if (segments.some((segment) => [".venv", "venv", "__pycache__", "node_modules", ".playwright-cli"].includes(segment))) {
        return false;
      }
      const first = segments[0];
      return ![
        ".git",
        ".DS_Store",
        ".kacha-version",
        ".playwright-cli",
        "node_modules",
        "output",
        "outputs",
        "quality",
        "tools",
        "website",
      ].includes(first);
    },
  });
}

function rejectSymlinks(root, label) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} 不允许符号链接：${current}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
    }
  }
}

function patchTargets(patchFile) {
  const targets = [];
  for (const line of fs.readFileSync(patchFile, "utf8").split(/\r?\n/)) {
    const match = /^(?:---|\+\+\+)\s+([^\t ]+)/.exec(line);
    if (!match || match[1] === "/dev/null") continue;
    const stripped = match[1].replace(/^[ab]\//, "");
    targets.push(safeRelative(stripped, `补丁 ${patchFile}`));
  }
  if (targets.length === 0) {
    throw new Error(`补丁没有可验证的目标路径：${patchFile}`);
  }
  return targets;
}

function applyOverlay(overlay, bundle) {
  const manifestFile = path.join(overlay, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`overlay 缺少 manifest.json：${overlay}`);
  }
  rejectSymlinks(overlay, "overlay");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.schemaVersion !== "1.0" || !manifest.id) {
    throw new Error("overlay manifest 必须包含 schemaVersion=1.0 和 id");
  }
  for (const entry of manifest.files ?? []) {
    const relative = safeRelative(entry, "overlay file");
    const source = path.join(overlay, "files", relative);
    const target = path.join(bundle, relative);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`overlay 文件不存在：${source}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode);
  }
  for (const entry of manifest.patches ?? []) {
    const relative = safeRelative(entry, "overlay patch");
    const patchFile = path.join(overlay, relative);
    if (!fs.existsSync(patchFile) || !fs.statSync(patchFile).isFile()) {
      throw new Error(`overlay 补丁不存在：${patchFile}`);
    }
    patchTargets(patchFile);
    run("/usr/bin/patch", ["--batch", "--forward", "-p1", "-i", patchFile], bundle);
  }
  return manifest.id;
}

function treeDigest(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`bundle 不允许符号链接：${current}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      files.push(current);
    }
  }
  const digest = crypto.createHash("sha256");
  for (const file of files.sort()) {
    digest.update(path.relative(root, file));
    digest.update("\0");
    digest.update(fs.readFileSync(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function coreIdentity(source) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  });
  const ref = result.status === 0 ? result.stdout.trim() : "not-a-git-checkout";
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: source,
    encoding: "utf8",
  });
  return {
    ref,
    dirty: status.status === 0 && status.stdout.trim() !== "",
  };
}

function verifyBundle(bundle, source) {
  if (!fs.existsSync(path.join(bundle, "SKILL.md"))) {
    throw new Error("组合后的 bundle 缺少 SKILL.md");
  }
  const projectFonts = path.resolve(source, "..", "Fonts");
  const verificationEnvironment = fs.existsSync(projectFonts)
    ? { ...process.env, KACHA_FONTS_DIR: projectFonts }
    : process.env;
  run(
    process.execPath,
    [path.join(bundle, "tests", "run_tests.mjs")],
    bundle,
    { env: verificationEnvironment },
  );
  const privateTests = path.join(bundle, "tests", "private");
  if (fs.existsSync(privateTests)) {
    for (const entry of fs.readdirSync(privateTests).sort()) {
      if (entry.endsWith(".mjs")) {
        run(
          process.execPath,
          [path.join(privateTests, entry)],
          bundle,
          { env: verificationEnvironment },
        );
      }
    }
  }
  run(
    "bash",
    [path.join(bundle, "tests", "test_installer.sh")],
    bundle,
    { env: verificationEnvironment },
  );
}

const args = process.argv.slice(2);
const source = path.resolve(option(args, "--source", path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)));
const overlayInput = option(args, "--overlay");
const overlay = overlayInput ? path.resolve(overlayInput) : null;
const agent = option(args, "--agent", "both");
const apply = args.includes("--apply");
const verifyOnly = args.includes("--verify-only");
const home = path.resolve(option(args, "--home", os.homedir()));
const outputInput = option(args, "--output");
const output = outputInput ? path.resolve(outputInput) : null;
function emit(report) {
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporaryOutput = `${output}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryOutput, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(temporaryOutput, output);
  }
  console.log(JSON.stringify(report, null, 2));
}
if (!["codex", "claude", "both"].includes(agent)) {
  fail("用法：sync_skill_installs.mjs [--source REPO] [--overlay DIR] "
    + "[--agent codex|claude|both] [--home HOME] [--apply] [--output FILE]", 2);
}
if (!fs.existsSync(path.join(source, "SKILL.md"))) {
  fail(`source 不是咔嚓仓库：${source}`, 2);
}
if (overlay && !fs.existsSync(overlay)) {
  fail(`overlay 不存在：${overlay}`, 2);
}

const targets = [
  ...(agent === "codex" || agent === "both"
    ? [{ agent: "codex", path: path.join(home, ".codex", "skills", "kacha") }]
    : []),
  ...(agent === "claude" || agent === "both"
    ? [{ agent: "claude", path: path.join(home, ".claude", "skills", "kacha") }]
    : []),
];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-bundle-"));
const bundle = path.join(temporary, "kacha");
let releaseInstallLock = null;
try {
  if (apply) {
    releaseInstallLock = acquireFileLock(path.join(home, ".kacha-install.lock"), {
      purpose: "kacha-install-sync",
      staleAfterMs: 24 * 60 * 60 * 1000,
    });
  }
  copyCore(source, bundle);
  run("python3", [path.join(bundle, "scripts", "scan_secrets.py")], bundle);
  const coreContentDigest = treeDigest(bundle);
  const overlayId = overlay ? applyOverlay(overlay, bundle) : "none";
  const identity = coreIdentity(source);
  fs.writeFileSync(
    path.join(bundle, ".kacha-version"),
    [
      `core_ref=${identity.ref}`,
      `core_dirty=${identity.dirty}`,
      `core_content_sha256=${coreContentDigest}`,
      `overlay=${overlayId}`,
      "",
    ].join("\n"),
  );
  if (!verifyOnly) verifyBundle(bundle, source);
  const bundleDigest = treeDigest(bundle);
  const before = targets.map((target) => ({
    ...target,
    exists: fs.existsSync(target.path),
    digest: fs.existsSync(target.path) ? treeDigest(target.path) : null,
  }));
  if (!apply) {
    emit({
      status: "dry_run_pass",
      source,
      core: identity,
      overlay: overlayId,
      bundleDigest,
      targets: before.map((target) => ({
        ...target,
        action: target.digest === bundleDigest ? "unchanged" : "replace_with_backup",
      })),
    });
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupRoot = path.join(home, ".kacha-backups", `${timestamp}-${process.pid}`);
    const staged = [];
    for (const target of before) {
      if (target.digest === bundleDigest) continue;
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      const stage = path.join(
        path.dirname(target.path),
        `.kacha.next-${process.pid}-${target.agent}`,
      );
      if (fs.existsSync(stage)) {
        throw new Error(`发现未处理的旧 staging 目录：${stage}`);
      }
      fs.cpSync(bundle, stage, { recursive: true, errorOnExist: true });
      if (treeDigest(stage) !== bundleDigest) {
        throw new Error(`staging bundle hash 不一致：${stage}`);
      }
      staged.push({ ...target, stage });
    }

    const replaced = [];
    try {
      for (const target of staged) {
        fs.mkdirSync(backupRoot, { recursive: true });
        const backup = path.join(backupRoot, target.agent);
        if (target.exists) fs.renameSync(target.path, backup);
        fs.renameSync(target.stage, target.path);
        replaced.push({ ...target, backup: target.exists ? backup : null });
      }
      for (const target of targets) {
        if (treeDigest(target.path) !== bundleDigest) {
          throw new Error(`安装后 bundle hash 不一致：${target.path}`);
        }
      }
    } catch (error) {
      for (const target of [...replaced].reverse()) {
        if (fs.existsSync(target.path)) {
          const failed = path.join(
            backupRoot,
            `failed-new-${target.agent}`,
          );
          fs.renameSync(target.path, failed);
        }
        if (target.backup && fs.existsSync(target.backup)) {
          fs.renameSync(target.backup, target.path);
        }
      }
      for (const target of staged) {
        if (fs.existsSync(target.stage)) {
          fs.mkdirSync(backupRoot, { recursive: true });
          fs.renameSync(
            target.stage,
            path.join(backupRoot, `unapplied-${target.agent}`),
          );
        }
      }
      throw error;
    }

    emit({
      status: "applied",
      source,
      core: identity,
      overlay: overlayId,
      bundleDigest,
      backupRoot: replaced.some((target) => target.backup) ? backupRoot : null,
      targets: targets.map((target) => ({
        ...target,
        digest: treeDigest(target.path),
        action: replaced.some((item) => item.agent === target.agent)
          ? "replaced"
          : "unchanged",
      })),
    });
  }
} catch (error) {
  console.error(`同步失败，当前安装未被无证据覆盖：${error.message}`);
  process.exitCode = 1;
} finally {
  try { releaseInstallLock?.(); } catch {}
  fs.rmSync(temporary, { recursive: true, force: true });
}
