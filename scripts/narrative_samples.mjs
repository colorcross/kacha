#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileIdentity, readJson, sha256File, sha256Value, acquireFileLock, writeJsonAtomic, resolveRuntimeCommand } from './kacha_utils.mjs';
import { loadKachaConfig } from './kacha_config.mjs';
import { acquireResourceLeases } from './resource_pool.mjs';
import { buildTimelineProjection, assertProjectionSourceCurrent } from './timeline_projection.mjs';
import { validateJobContract } from './job_contract.mjs';
import { observeJob } from './job_runtime.mjs';
import { verifyMedia } from './wise_motion_contract.mjs';
const self = fileURLToPath(import.meta.url), scripts = path.dirname(self);
export const recipes = [
  { id: 'steps', name: '步骤拆解', use: '说明一个可执行过程；每步写明动作和结果。', fields: '2–4 个步骤，按真实操作顺序排列。', dahui: 'AI 实践、产品操作、AI 共读方法。' },
  { id: 'comparison', name: '证据对比', use: '在同一条件下并列比较；不用装饰性数值图冒充测量。', fields: '恰好 2 项，注明条件、单位与证据来源。', dahui: 'AI 测评、方案取舍；保留局限与失败。' },
  { id: 'timeline', name: '事件时间线', use: '呈现真实先后关系；日期直接写入标签，不能推断因果。', fields: '2–4 个节点，按时间排序；注明来源。', dahui: '产品迭代、访谈论证、资讯背景。' },
];
export const need = (ok, message) => { if (!ok) throw Error(message); };
export const digest = value => { const copy = structuredClone(value); delete copy.digest; return sha256Value(copy); };
const exclusive = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const text = (v, max, label) => { need(typeof v === 'string' && v.trim().length > 0 && [...v].length <= max && !/[\x00-\x1f\x7f]/.test(v), `${label}须为 1–${max} 字的单行文字`); return v.trim(); };
function invoke(command, args, timeout = 180000) {
  const r = spawnSync(resolveRuntimeCommand(command), args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  need(!r.error && r.status === 0, `${command} 失败：${r.error?.message || r.stderr || r.stdout}`); return r.stdout;
}
export function validateSampleSpec(spec) {
  need(spec && typeof spec === 'object' && !Array.isArray(spec), '样片 spec 必须为对象');
  need(Object.keys(spec).every(k => ['recipe','title','items','evidence','pack','width','height','fps','durationSeconds','fontFile'].includes(k)), '样片包含未知字段');
  const s = { pack: 'generic', width: 1280, height: 720, fps: 25, durationSeconds: 8, ...spec };
  need(recipes.some(r => r.id === s.recipe), '请选择步骤、对比或时间线配方');
  need(['generic','dahui-ai'].includes(s.pack), 'pack 必须为 generic 或 dahui-ai');
  s.title = text(s.title, 32, '标题'); s.evidence = text(s.evidence, 100, '来源 / 演示说明');
  need(Array.isArray(s.items) && s.items.length >= 2 && s.items.length <= 4 && (s.recipe !== 'comparison' || s.items.length === 2), '对比须有 2 项，其余须有 2–4 项');
  s.items = s.items.map(i => { need(i && Object.keys(i).every(k => ['label','detail'].includes(k)), '节点仅支持 label、detail'); return {label:text(i.label,24,'节点标题'),detail:text(i.detail,60,'节点说明')}; });
  need([[1280,720],[720,1280]].some(([w,h])=>s.width===w && s.height===h), '支持 1280×720 或 720×1280；不可静默拉伸');
  need([24,25,30].includes(s.fps), 'fps 支持 24/25/30');
  const readingUnits = s.items.reduce((n,i)=>n+[...i.label+i.detail].reduce((sum,c)=>sum+(c.charCodeAt(0)<128?.45:1),0),0);
  const min = Math.max(4, Math.ceil(readingUnits/6)+2);
  need(Number.isFinite(s.durationSeconds) && s.durationSeconds >= min && s.durationSeconds <= 16 && Number.isInteger(s.durationSeconds*s.fps), `时长须为 ${min}–16 秒且对齐整帧，给文字保留阅读时间`);
  if (s.fontFile !== undefined) need(typeof s.fontFile === 'string' && path.isAbsolute(s.fontFile), '字体须为已注册的绝对路径');
  return s;
}
function fontFor(s, root) {
  const registry = loadKachaConfig({ anchorPath: root, includeSecrets:false }).config.tools.fontRegistry;
  need(registry && fs.existsSync(registry), '请先配置 tools.fontRegistry 中已授权的字体');
  const records = readJson(registry).records ?? [];
  const allowed = records.filter(r => r.license?.status === 'open' || r.projectAuthorization?.status === 'authorized');
  const preferred = allowed.filter(r => (r.families ?? []).some(f => /Noto Sans|Source Han Sans|思源黑体/i.test(f)));
  const record = s.fontFile ? allowed.find(r => r.file === s.fontFile) : preferred.find(r => r.weightClass >= 400 && r.weightClass <= 600) ?? preferred[0] ?? allowed[0];
  need(record && fs.existsSync(record.file) && sha256File(record.file) === record.sha256, '授权字体缺失或身份已改变；不会静默替换');
  return { ...fileIdentity(record.file), registry:fileIdentity(registry), authorization:record.projectAuthorization?.status ?? record.license.status, family:record.families?.[0] ?? '' };
}
function implementation() { return sha256Value(['narrative_samples.mjs','narrative_frames.py'].map(f => ({file:f,sha:sha256File(path.join(scripts,f))}))); }
function runtimeIdentity() {
  return sha256Value({ python:invoke('python3',['-c','import sys,PIL,fontTools;print(sys.version);print(PIL.__version__);print(fontTools.__version__)']).trim(), encoder:invoke('ffmpeg',['-version']).split('\n').slice(0,3) });
}
function checkFile(f) { need(f?.path && f.sha256 === sha256File(f.path), `文件已改变：${f?.path}`); }
function manifestAt(directory) {
  const root = fs.realpathSync(directory), manifest = readJson(path.join(root,'samples.json'));
  need(manifest.kind === 'kacha-narrative-samples' && manifest.digest === digest(manifest), '样片合同损坏'); validateSampleSpec(manifest.spec);
  need(JSON.stringify(manifest.variants)===JSON.stringify(['overview','guided']) && manifest.frames===manifest.spec.fps*manifest.spec.durationSeconds,'样片变体或帧数合同无效');
  need(manifest.runtime===runtimeIdentity(),'渲染依赖版本已变化，请创建新样片');
  need(manifest.implementation === implementation(), '样片生成实现已改变，请创建新候选包');
  checkFile(manifest.font); checkFile(manifest.font.registry);
  return { root, manifest };
}
export function prepareSamples({ spec, output }) {
  const s = validateSampleSpec(spec); need(typeof output === 'string' && path.isAbsolute(output), '新样片目录须为绝对路径');
  const font = fontFor(s, output);
  // Validate glyph coverage and geometry before creating a persistent job.
  invoke('python3', [path.join(scripts,'narrative_frames.py'),'check',JSON.stringify({spec:s,font})]);
  fs.mkdirSync(path.dirname(output),{recursive:true}); fs.mkdirSync(output);
  const root=fs.realpathSync(output);
  const m={kind:'kacha-narrative-samples',schemaVersion:'1.0',spec:s,font,implementation:implementation(),runtime:runtimeIdentity(),variants:['overview','guided'],frames:s.fps*s.durationSeconds}; m.digest=digest(m);
  exclusive(path.join(root,'samples.json'),m);
  const job=JSON.parse(invoke(process.execPath,[path.join(scripts,'kacha_jobs.mjs'),'submit','--project-root',root,'--id','samples-render','--kind','narrative-render','--expected-output',path.join(root,'receipt.json'),'--',process.execPath,path.join(scripts,'run_telemetry.mjs'),'run','--project-root',root,'--stage','narrative-samples','--operation-id',m.digest,'--mode','preview','--render-scope','range','--video-encodes','2','--rendered-seconds',String(s.durationSeconds*2),'--artifact',path.join(root,'receipt.json'),'--',process.execPath,self,'worker','--package',root,'--manifest-sha',sha256File(path.join(root,'samples.json'))]));
  return { status:'queued', package:root, digest:m.digest, job };
}
export function renderSamples(directory, expectedSha) {
  const {root,manifest:m}=manifestAt(directory), file=path.join(root,'samples.json');
  need(sha256File(file)===expectedSha,'提交后样片内容已改变');
  const unlock=acquireFileLock(path.join(root,'render.lock'),{purpose:'narrative-samples'}); let resources;
  try {
    need(!fs.existsSync(path.join(root,'receipt.json')),'不能覆盖已生成的样片');
    resources=acquireResourceLeases({config:loadKachaConfig({anchorPath:root,includeSecrets:false}).config,projectRoot:root,resources:['cpuHeavy','videoEncode'],purpose:'narrative-samples'});
    const entries=[];
    for(const variant of m.variants) {
      const output=path.join(root,`${variant}.mp4`);
      need(!fs.existsSync(output),'存在未确认产物；请创建新包或按 jobs 恢复');
      invoke('python3',[path.join(scripts,'narrative_frames.py'),'render',JSON.stringify(m),variant,output,resolveRuntimeCommand('ffmpeg')],300000);
      const media=verifyMedia(output,{...m.spec,frames:m.frames});
      invoke('ffmpeg',['-v','error','-xerror','-i',output,'-f','null','-']);
      entries.push({id:variant,name:variant==='overview'?'全局并列':'逐项聚焦',video:fileIdentity(output),media});
    }
    manifestAt(root); need(sha256File(file)===expectedSha,'渲染期间输入已改变');
    const receipt={kind:'kacha-narrative-render',manifest:fileIdentity(file),entries,status:'rendered_requires_review'}; receipt.digest=digest(receipt);
    exclusive(path.join(root,'receipt.json'),receipt); return sampleStatus(root);
  } finally { resources?.release(); unlock(); }
}
export function sampleStatus(directory) {
  const {root,manifest:m}=manifestAt(directory), receiptFile=path.join(root,'receipt.json');
  if(!fs.existsSync(receiptFile)) {
    const file=path.join(root,'.kacha/jobs/samples-render/job.json');
    if(!fs.existsSync(file)) return {status:'submission_interrupted',package:root,digest:m.digest,ready:false,error:'提交中断；先核对 jobs，不自动重复生成'};
    const job=readJson(file); need(validateJobContract(file,job).length===0,'任务记录失效');
    const state=observeJob(job); return {status:state.status,package:root,digest:m.digest,ready:false,error:state.error,recovery:state.recovery};
  }
  const r=readJson(receiptFile);
  need(r.kind==='kacha-narrative-render' && r.digest===digest(r) && r.manifest.path===path.join(root,'samples.json') && r.entries?.length===2,'样片回执失效'); checkFile(r.manifest);
  for (const [i,e] of r.entries.entries()) { need(e.id===m.variants[i] && e.video.path===path.join(root,`${e.id}.mp4`),'样片路径失效'); checkFile(e.video); }
  let selection=null;
  if(fs.existsSync(path.join(root,'selection.json'))) {
    selection=readJson(path.join(root,'selection.json'));
    need(selection.digest===digest(selection) && selection.manifestDigest===m.digest && selection.receiptSha===sha256File(receiptFile) && r.entries.some(e=>e.id===selection.variant && e.video.sha256===selection.videoSha),'选择记录已失效，请重新选择');
  }
  return {status:r.status,ready:true,package:root,digest:m.digest,receiptSha:sha256File(receiptFile),spec:m.spec,entries:r.entries,selection};
}
export function selectSample({directory,variant,expectedDigest,expectedSelection=null,reason}) {
  const root=fs.realpathSync(directory), unlock=acquireFileLock(path.join(root,'selection.lock'),{purpose:'sample-selection'});
  try {
    const s=sampleStatus(root); need(s.ready && s.digest===expectedDigest,'候选已改变，请重新读取');
    need((s.selection?.digest??null)===expectedSelection,'选择已被其他窗口更新，请重新读取');
    const entry=s.entries.find(e=>e.id===variant); need(entry,'候选不存在');
    const selection={variant,manifestDigest:s.digest,receiptSha:s.receiptSha,videoSha:entry.video.sha256,reason:text(reason,250,'选择理由'),status:'direction_selected_not_approved'}; selection.digest=digest(selection);
    writeJsonAtomic(path.join(root,'selection.json'),selection); return sampleStatus(root);
  } finally {unlock();}
}
export function inspectSampleTarget(timeline) {
  const input=fs.realpathSync(timeline), identity=fileIdentity(input), projection=buildTimelineProjection(input);
  assertProjectionSourceCurrent(projection,{requireDeclaredSha:true});
  const plan=readJson(input);
  need(sha256File(input)===identity.sha256,'读取期间时间线已改变');
  return {identity,width:plan.output?.width,height:plan.output?.height,fps:plan.output?.fps,durationSeconds:Math.max(...projection.items.filter(i=>i.type==='picture').map(i=>i.endTick))/projection.timebase.ticksPerSecond};
}
export function attachSample({directory,timeline,expectedSha,expectedSelection,output,start,reason}) {
  const s=sampleStatus(directory); need(s.ready && s.selection?.digest===expectedSelection,'先选择当前候选并绑定选择摘要');
  const entry=s.entries.find(e=>e.id===s.selection.variant), input=fs.realpathSync(timeline), out=path.resolve(output);
  need(sha256File(input)===expectedSha,'时间线已变化，请重新读取');
  need(path.dirname(out)===path.dirname(input) && out!==input && !fs.existsSync(out),'候选须为原时间线同目录的新文件');
  const projection=buildTimelineProjection(input), source=assertProjectionSourceCurrent(projection,{requireDeclaredSha:true}).identity;
  const plan=readJson(input), fps=plan.output?.fps;
  need(source && fps===s.spec.fps && plan.output.width===s.spec.width && plan.output.height===s.spec.height,'画幅、帧率须与样片一致，主源须绑定 SHA');
  need(Number.isFinite(start)&&start>=0&&Math.abs(start*fps-Math.round(start*fps))<1e-6,'插入时间须对齐整帧');
  const end=start+s.spec.durationSeconds, pictureEnd=Math.max(...projection.items.filter(i=>i.type==='picture').map(i=>i.endTick))/projection.timebase.ticksPerSecond;
  need(end<=pictureEnd+1e-6,'样片超出主片时长；请调整位置或重做短版');
  const purpose=text(reason,250,'叙事触发'), id=`sample-${entry.video.sha256.slice(0,12)}-${Math.round(start*fps)}`;
  plan.visual??={}; plan.visual.overlays??=[]; need(!plan.visual.overlays.some(o=>o.id===id),'同一位置已有该样片');
  plan.visual.overlays.push({id,...entry.video,kind:'video',start,end,x:0,y:0,width:s.spec.width,height:s.spec.height,opacity:1,provenance:{kind:'generated_motion',provider:'kacha-narrative',purpose,factualEvidence:false,review:'required',selection:fileIdentity(path.join(s.package,'selection.json')),receipt:fileIdentity(path.join(s.package,'receipt.json'))}});
  plan.mode='preview'; delete plan.contracts; delete plan.decisionPlan; delete plan.review;
  plan.output={...plan.output,path:`${out}.preview.mp4`}; for(const k of ['dialogueStem','bgmStem','sfxStem','mixStem'])delete plan.output[k];
  checkFile(source); need(sha256File(input)===expectedSha && sampleStatus(directory).selection.digest===expectedSelection,'插入期间输入已改变'); exclusive(out,plan);
  return {status:'candidate_requires_render_and_review',candidate:fileIdentity(out),original:fileIdentity(input)};
}
if(process.argv[1] && path.resolve(process.argv[1])===self) {
  const args=process.argv.slice(2), opt=(name)=>{const i=args.indexOf(`--${name}`);return i<0?undefined:args[i+1];};
  try { let result;
    if(args[0]==='recipes')result={recipes};
    else if(args[0]==='render')result=prepareSamples({spec:readJson(opt('spec')),output:opt('output')});
    else if(args[0]==='worker')result=renderSamples(opt('package'),opt('manifest-sha'));
    else if(args[0]==='status')result=sampleStatus(opt('package'));
    else if(args[0]==='select')result=selectSample({directory:opt('package'),variant:opt('variant'),expectedDigest:opt('expected-digest'),expectedSelection:opt('expected-selection')??null,reason:opt('reason')});
    else if(args[0]==='attach')result=attachSample({directory:opt('package'),timeline:opt('timeline'),expectedSha:opt('expected-sha'),expectedSelection:opt('expected-selection'),output:opt('output'),start:Number(opt('start')),reason:opt('reason')});
    else throw Error('samples recipes|render --spec FILE --output DIR|status|select|attach；见 references/narrative-samples.md');
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
