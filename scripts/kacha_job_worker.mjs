#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  now,
  resolveContainedPath,
  withOperationLock,
  writeJson,
} from "./agent_workspace_utils.mjs";
import { validateJobContract } from "./job_contract.mjs";
import {
  acquireFileLock,
  fileIdentity,
  readJson,
  sha256Value,
} from "./kacha_utils.mjs";

import { targetAlive } from "./job_runtime.mjs";

const jobFile = path.resolve(process.argv[2] ?? "");
if (!jobFile || !fs.existsSync(jobFile)) process.exit(2);

const outputLocks = [];
const stateLockFile = `${jobFile}.state.lock`;
const runLockFile = `${jobFile}.run.lock`;
let releaseRunLock = null;
try {
  releaseRunLock = acquireFileLock(runLockFile, {
    purpose: "kacha-background-job",
    staleAfterMs: 24 * 60 * 60 * 1000,
  });
} catch {
  process.exit(3);
}

let job = readJson(jobFile);

const contractErrors = validateJobContract(jobFile, job);
if (contractErrors.length > 0) {
  writeJson(jobFile, {
    ...job,
    status: "failed",
    finishedAt: now(),
    updatedAt: now(),
    workerPid: null,
    childPid: null,
    activeRunId: null,
    error: `任务合同完整性检查失败：${contractErrors.join("; ")}`,
  });
  try { releaseRunLock?.(); } catch {}
  releaseRunLock = null;
  process.stderr.write(`${contractErrors.join("\n")}\n`);
  process.exit(4);
}
const stdoutFile = path.join(path.dirname(jobFile), "stdout.log");
const stderrFile = path.join(path.dirname(jobFile), "stderr.log");
const placeholderFile = job.placeholder.path;
const runtimePidFile = job.runtimePidFile;
const runId = `${job.id}-a${Number(job.attempt ?? 0) + 1}-${Date.now().toString(36)}-${process.pid}`;
let finished = false;
let terminationTimer = null;

function placeholder(currentJob, state, extra = {}) {
  const current = fs.existsSync(placeholderFile)
    ? readJson(placeholderFile)
    : {
        schemaVersion: "1.0",
        id: currentJob.id,
        ref: currentJob.ref,
        kind: currentJob.kind,
      };
  writeJson(placeholderFile, {
    ...current,
    state,
    updatedAt: now(),
    ...extra,
  });
}

function mutateState(purpose, updater) {
  return withOperationLock(stateLockFile, purpose, () => {
    const current = readJson(jobFile);
    const errors = validateJobContract(jobFile, current);
    if (errors.length > 0) {
      throw new Error(`任务合同在状态变更前失效：${errors.join("; ")}`);
    }
    const next = updater(current);
    if (next) writeJson(jobFile, next);
    return next ?? current;
  });
}

function clearRuntimePid() {
  try {
    if (
      runtimePidFile
      && fs.existsSync(runtimePidFile)
      && (() => {
        const raw = fs.readFileSync(runtimePidFile, "utf8").trim();
        if (!raw.startsWith("{")) return Number(raw) === process.pid;
        const value = JSON.parse(raw);
        return value.pid === process.pid && value.runId === runId;
      })()
    ) {
      fs.unlinkSync(runtimePidFile);
    }
  } catch {}
}

function releaseWorker() {
  clearRuntimePid();
  if (terminationTimer) clearTimeout(terminationTimer);
  for (const release of outputLocks.splice(0).reverse()) { try { release(); } catch {} }
  try { releaseRunLock?.(); } catch {}
  releaseRunLock = null;
}

