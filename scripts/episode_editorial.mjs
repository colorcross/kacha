import fs from "node:fs";
import path from "node:path";
import { loadProductionPack } from "./production_pack.mjs";
import { readJson } from "./kacha_utils.mjs";
import { verifiedEditorialFile, validateEditorialReview } from "./editorial_review.mjs";
import { editorialTimeline } from "./editorial_timeline.mjs";

// Episode evidence supplements Timeline IR; it never becomes a second timeline.
export function episodeTemplate(projectId, showId) {
  const pack = loadProductionPack("dahui-ai", showId);
  const policy = pack.policies.episode;
  return {
    schemaVersion: "1.0", kind: "kacha-episode-editorial", projectId,
    pack: { id: pack.id, version: pack.version, sha256: pack.sha256, showId },
    status: "draft", deliverable: "master", sourceMaster: null,
    question: "", audienceTask: "", ownJudgment: "",
    targetSeconds: policy.targetSeconds,
    beats: policy.structure.map(role => ({ id: role, role, purpose: "", evidenceIds: [], timelineIds: [] })),
    evidence: policy.requiredEvidence.map(kind => ({ id: kind, kind, path: null, sha256: null, locator: "", description: "" })),
    context: { recordedAt: null, toolVersion: null, inputScope: null, primaryBooks: [], aiRole: null,
      ...(["TALK", "NEWS"].includes(policy.category) ? {sourceUrl: null, publishedAt: null} : {}),
      ...(policy.category === "NEWS" ? {eventAt: null, availability: null} : {}),
    },
    chapters: [], turns: [], disclosures: [],
    checks: { facts: "pending", attribution: "pending", readability: "pending", fullSpeedReview: "pending" },
    reviewEvidence: null,
    note: "待填写真实来源和时间线映射；模板不是已核验、已拍摄或已完成。",
  };
}

const identity = (owner, item, errors, label) => verifiedEditorialFile(owner, item, label, errors);
const nonempty = value => typeof value === "string" && value.trim().length > 0;

