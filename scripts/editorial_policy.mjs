import fs from "node:fs";
import { readJson, resolveFrom, sha256File } from "./kacha_utils.mjs";

export const NARRATIVE_POLICY = "narrative-v1";
export function editorialVersion(value = "legacy") {
  if (!["legacy", NARRATIVE_POLICY].includes(value)) throw new Error(`未知叙事政策：${value}`);
  return value;
}
export function firstMinutePolicy(original, version) {
  const result = structuredClone(original);
  if (editorialVersion(version) === NARRATIVE_POLICY) {
    for (const key of ["minimumMotivatedEffects", "minimumDistinctMechanisms", "minimumPeakAlignedSfx", "minimumHumanReactionWindows"]) result[key] = 0;
  }
  return result;
}
// Requirements are an independently hashed editorial decision, never inferred
// from the number of decorations. User and factual needs cannot be downgraded.
export function validateEditorialRequirements(owner, binding, { execution = false, timeline = null } = {}) {
  const errors = [];
  try {
    if (!binding?.path || !/^[a-f0-9]{64}$/.test(binding.sha256 ?? "")) throw new Error("叙事需求缺少 path/sha256");
    const file = resolveFrom(owner, binding.path);
    if (!fs.existsSync(file) || sha256File(file) !== binding.sha256) throw new Error("叙事需求文件身份已失效");
    const contract = readJson(file);
    if (contract.version !== NARRATIVE_POLICY || !Array.isArray(contract.requirements) || !contract.requirements.length) throw new Error("叙事需求必须有版本和非空 requirements");
    const ids = new Set();
    const actual = timeline ? readJson(timeline) : null;
    const objects = [...(actual?.edl ?? []), ...(actual?.visual?.overlays ?? []), ...(actual?.visual?.breathing ?? []), ...(actual?.audio?.sfx ?? [])];
    for (const item of contract.requirements) {
      if (!item.id || ids.has(item.id)) errors.push("叙事需求 ID 缺失或重复");
      ids.add(item.id);
      if (!["required", "conditional", "optional"].includes(item.priority) || !["user", "fact", "editorial"].includes(item.origin) || !String(item.reason ?? "").trim()) errors.push(`${item.id}: 需求分层、来源或理由缺失`);
      if (["user", "fact"].includes(item.origin) && item.priority !== "required") errors.push(`${item.id}: 用户或事实需求不能降级`);
      if (item.priority === "conditional" && (typeof item.triggered !== "boolean" || !item.condition)) errors.push(`${item.id}: 条件增强必须明确触发条件及结果`);
      const needed = item.priority === "required" || (item.priority === "conditional" && item.triggered === true);
      if (needed && (!Array.isArray(item.timelineIds) || !item.timelineIds.length)) errors.push(`${item.id}: 必需表达缺少执行映射`);
      if (!needed && !String(item.dispositionReason ?? "").trim()) errors.push(`${item.id}: 未采用或可选表达需说明决定`);
      if (execution && needed) {
        if (!actual) errors.push(`${item.id}: 执行检查必须提供当前 timeline`);
        else for (const id of item.timelineIds ?? []) if (!objects.some(object => object.id === id)) errors.push(`${item.id}: 当前 timeline 没有执行对象 ${id}`);
        if (item.origin === "fact") {
          for (const id of item.timelineIds ?? []) {
            const object = objects.find(value => value.id === id);
            if (!object?.provenance?.evidence || object.provenance.kind === "illustration") errors.push(`${item.id}: 事实表达缺少真实来源，不能用示意替代`);
          }
        }
      }
    }
  } catch (error) { errors.push(error.message); }
  return errors;
}
