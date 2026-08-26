#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mediaSummary,
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { resolveDesignSystem } from "./design_system.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";
import { measureSfxPeak } from "./sfx_peak_alignment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const registryFile = path.join(
  skillDirectory,
  "config",
  "effects",
  "spoken-caption-layouts.json",
);
const fontRoutingFile = path.join(skillDirectory, "config", "font-routing.json");
const bundledSfxRoot = path.join(skillDirectory, "assets", "sfx");
const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(name) {
  return args.includes(name);
}

function fail(message, code = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    error: message,
  }, null, 2));
  process.exit(code);
}

function execute(command, commandArgs) {
  const result = run(command, commandArgs);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} 失败\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
  return result;
}

function sfxPeakSeconds(file) {
  return measureSfxPeak(file).measuredPeakOffsetSeconds;
}

function parseTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const text = String(value ?? "").trim().replace(",", ".");
  const match = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text);
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseSrt(text) {
  return text
    .trim()
    .split(/\r?\n\r?\n+/)
    .map((block, index) => {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) throw new Error(`SRT 第 ${index + 1} 块缺少时间轴`);
      const [start, end] = lines[timingIndex].split("-->").map(parseTimestamp);
      return {
        start,
        end,
        text: lines.slice(timingIndex + 1).join(" ").trim(),
      };
    });
}

function readTranscript(file) {
  const extension = path.extname(file).toLowerCase();
  const raw = extension === ".srt"
    ? parseSrt(fs.readFileSync(file, "utf8"))
    : (() => {
      const value = readJson(file);
      return Array.isArray(value) ? value : value.cues ?? value.segments ?? value.items ?? [];
    })();
  const cues = raw.map((cue, index) => ({
    ...cue,
    id: String(cue.id ?? `cue-${String(index + 1).padStart(4, "0")}`),
    start: parseTimestamp(cue.start ?? cue.startSeconds ?? cue.begin),
    end: parseTimestamp(cue.end ?? cue.endSeconds ?? cue.finish),
    text: String(cue.text ?? cue.transcript ?? cue.content ?? "").replace(/\s+/g, " ").trim(),
  }));
  for (const [index, cue] of cues.entries()) {
    if (!cue.id.trim()) throw new Error(`转写 cue ${index + 1} 的 id 为空`);
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) {
      throw new Error(`转写 cue ${cue.id || index} 的时间区间无效`);
    }
    if (!cue.text) throw new Error(`转写 cue ${cue.id || index} 的文本为空`);
  }
  cues.sort((left, right) => left.start - right.start);
  const cueIds = new Set();
  for (const cue of cues) {
    if (cueIds.has(cue.id)) throw new Error(`转写 cue id 重复：${cue.id}`);
    cueIds.add(cue.id);
  }
  for (let index = 1; index < cues.length; index += 1) {
    if (cues[index].start < cues[index - 1].end) {
      throw new Error(`转写 cue ${cues[index].id} 与上一 cue 重叠`);
    }
  }
  return cues;
}

function aspectMode(summary) {
  const ratio = summary.width / summary.height;
  if (ratio > 1.1) return "landscape-16x9";
  if (ratio < 0.9) return "portrait-9x16";
  return "square-1x1";
}

