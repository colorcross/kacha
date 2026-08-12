#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";
import {
  findDesignEntry,
  loadDesignSystem,
  resolveDesignSystem,
} from "./design_system.mjs";
import {
  renderAssSubtitle,
  renderComponentArtifact,
  renderSceneArtifact,
  validateDesignContrast,
  validateRenderArtifact,
} from "./design_renderers.mjs";
import { generateDesignReferenceGallery } from "./design_reference_gallery.mjs";
import { generateDesignMotionPreviews } from "./design_motion_preview.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = args[0];
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const has = (name) => args.includes(name);

function fail(message, code = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    error: message,
  }, null, 2));
  process.exit(code);
}

if (![
  "validate",
  "list",
  "show",
  "resolve",
  "preview",
  "render",
  "qc",
  "gallery",
  "motion-preview",
  "library-qc",
].includes(action)) {
  fail(
    "用法：kacha.mjs design validate|list|show|resolve|preview|render|qc|gallery|motion-preview|library-qc "
      + "[--kind component|scene|mode|renderer|layout|motion|system] "
      + "[--id ID] [--scene ID]\n"
      + "  kacha.mjs design library-qc --light DIR --spatial DIR --comic DIR --pixel DIR --dark DIR --contracts FILE [--output REPORT.json]",
    2,
  );
}

