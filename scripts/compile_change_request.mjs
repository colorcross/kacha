#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireFileLock,
  hasValue,
  readJson,
  resolveFrom,
  run,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  applicableEditingDefaults,
  deepMerge,
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";
import { diagnostic } from "./kacha_error_catalog.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const input = firstPositional(args, ["--output-dir", "--config", "--secrets"]);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const outputRootArgument = option("--output-dir");
const dryRun = args.includes("--dry-run");

const RECIPES = {
  beauty: {
    type: "beauty_adjust",
    layers: ["visual"],
    defaultAcceptance: [
      "同源同帧 A/B 中肤色更均匀，眼睛、眉毛、嘴唇、眼镜、发丝和背景保持清晰。",
      "脸、颈、耳、手臂连续，无闪烁、漂移、液化或身份变化。",
    ],
  },
  color: {
    type: "color_adjust",
    layers: ["visual"],
    defaultAcceptance: [
      "曝光、白平衡和肤色稳定，跨素材色彩语言一致。",
      "冻结音频 elementary stream 哈希与基线一致。",
    ],
  },
  visual_interval: {
    type: "visual_interval",
    layers: ["visual"],
    requiresIntervals: true,
    defaultAcceptance: [
      "目标区间画面符合修改要求，区间前后 handle 连续。",
      "冻结音频 elementary stream 哈希与基线一致。",
    ],
  },
  netstyle: {
    type: "semantic_netstyle",
    layers: ["visual", "sfx"],
    requiresIntervals: true,
    regressionClass: "semantic_netstyle",
    defaultAcceptance: [
      "效果来自当前 netstyle 时间线计划和注册表，触发、功能、机制、进入、峰值、退出、降级与失败条件均可追溯。",
      "正式成片不含演示标签；源几何、有效帧率、时长和人声保持，音效峰值与视觉峰值误差不超过 1–2 帧。",
      "效果不遮挡头脸、字幕、品牌和平台安全区；同一时刻最多一个主效果。",
    ],
  },
  visual_breathing: {
    type: "visual_breathing",
    layers: ["visual", "sfx"],
    regressionClass: "visual_breathing",
    defaultAcceptance: [
      "运动由语义、情绪或真实空间变化触发，遵守收紧—停稳—释放，不用持续缩放掩盖错误切点。",
      "运动覆盖不超过 55%，静止不少于 45%；头顶、手势、字幕和平台安全区完整。",
      "缓慢推拉和横移无音效；短促冲击的视觉峰值与音效能量峰值误差不超过 1–2 帧。",
    ],
  },
  caption_layout: {
    type: "caption_layout",
    layers: ["subtitles", "sfx"],
    regressionClass: "caption_layout",
    defaultAcceptance: [
      "字幕以最终音频为准，普通单行为默认；左右、上下或前后景布局只表达真实信息关系。",
      "同一时刻最多三个阅读区和一个主重音，文字不遮挡人物头脸、品牌或平台安全区。",
      "字体真实命中且覆盖文本；普通字幕无音效，强调音效峰值与文字落位误差不超过 1–2 帧。",
    ],
  },
  insert_replace: {
    type: "insert_replace",
    layers: ["visual"],
    requiresIntervals: true,
    defaultAcceptance: [
      "插镜对象、动作、角色、状态、时态、方向和风格与旁白一致。",
      "进入、停留、退出和回到 A-roll 的连接均通过。",
    ],
  },
  dialogue: {
    type: "dialogue_adjust",
    layers: ["dialogue"],
    defaultAcceptance: [
      "同源同响度 A/B 中人声更清晰，无金属声、抽吸、齿音损伤和声道破坏。",
      "冻结视频 elementary stream 哈希与基线一致。",
    ],
  },
  bgm: {
    type: "bgm_adjust",
    layers: ["bgm"],
    defaultAcceptance: [
      "BGM 可感知但不抢人声，段落闪避自然，无突然起落。",
      "冻结视频 elementary stream 哈希与基线一致。",
    ],
  },
  sfx: {
    type: "sfx_adjust",
    layers: ["sfx"],
    defaultAcceptance: [
      "每个音效与事件逐一匹配，音色有区分，落点误差不超过计划容差。",
      "冻结视频 elementary stream 哈希与基线一致。",
    ],
  },
  subtitles: {
    type: "subtitle_only",
    layers: ["subtitles"],
    defaultAcceptance: [
      "字幕以最终音频为准，数字、专名、否定、条件和结论已校准。",
      "单行测宽、平台安全区、亮底/暗底和最长字幕通过。",
    ],
  },
  covers: {
    type: "cover_only",
    layers: ["covers"],
    noTimeline: true,
    defaultAcceptance: [
      "封面人物、标题、品牌、系列名和平台裁切零碰撞。",
      "所有要求画幅均有真实文件、精确比例和手机缩略图证据。",
    ],
  },
  metadata: {
    type: "metadata_rewrap",
    layers: ["metadata"],
    noTimeline: true,
    defaultAcceptance: [
      "视频、音频 elementary stream 哈希保持不变。",
      "容器、declared FPS、average FPS、时长和色彩元数据符合合同。",
    ],
  },
  remove: {
    type: "remove_interval",
    layers: ["visual", "dialogue", "bgm", "sfx", "subtitles"],
    requiresIntervals: true,
    durationChange: true,
    defaultAcceptance: [
      "删除区间来自词级时间戳，不切断完整语义。",
      "所有时间层共用新帧边界，连接点音画同步且自然。",
    ],
  },
  reorder: {
    type: "reorder",
    layers: ["visual", "dialogue", "bgm", "sfx", "subtitles"],
    durationChange: true,
    defaultAcceptance: [
      "内容顺序、因果、指代和时间层同步符合批准方案。",
      "全部新连接点正常速度试听并检查前后 handle。",
    ],
  },
  geometry: {
    type: "geometry_change",
    layers: ["visual", "metadata"],
    defaultAcceptance: [
      "输出几何有明确重新授权，人物头部、手势、字幕和平台安全区完整。",
      "全片重构图无主体跳变、误裁或清晰度异常。",
    ],
  },
  style: {
    type: "style_change",
    layers: ["visual", "subtitles"],
    regressionClass: "style_consistency",
    defaultAcceptance: [
      "成片、弹窗、信息卡、画中画、字幕、品牌和封面均来自同一解析后 style profile。",
      "亮底/暗底、人物安全区、手机尺寸和多画幅代表帧全部通过。",
    ],
  },
  timing_sync: {
    type: "timing_sync",
    layers: ["visual", "sfx"],
    regressionClass: "effect_audio_sync",
    defaultAcceptance: [
      "每个动作按实际口播触发词或可见动作落点对齐，不使用未经验证的统一全局偏移。",
      "视觉停稳与音效峰值误差不超过 1–2 帧，同类事件已完成整片扫描。",
    ],
  },
  popup_layout: {
    type: "popup_layout",
    layers: ["visual"],
    requiresIntervals: true,
    regressionClass: "layout_collision",
    defaultAcceptance: [
      "弹窗完整边界含阴影和装饰，不与头脸、字幕、品牌和平台 UI 安全区相交。",
      "同类弹窗已完成整片碰撞回归，进入、信息最满和退出三态均通过。",
    ],
  },
  connections: {
    type: "connection_repair",
    layers: ["visual", "sfx"],
    regressionClass: "timeline_connections",
    defaultAcceptance: [
      "重新枚举最终时间线全部连接点，正常速度检查数与检测数一致，未解决项为零。",
      "每个连接优先使用有理论依据的切镜、J/L-cut、声音桥或有 handle 的转场。",
    ],
  },
};
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(code, detail, exitCode = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    diagnostics: [diagnostic(code, detail)],
  }, null, 2));
  process.exit(exitCode);
}

