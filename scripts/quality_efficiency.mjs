#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  fileIdentityMatches,
  mediaSummary,
  readJson,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const policyFile = path.join(skillRoot, "config", "efficiency-policy.json");
const recipeFile = path.join(skillRoot, "config", "workflow-recipes.json");
let policy = readJson(policyFile);

const REQUIRED_QUALITY_INVARIANTS = [
  "sourceReadOnly",
  "semanticIntegrityRequired",
  "representativeApprovalBeforeFullPreview",
  "fullCandidatePlaybackRequired",
  "singleFinalVideoEncode",
  "proxyUpscaleForbidden",
  "currentArtifactEvidenceRequired",
  "assetLicenseAndProvenanceRequired",
];
const REQUIRED_RESOURCES = [
  "agent", "cpuHeavy", "ioHeavy", "network", "mps", "videoEncode", "human",
];
const REQUIRED_CACHE_CONTRACT_FIELDS = [
  "inputs", "implementation", "parameters", "operationVersion", "outputs",
];
const REQUIRED_CACHE_OUTPUT_FIELDS = ["name", "type", "sha256", "sizeBytes"];
const REQUIRED_GUARDRAILS = [
  "semanticIntegrity", "connectionPlayback", "subtitleAccuracy",
  "visualContinuity", "audioQuality", "fullCandidatePlayback",
];
const REQUIRED_EXECUTION_SCRIPTS = ["route_references.mjs"];

export function validateEfficiencyPolicy() {
  const errors = [];
  try {
    policy = readJson(policyFile);
  } catch (error) {
    return {
      schemaVersion: "1.0",
      status: "blocked",
      policy: fs.existsSync(policyFile) ? fileIdentity(policyFile) : null,
      errors: [`efficiency policy cannot be read: ${error.message}`],
    };
  }
  if (policy.schemaVersion !== "1.0" || policy.kind !== "kacha-quality-preserving-efficiency-policy") {
    errors.push("efficiency policy identity is invalid");
  }
  for (const key of REQUIRED_QUALITY_INVARIANTS) {
    if (policy.immutableQualityInvariants?.[key] !== true) {
      errors.push(`quality invariant must remain true: ${key}`);
    }
  }
  if (JSON.stringify(policy.risk?.levels) !== JSON.stringify(["low", "standard", "high", "critical"])) {
    errors.push("risk levels are invalid");
  }
  const thresholds = policy.risk?.thresholds ?? {};
  if (
    !(Number(thresholds.standard) > 0)
    || !(thresholds.standard < thresholds.high && thresholds.high < thresholds.critical)
  ) {
    errors.push("risk thresholds must be strictly increasing");
  }
  for (const key of [
    "firstEdit", "durationOverTwentyMinutes", "durationOverFortyFiveMinutes",
    "structuralChange", "styleChange", "connection", "denseSubtitle",
    "factualEvidence", "maskOrTracking", "audioTransition", "unknownEvidence",
  ]) {
    if (!(Number(policy.risk?.weights?.[key]) > 0)) errors.push(`risk weight missing: ${key}`);
  }
  const preview = policy.representativePreview ?? {};
  if (
    !(preview.minimumDurationSeconds > 0)
    || !(preview.maximumDurationSeconds >= preview.minimumDurationSeconds)
    || preview.incrementalMaximumRanges !== 3
    || preview.incrementalChangeCoverageRequired !== true
  ) errors.push("representative preview policy is invalid");
  for (const category of ["opening", "typical_information", "complex_visual", "ending"]) {
    if (!preview.firstEditRequiredCategories?.includes(category)) errors.push(`first edit category missing: ${category}`);
  }
  if (
    policy.parallelism?.resourceCapacities?.mps !== 1
    || policy.parallelism?.resourceCapacities?.videoEncode !== 1
    || policy.parallelism?.forbidSharedOutputWrites !== true
    || policy.parallelism?.requireDeclaredPrerequisites !== true
  ) errors.push("heavy resource or output conflict policy is invalid");
  for (const resource of REQUIRED_RESOURCES) {
    const capacity = policy.parallelism?.resourceCapacities?.[resource];
    if (!Number.isInteger(capacity) || capacity < 1) {
      errors.push(`resource capacity is invalid: ${resource}`);
    }
  }
  if (
    policy.parallelism?.executionCommandPolicy?.nodeScriptsOnly !== true
    || policy.parallelism?.executionCommandPolicy?.requireImplementationSha256 !== true
    || policy.parallelism?.executionCommandPolicy?.disallowNetworkResource !== true
  ) errors.push("execution command policy is invalid");
  const allowedScripts = policy.parallelism?.executionCommandPolicy?.allowedScripts;
  if (
    !Array.isArray(allowedScripts)
    || sha256Value([...allowedScripts].sort()) !== sha256Value([...REQUIRED_EXECUTION_SCRIPTS].sort())
  ) errors.push("execution command allowlist is invalid");
  for (const kind of ["source_separation", "asr", "mask", "tracking", "beauty", "styleframe", "generated_media"]) {
    if (!policy.cacheEvidence?.highValueKinds?.includes(kind)) errors.push(`high-value cache kind missing: ${kind}`);
  }
  if (
    !(policy.cacheEvidence?.warmCoverageTarget > 0)
    || !(policy.cacheEvidence?.warmCoverageTarget <= 1)
  ) errors.push("cache warm coverage target is invalid");
  for (const field of REQUIRED_CACHE_CONTRACT_FIELDS) {
    if (!policy.cacheEvidence?.requiredContractFields?.includes(field)) {
      errors.push(`cache contract field missing: ${field}`);
    }
  }
  for (const field of REQUIRED_CACHE_OUTPUT_FIELDS) {
    if (!policy.cacheEvidence?.requiredOutputFields?.includes(field)) {
      errors.push(`cache output field missing: ${field}`);
    }
  }
  if (
    !(policy.efficiencyClaim?.minimumPairedProjects >= 8)
    || policy.efficiencyClaim?.requireSameSourceIdentity !== true
    || policy.efficiencyClaim?.requireHumanReview !== true
    || policy.efficiencyClaim?.requireCriticalGuardrailsNoRegression !== true
  ) errors.push("efficiency claim evidence policy is incomplete");
  for (const guardrail of REQUIRED_GUARDRAILS) {
    if (!policy.efficiencyClaim?.requiredGuardrails?.includes(guardrail)) {
      errors.push(`efficiency guardrail missing: ${guardrail}`);
    }
  }
  return {
    schemaVersion: "1.0",
    status: errors.length === 0 ? "pass" : "blocked",
    policy: fileIdentity(policyFile),
    errors,
  };
}

