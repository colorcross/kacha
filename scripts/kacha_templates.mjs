#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJson,
  resolveFrom,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { deepMerge, resolveDesignSystem } from "./design_system.mjs";
import { firstPositional, loadKachaConfig } from "./kacha_config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const templateFile = path.join(skillRoot, "config", "effects", "templates.json");
const args = process.argv.slice(2);
const action = firstPositional(args, [
  "--template",
  "--signal",
  "--category",
  "--output",
  "--config",
  "--secrets",
]);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(`效果模板失败：${message}`);
  process.exit(code);
}

function registryItems(rule, templates) {
  const registryFile = path.resolve(path.dirname(templateFile), rule.path);
  const registry = readJson(registryFile);
  const items = registry?.[rule.items];
  if (!Array.isArray(items)) {
    throw new Error(`${rule.registry}.${rule.items} 不是数组`);
  }
  return { registryFile, registry, items, templates };
}

function loadCatalog(file, { privateCatalog = false } = {}) {
  const catalog = readJson(file);
  if (catalog.schemaVersion !== "1.0" || !Array.isArray(catalog.assets)) {
    throw new Error(`${file} 不是有效资源目录`);
  }
  const records = [];
  const ids = new Set();
  for (const [index, asset] of catalog.assets.entries()) {
    if (!asset.id || !asset.kind || !asset.path || !asset.sha256) {
      throw new Error(`${file} assets[${index}] 缺少 id/kind/path/sha256`);
    }
    if (!asset.license) {
      throw new Error(`${file} assets[${index}] 缺少 license`);
    }
    if (ids.has(asset.id)) {
      throw new Error(`${file} assets[${index}] id 重复：${asset.id}`);
    }
    ids.add(asset.id);
    const absolute = resolveFrom(file, asset.path);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`${file} assets[${index}] 文件不存在：${absolute}`);
    }
    const actual = sha256File(absolute);
    if (actual !== asset.sha256) {
      throw new Error(`${file} assets[${index}] SHA 不一致：${asset.id}`);
    }
    records.push({
      ...asset,
      absolutePath: absolute,
      distribution: asset.distribution
        ?? catalog.distribution
        ?? (privateCatalog ? "project_private_only" : "public_bundle_allowed"),
      private: privateCatalog,
    });
  }
  return { file, catalog, records };
}

function expandTemplates(config) {
  const expanded = [];
  for (const rule of config.bindingRules) {
    const { registryFile, items } = registryItems(rule, config);
    for (const item of items) {
      const familyId = rule.family
        ?? rule.familyMap?.[item?.[rule.familyFromField]];
      const family = config.families[familyId];
      if (!family) {
        throw new Error(
          `${rule.registry}.${item?.id} 无法解析模板 family：${familyId}`,
        );
      }
      const id = `${rule.templatePrefix}${item.id}`;
      const override = config.overrides?.[id] ?? {};
      const itemContract = {
        ...(item.fontRole
          ? { typography: { subtitleRole: item.fontRole } }
          : {}),
        ...(item.soundTrigger
          ? { audio: { trigger: item.soundTrigger } }
          : {}),
      };
      const merged = deepMerge(
        deepMerge(deepMerge(config.defaults, family), itemContract),
        override,
      );
      expanded.push({
        id,
        label: item.label ?? item.title ?? item.id,
        registry: rule.registry,
        registryFile,
        effectId: item.id,
        effect: item,
        family: familyId,
        ...merged,
      });
    }
  }
  return expanded;
}

