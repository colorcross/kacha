import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {fileIdentity,sha256File,writeJsonAtomic,readJson} from '../scripts/kacha_utils.mjs';
import {compileCraft} from '../scripts/craft_compile.mjs';import {requestRealPreview,realPreviewStatus} from '../scripts/real_preview.mjs';import {executeTaskSpec} from '../scripts/deterministic_task.mjs';import {validateEditorialRequirements} from '../scripts/editorial_policy.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-execution-v5-'));
const run=(exe,args)=>{const r=spawnSync(exe,args,{encoding:'utf8',maxBuffer:20*1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r;};
const cli=(script,args)=>run(process.execPath,[path.join(repo,'scripts',script),...args]);
try{
 const source=path.join(root,'source.mp4');run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=8','-f','lavfi','-i','aevalsrc=0.12*sin(2*PI*(220+20*t)*t):s=48000:d=8','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
 const sourceId=fileIdentity(source),timeline=path.join(root,'timeline.json');
 const plan={schemaVersion:'1.0',projectId:'craft',mode:'preview',source:sourceId,edl:[{id:'a',sourceStart:0,sourceEnd:2},{id:'b',sourceStart:4,sourceEnd:6}],visual:{overlays:[]},audio:{bgm:{...sourceId,sidechain:false}},output:{path:path.join(root,'original.mp4'),width:320,height:180,fps:25}};
 writeJsonAtomic(timeline,plan);
 const evidenceFile=path.join(root,'evidence.json');writeJsonAtomic(evidenceFile,{kind:'engineering_fixture',notProductionAcceptance:true});const evidence=fileIdentity(evidenceFile);
 const decisionsFile=path.join(root,'operations.json');
 const proof={id:'proof',type:'proof-reveal',cueId:'cue-proof',reason:'engineering proof',evidence,asset:{...sourceId,provenance:{kind:'source_recording',evidence:evidenceFile}},kind:'video',start:1.6,end:3.2,readingUnits:2,x:0,y:0,width:320,height:180};
 const transcriptFile=path.join(root,'transcript.json');writeJsonAtomic(transcriptFile,{sourceSha256:sourceId.sha256,cues:[{id:'c',text:'mapped cue',start:3.8,end:4.2}]});
 const decisions={version:'craft-v1',timelineSha256:sha256File(timeline),sourceSha256:sourceId.sha256,transcript:fileIdentity(transcriptFile),captionStyle:{font:'Arial',fontSize:16},operations:[proof,{id:'j',type:'j-cut',afterClipId:'a',offsetSeconds:.24,coverId:'proof',cueId:'c',reason:'sound leads picture',evidence},{id:'room',type:'natural-sound',start:0,end:1.6,recordingSha256:sourceId.sha256,cueId:'room',reason:'preserve location recording',evidence}]};
 writeJsonAtomic(decisionsFile,decisions);const result=compileCraft(timeline,decisionsFile,path.join(root,'compiled.json'));
 assert.equal(result.audioSegments[0].sourceEnd,1.76);assert.equal(result.audioSegments[1].sourceStart,3.76);assert.equal(result.mappedSubtitleCues,1);
 const compiled=readJson(result.output.path);assert.ok(fs.existsSync(compiled.audio.dialogue.path));assert.ok(fs.existsSync(compiled.visual.subtitles.path));assert.equal(compiled.audio.bgm.silences.length,1);
 cli('timeline_ir.mjs',['render','--plan',result.output.path]);
 const mapped=readJson(`${result.output.path}.subtitles.json`).cues[0];assert.ok(Math.abs(mapped.start-1.8)<1e-6);
 // L-cut uses different per-clip handles, never a whole-track shift.
 delete decisions.transcript;decisions.operations=[proof,{id:'l',type:'l-cut',afterClipId:'a',offsetSeconds:.24,coverId:'proof',cueId:'l',reason:'sound lingers',evidence}];writeJsonAtomic(decisionsFile,decisions);
 const l=compileCraft(timeline,decisionsFile,path.join(root,'l.json'));assert.equal(l.audioSegments[0].sourceEnd,2.24);assert.equal(l.audioSegments[1].sourceStart,4.24);
 decisions.operations[1].coverId='missing';writeJsonAtomic(decisionsFile,decisions);assert.throws(()=>compileCraft(timeline,decisionsFile,path.join(root,'bad.json')),/遮盖/);
 decisions.operations=[{id:'hold',type:'reading-hold',clipId:'a',sourceStart:0,sourceEnd:2.4,readingUnits:6,cueId:'hold',reason:'read actual source',evidence},{id:'reaction',type:'reaction-hold',clipId:'b',sourceStart:3.6,sourceEnd:6, cueId:'reaction',reason:'keep actual reaction',evidence}];writeJsonAtomic(decisionsFile,decisions);
 const hold=compileCraft(timeline,decisionsFile,path.join(root,'hold.json'));assert.equal(readJson(hold.output.path).edl[0].sourceEnd,2.4);assert.equal(hold.timingChanged,true);
 // Extending source ranges moves animation and music windows with their content.
 plan.visual.overlays=[{...sourceId,id:'moving',kind:'video',start:2.4,end:3.2,x:0,y:0,width:160,height:90,keyframes:{x:[{tick:288000,value:0},{tick:384000,value:100}]}}];
 plan.audio.bgm.silences=[{start:2.4,end:3.2,reason:'preserve content pause'}];writeJsonAtomic(timeline,plan);decisions.timelineSha256=sha256File(timeline);writeJsonAtomic(decisionsFile,decisions);
 const shifted=compileCraft(timeline,decisionsFile,path.join(root,'shifted.json')),shiftedPlan=readJson(shifted.output.path);
 assert.ok(Math.abs(shiftedPlan.visual.overlays[0].start-3.2)<1e-7);assert.equal(shiftedPlan.visual.overlays[0].keyframes.x[0].tick,384000);assert.ok(Math.abs(shiftedPlan.audio.bgm.silences[0].end-4)<1e-7);
 cli('timeline_ir.mjs',['render','--plan',shifted.output.path]);
 plan.visual.overlays=[];delete plan.audio.bgm.silences;writeJsonAtomic(timeline,plan);
 // Required fact/user expression cannot be relabelled optional.
 const requirementsFile=path.join(root,'requirements.json');writeJsonAtomic(requirementsFile,{version:'narrative-v1',requirements:[{id:'fact',priority:'optional',origin:'fact',reason:'skip',dispositionReason:'cheap'}]});assert.ok(validateEditorialRequirements(timeline,fileIdentity(requirementsFile)).some(e=>e.includes('不能降级')));
 writeJsonAtomic(requirementsFile,{version:'narrative-v1',requirements:[{id:'opening',priority:'required',origin:'editorial',reason:'real opening',timelineIds:['a']}]});
 const contract=path.join(root,'quality.json');cli('production_quality_contract.mjs',['template','--project-id','fixture','--editorial-policy','narrative-v1','--requirements',requirementsFile,'--output',contract]);cli('production_quality_contract.mjs',['validate','--contract',contract,'--stage','plan']);assert.equal(readJson(contract).policies.firstMinute.minimumMotivatedEffects,0);
 // Deterministic adapters are real executions with bounded parameters.
 for(const adapter of ['media_probe','audio_analysis','styleframe','transcript_index']){
  const spec=path.join(root,`${adapter}.spec.json`),output=path.join(root,adapter+(adapter==='styleframe'?'.png':'.json'));
  writeJsonAtomic(spec,{version:'deterministic-v1',adapter,input:adapter==='transcript_index'?fileIdentity(transcriptFile):sourceId,parameters:adapter==='styleframe'?{timeSeconds:1,width:160}:{}});
  assert.equal(executeTaskSpec(spec,sha256File(spec),output).status,'pass');assert.throws(()=>executeTaskSpec(spec,sha256File(spec),output),/覆盖/);
 }
 // Registered adapter also executes through the existing scheduler, managed job and telemetry.
 const schedulerSpec=path.join(root,'scheduled.spec.json'),scheduledOutput=path.join(root,'scheduled.json');
 writeJsonAtomic(schedulerSpec,{version:'deterministic-v1',adapter:'media_probe',input:sourceId,parameters:{}});
 const adapterScript=path.join(repo,'scripts/deterministic_task.mjs'),executionFile=path.join(root,'execution.json');
 const task={id:'probe',argv:[process.execPath,adapterScript,'--spec',schedulerSpec,'--spec-sha',sha256File(schedulerSpec),'--output',scheduledOutput],commandSha256:sha256File(adapterScript),outputs:[scheduledOutput],resources:['ioHeavy'],prerequisites:[],safeToAutoExecute:true,allowParallel:false};
 const execution={schemaVersion:'1.0',kind:'kacha-efficiency-execution-plan',projectRoot:root,authorization:{localExecution:true,upload:false,paidGeneration:false,publish:false,overwriteSource:false},tasks:[task]};
 writeJsonAtomic(executionFile,execution);
 const scheduled=JSON.parse(cli('kacha.mjs',['efficiency','execute',executionFile]).stdout);assert.equal(scheduled.report.status,'pass');assert.ok(fs.readdirSync(path.join(root,'.kacha/jobs')).some(id=>id.startsWith('eff-probe')));
 task.argv.push('--arbitrary','command');writeJsonAtomic(executionFile,execution);const unsafe=spawnSync(process.execPath,[path.join(repo,'scripts/kacha.mjs'),'efficiency','execute',executionFile],{encoding:'utf8'});assert.notEqual(unsafe.status,0);assert.match(unsafe.stderr,/exactly spec/);
 // Preview shares the canonical renderer and jobs. Identical in-flight requests deduplicate.
 const request=requestRealPreview(timeline,{start:.4,end:1.2,expectedSha256:sha256File(timeline)});
 const duplicate=requestRealPreview(timeline,{start:.4,end:1.2,expectedSha256:sha256File(timeline)});assert.equal(request.key,duplicate.key);assert.equal(duplicate.deduplicated,true);
 let status=duplicate;const deadline=Date.now()+45000;
 while(!status.ready&&['queued','running'].includes(status.status)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,250));status=realPreviewStatus(timeline,request.key);}
 assert.equal(status.ready,true,JSON.stringify(status));assert.ok(fs.existsSync(status.output));
 plan.projectId='changed';writeJsonAtomic(timeline,plan);assert.equal(realPreviewStatus(timeline,request.key).ready,false);
 console.log(JSON.stringify({status:'pass',checks:['reading-reaction-source-extension','proof-render','natural-sound-bgm-silence','j-l-actual-stems','subtitle-remap-and-ass','lip-cover-rejection','narrative-requirements','four-deterministic-adapters','job-preview-dedup','late-result-invalidation']}));
}finally{if(!process.env.KACHA_KEEP_TEST_OUTPUT)fs.rmSync(root,{recursive:true,force:true});else console.log(root);}
