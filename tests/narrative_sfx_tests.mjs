import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { validateSampleSpec, prepareSamples, sampleStatus, selectSample, attachSample } from '../scripts/narrative_samples.mjs';
import { synthesizePcm, synthesizeSfx, readSfx, attachSfx, soundTypes } from '../scripts/sfx_synthesize.mjs';
import { fileIdentity, sha256File, resolveRuntimeCommand } from '../scripts/kacha_utils.mjs';
const run=(cmd,args)=>{const r=spawnSync(resolveRuntimeCommand(cmd),args,{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v));
const spec={recipe:'steps',title:'Check the answer',items:[{label:'Ask',detail:'Define the task'},{label:'Verify',detail:'Read the source'}],evidence:'Synthetic demonstration',durationSeconds:6};
const sfx={type:'click',trigger:'Card lands on screen',libraryCheck:'Local palette checked; need shorter onset'};
test('strict narrative contract and deterministic bounded DSP',()=>{
 assert.equal(validateSampleSpec(spec).pack,'generic');
 for(const bad of [{recipe:'unknown'},{width:1920},{items:[spec.items[0]]},{durationSeconds:1},{fps:60},{remote:'https://example.com'},{items:[null,null]}])assert.throws(()=>validateSampleSpec({...spec,...bad}));
 for(const type of soundTypes){const a=synthesizePcm({...sfx,type}),b=synthesizePcm({...sfx,type});assert.deepEqual(a.wav,b.wav);assert.equal(a.wav.readUInt32LE(24),48000);assert.equal(a.wav.readUInt16LE(22),2);assert.equal(a.wav.readInt16LE(44),0);assert.equal(a.wav.readInt16LE(a.wav.length-2),0);let max=0;for(let i=44;i<a.wav.length;i+=2)max=Math.max(max,Math.abs(a.wav.readInt16LE(i)));assert.ok(max>100 && max<6000);}
 for(const type of soundTypes){const {wav}=synthesizePcm({...sfx,type,pitchHz:80,durationSeconds:.08});let sum=0;for(let i=44;i<wav.length;i+=4)sum+=wav.readInt16LE(i);assert.ok(Math.abs(sum/((wav.length-44)/4))<1,'quantized mean must remain below one PCM unit even for the shortest bass impact');}
 assert.notDeepEqual(synthesizePcm(sfx).wav,synthesizePcm({...sfx,seed:2}).wav);
 for(const bad of [{durationSeconds:Infinity},{durationSeconds:0},{peakDb:0},{pitchHz:22000},{seed:0},{type:'voice'},{trigger:''},{libraryCheck:''},{script:'eval'}])assert.throws(()=>synthesizePcm({...sfx,...bad}));
});
test('real queued narrative render, optimistic selection, composition and audio placement',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-narrative-tests-'));
 const previous=process.env.KACHA_CONFIG;
 try {
 const font=run('fc-match',['--format','%{file}','DejaVu Sans']).trim();assert.ok(fs.existsSync(font));
 const registry=path.join(root,'fonts.json'), config=path.join(root,'config.json');
 write(registry,{records:[{file:font,sha256:sha256File(font),families:['Test Sans'],license:{status:'open'}}]});write(config,{schemaVersion:'1.0',tools:{fontRegistry:registry}});process.env.KACHA_CONFIG=config;
 const kit=path.join(root,'samples');
 const prepared=prepareSamples({spec,output:kit});assert.equal(prepared.status,'queued');
 let status;
 for(let i=0;i<180;i++){status=sampleStatus(kit);if(status.ready)break;if(['failed','cancelled'].includes(status.status))throw Error(JSON.stringify(status));await new Promise(r=>setTimeout(r,500));}
 assert.ok(status.ready,JSON.stringify(status));
 const metrics=path.join(kit,'.kacha/metrics/events.jsonl');for(let i=0;i<40&&!fs.existsSync(metrics);i++)await new Promise(r=>setTimeout(r,50));const event=JSON.parse(fs.readFileSync(metrics,'utf8').trim().split('\n').at(-1));assert.equal(event.media.videoEncodes,2);assert.equal(event.media.renderedSeconds,spec.durationSeconds*2);
 assert.equal(status.entries.length,2);assert.notEqual(status.entries[0].video.sha256,status.entries[1].video.sha256);
 await t.test('selection refuses stale revisions and concurrent replacement',()=>{
  assert.throws(()=>selectSample({directory:kit,variant:'overview',expectedDigest:'wrong',reason:'Read all at once'}));
  status=selectSample({directory:kit,variant:'overview',expectedDigest:status.digest,reason:'Read all at once'});
  assert.equal(sampleStatus(kit).selection.digest,status.selection.digest);
  assert.throws(()=>selectSample({directory:kit,variant:'guided',expectedDigest:status.digest,reason:'Focus sequentially'}),/其他窗口/);
  status=selectSample({directory:kit,variant:'guided',expectedDigest:status.digest,expectedSelection:status.selection.digest,reason:'Focus sequentially'});
 });
 const source=path.join(root,'source.mp4');run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=1280x720:r=25:d=7','-f','lavfi','-i','sine=frequency=440:duration=7','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
 const timeline=path.join(root,'timeline.json');const original={schemaVersion:'1.0',projectId:'narrative-test',mode:'preview',source:{...fileIdentity(source),path:'./source.mp4'},edl:[{id:'all',sourceStart:0,sourceEnd:7}],output:{width:1280,height:720,fps:25,path:'old.mp4'},audio:{sourceGain:.5},review:{status:'pass'}};write(timeline,original);
 const base={directory:kit,timeline,expectedSha:sha256File(timeline),expectedSelection:status.selection.digest,output:path.join(root,'sample-candidate.json'),start:0,reason:'Explain the verification flow'};
 for(const change of [{expectedSha:'bad'},{expectedSelection:'bad'},{start:.01},{start:2},{reason:''},{output:timeline}])assert.throws(()=>attachSample({...base,...change}));
 const attached=attachSample(base), plan=JSON.parse(fs.readFileSync(attached.candidate.path));assert.equal(plan.review,undefined);assert.deepEqual(plan.audio,original.audio);assert.equal(sha256File(timeline),base.expectedSha);
 const soundRoot=path.join(root,'sound'),sound=synthesizeSfx({spec:sfx,output:soundRoot});assert.equal(sound.apiCalls,0);assert.ok(sound.measurement.measuredPeakOffsetSeconds>=0);
 const soundBase={directory:soundRoot,timeline:attached.candidate.path,expectedSha:attached.candidate.sha256,output:path.join(root,'combined.json'),target:1};
 assert.throws(()=>attachSfx({...soundBase,target:7}),/尾部/);
 const audio=attachSfx(soundBase);assert.ok(audio.alignment.withinTolerance);assert.equal(JSON.parse(fs.readFileSync(audio.candidate.path)).audio.sfx.length,1);
 run(process.execPath,['scripts/kacha.mjs','timeline','render','--plan',audio.candidate.path]);
 const combined=JSON.parse(fs.readFileSync(audio.candidate.path));const probed=JSON.parse(run('ffprobe',['-v','error','-show_streams','-of','json',combined.output.path]));assert.ok(probed.streams.some(s=>s.codec_type==='audio'));assert.equal(Number(probed.streams.find(s=>s.codec_type==='video').nb_frames),175);
 await t.test('native media controls read ranges without custom headers and concurrent reads share verification',async()=>{
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const server=spawn(process.execPath,['scripts/kacha_studio_server.mjs','--port',String(port),'--no-open'],{stdio:'ignore'});
  const origin=`http://127.0.0.1:${port}`;
  try {
   let ready=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
   const targetResponse=await fetch(origin+'/api/samples/target',{method:'POST',headers:{'Content-Type':'application/json','X-Kacha-Studio':'1'},body:JSON.stringify({package:timeline})});assert.equal(targetResponse.status,200,await targetResponse.clone().text());const targetInfo=await targetResponse.json();assert.equal(targetInfo.identity.sha256,base.expectedSha);assert.equal(targetInfo.durationSeconds,7);
   const urls=status.entries.map(e=>`${origin}/api/samples/media?${new URLSearchParams({package:kit,variant:e.id,sha:e.video.sha256})}`);
   const responses=await Promise.all(urls.map(url=>fetch(url,{headers:{Range:'bytes=0-31'}})));
   for(const response of responses){assert.equal(response.status,206,await response.text());assert.equal(response.headers.get('content-type'),'video/mp4');}
   fs.utimesSync(status.entries[0].video.path,new Date(),new Date());const touched=await fetch(urls[0],{headers:{Range:'bytes=0-31'}});assert.equal(touched.status,206,await touched.text());
   const soundUrl=`${origin}/api/sfx/media?${new URLSearchParams({package:soundRoot,sha:sound.audio.sha256})}`;
   const wav=await fetch(soundUrl,{headers:{Range:'bytes=0-43'}});assert.equal(wav.status,206);assert.equal(wav.headers.get('content-type'),'audio/wav');assert.equal((await wav.arrayBuffer()).byteLength,44);
   const cross=await fetch(urls[0],{headers:{Origin:'https://example.com'}});assert.ok(cross.status>=400);
   const stale=await fetch(urls[0].replace(status.entries[0].video.sha256,'0'.repeat(64)));assert.ok(stale.status>=400);
  } finally {server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}
 });
 await t.test('tampering and incompatible fonts fail closed' ,()=>{
  fs.appendFileSync(sound.audio.path,'changed');assert.throws(()=>readSfx(soundRoot),/变化/);
  fs.appendFileSync(status.entries[0].video.path,'changed');assert.throws(()=>sampleStatus(kit),/改变/);
  assert.throws(()=>prepareSamples({spec:{...spec,title:'\u{10FFFF}'},output:path.join(root,'missing-glyph')}),/缺字/);assert.ok(!fs.existsSync(path.join(root,'missing-glyph')));
  write(registry,{records:[]});assert.throws(()=>prepareSamples({spec,output:path.join(root,'no-font')}),/授权字体/);
 });
 }finally{if(previous===undefined)delete process.env.KACHA_CONFIG;else process.env.KACHA_CONFIG=previous;fs.rmSync(root,{recursive:true,force:true});}
});
