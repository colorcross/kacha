#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureDirectory,
  fail,
  normalizeObjectRef,
  now,
  option,
  repeated,
  resolveContainedPath,
  safeId,
  shortDigest,
  withOperationLock,
  writeJson,
} from "./agent_workspace_utils.mjs";
import {
  readJson,
  resolveRuntimeCommand,
  sha256Value,
} from "./kacha_utils.mjs";
import { jobProcessTargets, jobRecovery, targetAlive } from "./job_runtime.mjs";
import { jobSubmissionDigest, validateJobContract } from "./job_contract.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rawArgs = process.argv.slice(2);
const separator = rawArgs.indexOf("--");
const args = separator < 0 ? rawArgs : rawArgs.slice(0, separator);
const commandArgs = separator < 0 ? [] : rawArgs.slice(separator + 1);
const action = args[0];

function usage() {
  fail(
    "KACHA-E140",
    "用法：kacha.mjs jobs submit --project-root DIR --kind KIND "
      + "--expected-output FILE [--expected-output FILE ...] -- COMMAND [ARG ...]\n"
      + "  无产物任务必须显式使用 --allow-no-output\n"
      + "  kacha.mjs jobs status|list|cancel|resume [@job:ID] --project-root DIR",
    2,
  );
}

function queueRoot() {
  const requested = ensureDirectory(option(args, "--project-root", process.cwd()), {
    create: action === "submit",
  });
  const project = fs.realpathSync(requested);
  const root = resolveContainedPath(project, path.join(project, ".kacha", "jobs"));
  resolveContainedPath(project, path.join(project, ".kacha", "placeholders"));
  if (action === "submit") fs.mkdirSync(root, { recursive: true });
  return { project, root };
}

function jobPath(root, id) {
  return path.join(root, id, "job.json");
}

function resolveId(value) {
  const ref = normalizeObjectRef(value);
  if (ref && ref.type !== "job") fail("KACHA-E140", `不是 job 引用：${value}`, 2);
  return safeId(ref?.id ?? value, "job");
}

function loadJob(root, input) {
  const id = resolveId(input);
  if ([".", ".."].includes(id)) fail("KACHA-E140", "任务 ID 无效", 2);
  const file = jobPath(root, id);
  if (!fs.existsSync(file)) fail("KACHA-E100", `任务不存在：@job:${id}`, 2);
  const value = readJson(file);
  const errors = validateJobContract(file, value);
  if (errors.length > 0) fail("KACHA-E120", `任务合同完整性检查失败：${errors.join("; ")}`);
  return { file, value };
}

function compact(job) {
  return {
    ref: job.ref,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    attempt: job.attempt ?? 0,
    activeRunId: job.activeRunId ?? null,
    placeholder: job.placeholder?.path ?? null,
    outputs: job.outputs ?? [],
    error: job.error ?? null,
    logs: job.logs,
    recovery: jobRecovery(job),
  };
}

function stateLock(file) {
  return `${file}.state.lock`;
}

function updateState(file, purpose, updater) {
  return withOperationLock(stateLock(file), purpose, () => {
    const current = readJson(file);
    const errors = validateJobContract(file, current);
    if (errors.length) throw new Error(`任务合同在状态变更前失效：${errors.join("; ")}`);
    const next = updater(current);
    if (next) writeJson(file, next);
    return next ?? current;
  });
}

function sensitiveArgument(argv) {
  const secretFlag = /^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|credential)$/i;
  const secretAssignment = /(?:^|[?&;\s])(?:--?)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|credential)\s*[:=]\s*\S+/i;
  const authorizationValue = /^(?:authorization\s*:|bearer\s+|basic\s+)/i;
  const knownToken = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{16,})\b/;
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index]);
    const previous = String(argv[index - 1] ?? "");
    if (
      secretFlag.test(value)
      || secretAssignment.test(value)
      || authorizationValue.test(value.trim())
      || knownToken.test(value)
      || (["-H", "--header"].includes(previous) && authorizationValue.test(value.trim()))
      || (["-u", "--user"].includes(previous) && value.includes(":"))
      || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value)
    ) {
      return true;
    }
  }
  return false;
}

