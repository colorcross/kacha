import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256File, sha256Value } from "./kacha_utils.mjs";
import { loadStyleProfile } from "./style_profile.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const designSystemRoot = path.join(
  path.resolve(scriptDirectory, ".."),
  "config",
  "design-system",
);
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const FONT_ROLES = [
  "display",
  "subtitlePrimary",
  "subtitleSecondary",
  "label",
  "body",
  "coverTitle",
];
const installedFontFamiliesCache = new Map();

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function deepMerge(left, right) {
  if (!isObject(left) || !isObject(right)) return clone(right);
  const result = clone(left);
  for (const [key, value] of Object.entries(right)) {
    result[key] = isObject(value) && isObject(result[key])
      ? deepMerge(result[key], value)
      : clone(value);
  }
  return result;
}

function readRegistry(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function valueAtPath(value, tokenPath) {
  let current = value;
  for (const key of tokenPath.split(".")) {
    if (!isObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function requireString(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${label} 必须是非空字符串`);
}

function requireArray(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) errors.push(`${label} 必须是非空数组`);
}

function registryIds(items, label, errors) {
  if (!Array.isArray(items) || items.length === 0) {
    errors.push(`${label} 必须是非空数组`);
    return new Set();
  }
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    if (!ID.test(String(item?.id ?? ""))) errors.push(`${label}[${index}].id 格式无效`);
    if (ids.has(item?.id)) errors.push(`${label}[${index}].id 重复：${item?.id}`);
    ids.add(item?.id);
  }
  return ids;
}

function validateFallbackGraph(items, label, errors) {
  const graph = new Map(items.map((item) => [item.id, item.fallback]));
  for (const item of items) {
    const seen = new Map();
    const trail = [];
    let current = item.id;
    while (current && current !== "none" && graph.has(current)) {
      if (seen.has(current)) {
        const cycle = [...trail.slice(seen.get(current)), current].join(" -> ");
        errors.push(`${label} fallback 存在循环：${cycle}`);
        break;
      }
      seen.set(current, trail.length);
      trail.push(current);
      current = graph.get(current);
    }
  }
}

function semverParts(value) {
  if (!SEMVER.test(String(value ?? ""))) return null;
  return String(value).split(".").map(Number);
}

function semverAtLeast(actual, minimum) {
  const left = semverParts(actual);
  const right = semverParts(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function normalizeFontName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replaceAll("\\-", "-")
    .trim()
    .toLowerCase();
}

function installedFontCacheKey() {
  const directories = [
    process.env.KACHA_FONTS_DIR,
    path.resolve(scriptDirectory, "..", "..", "Fonts"),
  ].filter(Boolean).map((directory) => {
    const resolvedDirectory = path.resolve(directory);
    try {
      const stat = fs.statSync(resolvedDirectory);
      const files = fs.readdirSync(resolvedDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(?:ttf|otf|ttc)$/i.test(entry.name))
        .map((entry) => {
          const fileStat = fs.statSync(path.join(resolvedDirectory, entry.name));
          return [entry.name, fileStat.size, fileStat.mtimeMs, fileStat.ctimeMs];
        })
        .sort(([left], [right]) => left.localeCompare(right));
      return [resolvedDirectory, stat.mtimeMs, stat.size, files];
    } catch {
      return [resolvedDirectory, null, null, []];
    }
  });
  return JSON.stringify({
    platform: process.platform,
    path: process.env.PATH ?? "",
    directories,
  });
}

function cacheInstalledFonts(key, result) {
  if (!installedFontFamiliesCache.has(key) && installedFontFamiliesCache.size >= 8) {
    installedFontFamiliesCache.delete(installedFontFamiliesCache.keys().next().value);
  }
  installedFontFamiliesCache.set(key, {
    probe: result.probe,
    error: result.error,
    families: [...result.families.entries()],
  });
  return result;
}

function installedFontFamilies() {
  const cacheKey = installedFontCacheKey();
  const cached = installedFontFamiliesCache.get(cacheKey);
  if (cached) {
    return {
      probe: cached.probe,
      error: cached.error,
      families: new Map(cached.families),
    };
  }
  const addProjectFonts = (families) => {
    const scanCommand = [
      "/opt/homebrew/bin/fc-scan",
      "/usr/local/bin/fc-scan",
      "/usr/bin/fc-scan",
    ].find((candidate) => fs.existsSync(candidate)) ?? "fc-scan";
    const candidates = [
      process.env.KACHA_FONTS_DIR,
      path.resolve(scriptDirectory, "..", "..", "Fonts"),
    ].filter(Boolean);
    for (const directory of candidates) {
      if (!fs.existsSync(directory)) continue;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(?:ttf|otf|ttc)$/i.test(entry.name)) continue;
        const file = path.join(directory, entry.name);
        const scan = spawnSync(scanCommand, ["--format", "%{family}", file], {
          encoding: "utf8",
          timeout: 10000,
        });
        if (scan.status !== 0) continue;
        for (const family of scan.stdout.split(",")) {
          const trimmed = family.replaceAll("\\-", "-").trim();
          if (trimmed) families.set(normalizeFontName(trimmed), trimmed);
        }
      }
    }
  };
  const result = spawnSync("fc-list", [":", "family"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.status === 0) {
    const families = new Map();
    for (const line of result.stdout.split(/\r?\n/)) {
      for (const family of line.split(",")) {
        const trimmed = family.replaceAll("\\-", "-").trim();
        if (trimmed) families.set(normalizeFontName(trimmed), trimmed);
      }
    }
    addProjectFonts(families);
    return cacheInstalledFonts(
      cacheKey,
      { probe: "fc-list+project-fonts", families, error: null },
    );
  }
  if (process.platform === "darwin") {
    const profiler = spawnSync(
      "system_profiler",
      ["SPFontsDataType", "-json"],
      { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (profiler.status === 0) {
      const families = new Map();
      const familyKeys = new Set(["_name", "family", "fullname", "typeface"]);
      const visit = (value, key = "") => {
        if (typeof value === "string" && familyKeys.has(key)) {
          const trimmed = value.trim();
          if (trimmed) families.set(normalizeFontName(trimmed), trimmed);
          return;
        }
        if (Array.isArray(value)) {
          value.forEach((item) => visit(item, key));
          return;
        }
        if (isObject(value)) {
          Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
        }
      };
      visit(JSON.parse(profiler.stdout));
      if (families.size > 0) {
        addProjectFonts(families);
        return cacheInstalledFonts(
          cacheKey,
          { probe: "system_profiler", families, error: null },
        );
      }
    }
    return cacheInstalledFonts(cacheKey, {
      probe: "unavailable",
      families: new Map(),
      error: [
        String(result.stderr || "fc-list unavailable").trim(),
        String(profiler.stderr || "system_profiler returned no font families").trim(),
      ].filter(Boolean).join("; "),
    });
  }
  return cacheInstalledFonts(cacheKey, {
    probe: "unavailable",
    families: new Map(),
    error: String(result.stderr || "fc-list unavailable").trim(),
  });
}

export function resolveDesignFonts(style) {
  const available = installedFontFamilies();
  const roles = {};
  const warnings = [];
  for (const role of FONT_ROLES) {
    const requested = style?.typography?.[role]?.families ?? [];
    const match = requested.find(
      (family) => available.families.has(normalizeFontName(family)),
    );
    const resolved = match
      ? available.families.get(normalizeFontName(match))
      : requested[0] ?? null;
    const verified = Boolean(match);
    roles[role] = {
      requested,
      resolved,
      verified,
      fallbackUsed: match ? requested.indexOf(match) > 0 : null,
    };
    if (!verified) {
      warnings.push(
        `${role} 未找到已安装字体；暂用未验证首选项 ${resolved ?? "none"}`,
      );
    }
  }
  return {
    probe: available.probe,
    error: available.error,
    roles,
    warnings,
    digest: sha256Value({ probe: available.probe, roles }),
  };
}

export function validateDesignSystem(bundle) {
  const errors = [];
  const {
    system,
    modes,
    components,
    scenes,
    implementations,
    capabilityRegistries,
    baseStyle,
  } = bundle;
  if (system?.schemaVersion !== "1.0") errors.push("system.schemaVersion 必须为 1.0");
  if (!ID.test(String(system?.id ?? ""))) errors.push("system.id 格式无效");
  requireString(system?.version, "system.version", errors);
  requireString(system?.styleProfile, "system.styleProfile", errors);
  for (const key of ["modes", "components", "scenes", "implementations"]) {
    requireString(system?.registries?.[key], `system.registries.${key}`, errors);
  }
  if (!SEMVER.test(String(system?.version ?? ""))) {
    errors.push("system.version 必须使用 x.y.z");
  }
  if (implementations?.schemaVersion !== "1.0") {
    errors.push("implementations.schemaVersion 必须为 1.0");
  }
  const semanticNetstyle = capabilityRegistries?.semanticNetstyle;
  if (semanticNetstyle) {
    if (semanticNetstyle.schemaVersion !== "1.0") {
      errors.push("capabilityRegistries.semanticNetstyle.schemaVersion 必须为 1.0");
    }
    if (
      semanticNetstyle.id !== "z-en-netstyle"
      || !Array.isArray(semanticNetstyle.effects)
      || semanticNetstyle.effects.length !== 33
    ) {
      errors.push("semanticNetstyle 必须注册 z-en-netstyle 的 33 个机制");
    }
  }
  const spokenCaptionLayouts = capabilityRegistries?.spokenCaptionLayouts;
  if (
    spokenCaptionLayouts?.schemaVersion !== "1.0"
    || spokenCaptionLayouts?.id !== "spoken-caption-layouts"
    || !Array.isArray(spokenCaptionLayouts?.layouts)
    || spokenCaptionLayouts.layouts.length < 7
  ) {
    errors.push("spokenCaptionLayouts 必须注册至少 7 种可执行口播字幕布局");
  }
  const visualBreathing = capabilityRegistries?.visualBreathing;
  if (
    visualBreathing?.schemaVersion !== "1.0"
    || visualBreathing?.id !== "visual-breathing"
    || !Array.isArray(visualBreathing?.motions)
    || visualBreathing.motions.length < 5
  ) {
    errors.push("visualBreathing 必须注册至少 5 种运动与停稳机制");
  }
  const fontRouting = capabilityRegistries?.fontRouting;
  if (
    fontRouting?.schemaVersion !== "2.0"
    || fontRouting?.id !== "kacha-font-routing"
    || !isObject(fontRouting?.roles)
    || Object.keys(fontRouting.roles).length < 7
  ) {
    errors.push("fontRouting 2.0 必须注册四类限定字体的至少 7 个语义角色");
  }
  const requiredVisualLanguageIds = [
    "xingzhe-light-overlay",
    "xingzhe-spatial-lightpath",
    "xingzhe-humor-comic",
    "xingzhe-pixel-editorial",
    "xingzhe-dark-tech",
  ];
  if (
    !Array.isArray(fontRouting?.scope)
    || requiredVisualLanguageIds.some((styleId) => !fontRouting.scope.includes(styleId))
  ) {
    errors.push("fontRouting.scope 必须覆盖浅暖轻浮层、空间光路、幽默漫画、像素风和暗黑科技风五套风格");
  }
  const visualLanguages = capabilityRegistries?.visualLanguages;
  if (
    visualLanguages?.schemaVersion !== "1.0"
    || visualLanguages?.id !== "kacha-visual-languages"
    || visualLanguages?.parentProfile !== "xingzhe"
    || visualLanguages?.defaultSelectionMode !== "automatic"
    || visualLanguages?.noMatchFallback !== "clean_frame_or_plain_caption"
    || Object.hasOwn(visualLanguages ?? {}, "default")
    || !isObject(visualLanguages?.languages)
    || !visualLanguages.languages["xingzhe-light-overlay"]
    || !visualLanguages.languages["xingzhe-spatial-lightpath"]
    || !visualLanguages.languages["xingzhe-humor-comic"]
    || !visualLanguages.languages["xingzhe-pixel-editorial"]
    || !visualLanguages.languages["xingzhe-dark-tech"]
  ) {
    errors.push("visualLanguages 必须绑定行者风、默认按语义选择且注册五套可执行视觉语言；不得声明全局默认风格");
  }
  for (const styleId of requiredVisualLanguageIds) {
    const language = visualLanguages?.languages?.[styleId];
    const applicability = language?.applicability;
    if (
      !applicability?.selectionRule
      || !Array.isArray(applicability.requiredSignals)
      || applicability.requiredSignals.length < 3
      || applicability.minimumMatchedSignals !== 1
      || !applicability.fallback
      || !["matchedSignal", "semanticBeatId", "sourceRange", "fallbackReasonWhenNotApplied"]
        .every((field) => applicability.runtimeEvidenceRequired?.includes(field))
    ) {
      errors.push(`visualLanguages.${styleId}.applicability 缺少可执行选择、证据或回退合同`);
    }
    const signature = language?.grammarSignature;
    const grammar = language?.editingGrammar;
    const signatureFields = [
      "id",
      "temporalModel",
      "shotUnit",
      "spatialModel",
      "primaryTransition",
      "textBehavior",
      "audioCadence",
      "stillnessPolicy",
    ];
    if (
      !isObject(signature)
      || signatureFields.some((field) => typeof signature[field] !== "string" || !signature[field].trim())
      || !isObject(grammar)
      || !Array.isArray(grammar.sequence)
      || grammar.sequence.length < 5
      || ["camera", "topology", "cutPolicy", "transitionPolicy", "soundPolicy"]
        .some((field) => typeof grammar[field] !== "string" || !grammar[field].trim())
      || !Array.isArray(grammar.forbidSharedPatterns)
      || grammar.forbidSharedPatterns.length < 4
    ) {
      errors.push(`visualLanguages.${styleId} 缺少完整且可执行的剪辑语法签名`);
    }
  }
  const grammarSignatures = requiredVisualLanguageIds
    .map((styleId) => visualLanguages?.languages?.[styleId]?.grammarSignature)
    .filter(Boolean);
  if (new Set(grammarSignatures.map((signature) => signature.id)).size !== requiredVisualLanguageIds.length) {
    errors.push("五套视觉语言的 grammarSignature.id 必须互不相同");
  }
  const differentiatingAxes = [
    "temporalModel",
    "shotUnit",
    "spatialModel",
    "primaryTransition",
    "textBehavior",
    "audioCadence",
    "stillnessPolicy",
  ];
  for (let leftIndex = 0; leftIndex < grammarSignatures.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < grammarSignatures.length; rightIndex += 1) {
      const sharedAxes = differentiatingAxes.filter(
        (axis) => grammarSignatures[leftIndex]?.[axis] === grammarSignatures[rightIndex]?.[axis],
      );
      if (sharedAxes.length > 1) {
        errors.push(`五套视觉语言不能只做材质换皮；剪辑语法重复轴：${sharedAxes.join("、")}`);
      }
    }
  }
  const antiWeb = capabilityRegistries?.antiWeb;
  const requiredAntiWebMechanisms = [
    "clean_a_roll",
    "camera_reframe",
    "real_evidence_cutaway",
    "foreground_occlusion",
    "boundaryless_typography",
    "bounded_information_surface",
  ];
  const requiredShowIds = [
    "tool-share",
    "book-talk",
    "infinite-game",
    "very-ai",
    "casual-chat",
  ];
  const forbiddenWebPatterns = [
    "web_hero",
    "centered_modal",
    "dashboard_grid",
    "card_wall",
    "card_to_card_transition",
  ];
  if (
    antiWeb?.schemaVersion !== "1.0"
    || antiWeb?.id !== "xingzhe-cinematic-editorial"
    || antiWeb?.parentProfile !== "xingzhe"
    || !Array.isArray(antiWeb?.selectionOrder)
    || antiWeb.selectionOrder.at(-1) !== "bounded_information_surface"
    || !requiredAntiWebMechanisms.every((item) => antiWeb?.cinematicMechanisms?.includes(item))
    || !forbiddenWebPatterns.every((item) => antiWeb?.forbiddenPatterns?.includes(item))
    || antiWeb?.globalRules?.realPictureBeforeGraphicContainer !== true
    || antiWeb?.globalRules?.boundarylessBeforeBounded !== true
    || antiWeb?.globalRules?.noAdjacentBoundedSurfaces !== true
    || antiWeb?.globalRules?.staticPeakFrameIsNotAcceptance !== true
    || !requiredShowIds.every((showId) => isObject(antiWeb?.showBudgets?.[showId]))
    || !requiredVisualLanguageIds.every(
      (styleId) => Array.isArray(antiWeb?.styleGrammarMechanisms?.[styleId])
        && antiWeb.styleGrammarMechanisms[styleId].length >= 5,
    )
  ) {
    errors.push("antiWeb 必须注册行者风 3.0 的电影化优先级、栏目预算、五风格机制和反网页禁用模式");
  }
  for (const showId of requiredShowIds) {
    const budget = antiWeb?.showBudgets?.[showId];
    const realPicture = Number(budget?.minimumRealPictureRatio);
    const bounded = Number(budget?.maximumBoundedSurfaceRatio);
    if (
      !Number.isFinite(realPicture)
      || realPicture < 0.65
      || realPicture > 1
      || !Number.isFinite(bounded)
      || bounded < 0
      || bounded > 0.25
      || Number(budget?.maximumDashboardRatio) !== 0
      || Number(budget?.minimumDistinctMechanismsPer120Seconds) < 3
    ) {
      errors.push(`antiWeb.showBudgets.${showId} 未落实真实画面、容器上限、零仪表盘和机制多样性`);
    }
  }
  const effectTemplates = capabilityRegistries?.effectTemplates;
  if (
    effectTemplates?.schemaVersion !== "1.0"
    || effectTemplates?.id !== "kacha-effect-templates"
    || !isObject(effectTemplates?.families)
    || Object.keys(effectTemplates.families).length < 9
    || !Array.isArray(effectTemplates?.bindingRules)
    || effectTemplates.bindingRules.length < 5
  ) {
    errors.push("effectTemplates 必须注册至少 9 个效果家族和 5 组绑定规则");
  }
  const resourceCatalog = capabilityRegistries?.resourceCatalog;
  if (
    resourceCatalog?.schemaVersion !== "1.0"
    || resourceCatalog?.id !== "kacha-core-resources"
    || !Array.isArray(resourceCatalog?.assets)
    || resourceCatalog.assets.length < 15
    || !Array.isArray(resourceCatalog?.logicalSlots)
    || resourceCatalog.logicalSlots.length < 8
  ) {
    errors.push("resourceCatalog 必须注册至少 15 个核心资源和 8 个逻辑槽位");
  }
  const rendererIds = registryIds(
    implementations?.renderers,
    "implementations.renderers",
    errors,
  );
  const layoutIds = registryIds(
    implementations?.layouts,
    "implementations.layouts",
    errors,
  );
  const motionIds = registryIds(
    implementations?.motions,
    "implementations.motions",
    errors,
  );
  for (const [index, renderer] of (implementations?.renderers ?? []).entries()) {
    const label = `implementations.renderers[${index}]`;
    requireString(renderer?.adapter, `${label}.adapter`, errors);
    requireArray(renderer?.outputs, `${label}.outputs`, errors);
    if (renderer?.requiresMedia !== true && renderer?.requiresMedia !== false) {
      errors.push(`${label}.requiresMedia 必须是 boolean`);
    }
    if (renderer?.status !== "production") {
      errors.push(`${label}.status 必须为 production`);
    }
  }
  for (const [index, layout] of (implementations?.layouts ?? []).entries()) {
    requireString(layout?.template, `implementations.layouts[${index}].template`, errors);
  }
  for (const [index, motion] of (implementations?.motions ?? []).entries()) {
    requireString(motion?.family, `implementations.motions[${index}].family`, errors);
  }

  const dimensions = modes?.dimensions;
  if (modes?.schemaVersion !== "1.0") errors.push("modes.schemaVersion 必须为 1.0");
  if (!isObject(dimensions)) errors.push("modes.dimensions 必须是 object");
  const requiredDimensions = ["show", "aspectRatio", "language", "surface", "density"];
  for (const dimension of requiredDimensions) {
    if (!isObject(dimensions?.[dimension])) {
      errors.push(`modes.dimensions.${dimension} 必须是 object`);
      continue;
    }
    const defaultMode = system?.defaultModes?.[dimension];
    if (!Object.hasOwn(dimensions[dimension], defaultMode)) {
      errors.push(`system.defaultModes.${dimension} 不存在：${defaultMode}`);
    }
    for (const [modeId, mode] of Object.entries(dimensions[dimension])) {
      if (!ID.test(modeId)) errors.push(`mode id 格式无效：${dimension}.${modeId}`);
      requireString(mode?.label, `modes.${dimension}.${modeId}.label`, errors);
      if (mode.styleOverrides !== undefined && !isObject(mode.styleOverrides)) {
        errors.push(`modes.${dimension}.${modeId}.styleOverrides 必须是 object`);
      }
    }
  }

  if (components?.schemaVersion !== "1.0") {
    errors.push("components.schemaVersion 必须为 1.0");
  }
  const componentItems = Array.isArray(components?.components)
    ? components.components
    : [];
  if (componentItems.length === 0) errors.push("components.components 不能为空");
  const componentIds = new Set();
  const componentById = new Map();
  for (const [index, component] of componentItems.entries()) {
    const label = `components[${index}]`;
    if (!ID.test(String(component?.id ?? ""))) errors.push(`${label}.id 格式无效`);
    if (componentIds.has(component?.id)) errors.push(`${label}.id 重复：${component?.id}`);
    componentIds.add(component?.id);
    componentById.set(component?.id, component);
    for (const key of ["label", "category", "renderer"]) {
      requireString(component?.[key], `${label}.${key}`, errors);
    }
    if (!rendererIds.has(component?.renderer)) {
      errors.push(`${label}.renderer 未注册：${component?.renderer}`);
    }
    for (const key of ["slots", "states", "tokenRefs", "safety"]) {
      requireArray(component?.[key], `${label}.${key}`, errors);
    }
    for (const tokenRef of component?.tokenRefs ?? []) {
      if (valueAtPath(baseStyle, tokenRef) === undefined) {
        errors.push(`${label}.tokenRefs 不存在：${tokenRef}`);
      }
    }
    if (
      component?.category === "card"
      && ![
        "boundaryless_editorial",
        "boundaryless_progressive",
        "full_bleed_editorial",
        "edge_warning",
        "bounded_source",
        "split_evidence",
        "boundaryless_metric",
      ].includes(component?.presentation)
    ) {
      errors.push(`${label}.presentation 必须声明电影化边界策略，不能使用未分类网页卡片`);
    }
    if (
      component?.id === "subject_safe_popup"
      && component?.presentation !== "boundaryless_dialogue"
    ) {
      errors.push(`${label}.presentation 必须使用无容器人物关系回应`);
    }
  }
  for (const [index, component] of componentItems.entries()) {
    if (
      component.fallback !== "none"
      && !componentIds.has(component.fallback)
    ) {
      errors.push(`components[${index}].fallback 不存在：${component.fallback}`);
    }
  }
  validateFallbackGraph(componentItems, "component", errors);

  if (scenes?.schemaVersion !== "1.0") errors.push("scenes.schemaVersion 必须为 1.0");
  const sceneItems = Array.isArray(scenes?.scenes) ? scenes.scenes : [];
  if (sceneItems.length === 0) errors.push("scenes.scenes 不能为空");
  const sceneIds = new Set();
  for (const [index, scene] of sceneItems.entries()) {
    const label = `scenes[${index}]`;
    if (!ID.test(String(scene?.id ?? ""))) errors.push(`${label}.id 格式无效`);
    if (sceneIds.has(scene?.id)) errors.push(`${label}.id 重复：${scene?.id}`);
    sceneIds.add(scene?.id);
    for (const key of ["label", "category", "trigger", "layout", "entry", "exit"]) {
      requireString(scene?.[key], `${label}.${key}`, errors);
    }
    if (!layoutIds.has(scene?.layout)) {
      errors.push(`${label}.layout 未注册：${scene?.layout}`);
    }
    for (const field of ["entry", "exit"]) {
      if (!motionIds.has(scene?.[field])) {
        errors.push(`${label}.${field} 未注册：${scene?.[field]}`);
      }
    }
    requireArray(scene?.components, `${label}.components`, errors);
    for (const componentId of scene?.components ?? []) {
      if (!componentIds.has(componentId)) {
        errors.push(`${label}.components 不存在：${componentId}`);
      }
    }
    const sceneComponents = (scene?.components ?? [])
      .map((componentId) => componentById.get(componentId))
      .filter(Boolean);
    const hasCardOrPopup = sceneComponents.some(
      (component) => component.category === "card" || component.id === "subject_safe_popup",
    );
    if (hasCardOrPopup && scene?.entry === "soft_pop") {
      errors.push(`${label} 不能把 soft_pop 作为卡片或回应模块的默认入场`);
    }
    if (scene?.layout === "subject_left_card_right") {
      errors.push(`${label} 禁止把“左人右卡”作为正式场景构图`);
    }
    if (
      ["info_single", "info_bullets", "info_three_reasons", "info_definition", "info_warning"]
        .includes(scene?.id)
      && ["full_screen", "full_screen_or_subject_safe", "subject_safe_side", "subject_safe_right"]
        .includes(scene?.layout)
    ) {
      errors.push(`${label} 高频解释场景必须优先使用负空间、编辑边缘或真实画面关系`);
    }
  }
  for (const [index, scene] of sceneItems.entries()) {
    if (scene.fallback !== "none" && !sceneIds.has(scene.fallback)) {
      errors.push(`scenes[${index}].fallback 不存在：${scene.fallback}`);
    }
  }
  validateFallbackGraph(sceneItems, "scene", errors);

  if (baseStyle?.designSystem?.id !== system?.id) {
    errors.push(
      `styleProfile.designSystem.id 必须为 ${system?.id}，当前 ${baseStyle?.designSystem?.id}`,
    );
  }
  if (!semverAtLeast(system?.version, baseStyle?.designSystem?.minimumVersion)) {
    errors.push(
      `design system ${system?.version} 低于 style profile 最低版本 `
      + `${baseStyle?.designSystem?.minimumVersion}`,
    );
  }

  if (componentItems.length < 40) {
    errors.push(`组件覆盖不足：至少 40 个，当前 ${componentItems.length}`);
  }
  if (sceneItems.length < 50) {
    errors.push(`场景覆盖不足：至少 50 个，当前 ${sceneItems.length}`);
  }
  return errors;
}

export function loadDesignSystem(systemId = "dahui-video-system") {
  if (!ID.test(String(systemId))) throw new Error(`设计系统 id 无效：${systemId}`);
  const systemFile = path.join(designSystemRoot, "system.json");
  const system = readRegistry(systemFile);
  if (system.id !== systemId) throw new Error(`设计系统不存在：${systemId}`);
  const modesFile = path.join(designSystemRoot, system.registries.modes);
  const componentsFile = path.join(designSystemRoot, system.registries.components);
  const scenesFile = path.join(designSystemRoot, system.registries.scenes);
  const implementationsFile = path.join(
    designSystemRoot,
    system.registries.implementations,
  );
  const capabilityRegistryFiles = Object.fromEntries(
    Object.entries(system.capabilityRegistries ?? {}).map(([id, relativeFile]) => [
      id,
      path.resolve(designSystemRoot, relativeFile),
    ]),
  );
  const rendererCodeFile = path.join(scriptDirectory, "design_renderers.mjs");
  const resolverCodeFile = fileURLToPath(import.meta.url);
  const styleResolverCodeFile = path.join(scriptDirectory, "style_profile.mjs");
  const commandCodeFile = path.join(scriptDirectory, "kacha_design.mjs");
  const modes = readRegistry(modesFile);
  const components = readRegistry(componentsFile);
  const scenes = readRegistry(scenesFile);
  const implementations = readRegistry(implementationsFile);
  const capabilityRegistries = Object.fromEntries(
    Object.entries(capabilityRegistryFiles).map(([id, file]) => [
      id,
      readRegistry(file),
    ]),
  );
  const baseStyle = loadStyleProfile(system.styleProfile, {}).profile;
  const rendererCodeSha256 = sha256File(rendererCodeFile);
  const resolverCodeSha256 = sha256File(resolverCodeFile);
  const styleResolverCodeSha256 = sha256File(styleResolverCodeFile);
  const commandCodeSha256 = sha256File(commandCodeFile);
  const implementationDigest = sha256Value([
    { name: "design_renderers.mjs", sha256: rendererCodeSha256 },
    { name: "design_system.mjs", sha256: resolverCodeSha256 },
    { name: "style_profile.mjs", sha256: styleResolverCodeSha256 },
    { name: "kacha_design.mjs", sha256: commandCodeSha256 },
  ]);
  const bundle = {
    system,
    modes,
    components,
    scenes,
    implementations,
    capabilityRegistries,
    baseStyle,
    rendererCodeSha256,
    resolverCodeSha256,
    styleResolverCodeSha256,
    commandCodeSha256,
    implementationDigest,
    sources: {
      system: systemFile,
      modes: modesFile,
      components: componentsFile,
      scenes: scenesFile,
      implementations: implementationsFile,
      capabilityRegistries: capabilityRegistryFiles,
      rendererCode: rendererCodeFile,
      resolverCode: resolverCodeFile,
      styleResolverCode: styleResolverCodeFile,
      commandCode: commandCodeFile,
    },
  };
  const errors = validateDesignSystem(bundle);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return {
    ...bundle,
    digest: sha256Value({
      system,
      modes,
      components,
      scenes,
      implementations,
      capabilityRegistries,
      rendererCodeSha256,
      resolverCodeSha256,
      styleResolverCodeSha256,
      commandCodeSha256,
      implementationDigest,
    }),
  };
}

export function resolveDesignSystem(styleConfig = {}) {
  const systemId = styleConfig.system ?? "dahui-video-system";
  const bundle = loadDesignSystem(systemId);
  const selectedModes = {
    ...bundle.system.defaultModes,
    ...(styleConfig.modes ?? {}),
  };
  let modeStyleOverrides = {};
  let layout = {};
  const resolvedModeRecords = [];
  for (const dimension of ["show", "aspectRatio", "language", "surface", "density"]) {
    const modeId = selectedModes[dimension];
    const mode = bundle.modes.dimensions[dimension]?.[modeId];
    if (!mode) throw new Error(`设计模式不存在：${dimension}.${modeId}`);
    modeStyleOverrides = deepMerge(modeStyleOverrides, mode.styleOverrides ?? {});
    layout = deepMerge(layout, mode.layout ?? {});
    resolvedModeRecords.push({
      dimension,
      id: modeId,
      label: mode.label,
    });
  }
  const profileId = styleConfig.profile ?? bundle.system.styleProfile;
  const combinedOverrides = deepMerge(
    modeStyleOverrides,
    styleConfig.overrides ?? {},
  );
  const style = loadStyleProfile(profileId, combinedOverrides);
  if (style.profile.designSystem?.id !== bundle.system.id) {
    throw new Error(
      `style profile ${profileId} 绑定 ${style.profile.designSystem?.id}，`
      + `不能用于 ${bundle.system.id}`,
    );
  }
  if (!semverAtLeast(
    bundle.system.version,
    style.profile.designSystem?.minimumVersion,
  )) {
    throw new Error(
      `design system ${bundle.system.version} 低于 ${profileId} 要求的 `
      + `${style.profile.designSystem?.minimumVersion}`,
    );
  }
  const fonts = resolveDesignFonts(style.profile);
  const digest = sha256Value({
    designSystemDigest: bundle.digest,
    profileDigest: style.digest,
    modes: selectedModes,
    layout,
  });
  return {
    system: bundle.system,
    systemDigest: bundle.digest,
    selectedModes,
    modeRecords: resolvedModeRecords,
    style: style.profile,
    styleSource: style.source,
    styleDigest: style.digest,
    layout,
    components: bundle.components.components,
    scenes: bundle.scenes.scenes,
    implementations: bundle.implementations,
    capabilityRegistries: bundle.capabilityRegistries,
    rendererCodeSha256: bundle.rendererCodeSha256,
    resolverCodeSha256: bundle.resolverCodeSha256,
    styleResolverCodeSha256: bundle.styleResolverCodeSha256,
    commandCodeSha256: bundle.commandCodeSha256,
    implementationDigest: bundle.implementationDigest,
    fonts,
    sources: bundle.sources,
    digest,
  };
}

export function findDesignEntry(resolved, kind, id) {
  if (kind === "system") return resolved.system;
  if (kind === "component") {
    return resolved.components.find((item) => item.id === id) ?? null;
  }
  if (kind === "scene") {
    return resolved.scenes.find((item) => item.id === id) ?? null;
  }
  if (kind === "mode") {
    const [dimension, modeId] = String(id ?? "").split(".");
    const bundle = loadDesignSystem(resolved.system.id);
    return bundle.modes.dimensions?.[dimension]?.[modeId] ?? null;
  }
  if (kind === "renderer") {
    return resolved.implementations.renderers.find((item) => item.id === id) ?? null;
  }
  if (kind === "layout") {
    return resolved.implementations.layouts.find((item) => item.id === id) ?? null;
  }
  if (kind === "motion") {
    return resolved.implementations.motions.find((item) => item.id === id) ?? null;
  }
  throw new Error(`未知设计条目类型：${kind}`);
}

export function resolveFallback(items, id) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const chain = [];
  const seen = new Set();
  let current = id;
  while (current && current !== "none") {
    if (seen.has(current)) {
      throw new Error(`fallback 循环：${[...chain, current].join(" -> ")}`);
    }
    const item = byId.get(current);
    if (!item) throw new Error(`fallback 条目不存在：${current}`);
    seen.add(current);
    chain.push(current);
    current = item.fallback;
  }
  return chain;
}
