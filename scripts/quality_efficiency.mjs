#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  fileIdentityMatches,
  readJson,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const policyFile = path.join(skillRoot, "config", "efficiency-policy.json");
const recipeFile = path.join(skillRoot, "config", "workflow-recipes.json");
const policy = readJson(policyFile);

export function validateEfficiencyPolicy() {
  const errors = [];
  if (policy.schemaVersion !== "1.0" || policy.kind !== "kacha-quality-preserving-efficiency-policy") {
    errors.push("efficiency policy identity is invalid");
  }
  for (const [key, value] of Object.entries(policy.immutableQualityInvariants ?? {})) {
    if (value !== true) errors.push(`quality invariant must remain true: ${key}`);
  }
  if (Object.keys(policy.immutableQualityInvariants ?? {}).length < 8) errors.push("quality invariants are incomplete");
  const thresholds = policy.risk?.thresholds ?? {};
  if (!(thresholds.standard < thresholds.high && thresholds.high < thresholds.critical)) {
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
  ) errors.push("heavy resource or output conflict policy is invalid");
  for (const kind of ["source_separation", "asr", "mask", "tracking", "beauty", "styleframe", "generated_media"]) {
    if (!policy.cacheEvidence?.highValueKinds?.includes(kind)) errors.push(`high-value cache kind missing: ${kind}`);
  }
  if (
    !(policy.cacheEvidence?.warmCoverageTarget > 0)
    || !(policy.cacheEvidence?.warmCoverageTarget <= 1)
  ) errors.push("cache warm coverage target is invalid");
  if (
    !(policy.efficiencyClaim?.minimumPairedProjects >= 8)
    || (policy.efficiencyClaim?.requiredGuardrails?.length ?? 0) < 6
  ) errors.push("efficiency claim evidence policy is incomplete");
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
  return rangeAround(
    { start: Math.max(0, anchor - 0.5), end: Math.min(duration, anchor + 0.5) },
    duration,
    category,
    `structural:${category}`,
    "structural_fallback_requires_human_confirmation",
  );
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
  const groups = [];
  for (let index = 0; index < maximumGroups; index += 1) {
    const from = Math.floor(index * intervals.length / maximumGroups);
    const to = Math.floor((index + 1) * intervals.length / maximumGroups);
    const members = intervals.slice(from, to);
    groups.push({
      start: members[0].start,
      end: members.at(-1).end,
      refs: members.flatMap((item) => item.refs),
      durationBudgetException: true,
    });
  }
  return groups;
}

