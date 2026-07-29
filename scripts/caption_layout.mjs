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

const sfxPeakCache = new Map();
function sfxPeakSeconds(file) {
  if (sfxPeakCache.has(file)) return sfxPeakCache.get(file);
  const measurement = run("ffmpeg", [
    "-hide_banner", "-loglevel", "info",
    "-i", file,
    "-af",
    "asetnsamples=n=1024:p=0,astats=metadata=1:reset=1,ametadata=print",
    "-f", "null", "-",
  ]);
  const lines = String(measurement.stderr ?? "").split(/\r?\n/);
  let time = 0;
  let bestTime = 0;
  let bestLevel = -Infinity;
  for (const line of lines) {
    const timeMatch = /pts_time:([0-9.]+)/.exec(line);
    if (timeMatch) time = Number(timeMatch[1]);
    const peakMatch = /lavfi\.astats\.Overall\.Peak_level=([-+0-9.]+)/.exec(line);
    if (peakMatch && Number(peakMatch[1]) > bestLevel) {
      bestLevel = Number(peakMatch[1]);
      bestTime = time;
    }
  }
  const value = Number.isFinite(bestLevel) ? bestTime : 0;
  sfxPeakCache.set(file, value);
  return value;
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
    .map((block) => {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) return null;
      const [start, end] = lines[timingIndex].split("-->").map(parseTimestamp);
      return {
        start,
        end,
        text: lines.slice(timingIndex + 1).join(" ").trim(),
      };
    })
    .filter(Boolean);
}

function readTranscript(file) {
  const extension = path.extname(file).toLowerCase();
  const raw = extension === ".srt"
    ? parseSrt(fs.readFileSync(file, "utf8"))
    : (() => {
      const value = readJson(file);
      return Array.isArray(value) ? value : value.cues ?? value.segments ?? value.items ?? [];
    })();
  return raw.map((cue, index) => ({
    ...cue,
    id: String(cue.id ?? `cue-${String(index + 1).padStart(4, "0")}`),
    start: parseTimestamp(cue.start ?? cue.startSeconds ?? cue.begin),
    end: parseTimestamp(cue.end ?? cue.endSeconds ?? cue.finish),
    text: String(cue.text ?? cue.transcript ?? cue.content ?? "").replace(/\s+/g, " ").trim(),
  })).filter((cue) => (
    Number.isFinite(cue.start)
    && Number.isFinite(cue.end)
    && cue.end > cue.start
    && cue.text
  )).sort((left, right) => left.start - right.start);
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
  return null;
}

