import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireFileLock,
  fileIdentity,
  fileIdentityMatches,
  mediaSummary,
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { buildAssetInbox } from "./asset_inbox.mjs";
import {
  auditHighValueCache,
  buildEfficiencyPlan,
  buildSchedule,
  validateEfficiencyPlan,
} from "./quality_efficiency.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const recipeFile = path.join(skillRoot, "config", "workflow-recipes.json");
const orchestrationRelativePath = path.join(".kacha", "orchestration.json");

function now() {
  return new Date().toISOString();
}

function readOptionalJsonEvidence(file, label) {
  if (!file || !fs.existsSync(file)) return { value: null, error: null };
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("expected a regular non-symbolic-link file");
    }
    return { value: readJson(file), error: null };
  } catch (error) {
    return { value: null, error: `${label} cannot be read: ${error.message}` };
  }
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} 输出无法解析：${error.message}`);
  }
}

function installedVersion(root = skillRoot) {
  const file = path.join(root, ".kacha-version");
  if (!fs.existsSync(file)) return null;
  const value = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) value[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return value;
}

export function inspectRuntime({ home = os.homedir() } = {}) {
  const gitRef = run("git", ["-C", skillRoot, "rev-parse", "HEAD"]);
  const gitStatus = run("git", ["-C", skillRoot, "status", "--short"]);
  const installed = installedVersion();
  const sourceRef = gitRef.status === 0
    ? gitRef.stdout.trim()
    : installed?.core_ref ?? null;
  const sourceDirty = gitStatus.status === 0
    ? gitStatus.stdout.trim().length > 0
    : installed?.core_dirty === "true";
  const install = run(process.execPath, [
    path.join(scriptDirectory, "kacha_install.mjs"),
    "status",
    "--source",
    skillRoot,
    "--agent",
    "both",
    "--home",
    path.resolve(home),
  ]);
  let installReport = null;
  let installError = null;
  if (install.status === 0) {
    try {
      installReport = JSON.parse(install.stdout);
    } catch (error) {
      installError = `安装状态无法解析：${error.message}`;
    }
  } else {
    installError = (install.stderr || install.stdout).trim() || "安装状态检查失败";
  }
  const installedTargetsCurrent = installReport?.targets?.length > 0
    && installReport.targets.every((target) => target.state === "current");
  const productionReady = Boolean(
    sourceRef
    && sourceDirty === false
    && installReport?.status === "pass"
    && installedTargetsCurrent,
  );
  return {
    schemaVersion: "1.0",
    checkedAt: now(),
    skillRoot,
    mode: gitRef.status === 0 ? "source_checkout" : "installed_bundle",
    sourceRef,
    sourceDirty,
    bundleDigest: installReport?.bundleDigest ?? installed?.core_content_sha256 ?? null,
    installStatus: installReport?.status ?? "unavailable",
    targets: installReport?.targets ?? [],
    productionReady,
    diagnostics: [
      ...(sourceDirty ? ["source_worktree_dirty"] : []),
      ...(!installedTargetsCurrent ? ["agent_installations_out_of_sync"] : []),
      ...(installError ? [installError] : []),
    ],
  };
}

function slug(value, fallback = "kacha-project") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function ratioLabel(width, height) {
  const gcd = (left, right) => (right === 0 ? left : gcd(right, left % right));
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

function sourceFromBrief(briefFile) {
  const brief = readJson(briefFile);
  if (brief.kind !== "kacha-production-brief") {
    throw new Error("brief.kind 必须为 kacha-production-brief");
  }
  const sourcePath = brief.source?.path ? path.resolve(brief.source.path) : null;
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`brief 源文件不存在：${sourcePath ?? "missing"}`);
  }
  const identity = fileIdentity(sourcePath);
  if (brief.source?.sha256 && brief.source.sha256 !== identity.sha256) {
    throw new Error("brief 源文件 SHA-256 已变化，必须重新编译生产请求");
  }
  return {
    brief,
    input: {
      type: "video",
      role: "source_media",
      ...identity,
      media: {
        width: brief.source.width,
        height: brief.source.height,
        fps: brief.source.fps,
        durationSeconds: brief.source.durationSeconds,
        videoCodec: brief.source.videoCodec,
        audioCodec: brief.source.audioCodec,
        sampleRate: brief.source.sampleRate,
        channels: brief.source.channels,
      },
      readOnly: true,
    },
  };
}

function sourceFromVideo(sourceFile) {
  const resolved = path.resolve(sourceFile);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`源视频不存在：${resolved}`);
  }
  const media = mediaSummary(resolved);
  return {
    brief: null,
    input: {
      type: "video",
      role: "source_media",
      ...fileIdentity(resolved),
      media,
      readOnly: true,
    },
  };
}

function contentInput({ script, topic }) {
  if (script) {
    const resolved = path.resolve(script);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`内容输入不存在：${resolved}`);
    }
    return {
      type: "document",
      role: "content_source",
      ...fileIdentity(resolved),
      readOnly: true,
    };
  }
  if (typeof topic === "string" && topic.trim()) {
    return {
      type: "topic",
      role: "content_source",
      value: topic.trim(),
      digest: sha256Value(topic.trim()),
      readOnly: true,
    };
  }
  throw new Error("content_generation 需要 --script 或 --topic");
}

function relativeFrom(ownerFile, target) {
  return path.relative(path.dirname(ownerFile), target).split(path.sep).join("/") || ".";
}

function outputContractFor(input) {
  if (input.type !== "video") return null;
  const media = input.media;
  const width = Number(media.width ?? media.displayWidth);
  const height = Number(media.height ?? media.displayHeight);
  return {
    width,
    height,
    aspectRatio: ratioLabel(width, height),
    fps: Number(media.fps ?? media.averageFrameRate),
    fpsTolerance: 0.001,
    audioSampleRate: Number(media.sampleRate ?? 48000),
    expectedChannels: Number(media.channels ?? 2),
    maxAvDriftFrames: 1,
    integratedLufsMin: -21.5,
    integratedLufsMax: -19,
    truePeakMax: -3,
    audioMix: {
      bgmRequired: true,
      adaptiveBgmRequired: true,
      masterTruePeakDb: -4,
      bgmBelowDialogueDbMin: 12,
      bgmBelowDialogueDbMax: 24,
      bgmMinimumCoverageRatio: 0.95,
    },
  };
}

// 项目脚手架：把本机运行状态目录加入项目 .gitignore。append-only 且去重：
// 用户已有 .gitignore 只追加缺失行，没有就不创建之外的任何改动。
function ensureProjectGitignore(baseRoot) {
  const gitignore = path.join(baseRoot, ".gitignore");
  const needed = [".kacha/", "previews/", "output/"];
  let existing = "";
  try {
    existing = fs.readFileSync(gitignore, "utf8");
  } catch {
    // 没有就是全新文件。
  }
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = needed.filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignore, `${prefix}${["# kacha 本机运行状态与产物", ...missing].join("\n")}\n`);
}

function buildManifest({ projectId, projectRoot, input, runtimeLock, options }) {
  const contracts = path.join(projectRoot, "contracts");
  const manifestFile = path.join(contracts, "project-manifest.json");
  const rel = (file) => relativeFrom(manifestFile, file);
  return {
    schemaVersion: "2.0",
    kind: "kacha-project-manifest",
    projectId,
    lifecycle: {
      status: "planning",
      createdBy: "kacha-start",
      productionMilestones: ["proposal", "first_cut", "review", "delivery"],
    },
    runtimeLock,
    show: options.show,
    style: options.style,
    platform: options.platform,
    language: options.language,
    intelligenceV6: { required: true },
    productionQualityV1: { required: true },
    plans: {
      proposal: rel(path.join(contracts, "edit-proposal.json")),
      editPlan: rel(path.join(contracts, "edit-plan.json")),
      directorPlan: rel(path.join(contracts, "director-plan.json")),
      adaptiveBgm: rel(path.join(contracts, "adaptive-bgm-plan.json")),
      assetGapPlan: rel(path.join(contracts, "asset-gap-plan.json")),
      temporalPerceptionAudit: rel(path.join(contracts, "temporal-perception-audit.json")),
      semanticReviewSession: rel(path.join(projectRoot, ".kacha", "review", "review-session.json")),
      productionQuality: rel(path.join(contracts, "production-quality-contract.json")),
      coverIdentity: rel(path.join(contracts, "cover-identity-contract.json")),
      qualityEfficiency: rel(path.join(projectRoot, ".kacha", "efficiency-plan.json")),
      netstyleTimelines: [],
      visualBreathingTimelines: [],
      captionTimelines: [],
      timeline: {
        path: rel(path.join(contracts, "timeline-ir.json")),
        mode: "production",
      },
    },
    capabilityManifest: rel(path.join(contracts, "capabilities.json")),
    requiredCapabilities: [
      "command:ffmpeg",
      "command:ffprobe",
      "filter:overlay",
      "filter:blackdetect",
      "filter:freezedetect",
      "filter:silencedetect",
    ],
    source: input,
    expectedMedia: outputContractFor(input),
    requiredCoverAspectRatios: ["3:4", "4:3"],
    outputs: {
      finalVideo: { path: rel(path.join(projectRoot, "output", "final.mov")) },
      covers: [
        { aspectRatio: "3:4", path: rel(path.join(projectRoot, "output", "cover-3x4.png")) },
        { aspectRatio: "4:3", path: rel(path.join(projectRoot, "output", "cover-4x3.png")) },
      ],
      subtitles: [
        { language: "zh-CN", path: rel(path.join(projectRoot, "output", "subtitles.zh-CN.srt")) },
      ],
      audioStems: {
        dialogue: { path: rel(path.join(projectRoot, "output", "dialogue-stem.wav")) },
        bgm: { path: rel(path.join(projectRoot, "output", "bgm-stem.wav")) },
        sfx: { path: rel(path.join(projectRoot, "output", "sfx-stem.wav")) },
        mix: { path: rel(path.join(projectRoot, "output", "final-mix-stem.wav")) },
      },
      technicalQcReport: { path: rel(path.join(projectRoot, "output", "technical-qc.json")) },
      releaseReport: { path: rel(path.join(projectRoot, "output", "release-report.json")) },
    },
  };
}

function buildContentContract({ projectId, input, options, runtimeLock }) {
  return {
    schemaVersion: "1.0",
    kind: "kacha-content-project",
    projectId,
    task: "content_generation",
    input,
    show: options.show,
    style: options.style,
    platform: options.platform,
    language: options.language,
    runtimeLock,
    intelligenceV6: {
      requiredOnSourceEditHandoff: true,
    },
    requiredOutputs: [
      "content-spine.json",
      "fact-check-tasks.json",
      "recording-plan.json",
      "asset-inbox.json",
      "source-edit-handoff.json",
    ],
    handoffBoundary: "录制或生成媒体回填并冻结文件身份后，建立 source_edit 项目",
  };
}

function appendEvent(projectRoot, event) {
  const file = path.join(projectRoot, ".kacha", "project-events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: now(), ...event })}\n`, { mode: 0o600 });
}

