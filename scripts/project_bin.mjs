import fs from "node:fs";
import path from "node:path";
import {
  fileIdentityMatches,
  mediaIndexDigest,
  readJson,
} from "./kacha_utils.mjs";

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function auditedText(value, maximum = 500) {
  return typeof value === "string"
    && value.trim().length > 0
    && value === value.trim()
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function canonicalRiskState(value) {
  return String(value).trim().toLowerCase();
}

function replacementEligible(item) {
  return !["unknown", "unverified"].includes(canonicalRiskState(item.license))
    && !["unknown", "unverified"].includes(canonicalRiskState(item.provenance?.kind))
    && validEvidence(item.provenance?.evidence);
}

function validEvidence(value) {
  if (auditedText(value, 1000)) return true;
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 32
    && value.every((entry) => auditedText(entry, 1000));
}

function projectRootForTimeline(timelineFile) {
  let current = path.dirname(fs.realpathSync(timelineFile));
  while (true) {
    const state = path.join(current, ".kacha");
    if (fs.existsSync(state) && fs.statSync(state).isDirectory()) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(fs.realpathSync(timelineFile));
    current = parent;
  }
}

function resolveIndex(timelineFile, input) {
  const projectRoot = projectRootForTimeline(timelineFile);
  const candidates = input
    ? [path.resolve(input)]
    : [
        path.join(projectRoot, ".kacha", "media-index.json"),
        path.join(projectRoot, "media-index.json"),
      ];
  const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!file) return { projectRoot, file: null };
  const resolved = fs.realpathSync(file);
  if (!within(fs.realpathSync(projectRoot), resolved)) throw new Error("Project Bin 索引必须位于当前 Timeline 项目内");
  return { projectRoot: fs.realpathSync(projectRoot), file: resolved };
}

function searchableText(item) {
  return [
    item.id,
    item.ref,
    path.basename(item.path ?? ""),
    item.license,
    ...Object.values(item.fields ?? {}).flatMap((value) => Array.isArray(value) ? value : [value]),
  ].join(" ").toLowerCase().normalize("NFKC");
}

function tagsFor(item) {
  const values = [item.fields?.tags, item.fields?.labels].flatMap((value) => (
    Array.isArray(value) ? value : String(value ?? "").split(/[,、|]/)
  ));
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 12);
}

