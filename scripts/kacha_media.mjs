#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compactValue,
  ensureDirectory,
  ensureFile,
  fail,
  now,
  objectSummary,
  option,
  repeated,
  safeId,
  shortDigest,
  writeJson,
} from "./agent_workspace_utils.mjs";
import {
  fileIdentity,
  fileIdentityMatches,
  mediaIndexDigest,
  readJson,
  sha256File,
  sha256Value,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = args[0];
const mediaExtensions = new Set([
  ".mp4", ".mov", ".m4v", ".mkv", ".webm",
  ".jpg", ".jpeg", ".png", ".webp", ".heic",
  ".wav", ".aif", ".aiff", ".m4a", ".mp3", ".flac",
]);

function usage() {
  fail(
    "KACHA-E140",
    "用法：kacha.mjs media index --root DIR [--catalog catalog.json] "
      + "[--visual-evidence evidence.json] --output media-index.json\n"
      + "  kacha.mjs media search media-index.json --query TEXT "
      + "[--limit 8] [--kind video|image|audio] [--license LICENSE]",
    2,
  );
}

function tokenize(text) {
  const normalized = String(text ?? "").toLowerCase().normalize("NFKC");
  const words = (normalized.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? [])
    .filter((token) => token.length >= 2 || /^\d+$/.test(token));
  const chineseRuns = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  const chinese = [];
  for (const run of chineseRuns) {
    const characters = [...run];
    chinese.push(...characters);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      chinese.push(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return [...new Set([...words, ...chinese])];
}

function loadConfiguration() {
  const file = path.join(scriptDirectory, "..", "config", "media-search.json");
  return readJson(file);
}

function expand(tokens, groups) {
  const result = new Set(tokens);
  for (const group of groups) {
    const groupTokens = new Set(group.flatMap(tokenize));
    if (tokens.some((token) => groupTokens.has(token))) {
      group.flatMap(tokenize).forEach((token) => result.add(token));
    }
  }
  return [...result];
}

function kindFromPath(file) {
  const extension = path.extname(file).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".heic"].includes(extension)) return "image";
  if ([".wav", ".aif", ".aiff", ".m4a", ".mp3", ".flac"].includes(extension)) return "audio";
  return "video";
}

function scan(root, maxFiles) {
  const files = [];
  const pending = [root];
  let truncated = false;
  let visitedDirectories = 0;
  while (pending.length > 0 && !truncated) {
    const current = pending.pop();
    visitedDirectories += 1;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ["node_modules", "output", "outputs"].includes(entry.name)) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && mediaExtensions.has(path.extname(entry.name).toLowerCase())) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        files.push(absolute);
      }
    }
  }
  return {
    files,
    truncated,
    maxFiles,
    visitedDirectories,
    pendingDirectories: pending.length,
  };
}

function semanticBinary() {
  if (process.platform !== "darwin") {
    return { binary: null, limitation: "apple_natural_language_requires_macos" };
  }
  const source = path.join(scriptDirectory, "local_semantic_similarity.swift");
  if (!fs.existsSync(source)) {
    return { binary: null, limitation: "semantic_helper_missing" };
  }
  const cacheRoot = path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "kacha",
    "semantic",
    "v1",
  );
  fs.mkdirSync(cacheRoot, { recursive: true });
  const binary = path.join(cacheRoot, `local-semantic-${sha256File(source).slice(0, 16)}`);
  if (fs.existsSync(binary) && fs.statSync(binary).isFile()) {
    return { binary, limitation: null };
  }
  const xcrun = fs.existsSync("/usr/bin/xcrun") ? "/usr/bin/xcrun" : null;
  if (!xcrun) return { binary: null, limitation: "xcrun_unavailable" };
  const temporary = `${binary}.tmp-${process.pid}`;
  const compiled = spawnSync(
    xcrun,
    ["swiftc", source, "-O", "-o", temporary],
    { encoding: "utf8" },
  );
  if (compiled.status !== 0) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    return {
      binary: null,
      limitation: `semantic_compile_failed:${compactValue(compiled.stderr, 120)}`,
    };
  }
  fs.renameSync(temporary, binary);
  fs.chmodSync(binary, 0o700);
  return { binary, limitation: null };
}

function semanticDocuments(items) {
  return items.map((item) => ({
    id: item.ref,
    text: compactValue([
      item.fields?.description,
      item.fields?.tags,
      item.fields?.labels,
      item.fields?.transcript,
      item.fields?.ocr,
      item.fields?.filename,
    ].filter(Boolean).join("。"), 2000),
  }));
}