if (!input) {
  fail(
    "KACHA-E140",
    "用法：kacha.mjs compile-change REQUEST.json [--output-dir DIR] [--dry-run]",
    2,
  );
}
const requestFile = path.resolve(input);
if (!fs.existsSync(requestFile)) fail("KACHA-E100", `request 不存在：${requestFile}`);

let request;
try {
  request = readJson(requestFile);
} catch (error) {
  fail("KACHA-E140", `request JSON 无法解析：${error.message}`);
}
if (request.schemaVersion !== "1.0") {
  fail("KACHA-E140", "request.schemaVersion 必须为 1.0");
}
if (!hasValue(request.projectContext) || !hasValue(request.newVersion?.id)) {
  fail("KACHA-E140", "request 必须包含 projectContext 和 newVersion.id");
}
if (!VERSION_ID.test(request.newVersion.id)) {
  fail(
    "KACHA-E140",
    "newVersion.id 只能包含 1–64 位字母、数字、点、下划线或连字符，"
      + "且必须以字母或数字开头",
  );
}
if (!Array.isArray(request.changes) || request.changes.length === 0) {
  fail("KACHA-E140", "request.changes 必须是非空数组");
}
let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: requestFile,
    includeSecrets: false,
  });
} catch (error) {
  fail("KACHA-E140", `配置无效：${error.message}`);
}
const editingDefaults = applicableEditingDefaults(loadedConfig, {
  task: "local_optimization",
  modules: request.changes.map((change) => change?.recipe).filter(Boolean),
});

