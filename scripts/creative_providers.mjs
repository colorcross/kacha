import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileIdentity, readJson } from './kacha_utils.mjs';
import { PROVIDERS, need, treeIdentity } from './creative_contract.mjs';
const exists = f => !!f && fs.existsSync(f);
function cachedPackage(name) {
  const base = path.join(os.homedir(), '.npm/_npx');
  return exists(base) ? fs.readdirSync(base).sort().map(d => path.join(base, d, 'node_modules', name)).find(d => exists(path.join(d, 'package.json'))) : null;
}
function skillRoot(id) {
  const override = process.env[`KACHA_${id.toUpperCase().replaceAll('-', '_')}_HOME`];
  return override || [path.join(os.homedir(), '.codex/skills', id), path.join(os.homedir(), '.claude/skills', id)].find(d => exists(path.join(d, 'SKILL.md')));
}
export function providerRuntime(id) {
  need(PROVIDERS.includes(id), '未知 provider');
  const skill = skillRoot(id);
  const root = id === 'lemo-opuscar' ? (process.env.LEMO_OPUSCAR_HOME || path.join(os.homedir(), 'lemo-opuscar'))
    : id === 'huashu-motion' ? (process.env.KACHA_HUASHU_MOTION_RUNTIME || cachedPackage('huashu-motion')) : skill;
  const entry = ({ 'huashu-motion': 'cli/om.js', 'huashu-art-motion': 'scripts/engine/render.py', 'huashu-design': 'scripts/render-video-seek.js', 'lemo-opuscar': 'core/render/video.mjs' })[id];
  const playwright = cachedPackage('playwright');
  const modules = process.env.KACHA_CREATIVE_NODE_MODULES || (playwright && path.dirname(playwright));
  let python = null, pythonModule = null, pillowModule = null;
  if (['huashu-art-motion', 'huashu-design'].includes(id)) {
    const pillow = id === 'huashu-design';
    // The main CLI prepends its managed audio Python. Discover a compatible
    // installed interpreter without changing that environment or installing packages.
    const candidates = process.env.KACHA_CREATIVE_PYTHON ? [process.env.KACHA_CREATIVE_PYTHON]
      : [...new Set((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(p => path.resolve(p, 'python3')).filter(exists))];
    for (const candidate of candidates) {
      const probe = spawnSync(candidate, ['-c', `import sys,playwright${pillow ? ',PIL' : ''}; print(sys.executable); print(next(iter(playwright.__path__)))${pillow ? '; print(next(iter(PIL.__path__)))' : ''}`], { encoding: 'utf8', timeout: 10000 });
      if (probe.status === 0) { [python, pythonModule, pillowModule = null] = probe.stdout.trim().split('\n'); break; }
    }
  }
  return { id, skill, root, entry: root && path.join(root, entry), modules, python, pythonModule, pillowModule };
}
function nodeDependencies(r) {
  if (r.id === 'lemo-opuscar') return ['playwright-core', 'three'].map(p => path.join(r.root || '', 'node_modules', p));
  if (r.id === 'huashu-design') return ['playwright', 'playwright-core'].map(p => r.modules && path.join(r.modules, p));
  return [];
}
export function runtimeMissing(r) {
  return [...(!exists(r.entry) ? ['native renderer'] : []),
    ...nodeDependencies(r).flatMap((p, i) => exists(p && path.join(p, 'package.json')) ? [] : [`Node dependency ${p || ['playwright', 'playwright-core'][i]}`]),
    ...(['huashu-art-motion', 'huashu-design'].includes(r.id) && (!r.python || !r.pythonModule || (r.id === 'huashu-design' && !r.pillowModule)) ? ['Python with playwright' + (r.id === 'huashu-design' ? ' and pillow' : '') + '; KACHA_CREATIVE_PYTHON'] : [])];
}
export function runtimeIdentity(r) {
  const missing = runtimeMissing(r);
  need(!missing.length, `${r.id} 缺少本地运行时：${missing.join(', ')}；先按原 skill 安装，不自动下载`);
  // Includes renderer helpers, fonts and implementation; excludes output/cache/dependency trees.
  const identity = { id: r.id, root: fs.realpathSync(r.root), source: treeIdentity(r.root, { runtime: true }), node: fileIdentity(process.execPath) };
  const locks = ['package.json', 'package-lock.json', 'requirements.txt'].map(f => path.join(r.root, f)).filter(exists);
  identity.dependencies = locks.map(fileIdentity);
  if (r.modules && exists(path.join(r.modules, 'playwright/package.json'))) identity.dependencies.push(fileIdentity(path.join(r.modules, 'playwright/package.json')));
  if (r.python) identity.python = fileIdentity(fs.realpathSync(r.python));
  if (r.pythonModule) identity.pythonModule = treeIdentity(r.pythonModule);
  if (r.pillowModule) identity.pillowModule = treeIdentity(r.pillowModule);
  identity.nodeModules = nodeDependencies(r).map(p => treeIdentity(p, { runtime: true }));
  return identity;
}
export function creativeDoctor() {
  const command = name => spawnSync(name, [name.startsWith('ff') ? '-version' : '--version'], { encoding: 'utf8', timeout: 10000 }).status === 0;
  return { status: 'inventory_only', ffmpeg: command('ffmpeg'), ffprobe: command('ffprobe'), node: process.version,
    providers: PROVIDERS.map(id => { const r = providerRuntime(id); return { ...r, installed: exists(r.entry), renderVerified: false,
      missing: runtimeMissing(r) }; }) };
}
export function creativeCatalog(query = '') {
  const purposes = { 'huashu-motion': '产品 UI 连续演示 发布片 透明包装 语义动效', 'huashu-art-motion': '口播 图解 原理 白板 图表 艺术镜头', 'huashu-design': '品牌 方向板 信息图 视觉 排版 导演稿', 'lemo-opuscar': '风格短片 3D 材质 实证 数据 档案' };
  const rows = PROVIDERS.map(id => ({ summary: purposes[id], provider: id, id, kind: 'workflow', path: providerRuntime(id).skill && path.join(providerRuntime(id).skill, 'SKILL.md'), renderSupport: 'adapter' }));
  const art = providerRuntime('huashu-art-motion');
  if (exists(art.root)) {
    const schema = path.join(art.root, 'scripts/engine/clip_schema.json');
    if (exists(schema)) for (const [id, detail] of Object.entries(readJson(schema).grammars)) rows.push({ provider: art.id, id, kind: 'grammar', path: schema, renderSupport: exists(path.join(art.root, 'scripts/engine/clips', `${id}.js`)) ? 'native-spec' : 'reference-only', cues: detail.kinds });
    const dir = path.join(art.root, 'references/风格配方');
    if (exists(dir)) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) rows.push({ provider: art.id, id: f.slice(0, -3), kind: 'style-reference', title: fs.readFileSync(path.join(dir, f), 'utf8').split('\n').find(l => l.startsWith('# '))?.slice(2), path: path.join(dir, f), renderSupport: 'authoring-required' });
  }
  const lemo = providerRuntime('lemo-opuscar'), styles = lemo.root && path.join(lemo.root, 'styles');
  if (exists(styles)) for (const id of fs.readdirSync(styles)) {
    const f = path.join(styles, id, 'STYLE.md');
    if (exists(f)) rows.push({ provider: lemo.id, id, kind: 'style-reference', path: f, renderSupport: 'authoring-required', title: fs.readFileSync(f, 'utf8').split('\n').find(l => l.startsWith('# '))?.slice(2) });
  }
  const motion = providerRuntime('huashu-motion'), library = motion.skill && path.join(motion.skill, 'references/library');
  if (exists(library)) for (const f of fs.readdirSync(library).filter(f => f.endsWith('.md'))) rows.push({ provider: motion.id, id: f.slice(0, -3), kind: 'motion-language', path: path.join(library, f), renderSupport: 'authoring-required' });
  return { status: 'discovered_not_quality_verified', entries: rows.filter(row => JSON.stringify(row).toLowerCase().includes(query.toLowerCase())) };
}
// Native commands are fixed argv, never a shell command supplied by a plan.
export function renderCommands(plan, r, work, raw) {
  const g = plan.output, entry = path.join(work, plan.entry), duration = g.frames / g.fps;
  const node = (args, name) => ({ command: process.execPath, args, name, cwd: r.root });
  if (r.id === 'huashu-motion') return [node([r.entry, 'check', work], 'check'), node([r.entry, 'render', work, '--fps', String(g.fps), '--workers', '1', '--silent', '--out', raw, ...(g.transparent ? ['--transparent'] : [])], 'render'), node([r.entry, 'qa', raw, '--json'], 'qa')];
  if (r.id === 'huashu-art-motion') {
    need(r.python, '缺少带 Playwright 的 Python；配置 KACHA_CREATIVE_PYTHON');
    const py = (args, name) => ({ command: r.python, args, name, cwd: work });
    return [py([path.join(r.root, 'scripts/clip_lint.py'), entry], 'lint'), py([r.entry, '--spec', entry, '--audit', path.join(work, 'layout-audit.json')], 'audit'), py([r.entry, '--spec', entry, '--out', raw, ...(g.transparent ? ['--alpha'] : [])], 'render')];
  }
  if (r.id === 'huashu-design') {
    need(r.modules && r.python, '缺少 Playwright/Python；配置 KACHA_CREATIVE_NODE_MODULES / KACHA_CREATIVE_PYTHON');
    return [{ command: r.python, args: [path.join(r.root, 'scripts/design_lint.py'), 'check', entry, '--viewport', `${g.width}x${g.height}`], name: 'design-lint', cwd: work }, node([r.entry, entry, `--duration=${duration}`, `--fps=${g.fps}`, `--width=${g.width}`, `--height=${g.height}`, '--concurrency=1', '--keep-chrome'], 'render')];
  }
  return [...(plan.textPolicy === 'no-screen-text' ? [] : [node([path.join(r.root, 'core/render/readcheck.mjs'), work, '--size', `${g.width}x${g.height}`], 'readcheck')]), node([r.entry, work, '--fps', String(g.fps), '--workers', '1', '--size', `${g.width}x${g.height}`, '--out', raw], 'render')];
}
