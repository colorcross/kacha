#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireFileLock,
  fileIdentity,
  mediaSummary,
  readJson,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { validateDirectorPlan } from "./kacha_intelligence.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const configFile = path.join(skillRoot, "config", "intelligence-v6.json");

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function ensureFile(file, label) {
  const resolved = path.resolve(file ?? "");
  if (!file || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label}不存在：${resolved}`);
  }
  return resolved;
}

function stableDigest(value) {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  delete copy.updatedAt;
  delete copy.digest;
  return sha256Value(copy);
}

function safeId(value, prefix = "decision") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || `${prefix}-${sha256Value(value).slice(0, 10)}`;
}

function write(value, output = null) {
  if (output) writeJsonAtomic(path.resolve(output), value);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function existingPreview(previewRoot, names) {
  if (!previewRoot) return null;
  for (const name of names) {
    const file = path.join(previewRoot, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return fileIdentity(file);
  }
  return null;
}

function preferenceMetadata(category, value) {
  const keys = {
    opening: "opening.strategy",
    effect: "effects.recipe",
    overlay: "visual.overlayDensity",
    camera: "visual.cameraMotion",
    evidence: "visual.evidenceStrategy",
    sound: "audio.semanticSfx",
  };
  return { key: keys[category] ?? `review.${category}`, value };
}

export function buildReviewBundle(timelineFile, directorFile, options = {}) {
  const timelinePath = ensureFile(timelineFile, "Timeline IR");
  const directorPath = ensureFile(directorFile, "全片导演计划");
  const timeline = readJson(timelinePath);
  const director = readJson(directorPath);
  const directorErrors = validateDirectorPlan(director);
  if (directorErrors.length > 0) throw new Error(directorErrors.join("\n"));
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(path.dirname(timelinePath), ".kacha", "review"));
  if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length > 0 && !options.overwrite) {
    throw new Error(`审片目录已存在且非空：${outputDirectory}`);
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  const previewRoot = options.previewDirectory ? path.resolve(options.previewDirectory) : null;
  const decisions = [];
  for (const beat of director.beats.filter((item) => (
    item.attentionClass === "high_impact" || item.humanReviewRequired
  ))) {
    const category = beat.narrativeRole === "evidence"
      ? "evidence"
      : beat.narrativeRole === "hook"
        ? "opening"
        : "effect";
    const id = safeId(`beat-${beat.id}`);
    decisions.push({
      id,
      objectRef: `@range:${safeId(beat.id, "beat")}`,
      category,
      title: `${beat.narrativeRole} · ${beat.text || beat.id}`,
      range: { start: beat.start, end: beat.end },
      rationale: beat.effectReason,
      confidence: beat.confidence,
      proposed: {
        intent: beat.visualIntent,
        mechanism: beat.styleMechanism,
        effectDecision: beat.effectDecision,
      },
      fallback: beat.simplerAlternative,
      sourceDigest: sha256Value(beat),
      preview: {
        before: existingPreview(previewRoot, [`${beat.id}-before.mp4`, `${id}-before.mp4`]),
        after: existingPreview(previewRoot, [`${beat.id}-after.mp4`, `${id}-after.mp4`, `${beat.id}.mp4`]),
        normalSpeedRequired: true,
      },
      preference: preferenceMetadata(category, beat.styleMechanism),
      requiresHuman: true,
    });
  }
  for (const [index, overlay] of (timeline.visual?.overlays ?? []).entries()) {
    const id = safeId(`overlay-${overlay.id ?? index + 1}`);
    if (decisions.some((decision) => decision.id === id)) continue;
    decisions.push({
      id,
      objectRef: `@overlay:${safeId(overlay.id ?? `overlay-${index + 1}`, "overlay")}`,
      category: "overlay",
      title: overlay.title ?? overlay.text ?? overlay.id ?? `画面叠加 ${index + 1}`,
      range: { start: Number(overlay.start), end: Number(overlay.end) },
      rationale: overlay.reason ?? overlay.trigger ?? "时间线中的高影响画面叠加",
      confidence: Number(overlay.confidence ?? 1),
      proposed: {
        kind: overlay.kind ?? "image",
        effectType: overlay.effectType ?? null,
        geometry: {
          x: overlay.x,
          y: overlay.y,
          width: overlay.width,
          height: overlay.height,
        },
      },
      fallback: overlay.simplerAlternative ?? "remove_overlay_and_hold_live_action",
      sourceDigest: sha256Value(overlay),
      preview: {
        before: existingPreview(previewRoot, [`${overlay.id}-before.mp4`, `${id}-before.mp4`]),
        after: existingPreview(previewRoot, [`${overlay.id}-after.mp4`, `${id}-after.mp4`, `${overlay.id}.mp4`]),
        normalSpeedRequired: true,
      },
      preference: preferenceMetadata("overlay", overlay.effectType ?? overlay.kind ?? "overlay"),
      requiresHuman: true,
    });
  }
  const bundle = {
    schemaVersion: "1.0",
    kind: "kacha_semantic_review_bundle",
    generatedAt: new Date().toISOString(),
    project: {
      id: timeline.projectId ?? director.project.id,
      showId: director.project.showId,
      styleId: director.project.styleId,
      platform: options.platform ?? "general",
    },
    timeline: fileIdentity(timelinePath),
    directorPlan: fileIdentity(directorPath),
    candidateVideo: timeline.output?.path
      ? (() => {
          const candidate = path.resolve(path.dirname(timelinePath), timeline.output.path);
          return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
            ? fileIdentity(candidate)
            : { path: candidate, missing: true };
        })()
      : null,
    decisions,
    summary: {
      total: decisions.length,
      withNormalSpeedPreview: decisions.filter(hasValidNormalSpeedPreview).length,
      requiresHuman: decisions.filter((item) => item.requiresHuman).length,
    },
    boundaries: {
      notAReleaseApproval: true,
      acceptDoesNotPublish: true,
      adjustOrRejectRequiresResolutionEvidence: true,
    },
  };
  bundle.digest = stableDigest(bundle);
  const bundleFile = path.join(outputDirectory, "review-bundle.json");
  const sessionFile = path.join(outputDirectory, "review-session.json");
  writeJsonAtomic(bundleFile, bundle);
  const session = {
    schemaVersion: "1.0",
    kind: "kacha_semantic_review_session",
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bundle: fileIdentity(bundleFile),
    bundleDigest: bundle.digest,
    reviewer: options.reviewer ?? null,
    decisions: [],
    summary: {
      total: decisions.length,
      decided: 0,
      accepted: 0,
      adjusted: 0,
      rejected: 0,
      unresolvedChanges: 0,
      missingNormalSpeedPreviews: decisions.filter((item) => (
        item.preview?.normalSpeedRequired === true && !hasValidNormalSpeedPreview(item)
      )).length,
      readyForCandidate: false,
    },
  };
  session.digest = stableDigest(session);
  writeJsonAtomic(sessionFile, session);
  return {
    schemaVersion: "1.0",
    status: "pass",
    bundle: fileIdentity(bundleFile),
    session: fileIdentity(sessionFile),
    reviewUrl: `/review?bundle=${encodeURIComponent(bundleFile)}`,
    summary: bundle.summary,
  };
}

export function loadReviewBundle(bundleFile) {
  const file = ensureFile(bundleFile, "审片包");
  if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error("审片包超过 8 MB");
  const bundle = readJson(file);
  const bundleErrors = reviewBundleErrors(bundle);
  if (bundleErrors.length > 0) throw new Error(bundleErrors.join("\n"));
  const sessionFile = path.join(path.dirname(file), "review-session.json");
  const session = fs.existsSync(sessionFile) ? readJson(sessionFile) : null;
  if (session) {
    const errors = reviewSessionErrors(session, bundle, file);
    if (errors.length > 0) throw new Error(errors.join("\n"));
  }
  return { file, bundle, sessionFile, session };
}

function currentIdentityMatches(identity) {
  try {
    const file = ensureFile(identity?.path, "证据文件");
    return Boolean(identity?.sha256) && fileIdentity(file).sha256 === identity.sha256;
  } catch {
    return false;
  }
}

function normalSpeedPreviewError(identity, decision) {
  if (!currentIdentityMatches(identity)) return "文件不存在或 SHA-256 已变化";
  try {
    const summary = mediaSummary(identity.path);
    if (!summary.video || !(summary.duration > 0) || !(summary.averageFps > 0)) {
      return "不是可解码的动态视频";
    }
    if (!summary.audio || !(summary.audioDuration > 0)) return "缺少可试听音轨";
    const decisionSeconds = Number(decision.range?.end) - Number(decision.range?.start);
    const minimumSeconds = Math.min(1, Math.max(0.1, decisionSeconds));
    if (summary.duration + 0.05 < minimumSeconds) {
      return `动态预览短于最小代表时长 ${minimumSeconds.toFixed(2)} 秒`;
    }
    return null;
  } catch (error) {
    return `媒体探测失败：${error.message}`;
  }
}

function hasValidNormalSpeedPreview(decision) {
  return !normalSpeedPreviewError(decision.preview?.after, decision);
}

function reviewDecisionContract(decision) {
  return {
    id: decision.id,
    objectRef: decision.objectRef,
    category: decision.category,
    title: decision.title,
    range: decision.range,
    rationale: decision.rationale,
    confidence: decision.confidence,
    proposed: decision.proposed,
    fallback: decision.fallback,
    sourceDigest: decision.sourceDigest,
    preference: decision.preference,
    requiresHuman: decision.requiresHuman,
    normalSpeedRequired: decision.preview?.normalSpeedRequired,
  };
}

function reviewBundleErrors(bundle) {
  const errors = [];
  if (
    bundle.schemaVersion !== "1.0"
    || bundle.kind !== "kacha_semantic_review_bundle"
    || bundle.digest !== stableDigest(bundle)
  ) errors.push("审片包 schema 或 digest 无效");
  if (!currentIdentityMatches(bundle.timeline)) errors.push("审片包绑定的 Timeline IR 内容已变化");
  if (!currentIdentityMatches(bundle.directorPlan)) {
    errors.push("审片包绑定的 director plan 内容已变化");
  } else {
    errors.push(...validateDirectorPlan(readJson(bundle.directorPlan.path)));
  }
  if (
    bundle.candidateVideo
    && bundle.candidateVideo.missing !== true
    && !currentIdentityMatches(bundle.candidateVideo)
  ) errors.push("审片包绑定的候选视频内容已变化");
  const decisions = Array.isArray(bundle.decisions) ? bundle.decisions : [];
  if (!Array.isArray(bundle.decisions) || decisions.length === 0) {
    errors.push("审片包 decisions 不能为空");
    return errors;
  }
  const ids = new Set();
  for (const [index, decision] of decisions.entries()) {
    if (!decision.id || ids.has(decision.id)) errors.push(`decisions[${index}].id 缺失或重复`);
    ids.add(decision.id);
    if (!(Number(decision.range?.start) >= 0 && Number(decision.range?.end) > Number(decision.range?.start))) {
      errors.push(`decisions[${index}].range 无效`);
    }
    if (decision.preview?.normalSpeedRequired !== true) {
      errors.push(`decisions[${index}] 不得取消正常速度动态预览`);
    }
    for (const variant of ["before", "after"]) {
      if (decision.preview?.[variant] && !currentIdentityMatches(decision.preview[variant])) {
        errors.push(`decisions[${index}].preview.${variant} 内容已变化或不存在`);
      }
    }
    if (decision.preview?.after) {
      const previewError = normalSpeedPreviewError(decision.preview.after, decision);
      if (previewError) errors.push(`decisions[${index}].preview.after 不是有效的正常速度带声音预览：${previewError}`);
    }
  }
  if (currentIdentityMatches(bundle.timeline) && currentIdentityMatches(bundle.directorPlan)) {
    const timeline = readJson(bundle.timeline.path);
    const director = readJson(bundle.directorPlan.path);
    const expected = new Map();
    for (const beat of director.beats.filter((item) => (
      item.attentionClass === "high_impact" || item.humanReviewRequired
    ))) {
      const category = beat.narrativeRole === "evidence"
        ? "evidence"
        : beat.narrativeRole === "hook"
          ? "opening"
          : "effect";
      const id = safeId(`beat-${beat.id}`);
      expected.set(id, reviewDecisionContract({
        id,
        objectRef: `@range:${safeId(beat.id, "beat")}`,
        category,
        title: `${beat.narrativeRole} · ${beat.text || beat.id}`,
        range: { start: beat.start, end: beat.end },
        rationale: beat.effectReason,
        confidence: beat.confidence,
        proposed: {
          intent: beat.visualIntent,
          mechanism: beat.styleMechanism,
          effectDecision: beat.effectDecision,
        },
        fallback: beat.simplerAlternative,
        sourceDigest: sha256Value(beat),
        preference: preferenceMetadata(category, beat.styleMechanism),
        requiresHuman: true,
        preview: { normalSpeedRequired: true },
      }));
    }
    for (const [index, overlay] of (timeline.visual?.overlays ?? []).entries()) {
      const id = safeId(`overlay-${overlay.id ?? index + 1}`);
      expected.set(id, reviewDecisionContract({
        id,
        objectRef: `@overlay:${safeId(overlay.id ?? `overlay-${index + 1}`, "overlay")}`,
        category: "overlay",
        title: overlay.title ?? overlay.text ?? overlay.id ?? `画面叠加 ${index + 1}`,
        range: { start: Number(overlay.start), end: Number(overlay.end) },
        rationale: overlay.reason ?? overlay.trigger ?? "时间线中的高影响画面叠加",
        confidence: Number(overlay.confidence ?? 1),
        proposed: {
          kind: overlay.kind ?? "image",
          effectType: overlay.effectType ?? null,
          geometry: {
            x: overlay.x,
            y: overlay.y,
            width: overlay.width,
            height: overlay.height,
          },
        },
        fallback: overlay.simplerAlternative ?? "remove_overlay_and_hold_live_action",
        sourceDigest: sha256Value(overlay),
        preference: preferenceMetadata("overlay", overlay.effectType ?? overlay.kind ?? "overlay"),
        requiresHuman: true,
        preview: { normalSpeedRequired: true },
      }));
    }
    if (expected.size !== decisions.length) {
      errors.push("审片包未完整覆盖当前 director 高影响语义拍与 Timeline overlays");
    }
    for (const decision of decisions) {
      if (
        !expected.has(decision.id)
        || sha256Value(expected.get(decision.id)) !== sha256Value(reviewDecisionContract(decision))
      ) {
        errors.push(`审片决策 ${decision.id} 不属于当前 director/Timeline，或显示合同已失效`);
      }
    }
  }
  const expectedSummary = {
    total: decisions.length,
    withNormalSpeedPreview: decisions.filter(hasValidNormalSpeedPreview).length,
    requiresHuman: decisions.filter((item) => item.requiresHuman).length,
  };
  if (JSON.stringify(expectedSummary) !== JSON.stringify(bundle.summary)) {
    errors.push("审片包 summary 与真实决策及预览证据不一致");
  }
  return errors;
}

function reviewSessionErrors(session, bundle, bundleFile) {
  const errors = reviewBundleErrors(bundle);
  if (
    session.schemaVersion !== "1.0"
    || session.kind !== "kacha_semantic_review_session"
    || session.digest !== stableDigest(session)
  ) errors.push("审片 session schema 或 digest 无效");
  if (session.bundleDigest !== bundle.digest) errors.push("session 与 bundle digest 不一致");
  const currentBundle = fileIdentity(bundleFile);
  if (
    path.resolve(session.bundle?.path ?? "") !== currentBundle.path
    || session.bundle?.sha256 !== currentBundle.sha256
  ) errors.push("session 绑定的审片包内容身份已变化");
  const config = readJson(configFile).review;
  const bundleDecisions = new Map(bundle.decisions.map((item) => [item.id, item]));
  const seen = new Set();
  const records = Array.isArray(session.decisions) ? session.decisions : [];
  if (!Array.isArray(session.decisions)) errors.push("session.decisions 必须是数组");
  for (const [index, record] of records.entries()) {
    const label = `session.decisions[${index}]`;
    if (!record.decisionId || seen.has(record.decisionId)) {
      errors.push(`${label}.decisionId 缺失或重复`);
      continue;
    }
    seen.add(record.decisionId);
    const decision = bundleDecisions.get(record.decisionId);
    if (!decision) {
      errors.push(`${label} 不属于当前审片包`);
      continue;
    }
    if (record.sourceDigest !== decision.sourceDigest) errors.push(`${label}.sourceDigest 已失效`);
    if (!config.outcomes.includes(record.outcome)) errors.push(`${label}.outcome 无效`);
    if (!record.reviewedAt || !Number.isFinite(Date.parse(record.reviewedAt))) {
      errors.push(`${label}.reviewedAt 无效`);
    }
    if (["adjust", "reject"].includes(record.outcome) && !String(record.note ?? "").trim()) {
      errors.push(`${label} 调整或拒绝缺少具体原因`);
    }
    if (record.resolutionEvidence && !currentIdentityMatches(record.resolutionEvidence)) {
      errors.push(`${label}.resolutionEvidence 内容已变化或不存在`);
    }
  }
  if (Array.isArray(session.decisions)) {
    const summary = summarizeSession(session, bundle);
    if (JSON.stringify(summary) !== JSON.stringify(session.summary)) {
      errors.push("session.summary 与真实决策记录不一致");
    }
  }
  return errors;
}

function summarizeSession(session, bundle) {
  const records = Array.isArray(session.decisions) ? session.decisions : [];
  const outcomes = new Map(records.map((decision) => [decision.decisionId, decision]));
  const values = [...outcomes.values()];
  const unresolved = values.filter((decision) => (
    ["adjust", "reject"].includes(decision.outcome)
      && !currentIdentityMatches(decision.resolutionEvidence)
  ));
  const missingNormalSpeedPreviews = bundle.decisions.filter((decision) => (
    decision.preview?.normalSpeedRequired === true
      && !hasValidNormalSpeedPreview(decision)
  ));
  return {
    total: bundle.decisions.length,
    decided: values.length,
    accepted: values.filter((decision) => decision.outcome === "accept").length,
    adjusted: values.filter((decision) => decision.outcome === "adjust").length,
    rejected: values.filter((decision) => decision.outcome === "reject").length,
    unresolvedChanges: unresolved.length,
    missingNormalSpeedPreviews: missingNormalSpeedPreviews.length,
    readyForCandidate: values.length === bundle.decisions.length
      && unresolved.length === 0
      && missingNormalSpeedPreviews.length === 0,
  };
}

export function recordReviewDecision(bundleFile, input) {
  const { bundle, sessionFile } = loadReviewBundle(bundleFile);
  const config = readJson(configFile).review;
  const decision = bundle.decisions.find((item) => item.id === input.decisionId);
  if (!decision) throw new Error(`审片决策不存在：${input.decisionId}`);
  if (!config.outcomes.includes(input.outcome)) throw new Error(`审片结果无效：${input.outcome}`);
  if (["adjust", "reject"].includes(input.outcome) && !String(input.note ?? "").trim()) {
    throw new Error("调整或拒绝必须填写具体原因");
  }
  let resolutionEvidence = null;
  if (input.resolutionEvidence) {
    resolutionEvidence = fileIdentity(ensureFile(input.resolutionEvidence, "调整解决证据"));
  }
  const release = acquireFileLock(`${sessionFile}.lock`, { purpose: "review-decision" });
  try {
    const session = readJson(sessionFile);
    const sessionErrors = reviewSessionErrors(session, bundle, path.resolve(bundleFile));
    if (sessionErrors.length > 0) throw new Error(sessionErrors.join("\n"));
    const record = {
      decisionId: decision.id,
      sourceDigest: decision.sourceDigest,
      outcome: input.outcome,
      adjustedValue: input.adjustedValue ?? null,
      note: String(input.note ?? "").trim() || null,
      resolutionEvidence,
      reviewedAt: new Date().toISOString(),
      reviewer: input.reviewer ?? session.reviewer ?? "local-reviewer",
    };
    const index = session.decisions.findIndex((item) => item.decisionId === decision.id);
    if (index >= 0) session.decisions[index] = record;
    else session.decisions.push(record);
    session.updatedAt = new Date().toISOString();
    session.summary = summarizeSession(session, bundle);
    session.digest = stableDigest(session);
    writeJsonAtomic(sessionFile, session);
    return { session: fileIdentity(sessionFile), decision: record, summary: session.summary };
  } finally {
    release();
  }
}

export function validateReviewSession(sessionFile, { requireCandidateReady = false } = {}) {
  const file = ensureFile(sessionFile, "审片 session");
  const session = readJson(file);
  const errors = [];
  let bundle = null;
  try {
    const bundleFile = ensureFile(session.bundle?.path, "审片包");
    bundle = readJson(bundleFile);
    const bundleErrors = reviewBundleErrors(bundle);
    if (bundleErrors.length > 0) throw new Error(bundleErrors.join("\n"));
    errors.push(...reviewSessionErrors(session, bundle, bundleFile));
  } catch (error) {
    errors.push(error.message);
  }
  if (bundle) {
    const summary = summarizeSession(session, bundle);
    if (requireCandidateReady && !summary.readyForCandidate) {
      errors.push("审片尚未覆盖全部高影响决策、缺少正常速度动态预览，或调整/拒绝缺少解决证据");
    }
  }
  return { file, session, bundle, errors };
}

function derivePreferenceCandidate(sessionFile) {
  const validation = validateReviewSession(sessionFile);
  if (validation.errors.length > 0) throw new Error(validation.errors.join("\n"));
  const file = validation.file;
  const session = validation.session;
  const bundle = validation.bundle;
  const minimum = readJson(configFile).review.minimumPreferenceEvidence;
  const evidence = [];
  for (const record of session.decisions) {
    const decision = bundle.decisions.find((item) => item.id === record.decisionId);
    if (!decision?.preference) continue;
    const proposedValue = record.outcome === "adjust"
      ? record.adjustedValue
      : record.outcome === "reject"
        ? `avoid:${decision.preference.value}`
        : decision.preference.value;
    if (proposedValue === null || proposedValue === undefined || proposedValue === "") continue;
    evidence.push({
      key: decision.preference.key,
      value: proposedValue,
      outcome: record.outcome,
      decisionId: record.decisionId,
      sourceDigest: record.sourceDigest,
    });
  }
  const groups = new Map();
  for (const item of evidence) {
    const key = `${item.key}\u0000${JSON.stringify(item.value)}`;
    const group = groups.get(key) ?? { key: item.key, value: item.value, evidence: [] };
    group.evidence.push(item);
    groups.set(key, group);
  }
  const qualifiedByKey = new Map();
  for (const group of [...groups.values()].filter((item) => item.evidence.length >= minimum)) {
    const list = qualifiedByKey.get(group.key) ?? [];
    list.push(group);
    qualifiedByKey.set(group.key, list);
  }
  const selectedGroups = [];
  for (const list of qualifiedByKey.values()) {
    list.sort((left, right) => (
      right.evidence.length - left.evidence.length
      || JSON.stringify(left.value).localeCompare(JSON.stringify(right.value))
    ));
    if (list.length > 1 && list[0].evidence.length === list[1].evidence.length) continue;
    selectedGroups.push(list[0]);
  }
  const rules = selectedGroups.map((group) => ({
    key: group.key,
    value: group.value,
    evidenceCount: group.evidence.length,
    decisionIds: group.evidence.map((item) => item.decisionId).sort(),
    confidence: Math.min(1, Number((0.55 + group.evidence.length * 0.1).toFixed(2))),
  })).sort((left, right) => left.key.localeCompare(right.key));
  const candidate = {
    schemaVersion: "1.0",
    kind: "kacha_preference_candidate",
    generatedAt: new Date().toISOString(),
    sourceSession: fileIdentity(file),
    scope: bundle.project,
    rules,
    rejectedSignals: evidence.length - rules.reduce((total, rule) => total + rule.evidenceCount, 0),
    activation: {
      automatic: false,
      requiresExplicitConfirmation: true,
      storesFreeformNotes: false,
    },
  };
  candidate.digest = stableDigest(candidate);
  return candidate;
}

export function buildPreferenceCandidate(sessionFile, outputFile) {
  const file = ensureFile(sessionFile, "审片 session");
  const candidate = derivePreferenceCandidate(file);
  const output = path.resolve(outputFile ?? path.join(path.dirname(file), "preference-candidate.json"));
  writeJsonAtomic(output, candidate);
  return { candidate: fileIdentity(output), rules: candidate.rules.length, activationRequired: true };
}

function defaultPreferenceProfile() {
  const root = process.env.KACHA_CONFIG_HOME
    ? path.resolve(process.env.KACHA_CONFIG_HOME)
    : path.join(os.homedir(), ".config", "kacha");
  return path.join(root, "preferences-v6.json");
}

function validatePreferenceProfile(profile, label = "偏好 profile") {
  if (
    profile?.schemaVersion !== "1.0"
    || profile?.kind !== "kacha_preference_profile"
    || !Number.isInteger(Number(profile.versionNumber))
    || Number(profile.versionNumber) < 1
    || profile.digest !== stableDigest(profile)
  ) throw new Error(`${label} schema 或 digest 无效`);
  if (!Array.isArray(profile.rules)) throw new Error(`${label}.rules 必须是数组`);
  const seen = new Set();
  for (const [index, rule] of profile.rules.entries()) {
    const scope = rule.scope ?? profile.scope;
    if (!rule.key || !scope) throw new Error(`${label}.rules[${index}] 缺少 key 或 scope`);
    const key = `${sha256Value(scope)}\u0000${rule.key}`;
    if (seen.has(key)) throw new Error(`${label}.rules 存在同 scope 的重复 key`);
    seen.add(key);
  }
}

function storeHistoryVersion(history, profile) {
  fs.mkdirSync(history, { recursive: true });
  const historyFile = path.join(history, `v${profile.versionNumber}.json`);
  if (fs.existsSync(historyFile)) {
    const existing = readJson(historyFile);
    if (existing.digest !== profile.digest) {
      throw new Error(`偏好历史版本冲突：${historyFile}`);
    }
    return;
  }
  writeJsonAtomic(historyFile, profile);
}

export function activatePreferenceCandidate(candidateFile, profileFile = null, confirmed = false) {
  if (!confirmed) throw new Error("长期偏好激活需要显式 --confirm");
  const candidatePath = ensureFile(candidateFile, "偏好候选");
  const candidate = readJson(candidatePath);
  if (
    candidate.schemaVersion !== "1.0"
    || candidate.kind !== "kacha_preference_candidate"
    || !Array.isArray(candidate.rules)
    || candidate.digest !== stableDigest(candidate)
  ) {
    throw new Error("偏好候选 schema 或 digest 无效");
  }
  if (candidate.rules.length === 0) throw new Error("偏好候选没有达到证据阈值的规则");
  const sourceSession = ensureFile(candidate.sourceSession?.path, "偏好候选来源 session");
  if (fileIdentity(sourceSession).sha256 !== candidate.sourceSession.sha256) {
    throw new Error("偏好候选来源 session 内容已变化");
  }
  const sourceValidation = validateReviewSession(sourceSession);
  if (sourceValidation.errors.length > 0) throw new Error(sourceValidation.errors.join("\n"));
  const expectedCandidate = derivePreferenceCandidate(sourceSession);
  if (candidate.digest !== expectedCandidate.digest) {
    throw new Error("偏好候选与当前审片证据的确定性学习结果不一致");
  }
  const profilePath = path.resolve(profileFile ?? defaultPreferenceProfile());
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  let previous = null;
  if (fs.existsSync(profilePath)) {
    previous = readJson(profilePath);
    validatePreferenceProfile(previous, "现有偏好 profile");
  }
  const versionNumber = Number(previous?.versionNumber ?? 0) + 1;
  if (previous) {
    const history = `${profilePath}.history`;
    storeHistoryVersion(history, previous);
  }
  const merged = new Map();
  for (const rule of previous?.rules ?? []) {
    const scopedRule = { ...rule, scope: rule.scope ?? previous.scope };
    merged.set(`${sha256Value(scopedRule.scope)}\u0000${scopedRule.key}`, scopedRule);
  }
  for (const rule of candidate.rules) {
    const scopedRule = { ...rule, scope: candidate.scope };
    merged.set(`${sha256Value(scopedRule.scope)}\u0000${scopedRule.key}`, scopedRule);
  }
  const rules = [...merged.values()].sort((left, right) => (
    sha256Value(left.scope).localeCompare(sha256Value(right.scope))
    || left.key.localeCompare(right.key)
  ));
  const scopes = [...new Map(rules.map((rule) => [sha256Value(rule.scope), rule.scope])).values()];
  const profile = {
    schemaVersion: "1.0",
    kind: "kacha_preference_profile",
    versionNumber,
    activatedAt: new Date().toISOString(),
    previousDigest: previous?.digest ?? null,
    sourceCandidate: fileIdentity(candidatePath),
    scope: candidate.scope,
    scopes,
    rules,
    rollback: { historyDirectory: `${profilePath}.history` },
  };
  profile.digest = stableDigest(profile);
  writeJsonAtomic(profilePath, profile);
  return { profile: fileIdentity(profilePath), versionNumber, rules: profile.rules.length };
}

export function rollbackPreferenceProfile(profileFile, versionNumber, confirmed = false) {
  if (!confirmed) throw new Error("偏好回滚需要显式 --confirm");
  const profilePath = ensureFile(profileFile ?? defaultPreferenceProfile(), "偏好 profile");
  const historyFile = ensureFile(
    path.join(`${profilePath}.history`, `v${Number(versionNumber)}.json`),
    "历史偏好版本",
  );
  const current = readJson(profilePath);
  const target = readJson(historyFile);
  validatePreferenceProfile(current, "当前偏好 profile");
  validatePreferenceProfile(target, "历史偏好 profile");
  if (Number(target.versionNumber) !== Number(versionNumber)) {
    throw new Error("历史偏好版本号与文件名不一致");
  }
  const history = `${profilePath}.history`;
  storeHistoryVersion(history, current);
  const restored = {
    ...target,
    versionNumber: Number(current.versionNumber) + 1,
    activatedAt: new Date().toISOString(),
    previousDigest: current.digest,
    rollback: {
      historyDirectory: history,
      restoredFromVersion: target.versionNumber,
      rollbackFromVersion: current.versionNumber,
    },
  };
  restored.digest = stableDigest(restored);
  writeJsonAtomic(profilePath, restored);
  return {
    profile: fileIdentity(profilePath),
    versionNumber: restored.versionNumber,
    restoredFromVersion: target.versionNumber,
  };
}

export function resolveReviewMedia(bundleFile, decisionId, variant = "after") {
  const { bundle } = loadReviewBundle(bundleFile);
  const decision = bundle.decisions.find((item) => item.id === decisionId);
  if (!decision) throw new Error(`审片决策不存在：${decisionId}`);
  const identity = decision.preview?.[variant];
  if (!identity?.path) throw new Error(`该决策没有 ${variant} 预览`);
  const file = ensureFile(identity.path, "审片预览");
  if (fileIdentity(file).sha256 !== identity.sha256) throw new Error("审片预览内容已变化");
  return file;
}

export function runReviewCli(args = process.argv.slice(2)) {
  const action = args[0];
  if (action === "build") {
    write(buildReviewBundle(option(args, "--timeline"), option(args, "--director"), {
      outputDirectory: option(args, "--output-dir"),
      previewDirectory: option(args, "--preview-dir"),
      platform: option(args, "--platform", "general"),
      reviewer: option(args, "--reviewer"),
      overwrite: args.includes("--overwrite"),
    }));
    return;
  }
  if (action === "show") {
    const loaded = loadReviewBundle(option(args, "--bundle"));
    write({ bundle: loaded.bundle, session: loaded.session });
    return;
  }
  if (action === "validate") {
    const result = validateReviewSession(option(args, "--session"), {
      requireCandidateReady: args.includes("--for-candidate"),
    });
    if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
    write({ schemaVersion: "1.0", status: "pass", session: fileIdentity(result.file), summary: result.session.summary });
    return;
  }
  if (action === "record") {
    write(recordReviewDecision(option(args, "--bundle"), {
      decisionId: option(args, "--decision"),
      outcome: option(args, "--outcome"),
      adjustedValue: option(args, "--adjusted-value"),
      note: option(args, "--note"),
      resolutionEvidence: option(args, "--resolution-evidence"),
      reviewer: option(args, "--reviewer"),
    }));
    return;
  }
  if (action === "learn") {
    write(buildPreferenceCandidate(option(args, "--session"), option(args, "--output")));
    return;
  }
  if (action === "activate") {
    write(activatePreferenceCandidate(
      option(args, "--candidate"),
      option(args, "--profile"),
      args.includes("--confirm"),
    ));
    return;
  }
  if (action === "rollback") {
    write(rollbackPreferenceProfile(
      option(args, "--profile"),
      option(args, "--version"),
      args.includes("--confirm"),
    ));
    return;
  }
  throw new Error("用法：kacha.mjs review build|show|validate|record|learn|activate|rollback [options]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runReviewCli();
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: "1.0",
      status: "blocked",
      diagnostics: [{ code: "KACHA-E180", detail: error.message }],
    }, null, 2));
    process.exit(1);
  }
}