function now() {
  return new Date().toISOString();
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function listOption(args, name) {
  const value = option(args, name, "");
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeExpectedCacheEntries(entries) {
  if (!Array.isArray(entries)) throw new Error("expected cache entries must be an array");
  const normalized = entries.map((entry, index) => {
    const value = typeof entry === "string"
      ? (() => {
          const separator = entry.indexOf(":");
          return separator > 0
            ? { kind: entry.slice(0, separator), key: entry.slice(separator + 1) }
            : null;
        })()
      : entry;
    if (
      !value
      || !policy.cacheEvidence.highValueKinds.includes(value.kind)
      || !isSha(value.key)
    ) throw new Error(`expected cache entry ${index} is invalid`);
    return { kind: value.kind, key: value.key.toLowerCase() };
  }).sort((left, right) => `${left.kind}:${left.key}`.localeCompare(`${right.kind}:${right.key}`));
  const identities = normalized.map((entry) => `${entry.kind}:${entry.key}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("expected cache entries are duplicated");
  }
  return normalized;
}

function normalizeApplicableCacheKinds(kinds) {
  if (!Array.isArray(kinds)) throw new Error("applicable cache kinds must be an array");
  const normalized = [...new Set(kinds)].sort();
  if (normalized.some((kind) => !policy.cacheEvidence.highValueKinds.includes(kind))) {
    throw new Error("applicable cache kinds contain an unknown kind");
  }
  return normalized;
}

function sourceDuration(orchestration) {
  const value = Number(
    orchestration.input?.media?.durationSeconds
      ?? orchestration.input?.media?.duration
      ?? 0,
  );
  return Number.isFinite(value) && value > 0 ? value : null;
}

function loadOptionalJson(file) {
  if (!file) return null;
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`JSON 输入不存在：${resolved}`);
  }
  return { file: resolved, value: readJson(resolved) };
}

function loadOrchestration(projectRoot) {
  const root = path.resolve(projectRoot);
  const file = path.join(root, ".kacha", "orchestration.json");
  if (!fs.existsSync(file)) throw new Error(`项目未初始化：${file}`);
  return { root, file, value: readJson(file) };
}

function evidenceRegistryDigest(registry) {
  const stable = structuredClone(registry);
  delete stable.generatedAt;
  delete stable.digest;
  return sha256Value(stable);
}

function readEvidenceRegistry(file) {
  if (!fs.existsSync(file)) return { value: null, error: null };
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("registry must be a regular non-symbolic-link file");
    }
    const value = readJson(file);
    if (
      value?.schemaVersion !== "1.0"
      || value?.kind !== "kacha-efficiency-input-registry"
      || value?.digest !== evidenceRegistryDigest(value)
    ) throw new Error("registry identity or digest is invalid");
    for (const name of ["cues", "delta"]) {
      const state = value[`${name}State`];
      if (!["bound", "unbound", "explicitly_cleared"].includes(state)) {
        throw new Error(`registry ${name} state is invalid`);
      }
      if ((state === "bound") !== Boolean(value[name]?.path && isSha(value[name]?.sha256))) {
        throw new Error(`registry ${name} identity does not match its state`);
      }
    }
    normalizeApplicableCacheKinds(value.applicableCacheKinds ?? []);
    normalizeExpectedCacheEntries(value.expectedCacheEntries ?? []);
    return { value, error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function cueTimes(cue) {
  const start = Number(cue.startSeconds ?? cue.start ?? cue.in ?? 0);
  const end = Number(cue.endSeconds ?? cue.end ?? cue.out ?? start);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function cueSignals(cue) {
  return new Set([
    ...(Array.isArray(cue.signals) ? cue.signals : []),
    cue.role,
    cue.type,
    cue.category,
  ].filter(Boolean).map((item) => String(item).toLowerCase()));
}

const CATEGORY_SIGNALS = {
  opening: ["hook", "opening", "opening_promise", "cold_open"],
  typical_information: ["ordinary_speech", "explanation", "development", "typical_information"],
  complex_visual: ["complex_visual", "mask", "tracking", "pip", "composite", "demonstration"],
  ending: ["conclusion", "ending", "close", "call_to_action"],
  connection: ["connection", "jump_cut", "edit_point"],
  subtitle_density: ["subtitle_dense", "dense_subtitle", "subtitle_density"],
  factual_evidence: ["fact", "evidence", "citation", "factual_evidence"],
  mask_tracking: ["mask", "tracking", "subject_cutout", "mask_tracking"],
  audio_transition: ["audio_transition", "music_change", "sfx_transition"],
};

function categoryForCue(cue) {
  const signals = cueSignals(cue);
  return Object.entries(CATEGORY_SIGNALS)
    .filter(([, accepted]) => accepted.some((signal) => signals.has(signal)))
    .map(([category]) => category);
}

function clampRange(start, end, duration) {
  const maximum = duration ?? Math.max(end, 0);
  const safeStart = Math.max(0, Math.min(start, maximum));
  const safeEnd = Math.max(safeStart, Math.min(end, maximum));
  return { startSeconds: round(safeStart), endSeconds: round(safeEnd) };
}

function rangeAround({ start, end }, duration, category, sourceRef, evidence) {
  const config = policy.representativePreview;
  const cueDuration = end - start;
  const targetDuration = Math.min(
    config.maximumDurationSeconds,
    Math.max(config.minimumDurationSeconds, cueDuration, config.defaultDurationSeconds),
  );
  const center = (start + end) / 2;
  const range = clampRange(center - targetDuration / 2, center + targetDuration / 2, duration);
  return {
    id: `range-${category.replaceAll("_", "-")}`,
    category,
    categories: [category],
    ...range,
    durationSeconds: round(range.endSeconds - range.startSeconds),
    handleSeconds: config.handleSeconds,
    selectionEvidence: evidence,
    sourceRefs: [sourceRef],
  };
}

function structuralFallback(category, duration) {
  const defaultDuration = policy.representativePreview.defaultDurationSeconds;
  const anchor = {
    opening: defaultDuration / 2,
    typical_information: duration * 0.36,
    complex_visual: duration * 0.64,
    ending: Math.max(defaultDuration / 2, duration - defaultDuration / 2),
  }[category] ?? duration / 2;
  return {
    ...rangeAround(
      { start: Math.max(0, anchor - 0.5), end: Math.min(duration, anchor + 0.5) },
      duration,
      category,
      `structural:${category}`,
      "structural_fallback_requires_human_confirmation",
    ),
    requiresHumanConfirmation: true,
  };
}

function mergeIntervals(intervals, handleSeconds, duration) {
  const normalized = intervals.map((interval, index) => {
    const start = Number(interval.startSeconds ?? interval.start ?? 0);
    const end = Number(interval.endSeconds ?? interval.end ?? start);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`增量区间 ${index} 无效`);
    }
    return {
      start: Math.max(0, start - handleSeconds),
      end: Math.min(duration, end + handleSeconds),
      refs: [String(interval.id ?? `change-${index + 1}`)],
    };
  }).sort((left, right) => left.start - right.start);
  const merged = [];
  for (const interval of normalized) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end + handleSeconds) {
      last.end = Math.max(last.end, interval.end);
      last.refs.push(...interval.refs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function groupIntervals(intervals, maximumGroups) {
  if (intervals.length <= maximumGroups) return intervals;
  const count = intervals.length;
  const groups = Math.min(maximumGroups, count);
  const costs = Array.from({ length: groups + 1 }, () => Array(count + 1).fill(Infinity));
  const splits = Array.from({ length: groups + 1 }, () => Array(count + 1).fill(-1));
  costs[0][0] = 0;
  for (let group = 1; group <= groups; group += 1) {
    for (let end = group; end <= count; end += 1) {
      for (let start = group - 1; start < end; start += 1) {
        const span = intervals[end - 1].end - intervals[start].start;
        const candidate = costs[group - 1][start] + span;
        if (candidate < costs[group][end]) {
          costs[group][end] = candidate;
          splits[group][end] = start;
        }
      }
    }
  }
  const result = [];
  let end = count;
  for (let group = groups; group > 0; group -= 1) {
    const start = splits[group][end];
    const members = intervals.slice(start, end);
    const span = members.at(-1).end - members[0].start;
    result.push({
      start: members[0].start,
      end: members.at(-1).end,
      refs: members.flatMap((item) => item.refs),
      groupedForRangeBudget: members.length > 1,
      durationBudgetException: members.length > 1
        && span > policy.representativePreview.maximumDurationSeconds,
    });
    end = start;
  }
  return result.reverse();
}

export function selectIncrementalRepresentativeRanges(delta, duration) {
  const policyValidation = validateEfficiencyPolicy();
  if (policyValidation.status !== "pass") throw new Error(policyValidation.errors.join("; "));
  if (!(Number(duration) > 0)) throw new Error("incremental representative ranges require a positive duration");
  const scopeKind = delta?.changeSet?.scope?.kind
    ?? (delta?.renderPlan?.intervals ? "intervals" : null);
  if (scopeKind === "no_timeline") return [];
  if (scopeKind === "full") {
    return ["opening", "complex_visual", "ending"].map((category, index) => {
      const range = structuralFallback(category, duration);
      return {
        ...range,
        id: `range-full-scope-${index + 1}`,
        category: "changed_full_scope",
        categories: ["changed_full_scope", category],
        selectionEvidence: "full_scope_structural_sample_requires_human_confirmation",
        sourceRefs: [`version-delta:full:${category}`],
        requiresHumanConfirmation: true,
      };
    });
  }
  const intervals = delta?.changeSet?.scope?.intervals ?? delta?.renderPlan?.intervals ?? [];
  if (intervals.length === 0) return [];
  const handle = policy.representativePreview.handleSeconds;
  return groupIntervals(
    mergeIntervals(intervals, handle, duration),
    policy.representativePreview.incrementalMaximumRanges,
  ).map((interval, index) => ({
    id: `range-change-${index + 1}`,
    category: "changed_interval",
    categories: ["changed_interval"],
    startSeconds: round(interval.start),
    endSeconds: round(interval.end),
    durationSeconds: round(interval.end - interval.start),
    handleSeconds: handle,
    selectionEvidence: "version_delta_changed_interval",
    sourceRefs: interval.refs,
    ...(interval.groupedForRangeBudget ? { groupedForRangeBudget: true } : {}),
    ...(interval.durationBudgetException ? {
      durationBudgetException: "distant changed intervals grouped to preserve complete change coverage",
    } : {}),
  }));
}

function firstEditRanges(cues, duration) {
  const ranges = [];
  const used = new Set();
  const required = policy.representativePreview.firstEditRequiredCategories;
  const candidateFor = (category) => cues.find((cue, index) => (
    !used.has(index) && categoryForCue(cue).includes(category) && cueTimes(cue)
  ));
  for (const category of required) {
    const cue = candidateFor(category);
    if (cue) {
      const index = cues.indexOf(cue);
      used.add(index);
      ranges.push(rangeAround(
        cueTimes(cue),
        duration,
        category,
        `cue:${cue.id ?? index + 1}`,
        "current_cue_signal",
      ));
    } else {
      ranges.push(structuralFallback(category, duration));
    }
  }
  const existingCategories = new Set(ranges.map((range) => range.category));
  for (const category of policy.representativePreview.riskCategories) {
    if (existingCategories.has(category)) continue;
    const cue = cues.find((candidate) => (
      categoryForCue(candidate).includes(category) && cueTimes(candidate)
    ));
    if (!cue) continue;
    const index = cues.indexOf(cue);
    const sourceRef = `cue:${cue.id ?? index + 1}`;
    const existing = ranges.find((range) => range.sourceRefs.includes(sourceRef));
    if (existing) {
      existing.categories = [...new Set([
        ...(existing.categories ?? [existing.category]),
        category,
      ])];
      continue;
    }
    used.add(index);
    ranges.push(rangeAround(
      cueTimes(cue),
      duration,
      category,
      sourceRef,
      "current_high_risk_cue_signal",
    ));
  }
  const merged = [];
  for (const range of [...ranges].sort((left, right) => left.startSeconds - right.startSeconds)) {
    const previous = merged.at(-1);
    const combinedDuration = previous ? range.endSeconds - previous.startSeconds : Infinity;
    if (
      previous
      && range.startSeconds <= previous.endSeconds
      && combinedDuration <= policy.representativePreview.maximumDurationSeconds
    ) {
      previous.endSeconds = Math.max(previous.endSeconds, range.endSeconds);
      previous.durationSeconds = round(previous.endSeconds - previous.startSeconds);
      previous.categories = [...new Set([
        ...(previous.categories ?? [previous.category]),
        ...(range.categories ?? [range.category]),
      ])];
      previous.sourceRefs = [...new Set([...previous.sourceRefs, ...range.sourceRefs])];
      if (range.selectionEvidence.includes("fallback")) {
        previous.selectionEvidence = "mixed_current_and_structural_evidence_requires_human_confirmation";
      }
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function riskAssessment({ cues, delta, duration, task, evidenceKnown }) {
  const weights = policy.risk.weights;
  const factors = [];
  const add = (id, active, evidence) => {
    if (active) factors.push({ id, weight: weights[id], evidence });
  };
  add("firstEdit", !delta && task !== "content_generation", "no version delta supplied");
  add("durationOverTwentyMinutes", duration > 1200, `${round(duration ?? 0)} seconds`);
  add("durationOverFortyFiveMinutes", duration > 2700, `${round(duration ?? 0)} seconds`);
  const types = new Set(delta?.changeSet?.types ?? []);
  add("structuralChange", [...types].some((item) => ["remove_interval", "reorder", "geometry_change"].includes(item)), [...types]);
  add("styleChange", types.has("style_change"), [...types]);
  const categories = cues.flatMap(categoryForCue);
  add("connection", categories.includes("connection"), "current cue signals");
  add("denseSubtitle", categories.includes("subtitle_density"), "current cue signals");
  add("factualEvidence", categories.includes("factual_evidence"), "current cue signals");
  add("maskOrTracking", categories.includes("mask_tracking") || categories.includes("complex_visual"), "current cue signals");
  add("audioTransition", categories.includes("audio_transition"), "current cue signals");
  add("unknownEvidence", !evidenceKnown && task !== "content_generation", "no current cue evidence supplied");
  const score = factors.reduce((sum, factor) => sum + Number(factor.weight ?? 0), 0);
  const thresholds = policy.risk.thresholds;
  const level = score >= thresholds.critical ? "critical"
    : score >= thresholds.high ? "high"
      : score >= thresholds.standard ? "standard" : "low";
  return { level, score, factors, evidenceKnown };
}

export function buildSchedule(registry = readJson(recipeFile)) {
  const errors = [...validateEfficiencyPolicy().errors];
  const stages = registry.stages ?? [];
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  for (const stage of stages) {
    if (!Array.isArray(stage.prerequisites)) errors.push(`${stage.id} prerequisites missing`);
    if (!Array.isArray(stage.resources) || stage.resources.length === 0) errors.push(`${stage.id} resources missing`);
    if (typeof stage.parallelSafe !== "boolean") errors.push(`${stage.id} parallelSafe missing`);
    if (!Array.isArray(stage.outputGroups) || stage.outputGroups.length === 0) errors.push(`${stage.id} outputGroups missing`);
    for (const dependency of stage.prerequisites ?? []) {
      if (!byId.has(dependency)) errors.push(`${stage.id} references unknown prerequisite ${dependency}`);
      if (dependency === stage.id) errors.push(`${stage.id} depends on itself`);
    }
    for (const resource of stage.resources ?? []) {
      if (!Object.hasOwn(policy.parallelism.resourceCapacities, resource)) {
        errors.push(`${stage.id} uses unknown resource ${resource}`);
      }
    }
  }
  const completed = new Set();
  const pending = new Set(stages.map((stage) => stage.id));
  const waves = [];
  while (pending.size > 0 && errors.length === 0) {
    const ready = stages.filter((stage) => (
      pending.has(stage.id)
      && (stage.prerequisites ?? []).every((dependency) => completed.has(dependency))
    ));
    if (ready.length === 0) {
      errors.push(`workflow dependency cycle: ${[...pending].join(", ")}`);
      break;
    }
    const selected = [];
    const usedResources = {};
    const usedOutputs = new Set();
    for (const stage of ready) {
      const conflictsOutput = (stage.outputGroups ?? []).some((group) => usedOutputs.has(group));
      const exceedsCapacity = (stage.resources ?? []).some((resource) => (
        Number(usedResources[resource] ?? 0) + 1
          > Number(policy.parallelism.resourceCapacities[resource] ?? 0)
      ));
      const serialConflict = selected.length > 0 && (
        stage.parallelSafe !== true || selected.some((item) => item.parallelSafe !== true)
      );
      if (conflictsOutput || exceedsCapacity || serialConflict) continue;
      selected.push(stage);
      for (const resource of stage.resources ?? []) {
        usedResources[resource] = Number(usedResources[resource] ?? 0) + 1;
      }
      for (const group of stage.outputGroups ?? []) usedOutputs.add(group);
    }
    if (selected.length === 0) selected.push(ready[0]);
    waves.push({
      index: waves.length + 1,
      stages: selected.map((stage) => stage.id),
      resources: Object.fromEntries(Object.entries(usedResources).sort()),
      outputGroups: [...usedOutputs].sort(),
      parallel: selected.length > 1,
    });
    for (const stage of selected) {
      pending.delete(stage.id);
      completed.add(stage.id);
    }
  }
  return {
    status: errors.length === 0 ? "pass" : "blocked",
    waves,
    parallelWaves: waves.filter((wave) => wave.parallel).length,
    errors,
  };
}

function taskSchedule(tasks) {
  const errors = [];
  const byId = new Map();
  const outputOwners = new Map();
  for (const task of tasks) {
    if (!task?.id || byId.has(task.id)) errors.push(`task id missing or duplicated: ${task?.id ?? "missing"}`);
    else byId.set(task.id, task);
    if (!Array.isArray(task.argv) || task.argv.length === 0 || task.argv.some((item) => typeof item !== "string")) {
      errors.push(`task ${task?.id ?? "unknown"} argv is invalid`);
    }
    if (task.safeToAutoExecute !== true) errors.push(`task ${task?.id ?? "unknown"} is not explicitly safeToAutoExecute`);
    if (!Array.isArray(task.prerequisites)) errors.push(`task ${task?.id ?? "unknown"} prerequisites missing`);
    if (!Array.isArray(task.resources) || task.resources.length === 0) errors.push(`task ${task?.id ?? "unknown"} resources missing`);
    if (!Array.isArray(task.outputs) || task.outputs.length === 0) errors.push(`task ${task?.id ?? "unknown"} outputs missing`);
    if (task.externalMutation === true) errors.push(`task ${task?.id ?? "unknown"} declares an external mutation`);
    for (const resource of task.resources ?? []) {
      if (!Object.hasOwn(policy.parallelism.resourceCapacities, resource)) {
        errors.push(`task ${task.id} uses unknown resource ${resource}`);
      }
    }
    for (const output of task.outputs ?? []) {
      if (outputOwners.has(output)) errors.push(`tasks ${outputOwners.get(output)} and ${task.id} share output ${output}`);
      else outputOwners.set(output, task.id);
    }
  }
  for (const task of tasks) {
    for (const dependency of task.prerequisites ?? []) {
      if (!byId.has(dependency)) errors.push(`task ${task.id} references unknown prerequisite ${dependency}`);
      if (dependency === task.id) errors.push(`task ${task.id} depends on itself`);
    }
  }
  const completed = new Set();
  const pending = new Set(tasks.map((task) => task.id));
  const waves = [];
  while (pending.size > 0 && errors.length === 0) {
    const ready = tasks.filter((task) => (
      pending.has(task.id)
      && task.prerequisites.every((dependency) => completed.has(dependency))
    ));
    if (ready.length === 0) {
      errors.push(`task dependency cycle: ${[...pending].join(", ")}`);
      break;
    }
    const selected = [];
    const resources = {};
    for (const task of ready) {
      const exceeds = task.resources.some((resource) => (
        Number(resources[resource] ?? 0) + 1
          > Number(policy.parallelism.resourceCapacities[resource] ?? 0)
      ));
      const serial = selected.length > 0 && (
        task.allowParallel !== true || selected.some((item) => item.allowParallel !== true)
      );
      if (exceeds || serial) continue;
      selected.push(task);
      for (const resource of task.resources) resources[resource] = Number(resources[resource] ?? 0) + 1;
    }
    if (selected.length === 0) selected.push(ready[0]);
    waves.push({
      index: waves.length + 1,
      tasks: selected.map((task) => task.id),
      resources,
      parallel: selected.length > 1,
    });
    for (const task of selected) {
      pending.delete(task.id);
      completed.add(task.id);
    }
  }
  return { status: errors.length === 0 ? "pass" : "blocked", waves, errors };
}

function safeProjectOutput(projectRoot, candidate) {
  const resolved = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(projectRoot, candidate);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`task output must be a project-local file: ${candidate}`);
  }
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`task output cannot be a symbolic link: ${candidate}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const realRoot = fs.realpathSync(projectRoot);
  let existingParent = path.dirname(resolved);
  while (!fs.existsSync(existingParent)) {
    const parent = path.dirname(existingParent);
    if (parent === existingParent) break;
    existingParent = parent;
  }
  const realParent = fs.realpathSync(existingParent);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`task output resolves through a path outside the project: ${candidate}`);
  }
  return resolved;
}

function redactExecutionText(value) {
  return String(value ?? "")
    .replace(/((?:Bearer|Basic))\s+\S+/gi, "$1 [REDACTED]")
    .replace(/((?:api.?key|token|secret|password|credential)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function optionValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) values.push(argv[index + 1]);
  }
  return values;
}

function validateRegisteredTaskArguments(task, projectRoot, scriptName) {
  const errors = [];
  if (scriptName === "route_references.mjs") {
    const outputValues = optionValues(task.argv, "--output");
    if (outputValues.length !== 1 || !outputValues[0]) {
      errors.push(`task ${task.id} route_references must declare exactly one --output`);
      return errors;
    }
    let routedOutput = null;
    let declaredOutputs = [];
    try {
      routedOutput = safeProjectOutput(projectRoot, outputValues[0]);
      declaredOutputs = (task.outputs ?? []).map((output) => safeProjectOutput(projectRoot, output));
    } catch (error) {
      errors.push(error.message);
      return errors;
    }
    if (declaredOutputs.length !== 1 || declaredOutputs[0] !== routedOutput) {
      errors.push(`task ${task.id} route_references --output must exactly match its declared output`);
    }
  }
  return errors;
}

function validateTaskCommand(task, projectRoot) {
  const errors = [];
  const argv = task.argv ?? [];
  if (policy.parallelism.executionCommandPolicy.disallowNetworkResource
    && task.resources?.includes("network")) {
    errors.push(`task ${task.id} cannot use the network in the local-only efficiency executor`);
  }
  let executable = null;
  try {
    executable = fs.realpathSync(argv[0] ?? "");
  } catch {
    errors.push(`task ${task.id} executable does not exist`);
  }
  if (executable && executable !== fs.realpathSync(process.execPath)) {
    errors.push(`task ${task.id} must execute through the current Node.js runtime`);
  }
  const scriptValue = argv[1];
  if (!scriptValue || scriptValue.startsWith("-")) {
    errors.push(`task ${task.id} must name a file-backed Node.js script; inline code is forbidden`);
    return errors;
  }
  const script = path.isAbsolute(scriptValue)
    ? path.normalize(scriptValue)
    : path.resolve(projectRoot, scriptValue);
  let realScript = null;
  try {
    if (fs.lstatSync(script).isSymbolicLink()) throw new Error("script is a symlink");
    realScript = fs.realpathSync(script);
  } catch (error) {
    errors.push(`task ${task.id} implementation is invalid: ${error.message}`);
  }
  const scriptsRoot = fs.realpathSync(path.join(skillRoot, "scripts"));
  if (
    realScript
    && (realScript === scriptsRoot || !realScript.startsWith(`${scriptsRoot}${path.sep}`))
  ) errors.push(`task ${task.id} implementation must be a bundled Kacha script`);
  if (realScript && path.extname(realScript) !== ".mjs") {
    errors.push(`task ${task.id} implementation must be an .mjs script`);
  }
  const scriptName = realScript ? path.basename(realScript) : null;
  if (
    scriptName
    && !policy.parallelism.executionCommandPolicy.allowedScripts.includes(scriptName)
  ) {
    errors.push(`task ${task.id} implementation is not registered for deterministic execution`);
  }
  if (!isSha(task.commandSha256)) {
    errors.push(`task ${task.id} commandSha256 is missing`);
  } else if (realScript && sha256File(realScript) !== task.commandSha256) {
    errors.push(`task ${task.id} implementation SHA-256 changed`);
  }
  if (scriptName) errors.push(...validateRegisteredTaskArguments(task, projectRoot, scriptName));
  return errors;
}

function executionOutputIdentity(projectRoot, output) {
  const validated = safeProjectOutput(projectRoot, output);
  if (!fs.existsSync(validated) || !fs.lstatSync(validated).isFile()) {
    return { path: validated, missing: true };
  }
  return fileIdentity(validated);
}

function runTask(task, projectRoot) {
  const commandErrors = validateTaskCommand(task, projectRoot);
  if (commandErrors.length > 0) throw new Error(commandErrors.join("; "));
  const resourceNames = task.resources.filter((resource) => (
    ["cpuHeavy", "mps", "videoEncode", "network", "ioHeavy"].includes(resource)
  ));
  if (resourceNames.length === 0) {
    throw new Error(`task ${task.id} must declare at least one executable host resource`);
  }
  const outputs = (task.outputs ?? []).map((output) => safeProjectOutput(projectRoot, output));
  for (const output of outputs) {
    if (fs.existsSync(output)) throw new Error(`task ${task.id} refuses to overwrite existing output: ${output}`);
  }
  const workflow = task.workflow ?? "first_edit";
  const telemetry = [
    path.join(scriptDirectory, "run_telemetry.mjs"),
    "run",
    "--stage", task.id,
    "--project-root", projectRoot,
    "--workflow", workflow,
    "--mode", task.mode ?? "preview",
    "--render-scope", task.renderScope ?? "none",
    "--qc-scope", task.qcScope ?? "none",
    ...outputs.flatMap((output) => ["--artifact", output]),
  ];
  if (workflow === "incremental") {
    if (!task.versionId) throw new Error(`incremental task ${task.id} requires versionId`);
    telemetry.push("--version-id", task.versionId);
  }
  if (task.videoEncodes !== undefined) telemetry.push("--video-encodes", String(task.videoEncodes));
  if (task.approvalEvidence) telemetry.push("--approval-evidence", task.approvalEvidence);
  telemetry.push(
    "--",
    process.execPath,
    path.join(scriptDirectory, "resource_scheduler.mjs"),
    "run",
    "--project-root", projectRoot,
    ...resourceNames.flatMap((resource) => ["--resource", resource]),
    "--purpose", `efficiency:${task.id}`,
    "--",
    ...task.argv,
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, telemetry, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("close", (status) => {
      const missing = outputs.filter((output) => {
        try {
          return executionOutputIdentity(projectRoot, output).missing === true;
        } catch {
          return true;
        }
      });
      resolve({
        id: task.id,
        status: status === 0 && missing.length === 0 ? "pass" : "fail",
        exitCode: status ?? 1,
        outputs,
        missingOutputs: missing,
        stdout,
        stderr,
      });
    });
  });
}