export function initializeProject({
  briefPath = null,
  source = null,
  script = null,
  topic = null,
  projectRoot = null,
  projectId = null,
  task = null,
  show = "tool-share",
  style = "light-warm-overlay",
  platform = "general",
  language = "zh",
  confirmExecute = false,
  development = false,
  enforceRuntime = true,
  home = os.homedir(),
} = {}) {
  const briefResolved = briefPath ? path.resolve(briefPath) : null;
  const fromBrief = briefResolved ? sourceFromBrief(briefResolved) : null;
  const resolvedTask = task ?? fromBrief?.brief?.task
    ?? (script || topic ? "content_generation" : "source_edit");
  if (!new Set(["source_edit", "content_generation", "local_optimization"]).has(resolvedTask)) {
    throw new Error(`不支持的 task：${resolvedTask}`);
  }
  const input = fromBrief?.input
    ?? (source ? sourceFromVideo(source).input : contentInput({ script, topic }));
  const baseRoot = projectRoot
    ? path.resolve(projectRoot)
    : briefResolved
      ? path.dirname(briefResolved)
      : path.resolve(`${slug(projectId ?? path.parse(input.path ?? "content").name)}-kacha`);
  const orchestrationFile = path.join(baseRoot, orchestrationRelativePath);
  if (fs.existsSync(orchestrationFile)) {
    throw new Error(`项目已经初始化：${orchestrationFile}`);
  }
  fs.mkdirSync(path.join(baseRoot, "contracts"), { recursive: true });
  fs.mkdirSync(path.join(baseRoot, ".kacha", "review"), { recursive: true });
  fs.mkdirSync(path.join(baseRoot, ".kacha", "packets"), { recursive: true });
  fs.mkdirSync(path.join(baseRoot, "previews"), { recursive: true });
  fs.mkdirSync(path.join(baseRoot, "output"), { recursive: true });
  ensureProjectGitignore(baseRoot);

  const runtime = inspectRuntime({ home });
  const runtimeAllowed = development || runtime.productionReady || !enforceRuntime;
  const resolvedProjectId = slug(
    projectId ?? fromBrief?.brief?.projectName ?? path.parse(input.path ?? "content").name,
  );
  const options = {
    show: fromBrief?.brief?.target?.show ?? show,
    style: fromBrief?.brief?.style?.id ?? style,
    platform: fromBrief?.brief?.target?.platform ?? platform,
    language: fromBrief?.brief?.target?.language ?? language,
  };
  const runtimeLock = {
    sourceRef: runtime.sourceRef,
    sourceDirty: runtime.sourceDirty,
    bundleDigest: runtime.bundleDigest,
    installStatus: runtime.installStatus,
    mode: development ? "development" : "production",
    checkedAt: runtime.checkedAt,
  };
  let manifestFile = null;
  let contentContractFile = null;
  if (input.type === "video") {
    manifestFile = path.join(baseRoot, "contracts", "project-manifest.json");
    writeJsonAtomic(manifestFile, buildManifest({
      projectId: resolvedProjectId,
      projectRoot: baseRoot,
      input,
      runtimeLock,
      options,
    }));
    const productionQualityFile = path.join(
      baseRoot,
      "contracts",
      "production-quality-contract.json",
    );
    const productionQuality = run(process.execPath, [
      path.join(scriptDirectory, "production_quality_contract.mjs"),
      "template",
      "--project-id",
      resolvedProjectId,
      "--pack",
      "xingzhe-dahui",
      "--show",
      options.show,
      "--output",
      productionQualityFile,
    ]);
    if (productionQuality.status !== 0) {
      throw new Error(
        productionQuality.stderr.trim()
          || productionQuality.stdout.trim()
          || "无法初始化生产质量合同",
      );
    }
  } else {
    contentContractFile = path.join(baseRoot, "contracts", "content-project.json");
    writeJsonAtomic(contentContractFile, buildContentContract({
      projectId: resolvedProjectId,
      input,
      options,
      runtimeLock,
    }));
  }
  if (!briefResolved) {
    writeJsonAtomic(path.join(baseRoot, "production-brief.json"), {
      schemaVersion: "1.0",
      kind: "kacha-production-brief",
      generatedAt: now(),
      projectName: resolvedProjectId,
      task: resolvedTask,
      source: input,
      target: options,
      intelligenceV6: { required: input.type === "video" },
      authorityBoundary: "本项目不授权上传、付费生成、发布、覆盖源文件或跳过门禁。",
    });
  }
  const recipeIdentity = fileIdentity(recipeFile);
  const state = {
    schemaVersion: "1.0",
    kind: "kacha-production-orchestration",
    projectId: resolvedProjectId,
    projectRoot: baseRoot,
    createdAt: now(),
    updatedAt: now(),
    task: resolvedTask,
    input,
    show: options.show,
    style: options.style,
    platform: options.platform,
    language: options.language,
    runtimeLock,
    runtimeDiagnostics: runtime.diagnostics,
    executionAuthorization: {
      status: confirmExecute ? "authorized_local" : "not_authorized",
      grantedAt: confirmExecute ? now() : null,
      boundary: "local_execution_only",
      upload: false,
      paidGeneration: false,
      publish: false,
      overwriteSource: false,
    },
    intelligenceV6: {
      required: input.type === "video",
      compatibilityMode: false,
    },
    recipes: recipeIdentity,
    files: {
      brief: briefResolved ?? path.join(baseRoot, "production-brief.json"),
      manifest: manifestFile,
      contentContract: contentContractFile,
      projectState: path.join(baseRoot, ".kacha", "project-state.json"),
      assetInbox: path.join(baseRoot, ".kacha", "asset-inbox.json"),
      reviewRoot: path.join(baseRoot, ".kacha", "review"),
      metricsRoot: path.join(baseRoot, ".kacha", "metrics"),
      efficiencyPlan: path.join(baseRoot, ".kacha", "efficiency-plan.json"),
      efficiencyInputs: path.join(baseRoot, ".kacha", "efficiency-inputs.json"),
      cacheAudit: path.join(baseRoot, ".kacha", "cache-audit.json"),
    },
    lifecycle: {
      status: !runtimeAllowed
        ? "blocked_runtime"
        : confirmExecute ? "planning" : "awaiting_authorization",
      milestone: "proposal",
      completionBoundary: null,
    },
    latestAction: null,
  };
  state.digest = sha256Value({ ...state, digest: undefined, updatedAt: undefined });
  writeJsonAtomic(orchestrationFile, state);
  buildEfficiencyPlan({
    projectRoot: baseRoot,
    outputPath: state.files.efficiencyPlan,
  });
  auditHighValueCache({
    projectRoot: baseRoot,
    outputPath: state.files.cacheAudit,
  });
  appendEvent(baseRoot, {
    type: "project_initialized",
    projectId: resolvedProjectId,
    task: resolvedTask,
    runtimeReady: runtime.productionReady,
    development,
  });
  return projectStatus(baseRoot, { refreshRuntime: false });
}

