// Both projection and rendering must resolve sparse/named boundaries identically.
export function boundaryTransitions(entries, edl) {
  const count = Math.max(0, edl.length - 1);
  const result = Array.from({ length: count }, (_, boundaryIndex) => ({ boundaryIndex, effectId: 'clean_cut', durationFrames: 0 }));
  for (const [index, entry] of (entries ?? []).entries()) {
    let boundary = Number(entry?.boundaryIndex);
    if (!Number.isInteger(boundary) && entry?.afterClipId) boundary = edl.findIndex(clip => clip.id === entry.afterClipId);
    if (!Number.isInteger(boundary) && entries.length === count) boundary = index;
    if (!Number.isInteger(boundary) || boundary < 0 || boundary >= count) {
      throw new Error(`transitions[${index}].boundaryIndex 无效`);
    }
    const durationFrames = Number(entry.durationFrames ?? 0);
    if (!Number.isSafeInteger(durationFrames) || durationFrames < 0) throw new Error(`transitions[${index}].durationFrames 必须为非负整数`);
    // Existing Timeline IR uses the last declaration for a boundary.
    result[boundary] = { ...entry, boundaryIndex: boundary, durationFrames };
  }
  return result;
}
