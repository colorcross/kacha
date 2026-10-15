import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileIdentity } from '../scripts/kacha_utils.mjs';
import { prepareProfessionalPackage, professionalPackageStatus, receiveProfessionalResult, renderProfessionalPackage, detectProfessionalTools, aeScript } from '../scripts/professional_tools.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args) => { const r = spawnSync(command, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 16e6 }); assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout; };
const write = (file, v) => fs.writeFileSync(file, JSON.stringify(v));
const read = file => JSON.parse(fs.readFileSync(file));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('professional tool bridge preserves media, isolates candidates and fails closed', { timeout: 180000 }, async t => {
  const root = process.env.KACHA_PRO_TOOLS_TEST_ROOT ? path.resolve(process.env.KACHA_PRO_TOOLS_TEST_ROOT) : fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-pro-tools-'));
  fs.mkdirSync(root, { recursive: true });
  t.after(() => { if (!process.env.KACHA_PRO_TOOLS_TEST_ROOT) fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'source.mov'), timeline = path.join(root, 'timeline.json');
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=25:d=2', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]', '-map', '[v]', '-map', '[a]', '-ac', '2', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source]);
  const plan = { schemaVersion: '1.0', projectId: 'external-bridge-fixture', mode: 'preview', source: fileIdentity(source), edl: [{ id: 'blue-tail', sourceStart: 2, sourceEnd: 3 }, { id: 'red-head', sourceStart: 0, sourceEnd: 1 }], output: { width: 160, height: 90, fps: 25, path: path.join(root, 'original.mp4') } };
  write(timeline, plan); const original = fileIdentity(timeline);
  const kit = path.join(root, 'ae-kit');
  await t.test('detect never equates a missing app with verified automation', () => {
    const found = detectProfessionalTools([path.join(root, 'no-apps')]);
    assert.ok(found.applications.every(a => !a.installed && a.applicationRoundtrip === 'not_verified'));
  });
  await t.test('unsupported layers and non-frame edits are rejected before creating output', () => {
    for (const modified of [{ ...plan, visual: { overlays: [{ id: 'required', path: source }] } }, { ...plan, edl: [{ id: 'x', sourceStart: 0.015, sourceEnd: 1 }] }]) {
      const file = path.join(root, 'unsupported.json'); write(file, modified);
      assert.throws(() => prepareProfessionalPackage({ timeline: file, tool: 'after-effects', output: path.join(root, 'rejected') }));
      assert.ok(!fs.existsSync(path.join(root, 'rejected')));
    }
  });
  await t.test('VFR with matching average fps is rejected before silently duplicating frames', () => {
    const vfr = path.join(root, 'vfr.mov'), vfrPlan = path.join(root, 'vfr.json');
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=50:d=2', '-vf', 'select=lt(n\\,25)+gte(n\\,75)', '-fps_mode', 'vfr', '-c:v', 'libx264', '-an', vfr]);
    write(vfrPlan, { ...plan, source: fileIdentity(vfr), edl: [{ id: 'vfr', sourceStart: 0, sourceEnd: 2 }] });
    assert.throws(() => prepareProfessionalPackage({ timeline: vfrPlan, tool: 'jianying', output: path.join(root, 'vfr-kit') }), /VFR/);
    assert.ok(!fs.existsSync(path.join(root, 'vfr-kit')));
  });
  await t.test('actual background job stages high quality clips and editable AE script', async () => {
    const prepared = prepareProfessionalPackage({ timeline, tool: 'after-effects', output: kit, title: '中文标题 "AE"\\\n验证' });
    assert.equal(prepared.applicationVerified, false);
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(path.join(kit, 'staged.json'))) {
      const job = read(path.join(kit, '.kacha/jobs/stage/job.json'));
      assert.ok(!['failed', 'cancelled'].includes(job.status), JSON.stringify(job.error));
      assert.ok(Date.now() < deadline, 'preparation timed out'); await pause(200);
    }
    const status = professionalPackageStatus(kit, [path.join(root, 'no-apps')]);
    assert.equal(status.status, 'prepared_requires_application');
    const staged = read(path.join(kit, 'staged.json')); assert.equal(staged.files.length, 2);
    const p = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', staged.files[0].path]));
    assert.equal(p.streams.find(s => s.codec_type === 'video').codec_name, 'prores');
    assert.equal(p.streams.find(s => s.codec_type === 'audio').channels, 2);
    new vm.Script(fs.readFileSync(path.join(kit, 'assembly.jsx'), 'utf8'));
    assert.throws(() => prepareProfessionalPackage({ timeline, tool: 'after-effects', output: kit }), /EEXIST/);
    assert.throws(() => renderProfessionalPackage(kit, 'Lossless', [path.join(root, 'no-apps')]), /AE/);
  });
  await t.test('AE script refuses a nonempty project without modifying it', () => {
    let touched = false;
    function File(name) { this.parent = { fsName: root }; this.exists = false; this.fsName = name; }
    assert.throws(() => vm.runInNewContext(aeScript(read(path.join(kit, 'package.json'))), { File, $: { fileName: 'assembly.jsx' }, app: { project: { numItems: 1 }, beginUndoGroup: () => { touched = true; } } }), /empty/);
    assert.equal(touched, false);
  });
  const returned = path.join(root, 'synthetic-external-output.mov');
  await t.test('synthetic returned program validates and renders as a new candidate', () => {
    run('ffmpeg', ['-v', 'error', '-i', path.join(kit, 'media/0001.mov'), '-i', path.join(kit, 'media/0002.mov'), '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'pcm_s16le', returned]);
    const destination = path.join(root, 'returned');
    const receipt = receiveProfessionalResult({ directory: kit, media: returned, output: destination });
    assert.equal(receipt.status, 'technical_candidate_requires_review'); assert.equal(receipt.applicationVerified, false);
    assert.equal(fileIdentity(timeline).sha256, original.sha256);
    const candidate = read(receipt.candidate.path);
    assert.equal(candidate.mode, 'preview'); assert.equal(candidate.edl.length, 1); assert.equal(candidate.review, undefined);
    assert.notEqual(candidate.source.path, returned);
    run(process.execPath, [path.join(repo, 'scripts/kacha.mjs'), 'timeline', 'render', '--plan', receipt.candidate.path]);
    const first = spawnSync('ffmpeg', ['-v', 'error', '-i', candidate.output.path, '-vf', 'select=eq(n\\,5),crop=2:2:20:20,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']).stdout;
    assert.ok(first[2] > 180 && first[0] < 30, `expected blue first: ${first}`);
    const audio = spawnSync('ffmpeg', ['-v', 'error', '-i', candidate.output.path, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']).stdout;
    let crosses = 0; for (let i = 4801; i < 24000; i++) if (audio.readFloatLE((i - 1) * 4) < 0 && audio.readFloatLE(i * 4) >= 0) crosses++;
    assert.ok(Math.abs(crosses / 0.4 - 1000) < 5);
    assert.throws(() => receiveProfessionalResult({ directory: kit, media: returned, output: destination }), /EEXIST/);
  });
  await t.test('Jianying enhancement CLI and receive preserve bound records and reject stale exports', async () => {
    const jyKit = path.join(root, 'jianying-kit');
    prepareProfessionalPackage({ timeline, tool: 'jianying', output: jyKit });
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(path.join(jyKit, 'staged.json'))) {
      const job = read(path.join(jyKit, '.kacha/jobs/stage/job.json'));
      assert.ok(!['failed', 'cancelled'].includes(job.status), JSON.stringify(job.error));
      assert.ok(Date.now() < deadline); await pause(200);
    }
    const requestFile = path.join(root, 'enhance-request.json'), planFile = path.join(root, 'enhance-plan.json'), recordFile = path.join(root, 'enhance-record.json');
    write(requestFile, { operations: [{ capability: 'denoise', reason: 'fixture only', clipIds: ['blue-tail'] }] });
    run(process.execPath, [path.join(repo, 'scripts/kacha.mjs'), 'pro-tools', 'enhance-plan', '--package', jyKit, '--request', requestFile, '--output', planFile]);
    const enhancement = read(planFile);
    const record = { planDigest: enhancement.digest, exportSha256: fileIdentity(returned).sha256, applicationVersion: 'test-only', projectName: 'synthetic fixture', membership: 'unknown', operations: [{ id: 'op-1', status: 'applied', entitlement: 'free', settings: 'fixture, not real Jianying processing', evidence: [fileIdentity(requestFile)] }] };
    write(recordFile, record);
    const received = receiveProfessionalResult({ directory: jyKit, media: returned, output: path.join(root, 'enhanced-candidate'), enhancementPlan: planFile, enhancementRecord: recordFile });
    assert.equal(received.applicationVerified, false); assert.equal(received.enhancement.qualityVerified, false);
    const candidate = read(received.candidate.path);
    assert.equal(read(candidate.externalTool.enhancement.record.path).exportSha256, fileIdentity(returned).sha256);
    assert.throws(() => receiveProfessionalResult({ directory: jyKit, media: returned, output: path.join(root, 'bad-pair'), enhancementPlan: planFile }), /同时/);
    write(recordFile, { ...record, exportSha256: 'stale' });
    assert.throws(() => receiveProfessionalResult({ directory: jyKit, media: returned, output: path.join(root, 'bad-record'), enhancementPlan: planFile, enhancementRecord: recordFile }), /不匹配/);
    assert.ok(!fs.existsSync(path.join(root, 'bad-record')));
  });
  await t.test('delayed audio keeps leading and trailing silence and short audio is rejected', async () => {
    const delayed = path.join(root, 'delayed.mov'), delayedPlan = path.join(root, 'delayed.json'), delayedKit = path.join(root, 'delayed-kit');
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=25:d=4', '-itsoffset', '1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'pcm_s16le', delayed]);
    write(delayedPlan, { ...plan, source: fileIdentity(delayed), edl: [{ id: 'delayed', sourceStart: 0, sourceEnd: 4 }] });
    prepareProfessionalPackage({ timeline: delayedPlan, tool: 'jianying', output: delayedKit });
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(path.join(delayedKit, 'staged.json'))) {
      assert.notEqual(read(path.join(delayedKit, '.kacha/jobs/stage/job.json')).status, 'failed');
      assert.ok(Date.now() < deadline); await pause(200);
    }
    const staged = path.join(delayedKit, 'media/0001.mov');
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', staged, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']).stdout;
    assert.equal(decoded.length / 4, 192000);
    const rms = (a, b) => { let sum = 0; for (let i = a * 48000; i < b * 48000; i++) sum += decoded.readFloatLE(i * 4) ** 2; return Math.sqrt(sum / ((b - a) * 48000)); };
    assert.equal(rms(0, 1), 0); assert.ok(rms(1, 3) > 0.08); assert.equal(rms(3, 4), 0);
    const shortAudio = path.join(root, 'short-audio.mov');
    run('ffmpeg', ['-v', 'error', '-i', staged, '-filter_complex', '[0:a]atrim=duration=2[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'pcm_s16le', shortAudio]);
    assert.throws(() => receiveProfessionalResult({ directory: delayedKit, media: shortAudio, output: path.join(root, 'short-audio-candidate') }), /音轨/);
    assert.ok(!fs.existsSync(path.join(root, 'short-audio-candidate')));
  });
  await t.test('a real failed encoding job is surfaced as failed', async () => {
    const bin = path.join(root, 'fail-bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\necho injected-encode-failure >&2\nexit 42\n', { mode: 0o755 });
    const beforePath = process.env.PATH, failedKit = path.join(root, 'failed-kit');
    try { process.env.PATH = bin + path.delimiter + beforePath; prepareProfessionalPackage({ timeline, tool: 'jianying', output: failedKit }); }
    finally { process.env.PATH = beforePath; }
    const deadline = Date.now() + 30000;
    while (read(path.join(failedKit, '.kacha/jobs/stage/job.json')).status !== 'failed') { assert.ok(Date.now() < deadline); await pause(200); }
    assert.equal(professionalPackageStatus(failedKit, []).status, 'failed');
    assert.ok(!fs.existsSync(path.join(failedKit, 'staged.json')));
  });
  await t.test('short, changed-base and changed-staged results fail closed', () => {
    const short = path.join(root, 'short.mov'); run('ffmpeg', ['-v', 'error', '-i', returned, '-t', '1', '-c', 'copy', short]);
    assert.throws(() => receiveProfessionalResult({ directory: kit, media: short, output: path.join(root, 'short-candidate') }), /不匹配/);
    write(timeline, { ...plan, projectId: 'changed' });
    assert.throws(() => receiveProfessionalResult({ directory: kit, media: returned, output: path.join(root, 'stale-candidate') }), /身份/);
    write(timeline, plan);
    fs.appendFileSync(path.join(kit, 'media/0001.mov'), 'changed');
    assert.throws(() => receiveProfessionalResult({ directory: kit, media: returned, output: path.join(root, 'tampered-candidate') }), /身份/);
    assert.ok(!fs.existsSync(path.join(root, 'short-candidate')));
    assert.ok(!fs.existsSync(path.join(root, 'stale-candidate')));
    assert.ok(!fs.existsSync(path.join(root, 'tampered-candidate')));
  });
});