export function resolveProjectRoot(input) {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`项目路径不存在：${resolved}`);
  }
  if (path.basename(resolved) === "orchestration.json") return path.dirname(path.dirname(resolved));
  if (path.basename(path.dirname(resolved)) === "contracts") return path.dirname(path.dirname(resolved));
  return path.dirname(resolved);
}

export function handoffContentProject(input, source, {
  targetRoot = null,
  confirmContentApproved = false,
  confirmExecute = false,
  development = false,
  home = os.homedir(),
} = {}) {
  const contentRoot = resolveProjectRoot(input);
  const { value: orchestration } = readOrchestration(contentRoot);
  if (orchestration.task !== "content_generation") throw new Error("只有 content_generation 项目可以交接源媒体");
  if (!contentPackageReady(contentRoot)) throw new Error("内容生产包尚未完成");
  if (!confirmContentApproved) throw new Error("交接前必须显式设置 confirmContentApproved=true");
  const spineFile = path.join(contentRoot, "contracts", "content-spine.json");
  const factFile = path.join(contentRoot, "contracts", "fact-check-tasks.json");
  const inboxFile = path.join(contentRoot, ".kacha", "asset-inbox.json");
  const handoffFile = path.join(contentRoot, "contracts", "source-edit-handoff.json");
  const spine = readJson(spineFile);
  const facts = readJson(factFile);
  const inbox = readJson(inboxFile);
  if (spine.status !== "approved_for_recording") throw new Error("content spine 尚未批准录制");
  const unresolvedFacts = (facts.tasks ?? []).filter((task) => !["verified", "waived_with_reason"].includes(task.status));
  if (unresolvedFacts.length > 0) throw new Error(`仍有 ${unresolvedFacts.length} 项事实核查未解决`);
  const unresolvedAssets = (inbox.items ?? []).filter((item) => !["resolved", "waived_with_reason"].includes(item.status));
  if (unresolvedAssets.length > 0) throw new Error(`仍有 ${unresolvedAssets.length} 项内容素材缺口未解决`);
  const childRoot = path.resolve(targetRoot ?? path.join(contentRoot, "source-edit"));
  const child = initializeProject({
    source,
    projectRoot: childRoot,
    projectId: `${orchestration.projectId}-source-edit`,
    task: "source_edit",
    show: orchestration.show,
    style: orchestration.style,
    platform: orchestration.platform,
    language: orchestration.language,
    confirmExecute,
    development,
    enforceRuntime: true,
    home,
  });
  const manifestFile = child.files.manifest;
  const manifest = readJson(manifestFile);
  manifest.contentOrigin = {
    contentProject: fileIdentity(orchestration.files.contentContract),
    contentSpine: fileIdentity(spineFile),
    factCheckTasks: fileIdentity(factFile),
    assetInbox: fileIdentity(inboxFile),
    handoff: fileIdentity(handoffFile),
  };
  writeJsonAtomic(manifestFile, manifest);
  const handoff = readJson(handoffFile);
  handoff.status = "source_edit_created";
  handoff.sourceMedia = fileIdentity(path.resolve(source));
  handoff.sourceEditProject = { root: childRoot, manifest: fileIdentity(manifestFile) };
  handoff.handedOffAt = now();
  writeJsonAtomic(handoffFile, handoff);
  appendEvent(contentRoot, { type: "source_edit_handoff", childRoot, source: handoff.sourceMedia });
  return projectStatus(childRoot, { refreshRuntime: false, home });
}