fs.mkdirSync(path.dirname(runtimePidFile), { recursive: true });
fs.writeFileSync(runtimePidFile, `${JSON.stringify({
  pid: process.pid,
  runId,
  createdAt: now(),
})}\n`, { mode: 0o600 });
job = mutateState("job-worker-start", (current) => {
  if (current.status !== "queued") return current;
  const next = {
    ...current,
    status: "running",
    workerPid: process.pid,
    childPid: null,
    activeRunId: runId,
    startedAt: now(),
    finishedAt: null,
    updatedAt: now(),
    attempt: Number(current.attempt ?? 0) + 1,
  };
  placeholder(next, "running", {
    workerPid: process.pid,
    childPid: null,
    activeRunId: runId,
    outputs: [],
    error: null,
  });
  return next;
});
if (job.status !== "running" || job.activeRunId !== runId) {
  releaseWorker();
  process.exit(0);
}

try {
  const lockDirectory = resolveContainedPath(job.projectRoot, ".kacha/jobs/.output-locks");
  fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  for (const expected of [...new Set(job.expectedOutputs)].sort()) {
    const safeOutput = resolveContainedPath(job.projectRoot, expected);
    outputLocks.push(acquireFileLock(path.join(lockDirectory, `${sha256Value(safeOutput)}.lock`), {
      purpose: `job-output:${job.id}`,
    }));
    if (fs.lstatSync(safeOutput, { throwIfNoEntry: false })) {
      throw new Error(`预期产物已存在，拒绝覆盖或认领：${safeOutput}`);
    }
  }
} catch (error) {
  mutateState("job-output-conflict", (current) => {
    const next = { ...current, outputsOwned: false, status: "failed", error: error.message, finishedAt: now(), updatedAt: now(), workerPid: null, childPid: null, activeRunId: null };
    placeholder(next, "failed", { error: error.message, outputs: [], workerPid: null, childPid: null, activeRunId: null });
    return next;
  });
  releaseWorker();
  process.exit(0); // CLI reads the persisted terminal result and propagates failure.
}

job = mutateState("job-output-claimed", (current) => ({ ...current, outputsOwned: true }));

const stdout = fs.openSync(stdoutFile, "a", 0o600);
const stderr = fs.openSync(stderrFile, "a", 0o600);
const child = spawn(job.command.argv[0], job.command.argv.slice(1), {
  cwd: job.command.cwd,
  env: { ...process.env, KACHA_JOB_ID: job.id, KACHA_JOB_RUN_ID: runId },
  stdio: ["ignore", stdout, stderr],
  shell: false,
  detached: process.platform !== "win32",
});
job = mutateState("job-worker-child", (current) => {
  if (current.activeRunId !== runId || current.status !== "running") return current;
  const next = {
    ...current,
    childPid: child.pid ?? null,
    childProcessGroupId: process.platform !== "win32" ? child.pid ?? null : null,
    updatedAt: now(),
  };
  placeholder(next, "running", {
    workerPid: process.pid,
    childPid: child.pid ?? null,
    childProcessGroupId: process.platform !== "win32" ? child.pid ?? null : null,
    activeRunId: runId,
  });
  return next;
});

