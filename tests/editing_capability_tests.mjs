import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, readJson, sha256File } from '../scripts/kacha_utils.mjs';
import { openEditorProject, applyEditorCommand, undoEditorCommand, redoEditorCommand } from '../scripts/editor_command_journal.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-editing-capabilities-'));
const checks = [], failures = [];
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const exec = (command, args) => {
  const result = run(command, args, { timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return result;
};
const ff = args => exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
const cli = (action, file, ...args) => exec(process.execPath, [path.join(repo, 'scripts/timeline_ir.mjs'), action, '--plan', file, ...args]);
const source = path.join(root, 'source.mp4'), insert = path.join(root, 'insert.mp4');
ff(['-f', 'lavfi', '-i', 'color=black:s=320x180:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
ff(['-f', 'lavfi', '-i', 'color=red:s=100x100:r=25:d=0.8', '-f', 'lavfi', '-i', 'color=blue:s=100x100:r=25:d=1.2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', insert]);
const base = () => ({schemaVersion:'1.0',projectId:'editing-capability',mode:'preview',source:{path:source,sha256:sha256File(source)},edl:[{id:'main',sourceStart:0,sourceEnd:3}],visual:{overlays:[],breathing:[]},audio:{sfx:[]},output:{width:320,height:180,fps:25,path:path.join(root,'unused.mp4')}});
async function check(name, fn) {
  try { await fn(); checks.push(name); } catch (error) { failures.push({name,error:error.message}); }
}
function rgb(file,time,x=50,y=50) {
  // Outputs use 25 fps. Decode by frame index: input seeking can round a
  // boundary timestamp to the next frame differently across FFmpeg versions.
  const frame=time*25;assert.ok(Math.abs(frame-Math.round(frame))<1e-6,'pixel measurement must be frame-aligned');
  const r=run('ffmpeg',['-hide_banner','-v','error','-i',file,'-vf',`select=eq(n\\,${Math.round(frame)}),crop=2:2:${x}:${y},format=rgb24`,'-frames:v','1','-f','rawvideo','-'],{encoding:null});
  assert.equal(r.status,0,r.stderr?.toString());assert.equal(r.stdout.length,12,'expected one decoded 2x2 RGB frame');return [...r.stdout.subarray(0,3)];
}
try {
  await check('video-overlay-trim-preserves-selected-source-frames',()=>{
    const plan=base(),file=path.join(root,'trim.json'),output=path.join(root,'trim.mp4');
    plan.visual.overlays=[{id:'insert',kind:'video',path:insert,start:0,end:2,x:0,y:0,width:100,height:100}];write(file,plan);
    const project=openEditorProject(file);
    applyEditorCommand(file,{schemaVersion:'1.0',kind:'kacha-editor-command',baseSha256:project.session.currentSha256,itemId:'overlay:insert',operation:'trim',arguments:{edge:'start',outputTick:120000}});
    cli('render',file,'--output',output);
    const p=rgb(output,1.12);assert.ok(p[2]>150 && p[0]<70,`trim replayed discarded frames: ${p}`);
  });
  await check('mixed-source-and-output-framerate-transition-renders-exact-frame-count',()=>{
    const plan=base(),file=path.join(root,'transitions.json'),output=path.join(root,'transitions.mp4');
    plan.edl=[0,1,2].map((n)=>({id:`clip-${n}`,sourceStart:n,sourceEnd:n+1}));
    plan.transitions=[0,1].map(boundaryIndex=>({boundaryIndex,durationFrames:5,effectId:'soft_dissolve'}));write(file,plan);
    cli('render',file,'--output',output);
    const result=JSON.parse(exec('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames,r_frame_rate','-of','json',output]).stdout);
    assert.equal(Number(result.streams[0].nb_read_frames),65);
  });
  await check('overlay-keyframe-trim-keeps-motion-phase-and-valid-boundaries',()=>{
    const plan=base(),file=path.join(root,'keyframes.json');
    plan.visual.overlays=[{id:'insert',kind:'video',path:insert,start:0,end:2,x:0,y:0,width:100,height:100,keyframes:{x:[{tick:0,time:0,value:0},{tick:240000,time:2,value:200}]}}];write(file,plan);
    const project=openEditorProject(file);
    applyEditorCommand(file,{schemaVersion:'1.0',kind:'kacha-editor-command',baseSha256:project.session.currentSha256,itemId:'overlay:insert',operation:'trim',arguments:{edge:'start',outputTick:120000}});
    const overlay=readJson(file).visual.overlays[0];assert.equal(overlay.keyframes.x[0].tick,120000);assert.equal(overlay.keyframes.x[0].value,100);cli('validate',file);
    const output=path.join(root,'keyframes.mp4');cli('render',file,'--output',output);
    assert.ok(rgb(output,1.4,155,50)[2]>150,'motion should remain at the original interpolated position');
    assert.ok(rgb(output,1.4,110,50).every(c=>c<25),'motion must not restart at the trimmed in-point');
  });
  await check('overlay-out-point-is-exclusive-without-extra-frame',()=>{
    const plan=base(),file=path.join(root,'outpoint.json'),output=path.join(root,'outpoint.mp4');
    plan.visual.overlays=[{id:'insert',kind:'video',path:insert,start:0,end:2,x:0,y:0,width:100,height:100}];write(file,plan);cli('render',file,'--output',output);
    const before=rgb(output,1.96),after=rgb(output,2);
    assert.ok(before[2]>150,`overlay ended before its out-point: ${before}`);assert.ok(after.every(c=>c<25),`overlay remained on its exclusive end frame: ${after}`);
  });
  await check('rough-and-fine-edits-remain-reversible-and-frame-accurate',()=>{
    const plan=base(),file=path.join(root,'edits.json'),output=path.join(root,'edits.mp4');write(file,plan);
    let project=openEditorProject(file);
    const edit=command=>{project=applyEditorCommand(file,{schemaVersion:'1.0',kind:'kacha-editor-command',baseSha256:project.session.currentSha256,...command}).project;};
    edit({itemId:'picture:main',operation:'split',arguments:{outputTick:120000,newId:'tail'}});
    edit({operation:'reorder',arguments:{itemIds:['picture:tail','picture:main']}});
    edit({itemId:'picture:tail',operation:'ripple_trim',arguments:{edge:'end',outputTick:182400}});
    assert.equal(project.projection.durationTick,302400);
    const before=sha256File(file),undone=undoEditorCommand(file,project.session.currentSha256);
    project=redoEditorCommand(file,undone.timelineSha256).project;assert.equal(sha256File(file),before);
    edit({operation:'overwrite',arguments:{outputStartTick:0,outputEndTick:57600,sourceStartTick:240000,sourceEndTick:297600,newId:'replacement'}});
    const edl=readJson(file).edl;assert.equal(edl[0].sourceStart,2);assert.equal(edl[0].sourceEnd,2.48);
    cli('render',file,'--output',output);
    const probe=JSON.parse(exec('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','json',output]).stdout);
    assert.equal(Number(probe.streams[0].nb_read_frames),63);
  });
  console.log(JSON.stringify({status:failures.length?'fail':'pass',root,checks,failures},null,2));
  if(failures.length) process.exitCode=1;
} finally { if(!process.env.KACHA_KEEP_EDITING_FIXTURES && failures.length===0)fs.rmSync(root,{recursive:true,force:true}); }