export function listProjectBin(timelineFile, {
  indexPath = null,
  query = "",
  exactRef = null,
  kind = null,
  license = null,
  limit = 40,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Project Bin limit 必须是 1–100 整数");
  }
  const requestedLimit = limit;
  if (typeof query !== "string" || query.length > 500 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error("Project Bin query 必须是至多 500 字符字符串");
  if (indexPath !== null && !auditedText(indexPath, 4096)) throw new Error("Project Bin indexPath 必须是有效路径字符串");
  if (license !== null && !auditedText(license, 100)) throw new Error("Project Bin license 必须是有效字符串");
  if (kind !== null && !["video", "image", "audio"].includes(kind)) throw new Error("Project Bin kind 无效");
  if (exactRef !== null && (typeof exactRef !== "string" || !/^@asset:[^\u0000-\u001f\u007f]{1,240}$/.test(exactRef))) {
    throw new Error("Project Bin exactRef 必须是有效 @asset:id");
  }
  const resolved = resolveIndex(timelineFile, indexPath);
  if (!resolved.file) {
    return {
      schemaVersion: "1.0",
      kind: "kacha-project-bin",
      status: "empty",
      projectRoot: resolved.projectRoot,
      mediaIndex: null,
      query: { text: query, kind, license, limit: requestedLimit },
      items: [],
      limitations: ["当前项目未发现 .kacha/media-index.json；请先运行 kacha media index。"],
    };
  }
  const index = readJson(resolved.file);
  if (
    index?.kind !== "kacha_media_index"
    || index.digestVersion !== "2"
    || !Array.isArray(index.items)
    || index.digest !== mediaIndexDigest(index)
  ) throw new Error("Project Bin media index 身份或 digest 已失效；请重建索引");
  const refs = new Set();
  const ids = new Set();
  for (const [itemIndex, item] of index.items.entries()) {
    if (
      !item || typeof item !== "object" || Array.isArray(item)
      || !auditedText(item.id, 200)
      || typeof item.ref !== "string" || item.ref !== `@asset:${item.id}` || item.ref.length > 247
      || ids.has(item.id) || refs.has(item.ref)
      || !["video", "image", "audio"].includes(item.kind)
      || !auditedText(item.path, 4096)
      || !auditedText(item.license, 100)
      || !item.provenance || typeof item.provenance !== "object" || Array.isArray(item.provenance)
      || !auditedText(item.provenance.kind, 100)
      || (item.provenance.evidence !== null && item.provenance.evidence !== undefined && !validEvidence(item.provenance.evidence))
      || typeof item.provenance.externalUpload !== "boolean"
      || !/^[a-f0-9]{64}$/.test(String(item.identity?.sha256 ?? ""))
      || path.resolve(item.identity?.path ?? "") !== path.resolve(item.path)
    ) throw new Error(`Project Bin media index items[${itemIndex}] 身份、ref 或类型合同无效；请重建索引`);
    ids.add(item.id);
    refs.add(item.ref);
  }
  const needle = query.trim().toLowerCase().normalize("NFKC");
  let staleExcluded = 0;
  let outsideRootExcluded = 0;
  const items = [];
  for (const item of index.items) {
    if (exactRef && item.ref !== exactRef) continue;
    if (kind && item.kind !== kind) continue;
    if (license && canonicalRiskState(item.license) !== canonicalRiskState(license)) continue;
    if (needle && !searchableText(item).includes(needle)) continue;
    if (!item.path || !item.identity || !fileIdentityMatches(item.path, item.identity)) {
      staleExcluded += 1;
      continue;
    }
    const itemRealPath = fs.realpathSync(item.path);
    if (!within(resolved.projectRoot, itemRealPath)) {
      outsideRootExcluded += 1;
      continue;
    }
    const relative = path.relative(resolved.projectRoot, itemRealPath);
    items.push({
      id: item.id,
      ref: item.ref,
      kind: item.kind,
      name: path.basename(item.path),
      path: itemRealPath,
      relativePath: relative,
      folder: path.dirname(relative) === "." ? "项目根目录" : path.dirname(relative),
      range: item.range ?? null,
      identity: { sha256: item.identity.sha256, sizeBytes: item.identity.sizeBytes },
      license: item.license,
      provenance: {
        kind: item.provenance.kind,
        evidence: item.provenance.evidence ?? null,
        externalUpload: item.provenance.externalUpload,
      },
      replacementEligible: replacementEligible(item),
      tags: tagsFor(item),
      semanticEvidence: item.semanticEvidence ?? [],
    });
    if (items.length >= requestedLimit) break;
  }
  return {
    schemaVersion: "1.0",
    kind: "kacha-project-bin",
    status: staleExcluded > 0 || outsideRootExcluded > 0 ? "limited" : "pass",
    projectRoot: resolved.projectRoot,
    mediaIndex: { path: resolved.file, digest: index.digest, status: index.status },
    query: { text: query, kind, license, limit: requestedLimit },
    returned: items.length,
    staleExcluded,
    outsideRootExcluded,
    items,
    limitations: [
      "Project Bin 只展示本地当前强身份索引；不宣称视觉语义理解。",
      ...(staleExcluded ? [`${staleExcluded} 个索引项因当前文件身份失效被排除。`] : []),
      ...(outsideRootExcluded ? [`${outsideRootExcluded} 个索引项因越出当前项目根目录被排除。`] : []),
    ],
  };
}

export function resolveIndexedAsset(timelineFile, { indexPath = null, assetRef }) {
  if (typeof assetRef !== "string" || !/^@asset:[^\u0000-\u001f\u007f]{1,240}$/.test(assetRef)) throw new Error("assetRef 必须是 @asset:id");
  const result = listProjectBin(timelineFile, { indexPath, exactRef: assetRef, limit: 1 });
  const item = result.items.find((candidate) => candidate.ref === assetRef);
  if (!item) throw new Error(`Project Bin 中不存在当前有效素材：${assetRef}`);
  if (!replacementEligible(item)) throw new Error(`素材 ${assetRef} 的许可或 provenance 未验证，不能进入时间线`);
  return item;
}