function readOrchestration(projectRoot) {
  const file = path.join(projectRoot, orchestrationRelativePath);
  if (!fs.existsSync(file)) throw new Error(`项目未初始化：${file}`);
  return { file, value: readJson(file) };
}

function verifyInput(input) {
  if (!input?.path) return { status: "pass", identity: null };
  if (!fs.existsSync(input.path) || !fs.statSync(input.path).isFile()) {
    return { status: "blocked", diagnostics: ["input_missing"] };
  }
  return fileIdentityMatches(input.path, input)
    ? { status: "pass", identity: fileIdentity(input.path) }
    : { status: "blocked", diagnostics: ["input_identity_changed"] };
}

function stageViews(projectRoot, orchestration) {
  const recipes = readJson(recipeFile);
  const stateFile = orchestration.files?.projectState;
  const projectState = stateFile && fs.existsSync(stateFile) ? readJson(stateFile) : null;
  const stages = recipes.stages.map((recipe) => ({
    ...recipe,
    evidenceContract: recipe.evidence,
    status: projectState?.stages?.[recipe.id]?.status ?? "pending",
    evidence: projectState?.stages?.[recipe.id]?.evidence ?? null,
  }));
  const milestones = recipes.milestones.map((milestone) => {
    const members = stages.filter((stage) => milestone.stages.includes(stage.id));
    const completed = members.filter((stage) => stage.status === "complete").length;
    const blocked = members.some((stage) => stage.status === "blocked");
    return {
      ...milestone,
      status: blocked ? "blocked"
        : completed === members.length ? "complete"
          : completed > 0 ? "in_progress" : "pending",
      completedStages: completed,
      totalStages: members.length,
    };
  });
  return { stages, milestones, projectState };
}

function contractsReady(orchestration) {
  if (!orchestration.files?.manifest) return false;
  const manifest = readJson(orchestration.files.manifest);
  const resolveEntry = (entry) => path.resolve(
    path.dirname(orchestration.files.manifest),
    typeof entry === "string" ? entry : entry?.path ?? "",
  );
  return Boolean(
    manifest.intelligenceV6?.required === true
    && fs.existsSync(resolveEntry(manifest.plans?.proposal))
    && fs.existsSync(resolveEntry(manifest.plans?.editPlan)),
  );
}

