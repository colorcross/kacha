#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mediaSummary,
  readJson,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { firstPositional, loadKachaConfig } from "./kacha_config.mjs";
import { acquireResourceLeases } from "./resource_pool.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const profilesFile = path.join(skillRoot, "config", "facefusion", "profiles.json");
const args = process.argv.slice(2);
const action = firstPositional(args, [
  "--operation",
  "--profile",
  "--plan",
  "--output",
  "--project-root",
  "--config",
  "--secrets",
  "--timeout",
]);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs facefusion probe [--config FILE]\n"
      + "  kacha.mjs facefusion profiles\n"
      + "  kacha.mjs facefusion template --operation face_swap|lip_sync|face_restore|post_process --output PLAN\n"
      + "  kacha.mjs facefusion validate --plan PLAN [--for-execution]\n"
      + "  kacha.mjs facefusion run --plan PLAN [--project-root DIR] [--timeout SECONDS]",
  );
}

function fail(message, code = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    error: message,
  }, null, 2));
  process.exit(code);
}

function profileBundle() {
  return readJson(profilesFile);
}

function semanticVersion(value) {
  const match = String(value ?? "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function assertServiceCompatibility(health) {
  const required = semanticVersion(profileBundle().serviceMinimumVersion);
  const actual = semanticVersion(health?.facefusion_version);
  if (!actual) {
    throw new Error("FaceFusion /health 未返回可识别的 facefusion_version");
  }
  if (
    required
    && actual.some((value, index) => (
      value !== required[index]
        && actual.slice(0, index).every(
          (previous, previousIndex) => previous === required[previousIndex],
        )
        && value < required[index]
    ))
  ) {
    throw new Error(
      `FaceFusion 版本过低：${health.facefusion_version}，至少需要 `
        + profileBundle().serviceMinimumVersion,
    );
  }
}

function providerAvailable(provider, available) {
  const normalized = String(provider).toLowerCase();
  const aliases = {
    coreml: "coremlexecutionprovider",
    cpu: "cpuexecutionprovider",
    cuda: "cudaexecutionprovider",
    directml: "dmlexecutionprovider",
    openvino: "openvinoexecutionprovider",
    tensorrt: "tensorrtexecutionprovider",
  };
  const expected = aliases[normalized] ?? normalized;
  return available.some(
    (candidate) => String(candidate).toLowerCase() === expected,
  );
}

function profileCompatibility(profile, capabilities) {
  const allowedOptions = new Set(capabilities.allowed_options ?? []);
  const requestedProviders = profile.options.execution_providers ?? [];
  return {
    id: profile.id,
    processorAvailable:
      capabilities.processors?.includes(profile.processor) ?? false,
    optionSetAvailable: Object.keys(profile.options).every(
      (option) => allowedOptions.has(option),
    ),
    executionProvidersAvailable: requestedProviders.every(
      (provider) => providerAvailable(
        provider,
        capabilities.execution_providers ?? [],
      ),
    ),
    modelInstallState: "service_managed_unknown_until_first_run",
    modelLicense: profile.modelLicense,
  };
}

function profileById(id) {
  return profileBundle().profiles.find((profile) => profile.id === id) ?? null;
}

function defaultProfile(operation) {
  return profileBundle().profiles.find(
    (profile) => profile.operation === operation,
  ) ?? null;
}

function tokenFrom(file) {
  if (!file) throw new Error("未配置 tools.faceFusionTokenFile");
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("FaceFusion token 文件权限过宽，必须仅当前用户可读");
  }
  const token = fs.readFileSync(resolved, "utf8").trim();
  if (!token) throw new Error("FaceFusion token 文件为空");
  return token;
}

