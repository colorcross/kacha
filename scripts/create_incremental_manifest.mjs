#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  readJson,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const positional = args.filter((item) => !item.startsWith("--"));
const outputInput = option(args, "--output");
const capabilityInput = option(args, "--capabilities");
const dialogueStemInput = option(args, "--dialogue-stem");
const bgmStemInput = option(args, "--bgm-stem");
const sfxStemInput = option(args, "--sfx-stem");
const mixStemInput = option(args, "--mix-stem");
const requiredCapabilities = option(args, "--require", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
if (positional.length < 3 || !outputInput) {
  console.error(
    "用法：create_incremental_manifest.mjs CONTEXT DELTA INDEX "
      + "--output incremental-project.json "
      + "[--capabilities capabilities.json --require capability,...] "
      + "[--dialogue-stem FILE --bgm-stem FILE --sfx-stem FILE --mix-stem FILE]",
  );
  process.exit(2);
}
if (bgmStemInput && (!dialogueStemInput || !mixStemInput)) {
  console.error(
    "--bgm-stem 要求同时提供 --dialogue-stem 和 --mix-stem，"
      + "以证明组件混音和最终成片都包含 BGM",
  );
  process.exit(2);
}

const [contextInput, deltaInput, indexInput] = positional.map((item) => path.resolve(item));
const outputFile = path.resolve(outputInput);
for (const file of [contextInput, deltaInput, indexInput]) {
  if (!fs.existsSync(file)) {
    console.error(`输入不存在：${file}`);
    process.exit(2);
  }
}
if (fs.existsSync(outputFile)) {
  console.error(`拒绝覆盖已有 incremental project：${outputFile}`);
  process.exit(2);
}
let context;
let index;
try {
  context = readJson(contextInput);
  index = readJson(indexInput);
} catch (error) {
  console.error(`无法读取 context 或 index：${error.message}`);
  process.exit(2);
}
if (context.projectId !== index.projectId) {
  console.error("context 与 artifact index 的 projectId 不一致");
  process.exit(1);
}
const relative = (file) => path.relative(path.dirname(outputFile), file);
const project = {
  schemaVersion: "3.0",
  workflow: "incremental",
  projectId: context.projectId,
  context: relative(contextInput),
  delta: relative(deltaInput),
  artifactIndex: relative(indexInput),
  ...(capabilityInput
    ? { capabilityManifest: relative(path.resolve(capabilityInput)) }
    : {}),
  requiredCapabilities,
  outputs: {
    incrementalPlan: "./output/incremental-plan.json",
    deltaQcReport: "./output/delta-qc.json",
    reviewReport: "./output/incremental-review.json",
    ...(dialogueStemInput || bgmStemInput || sfxStemInput || mixStemInput
      ? {
          audioStems: {
            ...(dialogueStemInput
              ? { dialogue: relative(path.resolve(dialogueStemInput)) }
              : {}),
            ...(bgmStemInput
              ? { bgm: relative(path.resolve(bgmStemInput)) }
              : {}),
            ...(sfxStemInput
              ? { sfx: relative(path.resolve(sfxStemInput)) }
              : {}),
            ...(mixStemInput
              ? { mix: relative(path.resolve(mixStemInput)) }
              : {}),
          },
        }
      : {}),
  },
  ...(bgmStemInput
    ? {
        expectedMedia: {
          audioMix: {
            bgmRequired: true,
          },
        },
      }
    : {}),
};
writeJsonAtomic(outputFile, project);
console.log(
  JSON.stringify(
    {
      status: "pass",
      output: outputFile,
      projectId: project.projectId,
      requiredCapabilities,
      audioStems: project.outputs.audioStems ?? null,
    },
    null,
    2,
  ),
);