function deriveNextAction(projectRoot, orchestration, runtime, inputCheck) {
  if (inputCheck.status !== "pass") {
    return {
      id: "restore_input",
      owner: "human",
      state: "blocked",
      safeToAutoExecute: false,
      summary: "恢复冻结的输入文件或从当前输入重新建立项目",
      diagnostics: inputCheck.diagnostics,
    };
  }
  if (orchestration.runtimeLock?.mode === "production" && !runtime.productionReady) {
    return {
      id: "synchronize_runtime",
      owner: "agent",
      state: "blocked",
      safeToAutoExecute: false,
      summary: "完成代码验证并同步 Codex/Claude 安装后再继续生产",
      diagnostics: runtime.diagnostics,
    };
  }
  if (
    orchestration.runtimeLock?.mode === "production"
    && (
      orchestration.runtimeLock?.sourceRef !== runtime.sourceRef
      || orchestration.runtimeLock?.bundleDigest !== runtime.bundleDigest
    )
  ) {
    return {
      id: "revalidate_runtime_change",
      owner: "agent",
      state: "blocked",
      safeToAutoExecute: false,
      summary: "运行版本已变化；重新验证合同并显式接受新运行版本后再继续",
      diagnostics: ["runtime_lock_changed"],
    };
  }
  if (orchestration.executionAuthorization?.status !== "authorized_local") {
    return {
      id: "confirm_local_execution",
      owner: "human",
      state: "awaiting_authorization",
      safeToAutoExecute: false,
      summary: "确认只在本地建立和执行剪辑项目；不包含上传、付费生成或发布",
    };
  }
  if (orchestration.task === "content_generation" && !orchestration.files?.manifest) {
    if (contentPackageReady(projectRoot)) {
      return {
        id: "review_content_package",
        owner: "human",
        state: "awaiting_content_review",
        safeToAutoExecute: false,
        summary: "审阅内容主线、待核事实、录制计划和素材缺口；通过后录制或回填源媒体",
        expectedOutputs: [
          "contracts/content-spine.json",
          "contracts/fact-check-tasks.json",
          "contracts/recording-plan.json",
          ".kacha/asset-inbox.json",
          "contracts/source-edit-handoff.json",
        ],
      };
    }
    return {
      id: "develop_content_package",
      owner: "agent",
      state: "content_planning",
      safeToAutoExecute: false,
      summary: "建立内容结构、事实核查任务、真人录制计划和 source_edit 交接",
      expectedOutputs: [
        "contracts/content-spine.json",
        "contracts/fact-check-tasks.json",
        "contracts/recording-plan.json",
        ".kacha/asset-inbox.json",
        "contracts/source-edit-handoff.json",
      ],
    };
  }
  if (!contractsReady(orchestration)) {
    return {
      id: "author_project_contracts",
      owner: "agent",
      state: "contract_authoring",
      safeToAutoExecute: false,
      summary: "根据 brief 和真实媒体证据完成 proposal、edit plan 与 V6 计划",
      packet: path.join(projectRoot, ".kacha", "packets", "planning.json"),
      expectedOutputs: [
        "contracts/edit-proposal.json",
        "contracts/edit-plan.json",
        "contracts/director-plan.json",
        "contracts/asset-gap-plan.json",
        "contracts/cover-identity-contract.json",
      ],
    };
  }
  const next = run(process.execPath, [
    path.join(scriptDirectory, "next_action.mjs"),
    orchestration.files.manifest,
  ]);
  if (next.stdout.trim()) {
    try {
      return JSON.parse(next.stdout).nextAction;
    } catch {
      // Fall through to the explicit failure below.
    }
  }
  return {
    id: "repair_project_state",
    owner: "agent",
    state: "blocked",
    safeToAutoExecute: false,
    summary: "修复无法解析的项目 next action",
    diagnostics: [(next.stderr || next.stdout).trim()],
  };
}

export function projectStatus(input, { refreshRuntime = true, home = os.homedir() } = {}) {
  const projectRoot = resolveProjectRoot(input);
  const { value: orchestration } = readOrchestration(projectRoot);
  const runtime = refreshRuntime ? inspectRuntime({ home }) : {
    sourceRef: orchestration.runtimeLock?.sourceRef,
    bundleDigest: orchestration.runtimeLock?.bundleDigest,
    sourceDirty: orchestration.runtimeLock?.sourceDirty,
    installStatus: orchestration.runtimeLock?.installStatus,
    productionReady: orchestration.runtimeLock?.mode === "development"
      || (
        orchestration.runtimeLock?.sourceDirty === false
        && orchestration.runtimeLock?.installStatus === "pass"
        && Boolean(orchestration.runtimeLock?.sourceRef)
      ),
    diagnostics: orchestration.runtimeDiagnostics ?? [],
  };
  const inputCheck = verifyInput(orchestration.input);
  const views = stageViews(projectRoot, orchestration);
  const derivedNextAction = deriveNextAction(projectRoot, orchestration, runtime, inputCheck);
  const assetInbox = orchestration.files?.assetInbox
    && fs.existsSync(orchestration.files.assetInbox)
    ? readJson(orchestration.files.assetInbox)
    : null;
  const efficiencyFile = orchestration.files?.efficiencyPlan
    ?? path.join(projectRoot, ".kacha", "efficiency-plan.json");
  const efficiencyLoad = fs.existsSync(efficiencyFile)
    ? readOptionalJsonEvidence(efficiencyFile, "efficiency plan")
    : { value: null, error: `efficiency plan is missing: ${efficiencyFile}` };
  const efficiencyPlan = efficiencyLoad.value;
  let efficiencyValidation = efficiencyLoad.error ? {
    status: "blocked",
    errors: [efficiencyLoad.error],
  } : null;
  let cacheAudit = null;
  if (efficiencyPlan) {
    try {
      efficiencyValidation = validateEfficiencyPlan(efficiencyPlan);
      cacheAudit = auditHighValueCache({
        projectRoot,
        applicableKinds: efficiencyPlan.cache?.applicableKinds ?? [],
        expectedEntries: efficiencyPlan.cache?.expectedEntries ?? [],
        writeReport: false,
        includeNonApplicableEntries: false,
      }).report;
    } catch (error) {
      efficiencyValidation = {
        status: "blocked",
        errors: [error.message],
      };
      cacheAudit = {
        status: "evidence_needed",
        productionReady: false,
        applicabilityStatus: efficiencyPlan.cache?.applicabilityStatus ?? "unknown",
        diagnostics: [error.message],
      };
    }
  }
  const nextAction = efficiencyValidation?.status === "blocked"
    ? {
        id: "refresh_efficiency_evidence",
        owner: "agent",
        state: "blocked",
        safeToAutoExecute: false,
        summary: "效率计划与当前项目证据不一致，刷新后才能继续执行",
        diagnostics: efficiencyValidation.errors,
      }
    : derivedNextAction;
  return {
    schemaVersion: "1.0",
    status: nextAction?.state === "blocked" ? "blocked" : "pass",
    projectId: orchestration.projectId,
    projectRoot,
    task: orchestration.task,
    lifecycle: orchestration.lifecycle,
    input: {
      type: orchestration.input?.type,
      path: orchestration.input?.path ?? null,
      identityStatus: inputCheck.status,
    },
    runtime: {
      locked: orchestration.runtimeLock,
      current: runtime,
    },
    intelligenceV6: orchestration.intelligenceV6,
    milestones: views.milestones,
    stages: views.stages,
    nextAction,
    files: orchestration.files,
    assetInbox: assetInbox ? {
      path: orchestration.files.assetInbox,
      kind: assetInbox.kind,
      summary: assetInbox.summary ?? {
        total: assetInbox.items?.length ?? 0,
        pending: (assetInbox.items ?? []).filter((item) => ![
          "resolved",
          "resolved_by_current_plan",
          "waived_with_reason",
        ].includes(item.status)).length,
        productionReady: (assetInbox.items ?? []).every((item) => [
          "resolved",
          "resolved_by_current_plan",
          "waived_with_reason",
        ].includes(item.status)),
      },
      nextAction: assetInbox.nextAction,
    } : null,
    efficiency: efficiencyPlan || efficiencyLoad.error ? {
      status: efficiencyValidation?.status ?? efficiencyPlan?.status ?? "blocked",
      validation: efficiencyValidation,
      policyVersion: efficiencyPlan?.policyVersion ?? null,
      mode: efficiencyPlan?.mode ?? null,
      risk: efficiencyPlan?.risk ?? null,
      representativePreview: efficiencyPlan?.representativePreview ?? null,
      schedule: efficiencyPlan?.schedule ?? null,
      cache: cacheAudit ?? {
        status: "evidence_needed",
        applicabilityStatus: efficiencyPlan?.cache?.applicabilityStatus ?? "unknown",
        productionReady: false,
      },
      evidenceBoundary: efficiencyPlan?.evidenceBoundary ?? null,
    } : null,
    authorityBoundary: orchestration.executionAuthorization,
  };
}

