import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {fileIdentity,mediaSummary,readJson,writeJsonAtomic} from '../scripts/kacha_utils.mjs';import {renderMediaContract} from '../scripts/render_media_contract.mjs';import {compileNetstyleUnified} from '../scripts/netstyle_unified.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-render-v5-'));
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:20*1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r;};
try{
 const source=path.join(root,'ten.mp4');run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=25:d=1','-pix_fmt','yuv420p10le','-c:v','libx265','-preset','ultrafast','-x265-params','log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv',source]);
 const contract=path.join(root,'engineering-contract.json');writeJsonAtomic(contract,{engineeringFixture:true,productionAccepted:false});
 const timeline=path.join(root,'ten.json'),output=path.join(root,'ten-final.mp4');writeJsonAtomic(timeline,{schemaVersion:'1.0',mode:'final',projectId:'depth',source:fileIdentity(source),contracts:{proposal:fileIdentity(contract),editPlan:fileIdentity(contract)},edl:[{id:'a',sourceStart:0,sourceEnd:1}],visual:{},audio:{},output:{path:output,width:160,height:90,fps:25}});
 run(process.execPath,[path.join(repo,'scripts/timeline_ir.mjs'),'render','--plan',timeline]);
 const probe=mediaSummary(output);assert.equal(probe.video.pix_fmt,'yuv420p10le');assert.equal(probe.video.color_primaries,'bt709');assert.equal(probe.video.color_transfer,'bt709');
 assert.throws(()=>renderMediaContract({pix_fmt:'yuv420p10le',color_transfer:'smpte2084'},'final'),/HDR/);
 assert.throws(()=>renderMediaContract({pix_fmt:'yuv420p10le'},'final',{complex:true}),/复杂/);
 const sdr=path.join(root,'sdr.mp4');run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=2','-c:v','libx264','-preset','ultrafast',sdr]);
 const planFile=path.join(root,'netstyle-plan.json');const plan={source:{input:fileIdentity(sdr)},events:[{id:'zoom',effectId:'semantic_importance_zoom',startSeconds:.4,endSeconds:1.2,peakSeconds:.8,display:{title:'focus',subtitle:'',items:[]}}]};writeJsonAtomic(planFile,plan);
 const one=compileNetstyleUnified(plan,planFile,path.join(root,'one.json'),{noSfx:true});const two=compileNetstyleUnified(plan,planFile,path.join(root,'two.json'),{noSfx:true});
 assert.equal(one.plainIntervalsEncoded,0);assert.equal(two.coverage[0].cache.status,'hit');
 run(process.execPath,[path.join(repo,'scripts/timeline_ir.mjs'),'render','--plan',one.timeline.path]);assert.equal(readJson(one.timeline.path).visual.overlays.length,1);
 console.log(JSON.stringify({status:'pass',checks:['actual-10bit-export','bt709-metadata','hdr-fail-closed','complex-high-depth-fail-closed','cached-local-effect','no-gap-encodes','unified-final-composition']}));
}finally{if(!process.env.KACHA_KEEP_TEST_OUTPUT)fs.rmSync(root,{recursive:true,force:true});else console.log(root);}
