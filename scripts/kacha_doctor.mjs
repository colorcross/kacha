#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandExists,
  run,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  loadKachaConfig,
  providerEnvironment,
} from "./kacha_config.mjs";
import { diagnostic } from "./kacha_error_catalog.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const profile = option("--profile", "core");
const output = option("--output");
if (!["core", "claude-vision", "full"].includes(profile)) {
  console.error(
    "用法：kacha.mjs doctor [--profile core|claude-vision|full] [--output FILE]",
  );
  process.exit(2);
}
const inspectVisualSemantic = profile !== "core";
let loadedConfig = null;
let configError = null;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: skillRoot,
  });
} catch (error) {
  configError = error.message;
}
const configCheck = {
  id: "config:effective",
  required: true,
  available: Boolean(loadedConfig),
  evidence: loadedConfig
    ? `validated ${loadedConfig.sources.length} configuration layer(s); secrets redacted`
    : configError,
};

const requiredFiles = [
  "SKILL.md",
  "scripts/kacha.mjs",
  "scripts/kacha_config.mjs",
  "config/defaults.json",
  "scripts/capability_probe.mjs",
  "scripts/route_references.mjs",
  "scripts/prepare_agent_packet.mjs",
  "scripts/next_action.mjs",
  "scripts/compile_change_request.mjs",
  "scripts/kacha_facefusion.mjs",
  "scripts/kacha_sfx.mjs",
  "scripts/kacha_templates.mjs",
  "scripts/import_private_sfx.mjs",
  "scripts/build_visual_evidence.mjs",
  "scripts/analyze_visual_frames.swift",
  "scripts/enrich_visual_evidence_minimax.mjs",
  "references/project-workflow.md",
  "references/incremental-workflow.md",
  "references/agent-execution.md",
  "references/visual-evidence.md",
  "references/effect-templates-resources.md",
  "references/facefusion.md",
  "references/sfx-library.md",
  "references/qc-release.md",
  "config/effects/templates.json",
  "config/facefusion/profiles.json",
  "config/resources/core-catalog.json",
];
const fileChecks = requiredFiles.map((relativePath) => {
  const absolutePath = path.join(skillRoot, relativePath);
  const available = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
  return {
    id: `file:${relativePath}`,
    required: true,
    available,
    evidence: available ? `${absolutePath} (${fs.statSync(absolutePath).size} bytes)` : absolutePath,
  };
});

const commandIds = ["node", "ffmpeg", "ffprobe"];
if (profile === "full") commandIds.push("jq");
const commandChecks = commandIds.map((command) => ({
  id: `command:${command}`,
  required: true,
  available: commandExists(command),
  evidence: `command -v ${command}`,
}));

let ffmpegVersion = null;
let ffmpegFilters = "";
if (commandExists("ffmpeg")) {
  const version = run("ffmpeg", ["-version"]);
  ffmpegVersion = version.stdout.split("\n")[0] || null;
  const filters = run("ffmpeg", ["-hide_banner", "-filters"]);
  ffmpegFilters = `${filters.stdout}\n${filters.stderr}`;
}
const requiredFilters = [
  "blackdetect",
  "freezedetect",
  "silencedetect",
  "signalstats",
  "tile",
  "scale",
];
const filterChecks = requiredFilters.map((filter) => ({
  id: `filter:${filter}`,
  required: true,
  available: new RegExp(`\\s${filter}\\s`).test(ffmpegFilters),
  evidence: `ffmpeg -filters contains ${filter}`,
}));

let appleVision = {
  id: "framework:apple-vision",
  required: false,
  available: false,
  evidence: "swift unavailable",
};
if (inspectVisualSemantic && commandExists("swift")) {
  const result = run("swift", [
    "-e",
    "import Vision; import CoreImage; import AVFoundation; import ImageIO",
  ]);
  appleVision = {
    ...appleVision,
    available: result.status === 0,
    evidence: result.status === 0
      ? "Swift imports Vision/CoreImage/AVFoundation/ImageIO"
      : (result.stderr.trim() || "Swift Vision import failed"),
  };
}

