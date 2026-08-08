#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";

const allowedAdvisories = new Set([
  "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
  "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq",
]);
const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

function audit(args) {
  const result = spawnSync("npm", ["audit", "--json", ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!result.stdout.trim()) {
    throw new Error(`npm audit 没有返回 JSON\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const production = audit(["--omit=dev"]);
if (Number(production.metadata?.vulnerabilities?.total ?? -1) !== 0) {
  throw new Error("官网生产依赖存在未解决漏洞");
}

const report = audit([]);
const vulnerabilities = report.vulnerabilities ?? {};
const names = Object.keys(vulnerabilities).sort();
if (names.join(",") !== "image-size,vinext") {
  throw new Error(`开发依赖出现未登记的漏洞包：${names.join(", ") || "none"}`);
}

const imageSize = vulnerabilities["image-size"];
const imageAdvisories = (imageSize.via ?? [])
  .filter((item) => typeof item === "object")
  .map((item) => item.url)
  .sort();
if (
  imageSize.severity !== "high"
  || imageAdvisories.length !== allowedAdvisories.size
  || imageAdvisories.some((url) => !allowedAdvisories.has(url))
  || imageSize.fixAvailable?.name !== "vinext"
  || imageSize.fixAvailable?.version !== "0.0.45"
  || imageSize.fixAvailable?.isSemVerMajor !== true
) throw new Error("image-size 例外范围、修复状态或严重级别发生变化，必须重新审计");

const vinext = vulnerabilities.vinext;
if (
  vinext.severity !== "high"
  || JSON.stringify(vinext.via) !== JSON.stringify(["image-size"])
  || vinext.fixAvailable?.version !== "0.0.45"
  || vinext.fixAvailable?.isSemVerMajor !== true
) throw new Error("vinext 间接漏洞链或修复状态发生变化，必须重新审计");

const lockedImageSize = lock.packages?.["node_modules/image-size"]?.version;
const lockedVinext = lock.packages?.["node_modules/vinext"]?.version;
if (lockedImageSize !== "2.0.2" || lockedVinext !== "0.0.50") {
  throw new Error(`精确例外只适用于 image-size@2.0.2 / vinext@0.0.50，当前为 ${lockedImageSize} / ${lockedVinext}`);
}

console.log(JSON.stringify({
  status: "pass_with_exact_dev_exception",
  productionVulnerabilities: 0,
  allowedDevelopmentAdvisories: [...allowedAdvisories].sort(),
  scope: "trusted repository assets during static build only",
  forcedDowngradeRejected: "vinext@0.0.45",
}, null, 2));
