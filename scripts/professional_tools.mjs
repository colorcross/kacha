#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileIdentity, readJson, sha256Value, acquireFileLock, ffprobe } from './kacha_utils.mjs';
import { buildTimelineProjection, assertProjectionSourceCurrent } from './timeline_projection.mjs';

import { acquireResourceLeases } from './resource_pool.mjs';
import { loadKachaConfig } from './kacha_config.mjs';

const self = fileURLToPath(import.meta.url), scripts = path.dirname(self);
const definitions = {
  'after-effects': { ids: ['com.adobe.AfterEffects'], route: 'jsx-aerender' },
  jianying: { ids: ['com.lemon.lvpro'], route: 'supervised-ui-media-kit' },
  capcut: { ids: ['com.lemon.lvoverseas'], route: 'supervised-ui-media-kit' },
};
const digest = value => { const copy = structuredClone(value); delete copy.digest; return sha256Value(copy); };
const required = (value, label) => { if (!value) throw Error(`${label} 必填`); return value; };
function invoke(command, argv, timeout = 120000) {
  const r = spawnSync(command, argv, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error(`${path.basename(command)} 失败：${r.error?.message ?? r.stderr ?? r.stdout}`);
  return r.stdout;
}
function exclusive(file, value) { fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function checkIdentity(value) {
  if (!value?.path || !value.sha256 || fileIdentity(value.path).sha256 !== value.sha256) throw Error(`文件身份变化：${value?.path}`);
}
function toolDefinition(tool) { return definitions[tool] ?? (() => { throw Error(`未知工具：${tool}`); })(); }
function plists(root, depth = 0) {
  if (depth > 3 || !fs.existsSync(root)) return [];
  if (root.endsWith('.app')) return [path.join(root, 'Contents', 'Info.plist')];
  return fs.readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).flatMap(x => plists(path.join(root, x.name), depth + 1));
}
export function detectProfessionalTools(roots = ['/Applications', path.join(os.homedir(), 'Applications')]) {
  const apps = [];
  if (process.platform === 'darwin') for (const root of roots) for (const file of plists(path.resolve(root))) {
    if (!fs.existsSync(file)) continue;
    try {
      const info = JSON.parse(invoke('plutil', ['-convert', 'json', '-o', '-', file], 5000));
      const entry = Object.entries(definitions).find(([, d]) => d.ids.includes(info.CFBundleIdentifier));
      if (!entry) continue;
      const appPath = path.dirname(path.dirname(file));
      const render = [path.join(appPath, 'Contents', 'MacOS', 'aerender'), path.join(path.dirname(appPath), 'aerender')].find(p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } });
      apps.push({ tool: entry[0], path: appPath, version: String(info.CFBundleShortVersionString ?? info.CFBundleVersion ?? ''), bundleId: info.CFBundleIdentifier, aerender: render ?? null });
    } catch { /* Unreadable bundles are not evidence of availability. */ }
  }
  return { schemaVersion: '1.0', platform: process.platform, searchedRoots: roots.map(x => path.resolve(x)), applications: Object.entries(definitions).map(([tool, d]) => ({ tool, route: d.route, installations: apps.filter(a => a.tool === tool), installed: apps.some(a => a.tool === tool), applicationRoundtrip: 'not_verified' })), boundary: '发现安装不等于脚本、界面或真实往返已验证；当前自动发现支持 macOS。' };
}
function probe(file) {
  const data = ffprobe(file), videos = data.streams.filter(s => s.codec_type === 'video');
  if (videos.length !== 1) throw Error('需要且只允许一条视频轨');
  const video = videos[0], audio = data.streams.filter(s => s.codec_type === 'audio');
  const ratio = value => { const [a, b = 1] = String(value).split('/').map(Number); return a / b; };
  if (Math.abs(Number(video.start_time ?? 0)) > 0.00001) throw Error('视频起点非零，需先规范化时间基准');
  const rotation = Number(video.tags?.rotate ?? video.side_data_list?.find(x => x.rotation !== undefined)?.rotation ?? 0);
  if (rotation % 360 || !['1:1', undefined, 'N/A'].includes(video.sample_aspect_ratio)) throw Error('专业工具桥接当前要求已规范化的旋转和方形像素');
  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer)) throw Error('HDR 需独立色彩管理验收，当前桥接不自动转换');
  if (audio.length > 1) throw Error('多音轨源需先明确混音合同');
  return { width: video.width, height: video.height, fps: ratio(video.avg_frame_rate), duration: Number(video.duration ?? data.format.duration), audio: audio.length === 1, channels: audio[0]?.channels ?? 0, audioStart: audio[0] ? Number(audio[0].start_time ?? 0) : null, audioDuration: audio[0] ? Number(audio[0].duration) : null, color: video.color_transfer ?? null };
}
function assertFrameCadence(file, fps) {
  // Average fps cannot establish CFR: a VFR stream can have the same frame count.
  const rows = invoke('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file], 300000).trim().split(/\r?\n/).filter(line => line.trim());
  if (!rows.length || !Number.isFinite(fps) || fps <= 0) throw Error('无法验证视频逐帧时间戳');
  for (let i = 0; i < rows.length; i++) {
    const pts = Number(rows[i].split(',')[0]);
    if (!Number.isFinite(pts) || Math.abs(pts - i / fps) > 0.0001) throw Error('VFR 或不连续帧时间戳不受支持；需先明确规范化时间基准');
  }
}
function validateAssembly(file, title) {
  const identity = fileIdentity(file), t = readJson(file);
  const projection = buildTimelineProjection(file);
  const source = assertProjectionSourceCurrent(projection, { requireDeclaredSha: true }).identity;
  if (!source) throw Error('需要一个已绑定 SHA 的主视频源');
  const unsupported = [];
  for (const field of ['visual', 'audio', 'transitions', 'subtitles', 'motion', 'effects', 'timebase']) {
    const v = t[field];
    if (v && (typeof v !== 'object' || Object.keys(v).some(k => !Array.isArray(v[k]) || v[k].length))) unsupported.push(field);
  }
  if (unsupported.length) throw Error(`当前仅支持基础 EDL 装配；不能丢弃这些层：${unsupported.join(', ')}。请先准备单独的基础片段工程。`);
  const media = probe(source.path), fps = Number(t.output?.fps), width = Number(t.output?.width), height = Number(t.output?.height);
  if (![fps, width, height].every(Number.isFinite) || fps <= 0 || fps > 120 || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || width % 2 || height % 2) throw Error('输出几何或帧率无效');
  if (Math.abs(media.fps - fps) > 0.0001 || media.width !== width || media.height !== height) throw Error('桥接要求源与输出几何/帧率相同；不隐式缩放或变速');
  assertFrameCadence(source.path, fps);
  let cursor = 0;
  const ids = new Set();
  const clips = t.edl.map((c, i) => {
    if (Object.keys(c).some(k => !['id', 'sourceStart', 'sourceEnd'].includes(k))) throw Error('EDL 含未支持的扩展字段');
    const a = Number(c.sourceStart), b = Number(c.sourceEnd), startFrame = Math.round(a * fps), endFrame = Math.round(b * fps);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a * fps - startFrame) > 0.00001 || Math.abs(b * fps - endFrame) > 0.00001 || a < 0 || endFrame <= startFrame || b > media.duration + 0.0001 || !c.id || ids.has(c.id)) throw Error('EDL 区间、整帧边界或 ID 无效');
    ids.add(c.id);
    const out = { id: c.id, sourceStart: a, sourceEnd: b, frames: endFrame - startFrame, outputStartFrame: cursor, file: `media/${String(i + 1).padStart(4, '0')}.mov` };
    cursor += out.frames; return out;
  });
  if (!clips.length || cursor / fps > 3600) throw Error('装配需为 0–60 分钟的非空节目');
  if (title && (typeof title !== 'string' || title.length > 200)) throw Error('标题必须为 1–200 字文本');
  checkIdentity(identity); checkIdentity(source);
  return { timeline: identity, source, projectId: t.projectId ?? 'kacha', media, output: { width, height, fps, frames: cursor, duration: cursor / fps }, clips, title: title ?? null };
}
export function aeScript(m) {
  const data = JSON.stringify({ ...m.output, clips: m.clips, title: m.title, digest: m.digest }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `// Generated by Kacha. Run via File > Scripts > Run Script File in an EMPTY project.\n(function(){\nvar spec=${data};\nvar root=new File($.fileName).parent;\nvar output=new File(root.fsName+'/assembly.aep');\nif(output.exists) throw new Error('Refuse to overwrite assembly.aep');\nif(!app.project || app.project.numItems!==0 || app.project.file) throw new Error('Open an empty unsaved project first; existing work is protected');\nfor(var i=0;i<spec.clips.length;i++) if(!new File(root.fsName+'/'+spec.clips[i].file).exists) throw new Error('Missing staged media');\napp.beginUndoGroup('Kacha assembly');\ntry {\nvar comp=app.project.items.addComp('Kacha assembly',spec.width,spec.height,1,spec.duration,spec.fps);\nfor(var i=0;i<spec.clips.length;i++){\nvar clip=spec.clips[i];var footage=app.project.importFile(new ImportOptions(new File(root.fsName+'/'+clip.file)));\nvar layer=comp.layers.add(footage);layer.name=clip.id;layer.startTime=clip.outputStartFrame/spec.fps;layer.inPoint=layer.startTime;layer.outPoint=layer.startTime+clip.frames/spec.fps;\ncomp.markerProperty.setValueAtTime(layer.startTime,new MarkerValue(clip.id));\n}\nif(spec.title){\nvar text=comp.layers.addText(spec.title);var p=text.property('ADBE Text Properties').property('ADBE Text Document');var d=p.value;d.fontSize=spec.height*0.06;d.fillColor=[1,1,1];p.setValue(d);\ntext.property('ADBE Transform Group').property('ADBE Position').setValue([spec.width*0.08,spec.height*0.15]);\nvar opacity=text.property('ADBE Transform Group').property('ADBE Opacity');opacity.setValueAtTime(0,0);opacity.setValueAtTime(Math.min(0.3,spec.duration/4),100);text.outPoint=Math.min(3,spec.duration);\n}\nvar q=app.project.renderQueue.items.add(comp);q.outputModule(1).file=new File(root.fsName+'/render.mov');\nvar templates=q.outputModule(1).templates;app.project.save(output);\nvar receipt=new File(root.fsName+'/ae-receipt.json');receipt.encoding='UTF-8';if(!receipt.open('w')) throw new Error('Cannot write receipt; check AE script file access setting');\n// ExtendScript may not provide JSON.stringify. Encode only strings with a local encoder.\nfunction quote(v){return '"'+String(v).replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"').replace(/\\r/g,'\\\\r').replace(/\\n/g,'\\\\n').replace(/\\t/g,'\\\\t')+'"';}\nvar ts=[];for(var j=0;j<templates.length;j++) ts.push(quote(templates[j]));\nreceipt.write('{"packageDigest":'+quote(spec.digest)+',"version":'+quote(app.version)+',"project":'+quote(output.fsName)+',"comp":"Kacha assembly","outputModules":['+ts.join(',')+']}');receipt.close();comp.openInViewer();\n}finally{app.endUndoGroup();}\n})();\n`;
}
function loadPackage(directory, staged = false) {
  const root = fs.realpathSync(required(directory, 'package')), m = readJson(path.join(root, 'package.json'));
  if (m.kind !== 'kacha-professional-tools-package' || m.digest !== digest(m)) throw Error('专业工具包合同失效');
  toolDefinition(m.tool); checkIdentity(m.timeline); checkIdentity(m.source);
  const facts = validateAssembly(m.timeline.path, m.title);
  if (sha256Value(facts.clips) !== sha256Value(m.clips) || sha256Value(facts.output) !== sha256Value(m.output) || facts.source.path !== m.source.path) throw Error('工具包几何、片段或路径与原时间线不匹配');
  if (staged) {
    const s = readJson(path.join(root, 'staged.json'));
    if (s.packageDigest !== m.digest || s.status !== 'pass') throw Error('素材包未完成');
    for (const c of m.clips) {
      const artifact = s.files.find(f => f.path === path.join(root, c.file));
      if (!artifact) throw Error('缺少片段身份'); checkIdentity(artifact);
    }
    if (m.tool === 'after-effects') checkIdentity(s.script);
  }
  return { root, m };
}
function submit(root, id, kind, expected, argv) {
  return JSON.parse(invoke(process.execPath, [path.join(scripts, 'kacha_jobs.mjs'), 'submit', '--project-root', root, '--id', id, '--kind', kind, '--expected-output', expected, '--', ...argv]));
}
export function prepareProfessionalPackage({ timeline, tool, output, title } = {}) {
  toolDefinition(tool); const t = fs.realpathSync(required(timeline, 'timeline'));
  const facts = validateAssembly(t, title), root = path.resolve(required(output, 'output'));
  fs.mkdirSync(path.dirname(root), { recursive: true }); fs.mkdirSync(root); // refuses existing package
  const m = { schemaVersion: '1.0', kind: 'kacha-professional-tools-package', tool, createdAt: new Date().toISOString(), ...facts, applicationVerified: false };
  m.digest = digest(m);
  exclusive(path.join(root, 'package.json'), m);
  const job = submit(root, 'stage', 'professional-tool-stage', path.join(root, 'staged.json'), [process.execPath, self, 'stage', '--package', root]);
  return { status: 'queued', package: root, packageDigest: m.digest, job, applicationVerified: false };
}
export function stageProfessionalPackage(directory) {
  const { root, m } = loadPackage(directory);
  const unlock = acquireFileLock(path.join(root, 'stage.lock'), { purpose: 'professional-tool-stage' });
  let resources;
  try {
    resources = acquireResourceLeases({ config: loadKachaConfig({ anchorPath: m.timeline.path, includeSecrets: false }).config, projectRoot: root, resources: ['cpuHeavy', 'videoEncode'], purpose: 'professional-tool-stage' });
    if (fs.existsSync(path.join(root, 'staged.json'))) { loadPackage(root, true); return readJson(path.join(root, 'staged.json')); }
    fs.mkdirSync(path.join(root, 'media'), { recursive: true });
    if (fs.realpathSync(path.join(root, 'media')) !== path.join(root, 'media')) throw Error('media 目录不能是符号链接');
    for (const c of m.clips) {
      const dest = path.join(root, c.file);
      // Existing incomplete files are never trusted or silently overwritten on resume.
      if (fs.existsSync(dest)) throw Error(`准备产物已存在但无完整回执；保留并建立新包：${dest}`);
      const args = ['-nostdin', '-v', 'error', '-n', '-i', m.source.path, '-vf', `trim=start=${c.sourceStart}:end=${c.sourceEnd},setpts=PTS-STARTPTS`, '-map', '0:v:0', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-r', String(m.output.fps), '-frames:v', String(c.frames)];
      if (m.media.audio) args.push('-map', '0:a:0', '-af', `aresample=48000:async=0:first_pts=0,apad,atrim=start=${c.sourceStart}:end=${c.sourceEnd},asetpts=PTS-STARTPTS`, '-c:a', 'pcm_s24le', '-ar', '48000');
      else args.push('-an');
      args.push(dest); invoke('ffmpeg', args, Math.max(120000, Math.ceil(c.frames / m.output.fps * 30000)));
      const stagedMedia = probe(dest);
      assertAudioCoverage(stagedMedia, c.frames / m.output.fps, m.output.fps);
      const count = JSON.parse(invoke('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', dest]));
      if (Number(count.streams?.[0]?.nb_read_frames) !== c.frames) throw Error('准备片段帧数不匹配');
    }
    checkIdentity(m.timeline); checkIdentity(m.source);
    const script = m.tool === 'after-effects' ? path.join(root, 'assembly.jsx') : null;
    if (script) exclusive(script, aeScript(m));
    exclusive(path.join(root, '导入说明.md'), `# ${m.tool} 素材包\n\n按 media/0001.mov 起的文件顺序导入；${m.output.width}×${m.output.height}，${m.output.fps} fps，共 ${m.output.frames} 帧。所有片段均从 0 开始，不要重复按原始入点裁剪。\n\n${script ? '在 AE 的空白未保存工程中运行 assembly.jsx；保留 AEP，确认字体及标题，正常速度带声音审阅后再渲染。脚本不更改权限设置。' : '用当前应用界面导入素材并按顺序排列；保存独立工程，导出完整节目。此包不是剪映私有草稿，未声称支持 XML。'}\n\n原工程只读。导出须保持尺寸、帧率、总帧数和音轨。通过 pro-tools receive 回收独立候选；自动检查不代表人工终审。\n`);
    const result = { status: 'pass', packageDigest: m.digest, files: m.clips.map(c => fileIdentity(path.join(root, c.file))), script: script ? fileIdentity(script) : null, applicationVerified: false };
    exclusive(path.join(root, 'staged.json'), result); return result;
  } finally { resources?.release(); unlock(); }
}
export function professionalPackageStatus(directory, roots) {
  const { root, m } = loadPackage(directory);
  const job = JSON.parse(invoke(process.execPath, [path.join(scripts, 'kacha_jobs.mjs'), 'status', '@job:stage', '--project-root', root]));
  const staged = fs.existsSync(path.join(root, 'staged.json'));
  if (staged) loadPackage(root, true);
  const state = job.job?.status ?? job.status;
  const terminal = ['failed', 'cancelled', 'cancellation_failed', 'interrupted', 'succeeded'].includes(state);
  return { status: staged ? 'prepared_requires_application' : terminal ? (state === 'succeeded' ? 'incomplete' : state) : 'preparing', package: root, job, applications: detectProfessionalTools(roots), applicationVerified: false, next: staged ? '在目标应用导入并验证；导出后 receive' : terminal ? '任务已结束但未形成可用素材包；检查日志，保留产物，修复原因后新建包' : '通过 jobs status/cancel 检查运行任务' };
}
export function renderProfessionalPackage(directory, outputModule, roots) {
  const { root, m } = loadPackage(directory, true);
  if (m.tool !== 'after-effects') throw Error('该工具没有已验证的原生渲染 CLI；使用受监督界面导出');
  const apps = detectProfessionalTools(roots).applications.find(a => a.tool === m.tool).installations;
  if (apps.length !== 1 || !apps[0].aerender) throw Error('需要唯一明确的 AE 安装及 aerender；可用 --apps-root 指定应用目录');
  const receipt = readJson(path.join(root, 'ae-receipt.json'));
  if (receipt.packageDigest !== m.digest || receipt.project !== path.join(root, 'assembly.aep') || receipt.comp !== 'Kacha assembly' || !receipt.outputModules?.includes(required(outputModule, 'output-module'))) throw Error('AE 回执、工程或输出模块不匹配');
  if (String(receipt.version).split('.').slice(0, 2).join('.') !== apps[0].version.split('.').slice(0, 2).join('.')) throw Error('AE 应用版本与建工程版本不同，需重新验证');
  const project = fileIdentity(receipt.project), frozen = path.join(root, `render-input-${project.sha256}.aep`), output = path.join(root, 'render.mov');
  if (fs.existsSync(output)) throw Error('拒绝覆盖既有 render.mov');
  if (!fs.existsSync(frozen)) fs.copyFileSync(project.path, frozen, fs.constants.COPYFILE_EXCL);
  if (fileIdentity(frozen).sha256 !== project.sha256) throw Error('冻结工程身份不一致');
  const intent = { packageDigest: m.digest, project: fileIdentity(frozen), executable: fileIdentity(apps[0].aerender), outputModule, output };
  const intentFile = path.join(root, 'render-intent.json'); exclusive(intentFile, intent);
  const job = submit(root, 'ae-render', 'professional-tool-render', output, [process.execPath, self, 'render-worker', '--package', root, '--intent-sha', fileIdentity(intentFile).sha256]);
  return { status: 'queued', job, project, application: apps[0], applicationVerified: false };
}
export function renderProfessionalWorker(directory, intentSha) {
  const { root, m } = loadPackage(directory, true), intent = readJson(path.join(root, 'render-intent.json'));
  if (!intentSha || fileIdentity(path.join(root, 'render-intent.json')).sha256 !== intentSha) throw Error('渲染意图身份变化');
  if (intent.packageDigest !== m.digest || intent.output !== path.join(root, 'render.mov')) throw Error('渲染意图失效');
  checkIdentity(intent.project); checkIdentity(intent.executable);
  if (fs.existsSync(intent.output)) throw Error('拒绝覆盖既有渲染产物');
  const resources = acquireResourceLeases({ config: loadKachaConfig({ anchorPath: m.timeline.path, includeSecrets: false }).config, projectRoot: root, resources: ['cpuHeavy', 'videoEncode'], purpose: 'professional-tool-render' });
  try {
    invoke(intent.executable.path, ['-project', intent.project.path, '-comp', 'Kacha assembly', '-OMtemplate', intent.outputModule, '-output', intent.output], 3600000);
    checkIdentity(intent.project); loadPackage(root, true);
    return { status: 'rendered_requires_receive', output: fileIdentity(intent.output) };
  } finally { resources.release(); }
}
function assertAudioCoverage(media, duration, fps) {
  if (media.audio && (!Number.isFinite(media.audioDuration) || !Number.isFinite(media.audioStart) || Math.abs(media.audioStart) > 1 / fps + 0.001 || Math.abs(media.audioDuration - duration) > 1 / fps + 0.001)) throw Error('音轨起点或完整时长不匹配');
}
export function receiveProfessionalResult({ directory, media, output } = {}) {
  const { root, m } = loadPackage(directory, true);
  const resultFile = fs.realpathSync(required(media, 'media')), resultIdentity = fileIdentity(resultFile);
  if (resultFile === m.source.path || m.clips.some(c => resultFile === path.join(root, c.file))) throw Error('不能把源片或单个准备片段作为外部输出回收');
  const actual = probe(resultFile), expected = m.output;
  if (actual.width !== expected.width || actual.height !== expected.height || Math.abs(actual.fps - expected.fps) > 0.0001 || Math.abs(actual.duration - expected.duration) > 1 / expected.fps + 0.001 || actual.audio !== m.media.audio || actual.channels !== m.media.channels) throw Error('外部结果几何、帧率、时长或音轨不匹配');
  assertAudioCoverage(actual, expected.duration, expected.fps);
  assertFrameCadence(resultFile, expected.fps);
  const counted = JSON.parse(invoke('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', resultFile], 300000));
  if (Number(counted.streams?.[0]?.nb_read_frames) !== expected.frames) throw Error('外部结果总帧数不匹配');
  invoke('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', resultFile, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], 300000);
  checkIdentity(resultIdentity); loadPackage(root, true);
  const dest = path.resolve(required(output, 'output'));
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.mkdirSync(dest);
  try {
    const stored = path.join(dest, 'external-result' + path.extname(resultFile));
    fs.copyFileSync(resultFile, stored, fs.constants.COPYFILE_EXCL);
    const storedIdentity = fileIdentity(stored); if (storedIdentity.sha256 !== resultIdentity.sha256) throw Error('复制时外部产物发生变化');
    checkIdentity(resultIdentity); loadPackage(root, true);
    const candidate = { schemaVersion: '1.0', projectId: `${m.projectId}-external-candidate`, mode: 'preview', source: storedIdentity, edl: [{ id: 'external-program', sourceStart: 0, sourceEnd: expected.duration }], output: { width: expected.width, height: expected.height, fps: expected.fps, path: path.join(dest, 'candidate-preview.mp4') }, externalTool: { package: fileIdentity(path.join(root, 'package.json')), originalTimeline: m.timeline, tool: m.tool, status: 'technical_candidate_requires_review', flattened: true } };
    exclusive(path.join(dest, 'candidate.timeline.json'), candidate);
    const report = { status: 'technical_candidate_requires_review', packageDigest: m.digest, originalTimeline: m.timeline, received: storedIdentity, candidate: fileIdentity(path.join(dest, 'candidate.timeline.json')), technicalChecks: { decoded: true, frames: expected.frames, geometry: true, audioPresenceAndChannels: true, audioTimeCoverage: true }, applicationVerified: false, reviewRequired: ['source_content', 'normal_speed_with_audio', 'fonts_and_visuals', 'final_mix', 'current_project_contracts'] };
    exclusive(path.join(dest, 'receipt.json'), report); return report;
  } catch (e) {
    // Quarantine this new output directory; never remove user input or the base timeline.
    exclusive(path.join(dest, 'FAILED.txt'), String(e.message)); throw e;
  }
}
function option(args, name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
function main(args) {
  const command = args[0], roots = option(args, '--apps-root') ? [option(args, '--apps-root')] : undefined;
  let result;
  if (command === 'detect') result = detectProfessionalTools(roots);
  else if (command === 'prepare') result = prepareProfessionalPackage({ timeline: option(args, '--timeline'), tool: option(args, '--tool'), output: option(args, '--output'), title: option(args, '--title') });
  else if (command === 'stage') result = stageProfessionalPackage(option(args, '--package'));
  else if (command === 'status') result = professionalPackageStatus(option(args, '--package'), roots);
  else if (command === 'render-worker') result = renderProfessionalWorker(option(args, '--package'), option(args, '--intent-sha'));
  else if (command === 'render') result = renderProfessionalPackage(option(args, '--package'), option(args, '--output-module'), roots);
  else if (command === 'receive') result = receiveProfessionalResult({ directory: option(args, '--package'), media: option(args, '--media'), output: option(args, '--output') });
  else throw Error('用法：pro-tools detect|prepare|status|render|receive；参见 references/professional-tools.md');
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) { try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; } }
