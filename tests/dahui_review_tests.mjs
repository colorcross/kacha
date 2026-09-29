import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {episodeTemplate,validateEpisode} from '../scripts/episode_editorial.mjs';
import {template,validateProductionQualityContract,calculateCinematicEditorialMetrics} from '../scripts/production_quality_contract.mjs';
import {reviewTemplate} from '../scripts/editorial_review.mjs';
import {editorialTimeline} from '../scripts/editorial_timeline.mjs';
import {validateCoverIdentityContract} from '../scripts/kacha_cover.mjs';
import {ensureContentPackage,episodeForSourceHandoff,initializeProject} from '../scripts/project_orchestrator.mjs';
import {compileProductionRequest} from '../scripts/kacha_studio.mjs';
import {sha256File,writeJsonAtomic} from '../scripts/kacha_utils.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-dahui-review-'));
let count=0, serial=0;
const identity=file=>({path:file,sha256:sha256File(file)});
function write(file,data){writeJsonAtomic(file,data);return file;}
function reviewed(contract,candidate,timeline=null,kind='episode'){
 const r=reviewTemplate(contract,{candidate,timeline,kind});
 Object.assign(r,{reviewer:'synthetic regression fixture only',reviewedAt:'2026-09-29T12:00:00Z',status:'pass'});
 r.checks=Object.fromEntries(Object.keys(r.checks).map(k=>[k,'pass']));return r;
}
function fixture(){
 const dir=path.join(root,String(++serial));fs.mkdirSync(dir);
 const save=(name,data)=>write(path.join(dir,name),data);
 const proof=save('evidence.json',{synthetic:true,notProductionEvidence:true});
 const candidate=save('candidate.json',{synthetic:true,candidate:1});
 const frame=save('cover-output.json',{synthetic:true,cover:1});
 const timeline=save('timeline.json',{projectId:'review',output:{fps:25},edl:[{id:'s1',sourceStart:0,sourceEnd:30,provenance:{kind:'synthetic-test-fixture',evidence:proof}}],audio:{sfx:[]}});
 const episode=episodeTemplate('review','ai-practice');
 Object.assign(episode,{question:'测试任务',audienceTask:'测试输入',ownJudgment:'仅测试检查行为',targetSeconds:30});
 episode.context={recordedAt:'2026-09-29',toolVersion:'fixture',inputScope:'synthetic only'};
 episode.evidence.forEach(e=>Object.assign(e,identity(proof),{locator:'fixture 1',description:'synthetic fixture'}));
 episode.beats.forEach(b=>Object.assign(b,{purpose:'fixture',evidenceIds:episode.evidence.map(e=>e.id),timelineIds:['s1']}));
 episode.checks=Object.fromEntries(Object.keys(episode.checks).map(k=>[k,'pass']));
 episode.reviewEvidence=identity(save('episode-review.json',reviewed(episode,candidate,timeline)));
 const epFile=save('episode.json',episode);
 const cover={schemaVersion:'1.0',kind:'kacha-editorial-cover-contract',productionPack:'dahui-ai',projectId:'review',question:'fixture',headline:'fixture',composition:'fixture',sources:[{...identity(proof),role:'real_evidence'}],output:identity(frame),qc:{thumbnailStatus:'pass'}};
 cover.qc.reviewEvidence=identity(save('cover-review.json',reviewed(cover,frame,null,'cover')));
 const coverFile=save('cover.json',cover);
 const font=save('font-fixture.json',{synthetic:true,notARealFont:true});
 const registry=save('registry.json',{records:[{file:font,sha256:sha256File(font),families:['Noto Sans CJK SC'],license:{status:'open'}}]});
 const req=save('requirements.json',{version:'narrative-v1',requirements:[{id:'proof',priority:'required',origin:'fact',reason:'fixture',timelineIds:['s1']}]});
 const q=template('review',{packId:'dahui-ai',showId:'ai-practice',requirements:identity(req)});
 q.episodeEditorial=identity(epFile);
 const e=q.execution;
 e.timeline=identity(timeline);
 e.semanticEdit={wordTimedSource:identity(proof),reviewedThroughSeconds:30,unresolvedFragments:0,cutDecisions:[]};
 e.connections={detectedCount:0,cutSheetCount:0,auditedCount:0,unresolvedCount:0,events:[]};
 e.opening={mode:'natural',primaryNarrativeCount:1,narrativeReason:'fixture',primaryEffectCount:0,firstVisibleChangeSeconds:1,promiseSeconds:10,dynamicPreview:identity(proof)};
 e.effects={maxConcurrentPrimary:0,progressiveLists:[],behindSubjectText:[]};
 e.captions.regularStyle={...q.policies.typography.regularSubtitle,font:'Noto Sans CJK SC',fontEvidence:{file:font,sha256:sha256File(font),registryPath:registry,registrySha256:sha256File(registry)}};
 e.audio={bgmMode:'none',silenceReason:'保留论证与环境声',timelineFps:25,sfxEvents:[]};
 e.cover={mode:'editorial_2d',generationInputMode:'real_evidence',editorialContract:identity(coverFile)};
 e.firstMinute={motivatedEffects:[],humanPresenceRatio:1,fullScreenTakeoverRatio:0,breathingRoomRatio:1,peakAlignedSfxEventIds:[],humanReactionWindows:[],normalSpeedPreview:identity(proof)};
 e.cinematicEditorial={showId:'ai-practice',durationSeconds:30,events:[{id:'shot',semanticBeatId:'question',trigger:'fixture',mechanism:'clean_a_roll',sourceType:'a_roll',containerType:'none',compositionSignature:'medium',styleId:'dahui-ai',simplerAlternative:'fixture',startSeconds:0,endSeconds:30}],normalSpeedPreview:identity(proof),phoneSizeReview:{status:'pass',evidence:identity(proof)},webLikenessReview:{status:'pass',evidence:identity(proof)}};
 e.cinematicEditorial.auditMetrics=calculateCinematicEditorialMetrics(e.cinematicEditorial);
 q.release={finalTimeline:identity(timeline),finalVideo:identity(candidate),stems:{dialogue:identity(proof),mix:identity(proof)},programDurationSeconds:30,bgmCoverageRatio:0,representativeNormalSpeed:{status:'pass',evidence:identity(proof)},fullPlayback:{status:'pass',evidence:identity(proof)},deviceListening:{status:'pass',evidence:identity(proof)}};
 const file=save('quality.json',q);
 const project=save('project.json',{projectId:'review',show:'ai-practice',productionPack:'dahui-ai',plans:{timeline:{path:timeline}},expectedMedia:{audioMix:{bgmRequired:false,adaptiveBgmRequired:false}},outputs:{finalVideo:{path:candidate},covers:[{path:frame}]}});
 return {dir,save,proof,candidate,timeline,episode,epFile,cover,coverFile,frame,q,file,project,font,registry};
}
function test(name,fn){fn();count++;console.log(`PASS ${name}`);}
function quality(f){write(f.file,f.q);return validateProductionQualityContract(f.file,'release',{projectFile:f.project});}
function rejects(result,pattern){assert.equal(result.status,'fail',JSON.stringify(result));assert(result.errors.some(e=>pattern.test(e)),JSON.stringify(result.errors));}
try {
 test('complete no-music, no-SFX editorial release passes through the real quality gate',()=>{
  const f=fixture();assert.deepEqual(quality(f).errors,[]);
 });
 test('short source-led video does not require a second decorative mechanism',()=>{
  const f=fixture();assert.deepEqual(validateProductionQualityContract(f.file,'execution').errors,[]);
 });
 test('selected authorized fallback font is accepted but changed bytes are rejected',()=>{
  const f=fixture();assert.deepEqual(quality(f).errors,[]);fs.appendFileSync(f.font,' ');rejects(quality(f),/实际字体|sha256/);
 });
 test('an unrelated or unauthorized font registry cannot approve a font',()=>{
  const f=fixture();write(f.registry,{records:[]});f.q.execution.captions.regularStyle.fontEvidence.registrySha256=sha256File(f.registry);rejects(quality(f),/字体/);
 });
 test('missing or nonnumeric opening measurements fail closed',()=>{
  const f=fixture();delete f.q.execution.opening.promiseSeconds;rejects(quality(f),/opening/);
 });
 test('timeline counts, duration, fps and ratios cannot be invented',()=>{
  const f=fixture();f.q.execution.connections.detectedCount=5;f.q.execution.audio.timelineFps=30;f.q.execution.cinematicEditorial.durationSeconds=31;f.q.execution.firstMinute.humanPresenceRatio=null;
  const r=quality(f);for(const re of [/连接点/,/帧率/,/审计时长/,/实际比例/]) rejects(r,re);
 });
 test('music present in the timeline cannot masquerade as no music',()=>{
  const f=fixture(), t=JSON.parse(fs.readFileSync(f.timeline));t.audio.bgm={path:f.proof,enabled:false};write(f.timeline,t);f.q.execution.timeline=identity(f.timeline);rejects(quality(f),/bgmMode/);
 });
 test('explicit project music requirement cannot be silently omitted',()=>{
  const f=fixture(),p=JSON.parse(fs.readFileSync(f.project));p.expectedMedia.audioMix.bgmRequired=true;write(f.project,p);rejects(quality(f),/项目要求配乐/);
 });
 test('intentional music and silence both follow the actual timeline',()=>{
  const f=fixture(),t=JSON.parse(fs.readFileSync(f.timeline)),p=JSON.parse(fs.readFileSync(f.project));
  t.audio.bgm={adaptivePlan:identity(f.proof),segments:[{path:f.proof,start:0,end:15}]};write(f.timeline,t);
  Object.assign(f.q.execution.audio,{bgmMode:'music',adaptivePlan:identity(f.proof),promptFields:Object.fromEntries(f.q.policies.audio.professionalPromptFields.map(k=>[k,'fixture']))});
  f.q.execution.timeline=identity(f.timeline);f.q.release.finalTimeline=identity(f.timeline);f.q.release.stems.bgm=identity(f.proof);f.q.release.bgmCoverageRatio=0.5;f.q.release.intentionalSilences=[{startSeconds:15,endSeconds:30,reason:'论证留白'}];
  p.expectedMedia.audioMix={bgmRequired:true,adaptiveBgmRequired:true};write(f.project,p);
  f.episode.reviewEvidence=identity(f.save('music-review.json',reviewed(f.episode,f.candidate,f.timeline)));write(f.epFile,f.episode);f.q.episodeEditorial=identity(f.epFile);
  assert.deepEqual(quality(f).errors,[]);f.q.release.bgmCoverageRatio=1;rejects(quality(f),/实际配乐区间/);
 });
 test('visual CLI infers the new brand from the show',()=>{
  const file=path.join(root,'visual-reading.json'),r=spawnSync(process.execPath,['scripts/visual_capability_plan.mjs','template','--show','ai-reading','--duration','2700','--output',file],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const v=JSON.parse(fs.readFileSync(file));assert.equal(v.styleProfile,'dahui-ai');assert.equal(v.policy.openingContract.promiseBySeconds,45);
 });
 test('invalid narrative requirements cannot be bound into a valid episode contract',()=>{
  const f=fixture(),before=fs.readFileSync(f.file,'utf8'),r=spawnSync(process.execPath,['scripts/kacha_episode.mjs','bind','--episode',f.epFile,'--contract',f.file,'--requirements',f.proof],{encoding:'utf8'});
  assert.equal(r.status,1);assert.equal(fs.readFileSync(f.file,'utf8'),before);
 });
 test('changed candidate invalidates a previously passing full review',()=>{
  const f=fixture();write(f.candidate,{synthetic:true,candidate:2});f.q.release.finalVideo=identity(f.candidate);rejects(quality(f),/终审 candidate/);
 });
 test('changed timeline invalidates an old review even after quality identities are rebound',()=>{
  const f=fixture(),t=JSON.parse(fs.readFileSync(f.timeline));t.note='new edit';write(f.timeline,t);f.q.execution.timeline=identity(f.timeline);f.q.release.finalTimeline=identity(f.timeline);rejects(quality(f),/终审 timeline/);
 });
 test('changed interpretation invalidates the content-specific review',()=>{
  const f=fixture();f.episode.ownJudgment='new judgment';write(f.epFile,f.episode);f.q.episodeEditorial=identity(f.epFile);rejects(quality(f),/当前节目/);
 });
 test('a text file is not an editorial review receipt',()=>{
  const f=fixture();f.episode.reviewEvidence=identity(f.proof);write(f.epFile,f.episode);f.q.episodeEditorial=identity(f.epFile);rejects(quality(f),/终审/);
 });
 test('cover approval binds actual output and current composition',()=>{
  const f=fixture();assert.equal(validateCoverIdentityContract(f.coverFile,{requireQcPass:true}).status,'pass');f.cover.headline='changed';write(f.coverFile,f.cover);rejects(validateCoverIdentityContract(f.coverFile,{requireQcPass:true}),/当前节目/);
 });
 test('a declared thumbnail pass without the actual reviewed file cannot pass',()=>{
  const f=fixture();delete f.cover.qc.reviewEvidence;write(f.coverFile,f.cover);rejects(validateCoverIdentityContract(f.coverFile,{requireQcPass:true}),/终审记录/);
 });
 test('each delivered platform cover needs its own reviewed output',()=>{
  const f=fixture(),p=JSON.parse(fs.readFileSync(f.project));p.outputs.covers.push({path:f.candidate});write(f.project,p);rejects(quality(f),/交付封面/);
 });
 test('different project and production pack cannot borrow the old quality contract',()=>{
  const f=fixture();const old=f.save('legacy.json',template('other',{packId:'xingzhe-dahui',showId:'tool-share'}));
  const r=validateProductionQualityContract(old,'plan',{projectFile:f.project});for(const re of [/projectId/,/productionPack/,/show/]) rejects(r,re);
 });
 test('release must use the project timeline and final output',()=>{
  const f=fixture(),p=JSON.parse(fs.readFileSync(f.project));p.plans.timeline.path=f.proof;p.outputs.finalVideo.path=f.proof;write(f.project,p);const r=quality(f);rejects(r,/实际时间线/);rejects(r,/当前交付/);
 });
 test('canonical tick-only timeline is supported and contradictory seconds are rejected',()=>{
  const t={timebase:{ticksPerSecond:120000,frameRate:{numerator:25,denominator:1}},edl:[{id:'a',sourceStartTick:0,sourceEndTick:216000000}]};
  assert.equal(editorialTimeline(t).duration,1800);t.edl[0].sourceEnd=2400;assert.throws(()=>editorialTimeline(t),/半帧/);
 });
 test('transition aliases and duplicate boundaries match render last-declaration semantics',()=>{
  const t={output:{fps:25},edl:[{id:'a',sourceStart:0,sourceEnd:901},{id:'b',sourceStart:0,sourceEnd:900}],transitions:Array.from({length:6},()=>({afterClipId:'a',durationFrames:10}))};
  assert.equal(editorialTimeline(t).duration,1800.6);
 });
 test('a fabricated master stub cannot bypass full-book constraints as a derivative',()=>{
  const f=fixture();f.episode.deliverable='derivative';f.episode.sourceMaster={...identity(f.save('stub.json',{deliverable:'master',projectId:'parent',pack:{showId:'ai-practice'}})),projectId:'parent',contextPreserved:'fixture'};
  write(f.epFile,f.episode);rejects(validateEpisode(f.epFile),/母片/);
 });
 test('valid derivative retains reviewed parent, and stale parent approval fails',()=>{
  const f=fixture(),d=structuredClone(f.episode);d.projectId='child';d.deliverable='derivative';d.sourceMaster={...identity(f.epFile),projectId:'review',contextPreserved:'fixture conditions',timeline:identity(f.timeline),candidate:identity(f.candidate)};
  d.evidence=[{...identity(f.candidate),id:'source-excerpt',kind:'source-excerpt',locator:'fixture range',description:'synthetic excerpt'}];
  d.beats=['excerpt','context','judgment'].map(role=>({id:role,role,purpose:'fixture',evidenceIds:['source-excerpt'],timelineIds:['s1']}));
  const timeline=f.save('child-timeline.json',{projectId:'child',edl:[{id:'s1',sourceStart:0,sourceEnd:20}],output:{fps:25}}),candidate=f.save('child-candidate.json',{synthetic:true});
  d.reviewEvidence=identity(f.save('child-review.json',reviewed(d,candidate,timeline)));
  const file=f.save('child.json',d);assert.deepEqual(validateEpisode(file,{stage:'release',timeline,candidate}).errors,[]);
  f.episode.ownJudgment='changed';write(f.epFile,f.episode);d.sourceMaster.sha256=sha256File(f.epFile);write(file,d);rejects(validateEpisode(file,{stage:'release',timeline,candidate}),/母片.*终审/);
 });
 test('book content planning retains every paragraph and includes the episode evidence framework',()=>{
  const dir=path.join(root,'content-book');fs.mkdirSync(path.join(dir,'contracts'),{recursive:true});fs.mkdirSync(path.join(dir,'.kacha'));
  const script=path.join(dir,'script.md');fs.writeFileSync(script,Array.from({length:100},(_,i)=>`第 ${i+1} 段文本`).join('\n\n'));
  const r=ensureContentPackage(dir,{projectId:'book-content',productionPack:'dahui-ai',show:'ai-reading',input:{type:'document',path:script}});
  const spine=JSON.parse(fs.readFileSync(r.contentSpine.path)),recording=JSON.parse(fs.readFileSync(r.recording.path));
  assert.equal(spine.sections.length,100);assert.equal(recording.targetSeconds,2700);assert(recording.requiredEvidence.includes('primary-book'));assert(fs.existsSync(r.episode.path));
  const e=JSON.parse(fs.readFileSync(r.episode.path));e.evidence[0]={...e.evidence[0],path:'../script.md',sha256:sha256File(script)};e.checks.facts='pass';e.beats[0].timelineIds=['stale-id'];write(r.episode.path,e);
  const child=episodeForSourceHandoff(r.episode.path,'new-source');assert.equal(child.evidence[0].path,script);assert.equal(child.projectId,'new-source');assert.equal(child.checks.facts,'pending');assert.equal(child.reviewEvidence,null);assert.deepEqual(child.beats[0].timelineIds,[]);
 });
 test('debate content planning requests real conversation recording rather than scripted AI answers',()=>{
  const dir=path.join(root,'content-debate');fs.mkdirSync(path.join(dir,'contracts'),{recursive:true});fs.mkdirSync(path.join(dir,'.kacha'));
  const r=ensureContentPackage(dir,{projectId:'debate-content',productionPack:'dahui-ai',show:'ai-debate',input:{type:'topic',value:'是否应该依赖AI',digest:'fixture'}});
  const recording=JSON.parse(fs.readFileSync(r.recording.path));assert.equal(recording.recordingMode,'live-debate-outline');assert(recording.requiredEvidence.includes('full-session'));
 });
 test('conflicting existing config is preserved and rejected before creating project outputs',()=>{
  const dir=path.join(root,'existing');fs.mkdirSync(dir);const file=write(path.join(dir,'kacha.config.json'),{style:{profile:'xingzhe',modes:{show:'book-talk'}}});const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>initializeProject({topic:'test',projectRoot:dir,pack:'dahui-ai',show:'ai-reading',development:true}),/已有配置/);
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.deepEqual(fs.readdirSync(dir),['kacha.config.json']);
 });
 test('new brand preset and different new show cannot be mixed through the API',()=>{
  const source=path.join(root,'synthetic.mp4');const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=gray:s=160x90:r=25:d=1','-c:v','libx264',source],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  assert.throws(()=>compileProductionRequest({schemaVersion:'1.0',videoPath:source,styleId:'dahui-book',show:'ai-practice',outputDirectory:root},{write:false}),/栏目与所选预设/);
  const brief=write(path.join(root,'conflicting-brief.json'),{kind:'kacha-production-brief',source:{path:source,sha256:sha256File(source),width:160,height:90,fps:25,durationSeconds:1},target:{productionPack:'dahui-ai',show:'ai-reading'}});
  assert.throws(()=>initializeProject({briefPath:brief,projectRoot:path.join(root,'conflicting-output'),pack:'xingzhe-dahui',development:true}),/brief 不一致/);
  assert(!fs.existsSync(path.join(root,'conflicting-output')));
 });
 console.log(`${count} deep-review regressions passed; synthetic fixtures are not production acceptance`);
} finally { fs.rmSync(root,{recursive:true,force:true}); }