function validateAll(config, expanded, resolved, catalogs) {
  const errors = [];
  const ids = new Set();
  const sceneIds = new Set(resolved.scenes.map((scene) => scene.id));
  const componentIds = new Set(
    resolved.components.map((component) => component.id),
  );
  const resourceIds = new Set();
  const resourceRoles = new Set();
  const assetIds = new Set(catalogs.flatMap(
    ({ records }) => records.map((asset) => asset.id),
  ));
  const providerIds = new Set(catalogs.flatMap(
    ({ catalog }) => (catalog.providers ?? []).map((provider) => provider.id),
  ));
  const fallbackPolicies = new Set([
    "full_screen_insert_card",
    "keep_a_roll",
    "source_card",
  ]);
  for (const { catalog, records } of catalogs) {
    if (catalog.styleProfile && catalog.styleProfile !== config.styleProfile) {
      errors.push(`${catalog.id}.styleProfile 与模板不一致`);
    }
    records.forEach((asset) => {
      if (resourceIds.has(asset.id)) {
        errors.push(`资源 ID 重复：${asset.id}`);
      }
      resourceIds.add(asset.id);
      (asset.roles ?? []).forEach((role) => resourceRoles.add(role));
    });
    (catalog.runtimeRecipes ?? []).forEach((recipe) => {
      if (!recipe.id || !recipe.sourceAsset || !assetIds.has(recipe.sourceAsset)) {
        errors.push(`${catalog.id}.runtimeRecipe 无法解析源资产：${recipe.id}`);
      }
      if (resourceIds.has(recipe.id)) {
        errors.push(`资源 ID 重复：${recipe.id}`);
      }
      resourceIds.add(recipe.id);
      resourceRoles.add("background_motion");
    });
    (catalog.logicalSlots ?? []).forEach((slot) => {
      if (
        !slot.id
        || !Array.isArray(slot.selectionOrder)
        || slot.selectionOrder.length === 0
      ) {
        errors.push(`${catalog.id}.logicalSlot 缺少 id 或 selectionOrder`);
      }
      for (const provider of slot.selectionOrder ?? []) {
        if (!providerIds.has(provider)) {
          errors.push(`${catalog.id}.${slot.id} 使用未登记 provider：${provider}`);
        }
      }
      if (
        slot.fallback
        && !assetIds.has(slot.fallback)
        && !(catalog.runtimeRecipes ?? []).some(
          (recipe) => recipe.id === slot.fallback,
        )
        && !fallbackPolicies.has(slot.fallback)
      ) {
        errors.push(`${catalog.id}.${slot.id} fallback 未登记：${slot.fallback}`);
      }
      if (resourceIds.has(slot.id)) {
        errors.push(`资源 ID 重复：${slot.id}`);
      }
      resourceIds.add(slot.id);
    });
  }
  for (const [index, template] of expanded.entries()) {
    const label = `templates[${index}]`;
    if (ids.has(template.id)) errors.push(`${label}.id 重复：${template.id}`);
    ids.add(template.id);
    if (!sceneIds.has(template.sceneId)) {
      errors.push(`${label}.sceneId 不存在：${template.sceneId}`);
    }
    if (!Array.isArray(template.componentIds) || template.componentIds.length === 0) {
      errors.push(`${label}.componentIds 不能为空`);
    }
    for (const id of template.componentIds ?? []) {
      if (!componentIds.has(id)) errors.push(`${label}.componentId 不存在：${id}`);
    }
    if (!Array.isArray(template.signals) || template.signals.length === 0) {
      errors.push(`${label}.signals 不能为空`);
    }
    if (
      !Number.isFinite(template.timing?.audioVisualPeakToleranceFrames)
      || template.timing.audioVisualPeakToleranceFrames > 2
    ) {
      errors.push(`${label} 音画峰值容差必须为 0 至 2 帧`);
    }
    if (template.safety?.preserveFaceSafeZone !== true) {
      errors.push(`${label} 必须保留人物头脸安全区`);
    }
    for (const role of template.resourceRoles ?? []) {
      if (!resourceIds.has(role) && !resourceRoles.has(role)) {
        errors.push(`${label}.resourceRoles 未登记：${role}`);
      }
    }
  }
  const specialFallbacks = new Set([
    "hold_original_shot",
    "use_design_system_card_or_no_effect",
  ]);
  for (const template of expanded) {
    if (
      template.fallback
      && !ids.has(template.fallback)
      && !specialFallbacks.has(template.fallback)
    ) {
      errors.push(`${template.id}.fallback 不存在：${template.fallback}`);
    }
  }
  const coreCatalog = catalogs[0].catalog;
  if (coreCatalog.styleProfile !== config.styleProfile) {
    errors.push("模板与核心资源目录的 styleProfile 不一致");
  }
  return errors;
}

function resourcesFor(template, catalogs) {
  const allAssets = catalogs.flatMap((catalog) => catalog.records);
  const logicalSlots = catalogs.flatMap(
    ({ catalog, file }) => (catalog.logicalSlots ?? []).map(
      (slot) => ({ ...slot, catalog: file }),
    ),
  );
  const runtimeRecipes = catalogs.flatMap(
    ({ catalog, file }) => (catalog.runtimeRecipes ?? []).map(
      (recipe) => ({ ...recipe, catalog: file }),
    ),
  );
  return (template.resourceRoles ?? []).map((role) => {
    const direct = allAssets.find((asset) => asset.id === role);
    if (direct) {
      return {
        role,
        status: "resolved",
        assetId: direct.id,
        path: direct.absolutePath,
        sha256: direct.sha256,
        license: direct.license,
        distribution: direct.distribution,
        private: direct.private,
      };
    }
    const recipe = runtimeRecipes.find((item) => item.id === role);
    if (recipe) return { role, status: "runtime_recipe", recipe };
    const slot = logicalSlots.find((item) => item.id === role);
    if (slot) return { role, status: "query_time_slot", slot };
    const byRole = allAssets.find((asset) => asset.roles?.includes(role));
    if (byRole) {
      return {
        role,
        status: "resolved_by_role",
        assetId: byRole.id,
        path: byRole.absolutePath,
        sha256: byRole.sha256,
        license: byRole.license,
        distribution: byRole.distribution,
        private: byRole.private,
      };
    }
    return { role, status: "unresolved", fallback: template.fallback };
  });
}

