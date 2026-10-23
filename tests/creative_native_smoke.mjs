// Opt-in native integration smoke. Creates synthetic technical fixtures only;
// never asserts design approval or human review and never attaches them to a programme.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { creativeTemplate } from '../scripts/creative_skills.mjs';
import { readCreativeReceipt } from '../scripts/creative_contract.mjs';
import { providerRuntime } from '../scripts/creative_providers.mjs';
const root = path.resolve(process.argv[2] || 'output/creative-native-smoke');
const ids = process.argv[3] ? process.argv[3].split(',') : ['huashu-motion', 'huashu-art-motion', 'huashu-design', 'lemo-opuscar'];
fs.mkdirSync(root, { recursive: true });
const results = [];
for (const id of ids) {
  const source = path.join(root, 'sources', id), r = providerRuntime(id);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  if (id === 'huashu-motion' && !fs.existsSync(source)) {
    const init = spawnSync(process.execPath, [r.entry, 'new', source], { encoding: 'utf8' });
    if (init.status !== 0) throw Error(init.stderr);
  }
  fs.mkdirSync(source, { recursive: true });
  const g = { width: 1280, height: 720, fps: 25, frames: 100, transparent: false };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:#182c26}canvas{display:block}</style></head><body><canvas id="c" width="1280" height="720"></canvas><script>
const ctx=document.getElementById('c').getContext('2d');
function draw(t){ctx.fillStyle='#182c26';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#e6bd56';ctx.fillRect(160+160*t,270,180,180);ctx.strokeStyle='#f4f1e6';ctx.lineWidth=8;ctx.strokeRect(130,240,1020,240);ctx.fillStyle='#f4f1e6';ctx.font='48px sans-serif';ctx.fillText('TEST',160,180);}
window.DUR=4;window.TEXTS=()=>[{id:'test',text:'TEST',x0:160,y0:130,x1:300,y1:185}];window.render=draw;window.__seek=draw;window.__ready=true;window.READY=true;draw(0);
</script></body></html>`;
  if (id === 'huashu-motion') fs.writeFileSync(path.join(source, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><script src="vendor/gsap.min.js"></script><script src="vendor/om.js"></script><style>html,body{margin:0}#film{width:1280px;height:720px;background:#182c26;position:relative;overflow:hidden}#block{position:absolute;left:160px;top:270px;width:180px;height:180px;background:#e6bd56}</style></head><body><div id="film" data-composition-id="film" data-width="1280" data-height="720" data-duration="4" data-fps="25"><div id="block" data-om-id="moving-object"></div></div><script>const tl=gsap.timeline({paused:true});tl.addLabel('scene:travel',0).fromTo('#block',{x:0},{x:640,duration:4,ease:'none'},0);window.__timelines={film:tl};</script></body></html>`);
  else if (id === 'huashu-art-motion') fs.writeFileSync(path.join(source, 'clip.json'), JSON.stringify({ grammar: 't3_finance_chart', duration: 4, width: 1280, height: 720, fps: 25, theme: 'paper', data: { title: '合成数据验证', unit: '测试数据，不代表实际结果', source: '本地技术回归', chart: 'bar', series: [{ label: '甲', value: 20 }, { label: '乙', value: 45 }, { label: '丙', value: 80 }] }, cues: [{ at: 0, kind: 'bar', data: { index: 0 } }, { at: 0.8, kind: 'bar', data: { index: 1 } }, { at: 1.6, kind: 'bar', data: { index: 2 } }] }));
  else fs.writeFileSync(path.join(source, 'index.html'), id === 'huashu-design' ? html.replace('<body>', '<body><div class="title" style="position:absolute;left:20px;top:20px;width:100px;height:100px;background:#ff00ff"></div>') : html);
  for (const f of ['treatment.md', 'rights.md', 'direction-approved.md']) fs.writeFileSync(path.join(source, f), '# 技术回归素材\n仅验证原生渲染器的确定帧输出、几何和回收。使用自编几何图形/合成数据，无真人、无产品事实、无音效。机械测试，不是新视觉设计、用户选定或人工审片通过。\n');
  const plan = { ...creativeTemplate(id, source), purpose: 'technical-fixture', reason: '四套原生后端的本地技术闭环验证', directionStatus: 'mechanical-test', output: g };
  const planFile = path.join(root, `${id}.plan.json`); fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  const kit = path.join(root, 'packages', id);
  const submitted = spawnSync(process.execPath, ['scripts/kacha.mjs', 'creative', 'render', '--plan', planFile, '--output', kit], { encoding: 'utf8', timeout: 60000, maxBuffer: 12 * 1024 * 1024 });
  if (submitted.status !== 0) throw Error(submitted.stderr || submitted.stdout);
  const queued = JSON.parse(submitted.stdout); console.log(JSON.stringify({ provider: id, status: queued.status, package: kit, entrypoint: 'kacha-cli' }));
  let finished = false;
  for (let i = 0; i < 300; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (fs.existsSync(path.join(kit, 'receipt.json'))) {
      const { receipt } = readCreativeReceipt(kit);
      let titlePreserved;
      if (id === 'huashu-design') {
        const sample = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', receipt.video.path, '-vf', 'crop=2:2:40:40,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']);
        titlePreserved = sample.status === 0 && sample.stdout[0] > 220 && sample.stdout[1] < 30 && sample.stdout[2] > 220;
        if (!titlePreserved) throw Error('Design native render hid authored .title content');
      }
      results.push({ provider: id, status: receipt.status, video: receipt.video, media: receipt.media, ...(titlePreserved === undefined ? {} : { titlePreserved }) }); finished = true; break;
    }
    const status = spawnSync(process.execPath, ['scripts/kacha_jobs.mjs', 'status', '@job:creative-render', '--project-root', kit], { encoding: 'utf8' });
    if (/"status":\s*"(failed|cancelled)"/.test(status.stdout)) throw Error(`${id}: ${status.stdout}`);
  }
  if (!finished) throw Error(`${id}: timeout; inspect jobs logs before retry`);
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
