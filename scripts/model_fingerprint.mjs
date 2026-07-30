#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  fileIdentity,
  readJson,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

function inventory(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        entries.push({
          path: relative,
          sizeBytes: stat.size,
          mtimeNs: Math.trunc(stat.mtimeMs * 1_000_000),
          ctimeNs: Math.trunc(stat.ctimeMs * 1_000_000),
          inode: stat.ino ?? null,
        });
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: relative, symlink: fs.readlinkSync(absolute) });
      }
    }
  };
  visit(root);
  return entries;
}

function cacheFile(metadataDigest) {
  const root = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(root, "kacha", "model-fingerprints", "v1", `${metadataDigest}.json`);
}

export function fingerprintPath(input) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`模型路径不存在：${resolved}`);
  if (fs.statSync(resolved).isFile()) {
    return { kind: "file", ...fileIdentity(resolved) };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`模型路径既不是文件也不是目录：${resolved}`);
  }
  const metadata = inventory(resolved);
  const metadataDigest = sha256Value({ root: resolved, entries: metadata });
  const cachedFile = cacheFile(metadataDigest);
  if (fs.existsSync(cachedFile)) {
    try {
      const cached = readJson(cachedFile);
      if (
        cached.path === resolved
        && cached.metadataDigest === metadataDigest
        && /^[a-f0-9]{64}$/i.test(cached.sha256 ?? "")
      ) {
        return { ...cached, cache: "hit" };
      }
    } catch {
      // Recompute a malformed cache entry.
    }
  }
  const content = metadata.map((entry) => (
    entry.symlink
      ? entry
      : { path: entry.path, sizeBytes: entry.sizeBytes, sha256: sha256File(path.join(resolved, entry.path)) }
  ));
  const report = {
    schemaVersion: "1.0",
    kind: "directory",
    path: resolved,
    files: content.filter((entry) => entry.sha256).length,
    bytes: content.reduce((sum, entry) => sum + Number(entry.sizeBytes ?? 0), 0),
    metadataDigest,
    sha256: sha256Value(content),
    cache: "miss",
  };
  writeJsonAtomic(cachedFile, report);
  return report;
}

function usage() {
  console.error("用法：model_fingerprint.mjs PATH [--output REPORT.json]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const input = args.find((item) => !item.startsWith("--"));
  const outputIndex = args.indexOf("--output");
  if (!input || (outputIndex >= 0 && !args[outputIndex + 1])) {
    usage();
    process.exit(2);
  }
  try {
    const report = fingerprintPath(input);
    if (outputIndex >= 0) writeJsonAtomic(path.resolve(args[outputIndex + 1]), report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
