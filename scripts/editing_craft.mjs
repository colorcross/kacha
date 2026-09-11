import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sha256File } from "./kacha_utils.mjs";

const registryFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../config/editing-craft.json");
const strings = (value) => Array.isArray(value)
  && value.every((item) => typeof item === "string" && item.trim())
  && new Set(value).size === value.length;
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const round = (value) => Number(value.toFixed(4));

export function loadEditingCraft() {
  const catalog = readJson(registryFile);
  if (catalog.schemaVersion !== "1.0" || !catalog.version
    || !Array.isArray(catalog.recipes) || !catalog.recipes.length
    || !Array.isArray(catalog.techniques) || !catalog.techniques.length) {
    throw new Error("剪辑手法目录格式无效");
  }
  for (const key of ["readingUnitsPerSecond", "readingLeadSeconds", "minimumReadingSeconds",
    "minimumReactionSeconds", "minimumNaturalSoundSeconds"]) {
    if (!finite(catalog.timing?.[key]) || catalog.timing[key] === 0) {
      throw new Error(`剪辑手法 timing.${key} 必须为有限正数`);
    }
  }
  for (const [key, arrays] of [["techniques", ["signals", "requiredEvidence", "templateIds", "review"]],
    ["recipes", ["signals", "shows", "sequence", "techniques", "avoid"]]]) {
    const ids = new Set();
    for (const entry of catalog[key]) {
      if (!/^[a-z][a-z0-9-]+$/.test(entry.id) || ids.has(entry.id) || !entry.label) {
        throw new Error(`剪辑手法 ${key} ID 缺失或重复`);
      }
      ids.add(entry.id);
      for (const field of arrays) {
        if (!strings(entry[field]) || !entry[field].length) throw new Error(`${entry.id}.${field} 无效`);
      }
      if (key === "recipes" && (!finite(entry.minimumQuietRatio) || entry.minimumQuietRatio > 1)) {
        throw new Error(`${entry.id}.minimumQuietRatio 无效`);
      }
      if (key === "techniques" && (!entry.picture || !entry.audio || !entry.fallback
        || typeof entry.protectFromDecoration !== "boolean")) throw new Error(`${entry.id} 手法合同不完整`);
    }
  }
  const techniques = new Set(catalog.techniques.map((item) => item.id));
  for (const recipe of catalog.recipes) {
    if (recipe.techniques.some((id) => !techniques.has(id))) throw new Error(`${recipe.id} 使用未知手法`);
  }
  return { ...catalog, registry: { path: registryFile, sha256: sha256File(registryFile) } };
}

export function selectEditingRecipe(catalog, cues, { recipeId = "auto", showId } = {}) {
  if (recipeId !== "auto") {
    const recipe = catalog.recipes.find((item) => item.id === recipeId);
    if (!recipe) throw new Error(`未知剪辑模板：${recipeId}`);
    return { recipe, reason: "explicit_selection" };
  }
  const eligible = cues.filter((cue) => cue.confidence >= 0.65 && !cue.signals.includes("low_confidence"));
  const ranked = catalog.recipes.map((recipe, index) => ({
    recipe, index,
    score: eligible.filter((cue) => recipe.signals.some((signal) => cue.signals.includes(signal))).length,
  })).sort((a, b) => b.score - a.score || Number(b.recipe.shows.includes(showId)) - Number(a.recipe.shows.includes(showId)) || a.index - b.index);
  if (ranked[0].score > 0) return { recipe: ranked[0].recipe, reason: "explicit_semantic_signals" };
  return {
    recipe: catalog.recipes.find((item) => item.shows.includes(showId))
      ?? catalog.recipes.find((item) => item.id === "reflective-talk"),
    reason: "show_default_pending_content_review",
  };
}

