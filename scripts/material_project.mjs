import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireFileLock, fileIdentity, fileIdentityMatches, mediaSummary, readJson, run, sha256File, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";
import { resolveContainedPath } from "./agent_workspace_utils.mjs";
import { resolveDesignSystem } from "./design_system.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";
import { resolveProductionSelection, productionStyleProfile } from "./production_pack.mjs";
import { buildDirectorPlan } from "./kacha_intelligence.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const marker = ".kacha/material-project.json";
const images = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff", ".bmp"]);
const videos = new Set([".mp4", ".mov", ".mkv", ".m4v", ".webm", ".avi", ".mts", ".m2ts"]);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const numeric = (value) => typeof value === "number" && Number.isFinite(value);
const json = (file, value) => writeJsonAtomic(file, value);
function immutableJson(file, value) {
  if (fs.existsSync(file)) {
    if (sha256Value(readJson(file)) !== sha256Value(value)) throw new Error(`拒绝覆盖已有版本：${file}`);
  } else json(file, value);
}
function freshTemporary(root, file) {
  const resolved = resolveContainedPath(root, file);
  if (fs.existsSync(resolved)) throw new Error(`临时文件已存在，拒绝覆盖或清理：${resolved}`);
  return resolved;
}
function guardProjectPaths(root) {
  for (const entry of [marker, ".kacha/material-project.lock", ".kacha/material-submit.lock", ".kacha/material-active-plan.json", ".kacha/material-clips", ".kacha/material-job.json", "contracts", "previews", "output"]) {
    resolveContainedPath(root, path.join(root, entry));
  }
}
const command = (name, args, options = {}) => {
  const result = run(name, args, options);
  if (result.status !== 0) throw new Error(`${name} 失败：${result.stderr || result.stdout}`);
  return result;
};
const cli = (name, args) => command(process.execPath, [path.join(scripts, name), ...args]);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const signed = (value) => ({ ...value, digest: sha256Value(value) });
function verifySigned(value, label) {
  const copy = { ...value }; delete copy.digest;
  if (value.digest !== sha256Value(copy)) throw new Error(`${label} 摘要已失效`);
}
function current(identity) { return Boolean(identity?.path && fileIdentityMatches(identity.path, identity)); }
export function isMaterialProject(root) { return Boolean(root && fs.existsSync(path.join(path.resolve(root), marker))); }
function load(root) {
  root = fs.realpathSync(path.resolve(root));
  guardProjectPaths(root);
  const project = readJson(path.join(root, marker)); verifySigned(project, "素材项目");
  if (project.projectRoot !== root || project.kind !== "kacha_material_project") throw new Error("素材项目路径或类型不匹配");
  for (const asset of project.assets) if (!current(asset.identity)) throw new Error(`素材已变化或丢失：${asset.path}`);
  return { root, project };
}
function runtimeCheck(project, runtime) {
  if (project.development) return;
  if (!runtime?.productionReady || project.runtimeRef !== runtime.sourceRef || (project.runtimeBundleDigest && project.runtimeBundleDigest !== runtime.bundleDigest)) throw new Error("运行版本与素材项目冻结版本不一致，或双端安装未就绪；请在当前安装中重新建立项目");
}
function collect(inputs, outputRoot) {
  const paths = new Set(); const skipped = []; let visited = 0;
  function visit(file, explicit = false) {
    if (++visited > 10000) throw new Error("素材目录超过 10000 个条目，请缩小导入范围");
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) { skipped.push({ path: file, reason: "symlink_not_followed" }); return; }
    if (stat.isDirectory()) {
      if (inside(outputRoot, path.resolve(file))) { skipped.push({ path: file, reason: "project_output_excluded" }); return; }
      for (const name of fs.readdirSync(file).sort()) {
        if (name.startsWith(".")) continue;
        visit(path.join(file, name));
      }
    } else if (stat.isFile()) {
      if (!images.has(path.extname(file).toLowerCase()) && !videos.has(path.extname(file).toLowerCase())) {
        if (explicit) throw new Error(`不支持的素材格式：${file}`);
        skipped.push({ path: file, reason: "unsupported_format" }); return;
      }
      paths.add(fs.realpathSync(file));
      if (paths.size > 500) throw new Error("单项目最多导入 500 个素材，请分批建立项目");
    }
  }
  for (const input of inputs) visit(path.resolve(input), true);
  if (!paths.size) throw new Error("没有找到可用的视频或图片");
  return { paths: [...paths].sort(), skipped };
}

