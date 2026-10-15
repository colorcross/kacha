#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileIdentity, readJson, sha256Value, acquireFileLock } from './kacha_utils.mjs';
import { buildTimelineProjection, assertProjectionSourceCurrent } from './timeline_projection.mjs';
import { acquireResourceLeases } from './resource_pool.mjs';
import { loadKachaConfig } from './kacha_config.mjs';
import { WISE_VERSION, WISE_EFFECTS, need, digest, exclusive, checkIdentity, validateSpec, verifyMedia, readMotionReceipt } from './wise_motion_contract.mjs';

const self = fileURLToPath(import.meta.url), scripts = path.dirname(self);
const runtimeDefault = () => process.env.KACHA_WISE_MOTION_RUNTIME || path.join(os.homedir(), '.cache/kacha/wise-motion', WISE_VERSION);
const lockRoot = path.resolve(scripts, '../references/wise-motion-runtime');
function invoke(command, args, timeout = 120000) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error(`${path.basename(command)} 失败：${r.error?.message ?? r.stderr ?? r.stdout}`);
  return r.stdout;
}
function runtime(directory = runtimeDefault()) {
  const root = fs.realpathSync(directory), pkg = path.join(root, 'node_modules/wise-motion');
  need(readJson(path.join(pkg, 'package.json')).version === WISE_VERSION, `需要 wise-motion ${WISE_VERSION}；不能静默替换版本`);
  const require = createRequire(path.join(root, 'package.json'));
  for (const name of ['remotion', '@remotion/renderer', '@remotion/bundler']) need(require(`${name}/package.json`).version === '4.0.532', 'Remotion 组件版本不一致');
  return { root, pkg, require };
}
// Hash the source and assets actually used by the adapter. No private fonts/media are copied.
function runtimeIdentity(r) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, entry.name);
      need(!entry.isSymbolicLink(), 'wise-motion 包不得包含链接');
      if (entry.isDirectory()) walk(f);
      else if (entry.isFile()) files.push({ path: path.relative(r.root, f), sha256: fileIdentity(f).sha256 });
    }
  }
  walk(r.pkg);
  return { version: WISE_VERSION, root: r.root, lock: fileIdentity(path.join(r.root, 'package-lock.json')), digest: sha256Value(files.sort((a, b) => a.path.localeCompare(b.path))) };
}
async function api(r) { return import(pathToFileURL(path.join(r.pkg, 'dist/index.mjs')).href); }
function stageAssets(r, source, root) {
  // The 12 supported painters need shared fonts/runtime and their declared scripts,
  // not the upstream library's unrelated footage, music or reference recordings.
  const files = new Set(['catalog/scenes.css', 'catalog/frame.css', 'catalog/history.css', 'catalog/book-controls.css', 'catalog/content.js', 'catalog/runtime.js', source.path, ...(source.dependencies ?? []), ...(source.assets ?? [])]);
  const dest = path.join(root, 'public/wise-motion');
  for (const file of [...files, 'catalog/fonts', 'vendor/animejs']) {
    need(typeof file === 'string' && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..') && !file.includes(':'), '素材依赖路径无效');
    const target = path.join(dest, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(r.pkg, file), target, { recursive: true, errorOnExist: true, force: false });
  }
}
export async function searchWiseMotion(query = '', directory) {
  const r = runtime(directory), { effectDefinitions } = await api(r);
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return { version: WISE_VERSION, total: effectDefinitions.length, effects: effectDefinitions.filter(e => words.every(w => JSON.stringify([e.id, e.name, e.summary, e.purpose, e.aliases]).toLowerCase().includes(w))).map(e => ({ id: e.id, name: e.name, summary: e.summary, purpose: e.purpose, renderSupported: WISE_EFFECTS.includes(e.id), source: e.source, contentSlots: e.content_slots ?? [] })) };
}
export function setupWiseMotion(directory = runtimeDefault()) {
  const root = path.resolve(directory);
  fs.mkdirSync(path.dirname(root), { recursive: true }); fs.mkdirSync(root);
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(lockRoot, file), path.join(root, file), fs.constants.COPYFILE_EXCL);
  // npm's JS entry keeps the current Node executable, including on machines with an older system Node.
  const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  need(fs.existsSync(npm), '当前 Node 安装缺少 npm；使用含 npm 的 Node 26 安装');
  invoke(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', root], 1200000);
  return { status: 'installed', ...runtimeIdentity(runtime(root)), browser: 'resolved_on_first_render' };
}
export async function prepareWiseMotion({ spec, output, runtimeDirectory, browserExecutable } = {}) {
  const s = validateSpec(spec), r = runtime(runtimeDirectory), upstream = await api(r);
  const effect = upstream.resolveEffect(s.effectId);
  need(effect.source?.origin === 'original' && effect.source?.license === 'Apache-2.0', '当前接入只渲染已核验的原创内容槽效果');
  upstream.validateContent(effect, s.content);
  const meta = upstream.getEffectMetadata(s.effectId, { fps: s.fps, speed: s.speed });
  const requestedRoot = path.resolve(output), identity = runtimeIdentity(r);
  const browserPath = browserExecutable || process.env.KACHA_WISE_MOTION_BROWSER || (process.platform === 'darwin' && fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
  const browser = browserPath ? fileIdentity(fs.realpathSync(browserPath)) : null;
  need(Number.isInteger(meta.durationInFrames) && meta.durationInFrames > 0 && meta.durationInFrames <= s.fps * 60, '效果帧数无效');
  fs.mkdirSync(path.dirname(requestedRoot), { recursive: true }); fs.mkdirSync(requestedRoot);
  const root = fs.realpathSync(requestedRoot);
  const m = { schemaVersion: '1.0', kind: 'kacha-wise-motion-package', spec: s, frames: meta.durationInFrames, runtime: identity, browser, source: effect.source, includeAudio: false, review: 'required', createdAt: new Date().toISOString() };
  m.digest = digest(m); exclusive(path.join(root, 'motion.json'), m);
  const job = JSON.parse(invoke(process.execPath, [path.join(scripts, 'kacha_jobs.mjs'), 'submit', '--project-root', root, '--id', 'wise-render', '--kind', 'motion-render', '--expected-output', path.join(root, 'receipt.json'), '--', process.execPath, self, 'worker', '--package', root, '--manifest-sha', fileIdentity(path.join(root, 'motion.json')).sha256]));
  return { status: 'queued', package: root, spec: s, frames: m.frames, job };
}
export async function renderWiseMotion(directory, expectedSha) {
  const root = fs.realpathSync(directory), manifestFile = path.join(root, 'motion.json');
  need(fileIdentity(manifestFile).sha256 === expectedSha, '动效任务合同已变化');
  const m = readJson(manifestFile); need(m.digest === digest(m), '动效合同失效'); validateSpec(m.spec);
  const r = runtime(m.runtime.root); need(sha256Value(runtimeIdentity(r)) === sha256Value(m.runtime), '上游运行时或依赖锁已改变');
  const unlock = acquireFileLock(path.join(root, 'render.lock'), { purpose: 'wise-motion-render' });
  let resources;
  try {
    need(!fs.existsSync(path.join(root, 'receipt.json')) && !fs.existsSync(path.join(root, 'motion.mp4')) && !fs.existsSync(path.join(root, 'motion.mov')), '不覆盖已有产物；失败或返工请创建新包');
    let browser = m.browser;
    if (browser) checkIdentity(browser);
    else {
      // Download once per runtime, outside scarce encode leases. Bound network setup to five minutes.
      const releaseBrowser = acquireFileLock(path.join(r.root, 'browser.lock'), { purpose: 'wise-motion-browser' });
      try { browser = fileIdentity(JSON.parse(invoke(process.execPath, [self, 'browser', '--runtime', r.root], 300000)).path); }
      finally { releaseBrowser(); }
    }
    resources = acquireResourceLeases({ config: loadKachaConfig({ anchorPath: root, includeSecrets: false }).config, projectRoot: root, resources: ['cpuHeavy', 'videoEncode'], purpose: 'wise-motion-render' });
    fs.symlinkSync(path.join(r.root, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    stageAssets(r, m.source, root);
    const { width, height, fps, ...props } = m.spec;
    const entry = path.join(root, 'entry.jsx');
    exclusive(entry, `import React from 'react';\nimport {registerRoot,Composition} from 'remotion';\nimport {WiseMotionEffect} from 'wise-motion';\nconst Motion=()=> <WiseMotionEffect {...${JSON.stringify(props)}} width={${width}} height={${height}} includeAudio={false}/>;\nregisterRoot(()=> <Composition id="KachaWiseMotion" component={Motion} width={${width}} height={${height}} fps={${fps}} durationInFrames={${m.frames}}/>);\n`);
    const { bundle } = r.require('@remotion/bundler'), { renderMedia, selectComposition } = r.require('@remotion/renderer');
    const serveUrl = await bundle({ entryPoint: entry, publicDir: path.join(root, 'public'), outDir: path.join(root, 'bundle') });
    const composition = await selectComposition({ serveUrl, id: 'KachaWiseMotion', browserExecutable: browser.path });
    const output = path.join(root, m.spec.transparent ? 'motion.mov' : 'motion.mp4');
    await renderMedia({ composition, serveUrl, browserExecutable: browser.path, outputLocation: output, concurrency: 2, muted: true, codec: m.spec.transparent ? 'prores' : 'h264', imageFormat: 'png', pixelFormat: m.spec.transparent ? 'yuva444p10le' : 'yuv420p', ...(m.spec.transparent ? { proResProfile: '4444' } : { crf: 16 }), timeoutInMilliseconds: 120000 });
    const media = verifyMedia(output, { ...m.spec, frames: m.frames });
    invoke('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], 300000);
    need(fileIdentity(manifestFile).sha256 === expectedSha && sha256Value(runtimeIdentity(r)) === sha256Value(m.runtime), '渲染期间输入已改变');
    const notices = [];
    for (const file of ['LICENSE', 'NOTICE.md', 'ASSET-MANIFEST.json']) { const dest = path.join(root, `upstream-${file}`); fs.copyFileSync(path.join(r.pkg, file), dest, fs.constants.COPYFILE_EXCL); notices.push(fileIdentity(dest)); }
    checkIdentity(browser);
    const receipt = { schemaVersion: '1.0', kind: 'kacha-wise-motion-render', status: 'rendered_requires_review', manifest: fileIdentity(manifestFile), video: fileIdentity(output), browser, media, notices, checks: { decoded: true, exactFrames: true, silent: true }, reviewRequired: ['normal_speed', 'text_and_facts', 'fonts_and_style', 'rights', 'placement'] };
    receipt.digest = digest(receipt); exclusive(path.join(root, 'receipt.json'), receipt); return receipt;
  } finally { resources?.release(); unlock(); }
}
export function attachWiseMotion({ directory, timeline, expectedSha, output, start, x = 0, y = 0, width, height, reason } = {}) {
  const { receipt, manifest } = readMotionReceipt(directory), input = fs.realpathSync(timeline), out = path.resolve(output);
  need(fileIdentity(input).sha256 === expectedSha, '原时间线已变化；请重新检查插入位置');
  need(path.dirname(out) === path.dirname(input) && out !== input && !fs.existsSync(out), '候选必须为原时间线同目录的新 JSON；避免破坏相对素材路径');
  need(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 500, '必须说明动效对应的叙事触发');
  const projection = buildTimelineProjection(input), source = assertProjectionSourceCurrent(projection, { requireDeclaredSha: true }).identity;
  need(source, '需要绑定 SHA 的主视频源');
  const plan = readJson(input), s = manifest.spec, fps = plan.output?.fps;
  need(fps === s.fps, '动效与时间线帧率必须一致；请按工程 fps 重新渲染');
  need(Number.isFinite(start) && start >= 0 && Math.abs(start * fps - Math.round(start * fps)) < 0.00001, 'start 必须为非负整帧时间');
  const end = start + manifest.frames / fps;
  const pictureEnd = Math.max(...projection.items.filter(i => i.type === 'picture').map(i => i.endTick)) / projection.timebase.ticksPerSecond;
  need(end <= pictureEnd + 0.000001, '动效超出主时间线；不能自动截断末尾文字');
  width ??= s.width; height ??= s.height;
  need([x, y, width, height].every(Number.isInteger) && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= plan.output.width && y + height <= plan.output.height && width * 9 === height * 16, '插入区域须在画布内且保持 16:9');
  const id = `wise-${receipt.video.sha256.slice(0, 12)}-${Math.round(start * fps)}`;
  need(!(plan.visual?.overlays ?? []).some(o => o.id === id), '相同动效已在此位置插入');
  plan.visual ??= {}; plan.visual.overlays ??= [];
  plan.visual.overlays.push({ id, ...receipt.video, kind: 'video', start, end, x, y, width, height, opacity: 1, provenance: { kind: 'generated_motion', provider: 'wise-motion', version: WISE_VERSION, receipt: fileIdentity(path.join(directory, 'receipt.json')), source: manifest.source, purpose: reason, factualEvidence: false, review: 'required' } });
  plan.mode = 'preview'; delete plan.contracts; delete plan.decisionPlan; delete plan.review;
  plan.output = { ...plan.output, path: `${out}.preview.mp4` };
  for (const key of ['dialogueStem', 'bgmStem', 'sfxStem', 'mixStem']) delete plan.output[key];
  plan.motionIntegration = { input: fileIdentity(input), status: 'candidate_requires_render_and_review', reason };
  checkIdentity(source); need(fileIdentity(input).sha256 === expectedSha, '插入期间原时间线已改变');
  exclusive(out, plan);
  return { status: 'candidate_requires_render_and_review', candidate: fileIdentity(out), original: fileIdentity(input), overlayId: id, render: ['timeline', 'render', '--plan', out] };
}
async function main(args) {
  const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
  const dir = opt('runtime', runtimeDefault()); let result;
  if (args[0] === 'setup') result = setupWiseMotion(dir);
  else if (args[0] === 'browser') { const r = runtime(dir); process.chdir(r.root); result = await r.require('@remotion/renderer').ensureBrowser({ logLevel: 'error' }); }
  else if (args[0] === 'doctor') result = { status: 'pass', ...runtimeIdentity(runtime(dir)) };
  else if (args[0] === 'search') result = await searchWiseMotion(opt('query', ''), dir);
  else if (args[0] === 'show') { const r = runtime(dir); result = (await api(r)).resolveEffect(opt('effect')); }
  else if (args[0] === 'render') result = await prepareWiseMotion({ spec: readJson(opt('spec')), output: opt('output'), runtimeDirectory: dir, browserExecutable: opt('browser') });
  else if (args[0] === 'worker') result = await renderWiseMotion(opt('package'), opt('manifest-sha'));
  else if (args[0] === 'status') {
    const root = path.resolve(opt('package'));
    result = fs.existsSync(path.join(root, 'receipt.json')) ? readMotionReceipt(root).receipt : JSON.parse(invoke(process.execPath, [path.join(scripts, 'kacha_jobs.mjs'), 'status', '@job:wise-render', '--project-root', root]));
  } else if (args[0] === 'attach') result = attachWiseMotion({ directory: opt('package'), timeline: opt('timeline'), expectedSha: opt('expected-sha'), output: opt('output'), start: Number(opt('start')), x: Number(opt('x', 0)), y: Number(opt('y', 0)), width: opt('width') === undefined ? undefined : Number(opt('width')), height: opt('height') === undefined ? undefined : Number(opt('height')), reason: opt('reason') });
  else throw Error('wise-motion setup|doctor|search|show|render|status|attach；详见 references/wise-motion.md');
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
