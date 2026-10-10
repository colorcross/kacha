import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../scripts/kacha_utils.mjs';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-task-api-'));
const realProbe = process.env.PATH.split(path.delimiter).map(dir => path.join(dir, 'ffprobe')).find(file => fs.existsSync(file));
if (!realProbe) throw new Error('ffprobe is required');
const video = path.join(root, 'source.mp4');
const created = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.2', '-c:v', 'libx264', video]);
assert.equal(created.status, 0, created.stderr.toString());
const selected = path.join(root, 'selected-name.mp4'); fs.symlinkSync(video, selected);
const wrapper = path.join(root, 'bin'); fs.mkdirSync(wrapper);
const signal = path.join(root, 'probe-started'); const release = path.join(root, 'release-probe');
fs.writeFileSync(path.join(wrapper, 'ffprobe'), `#!${process.execPath}
const fs=require('node:fs'); const {spawnSync}=require('node:child_process');
fs.writeFileSync(${JSON.stringify(signal)},'started');
const deadline=Date.now()+15000;
while(!fs.existsSync(${JSON.stringify(release)})) { if(Date.now()>deadline) process.exit(2); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); }
const result=spawnSync(${JSON.stringify(realProbe)},process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);
`, { mode: 0o755 });
const portSocket = net.createServer(); await new Promise(resolve => portSocket.listen(0, '127.0.0.1', resolve));
const port = portSocket.address().port; await new Promise(resolve => portSocket.close(resolve));
const server = spawn(process.execPath, ['scripts/kacha.mjs', 'studio', 'serve', '--port', String(port), '--no-open'], {
  cwd: repository, env: { ...process.env, KACHA_DISABLE_MEDIA_CACHE: '1', KACHA_FFPROBE_BIN: path.join(wrapper, 'ffprobe'), PATH: `${wrapper}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
});
let stderr = ''; server.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
const origin = `http://127.0.0.1:${port}`;
const post = (endpoint, body) => fetch(`${origin}${endpoint}`, { method: 'POST', headers: { Origin: origin, 'X-Kacha-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
async function until(condition, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) { if (Date.now() > deadline || server.exitCode !== null) throw new Error(stderr || 'fixture did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
let pending;
try {
  await until(async () => { try { return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(200) })).ok; } catch { return false; } });
  pending = post('/api/probe-video', { videoPath: selected });
  await until(() => fs.existsSync(signal));
  // The probe cannot complete until released. Health must complete while it is still blocked.
  const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
  assert.equal(health.status, 200); assert.equal(fs.existsSync(release), false);
  const duplicate = await post('/api/probe-video', { videoPath: video });
  assert.equal(duplicate.status, 409);
  fs.writeFileSync(release, 'continue');
  const response = await pending; assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.media.path, selected); assert.equal(result.media.fileName, 'selected-name.mp4');
  const timeline = path.join(root, 'timeline.json');
  fs.writeFileSync(timeline, JSON.stringify({schemaVersion:'1.0',projectId:'preview-worker',mode:'preview',source:{path:video,sha256:sha256File(video)},edl:[{id:'main',sourceStart:0,sourceEnd:.2}],visual:{overlays:[]},audio:{sfx:[]},output:{width:64,height:64,fps:25,path:path.join(root,'unused.mp4')}}));
  const openedResponse = await post('/api/editor/open', {timelinePath:timeline});
  assert.equal(openedResponse.status,200); const opened = await openedResponse.json();
  fs.unlinkSync(signal); fs.unlinkSync(release);
  const previewBody = {sessionId:opened.browserSessionId,start:0,end:.2,baseSha256:sha256File(timeline)};
  pending = post('/api/editor/real-preview', previewBody);
  await until(()=>fs.existsSync(signal));
  assert.equal((await fetch(`${origin}/api/health`,{signal:AbortSignal.timeout(2000)})).status,200);
  assert.equal(fs.existsSync(release),false);
  assert.equal((await post('/api/editor/real-preview',previewBody)).status,409);
  fs.writeFileSync(release,'continue');
  const submitted = await pending; const preview = await submitted.json(); assert.equal(submitted.status,202,JSON.stringify(preview));
  await until(async()=>{const response=await post('/api/editor/real-preview-status',{sessionId:opened.browserSessionId,key:preview.key});assert.equal(response.status,200);const status=await response.json();assert.notEqual(status.status,'failed',JSON.stringify(status));assert.equal(status.stale,false,JSON.stringify(status));return status.ready;},30000);
  const media = await fetch(`${origin}/api/editor/real-preview-media?session=${opened.browserSessionId}&key=${preview.key}`,{headers:{Origin:origin}});assert.equal(media.status,200);await media.arrayBuffer();
  const invalid = await post('/api/content/start', { projectRoot: path.join(root, 'content'), topic: 'fixture', show: 'ai-practice', style: 'xingzhe-dark-tech' });
  assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /不匹配/);
  assert.equal(fs.existsSync(path.join(root, 'content')), false);
  const retry = await post('/api/probe-video', { videoPath: selected }); assert.equal(retry.status, 200);
  console.log(JSON.stringify({ status: 'pass', checks: ['http-health-responsive-during-blocked-ffprobe', 'real-preview-submit-health-responsive-and-duplicate-409', 'real-preview-worker-status-and-media-ready', 'http-alias-duplicate-409', 'real-media-worker-preserves-selected-path', 'content-validation-no-partial-project', 'worker-slot-reusable-after-completion'] }, null, 2));
} finally {
  fs.writeFileSync(release, 'continue');
  await pending?.catch(() => {});
  if (server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); process.kill(-server.pid, 'SIGTERM'); await exited; }
  fs.rmSync(root, { recursive: true, force: true });
}
