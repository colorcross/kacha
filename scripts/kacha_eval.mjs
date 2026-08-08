#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  readJson,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const configFile = path.join(skillRoot, "config", "intelligence-v6.json");

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function ensureFile(file, label) {
  const resolved = path.resolve(file ?? "");
  if (!file || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label}不存在：${resolved}`);
  }
  return resolved;
}

function stableDigest(value) {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  delete copy.digest;
  return sha256Value(copy);
}

function write(value, output = null) {
  if (output) writeJsonAtomic(path.resolve(output), value);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function nonnegativeInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0;
}

function validateDataset(dataset) {
  const errors = [];
  if (dataset.schemaVersion !== "1.0" || dataset.kind !== "kacha_editorial_eval_dataset") {
    errors.push("dataset 必须是 kacha_editorial_eval_dataset@1.0");
  }
  if (!dataset.id || !dataset.version) errors.push("dataset id/version 不能为空");
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    errors.push("dataset.cases 不能为空");
  }
  const ids = new Set();
  const sourceGroups = new Set();
  for (const [index, item] of (dataset.cases ?? []).entries()) {
    const label = `cases[${index}]`;
    if (!item.id || ids.has(item.id)) errors.push(`${label}.id 缺失或重复`);
    ids.add(item.id);
    if (!item.sourceGroupId) errors.push(`${label}.sourceGroupId 不能为空`);
    else if (sourceGroups.has(item.sourceGroupId)) errors.push(`${label}.sourceGroupId 在同一版本中重复`);
    else sourceGroups.add(item.sourceGroupId);
    if (!item.showId || !item.styleId || !item.platform) {
      errors.push(`${label} 缺少 showId/styleId/platform`);
    }
    const judgment = item.editorialJudgment;
    if (!judgment || judgment.humanReviewed !== true) {
      errors.push(`${label}.editorialJudgment 必须由人类明确复核`);
      continue;
    }
    if (!(Number(judgment.outputDurationSeconds) > 0)) {
      errors.push(`${label}.outputDurationSeconds 必须大于 0`);
    }
    if (!(Number(judgment.manualInterventionMinutes) >= 0)) {
      errors.push(`${label}.manualInterventionMinutes 必须为非负数`);
    }
    if (!(Number(judgment.firstDraftUsability) >= 0 && Number(judgment.firstDraftUsability) <= 1)) {
      errors.push(`${label}.firstDraftUsability 必须在 0–1`);
    }
    for (const group of ["semanticUnits", "highImpactDecisions", "connections", "captions", "styleGrammar"]) {
      if (!judgment[group] || !nonnegativeInteger(judgment[group].total)) {
        errors.push(`${label}.${group}.total 必须为非负整数`);
      }
    }
    const pairs = [
      ["semanticUnits", "damaged"],
      ["highImpactDecisions", "accepted"],
      ["highImpactDecisions", "adjusted"],
      ["highImpactDecisions", "rejected"],
      ["connections", "rejected"],
      ["captions", "corrected"],
      ["styleGrammar", "violations"],
    ];
    for (const [group, field] of pairs) {
      if (!nonnegativeInteger(judgment[group]?.[field])) {
        errors.push(`${label}.${group}.${field} 必须为非负整数`);
      }
      if (Number(judgment[group]?.[field]) > Number(judgment[group]?.total)) {
        errors.push(`${label}.${group}.${field} 不能大于 total`);
      }
    }
    const decisionTotal = Number(judgment.highImpactDecisions?.accepted ?? 0)
      + Number(judgment.highImpactDecisions?.adjusted ?? 0)
      + Number(judgment.highImpactDecisions?.rejected ?? 0);
    if (decisionTotal !== Number(judgment.highImpactDecisions?.total ?? -1)) {
      errors.push(`${label}.highImpactDecisions 三类结果之和必须等于 total`);
    }
    if (
      !item.evidence
      || !item.evidence.reviewer
      || !item.evidence.reviewedAt
      || !Number.isFinite(Date.parse(item.evidence.reviewedAt))
    ) {
      errors.push(`${label}.evidence 必须记录 reviewer 和有效 reviewedAt`);
    }
    if (item.evidence?.normalSpeedReview !== true) {
      errors.push(`${label}.evidence.normalSpeedReview 必须为 true`);
    }
    if (item.evidence?.phoneAndHeadphoneReview !== true) {
      errors.push(`${label}.evidence.phoneAndHeadphoneReview 必须为 true`);
    }
  }
  return errors;
}

function summarizeCases(cases, config) {
  const totals = {
    cases: cases.length,
    firstDraftUsable: 0,
    firstDraftUsabilitySum: 0,
    outputMinutes: 0,
    interventionMinutes: 0,
    semanticTotal: 0,
    semanticDamaged: 0,
    decisionTotal: 0,
    decisionAccepted: 0,
    decisionAdjusted: 0,
    decisionRejected: 0,
    connectionTotal: 0,
    connectionRejected: 0,
    captionTotal: 0,
    captionCorrected: 0,
    styleTotal: 0,
    styleViolations: 0,
  };
  const dimensions = {};
  for (const item of cases) {
    const judgment = item.editorialJudgment;
    totals.firstDraftUsabilitySum += Number(judgment.firstDraftUsability);
    if (Number(judgment.firstDraftUsability) >= config.firstDraftUsableThreshold) {
      totals.firstDraftUsable += 1;
    }
    totals.outputMinutes += Number(judgment.outputDurationSeconds) / 60;
    totals.interventionMinutes += Number(judgment.manualInterventionMinutes);
    totals.semanticTotal += Number(judgment.semanticUnits.total);
    totals.semanticDamaged += Number(judgment.semanticUnits.damaged);
    totals.decisionTotal += Number(judgment.highImpactDecisions.total);
    totals.decisionAccepted += Number(judgment.highImpactDecisions.accepted);
    totals.decisionAdjusted += Number(judgment.highImpactDecisions.adjusted);
    totals.decisionRejected += Number(judgment.highImpactDecisions.rejected);
    totals.connectionTotal += Number(judgment.connections.total);
    totals.connectionRejected += Number(judgment.connections.rejected);
    totals.captionTotal += Number(judgment.captions.total);
    totals.captionCorrected += Number(judgment.captions.corrected);
    totals.styleTotal += Number(judgment.styleGrammar.total);
    totals.styleViolations += Number(judgment.styleGrammar.violations);
    const key = `${item.showId}|${item.styleId}|${item.platform}`;
    dimensions[key] = (dimensions[key] ?? 0) + 1;
  }
  const metrics = {
    firstDraftUsableRate: ratio(totals.firstDraftUsable, totals.cases),
    meanFirstDraftUsability: totals.cases > 0
      ? round(totals.firstDraftUsabilitySum / totals.cases)
      : null,
    highImpactDecisionAcceptRate: ratio(totals.decisionAccepted, totals.decisionTotal),
    highImpactDecisionAdjustmentRate: ratio(totals.decisionAdjusted, totals.decisionTotal),
    highImpactDecisionRejectRate: ratio(totals.decisionRejected, totals.decisionTotal),
    semanticDamageRate: ratio(totals.semanticDamaged, totals.semanticTotal),
    manualInterventionMinutesPerOutputMinute: ratio(
      totals.interventionMinutes,
      totals.outputMinutes,
    ),
    connectionRejectRate: ratio(totals.connectionRejected, totals.connectionTotal),
    captionCorrectionRate: ratio(totals.captionCorrected, totals.captionTotal),
    styleGrammarViolationRate: ratio(totals.styleViolations, totals.styleTotal),
  };
  return {
    totals,
    metrics,
    combinations: Object.entries(dimensions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => ({ key, cases: count })),
  };
}

export function scoreDataset(datasetFile) {
  const file = ensureFile(datasetFile, "评测数据集");
  const dataset = readJson(file);
  const errors = validateDataset(dataset);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const config = readJson(configFile).evaluation;
  const { totals, metrics, combinations } = summarizeCases(dataset.cases, config);
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_editorial_eval_report",
    generatedAt: new Date().toISOString(),
    status: "measured",
    dataset: fileIdentity(file),
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    humanReviewedCases: totals.cases,
    metrics,
    totals,
    coverage: {
      combinations,
      claims: "仅代表当前数据集；没有对未覆盖栏目、风格、平台或素材类型外推",
    },
    claimPolicy: {
      qualityClaimAllowed: true,
      improvementClaimAllowed: false,
      reason: "单份报告只建立基线；提升声明必须使用同源成对比较",
    },
  };
  report.digest = stableDigest(report);
  return report;
}

function validateReport(report) {
  return report.schemaVersion === "1.0"
    && report.kind === "kacha_editorial_eval_report"
    && report.digest === stableDigest(report);
}

function boundDataset(identity, label) {
  const file = ensureFile(identity?.path, label);
  const current = fileIdentity(file);
  if (!identity?.sha256 || current.sha256 !== identity.sha256) {
    throw new Error(`${label}内容已变化，不能沿用旧评测报告`);
  }
  const dataset = readJson(file);
  const errors = validateDataset(dataset);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return dataset;
}

export function compareReports(baselineFile, candidateFile) {
  const baselinePath = ensureFile(baselineFile, "基线报告");
  const candidatePath = ensureFile(candidateFile, "候选报告");
  const baseline = readJson(baselinePath);
  const candidate = readJson(candidatePath);
  if (!validateReport(baseline) || !validateReport(candidate)) {
    throw new Error("基线或候选评测报告 digest 无效");
  }
  const baselineDataset = boundDataset(baseline.dataset, "基线数据集");
  const candidateDataset = boundDataset(candidate.dataset, "候选数据集");
  const baselineByGroup = new Map(baselineDataset.cases.map((item) => [item.sourceGroupId, item]));
  const candidateByGroup = new Map(candidateDataset.cases.map((item) => [item.sourceGroupId, item]));
  const shared = [...baselineByGroup.keys()].filter((id) => candidateByGroup.has(id)).sort();
  const config = readJson(configFile).evaluation;
  const minimum = config.minimumComparisonCases;
  const baselinePaired = summarizeCases(shared.map((id) => baselineByGroup.get(id)), config);
  const candidatePaired = summarizeCases(shared.map((id) => candidateByGroup.get(id)), config);
  const lowerIsBetter = new Set([
    "semanticDamageRate",
    "manualInterventionMinutesPerOutputMinute",
    "connectionRejectRate",
    "captionCorrectionRate",
    "styleGrammarViolationRate",
    "highImpactDecisionRejectRate",
    "highImpactDecisionAdjustmentRate",
  ]);
  const deltas = {};
  for (const key of new Set([
    ...Object.keys(baselinePaired.metrics),
    ...Object.keys(candidatePaired.metrics),
  ])) {
    const before = baselinePaired.metrics[key];
    const after = candidatePaired.metrics[key];
    if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after)) {
      deltas[key] = { baseline: before ?? null, candidate: after ?? null, delta: null, direction: "unavailable" };
      continue;
    }
    const delta = round(after - before);
    const improved = lowerIsBetter.has(key) ? delta < 0 : delta > 0;
    deltas[key] = {
      baseline: before,
      candidate: after,
      delta,
      direction: delta === 0 ? "unchanged" : improved ? "improved" : "regressed",
    };
  }
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_editorial_eval_comparison",
    generatedAt: new Date().toISOString(),
    baseline: fileIdentity(baselinePath),
    candidate: fileIdentity(candidatePath),
    pairedSourceGroups: shared,
    pairedCaseCount: shared.length,
    minimumComparisonCases: minimum,
    pairedTotals: {
      baseline: baselinePaired.totals,
      candidate: candidatePaired.totals,
    },
    deltas,
    claimPolicy: {
      improvementClaimAllowed: shared.length >= minimum,
      reason: shared.length >= minimum
        ? "达到最小同源成对样本数；仍须报告各维度而非只报综合分"
        : `仅 ${shared.length} 个同源样本，少于最低 ${minimum} 个，不能宣称整体提升`,
    },
  };
  report.digest = stableDigest(report);
  return report;
}

function templateDataset() {
  return {
    schemaVersion: "1.0",
    kind: "kacha_editorial_eval_dataset",
    id: "replace-with-dataset-id",
    version: "v1",
    cases: [
      {
        id: "case-001",
        sourceGroupId: "same-source-across-versions-001",
        showId: "tool-share",
        styleId: "light-warm-overlay",
        platform: "wechat-channels",
        editorialJudgment: {
          humanReviewed: true,
          firstDraftUsability: 0,
          outputDurationSeconds: 60,
          manualInterventionMinutes: 0,
          semanticUnits: { total: 1, damaged: 0 },
          highImpactDecisions: { total: 1, accepted: 0, adjusted: 0, rejected: 1 },
          connections: { total: 1, rejected: 0 },
          captions: { total: 1, corrected: 0 },
          styleGrammar: { total: 1, violations: 0 }
        },
        evidence: {
          reviewer: "replace-with-reviewer",
          reviewedAt: "replace-with-ISO-8601-time",
          normalSpeedReview: true,
          phoneAndHeadphoneReview: true
        }
      }
    ]
  };
}

export function runEvalCli(args = process.argv.slice(2)) {
  const action = args[0];
  if (action === "template") {
    const value = templateDataset();
    const output = option(args, "--output");
    if (!output) throw new Error("eval template 需要 --output FILE");
    write(value, output);
    return;
  }
  if (action === "validate") {
    const file = ensureFile(option(args, "--dataset"), "评测数据集");
    const dataset = readJson(file);
    const errors = validateDataset(dataset);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    write({ schemaVersion: "1.0", status: "pass", dataset: fileIdentity(file), cases: dataset.cases.length });
    return;
  }
  if (action === "score") {
    write(scoreDataset(option(args, "--dataset")), option(args, "--output"));
    return;
  }
  if (action === "compare") {
    write(
      compareReports(option(args, "--baseline"), option(args, "--candidate")),
      option(args, "--output"),
    );
    return;
  }
  throw new Error("用法：kacha.mjs eval template|validate|score|compare [options]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runEvalCli();
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: "1.0",
      status: "blocked",
      diagnostics: [{ code: "KACHA-E170", detail: error.message }],
    }, null, 2));
    process.exit(1);
  }
}
