#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mediaSummary,
  readJson,
  run,
  sha256File,
} from "../scripts/kacha_utils.mjs";

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
    /mask|beauty|text-behind|reframe|information card|visual design|cropped head|style profile|transition|opening|connection scanner/i
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

function localDesignPreflight(name) {
  return {
    status: "approved_for_implementation",
    artifactMode: "local_styleframe",
    artifactRef: `design/${name}/approved-styleframes.png`,
    layoutSpec: "已定义人物、字幕、品牌和模块安全区",
    motionSpec: "已定义进入、停稳和退出状态及缓动",
    soundSpec: "已定义声音功能、落点和相对人声音量",
    stateFrames: ["entry", "peak", "exit"],
    implementationHandoff: "按已批准样式帧、动效参数和音效帧点实现",
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
  for (const expected of [
    "references/incremental-workflow.md",
    "references/visuals-masks.md",
    "references/agent-execution.md",
    "references/visual-evidence.md",
  ]) {
    if (!packet.readOrder.some((file) => file.endsWith(expected))) {
      throw new Error(`agent packet missing ${expected}`);
    }
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
    || report.config.style.profile !== "warm-editorial"
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
    validation.style.id !== "warm-editorial"
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
    styleReport.style.profile.id !== "warm-editorial"
    || styleReport.style.profile.popups.maxWidthRatio !== 0.6
    || !styleReport.style.digest
  ) {
    throw new Error("style-only override did not inherit and resolve the default profile");
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
    "-f", "lavfi", "-i", "color=c=red@0.7:s=320x180:d=2:r=25,format=rgba",
    "-c:v", "qtrle", exactText,
  ]);
  mediaFixturesReady = true;
}

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
  const root = path.join(temporary, `incremental-${name}`);
  fs.mkdirSync(root, { recursive: true });
  const args = [
    path.join(scripts, "init_incremental_project.mjs"),
    baseVideo,
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
    baseline: baseVideo,
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

await test("beauty modes preserve duration and produce distinct outputs", () => {
  ensureMediaFixtures();
  const light = path.join(temporary, "beauty-light.mov");
  const plus = path.join(temporary, "beauty-plus.mov");
  execute(path.join(scripts, "apply_mask_effect.sh"), [
    baseVideo,
    exactMask,
    light,
    "beauty-light",
  ]);
  execute(path.join(scripts, "apply_mask_effect.sh"), [
    baseVideo,
    exactMask,
    plus,
    "beauty-plus",
  ]);
  const baseDuration = mediaSummary(baseVideo).duration;
  for (const file of [light, plus]) {
    if (Math.abs(mediaSummary(file).duration - baseDuration) > 1 / 25 + 0.0005) {
      throw new Error(`${path.basename(file)} duration drifted`);
    }
  }
  if (sha256File(light) === sha256File(plus)) {
    throw new Error("beauty-light and beauty-plus unexpectedly produced identical files");
  }
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
      expectedChannels: 1,
      maxAvDriftFrames: 1,
      integratedLufsMin: -40,
      integratedLufsMax: 0,
      truePeakMax: 0,
    },
    outputs: {
      finalVideo: { path: baseVideo },
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
  ) {
    throw new Error("technical QC did not record effective configured detectors");
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
  const project = {
    schemaVersion: "2.0",
    projectId: "synthetic-release",
    plans: {
      proposal: ensureValidProposalFixture(),
      editPlan: path.join(examples, "edit-plan.json"),
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
  if (JSON.parse(afterReview.stdout).nextAction.id !== "gate_release") {
    throw new Error("v2 next did not advance to release gate");
  }
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-release",
    projectFile,
  ]);
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
  console.log(
    JSON.stringify(
      {
        status: failed.length === 0 ? "pass" : "fail",
        suites: [...requestedSuites],
        match: nameMatch || null,
        discovered: discovered.length,
        tests: results.length,
        skipped: skipped.length,
        passed: results.length - failed.length,
        failed,
      },
      null,
      2,
    ),
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
