#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";

const token = process.env.MOCK_FACEFUSION_TOKEN;
const resultFile = process.env.MOCK_FACEFUSION_RESULT_FILE;
if (!token || !resultFile || !fs.existsSync(resultFile)) {
  console.error("MOCK_FACEFUSION_TOKEN and MOCK_FACEFUSION_RESULT_FILE are required");
  process.exit(2);
}

let uploadCount = 0;

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function authorized(request, response) {
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(response, 401, { detail: "unauthorized" });
    return false;
  }
  return true;
}

function afterBody(request, callback) {
  request.on("error", () => {});
  request.on("data", () => {});
  request.on("end", callback);
  request.resume();
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, {
      status: "ok",
      facefusion_version: "3.6.1",
      python_ready: true,
      queue_depth: 0,
    });
    return;
  }
  if (!authorized(request, response)) return;
  if (request.method === "GET" && url.pathname === "/v1/capabilities") {
    json(response, 200, {
      facefusion_version: "3.6.1",
      processors: [
        "face_swapper",
        "lip_syncer",
        "face_enhancer",
        "frame_enhancer",
      ],
      allowed_options: [
        "face_swapper_model",
        "face_swapper_weight",
        "face_mask_blur",
        "lip_syncer_model",
        "lip_syncer_weight",
        "face_enhancer_model",
        "face_enhancer_blend",
        "frame_enhancer_model",
        "frame_enhancer_blend",
        "execution_providers",
        "output_video_scale",
      ],
      execution_providers: ["CoreMLExecutionProvider", "CPUExecutionProvider"],
      concurrency: 1,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/assets") {
    afterBody(request, () => {
      uploadCount += 1;
      json(response, 200, { ref: `asset:mock-${uploadCount}` });
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/jobs") {
    afterBody(request, () => {
      json(response, 200, { id: "job-1", status: "queued" });
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/jobs/job-1") {
    json(response, 200, { id: "job-1", status: "succeeded" });
    return;
  }
  if (
    request.method === "GET"
    && url.pathname === "/v1/jobs/job-1/result"
  ) {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    fs.createReadStream(resultFile).pipe(response);
    return;
  }
  json(response, 404, { detail: "not found" });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
