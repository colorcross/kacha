#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  mediaSummary,
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function execute(script, scriptArgs, cwd) {
  const result = run(process.execPath, [path.join(scriptDirectory, script), ...scriptArgs], {
    cwd,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${script} 失败`);
  }
  return result;
}

if (action !== "real") {
  fail(
    "用法：kacha.mjs golden real --video REAL_VIDEO --output-dir DIR "
      + "[--start 10] [--duration 6] [--mode final]",
    2,
  );
}
const sourceValue = option("--video");
const outputDirectoryValue = option("--output-dir");
if (!sourceValue || !outputDirectoryValue) fail("--video 和 --output-dir 不能为空", 2);
const source = path.resolve(sourceValue);
const outputDirectory = path.resolve(outputDirectoryValue);
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
  fail(`真实黄金视频不存在：${source}`, 2);
}
const sourceSummary = mediaSummary(source);
const implementationFiles = [
  "golden_regression.mjs",
  "timeline_ir.mjs",
  "render_project.mjs",
  "qc_media.mjs",
  "audio_stem_qc.mjs",
  "run_telemetry.mjs",
  "prepare_agent_packet.mjs",
  "route_references.mjs",
  "decision_rules.mjs",
  "kacha_utils.mjs",
  "kacha_config.mjs",
].map((name) => path.join(scriptDirectory, name)).concat([
  path.join(scriptDirectory, "..", "config", "defaults.json"),
  path.join(scriptDirectory, "..", "config", "decision-rules.json"),
]);
const implementationIdentities = implementationFiles.map((file) => fileIdentity(file));
const implementation = {
  files: implementationIdentities,
  digest: sha256Value(
    implementationIdentities.map(({ path: file, sha256 }) => ({ path: file, sha256 })),
  ),
};
const start = Number(option("--start", "10"));
const duration = Number(option("--duration", "6"));
const mode = option("--mode", "final");
if (
  !Number.isFinite(start)
  || !Number.isFinite(duration)
  || start < 0
  || duration < 2
  || start + duration > sourceSummary.videoDuration
  || !["preview", "final"].includes(mode)
) {
  fail("start/duration/mode 无效", 2);
}
fs.mkdirSync(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, `real-golden-${mode}.mov`);
const timelineFile = path.join(outputDirectory, "timeline.json");
const graphFile = path.join(outputDirectory, "render-graph.json");
const qcFile = path.join(outputDirectory, "technical-qc.json");
const metricsFile = path.join(outputDirectory, ".kacha", "metrics", "run-metrics.json");
const contactSheet = path.join(outputDirectory, "contact-sheet.jpg");
const reportFile = path.join(outputDirectory, "golden-report.json");
const overlayFile = path.join(outputDirectory, "feature-overlay.png");
const subtitleFile = path.join(outputDirectory, "feature-subtitles.ass");
const bgmFile = path.join(outputDirectory, "feature-bgm.wav");
const sfxFile = path.join(outputDirectory, "feature-sfx.wav");
const dialogueStem = path.join(outputDirectory, "dialogue-stem.wav");
const bgmStem = path.join(outputDirectory, "bgm-stem.wav");
const sfxStem = path.join(outputDirectory, "sfx-stem.wav");
const mixStem = path.join(outputDirectory, "final-mix-stem.wav");
const outputWidth = mode === "final"
  ? sourceSummary.width
  : Math.min(1920, sourceSummary.width);
const outputHeight = mode === "final"
  ? sourceSummary.height
  : Math.round(
      sourceSummary.height * Math.min(1920, sourceSummary.width)
        / sourceSummary.width / 2,
    ) * 2;
const generatedAssets = [
  ["ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0xF6A21A:s=480x270:d=0.04",
    "-frames:v", "1", "-threads", "1", overlayFile,
  ]],
  ["ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i",
    `sine=frequency=174:duration=${duration}:sample_rate=48000`,
    "-af", "aformat=channel_layouts=stereo",
    "-c:a", "pcm_s24le", bgmFile,
  ]],
  ["ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=1046:duration=0.12:sample_rate=48000",
    "-af", "afade=t=out:st=0.06:d=0.06,aformat=channel_layouts=stereo",
    "-c:a", "pcm_s24le", sfxFile,
  ]],
];
for (const [command, commandArgs] of generatedAssets) {
  const generated = run(command, commandArgs);
  if (generated.status !== 0) fail(generated.stderr.trim() || "golden 素材生成失败");
}
fs.writeFileSync(
  subtitleFile,
  [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${outputWidth}`,
    `PlayResY: ${outputHeight}`,
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,"
      + "BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,"
      + "BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Default,Arial,${Math.max(36, Math.round(outputHeight * 0.035))},`
      + "&H00FFFFFF,&H00FFFFFF,&H60000000,&H60000000,0,0,0,0,100,100,0,0,"
      + `1,0,4,2,${Math.round(outputWidth * 0.08)},${Math.round(outputWidth * 0.08)},`
      + `${Math.round(outputHeight * 0.18)},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.80,0:00:${Math.min(duration - 0.4, 3).toFixed(2)
      .padStart(5, "0")},Default,,0,0,0,,Kacha real-media feature golden`,
    "",
  ].join("\n"),
);
writeJsonAtomic(timelineFile, {
  schemaVersion: "1.0",
  projectId: "kacha-real-golden",
  mode,
  source: {
    path: source,
    sha256: sha256File(source),
  },
  edl: [{
    id: "representative-real-segment",
    sourceStart: start,
    sourceEnd: start + duration,
  }],
  visual: {
    breathing: [{
      start: 0.6,
      end: Math.min(duration - 0.4, 2.2),
      scale: 1.035,
      anchorX: 0.5,
      anchorY: 0.45,
      entryRatio: 0.3,
      exitRatio: 0.3,
    }],
    overlays: [{
      id: "feature-overlay",
      kind: "image",
      path: overlayFile,
      sha256: sha256File(overlayFile),
      provenance: {
        kind: "local_synthetic_golden_asset",
        evidence: "generated by golden_regression.mjs",
      },
      start: 1.2,
      end: Math.min(duration - 0.4, 3.8),
      x: Math.round(outputWidth * 0.7),
      y: Math.round(outputHeight * 0.08),
      width: Math.round(outputWidth * 0.22),
      height: Math.round(outputWidth * 0.22 * 9 / 16),
      opacity: 0.92,
    }],
    subtitles: {
      kind: "ass",
      path: subtitleFile,
      sha256: sha256File(subtitleFile),
      provenance: {
        kind: "local_synthetic_golden_asset",
        evidence: "generated by golden_regression.mjs",
      },
    },
  },
  audio: {
    bgm: {
      path: bgmFile,
      sha256: sha256File(bgmFile),
      provenance: {
        kind: "local_synthetic_golden_asset",
        evidence: "generated by golden_regression.mjs",
      },
      levelBelowDialogueDb: 18,
      sidechain: true,
    },
    sfx: [{
      id: "feature-click",
      path: sfxFile,
      sha256: sha256File(sfxFile),
      provenance: {
        kind: "local_synthetic_golden_asset",
        evidence: "generated by golden_regression.mjs",
      },
      time: Math.min(duration - 0.5, 2.2),
      levelBelowDialogueDb: 8,
    }],
  },
  output: {
    path: output,
    width: outputWidth,
    height: outputHeight,
    fps: sourceSummary.averageFps,
    dialogueStem,
    bgmStem,
    sfxStem,
    mixStem,
  },
});

let telemetry;
const started = process.hrtime.bigint();
try {
  const result = execute("run_telemetry.mjs", [
    "run",
    "--stage",
    "real_golden_render",
    "--project-root",
    outputDirectory,
    "--mode",
    mode,
    "--source-seconds",
    String(sourceSummary.videoDuration),
    "--artifact",
    output,
    "--",
    process.execPath,
    path.join(scriptDirectory, "timeline_ir.mjs"),
    "render",
    "--plan",
    timelineFile,
    "--graph",
    graphFile,
  ], outputDirectory);
  telemetry = JSON.parse(result.stdout);
} catch (error) {
  fail(error.message);
}
const outputSummary = mediaSummary(output);
writeJsonAtomic(path.join(outputDirectory, "qc-project.json"), {
  schemaVersion: "2.0",
  projectId: "kacha-real-golden-qc",
  plans: {},
  requiredCoverAspectRatios: [],
  expectedMedia: {
    width: outputSummary.width,
    height: outputSummary.height,
    aspectRatio: `${outputSummary.width}:${outputSummary.height}`,
    fps: outputSummary.averageFps,
    fpsTolerance: 0.01,
    audioSampleRate: 48000,
    expectedChannels: outputSummary.channels,
    maxAvDriftFrames: 1,
    integratedLufsMin: -40,
    integratedLufsMax: -10,
    truePeakMax: 0,
    audioMix: {
      bgmRequired: true,
      bgmBelowDialogueDbMin: 8,
      bgmBelowDialogueDbMax: 35,
      bgmMinimumCoverageRatio: 0.9
    }
  },
  outputs: {
    finalVideo: { path: output },
    audioStems: {
      dialogue: { path: dialogueStem },
      bgm: { path: bgmStem },
      sfx: { path: sfxStem },
      mix: { path: mixStem }
    },
    technicalQcReport: { path: qcFile }
  }
});
const qcProject = path.join(outputDirectory, "qc-project.json");
try {
  execute("qc_media.mjs", [qcProject], outputDirectory);
} catch (error) {
  fail(error.message);
}
const reuse = JSON.parse(execute("timeline_ir.mjs", [
  "render",
  "--plan",
  timelineFile,
  "--graph",
  graphFile,
], outputDirectory).stdout);
const contactFps = Number((3 / duration).toFixed(8));
const sheet = run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-i", output,
  "-vf", `fps=${contactFps},scale=640:-2,tile=3x1:nb_frames=3`,
  "-frames:v", "1",
  contactSheet,
]);
if (sheet.status !== 0) fail(sheet.stderr.trim() || "联系表生成失败");
const routeTokens = {};
for (const stage of ["inventory", "content", "edit", "visual_audio", "release"]) {
  const routed = JSON.parse(execute("route_references.mjs", [
    "--task",
    "source_edit",
    "--stage",
    stage,
    "--modules",
    "audio,beauty,covers,generated,netstyle,subtitles",
  ], outputDirectory).stdout);
  routeTokens[stage] = routed.totals.approximateInputTokens;
}
const metrics = readJson(metricsFile);
const qc = readJson(qcFile);
const renderManifest = readJson(`${output}.manifest.json`);
const checks = {
  oneFullVideoEncode: metrics.media.videoEncodes === 1,
  exactReuseZeroEncode: reuse.status === "reused" && reuse.videoEncodes === 0,
  geometryPreserved: mode !== "final" || (
    outputSummary.width === sourceSummary.width
    && outputSummary.height === sourceSummary.height
  ),
  durationPreserved: Math.abs(outputSummary.videoDuration - duration)
    <= 1.5 / outputSummary.averageFps,
  avDriftWithinOneFrame: qc.automaticChecks
    .find((item) => item.id === "av_duration_drift")?.status === "pass",
  technicalQcPassed: ["pass", "pass_with_review"].includes(qc.status),
  stagePacketsWithinBudget: Math.max(...Object.values(routeTokens)) <= 12_000,
  noSilentFallback: Boolean(renderManifest.execution?.encoder)
    && typeof renderManifest.execution?.encoderFallbackUsed === "boolean"
    && renderManifest.execution?.videoEncodes === 1,
  featureTimelineCovered: renderManifest.outputStems?.length === 4
    && fs.existsSync(overlayFile)
    && fs.existsSync(subtitleFile)
    && fs.existsSync(bgmFile)
    && fs.existsSync(sfxFile),
  finalMixContributionProved: qc.audioStemQc?.status === "pass"
    && qc.automaticChecks
      .find((item) => item.id === "mix_stem_reconstruction")?.status === "pass"
    && qc.automaticChecks
      .find((item) => item.id === "final_audio_matches_mix_stem")?.status === "pass",
};
const report = {
  schemaVersion: "1.0",
  status: Object.values(checks).every(Boolean)
    ? "pass_requires_human_visual_listening_review"
    : "fail",
  generatedAt: new Date().toISOString(),
  implementation,
  source: fileIdentity(source),
  sample: { start, duration, mode },
  output: {
    ...fileIdentity(output),
    media: outputSummary,
  },
  render: {
    manifest: `${output}.manifest.json`,
    graph: graphFile,
    wallSeconds: Number(
      (Number(process.hrtime.bigint() - started) / 1e9).toFixed(6),
    ),
    metrics,
    reuse,
  },
  qc: {
    path: qcFile,
    status: qc.status,
    digest: qc.digest ?? sha256Value(qc),
  },
  tokenRoutes: routeTokens,
  contactSheet,
  featureAssets: {
    overlay: fileIdentity(overlayFile),
    subtitles: fileIdentity(subtitleFile),
    bgm: fileIdentity(bgmFile),
    sfx: fileIdentity(sfxFile),
    dialogueStem: fileIdentity(dialogueStem),
    bgmStem: fileIdentity(bgmStem),
    sfxStem: fileIdentity(sfxStem),
    mixStem: fileIdentity(mixStem),
  },
  checks,
  remainingHumanEvidence: [
    "正常速度通看代表片段",
    "耳机与手机扬声器试听",
    "确认人物、字幕和连接主观质量",
  ],
};
report.digest = sha256Value({ ...report, digest: undefined });
writeJsonAtomic(reportFile, report);
console.log(JSON.stringify({
  status: report.status,
  output: reportFile,
  video: output,
  contactSheet,
  checks,
  wallSeconds: report.render.wallSeconds,
  digest: report.digest,
}, null, 2));
if (report.status.startsWith("fail")) process.exit(1);
