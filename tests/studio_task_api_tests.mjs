import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  cwd: repository, env: { ...process.env, KACHA_FFPROBE_BIN: path.join(wrapper, 'ffprobe'), PATH: `${wrapper}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
});
let stderr = ''; server.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
const origin = `http://127.0.0.1:${port}`;
const post = (endpoint, body) => fetch(`${origin}${endpoint}`, { method: 'POST', headers: { Origin: origin, 'X-Kacha-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
async function until(condition) {
  const deadline = Date.now() + 10000;
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
  const invalid = await post('/api/content/start', { projectRoot: path.join(root, 'content'), topic: 'fixture', show: 'ai-practice', style: 'xingzhe-dark-tech' });
  assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /不匹配/);
  assert.equal(fs.existsSync(path.join(root, 'content')), false);
  const retry = await post('/api/probe-video', { videoPath: selected }); assert.equal(retry.status, 200);
  console.log(JSON.stringify({ status: 'pass', checks: ['http-health-responsive-during-blocked-ffprobe', 'http-alias-duplicate-409', 'real-media-worker-preserves-selected-path', 'content-validation-no-partial-project', 'worker-slot-reusable-after-completion'] }, null, 2));
} finally {
  fs.writeFileSync(release, 'continue');
  await pending?.catch(() => {});
  if (server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); process.kill(-server.pid, 'SIGTERM'); await exited; }
  fs.rmSync(root, { recursive: true, force: true });
}