// This plans editorial decisions. It never asserts media perception, mutates a
// timeline, extends a cue, or pretends a planned split edit has been rendered.
export function buildEditingCraft(cues, options = {}) {
  const catalog = loadEditingCraft();
  const { recipe, reason } = selectEditingRecipe(catalog, cues, options);
  const issues = [];
  const decisions = cues.map((cue) => {
    const supplied = cue.source?.craft ?? {};
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error(`${cue.id}.craft 必须是对象`);
    const evidence = supplied.evidence ?? [];
    if (!strings(evidence)) throw new Error(`${cue.id}.craft.evidence 必须为不重复的字符串数组`);
    for (const key of ["readingUnits", "textReadyOffsetSeconds"]) {
      if (supplied[key] !== undefined && !finite(supplied[key])) throw new Error(`${cue.id}.craft.${key} 必须为非负有限数`);
    }
    if (supplied.screenText !== undefined && typeof supplied.screenText !== "string") throw new Error(`${cue.id}.craft.screenText 必须为字符串`);
    const allMatches = catalog.techniques.filter((item) => (recipe.techniques.includes(item.id) || item.protectFromDecoration)
      && item.signals.some((signal) => cue.signals.includes(signal)));
    // Quiet / readable windows take precedence over visual treatment candidates.
    const matches = [...allMatches].sort((a, b) => Number(b.protectFromDecoration) - Number(a.protectFromDecoration)).slice(0, 3);
    const lowConfidence = cue.confidence < 0.65 || cue.signals.includes("low_confidence");
    const treatments = matches.map((item) => {
      const missingEvidence = item.requiredEvidence.filter((key) => !evidence.includes(key));
      if (missingEvidence.length || lowConfidence) issues.push({
        beatId: cue.id, techniqueId: item.id, reason: lowConfidence ? "low_confidence" : "missing_evidence", missingEvidence,
      });
      return {
        techniqueId: item.id,
        status: missingEvidence.length || lowConfidence ? "needs_evidence" : "candidate_requires_review",
        matchedSignals: item.signals.filter((signal) => cue.signals.includes(signal)),
        missingEvidence, picture: item.picture, audio: item.audio,
        templateIds: item.templateIds, fallback: item.fallback, review: item.review,
      };
    });
    const reading = allMatches.some((item) => ["reading-hold", "proof-reveal", "demo-chain", "matched-comparison"].includes(item.id));
    const screenUnits = supplied.screenText ? [...supplied.screenText.replace(/\s/g, "")].length : 0;
    const units = Math.max(supplied.readingUnits ?? 0, screenUnits);
    const requiredSeconds = Math.max(
      reading ? Math.max(catalog.timing.minimumReadingSeconds, units / catalog.timing.readingUnitsPerSecond + catalog.timing.readingLeadSeconds) : 0,
      allMatches.some((item) => item.id === "reaction-hold") ? catalog.timing.minimumReactionSeconds : 0,
      allMatches.some((item) => item.id === "natural-sound") ? catalog.timing.minimumNaturalSoundSeconds : 0,
    );
    const availableSeconds = Math.max(0, cue.end - cue.start - (supplied.textReadyOffsetSeconds ?? 0));
    if ((supplied.textReadyOffsetSeconds ?? 0) > cue.end - cue.start || availableSeconds + 0.0001 < requiredSeconds) {
      issues.push({ beatId: cue.id, reason: "insufficient_hold", requiredSeconds: round(requiredSeconds), availableSeconds: round(availableSeconds) });
    }
    if (reading && !units) issues.push({ beatId: cue.id, reason: "reading_content_not_measured" });
    return {
      beatId: cue.id, sourceRange: { start: cue.start, end: cue.end },
      protectFromDecoration: lowConfidence || treatments.some((item) => item.status === "needs_evidence")
        || allMatches.some((item) => item.protectFromDecoration),
      hold: { minimumSeconds: round(requiredSeconds), availableSeconds: round(availableSeconds),
        basis: "config_starting_point_not_creator_measurement", extendAutomatically: false },
      audioIntent: allMatches.some((item) => item.id === "natural-sound") ? "foreground_location_audio_no_bgm"
        : reading ? "dialogue_first_reduce_music" : "preserve_sync_and_phrase",
      treatments,
      deferredTechniqueIds: allMatches.filter((item) => !matches.includes(item)).map((item) => item.id),
      effectFallback: "clean_live_action",
    };
  });
  return {
    version: catalog.version, registry: catalog.registry,
    requestedRecipe: options.recipeId ?? "auto", recipeId: recipe.id, selectionReason: reason,
    narrativeSequence: recipe.sequence, avoid: recipe.avoid,
    minimumQuietRatio: recipe.minimumQuietRatio,
    evidenceBasis: catalog.evidencePolicy,
    status: "requires_human_review", executionStatus: "not_compiled_to_timeline",
    decisions, issues,
  };
}
