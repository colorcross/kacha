#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, sha256Value } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.dirname(scriptDirectory);
const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(name) {
  return args.includes(name);
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function omitPairs(values, names) {
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    if (names.has(values[index])) {
      index += 1;
      continue;
    }
    result.push(values[index]);
  }
  return result;
}

if (args[0] !== "render") {
  fail(
    "用法：kacha.mjs styleframe render --scene SCENE --output FILE "
      + "[--manifest FILE] [--project-root DIR] [design render 选项]",
    2,
  );
}
if (has("--overwrite")) {
  fail("styleframe 缓存渲染不接受 --overwrite；已有不一致输出必须显式换路径", 2);
}
const outputInput = option("--output");
const id = option("--scene") ?? option("--id");
if (!outputInput || !id) fail("styleframe render 缺少 --scene/--id 或 --output", 2);
const output = path.resolve(outputInput);
const manifest = path.resolve(option("--manifest", `${output}.manifest.json`));
const projectRoot = path.resolve(option("--project-root", path.dirname(output)));

const forwarded = omitPairs(args.slice(1), new Set([
  "--project-root",
  "--manifest",
]));
if (!forwarded.includes("--manifest")) {
  forwarded.push("--manifest", manifest);
}
const resolveArguments = [
  path.join(scriptDirectory, "kacha_design.mjs"),
  "resolve",
  "--scene",
  id,
];
for (const flag of [
  "--config",
  "--anchor",
  "--show",
  "--aspect",
  "--language",
  "--surface",
  "--density",
]) {
  const value = option(flag);
  if (value) resolveArguments.push(flag, value);
}
const resolvedResult = run(process.execPath, resolveArguments);
if (resolvedResult.status !== 0) {
  fail(resolvedResult.stderr.trim() || resolvedResult.stdout.trim() || "视频设计系统无法解析");
}
const resolved = JSON.parse(resolvedResult.stdout);
const sourceFiles = [
  path.join(skillDirectory, "config", "defaults.json"),
  path.join(skillDirectory, "config", "design-system", "system.json"),
  path.join(skillDirectory, "config", "design-system", "components.json"),
  path.join(skillDirectory, "config", "design-system", "scenes.json"),
  path.join(skillDirectory, "config", "design-system", "modes.json"),
  path.join(skillDirectory, "config", "design-system", "implementations.json"),
  option("--data"),
  option("--config"),
].filter((file) => file && fs.existsSync(path.resolve(file)))
  .map((file) => path.resolve(file));
const implementationFiles = [
  fileURLToPath(import.meta.url),
  path.join(scriptDirectory, "kacha_design.mjs"),
  path.join(scriptDirectory, "design_system.mjs"),
  path.join(scriptDirectory, "design_renderers.mjs"),
];
const semanticArguments = omitPairs(args.slice(1), new Set([
  "--project-root",
  "--output",
  "--manifest",
  "--config",
  "--anchor",
  "--data",
]));
const cacheArguments = [
  path.join(scriptDirectory, "artifact_cache.mjs"),
  "run",
  "--project-root",
  projectRoot,
  "--kind",
  "styleframe",
  ...sourceFiles.flatMap((file) => ["--input", file]),
  ...implementationFiles.flatMap((file) => ["--implementation", file]),
  "--operation-version",
  "video-design-styleframe-v1",
  "--parameters",
  JSON.stringify({
    id,
    kind: option("--kind", "scene"),
    designDigest: resolved.digest,
    implementationDigest: resolved.implementationDigest,
    selectedModes: resolved.selectedModes,
    renderOptionsDigest: sha256Value(semanticArguments),
  }),
  "--output",
  `artifact=${output}`,
  "--output",
  `manifest=${manifest}`,
  "--resource",
  "ioHeavy",
  "--",
  process.execPath,
  path.join(scriptDirectory, "kacha_design.mjs"),
  "render",
  ...forwarded,
];
const cachedResult = run(process.execPath, cacheArguments);
if (cachedResult.status !== 0) {
  fail(
    cachedResult.stderr.trim()
      || cachedResult.stdout.trim()
      || "styleframe 缓存渲染失败",
    cachedResult.status,
  );
}
const cached = JSON.parse(cachedResult.stdout);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: "pass",
  id,
  output,
  manifest,
  cache: cached.cache,
  designDigest: resolved.digest,
  implementationDigest: resolved.implementationDigest,
  selectedModes: resolved.selectedModes,
}, null, 2));
