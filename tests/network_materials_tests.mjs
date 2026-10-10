import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, fileIdentity, sha256File, readJson, mediaIndexDigest } from '../scripts/kacha_utils.mjs';
import { networkRequest, selectionTemplate, inspectSelection, selectedOverlay, validateAdoptedSelection, factEvidenceTemplate } from '../scripts/network_materials.mjs';
import { buildTimelineProjection } from '../scripts/timeline_projection.mjs';
import { applyEditorCommand, undoEditorCommand, redoEditorCommand } from '../scripts/editor_command_journal.mjs';
import { buildDirectorPlan, buildAssetGapPlan } from '../scripts/kacha_intelligence.mjs';
import { buildAssetInbox, validateAssetInbox, attachAsset } from '../scripts/asset_inbox.mjs';
import { compileEditorOperation } from '../scripts/editor_operations.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-network-materials-'));
const save=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2));return file;};
const exec=(cmd,args)=>{const r=run(cmd,args,{timeout:60000});assert.equal(r.status,0,r.stderr);return r;};
const ff=args=>exec('ffmpeg',['-v','error','-nostdin','-y',...args]);
const checks=[];
const test=(name,fn)=>{fn();checks.push(name);};
try {
 const main=path.join(root,'main.mp4'),asset=path.join(root,'asset.mp4');
 ff(['-f','lavfi','-i','color=black:s=160x90:r=25:d=3','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:v','libx264','-c:a','aac','-shortest',main]);
 ff(['-f','lavfi','-i','color=red:s=160x90:r=25:d=1','-f','lavfi','-i','color=blue:s=160x90:r=25:d=2','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-c:v','libx264',asset]);
 const plan={schemaVersion:'1.0',projectId:'network-test',mode:'preview',source:{path:main,sha256:sha256File(main)},edl:[{id:'main',sourceStart:0,sourceEnd:3}],visual:{overlays:[]},audio:{sfx:[]},output:{width:160,height:90,fps:25,path:path.join(root,'render.mp4')}};
 const timeline=save('timeline.json',plan);
 const requestFile=save('request.json',networkRequest(timeline,{start:1,end:2,text:'用蓝色画面解释当前步骤',purpose:'回归用示意插镜',query:'blue',evidenceType:'illustration'}));
 const manifest=save('manifest.json',{schema:'kacha.media-manifest.v1',status:'complete',items:[{asset_id:1,kind:'video',local_path:asset,sha256:sha256File(asset),source_url:'https://example.com/original',creator:'synthetic fixture',license_url:'https://example.com/fixture-license'}]});
 const selectionFile=save('selection.json',selectionTemplate(requestFile,manifest,1));
 const projection=()=>buildTimelineProjection(timeline);
 test('pending candidate cannot become an edit',()=>assert.throws(()=>selectedOverlay(projection(),selectionFile,sha256File(selectionFile),'insert'),/查看实际/));
 let selection=readJson(selectionFile);selection.sourceIn=1.2;save('selection.json',selection);
 test('inspect records selected range and real frames without approving it',()=>{
  const r=inspectSelection(selectionFile,path.join(root,'frames'));assert.equal(r.frames.length,3);assert.equal(readJson(selectionFile).review.status,'pending');
 });
 selection=readJson(selectionFile);selection.review={...selection.review,status:'approved',reviewer:'automated regression fixture only',reviewedAt:new Date().toISOString(),observation:'synthetic blue field',matchReason:'blue test insert',usageConditions:'own synthetic fixture',attribution:'test fixture',fullSelectedRangeViewed:true,rightsChecked:true};save('selection.json',selection);
 test('selected source offset renders, keeps dialogue, and is reversible',()=>{
  const result=applyEditorCommand(timeline,{schemaVersion:'1.0',kind:'kacha-editor-command',baseSha256:sha256File(timeline),operation:'insert_media',arguments:{selectionPath:selectionFile,selectionSha256:sha256File(selectionFile),id:'insert'}});
  assert.equal(readJson(timeline).visual.overlays[0].sourceOffsetSeconds,1.2);
  const out=path.join(root,'render.mp4');exec('node',[path.join(repo,'scripts/timeline_ir.mjs'),'render','--plan',timeline,'--output',out]);
  const pixel=run('ffmpeg',['-v','error','-i',out,'-vf','select=eq(n\\,25),crop=2:2:10:10,format=rgb24','-frames:v','1','-f','rawvideo','-'],{encoding:null});assert.equal(pixel.status,0);assert.ok(pixel.stdout[2]>150 && pixel.stdout[0]<50);
  const probe=JSON.parse(exec('ffprobe',['-v','error','-show_streams','-of','json',out]).stdout);assert.ok(probe.streams.some(s=>s.codec_type==='audio'));
  const after=sha256File(timeline),undo=undoEditorCommand(timeline,result.project.session.currentSha256);assert.equal(readJson(timeline).visual.overlays.length,0);
  redoEditorCommand(timeline,undo.timelineSha256);assert.equal(sha256File(timeline),after);
  validateAdoptedSelection(projection(),readJson(timeline).visual.overlays[0],selectionFile);
  const edited=readJson(timeline);edited.edl[0].sourceStart=.2;save('timeline.json',edited);
  assert.throws(()=>validateAdoptedSelection(projection(),edited.visual.overlays[0],selectionFile),/粗剪映射/);
  edited.edl[0].sourceStart=0;edited.source={path:asset,sha256:sha256File(asset)};save('timeline.json',edited);
  assert.throws(()=>validateAdoptedSelection(projection(),edited.visual.overlays[0],selectionFile),/主视频/);
  edited.source=plan.source;edited.output.fps=50;save('timeline.json',edited);
  assert.throws(()=>validateAdoptedSelection(projection(),edited.visual.overlays[0],selectionFile),/粗剪映射/);
  edited.output.fps=25;edited.audio.dialogue={path:main};save('timeline.json',edited);
  assert.throws(()=>validateAdoptedSelection(projection(),edited.visual.overlays[0],selectionFile),/粗剪映射/);
 });
 // Restore baseline identity by making a fresh request after an intentional reset of this test fixture.
 save('timeline.json',plan);save('request.json',networkRequest(timeline,{start:1,end:2,text:'蓝色说明',purpose:'回归',query:'blue'}));
 selection.request=fileIdentity(requestFile);selection.inspection.request=selection.request;save('selection.json',selection);
 test('short selection and stale inspection are rejected',()=>{
  const bad=structuredClone(selection);bad.sourceIn=2.5;save('bad.json',bad);assert.throws(()=>selectedOverlay(projection(),path.join(root,'bad.json'),sha256File(path.join(root,'bad.json')),'short'),/超出/);
  bad.sourceIn=0;save('bad.json',bad);assert.throws(()=>selectedOverlay(projection(),path.join(root,'bad.json'),sha256File(path.join(root,'bad.json')),'stale'),/重新查看/);
 });
 test('changed timeline and factual usage without source evidence fail',()=>{
  const req=readJson(requestFile);req.scene.evidenceType='factual';save('request.json',req);const factual={...selection,request:fileIdentity(requestFile)};save('factual.json',factual);
  assert.throws(()=>selectedOverlay(projection(),path.join(root,'factual.json'),sha256File(path.join(root,'factual.json')),'fact'),/用途或来源/);
  inspectSelection(path.join(root,'factual.json'),path.join(root,'factual-frames'));
  const inspected=readJson(path.join(root,'factual.json'));inspected.review=selection.review;save('factual.json',inspected);
  assert.throws(()=>selectedOverlay(projection(),path.join(root,'factual.json'),sha256File(path.join(root,'factual.json')),'fact'),/事实关联/);
  const factFile=save('fact-record.json',factEvidenceTemplate(path.join(root,'factual.json')));
  const fact=readJson(factFile);Object.assign(fact,{status:'approved',sourceRecord:fileIdentity(manifest),locator:'fixture position',verification:'synthetic regression only',reviewer:'test',reviewedAt:new Date().toISOString()});save('fact-record.json',fact);
  inspected.review.sourceEvidence=fileIdentity(factFile);save('factual.json',inspected);
  selectedOverlay(projection(),path.join(root,'factual.json'),sha256File(path.join(root,'factual.json')),'fact');
  fact.projectId='other';save('fact-record.json',fact);inspected.review.sourceEvidence=fileIdentity(factFile);save('factual.json',inspected);
  assert.throws(()=>selectedOverlay(projection(),path.join(root,'factual.json'),sha256File(path.join(root,'factual.json')),'fact'),/事实关联记录/);
  fs.appendFileSync(timeline,' ');assert.throws(()=>selectedOverlay(projection(),path.join(root,'factual.json'),sha256File(path.join(root,'factual.json')),'stale'),/时间线/);
 });
 const text='数据显示首稿返工时间增长了42%';
 const cues=save('cues.json',{schemaVersion:'1.0',cues:[{id:'hook',start:0,end:2,text:'可信么？',signals:['hook'],confidence:1},{id:'proof',start:2,end:8,text,signals:['evidence','data'],confidence:1},{id:'end',start:8,end:10,text:'核对来源',signals:['conclusion'],confidence:1}]});
 const director=save('director.json',buildDirectorPlan(cues,{projectId:'network-test',showId:'ai-review'}));
 const index={schemaVersion:'1.0',kind:'kacha_media_index',digestVersion:'2',status:'pass',root,items:[{id:'stock',ref:'@asset:stock',kind:'video',path:asset,identity:fileIdentity(asset),range:{start:1.2,end:1.6},fields:{tags:text},license:'fixture',provenance:{kind:'stock_media',evidence:'fixture',externalUpload:false}}]};index.digest=mediaIndexDigest(index);const indexFile=save('.kacha/media-index.json',index);
 const gap=save('contracts/gap.json',buildAssetGapPlan(director,indexFile));
 test('stock keywords cannot fill factual gaps',()=>assert.ok(readJson(gap).gaps.filter(g=>g.evidenceType==='factual').every(g=>g.blocker)));
 test('merged scan provenance cannot turn stock into factual evidence',()=>{
  index.items[0].provenance={kind:'merged_local_sources',sources:[{kind:'local_file',evidence:asset},{kind:'stock_media',evidence:'fixture'}],evidence:'fixture',externalUpload:false};
  index.digest=mediaIndexDigest(index);save('.kacha/media-index.json',index);
  assert.ok(buildAssetGapPlan(director,indexFile).gaps.filter(g=>g.evidenceType==='factual').every(g=>g.blocker));
  save('contracts/gap.json',buildAssetGapPlan(director,indexFile));
 });
 test('inbox rejects cross-project and changed upstream evidence',()=>{
  const manifestFile=save('contracts/project.json',{kind:'kacha-project-manifest',projectId:'wrong',plans:{assetGapPlan:'gap.json'}});
  assert.throws(()=>buildAssetInbox(manifestFile),/工程/);
  save('contracts/project.json',{kind:'kacha-project-manifest',projectId:'network-test',plans:{assetGapPlan:'gap.json'}});
  const built=buildAssetInbox(manifestFile);assert.equal(validateAssetInbox(built.path).status,'pass');
  const other=save('contracts/other-project.json',{kind:'kacha-project-manifest',projectId:'another',plans:{assetGapPlan:'gap.json'}});
  assert.throws(()=>attachAsset(other,{gapId:built.inbox.items[0].gapId,assetPath:asset,license:'fixture',provenanceKind:'fixture',provenanceEvidence:'fixture'}),/本次调用/);
  fs.appendFileSync(director,' ');assert.equal(validateAssetInbox(built.path).status,'blocked');
 });
 test('replacement uses source range and rejects too-short selected range',()=>{
  plan.visual.overlays=[{id:'old',kind:'video',path:asset,start:0,end:1,x:0,y:0,width:160,height:90,sourceOffsetSeconds:0}];save('timeline.json',plan);
  const command={schemaVersion:'1.0',kind:'kacha-editor-command',itemId:'overlay:old',operation:'replace_media',arguments:{assetRef:'@asset:stock',indexPath:indexFile}};
  assert.throws(()=>compileEditorOperation(projection(),command),/选段不足/);
  index.items[0].range.end=2.6;index.digest=mediaIndexDigest(index);save('.kacha/media-index.json',index);
  assert.equal(compileEditorOperation(projection(),command).operations[0].value.sourceOffsetSeconds,1.2);
  const short=path.join(root,'long-audio.mp4');ff(['-f','lavfi','-i','color=blue:s=160x90:r=25:d=1','-f','lavfi','-i','sine=duration=3','-c:v','libx264','-c:a','aac',short]);
  index.items[0].path=short;index.items[0].identity=fileIdentity(short);index.items[0].range=null;index.digest=mediaIndexDigest(index);save('.kacha/media-index.json',index);
  plan.visual.overlays[0].end=2;save('timeline.json',plan);assert.throws(()=>compileEditorOperation(projection(),command),/选段不足/);
 });
 console.log(JSON.stringify({status:'pass',checks},null,2));
} finally { if(!process.env.KACHA_KEEP_NETWORK_FIXTURES) fs.rmSync(root,{recursive:true,force:true}); }
