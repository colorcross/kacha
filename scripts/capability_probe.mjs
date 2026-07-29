#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandExists,
  run,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  loadKachaConfig,
  providerEnvironment,
} from "./kacha_config.mjs";

const GROUPS = {
  core: [
    "command:ffmpeg",
    "command:ffprobe",
    "command:node",
    "command:rsvg-convert",
    "filter:afftdn",
    "filter:adeclick",
    "filter:deesser",
    "filter:equalizer",
    "filter:acompressor",
    "filter:alimiter",
    "filter:loudnorm",
    "filter:overlay",
    "filter:amix",
    "filter:blackdetect",
    "filter:freezedetect",
    "filter:silencedetect",
  ],
  voice: [
    "command:jq",
    "engine:dialogue-separation",
    "filter:afftdn",
    "filter:adeclick",
    "filter:deesser",
    "filter:equalizer",
    "filter:acompressor",
    "filter:alimiter",
    "filter:loudnorm",
  ],
  masks: [
    "framework:apple-vision",
    "filter:bilateral",
    "filter:blend",
    "filter:gblur",
    "filter:maskedmerge",
    "filter:alphamerge",
    "filter:overlay",
  ],
  motion: [
    "filter:deshake",
    "filter:minterpolate",
    "filter:tblend",
    "filter:tmix",
  ],
  breathing: [
    "filter:zoompan",
    "filter:amix",
  ],
  typography: [
    "command:python3",
    "engine:font-metadata",
    "engine:caption-overlay",
    "filter:overlay",
    "filter:alphamerge",
    "encoder:qtrle",
  ],
  geometry: [
    "filter:lenscorrection",
    "filter:perspective",
    "filter:remap",
    "filter:cropdetect",
  ],
  hdr: ["filter:zscale", "filter:tonemap"],
  ai_video: ["command:mmx", "mmx-flag:--async"],
  claude_vision: [
    "engine:visual-evidence",
    "engine:semantic-visual-evidence",
  ],
};

const OPTIONAL = [
  "filter:arnndn",
  "filter:anlmdn",
  "filter:dialoguenhance",
  "filter:xfade",
  "filter:xstack",
  "filter:lut3d",
  "command:aubio",
  "application:davinci-resolve",
  "mmx-flag:--first-frame",
  "mmx-flag:--last-frame",
  "mmx-flag:--subject-image",
  "mmx-flag:--duration",
  "mmx-flag:--resolution",
  "mmx-flag:--prompt-optimizer",
  "mmx-command:vision-describe",
  "mmx-auth:active",
];

function usage() {
  console.error(
    "用法：capability_probe.sh [--profile core|voice|masks|motion|breathing|typography|geometry|hdr|ai-video|claude-vision|full] "
      + "[--require CAPABILITY] [--output manifest.json] "
      + "[--config FILE] [--secrets FILE]",
  );
}

const args = process.argv.slice(2);
let profile = "core";
let output = null;
const explicitRequired = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--profile") {
    profile = args[index + 1]?.replace("-", "_");
    index += 1;
  } else if (argument === "--require") {
    explicitRequired.push(args[index + 1]);
    index += 1;
  } else if (argument === "--output") {
    output = args[index + 1];
    index += 1;
  } else if (argument === "--config" || argument === "--secrets") {
    index += 1;
  } else if (argument === "-h" || argument === "--help") {
    usage();
    process.exit(0);
  } else {
    usage();
    process.exit(2);
  }
}

if (!GROUPS[profile] && profile !== "full") {
  usage();
  process.exit(2);
}

let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: output || process.cwd(),
  });
} catch (error) {
  console.error(`配置无效：${error.message}`);
  process.exit(2);
}
const managedDataRoot = process.env.XDG_DATA_HOME
  || path.join(os.homedir(), ".local", "share");
const managedDemucsBin = process.env.KACHA_DEMUCS_BIN
  || loadedConfig.config.tools.demucsBin
  || path.join(
    managedDataRoot,
    "kacha",
    "demucs-venv",
    "bin",
    "demucs",
  );