async function fetchJson(baseUrl, endpoint, token = null, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(Number(options.timeoutMs ?? 30_000)),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`FaceFusion HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function uploadAsset(baseUrl, token, file, timeoutMs) {
  const form = new FormData();
  form.append(
    "file",
    await fs.openAsBlob(file),
    path.basename(file),
  );
  const result = await fetchJson(baseUrl, "/v1/assets", token, {
    method: "POST",
    body: form,
    timeoutMs,
  });
  if (!result.ref) throw new Error("FaceFusion 上传未返回 asset reference");
  return result.ref;
}

function planTemplate(operation) {
  const profile = defaultProfile(operation);
  if (!profile) throw new Error(`未知 operation：${operation}`);
  const identityOperation = ["face_swap", "lip_sync"].includes(operation);
  return {
    schemaVersion: "1.0",
    operation,
    profile: profile.id,
    reason: "",
    inputs: {
      target: "",
      sources: [],
    },
    output: {
      path: "",
      preserveSourceGeometry: true,
      preserveSourceFrameRate: true,
      preserveAudio: operation !== "lip_sync",
    },
    options: {},
    authorization: {
      canExecute: false,
      identityManipulationConsent: identityOperation ? false : null,
      sourceRightsConfirmed: operation === "face_swap" ? false : null,
      targetSubjectConsent: identityOperation ? false : null,
      voiceRightsConfirmed: operation === "lip_sync" ? false : null,
      postProcessingAuthorized: identityOperation ? null : false,
      modelLicenseReviewed: false,
      publicRelease: false,
      disclosureDecisionRecorded: false,
      evidence: "",
    },
    qc: {
      manualReviewRequired: true,
      reviewer: "",
      reviewedAt: null,
      status: "pending",
    },
  };
}

function validatePlan(plan, { forExecution = false } = {}) {
  const errors = [];
  if (plan?.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  const profile = profileById(plan?.profile);
  if (!profile) errors.push(`profile 不存在：${plan?.profile}`);
  if (profile && profile.operation !== plan.operation) {
    errors.push(`profile ${profile.id} 不适用于 ${plan.operation}`);
  }
  const target = plan?.inputs?.target;
  if (typeof target !== "string" || !path.isAbsolute(target)) {
    errors.push("inputs.target 必须是绝对路径");
  } else if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    errors.push(`inputs.target 不存在：${target}`);
  }
  const sources = plan?.inputs?.sources;
  if (!Array.isArray(sources)) errors.push("inputs.sources 必须是数组");
  const requiredSources = ["face_swap", "lip_sync"].includes(plan?.operation);
  if (requiredSources && (!Array.isArray(sources) || sources.length === 0)) {
    errors.push(`${plan.operation} 至少需要一个 inputs.sources`);
  }
  for (const source of Array.isArray(sources) ? sources : []) {
    if (
      !path.isAbsolute(source)
      || !fs.existsSync(source)
      || !fs.statSync(source).isFile()
    ) {
      errors.push(`inputs.sources 不存在或不是绝对文件：${source}`);
    }
  }
  const output = plan?.output?.path;
  if (typeof output !== "string" || !path.isAbsolute(output)) {
    errors.push("output.path 必须是绝对路径");
  }
  if (target && output && path.resolve(target) === path.resolve(output)) {
    errors.push("output.path 不能覆盖 inputs.target");
  }
  if (profile) {
    const allowedOptions = new Set(Object.keys(profile.options));
    for (const key of Object.keys(plan.options ?? {})) {
      if (!allowedOptions.has(key)) {
        errors.push(`options 不允许覆盖未登记字段：${key}`);
      }
    }
    const modelOverride = plan.options?.[profile.modelOption];
    if (modelOverride && modelOverride !== profile.model) {
      errors.push(
        `禁止在稳定 profile 中静默换模型：${profile.modelOption}=${modelOverride}`,
      );
    }
    if (forExecution) {
      for (const field of profile.authorizationFields) {
        if (plan?.authorization?.[field] !== true) {
          errors.push(`执行前 authorization.${field} 必须为 true`);
        }
      }
      if (
        plan?.authorization?.publicRelease === true
        && plan?.authorization?.disclosureDecisionRecorded !== true
      ) {
        errors.push("公开发布前必须记录 disclosureDecisionRecorded");
      }
      if (
        typeof plan?.authorization?.evidence !== "string"
        || plan.authorization.evidence.trim().length < 4
      ) {
        errors.push("执行前 authorization.evidence 必须记录授权依据");
      }
    }
  }
  return { errors, profile };
}

function probeSafe(file) {
  try {
    return {
      ...mediaSummary(file),
      decoded: true,
    };
  } catch (error) {
    return {
      path: file,
      sizeBytes: fs.statSync(file).size,
      kind: path.extname(file).toLowerCase(),
      decoded: false,
      probeError: error.message,
    };
  }
}

let loaded;
try {
  loaded = loadKachaConfig({
    args,
    anchorPath: option("--plan", process.cwd()),
    includeSecrets: false,
  });
} catch (error) {
  fail(`配置无效：${error.message}`, 2);
}
const endpoint = loaded.config.tools.faceFusionEndpoint;

if (action === "profiles") {
  console.log(JSON.stringify(profileBundle(), null, 2));
  process.exit(0);
}
if (action === "template") {
  const operation = option("--operation");
  const output = option("--output");
  if (!operation || !output) {
    usage();
    process.exit(2);
  }
  if (fs.existsSync(path.resolve(output))) {
    fail(`拒绝覆盖已有计划：${path.resolve(output)}`);
  }
  try {
    writeJsonAtomic(path.resolve(output), planTemplate(operation));
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      output: path.resolve(output),
      operation,
    }, null, 2));
  } catch (error) {
    fail(error.message, 2);
  }
  process.exit(0);
}
if (action === "probe") {
  try {
    const health = await fetchJson(endpoint, "/health", null, {
      timeoutMs: 10_000,
    });
    assertServiceCompatibility(health);
    const token = tokenFrom(loaded.config.tools.faceFusionTokenFile);
    const capabilities = await fetchJson(
      endpoint,
      "/v1/capabilities",
      token,
      { timeoutMs: 15_000 },
    );
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      endpoint,
      health,
      serviceMinimumVersion: profileBundle().serviceMinimumVersion,
      capabilities,
      token: "[REDACTED]",
      profileCompatibility: profileBundle().profiles.map(
        (profile) => profileCompatibility(profile, capabilities),
      ),
    }, null, 2));
  } catch (error) {
    fail(error.message);
  }
  process.exit(0);
}

const planFile = option("--plan");
if (!["validate", "run"].includes(action) || !planFile) {
  usage();
  process.exit(2);
}
let plan;
try {
  plan = readJson(path.resolve(planFile));
} catch (error) {
  fail(`无法读取计划：${error.message}`, 2);
}
const validation = validatePlan(plan, {
  forExecution: action === "run" || args.includes("--for-execution"),
});
if (validation.errors.length > 0) fail(validation.errors.join("\n"));
const frozenInputs = {
  target: {
    path: plan.inputs.target,
    sha256: sha256File(plan.inputs.target),
    media: probeSafe(plan.inputs.target),
  },
  sources: plan.inputs.sources.map((source) => ({
    path: source,
    sha256: sha256File(source),
    media: probeSafe(source),
  })),
};
if (action === "run") {
  const undecodable = [
    frozenInputs.target,
    ...frozenInputs.sources,
  ].filter((input) => input.media.decoded !== true);
  if (undecodable.length > 0) {
    fail(
      `FaceFusion 输入无法由 ffprobe 解码：${
        undecodable.map((input) => input.path).join(", ")
      }`,
    );
  }
}
const validationReport = {
  schemaVersion: "1.0",
  status: "pass",
  plan: path.resolve(planFile),
  operation: plan.operation,
  profile: {
    id: validation.profile.id,
    processor: validation.profile.processor,
    model: validation.profile.model,
    modelLicense: validation.profile.modelLicense,
    releasePolicy: validation.profile.releasePolicy,
  },
  frozenInputs,
  manualQc: validation.profile.manualQc,
  authorizationBoundary:
    "计划授权仅适用于冻结哈希对应的输入与本次候选输出，不构成发布批准。",
};
if (action === "validate") {
  console.log(JSON.stringify(validationReport, null, 2));
  process.exit(0);
}

const output = path.resolve(plan.output.path);
if (fs.existsSync(output)) fail(`拒绝覆盖已有输出：${output}`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const projectRoot = path.resolve(
  option("--project-root", path.dirname(path.resolve(planFile))),
);
const timeoutSeconds = Number(option("--timeout", 7200));
if (
  !Number.isFinite(timeoutSeconds)
  || timeoutSeconds < 30
  || timeoutSeconds > 86_400
) {
  fail("--timeout 必须为 30 至 86400 秒", 2);
}

let lease = null;
let temporary = null;
try {
  const token = tokenFrom(loaded.config.tools.faceFusionTokenFile);
  const health = await fetchJson(endpoint, "/health", null, {
    timeoutMs: 10_000,
  });
  assertServiceCompatibility(health);
  const capabilities = await fetchJson(
    endpoint,
    "/v1/capabilities",
    token,
    { timeoutMs: 15_000 },
  );
  if (!capabilities.processors?.includes(validation.profile.processor)) {
    throw new Error(`服务不支持 processor：${validation.profile.processor}`);
  }
  const compatibility = profileCompatibility(validation.profile, capabilities);
  if (!compatibility.optionSetAvailable) {
    throw new Error(`服务不支持 profile 的一个或多个 options：${validation.profile.id}`);
  }
  if (!compatibility.executionProvidersAvailable) {
    throw new Error(`服务缺少 profile 需要的 execution provider：${validation.profile.id}`);
  }
  const fingerprint = sha256Value({
    operation: plan.operation,
    profile: validation.profile,
    options: plan.options,
    inputs: frozenInputs,
    serviceVersion: health.facefusion_version,
    processors: capabilities.processors,
  });
  const cacheRoot = path.join(
    projectRoot,
    ".kacha",
    "cache",
    "facefusion",
    fingerprint,
  );
  const cacheResult = path.join(cacheRoot, `result${path.extname(output)}`);
  const cacheManifest = path.join(cacheRoot, "manifest.json");
  if (fs.existsSync(cacheResult) && fs.existsSync(cacheManifest)) {
    const cached = readJson(cacheManifest);
    if (
      cached.fingerprint === fingerprint
      && cached.outputSha256 === sha256File(cacheResult)
    ) {
      fs.copyFileSync(cacheResult, output, fs.constants.COPYFILE_EXCL);
      const cacheReport = {
        ...cached,
        status: "candidate_requires_manual_qc",
        cache: "hit",
        output,
        outputSha256: sha256File(output),
        releaseApproved: false,
      };
      writeJsonAtomic(`${output}.facefusion.json`, cacheReport);
      console.log(JSON.stringify(cacheReport, null, 2));
      process.exit(0);
    }
  }
  lease = acquireResourceLeases({
    config: loaded.config,
    projectRoot,
    resources: ["mps", "videoEncode", "ioHeavy"],
    purpose: `facefusion-${plan.operation}`,
  });
  const sourceReferences = [];
  for (const source of plan.inputs.sources) {
    sourceReferences.push(
      await uploadAsset(endpoint, token, source, timeoutSeconds * 1000),
    );
  }
  const targetReference = await uploadAsset(
    endpoint,
    token,
    plan.inputs.target,
    timeoutSeconds * 1000,
  );
  const submit = await fetchJson(endpoint, "/v1/jobs", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_paths: sourceReferences,
      target_path: targetReference,
      processors: [validation.profile.processor],
      output_filename: path.basename(output),
      options: {
        ...validation.profile.options,
        ...(plan.options ?? {}),
      },
    }),
    timeoutMs: 30_000,
  });
  const jobId = submit.id ?? submit.job_id;
  if (!jobId) throw new Error("FaceFusion 未返回 job id");
  const deadline = Date.now() + timeoutSeconds * 1000;
  let job;
  do {
    job = await fetchJson(endpoint, `/v1/jobs/${jobId}`, token, {
      timeoutMs: 30_000,
    });
    if (["succeeded", "failed", "cancelled"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  if (!job || job.status !== "succeeded") {
    throw new Error(
      job?.status
        ? `FaceFusion job ${job.status}: ${JSON.stringify(job.error ?? {})}`
        : "FaceFusion job 超时",
    );
  }
  const response = await fetch(
    `${endpoint.replace(/\/$/, "")}/v1/jobs/${jobId}/result`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    },
  );
  if (!response.ok) throw new Error(`FaceFusion result HTTP ${response.status}`);
  temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.tmp-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()), {
    flag: "wx",
  });
  const outputMedia = probeSafe(temporary);
  if (outputMedia.decoded !== true) {
    throw new Error(
      `FaceFusion 输出无法由 ffprobe 解码：${outputMedia.probeError}`,
    );
  }
  const targetMedia = frozenInputs.target.media;
  const automaticQc = {
    outputDecodes: outputMedia.decoded === true,
    sourceGeometryPreserved: plan.output.preserveSourceGeometry !== true
      || (
        !targetMedia.width
        || !outputMedia.width
        || (
          targetMedia.width === outputMedia.width
          && targetMedia.height === outputMedia.height
        )
      ),
    sourceFrameRatePreserved: plan.output.preserveSourceFrameRate !== true
      || (
        !targetMedia.averageFps
        || !outputMedia.averageFps
        || Math.abs(targetMedia.averageFps - outputMedia.averageFps) <= 0.001
      ),
    sourceAudioPreserved: plan.output.preserveAudio !== true
      || !targetMedia.audio
      || Boolean(outputMedia.audio),
    durationDeltaSeconds: Number.isFinite(targetMedia.duration)
      && Number.isFinite(outputMedia.duration)
      ? Number((outputMedia.duration - targetMedia.duration).toFixed(6))
      : null,
  };
  if (
    automaticQc.sourceGeometryPreserved !== true
    || automaticQc.sourceFrameRatePreserved !== true
    || automaticQc.sourceAudioPreserved !== true
    || (
      automaticQc.durationDeltaSeconds !== null
      && Math.abs(automaticQc.durationDeltaSeconds) > 0.1
    )
  ) {
    throw new Error(
      `FaceFusion 自动媒体 QC 失败：${JSON.stringify(automaticQc)}`,
    );
  }
  fs.renameSync(temporary, output);
  temporary = null;
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.copyFileSync(output, cacheResult);
  const report = {
    schemaVersion: "1.0",
    status: "candidate_requires_manual_qc",
    operation: plan.operation,
    profile: validationReport.profile,
    fingerprint,
    service: {
      endpoint,
      facefusionVersion: health.facefusion_version,
      processor: validation.profile.processor,
      model: validation.profile.model,
    },
    jobId,
    frozenInputs,
    output,
    outputSha256: sha256File(output),
    outputMedia,
    automaticQc,
    manualQcRequired: validation.profile.manualQc,
    releaseApproved: false,
    token: "[REDACTED]",
  };
  writeJsonAtomic(`${output}.facefusion.json`, report);
  writeJsonAtomic(cacheManifest, report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(error.message);
} finally {
  if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  lease?.release();
}