export async function executeEfficiencyTasks(contractFile) {
  const resolved = path.resolve(contractFile);
  const contractIdentity = fileIdentity(resolved);
  const contract = readJson(resolved);
  const errors = [];
  const policyValidation = validateEfficiencyPolicy();
  errors.push(...policyValidation.errors);
  if (!fileIdentityMatches(resolved, contractIdentity)) errors.push("execution plan changed while it was being read");
  if (contract.schemaVersion !== "1.0" || contract.kind !== "kacha-efficiency-execution-plan") {
    errors.push("execution plan identity is invalid");
  }
  if (contract.authorization?.localExecution !== true) errors.push("local execution is not authorized");
  for (const boundary of ["upload", "paidGeneration", "publish", "overwriteSource"]) {
    if (contract.authorization?.[boundary] !== false) {
      errors.push(`execution plan must explicitly forbid ${boundary}`);
    }
  }
  const projectRoot = path.resolve(contract.projectRoot ?? path.dirname(resolved));
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) errors.push("project root does not exist");
  const tasks = contract.tasks ?? [];
  if (!Array.isArray(tasks) || tasks.length === 0) errors.push("execution plan has no tasks");
  const normalizedOutputOwners = new Map();
  const reservedOutputs = new Set([
    resolved,
    path.join(projectRoot, ".kacha", "efficiency-execution-report.json"),
  ].map((item) => path.normalize(item)));
  for (const task of tasks) {
    errors.push(...validateTaskCommand(task, projectRoot));
    try {
      for (const output of task.outputs ?? []) {
        const normalized = safeProjectOutput(projectRoot, output);
        if (reservedOutputs.has(normalized)) {
          errors.push(`task ${task.id} output is reserved by the efficiency executor: ${normalized}`);
        }
        if (normalizedOutputOwners.has(normalized)) {
          errors.push(`tasks ${normalizedOutputOwners.get(normalized)} and ${task.id} share output ${normalized}`);
        } else {
          normalizedOutputOwners.set(normalized, task.id);
        }
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  const schedule = taskSchedule(tasks);
  errors.push(...schedule.errors);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const results = [];
  for (const wave of schedule.waves) {
    const waveTasks = wave.tasks.map((id) => tasks.find((task) => task.id === id));
    const completed = await Promise.all(waveTasks.map((task) => runTask(task, projectRoot)));
    results.push(...completed);
    if (completed.some((result) => result.status !== "pass")) break;
  }
  const contractCurrent = fileIdentityMatches(resolved, contractIdentity);
  const report = {
    schemaVersion: "1.0",
    kind: "kacha-efficiency-execution-report",
    generatedAt: now(),
    projectRoot,
    contract: contractIdentity,
    contractCurrent,
    schedule,
    status: contractCurrent
      && results.length === tasks.length && results.every((result) => result.status === "pass")
      ? "pass" : "blocked",
    results: results.map((result) => ({
      id: result.id,
      status: result.status,
      exitCode: result.exitCode,
      outputs: result.outputs.map((output) => {
        try {
          return executionOutputIdentity(projectRoot, output);
        } catch (error) {
          return { path: output, missing: true, error: error.message };
        }
      }),
      missingOutputs: result.missingOutputs,
      telemetry: (() => {
        try {
          return JSON.parse(result.stdout);
        } catch {
          return { status: "unparseable", stderr: redactExecutionText(result.stderr) };
        }
      })(),
    })),
  };
  const reportFile = path.join(projectRoot, ".kacha", "efficiency-execution-report.json");
  writeJsonAtomic(reportFile, report);
  return { output: reportFile, report };
}

function planDigest(plan) {
  const stable = structuredClone(plan);
  delete stable.generatedAt;
  delete stable.digest;
  delete stable.status;
  delete stable.validation;
  return sha256Value(stable);
}

export function validateEfficiencyPlan(plan) {
  const policyValidation = validateEfficiencyPolicy();
  const errors = [...policyValidation.errors];
  if (plan?.schemaVersion !== "1.0" || plan?.kind !== "kacha-quality-preserving-efficiency-plan") {
    errors.push("efficiency plan identity is invalid");
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) plan = {};
  if (plan?.policyVersion !== policy.policyVersion) errors.push("efficiency plan policy version is stale");
  if (!plan?.projectId || !plan?.projectRoot) errors.push("efficiency plan project identity is missing");
  if (!["first_edit", "incremental", "content_planning"].includes(plan?.mode)) {
    errors.push("efficiency plan mode is invalid");
  }
  const invariants = plan.qualityInvariants ?? {};
  for (const key of REQUIRED_QUALITY_INVARIANTS) {
    if (invariants[key] !== true) errors.push(`quality invariant disabled: ${key}`);
  }
  const preview = plan.representativePreview ?? {};
  if (
    preview.representativeApprovalRequired !== true
    || preview.fullPreviewEncodeBudget !== 1
    || preview.finalVideoEncodeBudget !== 1
    || preview.fullCandidatePlaybackRequired !== true
  ) errors.push("efficiency preview quality or encode budget was weakened");
  if (plan.evidenceBoundary?.speedImprovementClaimed !== false) {
    errors.push("a single efficiency plan cannot claim measured improvement");
  }
  if (plan.evidenceBoundary?.minimumPairedProjects !== policy.efficiencyClaim.minimumPairedProjects) {
    errors.push("efficiency evidence cohort minimum was weakened");
  }
  const requiredInputs = ["orchestration", "evidenceRegistry", "policy", "recipes"];
  for (const name of requiredInputs) {
    if (!plan.inputs?.[name]?.path || !isSha(plan.inputs?.[name]?.sha256)) {
      errors.push(`efficiency plan required input missing: ${name}`);
    }
  }
  for (const [name, identity] of Object.entries(plan.inputs ?? {})) {
    if (!identity) continue;
    try {
      if (!identity.path || !fileIdentityMatches(identity.path, identity)) {
        errors.push(`efficiency plan input changed: ${name}`);
      }
    } catch {
      errors.push(`efficiency plan input changed: ${name}`);
    }
  }
  if (plan.inputs?.policy?.path && path.resolve(plan.inputs.policy.path) !== policyFile) {
    errors.push("efficiency plan policy input points to a different file");
  }
  if (plan.inputs?.recipes?.path && path.resolve(plan.inputs.recipes.path) !== recipeFile) {
    errors.push("efficiency plan recipe input points to a different file");
  }
  const expectedRegistryFile = plan.projectRoot
    ? path.join(path.resolve(plan.projectRoot), ".kacha", "efficiency-inputs.json")
    : null;
  if (
    plan.inputs?.evidenceRegistry?.path
    && path.resolve(plan.inputs.evidenceRegistry.path) !== expectedRegistryFile
  ) errors.push("efficiency plan evidence registry points to a different file");
  let orchestration = null;
  let cues = [];
  let delta = null;
  let evidenceRegistry = null;
  try {
    if (plan.inputs?.orchestration?.path && fileIdentityMatches(
      plan.inputs.orchestration.path,
      plan.inputs.orchestration,
    )) orchestration = readJson(plan.inputs.orchestration.path);
  } catch {
    // The current-input diagnostics above already describe the failure.
  }
  try {
    if (
      plan.inputs?.evidenceRegistry?.path
      && fileIdentityMatches(plan.inputs.evidenceRegistry.path, plan.inputs.evidenceRegistry)
    ) {
      const loaded = readEvidenceRegistry(plan.inputs.evidenceRegistry.path);
      if (loaded.error) errors.push(`efficiency evidence registry is invalid: ${loaded.error}`);
      else evidenceRegistry = loaded.value;
    }
  } catch {
    // The current-input diagnostics above already describe the failure.
  }
  if (evidenceRegistry) {
    if (
      evidenceRegistry.schemaVersion !== "1.0"
      || evidenceRegistry.kind !== "kacha-efficiency-input-registry"
      || evidenceRegistry.digest !== evidenceRegistryDigest(evidenceRegistry)
    ) errors.push("efficiency evidence registry identity or digest is invalid");
    if (
      evidenceRegistry.projectId !== plan.projectId
      || path.resolve(evidenceRegistry.projectRoot ?? "") !== path.resolve(plan.projectRoot ?? "")
    ) errors.push("efficiency evidence registry project identity differs from the plan");
    for (const name of ["cues", "delta"]) {
      const state = evidenceRegistry[`${name}State`];
      if (
        !["bound", "unbound", "explicitly_cleared"].includes(state)
        || ((state === "bound") !== Boolean(
          evidenceRegistry[name]?.path && isSha(evidenceRegistry[name]?.sha256)
        ))
      ) errors.push(`efficiency evidence registry ${name} state is invalid`);
    }
    if (
      sha256Value(evidenceRegistry.cues ?? null) !== sha256Value(plan.inputs?.cues ?? null)
      || sha256Value(evidenceRegistry.delta ?? null) !== sha256Value(plan.inputs?.delta ?? null)
    ) errors.push("efficiency plan inputs differ from the evidence registry");
    if (
      sha256Value(evidenceRegistry.applicableCacheKinds ?? [])
        !== sha256Value(plan.cache?.applicableKinds ?? [])
      || sha256Value(evidenceRegistry.expectedCacheEntries ?? [])
        !== sha256Value(plan.cache?.expectedEntries ?? [])
    ) errors.push("efficiency cache inputs differ from the evidence registry");
  }
  try {
    if (plan.inputs?.cues?.path && fileIdentityMatches(plan.inputs.cues.path, plan.inputs.cues)) {
      const value = readJson(plan.inputs.cues.path);
      cues = value.cues ?? value.segments ?? [];
    }
  } catch {
    // The current-input diagnostics above already describe the failure.
  }
  try {
    if (plan.inputs?.delta?.path && fileIdentityMatches(plan.inputs.delta.path, plan.inputs.delta)) {
      delta = readJson(plan.inputs.delta.path);
    }
  } catch {
    // The current-input diagnostics above already describe the failure.
  }
  if (orchestration) {
    const expectedProjectRoot = path.dirname(path.dirname(path.resolve(plan.inputs.orchestration.path)));
    const expectedDuration = sourceDuration(orchestration);
    const expectedMode = delta ? "incremental"
      : orchestration.task === "content_generation" ? "content_planning" : "first_edit";
    if (orchestration.projectId !== plan.projectId) errors.push("efficiency plan project id differs from orchestration");
    if (path.resolve(plan.projectRoot) !== expectedProjectRoot) errors.push("efficiency plan project root differs from orchestration");
    if (plan.mode !== expectedMode) errors.push(`efficiency plan mode differs from current inputs: ${expectedMode}`);
    if (plan.source?.type !== orchestration.input?.type) errors.push("efficiency plan source type differs from orchestration");
    const expectedSourceSha = orchestration.input?.sha256 ?? orchestration.input?.digest ?? null;
    if (plan.source?.sha256 !== expectedSourceSha) errors.push("efficiency plan source identity differs from orchestration");
    if (plan.source?.durationSeconds !== expectedDuration) errors.push("efficiency plan source duration differs from orchestration");
    if (["first_edit", "incremental"].includes(expectedMode)) {
      if (!isSha(expectedSourceSha)) errors.push("video efficiency plan requires a frozen source SHA-256");
      if (!(expectedDuration > 0)) errors.push("video efficiency plan requires a positive source duration");
    }
    const ranges = preview.ranges ?? [];
    let expectedRanges = [];
    if (expectedDuration) {
      expectedRanges = delta
        ? selectIncrementalRepresentativeRanges(delta, expectedDuration)
        : firstEditRanges(cues, expectedDuration);
    }
    if (sha256Value(ranges) !== sha256Value(expectedRanges)) {
      errors.push("representative ranges differ from current cues or delta");
    }
    const expectedFallbacks = expectedRanges.filter((range) => (
      range.requiresHumanConfirmation === true
      || String(range.selectionEvidence).includes("requires_human_confirmation")
    )).length;
    if (preview.structuralFallbacks !== expectedFallbacks) {
      errors.push("representative fallback count differs from current evidence");
    }
    const expectedPreviewStatus = expectedDuration ? "planned" : "awaiting_source_media";
    if (preview.status !== expectedPreviewStatus) {
      errors.push("representative preview status differs from current source evidence");
    }
    if (expectedMode === "first_edit") {
      const categories = new Set(ranges.flatMap((range) => range.categories ?? [range.category]));
      for (const category of policy.representativePreview.firstEditRequiredCategories) {
        if (!categories.has(category)) errors.push(`first edit preview missing category: ${category}`);
      }
    }
    if (expectedMode === "incremental") {
      const scopeKind = delta?.changeSet?.scope?.kind
        ?? (delta?.renderPlan?.intervals ? "intervals" : null);
      if (ranges.length > policy.representativePreview.incrementalMaximumRanges) {
        errors.push("incremental representative range budget exceeded");
      }
      if (scopeKind === "intervals" && (plan.changeCoverage?.intervals?.length ?? 0) === 0) {
        errors.push("interval-scoped incremental plan has no changed intervals");
      }
      if (scopeKind === "full" && ranges.length === 0) {
        errors.push("full-scope incremental plan has no representative ranges");
      }
      if (!scopeKind || !["intervals", "full", "no_timeline"].includes(scopeKind)) {
        errors.push("incremental change scope is invalid");
      }
      for (const interval of plan.changeCoverage?.intervals ?? []) {
        const start = Number(interval.startSeconds ?? interval.start);
        const end = Number(interval.endSeconds ?? interval.end);
        if (!ranges.some((range) => range.startSeconds <= start && range.endSeconds >= end)) {
          errors.push(`changed interval is not covered: ${start}-${end}`);
        }
      }
    }
    for (const range of ranges) {
      if (
        !Number.isFinite(Number(range.startSeconds))
        || !Number.isFinite(Number(range.endSeconds))
        || range.startSeconds < 0
        || range.endSeconds > Number(expectedDuration ?? 0) + 0.001
        || range.endSeconds <= range.startSeconds
      ) errors.push(`invalid representative range: ${range.id}`);
    }
    const expectedRisk = riskAssessment({
      cues,
      delta,
      duration: expectedDuration ?? 0,
      task: orchestration.task,
      evidenceKnown: Boolean(plan.inputs?.cues && cues.some((cue) => cueTimes(cue))),
    });
    if (sha256Value(plan.risk) !== sha256Value(expectedRisk)) {
      errors.push("efficiency risk differs from current evidence");
    }
    const expectedScopeKind = delta?.changeSet?.scope?.kind
      ?? (delta?.renderPlan?.intervals ? "intervals" : null);
    const expectedIntervals = delta?.changeSet?.scope?.intervals ?? delta?.renderPlan?.intervals ?? [];
    if (
      plan.changeCoverage?.scopeKind !== expectedScopeKind
      || sha256Value(plan.changeCoverage?.intervals ?? []) !== sha256Value(expectedIntervals)
      || plan.changeCoverage?.required !== Boolean(
        delta
        && expectedScopeKind === "intervals"
        && policy.representativePreview.incrementalChangeCoverageRequired
      )
    ) errors.push("efficiency change coverage differs from current delta");
  }
  const expectedSchedule = buildSchedule();
  if (sha256Value(plan.schedule ?? null) !== sha256Value(expectedSchedule)) {
    errors.push("efficiency schedule differs from current recipes and resource policy");
  }
  let applicableKinds = [];
  try {
    applicableKinds = normalizeApplicableCacheKinds(plan.cache?.applicableKinds ?? []);
  } catch (error) {
    errors.push(error.message);
  }
  let expectedCacheEntries = [];
  try {
    expectedCacheEntries = normalizeExpectedCacheEntries(plan.cache?.expectedEntries ?? []);
  } catch (error) {
    errors.push(error.message);
  }
  const expectedCacheKinds = new Set(expectedCacheEntries.map((entry) => entry.kind));
  const expectedKeyBindingStatus = applicableKinds.length === 0
    ? "awaiting_stage_plan"
    : applicableKinds.every((kind) => expectedCacheKinds.has(kind))
      ? "declared"
      : "awaiting_expected_keys";
  if (
    sha256Value(plan.cache?.applicableKinds ?? []) !== sha256Value(applicableKinds)
    || plan.cache?.applicabilityStatus !== (applicableKinds.length > 0 ? "declared" : "awaiting_stage_plan")
    || plan.cache?.strongFingerprintRequired !== true
    || plan.cache?.warmCoverageTarget !== policy.cacheEvidence.warmCoverageTarget
    || sha256Value(plan.cache?.expectedEntries ?? []) !== sha256Value(expectedCacheEntries)
    || expectedCacheEntries.some((entry) => !applicableKinds.includes(entry.kind))
    || plan.cache?.keyBindingStatus !== expectedKeyBindingStatus
  ) errors.push("efficiency cache contract is invalid");
  if (plan.digest !== planDigest(plan)) errors.push("efficiency plan digest mismatch");
  return {
    schemaVersion: "1.0",
    status: errors.length === 0 ? "pass" : "blocked",
    errors,
    digest: plan.digest ?? null,
  };
}

export function buildEfficiencyPlan({
  projectRoot,
  cuesPath = null,
  deltaPath = null,
  clearCues = false,
  clearDelta = false,
  applicableCacheKinds = null,
  expectedCacheEntries = null,
  outputPath = null,
} = {}) {
  const policyValidation = validateEfficiencyPolicy();
  if (policyValidation.status !== "pass") throw new Error(policyValidation.errors.join("; "));
  if (clearCues && cuesPath) throw new Error("--cues and --clear-cues are mutually exclusive");
  if (clearDelta && deltaPath) throw new Error("--delta and --clear-delta are mutually exclusive");
  const orchestration = loadOrchestration(projectRoot);
  const output = path.resolve(outputPath ?? path.join(orchestration.root, ".kacha", "efficiency-plan.json"));
  const evidenceRegistryFile = path.join(orchestration.root, ".kacha", "efficiency-inputs.json");
  const loadedRegistry = readEvidenceRegistry(evidenceRegistryFile);
  let previous = null;
  let previousUnreadable = false;
  if (fs.existsSync(output)) {
    try {
      const outputStat = fs.lstatSync(output);
      if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
        throw new Error("previous plan is not a regular file");
      }
      previous = readJson(output);
    } catch {
      previousUnreadable = true;
    }
  }
  const explicitRecovery = Boolean(cuesPath || clearCues) && Boolean(deltaPath || clearDelta);
  if (previousUnreadable && !loadedRegistry.value && !explicitRecovery) {
    throw new Error(
      "previous efficiency plan is unreadable and no valid efficiency input registry exists; "
      + "provide replacement cues/delta or explicitly clear both inputs",
    );
  }
  if (
    loadedRegistry.value
    && (
      loadedRegistry.value.projectId !== orchestration.value.projectId
      || path.resolve(loadedRegistry.value.projectRoot ?? "") !== orchestration.root
    )
  ) throw new Error("efficiency input registry belongs to a different project");
  const reusablePath = (candidate, label) => {
    if (!candidate) return null;
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(
        `previous ${label} evidence is missing: ${candidate}; provide a replacement or explicitly clear it`,
      );
    }
    return candidate;
  };
  const reusableEvidencePath = (name) => (
    loadedRegistry.value
      ? loadedRegistry.value[name]?.path
      : previous?.inputs?.[name]?.path
  );
  const effectiveCuesPath = clearCues
    ? null
    : cuesPath ?? reusablePath(reusableEvidencePath("cues"), "cues");
  const effectiveDeltaPath = clearDelta
    ? null
    : deltaPath ?? reusablePath(reusableEvidencePath("delta"), "delta");
  const effectiveCacheKinds = normalizeApplicableCacheKinds(
    applicableCacheKinds
      ?? loadedRegistry.value?.applicableCacheKinds
      ?? previous?.cache?.applicableKinds
      ?? [],
  );
  const effectiveExpectedCacheEntries = normalizeExpectedCacheEntries(
    expectedCacheEntries
      ?? loadedRegistry.value?.expectedCacheEntries
      ?? previous?.cache?.expectedEntries
      ?? [],
  );
  const cuesInput = loadOptionalJson(effectiveCuesPath);
  const deltaInput = loadOptionalJson(effectiveDeltaPath);
  const evidenceRegistry = {
    schemaVersion: "1.0",
    kind: "kacha-efficiency-input-registry",
    generatedAt: now(),
    projectId: orchestration.value.projectId,
    projectRoot: orchestration.root,
    cuesState: clearCues ? "explicitly_cleared" : cuesInput ? "bound" : "unbound",
    deltaState: clearDelta ? "explicitly_cleared" : deltaInput ? "bound" : "unbound",
    cues: cuesInput ? fileIdentity(cuesInput.file) : null,
    delta: deltaInput ? fileIdentity(deltaInput.file) : null,
    applicableCacheKinds: effectiveCacheKinds,
    expectedCacheEntries: effectiveExpectedCacheEntries,
  };
  evidenceRegistry.digest = evidenceRegistryDigest(evidenceRegistry);
  if (loadedRegistry.value?.digest === evidenceRegistry.digest) {
    evidenceRegistry.generatedAt = loadedRegistry.value.generatedAt;
  } else {
    writeJsonAtomic(evidenceRegistryFile, evidenceRegistry);
  }
  if (!fs.existsSync(evidenceRegistryFile)) writeJsonAtomic(evidenceRegistryFile, evidenceRegistry);
  const cues = cuesInput?.value?.cues ?? cuesInput?.value?.segments ?? [];
  const delta = deltaInput?.value ?? null;
  const duration = sourceDuration(orchestration.value);
  const mode = delta ? "incremental"
    : orchestration.value.task === "content_generation" ? "content_planning" : "first_edit";
  const ranges = duration
    ? (delta ? selectIncrementalRepresentativeRanges(delta, duration) : firstEditRanges(cues, duration))
    : [];
  const changeIntervals = delta?.changeSet?.scope?.intervals ?? delta?.renderPlan?.intervals ?? [];
  const changeScopeKind = delta?.changeSet?.scope?.kind
    ?? (delta?.renderPlan?.intervals ? "intervals" : null);
  const currentCueEvidenceKnown = Boolean(cuesInput && cues.some((cue) => cueTimes(cue)));
  const plan = {
    schemaVersion: "1.0",
    kind: "kacha-quality-preserving-efficiency-plan",
    policyVersion: policy.policyVersion,
    generatedAt: now(),
    projectId: orchestration.value.projectId,
    projectRoot: orchestration.root,
    mode,
    source: {
      type: orchestration.value.input?.type,
      sha256: orchestration.value.input?.sha256 ?? orchestration.value.input?.digest ?? null,
      durationSeconds: duration,
      currentEvidence: duration ? "frozen source identity" : "source media not yet available",
    },
    inputs: {
      orchestration: fileIdentity(orchestration.file),
      evidenceRegistry: fileIdentity(evidenceRegistryFile),
      cues: cuesInput ? fileIdentity(cuesInput.file) : null,
      delta: deltaInput ? fileIdentity(deltaInput.file) : null,
      policy: fileIdentity(policyFile),
      recipes: fileIdentity(recipeFile),
    },
    risk: riskAssessment({
      cues,
      delta,
      duration: duration ?? 0,
      task: orchestration.value.task,
      evidenceKnown: currentCueEvidenceKnown,
    }),
    qualityInvariants: structuredClone(policy.immutableQualityInvariants),
    representativePreview: {
      status: duration ? "planned" : "awaiting_source_media",
      ranges,
      representativeApprovalRequired: true,
      fullPreviewEncodeBudget: 1,
      finalVideoEncodeBudget: 1,
      fullCandidatePlaybackRequired: true,
      structuralFallbacks: ranges.filter((range) => (
        range.requiresHumanConfirmation === true
        || String(range.selectionEvidence).includes("requires_human_confirmation")
      )).length,
    },
    changeCoverage: {
      required: Boolean(
        delta
        && changeScopeKind === "intervals"
        && policy.representativePreview.incrementalChangeCoverageRequired
      ),
      scopeKind: changeScopeKind,
      intervals: changeIntervals,
    },
    schedule: buildSchedule(),
    cache: {
      applicableKinds: effectiveCacheKinds,
      applicabilityStatus: effectiveCacheKinds.length > 0 ? "declared" : "awaiting_stage_plan",
      expectedEntries: effectiveExpectedCacheEntries,
      keyBindingStatus: effectiveCacheKinds.length === 0
        ? "awaiting_stage_plan"
        : effectiveCacheKinds.every((kind) => (
          effectiveExpectedCacheEntries.some((entry) => entry.kind === kind)
        )) ? "declared" : "awaiting_expected_keys",
      warmCoverageTarget: policy.cacheEvidence.warmCoverageTarget,
      strongFingerprintRequired: true,
    },
    evidenceBoundary: {
      speedImprovementClaimed: false,
      reason: "单项目计划不能证明提速；必须通过同源成对项目和质量护栏比较。",
      minimumPairedProjects: policy.efficiencyClaim.minimumPairedProjects,
    },
  };
  plan.digest = planDigest(plan);
  const validation = validateEfficiencyPlan(plan);
  plan.status = validation.status;
  plan.validation = validation;
  if (previous?.digest === plan.digest) plan.generatedAt = previous.generatedAt;
  writeJsonAtomic(output, plan);
  return { output, plan };
}

