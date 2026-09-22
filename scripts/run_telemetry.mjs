#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  readJson,
  resolveRuntimeCommand,
  runtimeEnvironment,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";

import { extractUsage, tokenEvidence, accountingEvents, ledgerAccounting } from "./telemetry_usage.mjs";

const args = process.argv.slice(2);
const delimiter = args.indexOf("--");
const wrapperArgs = delimiter >= 0 ? args.slice(0, delimiter) : args;
const action = firstPositional(wrapperArgs, [
  "--operation-id",
  "--attempt",
  "--usage-scope",
  "--cost-entry",
  "--cost-ledger",
  "--project-root",
  "--metrics",
  "--stage",
  "--model-tier",
  "--input-tokens",
  "--output-tokens",
  "--reference-tokens",
  "--usage-file",
  "--agent-packet",
  "--cache-status",
  "--rendered-seconds",
  "--source-seconds",
  "--video-encodes",
  "--mode",
  "--artifact",
  "--workflow",
  "--version-id",
  "--render-scope",
  "--qc-scope",
  "--approval-evidence",
  "--config",
  "--secrets",
]) ?? "help";

function option(name, fallback = null) {
  const index = wrapperArgs.indexOf(name);
  return index >= 0 ? wrapperArgs[index + 1] : fallback;
}

