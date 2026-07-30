#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";
import { fingerprintPath } from "./model_fingerprint.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const skillDirectory = path.dirname(scriptDirectory);
const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function execute(script, scriptArgs = []) {
  return run(process.execPath, [path.join(scriptDirectory, script), ...scriptArgs], {
    cwd: skillDirectory,
  });
}

if (args[0] !== "run") {
  fail(
    "用法：kacha.mjs optimization-audit run --golden-report FILE "
      + "--test-report FILE --asr-report FILE --install-report FILE [--output FILE]",
    2,
  );
}
const goldenInput = option("--golden-report");
const testInput = option("--test-report");
const asrInput = option("--asr-report");
const installReportInput = option("--install-report");
if (!goldenInput || !testInput || !asrInput || !installReportInput) {
  fail(
    "--golden-report、--test-report、--asr-report 与 --install-report 不能为空",
    2,
  );
}
const output = path.resolve(
  option("--output", path.join(process.cwd(), "optimization-audit.json")),
);
const rerunReportFile = path.resolve(
  option("--rerun-report", `${output}.tests.json`),
);
const goldenFile = path.resolve(goldenInput);
const testFile = path.resolve(testInput);
const asrFile = path.resolve(asrInput);
const installFile = path.resolve(installReportInput);
for (const [label, file] of [
  ["golden", goldenFile],
  ["test", testFile],
  ["asr", asrFile],
  ["install", installFile],
]) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(`${label} report 不存在：${file}`, 2);
  }
}
let golden;
let tests;
let asr;
let installReport;
try {
  golden = readJson(goldenFile);
  tests = readJson(testFile);
  asr = readJson(asrFile);
  installReport = readJson(installFile);
} catch (error) {
  fail(`审计证据无法解析：${error.message}`, 2);
}
const submittedTests = tests;

function digestValid(report) {
  return /^[a-f0-9]{64}$/i.test(report?.digest ?? "")
    && sha256Value({ ...report, digest: undefined }) === report.digest;
}

function identityCurrent(identity) {
  return Boolean(
    identity?.path
    && identity?.sha256
    && fs.existsSync(identity.path)
    && fs.statSync(identity.path).isFile()
    && sha256File(identity.path) === identity.sha256,
  );
}

function implementationCurrent(implementation, minimumFiles = 1) {
  const files = implementation?.files;
  return Array.isArray(files)
    && files.length >= minimumFiles
    && files.every(identityCurrent)
    && implementation.digest === sha256Value(
      files.map(({ path: file, sha256 }) => ({ path: file, sha256 })),
    );
}

function verifyGoldenEvidence(report) {
  if (
    !digestValid(report)
    || !implementationCurrent(report.implementation, 10)
    || !identityCurrent(report.source)
    || !identityCurrent(report.output)
  ) {
    return false;
  }
  const featureIdentities = Object.values(report.featureAssets ?? {});
  if (featureIdentities.length < 8 || !featureIdentities.every(identityCurrent)) {
    return false;
  }
  const manifestFile = report.render?.manifest;
  const graphFile = report.render?.graph;
  const qcFile = report.qc?.path;
  if (![manifestFile, graphFile, qcFile].every(
    (file) => file && fs.existsSync(file) && fs.statSync(file).isFile(),
  )) {
    return false;
  }
  try {
    const manifest = readJson(manifestFile);
    const graph = readJson(graphFile);
    const qc = readJson(qcFile);
    return manifest.output?.sha256 === report.output.sha256
      && manifest.graph?.digest === graph.digest
      && manifest.graph?.sha256 === sha256File(graphFile)
      && graph.visual?.overlays?.length > 0
      && Boolean(graph.visual?.subtitles?.identity?.sha256)
      && Boolean(graph.audio?.bgm?.identity?.sha256)
      && graph.audio?.sfx?.length > 0
      && (manifest.outputStems ?? []).length === 4
      && (manifest.outputStems ?? []).every(identityCurrent)
      && qc.sha256 === report.output.sha256
      && ["pass", "pass_with_review"].includes(qc.status)
      && qc.audioStemQc?.status === "pass"
      && report.qc?.digest === (qc.digest ?? sha256Value(qc));
  } catch {
    return false;
  }
}