function isSha(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function cachedOutputIdentity(candidate, type) {
  const rootStat = fs.lstatSync(candidate);
  if (rootStat.isSymbolicLink()) throw new Error("cached output is a symlink");
  if (type === "file") {
    if (!rootStat.isFile()) throw new Error("cached output is not a file");
    return {
      sizeBytes: rootStat.size,
      sha256: sha256File(candidate),
    };
  }
  if (type !== "directory" || !rootStat.isDirectory()) {
    throw new Error("cached output type is invalid");
  }
  const files = [];
  const visit = (directory, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("cached directory contains a symlink");
      if (entry.isDirectory()) visit(absolute, child);
      else if (entry.isFile()) files.push({
        path: child,
        sizeBytes: fs.statSync(absolute).size,
        sha256: sha256File(absolute),
      });
    }
  };
  visit(candidate);
  return {
    fileCount: files.length,
    sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    sha256: sha256Value(files),
  };
}

function safeCachePayload(entryDirectory, cacheFile) {
  if (typeof cacheFile !== "string" || !cacheFile.trim() || path.isAbsolute(cacheFile)) {
    throw new Error("cacheFile must be a non-empty relative path");
  }
  const resolved = path.resolve(entryDirectory, cacheFile);
  const relative = path.relative(entryDirectory, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("cacheFile escapes the cache entry");
  }
  if (!fs.existsSync(resolved)) return resolved;
  if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error("cacheFile is a symlink");
  const realEntry = fs.realpathSync(entryDirectory);
  const realPayload = fs.realpathSync(resolved);
  if (realPayload !== realEntry && !realPayload.startsWith(`${realEntry}${path.sep}`)) {
    throw new Error("cacheFile resolves outside the cache entry");
  }
  return resolved;
}