let mmxVision = {
  id: "mmx:vision-describe",
  required: false,
  available: false,
  evidence: "mmx unavailable",
};
let mmxAuth = {
  id: "mmx:authenticated",
  required: false,
  available: false,
  evidence: "not checked",
};
let mmxRuntime = null;
if (inspectVisualSemantic && commandExists("mmx")) {
  const providerRuntime = loadedConfig
    ? providerEnvironment(loadedConfig, "minimax")
    : { environment: process.env };
  const minimaxProvider = loadedConfig?.config.providers.minimax ?? {
    region: "cn",
    baseUrl: null,
  };
  const providerFlags = [
    "--region",
    minimaxProvider.region,
    ...(minimaxProvider.baseUrl
      ? ["--base-url", minimaxProvider.baseUrl]
      : []),
  ];
  const version = run("mmx", ["--version"]);
  const help = run("mmx", ["vision", "describe", "--help", ...providerFlags], {
    env: providerRuntime.environment,
  });
  const auth = run("mmx", [
    "auth",
    "status",
    "--output",
    "json",
    "--quiet",
    "--non-interactive",
    ...providerFlags,
  ], {
    env: providerRuntime.environment,
  });
  const config = run("mmx", [
    "config",
    "show",
    "--output",
    "json",
    "--quiet",
    "--non-interactive",
    ...providerFlags,
  ], {
    env: providerRuntime.environment,
  });
  let safeConfig = {};
  try {
    const parsed = JSON.parse(config.stdout);
    safeConfig = {
      region: parsed.region ?? null,
      baseUrl: parsed.base_url ?? null,
      timeout: parsed.timeout ?? null,
    };
  } catch {
    safeConfig = {};
  }
  mmxRuntime = {
    version: (version.stdout || version.stderr).trim() || "unknown",
    ...safeConfig,
  };
  mmxVision = {
    ...mmxVision,
    available: help.status === 0 && /Describe an image|image understanding/i.test(
      `${help.stdout}\n${help.stderr}`,
    ),
    evidence: "mmx vision describe --help",
  };
  mmxAuth = {
    ...mmxAuth,
    available: auth.status === 0,
    evidence: auth.status === 0
      ? "mmx auth status succeeded; credential value intentionally omitted"
      : (auth.stderr.trim() || "mmx auth status failed"),
  };
}

const visualSemanticAvailable = appleVision.available
  || (mmxVision.available && mmxAuth.available);
