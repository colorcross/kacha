#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { ffprobe, fileIdentity, fileIdentityMatches, readJson, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function listOption(name) {
  const raw = option(name, "");
  return raw.split("|").map((item) => item.trim()).filter(Boolean);
}

function fail(message, code = 1) {
  console.error(JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2));
  process.exit(code);
}

function mediaTechnical(file) {
  const probe = ffprobe(file);
  const video = probe.streams?.find((stream) => stream.codec_type === "video") ?? null;
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio") ?? null;
  const duration = Number(probe.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const rate = String(video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationSeconds: Number(duration.toFixed(3)),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: rate[1] ? Number((rate[0] / rate[1]).toFixed(3)) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null
  };
}

function validateAnalysis(value, { requireDigest = true } = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["reference analysis root must be an object"];
  if (value.schemaVersion !== "1.0" || value.kind !== "kacha-reference-analysis") errors.push("invalid analysis identity");
  if (!value.source?.identity?.sha256 || typeof value.source.identity.path !== "string") errors.push("source identity is required");
  else if (!fileIdentityMatches(value.source.identity.path, value.source.identity)) errors.push("reference source identity is stale or unavailable");
  if (!new Set(["owned", "licensed", "fair-use-review", "unknown"]).has(value.rights?.status)) errors.push("invalid rights status");
  if (!new Set(["analysis-only", "principle-derivation"]).has(value.rights?.permittedUse)) errors.push("invalid permittedUse");
  const evidenceRequired = new Set(["licensed", "fair-use-review"]).has(value.rights?.status);
  const expectedDerivation = value.rights?.status !== "unknown"
    && value.rights?.permittedUse === "principle-derivation"
    && (!evidenceRequired || Boolean(value.rights?.evidenceRef));
  if (value.rights?.derivationAllowed !== expectedDerivation) errors.push("rights.derivationAllowed is inconsistent with status, permittedUse or evidence");
  if (!value.boundaries || !Array.isArray(value.boundaries.keepAsAbstractPrinciples) || !Array.isArray(value.boundaries.changeForKachaAndCreator) || !Array.isArray(value.boundaries.doNotCopy) || value.boundaries.doNotCopy.length === 0) errors.push("keep/change/doNotCopy boundaries are required");
  if (!value.technical || !Number.isFinite(value.technical.durationSeconds)) errors.push("technical probe is required");
  if (requireDigest && !/^[a-f0-9]{64}$/i.test(value.analysisDigest ?? "")) errors.push("analysisDigest is required");
  if (value.analysisDigest) {
    const copy = structuredClone(value);
    delete copy.analysisDigest;
    if (value.analysisDigest !== sha256Value(copy)) errors.push("analysisDigest mismatch");
  }
  return errors;
}

function validatePlan(value, { requireDigest = true } = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["reference plan root must be an object"];
  if (value.schemaVersion !== "1.0" || value.kind !== "kacha-reference-derived-plan") errors.push("invalid derived plan identity");
  if (!value.referenceAnalysisDigest) errors.push("referenceAnalysisDigest is required");
  for (const key of ["keep", "change", "doNotCopy"]) if (!Array.isArray(value.translation?.[key]) || (key === "doNotCopy" && value.translation[key].length === 0)) errors.push(`translation.${key} must be ${key === "doNotCopy" ? "a non-empty" : "an"} array`);
  if (value.originality?.shotForShotCopyAllowed !== false) errors.push("shotForShotCopyAllowed must be false");
  if (!Array.isArray(value.productionConstraints)) errors.push("productionConstraints must be an array");
  if (value.referenceAnalysis) {
    try {
      const analysis = readJson(path.resolve(value.referenceAnalysis));
      const analysisErrors = validateAnalysis(analysis);
      if (analysisErrors.length > 0) errors.push(`reference analysis invalid: ${analysisErrors.join(", ")}`);
      if (analysis.analysisDigest !== value.referenceAnalysisDigest) errors.push("referenceAnalysisDigest no longer matches the analysis artifact");
      if (analysis.rights?.derivationAllowed !== true) errors.push("reference analysis does not authorize principle derivation");
    } catch (error) {
      errors.push(`reference analysis unavailable: ${error.message}`);
    }
  } else errors.push("referenceAnalysis is required");
  if (requireDigest && !/^[a-f0-9]{64}$/i.test(value.planDigest ?? "")) errors.push("planDigest is required");
  if (value.planDigest) {
    const copy = structuredClone(value);
    delete copy.planDigest;
    if (value.planDigest !== sha256Value(copy)) errors.push("planDigest mismatch");
  }
  return errors;
}

if (!new Set(["analyze", "derive", "validate"]).has(action)) {
  fail("usage: kacha.mjs reference analyze|derive|validate [options]", 2);
}

if (action === "analyze") {
  const input = option("--input");
  const output = option("--output");
  if (!input || !output) fail("analyze requires --input and --output", 2);
  if (/^https?:\/\//i.test(input)) fail("network reference download is not implicit; download with a rights-aware external workflow, then pass a local file", 2);
  const file = path.resolve(input);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`reference file does not exist: ${file}`, 2);
  const rightsStatus = option("--rights-status", "unknown");
  if (!new Set(["owned", "licensed", "fair-use-review", "unknown"]).has(rightsStatus)) fail("--rights-status must be owned|licensed|fair-use-review|unknown", 2);
  const permittedUse = option("--permitted-use", rightsStatus === "owned" ? "principle-derivation" : "analysis-only");
  if (!new Set(["analysis-only", "principle-derivation"]).has(permittedUse)) fail("--permitted-use must be analysis-only|principle-derivation", 2);
  const rightsEvidence = option("--rights-evidence");
  const evidenceRequired = new Set(["licensed", "fair-use-review"]).has(rightsStatus);
  const derivationAllowed = rightsStatus !== "unknown"
    && permittedUse === "principle-derivation"
    && (!evidenceRequired || Boolean(rightsEvidence));
  const value = {
    schemaVersion: "1.0",
    kind: "kacha-reference-analysis",
    status: derivationAllowed ? "pass" : "limited",
    analyzedAt: new Date().toISOString(),
    source: {
      type: "local-file",
      identity: fileIdentity(file),
      sourceUrl: option("--source-url"),
      creator: option("--creator"),
      title: option("--title", path.basename(file))
    },
    rights: {
      status: rightsStatus,
      evidenceRef: rightsEvidence,
      permittedUse,
      derivationAllowed,
      limitation: derivationAllowed
        ? null
        : rightsStatus === "unknown"
          ? "Rights are unverified; derivation is blocked until reviewed."
          : evidenceRequired && !rightsEvidence
            ? "Licensed or fair-use derivation requires an explicit rights evidence reference."
            : "The recorded permitted use is analysis-only; principle derivation is blocked."
    },
    technical: mediaTechnical(file),
    observations: {
      narrativeStructure: listOption("--narrative"),
      pacingPatterns: listOption("--pacing"),
      visualGrammar: listOption("--visual-grammar"),
      soundGrammar: listOption("--sound-grammar"),
      audiencePromise: option("--audience-promise")
    },
    boundaries: {
      keepAsAbstractPrinciples: listOption("--keep"),
      changeForKachaAndCreator: listOption("--change"),
      doNotCopy: listOption("--do-not-copy").length > 0
        ? listOption("--do-not-copy")
        : ["exact shots", "unique wording", "creator identity", "logos and protected graphics", "music and source media"]
    },
    limitations: [
      "Technical properties are measured from the local file.",
      "Creative observations are explicit operator inputs; no hidden visual-semantic model claim is made."
    ]
  };
  const errors = validateAnalysis(value, { requireDigest: false });
  if (errors.length > 0) fail(errors.join("; "));
  value.analysisDigest = sha256Value(value);
  writeJsonAtomic(output, value);
  console.log(JSON.stringify({ schemaVersion: "1.0", status: value.status, output: path.resolve(output), analysisDigest: value.analysisDigest, rights: value.rights }, null, 2));
  process.exit(0);
}

if (action === "derive") {
  const analysisFile = option("--analysis");
  const output = option("--output");
  if (!analysisFile || !output) fail("derive requires --analysis and --output", 2);
  const analysis = readJson(path.resolve(analysisFile));
  const analysisErrors = validateAnalysis(analysis);
  if (analysisErrors.length > 0) fail(analysisErrors.join("; "));
  if (analysis.rights.derivationAllowed !== true) fail("reference rights do not authorize principle derivation; record permittedUse and required evidence first");
  const value = {
    schemaVersion: "1.0",
    kind: "kacha-reference-derived-plan",
    status: "pass",
    derivedAt: new Date().toISOString(),
    referenceAnalysis: path.resolve(analysisFile),
    referenceAnalysisDigest: analysis.analysisDigest ?? sha256Value(analysis),
    target: {
      creator: option("--target-creator", "行者大灰"),
      show: option("--show", "未指定"),
      objective: option("--objective", "derive an original Kacha production plan")
    },
    translation: {
      keep: [...analysis.boundaries.keepAsAbstractPrinciples, ...listOption("--keep")],
      change: [...analysis.boundaries.changeForKachaAndCreator, ...listOption("--change")],
      doNotCopy: [...new Set([...analysis.boundaries.doNotCopy, ...listOption("--do-not-copy")])]
    },
    originality: {
      shotForShotCopyAllowed: false,
      exactWordingCopyAllowed: false,
      sourceAssetReuseAllowed: false,
      requiredDistinctives: listOption("--distinctives").length > 0
        ? listOption("--distinctives")
        : ["行者大灰的真实判断", "咔嚓设计系统", "原创镜头与图形资产"]
    },
    productionConstraints: [
      "Use the existing Kacha planning and Timeline IR gates.",
      "Every borrowed principle must be translated into an original execution choice.",
      "Do not ingest or redistribute reference source media as production assets."
    ],
    handoff: {
      nextCommand: "kacha start --brief <brief.json> --confirm-execute",
      requiredReview: ["rights", "originality", "creator-fit", "production-feasibility"]
    }
  };
  const errors = validatePlan(value, { requireDigest: false });
  if (errors.length > 0) fail(errors.join("; "));
  value.planDigest = sha256Value(value);
  writeJsonAtomic(output, value);
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", output: path.resolve(output), planDigest: value.planDigest }, null, 2));
  process.exit(0);
}

const file = option("--input") ?? args[1];
if (!file) fail("validate requires --input FILE", 2);
const value = readJson(path.resolve(file));
const errors = value?.kind === "kacha-reference-analysis" ? validateAnalysis(value) : validatePlan(value);
if (errors.length > 0) fail(errors.join("; "));
console.log(JSON.stringify({ schemaVersion: "1.0", status: "pass", input: path.resolve(file), kind: value.kind, digest: sha256Value(value) }, null, 2));
