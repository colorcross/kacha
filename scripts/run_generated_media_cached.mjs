#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mediaSummary,
  readJson,
  resolveFrom,
  run,
  sha256Value,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const delimiter = args.indexOf("--");

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index < (delimiter >= 0 ? delimiter : args.length)
    ? args[index + 1]
    : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

if (args[0] !== "run") {
  fail(
    "用法：kacha.mjs generated-cache run --plan GENERATED.json --shot SHOT_ID "
      + "--output VIDEO [--project-root DIR] -- GENERATOR [ARGS...]",
    2,
  );
}
const planInput = option("--plan");
const shotId = option("--shot");
const outputInput = option("--output");
const command = delimiter >= 0 ? args.slice(delimiter + 1) : [];
if (!planInput || !shotId || !outputInput || command.length === 0) {
  fail("generated-cache 缺少 plan、shot、output 或生成命令", 2);
}
if (
  command.some((value) => /(?:api.?key|token|secret|password|authorization|credential)/i
    .test(String(value)))
) {
  fail("生成命令不得携带凭证参数；请通过环境、钥匙串或 mmx 凭证库注入", 2);
}

const planFile = path.resolve(planInput);
const output = path.resolve(outputInput);
if (!fs.existsSync(planFile) || !fs.statSync(planFile).isFile()) {
  fail(`生成镜头计划不存在：${planFile}`, 2);
}
const validation = run(process.execPath, [
  path.join(scriptDirectory, "validate_generated_shot_plan.mjs"),
  planFile,
  "--for-execution",
]);
if (validation.status !== 0) {
  fail(validation.stderr.trim() || validation.stdout.trim() || "生成镜头计划未通过执行门禁");
}
const plan = readJson(planFile);
const shot = (plan.generatedShots ?? []).find((item) => item.id === shotId);
if (!shot) fail(`生成镜头计划不存在 shot=${shotId}`, 2);

const referenceInputs = (shot.referenceAssets ?? []).map((asset) => (
  resolveFrom(planFile, asset.localPath)
));
for (const reference of referenceInputs) {
  if (!reference || !fs.existsSync(reference) || !fs.statSync(reference).isFile()) {
    fail(`生成参考素材不存在：${reference ?? "missing"}`, 2);
  }
}
const projectRoot = path.resolve(option("--project-root", path.dirname(output)));
let runtimeVersion = "unavailable";
const version = run(command[0], ["--version"]);
if (version.status === 0) {
  runtimeVersion = String(version.stdout || version.stderr).trim().slice(0, 300);
}
const implementationFiles = [
  fileURLToPath(import.meta.url),
  path.join(scriptDirectory, "validate_generated_shot_plan.mjs"),
];
try {
  const executable = fs.realpathSync(command[0]);
  if (fs.statSync(executable).isFile()) implementationFiles.push(executable);
} catch {
  // PATH-resolved runtimes are represented by runtimeVersion and command digest.
}
function normalizedGeneratorCommand(values) {
  const outputCandidates = new Set([
    outputInput,
    path.resolve(outputInput),
    output,
  ].map((value) => String(value)));
  return values.map((value) => {
    const text = String(value);
    if (outputCandidates.has(text)) return "<KACHA_OUTPUT>";
    for (const candidate of outputCandidates) {
      if (text.endsWith(`=${candidate}`)) {
        return `${text.slice(0, text.length - candidate.length)}<KACHA_OUTPUT>`;
      }
    }
    return text;
  });
}
const parameters = {
  shotId,
  provider: shot.routing?.provider,
  model: shot.routing?.model,
  transport: shot.routing?.transport,
  promptDigest: sha256Value(shot.compiledPrompt),
  shotDigest: sha256Value(shot),
  generatorCommandDigest: sha256Value(normalizedGeneratorCommand(command)),
  runtimeVersion,
};
const cacheArguments = [
  path.join(scriptDirectory, "artifact_cache.mjs"),
  "run",
  "--project-root",
  projectRoot,
  "--kind",
  "generated_media",
  "--input",
  planFile,
  ...referenceInputs.flatMap((file) => ["--input", file]),
  ...implementationFiles.flatMap((file) => ["--implementation", file]),
  "--operation-version",
  "generated-shot-v1",
  "--parameters",
  JSON.stringify(parameters),
  "--output",
  `video=${output}`,
  "--resource",
  "network",
  "--",
  ...command,
];
const cached = run(process.execPath, cacheArguments);
if (cached.status !== 0) {
  fail(cached.stderr.trim() || cached.stdout.trim() || "生成媒体缓存任务失败", cached.status);
}
let media;
try {
  media = mediaSummary(output);
} catch (error) {
  fail(`生成结果无法探测：${error.message}`);
}
if (!media.video || !(media.videoDuration > 0)) {
  fail("生成结果不是可解码的视频");
}
const cacheResult = JSON.parse(cached.stdout);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: "pass",
  plan: planFile,
  shotId,
  output,
  cache: cacheResult.cache,
  media: {
    width: media.width,
    height: media.height,
    durationSeconds: media.videoDuration,
    fps: media.averageFps,
    audio: Boolean(media.audio),
  },
  paidCallExecuted: cacheResult.cache?.status === "miss",
  provenance: {
    runtimeVersion,
    promptDigest: parameters.promptDigest,
    shotDigest: parameters.shotDigest,
    commandStored: false,
    credentialsStored: false,
  },
}, null, 2));
