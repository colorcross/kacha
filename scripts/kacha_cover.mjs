#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { reviewTemplate, validateEditorialReview } from "./editorial_review.mjs";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  hasValue,
  readJson,
  resolveFrom,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const action = isMain ? args[0] : null;
const dahuiProfileFile = fileURLToPath(new URL("../config/cover-profiles/dahui-ai.json", import.meta.url));
const coverRatios = ["3:4", "4:3", "16:9", "9:16", "1:1"];

function editorialDesign({ showId = "ai-practice", variant = null, aspectRatio = "16:9" } = {}) {
  const profile = readJson(dahuiProfileFile);
  if (!profile.shows[showId]) throw new Error(`未知大灰AI栏目：${showId}`);
  const selected = variant ?? profile.shows[showId].variant;
  if (!profile.variants[selected]) throw new Error(`未知封面变体：${selected}`);
  if (!coverRatios.includes(aspectRatio)) throw new Error(`不支持的封面画幅：${aspectRatio}`);
  return { profileId: profile.id, profileSha256: sha256File(dahuiProfileFile), showId, variant: selected, aspectRatio };
}
function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs cover template --project-id ID --turnaround FILE [--real-photo FILE] --output FILE\n"
      + "  kacha.mjs cover validate --contract FILE\n"
      + "  kacha.mjs cover prompt --contract FILE [--output FILE]"
      + "\n大灰AI模板：--pack dahui-ai [--show ai-practice --variant tech-interface|scene-poster --aspect-ratio 3:4]",
  );
}

function buildTemplate(projectId, turnaround, realPhoto = null) {
  const turnaroundIdentity = fileIdentity(turnaround);
  const realPhotoIdentity = realPhoto ? fileIdentity(realPhoto) : null;
  return {
    schemaVersion: "1.0",
    kind: "kacha-cinematic-3d-cover-identity-contract",
    projectId,
    generationInputMode: "turnaround_only_real_photo_qc",
    approved3dTurnaroundAnchor: turnaroundIdentity,
    generationInputReferences: [turnaroundIdentity],
    realPhotoAnchor: realPhotoIdentity,
    realPhotoAnchorRole: realPhotoIdentity ? "post_generation_identity_qc_only" : "not_supplied",
    identityLocks: {
      preserveApproved3dFace: true,
      adultCharacter: true,
      blackRectangularGlasses: true,
      shortSpikyBlackHair: true,
      deepNavyClothingBaseline: true,
      photographicFaceMixingForbidden: true,
      existingCharacterOrIpImitationForbidden: true,
    },
    sceneAdaptation: {
      sceneSignal: null,
      narrativeIntent: null,
      bodyAction: null,
      gaze: null,
      expression: null,
      propInteraction: null,
      weightShift: null,
      clothingAdaptation: null,
      clothingContinuity: null,
      reusedApprovedPose: false,
      displayUsesTurnaroundPose: false,
    },
    editorialComposition: {
      continuousCanvasRequired: true,
      grayCharacterBackdropForbidden: true,
      highDensitySemanticCollagePreserved: true,
      foregroundMidgroundBackgroundRequired: true,
      mobileThumbnailLegibilityRequired: true,
    },
    qc: {
      compareGeneratedCharacterToApproved3dFirst: true,
      compareRealPhotoOnlyAfterGeneration: Boolean(realPhotoIdentity),
      identitySimilarityStatus: "pending",
      poseSceneFitStatus: "pending",
      thumbnailStatus: "pending",
    },
  };
}

function verifyIdentity(owner, identity, label, errors) {
  if (!identity?.path || !identity?.sha256) {
    errors.push(`${label} 缺少 path/sha256`);
    return null;
  }
  const file = resolveFrom(owner, identity.path);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    errors.push(`${label} 文件不存在`);
    return null;
  }
  if (fs.lstatSync(file).isSymbolicLink()) errors.push(`${label} 不得是符号链接`);
  if (sha256File(file) !== identity.sha256) errors.push(`${label} sha256 已失效`);
  return file;
}

