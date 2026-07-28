#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  acquireFileLock,
  commandExists,
  readJson,
  resolveFrom,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { diagnostic } from "./kacha_error_catalog.mjs";

const args = process.argv.slice(2);
const input = args.find((item) => !item.startsWith("--"));

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function repeated(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function fail(code, detail, exitCode = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    diagnostics: [diagnostic(code, detail)],
  }, null, 2));
  process.exit(exitCode);
}

const contextInput = option("--context");
const outputInput = option("--output");
const maxFrames = Number(option("--max-frames", "6"));
const promptOverride = option("--prompt");
const selectedIds = repeated("--frame-id");
const dryRun = args.includes("--dry-run");
const allowUpload = args.includes("--allow-external-upload");
const useConfiguredNetwork = args.includes("--use-configured-network");

if (
  !input
  || !(Number.isInteger(maxFrames) && maxFrames >= 1 && maxFrames <= 12)
) {
  fail(
    "KACHA-E140",
    "用法：kacha.mjs vision-enrich visual-evidence.json "
      + "--context project-context.json --allow-external-upload "
      + "[--frame-id frame-001] [--max-frames 6] [--output FILE] "
      + "[--prompt TEXT] [--dry-run] [--use-configured-network]",
    2,
  );
}
const evidenceFile = path.resolve(input);
if (!fs.existsSync(evidenceFile)) {
  fail("KACHA-E100", `视觉证据不存在：${evidenceFile}`);
}
let evidence;
try {
  evidence = readJson(evidenceFile);
} catch (error) {
  fail("KACHA-E140", `视觉证据无法解析：${error.message}`);
}
if (
  evidence.schemaVersion !== "1.0"
  || !Array.isArray(evidence.frames)
  || evidence.frames.length === 0
) {
  fail("KACHA-E140", "输入不是有效的 visual-evidence 1.0");
}

let context = null;
let contextFile = null;
if (contextInput) {
  contextFile = path.resolve(contextInput);
  if (!fs.existsSync(contextFile)) {
    fail("KACHA-E100", `project context 不存在：${contextFile}`);
  }
  try {
    context = readJson(contextFile);
  } catch (error) {
    fail("KACHA-E140", `project context 无法解析：${error.message}`);
  }
}
if (!dryRun) {
  if (
    !context
    || context.authorization?.externalUploadAllowed !== true
    || context.authorization?.paidGenerationAllowed !== true
    || !allowUpload
  ) {
    fail(
      "KACHA-E410",
      "MiniMax 视觉增强必须同时满足 externalUploadAllowed=true、"
        + "paidGenerationAllowed=true 和命令行 --allow-external-upload",
    );
  }
  if (!commandExists("mmx")) {
    fail("KACHA-E130", "mmx CLI 不可用");
  }
}

function spread(values, limit) {
  if (values.length <= limit) return values;
  if (limit === 1) return [values[Math.floor(values.length / 2)]];
  return Array.from({ length: limit }, (_, index) => (
    values[Math.round(index * (values.length - 1) / (limit - 1))]
  ));
}