function writeOrchestration(file, value) {
  const stable = { ...value, updatedAt: now() };
  delete stable.digest;
  stable.digest = sha256Value({ ...stable, updatedAt: undefined });
  writeJsonAtomic(file, stable);
  return stable;
}

function ensurePlanningPacket(projectRoot, orchestration) {
  const output = path.join(projectRoot, ".kacha", "packets", "planning.json");
  const args = [
    path.join(scriptDirectory, "prepare_agent_packet.mjs"),
    "--task",
    orchestration.task,
    "--stage",
    "content",
    "--model-tier",
    "economy",
    "--output",
    output,
  ];
  if (orchestration.input?.path) args.push("--source", orchestration.input.path);
  const result = run(process.execPath, args, { cwd: projectRoot });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || "无法生成 planning packet");
  }
  return fileIdentity(output);
}

function contentText(input) {
  if (input.type === "topic") return input.value;
  if (input.type === "document") return fs.readFileSync(input.path, "utf8");
  throw new Error("内容策划输入必须是 topic 或 document");
}

function contentParagraphs(text) {
  return String(text)
    .replace(/^\s*#{1,6}\s+/gm, "")
    .split(/(?:\r?\n){2,}/)
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 80);
}

function ensureContentPackage(projectRoot, orchestration) {
  const contracts = path.join(projectRoot, "contracts");
  const text = contentText(orchestration.input);
  const paragraphs = contentParagraphs(text);
  const isTopicOnly = orchestration.input.type === "topic";
  const writeIfMissing = (file, value) => {
    if (!fs.existsSync(file)) writeJsonAtomic(file, value);
    return fileIdentity(file);
  };
  const sourceIdentity = orchestration.input.type === "document"
    ? fileIdentity(orchestration.input.path)
    : { type: "topic", value: orchestration.input.value, digest: orchestration.input.digest };
  const sections = (paragraphs.length ? paragraphs : [text]).map((paragraph, index) => ({
    id: `section-${String(index + 1).padStart(2, "0")}`,
    order: index + 1,
    sourceText: paragraph,
    narrativeRole: index === 0 ? "opening_promise"
      : index === (paragraphs.length || 1) - 1 ? "conclusion"
        : "development",
    status: isTopicOnly ? "needs_authoring" : "source_bound",
  }));
  const claims = sections.filter((section) => (
    /\d|研究|数据|报告|根据|调查|论文|实验|统计|增长|下降|百分|%|“|”/.test(section.sourceText)
  )).map((section, index) => ({
    id: `fact-${String(index + 1).padStart(2, "0")}`,
    sectionId: section.id,
    claim: section.sourceText,
    status: "pending_primary_source",
    evidence: [],
    publicationBoundary: "核查完成并绑定来源前，不得写成确定事实或进入正式录制稿。",
  }));
  const contentSpine = writeIfMissing(path.join(contracts, "content-spine.json"), {
    schemaVersion: "1.0",
    kind: "kacha-content-spine",
    projectId: orchestration.projectId,
    source: sourceIdentity,
    show: orchestration.show,
    thesis: isTopicOnly ? text.trim() : sections[0]?.sourceText ?? "",
    sections,
    status: isTopicOnly ? "needs_authoring" : "source_structured",
  });
  const factTasks = writeIfMissing(path.join(contracts, "fact-check-tasks.json"), {
    schemaVersion: "1.0",
    kind: "kacha-fact-check-tasks",
    projectId: orchestration.projectId,
    source: sourceIdentity,
    tasks: claims,
    summary: { total: claims.length, pending: claims.length, verified: 0 },
  });
  const recording = writeIfMissing(path.join(contracts, "recording-plan.json"), {
    schemaVersion: "1.0",
    kind: "kacha-recording-plan",
    projectId: orchestration.projectId,
    show: orchestration.show,
    openingRequired: true,
    segments: sections.map((section) => ({
      id: section.id,
      textRef: `content-spine.json#/${section.id}`,
      performanceIntent: section.narrativeRole,
      shot: indexForShot(section.order),
      requiredCoverage: ["clean_dialogue", section.order === 1 ? "opening_performance" : "continuity_handle"],
    })),
    captureRequirements: {
      handlesBeforeAfterSeconds: 1,
      cleanRoomToneSeconds: 20,
      identityReferenceRequired: true,
      notes: "画面、语音、音效和后续动效按同一内容节拍记录，不用视觉效果掩盖脚本问题。",
    },
  });
  const contentInbox = writeIfMissing(path.join(projectRoot, ".kacha", "asset-inbox.json"), {
    schemaVersion: "1.0",
    kind: "kacha-content-asset-inbox",
    projectId: orchestration.projectId,
    items: sections.map((section) => ({
      id: `asset-${section.id}`,
      sectionId: section.id,
      need: section.narrativeRole === "opening_promise" ? "开场真实动作或结果证据" : "支持当前论点的事实素材或说明性画面",
      evidenceClass: claims.some((claim) => claim.sectionId === section.id) ? "factual" : "illustrative",
      status: "unresolved",
    })),
    boundary: "事实素材必须有来源和许可；说明性生成素材不得冒充事实证据。",
  });
  const handoff = writeIfMissing(path.join(contracts, "source-edit-handoff.json"), {
    schemaVersion: "1.0",
    kind: "kacha-source-edit-handoff",
    projectId: orchestration.projectId,
    status: "awaiting_source_media",
    sourceMedia: null,
    intelligenceV6: { required: true },
    requiredInputs: ["recorded_or_generated_source_media", "approved_content_spine", "resolved_fact_checks", "asset_license_records"],
  });
  return { contentSpine, factTasks, recording, contentInbox, handoff };
}