const legacyManagedDemucsBin = path.join(
  managedDataRoot,
  "kacha-kacha",
  "demucs-venv",
  "bin",
  "demucs",
);
const minimaxProvider = loadedConfig.config.providers.minimax;
const minimaxRuntime = providerEnvironment(loadedConfig, "minimax");
const minimaxFlags = [
  "--region",
  minimaxProvider.region,
  ...(minimaxProvider.baseUrl
    ? ["--base-url", minimaxProvider.baseUrl]
    : []),
];

const required = new Set(
  profile === "full"
    ? Object.values(GROUPS).flat()
    : [...GROUPS.core, ...(GROUPS[profile] ?? []), ...explicitRequired],
);
for (const capability of explicitRequired) required.add(capability);
const requested = [...new Set([...required, ...OPTIONAL])];

let filters = "";
let encoders = "";
if (commandExists("ffmpeg")) {
  const result = run("ffmpeg", ["-hide_banner", "-filters"]);
  filters = `${result.stdout}\n${result.stderr}`;
  const encoderResult = run("ffmpeg", ["-hide_banner", "-encoders"]);
  encoders = `${encoderResult.stdout}\n${encoderResult.stderr}`;
}
const filterSet = new Set();
for (const line of filters.split("\n")) {
  const match = /^\s*[.A-Z|]{2,}\s+(\S+)\s+/.exec(line);
  if (match) filterSet.add(match[1]);
}

let mmxHelp = "";
let mmxVisionHelp = "";
let mmxVersion = null;
let mmxAuthenticated = false;
if (commandExists("mmx")) {
  const version = run("mmx", ["--version"]);
  mmxVersion = (version.stdout || version.stderr).trim() || "unknown";
  const help = run("mmx", ["video", "generate", "--help", ...minimaxFlags], {
    env: minimaxRuntime.environment,
  });
  mmxHelp = `${help.stdout}\n${help.stderr}`;
  const visionHelp = run("mmx", ["vision", "describe", "--help", ...minimaxFlags], {
    env: minimaxRuntime.environment,
  });
  mmxVisionHelp = `${visionHelp.stdout}\n${visionHelp.stderr}`;
  const auth = run("mmx", [
    "auth",
    "status",
    "--output",
    "json",
    "--quiet",
    "--non-interactive",
    ...minimaxFlags,
  ], {
    env: minimaxRuntime.environment,
  });
  mmxAuthenticated = auth.status === 0;
}

