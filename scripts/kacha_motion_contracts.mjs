#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sha256File } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const registryFile = path.join(
  skillRoot,
  "config",
  "effects",
  "motion-contracts",
  "design-effect-library-v3.json",
);
const args = process.argv.slice(2);
const action = args.find((value) => !value.startsWith("--")) ?? "validate";

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(`动效合同失败：${message}`);
  process.exit(code);
}

function loadRegistry() {
  if (!fs.existsSync(registryFile)) {
    fail(`合同注册表不存在：${registryFile}`);
  }
  return readJson(registryFile);
}

function validateRegistry(registry) {
  const errors = [];
  const allowedFamilies = new Set([
    "思源黑体 CN Light",
    "方正粗金陵简体",
    "青鸟华光标题黑体",
    "Aa封神榜书",
  ]);
  const jinlingSha256 = "3c15643db0ef339e1faf39b8b0c12ffead661565876e617fd25ca5209eabb1ea";
  if (registry.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (registry.kind !== "kacha_design_effect_motion_contract_registry") {
    errors.push("kind 不正确");
  }
  if (!Array.isArray(registry.contracts)) errors.push("contracts 必须为数组");
  const requiredStyleIds = new Set([
    "xingzhe-light-overlay",
    "xingzhe-spatial-lightpath",
    "xingzhe-humor-comic",
    "xingzhe-pixel-editorial",
    "xingzhe-dark-tech",
  ]);
  for (const styleId of requiredStyleIds) {
    if (!registry.styles?.[styleId]) errors.push(`styles 缺少 ${styleId}`);
  }
  const ids = new Set();
  const motionCoresByStyle = new Map();
  const grammarSignaturesByStyle = new Map();
  for (const [index, contract] of (registry.contracts ?? []).entries()) {
    const prefix = `contracts[${index}]`;
    if (!contract.contractId) errors.push(`${prefix} 缺少 contractId`);
    if (ids.has(contract.contractId)) errors.push(`${prefix} contractId 重复`);
    ids.add(contract.contractId);
    for (const field of [
      "effect",
      "style",
      "semanticMotionCore",
      "editingGrammarContract",
      "narrative",
      "applicabilityContract",
      "entry",
      "hold",
      "exit",
      "sfx",
      "constraints",
      "typographyContract",
      "layoutContract",
      "contrastContract",
      "persistentBrandContract",
      "avCoherenceContract",
      "styleMaterialContract",
      "execution",
    ]) {
      if (contract[field] == null) errors.push(`${prefix} 缺少 ${field}`);
    }
    const execution = contract.execution ?? {};
    const grammar = contract.editingGrammarContract ?? {};
    const grammarFields = ["sequence", "camera", "topology", "cutPolicy", "transitionPolicy", "soundPolicy", "forbidSharedPatterns"];
    if (
      !grammar.signature?.id
      || !Array.isArray(grammar.sequence)
      || grammar.sequence.length < 5
      || grammarFields.slice(1, 6).some((field) => typeof grammar[field] !== "string" || !grammar[field].trim())
      || !Array.isArray(grammar.forbidSharedPatterns)
      || grammar.forbidSharedPatterns.length < 4
    ) {
      errors.push(`${prefix}.editingGrammarContract 不完整`);
    }
    if (!contract.effect?.archetype) errors.push(`${prefix}.effect.archetype 缺失`);
    if (
      !Number.isInteger(contract.effect?.compositionVariant)
      || contract.effect.compositionVariant < 0
    ) {
      errors.push(`${prefix}.effect.compositionVariant 必须为非负整数`);
    }
    if (execution.timelineMode !== "seek-safe") {
      errors.push(`${prefix}.execution.timelineMode 必须为 seek-safe`);
    }
    if (!String(execution.renderer ?? "").startsWith("chrome-or-rsvg-explicit-font-svg-reference")) {
      errors.push(`${prefix}.execution.renderer 与实际参考图渲染链不一致`);
    }
    if (!execution.sync?.entryStart || !execution.sync?.visibleLanding || !execution.sync?.sfxPeak) {
      errors.push(`${prefix}.execution.sync 缺少入场、可见落位或音效峰值锚点`);
    }
    if (!Array.isArray(execution.qualityGates) || execution.qualityGates.length < 5) {
      errors.push(`${prefix}.execution.qualityGates 不完整`);
    }
    if (!execution.adaptation?.aspect || !execution.adaptation?.subject) {
      errors.push(`${prefix}.execution.adaptation 缺少横竖版或人物适配规则`);
    }
    if (
      !execution.audio?.cue
      || !Array.isArray(execution.audio?.forbid)
      || !execution.audio?.styleProfile?.id
      || !Array.isArray(execution.audio?.styleProfile?.forbid)
    ) {
      errors.push(`${prefix}.execution.audio 不完整`);
    }
    if (execution.audio?.cue !== execution.audio?.trigger) {
      errors.push(`${prefix}.execution.audio cue 与 trigger 不一致`);
    }
    if (
      execution.audio?.cue !== "none"
      && !execution.audio?.styleProfile?.allowedTriggers?.includes(execution.audio.cue)
    ) {
      errors.push(`${prefix}.execution.audio cue 不在当前风格声音母版允许范围`);
    }
    if (
      execution.audio?.cue === "none"
      && (execution.audio?.peakDbfs !== null || JSON.stringify(execution.audio?.voiceDuckingDb) !== "[0,0]")
    ) {
      errors.push(`${prefix}.execution.audio 静音事件不应保留峰值或闪避`);
    }
    if (!contract.applicabilityContract?.selectionRule || !contract.applicabilityContract?.fallback) {
      errors.push(`${prefix}.applicabilityContract 缺少选择规则或回退`);
    }
    if (contract.applicabilityContract?.minimumMatchedSignals !== 1) {
      errors.push(`${prefix}.applicabilityContract 必须要求至少一个命中信号`);
    }
    const runtimeEvidence = contract.applicabilityContract?.runtimeEvidenceRequired ?? [];
    for (const field of ["matchedSignal", "semanticBeatId", "sourceRange", "fallbackReasonWhenNotApplied"]) {
      if (!runtimeEvidence.includes(field)) {
        errors.push(`${prefix}.applicabilityContract 缺少运行时证据 ${field}`);
      }
    }
    const semanticCore = contract.semanticMotionCore ?? {};
    for (const field of ["trigger", "entry", "hold", "exit", "sfx"]) {
      if (typeof semanticCore[field] !== "string" || !semanticCore[field].trim()) {
        errors.push(`${prefix}.semanticMotionCore.${field} 缺失`);
      }
    }
    const typography = contract.typographyContract ?? {};
    if (
      !Array.isArray(typography.allowedFamilies)
      || typography.allowedFamilies.length !== allowedFamilies.size
      || typography.allowedFamilies.some((family) => !allowedFamilies.has(family))
    ) {
      errors.push(`${prefix}.typographyContract 只能使用四类指定字体`);
    }
    if (typography.subtitle?.family !== "方正粗金陵简体") {
      errors.push(`${prefix}.typographyContract 常规字幕不是真实金陵体`);
    }
    if (typography.subtitle?.fontFile !== "assets/private/fonts/FZCuJinLJW.ttf") {
      errors.push(`${prefix}.typographyContract 金陵体文件路径不正确`);
    }
    if (typography.subtitle?.fontSha256 !== jinlingSha256) {
      errors.push(`${prefix}.typographyContract 金陵体哈希不正确`);
    }
    if (typography.subtitle?.background !== "none" || typography.subtitle?.outline !== "none") {
      errors.push(`${prefix}.typographyContract 常规字幕必须无底色无描边`);
    }
    if (typography.subtitle?.shadowOpacity !== 0.6) {
      errors.push(`${prefix}.typographyContract 字幕阴影必须为 60%`);
    }
    if (typography.silentFallback !== "forbidden") {
      errors.push(`${prefix}.typographyContract 必须禁止字体静默回退`);
    }
    if ((contract.layoutContract?.inputs ?? []).length < 7) {
      errors.push(`${prefix}.layoutContract 缺少人物、字幕、平台UI、品牌、亮度或文字度量输入`);
    }
    if (contract.contrastContract?.minimumRegularTextRatio < 4.5) {
      errors.push(`${prefix}.contrastContract 常规文字对比度不足`);
    }
    if (contract.persistentBrandContract?.required !== true) {
      errors.push(`${prefix}.persistentBrandContract 未要求持续品牌模块`);
    }
    const av = contract.avCoherenceContract ?? {};
    if (av.clock !== "shared-timeline-ir" || av.dialogueIsPrimaryClock !== true) {
      errors.push(`${prefix}.avCoherenceContract 未使用口播主时钟`);
    }
    if (av.visualPeakToleranceFrames > 2 || av.sfxPeakToleranceFrames > 2) {
      errors.push(`${prefix}.avCoherenceContract 声画峰值误差必须不超过 2 帧`);
    }
    if (
      !Array.isArray(av.conflictPriority)
      || av.conflictPriority[0] !== "dialogue_intelligibility"
      || av.conflictPriority[1] !== "subject_face_and_evidence"
      || av.conflictPriority[2] !== "caption_readability"
    ) {
      errors.push(`${prefix}.avCoherenceContract 冲突优先级不正确`);
    }
    if (
      av.picture?.preserveOriginalFootage !== true
      || av.picture?.motionPurposeRequired !== true
      || av.picture?.decorativeLoop !== "forbidden"
    ) {
      errors.push(`${prefix}.avCoherenceContract 画面合同不完整`);
    }
    if (
      av.voice?.ordinarySubtitleSfx !== "forbidden"
      || av.sfx?.resolver !== "assets/audio/sfx-library/kacha-profile.json"
      || av.sfx?.exactNarrativeTriggerRequired !== true
      || av.sfx?.maximumPrimaryCuesPerSemanticBeat !== 1
    ) {
      errors.push(`${prefix}.avCoherenceContract 音效与人声合同不完整`);
    }
    if (av.sfx?.trigger === "none" && execution.audio?.cue !== "none") {
      errors.push(`${prefix}.execution.audio 常规字幕不应绑定音效`);
    }
    if (av.sfx?.trigger !== execution.audio?.trigger) {
      errors.push(`${prefix}.avCoherenceContract 与 execution.audio 触发不一致`);
    }
    const material = contract.styleMaterialContract ?? {};
    if (contract.style?.id === "xingzhe-spatial-lightpath") {
      const forbidden = new Set(material.forbid ?? []);
      if (material.footage !== "preserve-original" || !forbidden.has("opaque-black-region") || !forbidden.has("rectangular-dark-wash")) {
        errors.push(`${prefix}.styleMaterialContract 空间光路未禁止黑块或未保留原底图`);
      }
    }
    if (contract.style?.id === "xingzhe-light-overlay") {
      const forbidden = new Set(material.forbid ?? []);
      if (!forbidden.has("opaque-white-web-modal")) {
        errors.push(`${prefix}.styleMaterialContract 浅暖轻浮层未禁止网页式白卡`);
      }
    }
    if (contract.style?.id === "xingzhe-humor-comic") {
      const forbidden = new Set(material.forbid ?? []);
      if (
        material.footage !== "preserve-original-photographic-face-and-evidence"
        || material.humorMechanismRequired !== true
        || !forbidden.has("full-frame-cartoon-filter")
        || !forbidden.has("meme-template-replacement")
      ) {
        errors.push(`${prefix}.styleMaterialContract 幽默漫画未保留真人证据或未禁止整屏卡通/表情包替换`);
      }
      if (execution.audio?.styleProfile?.id !== "humor-comic-dry-editorial") {
        errors.push(`${prefix}.execution.audio 幽默漫画声音母版不正确`);
      }
      if ((contract.applicabilityContract?.requiredSignals ?? []).length < 5) {
        errors.push(`${prefix}.applicabilityContract 幽默漫画缺少真实喜剧触发`);
      }
    }
    if (contract.style?.id === "xingzhe-pixel-editorial") {
      const forbidden = new Set(material.forbid ?? []);
      if (
        material.footage !== "preserve-original-photographic-face-evidence-and-text"
        || material.textRendering !== "authorized-fonts-antialiased-above-crisp-pixel-graphics"
        || !forbidden.has("full-frame-low-resolution-filter")
        || !forbidden.has("pixelated-face")
      ) {
        errors.push(`${prefix}.styleMaterialContract 像素风未保护真人、证据和文字`);
      }
      if (execution.audio?.styleProfile?.id !== "pixel-editorial-quantized-ui") {
        errors.push(`${prefix}.execution.audio 像素风声音母版不正确`);
      }
      if ((contract.applicabilityContract?.requiredSignals ?? []).length < 6) {
        errors.push(`${prefix}.applicabilityContract 像素风缺少系统或状态触发`);
      }
    }
    if (contract.style?.id === "xingzhe-dark-tech") {
      const forbidden = new Set(material.forbid ?? []);
      if (
        material.footage !== "preserve-original-photographic-face-evidence-and-source"
        || material.maximumDarkIsolationAreaRatio > 0.42
        || material.subjectLumaRetentionMinimum < 0.82
        || material.evidenceLumaRetentionMinimum < 0.90
        || !forbidden.has("full-frame-black-wash")
        || !forbidden.has("generic-cyberpunk-hud")
        || !forbidden.has("continuous-scanline")
      ) {
        errors.push(`${prefix}.styleMaterialContract 暗黑科技风未限制暗部、保护人物证据或禁止通用赛博噪声`);
      }
      if (execution.audio?.styleProfile?.id !== "dark-tech-forensic-diagnostic") {
        errors.push(`${prefix}.execution.audio 暗黑科技风声音母版不正确`);
      }
      if ((contract.applicabilityContract?.requiredSignals ?? []).length < 7) {
        errors.push(`${prefix}.applicabilityContract 暗黑科技风缺少异常、风险或证据裁决触发`);
      }
    }
    const styleId = contract.style?.id ?? "missing-style";
    const priorGrammar = grammarSignaturesByStyle.get(styleId);
    const currentGrammar = JSON.stringify(grammar.signature ?? null);
    if (priorGrammar && priorGrammar !== currentGrammar) {
      errors.push(`${prefix}.editingGrammarContract 同一风格出现多个语法签名`);
    }
    grammarSignaturesByStyle.set(styleId, currentGrammar);
    const core = JSON.stringify({
      entry: contract.entry,
      hold: contract.hold,
      exit: contract.exit,
      sfx: contract.sfx,
    });
    if (!motionCoresByStyle.has(styleId)) motionCoresByStyle.set(styleId, new Map());
    const styleCores = motionCoresByStyle.get(styleId);
    styleCores.set(core, (styleCores.get(core) ?? 0) + 1);
  }
  if (registry.counts?.contracts !== (registry.contracts ?? []).length) {
    errors.push("counts.contracts 与实际数量不一致");
  }
  if (registry.counts?.styles !== requiredStyleIds.size) {
    errors.push(`counts.styles 必须为 ${requiredStyleIds.size}`);
  }
  const expected = (registry.counts?.effects ?? 0) * (registry.counts?.styles ?? 0);
  if (expected !== (registry.contracts ?? []).length) {
    errors.push("effect × style 与合同数量不一致");
  }
  for (const [styleId, cores] of motionCoresByStyle.entries()) {
    const contractCount = [...cores.values()].reduce((sum, count) => sum + count, 0);
    if (cores.size !== contractCount) {
      const largestRepeat = Math.max(...cores.values());
      errors.push(`${styleId} 存在重复动效核心；最大重复次数 ${largestRepeat}`);
    }
  }
  if (new Set(grammarSignaturesByStyle.values()).size !== requiredStyleIds.size) {
    errors.push("五套风格必须具有互不相同的剪辑语法签名，不能只更换颜色、材质或贴纸");
  }
  return errors;
}

function select(registry) {
  const id = option("--id");
  const style = option("--style");
  const kind = option("--kind");
  return registry.contracts.filter((contract) => {
    if (id && contract.effect.id !== id && contract.contractId !== id) return false;
    if (style && contract.style.id !== style && contract.style.label !== style) return false;
    if (kind && contract.effect.kind !== kind) return false;
    return true;
  });
}

const registry = loadRegistry();
const errors = validateRegistry(registry);
if (action === "validate") {
  if (errors.length) fail(errors.join("\n"));
  console.log(JSON.stringify({
    status: "pass",
    registry: registryFile,
    sha256: sha256File(registryFile),
    counts: registry.counts,
  }, null, 2));
  process.exit(0);
}
if (errors.length) fail(errors.join("\n"));

if (action === "list") {
  const contracts = select(registry).map((contract) => ({
    contractId: contract.contractId,
    kind: contract.effect.kind,
    effectId: contract.effect.id,
    label: contract.effect.label,
    style: contract.style.label,
  }));
  console.log(JSON.stringify({ count: contracts.length, contracts }, null, 2));
  process.exit(0);
}

if (action === "show" || action === "resolve") {
  const contracts = select(registry);
  if (contracts.length !== 1) {
    fail(`需要且只能匹配一个合同，当前匹配 ${contracts.length} 个；请补充 --id 和 --style`);
  }
  console.log(JSON.stringify(contracts[0], null, 2));
  process.exit(0);
}

fail("用法：kacha.mjs contracts validate|list|show|resolve [--id ID] [--style STYLE] [--kind KIND]", 2);
