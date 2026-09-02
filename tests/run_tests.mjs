#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireFileLock,
  fileIdentity,
  mediaIndexDigest,
  mediaSummary,
  readJson,
  run,
  sha256File,
  sha256Value,
} from "../scripts/kacha_utils.mjs";
import { resolveResourceDirectory } from "../scripts/resource_pool.mjs";
import {
  approveReleaseReview,
  initializeReleaseReview,
  openReleaseReview,
  recordReleaseCheck,
} from "../scripts/release_review.mjs";
import {
  attachAsset,
  buildAssetInbox,
  validateAssetInbox,
} from "../scripts/asset_inbox.mjs";
import { loadProductionPack } from "../scripts/production_pack.mjs";
import {
  framesToTicks,
  normalizeTimebase,
  ticksToFrames,
} from "../scripts/media_time.mjs";
import {
  applyEditorCommand,
  editorHistory,
  openEditorProject,
  recoverEditorProject,
  reopenEditorProject,
  redoEditorCommand,
  undoEditorCommand,
} from "../scripts/editor_command_journal.mjs";
import { buildTimelineProjection } from "../scripts/timeline_projection.mjs";
import { applyJsonOperations } from "../scripts/json_mutation.mjs";
import { listProjectBin, resolveIndexedAsset } from "../scripts/project_bin.mjs";
import { editorSessionExpired } from "../scripts/kacha_studio_server.mjs";
import {
  assertPreviewProviderEligibility,
  listPreviewProviders,
} from "../scripts/preview_provider.mjs";
import { professionalCapabilityMap } from "../scripts/professional_capabilities.mjs";
import {
  createEditorWorkspace,
  duplicateWorkspaceTimeline,
  loadEditorWorkspace,
} from "../scripts/editor_workspace.mjs";
import {
  createDeliveryPlan,
  createSelfContainedBundle,
  listDeliveryProfiles,
} from "../scripts/kacha_delivery.mjs";
import { exportNle, importNle } from "../scripts/kacha_nle.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.dirname(testDirectory);
const scripts = path.join(skillDirectory, "scripts");
const examples = path.join(skillDirectory, "examples");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-tests-"));
const isolatedConfigHome = path.join(temporary, "config-home");
process.env.KACHA_CONFIG_HOME = isolatedConfigHome;
const results = [];
const skipped = [];
const discovered = [];
const commandLine = process.argv.slice(2);

function option(name, fallback = null) {
  const index = commandLine.indexOf(name);
  return index >= 0 ? commandLine[index + 1] : fallback;
}

const requestedSuites = new Set(
  option("--suite", "all")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const nameMatch = option("--match", "");
const listOnly = commandLine.includes("--list");
const knownSuites = new Set([
  "all",
  "core",
  "proposal",
  "cleanup",
  "generated",
  "visual",
  "audio",
  "sfx",
  "qc",
  "incremental",
  "editor",
  "whiteboard",
]);
for (const suite of requestedSuites) {
  if (!knownSuites.has(suite)) {
    console.error(
      `未知测试套件：${suite}；可用值：${[...knownSuites].join(", ")}`,
    );
    process.exit(2);
  }
}

function inferSuite(name) {
  if (/editor|timebase|command journal|timeline projection|preview provider/i.test(name)) {
    return "editor";
  }
  if (/incremental|version delta|artifact index|project context/i.test(name)) {
    return "incremental";
  }
  if (/cleanup/i.test(name)) return "cleanup";
  if (/proposal/i.test(name)) return "proposal";
  if (/generated|generation|reference assets/i.test(name)) return "generated";
  if (/voice|audio|dialogue|loudness/i.test(name)) return "audio";
  if (/SFX|sound effect/i.test(name)) return "sfx";
  if (/technical QC|release gate|timing normalizer/i.test(name)) return "qc";
  if (
    /mask|beauty|text-behind|reframe|information card|visual design|cropped head|style profile|transition|opening|connection scanner|netstyle|semantic motion|parallel layout|visual breathing|caption layout|font routing|facefusion|effect template|resource catalog/i
      .test(name)
  ) {
    return "visual";
  }
  return "core";
}

function shouldRun(name, suite) {
  if (listOnly) return false;
  if (!requestedSuites.has("all") && !requestedSuites.has(suite)) return false;
  return !nameMatch || name.toLowerCase().includes(nameMatch.toLowerCase());
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function execute(command, args, expectedStatus = 0) {
  const result = run(command, args, { cwd: temporary });
  if (result.status !== expectedStatus) {
    throw new Error(
      `${command} ${args.join(" ")} expected ${expectedStatus}, got ${result.status}\n`
        + `${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function expectFailure(command, args) {
  const result = run(command, args, { cwd: temporary });
  if (result.status === 0) {
    throw new Error(`${command} ${args.join(" ")} unexpectedly passed`);
  }
  return result;
}

async function withDeterministicDesignFonts(callback) {
  const fontProbeBin = path.join(temporary, "deterministic-design-fonts");
  const fontProbe = path.join(fontProbeBin, "fc-list");
  fs.mkdirSync(fontProbeBin, { recursive: true });
  fs.writeFileSync(
    fontProbe,
    "#!/bin/sh\n"
      + "printf '%s\\n' "
      + "'青鸟华光标题黑体' 'JBHGBTH' "
      + "'方正粗金陵简体' 'FZJinLS-B-GB' "
      + "'思源黑体 CN Light' 'Source Han Sans CN Light' "
      + "'Aa封神榜书' 'AaFSBS'\n",
  );
  fs.chmodSync(fontProbe, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fontProbeBin}${path.delimiter}${previousPath ?? ""}`;
  try {
    return await callback();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

async function startMockFaceFusionServer(resultFile, token) {
  const child = spawn(
    process.execPath,
    [path.join(testDirectory, "fixtures", "mock_facefusion_server.mjs")],
    {
      env: {
        ...process.env,
        MOCK_FACEFUSION_RESULT_FILE: resultFile,
        MOCK_FACEFUSION_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`mock FaceFusion server timeout\n${stderr}`));
    }, 5000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock FaceFusion server exited ${code}\n${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(stdout.slice(0, newline)));
    });
  });
  return {
    child,
    endpoint: `http://127.0.0.1:${ready.port}`,
  };
}

function localDesignPreflight(name) {
  const artifactDirectory = path.join(temporary, "design-preflight", name);
  const artifact = path.join(artifactDirectory, "styleframe.svg");
  const manifestFile = path.join(artifactDirectory, "styleframe.manifest.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "design",
    "render",
    "--scene",
    "info_single",
    "--output",
    artifact,
    "--manifest",
    manifestFile,
    "--no-guides",
  ]);
  const manifest = readJson(manifestFile);
  const tokenRefs = [
    ...new Set(
      (manifest.components ?? []).flatMap(
        (component) => component.tokenRefs ?? [],
      ),
    ),
  ];
  return {
    designSystemId: "dahui-video-system",
    designSystemVersion: manifest.designSystemVersion,
    designDigest: manifest.designDigest,
    sceneId: "info_single",
    componentIds: ["info_card"],
    modeSelection: {
      show: "tool-share",
      aspectRatio: "landscape-16x9",
      language: "zh",
      surface: "footage",
      density: "standard",
    },
    status: "approved_for_implementation",
    artifactMode: "local_styleframe",
    artifactRef: artifact,
    artifactSha256: sha256File(artifact),
    implementationManifestRef: manifestFile,
    implementationManifestSha256: sha256File(manifestFile),
    layoutSpec: "已定义人物、字幕、品牌和模块安全区",
    motionSpec: "已定义进入、停稳和退出状态及缓动",
    soundSpec: "已定义声音功能、落点和相对人声音量",
    stateFrames: ["entry", "peak", "exit"],
    implementationHandoff: {
      resolvedFonts: manifest.resolvedFonts,
      fontResolutionDigest: sha256Value(manifest.resolvedFonts),
      tokenRefs,
      implementation: "按渲染清单、令牌和帧状态实施",
    },
    qcEvidence: ["手机尺寸样式帧", "进入/停稳/退出状态"],
  };
}

async function test(name, callback, explicitSuite = null) {
  const suite = explicitSuite ?? inferSuite(name);
  discovered.push({ name, suite });
  if (!shouldRun(name, suite)) {
    skipped.push({ name, suite });
    return;
  }
  try {
    await callback();
    results.push({ name, suite, status: "pass" });
    console.log(`PASS [${suite}] ${name}`);
  } catch (error) {
    results.push({ name, suite, status: "fail", error: error.message });
    console.error(`FAIL [${suite}] ${name}\n${error.message}`);
  }
}

// Pin a test to a CI matrix suite so shard membership no longer depends on
// name-based inference surviving a future rename.
async function testIn(suite, name, callback) {
  return test(name, callback, suite);
}

const sourceFile = path.join(temporary, "source-input.txt");
fs.writeFileSync(sourceFile, "immutable source fixture\n");
let validProposalFixture = null;
let visualCapabilityPlanFixture = null;

function ensureVisualCapabilityPlanFixture() {
  if (visualCapabilityPlanFixture) return visualCapabilityPlanFixture;
  visualCapabilityPlanFixture = path.join(temporary, "visual-capability-plan.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-capabilities",
    "template",
    "--duration",
    "100",
    "--output",
    visualCapabilityPlanFixture,
  ]);
  return visualCapabilityPlanFixture;
}

function ensureValidProposalFixture() {
  if (validProposalFixture) return validProposalFixture;
  const proposal = readJson(path.join(examples, "edit-proposal.json"));
  proposal.taskPath = "source_edit";
  proposal.authorization = {
    mode: "plan_then_execute",
    canExecute: true,
    externalUploadAllowed: false,
    paidGenerationAllowed: false,
    evidence: "test authorization",
  };
  proposal.sourceInventory = [{
    path: sourceFile,
    role: "test source",
    readOnly: true,
    probeEvidence: ["test probe"],
    existsVerified: true,
    probedAt: new Date().toISOString(),
    sha256: sha256File(sourceFile),
  }];
  proposal.creativeLock.sourceWidth = 2160;
  proposal.creativeLock.sourceHeight = 3840;
  proposal.creativeLock.outputWidth = 2160;
  proposal.creativeLock.outputHeight = 3840;
  proposal.approvedScope = [
    "local source edit and QC",
    "no upload",
    "no paid generation",
  ];
  validProposalFixture = path.join(temporary, "proposal-valid.json");
  writeJson(validProposalFixture, proposal);
  return validProposalFixture;
}

await test("reference router loads only task-relevant context", () => {
  const result = execute(process.execPath, [
    path.join(scripts, "route_references.mjs"),
    "--task", "local_optimization",
    "--modules", "audio,beauty,covers",
  ]);
  const report = JSON.parse(result.stdout);
  const files = new Set(report.files.map((item) => item.path));
  for (const required of [
    "SKILL.md",
    "references/incremental-workflow.md",
    "references/audio.md",
    "references/visuals-masks.md",
    "references/subtitles-covers-brand.md",
  ]) {
    if (!files.has(required)) throw new Error(`missing routed reference ${required}`);
  }
  if (
    files.has("references/project-workflow.md")
    || files.has("references/generated-media-assets.md")
  ) {
    throw new Error("local optimization loaded unrelated full-workflow context");
  }
  if (report.totals.approximateInputTokens <= report.totals.characters / 4) {
    throw new Error("multilingual token estimate still undercounts Chinese context");
  }
  const editRoute = JSON.parse(execute(process.execPath, [
    path.join(scripts, "route_references.mjs"),
    "--task", "source_edit",
  ]).stdout);
  if (editRoute.files.some((item) => item.path === "references/qc-release.md")) {
    throw new Error("source edit loaded release context before the release phase");
  }
  const releaseRoute = JSON.parse(execute(process.execPath, [
    path.join(scripts, "route_references.mjs"),
    "--task", "source_edit",
    "--release",
  ]).stdout);
  if (!releaseRoute.files.some((item) => item.path === "references/qc-release.md")) {
    throw new Error("release phase did not load qc-release reference");
  }
  const netstyleRoute = JSON.parse(execute(process.execPath, [
    path.join(scripts, "route_references.mjs"),
    "--task", "source_edit",
    "--modules", "netstyle",
  ]).stdout);
  if (
    !netstyleRoute.files.some(
      (item) => item.path === "references/z-en-editing-system.md",
    )
  ) {
    throw new Error("netstyle route did not load the editing-system reference");
  }
  const compactRoute = JSON.parse(execute(process.execPath, [
    path.join(scripts, "route_references.mjs"),
    "--task", "source_edit",
    "--stage", "edit",
    "--modules", "audio,beauty,covers,generated,netstyle,subtitles",
  ]).stdout);
  if (
    compactRoute.files.length !== 1
    || compactRoute.files[0].path !== "references/stages/edit.md"
    || compactRoute.totals.approximateInputTokens > 12_000
  ) {
    throw new Error("stage router did not produce a compact bounded execution contract");
  }
});

await testIn("generated", "cover workflow uses approved 3D turnaround as default generation anchor", () => {
  const reference = fs.readFileSync(
    path.join(skillDirectory, "references", "subtitles-covers-brand.md"),
    "utf8",
  );
  for (const required of [
    "获批 3D 三视图是默认且唯一的生成身份锚点",
    "生成后身份 QC",
    "T-pose 或展示站姿只作结构参考",
  ]) {
    if (!reference.includes(required)) throw new Error(`cover reference missing ${required}`);
  }
  const recipes = readJson(path.join(skillDirectory, "config", "workflow-recipes.json"));
  const cover = recipes.stages.find((stage) => stage.id === "cover");
  for (const required of [
    "approved 3D turnaround generation anchor",
    "real photo post-generation identity QC",
    "cover identity contract",
    "narrative pose adaptation evidence",
  ]) {
    if (!cover?.evidence?.includes(required)) throw new Error(`cover stage missing ${required}`);
  }
  if (
    cover.identityPolicy?.defaultGenerationInputMode !== "turnaround_only_real_photo_qc"
    || cover.identityPolicy?.generationIdentityPriority !== "approved 3D turnaround anchor"
    || cover.identityPolicy?.realPhotoRole !== "post_generation_identity_qc_only"
    || cover.identityPolicy?.realPhotoGenerationInputForbiddenByDefault !== true
    || cover.identityPolicy?.displayPoseForbidden !== true
    || cover.identityPolicy?.generatedActionFinalRequiresIdentityReview !== true
  ) throw new Error("cover identity policy is incomplete");
});

await test("cover identity contract forbids live-photo mixing and produces scene-specific 3D prompt", () => {
  const root = path.join(temporary, "cover-identity-contract");
  fs.mkdirSync(root, { recursive: true });
  const turnaround = path.join(root, "approved-3d-turnaround.png");
  const realPhoto = path.join(root, "real-photo-qc.jpg");
  fs.writeFileSync(turnaround, "approved 3d character identity");
  fs.writeFileSync(realPhoto, "real photo qc only");
  const contractFile = path.join(root, "contract.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "cover", "template",
    "--project-id", "cover-contract", "--turnaround", turnaround,
    "--real-photo", realPhoto, "--output", contractFile,
  ]);
  const contract = readJson(contractFile);
  Object.assign(contract.sceneAdaptation, {
    sceneSignal: "旅行安排过密",
    narrativeIntent: "用一个克制叫停动作表达不要把旅行项目化",
    bodyAction: "左手持手机，右手轻抬叫停",
    gaze: "从手机转向标题",
    expression: "成年人的无奈和自嘲",
    propInteraction: "拇指悬停在密集日程页面",
    weightShift: "上身微后撤，重心落在后腿",
    clothingAdaptation: "深藏蓝运动服增加轻量旅行夹克层次",
    clothingContinuity: "保留深藏蓝主色、黑框眼镜和短刺黑发",
  });
  writeJson(contractFile, contract);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "cover", "validate", "--contract", contractFile,
  ]);
  const prompt = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "cover", "prompt", "--contract", contractFile,
  ]).stdout).prompt;
  if (
    prompt.generationInputReferences.length !== 1
    || !prompt.generationPrompt.includes("只以获批的行者大灰 3D 三视图")
    || !prompt.negativePrompt.includes("不要使用真人照片作为生成输入")
  ) throw new Error("cover prompt did not preserve the approved 3D-only generation contract");
  contract.generationInputReferences.push(contract.realPhotoAnchor);
  writeJson(contractFile, contract);
  const failure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "cover", "validate", "--contract", contractFile,
  ]);
  if (!failure.stderr.includes("真人照片只能用于生成后身份 QC")) {
    throw new Error("cover contract allowed a real photo to enter generation inputs");
  }
});

await test("doctor and low-model packet expose deterministic execution", () => {
  const doctor = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "doctor",
    "--profile",
    "core",
  ]);
  const doctorReport = JSON.parse(doctor.stdout);
  if (!["pass", "pass_with_optional_gaps"].includes(doctorReport.status)) {
    throw new Error(`unexpected doctor status ${doctorReport.status}`);
  }
  const prepared = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "prepare",
    "--task",
    "local_optimization",
    "--modules",
    "beauty,low_model,visual_evidence",
    "--agent",
    "claude",
    "--model-tier",
    "economy",
  ]);
  const packet = JSON.parse(prepared.stdout);
  if (
    packet.stage !== "edit"
    || packet.readOrder.length !== 1
    || !packet.readOrder[0].endsWith("references/stages/edit.md")
    || packet.ruleRetrieval === null
    || packet.agentControlPlane?.primaryInterface !== "natural_language_chat"
    || packet.agentControlPlane?.mutationDelta !== "kacha.mjs delta apply"
  ) {
    throw new Error("economy packet did not default to the compact edit stage");
  }
  if (
    packet.modelTier !== "economy"
    || packet.contextBudget.withinBudget !== true
    || packet.contextBudget.approximateInputTokens > packet.contextBudget.limit
  ) {
    throw new Error("agent packet did not enforce the economy context budget");
  }
  if (packet.visualEvidencePolicy.required !== true) {
    throw new Error("Claude visual packet did not require local evidence");
  }
  const overBudget = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "prepare",
    "--task",
    "local_optimization",
    "--modules",
    "beauty,audio",
    "--agent",
    "claude",
    "--model-tier",
    "economy",
    "--max-reference-tokens",
    "1",
  ]);
  if (!overBudget.stderr.includes("KACHA-E140")) {
    throw new Error("over-budget packet did not fail closed");
  }
}, "core");

await test("resolved media runtime propagates to nested child processes", () => {
  const nested = run(process.execPath, [
    "-e",
    "const {spawnSync}=require('node:child_process');"
      + "const results=['ffmpeg','ffprobe'].map(command=>{"
      + "const value=spawnSync(command,['-version'],{encoding:'utf8'});"
      + "return {command,status:value.status,firstLine:String(value.stdout||'').split(/\\r?\\n/)[0]};"
      + "});console.log(JSON.stringify(results));"
      + "process.exit(results.every(item=>item.status===0)?0:1);",
  ], { cwd: temporary });
  if (nested.status !== 0) {
    throw new Error(`nested media runtime was not executable: ${nested.stderr}`);
  }
  const results = JSON.parse(nested.stdout);
  if (
    results.length !== 2
    || !results.every(
      (item) => item.status === 0 && item.firstLine.startsWith(`${item.command} version`),
    )
  ) {
    throw new Error("nested media runtime did not expose verified ffmpeg and ffprobe");
  }
}, "core");

await test("transcript windows keep long ASR text out of low-token packets", () => {
  const transcript = path.join(temporary, "long-transcript.json");
  const segments = Array.from({ length: 100 }, (_, index) => ({
    id: `segment-${String(index + 1).padStart(4, "0")}`,
    start: index * 6,
    end: (index + 1) * 6,
    text: `第${index + 1}段这是需要按窗口读取而不是全部进入提示词的口播内容。`,
    confidence: index < 25 ? "low" : "normal",
    reasons: index < 25 ? ["synthetic_low_confidence"] : [],
    words: [{
      start: index * 6,
      end: index * 6 + 0.5,
      word: "测试",
      probability: 0.9,
    }],
  }));
  writeJson(transcript, {
    schemaVersion: "1.0",
    status: "pass_with_review",
    language: "zh",
    durationSeconds: 600,
    text: segments.map((segment) => segment.text).join(""),
    segments,
  });
  const index = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "transcript",
    "index",
    transcript,
    "--window-seconds",
    "90",
  ]).stdout);
  const slice = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "transcript",
    "slice",
    transcript,
    "--start",
    "90",
    "--end",
    "180",
  ]).stdout);
  const packet = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "prepare",
    "--task",
    "local_optimization",
    "--model-tier",
    "economy",
    "--stage",
    "edit",
    "--transcript",
    transcript,
  ]).stdout);
  const windowPacket = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "prepare",
    "--task",
    "local_optimization",
    "--model-tier",
    "economy",
    "--stage",
    "edit",
    "--transcript",
    transcript,
    "--transcript-window",
    "90:180",
  ]).stdout);
  if (
    index.windows.length !== 7
    || index.textIncluded !== false
    || slice.segmentCount !== 15
    || slice.wordsIncluded !== false
    || packet.transcriptEvidence.semanticCues !== undefined
    || packet.transcriptEvidence.fullTextOmittedFromPacket !== true
    || packet.transcriptEvidence.lowConfidenceSegments.length !== 20
    || packet.transcriptEvidence.lowConfidenceOmittedCount !== 5
    || windowPacket.transcriptEvidence.selectedWindow.segmentCount !== 15
    || packet.packetBudget.withinBudget !== true
    || packet.packetBudget.approximateInputTokens > 16_000
  ) {
    throw new Error("long transcript was not bounded into explicit low-token windows");
  }
}, "core");

await test("ASR normalizes the selected audio stream before transcription", () => {
  const defaults = readJson(path.join(skillDirectory, "config", "defaults.json"));
  const source = fs.readFileSync(path.join(scripts, "transcribe_local.mjs"), "utf8");
  const asr = defaults.execution.asr;
  const requiredFragments = [
    '"-select_streams"',
    '"-map"',
    "`0:a:${audioStreamIndex}`",
    '"pcm_s16le"',
    '"local-whisper-mlx-v3-normalized-audio"',
    "audioPreparation",
    "normalizationSampleRate",
    "normalizationChannels",
    "workerConfigurationArguments",
  ];
  if (
    asr.audioStreamIndex !== 0
    || asr.normalizationSampleRate !== 16000
    || asr.normalizationChannels !== 1
    || asr.conditionOnPreviousText !== false
    || requiredFragments.some((fragment) => !source.includes(fragment))
  ) {
    throw new Error("ASR no longer freezes its selected normalized audio input");
  }
}, "audio");

await test("visual evidence prefers hardware decode with a software fallback", () => {
  const source = fs.readFileSync(
    path.join(scripts, "build_visual_evidence.mjs"),
    "utf8",
  );
  const requiredFragments = [
    '["-hwaccel", "videotoolbox"]',
    '"videotoolbox_then_software"',
    '"software_fallback"',
    "extractionArguments(preferredHardwareDecode)",
    "detectorArguments(preferredHardwareDecode)",
  ];
  if (requiredFragments.some((fragment) => !source.includes(fragment))) {
    throw new Error("visual evidence lost its accelerated decode fallback contract");
  }
}, "visual");

await test("timeline renderer prefers hardware decode with a software fallback", () => {
  const source = fs.readFileSync(path.join(scripts, "timeline_ir.mjs"), "utf8");
  const requiredFragments = [
    'command.push("-hwaccel", "videotoolbox")',
    'built.decoder === "videotoolbox"',
    'buildRenderCommand(graph, { hardwareDecode: false })',
    "decoderFallbackUsed",
    'command.push("-tag:v", "hvc1")',
    '"-movflags", "+faststart"',
  ];
  if (requiredFragments.some((fragment) => !source.includes(fragment))) {
    throw new Error("timeline renderer lost its accelerated decode fallback contract");
  }
}, "visual");

await test("deterministic rule engine gives weak models stable scored decisions", () => {
  const validation = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "rules",
    "validate",
  ]).stdout);
  if (validation.ruleCount < 18) {
    throw new Error("decision registry does not cover the required production rules");
  }
  const query = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "rules",
    "query",
    "--stage",
    "edit",
    "--modules",
    "cut,transition",
    "--signals",
    JSON.stringify(["information_change", "connection"]),
    "--limit",
    "5",
  ]).stdout);
  if (
    query.rules.length < 2
    || query.rules.some((rule) => rule.candidates.length > 3)
    || query.rules[0].priority !== "required"
  ) {
    throw new Error("rule retrieval did not return bounded, priority-scored candidates");
  }
  const first = path.join(temporary, "decision-plan-first.json");
  const second = path.join(temporary, "decision-plan-second.json");
  const compile = (output) => JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "rules",
    "compile",
    "--cues",
    path.join(examples, "semantic-cues.json"),
    "--output",
    output,
    "--model-tier",
    "economy",
    "--seed",
    "7",
  ]).stdout);
  const firstResult = compile(first);
  const secondResult = compile(second);
  const relocatedCues = path.join(temporary, "relocated-semantic-cues.json");
  const relocatedPlan = path.join(temporary, "relocated-decision-plan.json");
  fs.copyFileSync(path.join(examples, "semantic-cues.json"), relocatedCues);
  const relocatedResult = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "rules",
    "compile",
    "--cues",
    relocatedCues,
    "--output",
    relocatedPlan,
    "--model-tier",
    "economy",
    "--seed",
    "7",
  ]).stdout);
  const plan = readJson(first);
  if (
    firstResult.digest !== secondResult.digest
    || firstResult.digest !== relocatedResult.digest
    || plan.digest !== firstResult.digest
  ) {
    throw new Error(
      "same cue content/rules/config/seed did not produce the same decision digest",
    );
  }
  const expectedCuts = [true, true, true, false, true];
  const passedChecks = plan.decisions.filter(
    (decision, index) => decision.cut.apply === expectedCuts[index],
  ).length;
  if (passedChecks / expectedCuts.length < 0.95) {
    throw new Error("economy decision golden pass rate fell below 95%");
  }
  const cutScales = plan.decisions
    .filter((decision) => decision.cut.apply)
    .map((decision) => decision.cut.shotScale);
  if (cutScales.some((scale, index) => index > 0 && scale === cutScales[index - 1])) {
    throw new Error("deterministic decision plan repeated the same adjacent shot scale");
  }
  if (
    plan.quality.escalationCount !== 1
    || plan.decisions.find((decision) => decision.id === "uncertain-name")
      ?.execution.finalRenderAllowed !== false
  ) {
    throw new Error("weak-model uncertainty did not trigger preview/escalation");
  }
  const invalidCues = path.join(temporary, "invalid-semantic-cues.json");
  writeJson(invalidCues, {
    cues: [
      { id: "first", start: 0, end: 2, confidence: 0.9, signals: [] },
      { id: "overlap", start: 1.5, end: 3, confidence: "unknown", signals: [] },
    ],
  });
  const invalidCompile = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "rules",
    "compile",
    "--cues",
    invalidCues,
    "--output",
    path.join(temporary, "invalid-decision-plan.json"),
  ]);
  if (!/乱序|重叠|confidence/.test(invalidCompile.stderr)) {
    throw new Error("decision compiler accepted invalid weak-model cue timing");
  }
  const decisionSource = path.join(temporary, "decision-source.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=9",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    decisionSource,
  ]);
  const baseTimeline = path.join(temporary, "decision-base-timeline.json");
  writeJson(baseTimeline, {
    schemaVersion: "1.0",
    projectId: "decision-apply",
    mode: "final",
    source: { path: decisionSource, sha256: sha256File(decisionSource) },
    edl: [{ id: "full", sourceStart: 0, sourceEnd: 8.5 }],
    visual: { breathing: [], overlays: [] },
    audio: { sfx: [] },
    output: {
      path: path.join(temporary, "decision-final.mp4"),
      width: 160,
      height: 90,
      fps: 25,
    },
  });
  const blockedApply = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "rules",
    "apply",
    "--decision-plan",
    first,
    "--timeline",
    baseTimeline,
    "--output",
    path.join(temporary, "decision-final-timeline.json"),
  ]);
  if (!blockedApply.stderr.includes("升级项")) {
    throw new Error("final timeline accepted unresolved weak-model escalation");
  }
  const previewTimeline = path.join(temporary, "decision-preview-timeline.json");
  const previewVideo = path.join(temporary, "decision-preview.mp4");
  const applied = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "rules",
    "apply",
    "--decision-plan",
    first,
    "--timeline",
    baseTimeline,
    "--output",
    previewTimeline,
    "--preview-only",
    "--video-output",
    previewVideo,
  ]).stdout);
  const appliedTimeline = readJson(previewTimeline);
  if (
    applied.mode !== "preview"
    || applied.finalRenderAllowed !== false
    || appliedTimeline.edl.length !== 5
    || appliedTimeline.visual.breathing.length !== 3
    || appliedTimeline.decisionPlan.digest !== plan.digest
  ) {
    throw new Error("decision plan did not compile into a guarded executable Timeline IR");
  }
});

await test("configuration merges parameters, natural language and redacted credentials", async () => {
  fs.mkdirSync(isolatedConfigHome, { recursive: true });
  const userConfig = path.join(isolatedConfigHome, "config.json");
  writeJson(userConfig, {
    schemaVersion: "1.0",
    editingDefaults: {
      parameters: {
        subtitle: {
          singleLine: true,
          safeAreaBottomRatio: 0.16,
        },
      },
      instructions: [{
        id: "delivery-style",
        text: "保留自然强弱和幽默停顿。",
        appliesTo: ["source_edit", "local_optimization"],
        modules: [],
        priority: "normal",
      }],
      recipeParameters: {
        beauty: {
          profile: "natural",
          temporalConsistency: "required",
        },
      },
    },
  });
  const projectRoot = path.join(temporary, "config-case", "project");
  const nested = path.join(projectRoot, "versions", "v2");
  fs.mkdirSync(nested, { recursive: true });
  writeJson(path.join(projectRoot, "kacha.config.json"), {
    schemaVersion: "1.0",
    editingDefaults: {
      parameters: {
        subtitle: {
          safeAreaBottomRatio: 0.2,
        },
      },
      instructions: [{
        id: "delivery-style",
        text: "保留自然强弱、自嘲和幽默停顿。",
        appliesTo: ["local_optimization"],
        modules: ["beauty", "subtitles"],
        priority: "high",
      }, "补充画面必须匹配对象、动作和时态。"],
    },
    execution: {
      incremental: {
        handleFrames: 30,
      },
    },
  });
  const explicitConfig = path.join(temporary, "explicit-config.json");
  writeJson(explicitConfig, {
    schemaVersion: "1.0",
    execution: {
      incremental: {
        handleFrames: 36,
      },
    },
  });
  const secretsFile = path.join(isolatedConfigHome, "secrets.json");
  const fakeSecret = "unit-test-minimax-key-do-not-use";
  writeJson(secretsFile, {
    schemaVersion: "1.0",
    providers: {
      minimax: {
        apiKey: fakeSecret,
      },
    },
  });
  fs.chmodSync(secretsFile, 0o600);
  const shown = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "show",
    "--anchor",
    nested,
    "--config",
    explicitConfig,
  ]);
  if (shown.stdout.includes(fakeSecret)) {
    throw new Error("config show leaked a credential value");
  }
  const configApi = await import(
    `${pathToFileURL(path.join(scripts, "kacha_config.mjs")).href}?test=${Date.now()}`
  );
  const loaded = configApi.loadKachaConfig({
    args: ["--config", explicitConfig, "--secrets", secretsFile],
    anchorPath: nested,
    environment: {
      ...process.env,
      KACHA_CONFIG_HOME: isolatedConfigHome,
    },
  });
  const injected = configApi.providerEnvironment(loaded, "minimax", {});
  if (
    injected.environment.MINIMAX_API_KEY !== fakeSecret
    || JSON.stringify(loaded).includes(fakeSecret)
  ) {
    throw new Error("credential was not injected privately into the provider environment");
  }
  const report = JSON.parse(shown.stdout);
  if (
    report.config.execution.incremental.handleFrames !== 36
    || report.config.editingDefaults.parameters.subtitle.singleLine !== true
    || report.config.editingDefaults.parameters.subtitle.safeAreaBottomRatio !== 0.2
    || report.config.style.profile !== "xingzhe"
    || report.secrets.credentials.minimax.source !== "secrets_file"
  ) {
    throw new Error("configuration precedence or credential status is incorrect");
  }
  const instructions = report.config.editingDefaults.instructions;
  if (
    instructions.filter((item) => item.id === "delivery-style").length !== 1
    || !instructions.some((item) => item.text.includes("自嘲"))
    || !instructions.some((item) => item.text.includes("补充画面"))
  ) {
    throw new Error("natural-language defaults were not overridden and deduplicated");
  }
  const prepared = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "prepare",
    "--task",
    "local_optimization",
    "--modules",
    "beauty,subtitles",
    "--agent",
    "claude",
    "--model-tier",
    "economy",
    "--project",
    path.join(nested, "not-yet-created-project.json"),
    "--config",
    explicitConfig,
  ]).stdout);
  if (
    !prepared.configuration.editingDefaults.instructions
      .some((item) => item.text.includes("自嘲"))
    || !prepared.configuration.editingDefaults.authorityBoundary.includes("不构成上传")
  ) {
    throw new Error("agent packet did not receive safe applicable editing defaults");
  }
  const unsafeConfig = path.join(temporary, "unsafe-config.json");
  writeJson(unsafeConfig, {
    schemaVersion: "1.0",
    editingDefaults: {
      parameters: {
        paidGenerationAllowed: true,
      },
    },
  });
  const unsafe = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "validate",
    "--config",
    unsafeConfig,
    "--no-secrets",
  ]);
  if (!unsafe.stderr.includes("不能由默认配置设置")) {
    throw new Error("configuration accepted a per-project authorization override");
  }
  const weakenedExecutionConfig = path.join(
    temporary,
    "weakened-execution-config.json",
  );
  writeJson(weakenedExecutionConfig, {
    schemaVersion: "1.0",
    execution: {
      telemetry: {
        enabled: false,
      },
      artifactCache: {
        verifySha256: false,
      },
    },
  });
  const weakenedExecution = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "validate",
    "--config",
    weakenedExecutionConfig,
    "--no-secrets",
  ]);
  if (!weakenedExecution.stderr.includes("必须保持 true")) {
    throw new Error("configuration allowed telemetry or cache verification to be disabled");
  }
  const untrustedProjectRoot = path.join(temporary, "untrusted-config-project");
  fs.mkdirSync(untrustedProjectRoot, { recursive: true });
  const untrustedProjectConfig = path.join(
    untrustedProjectRoot,
    "kacha.config.json",
  );
  writeJson(untrustedProjectConfig, {
    schemaVersion: "1.0",
    providers: {
      minimax: {
        credentialEnv: "UNRELATED_PRIVATE_VALUE",
        region: "global",
        baseUrl: "https://example.invalid/collect",
      },
    },
  });
  const untrusted = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "validate",
    "--anchor",
    untrustedProjectRoot,
    "--no-secrets",
  ]);
  if (!untrusted.stderr.includes("不能设置 providers")) {
    throw new Error("auto-discovered project config could redirect provider credentials");
  }
  const stockFetcherUntrusted = run("python3", [
    path.join(scripts, "fetch_stock_media.py"),
    "--provider",
    "pixabay",
    "--kind",
    "photo",
    "--query",
    "test",
    "--output-dir",
    path.join(untrustedProjectRoot, "media"),
  ], {
    cwd: untrustedProjectRoot,
    env: {
      ...process.env,
      KACHA_CONFIG_HOME: isolatedConfigHome,
    },
  });
  if (
    stockFetcherUntrusted.status === 0
    || !stockFetcherUntrusted.stderr.includes("不能设置 providers")
  ) {
    throw new Error("stock fetcher did not enforce project-config trust boundary");
  }
  const explicitlyTrusted = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "validate",
    "--anchor",
    untrustedProjectRoot,
    "--config",
    untrustedProjectConfig,
    "--no-secrets",
  ]);
  if (JSON.parse(explicitlyTrusted.stdout).status !== "pass") {
    throw new Error("explicit config was not distinguished from auto-discovered config");
  }
  fs.chmodSync(secretsFile, 0o644);
  const insecure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "validate",
    "--anchor",
    nested,
  ]);
  if (!insecure.stderr.includes("chmod 600")) {
    throw new Error("insecure secrets permissions did not fail closed");
  }
  fs.rmSync(isolatedConfigHome, { recursive: true, force: true });
  const initializedHome = path.join(temporary, "initialized-config-home");
  const initialized = run(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "init",
    "--scope",
    "user",
  ], {
    cwd: temporary,
    env: {
      ...process.env,
      KACHA_CONFIG_HOME: initializedHome,
    },
  });
  if (initialized.status !== 0) {
    throw new Error(`user config initialization failed: ${initialized.stderr}`);
  }
  const initializedSecrets = path.join(initializedHome, "secrets.json");
  if (
    !fs.existsSync(path.join(initializedHome, "config.json"))
    || !fs.existsSync(initializedSecrets)
    || (fs.statSync(initializedSecrets).mode & 0o777) !== 0o600
  ) {
    throw new Error("user config initialization did not create a private secrets file");
  }
  const initializedAgain = run(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "init",
    "--scope",
    "user",
  ], {
    cwd: temporary,
    env: {
      ...process.env,
      KACHA_CONFIG_HOME: initializedHome,
    },
  });
  if (
    initializedAgain.status !== 0
    || JSON.parse(initializedAgain.stdout).status !== "unchanged"
  ) {
    throw new Error("user config initialization was not idempotent");
  }
}, "core");

await test("style profile and effect registries validate and render executable previews", () => {
  const validation = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "effects",
    "validate",
  ]).stdout);
  if (
    validation.style.id !== "xingzhe"
    || validation.registries.find((item) => item.kind === "transition")?.count < 8
    || validation.registries.find((item) => item.kind === "opening")?.count < 4
  ) {
    throw new Error("style profile or effect registry inventory is incomplete");
  }

  const transitionPreview = path.join(temporary, "transition-preview.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "effects",
    "preview",
    "--kind",
    "transition",
    "--id",
    "directional_smooth",
    "--direction",
    "left",
    "--width",
    "160",
    "--height",
    "90",
    "--fps",
    "8",
    "--duration",
    "0.25",
    "--output",
    transitionPreview,
  ]);
  const transitionMedia = mediaSummary(transitionPreview);
  if (transitionMedia.video?.codec_name !== "h264" || transitionMedia.width !== 160) {
    throw new Error("transition preview was not rendered as a real H.264 video");
  }

  const openingPreview = path.join(temporary, "opening-preview.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "effects",
    "preview",
    "--kind",
    "opening",
    "--id",
    "typewriter_command",
    "--title",
    "AI EDITS",
    "--width",
    "160",
    "--height",
    "90",
    "--fps",
    "8",
    "--frames",
    "8",
    "--output",
    openingPreview,
  ]);
  const openingMedia = mediaSummary(openingPreview);
  if (openingMedia.video?.codec_name !== "h264" || openingMedia.width !== 160) {
    throw new Error("opening preview was not rendered as a real H.264 video");
  }

  const projectStyle = path.join(temporary, "style-overrides-only.json");
  writeJson(projectStyle, {
    schemaVersion: "1.0",
    style: {
      overrides: {
        popups: {
          maxWidthRatio: 0.6,
        },
      },
    },
  });
  const styleReport = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "show",
    "--config",
    projectStyle,
    "--no-secrets",
  ]).stdout);
  if (
    styleReport.style.profile.id !== "xingzhe"
    || styleReport.style.profile.popups.maxWidthRatio !== 0.6
    || !styleReport.style.digest
  ) {
    throw new Error("style-only override did not inherit and resolve the default profile");
  }
}, "visual");

await test("video design system validates, resolves every mode and renders production artifacts", async () => {
  await withDeterministicDesignFonts(async () => {
  const validation = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "design",
    "validate",
  ]).stdout);
  if (
    validation.designSystem.id !== "dahui-video-system"
    || validation.designSystem.componentCount < 40
    || validation.designSystem.sceneCount < 50
    || validation.designSystem.rendererCount < 8
    || validation.designSystem.layoutCount < 30
    || validation.designSystem.motionCount < 70
    || !/^[a-f0-9]{64}$/.test(validation.designSystem.implementationDigest)
    || !/^[a-f0-9]{64}$/.test(validation.designSystem.rendererCodeSha256)
    || !validation.fontResolution?.digest
    || validation.designSystem.version !== "1.6.0"
  ) {
    throw new Error("video design system inventory is incomplete");
  }

  const portrait = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "design",
    "resolve",
    "--show",
    "very-ai",
    "--aspect",
    "portrait-9x16",
    "--language",
    "bilingual",
    "--surface",
    "light",
  ]).stdout);
  if (
    portrait.selectedModes.show !== "very-ai"
    || portrait.selectedModes.aspectRatio !== "portrait-9x16"
    || portrait.selectedModes.language !== "bilingual"
    || portrait.layout.canvasRatio !== 0.5625
    || !/^[a-f0-9]{64}$/.test(portrait.digest)
    || !/^[a-f0-9]{64}$/.test(portrait.implementationDigest)
  ) {
    throw new Error("video design system mode resolution is invalid");
  }

  const styleframe = path.join(temporary, "design-system-portrait.svg");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "design",
    "preview",
    "--scene",
    "process_progressive",
    "--aspect",
    "portrait-9x16",
    "--language",
    "bilingual",
    "--output",
    styleframe,
  ]);
  const svg = fs.readFileSync(styleframe, "utf8");
  if (
    !svg.includes("<svg")
    || !svg.includes('data-scene-id="process_progressive"')
    || !svg.includes('data-component-id="process_flow"')
  ) {
    throw new Error("video design system styleframe was not rendered");
  }
  const cachedStyleframe = path.join(temporary, "design-system-cached.svg");
  const cachedStyleframeManifest = `${cachedStyleframe}.manifest.json`;
  const cachedStyleframeArguments = [
    path.join(scripts, "kacha.mjs"),
    "styleframe",
    "render",
    "--scene",
    "process_progressive",
    "--aspect",
    "portrait-9x16",
    "--language",
    "bilingual",
    "--output",
    cachedStyleframe,
    "--project-root",
    temporary,
    "--no-guides",
  ];
  const cachedStyleframeMiss = JSON.parse(
    execute(process.execPath, cachedStyleframeArguments).stdout,
  );
  fs.unlinkSync(cachedStyleframe);
  fs.unlinkSync(cachedStyleframeManifest);
  const cachedStyleframeHit = JSON.parse(
    execute(process.execPath, cachedStyleframeArguments).stdout,
  );
  if (
    cachedStyleframeMiss.cache?.status !== "miss"
    || cachedStyleframeHit.cache?.status !== "hit"
    || !fs.existsSync(cachedStyleframe)
    || !fs.existsSync(cachedStyleframeManifest)
  ) {
    throw new Error("video design styleframe did not use content-addressed reuse");
  }

  const matrixReportFile = path.join(temporary, "design-system-matrix-qc.json");
  const matrix = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "design",
    "qc",
    "--matrix",
    "--output",
    matrixReportFile,
  ]).stdout);
  if (
    matrix.status !== "pass"
    || matrix.profileCount < 14
    || matrix.totalComponentRenders < 2000
    || matrix.totalSceneRenders < 2500
    || !/^[a-f0-9]{64}$/.test(matrix.implementationDigest)
    || matrix.profiles.some((profile) => profile.contrastStatus !== "pass")
  ) {
    throw new Error("video design system matrix QC did not cover every mode and state");
  }

  const subtitle = path.join(temporary, "design-system-subtitle.ass");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "design",
    "render",
    "--kind",
    "component",
    "--id",
    "subtitle_bilingual",
    "--language",
    "bilingual",
    "--output",
    subtitle,
  ]);
  const ass = fs.readFileSync(subtitle, "utf8");
  if (!ass.includes("KachaPrimary") || !ass.includes("\\N")) {
    throw new Error("bilingual subtitle renderer did not emit an ASS implementation");
  }

  const designApi = await import(
    `${pathToFileURL(path.join(scripts, "design_system.mjs")).href}?test=${Date.now()}`
  );
  const bundle = designApi.loadDesignSystem();
  if (
    bundle.capabilityRegistries?.antiWeb?.id !== "xingzhe-cinematic-editorial"
    || bundle.capabilityRegistries?.antiWeb?.version !== "3.0.0"
    || bundle.scenes.scenes.some((scene) => scene.layout === "subject_left_card_right")
    || bundle.scenes.scenes.some((scene) => (
      /card|popup/.test(scene.components.join("_")) && scene.entry === "soft_pop"
    ))
  ) {
    throw new Error("行者风 3.0 反网页合同没有进入当前设计系统");
  }
  const fakeRenderer = JSON.parse(JSON.stringify(bundle));
  fakeRenderer.components.components[0].renderer = "fake-renderer";
  if (
    !designApi.validateDesignSystem(fakeRenderer)
      .some((error) => error.includes("renderer 未注册"))
  ) {
    throw new Error("design validation accepted an unregistered renderer");
  }
  const fallbackCycle = JSON.parse(JSON.stringify(bundle));
  const first = fallbackCycle.components.components[0];
  const second = fallbackCycle.components.components[1];
  first.fallback = second.id;
  second.fallback = first.id;
  if (
    !designApi.validateDesignSystem(fallbackCycle)
      .some((error) => error.includes("fallback 存在循环"))
  ) {
    throw new Error("design validation accepted a fallback cycle");
  }

  if (process.platform === "darwin") {
    const fontProbeBin = path.join(temporary, "font-probe-bin");
    const profiler = path.join(fontProbeBin, "system_profiler");
    fs.mkdirSync(fontProbeBin, { recursive: true });
    fs.writeFileSync(
      profiler,
      "#!/bin/sh\n"
        + "printf '%s\\n' "
        + "'{\"SPFontsDataType\":[{\"_name\":\"华光标题黑\"},"
        + "{\"_name\":\"方正粗金陵简体\"},{\"_name\":\"FZJinLS-B-GB\"},"
        + "{\"_name\":\"Avenir Next\"}]}'\n",
    );
    fs.chmodSync(profiler, 0o755);
    const fallbackProbe = run(process.execPath, [
      path.join(scripts, "kacha.mjs"),
      "design",
      "validate",
    ], {
      cwd: temporary,
      env: { ...process.env, PATH: fontProbeBin },
    });
    if (fallbackProbe.status !== 0) {
      throw new Error(`macOS font fallback probe failed:\n${fallbackProbe.stderr}`);
    }
    const fallbackReport = JSON.parse(fallbackProbe.stdout);
    if (
      fallbackReport.fontResolution.probe !== "system_profiler"
      || fallbackReport.fontResolution.warnings.length > 0
      || Object.values(fallbackReport.fontResolution.roles)
        .some((role) => role.verified !== true)
    ) {
      throw new Error("macOS font fallback did not resolve every design role");
    }
  }
  });
}, "visual");

await test("visual design normal-speed preview renders seekable motion evidence", async () => {
  await withDeterministicDesignFonts(async () => {
    const motionDirectory = path.join(temporary, "design-motion-preview");
    const report = JSON.parse(execute(process.execPath, [
      path.join(scripts, "kacha.mjs"),
      "design",
      "motion-preview",
      "--output",
      motionDirectory,
      "--scenes",
      "info_single",
      "--overwrite",
    ]).stdout);
    const manifest = readJson(path.join(motionDirectory, "manifest.json"));
    const preview = manifest.previews?.[0];
    if (
      report.status !== "pass"
      || manifest.previewCount !== 1
      || preview?.sceneId !== "info_single"
      || preview?.fps !== 25
      || preview?.durationSeconds < 3
      || !/^[a-f0-9]{64}$/.test(preview?.sha256 ?? "")
      || !fs.existsSync(path.join(motionDirectory, preview?.file ?? "missing"))
      || manifest.reviewContract?.normalSpeedRequired !== true
    ) {
      throw new Error("正常速度动态样片没有形成可复核证据");
    }
  });
}, "visual");

await test("beauty v2 is local, scoped, bounded and disabled by default", async () => {
  const report = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "show",
    "--no-secrets",
  ]).stdout);
  const beauty = report.config.editingDefaults.parameters.beauty;
  if (
    beauty.enabled !== false
    || beauty.engine !== "beauty-v2"
    || beauty.profile !== "natural"
  ) {
    throw new Error("Beauty v2 defaults are not disabled and explicit");
  }
  const beautyConfig = readJson(
    path.join(skillDirectory, "config", "beauty-v2.json"),
  );
  const beautyValidation = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "beauty",
    "validate",
  ]).stdout);
  const expectedScope = [
    "skin_smoothing",
    "whitening",
    "tone_evening",
    "nasolabial_softening",
  ];
  if (
    beautyConfig.defaultEnabled !== false
    || beautyValidation.defaultEnabled !== false
    || !/^[a-f0-9]{64}$/.test(beautyValidation.implementation?.digest)
    || beautyValidation.implementation?.files?.length < 7
    || JSON.stringify(beautyConfig.scope) !== JSON.stringify(expectedScope)
    || beautyConfig.hardLimits.forbidFaceGeometryChange !== true
    || beautyConfig.hardLimits.forbidCloudProcessing !== true
    || beautyConfig.qc.minimumPrimaryFaceCoverage < 0.97
    || beautyConfig.qc.minimumLandmarkCoverage < 0.97
    || Object.values(beautyConfig.profiles)
      .some((profile) => (
        profile.skin.maskTemporalFrames !== 1
        || profile.nasolabial.maskTemporalFrames !== 1
      ))
  ) {
    throw new Error("Beauty v2 scope or safety limits drifted");
  }

  const unsafeBeauty = path.join(temporary, "unsafe-beauty-config.json");
  writeJson(unsafeBeauty, {
    schemaVersion: "1.0",
    editingDefaults: {
      parameters: {
        beauty: {
          enabled: "yes",
          engine: "GPUPixel",
          profile: "extreme",
        },
      },
    },
  });
  const unsafeTuning = path.join(temporary, "unsafe-beauty-tuning.json");
  writeJson(unsafeTuning, {
    schemaVersion: "1.0",
    editingDefaults: {
      parameters: {
        beauty: {
          enabled: true,
          engine: "beauty-v2",
          profile: "natural",
          tuning: {
            smoothing: 101,
            whitening: 22,
            toneEvening: 30,
            nasolabialSoftening: 24,
          },
        },
      },
    },
  });
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "validate",
    "--config",
    unsafeTuning,
    "--no-secrets",
  ]);
  const beautyApi = await import(
    `${pathToFileURL(path.join(scripts, "beauty_v2.mjs")).href}?test=${Date.now()}`
  );
  const tampered = JSON.parse(JSON.stringify(beautyConfig));
  tampered.hardLimits.maximumTemporalMaskFrames = 99;
  tampered.profiles.visible.skin.brightness = 0.5;
  tampered.profiles.extreme = tampered.profiles.visible;
  const errors = beautyApi.validateBeautyV2(tampered);
  if (
    !errors.some((error) => error.includes("maximumTemporalMaskFrames"))
    || !errors.some((error) => error.includes("brightness"))
    || !errors.some((error) => error.includes("extreme"))
  ) {
    throw new Error("Beauty v2 accepted parameters outside immutable safety limits");
  }

  const tuned = beautyApi.resolveBeautyV2Parameters(
    beautyConfig,
    "natural",
    {
      smoothing: 35,
      whitening: 22,
      toneEvening: 30,
      nasolabialSoftening: 24,
    },
  );
  if (
    !/^[a-f0-9]{64}$/.test(tuned.digest)
    || tuned.resolved.skin.smoothingSigmaR
      >= beautyConfig.profiles.natural.skin.smoothingSigmaR
    || tuned.resolved.skin.brightness
      >= beautyConfig.profiles.natural.skin.brightness
    || tuned.resolved.nasolabial.smoothingSigmaR
      >= beautyConfig.profiles.natural.nasolabial.smoothingSigmaR
  ) {
    throw new Error("Beauty v2 tuning did not resolve into bounded local parameters");
  }
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "validate",
    "--config",
    unsafeBeauty,
    "--no-secrets",
  ]);
}, "visual");

await test("Beauty v2 Vision generator typechecks and can verify a real-face fixture", () => {
  const generator = path.join(scripts, "generate_vision_masks.swift");
  const source = fs.readFileSync(generator, "utf8");
  for (const contract of [
    "primaryTrackingStatus",
    "beautyMaskApplied",
    "ambiguousFrameRatio",
    "previousPrimaryBox",
    "isPrimary",
  ]) {
    if (!source.includes(contract)) {
      throw new Error(`Vision generator is missing ${contract}`);
    }
  }
  if (process.platform === "darwin") {
    execute("swiftc", ["-typecheck", generator]);
    const visionMaskSource = path.join(temporary, "vision-mask-source.mp4");
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1",
      "-an", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", visionMaskSource,
    ]);
    const cachedMasks = path.join(temporary, "cached-vision-masks");
    const maskArguments = [
      path.join(scripts, "kacha.mjs"),
      "masks",
      visionMaskSource,
      "--output-dir",
      cachedMasks,
      "--sample-fps",
      "1",
      "--quality",
      "fast",
      "--project-root",
      temporary,
    ];
    const maskMiss = JSON.parse(execute(process.execPath, maskArguments).stdout);
    fs.rmSync(cachedMasks, { recursive: true, force: true });
    const maskHit = JSON.parse(execute(process.execPath, maskArguments).stdout);
    if (
      maskMiss.cache?.status !== "miss"
      || maskHit.cache?.status !== "hit"
      || !fs.existsSync(path.join(cachedMasks, "manifest.json"))
    ) {
      throw new Error("Vision masks wrapper did not reuse its content-addressed output");
    }
  }
  const realFixture = process.env.KACHA_REAL_FACE_FIXTURE;
  if (!realFixture) return;
  if (!fs.existsSync(realFixture)) {
    throw new Error(`KACHA_REAL_FACE_FIXTURE not found: ${realFixture}`);
  }
  const summary = mediaSummary(realFixture);
  const masks = path.join(temporary, "beauty-v2-real-face-masks");
  execute(generator, [
    realFixture,
    masks,
    String(summary.fps),
    "accurate",
  ]);
  const manifest = readJson(path.join(masks, "manifest.json"));
  if (
    manifest.tracking.primaryFaceCoverage < 0.97
    || manifest.tracking.landmarkCoverage < 0.97
    || manifest.tracking.ambiguousFrameRatio > 0.02
    || manifest.frames.some((frame) => frame.beautyMaskApplied !== true)
  ) {
    throw new Error("real-face Beauty v2 tracking fixture failed its coverage gate");
  }
}, "visual");

await test("connection scanner finds edit joins and emits review handles", () => {
  const first = path.join(temporary, "connection-first.mp4");
  const second = path.join(temporary, "connection-second.mp4");
  const joined = path.join(temporary, "connection-joined.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x8A4B2A:s=160x90:r=12:d=1",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", first,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0xF4D58D:s=160x90:r=12:d=1",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", second,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", first, "-i", second,
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-an", "-c:v", "libx264", "-y", joined,
  ]);
  const output = path.join(temporary, "connection-candidates.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "connections",
    joined,
    "--output",
    output,
    "--threshold",
    "0.2",
  ]);
  const report = readJson(output);
  if (
    report.count < 1
    || report.candidates[0].sources.includes("ffmpeg_scene_score") !== true
    || !["videotoolbox", "software"].includes(report.detection.decoder)
    || !(report.candidates[0].handleEndSeconds > report.candidates[0].handleStartSeconds)
    || report.candidates[0].reviewRequired !== true
  ) {
    throw new Error("connection scanner did not produce an auditable join candidate");
  }
}, "visual");

await testIn("proposal", "proposal executable source, hash and authorization pass", () => {
  execute(process.execPath, [
    path.join(scripts, "validate_edit_proposal.mjs"),
    ensureValidProposalFixture(),
  ]);
});

await testIn("proposal", "proposal rejects invalid stage status", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.executionFlow[0].status = "banana";
  const file = path.join(temporary, "proposal-bad-status.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await testIn("proposal", "proposal passed stages require current file-backed evidence", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.executionFlow[0] = {
    ...proposal.executionFlow[0],
    status: "passed",
    evidence: "claimed without a file",
  };
  const file = path.join(temporary, "proposal-fabricated-stage-evidence.json");
  writeJson(file, proposal);
  const failed = expectFailure(process.execPath, [
    path.join(scripts, "validate_edit_proposal.mjs"),
    file,
  ]);
  if (!failed.stderr.includes("{path, sha256}")) {
    throw new Error("proposal validator did not require file-backed stage evidence");
  }
});

await testIn("proposal", "proposal rejects task and authorization mismatch", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.taskPath = "proposal_review";
  const file = path.join(temporary, "proposal-bad-auth.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await testIn("proposal", "proposal rejects missing executable source", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.sourceInventory[0].path = path.join(temporary, "missing.mov");
  const file = path.join(temporary, "proposal-missing-source.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await testIn("proposal", "proposal rejects an output ratio outside the creative lock", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.creativeLock.outputAspectRatio = "16:9";
  const file = path.join(temporary, "proposal-bad-creative-lock.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await testIn("proposal", "proposal rejects unrequested source geometry changes", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.creativeLock.outputWidth = 1080;
  proposal.creativeLock.outputHeight = 1920;
  const file = path.join(temporary, "proposal-unrequested-geometry-change.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await testIn("proposal", "proposal accepts an explicitly authorized geometry change", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.goal.videoAspectRatios = ["16:9"];
  proposal.creativeLock.outputGeometryUserSpecified = true;
  proposal.creativeLock.preserveSourceDimensions = false;
  proposal.creativeLock.preserveSourceAspectRatio = false;
  proposal.creativeLock.outputWidth = 3840;
  proposal.creativeLock.outputHeight = 2160;
  proposal.creativeLock.outputAspectRatio = "16:9";
  proposal.creativeLock.outputGeometryAuthorizationEvidence =
    "test user explicitly requested 3840x2160 16:9";
  const file = path.join(temporary, "proposal-authorized-geometry-change.json");
  writeJson(file, proposal);
  execute(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await testIn("proposal", "proposal rejects spoken-word processing without source separation", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.planModules.dialogueAudio.sourceSeparation.required = false;
  proposal.planModules.dialogueAudio.sourceSeparation.mixResidualIntoFinal = true;
  const file = path.join(temporary, "proposal-no-dialogue-separation.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await testIn("proposal", "proposal rejects a detected series missing the video mark", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.seriesIdentity.videoMark.enabled = false;
  const file = path.join(temporary, "proposal-series-video-mark-missing.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await testIn("proposal", "proposal rejects an undetermined series identity before execution", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.seriesIdentity.status = "undetermined";
  proposal.seriesIdentity.videoMark.enabled = false;
  proposal.seriesIdentity.coverMark.enabled = false;
  const file = path.join(temporary, "proposal-series-undetermined.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await testIn("cleanup", "routine cleanup dry-run keeps fast regenerable cache", () => {
  const root = path.join(temporary, "cleanup-routine");
  const cache = path.join(root, "work", "render-scratch");
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.join(root, "source"), { recursive: true });
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  fs.writeFileSync(path.join(cache, "chunk.bin"), "temporary render chunk");
  fs.writeFileSync(path.join(root, "source", "original.mov"), "protected source");
  fs.writeFileSync(path.join(root, "output", "final.mov"), "protected final");
  const plan = {
    schemaVersion: "1.0",
    projectRoot: root,
    mode: "routine",
    authorization: {
      routineCleanupAllowed: true,
      finalCleanupConfirmed: false,
      noFurtherEdits: false,
      evidence: "test routine cleanup",
      confirmedAt: "not_applicable",
    },
    protectedPaths: ["source", "output/final.mov"],
    candidates: [{
      path: "work/render-scratch",
      category: "render_scratch",
      reproducible: true,
      requiredForIteration: false,
      userNeeds: false,
      regeneration: {
        verified: true,
        speed: "fast",
        estimatedSeconds: 10,
        method: "rerender test chunk",
      },
      finalDispositionApproved: false,
      reason: "test cache is fast to rebuild",
    }],
    reportPath: "qc/cleanup-report.json",
  };
  const file = path.join(temporary, "cleanup-routine.json");
  writeJson(file, plan);
  execute(process.execPath, [path.join(scripts, "cleanup_project.mjs"), file]);
  if (!fs.existsSync(cache)) throw new Error("dry-run unexpectedly deleted cache");
  const report = readJson(path.join(root, "qc", "cleanup-report.json"));
  if (report.status !== "dry_run" || report.totals.bytesPlanned <= 0) {
    throw new Error("dry-run report is incomplete");
  }
});

await testIn("cleanup", "routine cleanup applies only the approved cache list", () => {
  const root = path.join(temporary, "cleanup-routine");
  const planFile = path.join(temporary, "cleanup-routine.json");
  execute(process.execPath, [
    path.join(scripts, "cleanup_project.mjs"),
    planFile,
    "--apply",
  ]);
  if (fs.existsSync(path.join(root, "work", "render-scratch"))) {
    throw new Error("approved cache still exists after cleanup");
  }
  for (const protectedPath of [
    path.join(root, "source", "original.mov"),
    path.join(root, "output", "final.mov"),
  ]) {
    if (!fs.existsSync(protectedPath)) {
      throw new Error(`protected path was removed: ${protectedPath}`);
    }
  }
});

await testIn("cleanup", "routine cleanup rejects user-needed or slow-to-regenerate cache", () => {
  const root = path.join(temporary, "cleanup-routine-rejected");
  fs.mkdirSync(path.join(root, "work", "mask-cache"), { recursive: true });
  const plan = {
    schemaVersion: "1.0",
    projectRoot: root,
    mode: "routine",
    authorization: {
      routineCleanupAllowed: true,
      finalCleanupConfirmed: false,
      noFurtherEdits: false,
      evidence: "test rejection",
      confirmedAt: "not_applicable",
    },
    protectedPaths: ["protected"],
    candidates: [{
      path: "work/mask-cache",
      category: "cache",
      reproducible: true,
      requiredForIteration: false,
      userNeeds: true,
      regeneration: {
        verified: true,
        speed: "slow",
        estimatedSeconds: 3600,
        method: "rerun expensive mask generation",
      },
      finalDispositionApproved: false,
      reason: "must be retained",
    }],
    reportPath: "qc/cleanup-report.json",
  };
  const file = path.join(temporary, "cleanup-routine-rejected.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "cleanup_project.mjs"), file, "--apply"]);
  if (!fs.existsSync(path.join(root, "work", "mask-cache"))) {
    throw new Error("rejected cache was deleted");
  }
});

await testIn("cleanup", "final cleanup requires explicit no-more-edits confirmation", () => {
  const root = path.join(temporary, "cleanup-final");
  fs.mkdirSync(path.join(root, "work", "proxy"), { recursive: true });
  fs.writeFileSync(path.join(root, "work", "proxy", "proxy.mov"), "proxy");
  const plan = {
    schemaVersion: "1.0",
    projectRoot: root,
    mode: "final",
    authorization: {
      routineCleanupAllowed: true,
      finalCleanupConfirmed: false,
      noFurtherEdits: false,
      evidence: "",
      confirmedAt: "",
    },
    protectedPaths: ["output/final.mov"],
    candidates: [{
      path: "work/proxy",
      category: "proxy",
      reproducible: true,
      requiredForIteration: true,
      userNeeds: false,
      regeneration: {
        verified: true,
        speed: "slow",
        estimatedSeconds: 900,
        method: "regenerate proxy from protected source",
      },
      finalDispositionApproved: true,
      reason: "final-only heavy intermediate",
    }],
    reportPath: "qc/cleanup-report.json",
  };
  const file = path.join(temporary, "cleanup-final.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "cleanup_project.mjs"), file, "--apply"]);
  plan.authorization.finalCleanupConfirmed = true;
  plan.authorization.noFurtherEdits = true;
  plan.authorization.evidence = "user explicitly confirmed project completion";
  plan.authorization.confirmedAt = new Date().toISOString();
  writeJson(file, plan);
  execute(process.execPath, [path.join(scripts, "cleanup_project.mjs"), file, "--apply"]);
  if (fs.existsSync(path.join(root, "work", "proxy"))) {
    throw new Error("final-only proxy still exists after confirmed cleanup");
  }
});

await test("edit plan allows same scale for a different subject", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.cuts[0].shotScaleAfter = "medium";
  plan.cuts[0].subjectAfter = "guest";
  const file = path.join(temporary, "edit-plan-different-subject.json");
  writeJson(file, plan);
  execute(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
});

await test("edit plan rejects same scale for the same subject", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.cuts[0].shotScaleAfter = "medium";
  const file = path.join(temporary, "edit-plan-same-subject.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
});

await test("edit plan rejects reversed timecode without timeSeconds", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  delete plan.cuts[0].timeSeconds;
  delete plan.cuts[1].timeSeconds;
  plan.cuts[0].timecode = "00:00:20.000";
  plan.cuts[1].timecode = "00:00:10.000";
  const file = path.join(temporary, "edit-plan-reversed.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
});

await test("edit plan rejects a cropped head in a normal human shot", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.cuts[0].headTopMarginAfter = 0;
  const file = path.join(temporary, "edit-plan-cropped-head.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
});

await test("edit plan accepts a designed full-screen information module", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.effects.push({
    timeSeconds: 90,
    timecode: "00:01:30.000",
    technique: "全屏流程图",
    trigger: "口播开始解释完整工作流程",
    function: ["information"],
    mechanism: "暂时替换 A-roll，把多阶段关系交给完整画布逐步建立",
    beforeState: "人物中景口播",
    afterState: "全屏流程节点按口播逐项点亮",
    entryExit: "章节边界进入，流程收束后完整退出，再恢复人物",
    simplerAlternative: "人物旁侧小卡；信息节点较多，旁侧布局会过密",
    failureCondition: "流程没有真正铺满画布，或半透明叠在人物头像上",
    qcEvidence: ["全屏覆盖率截图", "进入前/停留中/退出后代表帧"],
    layoutMode: "full_screen",
    subjectVisibilityPolicy: "replace_a_roll",
    fullScreenCoverage: 0.98,
    layoutEvidence: ["A-roll 已完全替换", "手机尺寸阅读预览"],
    progressiveStateSpec: {
      persistentBase: true,
      updateMode: "local_highlight",
      activeRegionBounds: [
        { x: 0.08, y: 0.2, width: 0.84, height: 0.62 },
      ],
      screenFlashPolicy: "forbid_full_frame_fade",
      stateBoundaryQC: ["逐节点切换前后各 2 帧差分，只允许当前节点区域变化"],
    },
    designPreflight: localDesignPreflight("full-screen-flowchart"),
  });
  const file = path.join(temporary, "edit-plan-fullscreen-flowchart.json");
  writeJson(file, plan);
  execute(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
});

await test("edit plan rejects full-screen flashing between progressive module states", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.effects.push({
    timeSeconds: 90,
    timecode: "00:01:30.000",
    technique: "全屏流程图",
    trigger: "口播开始解释工作流程",
    function: ["information"],
    mechanism: "逐节点点亮",
    beforeState: "人物口播",
    afterState: "全屏流程图",
    entryExit: "章节进入和退出",
    simplerAlternative: "干净切",
    failureCondition: "节点切换时整屏闪烁",
    qcEvidence: ["状态边界差分帧"],
    layoutMode: "full_screen",
    subjectVisibilityPolicy: "replace_a_roll",
    fullScreenCoverage: 0.98,
    layoutEvidence: ["手机尺寸预览"],
    progressiveStateSpec: {
      persistentBase: false,
      updateMode: "local_highlight",
      activeRegionBounds: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.6 }],
      screenFlashPolicy: "allow_full_frame_fade",
      stateBoundaryQC: ["边界帧"],
    },
    designPreflight: localDesignPreflight("flashing-flowchart"),
  });
  const file = path.join(temporary, "edit-plan-flashing-flowchart.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
}, "visual");

await test("edit plan rejects incomplete connection audit", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.connectionAudit.auditedJoinCount = 1;
  plan.connectionAudit.unresolvedJoinIds = ["join-00:00:41.200"];
  const file = path.join(temporary, "edit-plan-incomplete-connection-audit.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
}, "visual");

await test("edit plan rejects an information card covering the head safe zone", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.effects.push({
    timeSeconds: 90,
    timecode: "00:01:30.000",
    technique: "人物旁侧信息卡",
    trigger: "需要列出三个并列结论",
    function: ["information"],
    mechanism: "人物保留在画面中，信息卡从负空间展开",
    beforeState: "人物中景口播",
    afterState: "人物与卡片并置",
    entryExit: "句首进入，最后一项说完后退出",
    simplerAlternative: "全屏信息卡；当前仍需保留人物表情",
    failureCondition: "卡片进入人物头像或字幕安全区",
    qcEvidence: ["人物头像框和卡片框叠加图"],
    layoutMode: "subject_safe",
    moduleBounds: { x: 0.52, y: 0.06, width: 0.42, height: 0.34 },
    subjectHeadBounds: [{ x: 0.62, y: 0.1, width: 0.2, height: 0.25 }],
    headSafetyMargin: 0.03,
    layoutEvidence: ["中段代表帧"],
    designPreflight: localDesignPreflight("subject-safe-card"),
  });
  const file = path.join(temporary, "edit-plan-card-covers-head.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
});

await test("edit plan rejects implementation before visual design approval", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  delete plan.effects[1].designPreflight;
  const file = path.join(temporary, "edit-plan-missing-design-preflight.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
});

await test("edit plan rejects stale or fabricated design evidence", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  const preflight = plan.effects[1].designPreflight;
  preflight.designDigest = "0".repeat(64);
  preflight.artifactSha256 = "1".repeat(64);
  preflight.implementationHandoff.resolvedFonts.display = "Imaginary Display";
  preflight.implementationHandoff.fontResolutionDigest = sha256Value(
    preflight.implementationHandoff.resolvedFonts,
  );
  const file = path.join(temporary, "edit-plan-fabricated-design-evidence.json");
  writeJson(file, plan);
  const failure = expectFailure(process.execPath, [
    path.join(scripts, "validate_edit_plan.mjs"),
    file,
  ]);
  if (
    !failure.stderr.includes("designDigest")
    || !failure.stderr.includes("SHA-256")
    || !failure.stderr.includes("候选字体")
  ) {
    throw new Error("fabricated design evidence was rejected for the wrong reason");
  }
}, "visual");

await test("edit plan rejects a styleframe from stale renderer code", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  const preflight = localDesignPreflight("stale-renderer-code");
  const manifestFile = preflight.implementationManifestRef;
  const manifest = readJson(manifestFile);
  manifest.implementationDigest = "0".repeat(64);
  writeJson(manifestFile, manifest);
  preflight.implementationManifestSha256 = sha256File(manifestFile);
  plan.effects[1].designPreflight = preflight;
  const file = path.join(temporary, "edit-plan-stale-renderer-code.json");
  writeJson(file, plan);
  const failure = expectFailure(process.execPath, [
    path.join(scripts, "validate_edit_plan.mjs"),
    file,
  ]);
  if (!failure.stderr.includes("代码摘要")) {
    throw new Error("stale renderer evidence was rejected for the wrong reason");
  }
}, "visual");

await test("edit plan rejects PIP without a designed border contract", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  const pip = plan.effects.find((effect) => /画中画|picture-in-picture|pip/i.test(effect.technique));
  delete pip.pipBorderSpec;
  const file = path.join(temporary, "edit-plan-pip-missing-border.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
}, "visual");

await test("edit plan accepts a project-consistent PIP border contract", () => {
  const file = path.join(examples, "edit-plan.json");
  execute(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
}, "visual");

await test("edit plan rejects PIP that hard-crops the source instead of full-frame fit", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  const pip = plan.effects.find((effect) => /画中画|picture-in-picture|pip/i.test(effect.technique));
  pip.pipContentSpec.sourceComposition = "fixed_pixel_crop";
  pip.pipContentSpec.fitMode = "cover";
  pip.pipContentSpec.headTopMarginRatio = 0.01;
  const file = path.join(temporary, "edit-plan-pip-hard-crop.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
}, "visual");

await test("edit plan rejects split-screen panes without centered subject-aware composition", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.effects.push({
    timeSeconds: 80,
    timecode: "00:01:20.000",
    technique: "上下分屏",
    trigger: "同时比较两个时刻",
    function: ["comparison"],
    mechanism: "两个真实时间源分别进入上下窗格",
    beforeState: "单人中景",
    afterState: "上下双屏",
    entryExit: "句首进入，比较完成后退出",
    simplerAlternative: "交替切镜",
    failureCondition: "人物裁头或贴边",
    qcEvidence: ["双屏进入、停稳、退出代表帧"],
    subjectSafeArea: "字幕和品牌安全区之外",
    paneCompositionSpecs: [
      {
        sourceComposition: "fixed_top_crop",
        fitMode: "subject_aware_crop",
        subjectAnchor: { x: 0.5, y: 0.3 },
        verticalSubjectPosition: 0.3,
        headTopMarginRatio: 0.01,
        gestureVisibilityPolicy: "保留手势",
        stateFrames: ["进入", "停稳", "退出"],
      },
      {
        sourceComposition: "subject_aware_reframe",
        fitMode: "subject_aware_crop",
        subjectAnchor: { x: 0.5, y: 0.5 },
        verticalSubjectPosition: 0.5,
        headTopMarginRatio: 0.06,
        gestureVisibilityPolicy: "保留手势",
        stateFrames: ["进入", "停稳", "退出"],
      },
    ],
  });
  const file = path.join(temporary, "edit-plan-split-cropped-head.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
}, "visual");

await testIn("sfx", "edit plan accepts a varied whole-timeline SFX palette", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.sfxPlan.palette = [
    { assetId: "turn-local-pivot", title: "转折", category: "turn", useFor: "观点或叙事方向真正改变" },
    { assetId: "ui-tick", title: "轻提示", category: "ui", useFor: "列表项落位" },
    { assetId: "soft-whoosh", title: "轻转场", category: "transition", useFor: "方向一致的短动画" },
    { assetId: "knowledge-local-point", title: "知识点", category: "knowledge", useFor: "核心判断落位" },
  ];
  plan.sfxPlan.events = [
    { timeSeconds: 10, effectRef: "effects:title", assetId: "ui-tick", title: "轻提示", category: "ui", purpose: "标题落位", syncTarget: "标题停稳帧", levelRelativeToDialogueDb: -12 },
    { timeSeconds: 12.4, effectRef: "effects[0]", assetId: "turn-local-pivot", title: "转折", category: "turn", purpose: "手掌落桌并转入新观点", syncTarget: "动作峰值", levelRelativeToDialogueDb: -10 },
    { timeSeconds: 20, effectRef: "effects:transition-a", assetId: "soft-whoosh", title: "轻转场", category: "transition", purpose: "横向连接", syncTarget: "运动峰值", levelRelativeToDialogueDb: -10 },
    { timeSeconds: 41.2, effectRef: "effects[1]", assetId: "knowledge-local-point", title: "知识点", category: "knowledge", purpose: "人物后文字落位", syncTarget: "文字停稳帧", levelRelativeToDialogueDb: -8 },
    { timeSeconds: 50, effectRef: "effects:list-b", assetId: "ui-tick", title: "轻提示", category: "ui", purpose: "流程节点", syncTarget: "节点亮起帧", levelRelativeToDialogueDb: -12 },
    { timeSeconds: 60, effectRef: "effects:transition-b", assetId: "soft-whoosh", title: "轻转场", category: "transition", purpose: "返回真人", syncTarget: "画面停稳帧", levelRelativeToDialogueDb: -10 },
  ];
  const file = path.join(temporary, "edit-plan-varied-sfx.json");
  writeJson(file, plan);
  execute(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
});

await testIn("sfx", "edit plan rejects one SFX reused across the whole timeline", () => {
  const plan = readJson(path.join(examples, "edit-plan.json"));
  plan.effects[0].soundDesign.assetId = "knowledge-local-point";
  plan.effects[0].soundDesign.title = "知识点";
  plan.effects[0].soundDesign.readySha256 =
    "36aaccd076bdae00568426e29eceb9684116b4973c0f1a8859f5a78b6b4fa7b5";
  plan.sfxPlan.events = [10, 20, 30, 41.2, 50, 60].map((timeSeconds, index) => ({
    timeSeconds,
    effectRef: index === 3 ? "effects[1]" : `effects:${index}`,
    assetId: "knowledge-local-point",
    title: "知识点",
    category: "knowledge",
    purpose: "重复使用同一落点音",
    syncTarget: "视觉停稳帧",
    levelRelativeToDialogueDb: -8,
  }));
  const file = path.join(temporary, "edit-plan-one-sfx-everywhere.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_plan.mjs"), file]);
});

await testIn("generated", "generated template cannot masquerade as an executable preflight", () => {
  expectFailure(process.execPath, [
    path.join(scripts, "validate_generated_shot_plan.mjs"),
    path.join(examples, "generated-shot-plan.json"),
  ]);
});

await testIn("generated", "generated plan rejects stale snapshot, fake model and invalid ratio", () => {
  const plan = readJson(path.join(examples, "generated-shot-plan.json"));
  plan.template = false;
  plan.capabilitySnapshot.verifiedAt = "2020-01-01";
  plan.generatedShots[0].routing.model = "definitely-not-a-real-model";
  plan.generatedShots[0].aspectRatio = "0:16";
  const file = path.join(temporary, "generated-invalid.json");
  writeJson(file, plan);
  expectFailure(
    process.execPath,
    [path.join(scripts, "validate_generated_shot_plan.mjs"), file],
  );
});

await testIn("generated", "generated execution validates real files, hashes and authorization", () => {
  const image = path.join(temporary, "reference.png");
  const video = path.join(temporary, "reference.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=white:s=64x64:d=0.04:r=25",
    "-frames:v", "1", image,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=64x64:d=1:r=25",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", video,
  ]);
  const plan = readJson(path.join(examples, "generated-shot-plan.json"));
  plan.template = false;
  plan.capabilitySnapshot.verifiedAt = new Date().toISOString().slice(0, 10);
  plan.executionAuthorization = {
    status: "authorized",
    evidence: "test-only authorization",
    authorizedAt: new Date().toISOString(),
  };
  for (const shot of plan.generatedShots) {
    for (const asset of shot.referenceAssets) {
      const candidate = asset.type === "video" ? video : image;
      asset.localPath = candidate;
      asset.sha256 = sha256File(candidate);
    }
  }
  const file = path.join(temporary, "generated-executable.json");
  writeJson(file, plan);
  execute(
    process.execPath,
    [path.join(scripts, "validate_generated_shot_plan.mjs"), file, "--for-execution"],
  );
  const generatedOutput = path.join(temporary, "generated-cached.mp4");
  const generatedArguments = [
    path.join(scripts, "kacha.mjs"),
    "generated-cache",
    "run",
    "--plan",
    file,
    "--shot",
    plan.generatedShots[0].id,
    "--output",
    generatedOutput,
    "--project-root",
    temporary,
    "--",
    "/bin/cp",
    video,
    generatedOutput,
  ];
  const generatedMiss = JSON.parse(
    execute(process.execPath, generatedArguments).stdout,
  );
  fs.unlinkSync(generatedOutput);
  const generatedHit = JSON.parse(
    execute(process.execPath, generatedArguments).stdout,
  );
  const alternateGeneratedOutput = path.join(
    temporary,
    "generated-cached-alternate-destination.mp4",
  );
  const alternateGeneratedArguments = generatedArguments.map((value) => (
    value === generatedOutput ? alternateGeneratedOutput : value
  ));
  const alternateGeneratedHit = JSON.parse(
    execute(process.execPath, alternateGeneratedArguments).stdout,
  );
  if (
    generatedMiss.cache?.status !== "miss"
    || generatedMiss.paidCallExecuted !== true
    || generatedHit.cache?.status !== "hit"
    || generatedHit.paidCallExecuted !== false
    || !fs.existsSync(generatedOutput)
    || alternateGeneratedHit.cache?.status !== "hit"
    || alternateGeneratedHit.paidCallExecuted !== false
    || !fs.existsSync(alternateGeneratedOutput)
  ) {
    throw new Error(
      "generated media wrapper did not reuse the same shot across output destinations",
    );
  }
  const secretFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "generated-cache",
    "run",
    "--plan",
    file,
    "--shot",
    plan.generatedShots[0].id,
    "--output",
    path.join(temporary, "generated-secret.mp4"),
    "--",
    "/bin/cp",
    "--api-token",
    "forbidden",
  ]);
  if (!secretFailure.stderr.includes("不得携带凭证")) {
    throw new Error("generated media wrapper accepted a credential-bearing command");
  }
});

await test("reframe fails closed on multiple unlocked subjects", () => {
  const manifest = readJson(path.join(examples, "vision-manifest-reframe.json"));
  manifest.frames.forEach((frame, index) => {
    frame.faces = [
      {
        confidence: 0.99,
        x: index % 2 === 0 ? 0.15 : 0.16,
        y: 0.50,
        width: index % 2 === 0 ? 0.20 : 0.08,
        height: index % 2 === 0 ? 0.30 : 0.12,
      },
      {
        confidence: 0.99,
        x: index % 2 === 0 ? 0.65 : 0.64,
        y: 0.50,
        width: index % 2 === 0 ? 0.08 : 0.20,
        height: index % 2 === 0 ? 0.12 : 0.30,
      },
    ];
  });
  const input = path.join(temporary, "multi-face.json");
  const output = path.join(temporary, "multi-face-reframe.json");
  writeJson(input, manifest);
  execute(process.execPath, [
    path.join(scripts, "plan_subject_reframe.mjs"),
    input,
    "9:16",
    output,
  ]);
  const result = readJson(output);
  if (result.summary.disposition !== "manual_keyframes_or_safe_fallback_required") {
    throw new Error("multi-face track was incorrectly approved for preview");
  }
});

await test("capability probe returns nonzero for missing required capability", () => {
  expectFailure(path.join(scripts, "capability_probe.sh"), [
    "--profile",
    "core",
    "--require",
    "command:__kacha_missing_command__",
  ]);
});

const baseVideo = path.join(temporary, "base.mov");
const shortMask = path.join(temporary, "mask-short.mkv");
const exactMask = path.join(temporary, "mask-exact.mkv");
const localizedMask = path.join(temporary, "mask-localized.mkv");
const exactText = path.join(temporary, "text-exact.mov");
let mediaFixturesReady = false;
function ensureMediaFixtures() {
  if (mediaFixturesReady) return;
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:d=2:r=25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
    "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
    "-c:a", "pcm_s24le", baseVideo,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=white:s=320x180:d=1:r=25",
    "-c:v", "ffv1", "-pix_fmt", "gray", shortMask,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=white:s=320x180:d=2:r=25",
    "-c:v", "ffv1", "-pix_fmt", "gray", exactMask,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i",
    "color=c=black:s=320x180:d=2:r=25,"
      + "drawbox=x=120:y=60:w=80:h=60:color=white:t=fill,format=gray",
    "-c:v", "ffv1", "-pix_fmt", "gray", localizedMask,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red@0.7:s=320x180:d=2:r=25,format=rgba",
    "-c:v", "qtrle", exactText,
  ]);
  mediaFixturesReady = true;
}

await test("font routing scans, authorizes, resolves and previews a real local font", () => {
  const match = run("fc-match", ["-f", "%{file}", "sans-serif"]);
  const commonFonts = [
    match.status === 0 ? match.stdout.trim() : null,
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter(Boolean);
  const sourceFont = commonFonts.find((candidate) => fs.existsSync(candidate));
  if (!sourceFont) throw new Error("no real system font available for routing test");
  const fontDirectory = path.join(temporary, "fonts");
  fs.mkdirSync(fontDirectory);
  const copiedFont = path.join(fontDirectory, path.basename(sourceFont));
  fs.copyFileSync(sourceFont, copiedFont);
  const scannedFile = path.join(temporary, "font-registry.json");
  const authorizedFile = path.join(temporary, "font-registry-authorized.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "fonts", "scan",
    "--directory", fontDirectory,
    "--output", scannedFile,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "fonts", "authorize",
    "--registry", scannedFile,
    "--output", authorizedFile,
    "--statement", "synthetic regression authorization",
  ]);
  const resolved = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "fonts", "resolve",
    "--registry", authorizedFile,
    "--role", "body_en",
    "--text", "Caption 123",
  ]).stdout);
  if (
    resolved.status !== "pass"
    || resolved.selected.projectAuthorization?.status !== "authorized"
    || resolved.selected.redistributionAllowed === true
  ) {
    throw new Error("font routing did not preserve local authorization boundaries");
  }
  const preview = path.join(temporary, "font-preview.png");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "fonts", "preview",
    "--font", copiedFont,
    "--text", "Caption 123",
    "--output", preview,
  ]);
  if (!fs.existsSync(preview) || fs.statSync(preview).size === 0) {
    throw new Error("font preview was not rendered");
  }
}, "visual");

await test("bundled private Jinling font is portable and selected by caption planning", () => {
  const bundledFont = path.join(
    skillDirectory,
    "assets",
    "private",
    "fonts",
    "FZCuJinLJW.ttf",
  );
  const bundledRegistry = path.join(path.dirname(bundledFont), "authorized.json");
  if (!fs.existsSync(bundledFont) || !fs.existsSync(bundledRegistry)) return;
  ensureMediaFixtures();
  const standalone = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-bundled-font-"));
  try {
    const configHome = path.join(standalone, "config-home");
    const input = path.join(standalone, "source.mp4");
    const cues = path.join(standalone, "cues.json");
    const plan = path.join(standalone, "caption-plan.json");
    fs.mkdirSync(configHome, { recursive: true });
    fs.copyFileSync(baseVideo, input);
    writeJson(cues, [{
      id: "jinling",
      start: 0.1,
      end: 0.8,
      text: "真正的金陵体字幕",
    }]);
    const planned = run(process.execPath, [
      path.join(scripts, "kacha.mjs"),
      "captions", "plan",
      "--input", input,
      "--transcript", cues,
      "--output", plan,
    ], {
      cwd: standalone,
      env: { ...process.env, KACHA_CONFIG_HOME: configHome },
    });
    if (planned.status !== 0) {
      throw new Error(`bundled Jinling planning failed:\n${planned.stdout}\n${planned.stderr}`);
    }
    const value = readJson(plan);
    const selected = value.events[0].font;
    if (
      selected.file !== bundledFont
      || selected.sha256 !== "3c15643db0ef339e1faf39b8b0c12ffead661565876e617fd25ca5209eabb1ea"
      || selected.projectAuthorization?.status !== "authorized"
      || !value.source.fontRegistry.path.endsWith(".bundled-fonts.json")
    ) {
      throw new Error("caption planning did not bind the portable bundled Jinling font");
    }
  } finally {
    fs.rmSync(standalone, { recursive: true, force: true });
  }
}, "visual");

await test("local production studio compiles an auditable project with verified font evidence", () => {
  const catalog = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "studio", "validate",
  ]).stdout);
  if (
    catalog.defaultStyleId !== "xingzhe"
    || catalog.builtInStyleCount !== 5
    || catalog.masterStyleId !== "xingzhe"
    || catalog.masterStyleVersion !== "3.0"
    || catalog.productionPresetRelationship
      !== "production-presets-inherit-master-effect-library"
    || catalog.visualLanguageCount !== 5
    || catalog.visualLanguageRelationship
      !== "five-visual-languages-are-xingzhe-substyles"
    || catalog.effectCountPerVisualLanguage !== 240
    || catalog.motionContractCount !== 1200
    || catalog.highFidelityFrameCount !== 2400
    || catalog.defaultVisualLanguageSelectionMode !== "automatic"
    || catalog.visualLanguageParentProfile !== "xingzhe"
    || catalog.openingCount < 10
    || catalog.assignableEffectCount < 100
  ) {
    throw new Error("production studio catalog is incomplete");
  }

  const match = run("fc-match", ["-f", "%{file}", "sans-serif"]);
  const sourceFont = [
    match.status === 0 ? match.stdout.trim() : null,
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
  if (!sourceFont) throw new Error("no real system font available for studio test");
  const fontDirectory = path.join(temporary, "studio-fonts");
  fs.mkdirSync(fontDirectory);
  fs.copyFileSync(sourceFont, path.join(fontDirectory, path.basename(sourceFont)));
  const scanned = path.join(temporary, "studio-font-registry.json");
  const authorized = path.join(temporary, "studio-font-registry-authorized.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "fonts", "scan",
    "--directory", fontDirectory,
    "--output", scanned,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "fonts", "authorize",
    "--registry", scanned,
    "--output", authorized,
    "--statement", "synthetic studio regression authorization",
  ]);
  const registry = readJson(authorized);
  const fontFamily = registry.records[0].families[0];
  const currentUserConfig = fs.existsSync(path.join(isolatedConfigHome, "config.json"))
    ? readJson(path.join(isolatedConfigHome, "config.json"))
    : { schemaVersion: "1.0" };
  fs.mkdirSync(isolatedConfigHome, { recursive: true });
  writeJson(path.join(isolatedConfigHome, "config.json"), {
    ...currentUserConfig,
    tools: {
      ...(currentUserConfig.tools ?? {}),
      fontRegistry: authorized,
    },
  });

  const styleInput = path.join(temporary, "studio-test-style.json");
  writeJson(styleInput, {
    schemaVersion: "1.0",
    id: "custom-studio-test",
    name: "Studio Test",
    tagline: "portable regression",
    description: "Synthetic style used only by regression tests.",
    baseStyleId: "xingzhe",
    caption: {
      preferredFontFamily: fontFamily,
    },
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "studio", "save-style",
    "--input", styleInput,
  ]);
  const duplicateStyle = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "studio", "save-style",
    "--input", styleInput,
  ]);
  if (!duplicateStyle.stderr.includes("不会静默覆盖")) {
    throw new Error("production studio did not block an accidental style overwrite");
  }

  const input = path.join(temporary, "studio-source.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=160x90:r=12:d=0.8",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", input,
  ]);
  const request = path.join(temporary, "studio-request.json");
  const outputDirectory = path.join(temporary, "studio-output");
  writeJson(request, {
    schemaVersion: "1.0",
    videoPath: input,
    projectName: "studio-regression",
    outputDirectory,
    task: "source_edit",
    platform: "general",
    show: "tool-share",
    language: "zh",
    outputPresetId: "preserve-source",
    preserveSource: true,
    backgroundMusicEnabled: true,
    styleId: "custom-studio-test",
    openingId: "hook_title_behind_subject",
    automaticProfessionalJudgment: true,
    effectAssignments: [{
      positionDescription: "说到结论的时候",
      effectKind: "caption",
      effectId: "logic_emphasis_inline",
      notes: "synthetic timing contract",
    }],
  });
  const previewRequest = readJson(request);
  previewRequest.visualLanguageSelection = {
    mode: "preferred",
    preferredId: "xingzhe-pixel-editorial",
  };
  previewRequest.projectOverrides = {
    audioPresetId: "clear",
    bgmPresetId: "minimal-piano",
    effectDensity: "active",
    beauty: {
      enabled: true,
      engine: "beauty-v2",
      profile: "visible",
      tuning: {
        smoothing: 58,
        whitening: 32,
        toneEvening: 44,
        nasolabialSoftening: 36,
      },
    },
  };
  const previewFile = path.join(temporary, "studio-preview-request.json");
  writeJson(previewFile, previewRequest);
  const preview = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "studio", "preview",
    "--request", previewFile,
  ]).stdout);
  if (
    preview.status !== "pass"
    || !preview.validationDigest
    || preview.readiness.outputWritable !== true
    || preview.readiness.fontAuthorized !== true
    || preview.projectConfig.execution.voiceEnhancement.preset !== "clear"
    || preview.projectConfig.editingDefaults.parameters.audio.bgm.presetId
      !== "minimal-piano"
    || preview.projectConfig.editingDefaults.parameters.beauty.enabled !== true
    || preview.projectConfig.editingDefaults.parameters.beauty.tuning.smoothing !== 58
    || preview.projectConfig.editingDefaults.parameters.delivery.container !== "source"
    || preview.brief.style.visualLanguageSelection.mode !== "preferred"
    || preview.brief.style.visualLanguageSelection.preferredId
      !== "xingzhe-pixel-editorial"
    || preview.projectConfig.editingDefaults.parameters.productionStudio
      .visualLanguageSelection.registryDigest.length !== 64
    || preview.projectConfig.editingDefaults.recipeParameters.style
      .visualLanguageSelection.preferredLabel !== "像素风"
  ) {
    throw new Error("production studio preview did not resolve project overrides");
  }
  const invalidVisualLanguageRequest = {
    ...previewRequest,
    visualLanguageSelection: {
      mode: "preferred",
      preferredId: "xingzhe-nonexistent",
    },
  };
  const invalidVisualLanguageFile = path.join(
    temporary,
    "studio-invalid-visual-language-request.json",
  );
  writeJson(invalidVisualLanguageFile, invalidVisualLanguageRequest);
  const invalidVisualLanguage = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "studio", "preview",
    "--request", invalidVisualLanguageFile,
  ]);
  if (!invalidVisualLanguage.stderr.includes("visualLanguageSelection.preferredId")) {
    throw new Error("production studio accepted an unknown visual language preference");
  }
  const compiled = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "studio", "compile",
    "--request", request,
  ]).stdout);
  const brief = readJson(compiled.briefPath);
  const projectConfig = readJson(compiled.configPath);
  if (
    compiled.status !== "pass"
    || brief.source.sha256 !== sha256File(input)
    || brief.source.readOnly !== true
    || brief.style.captionFontEvidence.sha256 !== registry.records[0].sha256
    || brief.style.captionFontEvidence.authorizationStatus !== "authorized"
    || projectConfig.editingDefaults.parameters.beauty.enabled !== false
    || projectConfig.editingDefaults.parameters.beauty.tuning.smoothing !== 35
    || projectConfig.editingDefaults.parameters.productionStudio
      .effectAssignments[0].effectId !== "logic_emphasis_inline"
    || projectConfig.editingDefaults.parameters.productionStudio
      .openingContract.effectId !== "hook_title_behind_subject"
    || projectConfig.editingDefaults.parameters.productionStudio
      .openingContract.source !== "z-en-netstyle"
    || projectConfig.editingDefaults.parameters.productionStudio
      .openingContract.promiseBySeconds !== 3
    || brief.style.visualLanguageSelection.mode !== "automatic"
    || brief.style.visualLanguageSelection.preferredId !== null
    || projectConfig.editingDefaults.parameters.productionStudio
      .visualLanguageSelection.mode !== "automatic"
    || !projectConfig.editingDefaults.instructions.some(
      (entry) => entry.id === "studio-visual-language-contract",
    )
    || brief.opening.required !== true
    || brief.opening.primaryEffectCount !== 1
    || brief.intelligenceV6?.required !== true
    || projectConfig.execution.intelligenceV6?.required !== true
    || compiled.orchestration?.v6Required !== true
    || compiled.orchestration?.milestones?.length !== 4
    || !fs.existsSync(compiled.orchestration?.manifest)
    || readJson(compiled.orchestration.manifest).intelligenceV6?.required !== true
  ) {
    throw new Error("production studio project contract is incomplete");
  }
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config", "validate",
    "--anchor", compiled.projectDirectory,
    "--no-secrets",
  ]);
}, "visual");

await test("production studio exposes five visual-language choices and live contract state", async () => {
  const html = fs.readFileSync(path.join(skillDirectory, "studio", "index.html"), "utf8");
  const contentHtml = fs.readFileSync(
    path.join(skillDirectory, "studio", "content.html"),
    "utf8",
  );
  const client = fs.readFileSync(path.join(skillDirectory, "studio", "app.js"), "utf8");
  const productionStudio = readJson(path.join(
    skillDirectory,
    "config",
    "production-studio.json",
  ));
  const visualLanguages = readJson(path.join(
    skillDirectory,
    "config",
    "design-system",
    "visual-languages.json",
  ));
  if (
    !html.includes('id="visualLanguageList"')
    || !html.includes('id="summaryVisualLanguage"')
    || !html.includes('id="previewLanguage"')
    || !client.includes("renderVisualLanguages")
    || !client.includes("visualLanguageSelection")
    || visualLanguages.defaultSelectionMode !== "automatic"
    || visualLanguages.parentProfile !== "xingzhe"
    || Object.keys(visualLanguages.languages).length !== 5
    || new Set(Object.keys(visualLanguages.languages)).size !== 5
    || !contentHtml.includes('<option value="xingzhe-dark-tech">暗黑科技风</option>')
    || productionStudio.styleArchitecture?.masterStyleId !== "xingzhe"
    || productionStudio.styleArchitecture?.expectedCounts?.motionContracts !== 1200
    || productionStudio.stylePresets.some((style) => (
      style.caption.preferredFontFamily !== "方正粗金陵简体"
      || style.caption.shadowOpacity !== 0.6
      || style.caption.background !== "none"
    ))
  ) {
    throw new Error("production studio visual-language controls are incomplete");
  }
  const { loadProductionCatalog, saveCustomStyle } = await import(
    pathToFileURL(path.join(scripts, "kacha_studio.mjs")).href
  );
  const cacheEnvironment = {
    ...process.env,
    KACHA_CONFIG_HOME: path.join(temporary, "studio-catalog-cache-config"),
  };
  const warmCatalog = loadProductionCatalog({ environment: cacheEnvironment });
  warmCatalog.styles[0].name = "caller-mutation";
  const isolatedCatalog = loadProductionCatalog({ environment: cacheEnvironment });
  if (isolatedCatalog.styles[0].name === "caller-mutation") {
    throw new Error("production catalog cache leaked a caller mutation");
  }
  saveCustomStyle({
    id: "custom-cache-freshness",
    name: "缓存后新风格",
    baseStyleId: "xingzhe",
  }, { environment: cacheEnvironment });
  const refreshedCatalog = loadProductionCatalog({ environment: cacheEnvironment });
  if (!refreshedCatalog.styles.some((style) => style.id === "custom-cache-freshness")) {
    throw new Error("production catalog cache hid a custom style created after warmup");
  }
}, "visual");

await test("production packs separate generic policy from five show-specific editorial rhythms", () => {
  const root = path.join(temporary, "production-packs");
  fs.mkdirSync(root, { recursive: true });
  const expected = {
    "tool-share": [5, 4, 3],
    "book-talk": [2, 2, 0],
    "infinite-game": [1, 1, 0],
    "very-ai": [5, 4, 2],
    "casual-chat": [2, 2, 1],
  };
  for (const [showId, thresholds] of Object.entries(expected)) {
    const contractFile = path.join(root, `${showId}.json`);
    execute(process.execPath, [
      path.join(scripts, "kacha.mjs"),
      "production-quality", "template",
      "--project-id", `pack-${showId}`,
      "--pack", "xingzhe-dahui",
      "--show", showId,
      "--output", contractFile,
    ]);
    execute(process.execPath, [
      path.join(scripts, "kacha.mjs"),
      "production-quality", "validate",
      "--contract", contractFile,
      "--stage", "plan",
    ]);
    const policy = readJson(contractFile).policies;
    if (
      policy.productionProfile.showId !== showId
      || policy.firstMinute.minimumMotivatedEffects !== thresholds[0]
      || policy.firstMinute.minimumDistinctMechanisms !== thresholds[1]
      || policy.firstMinute.minimumPeakAlignedSfx !== thresholds[2]
    ) throw new Error(`show-specific production pack did not resolve: ${showId}`);
  }

  const genericFile = path.join(root, "generic.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "template",
    "--project-id", "pack-generic",
    "--pack", "clean-editorial",
    "--show", "talking-head",
    "--output", genericFile,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "validate",
    "--contract", genericFile,
    "--stage", "plan",
  ]);
  const generic = readJson(genericFile).policies;
  if (
    generic.typography.allowedFonts.includes("金陵体")
    || generic.cover.mode !== "editorial_2d"
    || generic.productionProfile.packId !== "clean-editorial"
  ) throw new Error("generic production pack still depends on xingzhe-dahui brand rules");

  const malformedRoot = path.join(root, "malformed-pack-root");
  fs.mkdirSync(malformedRoot, { recursive: true });
  const malformed = readJson(path.join(skillDirectory, "config", "production-packs", "clean-editorial.json"));
  malformed.id = "malformed";
  delete malformed.base.firstMinute.maximumPrimaryEventsPer10Seconds;
  writeJson(path.join(malformedRoot, "malformed.json"), malformed);
  let malformedRejected = false;
  try {
    loadProductionPack("malformed", "talking-head", {
      packRoot: malformedRoot,
      designRoot: path.join(skillDirectory, "config", "design-system"),
    });
  } catch (error) {
    malformedRejected = error.message.includes("maximumPrimaryEventsPer10Seconds");
  }
  if (!malformedRejected) throw new Error("malformed production pack disabled a required numeric quality limit");
}, "core");

await test("production quality contract gates recurring editorial defects across all stages", () => {
  const root = path.join(temporary, "production-quality-contract");
  fs.mkdirSync(root, { recursive: true });
  const contractFile = path.join(root, "contract.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "template",
    "--project-id", "quality-contract",
    "--output", contractFile,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "validate",
    "--contract", contractFile,
    "--stage", "plan",
  ]);

  const evidence = path.join(root, "evidence.txt");
  fs.writeFileSync(evidence, "bound production evidence\n");
  const identity = fileIdentity(evidence);
  const sfxFile = path.join(root, "late-peak.wav");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i",
    "aevalsrc=if(between(t\\,0.4\\,0.52)\\,0.8*sin(2*PI*880*t)\\,0):d=0.8:s=48000",
    "-c:a", "pcm_s16le", sfxFile,
  ]);
  const alignments = [1, 5, 9].map((target) => JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "sfx", "align", "--file", sfxFile, "--target", String(target), "--fps", "25",
  ]).stdout).alignment);
  const contract = readJson(contractFile);
  contract.execution = {
    semanticEdit: {
      wordTimedSource: identity,
      reviewedThroughSeconds: 30,
      unresolvedFragments: 0,
      cutDecisions: [{
        id: "cut-001",
        semanticUnitComplete: true,
        fragmentPolicy: "remove_complete",
        reason: "删除无意长停顿，同时保留完整语义单元",
        sourceStartSeconds: 12.1,
        sourceEndSeconds: 13.8,
      }],
    },
    connections: {
      detectedCount: 1,
      cutSheetCount: 1,
      auditedCount: 1,
      unresolvedCount: 0,
      events: [{
        id: "join-001",
        decisionType: "j_cut",
        motivation: "下一句声音先行，承接同一论证",
        repairedWrongCut: true,
      }],
    },
    opening: {
      primaryEffectCount: 1,
      firstVisibleChangeSeconds: 0.2,
      promiseSeconds: 2.4,
      effectId: "pixel-promise-open",
      dynamicPreview: identity,
      revealStartsClosed: true,
      frameZeroCoverage: "full",
      partialSubjectAperture: false,
    },
    effects: {
      maxConcurrentPrimary: 1,
      progressiveLists: [{
        id: "list-001",
        itemCount: 2,
        itemCues: [0.15, 0.72],
        sfxPeaks: [0.18, 0.75],
      }],
      behindSubjectText: [{ text: "先做再说", font: "华光标题黑", maskVerified: true }],
    },
    captions: {
      regularStyle: {
        font: "金陵体",
        background: "none",
        outline: "none",
        shadowOpacity: 0.6,
      },
      relationshipGroups: [{
        relation: "contrast",
        lines: ["不是等灵感", "而是先行动"],
        lineCues: [0.1, 0.8],
      }],
    },
    overlays: {
      events: [{
        borderPxAt4k: 3,
        textOutline: "none",
        collisionStates: { entry: "pass", peak: "pass", exit: "pass" },
      }],
    },
    pip: {
      events: [{
        informationDifference: true,
        selfPip: false,
        collisionStates: { entry: "pass", peak: "pass", exit: "pass" },
      }],
    },
    externalAssets: {
      items: [{
        semantic: {
          object: "旅行清单",
          action: "逐项勾选",
          state: "正在完成",
          role: "论据",
          tense: "当前",
        },
        provenance: { kind: "local_generated", evidence: "asset-plan:shot-01" },
        file: identity,
        illustrative: true,
        label: "情境示意",
      }],
    },
    audio: {
      adaptivePlan: identity,
      timelineFps: 25,
      promptFields: {
        instrumentation: "dry electronic drums and soft mallets",
        style: "restrained pixel editorial",
        tempo: "92 BPM with speech-aware half-time sections",
        timbre: "warm rounded transients",
        harmony: "open fifths with suspended color",
        lowFrequency: "mono controlled below 120 Hz",
        highFrequency: "softened above 8 kHz around dense speech",
      },
      intentionalSilences: [],
      sfxEvents: alignments.map((alignment, index) => ({
        id: `sfx-${index + 1}`,
        file: alignment.file,
        fileStartSeconds: alignment.fileStartSeconds,
        sourceTrimSeconds: alignment.sourceTrimSeconds,
        measuredPeakOffsetSeconds: alignment.measuredPeakOffsetSeconds,
        targetLandingSeconds: alignment.targetLandingSeconds,
        deltaFrames: alignment.deltaFrames,
        alignmentMode: alignment.alignmentMode,
        measurementMethod: alignment.measurementMethod,
      })),
    },
    cover: {
      mode: "cinematic_3d",
      realFaceAnchor: identity,
      turnaroundAnchor: identity,
      poseAsset: identity,
      generationInputMode: "turnaround_only_real_photo_qc",
      generationInputReferences: [identity],
      realFaceAnchorRole: "post_generation_qc_only",
      displayUsesTurnaroundPose: false,
      poseAdapted: true,
      poseContract: {
        sceneSignal: "旅行计划过密",
        narrativeIntent: "先停一下，不把旅行继续项目化",
        bodyAction: "一手持手机，一手做克制叫停手势",
        gaze: "看向标题与路线关系",
        expression: "成年人的无奈与自嘲",
        propInteraction: "查看手机中的密集行程",
        weightShift: "身体后撤，重心落在后腿",
        clothingAdaptation: "保留深藏蓝基线，加入轻便旅行外套层次",
        clothingContinuity: "眼镜、短刺黑发和深藏蓝主色保持连续",
        reusedApprovedPose: false,
      },
    },
    firstMinute: {
      motivatedEffects: [
        { startSeconds: 0.2, trigger: "开场承诺", mechanism: "closed_reveal", primary: true, audioVisualIntentMatched: true },
        { startSeconds: 4, trigger: "观点落点", mechanism: "semantic_zoom", primary: true, audioVisualIntentMatched: true },
        { startSeconds: 14, trigger: "事实证据", mechanism: "evidence_pip", primary: true, audioVisualIntentMatched: true },
        { startSeconds: 28, trigger: "关系转折", mechanism: "caption_relation", primary: true, audioVisualIntentMatched: true },
        { startSeconds: 44, trigger: "情绪反应", mechanism: "reaction_hold", primary: true, audioVisualIntentMatched: true },
      ],
      humanPresenceRatio: 0.7,
      fullScreenTakeoverRatio: 0.2,
      breathingRoomRatio: 0.3,
      peakAlignedSfxEventIds: ["sfx-1", "sfx-2", "sfx-3"],
      humanReactionWindows: [{ startSeconds: 40, endSeconds: 43, reason: "保留真实表情反应" }],
      normalSpeedPreview: identity,
    },
    cinematicEditorial: {
      showId: "tool-share",
      durationSeconds: 30,
      events: [
        {
          id: "picture-base-001",
          semanticBeatId: "beat-all",
          trigger: "真人口播是全片主体",
          mechanism: "clean_a_roll",
          sourceType: "a_roll",
          containerType: "none",
          compositionSignature: "clean-medium-human",
          styleId: "xingzhe-pixel-editorial",
          simplerAlternative: "保留原镜头",
          startSeconds: 0,
          endSeconds: 30,
        },
        {
          id: "type-beat-001",
          semanticBeatId: "beat-promise",
          trigger: "开场承诺关键词落位",
          mechanism: "boundaryless_typography",
          sourceType: "a_roll",
          containerType: "boundaryless",
          compositionSignature: "type-behind-left-shoulder",
          styleId: "xingzhe-pixel-editorial",
          simplerAlternative: "只保留常规字幕",
          startSeconds: 2,
          endSeconds: 5,
        },
        {
          id: "detail-beat-001",
          semanticBeatId: "beat-detail",
          trigger: "细节证据需要短暂看清",
          mechanism: "detail_insert",
          sourceType: "project_evidence",
          containerType: "none",
          compositionSignature: "detail-full-bleed-center",
          styleId: "xingzhe-pixel-editorial",
          simplerAlternative: "不插入证据细节",
          startSeconds: 10,
          endSeconds: 13,
        },
        {
          id: "relation-beat-001",
          semanticBeatId: "beat-contrast",
          trigger: "对比关系需要同时建立",
          mechanism: "split_relationship",
          sourceType: "screen_recording",
          containerType: "none",
          compositionSignature: "split-evidence-diagonal",
          styleId: "xingzhe-pixel-editorial",
          simplerAlternative: "口播串行说明对比",
          startSeconds: 20,
          endSeconds: 23,
        },
      ],
      auditMetrics: null,
      normalSpeedPreview: identity,
      phoneSizeReview: { status: "pass", evidence: identity },
      webLikenessReview: { status: "pass", evidence: identity },
    },
  };
  contract.release = {
    finalTimeline: identity,
    stems: { dialogue: identity, bgm: identity, sfx: identity, mix: identity },
    programDurationSeconds: 30,
    bgmCoverageRatio: 0.98,
    intentionalSilences: [],
    representativeNormalSpeed: { status: "pass", evidence: identity },
    fullPlayback: { status: "pass", evidence: identity },
    deviceListening: { status: "pass", evidence: identity },
  };
  writeJson(contractFile, contract);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "anti-web-audit",
    "--contract", contractFile,
    "--write",
  ]);
  Object.assign(contract, readJson(contractFile));
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "validate",
    "--contract", contractFile,
    "--stage", "release",
  ]);

  const mismatchedShow = structuredClone(contract);
  mismatchedShow.execution.cinematicEditorial.showId = "casual-chat";
  const mismatchedShowFile = path.join(root, "mismatched-show.json");
  writeJson(mismatchedShowFile, mismatchedShow);
  const mismatchedShowFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "validate",
    "--contract", mismatchedShowFile,
    "--stage", "release",
  ]);
  if (!mismatchedShowFailure.stderr.includes("必须与 policies.productionProfile.showId 一致")) {
    throw new Error("production quality accepted a cinematic budget from another show");
  }

  const genericContractFile = path.join(root, "generic-contract.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "template",
    "--project-id", "generic-quality-contract",
    "--pack", "clean-editorial",
    "--show", "talking-head",
    "--output", genericContractFile,
  ]);
  const genericContract = readJson(genericContractFile);
  genericContract.execution = structuredClone(contract.execution);
  genericContract.release = structuredClone(contract.release);
  genericContract.execution.effects.behindSubjectText[0].font = genericContract.policies.typography.displayFont;
  genericContract.execution.captions.regularStyle = structuredClone(
    genericContract.policies.typography.regularSubtitle,
  );
  genericContract.execution.cover = {
    mode: "editorial_2d",
    identityEvidence: identity,
    generationInputMode: "real_photo",
  };
  genericContract.execution.cinematicEditorial.showId = "talking-head";
  for (const event of genericContract.execution.cinematicEditorial.events) {
    event.styleId = "clean-editorial";
  }
  genericContract.execution.cinematicEditorial.auditMetrics = null;
  writeJson(genericContractFile, genericContract);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "anti-web-audit",
    "--contract", genericContractFile,
    "--write",
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "validate",
    "--contract", genericContractFile,
    "--stage", "release",
  ]);

  const broken = structuredClone(contract);
  broken.execution.semanticEdit.unresolvedFragments = 1;
  broken.execution.connections.cutSheetCount = 0;
  broken.execution.opening.primaryEffectCount = 0;
  broken.execution.opening.partialSubjectAperture = true;
  broken.execution.effects.progressiveLists[0].itemCues = [0.15];
  broken.execution.effects.behindSubjectText[0].text = "这一整段长文字不应该出现在人物身后";
  broken.execution.captions.relationshipGroups[0].lineCues = [0.8, 0.1];
  broken.execution.pip.events[0].selfPip = true;
  delete broken.execution.externalAssets.items[0].semantic.action;
  delete broken.execution.audio.promptFields.harmony;
  broken.execution.audio.sfxEvents[0].fileStartSeconds += 0.5;
  broken.execution.cover.displayUsesTurnaroundPose = true;
  delete broken.execution.cover.poseContract.bodyAction;
  broken.execution.cover.poseContract.reusedApprovedPose = true;
  broken.execution.firstMinute.motivatedEffects = broken.execution.firstMinute.motivatedEffects.slice(0, 2);
  broken.execution.cinematicEditorial.events[1].patterns = ["web_hero"];
  broken.execution.cinematicEditorial.events[2].containerType = "dashboard";
  broken.release.bgmCoverageRatio = 0.2;
  broken.release.fullPlayback.status = "pending";
  const brokenFile = path.join(root, "broken.json");
  writeJson(brokenFile, broken);
  const failure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "validate",
    "--contract", brokenFile,
    "--stage", "release",
  ]);
  for (const phrase of [
    "半句话残片",
    "检测数、剪点表数和审计数",
    "唯一开场",
    "禁止先露出局部人脸小口",
    "逐项随口播出现",
    "7 字以内",
    "语义关系逐行出现",
    "信息差或三态避碰",
    "语义五元组",
    "promptFields.harmony",
    "自动反推起播时间",
    "不得直接使用三视图/T-pose",
    "人物动作必须绑定当前场景且不得复用固定姿势",
    "execution.firstMinute",
    "网页化禁用模式",
    "禁止通用仪表盘构图",
    "BGM 覆盖不足",
    "fullPlayback.status 必须为 pass",
  ]) {
    if (!failure.stderr.includes(phrase)) throw new Error(`missing quality gate: ${phrase}`);
  }
}, "core");

await test("V7 orchestrator starts source and script projects with recoverable milestones", () => {
  const registry = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "workflow", "validate",
  ]).stdout);
  if (registry.status !== "pass" || registry.stages !== 13 || registry.milestones !== 4) {
    throw new Error("V7 workflow registry is incomplete");
  }

  const source = path.join(temporary, "orchestrator-source.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=160x90:r=12:d=0.8",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", source,
  ]);
  const sourceRoot = path.join(temporary, "orchestrated-source-project");
  const started = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "start",
    "--source", source,
    "--project-root", sourceRoot,
    "--project-id", "orchestrated-source",
    "--show", "book-talk",
    "--development",
    "--confirm-execute",
  ]).stdout);
  const sourceManifest = readJson(started.files.manifest);
  if (
    started.status !== "pass"
    || started.milestones.length !== 4
    || started.stages.length !== 13
    || sourceManifest.intelligenceV6?.required !== true
    || sourceManifest.productionQualityV1?.required !== true
    || sourceManifest.runtimeLock?.mode !== "development"
    || sourceManifest.source?.sha256 !== sha256File(source)
    || !sourceManifest.plans?.qualityEfficiency
    || !sourceManifest.plans?.productionQuality
    || !fs.existsSync(path.join(sourceRoot, "contracts", "production-quality-contract.json"))
    || started.efficiency?.policyVersion !== "8.0"
    || started.efficiency?.representativePreview?.fullCandidatePlaybackRequired !== true
    || started.efficiency?.representativePreview?.finalVideoEncodeBudget !== 1
  ) {
    throw new Error("source project did not freeze V6, runtime and media identity");
  }
  const sourceQualityContract = readJson(
    path.join(sourceRoot, "contracts", "production-quality-contract.json"),
  );
  if (
    sourceQualityContract.policies?.productionProfile?.packId !== "xingzhe-dahui"
    || sourceQualityContract.policies?.productionProfile?.showId !== sourceManifest.show
  ) throw new Error("orchestrator did not propagate the selected show into production quality");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "production-quality", "validate",
    "--contract", path.join(sourceRoot, "contracts", "production-quality-contract.json"),
    "--stage", "plan",
  ]);
  const advanced = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "run", sourceRoot,
  ]).stdout);
  if (
    advanced.nextAction?.id !== "author_project_contracts"
    || !fs.existsSync(advanced.nextAction.packet)
    || !advanced.nextAction.packetSha256
  ) {
    throw new Error("orchestrator did not create a recoverable planning packet");
  }
  const efficiencyPlanFile = path.join(sourceRoot, ".kacha", "efficiency-plan.json");
  fs.writeFileSync(efficiencyPlanFile, "{invalid-json");
  const blockedStatus = JSON.parse(expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "status", sourceRoot,
  ]).stdout);
  if (
    blockedStatus.status !== "blocked"
    || blockedStatus.nextAction?.id !== "refresh_efficiency_evidence"
    || blockedStatus.efficiency?.validation?.status !== "blocked"
  ) throw new Error("corrupt efficiency evidence was not surfaced as a recoverable blocker");
  const blockedObservation = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "observe",
    "--project-root", sourceRoot,
  ]).stdout);
  if (blockedObservation.efficiency?.status !== "blocked") {
    throw new Error("observability trusted or crashed on a corrupt efficiency plan");
  }
  const recoveredStatus = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "run", sourceRoot,
  ]).stdout);
  if (
    recoveredStatus.efficiency?.status !== "pass"
    || !fs.existsSync(efficiencyPlanFile)
    || readJson(efficiencyPlanFile).status !== "pass"
  ) throw new Error("orchestrator did not recover a corrupt efficiency plan from current inputs");

  const scriptInput = path.join(temporary, "orchestrator-script.md");
  fs.writeFileSync(scriptInput, "# 中心问题\n\n用真实证据解释一个问题。\n");
  const contentRoot = path.join(temporary, "orchestrated-content-project");
  const content = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "start",
    "--script", scriptInput,
    "--task", "content_generation",
    "--project-root", contentRoot,
    "--project-id", "orchestrated-content",
    "--show", "book-talk",
    "--development",
    "--confirm-execute",
  ]).stdout);
  const contentContract = readJson(content.files.contentContract);
  if (
    content.files.manifest !== null
    || content.nextAction?.id !== "develop_content_package"
    || contentContract.kind !== "kacha-content-project"
    || contentContract.intelligenceV6?.requiredOnSourceEditHandoff !== true
    || contentContract.input.sha256 !== sha256File(scriptInput)
  ) {
    throw new Error("script-first content project still depends on a source video");
  }
  const plannedContent = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "run", contentRoot,
  ]).stdout);
  if (
    plannedContent.nextAction?.id !== "review_content_package"
    || plannedContent.lifecycle?.status !== "awaiting_content_review"
    || !fs.existsSync(path.join(contentRoot, "contracts", "content-spine.json"))
    || !fs.existsSync(path.join(contentRoot, "contracts", "fact-check-tasks.json"))
    || !fs.existsSync(path.join(contentRoot, "contracts", "recording-plan.json"))
    || !fs.existsSync(path.join(contentRoot, "contracts", "source-edit-handoff.json"))
    || readJson(path.join(contentRoot, "contracts", "source-edit-handoff.json")).status !== "awaiting_source_media"
  ) {
    throw new Error("script-first flow did not create a gated content and recording package");
  }
}, "core");

await test("V8 efficiency plan selects current-evidence representative ranges and preserves quality invariants", () => {
  const root = path.join(temporary, "efficiency-plan-v8");
  fs.mkdirSync(path.join(root, ".kacha"), { recursive: true });
  writeJson(path.join(root, ".kacha", "orchestration.json"), {
    schemaVersion: "1.0",
    kind: "kacha-production-orchestration",
    projectId: "efficiency-plan-v8",
    projectRoot: root,
    task: "source_edit",
    input: {
      type: "video",
      sha256: sha256Value("efficiency-plan-v8-source"),
      media: { durationSeconds: 120, fps: 25 },
      readOnly: true,
    },
  });
  const cues = path.join(root, "cues.json");
  writeJson(cues, {
    schemaVersion: "1.0",
    cues: [
      { id: "hook", start: 0, end: 5, signals: ["hook"] },
      { id: "typical", start: 25, end: 31, signals: ["ordinary_speech"] },
      { id: "evidence", start: 49, end: 56, signals: ["fact", "subtitle_dense"] },
      { id: "mask", start: 70, end: 78, signals: ["mask", "tracking"] },
      { id: "audio", start: 83, end: 89, signals: ["audio_transition"] },
      { id: "ending", start: 112, end: 120, signals: ["conclusion"] },
    ],
  });
  const planned = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "plan", root,
    "--cues", cues,
  ]).stdout).plan;
  const categories = new Set(planned.representativePreview.ranges.flatMap(
    (range) => range.categories ?? [range.category],
  ));
  for (const category of [
    "opening", "typical_information", "complex_visual", "ending",
    "subtitle_density", "factual_evidence", "mask_tracking", "audio_transition",
  ]) {
    if (!categories.has(category)) throw new Error(`representative range missing ${category}`);
  }
  if (
    planned.status !== "pass"
    || planned.representativePreview.structuralFallbacks !== 0
    || planned.qualityInvariants.fullCandidatePlaybackRequired !== true
    || planned.qualityInvariants.singleFinalVideoEncode !== true
    || planned.schedule.parallelWaves !== 2
    || !planned.schedule.waves.some((wave) => (
      wave.stages.includes("rough_cut") && wave.stages.includes("dialogue_preprocess")
    ))
  ) throw new Error("V8 first-edit efficiency contract is incomplete");
  const expectedCacheKey = "c".repeat(64);
  const cacheBoundPlan = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "plan", root,
    "--cues", cues,
    "--applicable-cache-kinds", "asr",
    "--expected-cache-keys", `asr:${expectedCacheKey}`,
  ]).stdout).plan;
  if (
    cacheBoundPlan.cache?.keyBindingStatus !== "declared"
    || cacheBoundPlan.cache?.expectedEntries?.[0]?.key !== expectedCacheKey
  ) throw new Error("efficiency plan did not bind the current expected cache content key");
  const tamperedFile = path.join(root, "tampered-efficiency-plan.json");
  planned.qualityInvariants.fullCandidatePlaybackRequired = false;
  writeJson(tamperedFile, planned);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "validate", tamperedFile,
  ]);
  const currentPlanFile = path.join(root, ".kacha", "efficiency-plan.json");
  const changedCues = readJson(cues);
  changedCues.cues[1].end = 32;
  writeJson(cues, changedCues);
  const stale = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "validate", currentPlanFile,
  ]);
  if (!stale.stdout.includes("efficiency plan input changed: cues")) {
    throw new Error("changed cue evidence did not invalidate the efficiency plan");
  }
  const refreshed = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "plan", root,
    "--cues", cues,
  ]).stdout).plan;
  if (refreshed.cache?.expectedEntries?.[0]?.key !== expectedCacheKey) {
    throw new Error("refresh silently discarded the current expected cache key registry");
  }
  refreshed.representativePreview.finalVideoEncodeBudget = 9;
  const stable = structuredClone(refreshed);
  delete stable.generatedAt;
  delete stable.digest;
  delete stable.status;
  delete stable.validation;
  refreshed.digest = sha256Value(stable);
  writeJson(tamperedFile, refreshed);
  const recomputedTamper = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "validate", tamperedFile,
  ]);
  if (!recomputedTamper.stdout.includes("encode budget was weakened")) {
    throw new Error("a recomputed digest bypassed the immutable encode budget");
  }
  const malformedFile = path.join(root, "malformed-efficiency-plan.json");
  writeJson(malformedFile, []);
  const malformed = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "validate", malformedFile,
  ]);
  if (!malformed.stdout.includes("efficiency plan identity is invalid")) {
    throw new Error("malformed efficiency plan crashed instead of returning blocked validation");
  }
  const evidenceRegistryFile = path.join(root, ".kacha", "efficiency-inputs.json");
  fs.unlinkSync(evidenceRegistryFile);
  fs.writeFileSync(currentPlanFile, "{invalid-json");
  const unrecoverable = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "plan", root,
  ]);
  if (!unrecoverable.stderr.includes("no valid efficiency input registry")) {
    throw new Error("corrupt plan silently discarded cues without an independent input registry");
  }
  const explicitlyRecovered = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "plan", root,
    "--clear-cues", "--clear-delta",
  ]).stdout).plan;
  if (explicitlyRecovered.status !== "pass" || explicitlyRecovered.inputs.cues !== null) {
    throw new Error("explicitly clearing both unavailable evidence inputs did not recover the plan");
  }
}, "core");

await test("V8 incremental representative ranges cover every changed interval within a three-range budget", () => {
  const root = path.join(temporary, "efficiency-incremental-v8");
  fs.mkdirSync(path.join(root, ".kacha"), { recursive: true });
  writeJson(path.join(root, ".kacha", "orchestration.json"), {
    schemaVersion: "1.0",
    kind: "kacha-production-orchestration",
    projectId: "efficiency-incremental-v8",
    projectRoot: root,
    task: "source_edit",
    input: {
      type: "video",
      sha256: sha256Value("efficiency-incremental-v8-source"),
      media: { durationSeconds: 180, fps: 25 },
      readOnly: true,
    },
  });
  const deltaFile = path.join(root, "version-delta.json");
  const intervals = [0, 5, 100, 105, 110].map((start, index) => ({
    id: String.fromCharCode(97 + index),
    startSeconds: start,
    endSeconds: start + 1,
  }));
  writeJson(deltaFile, {
    schemaVersion: "2.0",
    changeSet: {
      types: ["visual_interval"],
      scope: { kind: "intervals", intervals },
    },
  });
  const planned = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "plan", root,
    "--delta", deltaFile,
  ]).stdout).plan;
  const ranges = planned.representativePreview.ranges;
  if (planned.mode !== "incremental" || ranges.length !== 3 || planned.status !== "pass") {
    throw new Error("incremental efficiency plan did not preserve its three-range contract");
  }
  for (const interval of intervals) {
    if (!ranges.some((range) => (
      range.startSeconds <= interval.startSeconds && range.endSeconds >= interval.endSeconds
    ))) throw new Error(`changed interval ${interval.id} is not covered`);
  }
  if (Math.max(...ranges.map((range) => range.durationSeconds)) > 15) {
    throw new Error("range grouping created an avoidable long preview instead of minimizing total span");
  }
  writeJson(deltaFile, {
    schemaVersion: "2.0",
    changeSet: {
      types: ["visual_interval"],
      scope: {
        kind: "intervals",
        intervals: [0, 50, 100, 150].map((start, index) => ({
          id: `distant-${index + 1}`,
          startSeconds: start,
          endSeconds: start + 1,
        })),
      },
    },
  });
  const disclosed = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "plan", root,
    "--delta", deltaFile,
  ]).stdout).plan;
  if (!disclosed.representativePreview.ranges.some((range) => range.durationBudgetException)) {
    throw new Error("an unavoidable long grouped range did not disclose its budget exception");
  }
  writeJson(deltaFile, {
    schemaVersion: "2.0",
    changeSet: {
      types: ["style_change"],
      scope: { kind: "full", intervals: [] },
    },
  });
  const fullScope = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "plan", root,
    "--delta", deltaFile,
  ]).stdout).plan;
  if (
    fullScope.status !== "pass"
    || fullScope.representativePreview.ranges.length !== 3
    || !fullScope.representativePreview.ranges.every((range) => range.requiresHumanConfirmation)
  ) throw new Error("full-scope style rework did not receive three explicit representative samples");
}, "incremental");

await test("V8 high-value cache audit requires source, implementation and output SHA evidence", () => {
  const root = path.join(temporary, "efficiency-cache-v8");
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, "source.wav");
  const implementation = path.join(root, "asr-implementation.mjs");
  const output = path.join(root, "transcript.json");
  fs.writeFileSync(source, "frozen source audio identity");
  fs.writeFileSync(implementation, "export const version = 'v8';\n");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "cache", "run",
    "--project-root", root,
    "--kind", "asr",
    "--input", source,
    "--implementation", implementation,
    "--parameters", JSON.stringify({ language: "zh", model: "fixture" }),
    "--operation-version", "8",
    "--output", `transcript=${output}`,
    "--",
    process.execPath,
    "-e", "require('fs').writeFileSync(process.argv[1], JSON.stringify({text:'ok'}))",
    output,
  ]);
  const kindRoot = path.join(root, ".kacha", "cache", "asr");
  const cacheKey = fs.readdirSync(kindRoot).find((name) => !name.startsWith("."));
  const unbound = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "cache-audit", root,
    "--applicable-cache-kinds", "asr",
  ]);
  if (!unbound.stdout.includes("no expected content-addressed cache key")) {
    throw new Error("cache audit treated an arbitrary ready entry as a current planned cache hit");
  }
  const audited = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "cache-audit", root,
    "--applicable-cache-kinds", "asr",
    "--expected-cache-keys", `asr:${cacheKey}`,
  ]).stdout).report;
  const asr = audited.kinds.find((item) => item.kind === "asr");
  if (
    audited.status !== "pass"
    || audited.productionReady !== true
    || audited.warmCoverage !== 1
    || asr?.readyEntries !== 1
  ) throw new Error("strong-fingerprint cache evidence was not accepted");
  const manifestFile = path.join(kindRoot, cacheKey, "manifest.json");
  const manifest = readJson(manifestFile);
  const originalManifest = structuredClone(manifest);
  manifest.contract.parameters.language = "tampered";
  writeJson(manifestFile, manifest);
  const keyMismatch = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "cache-audit", root,
    "--applicable-cache-kinds", "asr",
    "--expected-cache-keys", `asr:${cacheKey}`,
  ]);
  if (!keyMismatch.stdout.includes("cache key does not match the contract digest")) {
    throw new Error("cache audit accepted a contract that no longer matched its content key");
  }
  writeJson(manifestFile, originalManifest);
  const missingImplementation = readJson(manifestFile);
  missingImplementation.contract.implementation = [];
  writeJson(manifestFile, missingImplementation);
  const failed = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "cache-audit", root,
    "--applicable-cache-kinds", "asr",
    "--expected-cache-keys", `asr:${cacheKey}`,
  ]);
  if (!failed.stdout.includes("implementation SHA-256 evidence missing")) {
    throw new Error("cache audit did not disclose missing implementation evidence");
  }
  const linkedRoot = path.join(temporary, "efficiency-cache-symlink-v8");
  const linkedTarget = path.join(temporary, "efficiency-cache-symlink-target-v8");
  fs.mkdirSync(path.join(linkedRoot, ".kacha"), { recursive: true });
  fs.mkdirSync(linkedTarget, { recursive: true });
  fs.symlinkSync(linkedTarget, path.join(linkedRoot, ".kacha", "cache"));
  const linkedFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "cache-audit", linkedRoot,
    "--applicable-cache-kinds", "asr",
    "--expected-cache-keys", `asr:${"b".repeat(64)}`,
  ]);
  if (!linkedFailure.stdout.includes("cache root is a symbolic link")) {
    throw new Error("cache audit followed a symbolic-link cache root");
  }
}, "core");

await test("V8 dependency executor runs safe parallel tasks through host locks and telemetry", () => {
  const root = path.join(temporary, "efficiency-executor-v8");
  fs.mkdirSync(root, { recursive: true });
  const firstOutput = path.join(root, "first.txt");
  const secondOutput = path.join(root, "second.txt");
  const contractFile = path.join(root, "execution-plan.json");
  const routeScript = path.join(scripts, "route_references.mjs");
  const commandSha256 = sha256File(routeScript);
  writeJson(contractFile, {
    schemaVersion: "1.0",
    kind: "kacha-efficiency-execution-plan",
    projectRoot: root,
    authorization: {
      localExecution: true,
      upload: false,
      paidGeneration: false,
      publish: false,
      overwriteSource: false,
    },
    tasks: [
      {
        id: "prepare-a",
        argv: [process.execPath, routeScript, "--task", "proposal_review", "--stage", "inventory", "--output", firstOutput],
        commandSha256,
        prerequisites: [],
        resources: ["cpuHeavy"],
        outputs: [firstOutput],
        safeToAutoExecute: true,
        allowParallel: true,
      },
      {
        id: "prepare-b",
        argv: [process.execPath, routeScript, "--task", "source_edit", "--stage", "inventory", "--output", secondOutput],
        commandSha256,
        prerequisites: [],
        resources: ["cpuHeavy"],
        outputs: [secondOutput],
        safeToAutoExecute: true,
        allowParallel: true,
      },
    ],
  });
  const executed = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "execute", contractFile,
  ]).stdout).report;
  const metrics = readJson(path.join(root, ".kacha", "metrics", "run-metrics.json"));
  if (
    executed.status !== "pass"
    || executed.schedule.waves[0]?.parallel !== true
    || executed.results.length !== 2
    || metrics.events !== 2
    || readJson(firstOutput).task !== "proposal_review"
    || readJson(secondOutput).task !== "source_edit"
  ) throw new Error("safe task wave did not preserve execution, resource and telemetry evidence");
  const unsafeFile = path.join(root, "unsafe-execution-plan.json");
  const unsafe = readJson(contractFile);
  unsafe.tasks[1].outputs = [firstOutput];
  writeJson(unsafeFile, unsafe);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "execute", unsafeFile,
  ]);
  const inlineFile = path.join(root, "inline-execution-plan.json");
  const inline = readJson(contractFile);
  inline.tasks = [{
    ...inline.tasks[0],
    id: "inline-code",
    argv: [process.execPath, "-e", "process.exit(0)"],
    outputs: [path.join(root, "inline.txt")],
  }];
  writeJson(inlineFile, inline);
  const inlineFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "execute", inlineFile,
  ]);
  if (!inlineFailure.stderr.includes("inline code is forbidden")) {
    throw new Error("efficiency executor accepted an inline arbitrary Node.js command");
  }
  const mismatchedOutputFile = path.join(root, "mismatched-output-plan.json");
  const mismatchedOutput = readJson(contractFile);
  mismatchedOutput.tasks = [{
    ...mismatchedOutput.tasks[0],
    id: "mismatched-output",
    argv: [
      process.execPath, routeScript, "--task", "proposal_review", "--stage", "inventory",
      "--output", path.join(root, "undeclared.txt"),
    ],
    outputs: [path.join(root, "declared.txt")],
  }];
  writeJson(mismatchedOutputFile, mismatchedOutput);
  const mismatchedFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "execute", mismatchedOutputFile,
  ]);
  if (!mismatchedFailure.stderr.includes("must exactly match its declared output")) {
    throw new Error("efficiency executor accepted an undeclared command output path");
  }
  const unregisteredFile = path.join(root, "unregistered-execution-plan.json");
  const unregistered = readJson(contractFile);
  const unregisteredScript = path.join(scripts, "plan_incremental_build.mjs");
  unregistered.tasks = [{
    ...unregistered.tasks[0],
    id: "unregistered-script",
    argv: [process.execPath, unregisteredScript, "--help"],
    commandSha256: sha256File(unregisteredScript),
    outputs: [path.join(root, "unregistered.txt")],
  }];
  writeJson(unregisteredFile, unregistered);
  const unregisteredFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "execute", unregisteredFile,
  ]);
  if (!unregisteredFailure.stderr.includes("not registered for deterministic execution")) {
    throw new Error("efficiency executor accepted an unregistered bundled script");
  }
  const outside = path.join(temporary, "efficiency-symlink-outside.txt");
  const linkedOutput = path.join(root, "linked-output.txt");
  fs.symlinkSync(outside, linkedOutput);
  const symlinkFile = path.join(root, "symlink-execution-plan.json");
  const symlink = readJson(contractFile);
  symlink.tasks = [{
    ...symlink.tasks[0],
    id: "symlink-output",
    argv: [process.execPath, routeScript, "--task", "proposal_review", "--stage", "inventory", "--output", linkedOutput],
    outputs: [linkedOutput],
  }];
  writeJson(symlinkFile, symlink);
  const symlinkFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "execute", symlinkFile,
  ]);
  if (!symlinkFailure.stderr.includes("symbolic link")) {
    throw new Error("efficiency executor accepted a broken output symlink");
  }
}, "core");

await test("V8 efficiency comparison refuses claims before eight paired human-reviewed projects", () => {
  const root = path.join(temporary, "efficiency-evidence-v8");
  fs.mkdirSync(root, { recursive: true });
  const requiredGuardrails = [
    "semanticIntegrity", "connectionPlayback", "subtitleAccuracy",
    "visualContinuity", "audioQuality", "fullCandidatePlayback",
  ];
  const mediaFixtures = Array.from({ length: 8 }, (_, index) => {
    const source = path.join(root, `source-${index + 1}.mp4`);
    const candidateOutput = path.join(root, `candidate-${index + 1}.mp4`);
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=0.4",
      "-f", "lavfi", "-i", `sine=frequency=${300 + index * 20}:sample_rate=48000:duration=0.4`,
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", source,
    ]);
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", source,
      "-vf", "eq=brightness=0.02", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", "-c:a", "aac", candidateOutput,
    ]);
    return { source, candidateOutput };
  });
  const buildProject = (index, variant, seconds) => {
    const projectId = `paired-${index + 1}`;
    const source = fileIdentity(mediaFixtures[index].source);
    const output = fileIdentity(
      variant === "baseline" ? mediaFixtures[index].source : mediaFixtures[index].candidateOutput,
    );
    const reviewer = "contract-test-reviewer";
    const evidenceRoot = path.join(root, "evidence", projectId, variant);
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const humanFile = path.join(evidenceRoot, "human-review.json");
    writeJson(humanFile, {
      schemaVersion: "1.0",
      kind: "kacha-efficiency-human-review-evidence",
      variant,
      projectId,
      sourceSha256: source.sha256,
      outputSha256: output.sha256,
      reviewer,
      reviewedAt: "2026-08-09T00:00:00.000Z",
      status: "pass",
    });
    const wallSeconds = seconds + index;
    const videoEncodes = variant === "candidate" ? 1 : 2;
    const metricsFile = path.join(evidenceRoot, "metrics.json");
    writeJson(metricsFile, {
      schemaVersion: "1.0",
      kind: "kacha-efficiency-metrics-evidence",
      variant,
      projectId,
      sourceSha256: source.sha256,
      outputSha256: output.sha256,
      wallSeconds,
      videoEncodes,
    });
    const guardrailEvidence = {};
    for (const guardrail of requiredGuardrails) {
      const file = path.join(evidenceRoot, `${guardrail}.json`);
      writeJson(file, {
        schemaVersion: "1.0",
        kind: "kacha-efficiency-guardrail-evidence",
        variant,
        projectId,
        sourceSha256: source.sha256,
        outputSha256: output.sha256,
        guardrail,
        status: "pass",
      });
      guardrailEvidence[guardrail] = fileIdentity(file);
    }
    return {
      projectId,
      sourceSha256: source.sha256,
      source,
      outputSha256: output.sha256,
      output,
      wallSeconds,
      videoEncodes,
      humanReview: {
        status: "pass",
        reviewer,
        evidence: fileIdentity(humanFile),
      },
      metricsEvidence: fileIdentity(metricsFile),
      guardrails: Object.fromEntries(requiredGuardrails.map((guardrail) => [guardrail, "pass"])),
      guardrailEvidence,
    };
  };
  const baselineProjects = Array.from({ length: 8 }, (_, index) => buildProject(index, "baseline", 100));
  const candidateProjects = Array.from({ length: 8 }, (_, index) => buildProject(index, "candidate", 80));
  const cohort = (variant, projects) => ({
    schemaVersion: "1.0",
    kind: "kacha-efficiency-evidence-cohort",
    variant,
    projects,
  });
  const baselineFile = path.join(root, "baseline.json");
  const candidateFile = path.join(root, "candidate.json");
  writeJson(baselineFile, cohort("baseline", baselineProjects.slice(0, 7)));
  writeJson(candidateFile, cohort("candidate", candidateProjects.slice(0, 7)));
  const insufficient = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "compare", baselineFile, candidateFile,
  ]);
  if (!insufficient.stdout.includes("paired projects 7 < 8")) {
    throw new Error("efficiency claim gate did not explain its minimum cohort requirement");
  }
  writeJson(baselineFile, cohort("baseline", baselineProjects));
  writeJson(candidateFile, cohort("candidate", candidateProjects));
  const supported = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "compare", baselineFile, candidateFile,
  ]).stdout);
  if (
    supported.supportsEfficiencyClaim !== true
    || supported.pairedProjects !== 8
    || !(supported.totals.improvementRatio > 0)
  ) throw new Error("complete paired evidence was not recognized");
  const duplicateBaseline = readJson(baselineFile);
  const duplicateCandidate = readJson(candidateFile);
  duplicateBaseline.projects[7].sourceSha256 = duplicateBaseline.projects[0].sourceSha256;
  duplicateCandidate.projects[7].sourceSha256 = duplicateCandidate.projects[0].sourceSha256;
  writeJson(baselineFile, duplicateBaseline);
  writeJson(candidateFile, duplicateCandidate);
  const duplicated = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "compare", baselineFile, candidateFile,
  ]);
  if (!duplicated.stdout.includes("distinct source groups")) {
    throw new Error("duplicate source groups were counted as separate paired projects");
  }
  writeJson(baselineFile, cohort("baseline", baselineProjects));
  writeJson(candidateFile, cohort("candidate", candidateProjects));
  const regressed = readJson(candidateFile);
  regressed.projects[0].guardrails.semanticIntegrity = "fail";
  writeJson(candidateFile, regressed);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "compare", baselineFile, candidateFile,
  ]);
  writeJson(candidateFile, cohort("candidate", candidateProjects));
  const fabricated = readJson(candidateFile);
  fabricated.projects[0].metricsEvidence = {
    path: path.join(root, "missing-metrics.json"),
    sha256: "a".repeat(64),
  };
  writeJson(candidateFile, fabricated);
  const fabricatedFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "efficiency", "compare", baselineFile, candidateFile,
  ]);
  if (!fabricatedFailure.stdout.includes("current file identity changed")) {
    throw new Error("formatted but non-file-backed metrics evidence supported an efficiency claim");
  }
}, "core");

await test("V7 release review binds eleven human checks to the current final video", () => {
  const root = path.join(temporary, "release-review-v7");
  const contracts = path.join(root, "contracts");
  const output = path.join(root, "output");
  fs.mkdirSync(contracts, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const finalVideo = path.join(output, "final.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x28231e:s=160x90:r=12:d=0.6",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=0.6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", finalVideo,
  ]);
  const manifest = path.join(contracts, "project-manifest.json");
  writeJson(manifest, {
    schemaVersion: "2.0",
    kind: "kacha-project-manifest",
    projectId: "release-review-v7",
    outputs: {
      finalVideo: { path: "../output/final.mp4" },
      releaseReport: { path: "../output/release-report.json" },
    },
  });
  const initialized = initializeReleaseReview(manifest, { reviewer: "test-reviewer" });
  if (initialized.checks.length !== 11 || initialized.summary.passed !== 0) {
    throw new Error("release review did not initialize the eleven current-video checks");
  }
  const failed = recordReleaseCheck(manifest, {
    reviewer: "test-reviewer", checkId: initialized.checks[0].id, outcome: "fail",
    evidence: [], note: "开头承诺和正文不一致，需要返工。",
  });
  const changeRequest = failed.checks[0].changeRequest?.path;
  if (!changeRequest || readJson(changeRequest).status !== "pending_agent_compilation") {
    throw new Error("failed release check did not create a bounded change request");
  }
  for (const check of initialized.checks) {
    recordReleaseCheck(manifest, {
      reviewer: "test-reviewer", checkId: check.id, outcome: "pass",
      evidence: [`normal-speed-review:${check.id}`], note: "",
    });
  }
  const approved = approveReleaseReview(manifest, { reviewer: "test-reviewer", limitations: ["none"] });
  if (!approved.summary.approved || approved.report.finalVideoSha256 !== sha256File(finalVideo)) {
    throw new Error("release review approval was not bound to the current final video");
  }
  fs.appendFileSync(finalVideo, "changed");
  if (openReleaseReview(manifest).status !== "blocked") {
    throw new Error("changed final video did not invalidate the release review");
  }
}, "qc");

await test("V7 asset inbox records licensed submissions without bypassing media reindex", () => {
  const root = path.join(temporary, "asset-inbox-v7");
  const contracts = path.join(root, "contracts");
  fs.mkdirSync(contracts, { recursive: true });
  const gapPlan = path.join(contracts, "asset-gap-plan.json");
  writeJson(gapPlan, {
    schemaVersion: "1.0",
    kind: "kacha_asset_gap_plan",
    gaps: [
      {
        id: "gap-evidence", beatId: "beat-1", range: { start: 0, end: 2 },
        query: "官方截图", evidenceType: "factual", resolution: "user_or_source_evidence_required",
        candidates: [], generationSpec: null, blocker: true, blockerReason: "source_evidence_required",
      },
      {
        id: "gap-illustration", beatId: "beat-2", range: { start: 2, end: 4 },
        query: "抽象流程", evidenceType: "illustrative", resolution: "generated_visual_candidate",
        candidates: [], generationSpec: { promptBrief: "抽象流程", externalOrPaidActionAuthorized: false },
        blocker: true, blockerReason: "generated_asset_not_materialized",
      },
    ],
  });
  const manifest = path.join(contracts, "project-manifest.json");
  writeJson(manifest, {
    schemaVersion: "2.0", kind: "kacha-project-manifest", projectId: "asset-inbox-v7",
    plans: { assetGapPlan: "./asset-gap-plan.json" }, outputs: {},
  });
  const built = buildAssetInbox(manifest);
  if (built.inbox.summary.total !== 2 || built.inbox.summary.productionReady !== false) {
    throw new Error("asset inbox did not preserve unresolved factual and generated gaps");
  }
  const asset = path.join(root, "official-evidence.png");
  fs.writeFileSync(asset, "licensed evidence fixture");
  const attached = attachAsset(manifest, {
    gapId: "gap-evidence", assetPath: asset, license: "project-owned",
    provenanceKind: "user-provided", provenanceEvidence: "source capture record",
  });
  if (attached.inbox.items[0].status !== "pending_reindex" || attached.inbox.summary.productionReady !== false) {
    throw new Error("asset submission bypassed the media index and rebuilt gap plan requirement");
  }
  if (validateAssetInbox(built.path).status !== "pass") throw new Error("asset inbox validation failed");
  fs.appendFileSync(asset, "changed");
  if (validateAssetInbox(built.path).status !== "blocked") throw new Error("asset identity drift was not detected");
}, "core");

await test("V7 evaluation cohort and NLE application protocol refuse synthetic production claims", () => {
  const cohortFile = path.join(temporary, "editorial-cohort-v7.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "cohort-template", "--output", cohortFile,
  ]);
  const cohort = readJson(cohortFile);
  if (
    cohort.cases.length !== 8
    || new Set(cohort.cases.map((item) => item.showId)).size !== 5
    || new Set(cohort.cases.map((item) => item.styleId)).size !== 5
    || cohort.cases.some((item) => item.editorialJudgment.humanReviewed !== false)
  ) throw new Error("V7 cohort template does not preserve eight real human-review slots");
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "validate", "--dataset", cohortFile,
  ]);
  const nle = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "nle-app", "detect",
  ]).stdout);
  if (
    !["pass", "unavailable"].includes(nle.status)
    || nle.applications.length !== 3
    || nle.applications.some((item) => item.installed && !item.version)
  ) throw new Error("NLE application evidence protocol did not report real installation state");
}, "core");

await test("caption layout plan renders relationship layouts and guarded depth text", () => {
  ensureMediaFixtures();
  const cues = path.join(temporary, "caption-layout-cues.json");
  writeJson(cues, [
    {
      id: "contrast",
      start: 0,
      end: 0.9,
      text: "不是堆效果，而是讲关系",
      captionLayout: "left_right_contrast",
      fontRole: "caption_tech",
      display: { left: "堆效果", right: "讲关系" },
    },
    {
      id: "depth",
      start: 1,
      end: 1.9,
      text: "人物和观点形成前后层次",
      captionLayout: "oversize_background_word",
      display: { background: "层次", foreground: "人物和观点" },
    },
  ]);
  const planFile = path.join(temporary, "caption-layout-plan.json");
  const planned = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "captions", "plan",
    "--input", baseVideo,
    "--transcript", cues,
    "--mask", exactMask,
    "--output", planFile,
  ]).stdout);
  if (
    planned.eventCount !== 2
    || !planned.layouts.includes("left_right_contrast")
    || !planned.layouts.includes("oversize_background_word")
  ) {
    throw new Error("caption layout planner did not preserve explicit information relations");
  }
  if (readJson(planFile).events[0].font.roleId !== "caption_tech") {
    throw new Error("caption layout did not route typography by scene role");
  }
  const plannedValue = readJson(planFile);
  if (
    plannedValue.resources.mask.width !== 320
    || plannedValue.resources.mask.height !== 180
    || plannedValue.resources.mask.fps !== 25
    || Math.abs(plannedValue.resources.mask.duration - 2) > 0.04
    || plannedValue.resources.mask.frameCount !== 50
    || Math.abs(plannedValue.resources.mask.startTime) > 0.001
  ) {
    throw new Error("caption layout plan did not freeze mask media identity");
  }
  const output = path.join(temporary, "caption-layout.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "captions", "render",
    "--plan", planFile,
    "--output", output,
  ]);
  const summary = mediaSummary(output);
  const manifest = readJson(`${output}.manifest.json`);
  if (
    summary.width !== 320
    || summary.height !== 180
    || !summary.audio
    || manifest.qc.depthLayoutsUsedOnlyWithMask !== true
    || manifest.events.length !== 2
    || manifest.sfxPeakAlignmentPlan.length !== 2
    || manifest.sfxPeakAlignmentPlan.some((item) => (
      item.deltaFrames !== 0
      || item.targetLandingSeconds !== item.actualLandingSeconds
      || !Number.isFinite(item.measuredPeakOffsetSeconds)
    ))
  ) {
    throw new Error("caption layout render did not honor geometry, mask, or SFX contracts");
  }
  const invalid = readJson(planFile);
  invalid.resources.mask = null;
  invalid.digest = sha256Value({ ...invalid, digest: undefined });
  const invalidFile = path.join(temporary, "caption-layout-no-mask.json");
  writeJson(invalidFile, invalid);
  const failure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "captions", "validate",
    "--plan", invalidFile,
  ]);
  if (!failure.stderr.includes("蒙版")) {
    throw new Error("depth caption plan without a mask did not fail closed");
  }
  const shortMaskFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "captions", "plan",
    "--input", baseVideo,
    "--transcript", cues,
    "--mask", shortMask,
    "--output", path.join(temporary, "caption-layout-short-mask.json"),
  ]);
  if (!shortMaskFailure.stderr.includes("同尺寸、同帧率和同帧数")) {
    throw new Error("caption layout accepted a temporally misaligned person mask");
  }
}, "visual");

await test("cinematic text scenes route show identity, typography layers, and density gates", () => {
  ensureMediaFixtures();
  const cues = path.join(temporary, "cinematic-text-scene-cues.json");
  writeJson(cues, [
    {
      id: "editorial",
      start: 0,
      end: 0.58,
      text: "真正省时间的是工作流",
      textScene: {
        show: "tool-share",
        layout: "editorial_stack",
        anchor: "left",
        progressMode: "micro_rail",
        entryFrames: 6,
        rotationDegrees: 0.8,
        displayOpacity: 0.9,
      },
      display: { primary: "工作流", secondary: "把重复步骤变成稳定路径", echo: "效率" },
      words: [
        { text: "真正省时间的", start: 0, end: 0.18 },
        { text: "是", start: 0.18, end: 0.35 },
        { text: "工作流", start: 0.35, end: 0.58 },
      ],
    },
    {
      id: "annotation",
      start: 0.62,
      end: 1.22,
      text: "上下文窗口决定模型能读多少信息",
      textScene: {
        show: "灰常AI",
        layout: "edge_annotation",
        anchor: "right",
        surface: "light",
      },
      display: { primary: "上下文", annotation: "一次推理可读取的信息范围" },
    },
    {
      id: "quote",
      start: 1.26,
      end: 1.88,
      text: "有限游戏以取胜为目的",
      textScene: { show: "解读好书", layout: "quote_field" },
      display: { primary: "有限游戏以取胜为目的", source: "《有限与无限的游戏》", echo: "取胜" },
    },
  ]);
  const planFile = path.join(temporary, "cinematic-text-scene-plan.json");
  const planned = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "plan",
    "--input", baseVideo,
    "--transcript", cues,
    "--show", "tool-share",
    "--output", planFile,
  ]).stdout);
  const plan = readJson(planFile);
  if (
    planned.eventCount !== 3
    || !planned.layouts.includes("editorial_stack")
    || !planned.layouts.includes("edge_annotation")
    || !planned.layouts.includes("quote_field")
    || plan.events[0].textScene.showProfile.id !== "tool_share"
    || plan.design.modes.show !== "tool-share"
    || plan.events[1].textScene.showProfile.id !== "very_ai"
    || plan.events[1].textScene.graphics.accent !== "#176E55"
    || plan.events[1].textScene.graphics.secondaryAccent !== "#315F52"
    || plan.events[2].textScene.showProfile.id !== "book_talk"
    || plan.events.some((event) => event.typography.reading.roleId !== "subtitle_primary")
    || plan.events.some((event) => event.typography.support.roleId !== "thin_support")
    || plan.events.some((event) => event.textScene.material.outline !== "none")
    || plan.events[0].textScene.lyricProgress.mode !== "micro_rail"
    || plan.events[0].wordTiming.length !== 3
    || plan.events[0].textScene.motion.entryFrames !== 6
    || plan.events[0].peakFrame !== plan.events[0].startFrame + 6
    || plan.events[0].entryStartFrame !== plan.events[0].startFrame
    || plan.events[0].visibleLandingFrame !== plan.events[0].peakFrame
    || plan.events[0].sfxPeakFrame !== plan.events[0].peakFrame
    || plan.events[0].sound.peakFrame !== plan.events[0].peakFrame
    || plan.events[0].textScene.spatial.rotationDegrees !== 0.8
    || plan.events[0].textScene.material.displayOpacity !== 0.9
  ) {
    throw new Error("cinematic text scene plan lost show, typography, or material contracts");
  }
  const output = path.join(temporary, "cinematic-text-scenes.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "render",
    "--plan", planFile,
    "--output", output,
  ]);
  const manifest = readJson(`${output}.manifest.json`);
  if (
    manifest.status !== "pass"
    || manifest.events.length !== 3
    || manifest.qc.strictTextSceneValidation !== "not_run_required_for_production_delivery"
  ) {
    throw new Error("cinematic text scene renderer did not produce a verified deliverable");
  }
  const strictFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "validate",
    "--plan", planFile,
    "--strict-text-scenes",
  ]);
  if (!strictFailure.stderr.includes("视觉留白")) {
    throw new Error("strict cinematic text density validation did not fail closed");
  }
  const fallbackPlan = readJson(planFile);
  fallbackPlan.events[0].font.file = null;
  fallbackPlan.events[0].font.sha256 = null;
  fallbackPlan.events[0].typography.display = fallbackPlan.events[0].font;
  fallbackPlan.fonts = fallbackPlan.fonts.map((font) => (
    font.roleId === fallbackPlan.events[0].font.roleId
      && font.family === fallbackPlan.events[0].font.family
      ? fallbackPlan.events[0].font
      : font
  ));
  fallbackPlan.digest = sha256Value({ ...fallbackPlan, digest: undefined });
  const fallbackPlanFile = path.join(temporary, "cinematic-text-scene-font-fallback.json");
  writeJson(fallbackPlanFile, fallbackPlan);
  const fallbackFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "validate",
    "--plan", fallbackPlanFile,
    "--strict-text-scenes",
  ]);
  if (!fallbackFailure.stderr.includes("严格模式禁止系统字体回退")) {
    throw new Error("strict cinematic text font fallback validation did not fail closed");
  }
  const invalidCues = path.join(temporary, "cinematic-text-scene-invalid.json");
  writeJson(invalidCues, [{
    id: "quote-without-source",
    start: 0,
    end: 1,
    text: "未经核实的引语",
    textScene: { show: "解读好书", layout: "quote_field" },
    display: { primary: "未经核实的引语" },
  }]);
  const invalidFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "plan",
    "--input", baseVideo,
    "--transcript", invalidCues,
    "--output", path.join(temporary, "invalid-quote-plan.json"),
  ]);
  if (!invalidFailure.stderr.includes("display.primary/source")) {
    throw new Error("quote field accepted an unverified source-less quote");
  }

  const invalidNumericCues = path.join(temporary, "cinematic-text-scene-invalid-number.json");
  writeJson(invalidNumericCues, [{
    id: "invalid-number",
    start: 0,
    end: 1,
    text: "非法参数不能进入计划",
    textScene: {
      show: "灰常AI",
      layout: "edge_annotation",
      rotationDegrees: "not-a-number",
    },
    display: { primary: "非法参数", annotation: "必须在计划阶段阻断" },
  }]);
  const invalidNumericFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "plan",
    "--input", baseVideo,
    "--transcript", invalidNumericCues,
    "--output", path.join(temporary, "invalid-number-plan.json"),
  ]);
  if (!invalidNumericFailure.stderr.includes("有限数值")) {
    throw new Error("caption plan accepted a non-finite text-scene parameter");
  }

  const overflowCues = path.join(temporary, "cinematic-text-scene-overflow.json");
  writeJson(overflowCues, [{
    id: "overflow",
    start: 0,
    end: 1,
    text: "超长背景文字不能被静默截断",
    captionLayout: "oversize_background_word",
    display: { background: "三个字", foreground: "完整阅读字幕" },
  }]);
  const overflowFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "plan",
    "--input", baseVideo,
    "--transcript", overflowCues,
    "--mask", exactMask,
    "--output", path.join(temporary, "overflow-plan.json"),
  ]);
  if (!overflowFailure.stderr.includes("display.background 超过 2 字")) {
    throw new Error("depth caption text was still silently truncated by the renderer contract");
  }

  const wordMismatchCues = path.join(temporary, "cinematic-text-scene-word-mismatch.json");
  writeJson(wordMismatchCues, [{
    id: "word-mismatch",
    start: 0,
    end: 1,
    text: "逐字时间必须覆盖完整文本",
    textScene: { show: "闲聊", layout: "plain_single", progressMode: "micro_rail" },
    words: [{ text: "逐字时间", start: 0, end: 1 }],
  }]);
  const wordMismatchFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "plan",
    "--input", baseVideo,
    "--transcript", wordMismatchCues,
    "--output", path.join(temporary, "word-mismatch-plan.json"),
  ]);
  if (!wordMismatchFailure.stderr.includes("words 文本与 cue.text 不一致")) {
    throw new Error("micro progress accepted incomplete word timing text");
  }

  const droppedCueFile = path.join(temporary, "cinematic-text-scene-invalid-cue.json");
  writeJson(droppedCueFile, [
    { id: "valid", start: 0, end: 0.8, text: "有效字幕" },
    { id: "invalid", start: 1, end: 1, text: "不能静默丢弃" },
  ]);
  const droppedCueFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "plan",
    "--input", baseVideo,
    "--transcript", droppedCueFile,
    "--output", path.join(temporary, "invalid-cue-plan.json"),
  ]);
  if (!droppedCueFailure.stderr.includes("时间区间无效")) {
    throw new Error("caption planning silently dropped an invalid transcript cue");
  }

  const tampered = readJson(planFile);
  tampered.densityAssessment.designedRatio = 0;
  tampered.digest = sha256Value({ ...tampered, digest: undefined });
  const tamperedFile = path.join(temporary, "cinematic-text-scene-tampered-density.json");
  writeJson(tamperedFile, tampered);
  const tamperedFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "validate", "--plan", tamperedFile,
  ]);
  if (!tamperedFailure.stderr.includes("densityAssessment")) {
    throw new Error("caption validation trusted a partially forged density assessment");
  }

  const rewritten = readJson(planFile);
  rewritten.events[0].display.primary = "被篡改的题眼";
  rewritten.digest = sha256Value({ ...rewritten, digest: undefined });
  const rewrittenFile = path.join(temporary, "cinematic-text-scene-rewritten-display.json");
  writeJson(rewrittenFile, rewritten);
  const rewrittenFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "captions", "validate", "--plan", rewrittenFile,
  ]);
  if (!rewrittenFailure.stderr.includes("无法从冻结 cue 重建")) {
    throw new Error("caption validation trusted rewritten display text after digest recomputation");
  }
}, "visual");

await test("visual breathing keeps deliberate stillness and aligns emphasis SFX", () => {
  const input = path.join(temporary, "visual-breathing-input.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:d=4:r=25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", input,
  ]);
  const cues = path.join(temporary, "visual-breathing-cues.json");
  writeJson(cues, [
    {
      id: "conclusion",
      start: 0.2,
      end: 2,
      text: "关键是有收有放",
      breathingIntent: "emphasis_punch_settle",
    },
  ]);
  const planFile = path.join(temporary, "visual-breathing-plan.json");
  const planned = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "breathing", "plan",
    "--input", input,
    "--transcript", cues,
    "--output", planFile,
  ]).stdout);
  if (
    planned.eventCount !== 1
    || planned.coverage.motionRatio > 0.55
    || planned.coverage.stillRatio < 0.45
  ) {
    throw new Error("visual breathing planner violated motion/still coverage");
  }
  const output = path.join(temporary, "visual-breathing.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "breathing", "render",
    "--plan", planFile,
    "--output", output,
  ]);
  const summary = mediaSummary(output);
  const manifest = readJson(`${output}.manifest.json`);
  if (
    summary.width !== 320
    || summary.height !== 180
    || !summary.audio
    || manifest.qc.stillCoveragePass !== true
    || manifest.sfxPeakAlignmentPlan.length !== 1
  ) {
    throw new Error("visual breathing render did not preserve media or SFX alignment plan");
  }
}, "visual");

await test("semantic netstyle registry validates and renders a deterministic showcase", () => {
  ensureMediaFixtures();
  const validation = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle",
    "validate",
  ]).stdout);
  if (validation.effectCount !== 33 || validation.sourceVideoCount !== 6) {
    throw new Error(
      `unexpected netstyle coverage: ${validation.effectCount}/${validation.sourceVideoCount}`,
    );
  }
  const list = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle",
    "list",
  ]).stdout);
  if (
    list.effects.length !== 33
    || new Set(list.effects.map((item) => item.family)).size !== 6
  ) {
    throw new Error("netstyle list does not expose 33 effects in six families");
  }
  const output = path.join(temporary, "netstyle-showcase.mp4");
  const result = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle",
    "showcase",
    "--input", baseVideo,
    "--duration", "0.6",
    "--max-effects", "2",
    "--output", output,
  ]).stdout);
  const summary = mediaSummary(output);
  if (
    result.effectCount !== 2
    || summary.width !== 320
    || summary.height !== 180
    || !summary.audio
  ) {
    throw new Error("netstyle showcase did not preserve media geometry and audio");
  }
  const decode = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", output, "-f", "null", "-",
  ]);
  if (decode.status !== 0 || decode.stderr.trim()) {
    throw new Error(`netstyle showcase has decode/timestamp errors: ${decode.stderr}`);
  }
}, "visual");

await test("semantic netstyle accepts an explicit pixel editorial visual language", () => {
  ensureMediaFixtures();
  const payload = path.join(temporary, "netstyle-pixel-payload.json");
  writeJson(payload, {
    display: {
      title: "算法在安排",
      subtitle: "选择被逐项标准化",
      items: ["住哪家酒店", "吃哪家美食", "去哪个打卡点"],
      itemCues: [
        { text: "住哪家酒店", revealAt: 0.12 },
        { text: "吃哪家美食", revealAt: 0.46 },
        { text: "去哪个打卡点", revealAt: 0.76 },
      ],
    },
  });
  const output = path.join(temporary, "netstyle-pixel.mp4");
  const rendered = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle", "preview",
    "--input", baseVideo,
    "--effect", "parallel_progressive_row",
    "--duration", "0.6",
    "--output", output,
    "--production",
    "--payload", payload,
    "--visual-language", "xingzhe-pixel-editorial",
    "--video-only",
    "--overwrite",
  ]).stdout);
  const summary = mediaSummary(output);
  if (
    rendered.visualLanguageId !== "xingzhe-pixel-editorial"
    || summary.width !== 320
    || summary.height !== 180
    || summary.audio
  ) {
    throw new Error("explicit pixel editorial visual language was not executed");
  }
  const invalid = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle", "preview",
    "--input", baseVideo,
    "--effect", "parallel_progressive_row",
    "--duration", "0.6",
    "--output", path.join(temporary, "netstyle-invalid-language.mp4"),
    "--production",
    "--payload", payload,
    "--visual-language", "missing-visual-language",
    "--video-only",
    "--overwrite",
  ]);
  if (!invalid.stderr.includes("视觉语言不存在")) {
    throw new Error("netstyle accepted an unknown visual language");
  }

  const missingCuePayload = path.join(temporary, "netstyle-pixel-missing-cues.json");
  writeJson(missingCuePayload, {
    display: {
      title: "错误示例",
      items: ["一起出现", "没有触发"],
    },
  });
  const missingCues = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle", "preview",
    "--input", baseVideo,
    "--effect", "parallel_progressive_row",
    "--duration", "0.6",
    "--output", path.join(temporary, "netstyle-missing-cues.mp4"),
    "--production",
    "--payload", missingCuePayload,
    "--visual-language", "xingzhe-pixel-editorial",
    "--video-only",
    "--overwrite",
  ]);
  if (
    !missingCues.stderr.includes("itemCues")
    || missingCues.stderr.includes("TypeError")
  ) {
    throw new Error("progressive list accepted production payload without semantic item cues");
  }

  const invalidCuePayload = path.join(temporary, "netstyle-pixel-invalid-cues.json");
  writeJson(invalidCuePayload, {
    display: {
      title: "越界示例",
      itemCues: [
        { text: "第一项", revealAt: 0.2 },
        { text: "第二项", revealAt: 0.96 },
      ],
    },
  });
  const invalidCues = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle", "preview",
    "--input", baseVideo,
    "--effect", "parallel_progressive_row",
    "--duration", "0.6",
    "--output", path.join(temporary, "netstyle-invalid-cues.mp4"),
    "--production",
    "--payload", invalidCuePayload,
    "--visual-language", "xingzhe-pixel-editorial",
    "--video-only",
    "--overwrite",
  ]);
  if (!invalidCues.stderr.includes("0–0.92")) {
    throw new Error("progressive list accepted an out-of-range semantic item cue");
  }
}, "visual");

await test("pixel opening starts fully covered without a partial-face aperture", () => {
  ensureMediaFixtures();
  const payload = path.join(temporary, "netstyle-pixel-opening-payload.json");
  writeJson(payload, {
    display: { title: "暑假出发", items: ["临时出发", "意外不断", "孩子很开心"] },
    motion: { startFullyCovered: true, fullCoverUntil: 0.26, revealDuration: 0.48 },
  });
  const output = path.join(temporary, "netstyle-pixel-opening.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle", "preview",
    "--input", baseVideo,
    "--effect", "hook_text_first_face_reveal",
    "--duration", "0.8",
    "--output", output,
    "--production",
    "--payload", payload,
    "--visual-language", "xingzhe-pixel-editorial",
    "--video-only",
    "--overwrite",
  ]);
  const center = path.join(temporary, "pixel-opening-center.gray");
  const corner = path.join(temporary, "pixel-opening-corner.gray");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", output,
    "-vf", "select=eq(n\\,0),crop=40:40:140:70,format=gray",
    "-frames:v", "1", "-f", "rawvideo", center,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", output,
    "-vf", "select=eq(n\\,0),crop=40:40:10:10,format=gray",
    "-frames:v", "1", "-f", "rawvideo", corner,
  ]);
  const average = (file) => {
    const bytes = fs.readFileSync(file);
    return [...bytes].reduce((sum, value) => sum + value, 0) / Math.max(1, bytes.length);
  };
  if (Math.abs(average(center) - average(corner)) > 2) {
    throw new Error("pixel opening frame zero exposes a partial center aperture");
  }
}, "visual");

await test("semantic netstyle production plan renders real timeline events without demo labels", () => {
  ensureMediaFixtures();
  const cues = path.join(temporary, "netstyle-production-cues.json");
  writeJson(cues, [
    {
      id: "hook",
      start: 0,
      end: 0.8,
      text: "为什么精剪不能只靠堆效果？",
      effectId: "hook_suspense_push",
      display: {
        title: "为什么不能堆效果？",
        subtitle: "先有叙事触发，再选视觉机制",
      },
    },
    {
      id: "conclusion",
      start: 1.05,
      end: 1.9,
      text: "所以，品味决定上限。",
      effectId: "semantic_importance_zoom",
      display: {
        title: "品味决定上限",
        subtitle: "结论",
      },
    },
  ]);
  const planFile = path.join(temporary, "netstyle-production-plan.json");
  const planned = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle",
    "plan",
    "--input", baseVideo,
    "--transcript", cues,
    "--output", planFile,
    "--max-effects-per-10", "6",
    "--minimum-gap", "0.1",
  ]).stdout);
  if (planned.eventCount !== 2) {
    throw new Error(`production planner expected 2 events, got ${planned.eventCount}`);
  }
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle",
    "validate-plan",
    "--plan", planFile,
  ]);
  const output = path.join(temporary, "netstyle-production.mp4");
  const rendered = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle",
    "render-plan",
    "--plan", planFile,
    "--output", output,
    "--no-sfx",
  ]).stdout);
  const summary = mediaSummary(output);
  const manifest = readJson(`${output}.manifest.json`);
  if (
    rendered.eventCount !== 2
    || summary.width !== 320
    || summary.height !== 180
    || !summary.audio
    || manifest.appliedEvents.length !== 2
    || manifest.qc.demoLabelsAbsent !== true
    || manifest.audio.sourcePreservedAtUnityGain !== true
  ) {
    throw new Error("production netstyle render did not honor its media/QC contract");
  }
  const decode = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", output, "-f", "null", "-",
  ]);
  if (decode.status !== 0 || decode.stderr.trim()) {
    throw new Error(`production netstyle render has decode errors: ${decode.stderr}`);
  }
  const productionPlan = readJson(planFile);
  const secondEvent = productionPlan.events[1];
  const visibility = run("ffmpeg", [
    "-hide_banner", "-nostats",
    "-i", output,
    "-i", baseVideo,
    "-filter_complex",
    `[0:v]trim=start_frame=${secondEvent.peakFrame}:`
      + `end_frame=${secondEvent.peakFrame + 1},setpts=PTS-STARTPTS[a];`
      + `[1:v]trim=start_frame=${secondEvent.peakFrame}:`
      + `end_frame=${secondEvent.peakFrame + 1},setpts=PTS-STARTPTS[b];`
      + "[a][b]ssim",
    "-f", "null", "-",
  ]);
  const ssim = Number(/All:([0-9.]+)/.exec(visibility.stderr)?.[1]);
  if (!Number.isFinite(ssim) || ssim > 0.97) {
    throw new Error(`second production event was not visibly present: SSIM=${ssim}`);
  }
  const invalid = readJson(planFile);
  invalid.events[1].startFrame = invalid.events[0].startFrame;
  invalid.digest = sha256Value({ ...invalid, digest: undefined });
  const invalidFile = path.join(temporary, "netstyle-overlap-plan.json");
  writeJson(invalidFile, invalid);
  const failure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "netstyle",
    "validate-plan",
    "--plan", invalidFile,
  ]);
  if (!failure.stderr.includes("重叠")) {
    throw new Error("production plan validator did not reject overlapping primary effects");
  }
}, "visual");

await test("adaptive BGM planner follows narrative, speech density and show-specific music grammar", () => {
  const directory = path.join(temporary, "adaptive-bgm-plan");
  fs.mkdirSync(directory, { recursive: true });
  const cues = path.join(directory, "cues.json");
  const planFile = path.join(directory, "plan.json");
  const casualPlanFile = path.join(directory, "casual-plan.json");
  writeJson(cues, {
    cues: [
      { id: "hook", start: 0, end: 12, text: "为什么我们总是高估一个工具？", signals: ["hook"], emotion: "curious" },
      { id: "reasoning", start: 12, end: 42, text: "先把判断依据一层一层说清楚。", role: "explanation" },
      { id: "evidence", start: 42, end: 65, text: "报告中的样本是 1280 人，误差范围 3.2%，这里还要核验来源。", signals: ["fact_check", "data"] },
      { id: "transition", start: 65, end: 78, text: "换个角度，再看作者真正的问题。", signals: ["transition"] },
      { id: "reflection", start: 78, end: 106, text: "回头看，答案也许不在效率，而在选择。", signals: ["reflection"] },
      { id: "conclusion", start: 106, end: 120, text: "所以，先保留判断，再使用工具。", signals: ["conclusion"] },
    ],
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "bgm", "plan",
    "--cues", cues,
    "--show", "book-talk",
    "--output", planFile,
  ]);
  const plan = readJson(planFile);
  const validation = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "bgm", "validate",
    "--plan", planFile,
  ]).stdout);
  const factScene = plan.scenes.find((scene) => scene.cueIds?.includes("evidence"));
  const musicScenes = plan.scenes.filter((scene) => scene.mode === "music");
  if (
    validation.status !== "pass"
    || plan.coverage.musicRatio > 0.45
    || factScene?.mode !== "silence"
    || musicScenes.length < 2
    || !musicScenes.every((scene) => (
      scene.prompt?.bpm
      && scene.prompt?.instruments?.length >= 3
      && /Frequency design:/.test(scene.prompt?.generationPrompt ?? "")
      && /Stereo:/.test(scene.prompt?.generationPrompt ?? "")
      && /no vocals|instrumental only/i.test(scene.prompt?.generationPrompt ?? "")
      && scene.mixAutomation?.phraseSafeEntry === true
      && scene.mixAutomation?.phraseSafeExit === true
    ))
  ) {
    throw new Error("adaptive BGM plan did not preserve sparse book-talk scoring and professional prompt fields");
  }
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "bgm", "plan",
    "--cues", cues,
    "--show", "casual-chat",
    "--output", casualPlanFile,
  ]);
  const casualPlan = readJson(casualPlanFile);
  const casualFactScene = casualPlan.scenes.find((scene) => scene.cueIds?.includes("evidence"));
  if (
    casualPlan.showId !== "casual-chat"
    || casualPlan.coverage.maximumForShow !== 0.52
    || casualPlan.coverage.musicRatio > 0.52
    || casualFactScene?.mode !== "silence"
  ) {
    throw new Error("adaptive BGM plan did not preserve casual-chat silence and coverage policy");
  }
  const invalidFile = path.join(directory, "invalid.json");
  const invalid = structuredClone(plan);
  invalid.scenes = [{
    ...musicScenes[0],
    id: "constant-bed",
    start: 0,
    end: 120,
    cueIds: plan.scenes.flatMap((scene) => scene.cueIds ?? []),
  }];
  delete invalid.digest;
  delete invalid.generatedAt;
  invalid.digest = sha256Value(invalid);
  writeJson(invalidFile, invalid);
  const rejected = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "bgm", "validate",
    "--plan", invalidFile,
  ]);
  if (!/覆盖率|铺满全片|连续/.test(rejected.stdout + rejected.stderr)) {
    throw new Error("adaptive BGM validator accepted an unchanged full-length loop");
  }
}, "audio");

await test("segmented adaptive BGM renderer executes music entries, exits and intentional silence", () => {
  const directory = path.join(temporary, "adaptive-bgm-render");
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, "source.mp4");
  const cueA = path.join(directory, "cue-a.wav");
  const cueB = path.join(directory, "cue-b.wav");
  const output = path.join(directory, "preview.mp4");
  const bgmStem = path.join(directory, "bgm-stem.wav");
  const graph = path.join(directory, "render-graph.json");
  const timeline = path.join(directory, "timeline.json");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=4:sample_rate=48000",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", source,
  ]);
  for (const [file, frequency] of [[cueA, 330], [cueB, 550]]) {
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=2:sample_rate=48000`,
      "-c:a", "pcm_s24le", file,
    ]);
  }
  writeJson(path.join(directory, "kacha.config.json"), {
    schemaVersion: "1.0",
    execution: {
      unifiedRender: {
        preview: { encoder: "libx264", fallbackEncoder: "libx264", preset: "ultrafast", crf: 23 },
        final: { encoder: "libx264", fallbackEncoder: "libx264", preset: "ultrafast", crf: 18 },
      },
    },
  });
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "adaptive-bgm-render",
    mode: "preview",
    source: { path: source, sha256: sha256File(source) },
    edl: [{ id: "full", sourceStart: 0, sourceEnd: 4 }],
    visual: { breathing: [], overlays: [] },
    audio: {
      masterTruePeakDb: -4,
      bgm: {
        sidechain: false,
        segments: [
          { path: cueA, start: 0, end: 0.9, sourceStart: 0, levelBelowDialogueDb: 14, fadeInSeconds: 0.1, fadeOutSeconds: 0.1 },
          { path: cueB, start: 2, end: 3.8, sourceStart: 0, levelBelowDialogueDb: 18, fadeInSeconds: 0.2, fadeOutSeconds: 0.2 },
        ],
      },
      sfx: [],
    },
    output: { path: output, width: 160, height: 90, fps: 25, bgmStem },
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "timeline", "validate", "--plan", timeline,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "timeline", "render", "--plan", timeline, "--graph", graph,
  ]);
  const compiled = readJson(graph);
  if (
    compiled.audio?.bgm?.segments?.length !== 2
    || !fs.existsSync(output)
    || !fs.existsSync(bgmStem)
    || !mediaSummary(bgmStem).audio
  ) {
    throw new Error("segmented BGM program was not compiled and rendered");
  }
  const silenceProbe = run("ffmpeg", [
    "-hide_banner", "-nostats", "-ss", "1.15", "-t", "0.45", "-i", bgmStem,
    "-af", "volumedetect", "-f", "null", "-",
  ]);
  const activeProbe = run("ffmpeg", [
    "-hide_banner", "-nostats", "-ss", "2.3", "-t", "0.45", "-i", bgmStem,
    "-af", "volumedetect", "-f", "null", "-",
  ]);
  const meanVolume = (stderr) => {
    const match = stderr.match(/mean_volume:\s+(-?(?:\d+(?:\.\d+)?|inf)) dB/);
    if (!match) return null;
    return match[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
  };
  const silenceMean = meanVolume(silenceProbe.stderr);
  const activeMean = meanVolume(activeProbe.stderr);
  if (
    silenceProbe.status !== 0
    || activeProbe.status !== 0
    || silenceMean === null
    || activeMean === null
    || silenceMean > -80
    || activeMean < -70
    || activeMean - silenceMean < 20
  ) {
    throw new Error(
      "rendered BGM stem did not preserve the planned intentional silence\n"
        + `silence:\n${silenceProbe.stderr}\nactive:\n${activeProbe.stderr}`,
    );
  }
}, "audio");

await test("unified timeline renders EDL, motion, overlays, subtitles and audio in one encode", () => {
  const directory = path.join(temporary, "unified-timeline");
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, "source.mp4");
  const overlay = path.join(directory, "overlay.png");
  const bgm = path.join(directory, "bgm.wav");
  const sfx = path.join(directory, "sfx.wav");
  const subtitles = path.join(directory, "subtitles.mov");
  const output = path.join(directory, "preview.mp4");
  const graph = path.join(directory, "render-graph.json");
  const dialogueStem = path.join(directory, "dialogue.wav");
  const bgmStem = path.join(directory, "bgm-stem.wav");
  const sfxStem = path.join(directory, "sfx-stem.wav");
  const mixStem = path.join(directory, "mix-stem.wav");
  const timeline = path.join(directory, "timeline.json");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=4:sample_rate=48000",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-timecode", "01:02:03:04", source,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0xF6A21A:s=70x50:d=0.1",
    "-frames:v", "1", "-threads", "1", overlay,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=3:sample_rate=48000",
    "-c:a", "pcm_s24le", bgm,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i",
    "aevalsrc=if(between(t\\,0.38\\,0.5)\\,0.8*sin(2*PI*880*t)\\,0):d=0.7:s=48000",
    "-c:a", "pcm_s24le", sfx,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i",
    "color=c=black@0.0:s=320x180:r=25:d=3,format=rgba,"
      + "drawbox=x=85:y=145:w=150:h=18:color=white@0.85:t=fill",
    "-an", "-c:v", "qtrle", "-pix_fmt", "argb", subtitles,
  ]);
  writeJson(path.join(directory, "kacha.config.json"), {
    schemaVersion: "1.0",
    execution: {
      unifiedRender: {
        preview: {
          encoder: "libx264",
          fallbackEncoder: "libx264",
          preset: "ultrafast",
          crf: 23,
        },
        final: {
          encoder: "libx264",
          fallbackEncoder: "libx264",
          preset: "ultrafast",
          crf: 18,
        },
      },
    },
  });
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "unified-timeline-smoke",
    mode: "preview",
    source: {
      path: source,
      sha256: sha256File(source),
    },
    edl: [
      {
        id: "first",
        sourceStart: 0,
        sourceEnd: 1.5,
        scale: 1.08,
        anchorX: 0.5,
        anchorY: 0.42,
      },
      { id: "second", sourceStart: 2, sourceEnd: 3.5 },
    ],
    visual: {
      breathing: [{
        start: 0.1,
        end: 0.9,
        scale: 1.05,
        anchorX: 0.5,
        anchorY: 0.45,
        entryRatio: 0.3,
        exitRatio: 0.3,
      }],
      overlays: [{
        kind: "image",
        path: overlay,
        start: 0.5,
        end: 1.3,
        x: 230,
        y: 20,
        width: 70,
        height: 50,
        opacity: 0.85,
        keyframes: {
          x: [
            { tick: 60000, time: 0.5, value: 230 },
            { tick: 156000, time: 1.3, value: 100 },
          ],
        },
      }],
      subtitles: { kind: "overlay_video", path: subtitles },
    },
    audio: {
      masterTruePeakDb: -4,
      bgm: {
        path: bgm,
        levelBelowDialogueDb: 16,
        sidechain: true,
      },
      sfx: [{
        path: sfx,
        targetLandingSeconds: 1,
        levelBelowDialogueDb: 8,
      }],
    },
    output: {
      path: output,
      width: 320,
      height: 180,
      fps: 25,
      dialogueStem,
      bgmStem,
      sfxStem,
      mixStem,
    },
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "validate",
    "--plan",
    timeline,
  ]);
  const rendered = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "render",
    "--plan",
    timeline,
    "--graph",
    graph,
  ]);
  const result = JSON.parse(rendered.stdout);
  const compiledGraph = readJson(graph);
  const manifest = readJson(`${output}.manifest.json`);
  const summary = mediaSummary(output);
  if (
    result.videoEncodes !== 1
    || manifest.execution.videoEncodes !== 1
    || manifest.execution.fullDecodePerformed !== false
    || summary.width !== 320
    || summary.height !== 180
    || Math.abs(summary.videoDuration - 3) > 0.06
    || !summary.audio
    || readJson(graph).edl[0]?.scale !== 1.08
    || readJson(graph).edl[0]?.anchorY !== 0.42
    || compiledGraph.audio?.masterTruePeakDb !== -4
    || compiledGraph.visual?.overlays?.[0]?.keyframes?.x?.length !== 2
    || compiledGraph.audio?.sfx?.[0]?.alignmentMode !== "waveform_peak"
    || Math.abs(
      compiledGraph.audio.sfx[0].fileStartSeconds
        + compiledGraph.audio.sfx[0].measuredPeakOffsetSeconds
        - compiledGraph.audio.sfx[0].targetLandingSeconds,
    ) > 0.041
    || manifest.execution.masterTruePeakDb !== -4
    || manifest.execution.sourceTimecodeAndUnrequestedMetadataStripped !== true
    || summary.probe.streams.some((stream) => stream.codec_type === "data")
  ) {
    throw new Error("unified renderer did not preserve its one-encode media contract");
  }
  const metadataOnlyTimeline = readJson(timeline);
  metadataOnlyTimeline.editor = {
    markers: [{ id: "review", tick: 120000, label: "Review", color: "amber" }],
    workArea: { startTick: 60000, endTick: 240000 },
    deliveryFrames: [{ id: "vertical", label: "9:16", width: 1080, height: 1920 }],
  };
  writeJson(timeline, metadataOnlyTimeline);
  const metadataGraph = path.join(directory, "render-graph-editor-metadata.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "timeline", "compile", "--plan", timeline, "--graph", metadataGraph,
  ]);
  if (readJson(metadataGraph).digest !== compiledGraph.digest) {
    throw new Error("editor-only markers/work area/delivery guides changed Render Graph identity");
  }
  for (const stem of [dialogueStem, bgmStem, sfxStem, mixStem]) {
    if (!fs.existsSync(stem) || !mediaSummary(stem).audio) {
      throw new Error(`unified renderer did not emit declared stem ${stem}`);
    }
  }
  const renderedSfxPeak = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "sfx", "align", "--file", sfxStem, "--target", "1", "--fps", "25",
  ]).stdout).alignment.measuredPeakOffsetSeconds;
  if (Math.abs(renderedSfxPeak - 1) > 0.041) {
    throw new Error(`rendered SFX peak landed at ${renderedSfxPeak}s instead of 1s`);
  }
  const reused = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "render",
    "--plan",
    timeline,
    "--graph",
    graph,
  ]);
  const reuseResult = JSON.parse(reused.stdout);
  if (reuseResult.status !== "reused" || reuseResult.videoEncodes !== 0) {
    throw new Error("exact unified timeline rerun did not reuse its verified output");
  }
  const originalGraphDigest = readJson(graph).digest;
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x2367FF:s=70x50:d=0.1",
    "-frames:v", "1", "-threads", "1", overlay,
  ]);
  const changedGraph = path.join(directory, "changed-asset.render-graph.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "compile",
    "--plan",
    timeline,
    "--graph",
    changedGraph,
  ]);
  if (readJson(changedGraph).digest === originalGraphDigest) {
    throw new Error("in-place overlay content change did not invalidate the render graph");
  }
  const changedRender = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "render",
    "--plan",
    timeline,
    "--graph",
    changedGraph,
  ]);
  if (!changedRender.stderr.includes("拒绝覆盖已有输出")) {
    throw new Error("changed asset was neither invalidated nor rejected fail-closed");
  }
  const proxyConfig = path.join(directory, "proxy.config.json");
  const rangeTimeline = path.join(directory, "range-timeline.json");
  const rangeOutput = path.join(directory, "range-preview.mp4");
  const rangeGraph = path.join(directory, "range-preview.render-graph.json");
  const rangeTimelineValue = readJson(timeline);
  rangeTimelineValue.output = {
    ...rangeTimelineValue.output,
    width: 640,
    height: 360,
  };
  writeJson(rangeTimeline, rangeTimelineValue);
  writeJson(proxyConfig, {
    schemaVersion: "1.0",
    execution: {
      unifiedRender: {
        preview: {
          maxWidth: 320,
          encoder: "libx264",
          fallbackEncoder: "libx264",
          preset: "ultrafast",
          crf: 25,
        },
      },
    },
  });
  const rangeResult = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "render",
    "--plan",
    rangeTimeline,
    "--output",
    rangeOutput,
    "--graph",
    rangeGraph,
    "--mode",
    "preview",
    "--range-start",
    "0.75",
    "--range-end",
    "1.35",
    "--config",
    proxyConfig,
  ]).stdout);
  const rangeSummary = mediaSummary(rangeOutput);
  const rangeManifest = readJson(`${rangeOutput}.manifest.json`);
  const rangeGraphValue = readJson(rangeGraph);
  if (
    rangeResult.videoEncodes !== 1
    || rangeSummary.width !== 320
    || rangeSummary.height !== 180
    || Math.abs(rangeSummary.videoDuration - 0.6) > 0.06
    || rangeGraphValue.edl.length !== 1
    || rangeGraphValue.sourceSeekSeconds !== 0.75
    || rangeGraphValue.previewRange?.start !== 0.75
    || rangeGraphValue.visual.overlays[0]?.x !== 115
    || rangeGraphValue.visual.overlays[0]?.width !== 35
    || rangeManifest.execution.previewRange?.end !== 1.35
    || rangeManifest.execution.stemOutputs.length !== 0
  ) {
    throw new Error("local proxy preview did not slice time, cap geometry or suppress final stems");
  }
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "compile",
    "--plan",
    rangeTimeline,
    "--mode",
    "preview",
    "--range-start",
    "0.75",
    "--range-end",
    "1.35",
  ]);
  const offCanvasTimeline = path.join(directory, "off-canvas-timeline.json");
  const offCanvasValue = readJson(timeline);
  offCanvasValue.visual.overlays[0].x = 280;
  offCanvasValue.visual.overlays[0].width = 70;
  writeJson(offCanvasTimeline, offCanvasValue);
  const offCanvas = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "validate",
    "--plan",
    offCanvasTimeline,
  ]);
  if (!offCanvas.stderr.includes("超出输出画布")) {
    throw new Error("timeline accepted an overlay outside the output canvas");
  }

  const projectOutput = path.join(directory, "project-final.mp4");
  const projectTimeline = path.join(directory, "project-timeline.json");
  const projectDialogueStem = path.join(directory, "project-dialogue.wav");
  const projectBgmStem = path.join(directory, "project-bgm.wav");
  const projectSfxStem = path.join(directory, "project-sfx.wav");
  const projectMixStem = path.join(directory, "project-mix.wav");
  const projectTimelineValue = readJson(timeline);
  projectTimelineValue.mode = "final";
  projectTimelineValue.output = {
    ...projectTimelineValue.output,
    path: projectOutput,
    dialogueStem: projectDialogueStem,
    bgmStem: projectBgmStem,
    sfxStem: projectSfxStem,
    mixStem: projectMixStem,
  };
  writeJson(projectTimeline, projectTimelineValue);
  const proposal = readJson(ensureValidProposalFixture());
  proposal.sourceInventory = [{
    path: source,
    role: "synthetic source",
    readOnly: true,
    probeEvidence: ["ffprobe synthetic fixture"],
    existsVerified: true,
    probedAt: new Date().toISOString(),
    sha256: sha256File(source),
  }];
  proposal.creativeLock.sourceWidth = 320;
  proposal.creativeLock.sourceHeight = 180;
  proposal.creativeLock.outputWidth = 320;
  proposal.creativeLock.outputHeight = 180;
  proposal.creativeLock.sourceAspectRatio = "16:9";
  proposal.creativeLock.outputAspectRatio = "16:9";
  proposal.goal.videoAspectRatios = ["16:9"];
  const workflowEvidence = path.join(directory, "workflow-through-preview.json");
  writeJson(workflowEvidence, {
    status: "pass",
    completedThrough: "preview_render",
    checks: ["semantic-boundaries", "audio-stems", "visual-safety", "preview-review"],
  });
  const workflowEvidenceIdentity = {
    path: workflowEvidence,
    sha256: sha256File(workflowEvidence),
  };
  proposal.executionFlow = proposal.executionFlow.map((stage, index) => (
    index <= 10
      ? { ...stage, status: "passed", evidence: workflowEvidenceIdentity }
      : stage
  ));
  const projectProposal = path.join(directory, "edit-proposal.json");
  writeJson(projectProposal, proposal);
  projectTimelineValue.contracts = {
    proposal: {
      path: projectProposal,
      sha256: sha256File(projectProposal),
    },
    editPlan: {
      path: path.join(examples, "edit-plan.json"),
      sha256: sha256File(path.join(examples, "edit-plan.json")),
    },
  };
  const assetProvenance = {
    kind: "synthetic_test_fixture",
    evidence: "generated locally by the unified renderer regression",
  };
  for (const asset of [
    ...(projectTimelineValue.visual?.overlays ?? []),
    ...(projectTimelineValue.visual?.subtitles
      ? [projectTimelineValue.visual.subtitles]
      : []),
    ...(projectTimelineValue.audio?.bgm ? [projectTimelineValue.audio.bgm] : []),
    ...(projectTimelineValue.audio?.sfx ?? []),
  ]) {
    asset.sha256 = sha256File(asset.path);
    asset.provenance = assetProvenance;
  }
  writeJson(projectTimeline, projectTimelineValue);
  const projectFile = path.join(directory, "project.json");
  writeJson(projectFile, {
    schemaVersion: "2.0",
    projectId: "unified-project-render",
    plans: {
      proposal: projectProposal,
      editPlan: path.join(examples, "edit-plan.json"),
      visualCapabilityPlan: {
        path: ensureVisualCapabilityPlanFixture(),
        mode: "template",
      },
      timeline: projectTimeline,
      generatedShotPlans: [],
    },
    outputs: {
      finalVideo: { path: projectOutput },
      audioStems: {
        dialogue: { path: projectDialogueStem },
        bgm: { path: projectBgmStem },
        sfx: { path: projectSfxStem },
        mix: { path: projectMixStem },
      },
      technicalQcReport: { path: path.join(directory, "technical-qc.json") },
      releaseReport: { path: path.join(directory, "release-report.json") },
    },
    expectedMedia: {
      width: 320,
      height: 180,
      aspectRatio: "16:9",
      fps: 25,
      fpsTolerance: 0.001,
      audioSampleRate: 48000,
      expectedChannels: 2,
      maxAvDriftFrames: 1,
      integratedLufsMin: -40,
      integratedLufsMax: 0,
      truePeakMax: 0,
      audioMix: {
        bgmRequired: true,
        bgmBelowDialogueDbMin: 8,
        bgmBelowDialogueDbMax: 30,
        bgmMinimumCoverageRatio: 0.8,
      },
    },
    requiredCoverAspectRatios: [],
    requiredCapabilities: [],
  });
  const next = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "next",
    projectFile,
  ]).stdout);
  if (
    next.nextAction.id !== "render_unified_timeline"
    || next.nextAction.safeToAutoExecute !== true
  ) {
    throw new Error("project workflow did not select the deterministic unified renderer");
  }
  const projectRender = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "render",
    projectFile,
  ]).stdout);
  if (
    projectRender.videoEncodes !== 1
    || projectRender.completionBoundary !== "rendered_requires_final_qc"
    || !fs.existsSync(projectRender.metrics)
  ) {
    throw new Error("project renderer did not execute and measure the unified final render");
  }
  const projectReuse = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "render",
    projectFile,
  ]).stdout);
  const runMetrics = readJson(projectReuse.metrics);
  if (
    projectReuse.videoEncodes !== 0
    || runMetrics.cache.hit < 1
    || runMetrics.media.videoEncodes !== 1
  ) {
    throw new Error("project renderer did not measure exact cache reuse");
  }
}, "visual");

await test("timeline executes declared picture and sound transitions at real joins", () => {
  const directory = path.join(temporary, "timeline-executed-transitions");
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, "source.mp4");
  const output = path.join(directory, "output.mp4");
  const graph = path.join(directory, "render-graph.json");
  const timeline = path.join(directory, "timeline.json");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=4:sample_rate=48000",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", source,
  ]);
  writeJson(path.join(directory, "kacha.config.json"), {
    schemaVersion: "1.0",
    execution: {
      unifiedRender: {
        preview: {
          encoder: "libx264",
          fallbackEncoder: "libx264",
          preset: "ultrafast",
          crf: 25
        }
      }
    }
  });
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "executed-transition-smoke",
    mode: "preview",
    source: { path: source, sha256: sha256File(source) },
    edl: [
      { id: "before", sourceStart: 0, sourceEnd: 1.5 },
      { id: "after", sourceStart: 2, sourceEnd: 3.5 }
    ],
    transitions: [{
      boundaryIndex: 0,
      effectId: "focus_blur",
      durationFrames: 4
    }],
    visual: { breathing: [], overlays: [] },
    audio: { masterTruePeakDb: -4, sfx: [] },
    output: { path: output, width: 320, height: 180, fps: 25 }
  });
  const rendered = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline", "render",
    "--plan", timeline,
    "--graph", graph,
  ]).stdout);
  const graphValue = readJson(graph);
  const manifest = readJson(`${output}.manifest.json`);
  const summary = mediaSummary(output);
  if (
    rendered.videoEncodes !== 1
    || graphValue.transitions[0]?.transition !== "hblur"
    || graphValue.transitions[0]?.durationFrames !== 4
    || manifest.execution.transitions?.executedCount !== 1
    || manifest.execution.transitions?.effects[0]?.boundaryIndex !== 0
    || Math.abs(summary.videoDuration - 2.84) > 0.06
    || !summary.audio
  ) {
    throw new Error("timeline declared a transition without executing the picture/sound overlap");
  }
  const safeZoomTimeline = readJson(timeline);
  safeZoomTimeline.transitions[0].effectId = "zoom_punch";
  writeJson(timeline, safeZoomTimeline);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline", "compile",
    "--plan", timeline,
    "--graph", graph,
  ]);
  const safeZoomGraph = readJson(graph);
  if (safeZoomGraph.transitions[0]?.transition !== "dissolve") {
    throw new Error("short zoom_punch join regressed to the flashing xfade=zoomin implementation");
  }
}, "visual");

await test("timeline preserves the displayed geometry of rotation-tagged source video", () => {
  const directory = path.join(temporary, "timeline-rotation-metadata");
  fs.mkdirSync(directory, { recursive: true });
  const base = path.join(directory, "base.mp4");
  const source = path.join(directory, "rotated.mp4");
  const timeline = path.join(directory, "timeline.json");
  const graph = path.join(directory, "render-graph.json");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", base,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-display_rotation", "90", "-i", base, "-c", "copy", source,
  ]);
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "rotation-aware-timeline",
    mode: "preview",
    source: { path: source, sha256: sha256File(source) },
    edl: [{ id: "full", sourceStart: 0, sourceEnd: 1 }],
    output: { path: path.join(directory, "output.mp4"), fps: 25 },
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "compile",
    "--plan",
    timeline,
    "--graph",
    graph,
  ]);
  const compiled = readJson(graph);
  if (
    compiled.geometry.width !== 360
    || compiled.geometry.height !== 640
    || compiled.sourceMedia.encodedWidth !== 640
    || compiled.sourceMedia.encodedHeight !== 360
    || Math.abs(compiled.sourceMedia.rotation) !== 90
  ) {
    throw new Error("rotation metadata no longer resolves to displayed output geometry");
  }
}, "visual");

await test("cross-process media probe cache reuses strong file identity", () => {
  const missingCommand = run("__kacha_missing_runtime_command__", []);
  if (missingCommand.status === 0 || !missingCommand.stderr) {
    throw new Error("missing command was not normalized into a stable failure");
  }
  ensureMediaFixtures();
  const cacheRoot = path.join(temporary, "media-cache");
  const moduleUrl = pathToFileURL(path.join(scripts, "kacha_utils.mjs")).href;
  const program = [
    `import { mediaSummary } from ${JSON.stringify(moduleUrl)};`,
    "console.log(mediaSummary(process.argv[1]).width);",
  ].join("");
  const first = run(process.execPath, [
    "--input-type=module",
    "-e",
    program,
    baseVideo,
  ], {
    cwd: temporary,
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
  });
  if (first.status !== 0 || first.stdout.trim() !== "320") {
    throw new Error(`first persistent ffprobe cache run failed: ${first.stderr}`);
  }
  const second = run(process.execPath, [
    "--input-type=module",
    "-e",
    program,
    baseVideo,
  ], {
    cwd: temporary,
    env: {
      ...process.env,
      XDG_CACHE_HOME: cacheRoot,
      PATH: "/nonexistent",
    },
  });
  if (second.status !== 0 || second.stdout.trim() !== "320") {
    throw new Error("second media probe did not reuse the persistent cache");
  }
}, "core");

function initializeIncrementalFixture(name, options = {}) {
  ensureMediaFixtures();
  const baseline = options.baseline ?? baseVideo;
  const root = path.join(temporary, `incremental-${name}`);
  fs.mkdirSync(root, { recursive: true });
  const args = [
    path.join(scripts, "init_incremental_project.mjs"),
    baseline,
    "--project-id",
    `incremental-${name}`,
    "--output-dir",
    root,
  ];
  if (options.delivery) args.push("--delivery", options.delivery);
  if (options.coverRatios) args.push("--cover-ratios", options.coverRatios);
  execute(process.execPath, args);
  return {
    root,
    context: path.join(root, "project-context.json"),
    index: path.join(root, "artifact-index.json"),
    baseline,
  };
}

function createIncrementalCase(
  fixture,
  {
    versionId,
    type,
    intent = "candidate",
    strategy = "auto",
    outputVideo = null,
    extraDeltaArgs = [],
  },
) {
  const delta = path.join(fixture.root, `${versionId}-delta.json`);
  const project = path.join(fixture.root, `${versionId}-project.json`);
  const deltaArgs = [
    path.join(scripts, "create_version_delta.mjs"),
    fixture.context,
    "--write",
    delta,
    "--new-version",
    versionId,
    "--type",
    type,
    "--intent",
    intent,
    "--strategy",
    strategy,
    ...extraDeltaArgs,
  ];
  if (outputVideo) deltaArgs.push("--output-video", outputVideo);
  execute(process.execPath, deltaArgs);
  execute(process.execPath, [
    path.join(scripts, "create_incremental_manifest.mjs"),
    fixture.context,
    delta,
    fixture.index,
    "--output",
    project,
  ]);
  return {
    ...fixture,
    versionId,
    delta,
    project,
    outputVideo,
    plan: path.join(fixture.root, "output", "incremental-plan.json"),
    qc: path.join(fixture.root, "output", "delta-qc.json"),
    review: path.join(fixture.root, "output", "incremental-review.json"),
  };
}

await test("low-model change compiler creates a safe incremental project", () => {
  const fixture = initializeIncrementalFixture("compiled-change");
  writeJson(path.join(fixture.root, "kacha.config.json"), {
    schemaVersion: "1.0",
    editingDefaults: {
      parameters: {
        preserveNaturalPauses: true,
      },
      instructions: [{
        id: "beauty-default",
        text: "美颜必须保持眼镜、发丝和背景清晰。",
        appliesTo: ["local_optimization"],
        modules: ["beauty"],
        priority: "required",
      }],
      recipeParameters: {
        beauty: {
          profile: "natural",
          temporalConsistency: "required",
        },
      },
    },
    execution: {
      incremental: {
        handleFrames: 31,
      },
    },
  });
  const requestFile = path.join(fixture.root, "change-request.json");
  const outputRoot = path.join(fixture.root, "versions", "v2");
  writeJson(requestFile, {
    schemaVersion: "1.0",
    projectContext: fixture.context,
    newVersion: {
      id: "v2",
      intent: "candidate",
    },
    changes: [{
      recipe: "beauty",
      reason: "synthetic beauty regression",
      parameters: {
        profile: "light_plus",
      },
    }],
    render: {
      strategy: "auto",
    },
    deliverables: {
      covers: [],
      subtitles: [],
    },
  });
  const unsafeRequestFile = path.join(fixture.root, "unsafe-change-request.json");
  const unsafeRequest = readJson(requestFile);
  unsafeRequest.newVersion.id = "../escape";
  writeJson(unsafeRequestFile, unsafeRequest);
  const unsafeVersion = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    unsafeRequestFile,
    "--dry-run",
  ]);
  if (!unsafeVersion.stderr.includes("KACHA-E140")) {
    throw new Error("unsafe version id did not fail closed");
  }
  const dryRun = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    requestFile,
    "--output-dir",
    outputRoot,
    "--dry-run",
  ]);
  if (JSON.parse(dryRun.stdout).status !== "dry_run") {
    throw new Error("compile-change dry-run did not stay read-only");
  }
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    requestFile,
    "--output-dir",
    outputRoot,
  ]);
  const projectFile = path.join(outputRoot, "incremental-project.json");
  const deltaFile = path.join(outputRoot, "version-delta.json");
  const planFile = path.join(outputRoot, "output", "incremental-plan.json");
  for (const file of [projectFile, deltaFile, planFile]) {
    if (!fs.existsSync(file)) throw new Error(`compiled file missing: ${file}`);
  }
  const delta = readJson(deltaFile);
  if (delta.changeSet.recipeChanges?.[0]?.parameters?.profile !== "light_plus") {
    throw new Error("recipe parameters were not preserved in version delta");
  }
  if (
    delta.changeSet.recipeChanges?.[0]?.parameters?.temporalConsistency !== "required"
    || delta.render.handleFrames !== 31
    || delta.changeSet.defaultRequirements?.parameters?.preserveNaturalPauses !== true
    || !delta.changeSet.defaultRequirements?.instructions
      ?.some((item) => item.id === "beauty-default")
  ) {
    throw new Error("configured recipe defaults or natural-language requirements were lost");
  }
  const packetFile = path.join(outputRoot, "agent-packet.json");
  const evidenceFile = path.join(outputRoot, "visual-evidence.json");
  const metricsFile = path.join(outputRoot, "run-metrics.json");
  writeJson(packetFile, {
    contextBudget: {
      files: 7,
      approximateInputTokens: 4321,
    },
  });
  writeJson(evidenceFile, {
    status: "pass",
    sampling: { mode: "fast" },
    frames: [{ timeSeconds: 0 }],
    analysis: {
      localSemantic: "pass",
      remoteSemantic: "not_requested",
      remoteSemanticFrames: 0,
    },
    provenance: { wholeVideoUploaded: false },
  });
  execute(process.execPath, [
    path.join(scripts, "write_run_metrics.mjs"),
    projectFile,
    "--output",
    metricsFile,
    "--agent-packet",
    packetFile,
    "--visual-evidence",
    evidenceFile,
    "--model-tier",
    "economy",
  ]);
  const metrics = readJson(metricsFile);
  if (
    metrics.context.routedFiles !== 7
    || metrics.context.routedApproximateTokens !== 4321
    || metrics.context.modelTier !== "economy"
    || metrics.visualEvidence.frames !== 1
    || metrics.visualEvidence.wholeVideoUploaded !== false
  ) {
    throw new Error("run metrics did not preserve model or visual evidence data");
  }
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    requestFile,
    "--output-dir",
    outputRoot,
  ]);
  const lockedRoot = path.join(fixture.root, "versions", "v3");
  const lockFile = `${lockedRoot}.lock`;
  writeJson(lockFile, {
    schemaVersion: "1.0",
    pid: process.pid,
    host: process.env.HOSTNAME || process.env.COMPUTERNAME || "local",
    purpose: "synthetic-live-lock",
    createdAt: new Date().toISOString(),
  });
  const locked = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    requestFile,
    "--output-dir",
    lockedRoot,
    "--dry-run",
  ]);
  if (!locked.stderr.includes("KACHA-E500")) {
    throw new Error("active project lock did not fail with a stable diagnostic");
  }
  fs.unlinkSync(lockFile);
  const recoveredRoot = path.join(fixture.root, "versions", "v4");
  const recoveredLock = `${recoveredRoot}.lock`;
  writeJson(recoveredLock, {
    schemaVersion: "1.0",
    pid: 2_147_483_647,
    host: os.hostname(),
    purpose: "synthetic-dead-lock",
    createdAt: new Date().toISOString(),
  });
  const recovered = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    requestFile,
    "--output-dir",
    recoveredRoot,
    "--dry-run",
  ]);
  if (JSON.parse(recovered.stdout).status !== "dry_run" || fs.existsSync(recoveredLock)) {
    throw new Error("dead same-host operation lock was not safely recovered");
  }
}, "incremental");

await test("FaceFusion change requests compile only authorized affected layers", () => {
  const fixture = initializeIncrementalFixture("facefusion-change");
  const planFile = path.join(fixture.root, "facefusion-plan.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "facefusion",
    "template",
    "--operation",
    "post_process",
    "--output",
    planFile,
  ]);
  const plan = readJson(planFile);
  plan.inputs.target = fixture.baseline;
  plan.output.path = path.join(fixture.root, "facefusion-candidate.mp4");
  plan.authorization.canExecute = true;
  plan.authorization.postProcessingAuthorized = true;
  plan.authorization.modelLicenseReviewed = true;
  plan.authorization.evidence = "synthetic project authorization";
  writeJson(planFile, plan);

  const requestFile = path.join(fixture.root, "facefusion-change-request.json");
  writeJson(requestFile, {
    schemaVersion: "1.0",
    projectContext: fixture.context,
    newVersion: { id: "facefusion-v2", intent: "candidate" },
    changes: [{
      recipe: "facefusion",
      reason: "repair visible compression damage",
      parameters: { plan: planFile },
    }],
    render: { strategy: "auto" },
    deliverables: { covers: [], subtitles: [] },
  });
  const compiled = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    requestFile,
    "--output-dir",
    path.join(fixture.root, "versions", "facefusion-v2"),
    "--dry-run",
  ]).stdout);
  if (
    compiled.derived.layers.length !== 1
    || compiled.derived.layers[0] !== "visual"
    || compiled.recipes[0].parameters.operation !== "post_process"
    || compiled.recipes[0].parameters.profile !== "frame-postprocess-natural"
  ) {
    throw new Error("FaceFusion post-processing expanded beyond the visual layer");
  }

  plan.inputs.target = sourceFile;
  writeJson(planFile, plan);
  const mismatch = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    requestFile,
    "--output-dir",
    path.join(fixture.root, "versions", "facefusion-mismatch"),
    "--dry-run",
  ]);
  if (!mismatch.stderr.includes("KACHA-E110")) {
    throw new Error("FaceFusion target mismatch was rejected for the wrong reason");
  }
}, "incremental");

await test("style and timing feedback compile to correct rebuild and regression scope", () => {
  const fixture = initializeIncrementalFixture("style-timing-change");
  const styleRequest = path.join(fixture.root, "style-change-request.json");
  const styleOutput = path.join(fixture.root, "versions", "style-v2");
  writeJson(styleRequest, {
    schemaVersion: "1.0",
    projectContext: fixture.context,
    newVersion: {
      id: "style-v2",
      intent: "candidate",
    },
    changes: [{
      recipe: "style",
      reason: "unify all visible design tokens",
      parameters: {
        profile: "xingzhe",
      },
    }],
    render: {
      strategy: "auto",
    },
    deliverables: {
      covers: [],
      subtitles: [],
    },
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    styleRequest,
    "--output-dir",
    styleOutput,
  ]);
  const styleDelta = readJson(path.join(styleOutput, "version-delta.json"));
  const stylePlan = readJson(path.join(styleOutput, "output", "incremental-plan.json"));
  if (
    stylePlan.renderPlan.strategy !== "full_rebuild"
    || !stylePlan.artifactPlan.invalidatedTypes.includes("style_profile")
    || styleDelta.changeSet.regressionScans?.[0]?.class !== "style_consistency"
    || !stylePlan.qcProfile.manualChecks.includes("sameSignatureRegressionScan")
  ) {
    throw new Error("style change did not invalidate the full visual system safely");
  }

  const timingRequest = path.join(fixture.root, "timing-change-request.json");
  const timingOutput = path.join(fixture.root, "versions", "timing-v2");
  writeJson(timingRequest, {
    schemaVersion: "1.0",
    projectContext: fixture.context,
    newVersion: {
      id: "timing-v2",
      intent: "candidate",
    },
    changes: [{
      recipe: "timing_sync",
      reason: "visible actions precede their spoken trigger words",
      parameters: {
        toleranceFrames: 2,
      },
    }],
    render: {
      strategy: "auto",
    },
    deliverables: {
      covers: [],
      subtitles: [],
    },
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    timingRequest,
    "--output-dir",
    timingOutput,
  ]);
  const timingDelta = readJson(path.join(timingOutput, "version-delta.json"));
  const timingPlan = readJson(path.join(timingOutput, "output", "incremental-plan.json"));
  if (
    timingDelta.changeSet.regressionScans?.[0]?.scope
      !== "full_timeline_same_signature"
    || !timingPlan.qcProfile.manualChecks.includes("sameSignatureRegressionScan")
    || timingPlan.renderPlan.strategy === "full_rebuild"
  ) {
    throw new Error("timing feedback did not stay incremental with full-class regression");
  }
}, "incremental");

await test("netstyle feedback compiles to visual and SFX incremental rebuild scope", () => {
  const fixture = initializeIncrementalFixture("netstyle-change");
  const requestFile = path.join(fixture.root, "netstyle-change-request.json");
  const outputRoot = path.join(fixture.root, "versions", "netstyle-v2");
  writeJson(requestFile, {
    schemaVersion: "1.0",
    projectContext: fixture.context,
    newVersion: {
      id: "netstyle-v2",
      intent: "candidate",
    },
    changes: [{
      recipe: "netstyle",
      reason: "结论句需要与语义重音同步的推近和音效",
      intervals: [{
        startSeconds: 0.4,
        endSeconds: 1.2,
      }],
      parameters: {
        effectId: "semantic_importance_zoom",
      },
    }],
    render: {
      strategy: "auto",
    },
    deliverables: {
      covers: [],
      subtitles: [],
    },
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    requestFile,
    "--output-dir",
    outputRoot,
  ]);
  const delta = readJson(path.join(outputRoot, "version-delta.json"));
  const plan = readJson(path.join(outputRoot, "output", "incremental-plan.json"));
  if (
    !delta.changeSet.types.includes("semantic_netstyle")
    || !delta.changeSet.changedLayers.includes("visual")
    || !delta.changeSet.changedLayers.includes("sfx")
    || !plan.artifactPlan.invalidatedTypes.includes("visual_segment")
    || !plan.artifactPlan.invalidatedTypes.includes("sfx_stem")
    || plan.renderPlan.strategy === "full_rebuild"
  ) {
    throw new Error("netstyle feedback did not remain an interval-scoped visual/SFX rebuild");
  }
  const badRequest = readJson(requestFile);
  badRequest.newVersion.id = "netstyle-bad";
  badRequest.changes[0].parameters.effectId = "unregistered-effect";
  const badFile = path.join(fixture.root, "netstyle-bad-request.json");
  writeJson(badFile, badRequest);
  const failure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    badFile,
    "--output-dir",
    path.join(fixture.root, "versions", "netstyle-bad"),
  ]);
  if (!failure.stderr.includes("KACHA-E140")) {
    throw new Error("unregistered netstyle effect did not fail closed");
  }
}, "incremental");

await test("visual breathing and caption layout plans compile into incremental rebuilds", () => {
  const baseline = path.join(temporary, "breathing-caption-baseline.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:d=4:r=25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", baseline,
  ]);
  const fixture = initializeIncrementalFixture(
    "breathing-caption-change",
    { baseline },
  );
  const breathingCues = path.join(fixture.root, "breathing-cues.json");
  const captionCues = path.join(fixture.root, "caption-cues.json");
  const breathingPlan = path.join(fixture.root, "breathing-plan.json");
  const captionPlan = path.join(fixture.root, "caption-plan.json");
  writeJson(breathingCues, [{
    id: "conclusion",
    start: 0.2,
    end: 2,
    text: "关键是有收有放",
    breathingIntent: "emphasis_punch_settle",
  }]);
  writeJson(captionCues, [{
    id: "caption",
    start: 2.1,
    end: 3.7,
    text: "字幕表达真实的信息关系",
    captionLayout: "logic_emphasis_inline",
    emphasis: "真实",
  }]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "breathing", "plan",
    "--input", baseline,
    "--transcript", breathingCues,
    "--output", breathingPlan,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "captions", "plan",
    "--input", baseline,
    "--transcript", captionCues,
    "--output", captionPlan,
  ]);
  const requestFile = path.join(fixture.root, "change-request.json");
  const outputRoot = path.join(fixture.root, "versions", "v2");
  writeJson(requestFile, {
    schemaVersion: "1.0",
    projectContext: fixture.context,
    newVersion: { id: "v2", intent: "candidate" },
    changes: [
      {
        recipe: "visual_breathing",
        reason: "结论需要一次有停稳的画面呼吸",
        parameters: { plan: breathingPlan },
      },
      {
        recipe: "caption_layout",
        reason: "重点句需要经过校准的逻辑重音字幕",
        parameters: { plan: captionPlan },
      },
    ],
    render: { strategy: "auto" },
    deliverables: { covers: [], subtitles: [] },
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "compile-change",
    requestFile,
    "--output-dir", outputRoot,
  ]);
  const delta = readJson(path.join(outputRoot, "version-delta.json"));
  const plan = readJson(path.join(outputRoot, "output", "incremental-plan.json"));
  if (
    !delta.changeSet.types.includes("visual_breathing")
    || !delta.changeSet.types.includes("caption_layout")
    || !plan.artifactPlan.invalidatedTypes.includes("visual_segment")
    || !plan.artifactPlan.invalidatedTypes.includes("subtitle_overlay")
    || !plan.artifactPlan.invalidatedTypes.includes("sfx_stem")
  ) {
    throw new Error("breathing/caption plans were not compiled into the real rebuild graph");
  }
}, "incremental");

await test("next action advances only one deterministic project state", () => {
  const fixture = initializeIncrementalFixture("next-action");
  const candidate = path.join(fixture.root, "v2.mov");
  const current = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "beauty_adjust",
    outputVideo: candidate,
  });
  const first = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "next",
    current.project,
  ]);
  const firstState = JSON.parse(first.stdout);
  if (firstState.nextAction.id !== "build_incremental_plan") {
    throw new Error(`unexpected first action ${firstState.nextAction.id}`);
  }
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-plan",
    current.project,
  ]);
  const second = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "next",
    current.project,
  ]);
  const secondState = JSON.parse(second.stdout);
  if (
    secondState.nextAction.id !== "render_changed_layers"
    || secondState.nextAction.owner !== "render_engine"
    || secondState.nextAction.safeToAutoExecute !== false
  ) {
    throw new Error("next action did not stop at the real render boundary");
  }
}, "incremental");

await test("compact project state persists decisions and evidence outside chat history", () => {
  const fixture = initializeIncrementalFixture("compact-state");
  const current = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "caption_layout",
    outputVideo: path.join(fixture.root, "v2.mov"),
  });
  const stateFile = path.join(fixture.root, ".kacha", "project-state.json");
  const evidence = path.join(fixture.root, "edit-evidence.json");
  writeJson(evidence, {
    status: "pass",
    stage: "edit",
    checks: ["sentence-boundary", "shot-scale-alternation"],
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "state",
    "snapshot",
    current.project,
    "--output",
    stateFile,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "state",
    "record",
    stateFile,
    "--stage",
    "edit",
    "--status",
    "complete",
    "--evidence",
    evidence,
    "--decision",
    "只按信息、情绪或视角变化切镜",
  ]);
  const recorded = readJson(stateFile);
  const firstDigest = recorded.digest;
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "state",
    "snapshot",
    current.project,
    "--output",
    stateFile,
  ]);
  const refreshed = readJson(stateFile);
  if (
    refreshed.stages.edit?.status !== "complete"
    || refreshed.stages.edit?.evidence?.sha256 !== sha256File(evidence)
    || refreshed.decisions.length !== 1
    || refreshed.digest !== firstDigest
  ) {
    throw new Error("compact project state did not preserve stable evidence-backed decisions");
  }
}, "incremental");

await test("v2 workflow state resets completed stages when a bound contract changes", () => {
  const root = path.join(temporary, "v2-state-contract-reset");
  fs.mkdirSync(root, { recursive: true });
  const editPlan = path.join(root, "edit-plan.json");
  fs.copyFileSync(path.join(examples, "edit-plan.json"), editPlan);
  const projectFile = path.join(root, "project.json");
  writeJson(projectFile, {
    schemaVersion: "2.0",
    projectId: "v2-state-contract-reset",
    plans: {
      proposal: ensureValidProposalFixture(),
      editPlan,
      generatedShotPlans: [],
    },
    expectedMedia: { width: 2160, height: 3840 },
    requiredCoverAspectRatios: [],
    outputs: { finalVideo: { path: path.join(root, "final.mov") } },
  });
  const stateFile = path.join(root, ".kacha", "project-state.json");
  const evidence = path.join(root, "inventory-evidence.json");
  writeJson(evidence, { status: "pass", stage: "inventory" });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "state", "snapshot", projectFile, "--output", stateFile,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "state", "record", stateFile,
    "--stage", "inventory", "--status", "complete", "--evidence", evidence,
  ]);
  const before = readJson(stateFile);
  const renderedProject = readJson(projectFile);
  renderedProject.outputs.finalVideo.sha256 = "a".repeat(64);
  writeJson(projectFile, renderedProject);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "state", "snapshot", projectFile, "--output", stateFile,
  ]);
  const afterRuntimeIdentity = readJson(stateFile);
  if (
    afterRuntimeIdentity.stages.inventory?.status !== "complete"
    || afterRuntimeIdentity.contract.digest !== before.contract.digest
  ) {
    throw new Error("v2 state reset after only a rendered output identity changed");
  }
  const changedPlan = readJson(editPlan);
  changedPlan.timelineDurationSeconds += 0.001;
  writeJson(editPlan, changedPlan);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "state", "snapshot", projectFile, "--output", stateFile,
  ]);
  const after = readJson(stateFile);
  if (
    before.stages.inventory?.status !== "complete"
    || after.stages.inventory?.status !== "pending"
    || afterRuntimeIdentity.contract.digest === after.contract.digest
  ) {
    throw new Error("v2 state reused stage completion across a changed contract");
  }
});

await test("final timeline fails early when production contracts or asset provenance are missing", () => {
  ensureMediaFixtures();
  const directory = path.join(temporary, "final-timeline-provenance-gate");
  fs.mkdirSync(directory, { recursive: true });
  const timeline = path.join(directory, "timeline.json");
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "final-provenance-gate",
    mode: "final",
    source: {
      path: baseVideo,
      sha256: sha256File(baseVideo),
    },
    edl: [{ id: "full", sourceStart: 0, sourceEnd: 2 }],
    visual: {
      breathing: [],
      overlays: [],
      subtitles: {
        path: baseVideo,
        kind: "overlay_video",
      },
    },
    audio: { sfx: [] },
    output: {
      path: path.join(directory, "final.mp4"),
      width: 320,
      height: 180,
      fps: 25,
    },
  });
  const failure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "timeline",
    "validate",
    "--plan",
    timeline,
  ]);
  for (const expected of [
    "contracts.proposal",
    "contracts.editPlan",
    "visual.subtitles.sha256",
    "visual.subtitles.provenance.kind/evidence",
  ]) {
    if (!failure.stderr.includes(expected)) {
      throw new Error(`final timeline did not fail early for ${expected}`);
    }
  }
});

function renderVisualOnlyCandidate(base, output) {
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", base,
    "-map", "0:v:0", "-map", "0:a:0",
    "-vf", "eq=brightness=0.015:saturation=1.01",
    "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
    "-c:a", "copy",
    output,
  ]);
}

function approveIncrementalReview(reviewFile, status) {
  const review = readJson(reviewFile);
  review.status = status;
  review.reviewedAt = new Date().toISOString();
  review.reviewer = "synthetic incremental regression";
  review.limitations = ["none"];
  for (const item of Object.values(review.manualChecks)) {
    item.status = "pass";
    item.evidence = ["synthetic review evidence"];
  }
  writeJson(reviewFile, review);
}

await test("mask effect rejects shorter mask instead of repeating last frame", () => {
  ensureMediaFixtures();
  expectFailure(path.join(scripts, "apply_mask_effect.sh"), [
    baseVideo,
    shortMask,
    path.join(temporary, "mask-should-fail.mov"),
    "face-light",
  ]);
});

await test("content-addressed artifact cache reuses exact outputs and releases resources", () => {
  const root = path.join(temporary, "artifact-cache-project");
  fs.mkdirSync(root, { recursive: true });
  const input = path.join(root, "input.txt");
  const output = path.join(root, "materialized.txt");
  fs.writeFileSync(input, "content-addressed fixture\n");
  const baseArguments = [
    path.join(scripts, "kacha.mjs"),
    "cache",
    "run",
    "--project-root",
    root,
    "--kind",
    "styleframe",
    "--input",
    input,
    "--implementation",
    path.join(scripts, "artifact_cache.mjs"),
    "--operation-version",
    "test-v1",
    "--parameters",
    JSON.stringify({ style: "xingzhe", state: "peak" }),
    "--output",
    `artifact=${output}`,
    "--resource",
    "ioHeavy",
    "--",
    "/bin/cp",
    input,
    output,
  ];
  const first = JSON.parse(execute(process.execPath, baseArguments).stdout);
  if (first.cache.status !== "miss" || !fs.existsSync(output)) {
    throw new Error("first content-addressed execution did not populate the cache");
  }
  fs.unlinkSync(output);
  const second = JSON.parse(execute(process.execPath, baseArguments).stdout);
  if (
    second.cache.status !== "hit"
    || second.cache.key !== first.cache.key
    || fs.readFileSync(output, "utf8") !== fs.readFileSync(input, "utf8")
  ) {
    throw new Error("exact content-addressed rerun did not materialize a verified hit");
  }
  const status = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "resources",
    "status",
    "--project-root",
    root,
  ]).stdout);
  const cachePurpose = `cache:styleframe:${first.cache.key.slice(0, 12)}`;
  if (
    Object.values(status.resources).some((resource) => (
      resource.leases ?? []
    ).some((lease) => lease.purpose === cachePurpose))
  ) {
    throw new Error("resource scheduler leaked this cache execution's lease");
  }
  const directoryOutput = path.join(root, "mask-frames");
  const directoryArguments = [
    path.join(scripts, "kacha.mjs"),
    "cache",
    "run",
    "--project-root",
    root,
    "--kind",
    "tracking",
    "--input",
    input,
    "--implementation",
    path.join(scripts, "artifact_cache.mjs"),
    "--operation-version",
    "test-directory-v1",
    "--parameters",
    JSON.stringify({ sampleFps: 2, quality: "balanced" }),
    "--output-dir",
    `frames=${directoryOutput}`,
    "--resource",
    "ioHeavy",
    "--",
    process.execPath,
    "-e",
    "const fs=require('node:fs'),p=process.argv[1];"
      + "fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/frame-1.txt','mask');",
    directoryOutput,
  ];
  const directoryMiss = JSON.parse(
    execute(process.execPath, directoryArguments).stdout,
  );
  fs.rmSync(directoryOutput, { recursive: true, force: true });
  const directoryHit = JSON.parse(
    execute(process.execPath, directoryArguments).stdout,
  );
  if (
    directoryMiss.cache.status !== "miss"
    || directoryHit.cache.status !== "hit"
    || fs.readFileSync(path.join(directoryOutput, "frame-1.txt"), "utf8") !== "mask"
  ) {
    throw new Error("directory artifact cache did not preserve a mask/tracking tree");
  }
  const inspection = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "cache",
    "inspect",
    "--project-root",
    root,
  ]).stdout);
  if (
    inspection.entries !== 2
    || !inspection.kinds.includes("styleframe")
    || !inspection.kinds.includes("tracking")
  ) {
    throw new Error("cache inspection did not report the ready entry");
  }
  const sensitive = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "cache",
    "key",
    "--kind",
    "asr",
    "--input",
    input,
    "--parameters",
    JSON.stringify({ apiToken: "must-not-be-recorded" }),
  ]);
  if (!sensitive.stderr.includes("禁止进入缓存键")) {
    throw new Error("cache accepted sensitive parameters into its manifest contract");
  }
  const capacityRoot = path.join(temporary, "artifact-cache-capacity");
  fs.mkdirSync(capacityRoot, { recursive: true });
  const capacityConfig = path.join(capacityRoot, "capacity.config.json");
  const capacityInput = path.join(capacityRoot, "large.bin");
  fs.writeFileSync(capacityInput, Buffer.alloc(700 * 1024, 7));
  writeJson(capacityConfig, {
    schemaVersion: "1.0",
    execution: {
      artifactCache: {
        maximumBytes: 1024 * 1024,
      },
    },
  });
  const cacheCapacityRun = (variant, destination) => run(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "cache",
    "run",
    "--project-root",
    capacityRoot,
    "--config",
    capacityConfig,
    "--kind",
    "generated_media",
    "--input",
    capacityInput,
    "--implementation",
    path.join(scripts, "artifact_cache.mjs"),
    "--operation-version",
    "capacity-v1",
    "--parameters",
    JSON.stringify({ variant }),
    "--output",
    `artifact=${destination}`,
    "--",
    "/bin/cp",
    capacityInput,
    destination,
  ], { cwd: temporary });
  const firstCapacity = cacheCapacityRun(
    "first",
    path.join(capacityRoot, "first.bin"),
  );
  const secondCapacity = cacheCapacityRun(
    "second",
    path.join(capacityRoot, "second.bin"),
  );
  if (
    firstCapacity.status !== 0
    || secondCapacity.status === 0
    || !secondCapacity.stderr.includes("缓存容量不足")
  ) {
    throw new Error("artifact cache did not enforce its cumulative maximumBytes limit");
  }
});

await test("cache run creates a previously missing project root", () => {
  const root = path.join(temporary, "artifact-cache-new-project");
  const input = path.join(temporary, "artifact-cache-new-project-input.txt");
  const output = path.join(root, "materialized.txt");
  fs.writeFileSync(input, "new project root fixture\n");
  if (fs.existsSync(root)) {
    throw new Error("new-project cache fixture unexpectedly exists before the run");
  }
  const result = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "cache",
    "run",
    "--project-root",
    root,
    "--kind",
    "asr",
    "--input",
    input,
    "--implementation",
    path.join(scripts, "artifact_cache.mjs"),
    "--operation-version",
    "new-project-root-v1",
    "--parameters",
    JSON.stringify({ language: "zh" }),
    "--output",
    `transcript=${output}`,
    "--resource",
    "ioHeavy",
    "--",
    "/bin/cp",
    input,
    output,
  ]).stdout);
  if (
    result.cache.status !== "miss"
    || !fs.statSync(root).isDirectory()
    || fs.readFileSync(output, "utf8") !== fs.readFileSync(input, "utf8")
  ) {
    throw new Error("cache run did not bootstrap and materialize a new project root");
  }
});

await test("host resource pool is shared across independent project roots", () => {
  const config = readJson(path.join(skillDirectory, "config", "defaults.json"));
  const firstRoot = path.join(temporary, "resource-project-a");
  const secondRoot = path.join(temporary, "resource-project-b");
  const runtimeRoot = path.join(temporary, "host-runtime");
  process.env.KACHA_RUNTIME_HOME = runtimeRoot;
  try {
    const first = resolveResourceDirectory({ config, projectRoot: firstRoot });
    const second = resolveResourceDirectory({ config, projectRoot: secondRoot });
    if (first !== second || !first.startsWith(runtimeRoot)) {
      throw new Error("host-scoped resource pools diverged across project roots");
    }
  } finally {
    delete process.env.KACHA_RUNTIME_HOME;
  }
});

await test("warm high-value cache rerun exceeds the 80 percent reuse target", () => {
  const root = path.join(temporary, "high-value-cache-coverage");
  fs.mkdirSync(root, { recursive: true });
  const input = path.join(root, "input.bin");
  fs.writeFileSync(input, Buffer.from("high-value cache fixture"));
  const kinds = [
    "source_separation",
    "asr",
    "mask",
    "tracking",
    "beauty",
    "styleframe",
    "generated_media",
  ];
  let hits = 0;
  for (const kind of kinds) {
    const destination = path.join(root, `${kind}.bin`);
    const command = [
      path.join(scripts, "kacha.mjs"),
      "cache",
      "run",
      "--project-root",
      root,
      "--kind",
      kind,
      "--input",
      input,
      "--implementation",
      path.join(scripts, "artifact_cache.mjs"),
      "--operation-version",
      "coverage-v1",
      "--parameters",
      JSON.stringify({ fixture: kind }),
      "--output",
      `artifact=${destination}`,
      "--",
      "/bin/cp",
      input,
      destination,
    ];
    const first = JSON.parse(execute(process.execPath, command).stdout);
    fs.unlinkSync(destination);
    const second = JSON.parse(execute(process.execPath, command).stdout);
    if (first.cache.status !== "miss") {
      throw new Error(`${kind} did not establish a cold baseline`);
    }
    if (second.cache.status === "hit") hits += 1;
  }
  if (hits / kinds.length < 0.8) {
    throw new Error(
      `high-value warm cache hit ratio ${(hits / kinds.length).toFixed(3)} is below 0.8`,
    );
  }
});

await test("dialogue separation cache fingerprints the actual Demucs runtime", () => {
  const source = fs.readFileSync(
    path.join(scripts, "separate_dialogue.sh"),
    "utf8",
  );
  const engineResolution = source.indexOf('engine="kacha-managed-demucs"');
  const cacheEntry = source.indexOf('if [[ "$no_cache" != true ]]');
  const requiredFragments = [
    'script_self="$script_dir/$(basename "${BASH_SOURCE[0]}")"',
    'runtime_fingerprint="demucs=${runtime_demucs_version};torch=${runtime_torch_version}"',
    '--operation-version "demucs-two-stems-v2"',
    '--implementation "$runtime_launcher"',
    '--implementation "$runtime_demucs_module"',
    '--implementation "$runtime_demucs_entry_module"',
    '--arg runtimeFingerprint "$runtime_fingerprint"',
    '--arg modelContentSha256 "$runtime_model_sha"',
    'modelContentSha256:$modelContentSha256',
    'bash "$script_self" "$input" "$output_dir"',
  ];
  if (
    engineResolution < 0
    || cacheEntry < 0
    || engineResolution > cacheEntry
    || requiredFragments.some((fragment) => !source.includes(fragment))
  ) {
    throw new Error(
      "source separation cache no longer freezes the resolved Demucs/Torch runtime",
    );
  }
});

await test("automatic telemetry records tokens, cache, artifacts and redacted commands", () => {
  const root = path.join(temporary, "telemetry-project");
  fs.mkdirSync(root, { recursive: true });
  const artifact = path.join(root, "candidate.mov");
  fs.writeFileSync(artifact, "synthetic candidate");
  const childProgram = [
    "const out=process.argv[1];",
    "console.log(JSON.stringify({status:'reused',output:out,videoEncodes:0,"
      + "durationSeconds:3,apiToken:'must-be-redacted-result'}));",
    "console.error('Authorization: '+['Be','arer'].join('')+' must-be-redacted-log');",
  ].join("");
  const result = run(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "metrics",
    "run",
    "--stage",
    "preview_render",
    "--project-root",
    root,
    "--reference-tokens",
    "402",
    "--",
    process.execPath,
    "-e",
    childProgram,
    artifact,
    "--api-token=must-be-redacted-inline",
  ], {
    cwd: temporary,
    env: {
      ...process.env,
      KACHA_INPUT_TOKENS: "123",
      KACHA_OUTPUT_TOKENS: "45",
    },
  });
  if (result.status !== 0) {
    throw new Error(`telemetry execution failed: ${result.stderr}`);
  }
  const compact = JSON.parse(result.stdout);
  const report = readJson(compact.metrics);
  const eventLine = fs.readFileSync(report.eventLog, "utf8").trim().split("\n").at(-1);
  const event = JSON.parse(eventLine);
  if (
    report.tokens.input !== 123
    || report.tokens.output !== 45
    || report.tokens.references !== 402
    || report.cache.hit !== 1
    || report.media.videoEncodes !== 0
    || report.bottlenecks.dominantTimeStage?.stage !== "preview_render"
    || report.bottlenecks.dominantTokenStage?.totalTokens !== 570
    || event.artifacts[0]?.exists !== true
    || JSON.stringify(event.command).includes("must-be-redacted")
    || !event.command.includes("[REDACTED]")
    || compact.result.apiToken !== "[REDACTED]"
    || fs.readFileSync(event.logs.stdout, "utf8").includes("must-be-redacted")
    || fs.readFileSync(event.logs.stderr, "utf8").includes("must-be-redacted")
    || !fs.readFileSync(event.logs.stderr, "utf8").includes("[REDACTED]")
  ) {
    throw new Error("automatic telemetry did not record or redact its execution evidence");
  }
});

await test("telemetry captures model usage from child JSON without manual token flags", () => {
  const root = path.join(temporary, "telemetry-child-usage");
  fs.mkdirSync(root, { recursive: true });
  const result = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "metrics",
    "run",
    "--stage",
    "content_planning",
    "--project-root",
    root,
    "--",
    process.execPath,
    "-e",
    "console.log(JSON.stringify({status:'pass',usage:{input_tokens:321,"
      + "output_tokens:87,reference_tokens:55}}));",
  ]);
  const compact = JSON.parse(result.stdout);
  const report = readJson(compact.metrics);
  const event = JSON.parse(
    fs.readFileSync(report.eventLog, "utf8").trim().split("\n").at(-1),
  );
  if (
    event.tokens.input !== 321
    || event.tokens.output !== 87
    || event.tokens.references !== 55
    || event.tokens.measurement !== "actual"
    || event.tokens.source !== "child_result_usage"
    || report.tokens.measuredEvents !== 1
  ) {
    throw new Error("child model usage was not captured as actual token evidence");
  }
});

await test("telemetry wrapper options do not consume child command options", () => {
  const root = path.join(temporary, "telemetry-child-option-boundary");
  fs.mkdirSync(root, { recursive: true });
  const childScript = path.join(root, "child-options.mjs");
  fs.writeFileSync(
    childScript,
    "console.log(JSON.stringify({status:'pass',childMode:process.argv[3],"
      + "childConfig:process.argv[5]}));\n",
  );
  const result = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "metrics",
    "run",
    "--stage",
    "inventory",
    "--project-root",
    root,
    "--mode",
    "preview",
    "--",
    process.execPath,
    childScript,
    "--mode",
    "review",
    "--config",
    "/tmp/child-only-config.json",
  ]);
  const compact = JSON.parse(result.stdout);
  const report = readJson(compact.metrics);
  const event = JSON.parse(
    fs.readFileSync(report.eventLog, "utf8").trim().split("\n").at(-1),
  );
  if (
    event.mode !== "preview"
    || compact.result.childMode !== "review"
    || compact.result.childConfig !== "/tmp/child-only-config.json"
    || !event.command.includes("/tmp/child-only-config.json")
  ) {
    throw new Error("telemetry wrapper consumed options that belong to the child command");
  }
});

await test("optimization audit rejects fabricated and stale engineering evidence", () => {
  const root = path.join(temporary, "optimization-audit");
  fs.mkdirSync(root, { recursive: true });
  const golden = path.join(root, "golden.json");
  const tests = path.join(root, "tests.json");
  const asr = path.join(root, "asr.json");
  const install = path.join(root, "install.json");
  const output = path.join(root, "audit.json");
  writeJson(golden, {
    status: "pass_requires_human_visual_listening_review",
    digest: "a".repeat(64),
    checks: {
      oneFullVideoEncode: true,
      exactReuseZeroEncode: true,
      geometryPreserved: true,
      avDriftWithinOneFrame: true,
      technicalQcPassed: true,
      noSilentFallback: true,
    },
    remainingHumanEvidence: [
      "normal-speed visual review",
      "headphone review",
      "phone speaker review",
    ],
    sample: { mode: "final" },
    source: { sha256: "d".repeat(64) },
    output: { sha256: "e".repeat(64) },
  });
  writeJson(tests, {
    status: "pass",
    tests: 88,
    passed: 88,
    passedTests: [
      "warm high-value cache rerun exceeds the 80 percent reuse target",
      "deterministic rule engine gives weak models stable scored decisions",
    ],
    failed: [],
  });
  writeJson(asr, {
    schemaVersion: "1.0",
    status: "pass",
    provider: "local_whisper_mlx",
    input: { sha256: "c".repeat(64) },
    text: "咔嚓本机转写验证",
    segments: [{
      id: "segment-0001",
      start: 0,
      end: 1,
      text: "咔嚓本机转写验证",
    }],
    provenance: {
      externalUpload: false,
      endpointScope: "loopback_only",
    },
  });
  const bundleDigest = "b".repeat(64);
  writeJson(install, {
    status: "dry_run_pass",
    bundleDigest,
    targets: [
      { agent: "codex", digest: bundleDigest, action: "unchanged" },
      { agent: "claude", digest: bundleDigest, action: "unchanged" },
    ],
  });
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "optimization-audit",
    "run",
    "--golden-report",
    golden,
    "--test-report",
    tests,
    "--asr-report",
    asr,
    "--install-report",
    install,
    "--output",
    output,
  ]);
  const report = readJson(output);
  if (
    report.status !== "fail"
    || report.checks.evidenceProvenanceVerified !== false
    || report.checks.fullRegressionPassed !== false
  ) {
    throw new Error("optimization audit accepted fabricated or stale report claims");
  }
  const incomplete = readJson(golden);
  incomplete.checks.oneFullVideoEncode = false;
  const incompleteFile = path.join(root, "incomplete-golden.json");
  writeJson(incompleteFile, incomplete);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "optimization-audit",
    "run",
    "--golden-report",
    incompleteFile,
    "--test-report",
    tests,
    "--asr-report",
    asr,
    "--install-report",
    install,
    "--output",
    path.join(root, "incomplete-audit.json"),
  ]);
});

await test("text-behind rejects shorter layer instead of truncating base", () => {
  ensureMediaFixtures();
  expectFailure(path.join(scripts, "compose_text_behind_person.sh"), [
    baseVideo,
    exactMask,
    shortMask,
    path.join(temporary, "text-should-fail.mov"),
  ]);
});

await test("aligned mask and text pipelines preserve base duration", () => {
  ensureMediaFixtures();
  const masked = path.join(temporary, "masked.mov");
  const composed = path.join(temporary, "composed.mov");
  execute(path.join(scripts, "apply_mask_effect.sh"), [
    baseVideo,
    exactMask,
    masked,
    "face-light",
  ]);
  execute(path.join(scripts, "compose_text_behind_person.sh"), [
    baseVideo,
    exactMask,
    exactText,
    composed,
  ]);
  const baseDuration = mediaSummary(baseVideo).duration;
  for (const file of [masked, composed]) {
    const delta = Math.abs(mediaSummary(file).duration - baseDuration);
    if (delta > 1 / 25 + 0.0005) {
      throw new Error(`${path.basename(file)} duration drifted by ${delta}s`);
    }
  }
});

await test("Beauty v2 profiles preserve duration and produce distinct outputs", () => {
  ensureMediaFixtures();
  const natural = path.join(temporary, "beauty-v2-natural.mov");
  const visible = path.join(temporary, "beauty-v2-visible.mov");
  const naturalConfig = path.join(temporary, "beauty-v2-natural-config.json");
  const visibleConfig = path.join(temporary, "beauty-v2-visible-config.json");
  writeJson(naturalConfig, {
    schemaVersion: "1.0",
    editingDefaults: {
      parameters: {
        beauty: {
          enabled: true,
          engine: "beauty-v2",
          profile: "natural",
        },
      },
    },
  });
  writeJson(visibleConfig, {
    schemaVersion: "1.0",
    editingDefaults: {
      parameters: {
        beauty: {
          enabled: true,
          engine: "beauty-v2",
          profile: "visible",
        },
      },
    },
  });
  const sourceMedia = mediaSummary(baseVideo);
  const visionManifest = path.join(temporary, "beauty-v2-vision-manifest.json");
  const frameCount = Math.round(sourceMedia.duration * sourceMedia.fps);
  writeJson(visionManifest, {
    input: baseVideo,
    sourceSha256: sha256File(baseVideo),
    sampleFPS: sourceMedia.fps,
    sourceFPS: sourceMedia.fps,
    sourceDuration: sourceMedia.duration,
    frames: Array.from({ length: frameCount }, (_, index) => ({
      index: index + 1,
      primaryFaceIndex: 0,
      primaryTrackingStatus: index === 0 ? "acquired" : "locked",
      primaryLandmarksAvailable: true,
      primaryJumpRatio: index === 0 ? null : 0.01,
      candidateCount: 1,
      beautyMaskApplied: true,
      faces: [{
        isPrimary: true,
        landmarksAvailable: true,
      }],
    })),
  });
  expectFailure(path.join(scripts, "apply_beauty_v2.sh"), [
    baseVideo,
    exactMask,
    exactMask,
    path.join(temporary, "beauty-v2-disabled.mov"),
    "natural",
    "--vision-manifest",
    visionManifest,
  ]);
  const naturalReport = path.join(temporary, "beauty-v2-natural-report.json");
  execute(path.join(scripts, "apply_beauty_v2.sh"), [
    baseVideo,
    exactMask,
    exactMask,
    natural,
    "natural",
    "--vision-manifest",
    visionManifest,
    "--config",
    naturalConfig,
    "--report",
    naturalReport,
  ]);
  const cachedNatural = path.join(temporary, "beauty-v2-cached-natural.mov");
  const cachedNaturalReport = path.join(
    temporary,
    "beauty-v2-cached-natural-report.json",
  );
  const cachedBeautyArguments = [
    path.join(scripts, "kacha.mjs"),
    "beauty",
    "render",
    baseVideo,
    "--skin-mask",
    exactMask,
    "--nasolabial-mask",
    exactMask,
    "--vision-manifest",
    visionManifest,
    "--output",
    cachedNatural,
    "--report",
    cachedNaturalReport,
    "--profile",
    "natural",
    "--config",
    naturalConfig,
    "--project-root",
    temporary,
  ];
  const cachedBeautyMiss = JSON.parse(
    execute(process.execPath, cachedBeautyArguments).stdout,
  );
  fs.unlinkSync(cachedNatural);
  fs.unlinkSync(cachedNaturalReport);
  const cachedBeautyHit = JSON.parse(
    execute(process.execPath, cachedBeautyArguments).stdout,
  );
  if (
    cachedBeautyMiss.cache?.status !== "miss"
    || cachedBeautyHit.cache?.status !== "hit"
    || !fs.existsSync(cachedNatural)
    || !fs.existsSync(cachedNaturalReport)
  ) {
    throw new Error("Beauty v2 wrapper did not reuse its content-addressed render");
  }
  execute(path.join(scripts, "apply_beauty_v2.sh"), [
    baseVideo,
    exactMask,
    exactMask,
    visible,
    "visible",
    "--vision-manifest",
    visionManifest,
    "--config",
    visibleConfig,
  ]);
  const baseDuration = mediaSummary(baseVideo).duration;
  for (const file of [natural, visible]) {
    if (Math.abs(mediaSummary(file).duration - baseDuration) > 1 / 25 + 0.0005) {
      throw new Error(`${path.basename(file)} duration drifted`);
    }
  }
  if (sha256File(natural) === sha256File(visible)) {
    throw new Error("Beauty v2 natural and visible unexpectedly produced identical files");
  }
  const localizedOutput = path.join(temporary, "beauty-v2-localized.mov");
  execute(path.join(scripts, "apply_beauty_v2.sh"), [
    baseVideo,
    localizedMask,
    localizedMask,
    localizedOutput,
    "visible",
    "--vision-manifest",
    visionManifest,
    "--config",
    visibleConfig,
  ]);
  const control = path.join(temporary, "beauty-v2-control.mov");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", baseVideo,
    "-vf", "format=yuv444p10le,format=yuv422p10le",
    "-map", "0:v:0", "-map", "0:a?",
    "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
    "-c:a", "copy",
    control,
  ]);
  const chromaCheck = run("ffmpeg", [
    "-hide_banner", "-loglevel", "info",
    "-i", control,
    "-i", localizedOutput,
    "-filter_complex",
    "[0:v]crop=96:180:0:0[a];[1:v]crop=96:180:0:0[b];[a][b]psnr",
    "-f", "null", "-",
  ]);
  if (chromaCheck.status !== 0) {
    throw new Error(`Beauty v2 chroma isolation check failed: ${chromaCheck.stderr}`);
  }
  const psnr = /PSNR y:([^ ]+) u:([^ ]+) v:([^ ]+) average:([^ ]+)/.exec(
    chromaCheck.stderr,
  );
  const acceptable = (value) => value === "inf" || Number(value) >= 55;
  if (!psnr || !acceptable(psnr[2]) || !acceptable(psnr[3])) {
    throw new Error(`Beauty v2 leaked chroma outside its mask: ${psnr?.[0] ?? "no PSNR"}`);
  }
  const report = readJson(naturalReport);
  if (
    report.status !== "pass_with_review"
    || report.technicalStatus !== "pass"
    || report.manualStatus !== "review_required"
    || report.tracking.metrics.primaryFaceCoverage !== 1
    || !/^[a-f0-9]{64}$/.test(report.implementation?.digest)
    || report.implementation?.files?.some(
      (file) => !/^[a-f0-9]{64}$/.test(file.sha256),
    )
  ) {
    throw new Error("Beauty v2 did not emit a gated technical QC report");
  }
  const manualReview = path.join(temporary, "beauty-v2-manual-review.json");
  writeJson(manualReview, {
    schemaVersion: "1.0",
    reviewer: "automated-test-fixture",
    reviewedAt: "2026-07-28T00:00:00.000Z",
    outputSha256: sha256File(natural),
    visionManifestSha256: sha256File(visionManifest),
    profile: "natural",
    sameFrameAB: true,
    temporalFlickerReviewed: true,
    skinNeckContinuityReviewed: true,
    dynamicReviewRef: natural,
    dynamicReviewSha256: sha256File(natural),
    requiredFrames: Object.fromEntries(
      [
        "front_neutral",
        "front_speaking",
        "head_turn",
        "blink",
        "glasses_reflection",
        "hand_near_face",
      ].map((id, index) => [id, {
        status: "pass",
        timeSeconds: Math.min(
          sourceMedia.duration - 1 / sourceMedia.fps,
          index / sourceMedia.fps,
        ),
        evidenceRef: natural,
        evidenceSha256: sha256File(natural),
      }]),
    ),
  });
  const releaseQc = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "beauty",
    "qc",
    baseVideo,
    natural,
    "--skin-mask",
    exactMask,
    "--nasolabial-mask",
    exactMask,
    "--vision-manifest",
    visionManifest,
    "--profile",
    "natural",
    "--manual-review",
    manualReview,
    "--ab-dir",
    path.join(temporary, "beauty-v2-release-ab"),
  ]).stdout);
  if (releaseQc.status !== "pass" || releaseQc.manualStatus !== "pass") {
    throw new Error("Beauty v2 release QC did not honor complete manual evidence");
  }
  const staleReview = readJson(manualReview);
  staleReview.outputSha256 = "0".repeat(64);
  const staleReviewFile = path.join(temporary, "beauty-v2-stale-review.json");
  writeJson(staleReviewFile, staleReview);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "beauty",
    "qc",
    baseVideo,
    natural,
    "--skin-mask",
    exactMask,
    "--nasolabial-mask",
    exactMask,
    "--vision-manifest",
    visionManifest,
    "--profile",
    "natural",
    "--manual-review",
    staleReviewFile,
    "--ab-dir",
    path.join(temporary, "beauty-v2-stale-review-ab"),
  ]);
  const ambiguousManifest = readJson(visionManifest);
  ambiguousManifest.frames.slice(0, 3).forEach((frame) => {
    frame.primaryTrackingStatus = "ambiguous";
    frame.beautyMaskApplied = false;
  });
  const ambiguousFile = path.join(temporary, "beauty-v2-ambiguous-manifest.json");
  writeJson(ambiguousFile, ambiguousManifest);
  expectFailure(process.execPath, [
    path.join(scripts, "beauty_qc.mjs"),
    baseVideo,
    natural,
    "--skin-mask",
    exactMask,
    "--nasolabial-mask",
    exactMask,
    "--vision-manifest",
    ambiguousFile,
    "--profile",
    "natural",
    "--technical-only",
  ]);
  const staleSourceManifest = readJson(visionManifest);
  staleSourceManifest.sourceSha256 = "0".repeat(64);
  const staleSourceFile = path.join(
    temporary,
    "beauty-v2-stale-source-manifest.json",
  );
  writeJson(staleSourceFile, staleSourceManifest);
  expectFailure(process.execPath, [
    path.join(scripts, "beauty_qc.mjs"),
    baseVideo,
    natural,
    "--skin-mask",
    exactMask,
    "--nasolabial-mask",
    exactMask,
    "--vision-manifest",
    staleSourceFile,
    "--profile",
    "natural",
    "--technical-only",
  ]);
});

await test("Claude visual evidence is local, cacheable and upload-gated", () => {
  ensureMediaFixtures();
  const visualConfigFile = path.join(temporary, "visual-config.json");
  writeJson(visualConfigFile, {
    schemaVersion: "1.0",
    execution: {
      visualEvidence: {
        maxFrames: {
          fast: 4,
        },
        maxImageEdge: 640,
      },
      minimaxVision: {
        maxFrames: 2,
        networkMode: "configured_environment",
      },
    },
    providers: {
      minimax: {
        region: "global",
      },
    },
  });
  const configuredOutput = path.join(temporary, "visual-evidence-configured");
  const configured = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-evidence",
    baseVideo,
    "--output-dir",
    configuredOutput,
    "--mode",
    "fast",
    "--config",
    visualConfigFile,
    "--skip-apple-vision",
  ]).stdout);
  if (configured.frames !== 4 || !configured.configurationDigest) {
    throw new Error("visual-evidence did not use configured frame and provenance defaults");
  }
  const configuredEvidence = path.join(configuredOutput, "visual-evidence.json");
  const configuredPlan = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "vision-enrich",
    configuredEvidence,
    "--dry-run",
    "--config",
    visualConfigFile,
  ]).stdout);
  if (
    configuredPlan.upload.selectedFrames !== 2
    || configuredPlan.provider.network !== "configured_environment"
    || configuredPlan.provider.region !== "global"
  ) {
    throw new Error("MiniMax dry-run did not use configured safe defaults");
  }
  const outputDirectory = path.join(temporary, "visual-evidence");
  const first = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-evidence",
    baseVideo,
    "--output-dir",
    outputDirectory,
    "--mode",
    "fast",
    "--max-frames",
    "5",
    "--skip-apple-vision",
  ]);
  const firstResult = JSON.parse(first.stdout);
  if (firstResult.frames !== 5 || firstResult.localSemantic !== "unavailable") {
    throw new Error("unexpected local visual evidence result");
  }
  const evidenceFile = path.join(outputDirectory, "visual-evidence.json");
  const evidence = readJson(evidenceFile);
  if (
    evidence.provenance.externalUpload !== false
    || evidence.provenance.wholeVideoUploaded !== false
    || !fs.existsSync(evidence.contactSheet.path)
  ) {
    throw new Error("local visual evidence provenance is unsafe or incomplete");
  }
  const invalidEvidenceFile = path.join(outputDirectory, "invalid-visual-evidence.json");
  fs.writeFileSync(invalidEvidenceFile, "null\n");
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "vision-enrich", invalidEvidenceFile, "--dry-run"]).stderr.includes("KACHA-E140")) throw new Error("MiniMax enrichment did not reject a null evidence root cleanly");
  const duplicateEvidence = structuredClone(evidence);
  duplicateEvidence.frames[1].id = duplicateEvidence.frames[0].id;
  writeJson(invalidEvidenceFile, duplicateEvidence);
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "vision-enrich", invalidEvidenceFile, "--dry-run"]).stderr.includes("frame id")) throw new Error("MiniMax enrichment accepted duplicate frame identities");
  const reused = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-evidence",
    baseVideo,
    "--output-dir",
    outputDirectory,
    "--mode",
    "fast",
    "--max-frames",
    "5",
    "--skip-apple-vision",
  ]);
  if (JSON.parse(reused.stdout).status !== "reused") {
    throw new Error("identical visual evidence did not hit cache");
  }
  const dryRun = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "vision-enrich",
    evidenceFile,
    "--dry-run",
    "--max-frames",
    "3",
  ]);
  const plan = JSON.parse(dryRun.stdout);
  if (
    plan.upload.wholeVideo !== false
    || plan.upload.contactSheet !== false
    || plan.upload.selectedFrames !== 3
  ) {
    throw new Error("MiniMax dry-run selected an unsafe upload scope");
  }
  const priorityEvidenceFile = path.join(outputDirectory, "priority-evidence.json");
  const priorityEvidence = structuredClone(evidence);
  priorityEvidence.findings = [{
    severity: "review",
    frameId: evidence.frames.at(-1).id,
    code: "synthetic-risk",
  }];
  writeJson(priorityEvidenceFile, priorityEvidence);
  const priorityPlan = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "vision-enrich",
    priorityEvidenceFile,
    "--dry-run",
    "--max-frames",
    "1",
  ]).stdout);
  if (priorityPlan.frames[0].id !== evidence.frames.at(-1).id) {
    throw new Error("MiniMax selection did not prioritize local findings");
  }
  const selectedFrame = evidence.frames[Math.floor(evidence.frames.length / 2)].path;
  const originalFrame = fs.readFileSync(selectedFrame);
  fs.appendFileSync(selectedFrame, "tampered");
  const staleFrame = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "vision-enrich",
    evidenceFile,
    "--dry-run",
    "--max-frames",
    "1",
  ]);
  fs.writeFileSync(selectedFrame, originalFrame);
  if (!staleFrame.stderr.includes("KACHA-E110")) {
    throw new Error("modified evidence frame did not fail identity validation");
  }
  const unpaidContext = path.join(temporary, "unpaid-visual-context.json");
  writeJson(unpaidContext, {
    authorization: {
      externalUploadAllowed: true,
      paidGenerationAllowed: false,
    },
  });
  const unpaid = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "vision-enrich",
    evidenceFile,
    "--context",
    unpaidContext,
    "--allow-external-upload",
    "--max-frames",
    "1",
  ]);
  if (!unpaid.stderr.includes("KACHA-E410")) {
    throw new Error("unpaid MiniMax request did not fail authorization");
  }
  const paidContext = path.join(temporary, "paid-visual-context.json");
  writeJson(paidContext, {
    authorization: {
      externalUploadAllowed: true,
      paidGenerationAllowed: true,
    },
  });
  const unreserved = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "vision-enrich",
    evidenceFile,
    "--context",
    paidContext,
    "--allow-external-upload",
    "--max-frames",
    "1",
  ]);
  if (!unreserved.stderr.includes("--cost-ledger") || !unreserved.stderr.includes("--cost-entry")) {
    throw new Error("authorized MiniMax request bypassed the cost reservation gate");
  }
  const denied = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "vision-enrich",
    evidenceFile,
    "--max-frames",
    "1",
  ]);
  if (!denied.stderr.includes("KACHA-E410")) {
    throw new Error("unauthorized MiniMax upload did not return KACHA-E410");
  }
}, "visual");

await test("mask PNG manifest builds an aligned lossless video", () => {
  ensureMediaFixtures();
  const maskDirectory = path.join(temporary, "mask-frames");
  fs.mkdirSync(maskDirectory);
  const first = path.join(maskDirectory, "person_000001.png");
  const second = path.join(maskDirectory, "person_000002.png");
  for (const [file, color] of [[first, "white"], [second, "black"]]) {
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${color}:s=80x45:d=0.04:r=25`,
      "-frames:v", "1", file,
    ]);
  }
  const manifest = {
    schemaVersion: "2.0",
    input: baseVideo,
    sourceFPS: 25,
    sourceDuration: 2,
    sourceWidth: 320,
    sourceHeight: 180,
    frames: [
      { timeSeconds: 0, personMask: "person_000001.png" },
      { timeSeconds: 1, personMask: "person_000002.png" },
    ],
  };
  const manifestFile = path.join(maskDirectory, "manifest.json");
  const output = path.join(maskDirectory, "person.mkv");
  writeJson(manifestFile, manifest);
  execute(process.execPath, [
    path.join(scripts, "build_mask_video.mjs"),
    manifestFile,
    "person",
    output,
  ]);
  const summary = mediaSummary(output);
  if (
    summary.width !== 320
    || summary.height !== 180
    || Math.abs(summary.fps - 25) > 0.001
    || Math.abs(summary.duration - 2) > 1 / 25 + 0.0005
  ) {
    throw new Error(`unexpected mask video contract: ${JSON.stringify(summary)}`);
  }
});

await test("skin mask PNG manifest builds an aligned lossless video", () => {
  ensureMediaFixtures();
  const maskDirectory = path.join(temporary, "skin-mask-frames");
  fs.mkdirSync(maskDirectory);
  const first = path.join(maskDirectory, "skin_000001.png");
  const second = path.join(maskDirectory, "skin_000002.png");
  for (const [file, color] of [[first, "white"], [second, "black"]]) {
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${color}:s=80x45:d=0.04:r=25`,
      "-frames:v", "1", file,
    ]);
  }
  const manifest = {
    schemaVersion: "2.0",
    input: baseVideo,
    sourceFPS: 25,
    sourceDuration: 2,
    sourceWidth: 320,
    sourceHeight: 180,
    frames: [
      { timeSeconds: 0, skinMask: "skin_000001.png" },
      { timeSeconds: 1, skinMask: "skin_000002.png" },
    ],
  };
  const manifestFile = path.join(maskDirectory, "manifest.json");
  const output = path.join(maskDirectory, "skin.mkv");
  writeJson(manifestFile, manifest);
  execute(process.execPath, [
    path.join(scripts, "build_mask_video.mjs"),
    manifestFile,
    "skin",
    output,
  ]);
  if (Math.abs(mediaSummary(output).duration - 2) > 1 / 25 + 0.0005) {
    throw new Error("skin mask duration drifted");
  }
});

await test("nasolabial mask PNG manifest builds an aligned lossless video", () => {
  ensureMediaFixtures();
  const maskDirectory = path.join(temporary, "nasolabial-mask-frames");
  fs.mkdirSync(maskDirectory);
  const first = path.join(maskDirectory, "nasolabial_000001.png");
  const second = path.join(maskDirectory, "nasolabial_000002.png");
  for (const [file, color] of [[first, "white"], [second, "black"]]) {
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${color}:s=80x45:d=0.04:r=25`,
      "-frames:v", "1", file,
    ]);
  }
  const manifest = {
    schemaVersion: "2.0",
    input: baseVideo,
    sourceFPS: 25,
    sourceDuration: 2,
    sourceWidth: 320,
    sourceHeight: 180,
    frames: [
      { timeSeconds: 0, nasolabialMask: "nasolabial_000001.png" },
      { timeSeconds: 1, nasolabialMask: "nasolabial_000002.png" },
    ],
  };
  const manifestFile = path.join(maskDirectory, "manifest.json");
  const output = path.join(maskDirectory, "nasolabial.mkv");
  writeJson(manifestFile, manifest);
  execute(process.execPath, [
    path.join(scripts, "build_mask_video.mjs"),
    manifestFile,
    "nasolabial",
    output,
  ]);
  if (Math.abs(mediaSummary(output).duration - 2) > 1 / 25 + 0.0005) {
    throw new Error("nasolabial mask duration drifted");
  }
});

await test("incremental v3 templates validate without loading project media", () => {
  execute(process.execPath, [
    path.join(scripts, "validate_project_context.mjs"),
    path.join(examples, "project-context.json"),
    "--template",
  ]);
  execute(process.execPath, [
    path.join(scripts, "validate_artifact_index.mjs"),
    path.join(examples, "artifact-index.json"),
    "--template",
  ]);
  execute(process.execPath, [
    path.join(scripts, "validate_version_delta.mjs"),
    path.join(examples, "version-delta.json"),
    "--template",
  ]);
  execute(process.execPath, [
    path.join(scripts, "validate_incremental_project.mjs"),
    path.join(examples, "incremental-project.json"),
    "--template",
  ]);
});

await test("incremental BGM manifest requires component and final mix proof", () => {
  const fixture = initializeIncrementalFixture("bgm-mix-contract");
  const delta = path.join(fixture.root, "v2-delta.json");
  execute(process.execPath, [
    path.join(scripts, "create_version_delta.mjs"),
    fixture.context,
    "--write", delta,
    "--new-version", "v2",
    "--type", "bgm_adjust",
    "--output-video", path.join(fixture.root, "v2.mov"),
  ]);
  const dialogue = path.join(fixture.root, "dialogue.wav");
  const bgm = path.join(fixture.root, "bgm.wav");
  const sfx = path.join(fixture.root, "sfx.wav");
  const mix = path.join(fixture.root, "mix.wav");
  for (const file of [dialogue, bgm, sfx, mix]) fs.writeFileSync(file, "fixture\n");
  const incomplete = path.join(fixture.root, "incomplete-project.json");
  expectFailure(process.execPath, [
    path.join(scripts, "create_incremental_manifest.mjs"),
    fixture.context, delta, fixture.index,
    "--output", incomplete,
    "--dialogue-stem", dialogue,
    "--bgm-stem", bgm,
  ]);
  const complete = path.join(fixture.root, "complete-project.json");
  execute(process.execPath, [
    path.join(scripts, "create_incremental_manifest.mjs"),
    fixture.context, delta, fixture.index,
    "--output", complete,
    "--dialogue-stem", dialogue,
    "--bgm-stem", bgm,
    "--sfx-stem", sfx,
    "--mix-stem", mix,
  ]);
  const project = readJson(complete);
  if (
    project.expectedMedia?.audioMix?.bgmRequired !== true
    || !project.outputs?.audioStems?.dialogue
    || !project.outputs?.audioStems?.bgm
    || !project.outputs?.audioStems?.sfx
    || !project.outputs?.audioStems?.mix
  ) {
    throw new Error("incremental BGM manifest did not retain full mix evidence");
  }
});

await test("incremental visual-only QC proves inherited audio and candidate gate", () => {
  const fixture = initializeIncrementalFixture("visual-only");
  const output = path.join(fixture.root, "v2.mov");
  const project = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "beauty_adjust",
    outputVideo: output,
  });
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "gate-plan", project.project]);
  const plan = readJson(project.plan);
  if (
    plan.impact.level !== "L1"
    || plan.renderPlan.strategy !== "layer_rebuild"
    || !plan.qcProfile.inheritedChecks.includes("audio_elementary_stream_sha256")
  ) {
    throw new Error(`unexpected visual-only plan: ${JSON.stringify(plan)}`);
  }
  renderVisualOnlyCandidate(fixture.baseline, output);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "qc", project.project]);
  const qc = readJson(project.qc);
  if (
    !["pass", "pass_with_review"].includes(qc.status)
    || qc.inheritedEvidence.find((item) => item.layer === "audio")?.inherited !== true
  ) {
    throw new Error("visual-only QC did not prove inherited audio");
  }
  execute(process.execPath, [
    path.join(scripts, "create_incremental_review.mjs"),
    project.project,
  ]);
  approveIncrementalReview(project.review, "approved_candidate");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-candidate",
    project.project,
  ]);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-release",
    project.project,
  ]);
  const changedIndex = readJson(project.index);
  changedIndex.generatedAt = new Date(Date.now() + 1000).toISOString();
  writeJson(project.index, changedIndex);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-candidate",
    project.project,
  ]);
});

await test("incremental release candidate requires full manual evidence and full hashes", () => {
  const fixture = initializeIncrementalFixture("release-candidate");
  const output = path.join(fixture.root, "v2.mov");
  const project = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "color_adjust",
    intent: "release_candidate",
    outputVideo: output,
  });
  renderVisualOnlyCandidate(fixture.baseline, output);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "qc", project.project]);
  execute(process.execPath, [
    path.join(scripts, "create_incremental_review.mjs"),
    project.project,
  ]);
  const review = readJson(project.review);
  if (Object.keys(review.manualChecks).length !== 11) {
    throw new Error("release candidate did not require the full manual review set");
  }
  approveIncrementalReview(project.review, "approved_local_release");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-release",
    project.project,
  ]);
});

await test("incremental audio-only QC proves inherited video without lowering geometry", () => {
  const fixture = initializeIncrementalFixture("audio-only");
  const output = path.join(fixture.root, "v2.mov");
  const project = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "dialogue_adjust",
    outputVideo: output,
  });
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", fixture.baseline,
    "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy",
    "-af", "volume=-1dB",
    "-c:a", "pcm_s24le",
    output,
  ]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "qc", project.project]);
  const plan = readJson(project.plan);
  const qc = readJson(project.qc);
  if (
    plan.renderPlan.strategy !== "stream_copy_video"
    || qc.inheritedEvidence.find((item) => item.layer === "video")?.inherited !== true
    || qc.output.width !== 320
    || qc.output.height !== 180
  ) {
    throw new Error("audio-only delta failed stream-copy video proof");
  }
});

await test("incremental cover-only change skips video render and checks exact ratio", () => {
  const fixture = initializeIncrementalFixture("cover-only", {
    delivery: "video,covers",
    coverRatios: "3:4",
  });
  const cover = path.join(fixture.root, "cover-3x4.png");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=#f3d6a4:s=300x400:d=0.04:r=25",
    "-frames:v", "1",
    cover,
  ]);
  const project = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "cover_only",
    extraDeltaArgs: ["--cover", `3:4=${cover}`],
  });
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "qc", project.project]);
  const plan = readJson(project.plan);
  const qc = readJson(project.qc);
  if (
    plan.renderPlan.strategy !== "no_video_render"
    || qc.output !== null
    || qc.deliverableEvidence[0]?.type !== "cover"
  ) {
    throw new Error("cover-only delta unexpectedly required a video render");
  }
  const current = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "next",
    project.project,
  ]).stdout);
  if (current.nextAction.id !== "create_review_checklist") {
    throw new Error("current cover QC did not advance to review");
  }
  fs.appendFileSync(cover, "modified-after-qc");
  const stale = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "next",
    project.project,
  ]).stdout);
  if (stale.nextAction.id !== "run_delta_qc") {
    throw new Error("next did not invalidate QC after a cover changed");
  }
});

await test("incremental structural change cannot request a stream-copy shortcut", () => {
  const fixture = initializeIncrementalFixture("structural");
  const output = path.join(fixture.root, "v2.mov");
  const project = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "remove_interval",
    strategy: "stream_copy_audio",
    outputVideo: output,
    extraDeltaArgs: [
      "--duration-change",
      "--output-duration",
      "1.5",
    ],
  });
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-plan",
    project.project,
  ]);
});

await test("incremental cache reuse requires exact fingerprint and cannot bypass invalidation", () => {
  const fixture = initializeIncrementalFixture("cache-reuse");
  const cacheFile = path.join(fixture.root, "person-mask-cache.bin");
  fs.writeFileSync(cacheFile, "deterministic reusable person mask cache");
  execute(process.execPath, [
    path.join(scripts, "register_artifact.mjs"),
    fixture.index,
    "--id", "person-mask-v1",
    "--type", "mask_cache",
    "--version", "v1",
    "--path", cacheFile,
    "--regeneration-verified",
    "--regeneration-speed", "fast",
    "--regeneration-seconds", "2",
  ]);
  const fingerprint = readJson(fixture.index).artifacts
    .find((item) => item.id === "person-mask-v1").fingerprint;
  const validOutput = path.join(fixture.root, "v2.mov");
  const valid = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "beauty_adjust",
    outputVideo: validOutput,
    extraDeltaArgs: ["--reuse", `person-mask-v1=${fingerprint}`],
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-plan",
    valid.project,
  ]);
  if (!readJson(valid.plan).artifactPlan.explicitReuse.includes("person-mask-v1")) {
    throw new Error("exact reusable cache was not accepted");
  }

  const mismatch = createIncrementalCase(fixture, {
    versionId: "v3",
    type: "beauty_adjust",
    outputVideo: path.join(fixture.root, "v3.mov"),
    extraDeltaArgs: ["--reuse", `person-mask-v1=${"0".repeat(64)}`],
  });
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-plan",
    mismatch.project,
  ]);
});

await test("incremental cleanup plan keeps slow or human-calibrated artifacts", () => {
  const fixture = initializeIncrementalFixture("cleanup");
  const fastCache = path.join(fixture.root, "fast-cache.bin");
  const slowCache = path.join(fixture.root, "slow-cache.bin");
  fs.writeFileSync(fastCache, "fast cache");
  fs.writeFileSync(slowCache, "slow calibrated cache");
  execute(process.execPath, [
    path.join(scripts, "register_artifact.mjs"),
    fixture.index,
    "--id", "fast-cache",
    "--type", "cache",
    "--version", "v1",
    "--path", fastCache,
    "--regeneration-verified",
    "--regeneration-speed", "fast",
    "--regeneration-seconds", "3",
  ]);
  execute(process.execPath, [
    path.join(scripts, "register_artifact.mjs"),
    fixture.index,
    "--id", "slow-cache",
    "--type", "cache",
    "--version", "v1",
    "--path", slowCache,
    "--human-calibrated",
    "--regeneration-speed", "slow",
    "--regeneration-seconds", "120",
  ]);
  const cleanup = path.join(fixture.root, "cleanup-plan.json");
  execute(process.execPath, [
    path.join(scripts, "generate_cleanup_plan.mjs"),
    fixture.context,
    fixture.index,
    "--output",
    cleanup,
  ]);
  const candidates = readJson(cleanup).candidates.map((item) => item.path);
  if (
    !candidates.includes(path.basename(fastCache))
    || candidates.includes(path.basename(slowCache))
  ) {
    throw new Error(`unexpected cleanup candidates: ${JSON.stringify(candidates)}`);
  }
});

await testIn("sfx", "bundled original SFX pass hash, format and distribution checks", () => {
  const sfxConfig = path.join(temporary, "sfx-config.json");
  writeJson(sfxConfig, {
    schemaVersion: "1.0",
    tools: {
      sfxLibrary: path.join(skillDirectory, "assets", "sfx"),
    },
  });
  const result = execute(process.execPath, [
    path.join(scripts, "validate_sfx_library.mjs"),
    "--config",
    sfxConfig,
    "--require-public-distribution",
  ]);
  const report = JSON.parse(result.stdout);
  if (report.assets.length !== 12) {
    throw new Error(`expected 12 original SFX, got ${report.assets.length}`);
  }
});

await testIn("sfx", "SFX aliases resolve uniquely and private assets fail public distribution", () => {
  const sourceManifestFile = path.join(
    skillDirectory,
    "assets",
    "sfx",
    "manifest.json",
  );
  const sourceManifest = readJson(sourceManifestFile);
  const sourceAsset = sourceManifest.assets[0];
  const fixture = {
    ...sourceManifest,
    assets: [{
      ...sourceAsset,
      aliases: ["Regression Alias"],
      source_file: path.resolve(
        path.dirname(sourceManifestFile),
        sourceAsset.source_file,
      ),
      ready_file: path.resolve(
        path.dirname(sourceManifestFile),
        sourceAsset.ready_file,
      ),
      distribution: "public_distribution_allowed",
    }],
  };
  const manifest = path.join(temporary, "sfx-alias-manifest.json");
  writeJson(manifest, fixture);
  const selected = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "sfx",
    "validate",
    manifest,
    "--title",
    "Regression Alias",
    "--require-public-distribution",
  ]).stdout);
  if (
    selected.assets.length !== 1
    || !selected.assets[0].aliases.includes("Regression Alias")
  ) {
    throw new Error("SFX alias did not resolve to exactly one asset");
  }
  fixture.assets[0].distribution = "project_private_only";
  writeJson(manifest, fixture);
  const blocked = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "sfx",
    "validate",
    manifest,
    "--title",
    "Regression Alias",
    "--require-public-distribution",
  ]);
  if (!blocked.stderr.includes("公开仓库")) {
    throw new Error("private SFX was rejected for the wrong reason");
  }
});

await test("effect templates and resource catalog resolve deterministic execution contracts", () => {
  const validation = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "templates",
    "validate",
  ]).stdout);
  if (
    validation.templates !== 65
    || validation.catalogs.length !== 1
    || validation.catalogs[0].assets !== 23
    || validation.byCategory.opening !== 10
    || validation.byCategory.transition !== 10
    || validation.byCategory.spoken_caption_layout !== 10
  ) {
    throw new Error(`unexpected effect catalog coverage: ${JSON.stringify(validation)}`);
  }
  const resolved = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "templates",
    "resolve",
    "--template",
    "effect-sticker_directional_arrows",
  ]).stdout);
  if (
    resolved.template.category !== "sticker_and_gaze"
    || resolved.resources.some((resource) => resource.status === "unresolved")
    || !/^[a-f0-9]{64}$/.test(resolved.digest)
    || resolved.executionContract.safety.preserveFaceSafeZone !== true
  ) {
    throw new Error("effect template did not resolve to an executable safe contract");
  }
  const workflow = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "templates",
    "resolve",
    "--template",
    "effect-process_spatial_nodes",
  ]).stdout);
  if (
    workflow.executionContract.motionContract?.contract?.id
      !== "workflow-spatial-nodes"
    || workflow.executionContract.motionContract.contract
      .invariants.noLargeOpaqueWebCards !== true
    || workflow.executionContract.motionContract.contract
      .audioContract.cues.length < 3
    || workflow.executionContract.motionContract.contract
      .parameters.nodeCount.maximum !== 7
  ) {
    throw new Error("spatial workflow template lost its adaptive motion contract");
  }
  const lightOverlay = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "templates",
    "resolve",
    "--template",
    "effect-process_light_overlay",
  ]).stdout);
  if (
    lightOverlay.executionContract.motionContract?.contract?.id
      !== "workflow-light-overlay"
    || lightOverlay.executionContract.motionContract.contract
      .invariants.maximumFullyReadableCards !== 3
    || lightOverlay.executionContract.motionContract.contract
      .materialContract.surfaceOpacityRange[1] > 0.8
    || lightOverlay.executionContract.motionContract.contract
      .invariants.noFullFrameDashboardLayout !== true
  ) {
    throw new Error("light overlay workflow lost its lightweight video contract");
  }
});

await test("full design effect library resolves five executable visual styles", () => {
  const fontRouting = readJson(path.join(skillDirectory, "config", "font-routing.json"));
  const visualLanguages = readJson(path.join(skillDirectory, "config", "design-system", "visual-languages.json"));
  for (const styleId of [
    "xingzhe-light-overlay",
    "xingzhe-spatial-lightpath",
    "xingzhe-humor-comic",
    "xingzhe-pixel-editorial",
    "xingzhe-dark-tech",
  ]) {
    if (!fontRouting.scope.includes(styleId)) {
      throw new Error(`font routing does not cover ${styleId}`);
    }
    const applicability = visualLanguages.languages[styleId]?.applicability;
    if (
      applicability?.minimumMatchedSignals !== 1
      || !applicability?.fallback
      || !applicability.runtimeEvidenceRequired?.includes("matchedSignal")
    ) {
      throw new Error(`visual language does not enforce runtime applicability evidence for ${styleId}`);
    }
  }
  const validation = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "contracts",
    "validate",
  ]).stdout);
  if (
    validation.counts.effects !== 240
    || validation.counts.styles !== 5
    || validation.counts.contracts !== 1200
  ) {
    throw new Error(`unexpected design contract coverage: ${JSON.stringify(validation)}`);
  }
  const light = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "contracts",
    "resolve",
    "--id",
    "process_progressive",
    "--style",
    "xingzhe-light-overlay",
  ]).stdout);
  const spatial = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "contracts",
    "resolve",
    "--id",
    "process_progressive",
    "--style",
    "xingzhe-spatial-lightpath",
  ]).stdout);
  const comic = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "contracts",
    "resolve",
    "--id",
    "process_progressive",
    "--style",
    "xingzhe-humor-comic",
  ]).stdout);
  const pixel = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "contracts",
    "resolve",
    "--id",
    "process_progressive",
    "--style",
    "xingzhe-pixel-editorial",
  ]).stdout);
  const dark = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "contracts",
    "resolve",
    "--id",
    "process_progressive",
    "--style",
    "xingzhe-dark-tech",
  ]).stdout);
  const cleanCut = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "contracts",
    "resolve",
    "--id",
    "clean_cut",
    "--style",
    "xingzhe-light-overlay",
  ]).stdout);
  if (
    light.execution.timelineMode !== "seek-safe"
    || light.execution.parameters.defaults.surfaceOpacity > 0.62
    || spatial.execution.parameters.defaults.relationAccent !== "rational-blue"
    || spatial.execution.parameters.defaults.depthOffsetPx <= light.execution.parameters.defaults.depthOffsetPx
    || spatial.execution.qualityGates.length < 5
    || light.semanticMotionCore.trigger !== light.trigger
    || spatial.semanticMotionCore.trigger !== spatial.trigger
    || light.avCoherenceContract.clock !== "shared-timeline-ir"
    || light.avCoherenceContract.dialogueIsPrimaryClock !== true
    || light.avCoherenceContract.visualPeakToleranceFrames > 2
    || spatial.avCoherenceContract.sfx.resolver !== "assets/audio/sfx-library/kacha-profile.json"
    || spatial.avCoherenceContract.conflictPriority[0] !== "dialogue_intelligibility"
    || comic.styleMaterialContract.humorMechanismRequired !== true
    || comic.styleMaterialContract.maximumPanelCount !== 3
    || comic.execution.audio.styleProfile.id !== "humor-comic-dry-editorial"
    || !comic.execution.easing.entry.startsWith("anticipate-then")
    || pixel.styleMaterialContract.textRendering !== "authorized-fonts-antialiased-above-crisp-pixel-graphics"
    || pixel.execution.parameters.defaults.baseGridPxAt1080p !== 8
    || pixel.execution.audio.styleProfile.id !== "pixel-editorial-quantized-ui"
    || pixel.execution.easing.entry !== "steps(3,end)"
    || pixel.execution.parameters.defaults.pixelateFaceAndEvidence !== false
    || dark.styleMaterialContract.maximumDarkIsolationAreaRatio > 0.42
    || dark.styleMaterialContract.subjectLumaRetentionMinimum < 0.82
    || dark.styleMaterialContract.evidenceLumaRetentionMinimum < 0.90
    || dark.execution.audio.styleProfile.id !== "dark-tech-forensic-diagnostic"
    || dark.applicabilityContract.requiredSignals.length < 7
    || !dark.styleMaterialContract.forbid.includes("generic-cyberpunk-hud")
    || !light.execution.renderer.startsWith("chrome-or-rsvg-explicit-font-svg-reference")
    || !light.execution.sync.visibleLanding
    || comic.applicabilityContract.requiredSignals.length < 5
    || pixel.applicabilityContract.requiredSignals.length < 6
    || comic.applicabilityContract.minimumMatchedSignals !== 1
    || pixel.applicabilityContract.minimumMatchedSignals !== 1
    || !comic.applicabilityContract.runtimeEvidenceRequired.includes("matchedSignal")
    || !pixel.applicabilityContract.runtimeEvidenceRequired.includes("fallbackReasonWhenNotApplied")
    || cleanCut.execution.audio.cue !== "none"
    || cleanCut.execution.audio.peakDbfs !== null
  ) {
    throw new Error("full design effect contracts lost style-specific executable behavior");
  }
});

await test("FaceFusion plans enforce consent, loopback and a mock end-to-end candidate QC", async () => {
  ensureMediaFixtures();
  const unsafeConfig = path.join(temporary, "facefusion-unsafe-config.json");
  writeJson(unsafeConfig, {
    schemaVersion: "1.0",
    tools: {
      faceFusionEndpoint: "https://example.com",
    },
  });
  const unsafe = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "config",
    "validate",
    "--config",
    unsafeConfig,
  ]);
  if (!unsafe.stderr.includes("loopback")) {
    throw new Error("non-loopback FaceFusion endpoint was rejected for the wrong reason");
  }

  const planFile = path.join(temporary, "facefusion-plan.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "facefusion",
    "template",
    "--operation",
    "post_process",
    "--output",
    planFile,
  ]);
  const plan = readJson(planFile);
  const firstOutput = path.join(temporary, "facefusion-output.mp4");
  plan.inputs.target = baseVideo;
  plan.output.path = firstOutput;
  plan.authorization.evidence = "synthetic regression authorization";
  writeJson(planFile, plan);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "facefusion",
    "validate",
    "--plan",
    planFile,
  ]);
  const unauthorized = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "facefusion",
    "validate",
    "--plan",
    planFile,
    "--for-execution",
  ]);
  if (!unauthorized.stderr.includes("authorization.canExecute")) {
    throw new Error("FaceFusion execution authorization failed for the wrong reason");
  }

  plan.authorization.canExecute = true;
  plan.authorization.postProcessingAuthorized = true;
  plan.authorization.modelLicenseReviewed = true;
  writeJson(planFile, plan);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "facefusion",
    "validate",
    "--plan",
    planFile,
    "--for-execution",
  ]);

  const token = ["facefusion", "regression", "fixture"].join("-");
  const tokenFile = path.join(temporary, "facefusion-token");
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const mock = await startMockFaceFusionServer(baseVideo, token);
  try {
    const config = path.join(temporary, "facefusion-config.json");
    writeJson(config, {
      schemaVersion: "1.0",
      tools: {
        faceFusionEndpoint: mock.endpoint,
        faceFusionTokenFile: tokenFile,
      },
    });
    const beforeHash = sha256File(baseVideo);
    const result = execute(process.execPath, [
      path.join(scripts, "kacha.mjs"),
      "facefusion",
      "run",
      "--plan",
      planFile,
      "--project-root",
      path.join(temporary, "facefusion-project"),
      "--timeout",
      "30",
      "--config",
      config,
    ]);
    if (result.stdout.includes(token) || result.stderr.includes(token)) {
      throw new Error("FaceFusion adapter leaked its bearer token");
    }
    const report = JSON.parse(result.stdout);
    if (
      report.status !== "candidate_requires_manual_qc"
      || report.releaseApproved !== false
      || report.automaticQc.outputDecodes !== true
      || sha256File(firstOutput) !== beforeHash
      || sha256File(baseVideo) !== beforeHash
      || !fs.existsSync(`${firstOutput}.facefusion.json`)
    ) {
      throw new Error("FaceFusion candidate output or QC contract is incomplete");
    }

    const cachedPlan = {
      ...plan,
      output: {
        ...plan.output,
        path: path.join(temporary, "facefusion-output-cached.mp4"),
      },
    };
    const cachedPlanFile = path.join(temporary, "facefusion-plan-cached.json");
    writeJson(cachedPlanFile, cachedPlan);
    const cached = JSON.parse(execute(process.execPath, [
      path.join(scripts, "kacha.mjs"),
      "facefusion",
      "run",
      "--plan",
      cachedPlanFile,
      "--project-root",
      path.join(temporary, "facefusion-project"),
      "--timeout",
      "30",
      "--config",
      config,
    ]).stdout);
    if (cached.cache !== "hit" || !fs.existsSync(cached.output)) {
      throw new Error("FaceFusion content-addressed cache was not reused");
    }
  } finally {
    mock.child.kill("SIGTERM");
  }
});

await test("local change template passes and rejects an unsafe overwrite", () => {
  execute(process.execPath, [
    path.join(scripts, "validate_local_change_plan.mjs"),
    path.join(examples, "local-change-plan.json"),
    "--template",
  ]);
  const plan = readJson(path.join(examples, "local-change-plan.json"));
  plan.newVersion.overwriteBase = true;
  const file = path.join(temporary, "local-change-unsafe.json");
  writeJson(file, plan);
  expectFailure(process.execPath, [
    path.join(scripts, "validate_local_change_plan.mjs"),
    file,
    "--template",
  ]);
});

await test("MOV timing normalizer stream-copies and checks both FPS values", () => {
  ensureMediaFixtures();
  const output = path.join(temporary, "timing-normalized.mov");
  execute(process.execPath, [
    path.join(scripts, "normalize_mov_timing.mjs"),
    baseVideo,
    output,
    "--fps",
    "25",
  ]);
  const summary = mediaSummary(output);
  if (Math.abs(summary.declaredFps - 25) > 0.001
    || Math.abs(summary.averageFps - 25) > 0.001) {
    throw new Error("declared or average FPS is not 25");
  }
  if (summary.video.codec_name !== mediaSummary(baseVideo).video.codec_name) {
    throw new Error("video codec changed during timing normalization");
  }
});

await test("natural dialogue reference standard protects dynamics and equal-loudness review", () => {
  const audioReference = fs.readFileSync(
    path.join(skillDirectory, "references", "audio.md"),
    "utf8",
  );
  const requiredRules = [
    "自然口播参考基准（中文版标准）",
    "±0.2 LU",
    "dialogue LRA",
    "centered_dialogue",
    "整段动态 `loudnorm`",
    "视频 elementary-stream SHA-256",
  ];
  for (const rule of requiredRules) {
    if (!audioReference.includes(rule)) {
      throw new Error(`natural dialogue reference contract missing: ${rule}`);
    }
  }
});

await test("warm-soft long-listening voice profile is the executable default", () => {
  const defaults = readJson(path.join(skillDirectory, "config", "defaults.json"));
  const voice = defaults.execution.voiceEnhancement;
  const audio = defaults.editingDefaults.parameters.audio;
  if (
    voice.preset !== "warm-soft"
    || voice.targetLufs !== -21
    || voice.truePeakDbtp !== -4
    || audio.profile !== "warm-soft-long-listening"
    || audio.bgm?.targetBelowDialogueDb !== 18
    || audio.bgm?.stereoWidth !== 0.5
    || audio.sfx?.defaultBelowDialogueDb !== 12
    || audio.sfx?.highShelfFrequencyHz !== 4500
    || audio.sfx?.highShelfGainDb !== -1.5
  ) {
    throw new Error("warm-soft default parameters drifted");
  }
  const enhancer = fs.readFileSync(
    path.join(scripts, "enhance_voice.sh"),
    "utf8",
  );
  for (const fragment of [
    "warm-soft)",
    "lowshelf=f=160:g=1.4",
    "equalizer=f=2500:t=q:w=1.05:g=-2.0",
    "deesser=i=0.14:m=0.35",
    "ratio=1.5:attack=8:release=160",
    "volume=${gain_db}dB",
    "level=false",
  ]) {
    if (!enhancer.includes(fragment)) {
      throw new Error(`warm-soft executable chain missing: ${fragment}`);
    }
  }
  if (enhancer.includes("measured_I=${measured_i}")) {
    throw new Error("voice enhancer still applies final dynamic loudnorm");
  }
});

await test("default warm-soft enhancer reaches its long-listening loudness target", () => {
  const input = path.join(temporary, "warm-soft-input.wav");
  const output = path.join(temporary, "warm-soft-output.wav");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=5:sample_rate=48000",
    "-c:a", "pcm_s24le", input,
  ]);
  execute(path.join(scripts, "enhance_voice.sh"), [input, output]);
  const measured = execute("ffmpeg", [
    "-hide_banner", "-nostats",
    "-i", output,
    "-af", "loudnorm=I=-21:TP=-4:LRA=5:print_format=json",
    "-f", "null", "-",
  ]);
  const jsonText = measured.stderr.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw new Error("could not parse warm-soft loudness report");
  const loudness = JSON.parse(jsonText);
  const integrated = Number(loudness.input_i);
  const truePeak = Number(loudness.input_tp);
  if (Math.abs(integrated - (-21)) > 0.2) {
    throw new Error(`warm-soft loudness drifted: ${integrated} LUFS`);
  }
  if (truePeak > -4) {
    throw new Error(`warm-soft true peak exceeded ceiling: ${truePeak} dBTP`);
  }
});

await test("voice enhancer preserves distinct stereo channels by default", () => {
  const input = path.join(temporary, "stereo.wav");
  const output = path.join(temporary, "stereo-enhanced.wav");
  const voiceConfig = path.join(temporary, "voice-config.json");
  writeJson(voiceConfig, {
    schemaVersion: "1.0",
    execution: {
      voiceEnhancement: {
        preset: "clear",
        denoise: "off",
        channelMode: "preserve",
      },
    },
  });
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=2:sample_rate=48000",
    "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]",
    "-map", "[a]", "-c:a", "pcm_s24le", input,
  ]);
  execute(path.join(scripts, "enhance_voice.sh"), [
    input,
    output,
    "--config",
    voiceConfig,
  ]);
  const summary = mediaSummary(output);
  if (summary.channels !== 2) throw new Error("stereo channel count was not preserved");
  const hashes = [0, 1].map((channel) => {
    const result = execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", output,
      "-af", `pan=mono|c0=c${channel}`,
      "-f", "md5", "-",
    ]);
    return result.stdout.trim();
  });
  if (hashes[0] === hashes[1]) {
    throw new Error("left and right channels became identical");
  }
});

await test("technical QC decodes media and writes a report", () => {
  ensureMediaFixtures();
  const dialogueStem = path.join(temporary, "qc-dialogue-stem.wav");
  const bgmStem = path.join(temporary, "qc-bgm-stem.wav");
  const mixStem = path.join(temporary, "qc-mix-stem.wav");
  const finalWithMix = path.join(temporary, "qc-final-with-mix.mov");
  const adaptiveBgmPlan = path.join(temporary, "qc-adaptive-bgm-plan.json");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=2:sample_rate=48000",
    "-c:a", "pcm_s24le",
    dialogueStem,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
    "-af", "volume=-14dB",
    "-c:a", "pcm_s24le",
    bgmStem,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", dialogueStem,
    "-i", bgmStem,
    "-filter_complex",
    "[0:a]aformat=sample_rates=48000:channel_layouts=stereo[d];"
      + "[1:a]aformat=sample_rates=48000:channel_layouts=stereo[b];"
      + "[d][b]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0,"
      + "atrim=0:2,alimiter=limit=0.630957:level=false[m]",
    "-map", "[m]", "-c:a", "pcm_s24le", mixStem,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", baseVideo,
    "-i", mixStem,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
    "-t", "2", finalWithMix,
  ]);
  writeJson(adaptiveBgmPlan, {
    schemaVersion: "1.0",
    kind: "kacha-adaptive-bgm-plan",
    showId: "tool-share",
    durationSeconds: 2,
    scenes: [
      { id: "silence-in", start: 0, end: 0.2, mode: "silence" },
      { id: "music", start: 0.2, end: 1.8, mode: "music" },
      { id: "silence-out", start: 1.8, end: 2, mode: "silence" },
    ],
  });
  const project = {
    schemaVersion: "2.0",
    projectId: "synthetic-qc",
    plans: { adaptiveBgm: adaptiveBgmPlan },
    requiredCoverAspectRatios: [],
    expectedMedia: {
      width: 320,
      height: 180,
      aspectRatio: "16:9",
      fps: 25,
      fpsTolerance: 0.001,
      audioSampleRate: 48000,
      expectedChannels: 2,
      maxAvDriftFrames: 1,
      integratedLufsMin: -40,
      integratedLufsMax: 0,
      truePeakMax: 0,
      audioMix: {
        bgmRequired: true,
        adaptiveBgmRequired: true,
        masterTruePeakDb: -4,
        bgmBelowDialogueDbMin: 12,
        bgmBelowDialogueDbMax: 18,
        bgmMinimumCoverageRatio: 0.85,
      },
    },
    outputs: {
      finalVideo: { path: finalWithMix },
      audioStems: {
        dialogue: { path: dialogueStem },
        bgm: { path: bgmStem },
        mix: { path: mixStem },
      },
      technicalQcReport: { path: path.join(temporary, "technical-qc.json") },
    },
  };
  const projectFile = path.join(temporary, "qc-project.json");
  const qcConfigFile = path.join(temporary, "qc-config.json");
  writeJson(projectFile, project);
  writeJson(qcConfigFile, {
    schemaVersion: "1.0",
    execution: {
      qualityControl: {
        blackDurationSeconds: 0.12,
        silenceDurationSeconds: 0.7,
        measurementTargetLufs: -21,
      },
    },
  });
  execute(process.execPath, [
    path.join(scripts, "qc_media.mjs"),
    projectFile,
    "--config",
    qcConfigFile,
  ]);
  const report = readJson(project.outputs.technicalQcReport.path);
  if (!["pass", "pass_with_review"].includes(report.status)) {
    throw new Error(`unexpected technical QC status ${report.status}`);
  }
  if (
    report.configuration?.detectorParameters?.blackDurationSeconds !== 0.12
    || report.configuration?.detectorParameters?.silenceDurationSeconds !== 0.7
    || !["videotoolbox", "software"].includes(report.execution?.detectorDecoder)
    || report.audioStemQc?.status !== "pass"
    || report.audioStemQc?.measurements?.mixReconstruction?.exactMatch !== true
    || report.audioStemQc?.checks?.find((item) => item.id === "adaptive_bgm_overlap_measurement")?.status !== "pass"
    || report.audioStemQc?.measurements?.adaptiveBgmOverlap?.intervals?.length !== 1
    || report.audioStemQc?.bgmBelowDialogueDb < 12
    || report.audioStemQc?.bgmBelowDialogueDb > 18
  ) {
    throw new Error("technical QC did not enforce configured detectors and BGM audibility");
  }
});

await test("technical QC rejects valid stems when the final video omits their mix", () => {
  ensureMediaFixtures();
  const dialogue = path.join(temporary, "qc-omitted-dialogue.wav");
  const bgm = path.join(temporary, "qc-omitted-bgm.wav");
  const mix = path.join(temporary, "qc-omitted-mix.wav");
  for (const [frequency, level, output] of [
    [220, "0dB", dialogue],
    [440, "-14dB", bgm],
  ]) {
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=2:sample_rate=48000`,
      "-af", `volume=${level},aformat=channel_layouts=stereo`,
      "-c:a", "pcm_s24le", output,
    ]);
  }
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", dialogue, "-i", bgm,
    "-filter_complex",
    "[0:a][1:a]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0,"
      + "atrim=0:2,alimiter=limit=0.630957:level=false[m]",
    "-map", "[m]", "-c:a", "pcm_s24le", mix,
  ]);
  const report = path.join(temporary, "technical-qc-omitted-mix.json");
  const projectFile = path.join(temporary, "qc-project-omitted-mix.json");
  const baseSummary = mediaSummary(baseVideo);
  writeJson(projectFile, {
    schemaVersion: "2.0",
    projectId: "synthetic-qc-omitted-final-mix",
    plans: {},
    requiredCoverAspectRatios: [],
    expectedMedia: {
      width: baseSummary.width,
      height: baseSummary.height,
      aspectRatio: `${baseSummary.width}:${baseSummary.height}`,
      fps: baseSummary.averageFps,
      fpsTolerance: 0.001,
      audioSampleRate: 48000,
      expectedChannels: baseSummary.channels,
      maxAvDriftFrames: 1,
      integratedLufsMin: -40,
      integratedLufsMax: 0,
      truePeakMax: 0,
      audioMix: {
        bgmRequired: true,
        masterTruePeakDb: -4,
        bgmBelowDialogueDbMin: 12,
        bgmBelowDialogueDbMax: 18,
        bgmMinimumCoverageRatio: 0.85,
      },
    },
    outputs: {
      finalVideo: { path: baseVideo },
      audioStems: {
        dialogue: { path: dialogue },
        bgm: { path: bgm },
        mix: { path: mix },
      },
      technicalQcReport: { path: report },
    },
  });
  expectFailure(process.execPath, [path.join(scripts, "qc_media.mjs"), projectFile]);
  const qc = readJson(report);
  if (
    qc.automaticChecks.find(
      (item) => item.id === "mix_stem_reconstruction",
    )?.status !== "pass"
    || qc.automaticChecks.find(
      (item) => item.id === "final_audio_matches_mix_stem",
    )?.status !== "fail"
  ) {
    throw new Error("QC did not distinguish valid stems from an omitted final mix");
  }
});

await test("technical QC rejects a declared BGM stem that is effectively inaudible", () => {
  ensureMediaFixtures();
  const dialogueStem = path.join(temporary, "qc-dialogue-audible.wav");
  const bgmStem = path.join(temporary, "qc-bgm-inaudible.wav");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=2:sample_rate=48000",
    "-c:a", "pcm_s24le",
    dialogueStem,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
    "-af", "volume=-30dB",
    "-c:a", "pcm_s24le",
    bgmStem,
  ]);
  const report = path.join(temporary, "technical-qc-inaudible-bgm.json");
  const projectFile = path.join(temporary, "qc-project-inaudible-bgm.json");
  writeJson(projectFile, {
    schemaVersion: "2.0",
    projectId: "synthetic-qc-inaudible-bgm",
    plans: {},
    requiredCoverAspectRatios: [],
    expectedMedia: {
      width: 320,
      height: 180,
      aspectRatio: "16:9",
      fps: 25,
      fpsTolerance: 0.001,
      audioSampleRate: 48000,
      expectedChannels: 2,
      maxAvDriftFrames: 1,
      integratedLufsMin: -40,
      integratedLufsMax: 0,
      truePeakMax: 0,
      audioMix: {
        bgmRequired: true,
        bgmBelowDialogueDbMin: 12,
        bgmBelowDialogueDbMax: 18,
        bgmMinimumCoverageRatio: 0.85,
      },
    },
    outputs: {
      finalVideo: { path: baseVideo },
      audioStems: {
        dialogue: { path: dialogueStem },
        bgm: { path: bgmStem },
      },
      technicalQcReport: { path: report },
    },
  });
  expectFailure(process.execPath, [
    path.join(scripts, "qc_media.mjs"),
    projectFile,
  ]);
  if (
    readJson(report).automaticChecks
      .find((item) => item.id === "bgm_perceptibility")?.status !== "fail"
  ) {
    throw new Error("inaudible BGM did not fail the perceptibility gate");
  }
});

await test("release gate verifies hashes, cover ratios and manual evidence", () => {
  ensureMediaFixtures();
  const outputDirectory = path.join(temporary, "release-output");
  fs.mkdirSync(outputDirectory);
  const cover34 = path.join(outputDirectory, "cover-3x4.png");
  const cover43 = path.join(outputDirectory, "cover-4x3.png");
  const subtitle = path.join(outputDirectory, "subtitles.srt");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=white:s=300x400:d=0.04:r=25",
    "-frames:v", "1", cover34,
  ]);
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=white:s=400x300:d=0.04:r=25",
    "-frames:v", "1", cover43,
  ]);
  fs.writeFileSync(
    subtitle,
    "1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n",
  );
  const technicalQc = path.join(outputDirectory, "technical-qc.json");
  const releaseReport = path.join(outputDirectory, "release-report.json");
  const releaseStageEvidence = path.join(outputDirectory, "release-stage-evidence.json");
  writeJson(releaseStageEvidence, {
    status: "pass",
    completedThrough: "final_qc",
  });
  const releaseProposalValue = readJson(ensureValidProposalFixture());
  releaseProposalValue.executionFlow = releaseProposalValue.executionFlow.map(
    (stage, index) => (
      index <= 11
        ? {
            ...stage,
            status: "passed",
            evidence: {
              path: releaseStageEvidence,
              sha256: sha256File(releaseStageEvidence),
            },
          }
        : stage
    ),
  );
  const releaseProposal = path.join(outputDirectory, "edit-proposal.json");
  writeJson(releaseProposal, releaseProposalValue);
  const project = {
    schemaVersion: "2.0",
    projectId: "synthetic-release",
    plans: {
      proposal: releaseProposal,
      editPlan: path.join(examples, "edit-plan.json"),
      visualCapabilityPlan: {
        path: ensureVisualCapabilityPlanFixture(),
        mode: "template",
      },
      generatedShotPlans: [],
    },
    requiredCoverAspectRatios: ["3:4", "4:3"],
    expectedMedia: {
      width: 320,
      height: 180,
      aspectRatio: "16:9",
      fps: 25,
      fpsTolerance: 0.001,
      audioSampleRate: 48000,
      expectedChannels: 1,
      maxAvDriftFrames: 1,
      integratedLufsMin: -40,
      integratedLufsMax: 0,
      truePeakMax: 0,
    },
    outputs: {
      finalVideo: { path: baseVideo, sha256: sha256File(baseVideo) },
      covers: [
        { aspectRatio: "3:4", path: cover34, sha256: sha256File(cover34) },
        { aspectRatio: "4:3", path: cover43, sha256: sha256File(cover43) },
      ],
      subtitles: [
        { language: "zh-CN", path: subtitle, sha256: sha256File(subtitle) },
      ],
      technicalQcReport: { path: technicalQc },
      releaseReport: { path: releaseReport },
    },
  };
  const projectFile = path.join(temporary, "release-project.json");
  writeJson(projectFile, project);
  execute(process.execPath, [path.join(scripts, "qc_media.mjs"), projectFile]);
  const beforeReview = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "next",
    projectFile,
  ]);
  if (JSON.parse(beforeReview.stdout).nextAction.id !== "complete_release_review") {
    throw new Error("v2 next did not reuse the current QC identity");
  }
  const checkIds = [
    "contentIntegrity",
    "connectionPlayback",
    "subtitleAccuracy",
    "subtitleLayout",
    "visualContinuity",
    "assetSemanticsAndLicenses",
    "maskTrackingBeautyAndPip",
    "audioStemAndDeviceListening",
    "coverAndBrand",
    "openingEndingAndFullPlayback",
    "technicalFindingsDisposition",
  ];
  writeJson(releaseReport, {
    schemaVersion: "2.0",
    projectId: project.projectId,
    status: "approved_local_release",
    reviewedAt: new Date().toISOString(),
    reviewer: "automated synthetic regression",
    finalVideoSha256: sha256File(baseVideo),
    limitations: ["synthetic fixture only"],
    manualChecks: Object.fromEntries(
      checkIds.map((id) => [id, { status: "pass", evidence: ["synthetic test evidence"] }]),
    ),
  });
  const afterReview = execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "next",
    projectFile,
  ]);
  const recordRelease = JSON.parse(afterReview.stdout).nextAction;
  if (recordRelease.id !== "record_release_package") {
    throw new Error("v2 next did not require evidence-backed release stage recording");
  }
  execute(recordRelease.command ? "/bin/sh" : process.execPath, recordRelease.command
    ? ["-c", recordRelease.command]
    : []);
  const finalNext = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "next",
    projectFile,
  ]).stdout);
  if (finalNext.nextAction.id !== "gate_release") {
    throw new Error("v2 next did not advance to release gate after stage evidence");
  }
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-release",
    projectFile,
  ]);
});

await test("Agent chat control plane keeps deltas, search, jobs, refs and install status deterministic", () => {
  execute(process.execPath, [
    path.join(testDirectory, "agent_control_plane_tests.mjs"),
  ]);
}, "incremental");

await test("xingzhe capability budget rejects perceptually weak or under-covered plans", () => {
  const planFile = path.join(temporary, "capability-budget.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-capabilities",
    "template",
    "--duration",
    "399.28",
    "--output",
    planFile,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-capabilities",
    "validate",
    "--plan",
    planFile,
  ]);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-capabilities",
    "validate",
    "--plan",
    planFile,
    "--for-execution",
  ]);
  const weak = readJson(planFile);
  weak.events = weak.events.filter((event) => event.family !== "pip").slice(1);
  weak.digest = sha256Value({ ...weak, digest: undefined });
  const weakFile = path.join(temporary, "capability-budget-weak.json");
  writeJson(weakFile, weak);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-capabilities",
    "validate",
    "--plan",
    weakFile,
  ]);
}, "visual");

await test("every video requires exactly one registered or contracted opening, including shorts", () => {
  const planFile = path.join(temporary, "capability-opening-short.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-capabilities",
    "template",
    "--duration",
    "20",
    "--opening",
    "hook_title_behind_subject",
    "--output",
    planFile,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-capabilities",
    "validate",
    "--plan",
    planFile,
  ]);
  const valid = readJson(planFile);
  const openings = valid.events.filter((event) => event.family === "opening");
  if (
    valid.policy.active !== false
    || valid.policy.families.opening.minimum !== 1
    || openings.length !== 1
    || openings[0].implementation.effectId !== "hook_title_behind_subject"
    || openings[0].implementation.promiseBySeconds > 3
  ) {
    throw new Error("short-video template did not freeze the mandatory opening contract");
  }

  const missing = structuredClone(valid);
  missing.events = missing.events.filter((event) => event.family !== "opening");
  missing.digest = sha256Value({ ...missing, digest: undefined });
  const missingFile = path.join(temporary, "capability-opening-missing.json");
  writeJson(missingFile, missing);
  const missingResult = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-capabilities",
    "validate",
    "--plan",
    missingFile,
  ]);
  if (!missingResult.stderr.includes("每条视频必须且只能选择一个主开场")) {
    throw new Error("short-video gate did not explain the missing opening");
  }

  const late = structuredClone(valid);
  const opening = late.events.find((event) => event.family === "opening");
  opening.startSeconds = 1;
  opening.endSeconds = 2;
  opening.implementation.promiseBySeconds = 2;
  late.digest = sha256Value({ ...late, digest: undefined });
  const lateFile = path.join(temporary, "capability-opening-late.json");
  writeJson(lateFile, late);
  const lateResult = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "visual-capabilities",
    "validate",
    "--plan",
    lateFile,
  ]);
  if (!lateResult.stderr.includes("开场必须在 0.5 秒内开始建立可见变化")) {
    throw new Error("opening timing gate did not reject a late visual start");
  }
}, "visual");

await test("xingzhe show profiles keep book-talk and casual-chat calmer than tool-share", () => {
  const toolPlan = path.join(temporary, "capability-tool-share.json");
  const bookPlan = path.join(temporary, "capability-book-talk.json");
  const casualPlan = path.join(temporary, "capability-casual-chat.json");
  for (const [showId, output] of [
    ["tool-share", toolPlan],
    ["book-talk", bookPlan],
    ["casual-chat", casualPlan],
  ]) {
    execute(process.execPath, [
      path.join(scripts, "kacha.mjs"),
      "visual-capabilities",
      "template",
      "--duration",
      "399.28",
      "--show",
      showId,
      "--output",
      output,
    ]);
    execute(process.execPath, [
      path.join(scripts, "kacha.mjs"),
      "visual-capabilities",
      "validate",
      "--plan",
      output,
    ]);
  }
  const tool = readJson(toolPlan);
  const book = readJson(bookPlan);
  const casual = readJson(casualPlan);
  if (
    tool.showId !== "tool-share"
    || book.showId !== "book-talk"
    || casual.showId !== "casual-chat"
  ) {
    throw new Error("visual capability plans did not freeze showId");
  }
  if (book.events.length >= tool.events.length || casual.events.length >= tool.events.length) {
    throw new Error("book-talk and casual-chat should have calmer minimum effect budgets");
  }
  if (
    tool.policy.capabilityProfile !== "tool-evidence-balanced"
    || book.policy.capabilityProfile !== "book-calm-evidence"
    || casual.policy.capabilityProfile !== "casual-conversational-breathing"
  ) {
    throw new Error("show-specific capability profiles were not resolved");
  }
}, "visual");

await test("design reference gallery covers every registered design item", () => {
  const gallery = path.join(temporary, "design-reference-gallery");
  const result = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "design",
    "gallery",
    "--output",
    gallery,
    "--overwrite",
  ]).stdout);
  const manifest = readJson(path.join(gallery, "manifest.json"));
  const expected = {
    component: 52,
    scene: 69,
    renderer: 8,
    layout: 36,
    motion: 75,
    total: 240,
  };
  if (JSON.stringify(manifest.counts) !== JSON.stringify(expected)) {
    throw new Error(`unexpected gallery counts: ${JSON.stringify(manifest.counts)}`);
  }
  if (result.digest !== manifest.digest || !fs.existsSync(path.join(gallery, "index.html"))) {
    throw new Error("gallery index or digest is missing");
  }
  for (const entry of manifest.entries) {
    const file = path.join(gallery, entry.path);
    if (!fs.existsSync(file) || sha256File(file) !== entry.sha256) {
      throw new Error(`gallery reference is missing or stale: ${entry.kind}.${entry.id}`);
    }
    const svg = fs.readFileSync(file, "utf8");
    if (/\bundefined\b/.test(svg)) {
      throw new Error(`gallery reference contains an undefined visual token: ${entry.kind}.${entry.id}`);
    }
    if (/[ \t]+$/m.test(svg)) {
      throw new Error(`gallery reference contains trailing whitespace: ${entry.kind}.${entry.id}`);
    }
  }
  const style = readJson(path.join(skillDirectory, "config", "styles", "xingzhe.json"));
  if (
    style.cover.subjectHeightRatio >= 0.5
    || style.emphasis.conflict !== "accentSignal"
    || !style.gradients.signalWarm
    || style.cover.characterVisualLanguageId !== "cinematic-3d-adult-dahui"
    || style.cover.preserveSemanticEditorialCollage !== true
    || style.cover.specificCharacterImitation !== "forbidden"
  ) {
    throw new Error("Xingzhe 3.0 cover composition, character language or IP boundary regressed");
  }
}, "visual");

await test("committed five-style library QC has zero unresolved composition collisions", () => {
  const report = readJson(path.join(
    skillDirectory,
    "docs",
    "generated",
    "five-style-library-qc.json",
  ));
  if (
    report.status !== "pass"
    || report.distinctEditingGrammarCount !== 5
    || report.crossStyleExactDuplicateGroupCount !== 0
    || report.libraries?.length !== 5
    || report.registryConsistency?.actualContracts !== 1200
    || report.registryConsistency?.uniqueContractIds !== 1200
    || report.registryConsistency?.failures?.length !== 0
    || report.legacyArtifactScan?.findingCount !== 0
    || report.referenceGalleryOrphanScan?.findingCount !== 0
  ) {
    throw new Error("five-style library QC summary is missing or did not pass");
  }
  for (const library of report.libraries) {
    for (const key of [
      "nearDuplicatePairCount",
      "headCollisionAssetCount",
      "spatialBlackAssetCount",
      "exactDuplicateAssets",
      "orphanAssetCount",
    ]) {
      if (library[key] !== 0) {
        throw new Error(`${library.style} has unresolved ${key}: ${library[key]}`);
      }
    }
    if (library.effects !== 240 || library.images !== 480 || library.failures.length !== 0) {
      throw new Error(`${library.style} library coverage or failure list regressed`);
    }
  }
}, "visual");

await test("incremental telemetry blocks repeated full previews, final encodes and full QC", () => {
  const root = path.join(temporary, "incremental-render-budget");
  fs.mkdirSync(root, { recursive: true });
  const approval = path.join(root, "representative-preview-approved.json");
  writeJson(approval, {
    status: "approved",
    reviewedRanges: [[10, 16], [42, 48]],
    frozenDigests: ["edl", "style", "capability", "audio"],
  });
  const base = [
    path.join(scripts, "kacha.mjs"),
    "metrics",
    "run",
    "--project-root",
    root,
    "--workflow",
    "incremental",
    "--version-id",
    "v2",
  ];
  execute(process.execPath, [
    ...base,
    "--stage",
    "full_preview_after_approval",
    "--mode",
    "preview",
    "--render-scope",
    "full",
    "--video-encodes",
    "1",
    "--approval-evidence",
    approval,
    "--",
    "/usr/bin/true",
  ]);
  expectFailure(process.execPath, [
    ...base,
    "--stage",
    "full_preview_again",
    "--mode",
    "preview",
    "--render-scope",
    "full",
    "--video-encodes",
    "1",
    "--approval-evidence",
    approval,
    "--",
    "/usr/bin/true",
  ]);
  execute(process.execPath, [
    ...base,
    "--stage",
    "final_render",
    "--mode",
    "final",
    "--render-scope",
    "full",
    "--video-encodes",
    "1",
    "--",
    "/usr/bin/true",
  ]);
  expectFailure(process.execPath, [
    ...base,
    "--stage",
    "final_render_again",
    "--mode",
    "final",
    "--render-scope",
    "full",
    "--video-encodes",
    "1",
    "--",
    "/usr/bin/true",
  ]);
  execute(process.execPath, [
    ...base,
    "--stage",
    "release_qc",
    "--mode",
    "final",
    "--qc-scope",
    "full",
    "--video-encodes",
    "0",
    "--",
    "/usr/bin/true",
  ]);
  expectFailure(process.execPath, [
    ...base,
    "--stage",
    "release_qc_again",
    "--mode",
    "final",
    "--qc-scope",
    "full",
    "--video-encodes",
    "0",
    "--",
    "/usr/bin/true",
  ]);
}, "incremental");

await test("V6 global director budgets attention and routes factual asset gaps", () => {
  const root = path.join(temporary, "v6-director");
  fs.mkdirSync(root, { recursive: true });
  const cues = path.join(root, "cues.json");
  writeJson(cues, {
    schemaVersion: "1.0",
    cues: [
      { id: "hook", start: 0, end: 2, text: "为什么很多 AI 剪辑看起来都一样？", signals: ["hook", "logical_emphasis"], confidence: 0.98 },
      { id: "premise", start: 2, end: 10, text: "因为局部效果合理，不等于全片成立。", signals: ["ordinary_speech"], confidence: 0.97 },
      { id: "evidence", start: 10, end: 20, text: "数据显示首稿返工时间增长了 42%。", signals: ["evidence", "data", "number"], confidence: 0.96 },
      { id: "explain", start: 20, end: 30, text: "我们需要控制强调预算并保留安静段落。", signals: ["ordinary_speech"], confidence: 0.95 },
      { id: "contrast", start: 30, end: 40, text: "不是增加效果，而是提高判断质量。", signals: ["contrast", "negation", "logical_emphasis"], confidence: 0.99 },
      { id: "conclusion", start: 40, end: 50, text: "所以智能剪辑必须建立评价闭环。", signals: ["conclusion", "causality"], confidence: 0.99 }
    ]
  });
  const director = path.join(root, "director.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "director",
    "--cues", cues,
    "--style", "spatial-light-path",
    "--show", "very-ai",
    "--output", director,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "validate-plan",
    "--plan", director,
  ]);
  const directorValue = readJson(director);
  if (
    directorValue.opening.count !== 1
    || directorValue.attentionBudget.quietRatio < 0.35
    || directorValue.attentionBudget.deliberateNoneCount < 2
    || directorValue.project.styleGrammar !== "depth_navigation"
  ) throw new Error("V6 director did not enforce opening, quiet or style grammar budgets");
  const tamperedDirector = path.join(root, "director-tampered.json");
  const tamperedDirectorValue = structuredClone(directorValue);
  tamperedDirectorValue.beats[0].effectReason = "tampered but re-digested";
  delete tamperedDirectorValue.generatedAt;
  delete tamperedDirectorValue.digest;
  tamperedDirectorValue.digest = sha256Value(tamperedDirectorValue);
  writeJson(tamperedDirector, tamperedDirectorValue);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "validate-plan",
    "--plan", tamperedDirector,
  ]);

  const evidenceAsset = path.join(root, "evidence.png");
  fs.writeFileSync(evidenceAsset, "licensed factual evidence fixture");
  const mediaCatalog = path.join(root, "media-catalog.json");
  writeJson(mediaCatalog, {
    entries: [{
      id: "growth-data",
      kind: "image",
      path: evidenceAsset,
      description: "数据显示首稿返工时间增长 42%",
      license: "project-owned",
      provenance: { kind: "project_evidence", evidence: "fixture" }
    }],
  });
  const mediaIndex = path.join(root, "media-index.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "media", "index",
    "--root", root,
    "--catalog", mediaCatalog,
    "--no-scan",
    "--output", mediaIndex,
  ]);
  const tamperedIndex = readJson(mediaIndex);
  tamperedIndex.items[0].license = "tampered-license";
  tamperedIndex.items[0].provenance = { kind: "forged" };
  writeJson(mediaIndex, tamperedIndex);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "assets",
    "--director", director,
    "--media-index", mediaIndex,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "media", "index",
    "--root", root,
    "--catalog", mediaCatalog,
    "--no-scan",
    "--output", mediaIndex,
  ]);
  const gaps = path.join(root, "asset-gaps.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "assets",
    "--director", director,
    "--media-index", mediaIndex,
    "--output", gaps,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "validate-plan",
    "--plan", gaps,
    "--for-execution",
  ]);
  const gapValue = readJson(gaps);
  if (gapValue.summary.localCandidates !== 1 || gapValue.summary.productionReady !== true) {
    throw new Error("V6 asset gap planner did not resolve licensed local evidence");
  }
  const illustrativeCues = path.join(root, "illustrative-cues.json");
  writeJson(illustrativeCues, {
    schemaVersion: "1.0",
    cues: [
      { id: "hook", start: 0, end: 2, text: "先看一个模型", signals: ["hook"], confidence: 1 },
      { id: "illustration", start: 2, end: 10, text: "把流程想象成一条发光路径", signals: ["illustration_required"], confidence: 1 },
    ],
  });
  const illustrativeDirector = path.join(root, "illustrative-director.json");
  const illustrativeGaps = path.join(root, "illustrative-gaps.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "director",
    "--cues", illustrativeCues,
    "--output", illustrativeDirector,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "assets",
    "--director", illustrativeDirector,
    "--output", illustrativeGaps,
  ]);
  const illustrativeGapValue = readJson(illustrativeGaps);
  if (
    illustrativeGapValue.summary.unresolvedGeneratedCandidates !== 1
    || illustrativeGapValue.summary.productionReady !== false
  ) throw new Error("unmaterialized generated asset candidate was incorrectly execution-ready");
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "validate-plan",
    "--plan", illustrativeGaps,
    "--for-execution",
  ]);
  fs.appendFileSync(evidenceAsset, " changed-after-plan");
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "validate-plan",
    "--plan", gaps,
    "--for-execution",
  ]);
  fs.appendFileSync(cues, "\n");
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "validate-plan",
    "--plan", director,
  ]);
}, "core");

await test("V6 required evidence cannot be bypassed by an incremental v3 manifest", () => {
  const fixture = initializeIncrementalFixture("v6-required-gate");
  const project = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "caption_layout",
    outputVideo: path.join(fixture.root, "v2.mov"),
  });
  const manifest = readJson(project.project);
  manifest.intelligenceV6 = { required: true };
  manifest.plans = {};
  writeJson(project.project, manifest);
  const failed = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "gate-plan", project.project,
  ]);
  if (!/plans\.directorPlan/.test(`${failed.stdout}\n${failed.stderr}`)) {
    throw new Error("incremental v3 gate did not expose the missing V6 evidence");
  }
}, "incremental");

await test("V6 evidence set rejects cross-project director and asset plans", () => {
  const fixture = initializeIncrementalFixture("v6-coherence-gate");
  const project = createIncrementalCase(fixture, {
    versionId: "v2",
    type: "caption_layout",
    outputVideo: path.join(fixture.root, "v2.mov"),
  });
  const makeDirector = (id) => {
    const cues = path.join(fixture.root, `${id}-cues.json`);
    const director = path.join(fixture.root, `${id}-director.json`);
    writeJson(cues, {
      schemaVersion: "1.0",
      cues: [
        { id: "hook", start: 0, end: 2, text: `项目 ${id} 的开场`, signals: ["hook"], confidence: 1 },
        { id: "close", start: 2, end: 8, text: `项目 ${id} 的结论`, signals: ["conclusion"], confidence: 1 },
      ],
    });
    execute(process.execPath, [
      path.join(scripts, "kacha.mjs"), "intelligence", "director",
      "--cues", cues,
      "--project-id", id,
      "--output", director,
    ]);
    return director;
  };
  const directorA = makeDirector("project-a");
  const directorB = makeDirector("project-b");
  const assetB = path.join(fixture.root, "project-b-assets.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "assets",
    "--director", directorB,
    "--output", assetB,
  ]);
  const manifest = readJson(project.project);
  manifest.intelligenceV6 = { required: true };
  manifest.plans = { directorPlan: directorA, assetGapPlan: assetB };
  writeJson(project.project, manifest);
  const failed = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "gate-plan", project.project,
  ]);
  if (!/coherence|assetGapPlan/.test(`${failed.stdout}\n${failed.stderr}`)) {
    throw new Error("V6 gate accepted a cross-project evidence set");
  }
}, "incremental");

await test("V6 temporal perception audit blocks competing effects and preserves human review", () => {
  const root = path.join(temporary, "v6-perception");
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, "source.mov");
  fs.writeFileSync(source, "source fixture");
  const safeTimeline = path.join(root, "safe-timeline.json");
  writeJson(safeTimeline, {
    schemaVersion: "1.0",
    projectId: "perception-safe",
    mode: "preview",
    source: { path: source },
    edl: [{ id: "a", sourceStart: 0, sourceEnd: 10 }],
    visual: {
      breathing: [{ id: "push", start: 1, end: 3, scale: 1.04 }],
      overlays: [{
        id: "text", kind: "text", text: "稳定可读", start: 4, end: 6,
        x: 100, y: 100, width: 500, height: 160, fontSizeRatio: 0.05,
        primary: true, visibleLandingFrame: 100, sfxPeakFrame: 101
      }]
    },
    audio: { sfx: [] },
    output: { path: "preview.mp4", width: 1920, height: 1080, fps: 25 }
  });
  const report = path.join(root, "perception.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "perception",
    "--timeline", safeTimeline,
    "--output", report,
  ]);
  const safe = readJson(report);
  if (safe.status !== "pass_with_human_review" || safe.humanReview.required !== true) {
    throw new Error("perception audit must retain normal-speed human review");
  }
  const fakeDynamicEvidence = path.join(root, "fake-dynamic-evidence.mp4");
  fs.writeFileSync(fakeDynamicEvidence, "not a video");
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "perception",
    "--timeline", safeTimeline,
    "--dynamic-evidence", fakeDynamicEvidence,
  ]);
  const tamperedReport = path.join(root, "perception-tampered.json");
  const tamperedReportValue = structuredClone(safe);
  tamperedReportValue.measurements.motionCoverageRatio = 0;
  delete tamperedReportValue.generatedAt;
  delete tamperedReportValue.digest;
  tamperedReportValue.digest = sha256Value(tamperedReportValue);
  writeJson(tamperedReport, tamperedReportValue);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "validate-plan",
    "--plan", tamperedReport,
  ]);
  const unsafeTimeline = path.join(root, "unsafe-timeline.json");
  const unsafe = readJson(safeTimeline);
  unsafe.visual.overlays.push({
    id: "flash", kind: "text", text: "抢焦点", start: 4.02, end: 4.12,
    x: 0, y: 0, width: 1920, height: 1080, opacity: 1, fontSizeRatio: 0.02,
    primary: true
  });
  unsafe.visual.overlays.push({
    id: "outside", kind: "image", start: 20, end: 21,
    x: 0, y: 0, width: 100, height: 100, primary: false,
  });
  writeJson(unsafeTimeline, unsafe);
  const failed = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "perception",
    "--timeline", unsafeTimeline,
  ]);
  if (!/too_many_primary_effects|full_frame_flash_risk|mobile_text_too_small|event_outside_timeline/.test(failed.stdout)) {
    throw new Error("perception audit did not expose expected temporal blockers");
  }
  fs.appendFileSync(safeTimeline, "\n");
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "validate-plan",
    "--plan", report,
  ]);
}, "visual");

await test("V6 semantic review records every decision and learns only explicit versioned preferences", () => {
  const root = path.join(temporary, "v6-review");
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, "source.mov");
  fs.writeFileSync(source, "source fixture");
  const cues = path.join(root, "cues.json");
  writeJson(cues, {
    schemaVersion: "1.0",
    cues: [
      { id: "hook", start: 0, end: 2, text: "先看问题", signals: ["hook"], confidence: 0.99 },
      { id: "quiet", start: 2, end: 8, text: "解释背景", signals: ["ordinary_speech"], confidence: 0.99 },
      { id: "contrast", start: 8, end: 12, text: "但关键不是效果", signals: ["contrast"], confidence: 0.99 },
      { id: "quiet-2", start: 12, end: 20, text: "继续解释", signals: ["ordinary_speech"], confidence: 0.99 },
      { id: "conclusion", start: 20, end: 25, text: "判断决定上限", signals: ["conclusion"], confidence: 0.99 }
    ]
  });
  const director = path.join(root, "director.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "director",
    "--cues", cues,
    "--style", "light-warm-overlay",
    "--project-id", "review-project",
    "--output", director,
  ]);
  const timeline = path.join(root, "timeline.json");
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "review-project",
    mode: "preview",
    source: { path: source },
    edl: [{ id: "source", sourceStart: 0, sourceEnd: 25 }],
    visual: {
      overlays: [
        { id: "callout-a", kind: "text", effectType: "callout", text: "A", reason: "事实落位", start: 4, end: 6, x: 100, y: 100, width: 500, height: 120 },
        { id: "callout-b", kind: "text", effectType: "callout", text: "B", reason: "结论落位", start: 14, end: 16, x: 100, y: 100, width: 500, height: 120 }
      ]
    },
    audio: { sfx: [] },
    output: { path: "candidate.mp4", width: 1920, height: 1080, fps: 25 }
  });
  const reviewDirectory = path.join(root, "review");
  const previewDirectory = path.join(root, "preview");
  fs.mkdirSync(previewDirectory, { recursive: true });
  const previewFixture = path.join(root, "normal-speed-preview.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x20242b:s=320x180:r=25:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    previewFixture,
  ]);
  fs.copyFileSync(previewFixture, path.join(previewDirectory, "hook-after.mp4"));
  const missingPreviewReviewDirectory = path.join(root, "review-missing-previews");
  const missingPreviewBuild = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "build",
    "--timeline", timeline,
    "--director", director,
    "--preview-dir", previewDirectory,
    "--output-dir", missingPreviewReviewDirectory,
  ]).stdout);
  const missingPreviewBundle = readJson(missingPreviewBuild.bundle.path);
  for (const decision of missingPreviewBundle.decisions) {
    execute(process.execPath, [
      path.join(scripts, "kacha.mjs"), "review", "record",
      "--bundle", missingPreviewBuild.bundle.path,
      "--decision", decision.id,
      "--outcome", "accept",
    ]);
  }
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "validate",
    "--session", missingPreviewBuild.session.path,
    "--for-candidate",
  ]);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "learn",
    "--session", missingPreviewBuild.session.path,
    "--output", path.join(root, "invalid-incomplete-preference.json"),
  ]);
  for (const id of ["contrast", "conclusion", "callout-a", "callout-b"]) {
    fs.copyFileSync(previewFixture, path.join(previewDirectory, `${id}-after.mp4`));
  }
  const built = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "build",
    "--timeline", timeline,
    "--director", director,
    "--preview-dir", previewDirectory,
    "--output-dir", reviewDirectory,
  ]).stdout);
  const bundle = readJson(built.bundle.path);
  if (bundle.summary.withNormalSpeedPreview !== bundle.summary.total) {
    throw new Error("complete normal-speed preview evidence was not recognized");
  }
  const tamperedReviewDirectory = path.join(root, "review-tampered");
  fs.mkdirSync(tamperedReviewDirectory, { recursive: true });
  const tamperedBundle = structuredClone(bundle);
  tamperedBundle.decisions.pop();
  tamperedBundle.summary.total = tamperedBundle.decisions.length;
  tamperedBundle.summary.withNormalSpeedPreview = tamperedBundle.decisions.length;
  tamperedBundle.summary.requiresHuman = tamperedBundle.decisions.length;
  delete tamperedBundle.generatedAt;
  delete tamperedBundle.digest;
  tamperedBundle.digest = sha256Value(tamperedBundle);
  const tamperedBundleFile = path.join(tamperedReviewDirectory, "review-bundle.json");
  writeJson(tamperedBundleFile, tamperedBundle);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "show",
    "--bundle", tamperedBundleFile,
  ]);
  const misleadingBundle = structuredClone(bundle);
  misleadingBundle.decisions[0].rationale = "与真实导演计划相反的伪造理由";
  delete misleadingBundle.generatedAt;
  delete misleadingBundle.digest;
  misleadingBundle.digest = sha256Value(misleadingBundle);
  const misleadingBundleFile = path.join(tamperedReviewDirectory, "misleading-review-bundle.json");
  writeJson(misleadingBundleFile, misleadingBundle);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "show",
    "--bundle", misleadingBundleFile,
  ]);
  const scopeLaunderedBundle = structuredClone(bundle);
  scopeLaunderedBundle.project.id = "another-project";
  scopeLaunderedBundle.project.platform = "another-platform";
  delete scopeLaunderedBundle.generatedAt;
  delete scopeLaunderedBundle.digest;
  scopeLaunderedBundle.digest = sha256Value(scopeLaunderedBundle);
  const scopeLaunderedBundleFile = path.join(tamperedReviewDirectory, "scope-laundered-review-bundle.json");
  writeJson(scopeLaunderedBundleFile, scopeLaunderedBundle);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "show",
    "--bundle", scopeLaunderedBundleFile,
  ]);
  const invalidResolution = path.join(root, "invalid-resolution.txt");
  fs.writeFileSync(invalidResolution, "not a normal-speed media preview");
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "record",
    "--bundle", built.bundle.path,
    "--decision", bundle.decisions[0].id,
    "--outcome", "adjust",
    "--note", "测试伪解决证据",
    "--resolution-evidence", invalidResolution,
  ]);
  for (const decision of bundle.decisions) {
    execute(process.execPath, [
      path.join(scripts, "kacha.mjs"), "review", "record",
      "--bundle", built.bundle.path,
      "--decision", decision.id,
      "--outcome", "accept",
      "--reviewer", "test-reviewer",
    ]);
  }
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "validate",
    "--session", built.session.path,
    "--for-candidate",
  ]);
  const candidate = path.join(root, "preference-candidate.json");
  const learned = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "learn",
    "--session", built.session.path,
    "--output", candidate,
  ]).stdout);
  if (learned.rules < 1 || readJson(candidate).activation.automatic !== false) {
    throw new Error("preference learning did not produce an explicit candidate");
  }
  const profile = path.join(root, "preferences.json");
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "activate",
    "--candidate", candidate,
    "--profile", profile,
  ]);
  const releaseProfileLock = acquireFileLock(`${profile}.lock`, { purpose: "test-active-preference-writer" });
  try {
    expectFailure(process.execPath, [
      path.join(scripts, "kacha.mjs"), "review", "activate",
      "--candidate", candidate,
      "--profile", profile,
      "--confirm",
    ]);
  } finally {
    releaseProfileLock();
  }
  const tamperedCandidate = path.join(root, "preference-candidate-tampered.json");
  const tamperedCandidateValue = readJson(candidate);
  tamperedCandidateValue.rules[0].value = "forged-without-review-evidence";
  delete tamperedCandidateValue.generatedAt;
  delete tamperedCandidateValue.digest;
  tamperedCandidateValue.digest = sha256Value(tamperedCandidateValue);
  writeJson(tamperedCandidate, tamperedCandidateValue);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "activate",
    "--candidate", tamperedCandidate,
    "--profile", profile,
    "--confirm",
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "activate",
    "--candidate", candidate,
    "--profile", profile,
    "--confirm",
  ]);
  if (readJson(profile).versionNumber !== 1) throw new Error("preference profile was not versioned");
  const initialRules = readJson(profile).rules.map((rule) => `${rule.key}:${JSON.stringify(rule.value)}`);
  const overlayDecision = bundle.decisions.find((decision) => decision.category === "overlay");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "record",
    "--bundle", built.bundle.path,
    "--decision", overlayDecision.id,
    "--outcome", "reject",
    "--note", "不再沿用这一处 overlay 偏好",
    "--resolution-evidence", previewFixture,
  ]);
  const candidateV2 = path.join(root, "preference-candidate-v2.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "learn",
    "--session", built.session.path,
    "--output", candidateV2,
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "activate",
    "--candidate", candidateV2,
    "--profile", profile,
    "--confirm",
  ]);
  const mergedRules = readJson(profile).rules.map((rule) => `${rule.key}:${JSON.stringify(rule.value)}`);
  if (!initialRules.every((rule) => mergedRules.includes(rule))) {
    throw new Error("activating a partial preference candidate dropped previously learned rules");
  }
  if (readJson(profile).versionNumber !== 2) throw new Error("preference profile did not advance monotonically");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "rollback",
    "--profile", profile,
    "--version", "1",
    "--confirm",
  ]);
  if (
    readJson(profile).versionNumber !== 3
    || readJson(profile).rollback.restoredFromVersion !== 1
  ) throw new Error("preference rollback did not create an auditable monotonic version");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "record",
    "--bundle", built.bundle.path,
    "--decision", bundle.decisions[0].id,
    "--outcome", "accept",
    "--reviewer", "test-reviewer-updated",
  ]);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "activate",
    "--candidate", candidateV2,
    "--profile", profile,
    "--confirm",
  ]);
}, "core");

await test("V6 editorial evaluation measures paired human-reviewed improvement without a composite vanity score", () => {
  const root = path.join(temporary, "v6-eval");
  fs.mkdirSync(root, { recursive: true });
  const sources = Array.from({ length: 9 }, (_, index) => path.join(root, `source-${index + 1}.mov`));
  const baselineOutputs = Array.from({ length: 9 }, (_, index) => path.join(root, `baseline-${index + 1}.mp4`));
  const candidateOutputs = Array.from({ length: 8 }, (_, index) => path.join(root, `candidate-${index + 1}.mp4`));
  const mediaSeed = path.join(root, "media-seed.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x20242b:s=64x64:r=25:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    mediaSeed,
  ]);
  const makeUniqueMedia = (file, marker) => {
    fs.copyFileSync(mediaSeed, file);
    fs.appendFileSync(file, `\n${marker}\n`);
  };
  for (const [index, file] of sources.entries()) makeUniqueMedia(file, `source-media-${index + 1}`);
  for (const [index, file] of baselineOutputs.entries()) makeUniqueMedia(file, `baseline-output-${index + 1}`);
  for (const [index, file] of candidateOutputs.entries()) makeUniqueMedia(file, `candidate-output-${index + 1}`);
  const foreignSource = path.join(root, "foreign-source.mov");
  makeUniqueMedia(foreignSource, "foreign-source-media");
  const contentIdentity = (file) => {
    const identity = fileIdentity(file);
    return { path: identity.path, sha256: identity.sha256 };
  };
  const makeDataset = (candidate) => ({
    schemaVersion: "1.0",
    kind: "kacha_editorial_eval_dataset",
    id: candidate ? "candidate" : "baseline",
    version: "v1",
    cases: [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `case-${index + 1}`,
        sourceGroupId: `source-${index + 1}`,
        showId: ["tool-share", "book-talk", "infinite-game", "very-ai", "casual-chat"][index % 5],
        styleId: [
          "light-warm-overlay",
          "spatial-light-path",
          "humor-comic",
          "pixel-editorial",
          "dark-tech",
        ][index % 5],
        platform: index % 2 ? "douyin" : "wechat-channels",
        editorialJudgment: {
          humanReviewed: true,
          firstDraftUsability: candidate ? 0.9 : 0.65,
          outputDurationSeconds: 1,
          manualInterventionMinutes: candidate ? 3 : 9,
          semanticUnits: { total: 20, damaged: candidate ? 0 : 1 },
          highImpactDecisions: { total: 10, accepted: candidate ? 8 : 5, adjusted: candidate ? 2 : 3, rejected: candidate ? 0 : 2 },
          connections: { total: 8, rejected: candidate ? 0 : 1 },
          captions: { total: 30, corrected: candidate ? 1 : 4 },
          styleGrammar: { total: 12, violations: candidate ? 0 : 2 }
        },
        evidence: {
          reviewer: "test-reviewer",
          reviewedAt: "2026-08-08T00:00:00.000Z",
          normalSpeedReview: true,
          phoneAndHeadphoneReview: true,
          sourceMedia: contentIdentity(sources[index]),
          reviewedOutput: contentIdentity(candidate ? candidateOutputs[index] : baselineOutputs[index]),
        }
      })),
      ...(!candidate ? [{
        id: "baseline-only-case",
        sourceGroupId: "baseline-only-source",
        showId: "tool-share",
        styleId: "light-warm-overlay",
        platform: "douyin",
        editorialJudgment: {
          humanReviewed: true,
          firstDraftUsability: 1,
          outputDurationSeconds: 1,
          manualInterventionMinutes: 0,
          semanticUnits: { total: 20, damaged: 0 },
          highImpactDecisions: { total: 10, accepted: 10, adjusted: 0, rejected: 0 },
          connections: { total: 8, rejected: 0 },
          captions: { total: 30, corrected: 0 },
          styleGrammar: { total: 12, violations: 0 },
        },
        evidence: {
          reviewer: "test-reviewer",
          reviewedAt: "2026-08-08T00:00:00.000Z",
          normalSpeedReview: true,
          phoneAndHeadphoneReview: true,
          sourceMedia: contentIdentity(sources[8]),
          reviewedOutput: contentIdentity(baselineOutputs[8]),
        },
      }] : []),
    ]
  });
  const baselineData = path.join(root, "baseline-data.json");
  const candidateData = path.join(root, "candidate-data.json");
  writeJson(baselineData, makeDataset(false));
  writeJson(candidateData, makeDataset(true));
  const baselineReport = path.join(root, "baseline-report.json");
  const candidateReport = path.join(root, "candidate-report.json");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "eval", "score", "--dataset", baselineData, "--output", baselineReport]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "eval", "score", "--dataset", candidateData, "--output", candidateReport]);
  const comparison = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "compare",
    "--baseline", baselineReport,
    "--candidate", candidateReport,
  ]).stdout);
  if (
    comparison.claimPolicy.improvementClaimAllowed !== true
    || comparison.deltas.firstDraftUsableRate.direction !== "improved"
    || comparison.deltas.firstDraftUsableRate.baseline !== 0
    || comparison.deltas.semanticDamageRate.direction !== "improved"
    || Object.hasOwn(comparison, "compositeScore")
  ) throw new Error("paired editorial evaluation policy regressed");
  const regressedData = path.join(root, "regressed-candidate-data.json");
  const regressedDataset = makeDataset(true);
  regressedDataset.id = "candidate-with-semantic-regression";
  for (const item of regressedDataset.cases) item.editorialJudgment.semanticUnits.damaged = 2;
  writeJson(regressedData, regressedDataset);
  const regressedReport = path.join(root, "regressed-candidate-report.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "score",
    "--dataset", regressedData,
    "--output", regressedReport,
  ]);
  const regressedComparison = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "compare",
    "--baseline", baselineReport,
    "--candidate", regressedReport,
  ]).stdout);
  if (
    regressedComparison.claimPolicy.improvementClaimAllowed !== false
    || !regressedComparison.claimPolicy.regressedGuardrails.includes("semanticDamageRate")
  ) throw new Error("sample count incorrectly overrode a regressed quality guardrail");
  const invalidNumericData = path.join(root, "invalid-numeric-data.json");
  const invalidNumericDataset = makeDataset(true);
  invalidNumericDataset.cases[0].editorialJudgment.manualInterventionMinutes = "1";
  writeJson(invalidNumericData, invalidNumericDataset);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "score",
    "--dataset", invalidNumericData,
  ]);
  const mismatchedSourceData = path.join(root, "mismatched-source-data.json");
  const mismatchedSourceDataset = makeDataset(true);
  mismatchedSourceDataset.id = "candidate-with-mismatched-source";
  mismatchedSourceDataset.cases[0].evidence.sourceMedia = contentIdentity(foreignSource);
  writeJson(mismatchedSourceData, mismatchedSourceDataset);
  const mismatchedSourceReport = path.join(root, "mismatched-source-report.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "score",
    "--dataset", mismatchedSourceData,
    "--output", mismatchedSourceReport,
  ]);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "compare",
    "--baseline", baselineReport,
    "--candidate", mismatchedSourceReport,
  ]);
  const duplicatedSourceData = path.join(root, "duplicated-source-data.json");
  const duplicatedSourceDataset = makeDataset(true);
  duplicatedSourceDataset.id = "candidate-with-repeated-source";
  duplicatedSourceDataset.cases[1].evidence.sourceMedia = duplicatedSourceDataset.cases[0].evidence.sourceMedia;
  writeJson(duplicatedSourceData, duplicatedSourceDataset);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "score",
    "--dataset", duplicatedSourceData,
  ]);
  const tampered = readJson(baselineData);
  tampered.version = "tampered-after-report";
  writeJson(baselineData, tampered);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "eval", "compare",
    "--baseline", baselineReport,
    "--candidate", candidateReport,
  ]);
}, "core");

await test("V6 NLE interchange round-trips semantic clip IDs as candidate-only timelines", () => {
  const root = path.join(temporary, "v6-nle");
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, "source.mov");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x263238:s=160x90:d=11:r=30000/1001",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
  ]);
  if (mediaSummary(source).duration < 10) throw new Error("NLE source fixture is not a valid 10-second media file");
  const timeline = path.join(root, "timeline.json");
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "nle-project",
    mode: "preview",
    source: { path: source, sha256: sha256File(source) },
    edl: [
      { id: "hook", sourceStart: 1, sourceEnd: 3, sourceDecisionId: "decision-hook", semanticBeatId: "beat-hook" },
      { id: "proof", sourceStart: 6, sourceEnd: 10, sourceDecisionId: "decision-proof", semanticBeatId: "beat-proof" }
    ],
    visual: { overlays: [] },
    audio: { sfx: [] },
    output: { path: "preview.mp4", width: 1920, height: 1080, fps: 29.97 }
  });
  for (const format of ["otio", "fcpxml", "cmx3600"]) {
    const extension = format === "fcpxml" ? "fcpxml" : format === "otio" ? "otio" : "edl";
    execute(process.execPath, [
      path.join(scripts, "kacha.mjs"), "nle", "export",
      "--timeline", timeline,
      "--format", format,
      "--output", path.join(root, `timeline.${extension}`),
    ]);
  }
  const fcpxmlText = fs.readFileSync(path.join(root, "timeline.fcpxml"), "utf8");
  if (!fcpxmlText.includes('frameDuration="1001/30000s"') || fcpxmlText.includes("1/29.97s")) {
    throw new Error("FCPXML did not encode fractional frame rate as a valid rational time");
  }
  for (const format of ["otio", "fcpxml"]) {
    const input = path.join(root, format === "otio" ? "timeline.otio" : "timeline.fcpxml");
    const output = path.join(root, `${format}-candidate.json`);
    execute(process.execPath, [
      path.join(scripts, "kacha.mjs"), "nle", "import",
      "--input", input,
      "--format", format,
      "--base-timeline", timeline,
      "--output", output,
    ]);
    const candidate = readJson(output);
    if (
      candidate.mode !== "preview"
      || candidate.interchangeCandidate.candidateOnly !== true
      || candidate.edl.map((clip) => clip.id).join(",") !== "hook,proof"
      || candidate.edl[1].semanticBeatId !== "beat-proof"
    ) throw new Error(`${format} semantic round-trip failed`);
  }
  const forgedOtio = readJson(path.join(root, "timeline.otio"));
  forgedOtio.tracks.children[0].children[0].metadata.kacha.kachaId = "forged-clip";
  const forgedOtioFile = path.join(root, "timeline-forged-id.otio");
  writeJson(forgedOtioFile, forgedOtio);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "nle", "import",
    "--input", forgedOtioFile,
    "--format", "otio",
    "--base-timeline", timeline,
    "--output", path.join(root, "forged-id-candidate.json"),
  ]);
  const wrongSourceShaOtio = readJson(path.join(root, "timeline.otio"));
  wrongSourceShaOtio.tracks.children[0].children[0].media_reference.metadata.kachaSourceSha256 = "0".repeat(64);
  const wrongSourceShaOtioFile = path.join(root, "timeline-wrong-source-sha.otio");
  writeJson(wrongSourceShaOtioFile, wrongSourceShaOtio);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "nle", "import",
    "--input", wrongSourceShaOtioFile,
    "--format", "otio",
    "--base-timeline", timeline,
    "--output", path.join(root, "wrong-source-sha-candidate.json"),
  ]);
  const otherSource = path.join(root, "other-source.mov");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x5d4037:s=160x90:d=11:r=30000/1001",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", otherSource,
  ]);
  if (mediaSummary(otherSource).duration < 10) throw new Error("alternate NLE source fixture is not valid media");
  const otherTimeline = path.join(root, "other-timeline.json");
  const otherTimelineValue = readJson(timeline);
  otherTimelineValue.source = { path: otherSource, sha256: sha256File(otherSource) };
  writeJson(otherTimeline, otherTimelineValue);
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "nle", "import",
    "--input", path.join(root, "timeline.otio"),
    "--format", "otio",
    "--base-timeline", otherTimeline,
    "--output", path.join(root, "wrong-base-candidate.json"),
  ]);
}, "core");

await test("V6 review workbench is local-only and exposes the new review assets", async () => {
  const server = fs.readFileSync(path.join(scripts, "kacha_studio_server.mjs"), "utf8");
  const html = fs.readFileSync(path.join(skillDirectory, "studio", "review.html"), "utf8");
  const css = fs.readFileSync(path.join(skillDirectory, "studio", "review.css"), "utf8");
  const projectHtml = fs.readFileSync(path.join(skillDirectory, "studio", "project.html"), "utf8");
  const projectJs = fs.readFileSync(path.join(skillDirectory, "studio", "project.js"), "utf8");
  const contentHtml = fs.readFileSync(path.join(skillDirectory, "studio", "content.html"), "utf8");
  const editorJs = fs.readFileSync(path.join(skillDirectory, "studio", "editor.js"), "utf8");
  if (
    !server.includes("/api/review/media")
    || !server.includes("/api/project/status")
    || !server.includes("/api/release/approve")
    || !server.includes("/api/content/start")
    || !server.includes("127.0.0.1")
    || !server.includes("media-src 'self'")
    || !html.includes("正常速度")
    || !html.includes("接受不等于发布")
    || !html.includes("十一项当前成片检查")
    || !projectHtml.includes("四个生产里程碑")
    || !projectHtml.includes("QUALITY-PRESERVING EFFICIENCY · V8")
    || !projectJs.includes("/api/project/run")
    || !projectJs.includes("renderEfficiency")
    || !contentHtml.includes("还没有视频")
    || !editorJs.includes("if (!current) {")
    || !css.includes("--signal: #ff6b1a")
  ) throw new Error("V7 local project and unified review workbench contract is incomplete");
  const root = path.join(temporary, "v6-review-workbench");
  const reviewDirectory = path.join(root, "review");
  const previewDirectory = path.join(root, "preview");
  fs.mkdirSync(previewDirectory, { recursive: true });
  const source = path.join(root, "source.mov");
  fs.writeFileSync(source, "source fixture");
  const cues = path.join(root, "cues.json");
  writeJson(cues, {
    schemaVersion: "1.0",
    cues: [
      { id: "hook", start: 0, end: 2, text: "先看问题", signals: ["hook"] },
      { id: "quiet", start: 2, end: 8, text: "解释背景", signals: ["ordinary_speech"] },
      { id: "close", start: 8, end: 10, text: "最后给出判断", signals: ["conclusion"] },
    ],
  });
  const director = path.join(root, "director.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "director",
    "--cues", cues,
    "--style", "light-warm-overlay",
    "--project-id", "review-workbench-project",
    "--output", director,
  ]);
  const timeline = path.join(root, "timeline.json");
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "review-workbench-project",
    mode: "preview",
    source: { path: source },
    edl: [{ id: "source", sourceStart: 0, sourceEnd: 10 }],
    visual: { overlays: [] },
    audio: { sfx: [] },
    output: { path: "candidate.mp4", width: 1920, height: 1080, fps: 25 },
  });
  const workbenchPreview = path.join(previewDirectory, "hook-after.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x20242b:s=320x180:r=25:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    workbenchPreview,
  ]);
  const built = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "build",
    "--timeline", timeline,
    "--director", director,
    "--preview-dir", previewDirectory,
    "--output-dir", reviewDirectory,
  ]).stdout);
  const bundleFile = built.bundle.path;
  const port = 47000 + (process.pid % 1000);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    path.join(scripts, "kacha_studio_server.mjs"),
    "--port", String(port),
    "--no-open",
  ], { cwd: skillDirectory, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const response = await fetch(`${origin}/api/health`);
        ready = response.ok;
        if (ready) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready) throw new Error(`studio review server did not start\n${stderr}`);
    const rebindingStatus = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/api/bootstrap",
        method: "GET",
        headers: { host: `attacker.example:${port}` },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
      request.end();
    });
    if (rebindingStatus !== 421) {
      throw new Error("studio server did not reject a non-loopback Host header");
    }
    const mutationHeaders = {
      "content-type": "application/json",
      "x-kacha-studio": "1",
      origin,
      referer: `${origin}/review`,
    };
    const nonObjectResponse = await fetch(`${origin}/api/review/open`, {
      method: "POST",
      headers: mutationHeaders,
      body: "null",
    });
    const nonObject = await nonObjectResponse.json();
    if (
      nonObjectResponse.status !== 400
      || nonObject.status !== "blocked"
      || !nonObject.error.includes("根节点必须是 object")
    ) throw new Error("studio server accepted a non-object JSON root");
    const declaredOverflowResponse = await fetch(`${origin}/api/review/open`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });
    const declaredOverflow = await declaredOverflowResponse.json();
    if (
      declaredOverflowResponse.status !== 413
      || declaredOverflow.status !== "blocked"
      || !declaredOverflow.error.includes("超过 1 MB")
    ) throw new Error("studio server did not return structured 413 for Content-Length overflow");
    const chunkedOverflow = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/api/review/open",
        method: "POST",
        headers: mutationHeaders,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      });
      request.once("error", reject);
      request.write(`{"padding":"${"x".repeat(700 * 1024)}`);
      request.end(`${"x".repeat(400 * 1024)}"}`);
    });
    if (
      chunkedOverflow.status !== 413
      || chunkedOverflow.body.status !== "blocked"
      || !chunkedOverflow.body.error.includes("超过 1 MB")
    ) throw new Error("studio server did not return structured 413 for chunked overflow");
    const healthyAfterBoundaryFailures = await fetch(`${origin}/api/health`);
    if (!healthyAfterBoundaryFailures.ok) {
      throw new Error("studio server was not healthy after request-body failures");
    }
    const malformedRequestLine = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.write(`GET /%\u0001\u0002bad HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      const chunks = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.once("error", reject);
    });
    if (!malformedRequestLine.startsWith("HTTP/1.1 400")) {
      throw new Error(`malformed request line did not fail fast with 400: ${malformedRequestLine.slice(0, 40)}`);
    }
    const openedResponse = await fetch(`${origin}/api/review/open`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ bundlePath: bundleFile }),
    });
    const opened = await openedResponse.json();
  const previewDecision = opened.bundle?.decisions?.find((item) => item.preview?.after);
  if (!openedResponse.ok || !previewDecision || !opened.session?.path) {
    throw new Error(`review open API failed: ${JSON.stringify(opened)}`);
  }
  const watchable = opened.bundle.decisions.filter((decision) => (
    Array.isArray(decision.suggestedWatch)
    && decision.suggestedWatch.every((window) => window.end > window.start && window.fps > 0)
  ));
  if (watchable.length !== opened.bundle.decisions.length) {
    throw new Error("review bundle lost suggested watch windows for some high-impact decisions");
  }
    const mediaUrl = new URL("/api/review/media", origin);
    mediaUrl.searchParams.set("bundle", bundleFile);
    mediaUrl.searchParams.set("decision", previewDecision.id);
    mediaUrl.searchParams.set("variant", "after");
    const previewBytes = fs.readFileSync(workbenchPreview);
    const expectedSuffix = previewBytes.subarray(previewBytes.length - 4);
    const mediaResponse = await fetch(mediaUrl, { headers: { range: "bytes=-4" } });
    if (
      mediaResponse.status !== 206
      || mediaResponse.headers.get("content-range") !== `bytes ${previewBytes.length - 4}-${previewBytes.length - 1}/${previewBytes.length}`
      || !Buffer.from(await mediaResponse.arrayBuffer()).equals(expectedSuffix)
    ) throw new Error("review media Range endpoint did not preserve the bound preview");
    const headResponse = await fetch(mediaUrl, { method: "HEAD" });
    if (
      headResponse.status !== 200
      || headResponse.headers.get("content-length") !== String(previewBytes.length)
      || (await headResponse.text()) !== ""
    ) throw new Error("review media HEAD endpoint did not expose metadata without a body");
    const crossOriginMedia = await fetch(mediaUrl, { headers: { origin: "https://attacker.invalid" } });
    if (crossOriginMedia.ok) throw new Error("cross-origin review media read was accepted");
    const sameOriginMedia = await fetch(mediaUrl, { headers: { origin } });
    if (!sameOriginMedia.ok) throw new Error("same-origin review media read was rejected");
    const recordedResponse = await fetch(`${origin}/api/review/record`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        bundlePath: bundleFile,
        decisionId: previewDecision.id,
        outcome: "accept",
        reviewer: "studio-api-test",
      }),
    });
    const recorded = await recordedResponse.json();
    if (!recordedResponse.ok || recorded.decision?.outcome !== "accept" || !recorded.session?.path) {
      throw new Error(`review record API failed: ${JSON.stringify(recorded)}`);
    }
    const metricsDirectory = path.join(root, ".kacha", "metrics");
    fs.mkdirSync(metricsDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(metricsDirectory, "events.jsonl"),
      `${JSON.stringify({
        stage: "preview_render",
        status: "pass",
        timing: { wallSeconds: 1.25 },
        tokens: { input: 8, output: 2, references: 3, measurement: "actual" },
        cache: { status: "hit" },
        media: { videoEncodes: 1 },
      })}\n{truncated-json\n`,
    );
    const failedJobOutput = path.join(root, "failed-job-output.txt");
    const failedJobResult = JSON.parse(execute(process.execPath, [
      path.join(scripts, "kacha.mjs"), "jobs", "submit",
      "--project-root", root,
      "--kind", "render",
      "--expected-output", failedJobOutput,
      "--foreground",
      "--",
      process.execPath,
      "-e",
      "process.exit(3)",
    ]).stdout);
    const failedJobFile = path.join(
      root,
      ".kacha",
      "jobs",
      failedJobResult.ref.split(":")[1],
      "job.json",
    );
    const failedJob = readJson(failedJobFile);
    failedJob.error = ["Author", "ization: Be", "arer should-never-reach-the-review-ui"].join("");
    writeJson(failedJobFile, failedJob);
    const observedResponse = await fetch(`${origin}/api/observe`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ projectRoot: root }),
    });
    const observed = await observedResponse.json();
    if (
      !observedResponse.ok
      || observed.cost?.status !== "unavailable"
      || observed.metrics?.events !== 1
      || observed.metrics?.tokens?.measurement !== "actual"
      || observed.integrity?.status !== "degraded"
      || !observed.integrity?.warnings?.some((item) => item.code === "invalid_metrics_jsonl")
      || JSON.stringify(observed).includes("should-never-reach-the-review-ui")
    ) {
      throw new Error(`review observability API fabricated cost evidence: ${JSON.stringify(observed)}`);
    }
    const flightUrl = new URL("/api/flight", origin);
    flightUrl.searchParams.set("projectRoot", root);
    const flightResponse = await fetch(flightUrl, { headers: { "X-Kacha-Studio": "1" } });
    const flight = await flightResponse.json();
    if (!flightResponse.ok || flight.kind !== "kacha-production-flight" || !Array.isArray(flight.events)) {
      throw new Error(`read-only flight API failed: ${JSON.stringify(flight)}`);
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}, "core");

await test("Timebase V2 preserves exact fractional-frame boundaries and migrates legacy Timeline IR", () => {
  for (const frameRate of [
    { numerator: 24000, denominator: 1001 },
    { numerator: 30000, denominator: 1001 },
    { numerator: 60000, denominator: 1001 },
    { numerator: 25, denominator: 1 },
  ]) {
    const timebase = normalizeTimebase({ ticksPerSecond: 120000, frameRate });
    const frame = 1_000_000;
    const tick = framesToTicks(frame, timebase);
    if (ticksToFrames(tick, timebase) !== frame) {
      throw new Error(`fractional frame drifted at ${frameRate.numerator}/${frameRate.denominator}`);
    }
  }
  const root = path.join(temporary, "timebase-v2");
  fs.mkdirSync(root, { recursive: true });
  const legacy = path.join(root, "legacy.json");
  const migrated = path.join(root, "migrated.json");
  writeJson(legacy, {
    schemaVersion: "1.0",
    projectId: "timebase-migration",
    mode: "preview",
    source: { path: "missing-source.mp4" },
    edl: [{ id: "clip", sourceStart: 1.001, sourceEnd: 5.005 }],
    visual: { overlays: [] },
    audio: { sfx: [] },
    output: { path: "preview.mp4", width: 1920, height: 1080, fps: 24000 / 1001 },
  });
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "timeline", "migrate-timebase",
    "--plan", legacy, "--output", migrated,
  ]);
  const value = readJson(migrated);
  if (
    value.timebase?.frameRate?.numerator !== 24000
    || value.timebase?.frameRate?.denominator !== 1001
    || !Number.isSafeInteger(value.edl[0].sourceStartTick)
    || readJson(legacy).timebase
  ) throw new Error("legacy timeline migration was not exact or overwrote its source");
  const conflict = path.join(root, "conflict.json");
  writeJson(conflict, {
    ...value,
    edl: [{ ...value.edl[0], sourceStart: 9 }],
  });
  const failed = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "timeline", "migrate-timebase",
    "--plan", conflict, "--output", path.join(root, "must-not-exist.json"),
  ]);
  if (!failed.stderr.includes("超过半帧")) throw new Error("timebase conflict did not fail closed");
}, "editor");

await test("Editor mutation inverses restore array inserts and object adds exactly", () => {
  const original = { tracks: [{ id: "a" }, { id: "b" }], metadata: { title: "demo" } };
  for (const operation of [
    { op: "add", path: "/tracks/1", value: { id: "inserted" } },
    { op: "add", path: "/tracks/-", value: { id: "tail" } },
    { op: "add", path: "/metadata/status", value: "draft" },
  ]) {
    const applied = applyJsonOperations(original, [operation], { captureInverse: true });
    const restored = applyJsonOperations(applied.value, applied.inverseOperations);
    if (JSON.stringify(restored) !== JSON.stringify(original)) {
      throw new Error(`mutation inverse did not restore ${operation.path}`);
    }
  }
}, "editor");

await test("Timeline Projection and Command Journal apply undo redo and detect tamper or truncation", () => {
  const root = path.join(temporary, "editor-command-journal");
  fs.mkdirSync(root, { recursive: true });
  const timeline = path.join(root, "timeline.json");
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "editor-command-journal",
    mode: "preview",
    source: { path: "missing-source.mp4" },
    edl: [{ id: "main", sourceStart: 0, sourceEnd: 10 }],
    visual: {
      breathing: [],
      overlays: [{
        id: "card-1", kind: "image", path: "missing-card.png",
        start: 1, end: 4, x: 20, y: 30, width: 320, height: 180, opacity: 1,
      }],
    },
    audio: {
      bgm: { segments: [{ id: "music-1", path: "missing.wav", start: 0, end: 10 }] },
      sfx: [{ id: "tick", path: "missing.wav", time: 2, timingReference: "file_start" }],
    },
    output: { path: "preview.mp4", width: 1920, height: 1080, fps: 30000 / 1001 },
  });
  const opened = openEditorProject(timeline);
  const timelineAlias = path.join(root, "timeline-alias.json");
  fs.symlinkSync(timeline, timelineAlias);
  if (openEditorProject(timelineAlias).session.timelinePath !== fs.realpathSync(timeline)) {
    throw new Error("editor session was not bound to the Timeline realpath");
  }
  const overlay = opened.projection.items.find((item) => item.id === "overlay:card-1");
  const sfx = opened.projection.items.find((item) => item.id === "sfx:tick");
  if (!overlay || !overlay.editableFields.includes("x") || !overlay.editableFields.includes("startTick")) {
    throw new Error("projection did not expose a traceable overlay allowlist");
  }
  if (opened.session.synchronized !== true || opened.session.timebase?.ticksPerSecond !== 120000) {
    throw new Error("editor session did not bind the canonical Timeline timebase");
  }
  if (!sfx?.editableFields.includes("timeTick") || !Number.isSafeInteger(sfx.metadata.timeTick)) {
    throw new Error("projection did not expose the actual editable SFX timing field");
  }
  const originalSha = opened.session.currentSha256;
  const alignedStartTick = opened.session.timebase.ticksPerFrame * 30;
  let missingBaseBlocked = false;
  try {
    applyEditorCommand(timeline, {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      itemId: overlay.id, changes: { x: 240 },
    });
  } catch (error) {
    missingBaseBlocked = /baseSha256/.test(error.message);
  }
  if (!missingBaseBlocked || sha256File(timeline) !== originalSha) throw new Error("editor apply accepted a mutation without caller SHA");
  const applied = applyEditorCommand(timeline, {
    schemaVersion: "1.0",
    kind: "kacha-editor-command",
    baseSha256: originalSha,
    commandId: "cmd-test-1",
    itemId: overlay.id,
    changes: { x: 240, startTick: alignedStartTick },
    actor: "test",
    reason: "test geometry",
  });
  const changed = readJson(timeline);
  if (changed.visual.overlays[0].x !== 240 || changed.visual.overlays[0].startTick !== alignedStartTick) {
    throw new Error("editor command did not write scalar and canonical time together");
  }
  let duplicateCommandBlocked = false;
  try {
    applyEditorCommand(timeline, {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      commandId: "cmd-test-1", baseSha256: applied.timelineSha256,
      itemId: overlay.id, changes: { x: 241 },
    });
  } catch (error) {
    duplicateCommandBlocked = /commandId 已存在/.test(error.message);
  }
  if (!duplicateCommandBlocked) throw new Error("duplicate commandId was accepted into the journal");
  let emptyCommandBlocked = false;
  try {
    applyEditorCommand(timeline, {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      baseSha256: applied.timelineSha256, itemId: overlay.id, changes: {},
    });
  } catch (error) {
    emptyCommandBlocked = /不能为空/.test(error.message);
  }
  if (!emptyCommandBlocked) throw new Error("empty editor command was accepted");
  for (const invalidCommand of [
    {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      baseSha256: applied.timelineSha256, itemId: overlay.id, changes: { x: "241" },
    },
    {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      baseSha256: applied.timelineSha256, itemId: overlay.id, changes: { toString: 1 },
    },
    {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      baseSha256: applied.timelineSha256, itemId: overlay.id, changes: { x: 241 }, arbitraryPath: "/tmp",
    },
    {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      baseSha256: applied.timelineSha256, itemId: overlay.id, changes: { startTick: 1 },
    },
  ]) {
    let invalidBlocked = false;
    try { applyEditorCommand(timeline, invalidCommand); } catch (error) {
      invalidBlocked = /有限数值|allowlist|未知字段|整帧边界/.test(error.message);
    }
    if (!invalidBlocked) throw new Error("editor accepted a command outside its strict contract");
  }
  let staleBlocked = false;
  try {
    applyEditorCommand(timeline, {
      schemaVersion: "1.0",
      kind: "kacha-editor-command",
      baseSha256: originalSha,
      itemId: overlay.id,
      changes: { x: 300 },
    });
  } catch (error) {
    staleBlocked = /expected|过期|其他进程/.test(error.message);
  }
  if (!staleBlocked) throw new Error("stale editor base SHA was not blocked");
  let staleUndoBlocked = false;
  try { undoEditorCommand(timeline, originalSha); } catch (error) {
    staleUndoBlocked = /过期|expected/.test(error.message);
  }
  if (!staleUndoBlocked || sha256File(timeline) !== applied.timelineSha256) {
    throw new Error("stale undo caller mutated current Timeline history");
  }
  const undone = undoEditorCommand(timeline, applied.timelineSha256);
  if (readJson(timeline).visual.overlays[0].x !== 20 || !undone.project.session.canRedo) {
    throw new Error("undo did not restore the snapshot-backed inverse command");
  }
  const redone = redoEditorCommand(timeline, undone.timelineSha256);
  if (readJson(timeline).visual.overlays[0].x !== 240 || !redone.project.session.canUndo) {
    throw new Error("redo did not replay the original command");
  }
  const beforeInvalidSha = sha256File(timeline);
  let geometryBlocked = false;
  try {
    applyEditorCommand(timeline, {
      schemaVersion: "1.0",
      kind: "kacha-editor-command",
      baseSha256: beforeInvalidSha,
      itemId: overlay.id,
      changes: { x: 1800 },
    });
  } catch (error) {
    geometryBlocked = /已恢复|输出画布/.test(error.message);
  }
  if (!geometryBlocked || sha256File(timeline) !== beforeInvalidSha) {
    throw new Error("out-of-canvas command was not atomically rolled back");
  }
  const driftTimeline = path.join(root, "external-drift.json");
  fs.copyFileSync(timeline, driftTimeline);
  const driftOpened = openEditorProject(driftTimeline);
  const driftValue = readJson(driftTimeline);
  driftValue.visual.overlays[0].x = 260;
  writeJson(driftTimeline, driftValue);
  const driftSha = sha256File(driftTimeline);
  let externalDriftBlocked = false;
  try {
    applyEditorCommand(driftTimeline, {
      schemaVersion: "1.0", kind: "kacha-editor-command",
      baseSha256: driftSha, itemId: "overlay:card-1", changes: { x: 280 },
    });
  } catch (error) {
    externalDriftBlocked = /其他进程修改/.test(error.message);
  }
  if (!externalDriftBlocked || sha256File(driftTimeline) !== driftSha || driftOpened.status !== "pass") {
    throw new Error("caller-supplied current SHA bypassed editor session conflict detection");
  }
  const conflicted = openEditorProject(driftTimeline);
  if (
    conflicted.status !== "conflict"
    || conflicted.session.currentSha256 !== driftOpened.session.currentSha256
    || conflicted.session.timelineSha256 !== driftSha
  ) throw new Error("editor conflict diagnostics collapsed session head into observed Timeline SHA");
  const reopened = reopenEditorProject(driftTimeline, {
    expectedCurrentSha256: driftSha,
    actor: "test",
    reason: "accept intentional external edit",
  });
  if (reopened.status !== "pass" || reopened.project.session.currentSha256 !== driftSha) {
    throw new Error("explicit editor reopen did not accept the current external Timeline state");
  }
  const duplicateIdTimeline = path.join(root, "duplicate-id.json");
  const duplicateValue = readJson(timeline);
  duplicateValue.visual.overlays.push({ ...duplicateValue.visual.overlays[0] });
  writeJson(duplicateIdTimeline, duplicateValue);
  let duplicateIdBlocked = false;
  try { openEditorProject(duplicateIdTimeline); } catch (error) {
    duplicateIdBlocked = /重复 item id/.test(error.message);
  }
  if (!duplicateIdBlocked) throw new Error("duplicate projection item ids were accepted");
  const history = editorHistory(timeline);
  if (history.status !== "pass" || history.records.length !== 3 || !history.records.every((entry) => entry.recordDigest)) {
    throw new Error("valid command journal was not accepted");
  }
  const journal = applied.project.journal;
  if (process.platform !== "win32") {
    const editorStateRoot = path.dirname(journal);
    const sessionState = readJson(path.join(editorStateRoot, "session.json"));
    for (const privateFile of [
      path.join(editorStateRoot, "session.json"),
      sessionState.initialSnapshot.path,
      path.join(editorStateRoot, "recovery.json"),
    ]) {
      if ((fs.statSync(privateFile).mode & 0o777) !== 0o600) {
        throw new Error(`editor private state permissions are too broad: ${privateFile}`);
      }
    }
    const legacyPrivateFiles = [
      path.join(editorStateRoot, "session.json"),
      sessionState.initialSnapshot.path,
      path.join(editorStateRoot, "recovery.json"),
      journal,
    ];
    for (const privateFile of legacyPrivateFiles) fs.chmodSync(privateFile, 0o644);
    openEditorProject(timeline);
    for (const privateFile of legacyPrivateFiles) {
      if ((fs.statSync(privateFile).mode & 0o777) !== 0o600) {
        throw new Error(`legacy editor state permissions were not tightened: ${privateFile}`);
      }
    }
  }
  const originalJournal = fs.readFileSync(journal, "utf8");
  const tampered = originalJournal.split("\n").filter(Boolean).map((line, index) => {
    const record = JSON.parse(line);
    if (index === 0) record.reason = "tampered";
    return JSON.stringify(record);
  }).join("\n") + "\n";
  fs.writeFileSync(journal, tampered);
  if (editorHistory(timeline).chainStatus !== "invalid") throw new Error("journal tamper was not detected");
  const beforeTamperedApply = sha256File(timeline);
  let tamperedApplyBlocked = false;
  try {
    applyEditorCommand(timeline, {
      schemaVersion: "1.0",
      kind: "kacha-editor-command",
      baseSha256: beforeTamperedApply,
      itemId: overlay.id,
      changes: { x: 260 },
    });
  } catch (error) {
    tamperedApplyBlocked = /recordDigest/.test(error.message);
  }
  if (!tamperedApplyBlocked || sha256File(timeline) !== beforeTamperedApply) {
    throw new Error("tampered journal allowed a timeline write before failing");
  }
  fs.writeFileSync(journal, `${originalJournal}{truncated\n`);
  const recovery = editorHistory(timeline);
  if (recovery.status !== "recovery_required" || recovery.truncated !== true) {
    throw new Error("truncated journal did not produce a recovery contract");
  }
  const recovered = recoverEditorProject(timeline, {
    expectedCurrentSha256: sha256File(timeline),
    actor: "test",
    reason: "recover trailing partial journal write",
  });
  if (
    recovered.status !== "pass"
    || !fs.existsSync(recovered.archive)
    || readJson(timeline).visual.overlays[0].x !== 240
    || editorHistory(timeline).status !== "pass"
  ) throw new Error("editor recovery did not restore and re-chain the last valid snapshot");
  const recoveredJournal = recovered.project.journal;
  const lastRecoveredRecord = fs.readFileSync(recoveredJournal, "utf8").trim().split("\n").map(JSON.parse).at(-1);
  const snapshotPath = lastRecoveredRecord.snapshots.after.path;
  const outsideSnapshot = path.join(root, "outside-snapshot.json");
  fs.copyFileSync(snapshotPath, outsideSnapshot);
  fs.unlinkSync(snapshotPath);
  fs.symlinkSync(outsideSnapshot, snapshotPath);
  let escapedSnapshotBlocked = false;
  try {
    recoverEditorProject(timeline, { expectedCurrentSha256: recovered.timelineSha256 });
  } catch (error) {
    escapedSnapshotBlocked = /越出 snapshots/.test(error.message);
  } finally {
    fs.unlinkSync(snapshotPath);
    fs.copyFileSync(outsideSnapshot, snapshotPath);
  }
  if (!escapedSnapshotBlocked) throw new Error("snapshot recovery followed a symlink outside its evidence directory");
}, "editor");

await test("Editor V2 operations keep structural and motion edits journaled and reversible", () => {
  const root = path.join(temporary, "editor-v2-operations");
  fs.mkdirSync(root, { recursive: true });
  const timeline = path.join(root, "timeline.json");
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "editor-v2-operations",
    mode: "preview",
    source: { path: "missing-source.mp4" },
    edl: [
      { id: "a", sourceStart: 0, sourceEnd: 4 },
      { id: "b", sourceStart: 5, sourceEnd: 9 },
    ],
    transitions: [],
    visual: {
      breathing: [],
      overlays: [{
        id: "card", kind: "image", path: "missing.png",
        start: 1, end: 3, x: 10, y: 20, width: 100, height: 80, opacity: 1,
      }],
    },
    audio: { bgm: { segments: [{ id: "music", path: "missing.wav", start: 0, end: 8 }] }, sfx: [] },
    output: { path: "preview.mp4", width: 1280, height: 720, fps: 25 },
  });
  let project = openEditorProject(timeline);
  const command = (body) => {
    const value = applyEditorCommand(timeline, {
      schemaVersion: "1.0",
      kind: "kacha-editor-command",
      baseSha256: project.session.currentSha256,
      actor: "editor-v2-test",
      reason: "exercise typed operation",
      ...body,
    });
    project = value.project;
    return value;
  };
  const frame = project.session.timebase.ticksPerFrame;
  command({ operation: "marker_set", arguments: { marker: { id: "beat", tick: frame * 25, label: "Beat" } } });
  command({ operation: "work_area_set", arguments: { startTick: frame * 10, endTick: frame * 120 } });
  command({ operation: "delivery_frames_set", arguments: { frames: [
    { id: "landscape", label: "16:9", width: 1920, height: 1080 },
    { id: "vertical", label: "9:16", width: 1080, height: 1920 },
  ] } });
  command({ itemId: "overlay:card", operation: "keyframe_set", arguments: { property: "x", tick: frame * 25, value: 40 } });
  command({ itemId: "overlay:card", operation: "keyframe_set", arguments: { property: "x", tick: frame * 50, value: 240 } });
  command({ itemId: "overlay:card", operation: "keyframe_set", arguments: { tick: frame * 60, values: { x: 280, y: 90 } } });
  const atomicKeyframes = readJson(timeline).visual.overlays[0].keyframes;
  if (!atomicKeyframes.x.some((point) => point.tick === frame * 60 && point.value === 280)
    || !atomicKeyframes.y.some((point) => point.tick === frame * 60 && point.value === 90)) {
    throw new Error("atomic x/y keyframe edit did not update both rendered properties");
  }
  for (const invalidTyped of [
    { operation: "marker_set", arguments: { marker: { id: "invalid", tick: frame, label: "x", hiddenPath: "/tmp" } } },
    { operation: "work_area_clear", arguments: { unexpected: true } },
    { itemId: "overlay:card", operation: "keyframe_set", arguments: { property: "x", value: 10, values: { x: 20 }, tick: frame * 40 } },
    { operation: "batch", arguments: { edits: [{ itemId: "overlay:card", changes: { x: 5 }, arbitrary: true }] } },
    { operation: "marker_remove", arguments: { id: "beat" }, arbitraryPath: "/tmp" },
  ]) {
    const before = sha256File(timeline);
    let blocked = false;
    try { command(invalidTyped); } catch (error) { blocked = /未知字段|不能混用/.test(error.message); }
    if (!blocked || sha256File(timeline) !== before) throw new Error("typed operation accepted undeclared command or argument fields");
  }
  for (const invalidScalar of [
    { operation: "marker_set", arguments: { marker: { id: { forged: true }, tick: frame, label: "x" } } },
    { operation: "delivery_frames_set", arguments: { frames: [{ id: "bad", width: "640", height: 360 }] } },
    { itemId: "overlay:card", operation: "keyframe_set", arguments: { property: "x", tick: frame * 40, value: "10" } },
    { operation: "marker_set", arguments: { marker: { id: "actor-test", tick: frame, label: "x" } }, actor: { forged: true } },
  ]) {
    const before = sha256File(timeline);
    let blocked = false;
    try { command(invalidScalar); } catch (error) { blocked = /必须是|必须为/.test(error.message); }
    if (!blocked || sha256File(timeline) !== before) throw new Error("typed operation coerced a non-contract scalar value");
  }
  const beforeMove = buildTimelineProjection(timeline).items.find((item) => item.id === "overlay:card");
  command({ operation: "move", arguments: { itemIds: ["overlay:card"], deltaTick: frame * 5 } });
  const afterMove = buildTimelineProjection(timeline).items.find((item) => item.id === "overlay:card");
  if (afterMove.startTick - beforeMove.startTick !== frame * 5) throw new Error("typed move did not preserve duration");
  command({ itemId: "picture:a", operation: "split", arguments: { outputTick: frame * 50, newId: "a-tail" } });
  const splitProjection = buildTimelineProjection(timeline);
  if (!splitProjection.items.some((item) => item.id === "picture:a-tail") || readJson(timeline).edl.length !== 3) {
    throw new Error("typed split did not create a valid EDL segment");
  }
  command({ operation: "reorder", arguments: { itemIds: ["picture:b", "picture:a", "picture:a-tail"] } });
  if (readJson(timeline).edl.map((entry) => entry.id).join(",") !== "b,a,a-tail") throw new Error("explicit EDL reorder failed");
  const operationHistory = editorHistory(timeline);
  if (operationHistory.status !== "pass" || !operationHistory.records.some((entry) => entry.operation === "keyframe_set")) {
    throw new Error("operation identity was not retained in the Command Journal");
  }
  const binRoot = path.join(root, "assets");
  fs.mkdirSync(binRoot, { recursive: true });
  const targetAsset = path.join(binRoot, "target.png");
  fs.writeFileSync(targetAsset, "project-bin-exact-target");
  const targetIdentity = fileIdentity(targetAsset);
  const makeAsset = (id) => ({
    id, ref: `@asset:${id}`, kind: "image", path: targetAsset, identity: targetIdentity,
    fields: { filename: `${id}.png` }, license: "owned",
    provenance: { kind: "owned_local", evidence: "test-attestation", externalUpload: false },
  });
  const mediaIndexFile = path.join(root, ".kacha", "media-index.json");
  const mediaIndex = {
    schemaVersion: "1.0", kind: "kacha_media_index", digestVersion: "2", status: "pass",
    root, items: [...Array.from({ length: 120 }, (_, index) => makeAsset(`target-${index}`)), makeAsset("target")],
  };
  mediaIndex.digest = mediaIndexDigest(mediaIndex);
  writeJson(mediaIndexFile, mediaIndex);
  if (resolveIndexedAsset(timeline, { assetRef: "@asset:target" }).ref !== "@asset:target") {
    throw new Error("exact Project Bin resolution was truncated by substring candidates");
  }
  const duplicateRefIndex = readJson(mediaIndexFile);
  duplicateRefIndex.items.push({ ...makeAsset("duplicate"), ref: "@asset:target" });
  duplicateRefIndex.digest = mediaIndexDigest(duplicateRefIndex);
  writeJson(mediaIndexFile, duplicateRefIndex);
  let duplicateRefBlocked = false;
  try { listProjectBin(timeline); } catch (error) { duplicateRefBlocked = /身份、ref 或类型合同无效/.test(error.message); }
  if (!duplicateRefBlocked) throw new Error("Project Bin accepted duplicate asset refs");
  for (const mutate of [
    (value) => { value.items[0].ref = "@asset:wrong-id"; },
    (value) => { value.items[0].license = { forged: true }; },
    (value) => { value.items[0].license = " unknown "; },
    (value) => { value.items[0].provenance.evidence = { forged: true }; },
    (value) => { delete value.items[0].provenance.externalUpload; },
  ]) {
    const invalidIndex = structuredClone(mediaIndex);
    mutate(invalidIndex);
    invalidIndex.digest = mediaIndexDigest(invalidIndex);
    writeJson(mediaIndexFile, invalidIndex);
    let blocked = false;
    try { listProjectBin(timeline); } catch (error) { blocked = /合同无效/.test(error.message); }
    if (!blocked) throw new Error("Project Bin accepted forged ref, license or provenance evidence");
  }
  for (const mutate of [
    (value) => { value.items.at(-1).license = "UNKNOWN"; },
    (value) => { value.items.at(-1).provenance.kind = "Unverified"; },
  ]) {
    const riskIndex = structuredClone(mediaIndex);
    mutate(riskIndex);
    riskIndex.digest = mediaIndexDigest(riskIndex);
    writeJson(mediaIndexFile, riskIndex);
    const listed = listProjectBin(timeline, { exactRef: "@asset:target", limit: 1 });
    if (listed.items[0]?.replacementEligible !== false) throw new Error("Project Bin presented canonical risk evidence as replacement-eligible");
    let blocked = false;
    try { resolveIndexedAsset(timeline, { assetRef: "@asset:target" }); } catch (error) { blocked = /未验证/.test(error.message); }
    if (!blocked) throw new Error("Project Bin canonical risk state bypassed replacement authorization");
  }
  writeJson(mediaIndexFile, mediaIndex);
  const invalidEditorMetadata = path.join(root, "invalid-editor-metadata.json");
  const invalidEditorValue = readJson(timeline);
  invalidEditorValue.editor.markers[0].label = "x".repeat(501);
  writeJson(invalidEditorMetadata, invalidEditorValue);
  let invalidMetadataBlocked = false;
  try { openEditorProject(invalidEditorMetadata); } catch (error) { invalidMetadataBlocked = /editor.markers/.test(error.message); }
  if (!invalidMetadataBlocked) throw new Error("direct Timeline metadata bypassed typed marker string bounds");
  const invalidEditorType = path.join(root, "invalid-editor-type.json");
  const invalidEditorTypeValue = readJson(timeline);
  invalidEditorTypeValue.editor.markers[0].id = { forged: true };
  writeJson(invalidEditorType, invalidEditorTypeValue);
  let invalidMetadataTypeBlocked = false;
  try { openEditorProject(invalidEditorType); } catch (error) { invalidMetadataTypeBlocked = /editor.markers/.test(error.message); }
  if (!invalidMetadataTypeBlocked) throw new Error("direct Timeline metadata coerced an object marker id");
  const invalidKeyframeType = path.join(root, "invalid-keyframe-type.json");
  const invalidKeyframeTypeValue = readJson(timeline);
  invalidKeyframeTypeValue.visual.overlays[0].keyframes.x[0].value = "40";
  writeJson(invalidKeyframeType, invalidKeyframeTypeValue);
  let invalidKeyframeTypeBlocked = false;
  try { openEditorProject(invalidKeyframeType); } catch (error) { invalidKeyframeTypeBlocked = /keyframes.x/.test(error.message); }
  if (!invalidKeyframeTypeBlocked) throw new Error("direct Timeline metadata coerced a string keyframe value");
  const beforeInvalid = sha256File(timeline);
  let transitionBlocked = false;
  const withTransition = readJson(timeline);
  withTransition.transitions = [{ boundaryIndex: 0, effectId: "micro_fade", durationFrames: 2 }];
  withTransition.audio.bgm.segments[0].end = 8 - 2 / 25;
  writeJson(timeline, withTransition);
  const driftSha = sha256File(timeline);
  reopenEditorProject(timeline, { expectedCurrentSha256: driftSha, actor: "test", reason: "add transition boundary" });
  project = openEditorProject(timeline);
  try {
    command({ operation: "reorder", arguments: { itemIds: ["picture:a", "picture:b", "picture:a-tail"] } });
  } catch (error) {
    transitionBlocked = /已执行转场/.test(error.message);
  }
  if (!transitionBlocked || sha256File(timeline) !== driftSha || beforeInvalid === driftSha) {
    throw new Error("structural edit bypassed executed transition safety");
  }
  if (editorHistory(timeline).status !== "pass") throw new Error("reopened operation history is invalid");
}, "editor");

await test("Preview Provider gate keeps approximate Canvas and unimplemented WebGPU out of final", () => {
  const providers = listPreviewProviders();
  if (
    providers.providers.find((item) => item.id === "ffmpeg-render-graph")?.finalEligible !== true
    || providers.providers.find((item) => item.id === "studio-canvas")?.finalEligible !== false
    || providers.providers.find((item) => item.id === "webgpu")?.status !== "not_implemented"
  ) throw new Error("preview provider registry overclaimed implementation or parity");
  const canonical = assertPreviewProviderEligibility("ffmpeg-render-graph", { purpose: "final" });
  if (canonical.runtime?.status !== "available") throw new Error("canonical provider skipped its runtime probe");
  assertPreviewProviderEligibility("studio-canvas", { purpose: "preview" });
  let finalBlocked = false;
  try {
    assertPreviewProviderEligibility("studio-canvas", { purpose: "final" });
  } catch (error) {
    finalBlocked = /禁止用于 final/.test(error.message);
  }
  if (!finalBlocked) throw new Error("approximate provider was accepted for final");
  let invalidPurposeBlocked = false;
  try { assertPreviewProviderEligibility("ffmpeg-render-graph", { purpose: "publish" }); } catch (error) {
    invalidPurposeBlocked = /未知 preview purpose/.test(error.message);
  }
  if (!invalidPurposeBlocked) throw new Error("unknown preview purpose was accepted");
}, "editor");

await test("Studio editor session supports open apply undo redo without arbitrary write paths", async () => {
  if (!editorSessionExpired({ openedAtMs: 1 }, 12 * 60 * 60 * 1000 + 2)
    || editorSessionExpired({ openedAtMs: 1000 }, 1001)) {
    throw new Error("Editor SSE session expiry predicate is incorrect");
  }
  const root = path.join(temporary, "studio-editor-api");
  fs.mkdirSync(root, { recursive: true });
  const timeline = path.join(root, "timeline.json");
  const sourceMedia = path.join(root, "source.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x20252b:s=320x180:d=8",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-shortest", "-c:v", "libx264", "-c:a", "aac", sourceMedia,
  ]);
  const assetRoot = path.join(root, "assets");
  fs.mkdirSync(path.join(root, ".kacha"), { recursive: true });
  fs.mkdirSync(assetRoot, { recursive: true });
  const indexedAsset = path.join(assetRoot, "owned-card.png");
  execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0xd59a52:s=64x64:d=0.1", "-frames:v", "1", indexedAsset]);
  const mediaCatalog = path.join(root, "media-catalog.json");
  writeJson(mediaCatalog, { entries: [{ path: "assets/owned-card.png", license: "owned", provenance: { kind: "owned_local", evidence: "test-owner-attestation", externalUpload: false } }] });
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "media", "index", "--root", root, "--catalog", mediaCatalog, "--output", path.join(root, ".kacha", "media-index.json")]);
  const outsideIndexedAsset = path.join(temporary, "studio-editor-outside.png");
  fs.copyFileSync(indexedAsset, outsideIndexedAsset);
  const indexFile = path.join(root, ".kacha", "media-index.json");
  const indexValue = readJson(indexFile);
  const indexedCard = indexValue.items.find((entry) => path.basename(entry.path) === path.basename(indexedAsset));
  if (!indexedCard) throw new Error("synthetic indexed card is missing");
  indexValue.items.push({
    ...structuredClone(indexedCard),
    id: "outside-card",
    ref: "@asset:outside-card",
    path: outsideIndexedAsset,
    identity: fileIdentity(outsideIndexedAsset),
  });
  indexValue.digest = mediaIndexDigest(indexValue);
  writeJson(indexFile, indexValue);
  writeJson(timeline, {
    schemaVersion: "1.0",
    projectId: "studio-editor-api",
    mode: "preview",
    source: { path: "source.mp4", sha256: sha256File(sourceMedia) },
    edl: [{ id: "main", sourceStart: 0, sourceEnd: 8 }],
    visual: { overlays: [{ id: "card", kind: "image", path: "missing.png", start: 1, end: 3, x: 10, y: 10, width: 100, height: 80, opacity: 1 }] },
    audio: { sfx: [] },
    output: { path: "preview.mp4", width: 1280, height: 720, fps: 25 },
  });
  const port = 48000 + (process.pid % 1000);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    path.join(scripts, "kacha_studio_server.mjs"), "--port", String(port), "--no-open",
  ], { cwd: skillDirectory, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { ready = (await fetch(`${origin}/api/health`)).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`studio editor server did not start\n${stderr}`);
    const page = await fetch(`${origin}/editor`);
    const html = await page.text();
    if (!page.ok || !html.includes("APPROXIMATE PREVIEW") || !html.includes("Timeline Projection")) {
      throw new Error("editor surface is missing its preview boundary or timeline UI");
    }
    const headers = { "content-type": "application/json", "x-kacha-studio": "1", origin };
    const openedResponse = await fetch(`${origin}/api/editor/open`, {
      method: "POST", headers, body: JSON.stringify({ timelinePath: timeline }),
    });
    const opened = await openedResponse.json();
    const item = opened.projection?.items?.find((candidate) => candidate.id === "overlay:card");
    if (!openedResponse.ok || !opened.browserSessionId || !item) throw new Error(`editor open failed: ${JSON.stringify(opened)}`);
    if (
      opened.projection.timeline.sourceSha256 !== sha256File(sourceMedia)
      || opened.projection.timeline.sourceIdentity?.sha256 !== sha256File(sourceMedia)
    ) throw new Error("Studio open omitted the declared source media integrity verification");
    const invalidEvents = await fetch(`${origin}/api/editor/events?session=${encodeURIComponent(opened.browserSessionId)}`, { headers: { origin: "https://attacker.invalid" } });
    if (invalidEvents.ok) throw new Error("cross-origin editor event stream was accepted");
    const eventsResponse = await fetch(`${origin}/api/editor/events?session=${encodeURIComponent(opened.browserSessionId)}`, { headers: { origin } });
    if (!eventsResponse.ok || !String(eventsResponse.headers.get("content-type")).startsWith("text/event-stream")) throw new Error("editor event stream did not open");
    const eventsReader = eventsResponse.body.getReader();
    const initialEvent = Buffer.from((await eventsReader.read()).value ?? []).toString("utf8");
    if (!initialEvent.includes("kacha-editor-revision") || !initialEvent.includes("connected")) throw new Error("editor event stream omitted its canonical initial revision");
    const mediaResponse = await fetch(
      `${origin}/api/editor/media?session=${encodeURIComponent(opened.browserSessionId)}`,
      { headers: { range: "bytes=0-4" } },
    );
    if (mediaResponse.status !== 206 || Buffer.from(await mediaResponse.arrayBuffer()).length !== 5) {
      throw new Error("editor source media session did not stream the identity-bound byte range");
    }
    const waveformResponse = await fetch(`${origin}/api/editor/waveform?session=${encodeURIComponent(opened.browserSessionId)}&width=320`, { headers: { origin } });
    const waveform = Buffer.from(await waveformResponse.arrayBuffer());
    if (!waveformResponse.ok || waveform.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("bounded editor waveform endpoint did not return PNG evidence");
    const concurrentWaveforms = await Promise.all([321, 322, 323].map((width) => fetch(`${origin}/api/editor/waveform?session=${encodeURIComponent(opened.browserSessionId)}&width=${width}`, { headers: { origin } })));
    if (!concurrentWaveforms.some((response) => response.status === 429) || concurrentWaveforms.filter((response) => response.ok).length > 2) {
      throw new Error(`waveform concurrency was not bounded: ${concurrentWaveforms.map((response) => response.status).join(",")}`);
    }
    await Promise.all(concurrentWaveforms.map((response) => response.arrayBuffer()));
    const binResponse = await fetch(`${origin}/api/editor/bin`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: opened.browserSessionId, query: "owned-card" }),
    });
    const projectBin = await binResponse.json();
    const binEvidence = projectBin.items?.[0]?.provenance?.evidence;
    if (!binResponse.ok || projectBin.items?.[0]?.license !== "owned" || projectBin.outsideRootExcluded !== 1 || projectBin.items.some((entry) => entry.path === outsideIndexedAsset) || !(Array.isArray(binEvidence) ? binEvidence : [binEvidence]).includes("test-owner-attestation")) {
      throw new Error(`Project Bin omitted current license/provenance evidence: ${JSON.stringify(projectBin)}`);
    }
    const commandResponse = await fetch(`${origin}/api/editor/command`, {
      method: "POST", headers, body: JSON.stringify({
        sessionId: opened.browserSessionId,
        command: {
          schemaVersion: "1.0", kind: "kacha-editor-command",
          baseSha256: opened.session.currentSha256, itemId: item.id,
          changes: { x: 88 }, actor: "studio-test", reason: "journey",
        },
      }),
    });
    const command = await commandResponse.json();
    if (!commandResponse.ok || readJson(timeline).visual.overlays[0].x !== 88) {
      throw new Error(`editor command API failed: ${JSON.stringify(command)}`);
    }
    let mutationEvent = "";
    for (let attempt = 0; attempt < 4 && !mutationEvent.includes('"reason":"command"'); attempt += 1) {
      const chunk = await Promise.race([
        eventsReader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("editor event timeout")), 2500)),
      ]);
      mutationEvent += Buffer.from(chunk.value ?? []).toString("utf8");
    }
    if (!mutationEvent.includes(command.timelineSha256) || !mutationEvent.includes('"reason":"command"')) throw new Error("editor command did not emit its SHA revision event");
    const staleUndo = await fetch(`${origin}/api/editor/undo`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: opened.browserSessionId, baseSha256: opened.session.currentSha256 }),
    });
    if (staleUndo.ok || readJson(timeline).visual.overlays[0].x !== 88) throw new Error("stale Studio undo mutated current history");
    let historySha = command.timelineSha256;
    for (const action of ["undo", "redo"]) {
      const response = await fetch(`${origin}/api/editor/${action}`, {
        method: "POST", headers, body: JSON.stringify({ sessionId: opened.browserSessionId, baseSha256: historySha }),
      });
      const value = await response.json();
      if (!response.ok || value.status !== "pass") throw new Error(`editor ${action} API failed`);
      historySha = value.timelineSha256;
    }
    if (readJson(timeline).visual.overlays[0].x !== 88) throw new Error("editor HTTP redo did not restore command");
    const beforeSourceDriftSha = sha256File(timeline);
    fs.appendFileSync(sourceMedia, Buffer.from([0]));
    const staleWaveform = await fetch(`${origin}/api/editor/waveform?session=${encodeURIComponent(opened.browserSessionId)}&width=320`, { headers: { origin } });
    if (staleWaveform.status !== 409 || !(await staleWaveform.text()).includes("源媒体身份已变化")) {
      throw new Error("cached waveform bypassed the opened source identity");
    }
    let sourceDriftEvent = "";
    for (let attempt = 0; attempt < 4 && !sourceDriftEvent.includes('"reason":"source_identity_changed"'); attempt += 1) {
      const chunk = await Promise.race([
        eventsReader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("source drift event timeout")), 2500)),
      ]);
      sourceDriftEvent += Buffer.from(chunk.value ?? []).toString("utf8");
    }
    if (!sourceDriftEvent.includes('"reason":"source_identity_changed"') || !sourceDriftEvent.includes('"conflict":true')) {
      throw new Error("source identity drift did not emit a terminal editor conflict revision");
    }
    const driftProjectResponse = await fetch(`${origin}/api/editor/project`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: opened.browserSessionId }),
    });
    const driftProject = await driftProjectResponse.json();
    if (!driftProjectResponse.ok || driftProject.status !== "conflict" || driftProject.sourceIntegrity?.reason !== "source_identity_changed") {
      throw new Error("Editor project readback did not disclose source identity drift");
    }
    for (const [endpoint, body] of [
      ["command", { command: { schemaVersion: "1.0", kind: "kacha-editor-command", baseSha256: historySha, itemId: item.id, changes: { x: 89 }, actor: "studio-test", reason: "must block after source drift" } }],
      ["undo", { baseSha256: historySha }],
      ["redo", { baseSha256: historySha }],
    ]) {
      const response = await fetch(`${origin}/api/editor/${endpoint}`, {
        method: "POST", headers, body: JSON.stringify({ sessionId: opened.browserSessionId, ...body }),
      });
      if (response.status !== 409 || !(await response.text()).includes("源媒体身份已变化") || sha256File(timeline) !== beforeSourceDriftSha) {
        throw new Error(`Editor ${endpoint} mutated or proceeded after source identity drift`);
      }
    }
    const staleOpenResponse = await fetch(`${origin}/api/editor/open`, {
      method: "POST", headers, body: JSON.stringify({ timelinePath: timeline }),
    });
    if (staleOpenResponse.ok || !(await staleOpenResponse.text()).includes("source.sha256 已失效")) {
      throw new Error("Studio reopened a Timeline whose declared source digest was stale");
    }
    const forged = await fetch(`${origin}/api/editor/command`, {
      method: "POST", headers, body: JSON.stringify({
        sessionId: "forged-session",
        timelinePath: path.join(root, "other.json"),
        command: { schemaVersion: "1.0", kind: "kacha-editor-command", itemId: item.id, changes: { x: 1 } },
      }),
    });
    if (forged.ok || fs.existsSync(path.join(root, "other.json"))) throw new Error("forged editor session escaped its bound timeline");
    await eventsReader.cancel();
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}, "editor");

await test("capability broker enforces hard exclusions before explainable ranking", () => {
  const validated = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "capabilities", "validate",
  ]).stdout);
  if (validated.providers < 5 || !validated.digest) throw new Error("provider registry validation is incomplete");
  const ranked = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "capabilities", "rank",
    "--capability", "video-compose", "--modes", "series",
    "--local-only", "--require-known-cost",
  ]).stdout);
  const external = ranked.alternatives.find((item) => item.providerId === "minimax-external");
  if (
    ranked.chosenProviderId !== "ffmpeg-local"
    || !ranked.alternatives.every((item) => item.dimensions && Array.isArray(item.exclusions) && item.evidenceFreshness?.status === "current")
    || external?.eligible !== false
    || !external.exclusions.includes("external_upload_not_authorized")
    || !external.exclusions.includes("cost_unknown")
  ) throw new Error("capability broker bypassed a hard gate or omitted its evidence");
  const customRegistry = path.join(temporary, "custom-provider-registry.json");
  fs.copyFileSync(path.join(skillDirectory, "config", "capabilities", "provider-registry.json"), customRegistry);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "capabilities", "validate", "--registry", customRegistry]);
  expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "capabilities", "probe", "--registry", customRegistry]);
  const malformed = readJson(customRegistry);
  malformed.providers[0].sideEffects = "local-files";
  malformed.providers[0].runtime.probeArgs = "-version";
  writeJson(customRegistry, malformed);
  const malformedResult = expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "capabilities", "validate", "--registry", customRegistry]);
  if (!malformedResult.stderr.includes("sideEffects") || !malformedResult.stderr.includes("probeArgs")) throw new Error("provider registry accepted malformed executable fields");
  fs.writeFileSync(customRegistry, "null\n");
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "capabilities", "validate", "--registry", customRegistry]).stderr.includes("root must be an object")) throw new Error("provider registry null root was not rejected cleanly");
}, "core");

await test("cost ledger locks budget through reserve approve reconcile and refund", () => {
  const root = path.join(temporary, "cost-ledger-project");
  fs.mkdirSync(root, { recursive: true });
  expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "init", "--project-root", path.join(temporary, "missing-budget")]);
  expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "init", "--project-root", path.join(temporary, "invalid-currency"), "--budget", "100", "--currency", "cny"]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "init", "--project-root", root, "--budget", "100", "--approval-threshold", "50"]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "reserve", "--project-root", root, "--id", "small", "--provider", "ffmpeg-local", "--capability", "video-compose", "--amount", "10"]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "reconcile", "--project-root", root, "--id", "small", "--actual", "8"]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "refund", "--project-root", root, "--id", "small", "--amount", "2"]);
  const large = JSON.parse(execute(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "reserve", "--project-root", root, "--id", "large", "--provider", "metered", "--capability", "video-generation", "--amount", "60"]).stdout);
  if (large.entry.status !== "pending_approval") throw new Error("approval threshold was not enforced");
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "reconcile", "--project-root", root, "--id", "large", "--actual", "60"]).stderr.includes("requires reserved, approved or reconciliation_required")) throw new Error("unapproved cost was not blocked");
  if (fs.existsSync(path.join(root, ".kacha", "cost-ledger.json.lock"))) throw new Error("failed cost transition leaked its operation lock");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "approve", "--project-root", root, "--id", "large", "--evidence", "test-approval"]);
  const status = JSON.parse(execute(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "status", "--project-root", root]).stdout);
  if (status.totals.available !== 34 || status.totals.netSpent !== 6) throw new Error("cost totals are not reconciled");
  const malformedLedgerFile = path.join(temporary, "malformed-cost-ledger.json");
  const malformedLedger = readJson(path.join(root, ".kacha", "cost-ledger.json"));
  malformedLedger.kind = "forged-ledger";
  malformedLedger.entries.push(null);
  writeJson(malformedLedgerFile, malformedLedger);
  const malformedResult = expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "validate", "--ledger", malformedLedgerFile]);
  if (!malformedResult.stderr.includes("kind must be kacha-cost-ledger") || !malformedResult.stderr.includes("must be an object")) throw new Error("cost ledger validation accepted malformed identity or entries");
  const intentDigest = "a".repeat(64);
  const consumed = JSON.parse(execute(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "consume", "--project-root", root, "--id", "large", "--provider", "metered", "--capability", "video-generation", "--execution-id", "exec-1", "--intent-digest", intentDigest]).stdout);
  if (consumed.entry.status !== "reconciliation_required" || consumed.entry.executionId !== "exec-1") throw new Error("cost reservation was not atomically consumed");
  const replay = expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "consume", "--project-root", root, "--id", "large", "--provider", "metered", "--capability", "video-generation", "--execution-id", "exec-2", "--intent-digest", intentDigest]);
  if (!replay.stderr.includes("unused reserved or approved")) throw new Error("a consumed cost reservation could be replayed");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "reconcile", "--project-root", root, "--id", "large", "--actual", "60"]);
  expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "reserve", "--project-root", root, "--provider", "metered", "--capability", "video-generation", "--amount", "35"]);
  const ledgerFile = path.join(root, ".kacha", "cost-ledger.json");
  const tampered = readJson(ledgerFile);
  tampered.entries.find((entry) => entry.id === "small").refundAmount = 999;
  writeJson(ledgerFile, tampered);
  const tamperedResult = expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "cost", "validate", "--project-root", root]);
  if (!tamperedResult.stderr.includes("refundAmount exceeds actualAmount")) throw new Error("cost ledger validation accepted forged refund credit");
}, "core");

await test("reference intelligence freezes rights and forbids shot for shot derivation", () => {
  const media = path.join(skillDirectory, "design", "reference-gallery", "xingzhe-v3", "normal-speed-previews", "info_single.mp4");
  const rhythmMedia = path.join(temporary, "rhythm-reference.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=4",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", rhythmMedia,
  ]);
  const rhythmEvidence = path.join(temporary, "rhythm-evidence.json");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "rhythm", "analyze", "--input", rhythmMedia, "--output", rhythmEvidence, "--max-events", "40"]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "rhythm", "validate", "--input", rhythmEvidence]);
  const rhythmValue = readJson(rhythmEvidence);
  if (
    rhythmValue.claims.semanticUnderstanding !== false
    || rhythmValue.claims.beatGridIsAuthoritative !== false
    || !Array.isArray(rhythmValue.audio.bpmCandidates)
    || !rhythmValue.source.identity.sha256
  ) throw new Error("technical rhythm evidence overclaimed semantics or omitted strong identity");
  const rhythmAnalysis = path.join(temporary, "rhythm-reference-analysis.json");
  const rhythmPlan = path.join(temporary, "rhythm-reference-plan.json");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "analyze", "--input", rhythmMedia, "--output", rhythmAnalysis, "--rights-status", "owned", "--rhythm-evidence", rhythmEvidence]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "derive", "--analysis", rhythmAnalysis, "--output", rhythmPlan]);
  if (readJson(rhythmPlan).technicalRhythmEvidence?.evidenceDigest !== rhythmValue.evidenceDigest) throw new Error("derived reference plan lost its approved technical rhythm evidence binding");
  const malformedRhythm = readJson(rhythmEvidence);
  malformedRhythm.audio.bpmCandidates = [{ bpm: 999, confidence: 2 }];
  delete malformedRhythm.evidenceDigest;
  malformedRhythm.evidenceDigest = sha256Value(malformedRhythm);
  const malformedRhythmFile = path.join(temporary, "malformed-rhythm-evidence.json");
  writeJson(malformedRhythmFile, malformedRhythm);
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "rhythm", "validate", "--input", malformedRhythmFile]).stderr.includes("invalid bpm or confidence")) {
    throw new Error("rhythm validation accepted out-of-contract technical candidates");
  }
  const droppedRhythmPlan = readJson(rhythmPlan);
  delete droppedRhythmPlan.technicalRhythmEvidence;
  delete droppedRhythmPlan.planDigest;
  droppedRhythmPlan.planDigest = sha256Value(droppedRhythmPlan);
  const droppedRhythmPlanFile = path.join(temporary, "rhythm-plan-without-binding.json");
  writeJson(droppedRhythmPlanFile, droppedRhythmPlan);
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "validate", "--input", droppedRhythmPlanFile]).stderr.includes("preserve the approved analysis rhythm evidence")) {
    throw new Error("reference validation allowed a derived plan to drop approved rhythm evidence");
  }
  const analysis = path.join(temporary, "reference-analysis.json");
  const plan = path.join(temporary, "reference-plan.json");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "analyze", "--input", media, "--output", analysis, "--rights-status", "owned", "--keep", "editorial hierarchy", "--change", "replace every shot"]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "derive", "--analysis", analysis, "--output", plan, "--show", "工具分享"]);
  const value = readJson(plan);
  if (value.originality.shotForShotCopyAllowed !== false || !value.translation.doNotCopy.includes("exact shots")) throw new Error("originality boundary is missing");
  const digestlessAnalysis = readJson(analysis);
  delete digestlessAnalysis.analysisDigest;
  const digestlessAnalysisFile = path.join(temporary, "reference-analysis-without-digest.json");
  writeJson(digestlessAnalysisFile, digestlessAnalysis);
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "validate", "--input", digestlessAnalysisFile]).stderr.includes("analysisDigest is required")) throw new Error("reference validation accepted an artifact without its integrity digest");
  const digestlessPlan = readJson(plan);
  delete digestlessPlan.planDigest;
  const digestlessPlanFile = path.join(temporary, "reference-plan-without-digest.json");
  writeJson(digestlessPlanFile, digestlessPlan);
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "validate", "--input", digestlessPlanFile]).stderr.includes("planDigest is required")) throw new Error("reference plan validation accepted an artifact without its integrity digest");
  const unknown = path.join(temporary, "reference-unknown.json");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "analyze", "--input", media, "--output", unknown]);
  expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "derive", "--analysis", unknown, "--output", path.join(temporary, "must-not-exist.json")]);
  const licensed = path.join(temporary, "reference-licensed.json");
  const licensedResult = JSON.parse(execute(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "analyze", "--input", media, "--output", licensed, "--rights-status", "licensed", "--permitted-use", "principle-derivation"]).stdout);
  if (licensedResult.status !== "limited") throw new Error("licensed reference without evidence was marked derivation-ready");
  expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "derive", "--analysis", licensed, "--output", path.join(temporary, "unlicensed-plan.json")]);
  const copiedMedia = path.join(temporary, "reference-copy.mp4");
  fs.copyFileSync(media, copiedMedia);
  const copiedAnalysis = path.join(temporary, "reference-copy-analysis.json");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "analyze", "--input", copiedMedia, "--output", copiedAnalysis, "--rights-status", "owned"]);
  fs.appendFileSync(copiedMedia, "identity-changed");
  const staleReference = expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "validate", "--input", copiedAnalysis]);
  if (!staleReference.stderr.includes("source identity is stale")) throw new Error("reference validation accepted changed source media");
  const nullReference = path.join(temporary, "null-reference.json");
  fs.writeFileSync(nullReference, "null\n");
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "reference", "validate", "--input", nullReference]).stderr.includes("root must be an object")) throw new Error("reference null root was not rejected cleanly");
}, "core");

await test("production flight recorder normalizes sources without exposing raw payloads", () => {
  const root = path.join(temporary, "flight-project");
  fs.mkdirSync(path.join(root, ".kacha", "metrics"), { recursive: true });
  fs.writeFileSync(path.join(root, ".kacha", "project-events.jsonl"), `${JSON.stringify({ at: "2026-01-01T00:00:02Z", type: "stage_complete", status: "pass", message: { ["api" + "Key"]: "flight-secret-value", ["pass" + "word"]: "nested-secret-value" } })}\n`);
  fs.writeFileSync(path.join(root, ".kacha", "metrics", "events.jsonl"), `${JSON.stringify({ eventId: "m1", stage: "render", status: "pass", timing: { startedAt: "2026-01-01T00:00:01Z" }, command: ["secret-value"] })}\n`);
  const output = path.join(temporary, "flight.json");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "flight", "snapshot", "--project-root", root, "--output", output]);
  const flight = readJson(output);
  if (flight.events.length !== 2 || flight.events[0].source !== "telemetry" || JSON.stringify(flight).includes("flight-secret-value") || JSON.stringify(flight).includes("nested-secret-value") || !JSON.stringify(flight).includes("[REDACTED]")) throw new Error("flight normalization leaked or misordered evidence");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "flight", "validate", "--input", output]);
  const outside = path.join(temporary, "outside-flight-decisions");
  fs.mkdirSync(outside);
  writeJson(path.join(outside, "secret.json"), { decidedAt: "2026-01-01T00:00:03Z", kind: "outside", request: { capability: "must-not-read" } });
  fs.symlinkSync(outside, path.join(root, ".kacha", "decisions"));
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "flight", "snapshot", "--project-root", root, "--output", output]);
  const symlinkSafe = readJson(output);
  if (JSON.stringify(symlinkSafe).includes("must-not-read") || !symlinkSafe.limitations.some((item) => item.includes("symlink_directory_rejected"))) throw new Error("flight recorder followed an out-of-project symlink");
  fs.writeFileSync(output, "null\n");
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "flight", "validate", "--input", output]).stderr.includes("root must be an object")) throw new Error("flight null root was not rejected cleanly");
}, "core");

await test("media corpus exposes keyword fallback motion evidence and MMR diversity", () => {
  const root = path.join(skillDirectory, "design", "reference-gallery", "xingzhe-v3", "normal-speed-previews");
  const index = path.join(temporary, "corpus-media-index.json");
  const corpus = path.join(temporary, "media-corpus.json");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "media", "index", "--root", root, "--output", index]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "corpus", "build", "--index", index, "--output", corpus, "--clip-seconds", "5"]);
  const search = JSON.parse(execute(process.execPath, [path.join(scripts, "kacha.mjs"), "corpus", "search", "--input", corpus, "--query", "info", "--limit", "4"]).stdout);
  if (search.retrievalMode !== "keyword_fallback" || search.results.length < 1 || search.diversity.method !== "MMR" || search.results.some((item) => item.motion.status !== "unavailable")) throw new Error("corpus search overclaimed semantics or omitted diversity/motion state");
  const digestlessCorpus = readJson(corpus);
  delete digestlessCorpus.digest;
  const digestlessCorpusFile = path.join(temporary, "media-corpus-without-digest.json");
  writeJson(digestlessCorpusFile, digestlessCorpus);
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "corpus", "validate", "--input", digestlessCorpusFile]).stderr.includes("corpus digest is required")) throw new Error("corpus validation accepted an artifact without its integrity digest");
  const staleRoot = path.join(temporary, "stale-corpus-media");
  fs.mkdirSync(staleRoot);
  const source = path.join(staleRoot, "info.mp4");
  fs.copyFileSync(path.join(root, "info_single.mp4"), source);
  const staleIndex = path.join(temporary, "stale-corpus-index.json");
  const staleCorpus = path.join(temporary, "stale-corpus.json");
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "media", "index", "--root", staleRoot, "--output", staleIndex]);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "corpus", "build", "--index", staleIndex, "--output", staleCorpus]);
  fs.appendFileSync(source, "identity-changed");
  const staleValidation = expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "corpus", "validate", "--input", staleCorpus]);
  if (!staleValidation.stderr.includes("source file identity is stale")) throw new Error("corpus validation accepted a changed source file");
  expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "corpus", "build", "--index", staleIndex, "--output", staleCorpus]);
  const nullCorpus = path.join(temporary, "null-corpus.json");
  fs.writeFileSync(nullCorpus, "null\n");
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "corpus", "validate", "--input", nullCorpus]).stderr.includes("root must be an object")) throw new Error("corpus null root was not rejected cleanly");
}, "core");

await test("composition router records explicit series choice and blocks unavailable hero engine", () => {
  const series = JSON.parse(execute(process.execPath, [path.join(scripts, "kacha.mjs"), "composition", "route", "--mode", "series", "--requires", "video-compose"]).stdout);
  if (series.chosenEngine !== "ffmpeg-local" || series.silentFallbackAllowed !== false) throw new Error("series engine decision is not explicit");
  const hero = run(process.execPath, [path.join(scripts, "kacha.mjs"), "composition", "route", "--mode", "hero", "--requires", "video-compose,motion-graphics"], { cwd: temporary });
  const heroDecision = JSON.parse(hero.stdout || hero.stderr);
  if (hero.status === 0) {
    const chosen = heroDecision.alternatives.find((item) => item.providerId === heroDecision.chosenEngine);
    if (!chosen?.eligible || chosen.probe?.available !== true || chosen.exclusions.length) throw new Error("hero route selected an engine without current capability evidence");
  } else if (heroDecision.status !== "blocked" || heroDecision.chosenEngine !== null) {
    throw new Error("unavailable hero engine was silently substituted");
  }
  const tampered = structuredClone(series);
  tampered.chosenEngine = "minimax-external";
  tampered.engineHandoff.providerId = "minimax-external";
  delete tampered.output;
  delete tampered.decisionDigest;
  tampered.decisionDigest = sha256Value(tampered);
  const tamperedFile = path.join(temporary, "tampered-composition-decision.json");
  writeJson(tamperedFile, tampered);
  const tamperedResult = expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "composition", "validate", "--input", tamperedFile]);
  if (!tamperedResult.stderr.includes("eligible exclusion-free")) throw new Error("composition validation accepted an ineligible chosen engine");
  const digestless = structuredClone(series);
  delete digestless.output;
  delete digestless.decisionDigest;
  const digestlessFile = path.join(temporary, "composition-decision-without-digest.json");
  writeJson(digestlessFile, digestless);
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "composition", "validate", "--input", digestlessFile]).stderr.includes("decisionDigest is required")) throw new Error("composition validation accepted a decision without its integrity digest");
  fs.writeFileSync(digestlessFile, "null\n");
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "composition", "validate", "--input", digestlessFile]).stderr.includes("root must be an object")) throw new Error("composition null root was not rejected cleanly");
}, "core");

await test("workflow packs validate and resolve through existing Kacha commands", () => {
  const registry = JSON.parse(execute(process.execPath, [path.join(scripts, "kacha.mjs"), "workflows", "validate"]).stdout);
  if (registry.packs !== 5) throw new Error("expected five workflow packs");
  const variables = path.join(temporary, "workflow-vars.json");
  const output = path.join(temporary, "workflow-instance.json");
  writeJson(variables, {
    REFERENCE_VIDEO: "/tmp/reference.mp4",
    RIGHTS_STATUS: "owned",
    RIGHTS_EVIDENCE: "owner-attestation:test",
    PERMITTED_USE: "principle-derivation",
    ANALYSIS_JSON: "/tmp/analysis.json",
    DERIVED_PLAN_JSON: "/tmp/plan.json",
    BRIEF_JSON: "/tmp/brief.json"
  });
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "workflows", "resolve", "--pack", "reference-to-original", "--vars", variables, "--output", output]);
  const instance = readJson(output);
  if (instance.status !== "ready" || instance.unresolved.length || instance.steps.some((step) => !step.command.startsWith("kacha "))) throw new Error("workflow pack did not resolve into an auditable Kacha checklist");
  const hostileVariables = readJson(variables);
  hostileVariables.REFERENCE_VIDEO = "/tmp/reference.mp4'; touch /tmp/forbidden; echo '";
  writeJson(variables, hostileVariables);
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "workflows", "resolve", "--pack", "reference-to-original", "--vars", variables, "--output", output]);
  const quoted = readJson(output).steps[0].command;
  if (!quoted.includes(`'"'"'`) || quoted.includes("--input /tmp/reference")) throw new Error("workflow variable was not safely shell quoted");
  const structuredVariables = readJson(variables);
  structuredVariables.REFERENCE_VIDEO = { path: "/tmp/reference.mp4" };
  writeJson(variables, structuredVariables);
  const structuredFailure = expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "workflows", "resolve", "--pack", "reference-to-original", "--vars", variables, "--output", output]);
  if (!structuredFailure.stderr.includes("single-line scalar")) throw new Error("workflow resolver accepted a structured command variable");
  writeJson(variables, hostileVariables);
  const customRegistry = path.join(temporary, "custom-workflows.json");
  fs.copyFileSync(path.join(skillDirectory, "config", "workflow-packs.json"), customRegistry);
  expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "workflows", "resolve", "--registry", customRegistry, "--pack", "reference-to-original", "--vars", variables, "--output", output]);
  const injectedRegistry = readJson(customRegistry);
  injectedRegistry.packs[0].steps[0].command += "; touch /tmp/forbidden";
  writeJson(customRegistry, injectedRegistry);
  const injectedFailure = expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "workflows", "validate", "--registry", customRegistry]);
  if (!injectedFailure.stderr.includes("shell control operators")) throw new Error("workflow registry accepted a shell-control operator");
  fs.writeFileSync(customRegistry, "null\n");
  if (!expectFailure(process.execPath, [path.join(scripts, "kacha.mjs"), "workflows", "validate", "--registry", customRegistry]).stderr.includes("root must be an object")) throw new Error("workflow registry null root was not rejected cleanly");
}, "core");

await test("Editor V3 workspace capability map ripple overwrite and delivery contracts remain honest and reversible", () => {
  ensureMediaFixtures();
  const root = path.join(temporary, "editor-v3-palmier-workspace");
  fs.mkdirSync(root, { recursive: true });
  const timeline = path.join(root, "timeline.json");
  writeJson(timeline, {
    schemaVersion: "1.0", projectId: "editor-v3", mode: "preview",
    source: {
      path: baseVideo, sha256: sha256File(baseVideo), license: "owned",
      provenance: { kind: "owned_local", evidence: "test-owner-attestation", externalUpload: false },
    },
    edl: [
      { id: "a", sourceStart: 0, sourceEnd: 1 },
      { id: "b", sourceStart: 1, sourceEnd: 2 },
    ],
    transitions: [], visual: { breathing: [], overlays: [] }, audio: { sfx: [] },
    output: { path: "./output/preview.mp4", width: 1280, height: 720, fps: 25 },
  });
  let project = openEditorProject(timeline);
  const frame = project.session.timebase.ticksPerFrame;
  let result = applyEditorCommand(timeline, {
    schemaVersion: "1.0", kind: "kacha-editor-command", baseSha256: project.session.currentSha256,
    itemId: "picture:a", operation: "ripple_trim", arguments: { edge: "end", outputTick: frame * 20 },
    actor: "editor-v3-test", reason: "picture ripple trim",
  });
  if (buildTimelineProjection(timeline).durationTick !== frame * 45 || !result.requiredQc.includes("connection_qc")) {
    throw new Error("picture ripple trim did not shift the contiguous EDL duration or require connection QC");
  }
  result = undoEditorCommand(timeline, result.timelineSha256); project = result.project;
  const beforeOverwrite = sha256File(timeline);
  result = applyEditorCommand(timeline, {
    schemaVersion: "1.0", kind: "kacha-editor-command", baseSha256: project.session.currentSha256,
    operation: "overwrite", arguments: {
      outputStartTick: frame * 10, outputEndTick: frame * 20,
      sourceStartTick: frame * 30, sourceEndTick: frame * 40,
      newId: "insert", sourceDecisionId: "decision-insert", semanticBeatId: "beat-insert", reason: "evidence overwrite",
    }, actor: "editor-v3-test", reason: "overwrite work area",
  });
  const overwritten = readJson(timeline);
  if (!overwritten.edl.some((clip) => clip.id === "insert" && clip.semanticBeatId === "beat-insert") || overwritten.edl.length !== 4) {
    throw new Error("overwrite did not preserve left/right ranges and semantic metadata");
  }
  const restored = undoEditorCommand(timeline, result.timelineSha256);
  if (sha256File(timeline) !== beforeOverwrite || restored.project.status !== "pass") throw new Error("overwrite was not exactly reversible");
  const invalidBefore = sha256File(timeline);
  let unalignedBlocked = false;
  try {
    applyEditorCommand(timeline, {
      schemaVersion: "1.0", kind: "kacha-editor-command", baseSha256: invalidBefore,
      operation: "overwrite", arguments: { outputStartTick: 1, outputEndTick: frame, sourceStartTick: 0, sourceEndTick: frame - 1, newId: "bad" },
    });
  } catch (error) { unalignedBlocked = /整帧/.test(error.message); }
  if (!unalignedBlocked || sha256File(timeline) !== invalidBefore) throw new Error("unaligned overwrite crossed the atomic boundary");
  let structuredMetadataBlocked = false;
  try {
    applyEditorCommand(timeline, {
      schemaVersion: "1.0", kind: "kacha-editor-command", baseSha256: invalidBefore,
      operation: "overwrite", arguments: {
        outputStartTick: frame * 10, outputEndTick: frame * 20, sourceStartTick: frame * 30, sourceEndTick: frame * 40,
        newId: "structured", sourceDecisionId: { forged: true },
      },
    });
  } catch (error) { structuredMetadataBlocked = /必须是/.test(error.message); }
  if (!structuredMetadataBlocked || sha256File(timeline) !== invalidBefore) throw new Error("overwrite coerced structured semantic metadata");
  let sourceDurationBlocked = false;
  try {
    applyEditorCommand(timeline, {
      schemaVersion: "1.0", kind: "kacha-editor-command", baseSha256: invalidBefore,
      operation: "overwrite", arguments: {
        outputStartTick: 0, outputEndTick: frame,
        sourceStartTick: frame * 10_000, sourceEndTick: frame * 10_001,
        newId: "beyond-source-duration",
      },
    });
  } catch (error) { sourceDurationBlocked = /源媒体时长/.test(error.message); }
  if (!sourceDurationBlocked || sha256File(timeline) !== invalidBefore) throw new Error("overwrite accepted a range beyond source media duration");
  const transitionTimeline = path.join(root, "transition-timeline.json");
  const transitionValue = readJson(timeline); transitionValue.transitions = [{ transition: "fade", durationFrames: 2 }];
  writeJson(transitionTimeline, transitionValue);
  const transitionProject = openEditorProject(transitionTimeline); const transitionBefore = sha256File(transitionTimeline);
  let transitionBlocked = false;
  try {
    applyEditorCommand(transitionTimeline, {
      schemaVersion: "1.0", kind: "kacha-editor-command", baseSha256: transitionProject.session.currentSha256,
      itemId: "picture:a", operation: "ripple_trim", arguments: { edge: "end", outputTick: frame * 20 },
    });
  } catch (error) { transitionBlocked = /已执行转场/.test(error.message); }
  if (!transitionBlocked || sha256File(transitionTimeline) !== transitionBefore) throw new Error("ripple trim modified an EDL with executed transitions");

  const workspaceFile = path.join(root, "editor-workspace.json");
  let workspace = createEditorWorkspace(workspaceFile, timeline, { label: "V3 Workspace" });
  if (workspace.timelines.length !== 1 || workspace.activeTimelineId !== "main") throw new Error("workspace did not register the primary Timeline");
  workspace = duplicateWorkspaceTimeline(workspaceFile, {
    expectedWorkspaceSha256: workspace.workspace.sha256, sourceTimelineId: "main", newTimelineId: "vertical-v1",
    label: "Vertical V1", outputPath: "versions/vertical-v1.json", width: 1080, height: 1920, role: "aspect",
  });
  const vertical = workspace.timelines.find((entry) => entry.id === "vertical-v1");
  if (workspace.timelines.length !== 2 || vertical.projection.width !== 1080 || vertical.projection.height !== 1920 || workspace.activeTimelineId !== "vertical-v1") {
    throw new Error("workspace duplicate did not create an independent aspect candidate");
  }
  const staleDestination = path.join(root, "versions", "stale.json");
  let staleBlocked = false;
  try {
    duplicateWorkspaceTimeline(workspaceFile, {
      expectedWorkspaceSha256: "0".repeat(64), sourceTimelineId: "main", newTimelineId: "stale",
      outputPath: "versions/stale.json", width: 720, height: 1280,
    });
  } catch (error) { staleBlocked = /SHA/.test(error.message); }
  if (!staleBlocked || fs.existsSync(staleDestination) || loadEditorWorkspace(workspaceFile).timelines.length !== 2) throw new Error("stale workspace mutation was not fail-closed");
  const outside = path.join(temporary, "editor-v3-outside"); fs.mkdirSync(outside, { recursive: true });
  const linked = path.join(root, "linked-outside"); fs.symlinkSync(outside, linked, "dir");
  let symlinkEscapeBlocked = false;
  try {
    duplicateWorkspaceTimeline(workspaceFile, {
      expectedWorkspaceSha256: workspace.workspace.sha256, sourceTimelineId: "main", newTimelineId: "escaped",
      outputPath: "linked-outside/escaped.json", width: 720, height: 1280,
    });
  } catch (error) { symlinkEscapeBlocked = /链接越出|Workspace 路径/.test(error.message); }
  if (!symlinkEscapeBlocked || fs.existsSync(path.join(outside, "escaped.json"))) throw new Error("workspace duplicate followed a symlink outside the project root");
  const digestTamperFile = path.join(root, "digest-tamper-workspace.json");
  const digestTamper = readJson(workspaceFile);
  digestTamper.updatedAt = "2099-01-01T00:00:00.000Z";
  digestTamper.timelines[0].path = "missing-before-digest-check.json";
  writeJson(digestTamperFile, digestTamper);
  let digestTamperBlockedFirst = false;
  try { loadEditorWorkspace(digestTamperFile); }
  catch (error) { digestTamperBlockedFirst = /digest/.test(error.message); }
  if (!digestTamperBlockedFirst) throw new Error("workspace did not bind updatedAt or validate digest before timeline files");

  const maxWorkspaceFile = path.join(root, "max-workspace.json");
  const maxWorkspace = readJson(workspaceFile);
  const templateVersion = structuredClone(maxWorkspace.timelines[1]);
  while (maxWorkspace.timelines.length < 64) {
    const index = maxWorkspace.timelines.length;
    maxWorkspace.timelines.push({
      ...structuredClone(templateVersion), id: `version-${index}`, label: `Version ${index}`, createdFrom: "main",
    });
  }
  maxWorkspace.updatedAt = new Date().toISOString();
  const maxDigestValue = structuredClone(maxWorkspace); delete maxDigestValue.digest;
  maxWorkspace.digest = sha256Value(maxDigestValue);
  writeJson(maxWorkspaceFile, maxWorkspace);
  const maxWorkspaceView = loadEditorWorkspace(maxWorkspaceFile);
  if (maxWorkspaceView.sourceVerification?.uniqueSources !== 1) {
    throw new Error("64-timeline workspace did not deduplicate shared source verification");
  }
  const maxDestination = path.join(root, "versions", "version-65.json");
  const maxWorkspaceSha = maxWorkspaceView.workspace.sha256;
  let maxWorkspaceBlocked = false;
  try {
    duplicateWorkspaceTimeline(maxWorkspaceFile, {
      expectedWorkspaceSha256: maxWorkspaceSha, sourceTimelineId: "main", newTimelineId: "version-65",
      outputPath: "versions/version-65.json", width: 1280, height: 720,
    });
  } catch (error) { maxWorkspaceBlocked = /64/.test(error.message); }
  if (!maxWorkspaceBlocked || fs.existsSync(maxDestination) || sha256File(maxWorkspaceFile) !== maxWorkspaceSha) {
    throw new Error("64-timeline workspace cap was not fail-closed and non-mutating");
  }

  const staleSourceTimeline = path.join(root, "stale-source-timeline.json");
  const staleSourceValue = readJson(timeline); staleSourceValue.source.sha256 = "0".repeat(64);
  writeJson(staleSourceTimeline, staleSourceValue);
  const staleSourceWorkspace = path.join(root, "stale-source-workspace.json");
  let staleSourceBlocked = false;
  try { createEditorWorkspace(staleSourceWorkspace, staleSourceTimeline); }
  catch (error) { staleSourceBlocked = /source\.sha256/.test(error.message); }
  if (!staleSourceBlocked || fs.existsSync(staleSourceWorkspace)) throw new Error("workspace registered a Timeline with stale source media identity");

  const relativeRoot = path.join(root, "relative-project");
  const relativeMediaDirectory = path.join(relativeRoot, "media");
  fs.mkdirSync(relativeMediaDirectory, { recursive: true });
  const relativeMedia = path.join(relativeMediaDirectory, "source.mp4");
  fs.copyFileSync(baseVideo, relativeMedia);
  const relativeTimeline = path.join(relativeRoot, "timeline.json");
  const relativeTimelineValue = readJson(timeline);
  relativeTimelineValue.source = {
    ...relativeTimelineValue.source, path: "./media/source.mp4", sha256: sha256File(relativeMedia),
  };
  relativeTimelineValue.output = {
    ...relativeTimelineValue.output,
    path: "./output/main.mp4", dialogueStem: "./output/dialogue.wav", mixStem: "./output/mix.wav",
  };
  writeJson(relativeTimeline, relativeTimelineValue);
  const relativeWorkspaceFile = path.join(relativeRoot, "workspace.json");
  const relativeWorkspace = createEditorWorkspace(relativeWorkspaceFile, relativeTimeline);
  const duplicatedRelativeWorkspace = duplicateWorkspaceTimeline(relativeWorkspaceFile, {
    expectedWorkspaceSha256: relativeWorkspace.workspace.sha256, sourceTimelineId: "main", newTimelineId: "relative-version",
    outputPath: "versions/relative-version.json", width: 1080, height: 1920, role: "aspect",
  });
  const duplicatedRelative = duplicatedRelativeWorkspace.timelines.find((entry) => entry.id === "relative-version");
  const duplicatedRelativeValue = readJson(duplicatedRelative.absolutePath);
  const duplicatedSourcePath = path.resolve(path.dirname(duplicatedRelative.absolutePath), duplicatedRelativeValue.source.path);
  if (fs.realpathSync(duplicatedSourcePath) !== fs.realpathSync(relativeMedia)
    || duplicatedRelativeValue.output.path !== "./output/relative-version.mp4"
    || duplicatedRelativeValue.output.dialogueStem === relativeTimelineValue.output.dialogueStem) {
    throw new Error("workspace duplicate broke relative media paths or reused output targets");
  }

  const invalidWorkspaceFile = path.join(root, "invalid-workspace.json");
  const invalidWorkspace = readJson(workspaceFile);
  invalidWorkspace.timelines[1].role = "mystery-role";
  const invalidWorkspaceDigest = structuredClone(invalidWorkspace);
  delete invalidWorkspaceDigest.digest;
  invalidWorkspace.digest = sha256Value(invalidWorkspaceDigest);
  writeJson(invalidWorkspaceFile, invalidWorkspace);
  let invalidWorkspaceBlocked = false;
  try { loadEditorWorkspace(invalidWorkspaceFile); }
  catch (error) { invalidWorkspaceBlocked = /role 非法/.test(error.message); }
  if (!invalidWorkspaceBlocked) throw new Error("workspace silently normalized an unknown timeline role");
  const foreignTimeline = path.join(root, "foreign-project-timeline.json");
  const foreignTimelineValue = readJson(timeline); foreignTimelineValue.projectId = "foreign-project";
  writeJson(foreignTimeline, foreignTimelineValue);
  const foreignWorkspaceFile = path.join(root, "foreign-project-workspace.json");
  const foreignWorkspace = readJson(workspaceFile);
  foreignWorkspace.timelines[1].path = path.basename(foreignTimeline);
  foreignWorkspace.timelines[1].aspect = "1280:720";
  const foreignWorkspaceDigest = structuredClone(foreignWorkspace); delete foreignWorkspaceDigest.digest;
  foreignWorkspace.digest = sha256Value(foreignWorkspaceDigest);
  writeJson(foreignWorkspaceFile, foreignWorkspace);
  let foreignProjectBlocked = false;
  try { loadEditorWorkspace(foreignWorkspaceFile); }
  catch (error) { foreignProjectBlocked = /其他 projectId/.test(error.message); }
  if (!foreignProjectBlocked) throw new Error("workspace registered a Timeline from another project");

  const unrootedWorkspaceFile = path.join(root, "unrooted-workspace.json");
  const unrootedWorkspace = readJson(workspaceFile);
  unrootedWorkspace.timelines[1].createdFrom = null;
  const unrootedWorkspaceDigest = structuredClone(unrootedWorkspace); delete unrootedWorkspaceDigest.digest;
  unrootedWorkspace.digest = sha256Value(unrootedWorkspaceDigest);
  writeJson(unrootedWorkspaceFile, unrootedWorkspace);
  let unrootedBlocked = false;
  try { loadEditorWorkspace(unrootedWorkspaceFile); }
  catch (error) { unrootedBlocked = /createdFrom 不得为空/.test(error.message); }
  if (!unrootedBlocked) throw new Error("non-primary Timeline could escape primary ancestry");

  const map = professionalCapabilityMap();
  if (!map.capabilities.some((item) => item.id === "timeline.multicam" && item.status === "planned")
    || !map.capabilities.some((item) => item.id === "workspace.versions" && item.status === "available")) {
    throw new Error("professional capability map promoted planned features or omitted implemented workspace versions");
  }
  const profiles = listDeliveryProfiles();
  if (!profiles.profiles.some((profile) => profile.id === "h264-master") || !profiles.profiles.some((profile) => profile.id === "prores-422-hq")) {
    throw new Error("delivery profiles omitted required H.264 or ProRes contracts");
  }
  const h264 = profiles.profiles.find((profile) => profile.id === "h264-master");
  for (const profile of profiles.profiles) {
    const checksPass = Object.values(profile.runtimeChecks ?? {}).every(Boolean);
    if ((profile.status === "available") !== checksPass
      || (profile.status === "available" && (!profile.selectedEncoder || !profile.selectedAudioEncoder || profile.blockedReasons.length))) {
      throw new Error(`delivery profile ${profile.id} overstated incomplete runtime support`);
    }
  }
  if (h264.status === "available") {
    const deliveryOutput = path.join(root, "final.mp4");
    const delivery = createDeliveryPlan(timeline, "h264-master", deliveryOutput);
    if (delivery.status !== "planned_not_rendered" || !fs.existsSync(`${deliveryOutput}.kacha-delivery.json`) || fs.existsSync(deliveryOutput)) {
      throw new Error("delivery plan was confused with a rendered output");
    }
  }
  const contractBundle = createSelfContainedBundle(timeline, path.join(root, "contract-bundle"));
  if (contractBundle.status !== "contract_only" || contractBundle.excludedMedia.length < 1) throw new Error("contract-only bundle silently copied source media");
  const contractManifestText = fs.readFileSync(path.join(root, "contract-bundle", "manifest.json"), "utf8");
  const contractTimelineText = fs.readFileSync(path.join(root, "contract-bundle", "timeline.json"), "utf8");
  if (contractManifestText.includes(temporary) || contractTimelineText.includes(temporary) || !contractTimelineText.includes("./Missing/")) {
    throw new Error("contract-only bundle leaked an absolute local path instead of a Missing placeholder");
  }
  const mediaBundle = createSelfContainedBundle(timeline, path.join(root, "media-bundle"), { includeMedia: true });
  if (mediaBundle.status !== "portable_with_authorized_media" || mediaBundle.includedMedia.length !== 1) throw new Error("authorized media bundle did not preserve strong identity evidence");
  const generatedProvenanceTimeline = path.join(root, "generated-provenance-timeline.json");
  const generatedProvenanceValue = readJson(timeline);
  generatedProvenanceValue.visual.overlays = [{
    id: "generated-layer", path: baseVideo, sha256: sha256File(baseVideo), kind: "video",
    start: 0, end: 1, x: 0, y: 0, width: 320, height: 180, opacity: 1,
    license: "generated", provenance: { kind: "project_generated_subtitles", evidence: "generation-manifest" },
  }];
  writeJson(generatedProvenanceTimeline, generatedProvenanceValue);
  const generatedProvenanceBundle = createSelfContainedBundle(generatedProvenanceTimeline, path.join(root, "generated-provenance-bundle"), { includeMedia: true });
  if (generatedProvenanceBundle.includedMedia.length !== 2) throw new Error("bundle rejected a documented project-generated provenance kind");
  const pendingLicenseTimeline = path.join(root, "pending-license-timeline.json");
  const pendingLicenseValue = readJson(timeline); pendingLicenseValue.source.license = "pending-review";
  writeJson(pendingLicenseTimeline, pendingLicenseValue);
  const pendingLicenseBundle = path.join(root, "pending-license-bundle");
  let pendingLicenseBlocked = false;
  try { createSelfContainedBundle(pendingLicenseTimeline, pendingLicenseBundle, { includeMedia: true }); }
  catch (error) { pendingLicenseBlocked = /license\/provenance/.test(error.message); }
  if (!pendingLicenseBlocked || fs.existsSync(pendingLicenseBundle)) throw new Error("self-contained bundle accepted an unapproved license state");
  const occupiedBundle = path.join(root, "occupied-bundle");
  fs.mkdirSync(occupiedBundle); fs.writeFileSync(path.join(occupiedBundle, "owner.txt"), "preserve me");
  let occupiedBundleBlocked = false;
  try { createSelfContainedBundle(timeline, occupiedBundle); }
  catch (error) { occupiedBundleBlocked = /拒绝覆盖/.test(error.message); }
  if (!occupiedBundleBlocked || fs.readFileSync(path.join(occupiedBundle, "owner.txt"), "utf8") !== "preserve me") {
    throw new Error("bundle publication overwrote a concurrently occupied destination");
  }
  const duplicateShaAuthorizationTimeline = path.join(root, "duplicate-sha-authorization-timeline.json");
  const duplicateShaAuthorizationValue = readJson(timeline);
  duplicateShaAuthorizationValue.source.license = "unknown";
  duplicateShaAuthorizationValue.visual.overlays = [{
    id: "same-bytes-overlay", path: baseVideo, sha256: sha256File(baseVideo), kind: "video",
    start: 0, end: 1, x: 0, y: 0, width: 320, height: 180, opacity: 1,
    license: "owned", provenance: { kind: "owned_local", evidence: "overlay-owner-attestation" },
  }];
  writeJson(duplicateShaAuthorizationTimeline, duplicateShaAuthorizationValue);
  const unauthorizedBundle = path.join(root, "unauthorized-dedup-bundle");
  let duplicateShaBypassBlocked = false;
  try { createSelfContainedBundle(duplicateShaAuthorizationTimeline, unauthorizedBundle, { includeMedia: true }); }
  catch (error) { duplicateShaBypassBlocked = /source/.test(error.message); }
  if (!duplicateShaBypassBlocked || fs.existsSync(unauthorizedBundle)) throw new Error("same-SHA asset dedup bypassed per-reference media authorization");
  const leakedTimeline = path.join(root, "timeline-with-local-evidence-path.json");
  const leakedTimelineValue = readJson(timeline);
  leakedTimelineValue.source.provenance.localEvidencePath = path.join(temporary, "private-evidence.json");
  writeJson(leakedTimeline, leakedTimelineValue);
  let localPathBlocked = false;
  try { createSelfContainedBundle(leakedTimeline, path.join(root, "leaking-bundle")); }
  catch (error) { localPathBlocked = /绝对本机路径/.test(error.message); }
  if (!localPathBlocked || fs.existsSync(path.join(root, "leaking-bundle"))) throw new Error("project bundle leaked a nested local evidence path");
  const staleNleTimeline = path.join(root, "stale-nle-timeline.json");
  const staleNleValue = readJson(timeline); staleNleValue.source.sha256 = "0".repeat(64);
  writeJson(staleNleTimeline, staleNleValue);
  const staleNleOutput = path.join(root, "stale.otio");
  let staleNleBlocked = false;
  try { exportNle(staleNleTimeline, "otio", staleNleOutput); }
  catch (error) { staleNleBlocked = /source\.sha256/.test(error.message); }
  if (!staleNleBlocked || fs.existsSync(staleNleOutput)) throw new Error("NLE export accepted a stale source identity");
  const beyondNleTimeline = path.join(root, "beyond-source-nle-timeline.json");
  const beyondNleValue = readJson(timeline); beyondNleValue.edl[1].sourceEnd = 9_999;
  writeJson(beyondNleTimeline, beyondNleValue);
  const beyondNleOutput = path.join(root, "beyond.otio");
  let beyondNleBlocked = false;
  try { exportNle(beyondNleTimeline, "otio", beyondNleOutput); }
  catch (error) { beyondNleBlocked = /源媒体时长/.test(error.message); }
  if (!beyondNleBlocked || fs.existsSync(beyondNleOutput)) throw new Error("NLE export accepted a source range beyond real media duration");
  const otioFile = path.join(root, "timeline.otio");
  exportNle(timeline, "otio", otioFile);
  const nestedCandidate = path.join(root, "nle-candidates", "nested", "candidate.json");
  const nestedImport = importNle(otioFile, "otio", timeline, nestedCandidate);
  const nestedCandidateValue = readJson(nestedCandidate);
  const nestedSource = path.resolve(path.dirname(nestedCandidate), nestedCandidateValue.source.path);
  if (nestedImport.status !== "candidate_only" || fs.realpathSync(nestedSource) !== fs.realpathSync(baseVideo)
    || nestedCandidateValue.output.path !== "./output/candidate.mp4") {
    throw new Error("NLE import did not rebase relative inputs or isolate candidate outputs");
  }
  const importRollbackOutput = path.join(root, `${"i".repeat(235)}.json`);
  let importReportFailureObserved = false;
  try { importNle(otioFile, "otio", timeline, importRollbackOutput); }
  catch { importReportFailureObserved = true; }
  if (!importReportFailureObserved || fs.existsSync(importRollbackOutput)) throw new Error("NLE import left an orphan candidate after report creation failed");
  const premiereFile = path.join(root, "timeline-premiere.xml");
  const premiere = exportNle(timeline, "premiere-xml", premiereFile);
  const premiereText = fs.readFileSync(premiereFile, "utf8");
  if (!premiere.compatibilityRoute?.includes("xmeml v5") || !premiereText.includes('<xmeml version="5">')
    || !premiereText.includes('<clipitem id="video-clipitem-1">') || !premiereText.includes("<pathurl>file:")) {
    throw new Error("Premiere export is not a real xmeml v5 interchange candidate");
  }
  const rollbackOutput = path.join(root, `${"x".repeat(235)}.otio`);
  let reportFailureObserved = false;
  try { exportNle(timeline, "otio", rollbackOutput); }
  catch { reportFailureObserved = true; }
  if (!reportFailureObserved || fs.existsSync(rollbackOutput)) throw new Error("NLE export left an orphan output after report creation failed");
}, "editor");

await test("Editor V3 surface exposes workspace intelligence delivery and activity without claiming final preview", () => {
  const html = fs.readFileSync(path.join(skillDirectory, "studio", "editor.html"), "utf8");
  const js = fs.readFileSync(path.join(skillDirectory, "studio", "editor.js"), "utf8");
  for (const id of ["timelineSwitcher", "capabilityDrawer", "deliveryDrawer", "activityDrawer", "overwriteButton", "duplicateDialog"]) {
    if (!html.includes(`id="${id}"`)) throw new Error(`Editor V3 surface omitted ${id}`);
  }
  if (!html.includes("APPROXIMATE PREVIEW") || !html.includes("PLAN ≠ RENDERED") || !js.includes('operation: "overwrite"') || !js.includes('"ripple_trim"')
    || !js.includes("capability.evidence") || !js.includes("const drawers =")) {
    throw new Error("Editor V3 UI lost its preview/delivery truth boundary or professional operations");
  }
}, "editor");

// ── 白板手绘动画（vendored 引擎，真实渲染回归）──

const whiteboardEngineVenv = path.join(scripts, "whiteboard_engine", ".venv");
const whiteboardEnginePython = process.platform.startsWith("win")
  ? path.join(whiteboardEngineVenv, "Scripts", "python.exe")
  : path.join(whiteboardEngineVenv, "bin", "python");

function ensureWhiteboardEngine() {
  if (fs.existsSync(whiteboardEnginePython)) return;
  // CI 通过 KACHA_WHITEBOARD_PYTHON 指定系统解释器（矩阵 job 已 pip 安装依赖），
  // 此时跳过 venv 引导，避免无谓下载。
  if (process.env.KACHA_WHITEBOARD_PYTHON) return;
  // 首次使用时引导引擎虚拟环境（幂等）。
  execute(process.execPath, [path.join(scripts, "kacha.mjs"), "whiteboard", "env-prepare"]);
}

function makeWhiteboardLineArt(target, width = 640, height = 360) {
  const venvPython = fs.existsSync(whiteboardEnginePython) ? whiteboardEnginePython : "python3";
  const script = [
    "from PIL import Image, ImageDraw",
    `img = Image.new("RGB", (${width}, ${height}), "#F6F1E3")`,
    "d = ImageDraw.Draw(img)",
    "d.line([(40,300),(160,120),(280,300)], fill=(70,70,70), width=4)",
    "d.line([(460,300),(460,180)], fill=(70,70,70), width=5)",
    "d.ellipse([(400,120),(520,200)], outline=(70,70,70), width=4)",
    "d.ellipse([(540,40),(610,110)], outline=(200,120,60), width=4)",
    "d.line([(20,301),(620,301)], fill=(70,70,70), width=4)",
    `img.save(${JSON.stringify(target)})`,
  ].join("\n");
  const result = run(venvPython, ["-c", script], { cwd: temporary });
  if (result.status !== 0) throw new Error(`合成线稿失败：${result.stderr}`);
  return target;
}

function whiteboardAnnotation(canvas, overrides = {}) {
  return {
    schemaVersion: "1.0",
    kind: "kacha_whiteboard_annotation",
    sceneId: "scene-01",
    canvas,
    storyBasis: "山、树与太阳",
    sceneDurationMs: 4000,
    elements: [
      {
        id: "mountain", label: "小山", sequence: 1,
        narrativeRole: "场景铺垫", subtitle: "远处有一座小山", type: "structure",
        region: { x: 20, y: 100, width: 280, height: 220 },
        reveal: { direction: "top_to_bottom", startMs: 200, durationMs: 1500, maskPaddingPx: 12, protectedRegions: [] },
        handPath: { start: [160, 110], end: [160, 300], easing: "easeInOut" },
      },
      {
        id: "tree", label: "大树", sequence: 2,
        narrativeRole: "关键物体", subtitle: "树下长着一棵大树", type: "character",
        region: { x: 390, y: 110, width: 140, height: 200 },
        reveal: { direction: "bottom_to_top", startMs: 1800, durationMs: 1300, maskPaddingPx: 12, protectedRegions: [{ x: 530, y: 30, width: 90, height: 90 }] },
        handPath: { start: [460, 300], end: [460, 130], easing: "easeInOut" },
      },
      {
        id: "sun", label: "太阳", sequence: 3,
        narrativeRole: "收尾意象", subtitle: "太阳挂在天空", type: "structure",
        region: { x: 530, y: 30, width: 90, height: 90 },
        reveal: { direction: "left_to_right", startMs: 3200, durationMs: 700, maskPaddingPx: 10, protectedRegions: [] },
        handPath: { start: [540, 40], end: [600, 100], easing: "linear" },
      },
      ...overrides.elements ?? [],
    ],
    ...overrides.topLevel ?? {},
  };
}

await testIn("whiteboard", "storyboard plan derives scenes from a real SRT under duration rules", () => {
  const srt = path.join(temporary, "whiteboard-story.srt");
  fs.writeFileSync(srt, [
    "1",
    "00:00:00,000 --> 00:00:12,000",
    "远处有一座小山",
    "",
    "2",
    "00:00:12,500 --> 00:00:24,000",
    "山脚长着一棵大树",
    "",
    "3",
    "00:00:24,500 --> 00:00:38,000",
    "太阳慢慢落下去了",
    "",
    "4",
    "00:00:38,500 --> 00:00:52,000",
    "孩子们都回家了",
    "",
  ].join("\n"), "utf8");
  const planFile = path.join(temporary, "whiteboard-story-plan.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "parse-srt",
    "--srt", srt, "--output", planFile,
  ]);
  const plan = readJson(planFile);
  if (plan.kind !== "kacha_whiteboard_storyboard_plan" || plan.schemaVersion !== "1.0") {
    throw new Error("storyboard plan lost its kacha contract identity");
  }
  if (plan.source.sha256 !== sha256File(srt)) throw new Error("storyboard plan omitted real source identity");
  if (plan.cues.length !== 4) throw new Error(`expected 4 cues, got ${plan.cues.length}`);
  if (plan.scenes.length !== 2) throw new Error(`25-35s 分幕规则失效：got ${plan.scenes.length} scenes`);
  const [first, second] = plan.scenes;
  if (first.cueRange[0] !== 1 || first.cueRange[1] !== 2 || second.cueRange[0] !== 3) {
    throw new Error("scene cue ranges did not follow narrative order");
  }
});

await testIn("whiteboard", "annotation contract validation is fail-closed on geometry and ordering", () => {
  const image = makeWhiteboardLineArt(path.join(temporary, "whiteboard-validate.png"));
  const good = path.join(temporary, "whiteboard-good-annotation.json");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "scaffold",
    "--image", image, "--scene-id", "scene-01", "--story-basis", "山、树与太阳",
    "--duration-ms", "4000", "--output", good,
  ]);
  const scaffolded = readJson(good);
  if (scaffolded.canvas.width !== 640 || scaffolded.canvas.height !== 360) {
    throw new Error("scaffold did not probe the real image dimensions");
  }
  const annotation = whiteboardAnnotation(scaffolded.canvas);
  fs.writeFileSync(good, JSON.stringify(annotation), "utf8");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "validate",
    "--image", image, "--annotation", good,
  ]);
  const broken = path.join(temporary, "whiteboard-broken-annotation.json");
  const outOfBounds = whiteboardAnnotation(scaffolded.canvas);
  outOfBounds.elements[0].region = { x: 600, y: 300, width: 200, height: 200 };
  outOfBounds.elements[1].sequence = 4;
  fs.writeFileSync(broken, JSON.stringify(outOfBounds), "utf8");
  const failure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "validate",
    "--image", image, "--annotation", broken,
  ]);
  if (!failure.stderr.includes("超出画布右边界") || !failure.stderr.includes("sequence")) {
    throw new Error(`validation failures lost their actionable reasons: ${failure.stderr.slice(0, 300)}`);
  }
  // 渲染入口默认校验：坏标注在渲染前被拒绝，且不产生任何输出文件。
  expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "render",
    "--image", image, "--annotation", broken,
    "--output", path.join(temporary, "whiteboard-should-not-render.mp4"),
  ]);
  if (fs.existsSync(path.join(temporary, "whiteboard-should-not-render.mp4"))) {
    throw new Error("render gate did not run before the engine");
  }
});

await testIn("whiteboard", "stream ink renderer produces a real narrated scene with evidence", async () => {
  ensureWhiteboardEngine();
  const image = makeWhiteboardLineArt(path.join(temporary, "whiteboard-render.png"));
  const annotationFile = path.join(temporary, "whiteboard-render-annotation.json");
  const canvas = { width: 640, height: 360 };
  // 第 4 个元素区域落在空白纸面上：回归 vendored 引擎的空墨迹分支——
  // 修复前该分支以 TypeError 崩溃，修复后跳过并继续。
  const annotation = whiteboardAnnotation(canvas, {
    elements: [{
      id: "blank-area", label: "留白", sequence: 4,
      narrativeRole: "呼吸留白", subtitle: "画面短暂留白", type: "structure",
      region: { x: 300, y: 20, width: 60, height: 40 },
      reveal: { direction: "left_to_right", startMs: 3400, durationMs: 500, maskPaddingPx: 0, protectedRegions: [] },
      handPath: { start: [300, 20], end: [360, 60], easing: "linear" },
    }],
  });
  fs.writeFileSync(annotationFile, JSON.stringify(annotation), "utf8");
  const output = path.join(temporary, "whiteboard-render-scene.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "render",
    "--image", image, "--annotation", annotationFile,
    "--output", output, "--fps", "12", "--cap-long-edge", "320",
  ]);
  if (!fs.existsSync(output)) throw new Error("whiteboard render produced no output");
  const evidenceFile = `${output}.whiteboard-evidence.json`;
  const evidence = readJson(evidenceFile);
  if (evidence.kind !== "kacha_whiteboard_render_evidence" || evidence.schemaVersion !== "1.0") {
    throw new Error("render evidence lost its kacha contract identity");
  }
  if (evidence.inputs.image.sha256 !== sha256File(image)
    || evidence.inputs.annotation.sha256 !== sha256File(annotationFile)) {
    throw new Error("render evidence omitted real input identity");
  }
  if (!evidence.engine.render.sha256 || !evidence.engine.core.sha256) {
    throw new Error("render evidence omitted engine identity");
  }
  if (evidence.options.skipValidate !== false || !evidence.validation || evidence.validation === "skipped") {
    throw new Error("render evidence omitted its validation record");
  }
  if (evidence.output.probe.codec !== "h264" || evidence.output.probe.width !== 320) {
    throw new Error(`render probe unexpected: ${JSON.stringify(evidence.output.probe)}`);
  }
  if (evidence.output.sha256 !== sha256File(output)) throw new Error("render evidence hash does not match the file on disk");
});

await testIn("whiteboard", "scene QC gates paper purity coverage and merge integrity", () => {
  ensureWhiteboardEngine();
  const image = makeWhiteboardLineArt(path.join(temporary, "whiteboard-qc.png"));
  const canvas = { width: 640, height: 360 };
  const annotationFile = path.join(temporary, "whiteboard-qc-annotation.json");
  fs.writeFileSync(annotationFile, JSON.stringify(whiteboardAnnotation(canvas)), "utf8");
  const output = path.join(temporary, "whiteboard-qc-scene.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "render",
    "--image", image, "--annotation", annotationFile,
    "--output", output, "--fps", "12", "--cap-long-edge", "320",
  ]);
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "qc",
    "--video", output, "--annotation", annotationFile, "--image", image,
  ]);
  // 幽灵元素：时序合法（不触发排序/越界错误），但区域永远不会有笔迹，
  // 唯一失败原因必须是收尾覆盖检查——单独验证覆盖门禁本身。
  const ghostAnnotation = whiteboardAnnotation(canvas, {
    elements: [{
      id: "ghost", label: "空区域", sequence: 4,
      narrativeRole: "QC 探针", subtitle: "不存在的内容", type: "structure",
      region: { x: 300, y: 20, width: 60, height: 40 },
      reveal: { direction: "left_to_right", startMs: 3400, durationMs: 500, maskPaddingPx: 0, protectedRegions: [] },
      handPath: { start: [300, 20], end: [360, 60], easing: "linear" },
    }],
  });
  const ghostFile = path.join(temporary, "whiteboard-qc-ghost.json");
  fs.writeFileSync(ghostFile, JSON.stringify(ghostAnnotation), "utf8");
  const ghostFailure = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "qc",
    "--video", output, "--annotation", ghostFile, "--image", image,
  ]);
  if (!ghostFailure.stderr.includes("final-frame-covered")) {
    throw new Error(`coverage gate failure lost its report: ${ghostFailure.stderr.slice(0, 200)}`);
  }
  if (ghostFailure.stderr.includes("annotation-valid\",\"pass\":false")) {
    throw new Error("ghost annotation unexpectedly failed the annotation contract instead of coverage");
  }
  // 合并：两段真实渲染拼成一条，证据保留双输入身份。
  const second = path.join(temporary, "whiteboard-qc-scene-2.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "render",
    "--image", image, "--annotation", annotationFile,
    "--output", second, "--fps", "12", "--cap-long-edge", "320", "--bare-tip",
  ]);
  const merged = path.join(temporary, "whiteboard-qc-merged.mp4");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "whiteboard", "merge",
    "--inputs", `${output},${second}`, "--output", merged,
  ]);
  const evidence = readJson(`${merged}.whiteboard-evidence.json`);
  if (evidence.kind !== "kacha_whiteboard_merge_evidence" || evidence.inputs.length !== 2) {
    throw new Error("merge evidence lost its input identity chain");
  }
  const firstProbe = readJson(`${output}.whiteboard-evidence.json`).output.probe;
  if (evidence.output.probe.durationMs < firstProbe.durationMs * 2 - 200) {
    throw new Error(`merged duration looks wrong: ${evidence.output.probe.durationMs}`);
  }
});

await test("install sync strips test-bootstrapped runtime artifacts from the bundle", () => {
  const source = fs.readFileSync(path.join(scripts, "sync_skill_installs.mjs"), "utf8");
  if (!source.includes("stripRuntimeArtifacts(bundle)")) {
    throw new Error("install sync does not strip runtime artifacts after bundle verification");
  }
  if (!source.includes('path.join(bundle, "scripts", "whiteboard_engine", ".venv")')) {
    throw new Error("sync strip list lost the whiteboard engine venv");
  }
  if (!source.includes('path.join(bundle, ".kacha")')) {
    throw new Error("sync strip list lost the .kacha runtime state");
  }
  if (!source.includes('"__pycache__"')) {
    throw new Error("sync strip lost the python bytecode sweep");
  }
});

await test("kacha closeout hook enforces the release contract with escape hatches", () => {
  const hook = path.join(skillDirectory, "hooks", "check_closeout.mjs");
  const runHook = (cwd, stdin = "{}") => run(process.execPath, [hook], {
    cwd,
    input: stdin,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  const blockReason = (result) => {
    try {
      const parsed = JSON.parse(result.stdout);
      return parsed.decision === "block" ? parsed.reason ?? "" : null;
    } catch {
      return null;
    }
  };
  // 非咔嚓目录必须静默放行。
  const plain = path.join(temporary, "hook-plain");
  fs.mkdirSync(plain, { recursive: true });
  const plainResult = runHook(plain);
  if (plainResult.status !== 0 || plainResult.stdout.trim() !== "") {
    throw new Error(`hook blocked a non-kacha directory: ${plainResult.stdout}`);
  }

  const project = path.join(temporary, "hook-project");
  const contracts = path.join(project, "contracts");
  fs.mkdirSync(contracts, { recursive: true });
  const finalVideo = path.join(project, "output", "final.mp4");
  fs.mkdirSync(path.dirname(finalVideo), { recursive: true });
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x20242b:s=160x90:d=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", finalVideo,
  ]);
  const manifest = {
    schemaVersion: "2.0",
    kind: "kacha-project-manifest",
    projectId: "hook-fixture",
    outputs: {
      finalVideo: { path: "output/final.mp4" },
      releaseReport: { path: "contracts/release-review.json" },
    },
  };
  fs.writeFileSync(path.join(contracts, "project-manifest.json"), JSON.stringify(manifest), "utf8");

  // 成片在、报告缺：阻断。
  const missingReport = runHook(project, JSON.stringify({ session_id: "scenario-missing-report" }));
  if (missingReport.status !== 0 || !blockReason(missingReport).includes("release-review")) {
    throw new Error(`closeout hook did not block on missing release report: ${missingReport.stdout}`);
  }

  // 报告过期（绑定旧成片）：阻断。
  fs.writeFileSync(path.join(contracts, "release-review.json"), JSON.stringify({
    status: "approved_local_release",
    finalVideoSha256: "0".repeat(64),
  }), "utf8");
  const stale = runHook(project, JSON.stringify({ session_id: "scenario-stale" }));
  if (!blockReason(stale).includes("不可验证") && !blockReason(stale).includes("过期")) {
    throw new Error(`closeout hook did not block on a stale release report: ${stale.stdout}`);
  }

  // 未批准状态：阻断。
  fs.writeFileSync(path.join(contracts, "release-review.json"), JSON.stringify({
    status: "in_review",
    finalVideoSha256: sha256File(finalVideo),
  }), "utf8");
  const unapproved = runHook(project, JSON.stringify({ session_id: "scenario-unapproved" }));
  if (!unapproved.stdout.includes("approved_local_release") && !unapproved.stdout.includes("发布审片尚未批准")) {
    throw new Error(`closeout hook did not surface the approval state: ${unapproved.stdout}`);
  }

  // 批准但报告未绑定成片 SHA：新鲜度不可验证，必须 fail-closed 阻断。
  fs.writeFileSync(path.join(contracts, "release-review.json"), JSON.stringify({
    status: "approved_local_release",
  }), "utf8");
  const unboundReport = runHook(project, JSON.stringify({ session_id: "scenario-unbound" }));
  if (!blockReason(unboundReport).includes("不可验证")) {
    throw new Error(`closeout hook did not fail closed on an unbound report: ${unboundReport.stdout}`);
  }

  // 批准且哈希新鲜：放行。
  fs.writeFileSync(path.join(contracts, "release-review.json"), JSON.stringify({
    status: "approved_local_release",
    finalVideoSha256: sha256File(finalVideo),
  }), "utf8");
  const approved = runHook(project);
  if (approved.status !== 0 || approved.stdout.trim() !== "") {
    throw new Error(`closeout hook blocked an approved release: ${approved.stdout}`);
  }

  // 逃生门：unresolved.md 记录缺口即放行。
  fs.writeFileSync(path.join(contracts, "release-review.json"), JSON.stringify({
    status: "in_review",
    finalVideoSha256: sha256File(finalVideo),
  }), "utf8");
  fs.writeFileSync(path.join(project, "unresolved.md"), "审片留到明天，缺口已记录。\n", "utf8");
  const escaped = runHook(project);
  if (escaped.status !== 0 || escaped.stdout.trim() !== "") {
    throw new Error(`closeout hook ignored the unresolved.md escape hatch: ${escaped.stdout}`);
  }
  fs.rmSync(path.join(project, "unresolved.md"));

  // 防死循环：同一会话连续 3 次阻断后放行并记违规。
  for (let index = 0; index < 2; index += 1) {
    runHook(project, JSON.stringify({ session_id: "hook-strike-test" }));
  }
  const released = runHook(project, JSON.stringify({ session_id: "hook-strike-test" }));
  if (blockReason(released) !== null) {
    throw new Error("closeout hook did not release after the strike limit");
  }
  const violations = path.join(project, ".kacha", "hook-state", "violations.jsonl");
  if (!fs.existsSync(violations) || !fs.readFileSync(violations, "utf8").includes("hook-strike-test")) {
    throw new Error("released strikes were not recorded as violations");
  }
});

await test("visual evidence watch windows deduplicate via the ledger and support forced rewatch", () => {
  const watchCli = path.join(scripts, "visual_evidence_watch.mjs");
  const sourceVideo = path.join(temporary, "watch-source.mp4");
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=160x90:rate=12:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", sourceVideo,
  ]);
  const ledger = path.join(temporary, "watch-ledger.json");
  const firstOutput = path.join(temporary, "watch-first.json");
  execute(process.execPath, [
    watchCli, "watch",
    "--video", sourceVideo, "--start", "1", "--end", "2.5", "--fps", "4",
    "--ledger", ledger, "--output", firstOutput,
  ]);
  const first = readJson(firstOutput);
  if (first.status !== "pass" || first.kind !== "kacha_visual_watch_evidence") {
    throw new Error(`first watch failed: ${first.status}`);
  }
  if (!fs.existsSync(first.contactSheet.path) || first.framePaths.length < 4) {
    throw new Error(`watch produced insufficient frames: ${first.framePaths.length}`);
  }
  if (first.transcriptSegments !== null) throw new Error("watch fabricated transcript without a transcript file");
  const secondOutput = path.join(temporary, "watch-second.json");
  const second = JSON.parse(execute(process.execPath, [
    watchCli, "watch",
    "--video", sourceVideo, "--start", "1", "--end", "2.5", "--fps", "4",
    "--ledger", ledger, "--output", secondOutput,
  ]).stdout);
  if (second.status !== "skipped_duplicate") {
    throw new Error(`identical watch window was not deduplicated: ${second.status}`);
  }
  const forcedOutput = path.join(temporary, "watch-forced.json");
  const forced = JSON.parse(execute(process.execPath, [
    watchCli, "watch",
    "--video", sourceVideo, "--start", "1", "--end", "2.5", "--fps", "4", "--force",
    "--ledger", ledger, "--output", forcedOutput,
  ]).stdout);
  if (forced.status !== "pass") throw new Error(`forced rewatch failed: ${forced.status}`);
  if (readJson(ledger).videos[Object.keys(readJson(ledger).videos)[0]].windows.length !== 2) {
    throw new Error("ledger did not record the forced rewatch");
  }
  // P1-2 回归：第二次观察不得破坏第一次观察包引用的帧文件。
  if (readJson(firstOutput).framePaths.some((frame) => !fs.existsSync(frame))) {
    throw new Error("a later watch destroyed frame files referenced by an earlier evidence package");
  }
  // P1-1 回归：超出单次帧上限的窗口必须报错，不做静默截断。
  expectFailure(process.execPath, [
    watchCli, "watch",
    "--video", sourceVideo, "--start", "0", "--end", "4", "--fps", "30",
    "--ledger", ledger, "--output", path.join(temporary, "watch-oob-fps.json"),
  ]);
  // 毫秒转录字段（startMs/endMs）也要能对齐到窗口。
  const msTranscript = path.join(temporary, "watch-transcript-ms.json");
  fs.writeFileSync(msTranscript, JSON.stringify({
    segments: [
      { startMs: 800, endMs: 1600, text: "窗口内的话" },
      { startMs: 3500, endMs: 3900, text: "窗口外的话" },
      { startMs: "bad", endMs: 2000, text: "时间不可解析" },
    ],
  }), "utf8");
  const alignedOutput = path.join(temporary, "watch-aligned.json");
  execute(process.execPath, [
    watchCli, "watch",
    "--video", sourceVideo, "--start", "1", "--end", "2.5", "--fps", "4", "--force",
    "--transcript", msTranscript, "--ledger", ledger, "--output", alignedOutput,
  ]);
  const aligned = readJson(alignedOutput);
  if (aligned.transcriptSegments?.length !== 1 || aligned.transcriptSegments[0].text !== "窗口内的话") {
    throw new Error(`ms-transcript alignment failed: ${JSON.stringify(aligned.transcriptSegments)}`);
  }
  expectFailure(process.execPath, [
    watchCli, "watch",
    "--video", sourceVideo, "--start", "3", "--end", "9", "--fps", "4",
    "--ledger", ledger, "--output", path.join(temporary, "watch-oob.json"),
  ]);
});

await test("doctor environment checks classify synthetic ffmpeg output correctly", async () => {
  const { checkEncoders, checkAssBurn, summarizeFontCoverage } = await import(
    pathToFileURL(path.join(scripts, "doctor_env_checks.mjs")).href
  );
  const fullEncoders = [
    " V....D libx264              libx264 H.264",
    " A....D aac                  AAC (Advanced Audio Coding)",
    " A....D libmp3lame           libmp3lame MP3",
  ].join("\n");
  const encoderChecks = checkEncoders(fullEncoders);
  if (encoderChecks.length !== 3 || encoderChecks.some((check) => !check.available)) {
    throw new Error("encoder checks failed on a complete ffmpeg build");
  }
  // 名称列锚定：libx264rgb / aac_at 的存在不能替 base 编码器背书，
  // 它们的描述列文本也不能被误当成编码器命中。
  const trickyEncoders = [
    " V....D libx264rgb           libx264 RGB",
    " A....D aac_at               AAC (AudioToolbox)",
  ].join("\n");
  const trickyChecks = checkEncoders(trickyEncoders);
  if (trickyChecks.some((check) => check.available)) {
    throw new Error("encoder checks accepted variant names or description text as the base encoder");
  }
  const partialEncoders = checkEncoders(" V....D libx264              libx264 H.264");
  const missingLame = partialEncoders.find((check) => check.id === "encoder:libmp3lame");
  if (partialEncoders.find((check) => check.id === "encoder:libx264")?.available !== true
    || missingLame?.available !== false
    || !missingLame.evidence.includes("渲染到最后一步")) {
    throw new Error("encoder checks did not flag a missing encoder with actionable impact");
  }
  const assAvailable = checkAssBurn(" .. TS subtitles        V       Render text subtitles using libass\n .. TS ass            V       ASS subtitles using libass");
  const assMissing = checkAssBurn(" .. TS scale          V       Scale");
  if (!assAvailable.available || assMissing.available) {
    throw new Error("ass burn check misclassified libass presence");
  }
  if (!assMissing.evidence.includes("PNG 叠加字幕路径不受影响")) {
    throw new Error("ass burn check lost the boundary note for the PNG caption path");
  }
  const coverageOk = summarizeFontCoverage([{ font: "zhenjingang.ttf", covered: 45, total: 45 }]);
  const coverageGap = summarizeFontCoverage([{ font: "tofu.ttf", covered: 5, total: 45 }]);
  const coverageEmpty = summarizeFontCoverage([]);
  if (!coverageOk.available || coverageGap.available || !coverageEmpty.available) {
    throw new Error("font coverage summary misclassified coverage results");
  }
  if (!coverageGap.evidence.includes("豆腐块")) {
    throw new Error("font coverage gap lost the tofu failure mode");
  }
  // 探测失败（如 fontTools 缺失）必须与"覆盖不足"区分：修环境，不是换字体。
  const probeFailed = summarizeFontCoverage([{ font: "mystery.ttf", probeFailed: true, detail: "ModuleNotFoundError: fontTools" }]);
  if (probeFailed.available || probeFailed.required !== true || !probeFailed.evidence.includes("必需能力")) {
    throw new Error("fontTools probe failure is not treated as a required capability");
  }
  if (!probeFailed.evidence.includes("不要据此更换字体")) {
    throw new Error("fontTools probe failure lost the remedy boundary");
  }
  // 接线断言：doctor 报告必须真的包含环境深度检查项，纯函数不许是死代码。
  const doctorReport = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "doctor", "--profile", "core",
  ]).stdout);
  const doctorIds = new Set(doctorReport.checks.map((check) => check.id));
  for (const id of ["encoder:libx264", "encoder:aac", "encoder:libmp3lame", "ass-subtitle-burn"]) {
    if (!doctorIds.has(id)) throw new Error(`doctor report omitted ${id}`);
  }
});

try {
  if (listOnly) {
    console.log(
      JSON.stringify(
        {
          status: "listed",
          tests: discovered,
        },
        null,
        2,
      ),
    );
    process.exitCode = 0;
  } else {
  const failed = results.filter((result) => result.status === "fail");
  const report = {
    status: failed.length === 0 ? "pass" : "fail",
    suites: [...requestedSuites],
    match: nameMatch || null,
    discovered: discovered.length,
    tests: results.length,
    skipped: skipped.length,
    passed: results.length - failed.length,
    passedTests: results
      .filter((result) => result.status === "pass")
      .map((result) => result.name),
    failed,
  };
  const reportOutput = option("--report");
  if (reportOutput) writeJson(path.resolve(reportOutput), report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