function repeated(name) {
  const values = [];
  const limit = delimiter >= 0 ? delimiter : args.length;
  for (let index = 0; index < limit; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function numberOption(name, environmentName = null, fallback = null) {
  const raw = option(name, environmentName ? process.env[environmentName] : null);
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是非负数字`);
  }
  return value;
}

function redactCommand(command) {
  const sensitive = /(?:key|token|secret|password|authorization|credential)/i;
  return command.map((part, index) => {
    const text = String(part);
    if (index > 0 && sensitive.test(String(command[index - 1]))) return "[REDACTED]";
    if (sensitive.test(text) && text.includes("=")) {
      return `${text.slice(0, text.indexOf("="))}=[REDACTED]`;
    }
    if (/(?:authorization\s*:\s*)?(?:Bearer|Basic)\s+/i.test(text)) {
      return text.replace(
        /((?:authorization\s*:\s*)?(?:Bearer|Basic))\s+\S+/gi,
        "$1 [REDACTED]",
      );
    }
    if (/^[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=/i.test(text)) {
      return `${text.split("=")[0]}=[REDACTED]`;
    }
    if (/^(?:Bearer|Basic)\s+/i.test(text)) return "[REDACTED]";
    return text;
  });
}

function redactText(value) {
  return String(value ?? "")
    .replace(
      /((?:authorization\s*:\s*)?(?:Bearer|Basic))\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1 [REDACTED]",
    )
    .replace(
      /(("?(?:api.?key|access.?token|refresh.?token|token|secret|password|credential)"?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      '$1"[REDACTED]"',
    );
}

function redactValue(value, key = "") {
  if (/(?:key|token|secret|password|authorization|credential)/i.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactValue(child, childKey),
      ]),
    );
  }
  return typeof value === "string" ? redactText(value) : value;
}

function compactFailure(text, maximum) {
  const value = redactText(text).trim();
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}…`;
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function estimatePacketTokens(packetFile) {
  if (!packetFile) return null;
  const resolved = path.resolve(packetFile);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`agent packet 不存在：${resolved}`);
  }
  const characters = [...fs.readFileSync(resolved, "utf8")].length;
  return Math.ceil(characters / 4);
}

function loadEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function aggregate(rawEvents, eventFile) {
  const accounting = accountingEvents(rawEvents);
  const events = accounting.events;
  const usageEvents = new Set(accounting.usage);
  const workEvents = new Set(accounting.work);
  const stageSeconds = {};
  const stageDetails = {};
  const statusCounts = {};
  const cacheCounts = { hit: 0, miss: 0, bypass: 0, unknown: 0 };
  const tokens = {
    input: 0,
    output: 0,
    references: 0,
    measuredEvents: 0,
    estimatedEvents: 0,
    unavailableEvents: 0,
    mixedEvents: 0,
    fields: Object.fromEntries(["input", "output", "references"].map(key => [key, { measured: 0, estimated: 0, knownEvents: 0, unavailableEvents: 0 }])),
  };
  let videoEncodes = 0;
  let renderedSeconds = 0;
  let sourceSeconds = 0;
  let artifacts = 0;
  for (const original of events) {
    const event = { ...original, tokens: usageEvents.has(original) ? original.tokens : {}, media: workEvents.has(original) ? original.media : {}, timing: workEvents.has(original) ? original.timing : { wallSeconds: 0 } };
    stageSeconds[event.stage] = Number(
      ((stageSeconds[event.stage] ?? 0) + Number(event.timing?.wallSeconds ?? 0))
        .toFixed(6),
    );
    statusCounts[event.status] = (statusCounts[event.status] ?? 0) + 1;
    const detail = stageDetails[event.stage] ?? {
      events: 0,
      wallSeconds: 0,
      inputTokens: 0,
      outputTokens: 0,
      referenceTokens: 0,
      videoEncodes: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
    detail.events += 1;
    detail.wallSeconds += Number(event.timing?.wallSeconds ?? 0);
    detail.inputTokens += Number(event.tokens?.input ?? 0);
    detail.outputTokens += Number(event.tokens?.output ?? 0);
    detail.referenceTokens += Number(event.tokens?.references ?? 0);
    detail.videoEncodes += Number(event.media?.videoEncodes ?? 0);
    if (event.cache?.status === "hit") detail.cacheHits += 1;
    if (event.cache?.status === "miss") detail.cacheMisses += 1;
    stageDetails[event.stage] = detail;
    const cacheStatus = Object.hasOwn(cacheCounts, event.cache?.status)
      ? event.cache.status
      : "unknown";
    cacheCounts[cacheStatus] += 1;
    videoEncodes += Number(event.media?.videoEncodes ?? 0);
    renderedSeconds += Number(event.media?.renderedSeconds ?? 0);
    sourceSeconds = Math.max(sourceSeconds, Number(event.media?.sourceSeconds ?? 0));
    artifacts += event.artifacts?.length ?? 0;
    for (const key of ["input", "output", "references"]) {
      tokens[key] += Number(event.tokens?.[key] ?? 0);
      if (usageEvents.has(original)) {
        const measurement = event.tokens?.fields?.[key]?.measurement ?? (event.tokens?.[key] == null ? "unavailable" : event.tokens?.measurement === "actual" ? "measured" : event.tokens?.measurement === "estimated" ? "estimated" : "unavailable");
        if (measurement === "measured" || measurement === "estimated") { tokens.fields[key][measurement] += Number(event.tokens?.[key] ?? 0); tokens.fields[key].knownEvents += 1; }
        else tokens.fields[key].unavailableEvents += 1;
      }
    }
    if (!usageEvents.has(original)) continue;
    if (event.tokens?.measurement === "mixed") {
      tokens.mixedEvents += 1;
    } else if (event.tokens?.measurement === "actual") {
      tokens.measuredEvents += 1;
    } else if (event.tokens?.measurement === "estimated") {
      tokens.estimatedEvents += 1;
    } else {
      tokens.unavailableEvents += 1;
    }
  }
  for (const key of ["input", "output", "references"]) {
    if (tokens.fields[key].knownEvents === 0) tokens[key] = null;
    tokens.fields[key].complete = tokens.fields[key].knownEvents > 0 && tokens.fields[key].unavailableEvents === 0;
  }
  const complete = events.length > 0
    && events.every((event) => event.status === "pass");
  const normalizedStageDetails = Object.fromEntries(
    Object.entries(stageDetails).map(([stage, detail]) => [
      stage,
      {
        ...detail,
        wallSeconds: Number(detail.wallSeconds.toFixed(6)),
        totalTokens: detail.inputTokens + detail.outputTokens + detail.referenceTokens,
      },
    ]),
  );
  const byWallTime = Object.entries(normalizedStageDetails)
    .sort((left, right) => (
      right[1].wallSeconds - left[1].wallSeconds
      || left[0].localeCompare(right[0])
    ))
    .map(([stage, detail]) => ({ stage, ...detail }));
  const byTokens = [...byWallTime].sort((left, right) => (
    right.totalTokens - left.totalTokens
    || left.stage.localeCompare(right.stage)
  ));
  const totalWallSeconds = byWallTime.reduce(
    (sum, detail) => sum + detail.wallSeconds,
    0,
  );
  const recommendations = [];
  if (videoEncodes > 1) {
    recommendations.push("检测到多次视频编码：合并到统一 Timeline IR/Render Graph。");
  }
  if (cacheCounts.miss > cacheCounts.hit) {
    recommendations.push("缓存 miss 多于 hit：仅复用或预热已经确定会使用的 ASR/分离/蒙版/美颜/生成资产。");
  }
  if (tokens.references > tokens.input + tokens.output && tokens.references > 0) {
    recommendations.push("reference token 占主导：改用阶段 packet 和按需规则检索。");
  }
  if (byTokens[0]?.totalTokens > 12_000) {
    recommendations.push(`阶段 ${byTokens[0].stage} 超过 12k tokens：继续拆分转写窗口或模块。`);
  }
  return {
    schemaVersion: "2.0",
    generatedAt: new Date().toISOString(),
    status: complete ? "pass" : events.length > 0 ? "has_failures" : "empty",
    eventLog: path.resolve(eventFile),
    events: events.length,
    duplicateEvents: accounting.duplicateEvents,
    timing: accounting.timing,
    accounting: { usageEvents: accounting.usage.length, workEvents: accounting.work.length, referencesMayOverlapInput: true },
    cash: ledgerAccounting(events, readJson),
    stages: stageSeconds,
    stageDetails: normalizedStageDetails,
    statuses: statusCounts,
    cache: {
      ...cacheCounts,
      hitRatio: cacheCounts.hit + cacheCounts.miss > 0
        ? Number((cacheCounts.hit / (cacheCounts.hit + cacheCounts.miss)).toFixed(6))
        : null,
    },
    tokens,
    media: {
      videoEncodes,
      renderedSeconds: Number(renderedSeconds.toFixed(6)),
      sourceSeconds: Number(sourceSeconds.toFixed(6)),
      renderRatio: sourceSeconds > 0
        ? Number((renderedSeconds / sourceSeconds).toFixed(6))
        : null,
    },
    artifacts,
    bottlenecks: {
      dominantTimeStage: byWallTime[0]
        ? {
            ...byWallTime[0],
            wallShare: totalWallSeconds > 0
              ? Number((byWallTime[0].wallSeconds / totalWallSeconds).toFixed(6))
              : null,
          }
        : null,
      dominantTokenStage: byTokens[0] ?? null,
      byWallTime,
      byTokens,
      recommendations,
    },
    digest: sha256Value(events),
  };
}

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs metrics run --stage STAGE --project-root DIR [指标] -- COMMAND [ARGS...]\n"
      + "  kacha.mjs metrics summarize --project-root DIR [--metrics FILE]\n"
      + "指标：--model-tier economy|balanced|frontier "
      + "--input-tokens N --output-tokens N --reference-tokens N "
      + "--usage-file USAGE.json --agent-packet PACKET.json "
      + "--cache-status hit|miss|bypass|unknown --rendered-seconds N "
      + "--source-seconds N --video-encodes N --mode preview|final "
      + "--workflow first_edit|incremental --version-id ID "
      + "--render-scope none|range|layer|full --qc-scope none|delta|full "
      + "--approval-evidence FILE "
      + "--artifact FILE（可重复）",
  );
}

