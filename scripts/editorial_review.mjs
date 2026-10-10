import fs from "node:fs";
import path from "node:path";
import { readJson, sha256File, sha256Value } from "./kacha_utils.mjs";

export function editorialDigest(contract) {
  const content = structuredClone(contract);
  for (const field of ["reviewEvidence", "checks", "status", "qc"]) delete content[field];
  if (content.kind === "kacha-production-quality-contract" && content.release) {
    for (const field of ["representativeNormalSpeed", "fullPlayback", "deviceListening"]) delete content.release[field];
  }
  return sha256Value(content);
}

export function verifiedEditorialFile(owner, identity, label, errors) {
  if (!identity?.path || !/^[a-f0-9]{64}$/.test(identity.sha256 ?? "")) {
    errors.push(`${label}: 缺少 path/sha256`);
    return null;
  }
  const file = path.resolve(path.dirname(owner), identity.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()
    || sha256File(file) !== identity.sha256) {
    errors.push(`${label}: 来源文件缺失、符号链接或摘要失效`);
    return null;
  }
  return file;
}

export function reviewTemplate(contract, { candidate, timeline = null, kind = "episode" }) {
  const identity = file => ({ path: path.resolve(file), sha256: sha256File(file) });
  return {
    schemaVersion: "1.0", kind: "kacha-editorial-review", subject: kind,
    projectId: contract.projectId, contentDigest: editorialDigest(contract),
    candidate: identity(candidate), ...(timeline ? { timeline: identity(timeline) } : {}),
    reviewer: "", reviewedAt: null, status: "pending",
    checks: kind === "production"
      ? { representativeNormalSpeed: "pending", fullPlayback: "pending", deviceListening: "pending" }
      : kind === "episode"
      ? { facts: "pending", attribution: "pending", readability: "pending", fullSpeedReview: "pending" }
      : { thumbnail: "pending" },
  };
}

export function validateEditorialReview(owner, reference, contract, { kind = "episode", timeline = null, candidate = null } = {}) {
  const errors = [];
  const file = verifiedEditorialFile(owner, reference, "终审记录", errors);
  if (!file) return errors;
  try {
    const review = readJson(file);
    if (review.schemaVersion !== "1.0" || review.kind !== "kacha-editorial-review"
      || review.subject !== kind || review.projectId !== contract.projectId
      || review.contentDigest !== editorialDigest(contract)) errors.push("终审记录不属于当前节目/封面内容");
    if (typeof review.reviewer !== "string" || !review.reviewer.trim()
      || typeof review.reviewedAt !== "string" || !Number.isFinite(Date.parse(review.reviewedAt))
      || review.status !== "pass") errors.push("终审须记录实际审阅人、时间与通过状态");
    const checks = kind === "production" ? ["representativeNormalSpeed", "fullPlayback", "deviceListening"] : kind === "episode" ? ["facts", "attribution", "readability", "fullSpeedReview"] : ["thumbnail"];
    if (checks.some(key => review.checks?.[key] !== "pass")) errors.push("终审各项尚未通过");
    for (const [label, expected] of [["candidate", candidate], ...(kind !== "cover" ? [["timeline", timeline]] : [])]) {
      const actual = verifiedEditorialFile(file, review[label], `终审 ${label}`, errors);
      if (!expected || !actual || path.resolve(expected) !== actual) errors.push(`终审 ${label} 未绑定当前产物`);
    }
  } catch (error) { errors.push(`终审记录无效：${error.message}`); }
  return errors;
}
