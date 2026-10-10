import fs from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Full verification hashes media and probes installed runtimes synchronously.
// Keep it outside the HTTP event loop without creating an unbounded job queue.
export function createStudioTaskRunner({ limit = 2, workerUrl = new URL(import.meta.url) } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Task concurrency must be a positive integer");
  const active = new Set();
  const previewHashCaches = new Map();
  let running = 0;
  return function runProjectTask(task, projectRoot, options = {}) {
    if (!["status", "run", "observe", "probe", "preview", "compile", "real-preview", "real-preview-status", "content-start"].includes(task)) throw new Error("Unknown project task");
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) throw new Error("项目或媒体路径必须是绝对路径");
    const creating = task === "content-start";
    const root = canonicalTaskPath(projectRoot, creating);
    const previewTask = ["real-preview", "real-preview-status"].includes(task);
    const mediaTask = ["probe", "preview", "compile", "real-preview", "real-preview-status"].includes(task);
    // Canonicalize only the lock. A media symlink's selected directory owns
    // its config discovery, display name and default output destination.
    const executionRoot = mediaTask ? path.resolve(projectRoot) : root;
    if (!creating && !fs.statSync(root)[mediaTask ? "isFile" : "isDirectory"]()) {
      throw new Error("项目路径必须是目录，媒体路径必须是文件");
    }
    const resources = [root];
    if (task === "compile") {
      const destination = options.outputDirectory ? path.resolve(options.outputDirectory) : path.dirname(executionRoot);
      resources.push(canonicalTaskPath(destination, true));
    }
    if (resources.some(key => active.has(key)) || running >= limit) {
      throw Object.assign(new Error("项目核验或执行正在进行，请等待完成后重试；未重复提交。"), { statusCode: 409 });
    }
    resources.forEach(key => active.add(key)); running++;
    const release = () => { resources.forEach(key => active.delete(key)); running--; };
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(workerUrl, { workerData: { task, projectRoot: executionRoot, options, hashCache: previewTask ? previewHashCaches.get(root) : undefined } }); }
      catch (error) { release(); reject(error); return; }
      let result;
      let failure;
      worker.once("message", (message) => { result = message; });
      worker.once("error", (error) => { failure = error; });
      worker.once("exit", (code) => {
        release();
        if (failure || code !== 0 || !result) reject(failure ?? new Error(`项目任务异常退出 (${code})；请读取当前状态后再决定是否重试。`));
        else if (result.error) reject(Object.assign(new Error(result.error), { statusCode: result.statusCode }));
        else {
          if (previewTask && result.hashCache) {
            previewHashCaches.delete(root);
            if (previewHashCaches.size >= limit) previewHashCaches.delete(previewHashCaches.keys().next().value);
            previewHashCaches.set(root, result.hashCache);
          }
          resolve(result.value);
        }
      });
    });
  };
}

// Resolve the existing ancestor too: aliases must share a lock even before a
// new content directory exists. Never manufacture missing parent directories.
function canonicalTaskPath(value, allowMissing) {
  let cursor = path.resolve(value);
  const missing = [];
  while (true) {
    try { return path.join(fs.realpathSync(cursor), ...missing); }
    catch (error) {
      if (!allowMissing || error.code !== "ENOENT" || path.dirname(cursor) === cursor) throw error;
      missing.unshift(path.basename(cursor)); cursor = path.dirname(cursor);
    }
  }
}

export const createProjectTaskRunner = createStudioTaskRunner;

if (!isMainThread) {
  try {
    const { task, projectRoot, options } = workerData;
    const { importFileHashCache, exportFileHashCache } = await import('./kacha_utils.mjs');
    importFileHashCache(workerData.hashCache);
    let value;
    if (task === "observe") {
      const { observeProject } = await import("./project_observation.mjs");
      value = observeProject(projectRoot);
    } else if (["probe", "preview", "compile"].includes(task)) {
      const { inspectProductionVideo, compileProductionRequest } = await import("./kacha_studio.mjs");
      value = task === "probe" ? inspectProductionVideo(projectRoot)
        : compileProductionRequest({ ...options, videoPath: projectRoot }, { write: task === "compile" });
    } else if (["real-preview", "real-preview-status"].includes(task)) {
      const { requestRealPreview, realPreviewStatus } = await import("./real_preview.mjs");
      value = task === "real-preview" ? requestRealPreview(projectRoot, options) : realPreviewStatus(projectRoot, options.key);
    } else if (task === "content-start") {
      const { loadProductionCatalog } = await import("./kacha_studio.mjs");
      const { initializeProject } = await import("./project_orchestrator.mjs");
      if (!options.scriptPath && !options.topic) throw new Error("请提供脚本路径或中心选题");
      const catalog = loadProductionCatalog();
      const { resolveProductionSelection } = await import("./production_pack.mjs");
      const selection = resolveProductionSelection(null, options.show);
      const expectedStyle = selection.packId === "xingzhe-dahui" ? null : selection.packId;
      if (expectedStyle ? options.style !== expectedStyle : !catalog.visualLanguages.some(item => item.id === options.style)) {
        throw new Error(`内容栏目与视觉风格不匹配：${options.style}`);
      }
      value = initializeProject({
        script: options.scriptPath || null, topic: options.topic || null,
        projectRoot, projectId: options.projectId, task: "content_generation",
        pack: selection.packId, show: selection.showId, style: options.style, platform: options.platform,
        language: "zh", confirmExecute: false, development: false,
      });
    } else {
      const { projectStatus, runProject } = await import("./project_orchestrator.mjs");
      value = task === "status" ? projectStatus(projectRoot) : runProject(projectRoot, options);
    }
    parentPort.postMessage({ value, hashCache: ['real-preview','real-preview-status'].includes(task) ? exportFileHashCache() : undefined });
  } catch (error) { parentPort.postMessage({ error: error.message, statusCode: error.statusCode }); }
}
