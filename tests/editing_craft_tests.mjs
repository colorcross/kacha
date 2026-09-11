#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildDirectorPlan, validateDirectorPlan } from "../scripts/kacha_intelligence.mjs";
import { loadEditingCraft } from "../scripts/editing_craft.mjs";
import { sha256Value } from "../scripts/kacha_utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-editing-craft-"));
const file = path.join(tmp, "cues.json");
const checked = [];
const cue = (id, start, end, signals = [], craft = {}) => ({ id, start, end, text: "真实任务与证据", signals, craft, confidence: 1 });
const plan = (cues, options = {}) => { fs.writeFileSync(file, JSON.stringify({ cues })); return buildDirectorPlan(file, options); };
const resign = (value) => { const copy = structuredClone(value); delete copy.digest; delete copy.generatedAt; value.digest = sha256Value(copy); return value; };
try {
  const catalog = loadEditingCraft();
  assert.equal(catalog.recipes.length, 4); assert.equal(catalog.techniques.length, 12);
  const result = spawnSync(process.execPath, [path.join(root, "scripts/kacha.mjs"), "templates", "recipes", "--recipe", "field-journal"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).recipes[0].id, "field-journal");
  checked.push("catalog-and-existing-template-bindings");

  let value = plan([cue("demo", 0, 10, ["screen_demo"])], { showId: "very-ai" });
  assert.equal(value.editingCraft.recipeId, "product-demo");
  assert.equal(value.editingCraft.selectionReason, "explicit_semantic_signals");
  assert.ok(value.editingCraft.issues.some((item) => item.reason === "missing_evidence"));
  assert.equal(value.beats[0].effectDecision, "deliberate_none");
  assert.equal(value.opening.count, 1);
  assert.deepEqual(validateDirectorPlan(value), []);
  for (const signal of ["fact", "data"]) {
    value = plan([cue("fact", 0, 5, [signal], { screenText: "当前结果", evidence: ["source_visible"] })]);
    assert.equal(value.beats[0].effectDecision, "deliberate_none");
    assert.equal(value.editingCraft.decisions[0].treatments[0].techniqueId, "proof-reveal");
  }
  checked.push("content-routing-and-unproven-demo-fallback");

  value = plan([cue("field", 0, 6, ["ambient_sound"], { evidence: ["usable_location_audio"] }), cue("talk", 6, 12)], { showId: "tool-share" });
  assert.equal(value.editingCraft.recipeId, "field-journal");
  assert.equal(value.editingCraft.decisions[0].audioIntent, "foreground_location_audio_no_bgm");
  assert.equal(value.beats[0].attentionClass, "quiet");
  assert.ok(value.attentionBudget.quietRatio >= .65);
  checked.push("natural-sound-protected-from-decoration");

  value = plan([cue("read", 0, 2, ["reading"], { screenText: "这是一段必须在画面稳定之后才能完整读清的关键文字", textReadyOffsetSeconds: 1, evidence: ["text_visible"] })]);
  assert.ok(value.editingCraft.issues.some((item) => item.reason === "insufficient_hold"));
  assert.equal(value.editingCraft.decisions[0].hold.extendAutomatically, false);
  assert.equal(value.beats[0].end, 2);
  assert.ok(value.quality.quietRatioPass);
  checked.push("reading-after-reveal-does-not-silently-retime");

  value = plan([cue("match", 0, 5, ["action_continuation"], { evidence: ["action_phase_match"] })]);
  const treatment = value.editingCraft.decisions[0].treatments.find((item) => item.techniqueId === "action-match");
  assert.deepEqual(treatment.missingEvidence, ["screen_direction_match"]);
  assert.equal(treatment.status, "needs_evidence");
  assert.equal(value.beats[0].effectDecision, "deliberate_none");
  checked.push("action-match-needs-direction-evidence");

  value = plan([cue("j", 0, 5, ["audio_lead"], { evidence: ["incoming_audio_handle", "no_lip_sync_conflict"] }), cue("l", 5, 10, ["audio_carry"])], { recipeId: "product-demo" });
  assert.equal(value.editingCraft.decisions[0].treatments[0].status, "candidate_requires_review");
  assert.equal(value.editingCraft.decisions[1].treatments[0].status, "needs_evidence");
  assert.equal(value.editingCraft.executionStatus, "not_compiled_to_timeline");
  checked.push("split-edit-handles-and-execution-boundary");

  value = plan([{ ...cue("bad", 0, 3, ["experiment", "logical_emphasis"]), confidence: .2 }], { showId: "book-talk" });
  assert.equal(value.editingCraft.recipeId, "reflective-talk");
  assert.equal(value.beats[0].attentionClass, "quiet");
  checked.push("low-confidence-cannot-drive-style-or-emphasis");

  for (const craft of [{ readingUnits: -1 }, { textReadyOffsetSeconds: "2" }, { evidence: "yes" }, { screenText: [] }]) {
    assert.throws(() => plan([cue("bad", 0, 4, ["reading"], craft)]));
  }
  assert.throws(() => plan([cue("one", 0, 4)], { recipeId: "unknown" }), /未知剪辑模板/);
  checked.push("malformed-input-and-unknown-recipe-rejected");

  value = plan([cue("one", 0, 8, ["reading"], { screenText: "短句", evidence: ["text_visible"] })]);
  const first = value.digest;
  assert.equal(buildDirectorPlan(file).digest, first);
  value.editingCraft.decisions[0].protectFromDecoration = false;
  assert.ok(validateDirectorPlan(resign(value)).some((message) => /确定性结果/.test(message)));
  value = buildDirectorPlan(file);
  value.editingCraft.registry.sha256 = "0".repeat(64);
  assert.ok(validateDirectorPlan(resign(value)).length);
  checked.push("deterministic-rebuild-rejects-redigested-tampering");

  value = plan(Array.from({ length: 20 }, (_, i) => cue(`dense-${i}`, i * .1, (i + 1) * .1, ["logical_emphasis"])), { recipeId: "reflective-talk" });
  assert.ok(value.attentionBudget.quietRatio >= .7);
  assert.deepEqual(validateDirectorPlan(value), []);
  value = plan([cue("tiny", 0, .0001, ["logical_emphasis"])], { recipeId: "reflective-talk" });
  assert.equal(value.attentionBudget.selectedHighImpactDecisions, 0);
  assert.equal(value.attentionBudget.quietRatio, 1);
  checked.push("short-dense-timeline-respects-duration-budget");
  console.log(JSON.stringify({ status: "pass", passed: checked.length, checks: checked }, null, 2));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