function verifyAsrEvidence(report) {
  const implementation = report?.provenance?.implementation;
  const serviceFiles = implementation?.service?.files;
  if (
    !digestValid(report)
    || !["pass", "pass_with_review"].includes(report?.status)
    || report.provider !== "local_whisper_mlx"
    || !identityCurrent(report.input)
    || !identityCurrent(implementation?.client)
    || !/^[a-f0-9]{64}$/i.test(implementation?.healthSha256 ?? "")
    || !Array.isArray(serviceFiles)
    || serviceFiles.length === 0
    || !serviceFiles.every(identityCurrent)
    || implementation.service.sha256 !== sha256Value(
      serviceFiles.map(({ path: file, sha256 }) => ({ path: file, sha256 })),
    )
    || report.model?.serviceSha256 !== implementation.service.sha256
    || report.provenance?.externalUpload !== false
    || report.provenance?.endpointScope !== "loopback_only"
  ) {
    return false;
  }
  try {
    const currentModel = fingerprintPath(implementation.model.path);
    return currentModel.sha256 === implementation.model.sha256
      && currentModel.sha256 === report.model?.contentSha256;
  } catch {
    return false;
  }
}

function verifyCurrentInstalls() {
  const result = execute("sync_skill_installs.mjs", [
    "--source",
    skillDirectory,
    "--agent",
    "both",
    "--verify-only",
  ]);
  if (result.status !== 0) return { pass: false, detail: result.stderr.trim() };
  try {
    const report = JSON.parse(result.stdout);
    const targets = report.targets ?? [];
    return {
      pass: report.status === "dry_run_pass"
        && targets.length === 2
        && targets.every(
          (target) => target.digest === report.bundleDigest && target.action === "unchanged",
        ),
      detail: report,
    };
  } catch (error) {
    return { pass: false, detail: error.message };
  }
}

function verifyInstallEvidence(report, currentVerification) {
  if (!currentVerification.pass) return false;
  const current = currentVerification.detail;
  const targets = report?.targets ?? [];
  return ["applied", "dry_run_pass"].includes(report?.status)
    && /^[a-f0-9]{64}$/i.test(report?.bundleDigest ?? "")
    && report.bundleDigest === current.bundleDigest
    && targets.length === 2
    && targets.every(
      (target) => target.digest === report.bundleDigest
        && ["replaced", "unchanged"].includes(target.action),
    );
}

const goldenEvidenceVerified = verifyGoldenEvidence(golden);
const asrEvidenceVerified = verifyAsrEvidence(asr);
const currentInstallVerification = goldenEvidenceVerified && asrEvidenceVerified
  ? verifyCurrentInstalls()
  : { pass: false, detail: "skipped because media or ASR evidence is invalid" };
const installEvidenceVerified = verifyInstallEvidence(
  installReport,
  currentInstallVerification,
);
let testRerun = null;
if (
  goldenEvidenceVerified
  && asrEvidenceVerified
  && currentInstallVerification.pass
  && installEvidenceVerified
) {
  fs.mkdirSync(path.dirname(rerunReportFile), { recursive: true });
  const result = run(process.execPath, [
    path.join(skillDirectory, "tests", "run_tests.mjs"),
    "--report",
    rerunReportFile,
  ], { cwd: skillDirectory });
  testRerun = fs.existsSync(rerunReportFile)
    ? readJson(rerunReportFile)
    : { status: "fail", failed: [{ error: result.stderr.trim() }] };
  tests = testRerun;
}
let loaded;
try {
  loaded = loadKachaConfig({
    args,
    anchorPath: skillDirectory,
    includeSecrets: false,
  });
} catch (error) {
  fail(`配置无效：${error.message}`, 2);
}

