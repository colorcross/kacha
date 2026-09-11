#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeMaterialProject, inspectMaterial, composeMaterialProject, materialProjectStatus, renderMaterialProject, runMaterialProject } from "../scripts/material_project.mjs";
import { run, readJson, sha256File, sha256Value, fileIdentity } from "../scripts/kacha_utils.mjs";
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
  for (const field of ["speed", "sourceStart", "transition", "motion"]) bad(b=>b.segments[0][field]=2,/不支持的字段/);
  bad(b=>b.effects=[],/不支持的字段/);
  bad(b=>b.requirements[0].mandatory=true,/不支持的字段/);
  for (const difference of [-.04,.04]) bad(b=>b.segments[0].duration+=difference,/总时长/);
  checks.push("unknown-edit-instructions-and-one-frame-duration-mismatch-are-rejected");
  checks.push("storyboard-enforces-requirements-duration-source-ranges-crop-audio-and-reading");
  write(boardFile,board); const composed=composeMaterialProject(projectRoot,boardFile);
  assert.equal(composed.status,"ready_to_render"); assert.equal(composed.candidate,null);
  const identity=readJson(path.join(projectRoot,".kacha/material-active-plan.json")).plan;
  composeMaterialProject(projectRoot,boardFile); assert.deepEqual(readJson(path.join(projectRoot,".kacha/material-active-plan.json")).plan,identity);
  const beforeInspection=fileIdentity(path.join(projectRoot,"previews",assets[0].id,"inspection.json"));
  inspectMaterial(projectRoot,assets[0].id);
  assert.deepEqual(fileIdentity(beforeInspection.path),beforeInspection);
  assert.deepEqual(materialProjectStatus(projectRoot).activePlan,identity);
  inspectMaterial(projectRoot,assets[0].id,{timestamps:[1.1]});
  assert.deepEqual(materialProjectStatus(projectRoot).activePlan,identity);
  const frozen=readJson(identity.path);
  assert.ok(frozen.segments[0].inspection.path.includes("inspection-"));
  assert.ok(frozen.subtitle?.source?.sha256);
  checks.push("inspection-is-idempotent-and-added-frames-preserve-frozen-storyboard");
  checks.push("versioned-plan-is-idempotent-and-not-a-render-claim");
  assert.throws(()=>renderMaterialProject(projectRoot,{expectedPlanDigest:"stale"}),/排队后/);
  // A private Fontconfig view with no system font directories proves fontsdir portability.
  const fontconfig=path.join(temp,"empty-fontconfig.xml");
  fs.writeFileSync(fontconfig,`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><cachedir>${temp}/fontcache</cachedir></fontconfig>`);
  const previousFontconfig=process.env.FONTCONFIG_FILE;process.env.FONTCONFIG_FILE=fontconfig;
  let rendered;
  try { rendered=renderMaterialProject(projectRoot); }
  finally { if(previousFontconfig===undefined)delete process.env.FONTCONFIG_FILE;else process.env.FONTCONFIG_FILE=previousFontconfig; }
  assert.equal(rendered.status,"candidate_ready");
  assert.equal(rendered.boundaries.humanReviewComplete,false);
  const first=readJson(path.join(path.dirname(rendered.candidate.path),"material-render.json"));
  assert.equal(first.qc.frameCount,"pass");assert.equal(first.qc.decodedFrames,150);
  const timeline=readJson(first.timeline.path);
  assert.ok(timeline.visual.subtitles.fontsDirectory);
  const copiedFont=path.join(timeline.visual.subtitles.fontsDirectory,path.basename(frozen.subtitle.source.path));
  assert.equal(sha256File(copiedFont),frozen.subtitle.source.sha256);
  checks.push("frozen-font-is-supplied-to-libass-without-requiring-system-registration");
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
  for (const extra of [["--timestamp", "1"], ["--project-root", projectRoot], ["--unknown"]]) {
    const invalid=run(process.execPath,[path.join(repository,"scripts/kacha_materials.mjs"),"status","--project-root",projectRoot,...extra]);
    assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/不支持的参数|重复参数/);
  }
  checks.push("material-cli-rejects-ignored-and-duplicate-options");
  checks.push("standard-project-status-routes-material-projects");
  const receipt=path.join(path.dirname(rendered.candidate.path),"material-render.json");
  const good=fs.readFileSync(receipt); const corrupt=readJson(receipt); corrupt.planDigest="stale";const {digest,...unsigned}=corrupt;corrupt.digest=sha256Value(unsigned);write(receipt,corrupt);
  assert.throws(()=>materialProjectStatus(projectRoot),/成片已变化/);fs.writeFileSync(receipt,good);
  const resign=(value)=>{const {digest,...unsigned}=value;return {...unsigned,digest:sha256Value(unsigned)};};
  for(const mutate of [r=>r.qc.decode="fail",r=>r.qc.humanReviewComplete=true,r=>r.qc.frameCount="fail",r=>r.qc.decodedFrames=0,r=>r.kind="other",r=>r.timeline=r.assembly]) {
    const invalid=JSON.parse(good);mutate(invalid);write(receipt,resign(invalid));
    assert.throws(()=>materialProjectStatus(projectRoot),/成片已变化/);
  }
  fs.writeFileSync(receipt,good);
  checks.push("receipt-rejects-failed-qc-false-human-acceptance-and-wrong-artifact-type");
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
  // Isolated projects let corruption tests preserve the valid candidates above.
  const isolated=(name,source=image)=>{
    const root=path.join(temp,name);
    initializeMaterialProject({materials:[source],requirements:"2秒完整展示",projectRoot:root,duration:2,width:320,development:true,runtime,confirmExecute:true});
    const p=readJson(path.join(root,".kacha/material-project.json")),b=readJson(p.brief.path),a=p.assets[0];
    inspectMaterial(root,a.id);
    const board={schemaVersion:"1.0",kind:"kacha_material_storyboard",projectDigest:p.digest,briefDigest:b.digest,interpretation:"完整展示实际素材",requirements:[{id:"r",text:"保持比例",check:"semantic",assetIds:[]}],
      segments:[{id:"shot",assetId:a.id,duration:2,fit:"contain",audio:"source",observation:"单色测试素材",role:"hold",reason:"完整展示",satisfies:["r"]}]};
    const file=path.join(root,"board.json");write(file,board);return {root,p,a,board,file};
  };
  const changed=isolated("changed-inspection");
  const evidenceFile=path.join(changed.root,"previews",changed.a.id,"inspection.json");
  const evidence=readJson(evidenceFile);
  fs.appendFileSync(evidence.frames[0].path,"changed");
  assert.throws(()=>inspectMaterial(changed.root,changed.a.id),/审阅帧已失效/);
  assert.throws(()=>composeMaterialProject(changed.root,changed.file),/审阅帧已失效/);
  const empty=isolated("empty-inspection");
  const emptyFile=path.join(empty.root,"previews",empty.a.id,"inspection.json");
  const emptyEvidence=readJson(emptyFile);emptyEvidence.frames=[];write(emptyFile,resign(emptyEvidence));
  assert.throws(()=>composeMaterialProject(empty.root,empty.file),/为空/);
  const unowned=isolated("unowned-inspection",video);
  const orphan=path.join(unowned.root,"previews",unowned.a.id,`${unowned.a.identity.sha256.slice(0,12)}-${sha256Value(1.1).slice(0,16)}.jpg`);
  fs.writeFileSync(orphan,"unowned");assert.throws(()=>inspectMaterial(unowned.root,unowned.a.id,{timestamps:[1.1]}),/缺少归属/);
  checks.push("changed-empty-and-unowned-inspection-evidence-cannot-be-adopted");
  const target=isolated("mutated-target");composeMaterialProject(target.root,target.file);
  const pointerFile=path.join(target.root,".kacha/material-active-plan.json"),pointer=readJson(pointerFile);
  const targetPlan=readJson(pointer.plan.path);targetPlan.target.width=640;write(pointer.plan.path,resign(targetPlan));write(pointerFile,{plan:fileIdentity(pointer.plan.path)});
  assert.throws(()=>materialProjectStatus(target.root),/分镜目标/);
  checks.push("redigested-plan-cannot-change-frozen-output-target");
  const fontPreflight=isolated("font-preflight");fontPreflight.board.segments[0].caption="字体";write(fontPreflight.file,fontPreflight.board);
  write(path.join(fontPreflight.root,"kacha.config.json"),{schemaVersion:"1.0",style:{overrides:{typography:{subtitlePrimary:{fontFile:path.join(temp,"missing.ttf"),fontSha256:"0".repeat(64)}}}}});
  assert.throws(()=>composeMaterialProject(fontPreflight.root,fontPreflight.file),/字幕字体文件缺失/);
  assert.equal(fs.existsSync(path.join(fontPreflight.root,".kacha/material-clips")),false);
  checks.push("missing-declared-font-fails-before-rendering-or-activating-a-plan");
  const anamorphic=path.join(temp,"anamorphic.mp4");
  ff(["-f","lavfi","-i","color=c=red:s=160x120:r=25:d=2","-vf","setsar=2","-c:v","libx264",anamorphic]);
  const anamorphicProject=isolated("anamorphic-project",anamorphic);composeMaterialProject(anamorphicProject.root,anamorphicProject.file);
  const anamorphicResult=renderMaterialProject(anamorphicProject.root);
  const at=(x,y)=>{
    const result=run("ffmpeg",["-hide_banner","-v","error","-ss","0.8","-i",anamorphicResult.candidate.path,"-vf",`crop=2:2:${x}:${y},format=rgb24`,"-frames:v","1","-f","rawvideo","-"],{encoding:null});
    assert.equal(result.status,0,result.stderr);return [...result.stdout.subarray(0,3)];
  };
  assert.ok(at(160,10).every(v=>v<20));assert.ok(at(10,90)[0]>150);assert.ok(at(160,40)[0]>150);
  checks.push("anamorphic-video-retains-display-aspect-ratio-in-real-rendered-pixels");
  const collisions=isolated("temporary-collisions",video);
  const frameCollision=path.join(collisions.root,"previews",collisions.a.id,`frame-${process.pid}.partial.jpg`);
  fs.writeFileSync(frameCollision,"pre-existing frame work");
  assert.throws(()=>inspectMaterial(collisions.root,collisions.a.id,{timestamps:[1.1]}),/临时文件已存在/);
  assert.equal(fs.readFileSync(frameCollision,"utf8"),"pre-existing frame work");
  const collisionState=composeMaterialProject(collisions.root,collisions.file),collisionPlan=readJson(collisionState.activePlan.path),shot=collisionPlan.segments[0];
  const cacheKey=sha256Value({source:shot.source.sha256,sourceIn:shot.sourceIn,duration:shot.duration,fit:shot.fit,audio:shot.audio,target:collisionPlan.target,implementation:sha256File(path.join(repository,"scripts/material_project.mjs"))});
  const collisionCache=path.join(collisions.root,".kacha/material-clips");fs.mkdirSync(collisionCache);
  const clipCollision=path.join(collisionCache,`${cacheKey}-${process.pid}.partial.mkv`);fs.writeFileSync(clipCollision,"pre-existing clip work");
  assert.throws(()=>renderMaterialProject(collisions.root),/临时文件已存在/);
  assert.equal(fs.readFileSync(clipCollision,"utf8"),"pre-existing clip work");fs.unlinkSync(clipCollision);
  const collisionOutput=path.join(collisions.root,"output",`edit-${collisionPlan.digest.slice(0,16)}`);fs.mkdirSync(collisionOutput,{recursive:true});
  const assemblyCollision=path.join(collisionOutput,`assembly-${process.pid}.partial.mkv`);fs.writeFileSync(assemblyCollision,"pre-existing assembly work");
  assert.throws(()=>renderMaterialProject(collisions.root),/临时文件已存在/);
  assert.equal(fs.readFileSync(assemblyCollision,"utf8"),"pre-existing assembly work");
  checks.push("failed-frame-clip-and-assembly-renders-never-delete-preexisting-temporary-files");
  const activeFontPlan=readJson(materialProjectStatus(projectRoot).activePlan.path);
  const activeFontDir=path.join(path.dirname(materialProjectStatus(projectRoot).activePlan.path),"fonts");
  const activeFont=path.join(activeFontDir,path.basename(activeFontPlan.subtitle.source.path));
  const savedFont=fs.readFileSync(activeFont);fs.appendFileSync(activeFont,"changed");
  assert.throws(()=>materialProjectStatus(projectRoot),/工程字幕字体已变化/);fs.writeFileSync(activeFont,savedFont);
  assert.equal(materialProjectStatus(projectRoot).status,"candidate_ready");
  checks.push("candidate-status-revalidates-project-font-content");
  const report={status:"pass",passed:checks.length,checks,fixture:"synthetic_local_media_not_real_editorial_acceptance",candidate:rendered.candidate.path};
  if(persistent)write(path.join(temp,"demo-result.json"),report);
  console.log(JSON.stringify(report,null,2));
} finally { if(!persistent)fs.rmSync(temp,{recursive:true,force:true}); }