function localSemanticScores(query, items) {
  const runtime = semanticBinary();
  if (!runtime.binary) {
    return {
      available: false,
      engine: "lexical_fallback",
      language: null,
      results: new Map(),
      limitation: runtime.limitation,
    };
  }
  const result = spawnSync(runtime.binary, [], {
    input: JSON.stringify({
      query,
      documents: semanticDocuments(items),
    }),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return {
      available: false,
      engine: "lexical_fallback",
      language: null,
      results: new Map(),
      limitation: `semantic_runtime_failed:${compactValue(result.stderr, 120)}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      available: parsed.available === true,
      engine: parsed.engine,
      language: parsed.language ?? null,
      results: new Map((parsed.results ?? []).map((entry) => [entry.id, entry])),
      limitation: parsed.limitation ?? null,
    };
  } catch (error) {
    return {
      available: false,
      engine: "lexical_fallback",
      language: null,
      results: new Map(),
      limitation: `semantic_response_invalid:${error.message}`,
    };
  }
}

function sidecarMetadata(file) {
  const candidates = [
    `${file}.kacha.json`,
    `${file.slice(0, -path.extname(file).length)}.kacha.json`,
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return { path: candidate, value: readJson(candidate) };
    } catch (error) {
      fail("KACHA-E140", `素材 sidecar 无法解析：${candidate}: ${error.message}`);
    }
  }
  return { path: null, value: {} };
}

function catalogEntries(catalogFile) {
  if (!catalogFile) return [];
  const file = ensureFile(catalogFile, "素材 catalog");
  const catalog = readJson(file);
  const entries = Array.isArray(catalog) ? catalog : catalog.entries;
  if (!Array.isArray(entries)) {
    fail("KACHA-E140", "素材 catalog 必须是数组或包含 entries 数组", 2);
  }
  return entries.map((entry, index) => ({
    ...entry,
    __catalog: file,
    __index: index,
  }));
}

function visualEntries(files) {
  const entries = [];
  for (const input of files) {
    const file = ensureFile(input, "视觉证据");
    const evidence = readJson(file);
    const sourcePath = evidence.source?.path;
    for (const frame of evidence.frames ?? []) {
      const labels = [
        ...(frame.localVision?.classifications ?? []).map((item) => item.identifier),
        ...(frame.localVision?.recognizedText ?? []).map((item) => item.text),
        ...((frame.localVision?.faces?.length ?? 0) > 0 ? ["人物", "人脸"] : []),
        ...((frame.localVision?.humans?.length ?? 0) > 0 ? ["人物", "真人"] : []),
      ];
      entries.push({
        id: `frame-${safeId(frame.id)}-${shortDigest(sourcePath)}`,
        path: frame.path,
        sourcePath,
        kind: "image",
        start: frame.timestampSeconds,
        end: frame.timestampSeconds,
        labels,
        ocr: (frame.localVision?.recognizedText ?? []).map((item) => item.text).join(" "),
        description: labels.join(" "),
        provenance: {
          kind: "local_visual_evidence",
          evidence: file,
          externalUpload: false,
        },
      });
    }
  }
  return entries;
}

function mergeProvenance(left, right) {
  const flatten = (value) => value?.kind === "merged_local_sources"
    ? value.sources ?? []
    : value ? [value] : [];
  const sources = [...flatten(left), ...flatten(right)];
  const unique = [...new Map(sources.map((source) => [sha256Value(source), source])).values()];
  if (unique.length <= 1) return unique[0] ?? null;
  const evidence = unique
    .map((source) => source.evidence ?? source.source ?? source.assetId ?? null)
    .filter(Boolean);
  return {
    kind: "merged_local_sources",
    evidence: evidence.length > 0 ? evidence : null,
    sources: unique,
    externalUpload: false,
  };
}

function normalizeEntry(entry, root) {
  const file = path.resolve(root, entry.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const identity = fileIdentity(file);
  const sidecar = sidecarMetadata(file);
  const merged = { ...sidecar.value, ...entry };
  const id = safeId(
    merged.id ?? `${path.relative(root, file)}-${identity.sizeBytes}`,
    "asset",
  );
  return {
    id,
    ref: `@asset:${id}`,
    kind: merged.kind ?? kindFromPath(file),
    path: file,
    sourcePath: merged.sourcePath ? path.resolve(root, merged.sourcePath) : null,
    identity,
    range: (
      Number.isFinite(Number(merged.start))
      || Number.isFinite(Number(merged.end))
    ) ? {
        start: Number(merged.start ?? merged.end),
        end: Number(merged.end ?? merged.start),
      } : null,
    fields: {
      filename: path.basename(file),
      tags: Array.isArray(merged.tags) ? merged.tags.join(" ") : String(merged.tags ?? ""),
      description: String(merged.description ?? merged.summary ?? ""),
      labels: Array.isArray(merged.labels) ? merged.labels.join(" ") : String(merged.labels ?? ""),
      transcript: String(merged.transcript ?? merged.text ?? ""),
      ocr: String(merged.ocr ?? ""),
    },
    license: merged.license ?? merged.provenance?.license ?? "unknown",
    provenance: merged.provenance ?? {
      kind: entry.__catalog ? "local_catalog" : sidecar.path ? "local_sidecar" : "local_file",
      evidence: entry.__catalog ?? sidecar.path,
      ...(entry.__catalog ? { catalogIndex: entry.__index } : {}),
      externalUpload: false,
    },
    semanticEvidence: [
      ...(merged.description || merged.summary ? ["description"] : []),
      ...(merged.tags ? ["tags"] : []),
      ...(merged.labels ? ["labels"] : []),
      ...(merged.transcript || merged.text ? ["transcript"] : []),
      ...(merged.ocr ? ["ocr"] : []),
      ...(!merged.description && !merged.tags && !merged.labels
        && !merged.transcript && !merged.ocr ? ["filename_only"] : []),
    ],
  };
}

if (!["index", "search"].includes(action)) usage();

if (action === "index") {
  const root = ensureDirectory(option(args, "--root", process.cwd()));
  const output = option(args, "--output");
  if (!output) usage();
  const configuration = loadConfiguration();
  const maxFiles = Number(option(args, "--max-files", "5000"));
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 50000) {
    fail("KACHA-E140", "--max-files 必须是 1–50000", 2);
  }
  const scanResult = args.includes("--no-scan")
    ? {
        files: [],
        truncated: false,
        maxFiles,
        visitedDirectories: 0,
        pendingDirectories: 0,
      }
    : scan(root, maxFiles);
  const scanned = scanResult.files.map((file) => ({ path: file }));
  const entries = [
    ...scanned,
    ...catalogEntries(option(args, "--catalog")),
    ...visualEntries(repeated(args, "--visual-evidence")),
  ];
  const byKey = new Map();
  for (const entry of entries) {
    const normalized = normalizeEntry(entry, root);
    if (!normalized) continue;
    const key = `${normalized.path}:${normalized.range?.start ?? ""}:${normalized.range?.end ?? ""}`;
    const prior = byKey.get(key);
    byKey.set(key, prior
      ? {
          ...prior,
          kind: normalized.kind ?? prior.kind,
          sourcePath: normalized.sourcePath ?? prior.sourcePath,
          license: !["unknown", "unverified"].includes(normalized.license)
            ? normalized.license
            : prior.license,
          provenance: mergeProvenance(prior.provenance, normalized.provenance),
          fields: Object.fromEntries(
            Object.keys(prior.fields).map((field) => [
              field,
              [prior.fields[field], normalized.fields[field]].filter(Boolean).join(" "),
            ]),
          ),
          semanticEvidence: [...new Set([
            ...prior.semanticEvidence,
            ...normalized.semanticEvidence,
          ])],
        }
      : normalized);
  }
  const items = [...byKey.values()];
  const itemRefs = new Set();
  for (const item of items) {
    if (itemRefs.has(item.ref)) {
      fail("KACHA-E140", `素材索引出现重复 ref：${item.ref}；请为 catalog 项提供唯一 id`, 2);
    }
    itemRefs.add(item.ref);
  }
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_media_index",
    digestVersion: "2",
    generatedAt: now(),
    status: "pass",
    engine: configuration.engine,
    privacy: {
      localOnly: true,
      externalUpload: false,
    },
    root,
    items,
    summary: {
      items: items.length,
      byKind: Object.fromEntries(
        [...new Set(items.map((item) => item.kind))]
          .map((kind) => [kind, items.filter((item) => item.kind === kind).length]),
      ),
      evidenceLevels: Object.fromEntries(
        [...new Set(items.flatMap((item) => item.semanticEvidence))]
          .map((level) => [level, items.filter(
            (item) => item.semanticEvidence.includes(level),
          ).length]),
      ),
      scan: {
        files: scanResult.files.length,
        maxFiles: scanResult.maxFiles,
        truncated: scanResult.truncated,
        visitedDirectories: scanResult.visitedDirectories,
        pendingDirectories: scanResult.pendingDirectories,
      },
    },
  };
  report.digest = mediaIndexDigest(report);
  writeJson(output, report);
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    index: path.resolve(output),
    digest: report.digest,
    summary: report.summary,
    limitations: [
      ...(items.some((item) => item.semanticEvidence.includes("filename_only"))
        ? ["仅文件名素材不具备可靠画面语义；可补 sidecar、转写或 visual-evidence"]
        : []),
      ...(scanResult.truncated
        ? [`扫描达到 --max-files=${maxFiles}，索引不完整；应提高上限或缩小 root`]
        : []),
    ],
  }, null, 2));
  process.exit(0);
}

const indexFile = ensureFile(args[1], "素材索引");
const query = option(args, "--query");
const limit = Number(option(args, "--limit", "8"));
if (!query || !Number.isInteger(limit) || limit < 1 || limit > 50) usage();
const index = readJson(indexFile);
if (
  index.schemaVersion !== "1.0"
  || index.kind !== "kacha_media_index"
  || index.digestVersion !== "2"
  || !Array.isArray(index.items)
  || index.digest !== mediaIndexDigest(index)
) {
  fail("KACHA-E140", "素材索引格式无效", 2);
}
const indexRefs = new Set();
for (const [itemIndex, item] of index.items.entries()) {
  if (!item.ref || indexRefs.has(item.ref)) {
    fail("KACHA-E140", `素材索引 items[${itemIndex}].ref 缺失或重复`, 2);
  }
  indexRefs.add(item.ref);
  if (
    !item.identity?.sha256
    || path.resolve(item.identity.path ?? "") !== path.resolve(item.path ?? "")
  ) {
    fail("KACHA-E140", `素材索引 items[${itemIndex}] 缺少与 path 一致的强文件身份`, 2);
  }
}
const configuration = loadConfiguration();
const baseTokens = tokenize(query);
const queryTokens = expand(baseTokens, configuration.synonymGroups ?? []);
const phrase = String(query).toLowerCase().normalize("NFKC");
const kind = option(args, "--kind");
const license = option(args, "--license");
const eligible = index.items
  .filter((item) => !kind || item.kind === kind)
  .filter((item) => !license || item.license === license)
  .sort((left, right) => left.ref.localeCompare(right.ref));
const semanticLimit = Number(configuration.semantic?.maxCandidates ?? 5000);
const semanticCandidates = eligible.slice(0, semanticLimit);
const semantic = localSemanticScores(query, semanticCandidates);
const semanticWeight = Number(configuration.semantic?.weight ?? 5);
const minimumSemanticSimilarity = Number(
  configuration.semantic?.minimumSimilarity ?? 0.4,
);
const scored = [];
for (const item of eligible) {
  let score = 0;
  const matches = [];
  for (const [field, text] of Object.entries(item.fields ?? {})) {
    const tokens = new Set(tokenize(text));
    const matched = queryTokens.filter((token) => tokens.has(token));
    if (matched.length > 0) {
      const fieldScore = matched.length * Number(configuration.fieldWeights?.[field] ?? 1);
      score += fieldScore;
      matches.push({ field, tokens: matched.slice(0, 8), score: Number(fieldScore.toFixed(3)) });
    }
    if (phrase.length >= 2 && String(text).toLowerCase().includes(phrase)) {
      score += 4;
      matches.push({ field, phrase: compactValue(query, 40), score: 4 });
    }
  }
  const semanticResult = semantic.results.get(item.ref);
  if (semanticResult?.similarity >= minimumSemanticSimilarity) {
    const semanticScore = semanticResult.similarity * semanticWeight;
    score += semanticScore;
    matches.push({
      field: "local_semantic_embedding",
      similarity: Number(semanticResult.similarity.toFixed(4)),
      distance: Number(semanticResult.distance.toFixed(4)),
      score: Number(semanticScore.toFixed(3)),
    });
  }
  if (score <= 0) continue;
  if (!fileIdentityMatches(item.path, item.identity)) {
    fail("KACHA-E120", `素材索引已过期：${item.ref} 的文件内容或身份已变化，请重建索引`);
  }
  const evidenceFactor = item.semanticEvidence?.includes("filename_only") ? 0.6 : 1;
  scored.push({
    score: Number((score * evidenceFactor).toFixed(4)),
    ref: item.ref,
    kind: item.kind,
    path: item.path,
    sourcePath: item.sourcePath,
    range: item.range,
    description: compactValue(item.fields?.description || item.fields?.labels || item.fields?.filename),
    license: item.license,
    semanticEvidence: item.semanticEvidence,
    whyMatched: matches,
  });
}
scored.sort((left, right) => right.score - left.score || left.ref.localeCompare(right.ref));
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: "pass",
  index: indexFile,
  indexDigest: index.digest,
  query,
  engine: semantic.available
    ? `${configuration.engine}+${semantic.engine}`
    : `${configuration.engine}+lexical_fallback`,
  semantic: {
    available: semantic.available,
    engine: semantic.engine,
    language: semantic.language,
    limitation: semantic.limitation,
    candidates: semanticCandidates.length,
    truncated: eligible.length > semanticCandidates.length,
    minimumSimilarity: minimumSemanticSimilarity,
  },
  queryExpansion: {
    inputTokens: baseTokens,
    expandedTokens: queryTokens,
  },
  results: scored.slice(0, limit),
  resultCount: Math.min(scored.length, limit),
  totalMatches: scored.length,
  privacy: {
    localOnly: true,
    externalUpload: false,
  },
}, null, 2));
