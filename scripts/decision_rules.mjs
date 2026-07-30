#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const registryFile = path.join(
  path.resolve(scriptDirectory, ".."),
  "config",
  "decision-rules.json",
);
const args = process.argv.slice(2);
const action = args[0];
const STAGES = new Set(["inventory", "content", "edit", "visual_audio", "release"]);
const PRIORITY_SCORE = { required: 1000, high: 500, normal: 100, low: 10 };

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonOrFile(value, fallback) {
  if (!value) return fallback;
  const file = path.resolve(value);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return readJson(file);
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`无法解析 JSON 参数：${error.message}`);
  }
}

function validateRegistry(registry) {
  const errors = [];
  if (registry.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (!registry.id || !registry.version) errors.push("id/version 不能为空");
  if (!Array.isArray(registry.rules) || registry.rules.length < 10) {
    errors.push("rules 至少包含 10 条生产规则");
  }
  const ids = new Set();
  for (const [index, rule] of (registry.rules ?? []).entries()) {
    const label = `rules[${index}]`;
    if (!/^[a-z][a-z0-9-]+$/.test(rule.id ?? "") || ids.has(rule.id)) {
      errors.push(`${label}.id 无效或重复`);
    }
    ids.add(rule.id);
    if (
      !Array.isArray(rule.stages)
      || rule.stages.length === 0
      || rule.stages.some((stage) => !STAGES.has(stage))
    ) {
      errors.push(`${label}.stages 无效`);
    }
    if (!Array.isArray(rule.modules) || rule.modules.length === 0) {
      errors.push(`${label}.modules 不能为空`);
    }
    if (!Array.isArray(rule.signals) || rule.signals.length === 0) {
      errors.push(`${label}.signals 不能为空`);
    }
    if (!Object.hasOwn(PRIORITY_SCORE, rule.priority)) {
      errors.push(`${label}.priority 无效`);
    }
    if (!rule.decision || !rule.fallback) errors.push(`${label} 缺少 decision/fallback`);
    if (
      !Array.isArray(rule.candidates)
      || rule.candidates.length < 1
      || rule.candidates.length > 3
      || rule.candidates.some(
        (candidate) => !candidate.recipe || !Number.isFinite(Number(candidate.score)),
      )
    ) {
      errors.push(`${label}.candidates 必须包含 1–3 个带分数配方`);
    }
  }
  return errors;
}

function loadRegistry() {
  const registry = readJson(registryFile);
  const errors = validateRegistry(registry);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return registry;
}

function queryRules(registry, { stage, modules, signals, limit }) {
  const moduleSet = new Set(modules);
  const signalSet = new Set(signals);
  return registry.rules
    .filter((rule) => rule.stages.includes(stage))
    .filter((rule) => (
      moduleSet.size === 0
      || moduleSet.has("all")
      || rule.modules.some((module) => moduleSet.has(module))
    ))
    .map((rule) => {
      const matches = rule.signals.filter(
        (signal) => signal === "always" || signalSet.has(signal),
      );
      return {
        ...rule,
        matchedSignals: matches,
        retrievalScore: PRIORITY_SCORE[rule.priority] + matches.length * 25,
        candidates: [...rule.candidates]
          .sort((left, right) => (
            Number(right.score) - Number(left.score)
            || left.recipe.localeCompare(right.recipe)
          ))
          .slice(0, 3),
      };
    })
    .filter((rule) => rule.matchedSignals.length > 0)
    .sort((left, right) => (
      right.retrievalScore - left.retrievalScore
      || left.id.localeCompare(right.id)
    ))
    .slice(0, limit);
}

function compileDecisions(registry, cues, seed, modelTier) {
  const scales = ["wide", "medium", "close", "closeup"];
  let previousScale = null;
  let scaleCursor = Number(seed) % scales.length;
  let outputCursor = 0;
  const decisions = [];
  for (const [index, cue] of cues.entries()) {
    const signals = [...new Set(cue.signals ?? [])].sort();
    const signalSet = new Set(signals);
    const confidence = Number(cue.confidence ?? 1);
    const sourceStart = Number(cue.sourceStart ?? cue.start);
    const sourceEnd = Number(cue.sourceEnd ?? cue.end);
    const outputDuration = sourceEnd - sourceStart;
    const narrativeChange = [
      "information_change",
      "emotion_change",
      "viewpoint_change",
    ].some((signal) => signalSet.has(signal));
    const cut = index === 0 || (
      narrativeChange && !signalSet.has("no_narrative_change")
    );
    let shotScale = previousScale;
    if (cut) {
      scaleCursor = (scaleCursor + 1) % scales.length;
      if (signalSet.has("logical_emphasis")) {
        scaleCursor = scales.indexOf(
          previousScale === "closeup" ? "close" : "closeup",
        );
      }
      shotScale = scales[scaleCursor];
      if (shotScale === previousScale) {
        scaleCursor = (scaleCursor + 1) % scales.length;
        shotScale = scales[scaleCursor];
      }
    }
    const transition = !cut
      ? "none"
      : index === 0
        ? "opening"
        : signalSet.has("action_continuity")
          ? "match_action_cut"
          : signalSet.has("chapter_change")
            ? "audio_bridge"
            : "motivated_hard_cut";
    const subtitleRecipe = signalSet.has("bright_surface")
      ? "dark_caption_on_bright"
      : signalSet.has("logical_emphasis")
        ? "keyword_weight_and_scale"
        : "jinling_plain_single";
    const sfxRecipe = signalSet.has("typing_requested")
      ? "single_keyboard_click"
      : signalSet.has("effect_peak") || signalSet.has("logical_emphasis")
        ? "semantic_peak_sfx"
        : "none";
    const rules = queryRules(registry, {
      stage: "edit",
      modules: ["cut", "transition", "camera", "decision"],
      signals,
      limit: 8,
    });
    const requiresEscalation = confidence < 0.65
      || signalSet.has("low_confidence")
      || signalSet.has("rule_conflict");
    const decision = {
      id: cue.id ?? `cue-${String(index + 1).padStart(4, "0")}`,
      start: Number(cue.start),
      end: Number(cue.end),
      sourceStart,
      sourceEnd,
      outputStart: outputCursor,
      outputEnd: outputCursor + outputDuration,
      text: String(cue.text ?? ""),
      signals,
      confidence,
      cut: {
        apply: cut,
        reason: index === 0
          ? "opening"
          : narrativeChange
            ? signals.filter((signal) => signal.endsWith("_change"))
            : ["no_narrative_change"],
        shotScale,
        transition,
      },
      subtitle: { recipe: subtitleRecipe },
      sound: { recipe: sfxRecipe },
      rules: rules.map((rule) => ({
        id: rule.id,
        decision: rule.decision,
        selectedRecipe: rule.candidates[0].recipe,
        selectedScore: rule.candidates[0].score,
        fallback: rule.fallback,
      })),
      execution: requiresEscalation
        ? {
            mode: "local_preview_then_escalate",
            owner: modelTier === "economy" ? "frontier_model_or_human" : "human",
            finalRenderAllowed: false,
          }
        : {
            mode: "deterministic",
            owner: "render_engine",
            finalRenderAllowed: true,
          },
    };
    decisions.push(decision);
    outputCursor = decision.outputEnd;
    previousScale = shotScale;
  }
  const timelinePatch = {
    edl: decisions.map((decision, index) => ({
      id: decision.id || `segment-${String(index + 1).padStart(4, "0")}`,
      sourceStart: decision.sourceStart,
      sourceEnd: decision.sourceEnd,
      sourceDecisionId: decision.id,
    })),
    breathing: decisions
      .filter((decision) => (
        decision.execution.finalRenderAllowed
        && decision.signals.includes("logical_emphasis")
        && decision.outputEnd - decision.outputStart >= 0.4
      ))
      .map((decision) => ({
        start: decision.outputStart,
        end: Math.min(decision.outputEnd, decision.outputStart + 1.2),
        scale: 1.045,
        anchorX: 0.5,
        anchorY: 0.45,
        entryRatio: 0.3,
        exitRatio: 0.3,
        sourceDecisionId: decision.id,
      })),
  };
  return { decisions, timelinePatch };
}

let registry;
try {
  registry = loadRegistry();
} catch (error) {
  fail(error.message);
}
if (action === "validate") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    registry: registryFile,
    registrySha256: sha256File(registryFile),
    version: registry.version,
    ruleCount: registry.rules.length,
  }, null, 2));
  process.exit(0);
}
if (action === "query") {
  const stage = option("--stage");
  if (!STAGES.has(stage)) fail("--stage 无效", 2);
  let signalValue;
  try {
    signalValue = parseJsonOrFile(option("--signals"), []);
  } catch (error) {
    fail(error.message, 2);
  }
  const signals = Array.isArray(signalValue)
    ? signalValue
    : signalValue.signals ?? [];
  const rules = queryRules(registry, {
    stage,
    modules: parseList(option("--modules")),
    signals,
    limit: Math.max(1, Math.min(30, Number(option("--limit", "10")))),
  });
  const report = {
    schemaVersion: "1.0",
    status: "pass",
    stage,
    modules: parseList(option("--modules")),
    signals,
    rules,
    registryDigest: sha256Value(registry),
  };
  const output = option("--output");
  if (output) writeJsonAtomic(path.resolve(output), report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
if (action === "apply") {
  const decisionInput = option("--decision-plan");
  const timelineInput = option("--timeline");
  const output = option("--output");
  const previewOnly = args.includes("--preview-only");
  if (!decisionInput || !timelineInput || !output) {
    fail(
      "rules apply 需要 --decision-plan PLAN --timeline TIMELINE "
        + "--output NEW-TIMELINE [--preview-only] [--video-output VIDEO]",
      2,
    );
  }
  const decisionFile = path.resolve(decisionInput);
  const timelineFile = path.resolve(timelineInput);
  const outputFile = path.resolve(output);
  if (fs.existsSync(outputFile)) fail(`拒绝覆盖已有时间线：${outputFile}`, 2);
  let decisionPlan;
  let timeline;
  try {
    decisionPlan = readJson(decisionFile);
    timeline = readJson(timelineFile);
  } catch (error) {
    fail(`决策计划或时间线无法解析：${error.message}`, 2);
  }
  const stableDecision = { ...decisionPlan };
  delete stableDecision.generatedAt;
  delete stableDecision.digest;
  delete stableDecision.provenance;
  if (
    decisionPlan.kind !== "kacha_deterministic_decision_plan"
    || sha256Value(stableDecision) !== decisionPlan.digest
  ) {
    fail("决策计划 digest 无效或文件已被修改", 2);
  }
  if (
    Number(decisionPlan.quality?.escalationCount ?? 0) > 0
    && !previewOnly
  ) {
    fail("决策计划含升级项；只能 --preview-only，禁止直接进入最终渲染");
  }
  const breathing = [
    ...(timeline.visual?.breathing ?? []),
    ...(decisionPlan.timelinePatch?.breathing ?? []),
  ].sort((left, right) => Number(left.start) - Number(right.start));
  for (let index = 1; index < breathing.length; index += 1) {
    if (Number(breathing[index].start) < Number(breathing[index - 1].end) - 0.0001) {
      fail("决策呼吸事件与现有事件重叠，必须先解决冲突");
    }
  }
  const next = {
    ...timeline,
    mode: previewOnly ? "preview" : timeline.mode,
    edl: decisionPlan.timelinePatch.edl,
    visual: {
      ...(timeline.visual ?? {}),
      breathing,
    },
    decisionPlan: {
      path: path.relative(path.dirname(outputFile), decisionFile),
      sha256: sha256File(decisionFile),
      digest: decisionPlan.digest,
      escalationCount: decisionPlan.quality.escalationCount,
    },
    output: {
      ...timeline.output,
      ...(option("--video-output")
        ? { path: path.resolve(option("--video-output")) }
        : {}),
    },
  };
  writeJsonAtomic(outputFile, next);
  const validation = run(process.execPath, [
    path.join(scriptDirectory, "timeline_ir.mjs"),
    "validate",
    "--plan",
    outputFile,
  ]);
  if (validation.status !== 0) {
    fs.unlinkSync(outputFile);
    fail(validation.stderr.trim() || validation.stdout.trim());
  }
  console.log(JSON.stringify({
    status: "pass",
    output: outputFile,
    mode: next.mode,
    decisionDigest: decisionPlan.digest,
    edlSegments: next.edl.length,
    breathingEvents: next.visual.breathing.length,
    finalRenderAllowed: !previewOnly
      && decisionPlan.quality.escalationCount === 0,
  }, null, 2));
  process.exit(0);
}
if (action !== "compile") {
  fail(
    "用法：kacha.mjs rules validate | rules query --stage STAGE "
      + "--modules LIST --signals JSON|FILE | "
      + "rules compile --cues CUES.json --output PLAN.json "
      + "[--seed 0] [--model-tier economy|balanced|frontier] | "
      + "rules apply --decision-plan PLAN --timeline TIMELINE --output NEW-TIMELINE",
    2,
  );
}
const cuesFile = option("--cues");
const output = option("--output");
const modelTier = option("--model-tier", "economy");
if (!cuesFile || !output || !["economy", "balanced", "frontier"].includes(modelTier)) {
  fail("--cues、--output 或 --model-tier 无效", 2);
}
let cueValue;
try {
  cueValue = readJson(path.resolve(cuesFile));
} catch (error) {
  fail(`cues 无法解析：${error.message}`, 2);
}
const cues = Array.isArray(cueValue) ? cueValue : cueValue.cues;
if (!Array.isArray(cues) || cues.length === 0) fail("cues 不能为空", 2);
let previousCueEnd = null;
for (const [index, cue] of cues.entries()) {
  const start = Number(cue.start);
  const end = Number(cue.end);
  const sourceStart = Number(cue.sourceStart ?? cue.start);
  const sourceEnd = Number(cue.sourceEnd ?? cue.end);
  const confidence = Number(cue.confidence ?? 1);
  if (
    !Number.isFinite(start)
    || !Number.isFinite(end)
    || end <= start
    || start < 0
    || (previousCueEnd !== null && start < previousCueEnd - 0.0001)
  ) {
    fail(`cues[${index}] 时间无效、乱序或重叠`, 2);
  }
  if (
    !Number.isFinite(sourceStart)
    || !Number.isFinite(sourceEnd)
    || sourceStart < 0
    || sourceEnd <= sourceStart
  ) {
    fail(`cues[${index}] sourceStart/sourceEnd 无效`, 2);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail(`cues[${index}].confidence 必须在 0–1`, 2);
  }
  if (
    cue.signals !== undefined
    && (
      !Array.isArray(cue.signals)
      || cue.signals.some((signal) => typeof signal !== "string" || !signal.trim())
    )
  ) {
    fail(`cues[${index}].signals 必须是非空字符串数组`, 2);
  }
  previousCueEnd = end;
}
const seed = Number(option("--seed", "0"));
if (!Number.isInteger(seed) || seed < 0) fail("--seed 必须是非负整数", 2);
const compiled = compileDecisions(registry, cues, seed, modelTier);
const stable = {
  schemaVersion: "1.0",
  kind: "kacha_deterministic_decision_plan",
  registry: {
    id: registry.id,
    sha256: sha256File(registryFile),
    digest: sha256Value(registry),
    version: registry.version,
  },
  source: {
    sha256: sha256File(path.resolve(cuesFile)),
    cueCount: cues.length,
  },
  modelTier,
  seed,
  decisions: compiled.decisions,
  timelinePatch: compiled.timelinePatch,
  quality: {
    deterministic: true,
    sameScaleAdjacentCutsForbidden: true,
    weakModelMayExecuteOnlyFinalRenderAllowed: true,
    escalationCount: compiled.decisions.filter(
      (decision) => !decision.execution.finalRenderAllowed,
    ).length,
  },
};
stable.digest = sha256Value(stable);
const report = {
  ...stable,
  generatedAt: new Date().toISOString(),
  provenance: {
    registryPath: registryFile,
    cuesPath: path.resolve(cuesFile),
  },
};
writeJsonAtomic(path.resolve(output), report);
console.log(JSON.stringify({
  status: "pass",
  output: path.resolve(output),
  digest: report.digest,
  decisions: report.decisions.length,
  escalationCount: report.quality.escalationCount,
}, null, 2));
