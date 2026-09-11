// Plain text only: the caller assigns textContent, never innerHTML.
export function formatReviewProposal(proposed = {}) {
  const craft = proposed.editingCraft;
  if (!craft?.treatments.length && !proposed.editingCraftIssues?.length) {
    return proposed.effectDecision === "deliberate_none" ? "保留原镜头，停止装饰性强调"
      : proposed.mechanism ?? proposed.effectType ?? proposed.kind ?? "查看当前片段";
  }
  const lines = ["以下为待审手法，需结合当前片段判断："];
  for (const treatment of craft?.treatments ?? []) {
    lines.push(`${treatment.label ?? treatment.techniqueId}：${treatment.status === "needs_evidence"
      ? "依据不足，暂不采用" : "依据已标注，仍需审片"}`);
  }
  const names = { reading: "阅读", reaction: "人物反应", natural_sound: "现场声" };
  for (const window of craft?.hold?.windows ?? []) {
    lines.push(`${names[window.kind] ?? window.kind}：${window.offsetSeconds ? `落位后 ` : ""}至少 ${window.minimumSeconds} 秒，当前可用 ${window.availableSeconds} 秒`);
  }
  const reasons = {
    missing_evidence: "补齐缺失的素材依据，再决定是否采用",
    low_confidence: "当前标注置信度不足，先核对真实素材",
    insufficient_hold: "停留时间不足：减字、分步揭示或选择更长的真实源段",
    reading_content_not_measured: "尚未标注画面文字，无法确认是否读得完",
    text_ready_offset_without_reading_signal: "已标注文字落位时间，请补充阅读场景标记或修正标注",
  };
  for (const reason of new Set((proposed.editingCraftIssues ?? []).map((item) => item.reason))) {
    lines.push(reasons[reason] ?? `待核对：${reason}`);
  }
  if (craft?.deferredTechniqueIds.length) lines.push(`另有 ${craft.deferredTechniqueIds.length} 项手法暂缓展示，缺失依据仍纳入检查`);
  lines.push("审片接受不会自动执行手法；实施后仍需核对成片。");
  return lines.join("\n");
}
