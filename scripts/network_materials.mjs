#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileIdentity, fileIdentityMatches, mediaSummary, visualMediaDuration, readJson, sha256File, sha256Value, writeJsonAtomic } from './kacha_utils.mjs';
import { buildTimelineProjection } from './timeline_projection.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const need = (condition, message) => { if (!condition) throw new Error(message); };
const identity = (value, label) => {
  need(value?.path && /^[a-f0-9]{64}$/.test(value.sha256 ?? '') && fileIdentityMatches(value.path, value), `${label}身份已变化或缺失`);
};
const webUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } };
function narrativeDigest(projection) {
  const timeline=readJson(projection.timeline.path);
  const dialogue=timeline.audio?.dialogue;
  const dialoguePath=dialogue && path.resolve(path.dirname(projection.timeline.path),typeof dialogue === 'string' ? dialogue : dialogue.path);
  return sha256Value({source:projection.timeline.source ? sha256File(projection.timeline.source) : null,
    edl:timeline.edl,transitions:timeline.transitions ?? [],fps:projection.timebase.frameRate,
    dialogue:dialogue ? {spec:dialogue,sha256:sha256File(dialoguePath)} : null});
}

export function networkRequest(timeline, { start, end, text, purpose, query, evidenceType = 'illustration' }) {
  const projection = buildTimelineProjection(timeline);
  const request = { schemaVersion:'1.0', kind:'kacha-network-material-request', projectId:projection.projectId,
    timeline:fileIdentity(path.resolve(timeline)), source:projection.timeline.source ? fileIdentity(projection.timeline.source) : null,
    narrativeSha256:narrativeDigest(projection),
    scene:{ start, end, text, purpose, query, evidenceType },
    output:{ width:projection.output.width, height:projection.output.height, fps:projection.timebase.framesPerSecond },
    note:'搜索结果仅为候选；观察实际画面、选段、核对来源和许可后才能加入当前时间线。' };
  validateRequest(request, projection);
  return request;
}

function validateRequest(request, projection) {
  need(request?.schemaVersion === '1.0' && request.kind === 'kacha-network-material-request', '找素材需求格式无效');
  identity(request.timeline, '当前时间线');
  identity(request.source, '主视频');
  need(request.narrativeSha256 === narrativeDigest(projection),'主视频或粗剪映射已变化，需要重新匹配');
  need(request.projectId === projection.projectId && request.timeline.sha256 === projection.timeline.sha256
    && fs.realpathSync(request.timeline.path) === fs.realpathSync(projection.timeline.path), '需求不属于当前工程或剪辑版本');
  const scene = request.scene;
  need(scene && ['text','purpose','query'].every(key => nonempty(scene[key])), '填写当前段落文字、画面用途和具体检索词');
  need(['illustration','factual'].includes(scene.evidenceType), '区分事实材料与示意画面');
  const fps = projection.timebase.framesPerSecond;
  need(Number.isFinite(scene.start) && Number.isFinite(scene.end) && scene.start >= 0 && scene.end > scene.start
    && scene.end <= projection.durationSeconds + 1e-7
    && [scene.start, scene.end].every(t => Math.abs(t * fps - Math.round(t * fps)) < 1e-6), '素材目标区间必须位于当前视频的整帧边界');
}

function manifestAsset(manifestFile, assetId) {
  const manifest = readJson(manifestFile);
  need(manifest.schema === 'kacha.media-manifest.v1', '需要实际下载清单');
  const matches = (manifest.items ?? []).filter(item => String(item.asset_id) === String(assetId));
  need(matches.length === 1, '下载清单素材 ID 不存在或重复');
  const item = matches[0];
  need(['photo','video'].includes(item.kind) && webUrl(item.source_url) && webUrl(item.license_url) && nonempty(item.creator), '素材缺少来源页、作者或许可');
  const local = path.resolve(path.dirname(manifestFile), item.local_path);
  need(fs.existsSync(local) && sha256File(local) === item.sha256, '下载素材摘要已变化');
  return { item, local };
}

