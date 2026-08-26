#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
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
import {
  firstPositional,
  loadKachaConfig,
  providerEnvironment,
} from "./kacha_config.mjs";
import { diagnostic } from "./kacha_error_catalog.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const input = firstPositional(args, [
  "--context",
  "--output",
  "--max-frames",
  "--prompt",
  "--frame-id",
  "--cost-ledger",
  "--cost-entry",
  "--config",
  "--secrets",
]);

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
const promptOverride = option("--prompt");
const selectedIds = repeated("--frame-id");
const costLedgerInput = option("--cost-ledger");
const costEntryId = option("--cost-entry");
const dryRun = args.includes("--dry-run");
const allowUpload = args.includes("--allow-external-upload");
let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args,
    anchorPath: input || contextInput || process.cwd(),
    includeSecrets: !dryRun,
  });
} catch (error) {
  fail("KACHA-E140", `配置无效：${error.message}`);
}
const minimaxConfig = loadedConfig.config.execution.minimaxVision;
const providerConfig = loadedConfig.config.providers.minimax;
const maxFrames = Number(option("--max-frames", String(minimaxConfig.maxFrames)));
const hardMaxFrames = minimaxConfig.hardMaxFrames;
const timeoutSeconds = minimaxConfig.timeoutSeconds;
const maximumImageBytes = minimaxConfig.maxImageBytes;
const useConfiguredNetwork = args.includes("--use-configured-network")
  || (
    !args.includes("--direct-no-proxy")
    && minimaxConfig.networkMode === "configured_environment"
  );

