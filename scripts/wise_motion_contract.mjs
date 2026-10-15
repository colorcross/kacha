import fs from 'node:fs';
import path from 'node:path';
import { fileIdentity, readJson, sha256Value, ffprobe } from './kacha_utils.mjs';

export const WISE_VERSION = '0.1.16';
export const WISE_EFFECTS = ['stagger-in', 'count-up', 'type-reveal', 'word-focus', 'title-content', 'interface-feedback', 'particle-word', 'word-slam', 'terminal-code', 'bar-growth', 'timeline-progress', 'button-press-status'];
export const need = (test, message) => { if (!test) throw Error(message); };
export function checkIdentity(identity) {
  need(identity?.path && identity.sha256 && fileIdentity(identity.path).sha256 === identity.sha256, `文件身份已变化：${identity?.path}`);
}
export function digest(value) { const copy = structuredClone(value); delete copy.digest; return sha256Value(copy); }
export function exclusive(file, value) { fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
export function validateSpec(spec) {
  need(spec && typeof spec === 'object' && !Array.isArray(spec), 'spec 必须为对象');
  const fields = ['effectId', 'content', 'speed', 'theme', 'transparent', 'width', 'height', 'fps'];
  need(Object.keys(spec).every(k => fields.includes(k)), 'spec 含未支持字段；不允许远程素材、音频或任意脚本');
  need(WISE_EFFECTS.includes(spec.effectId), '该效果未接入渲染；使用 search/show 检查候选');
  need(spec.content && typeof spec.content === 'object' && !Array.isArray(spec.content) && Object.keys(spec.content).length, '必须明确提供 content，避免把演示文案当节目事实');
  const s = { speed: 1, theme: 'dark', transparent: false, width: 1280, height: 720, fps: 25, ...spec };
  need(Number.isFinite(s.speed) && s.speed >= 0.5 && s.speed <= 2, 'speed 必须为 0.5–2');
  need(['dark', 'light'].includes(s.theme), 'theme 必须为 dark 或 light');
  need(typeof s.transparent === 'boolean', 'transparent 必须为 boolean');
  need(!s.transparent || ['type-reveal', 'count-up', 'word-focus'].includes(s.effectId), '此效果未开放透明输出');
  need([s.width, s.height].every(v => Number.isInteger(v) && v >= 16 && v <= 3840 && v % 2 === 0), '尺寸必须为 16–3840 的偶数');
  need(s.width * 9 === s.height * 16, '上游为固定 16:9 画板；竖屏请以局部卡片插入，不能拉伸或假称自适应');
  need([24, 25, 30, 50, 60].includes(s.fps), 'fps 必须为 24/25/30/50/60');
  return s;
}
export function verifyMedia(file, expected) {
  const data = ffprobe(file), video = data.streams.filter(s => s.codec_type === 'video');
  need(video.length === 1 && !data.streams.some(s => s.codec_type === 'audio'), '动效须为单视频轨且无音频');
  const v = video[0], [a, b = 1] = String(v.avg_frame_rate).split('/').map(Number);
  need(v.width === expected.width && v.height === expected.height && Math.abs(a / b - expected.fps) < 0.00001 && Number(v.nb_frames) === expected.frames, '动效尺寸、帧率或帧数不匹配');
  need(Math.abs(Number(v.start_time ?? 0)) < 0.00001, '动效视频起点必须为零');
  need(!expected.transparent || /yuva|rgba|argb/.test(v.pix_fmt), '透明输出缺少 alpha 通道');
  return { width: v.width, height: v.height, fps: a / b, frames: Number(v.nb_frames), pixelFormat: v.pix_fmt, audio: false };
}
export function readMotionReceipt(directory) {
  const root = fs.realpathSync(directory), receipt = readJson(path.join(root, 'receipt.json'));
  need(receipt.kind === 'kacha-wise-motion-render' && receipt.digest === digest(receipt), '动效渲染回执失效');
  need(receipt.status === 'rendered_requires_review', '动效尚未成功渲染');
  checkIdentity(receipt.manifest); checkIdentity(receipt.video);
  const manifest = readJson(receipt.manifest.path);
  need(manifest.digest === digest(manifest) && receipt.manifest.path === path.join(root, 'motion.json') && receipt.video.path === path.join(root, manifest.spec.transparent ? 'motion.mov' : 'motion.mp4'), '动效包路径或合同失效');
  for (const f of receipt.notices ?? []) checkIdentity(f);
  need(receipt.notices?.length >= 2, '缺少上游授权记录');
  verifyMedia(receipt.video.path, { ...manifest.spec, frames: manifest.frames });
  return { root, receipt, manifest };
}
