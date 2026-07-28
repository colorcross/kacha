#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  readJson,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  applicableEditingDefaults,
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";

const LAYERS_BY_TYPE = {
  metadata_rewrap: ["metadata"],
  cover_only: ["covers"],
  subtitle_only: ["subtitles"],
  bgm_adjust: ["bgm"],
  sfx_adjust: ["sfx"],
  dialogue_adjust: ["dialogue"],
  beauty_adjust: ["visual"],
  color_adjust: ["visual"],
  visual_interval: ["visual"],
  insert_replace: ["visual"],
  remove_interval: ["visual", "dialogue", "bgm", "sfx", "subtitles"],
  reorder: ["visual", "dialogue", "bgm", "sfx", "subtitles"],
  geometry_change: ["visual", "metadata"],
};
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function repeated(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

const args = process.argv.slice(2);
const contextInput = firstPositional(args, [
  "--write",
  "--new-version",
  "--intent",
  "--type",
  "--layers",
  "--scope",
  "--output-video",
  "--reason",
  "--strategy",
  "--handle-frames",
  "--interval",
  "--cover",
  "--subtitle",
  "--accept",
  "--reuse",
  "--output-duration",
  "--config",
  "--secrets",
]);
let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: contextInput || process.cwd(),
    includeSecrets: false,
  });
} catch (error) {
  console.error(`配置无效：${error.message}`);
  process.exit(2);
}
const writeInput = option(args, "--write");
const newVersionId = option(args, "--new-version");
const intent = option(args, "--intent", "candidate");
const types = option(args, "--type", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const explicitLayers = option(args, "--layers", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const scopeKind = option(
  args,
  "--scope",
  types.every((type) => ["cover_only", "metadata_rewrap"].includes(type))
    ? "no_timeline"
    : "full",
);
const outputVideo = option(args, "--output-video");
const reason = option(args, "--reason", "用户要求对现有基线进行局部优化。");
const strategy = option(args, "--strategy", "auto");
const handleFrames = Number(option(
  args,
  "--handle-frames",
  String(loadedConfig.config.execution.incremental.handleFrames),
));
const durationChange = args.includes("--duration-change");
const intervals = repeated(args, "--interval").map((value) => {
  const [startSeconds, endSeconds] = value.split(":").map(Number);
  return { startSeconds, endSeconds };
});
const covers = repeated(args, "--cover").map((value) => {
  const separator = value.indexOf("=");
  return {
    aspectRatio: value.slice(0, separator),
    path: value.slice(separator + 1),
  };
});
const subtitles = repeated(args, "--subtitle").map((value) => {
  const separator = value.indexOf("=");
  return {
    language: value.slice(0, separator),
    path: value.slice(separator + 1),
  };
});
const acceptanceCriteria = repeated(args, "--accept");
const reuseRequests = repeated(args, "--reuse").map((value) => {
  const separator = value.indexOf("=");
  return {
    artifactId: value.slice(0, separator),
    fingerprint: value.slice(separator + 1),
  };
});

if (!contextInput || !writeInput || !newVersionId || types.length === 0) {
  console.error(
    "用法：create_version_delta.mjs CONTEXT --write DELTA.json "
      + "--new-version v2 --type beauty_adjust[,sfx_adjust] "
      + "[--intent preview|candidate|release_candidate] "
      + "[--layers visual,sfx] [--scope full|intervals|no_timeline] "
      + "[--interval START:END] [--output-video FILE] "
      + "[--cover 3:4=FILE] [--subtitle zh-CN=FILE] "
      + "[--reuse ARTIFACT_ID=FINGERPRINT] "
      + "[--duration-change] [--reason TEXT] [--accept TEXT] [--config FILE]",
  );
  process.exit(2);
}
if (!VERSION_ID.test(newVersionId)) {
  console.error(
    "newVersionId 只能包含 1–64 位字母、数字、点、下划线或连字符，"
      + "且必须以字母或数字开头",
  );
  process.exit(2);
}
for (const type of types) {
  if (!Object.hasOwn(LAYERS_BY_TYPE, type)) {
    console.error(`未知 change type：${type}`);
    process.exit(2);
  }
}

const contextFile = path.resolve(contextInput);
const deltaFile = path.resolve(writeInput);
if (!fs.existsSync(contextFile)) {
  console.error(`project context 不存在：${contextFile}`);
  process.exit(2);
}
if (fs.existsSync(deltaFile)) {
  console.error(`拒绝覆盖已有 delta：${deltaFile}`);
  process.exit(2);
}
let context;
try {
  context = readJson(contextFile);
} catch (error) {
  console.error(`无法读取 project context：${error.message}`);
  process.exit(2);
}

const changedLayers = explicitLayers.length > 0
  ? [...new Set(explicitLayers)]
  : [...new Set(types.flatMap((type) => LAYERS_BY_TYPE[type]))];
const editingDefaults = applicableEditingDefaults(loadedConfig, {
  task: "local_optimization",
  modules: [...types, ...changedLayers],
});
const outputDurationSeconds = Number(
  option(
    args,
    "--output-duration",
    String(context.source?.media?.durationSeconds ?? ""),
  ),
);
const hasTimelineMediaChange = changedLayers.some(
  (layer) => ["visual", "dialogue", "bgm", "sfx", "subtitles"].includes(layer),
);
const videoDeliverable = Boolean(outputVideo)
  || hasTimelineMediaChange
  || types.includes("metadata_rewrap");
if (videoDeliverable && !outputVideo) {
  console.error("时间线媒体发生变化时必须提供 --output-video");
  process.exit(2);
}

const delta = {
  schemaVersion: "3.0",
  projectContext: path.relative(path.dirname(deltaFile), contextFile) || ".",
  contextSha256: sha256File(contextFile),
  baseVersionId: context.baseline?.versionId,
  newVersion: {
    id: newVersionId,
    intent,
    ...(outputVideo ? { outputPath: path.resolve(outputVideo) } : {}),
    overwriteBase: false,
  },
  changeSet: {
    summary: reason,
    types,
    changedLayers,
    scope: {
      kind: scopeKind,
      intervals: scopeKind === "intervals" ? intervals : [],
    },
    durationChange,
    outputDurationSeconds,
    reason,
    acceptanceCriteria: acceptanceCriteria.length > 0
      ? acceptanceCriteria
      : ["本轮变化符合用户要求，冻结层通过哈希不变性检查。"],
    defaultRequirements: editingDefaults,
  },
  render: {
    requestedStrategy: strategy,
    handleFrames,
  },
  reuseRequests,
  deliverables: {
    video: videoDeliverable,
    covers,
    subtitles,
  },
  reviewReportPath: path.join(
    path.dirname(deltaFile),
    "output",
    "incremental-review.json",
  ),
  configuration: {
    digest: loadedConfig.digest,
    sources: loadedConfig.sources,
  },
};

writeJsonAtomic(deltaFile, delta);
console.log(
  JSON.stringify(
    {
      status: "pass",
      output: deltaFile,
      contextSha256: delta.contextSha256,
      baseVersionId: delta.baseVersionId,
      newVersionId,
      intent,
      types,
      changedLayers,
      videoDeliverable,
      configurationDigest: loadedConfig.digest,
    },
    null,
    2,
  ),
);
