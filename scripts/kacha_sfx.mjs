#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstPositional } from "./kacha_config.mjs";
import { run } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = firstPositional(args, [
  "--library",
  "--mapping",
  "--asset-id",
  "--title",
  "--output",
  "--config",
  "--secrets",
]);
const rest = args.slice(1);
const scripts = {
  validate: "validate_sfx_library.mjs",
  import: "import_private_sfx.mjs",
  align: "align_sfx_peak.mjs",
};
if (!Object.hasOwn(scripts, action)) {
  console.error(
    "用法：kacha.mjs sfx validate [manifest.json] [options]\n"
      + "      kacha.mjs sfx import --library DIR --mapping FILE [--dry-run]\n"
      + "      kacha.mjs sfx align --file FILE --target SECONDS [--fps 25] [--output FILE]",
  );
  process.exit(2);
}
const result = run(process.execPath, [path.join(scriptDirectory, scripts[action]), ...rest]);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
