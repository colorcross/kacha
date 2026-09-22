import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireFileLock, directoryIdentity, readJson, run, sha256File, sha256Value, writeJsonAtomic } from "./kacha_utils.mjs";
import { resolveContainedPath } from "./agent_workspace_utils.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";
import { projectRuntimeRoot, callBoundRuntime } from "./runtime_bundle.mjs";
import { validateJobContract } from "./job_contract.mjs";
import { observeJob } from "./job_runtime.mjs";

import { implementationIdentity } from './implementation_identity.mjs';
const scripts = path.dirname(fileURLToPath(import.meta.url));
function invoke(script, args) {
  const result = run(process.execPath, [path.join(scripts, script), ...args]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function absolutePaths(value, owner) {
  if (Array.isArray(value)) return value.map(item => absolutePaths(item, owner));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ["path", "fontsDirectory"].includes(key) && typeof item === "string" ? path.resolve(path.dirname(owner), item) : absolutePaths(item, owner)]));
}
function dependencies(value, owner, found = []) {
  if (Array.isArray(value)) { value.forEach(item => dependencies(item, owner, found)); return found; }
  if (!value || typeof value !== "object") return found;
  for (const [key, item] of Object.entries(value)) {
    if (key === "output") continue;
    if ((["path", "fontsDirectory", "source", "subtitles", "dialogue", "bgm"].includes(key)) && typeof item === "string") {
      const file = path.resolve(path.dirname(owner), item);
      if (fs.existsSync(file)) found.push({ path: file, directory: fs.statSync(file).isDirectory(), sha256: fs.statSync(file).isDirectory() ? directoryIdentity(file).sha256 : sha256File(file) });
    } else dependencies(item, owner, found);
  }
  return found;
}
function previewDirectory(timeline) {
  const root = projectRuntimeRoot(timeline);
  return { root, directory: resolveContainedPath(root, path.join(root, ".kacha", "real-previews")) };
}
export function requestRealPreview(timeline, { start, end, expectedSha256 } = {}) {
  timeline = fs.realpathSync(timeline);
  const bound = callBoundRuntime(timeline, ["real-preview", "request", "--timeline", timeline, "--expected-sha", String(expectedSha256 ?? ""), "--start", String(start), "--end", String(end)]);
  if (bound) return bound;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 60) throw new Error("真实预览范围必须为 0–60 秒内的有效区间");
  const revision = sha256File(timeline);
  if (!expectedSha256 || expectedSha256 !== revision) throw new Error("时间线已改变，请刷新后生成预览");
  const { root, directory } = previewDirectory(timeline);
  fs.mkdirSync(directory, { recursive: true });
  const release = acquireFileLock(path.join(directory, "request.lock"), { purpose: "real-preview-submit" });
  try {
    const inputs = dependencies(readJson(timeline), timeline);
    const configurationDigest = loadKachaConfig({ anchorPath: timeline, includeSecrets: false }).digest;
    const implementation = implementationIdentity(scripts).sha256;
    const key = sha256Value({ timeline, revision, start, end, inputs, configurationDigest, implementation });
    const receipt = path.join(directory, `${key}.json`);
    const latest = path.join(directory, `${sha256Value(timeline)}.latest.json`);
    if (fs.existsSync(receipt)) {
      writeJsonAtomic(latest, { key, revision });
      return { ...realPreviewStatus(timeline, key), deduplicated: true };
    }
    const folder = resolveContainedPath(root, path.join(directory, key));
    const jobId = `preview-${key.slice(0, 24)}`;
    const jobFile = path.join(root, ".kacha", "jobs", jobId, "job.json");
    if (fs.existsSync(jobFile)) throw new Error(`预览已有任务但缺少回执，请通过 jobs status @job:${jobId} 恢复，禁止重复提交`);
    fs.mkdirSync(folder, {recursive:true});
    const snapshot = path.join(folder, "timeline.json");
    const output = path.join(folder, "preview.mp4");
    const graphFile = path.join(folder, "request-graph.json");
    if (fs.existsSync(output)) throw new Error("预览目录已有无回执产物，须先核查并隔离，不能覆盖");
    const plan = absolutePaths(readJson(timeline), timeline);
    // Legacy string media references need the same resolution as object refs.
    for (const [owner, name] of [[plan, "source"], [plan.visual, "subtitles"], [plan.audio, "dialogue"], [plan.audio, "bgm"]]) if (owner && typeof owner[name] === "string") owner[name] = { path: path.resolve(path.dirname(timeline), owner[name]) };
    plan.mode = "preview"; plan.output = { ...plan.output, path: path.join(folder, "candidate.mp4") };
    for (const name of ["dialogueStem", "bgmStem", "sfxStem", "mixStem"]) delete plan.output[name];
    writeJsonAtomic(snapshot, plan);
    const range = ["--output", output, "--range-start", String(start), "--range-end", String(end)];
    const compiled = invoke("timeline_ir.mjs", ["compile", "--plan", snapshot, "--graph", graphFile, ...range]);
    // Persist the reference before a worker can start. A crash after submission
    // must not lose the only link to an active job and invite a duplicate.
    writeJsonAtomic(receipt, { key, timeline, revision, start, end, inputs, configurationDigest, implementation, output, graphDigest: compiled.graphDigest, job: `@job:${jobId}`, jobFile });
    writeJsonAtomic(latest, { key, revision });
    try { invoke("kacha_jobs.mjs", ["submit", "--project-root", root, "--kind", "real-preview", "--id", jobId, "--expected-output", output, "--", process.execPath,
      path.join(scripts, "run_telemetry.mjs"), "run", "--project-root", root, "--stage", "real-preview", "--operation-id", key, "--mode", "preview", "--render-scope", "range", "--artifact", output, "--", process.execPath,
      path.join(scripts, "timeline_ir.mjs"), "render", "--plan", snapshot, "--expected-graph-digest", compiled.graphDigest, ...range]);
    } catch (error) {
      if (!fs.existsSync(jobFile)) fs.unlinkSync(receipt);
      throw error;
    }
    return { ...realPreviewStatus(timeline, key), deduplicated: false };
  } finally { release(); }
}
export function realPreviewStatus(timeline, key) {
  timeline = fs.realpathSync(timeline);
  const bound = callBoundRuntime(timeline, ["real-preview", "status", "--timeline", timeline, "--key", String(key ?? "")]);
  if (bound) return bound;
  if (!/^[a-f0-9]{64}$/.test(key ?? "")) throw new Error("预览 key 无效");
  const { directory } = previewDirectory(timeline);
  const receipt = readJson(path.join(directory, `${key}.json`));
  if (receipt.timeline !== timeline) throw new Error("预览不属于当前时间线");
  const latest = readJson(path.join(directory, `${sha256Value(timeline)}.latest.json`));
  if (!fs.existsSync(receipt.jobFile)) return {status:"submission_interrupted",key,revision:receipt.revision,current:false,ready:false,stale:true,output:null,job:receipt.job,error:"提交中断；先核查 jobs 记录，不自动重复执行"};
  const recordedJob = readJson(receipt.jobFile);
  const errors = validateJobContract(receipt.jobFile, recordedJob);
  if (errors.length) throw new Error(`预览任务合同已失效：${errors.join("; ")}`);
  const job = observeJob(recordedJob);
  const inputCurrent = receipt.inputs.every(input => fs.existsSync(input.path) && (input.directory ? directoryIdentity(input.path).sha256 : sha256File(input.path)) === input.sha256);
  const current = receipt.implementation === implementationIdentity(scripts).sha256 && inputCurrent && sha256File(timeline) === receipt.revision && latest.key === key && loadKachaConfig({ anchorPath: timeline, includeSecrets: false }).digest === receipt.configurationDigest;
  const output = job.outputs?.find(item => item.path === receipt.output);
  const verified = job.status === "succeeded" && output?.sha256 && fs.existsSync(receipt.output) && sha256File(receipt.output) === output.sha256;
  return { status: job.status, key, revision: receipt.revision, range: { start: receipt.start, end: receipt.end }, current,
    ready: Boolean(current && verified), stale: !current, output: verified ? receipt.output : null, job: receipt.job, recovery: job.recovery, error: job.error ?? null };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = name => args[args.indexOf(name) + 1];
  try {
    const timeline = opt("--timeline");
    const result = args[0] === "request" ? requestRealPreview(timeline, { start: Number(opt("--start")), end: Number(opt("--end")), expectedSha256: opt("--expected-sha") }) : args[0] === "status" ? realPreviewStatus(timeline, opt("--key")) : (() => { throw new Error("用法：real-preview request|status --timeline FILE --start SEC --end SEC --expected-sha SHA | --key KEY"); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