const processPids = jobProcessTargets;

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = pids.filter(targetAlive);
    if (remaining.length === 0) return [];
    sleepSync(25);
  }
  return pids.filter(targetAlive);
}

function setPlaceholder(job, state, extra = {}) {
  const current = fs.existsSync(job.placeholder.path)
    ? readJson(job.placeholder.path)
    : {
        schemaVersion: "1.0",
        id: job.id,
        ref: job.ref,
        kind: job.kind,
      };
  writeJson(job.placeholder.path, {
    ...current,
    state,
    updatedAt: now(),
    ...extra,
  });
}

function reconcileJob(file, value) {
  if (!["queued", "running", "cancelling"].includes(value.status)) return value;
  const hasProcess = processPids(value).some(targetAlive);
  const ageMs = Date.now() - Date.parse(value.updatedAt ?? value.createdAt ?? 0);
  if (hasProcess || (value.status === "queued" && ageMs < 2000)) return value;
  return updateState(file, "job-reconcile", (current) => {
    if (!["queued", "running", "cancelling"].includes(current.status)) return current;
    if (processPids(current).some(targetAlive)) return current;
    const status = current.status === "cancelling" ? "cancelled" : "interrupted";
    const next = {
      ...current,
      status,
      updatedAt: now(),
      finishedAt: now(),
      error: status === "interrupted"
        ? "后台进程已不存在；可显式 resume"
        : null,
      workerPid: null,
      childPid: null,
      childProcessGroupId: null,
      activeRunId: null,
    };
    setPlaceholder(next, status, {
      workerPid: null,
      childPid: null,
      childProcessGroupId: null,
      activeRunId: null,
    });
    return next;
  });
}