if (action === "library-qc") {
  const light = option("--light");
  const spatial = option("--spatial");
  const comic = option("--comic");
  const pixel = option("--pixel");
  const dark = option("--dark");
  const contracts = option("--contracts");
  const semantics = option(
    "--semantics",
    path.join(path.resolve(scriptDirectory, ".."), "config", "effects", "reference-semantics", "light-overlay.json"),
  );
  const gallery = option(
    "--gallery",
    path.join(path.resolve(scriptDirectory, ".."), "design", "reference-gallery", "xingzhe-v3", "manifest.json"),
  );
  const antiWeb = option(
    "--anti-web",
    path.join(path.resolve(scriptDirectory, ".."), "config", "design-system", "anti-web.json"),
  );
  const visualLanguages = option(
    "--visual-languages",
    path.join(path.resolve(scriptDirectory, ".."), "config", "design-system", "visual-languages.json"),
  );
  const artifactRoot = option("--artifact-root");
  const output = option("--output");
  if (!light || !spatial || !comic || !pixel || !dark || !contracts) {
    fail("library-qc 必须提供 --light、--spatial、--comic、--pixel、--dark 和 --contracts", 2);
  }
  const qcArguments = [
    path.join(scriptDirectory, "reference_library_qc.py"),
    "--light", path.resolve(light),
    "--spatial", path.resolve(spatial),
    "--comic", path.resolve(comic),
    "--pixel", path.resolve(pixel),
    "--dark", path.resolve(dark),
    "--contracts", path.resolve(contracts),
    "--semantics", path.resolve(semantics),
    "--gallery", path.resolve(gallery),
    "--anti-web", path.resolve(antiWeb),
    "--visual-languages", path.resolve(visualLanguages),
  ];
  if (artifactRoot) qcArguments.push("--artifact-root", path.resolve(artifactRoot));
  if (output) qcArguments.push("--output", path.resolve(output));
  const result = spawnSync("python3", qcArguments, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout && output) {
    const report = JSON.parse(result.stdout);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: report.schemaVersion,
      status: report.status,
      output: path.resolve(output),
      distinctEditingGrammarCount: report.distinctEditingGrammarCount,
      crossStyleExactDuplicateGroupCount: report.crossStyleExactDuplicateGroupCount,
      registryConsistency: report.registryConsistency,
      legacyArtifactScan: report.legacyArtifactScan,
      libraries: report.libraries.map((library) => ({
        style: library.style,
        editingGrammarId: library.editingGrammarId,
        effects: library.effects,
        images: library.images,
        headCollisionAssetCount: library.headCollisionAssetCount,
        spatialBlackAssetCount: library.spatialBlackAssetCount,
        exactDuplicateAssets: library.exactDuplicateAssets,
        nearDuplicatePairCount: library.nearDuplicatePairCount,
        failures: library.failures,
        warnings: library.warnings,
      })),
      failures: report.failures,
    }, null, 2)}\n`);
  } else if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  process.exit(0);
}

const loaded = loadKachaConfig({
  args,
  anchorPath: option("--anchor"),
  includeSecrets: false,
});
const styleConfig = {
  ...loaded.config.style,
  modes: {
    ...loaded.config.style.modes,
    ...(option("--show") ? { show: option("--show") } : {}),
    ...(option("--aspect") ? { aspectRatio: option("--aspect") } : {}),
    ...(option("--language") ? { language: option("--language") } : {}),
    ...(option("--surface") ? { surface: option("--surface") } : {}),
    ...(option("--density") ? { density: option("--density") } : {}),
  },
};
const resolved = resolveDesignSystem(styleConfig);
const baseBundle = loadDesignSystem(resolved.system.id);

if (action === "motion-preview") {
  const output = option(
    "--output",
    path.join("design", "reference-gallery", "xingzhe-v3", "normal-speed-previews"),
  );
  const requestedScenes = option("--scenes");
  const result = generateDesignMotionPreviews({
    resolved,
    outputDirectory: output,
    sceneIds: requestedScenes ? requestedScenes.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
    overwrite: has("--overwrite"),
  });
  console.log(JSON.stringify({ schemaVersion: "1.0", ...result }, null, 2));
  process.exit(0);
}

if (action === "gallery") {
  const output = option(
    "--output",
    path.join("design", "reference-gallery", "xingzhe-v3"),
  );
  const result = generateDesignReferenceGallery({
    resolved,
    outputDirectory: output,
    overwrite: has("--overwrite"),
  });
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    ...result,
  }, null, 2));
  process.exit(0);
}

if (action === "validate") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    designSystem: {
      id: resolved.system.id,
      version: resolved.system.version,
      digest: resolved.digest,
      systemDigest: resolved.systemDigest,
      implementationDigest: resolved.implementationDigest,
      rendererCodeSha256: resolved.rendererCodeSha256,
      componentCount: resolved.components.length,
      sceneCount: resolved.scenes.length,
      rendererCount: baseBundle.implementations.renderers.length,
      layoutCount: baseBundle.implementations.layouts.length,
      motionCount: baseBundle.implementations.motions.length,
      modeDimensions: Object.fromEntries(
        Object.entries(baseBundle.modes.dimensions)
          .map(([dimension, values]) => [dimension, Object.keys(values).length]),
      ),
    },
    selectedModes: resolved.selectedModes,
    fontResolution: resolved.fonts,
    sources: resolved.sources,
  }, null, 2));
  process.exit(0);
}

if (action === "list") {
  const kind = option("--kind", "scene");
  let entries;
  if (kind === "component") entries = resolved.components;
  else if (kind === "scene") entries = resolved.scenes;
  else if (kind === "renderer") entries = resolved.implementations.renderers;
  else if (kind === "layout") entries = resolved.implementations.layouts;
  else if (kind === "motion") entries = resolved.implementations.motions;
  else if (kind === "mode") {
    entries = Object.entries(baseBundle.modes.dimensions).flatMap(
      ([dimension, values]) => Object.entries(values).map(([id, value]) => ({
        id: `${dimension}.${id}`,
        label: value.label,
        dimension,
      })),
    );
  } else {
    fail(`list 不支持 kind：${kind}`);
  }
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    kind,
    count: entries.length,
    entries,
  }, null, 2));
  process.exit(0);
}

if (action === "resolve") {
  const sceneId = option("--scene");
  const scene = sceneId
    ? resolved.scenes.find((item) => item.id === sceneId)
    : null;
  if (sceneId && !scene) fail(`场景不存在：${sceneId}`);
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    designSystemId: resolved.system.id,
    designSystemVersion: resolved.system.version,
    digest: resolved.digest,
    implementationDigest: resolved.implementationDigest,
    selectedModes: resolved.selectedModes,
    fontResolution: resolved.fonts,
    layout: resolved.layout,
    style: resolved.style,
    ...(scene ? {
      scene,
      components: scene.components.map(
        (id) => resolved.components.find((item) => item.id === id),
      ),
    } : {}),
  }, null, 2));
  process.exit(0);
}

const kind = option(
  "--kind",
  ["preview", "render"].includes(action) ? "scene" : "system",
);
const id = option("--id") || option("--scene") || firstPositional(args.slice(1), [
  "--anchor", "--config", "--secrets", "--kind", "--id", "--scene", "--output",
  "--width", "--height", "--show", "--aspect", "--language", "--surface",
  "--density", "--state", "--data", "--manifest",
]);
if (action === "show") {
  const entry = kind === "system"
    ? resolved.system
    : findDesignEntry(resolved, kind, id);
  if (!entry) fail(`设计条目不存在：${kind}.${id}`);
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    kind,
    id: kind === "system" ? resolved.system.id : id,
    entry,
    designDigest: resolved.digest,
    implementationDigest: resolved.implementationDigest,
    selectedModes: resolved.selectedModes,
    fontResolution: resolved.fonts,
  }, null, 2));
  process.exit(0);
}

if (action === "qc") {
  const modeKey = (modes) => JSON.stringify(modes);
  const modeSelections = [resolved.selectedModes];
  if (has("--matrix")) {
    for (const [dimension, values] of Object.entries(baseBundle.modes.dimensions)) {
      for (const modeId of Object.keys(values)) {
        modeSelections.push({
          ...resolved.selectedModes,
          [dimension]: modeId,
        });
      }
    }
    modeSelections.push(
      {
        ...resolved.selectedModes,
        show: "very-ai",
        aspectRatio: "portrait-9x16",
        language: "bilingual",
        surface: "light",
        density: "compact",
      },
      {
        ...resolved.selectedModes,
        show: "book-talk",
        aspectRatio: "square-1x1",
        language: "en",
        surface: "dark",
        density: "spacious",
      },
    );
  }
  const uniqueSelections = [
    ...new Map(modeSelections.map((modes) => [modeKey(modes), modes])).values(),
  ];
  const errors = [];
  const profiles = [];
  for (const modes of uniqueSelections) {
    const current = resolveDesignSystem({
      ...styleConfig,
      modes,
    });
    const profileErrors = [];
    if (current.fonts.warnings.length > 0) {
      profileErrors.push(
        ...current.fonts.warnings.map((warning) => `字体解析失败：${warning}`),
      );
    }
    const contrast = validateDesignContrast(current);
    profileErrors.push(...contrast.errors);
    let componentRenderCount = 0;
    let sceneRenderCount = 0;
    let renderedBytes = 0;
    for (const component of current.components) {
      for (const state of component.states) {
        const artifact = renderComponentArtifact(component, current, { state });
        const itemErrors = validateRenderArtifact(artifact, [component.id]);
        if (artifact.manifest.state !== state) {
          itemErrors.push(`状态未按要求渲染：${state}`);
        }
        if (itemErrors.length > 0) {
          profileErrors.push(
            ...itemErrors.map((message) => `${component.id}.${state}: ${message}`),
          );
        }
        componentRenderCount += 1;
        renderedBytes += Buffer.byteLength(artifact.svg);
      }
    }
    for (const scene of current.scenes) {
      for (const state of ["entry", "peak", "exit"]) {
        const artifact = renderSceneArtifact(scene, current, { state });
        const itemErrors = validateRenderArtifact(
          artifact,
          [scene.id, ...scene.components],
        );
        if (artifact.manifest.state !== state) {
          itemErrors.push(`场景状态未按要求渲染：${state}`);
        }
        if (itemErrors.length > 0) {
          profileErrors.push(
            ...itemErrors.map((message) => `${scene.id}.${state}: ${message}`),
          );
        }
        sceneRenderCount += 1;
        renderedBytes += Buffer.byteLength(artifact.svg);
      }
    }
    const prefix = Object.entries(modes).map(([key, value]) => `${key}=${value}`).join(",");
    errors.push(...profileErrors.map((message) => `[${prefix}] ${message}`));
    profiles.push({
      selectedModes: modes,
      designDigest: current.digest,
      fontResolutionDigest: current.fonts.digest,
      contrastStatus: contrast.status,
      componentRenderCount,
      sceneRenderCount,
      renderedBytes,
      status: profileErrors.length === 0 ? "pass" : "fail",
      errors: profileErrors,
    });
  }
  const report = {
    schemaVersion: "1.0",
    status: errors.length === 0 ? "pass" : "fail",
    designSystemId: resolved.system.id,
    designSystemVersion: resolved.system.version,
    designDigest: resolved.digest,
    implementationDigest: resolved.implementationDigest,
    selectedModes: resolved.selectedModes,
    fonts: resolved.fonts,
    matrix: has("--matrix"),
    profileCount: profiles.length,
    componentCount: resolved.components.length,
    sceneCount: resolved.scenes.length,
    rendererCount: baseBundle.implementations.renderers.length,
    layoutCount: baseBundle.implementations.layouts.length,
    motionCount: baseBundle.implementations.motions.length,
    totalComponentRenders: profiles.reduce(
      (sum, profile) => sum + profile.componentRenderCount,
      0,
    ),
    totalSceneRenders: profiles.reduce(
      (sum, profile) => sum + profile.sceneRenderCount,
      0,
    ),
    profiles,
    errors,
  };
  const reportOutput = option("--output");
  if (reportOutput) {
    const destination = path.resolve(reportOutput);
    if (fs.existsSync(destination) && !has("--overwrite")) {
      fail(`拒绝覆盖已有报告：${destination}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(errors.length === 0 ? 0 : 1);
}