function ancestorDirectories(file) {
  const directories = [];
  let current = path.dirname(path.resolve(file));
  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function materializeBundledPrivateRegistry(templateFile, output) {
  const template = readJson(templateFile);
  const privateDirectory = path.dirname(templateFile);
  const records = (template.records ?? []).map((record) => {
    const localFile = path.join(privateDirectory, record.fileName);
    if (!fs.existsSync(localFile)) {
      throw new Error(`咔嚓私有字体注册表指向缺失文件：${localFile}`);
    }
    if (sha256File(localFile) !== record.sha256) {
      throw new Error(`咔嚓私有字体文件哈希已失效：${localFile}`);
    }
    return { ...record, file: localFile };
  });
  const registry = {
    ...template,
    generatedAt: new Date().toISOString(),
    source: {
      directory: privateDirectory,
      fileCount: records.length,
      materializedFrom: templateFile,
    },
    records,
  };
  registry.digest = sha256Value({ ...registry, digest: undefined });
  const destination = `${path.resolve(output)}.bundled-fonts.json`;
  writeJsonAtomic(destination, registry);
  return destination;
}

function resolveFontRegistry({ input, output, explicit, config }) {
  if (explicit) return path.resolve(explicit);
  if (config.tools.fontRegistry) {
    const configured = path.resolve(config.tools.fontRegistry);
    if (!fs.existsSync(configured)) {
      throw new Error(`配置的 tools.fontRegistry 不存在：${configured}`);
    }
    return configured;
  }
  if (!config.execution.fonts.autoDiscoverProjectFonts) return null;
  const ancestors = ancestorDirectories(input);
  const registryCandidates = ancestors.flatMap((directory) => [
    path.join(directory, ".kacha", "fonts", "authorized.json"),
    path.join(directory, ".work", "kacha-font-registry-authorized.json"),
  ]);
  const authorized = registryCandidates.find((candidate) => fs.existsSync(candidate));
  if (authorized) return authorized;
  for (const directory of ancestors) {
    for (const relative of config.execution.fonts.directories) {
      const fontDirectory = path.resolve(directory, relative);
      if (!fs.existsSync(fontDirectory) || !fs.statSync(fontDirectory).isDirectory()) continue;
      const generated = `${path.resolve(output)}.fonts.json`;
      execute(process.execPath, [
        path.join(scriptDirectory, "kacha_fonts.mjs"),
        "scan",
        "--directory", fontDirectory,
        "--output", generated,
        "--overwrite",
      ]);
      return generated;
    }
  }
  const bundledPrivateRegistry = path.join(
    skillDirectory,
    "assets",
    "private",
    "fonts",
    "authorized.json",
  );
  if (fs.existsSync(bundledPrivateRegistry)) {
    return materializeBundledPrivateRegistry(bundledPrivateRegistry, output);
  }
  return null;
}

function stripPunctuation(value) {
  return String(value ?? "")
    .replace(/[\s“”"'‘’。.!！？?，,；;：:、·—…（）()《》〈〉【】\[\]{}]/g, "")
    .trim();
}

function sameValue(left, right) {
  return sha256Value(left) === sha256Value(right);
}

function finiteNumber(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} 必须为 ${minimum} 至 ${maximum} 的有限数值`);
  }
  return number;
}

function integerNumber(value, label, minimum, maximum) {
  const number = finiteNumber(value, label, minimum, maximum);
  if (!Number.isInteger(number)) throw new Error(`${label} 必须为整数`);
  return number;
}

function fontRoleForCue(cue, layout, routing) {
  const explicit = String(cue.fontRole ?? cue.typographyRole ?? "").trim();
  if (explicit) {
    if (!routing.roles[explicit]) {
      throw new Error(`cue ${cue.id} 指定了不存在的字体角色：${explicit}`);
    }
    return { roleId: explicit, evidence: "explicit" };
  }
  if (["plain_single", "logic_emphasis_inline"].includes(layout.id)) {
    return { roleId: layout.fontRole, evidence: "subtitle_consistency" };
  }
  if ([
    "editorial_stack",
    "edge_annotation",
    "quote_field",
    "oversize_background_word",
    "front_back_phrase",
  ].includes(layout.id)) {
    return { roleId: layout.fontRole, evidence: "designed_text_role_contract" };
  }
  const text = cue.text;
  if (/哈哈|好笑|笑点|自嘲|尴尬|离谱|滚蛋|小白|humou?r|funny|joke|lol/i.test(text)) {
    return { roleId: "caption_humor", evidence: "humor_semantics" };
  }
  if (/读书|书籍|历史|文化|哲学|人生|夫子|佛祖|三清|品味|book|read|history|culture|philosophy/i.test(text)) {
    return { roleId: "caption_cultural", evidence: "cultural_semantics" };
  }
  if (/AI|人工智能|工具|代码|数据|流程|算法|模型|剪辑|workflow|data|code|model|tool/i.test(text)) {
    return { roleId: "caption_tech", evidence: "technology_semantics" };
  }
  return { roleId: layout.fontRole, evidence: "layout_default" };
}

function splitContrast(text) {
  const patterns = [
    /不是(.+?)(?:，|,)?而是(.+)/,
    /一方面(.+?)(?:，|,)?另一方面(.+)/,
    /(.+?)(?:对比|vs\.?|VS)(.+)/,
    /(.+?)(?:，|,)(?:但|但是|却)(.+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return [stripPunctuation(match[1]), stripPunctuation(match[2])];
  }
  return null;
}

function inferEmphasis(text) {
  const tokens = [
    /(?:不是|不要|不能|必须|只有|关键|重点|真正|最重要|所以|因此)([\u3400-\u9fffA-Za-z0-9%.-]{0,8})/,
    /(\d+(?:\.\d+)?%?)/,
  ];
  for (const pattern of tokens) {
    const match = pattern.exec(text);
    if (match) return stripPunctuation(match[0]).slice(0, 10);
  }
  return null;
}

function requestedLayout(cue, layoutsById) {
  const id = String(
    cue.textScene?.layout ?? cue.captionLayout ?? cue.layoutId ?? cue.display?.layout ?? "",
  ).trim();
  if (!id || id === "auto") return null;
  if (!layoutsById.has(id)) throw new Error(`cue ${cue.id} 指定了不存在的字幕布局：${id}`);
  return { id, evidence: "explicit" };
}

function resolveShowProfile(requested, registry, label) {
  for (const [id, profile] of Object.entries(registry.showProfiles ?? {})) {
    const names = new Set([id, profile.label, ...(profile.aliases ?? [])]);
    if (names.has(requested)) return { id, ...profile };
  }
  throw new Error(`${label} 指定了不存在的栏目字景档案：${requested}`);
}

function showProfileForCue(cue, registry) {
  const requested = String(cue.textScene?.show ?? option("--show", "neutral")).trim();
  return resolveShowProfile(requested, registry, `cue ${cue.id}`);
}

function presentationTier(layout) {
  if (layout.presentationTier) return layout.presentationTier;
  if (layout.id === "plain_single") return "reading";
  return "semantic";
}

function normalizeAnchor(value, fallback = "left") {
  const anchor = String(value ?? fallback).trim();
  if (!["left", "right", "center"].includes(anchor)) {
    throw new Error(`字景 anchor 必须为 left、right 或 center，当前为：${anchor}`);
  }
  return anchor;
}

function textSceneRecord(cue, layout, profile, surface) {
  const scene = cue.textScene ?? {};
  const tier = presentationTier(layout);
  const motion = String(scene.motion ?? layout.entry ?? "cut");
  if (scene.motion && motion !== String(layout.entry ?? "cut")) {
    throw new Error(`cue ${cue.id} 指定的 motion 尚无对应渲染实现`);
  }
  const exit = String(scene.exit ?? layout.exit ?? "cut");
  if (scene.exit && exit !== String(layout.exit ?? "cut")) {
    throw new Error(`cue ${cue.id} 指定的 exit 尚无对应渲染实现`);
  }
  const anchor = normalizeAnchor(
    scene.anchor,
    layout.id === "edge_annotation" ? "right" : "left",
  );
  const progressMode = String(scene.progressMode ?? "none");
  if (!["none", "micro_rail"].includes(progressMode)) {
    throw new Error(`cue ${cue.id} 的 progressMode 只允许 none 或 micro_rail`);
  }
  const resolvedSurface = String(scene.surface ?? surface).trim();
  if (!["footage", "light", "dark"].includes(resolvedSurface)) {
    throw new Error(`cue ${cue.id} 的 surface 只允许 footage、light 或 dark`);
  }
  const semanticRole = String(scene.role ?? layout.trigger).trim();
  if (!semanticRole) throw new Error(`cue ${cue.id} 的字景语义角色不能为空`);
  const motif = String(scene.graphicMotif ?? profile.graphicMotif).trim();
  if (!motif) throw new Error(`cue ${cue.id} 的字景图形母题不能为空`);
  return {
    enabled: tier !== "reading" || Boolean(cue.textScene),
    tier,
    semanticRole,
    showProfile: profile,
    surface: resolvedSurface,
    anchor,
    material: {
      textTexture: "clean_raster_with_contact_shadow",
      displayOpacity: finiteNumber(
        scene.displayOpacity ?? 0.96,
        `cue ${cue.id} 的 displayOpacity`,
        0.72,
        1,
      ),
      echoOpacity: finiteNumber(
        scene.echoOpacity ?? 0.11,
        `cue ${cue.id} 的 echoOpacity`,
        0.07,
        0.16,
      ),
      shadowOpacity: tier === "reading" ? 0.6 : 0.38,
      outline: "none",
      plate: "none",
    },
    graphics: {
      motif,
      accent: resolvedSurface === "light" ? profile.lightAccent : profile.accent,
      secondaryAccent: resolvedSurface === "light"
        ? profile.lightSecondaryAccent
        : profile.secondaryAccent,
      maximumAccentAreaRatio: 0.08,
    },
    motion: {
      id: motion,
      entryFrames: integerNumber(
        scene.entryFrames ?? (layout.entry === "cut" ? 1 : tier === "spatial" ? 6 : 4),
        `cue ${cue.id} 的 entryFrames`,
        1,
        12,
      ),
      settleScale: finiteNumber(
        scene.settleScale ?? 1.04,
        `cue ${cue.id} 的 settleScale`,
        1,
        1.08,
      ),
      exit,
      visibleLandingNotEarlierThanSpeech: true,
      bounce: false,
    },
    spatial: {
      coordinateSpace: "normalized_frame",
      rotationDegrees: finiteNumber(
        scene.rotationDegrees ?? 0,
        `cue ${cue.id} 的 rotationDegrees`,
        -1.2,
        1.2,
      ),
      parallaxPixels: finiteNumber(
        scene.parallaxPixels ?? (tier === "spatial" ? 8 : 3),
        `cue ${cue.id} 的 parallaxPixels`,
        0,
        12,
      ),
      faceClearanceRatio: finiteNumber(
        scene.faceClearanceRatio ?? 0.06,
        `cue ${cue.id} 的 faceClearanceRatio`,
        0.04,
        0.12,
      ),
      subjectOcclusion: Boolean(layout.maskRequired),
    },
    lyricProgress: {
      mode: progressMode,
      thicknessRatio: 0.0025,
      maximumWidthRatio: 0.46,
      recolorWholeLine: false,
    },
  };
}

function wordTimingForCue(cue, fps, startFrame, endFrame) {
  const words = Array.isArray(cue.words) ? cue.words : [];
  let previousEnd = startFrame;
  return words.map((word, index) => {
    const start = parseTimestamp(word.start ?? word.startSeconds ?? word.begin);
    const end = parseTimestamp(word.end ?? word.endSeconds ?? word.finish);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`cue ${cue.id} 的 words[${index}] 时间无效`);
    }
    const wordStartFrame = Math.round(start * fps);
    const wordEndFrame = Math.round(end * fps);
    const text = String(word.text ?? word.word ?? "").trim();
    if (!text) throw new Error(`cue ${cue.id} 的 words[${index}].text 不能为空`);
    if (
      wordStartFrame < startFrame
      || wordEndFrame > endFrame
      || wordEndFrame <= wordStartFrame
      || wordStartFrame < previousEnd
    ) {
      throw new Error(`cue ${cue.id} 的 words[${index}] 越界或非单调`);
    }
    previousEnd = wordEndFrame;
    return {
      text,
      startFrame: wordStartFrame,
      endFrame: wordEndFrame,
      startSeconds: wordStartFrame / fps,
      endSeconds: wordEndFrame / fps,
    };
  }).map((word, index, records) => {
    if (index === records.length - 1) {
      const cueText = stripPunctuation(cue.text);
      const timedText = stripPunctuation(records.map((item) => item.text).join(""));
      if (cueText !== timedText) {
        throw new Error(`cue ${cue.id} 的 words 文本与 cue.text 不一致`);
      }
    }
    return word;
  });
}

function validateDisplayForLayout(cue, layout, display) {
  const constraints = layout.constraints ?? {};
  const checks = [
    ["Left", display.left, constraints.maximumCharactersPerZone],
    ["Right", display.right, constraints.maximumCharactersPerZone],
    ["Top", display.top, constraints.maximumCharactersTop],
    ["Bottom", display.bottom, constraints.maximumCharactersBottom],
    ["Background", display.background, constraints.maximumCharactersBackground],
    ["Foreground", display.foreground, constraints.maximumCharactersForeground],
    ["Primary", display.primary, constraints.maximumCharactersPrimary],
    ["Secondary", display.secondary, constraints.maximumCharactersSecondary],
    ["Annotation", display.annotation, constraints.maximumCharactersAnnotation],
    ["Source", display.source, constraints.maximumCharactersSource],
    ["Echo", display.echo, constraints.maximumCharactersEcho],
  ];
  for (const [label, value, maximum] of checks) {
    if (maximum && stripPunctuation(value).length > maximum) {
      throw new Error(`cue ${cue.id} 的 display.${label.toLowerCase()} 超过 ${maximum} 字`);
    }
  }
  if (layout.id === "editorial_stack" && (!display.primary || !display.secondary)) {
    throw new Error(`cue ${cue.id} 的 editorial_stack 需要 display.primary/secondary`);
  }
  if (layout.id === "edge_annotation" && (!display.primary || !display.annotation)) {
    throw new Error(`cue ${cue.id} 的 edge_annotation 需要 display.primary/annotation`);
  }
  if (layout.id === "quote_field" && (!display.primary || !display.source)) {
    throw new Error(`cue ${cue.id} 的 quote_field 需要已核实的 display.primary/source`);
  }
  if (["left_right_contrast", "side_vertical_labels"].includes(layout.id)) {
    if (!display.left || !display.right) {
      throw new Error(`cue ${cue.id} 的 ${layout.id} 需要 display.left/right`);
    }
  }
  if (layout.id === "top_bottom_hierarchy" && (!display.top || !display.bottom)) {
    throw new Error(`cue ${cue.id} 的 top_bottom_hierarchy 需要 display.top/bottom`);
  }
  if (["oversize_background_word", "front_back_phrase"].includes(layout.id)) {
    if (!display.background || !display.foreground) {
      throw new Error(`cue ${cue.id} 的 ${layout.id} 需要 display.background/foreground`);
    }
  }
}

function densityAssessment(events, registry) {
  const rules = registry.globalRules?.designedTextSceneDensity ?? {};
  const designed = events.filter((event) => event.presentationTier !== "reading");
  const spatial = events.filter((event) => event.presentationTier === "spatial");
  let semanticRun = 0;
  let spatialRun = 0;
  let maximumSemanticRun = 0;
  let maximumSpatialRun = 0;
  for (const event of events) {
    semanticRun = event.presentationTier === "semantic" ? semanticRun + 1 : 0;
    spatialRun = event.presentationTier === "spatial" ? spatialRun + 1 : 0;
    maximumSemanticRun = Math.max(maximumSemanticRun, semanticRun);
    maximumSpatialRun = Math.max(maximumSpatialRun, spatialRun);
  }
  const designedRatio = events.length ? designed.length / events.length : 0;
  const spatialRatio = events.length ? spatial.length / events.length : 0;
  const warnings = [];
  if (events.length >= 8 && designedRatio > Number(rules.recommendedMaximumRatio ?? 0.28)) {
    warnings.push(`语义/空间字景占比 ${(designedRatio * 100).toFixed(1)}%，高于建议上限`);
  }
  if (events.length >= 10 && spatialRatio > Number(rules.spatialMaximumRatio ?? 0.1)) {
    warnings.push(`空间字景占比 ${(spatialRatio * 100).toFixed(1)}%，高于建议上限`);
  }
  if (maximumSemanticRun > Number(rules.maximumConsecutiveSemantic ?? 2)) {
    warnings.push(`连续语义字景达到 ${maximumSemanticRun} 条，缺少视觉留白`);
  }
  if (maximumSpatialRun > Number(rules.maximumConsecutiveSpatial ?? 1)) {
    warnings.push(`连续空间字景达到 ${maximumSpatialRun} 条，空间强调过密`);
  }
  return {
    designedCount: designed.length,
    spatialCount: spatial.length,
    designedRatio,
    spatialRatio,
    maximumSemanticRun,
    maximumSpatialRun,
    warnings,
  };
}

function automaticLayout(cue, maskAvailable) {
  const contrast = splitContrast(cue.text);
  if (contrast && contrast.every((item) => item.length <= 10)) {
    return { id: "left_right_contrast", evidence: "deterministic_contrast_relation" };
  }
  if (
    cue.display?.top
    && cue.display?.bottom
    && String(cue.display.top).length <= 10
    && String(cue.display.bottom).length <= 14
  ) {
    return { id: "top_bottom_hierarchy", evidence: "explicit_hierarchical_display_content" };
  }
  if (
    maskAvailable
    && cue.display?.background
    && cue.display?.foreground
  ) {
    return { id: "front_back_phrase", evidence: "explicit_depth_content_with_mask" };
  }
  if (cue.emphasis || inferEmphasis(cue.text)) {
    return { id: "logic_emphasis_inline", evidence: "logical_emphasis_rule" };
  }
  return { id: "plain_single", evidence: "default_reading_subtitle" };
}

function displayRecordForCue(cue) {
  return {
    full: cue.text,
    emphasis: String(cue.emphasis ?? inferEmphasis(cue.text) ?? ""),
    left: String(cue.display?.left ?? splitContrast(cue.text)?.[0] ?? ""),
    right: String(cue.display?.right ?? splitContrast(cue.text)?.[1] ?? ""),
    top: String(cue.display?.top ?? ""),
    bottom: String(cue.display?.bottom ?? ""),
    background: String(cue.display?.background ?? ""),
    foreground: String(cue.display?.foreground ?? cue.text),
    primary: String(cue.display?.primary ?? cue.textScene?.primary ?? ""),
    secondary: String(cue.display?.secondary ?? cue.textScene?.secondary ?? ""),
    annotation: String(cue.display?.annotation ?? cue.textScene?.annotation ?? ""),
    source: String(cue.display?.source ?? cue.textScene?.source ?? ""),
    echo: String(cue.display?.echo ?? cue.textScene?.echo ?? ""),
  };
}

function fontAliases(record) {
  return [
    ...(record.families ?? []),
    ...(record.fullNames ?? []),
    ...(record.postscriptNames ?? []),
  ];
}

const fixedIdentityFontRoles = new Set([
  "subtitle_primary",
  "subtitle_emphasis",
  "display_title",
  "display_title_zh",
  "term_definition",
  "quote_pull",
  "cover_title",
  "thin_support",
]);

function supportsText(record, text) {
  const cjk = /[\u3400-\u9fff]/.test(text);
  const latin = /[A-Za-z]/.test(text);
  if (
    cjk
    && (record.coverage?.simplifiedChinese?.ratio ?? 0) < 0.9
    && (record.coverage?.traditionalChinese?.ratio ?? 0) < 0.9
  ) return false;
  if (latin && (record.coverage?.latin?.ratio ?? 0) < 0.9) return false;
  return true;
}

function localFontForRole(registry, routing, roleId, text, allowRestricted) {
  const role = routing.roles[roleId];
  if (!role) return null;
  const autoStatuses = new Set(routing.distributionPolicy.automaticSelectionStatuses);
  const ranked = registry.records.filter((record) => (
    supportsText(record, text)
    && (
      allowRestricted
      || autoStatuses.has(record.license?.status)
      || record.projectAuthorization?.status === "authorized"
    )
  )).map((record) => {
    const aliases = fontAliases(record).map((name) => name.toLowerCase());
    const familyIndex = (role.preferredFamilies ?? []).findIndex((family) => {
      const requested = family.toLowerCase();
      return aliases.some(
        (name) => name === requested || name.includes(requested) || requested.includes(name),
      );
    });
    const classIndex = (role.preferredClasses ?? []).findIndex(
      (fontClass) => record.classes?.includes(fontClass),
    );
    const weight = Number(record.weightClass ?? 400);
    return {
      record,
      eligible: !fixedIdentityFontRoles.has(roleId) || familyIndex >= 0,
      score: (familyIndex < 0 ? 100 : familyIndex * 5)
        + (classIndex < 0 ? 30 : classIndex * 3)
        + Math.abs(weight - Number(role.targetWeight ?? 500)) / 100
        + (
          record.license?.status === "open"
          || record.projectAuthorization?.status === "authorized"
            ? 0
            : 20
        )
        + (record.duplicateOf ? 2 : 0),
    };
  }).filter((item) => item.eligible).sort((left, right) => left.score - right.score);
  if (ranked.length === 0) return null;
  const selected = ranked[0].record;
  return {
    roleId,
    family: selected.families?.[0] ?? selected.postscriptNames?.[0],
    file: selected.file,
    sha256: selected.sha256,
    licenseStatus: selected.license?.status,
    projectAuthorization: selected.projectAuthorization ?? null,
    projectLicenseReviewRequired:
      selected.license?.status !== "open"
      && selected.projectAuthorization?.status !== "authorized",
  };
}

function planCaptionLayout({ input, transcript, output, mask, fontRegistry }) {
  const registry = readJson(registryFile);
  const layoutsById = new Map(registry.layouts.map((layout) => [layout.id, layout]));
  const summary = mediaSummary(input);
  const cues = readTranscript(transcript);
  if (cues.length === 0) throw new Error("转写中没有有效字幕 cue");
  const config = loadKachaConfig({ args, anchorPath: input, includeSecrets: false }).config;
  const resolvedFontRegistry = resolveFontRegistry({
    input,
    output,
    explicit: fontRegistry,
    config,
  });
  const globalShowRequest = option("--show", null);
  const globalShowProfile = globalShowRequest
    ? resolveShowProfile(String(globalShowRequest).trim(), registry, "--show")
    : null;
  const designResolverInput = {
    ...config.style,
    modes: {
      ...config.style.modes,
      ...(globalShowProfile && globalShowProfile.id !== "neutral"
        ? { show: globalShowProfile.id.replaceAll("_", "-") }
        : {}),
      aspectRatio: aspectMode(summary),
      surface: option("--surface", "footage"),
      language: option("--language", config.style.modes.language),
    },
  };
  const design = resolveDesignSystem(designResolverInput);
  const localRegistry = resolvedFontRegistry ? readJson(resolvedFontRegistry) : null;
  const routing = readJson(fontRoutingFile);
  const allowRestricted = has("--allow-restricted-fonts");
  const surface = option("--surface", "footage");
  const maskSummary = mask ? mediaSummary(mask) : null;
  const maskRecord = mask
    ? {
      path: path.resolve(mask),
      sha256: sha256File(mask),
      width: maskSummary.width,
      height: maskSummary.height,
      fps: maskSummary.averageFps,
      duration: maskSummary.videoDuration,
      frameCount: Number(maskSummary.video?.nb_frames)
        || Math.round(maskSummary.videoDuration * maskSummary.averageFps),
      startTime: maskSummary.startTime,
    }
    : null;
  if (maskRecord && (
    maskRecord.width !== summary.width
    || maskRecord.height !== summary.height
    || Math.abs(maskRecord.fps - summary.averageFps) > 0.001
    || Math.abs(maskRecord.duration - summary.videoDuration) > 1 / summary.averageFps
    || maskRecord.frameCount !== (
      Number(summary.video?.nb_frames) || Math.round(summary.videoDuration * summary.averageFps)
    )
    || Math.abs(maskRecord.startTime - summary.startTime) > 0.5 / summary.averageFps
  )) {
    throw new Error("人物蒙版必须与源视频保持同尺寸、同帧率和同帧数");
  }
  const events = [];
  const droppedOrFallback = [];
  const usedFonts = new Map();
  const registeredMotifs = new Set(
    Object.values(registry.showProfiles ?? {}).map((item) => item.graphicMotif),
  );

  for (const cue of cues) {
    if (
      cue.start < -0.5 / summary.averageFps
      || cue.end > summary.videoDuration + 0.5 / summary.averageFps
    ) {
      throw new Error(`cue ${cue.id} 超出源视频时间范围`);
    }
    const requested = requestedLayout(cue, layoutsById);
    let selection = requested ?? automaticLayout(cue, Boolean(maskRecord));
    let layout = layoutsById.get(selection.id);
    if (layout.maskRequired && !maskRecord) {
      if (requested) {
        throw new Error(`cue ${cue.id} 使用 ${layout.id}，但没有逐帧人物蒙版`);
      }
      droppedOrFallback.push({
        cueId: cue.id,
        requested: layout.id,
        fallback: layout.fallback,
        reason: "人物蒙版不可用",
      });
      selection = { id: layout.fallback, evidence: "mask_fallback" };
      layout = layoutsById.get(selection.id);
    }
    const display = displayRecordForCue(cue);
    if (layout.id === "side_vertical_labels") {
      display.left = String(cue.display?.left ?? "");
      display.right = String(cue.display?.right ?? "");
      if (!display.left || !display.right) {
        throw new Error(`cue ${cue.id} 的 side_vertical_labels 需要 display.left/right`);
      }
    }
    if (layout.id === "top_bottom_hierarchy" && (!display.top || !display.bottom)) {
      if (requested) {
        throw new Error(`cue ${cue.id} 的 top_bottom_hierarchy 需要 display.top/bottom`);
      }
      layout = layoutsById.get("logic_emphasis_inline");
      selection = { id: layout.id, evidence: "hierarchy_content_fallback" };
    }
    if (
      ["oversize_background_word", "front_back_phrase"].includes(layout.id)
      && !display.background
    ) {
      throw new Error(`cue ${cue.id} 的 ${layout.id} 需要 display.background`);
    }
    validateDisplayForLayout(cue, layout, display);
    const textForFont = Object.values(display).join(" ");
    const fontRole = fontRoleForCue(cue, layout, routing);
    const localFont = localRegistry
      ? localFontForRole(
        localRegistry,
        routing,
        fontRole.roleId,
        textForFont,
        allowRestricted,
      )
      : null;
    const fallbackRole = [
      "display_title_zh",
      "display_title",
      "term_definition",
      "quote_pull",
      "caption_editorial",
      "caption_humor",
      "caption_cultural",
      "caption_tech",
    ].includes(fontRole.roleId)
      ? "display"
      : "subtitlePrimary";
    const font = localFont ?? {
      roleId: fontRole.roleId,
      family: design.fonts.roles[fallbackRole]?.resolved
        ?? design.style.typography[fallbackRole]?.families?.[0],
      file: null,
      sha256: null,
      licenseStatus: "system_or_unverified",
      projectLicenseReviewRequired: false,
    };
    const readingFont = presentationTier(layout) === "reading"
      ? font
      : localRegistry
        ? localFontForRole(localRegistry, routing, "subtitle_primary", cue.text, allowRestricted)
        : null;
    const supportFont = presentationTier(layout) === "reading"
      ? font
      : localRegistry
        ? localFontForRole(
          localRegistry,
          routing,
          "thin_support",
          `${display.secondary} ${display.annotation} ${display.source}`,
          allowRestricted,
        )
        : null;
    const resolvedReadingFont = readingFont ?? {
      roleId: "subtitle_primary",
      family: design.fonts.roles.subtitlePrimary?.resolved
        ?? design.style.typography.subtitlePrimary?.families?.[0],
      file: null,
      sha256: null,
      licenseStatus: "system_or_unverified",
      projectLicenseReviewRequired: false,
    };
    const resolvedSupportFont = supportFont ?? {
      roleId: "thin_support",
      family: design.fonts.roles.support?.resolved
        ?? design.fonts.roles.bodyEn?.resolved
        ?? design.style.typography.bodyEn?.families?.[0]
        ?? routing.roles.thin_support.preferredFamilies[0],
      file: null,
      sha256: null,
      licenseStatus: "system_or_unverified",
      projectLicenseReviewRequired: false,
    };
    for (const selectedFont of [font, resolvedReadingFont, resolvedSupportFont]) {
      usedFonts.set(`${selectedFont.roleId}:${selectedFont.family}`, selectedFont);
    }
    const startFrame = Math.max(0, Math.round(cue.start * summary.averageFps));
    const endFrame = Math.min(
      Math.round(summary.videoDuration * summary.averageFps),
      Math.round(cue.end * summary.averageFps),
    );
    const profile = showProfileForCue(cue, registry);
    const scene = textSceneRecord(cue, layout, profile, surface);
    if (!registeredMotifs.has(scene.graphics.motif)) {
      throw new Error(`cue ${cue.id} 指定了未注册的字景图形母题：${scene.graphics.motif}`);
    }
    if (endFrame - startFrame <= scene.motion.entryFrames) {
      throw new Error(
        `cue ${cue.id} 的有效帧数不足以完成 ${scene.motion.entryFrames} 帧入场`,
      );
    }
    const peakFrame = startFrame + scene.motion.entryFrames;
    if (
      layout.constraints?.allowedAnchors
      && !layout.constraints.allowedAnchors.includes(scene.anchor)
    ) {
      throw new Error(
        `cue ${cue.id} 的 ${layout.id} anchor 必须为 `
          + layout.constraints.allowedAnchors.join(" 或 "),
      );
    }
    if (Math.abs(scene.spatial.rotationDegrees) > 1.2) {
      throw new Error(`cue ${cue.id} 的 rotationDegrees 不得超过 ±1.2°`);
    }
    const wordTiming = wordTimingForCue(
      cue,
      summary.averageFps,
      startFrame,
      endFrame,
    );
    if (scene.lyricProgress.mode !== "none" && wordTiming.length === 0) {
      throw new Error(`cue ${cue.id} 启用了 ${scene.lyricProgress.mode}，但没有逐字时间 words`);
    }
    if (
      scene.lyricProgress.mode !== "none"
      && ![
        "plain_single",
        "logic_emphasis_inline",
        "editorial_stack",
        "edge_annotation",
        "oversize_background_word",
      ].includes(layout.id)
    ) {
      throw new Error(`cue ${cue.id} 的 ${layout.id} 没有可承载逐字进度的阅读基线`);
    }
    events.push({
      id: `caption-${String(events.length + 1).padStart(4, "0")}`,
      cueId: cue.id,
      startSeconds: startFrame / summary.averageFps,
      endSeconds: endFrame / summary.averageFps,
      startFrame,
      endFrame,
      peakFrame,
      entryStartFrame: startFrame,
      visibleLandingFrame: peakFrame,
      sfxPeakFrame: layout.soundTrigger ? peakFrame : null,
      layoutId: layout.id,
      presentationTier: scene.tier,
      trigger: layout.trigger,
      function: layout.function,
      selectionEvidence: selection.evidence,
      display,
      textScene: scene,
      wordTiming,
      font,
      typography: {
        display: font,
        reading: resolvedReadingFont,
        support: resolvedSupportFont,
      },
      fontRoleEvidence: fontRole.evidence,
      sound: layout.soundTrigger
        ? {
          trigger: layout.soundTrigger,
          peakFrame,
          peakSeconds: peakFrame / summary.averageFps,
          levelRelativeToDialogueDb:
            registry.soundPalette[layout.soundTrigger].levelRelativeToDialogueDb,
        }
        : null,
      maskRequired: Boolean(layout.maskRequired),
      fallback: layout.fallback,
      failureModes: layout.failureModes,
    });
  }

  const density = densityAssessment(events, registry);

  const plan = {
    schemaVersion: "1.0",
    kind: "kacha_spoken_caption_timeline",
    status: "planned_not_rendered",
    generatedAt: new Date().toISOString(),
    generationOptions: {
      show: globalShowRequest ? String(globalShowRequest).trim() : "neutral",
      surface,
      language: option("--language", config.style.modes.language),
      allowRestrictedFonts: allowRestricted,
    },
    source: {
      input: {
        path: path.resolve(input),
        sha256: sha256File(input),
        width: summary.width,
        height: summary.height,
        fps: summary.averageFps,
        duration: summary.videoDuration,
        frameCount: Number(summary.video?.nb_frames)
          || Math.round(summary.videoDuration * summary.averageFps),
        startTime: summary.startTime,
      },
      transcript: {
        path: path.resolve(transcript),
        sha256: sha256File(transcript),
        cueCount: cues.length,
      },
      fontRegistry: localRegistry
        ? {
          path: path.resolve(resolvedFontRegistry),
          sha256: sha256File(resolvedFontRegistry),
        }
        : null,
    },
    resources: { mask: maskRecord },
    design: {
      id: design.system.id,
      version: design.system.version,
      digest: design.digest,
      modes: design.selectedModes,
      resolverInput: designResolverInput,
      palette: design.style.palette,
      subtitles: design.style.subtitles,
      textSceneSystem: {
        id: registry.id,
        name: registry.designSystem?.name,
        showProfiles: Object.fromEntries(
          [...new Set(events.map((event) => event.textScene.showProfile.id))]
            .map((id) => [id, registry.showProfiles[id]]),
        ),
      },
    },
    policy: {
      ...registry.globalRules,
      preserveSourceGeometry: true,
      explicitRestrictedFontAuthorization: allowRestricted,
      publicFontRedistribution: false,
    },
    fonts: [...usedFonts.values()],
    events,
    densityAssessment: density,
    fallbackLog: droppedOrFallback,
    registry: {
      id: registry.id,
      sha256: sha256File(registryFile),
      fontRoutingSha256: sha256File(fontRoutingFile),
    },
  };
  plan.digest = sha256Value({ ...plan, digest: undefined });
  writeJsonAtomic(output, plan);
  return plan;
}

function validatePlan(planFile, strictTextScenes = false) {
  const plan = readJson(planFile);
  const registry = readJson(registryFile);
  const routing = readJson(fontRoutingFile);
  const layoutsById = new Map(registry.layouts.map((layout) => [layout.id, layout]));
  const errors = [];
  const warnings = [];
  if (plan.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (plan.kind !== "kacha_spoken_caption_timeline") {
    errors.push("kind 必须为 kacha_spoken_caption_timeline");
  }
  for (const [label, item] of [
    ["input", plan.source?.input],
    ["transcript", plan.source?.transcript],
  ]) {
    if (!item?.path || !fs.existsSync(item.path)) errors.push(`${label} 不存在`);
    else if (sha256File(item.path) !== item.sha256) errors.push(`${label} SHA-256 已失效`);
  }
  let inputSummary = null;
  if (plan.source?.input?.path && fs.existsSync(plan.source.input.path)) {
    inputSummary = mediaSummary(plan.source.input.path);
    const input = plan.source.input;
    if (
      input.width !== inputSummary.width
      || input.height !== inputSummary.height
      || Math.abs(Number(input.fps) - inputSummary.averageFps) > 0.001
      || Math.abs(Number(input.duration) - inputSummary.videoDuration)
        > 1 / inputSummary.averageFps
      || input.frameCount !== (
        Number(inputSummary.video?.nb_frames)
          || Math.round(inputSummary.videoDuration * inputSummary.averageFps)
      )
      || Math.abs(Number(input.startTime) - inputSummary.startTime) > 0.5 / inputSummary.averageFps
    ) {
      errors.push("源视频媒体规格与计划不一致");
    }
  }
  if (plan.source?.fontRegistry) {
    const fontRegistry = plan.source.fontRegistry;
    if (!fs.existsSync(fontRegistry.path)) errors.push("字体清单不存在");
    else if (sha256File(fontRegistry.path) !== fontRegistry.sha256) {
      errors.push("字体清单 SHA-256 已失效");
    }
  }
  if (plan.registry?.sha256 !== sha256File(registryFile)) {
    errors.push("字幕布局注册表已变化，计划必须重建");
  }
  if (plan.registry?.fontRoutingSha256 !== sha256File(fontRoutingFile)) {
    errors.push("字体路由注册表已变化，计划必须重建");
  }
  let currentDesign = null;
  try {
    currentDesign = resolveDesignSystem(plan.design?.resolverInput ?? {
      modes: plan.design?.modes ?? {},
    });
  } catch (error) {
    errors.push(`设计系统无法解析：${error.message}`);
  }
  if (
    currentDesign
    && (
      plan.design?.id !== currentDesign.system.id
      || plan.design?.version !== currentDesign.system.version
      || plan.design?.digest !== currentDesign.digest
    )
  ) {
    errors.push("设计系统版本或摘要已失效");
  }
  for (const [key, value] of Object.entries(registry.globalRules ?? {})) {
    if (!sameValue(plan.policy?.[key], value)) {
      errors.push(`policy.${key} 与当前字幕注册表不一致`);
    }
  }
  if (plan.policy?.preserveSourceGeometry !== true) {
    errors.push("字幕计划必须保持源视频几何");
  }
  if (
    !["footage", "light", "dark"].includes(plan.generationOptions?.surface)
    || plan.design?.modes?.surface !== plan.generationOptions?.surface
  ) {
    errors.push("生成 surface 与设计模式不一致");
  }
  if (
    plan.generationOptions?.allowRestrictedFonts
      !== plan.policy?.explicitRestrictedFontAuthorization
  ) {
    errors.push("限制性字体生成选项与计划策略不一致");
  }
  try {
    const globalProfile = resolveShowProfile(
      String(plan.generationOptions?.show ?? "neutral"),
      registry,
      "generationOptions.show",
    );
    if (
      globalProfile.id !== "neutral"
      && plan.design?.modes?.show !== globalProfile.id.replaceAll("_", "-")
    ) {
      errors.push("生成栏目与设计系统 show 模式不一致");
    }
  } catch (error) {
    errors.push(error.message);
  }
  const mask = plan.resources?.mask;
  if (mask) {
    if (!mask.path || !fs.existsSync(mask.path)) {
      errors.push("人物蒙版不存在");
    } else if (sha256File(mask.path) !== mask.sha256) {
      errors.push("人物蒙版 SHA-256 已失效");
    } else if (inputSummary) {
      const currentMask = mediaSummary(mask.path);
      if (
        mask.width !== currentMask.width
        || mask.height !== currentMask.height
        || Math.abs(Number(mask.fps) - currentMask.averageFps) > 0.001
        || Math.abs(Number(mask.duration) - currentMask.videoDuration)
          > 1 / inputSummary.averageFps
        || mask.frameCount !== (
          Number(currentMask.video?.nb_frames)
            || Math.round(currentMask.videoDuration * currentMask.averageFps)
        )
        || Math.abs(Number(mask.startTime) - currentMask.startTime)
          > 0.5 / inputSummary.averageFps
        || currentMask.width !== inputSummary.width
        || currentMask.height !== inputSummary.height
        || Math.abs(currentMask.averageFps - inputSummary.averageFps) > 0.001
        || Math.abs(currentMask.videoDuration - inputSummary.videoDuration)
          > 1 / inputSummary.averageFps
        || (
          Number(currentMask.video?.nb_frames)
            || Math.round(currentMask.videoDuration * currentMask.averageFps)
        ) !== (
          Number(inputSummary.video?.nb_frames)
            || Math.round(inputSummary.videoDuration * inputSummary.averageFps)
        )
        || Math.abs(currentMask.startTime - inputSummary.startTime)
          > 0.5 / inputSummary.averageFps
      ) {
        errors.push("人物蒙版必须与源视频保持同尺寸、同帧率和同帧数");
      }
    }
  }
  const authorizedFontRecords = new Map(
    (plan.source?.fontRegistry?.path && fs.existsSync(plan.source.fontRegistry.path)
      ? readJson(plan.source.fontRegistry.path).records ?? []
      : []).map((record) => [`${record.file}:${record.sha256}`, record]),
  );
  let transcriptCues = [];
  if (plan.source?.transcript?.path && fs.existsSync(plan.source.transcript.path)) {
    try {
      transcriptCues = readTranscript(plan.source.transcript.path);
    } catch (error) {
      errors.push(`转写无法重新解析：${error.message}`);
    }
  }
  if (
    plan.source?.transcript?.cueCount !== transcriptCues.length
    || (plan.events ?? []).length !== transcriptCues.length
  ) {
    errors.push("转写 cue 数量与字幕事件不一致");
  }
  let previousEnd = -1;
  for (const [index, event] of (plan.events ?? []).entries()) {
    const label = `events[${index}]`;
    const expectedEventId = `caption-${String(index + 1).padStart(4, "0")}`;
    if (event.id !== expectedEventId) errors.push(`${label}.id 与确定性事件顺序不一致`);
    const sourceCue = transcriptCues[index];
    if (sourceCue && (
      event.cueId !== sourceCue.id
      || event.display?.full !== sourceCue.text
      || (
        inputSummary
        && (
          event.startFrame !== Math.max(0, Math.round(sourceCue.start * inputSummary.averageFps))
          || event.endFrame !== Math.min(
            Math.round(inputSummary.videoDuration * inputSummary.averageFps),
            Math.round(sourceCue.end * inputSummary.averageFps),
          )
        )
      )
    )) {
      errors.push(`${label} 与冻结转写 cue 不一致`);
    }
    if (sourceCue) {
      try {
        const requested = requestedLayout(sourceCue, layoutsById);
        let selection = requested ?? automaticLayout(sourceCue, Boolean(mask));
        let expectedLayout = layoutsById.get(selection.id);
        if (expectedLayout?.maskRequired && !mask && !requested) {
          selection = { id: expectedLayout.fallback, evidence: "mask_fallback" };
          expectedLayout = layoutsById.get(selection.id);
        }
        const expectedDisplay = displayRecordForCue(sourceCue);
        if (
          expectedLayout?.id === "top_bottom_hierarchy"
          && (!expectedDisplay.top || !expectedDisplay.bottom)
          && !requested
        ) {
          expectedLayout = layoutsById.get("logic_emphasis_inline");
          selection = { id: expectedLayout.id, evidence: "hierarchy_content_fallback" };
        }
        if (
          event.layoutId !== expectedLayout?.id
          || event.selectionEvidence !== selection.evidence
          || !sameValue(event.display, expectedDisplay)
        ) {
          errors.push(`${label} 的布局或展示文字无法从冻结 cue 重建`);
        }
        if (expectedLayout) {
          const expectedFontRole = fontRoleForCue(sourceCue, expectedLayout, routing);
          if (
            event.font?.roleId !== expectedFontRole.roleId
            || event.fontRoleEvidence !== expectedFontRole.evidence
          ) {
            errors.push(`${label} 的展示字体角色无法从冻结 cue 重建`);
          }
          const requestedProfile = String(
            sourceCue.textScene?.show ?? plan.generationOptions?.show ?? "neutral",
          ).trim();
          const expectedProfile = resolveShowProfile(
            requestedProfile,
            registry,
            `cue ${sourceCue.id}`,
          );
          const expectedScene = textSceneRecord(
            sourceCue,
            expectedLayout,
            expectedProfile,
            plan.generationOptions?.surface,
          );
          if (!sameValue(event.textScene, expectedScene)) {
            errors.push(`${label}.textScene 无法从冻结 cue 和注册表重建`);
          }
          if (
            event.trigger !== expectedLayout.trigger
            || event.function !== expectedLayout.function
            || event.maskRequired !== Boolean(expectedLayout.maskRequired)
            || event.fallback !== expectedLayout.fallback
            || !sameValue(event.failureModes, expectedLayout.failureModes)
          ) {
            errors.push(`${label} 的布局执行合同与注册表不一致`);
          }
        }
        if (inputSummary) {
          const expectedWords = wordTimingForCue(
            sourceCue,
            inputSummary.averageFps,
            event.startFrame,
            event.endFrame,
          );
          if (!sameValue(event.wordTiming, expectedWords)) {
            errors.push(`${label}.wordTiming 无法从冻结 cue 重建`);
          }
        }
      } catch (error) {
        errors.push(`${label} 无法重建：${error.message}`);
      }
    }
    const layout = layoutsById.get(event.layoutId);
    if (!layout) errors.push(`${label}.layoutId 未注册`);
    if (
      !Number.isInteger(event.startFrame)
      || !Number.isInteger(event.endFrame)
      || !(event.startFrame >= 0 && event.endFrame > event.startFrame)
    ) {
      errors.push(`${label} 帧区间无效`);
    }
    if (
      !Number.isInteger(event.peakFrame)
      || event.peakFrame < event.startFrame
      || event.peakFrame >= event.endFrame
    ) {
      errors.push(`${label}.peakFrame 不在事件区间内`);
    }
    if (
      event.entryStartFrame !== event.startFrame
      || event.visibleLandingFrame !== event.peakFrame
      || event.sfxPeakFrame !== (event.sound ? event.peakFrame : null)
    ) {
      errors.push(`${label} 的入场、可见落位与 SFX 帧合同不一致`);
    }
    if (
      inputSummary
      && event.endFrame > Math.round(inputSummary.videoDuration * inputSummary.averageFps)
    ) {
      errors.push(`${label} 超出源视频帧区间`);
    }
    if (inputSummary && (
      !Number.isFinite(event.startSeconds)
      || !Number.isFinite(event.endSeconds)
      || Math.abs(event.startSeconds - event.startFrame / inputSummary.averageFps) > 0.000001
      || Math.abs(event.endSeconds - event.endFrame / inputSummary.averageFps) > 0.000001
    )) {
      errors.push(`${label} 秒与帧时间不一致`);
    }
    if (event.startFrame < previousEnd) errors.push(`${label} 与上一字幕 cue 重叠`);
    previousEnd = event.endFrame;
    if (!event.font?.family) errors.push(`${label}.font.family 缺失`);
    if (!sameValue(event.font, event.typography?.display)) {
      errors.push(`${label}.font 必须与 typography.display 一致`);
    }
    const expectedTypographySlots = event.presentationTier === "reading"
      ? ["display"]
      : ["display", "reading", "support"];
    for (const slot of expectedTypographySlots) {
      if (!event.typography?.[slot]) errors.push(`${label}.typography.${slot} 缺失`);
    }
    for (const [slot, selectedFont] of Object.entries(
      event.typography ?? { display: event.font },
    )) {
      if (!selectedFont?.family) errors.push(`${label}.typography.${slot}.family 缺失`);
      if (!routing.roles?.[selectedFont?.roleId]) {
        errors.push(`${label}.typography.${slot}.roleId 未注册`);
      }
      if (slot === "reading" && event.presentationTier !== "reading" && selectedFont?.roleId !== "subtitle_primary") {
        errors.push(`${label}.typography.reading 必须使用 subtitle_primary`);
      }
      if (slot === "support" && event.presentationTier !== "reading" && selectedFont?.roleId !== "thin_support") {
        errors.push(`${label}.typography.support 必须使用 thin_support`);
      }
      if (selectedFont?.file) {
        if (!fs.existsSync(selectedFont.file)) {
          errors.push(`${label}.typography.${slot}.file 不存在`);
        } else if (sha256File(selectedFont.file) !== selectedFont.sha256) {
          errors.push(`${label}.typography.${slot}.sha256 已失效`);
        }
        if (
          selectedFont.projectLicenseReviewRequired
          && !plan.policy.explicitRestrictedFontAuthorization
        ) {
          errors.push(`${label} 使用限制性字体但没有项目授权确认`);
        }
        if (
          strictTextScenes
          && !authorizedFontRecords.has(`${selectedFont.file}:${selectedFont.sha256}`)
        ) {
          errors.push(`${label}.typography.${slot} 不属于冻结的字体注册表`);
        } else if (strictTextScenes) {
          const record = authorizedFontRecords.get(`${selectedFont.file}:${selectedFont.sha256}`);
          const authorized = record?.license?.status === "open"
            || record?.projectAuthorization?.status === "authorized"
            || plan.policy?.explicitRestrictedFontAuthorization === true;
          if (!authorized) {
            errors.push(`${label}.typography.${slot} 没有当前项目授权`);
          }
          const aliases = fontAliases(record).map((name) => name.toLowerCase());
          const preferred = routing.roles?.[selectedFont.roleId]?.preferredFamilies ?? [];
          if (!preferred.some((family) => {
            const requested = family.toLowerCase();
            return aliases.some(
              (name) => name === requested || name.includes(requested) || requested.includes(name),
            );
          })) {
            errors.push(`${label}.typography.${slot} 未命中角色指定字体家族`);
          }
        }
      } else if (strictTextScenes) {
        errors.push(`${label}.typography.${slot} 严格模式禁止系统字体回退`);
      }
    }
    if (layout?.maskRequired) {
      if (!mask?.path || !fs.existsSync(mask.path)) errors.push(`${label} 缺少人物蒙版`);
    }
    const expectedTier = layout ? presentationTier(layout) : null;
    if (!event.presentationTier || event.presentationTier !== expectedTier) {
      errors.push(`${label}.presentationTier 与布局定义不一致`);
    }
    const profileId = event.textScene?.showProfile?.id;
    if (!profileId || !registry.showProfiles?.[profileId]) {
      errors.push(`${label}.textScene.showProfile 未注册`);
    } else if (!sameValue(
      event.textScene.showProfile,
      { id: profileId, ...registry.showProfiles[profileId] },
    )) {
      errors.push(`${label}.textScene.showProfile 与当前栏目档案不一致`);
    }
    if (strictTextScenes && profileId === "neutral") {
      errors.push(`${label} 严格模式必须选择行者大灰五个正式栏目之一`);
    }
    if (
      strictTextScenes
      && profileId !== "neutral"
      && event.presentationTier === "reading"
      && event.typography?.display?.roleId !== "subtitle_primary"
    ) {
      errors.push(`${label} 正式栏目阅读字幕必须使用 subtitle_primary`);
    }
    if (event.textScene?.tier !== event.presentationTier) {
      errors.push(`${label}.textScene.tier 与 presentationTier 不一致`);
    }
    if (!["footage", "light", "dark"].includes(event.textScene?.surface)) {
      errors.push(`${label}.textScene.surface 无效`);
    }
    if (
      strictTextScenes
      && event.presentationTier !== "reading"
      && event.textScene?.surface === "footage"
    ) {
      errors.push(`${label} 严格模式要求字景显式标注 light 或 dark 表面`);
    }
    if (event.textScene?.material?.outline !== "none") {
      errors.push(`${label}.textScene.material.outline 必须为 none`);
    }
    if (event.textScene?.material?.plate !== "none") {
      errors.push(`${label}.textScene.material.plate 必须为 none`);
    }
    const displayOpacity = Number(event.textScene?.material?.displayOpacity);
    const echoOpacity = Number(event.textScene?.material?.echoOpacity);
    if (!Number.isFinite(displayOpacity) || !(displayOpacity >= 0.72 && displayOpacity <= 1)) {
      errors.push(`${label}.textScene.material.displayOpacity 必须为 0.72 至 1`);
    }
    if (!Number.isFinite(echoOpacity) || !(echoOpacity >= 0.07 && echoOpacity <= 0.16)) {
      errors.push(`${label}.textScene.material.echoOpacity 必须为 0.07 至 0.16`);
    }
    const accentArea = Number(event.textScene?.graphics?.maximumAccentAreaRatio);
    if (!Number.isFinite(accentArea) || accentArea < 0 || accentArea > 0.08) {
      errors.push(`${label}.textScene.graphics 强调图形面积不得超过 8%`);
    }
    if (profileId && registry.showProfiles?.[profileId]) {
      const profile = registry.showProfiles[profileId];
      const expectedAccent = event.textScene?.surface === "light"
        ? profile.lightAccent
        : profile.accent;
      const expectedSecondaryAccent = event.textScene?.surface === "light"
        ? profile.lightSecondaryAccent
        : profile.secondaryAccent;
      if (
        event.textScene?.graphics?.accent !== expectedAccent
        || event.textScene?.graphics?.secondaryAccent !== expectedSecondaryAccent
      ) {
        errors.push(`${label}.textScene.graphics 栏目色与档案不一致`);
      }
      const knownMotifs = new Set(
        Object.values(registry.showProfiles).map((item) => item.graphicMotif),
      );
      if (!knownMotifs.has(event.textScene?.graphics?.motif)) {
        errors.push(`${label}.textScene.graphics.motif 未注册`);
      }
    }
    const rotation = Number(event.textScene?.spatial?.rotationDegrees);
    const parallax = Number(event.textScene?.spatial?.parallaxPixels);
    const faceClearance = Number(event.textScene?.spatial?.faceClearanceRatio);
    if (!Number.isFinite(rotation) || Math.abs(rotation) > 1.2) {
      errors.push(`${label}.textScene.spatial.rotationDegrees 不得超过 ±1.2°`);
    }
    if (!Number.isFinite(parallax) || parallax < 0 || parallax > 12) {
      errors.push(`${label}.textScene.spatial.parallaxPixels 必须为 0 至 12`);
    }
    if (!Number.isFinite(faceClearance) || faceClearance < 0.04 || faceClearance > 0.12) {
      errors.push(`${label}.textScene.spatial.faceClearanceRatio 必须为 0.04 至 0.12`);
    }
    if (
      layout?.constraints?.allowedAnchors?.length
      && !layout.constraints.allowedAnchors.includes(event.textScene?.anchor)
    ) {
      errors.push(`${label}.textScene.anchor 不符合布局约束`);
    }
    const motion = event.textScene?.motion;
    if (!motion || motion.bounce !== false) {
      errors.push(`${label}.textScene.motion 必须显式禁用 bounce`);
    } else {
      const entryFrames = Number(motion.entryFrames);
      const settleScale = Number(motion.settleScale);
      if (
        !Number.isInteger(entryFrames)
        || entryFrames < 1
        || entryFrames > 12
      ) {
        errors.push(`${label}.textScene.motion.entryFrames 必须为 1 至 12 的整数`);
      } else {
        if (event.endFrame - event.startFrame <= entryFrames) {
          errors.push(`${label} 的有效帧数不足以完成入场`);
        }
        if (event.peakFrame !== event.startFrame + entryFrames) {
          errors.push(`${label}.peakFrame 必须等于可见落位帧`);
        }
      }
      if (!Number.isFinite(settleScale) || settleScale < 1 || settleScale > 1.08) {
        errors.push(`${label}.textScene.motion.settleScale 必须为 1 至 1.08`);
      }
      if (layout && motion.id !== String(layout.entry ?? "cut")) {
        errors.push(`${label}.textScene.motion.id 没有对应渲染实现`);
      }
      if (layout && motion.exit !== String(layout.exit ?? "cut")) {
        errors.push(`${label}.textScene.motion.exit 没有对应渲染实现`);
      }
    }
    const progressMode = event.textScene?.lyricProgress?.mode ?? "none";
    if (!["none", "micro_rail"].includes(progressMode)) {
      errors.push(`${label}.textScene.lyricProgress.mode 无效`);
    }
    let previousWordEnd = event.startFrame;
    const timedWords = [];
    for (const [wordIndex, word] of (event.wordTiming ?? []).entries()) {
      if (
        word.startFrame < event.startFrame
        || word.endFrame > event.endFrame
        || word.endFrame <= word.startFrame
        || word.startFrame < previousWordEnd
      ) {
        errors.push(`${label}.wordTiming[${wordIndex}] 越界或非单调`);
      }
      if (!String(word.text ?? "").trim()) {
        errors.push(`${label}.wordTiming[${wordIndex}].text 不能为空`);
      }
      if (inputSummary && (
        !Number.isFinite(word.startSeconds)
        || !Number.isFinite(word.endSeconds)
        || Math.abs(word.startSeconds - word.startFrame / inputSummary.averageFps) > 0.000001
        || Math.abs(word.endSeconds - word.endFrame / inputSummary.averageFps) > 0.000001
      )) {
        errors.push(`${label}.wordTiming[${wordIndex}] 秒与帧时间不一致`);
      }
      timedWords.push(String(word.text ?? ""));
      previousWordEnd = word.endFrame;
    }
    if (progressMode !== "none" && !(event.wordTiming ?? []).length) {
      errors.push(`${label} 启用了逐字进度但没有 wordTiming`);
    }
    if (event.textScene?.lyricProgress?.recolorWholeLine !== false) {
      errors.push(`${label}.textScene.lyricProgress 禁止整行卡拉 OK 变色`);
    }
    const thickness = Number(event.textScene?.lyricProgress?.thicknessRatio);
    const maximumRailWidth = Number(event.textScene?.lyricProgress?.maximumWidthRatio);
    if (!Number.isFinite(thickness) || thickness < 0.001 || thickness > 0.006) {
      errors.push(`${label}.textScene.lyricProgress.thicknessRatio 必须为 0.001 至 0.006`);
    }
    if (!Number.isFinite(maximumRailWidth) || maximumRailWidth <= 0 || maximumRailWidth > 0.46) {
      errors.push(`${label}.textScene.lyricProgress.maximumWidthRatio 必须大于 0 且不超过 0.46`);
    }
    if (timedWords.length > 0 && stripPunctuation(timedWords.join("")) !== stripPunctuation(event.display?.full)) {
      errors.push(`${label}.wordTiming 文本与 display.full 不一致`);
    }
    if (!String(event.display?.full ?? "").trim()) {
      errors.push(`${label}.display.full 不能为空`);
    }
    if (layout) {
      try {
        validateDisplayForLayout({ id: event.cueId }, layout, event.display ?? {});
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (event.sound) {
      const level = Number(event.sound.levelRelativeToDialogueDb);
      if (!Number.isFinite(level) || level < -24 || level > -6) {
        errors.push(`${label}.sound 电平必须为 -24 至 -6 dB`);
      }
      if (
        event.sound.peakFrame !== event.peakFrame
        || !inputSummary
        || !Number.isFinite(event.sound.peakSeconds)
        || Math.abs(event.sound.peakSeconds - event.peakFrame / inputSummary.averageFps)
          > 0.000001
      ) {
        errors.push(`${label}.sound 峰值必须与可见落位帧一致`);
      }
    }
    const expectedSound = layout?.soundTrigger && inputSummary
      ? {
        trigger: layout.soundTrigger,
        peakFrame: event.peakFrame,
        peakSeconds: event.peakFrame / inputSummary.averageFps,
        levelRelativeToDialogueDb:
          registry.soundPalette[layout.soundTrigger].levelRelativeToDialogueDb,
      }
      : null;
    if (!sameValue(event.sound, expectedSound)) {
      errors.push(`${label}.sound 与布局注册表或可见落位帧不一致`);
    }
  }
  if (!Array.isArray(plan.events) || plan.events.length === 0) errors.push("events 不能为空");
  if (strictTextScenes && !plan.source?.fontRegistry) {
    errors.push("严格模式必须冻结本地授权字体注册表");
  }
  if (plan.policy?.singleLinePerReadingZone !== true) {
    errors.push("每个阅读区必须保持单行");
  }
  if (plan.policy?.ordinarySubtitleSfx !== "none") {
    errors.push("普通连续字幕不得逐卡添加音效");
  }
  const density = densityAssessment(plan.events ?? [], registry);
  warnings.push(...density.warnings);
  if (strictTextScenes && warnings.length > 0) {
    errors.push(...warnings.map((warning) => `严格字景密度检查失败：${warning}`));
  }
  if (!sameValue(plan.densityAssessment, density)) {
    errors.push("densityAssessment 与字幕事件不一致");
  }
  const plannedFonts = new Map();
  for (const event of plan.events ?? []) {
    for (const selectedFont of Object.values(event.typography ?? {})) {
      if (selectedFont?.roleId && selectedFont?.family) {
        plannedFonts.set(`${selectedFont.roleId}:${selectedFont.family}`, selectedFont);
      }
    }
  }
  if (!sameValue(plan.fonts, [...plannedFonts.values()])) {
    errors.push("fonts 与事件字体选择不一致");
  }
  const expectedDigest = sha256Value({ ...plan, digest: undefined });
  if (expectedDigest !== plan.digest) errors.push("计划 digest 不一致");
  return { plan, errors, warnings };
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const wholeSeconds = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:`
    + `${String(wholeSeconds).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assEscape(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\r?\n/g, " ");
}

function assColor(hex, alpha = "00") {
  const value = String(hex ?? "#FFFFFF").replace("#", "").padEnd(6, "F");
  return `&H${alpha}${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`;
}

function dialogue(start, end, style, text, layer = 0) {
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
}

function inlineEmphasis(text, emphasis, accent) {
  const escaped = assEscape(text);
  if (!emphasis || !text.includes(emphasis)) return escaped;
  const index = text.indexOf(emphasis);
  const before = assEscape(text.slice(0, index));
  const highlighted = assEscape(emphasis);
  const after = assEscape(text.slice(index + emphasis.length));
  return `${before}{\\c${accent}\\b1\\fscx108\\fscy108}${highlighted}`
    + `{\\rKachaPrimary}${after}`;
}

function buildAss(plan, background = false) {
  const width = plan.source.input.width;
  const height = plan.source.input.height;
  const palette = plan.design.palette;
  const subtitles = plan.design.subtitles;
  const defaultFont = plan.fonts.find((font) => font.roleId === "subtitle_primary")
    ?? plan.fonts[0];
  const shadowAlpha = Math.round(255 * (1 - (subtitles.shadow?.opacity ?? 0.6)))
    .toString(16).padStart(2, "0").toUpperCase();
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,"
      + "BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,"
      + "BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: KachaPrimary,${defaultFont?.family ?? "Arial"},${Math.round(height * 0.048)},`
      + `${assColor(palette.textOnDark)},${assColor(palette.accent)},`
      + `${assColor(palette.shadow)},${assColor(palette.shadow, shadowAlpha)},`
      + "0,0,0,0,100,100,0,0,1,0,3,2,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];
  const events = [];
  for (const event of plan.events) {
    const isDepth = ["oversize_background_word", "front_back_phrase"].includes(event.layoutId);
    if (background && !isDepth) continue;
    const start = event.startSeconds;
    const end = event.endSeconds;
    const family = assEscape(event.font.family);
    const primary = assColor(palette.textOnDark);
    const accent = assColor(palette.accent);
    const dark = assColor(palette.textOnLight);
    const centerX = Math.round(width * 0.5);
    const baseline = Math.round(height * 0.69);
    const baseSize = Math.round(height * 0.048);
    const displaySize = Math.round(height * 0.088);
    const fade = "\\fad(70,90)";
    if (background) {
      if (event.layoutId === "oversize_background_word") {
        events.push(dialogue(
          start,
          end,
          "KachaPrimary",
          `{\\fn${family}\\fs${Math.round(height * 0.23)}\\b1\\an5\\c${accent}`
            + `\\alpha&H28&\\pos(${centerX},${Math.round(height * 0.35)})`
            + "\\fscx82\\fscy82\\t(0,220,\\fscx100\\fscy100)\\fad(80,120)}"
            + assEscape(event.display.background),
          0,
        ));
      } else {
        events.push(dialogue(
          start,
          end,
          "KachaPrimary",
          `{\\fn${family}\\fs${Math.round(height * 0.13)}\\b1\\an5\\c${primary}`
            + `\\alpha&H22&\\pos(${centerX},${Math.round(height * 0.34)})`
            + "\\fscx88\\fscy88\\t(0,180,\\fscx100\\fscy100)\\fad(80,100)}"
            + assEscape(event.display.background),
          0,
        ));
      }
      continue;
    }
    if (event.layoutId === "plain_single") {
      events.push(dialogue(
        start,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${baseSize}\\an5\\pos(${centerX},${baseline})${fade}}`
          + assEscape(event.display.full),
      ));
    } else if (event.layoutId === "logic_emphasis_inline") {
      events.push(dialogue(
        start,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${baseSize}\\an5\\pos(${centerX},${baseline})`
          + `\\fscx92\\fscy92\\t(0,150,\\fscx100\\fscy100)${fade}}`
          + inlineEmphasis(event.display.full, event.display.emphasis, accent),
      ));
    } else if (event.layoutId === "left_right_contrast") {
      const y = Math.round(height * 0.61);
      const size = Math.round(height * 0.052);
      events.push(dialogue(
        start,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${size}\\an5\\c${primary}\\move(${Math.round(width * 0.12)},${y},`
          + `${Math.round(width * 0.25)},${y},0,180)${fade}}`
          + assEscape(event.display.left),
      ));
      events.push(dialogue(
        start + 0.08,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${size}\\an5\\c${accent}\\move(${Math.round(width * 0.88)},${y},`
          + `${Math.round(width * 0.75)},${y},0,180)${fade}}`
          + assEscape(event.display.right),
      ));
    } else if (event.layoutId === "side_vertical_labels") {
      const size = Math.round(height * 0.046);
      const y = Math.round(height * 0.49);
      events.push(dialogue(
        start,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${size}\\an5\\c${primary}\\frz270\\pos(${Math.round(width * 0.09)},${y})${fade}}`
          + assEscape(event.display.left),
      ));
      events.push(dialogue(
        start + 0.08,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${size}\\an5\\c${accent}\\frz90\\pos(${Math.round(width * 0.91)},${y})${fade}}`
          + assEscape(event.display.right),
      ));
    } else if (event.layoutId === "top_bottom_hierarchy") {
      events.push(dialogue(
        start,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${Math.round(displaySize * 0.76)}\\b1\\an8\\c${primary}`
          + `\\pos(${centerX},${Math.round(height * 0.12)})${fade}}`
          + assEscape(event.display.top),
      ));
      events.push(dialogue(
        start + 0.1,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${Math.round(displaySize * 0.54)}\\an5\\c${accent}`
          + `\\pos(${centerX},${Math.round(height * 0.64)})${fade}}`
          + assEscape(event.display.bottom),
      ));
    }
    if (event.layoutId === "oversize_background_word") {
      events.push(dialogue(
        start + 0.08,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${baseSize}\\an5\\c${dark}\\pos(${centerX},${baseline})${fade}}`
          + assEscape(event.display.foreground),
        2,
      ));
    }
    if (event.layoutId === "front_back_phrase") {
      events.push(dialogue(
        start + 0.1,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${Math.round(displaySize * 0.58)}\\b1\\an5\\c${accent}`
          + `\\pos(${centerX},${Math.round(height * 0.63)})${fade}}`
          + assEscape(event.display.foreground),
        2,
      ));
    }
  }
  return `${[...header, ...events].join("\n")}\n`;
}

