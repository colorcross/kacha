#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadKachaConfig, firstPositional } from "./kacha_config.mjs";
import {
  resolveRuntimeCommand,
  runtimeEnvironment,
} from "./kacha_utils.mjs";
import {
  acquireResourceLeases,
  inspectResourceLeases,
} from "./resource_pool.mjs";

const args = process.argv.slice(2);
const delimiter = args.indexOf("--");
const action = firstPositional(args, [
  "--project-root",
  "--resource",
  "--purpose",
  "--config",
  "--secrets",
]) ?? "help";

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function repeated(name) {
  const values = [];
  const limit = delimiter >= 0 ? delimiter : args.length;
  for (let index = 0; index < limit; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs resources status [--project-root DIR]\n"
      + "  kacha.mjs resources run --project-root DIR "
      + "--resource cpuHeavy|mps|videoEncode|network|ioHeavy [可重复] "
      + "-- COMMAND [ARGS...]",
  );
}

const projectRoot = path.resolve(option("--project-root", process.cwd()));
if (action === "run") fs.mkdirSync(projectRoot, { recursive: true });
let loaded;
try {
  loaded = loadKachaConfig({
    args,
    anchorPath: projectRoot,
    includeSecrets: false,
  });
} catch (error) {
  console.error(`配置无效：${error.message}`);
  process.exit(2);
}

if (action === "status") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    ...inspectResourceLeases({ config: loaded.config, projectRoot }),
  }, null, 2));
  process.exit(0);
}
if (action !== "run") {
  usage();
  process.exit(2);
}
const command = delimiter >= 0 ? args.slice(delimiter + 1) : [];
const resources = repeated("--resource");
if (resources.length === 0 || command.length === 0) {
  usage();
  process.exit(2);
}
let acquired;
try {
  acquired = acquireResourceLeases({
    config: loaded.config,
    projectRoot,
    resources,
    purpose: option("--purpose", command[0]),
  });
  const result = spawnSync(resolveRuntimeCommand(command[0]), command.slice(1), {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: runtimeEnvironment(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`资源调度失败：${error.message}`);
  process.exitCode = 1;
} finally {
  acquired?.release();
}