const contextFile = resolveFrom(requestFile, request.projectContext);
if (!contextFile || !fs.existsSync(contextFile)) {
  fail("KACHA-E100", `project context 不存在：${contextFile}`);
}
let context;
try {
  context = readJson(contextFile);
} catch (error) {
  fail("KACHA-E140", `project context 无法解析：${error.message}`);
}
const normalizedChanges = request.changes.map((change, index) => {
  const recipe = RECIPES[change?.recipe];
  if (!recipe) {
    fail(
      "KACHA-E140",
      `changes[${index}].recipe 未知：${change?.recipe}；可用值：${Object.keys(RECIPES).join(", ")}`,
    );
  }
  const intervals = change.intervals ?? [];
  if (recipe.requiresIntervals && intervals.length === 0) {
    fail("KACHA-E140", `changes[${index}] recipe=${change.recipe} 必须提供 intervals`);
  }
  for (const [position, interval] of intervals.entries()) {
    if (
      !(Number.isFinite(interval?.startSeconds)
        && Number.isFinite(interval?.endSeconds)
        && interval.startSeconds >= 0
        && interval.endSeconds > interval.startSeconds)
    ) {
      fail("KACHA-E140", `changes[${index}].intervals[${position}] 无效`);
    }
  }
  if (
    change.parameters !== undefined
    && (
      change.parameters === null
      || typeof change.parameters !== "object"
      || Array.isArray(change.parameters)
    )
  ) {
    fail("KACHA-E140", `changes[${index}].parameters 必须是 object`);
  }
  const parameters = deepMerge(
    editingDefaults.recipeParameters[change.recipe] ?? {},
    change.parameters ?? {},
  );
  if (
    change.recipe === "netstyle"
    && !(
      hasValue(parameters.effectId)
      || hasValue(parameters.plan)
    )
  ) {
    fail(
      "KACHA-E140",
      `changes[${index}] recipe=netstyle 必须通过 parameters.effectId 或 parameters.plan 指定效果来源`,
    );
  }
  if (change.recipe === "netstyle" && hasValue(parameters.effectId)) {
    const registry = readJson(
      path.join(scriptsDirectory, "..", "config", "effects", "z-en-netstyle.json"),
    );
    if (!registry.effects?.some((effect) => effect.id === parameters.effectId)) {
      fail(
        "KACHA-E140",
        `changes[${index}].parameters.effectId 未注册：${parameters.effectId}`,
      );
    }
  }
  if (change.recipe === "netstyle" && hasValue(parameters.plan)) {
    const plan = resolveFrom(requestFile, parameters.plan);
    if (!plan || !fs.existsSync(plan)) {
      fail("KACHA-E100", `changes[${index}] netstyle plan 不存在：${plan}`);
    }
    const validation = run(process.execPath, [
      path.join(scriptsDirectory, "netstyle_timeline.mjs"),
      "validate",
      "--plan",
      plan,
    ]);
    if (validation.status !== 0) {
      fail(
        "KACHA-E140",
        `changes[${index}] netstyle plan 无效：${validation.stderr || validation.stdout}`,
      );
    }
    const frozenPlan = readJson(plan);
    if (frozenPlan.source?.input?.sha256 !== context.source?.sha256) {
      fail(
        "KACHA-E110",
        `changes[${index}] ${change.recipe} plan 的源片与当前增量基线不一致`,
      );
    }
    parameters.plan = plan;
  }
  if (
    ["visual_breathing", "caption_layout"].includes(change.recipe)
    && !hasValue(parameters.plan)
  ) {
    fail(
      "KACHA-E140",
      `changes[${index}] recipe=${change.recipe} 必须通过 parameters.plan 指定已验证计划`,
    );
  }
  if (
    ["visual_breathing", "caption_layout"].includes(change.recipe)
    && hasValue(parameters.plan)
  ) {
    const plan = resolveFrom(requestFile, parameters.plan);
    if (!plan || !fs.existsSync(plan)) {
      fail("KACHA-E100", `changes[${index}] ${change.recipe} plan 不存在：${plan}`);
    }
    const validator = change.recipe === "visual_breathing"
      ? "visual_breathing.mjs"
      : "caption_layout.mjs";
    const validation = run(process.execPath, [
      path.join(scriptsDirectory, validator),
      "validate",
      "--plan",
      plan,
    ]);
    if (validation.status !== 0) {
      fail(
        "KACHA-E140",
        `changes[${index}] ${change.recipe} plan 无效：`
          + `${validation.stderr || validation.stdout}`,
      );
    }
    const frozenPlan = readJson(plan);
    if (frozenPlan.source?.input?.sha256 !== context.source?.sha256) {
      fail(
        "KACHA-E110",
        `changes[${index}] ${change.recipe} plan 的源片与当前增量基线不一致`,
      );
    }
    parameters.plan = plan;
  }
  return {
    recipe: change.recipe,
    type: recipe.type,
    layers: recipe.layers,
    reason: change.reason || `按 ${change.recipe} 稳定配方修改当前基线。`,
    intervals,
    parameters,
    acceptanceCriteria: Array.isArray(change.acceptanceCriteria)
      && change.acceptanceCriteria.length > 0
      ? change.acceptanceCriteria
      : recipe.defaultAcceptance,
    noTimeline: Boolean(recipe.noTimeline),
    durationChange: Boolean(recipe.durationChange),
    regressionClass: recipe.regressionClass ?? null,
  };
});