function inspectCacheEntry(entryDirectory, manifest, kind) {
  const errors = [];
  const contract = manifest?.contract;
  if (manifest?.schemaVersion !== "1.0") errors.push("manifest schemaVersion is invalid");
  if (manifest?.status !== "ready") errors.push("manifest status is not ready");
  if (!isSha(manifest?.key) || path.basename(entryDirectory) !== manifest.key) errors.push("cache key identity mismatch");
  if (contract && sha256Value(contract) !== manifest?.key) errors.push("cache key does not match the contract digest");
  if (!isSha(manifest?.configurationDigest)) errors.push("cache configuration digest missing");
  if (manifest?.kind !== kind || contract?.kind !== kind) errors.push("kind mismatch");
  for (const field of policy.cacheEvidence.requiredContractFields) {
    if (!Object.hasOwn(contract ?? {}, field)) errors.push(`contract missing ${field}`);
  }
  if (
    !Array.isArray(contract?.inputs)
    || contract.inputs.length === 0
    || contract.inputs.some((input) => !isSha(input?.sha256))
  ) {
    errors.push("source/input SHA-256 evidence missing");
  }
  if (
    !Array.isArray(contract?.implementation)
    || contract.implementation.length === 0
    || contract.implementation.some((item) => !isSha(item?.sha256))
  ) {
    errors.push("implementation SHA-256 evidence missing");
  }
  if (typeof contract?.operationVersion !== "string" || !contract.operationVersion.trim()) {
    errors.push("operation version missing");
  }
  if (!contract?.parameters || typeof contract.parameters !== "object" || Array.isArray(contract.parameters)) {
    errors.push("parameters contract missing");
  }
  if (!Array.isArray(contract?.outputs) || contract.outputs.length === 0) errors.push("output schema missing");
  if (!Array.isArray(manifest?.outputs) || manifest.outputs.length === 0) errors.push("manifest outputs missing");
  if (Array.isArray(contract?.outputs) && contract.outputs.some((output) => (
    typeof output?.name !== "string"
    || !output.name.trim()
    || !["file", "directory"].includes(output.type)
  ))) errors.push("contract output schema contains an invalid name or type");
  if (Array.isArray(manifest?.outputs) && manifest.outputs.some((output) => (
    typeof output?.name !== "string" || !output.name.trim()
  ))) errors.push("manifest output contains an invalid name");
  const contractOutputNames = (contract?.outputs ?? []).map((output) => output.name);
  const manifestOutputNames = (manifest?.outputs ?? []).map((output) => output.name);
  if (new Set(contractOutputNames).size !== contractOutputNames.length) errors.push("contract output names are duplicated");
  if (new Set(manifestOutputNames).size !== manifestOutputNames.length) errors.push("manifest output names are duplicated");
  const cacheFiles = (manifest?.outputs ?? []).map((output) => output.cacheFile);
  if (new Set(cacheFiles).size !== cacheFiles.length) errors.push("manifest cacheFile paths are duplicated");
  for (const output of manifest?.outputs ?? []) {
    for (const field of policy.cacheEvidence.requiredOutputFields) {
      if (!Object.hasOwn(output, field)) errors.push(`output ${output.name ?? "unknown"} missing ${field}`);
    }
    let cached = null;
    try {
      cached = safeCachePayload(entryDirectory, output.cacheFile);
    } catch (error) {
      errors.push(`cached output path invalid ${output.name ?? "unknown"}: ${error.message}`);
    }
    if (!["file", "directory"].includes(output.type)) {
      errors.push(`cached output type invalid: ${output.name ?? "unknown"}`);
    }
    if (
      !Object.hasOwn(output, "sizeBytes")
      || typeof output.sizeBytes !== "number"
      || !Number.isInteger(output.sizeBytes)
      || output.sizeBytes < 0
    ) errors.push(`cached output size is invalid: ${output.name ?? "unknown"}`);
    if (
      output.type === "directory"
      && (
        !Object.hasOwn(output, "fileCount")
        || typeof output.fileCount !== "number"
        || !Number.isInteger(output.fileCount)
        || output.fileCount < 0
      )
    ) {
      errors.push(`cached output file count missing: ${output.name ?? "unknown"}`);
    }
    if (!cached || !fs.existsSync(cached)) errors.push(`cached output missing: ${output.name ?? "unknown"}`);
    if (!isSha(output.sha256)) errors.push(`cached output SHA-256 missing: ${output.name ?? "unknown"}`);
    if (cached && fs.existsSync(cached)) {
      try {
        const identity = cachedOutputIdentity(cached, output.type);
        if (identity.sha256 !== output.sha256) errors.push(`cached output SHA-256 mismatch: ${output.name}`);
        if (identity.sizeBytes !== Number(output.sizeBytes)) errors.push(`cached output size mismatch: ${output.name}`);
        if (output.type === "directory" && identity.fileCount !== Number(output.fileCount)) {
          errors.push(`cached output file count mismatch: ${output.name}`);
        }
      } catch (error) {
        errors.push(`cached output invalid ${output.name}: ${error.message}`);
      }
    }
  }
  const contractSchema = [...new Set((contract?.outputs ?? []).map((item) => `${item.name}:${item.type}`))].sort();
  const manifestSchema = [...new Set((manifest?.outputs ?? []).map((item) => `${item.name}:${item.type}`))].sort();
  if (sha256Value(contractSchema) !== sha256Value(manifestSchema)) {
    errors.push("manifest outputs do not exactly match the declared output schema");
  }
  return { status: errors.length === 0 ? "ready" : "invalid", errors };
}