export function selectionTemplate(requestFile, manifestFile, assetId) {
  const request = readJson(requestFile);
  validateRequest(request, buildTimelineProjection(request.timeline.path));
  const { item, local } = manifestAsset(manifestFile, assetId);
  return {schemaVersion:'1.0',kind:'kacha-network-material-selection',
    request:fileIdentity(path.resolve(requestFile)), manifest:fileIdentity(path.resolve(manifestFile)), assetId:String(assetId),
    asset:fileIdentity(local), sourceIn:0, fit:'contain', audio:'mute',
    review:{status:'pending',reviewer:'',reviewedAt:null,observation:'',matchReason:'',mismatch:'',
      fullSelectedRangeViewed:false, rightsChecked:false, usageConditions:'', attribution:'',
      sourceEvidence:null, disclosure:request.scene.evidenceType === 'illustration' ? '素材示意' : ''},
    inspection:null, note:`${item.kind === 'video' ? '视频须看选段的完整动作和前后文' : '图片须看清实际内容'}；字段记录审阅，不自动判定匹配或授权。`};
}

export function factEvidenceTemplate(selectionFile) {
  const selection=readJson(selectionFile),{request,item}=selectionInputs(selection);
  need(request.scene.evidenceType === 'factual','只有事实素材需要事实关联记录');
  return {schemaVersion:'1.0',kind:'kacha-material-fact-evidence',status:'pending',projectId:request.projectId,
    requestSha256:selection.request.sha256,assetSha256:selection.asset.sha256,
    claim:request.scene.text,sourceUrl:item.source_url,sourceRecord:null,locator:'',verification:'',reviewer:'',reviewedAt:null};
}

export function inspectSelection(selectionFile, output) {
  const selection = readJson(selectionFile);
  const {request, item, local} = selectionInputs(selection);
  const duration = request.scene.end - request.scene.start;
  validateRange(selection, item, local, duration);
  need(!fs.existsSync(output), '拒绝覆盖已有素材观察目录');
  fs.mkdirSync(output, {recursive:true});
  const frames = [];
  const times = item.kind === 'photo' ? [0] : [0.05,0.5,0.95].map(f => selection.sourceIn + duration*f);
  for (const [i, at] of times.entries()) {
    const file = path.resolve(output, `frame-${i+1}.jpg`);
    const result = spawnSync(process.env.KACHA_FFMPEG_BIN || 'ffmpeg', ['-v','error','-nostdin','-i',local,
      ...(item.kind === 'photo' ? [] : ['-ss',String(at)]), '-vf','scale=960:540:force_original_aspect_ratio=decrease',
      '-frames:v','1',file], {encoding:'utf8',timeout:60000});
    need(result.status === 0 && fs.existsSync(file), '素材抽帧失败');
    frames.push({...fileIdentity(file),atSeconds:at});
  }
  selection.inspection = {asset:fileIdentity(local),request:selection.request,manifest:selection.manifest,sourceIn:selection.sourceIn,duration,frames};
  // New observations invalidate prior assertions. Merely extracting frames is
  // never evidence that the selected video was watched.
  selection.review = {...selection.review,status:'pending',reviewer:'',reviewedAt:null,fullSelectedRangeViewed:false};
  writeJsonAtomic(selectionFile,selection);
  return {status:'needs_review',frames,selectedRange:{start:selection.sourceIn,end:selection.sourceIn+duration},asset:local};
}

function selectionInputs(selection) {
  need(selection?.schemaVersion === '1.0' && selection.kind === 'kacha-network-material-selection', '素材选择格式无效');
  identity(selection.request,'素材需求'); identity(selection.manifest,'下载清单'); identity(selection.asset,'选中素材');
  const request = readJson(selection.request.path);
  const {item,local} = manifestAsset(selection.manifest.path,selection.assetId);
  need(fs.realpathSync(local) === fs.realpathSync(selection.asset.path) && selection.asset.sha256 === item.sha256, '选择与下载素材不一致');
  return {request,item,local};
}

