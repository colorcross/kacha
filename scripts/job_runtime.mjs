import fs from "node:fs";

export function jobRuntimePid(job) {
  try {
    const raw = fs.readFileSync(job.runtimePidFile, "utf8").trim();
    const value = raw.startsWith("{") ? JSON.parse(raw) : { pid: Number(raw) };
    const matches = value.runId === job.activeRunId
      || (!job.activeRunId && job.status === "queued" && String(value.runId ?? "").startsWith(`${job.id}-a`))
      || (!value.runId && !job.activeRunId);
    return matches && Number.isInteger(value.pid) && value.pid > 1 ? value.pid : null;
  } catch { return null; }
}

export function jobProcessTargets(job) {
  const targets = [job.childPid, job.workerPid, jobRuntimePid(job)]
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  if (process.platform !== "win32" && Number.isInteger(job.childProcessGroupId)
    && job.childProcessGroupId > 1 && job.childProcessGroupId !== process.pid) {
    targets.unshift(-job.childProcessGroupId);
  }
  return [...new Set(targets)];
}

export function targetAlive(target) {
  if (!Number.isInteger(target) || Math.abs(target) <= 1) return false;
  try { process.kill(target, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function jobRecovery(job) {
  const active = jobProcessTargets(job).some(targetAlive);
  if (["failed", "interrupted", "cancelled", "cancellation_failed"].includes(job.status)) {
    return {
      action: active ? "wait_for_exit" : "inspect_then_resume",
      canResume: !active,
      summary: active ? "旧进程仍在运行，退出前不能重试" : "检查失败原因和日志后显式恢复；部分产物会先隔离",
      command: active ? null : ["jobs", "resume", job.ref, "--project-root", job.projectRoot],
    };
  }
  return { action: job.status === "succeeded" ? "use_verified_outputs" : "wait", canResume: false };
}

// Observation never repairs the persisted state or authorizes a retry.
export function observeJob(job) {
  const active = jobProcessTargets(job).some(targetAlive);
  const ageMs = Date.now() - Date.parse(job.updatedAt ?? job.createdAt);
  const orphaned = ["queued", "running", "cancelling"].includes(job.status) && !active
    && !(job.status === "queued" && ageMs < 2000);
  const status = orphaned ? (job.status === "cancelling" ? "cancelled" : "interrupted") : job.status;
  return { ...job, status, recordedStatus: job.status, processAlive: active, recovery: jobRecovery({ ...job, status }) };
}
