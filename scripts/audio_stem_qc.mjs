import fs from "node:fs";
import path from "node:path";
import {
  mediaSummary,
  readJson,
  resolveFrom,
  run,
} from "./kacha_utils.mjs";

function entryPath(entry) {
  return typeof entry === "string" ? entry : entry?.path;
}

function check(id, pass, actual, expected) {
  return {
    id,
    status: pass ? "pass" : "fail",
    severity: "error",
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

function measureStem(file, qcConfig) {
  const probe = mediaSummary(file);
  const result = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    "-i",
    file,
    "-af",
    `loudnorm=I=${qcConfig.measurementTargetLufs}:`
      + `TP=${qcConfig.measurementTruePeakDbtp}:`
      + `LRA=${qcConfig.measurementLoudnessRange}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  const loudness = parseLoudnorm(result.stderr);
  if (result.status !== 0 || !loudness) {
    throw new Error(`无法测量 stem：${file}`);
  }
  return {
    path: file,
    durationSeconds: probe.audioDuration || probe.duration,
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    integratedLufs: Number(loudness.input_i),
    truePeakDbtp: Number(loudness.input_tp),
    loudnessRangeLu: Number(loudness.input_lra),
  };
}

function measureStemIntervals(file, intervals, qcConfig) {
  if (!Array.isArray(intervals) || intervals.length === 0) return null;
  const selection = intervals.map(({ start, end }) => (
    `between(t\\,${Number(start).toFixed(6)}\\,${Number(end).toFixed(6)})`
  )).join("+");
  const temporary = path.join(
    path.dirname(file),
    `.kacha-qc-intervals-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`,
  );
  const result = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", file,
    "-af", `aselect='${selection}',asetpts=N/SR/TB`,
    "-c:a", "pcm_s24le",
    temporary,
  ]);
  if (result.status !== 0) {
    throw new Error(`无法提取自适应 BGM 计划区间：${result.stderr.trim()}`);
  }
  try {
    return measureStem(temporary, qcConfig);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseAstatsRms(stderr) {
  const values = [...String(stderr).matchAll(
    /RMS level dB:\s*(-inf|inf|[-+]?\d+(?:\.\d+)?)/gi,
  )].map((match) => {
    const value = match[1].toLowerCase();
    if (value === "-inf") return Number.NEGATIVE_INFINITY;
    if (value === "inf") return Number.POSITIVE_INFINITY;
    return Number(value);
  });
  return values.length > 0 ? values.at(-1) : null;
}

function measureResidualSimilarity(firstFile, referenceFile) {
  const common = "aresample=48000:async=0:first_pts=0,"
    + "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
    + "asetpts=N/SR/TB";
  const residual = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    "-i",
    firstFile,
    "-i",
    referenceFile,
    "-filter_complex",
    `[0:a]${common}[candidate];`
      + `[1:a]${common}[reference];`
      + "[candidate][reference]amerge=inputs=2[merged];"
      + "[merged]pan=stereo|c0=c0-c2|c1=c1-c3,"
      + "astats=metadata=0:reset=0",
    "-f",
    "null",
    "-",
  ]);
  const reference = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    "-i",
    referenceFile,
    "-af",
    `${common},astats=metadata=0:reset=0`,
    "-f",
    "null",
    "-",
  ]);
  const residualRmsDb = parseAstatsRms(residual.stderr);
  const referenceRmsDb = parseAstatsRms(reference.stderr);
  const exactMatch = residualRmsDb === Number.NEGATIVE_INFINITY;
  const similaritySnrDb = exactMatch
    ? null
    : Number.isFinite(referenceRmsDb) && Number.isFinite(residualRmsDb)
      ? Number((referenceRmsDb - residualRmsDb).toFixed(3))
      : null;
  return {
    status: residual.status === 0 && reference.status === 0 ? 0 : 1,
    exactMatch,
    similaritySnrDb,
    referenceRmsDb,
    residualRmsDb: exactMatch ? null : residualRmsDb,
    diagnostic: residual.status === 0 && reference.status === 0
      ? null
      : `${residual.stderr}\n${reference.stderr}`.trim(),
  };
}

function compareReconstructedMix(
  files,
  mixFile,
  durationSeconds,
  masterTruePeakDb,
) {
  const ordered = [
    ["dialogue", files.dialogue],
    ["bgm", files.bgm],
    ["sfx", files.sfx],
  ].filter(([, file]) => Boolean(file));
  if (ordered.length === 0) {
    return { status: 1, similaritySnrDb: null, diagnostic: "no component stems" };
  }
  const command = ["-hide_banner", "-nostats", "-nostdin"];
  ordered.forEach(([, file]) => command.push("-i", file));
  const normalized = ordered.map(([name], index) => {
    const label = `component${index}`;
    return {
      label,
      filter: `[${index}:a]aresample=48000:async=0:first_pts=0,`
        + "aformat=sample_rates=48000:channel_layouts=stereo"
        + `[${label}]`,
    };
  });
  const filters = [
    ...normalized.map((item) => item.filter),
    `${normalized.map((item) => `[${item.label}]`).join("")}`
      + `amix=inputs=${normalized.length}:normalize=0:duration=longest:`
      + `dropout_transition=0,atrim=0:${Number(durationSeconds).toFixed(6)},`
      + `alimiter=limit=${(10 ** (Number(masterTruePeakDb) / 20)).toFixed(6)}:`
      + "level=false[reconstructed]",
  ];
  const reconstructedFile = path.join(
    path.dirname(mixFile),
    `.kacha-qc-reconstructed-${process.pid}-${Date.now()}.wav`,
  );
  filters.push("[reconstructed]anull[reconstructedOut]");
  command.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[reconstructedOut]",
    "-c:a",
    "pcm_s24le",
    "-y",
    reconstructedFile,
  );
  const result = run("ffmpeg", command);
  if (result.status !== 0) {
    return {
      status: result.status,
      similaritySnrDb: null,
      diagnostic: result.stderr.trim(),
    };
  }
  try {
    return measureResidualSimilarity(reconstructedFile, mixFile);
  } finally {
    fs.rmSync(reconstructedFile, { force: true });
  }
}

export function evaluateAudioStems({
  projectFile,
  project,
  qcConfig,
  finalDurationSeconds,
  finalVideo = null,
}) {
  const contract = project.expectedMedia?.audioMix;
  const declared = project.outputs?.audioStems;
  if (!contract && !declared) return null;

  const checks = [];
  const measurements = {};
  const required = contract?.bgmRequired === true;
  const adaptiveRequired = contract?.adaptiveBgmRequired === true;
  const dialogueEntry = declared?.dialogue ?? declared?.voice;
  const bgmEntry = declared?.bgm;
  const sfxEntry = declared?.sfx;
  const mixEntry = declared?.mix;
  const dialogueFile = dialogueEntry
    ? resolveFrom(projectFile, entryPath(dialogueEntry))
    : null;
  const bgmFile = bgmEntry
    ? resolveFrom(projectFile, entryPath(bgmEntry))
    : null;
  const sfxFile = sfxEntry
    ? resolveFrom(projectFile, entryPath(sfxEntry))
    : null;
  const mixFile = mixEntry
    ? resolveFrom(projectFile, entryPath(mixEntry))
    : null;
  const adaptivePlanEntry = project.plans?.adaptiveBgm;
  const adaptivePlanFile = adaptivePlanEntry
    ? resolveFrom(projectFile, entryPath(adaptivePlanEntry))
    : null;
  let adaptivePlan = null;
  checks.push(check(
    "adaptive_bgm_plan_declared",
    !adaptiveRequired || Boolean(adaptivePlanFile),
    adaptivePlanFile ?? "missing",
    adaptiveRequired ? "plans.adaptiveBgm" : "optional",
  ));
  if (adaptivePlanFile) {
    const exists = fs.existsSync(adaptivePlanFile) && fs.statSync(adaptivePlanFile).isFile();
    checks.push(check(
      "adaptive_bgm_plan_exists",
      exists,
      adaptivePlanFile,
      "existing adaptive BGM plan",
    ));
    if (exists) {
      try {
        adaptivePlan = readJson(adaptivePlanFile);
        checks.push(check(
          "adaptive_bgm_plan_shape",
          adaptivePlan.kind === "kacha-adaptive-bgm-plan"
            && Array.isArray(adaptivePlan.scenes)
            && adaptivePlan.scenes.length > 0,
          adaptivePlan.kind ?? "unknown",
          "validated kacha-adaptive-bgm-plan",
        ));
      } catch (error) {
        checks.push(check(
          "adaptive_bgm_plan_shape",
          false,
          error.message,
          "readable adaptive BGM plan",
        ));
      }
    }
  }

  checks.push(check(
    "dialogue_stem_declared",
    Boolean(dialogueFile),
    dialogueFile ?? "missing",
    "outputs.audioStems.dialogue or outputs.audioStems.voice",
  ));
  checks.push(check(
    "bgm_stem_declared",
    !required || Boolean(bgmFile),
    bgmFile ?? "missing",
    required ? "outputs.audioStems.bgm" : "optional",
  ));
  checks.push(check(
    "final_mix_stem_declared",
    !required || Boolean(mixFile),
    mixFile ?? "missing",
    required ? "outputs.audioStems.mix" : "optional",
  ));

  for (const [name, file] of [
    ["dialogue", dialogueFile],
    ["bgm", bgmFile],
    ["sfx", sfxFile],
    ["mix", mixFile],
  ]) {
    if (!file) continue;
    const exists = fs.existsSync(file) && fs.statSync(file).isFile();
    checks.push(check(
      `${name}_stem_exists`,
      exists,
      file,
      "existing audio stem",
    ));
    if (!exists) continue;
    try {
      measurements[name] = measureStem(file, qcConfig);
      checks.push(check(
        `${name}_stem_loudness_analysis`,
        Number.isFinite(measurements[name].integratedLufs),
        measurements[name],
        "finite integrated loudness measurement",
      ));
    } catch (error) {
      checks.push(check(
        `${name}_stem_loudness_analysis`,
        false,
        error.message,
        "valid loudnorm measurement",
      ));
    }
  }

  let bgmBelowDialogueDb = null;
  if (measurements.dialogue && measurements.bgm) {
    const musicIntervals = (adaptivePlan?.scenes ?? [])
      .filter((scene) => scene.mode === "music")
      .map((scene) => ({ start: Number(scene.start), end: Number(scene.end) }))
      .filter((scene) => Number.isFinite(scene.start) && Number.isFinite(scene.end));
    let comparisonDialogue = measurements.dialogue;
    let comparisonBgm = measurements.bgm;
    if (musicIntervals.length > 0) {
      try {
        comparisonDialogue = measureStemIntervals(dialogueFile, musicIntervals, qcConfig);
        comparisonBgm = measureStemIntervals(bgmFile, musicIntervals, qcConfig);
        measurements.adaptiveBgmOverlap = {
          intervals: musicIntervals,
          dialogue: comparisonDialogue,
          bgm: comparisonBgm,
        };
        checks.push(check(
          "adaptive_bgm_overlap_measurement",
          true,
          `${musicIntervals.length} planned music intervals`,
          "measure dialogue and BGM only where music is planned",
        ));
      } catch (error) {
        checks.push(check(
          "adaptive_bgm_overlap_measurement",
          false,
          error.message,
          "measurable planned music intervals",
        ));
      }
    }
    bgmBelowDialogueDb = Number(
      (comparisonDialogue.integratedLufs - comparisonBgm.integratedLufs)
        .toFixed(2),
    );
    const minimum = Number(
      contract?.bgmBelowDialogueDbMin
        ?? qcConfig.bgmBelowDialogueMinDb,
    );
    const maximum = Number(
      contract?.bgmBelowDialogueDbMax
        ?? qcConfig.bgmBelowDialogueMaxDb,
    );
    checks.push(check(
      "bgm_perceptibility",
      bgmBelowDialogueDb >= minimum && bgmBelowDialogueDb <= maximum,
      `${bgmBelowDialogueDb} dB below dialogue`,
      `${minimum} to ${maximum} dB below dialogue`,
    ));

    const coverage = finalDurationSeconds > 0
      ? measurements.bgm.durationSeconds / finalDurationSeconds
      : 0;
    const minimumCoverage = Number(
      contract?.bgmMinimumCoverageRatio
        ?? qcConfig.bgmMinimumCoverageRatio,
    );
    checks.push(check(
      "bgm_duration_coverage",
      coverage >= minimumCoverage,
      Number(coverage.toFixed(4)),
      `>= ${minimumCoverage}`,
    ));
  }

  const mixExists = Boolean(
    mixFile && fs.existsSync(mixFile) && fs.statSync(mixFile).isFile(),
  );
  if (mixExists) {
    const masterTruePeakDb = Number(contract?.masterTruePeakDb ?? -4);
    const reconstruction = compareReconstructedMix(
      { dialogue: dialogueFile, bgm: bgmFile, sfx: sfxFile },
      mixFile,
      finalDurationSeconds,
      masterTruePeakDb,
    );
    measurements.mixReconstruction = reconstruction;
    const threshold = Number(qcConfig.mixStemReconstructionPsnrMinDb);
    checks.push(check(
      "mix_stem_reconstruction",
      reconstruction.status === 0
        && (
          reconstruction.exactMatch === true
          || (
            reconstruction.similaritySnrDb !== null
            && reconstruction.similaritySnrDb >= threshold
          )
        ),
      reconstruction,
      `component stems reconstruct final mix at >= ${threshold} dB residual SNR`,
    ));

    const resolvedFinal = finalVideo ? path.resolve(finalVideo) : null;
    const finalExists = Boolean(
      resolvedFinal
      && fs.existsSync(resolvedFinal)
      && fs.statSync(resolvedFinal).isFile(),
    );
    checks.push(check(
      "final_audio_available_for_mix_proof",
      finalExists,
      resolvedFinal ?? "missing",
      "existing final video with decoded audio",
    ));
    if (finalExists) {
      const finalComparison = measureResidualSimilarity(resolvedFinal, mixFile);
      measurements.finalMixComparison = finalComparison;
      const finalThreshold = Number(qcConfig.finalMixPsnrMinDb);
      checks.push(check(
        "final_audio_matches_mix_stem",
        finalComparison.status === 0
          && finalComparison.similaritySnrDb !== null
          && finalComparison.similaritySnrDb >= finalThreshold,
        finalComparison,
        `decoded final audio matches mix stem at >= ${finalThreshold} dB residual SNR`,
      ));
    }
  }

  const failures = checks.filter((item) => item.status === "fail");
  return {
    status: failures.length > 0 ? "fail" : "pass",
    contract: {
      bgmRequired: required,
      adaptiveBgmRequired: adaptiveRequired,
      adaptiveBgmPlan: adaptivePlanFile,
      masterTruePeakDb: Number(contract?.masterTruePeakDb ?? -4),
      bgmBelowDialogueDbMin: Number(
        contract?.bgmBelowDialogueDbMin
          ?? qcConfig.bgmBelowDialogueMinDb,
      ),
      bgmBelowDialogueDbMax: Number(
        contract?.bgmBelowDialogueDbMax
          ?? qcConfig.bgmBelowDialogueMaxDb,
      ),
      bgmMinimumCoverageRatio: Number(
        contract?.bgmMinimumCoverageRatio
          ?? qcConfig.bgmMinimumCoverageRatio,
      ),
      mixStemReconstructionPsnrMinDb: Number(
        qcConfig.mixStemReconstructionPsnrMinDb,
      ),
      finalMixPsnrMinDb: Number(qcConfig.finalMixPsnrMinDb),
    },
    measurements,
    bgmBelowDialogueDb,
    checks,
  };
}
