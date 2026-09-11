#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildDirectorPlan, validateDirectorPlan, buildAssetGapPlan } from "../scripts/kacha_intelligence.mjs";
import { loadEditingCraft, validateEditingCraft } from "../scripts/editing_craft.mjs";
import { formatReviewProposal } from "../studio/review-format.js";
import { buildReviewBundle, loadReviewBundle } from "../scripts/kacha_review.mjs";
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
  for (const confidence of [null, "unknown", "0.9", -1, 1.1]) {
    assert.throws(() => plan([{ ...cue("bad", 0, 4), confidence }]), /confidence/);
  }
  for (const signals of [null, "reading", [null], [3], [""]]) {
    assert.throws(() => plan([{ ...cue("bad", 0, 4), signals }]), /signals/);
  }
  for (const craft of [null, { evidence: null }, { evidence: ["source_visble"] }]) {
    assert.throws(() => plan([cue("bad", 0, 4, [], craft)]), /craft/);
  }
  assert.throws(() => plan([null]), /必须是对象/);
  assert.equal(plan([{ ...cue(0, 0, 4), signals: [" reading ", "reading"] }]).beats[0].id, "0");
  checked.push("malformed-confidence-and-metadata-fail-closed");

  const longDemo = cue("demo", 0, 30, ["screen_demo"]);
  const field = cue("field", 30, 40, ["travel"]);
  const whole = plan([longDemo, field]);
  const fragmented = plan([longDemo, ...Array.from({ length: 10 }, (_, i) => cue(`field-${i}`, 30 + i, 31 + i, ["travel"]))]);
  assert.equal(whole.editingCraft.recipeId, "product-demo");
  assert.equal(fragmented.editingCraft.recipeId, whole.editingCraft.recipeId);
  checked.push("recipe-selection-invariant-to-cue-fragmentation");

  const sparse = plan([cue("a", 100, 101, ["logical_emphasis"]), cue("b", 200, 201, ["logical_emphasis"])], { recipeId: "reflective-talk" });
  const compact = plan([cue("a", 0, 1, ["logical_emphasis"]), cue("b", 1, 2, ["logical_emphasis"])], { recipeId: "reflective-talk" });
  assert.equal(sparse.attentionBudget.quietRatio, compact.attentionBudget.quietRatio);
  assert.equal(sparse.attentionBudget.selectedHighImpactDecisions, 0);
  assert.equal(sparse.attentionBudget.coveredSeconds, 2);
  assert.equal(sparse.attentionBudget.unannotatedSeconds, 199);
  value = plan(Array.from({ length: 20 }, (_, i) => cue(`micro-${i}`, i * .000055, (i + 1) * .000055, ["logical_emphasis"])));
  assert.ok(value.quality.quietRatioPass);
  assert.deepEqual(validateDirectorPlan(value), []);
  checked.push("unannotated-gaps-and-rounded-micro-cues-cannot-inflate-budget");

  for (const candidate of [cue("ambient", 0, 4, ["ambient_sound"]),
    { ...cue("ambient", 0, 4, ["ambient_sound"], { evidence: ["usable_location_audio"] }), confidence: .4 },
    cue("ambient", 0, .5, ["ambient_sound"], { evidence: ["usable_location_audio"] })]) {
    value = plan([candidate]);
    assert.equal(value.editingCraft.decisions[0].audioIntent, "preserve_sync_and_phrase");
  }
  value = plan([cue("many", 0, 10, ["evidence", "screen_demo", "comparison", "ambient_sound", "reading"], { screenText: "结果" })], { recipeId: "product-demo" });
  assert.ok(value.editingCraft.decisions[0].deferredTechniqueIds.includes("natural-sound"));
  assert.ok(value.editingCraft.issues.some((item) => item.techniqueId === "natural-sound" && item.reason === "missing_evidence"));
  assert.equal(value.editingCraft.decisions[0].treatments.length, 3);
  assert.equal(value.editingCraft.decisions[0].audioIntent, "preserve_sync_and_phrase");
  checked.push("all-matched-techniques-checked-and-unusable-audio-keeps-sync");

  value = plan([cue("hold", 0, 2, ["reading", "ambient_sound"], {
    screenText: "字", textReadyOffsetSeconds: .6, evidence: ["text_visible", "usable_location_audio"],
  })]);
  assert.ok(!value.editingCraft.issues.some((item) => item.reason === "insufficient_hold"));
  assert.equal(value.editingCraft.decisions[0].hold.windows.find((item) => item.kind === "natural_sound").availableSeconds, 2);
  value = plan([cue("stray", 0, 4, [], { textReadyOffsetSeconds: 3 })]);
  assert.ok(value.beats[0].humanReviewRequired);
  assert.ok(value.editingCraft.issues.some((item) => item.reason === "text_ready_offset_without_reading_signal"));
  checked.push("hold-clocks-independent-and-issue-only-beats-reviewed");

  const templateIds = catalog.techniques.flatMap((item) => item.templateIds);
  for (const mutate of [
    (item) => { item.version = 1; },
    (item) => { item.evidencePolicy = ""; },
    (item) => { item.techniques[0].picture = {}; },
    (item) => { item.techniques[0].templateIds = ["missing-template"]; },
    (item) => { item.recipes = item.recipes.filter((recipe) => recipe.id !== "reflective-talk"); },
  ]) {
    const broken = structuredClone(catalog); mutate(broken);
    assert.throws(() => validateEditingCraft(broken, templateIds));
  }
  assert.ok(!catalog.techniques.find((item) => item.id === "chapter-reset").templateIds.some((id) => id.startsWith("opening-")));
  checked.push("catalog-integrity-and-chapter-without-second-opening");

  value = plan([cue("read", 0, 8, ["reading"], { screenText: "结果", readingUnits: 3, evidence: ["text_visible"] })]);
  const directorFile = path.join(tmp, "director.json");
  const timelineFile = path.join(tmp, "timeline.json");
  fs.writeFileSync(directorFile, JSON.stringify(value));
  fs.writeFileSync(timelineFile, JSON.stringify({ schemaVersion: "1.0", projectId: value.project.id, visual: { overlays: [] } }));
  const built = buildReviewBundle(timelineFile, directorFile, { outputDirectory: path.join(tmp, "review-a") });
  const decisionA = loadReviewBundle(built.bundle.path).bundle.decisions[0];
  assert.equal(decisionA.preference, null);
  const display = formatReviewProposal(decisionA.proposed);
  assert.match(display, /阅读/);
  assert.match(display, /至少 1.2 秒/);
  assert.match(display, /不会自动执行/);
  assert.ok(!display.includes('"techniqueId":'));
  assert.ok(Array.isArray(decisionA.proposed.editingCraftIssues));
  const oldBeat = value.beats[0];
  value = plan([cue("read", 0, 8, ["reading"], { screenText: "结果", readingUnits: 20, evidence: ["text_visible"] })]);
  assert.deepEqual(value.beats[0], oldBeat);
  fs.writeFileSync(directorFile, JSON.stringify(value));
  const rebuilt = buildReviewBundle(timelineFile, directorFile, { outputDirectory: path.join(tmp, "review-b") });
  const decisionB = loadReviewBundle(rebuilt.bundle.path).bundle.decisions[0];
  assert.notEqual(decisionB.sourceDigest, decisionA.sourceDigest);
  assert.throws(() => loadReviewBundle(built.bundle.path), /变化/);
  checked.push("review-includes-craft-identity-and-does-not-learn-unexecuted-style");

  const executable = spawnSync(process.execPath, [path.join(root, "scripts/kacha.mjs"), "intelligence", "validate-plan", "--plan", directorFile, "--for-execution"], { encoding: "utf8", timeout: 30_000 });
  assert.notEqual(executable.status, 0);
  assert.match(executable.stderr, /尚未编译到 Timeline IR/);
  checked.push("planned-director-cannot-pass-as-execution-evidence");
  assert.match(formatReviewProposal({ editingCraftIssues: [{ reason: "insufficient_hold" }] }), /停留时间不足/);
  assert.equal(formatReviewProposal({ effectDecision: "deliberate_none" }), "保留原镜头，停止装饰性强调");
  assert.equal(formatReviewProposal({ kind: "<script>untrusted</script>" }), "<script>untrusted</script>");
  checked.push("review-proposals-present-readable-guidance-as-plain-text");
  for (const signal of ["evidence", "fact", "data", "test_result", "comparison", "external_evidence", "screen_demo", "operation", "workflow_demo"]) {
    value = plan([cue("opening-proof", 0, 8, [signal])]);
    assert.equal(value.beats[0].narrativeRole, "hook");
    assert.equal(value.beats[0].assetNeed.evidenceType, "factual", signal);
    fs.writeFileSync(directorFile, JSON.stringify(value));
    const gaps = buildAssetGapPlan(directorFile);
    assert.equal(gaps.gaps[0].resolution, "user_or_source_evidence_required");
    assert.equal(gaps.gaps[0].generationSpec, null);
    assert.equal(gaps.summary.productionReady, false);
  }
  checked.push("opening-evidence-and-demonstrations-require-real-source-media");

  const mediaCatalog = path.join(tmp, "catalog.json"), mediaIndex = path.join(tmp, "index.json"), asset = path.join(tmp, "proof.png");
  fs.writeFileSync(asset, "synthetic provenance fixture, not a decodable image");
  for (const provenance of [
    { kind: "local_generated", evidence: "fixture" },
    { kind: "merged_local_sources", evidence: "fixture", sources: [{ kind: "owned_local", evidence: "fixture" }, { kind: "local_generated", generator: "fixture" }] },
    { kind: "project_evidence", evidence: "fixture" },
  ]) {
    fs.writeFileSync(mediaCatalog, JSON.stringify({ entries: [{ path: asset, kind: "image", description: value.beats[0].text, license: "owned", provenance }] }));
    const indexed = spawnSync(process.execPath, [path.join(root, "scripts/kacha.mjs"), "media", "index", "--root", tmp,
      "--catalog", mediaCatalog, "--no-scan", "--output", mediaIndex], { encoding: "utf8", timeout: 30_000 });
    assert.equal(indexed.status, 0, indexed.stderr);
    assert.equal(buildAssetGapPlan(directorFile, mediaIndex).summary.productionReady, provenance.kind === "project_evidence");
  }
  checked.push("declared-generated-or-mixed-provenance-cannot-fill-factual-gaps");
  console.log(JSON.stringify({ status: "pass", passed: checked.length, checks: checked }, null, 2));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