export function validateCoverIdentityContract(contractFile, { requireQcPass = false } = {}) {
  const resolved = path.resolve(contractFile);
  const contract = readJson(resolved);
  const errors = [];
  if (contract.kind === "kacha-editorial-cover-contract") {
    if (contract.schemaVersion !== "1.0" || contract.productionPack !== "dahui-ai" || !hasValue(contract.projectId)) errors.push("大灰AI封面合同身份无效");
    for (const key of ["question", "headline", "composition"]) if (!hasValue(contract[key])) errors.push(`${key} 缺失`);
    if (!Array.isArray(contract.sources) || !contract.sources.length) errors.push("封面须关联本人实拍、真实书籍、产品或结果证据");
    for (const source of contract.sources ?? []) {
      verifyIdentity(resolved, source, "封面实际来源", errors);
      if (!["real_photo", "real_evidence"].includes(source.role)) errors.push("不可使用合成人物或伪造证据冒充实际来源");
    }
    if (contract.illustrations !== undefined && !Array.isArray(contract.illustrations)) errors.push("illustrations 必须为数组");
    for (const layer of Array.isArray(contract.illustrations) ? contract.illustrations : []) {
      verifyIdentity(resolved, layer, "封面生成示意层", errors);
      if (layer.role !== "generated_illustration" || !hasValue(layer.purpose)) errors.push("生成层须标为generated_illustration并注明用途，不得冒充实际证据");
    }
    // Existing frozen editorial contracts retain their original brief until explicitly migrated.
    if (contract.design !== undefined) {
      try {
        if (!contract.design || typeof contract.design !== "object" || Array.isArray(contract.design)) throw new Error("design 必须为对象");
        const expected = editorialDesign(contract.design);
        for (const key of Object.keys(expected)) {
          if (contract.design[key] !== expected[key]) errors.push(`design.${key} 与当前封面风格不匹配；迁移时重新生成设计配置并审阅`);
        }
      } catch (error) { errors.push(error.message); }
    }
    if (requireQcPass) {
      if (contract.qc?.thumbnailStatus !== "pass") errors.push("手机缩略图尚未验收");
      const candidate = verifyIdentity(resolved, contract.output, "实际封面", errors);
      errors.push(...validateEditorialReview(resolved, contract.qc?.reviewEvidence, contract, {kind:"cover",candidate}));
    }
    return { status: errors.length ? "fail" : "pass", contract: resolved, errors };
  }
  if (contract.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (contract.kind !== "kacha-cinematic-3d-cover-identity-contract") errors.push("kind 无效");
  if (!hasValue(contract.projectId)) errors.push("projectId 缺失");
  verifyIdentity(resolved, contract.approved3dTurnaroundAnchor, "approved3dTurnaroundAnchor", errors);
  if (contract.realPhotoAnchor) {
    verifyIdentity(resolved, contract.realPhotoAnchor, "realPhotoAnchor", errors);
  }
  const references = contract.generationInputReferences ?? [];
  if (
    contract.generationInputMode !== "turnaround_only_real_photo_qc"
    || references.length !== 1
    || references[0]?.sha256 !== contract.approved3dTurnaroundAnchor?.sha256
    || (contract.realPhotoAnchor && contract.realPhotoAnchorRole !== "post_generation_identity_qc_only")
  ) errors.push("生成输入必须只有获批 3D 三视图；真人照片只能用于生成后身份 QC");
  const locks = contract.identityLocks ?? {};
  for (const field of [
    "preserveApproved3dFace", "adultCharacter", "blackRectangularGlasses",
    "shortSpikyBlackHair", "deepNavyClothingBaseline",
    "photographicFaceMixingForbidden", "existingCharacterOrIpImitationForbidden",
  ]) if (locks[field] !== true) errors.push(`identityLocks.${field} 必须为 true`);
  const scene = contract.sceneAdaptation ?? {};
  for (const field of [
    "sceneSignal", "narrativeIntent", "bodyAction", "gaze", "expression",
    "propInteraction", "weightShift", "clothingAdaptation", "clothingContinuity",
  ]) if (!hasValue(scene[field])) errors.push(`sceneAdaptation.${field} 缺失`);
  if (scene.reusedApprovedPose !== false || scene.displayUsesTurnaroundPose !== false) {
    errors.push("封面不得复用固定动作或直接展示 T/A pose 三视图姿态");
  }
  const composition = contract.editorialComposition ?? {};
  for (const field of [
    "continuousCanvasRequired", "grayCharacterBackdropForbidden",
    "highDensitySemanticCollagePreserved", "foregroundMidgroundBackgroundRequired",
    "mobileThumbnailLegibilityRequired",
  ]) if (composition[field] !== true) errors.push(`editorialComposition.${field} 必须为 true`);
  if (requireQcPass) {
    for (const field of ["identitySimilarityStatus", "poseSceneFitStatus", "thumbnailStatus"]) {
      if (contract.qc?.[field] !== "pass") errors.push(`qc.${field} 必须为 pass`);
    }
  }
  return { status: errors.length ? "fail" : "pass", contract: resolved, errors };
}

function promptFor(contract) {
  if (contract.kind === "kacha-editorial-cover-contract" && contract.design) {
    const profile = readJson(dahuiProfileFile);
    const { showId, variant, aspectRatio } = contract.design;
    const selected = profile.variants[variant];
    const percentRange = values => values.map(value => Math.round(value * 100)).join("–");
    return {
      mode: "editorial_2d", references: contract.sources, design: contract.design,
      compositingSources: contract.sources, generationInputReferences: [],
      illustrationLayers: contract.illustrations ?? [],
      generationRequired: false,
      backgroundGenerationOptional: true,
      layoutBrief: [
        profile.direction, `画幅：${aspectRatio}，逐张独立构图。`,
        `核心问题：${contract.question}；正式标题原文：${contract.headline}。`,
        `本期构图：${contract.composition}。`, selected.direction, profile.shows[showId].direction,
        profile.composition.rule, profile.composition.depth, profile.composition.identity,
        profile.composition.cutout, profile.composition.generatedIllustrations,
        `人物高度优先约${Math.round(profile.composition.subjectHeightPreferred * 100)}%，按素材可用性在${percentRange(profile.composition.subjectHeightRatio)}%调整；标题约占${percentRange(profile.composition.headlineAreaRatio)}%，安全边距约${Math.round(profile.composition.safeMarginRatio * 100)}%，最多${profile.composition.sceneElementsMaximum}个主题元素，不遮脸或关键证据。`,
        `${profile.typography.family}；${profile.typography.treatment}。`,
        `主文字优先${profile.typography.headlineLines.join("–")}行、${profile.typography.headlineCharactersPreferred.join("–")}字（书名与必要限定另留位置），最多${profile.typography.emphasisGroupsMaximum}组题眼；${profile.typography.numberRule}。`,
        profile.typography.formalText, profile.composition.labels,
      ].join("\n"),
      palette: profile.palette,
      typography: profile.typography,
      formalText: { headline: contract.headline, seriesLabel: contract.seriesLabel ?? null, issueNumber: contract.issueNumber ?? null, rendering: "deterministic_typography_after_compositing" },
      backgroundPrompt: `仅可选生成无字背景或明确示意层。${selected.direction} 按本期主题：${contract.question}；构图：${contract.composition}。为正式文字和本人实拍预留空间。不要生成任何人物、文字、界面、书封、数字或事实证据；本人及证据必须从已绑定真实来源单独合成。`,
      negativePrompt: [...profile.negative, selected.avoid].join("；"),
      qcChecklist: profile.qc,
    };
  }
  if (contract.kind === "kacha-editorial-cover-contract") return {
    mode: "editorial_2d", references: contract.sources,
    layoutBrief: `${contract.composition}；核心问题：${contract.question}；主文字：${contract.headline}。手机缩略图可读，保留真实来源含义；系列名和期号可选，不增加3D人物或高密度拼贴。`,
    generationRequired: false,
  };
  const scene = contract.sceneAdaptation;
  return {
    generationInputMode: contract.generationInputMode,
    generationInputReferences: contract.generationInputReferences,
    generationPrompt: [
      "只以获批的行者大灰 3D 三视图角色资产作为人物生成输入和身份基准。",
      "高品质院线级 3D 动画电影人物语言：温暖、圆润但不幼龄化，精细皮肤、头发、布料材质与电影级灯光。",
      "保持获批 3D 角色的成年脸型、黑框矩形眼镜、短刺黑发；深藏蓝服装为连续性基线，再按场景做克制适配。",
      `场景信号：${scene.sceneSignal}。叙事意图：${scene.narrativeIntent}。`,
      `动作：${scene.bodyAction}；视线：${scene.gaze}；表情：${scene.expression}。`,
      `道具互动：${scene.propInteraction}；重心：${scene.weightShift}。`,
      `服装适配：${scene.clothingAdaptation}；连续性：${scene.clothingContinuity}。`,
      "人物必须融入高密度语义编辑拼贴的连续画布，保留前中后景和印刷质感；标题在手机缩略图清晰可读。",
    ].join(" "),
    negativePrompt: [
      "不要使用真人照片作为生成输入，不要混入摄影真人脸、写实毛孔或真人皮肤质感",
      "不要 T-pose、A-pose、三视图展示姿势或跨期复用固定动作",
      "不要灰色人物底板，不要孤立棚拍人物，不要普通单层 3D 海报",
      "不要复制或近似任何现成动画角色、电影造型、Logo 或 IP",
      "不要幼龄化、塑料感、低质描边、文字不可读或人物遮挡标题",
    ].join("；"),
    postGenerationQcReference: contract.realPhotoAnchor ?? null,
  };
}

if (action === "template") {
  const projectId = option("--project-id");
  const turnaround = option("--turnaround");
  const realPhoto = option("--real-photo");
  const output = option("--output");
  const editorial = option("--pack") === "dahui-ai";
  if (!projectId || (!editorial && !turnaround) || !output) {
    usage();
    process.exit(2);
  }
  if (fs.existsSync(output) && !args.includes("--overwrite")) throw new Error("拒绝覆盖已有封面合同");
  writeJsonAtomic(output, editorial ? {
    schemaVersion: "1.0", kind: "kacha-editorial-cover-contract", productionPack: "dahui-ai", projectId,
    question: null, headline: null, composition: null,
    design: editorialDesign({ showId: option("--show", "ai-practice"), variant: option("--variant"), aspectRatio: option("--aspect-ratio", "16:9") }),
    sources: [
      ...(realPhoto ? [{ ...fileIdentity(realPhoto), role: "real_photo" }] : []),
      ...(option("--evidence") ? [{ ...fileIdentity(option("--evidence")), role: "real_evidence" }] : []),
    ],
    illustrations: [],
    seriesLabel: null, issueNumber: null, output: null, qc: { thumbnailStatus: "pending", reviewEvidence: null },
  } : buildTemplate(projectId, turnaround, realPhoto));
  console.log(JSON.stringify({ status: "pass", output: path.resolve(output) }, null, 2));
} else if (action === "review-template") {
  const file=option("--contract"), output=option("--output");
  if (!file || !output || fs.existsSync(output)) throw new Error("需要 --contract、未占用的 --output");
  const contract=readJson(file), report=validateCoverIdentityContract(file);
  if (contract.kind !== "kacha-editorial-cover-contract" || report.status !== "pass") throw new Error("需要有效的大灰AI封面合同");
  const errors=[], candidate=verifyIdentity(file,contract.output,"实际封面",errors);
  if (errors.length) throw new Error(errors.join("; "));
  writeJsonAtomic(output,reviewTemplate(contract,{kind:"cover",candidate}));
  console.log(JSON.stringify({status:"pending",output:path.resolve(output)}));
} else if (action === "validate") {
  const contractFile = option("--contract");
  if (!contractFile) {
    usage();
    process.exit(2);
  }
  const report = validateCoverIdentityContract(contractFile, {
    requireQcPass: args.includes("--require-qc-pass"),
  });
  if (report.status !== "pass") report.errors.forEach((error) => console.error(`- ${error}`));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "pass") process.exit(1);
} else if (action === "prompt") {
  const contractFile = option("--contract");
  const output = option("--output");
  if (!contractFile) {
    usage();
    process.exit(2);
  }
  const validation = validateCoverIdentityContract(contractFile);
  if (validation.status !== "pass") {
    validation.errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  const prompt = promptFor(readJson(contractFile));
  if (output) writeJsonAtomic(output, prompt);
  console.log(JSON.stringify({ status: "pass", prompt, ...(output ? { output: path.resolve(output) } : {}) }, null, 2));
} else if (isMain) {
  usage();
  process.exit(2);
}
