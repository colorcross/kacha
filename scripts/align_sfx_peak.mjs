#!/usr/bin/env node

import path from "node:path";
import { alignSfxPeak } from "./sfx_peak_alignment.mjs";
import { writeJsonAtomic } from "./kacha_utils.mjs";

const args = process.argv.slice(2);
function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const file = option("--file");
const targetLandingSeconds = option("--target");
const fps = option("--fps", "25");
const output = option("--output");
if (!file || targetLandingSeconds === null) {
  console.error("用法：kacha.mjs sfx align --file FILE --target SECONDS [--fps 25] [--output FILE]");
  process.exit(2);
}

try {
  const alignment = alignSfxPeak({ file, targetLandingSeconds, fps });
  const report = { status: alignment.withinTolerance ? "pass" : "fail", alignment };
  if (output) writeJsonAtomic(output, report);
  console.log(JSON.stringify({ ...report, ...(output ? { output: path.resolve(output) } : {}) }, null, 2));
  if (!alignment.withinTolerance) process.exit(1);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
