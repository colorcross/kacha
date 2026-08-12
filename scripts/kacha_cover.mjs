#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  fileIdentity,
  hasValue,
  readJson,
  resolveFrom,
  sha256File,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const action = args[0];
function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs cover template --project-id ID --turnaround FILE [--real-photo FILE] --output FILE\n"
      + "  kacha.mjs cover validate --contract FILE\n"
      + "  kacha.mjs cover prompt --contract FILE [--output FILE]",
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
  if (!projectId || !turnaround || !output) {
    usage();
    process.exit(2);
  }
  writeJsonAtomic(output, buildTemplate(projectId, turnaround, realPhoto));
  console.log(JSON.stringify({ status: "pass", output: path.resolve(output) }, null, 2));
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
} else {
  usage();
  process.exit(2);
}