function inspect(capability) {
  const [kind, ...rest] = capability.split(":");
  const value = rest.join(":");
  if (kind === "command") {
    return { available: commandExists(value), evidence: `command -v ${value}` };
  }
  if (kind === "filter") {
    return {
      available: filterSet.has(value),
      evidence: `ffmpeg filter ${value}`,
    };
  }
  if (kind === "encoder") {
    return {
      available: new RegExp(`\\b${value}\\b`).test(encoders),
      evidence: `ffmpeg encoder ${value}`,
    };
  }
  if (kind === "engine" && ["font-metadata", "caption-overlay"].includes(value)) {
    if (!commandExists("python3")) {
      return { available: false, evidence: "python3 unavailable" };
    }
    const modules = value === "font-metadata"
      ? "from fontTools.ttLib import TTFont"
      : "from PIL import Image, ImageDraw, ImageFont";
    const result = run("python3", ["-c", modules]);
    return {
      available: result.status === 0,
      evidence: value === "font-metadata"
        ? "python3 import fontTools"
        : "python3 import Pillow",
    };
  }
  if (kind === "engine" && value === "dialogue-separation") {
    const availableManagedBin = [managedDemucsBin, legacyManagedDemucsBin]
      .find((candidate) => run("/bin/test", ["-x", candidate]).status === 0);
    if (availableManagedBin) {
      const help = run(availableManagedBin, ["--help"]);
      return {
        available: help.status === 0,
        evidence: help.status === 0
          ? `managed Demucs CLI: ${availableManagedBin}`
          : `managed Demucs CLI failed: ${availableManagedBin}`,
      };
    }
    if (commandExists("demucs")) {
      const help = run("demucs", ["--help"]);
      return {
        available: help.status === 0,
        evidence: help.status === 0
          ? "demucs command"
          : "demucs command exists but failed runtime probe",
      };
    }
    if (!commandExists("python3")) {
      return {
        available: false,
        evidence: "demucs command and python3 unavailable",
      };
    }
    const result = run("python3", ["-m", "demucs", "--help"]);
    return {
      available: result.status === 0,
      evidence: result.status === 0
        ? "python3 module demucs"
        : "demucs command/module unavailable",
    };
  }
  if (kind === "framework" && value === "apple-vision") {
    if (!commandExists("swift")) {
      return { available: false, evidence: "swift unavailable" };
    }
    const result = run("swift", [
      "-e",
      "import Vision; import CoreImage; import AVFoundation",
    ]);
    return {
      available: result.status === 0,
      evidence: "Swift import Vision/CoreImage/AVFoundation",
    };
  }
  if (kind === "engine" && value === "visual-evidence") {
    const script = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "build_visual_evidence.mjs",
    );
    return {
      available: run("/bin/test", ["-f", script]).status === 0
        && commandExists("ffmpeg")
        && commandExists("ffprobe"),
      evidence: `local visual evidence builder: ${script}`,
    };
  }
  if (kind === "engine" && value === "semantic-visual-evidence") {
    const appleVision = inspect("framework:apple-vision");
    const minimaxVision = inspect("mmx-command:vision-describe");
    const minimaxAuth = inspect("mmx-auth:active");
    return {
      available: appleVision.available
        || (minimaxVision.available && minimaxAuth.available),
      evidence: appleVision.available
        ? "local Apple Vision semantic evidence"
        : minimaxVision.available && minimaxAuth.available
          ? "authorized MiniMax keyframe semantic evidence"
          : "neither Apple Vision nor authorized MiniMax vision is available",
    };
  }
  if (kind === "application" && value === "davinci-resolve") {
    const location = "/Applications/DaVinci Resolve/DaVinci Resolve.app";
    const result = run("/bin/test", ["-d", location]);
    return { available: result.status === 0, evidence: location };
  }
  if (kind === "mmx-flag") {
    return {
      available: commandExists("mmx") && mmxHelp.includes(value),
      evidence: `mmx video generate --help contains ${value}`,
    };
  }
  if (kind === "mmx-command" && value === "vision-describe") {
    return {
      available: commandExists("mmx")
        && /Describe an image|image understanding/i.test(mmxVisionHelp),
      evidence: "mmx vision describe --help",
    };
  }
  if (kind === "mmx-auth" && value === "active") {
    return {
      available: mmxAuthenticated,
      evidence: "mmx auth status (credential omitted)",
    };
  }
  return { available: false, evidence: "unknown capability" };
}

const checks = requested.map((id) => {
  const result = inspect(id);
  return {
    id,
    required: required.has(id),
    ...result,
  };
});
const missingRequired = checks.filter((check) => check.required && !check.available);
const availableRequired = checks.filter((check) => check.required && check.available);
const manifest = {
  schemaVersion: "2.0",
  generatedAt: new Date().toISOString(),
  profile: profile.replace("_", "-"),
  status: missingRequired.length === 0 ? "pass" : "fail",
  runtime: {
    node: process.version,
    ffmpeg: commandExists("ffmpeg")
      ? (run("ffmpeg", ["-version"]).stdout.split("\n")[0] || null)
      : null,
    mmx: mmxVersion,
  },
  configuration: {
    digest: loadedConfig.digest,
    sources: loadedConfig.sources,
    secrets: loadedConfig.secrets,
  },
  summary: {
    required: required.size,
    availableRequired: availableRequired.length,
    missingRequired: missingRequired.map((check) => check.id),
  },
  checks,
};

for (const check of checks) {
  const marker = check.available ? "OK  " : check.required ? "FAIL" : "INFO";
  console.log(`${marker} ${check.id}`);
}
console.log(
  `STATUS ${manifest.status.toUpperCase()} (${availableRequired.length}/${required.size} required capabilities available)`,
);

if (output) {
  writeJsonAtomic(path.resolve(output), manifest);
  console.log(`MANIFEST ${path.resolve(output)}`);
}
process.exit(missingRequired.length === 0 ? 0 : 1);
