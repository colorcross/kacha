import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {template,validateProductionQualityContract,calculateCinematicEditorialMetrics} from '../scripts/production_quality_contract.mjs';
import {reviewTemplate} from '../scripts/editorial_review.mjs';
import {ensureContentPackage,initializeProject} from '../scripts/project_orchestrator.mjs';
import {loadProductionCatalog,compileProductionRequest} from '../scripts/kacha_studio.mjs';
import {resolveProductionSelection,requiresProductionQuality} from '../scripts/production_pack.mjs';
import {resolveDesignSystem} from '../scripts/design_system.mjs';
import {buildDirectorPlan} from '../scripts/kacha_intelligence.mjs';
import {initializeMaterialProject} from '../scripts/material_project.mjs';
import {sha256File,writeJsonAtomic,readJson} from '../scripts/kacha_utils.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-general-custom-'));
let count=0, serial=0;
const identity=file=>({path:file,sha256:sha256File(file)});
function write(file,data){writeJsonAtomic(file,data);return file;}
function reviewed(contract,candidate,timeline=null,kind='production'){
 const r=reviewTemplate(contract,{candidate,timeline,kind});
 Object.assign(r,{reviewer:'synthetic regression fixture only',reviewedAt:'2026-10-10T12:00:00Z',status:'pass'});
 r.checks=Object.fromEntries(Object.keys(r.checks).map(k=>[k,'pass']));return r;
}
function fixture(){
 const dir=path.join(root,String(++serial));fs.mkdirSync(dir);
 const save=(name,data)=>write(path.join(dir,name),data);
 const proof=save('evidence.json',{synthetic:true,notProductionEvidence:true});
 const candidate=save('candidate.json',{synthetic:true,candidate:1});
 const frame=save('cover-output.json',{synthetic:true,cover:1});
 const timeline=save('timeline.json',{projectId:'review',output:{fps:25},edl:[{id:'s1',sourceStart:0,sourceEnd:30,provenance:{kind:'synthetic-test-fixture',evidence:proof}}],audio:{sfx:[]}});
 const font=save('font-fixture.json',{synthetic:true,notARealFont:true});
 const registry=save('registry.json',{records:[{file:font,sha256:sha256File(font),families:['Noto Sans CJK SC'],license:{status:'open'}}]});
 const req=save('requirements.json',{version:'narrative-v1',requirements:[{id:'proof',priority:'required',origin:'fact',reason:'fixture',timelineIds:['s1']}]});
 const q=template('review',{packId:'clean-editorial',showId:'talking-head',requirements:identity(req)});
 const e=q.execution;
 e.timeline=identity(timeline);
 e.semanticEdit={wordTimedSource:identity(proof),reviewedThroughSeconds:30,unresolvedFragments:0,cutDecisions:[]};
 e.connections={detectedCount:0,cutSheetCount:0,auditedCount:0,unresolvedCount:0,events:[]};
 e.opening={mode:'natural',primaryNarrativeCount:1,narrativeReason:'fixture',primaryEffectCount:0,firstVisibleChangeSeconds:1,promiseSeconds:10,dynamicPreview:identity(proof)};
 e.effects={maxConcurrentPrimary:0,progressiveLists:[],behindSubjectText:[]};
 e.captions.regularStyle={...q.policies.typography.regularSubtitle,font:'Noto Sans CJK SC',fontEvidence:{file:font,sha256:sha256File(font),registryPath:registry,registrySha256:sha256File(registry)}};
 e.audio={bgmMode:'none',silenceReason:'保留论证与环境声',timelineFps:25,sfxEvents:[]};
 e.cover={mode:'editorial_2d',generationInputMode:'none',identityEvidence:identity(frame)};
 e.firstMinute={motivatedEffects:[],humanPresenceRatio:1,fullScreenTakeoverRatio:0,breathingRoomRatio:1,peakAlignedSfxEventIds:[],humanReactionWindows:[],normalSpeedPreview:identity(proof)};
 e.cinematicEditorial={showId:'talking-head',durationSeconds:30,events:[{id:'shot',semanticBeatId:'question',trigger:'fixture',mechanism:'clean_a_roll',sourceType:'a_roll',containerType:'none',compositionSignature:'medium',styleId:'clean-editorial',simplerAlternative:'fixture',startSeconds:0,endSeconds:30}],normalSpeedPreview:identity(proof),phoneSizeReview:{status:'pass',evidence:identity(proof)},webLikenessReview:{status:'pass',evidence:identity(proof)}};
 e.cinematicEditorial.auditMetrics=calculateCinematicEditorialMetrics(e.cinematicEditorial);
 q.release={finalTimeline:identity(timeline),finalVideo:identity(candidate),stems:{dialogue:identity(proof),mix:identity(proof)},programDurationSeconds:30,bgmCoverageRatio:0,representativeNormalSpeed:{status:'pass',evidence:identity(proof)},fullPlayback:{status:'pass',evidence:identity(proof)},deviceListening:{status:'pass',evidence:identity(proof)}};
 const receipt=identity(save('production-review.json',reviewed(q,candidate,timeline,'production')));
 for(const key of ['representativeNormalSpeed','fullPlayback','deviceListening']) q.release[key].evidence=receipt;
 const file=save('quality.json',q);
 const project=save('project.json',{projectId:'review',show:'talking-head',productionPack:'clean-editorial',plans:{timeline:{path:timeline}},expectedMedia:{audioMix:{bgmRequired:false,adaptiveBgmRequired:false}},outputs:{finalVideo:{path:candidate},covers:[{path:frame}]}});
 return {dir,save,proof,candidate,timeline,frame,q,file,project,font,registry};
}
function test(name,fn){fn();count++;console.log(`PASS ${name}`);}
function quality(f){write(f.file,f.q);return validateProductionQualityContract(f.file,'release',{projectFile:f.project});}
function rejects(result,pattern){assert.equal(result.status,'fail',JSON.stringify(result));assert(result.errors.some(e=>pattern.test(e)),JSON.stringify(result.errors));}
try {
 test('new default is generic; explicit brand and old show remain separate',()=>{
  assert.deepEqual(resolveProductionSelection(),{packId:'clean-editorial',showId:'talking-head'});
  assert.equal(resolveProductionSelection(null,'ai-reading').packId,'dahui-ai');
  assert.equal(resolveProductionSelection(null,'book-talk').packId,'xingzhe-dahui');
  for(const [pack,show] of [['clean-editorial','ai-reading'],['dahui-ai','tool-share'],[null,'unknown-show']]) assert.throws(()=>resolveProductionSelection(pack,show));
  const catalog=loadProductionCatalog({includeCustom:false});assert.equal(catalog.defaultStyleId,'clean-editorial');
  for(const [profile,n] of [['clean-editorial',1],['dahui-ai',8],['xingzhe',5]]) assert.equal(catalog.styles.filter(s=>s.design.profile===profile).length,n);
  assert.equal(Object.keys(catalog.showGroups['clean-editorial']).length,3);
 });
 test('agent decision planning keeps ordinary captions bound to the project font',()=>{
  const cues=write(path.join(root,'neutral-cues.json'),[{id:'c',start:0,end:2,text:'A generic caption',signals:['ordinary_speech']}]);
  const output=path.join(root,'neutral-decisions.json');
  const result=spawnSync(process.execPath,['scripts/decision_rules.mjs','compile','--cues',cues,'--output',output],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(readJson(output).decisions[0].subtitle.recipe,'project_plain_single');
 });
 test('all general visual modes are brand-free',()=>{
  for(const show of ['talking-head','screen-demo','montage']) {
   const d=resolveDesignSystem({profile:'clean-editorial',modes:{show}});assert.equal(d.style.brand.label,'');assert.equal(d.style.brand.persistent,false);
  }
 });
 test('new generic and brand gates cannot be removed by deleting the optional flag',()=>{
  assert.equal(requiresProductionQuality({productionPack:'clean-editorial',show:'montage',productionQualityV1:{required:false}}),true);
  assert.equal(requiresProductionQuality({show:'screen-demo'}),true);assert.equal(requiresProductionQuality({productionPack:'dahui-ai'}),true);
  assert.equal(requiresProductionQuality({projectId:'unbranded-old-manifest'}),false);
 });
 test('blank contracts cannot bypass requirements by downgrading to legacy',()=>{
  assert.throws(()=>template('generic',{packId:'clean-editorial',editorialPolicy:'legacy'}));
  const f=fixture();f.q.editorialPolicy.version='legacy';rejects(quality(f),/回退 legacy/);
 });
 test('complete generic no-music and no-SFX release passes with one clean shot',()=>{
  const f=fixture();assert.deepEqual(quality(f).errors,[]);assert.equal(f.q.episodeEditorial,undefined);
 });
 test('generic release binds current project timeline and output',()=>{
  const f=fixture(),p=readJson(f.project);p.plans.timeline.path=path.join(root,'absent.json');p.outputs.finalVideo.path=path.join(root,'absent.mp4');write(f.project,p);
  const r=quality(f);rejects(r,/实际时间线/);rejects(r,/当前交付/);
 });
 test('generic release cannot reuse another timeline or an outdated media identity',()=>{
  const f=fixture();f.q.release.finalTimeline=identity(f.proof);rejects(quality(f),/已检查时间线/);
  const g=fixture();fs.appendFileSync(g.candidate,' ');rejects(quality(g),/sha256/);
 });
 test('rebound candidate and timeline do not preserve old review acceptance',()=>{
  const f=fixture();write(f.candidate,{newCandidate:true});f.q.release.finalVideo=identity(f.candidate);rejects(quality(f),/终审/);
  const g=fixture();const t=readJson(g.timeline);t.changed=true;write(g.timeline,t);g.q.execution.timeline=identity(g.timeline);g.q.release.finalTimeline=identity(g.timeline);rejects(quality(g),/终审/);
 });
 test('arbitrary files and a bare pass are not generic playback review receipts',()=>{
  const f=fixture();f.q.release.fullPlayback.evidence=identity(f.proof);rejects(quality(f),/终审/);
 });
 test('actual EDL counts, duration and fps are checked for generic projects',()=>{
  const f=fixture();f.q.execution.connections.detectedCount=2;f.q.execution.audio.timelineFps=30;f.q.execution.cinematicEditorial.durationSeconds=31;
  const r=quality(f);for(const re of [/连接点/,/帧率/,/审计时长/]) rejects(r,re);
 });
 test('explicit required music cannot be omitted while optional silence can pass',()=>{
  const f=fixture(),p=readJson(f.project);p.expectedMedia.audioMix.bgmRequired=true;write(f.project,p);rejects(quality(f),/项目要求配乐/);
  const g=fixture(),t=readJson(g.timeline);t.audio.bgm={path:g.proof};write(g.timeline,t);g.q.execution.timeline=identity(g.timeline);rejects(quality(g),/bgmMode/);
 });
 test('generic fallback font must belong to current authorized registry',()=>{
  const f=fixture();write(f.registry,{records:[]});f.q.execution.captions.regularStyle.fontEvidence.registrySha256=sha256File(f.registry);rejects(quality(f),/字体/);
 });
 test('montage does not invent dialogue or transcription requirements',()=>{
  const f=fixture(),q=template('review',{packId:'clean-editorial',showId:'montage',requirements:f.q.editorialPolicy.requirements});
  q.execution=structuredClone(f.q.execution);q.release=structuredClone(f.q.release);
  q.execution.cinematicEditorial.showId='montage';q.execution.semanticEdit.sourceReview=q.execution.semanticEdit.wordTimedSource;delete q.execution.semanticEdit.wordTimedSource;delete q.release.stems.dialogue;
  const receipt=identity(f.save('montage-review.json',reviewed(q,f.candidate,f.timeline)));for(const key of ['representativeNormalSpeed','fullPlayback','deviceListening'])q.release[key].evidence=receipt;
  f.q=q;const p=readJson(f.project);p.show='montage';write(f.project,p);assert.deepEqual(quality(f).errors,[]);
 });
 test('review-template generates pending evidence and refuses overwrite',()=>{
  const f=fixture(),output=path.join(f.dir,'pending-review.json');
  const args=['scripts/kacha.mjs','production-quality','review-template','--contract',f.file,'--output',output];
  const r=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(readJson(output).status,'pending');assert.equal(readJson(output).checks.fullPlayback,'pending');
  assert.notEqual(spawnSync(process.execPath,args,{encoding:'utf8'}).status,0);
 });
 test('all 101 generic script paragraphs survive planning including the final condition',()=>{
  const dir=path.join(root,'content');fs.mkdirSync(dir);const script=path.join(root,'long.md');fs.writeFileSync(script,Array.from({length:101},(_,i)=>`第 ${i+1} 段完整条件`).join('\n\n'));
  initializeProject({script,projectRoot:dir,projectId:'long-generic',development:true});
  const manifest=readJson(path.join(dir,'.kacha/orchestration.json'));assert.equal(manifest.productionPack,'clean-editorial');
  const config=readJson(path.join(dir,'kacha.config.json'));assert.equal(config.style.profile,'clean-editorial');
  const r=ensureContentPackage(dir,manifest),spine=readJson(r.contentSpine.path);assert.equal(spine.sections.length,101);assert(JSON.stringify(spine).includes('第 101 段完整条件'));assert.equal(r.episode,undefined);
 });
 test('legacy initialization refuses generic config without touching it',()=>{
  const dir=path.join(root,'conflict');fs.mkdirSync(dir);const file=write(path.join(dir,'kacha.config.json'),{style:{profile:'clean-editorial',modes:{show:'talking-head'}}});const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>initializeProject({topic:'test',pack:'xingzhe-dahui',show:'book-talk',projectRoot:dir,development:true}),/已有配置/);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readdirSync(dir).length,1);
 });
 test('explicit design show consistently selects its own profile',()=>{
  const cfg=write(path.join(root,'generic-config.json'),{schemaVersion:'1.0',style:{profile:'clean-editorial',modes:{show:'talking-head'}}});
  const r=spawnSync(process.execPath,['scripts/kacha_design.mjs','resolve','--config',cfg,'--show','tool-share'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).style.id,'xingzhe');
 });
 test('generic and new-brand director grammars are executable',()=>{
  const file=write(path.join(root,'cues.json'),{cues:[{id:'cue',start:0,end:3,text:'保留完整画面',confidence:1,signals:[]}]});
  for(const [styleId,showId] of [['clean-editorial','montage'],['dahui-ai','ai-practice']]) assert.equal(buildDirectorPlan(file,{projectId:'fixture',styleId,showId}).project.styleId,styleId);
 });
 test('generic source brief, captions and visual planning share the generic profile',()=>{
  const previous=process.env.KACHA_CONFIG_HOME,disabled=process.env.KACHA_DISABLE_USER_CONFIG;
  const cfgHome=path.join(root,'isolated-config');fs.mkdirSync(cfgHome);process.env.KACHA_CONFIG_HOME=cfgHome;delete process.env.KACHA_DISABLE_USER_CONFIG;
  try {
   const source=path.join(root,'source.mp4');const ff=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=gray:s=160x90:r=25:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-c:a','aac','-shortest',source],{encoding:'utf8'});assert.equal(ff.status,0,ff.stderr);
   const font=['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(f=>fs.existsSync(f));assert(font);
   const families=spawnSync('fc-scan',['--format','%{family}\n',font],{encoding:'utf8'}).stdout.split(/[,\r\n]/).filter(Boolean);
   const registry=write(path.join(root,'real-fonts.json'),{schemaVersion:'1.0',records:[{file:font,sha256:sha256File(font),families,projectAuthorization:{status:'authorized',statement:'self-controlled regression'}}]});
   write(path.join(cfgHome,'config.json'),{schemaVersion:'1.0',tools:{fontRegistry:registry}});
   const result=compileProductionRequest({schemaVersion:'1.0',videoPath:source,outputDirectory:root,projectName:'generic-fixture',show:'screen-demo'},{write:false});
   assert.equal(result.brief.target.productionPack,'clean-editorial');assert.equal(result.brief.target.show,'screen-demo');assert.equal(result.brief.style.bgm.enabled,false);
   const project=path.join(root,'source-project');initializeProject({source,projectRoot:project,development:true,show:'screen-demo'});
   const manifest=readJson(path.join(project,'contracts/project-manifest.json'));assert.equal(manifest.productionPack,'clean-editorial');assert.equal(manifest.expectedMedia.audioMix.bgmRequired,false);
   const quality=readJson(path.join(project,'contracts/production-quality-contract.json'));assert.equal(quality.policies.audio.adaptiveBgmRequired,false);assert.equal(quality.episodeEditorial,undefined);
   const cues=write(path.join(root,'real-cues.json'),[{id:'c1',start:0,end:2.8,text:'READ THE SCREEN'}]);const caption=path.join(root,'caption.json');
   let r=spawnSync(process.execPath,['scripts/kacha.mjs','captions','plan','--input',source,'--transcript',cues,'--config',path.join(project,'kacha.config.json'),'--output',caption],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
   assert.equal(readJson(caption).registry.fontRoutingId,'clean-editorial-font-routing');assert.equal(readJson(caption).design.resolverInput.profile,'clean-editorial');
   r=spawnSync(process.execPath,['scripts/kacha.mjs','captions','validate','--plan',caption],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
   const visual=path.join(root,'visual.json');r=spawnSync(process.execPath,['scripts/kacha.mjs','visual-capabilities','template','--show','screen-demo','--duration','3','--output',visual],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(readJson(visual).styleProfile,'clean-editorial');
  } finally {if(previous===undefined)delete process.env.KACHA_CONFIG_HOME;else process.env.KACHA_CONFIG_HOME=previous;if(disabled===undefined)delete process.env.KACHA_DISABLE_USER_CONFIG;else process.env.KACHA_DISABLE_USER_CONFIG=disabled;}
 });
 test('source and materials entrypoints reject mismatched brand before writing projects',()=>{
  const dir=path.join(root,'invalid-materials');assert.throws(()=>initializeMaterialProject({pack:'clean-editorial',show:'ai-reading',projectRoot:dir}),/栏目|show/);assert(!fs.existsSync(dir));
 });
 console.log(`${count} generic/custom regressions passed; synthetic evidence is not production acceptance`);
} finally {fs.rmSync(root,{recursive:true,force:true});}
