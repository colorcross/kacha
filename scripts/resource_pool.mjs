import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const RESOURCE_NAMES = new Set([
  "cpuHeavy",
  "mps",
  "videoEncode",
  "network",
  "ioHeavy",
]);

export function resolveResourceDirectory({ config, projectRoot }) {
  const scheduling = config.execution.resourceScheduling;
  if (scheduling.scope === "project") {
    return path.resolve(projectRoot, scheduling.directory);
  }
  const hostRoot = process.env.KACHA_RUNTIME_HOME
    || process.env.XDG_RUNTIME_DIR
    || process.env.XDG_CACHE_HOME
    || path.join(os.homedir(), ".cache");
  return path.resolve(hostRoot, scheduling.directory);
}

function pause(milliseconds) {
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

function safeUnlinkOwned(file, lease) {
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      current.pid === process.pid
      && current.host === os.hostname()
      && current.nonce === lease.nonce
    ) {
      fs.unlinkSync(file);
    }
  } catch {
    // Missing or replaced locks must not be deleted blindly.
  }
}

function reclaimDeadLocalOwner(file) {
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    if (current.host === os.hostname() && !processAlive(current.pid)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function tryAcquireSlot(directory, resource, capacity, purpose) {
  for (let slot = 0; slot < capacity; slot += 1) {
    const file = path.join(directory, `${resource}.${slot}.lock`);
    const lease = {
      schemaVersion: "1.0",
      resource,
      slot,
      pid: process.pid,
      host: os.hostname(),
      nonce: crypto.randomBytes(12).toString("hex"),
      purpose,
      acquiredAt: new Date().toISOString(),
    };
    const attempt = () => {
      const descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(lease)}\n`);
      fs.closeSync(descriptor);
      return { ...lease, file };
    };
    try {
      return attempt();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (reclaimDeadLocalOwner(file)) {
        try {
          return attempt();
        } catch (retryError) {
          if (retryError.code !== "EEXIST") throw retryError;
        }
      }
    }
  }
  return null;
}

export function acquireResourceLeases({
  config,
  projectRoot,
  resources,
  purpose = "kacha-operation",
}) {
  const scheduling = config.execution.resourceScheduling;
  if (!scheduling.enabled || resources.length === 0) {
    return {
      leases: [],
      waitedSeconds: 0,
      release() {},
    };
  }
  const requested = [...new Set(resources)].sort();
  for (const resource of requested) {
    if (!RESOURCE_NAMES.has(resource)) {
      throw new Error(`未知资源池：${resource}`);
    }
  }
  const directory = resolveResourceDirectory({ config, projectRoot });
  fs.mkdirSync(directory, { recursive: true });
  const start = process.hrtime.bigint();
  const deadline = Date.now() + scheduling.waitTimeoutSeconds * 1000;
  const leases = [];
  try {
    for (const resource of requested) {
      let lease = null;
      while (!lease) {
        lease = tryAcquireSlot(
          directory,
          resource,
          scheduling.capacities[resource],
          purpose,
        );
        if (lease) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `等待资源 ${resource} 超时（${scheduling.waitTimeoutSeconds}s）`,
          );
        }
        pause(scheduling.pollIntervalMs);
      }
      leases.push(lease);
    }
  } catch (error) {
    for (const lease of [...leases].reverse()) safeUnlinkOwned(lease.file, lease);
    throw error;
  }
  let released = false;
  return {
    leases,
    waitedSeconds: Number((Number(process.hrtime.bigint() - start) / 1e9).toFixed(6)),
    release() {
      if (released) return;
      released = true;
      for (const lease of [...leases].reverse()) safeUnlinkOwned(lease.file, lease);
    },
  };
}

export function inspectResourceLeases({ config, projectRoot }) {
  const scheduling = config.execution.resourceScheduling;
  const directory = resolveResourceDirectory({ config, projectRoot });
  const resources = {};
  for (const resource of RESOURCE_NAMES) {
    const capacity = scheduling.capacities[resource];
    const active = [];
    for (let slot = 0; slot < capacity; slot += 1) {
      const file = path.join(directory, `${resource}.${slot}.lock`);
      if (!fs.existsSync(file)) continue;
      try {
        active.push({ file, ...JSON.parse(fs.readFileSync(file, "utf8")) });
      } catch {
        active.push({ file, status: "unreadable" });
      }
    }
    resources[resource] = {
      capacity,
      active: active.length,
      available: Math.max(0, capacity - active.length),
      leases: active,
    };
  }
  return { directory, resources };
}