export function initializeMaterialProject({ materials, requirements, projectRoot, projectId = "material-film", duration = 60,
  aspect = "16:9", fps = 25, width = null, pack = null, show = null, style = null, development = false,
  confirmExecute = false, runtime } = {}) {
  const selection = resolveProductionSelection(pack, show ?? (!pack || pack === "clean-editorial" ? "montage" : null));
  pack = selection.packId; show = selection.showId;
  if (pack === "dahui-ai") throw new Error("大灰AI素材项目需要节目证据合同，请使用 source-edit 入口");
  style ??= pack === "clean-editorial" ? productionStyleProfile(pack) : "light-warm-overlay";
  if (pack === "clean-editorial" && style !== "clean-editorial") throw new Error("通用素材项目需使用 clean-editorial 样式");
  if (!Array.isArray(materials) || !materials.length || !materials.every(text)) throw new Error("请提供素材文件或目录");
  if (!text(requirements) || requirements.length > 20000) throw new Error("剪辑要求必须是 1–20000 字的文本");
  if (!text(projectRoot)) throw new Error("素材成片需要独立 --project-root");
  if (!numeric(duration) || duration < 1 || duration > 3600) throw new Error("目标时长须为 1–3600 秒");
  if (![24, 25, 30, 50, 60].includes(fps)) throw new Error("帧率须为 24/25/30/50/60");
  const ratios = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350] };
  if (!ratios[aspect]) throw new Error("画幅须为 16:9、9:16、1:1 或 4:5");
  const geometry = ratios[aspect];
  if (width !== null) {
    if (!Number.isInteger(width) || width < 160 || width > 1920 || width % 2) throw new Error("宽度须为 160–1920 的偶数");
    geometry[1] = Math.round(geometry[1] * width / geometry[0] / 2) * 2; geometry[0] = width;
  }
  const requestedRoot = path.resolve(projectRoot);
  if (fs.existsSync(requestedRoot) && (!fs.statSync(requestedRoot).isDirectory() || fs.readdirSync(requestedRoot).length)) throw new Error("素材项目必须使用新的空目录，避免覆盖现有工程");
  const inventory = collect(materials, requestedRoot);
  if (inventory.paths.some((file) => inside(requestedRoot, file))) throw new Error("输出目录不能包含输入素材");
  const assets = inventory.paths.map((file) => {
    const kind = images.has(path.extname(file).toLowerCase()) ? "image" : "video";
    const summary = mediaSummary(file);
    if (["smpte2084", "arib-std-b67"].includes(summary.video?.color_transfer)) throw new Error(`素材使用 HDR 传递曲线，须先明确转换为 SDR 后再导入，不能直接降为 8 位：${file}`);
    if (!summary.video || !summary.width || !summary.height || (kind === "video" && !(summary.videoDuration > 0))) throw new Error(`素材无法解码或缺少有效视频轨：${file}`);
    const identity = fileIdentity(file);
    return { id: `asset-${sha256Value({ path: file, sha256: identity.sha256 }).slice(0, 16)}`, path: file, identity, kind,
      width: summary.width, height: summary.height, duration: kind === "video" ? summary.videoDuration : null,
      hasAudio: Boolean(summary.audio), fps: kind === "video" ? summary.fps : null,
      description: null, contentUnderstanding: "requires_agent_inspection", sourceAuthority: "user_provided_local_edit_only" };
  });
  runtimeCheck({ development, runtimeRef: runtime?.sourceRef }, runtime);
  fs.mkdirSync(requestedRoot, { recursive: true }); const root = fs.realpathSync(requestedRoot);
  fs.mkdirSync(path.join(root, ".kacha"), { recursive: true }); fs.mkdirSync(path.join(root, "contracts"));
  fs.writeFileSync(path.join(root, ".gitignore"), ".kacha/\noutput/\npreviews/\n");
  json(path.join(root, "kacha.config.json"), {
    schemaVersion: "1.0", style: { system: "dahui-video-system", profile: productionStyleProfile(pack), modes: { show }, overrides: {} },
    editingDefaults: { parameters: { audio: { bgm: { enabled: false } } } },
  });
  const brief = signed({ schemaVersion: "1.0", kind: "kacha_material_brief", requirements: requirements.trim(),
    target: { durationSeconds: Math.round(duration * fps) / fps, fps, width: geometry[0], height: geometry[1], aspect },
    principles: ["根据实际内容选择镜头，不以文件名冒充内容理解", "保留因果、否定与完整说话语义", "默认完整适配画面，裁切必须注明依据", "只做本地候选，保留人工成片审阅"] });
  json(path.join(root, "contracts/material-brief.json"), brief);
  const project = signed({ schemaVersion: "1.0", kind: "kacha_material_project", projectRoot: root, projectId,
    task: "material_edit", brief: fileIdentity(path.join(root, "contracts/material-brief.json")), assets, skipped: inventory.skipped,
    runtimeRef: runtime?.sourceRef ?? null, runtimeBundleDigest: runtime?.bundleDigest ?? null, development, confirmExecute, productionPack: pack, show, style, createdAt: new Date().toISOString() });
  json(path.join(root, marker), project);
  json(path.join(root, "contracts/storyboard-template.json"), { schemaVersion: "1.0", kind: "kacha_material_storyboard",
    projectDigest: project.digest, briefDigest: brief.digest, interpretation: "填写对用户要求的具体理解",
    requirements: [{ id: "requirement-1", text: "逐条拆解用户要求", check: "semantic", assetIds: [] }],
    segments: [], notes: "由 Agent 读取实际素材后填写，不能将空模板作为成片方案" });
  json(path.join(root, ".kacha/material-agent-packet.json"), { project: fileIdentity(path.join(root, marker)), brief,
    assets, next: "先提取代表帧、按需转写并审阅素材；填写分镜，再调用 materials compose。用户只需提供素材和要求，不需编辑 JSON。",
    tools: ["materials inspect --project-root DIR --asset ID", "transcribe", "transcript", "visual-evidence-watch"],
    storyboardTemplate: path.join(root, "contracts/storyboard-template.json") });
  return materialProjectStatus(root);
}

function checkFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} 包含不支持的字段：${unknown.join(", ")}；请使用已实现的分镜参数`);
}
function validateInspection(project, asset, evidence) {
  verifySigned(evidence, "素材审阅帧");
  if (evidence.kind !== "kacha_material_inspection" || evidence.assetId !== asset.id
    || sha256Value(evidence.source) !== sha256Value(asset.identity) || !current(evidence.source)
    || !Array.isArray(evidence.frames) || !evidence.frames.length) throw new Error("素材审阅帧已失效或为空");
  const seen = new Set();
  for (const frame of evidence.frames) {
    const directory = path.join(project.projectRoot, "previews", asset.id);
    if (!numeric(frame.time) || frame.time < 0 || (asset.kind === "image" ? frame.time !== 0 : frame.time >= asset.duration)
      || seen.has(frame.time) || !text(frame.path) || !inside(directory, frame.path)
      || !current(frame)) throw new Error("素材审阅帧已失效或越界");
    resolveContainedPath(project.projectRoot, frame.path); seen.add(frame.time);
  }
}
export function inspectMaterial(root, assetId, { timestamps = [] } = {}) {
  const loaded = load(root); root = loaded.root; const { project } = loaded;
  const unlock = acquireFileLock(path.join(root, ".kacha/material-project.lock"), { purpose: "inspect-materials" });
  try {
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) throw new Error("未知素材 ID");
    const dir = resolveContainedPath(root, path.join(root, "previews", asset.id)); fs.mkdirSync(dir, { recursive: true });
    let times = asset.kind === "image" ? [0] : [.1, .5, .9].map((fraction) => Math.max(0, Math.min(asset.duration - .05, asset.duration * fraction)));
    if (!Array.isArray(timestamps) || timestamps.length > 12 || timestamps.some((time) => !numeric(time) || time < 0 || (asset.kind === "image" ? time !== 0 : time >= asset.duration))) throw new Error("抽帧时间超出素材范围或超过 12 帧");
    if (timestamps.length) times = [...new Set(timestamps)];
    const previousFile = resolveContainedPath(root, path.join(dir, "inspection.json"));
    const previous = fs.existsSync(previousFile) ? readJson(previousFile) : null;
    if (previous) validateInspection(project, asset, previous);
    const allFrames = [...(previous?.frames ?? [])];
    for (const time of times) {
      if (allFrames.some((frame) => frame.time === time)) continue;
      // The exact timestamp hash avoids sub-microsecond filename collisions.
      const file = resolveContainedPath(root, path.join(dir, `${asset.identity.sha256.slice(0, 12)}-${sha256Value(time).slice(0, 16)}.jpg`));
      if (fs.existsSync(file)) throw new Error("审阅帧缺少归属记录，拒绝接纳已有文件");
      const temporary = freshTemporary(root, path.join(dir, `frame-${process.pid}.partial.jpg`));
      try {
        command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", ...(asset.kind === "video" ? ["-ss", String(time)] : []), "-i", asset.path,
          "-frames:v", "1", "-vf", "scale=w='max(2,trunc(iw*if(gt(sar,0),sar,1)/2)*2)':h=ih,setsar=1,scale=960:960:force_original_aspect_ratio=decrease", "-update", "1", temporary]);
        if (!fs.existsSync(temporary) || !fs.statSync(temporary).size) throw new Error("未能提取有效审阅帧");
        fs.renameSync(temporary, file);
        allFrames.push({ time, ...fileIdentity(file) });
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    if (!current(asset.identity)) throw new Error("抽帧期间源素材变化");
    allFrames.sort((a, b) => a.time - b.time);
    const evidence = signed({ kind: "kacha_material_inspection", assetId, source: asset.identity, frames: allFrames,
      audioPresent: asset.hasAudio, boundary: "代表帧仅供 Agent 查看，不代表已经理解全片或听过人声；有对白须转写并核对选段" });
    const snapshot = resolveContainedPath(root, path.join(dir, `inspection-${evidence.digest}.json`));
    immutableJson(snapshot, evidence);
    if (!previous || previous.digest !== evidence.digest) json(previousFile, evidence);
    return evidence;
  } finally { unlock(); }
}

function subtitleContract(root, segments) {
  if (!segments.some((segment) => segment.caption)) return null;
  const loaded = loadKachaConfig({ args: [], anchorPath: root, includeSecrets: false });
  const design = resolveDesignSystem(loaded.config.style);
  const role = design.style.typography.subtitlePrimary;
  const sizeRatio = role.sizeRatio ?? .042;
  if (!numeric(sizeRatio) || sizeRatio <= 0 || sizeRatio > .2) throw new Error("字幕字号比例无效");
  const font = design.fonts.roles.subtitlePrimary;
  let file = role.fontFile ? path.resolve(scripts, "..", role.fontFile) : null;
  if (!file && font.verified) {
    const matcher = ["/opt/homebrew/bin/fc-match", "/usr/local/bin/fc-match", "/usr/bin/fc-match"].find(file => fs.existsSync(file)) ?? "fc-match";
    file = command(matcher, ["--format", "%{file}", font.resolved]).stdout.trim();
  }
  if (file) {
    if (!fs.existsSync(file) || (role.fontFile && (!/^[a-f0-9]{64}$/.test(role.fontSha256 ?? "") || sha256File(file) !== role.fontSha256))) throw new Error("字幕字体文件缺失或 SHA-256 不匹配，请修复字体配置后重新编排");
    const scanner = ["/opt/homebrew/bin/fc-scan", "/usr/local/bin/fc-scan", "/usr/bin/fc-scan"].find((file) => fs.existsSync(file)) ?? "fc-scan";
    const families = command(scanner, ["--format", "%{family}\n", file]).stdout.split(/[,\r\n]/).map((name) => name.replaceAll("\\-", "-").trim());
    const family = role.families.find((name) => families.includes(name));
    if (!family) throw new Error("字幕字体文件内部名称与品牌配置不一致");
    return { family, sizeRatio, source: fileIdentity(file) };
  }
  throw new Error("字幕字体文件尚未验证，请配置字体文件或安装所选字体后重试");
}

function validateStoryboard(project, brief, storyboard, { frozen = false } = {}) {
  checkFields(storyboard, ["schemaVersion", "kind", "projectDigest", "briefDigest", "interpretation", "requirements", "segments", "notes", "soundtrack",
    ...(frozen ? ["target", "unselected", "quality", "digest", "subtitle"] : [])], "分镜");
  if (storyboard.schemaVersion !== "1.0" || storyboard.kind !== "kacha_material_storyboard"
    || storyboard.projectDigest !== project.digest || storyboard.briefDigest !== brief.digest) throw new Error("分镜未绑定当前素材与剪辑要求");
  if (!text(storyboard.interpretation)) throw new Error("分镜缺少对剪辑要求的理解");
  if (!Array.isArray(storyboard.requirements) || !storyboard.requirements.length) throw new Error("请逐条登记剪辑要求及覆盖关系");
  if (!Array.isArray(storyboard.segments) || !storyboard.segments.length || storyboard.segments.length > 500) throw new Error("分镜需要 1–500 个镜头");
  const ids = new Set(); const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const rules = new Map();
  for (const requirement of storyboard.requirements) {
    checkFields(requirement, ["id", "text", "check", "assetIds"], "剪辑要求");
    if (!text(requirement.id) || rules.has(requirement.id) || !text(requirement.text)
      || !["semantic", "include_assets", "exclude_assets"].includes(requirement.check)
      || !Array.isArray(requirement.assetIds) || requirement.assetIds.some((id) => !assets.has(id))) throw new Error("剪辑要求的 ID、检查类型或素材引用无效");
    if (requirement.check !== "semantic" && !requirement.assetIds.length) throw new Error("包含/排除要求必须指定素材");
    rules.set(requirement.id, requirement);
  }
  let cursorFrames = 0;
  const segments = storyboard.segments.map((segment) => {
    checkFields(segment, ["id", "assetId", "sourceIn", "duration", "fit", "audio", "role", "reason", "observation", "satisfies", "caption", "cropReason", "muteReason",
      ...(frozen ? ["frames", "start", "end", "source", "kind", "hasAudio", "inspection"] : [])], "镜头");
    const asset = assets.get(segment.assetId);
    if (!text(segment.id) || !/^[a-zA-Z0-9_-]+$/.test(segment.id) || ids.has(segment.id) || !asset) throw new Error("镜头 ID 重复/无效或引用未知素材");
    ids.add(segment.id);
    if (!numeric(segment.duration) || segment.duration < .2 || segment.duration > 600) throw new Error(`${segment.id} 时长须为 0.2–600 秒`);
    const frames = Math.round(segment.duration * brief.target.fps); const duration = frames / brief.target.fps;
    const sourceIn = segment.sourceIn ?? 0;
    if (!numeric(sourceIn) || sourceIn < 0 || (asset.kind === "image" && sourceIn !== 0)
      || (asset.kind === "video" && sourceIn + duration > asset.duration + .0001)) throw new Error(`${segment.id} 选段超出素材边界`);
    if (!["contain", "cover"].includes(segment.fit) || !["source", "mute"].includes(segment.audio)) throw new Error(`${segment.id} 必须声明 fit 和 audio`);
    if (segment.fit === "cover" && !text(segment.cropReason)) throw new Error(`${segment.id} 裁切缺少主体安全依据`);
    if (asset.hasAudio && segment.audio === "mute" && !text(segment.muteReason)) throw new Error(`${segment.id} 静音缺少理由`);
    if (!text(segment.reason) || !text(segment.observation) || !text(segment.role)) throw new Error(`${segment.id} 缺少实际内容观察、叙事作用或选用理由`);
    if (!Array.isArray(segment.satisfies) || segment.satisfies.some((id) => !rules.has(id))) throw new Error(`${segment.id} 要求覆盖引用无效`);
    if (segment.caption !== undefined && (!text(segment.caption) || [...segment.caption].length > 60)) throw new Error(`${segment.id} 字幕须为 1–60 字`);
    if (segment.caption && duration < Math.max(1.2, [...segment.caption.replace(/\s/g, "")].length / 5 + .4)) throw new Error(`${segment.id} 字幕停留不足，需减字或选更长区间`);
    const directory = path.join(project.projectRoot, "previews", asset.id);
    let inspected = frozen ? segment.inspection?.path : path.join(directory, "inspection.json");
    if (!text(inspected) || !inside(directory, inspected)) throw new Error(`${segment.id} 审阅帧身份缺失或越界`);
    inspected = resolveContainedPath(project.projectRoot, inspected);
    if (!fs.existsSync(inspected)) throw new Error(`${segment.id} 尚未提取审阅帧，请先 materials inspect`);
    if (frozen && !current(segment.inspection)) throw new Error(`${segment.id} 审阅帧已失效`);
    const evidence = readJson(inspected); validateInspection(project, asset, evidence);
    if (!frozen) {
      inspected = resolveContainedPath(project.projectRoot, path.join(directory, `inspection-${evidence.digest}.json`));
      immutableJson(inspected, evidence);
    }
    if (asset.kind === "video" && !evidence.frames.some((frame) => frame.time >= sourceIn && frame.time < sourceIn + duration)) throw new Error(`${segment.id} 没有选段内的审阅帧，请用 --timestamp 补充`);
    const start = cursorFrames / brief.target.fps; cursorFrames += frames;
    return { ...segment, sourceIn, duration, frames, start, end: cursorFrames / brief.target.fps, source: asset.identity, kind: asset.kind, hasAudio: asset.hasAudio,
      inspection: fileIdentity(inspected) };
  });
  if (cursorFrames !== Math.round(brief.target.durationSeconds * brief.target.fps)) throw new Error("分镜总时长与目标时长不一致：各镜头按帧舍入后，总帧数须与目标完全一致");
  const selected = new Set(segments.map((segment) => segment.assetId));
  for (const requirement of rules.values()) {
    if (requirement.check === "include_assets" && requirement.assetIds.some((id) => !selected.has(id))) throw new Error(`缺少必须出现的素材：${requirement.id}`);
    if (requirement.check === "exclude_assets" && requirement.assetIds.some((id) => selected.has(id))) throw new Error(`使用了必须排除的素材：${requirement.id}`);
    if (requirement.check !== "exclude_assets" && !segments.some((segment) => segment.satisfies.includes(requirement.id))) throw new Error(`剪辑要求未被镜头覆盖：${requirement.id}`);
  }
  return segments;
}

export function composeMaterialProject(root, storyboardFile) {
  const loaded = load(root); root = loaded.root; const project = loaded.project;
  const unlock = acquireFileLock(path.join(root, ".kacha/material-project.lock"), { purpose: "compose-materials" });
  try {
    if (!current(project.brief)) throw new Error("剪辑要求已变化，请建立新项目以保留旧版本");
    const brief = readJson(project.brief.path); verifySigned(brief, "剪辑要求");
    const storyboard = readJson(path.resolve(storyboardFile));
    const segments = validateStoryboard(project, brief, storyboard);
    let soundtrack = null;
    if (storyboard.soundtrack) {
      const music = storyboard.soundtrack;
      checkFields(music, ["path", "reason", "levelBelowDialogueDb"], "配乐");
      if (!text(music.path) || !text(music.reason) || !numeric(music.levelBelowDialogueDb) || music.levelBelowDialogueDb < 8 || music.levelBelowDialogueDb > 30) throw new Error("配乐须声明本地文件、叙事理由和 8–30 dB 人声下方电平");
      const file = fs.realpathSync(path.resolve(music.path));
      if (!mediaSummary(file).audio) throw new Error("配乐文件没有可用音轨");
      soundtrack = { ...music, path: file, identity: fileIdentity(file) };
    }
    const proposal = signed({ schemaVersion: "1.0", kind: "kacha_material_edit_plan", projectDigest: project.digest, briefDigest: brief.digest,
      subtitle: subtitleContract(root, segments), soundtrack, interpretation: storyboard.interpretation, requirements: storyboard.requirements, target: brief.target, segments,
      unselected: project.assets.filter((asset) => !segments.some((segment) => segment.assetId === asset.id)).map((asset) => asset.id),
      quality: { status: "requires_render_and_human_review", semanticAssessment: "agent_authored_not_automatic_visual_proof" } });
    const dir = resolveContainedPath(root, path.join(root, "contracts", `edit-${proposal.digest.slice(0, 16)}`)); fs.mkdirSync(dir, { recursive: true });
    const planFile = resolveContainedPath(root, path.join(dir, "plan.json")); immutableJson(planFile, proposal);
    const cuesFile = resolveContainedPath(root, path.join(dir, "cues.json")); immutableJson(cuesFile, { cues: segments.map((segment) => ({
      id: segment.id, start: segment.start, end: segment.end, text: segment.observation, confidence: 1,
      signals: segment.caption ? ["reading"] : [],
      craft: segment.caption ? { screenText: segment.caption, evidence: ["text_visible"] } : {},
    })) });
    const directorFile = resolveContainedPath(root, path.join(dir, "director.json"));
    if (!fs.existsSync(directorFile)) json(directorFile, buildDirectorPlan(cuesFile, { projectId: project.projectId, showId: project.show, styleId: project.style }));
    json(path.join(root, ".kacha/material-active-plan.json"), { plan: fileIdentity(planFile) });
    return materialProjectStatus(root);
  } finally { unlock(); }
}
function verifyProjectFonts(root, active, { required = false } = {}) {
  if (!active.plan.subtitle?.source) return;
  const directory = resolveContainedPath(root, path.join(active.dir, "fonts"));
  if (!fs.existsSync(directory)) {
    if (required) throw new Error("工程字幕字体已缺失");
    return;
  }
  const source = active.plan.subtitle.source;
  const font = resolveContainedPath(root, path.join(directory, path.basename(source.path)));
  const entries = fs.readdirSync(directory);
  if ((required && !fs.existsSync(font)) || entries.some((entry) => entry !== path.basename(font))
    || (fs.existsSync(font) && sha256File(font) !== source.sha256)) throw new Error("工程字幕字体已变化或包含未声明文件");
}
function activePlan(root, project) {
  const pointer = path.join(root, ".kacha/material-active-plan.json");
  if (!fs.existsSync(pointer)) return null;
  const identity = readJson(pointer).plan;
  if (!identity?.path || !inside(root, fs.realpathSync(identity.path)) || !current(identity)) throw new Error("当前分镜计划已变化或越界");
  const plan = readJson(identity.path); verifySigned(plan, "分镜计划");
  if (plan.soundtrack && !current(plan.soundtrack.identity)) throw new Error("配乐文件已变化");
  if (!current(project.brief) || plan.projectDigest !== project.digest || plan.briefDigest !== readJson(project.brief.path).digest) throw new Error("分镜与当前素材或剪辑要求不一致");
  if (plan.kind !== "kacha_material_edit_plan" || sha256Value(plan.target) !== sha256Value(readJson(project.brief.path).target)) throw new Error("分镜目标与冻结剪辑要求不一致");
  if (plan.segments.some((segment) => segment.caption)) {
    if (!text(plan.subtitle?.family) || !numeric(plan.subtitle?.sizeRatio) || plan.subtitle.sizeRatio <= 0 || plan.subtitle.sizeRatio > .2) throw new Error("字幕合同缺失或无效，请重新 compose 冻结字体");
    if (plan.subtitle.source && !current(plan.subtitle.source)) throw new Error("字幕字体文件已变化");
  }
  const segments = validateStoryboard(project, readJson(project.brief.path), { ...plan, kind: "kacha_material_storyboard" }, { frozen: true });
  if (sha256Value(segments) !== sha256Value(plan.segments)) throw new Error("分镜派生时间或素材身份不一致");
  return { plan, identity, dir: path.dirname(identity.path), outputDir: resolveContainedPath(root, path.join(root, "output", `edit-${plan.digest.slice(0, 16)}`)) };
}

export function materialProjectStatus(root, { runtime = null } = {}) {
  const loaded = load(root); root = loaded.root; const project = loaded.project;
  if (runtime) runtimeCheck(project, runtime);
  if (!current(project.brief)) throw new Error("剪辑要求身份已失效");
  const active = activePlan(root, project);
  let receipt = null;
  if (active) {
    verifyProjectFonts(root, active);
    const file = resolveContainedPath(root, path.join(active.outputDir, "material-render.json"));
    if (fs.existsSync(file)) {
      receipt = readJson(file); verifySigned(receipt, "成片记录");
      verifyProjectFonts(root, active, { required: true });
      if (receipt.schemaVersion !== "1.0" || receipt.kind !== "kacha_material_render"
        || ["decode", "geometry", "duration", "audioTrack", "frameCount"].some((key) => receipt.qc?.[key] !== "pass")
        || receipt.qc?.decodedFrames !== Math.round(active.plan.target.durationSeconds * active.plan.target.fps)
        || receipt.qc?.humanReviewComplete !== false || receipt.qc?.semanticCoverage !== "agent_declared_requires_human_review"
        || receipt.timeline?.path !== path.join(active.outputDir, "timeline.json") || receipt.assembly?.path !== path.join(active.outputDir, "assembly.mkv")
        || receipt.planDigest !== active.plan.digest || receipt.output?.path !== path.join(active.outputDir, "candidate.mp4") || !current(receipt.output) || !current(receipt.timeline) || !current(receipt.assembly)) throw new Error("成片已变化，不能沿用旧验收结果");
    }
  }
  const jobFile = path.join(root, ".kacha/material-job.json");
  const submitted = fs.existsSync(jobFile) ? readJson(jobFile) : null;
  let job = null;
  if (submitted?.ref?.startsWith("@job:") && /^[a-zA-Z0-9_-]+$/.test(submitted.ref.slice(5))) {
    const file = resolveContainedPath(root, path.join(root, ".kacha/jobs", submitted.ref.slice(5), "job.json"));
    if (fs.existsSync(file)) {
      const stored = readJson(file);
      if (active && stored.command?.argv?.includes(active.plan.digest)) {
        const checked = JSON.parse(cli("kacha_jobs.mjs", ["status", submitted.ref, "--project-root", root]).stdout).job;
        job = { ref: submitted.ref, status: checked.status, error: checked.error ?? null, logs: stored.logs };
      }
    }
  }
  const failed = job && (["failed", "interrupted", "cancelled", "cancellation_failed"].includes(job.status) || (job.status === "succeeded" && !receipt));
  const rendering = job && ["pending", "queued", "running", "cancelling"].includes(job.status);
  return { schemaVersion: "1.0", kind: "kacha-material-project-status", status: receipt ? "candidate_ready" : failed ? "blocked" : rendering ? "rendering" : active ? "ready_to_render" : "awaiting_storyboard",
    projectRoot: root, projectId: project.projectId, task: "material_edit", assets: { count: project.assets.length, images: project.assets.filter((a) => a.kind === "image").length, videos: project.assets.filter((a) => a.kind === "video").length, skipped: project.skipped },
    agentPacket: path.join(root, ".kacha/material-agent-packet.json"), storyboardTemplate: path.join(root, "contracts/storyboard-template.json"),
    input: { identityStatus: "current" }, brief: project.brief, activePlan: active?.identity ?? null, candidate: receipt?.output ?? null, job,
    stages: [{ id: "materials", status: "complete" }, { id: "storyboard", status: active ? "complete" : "pending" }, { id: "render", status: receipt ? "complete" : rendering ? "running" : failed ? "blocked" : "pending" }, { id: "review", status: "pending" }],
    milestones: [{ id: "materials", label: "素材与要求", status: "complete" }, { id: "storyboard", label: "分镜与选段", status: active ? "complete" : "pending" }, { id: "render", label: "成片生成", status: receipt ? "complete" : "pending" }, { id: "review", label: "成片审阅", status: "pending" }],
    nextAction: { id: receipt ? "review_candidate" : failed ? "recover_render_job" : rendering ? "wait_render_job" : active ? "render_materials" : "inspect_and_compose", owner: receipt ? "human" : "agent", state: "ready",
      summary: receipt ? "正常速度审阅当前成片；技术通过不代表叙事与审美验收" : failed ? `渲染任务失败，请检查 ${job.ref} 的日志后恢复` : rendering ? `渲染中，查询 ${job.ref} 获取进度` : active ? "运行项目，提交可恢复渲染任务" : "查看素材代表帧、按需转写，依据要求选择和编排镜头", safeToAutoExecute: !receipt && !failed && !rendering },
    boundaries: { sourceReadOnly: true, localOnly: true, published: false, humanReviewComplete: false } };
}

function assTime(time) { const centis = Math.round(time * 100); return `${Math.floor(centis / 360000)}:${String(Math.floor(centis / 6000) % 60).padStart(2, "0")}:${String(Math.floor(centis / 100) % 60).padStart(2, "0")}.${String(centis % 100).padStart(2, "0")}`; }
function captions(plan, file, fontFamily) {
  const { width, height } = plan.target; const size = Math.round(height * plan.subtitle.sizeRatio);
  const escape = (value) => value.replaceAll("\\", "＼").replaceAll("{", "｛").replaceAll("}", "｝").replace(/\r?\n/g, "\\N");
  const lines = ["[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontFamily.replace(/[,\r\n]/g, "")},${size},&H00FFFFFF,&H00FFFFFF,&H00141414,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,${Math.round(width*.08)},${Math.round(width*.08)},${Math.round(height*.1)},1`,
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...plan.segments.filter((segment) => segment.caption).map((segment) => `Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Default,,0,0,0,,${escape(segment.caption)}`)];
  const content = lines.join("\n") + "\n";
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== content) throw new Error("字幕产物已变化");
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
}