function cacheReportDigest(report) {
  const stable = structuredClone(report);
  delete stable.generatedAt;
  delete stable.digest;
  return sha256Value(stable);
}

export function auditHighValueCache({
  projectRoot,
  applicableKinds = [],
  expectedEntries = [],
  outputPath = null,
  writeReport = true,
  includeNonApplicableEntries = true,
} = {}) {
  const policyValidation = validateEfficiencyPolicy();
  if (policyValidation.status !== "pass") throw new Error(policyValidation.errors.join("; "));
  const root = path.resolve(projectRoot);
  const cacheRoot = path.join(root, ".kacha", "cache");
  const applicable = new Set(normalizeApplicableCacheKinds(applicableKinds));
  const expected = normalizeExpectedCacheEntries(expectedEntries);
  const expectedByKind = new Map(policy.cacheEvidence.highValueKinds.map((kind) => [
    kind,
    expected.filter((entry) => entry.kind === kind),
  ]));
  const unknownApplicableKinds = [...applicable].filter((kind) => (
    !policy.cacheEvidence.highValueKinds.includes(kind)
  ));
  const unexpectedKeyKinds = [...new Set(expected.map((entry) => entry.kind))]
    .filter((kind) => !applicable.has(kind));
  let cacheRootError = null;
  if (fs.existsSync(cacheRoot)) {
    const rootStat = fs.lstatSync(cacheRoot);
    if (rootStat.isSymbolicLink()) cacheRootError = "cache root is a symbolic link";
    else if (!rootStat.isDirectory()) cacheRootError = "cache root is not a directory";
  }
  const kinds = policy.cacheEvidence.highValueKinds.map((kind) => {
    const directory = path.join(cacheRoot, kind);
    const entries = [];
    const shouldInspect = includeNonApplicableEntries
      || applicable.size === 0
      || applicable.has(kind);
    let directoryError = cacheRootError;
    if (!directoryError && fs.existsSync(directory)) {
      const directoryStat = fs.lstatSync(directory);
      if (directoryStat.isSymbolicLink()) directoryError = `cache kind directory is a symbolic link: ${kind}`;
      else if (!directoryStat.isDirectory()) directoryError = `cache kind path is not a directory: ${kind}`;
    }
    if (shouldInspect && !directoryError && fs.existsSync(directory)) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) {
          entries.push({ key: item.name, status: "invalid", errors: ["cache entry is a symbolic link"] });
          continue;
        }
        if (!item.isDirectory() || item.name.includes(".tmp-")) continue;
        const entryDirectory = path.join(directory, item.name);
        const manifestFile = path.join(entryDirectory, "manifest.json");
        if (!fs.existsSync(manifestFile)) {
          entries.push({ key: item.name, status: "invalid", errors: ["manifest missing"] });
          continue;
        }
        try {
          entries.push({ key: item.name, ...inspectCacheEntry(entryDirectory, readJson(manifestFile), kind) });
        } catch (error) {
          entries.push({ key: item.name, status: "invalid", errors: [error.message] });
        }
      }
    }
    const readyEntries = entries.filter((entry) => entry.status === "ready").length;
    const invalidEntries = entries.length - readyEntries;
    const expectedForKind = expectedByKind.get(kind) ?? [];
    const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
    const readyExpectedEntries = expectedForKind.filter((entry) => (
      entriesByKey.get(entry.key)?.status === "ready"
    )).length;
    const missingExpectedKeys = expectedForKind
      .filter((entry) => !entriesByKey.has(entry.key))
      .map((entry) => entry.key);
    const invalidExpectedEntries = expectedForKind
      .map((entry) => entriesByKey.get(entry.key))
      .filter((entry) => entry && entry.status !== "ready");
    const applicability = applicable.size === 0 ? "unknown"
      : applicable.has(kind) ? "applicable" : "not_applicable";
    return {
      kind,
      applicability,
      status: applicability === "not_applicable" ? "not_applicable"
        : directoryError ? "invalid"
        : applicability === "unknown" ? "unknown_applicability"
          : expectedForKind.length === 0 ? "expected_keys_missing"
            : invalidExpectedEntries.length > 0 ? "invalid"
              : missingExpectedKeys.length > 0 ? "missing"
                : readyExpectedEntries === expectedForKind.length ? "ready" : "missing",
      entries: entries.length,
      readyEntries,
      invalidEntries,
      expectedEntries: expectedForKind.length,
      readyExpectedEntries,
      diagnostics: [
        ...(directoryError && applicability !== "not_applicable" ? [directoryError] : []),
        ...(applicability === "applicable" && expectedForKind.length === 0
          ? ["no expected content-addressed cache key was declared for this kind"] : []),
        ...missingExpectedKeys.map((key) => `expected cache key missing: ${key}`),
        ...invalidExpectedEntries.flatMap((entry) => entry.errors ?? []),
      ],
    };
  });
  const applicableReports = kinds.filter((item) => item.applicability === "applicable");
  const expectedCount = applicableReports.reduce((sum, item) => sum + item.expectedEntries, 0);
  const readyExpectedCount = applicableReports.reduce((sum, item) => sum + item.readyExpectedEntries, 0);
  const coverage = expectedCount > 0 ? readyExpectedCount / expectedCount : null;
  const report = {
    schemaVersion: "1.0",
    kind: "kacha-high-value-cache-audit",
    generatedAt: now(),
    projectRoot: root,
    cacheRoot,
    applicabilityStatus: applicable.size > 0 ? "declared" : "unknown",
    unknownApplicableKinds,
    unexpectedKeyKinds,
    productionReady: applicableReports.length > 0
      && unknownApplicableKinds.length === 0
      && unexpectedKeyKinds.length === 0
      && !cacheRootError
      && applicableReports.every((item) => item.status === "ready"),
    warmCoverage: coverage === null ? null : round(coverage),
    warmCoverageTarget: policy.cacheEvidence.warmCoverageTarget,
    targetMet: coverage !== null && coverage >= policy.cacheEvidence.warmCoverageTarget,
    kinds,
  };
  report.status = report.productionReady ? "pass" : "evidence_needed";
  report.digest = cacheReportDigest(report);
  const output = path.resolve(outputPath ?? path.join(root, ".kacha", "cache-audit.json"));
  if (writeReport) writeJsonAtomic(output, report);
  return { output, report };
}

