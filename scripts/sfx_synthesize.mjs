#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, sha256File, readJson, sha256Value } from './kacha_utils.mjs';
import { measureSfxPeak, alignSfxPeak } from './sfx_peak_alignment.mjs';
import { buildTimelineProjection, assertProjectionSourceCurrent } from './timeline_projection.mjs';
const self=fileURLToPath(import.meta.url), rate=48000;
const need=(ok,msg)=>{if(!ok)throw Error(msg);};
const digest=o=>{const c=structuredClone(o);delete c.digest;return sha256Value(c);};
export const soundTypes=['click','pop','chime','whoosh','impact'];
export function validateSfxSpec(spec) {
  need(spec && typeof spec==='object' && !Array.isArray(spec),'音效 spec 须为对象');
  need(Object.keys(spec).every(k=>['type','durationSeconds','peakDb','seed','pitchHz','trigger','libraryCheck'].includes(k)),'音效含未知字段');
  const s={durationSeconds:.4,peakDb:-15,seed:1,pitchHz:700,...spec};
  need(soundTypes.includes(s.type),'支持 click、pop、chime、whoosh、impact');
  need(Number.isFinite(s.durationSeconds)&&s.durationSeconds>=.08&&s.durationSeconds<=3,'时长须为 0.08–3 秒');
  need(Number.isFinite(s.peakDb)&&s.peakDb>=-36&&s.peakDb<=-6,'样本峰值须为 -36 至 -6 dBFS');
  need(Number.isInteger(s.seed)&&s.seed>=1&&s.seed<=0xffffffff,'seed 须为 1–4294967295');
  need(Number.isFinite(s.pitchHz)&&s.pitchHz>=80&&s.pitchHz<=4000,'pitchHz 须为 80–4000');
  for(const k of ['trigger','libraryCheck'])need(typeof s[k]==='string'&&s[k].trim().length>=3&&s[k].length<=500,`${k}须说明叙事触发 / 已检查的音效库及不匹配理由`);
  return s;
}
export function synthesizePcm(spec) {
  const s=validateSfxSpec(spec), n=Math.round(s.durationSeconds*rate), samples=new Float64Array(n);
  let state=s.seed>>>0, low=0, phase=0;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296*2-1;};
  for(let i=0;i<n;i++) {
    const t=i/rate, u=i/(n-1), noise=random(); low+=.14*(noise-low);
    const fade=Math.min(1,i/(rate*.005),(n-1-i)/(rate*.015));
    let value;
    if(s.type==='whoosh')value=low*Math.sin(Math.PI*u)**2;
    else if(s.type==='click')value=(.7*noise+.3*Math.sin(2*Math.PI*s.pitchHz*t))*Math.exp(-t*55);
    else if(s.type==='chime')value=(Math.sin(2*Math.PI*s.pitchHz*t)+.35*Math.sin(2*Math.PI*s.pitchHz*1.5*t))*Math.exp(-u*5);
    else { const hz=s.type==='pop'?s.pitchHz*(1-.75*u):s.pitchHz*.3*(1-.8*u);phase+=2*Math.PI*hz/rate;value=(Math.sin(phase)+(s.type==='impact'?.3*low:0))*Math.exp(-u*8); }
    samples[i]=value*fade;
  }
  const sum=samples.reduce((a,b)=>a+b,0);
  let windowSum=0;for(let i=0;i<n;i++)windowSum+=Math.sin(Math.PI*i/(n-1))**2;
  const correction=sum/windowSum;
  // Removing DC under a zero-ended window preserves quiet boundaries.
  for(let i=0;i<n;i++)samples[i]-=correction*Math.sin(Math.PI*i/(n-1))**2;
  let max=0;for(const v of samples)max=Math.max(max,Math.abs(v));
  need(max>0,'生成结果为空');
  const wav=Buffer.alloc(44+n*4), amplitude=10**(s.peakDb/20);
  wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*4,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(n*4,40);
  for(let i=0;i<n;i++){const v=Math.round(samples[i]/max*amplitude*32767);wav.writeInt16LE(v,44+i*4);wav.writeInt16LE(v,46+i*4);}
  return {spec:s,wav,frames:n,sampleRate:rate,channels:2,encoding:'pcm_s16le',peakDb:s.peakDb};
}
export function synthesizeSfx({spec,output}) {
  need(typeof output==='string'&&path.isAbsolute(output),'音效包目录须为绝对路径');
  const result=synthesizePcm(spec);
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);
  const root=fs.realpathSync(output), file=path.join(root,'sound.wav');
  fs.writeFileSync(file,result.wav,{flag:'wx'});
  const measurement=measureSfxPeak(file);
  const receipt={kind:'kacha-procedural-sfx',schemaVersion:'1.0',spec:result.spec,audio:fileIdentity(file),implementation:sha256File(self),sampleRate:rate,channels:2,encoding:result.encoding,durationSeconds:result.frames/rate,measurement,externalAssets:false,apiCalls:0,status:'generated_requires_audition',reviewRequired:['semantic_match','dialogue_protection','headphones','phone_speaker']};receipt.digest=digest(receipt);
  fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