function quarantinePartialOutputs(job) {
  if (job.outputsOwned === false) return [];
  const existing = (job.expectedOutputs ?? []).filter(
    (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
  );
  if (existing.length === 0) return [];
  const directory = path.join(
    path.dirname(job.placeholder.path),
    "..",
    "jobs",
    job.id,
    "partial",
    `attempt-${Number(job.attempt ?? 0)}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  return existing.map((file, index) => {
    const safeFile = resolveContainedPath(job.projectRoot, file, { allowMissing: false });
    const destination = path.join(
      directory,
      `${index + 1}-${path.basename(safeFile)}`,
    );
    fs.renameSync(safeFile, destination);
    return destination;
  });
}

function startWorker(file, foreground = false) {
  if (foreground) {
    const result = spawnSync(
      process.execPath,
      [path.join(scriptDirectory, "kacha_job_worker.mjs"), file],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      fail("KACHA-E500", `后台任务 worker 失败：${result.status ?? result.signal}`);
    }
    return { pid: null };
  }
  const child = spawn(
    process.execPath,
    [path.join(scriptDirectory, "kacha_job_worker.mjs"), file],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return child;
}

if (!["submit", "status", "list", "cancel", "resume"].includes(action)) usage();
const { project, root } = queueRoot();

if (action === "submit") {
  const argv = commandArgs;
  const kind = safeId(option(args, "--kind"), "task");
  if (argv.length === 0 || !option(args, "--kind")) usage();
  if (sensitiveArgument(argv)) {
    fail("KACHA-E120", "后台任务参数不能持久化密钥；请通过受控环境或 secrets 文件传递");
  }
  const executable = resolveRuntimeCommand(argv[0]);
  const expectedOutputs = repeated(args, "--expected-output")
    .map((file) => {
      try {
        return resolveContainedPath(project, file);
      } catch (error) {
        fail("KACHA-E120", `预期产物边界无效：${error.message}`);
      }
      return null;
    });
  if (new Set(expectedOutputs).size !== expectedOutputs.length) fail("KACHA-E140", "预期产物路径不能重复", 2);
  for (const output of expectedOutputs) {
    if (fs.existsSync(output) || fs.lstatSync(output, { throwIfNoEntry: false })) {
      fail("KACHA-E120", `预期产物已存在，必须选择新输出：${output}`);
    }
  }
  if (expectedOutputs.length === 0 && !args.includes("--allow-no-output")) {
    fail(
      "KACHA-E140",
      "后台任务默认必须声明至少一个 --expected-output；无产物任务需显式 --allow-no-output",
      2,
    );
  }
  let cwd;
  try {
    cwd = resolveContainedPath(project, option(args, "--cwd", project), {
      allowMissing: false,
    });
  } catch (error) {
    fail("KACHA-E120", `后台任务 cwd 边界无效：${error.message}`);
  }
  if (!fs.statSync(cwd).isDirectory()) {
    fail("KACHA-E120", `后台任务 cwd 不是目录：${cwd}`);
  }
  const createdAt = now();
  const id = safeId(
    option(args, "--id", `${kind}-${Date.now().toString(36)}-${shortDigest(argv, 6)}`),
    "job",
  );
  if ([".", ".."].includes(id)) fail("KACHA-E140", "任务 ID 不能是 . 或 ..", 2);
  const directory = path.join(root, id);
  if (fs.existsSync(directory)) fail("KACHA-E140", `任务已存在：@job:${id}`, 2);
  fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, "job.json");
  const placeholder = path.join(project, ".kacha", "placeholders", `${id}.json`);
  const job = {
    schemaVersion: "1.0",
    id,
    ref: `@job:${id}`,
    kind,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    attempt: 0,
    outputsOwned: false,
    activeRunId: null,
    projectRoot: project,
    command: {
      argv: [executable, ...argv.slice(1)],
      argvDigest: sha256Value([executable, ...argv.slice(1)]),
      cwd,
      shell: false,
    },
    expectedOutputs,
    allowNoOutput: args.includes("--allow-no-output"),
    placeholder: {
      path: placeholder,
      replacementContract: "只有 state=ready 且 outputs 哈希已写入后才可替换正式对象",
    },
    logs: {
      stdout: path.join(directory, "stdout.log"),
      stderr: path.join(directory, "stderr.log"),
    },
    runtimePidFile: path.join(directory, "worker.pid"),
  };
  job.submissionDigest = jobSubmissionDigest(job);
  writeJson(file, job);
  writeJson(placeholder, {
    schemaVersion: "1.0",
    id,
    ref: job.ref,
    kind,
    state: "pending",
    createdAt,
    updatedAt: createdAt,
    expectedOutputs,
    replacementContract: job.placeholder.replacementContract,
  });
  const foreground = args.includes("--foreground");
  const child = startWorker(file, foreground);
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: foreground ? readJson(file).status : "submitted",
    ref: job.ref,
    placeholder: placeholder,
    workerPid: foreground ? null : child.pid,
    expectedOutputs,
    poll: `node scripts/kacha.mjs jobs status ${job.ref} --project-root ${JSON.stringify(project)}`,
  }, null, 2));
  process.exit(foreground && readJson(file).status !== "succeeded" ? 1 : 0);
}

if (action === "list") {
  const limit = Number(option(args, "--limit", 20));
  const offset = Number(option(args, "--offset", 0));
  const filter = option(args, "--status");
  const statuses = ["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "interrupted", "cancellation_failed"];
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0
    || (filter && !statuses.includes(filter))) fail("KACHA-E140", "limit 必须是 1–200，offset 必须是非负整数，status 必须是合法任务状态", 2);
  const warnings = [];
  const jobs = (fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [])
    .filter((entry) => entry.isDirectory() && fs.existsSync(jobPath(root, entry.name)))
    .flatMap((entry) => {
      const file = jobPath(root, entry.name);
      try {
        const value = readJson(file);
        const errors = validateJobContract(file, value);
        if (errors.length) throw new Error(errors.join("; "));
        return [reconcileJob(file, value)];
      } catch (error) {
        warnings.push({ id: entry.name, status: "invalid", summary: "任务记录损坏；修复合同后才可执行", detail: error.message });
        return [];
      }
    })
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || left.id.localeCompare(right.id));
  const filtered = filter ? jobs.filter((job) => job.status === filter) : jobs;
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: warnings.length ? "pass_with_warnings" : "pass",
    jobs: filtered.slice(offset, offset + limit).map(compact),
    counts: Object.fromEntries(statuses.map((status) => [status, jobs.filter((job) => job.status === status).length])),
    responseWindow: { total: filtered.length, offset, limit, hasMore: offset + limit < filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null },
    warnings: warnings.slice(0, limit),
    invalidJobs: warnings.length,
  }, null, 2));
  process.exit(0);
}

const input = args[1];
if (!input) usage();
const loaded = loadJob(root, input);
let job = reconcileJob(loaded.file, loaded.value);

if (action === "status") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    job: compact(job),
    processAlive: processPids(job).some(targetAlive),
  }, null, 2));
  process.exit(0);
}

if (action === "cancel") {
  if (!["queued", "running"].includes(job.status)) {
    fail("KACHA-E140", `任务当前不可取消：${job.status}`, 2);
  }
  job = updateState(loaded.file, "job-cancel-request", (current) => {
    if (!["queued", "running"].includes(current.status)) {
      throw new Error(`任务当前不可取消：${current.status}`);
    }
    const next = {
      ...current,
      status: "cancelling",
      cancellationRequestedAt: now(),
      updatedAt: now(),
    };
    setPlaceholder(next, "cancelling", {
      activeRunId: next.activeRunId ?? null,
    });
    return next;
  });
  const pids = processPids(job);
  for (const pid of pids) {
    if (targetAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }
  let remaining = waitForExit(pids, 1200);
  for (const pid of remaining) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  remaining = waitForExit(remaining, 800);
  job = updateState(loaded.file, "job-cancel-finalize", (current) => {
    if (remaining.length > 0) {
      const next = {
        ...current,
        status: "cancellation_failed",
        updatedAt: now(),
        error: `后台进程未退出：${remaining.join(", ")}`,
      };
      setPlaceholder(next, "cancellation_failed", {
        error: next.error,
      });
      return next;
    }
    if (current.status === "cancelled") return current;
    const quarantinedOutputs = quarantinePartialOutputs(current);
    const next = {
      ...current,
      status: "cancelled",
      finishedAt: now(),
      updatedAt: now(),
      workerPid: null,
      childPid: null,
      childProcessGroupId: null,
      activeRunId: null,
      error: null,
      outputs: [],
      quarantinedOutputs: [
        ...(current.quarantinedOutputs ?? []),
        ...quarantinedOutputs,
      ],
    };
    setPlaceholder(next, "cancelled", {
      workerPid: null,
      childPid: null,
      childProcessGroupId: null,
      activeRunId: null,
    });
    return next;
  });
  if (job.status !== "cancelled") {
    fail("KACHA-E500", job.error ?? "后台任务取消失败");
  }
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "cancelled", ref: job.ref }, null, 2));
  process.exit(0);
}

if (!["failed", "interrupted", "cancelled", "cancellation_failed"].includes(job.status)) {
  fail("KACHA-E140", `任务当前不可恢复：${job.status}`, 2);
}
job = updateState(loaded.file, "job-resume", (current) => {
  if (!["failed", "interrupted", "cancelled", "cancellation_failed"].includes(current.status)) {
    throw new Error(`任务当前不可恢复：${current.status}`);
  }
  if (processPids(current).some(targetAlive)) throw new Error("旧任务进程仍在运行，禁止恢复或隔离其产物");
  const quarantinedOutputs = quarantinePartialOutputs(current);
  const next = {
    ...current,
    status: "queued",
    updatedAt: now(),
    finishedAt: null,
    error: null,
    outputs: [],
    missingOutputs: [],
    quarantinedOutputs: [
      ...(current.quarantinedOutputs ?? []),
      ...quarantinedOutputs,
    ],
    workerPid: null,
    childPid: null,
    activeRunId: null,
  };
  setPlaceholder(next, "pending", {
    outputs: [],
    error: null,
    workerPid: null,
    childPid: null,
    activeRunId: null,
  });
  return next;
});
const foreground = args.includes("--foreground");
const child = startWorker(loaded.file, foreground);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: foreground ? readJson(loaded.file).status : "resubmitted",
  ref: job.ref,
  workerPid: foreground ? null : child.pid,
}, null, 2));

process.exitCode = foreground && readJson(loaded.file).status !== "succeeded" ? 1 : 0;
