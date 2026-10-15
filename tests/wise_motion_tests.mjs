import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileIdentity, sha256Value } from '../scripts/kacha_utils.mjs';
import { validateSpec, verifyMedia, digest, readMotionReceipt } from '../scripts/wise_motion_contract.mjs';
import { attachWiseMotion } from '../scripts/wise_motion.mjs';

const run = (command, args) => { const r = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 }); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout; };
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
test('motion inputs reject distortion, external URLs, unsupported effects and implicit demo content', () => {
  const base = { effectId: 'type-reveal', content: { text: '核实后再表达' } };
  assert.equal(validateSpec(base).fps, 25);
  for (const change of [{ width: 1080, height: 1920 }, { speed: 0 }, { fps: 29.97 }, { includeAudio: true }, { assetBaseUrl: 'https://example.com' }, { effectId: 'moon' }, { content: null }, { content: {} }, { transparent: 'false' }, { width: 0 }]) assert.throws(() => validateSpec({ ...base, ...change }));
  assert.throws(() => validateSpec({ effectId: 'stagger-in', content: { labels: ['一', '二', '三', '四'] }, transparent: true }), /透明/);
});
test('motion candidate preserves existing edit, paths and sound while binding actual media', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-wise-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kit = path.join(root, 'motion'); fs.mkdirSync(kit);
  const source = path.join(root, 'source.mp4'), video = path.join(kit, 'motion.mp4');
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-vf', "drawbox=color=lime:t=fill:enable='eq(n,74)'", '-c:v', 'libx264', '-c:a', 'aac', source]);
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=25:d=1', '-an', '-c:v', 'libx264', video]);
  const spec = validateSpec({ effectId: 'type-reveal', content: { text: '测试' }, width: 160, height: 90 });
  const manifest = { kind: 'kacha-wise-motion-package', spec, frames: 25, source: { origin: 'original', license: 'Apache-2.0' }, fixture: true };
  manifest.digest = digest(manifest); const mf = path.join(kit, 'motion.json'); write(mf, manifest);
  const notices = ['LICENSE', 'NOTICE.md'].map(name => { const file = path.join(kit, name); fs.writeFileSync(file, 'Test fixture only'); return fileIdentity(file); });
  const receipt = { kind: 'kacha-wise-motion-render', status: 'rendered_requires_review', manifest: fileIdentity(mf), video: fileIdentity(video), notices };
  receipt.digest = digest(receipt); const rf = path.join(kit, 'receipt.json'); write(rf, receipt);
  const timeline = path.join(root, 'timeline.json');
  const original = { schemaVersion: '1.0', projectId: 'generic-wise-test', mode: 'final', source: { ...fileIdentity(source), path: './source.mp4' }, edl: [{ id: 'whole', sourceStart: 0, sourceEnd: 3 }], output: { width: 320, height: 180, fps: 25, path: 'old.mp4' }, audio: { sourceGain: 0.5 }, review: { status: 'pass' }, contracts: { fixture: true } };
  write(timeline, original); const expectedSha = fileIdentity(timeline).sha256;
  const options = { directory: kit, timeline, expectedSha, output: path.join(root, 'candidate.json'), start: 1, width: 160, height: 90, reason: '合成测试落点，不是产品演示' };
  await t.test('exact media checks reject audio, wrong frames and opaque alpha', () => {
    assert.equal(verifyMedia(video, { ...spec, frames: 25 }).audio, false);
    assert.throws(() => verifyMedia(source, { ...spec, frames: 75 }), /无音频/);
    assert.throws(() => verifyMedia(video, { ...spec, frames: 24 }), /帧数/);
    assert.throws(() => verifyMedia(video, { ...spec, frames: 25, transparent: true }), /alpha/);
  });
  await t.test('rejects stale source and boundaries without writing candidates', () => {
    for (const change of [{ expectedSha: '0'.repeat(64) }, { start: 2.04 }, { start: 0.01 }, { x: 300 }, { width: 100 }, { output: path.join(kit, 'relocated.json') }, { reason: '' }]) assert.throws(() => attachWiseMotion({ ...options, ...change }));
    const bytes = fs.readFileSync(source);
    try { fs.appendFileSync(source, 'mutation'); assert.throws(() => attachWiseMotion(options), /sha/i); }
    finally { fs.writeFileSync(source, bytes); }
    assert.ok(!fs.existsSync(options.output));
  });
  await t.test('renders a real layered candidate and leaves original audio policy unchanged', () => {
    const result = attachWiseMotion(options), candidate = JSON.parse(fs.readFileSync(result.candidate.path));
    assert.equal(fileIdentity(timeline).sha256, expectedSha);
    assert.equal(candidate.mode, 'preview'); assert.equal(candidate.review, undefined); assert.equal(candidate.contracts, undefined);
    assert.deepEqual(candidate.audio, original.audio); assert.deepEqual(candidate.edl, original.edl); assert.equal(candidate.source.path, './source.mp4');
    assert.equal(candidate.visual.overlays[0].provenance.factualEvidence, false);
    run(process.execPath, ['scripts/kacha.mjs', 'timeline', 'render', '--plan', result.candidate.path]);
    const data = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', candidate.output.path]));
    assert.ok(data.streams.some(s => s.codec_type === 'audio')); assert.equal(Number(data.streams.find(s => s.codec_type === 'video').nb_frames), 75);
    const sample = second => spawnSync('ffmpeg', ['-v', 'error', '-ss', String(second), '-i', candidate.output.path, '-vf', 'crop=2:2:20:20,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']).stdout;
    assert.ok(sample(0.2)[2] > 180); assert.ok(sample(1.2)[0] > 180); assert.ok(sample(2.2)[2] > 180);
    const last = spawnSync('ffmpeg', ['-v', 'error', '-i', candidate.output.path, '-vf', 'select=eq(n\\,74),crop=2:2:20:20,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']).stdout;
    assert.ok(last.length && last[1] > 180 && last[2] < 30, 'the unique final green source frame must survive; duplicating the previous blue frame is not sufficient');
    assert.throws(() => attachWiseMotion(options), /新 JSON/);
  });
  await t.test('changed media, manifests or notices invalidate the receipt', () => {
    const bytes = fs.readFileSync(video); fs.appendFileSync(video, 'changed'); assert.throws(() => readMotionReceipt(kit), /身份/); fs.writeFileSync(video, bytes);
    write(mf, { ...manifest, frames: 1 }); assert.throws(() => readMotionReceipt(kit), /身份/); write(mf, manifest);
    fs.appendFileSync(notices[0].path, 'changed'); assert.throws(() => readMotionReceipt(kit), /身份/);
    assert.notEqual(sha256Value({ a: 1 }), sha256Value({ a: 2 }));
  });
});
