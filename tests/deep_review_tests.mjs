import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, readJson, fileIdentity, sha256File, mediaIndexDigest, visualMediaDuration, resolveRuntimeCommand } from '../scripts/kacha_utils.mjs';
import { openEditorProject, applyEditorCommand, recoverEditorProject } from '../scripts/editor_command_journal.mjs';
import { buildTimelineProjection } from '../scripts/timeline_projection.mjs';
import { networkRequest, selectionTemplate, inspectSelection } from '../scripts/network_materials.mjs';
import { episodeTemplate, validateEpisode } from '../scripts/episode_editorial.mjs';
import { listProjectBin } from '../scripts/project_bin.mjs';
import { createSelfContainedBundle } from '../scripts/kacha_delivery.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-deep-review-'));
const save = (name,value) => { const file=path.join(root,name); fs.writeFileSync(file,JSON.stringify(value)); return file; };
const exec = (cmd,args) => { const r=run(cmd,args,{timeout:60000}); assert.equal(r.status,0,r.stderr); return r; };
const ff = args => exec('ffmpeg',['-v','error','-y',...args]);
const checks=[];
const test=(name,fn)=>{fn();checks.push(name);};
try {
  const source=path.join(root,'source.mp4');
  ff(['-f','lavfi','-i','color=red:s=160x90:r=25:d=0.04','-f','lavfi','-i','color=blue:s=160x90:r=25:d=3',
    '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-c:v','libx264',source]);
  const base=()=>({schemaVersion:'1.0',projectId:'review-fixture',mode:'preview',source:{...fileIdentity(source),license:'owned',provenance:{kind:'owned_local',evidence:'synthetic ownership'}},edl:[{id:'main',sourceStart:0,sourceEnd:3}],visual:{overlays:[]},audio:{sfx:[]},output:{width:160,height:90,fps:25,path:path.join(root,'unused.mp4')}});
  test('failed-journal-write-preserves-original-bytes-and-next-edit-works',()=>{
    const file=save('minified.json',base()),before=fs.readFileSync(file);let project=openEditorProject(file);
    const command={schemaVersion:'1.0',kind:'kacha-editor-command',operation:'marker_set',arguments:{marker:{id:'test',tick:0,label:'test'}},baseSha256:project.session.currentSha256};
    const open = fs.openSync;
    fs.openSync = (file,...args) => { if(String(file).endsWith('journal.jsonl') && args[0] === 'a') throw new Error('synthetic journal I/O failure'); return open(file,...args); };
    try { assert.throws(()=>applyEditorCommand(file,command),/已恢复/); }
    finally { fs.openSync = open; }
    assert.deepEqual(fs.readFileSync(file),before);assert.equal(openEditorProject(file).status,'pass');
    assert.equal(applyEditorCommand(file,command).status,'pass');
  });
  test('recovery-restores-original-minified-snapshot-and-remains-recoverable',()=>{
    const file=save('recovery.json',base()),before=fs.readFileSync(file);openEditorProject(file);
    for(let i=0;i<2;i++) {fs.writeFileSync(file,'{"broken":');const recovered=recoverEditorProject(file,{expectedCurrentSha256:sha256File(file)});assert.equal(recovered.status,'pass');assert.deepEqual(fs.readFileSync(file),before);}
  });
  test('sparse-named-and-reordered-transitions-share-render-boundaries',()=>{
    const plan=base();plan.edl=[0,1,2].map(n=>({id:`clip-${n}`,sourceStart:n,sourceEnd:n+1}));
    for(const transitions of [[{boundaryIndex:1,durationFrames:5,effectId:'soft_dissolve'}],[{afterClipId:'clip-1',durationFrames:5,effectId:'soft_dissolve'}],
      [{boundaryIndex:1,durationFrames:5,effectId:'soft_dissolve'},{boundaryIndex:0,durationFrames:0}]]) {
      plan.transitions=transitions;const file=save('transitions.json',plan),projection=buildTimelineProjection(file);
      const ticks=projection.timebase.ticksPerSecond;assert.deepEqual(projection.items.filter(x=>x.type==='picture').map(x=>x.startTick/ticks),[0,1,1.8]);
      const graph=path.join(root,'graph.json');exec(process.execPath,[path.join(repo,'scripts/timeline_ir.mjs'),'compile','--plan',file,'--graph',graph]);
      assert.deepEqual(readJson(graph).transitions.map(x=>x.durationFrames),[0,5]);
    }
    plan.transitions=[{boundaryIndex:1,durationFrames:5},{boundaryIndex:1,durationFrames:0}];assert.throws(()=>buildTimelineProjection(save('duplicate.json',plan)),/重复/);
  });
  const timeline=save('network.json',base());
  const request=save('request.json',networkRequest(timeline,{start:1,end:1.04,text:'红色一帧',purpose:'检查极短选段',query:'red'}));
  const manifest=save('manifest.json',{schema:'kacha.media-manifest.v1',items:[{asset_id:1,kind:'video',local_path:source,sha256:sha256File(source),source_url:'https://example.com/fixture',creator:'synthetic fixture',license_url:'https://example.com/license'}]});
  const selectionFile=save('selection.json',selectionTemplate(request,manifest,1));
  test('one-frame-inspection-stays-inside-selected-range',()=>{
    const result=inspectSelection(selectionFile,path.join(root,'frames'));
    for(const frame of result.frames) {
      assert.equal(frame.atSeconds,0);
      const pixel=run('ffmpeg',['-v','error','-i',frame.path,'-vf','crop=2:2:10:10,format=rgb24','-frames:v','1','-f','rawvideo','-'],{encoding:null});
      assert.equal(pixel.status,0);assert.ok(pixel.stdout[0]>180 && pixel.stdout[2]<30);
    }
  });
  test('nonzero-container-origin-keeps-relative-inspection-times',()=>{
    const shifted=path.join(root,'shifted.mp4');ff(['-i',source,'-c','copy','-output_ts_offset','5',shifted]);
    const shiftedManifest=readJson(manifest);Object.assign(shiftedManifest.items[0],{local_path:shifted,sha256:sha256File(shifted)});
    const file=save('shifted-selection.json',selectionTemplate(request,save('shifted-manifest.json',shiftedManifest),1));
    const result=inspectSelection(file,path.join(root,'shifted-frames'));
    for(const frame of result.frames){assert.equal(frame.atSeconds,0);const pixel=run('ffmpeg',['-v','error','-i',frame.path,'-vf','crop=2:2:10:10,format=rgb24','-frames:v','1','-f','rawvideo','-'],{encoding:null});assert.ok(pixel.stdout[0]>180&&pixel.stdout[2]<30);}
  });
  const selection=readJson(selectionFile);Object.assign(selection.review,{status:'approved',reviewer:'synthetic regression',reviewedAt:new Date().toISOString(),observation:'red',matchReason:'red frame',usageConditions:'owned fixture',attribution:'synthetic fixture',rightsChecked:true,fullSelectedRangeViewed:true});save('selection.json',selection);
  applyEditorCommand(timeline,{schemaVersion:'1.0',kind:'kacha-editor-command',baseSha256:sha256File(timeline),operation:'insert_media',arguments:{selectionPath:selectionFile,selectionSha256:sha256File(selectionFile),id:'insert'}});
  const adopted=readJson(timeline);
  const episode=episodeTemplate('review-fixture','ai-practice');Object.assign(episode,{question:'如何核对画面来源？',audienceTask:'检查画面',ownJudgment:'以真实画面为准'});
  Object.assign(episode.editingBrief,{firstSpokenQuestion:episode.question,closingAnswer:episode.ownJudgment,protectedMeaning:['合成测试'],networkMaterials:[fileIdentity(selectionFile)]});episode.context={recordedAt:'2026-10-10',toolVersion:'synthetic',inputScope:'synthetic'};
  const proof=save('proof.json',{synthetic:true});episode.evidence.forEach(x=>Object.assign(x,{...fileIdentity(proof),locator:'test',description:'synthetic'}));episode.beats.forEach(x=>Object.assign(x,{purpose:'synthetic',evidenceIds:episode.evidence.map(e=>e.id),timelineIds:['main','insert']}));const episodeFile=save('episode.json',episode);
  test('network-replacement-cannot-remove-review-and-raw-stock-fails-execution',()=>{
    assert.deepEqual(validateEpisode(episodeFile,{stage:'execution',timeline}).errors,[]);
    const index={schemaVersion:'1.0',kind:'kacha_media_index',digestVersion:'2',status:'pass',root,items:[{id:'unreviewed',ref:'@asset:unreviewed',kind:'video',path:source,identity:fileIdentity(source),range:null,fields:{},license:'owned',provenance:{kind:'stock_media',evidence:'unreviewed',externalUpload:false}}]};index.digest=mediaIndexDigest(index);const indexFile=save('index.json',index);
    assert.throws(()=>applyEditorCommand(timeline,{schemaVersion:'1.0',kind:'kacha-editor-command',baseSha256:sha256File(timeline),operation:'replace_media',itemId:'overlay:insert',arguments:{indexPath:indexFile,assetRef:'@asset:unreviewed'}}),/重新匹配审阅/);
    const localPlan=structuredClone(adopted);localPlan.visual.overlays[0].provenance={kind:'owned_local',evidence:'synthetic local'};
    const localTimeline=save('local-network.json',localPlan);
    index.items[0].provenance={kind:'merged_local_sources',evidence:['scan','download'],externalUpload:false,sources:[{kind:'local_file'},{kind:'stock_media',source:'https://example.com/stock'}]};
    index.items[0].private=true;index.items[0].distribution='project_private_only';index.digest=mediaIndexDigest(index);save('index.json',index);
    const bin=listProjectBin(localTimeline,{indexPath:indexFile}).items[0];assert.equal(bin.provenance.sources[1].kind,'stock_media');assert.equal(bin.private,true);assert.equal(bin.distribution,'project_private_only');
    assert.throws(()=>applyEditorCommand(localTimeline,{schemaVersion:'1.0',kind:'kacha-editor-command',baseSha256:sha256File(localTimeline),operation:'replace_media',itemId:'overlay:insert',arguments:{indexPath:indexFile,assetRef:'@asset:unreviewed'}}),/重新匹配审阅/);
    localPlan.visual.overlays[0].provenance=index.items[0].provenance;save('local-network.json',localPlan);
    assert.ok(validateEpisode(episodeFile,{stage:'execution',timeline:localTimeline}).errors.some(x=>x.includes('当前网络素材审阅')));
    const invalid=structuredClone(adopted);invalid.visual.overlays[0].provenance={kind:'stock_media',evidence:'unreviewed'};save('network.json',invalid);
    assert.ok(validateEpisode(episodeFile,{stage:'execution',timeline}).errors.some(x=>x.includes('当前网络素材审阅')));save('network.json',adopted);
  });
  test('network-contract-bundle-preserves-source-without-local-review-path',()=>{
    delete adopted.output.path;save('network.json',adopted);
    const output=path.join(root,'network-bundle');const bundle=createSelfContainedBundle(timeline,output);assert.equal(bundle.status,'contract_only');
    const contents=fs.readFileSync(path.join(output,'timeline.json'),'utf8');assert.ok(!contents.includes(root));
    const p=JSON.parse(contents).visual.overlays[0].provenance;assert.equal(p.source,'https://example.com/fixture');assert.equal(p.selectionSha256,sha256File(selectionFile));assert.equal(p.reviewBindingStatus,'requires_rebind');
    assert.equal(fs.existsSync(path.join(output,'Media')),false);
  });
  test('private-source-media-never-enter-portable-bundle',()=>{
    const plan=base();delete plan.output.path;
    for(const flags of [{private:true},{distribution:'project_private_only'},{provenance:{kind:'owned_local',evidence:'test',redistributionAllowed:false}},{provenance:{kind:'project_sfx_library',evidence:'internal grant'}},{provenance:{kind:'owned_local',evidence:'test',sources:[{private:true}]}}]) {
      const candidate=structuredClone(plan);Object.assign(candidate.source,flags);const file=save('private.json',candidate),output=path.join(root,'blocked-bundle');
      assert.throws(()=>createSelfContainedBundle(file,output,{includeMedia:true}),/禁止自包含/);assert.equal(fs.existsSync(output),false);
    }
    for (const distribution of ['public_distribution_allowed','public_bundle','public_bundle_allowed']) {
      const candidate=structuredClone(plan);candidate.source.distribution=distribution;
      assert.equal(createSelfContainedBundle(save(`public-${distribution}.json`,candidate),path.join(root,distribution),{includeMedia:true}).status,'portable_with_authorized_media');
    }
    const output=path.join(root,'private-contract');assert.equal(createSelfContainedBundle(path.join(root,'private.json'),output).status,'contract_only');
  });
  test('webm-visual-duration-caches-scans-and-invalidates-on-source-or-tool-change',()=>{
    const webm=path.join(root,'clip.webm');ff(['-f','lavfi','-i','color=blue:s=64x64:r=25:d=2','-c:v','libvpx-vp9','-deadline','realtime',webm]);
    const probe=resolveRuntimeCommand('ffprobe'),log=path.join(root,'probe-log'),wrapper=path.join(root,'probe');
    fs.writeFileSync(wrapper,`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');const r=require('node:child_process').spawnSync(${JSON.stringify(probe)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);`,{mode:0o755});
    const original=process.env.KACHA_FFPROBE_BIN;process.env.KACHA_FFPROBE_BIN=wrapper;
    const scans=()=>fs.readFileSync(log,'utf8').split('\n').filter(x=>x.includes('packet=pts_time')).length;
    try {for(let i=0;i<5;i++)assert.equal(visualMediaDuration(webm),2);assert.equal(scans(),1);fs.appendFileSync(webm,Buffer.from([0]));assert.equal(visualMediaDuration(webm),2);assert.equal(scans(),2);fs.appendFileSync(wrapper,'\n// changed');assert.equal(visualMediaDuration(webm),2);assert.equal(scans(),3);}
    finally {if(original===undefined)delete process.env.KACHA_FFPROBE_BIN;else process.env.KACHA_FFPROBE_BIN=original;}
  });
  console.log(JSON.stringify({status:'pass',checks},null,2));
} finally { fs.rmSync(root,{recursive:true,force:true}); }
