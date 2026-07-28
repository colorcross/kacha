#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBeautyV2 } from "./beauty_v2.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";

const args = process.argv.slice(2);
const action = args[0];
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

function fail(message, code = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    error: message,
  }, null, 2));
  process.exit(code);
}

if (!["validate", "show", "authorize", "qc"].includes(action)) {
  fail(
    "用法：kacha.mjs beauty validate|show|authorize|qc "
      + "[--profile natural|visible] [--config FILE] [--anchor PATH]",
    2,
  );
}

try {
  const loaded = loadBeautyV2();
  if (action === "validate" || action === "show") {
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      source: loaded.source,
      id: loaded.config.id,
      engine: loaded.config.engine,
      defaultEnabled: loaded.config.defaultEnabled,
      implementation: loaded.implementation,
      scope: loaded.config.scope,
      profiles: action === "show"
        ? loaded.config.profiles
        : Object.keys(loaded.config.profiles),
      hardLimits: loaded.config.hardLimits,
      qc: loaded.config.qc,
    }, null, 2));
    process.exit(0);
  }

  if (action === "authorize") {
    const configured = loadKachaConfig({
      args,
      anchorPath: option("--anchor"),
      includeSecrets: false,
    });
    const preference = configured.config.editingDefaults.parameters.beauty;
    const requestedProfile = option("--profile", preference.profile);
    if (preference.enabled !== true) {
      fail(
        "Beauty v2 默认关闭；必须在当前项目或显式配置中设置 "
          + "editingDefaults.parameters.beauty.enabled=true",
      );
    }
    if (preference.engine !== "beauty-v2") {
      fail(`当前配置的美颜引擎不受支持：${preference.engine}`);
    }
    if (requestedProfile !== preference.profile) {
      fail(
        `请求档位 ${requestedProfile} 与当前项目已启用档位 `
          + `${preference.profile} 不一致`,
      );
    }
    if (!loaded.config.profiles[requestedProfile]) {
      fail(`Beauty v2 档位不存在：${requestedProfile}`);
    }
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "authorized",
      engine: preference.engine,
      profile: requestedProfile,
      defaultEnabled: loaded.config.defaultEnabled,
      configurationDigest: configured.digest,
      implementationDigest: loaded.implementation.digest,
      sources: configured.sources,
      authorityBoundary:
        "仅授权本地 Beauty v2 渲染，不构成覆盖源文件、上传或发布授权。",
    }, null, 2));
    process.exit(0);
  }

  const forwarded = args.slice(1);
  const result = spawnSync(
    process.execPath,
    [
      path.join(path.dirname(fileURLToPath(import.meta.url)), "beauty_qc.mjs"),
      ...forwarded,
    ],
    { encoding: "utf8" },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
} catch (error) {
  fail(error.message);
}