let frames = evidence.frames;
if (selectedIds.length > 0) {
  const wanted = new Set(selectedIds);
  frames = frames.filter((frame) => wanted.has(frame.id));
  const missing = selectedIds.filter(
    (id) => !evidence.frames.some((frame) => frame.id === id),
  );
  if (missing.length > 0) {
    fail("KACHA-E140", `未知 frame-id：${missing.join(", ")}`);
  }
  frames = spread(frames, maxFrames);
} else {
  const priorityIds = new Set(
    (evidence.findings ?? [])
      .filter((item) => item.severity === "review")
      .map((item) => item.frameId),
  );
  const priority = frames.filter((frame) => priorityIds.has(frame.id));
  const remaining = frames.filter((frame) => !priorityIds.has(frame.id));
  const selected = [
    ...spread(priority, Math.min(priority.length, maxFrames)),
    ...spread(remaining, Math.max(0, maxFrames - Math.min(priority.length, maxFrames))),
  ];
  const order = new Map(evidence.frames.map((frame, index) => [frame.id, index]));
  frames = selected.sort((left, right) => order.get(left.id) - order.get(right.id));
}
frames = frames.map((frame) => ({
  ...frame,
  path: resolveFrom(evidenceFile, frame.path),
}));
for (const frame of frames) {
  if (!fs.existsSync(frame.path) || !fs.statSync(frame.path).isFile()) {
    fail("KACHA-E100", `关键帧不存在：${frame.path}`);
  }
  if (fs.statSync(frame.path).size > 20 * 1024 * 1024) {
    fail("KACHA-E140", `关键帧超过 MiniMax 20MB 限制：${frame.path}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(frame.sha256 ?? "")) {
    fail("KACHA-E110", `关键帧缺少有效 SHA-256：${frame.id}`);
  }
  const actualSha256 = sha256File(frame.path);
  if (actualSha256 !== frame.sha256) {
    fail(
      "KACHA-E110",
      `关键帧在 visual-evidence 后发生变化：${frame.id}`,
    );
  }
}

const prompt = promptOverride || [
  "你是视频剪辑视觉质检员。只分析这一张关键帧，不臆测看不见的前后动作。",
  "输出严格 JSON，不要 Markdown，字段为：",
  "{\"sceneSummary\":\"\",\"visibleSubjects\":[{\"role\":\"\",\"appearance\":\"\",\"action\":\"\",\"position\":\"\"}],",
  "\"visibleText\":[\"\"],\"composition\":{\"shotScale\":\"\",\"headIntegrity\":\"pass|review|not_applicable\",",
  "\"faceOcclusion\":\"pass|review|not_applicable\",\"safeNegativeSpace\":\"\"},",
  "\"continuitySignals\":[\"\"],\"semanticRisks\":[\"\"],\"qualityRisks\":[\"\"],",
  "\"confidence\":0.0,\"uncertainties\":[\"\"]}。",
  "中文简洁作答；无法确认时写入 uncertainties，禁止把推断写成事实。",
].join("");
const promptSha256 = sha256Value(prompt);
const outputFile = path.resolve(
  outputInput || path.join(path.dirname(evidenceFile), "visual-evidence-minimax.json"),
);
if (outputFile === evidenceFile) {
  fail("KACHA-E140", "MiniMax 增强输出不得覆盖本地 visual-evidence 输入");
}
const cacheDirectory = path.join(path.dirname(evidenceFile), ".cache", "minimax-vision");
const contextSha256 = contextFile ? sha256File(contextFile) : null;
const plan = {
  schemaVersion: "1.0",
  status: dryRun ? "dry_run" : "ready",
  evidence: evidenceFile,
  context: contextFile,
  output: outputFile,
  frames: frames.map((frame) => ({
    id: frame.id,
    timestampSeconds: frame.timestampSeconds,
    path: frame.path,
    sha256: frame.sha256,
  })),
  upload: {
    wholeVideo: false,
    contactSheet: false,
    selectedFrames: frames.length,
    authorized: Boolean(
      context?.authorization?.externalUploadAllowed === true
        && context?.authorization?.paidGenerationAllowed === true
        && allowUpload,
    ),
  },
  provider: {
    name: "MiniMax",
    transport: "mmx vision describe",
    network: useConfiguredNetwork ? "configured_environment" : "direct_no_proxy",
  },
  promptSha256,
};
if (dryRun) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

const version = run("mmx", ["--version"]);
const mmxVersion = (version.stdout || version.stderr).trim() || "unknown";
fs.mkdirSync(cacheDirectory, { recursive: true });
let releaseLock = null;
try {
  releaseLock = acquireFileLock(path.join(cacheDirectory, ".enrich.lock"), {
    purpose: `minimax-vision:${path.basename(evidenceFile)}`,
  });
} catch (error) {
  fail("KACHA-E500", error.message);
}
process.on("exit", () => releaseLock?.());

function safeNetworkEnvironment() {
  const environment = { ...process.env };
  if (useConfiguredNetwork) return environment;
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete environment[key];
  }
  const noProxy = new Set(
    String(environment.NO_PROXY || environment.no_proxy || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  for (const host of [
    "api.minimaxi.com",
    "platform.minimaxi.com",
    "api.minimax.io",
    "platform.minimax.io",
  ]) {
    noProxy.add(host);
  }
  environment.NO_PROXY = [...noProxy].join(",");
  environment.no_proxy = environment.NO_PROXY;
  return environment;
}

function textFromResponse(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(textFromResponse).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    for (const key of ["content", "text", "description", "message", "output", "data"]) {
      if (Object.hasOwn(value, key)) {
        const result = textFromResponse(value[key]);
        if (result) return result;
      }
    }
  }
  return "";
}

function parseStrictJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function hasValidRemoteSchema(value) {
  return Boolean(
    value
    && typeof value === "object"
    && typeof value.sceneSummary === "string"
    && Array.isArray(value.visibleSubjects)
    && Array.isArray(value.visibleText)
    && value.composition
    && typeof value.composition === "object"
    && Array.isArray(value.continuitySignals)
    && Array.isArray(value.semanticRisks)
    && Array.isArray(value.qualityRisks)
    && Number.isFinite(value.confidence)
    && value.confidence >= 0
    && value.confidence <= 1
    && Array.isArray(value.uncertainties)
  );
}

const results = [];
for (const frame of frames) {
  const cacheKey = sha256Value({
    frameSha256: frame.sha256,
    promptSha256,
    mmxVersion,
    transport: "vision-describe",
  });
  const cacheFile = path.join(cacheDirectory, `${cacheKey}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = readJson(cacheFile);
      results.push({ ...cached, cache: "hit" });
      continue;
    } catch {
      // Corrupt cache is overwritten only after a successful response.
    }
  }
  const response = run("mmx", [
    "vision",
    "describe",
    "--image",
    frame.path,
    "--prompt",
    prompt,
    "--output",
    "json",
    "--quiet",
    "--non-interactive",
    "--timeout",
    "120",
  ], {
    env: safeNetworkEnvironment(),
  });
  if (response.status !== 0) {
    fail(
      "KACHA-E500",
      `MiniMax frame=${frame.id} 失败，未自动重试：${response.stderr.trim() || response.stdout.trim()}`,
    );
  }
  let envelope;
  try {
    envelope = JSON.parse(response.stdout);
  } catch {
    envelope = response.stdout.trim();
  }
  const rawText = textFromResponse(envelope);
  const parsed = parseStrictJson(rawText);
  const schemaValid = hasValidRemoteSchema(parsed);
  const item = {
    frameId: frame.id,
    timestampSeconds: frame.timestampSeconds,
    frameSha256: frame.sha256,
    cacheKey,
    cache: "miss",
    provider: "MiniMax",
    transport: "mmx vision describe",
    mmxVersion,
    analyzedAt: new Date().toISOString(),
    parsed,
    parseStatus: !parsed ? "raw_only" : schemaValid ? "pass" : "schema_fail",
    rawText,
  };
  writeJsonAtomic(cacheFile, item);
  results.push(item);
}

