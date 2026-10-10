import { boundaryTransitions } from "./timeline_transitions.mjs";
import { canonicalizeTimelineTime } from "./media_time.mjs";

// Use the same tick authority and transition boundary semantics as Timeline IR.
export function editorialTimeline(input) {
  const canonical = canonicalizeTimelineTime(input, Number(input.output?.fps ?? input.source?.fps ?? 25));
  if (canonical.errors.length) throw new Error(canonical.errors.join("; "));
  const plan = canonical.plan;
  const edl = plan.edl ?? [];
  if (!edl.length) throw new Error("节目检查需要显式 EDL，不能以目标时长替代实际剪辑");
  const fps = Number(plan.output?.fps ?? canonical.timebase.frameRate.numerator / canonical.timebase.frameRate.denominator);
  if (!(fps > 0)) throw new Error("时间线帧率无效");
  const ids = new Set();
  const durations = edl.map((item, index) => {
    item.id ||= `segment-${String(index + 1).padStart(3, "0")}`;
    if (ids.has(item.id)) throw new Error("时间线 EDL ID 重复");
    ids.add(item.id);
    if (!Number.isFinite(item.sourceStart) || !Number.isFinite(item.sourceEnd)
      || item.sourceStart < 0 || item.sourceEnd <= item.sourceStart) throw new Error("时间线源区间无效");
    return item.sourceEnd - item.sourceStart;
  });
  const transitions = boundaryTransitions(plan.transitions, edl);
  transitions.forEach(({boundaryIndex: boundary, durationFrames: frames}) => {
    if (frames > Math.round(fps * 0.6) || frames / fps >= Math.min(durations[boundary], durations[boundary + 1])) {
      throw new Error("时间线转场边界或时长无效");
    }
  });
  const duration = durations.reduce((sum, item) => sum + item, 0) - transitions.reduce((sum, item) => sum + item.durationFrames / fps, 0);
  if (!(duration > 0)) throw new Error("时间线总时长无效");
  return { plan, duration, fps };
}