function stripPunctuation(value) {
  return String(value ?? "").replace(/[“”"'‘’。.!！？?，,；;：:]/g, "").trim();
}

function shortText(value, maximum) {
  const text = stripPunctuation(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
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
    cue.captionLayout ?? cue.layoutId ?? cue.display?.layout ?? "",
  ).trim();
  if (!id || id === "auto") return null;
  if (!layoutsById.has(id)) throw new Error(`cue ${cue.id} 指定了不存在的字幕布局：${id}`);
  return { id, evidence: "explicit" };
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

function fontAliases(record) {
  return [
    ...(record.families ?? []),
    ...(record.fullNames ?? []),
    ...(record.postscriptNames ?? []),
  ];
}

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
    const familyIndex = role.preferredFamilies.findIndex((family) => {
      const requested = family.toLowerCase();
      return aliases.some(
        (name) => name === requested || name.includes(requested) || requested.includes(name),
      );
    });
    const classIndex = role.preferredClasses.findIndex(
      (fontClass) => record.classes?.includes(fontClass),
    );
    const weight = Number(record.weightClass ?? 400);
    return {
      record,
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
  }).sort((left, right) => left.score - right.score);
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
  const design = resolveDesignSystem({
    ...config.style,
    modes: {
      ...config.style.modes,
      aspectRatio: aspectMode(summary),
      surface: option("--surface", "footage"),
      language: option("--language", config.style.modes.language),
    },
  });
  const localRegistry = resolvedFontRegistry ? readJson(resolvedFontRegistry) : null;
  const routing = readJson(fontRoutingFile);
  const allowRestricted = has("--allow-restricted-fonts");
  const maskRecord = mask
    ? { path: path.resolve(mask), sha256: sha256File(mask) }
    : null;
  const events = [];
  const droppedOrFallback = [];
  const usedFonts = new Map();

  for (const cue of cues) {
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
    const display = {
      full: cue.text,
      emphasis: String(cue.emphasis ?? inferEmphasis(cue.text) ?? ""),
      left: String(cue.display?.left ?? splitContrast(cue.text)?.[0] ?? ""),
      right: String(cue.display?.right ?? splitContrast(cue.text)?.[1] ?? ""),
      top: String(cue.display?.top ?? ""),
      bottom: String(cue.display?.bottom ?? ""),
      background: String(cue.display?.background ?? ""),
      foreground: String(cue.display?.foreground ?? cue.text),
    };
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
    usedFonts.set(`${font.roleId}:${font.family}`, font);
    const startFrame = Math.max(0, Math.round(cue.start * summary.averageFps));
    const endFrame = Math.min(
      Math.round(summary.videoDuration * summary.averageFps),
      Math.round(cue.end * summary.averageFps),
    );
    const entryFrames = Math.min(
      6,
      Math.max(1, registry.globalRules.entryLeadFrames),
    );
    const peakFrame = Math.min(endFrame - 1, startFrame + entryFrames);
    events.push({
      id: `caption-${String(events.length + 1).padStart(4, "0")}`,
      cueId: cue.id,
      startSeconds: startFrame / summary.averageFps,
      endSeconds: endFrame / summary.averageFps,
      startFrame,
      endFrame,
      peakFrame,
      layoutId: layout.id,
      trigger: layout.trigger,
      function: layout.function,
      selectionEvidence: selection.evidence,
      display,
      font,
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

  const plan = {
    schemaVersion: "1.0",
    kind: "kacha_spoken_caption_timeline",
    status: "planned_not_rendered",
    generatedAt: new Date().toISOString(),
    source: {
      input: {
        path: path.resolve(input),
        sha256: sha256File(input),
        width: summary.width,
        height: summary.height,
        fps: summary.averageFps,
        duration: summary.videoDuration,
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
      palette: design.style.palette,
      subtitles: design.style.subtitles,
    },
    policy: {
      ...registry.globalRules,
      preserveSourceGeometry: true,
      explicitRestrictedFontAuthorization: allowRestricted,
      publicFontRedistribution: false,
    },
    fonts: [...usedFonts.values()],
    events,
    fallbackLog: droppedOrFallback,
    registry: {
      id: registry.id,
      sha256: sha256File(registryFile),
    },
  };
  plan.digest = sha256Value({ ...plan, digest: undefined });
  writeJsonAtomic(output, plan);
  return plan;
}

function validatePlan(planFile) {
  const plan = readJson(planFile);
  const registry = readJson(registryFile);
  const layoutsById = new Map(registry.layouts.map((layout) => [layout.id, layout]));
  const errors = [];
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
  let previousEnd = -1;
  for (const [index, event] of (plan.events ?? []).entries()) {
    const label = `events[${index}]`;
    const layout = layoutsById.get(event.layoutId);
    if (!layout) errors.push(`${label}.layoutId 未注册`);
    if (!(event.startFrame >= 0 && event.endFrame > event.startFrame)) {
      errors.push(`${label} 帧区间无效`);
    }
    if (event.startFrame < previousEnd) errors.push(`${label} 与上一字幕 cue 重叠`);
    previousEnd = event.endFrame;
    if (!event.font?.family) errors.push(`${label}.font.family 缺失`);
    if (event.font?.file) {
      if (!fs.existsSync(event.font.file)) errors.push(`${label}.font.file 不存在`);
      else if (sha256File(event.font.file) !== event.font.sha256) {
        errors.push(`${label}.font.sha256 已失效`);
      }
      if (
        event.font.projectLicenseReviewRequired
        && !plan.policy.explicitRestrictedFontAuthorization
      ) {
        errors.push(`${label} 使用限制性字体但没有项目授权确认`);
      }
    }
    if (layout?.maskRequired) {
      const mask = plan.resources?.mask;
      if (!mask?.path || !fs.existsSync(mask.path)) errors.push(`${label} 缺少人物蒙版`);
      else if (sha256File(mask.path) !== mask.sha256) errors.push(`${label} 蒙版已失效`);
    }
    if (event.sound) {
      const level = Number(event.sound.levelRelativeToDialogueDb);
      if (!Number.isFinite(level) || level < -24 || level > -6) {
        errors.push(`${label}.sound 电平必须为 -24 至 -6 dB`);
      }
    }
  }
  if (!Array.isArray(plan.events) || plan.events.length === 0) errors.push("events 不能为空");
  if (plan.policy?.singleLinePerReadingZone !== true) {
    errors.push("每个阅读区必须保持单行");
  }
  if (plan.policy?.ordinarySubtitleSfx !== "none") {
    errors.push("普通连续字幕不得逐卡添加音效");
  }
  const expectedDigest = sha256Value({ ...plan, digest: undefined });
  if (expectedDigest !== plan.digest) errors.push("计划 digest 不一致");
  return { plan, errors };
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
            + assEscape(shortText(event.display.background, 2)),
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
            + assEscape(shortText(event.display.background, 4)),
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
          + assEscape(shortText(event.display.left, 10)),
      ));
      events.push(dialogue(
        start + 0.08,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${size}\\an5\\c${accent}\\move(${Math.round(width * 0.88)},${y},`
          + `${Math.round(width * 0.75)},${y},0,180)${fade}}`
          + assEscape(shortText(event.display.right, 10)),
      ));
    } else if (event.layoutId === "side_vertical_labels") {
      const size = Math.round(height * 0.046);
      const y = Math.round(height * 0.49);
      events.push(dialogue(
        start,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${size}\\an5\\c${primary}\\frz270\\pos(${Math.round(width * 0.09)},${y})${fade}}`
          + assEscape(shortText(event.display.left, 6)),
      ));
      events.push(dialogue(
        start + 0.08,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${size}\\an5\\c${accent}\\frz90\\pos(${Math.round(width * 0.91)},${y})${fade}}`
          + assEscape(shortText(event.display.right, 6)),
      ));
    } else if (event.layoutId === "top_bottom_hierarchy") {
      events.push(dialogue(
        start,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${Math.round(displaySize * 0.76)}\\b1\\an8\\c${primary}`
          + `\\pos(${centerX},${Math.round(height * 0.12)})${fade}}`
          + assEscape(shortText(event.display.top, 10)),
      ));
      events.push(dialogue(
        start + 0.1,
        end,
        "KachaPrimary",
        `{\\fn${family}\\fs${Math.round(displaySize * 0.54)}\\an5\\c${accent}`
          + `\\pos(${centerX},${Math.round(height * 0.64)})${fade}}`
          + assEscape(shortText(event.display.bottom, 14)),
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
          + assEscape(shortText(event.display.foreground, 8)),
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
  const checked = validatePlan(planFile);
  if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
  const { plan } = checked;
  const input = plan.source.input.path;
  const summary = mediaSummary(input);
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

    const config = loadKachaConfig({ args, anchorPath: input, includeSecrets: false }).config;
    const configuredRoot = config.tools.sfxLibrary;
    const sfxRoot = option("--sfx-root")
      ? path.resolve(option("--sfx-root"))
      : configuredRoot
        ? path.resolve(configuredRoot)
        : bundledSfxRoot;
    const sfxItems = plan.events.map((event) => {
      const resolved = resolveSfxAsset(event.sound?.trigger, sfxRoot);
      return resolved
        ? { event, ...resolved, sourcePeakSeconds: sfxPeakSeconds(resolved.file) }
        : null;
    }).filter(Boolean);
    const finalArgs = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", videoOnly,
    ];
    if (summary.audio) finalArgs.push("-i", input);
    for (const item of sfxItems) finalArgs.push("-i", item.file);
    if (!summary.audio) {
      finalArgs.push("-map", "0:v:0", "-c:v", "copy", "-an");
    } else if (sfxItems.length === 0 || has("--no-sfx")) {
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
      events: plan.events.map((event) => ({
        id: event.id,
        layoutId: event.layoutId,
        font: event.font,
        soundAssetId: resolveSfxAsset(event.sound?.trigger, sfxRoot)?.asset.id ?? null,
      })),
      sfxPeakAlignmentPlan: sfxItems.map((item) => ({
        eventId: item.event.id,
        eventPeakSeconds: item.event.sound.peakSeconds,
        sourcePeakSeconds: item.sourcePeakSeconds,
        placedAtSeconds: Math.max(
          0,
          item.event.sound.peakSeconds - item.sourcePeakSeconds,
        ),
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
        phoneSizeVisualReview: "required",
        textAccuracyReview: "required",
      },
    };
    manifest.digest = sha256Value({ ...manifest, digest: undefined });
    const manifestFile = option("--manifest", `${output}.manifest.json`);
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
      + "  caption_layout.mjs validate --plan PLAN\n"
      + "  caption_layout.mjs render --plan PLAN --output VIDEO [--sfx-root DIR]",
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
    const checked = validatePlan(output);
    if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      output,
      eventCount: plan.events.length,
      layouts: [...new Set(plan.events.map((event) => event.layoutId))],
      fonts: plan.fonts,
      fallbackCount: plan.fallbackLog.length,
      digest: plan.digest,
    }, null, 2));
  } else if (action === "validate") {
    const planFile = path.resolve(option("--plan", ""));
    if (!fs.existsSync(planFile)) fail(`计划不存在：${planFile}`, 2);
    const checked = validatePlan(planFile);
    if (checked.errors.length > 0) throw new Error(checked.errors.join("\n"));
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      plan: planFile,
      eventCount: checked.plan.events.length,
      digest: checked.plan.digest,
    }, null, 2));
  } else {
    const planFile = path.resolve(option("--plan", ""));
    const output = path.resolve(option("--output", ""));
    if (!fs.existsSync(planFile)) fail(`计划不存在：${planFile}`, 2);
    if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖输出：${output}`, 2);
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