const commandChecks = [
  ["config", "kacha_config.mjs", ["validate", "--no-secrets"]],
  ["rules", "decision_rules.mjs", ["validate"]],
  ["design", "kacha_design.mjs", ["validate"]],
  ["beauty", "kacha_beauty.mjs", ["validate"]],
].map(([id, script, commandArgs]) => {
  const result = execute(script, commandArgs);
  return {
    id,
    status: result.status === 0 ? "pass" : "fail",
    evidence: result.status === 0
      ? JSON.parse(result.stdout)
      : String(result.stderr || result.stdout).trim().slice(0, 1000),
  };
});
const stagePackets = {};
for (const stage of ["inventory", "content", "edit", "visual_audio", "release"]) {
  const result = execute("prepare_agent_packet.mjs", [
    "--task",
    "source_edit",
    "--stage",
    stage,
    "--model-tier",
    "economy",
    "--modules",
    "audio,beauty,covers,generated,netstyle,subtitles",
  ]);
  if (result.status !== 0) {
    stagePackets[stage] = { status: "fail", error: result.stderr.trim() };
  } else {
    const packet = JSON.parse(result.stdout);
    stagePackets[stage] = {
      status: packet.contextBudget?.withinBudget === true
        && packet.packetBudget?.withinBudget === true
        ? "pass"
        : "fail",
      referenceCount: packet.readOrder?.length ?? 0,
      approximateReferenceTokens:
        packet.contextBudget?.approximateInputTokens ?? null,
      approximatePacketTokens:
        packet.packetBudget?.approximateInputTokens ?? null,
      referenceLimit: packet.contextBudget?.limit ?? null,
      packetLimit: packet.packetBudget?.limit ?? null,
    };
  }
}
const config = loaded.config;
const installEvidence = {
  path: installFile,
  sha256: sha256File(installFile),
  report: installReport,
};
const checks = {
  evidenceProvenanceVerified: goldenEvidenceVerified
    && asrEvidenceVerified
    && currentInstallVerification.pass
    && installEvidenceVerified
    && Boolean(testRerun),
  fullRegressionPassed: testRerun?.status === "pass"
    && Number(tests.failed?.length ?? 0) === 0
    && Number(tests.passed ?? tests.tests ?? 0) >= 80,
  warmHighValueCacheTargetPassed: Array.isArray(tests.passedTests)
    && tests.passedTests.includes(
      "warm high-value cache rerun exceeds the 80 percent reuse target",
    ),
  economyDecisionGoldenPassed: Array.isArray(tests.passedTests)
    && tests.passedTests.includes(
      "deterministic rule engine gives weak models stable scored decisions",
    ),
  realFinalGoldenEvidence: golden.sample?.mode === "final"
    && /^[a-f0-9]{64}$/.test(golden.source?.sha256 ?? "")
    && /^[a-f0-9]{64}$/.test(golden.output?.sha256 ?? ""),
  oneFinalEncode: golden.checks?.oneFullVideoEncode === true,
  exactReuseZeroEncode: golden.checks?.exactReuseZeroEncode === true,
  geometryPreserved: golden.checks?.geometryPreserved === true,
  avDriftWithinOneFrame: golden.checks?.avDriftWithinOneFrame === true,
  technicalQcPassed: golden.checks?.technicalQcPassed === true,
  noSilentFallback: golden.checks?.noSilentFallback === true,
  fullFeatureTimelineCovered: golden.checks?.featureTimelineCovered === true,
  finalMixContributionProved: golden.checks?.finalMixContributionProved === true,
  stagePacketsWithinBudget: Object.values(stagePackets)
    .every((stage) => stage.status === "pass"),
  deterministicDecisionRules: commandChecks
    .find((check) => check.id === "rules")?.status === "pass",
  localAsrConfigured: config.execution.asr.provider === "local_whisper_mlx"
    && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/.test(
      config.tools.whisperEndpoint,
    ),
  localAsrCanaryPassed: ["pass", "pass_with_review"].includes(asr.status)
    && asr.provider === "local_whisper_mlx"
    && asr.provenance?.externalUpload === false
    && asr.provenance?.endpointScope === "loopback_only"
    && typeof asr.text === "string"
    && asr.text.trim().length > 0
    && Array.isArray(asr.segments)
    && asr.segments.length > 0,
  highValueCacheComplete: [
    "source_separation",
    "asr",
    "mask",
    "tracking",
    "beauty",
    "styleframe",
    "generated_media",
  ].every((kind) => config.execution.artifactCache.highValueKinds.includes(kind)),
  heavyResourceSerialization: config.execution.resourceScheduling.capacities.mps === 1
    && config.execution.resourceScheduling.capacities.videoEncode === 1
    && config.execution.resourceScheduling.scope === "host",
  singleFinalEncodeConfigured:
    config.execution.unifiedRender.singleFinalVideoEncode === true,
  telemetryMandatory: config.execution.telemetry.enabled === true
    && config.execution.telemetry.compactToolOutput === true
    && Array.isArray(tests.passedTests)
    && tests.passedTests.includes(
      "telemetry captures model usage from child JSON without manual token flags",
    ),
  cacheShaVerificationMandatory:
    config.execution.artifactCache.verifySha256 === true,
  beautyDefaultOff: config.editingDefaults.parameters.beauty.enabled === false,
  humanQcContractPreserved: Array.isArray(golden.remainingHumanEvidence)
    && golden.remainingHumanEvidence.length >= 3,
  doubleInstallVerified: currentInstallVerification.pass,
  submittedInstallEvidenceMatchesCurrent: installEvidenceVerified,
};
const requiredChecks = Object.entries(checks)
  .filter(([, value]) => value !== null);