function pairedProjects(baseline, candidate) {
  const candidateById = new Map((candidate.projects ?? []).map((item) => [item.projectId, item]));
  return (baseline.projects ?? []).flatMap((base) => {
    const next = candidateById.get(base.projectId);
    return next ? [{ projectId: base.projectId, baseline: base, candidate: next }] : [];
  });
}

function loadEfficiencyEvidence(identity, label, expected) {
  const errors = [];
  if (!identity?.path || !isSha(identity?.sha256)) {
    return { value: null, errors: [`${label} current file identity missing`] };
  }
  const file = path.resolve(identity.path);
  try {
    if (!fileIdentityMatches(file, identity)) {
      return { value: null, errors: [`${label} current file identity changed`] };
    }
  } catch {
    return { value: null, errors: [`${label} current file identity changed`] };
  }
  let value;
  try {
    value = readJson(file);
  } catch (error) {
    return { value: null, errors: [`${label} is not readable JSON: ${error.message}`] };
  }
  for (const [field, required] of Object.entries(expected)) {
    if (value?.[field] !== required) errors.push(`${label} ${field} does not match the paired project`);
  }
  return { value, errors };
}

function validateEfficiencyMedia(identity, label, { requireAudio = false } = {}) {
  const errors = [];
  if (!identity?.path || !isSha(identity?.sha256)) {
    return [`${label} current media identity missing`];
  }
  const file = path.resolve(identity.path);
  try {
    if (!fileIdentityMatches(file, identity)) return [`${label} current media identity changed`];
    const summary = mediaSummary(file);
    if (!summary.video || !(Number(summary.videoDuration) > 0)) {
      errors.push(`${label} is not a decodable video`);
    }
    if (requireAudio && !summary.audio) errors.push(`${label} has no reviewable audio`);
  } catch (error) {
    errors.push(`${label} media validation failed: ${error.message}`);
  }
  return errors;
}

