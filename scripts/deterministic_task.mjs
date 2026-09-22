#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {fileIdentity, mediaSummary, readJson, sha256File, writeJsonAtomic} from './kacha_utils.mjs';
export const ADAPTERS={media_probe:{resources:['ioHeavy']},transcript_index:{resources:['ioHeavy']},audio_analysis:{resources:['cpuHeavy']},styleframe:{resources:['cpuHeavy']}};
export function validateTaskSpec(file,sha){
 if(!/^[a-f0-9]{64}$/.test(sha??'')||sha256File(file)!==sha)throw new Error('任务 spec 身份已失效');
 const spec=readJson(file),params=spec.parameters??{};
 if(spec.version!=='deterministic-v1'||!ADAPTERS[spec.adapter]||Object.keys(spec).some(k=>!['version','adapter','input','parameters'].includes(k)))throw new Error('未知适配器或 spec 字段');
 if(!spec.input?.path||!path.isAbsolute(spec.input.path)||!spec.input.sha256||sha256File(spec.input.path)!==spec.input.sha256)throw new Error('任务输入身份已失效');
 const allowed=spec.adapter==='styleframe'?['timeSeconds','width']:[];
 if(Object.keys(params).some(k=>!allowed.includes(k)))throw new Error('未知适配器参数');
 if(spec.adapter==='styleframe'&&(typeof params.timeSeconds!=='number'||!Number.isFinite(params.timeSeconds)||params.timeSeconds<0||!Number.isInteger(params.width)||params.width<64||params.width>3840))throw new Error('样式帧需有效 timeSeconds 和 64–3840 width');
 return spec;
}
export function executeTaskSpec(file,sha,output){
 const spec=validateTaskSpec(file,sha),input=spec.input.path;
 output=path.resolve(output);if(fs.existsSync(output)||output===input||output===path.resolve(file))throw new Error('任务拒绝覆盖任何现有输出或输入');
 fs.mkdirSync(path.dirname(output),{recursive:true});
 const temporary=path.join(path.dirname(output),`.task-${process.pid}-${Date.now()}${path.extname(output)}`);
 let result;
 try{
  if(spec.adapter==='media_probe')result={media:mediaSummary(input)};
  if(spec.adapter==='transcript_index'){
   const value=readJson(input),cues=value.cues??value.segments;
   if(!Array.isArray(cues))throw new Error('字幕输入需 cues 或 segments');
   result={cues:cues.map((cue,index)=>{if(typeof cue.start!=='number'||typeof cue.end!=='number'||cue.start<0||cue.end<=cue.start||typeof cue.text!=='string')throw new Error(`字幕 ${index} 无效`);return {id:cue.id??`cue-${index}`,start:cue.start,end:cue.end,text:cue.text};})};
  }
  if(spec.adapter==='audio_analysis'){
   const process=spawnSync('ffmpeg',['-nostdin','-hide_banner','-i',input,'-vn','-af','volumedetect','-f','null','-'],{encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
   if(process.status!==0)throw new Error(process.error?.message??process.stderr);
   const metric=name=>{const match=process.stderr.match(new RegExp(`${name}: ([-0-9.]+) dB`));return match?Number(match[1]):null;};
   result={meanVolumeDb:metric('mean_volume'),maxVolumeDb:metric('max_volume'),method:'ffmpeg_volumedetect',loudnessLufs:null};
  }
  if(spec.adapter==='styleframe'){
   if(path.extname(output)!=='.png')throw new Error('样式帧仅输出 PNG');
   const summary=mediaSummary(input);if(spec.parameters.timeSeconds>=summary.videoDuration)throw new Error('样式帧时间超出视频');
   const process=spawnSync('ffmpeg',['-nostdin','-v','error','-ss',String(spec.parameters.timeSeconds),'-i',input,'-frames:v','1','-vf',`scale=${spec.parameters.width}:-2`,'-update','1',temporary],{encoding:'utf8',timeout:300000});
   if(process.status!==0||!fs.existsSync(temporary))throw new Error(process.error?.message??process.stderr??'样式帧未生成');
  }else writeJsonAtomic(temporary,{status:'pass',adapter:spec.adapter,input:fileIdentity(input),...result});
  validateTaskSpec(file,sha);
  fs.linkSync(temporary,output); // Exclusive publication; never replace a racing writer.
  return {status:'pass',adapter:spec.adapter,output:fileIdentity(output),retryPolicy:'inspect_then_explicit_resume'};
 }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),opt=k=>args.includes(k)?args[args.indexOf(k)+1]:null;
 try{const allowed=['--spec','--spec-sha','--output'];if(args.length!==6||allowed.some(k=>args.filter(v=>v===k).length!==1))throw new Error('用法：deterministic_task --spec FILE --spec-sha SHA --output NEW_FILE');console.log(JSON.stringify(executeTaskSpec(opt('--spec'),opt('--spec-sha'),opt('--output')),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