export function renderMaterialProject(root, { runtime, confirmExecute = false, expectedPlanDigest = null } = {}) {
  const loaded = load(root); root = loaded.root; const project = loaded.project; runtimeCheck(project, runtime);
  if (!confirmExecute && !project.confirmExecute) throw new Error("渲染需要本地执行授权");
  const unlock = acquireFileLock(path.join(root, ".kacha/material-project.lock"), { purpose: "render-materials" });
  try {
    const active = activePlan(root, project); if (!active) throw new Error("请先完成素材审阅与分镜");
    const { plan, outputDir } = active;
    if (expectedPlanDigest && expectedPlanDigest !== plan.digest) throw new Error("排队后分镜版本发生变化，请为新版本重新提交任务");
    if (materialProjectStatus(root).candidate) return materialProjectStatus(root);
    fs.mkdirSync(outputDir, { recursive: true });
    let fontsDirectory = null;
    if (plan.subtitle?.source) {
      fontsDirectory = resolveContainedPath(root, path.join(active.dir, "fonts")); fs.mkdirSync(fontsDirectory, { recursive: true });
      const font = resolveContainedPath(root, path.join(fontsDirectory, path.basename(plan.subtitle.source.path)));
      if (fs.readdirSync(fontsDirectory).some((name) => name !== path.basename(font))) throw new Error("工程字体目录含未声明文件");
      if (fs.existsSync(font)) {
        if (sha256File(font) !== plan.subtitle.source.sha256) throw new Error("工程字幕字体已变化");
      } else fs.copyFileSync(plan.subtitle.source.path, font, fs.constants.COPYFILE_EXCL);
    } else if (plan.subtitle) {
      const config = loadKachaConfig({ args: [], anchorPath: root, includeSecrets: false });
      const font = resolveDesignSystem(config.config.style).fonts.roles.subtitlePrimary;
      if (!font.verified || font.resolved !== plan.subtitle.family) throw new Error("系统字幕字体与冻结合同不一致，请重新配置并 compose");
    }
    const cache = path.join(root, ".kacha/material-clips"); fs.mkdirSync(cache, { recursive: true });
    for (const leaf of ["assembly.mkv", "assembly.json", "captions.ass", "timeline.json", "candidate.mp4", "material-render.json"]) resolveContainedPath(root, path.join(outputDir, leaf));
    const parts = []; const { width, height, fps } = plan.target;
    for (const segment of plan.segments) {
      if (!current(segment.source)) throw new Error(`源素材已变化：${segment.id}`);
      const key = sha256Value({ source: segment.source.sha256, sourceIn: segment.sourceIn, duration: segment.duration, fit: segment.fit, audio: segment.audio, target: plan.target, implementation: sha256File(fileURLToPath(import.meta.url)) });
      const file = path.join(cache, `${key}.mkv`); const receipt = path.join(cache, `${key}.json`);
      let reusable = false;
      if (fs.existsSync(receipt)) { const value = readJson(receipt); reusable = value.key === key && value.output?.path === file && current(value.output); }
      resolveContainedPath(root, file); resolveContainedPath(root, receipt);
      if (!reusable) {
        if (fs.existsSync(file) && !fs.existsSync(receipt)) throw new Error("缓存文件缺少归属记录，拒绝覆盖");
        const temporary = freshTemporary(root, path.join(cache, `${key}-${process.pid}.partial.mkv`));
        const keepAudio = segment.hasAudio && segment.audio === "source";
        const filter = segment.fit === "cover"
          ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
          : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
        try {
          command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-n",
            ...(segment.kind === "image" ? ["-loop", "1", "-framerate", String(fps)] : ["-ss", String(segment.sourceIn)]), "-i", segment.source.path,
            ...(!keepAudio ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"] : []),
            "-map", "0:v:0", "-map", keepAudio ? "0:a:0" : "1:a:0",
            "-vf", `setpts=PTS-STARTPTS,scale=w='max(2,trunc(iw*if(gt(sar,0),sar,1)/2)*2)':h=ih,setsar=1,${filter},setsar=1,fps=${fps}:start_time=0,trim=end_frame=${segment.frames},format=yuv420p`,
            "-af", `aresample=48000:first_pts=0,${keepAudio ? "loudnorm=I=-16:TP=-2:LRA=11," : ""}aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${segment.duration},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=${Math.max(0,segment.duration-.01)}:d=0.01`,
            "-t", String(segment.duration), "-c:v", "ffv1", "-level", "3", "-c:a", "pcm_s16le", "-ar", "48000", temporary]);
          if (!current(segment.source)) throw new Error("转码期间源素材发生变化");
          const summary = mediaSummary(temporary);
          if (Math.abs(summary.duration - segment.duration) > 1/fps+.01) throw new Error("选段实际时长与分镜不符");
          fs.renameSync(temporary, file); json(receipt, { key, output: fileIdentity(file) });
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      parts.push({ segmentId: segment.id, source: segment.source, sourceIn: segment.sourceIn, duration: segment.duration, reused: reusable, output: fileIdentity(file) });
    }
    const concat = resolveContainedPath(root, path.join(cache, `concat-${plan.digest}.txt`));
    fs.writeFileSync(concat, parts.map((part) => `file '${path.basename(part.output.path)}'`).join("\n") + "\n");
    const master = path.join(outputDir, "assembly.mkv");
    const masterReceipt = path.join(outputDir, "assembly.json");
    const reusableMaster = fs.existsSync(masterReceipt) && readJson(masterReceipt).output?.path === master && current(readJson(masterReceipt).output) && readJson(masterReceipt).planDigest === plan.digest;
    if (!reusableMaster) {
      if (fs.existsSync(master) && !fs.existsSync(masterReceipt)) throw new Error("拼接母版缺少归属记录，拒绝覆盖");
      const temporary = freshTemporary(root, path.join(outputDir, `assembly-${process.pid}.partial.mkv`));
      try { command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "concat", "-safe", "1", "-i", concat, "-c", "copy", temporary]); fs.renameSync(temporary, master); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      json(masterReceipt, { planDigest: plan.digest, output: fileIdentity(master), parts });
    }
    const subtitleFile = path.join(outputDir, "captions.ass");
    if (plan.segments.some((segment) => segment.caption)) {
      captions(plan, subtitleFile, plan.subtitle.family);
    }
    const timelineFile = path.join(outputDir, "timeline.json");
    const candidate = path.join(outputDir, "candidate.mp4");
    immutableJson(timelineFile, { schemaVersion: "1.0", projectId: project.projectId, mode: "preview", source: fileIdentity(master),
      contracts: { materialPlan: active.identity }, edl: [{ id: "material-assembly", sourceStart: 0, sourceEnd: plan.target.durationSeconds }],
      visual: { overlays: [], ...(plan.segments.some((segment) => segment.caption) ? { subtitles: { path: subtitleFile, kind: "ass", ...(fontsDirectory ? { fontsDirectory } : {}) } } : {}) },
      audio: { masterTruePeakDb: -2, sfx: [], ...(plan.soundtrack ? { bgm: { path: plan.soundtrack.path, sha256: plan.soundtrack.identity.sha256, levelBelowDialogueDb: plan.soundtrack.levelBelowDialogueDb, sidechain: true } } : {}) }, output: { path: candidate, width, height, fps } });
    cli("timeline_ir.mjs", ["render", "--plan", timelineFile]);
    const decoded = command("ffmpeg", ["-hide_banner", "-v", "error", "-nostdin", "-i", candidate, "-map", "0:v:0", "-map", "0:a:0", "-progress", "pipe:1", "-nostats", "-f", "null", "-"]);
    const decodedFrames = Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]);
    if (decodedFrames !== Math.round(plan.target.durationSeconds * fps)) throw new Error("成片视频帧数与分镜目标不一致");
    const summary = mediaSummary(candidate);
    if (summary.width !== width || summary.height !== height || Math.abs(summary.fps-fps) > .001 || Math.abs(summary.duration-plan.target.durationSeconds)>2/fps+.02 || !summary.audio) throw new Error("成片几何、时长或音轨不符合合同");
    load(root); if (activePlan(root, project)?.plan.digest !== plan.digest) throw new Error("渲染期间当前分镜发生变化");
    json(path.join(outputDir, "material-render.json"), signed({ schemaVersion: "1.0", kind: "kacha_material_render", planDigest: plan.digest,
      output: fileIdentity(candidate), timeline: fileIdentity(timelineFile), assembly: fileIdentity(master), parts,
      qc: { frameCount: "pass", decodedFrames, decode: "pass", geometry: "pass", duration: "pass", audioTrack: "pass", semanticCoverage: "agent_declared_requires_human_review", humanReviewComplete: false },
      finalVideoEncodes: 1, losslessPreparation: true, createdAt: new Date().toISOString() }));
    return materialProjectStatus(root);
  } finally { unlock(); }
}

