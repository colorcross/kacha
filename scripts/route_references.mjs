#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./kacha_utils.mjs";

const skillDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TASKS = new Set([
  "proposal_review",
  "source_edit",
  "content_generation",
  "local_optimization",
]);
const MODULE_REFERENCES = {
  audio: ["references/audio.md"],
  dialogue: ["references/audio.md"],
  bgm: ["references/audio.md"],
  sfx: ["references/audio.md", "references/sfx-library.md"],
  visual: ["references/visuals-masks.md"],
  masks: ["references/visuals-masks.md"],
  beauty: ["references/beauty-v2.md", "references/visuals-masks.md"],
  pip: ["references/visuals-masks.md"],
  color: ["references/visuals-masks.md"],
  reframe: ["references/visuals-masks.md"],
  design: [
    "references/visuals-masks.md",
    "references/visual-design-preflight.md",
    "references/style-effects-library.md",
    "docs/VIDEO_DESIGN_SYSTEM_V1.md",
  ],
  information_card: [
    "references/visuals-masks.md",
    "references/visual-design-preflight.md",
  ],
  flowchart: [
    "references/visuals-masks.md",
    "references/visual-design-preflight.md",
  ],
  popup: [
    "references/visuals-masks.md",
    "references/visual-design-preflight.md",
    "references/style-effects-library.md",
  ],
  style: [
    "references/style-effects-library.md",
    "docs/VIDEO_DESIGN_SYSTEM_V1.md",
  ],
  opening: ["references/style-effects-library.md"],
  transition: [
    "references/editing-theory.md",
    "references/visual-design-preflight.md",
    "references/style-effects-library.md",
  ],
  text_behind: [
    "references/visuals-masks.md",
    "references/visual-design-preflight.md",
  ],
  subtitles: ["references/subtitles-covers-brand.md"],
  covers: ["references/subtitles-covers-brand.md"],
  brand: ["references/subtitles-covers-brand.md"],
  series: ["references/subtitles-covers-brand.md"],
  generated: ["references/generated-media-assets.md"],
  minimax: ["references/generated-media-assets.md"],
  seedance: ["references/generated-media-assets.md"],
  network_assets: ["references/generated-media-assets.md"],
  cleanup: ["references/cleanup-retention.md"],
  hardening: ["docs/PRODUCTION_HARDENING.md"],
  low_model: ["references/agent-execution.md"],
  agent_execution: ["references/agent-execution.md"],
  visual_evidence: ["references/visual-evidence.md"],
  claude_visual: [
    "references/agent-execution.md",
    "references/visual-evidence.md",
  ],
};

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function estimateTokens(text) {
  let nonAscii = 0;
  let asciiCharacters = 0;
  for (const character of text) {
    if (character.codePointAt(0) > 0x7f) nonAscii += 1;
    else asciiCharacters += 1;
  }
  return nonAscii + Math.ceil(asciiCharacters / 4);
}

const args = process.argv.slice(2);
const task = option(args, "--task");
const modules = option(args, "--modules", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const release = args.includes("--release");
const output = option(args, "--output");
if (!TASKS.has(task)) {
  console.error(
    "用法：route_references.mjs --task "
      + "proposal_review|source_edit|content_generation|local_optimization "
      + "[--modules audio,sfx,beauty,covers,...] [--release] [--output FILE]",
  );
  process.exit(2);
}
for (const module of modules) {
  if (!Object.hasOwn(MODULE_REFERENCES, module)) {
    console.error(
      `未知模块：${module}；可用模块：${Object.keys(MODULE_REFERENCES).join(", ")}`,
    );
    process.exit(2);
  }
}

const selected = new Set(["SKILL.md"]);
if (task === "local_optimization") {
  selected.add("references/incremental-workflow.md");
  if (release) selected.add("references/qc-release.md");
} else {
  selected.add("references/project-workflow.md");
  selected.add("references/editing-theory.md");
  if (release) selected.add("references/qc-release.md");
}
for (const module of modules) {
  for (const reference of MODULE_REFERENCES[module]) selected.add(reference);
}

const files = [...selected].map((relative) => {
  const absolute = path.join(skillDirectory, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    console.error(`所需 reference 不存在：${absolute}`);
    process.exit(1);
  }
  const text = fs.readFileSync(absolute, "utf8");
  return {
    path: relative,
    absolutePath: absolute,
    bytes: Buffer.byteLength(text),
    characters: [...text].length,
    approximateInputTokens: estimateTokens(text),
  };
});
const totalCharacters = files.reduce((sum, file) => sum + file.characters, 0);
const report = {
  schemaVersion: "1.0",
  task,
  modules,
  release,
  files,
  totals: {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    characters: totalCharacters,
    approximateInputTokens: files.reduce(
      (sum, file) => sum + file.approximateInputTokens,
      0,
    ),
  },
  note: "token 为保守启发式预算：非 ASCII 字符按 1 token、ASCII 按 4 字符/token；不是实际计费结果",
};
if (output) writeJsonAtomic(path.resolve(output), report);
console.log(JSON.stringify(report, null, 2));
