#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  mediaSummary,
  readJson,
  sha256File,
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

function approximateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.6);
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
const currentProject = project && fs.existsSync(project) ? readJson(path.resolve(project)) : null;
const legacyWorkflow = currentProject && currentProject.schemaVersion === '2.0' && currentProject.workflowPolicy?.version !== 'adaptive-v1';
const transcriptInput = option("--transcript");
const transcriptWindow = option("--transcript-window");
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
const STAGES = new Set(["inventory", "content", "edit", "visual_audio", "release"]);
const DEFAULT_STAGE_BY_TASK = {
  proposal_review: "inventory",
  source_edit: "edit",
  content_generation: "content",
  local_optimization: "edit",
};
const capabilityInput = option("--capabilities");
let capabilities = { imageInput: 'unknown', audioInput: 'unknown', videoInput: 'unknown' };
if (capabilityInput) {
  const supplied = readJson(path.resolve(capabilityInput));
  if (supplied.schemaVersion !== '1.0' || typeof supplied.evidence !== 'string' || !supplied.evidence.trim()
      || ['imageInput','audioInput','videoInput'].some(key => typeof supplied[key] !== 'boolean')) {
    throw new Error('能力配置需要 schemaVersion 1.0、实际会话 evidence 和三项 boolean 输入能力');
  }
  capabilities = { ...supplied, identity: fileIdentity(path.resolve(capabilityInput)) };
}
const executionMode = option('--execution-mode', modelTier === 'economy' ? 'guided' : 'adaptive');
if (!['guided','adaptive'].includes(executionMode)) throw new Error('--execution-mode 必须为 guided 或 adaptive');
const stage = option(
  "--stage",
  executionMode === "guided" ? DEFAULT_STAGE_BY_TASK[task] : null,
);
if (stage && !STAGES.has(stage)) {
  console.error(`--stage 无效：${stage}`);
  process.exit(2);
}
const MODEL_TOKEN_LIMITS = loadedConfig.config.execution.referenceTokenLimits;
const explicitTokenLimit = option("--max-reference-tokens");
const configuredReferenceTokenLimit = explicitTokenLimit === null
  ? MODEL_TOKEN_LIMITS[modelTier]
  : Number(explicitTokenLimit);
const referenceTokenLimit = stage
  ? Math.min(configuredReferenceTokenLimit, 12_000)
  : configuredReferenceTokenLimit;
const release = args.includes("--release");
const fullHash = args.includes("--full-hash");

if (
  !["proposal_review", "source_edit", "content_generation", "local_optimization", "material_edit"]
    .includes(task)
  || !["codex", "claude"].includes(agent)
  || !Object.hasOwn(MODEL_TOKEN_LIMITS, modelTier)
  || !(Number.isInteger(referenceTokenLimit) && referenceTokenLimit > 0)
) {
  console.error(
    "用法：kacha.mjs prepare --task proposal_review|source_edit|content_generation|local_optimization|material_edit "
      + "[--modules audio,beauty,...] [--agent codex|claude] "
      + "[--stage inventory|content|edit|visual_audio|release] "
      + "[--model-tier economy|balanced|frontier] [--max-reference-tokens N] "
      + "[--source FILE] [--transcript TRANSCRIPT.json] "
      + "[--transcript-window START:END] "
      + "[--project PROJECT.json] [--release] [--full-hash] "
      + "[--config FILE] [--secrets FILE] "
      + "[--output packet.json]",
  );
  process.exit(2);
}

