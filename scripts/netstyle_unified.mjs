import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {directoryIdentity,fileIdentity,mediaSummary,run,sha256File,writeJsonAtomic} from './kacha_utils.mjs';
import { implementationIdentity } from './implementation_identity.mjs';
const scripts=path.dirname(fileURLToPath(import.meta.url));
export function compileNetstyleUnified(plan,planFile,output,{sfxRoot=null,noSfx=false}={}){
 if(fs.existsSync(output))throw new Error('统一时间线必须写入新文件');
 const source=plan.source.input.path,summary=mediaSummary(source),video=summary.video;
 // The existing netstyle renderer is SDR 8-bit. Never hide that conversion
 // behind a high-bit-depth final export or relabel HDR as SDR.
 if(!['yuv420p','yuvj420p'].includes(video.pix_fmt)||['smpte2084','arib-std-b67'].includes(video.color_transfer))throw new Error('旧网感局部渲染器仅验证 SDR 8-bit 4:2:0；当前源需保持原工程，禁止降位深/HDR');
 if(Number(video.sample_aspect_ratio?.split(':')[0]??1)!==Number(video.sample_aspect_ratio?.split(':')[1]??1)||video.side_data_list?.some(x=>Number(x.rotation)))throw new Error('网感局部合成需先显式规范 SAR/旋转');
 const root=path.dirname(path.resolve(output)),folder=`${output}.layers`;fs.mkdirSync(folder,{recursive:true});
 const implementation=implementationIdentity(scripts).sha256,configuration=directoryIdentity(path.join(scripts,'../config')).sha256;
 const overlays=[],sfx=[],coverage=[];
 for(const event of plan.events){
  const payload=path.join(folder,`${event.id}.payload.json`),layer=path.join(folder,`${event.id}.mp4`);
  writeJsonAtomic(payload,{display:event.display,assetRef:event.asset?.path??null});
  const inputs=[source,payload,...(plan.resources?.mask?.path?[plan.resources.mask.path]:[]),...(event.asset?.path?[event.asset.path]:[])];
  const command=[process.execPath,path.join(scripts,'kacha_netstyle.mjs'),'preview','--input',source,'--effect',event.effectId,'--start',String(event.startSeconds),'--duration',String(event.endSeconds-event.startSeconds),'--output',layer,'--production','--payload',payload,'--video-only'];
  if(plan.resources?.mask?.path)command.push('--mask',plan.resources.mask.path);
  if(event.asset?.path)command.push('--asset',event.asset.path);
  const cached=run(process.execPath,[path.join(scripts,'artifact_cache.mjs'),'run','--project-root',root,'--kind','netstyle_local_composite',...inputs.flatMap(file=>['--input',file]),'--implementation',path.join(scripts,'kacha_netstyle.mjs'),'--parameters',JSON.stringify({event,implementation,configuration}),'--operation-version','netstyle-local-sdr8-v1','--resource','videoEncode','--output',`layer=${layer}`,'--',...command]);
  if(cached.status!==0)throw new Error(cached.stderr||cached.stdout);
  const probe=mediaSummary(layer);
  if(probe.width!==summary.width||probe.height!==summary.height||Math.abs(probe.averageFps-summary.averageFps)>.02||Math.abs(probe.videoDuration-(event.endSeconds-event.startSeconds))>1.5/summary.averageFps)throw new Error(`${event.id} 局部合成未保持几何、帧率或时长`);
  overlays.push({...fileIdentity(layer),id:event.id,kind:'video',start:event.startSeconds,end:event.endSeconds,x:0,y:0,width:summary.width,height:summary.height,opacity:1,provenance:{kind:'cached_local_composite',evidence:path.resolve(planFile)}});
  coverage.push({eventId:event.id,effectId:event.effectId,route:'cached_local_composite',cache:JSON.parse(cached.stdout).cache,extraLocalEncode:true});
  if(!noSfx&&event.sound?.trigger){
   // Resolve through the caller's reviewed project library. Never bundle audio.
   const manifestFile=sfxRoot?path.join(sfxRoot,'manifest.json'):null;
   if(!manifestFile||!fs.existsSync(manifestFile))throw new Error('局部合成需要显式 --no-sfx 或当前项目音效库；不会静默省略已计划音效');
   const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
   const entries=manifest.assets??manifest.items??manifest.sounds??[];
   const item=entries.find(x=>x.id===event.sound.assetId);
   if(!item?.path)throw new Error(`${event.id} 需要已明确选择的 sound.assetId；不按装饰数量自动配音效`);
   const file=path.resolve(sfxRoot,item.path);
   sfx.push({...fileIdentity(file),id:`${event.id}-sfx`,targetLandingSeconds:event.peakSeconds,levelBelowDialogueDb:Math.abs(event.sound.levelRelativeToDialogueDb??12),provenance:{kind:'project_library',evidence:manifestFile}});
  }
 }
 if(sha256File(source)!==plan.source.input.sha256)throw new Error('局部渲染期间源已改变');
 const timeline={schemaVersion:'1.0',projectId:plan.projectId??'netstyle-unified',mode:'preview',source:fileIdentity(source),edl:[{id:'source',sourceStart:0,sourceEnd:summary.videoDuration}],visual:{overlays},audio:{sfx},output:{path:`${output}.preview.mp4`,width:summary.width,height:summary.height,fps:summary.averageFps},renderMigration:{version:'unified-local-v1',coverage,plainIntervalsEncoded:0,finalContractsRequired:true}};
 writeJsonAtomic(output,timeline);
 const report={status:'compiled_requires_render_and_review',timeline:fileIdentity(output),source:fileIdentity(source),coverage,plainIntervalsEncoded:0,fullVideoEncodes:0,legacyRendererRetained:true};
 writeJsonAtomic(`${output}.migration.json`,report);return report;
}