export function compareEfficiencyEvidence(baseline, candidate) {
  const policyValidation = validateEfficiencyPolicy();
  const reasons = [...policyValidation.errors];
  if (baseline?.schemaVersion !== "1.0"
    || baseline?.kind !== "kacha-efficiency-evidence-cohort"
    || baseline?.variant !== "baseline") {
    reasons.push("baseline cohort identity is invalid");
  }
  if (candidate?.schemaVersion !== "1.0"
    || candidate?.kind !== "kacha-efficiency-evidence-cohort"
    || candidate?.variant !== "candidate") {
    reasons.push("candidate cohort identity is invalid");
  }
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) baseline = {};
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) candidate = {};
  baseline = { ...baseline, projects: baseline.projects };
  candidate = { ...candidate, projects: candidate.projects };
  for (const [label, cohort] of [["baseline", baseline], ["candidate", candidate]]) {
    if (!Array.isArray(cohort.projects)) {
      reasons.push(`${label} cohort projects must be an array`);
      cohort.projects = [];
      continue;
    }
    if (cohort.projects.some((project) => !project || typeof project !== "object" || Array.isArray(project))) {
      reasons.push(`${label} cohort contains an invalid project record`);
      cohort.projects = cohort.projects.filter((project) => (
        project && typeof project === "object" && !Array.isArray(project)
      ));
    }
  }
  const pairs = pairedProjects(baseline, candidate);
  const guardrails = policy.efficiencyClaim.requiredGuardrails;
  for (const [label, projects] of [["baseline", baseline.projects ?? []], ["candidate", candidate.projects ?? []]]) {
    const ids = projects.map((project) => project.projectId);
    if (ids.some((id) => typeof id !== "string" || !id.trim())) {
      reasons.push(`${label} project ids must be non-empty strings`);
    }
    if (new Set(ids).size !== ids.length) reasons.push(`${label} project ids are not unique`);
  }
  const baselineIds = (baseline.projects ?? []).map((project) => project.projectId).sort();
  const candidateIds = (candidate.projects ?? []).map((project) => project.projectId).sort();
  if (sha256Value(baselineIds) !== sha256Value(candidateIds)) {
    reasons.push("baseline and candidate cohort project ids do not match exactly");
  }
  const sourceGroups = pairs.map((pair) => pair.baseline.sourceSha256);
  if (new Set(sourceGroups).size !== sourceGroups.length) {
    reasons.push("paired projects do not contain distinct source groups");
  }
  for (const [label, projects] of [["baseline", baseline.projects ?? []], ["candidate", candidate.projects ?? []]]) {
    const outputs = projects.map((project) => project.outputSha256).filter(isSha);
    if (new Set(outputs).size !== outputs.length) reasons.push(`${label} output identities are not unique`);
  }
  const pairedOutputs = pairs.flatMap((pair) => [
    pair.baseline.outputSha256,
    pair.candidate.outputSha256,
  ]).filter(isSha);
  if (new Set(pairedOutputs).size !== pairedOutputs.length) {
    reasons.push("reviewed output identities are reused across paired projects");
  }
  const projects = pairs.map((pair) => {
    const projectReasons = [];
    if (policy.efficiencyClaim.requireSameSourceIdentity && (
      !isSha(pair.baseline.sourceSha256)
      || pair.baseline.sourceSha256 !== pair.candidate.sourceSha256
    )) projectReasons.push("source identity differs");
    for (const [variant, project] of [["baseline", pair.baseline], ["candidate", pair.candidate]]) {
      projectReasons.push(...validateEfficiencyMedia(project.source, `${variant} source`));
      projectReasons.push(...validateEfficiencyMedia(project.output, `${variant} reviewed output`, {
        requireAudio: true,
      }));
      if (project.source?.sha256 !== project.sourceSha256) {
        projectReasons.push(`${variant} source SHA-256 differs from its current media identity`);
      }
      if (project.output?.sha256 !== project.outputSha256) {
        projectReasons.push(`${variant} output SHA-256 differs from its current media identity`);
      }
    }
    if (!isSha(pair.baseline.outputSha256) || !isSha(pair.candidate.outputSha256)) {
      projectReasons.push("reviewed output identity missing");
    } else if (pair.baseline.outputSha256 === pair.candidate.outputSha256) {
      projectReasons.push("baseline and candidate reviewed outputs are identical");
    }
    for (const [variant, project] of [["baseline", pair.baseline], ["candidate", pair.candidate]]) {
      const reviewer = String(project.humanReview?.reviewer ?? "").trim();
      if (policy.efficiencyClaim.requireHumanReview && (
        project.humanReview?.status !== "pass" || !reviewer
      )) projectReasons.push(`${variant} human review declaration missing`);
      const humanEvidence = loadEfficiencyEvidence(
        project.humanReview?.evidence,
        `${variant} human review evidence`,
        {
          schemaVersion: "1.0",
          kind: "kacha-efficiency-human-review-evidence",
          variant,
          projectId: pair.projectId,
          sourceSha256: project.sourceSha256,
          outputSha256: project.outputSha256,
          reviewer,
          status: "pass",
        },
      );
      projectReasons.push(...humanEvidence.errors);
      if (!String(humanEvidence.value?.reviewedAt ?? "").trim()) {
        projectReasons.push(`${variant} human review timestamp missing`);
      } else if (!Number.isFinite(Date.parse(humanEvidence.value.reviewedAt))) {
        projectReasons.push(`${variant} human review timestamp is invalid`);
      }
      const metricsEvidence = loadEfficiencyEvidence(
        project.metricsEvidence,
        `${variant} metrics evidence`,
        {
          schemaVersion: "1.0",
          kind: "kacha-efficiency-metrics-evidence",
          variant,
          projectId: pair.projectId,
          sourceSha256: project.sourceSha256,
          outputSha256: project.outputSha256,
        },
      );
      projectReasons.push(...metricsEvidence.errors);
      if (!(typeof metricsEvidence.value?.wallSeconds === "number" && metricsEvidence.value.wallSeconds > 0)) {
        projectReasons.push(`${variant} metrics wall time is invalid`);
      }
      if (
        typeof metricsEvidence.value?.videoEncodes !== "number"
        || !Number.isInteger(metricsEvidence.value.videoEncodes)
        || metricsEvidence.value.videoEncodes < 0
      ) projectReasons.push(`${variant} metrics video encode count is invalid`);
      if (Number(metricsEvidence.value?.wallSeconds) !== Number(project.wallSeconds)) {
        projectReasons.push(`${variant} wall time differs from current metrics evidence`);
      }
      if (Number(metricsEvidence.value?.videoEncodes) !== Number(project.videoEncodes)) {
        projectReasons.push(`${variant} video encode count differs from current metrics evidence`);
      }
      for (const guardrail of guardrails) {
        if (project.guardrails?.[guardrail] !== "pass") {
          projectReasons.push(`${variant} guardrail not pass: ${guardrail}`);
        }
        const guardrailEvidence = loadEfficiencyEvidence(
          project.guardrailEvidence?.[guardrail],
          `${variant} guardrail evidence ${guardrail}`,
          {
            schemaVersion: "1.0",
            kind: "kacha-efficiency-guardrail-evidence",
            variant,
            projectId: pair.projectId,
            sourceSha256: project.sourceSha256,
            outputSha256: project.outputSha256,
            guardrail,
            status: "pass",
          },
        );
        projectReasons.push(...guardrailEvidence.errors);
      }
    }
    const baselineSeconds = Number(pair.baseline.wallSeconds);
    const candidateSeconds = Number(pair.candidate.wallSeconds);
    if (
      typeof pair.baseline.wallSeconds !== "number"
      || typeof pair.candidate.wallSeconds !== "number"
      || !(baselineSeconds > 0)
      || !(candidateSeconds > 0)
    ) {
      projectReasons.push("wall time evidence missing");
    }
    const baselineEncodes = Number(pair.baseline.videoEncodes);
    const candidateEncodes = Number(pair.candidate.videoEncodes);
    if (
      typeof pair.baseline.videoEncodes !== "number"
      || !Number.isInteger(baselineEncodes)
      || baselineEncodes < 0
    ) {
      projectReasons.push("baseline video encode evidence missing");
    }
    if (
      typeof pair.candidate.videoEncodes !== "number"
      || !Number.isInteger(candidateEncodes)
      || candidateEncodes < 0
    ) {
      projectReasons.push("candidate video encode evidence missing");
    } else if (candidateEncodes > 1) {
      projectReasons.push("candidate final video encode budget exceeded");
    }
    return {
      projectId: pair.projectId,
      baselineSeconds,
      candidateSeconds,
      savedSeconds: Number.isFinite(baselineSeconds) && Number.isFinite(candidateSeconds)
        ? round(baselineSeconds - candidateSeconds) : null,
      status: projectReasons.length === 0 ? "comparable" : "blocked",
      reasons: projectReasons,
    };
  });
  if (pairs.length < policy.efficiencyClaim.minimumPairedProjects) {
    reasons.push(`paired projects ${pairs.length} < ${policy.efficiencyClaim.minimumPairedProjects}`);
  }
  const blocked = projects.filter((project) => project.status === "blocked");
  if (blocked.length > 0) reasons.push(`${blocked.length} paired projects fail comparability or quality guardrails`);
  const comparable = projects.filter((project) => project.status === "comparable");
  const baselineSeconds = comparable.reduce((sum, item) => sum + item.baselineSeconds, 0);
  const candidateSeconds = comparable.reduce((sum, item) => sum + item.candidateSeconds, 0);
  const savedSeconds = baselineSeconds - candidateSeconds;
  if (!(savedSeconds > 0)) reasons.push("candidate cohort has no measured wall-time improvement");
  const supportsEfficiencyClaim = reasons.length === 0;
  return {
    schemaVersion: "1.0",
    kind: "kacha-efficiency-evidence-comparison",
    generatedAt: now(),
    status: supportsEfficiencyClaim ? "pass" : "insufficient_evidence",
    supportsEfficiencyClaim,
    pairedProjects: pairs.length,
    comparableProjects: comparable.length,
    minimumPairedProjects: policy.efficiencyClaim.minimumPairedProjects,
    totals: {
      baselineWallSeconds: round(baselineSeconds),
      candidateWallSeconds: round(candidateSeconds),
      savedSeconds: round(savedSeconds),
      improvementRatio: baselineSeconds > 0 ? round(savedSeconds / baselineSeconds) : null,
    },
    reasons,
    projects,
    evidenceBoundary: supportsEfficiencyClaim
      ? "仅支持当前同源成对样本，不外推到未测项目、设备或剪辑类型。"
      : "禁止宣称效率提升；先补齐同源成对样本、人工审片和全部关键质量护栏。",
  };
}

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs efficiency plan PROJECT [--cues FILE|--clear-cues] [--delta FILE|--clear-delta] "
      + "[--applicable-cache-kinds a,b] [--expected-cache-keys kind:sha256,...] [--output FILE]\n"
      + "  kacha.mjs efficiency validate-policy\n"
      + "  kacha.mjs efficiency validate PLAN.json\n"
      + "  kacha.mjs efficiency schedule [--output FILE]\n"
      + "  kacha.mjs efficiency execute EXECUTION-PLAN.json\n"
      + "  kacha.mjs efficiency cache-audit PROJECT --applicable-cache-kinds a,b "
      + "--expected-cache-keys kind:sha256,... [--output FILE]\n"
      + "  kacha.mjs efficiency compare BASELINE.json CANDIDATE.json [--output FILE]",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const [action, first, second] = args;
  try {
    if (action === "validate-policy") {
      const report = validateEfficiencyPolicy();
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === "pass" ? 0 : 1;
      return;
    }
    if (action === "plan" && first) {
      const result = buildEfficiencyPlan({
        projectRoot: first,
        cuesPath: option(args, "--cues"),
        deltaPath: option(args, "--delta"),
        clearCues: args.includes("--clear-cues"),
        clearDelta: args.includes("--clear-delta"),
        applicableCacheKinds: args.includes("--applicable-cache-kinds")
          ? listOption(args, "--applicable-cache-kinds")
          : null,
        expectedCacheEntries: args.includes("--expected-cache-keys")
          ? listOption(args, "--expected-cache-keys")
          : null,
        outputPath: option(args, "--output"),
      });
      console.log(JSON.stringify({ status: result.plan.status, output: result.output, plan: result.plan }, null, 2));
      process.exitCode = result.plan.status === "pass" ? 0 : 1;
      return;
    }
    if (action === "validate" && first) {
      const report = validateEfficiencyPlan(readJson(path.resolve(first)));
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === "pass" ? 0 : 1;
      return;
    }
    if (action === "schedule") {
      const report = buildSchedule();
      const output = option(args, "--output");
      if (output) writeJsonAtomic(path.resolve(output), report);
      console.log(JSON.stringify({ ...report, output: output ? path.resolve(output) : null }, null, 2));
      process.exitCode = report.status === "pass" ? 0 : 1;
      return;
    }
    if (action === "execute" && first) {
      const result = await executeEfficiencyTasks(first);
      console.log(JSON.stringify({ status: result.report.status, output: result.output, report: result.report }, null, 2));
      process.exitCode = result.report.status === "pass" ? 0 : 1;
      return;
    }
    if (action === "cache-audit" && first) {
      const result = auditHighValueCache({
        projectRoot: first,
        applicableKinds: listOption(args, "--applicable-cache-kinds"),
        expectedEntries: listOption(args, "--expected-cache-keys"),
        outputPath: option(args, "--output"),
      });
      console.log(JSON.stringify({ status: result.report.status, output: result.output, report: result.report }, null, 2));
      process.exitCode = result.report.status === "pass" ? 0 : 1;
      return;
    }
    if (action === "compare" && first && second && !second.startsWith("--")) {
      const report = compareEfficiencyEvidence(readJson(path.resolve(first)), readJson(path.resolve(second)));
      const output = option(args, "--output");
      if (output) writeJsonAtomic(path.resolve(output), report);
      console.log(JSON.stringify({ ...report, output: output ? path.resolve(output) : null }, null, 2));
      process.exitCode = report.supportsEfficiencyClaim ? 0 : 1;
      return;
    }
    usage();
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