export function selectIncrementalRepresentativeRanges(delta, duration) {
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

function runTask(task, projectRoot) {
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
      const missing = outputs.filter((output) => (
        !fs.existsSync(output) || !fs.statSync(output).isFile()
      ));
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
  const contract = readJson(resolved);
  const errors = [];
  if (contract.kind !== "kacha-efficiency-execution-plan") errors.push("execution plan kind is invalid");
  if (contract.authorization?.localExecution !== true) errors.push("local execution is not authorized");
  if (
    contract.authorization?.upload === true
    || contract.authorization?.paidGeneration === true
    || contract.authorization?.publish === true
    || contract.authorization?.overwriteSource === true
  ) errors.push("execution plan exceeds local-only authority");
  const projectRoot = path.resolve(contract.projectRoot ?? path.dirname(resolved));
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) errors.push("project root does not exist");
  const tasks = contract.tasks ?? [];
  if (!Array.isArray(tasks) || tasks.length === 0) errors.push("execution plan has no tasks");
  const normalizedOutputOwners = new Map();
  for (const task of tasks) {
    try {
      for (const output of task.outputs ?? []) {
        const normalized = safeProjectOutput(projectRoot, output);
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
  const report = {
    schemaVersion: "1.0",
    kind: "kacha-efficiency-execution-report",
    generatedAt: now(),
    projectRoot,
    contract: fileIdentity(resolved),
    schedule,
    status: results.length === tasks.length && results.every((result) => result.status === "pass")
      ? "pass" : "blocked",
    results: results.map((result) => ({
      id: result.id,
      status: result.status,
      exitCode: result.exitCode,
      outputs: result.outputs.map((output) => (
        fs.existsSync(output) && fs.statSync(output).isFile()
          ? fileIdentity(output)
          : { path: output, missing: true }
      )),
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
  const errors = [];
  const invariants = plan.qualityInvariants ?? {};
  for (const [key, required] of Object.entries(policy.immutableQualityInvariants)) {
    if (required === true && invariants[key] !== true) errors.push(`quality invariant disabled: ${key}`);
  }
  if (plan.source?.durationSeconds) {
    const ranges = plan.representativePreview?.ranges ?? [];
    if (plan.mode === "first_edit") {
      const categories = new Set(ranges.flatMap(
        (range) => range.categories ?? [range.category],
      ));
      for (const category of policy.representativePreview.firstEditRequiredCategories) {
        if (!categories.has(category)) errors.push(`first edit preview missing category: ${category}`);
      }
    }
    if (plan.mode === "incremental") {
      if (ranges.length > policy.representativePreview.incrementalMaximumRanges) {
        errors.push("incremental representative range budget exceeded");
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
        range.startSeconds < 0
        || range.endSeconds > plan.source.durationSeconds + 0.001
        || range.endSeconds <= range.startSeconds
      ) errors.push(`invalid representative range: ${range.id}`);
    }
  }
  if (plan.schedule?.status !== "pass") errors.push(...(plan.schedule?.errors ?? ["schedule blocked"]));
  for (const [name, identity] of Object.entries(plan.inputs ?? {})) {
    if (identity?.path && !fileIdentityMatches(identity.path, identity)) {
      errors.push(`efficiency plan input changed: ${name}`);
    }
  }
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
  applicableCacheKinds = null,
  outputPath = null,
} = {}) {
  const policyValidation = validateEfficiencyPolicy();
  if (policyValidation.status !== "pass") throw new Error(policyValidation.errors.join("; "));
  const orchestration = loadOrchestration(projectRoot);
  const output = path.resolve(outputPath ?? path.join(orchestration.root, ".kacha", "efficiency-plan.json"));
  let previous = null;
  if (fs.existsSync(output)) {
    try {
      previous = readJson(output);
    } catch {
      // An unreadable prior plan contributes no evidence to the refresh.
    }
  }
  const reusablePath = (candidate) => (
    candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null
  );
  const effectiveCuesPath = cuesPath ?? reusablePath(previous?.inputs?.cues?.path);
  const effectiveDeltaPath = deltaPath ?? reusablePath(previous?.inputs?.delta?.path);
  const effectiveCacheKinds = applicableCacheKinds ?? previous?.cache?.applicableKinds ?? [];
  const cuesInput = loadOptionalJson(effectiveCuesPath);
  const deltaInput = loadOptionalJson(effectiveDeltaPath);
  const cues = cuesInput?.value?.cues ?? cuesInput?.value?.segments ?? [];
  const delta = deltaInput?.value ?? null;
  const duration = sourceDuration(orchestration.value);
  const mode = delta ? "incremental"
    : orchestration.value.task === "content_generation" ? "content_planning" : "first_edit";
  const ranges = duration
    ? (delta ? selectIncrementalRepresentativeRanges(delta, duration) : firstEditRanges(cues, duration))
    : [];
  const changeIntervals = delta?.changeSet?.scope?.intervals ?? delta?.renderPlan?.intervals ?? [];
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
      evidenceKnown: Boolean(cuesInput),
    }),
    qualityInvariants: structuredClone(policy.immutableQualityInvariants),
    representativePreview: {
      status: duration ? "planned" : "awaiting_source_media",
      ranges,
      representativeApprovalRequired: true,
      fullPreviewEncodeBudget: 1,
      finalVideoEncodeBudget: 1,
      fullCandidatePlaybackRequired: true,
      structuralFallbacks: ranges.filter((range) => range.selectionEvidence.includes("fallback")).length,
    },
    changeCoverage: {
      required: Boolean(delta && policy.representativePreview.incrementalChangeCoverageRequired),
      intervals: changeIntervals,
    },
    schedule: buildSchedule(),
    cache: {
      applicableKinds: [...new Set(effectiveCacheKinds)].sort(),
      applicabilityStatus: effectiveCacheKinds.length > 0 ? "declared" : "awaiting_stage_plan",
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
  if (type === "file") {
    if (!fs.statSync(candidate).isFile()) throw new Error("cached output is not a file");
    return {
      sizeBytes: fs.statSync(candidate).size,
      sha256: sha256File(candidate),
    };
  }
  if (type !== "directory" || !fs.statSync(candidate).isDirectory()) {
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

function inspectCacheEntry(entryDirectory, manifest, kind) {
  const errors = [];
  const contract = manifest?.contract;
  if (manifest?.status !== "ready") errors.push("manifest status is not ready");
  if (!isSha(manifest?.key) || path.basename(entryDirectory) !== manifest.key) errors.push("cache key identity mismatch");
  if (!isSha(manifest?.configurationDigest)) errors.push("cache configuration digest missing");
  if (manifest?.kind !== kind || contract?.kind !== kind) errors.push("kind mismatch");
  for (const field of policy.cacheEvidence.requiredContractFields) {
    if (!Object.hasOwn(contract ?? {}, field)) errors.push(`contract missing ${field}`);
  }
  if (!(contract?.inputs?.length > 0) || contract.inputs.some((input) => !isSha(input.sha256))) {
    errors.push("source/input SHA-256 evidence missing");
  }
  if (!(contract?.implementation?.length > 0) || contract.implementation.some((item) => !isSha(item.sha256))) {
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
  for (const output of manifest?.outputs ?? []) {
    for (const field of policy.cacheEvidence.requiredOutputFields) {
      if (!Object.hasOwn(output, field)) errors.push(`output ${output.name ?? "unknown"} missing ${field}`);
    }
    const cached = path.join(entryDirectory, output.cacheFile ?? "");
    if (!fs.existsSync(cached)) errors.push(`cached output missing: ${output.name ?? "unknown"}`);
    if (!isSha(output.sha256)) errors.push(`cached output SHA-256 missing: ${output.name ?? "unknown"}`);
    if (fs.existsSync(cached)) {
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
  const outputSchema = new Set((contract?.outputs ?? []).map((item) => `${item.name}:${item.type}`));
  for (const output of manifest?.outputs ?? []) {
    if (!outputSchema.has(`${output.name}:${output.type}`)) errors.push(`output schema mismatch: ${output.name}`);
  }
  return { status: errors.length === 0 ? "ready" : "invalid", errors };
}

export function auditHighValueCache({ projectRoot, applicableKinds = [], outputPath = null } = {}) {
  const root = path.resolve(projectRoot);
  const cacheRoot = path.join(root, ".kacha", "cache");
  const applicable = new Set(applicableKinds);
  const unknownApplicableKinds = [...applicable].filter((kind) => (
    !policy.cacheEvidence.highValueKinds.includes(kind)
  ));
  const kinds = policy.cacheEvidence.highValueKinds.map((kind) => {
    const directory = path.join(cacheRoot, kind);
    const entries = [];
    if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
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
    const applicability = applicable.size === 0 ? "unknown"
      : applicable.has(kind) ? "applicable" : "not_applicable";
    return {
      kind,
      applicability,
      status: applicability === "not_applicable" ? "not_applicable"
        : readyEntries > 0 && invalidEntries === 0 ? "ready"
          : invalidEntries > 0 ? "invalid"
          : applicability === "unknown" ? "unknown_applicability" : "missing",
      entries: entries.length,
      readyEntries,
      invalidEntries,
      diagnostics: entries.flatMap((entry) => entry.errors ?? []),
    };
  });
  const applicableReports = kinds.filter((item) => item.applicability === "applicable");
  const readyApplicable = applicableReports.filter((item) => item.status === "ready").length;
  const coverage = applicableReports.length > 0 ? readyApplicable / applicableReports.length : null;
  const report = {
    schemaVersion: "1.0",
    kind: "kacha-high-value-cache-audit",
    generatedAt: now(),
    projectRoot: root,
    cacheRoot,
    applicabilityStatus: applicable.size > 0 ? "declared" : "unknown",
    unknownApplicableKinds,
    productionReady: applicableReports.length > 0
      && unknownApplicableKinds.length === 0
      && applicableReports.every((item) => item.status === "ready"),
    warmCoverage: coverage === null ? null : round(coverage),
    warmCoverageTarget: policy.cacheEvidence.warmCoverageTarget,
    targetMet: coverage !== null && coverage >= policy.cacheEvidence.warmCoverageTarget,
    kinds,
  };
  report.status = report.productionReady ? "pass" : "evidence_needed";
  const output = path.resolve(outputPath ?? path.join(root, ".kacha", "cache-audit.json"));
  writeJsonAtomic(output, report);
  return { output, report };
}

function pairedProjects(baseline, candidate) {
  const candidateById = new Map((candidate.projects ?? []).map((item) => [item.projectId, item]));
  return (baseline.projects ?? []).flatMap((base) => {
    const next = candidateById.get(base.projectId);
    return next ? [{ projectId: base.projectId, baseline: base, candidate: next }] : [];
  });
}

export function compareEfficiencyEvidence(baseline, candidate) {
  const reasons = [];
  const pairs = pairedProjects(baseline, candidate);
  const guardrails = policy.efficiencyClaim.requiredGuardrails;
  for (const [label, projects] of [["baseline", baseline.projects ?? []], ["candidate", candidate.projects ?? []]]) {
    const ids = projects.map((project) => project.projectId);
    if (new Set(ids).size !== ids.length) reasons.push(`${label} project ids are not unique`);
  }
  const sourceGroups = pairs.map((pair) => pair.baseline.sourceSha256);
  if (new Set(sourceGroups).size !== sourceGroups.length) {
    reasons.push("paired projects do not contain distinct source groups");
  }
  const projects = pairs.map((pair) => {
    const projectReasons = [];
    if (policy.efficiencyClaim.requireSameSourceIdentity && (
      !isSha(pair.baseline.sourceSha256)
      || pair.baseline.sourceSha256 !== pair.candidate.sourceSha256
    )) projectReasons.push("source identity differs");
    if (policy.efficiencyClaim.requireHumanReview && (
      pair.baseline.humanReview?.status !== "pass"
      || pair.candidate.humanReview?.status !== "pass"
      || !String(pair.baseline.humanReview?.reviewer ?? "").trim()
      || !String(pair.candidate.humanReview?.reviewer ?? "").trim()
      || !isSha(pair.baseline.humanReview?.evidenceSha256)
      || !isSha(pair.candidate.humanReview?.evidenceSha256)
    )) projectReasons.push("human review evidence missing");
    if (!isSha(pair.baseline.metricsEvidenceSha256) || !isSha(pair.candidate.metricsEvidenceSha256)) {
      projectReasons.push("metrics evidence identity missing");
    }
    for (const guardrail of guardrails) {
      if (
        pair.baseline.guardrails?.[guardrail] !== "pass"
        || pair.candidate.guardrails?.[guardrail] !== "pass"
      ) projectReasons.push(`guardrail not pass: ${guardrail}`);
      if (
        !isSha(pair.baseline.guardrailEvidence?.[guardrail]?.sha256)
        || !isSha(pair.candidate.guardrailEvidence?.[guardrail]?.sha256)
      ) projectReasons.push(`guardrail evidence missing: ${guardrail}`);
    }
    const baselineSeconds = Number(pair.baseline.wallSeconds);
    const candidateSeconds = Number(pair.candidate.wallSeconds);
    if (!(baselineSeconds > 0) || !(candidateSeconds > 0)) {
      projectReasons.push("wall time evidence missing");
    }
    if (Number(pair.candidate.videoEncodes ?? 0) > 1) projectReasons.push("candidate final video encode budget exceeded");
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
      + "  kacha.mjs efficiency plan PROJECT [--cues FILE] [--delta FILE] [--applicable-cache-kinds a,b] [--output FILE]\n"
      + "  kacha.mjs efficiency validate-policy\n"
      + "  kacha.mjs efficiency validate PLAN.json\n"
      + "  kacha.mjs efficiency schedule [--output FILE]\n"
      + "  kacha.mjs efficiency execute EXECUTION-PLAN.json\n"
      + "  kacha.mjs efficiency cache-audit PROJECT --applicable-cache-kinds a,b [--output FILE]\n"
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
        applicableCacheKinds: args.includes("--applicable-cache-kinds")
          ? listOption(args, "--applicable-cache-kinds")
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