if (
  !input
  || (
    args.includes("--use-configured-network")
    && args.includes("--direct-no-proxy")
  )
  || !(Number.isInteger(maxFrames) && maxFrames >= 1 && maxFrames <= hardMaxFrames)
) {
  fail(
    "KACHA-E140",
    "用法：kacha.mjs vision-enrich visual-evidence.json "
      + "--context project-context.json --allow-external-upload "
      + "[--frame-id frame-001] [--max-frames 6] [--output FILE] "
      + "[--prompt TEXT] [--config FILE] [--secrets FILE] "
      + "[--cost-ledger FILE --cost-entry ID] "
      + "[--dry-run] [--use-configured-network|--direct-no-proxy]",
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
  !evidence
  || typeof evidence !== "object"
  || Array.isArray(evidence)
  || evidence.schemaVersion !== "1.0"
  || !Array.isArray(evidence.frames)
  || evidence.frames.length === 0
) {
  fail("KACHA-E140", "输入不是有效的 visual-evidence 1.0");
}
const frameIds = evidence.frames.map((frame) => frame?.id);
if (frameIds.some((id) => typeof id !== "string" || !id) || new Set(frameIds).size !== frameIds.length) {
  fail("KACHA-E140", "visual-evidence frame id 必须非空且唯一");
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
}

let costAuthorization = null;
let costExecutionIntentDigest = null;
function preflightCostAuthorization() {
  if (!costLedgerInput || !costEntryId) {
    fail("KACHA-E410", "MiniMax 真实付费调用必须提供 --cost-ledger 和 --cost-entry 预算预占证据");
  }
  const ledgerFile = path.resolve(costLedgerInput);
  if (!fs.existsSync(ledgerFile) || !fs.statSync(ledgerFile).isFile()) {
    fail("KACHA-E100", `费用账本不存在：${ledgerFile}`);
  }
  let ledger;
  try { ledger = readJson(ledgerFile); }
  catch (error) { fail("KACHA-E140", `费用账本无法解析：${error.message}`); }
  if (ledger?.schemaVersion !== "1.0" || ledger?.kind !== "kacha-cost-ledger" || !Array.isArray(ledger.entries)) {
    fail("KACHA-E410", "费用账本结构无效");
  }
  const entry = ledger.entries.find((item) => item?.id === costEntryId);
  if (!entry) fail("KACHA-E410", `费用预占不存在：${costEntryId}`);
  if (entry.providerId !== "minimax-external" || entry.capability !== "vision-analysis") {
    fail("KACHA-E410", "费用预占与 MiniMax 视觉调用不匹配");
  }
  if (!new Set(["reserved", "approved"]).has(entry.status)) {
    fail("KACHA-E410", `费用预占不可执行：${entry.status}`);
  }
  if (entry.approvalRequired === true && (!entry.approvedAt || !entry.approvalEvidence)) {
    fail("KACHA-E410", "费用预占缺少审批证据");
  }
  if (!Number.isFinite(entry.reservedAmount) || entry.reservedAmount <= 0) {
    fail("KACHA-E410", "费用预占金额必须大于 0；未知费用不能按免费处理");
  }
  return ledgerFile;
}

function requireCostAuthorization() {
  if (costAuthorization) return costAuthorization;
  const ledgerFile = preflightCostAuthorization();
  if (!costExecutionIntentDigest) fail("KACHA-E500", "费用执行意图尚未冻结");
  const executionId = crypto.randomUUID();
  const consumed = run(process.execPath, [
    path.join(scriptDirectory, "cost_ledger.mjs"),
    "consume",
    "--ledger", ledgerFile,
    "--id", costEntryId,
    "--provider", "minimax-external",
    "--capability", "vision-analysis",
    "--execution-id", executionId,
    "--intent-digest", costExecutionIntentDigest,
    "--actor", "vision-enrich",
  ]);
  if (consumed.status !== 0) {
    fail("KACHA-E410", `费用预占无法原子消费：${consumed.stderr.trim() || consumed.stdout.trim()}`);
  }
  let response;
  try { response = JSON.parse(consumed.stdout); }
  catch { fail("KACHA-E500", "费用账本返回了无效响应"); }
  const entry = response.entry;
  if (!entry || entry.status !== "reconciliation_required" || entry.executionId !== executionId) {
    fail("KACHA-E500", "费用预占消费后状态不一致");
  }
  if (!Number.isFinite(entry.reservedAmount) || entry.reservedAmount <= 0) fail("KACHA-E410", "费用预占金额必须大于 0；未知费用不能按免费处理");
  costAuthorization = {
    ledger: ledgerFile,
    ledgerSha256: sha256File(ledgerFile),
    entryId: entry.id,
    status: entry.status,
    executionId,
    executionIntentDigest: costExecutionIntentDigest,
    reservedAmount: entry.reservedAmount,
    currency: entry.currency,
  };
  return costAuthorization;
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
  if (fs.statSync(frame.path).size > maximumImageBytes) {
    fail(
      "KACHA-E140",
      `关键帧超过配置的 MiniMax ${maximumImageBytes} bytes 限制：${frame.path}`,
    );
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
costExecutionIntentDigest = sha256Value({
  providerId: "minimax-external",
  capability: "vision-analysis",
  evidenceSha256: sha256File(evidenceFile),
  contextSha256,
  promptSha256,
  frameSha256s: frames.map((frame) => frame.sha256),
  network: useConfiguredNetwork ? "configured_environment" : "direct_no_proxy",
});
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
    region: providerConfig.region,
    baseUrl: providerConfig.baseUrl,
    network: useConfiguredNetwork ? "configured_environment" : "direct_no_proxy",
    credential: loadedConfig.secrets.credentials.minimax,
  },
  promptSha256,
  configurationDigest: loadedConfig.digest,
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

const providerRuntime = providerEnvironment(loadedConfig, "minimax");

function safeNetworkEnvironment() {
  const environment = { ...providerRuntime.environment };
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

function validCachedItem(value, { cacheKey, frame }) {
  if (!value || typeof value !== "object" || value.cacheKey !== cacheKey || value.frameId !== frame.id || value.frameSha256 !== frame.sha256) return false;
  if (!/^[a-f0-9]{64}$/i.test(value.itemDigest ?? "")) return false;
  const copy = structuredClone(value);
  delete copy.itemDigest;
  return value.itemDigest === sha256Value(copy);
}

const results = [];
for (const frame of frames) {
  const cacheKey = sha256Value({
    frameSha256: frame.sha256,
    promptSha256,
    mmxVersion,
    transport: "vision-describe",
    region: providerConfig.region,
    baseUrl: providerConfig.baseUrl,
    network: plan.provider.network,
  });
  const cacheFile = path.join(cacheDirectory, `${cacheKey}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = readJson(cacheFile);
      if (validCachedItem(cached, { cacheKey, frame })) {
        const hit = { ...cached, cache: "hit", cacheArtifactDigest: cached.itemDigest };
        delete hit.itemDigest;
        hit.itemDigest = sha256Value(hit);
        results.push(hit);
        continue;
      }
    } catch {
      // Corrupt cache is overwritten only after a successful response.
    }
  }
  preflightCostAuthorization();
  if (!commandExists("mmx")) {
    fail("KACHA-E130", "mmx CLI 不可用");
  }
  requireCostAuthorization();
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
    String(timeoutSeconds),
    "--region",
    providerConfig.region,
    ...(providerConfig.baseUrl
      ? ["--base-url", providerConfig.baseUrl]
      : []),
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
  item.itemDigest = sha256Value(item);
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
      cost: costAuthorization,
    },
    privacy: {
      wholeVideoUploaded: false,
      contactSheetUploaded: false,
      uploadedFrameIds: results.map((item) => item.frameId),
    },
    provider: plan.provider,
    promptSha256,
    configurationDigest: loadedConfig.digest,
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
  configurationDigest: loadedConfig.digest,
}, null, 2));
releaseLock?.();
releaseLock = null;
