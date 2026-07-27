#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import {
  commandExists,
  run,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const GROUPS = {
  core: [
    "command:ffmpeg",
    "command:ffprobe",
    "command:node",
    "filter:afftdn",
    "filter:adeclick",
    "filter:deesser",
    "filter:equalizer",
    "filter:acompressor",
    "filter:alimiter",
    "filter:loudnorm",
    "filter:overlay",
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
  geometry: [
    "filter:lenscorrection",
    "filter:perspective",
    "filter:remap",
    "filter:cropdetect",
  ],
  hdr: ["filter:zscale", "filter:tonemap"],
  ai_video: ["command:mmx", "mmx-flag:--async"],
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
];

const managedDataRoot = process.env.XDG_DATA_HOME
  || path.join(os.homedir(), ".local", "share");
const managedDemucsBin = process.env.KACHA_DEMUCS_BIN
  || path.join(
    managedDataRoot,
    "kacha-kacha",
    "demucs-venv",
    "bin",
    "demucs",
  );

function usage() {
  console.error(
    "用法：capability_probe.sh [--profile core|voice|masks|motion|geometry|hdr|ai-video|full] "
      + "[--require CAPABILITY] [--output manifest.json]",
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

const required = new Set(
  profile === "full"
    ? Object.values(GROUPS).flat()
    : [...GROUPS.core, ...(GROUPS[profile] ?? []), ...explicitRequired],
);
for (const capability of explicitRequired) required.add(capability);
const requested = [...new Set([...required, ...OPTIONAL])];

let filters = "";
if (commandExists("ffmpeg")) {
  const result = run("ffmpeg", ["-hide_banner", "-filters"]);
  filters = `${result.stdout}\n${result.stderr}`;
}
const filterSet = new Set();
for (const line of filters.split("\n")) {
  const match = /^\s*[.A-Z|]{2,}\s+(\S+)\s+/.exec(line);
  if (match) filterSet.add(match[1]);
}

let mmxHelp = "";
let mmxVersion = null;
if (commandExists("mmx")) {
  const version = run("mmx", ["--version"]);
  mmxVersion = (version.stdout || version.stderr).trim() || "unknown";
  const help = run("mmx", ["video", "generate", "--help"]);
  mmxHelp = `${help.stdout}\n${help.stderr}`;
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
  if (kind === "engine" && value === "dialogue-separation") {
    const managed = run("/bin/test", ["-x", managedDemucsBin]);
    if (managed.status === 0) {
      const help = run(managedDemucsBin, ["--help"]);
      return {
        available: help.status === 0,
        evidence: help.status === 0
          ? `managed Demucs CLI: ${managedDemucsBin}`
          : `managed Demucs CLI failed: ${managedDemucsBin}`,
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
