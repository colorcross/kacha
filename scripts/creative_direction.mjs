#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const self = fileURLToPath(import.meta.url);
const registryFile = path.resolve(path.dirname(self), '../config/creative-direction.json');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, name, max = 4000) {
  if (value === undefined) return '';
  requireValue(typeof value === 'string' && value.length <= max, `${name} 必须为不超过 ${max} 字符的文字`);
  return value.trim();
}
function validateCatalog(input) {
  requireValue(object(input), '创作方向注册表必须是 object');
  const { digest: _digest, ...registry } = input;
  requireValue(typeof registry.id === 'string' && registry.id.length > 0, '注册表缺少 ID');
  requireValue(Array.isArray(registry.providers) && registry.providers.length > 0 && registry.providers.every(x => typeof x === 'string') && new Set(registry.providers).size === registry.providers.length, '工具列表无效');
  requireValue(registry.kind === 'kacha-creative-direction-registry', '创作方向注册表无效');
  for (const key of ['intents', 'techniques']) {
    requireValue(Array.isArray(registry[key]) && registry[key].length > 0, `${key} 不能为空`);
    requireValue(registry[key].every(x => object(x) && typeof x.id === 'string' && /^[a-z][a-z0-9-]*$/.test(x.id) && typeof x.label === 'string' && x.label.trim()), `${key} 缺少有效 ID 或名称`);
    requireValue(new Set(registry[key].map(x => x.id)).size === registry[key].length, `${key} ID 重复`);
  }
  for (const intent of registry.intents) requireValue(Array.isArray(intent.techniques) && intent.techniques.length > 0, '目标缺少方法');
  for (const method of registry.techniques) requireValue(typeof method.principle === 'string' && method.principle.trim() && Array.isArray(method.providerCandidates) && method.providerCandidates.length > 0, '方法缺少原则或工具候选');
  for (const intent of registry.intents) for (const id of intent.techniques) requireValue(registry.techniques.some(x => x.id === id), `未知方法：${id}`);
  for (const method of registry.techniques) for (const id of method.providerCandidates) requireValue(registry.providers.includes(id), `未知执行工具：${id}`);
  return { ...registry, digest: hash(registry) };
}
export function directionCatalog() {
  return validateCatalog(JSON.parse(fs.readFileSync(registryFile, 'utf8')));
}
export function planCreativeDirection(input = {}, catalog = directionCatalog()) {
  catalog = validateCatalog(catalog);
  requireValue(object(input), 'creativeDirection 必须是 object');
  const fields = new Set(['intent', 'brief', 'artDirection', 'pacing', 'techniques', 'customMethod', 'providerPreference']);
  for (const key of Object.keys(input)) requireValue(fields.has(key), `creativeDirection 未知字段：${key}`);
  const intent = input.intent ?? 'auto';
  const target = catalog.intents.find(x => x.id === intent);
  requireValue(target, `未知创作目标：${intent}；新目标可用 custom 并填写 customMethod`);
  const ids = input.techniques ?? target.techniques;
  requireValue(Array.isArray(ids) && ids.length > 0 && ids.every(x => typeof x === 'string'), 'techniques 必须是非空方法 ID 列表');
  requireValue(new Set(ids).size === ids.length, 'techniques 不能重复');
  const methods = ids.map(id => { const method = catalog.techniques.find(x => x.id === id); requireValue(method, `未知方法：${id}；使用 custom 定义新方法`); return method; });
  const customMethod = text(input.customMethod, 'customMethod');
  requireValue(!ids.includes('custom') || customMethod, '自定义方法必须填写 customMethod：目的、动作与回退');
  requireValue(intent !== 'custom' || customMethod, '自定义目标必须填写 customMethod');
  const providerPreference = input.providerPreference ?? 'auto';
  requireValue(providerPreference === 'auto' || catalog.providers.includes(providerPreference), '未知执行工具；外部素材仍通过已验证的 ingest 接口回收');
  const request = { intent, brief: text(input.brief, 'brief'), artDirection: text(input.artDirection, 'artDirection'), pacing: text(input.pacing, 'pacing', 1000), techniques: [...ids], customMethod, providerPreference };
  const proposedProviders = [...new Set([...(providerPreference === 'auto' ? [] : [providerPreference]), ...methods.flatMap(x => x.providerCandidates)])];
  const plan = {
    schemaVersion: '1.0', kind: 'kacha-creative-direction-plan', model: catalog.id, status: 'proposal', registryDigest: catalog.digest, request,
    intentLabel: target.label, methods: structuredClone(methods), proposedProviders,
    execution: { preferredProvider: providerPreference, availability: 'not-checked', requires: ['核实素材与叙事触发', '确认画面方向与代表预览', 'creative doctor 核验所选外部工具', '按原生 skill 创作后经 creative 回收候选', '当前时间线重新审阅'], automaticRender: false, paidGenerationAuthorized: false },
    appearance: { direction: request.artDirection || '从真实素材、品牌与参考提炼；不预设浅暖、暗黑、漫画或像素', pacing: request.pacing || '按信息量、情绪和阅读时间变化；不设统一镜长或音效配额' },
    fallback: '没有叙事触发时保留原素材与正常字幕；明确要求但工具不可用时报告缺口，不静默改画风',
    boundary: '这是表达方案，不是已生成素材或已通过审片；原素材、声音、来源、帧同步与批准版本继续由咔嚓管理。',
  };
  return { ...plan, digest: hash(plan) };
}
export function directionInstruction(plan, task) {
  const { request } = plan;
  return { id: 'open-creative-direction', priority: 'required', appliesTo: [task], modules: ['visual'], text: `创作目标：${plan.intentLabel}。${request.brief ? `本片要求：${request.brief}。` : ''}候选方法：${plan.methods.map(x => `${x.label}（${x.principle}）`).join('；')}。这些方法是方案起点，可按真实内容组合或提出新方法，先更新方案再制作。画面方向：${plan.appearance.direction}。节奏：${plan.appearance.pacing}。${request.customMethod ? `自定义方法：${request.customMethod}。` : ''}候选执行工具：${plan.proposedProviders.join("、")}。执行工具偏好：${request.providerPreference}；工具状态尚未检查，先核实依赖。${plan.fallback}。${plan.boundary}` };
}
// Cue signals nominate methods; they never prove source content or authorize a render.
export function directionForBeat(plan, cue, { protectedBeat = false } = {}) {
  const triggers = {
    continuity: null,
    annotation: ['logical_emphasis', 'focus_target', 'reading'],
    relation: ['causality', 'process', 'relationship', 'workflow_demo'],
    demonstration: ['screen_demo', 'operation', 'workflow_demo'],
    comparison: ['comparison', 'contrast', 'test_result'],
    evidence: ['evidence', 'fact', 'data', 'test_result', 'external_evidence'],
    comic: ['humor', 'misunderstanding', 'reaction', 'callback'],
    state: ['state_change', 'operation', 'workflow_demo', 'progress'],
    montage: ['motion', 'time_passage', 'scene_change'],
    atmosphere: ['emotion_change', 'ambient_sound', 'music'],
  };
  const signals = new Set(cue.signals ?? []);
  const candidates = plan.methods.filter(method =>
    (!protectedBeat || ['continuity', 'comparison', 'evidence', 'demonstration'].includes(method.id))
    && (triggers[method.id] === null || triggers[method.id]?.some(signal => signals.has(signal))));
  return {
    directionDigest: plan.digest,
    candidateMethods: candidates.map(method => ({ id: method.id, principle: method.principle, providerCandidates: method.providerCandidates })),
    reviewMethods: protectedBeat ? [] : plan.methods.filter(method => !(method.id in triggers)).map(method => method.id),
    status: 'requires_material_review',
    decorationAllowed: !protectedBeat,
    fallback: 'preserve_source_and_semantics',
    reason: protectedBeat ? '保护完整语义、阅读或现场声，不添加装饰' : candidates.length ? '按已标注信号提议；制作前核对真实内容与素材' : '没有匹配信号，保留原素材；必要时补充人工观察后重定方案',
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    const { values, positionals } = parseArgs({ options: { request: { type: 'string' }, intent: { type: 'string' }, brief: { type: 'string' }, 'art-direction': { type: 'string' }, pacing: { type: 'string' }, 'custom-method': { type: 'string' }, provider: { type: 'string' } }, allowPositionals: true });
    const action = positionals[0] ?? 'catalog';
    requireValue(positionals.length <= 1 && ['catalog', 'plan'].includes(action), '用法：kacha direction catalog | plan [--request FILE | --intent ID --brief TEXT --art-direction TEXT]');
    requireValue(action !== 'catalog' || Object.keys(values).length === 0, 'catalog 不接受方案参数');
    requireValue(!values.request || Object.keys(values).length === 1, '--request 不可与零散方案参数混用');
    const result = action === 'catalog' ? directionCatalog() : planCreativeDirection(values.request ? JSON.parse(fs.readFileSync(values.request, 'utf8')) : { intent: values.intent, brief: values.brief, artDirection: values['art-direction'], pacing: values.pacing, customMethod: values['custom-method'], providerPreference: values.provider });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