function indexForShot(order) {
  if (order === 1) return "high_intent_opening_close_or_medium";
  return order % 3 === 0 ? "evidence_insert_or_demonstration" : "clean_medium_with_negative_space";
}

function contentPackageReady(projectRoot) {
  return [
    "content-spine.json",
    "fact-check-tasks.json",
    "recording-plan.json",
    "source-edit-handoff.json",
  ].every((name) => fs.existsSync(path.join(projectRoot, "contracts", name)))
    && fs.existsSync(path.join(projectRoot, ".kacha", "asset-inbox.json"));
}

function commandArgv(action) {
  return Array.isArray(action?.argv) && action.argv.every((item) => typeof item === "string")
    ? action.argv
    : null;
}

function instrumentedAction(projectRoot, action, argv) {
  const recipe = (readJson(recipeFile).stages ?? []).find((stage) => stage.id === action.id);
  const hostResources = (recipe?.resources ?? []).filter((resource) => (
    ["cpuHeavy", "mps", "videoEncode", "network", "ioHeavy"].includes(resource)
  ));
  const guardedCommand = hostResources.length > 0
    ? [
        process.execPath,
        path.join(scriptDirectory, "resource_scheduler.mjs"),
        "run",
        "--project-root", projectRoot,
        ...hostResources.flatMap((resource) => ["--resource", resource]),
        "--purpose", `orchestrator:${action.id}`,
        "--",
        ...argv,
      ]
    : argv;
  return [
    process.execPath,
    [
      path.join(scriptDirectory, "run_telemetry.mjs"),
      "run",
      "--stage", action.id,
      "--project-root", projectRoot,
      "--workflow", "first_edit",
      "--render-scope", action.owner === "render_engine" ? "range" : "none",
      "--qc-scope", action.id === "final_qc" ? "full" : "none",
      "--",
      ...guardedCommand,
    ],
  ];
}

function refreshEfficiencyEvidence(projectRoot, orchestration) {
  const previousPlan = readOptionalJsonEvidence(
    orchestration.files?.efficiencyPlan,
    "previous efficiency plan",
  ).value;
  const previousCache = readOptionalJsonEvidence(
    orchestration.files?.cacheAudit,
    "previous cache audit",
  ).value;
  const efficiency = buildEfficiencyPlan({
    projectRoot,
    outputPath: orchestration.files?.efficiencyPlan,
  });
  const cache = auditHighValueCache({
    projectRoot,
    applicableKinds: efficiency.plan.cache?.applicableKinds ?? [],
    expectedEntries: efficiency.plan.cache?.expectedEntries ?? [],
    outputPath: orchestration.files?.cacheAudit,
  });
  if (previousPlan?.digest !== efficiency.plan.digest || previousCache?.digest !== cache.report.digest) {
    appendEvent(projectRoot, {
      type: "efficiency_evidence_refreshed",
      plan: fileIdentity(efficiency.output),
      cache: fileIdentity(cache.output),
      speedImprovementClaimed: false,
    });
  }
  return { efficiency, cache };
}