export function readSfx(directory) {
  const root=fs.realpathSync(directory), r=readJson(path.join(root,'receipt.json'));validateSfxSpec(r.spec);
  need(r.kind==='kacha-procedural-sfx'&&r.digest===digest(r)&&r.implementation===sha256File(self)&&r.audio.path===path.join(root,'sound.wav')&&sha256File(r.audio.path)===r.audio.sha256,'代码音效回执、实现或 WAV 已变化');return r;
}
export function attachSfx({directory,timeline,expectedSha,output,target}) {
  const r=readSfx(directory), input=fs.realpathSync(timeline), out=path.join(fs.realpathSync(path.dirname(path.resolve(output))),path.basename(output));
  need(sha256File(input)===expectedSha,'时间线已改变');
  need(path.dirname(out)===path.dirname(input)&&out!==input&&!fs.existsSync(out),'候选须为原时间线同目录的新文件');
  const projection=buildTimelineProjection(input), source=assertProjectionSourceCurrent(projection,{requireDeclaredSha:true}).identity;
  const plan=readJson(input), fps=plan.output.fps;
  need(Number.isFinite(target)&&target>=0&&Math.abs(target*fps-Math.round(target*fps))<1e-6,'落点须为非负整帧时间');
  const alignment=alignSfxPeak({file:r.audio.path,targetLandingSeconds:target,fps});
  const end=Math.max(...projection.items.filter(i=>i.type==='picture').map(i=>i.endTick))/projection.timebase.ticksPerSecond;
  need(alignment.fileStartSeconds+r.durationSeconds-alignment.sourceTrimSeconds<=end+1e-6,'音效尾部超出时间线；请缩短音效或提前落点');
  plan.audio??={};plan.audio.sfx??=[];
  need(!plan.audio.sfx.some(e=>e.sha256===r.audio.sha256&&e.targetLandingSeconds===target),'该落点已有相同音效');
  plan.audio.sfx.push({...r.audio,targetLandingSeconds:target,measuredPeakOffsetSeconds:alignment.measuredPeakOffsetSeconds,levelBelowDialogueDb:10,provenance:{kind:'procedural_synthesis',provider:'kacha-dsp',trigger:r.spec.trigger,libraryCheck:r.spec.libraryCheck,receipt:fileIdentity(path.join(directory,'receipt.json')),review:'required'}});
  plan.mode='preview';delete plan.contracts;delete plan.decisionPlan;delete plan.review;
  plan.output={...plan.output,path:`${out}.preview.mp4`};for(const k of ['dialogueStem','bgmStem','sfxStem','mixStem'])delete plan.output[k];
  need(source&&sha256File(source.path)===source.sha256&&sha256File(input)===expectedSha,'输入已改变');readSfx(directory);
  fs.writeFileSync(out,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  return {status:'candidate_requires_render_and_audition',candidate:fileIdentity(out),alignment};
}
if(process.argv[1]&&path.resolve(process.argv[1])===self) {
  const args=process.argv.slice(2),opt=n=>{const i=args.indexOf(`--${n}`);return i<0?undefined:args[i+1];};
  try {const result=args[0]==='attach'?attachSfx({directory:opt('package'),timeline:opt('timeline'),expectedSha:opt('expected-sha'),output:opt('output'),target:Number(opt('target'))}):args[0]==='status'?readSfx(opt('package')):synthesizeSfx({spec:readJson(opt('spec')),output:opt('output')});console.log(JSON.stringify(result,null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
