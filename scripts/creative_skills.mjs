#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, fileIdentity, sha256Value, acquireFileLock, run as runtimeRun } from './kacha_utils.mjs';
import { need, digest, exclusive, checkIdentity, validateCreative, treeIdentity, verifyCreativeVideo, readCreativeReceipt, canonicalDestination, PROVIDERS } from './creative_contract.mjs';
import { providerRuntime, runtimeIdentity, creativeCatalog, creativeDoctor, renderCommands } from './creative_providers.mjs';
import { acquireResourceLeases } from './resource_pool.mjs';
import { loadKachaConfig } from './kacha_config.mjs';
import { buildTimelineProjection, assertProjectionSourceCurrent } from './timeline_projection.mjs';
const self = fileURLToPath(import.meta.url), scripts = path.dirname(self);
function run(command, args, options = {}) {
  const result = runtimeRun(command, args, { timeout: 1800000, maxBuffer: 12 * 1024 * 1024, ...options });
  if (options.log) fs.writeFileSync(options.log, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  need(!result.error && result.status === 0, `${path.basename(command)} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
function recordFailure(root, stage, error) {
  const file = path.join(root, 'failure.json');
  if (!fs.existsSync(file)) exclusive(file, { status: 'failed', stage, message: error.message, recovery: '保留日志；确认任务树退出后使用新输出包重试', at: new Date().toISOString() });
}
export function validateNativeCheck(provider, step, stdout) {
  if (provider !== 'huashu-motion' || step !== 'qa') return null;
  const qa = JSON.parse(stdout);
  need(Array.isArray(qa.pops) && Array.isArray(qa.dead) && Array.isArray(qa.cuts), 'OM QA 返回结构无效');
  need(qa.pops.length === 0, `OM QA 发现 ${qa.pops.length} 处单帧闪跳，先修复后重渲染`);
  return { check: 'om-qa', status: 'no_single_frame_pops', readingHolds: qa.dead, cuts: qa.cuts, humanReview: 'required' };
}
function freezeSource(source, target) {
  fs.mkdirSync(target);
  for (const f of source.files) {
    const dest = path.join(target, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source.root, f.path), dest, fs.constants.COPYFILE_EXCL);
  }
  need(treeIdentity(target).sha256 === source.sha256, '冻结源项目时输入已变化');
}
export function creativeTemplate(provider, project) {
  need(PROVIDERS.includes(provider), '未知 provider');
  return { schemaVersion: '1.0', provider, purpose: 'insert', reason: '', project: path.resolve(project), entry: provider === 'huashu-art-motion' ? 'clip.json' : 'index.html', output: { width: 1920, height: 1080, fps: 30, frames: 180, transparent: false }, audioPolicy: 'silent-visual-retain-original', directionStatus: 'selected', evidence: { treatment: 'treatment.md', rights: 'rights.md', direction: 'direction-approved.md' } };
}
function preparePackage(plan, output, { imported = false } = {}) {
  const validated = validateCreative(plan);
  let root = canonicalDestination(output);
  need(root !== validated.source.root && !root.startsWith(validated.source.root + path.sep), '输出包必须位于创作源项目之外');
  const runtime = imported ? null : providerRuntime(plan.provider);
  const runtimeSnapshot = runtime ? runtimeIdentity(runtime) : null;
  fs.mkdirSync(path.dirname(root), { recursive: true }); fs.mkdirSync(root); root = fs.realpathSync(root);
  freezeSource(validated.source, path.join(root, 'source'));
  const manifest = { kind: 'kacha-creative-package', schemaVersion: '1.0', plan: validated.plan, source: validated.source, runtime, runtimeSnapshot, adapter: [self, ...['creative_contract.mjs', 'creative_providers.mjs', 'kacha_utils.mjs', 'wise_motion_contract.mjs', 'resource_pool.mjs', 'kacha_config.mjs'].map(f => path.join(scripts, f))].map(fileIdentity), imported, createdAt: new Date().toISOString() };
  manifest.digest = digest(manifest); exclusive(path.join(root, 'creative.json'), manifest);
  return { root, manifest };
}
export function prepareCreative(plan, output) {
  need(plan.renderMode !== 'external-output', '外部场景/后端请先用原工具渲染，再 creative ingest');
  const { root } = preparePackage(plan, output);
  try {
    const job = JSON.parse(run(process.execPath, [path.join(scripts, 'kacha_jobs.mjs'), 'submit', '--project-root', root, '--id', 'creative-render', '--kind', 'motion-render', '--expected-output', path.join(root, 'receipt.json'), '--', process.execPath, self, 'worker', '--package', root, '--manifest-sha', fileIdentity(path.join(root, 'creative.json')).sha256]));
    return { status: 'queued', package: root, job };
  } catch (error) { recordFailure(root, 'submit', error); throw error; }
}
function finalize(root, manifest, raw, execution) {
  const initial = fileIdentity(raw), media = verifyCreativeVideo(raw, manifest.plan.output, { silent: false });
  const ext = path.extname(raw).toLowerCase();
  need(['.mov', '.mp4', '.webm', '.mkv'].includes(ext), '不支持的媒体容器');
  need((manifest.plan.output.transparent ? ['prores', 'qtrle', 'png'] : ['h264', 'hevc', 'av1', 'vp9', 'mpeg4']).includes(media.codec), '此编码不能无损封装到工作画面；请用原工具导出 H.264/HEVC，透明画面导出 ProRes 4444');
  const original = path.join(root, `original${ext}`);
  if (path.resolve(raw) !== original) fs.copyFileSync(raw, original, fs.constants.COPYFILE_EXCL);
  checkIdentity(initial); need(fileIdentity(original).sha256 === initial.sha256, '复制原件时身份变化');
  const originalIdentity = fileIdentity(original);
  const visual = path.join(root, manifest.plan.output.transparent ? 'visual.mov' : 'visual.mp4');
  run('ffmpeg', ['-v', 'error', '-n', '-i', original, '-map', '0:v:0', '-an', '-c:v', 'copy', visual]);
  const checked = verifyCreativeVideo(visual, manifest.plan.output);
  const videoIdentity = fileIdentity(visual);
  run('ffmpeg', ['-v', 'error', '-xerror', '-i', original, '-f', 'null', '-']);
  run('ffmpeg', ['-v', 'error', '-xerror', '-i', visual, '-f', 'null', '-']);
  need(treeIdentity(path.join(root, 'source')).sha256 === manifest.source.sha256, '冻结源已改变');
  need(readJson(path.join(root, 'creative.json')).digest === manifest.digest && digest(readJson(path.join(root, 'creative.json'))) === manifest.digest, '回收期间合同变化');
  for (const identity of [initial, originalIdentity, videoIdentity]) checkIdentity(identity);
  const receipt = { kind: 'kacha-creative-receipt', schemaVersion: '1.0', status: 'rendered_requires_review', manifest: fileIdentity(path.join(root, 'creative.json')), original: originalIdentity, video: videoIdentity, originalAudio: media.audio, media: checked, execution, evidence: Object.values(manifest.plan.evidence).map(f => fileIdentity(path.join(root, 'source', f))), checks: { decoded: true, exactGeometry: true, exactFrames: true, constantFrameTiming: true, squarePixels: true, noRotation: true, silentVisual: true }, factualEvidence: false, reviewRequired: ['normal_speed', 'facts', 'rights', 'style', 'placement', 'audio_in_final_timeline'] };
  receipt.digest = digest(receipt); exclusive(path.join(root, 'receipt.json'), receipt);
  return receipt;
}
export function renderCreative(directory, expectedSha) {
  const root = fs.realpathSync(directory), file = path.join(root, 'creative.json'), m = readJson(file);
  need(fileIdentity(file).sha256 === expectedSha && m.digest === digest(m), '任务合同已变化');
  need(!m.imported && m.runtime, '导入包不能调用 render worker');
  for (const identity of m.adapter) checkIdentity(identity);
  need(sha256Value(runtimeIdentity(m.runtime)) === sha256Value(m.runtimeSnapshot), '运行时已变化，需新建包');
  const unlock = acquireFileLock(path.join(root, 'render.lock'), { purpose: 'creative-render' });
  let resources;
  try {
    need(!fs.existsSync(path.join(root, 'receipt.json')) && !fs.existsSync(path.join(root, 'work')), '不覆盖已有尝试；失败或返工创建新包');
    const source = treeIdentity(path.join(root, 'source')); need(source.sha256 === m.source.sha256, '冻结源已变化');
    freezeSource(source, path.join(root, 'work'));
    resources = acquireResourceLeases({ config: loadKachaConfig({ anchorPath: root, includeSecrets: false }).config, projectRoot: root, resources: ['cpuHeavy', 'videoEncode'], purpose: 'creative-render' });
    const work = path.join(root, 'work'), raw = path.join(root, m.plan.output.transparent ? 'render.mov' : 'render.mp4');
    const commands = renderCommands(m.plan, m.runtime, work, raw), logs = [], qualityChecks = [];
    for (const step of commands) {
      const log = path.join(root, `${step.name}.log`);
      const stdout = run(step.command, step.args, { cwd: step.cwd, env: { ...process.env, ...(m.runtime.modules ? { NODE_PATH: m.runtime.modules } : {}) }, log });
      const qualityCheck = validateNativeCheck(m.plan.provider, step.name, stdout);
      if (qualityCheck) qualityChecks.push(qualityCheck);
      need(!/optional file missing:|\[page\] request failed/.test(fs.readFileSync(log, 'utf8')), '原生渲染发现缺失素材；先补齐资产，不把可选回退当完整画面');
      logs.push(fileIdentity(log));
    }
    const actual = m.plan.provider === 'huashu-design' ? path.join(work, m.plan.entry.replace(/\.html$/, '.mp4')) : raw;
    need(fileIdentity(file).sha256 === expectedSha && sha256Value(runtimeIdentity(m.runtime)) === sha256Value(m.runtimeSnapshot), '渲染期间合同或运行时改变');
    return finalize(root, m, actual, { method: 'native-render', logs, qualityChecks, runtime: m.runtimeSnapshot, readingCheck: m.plan.provider === 'lemo-opuscar' ? (m.plan.textPolicy === 'no-screen-text' ? { status: 'not_applicable_declared_no_text', reason: m.plan.textCheckOmissionReason } : { status: 'native_readcheck_passed' }) : { status: 'provider_specific_checks' }, humanReview: 'not_performed' });
  } catch (error) { recordFailure(root, 'render', error); throw error; }
  finally { resources?.release(); unlock(); }
}
export function ingestCreative(plan, output, media) {
  const original = fileIdentity(fs.realpathSync(media));
  verifyCreativeVideo(original.path, plan.output, { silent: false });
  const { root, manifest } = preparePackage(plan, output, { imported: true });
  let resources;
  try {
    resources = acquireResourceLeases({ config: loadKachaConfig({ anchorPath: root, includeSecrets: false }).config, projectRoot: root, resources: ['cpuHeavy', 'videoEncode'], purpose: 'creative-ingest' });
    checkIdentity(original); return finalize(root, manifest, original.path, { method: 'external-native-output', nativeChecks: 'not_attested', humanReview: 'not_performed' });
  } catch (error) { recordFailure(root, 'ingest', error); throw error; }
  finally { resources?.release(); }
}
export function creativeStatus(directory) {
  const root = fs.realpathSync(directory), manifest = readJson(path.join(root, 'creative.json'));
  need(manifest.kind === 'kacha-creative-package' && manifest.digest === digest(manifest), 'creative 合同无效');
  if (fs.existsSync(path.join(root, 'receipt.json'))) return readCreativeReceipt(root).receipt;
  const failure = path.join(root, 'failure.json');
  if (manifest.imported || (fs.existsSync(failure) && readJson(failure).stage === 'submit')) return fs.existsSync(failure) ? readJson(failure) : { status: 'incomplete_requires_inspection', package: root, recovery: '回收尚未完成；检查执行进程与日志，不覆盖现有包' };
  return JSON.parse(run(process.execPath, [path.join(scripts, 'kacha_jobs.mjs'), 'status', '@job:creative-render', '--project-root', root]));
}
export function attachCreative({ directory, timeline, expectedSha, output, start, x = 0, y = 0, width, height, reason }) {
  const { receipt, manifest, receiptIdentity } = readCreativeReceipt(directory), input = fs.realpathSync(timeline), out = path.join(fs.realpathSync(path.dirname(path.resolve(output))), path.basename(output));
  need(manifest.plan.purpose !== 'technical-fixture', '技术测试包不能剪入真实节目；测试只验证渲染，不冒充方向批准');
  need(fileIdentity(input).sha256 === expectedSha, '原时间线已变化');
  need(path.dirname(out) === path.dirname(input) && out !== input && !fs.existsSync(out), '候选必须为原时间线同目录的新 JSON');
  need(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 500, '必须说明当前口播/画面叙事触发');
  const projection = buildTimelineProjection(input), source = assertProjectionSourceCurrent(projection, { requireDeclaredSha: true }).identity;
  const plan = readJson(input), g = manifest.plan.output;
  need(plan.output?.fps === g.fps, '帧率不一致，请按当前节目重新渲染');
  need(Number.isFinite(start) && start >= 0 && Math.abs(start * g.fps - Math.round(start * g.fps)) < 1e-6, 'start 必须为非负整帧位置');
  const end = start + g.frames / g.fps, pictureEnd = Math.max(...projection.items.filter(i => i.type === 'picture').map(i => i.endTick)) / projection.timebase.ticksPerSecond;
  need(end <= pictureEnd + 1e-6, '超出时间线，不能隐式裁短');
  width ??= g.width; height ??= g.height;
  need([x, y, width, height].every(Number.isInteger) && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= plan.output.width && y + height <= plan.output.height && width * g.height === height * g.width, '插入区域越界或改变宽高比');
  const id = `creative-${receipt.video.sha256.slice(0, 12)}-${Math.round(start * g.fps)}`;
  plan.visual ??= {}; plan.visual.overlays ??= [];
  need(!plan.visual.overlays.some(o => o.id === id), '相同素材已插入当前位置');
  plan.visual.overlays.push({ id, ...receipt.video, kind: 'video', start, end, x, y, width, height, opacity: 1, provenance: { kind: 'generated_motion', provider: manifest.plan.provider, receipt: receiptIdentity, evidence: receiptIdentity.path, purpose: reason, factualEvidence: false, review: 'required' } });
  plan.mode = 'preview'; delete plan.contracts; delete plan.review; delete plan.decisionPlan;
  plan.output = { ...plan.output, path: `${out}.preview.mp4` };
  for (const key of ['dialogueStem', 'bgmStem', 'sfxStem', 'mixStem']) delete plan.output[key];
  plan.creativeIntegration = { input: fileIdentity(input), status: 'candidate_requires_render_and_review', reason };
  for (const identity of [source, receiptIdentity, receipt.manifest, receipt.video, receipt.original, ...receipt.evidence]) checkIdentity(identity);
  need(treeIdentity(path.join(directory, 'source')).sha256 === manifest.source.sha256, '插入期间冻结源改变');
  need(fileIdentity(input).sha256 === expectedSha, '插入期间时间线改变');
  exclusive(out, plan);
  return { status: 'candidate_requires_render_and_review', candidate: fileIdentity(out), overlayId: id, render: ['timeline', 'render', '--plan', out] };
}
async function main(args) {
  const opt = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
  let result;
  if (args[0] === 'catalog') result = creativeCatalog(opt('query', ''));
  else if (args[0] === 'doctor') result = creativeDoctor();
  else if (args[0] === 'template') { result = creativeTemplate(opt('provider'), opt('project')); if (opt('output')) exclusive(opt('output'), result); }
  else if (args[0] === 'validate') result = { status: 'valid_not_rendered', ...validateCreative(readJson(opt('plan'))) };
  else if (args[0] === 'render') result = prepareCreative(readJson(opt('plan')), opt('output'));
  else if (args[0] === 'worker') result = renderCreative(opt('package'), opt('manifest-sha'));
  else if (args[0] === 'ingest') result = ingestCreative(readJson(opt('plan')), opt('output'), opt('media'));
  else if (args[0] === 'status') result = creativeStatus(opt('package'));
  else if (args[0] === 'attach') result = attachCreative({ directory: opt('package'), timeline: opt('timeline'), expectedSha: opt('expected-sha'), output: opt('output'), start: Number(opt('start')), x: Number(opt('x', 0)), y: Number(opt('y', 0)), width: opt('width') === undefined ? undefined : Number(opt('width')), height: opt('height') === undefined ? undefined : Number(opt('height')), reason: opt('reason') });
  else throw Error('creative catalog|doctor|template|validate|render|ingest|status|attach；详见 references/creative-skills.md');
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
