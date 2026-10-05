import fs from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Full verification hashes media and probes installed runtimes synchronously.
// Keep it outside the HTTP event loop without creating an unbounded job queue.
export function createProjectTaskRunner({ limit = 2, workerUrl = new URL(import.meta.url) } = {}) {
  const active = new Set();
  return function runProjectTask(task, projectRoot, options = {}) {
    if (!["status", "run", "observe"].includes(task)) throw new Error("Unknown project task");
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) throw new Error("项目目录必须是绝对路径");
    const root = fs.realpathSync(projectRoot);
    if (!fs.statSync(root).isDirectory()) throw new Error("项目路径必须是目录");
    if (active.has(root) || active.size >= limit) {
      throw Object.assign(new Error("项目核验或执行正在进行，请等待完成后重试；未重复提交。"), { statusCode: 409 });
    }
    active.add(root);
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(workerUrl, { workerData: { task, projectRoot: root, options } }); }
      catch (error) { active.delete(root); reject(error); return; }
      let result;
      let failure;
      worker.once("message", (message) => { result = message; });
      worker.once("error", (error) => { failure = error; });
      worker.once("exit", (code) => {
        active.delete(root);
        if (failure || code !== 0 || !result) reject(failure ?? new Error(`项目任务异常退出 (${code})；请读取当前状态后再决定是否重试。`));
        else if (result.error) reject(new Error(result.error));
        else resolve(result.value);
      });
    });
  };
}

if (!isMainThread) {
  try {
    const { task, projectRoot, options } = workerData;
    let value;
    if (task === "observe") {
      const { observeProject } = await import("./project_observation.mjs");
      value = observeProject(projectRoot);
    } else {
      const { projectStatus, runProject } = await import("./project_orchestrator.mjs");
      value = task === "status" ? projectStatus(projectRoot) : runProject(projectRoot, options);
    }
    parentPort.postMessage({ value });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
}