export function validateEpisode(file, { stage = "plan", timeline = null, expectedProjectId = null, expectedShowId = null, candidate = null, ancestry = [] } = {}) {
  const errors = [];
  if (!["plan", "execution", "release"].includes(stage)) return { status: "fail", errors: ["未知检查阶段"] };
  try {
    file = path.resolve(file);
    if (ancestry.includes(file) || ancestry.length > 8) throw new Error("衍生母片引用循环或层级过深");
    const episode = readJson(file);
    if (episode.schemaVersion !== "1.0" || episode.kind !== "kacha-episode-editorial") throw new Error("节目合同格式无效");
    const pack = loadProductionPack(episode.pack?.id, episode.pack?.showId);
    if (pack.id !== "dahui-ai" || !pack.policies.episode) throw new Error("节目合同必须绑定大灰AI栏目");
    if (episode.pack.sha256 !== pack.sha256 || episode.pack.version !== pack.version) errors.push("节目合同生产包已变化，需要显式复核");
    if (!nonempty(episode.projectId) || (expectedProjectId && episode.projectId !== expectedProjectId)) errors.push("节目 projectId 不匹配");
    if (expectedShowId && pack.showId !== expectedShowId) errors.push("节目 showId 不匹配");
    const policy = pack.policies.episode;
    for (const key of ["question", "audienceTask", "ownJudgment"]) if (!nonempty(episode[key])) errors.push(`${key}: 必须填写本期具体内容`);
    if (!["master", "derivative"].includes(episode.deliverable)) errors.push("deliverable 必须为 master 或 derivative");
    if (!Number.isFinite(episode.targetSeconds) || episode.targetSeconds <= 0) errors.push("目标时长无效");
    if (episode.deliverable === "derivative") {
      const source = identity(file, episode.sourceMaster, errors, "衍生母片");
      if (source) {
        const master = readJson(source);
        if (master.deliverable !== "master" || master.projectId === episode.projectId || master.projectId !== episode.sourceMaster.projectId || master.pack?.showId !== pack.showId) errors.push("衍生须引用独立且同栏目的母片，沿用其期号");
        let parentTimeline = null, parentCandidate = null;
        if (stage === "release") {
          parentTimeline = identity(file, episode.sourceMaster.timeline, errors, "母片时间线");
          parentCandidate = identity(file, episode.sourceMaster.candidate, errors, "母片成片");
        }
        errors.push(...validateEpisode(source, {stage: stage === "release" ? "release" : "plan",
          timeline: parentTimeline, candidate: parentCandidate, expectedShowId: pack.showId,
          ancestry: [...ancestry, file]}).errors.map(error => `母片: ${error}`));
      }
      if (!nonempty(episode.sourceMaster?.contextPreserved)) errors.push("衍生须说明保留了哪些前提与条件");
    }
    if (policy.category === "BOOK" && episode.deliverable === "master") {
      if (episode.targetSeconds < 1800 || episode.targetSeconds > 3600) errors.push("读书母片必须是30–60分钟完整长视频");
      if (episode.context?.primaryBooks?.length !== 1 || !nonempty(episode.context.primaryBooks[0]?.title) || !nonempty(episode.context.primaryBooks[0]?.edition)) errors.push("读书必须绑定一本主书及版本");
    }
    const evidence = Array.isArray(episode.evidence) ? episode.evidence : [];
    const evidenceIds = new Set();
    for (const item of evidence) {
      if (!nonempty(item.id) || evidenceIds.has(item.id)) errors.push("证据 ID 缺失或重复");
      evidenceIds.add(item.id);
      identity(file, item, errors, `证据 ${item.id}`);
      if (!nonempty(item.locator) || !nonempty(item.description)) errors.push(`${item.id}: 缺少页码、原始时间码或记录位置及来源说明`);
      if (item.kind === "generated-illustration") errors.push("生成示意不得登记为节目事实证据");
    }
    for (const kind of (episode.deliverable === "derivative" ? ["source-excerpt"] : policy.requiredEvidence)) if (!evidence.some(item => item.kind === kind)) errors.push(`缺少栏目证据 ${kind}`);
    const beats = Array.isArray(episode.beats) ? episode.beats : [];
    const beatIds = new Set();
    for (const role of (episode.deliverable === "derivative" ? ["excerpt", "context", "judgment"] : policy.structure)) if (!beats.some(beat => beat.role === role)) errors.push(`缺少叙事环节 ${role}`);
    for (const beat of beats) {
      if (!nonempty(beat.id) || beatIds.has(beat.id)) errors.push("叙事 ID 缺失或重复");
      beatIds.add(beat.id);
      if (!nonempty(beat.purpose)) errors.push(`${beat.id}: 缺少叙事目的`);
      if (!Array.isArray(beat.evidenceIds) || !beat.evidenceIds.length || beat.evidenceIds.some(id => !evidenceIds.has(id))) errors.push(`${beat.id}: 未关联实际证据`);
      if (!Array.isArray(beat.timelineIds) || !beat.timelineIds.length) errors.push(`${beat.id}: 缺少 Timeline IR 对象映射`);
    }
    for (const kind of (episode.deliverable === "derivative" ? ["source-excerpt"] : policy.requiredEvidence)) {
      if (!evidence.some(item => item.kind === kind && beats.some(beat => beat.evidenceIds?.includes(item.id)))) errors.push(`${kind}: 证据未进入任何叙事环节`);
    }
    if (policy.aiLinkRequired && ["BOOK", "PRACTICE", "REVIEW", "DEBATE"].includes(policy.category)) {
      for (const field of ["recordedAt", "toolVersion", "inputScope"]) if (!nonempty(episode.context?.[field])) errors.push(`context.${field}: 记录日期、模型工具版本和输入条件`);
    }
    if (["TALK", "NEWS"].includes(policy.category)) {
      try { if (!["http:", "https:"].includes(new URL(episode.context?.sourceUrl).protocol)) throw new Error(); }
      catch { errors.push("访谈/资讯必须记录原始来源 URL"); }
      if (!nonempty(episode.context?.publishedAt) || !Number.isFinite(Date.parse(episode.context.publishedAt))) errors.push("必须记录可解析的原始发布日期");
    }
    if (policy.category === "NEWS" && (!nonempty(episode.context?.eventAt) || !Number.isFinite(Date.parse(episode.context.eventAt))
      || !["announced", "demo", "invite-only", "available", "personally-tested", "unknown"].includes(episode.context?.availability))) errors.push("资讯须分别记录事件日期与真实开放状态");
    if (episode.context?.recordedAt && !Number.isFinite(Date.parse(episode.context.recordedAt))) errors.push("录制日期无效");
    if (policy.category === "BUILD" && !["ai-native", "ai-assisted-development", "non-ai-decision"].includes(episode.context?.aiRole)) errors.push("产品须区分AI原生、AI辅助开发和非AI取舍");
    let duration = episode.targetSeconds;
    if (stage !== "plan") {
      const actual = timeline ? readJson(timeline) : null;
      if (!actual) errors.push("执行检查必须提供当前 Timeline IR");
      else {
        if (actual.projectId !== episode.projectId) errors.push("Timeline IR projectId 不匹配");
        const resolved = editorialTimeline(actual);
        const objects = [...resolved.plan.edl, ...(actual.visual?.overlays ?? []), ...(actual.visual?.breathing ?? []), ...(actual.audio?.sfx ?? [])];
        for (const beat of beats) for (const id of beat.timelineIds ?? []) if (!objects.some(item => item.id === id)) errors.push(`${beat.id}: 当前时间线缺少 ${id}`);
        duration = resolved.duration;
        if (policy.category === "BOOK" && episode.deliverable === "master" && (duration < 1800 || duration > 3600)) errors.push("真实读书母片时间线不是30–60分钟");
      }
    }
    if (policy.chaptersRequired && episode.deliverable === "master") {
      if (!episode.chapters?.length || episode.chapters[0]?.atSeconds !== 0) errors.push("长读书章节须从0秒开始");
      let previous = -1;
      for (const chapter of episode.chapters ?? []) {
        if (!nonempty(chapter.title) || !Number.isFinite(chapter.atSeconds) || chapter.atSeconds <= previous || chapter.atSeconds >= duration) errors.push("章节标题、顺序或最终时间码无效");
        previous = chapter.atSeconds;
      }
    }
    if (policy.category === "DEBATE") {
      const turns = episode.turns ?? [];
      if (!turns.some(turn => turn.speaker === "human") || !turns.some(turn => turn.speaker === "ai")) errors.push("辩论须保留双方真实发言索引");
      for (const turn of turns) if (!["human", "ai"].includes(turn.speaker) || !nonempty(turn.sourceLocator) || !evidenceIds.has(turn.evidenceId) || !beatIds.has(turn.beatId)) errors.push("发言必须关联原会话位置、证据及叙事环节");
      if (!Array.isArray(episode.disclosures) || !episode.disclosures.length || episode.disclosures.some(item => !nonempty(item))) errors.push("须说明实时/异步、等待缩短、重连及补录情况，包括无此操作");
    }
    if (stage === "release") {
      for (const field of ["facts", "attribution", "readability", "fullSpeedReview"]) if (episode.checks?.[field] !== "pass") errors.push(`终审 ${field} 尚未通过`);
      errors.push(...validateEditorialReview(file, episode.reviewEvidence, episode, {timeline, candidate}));
    }
  } catch (error) { errors.push(error.message); }
  return { status: errors.length ? "fail" : "pass", stage, errors };
}
