#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  fileIdentity,
  mediaSummary,
  parseRatio,
  readJson,
  resolveFrom,
  run,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";

function usage() {
  console.error(
    "用法：qc_media.mjs <project-manifest.json> "
      + "[--output technical-qc.json] [--config FILE]",
  );
}

function outputPathOf(entry) {
  return typeof entry === "string" ? entry : entry?.path;
}

function check(id, pass, actual, expected, severity = "error") {
  return {
    id,
    status: pass ? "pass" : "fail",
    severity,
    actual,
    expected,
  };
}

function parseLoudnorm(stderr) {
  const blocks = stderr.match(/\{[\s\S]*?\}/g) ?? [];
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block);
      if (Object.hasOwn(parsed, "input_i") && Object.hasOwn(parsed, "input_tp")) {
        return parsed;
      }
    } catch {
      // Continue to the previous JSON-looking block.
    }
  }
  return null;
}

const args = process.argv.slice(2);
const input = firstPositional(args, ["--output", "--config", "--secrets"]);
const outputIndex = args.indexOf("--output");
if (!input || (outputIndex >= 0 && !args[outputIndex + 1])) {
  usage();
  process.exit(2);
}

const projectFile = path.resolve(input);
let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: projectFile,
    includeSecrets: false,
  });
} catch (error) {
  console.error(`配置无效：${error.message}`);
  process.exit(2);
}
const qcConfig = loadedConfig.config.execution.qualityControl;
let project;
try {
  project = readJson(projectFile);
} catch (error) {
  console.error(`无法读取项目 manifest：${error.message}`);
  process.exit(2);
}
const finalVideoEntry = project.outputs?.finalVideo;
const finalVideo = resolveFrom(projectFile, outputPathOf(finalVideoEntry));
const outputFile = outputIndex >= 0
  ? path.resolve(args[outputIndex + 1])
  : resolveFrom(
    projectFile,
    outputPathOf(project.outputs?.technicalQcReport)
      ?? "technical-qc.json",
  );
if (!finalVideo || !fs.existsSync(finalVideo)) {
  console.error(`最终视频不存在：${finalVideo ?? "(missing path)"}`);
  process.exit(2);
}

let summary;
try {
  summary = mediaSummary(finalVideo);
} catch (error) {
  console.error(`无法探测最终视频：${error.message}`);
  process.exit(2);
}
const expected = project.expectedMedia ?? {};
const checks = [];

checks.push(check("video_stream", Boolean(summary.video), Boolean(summary.video)));
checks.push(check("audio_stream", Boolean(summary.audio), Boolean(summary.audio)));
if (summary.video) {
  if (Number.isFinite(expected.width)) {
    checks.push(check("width", summary.width === expected.width, summary.width, expected.width));
  }
  if (Number.isFinite(expected.height)) {
    checks.push(check("height", summary.height === expected.height, summary.height, expected.height));
  }
  if (expected.aspectRatio) {
    const ratio = parseRatio(expected.aspectRatio);
    const actualRatio = summary.width / summary.height;
    checks.push(
      check(
        "aspect_ratio",
        Boolean(ratio) && Math.abs(actualRatio - ratio.value) < 0.0001,
        `${summary.width}:${summary.height}`,
        expected.aspectRatio,
      ),
    );
  }
  if (Number.isFinite(expected.fps)) {
    const tolerance = Number(expected.fpsTolerance ?? 0.001);
    checks.push(
      check(
        "declared_fps",
        Math.abs(summary.declaredFps - expected.fps) <= tolerance,
        summary.declaredFps,
        `${expected.fps} ± ${tolerance}`,
      ),
    );
    checks.push(
      check(
        "average_fps",
        Math.abs(summary.averageFps - expected.fps) <= tolerance,
        summary.averageFps,
        `${expected.fps} ± ${tolerance}`,
      ),
    );
  }
}
if (summary.audio) {
  if (Number.isFinite(expected.audioSampleRate)) {
    checks.push(
      check(
        "audio_sample_rate",
        summary.sampleRate === expected.audioSampleRate,
        summary.sampleRate,
        expected.audioSampleRate,
      ),
    );
  }
  if (Number.isFinite(expected.expectedChannels)) {
    checks.push(
      check(
        "audio_channels",
        summary.channels === expected.expectedChannels,
        summary.channels,
        expected.expectedChannels,
      ),
    );
  }
}

if (summary.video && summary.audio && summary.fps > 0) {
  const drift = Math.abs(summary.videoDuration - summary.audioDuration);
  const maximumFrames = Number(expected.maxAvDriftFrames ?? 1);
  const maximumSeconds = maximumFrames / summary.fps + 0.0005;
  checks.push(
    check(
      "av_duration_drift",
      drift <= maximumSeconds,
      drift,
      `<= ${maximumFrames} frame(s) / ${maximumSeconds.toFixed(6)}s`,
    ),
  );
}