const enriched = {
  ...evidence,
  schemaVersion: "1.1",
  generatedAt: new Date().toISOString(),
  status: results.every((item) => item.parseStatus === "pass")
    ? "pass"
    : "pass_with_unstructured_remote_results",
  analysis: {
    ...evidence.analysis,
    remoteSemantic: results.every((item) => item.parseStatus === "pass")
      ? "pass"
      : "pass_with_schema_gaps",
    remoteSemanticProvider: "MiniMax",
    remoteSemanticFrames: results.length,
  },
  remoteAnalysis: {
    authorization: {
      context: contextFile,
      contextSha256,
      externalUploadAllowed: true,
      paidGenerationAllowed: true,
      explicitFlag: true,
    },
    privacy: {
      wholeVideoUploaded: false,
      contactSheetUploaded: false,
      uploadedFrameIds: results.map((item) => item.frameId),
    },
    provider: plan.provider,
    promptSha256,
    results,
  },
  provenance: {
    ...evidence.provenance,
    externalUpload: true,
    wholeVideoUploaded: false,
    minimaxVision: {
      mmxVersion,
      frames: results.length,
    },
  },
};
writeJsonAtomic(outputFile, enriched);
console.log(JSON.stringify({
  status: enriched.status,
  output: outputFile,
  frames: results.length,
  cacheHits: results.filter((item) => item.cache === "hit").length,
  cacheMisses: results.filter((item) => item.cache === "miss").length,
  wholeVideoUploaded: false,
}, null, 2));
releaseLock?.();
releaseLock = null;
