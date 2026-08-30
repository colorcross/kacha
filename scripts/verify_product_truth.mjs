#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..");

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function commandJson(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${process.execPath} ${args.join(" ")} failed (${result.status})\n`
        + `${result.stdout}\n${result.stderr}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`command did not return JSON: ${args.join(" ")} (${error.message})`);
  }
}

function arrayLength(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value.length;
}

function deriveTruth() {
  const tests = commandJson(["tests/run_tests.mjs", "--list"]);
  const templates = commandJson(["scripts/kacha.mjs", "templates", "list"]);
  const designs = commandJson(["scripts/kacha.mjs", "design", "list"]);
  const resources = readJson("config/resources/core-catalog.json");
  const effectSources = [
    ["config/effects/openings.json", "effects"],
    ["config/effects/transitions.json", "effects"],
    ["config/effects/spoken-caption-layouts.json", "layouts"],
    ["config/effects/visual-breathing.json", "motions"],
    ["config/effects/z-en-netstyle.json", "effects"],
    ["config/design-system/scenes.json", "scenes"],
  ];
  return {
    regressionChecks: arrayLength(tests.tests, "tests.tests"),
    templates: arrayLength(templates.items, "templates.items"),
    designEntries: arrayLength(designs.entries, "designs.entries"),
    coreResources: arrayLength(resources.assets, "core resources"),
    assignableEffects: effectSources.reduce(
      (total, [file, key]) => total + arrayLength(readJson(file)[key], `${file}.${key}`),
      0,
    ),
  };
}

function compareCounts(declared, actual) {
  const errors = [];
  for (const [key, value] of Object.entries(actual)) {
    if (declared[key] !== value) {
      errors.push(`${key}: declared ${declared[key]}, derived ${value}`);
    }
  }
  if (errors.length > 0) throw new Error(`current product truth drifted:\n- ${errors.join("\n- ")}`);
}

function requireText(relative, expected) {
  const content = fs.readFileSync(path.join(root, relative), "utf8");
  const normalizedContent = content.replace(/\s+/g, " ");
  const normalizedExpected = expected.replace(/\s+/g, " ");
  if (!normalizedContent.includes(normalizedExpected)) {
    throw new Error(`${relative} is missing current product truth: ${expected}`);
  }
}

const actual = deriveTruth();
const declared = readJson("website/app/product-truth.json");
compareCounts(declared, actual);

requireText("README.md", `69 个复用场景、${actual.templates} 个预制效果模板、${actual.coreResources} 个公共`);
requireText("README.md", `当前仓库完整回归为 ${actual.regressionChecks} 项`);
requireText("README.en.md", `${actual.designEntries} reusable scenes`);
requireText("README.en.md", `Resolves ${actual.templates} production effect templates`);
requireText("README.en.md", `Ships ${actual.coreResources} public core resources`);
requireText("README.en.md", `The current full regression discovers ${actual.regressionChecks} checks`);
requireText("README.en.md", `All ${actual.assignableEffects} assignable effects are searchable`);
requireText("docs/product/metrics-and-learning.md", `完整回归 ${actual.regressionChecks} 项`);
requireText("website/app/site-content.ts", "String(productTruth.regressionChecks)");
requireText("website/app/components/SiteShell.tsx", "--agent both --channel canary");
requireText("website/tests/rendered-html.test.mjs", `/>${actual.regressionChecks}</`);

if (process.argv.includes("--self-test")) {
  let rejected = false;
  try {
    compareCounts({ ...declared, templates: declared.templates + 1 }, actual);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("negative product-truth self-test did not reject drift");
}

console.log(JSON.stringify({
  schemaVersion: 1,
  status: "pass",
  actual,
  negativeSelfTest: process.argv.includes("--self-test") ? "passed" : "not_requested",
}, null, 2));
