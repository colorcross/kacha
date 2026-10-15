import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileIdentity, sha256File, readJson, writeJsonAtomic, resolveRuntimeCommand } from '../scripts/kacha_utils.mjs';
import { loadOrInitializeV2State, recordV2Stage, stageInputDigest } from '../scripts/workflow_state.mjs';
import { initializeMaterialProject } from '../scripts/material_project.mjs';
import { readyStages, effectiveExecutionFlow } from '../scripts/adaptive_workflow.mjs';
import { diagnoseDialogue, diagnosisReviewDigest, validateDialogueDiagnosis, prepareDialogue, validatePreparedDialogue } from '../scripts/dialogue_diagnosis.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-workflow-simplification-'));
let count=0;
function test(name,fn){fn();count++;console.log(`PASS ${name}`);}
function json(file,value){writeJsonAtomic(file,value);return file;}
function cli(args,ok=true){const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});if(ok)assert.equal(r.status,0,r.stderr+r.stdout);else assert.notEqual(r.status,0,r.stdout);return r;}
function fixture(name){const dir=path.join(temp,name);fs.mkdirSync(dir);const source=path.join(dir,'source.bin');fs.writeFileSync(source,'source');
 const proposal=json(path.join(dir,'proposal.json'),{workflowPolicy:{version:'adaptive-v1'},goal:{hasSpokenDialogue:true},planModules:{}});
 const timeline=json(path.join(dir,'timeline.json'),{source:{path:source},edl:[{sourceStart:0,sourceEnd:1}],audio:{bgm:{gainDb:-20}},visual:{},output:{fps:25}});
 const cover=json(path.join(dir,'cover.json'),{title:'first'});
 const file=json(path.join(dir,'project.json'),{schemaVersion:'2.0',projectId:name,workflowPolicy:{version:'adaptive-v1'},source:{path:source},productionPack:'clean-editorial',show:'talking-head',plans:{proposal,timeline,coverIdentity:cover},outputs:{finalVideo:{path:path.join(dir,'final.mp4')}},expectedMedia:{fps:25}});
 const stateFile=path.join(dir,'state.json');let i=0;
 const snapshot=()=>loadOrInitializeV2State(file,stateFile).state;
 const record=(id,token=stageInputDigest(snapshot(),id))=>recordV2Stage({stateFile,stage:id,status:'complete',expectedInputDigest:token,evidenceFile:json(path.join(dir,`proof-${++i}.json`),{fixture:name,stage:id,attempt:i})});
 const complete=()=>{for(let n=0;n<20;n++){const s=snapshot(),ready=readyStages(s);if(!ready.length)return s;for(const id of ready)record(id);}throw Error('cycle');};
 return {dir,file,proposal,timeline,cover,source,stateFile,snapshot,record,complete};
}
try{
 test('independent cover can finish while transcript remains pending; dependencies still enforced',()=>{
  const f=fixture('parallel');f.record('inventory');assert.deepEqual(readyStages(f.snapshot()),['transcript_structure','cover']);f.record('cover');assert.equal(f.snapshot().stages.transcript_structure.status,'pending');assert.throws(()=>f.record('final_mix'),/前置阶段/);
 });
 test('not-applicable nodes preserve ancestor dependencies for silent montage',()=>{
  const f=fixture('silent');const p=readJson(f.proposal);p.goal.hasSpokenDialogue=false;json(f.proposal,p);
  assert.deepEqual(readyStages(f.snapshot()),['inventory']);assert.throws(()=>f.record('rough_cut'),/前置阶段/);f.record('inventory');assert(readyStages(f.snapshot()).includes('rough_cut'));
 });
 test('music-only change preserves picture, captions, transcript and cover',()=>{
  const f=fixture('music');f.complete();const timeline=readJson(f.timeline);timeline.audio.bgm.gainDb=-25;json(f.timeline,timeline);const s=f.snapshot();
  for(const id of ['inventory','rough_cut','fine_cut','visual_packaging','subtitles','cover'])assert.equal(s.stages[id].status,'complete',id);
  for(const id of ['final_mix','preview_render','final_qc','release_package'])assert.equal(s.stages[id].status,'pending',id);
 });
 test('cover-only change preserves actual video workflow and invalidates release',()=>{
  const f=fixture('cover');f.complete();json(f.cover,{title:'second'});const s=f.snapshot();assert.equal(s.stages.final_qc.status,'complete');assert.equal(s.stages.cover.status,'pending');assert.equal(s.stages.release_package.status,'pending');
 });
 test('source file bytes, brand and runtime changes invalidate previous work',()=>{
  for(const kind of ['source','brand','runtime']){const f=fixture(kind);f.complete();if(kind==='source')fs.appendFileSync(f.source,'changed');else{const p=readJson(f.file);if(kind==='brand')p.productionPack='dahui-ai';else p.runtimeLock={digest:'changed'};json(f.file,p);}assert.equal(f.snapshot().stages.inventory.status,'pending',kind);}
 });
 test('changed completion evidence invalidates only dependency closure',()=>{
  const f=fixture('evidence');f.complete();const before=f.snapshot();fs.appendFileSync(before.stages.cover.evidence.path,' ');const after=f.snapshot();assert.equal(after.stages.cover.status,'pending');assert.equal(after.stages.final_qc.status,'complete');assert.equal(after.stages.release_package.status,'pending');
 });
 test('late results cannot mark changed inputs complete even after another snapshot',()=>{
  const f=fixture('late');f.record('inventory');const old=stageInputDigest(f.snapshot(),'cover');json(f.cover,{title:'late'});f.snapshot();assert.throws(()=>f.record('cover',old),/阶段输入/);assert.equal(f.snapshot().stages.cover.status,'pending');f.record('cover');
 });
 test('known timeline contract hashes do not turn cover-only edits into a video rebuild',()=>{
  const f=fixture('linked-contract');const t=readJson(f.timeline);t.contracts={proposal:fileIdentity(f.proposal)};json(f.timeline,t);f.complete();
  const p=readJson(f.proposal);p.planModules.cover={rationale:'new cover'};json(f.proposal,p);t.contracts.proposal=fileIdentity(f.proposal);json(f.timeline,t);
  const s=f.snapshot();assert.equal(s.stages.final_qc.status,'complete');assert.equal(s.stages.cover.status,'pending');
 });
 test('re-recording upstream evidence invalidates every dependent completion',()=>{
  const f=fixture('rerecord');f.complete();f.record('rough_cut');const s=f.snapshot();assert.equal(s.stages.rough_cut.status,'complete');assert.equal(s.stages.cover.status,'complete');
  for(const id of ['fine_cut','connection_qc','final_qc','release_package'])assert.equal(s.stages[id].status,'pending',id);
 });
 test('new candidate bytes invalidate final QC but retain production and cover',()=>{
  const f=fixture('candidate');const candidate=readJson(f.file).outputs.finalVideo.path;fs.writeFileSync(candidate,'first');f.complete();fs.writeFileSync(candidate,'second');const s=f.snapshot();assert.equal(s.stages.preview_render.status,'complete');assert.equal(s.stages.cover.status,'complete');assert.equal(s.stages.final_qc.status,'pending');
 });
 test('unknown plan changes conservatively invalidate and stale proposal passed evidence cannot revive work',()=>{
  const f=fixture('unknown');f.complete();const p=readJson(f.file);p.plans.unknown=json(path.join(f.dir,'unknown.json'),{newRule:true});json(f.file,p);assert.equal(f.snapshot().stages.inventory.status,'pending');
 });
 test('adaptive proposal derives stages, legacy preserves required explicit flow',()=>{
  const p=readJson(path.join(root,'examples/edit-proposal.json'));p.workflowPolicy={version:'adaptive-v1'};delete p.executionFlow;
  const file=json(path.join(temp,'proposal-validate.json'),p);cli(['scripts/validate_edit_proposal.mjs',file]);assert.equal(effectiveExecutionFlow(p).length,13);
  delete p.workflowPolicy;json(file,p);cli(['scripts/validate_edit_proposal.mjs',file],false);
 });
 test('same capability profile routes Codex and Claude identically',()=>{
  const profile=json(path.join(temp,'capabilities.json'),{schemaVersion:'1.0',evidence:'synthetic local capability fixture',imageInput:true,audioInput:false,videoInput:false});
  const args=['scripts/prepare_agent_packet.mjs','--task','proposal_review','--modules','visual','--model-tier','frontier','--capabilities',profile];
  const a=JSON.parse(cli([...args,'--agent','codex']).stdout),b=JSON.parse(cli([...args,'--agent','claude']).stdout);
  assert.deepEqual(a.readOrder,b.readOrder);assert.deepEqual(a.visualEvidencePolicy,b.visualEvidencePolicy);assert(!b.supportModules.includes('claude_visual'));assert.equal(a.executionMode,'adaptive');
 });
 test('guided mode remains bounded and missing capability never claims perception',()=>{
  const p=JSON.parse(cli(['scripts/prepare_agent_packet.mjs','--task','source_edit','--modules','visual','--model-tier','economy','--stage','inventory']).stdout);assert.equal(p.executionMode,'guided');assert.equal(p.capabilities.imageInput,'unknown');assert(p.supportModules.includes('low_model'));assert(p.visualEvidencePolicy.inputPolicy.includes('未知'));assert(p.readOrder.some(file=>file.endsWith('stages/inventory.md')));
  const contract=fs.readFileSync(path.join(root,'references/stages/inventory.md'),'utf8');assert(contract.includes('先诊断'));assert(!contract.includes('真人口播先运行'));
  const video=JSON.parse(cli(['scripts/prepare_agent_packet.mjs','--task','source_edit','--modules','video_generation']).stdout);assert.equal(video.visualEvidencePolicy.required,true);
 });
 const source=path.join(temp,'dialogue.wav');const ff=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=400:duration=1:sample_rate=48000','-c:a','pcm_f32le',source],{encoding:'utf8'});assert.equal(ff.status,0,ff.stderr);
 const timelineFile=json(path.join(temp,'audio-timeline.json'),{source:{path:source},edl:[{sourceStart:0,sourceEnd:1}],output:{fps:25}});
 let diagnosis=diagnoseDialogue(source),diagnosisFile=path.join(temp,'diagnosis.json');
 test('actual decode never fabricates semantic listening approval',()=>{assert.equal(diagnosis.technical.decoded,true);assert.equal(diagnosis.review.status,'pending');assert(validateDialogueDiagnosis(diagnosis,{mode:'passthrough'}).length>0);});
 // Synthetic fixture approval tests the contract only, not human speech quality.
 diagnosis.review={status:'pass',reviewer:'synthetic-test',reviewedAt:new Date().toISOString(),subjectDigest:diagnosisReviewDigest(diagnosis),reason:'synthetic sound fixture',checks:{speechIntact:true,noBackgroundMusic:true,noCompetingSpeech:true,cleanRecording:true,lightProcessingAppropriate:true}};json(diagnosisFile,diagnosis);
 test('passthrough makes a real PCM stem, refuses overwrite and binds current diagnosis',()=>{
  const output=path.join(temp,'passthrough.wav');const receipt=prepareDialogue({diagnosisFile,timelineFile,output,mode:'passthrough'});assert.equal(receipt.sourceSeparated,false);assert.throws(()=>prepareDialogue({diagnosisFile,timelineFile,output,mode:'passthrough'}),/覆盖/);
  const proposal={workflowPolicy:{version:'adaptive-v1'},planModules:{dialogueAudio:{processing:{mode:'passthrough',diagnosis:fileIdentity(diagnosisFile),preparation:fileIdentity(`${output}.json`)}}}};
  assert.deepEqual(validatePreparedDialogue(proposal,path.join(temp,'p.json'),{...readJson(timelineFile),audio:{dialogue:{path:output}}},path.join(temp,'t.json')),[]);
  assert(validatePreparedDialogue(proposal,path.join(temp,'p.json'),{...readJson(timelineFile),audio:{dialogue:{path:source}}},path.join(temp,'t.json')).length>0);
  const pcm=f=>spawnSync('ffmpeg',['-v','error','-i',f,'-f','f32le','-'],{maxBuffer:1024*1024}).stdout;assert.deepEqual(pcm(source),pcm(output));
 });
 test('light-processing output remains a candidate until actual output review',()=>{
  const output=path.join(temp,'light.wav');prepareDialogue({diagnosisFile,timelineFile,output,mode:'light'});
  const proposal={workflowPolicy:{version:'adaptive-v1'},planModules:{dialogueAudio:{processing:{mode:'light',diagnosis:fileIdentity(diagnosisFile),preparation:fileIdentity(`${output}.json`)}}}};
  assert(validatePreparedDialogue(proposal,path.join(temp,'p.json'),{...readJson(timelineFile),audio:{dialogue:{path:output}}},path.join(temp,'t.json')).some(s=>s.includes('A/B')));
 });
 test('prepared dialogue follows cuts, sparse transitions and rejects stale or other-source mapping',()=>{
  const src=path.join(temp,'two-tones.wav');const result=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=400:duration=2:sample_rate=48000','-f','lavfi','-i','sine=frequency=1000:duration=2:sample_rate=48000','-filter_complex','[0:a][1:a]concat=n=2:v=0:a=1[a]','-map','[a]','-c:a','pcm_f32le',src],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const d=diagnoseDialogue(src);d.review={...diagnosis.review,subjectDigest:diagnosisReviewDigest(d)};
  const df=json(path.join(temp,'tones-diagnosis.json'),d),tf=json(path.join(temp,'tones-timeline.json'),{source:{path:src},edl:[{id:'tail',sourceStart:2,sourceEnd:4}],output:{fps:25}}),out=path.join(temp,'tail.wav');
  prepareDialogue({diagnosisFile:df,timelineFile:tf,output:out,mode:'passthrough'});
  const raw=spawnSync('ffmpeg',['-v','error','-i',out,'-f','f32le','-'],{maxBuffer:2*1024*1024}).stdout;
  let crossings=0;for(let i=4801;i<24000;i++)if(raw.readFloatLE((i-1)*4)<0&&raw.readFloatLE(i*4)>=0)crossings++;assert(Math.abs(crossings/.4-1000)<5);
  const p={workflowPolicy:{version:'adaptive-v1'},planModules:{dialogueAudio:{processing:{mode:'passthrough',diagnosis:fileIdentity(df),preparation:fileIdentity(`${out}.json`)}}}};
  const t={...readJson(tf),audio:{dialogue:{path:out}}};assert.deepEqual(validatePreparedDialogue(p,tf,t,tf),[]);
  t.edl[0].sourceStart=1;assert(validatePreparedDialogue(p,tf,t,tf).some(e=>e.includes('映射')));
  t.source.path=source;assert(validatePreparedDialogue(p,tf,t,tf).some(e=>e.includes('源不一致')));
  const mixed={source:{path:src},output:{fps:25},edl:[{id:'a',sourceStart:0,sourceEnd:1},{id:'b',sourceStart:1,sourceEnd:2},{id:'c',sourceStart:2,sourceEnd:4}],transitions:[{afterClipId:'b',effectId:'fade',durationFrames:5}]};json(tf,mixed);
  const r=prepareDialogue({diagnosisFile:df,timelineFile:tf,output:path.join(temp,'transitions.wav'),mode:'passthrough'});assert.equal(r.mapping.durationSeconds,3.8);assert.equal(r.mapping.transitions[0].durationSeconds,0);assert.equal(r.mapping.transitions[1].durationSeconds,.2);
 });
 test('source audio starting one second late preserves silence and output duration',()=>{
  const src=path.join(temp,'offset.mov'),r=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=160x90:r=25:d=3','-itsoffset','1','-f','lavfi','-i','sine=frequency=600:duration=2:sample_rate=48000','-map','0:v','-map','1:a','-c:v','libx264','-c:a','pcm_s16le',src],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const d=diagnoseDialogue(src);d.review={...diagnosis.review,subjectDigest:diagnosisReviewDigest(d)};
  const df=json(path.join(temp,'offset-diagnosis.json'),d),tf=json(path.join(temp,'offset-timeline.json'),{source:{path:src},edl:[{sourceStart:0,sourceEnd:3}],output:{fps:25}}),out=path.join(temp,'offset.wav');
  prepareDialogue({diagnosisFile:df,timelineFile:tf,output:out,mode:'passthrough'});
  const raw=spawnSync('ffmpeg',['-v','error','-i',out,'-f','f32le','-'],{maxBuffer:2*1024*1024}).stdout;assert.equal(raw.length,3*48000*4);
  let early=0,late=0;for(let i=0;i<24000;i++){early+=Math.abs(raw.readFloatLE(i*4));late+=Math.abs(raw.readFloatLE((i+72000)*4));}assert.equal(early,0);assert(late>100);
 });
 test('proposal blockers cannot be overridden and contract edits invalidate only descendants',()=>{
  const f=fixture('proposal-blocks'),p=readJson(f.proposal);p.executionFlow=effectiveExecutionFlow(p);json(f.proposal,p);f.complete();
  const cover=p.executionFlow.find(s=>s.id==='cover');cover.status='blocked';json(f.proposal,p);
  assert.equal(f.snapshot().stages.cover.status,'blocked');assert.throws(()=>f.record('cover'),/方案仍阻断/);
  cover.status='pending';json(f.proposal,p);assert.equal(f.snapshot().stages.cover.status,'pending');f.complete();
  for(const key of ['gate','deliverable']){cover[key]+=' new requirement';json(f.proposal,p);const s=f.snapshot();assert.equal(s.stages.cover.status,'pending');assert.equal(s.stages.release_package.status,'pending');assert.equal(s.stages.final_qc.status,'complete');f.complete();}
  cover.status='passed';json(f.proposal,p);assert.equal(f.snapshot().stages.cover.status,'complete');
 });
 test('next surfaces a blocked prerequisite and custom snapshot keeps its own state and token',()=>{
  const f=fixture('cli-state');const p=readJson(path.join(root,'examples/edit-proposal.json'));p.workflowPolicy={version:'adaptive-v1'};delete p.executionFlow;json(f.proposal,p);
  const project=readJson(f.file);project.plans.editPlan=json(path.join(f.dir,'edit.json'),readJson(path.join(root,'examples/edit-plan.json')));json(f.file,project);
  f.record('inventory');const report=JSON.parse(cli(['scripts/project_state.mjs','snapshot',f.file,'--output',f.stateFile]).stdout);
  assert.equal(report.nextAction.stage,'transcript_structure');assert.equal(report.nextAction.stateFile,f.stateFile);assert(report.nextAction.recordCommandTemplate.includes(f.stateFile));assert.equal(report.nextAction.expectedInputDigest,stageInputDigest(f.snapshot(),'transcript_structure'));
  for(const id of ['transcript_structure','rough_cut','dialogue_preprocess','cover'])f.record(id);
  recordV2Stage({stateFile:f.stateFile,stage:'fine_cut',status:'blocked',expectedInputDigest:stageInputDigest(f.snapshot(),'fine_cut'),evidenceFile:json(path.join(f.dir,'block.json'),{reason:'fixture'})});
  const next=JSON.parse(cli(['scripts/next_action.mjs',f.file,'--state-file',f.stateFile]).stdout);assert.equal(next.nextAction.id,'resolve_blocked_stage');assert.equal(next.nextAction.stage,'fine_cut');f.record('fine_cut');
 });
 test('upstream re-record removes stale downstream decisions immediately',()=>{
  const f=fixture('decisions');f.complete();recordV2Stage({stateFile:f.stateFile,stage:'release_package',status:'complete',expectedInputDigest:stageInputDigest(f.snapshot(),'release_package'),evidenceFile:json(path.join(f.dir,'release.json'),{}),decision:'approved fixture'});
  assert.equal(readJson(f.stateFile).decisions.length,1);const s=f.record('cover');assert.equal(s.decisions.length,0);assert.equal(readJson(f.stateFile).decisions.length,0);
 });
 test('compact v3 packets retain the incremental contract without adaptive proposal defaults',()=>{
  const p=JSON.parse(cli(['scripts/prepare_agent_packet.mjs','--task','local_optimization','--project','examples/incremental-project.json','--model-tier','economy']).stdout);
  assert.equal(p.workflow,'v3_incremental');assert.equal(p.resolvedContract.workflowPolicy,'incremental-v3');assert.deepEqual(p.resolvedContract.proposalDefaults,{preserveExisting:true});assert(p.readOrder.some(f=>f.endsWith('incremental-workflow.md')));assert(p.resolvedContract.decisionSource.includes('version-delta'));
 });
 test('existing project family overrides a generic task and material editing prepares its own contracts',()=>{
  const p=JSON.parse(cli(['scripts/prepare_agent_packet.mjs','--task','source_edit','--project','examples/incremental-project.json','--model-tier','economy']).stdout);
  assert.equal(p.task,'local_optimization');assert.equal(p.requestedTask,'source_edit');assert.equal(p.workflow,'v3_incremental');assert(!p.executionProtocol.join(' ').includes('availableStages'));assert(!p.readOrder.some(f=>f.endsWith('stages/edit.md')));assert(p.readOrder.some(f=>f.endsWith('incremental-workflow.md')));
  for(const tier of ['economy','frontier']){const m=JSON.parse(cli(['scripts/prepare_agent_packet.mjs','--task','material_edit','--model-tier',tier]).stdout);assert.equal(m.workflow,'material_edit');assert(!m.executionProtocol.join(' ').includes('availableStages'));assert(!m.readOrder.some(f=>f.endsWith('stages/edit.md')));assert.equal(m.resolvedContract.workflowPolicy,'material-v1');assert.deepEqual(m.resolvedContract.proposalDefaults,{preserveExisting:true});assert.equal(m.artifactProtocol.preferredCompiler,'kacha.mjs materials compose');assert(m.readOrder.some(f=>f.endsWith('material-editing.md')));assert(!m.artifactProtocol.stableInputs.includes('edit-proposal.json'));}
 });
 test('dialogue transitions use render FPS including explicit timebase and fractional source',()=>{
  for(const [name,rate,output,timebase] of [['default',30,{},undefined],['timebase',30,{fps:30},{ticksPerSecond:90000,frameRate:{numerator:25,denominator:1}}],['fractional','30000/1001',{},undefined]]){
   const src=path.join(temp,`${name}.mov`);const r=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=black:s=160x90:r=${rate}:d=3`,'-f','lavfi','-i','sine=frequency=600:duration=3:sample_rate=48000','-c:v','libx264','-c:a','pcm_s16le',src],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
   const d=diagnoseDialogue(src);d.review={...diagnosis.review,subjectDigest:diagnosisReviewDigest(d)};const df=json(path.join(temp,`${name}-diagnosis.json`),d);
   const tf=json(path.join(temp,`${name}-timeline.json`),{schemaVersion:'1.0',projectId:name,mode:'preview',source:{path:src},edl:[{id:'a',sourceStart:0,sourceEnd:1.5},{id:'b',sourceStart:1.5,sourceEnd:3}],transitions:[{boundaryIndex:0,effectId:'soft_dissolve',durationFrames:15}],visual:{},audio:{},output:{width:160,height:90,path:path.join(temp,`${name}.mp4`),...output},...(timebase?{timebase}:{})});
   const receipt=prepareDialogue({diagnosisFile:df,timelineFile:tf,output:path.join(temp,`${name}.wav`),mode:'passthrough'});
   const compiled=JSON.parse(cli(['scripts/timeline_ir.mjs','compile','--plan',tf]).stdout),graph=readJson(compiled.output);assert(Math.abs(receipt.mapping.durationSeconds-graph.durationSeconds)<.00001);assert(Math.abs(receipt.mapping.transitions[0].durationSeconds-graph.transitions[0].durationSeconds)<.00001);
  }
 });
 test('actual material project preparation reads material status instead of rejecting its schema',()=>{
  const projectRoot=path.join(temp,'actual-material'),src=path.join(temp,'default.mov');
  initializeMaterialProject({materials:[src],requirements:'synthetic material routing fixture',projectRoot,duration:3,width:160,development:true});
  const p=JSON.parse(cli(['scripts/prepare_agent_packet.mjs','--task','source_edit','--project',path.join(projectRoot,'.kacha/material-project.json'),'--model-tier','economy']).stdout);
  assert.equal(p.workflow,'material_edit');assert.equal(p.projectState.kind,'kacha-material-project-status');assert.equal(p.projectState.status,'awaiting_storyboard');assert(!p.projectState.diagnostics?.length);
 });
 test('receipt publication failure rolls back owned audio and retry succeeds without overwriting others',()=>{
  const output=path.join(temp,'retry.wav'),link=fs.linkSync;
  try{fs.linkSync=(from,to)=>{if(to===`${output}.json`)throw new Error('synthetic receipt ENOSPC');return link(from,to);};assert.throws(()=>prepareDialogue({diagnosisFile,timelineFile,output,mode:'passthrough'}),/ENOSPC/);}finally{fs.linkSync=link;}
  assert(!fs.existsSync(output));assert(!fs.existsSync(`${output}.json`));prepareDialogue({diagnosisFile,timelineFile,output,mode:'passthrough'});
  const other=path.join(temp,'occupied.wav');fs.writeFileSync(`${other}.json`,'keep');assert.throws(()=>prepareDialogue({diagnosisFile,timelineFile,output:other,mode:'passthrough'}),/覆盖/);assert.equal(fs.readFileSync(`${other}.json`,'utf8'),'keep');
 });
 test('approval withdrawn during processing cannot publish a stem or receipt',()=>{
  const output=path.join(temp,'withdrawn.wav'),wrapper=path.join(temp,'withdraw-wrapper.mjs'),previous=process.env.KACHA_FFMPEG_BIN;
  fs.writeFileSync(wrapper,`#!${process.execPath}\nimport {spawnSync} from 'node:child_process'; import fs from 'node:fs'; const r=spawnSync(${JSON.stringify(resolveRuntimeCommand('ffmpeg'))},process.argv.slice(2),{stdio:'inherit'}); if(r.status)process.exit(r.status); const file=${JSON.stringify(diagnosisFile)},d=JSON.parse(fs.readFileSync(file));d.review.status='pending';fs.writeFileSync(file,JSON.stringify(d));\n`);fs.chmodSync(wrapper,0o755);
  try{process.env.KACHA_FFMPEG_BIN=wrapper;assert.throws(()=>prepareDialogue({diagnosisFile,timelineFile,output,mode:'passthrough'}),/诊断已改变/);}
  finally{if(previous===undefined)delete process.env.KACHA_FFMPEG_BIN;else process.env.KACHA_FFMPEG_BIN=previous;json(diagnosisFile,diagnosis);}
  assert(!fs.existsSync(output));assert(!fs.existsSync(`${output}.json`));
 });
 test('multi-track diagnosis requires explicit stream and preparation preserves that selection',()=>{
  const src=path.join(temp,'multitrack.mkv');const r=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=400:duration=1:sample_rate=48000','-f','lavfi','-i','sine=frequency=1000:duration=1:sample_rate=48000','-map','0:a','-map','1:a','-c:a','pcm_s16le',src],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  assert.throws(()=>diagnoseDialogue(src),/多音轨/);assert.throws(()=>diagnoseDialogue(src,{audioStreamIndex:9}),/不存在/);
  const d=diagnoseDialogue(src,{audioStreamIndex:1});d.review={...diagnosis.review,subjectDigest:diagnosisReviewDigest(d)};const df=json(path.join(temp,'multi-diagnosis.json'),d),tf=json(path.join(temp,'multi-timeline.json'),{source:{path:src},edl:[{sourceStart:0,sourceEnd:1}]}),output=path.join(temp,'selected.wav');
  const receipt=prepareDialogue({diagnosisFile:df,timelineFile:tf,output,mode:'passthrough'});assert.equal(receipt.audioStreamIndex,1);
  const other=diagnoseDialogue(src,{audioStreamIndex:0});other.review={...diagnosis.review,subjectDigest:diagnosisReviewDigest(other)};const otherFile=json(path.join(temp,'other-track.json'),other);
  receipt.diagnosis=fileIdentity(otherFile);json(`${output}.json`,receipt);
  const p={workflowPolicy:{version:'adaptive-v1'},planModules:{dialogueAudio:{processing:{mode:'passthrough',diagnosis:fileIdentity(otherFile),preparation:fileIdentity(`${output}.json`)}}}};
  assert(validatePreparedDialogue(p,tf,{...readJson(tf),audio:{dialogue:{path:output}}},tf).some(e=>e.includes('所选音轨不同')));
  const raw=spawnSync('ffmpeg',['-v','error','-i',output,'-f','f32le','-'],{maxBuffer:1024*1024}).stdout;let crossings=0;for(let i=4801;i<24000;i++)if(raw.readFloatLE((i-1)*4)<0&&raw.readFloatLE(i*4)>=0)crossings++;assert(Math.abs(crossings/.4-1000)<5);
 });
 test('background music, explicit separation, missing and altered diagnosis reject bypass',()=>{
  const bad=structuredClone(diagnosis);bad.review.checks.noBackgroundMusic=false;assert(validateDialogueDiagnosis(bad,{mode:'passthrough'}).length>0);
  const p=readJson(path.join(root,'examples/edit-proposal.json'));p.workflowPolicy={version:'adaptive-v1'};delete p.executionFlow;p.sourceInventory[0].path=source;
  p.planModules.dialogueAudio.processing={mode:'passthrough',diagnosis:fileIdentity(diagnosisFile)};
  const file=json(path.join(temp,'audio-proposal.json'),p);cli(['scripts/validate_edit_proposal.mjs',file],false);
  p.planModules.dialogueAudio.sourceSeparation.required=false;json(file,p);cli(['scripts/validate_edit_proposal.mjs',file]);
  fs.appendFileSync(source,'changed');assert(validateDialogueDiagnosis(diagnosis,{mode:'passthrough'}).some(s=>s.includes('身份')));
 });
 console.log(`${count} workflow simplification regressions passed`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