const semanticVisualCheck = {
  id: "engine:semantic-visual-evidence",
  required: inspectVisualSemantic,
  available: visualSemanticAvailable,
  evidence: appleVision.available
    ? "local Apple Vision semantic evidence"
    : mmxVision.available && mmxAuth.available
      ? "authorized MiniMax keyframe semantic evidence"
      : "Apple Vision and authorized MiniMax vision are both unavailable",
};
let fullCapabilityCheck = null;
let faceFusionCheck = null;
if (profile === "full") {
  const manifestFile = path.join(
    os.tmpdir(),
    `kacha-doctor-full-${process.pid}-${Date.now()}.json`,
  );
  try {
    const result = run(process.execPath, [
      path.join(skillRoot, "scripts", "capability_probe.mjs"),
      "--profile",
      "full",
      "--output",
      manifestFile,
      ...(option("--config") ? ["--config", path.resolve(option("--config"))] : []),
      ...(option("--secrets") ? ["--secrets", path.resolve(option("--secrets"))] : []),
    ]);
    let missing = [];
    if (fs.existsSync(manifestFile)) {
      try {
        missing = JSON.parse(
          fs.readFileSync(manifestFile, "utf8"),
        ).summary?.missingRequired ?? [];
      } catch {
        missing = [];
      }
    }
    fullCapabilityCheck = {
      id: "profile:full-capability-probe",
      required: true,
      available: result.status === 0,
      evidence: result.status === 0
        ? "capability_probe --profile full passed"
        : `missing required capabilities: ${missing.join(", ") || "unknown"}`,
      missing,
    };
  } finally {
    if (fs.existsSync(manifestFile)) fs.unlinkSync(manifestFile);
  }
  const faceFusionConfigured = Boolean(
    loadedConfig?.config.tools.faceFusionTokenFile,
  );
  if (faceFusionConfigured) {
    const result = run(process.execPath, [
      path.join(skillRoot, "scripts", "kacha_facefusion.mjs"),
      "probe",
      ...(option("--config") ? ["--config", path.resolve(option("--config"))] : []),
      ...(option("--secrets") ? ["--secrets", path.resolve(option("--secrets"))] : []),
    ]);
    faceFusionCheck = {
      id: "service:facefusion",
      required: false,
      available: result.status === 0,
      evidence: result.status === 0
        ? "loopback FaceFusion health, authorization and processor probe passed"
        : (result.stderr.trim() || "FaceFusion probe failed"),
    };
  } else {
    faceFusionCheck = {
      id: "service:facefusion",
      required: false,
      available: false,
      evidence: "tools.faceFusionTokenFile is not configured",
    };
  }
}
const checks = [
  configCheck,
  ...fileChecks,
  ...commandChecks,
  ...filterChecks,
  ...(inspectVisualSemantic
    ? [appleVision, mmxVision, mmxAuth, semanticVisualCheck]
    : []),
  ...(fullCapabilityCheck ? [fullCapabilityCheck] : []),
  ...(faceFusionCheck ? [faceFusionCheck] : []),
];
const requiredFailures = checks.filter((item) => item.required && !item.available);
const optionalMissing = checks.filter((item) => !item.required && !item.available);
const diagnostics = requiredFailures.map((item) => diagnostic(
  "KACHA-E130",
  `${item.id}: ${item.evidence}`,
));
const versionFile = path.join(skillRoot, ".kacha-version");
const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  profile,
  status: requiredFailures.length > 0
    ? "fail"
    : optionalMissing.length > 0
      ? "pass_with_optional_gaps"
      : "pass",
  runtime: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    ffmpeg: ffmpegVersion,
    mmx: mmxRuntime,
  },
  configuration: loadedConfig
    ? {
        digest: loadedConfig.digest,
        sources: loadedConfig.sources,
        secrets: loadedConfig.secrets,
      }
    : {
        status: "invalid",
        error: configError,
      },
  skill: {
    root: skillRoot,
    installedVersionFile: fs.existsSync(versionFile)
      ? fs.readFileSync(versionFile, "utf8").trim()
      : null,
    entrySha256: sha256File(path.join(skillRoot, "SKILL.md")),
  },
  visualEvidence: {
    localTechnical: commandExists("ffmpeg") && commandExists("ffprobe"),
    localSemantic: inspectVisualSemantic ? appleVision.available : "not_probed",
    optionalRemoteSemantic: inspectVisualSemantic
      ? mmxVision.available && mmxAuth.available
      : "not_probed",
    policy: "本地优先；远程只上传显式授权的少量关键帧，不上传整段视频。",
  },
  summary: {
    checks: checks.length,
    requiredFailures: requiredFailures.map((item) => item.id),
    optionalMissing: optionalMissing.map((item) => item.id),
  },
  checks,
  diagnostics,
  cacheRecommendation: {
    root: path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
      "kacha",
    ),
    note: "只缓存工具二进制、媒体探测和关键帧证据；文件身份变化即失效。",
  },
};
if (output) writeJsonAtomic(path.resolve(output), report);
console.log(JSON.stringify(report, null, 2));
process.exit(requiredFailures.length > 0 ? 1 : 0);