function validateRange(selection,item,local,duration) {
  need(Number.isFinite(selection.sourceIn) && selection.sourceIn >= 0, '源入点须为非负秒数');
  const media = mediaSummary(local);
  need(media.width > 0 && media.height > 0, '素材没有有效画面');
  if (item.kind === 'photo') need(selection.sourceIn === 0, '图片源入点必须为0');
  else need(selection.sourceIn + duration <= visualMediaDuration(local) + 1e-7, '选段超出源视频，不允许静默定格或循环');
  need(selection.fit === 'contain' && selection.audio === 'mute', '当前插镜保留完整画面并静音，主片人声继续；其他裁切/声音策略须单独编排');
}

export function selectedOverlay(projection, selectionFile, selectionSha256, id, {adopted=false}={}) {
  need(/^[a-zA-Z0-9_-]{1,80}$/.test(id ?? ''), '插镜 ID 格式无效');
  need(sha256File(selectionFile) === selectionSha256, '素材审阅文件已变化');
  const selection = readJson(selectionFile);
  const {request,item,local} = selectionInputs(selection);
  if (!adopted) validateRequest(request,projection);
  else {
    identity(request.source,'主视频');
    need(request.narrativeSha256 === narrativeDigest(projection),'主视频或粗剪映射已变化，需要重新匹配');
    need(request.projectId === projection.projectId && fs.realpathSync(request.timeline.path) === projection.timeline.path, '素材审阅不属于当前工程');
  }
  const duration = request.scene.end-request.scene.start;
  validateRange(selection,item,local,duration);
  const review = selection.review, inspection = selection.inspection;
  need(review?.status === 'approved' && ['reviewer','observation','matchReason','usageConditions','attribution'].every(key=>nonempty(review[key]))
    && Number.isFinite(Date.parse(review.reviewedAt)) && Date.parse(review.reviewedAt) <= Date.now()
    && review.rightsChecked === true && review.fullSelectedRangeViewed === true, '先查看实际选段并填写匹配、许可条件和归属审阅');
  need(!nonempty(review.mismatch), '候选存在未解决的不匹配，不能加入时间线');
  need(inspection?.sourceIn === selection.sourceIn && inspection.duration === duration, '源选段已变化，需要重新查看');
  identity(inspection.asset,'观察素材');
  need(inspection.request?.sha256 === selection.request.sha256 && inspection.manifest?.sha256 === selection.manifest.sha256,
    '段落用途或来源许可已变化，需要重新查看和审阅');
  need(inspection.asset.sha256 === selection.asset.sha256 && inspection.frames?.length === (item.kind === 'photo' ? 1 : 3), '观察帧不属于当前素材');
  inspection.frames.forEach(frame => identity(frame,'观察帧'));
  if (request.scene.evidenceType === 'factual') {
    identity(review.sourceEvidence,'本期事实关联证据');
    const fact=readJson(review.sourceEvidence.path);
    need(fact.schemaVersion === '1.0' && fact.kind === 'kacha-material-fact-evidence' && fact.status === 'approved'
      && fact.projectId === request.projectId && fact.requestSha256 === selection.request.sha256
      && fact.assetSha256 === selection.asset.sha256 && fact.claim === request.scene.text && fact.sourceUrl === item.source_url
      && ['locator','verification','reviewer'].every(key=>nonempty(fact[key]))
      && Number.isFinite(Date.parse(fact.reviewedAt)) && Date.parse(fact.reviewedAt) <= Date.now(), '事实关联记录不属于本期论点和素材，或尚未核对');
    identity(fact.sourceRecord,'事实来源记录');
  }
  else need(nonempty(review.disclosure), '示意素材须记录说明标签');
  if (!adopted) need(!projection.items.some(entry=>entry.id === `overlay:${id}`), '插镜 ID 已存在');
  const width = Number(projection.output.width), height = Number(projection.output.height);
  need(width > 0 && height > 0, '时间线需要明确输出尺寸');
  return {id,kind:item.kind === 'photo' ? 'image':'video',path:local,sha256:selection.asset.sha256,
    start:request.scene.start,end:request.scene.end,sourceOffsetSeconds:selection.sourceIn,x:0,y:0,width,height,
    license:item.license_url,provenance:{kind:request.scene.evidenceType === 'factual' ? 'reviewed_source':'stock_illustration',
      source:item.source_url,creator:item.creator,evidence:path.resolve(selectionFile),selectionSha256,
      externalUpload:false,attribution:review.attribution,disclosure:review.disclosure},
    narrativePurpose:request.scene.purpose};
}

