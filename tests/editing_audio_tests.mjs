#!/usr/bin/env node
// Synthetic timing/mix evidence only: these tests do not establish dialogue
// separation quality, natural listening quality, music taste or human approval.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeMaterialProject, inspectMaterial, composeMaterialProject, renderMaterialProject } from "../scripts/material_project.mjs";
import { evaluateAudioStems } from "../scripts/audio_stem_qc.mjs";
import { measureSfxPeak } from "../scripts/sfx_peak_alignment.mjs";
import { run, readJson, fileIdentity } from "../scripts/kacha_utils.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-editing-audio-"));
const checks = [];
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
function execute(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, String(result.stderr));
  return result;
}
const ff = args => execute("ffmpeg", ["-hide_banner", "-v", "error", "-nostdin", "-n", ...args]);
function samples(file) {
  const result = execute("ffmpeg", ["-v", "error", "-nostdin", "-i", file,
    "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { encoding: null });
  return Array.from({ length: result.stdout.length / 4 }, (_, index) => result.stdout.readFloatLE(index * 4));
}
function rms(data, start, end) {
  const from = Math.round(start * 48000), to = Math.min(data.length, Math.round(end * 48000));
  assert.ok(to > from, "measurement interval must contain decoded samples");
  let sum = 0;
  for (let index = from; index < to; index++) sum += data[index] ** 2;
  return Math.sqrt(sum / (to - from));
}
function audibleBounds(data) {
  const active = [];
  for (let index = 0; index + 480 <= data.length; index += 480) {
    let energy = 0;
    for (let offset = 0; offset < 480; offset++) energy += data[index + offset] ** 2;
    if (Math.sqrt(energy / 480) > 0.001) active.push(index / 48000);
  }
  return active.length ? [active[0], active.at(-1) + 0.01] : null;
}
try {
  const source = path.join(root, "delayed-audio.mkv");
  ff(["-f", "lavfi", "-i", "color=c=red:s=160x90:r=25:d=4", "-itsoffset", "1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:v", "ffv1", "-c:a", "pcm_s16le", source]);
  const probe = JSON.parse(execute("ffprobe", ["-v", "error", "-show_streams", "-of", "json", source]).stdout);
  assert.equal(Number(probe.streams.find(stream => stream.codec_type === "audio").start_time), 1);
  const runtime = { sourceRef: "synthetic-development-test", productionReady: false };
  for (const [name, sourceIn, duration, expected] of [
    ["full", 0, 4, [1, 2]], ["nonzero", 0.4, 2, [0.6, 1.6]],
    ["half-frame", 0.5, 2, [0.5, 1.5]], ["before-audio", 0, 1, null], ["after-audio", 3, 1, null],
  ]) {
    const projectRoot = path.join(root, name);
    initializeMaterialProject({ materials: [source], requirements: "Preserve source audio/video timing",
      projectRoot, duration, width: 160, fps: 25, development: true, confirmExecute: true, runtime });
    const project = readJson(path.join(projectRoot, ".kacha/material-project.json"));
    const brief = readJson(project.brief.path), asset = project.assets[0];
    inspectMaterial(projectRoot, asset.id, { timestamps: [sourceIn] });
    const storyboard = path.join(root, `${name}.json`);
    write(storyboard, { schemaVersion: "1.0", kind: "kacha_material_storyboard", projectDigest: project.digest,
      briefDigest: brief.digest, interpretation: "Keep the selected source and its delayed audio aligned",
      requirements: [{ id: "sync", text: "Preserve source timing", check: "semantic", assetIds: [] }],
      segments: [{ id: "shot", assetId: asset.id, sourceIn, duration, fit: "contain", audio: "source",
        role: "hold", observation: "Synthetic red picture; tone from source second one to two",
        reason: "Test the selected interval", satisfies: ["sync"] }] });
    composeMaterialProject(projectRoot, storyboard);
    const rendered = renderMaterialProject(projectRoot);
    const frames = JSON.parse(execute("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "json", rendered.candidate.path]).stdout);
    assert.equal(Number(frames.streams[0].nb_read_frames), Math.round(duration * 25), name);
    const bounds = audibleBounds(samples(rendered.candidate.path));
    if (expected) {
      assert.ok(bounds, `${name}: selected source tone disappeared`);
      for (let index = 0; index < 2; index++) assert.ok(Math.abs(bounds[index] - expected[index]) <= 1 / 25,
        `${name}: sound boundary ${bounds[index]} differs from ${expected[index]} by more than one frame`);
    } else assert.equal(bounds, null, `${name}: silent source interval acquired audio`);
  }
  checks.push("material-delayed-audio-nonzero-and-half-frame-seeks-preserve-timing-and-frame-count",
    "material-selections-before-and-after-source-audio-remain-silent");

  const dialogue = path.join(root, "dialogue.wav"), mix = path.join(root, "mix.wav"), exact = path.join(root, "exact.mkv");
  ff(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-ac", "2", "-c:a", "pcm_s24le", dialogue]);
  ff(["-i", dialogue, "-af", "alimiter=limit=0.630957:level=false", "-c:a", "pcm_s24le", mix]);
  ff(["-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=2", "-i", mix,
    "-map", "0:v", "-map", "1:a", "-c:v", "ffv1", "-c:a", "copy", exact]);
  const qcConfig = { measurementTargetLufs: -21, measurementTruePeakDbtp: -4, measurementLoudnessRange: 5,
    mixStemReconstructionPsnrMinDb: 70, finalMixPsnrMinDb: 24 };
  const evaluate = (finalVideo, finalDurationSeconds) => evaluateAudioStems({ projectFile: path.join(root, "project.json"),
    project: { expectedMedia: { audioMix: { bgmRequired: false, masterTruePeakDb: -4 } }, outputs: { audioStems: { dialogue, mix } } },
    qcConfig, finalDurationSeconds, finalVideo });
  const exactResult = evaluate(exact, 2);
  assert.equal(exactResult.status, "pass", JSON.stringify(exactResult.checks.filter(item => item.status === "fail")));
  assert.equal(exactResult.measurements.finalMixComparison.exactMatch, true);
  const wrongTail = path.join(root, "wrong-tail.mp4");
  ff(["-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=8", "-i", mix, "-f", "lavfi", "-i",
    "sine=frequency=2000:sample_rate=48000:duration=6", "-filter_complex",
    "[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a];[2:a]aformat=sample_rates=48000:channel_layouts=stereo[b];[a][b]concat=n=2:v=0:a=1[out]",
    "-map", "0:v", "-map", "[out]", "-c:v", "libx264", "-c:a", "aac", "-b:a", "320k", wrongTail]);
  const failed = evaluate(wrongTail, 8);
  assert.equal(failed.status, "fail");
  for (const id of ["dialogue_stem_full_duration", "mix_stem_full_duration", "final_audio_matches_mix_stem"])
    assert.equal(failed.checks.find(item => item.id === id)?.status, "fail", id);
  assert.ok(failed.measurements.finalMixComparison.similaritySnrDb < 0, "comparison must consume the wrong tail, not just reject short metadata");
  checks.push("exact-lossless-final-audio-passes-mix-proof", "short-stems-and-correct-prefix-cannot-hide-six-second-wrong-tail");

  const silentMix = path.join(root, "silent.wav"), silentVideo = path.join(root, "silent.mkv");
  ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2", "-c:a", "pcm_s24le", silentMix]);
  ff(["-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=2", "-i", silentMix, "-c:v", "ffv1", "-c:a", "copy", "-shortest", silentVideo]);
  const silentProjectFile=path.join(root,"silent-project.json");
  const silentProject={projectId:"silent-montage",productionPack:"clean-editorial",show:"montage",expectedMedia:{audioMix:{dialogueRequired:false,silenceAllowed:true,bgmRequired:false,adaptiveBgmRequired:false}},outputs:{finalVideo:silentVideo,audioStems:{mix:silentMix}}};
  const silenceQc=project=>evaluateAudioStems({projectFile:silentProjectFile,project,qcConfig,finalDurationSeconds:2,finalVideo:silentVideo});
  assert.equal(silenceQc(silentProject).status,"pass");
  const requiredDialogue=structuredClone(silentProject);requiredDialogue.expectedMedia.audioMix.dialogueRequired=true;
  assert.equal(silenceQc(requiredDialogue).checks.find(c=>c.id==="dialogue_stem_declared").status,"fail");
  const wrongBrand=structuredClone(silentProject);wrongBrand.productionPack="dahui-ai";assert.equal(silenceQc(wrongBrand).status,"fail");
  const audible=structuredClone(silentProject);audible.outputs.audioStems.mix=mix;
  assert.equal(silenceQc(audible).checks.find(c=>c.id==="mix_stem_reconstruction").status,"fail");
  const missingMix=structuredClone(silentProject);delete missingMix.outputs.audioStems.mix;assert.equal(silenceQc(missingMix).status,"fail");
  write(silentProjectFile,silentProject);const silentQcFile=path.join(root,"silent-qc.json");
  execute(process.execPath,[path.join(repository,"scripts/qc_media.mjs"),silentProjectFile,"--output",silentQcFile]);
  assert.equal(readJson(silentQcFile).automaticChecks.filter(c=>c.status==="fail").length,0);
  const incremental=path.join(root,"silent-incremental");
  execute(process.execPath,[path.join(repository,"scripts/init_incremental_project.mjs"),silentVideo,"--project-id",silentProject.projectId,"--output-dir",incremental,"--project-manifest",silentProjectFile]);
  const contextFile=path.join(incremental,"project-context.json"),indexFile=path.join(incremental,"artifact-index.json");
  assert.equal(readJson(contextFile).delivery.audioContract.audioMix.silenceAllowed,true);
  execute(process.execPath,[path.join(repository,"scripts/validate_project_context.mjs"),contextFile,"--full-hash"]);
  const delta=path.join(incremental,"delta.json");write(delta,{synthetic:true});const manifest=path.join(incremental,"incremental-project.json");
  execute(process.execPath,[path.join(repository,"scripts/create_incremental_manifest.mjs"),contextFile,delta,indexFile,"--output",manifest,"--mix-stem",silentMix]);
  const inherited=readJson(manifest);assert.equal(inherited.productionPack,"clean-editorial");assert.equal(inherited.show,"montage");assert.equal(inherited.expectedMedia.audioMix.silenceAllowed,true);
  assert.equal(evaluateAudioStems({projectFile:manifest,project:inherited,qcConfig,finalDurationSeconds:2,finalVideo:silentVideo}).status,"pass");
  const tampered=readJson(contextFile);tampered.productionProfile.packId="dahui-ai";write(contextFile,tampered);
  assert.notEqual(run(process.execPath,[path.join(repository,"scripts/validate_project_context.mjs"),contextFile,"--full-hash"]).status,0);
  checks.push("incremental-manifest-inherits-bound-production-and-audio-contract-and-rejects-tampering");
  checks.push("explicit-silent-montage-passes-real-stem-and-media-qc-with-current-mix", "silent-exception-cannot-hide-required-dialogue-wrong-brand-audible-or-missing-mix");

  const bgm = path.join(root, "loop.wav"), sfx = path.join(root, "impact.wav");
  ff(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=0.5", "-c:a", "pcm_s24le", bgm]);
  ff(["-f", "lavfi", "-i", "aevalsrc=if(between(t\\,0.4\\,0.5)\\,0.3*sin(2*PI*880*t)\\,0):s=48000:d=1",
    "-c:a", "pcm_s24le", sfx]);
  const timeline = path.join(root, "mix-timeline.json"), bgmStem = path.join(root, "bgm.wav"), sfxStem = path.join(root, "sfx.wav");
  write(timeline, { schemaVersion: "1.0", projectId: "synthetic-audio-behavior", mode: "preview", source: fileIdentity(source),
    edl: [{ id: "full", sourceStart: 0, sourceEnd: 4 }], visual: { overlays: [] },
    audio: { masterTruePeakDb: -4, bgm: { ...fileIdentity(bgm), levelBelowDialogueDb: 18,
      sidechain: { threshold: 0.01, ratio: 8, attackMs: 10, releaseMs: 100 } },
      sfx: [{ ...fileIdentity(sfx), targetLandingSeconds: 2.5, levelBelowDialogueDb: 10 }] },
    output: { path: path.join(root, "mixed.mp4"), width: 160, height: 90, fps: 25, bgmStem, sfxStem } });
  execute(process.execPath, [path.join(repository, "scripts/timeline_ir.mjs"), "render", "--plan", timeline]);
  const music = samples(bgmStem);
  assert.equal(music.length, 4 * 48000, "short BGM source must cover every timeline sample");
  assert.ok(rms(music, 3.99, 4) > 0.001, "BGM tail must contain music, not padded silence");
  assert.ok(rms(music, 3.3, 3.7) > 0.001, "BGM must remain audible after source dialogue ends");
  const reduction = 20 * Math.log10(rms(music, 0.3, 0.7) / rms(music, 1.3, 1.7));
  assert.ok(reduction > 3, `sidechain should lower music during source speech; measured ${reduction} dB`);
  const landing = measureSfxPeak(sfxStem).measuredPeakOffsetSeconds;
  assert.ok(Math.abs(landing - 2.5) <= 1 / 25, `rendered SFX peak landed at ${landing}, not target 2.5`);
  checks.push("decoded-bgm-loops-ducks-during-dialogue-and-survives-dialogue-end", "rendered-sfx-peak-lands-within-one-frame");
  const compressedBgm = path.join(root, "loop-44100.m4a");
  ff(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=0.5", "-c:a", "aac", compressedBgm]);
  const sourceLong = path.join(root, "long-source.mkv");
  ff(["-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=6", "-itsoffset", "1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:v", "ffv1", "-c:a", "pcm_s16le", sourceLong]);
  for (const [name, duration, segmented] of [["wave-tail-1", 4, false], ["wave-tail-2", 4, false],
    ["aac-tail", 3.88, false], ["aac-partial-block", 4.04, false], ["aac-segment", 4.04, true]]) {
    const candidate = readJson(timeline), wave = name.startsWith("wave");
    candidate.source = fileIdentity(sourceLong);candidate.edl[0].sourceEnd = duration;
    candidate.audio.bgm = { ...candidate.audio.bgm, ...fileIdentity(wave ? bgm : compressedBgm) };
    if (segmented) candidate.audio.bgm = { sidechain: candidate.audio.bgm.sidechain, segments: [{
      ...fileIdentity(compressedBgm), start: 0, end: duration, sourceStart: 0.3,
      fadeInSeconds: 0, fadeOutSeconds: 0, levelBelowDialogueDb: 18 }] };
    candidate.output = { ...candidate.output, path: path.join(root, name + ".mp4"),
      bgmStem: path.join(root, name + "-bgm.wav"), sfxStem: path.join(root, name + "-sfx.wav"), mixStem: path.join(root, name + "-mix.wav") };
    const file = path.join(root, name + ".json");write(file, candidate);
    execute(process.execPath, [path.join(repository, "scripts/timeline_ir.mjs"), "render", "--plan", file]);
    const decoded = samples(candidate.output.bgmStem);
    assert.equal(decoded.length, Math.round(duration * 48000), `${name}: BGM sample coverage`);
    assert.ok(rms(decoded, duration - 0.01, duration) > 0.001, `${name}: real music through the last sample block`);
    assert.equal(samples(candidate.output.mixStem).length, Math.round(duration * 48000), `${name}: mix sample coverage`);
  }
  checks.push("looped-wav-and-compressed-bgm-preserve-exact-audible-tail-through-sidechain");
  console.log(JSON.stringify({ status: "pass", checks, scope: "Synthetic decoded-media regression; not human listening or final creative acceptance" }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
