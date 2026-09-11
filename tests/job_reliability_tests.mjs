#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { jobRecovery, observeJob } from "../scripts/job_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kacha-job-reliability-")));
const cli = path.join(root, "scripts/kacha.mjs");
const checked = [];
function invoke(args) { return spawnSync(process.execPath, [cli, "jobs", ...args, "--project-root", project], { encoding: "utf8", timeout: 15_000 }); }
function submit(id, output, code, { foreground = true, childArgs = [] } = {}) {
  return spawnSync(process.execPath, [cli, "jobs", "submit", "--id", id, "--kind", "test", "--project-root", project,
    ...(output ? ["--expected-output", output] : ["--allow-no-output"]), ...(foreground ? ["--foreground"] : []),
    "--", process.execPath, "-e", code, "--", ...childArgs], { encoding: "utf8", timeout: 15_000 });
}
function json(result, status = 0) { assert.equal(result.status, status, result.stderr || result.stdout); return JSON.parse(result.stdout); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await sleep(40); } throw new Error("timed out"); }
let extraProcess;
try {
  const existing = path.join(project, "existing.txt"); fs.writeFileSync(existing, "baseline");
  assert.notEqual(submit("existing", existing, "").status, 0);
  assert.equal(fs.readFileSync(existing, "utf8"), "baseline");
  checked.push("existing-output-preserved");
  json(submit("failed", null, "process.exit(7)"), 1);
  const signalled = json(submit("signal", null, "process.kill(process.pid, 'SIGTERM')"), 1);
  assert.equal(signalled.status, "failed");
  checked.push("foreground-failure-exit");
  const optionJob = json(submit("options", null, "", { childArgs: ["--project-root", "/not-the-project", "--id", "other"] }));
  assert.equal(optionJob.ref, "@job:options");
  checked.push("child-arguments-isolated");
  for (const id of [".", ".."]) assert.notEqual(submit(id, null, "").status, 0);
  checked.push("special-id-rejected");
  const shared = path.join(project, "shared.txt");
  json(submit("first", shared, `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(shared)},'owner'),1000)`, { foreground: false }));
  const firstRecord = path.join(project, ".kacha/jobs/first/job.json");
  await until(() => fs.existsSync(firstRecord) && JSON.parse(fs.readFileSync(firstRecord)).childPid);
  const second = json(submit("second", shared, `require('node:fs').writeFileSync(${JSON.stringify(shared)},'wrong')`), 1);
  assert.equal(second.status, "failed");
  await until(() => fs.existsSync(shared));
  assert.equal(fs.readFileSync(shared, "utf8"), "owner");
  json(invoke(["resume", "@job:second", "--foreground"]), 1);
  assert.equal(fs.readFileSync(shared, "utf8"), "owner", "conflicting job must never quarantine another task's output");
  checked.push("concurrent-output-lock-and-ownership");
  const corrupt = path.join(project, ".kacha/jobs/corrupt"); fs.mkdirSync(corrupt); fs.writeFileSync(path.join(corrupt, "job.json"), "{");
  const listed = json(invoke(["list", "--limit", "2"]));
  assert.equal(listed.jobs.length, 2); assert.equal(listed.invalidJobs, 1); assert.equal(listed.responseWindow.hasMore, true);
  assert.equal(json(invoke(["list", "--status", "failed"])).jobs.every((job) => job.status === "failed"), true);
  assert.notEqual(invoke(["list", "--limit", "0"]).status, 0);
  checked.push("bounded-list-with-independent-corruption");
  extraProcess = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const failedRecord = path.join(project, ".kacha/jobs/failed/job.json");
  const failed = JSON.parse(fs.readFileSync(failedRecord));
  fs.writeFileSync(failedRecord, JSON.stringify({ ...failed, status: "cancellation_failed", childPid: extraProcess.pid }));
  assert.equal(jobRecovery({ ...failed, childPid: extraProcess.pid }).canResume, false);
  assert.notEqual(invoke(["resume", "@job:failed", "--foreground"]).status, 0);
  extraProcess.kill(); extraProcess = null;
  const orphaned = observeJob({ ...failed, status: "running", updatedAt: "2020-01-01T00:00:00Z", workerPid: null, childPid: null });
  assert.equal(orphaned.status, "interrupted"); assert.equal(orphaned.recordedStatus, "running");
  assert.equal(orphaned.recovery.canResume, true);
  checked.push("live-process-blocks-resume");
  checked.push("orphan-observation-does-not-trust-recorded-running");
  if (process.platform !== "win32") {
    const late = path.join(project, "grandchild.txt");
    const marker = path.join(project, "grandchild-ready.txt");
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'late'),1800)`;
    const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    json(submit("tree", late, code, { foreground: false }));
    await until(() => fs.existsSync(marker));
    const cancelled = json(invoke(["cancel", "@job:tree"]));
    assert.equal(cancelled.status, "cancelled");
    await sleep(1900); assert.equal(fs.existsSync(late), false);
    checked.push("grandchild-cancelled-before-late-write");
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-job-outside-"));
  try {
    const linked = path.join(project, "linked"); fs.mkdirSync(linked); fs.symlinkSync(outside, path.join(linked, ".kacha"));
    const result = spawnSync(process.execPath, [cli, "jobs", "list", "--project-root", linked], { encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  checked.push("internal-directory-boundary");
  console.log(JSON.stringify({ status: "pass", checks: checked }, null, 2));
} finally {
  extraProcess?.kill();
  // All submitted workers must finish before their isolated fixtures are removed.
  for (const id of ["first", "tree"]) { try { invoke(["cancel", `@job:${id}`]); } catch {} }
  fs.rmSync(project, { recursive: true, force: true });
}
