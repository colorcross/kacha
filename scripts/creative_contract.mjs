import fs from 'node:fs';
import path from 'node:path';
import { fileIdentity, readJson, sha256Value, ffprobe, run } from './kacha_utils.mjs';
import { need, digest, exclusive, checkIdentity } from './wise_motion_contract.mjs';
export { need, digest, exclusive, checkIdentity };
export const PROVIDERS = ['huashu-motion', 'huashu-art-motion', 'huashu-design', 'lemo-opuscar'];
export function canonicalDestination(file) {
  let parent = path.dirname(path.resolve(file));
  const tail = [path.basename(file)];
  while (!fs.existsSync(parent)) { tail.unshift(path.basename(parent)); parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), ...tail);
}
const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.DS_Store']);
export function treeIdentity(directory, { runtime = false } = {}) {
  const root = fs.realpathSync(directory), files = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(e.name) || (runtime && ['out', 'output', '.om'].includes(e.name))) continue;
      const f = path.join(dir, e.name);
      need(!e.isSymbolicLink(), `项目/运行时源不能含符号链接：${f}`);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) files.push({ path: path.relative(root, f), sha256: fileIdentity(f).sha256 });
    }
  }
  walk(root); need(files.length > 0, '空项目或运行时');
  return { root, sha256: sha256Value(files), files };
}
export function localFile(root, relative) {
  need(typeof relative === 'string' && relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), '文件必须为项目内相对路径');
  const file = fs.realpathSync(path.join(root, relative));
  need(file.startsWith(root + path.sep) && fs.statSync(file).isFile(), '文件必须位于项目目录内');
  return file;
}
export function validateCreative(plan) {
  need(plan?.schemaVersion === '1.0' && PROVIDERS.includes(plan.provider), '未知 creative schema/provider');
  need(['insert', 'standalone-visual', 'technical-fixture'].includes(plan.purpose), 'purpose 必须为 insert/standalone-visual/technical-fixture');
  need(typeof plan.reason === 'string' && plan.reason.trim().length > 0, '必须说明叙事用途');
  need(['native', 'external-output'].includes(plan.renderMode ?? 'native'), 'renderMode 必须为 native/external-output');
  need(['readcheck', 'no-screen-text'].includes(plan.textPolicy ?? 'readcheck'), 'textPolicy 无效');
  need(plan.textPolicy !== 'no-screen-text' || (typeof plan.textCheckOmissionReason === 'string' && plan.textCheckOmissionReason.trim().length > 0), '无屏上文字须明确说明，不把未检查记为通过');
  need(plan.audioPolicy === 'silent-visual-retain-original', '此桥接交付画面素材；显式 audioPolicy=silent-visual-retain-original');
  const g = plan.output;
  need(g && [g.width, g.height].every(v => Number.isInteger(v) && v >= 16 && v <= 3840 && v % 2 === 0), '画幅必须为 16–3840 偶数');
  need([24, 25, 30, 50, 60].includes(g.fps) && Number.isInteger(g.frames) && g.frames > 0 && g.frames <= g.fps * 600, '需明确帧率与精确帧数，单包最多 10 分钟');
  need(typeof g.transparent === 'boolean', 'transparent 必须为布尔值');
  need(!g.transparent || ['huashu-motion', 'huashu-art-motion'].includes(plan.provider), '当前后端未接入透明渲染');
  need(typeof plan.project === 'string' && path.isAbsolute(plan.project), 'project 必须为绝对路径');
  const root = fs.realpathSync(plan.project), entry = localFile(root, plan.entry);
  need(plan.renderMode === 'external-output' ? ['.html', '.js', '.json', '.mjs'].includes(path.extname(entry)) : path.extname(entry) === (plan.provider === 'huashu-art-motion' ? '.json' : '.html'), '入口扩展名与后端不匹配');
  need(plan.renderMode === 'external-output' || !['huashu-motion', 'lemo-opuscar'].includes(plan.provider) || plan.entry === 'index.html', '该后端入口必须为项目根 index.html');
  need(['treatment', 'rights', 'direction'].every(k => typeof plan.evidence?.[k] === 'string'), '缺少 treatment/rights/direction 证据');
  const docs = Object.keys(plan.evidence).map(k => {
    const file = localFile(root, plan.evidence?.[k]);
    need(fs.readFileSync(file, 'utf8').trim().length >= 20, `${k} 不能为空模板`);
    return fileIdentity(file);
  });
  need(['selected', 'existing-direction', 'mechanical-test'].includes(plan.directionStatus), '缺少真实方向决定');
  need(plan.directionStatus !== 'mechanical-test' || plan.purpose === 'technical-fixture', '机械测试豁免仅限 technical-fixture');
  const requiredFiles = [entry, ...docs.map(d => d.path)];
  if (plan.provider === 'huashu-art-motion' && plan.renderMode !== 'external-output') {
    const spec = readJson(entry);
    need(spec.width === g.width && spec.height === g.height && spec.fps === g.fps && Math.abs(spec.duration * g.fps - g.frames) < 1e-6, '片段 spec 与几何/帧数合同不一致');
    need(Boolean(spec.alpha) === g.transparent, 'spec alpha 与合同不一致');
    // All media must travel with the editable project. The native renderer permits URLs and
    // absolute files, but the bridge cannot freeze them, so fail closed here.
    const assetPath = ref => {
      need(typeof ref === 'string' && !path.isAbsolute(ref) && !ref.includes(':') && !ref.split(/[\\/]/).includes('..'), '片段素材必须为项目内相对路径');
      const resolved = fs.realpathSync(path.resolve(path.dirname(entry), ref));
      need(resolved.startsWith(root + path.sep), '片段素材必须位于项目目录内');
      return resolved;
    };
    const addFile = ref => {
      const resolved = assetPath(ref);
      need(fs.statSync(resolved).isFile(), '片段素材必须为项目内文件');
      requiredFiles.push(resolved);
    };
    const addFrameDirectory = ref => {
      const directory = assetPath(ref);
      need(fs.statSync(directory).isDirectory(), '帧序列必须为项目内目录');
      // Match native spec_assets.localize: only immediate image children are frames.
      const frames = fs.readdirSync(directory).filter(name => /\.(png|jpe?g|webp)$/i.test(name));
      need(frames.length > 0, '帧序列目录不能为空');
      for (const name of frames) addFile(path.relative(path.dirname(entry), path.join(directory, name)));
    };
    if (spec.data?.image) addFile(spec.data.image);
    for (const cue of spec.cues ?? []) {
      if (cue.image) addFile(cue.image);
      if (cue.frames !== undefined) {
        if (typeof cue.frames === 'string') addFrameDirectory(cue.frames);
        else {
          need(Array.isArray(cue.frames) && cue.frames.length > 0, 'frames 必须为非空路径数组或帧目录');
          cue.frames.forEach(addFile);
        }
      }
    }
    const character = spec.data?.character;
    if (character !== undefined) {
      if (typeof character === 'string') addFrameDirectory(character);
      else {
        const frames = character?.frames;
        if (typeof frames === 'string') addFrameDirectory(frames);
        else {
          need(frames && typeof frames === 'object' && !Array.isArray(frames) && Object.keys(frames).length > 0, '角色须提供非空姿势路径字典或帧目录');
          Object.values(frames).forEach(addFile);
        }
      }
    }
  }
  const source = treeIdentity(root);
  const frozenFiles = new Set(source.files.map(f => path.join(root, f.path)));
  for (const file of requiredFiles) need(frozenFiles.has(file), '入口、证据和素材不能放在被排除的依赖/缓存目录');
  return { plan: { ...plan, project: root }, source, documents: docs, entry: fileIdentity(entry) };
}
export function verifyCreativeVideo(file, geometry, { silent = true } = {}) {
  const initial = fileIdentity(file);
  const data = ffprobe(file), videos = data.streams.filter(s => s.codec_type === 'video');
  need(videos.length === 1, '需要单视频流');
  const v = videos[0], audio = data.streams.some(s => s.codec_type === 'audio');
  need(!silent || !audio, '动效须为单视频轨且无音频');
  need(v.width === geometry.width && v.height === geometry.height, '原件尺寸、帧率或帧数不匹配');
  const rotations = [v.tags?.rotate, ...(v.side_data_list ?? []).map(s => s.rotation)].filter(x => x !== undefined);
  need(rotations.every(x => Number.isFinite(Number(x)) && Number(x) % 360 === 0), '旋转标记会改变画面方向；先按显示方向导出无旋转标记的原件');
  need(!v.sample_aspect_ratio || ['N/A', '1:1'].includes(v.sample_aspect_ratio), '非方形像素会改变显示比例；先导出方形像素');
  need(Math.abs(Number(v.start_time ?? 0)) < 1e-5, '原件视频起点必须为零');
  need(!geometry.transparent || /yuva|rgba|argb/.test(v.pix_fmt), '原件缺少 alpha 通道');
  // Container averages can hide VFR and WebM often omits nb_frames. Validate the
  // actual presentation timeline, sorting PTS because B-frames arrive out of order.
  const result = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', file], { timeout: 120000 });
  need(result.status === 0, '无法核验逐帧时间戳');
  const packets = JSON.parse(result.stdout).packets ?? [];
  const pts = packets.map(p => ({ at: Number(p.pts_time), duration: Number(p.duration_time) })).sort((a, b) => a.at - b.at);
  const [tn, td] = String(v.time_base).split('/').map(Number);
  const tolerance = Math.min(0.1 / geometry.fps, (tn / td || 0) + 0.000002);
  need(pts.length === geometry.frames, '实际视频帧数不匹配');
  need(pts.every((p, i) => Number.isFinite(p.at) && Math.abs(p.at - i / geometry.fps) <= tolerance && (!Number.isFinite(p.duration) || Math.abs(p.duration - 1 / geometry.fps) <= tolerance)), '帧时间不均匀或时长不匹配；须按合同导出恒定帧率');
  checkIdentity(initial);
  return { width: v.width, height: v.height, fps: geometry.fps, frames: pts.length, audio, pixelFormat: v.pix_fmt, codec: v.codec_name, timing: 'packet_pts_verified' };
}
export function readCreativeReceipt(directory) {
  const root = fs.realpathSync(directory), receiptIdentity = fileIdentity(path.join(root, 'receipt.json')), receipt = readJson(receiptIdentity.path);
  need(receipt.kind === 'kacha-creative-receipt' && receipt.digest === digest(receipt) && receipt.status === 'rendered_requires_review', 'creative 回执无效');
  need(receipt.manifest?.path === path.join(root, 'creative.json'), '回执合同路径不匹配');
  for (const f of [receipt.manifest, receipt.video, receipt.original, ...(receipt.evidence ?? []), ...(receipt.execution?.logs ?? [])]) checkIdentity(f);
  const manifest = readJson(receipt.manifest.path);
  need(manifest.kind === 'kacha-creative-package' && manifest.digest === digest(manifest), 'creative 合同无效');
  need(receipt.video.path === path.join(root, manifest.plan.output.transparent ? 'visual.mov' : 'visual.mp4'), '视频包路径不匹配');
  need(receipt.evidence?.length >= 3, '缺少导演/许可/方向证据');
  need(treeIdentity(path.join(root, 'source')).sha256 === manifest.source.sha256, '已冻结的创作源发生变化');
  verifyCreativeVideo(receipt.video.path, manifest.plan.output);
  checkIdentity(receiptIdentity);
  return { root, receipt, manifest, receiptIdentity };
}
