#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJson,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { loadStyleProfile } from "./style_profile.mjs";

const args = process.argv.slice(2);
const action = args[0];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(name) {
  return args.includes(name);
}

function fail(message, code = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    error: message,
  }, null, 2));
  process.exit(code);
}

function requiredCount(policy, durationSeconds) {
  const minutes = durationSeconds / 60;
  return Math.max(
    Number(policy.minimumPerVideo ?? 0),
    Math.ceil(minutes * Number(policy.minimumPerMinute ?? 0) - 1e-9),
  );
}

function maximumCount(policy, durationSeconds) {
  return Math.max(
    Number(policy.minimumPerVideo ?? 0),
    Math.floor((durationSeconds / 60) * Number(policy.maximumPerMinute ?? 0) + 1e-9),
  );
}

function coveragePolicy(profileId, durationSeconds) {
  const loaded = loadStyleProfile(profileId);
  const usageFile = path.join(
    skillDirectory,
    "config",
    "capability-usage",
    `${profileId}.json`,
  );
  if (!fs.existsSync(usageFile)) {
    throw new Error(`风格 ${profileId} 没有 capability usage 配置`);
  }
  const usage = readJson(usageFile);
  if (
    usage.schemaVersion !== "1.0"
    || usage.styleProfile !== profileId
    || !usage.families
  ) {
    throw new Error(`风格 ${profileId} 的 capability usage 配置无效`);
  }
  const active = durationSeconds >= Number(usage.minimumDurationSeconds ?? 0);
  const families = Object.fromEntries(
    Object.entries(usage.families).map(([family, policy]) => [
      family,
      {
        minimum: active ? requiredCount(policy, durationSeconds) : 0,
        maximum: maximumCount(policy, durationSeconds),
      },
    ]),
  );
  return {
    profileId,
    styleDigest: loaded.digest,
    profileDigest: sha256File(usageFile),
    capabilityProfile: usage.profile,
    durationSeconds,
    active,
    families,
    resourceRules: usage.resourceRules,
    diversity: usage.diversity,
    perceptual: usage.perceptual,
  };
}

function eventDuration(event) {
  return Number(event.endSeconds) - Number(event.startSeconds);
}

function collectIds(value, ids = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectIds(item, ids));
    return ids;
  }
  if (!value || typeof value !== "object") return ids;
  if (typeof value.id === "string" && value.id) ids.add(value.id);
  Object.values(value).forEach((item) => collectIds(item, ids));
  return ids;
}

function validateHashedFile(reference, planFile, label, errors) {
  if (!reference?.path || !reference.sha256) {
    errors.push(`${label} 缺少 path/sha256`);
    return;
  }
  const file = path.resolve(path.dirname(planFile), reference.path);
  if (!fs.existsSync(file) || sha256File(file) !== reference.sha256) {
    errors.push(`${label} 不存在或 SHA-256 已失效`);
  }
}

