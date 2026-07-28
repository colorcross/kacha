#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  mediaSummary,
  parseRatio,
  readJson,
  resolveFrom,
  run,
  sha256File,
  sha256Value,
  streamSha256,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

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

function runLoudness(file) {
  const result = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    "-i",
    file,
    "-map",
    "0:a:0",
    "-af",
    "loudnorm=I=-20:TP=-2:LRA=7:print_format=json",
    "-f",
    "null",
    "-",
  ]);
  return parseLoudnorm(result.stderr);
}

function resolveOutput(projectFile, project, delta, field) {
  if (field === "video") {
    return resolveFrom(
      resolveFrom(projectFile, project.delta),
      delta.newVersion.outputPath,
    );
  }
  return null;
}

const [, , input] = process.argv;
if (!input) {
  console.error("用法：qc_incremental.mjs <incremental-project.json>");
  process.exit(2);
}

const projectFile = path.resolve(input);
let project;
let context;
let delta;
let plan;
try {
  project = readJson(projectFile);
  context = readJson(resolveFrom(projectFile, project.context));
  delta = readJson(resolveFrom(projectFile, project.delta));
  plan = readJson(resolveFrom(projectFile, project.outputs.incrementalPlan));
} catch (error) {
  console.error(`无法读取增量 QC 输入：${error.message}`);
  process.exit(2);
}

const outputFile = resolveFrom(projectFile, project.outputs.deltaQcReport);
const deltaFile = resolveFrom(projectFile, project.delta);
const contextFile = resolveFrom(projectFile, project.context);
const artifactIndexFile = resolveFrom(projectFile, project.artifactIndex);
const baseVideo = resolveFrom(contextFile, context.baseline.video.path);
const candidateVideo = delta.deliverables.video
  ? resolveOutput(projectFile, project, delta, "video")
  : null;
const changedLayers = new Set(delta.changeSet.changedLayers);
const audioChanged = ["dialogue", "bgm", "sfx"].some((layer) => changedLayers.has(layer));
const videoChanged = ["visual", "subtitles"].some((layer) => changedLayers.has(layer));
const checks = [];
const inheritedEvidence = [];
const deliverableEvidence = [];
const detectorFindings = {
  blackSegments: [],
  freezeSegments: [],
  silenceSegments: [],
};
let summary = null;
let loudness = null;

if (
  plan.inputHashes.projectContext !== sha256File(contextFile)
  || plan.inputHashes.versionDelta !== sha256File(deltaFile)
  || plan.inputHashes.artifactIndex !== sha256File(artifactIndexFile)
) {
  checks.push(
    check(
      "plan_input_identity",
      false,
      "incremental plan input hash mismatch",
      "plan belongs to current context and delta",
    ),
  );
}