export function validateAdoptedSelection(projection, overlay, selectionFile) {
  const expected=selectedOverlay(projection,selectionFile,overlay.provenance?.selectionSha256,overlay.id,{adopted:true});
  for (const key of ['kind','path','sha256','start','end','sourceOffsetSeconds','x','y','width','height','license']) {
    need(overlay[key] === expected[key],`实际插镜 ${key} 已变化，需要重新匹配审阅`);
  }
  need(JSON.stringify(overlay.provenance) === JSON.stringify(expected.provenance),'插镜来源/署名记录已变化');
}

async function main(args) {
  const option = (name, fallback=null) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
  const action = args[0], output = option('--output');
  const save = value => { need(output && !fs.existsSync(output),'指定未使用的 --output'); writeJsonAtomic(output,value); return {status:'draft',path:path.resolve(output)}; };
  let result;
  if (action === 'request') result = save(networkRequest(option('--timeline'),{start:Number(option('--start')),end:Number(option('--end')),
    text:option('--text'),purpose:option('--purpose'),query:option('--query'),evidenceType:option('--evidence-type','illustration')}));
  else if (action === 'select') result = save(selectionTemplate(option('--request'),option('--manifest'),option('--asset-id')));
  else if (action === 'fact-template') result = save(factEvidenceTemplate(option('--selection')));
  else if (action === 'inspect') { need(output,'需要 --output 观察目录'); result=inspectSelection(option('--selection'),output); }
  else if (action === 'search') {
    const requestFile=option('--request'),request=readJson(requestFile);
    validateRequest(request,buildTimelineProjection(request.timeline.path));
    const provider=option('--provider','commons'),kind=option('--kind','photo');
    const child=spawnSync('python3',[path.join(path.dirname(fileURLToPath(import.meta.url)),'fetch_stock_media.py'),
      '--provider',provider,'--kind',kind,'--query',request.scene.query,'--orientation',request.output.width > request.output.height ? 'landscape' : request.output.width < request.output.height ? 'portrait':'square',
      '--output-dir',output,'--search-only','--limit',option('--limit','3')],{encoding:'utf8',timeout:120000});
    need(child.status===0,child.stderr || '网络检索失败'); result={status:'candidates',request:fileIdentity(requestFile),detail:child.stdout.trim()};
  } else if (action === 'apply' || action === 'validate') {
    const selectionFile=path.resolve(option('--selection')),selection=readJson(selectionFile),request=readJson(selection.request.path);
    const projection=buildTimelineProjection(request.timeline.path),id=option('--id','network-insert');
    const overlay=selectedOverlay(projection,selectionFile,sha256File(selectionFile),id);
    if(action === 'validate') result={status:'pass',overlay};
    else {
      const {applyEditorCommand}=await import('./editor_command_journal.mjs');
      result=applyEditorCommand(request.timeline.path,{schemaVersion:'1.0',kind:'kacha-editor-command',baseSha256:projection.timeline.sha256,
        operation:'insert_media',arguments:{selectionPath:selectionFile,selectionSha256:sha256File(selectionFile),id},reason:request.scene.purpose});
    }
  } else throw new Error('用法：network-materials request|search|select|inspect|fact-template|validate|apply；详见 references/network-materials.md');
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