const newVersionId = request.newVersion.id;
const outputRoot = path.resolve(
  outputRootArgument
    || path.join(path.dirname(contextFile), "versions", newVersionId),
);
let releaseLock = null;
try {
  releaseLock = acquireFileLock(`${outputRoot}.lock`, {
    purpose: `compile-change:${newVersionId}`,
  });
} catch (error) {
  fail("KACHA-E500", error.message);
}
process.on("exit", () => releaseLock?.());
if (!dryRun && fs.existsSync(outputRoot)) {
  fail("KACHA-E100", `拒绝覆盖已有版本目录：${outputRoot}`);
}
const deltaFile = path.join(outputRoot, "version-delta.json");
const projectFile = path.join(outputRoot, "incremental-project.json");
const artifactIndex = resolveFrom(
  contextFile,
  context.artifactIndex || "./artifact-index.json",
);
if (!artifactIndex || !fs.existsSync(artifactIndex)) {
  fail("KACHA-E100", `artifact index 不存在：${artifactIndex}`);
}

const types = [...new Set(normalizedChanges.map((item) => item.type))];
const layers = [...new Set(normalizedChanges.flatMap((item) => item.layers))];
const intervals = normalizedChanges.flatMap((item) => item.intervals);
const allNoTimeline = normalizedChanges.every((item) => item.noTimeline);
const hasIntervals = intervals.length > 0;
const scope = allNoTimeline ? "no_timeline" : hasIntervals ? "intervals" : "full";
const durationChange = normalizedChanges.some((item) => item.durationChange);
let outputDuration = Number(
  request.newVersion.outputDurationSeconds
  ?? context.source?.media?.durationSeconds,
);
if (
  normalizedChanges.some((item) => item.recipe === "remove")
  && !Number.isFinite(request.newVersion.outputDurationSeconds)
) {
  const ordered = [...intervals].sort((a, b) => a.startSeconds - b.startSeconds);
  let removed = 0;
  let cursor = -Infinity;
  for (const interval of ordered) {
    const start = Math.max(interval.startSeconds, cursor);
    if (interval.endSeconds > start) removed += interval.endSeconds - start;
    cursor = Math.max(cursor, interval.endSeconds);
  }
  outputDuration = Number(context.source.media.durationSeconds) - removed;
}
if (!(outputDuration > 0)) {
  fail("KACHA-E140", "无法推导正数 outputDurationSeconds");
}