let loadedConfig;
try {
  loadedConfig = loadKachaConfig({
    args: wrapperArgs,
    anchorPath: option("--project-root", process.cwd()),
    includeSecrets: false,
  });
} catch (error) {
  console.error(`配置无效：${error.message}`);
  process.exit(2);
}
const telemetryConfig = loadedConfig.config.execution.telemetry;
const projectRoot = path.resolve(option("--project-root", process.cwd()));
const telemetryRoot = path.resolve(
  projectRoot,
  option("--metrics", telemetryConfig.directory),
);
const eventFile = telemetryRoot.endsWith(".jsonl")
  ? telemetryRoot
  : path.join(telemetryRoot, "events.jsonl");
const reportFile = telemetryRoot.endsWith(".jsonl")
  ? path.join(path.dirname(telemetryRoot), "run-metrics.json")
  : path.join(telemetryRoot, "run-metrics.json");

if (action === "summarize") {
  try {
    const report = aggregate(loadEvents(eventFile), eventFile);
    writeJsonAtomic(reportFile, report);
    console.log(JSON.stringify({ status: report.status, output: reportFile, report }, null, 2));
  } catch (error) {
    console.error(`无法汇总运行指标：${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (action !== "run") {
  usage();
  process.exit(2);
}

const stage = option("--stage");
const command = delimiter >= 0 ? args.slice(delimiter + 1) : [];
const modelTier = option("--model-tier", loadedConfig.config.execution.modelTier);
const cacheStatus = option("--cache-status", "unknown");
const mode = option("--mode", "preview");
const workflow = option("--workflow", "first_edit");
const versionId = option("--version-id");
const renderScope = option("--render-scope", "none");
const qcScope = option("--qc-scope", "none");
if (
  !stage
  || command.length === 0
  || !["economy", "balanced", "frontier"].includes(modelTier)
  || !["hit", "miss", "bypass", "unknown"].includes(cacheStatus)
  || !["preview", "final"].includes(mode)
  || !["first_edit", "incremental"].includes(workflow)
  || !["none", "range", "layer", "full"].includes(renderScope)
  || !["none", "delta", "full"].includes(qcScope)
) {
  usage();
  process.exit(2);
}

try {
  if (!Number.isInteger(numberOption("--attempt", null, 1)) || numberOption("--attempt", null, 1) < 1) throw new Error("attempt 必须为正整数");
  if (!["self", "subtree"].includes(option("--usage-scope", "subtree"))) throw new Error("usage-scope 必须为 self 或 subtree");
  const ledgerPath = option("--cost-ledger") ? path.resolve(projectRoot, option("--cost-ledger")) : null;
  const cashReference = ledgerAccounting([{ cost: { ledger: ledgerPath, entries: repeated("--cost-entry") } }], readJson);
  if (cashReference.errors.length) throw new Error("现金引用不对应有效账本条目");
  if (workflow === "incremental") {
    if (!versionId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(versionId)) {
      throw new Error("增量返工的每次运行必须提供安全的 --version-id");
    }
    const budget = loadedConfig.config.execution.incremental.renderBudget;
    const previous = loadEvents(eventFile).filter(
      (event) => event.workflow?.kind === "incremental"
        && event.workflow?.versionId === versionId
        && event.status === "pass",
    );
    const requestedEncodes = numberOption("--video-encodes", null, renderScope === "full" ? 1 : 0);
    if (renderScope === "full" && requestedEncodes > 0) {
      const approval = option("--approval-evidence");
      if (mode === "preview") {
        if (!approval) {
          throw new Error("整片代理前必须提供 --approval-evidence，证明代表区间已经批准");
        }
        const approvalFile = path.resolve(projectRoot, approval);
        if (!fs.existsSync(approvalFile) || !fs.statSync(approvalFile).isFile()) {
          throw new Error(`代表区间批准证据不存在：${approvalFile}`);
        }
      }
      const previousFullEncodes = previous.reduce(
        (sum, event) => sum + (
          event.workflow?.renderScope === "full"
          && event.mode === mode
            ? Number(event.media?.videoEncodes ?? 0)
            : 0
        ),
        0,
      );
      const maximum = mode === "preview"
        ? budget.maximumFullPreviewEncodesPerVersion
        : budget.maximumFinalEncodesPerVersion;
      if (previousFullEncodes + requestedEncodes > maximum) {
        throw new Error(
          `版本 ${versionId} 的整片${mode === "preview" ? "代理" : "正式"}编码预算已用完；`
          + "请复用当前 Render Graph，或创建新的、有明确失效原因的版本 delta",
        );
      }
    }
    if (qcScope === "full") {
      const previousFullQc = previous.filter(
        (event) => event.workflow?.qcScope === "full",
      ).length;
      if (previousFullQc >= budget.maximumFullQcRunsPerVersion) {
        throw new Error(
          `版本 ${versionId} 已完成一次完整 QC；后续只允许 delta QC，`
          + "结构变化必须创建新版本 delta",
        );
      }
    }
  }
  fs.mkdirSync(path.dirname(eventFile), { recursive: true });
  const logDirectory = path.join(path.dirname(eventFile), "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  const eventSeed = `${startedAt.toISOString()}:${process.pid}:${stage}:${command.join("\0")}`;
  const eventId = crypto.createHash("sha256").update(eventSeed).digest("hex").slice(0, 16);
  const stdoutFile = path.join(logDirectory, `${eventId}.stdout.log`);
  const stderrFile = path.join(logDirectory, `${eventId}.stderr.log`);
  const childEnvironment = { ...runtimeEnvironment(), KACHA_TELEMETRY_PARENT_EVENT_ID: eventId, KACHA_TELEMETRY_OPERATION_ID: option("--operation-id", process.env.KACHA_TELEMETRY_OPERATION_ID ?? eventId) };
  for (const field of ["KACHA_INPUT_TOKENS", "KACHA_OUTPUT_TOKENS", "KACHA_REFERENCE_TOKENS"]) delete childEnvironment[field];
  const result = spawnSync(resolveRuntimeCommand(command[0]), command.slice(1), {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: telemetryConfig.maxLogBytes,
    env: childEnvironment,
  });
  const endedNs = process.hrtime.bigint();
  fs.writeFileSync(stdoutFile, redactText(result.stdout), { mode: 0o600 });
  fs.writeFileSync(
    stderrFile,
    redactText(result.stderr ?? result.error?.message ?? ""),
    { mode: 0o600 },
  );
  let childResult = null;
  try {
    childResult = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    childResult = null;
  }
  let usageResult = null;
  const usageFile = option("--usage-file");
  let usageError = null;
  if (usageFile) {
    try {
    const resolvedUsage = path.resolve(projectRoot, usageFile);
    if (!fs.existsSync(resolvedUsage) || !fs.statSync(resolvedUsage).isFile()) {
      throw new Error(`usage 文件不存在：${resolvedUsage}`);
    }
    usageResult = readJson(resolvedUsage);
    } catch (error) { usageError = error.message; }
  }
  const fileUsage = extractUsage(usageResult), childUsage = extractUsage(childResult);
  const runtimeUsage = Object.fromEntries(["input", "output", "references"].map(key => [key, fileUsage?.[key] ?? childUsage?.[key] ?? null]));
  const explicitInput = numberOption("--input-tokens", "KACHA_INPUT_TOKENS");
  const explicitOutput = numberOption("--output-tokens", "KACHA_OUTPUT_TOKENS");
  const explicitReferences = numberOption(
    "--reference-tokens",
    "KACHA_REFERENCE_TOKENS",
  );
  const packetEstimate = estimatePacketTokens(option("--agent-packet"));
  const tokenValues = tokenEvidence({ explicit: { input: explicitInput, output: explicitOutput, references: explicitReferences },
    usage: runtimeUsage, estimate: packetEstimate, usageSources: Object.fromEntries(["input", "output", "references"].map(key => [key, fileUsage?.[key] != null ? "usage_file" : "child_result_usage"])) });
  const childArtifactCandidates = childResult && typeof childResult === "object"
    ? [
        childResult.output,
        childResult.manifest,
        childResult.graph,
      ].filter((candidate) => typeof candidate === "string")
    : [];
  const artifacts = [
    ...new Set([...repeated("--artifact"), ...childArtifactCandidates]),
  ].map((candidate) => {
    const file = path.resolve(projectRoot, candidate);
    return {
      path: file,
      exists: fs.existsSync(file) && fs.statSync(file).isFile(),
      sizeBytes: fs.existsSync(file) && fs.statSync(file).isFile()
        ? fs.statSync(file).size
        : null,
    };
  });
  const inferredVideoEncodes = numberOption(
    "--video-encodes",
    null,
    Number.isFinite(Number(childResult?.videoEncodes))
      ? Number(childResult.videoEncodes)
      : 0,
  );
  const inferredRenderedSeconds = numberOption(
    "--rendered-seconds",
    null,
    inferredVideoEncodes > 0 && Number.isFinite(Number(childResult?.durationSeconds))
      ? Number(childResult.durationSeconds)
      : 0,
  );
  const inferredCacheStatus = cacheStatus !== "unknown"
    ? cacheStatus
    : childResult?.status === "reused" || childResult?.cache?.status === "hit"
      ? "hit"
      : inferredVideoEncodes > 0 || childResult?.cache?.status === "miss"
        ? "miss"
        : "unknown";
  const event = {
    schemaVersion: "1.0",
    eventId,
    parentEventId: process.env.KACHA_TELEMETRY_PARENT_EVENT_ID ?? null,
    operationId: option("--operation-id", process.env.KACHA_TELEMETRY_OPERATION_ID ?? eventId),
    attempt: numberOption("--attempt", null, 1),
    accounting: { usageScope: option("--usage-scope", explicitInput !== null || explicitOutput !== null ? "self" : "subtree") },
    usageError,
    cost: { ledger: ledgerPath, entries: repeated("--cost-entry"), authority: "cost_ledger_reconciliation" },
    host: os.hostname(),
    pid: process.pid,
    stage,
    mode,
    status: result.status === 0 ? "pass" : "fail",
    command: redactCommand(command),
    timing: {
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      wallSeconds: Number((Number(endedNs - startedNs) / 1e9).toFixed(6)),
    },
    model: { tier: modelTier },
    workflow: {
      kind: workflow,
      versionId: versionId ?? null,
      renderScope,
      qcScope,
      approvalEvidence: option("--approval-evidence")
        ? path.resolve(projectRoot, option("--approval-evidence"))
        : null,
    },
    tokens: { ...tokenValues, source: [...new Set(Object.values(tokenValues.fields).map(field => field.source).filter(value => value !== "unavailable"))].join(",") || "unavailable" },
    cache: { status: inferredCacheStatus },
    media: {
      renderedSeconds: inferredRenderedSeconds,
      sourceSeconds: numberOption("--source-seconds"),
      videoEncodes: inferredVideoEncodes,
    },
    logs: {
      stdout: stdoutFile,
      stderr: stderrFile,
    },
    artifacts,
    configurationDigest: loadedConfig.digest,
  };
  appendJsonLine(eventFile, event);
  const report = aggregate(loadEvents(eventFile), eventFile);
  writeJsonAtomic(reportFile, report);
  const compact = {
    status: event.status,
    eventId,
    stage,
    wallSeconds: event.timing.wallSeconds,
    exitCode: result.status ?? 1,
    logs: event.logs,
    metrics: reportFile,
    artifacts,
    ...(childResult ? { result: redactValue(childResult) } : {}),
    ...(event.status === "fail"
      ? {
          failure: compactFailure(
            result.stderr || result.error?.message || result.stdout,
            telemetryConfig.maxFailureSummaryCharacters,
          ),
        }
      : {}),
  };
  console.log(JSON.stringify(compact, null, 2));
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(`运行遥测失败：${error.message}`);
  process.exit(1);
}
