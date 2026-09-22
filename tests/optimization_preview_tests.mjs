import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {previewClosure} from '../scripts/preview_range.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-preview-v5-'));
const run=(cmd,args,options={})=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:20*1024*1024,...options});assert.equal(r.status,0,`${cmd}: ${r.stderr}`);return r;};
try{
 const source=path.join(root,'source.mp4'),planFile=path.join(root,'timeline.json'),full=path.join(root,'full.mp4'),part=path.join(root,'part.mp4'),graph=path.join(root,'part.json');
 run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=14','-f','lavfi','-i','aevalsrc=0.15*sin(2*PI*(220+10*t)*t):s=48000:d=14','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
 const edl=Array.from({length:5},(_,i)=>({id:`c${i}`,sourceStart:i*3,sourceEnd:i*3+2}));
 const transitions=Array.from({length:4},(_,i)=>({boundaryIndex:i,effectId:'soft_dissolve',durationFrames:5}));
 const plan={schemaVersion:'1.0',projectId:'closure',mode:'preview',source:{path:source},edl,transitions,visual:{overlays:[],breathing:[]},audio:{},output:{path:full,width:320,height:180,fps:25}};
 fs.writeFileSync(planFile,JSON.stringify(plan));
 const render=(out,extras=[])=>run(process.execPath,[path.join(repo,'scripts/timeline_ir.mjs'),'render','--plan',planFile,'--output',out,...extras]);
 render(full);render(part,['--range-start','5.2','--range-end','5.8','--graph',graph]);
 const compiled=JSON.parse(fs.readFileSync(graph,'utf8'));
 assert.equal(compiled.edl.length,2);assert.equal(compiled.transitions.length,1);assert.ok(compiled.sourceSeekSeconds>=6);assert.equal(compiled.rangeEvidence.originalClips,5);
 const pcm=(file,start)=>run('ffmpeg',['-v','error','-i',file,'-ss',String(start),'-t','0.6','-map','0:a','-ac','1','-ar','48000','-f','f32le','-'],{encoding:null}).stdout;
 const a=pcm(full,5.2),b=pcm(part,0),count=Math.min(a.length,b.length)/4;let dot=0,aa=0,bb=0;
 for(let i=256;i<count-256;i++){const x=a.readFloatLE(i*4),y=b.readFloatLE(i*4);dot+=x*y;aa+=x*x;bb+=y*y;}
 const correlation=dot/Math.sqrt(aa*bb);assert.ok(correlation>.97,`audio boundary mismatch ${correlation}`);
 const closure=previewClosure(edl.map(e=>({...e,duration:2})),transitions.map(t=>({...t,durationSeconds:.2})),{start:7.6,end:8},25);assert.equal(closure.edl.length,1);assert.ok(Math.abs(closure.edl[0].duration-.4)<1e-6);
 const badge=path.join(root,'badge.png'),tail=path.join(root,'tail.wav');
 run('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=40x30:d=0.1','-frames:v','1',badge]);
 run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1',tail]);
 plan.visual.overlays=[{id:'move',kind:'image',path:badge,start:4.8,end:6.2,x:20,y:30,width:40,height:30,keyframes:{x:[{tick:576000,time:4.8,value:20},{tick:744000,time:6.2,value:240}]}}];
 plan.audio={sfx:[{id:'tail',path:tail,time:5,levelBelowDialogueDb:8}],bgm:{sidechain:false,segments:[{id:'fade',path:source,start:4.8,end:6.2,sourceStart:0,fadeInSeconds:.6,fadeOutSeconds:.2,levelBelowDialogueDb:16}]}};
 fs.writeFileSync(planFile,JSON.stringify(plan));
 const effectsFull=path.join(root,'effects-full.mp4'),effectsPart=path.join(root,'effects-part.mp4'),effectsGraph=path.join(root,'effects-graph.json');render(effectsFull);render(effectsPart,['--range-start','5.2','--range-end','5.8','--graph',effectsGraph]);
 const eg=JSON.parse(fs.readFileSync(effectsGraph,'utf8'));assert.ok(eg.visual.overlays[0].keyframes.x[0].time<0);assert.ok(eg.audio.sfx[0].sourceTrimSeconds>.19);
 const ea=pcm(effectsFull,5.2),eb=pcm(effectsPart,0);let edot=0,eaa=0,ebb=0;
 for(let i=256;i<Math.min(ea.length,eb.length)/4-256;i++){const x=ea.readFloatLE(i*4),y=eb.readFloatLE(i*4);edot+=x*y;eaa+=x*x;ebb+=y*y;}assert.ok(edot/Math.sqrt(eaa*ebb)>.97,'SFX tail or BGM envelope differs');
 const frame=(file,start)=>run('ffmpeg',['-v','error','-i',file,'-ss',String(start),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:null}).stdout;
 const fa=frame(effectsFull,5.2),fb=frame(effectsPart,0);assert.equal(fa.length,fb.length);const mae=fa.reduce((sum,v,i)=>sum+Math.abs(v-fb[i]),0)/fa.length;assert.ok(mae<8,`preview picture/keyframe mismatch ${mae}`);
 plan.audio={bgm:{path:source,levelBelowDialogueDb:20,sidechain:{}}};fs.writeFileSync(planFile,JSON.stringify(plan));
 const stateful=path.join(root,'stateful.mp4');render(stateful,['--range-start','5.2','--range-end','5.8','--graph',path.join(root,'stateful.json')]);
 const sg=JSON.parse(fs.readFileSync(path.join(root,'stateful.json'),'utf8'));assert.equal(sg.rangeExpansionReason,'stateful_audio_history');assert.equal(sg.finalTrimSeconds,5.2);
 console.log(JSON.stringify({status:'pass',audioCorrelation:correlation,effectsAudioCorrelation:edot/Math.sqrt(eaa*ebb),frameMeanAbsoluteError:mae,selectedClips:2,originalClips:5,checks:['overlap-phase','source-audio-trim','moving-overlay-phase','sfx-tail','bgm-envelope','stateful-history-expansion','single-clip-range']}));
}finally{if(!process.env.KACHA_KEEP_TEST_OUTPUT)fs.rmSync(root,{recursive:true,force:true});else console.log(root);}