if (delta.deliverables.video) {
  if (
    !candidateVideo
    || !fs.existsSync(candidateVideo)
    || !fs.statSync(candidateVideo).isFile()
  ) {
    console.error(`候选视频不存在：${candidateVideo ?? delta.newVersion.outputPath}`);
    process.exit(2);
  }
  if (path.resolve(candidateVideo) === path.resolve(baseVideo)) {
    checks.push(check("base_not_overwritten", false, candidateVideo, "independent output"));
  } else {
    checks.push(check("base_not_overwritten", true, candidateVideo, "independent output"));
  }
  try {
    summary = mediaSummary(candidateVideo);
  } catch (error) {
    console.error(`无法探测候选视频：${error.message}`);
    process.exit(2);
  }
  const lock = context.creativeLock;
  checks.push(check(
    "video_stream",
    Boolean(summary.video),
    Boolean(summary.video),
    true,
  ));
  if (context.source.media.hasAudio) {
    checks.push(check(
      "audio_stream",
      Boolean(summary.audio),
      Boolean(summary.audio),
      true,
    ));
  }
  checks.push(check(
    "width",
    summary.width === Number(lock.outputWidth),
    summary.width,
    Number(lock.outputWidth),
  ));
  checks.push(check(
    "height",
    summary.height === Number(lock.outputHeight),
    summary.height,
    Number(lock.outputHeight),
  ));
  checks.push(check(
    "declared_fps",
    Math.abs(summary.declaredFps - Number(context.source.media.fps)) <= 0.001,
    summary.declaredFps,
    Number(context.source.media.fps),
  ));
  checks.push(check(
    "average_fps",
    Math.abs(summary.averageFps - Number(context.source.media.fps)) <= 0.001,
    summary.averageFps,
    Number(context.source.media.fps),
  ));
  const expectedDuration = Number(delta.changeSet.outputDurationSeconds);
  const durationTolerance = 1 / Number(context.source.media.fps) + 0.0005;
  const durationPass = delta.newVersion.intent === "preview"
    ? summary.duration > 0 && summary.duration <= expectedDuration + durationTolerance
    : Math.abs(summary.duration - expectedDuration) <= durationTolerance;
  checks.push(check(
    "duration_contract",
    durationPass,
    summary.duration,
    delta.newVersion.intent === "preview"
      ? `> 0 and <= ${expectedDuration}`
      : `${expectedDuration} ± ${durationTolerance.toFixed(6)}s`,
  ));

  if (summary.video && summary.audio && summary.fps > 0) {
    const drift = Math.abs(summary.videoDuration - summary.audioDuration);
    const maximum = 1 / summary.fps + 0.0005;
    checks.push(check("audio_video_drift", drift <= maximum, drift, `<= ${maximum}s`));
  }

  const decode = run("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-xerror",
    "-nostdin",
    "-i",
    candidateVideo,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-f",
    "null",
    "-",
  ]);
  checks.push(check(
    "decode_output",
    decode.status === 0,
    decode.status === 0 ? "decoded without errors" : decode.stderr.trim(),
    "complete decode with no errors",
  ));

  if (delta.newVersion.intent !== "preview") {
    if (!audioChanged && context.source.media.hasAudio) {
      try {
        const baseHash = streamSha256(baseVideo, "audio");
        const candidateHash = streamSha256(candidateVideo, "audio");
        checks.push(check(
          "audio_elementary_stream_sha256",
          baseHash === candidateHash,
          candidateHash,
          baseHash,
        ));
        inheritedEvidence.push({
          layer: "audio",
          baseVideo,
          baseStreamSha256: baseHash,
          candidateStreamSha256: candidateHash,
          inherited: baseHash === candidateHash,
        });
      } catch (error) {
        checks.push(check(
          "audio_elementary_stream_sha256",
          false,
          error.message,
          "matching audio elementary stream",
        ));
      }
    }
    if (!videoChanged) {
      try {
        const baseHash = streamSha256(baseVideo, "video");
        const candidateHash = streamSha256(candidateVideo, "video");
        checks.push(check(
          "video_elementary_stream_sha256",
          baseHash === candidateHash,
          candidateHash,
          baseHash,
        ));
        inheritedEvidence.push({
          layer: "video",
          baseVideo,
          baseStreamSha256: baseHash,
          candidateStreamSha256: candidateHash,
          inherited: baseHash === candidateHash,
        });
      } catch (error) {
        checks.push(check(
          "video_elementary_stream_sha256",
          false,
          error.message,
          "matching video elementary stream",
        ));
      }
    }
  }

  if (audioChanged && summary.audio) {
    if (Number.isFinite(context.source.media.audioSampleRate)) {
      checks.push(check(
        "audio_sample_rate",
        summary.sampleRate === Number(context.source.media.audioSampleRate),
        summary.sampleRate,
        Number(context.source.media.audioSampleRate),
      ));
    }
    if (Number.isFinite(context.source.media.audioChannels)) {
      checks.push(check(
        "audio_channels",
        summary.channels === Number(context.source.media.audioChannels),
        summary.channels,
        Number(context.source.media.audioChannels),
      ));
    }
    loudness = runLoudness(candidateVideo);
    checks.push(check(
      "loudness_analysis",
      Boolean(loudness),
      loudness ?? "unavailable",
      "valid loudnorm measurement",
    ));
    const contract = context.delivery.audioContract;
    if (loudness && contract) {
      const integrated = Number(loudness.input_i);
      const truePeak = Number(loudness.input_tp);
      checks.push(check(
        "integrated_loudness",
        integrated >= Number(contract.integratedLufsMin)
          && integrated <= Number(contract.integratedLufsMax),
        integrated,
        `${contract.integratedLufsMin} to ${contract.integratedLufsMax} LUFS`,
      ));
      checks.push(check(
        "true_peak",
        truePeak <= Number(contract.truePeakMax),
        truePeak,
        `<= ${contract.truePeakMax} dBTP`,
      ));
    }
    const silenceDetector = run("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-nostdin",
      "-i",
      candidateVideo,
      "-map",
      "0:a:0",
      "-af",
      "silencedetect=n=-50dB:d=0.5",
      "-f",
      "null",
      "-",
    ]);
    checks.push(check(
      "audio_silence_detector",
      silenceDetector.status === 0,
      silenceDetector.status === 0
        ? "completed"
        : silenceDetector.stderr.trim(),
      "silence detector complete",
    ));
    const silenceLog = `${silenceDetector.stdout}\n${silenceDetector.stderr}`;
    detectorFindings.silenceSegments = silenceLog
      .split("\n")
      .filter(
        (line) => line.includes("silence_start:") || line.includes("silence_end:"),
      )
      .map((line) => line.trim());
  }

  if (videoChanged) {
    const detector = run("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-nostdin",
      "-i",
      candidateVideo,
      "-vf",
      "blackdetect=d=0.08:pix_th=0.10,freezedetect=n=-60dB:d=0.5",
      "-f",
      "null",
      "-",
    ]);
    checks.push(check(
      "visual_artifact_detectors",
      detector.status === 0,
      detector.status === 0 ? "completed" : detector.stderr.trim(),
      "black/freeze detectors complete",
    ));
    const log = `${detector.stdout}\n${detector.stderr}`;
    detectorFindings.blackSegments = log
      .split("\n")
      .filter((line) => line.includes("black_start:"))
      .map((line) => line.trim());
    detectorFindings.freezeSegments = log
      .split("\n")
      .filter((line) => line.includes("freeze_start:") || line.includes("freeze_end:"))
      .map((line) => line.trim());
  }

  deliverableEvidence.push({
    type: "video",
    path: candidateVideo,
    sha256: sha256File(candidateVideo),
  });
}