const detectorArguments = [
  "-hide_banner",
  "-nostats",
  "-xerror",
  "-nostdin",
  "-i",
  finalVideo,
];
if (summary.video) {
  detectorArguments.push(
    "-vf",
    `blackdetect=d=${qcConfig.blackDurationSeconds}:pix_th=${qcConfig.blackPixelThreshold},`
      + `freezedetect=n=${qcConfig.freezeNoiseDb}dB:d=${qcConfig.freezeDurationSeconds}`,
  );
}
if (summary.audio) {
  detectorArguments.push(
    "-af",
    `silencedetect=n=${qcConfig.silenceNoiseDb}dB:d=${qcConfig.silenceDurationSeconds},`
      + `loudnorm=I=${qcConfig.measurementTargetLufs}:`
      + `TP=${qcConfig.measurementTruePeakDbtp}:`
      + `LRA=${qcConfig.measurementLoudnessRange}:print_format=json`,
  );
}
detectorArguments.push("-f", "null", "-");
const detector = run("ffmpeg", detectorArguments);
const detectorLog = `${detector.stdout}\n${detector.stderr}`;
let loudness = null;
if (summary.audio) {
  loudness = parseLoudnorm(detector.stderr);
  if (!loudness) {
    checks.push(check("loudness_analysis", false, "unavailable", "valid loudnorm report"));
  } else {
    const integrated = Number(loudness.input_i);
    const truePeak = Number(loudness.input_tp);
    const minimum = Number(expected.integratedLufsMin ?? -22);
    const maximum = Number(expected.integratedLufsMax ?? -18);
    const peakMaximum = Number(expected.truePeakMax ?? -2);
    checks.push(
      check(
        "integrated_loudness",
        integrated >= minimum && integrated <= maximum,
        integrated,
        `${minimum} to ${maximum} LUFS`,
      ),
    );
    checks.push(
      check(
        "true_peak",
        truePeak <= peakMaximum,
        truePeak,
        `<= ${peakMaximum} dBTP`,
      ),
    );
  }
}

checks.push(
  check(
    "full_decode",
    detector.status === 0,
    detector.status === 0
      ? "complete detector pass decoded without FFmpeg errors"
      : detector.stderr.trim(),
    "complete decode with no errors",
  ),
);
checks.push(
  check(
    "artifact_detectors",
    detector.status === 0,
    detector.status === 0 ? "completed" : detector.stderr.trim(),
    "black/freeze/silence detectors complete",
  ),
);
const findings = {
  blackSegments: detectorLog
    .split("\n")
    .filter((line) => line.includes("black_start:"))
    .map((line) => line.trim()),
  freezeSegments: detectorLog
    .split("\n")
    .filter((line) => line.includes("freeze_start:") || line.includes("freeze_end:"))
    .map((line) => line.trim()),
  silenceSegments: detectorLog
    .split("\n")
    .filter((line) => line.includes("silence_start:") || line.includes("silence_end:"))
    .map((line) => line.trim()),
};

const failures = checks.filter((item) => item.status === "fail");
const reviewFindings = Object.values(findings).flat().length;
const finalIdentity = fileIdentity(finalVideo);
const report = {
  schemaVersion: "2.0",
  generatedAt: new Date().toISOString(),
  project: project.projectId,
  finalVideo,
  sha256: finalIdentity.sha256,
  fileIdentity: finalIdentity,
  status: failures.length > 0
    ? "fail"
    : reviewFindings > 0
      ? "pass_with_review"
      : "pass",
  media: {
    duration: summary.duration,
    videoDuration: summary.videoDuration,
    audioDuration: summary.audioDuration,
    width: summary.width,
    height: summary.height,
    fps: summary.fps,
    declaredFps: summary.declaredFps,
    averageFps: summary.averageFps,
    videoCodec: summary.video?.codec_name ?? null,
    pixelFormat: summary.video?.pix_fmt ?? null,
    colorSpace: summary.video?.color_space ?? null,
    colorTransfer: summary.video?.color_transfer ?? null,
    colorPrimaries: summary.video?.color_primaries ?? null,
    audioCodec: summary.audio?.codec_name ?? null,
    sampleRate: summary.sampleRate,
    channels: summary.channels,
    channelLayout: summary.channelLayout,
  },
  loudness,
  automaticChecks: checks,
  detectorFindings: findings,
  configuration: {
    digest: loadedConfig.digest,
    sources: loadedConfig.sources,
    detectorParameters: qcConfig,
  },
  manualReviewRequired: [
    "所有切点正常速度试听与完整语义检查",
    "字幕全文、真实字体、单行宽度、碰撞和平台安全区检查",
    "插镜对象、动作、状态、角色、时态和许可检查",
    "蒙版、人物跟踪、美颜、画中画和转场逐段动态检查",
    "voice、bgm、sfx stems 与手机扬声器/耳机听审",
    "开头、结尾、封面、品牌和全片正常速度通看",
    ...(reviewFindings > 0
      ? ["逐条判定 black/freeze/silence 探测结果是否为计划内内容"]
      : []),
  ],
};
writeJsonAtomic(outputFile, report);

console.log(
  JSON.stringify(
    {
      status: report.status,
      output: outputFile,
      failures: failures.map((item) => item.id),
      detectorFindings: reviewFindings,
    },
    null,
    2,
  ),
);
process.exit(failures.length === 0 ? 0 : 1);
