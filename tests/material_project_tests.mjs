#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeMaterialProject, inspectMaterial, composeMaterialProject, materialProjectStatus, renderMaterialProject, runMaterialProject } from "../scripts/material_project.mjs";
import { run, readJson, sha256File, sha256Value } from "../scripts/kacha_utils.mjs";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = process.argv.indexOf("--output-dir");
const persistent = argument >= 0 ? path.resolve(process.argv[argument + 1]) : null;
const temp = persistent ?? fs.mkdtempSync(path.join(os.tmpdir(), "kacha-material-tests-"));
const checks = [];
const ff = (args) => { const result = run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", ...args]); assert.equal(result.status, 0, result.stderr); };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2)+"\n");
try {
  fs.mkdirSync(temp, { recursive: true });
  const inputs = path.join(temp, "输入素材"); fs.mkdirSync(inputs);
  const video = path.join(inputs, "red ' source.mp4"), image = path.join(inputs, "blue.png"), portrait = path.join(inputs, "portrait.mp4");
  ff(["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "color=c=yellow:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  ff(["-f", "lavfi", "-i", "color=c=blue:s=240x240", "-frames:v", "1", "-update", "1", image]);
  ff(["-f", "lavfi", "-i", "color=c=green:s=180x320:r=24:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", portrait]);
  fs.writeFileSync(path.join(inputs,"notes.txt"),"not media");
  const sourceHashes = [video,image,portrait].map(sha256File);
  const projectRoot = path.join(temp,"project");
  const runtime = { sourceRef: "synthetic-development-test", productionReady: false };
  const initial = initializeMaterialProject({ materials:[inputs,video], requirements:"6秒短片，红色开场，蓝色图片居中，竖屏绿色素材结尾；保持原声，完整保留画面。", projectRoot, duration:6, width:320, fps:25, development:true, confirmExecute:true, runtime });
  assert.equal(initial.assets.count,3); assert.equal(initial.assets.images,1); assert.equal(initial.status,"awaiting_storyboard");
  assert.equal(initial.assets.skipped.length,1);
  assert.throws(()=>initializeMaterialProject({materials:[inputs],requirements:"x",projectRoot,development:true,runtime}),/空目录/);
  checks.push("mixed-recursive-inventory-deduplicates-paths-and-protects-existing-projects");
  const project=readJson(path.join(projectRoot,".kacha/material-project.json")); const brief=readJson(project.brief.path);
  const assets=[video,image,portrait].map((file)=>project.assets.find((asset)=>asset.path===fs.realpathSync(file)));
  for(const asset of assets) { const evidence=inspectMaterial(projectRoot,asset.id); assert.ok(evidence.frames.length); }
  assert.throws(()=>inspectMaterial(projectRoot,assets[0].id,{timestamps:[5]}),/范围/);
  checks.push("real-frame-inspection-and-timestamp-bounds");
  const board={schemaVersion:"1.0",kind:"kacha_material_storyboard",projectDigest:project.digest,briefDigest:brief.digest,
    interpretation:"按红、蓝、绿组织，混合视频和图片，保留红色视频原声，画幅完整适配。",
    requirements:[{id:"sequence",text:"按红蓝绿顺序展示",check:"semantic",assetIds:[]},{id:"all",text:"三个素材都出现",check:"include_assets",assetIds:assets.map(a=>a.id)}],
    segments:assets.map((asset,i)=>({id:`shot-${i}`,assetId:asset.id,sourceIn:0,duration:2,fit:"contain",audio:"source",role:["opening","detail","ending"][i],observation:["红色画面伴随音调","蓝色正方形静态图","竖屏绿色视频且无音轨"][i],reason:"满足规定顺序并保留完整画面",satisfies:["sequence","all"],caption:["RED","BLUE","GREEN"][i]}))};
  const boardFile=path.join(temp,"storyboard.json");
  const bad=(mutate,regex)=>{const copy=structuredClone(board);mutate(copy);write(boardFile,copy);assert.throws(()=>composeMaterialProject(projectRoot,boardFile),regex);};
  bad(b=>b.segments[0].sourceIn=3,/边界/);
  bad(b=>{b.segments[0].duration=1;delete b.segments[0].caption;},/总时长/);
  bad(b=>b.segments[0].fit="cover",/裁切/);
  bad(b=>b.segments[0].audio="mute",/静音/);
  bad(b=>b.segments[0].caption="这是一条在两秒钟内根本不可能读完的超长说明字幕",/停留不足/);
  bad(b=>b.requirements.push({id:"no-blue",text:"不能出现蓝图",check:"exclude_assets",assetIds:[assets[1].id]}),/排除/);
  bad(b=>b.briefDigest="0".repeat(64),/绑定/);
  checks.push("storyboard-enforces-requirements-duration-source-ranges-crop-audio-and-reading");
  write(boardFile,board); const composed=composeMaterialProject(projectRoot,boardFile);
  assert.equal(composed.status,"ready_to_render"); assert.equal(composed.candidate,null);
  const identity=readJson(path.join(projectRoot,".kacha/material-active-plan.json")).plan;
  composeMaterialProject(projectRoot,boardFile); assert.deepEqual(readJson(path.join(projectRoot,".kacha/material-active-plan.json")).plan,identity);
  checks.push("versioned-plan-is-idempotent-and-not-a-render-claim");
  assert.throws(()=>renderMaterialProject(projectRoot,{expectedPlanDigest:"stale"}),/排队后/);
  let rendered=renderMaterialProject(projectRoot); assert.equal(rendered.status,"candidate_ready");
  assert.equal(rendered.boundaries.humanReviewComplete,false);
  const first=readJson(path.join(path.dirname(rendered.candidate.path),"material-render.json"));
  assert.equal(first.qc.decode,"pass"); assert.equal(first.parts.length,3);
  assert.equal(first.finalVideoEncodes,1);
  assert.deepEqual([video,image,portrait].map(sha256File),sourceHashes);
  assert.equal(renderMaterialProject(projectRoot).candidate.sha256,rendered.candidate.sha256);
  const pixels=[.8,2.8,4.8].map(time=>{
    const result=run("ffmpeg",["-hide_banner","-v","error","-ss",String(time),"-i",rendered.candidate.path,"-vf","crop=2:2:(iw-2)/2:(ih-2)/2,format=rgb24","-frames:v","1","-f","rawvideo","-"],{encoding:null});
    assert.equal(result.status,0);return [...result.stdout.subarray(0,3)];
  });
  assert.ok(pixels[0][0]>150 && pixels[0][1]<80);
  assert.ok(pixels[1][2]>150 && pixels[1][0]<80);
  assert.ok(pixels[2][1]>70 && pixels[2][0]<80);
  const volume=(start)=>{
    const result=run("ffmpeg",["-hide_banner","-ss",String(start),"-t","0.8","-i",rendered.candidate.path,"-vn","-af","volumedetect","-f","null","-"]);
    assert.equal(result.status,0,result.stderr);return Number(/mean_volume: ([\-\d.]+) dB/.exec(result.stderr)?.[1]);
  };
  assert.ok(volume(.5)>-45);assert.ok(volume(2.5)<-70);
  checks.push("actual-video-image-portrait-render-keeps-sources-and-reuses-completed-candidate");
  checks.push("decoded-candidate-proves-shot-order-and-source-versus-silent-audio");
  // A content-only revision should reuse the normalized source clips.
  board.segments[1].caption="PHOTO"; write(boardFile,board); composeMaterialProject(projectRoot,boardFile);
  rendered=renderMaterialProject(projectRoot);
  const revised=readJson(path.join(path.dirname(rendered.candidate.path),"material-render.json"));
  assert.ok(revised.parts.every(part=>part.reused)); assert.notEqual(revised.planDigest,first.planDigest);
  assert.ok(fs.existsSync(first.output.path));
  checks.push("caption-revision-reuses-lossless-clips-and-preserves-prior-version");
  board.segments[0].sourceIn=2;board.segments[0].caption="YELLOW";board.segments[0].observation="源视频后半段为黄色画面";
  write(boardFile,board);composeMaterialProject(projectRoot,boardFile);rendered=renderMaterialProject(projectRoot);
  const seekPixel=run("ffmpeg",["-hide_banner","-v","error","-ss","0.8","-i",rendered.candidate.path,"-vf","crop=2:2:(iw-2)/2:(ih-2)/2,format=rgb24","-frames:v","1","-f","rawvideo","-"],{encoding:null});
  assert.equal(seekPixel.status,0);assert.ok(seekPixel.stdout[0]>150 && seekPixel.stdout[1]>150 && seekPixel.stdout[2]<80);
  const seekReceipt=readJson(path.join(path.dirname(rendered.candidate.path),"material-render.json"));
  assert.equal(seekReceipt.parts[0].reused,false);assert.ok(seekReceipt.parts.slice(1).every(part=>part.reused));
  checks.push("nonzero-source-selection-renders-selected-frames-and-invalidates-only-changed-clip");
  const status=run(process.execPath,[path.join(repository,"scripts/kacha.mjs"),"status",projectRoot,"--summary"]);
  assert.equal(status.status,0,status.stderr); assert.equal(JSON.parse(status.stdout).task,"material_edit");
  checks.push("standard-project-status-routes-material-projects");
  const receipt=path.join(path.dirname(rendered.candidate.path),"material-render.json");
  const good=fs.readFileSync(receipt); const corrupt=readJson(receipt); corrupt.planDigest="stale";const {digest,...unsigned}=corrupt;corrupt.digest=sha256Value(unsigned);write(receipt,corrupt);
  assert.throws(()=>materialProjectStatus(projectRoot),/成片已变化/);fs.writeFileSync(receipt,good);
  checks.push("redigested-render-receipt-cannot-change-plan-binding");
  const out=path.join(temp,"outside");fs.mkdirSync(out);
  const clipCache=path.join(projectRoot,".kacha/material-clips");fs.renameSync(clipCache,clipCache+".saved");fs.symlinkSync(out,clipCache);
  assert.throws(()=>materialProjectStatus(projectRoot),/越出/);fs.unlinkSync(clipCache);fs.renameSync(clipCache+".saved",clipCache);
  checks.push("project-write-paths-reject-symlink-escape");
  const tamperFile=path.join(temp,"tamper.png");fs.copyFileSync(image,tamperFile);
  const tamperRoot=path.join(temp,"tamper-project");
  initializeMaterialProject({materials:[tamperFile],requirements:"检查源身份",projectRoot:tamperRoot,duration:2,width:320,development:true,runtime});
  fs.appendFileSync(tamperFile,"changed");assert.throws(()=>materialProjectStatus(tamperRoot),/素材已变化/);
  checks.push("source-drift-invalidates-project");
  // Exercise the actual asynchronous lifecycle and a portrait image-only film with music.
  const imageRoot=path.join(temp,"image-project");
  const requirementsFile=path.join(temp,"image-requirements.txt");fs.writeFileSync(requirementsFile,"竖屏蓝色图片短片，配本地音调，无字幕");
  const startCli=run(process.execPath,[path.join(repository,"scripts/kacha.mjs"),"start","--materials",image,"--requirements-file",requirementsFile,"--project-root",imageRoot,"--duration","3","--aspect","9:16","--width","180","--development"]);
  assert.equal(startCli.status,0,startCli.stderr);assert.equal(JSON.parse(startCli.stdout).task,"material_edit");
  const imageProject=readJson(path.join(imageRoot,".kacha/material-project.json"));const imageBrief=readJson(imageProject.brief.path);const imageAsset=imageProject.assets[0];
  inspectMaterial(imageRoot,imageAsset.id);
  const imageBoard={schemaVersion:"1.0",kind:"kacha_material_storyboard",projectDigest:imageProject.digest,briefDigest:imageBrief.digest,
    interpretation:"竖屏图片三秒，居中裁切纯色画面并配本地音调",requirements:[{id:"blue",text:"蓝色图片短片",check:"include_assets",assetIds:[imageAsset.id]}],
    soundtrack:{path:video,reason:"本地合成测试音调，不是实际配乐质量证据",levelBelowDialogueDb:18},
    segments:[{id:"photo",assetId:imageAsset.id,sourceIn:0,duration:3,fit:"cover",cropReason:"纯色测试图无主体裁切风险",audio:"mute",role:"image_hold",observation:"蓝色纯色图",reason:"满足蓝色图片要求",satisfies:["blue"]}]};
  const imageBoardFile=path.join(temp,"image-storyboard.json");write(imageBoardFile,imageBoard);composeMaterialProject(imageRoot,imageBoardFile);
  assert.throws(()=>runMaterialProject(imageRoot,{runtime,includeRender:true}),/授权/);
  const submitted=runMaterialProject(imageRoot,{runtime,includeRender:true,confirmExecute:true});assert.equal(submitted.status,"render_submitted");
  const repeat=runMaterialProject(imageRoot,{runtime,includeRender:true,confirmExecute:true});assert.equal(repeat.job.ref,submitted.job.ref);assert.equal(repeat.status,"rendering");
  const cancel=run(process.execPath,[path.join(repository,"scripts/kacha_jobs.mjs"),"cancel",submitted.job.ref,"--project-root",imageRoot]);assert.equal(cancel.status,0,cancel.stderr);
  assert.equal(materialProjectStatus(imageRoot).status,"blocked");
  const resumed=runMaterialProject(imageRoot,{runtime,includeRender:true,confirmExecute:true,resume:true});assert.equal(resumed.job.ref,submitted.job.ref);
  let finished=null;
  for(let attempt=0;attempt<180;attempt++) {
    const state=materialProjectStatus(imageRoot);
    if(state.status==="candidate_ready"){finished=state;break;}
    assert.notEqual(state.status,"blocked",JSON.stringify(state.job));
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(finished,"background render did not finish within 180 seconds");
  const imageAudio=run("ffmpeg",["-hide_banner","-i",finished.candidate.path,"-vn","-af","volumedetect","-f","null","-"]);
  assert.equal(imageAudio.status,0,imageAudio.stderr);assert.ok(Number(/mean_volume: ([\-\d.]+) dB/.exec(imageAudio.stderr)?.[1])>-65);
  const finalSummary=run(process.execPath,[path.join(repository,"scripts/kacha.mjs"),"status",imageRoot,"--summary"]);
  assert.equal(finalSummary.status,0,finalSummary.stderr);assert.deepEqual(JSON.parse(finalSummary.stdout).progress,{complete:3,total:4});
  checks.push("image-only-portrait-with-music-through-real-queued-cancel-resume-and-deduplicated-run");
  const routed=run(process.execPath,[path.join(repository,"scripts/route_references.mjs"),"--task","material_edit"]);
  assert.equal(routed.status,0,routed.stderr);assert.ok(JSON.parse(routed.stdout).files.some(file=>file.path==="references/material-editing.md"));
  checks.push("material-task-routes-agent-instructions");
  const hdr=path.join(temp,"hdr-tagged.mp4");
  ff(["-f","lavfi","-i","color=c=gray:s=160x90:r=25:d=1","-c:v","libx264","-color_primaries","bt2020","-color_trc","smpte2084","-colorspace","bt2020nc","-x264-params","colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",hdr]);
  const hdrProbe=run("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=color_transfer","-of","json",hdr]);
  assert.equal(hdrProbe.status,0,hdrProbe.stderr);assert.equal(JSON.parse(hdrProbe.stdout).streams[0].color_transfer,"smpte2084");
  const hdrRoot=path.join(temp,"hdr-project");
  assert.throws(()=>initializeMaterialProject({materials:[hdr],requirements:"HDR 测试",projectRoot:hdrRoot,duration:1,width:320,development:true,runtime}),/HDR/);
  assert.equal(fs.existsSync(hdrRoot),false);
  const audioLong=path.join(temp,"long-audio.mp4");
  ff(["-f","lavfi","-i","color=c=red:s=160x90:r=25:d=2","-f","lavfi","-i","sine=duration=4:sample_rate=48000","-c:v","libx264","-c:a","aac",audioLong]);
  const shortRoot=path.join(temp,"short-video-project");
  initializeMaterialProject({materials:[audioLong],requirements:"以画面时长为准",projectRoot:shortRoot,duration:2,width:320,development:true,runtime});
  assert.equal(readJson(path.join(shortRoot,".kacha/material-project.json")).assets[0].duration,2);
  checks.push("hdr-requires-explicit-color-conversion-and-audio-tail-cannot-extend-video-range");
  const report={status:"pass",passed:checks.length,checks,fixture:"synthetic_local_media_not_real_editorial_acceptance",candidate:rendered.candidate.path};
  if(persistent)write(path.join(temp,"demo-result.json"),report);
  console.log(JSON.stringify(report,null,2));
} finally { if(!persistent)fs.rmSync(temp,{recursive:true,force:true}); }