const timelineLayers = new Set(["visual", "dialogue", "bgm", "sfx", "subtitles"]);
const videoRequired = layers.some((layer) => timelineLayers.has(layer))
  || layers.includes("metadata");
const baselineExtension = path.extname(context.baseline?.video?.path || "") || ".mov";
const outputVideo = request.newVersion.outputVideo
  ? resolveFrom(requestFile, request.newVersion.outputVideo)
  : videoRequired
    ? path.join(outputRoot, `${newVersionId}${baselineExtension}`)
    : null;
const acceptance = [
  ...new Set(normalizedChanges.flatMap((item) => item.acceptanceCriteria)),
];
const reason = normalizedChanges.map((item) => item.reason).join("；");
const covers = request.deliverables?.covers ?? [];
const subtitles = request.deliverables?.subtitles ?? [];
const intent = request.newVersion.intent || "candidate";
if (!["preview", "candidate", "release_candidate"].includes(intent)) {
  fail("KACHA-E140", `newVersion.intent 无效：${intent}`);
}

const deltaArgs = [
  contextFile,
  "--write",
  deltaFile,
  "--new-version",
  newVersionId,
  "--type",
  types.join(","),
  "--layers",
  layers.join(","),
  "--intent",
  intent,
  "--scope",
  scope,
  "--output-duration",
  String(outputDuration),
  "--reason",
  reason,
  "--strategy",
  request.render?.strategy || "auto",
  "--handle-frames",
  String(
    request.render?.handleFrames
      ?? loadedConfig.config.execution.incremental.handleFrames,
  ),
];
if (durationChange) deltaArgs.push("--duration-change");
if (outputVideo) deltaArgs.push("--output-video", outputVideo);
for (const interval of intervals) {
  deltaArgs.push("--interval", `${interval.startSeconds}:${interval.endSeconds}`);
}
for (const criterion of acceptance) deltaArgs.push("--accept", criterion);
for (const cover of covers) {
  deltaArgs.push("--cover", `${cover.aspectRatio}=${resolveFrom(requestFile, cover.path)}`);
}
for (const subtitle of subtitles) {
  deltaArgs.push("--subtitle", `${subtitle.language}=${resolveFrom(requestFile, subtitle.path)}`);
}
for (const reuse of request.reuseRequests ?? []) {
  deltaArgs.push("--reuse", `${reuse.artifactId}=${reuse.fingerprint}`);
}