function validatePlan(planFile, forExecution = false, timelineFile = null) {
  const plan = readJson(planFile);
  const errors = [];
  let timelineIds = null;
  if (forExecution) {
    if (!timelineFile || !fs.existsSync(timelineFile)) {
      errors.push("--for-execution 必须提供当前真实 --timeline");
    } else {
      timelineIds = collectIds(readJson(timelineFile));
    }
  }
  if (plan.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (plan.kind !== "kacha_visual_capability_plan") {
    errors.push("kind 必须为 kacha_visual_capability_plan");
  }
  const duration = Number(plan.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    errors.push("durationSeconds 必须为正数");
  }
  let policy = null;
  try {
    policy = coveragePolicy(plan.styleProfile ?? "xingzhe", duration);
  } catch (error) {
    errors.push(error.message);
  }
  if (
    policy
    && (
      plan.policy?.profileDigest !== policy.profileDigest
      || plan.policy?.capabilityProfile !== policy.capabilityProfile
    )
  ) {
    errors.push("能力使用策略或行者风摘要已失效，必须重新规划");
  }
  const events = Array.isArray(plan.events) ? plan.events : [];
  if (events.length === 0) errors.push("events 必须是非空数组");
  const ids = new Set();
  const familyCounts = {};
  const implementationCounts = {};
  const supportingKinds = new Set();
  const captionKinds = new Set();
  const pipKinds = new Set();
  const transitionKinds = new Set();
  let previousStart = -Infinity;
  for (const [index, event] of events.entries()) {
    const label = `events[${index}]`;
    for (const field of [
      "id",
      "family",
      "trigger",
      "mechanism",
      "entryPeakExit",
      "simplerAlternative",
      "failureCondition",
      "implementation",
      "perceptual",
      "qcEvidence",
    ]) {
      if (event[field] === undefined || event[field] === null || event[field] === "") {
        errors.push(`${label}.${field} 缺失`);
      }
    }
    if (ids.has(event.id)) errors.push(`${label}.id 重复：${event.id}`);
    ids.add(event.id);
    const start = Number(event.startSeconds);
    const end = Number(event.endSeconds);
    if (
      !Number.isFinite(start)
      || !Number.isFinite(end)
      || start < 0
      || end <= start
      || end > duration + 1e-6
    ) {
      errors.push(`${label} 时间区间无效`);
    }
    if (start < previousStart) errors.push(`${label} 必须按 startSeconds 排序`);
    previousStart = Number.isFinite(start) ? start : previousStart;
    if (!policy?.families[event.family]) {
      errors.push(`${label}.family 未进入当前风格配额：${event.family}`);
    }
    familyCounts[event.family] = (familyCounts[event.family] ?? 0) + 1;
    const implementationId = String(event.implementation?.id ?? "");
    if (!implementationId) errors.push(`${label}.implementation.id 缺失`);
    implementationCounts[implementationId] = (
      implementationCounts[implementationId] ?? 0
    ) + 1;
    if (
      Number.isFinite(eventDuration(event))
      && eventDuration(event) < Number(policy?.perceptual.minimumVisibleDurationSeconds ?? 0)
    ) {
      errors.push(`${label} 可见时长不足，观众无法感知`);
    }
    const area = Number(event.perceptual?.primaryScreenAreaRatio);
    if (
      !Number.isFinite(area)
      || area < Number(policy?.perceptual.minimumPrimaryScreenAreaRatio ?? 0)
      || area > 1
    ) {
      errors.push(`${label}.perceptual.primaryScreenAreaRatio 不足或无效`);
    }
    if (event.family === "pip" && !event.implementation?.informationDifference) {
      errors.push(`${label} 画中画必须说明相对主画面的信息差`);
    }
    if (event.family === "pip" && event.implementation?.layoutKind) {
      pipKinds.add(event.implementation.layoutKind);
    }
    if (event.family === "expressive_transition") {
      if (!event.implementation?.transitionKind) {
        errors.push(`${label} 可感知转场必须声明 transitionKind`);
      } else {
        transitionKinds.add(event.implementation.transitionKind);
      }
    }
    if (event.family === "caption_relation") {
      const layoutKind = event.implementation?.layoutKind;
      if (![
        "logic_emphasis_inline",
        "left_right_contrast",
        "top_bottom_hierarchy",
      ].includes(layoutKind)) {
        errors.push(`${label} 关系字幕必须声明逻辑重音、左右对照或上下层级`);
      } else {
        captionKinds.add(layoutKind);
      }
    }
    if (event.family === "supporting_media") {
      const kind = event.implementation?.assetKind;
      if (!policy?.resourceRules.supportingMediaAlternatives.includes(kind)) {
        errors.push(`${label}.implementation.assetKind 必须是外部、AI 或 HyperFrames 素材`);
      } else {
        supportingKinds.add(kind);
      }
    }
    if (event.family === "oversize_background_word") {
      if (
        Number(event.perceptual?.subtitleScale) <
        Number(policy?.perceptual.oversizeWordMinimumSubtitleScale)
      ) {
        errors.push(`${label} 超大背景词必须至少为字幕的 3 倍`);
      }
      if (
        area < Number(policy?.perceptual.oversizeWordMinimumScreenAreaRatio)
      ) {
        errors.push(`${label} 超大背景词屏幕占比过小`);
      }
    }
    if (event.family === "person_depth_text") {
      if (
        Number(event.perceptual?.subtitleScale) <
        Number(policy?.perceptual.personDepthTextMinimumSubtitleScale)
      ) {
        errors.push(`${label} 人物前后景文字层级不足`);
      }
      if (
        Number(event.perceptual?.visibleAreaRatio) <
        Number(policy?.perceptual.personDepthTextMinimumVisibleAreaRatio)
      ) {
        errors.push(`${label} 人物后文字可读面积不足`);
      }
    }
    if (!Array.isArray(event.qcEvidence) || event.qcEvidence.length < 2) {
      errors.push(`${label}.qcEvidence 至少包含动态短片和代表帧两类证据`);
    }
    if (forExecution) {
      if (JSON.stringify(event).includes("replace_")) {
        errors.push(`${label} 仍包含模板占位符，不能进入执行`);
      }
      if (!event.binding?.timelineType || !event.binding?.timelineId) {
        errors.push(`${label} 未绑定 Timeline IR 的真实执行对象`);
      } else if (timelineIds && !timelineIds.has(event.binding.timelineId)) {
        errors.push(`${label} 绑定的 Timeline ID 不存在：${event.binding.timelineId}`);
      }
      const asset = event.implementation?.asset;
      if (event.family === "supporting_media") {
        validateHashedFile(asset, planFile, `${label} 支撑素材`, errors);
      }
      if (
        ["mask_depth", "person_depth_text"].includes(event.family)
      ) {
        if (event.implementation?.maskReady !== true) {
          errors.push(`${label} 需要逐帧人物蒙版且必须真实 ready`);
        }
        validateHashedFile(
          event.implementation?.mask,
          planFile,
          `${label} 人物蒙版`,
          errors,
        );
      }
      const evidenceKinds = new Set();
      const evidenceList = Array.isArray(event.qcEvidence) ? event.qcEvidence : [];
      for (const [evidenceIndex, evidence] of evidenceList.entries()) {
        if (!["dynamic_preview", "representative_frame"].includes(evidence?.kind)) {
          errors.push(
            `${label}.qcEvidence[${evidenceIndex}].kind `
            + "必须是 dynamic_preview 或 representative_frame",
          );
          continue;
        }
        evidenceKinds.add(evidence.kind);
        validateHashedFile(
          evidence,
          planFile,
          `${label}.qcEvidence[${evidenceIndex}]`,
          errors,
        );
      }
      for (const requiredKind of ["dynamic_preview", "representative_frame"]) {
        if (!evidenceKinds.has(requiredKind)) {
          errors.push(`${label}.qcEvidence 缺少 ${requiredKind}`);
        }
      }
    }
  }
  if (policy?.active) {
    for (const [family, limits] of Object.entries(policy.families)) {
      const count = familyCounts[family] ?? 0;
      if (count < limits.minimum) {
        errors.push(`${family} 计划 ${count} 次，低于行者风最低配额 ${limits.minimum}`);
      }
      if (count > limits.maximum) {
        errors.push(`${family} 计划 ${count} 次，超过行者风密度上限 ${limits.maximum}`);
      }
    }
    if (
      supportingKinds.size <
      Number(policy.resourceRules.minimumSupportingMediaKinds)
    ) {
      errors.push(
        `支撑素材至少覆盖 ${policy.resourceRules.minimumSupportingMediaKinds} 种来源，`
        + `当前只有 ${supportingKinds.size} 种`,
      );
    }
    if (duration >= 120) {
      for (const required of [
        "logic_emphasis_inline",
        "left_right_contrast",
        "top_bottom_hierarchy",
      ]) {
        if (!captionKinds.has(required)) {
          errors.push(`两分钟以上行者风必须实际使用字幕关系布局：${required}`);
        }
      }
      if (pipKinds.size < 2) {
        errors.push("两分钟以上行者风的 PIP 至少使用两种构图，不能反复套同一角落框");
      }
      if (transitionKinds.size < 2) {
        errors.push("两分钟以上行者风的可感知转场至少覆盖两种有理由的机制");
      }
    }
    const distinctFamilies = Object.values(familyCounts).filter((count) => count > 0).length;
    if (distinctFamilies < Number(policy.diversity.minimumDistinctFamilies)) {
      errors.push(
        `能力家族只覆盖 ${distinctFamilies} 种，低于最低多样性 `
        + `${policy.diversity.minimumDistinctFamilies}`,
      );
    }
    if (events.length > 0) {
      const largestShare = Math.max(...Object.values(implementationCounts)) / events.length;
      if (largestShare > Number(policy.diversity.maximumSingleImplementationShare)) {
        errors.push("单一实现占比过高，不能重复使用同一种小字/弹出方式冒充丰富度");
      }
    }
  }
  const expectedDigest = sha256Value({ ...plan, digest: undefined });
  if (plan.digest !== expectedDigest) errors.push("计划 digest 不一致");
  return {
    plan,
    policy,
    familyCounts,
    supportingKinds: [...supportingKinds],
    errors,
  };
}

function writeTemplate(output, profileId, durationSeconds) {
  const policy = coveragePolicy(profileId, durationSeconds);
  const events = [];
  let cursor = 0;
  for (const [family, limits] of Object.entries(policy.families)) {
    for (let index = 0; index < limits.minimum; index += 1) {
      const start = Math.min(durationSeconds - 1, cursor);
      events.push({
        id: `${family}-${String(index + 1).padStart(2, "0")}`,
        family,
        startSeconds: Number(start.toFixed(3)),
        endSeconds: Number(Math.min(durationSeconds, start + 1).toFixed(3)),
        trigger: "replace_with_real_semantic_trigger",
        mechanism: "replace_with_explainable_visual_mechanism",
        entryPeakExit: "entry / semantic peak / exit before next primary event",
        simplerAlternative: "plain_a_roll_or_single_caption",
        failureCondition: "semantic mismatch, collision, weak perceptual evidence",
        implementation: {
          id: `replace-${family}-${index + 1}`,
          informationDifference: family === "pip"
            ? "replace_with_real_information_difference"
            : undefined,
          assetKind: family === "supporting_media"
            ? policy.resourceRules.supportingMediaAlternatives[
              index % policy.resourceRules.supportingMediaAlternatives.length
            ]
            : undefined,
          layoutKind: family === "caption_relation"
            ? [
                "logic_emphasis_inline",
                "left_right_contrast",
                "top_bottom_hierarchy",
              ][index % 3]
            : family === "pip"
              ? ["detail_corner_rect", "evidence_circle", "interface_square"][index % 3]
              : undefined,
          transitionKind: family === "expressive_transition"
            ? ["directional_smooth", "focus_blur", "push_slide"][index % 3]
            : undefined,
        },
        perceptual: {
          primaryScreenAreaRatio: family === "oversize_background_word" ? 0.14 : 0.1,
          subtitleScale: ["oversize_background_word", "person_depth_text"].includes(family)
            ? family === "oversize_background_word" ? 3 : 1.8
            : 1,
          visibleAreaRatio: family === "person_depth_text" ? 0.7 : 1,
        },
        binding: {
          timelineType: "replace_with_timeline_type",
          timelineId: "replace_with_timeline_id",
        },
        qcEvidence: ["replace_with_dynamic_preview", "replace_with_representative_frame"],
      });
      cursor += Math.max(1.2, durationSeconds / Math.max(1, 2 * events.length));
    }
  }
  const plan = JSON.parse(JSON.stringify({
    schemaVersion: "1.0",
    kind: "kacha_visual_capability_plan",
    status: "template_needs_semantic_and_resource_binding",
    styleProfile: profileId,
    durationSeconds,
    policy,
    events: events.sort((left, right) => left.startSeconds - right.startSeconds),
  }));
  plan.digest = sha256Value({ ...plan, digest: undefined });
  writeJsonAtomic(output, plan);
  return plan;
}

if (!["template", "validate"].includes(action)) {
  fail(
    "用法：visual_capability_plan.mjs template --duration SECONDS --output PLAN.json "
    + "[--style xingzhe]\n"
    + "  visual_capability_plan.mjs validate --plan PLAN.json "
    + "[--for-execution --timeline TIMELINE.json]",
    2,
  );
}

try {
  if (action === "template") {
    const output = path.resolve(option("--output", ""));
    const duration = Number(option("--duration", ""));
    const profile = option("--style", "xingzhe");
    if (!output || !Number.isFinite(duration) || duration <= 0) {
      throw new Error("template 需要 --duration 正数与 --output");
    }
    if (fs.existsSync(output) && !has("--overwrite")) {
      throw new Error(`拒绝覆盖现有计划：${output}`);
    }
    const plan = writeTemplate(output, profile, duration);
    console.log(JSON.stringify({
      status: "pass",
      output,
      eventCount: plan.events.length,
      familyMinimums: plan.policy.families,
      digest: plan.digest,
    }, null, 2));
  } else {
    const planFile = path.resolve(option("--plan", ""));
    if (!fs.existsSync(planFile)) throw new Error(`计划不存在：${planFile}`);
    const timelineFile = option("--timeline")
      ? path.resolve(option("--timeline"))
      : null;
    const result = validatePlan(planFile, has("--for-execution"), timelineFile);
    if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
    console.log(JSON.stringify({
      status: "pass",
      plan: planFile,
      forExecution: has("--for-execution"),
      familyCounts: result.familyCounts,
      supportingKinds: result.supportingKinds,
      digest: result.plan.digest,
    }, null, 2));
  }
} catch (error) {
  fail(error.message);
}
