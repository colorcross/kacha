#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  mediaSummary,
  run,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  applicableEditingDefaults,
  loadKachaConfig,
} from "./kacha_config.mjs";
import { diagnostic } from "./kacha_error_catalog.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const task = option("--task");
const modules = option("--modules", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const agent = option("--agent", "codex");
const source = option("--source");
const project = option("--project");
const output = option("--output");
let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: project || source || output || process.cwd(),
    includeSecrets: false,
  });
} catch (error) {
  console.error(JSON.stringify({
    status: "blocked",
    diagnostics: [diagnostic("KACHA-E140", `配置无效：${error.message}`)],
  }, null, 2));
  process.exit(1);
}
const modelTier = option("--model-tier", loadedConfig.config.execution.modelTier);
const MODEL_TOKEN_LIMITS = loadedConfig.config.execution.referenceTokenLimits;
const explicitTokenLimit = option("--max-reference-tokens");
const referenceTokenLimit = explicitTokenLimit === null
  ? MODEL_TOKEN_LIMITS[modelTier]
  : Number(explicitTokenLimit);
const release = args.includes("--release");
const fullHash = args.includes("--full-hash");

if (
  !["proposal_review", "source_edit", "content_generation", "local_optimization"]
    .includes(task)
  || !["codex", "claude"].includes(agent)
  || !Object.hasOwn(MODEL_TOKEN_LIMITS, modelTier)
  || !(Number.isInteger(referenceTokenLimit) && referenceTokenLimit > 0)
) {
  console.error(
    "用法：kacha.mjs prepare --task proposal_review|source_edit|content_generation|local_optimization "
      + "[--modules audio,beauty,...] [--agent codex|claude] "
      + "[--model-tier economy|balanced|frontier] [--max-reference-tokens N] "
      + "[--source FILE] [--project PROJECT.json] [--release] [--full-hash] "
      + "[--config FILE] [--secrets FILE] "
      + "[--output packet.json]",
  );
  process.exit(2);
}

const visualModules = new Set([
  "visual",
  "masks",
  "beauty",
  "pip",
  "color",
  "reframe",
  "design",
  "information_card",
  "flowchart",
  "popup",
  "transition",
  "text_behind",
  "subtitles",
  "covers",
  "generated",
  "network_assets",
]);
const needsVisualEvidence = modules.some((item) => visualModules.has(item));
const routedModules = new Set(modules);
if (modelTier === "economy") routedModules.add("low_model");
if (agent === "claude" && needsVisualEvidence) routedModules.add("claude_visual");
const supportModules = [...routedModules].filter((item) => !modules.includes(item));
const editingDefaults = applicableEditingDefaults(loadedConfig, {
  task,
  modules,
});

const route = run(process.execPath, [
  path.join(scriptsDirectory, "route_references.mjs"),
  "--task",
  task,
  "--modules",
  [...routedModules].join(","),
  ...(release ? ["--release"] : []),
]);
if (route.status !== 0) {
  process.stderr.write(route.stderr);
  process.exit(route.status ?? 1);
}
let routed;
try {
  routed = JSON.parse(route.stdout);
} catch (error) {
  console.error(`reference router 输出无法解析：${error.message}`);
  process.exit(1);
}
if (routed.totals.approximateInputTokens > referenceTokenLimit) {
  const report = {
    schemaVersion: "1.0",
    status: "blocked",
    task,
    modelTier,
    contextBudget: {
      ...routed.totals,
      limit: referenceTokenLimit,
      withinBudget: false,
    },
    diagnostics: [diagnostic(
      "KACHA-E140",
      `路由 reference 预算约 ${routed.totals.approximateInputTokens} tokens，`
        + `超过 ${modelTier} 档上限 ${referenceTokenLimit}；`
        + "拆分模块/阶段，或显式提高 --max-reference-tokens。",
    )],
  };
  if (output) writeJsonAtomic(path.resolve(output), report);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

let sourceEvidence = null;
if (source) {
  const sourceFile = path.resolve(source);
  if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
    console.error(JSON.stringify({
      status: "blocked",
      diagnostics: [diagnostic("KACHA-E100", `源文件不存在：${sourceFile}`)],
    }, null, 2));
    process.exit(1);
  }
  try {
    const identity = fileIdentity(sourceFile, { includeHash: fullHash });
    const summary = mediaSummary(sourceFile);
    sourceEvidence = {
      ...identity,
      hashStatus: fullHash ? "verified" : "deferred_until_execution_contract",
      media: {
        durationSeconds: summary.duration,
        width: summary.width,
        height: summary.height,
        declaredFps: summary.declaredFps,
        averageFps: summary.averageFps,
        hasAudio: Boolean(summary.audio),
        audioSampleRate: summary.sampleRate,
        audioChannels: summary.channels,
      },
    };
  } catch (error) {
    console.error(JSON.stringify({
      status: "blocked",
      diagnostics: [diagnostic("KACHA-E500", `源媒体探测失败：${error.message}`)],
    }, null, 2));
    process.exit(1);
  }
}

