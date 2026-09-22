#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquireFileLock,
  mediaSummary,
  readJson,
  resolveRuntimeCommand,
  sha256File,
} from "./kacha_utils.mjs";

const args = process.argv.slice(2);
const createdDuringRun = [];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function usage() {
  console.error(
    "用法：import_private_sfx.mjs --library DIR --mapping FILE [--dry-run]",
  );
}

function fail(message) {
  for (const file of [...createdDuringRun].reverse()) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // Preserve the original failure; orphaned files will still be rejected on retry.
    }
  }
  console.error(`私有音效导入失败：${message}`);
  process.exit(1);
}

process.once("uncaughtException", error => fail(error.message));

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function rebuildAudition(root, manifest) {
  const byCategory = new Map();
  for (const asset of manifest.assets) {
    if (!byCategory.has(asset.category)) byCategory.set(asset.category, []);
    byCategory.get(asset.category).push(asset);
  }
  const sections = [...byCategory.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, assets]) => {
      const cards = assets.map((asset) => {
        const title = asset.display_title
          ? `${asset.display_title} / ${asset.title}`
          : asset.title;
        const privateAsset = asset.distribution === "project_private_only";
        const badge = privateAsset
          ? '<span class="badge private">项目私有</span>'
          : asset.provider === "user_local"
            ? '<span class="badge local">本地优先</span>'
            : '<span class="badge">授权候选</span>';
        const search = [
          title,
          ...(asset.aliases ?? []),
          asset.use,
          category,
        ].join(" ").toLowerCase();
        return `<article data-search="${escapeHtml(search)}">
  <h3>${escapeHtml(title)} ${badge}</h3>
  <p>${escapeHtml(asset.use ?? "")}</p>
  <audio controls preload="none" src="${escapeHtml(asset.ready_file)}"></audio>
  <code>${escapeHtml(asset.ready_file)}</code>
</article>`;
      }).join("\n");
      return `<section>
  <h2>${escapeHtml(category)} <small>${assets.length} 个</small></h2>
  <div class="grid">${cards}</div>
</section>`;
    }).join("\n");
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>行者大灰常用音效库</title>
<style>
:root{color-scheme:light;--bg:#f3efe8;--card:#fffdf9;--ink:#26231f;--muted:#716b63;--accent:#c76d34}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{width:min(1180px,calc(100% - 32px));margin:40px auto 80px}h1{font-size:32px;margin:0 0 8px}.intro{color:var(--muted)}
.toolbar{position:sticky;top:0;z-index:3;padding:12px 0;background:linear-gradient(var(--bg) 75%,transparent)}
input{width:100%;border:1px solid #26231f2e;border-radius:12px;padding:12px 14px;background:var(--card);font:inherit}
section{margin:32px 0}h2{font-size:20px;border-left:4px solid var(--accent);padding-left:10px}h2 small{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:14px}article{background:var(--card);border:1px solid #26231f1a;border-radius:14px;padding:16px;box-shadow:0 5px 20px #3c2d1e0d}
article[hidden]{display:none}h3{font-size:16px;margin:0 0 5px}p{color:var(--muted);min-height:47px}audio{width:100%;height:36px}code{font-size:12px;color:#7b4727;word-break:break-all}
.badge{display:inline-block;margin-left:7px;padding:2px 7px;border-radius:999px;background:#ece7df;color:#665f57;font-size:11px}.local{background:#f2d8c5;color:#88451f}.private{background:#ffe0b8;color:#7a3d00}
</style></head><body><main><h1>行者大灰常用音效库</h1>
<p class="intro">${manifest.assets.length} 个工作副本。先按真实叙事触发选择；项目私有素材不得随公开仓库分发。</p>
<div class="toolbar"><input id="search" type="search" placeholder="搜索名称、别名、用途或触发"></div>
${sections}</main><script>
const input=document.querySelector("#search");const cards=[...document.querySelectorAll("article")];
input.addEventListener("input",()=>{const q=input.value.trim().toLowerCase();for(const card of cards)card.hidden=q&&!card.dataset.search.includes(q)});
</script></body></html>`;
  return html;
}

const libraryRoot = option("--library");
const mappingFile = option("--mapping");
const dryRun = args.includes("--dry-run");
if (!libraryRoot || !mappingFile) {
  usage();
  process.exit(2);
}
const root = path.resolve(libraryRoot);
const manifestFile = path.join(root, "manifest.json");
const profileFile = path.join(root, "kacha-profile.json");
if (!fs.existsSync(manifestFile) || !fs.existsSync(profileFile)) {
  fail("library 必须包含 manifest.json 与 kacha-profile.json");
}
// Serialize the read/modify/write cycle, not just the final manifest write.
const releaseLibraryLock = acquireFileLock(path.join(root, ".kacha-sfx-import.lock"), { purpose: "sfx-import" });
process.once("exit", releaseLibraryLock);

function libraryTarget(relative) {
  if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative)
    || relative.split(/[\\/]/).some(part => !part || part === ".." || part === ".")) {
    fail(`音效输出路径必须是库内相对路径：${relative}`);
  }
  let current = root;
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`音效输出路径不允许符号链接：${relative}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return path.join(root, relative);
}
for (const file of ["manifest.json", "kacha-profile.json", "试听索引.html"]) libraryTarget(file);

let mapping;
let manifest;
let profile;
let originalManifest;
let originalProfile;
try {
  mapping = readJson(path.resolve(mappingFile));
  manifest = readJson(manifestFile);
  profile = readJson(profileFile);
  originalManifest = structuredClone(manifest);
  originalProfile = structuredClone(profile);
} catch (error) {
  fail(error.message);
}
if (
  mapping.schemaVersion !== "1.0"
  || !Array.isArray(mapping.assets)
  || mapping.assets.length === 0
) {
  fail("mapping.schemaVersion 必须为 1.0，assets 必须是非空数组");
}

const ids = new Map(manifest.assets.map((asset) => [asset.id, asset]));
const names = new Map();
for (const asset of manifest.assets) {
  for (const name of [asset.title, ...(asset.aliases ?? [])]) {
    if (name) names.set(name, asset.id);
  }
}
const operations = [];
const plannedIds = new Set(), plannedNames = new Set(), plannedOutputs = new Set();
for (const [index, item] of mapping.assets.entries()) {
  const label = `assets[${index}]`;
  if (!item.title || typeof item.title !== "string") fail(`${label}.title 缺失`);
  if (plannedNames.has(item.title)) fail(`${label}.title 在本批次重复`);
  plannedNames.add(item.title);
  if (typeof item.source !== "string" || !item.source.trim()) fail(`${label}.source 缺失`);
  if (item.duplicateOf) {
    const target = ids.get(item.duplicateOf);
    if (!target) fail(`${label}.duplicateOf 不存在：${item.duplicateOf}`);
    const source = path.resolve(path.dirname(path.resolve(mappingFile)), item.source);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail(`${label}.source 不是文件：${source}`);
    if (sha256File(source) !== target.source_sha256) {
      fail(`${label} 声明为重复项，但 source SHA 与 ${item.duplicateOf} 不同`);
    }
    if (item.provenance && JSON.stringify(target.provenance) !== JSON.stringify(item.provenance)) {
      fail(`${label}.provenance 与重复项不同，不能静默丢弃`);
    }
    if (names.has(item.title) && names.get(item.title) !== target.id) {
      fail(`${label}.title 与其他资产冲突：${item.title}`);
    }
    operations.push({ kind: "alias", item, target });
    continue;
  }
  for (const field of ["id", "category", "source", "readyFile", "use", "route"]) {
    if (!item[field]) fail(`${label}.${field} 缺失`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(item.id) || plannedIds.has(item.id)) fail(`${label}.id 无效或重复`);
  plannedIds.add(item.id);
  libraryTarget(item.readyFile);
  if (plannedOutputs.has(item.readyFile)) fail(`${label}.readyFile 在本批次重复`);
  plannedOutputs.add(item.readyFile);
  if (item.provenance !== undefined && (!item.provenance || typeof item.provenance !== "object"
    || Array.isArray(item.provenance) || typeof item.provenance.provider !== "string"
    || !item.provenance.provider.trim() || !["mmx", "web", "desktop"].includes(item.provenance.transport)
    || !/^[a-f0-9]{64}$/i.test(item.provenance.promptSha256 ?? "")
    || typeof item.provenance.logicalAssetId !== "string" || !item.provenance.logicalAssetId.trim())) {
    fail(`${label}.provenance 需要 provider、transport、promptSha256 和 logicalAssetId`);
  }
  const existing = ids.get(item.id);
  const source = path.resolve(path.dirname(path.resolve(mappingFile)), item.source);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    fail(`${label}.source 不存在：${source}`);
  }
  if (names.has(item.title) && names.get(item.title) !== item.id) {
    fail(`${label}.title 与其他资产冲突：${item.title}`);
  }
  operations.push({
    kind: existing ? "verify_existing" : "import",
    item,
    source,
    existing,
  });
}

if (dryRun) {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    dryRun: true,
    library: root,
    operations: operations.map(({ kind, item, target }) => ({
      kind,
      id: item.id ?? target.id,
      title: item.title,
    })),
  }, null, 2));
  process.exit(0);
}

const ffmpeg = resolveRuntimeCommand("ffmpeg");
for (const operation of operations) {
  const { item } = operation;
  if (operation.kind === "alias") {
    operation.target.aliases = unique([
      ...(operation.target.aliases ?? []),
      item.title,
    ]);
    continue;
  }
  const sourceSha256 = sha256File(operation.source);
  if (operation.kind === "verify_existing") {
    if (operation.existing.source_sha256 !== sourceSha256) {
      fail(`已有 ${item.id} 的 source SHA 与待导入文件不同`);
    }
    if (item.provenance && JSON.stringify(operation.existing.provenance) !== JSON.stringify(item.provenance)) {
      fail(`已有 ${item.id} 的 provenance 与待导入记录不同，不能静默丢弃或覆盖`);
    }
    continue;
  }
  const sourceExtension = path.extname(operation.source).toLowerCase() || ".bin";
  const sourceRelative = `_source/project-private/${item.id}${sourceExtension}`;
  const sourceTarget = libraryTarget(sourceRelative);
  const readyTarget = libraryTarget(item.readyFile);
  for (const target of [sourceTarget, readyTarget]) {
    if (fs.existsSync(target)) fail(`拒绝覆盖已有文件：${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  fs.copyFileSync(operation.source, sourceTarget, fs.constants.COPYFILE_EXCL);
  createdDuringRun.push(sourceTarget);
  // Reserve the output exclusively before ffmpeg; cleanup must never unlink a
  // file created by another writer between the existence check and conversion.
  fs.closeSync(fs.openSync(readyTarget, "wx"));
  createdDuringRun.push(readyTarget);
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-y",
    "-i", sourceTarget,
    "-vn", "-af", "volume=-1dB",
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le",
    readyTarget,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    try { fs.unlinkSync(readyTarget); } catch {}
    fail(`ffmpeg 转码 ${item.id} 失败：${result.stderr.trim()}`);
  }
  const summary = mediaSummary(readyTarget);
  const asset = {
    id: item.id,
    category: item.category,
    display_title: item.displayTitle ?? item.title,
    title: item.title,
    aliases: unique(item.aliases ?? []),
    provider: "user_project_private",
    priority: Number(item.priority ?? 110),
    license_ref: "project_private",
    distribution: "project_private_only",
    rights_status: "project_use_authorized_by_user_source_provenance_unrecorded",
    ...(item.provenance ? { provenance: structuredClone(item.provenance),
      rights_status: "source_provenance_recorded_license_review_required" } : {}),
    source_file: sourceRelative,
    source_sha256: sourceSha256,
    ready_file: item.readyFile,
    duration_s: Number(summary.duration.toFixed(6)),
    ready_sha256: sha256File(readyTarget),
    use: item.use,
  };
  manifest.assets.push(asset);
  ids.set(asset.id, asset);
  names.set(asset.title, asset.id);
}

manifest.schemaVersion ??= "1.0";
manifest.id ??= "xingzhe-dahui-private-sfx-library";
manifest.additional_sources ??= {};
manifest.additional_sources.user_project_private ??= {
  description: "项目私有音效；每项来源、生成渠道和许可按资产记录核实",
  rights_status: "per_asset_license_review_required",
  registered_at: new Date().toISOString().slice(0, 10),
  distribution: "project_private_only",
  license_ref: "project_private",
  source_archive: "_source/project-private",
  selection_priority: 110,
};
manifest.library_stats = {
  total_assets: manifest.assets.length,
  mixkit_assets: manifest.assets.filter((asset) => asset.provider === "mixkit").length,
  user_local_assets: manifest.assets.filter((asset) => asset.provider === "user_local").length,
  project_private_assets: manifest.assets.filter(
    (asset) => asset.provider === "user_project_private",
  ).length,
};

profile.asset_routes ??= [];
for (const operation of operations) {
  const { item } = operation;
  const target = operation.kind === "alias"
    ? operation.target
    : ids.get(item.id);
  if (!item.route) continue;
  const readyFile = target.ready_file;
  const route = {
    asset: readyFile,
    trigger: item.route.trigger,
    use_when: item.route.useWhen,
    placement: item.route.placement,
    do_not_use_when: item.route.doNotUseWhen,
    maximum_uses_per_minute: Number(item.route.maximumUsesPerMinute ?? 2),
  };
  const routeIndex = profile.asset_routes.findIndex(
    (candidate) => candidate.asset === readyFile,
  );
  if (routeIndex >= 0) profile.asset_routes[routeIndex] = route;
  else profile.asset_routes.push(route);

  let rule = profile.rules.find(
    (candidate) => candidate.trigger === item.route.trigger,
  );
  if (!rule) {
    rule = {
      trigger: item.route.trigger,
      meaning: item.route.meaning,
      preferred_local: [readyFile],
      preferred_local_use_when: item.route.useWhen,
      start_gain_db: Number(item.route.startGainDb ?? -18),
      placement: item.route.placement,
      do_not_use_when: item.route.doNotUseWhen,
    };
    profile.rules.push(rule);
  } else if (operation.kind !== "alias") {
    rule.preferred_local = unique([...(rule.preferred_local ?? []), readyFile]);
  }
}
profile.selection_policy ??= {};
profile.selection_policy.require_exact_asset_route_match = true;
profile.selection_policy.project_private_never_public = true;
profile.selection_policy.no_generic_impact_for_serious_trauma = true;

function contentWithoutRevision(value) {
  const copy = structuredClone(value);
  delete copy.version;
  delete copy.updated_at;
  return copy;
}

const manifestChanged = JSON.stringify(contentWithoutRevision(manifest))
  !== JSON.stringify(contentWithoutRevision(originalManifest));
const profileChanged = JSON.stringify(contentWithoutRevision(profile))
  !== JSON.stringify(contentWithoutRevision(originalProfile));
if (manifestChanged) {
  manifest.version = Number(originalManifest.version ?? 0) + 1;
  manifest.updated_at = new Date().toISOString();
}
if (profileChanged) {
  profile.version = Number(originalProfile.version ?? 0) + 1;
}
// Restore all metadata if any step fails so the manifest never points to files
// removed by failed-import cleanup. Each individual replacement is atomic.
const updates = [
  ...(manifestChanged ? [[manifestFile, `${JSON.stringify(manifest, null, 2)}\n`]] : []),
  ...(profileChanged ? [[profileFile, `${JSON.stringify(profile, null, 2)}\n`]] : []),
  ...(manifestChanged ? [[path.join(root, "试听索引.html"), rebuildAudition(root, manifest)]] : []),
];
const previous = updates.map(([file]) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]);
const written = [];
function replaceText(file, content) {
  const temporary = `${file}.tmp-${process.pid}`;
  let created = false;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" });
    created = true;
    fs.renameSync(temporary, file);
  } finally {
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
try {
  for (const [file, content] of updates) { replaceText(file, content); written.push(file); }
} catch (error) {
  const restorationErrors = [];
  for (const [file, content] of previous.reverse()) {
    if (!written.includes(file)) continue;
    try { if (content === null) fs.unlinkSync(file); else replaceText(file, content); }
    catch (restoreError) { restorationErrors.push(restoreError.message); }
  }
  if (restorationErrors.length) {
    // Keep audio referenced by metadata that could not be restored.
    createdDuringRun.length = 0;
    fail(`元数据恢复未完成，保留音频待恢复：${restorationErrors.join("; ")}`);
  }
  fail(error.message);
}
createdDuringRun.length = 0;
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: "pass",
  library: root,
  manifest: manifestFile,
  profile: profileFile,
  audition: path.join(root, "试听索引.html"),
  imported: operations.filter((item) => item.kind === "import").length,
  reused: operations.filter((item) => item.kind === "verify_existing").length,
  aliases: operations.filter((item) => item.kind === "alias").length,
  assetCount: manifest.assets.length,
  changed: manifestChanged || profileChanged,
}, null, 2));