export function runProject(input, {
  confirmExecute = false,
  acceptRuntimeUpdate = false,
  includeRender = false,
  resume = false,
  home = os.homedir(),
  maxAutomaticSteps = 8,
} = {}) {
  const projectRoot = resolveProjectRoot(input);
  const lock = path.join(projectRoot, ".kacha", "orchestrator.lock");
  const release = acquireFileLock(lock, { purpose: resume ? "kacha-resume" : "kacha-run" });
  try {
    const loaded = readOrchestration(projectRoot);
    let orchestration = loaded.value;
    if (confirmExecute && orchestration.executionAuthorization?.status !== "authorized_local") {
      orchestration.executionAuthorization = {
        ...orchestration.executionAuthorization,
        status: "authorized_local",
        grantedAt: now(),
      };
      orchestration.lifecycle = { ...orchestration.lifecycle, status: "planning" };
      orchestration = writeOrchestration(loaded.file, orchestration);
      appendEvent(projectRoot, { type: "local_execution_authorized" });
    }
    const runtime = inspectRuntime({ home });
    if (acceptRuntimeUpdate) {
      if (orchestration.runtimeLock?.mode === "production" && !runtime.productionReady) {
        throw new Error("当前运行版本尚未通过生产一致性门禁，不能接受版本更新");
      }
      orchestration.runtimeLock = {
        sourceRef: runtime.sourceRef,
        sourceDirty: runtime.sourceDirty,
        bundleDigest: runtime.bundleDigest,
        installStatus: runtime.installStatus,
        mode: orchestration.runtimeLock?.mode ?? "production",
        checkedAt: runtime.checkedAt,
      };
      if (orchestration.files?.manifest && fs.existsSync(orchestration.files.manifest)) {
        const manifest = readJson(orchestration.files.manifest);
        manifest.runtimeLock = orchestration.runtimeLock;
        writeJsonAtomic(orchestration.files.manifest, manifest);
      }
      appendEvent(projectRoot, {
        type: "runtime_lock_updated",
        sourceRef: runtime.sourceRef,
        bundleDigest: runtime.bundleDigest,
      });
      orchestration = writeOrchestration(loaded.file, orchestration);
    }
    const inputCheck = verifyInput(orchestration.input);
    const currentEfficiency = refreshEfficiencyEvidence(projectRoot, orchestration);
    if (currentEfficiency.efficiency.plan.status !== "pass") {
      throw new Error(
        `当前效率计划未通过：${currentEfficiency.efficiency.plan.validation?.errors?.join("; ")}`,
      );
    }
    if (
      orchestration.files?.manifest
      && contractsReady(orchestration)
      && !fs.existsSync(orchestration.files.assetInbox)
    ) {
      const inbox = buildAssetInbox(orchestration.files.manifest);
      appendEvent(projectRoot, { type: "asset_inbox_ready", path: inbox.path });
    }
    let action = deriveNextAction(projectRoot, orchestration, runtime, inputCheck);
    if (action.id === "author_project_contracts") {
      const packet = ensurePlanningPacket(projectRoot, orchestration);
      orchestration.latestAction = { id: action.id, at: now(), packet };
      orchestration.lifecycle = { ...orchestration.lifecycle, status: "planning" };
      writeOrchestration(loaded.file, orchestration);
      appendEvent(projectRoot, { type: "planning_packet_ready", packet });
      refreshEfficiencyEvidence(projectRoot, readOrchestration(projectRoot).value);
      action = { ...action, packet: packet.path, packetSha256: packet.sha256 };
      return { ...projectStatus(projectRoot, { home }), nextAction: action };
    }
    if (action.id === "develop_content_package") {
      const contentPackage = ensureContentPackage(projectRoot, orchestration);
      orchestration.latestAction = { id: action.id, at: now(), contentPackage };
      orchestration.lifecycle = { ...orchestration.lifecycle, status: "awaiting_content_review" };
      writeOrchestration(loaded.file, orchestration);
      appendEvent(projectRoot, { type: "content_package_ready", contentPackage });
      refreshEfficiencyEvidence(projectRoot, readOrchestration(projectRoot).value);
      return {
        ...projectStatus(projectRoot, { home }),
        contentPackage,
        nextAction: deriveNextAction(projectRoot, orchestration, runtime, inputCheck),
      };
    }
    const executed = [];
    for (let index = 0; index < maxAutomaticSteps; index += 1) {
      const argv = commandArgv(action);
      const automaticOwner = action?.owner === "agent"
        || (includeRender && action?.owner === "render_engine");
      if (!action?.safeToAutoExecute || !automaticOwner || !argv) break;
      const [command, commandArguments] = instrumentedAction(projectRoot, action, argv);
      const result = run(command, commandArguments, { cwd: projectRoot });
      const record = {
        id: action.id,
        owner: action.owner,
        status: result.status,
        argvDigest: sha256Value(argv),
        stdoutDigest: sha256Value(result.stdout),
        stderrDigest: sha256Value(result.stderr),
      };
      executed.push(record);
      appendEvent(projectRoot, { type: "automatic_action", ...record });
      if (result.status !== 0) {
        action = {
          id: "repair_failed_action",
          owner: "agent",
          state: "blocked",
          safeToAutoExecute: false,
          summary: `自动步骤 ${record.id} 失败，保留当前状态后修复`,
          diagnostics: [(result.stderr || result.stdout).trim()],
        };
        break;
      }
      action = deriveNextAction(projectRoot, orchestration, runtime, inputCheck);
    }
    orchestration.latestAction = { id: action?.id ?? null, at: now(), executed };
    orchestration.lifecycle = {
      ...orchestration.lifecycle,
      status: action?.state === "blocked" ? "blocked" : "in_progress",
      completionBoundary: action?.completionBoundary ?? null,
    };
    writeOrchestration(loaded.file, orchestration);
    refreshEfficiencyEvidence(projectRoot, readOrchestration(projectRoot).value);
    return { ...projectStatus(projectRoot, { home }), executed, nextAction: action };
  } finally {
    release();
  }
}

export function validateRecipeRegistry() {
  const registry = readJson(recipeFile);
  const errors = [];
  const requiredStages = [
    "inventory", "transcript_structure", "rough_cut", "dialogue_preprocess",
    "connection_qc", "fine_cut", "visual_packaging", "subtitles", "final_mix",
    "cover", "preview_render", "final_qc", "release_package",
  ];
  const stageIds = registry.stages?.map((stage) => stage.id) ?? [];
  if (registry.schemaVersion !== "1.0") errors.push("recipe schemaVersion 必须为 1.0");
  if (new Set(stageIds).size !== stageIds.length) errors.push("recipe stage id 重复");
  if (JSON.stringify(stageIds) !== JSON.stringify(requiredStages)) {
    errors.push("recipe stages 必须按 V2 十三阶段完整排序");
  }
  const milestoneStages = (registry.milestones ?? []).flatMap((item) => item.stages ?? []);
  if (JSON.stringify(milestoneStages) !== JSON.stringify(requiredStages)) {
    errors.push("四个用户里程碑必须且只能覆盖十三阶段一次");
  }
  for (const stage of registry.stages ?? []) {
    if (!stage.owner || !stage.execution || typeof stage.safeToAutoExecute !== "boolean") {
      errors.push(`阶段 ${stage.id} 缺少 owner/execution/safeToAutoExecute`);
    }
    if (!Array.isArray(stage.evidence) || stage.evidence.length === 0) {
      errors.push(`阶段 ${stage.id} 缺少 evidence`);
    }
    if (!Array.isArray(stage.prerequisites)) {
      errors.push(`阶段 ${stage.id} 缺少 prerequisites`);
    }
    if (!Array.isArray(stage.resources) || stage.resources.length === 0) {
      errors.push(`阶段 ${stage.id} 缺少 resources`);
    }
    if (typeof stage.parallelSafe !== "boolean") {
      errors.push(`阶段 ${stage.id} 缺少 parallelSafe`);
    }
    if (!Array.isArray(stage.outputGroups) || stage.outputGroups.length === 0) {
      errors.push(`阶段 ${stage.id} 缺少 outputGroups`);
    }
  }
  const schedule = buildSchedule(registry);
  errors.push(...schedule.errors);
  return {
    schemaVersion: "1.0",
    status: errors.length === 0 ? "pass" : "blocked",
    registry: fileIdentity(recipeFile),
    stages: stageIds.length,
    milestones: registry.milestones?.length ?? 0,
    schedule,
    errors,
  };
}
