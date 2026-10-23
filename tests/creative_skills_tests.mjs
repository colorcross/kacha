import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileIdentity } from '../scripts/kacha_utils.mjs';
import { validateCreative, readCreativeReceipt, verifyCreativeVideo } from '../scripts/creative_contract.mjs';
import { creativeTemplate, ingestCreative, attachCreative, prepareCreative, renderCreative, validateNativeCheck, creativeStatus } from '../scripts/creative_skills.mjs';
import { renderCommands, runtimeMissing, runtimeIdentity, providerRuntime } from '../scripts/creative_providers.mjs';
const run = (c, a) => { const r = spawnSync(c, a, { encoding: 'utf8', timeout: 120000 }); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout; };
const write = (f, x) => fs.writeFileSync(f, JSON.stringify(x));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-creative-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'editable'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.html'), '<!doctype html><canvas></canvas>');
  for (const f of ['treatment.md', 'rights.md', 'direction-approved.md']) fs.writeFileSync(path.join(source, f), 'Automated regression fixture, synthetic media only. No production approval asserted.');
  const plan = { ...creativeTemplate('huashu-design', source), reason: 'Regression for an existing synthetic layout', directionStatus: 'existing-direction', output: { width: 160, height: 90, fps: 25, frames: 25, transparent: false } };
  return { root, source, plan };
}
test('creative input contract binds project files, geometry and truthful direction state', t => {
  const { root, source, plan } = fixture(t);
  assert.ok(validateCreative(plan).source.sha256);
  for (const delta of [{ provider: 'shell' }, { reason: '' }, { audioPolicy: 'mix' }, { purpose: 'auto' }, { directionStatus: 'mechanical-test' }, { entry: '../private.html' }, { output: { ...plan.output, frames: 0 } }, { output: { ...plan.output, transparent: true } }, { output: { ...plan.output, width: 99 } }]) assert.throws(() => validateCreative({ ...plan, ...delta }));
  fs.writeFileSync(path.join(root, 'outside.html'), 'private'); fs.symlinkSync(path.join(root, 'outside.html'), path.join(source, 'escape.html'));
  assert.throws(() => validateCreative(plan), /链接/);
});
test('native command mapping uses fixed argv and does not invoke remote generation', () => {
  for (const id of ['huashu-motion', 'huashu-art-motion', 'huashu-design', 'lemo-opuscar']) {
    const plan = { entry: id === 'huashu-art-motion' ? 'clip.json' : 'index.html', output: { width: 1080, height: 1920, fps: 30, frames: 90, transparent: false } };
    const commands = renderCommands(plan, { id, root: '/runtime', entry: '/runtime/entry', modules: '/runtime/node_modules', python: '/runtime/python' }, '/space project', '/out.mp4');
    assert.ok(commands.some(c => c.name === 'render'));
    assert.ok(commands.every(c => !['sh', 'bash', 'npx'].includes(c.command)));
    if (id === 'lemo-opuscar') assert.equal(commands[0].name, 'readcheck');
    if (id === 'huashu-art-motion') assert.deepEqual(commands.map(c => c.name), ['lint', 'audit', 'render']);
    if (id === 'huashu-motion') assert.ok(commands.at(-1).args.includes('/out.mp4'));
    if (id === 'huashu-design') {
      assert.ok(commands.at(-1).args.includes('--keep-chrome'));
      assert.ok(commands[0].args.includes('1080x1920'));
      assert.equal(commands[0].command, '/runtime/python');
    }
  }
  const noText = renderCommands({ entry: 'index.html', textPolicy: 'no-screen-text', output: { width: 320, height: 180, fps: 25, frames: 25 } }, { id: 'lemo-opuscar', root: '/runtime', entry: '/runtime/entry' }, '/work', '/out.mp4');
  assert.deepEqual(noText.map(c => c.name), ['render']);
});
test('OM semantic QA blocks flash frames even when the native CLI exits successfully', () => {
  assert.throws(() => validateNativeCheck('huashu-motion', 'qa', JSON.stringify({ pops: [{ at: 0.4 }], dead: [], cuts: [] })), /单帧闪跳/);
  assert.throws(() => validateNativeCheck('huashu-motion', 'qa', '{}'), /结构/);
  const result = validateNativeCheck('huashu-motion', 'qa', JSON.stringify({ pops: [], dead: [{ from: 1, to: 4 }], cuts: [2] }));
  assert.equal(result.humanReview, 'required'); assert.equal(result.readingHolds.length, 1);
});
test('dependency diagnostics reject broken overrides and bind runtime helper changes', t => {
  const { root } = fixture(t), entry = path.join(root, 'renderer.js'); fs.writeFileSync(entry, '// runtime');
  const missing = runtimeMissing({ id: 'huashu-design', root, entry, modules: path.join(root, 'absent'), python: null });
  assert.equal(missing.length, 3);
  assert.throws(() => runtimeIdentity({ id: 'lemo-opuscar', root, entry }), /缺少本地运行时/);
  const r = { id: 'huashu-motion', root, entry }, before = runtimeIdentity(r).source.sha256;
  fs.writeFileSync(path.join(root, 'helper.js'), '// changed helper');
  assert.notEqual(runtimeIdentity(r).source.sha256, before);
  const prior = process.env.KACHA_CREATIVE_PYTHON;
  try {
    process.env.KACHA_CREATIVE_PYTHON = path.join(root, 'missing-python');
    const art = providerRuntime('huashu-art-motion');
    assert.equal(art.python, null); assert.ok(runtimeMissing(art).some(x => x.includes('Python')));
  } finally { if (prior === undefined) delete process.env.KACHA_CREATIVE_PYTHON; else process.env.KACHA_CREATIVE_PYTHON = prior; }
});
test('creative Python discovery survives the CLI prepending an incompatible managed interpreter', t => {
  const { root } = fixture(t), first = path.join(root, 'managed'), second = path.join(root, 'compatible');
  fs.mkdirSync(first); fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, 'python3'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
  const compatible = path.join(second, 'python3');
  fs.writeFileSync(compatible, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${compatible}\n${root}/playwright\n${root}/PIL\n`)});\n`, { mode: 0o755 });
  const priorPath = process.env.PATH, priorPython = process.env.KACHA_CREATIVE_PYTHON;
  try {
    delete process.env.KACHA_CREATIVE_PYTHON;
    process.env.PATH = [first, second].join(path.delimiter);
    assert.equal(providerRuntime('huashu-design').python, compatible);
    process.env.KACHA_CREATIVE_PYTHON = path.join(first, 'python3');
    assert.equal(providerRuntime('huashu-design').python, null);
  } finally {
    process.env.PATH = priorPath;
    if (priorPython === undefined) delete process.env.KACHA_CREATIVE_PYTHON; else process.env.KACHA_CREATIVE_PYTHON = priorPython;
  }
});
test('recovery checks real PTS, display geometry and WebM without nb_frames; failed imports remain queryable', t => {
  const { root, source, plan } = fixture(t);
  const make = (name, extra = []) => {
    const file = path.join(root, name);
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=25:d=1', ...extra, file]); return file;
  };
  const normal = make('normal.mp4');
  const rotated = path.join(root, 'rotated.mp4');
  run('ffmpeg', ['-v', 'error', '-display_rotation', '90', '-i', normal, '-c', 'copy', rotated]);
  assert.throws(() => verifyCreativeVideo(rotated, plan.output), /旋转/);
  const sar = make('sar.mp4', ['-vf', 'setsar=2/1']);
  assert.throws(() => verifyCreativeVideo(sar, plan.output), /方形像素/);
  const vfr = make('vfr.mp4', ['-vf', 'settb=1/1000,setpts=PTS+if(eq(N\\,10)\\,20\\,0)', '-fps_mode', 'vfr', '-enc_time_base', '1/1000']);
  const metadata = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', vfr])).streams[0];
  assert.equal(metadata.avg_frame_rate, '25/1'); assert.equal(Number(metadata.nb_frames), 25);
  assert.throws(() => verifyCreativeVideo(vfr, plan.output), /帧时间/);
  const webm = make('normal.webm', ['-c:v', 'libvpx-vp9', '-lossless', '1']);
  fs.mkdirSync(path.join(source, 'output'));
  fs.writeFileSync(path.join(source, 'output/asset.txt'), 'Authored asset whose directory name is output');
  const kit = path.join(root, 'webm-package'), receipt = ingestCreative(plan, kit, webm);
  assert.equal(receipt.media.frames, 25); assert.equal(receipt.media.timing, 'packet_pts_verified');
  assert.ok(fs.existsSync(path.join(kit, 'source/output/asset.txt')));
  assert.equal(creativeStatus(kit).status, 'rendered_requires_review');
  fs.appendFileSync(path.join(kit, 'source/output/asset.txt'), 'changed');
  assert.throws(() => creativeStatus(kit), /冻结/);
  const unsupported = make('unsupported.mkv', ['-c:v', 'ffv1']), failed = path.join(root, 'failed-package');
  assert.throws(() => ingestCreative(plan, failed, unsupported), /此编码/);
  assert.equal(creativeStatus(failed).status, 'failed');
  assert.equal(creativeStatus(failed).stage, 'ingest');
  assert.equal(fs.existsSync(path.join(failed, 'receipt.json')), false);
  assert.throws(() => ingestCreative(plan, failed, normal), /EEXIST/);
});
test('creative contract remains available in compact Agent stage packets', () => {
  const result = JSON.parse(run(process.execPath, ['scripts/route_references.mjs', '--task', 'content_generation', '--stage', 'visual_audio', '--modules', 'creative']));
  const serialized = JSON.stringify(result);
  assert.match(serialized, /creative-skills\.md/); assert.match(serialized, /generated-media-assets\.md/);
});
test('creative media recovery and real Timeline IR composition preserve originals, audio and frame boundaries', async t => {
  const { root, plan } = fixture(t), source = path.join(root, 'source.mp4'), media = path.join(root, 'generated.mp4');
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-c:a', 'aac', source]);
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=25:d=1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', '-c:v', 'libx264', '-c:a', 'aac', media]);
  const identity = fileIdentity(media), kit = path.join(root, 'package');
  const receipt = ingestCreative(plan, kit, media);
  assert.equal(receipt.originalAudio, true); assert.equal(receipt.media.audio, false);
  assert.equal(fileIdentity(media).sha256, identity.sha256);
  assert.equal(readCreativeReceipt(kit).receipt.video.sha256, receipt.video.sha256);
  assert.throws(() => verifyCreativeVideo(media, plan.output), /无音频/);
  assert.throws(() => verifyCreativeVideo(media, { ...plan.output, frames: 24 }, { silent: false }), /帧数/);
  assert.throws(() => ingestCreative(plan, kit, media), /EEXIST/);
  assert.throws(() => renderCreative(kit, fileIdentity(path.join(kit, 'creative.json')).sha256), /导入包/);
  const alias = path.join(root, 'editable-alias'); fs.symlinkSync(plan.project, alias);
  assert.throws(() => ingestCreative(plan, path.join(alias, 'nested-package'), media), /之外/);
  assert.throws(() => ingestCreative(plan, path.join(alias, 'new-parent/nested-package'), media), /之外/);
  assert.equal(fs.existsSync(path.join(plan.project, 'new-parent')), false);
  const timeline = path.join(root, 'timeline.json');
  const original = { schemaVersion: '1.0', projectId: 'creative-regression', mode: 'final', source: { ...fileIdentity(source), path: './source.mp4' }, edl: [{ id: 'whole', sourceStart: 0, sourceEnd: 3 }], output: { width: 320, height: 180, fps: 25, path: 'old.mp4' }, audio: { sourceGain: 0.5 }, review: { status: 'pass' }, contracts: { fixture: true } };
  write(timeline, original); const sha = fileIdentity(timeline).sha256;
  const opts = { directory: kit, timeline, expectedSha: sha, output: path.join(root, 'candidate.json'), start: 1, width: 160, height: 90, reason: 'Synthetic insertion regression' };
  const fixtureKit = path.join(root, 'fixture-package');
  ingestCreative({ ...plan, purpose: 'technical-fixture', directionStatus: 'mechanical-test' }, fixtureKit, media);
  assert.throws(() => attachCreative({ ...opts, directory: fixtureKit }), /技术测试/);
  for (const delta of [{ start: 0.01 }, { start: 2.04 }, { width: 100 }, { x: 300 }, { expectedSha: '0'.repeat(64) }, { output: path.join(kit, 'moved.json') }, { reason: '' }]) assert.throws(() => attachCreative({ ...opts, ...delta }));
  const result = attachCreative(opts), candidate = JSON.parse(fs.readFileSync(result.candidate.path));
  assert.deepEqual(candidate.edl, original.edl); assert.deepEqual(candidate.audio, original.audio);
  assert.equal(candidate.review, undefined); assert.equal(candidate.contracts, undefined); assert.equal(candidate.mode, 'preview');
  assert.equal(candidate.visual.overlays[0].provenance.evidence, path.join(kit, 'receipt.json'));
  assert.equal(fileIdentity(timeline).sha256, sha);
  run(process.execPath, ['scripts/kacha.mjs', 'timeline', 'render', '--plan', result.candidate.path]);
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', candidate.output.path]));
  assert.equal(Number(probe.streams.find(s => s.codec_type === 'video').nb_frames), 75);
  assert.ok(probe.streams.some(s => s.codec_type === 'audio'));
  const sample = second => spawnSync('ffmpeg', ['-v', 'error', '-ss', String(second), '-i', candidate.output.path, '-vf', 'crop=2:2:20:20,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']).stdout;
  assert.ok(sample(0.2)[2] > 180); assert.ok(sample(1.2)[0] > 180); assert.ok(sample(2.2)[2] > 180);
  await t.test('frozen source and media tampering invalidate receipt', () => {
    for (const file of [receipt.original.path, receipt.video.path, path.join(kit, 'source/rights.md')]) {
      const bytes = fs.readFileSync(file); fs.appendFileSync(file, 'changed');
      assert.throws(() => readCreativeReceipt(kit), /身份/); fs.writeFileSync(file, bytes);
    }
    const file = path.join(kit, 'source/index.html'); fs.appendFileSync(file, 'changed');
    assert.throws(() => readCreativeReceipt(kit), /冻结/);
  });
});
test('portrait alpha recovery supports external art scenes without claiming native spec QA', t => {
  const { root, plan } = fixture(t), media = path.join(root, 'portrait.mov');
  const external = { ...plan, provider: 'huashu-art-motion', renderMode: 'external-output', output: { width: 90, height: 160, fps: 25, frames: 25, transparent: true } };
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.5:s=90x160:r=25:d=1,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', media]);
  const kit = path.join(root, 'portrait-package');
  const receipt = ingestCreative(external, kit, media);
  assert.match(receipt.media.pixelFormat, /yuva/); assert.equal(receipt.media.frames, 25);
  assert.equal(receipt.execution.nativeChecks, 'not_attested');
  assert.throws(() => prepareCreative(external, path.join(root, 'illegal-native')), /外部场景/);
  assert.equal(fs.existsSync(path.join(root, 'illegal-native')), false);
});
test('art spec forbids unbound media and requires geometry agreement', t => {
  const { source, plan } = fixture(t);
  const clip = path.join(source, 'clip.json');
  const p = { ...plan, provider: 'huashu-art-motion', entry: 'clip.json' };
  const spec = { width: 160, height: 90, fps: 25, duration: 1, grammar: 'y3_whiteboard', cues: [{ at: 0, kind: 'image', image: 'https://example.invalid/private.png' }] };
  write(clip, spec); assert.throws(() => validateCreative(p), /相对/);
  delete spec.cues[0].image; spec.duration = 2; write(clip, spec);
  assert.throws(() => validateCreative(p), /帧数/);
  spec.duration = 1; spec.cues[0].image = 'node_modules/image.png';
  fs.mkdirSync(path.join(source, 'node_modules')); fs.writeFileSync(path.join(source, 'node_modules/image.png'), 'synthetic');
  write(clip, spec); assert.throws(() => validateCreative(p), /被排除/);
});
test('art specs freeze native frame directories and character pose dictionaries', t => {
  const { root, source, plan } = fixture(t);
  const frames = path.join(source, 'frames'); fs.mkdirSync(frames);
  fs.writeFileSync(path.join(frames, '01.png'), 'synthetic frame one');
  fs.writeFileSync(path.join(frames, '02.webp'), 'synthetic frame two');
  const clip = path.join(source, 'clip.json');
  const p = { ...plan, provider: 'huashu-art-motion', entry: 'clip.json' };
  const spec = { width: 160, height: 90, fps: 25, duration: 1, grammar: 'y4_storytime', cues: [{ at: 0, kind: 'point', text: 'TEST', frames: 'frames' }] };
  for (const character of ['frames', { frames: 'frames' }, { frames: { rest: 'frames/01.png', point: 'frames/02.webp' } }]) {
    spec.data = { character }; write(clip, spec);
    const result = validateCreative(p);
    assert.ok(result.source.files.some(f => f.path === 'frames/01.png'));
    const before = result.source.sha256;
    fs.appendFileSync(path.join(frames, '01.png'), 'changed frame');
    assert.notEqual(validateCreative(p).source.sha256, before);
  }
  // Both list and directory forms must retain the same containment/freeze checks.
  const invalidCharacters = [{ frames: {} }, { frames: { idle: '../outside.png' } }, { frames: { idle: 'https://example.invalid/pose.png' } }];
  for (const character of invalidCharacters) {
    spec.data = { character }; write(clip, spec); assert.throws(() => validateCreative(p));
  }
  delete spec.data;
  fs.mkdirSync(path.join(source, 'empty'));
  for (const invalid of ['empty', [], ['../outside.png']]) {
    spec.cues[0].frames = invalid; write(clip, spec); assert.throws(() => validateCreative(p));
  }
  fs.mkdirSync(path.join(source, 'node_modules'));
  fs.mkdirSync(path.join(source, 'node_modules/frames'));
  fs.writeFileSync(path.join(source, 'node_modules/frames/01.png'), 'excluded');
  spec.cues[0].frames = 'node_modules/frames'; write(clip, spec);
  assert.throws(() => validateCreative(p), /被排除/);
  fs.writeFileSync(path.join(root, 'outside.png'), 'outside');
  fs.symlinkSync(path.join(root, 'outside.png'), path.join(frames, 'outside.png'));
  spec.cues[0].frames = 'frames'; write(clip, spec);
  assert.throws(() => validateCreative(p), /目录内/);
});