function escapeFilterPath(value) {
  return path.resolve(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

function resolveSfxAsset(trigger, root) {
  if (!trigger || !root) return null;
  const palette = readJson(registryFile).soundPalette[trigger];
  if (!palette) return null;
  const manifestFile = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = readJson(manifestFile);
  for (const id of palette.preferredAssetIds) {
    const asset = (manifest.assets ?? []).find((item) => item.id === id);
    if (!asset) continue;
    const candidates = [
      path.resolve(root, asset.ready_file),
      path.resolve(root, "ready", asset.ready_file),
    ];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (file) return { asset, file };
  }
  return null;
}

function renderPlan(planFile, output) {
  const strictTextScenes = has("--strict-text-scenes");
  const checked = validatePlan(planFile, strictTextScenes);
  if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
  const { plan } = checked;
  const input = plan.source.input.path;
  const summary = mediaSummary(input);
  const config = loadKachaConfig({ args, anchorPath: input, includeSecrets: false }).config;
  const configuredRoot = config.tools.sfxLibrary;
  const sfxRoot = option("--sfx-root")
    ? path.resolve(option("--sfx-root"))
    : configuredRoot
      ? path.resolve(configuredRoot)
      : bundledSfxRoot;
  const resolvedSfx = plan.events.map((event) => {
    const resolved = resolveSfxAsset(event.sound?.trigger, sfxRoot);
    return resolved
      ? { event, ...resolved, sourcePeakSeconds: sfxPeakSeconds(resolved.file) }
      : null;
  });
  if (strictTextScenes && !has("--no-sfx")) {
    const unresolved = plan.events.filter((event, index) => event.sound && !resolvedSfx[index]);
    if (unresolved.length > 0) {
      throw new Error(
        `严格模式缺少 ${unresolved.map((event) => event.id).join(", ")} 的已注册音效资产`,
      );
    }
  }
  const sfxItems = has("--no-sfx") ? [] : resolvedSfx.filter(Boolean);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-captions-"));
  try {
    const backgroundAss = path.join(temporary, "background.ass");
    const foregroundAss = path.join(temporary, "foreground.ass");
    fs.writeFileSync(backgroundAss, buildAss(plan, true));
    fs.writeFileSync(foregroundAss, buildAss(plan, false));
    const backgroundOverlay = path.join(temporary, "background-overlay.mov");
    const foregroundOverlay = path.join(temporary, "foreground-overlay.mov");
    execute("python3", [
      path.join(scriptDirectory, "render_caption_overlay.py"),
      "--plan", planFile,
      "--layer", "background",
      "--output", backgroundOverlay,
    ]);
    execute("python3", [
      path.join(scriptDirectory, "render_caption_overlay.py"),
      "--plan", planFile,
      "--layer", "foreground",
      "--output", foregroundOverlay,
    ]);
    const hasDepth = plan.events.some((event) => event.maskRequired);
    const videoOnly = path.join(temporary, "captioned-video.mp4");
    const ffmpegArgs = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", input,
      "-i", foregroundOverlay,
    ];
    let filter;
    if (hasDepth) {
      ffmpegArgs.push("-i", backgroundOverlay, "-i", plan.resources.mask.path);
      filter = "[0:v][2:v]overlay=0:0:format=auto[back];"
        + `[0:v]format=rgba[subject-rgb];[3:v]format=gray[mask];`
        + "[subject-rgb][mask]alphamerge[subject];"
        + "[back][subject]overlay=0:0:format=auto[depth];"
        + "[depth][1:v]overlay=0:0:format=auto,format=yuv420p[outv]";
    } else {
      filter = "[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[outv]";
    }
    ffmpegArgs.push(
      "-filter_complex", filter,
      "-map", "[outv]", "-an",
      "-c:v", "libx264", "-preset", "slow", "-crf", option("--crf", "16"),
      "-pix_fmt", "yuv420p", "-fps_mode", "cfr",
      "-movflags", "+faststart", videoOnly,
    );
    execute("ffmpeg", ffmpegArgs);

    const finalArgs = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", videoOnly,
    ];
    if (summary.audio) finalArgs.push("-i", input);
    for (const item of sfxItems) finalArgs.push("-i", item.file);
    if (!summary.audio) {
      finalArgs.push("-map", "0:v:0", "-c:v", "copy", "-an");
    } else if (sfxItems.length === 0) {
      finalArgs.push(
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
      );
    } else {
      const filters = [
        "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,"
          + "asetpts=PTS-STARTPTS[voice]",
      ];
      sfxItems.forEach((item, index) => {
        const inputIndex = index + 2;
        const offset = item.event.sound.peakSeconds - item.sourcePeakSeconds;
        const trim = offset < 0
          ? `atrim=start=${(-offset).toFixed(6)},asetpts=PTS-STARTPTS,`
          : "";
        const delay = Math.max(0, Math.round(offset * 1000));
        filters.push(
          `[${inputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,`
          + `${trim}adelay=${delay}|${delay},`
          + `volume=${item.event.sound.levelRelativeToDialogueDb}dB`
          + `[s${index}]`,
        );
      });
      const inputs = ["[voice]", ...sfxItems.map((_, index) => `[s${index}]`)].join("");
      filters.push(
        `${inputs}amix=inputs=${sfxItems.length + 1}:normalize=0:dropout_transition=0,`
          + "alimiter=limit=0.95[outa]",
      );
      finalArgs.push(
        "-filter_complex", filters.join(";"),
        "-map", "0:v:0", "-map", "[outa]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
      );
    }
    finalArgs.push("-t", String(summary.videoDuration), "-movflags", "+faststart", output);
    execute("ffmpeg", finalArgs);
    const decode = run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", output, "-f", "null", "-",
    ]);
    if (decode.status !== 0 || decode.stderr.trim()) {
      throw new Error(`字幕成片解码失败：${decode.stderr}`);
    }
    const rendered = mediaSummary(output);
    if (
      rendered.width !== summary.width
      || rendered.height !== summary.height
      || Math.abs(rendered.videoDuration - summary.videoDuration) > 2 / summary.averageFps
    ) {
      throw new Error("字幕渲染未保持源几何或时长");
    }
    const manifest = {
      schemaVersion: "1.0",
      status: "pass",
      plan: { path: path.resolve(planFile), sha256: sha256File(planFile), digest: plan.digest },
      output: {
        path: path.resolve(output),
        sha256: sha256File(output),
        width: rendered.width,
        height: rendered.height,
        fps: rendered.averageFps,
        duration: rendered.videoDuration,
      },
      events: plan.events.map((event, index) => ({
        id: event.id,
        layoutId: event.layoutId,
        presentationTier: event.presentationTier,
        showProfileId: event.textScene.showProfile.id,
        font: event.font,
        typography: event.typography,
        wordTimingCount: event.wordTiming.length,
        entryStartFrame: event.entryStartFrame,
        visibleLandingFrame: event.visibleLandingFrame,
        sfxPeakFrame: event.sfxPeakFrame,
        soundAssetId: has("--no-sfx") ? null : resolvedSfx[index]?.asset.id ?? null,
      })),
      sfxPeakAlignmentPlan: sfxItems.map((item) => ({
        eventId: item.event.id,
        targetLandingSeconds: item.event.sound.peakSeconds,
        measuredPeakOffsetSeconds: item.sourcePeakSeconds,
        fileStartSeconds: Math.max(0, item.event.sound.peakSeconds - item.sourcePeakSeconds),
        trimmedFromStartSeconds: Math.max(0, item.sourcePeakSeconds - item.event.sound.peakSeconds),
        actualLandingSeconds: item.event.sound.peakSeconds,
        deltaFrames: 0,
      })),
      qc: {
        fullDecode: "pass",
        sourceGeometryPreserved: true,
        sourceDurationPreserved: true,
        ordinarySubtitleSfxAbsent: plan.events
          .filter((event) => event.layoutId === "plain_single")
          .every((event) => !event.sound),
        depthLayoutsUsedOnlyWithMask: plan.events
          .filter((event) => event.maskRequired)
          .every(() => Boolean(plan.resources.mask)),
        textSceneDensity: plan.densityAssessment,
        strictTextSceneValidation: strictTextScenes
          ? "pass"
          : "not_run_required_for_production_delivery",
        phoneSizeVisualReview: "required",
        textAccuracyReview: "required",
        normalSpeedHumanReview: "required",
      },
    };
    manifest.digest = sha256Value({ ...manifest, digest: undefined });
    const manifestFile = path.resolve(option("--manifest", `${output}.manifest.json`));
    writeJsonAtomic(manifestFile, manifest);
    return { manifest, manifestFile };
  } finally {
    if (has("--keep-workdir")) console.error(`caption workdir kept: ${temporary}`);
    else fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (!["plan", "validate", "render"].includes(action)) {
  fail(
    "用法：caption_layout.mjs plan --input VIDEO --transcript JSON|SRT --output PLAN "
      + "[--mask MASK --font-registry REGISTRY]\n"
      + "  caption_layout.mjs validate --plan PLAN [--strict-text-scenes]\n"
      + "  caption_layout.mjs render --plan PLAN --output VIDEO [--sfx-root DIR]\n"
      + "字景 cue 可用 textScene.show/layout/anchor/progressMode；完整合同见 "
      + "docs/CINEMATIC_TEXT_SCENES_V1.md",
    2,
  );
}

try {
  if (action === "plan") {
    const input = path.resolve(option("--input", ""));
    const transcript = path.resolve(option("--transcript", ""));
    const output = path.resolve(option("--output", ""));
    const mask = option("--mask") ? path.resolve(option("--mask")) : null;
    const fontRegistry = option("--font-registry")
      ? path.resolve(option("--font-registry"))
      : null;
    if (!fs.existsSync(input)) fail(`输入不存在：${input}`, 2);
    if (!fs.existsSync(transcript)) fail(`转写不存在：${transcript}`, 2);
    if (mask && !fs.existsSync(mask)) fail(`蒙版不存在：${mask}`, 2);
    if (fontRegistry && !fs.existsSync(fontRegistry)) fail(`字体清单不存在：${fontRegistry}`, 2);
    if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖计划：${output}`, 2);
    const plan = planCaptionLayout({ input, transcript, output, mask, fontRegistry });
    const checked = validatePlan(output, has("--strict-text-scenes"));
    if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      output,
      eventCount: plan.events.length,
      layouts: [...new Set(plan.events.map((event) => event.layoutId))],
      fonts: plan.fonts,
      fallbackCount: plan.fallbackLog.length,
      densityAssessment: plan.densityAssessment,
      digest: plan.digest,
    }, null, 2));
  } else if (action === "validate") {
    const planFile = path.resolve(option("--plan", ""));
    if (!fs.existsSync(planFile)) fail(`计划不存在：${planFile}`, 2);
    const checked = validatePlan(planFile, has("--strict-text-scenes"));
    if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      plan: planFile,
      eventCount: checked.plan.events.length,
      warnings: checked.warnings,
      digest: checked.plan.digest,
    }, null, 2));
  } else {
    const planFile = path.resolve(option("--plan", ""));
    const output = path.resolve(option("--output", ""));
    const manifestFile = path.resolve(option("--manifest", `${output}.manifest.json`));
    if (!fs.existsSync(planFile)) fail(`计划不存在：${planFile}`, 2);
    if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖输出：${output}`, 2);
    if (fs.existsSync(manifestFile) && !has("--overwrite")) {
      fail(`拒绝覆盖渲染清单：${manifestFile}`, 2);
    }
    const result = renderPlan(planFile, output);
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: result.manifest.status,
      output,
      manifest: result.manifestFile,
      eventCount: result.manifest.events.length,
      sha256: result.manifest.output.sha256,
    }, null, 2));
  }
} catch (error) {
  fail(error.message);
}