const scene = kind === "scene"
  ? resolved.scenes.find((item) => item.id === id)
  : null;
const component = kind === "component"
  ? resolved.components.find((item) => item.id === id)
  : null;
if (kind === "scene" && !scene) fail(`场景不存在：${id}`);
if (kind === "component" && !component) fail(`组件不存在：${id}`);
if (!["scene", "component"].includes(kind)) {
  fail("preview/render 只支持 --kind scene 或 component");
}
const aspect = resolved.selectedModes.aspectRatio;
const defaultGeometry = aspect === "portrait-9x16"
  ? [720, 1280]
  : aspect === "square-1x1"
    ? [900, 900]
    : [1280, 720];
const width = Number(option("--width", defaultGeometry[0]));
const height = Number(option("--height", defaultGeometry[1]));
if (!Number.isInteger(width) || width < 64 || !Number.isInteger(height) || height < 64) {
  fail("width/height 必须是至少 64 的整数");
}
let data = {};
const dataFile = option("--data");
if (dataFile) {
  const resolvedData = path.resolve(dataFile);
  if (!fs.existsSync(resolvedData)) fail(`data 文件不存在：${resolvedData}`);
  data = JSON.parse(fs.readFileSync(resolvedData, "utf8"));
}
const itemId = scene?.id ?? component.id;
const output = path.resolve(option("--output", `${itemId}.svg`));
if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖已有预览：${output}`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const state = option("--state");
const artifact = scene
  ? renderSceneArtifact(scene, resolved, {
    width,
    height,
    state: state ?? "peak",
    data,
    showGuides: !has("--no-guides"),
  })
  : renderComponentArtifact(component, resolved, {
    width,
    height,
    state,
    data,
  });
const artifactErrors = validateRenderArtifact(
  artifact,
  scene ? [scene.id, ...scene.components] : [component.id],
);
if (artifactErrors.length > 0) fail(artifactErrors.join("\n"));
const extension = path.extname(output).toLowerCase();
if (extension === ".svg") {
  fs.writeFileSync(output, artifact.svg);
} else if (extension === ".png") {
  const result = spawnSync("rsvg-convert", ["-o", output], {
    input: artifact.svg,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`PNG 预览需要 rsvg-convert：${result.stderr || "转换失败"}`);
  }
} else if (extension === ".ass" && component) {
  fs.writeFileSync(output, renderAssSubtitle(component, resolved, {
    width,
    height,
    data,
  }));
} else if (extension === ".json") {
  fs.writeFileSync(output, `${JSON.stringify(artifact.manifest, null, 2)}\n`);
} else {
  fail("预览支持 .svg、.png、组件字幕 .ass 或 manifest .json");
}
let manifestOutput = option("--manifest");
if (!manifestOutput && action === "render" && extension !== ".json") {
  manifestOutput = `${output}.manifest.json`;
}
if (manifestOutput) {
  const destination = path.resolve(manifestOutput);
  if (fs.existsSync(destination) && !has("--overwrite")) {
    fail(`拒绝覆盖已有 manifest：${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(artifact.manifest, null, 2)}\n`);
}
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: "pass",
  kind,
  id: itemId,
  output,
  manifest: manifestOutput ? path.resolve(manifestOutput) : null,
  geometry: { width, height },
  state: artifact.manifest.state,
  selectedModes: resolved.selectedModes,
  designDigest: resolved.digest,
  resolvedFonts: artifact.manifest.resolvedFonts,
}, null, 2));
