#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const results = [];

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

async function test(name, callback) {
  try {
    await callback();
    results.push({ name, status: "pass" });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: "fail", error: error.message });
    console.error(`FAIL ${name}\n${error.message}`);
  }
}

const sourceFile = path.join(temporary, "source-input.txt");
fs.writeFileSync(sourceFile, "immutable source fixture\n");

await test("proposal executable source, hash and authorization pass", () => {
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
  proposal.approvedScope = ["local source edit and QC", "no upload", "no paid generation"];
  const file = path.join(temporary, "proposal-valid.json");
  writeJson(file, proposal);
  execute(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal rejects invalid stage status", () => {
  const proposal = readJson(path.join(temporary, "proposal-valid.json"));
  proposal.executionFlow[0].status = "banana";
  const file = path.join(temporary, "proposal-bad-status.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal rejects task and authorization mismatch", () => {
  const proposal = readJson(path.join(temporary, "proposal-valid.json"));
  proposal.taskPath = "proposal_review";
  const file = path.join(temporary, "proposal-bad-auth.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal rejects missing executable source", () => {
  const proposal = readJson(path.join(temporary, "proposal-valid.json"));
  proposal.sourceInventory[0].path = path.join(temporary, "missing.mov");
  const file = path.join(temporary, "proposal-missing-source.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
});

await test("proposal rejects an output ratio outside the creative lock", () => {
  const proposal = readJson(path.join(temporary, "proposal-valid.json"));
  proposal.creativeLock.outputAspectRatio = "16:9";
  const file = path.join(temporary, "proposal-bad-creative-lock.json");
  writeJson(file, proposal);
  expectFailure(process.execPath, [path.join(scripts, "validate_edit_proposal.mjs"), file]);
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

await test("mask effect rejects shorter mask instead of repeating last frame", () => {
  expectFailure(path.join(scripts, "apply_mask_effect.sh"), [
    baseVideo,
    shortMask,
    path.join(temporary, "mask-should-fail.mov"),
    "face-light",
  ]);
});

await test("text-behind rejects shorter layer instead of truncating base", () => {
  expectFailure(path.join(scripts, "compose_text_behind_person.sh"), [
    baseVideo,
    exactMask,
    shortMask,
    path.join(temporary, "text-should-fail.mov"),
  ]);
});

await test("aligned mask and text pipelines preserve base duration", () => {
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

await test("mask PNG manifest builds an aligned lossless video", () => {
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

await test("bundled original SFX pass hash, format and distribution checks", () => {
  const result = execute(process.execPath, [
    path.join(scripts, "validate_sfx_library.mjs"),
    path.join(skillDirectory, "assets", "sfx", "manifest.json"),
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
    "--denoise",
    "off",
    "--channel-mode",
    "preserve",
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
  writeJson(projectFile, project);
  execute(process.execPath, [path.join(scripts, "qc_media.mjs"), projectFile]);
  const report = readJson(project.outputs.technicalQcReport.path);
  if (!["pass", "pass_with_review"].includes(report.status)) {
    throw new Error(`unexpected technical QC status ${report.status}`);
  }
});

await test("release gate verifies hashes, cover ratios and manual evidence", () => {
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
      proposal: path.join(temporary, "proposal-valid.json"),
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
  execute(process.execPath, [
    path.join(scripts, "kacha.mjs"),
    "gate-release",
    projectFile,
  ]);
});

try {
  const failed = results.filter((result) => result.status === "fail");
  console.log(
    JSON.stringify(
      {
        status: failed.length === 0 ? "pass" : "fail",
        tests: results.length,
        passed: results.length - failed.length,
        failed,
      },
      null,
      2,
    ),
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