for (const cover of delta.deliverables.covers ?? []) {
  const file = resolveFrom(deltaFile, cover.path);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    checks.push(check(
      `cover_${cover.aspectRatio}`,
      false,
      file ?? cover.path,
      "existing cover file",
    ));
    continue;
  }
  try {
    const coverSummary = mediaSummary(file);
    const expected = parseRatio(cover.aspectRatio);
    const actual = coverSummary.width / coverSummary.height;
    checks.push(check(
      `cover_${cover.aspectRatio}`,
      Boolean(expected) && Math.abs(actual - expected.value) <= 0.0001,
      `${coverSummary.width}:${coverSummary.height}`,
      cover.aspectRatio,
    ));
    deliverableEvidence.push({
      type: "cover",
      aspectRatio: cover.aspectRatio,
      path: file,
      sha256: sha256File(file),
    });
  } catch (error) {
    checks.push(check(
      `cover_${cover.aspectRatio}`,
      false,
      error.message,
      "decodable exact-ratio cover",
    ));
  }
}

for (const subtitle of delta.deliverables.subtitles ?? []) {
  const file = resolveFrom(deltaFile, subtitle.path);
  const pass = Boolean(file)
    && fs.existsSync(file)
    && fs.statSync(file).isFile()
    && fs.statSync(file).size > 0;
  checks.push(check(
    `subtitle_${subtitle.language}`,
    pass,
    file ?? subtitle.path,
    "existing non-empty subtitle file",
  ));
  if (pass) {
    deliverableEvidence.push({
      type: "subtitle",
      language: subtitle.language,
      path: file,
      sha256: sha256File(file),
    });
  }
}

if (deliverableEvidence.length === 0) {
  checks.push(check(
    "deliverable_exists_and_sha256",
    false,
    "no deliverable evidence",
    "at least one video, cover, or subtitle deliverable",
  ));
}

const failures = checks.filter((item) => item.status === "fail");
const findingsCount = Object.values(detectorFindings).flat().length;
const report = {
  schemaVersion: "3.0",
  generatedAt: new Date().toISOString(),
  projectId: project.projectId,
  baseVersionId: delta.baseVersionId,
  versionId: delta.newVersion.id,
  intent: delta.newVersion.intent,
  contextSha256: sha256File(contextFile),
  deltaSha256: sha256File(deltaFile),
  artifactIndexSha256: sha256File(artifactIndexFile),
  planSha256: sha256File(resolveFrom(projectFile, project.outputs.incrementalPlan)),
  status: failures.length > 0
    ? "fail"
    : findingsCount > 0
      ? "pass_with_review"
      : "pass",
  output: candidateVideo
    ? {
        path: candidateVideo,
        sha256: sha256File(candidateVideo),
        durationSeconds: summary.duration,
        width: summary.width,
        height: summary.height,
        declaredFps: summary.declaredFps,
        averageFps: summary.averageFps,
      }
    : null,
  changedLayers: [...changedLayers],
  executedChecks: checks,
  inheritedEvidence,
  deliverableEvidence,
  deliverableDigest: sha256Value(deliverableEvidence),
  loudness,
  detectorFindings,
  manualReviewRequired: plan.qcProfile.manualChecks,
};
writeJsonAtomic(outputFile, report);
console.log(
  JSON.stringify(
    {
      status: report.status,
      output: outputFile,
      failures: failures.map((item) => item.id),
      checksExecuted: checks.length,
      inheritedEvidence: inheritedEvidence.length,
      manualReviewRequired: report.manualReviewRequired,
    },
    null,
    2,
  ),
);
process.exit(failures.length === 0 ? 0 : 1);