const passed = requiredChecks.every(([, value]) => value === true)
  && commandChecks.every((check) => check.status === "pass");
const report = {
  schemaVersion: "1.0",
  status: passed
    ? "pass_with_runtime_human_review_required"
    : "fail",
  generatedAt: new Date().toISOString(),
  implementation: fileIdentity(scriptFile),
  checks,
  commandChecks,
  stagePackets,
  evidence: {
    golden: {
      path: goldenFile,
      sha256: sha256File(goldenFile),
      status: golden.status,
      digest: golden.digest,
    },
    tests: {
      submitted: {
        path: testFile,
        sha256: sha256File(testFile),
        status: submittedTests.status,
        passed: submittedTests.passed ?? submittedTests.tests,
        failed: submittedTests.failed?.length ?? 0,
      },
      rerun: testRerun
        ? {
            path: rerunReportFile,
            sha256: sha256File(rerunReportFile),
            status: testRerun.status,
            passed: testRerun.passed ?? testRerun.tests,
            failed: testRerun.failed?.length ?? 0,
          }
        : null,
      status: tests.status,
      passed: tests.passed ?? tests.tests,
      failed: tests.failed?.length ?? 0,
    },
    asr: {
      path: asrFile,
      sha256: sha256File(asrFile),
      status: asr.status,
      provider: asr.provider,
      inputSha256: asr.input?.sha256 ?? null,
      segmentCount: asr.segments?.length ?? 0,
    },
    installation: {
      ...installEvidence,
      verifiedAgainstCurrentBundle: installEvidenceVerified,
    },
    currentInstallation: currentInstallVerification.detail,
  },
  configurationDigest: loaded.digest,
  runtimeBoundary:
    "工程优化通过不替代每条正式成片的正常速度通看、耳机/手机试听和发布批准。",
};
report.digest = sha256Value({ ...report, digest: undefined });
writeJsonAtomic(output, report);
console.log(JSON.stringify({
  status: report.status,
  output,
  checks,
  digest: report.digest,
}, null, 2));
if (!passed) process.exit(1);
