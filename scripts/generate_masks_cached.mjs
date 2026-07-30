#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, run } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const implementation = path.join(scriptDirectory, "generate_vision_masks.swift");
const args = process.argv.slice(2);
const inputValue = args.find((item, index) => (
  !item.startsWith("--")
  && (index === 0 || !args[index - 1]?.startsWith("--"))
));

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

if (!inputValue || !option("--output-dir")) {
  fail(
    "用法：kacha.mjs masks INPUT --output-dir DIR "
      + "[--sample-fps 5] [--quality fast|balanced|accurate] [--project-root DIR]",
    2,
  );
}
const input = path.resolve(inputValue);
const outputDirectory = path.resolve(option("--output-dir"));
const sampleFps = Number(option("--sample-fps", "5"));
const quality = option("--quality", "balanced");
const projectRoot = path.resolve(
  option("--project-root", path.dirname(outputDirectory)),
);
if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
  fail(`输入视频不存在：${input}`, 2);
}
if (!(sampleFps > 0 && sampleFps <= 60) || !["fast", "balanced", "accurate"].includes(quality)) {
  fail("--sample-fps 或 --quality 无效", 2);
}
const command = [
  path.join(scriptDirectory, "artifact_cache.mjs"),
  "run",
  "--project-root",
  projectRoot,
  "--kind",
  "tracking",
  "--input",
  input,
  "--implementation",
  implementation,
  "--implementation",
  fileURLToPath(import.meta.url),
  "--operation-version",
  "apple-vision-masks-v2",
  "--parameters",
  JSON.stringify({ sampleFps, quality }),
  "--output-dir",
  `masks=${outputDirectory}`,
  "--resource",
  "mps",
  "--",
  "swift",
  implementation,
  input,
  outputDirectory,
  String(sampleFps),
  quality,
];
const result = run(process.execPath, command);
if (result.status !== 0) {
  fail(result.stderr.trim() || result.stdout.trim() || "Vision 蒙版生成失败", result.status);
}
const cached = JSON.parse(result.stdout);
const manifestFile = path.join(outputDirectory, "manifest.json");
if (!fs.existsSync(manifestFile)) fail("蒙版缓存产物缺少 manifest.json");
const manifest = readJson(manifestFile);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: "pass",
  outputDirectory,
  manifest: manifestFile,
  cache: cached.cache,
  frameCount: manifest.frameCount,
  tracking: manifest.tracking,
  limitations: manifest.limitations,
}, null, 2));
