#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mediaSummary,
  readJson,
  run,
  sha256File,
  sha256Value,
} from "../scripts/kacha_utils.mjs";
import { resolveResourceDirectory } from "../scripts/resource_pool.mjs";

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

await test("proposal executable source, hash and authorization pass", () => {
  execute(process.execPath, [
    path.join(scripts, "validate_edit_proposal.mjs"),
    ensureValidProposalFixture(),
  ]);
});

await test("proposal rejects invalid stage status", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.executionFlow[0].status = "banana";
  const file = path.join(temporary, "proposal-bad-status.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal passed stages require current file-backed evidence", () => {
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

await test("proposal rejects task and authorization mismatch", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.taskPath = "proposal_review";
  const file = path.join(temporary, "proposal-bad-auth.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal rejects missing executable source", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.sourceInventory[0].path = path.join(temporary, "missing.mov");
  const file = path.join(temporary, "proposal-missing-source.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal rejects an output ratio outside the creative lock", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.creativeLock.outputAspectRatio = "16:9";
  const file = path.join(temporary, "proposal-bad-creative-lock.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal rejects unrequested source geometry changes", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.creativeLock.outputWidth = 1080;
  proposal.creativeLock.outputHeight = 1920;
  const file = path.join(temporary, "proposal-unrequested-geometry-change.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal accepts an explicitly authorized geometry change", () => {
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

await test("proposal rejects spoken-word processing without source separation", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.planModules.dialogueAudio.sourceSeparation.required = false;
  proposal.planModules.dialogueAudio.sourceSeparation.mixResidualIntoFinal = true;
  const file = path.join(temporary, "proposal-no-dialogue-separation.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal rejects a detected series missing the video mark", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.seriesIdentity.videoMark.enabled = false;
  const file = path.join(temporary, "proposal-series-video-mark-missing.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal rejects an undetermined series identity before execution", () => {
  const proposal = readJson(ensureValidProposalFixture());
  proposal.seriesIdentity.status = "undetermined";
  proposal.seriesIdentity.videoMark.enabled = false;
  proposal.seriesIdentity.coverMark.enabled = false;
  const file = path.join(temporary, "proposal-series-undetermined.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("routine cleanup dry-run keeps fast regenerable cache", () => {
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

await test("routine cleanup applies only the approved cache list", () => {
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

await test("routine cleanup rejects user-needed or slow-to-regenerate cache", () => {
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

await test("final cleanup requires explicit no-more-edits confirmation", () => {
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

await test("edit plan accepts a varied whole-timeline SFX palette", () => {
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

await test("edit plan rejects one SFX reused across the whole timeline", () => {
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

await test("generated template cannot masquerade as an executable preflight", () => {
  expectFailure(process.execPath, [
    path.join(scripts, "validate_generated_shot_plan.mjs"),
    path.join(examples, "generated-shot-plan.json"),
  ]);
});

await test("generated plan rejects stale snapshot, fake model and invalid ratio", () => {
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

await test("generated execution validates real files, hashes and authorization", () => {
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
    || catalog.builtInStyleCount < 4
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
  ) {
    throw new Error("production studio preview did not resolve project overrides");
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
    || brief.opening.required !== true
    || brief.opening.primaryEffectCount !== 1
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
    "-f", "lavfi", "-i", "sine=frequency=880:duration=0.12:sample_rate=48000",
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
        time: 1,
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
    || readJson(graph).audio?.masterTruePeakDb !== -4
    || manifest.execution.masterTruePeakDb !== -4
    || manifest.execution.sourceTimecodeAndUnrequestedMetadataStripped !== true
    || summary.probe.streams.some((stream) => stream.codec_type === "data")
  ) {
    throw new Error("unified renderer did not preserve its one-encode media contract");
  }
  for (const stem of [dialogueStem, bgmStem, sfxStem, mixStem]) {
    if (!fs.existsSync(stem) || !mediaSummary(stem).audio) {
      throw new Error(`unified renderer did not emit declared stem ${stem}`);
    }
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
        profile: "warm-editorial",
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

await test("bundled original SFX pass hash, format and distribution checks", () => {
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

await test("SFX aliases resolve uniquely and private assets fail public distribution", () => {
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
    validation.templates !== 62
    || validation.catalogs.length !== 1
    || validation.catalogs[0].assets !== 22
    || validation.byCategory.opening !== 10
    || validation.byCategory.transition !== 10
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

await test("full design effect library resolves four executable visual styles", () => {
  const fontRouting = readJson(path.join(skillDirectory, "config", "font-routing.json"));
  const visualLanguages = readJson(path.join(skillDirectory, "config", "design-system", "visual-languages.json"));
  for (const styleId of [
    "xingzhe-light-overlay",
    "xingzhe-spatial-lightpath",
    "xingzhe-humor-comic",
    "xingzhe-pixel-editorial",
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
    || validation.counts.styles !== 4
    || validation.counts.contracts !== 960
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
  const project = {
    schemaVersion: "2.0",
    projectId: "synthetic-qc",
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

await test("xingzhe show profiles keep book-talk calmer than tool-share", () => {
  const toolPlan = path.join(temporary, "capability-tool-share.json");
  const bookPlan = path.join(temporary, "capability-book-talk.json");
  for (const [showId, output] of [
    ["tool-share", toolPlan],
    ["book-talk", bookPlan],
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
  if (tool.showId !== "tool-share" || book.showId !== "book-talk") {
    throw new Error("visual capability plans did not freeze showId");
  }
  if (book.events.length >= tool.events.length) {
    throw new Error("book-talk should have a calmer minimum effect budget");
  }
  if (
    tool.policy.capabilityProfile !== "tool-evidence-balanced"
    || book.policy.capabilityProfile !== "book-calm-evidence"
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
    throw new Error("Xingzhe 2.0 cover composition, character language or IP boundary regressed");
  }
}, "visual");

await test("committed four-style library QC has zero unresolved composition collisions", () => {
  const report = readJson(path.join(
    skillDirectory,
    "docs",
    "generated",
    "four-style-library-qc.json",
  ));
  if (
    report.status !== "pass"
    || report.distinctEditingGrammarCount !== 4
    || report.crossStyleExactDuplicateGroupCount !== 0
    || report.libraries?.length !== 4
  ) {
    throw new Error("four-style library QC summary is missing or did not pass");
  }
  for (const library of report.libraries) {
    for (const key of [
      "nearDuplicatePairCount",
      "headCollisionAssetCount",
      "spatialBlackAssetCount",
      "exactDuplicateAssets",
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

  const evidenceAsset = path.join(root, "evidence.png");
  fs.writeFileSync(evidenceAsset, "licensed factual evidence fixture");
  const mediaIndex = path.join(root, "media-index.json");
  writeJson(mediaIndex, {
    schemaVersion: "1.0",
    items: [{
      id: "growth-data",
      ref: "@asset:growth-data",
      kind: "image",
      path: evidenceAsset,
      fields: { description: "数据显示首稿返工时间增长 42%" },
      license: "project-owned",
      provenance: { kind: "project_evidence", evidence: "fixture" }
    }],
    summary: { scan: { truncated: false } }
  });
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
  const unsafeTimeline = path.join(root, "unsafe-timeline.json");
  const unsafe = readJson(safeTimeline);
  unsafe.visual.overlays.push({
    id: "flash", kind: "text", text: "抢焦点", start: 4.02, end: 4.12,
    x: 0, y: 0, width: 1920, height: 1080, opacity: 1, fontSizeRatio: 0.02,
    primary: true
  });
  writeJson(unsafeTimeline, unsafe);
  const failed = expectFailure(process.execPath, [
    path.join(scripts, "kacha.mjs"), "intelligence", "perception",
    "--timeline", unsafeTimeline,
  ]);
  if (!/too_many_primary_effects|full_frame_flash_risk|mobile_text_too_small/.test(failed.stdout)) {
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
  fs.writeFileSync(path.join(previewDirectory, "hook-after.mp4"), "0123456789abcdef");
  const built = JSON.parse(execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "build",
    "--timeline", timeline,
    "--director", director,
    "--preview-dir", previewDirectory,
    "--output-dir", reviewDirectory,
  ]).stdout);
  const bundle = readJson(built.bundle.path);
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
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "activate",
    "--candidate", candidate,
    "--profile", profile,
    "--confirm",
  ]);
  if (readJson(profile).versionNumber !== 1) throw new Error("preference profile was not versioned");
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"), "review", "activate",
    "--candidate", candidate,
    "--profile", profile,
    "--confirm",
  ]);
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
    "--candidate", candidate,
    "--profile", profile,
    "--confirm",
  ]);
}, "core");

await test("V6 editorial evaluation measures paired human-reviewed improvement without a composite vanity score", () => {
  const root = path.join(temporary, "v6-eval");
  fs.mkdirSync(root, { recursive: true });
  const makeDataset = (candidate) => ({
    schemaVersion: "1.0",
    kind: "kacha_editorial_eval_dataset",
    id: candidate ? "candidate" : "baseline",
    version: "v1",
    cases: [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `case-${index + 1}`,
        sourceGroupId: `source-${index + 1}`,
        showId: ["tool-share", "book-talk", "infinite-game", "very-ai"][index % 4],
        styleId: ["light-warm-overlay", "spatial-light-path", "humor-comic", "pixel-editorial"][index % 4],
        platform: index % 2 ? "douyin" : "wechat-channels",
        editorialJudgment: {
          humanReviewed: true,
          firstDraftUsability: candidate ? 0.9 : 0.65,
          outputDurationSeconds: 60,
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
          phoneAndHeadphoneReview: true
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
          outputDurationSeconds: 60,
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
  fs.writeFileSync(source, "source fixture");
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
    output: { path: "preview.mp4", width: 1920, height: 1080, fps: 25 }
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
}, "core");

await test("V6 review workbench is local-only and exposes the new review assets", async () => {
  const server = fs.readFileSync(path.join(scripts, "kacha_studio_server.mjs"), "utf8");
  const html = fs.readFileSync(path.join(skillDirectory, "studio", "review.html"), "utf8");
  const css = fs.readFileSync(path.join(skillDirectory, "studio", "review.css"), "utf8");
  if (
    !server.includes("/api/review/media")
    || !server.includes("127.0.0.1")
    || !server.includes("media-src 'self'")
    || !html.includes("正常速度")
    || !html.includes("接受不等于发布")
    || !css.includes("--signal: #ff6b1a")
  ) throw new Error("V6 local semantic review workbench contract is incomplete");
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
  fs.writeFileSync(path.join(previewDirectory, "hook-after.mp4"), "0123456789abcdef");
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
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`${origin}/api/health`);
        ready = response.ok;
        if (ready) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready) throw new Error(`studio review server did not start\n${stderr}`);
    const mutationHeaders = {
      "content-type": "application/json",
      "x-kacha-studio": "1",
      origin,
      referer: `${origin}/review`,
    };
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
    const mediaUrl = new URL("/api/review/media", origin);
    mediaUrl.searchParams.set("bundle", bundleFile);
    mediaUrl.searchParams.set("decision", previewDecision.id);
    mediaUrl.searchParams.set("variant", "after");
    const mediaResponse = await fetch(mediaUrl, { headers: { range: "bytes=-4" } });
    if (
      mediaResponse.status !== 206
      || mediaResponse.headers.get("content-range") !== "bytes 12-15/16"
      || (await mediaResponse.text()) !== "cdef"
    ) throw new Error("review media Range endpoint did not preserve the bound preview");
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
    const observedResponse = await fetch(`${origin}/api/observe`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ projectRoot: root }),
    });
    const observed = await observedResponse.json();
    if (!observedResponse.ok || observed.cost?.status !== "unavailable") {
      throw new Error(`review observability API fabricated cost evidence: ${JSON.stringify(observed)}`);
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}, "core");

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
