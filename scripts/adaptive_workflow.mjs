import fs from 'node:fs';
import path from 'node:path';
import { readJson, resolveFrom, sha256File, sha256Value } from './kacha_utils.mjs';

export const ADAPTIVE_POLICY = 'adaptive-v1';
export const STAGE_DEPENDENCIES = Object.freeze({
  inventory: [],
  transcript_structure: ['inventory'],
  rough_cut: ['transcript_structure'],
  dialogue_preprocess: ['rough_cut'],
  fine_cut: ['rough_cut'],
  connection_qc: ['fine_cut', 'dialogue_preprocess'],
  visual_packaging: ['fine_cut'],
  subtitles: ['fine_cut', 'dialogue_preprocess'],
  final_mix: ['visual_packaging', 'subtitles', 'dialogue_preprocess'],
  cover: ['inventory'],
  preview_render: ['connection_qc', 'visual_packaging', 'subtitles', 'final_mix'],
  final_qc: ['preview_render'],
  release_package: ['final_qc', 'cover'],
});
export const WORKFLOW_PHASES = [
  { id: 'understand', label: '理解任务与素材', stages: ['inventory', 'transcript_structure'] },
  { id: 'draft', label: '形成可播放初稿', stages: ['rough_cut', 'dialogue_preprocess', 'fine_cut', 'connection_qc', 'visual_packaging', 'subtitles', 'final_mix', 'cover', 'preview_render'] },
  { id: 'refine', label: '针对问题修改', repeatable: true, trigger: 'feedback_or_changed_inputs', stages: ['rough_cut', 'dialogue_preprocess', 'fine_cut', 'connection_qc', 'visual_packaging', 'subtitles', 'final_mix', 'cover', 'preview_render'] },
  { id: 'deliver', label: '验证并交付', stages: ['final_qc', 'release_package'] },
];
export function isAdaptive(project) { return project.workflowPolicy?.version === ADAPTIVE_POLICY; }
export function unmetDependencies(state, id) {
  const missing = new Set();
  const visit = node => { for (const dep of STAGE_DEPENDENCIES[node] ?? []) {
    if (state.stages[dep]?.status !== 'complete') missing.add(dep);
    visit(dep);
  } };
  visit(id);return [...missing];
}
export function readyStages(state) {
  return Object.keys(STAGE_DEPENDENCIES).filter(id => state.stages[id]?.status !== 'complete'
    && state.stages[id]?.status !== 'blocked'
    && unmetDependencies(state,id).length === 0);
}
const PLAN_OWNERS = {
  editPlan: ['rough_cut'], directorPlan: ['fine_cut'], assetGapPlan: ['visual_packaging'],
  adaptiveBgm: ['final_mix'], coverIdentity: ['cover'], captionTimelines: ['subtitles'],
  netstyleTimelines: ['visual_packaging'], visualBreathingTimelines: ['visual_packaging'],
  temporalPerceptionAudit: ['final_qc'], semanticReviewSession: ['final_qc'],
  productionQuality: ['rough_cut', 'cover'], qualityEfficiency: ['preview_render'],
};
const MODULE_OWNERS = {
  cutsAndShotScale: ['rough_cut'], retentionAndRhythm: ['rough_cut'],
  dialogueAudio: ['dialogue_preprocess'], visuals: ['visual_packaging'],
  color: ['visual_packaging'], beautyAndMasks: ['visual_packaging'], generatedMedia: ['visual_packaging'],
  subtitles: ['subtitles'], finalMix: ['final_mix'], cover: ['cover'], output: ['preview_render'], qc: ['final_qc'],
};
// File content, including a changed asset behind the same path, is part of the input.
function fingerprintValue(owner, value, cache) {
  if (!value) return value;
  if (Array.isArray(value)) return value.map(v => fingerprintValue(owner, v, cache));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, fingerprintValue(owner,v,cache)]));
  if (typeof value !== 'string') return value;
  const file = resolveFrom(owner, value);
  try { if (file && fs.statSync(file).isFile()) { if (!cache.has(file)) cache.set(file, {path:file,sha256:sha256File(file)}); return cache.get(file); } } catch { /* absent input remains explicit */ }
  return value;
}
function readEntry(owner, entry) {
  const file = resolveFrom(owner, typeof entry === 'string' ? entry : entry?.path);
  if (!file || !fs.existsSync(file)) return { file, value: null };
  return { file, value: readJson(file) };
}
export function adaptiveStageDigests(projectFile, project) {
  // One snapshot hashes each media file once; no cross-snapshot stale cache.
  const cache = new Map(), identity = (owner,value) => fingerprintValue(owner,value,cache);
  const inputs = Object.fromEntries(Object.keys(STAGE_DEPENDENCIES).map(id => [id, {}]));
  const add = (key, value, owners = Object.keys(inputs)) => { for (const id of owners) inputs[id][key] = value; };
  const { plans = {}, outputs = {}, ...spec } = project;
  // Lifecycle timestamps are bookkeeping, not editorial inputs.
  delete spec.lifecycle;
  add('project', identity(projectFile, spec));
  for (const [key, value] of Object.entries(plans)) {
    if (key === 'proposal') {
      const entry = readEntry(projectFile, value);
      if (!entry.value) { add('proposal', { missing: entry.file }); continue; }
      const { planModules = {}, executionFlow = [], planVersion, generatedAt, updatedAt, ...common } = entry.value;
      add('proposal', identity(entry.file, common));
      for (const [name, module] of Object.entries(planModules)) add(`module.${name}`, identity(entry.file,module), MODULE_OWNERS[name]);
      for (const id of Object.keys(inputs)) {
        const stage = (effectiveExecutionFlow(entry.value) ?? []).find(s => s.id === id);
        // Completion evidence is checked separately; writing progress must not invalidate work.
        const { status, evidence, recordedAt, updatedAt, ...contract } = stage ?? {};
        inputs[id].stageContract = identity(entry.file, contract);
        inputs[id].applicability = { notApplicable: status === 'not_applicable', blocked: status === 'blocked' };
      }
    } else if (key === 'timeline' || key === 'timelineIr') {
      const entry = readEntry(projectFile, value);
      if (!entry.value) { add('timeline', { missing: entry.file }, ['rough_cut']); continue; }
      const { audio = {}, visual = {}, output, editor, contracts = {}, ...structure } = entry.value;
      add('timeline.structure', identity(entry.file,structure), ['rough_cut']);
      // Known plan references are already partitioned above; following their entire JSON
      // here would turn a cover edit back into a structural edit. Render gates still bind SHA.
      const { proposal, editPlan, ...otherContracts } = contracts;
      add('timeline.otherContracts', identity(entry.file,otherContracts), ['preview_render']);
      const { subtitles, ...picture } = visual;
      add('timeline.picture', identity(entry.file,picture), ['visual_packaging']);
      add('timeline.subtitles', identity(entry.file,subtitles), ['subtitles']);
      const { bgm, sfx, ...dialogue } = audio;
      add('timeline.dialogue', identity(entry.file,dialogue), ['dialogue_preprocess']);
      add('timeline.music', identity(entry.file,{ bgm, sfx }), ['final_mix']);
      add('timeline.output', output, ['preview_render']);
    } else {
      add(`plan.${key}`, identity(projectFile,value), PLAN_OWNERS[key]);
    }
  }
  // Output content is validated by QC/release; only destinations are planning inputs.
  for (const [key,value] of Object.entries(outputs)) {
    const destination = item => typeof item === 'string' ? item : item?.path ?? item;
    add(`output.${key}`, Array.isArray(value) ? value.map(destination) : destination(value), key === 'covers' ? ['cover'] : ['preview_render']);
    if (key === 'finalVideo') add('actualCandidate', identity(projectFile, destination(value)), ['final_qc']);
    if (key === 'covers') add('actualCovers', identity(projectFile, value), ['release_package']);
  }
  return Object.fromEntries(Object.entries(inputs).map(([id,value]) => [id,sha256Value(value)]));
}
export function reconcileAdaptiveStages(previous, initial, digests, evidenceCurrent) {
  const stages = {};
  for (const id of Object.keys(STAGE_DEPENDENCIES)) {
    const old = previous?.stages?.[id];
    const same = previous?.stageDigests?.[id] === digests[id] && evidenceCurrent(old);
    stages[id] = initial[id]?.status === 'blocked' && initial[id]?.source === 'proposal'
      ? initial[id] : same && old ? old : initial[id]?.notApplicable ? initial[id] : { status: 'pending' };
  }
  // Propagate invalidation along true dependencies, never across independent branches.
  let changed;
  do {
    changed = false;
    for (const [id,deps] of Object.entries(STAGE_DEPENDENCIES)) {
      if (stages[id].status === 'complete' && !stages[id].notApplicable && (unmetDependencies({stages},id).length > 0 || stages[id].inputDigest !== stageInputDigest({ stages, stageDigests: digests }, id))) {
        stages[id] = { status: 'pending' }; changed = true;
      }
    }
  } while (changed);
  return stages;
}