function fontsFor(template, catalogs) {
  const assets = catalogs.flatMap((catalog) => catalog.records);
  return Object.entries(template.typography ?? {}).map(([usage, role]) => {
    const font = assets.find(
      (asset) => asset.kind === "font" && asset.roles?.includes(role),
    );
    return font
      ? {
        usage,
        role,
        status: "resolved",
        assetId: font.id,
        path: font.absolutePath,
        sha256: font.sha256,
        license: font.license,
        distribution: font.distribution,
        private: font.private,
      }
      : {
        usage,
        role,
        status: "unresolved",
        requirement: "必须经 font routing 命中真实字体文件，不得静默替换",
      };
  });
}

let loaded;
let config;
let resolved;
let expanded;
let catalogs;
try {
  loaded = loadKachaConfig({
    args,
    anchorPath: process.cwd(),
    includeSecrets: false,
  });
  config = readJson(templateFile);
  resolved = resolveDesignSystem(loaded.config.style);
  expanded = expandTemplates(config);
  const coreCatalogFile = path.resolve(
    path.dirname(templateFile),
    config.resourceCatalog,
  );
  catalogs = [loadCatalog(coreCatalogFile)];
  const privateCatalogFile = loaded.config.tools.resourceCatalog;
  if (privateCatalogFile) {
    if (!fs.existsSync(privateCatalogFile)) {
      throw new Error(`tools.resourceCatalog 不存在：${privateCatalogFile}`);
    }
    const privateCatalog = loadCatalog(privateCatalogFile, {
      privateCatalog: true,
    });
    const coreIds = new Set(catalogs[0].records.map((asset) => asset.id));
    for (const asset of privateCatalog.records) {
      if (coreIds.has(asset.id)) {
        throw new Error(`私有资源不得覆盖核心资源：${asset.id}`);
      }
    }
    catalogs.push(privateCatalog);
  }
  const errors = validateAll(config, expanded, resolved, catalogs);
  if (errors.length > 0) throw new Error(errors.join("\n"));
} catch (error) {
  fail(error.message, 2);
}

const byCategory = Object.fromEntries(
  [...new Set(expanded.map((template) => template.category))]
    .sort()
    .map((category) => [
      category,
      expanded.filter((template) => template.category === category).length,
    ]),
);
const report = {
  schemaVersion: "1.0",
  status: "pass",
  templateRegistry: templateFile,
  templateVersion: config.version,
  designSystemVersion: resolved.system.version,
  designDigest: resolved.digest,
  templates: expanded.length,
  byCategory,
  catalogs: catalogs.map(({ file, records }) => ({
    path: file,
    assets: records.length,
    digest: sha256Value({
      catalog: readJson(file),
      verifiedAssets: records.map(
        (asset) => ({ id: asset.id, sha256: asset.sha256 }),
      ),
    }),
  })),
};

if (action === "validate") {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
if (action === "list") {
  const category = option("--category");
  const list = category
    ? expanded.filter((template) => template.category === category)
    : expanded;
  console.log(JSON.stringify({
    ...report,
    items: list.map((template) => ({
      id: template.id,
      label: template.label,
      category: template.category,
      family: template.family,
      signals: template.signals,
      fallback: template.fallback,
    })),
  }, null, 2));
  process.exit(0);
}

let selected = null;
const requestedTemplate = option("--template");
const signal = option("--signal");
if (requestedTemplate) {
  selected = expanded.find((template) => template.id === requestedTemplate);
} else if (signal) {
  selected = expanded.find((template) => template.signals.includes(signal));
}
if (!selected) {
  if (!["show", "resolve"].includes(action)) {
    console.error(
      "用法：kacha.mjs templates validate|list|show|resolve "
        + "[--template ID | --signal SIGNAL] [--output FILE]",
    );
    process.exit(2);
  }
  fail(
    requestedTemplate
      ? `模板不存在：${requestedTemplate}`
      : `没有模板匹配 signal：${signal}`,
    2,
  );
}
const result = {
  schemaVersion: "1.0",
  status: "pass",
  template: {
    ...selected,
    registryFileSha256: sha256File(selected.registryFile),
  },
  resources: resourcesFor(selected, catalogs),
  fonts: fontsFor(selected, catalogs),
  executionContract: {
    designSystemId: resolved.system.id,
    designSystemVersion: resolved.system.version,
    designDigest: resolved.digest,
    styleProfile: resolved.style.id,
    sceneId: selected.sceneId,
    componentIds: selected.componentIds,
    effect: {
      registry: selected.registry,
      id: selected.effectId,
    },
    timing: selected.timing,
    safety: selected.safety,
    typography: selected.typography,
    resolvedFonts: fontsFor(selected, catalogs),
    audio: selected.audio,
    fallback: selected.fallback,
    failureConditions: selected.failureConditions,
    resourceResolution:
      "resolved 资源可直接使用；query_time_slot 必须取得来源、许可、格式和 SHA 后才能渲染。",
  },
  digest: sha256Value({
    template: selected,
    resources: resourcesFor(selected, catalogs),
    fonts: fontsFor(selected, catalogs),
    designDigest: resolved.digest,
  }),
};
const output = option("--output");
if (output) writeJsonAtomic(path.resolve(output), result);
console.log(JSON.stringify(result, null, 2));
