import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, sha256File } from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const registryFile = path.join(scriptDirectory, "..", "config", "editor", "preview-providers.json");
const REQUIRED_FINAL_CAPABILITIES = ["picture", "overlay", "caption", "audio", "transition", "effect", "export"];
const RUNTIME_PROBES = new Set([null, "ffmpeg-version"]);
const runtimeCache = new Map();

function runtimeStatus(provider) {
  if (!provider.runtimeProbe) return { required: false, status: "not_required" };
  if (runtimeCache.has(provider.runtimeProbe)) return runtimeCache.get(provider.runtimeProbe);
  let result;
  if (provider.runtimeProbe === "ffmpeg-version") {
    const probe = spawnSync("ffmpeg", ["-version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    result = {
      required: true,
      status: probe.status === 0 ? "available" : "unavailable",
      command: "ffmpeg -version",
      exitCode: probe.status,
      error: probe.error?.message ?? null,
    };
  }
  runtimeCache.set(provider.runtimeProbe, result);
  return result;
}

function loadRegistry() {
  const registry = readJson(registryFile);
  if (registry.schemaVersion !== "1.0" || !Array.isArray(registry.providers)) {
    throw new Error("preview provider registry 无效");
  }
  const ids = new Set();
  for (const [index, provider] of registry.providers.entries()) {
    if (!provider?.id || ids.has(provider.id)) throw new Error(`providers[${index}].id 缺失或重复`);
    ids.add(provider.id);
    if (!Array.isArray(provider.capabilities) || !Array.isArray(provider.limitations)) {
      throw new Error(`providers[${index}] capabilities/limitations 必须是数组`);
    }
    if (
      !["canonical", "approximate", "experimental"].includes(provider.kind)
      || !["available", "not_implemented", "unavailable"].includes(provider.status)
      || typeof provider.finalEligible !== "boolean"
      || typeof provider.deterministic !== "boolean"
      || !RUNTIME_PROBES.has(provider.runtimeProbe ?? null)
    ) throw new Error(`providers[${index}] kind/status/eligibility 合同无效`);
    if (provider.status !== "available" && provider.finalEligible === true) {
      throw new Error(`providers[${index}] 不可用却声明 finalEligible`);
    }
    if (
      provider.finalEligible === true
      && REQUIRED_FINAL_CAPABILITIES.some((capability) => !provider.capabilities.includes(capability))
    ) throw new Error(`providers[${index}] 缺少 final 必需能力`);
  }
  return registry;
}

export function listPreviewProviders() {
  const registry = loadRegistry();
  return {
    schemaVersion: "1.0",
    status: "pass",
    registry: { path: registryFile, sha256: sha256File(registryFile) },
    providers: registry.providers.map((provider) => ({
      ...provider,
      runtime: runtimeStatus(provider),
    })),
    invariant: "Only a registered provider with finalEligible=true may produce a final artifact.",
  };
}

export function assertPreviewProviderEligibility(providerId, { purpose = "preview" } = {}) {
  if (!["preview", "final"].includes(purpose)) throw new Error(`未知 preview purpose：${purpose}`);
  const provider = loadRegistry().providers.find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`未知 preview provider：${providerId}`);
  if (purpose === "final" && provider.finalEligible !== true) {
    throw new Error(`${providerId} 没有 current parity 证据，禁止用于 final`);
  }
  if (provider.status !== "available") throw new Error(`${providerId} 当前不可用：${provider.status}`);
  const runtime = runtimeStatus(provider);
  if (runtime.required && runtime.status !== "available") {
    throw new Error(`${providerId} 运行时不可用：${runtime.error ?? runtime.command}`);
  }
  return { ...provider, runtime, purpose, eligible: true };
}