const preview = {
  schemaVersion: "1.0",
  status: dryRun ? "dry_run" : "compiled",
  projectId: context.projectId,
  baseVersionId: context.baseline?.versionId,
  newVersionId,
  intent,
  recipes: normalizedChanges,
  configuration: {
    digest: loadedConfig.digest,
    sources: loadedConfig.sources,
    editingDefaults: {
      parameters: editingDefaults.parameters,
      instructions: editingDefaults.instructions,
      style: editingDefaults.style,
      authorityBoundary: editingDefaults.authorityBoundary,
    },
  },
  derived: {
    types,
    layers,
    scope,
    durationChange,
    outputDurationSeconds: outputDuration,
    outputVideo,
    outputRoot,
  },
  files: {
    request: requestFile,
    context: contextFile,
    artifactIndex,
    delta: deltaFile,
    project: projectFile,
  },
  nextCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(scriptsDirectory, "kacha.mjs"))} next ${JSON.stringify(projectFile)}`,
};
if (dryRun) {
  console.log(JSON.stringify(preview, null, 2));
  releaseLock?.();
  releaseLock = null;
  process.exit(0);
}

fs.mkdirSync(outputRoot, { recursive: true });
const deltaResult = run(process.execPath, [
  path.join(scriptsDirectory, "create_version_delta.mjs"),
  ...deltaArgs,
]);
if (deltaResult.status !== 0) {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fail(
    "KACHA-E140",
    deltaResult.stderr.trim() || deltaResult.stdout.trim() || "delta 编译失败",
  );
}
const delta = readJson(deltaFile);
delta.changeSet.recipeChanges = normalizedChanges.map((item) => ({
  recipe: item.recipe,
  type: item.type,
  reason: item.reason,
  intervals: item.intervals,
  parameters: item.parameters,
  acceptanceCriteria: item.acceptanceCriteria,
  regressionClass: item.regressionClass,
}));
delta.changeSet.regressionScans = normalizedChanges
  .filter((item) => item.regressionClass)
  .map((item) => ({
    class: item.regressionClass,
    scope: "full_timeline_same_signature",
    required: true,
    reason: "修复一个实例后扫描全片同类问题，避免局部返工后重复暴露。",
  }));
delta.changeSet.defaultRequirements = {
  parameters: editingDefaults.parameters,
  instructions: editingDefaults.instructions,
  style: editingDefaults.style,
  authorityBoundary: editingDefaults.authorityBoundary,
};
delta.compiledFrom = {
  requestPath: requestFile,
  compiler: "compile_change_request.mjs",
  schemaVersion: "1.0",
  configurationDigest: loadedConfig.digest,
  configurationSources: loadedConfig.sources,
};
writeJsonAtomic(deltaFile, delta);

const manifestResult = run(process.execPath, [
  path.join(scriptsDirectory, "create_incremental_manifest.mjs"),
  contextFile,
  deltaFile,
  artifactIndex,
  "--output",
  projectFile,
]);
if (manifestResult.status !== 0) {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fail(
    "KACHA-E140",
    manifestResult.stderr.trim() || manifestResult.stdout.trim() || "project manifest 编译失败",
  );
}
const gateResult = run(process.execPath, [
  path.join(scriptsDirectory, "kacha.mjs"),
  "gate-plan",
  projectFile,
]);
if (gateResult.status !== 0) {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fail(
    "KACHA-E140",
    gateResult.stderr.trim() || gateResult.stdout.trim() || "编译后的 gate-plan 失败",
  );
}
writeJsonAtomic(path.join(outputRoot, "compile-receipt.json"), preview);
console.log(JSON.stringify(preview, null, 2));
releaseLock?.();
releaseLock = null;
