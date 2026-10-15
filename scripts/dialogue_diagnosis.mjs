import fs from 'node:fs';
import { canonicalizeTimelineTime, timebaseSummary } from './media_time.mjs';
import { boundaryTransitions } from './timeline_transitions.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, fileIdentityMatches, mediaSummary, readJson, run, sha256Value, writeJsonAtomic } from './kacha_utils.mjs';

export function diagnosisReviewDigest(report) {
  const { review, ...subject } = report;
  return sha256Value(subject);
}
export function validateDialogueDiagnosis(report, { sourcePaths = [], mode } = {}) {
  const errors = [];
  if (report?.schemaVersion !== '1.0' || report?.kind !== 'kacha-dialogue-diagnosis') return ['无效的人声诊断'];
  if (!report.source?.path || !fileIdentityMatches(report.source.path, report.source)) errors.push('诊断源身份已失效');
  if (sourcePaths.length && !sourcePaths.some(file => path.resolve(file) === report.source.path)) errors.push('诊断不属于方案当前源');
  if (report.technical?.decoded !== true || !(report.technical?.durationSeconds > 0) || !(report.technical?.channels > 0)) errors.push('诊断缺少真实音轨完整解码');
  const review = report.review;
  if (!review || review.status !== 'pass' || !review.reviewer?.trim() || !Number.isFinite(Date.parse(review.reviewedAt))
      || review.subjectDigest !== diagnosisReviewDigest(report)) errors.push('诊断缺少绑定当前源的实际审听');
  for (const check of ['speechIntact','noBackgroundMusic','noCompetingSpeech']) if (review?.checks?.[check] !== true) errors.push(`诊断未通过 ${check}`);
  if (mode === 'passthrough' && review?.checks?.cleanRecording !== true) errors.push('直通要求已审听的干净录音');
  if (mode === 'light' && review?.checks?.lightProcessingAppropriate !== true) errors.push('轻处理需要具体审听依据');
  if (!review?.reason?.trim()) errors.push('诊断缺少处理理由');
  return errors;
}
export function diagnoseDialogue(input) {
  const file = path.resolve(input), source = fileIdentity(file), media = mediaSummary(file);
  if (!media.audio) throw new Error('源文件没有音轨');
  const decoded = run('ffmpeg',['-v','error','-i',file,'-map','0:a:0','-f','null','-']);
  if (decoded.status !== 0) throw new Error(decoded.stderr || '音轨无法完整解码');
  const report = { schemaVersion:'1.0',kind:'kacha-dialogue-diagnosis',source,
    technical:{decoded:true,durationSeconds:Number(media.audio.duration) || media.duration,channels:media.channels,sampleRate:media.sampleRate},
    review:{status:'pending',reviewer:'',reviewedAt:null,reason:'',checks:{speechIntact:false,noBackgroundMusic:false,noCompetingSpeech:false,cleanRecording:false,lightProcessingAppropriate:false}} };
  report.review.subjectDigest = diagnosisReviewDigest(report);
  return report;
}
// The external dialogue contract is in final-output time. Freeze the editorial
// mapping separately from audio.dialogue to avoid a circular receipt dependency.
export function dialogueMapping(timeline, timelineFile, source) {
  const sourcePath = timeline.source?.path && path.resolve(path.dirname(timelineFile), timeline.source.path);
  if (sourcePath !== source.path || !fileIdentityMatches(source.path, source)) throw new Error('时间线与诊断源不一致');
  const media = mediaSummary(source.path);
  const canonical = canonicalizeTimelineTime(timeline, timeline.output?.fps ?? 25);
  if (canonical.errors.length) throw new Error(canonical.errors.join('; '));
  const fps = timebaseSummary(canonical.timebase).framesPerSecond;
  const sourceDuration = media.videoDuration || media.duration;
  const entries = canonical.plan.edl?.length ? canonical.plan.edl : [{id:'source-full',sourceStart:0,sourceEnd:sourceDuration}];
  const edl = entries.map((entry,index) => {
    const start=Number(entry.sourceStart),end=Number(entry.sourceEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start || end>sourceDuration+.001) throw new Error('无效的人声剪辑区间');
    return {id:entry.id || `segment-${String(index+1).padStart(3,'0')}`,sourceStart:start,sourceEnd:end};
  });
  const transitions=boundaryTransitions(canonical.plan.transitions,edl).map(entry=>({durationSeconds:entry.durationFrames/fps}));
  for(let i=0;i<edl.length;i++) if((transitions[i-1]?.durationSeconds??0)+(transitions[i]?.durationSeconds??0)>=edl[i].sourceEnd-edl[i].sourceStart) throw new Error('转场占满人声片段');
  const durationSeconds=edl.reduce((sum,e)=>sum+e.sourceEnd-e.sourceStart,0)-transitions.reduce((sum,e)=>sum+e.durationSeconds,0);
  return {coordinateSpace:'output-time',sourceSha256:source.sha256,edl,transitions,durationSeconds};
}
export function prepareDialogue({ diagnosisFile, timelineFile, output, mode }) {
  if (!['passthrough','light'].includes(mode)) throw new Error('mode 必须为 passthrough 或 light；分离使用 separate_dialogue.sh');
  if (!timelineFile) throw new Error('prepare 需要 --timeline 绑定实际剪辑与转场');
  const diagnosis = readJson(diagnosisFile), errors = validateDialogueDiagnosis(diagnosis,{mode});
  if (errors.length) throw new Error(errors.join('; '));
  const mapping=dialogueMapping(readJson(timelineFile),timelineFile,diagnosis.source);
  const mappingDigest=sha256Value(mapping);
  const target = path.resolve(output);
  if (path.extname(target).toLowerCase() !== '.wav') throw new Error('dialogue 输出必须为独立 WAV');
  if (fs.existsSync(target) || fs.existsSync(`${target}.json`)) throw new Error('拒绝覆盖已有音轨或处理回执');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temp = `${target}.partial-${process.pid}.wav`;
  try {
    const filters=mapping.edl.map((e,i)=>`[0:a:0]aresample=48000:first_pts=0,apad,atrim=start=${e.sourceStart}:end=${e.sourceEnd},asetpts=PTS-STARTPTS[a${i}]`);
    let current='a0';
    for(let i=1;i<mapping.edl.length;i++) {
      const duration=mapping.transitions[i-1].durationSeconds,next=`chain${i}`;
      filters.push(`[${current}][a${i}]`+(duration>0?`acrossfade=d=${duration}:c1=tri:c2=tri`:'concat=n=2:v=0:a=1')+`[${next}]`);current=next;
    }
    filters.push(`[${current}]${mode==='light'?'highpass=f=70,afftdn=nr=6:nf=-45':'anull'}[out]`);
    const args=['-v','error','-n','-i',diagnosis.source.path,'-filter_complex',filters.join(';'),'-map','[out]','-vn','-c:a','pcm_f32le',temp];
    const result=run('ffmpeg',args); if(result.status!==0) throw new Error(result.stderr);
    const summary=mediaSummary(temp);
    if (summary.channels!==diagnosis.technical.channels || Math.abs(summary.duration-mapping.durationSeconds)>.01) throw new Error('处理改变了声道或剪后时长');
    if (!fileIdentityMatches(diagnosis.source.path,diagnosis.source)) throw new Error('处理期间源已改变');
    if (sha256Value(dialogueMapping(readJson(timelineFile),timelineFile,diagnosis.source))!==mappingDigest) throw new Error('处理期间剪辑已改变');
    // Unlink before taking identity: removing a hard link changes inode ctime.
    fs.linkSync(temp,target);fs.unlinkSync(temp);
    const receipt={schemaVersion:'1.0',kind:'kacha-dialogue-preparation',mode,source:diagnosis.source,
      diagnosis:fileIdentity(diagnosisFile),output:fileIdentity(target),sourceSeparated:false,mapping,mappingDigest,
      acceptance:mode==='passthrough'?'source_reviewed':'candidate_requires_ab'};
    writeJsonAtomic(`${target}.json`,receipt);return receipt;
  } finally { if(fs.existsSync(temp))fs.unlinkSync(temp); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), opt=name=>args[args.indexOf(name)+1];
  try {
    const output=opt('--output');if(!args.includes('--output'))throw new Error('需要 --output');
    if(fs.existsSync(output))throw new Error('输出已存在');
    let result;
    if(args[0]==='diagnose' && args.includes('--input')) {result=diagnoseDialogue(opt('--input'));writeJsonAtomic(output,result);}
    else if(args[0]==='prepare' && args.includes('--diagnosis') && args.includes('--mode'))result=prepareDialogue({diagnosisFile:opt('--diagnosis'),output,mode:opt('--mode'),timelineFile:args.includes('--timeline')?opt('--timeline'):undefined});
    else throw new Error('dialogue diagnose --input FILE --output JSON | prepare --diagnosis JSON --timeline JSON --mode passthrough|light --output WAV');
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}

export function validatePreparedDialogue(proposal, proposalFile, timeline, timelineFile) {
  const processing = proposal.planModules?.dialogueAudio?.processing;
  if (!['passthrough','light'].includes(processing?.mode)) return [];
  const errors=[];
  try {
    if(proposal.workflowPolicy?.version!=='adaptive-v1') throw new Error('旧工程不能隐式启用按需人声处理');
    const entry=processing.preparation;
    const file=entry?.path && path.resolve(path.dirname(proposalFile),entry.path);
    if(!file || !fileIdentityMatches(file,entry)) throw new Error('缺少当前人声处理回执');
    const receipt=readJson(file), stem=timeline.audio?.dialogue;
    if(receipt.kind!=='kacha-dialogue-preparation' || receipt.mode!==processing.mode || receipt.sourceSeparated!==false) throw new Error('人声处理回执模式不符');
    if(!receipt.diagnosis?.path || !fileIdentityMatches(receipt.diagnosis.path,receipt.diagnosis)
       || receipt.diagnosis.sha256!==processing.diagnosis?.sha256) throw new Error('处理回执未绑定当前诊断');
    const diagnosis=readJson(receipt.diagnosis.path);
    if(receipt.source?.sha256!==diagnosis.source?.sha256 || receipt.source?.path!==diagnosis.source?.path) throw new Error('处理源与诊断源不同');
    errors.push(...validateDialogueDiagnosis(diagnosis,{mode:processing.mode}));
    const mapping=dialogueMapping(timeline,timelineFile,diagnosis.source);
    if(receipt.mappingDigest!==sha256Value(mapping) || sha256Value(receipt.mapping)!==receipt.mappingDigest) throw new Error('人声剪辑映射已失效，需要按当前时间线重建');
    if(!stem?.path || path.resolve(path.dirname(timelineFile),stem.path)!==receipt.output?.path
       || !fileIdentityMatches(receipt.output.path,receipt.output)) throw new Error('时间线未使用当前已处理人声');
    if(processing.mode==='light') {
      const review=receipt.review;
      if(review?.status!=='pass' || !review.reviewer?.trim() || !Number.isFinite(Date.parse(review.reviewedAt))
         || review.outputSha256!==receipt.output.sha256 || review.speechIntact!==true || review.noArtifacts!==true) throw new Error('轻处理候选尚未完成当前输出 A/B 审听');
    }
  } catch(error){errors.push(error.message);}
  return errors;
}