function quarantineCancelledOutputs(current) {
  if (current.outputsOwned === false) return [];
  const existing = (current.expectedOutputs ?? []).filter(
    (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
  );
  if (existing.length === 0) return [];
  const directory = path.join(
    path.dirname(jobFile),
    "partial",
    `cancelled-${runId}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  return existing.map((file, index) => {
    let safeFile = file;
    try {
      safeFile = resolveContainedPath(current.projectRoot, file, {
        allowMissing: false,
      });
    } catch {
      return null;
    }
    const destination = path.join(directory, `${index + 1}-${path.basename(safeFile)}`);
    fs.renameSync(safeFile, destination);
    return destination;
  }).filter(Boolean);
}

function closeLogs() {
  try { fs.closeSync(stdout); } catch {}
  try { fs.closeSync(stderr); } catch {}
}

function finish(requestedStatus, extra = {}) {
  if (finished) return;
  finished = true;
  closeLogs();
  mutateState("job-worker-finish", (current) => {
    if (current.activeRunId !== runId) return current;
    if (["cancelled", "cancellation_failed"].includes(current.status)) {
      return current;
    }
    if (current.status === "cancelling" && requestedStatus !== "cancellation_failed") {
      const quarantinedOutputs = quarantineCancelledOutputs(current);
      const next = {
        ...current,
        status: "cancelled",
        finishedAt: now(),
        updatedAt: now(),
        workerPid: null,
        childPid: null,
        childProcessGroupId: null,
        activeRunId: null,
        outputs: [],
        error: null,
        quarantinedOutputs: [
          ...(current.quarantinedOutputs ?? []),
          ...quarantinedOutputs,
        ],
      };
      placeholder(next, "cancelled", {
        workerPid: null,
        childPid: null,
        childProcessGroupId: null,
        activeRunId: null,
        outputs: [],
        error: null,
      });
      return next;
    }
    if (!["running", "cancelling"].includes(current.status)) return current;
    const next = {
      ...current,
      status: requestedStatus,
      finishedAt: now(),
      updatedAt: now(),
      workerPid: null,
      childPid: null,
      childProcessGroupId: null,
      activeRunId: null,
      ...extra,
    };
    placeholder(next, requestedStatus === "succeeded" ? "ready" : requestedStatus, {
      ...extra,
      workerPid: null,
      childPid: null,
      childProcessGroupId: null,
      activeRunId: null,
    });
    return next;
  });
  releaseWorker();
}

child.on("error", (error) => {
  finish("failed", {
    exitCode: null,
    error: error.message,
  });
});

child.on("close", (code, signal) => {
  if (finished) return;
  const current = readJson(jobFile);
  if (current.activeRunId !== runId) {
    closeLogs();
    releaseWorker();
    finished = true;
    return;
  }
  const group = current.childProcessGroupId;
  if (group && targetAlive(-group)) {
    try { process.kill(-group, "SIGKILL"); } catch {}
    finish("cancellation_failed", { exitCode: code, signal, error: "主进程退出后仍有子进程存活；已请求终止，确认退出后才可恢复", childProcessGroupId: group });
    return;
  }
  if (current.status === "cancelling") {
    finish("cancelled", {
      exitCode: code,
      signal: signal ?? null,
    });
    return;
  }
  if (code !== 0 || signal) {
    finish("failed", {
      exitCode: code,
      signal: signal ?? null,
      error: `后台命令退出：${code ?? signal}`,
    });
    return;
  }
  const missing = [];
  const outputs = [];
  const boundaryErrors = [];
  for (const expected of current.expectedOutputs ?? []) {
    let safeExpected = null;
    try {
      safeExpected = resolveContainedPath(current.projectRoot, expected, {
        allowMissing: false,
      });
    } catch (error) {
      boundaryErrors.push(error.message);
      continue;
    }
    if (!fs.existsSync(safeExpected) || !fs.statSync(safeExpected).isFile()) {
      missing.push(expected);
    } else {
      outputs.push(fileIdentity(safeExpected));
    }
  }
  if (boundaryErrors.length > 0) {
    finish("failed", {
      exitCode: code,
      error: `产物越出项目边界：${boundaryErrors.join("; ")}`,
      boundaryErrors,
    });
    return;
  }
  if (missing.length > 0) {
    finish("failed", {
      exitCode: code,
      error: `预期产物缺失：${missing.join(", ")}`,
      missingOutputs: missing,
    });
    return;
  }
  if (outputs.length === 0 && current.allowNoOutput !== true) {
    finish("failed", {
      exitCode: code,
      error: "任务没有可验证产物",
    });
    return;
  }
  finish("succeeded", {
    exitCode: code,
    outputs,
  });
});

function requestTermination() {
  try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch {}
  terminationTimer = setTimeout(() => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
  }, 700);
}

process.on("SIGTERM", requestTermination);
process.on("SIGINT", requestTermination);
