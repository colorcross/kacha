#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  readJson,
  resolveFrom,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const configFile = path.join(skillRoot, "config", "intelligence-v6.json");

function number(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function assertFile(file, label) {
  const resolved = path.resolve(file ?? "");
  if (!file || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label}不存在：${resolved}`);
  }
  return resolved;
}

function outputJson(value, file = null) {
  if (file) writeJsonAtomic(path.resolve(file), value);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function redactDiagnostic(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => redactDiagnostic(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      /(?:key|token|secret|password|authorization)/i.test(childKey)
        ? "[REDACTED]"
        : redactDiagnostic(child, childKey),
    ]));
  }
  if (typeof value !== "string") return value;
  if (/(?:key|token|secret|password|authorization)/i.test(key)) return "[REDACTED]";
  return value
    .replace(/((?:authorization\s*:\s*)?(?:Bearer|Basic))\s+\S+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)[^\s]+/gi, "$1[REDACTED]");
}

function stableDigest(value) {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  delete copy.digest;
  return sha256Value(copy);
}

function timedCues(value) {
  const candidates = value.cues ?? value.segments ?? value.transcript?.segments ?? [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("输入必须包含非空 cues/segments");
  }
  const result = candidates.map((cue, index) => {
    const start = number(cue.start ?? cue.startSeconds);
    const end = number(cue.end ?? cue.endSeconds);
    if (start === null || end === null || start < 0 || end <= start) {
      throw new Error(`cues[${index}] 时间区间无效`);
    }
    return {
      id: String(cue.id ?? `beat-${String(index + 1).padStart(4, "0")}`),
      start,
      end,
      text: String(cue.text ?? cue.transcript ?? "").trim(),
      signals: [...new Set((cue.signals ?? []).map(String))].sort(),
      confidence: clamp(number(cue.confidence, 1), 0, 1),
      source: cue,
    };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const ids = new Set();
  for (const [index, cue] of result.entries()) {
    if (ids.has(cue.id)) throw new Error(`cues[${index}].id 重复：${cue.id}`);
    ids.add(cue.id);
    if (index > 0 && cue.start < result[index - 1].end) {
      throw new Error(`cues[${index}] 与前一语义拍重叠，不能建立确定性全片预算`);
    }
  }
  return result;
}

function narrativeRole(cue, index, total) {
  const text = cue.text;
  const signals = new Set(cue.signals);
  if (index === 0 || signals.has("hook") || /^(你知道|为什么|如果|别急|先别|想象)/.test(text)) {
    return "hook";
  }
  if (
    signals.has("evidence")
    || signals.has("fact")
    || signals.has("data")
    || /(?:数据显示|研究|事实|证据|例如|比如|\d+(?:\.\d+)?%)/.test(text)
  ) return "evidence";
  if (
    signals.has("contrast")
    || signals.has("negative")
    || /(?:但是|然而|反而|并不是|不是.+而是|问题在于)/.test(text)
  ) return "contrast";
  if (
    signals.has("conclusion")
    || index === total - 1
    || /(?:所以|因此|结论|最终|真正重要|这意味着)/.test(text)
  ) return "conclusion";
  if (signals.has("call_to_action") || /(?:关注|收藏|转发|评论|试试看)/.test(text)) {
    return "call_to_action";
  }
  if (signals.has("example") || /(?:举个例子|想象一下|具体来说)/.test(text)) {
    return "example";
  }
  return index < Math.ceil(total * 0.35) ? "premise" : "explanation";
}

function contentPriority(cue, role) {
  const signals = new Set(cue.signals);
  if (
    ["hook", "evidence", "contrast", "conclusion"].includes(role)
    || ["number", "proper_noun", "negation", "condition", "causality"].some(
      (signal) => signals.has(signal),
    )
  ) return "must_keep";
  if (cue.confidence < 0.65 || signals.has("low_confidence")) return "requires_review";
  if (signals.has("repetition") || signals.has("filler")) return "compress_candidate";
  return "may_compress";
}

function emphasisScore(cue, role) {
  const signals = new Set(cue.signals);
  let score = {
    hook: 0.92,
    evidence: 0.76,
    contrast: 0.82,
    conclusion: 0.9,
    call_to_action: 0.58,
    example: 0.5,
    premise: 0.38,
    explanation: 0.32,
  }[role] ?? 0.3;
  if (signals.has("logical_emphasis")) score += 0.12;
  if (signals.has("emotion_change") || signals.has("viewpoint_change")) score += 0.08;
  if (signals.has("ordinary_speech") || signals.has("no_narrative_change")) score -= 0.12;
  return clamp(score * (0.7 + cue.confidence * 0.3), 0, 1);
}

function visualIntent(role, cue) {
  const signals = new Set(cue.signals);
  if (role === "evidence") return "evidence_insert";
  if (role === "contrast") return "contrast_reframe";
  if (role === "conclusion" || role === "hook") return "semantic_emphasis";
  if (signals.has("multiple_viewpoints")) return "layered_perspectives";
  if (signals.has("focus_target")) return "mask_focus";
  if (signals.has("motion")) return "keyframed_spatial_change";
  return "hold_live_action";
}

function needsAsset(role, cue) {
  const signals = new Set(cue.signals);
  return role === "evidence"
    || signals.has("illustration_required")
    || signals.has("external_evidence")
    || signals.has("screen_demo");
}

function styleMechanism(config, styleId, intent, highImpact, cue) {
  const style = config.director.styles[styleId];
  if (!style) throw new Error(`未知 V6 风格：${styleId}`);
  if (!highImpact) return style.quietMechanism;
  if (styleId === "humor-comic") {
    const humorous = cue.signals.some((signal) => (
      ["humor", "contrast", "misunderstanding", "reaction", "callback"].includes(signal)
    ));
    return humorous ? style.defaultMechanism : style.quietMechanism;
  }
  if (styleId === "pixel-editorial" && intent === "evidence_insert") {
    return "verified_state_commit";
  }
  return style.defaultMechanism;
}

export function buildDirectorPlan(cuesFile, options = {}) {
  const sourceFile = assertFile(cuesFile, "语义 cues");
  const input = readJson(sourceFile);
  const cues = timedCues(input);
  const config = readJson(configFile);
  const styleId = options.styleId ?? "light-warm-overlay";
  const showId = options.showId ?? "tool-share";
  const duration = Math.max(...cues.map((cue) => cue.end));
  const maximumHighImpact = Math.max(
    1,
    Math.floor((duration / 60) * config.director.maximumHighImpactDecisionsPerMinute),
  );
  const candidates = cues.map((cue, index) => {
    const role = narrativeRole(cue, index, cues.length);
    const score = emphasisScore(cue, role);
    return { cue, index, role, score };
  });
  const ranked = [...candidates]
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = new Set([candidates[0].cue.id]);
  for (const item of ranked) {
    if (selected.size >= maximumHighImpact) break;
    if (item.index > 0 && item.score >= 0.58) selected.add(item.cue.id);
  }
  let consecutiveHigh = 0;
  const beats = candidates.map(({ cue, index, role, score }) => {
    let highImpact = selected.has(cue.id) && score >= 0.58;
    if (index === 0) highImpact = true;
    if (highImpact) consecutiveHigh += 1;
    else consecutiveHigh = 0;
    if (consecutiveHigh > config.director.maximumConsecutiveHighImpactBeats) {
      highImpact = false;
      consecutiveHigh = 0;
    }
    const intent = visualIntent(role, cue);
    return {
      id: cue.id,
      start: cue.start,
      end: cue.end,
      text: cue.text,
      narrativeRole: role,
      contentPriority: contentPriority(cue, role),
      confidence: cue.confidence,
      signals: cue.signals,
      emphasisScore: round(score),
      attentionClass: highImpact ? "high_impact" : "quiet",
      impactDurationSeconds: highImpact
        ? round(Math.min(cue.end - cue.start, config.director.maximumImpactSecondsPerDecision))
        : 0,
      visualIntent: intent,
      styleMechanism: styleMechanism(config, styleId, intent, highImpact, cue),
      effectDecision: highImpact ? "candidate" : "deliberate_none",
      effectReason: highImpact
        ? `全片强调预算内的 ${role} 语义拍`
        : "保留真人与信息呼吸，不为局部热闹消耗全片注意力",
      simplerAlternative: "clean_live_action_or_motivated_cut",
      assetNeed: needsAsset(role, cue)
        ? {
            required: true,
            query: cue.text,
            evidenceType: role === "evidence" ? "factual" : "illustrative",
          }
        : { required: false },
      humanReviewRequired: cue.confidence < 0.65 || cue.signals.includes("low_confidence"),
    };
  });
  const impactSeconds = intervalCoverage(beats
    .filter((beat) => beat.attentionClass === "high_impact")
    .map((beat) => ({
      start: beat.start,
      end: Math.min(beat.end, beat.start + beat.impactDurationSeconds),
    })), duration);
  const quietSeconds = Math.max(0, duration - impactSeconds);
  const highImpactCount = beats.filter((beat) => beat.attentionClass === "high_impact").length;
  const plan = {
    schemaVersion: "1.0",
    kind: "kacha_global_director_plan",
    version: config.version,
    generatedAt: new Date().toISOString(),
    project: {
      id: options.projectId ?? path.basename(sourceFile, path.extname(sourceFile)),
      showId,
      styleId,
      styleGrammar: config.director.styles[styleId]?.grammar,
      durationSeconds: round(duration, 3),
    },
    source: fileIdentity(sourceFile),
    narrativeSpine: beats
      .filter((beat) => ["hook", "contrast", "evidence", "conclusion"].includes(beat.narrativeRole))
      .map((beat) => ({ id: beat.id, role: beat.narrativeRole, text: beat.text })),
    attentionBudget: {
      maximumHighImpactDecisions: maximumHighImpact,
      selectedHighImpactDecisions: highImpactCount,
      quietRatio: round(quietSeconds / duration),
      minimumQuietRatio: config.director.minimumQuietRatio,
      deliberateNoneCount: beats.filter((beat) => beat.effectDecision === "deliberate_none").length,
    },
    opening: {
      count: 1,
      beatId: beats[0].id,
      contract: "必须从首个有效声音或动作建立变化，并在 3 秒内兑现内容承诺",
    },
    beats,
    unresolved: beats
      .filter((beat) => beat.humanReviewRequired)
      .map((beat) => ({ beatId: beat.id, reason: "low_confidence_or_explicit_review" })),
    quality: {
      quietRatioPass: quietSeconds / duration >= config.director.minimumQuietRatio,
      singleOpeningPass: true,
      globalBudgetPass: highImpactCount <= maximumHighImpact,
      status: "requires_human_review",
    },
  };
  plan.digest = stableDigest(plan);
  return plan;
}

export function validateDirectorPlan(plan) {
  const errors = [];
  const config = readJson(configFile);
  if (plan.schemaVersion !== "1.0" || plan.kind !== "kacha_global_director_plan") {
    errors.push("不是有效的 V6 全片导演计划");
  }
  if (plan.version !== config.version) errors.push("director plan 使用了过期的 V6 配置版本");
  if (!Array.isArray(plan.beats) || plan.beats.length === 0) errors.push("beats 不能为空");
  if (plan.opening?.count !== 1) errors.push("全片必须且只能有一个主开场");
  if (plan.project?.styleGrammar !== config.director.styles[plan.project?.styleId]?.grammar) {
    errors.push("全片风格语法与已注册 V6 风格不一致");
  }
  if (!currentFileIdentityMatches(plan.source)) errors.push("director plan 的语义 cues 内容已变化");
  const beats = Array.isArray(plan.beats) ? plan.beats : [];
  const ids = new Set();
  for (const [index, beat] of beats.entries()) {
    if (!beat.id || ids.has(beat.id)) errors.push(`beats[${index}].id 缺失或重复`);
    ids.add(beat.id);
    if (!(Number(beat.start) >= 0 && Number(beat.end) > Number(beat.start))) {
      errors.push(`beats[${index}] 时间区间无效`);
    }
  }
  if (beats[0] && plan.opening?.beatId !== beats[0].id) errors.push("开场必须绑定首个语义拍");
  const highImpact = beats.filter((beat) => beat.attentionClass === "high_impact");
  if (highImpact.length !== plan.attentionBudget?.selectedHighImpactDecisions) {
    errors.push("attentionBudget 的高影响决策计数与 beats 不一致");
  }
  const duration = Number(plan.project?.durationSeconds);
  if (duration > 0) {
    const impactSeconds = intervalCoverage(highImpact.map((beat) => ({
      start: Number(beat.start),
      end: Math.min(Number(beat.end), Number(beat.start) + Number(beat.impactDurationSeconds ?? 0)),
    })), duration);
    const quietRatio = round(Math.max(0, duration - impactSeconds) / duration);
    if (Math.abs(quietRatio - Number(plan.attentionBudget?.quietRatio)) > 0.0001) {
      errors.push("attentionBudget.quietRatio 与真实强调区间不一致");
    }
  }
  if (plan.attentionBudget?.quietRatio < plan.attentionBudget?.minimumQuietRatio) {
    errors.push("全片安静区比例低于导演合同");
  }
  if (
    plan.attentionBudget?.selectedHighImpactDecisions
    > plan.attentionBudget?.maximumHighImpactDecisions
  ) errors.push("高影响决策超过全片预算");
  if (plan.digest !== stableDigest(plan)) errors.push("director plan digest 无效");
  if (currentFileIdentityMatches(plan.source)) {
    try {
      const expected = buildDirectorPlan(plan.source.path, {
        projectId: plan.project?.id,
        showId: plan.project?.showId,
        styleId: plan.project?.styleId,
      });
      if (plan.digest !== expected.digest) {
        errors.push("director plan 与当前语义 cues 和 V6 导演规则的确定性结果不一致");
      }
    } catch (error) {
      errors.push(`director plan 无法从当前语义 cues 重建：${error.message}`);
    }
  }
  return errors;
}

function currentFileIdentityMatches(identity) {
  try {
    if (!identity?.path || !identity?.sha256) return false;
    return fileIdentity(assertFile(identity.path, "绑定文件")).sha256 === identity.sha256;
  } catch {
    return false;
  }
}

function tokenize(value) {
  const text = String(value ?? "").toLowerCase().normalize("NFKC");
  const latin = text.match(/[a-z0-9]+/g) ?? [];
  const chineseRuns = text.match(/[\u3400-\u9fff]+/g) ?? [];
  const chinese = [];
  for (const run of chineseRuns) {
    const chars = [...run];
    chinese.push(...chars);
    for (let index = 0; index + 1 < chars.length; index += 1) {
      chinese.push(chars[index] + chars[index + 1]);
    }
  }
  return [...new Set([...latin, ...chinese])];
}

function mediaText(item) {
  return [
    item.fields?.filename,
    item.fields?.tags,
    item.fields?.description,
    item.fields?.labels,
    item.fields?.transcript,
    item.fields?.ocr,
  ].filter(Boolean).join(" ");
}

function lexicalScore(query, item) {
  const queryTokens = tokenize(query);
  const itemTokens = new Set(tokenize(mediaText(item)));
  if (queryTokens.length === 0) return 0;
  return queryTokens.filter((token) => itemTokens.has(token)).length / queryTokens.length;
}

function resolvedMediaIdentity(item) {
  try {
    const current = fileIdentity(assertFile(item.path, "素材候选"));
    if (
      item.identity
      && (
        Number(item.identity.sizeBytes) !== current.sizeBytes
        || Number(item.identity.mtimeMs) !== current.mtimeMs
      )
    ) return null;
    return current;
  } catch {
    return null;
  }
}

export function buildAssetGapPlan(directorFile, mediaIndexFile = null) {
  const planFile = assertFile(directorFile, "director plan");
  const director = readJson(planFile);
  const errors = validateDirectorPlan(director);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  let index = null;
  if (mediaIndexFile) index = readJson(assertFile(mediaIndexFile, "media index"));
  const items = index?.items ?? index?.assets ?? [];
  const gaps = director.beats
    .filter((beat) => beat.assetNeed?.required)
    .map((beat) => {
      const candidates = items
        .map((item) => ({ item, score: lexicalScore(beat.assetNeed.query, item) }))
        .filter(({ score }) => score >= 0.12)
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)
        .map(({ item, score }) => {
          const identity = resolvedMediaIdentity(item);
          return {
            ref: item.ref ?? `@asset:${item.id}`,
            path: item.path,
            kind: item.kind,
            score: round(score),
            license: item.license ?? "unknown",
            provenance: item.provenance ?? null,
            identity,
            staleSinceIndex: identity === null,
          };
        });
      const usable = candidates.find((candidate) => (
        candidate.score >= 0.25
        && candidate.identity
        && !["unknown", "unverified"].includes(candidate.license)
        && candidate.provenance
      ));
      const identitySensitive = /(?:本人|真实人物|原始截图|官方数据|具体研究|证件|产品实拍)/
        .test(beat.text);
      const resolution = usable
        ? "local_candidate"
        : identitySensitive || beat.assetNeed.evidenceType === "factual"
          ? "user_or_source_evidence_required"
          : "generated_visual_candidate";
      return {
        id: `gap-${beat.id}`,
        beatId: beat.id,
        range: { start: beat.start, end: beat.end },
        query: beat.assetNeed.query,
        evidenceType: beat.assetNeed.evidenceType,
        resolution,
        candidates,
        generationSpec: resolution === "generated_visual_candidate"
          ? {
              purpose: "只补充抽象说明，不冒充事实证据",
              promptBrief: beat.text,
              preservePeopleAndEvidence: true,
              externalOrPaidActionAuthorized: false,
            }
          : null,
        blocker: resolution !== "local_candidate",
        blockerReason: resolution === "generated_visual_candidate"
          ? "generated_asset_not_materialized"
          : resolution === "user_or_source_evidence_required"
            ? "source_evidence_required"
            : null,
      };
    });
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_asset_gap_plan",
    generatedAt: new Date().toISOString(),
    directorPlan: fileIdentity(planFile),
    mediaIndex: mediaIndexFile ? fileIdentity(path.resolve(mediaIndexFile)) : null,
    searchCompleteness: index?.summary?.scan?.truncated === true ? "truncated" : "complete_or_not_provided",
    gaps,
    summary: {
      total: gaps.length,
      localCandidates: gaps.filter((gap) => gap.resolution === "local_candidate").length,
      generatedCandidates: gaps.filter((gap) => gap.resolution === "generated_visual_candidate").length,
      unresolvedGeneratedCandidates: gaps.filter((gap) => (
        gap.resolution === "generated_visual_candidate" && gap.blocker
      )).length,
      userEvidenceRequired: gaps.filter((gap) => (
        gap.resolution === "user_or_source_evidence_required"
      )).length,
      productionReady: gaps.every((gap) => !gap.blocker),
    },
  };
  report.digest = stableDigest(report);
  return report;
}

export function validateAssetGapPlan(plan) {
  const errors = [];
  if (plan.schemaVersion !== "1.0" || plan.kind !== "kacha_asset_gap_plan") {
    errors.push("不是有效的素材缺口计划");
  }
  if (!Array.isArray(plan.gaps)) errors.push("gaps 必须是数组");
  if (!currentFileIdentityMatches(plan.directorPlan)) {
    errors.push("素材缺口计划绑定的 director plan 内容已变化");
  }
  if (plan.mediaIndex && !currentFileIdentityMatches(plan.mediaIndex)) {
    errors.push("素材缺口计划绑定的 media index 内容已变化");
  }
  if (plan.searchCompleteness === "truncated") errors.push("素材索引被截断，不能视为完整搜索");
  for (const [index, gap] of (plan.gaps ?? []).entries()) {
    if (!gap.beatId || !gap.resolution) errors.push(`gaps[${index}] 合同不完整`);
    if (
      gap.resolution === "generated_visual_candidate"
      && gap.generationSpec?.externalOrPaidActionAuthorized !== false
    ) errors.push(`gaps[${index}] 不能预授权外传或付费生成`);
    if (gap.blocker !== (gap.resolution !== "local_candidate")) {
      errors.push(`gaps[${index}].blocker 与素材是否已物化不一致`);
    }
    if (gap.resolution === "local_candidate") {
      const candidate = (gap.candidates ?? []).find((item) => (
        Number(item.score) >= 0.25
        && item.identity
        && !["unknown", "unverified"].includes(item.license)
        && item.provenance
      ));
      if (!candidate || !currentFileIdentityMatches(candidate.identity)) {
        errors.push(`gaps[${index}] 本地素材候选内容已变化，或缺少语义、许可、来源与 SHA-256 证据`);
      }
    }
  }
  const gaps = Array.isArray(plan.gaps) ? plan.gaps : [];
  const expectedSummary = {
    total: gaps.length,
    localCandidates: gaps.filter((gap) => gap.resolution === "local_candidate").length,
    generatedCandidates: gaps.filter((gap) => gap.resolution === "generated_visual_candidate").length,
    unresolvedGeneratedCandidates: gaps.filter((gap) => (
      gap.resolution === "generated_visual_candidate" && gap.blocker
    )).length,
    userEvidenceRequired: gaps.filter((gap) => (
      gap.resolution === "user_or_source_evidence_required"
    )).length,
    productionReady: gaps.every((gap) => !gap.blocker),
  };
  if (JSON.stringify(expectedSummary) !== JSON.stringify(plan.summary)) {
    errors.push("素材缺口计划 summary 与真实缺口不一致");
  }
  if (plan.digest !== stableDigest(plan)) errors.push("asset gap plan digest 无效");
  if (currentFileIdentityMatches(plan.directorPlan) && (!plan.mediaIndex || currentFileIdentityMatches(plan.mediaIndex))) {
    try {
      const expected = buildAssetGapPlan(plan.directorPlan.path, plan.mediaIndex?.path ?? null);
      if (plan.digest !== expected.digest) {
        errors.push("素材缺口计划与当前 director、素材索引和 V6 路由规则的确定性结果不一致");
      }
    } catch (error) {
      errors.push(`素材缺口计划无法从当前证据重建：${error.message}`);
    }
  }
  return errors;
}

function intervalCoverage(intervals, duration) {
  const sorted = intervals
    .map(({ start, end }) => ({ start: Math.max(0, start), end: Math.min(duration, end) }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start);
  let total = 0;
  let current = null;
  for (const interval of sorted) {
    if (!current || interval.start > current.end) {
      if (current) total += current.end - current.start;
      current = { ...interval };
    } else current.end = Math.max(current.end, interval.end);
  }
  if (current) total += current.end - current.start;
  return total;
}

function overlappingPrimary(events, maximum) {
  const points = events.flatMap((event) => [
    { time: event.start, delta: 1, id: event.id },
    { time: event.end, delta: -1, id: event.id },
  ]).sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let peak = 0;
  const failures = [];
  for (const point of points) {
    active += point.delta;
    peak = Math.max(peak, active);
    if (active > maximum) failures.push({ time: point.time, active });
  }
  return { peak, failures };
}

export function auditPerception(timelineFile, options = {}) {
  const file = assertFile(timelineFile, "Timeline IR");
  const timeline = readJson(file);
  const config = readJson(configFile).perception;
  const duration = (timeline.edl ?? []).reduce(
    (total, clip) => total + number(clip.sourceEnd, 0) - number(clip.sourceStart, 0),
    0,
  );
  if (!(duration > 0)) throw new Error("Timeline IR 缺少有效 EDL 时长");
  const width = number(timeline.output?.width, 1920);
  const height = number(timeline.output?.height, 1080);
  const fps = number(timeline.output?.fps, 25);
  const events = [
    ...(timeline.visual?.breathing ?? []).map((event, index) => ({
      id: event.id ?? `breathing-${index + 1}`,
      kind: "breathing",
      start: number(event.start, 0),
      end: number(event.end, 0),
      primary: event.primary !== false,
      source: event,
    })),
    ...(timeline.visual?.overlays ?? []).map((event, index) => ({
      id: event.id ?? `overlay-${index + 1}`,
      kind: "overlay",
      start: number(event.start, 0),
      end: number(event.end, 0),
      primary: event.primary !== false,
      source: event,
    })),
  ];
  const blockers = [];
  const warnings = [];
  for (const event of events) {
    const length = event.end - event.start;
    const source = event.source;
    if (length <= 0) blockers.push({ code: "invalid_interval", eventId: event.id });
    const hasText = Boolean(source.text || source.textContent || source.kind === "text");
    if (hasText && length < config.minimumReadableTextSeconds) {
      blockers.push({ code: "text_exposure_too_short", eventId: event.id, seconds: round(length) });
    }
    const fontSize = number(source.fontSize ?? source.style?.fontSizePx, null);
    const fontRatio = number(
      source.fontSizeRatio,
      fontSize === null ? null : fontSize / height,
    );
    if (hasText && fontRatio === null) {
      blockers.push({ code: "text_size_evidence_missing", eventId: event.id });
    } else if (hasText && fontRatio < config.minimumMobileTextHeightRatio) {
      blockers.push({ code: "mobile_text_too_small", eventId: event.id, fontHeightRatio: round(fontRatio) });
    }
    const areaRatio = number(source.width, 0) * number(source.height, 0) / (width * height);
    if (
      event.kind === "overlay"
      && areaRatio >= 0.85
      && number(source.opacity, 1) >= 0.85
      && length <= config.maximumFullFrameFlashSeconds
    ) blockers.push({ code: "full_frame_flash_risk", eventId: event.id, seconds: round(length) });
    if (
      ["person_behind_text", "subject_cutout", "mask_reveal"].includes(source.effectType)
      && !source.maskEvidence
    ) blockers.push({ code: "mask_evidence_missing", eventId: event.id });
    if (source.visibleLandingFrame !== undefined && source.sfxPeakFrame !== undefined) {
      const delta = Math.abs(number(source.visibleLandingFrame) - number(source.sfxPeakFrame));
      if (delta > config.sfxLandingToleranceFrames) {
        blockers.push({ code: "sfx_landing_misaligned", eventId: event.id, deltaFrames: delta });
      }
    }
  }
  const primary = events.filter((event) => event.primary);
  const concurrency = overlappingPrimary(primary, config.maximumPrimaryEffectsAtOnce);
  if (concurrency.failures.length > 0) {
    blockers.push({
      code: "too_many_primary_effects",
      peak: concurrency.peak,
      samples: concurrency.failures.slice(0, 8),
    });
  }
  const moving = events.filter((event) => event.kind === "breathing" || event.source.motion);
  const motionCoverage = intervalCoverage(moving, duration) / duration;
  if (motionCoverage > config.maximumMotionCoverageRatio) {
    blockers.push({ code: "motion_coverage_exceeded", ratio: round(motionCoverage) });
  }
  if (1 - motionCoverage < config.minimumQuietRatio) {
    blockers.push({ code: "quiet_ratio_too_low", ratio: round(1 - motionCoverage) });
  }
  if (!options.dynamicEvidenceFile) {
    warnings.push({
      code: "dynamic_pixel_evidence_missing",
      detail: "合同级时序审计不能证明真实视频没有蒙版边缘抖动、闪烁或观感冲突",
    });
  }
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_temporal_perception_audit",
    generatedAt: new Date().toISOString(),
    timeline: fileIdentity(file),
    dynamicEvidence: options.dynamicEvidenceFile
      ? fileIdentity(assertFile(options.dynamicEvidenceFile, "动态视觉证据"))
      : null,
    media: { durationSeconds: round(duration, 3), width, height, fps },
    measurements: {
      eventCount: events.length,
      primaryEffectPeak: concurrency.peak,
      motionCoverageRatio: round(motionCoverage),
      quietRatio: round(1 - motionCoverage),
    },
    blockers,
    warnings,
    status: blockers.length > 0 ? "blocked" : "pass_with_human_review",
    humanReview: {
      required: true,
      checklist: [
        "正常速度检查闪烁、蒙版边缘、层间运动与真实阅读时间",
        "手机缩略尺寸检查字幕、卡片和常驻品牌的可读性",
        "确认效果、声音、语音和画面没有同时抢焦点"
      ],
    },
  };
  report.digest = stableDigest(report);
  return report;
}

export function validatePerceptionAudit(value) {
  const errors = [];
  if (value.schemaVersion !== "1.0" || value.kind !== "kacha_temporal_perception_audit") {
    errors.push("不是有效的时序感知审计");
  }
  if (value.digest !== stableDigest(value)) errors.push("perception audit digest 无效");
  if (!currentFileIdentityMatches(value.timeline)) {
    errors.push("perception audit 绑定的 Timeline IR 内容已变化");
  }
  if (value.dynamicEvidence && !currentFileIdentityMatches(value.dynamicEvidence)) {
    errors.push("perception audit 的动态视觉证据内容已变化");
  }
  if (value.status === "blocked") errors.push("perception audit 存在未解决阻断项");
  if (value.humanReview?.required !== true) errors.push("perception audit 不得取消人工动态审片");
  if (
    currentFileIdentityMatches(value.timeline)
    && (!value.dynamicEvidence || currentFileIdentityMatches(value.dynamicEvidence))
  ) {
    try {
      const expected = auditPerception(value.timeline.path, {
        dynamicEvidenceFile: value.dynamicEvidence?.path ?? null,
      });
      if (value.digest !== expected.digest) {
        errors.push("perception audit 与当前 Timeline IR 和 V6 时序规则的确定性结果不一致");
      }
    } catch (error) {
      errors.push(`perception audit 无法从当前 Timeline IR 重建：${error.message}`);
    }
  }
  return errors;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return { items: [], warnings: [] };
  const items = [];
  const warnings = [];
  for (const [index, line] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      warnings.push({ code: "invalid_metrics_jsonl", line: index + 1 });
    }
  }
  return { items, warnings };
}

export function observeProject(projectRoot) {
  const root = path.resolve(projectRoot ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`项目目录不存在：${root}`);
  }
  const jobsRoot = path.join(root, ".kacha", "jobs");
  const warnings = [];
  const jobs = fs.existsSync(jobsRoot)
    ? fs.readdirSync(jobsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(jobsRoot, entry.name, "job.json"))
      .filter((file) => fs.existsSync(file))
      .map((file) => {
        try {
          return readJson(file);
        } catch {
          warnings.push({ code: "invalid_job_json", jobDirectory: path.basename(path.dirname(file)) });
          return null;
        }
      })
      .filter(Boolean)
      .map((job) => ({
        ref: job.ref,
        kind: job.kind,
        status: job.status,
        attempt: job.attempt ?? 0,
        createdAt: job.createdAt,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
        outputs: job.outputs ?? [],
        error: redactDiagnostic(job.error ?? null),
      }))
    : [];
  const eventsFile = path.join(root, ".kacha", "metrics", "events.jsonl");
  const loadedEvents = readJsonLines(eventsFile);
  const events = loadedEvents.items;
  warnings.push(...loadedEvents.warnings);
  const stageHistory = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let referenceTokens = 0;
  let cacheHits = 0;
  let cacheEvents = 0;
  let videoEncodes = 0;
  const tokenMeasurements = { actual: 0, estimated: 0, unavailable: 0 };
  for (const event of events) {
    const seconds = number(event.timing?.wallSeconds, 0);
    const list = stageHistory[event.stage] ?? [];
    if (seconds > 0 && event.status === "pass") list.push(seconds);
    stageHistory[event.stage] = list;
    inputTokens += number(event.tokens?.input, 0);
    outputTokens += number(event.tokens?.output, 0);
    referenceTokens += number(event.tokens?.references, 0);
    if (event.cache?.status) cacheEvents += 1;
    if (event.cache?.status === "hit") cacheHits += 1;
    videoEncodes += number(event.media?.videoEncodes, 0);
    const tokenMeasurement = event.tokens?.measurement;
    if (tokenMeasurement === "actual") tokenMeasurements.actual += 1;
    else if (tokenMeasurement === "estimated") tokenMeasurements.estimated += 1;
    else tokenMeasurements.unavailable += 1;
  }
  const stages = Object.fromEntries(Object.entries(stageHistory).map(([stage, values]) => [
    stage,
    {
      samples: values.length,
      averageSeconds: values.length > 0 ? round(values.reduce((a, b) => a + b, 0) / values.length, 3) : null,
    },
  ]));
  const running = jobs.filter((job) => ["queued", "running", "cancelling"].includes(job.status));
  let disk = null;
  if (typeof fs.statfsSync === "function") {
    const stat = fs.statfsSync(root);
    disk = {
      availableBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
    };
  }
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_project_observability",
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    jobs: {
      total: jobs.length,
      active: running.length,
      failed: jobs.filter((job) => ["failed", "interrupted", "cancellation_failed"].includes(job.status)).length,
      items: jobs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 20),
    },
    metrics: {
      events: events.length,
      stages,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        references: referenceTokens,
        measurement: tokenMeasurements.actual > 0 && tokenMeasurements.estimated === 0
          && tokenMeasurements.unavailable === 0
          ? "actual"
          : tokenMeasurements.actual > 0 || tokenMeasurements.estimated > 0
            ? "mixed_or_estimated"
            : "unavailable",
        events: tokenMeasurements,
      },
      cacheHitRatio: cacheEvents > 0 ? round(cacheHits / cacheEvents) : null,
      videoEncodes,
    },
    eta: running.length === 0
      ? { status: "not_running", seconds: 0 }
      : { status: "unavailable", reason: "当前任务没有可靠的阶段进度分母" },
    cost: { status: "unavailable", reason: "没有实测 provider 费用时不按 Token 猜价格" },
    disk,
    integrity: {
      status: warnings.length === 0 ? "pass" : "degraded",
      warnings,
    },
    privacy: { localOnly: true, secretsExposed: false },
  };
  report.digest = stableDigest(report);
  return report;
}

function validateConfig() {
  const config = readJson(configFile);
  const errors = [];
  if (config.schemaVersion !== "1.0" || config.version !== "6.0.0") {
    errors.push("intelligence-v6 配置版本无效");
  }
  if (Object.keys(config.director?.styles ?? {}).length !== 4) {
    errors.push("V6 必须定义四套互斥风格语法");
  }
  if (config.review?.preferenceActivationRequiresConfirmation !== true) {
    errors.push("长期偏好激活必须显式确认");
  }
  if (config.interchange?.importCreatesCandidateOnly !== true) {
    errors.push("NLE 导入必须只创建候选时间线");
  }
  if (
    !Array.isArray(config.evaluation?.improvementClaim?.guardrailMetrics)
    || config.evaluation.improvementClaim.guardrailMetrics.length === 0
    || !Array.isArray(config.evaluation?.improvementClaim?.primaryMetrics)
    || config.evaluation.improvementClaim.primaryMetrics.length === 0
  ) errors.push("版本提升声明必须配置可测量的护栏与主要指标");
  return { config, errors };
}

export function runIntelligenceCli(args = process.argv.slice(2)) {
  const action = args[0];
  if (action === "validate") {
    const { config, errors } = validateConfig();
    if (errors.length > 0) throw new Error(errors.join("\n"));
    outputJson({
      schemaVersion: "1.0",
      status: "pass",
      config: fileIdentity(configFile),
      version: config.version,
      styleGrammars: Object.keys(config.director.styles),
    });
    return;
  }
  if (action === "director") {
    const cues = option(args, "--cues");
    const plan = buildDirectorPlan(cues, {
      projectId: option(args, "--project-id"),
      showId: option(args, "--show", "tool-share"),
      styleId: option(args, "--style", "light-warm-overlay"),
    });
    outputJson(plan, option(args, "--output"));
    return;
  }
  if (action === "assets") {
    const report = buildAssetGapPlan(
      option(args, "--director"),
      option(args, "--media-index"),
    );
    outputJson(report, option(args, "--output"));
    return;
  }
  if (action === "perception") {
    const report = auditPerception(option(args, "--timeline"), {
      dynamicEvidenceFile: option(args, "--dynamic-evidence"),
    });
    outputJson(report, option(args, "--output"));
    if (report.status === "blocked") process.exitCode = 1;
    return;
  }
  if (action === "observe") {
    outputJson(observeProject(option(args, "--project-root", process.cwd())), option(args, "--output"));
    return;
  }
  if (action === "validate-plan") {
    const file = assertFile(option(args, "--plan"), "V6 计划");
    const value = readJson(file);
    const errors = value.kind === "kacha_global_director_plan"
      ? validateDirectorPlan(value)
      : value.kind === "kacha_asset_gap_plan"
        ? validateAssetGapPlan(value)
      : value.kind === "kacha_temporal_perception_audit"
        ? validatePerceptionAudit(value)
        : ["未知 V6 计划 kind"];
    if (
      args.includes("--for-execution")
      && value.kind === "kacha_asset_gap_plan"
      && value.summary?.productionReady !== true
    ) {
      errors.push("素材缺口计划仍有必须由用户或真实来源补充的证据");
    }
    if (errors.length > 0) throw new Error(errors.join("\n"));
    outputJson({ schemaVersion: "1.0", status: "pass", plan: fileIdentity(file), kind: value.kind });
    return;
  }
  throw new Error(
    "用法：kacha.mjs intelligence validate|director|assets|perception|observe|validate-plan [options]",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runIntelligenceCli();
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: "1.0",
      status: "blocked",
      diagnostics: [{ code: "KACHA-E160", detail: error.message }],
    }, null, 2));
    process.exit(1);
  }
}
