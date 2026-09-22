import fs from "node:fs";
import path from "node:path";

// All candidates must already be staged and hashed. Keep an entry in the undo
// log before the first rename: activation itself can fail after backing up.
export function activateInstallations({ staged, targets, backupRoot, bundleDigest, treeDigest, io = fs }) {
  const touched = [];
  try {
    for (const target of staged) {
      io.mkdirSync(backupRoot, { recursive: true });
      const entry = { ...target, backup: target.exists ? path.join(backupRoot, target.agent) : null,
        backedUp: false, activated: false };
      touched.push(entry);
      if (entry.backup) {
        io.renameSync(target.path, entry.backup);
        entry.backedUp = true;
      }
      io.renameSync(target.stage, target.path);
      entry.activated = true;
    }
    for (const target of targets) {
      if (treeDigest(target.path) !== bundleDigest) throw new Error(`安装后 bundle hash 不一致：${target.path}`);
    }
    return touched;
  } catch (error) {
    const recoveryErrors = [];
    for (const entry of [...touched].reverse()) {
      try {
        if (entry.activated) io.renameSync(entry.path, path.join(backupRoot, `failed-new-${entry.agent}`));
        if (entry.backedUp) io.renameSync(entry.backup, entry.path);
      } catch (recoveryError) { recoveryErrors.push(`${entry.agent}: ${recoveryError.message}`); }
    }
    for (const target of staged) {
      try {
        if (io.existsSync(target.stage)) {
          io.mkdirSync(backupRoot, { recursive: true });
          io.renameSync(target.stage, path.join(backupRoot, `unapplied-${target.agent}`));
        }
      } catch (recoveryError) { recoveryErrors.push(`${target.agent} staging: ${recoveryError.message}`); }
    }
    if (recoveryErrors.length) throw new Error(`${error.message}; 自动恢复未完成，保留备份 ${backupRoot}: ${recoveryErrors.join("; ")}`, { cause: error });
    throw error;
  }
}

export function assertOverlayPreserved(targets, overlayId) {
  for (const target of targets) {
    const file = path.join(target.path, ".kacha-version");
    if (!fs.existsSync(file)) continue;
    const current = /^overlay=(.*)$/m.exec(fs.readFileSync(file, "utf8"))?.[1]?.trim();
    if (current && current !== "none" && current !== overlayId) {
      throw new Error(`${target.agent} 当前安装包含私有 overlay（${current}）；必须传入同一 --overlay，不能静默移除或替换`);
    }
  }
}