let projectState = null;
if (project) {
  const result = run(process.execPath, [
    path.join(scriptsDirectory, "next_action.mjs"),
    path.resolve(project),
  ]);
  try {
    projectState = JSON.parse(result.stdout);
  } catch {
    projectState = {
      status: "blocked",
      diagnostics: [diagnostic(
        "KACHA-E500",
        result.stderr.trim() || "next action 输出无法解析",
      )],
    };
  }
}

const workflow = task === "local_optimization" ? "v3_incremental" : "v2_full";
const artifactProtocol = task === "local_optimization"
  ? {
      stableInputs: [
        "project-context.json",
        "artifact-index.json",
      ],
      perVersionInputs: [
        "change-request.json or version-delta.json",
        "incremental-project.json",
      ],
      templates: [
        path.join(path.dirname(scriptsDirectory), "examples", "change-request.json"),
        path.join(path.dirname(scriptsDirectory), "examples", "project-context.json"),
      ],
      preferredCompiler: "kacha.mjs compile-change",
    }
  : {
      stableInputs: [
        "edit-proposal.json",
        "edit-plan.json",
        "project-manifest.json",
      ],
      perVersionInputs: [],
      templates: [
        path.join(path.dirname(scriptsDirectory), "examples", "edit-proposal.json"),
        path.join(path.dirname(scriptsDirectory), "examples", "edit-plan.json"),
        path.join(path.dirname(scriptsDirectory), "examples", "project-manifest.json"),
      ],
      validators: [
        "validate_edit_proposal.mjs",
        "validate_edit_plan.mjs",
        "kacha.mjs gate-plan",
      ],
    };
const packet = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  purpose: "low-capability-model execution packet",
  agent,
  modelTier,
  task,
  workflow,
  modules,
  supportModules,
  release,
  readOrder: routed.files.map((item) => item.absolutePath),
  contextBudget: {
    ...routed.totals,
    limit: referenceTokenLimit,
    withinBudget: true,
  },
  sourceEvidence,
  projectState,
  artifactProtocol,
  configuration: {
    digest: loadedConfig.digest,
    sources: loadedConfig.sources,
    editingDefaults,
  },
  decisionBoundary: {
    modelOwns: [
      "用户意图、内容结构、创意理由、配方选择、样式帧比较和证据解释",
    ],
    scriptsOwn: [
      "文件身份、媒体规格、影响级别、缓存失效、状态推进、技术 QC 和门禁",
    ],
    humanOwns: [
      "正常速度通看、设备试听、审美批准、外传/付费/发布授权",
    ],
  },
  invariants: [
    "源和基线只读；新版本独立输出。",
    "用户未授权时保持源几何，不上传、不付费、不发布。",
    "半句、数字、专名、否定、条件、因果和结论不得被剪断或改义。",
    "所有时间层共用帧边界和 PTS。",
    "自动 QC 不等于人工审片；旧报告不属于新输出。",
  ],
  executionProtocol: [
    "完整读取 readOrder 中的文件。",
    "若 projectState 存在，只执行 projectState.nextAction。",
    "每完成一步重新运行 kacha.mjs next；不要自行跳级。",
    "遇到 diagnostics 按 code/remediation 处理，不用猜测填空。",
  ],
  visualEvidencePolicy: needsVisualEvidence
    ? {
        required: true,
        localCommand: source
          ? [
              process.execPath,
              path.join(scriptsDirectory, "kacha.mjs"),
              "visual-evidence",
              path.resolve(source),
              "--output-dir",
              path.resolve(path.dirname(output || process.cwd()), "visual-evidence"),
              "--mode",
              task === "proposal_review" ? "fast" : "review",
              ...(option("--config") ? ["--config", path.resolve(option("--config"))] : []),
            ].map((item) => JSON.stringify(item)).join(" ")
          : null,
        claudePolicy: agent === "claude"
          ? "先消费 visual-evidence.json/.md；只有本地语义不足且项目授权外传时才运行 vision-enrich。"
          : "代表帧、时间码和机器证据必须与模型视觉判断交叉核对。",
      }
    : { required: false },
  prohibitedShortcuts: [
    "不得把预览、自动报告或渲染完成提示称为最终发布成片。",
    "不得静默更换美颜、人声分离、视觉分析或生成媒体后端。",
    "不得上传整段视频补偿 Claude 的视觉缺口。",
  ],
};
if (output) writeJsonAtomic(path.resolve(output), packet);
console.log(JSON.stringify(packet, null, 2));
