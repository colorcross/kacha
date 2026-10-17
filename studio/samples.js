import { studioRequest, previewPollDelay } from './shared.js';
const $=id=>document.getElementById(id);
let current=null, sound=null, epoch=0, timer=null, recipes=[], timelineTarget=null, targetEpoch=0;
const message=(id,value,error=false)=>{$(id).textContent=value;$(id).classList.toggle('error',error);};
function pauseAll(except) {document.querySelectorAll('video,audio').forEach(v=>{if(v!==except)v.pause();});}
document.addEventListener('play',event=>pauseAll(event.target),true);
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseAll();});
const observer=new IntersectionObserver(entries=>entries.forEach(e=>{if(!e.isIntersecting)e.target.pause();}));
function clearSamples() {epoch++;clearTimeout(timer);pauseAll();observer.disconnect();current=null;$('comparison').hidden=true;$('candidates').replaceChildren();}
function remember(key,value){try{localStorage.setItem(key,value);}catch{}}
function restore(key,id){try{$(id).value=localStorage.getItem(key)||'';}catch{}}
restore('kacha.samples.package','package');restore('kacha.sfx.package','soundPackage');
function spec() {
 const items=$('items').value.split('\n').filter(l=>l.trim()).map(line=>{const split=line.indexOf('|');if(split<1)throw Error('每行请写成：标题 | 说明');return {label:line.slice(0,split).trim(),detail:line.slice(split+1).trim()};});
 return {recipe:$('recipe').value,pack:$('pack').value,title:$('sampleTitle').value,items,evidence:$('evidence').value,width:$('aspect').value==='portrait'?720:1280,height:$('aspect').value==='portrait'?1280:720,fps:Number($('fps').value),durationSeconds:Number($('duration').value),...($('fontFile').value.trim()?{fontFile:$('fontFile').value.trim()}: {})};
}
function populate(s) {
 for(const [id,value] of Object.entries({recipe:s.recipe,pack:s.pack,sampleTitle:s.title,evidence:s.evidence,items:s.items.map(i=>`${i.label} | ${i.detail}`).join('\n'),aspect:s.height>s.width?'portrait':'landscape',fps:s.fps,duration:s.durationSeconds,fontFile:s.fontFile??''}))$(id).value=value;
 help();
}
function display(s) {
 current=s;
 if(!s.ready){message('sampleStatus',`状态：${s.status}。${s.error||'任务在后台运行；可关闭此页，稍后读取同一目录。'}`);return;}
 populate(s.spec);$('comparison').hidden=false;$('loadedTitle').textContent=`${s.spec.title} · ${s.spec.durationSeconds} 秒 · ${s.spec.fps} fps`;
 $('candidates').replaceChildren();observer.disconnect();
 for(const entry of s.entries){
  const card=document.createElement('article');card.className=`candidate${s.spec.height>s.spec.width?' portrait':''}${s.selection?.variant===entry.id?' is-selected':''}`;
  const heading=document.createElement('h3');heading.textContent=entry.name;
  const video=document.createElement('video');video.controls=true;video.preload='metadata';video.playsInline=true;video.setAttribute('aria-label',entry.name);video.src=`/api/samples/media?${new URLSearchParams({package:s.package,variant:entry.id,sha:entry.video.sha256})}`;observer.observe(video);video.addEventListener('error',()=>{if(video.isConnected && current?.digest===s.digest)message('sampleStatus','样片暂时无法播放；请检查服务并读取已有样片重新核对版本。',true);});
  const button=document.createElement('button');button.type='button';button.textContent=s.selection?.variant===entry.id?'已选方向':'选择此方向';button.setAttribute('aria-pressed',String(s.selection?.variant===entry.id));
  button.addEventListener('click',()=>select(entry.id));card.append(heading,video,button);$('candidates').append(card);
 }
 $('selected').textContent=s.selection?`已保存：${s.selection.reason}。这是方向选择，仍须完整审片。`:'按正常速度播放比较，再填写理由选择。';message('sampleStatus','两份候选已完成；文案或字体改变后请使用新目录重新生成。');
}
async function load(root, token, attempt=0) {
 try {
  if(document.hidden){timer=setTimeout(()=>load(root,token,attempt),4000);return;}
  const s=await studioRequest('/api/samples/status',{body:{package:root}});if(token!==epoch)return;display(s);
  if(!s.ready && ['queued','running','starting','pending'].includes(s.status))timer=setTimeout(()=>load(root,token,attempt+1),previewPollDelay(attempt));
 }catch(error){if(token===epoch){current=null;$('comparison').hidden=true;message('sampleStatus',`${error.message} 可使用“读取已有样片”重新核对。`,true);}}
}
async function select(variant){
 if(!current?.ready)return;
 const s=current,token=epoch;$('sampleFields').disabled=true;document.querySelectorAll('#candidates button').forEach(b=>b.disabled=true);
 try{const next=await studioRequest('/api/samples/select',{body:{package:s.package,variant,expectedDigest:s.digest,expectedSelection:s.selection?.digest??null,reason:$('selectionReason').value}});if(token===epoch)display(next);}
 catch(error){if(token===epoch)message('sampleStatus',error.message,true);}
 finally{$('sampleFields').disabled=false;document.querySelectorAll('#candidates button').forEach(b=>b.disabled=false);}
}
$('sampleForm').addEventListener('submit',async event=>{
 event.preventDefault();let input;try{input=spec();}catch(e){message('sampleStatus',e.message,true);return;}
 clearSamples();const token=epoch,root=$('package').value.trim();remember('kacha.samples.package',root);$('sampleFields').disabled=true;message('sampleStatus','正在核对文字、字体与版面并提交任务…');
 try{await studioRequest('/api/samples/render',{body:{package:root,spec:input}});if(token===epoch)await load(root,token);}
 catch(error){if(token===epoch)message('sampleStatus',`${error.message} 若请求超时，请先读取此目录，不要重复生成。`,true);}
 finally{$('sampleFields').disabled=false;}
});
$('open').addEventListener('click',()=>{clearSamples();const root=$('package').value.trim();remember('kacha.samples.package',root);message('sampleStatus','正在读取…');load(root,epoch);});
$('sampleFields').addEventListener('input',()=>{clearSamples();message('sampleStatus','输入已改变。请用新目录生成，或读取已有包恢复原内容。');});
function help(){const r=recipes.find(r=>r.id===$('recipe').value);if(r)$('recipeHelp').textContent=`${r.use} ${r.fields}${$('pack').value==='dahui-ai'?` 大灰AI：${r.dahui}`:''}`;}
$('recipe').addEventListener('change',help);$('pack').addEventListener('change',help);
studioRequest('/api/samples/recipes').then(r=>{recipes=r.recipes;help();}).catch(e=>message('sampleStatus',e.message,true));
let soundEpoch=0;
function showSound(r,root){sound={receipt:r,package:root};for(const [id,value] of Object.entries({soundType:r.spec.type,soundDuration:r.spec.durationSeconds,peakDb:r.spec.peakDb,trigger:r.spec.trigger,libraryCheck:r.spec.libraryCheck}))$(id).value=value;$('soundPlayer').hidden=false;$('soundPlayer').src=`/api/sfx/media?${new URLSearchParams({package:root,sha:r.audio.sha256})}`;message('soundStatus',`已生成 ${r.durationSeconds} 秒音效，48 kHz 双声道。请试听并确认不盖过人声。`);}
async function soundRequest(create){
 const token=++soundEpoch,root=$('soundPackage').value.trim();sound=null;$('soundPlayer').pause();$('soundPlayer').hidden=true;$('sfxFields').disabled=true;remember('kacha.sfx.package',root);message('soundStatus','正在处理…');
 try{const r=await studioRequest(`/api/sfx/${create?'synth':'status'}`,{body:{package:root,...(create?{spec:{type:$('soundType').value,durationSeconds:Number($('soundDuration').value),peakDb:Number($('peakDb').value),trigger:$('trigger').value,libraryCheck:$('libraryCheck').value}}:{})}});if(token===soundEpoch)showSound(r,root);}
 catch(e){if(token===soundEpoch)message('soundStatus',e.message,true);}finally{$('sfxFields').disabled=false;}
}
$('soundPlayer').addEventListener('error',()=>{if(sound)message('soundStatus','音效暂时无法播放；请读取已有音效重新核对。',true);});
$('sfxForm').addEventListener('submit',e=>{e.preventDefault();soundRequest(true);});$('openSound').addEventListener('click',()=>soundRequest(false));
$('sfxFields').addEventListener('input',()=>{soundEpoch++;sound=null;$('soundPlayer').pause();$('soundPlayer').hidden=true;});
$('timeline').addEventListener('input',()=>{targetEpoch++;timelineTarget=null;message('timelineInfo','路径已改变，请重新读取。');});
$('readTimeline').addEventListener('click',async()=>{
 const token=++targetEpoch,root=$('timeline').value.trim();timelineTarget=null;message('timelineInfo','正在读取…');
 try {const value=await studioRequest('/api/samples/target',{body:{package:root}});if(token!==targetEpoch)return;timelineTarget=value;message('timelineInfo',`${value.width} × ${value.height} · ${value.fps} fps · ${value.durationSeconds.toFixed(2)} 秒。已绑定当前版本。`);}
 catch(error){if(token===targetEpoch)message('timelineInfo',error.message,true);}
});
$('attachForm').addEventListener('submit',async e=>{
 e.preventDefault();const kind=$('attachKind').value,root=kind==='samples'?current?.package:sound?.package;
 if(!root || (kind==='samples'&&!current?.selection)){message('attachStatus','先读取并选择当前样片，或生成 / 读取音效。',true);return;}
 if(!timelineTarget){message('attachStatus','请先读取当前时间线。',true);return;}
 $('attachFields').disabled=true;message('attachStatus','正在验证版本和插入位置…');
 try{const r=await studioRequest(`/api/${kind}/attach`,{body:{package:root,timeline:timelineTarget.identity.path,expectedSha:timelineTarget.identity.sha256,output:$('attachOutput').value.trim(),start:Number($('landing').value),target:Number($('landing').value),expectedSelection:current?.selection?.digest,reason:$('attachReason').value}});message('attachStatus',`已建立候选：${r.candidate.path}。请由 Agent 渲染后进入审片。`);}
 catch(error){message('attachStatus',error.message,true);}finally{$('attachFields').disabled=false;}
});