export function effectiveExecutionFlow(plan) {
  if (!isAdaptive(plan) || Array.isArray(plan.executionFlow)) return plan.executionFlow;
  const skip = {};
  if (plan.goal?.hasSpokenDialogue === false) {
    skip.transcript_structure = '工程无对白，不要求转写';
    skip.dialogue_preprocess = '工程无对白，不做人声处理';
  }
  if (plan.planModules?.subtitles?.status === 'not_applicable') skip.subtitles = plan.planModules.subtitles.rationale;
  if (plan.planModules?.cover?.status === 'not_applicable' && plan.goal?.coverAspectRatios?.length === 0) skip.cover = plan.planModules.cover.rationale;
  return Object.keys(STAGE_DEPENDENCIES).map(id => ({ id, deliverable: id, gate: '实际产物与当前输入验证',
    status: skip[id] ? 'not_applicable' : 'pending', ...(skip[id] ? { notApplicableReason: skip[id] } : {}) }));
}

export function stageInputDigest(state, id) {
  return sha256Value({ input: state.stageDigests?.[id], dependencies: (STAGE_DEPENDENCIES[id] ?? []).map(dep =>
    ({ id: dep, input: stageInputDigest(state, dep), evidence: state.stages[dep]?.evidence?.sha256 ?? null, status: state.stages[dep]?.status })) });
}
