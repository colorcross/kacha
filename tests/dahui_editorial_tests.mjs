import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {episodeTemplate, validateEpisode} from '../scripts/episode_editorial.mjs';
import {loadProductionPack, resolveProductionSelection} from '../scripts/production_pack.mjs';
import {template, validateProductionQualityContract} from '../scripts/production_quality_contract.mjs';
import {loadProductionCatalog} from '../scripts/kacha_studio.mjs';
import {loadEditingCraft, selectEditingRecipe} from '../scripts/editing_craft.mjs';
import {resolveDesignSystem} from '../scripts/design_system.mjs';
import {sha256File, sha256Value, writeJsonAtomic} from '../scripts/kacha_utils.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-dahui-'));
let passed=0;
function test(name, fn){fn();passed++;console.log(`PASS ${name}`);}
function save(name,data){const file=path.join(dir,name);writeJsonAtomic(file,data);return file;}
function cli(args,ok=true){const r=spawnSync(process.execPath,[path.join(root,'scripts/kacha.mjs'),...args],{encoding:'utf8',cwd:dir});assert.equal(r.status===0,ok,r.stderr||r.stdout);return r;}
function filled(show){
 const e=episodeTemplate('regression',show);
 Object.assign(e,{question:'此任务如何判断结果可信？',audienceTask:'完成一份可交付材料',ownJudgment:'判断由来源及具体条件约束'});
 e.editingBrief.firstSpokenQuestion=e.question;e.editingBrief.closingAnswer=e.ownJudgment;e.editingBrief.protectedMeaning=['保留具体条件'];
 if(e.editingBrief.reviewScenario) Object.assign(e.editingBrief.reviewScenario,{productVersion:'fixture',conditions:'fixture',expected:'fixture',actual:'fixture',attempts:1,reproduced:0});
 e.context={recordedAt:'2026-09-29',toolVersion:'test fixture only',inputScope:'synthetic validation fixture',primaryBooks:[{title:'测试主书',edition:'测试版'}],aiRole:'ai-assisted-development',sourceUrl:'https://example.com/fixture',publishedAt:'2026-09-29',eventAt:'2026-09-29',availability:'announced'};
 const proof=save(`${show}-evidence.json`,{fixture:true,note:'schema regression only, not actual production evidence'});
 e.evidence.forEach(x=>Object.assign(x,{path:proof,sha256:sha256File(proof),locator:'fixture record 1',description:'仅回归夹具'}));
 e.beats.forEach(x=>Object.assign(x,{purpose:'说明本环节的判断依据',evidenceIds:e.evidence.map(item=>item.id),timelineIds:['segment-001']}));
 e.chapters=[{title:'本期问题',atSeconds:0},{title:'原文与解释',atSeconds:60}];
 e.turns=['human','ai'].map(speaker=>({speaker,sourceLocator:'00:00–00:01',evidenceId:'full-session',beatId:'positions'}));
 e.disclosures=['synthetic fixture; not a real debate'];return e;
}
try {
 test('eight active categories resolve independently while explicit legacy remains frozen',()=>{
  assert.equal(loadProductionPack('dahui-ai','ai-practice').supportedShows.length,8);
  for(const show of loadProductionPack('dahui-ai','ai-practice').supportedShows){assert.equal(resolveProductionSelection(null,show).packId,'dahui-ai');const d=resolveDesignSystem({profile:'dahui-ai',modes:{show}});assert.equal(d.style.brand.creatorName,'大灰AI');assert.equal(d.style.brand.persistent,false);}
  assert.equal(loadProductionPack('xingzhe-dahui','book-talk').policies.cover.mode,'cinematic_3d');
  assert.throws(()=>loadProductionPack('xingzhe-dahui','ai-reading'));
 });
 test('studio keeps eight new editorial presets and five legacy presets alongside generic default',()=>{
  const c=loadProductionCatalog({includeCustom:false});assert.equal(c.defaultStyleId,'clean-editorial');assert.equal(c.styles.filter(s=>s.design.profile==='dahui-ai').length,8);assert.equal(c.styles.filter(s=>s.design.profile==='xingzhe').length,5);
  assert.equal(c.styles[0].direction.openingId,'natural');assert.equal(c.styles[0].bgm.enabled,false);
 });
 test('book and debate recipe cannot be hijacked by generic experiment signals',()=>{
  const c=loadEditingCraft();
  for(const show of ['ai-reading','ai-debate']) assert.equal(selectEditingRecipe(c,[{start:0,end:60,confidence:1,signals:['experiment']}],{showId:show}).recipe.shows[0],show);
 });
 test('blank episode cannot pass the planning gate',()=>assert.equal(validateEpisode(save('blank.json',episodeTemplate('regression','ai-reading'))).status,'fail'));
 for(const show of loadProductionPack('dahui-ai','ai-practice').supportedShows){test(`${show} accepts complete schema evidence and rejects lost evidence`,()=>{
  const e=filled(show),file=save(`${show}.json`,e);assert.deepEqual(validateEpisode(file).errors,[]);
  e.evidence.pop();save(`${show}.json`,e);assert.equal(validateEpisode(file).status,'fail');
 });}
 test('book short master, multiple primary books and out-of-order chapters cannot pass',()=>{
  const e=filled('ai-reading');e.targetSeconds=300;e.context.primaryBooks.push({title:'第二本',edition:'一版'});e.chapters[1].atSeconds=0;
  const r=validateEpisode(save('short-book.json',e));assert(r.errors.some(x=>x.includes('30–60')));assert(r.errors.some(x=>x.includes('一本')));assert(r.errors.some(x=>x.includes('章节')));
 });
 test('changed proof bytes invalidate prior acceptance',()=>{
  const e=filled('ai-practice'),file=save('changed.json',e);fs.appendFileSync(e.evidence[0].path,' ');assert(validateEpisode(file).errors.some(x=>x.includes('摘要失效')));
 });
 test('V1.2 opening, protected meaning and product followup evidence are explicit',()=>{
  const e=filled('ai-review'),file=save('review-scenario.json',e),timeline=save('review-scenario-timeline.json',{projectId:'regression',output:{fps:25},edl:[{id:'segment-001',sourceStart:0,sourceEnd:540}]});
  assert.equal(validateEpisode(file,{stage:'execution',timeline}).status,'pass');
  e.editingBrief.firstSpokenQuestion='只写标题';e.editingBrief.protectedMeaning=[];
  e.editingBrief.reviewScenario.type='fix-followup';save('review-scenario.json',e);
  const errors=validateEpisode(file,{stage:'execution',timeline}).errors;
  assert(errors.some(x=>x.includes('首句')));assert(errors.some(x=>x.includes('不能剪掉')));assert(errors.some(x=>x.includes('回访')));
 });
 test('execution uses real timeline identities and book duration, not target duration',()=>{
  const e=filled('ai-reading'),file=save('execution.json',e),timeline=save('timeline.json',{projectId:'regression',edl:[{id:'wrong-id',sourceStart:0,sourceEnd:120}]});
  const r=validateEpisode(file,{stage:'execution',timeline});assert(r.errors.some(x=>x.includes('segment-001')));assert(r.errors.some(x=>x.includes('真实读书母片')));
 });
 test('book duration deducts actual frame-based overlap, ignoring invented durationSeconds',()=>{
  const e=filled('ai-reading'),file=save('overlap.json',e);
  const timeline=save('overlap-timeline.json',{projectId:'regression',output:{fps:25},edl:[{id:'segment-001',sourceStart:0,sourceEnd:900},{id:'segment-002',sourceStart:900,sourceEnd:1800}],transitions:[{boundaryIndex:0,durationFrames:10,durationSeconds:0}]});
  assert(validateEpisode(file,{stage:'execution',timeline}).errors.some(x=>x.includes('真实读书母片')));
 });
 test('release requires full-speed review receipt, not merely marked pass',()=>{
  const e=filled('ai-practice');e.checks=Object.fromEntries(Object.keys(e.checks).map(x=>[x,'pass']));
  const timeline=save('release-timeline.json',{projectId:'regression',edl:[{id:'segment-001',sourceStart:0,sourceEnd:450}]});
  assert(validateEpisode(save('review.json',e),{stage:'release',timeline}).errors.some(x=>x.includes('终审记录')));
 });
 test('production gate binds episode and cannot downgrade new pack to legacy',()=>{
  const ep=filled('ai-practice'),epFile=save('quality-episode.json',ep);
  const req=save('requirements.json',{version:'narrative-v1',requirements:[{id:'proof',priority:'required',origin:'fact',reason:'实测证据',timelineIds:['segment-001']}]});
  const c=template('regression',{packId:'dahui-ai',showId:'ai-practice',requirements:{path:req,sha256:sha256File(req)}});
  c.episodeEditorial={path:epFile,sha256:sha256File(epFile)};
  const f=save('quality.json',c);assert.deepEqual(validateProductionQualityContract(f,'plan').errors,[]);
  c.editorialPolicy.version='legacy';save('quality.json',c);assert.equal(validateProductionQualityContract(f,'plan').status,'fail');
  assert.throws(()=>template('x',{packId:'dahui-ai',editorialPolicy:'legacy'}));
 });
 test('new-brand design preflight resolves the same profile at rendering and validation',()=>{
  const svg=path.join(dir,'design.svg'),manifest=path.join(dir,'design.manifest.json');
  cli(['design','render','--scene','text_behind_subject_scene','--show','ai-reading','--output',svg,'--manifest',manifest,'--no-guides']);
  const m=JSON.parse(fs.readFileSync(manifest)),plan=JSON.parse(fs.readFileSync(path.join(root,'examples/edit-plan.json')));
  const pre=plan.effects[1].designPreflight;
  Object.assign(pre,{styleProfile:'dahui-ai',modeSelection:m.modeSelection,designDigest:m.designDigest,artifactRef:svg,artifactSha256:sha256File(svg),implementationManifestRef:manifest,implementationManifestSha256:sha256File(manifest)});
  Object.assign(pre.implementationHandoff,{resolvedFonts:m.resolvedFonts,fontResolutionDigest:sha256Value(m.resolvedFonts)});
  const file=save('new-style-preflight.json',plan);
  const check=spawnSync(process.execPath,[path.join(root,'scripts/validate_edit_plan.mjs'),file],{cwd:root,encoding:'utf8'});assert.equal(check.status,0,check.stderr);
 });
 test('real CLI project and caption planner keep the new brand and permit silent BGM',()=>{
  const video=path.join(dir,'synthetic.mp4');
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=gray:s=160x90:r=25:d=1','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
  const project=path.join(dir,'source-project');
  cli(['start','--source',video,'--project-root',project,'--project-id','routing','--pack','dahui-ai','--show','ai-reading','--development']);
  const manifest=JSON.parse(fs.readFileSync(path.join(project,'contracts/project-manifest.json')));
  assert.equal(manifest.productionPack,'dahui-ai');assert.equal(manifest.expectedMedia.audioMix.bgmRequired,false);assert.equal(manifest.expectedMedia.audioMix.adaptiveBgmRequired,false);assert(!manifest.plans.adaptiveBgm);assert(!manifest.outputs.audioStems.bgm);assert(!manifest.outputs.audioStems.sfx);assert.deepEqual(manifest.requiredCoverAspectRatios,['16:9']);
  const config=JSON.parse(fs.readFileSync(path.join(project,'kacha.config.json')));assert.equal(config.style.profile,'dahui-ai');
  const cues=save('caption-cues.json',{cues:[{id:'cue',start:0,end:.8,text:'测试字幕'}]});
  const captions=path.join(dir,'captions.json');
  cli(['captions','plan','--input',video,'--transcript',cues,'--show','ai-reading','--output',captions]);
  const cp=JSON.parse(fs.readFileSync(captions));assert.equal(cp.registry.fontRoutingId,'dahui-ai-font-routing');
  const episode=filled('ai-practice'),epFile=save('bind-episode.json',episode),qc=save('bind-quality.json',template('regression',{packId:'dahui-ai'}));
  cli(['episode','bind','--episode',epFile,'--contract',qc]);assert.equal(JSON.parse(fs.readFileSync(qc)).episodeEditorial.sha256,sha256File(epFile));
 });
 test('CLI creates companion episode, natural visual opening, and real editorial cover',()=>{
  const q=path.join(dir,'cli-quality.json');cli(['production-quality','template','--project-id','cli','--show','ai-reading','--output',q]);
  const c=JSON.parse(fs.readFileSync(q));assert.equal(c.policies.productionProfile.packId,'dahui-ai');assert.equal(c.editorialPolicy.version,'narrative-v1');assert(fs.existsSync(c.episodeEditorial.path));
  cli(['production-quality','validate','--contract',q],false);
  const v=path.join(dir,'visual.json');cli(['visual-capabilities','template','--style','dahui-ai','--show','ai-reading','--duration','2700','--output',v]);
  const vp=JSON.parse(fs.readFileSync(v));assert.equal(vp.events.length,1);assert.equal(vp.events[0].implementation.openingMode,'natural');assert.equal(vp.policy.openingContract.promiseBySeconds,45);
  const cover=path.join(dir,'cover.json');cli(['cover','template','--pack','dahui-ai','--project-id','cli','--output',cover]);assert.equal(JSON.parse(fs.readFileSync(cover)).kind,'kacha-editorial-cover-contract');cli(['cover','validate','--contract',cover],false);
 });
 console.log(`${passed} 大灰AI regression checks passed (synthetic fixtures, no visual quality claim)`);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
