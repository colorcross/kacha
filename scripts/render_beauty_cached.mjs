#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, run } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
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

const required = {
  input: inputValue,
  skinMask: option("--skin-mask"),
  nasolabialMask: option("--nasolabial-mask"),
  visionManifest: option("--vision-manifest"),
  output: option("--output"),
  report: option("--report"),
  config: option("--config"),
};
if (Object.values(required).some((value) => !value)) {
  fail(
    "用法：kacha.mjs beauty render INPUT --skin-mask FILE --nasolabial-mask FILE "
      + "--vision-manifest FILE --output VIDEO --report QC.json --profile natural|visible "
      + "--config PROJECT-CONFIG.json [--ab-dir DIR] [--project-root DIR]",
    2,
  );
}
const resolved = Object.fromEntries(
  Object.entries(required).map(([key, value]) => [key, path.resolve(value)]),
);
for (const [label, file] of Object.entries(resolved)) {
  if (["output", "report"].includes(label)) continue;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(`${label} 不存在：${file}`, 2);
  }
}
const profile = option("--profile", "natural");
if (!["natural", "visible"].includes(profile)) fail("--profile 无效", 2);
const projectRoot = path.resolve(
  option("--project-root", path.dirname(resolved.output)),
);
const parametersResult = run(process.execPath, [
  path.join(scriptDirectory, "kacha_beauty.mjs"),
  "parameters",
  "--profile",
  profile,
  "--config",
  resolved.config,
  "--anchor",
  resolved.input,
]);
if (parametersResult.status !== 0) {
  fail(parametersResult.stderr.trim() || parametersResult.stdout.trim(), parametersResult.status);
}
const parameters = JSON.parse(parametersResult.stdout);
const applyScript = path.join(scriptDirectory, "apply_beauty_v2.sh");
const implementations = [
  fileURLToPath(import.meta.url),
  applyScript,
  path.join(scriptDirectory, "beauty_v2.mjs"),
  path.join(scriptDirectory, "beauty_qc.mjs"),
  path.join(scriptDirectory, "assert_media_alignment.mjs"),
  path.join(scriptDirectory, "..", "config", "beauty-v2.json"),
];
const abDirectory = option("--ab-dir");
const command = [
  path.join(scriptDirectory, "artifact_cache.mjs"),
  "run",
  "--project-root",
  projectRoot,
  "--config",
  resolved.config,
  "--kind",
  "beauty",
  "--input",
  resolved.input,
  "--input",
  resolved.skinMask,
  "--input",
  resolved.nasolabialMask,
  "--input",
  resolved.visionManifest,
  ...implementations.flatMap((file) => ["--implementation", file]),
  "--operation-version",
  "beauty-v2-local-v2",
  "--parameters",
  JSON.stringify({
    profile,
    parameterDigest: parameters.digest,
    resolved: parameters.resolved,
  }),
  "--output",
  `video=${resolved.output}`,
  "--output",
  `report=${resolved.report}`,
  ...(abDirectory ? ["--output-dir", `ab=${path.resolve(abDirectory)}`] : []),
  "--resource",
  "cpuHeavy",
  "--resource",
  "videoEncode",
  "--",
  "bash",
  applyScript,
  resolved.input,
  resolved.skinMask,
  resolved.nasolabialMask,
  resolved.output,
  profile,
  "--vision-manifest",
  resolved.visionManifest,
  "--config",
  resolved.config,
  "--anchor",
  resolved.input,
  "--report",
  resolved.report,
  ...(abDirectory ? ["--ab-dir", path.resolve(abDirectory)] : []),
];
const result = run(process.execPath, command);
if (result.status !== 0) {
  fail(result.stderr.trim() || result.stdout.trim() || "Beauty v2 缓存渲染失败", result.status);
}
const cached = JSON.parse(result.stdout);
const report = readJson(resolved.report);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: report.status,
  output: resolved.output,
  report: resolved.report,
  cache: cached.cache,
  profile,
  parameterDigest: parameters.digest,
  manualReviewRequired: true,
}, null, 2));