export function runMaterialProject(root, { runtime, confirmExecute = false, includeRender = false, resume = false } = {}) {
  const { project } = load(root); runtimeCheck(project, runtime);
  const unlock = acquireFileLock(path.join(project.projectRoot, ".kacha/material-submit.lock"), { purpose: "submit-material-render" });
  try {
    const state = materialProjectStatus(root);
    if (state.candidate || !state.activePlan || state.status === "rendering") return state;
    if (!confirmExecute && !project.confirmExecute) throw new Error("需要本地执行授权 --confirm-execute");
    if (!includeRender) return { ...state, nextAction: { ...state.nextAction, summary: "分镜就绪，使用 run --include-render 生成候选视频" } };
    if (state.status === "blocked") {
      if (!resume || state.job.status === "succeeded") return state;
      cli("kacha_jobs.mjs", ["resume", state.job.ref, "--project-root", project.projectRoot]);
      return materialProjectStatus(project.projectRoot);
    }
    const active = activePlan(project.projectRoot, project);
    const output = path.join(active.outputDir, "material-render.json");
    const result = cli("kacha_jobs.mjs", ["submit", "--project-root", project.projectRoot, "--kind", "render", "--expected-output", output,
      "--", process.execPath, path.join(scripts, "kacha_materials.mjs"), "render", "--project-root", project.projectRoot, "--confirm-execute", "--plan-digest", active.plan.digest]);
    const job = JSON.parse(result.stdout); json(path.join(project.projectRoot, ".kacha/material-job.json"), job);
    return { ...materialProjectStatus(project.projectRoot), status: "render_submitted", job };
  } finally { unlock(); }
}
