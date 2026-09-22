#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireFileLock, fileIdentity, mediaSummary, readJson, run, sha256File, writeJsonAtomic} from './kacha_utils.mjs';
import {canonicalizeTimelineTime,normalizeTimebase} from './media_time.mjs';
import {loadEditingCraft} from './editing_craft.mjs';
const scripts=path.dirname(fileURLToPath(import.meta.url));
const number=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw new Error(`${label} 必须为非负有限数`);return v;};
function identity(owner,value,label){
 if(!value?.path||!value.sha256)throw new Error(`${label} 缺少强身份`);
 const file=path.resolve(path.dirname(owner),value.path);
 if(!fs.existsSync(file)||sha256File(file)!==value.sha256)throw new Error(`${label} 身份已失效`);
 return {...value,path:file};
}
function absolute(value,owner){
 if(Array.isArray(value))return value.map(v=>absolute(v,owner));
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([k])=>!k.endsWith('Tick')).map(([k,v])=>[k,['path','fontsDirectory'].includes(k)&&typeof v==='string'?path.resolve(path.dirname(owner),v):absolute(v,owner)]));
}
function spans(edl){let cursor=0;return edl.map(c=>{const span={id:c.id,start:cursor,end:cursor+c.sourceEnd-c.sourceStart};cursor=span.end;return span;});}
function retime(plan,oldEdl,newEdl,fps){
 const before=spans(oldEdl),after=spans(newEdl);
 const map=(t,end=false)=>{const i=before.findIndex(s=>t>=s.start-1e-7&&(end?t<=s.end+1e-7:t<s.end-1e-7));if(i<0)throw new Error(`无法映射事件时间 ${t}`);return after[i].start+t-before[i].start+oldEdl[i].sourceStart-newEdl[i].sourceStart;};
 const ticksPerSecond=normalizeTimebase(plan.timebase,fps).ticksPerSecond;
 for(const event of [...(plan.visual?.overlays??[]),...(plan.visual?.breathing??[]),...(plan.audio?.bgm?.segments??[]),...(plan.audio?.bgm?.silences??[]),...(plan.audio?.naturalSoundWindows??[])]){
  const oldEnd=event.end;
  for(const points of Object.values(event.keyframes??{}))for(const point of points){
   const time=point.tick/ticksPerSecond;
   point.time=map(time,Math.abs(time-oldEnd)<1e-7);point.tick=Math.round(point.time*ticksPerSecond);
  }
  event.start=map(event.start);event.end=map(event.end,true);
 }
 for(const event of plan.audio?.sfx??[]){if(event.targetLandingSeconds!==undefined)event.targetLandingSeconds=map(event.targetLandingSeconds);else event.time=map(event.time);}
}
function renderAudio(source,segments,output,root,operationsFile){
 const filters=segments.map((s,i)=>`[0:a]atrim=start_sample=${Math.round(s.sourceStart*48000)}:end_sample=${Math.round(s.sourceEnd*48000)},asetpts=PTS-STARTPTS[a${i}]`);
 filters.unshift('[0:a]aresample=48000[audio48]');
 // Each segment reads the same resampled source through asplit.
 filters[0]+=`;[audio48]asplit=${segments.length}${segments.map((_,i)=>`[src${i}]`).join('')}`;
 for(let i=1;i<filters.length;i++)filters[i]=filters[i].replace('[0:a]',`[src${i-1}]`);
 filters.push(segments.map((_,i)=>`[a${i}]`).join('')+`concat=n=${segments.length}:v=0:a=1[out]`);
 const ff=['ffmpeg','-v','error','-i',source,'-filter_complex',filters.join(';'),'-map','[out]','-c:a','pcm_s24le','-ar','48000',output];
 const result=run(process.execPath,[path.join(scripts,'artifact_cache.mjs'),'run','--project-root',root,'--kind','craft_audio','--input',source,'--input',operationsFile,'--implementation',fileURLToPath(import.meta.url),'--parameters',JSON.stringify({segments,sampleRate:48000}),'--operation-version','1','--resource','cpuHeavy','--output',`dialogue=${output}`,'--',...ff]);
 if(result.status!==0)throw new Error(result.stderr||result.stdout);
}
export function compileCraft(timelineFile,operationsFile,outputFile){
 timelineFile=path.resolve(timelineFile);operationsFile=path.resolve(operationsFile);outputFile=path.resolve(outputFile);
 if(fs.existsSync(outputFile)||outputFile===timelineFile)throw new Error('手法编译必须写入独立新时间线');
 const original=readJson(timelineFile),decisions=readJson(operationsFile),decisionsSha256=sha256File(operationsFile);
 if(decisions.version!=='craft-v1'||decisions.timelineSha256!==sha256File(timelineFile)||!Array.isArray(decisions.operations)||!decisions.operations.length)throw new Error('手法决定缺少版本、当前时间线身份或 operations');
 const source=identity(timelineFile,original.source,'source');
 if(decisions.sourceSha256!==source.sha256)throw new Error('手法决定未绑定当前源');
 const summary=mediaSummary(source.path),duration=summary.videoDuration||summary.duration;
 if(!Array.isArray(original.edl)||!original.edl.length)throw new Error('手法编译需要明确 EDL');
 if((original.transitions??[]).some(t=>Number(t.durationFrames)>0))throw new Error('当前手法编译只支持明确硬切；保留原工程，先将转场区间独立处理');
 if(original.audio?.dialogue)throw new Error('已有独立人声 stem 需先建立其源映射，禁止猜测替换');
 const plan=absolute(original,timelineFile);
 const oldEdl=structuredClone(plan.edl),fps=Number(plan.output?.fps)||summary.averageFps;
 const align=(v,label)=>{number(v,label);if(Math.abs(v*fps-Math.round(v*fps))>1e-4)throw new Error(`${label} 必须对齐画面帧`);return v;};
 const catalog=loadEditingCraft(),ids=new Set();
 for(const op of decisions.operations){
  if(!op.id||ids.has(op.id)||!op.cueId||!op.reason)throw new Error('每项手法需唯一 ID、cueId 和理由');ids.add(op.id);
  identity(operationsFile,op.evidence,`${op.id}.evidence`);
  if(!['reading-hold','reaction-hold','proof-reveal','natural-sound','j-cut','l-cut'].includes(op.type))throw new Error(`尚未编译的手法 ${op.type}`);
  if(['reading-hold','reaction-hold'].includes(op.type)){
   const clip=plan.edl.find(c=>c.id===op.clipId);if(!clip)throw new Error(`${op.id} 片段不存在`);
   const start=align(op.sourceStart,'sourceStart'),end=align(op.sourceEnd,'sourceEnd');
   const min=op.type==='reading-hold'?Math.max(catalog.timing.minimumReadingSeconds,number(op.readingUnits,'readingUnits')/catalog.timing.readingUnitsPerSecond+catalog.timing.readingLeadSeconds):catalog.timing.minimumReactionSeconds;
   if(start>clip.sourceStart||end<clip.sourceEnd||end>duration||end-start<min)throw new Error(`${op.id} 真实源区间不足，禁止删句或冻结反应伪造停留`);
   Object.assign(clip,{sourceStart:start,sourceEnd:end,provenance:{kind:'source_range',evidence:op.evidence.path},craftOperationId:op.id});
  }
 }
 const durationChanged=oldEdl.some((c,i)=>c.sourceStart!==plan.edl[i].sourceStart||c.sourceEnd!==plan.edl[i].sourceEnd);
 if(durationChanged&&plan.visual?.subtitles)throw new Error('源区间延长后须先按新映射重建字幕，不复用旧 ASS/字幕视频');
 if(durationChanged)retime(plan,oldEdl,plan.edl,fps);
 const positions=spans(plan.edl),total=positions.at(-1).end;
 plan.visual??={};plan.visual.overlays??=[];plan.audio??={};
 const audio=plan.edl.map((c,i)=>({clipId:c.id,sourceStart:c.sourceStart,sourceEnd:c.sourceEnd,outputStart:positions[i].start,outputEnd:positions[i].end}));
 const root=path.dirname(outputFile);fs.mkdirSync(root,{recursive:true});
 const release=acquireFileLock(`${outputFile}.lock`,{purpose:'craft-compile'});
 const artifacts=[];let needsAudio=false;
 try{
  if(fs.existsSync(outputFile))throw new Error('手法编译输出已存在，拒绝覆盖');
  for(const op of decisions.operations){
   if(op.type==='proof-reveal'){
    const asset=identity(operationsFile,op.asset,`${op.id}.asset`),start=align(op.start,'start'),end=align(op.end,'end');
    if(end<=start||end>total||!['image','video'].includes(op.kind)||op.asset.provenance?.kind==='illustration'||!op.asset.provenance?.evidence)throw new Error(`${op.id} 证据揭示缺少真实来源或有效范围`);
    const minimum=number(op.readingUnits,'readingUnits')/catalog.timing.readingUnitsPerSecond+catalog.timing.readingLeadSeconds;
    if(end-start<minimum)throw new Error(`${op.id} 证据阅读时间不足`);
    const geometry=Object.fromEntries(['x','y','width','height'].map(k=>[k,number(op[k],k)]));
    if(!geometry.width||!geometry.height)throw new Error('证据画面尺寸必须大于 0');
    plan.visual.overlays.push({...asset,...geometry,id:op.id,kind:op.kind,start,end,opacity:1,craftOperationId:op.id});
   }
  }
  const joins=new Set();
  for(const op of decisions.operations){
   if(['j-cut','l-cut'].includes(op.type)){
    needsAudio=true;const i=plan.edl.findIndex(c=>c.id===op.afterClipId);
    if(i<0||i>=audio.length-1||joins.has(i))throw new Error(`${op.id} 剪口不存在或重复`);joins.add(i);
    const delta=align(op.offsetSeconds,'offsetSeconds'),boundary=positions[i].end;
    if(delta<=0||delta>2)throw new Error('J/L 音桥必须在 0–2 秒 handle 范围');
    const begin=op.type==='j-cut'?boundary-delta:boundary,end=op.type==='j-cut'?boundary:boundary+delta;
    const cover=plan.visual.overlays.find(v=>v.id===op.coverId);
    const width=plan.output?.width||summary.width,height=plan.output?.height||summary.height;
    if(!cover||cover.start>begin||cover.end<end||cover.x!==0||cover.y!==0||cover.width!==width||cover.height!==height||(cover.opacity??1)!==1)throw new Error(`${op.id} 音画分离范围缺少完整遮盖，不能自动放行口型冲突`);
    const shift=op.type==='j-cut'?-delta:delta;
    audio[i].sourceEnd+=shift;audio[i].outputEnd+=shift;
    audio[i+1].sourceStart+=shift;audio[i+1].outputStart+=shift;
   }
   if(op.type==='natural-sound'){
    const start=align(op.start,'start'),end=align(op.end,'end');
    if(op.recordingSha256!==source.sha256||!summary.audio||end-start<catalog.timing.minimumNaturalSoundSeconds||end>total)throw new Error(`${op.id} 必须使用当前真实录音且保留足够现场声窗口`);
    if(plan.audio.bgm){plan.audio.bgm.silences??=[];plan.audio.bgm.silences.push({id:op.id,start,end,reason:op.reason});}
    plan.audio.naturalSoundWindows??=[];plan.audio.naturalSoundWindows.push({id:op.id,start,end,sourceSha256:source.sha256,cueId:op.cueId});
   }
  }
  for(const segment of audio)if(segment.sourceStart<0||segment.sourceEnd>duration||segment.sourceEnd<=segment.sourceStart||segment.outputEnd<=segment.outputStart)throw new Error('音频 handle 不足或相邻音桥发生冲突');
  if(needsAudio){
   if(plan.visual.subtitles&&!decisions.transcript)throw new Error('J/L-cut 需要源时间字幕映射，不能沿用未映射字幕');
   const stem=`${outputFile}.dialogue.wav`;renderAudio(source.path,audio,stem,root,operationsFile);artifacts.push(fileIdentity(stem));
   plan.audio.dialogue={...fileIdentity(stem),provenance:{kind:'compiled_split_edit',evidence:`${outputFile}.craft.json`}};
  }
  let mapped=[];
  if(decisions.transcript){
   const ref=identity(operationsFile,decisions.transcript,'transcript'),transcript=readJson(ref.path);
   if(transcript.sourceSha256!==source.sha256||!Array.isArray(transcript.cues))throw new Error('字幕须绑定源 SHA 和源时间 cues');
   for(const cue of transcript.cues){
    if(!cue.id||!cue.text||typeof cue.start!=='number'||typeof cue.end!=='number'||cue.end<=cue.start)throw new Error('字幕 cue 无效');
    const segments=audio.filter(s=>cue.start>=s.sourceStart-1e-7&&cue.end<=s.sourceEnd+1e-7);
    const intersect=audio.some(s=>cue.end>s.sourceStart&&cue.start<s.sourceEnd);
    if(!segments.length&&intersect)throw new Error(`剪口截断字幕 ${cue.id}，须先按词边界修订`);
    mapped.push(...segments.map((s,i)=>({...cue,id:`${cue.id}-${i}`,sourceStart:cue.start,sourceEnd:cue.end,start:s.outputStart+cue.start-s.sourceStart,end:s.outputStart+cue.end-s.sourceStart})));
   }
   mapped.sort((a,b)=>a.start-b.start);
   writeJsonAtomic(`${outputFile}.subtitles.json`,{sourceSha256:source.sha256,cues:mapped});
   const style=decisions.captionStyle;
   if(!style||typeof style.font!=='string'||/[\r\n,]/.test(style.font)||!Number.isFinite(style.fontSize)||style.fontSize<8||style.fontSize>240)throw new Error('字幕重建须指定原批准 captionStyle.font/fontSize');
   const assTime=seconds=>{const n=Math.round(seconds*100);return `${Math.floor(n/360000)}:${String(Math.floor(n/6000)%60).padStart(2,'0')}:${String(Math.floor(n/100)%60).padStart(2,'0')}.${String(n%100).padStart(2,'0')}`;};
   const escape=text=>String(text).replaceAll('\\','\\\\').replaceAll('{','\\{').replaceAll('}','\\}').replace(/\r?\n/g,'\\N');
   const ass=`[Script Info]\nScriptType: v4.00+\nPlayResX: ${plan.output?.width||summary.width}\nPlayResY: ${plan.output?.height||summary.height}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${style.font},${style.fontSize},&H00FFFFFF,&H00FFFFFF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,1,0,1,2,12,12,12,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`+mapped.map(c=>`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${escape(c.text)}`).join('\n');
   const assFile=`${outputFile}.subtitles.ass`;fs.writeFileSync(assFile,ass,{flag:'wx'});artifacts.push(fileIdentity(assFile));
   plan.visual.subtitles={...fileIdentity(assFile),kind:'ass',provenance:{kind:'remapped_source_transcript',evidence:ref.path}};
  }
  if(sha256File(operationsFile)!==decisionsSha256||sha256File(timelineFile)!==decisions.timelineSha256||sha256File(source.path)!==source.sha256)throw new Error('编译期间决定、源或时间线已改变');
  plan.source=source;plan.output={...plan.output,path:`${outputFile}.preview.mp4`};
  for(const k of ['dialogueStem','bgmStem','sfxStem','mixStem'])delete plan.output[k];
  // Edit-plan and proposal approvals do not carry across a structural edit.
  plan.mode='preview';delete plan.contracts;delete plan.decisionPlan;
  plan.craft={version:'craft-v1',decisions:fileIdentity(operationsFile),inputTimeline:fileIdentity(timelineFile),executionStatus:'compiled_requires_render_and_review',operations:decisions.operations.map(op=>({id:op.id,type:op.type,cueId:op.cueId})),audioSegments:audio};
  const canonical=canonicalizeTimelineTime(plan,fps);if(canonical.errors.length)throw new Error(canonical.errors.join('; '));
  writeJsonAtomic(outputFile,canonical.plan);
  const manifest={status:'compiled_requires_render_and_review',input:fileIdentity(timelineFile),decisions:fileIdentity(operationsFile),output:fileIdentity(outputFile),artifacts,audioSegments:audio,mappedSubtitleCues:mapped.length,timingChanged:durationChanged,renderCommand:['timeline','render','--plan',outputFile]};
  writeJsonAtomic(`${outputFile}.craft.json`,manifest);return manifest;
 }finally{release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),opt=k=>args.includes(k)?args[args.indexOf(k)+1]:null;
 try{if(args[0]!=='compile'||!opt('--timeline')||!opt('--operations')||!opt('--output'))throw new Error('用法：craft compile --timeline FILE --operations FILE --output NEW_TIMELINE');console.log(JSON.stringify(compileCraft(opt('--timeline'),opt('--operations'),opt('--output')),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