const visualModules = new Set([
  "video_generation",
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
if (executionMode === "guided") routedModules.add("low_model");
if (needsVisualEvidence) routedModules.add("visual_evidence");
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
  ...(stage ? ["--stage", stage] : []),
  ...(legacyWorkflow ? ["--legacy-workflow"] : []),
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

let transcriptEvidence = null;
if (transcriptInput) {
  const transcriptFile = path.resolve(transcriptInput);
  if (!fs.existsSync(transcriptFile) || !fs.statSync(transcriptFile).isFile()) {
    console.error(JSON.stringify({
      status: "blocked",
      diagnostics: [diagnostic("KACHA-E100", `转写文件不存在：${transcriptFile}`)],
    }, null, 2));
    process.exit(1);
  }
  try {
    const transcript = readJson(transcriptFile);
    const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
    const lowConfidence = segments.filter(
      (segment) => segment.confidence === "low"
        || (segment.reasons ?? []).length > 0,
    );
    const indexResult = run(process.execPath, [
      path.join(scriptsDirectory, "transcript_window.mjs"),
      "index",
      transcriptFile,
      "--window-seconds",
      "90",
    ]);
    if (indexResult.status !== 0) {
      throw new Error(indexResult.stderr.trim() || "转写窗口索引失败");
    }
    const index = JSON.parse(indexResult.stdout);
    let selectedWindow = null;
    if (transcriptWindow) {
      const match = /^([0-9]+(?:\.[0-9]+)?):([0-9]+(?:\.[0-9]+)?)$/
        .exec(transcriptWindow);
      if (!match) throw new Error("--transcript-window 必须是 START:END");
      const sliceResult = run(process.execPath, [
        path.join(scriptsDirectory, "transcript_window.mjs"),
        "slice",
        transcriptFile,
        "--start",
        match[1],
        "--end",
        match[2],
      ]);
      if (sliceResult.status !== 0) {
        throw new Error(sliceResult.stderr.trim() || "转写窗口读取失败");
      }
      selectedWindow = JSON.parse(sliceResult.stdout);
    }
    const maximumInlineReviewSegments = 20;
    transcriptEvidence = {
      path: transcriptFile,
      sha256: sha256File(transcriptFile),
      status: transcript.status ?? "unknown",
      language: transcript.language ?? null,
      durationSeconds: transcript.durationSeconds ?? null,
      segmentCount: segments.length,
      index: {
        windowSeconds: index.windowSeconds,
        windows: index.windows,
      },
      selectedWindow,
      lowConfidenceSegments: lowConfidence
        .slice(0, maximumInlineReviewSegments)
        .map((segment) => ({
        id: segment.id,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        reasons: segment.reasons ?? [],
        })),
      lowConfidenceCount: lowConfidence.length,
      lowConfidenceOmittedCount: Math.max(
        0,
        lowConfidence.length - maximumInlineReviewSegments,
      ),
      access: {
        indexCommand: `node ${path.join(scriptsDirectory, "kacha.mjs")} `
          + `transcript index ${transcriptFile}`,
        sliceCommand: `node ${path.join(scriptsDirectory, "kacha.mjs")} `
          + `transcript slice ${transcriptFile} --start SEC --end SEC`,
        maximumSliceSeconds: 180,
      },
      fullTextOmittedFromPacket: true,
      wordsOmittedFromPacket: true,
    };
  } catch (error) {
    console.error(JSON.stringify({
      status: "blocked",
      diagnostics: [diagnostic("KACHA-E140", `转写 JSON 无效：${error.message}`)],
    }, null, 2));
    process.exit(1);
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
  purpose: "capability-aware editing execution packet",
  executionMode,
  capabilities,
  agent,
  modelTier,
  stage,
  task,
  workflow,
  resolvedContract: {
    workflowPolicy: legacyWorkflow ? 'legacy' : currentProject?.workflowPolicy?.version ?? 'adaptive-v1',
    productionPack: currentProject?.productionPack ?? null,
    show: currentProject?.show ?? null,
    proposalDefaults: legacyWorkflow ? { preserveExisting: true } : { workflowPolicy: { version: 'adaptive-v1' }, executionFlow: 'derived_from_plan_modules' },
    decisionSource: 'editProposal + Timeline IR; derived views must reference current identities',
    finalReview: 'current_candidate_required',
  },
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
  transcriptEvidence,
  projectState,
  artifactProtocol,
  agentControlPlane: {
    primaryInterface: "natural_language_chat",
    mutationDelta: "kacha.mjs delta apply",
    localMediaSearch: "kacha.mjs media index|search",
    asyncJobs: "kacha.mjs jobs submit|status|list|cancel|resume",
    objectReferences: "kacha.mjs refs index|resolve|parse",
    installStatus: "kacha.mjs install status|sync",
    policy: [
      "小合同修改只返回 mutation delta，不回传完整 before/after。",
      "素材搜索只返回少量带语义和许可证据的候选。",
      "耗时任务使用 placeholder；ready 前不得接入正式时间线。",
      "对象引用必须绑定 owner SHA、JSON Pointer 和 object digest。",
    ],
  },
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
    ...(stage
      ? [
          `只处理 ${stage} 阶段；完成后写入项目状态文件，再进入下一阶段。`,
          "需要效果或剪辑规则时先运行 rules query，只接收每条规则的 1–3 个候选。",
          ...(transcriptEvidence
            ? [
                "按 transcriptEvidence.index 逐个读取最多 180 秒的转写窗口；"
                  + "不得把完整 transcript 或逐词 JSON 放回提示词。",
              ]
            : []),
        ]
      : []),
    executionMode === 'guided' ? "若 projectState 存在，只执行 projectState.nextAction。"
      : "按当前 nextAction.availableStages 安排独立任务；一轮可完成多项判断，每项记录前核对 expectedInputDigest，不能跨越真实依赖。",
    "已有对象先用 refs resolve 缩小读取；小合同修改用 delta apply。",
    "耗时步骤可提交 jobs，但 placeholder ready 前不得假定产物存在。",
    executionMode === 'guided' ? "每完成一步重新运行 kacha.mjs next；不要自行跳级。"
      : "复用当前素材理解统一决定结构、切点、素材与声音；只有输入/依赖变化时刷新，昂贵任务仍受资源锁和授权约束。",
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
        inputPolicy: capabilities.imageInput === true
          ? "直接检查当前代表帧，结合时间码和技术证据；视频/音频能力以本次会话配置为准。"
          : "图像输入能力未知或不可用；先检查本地技术证据，语义审阅须选择有实际能力且获授权的入口，不从文本猜画面。",
      }
    : { required: false },
  prohibitedShortcuts: [
    "不得把预览、自动报告或渲染完成提示称为最终发布成片。",
    "不得静默更换美颜、人声分离、视觉分析或生成媒体后端。",
    "能力声明不授予上传权限；不能为补偿任何模型的输入限制而擅自外传素材。",
  ],
  ruleRetrieval: stage
    ? {
        registry: path.join(
          path.dirname(scriptsDirectory),
          "config",
          "decision-rules.json",
        ),
        commandTemplate: [
          process.execPath,
          path.join(scriptsDirectory, "kacha.mjs"),
          "rules",
          "query",
          "--stage",
          stage,
          "--modules",
          modules.join(",") || "decision",
          "--signals",
          "SIGNALS.json",
          "--limit",
          "3",
        ].map((item) => JSON.stringify(item)).join(" "),
      }
    : null,
};
const packetTokenLimit = stage ? 16_000 : referenceTokenLimit + 8_000;
const packetTokenEstimate = approximateTokens(packet);
packet.packetBudget = {
  approximateInputTokens: packetTokenEstimate,
  limit: packetTokenLimit,
  withinBudget: packetTokenEstimate <= packetTokenLimit,
  excludes: [
    "按需读取的 transcript window",
    "工具完整日志",
    "完整逐词时间戳",
  ],
};
if (!packet.packetBudget.withinBudget) {
  packet.status = "blocked";
  packet.diagnostics = [
    diagnostic(
      "KACHA-E140",
      `agent packet 约 ${packetTokenEstimate} tokens，超过 ${packetTokenLimit}；`
        + "请缩小转写窗口、阶段或模块范围。",
    ),
  ];
  if (output) writeJsonAtomic(path.resolve(output), packet);
  console.error(JSON.stringify(packet, null, 2));
  process.exit(1);
}
if (output) writeJsonAtomic(path.resolve(output), packet);
console.log(JSON.stringify(packet, null, 2));
