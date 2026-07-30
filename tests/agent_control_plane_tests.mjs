#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  readJson,
  resolveRuntimeCommand,
  sha256File,
} from "../scripts/kacha_utils.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testDirectory);
const cli = path.join(root, "scripts", "kacha.mjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-agent-control-"));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function invoke(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      KACHA_CONFIG_HOME: path.join(temporary, "config"),
    },
  });
}

function run(args, expectedStatus = 0) {
  const result = invoke(args);
  assert.equal(
    result.status,
    expectedStatus,
    `${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

function blocked(args) {
  const result = invoke(args);
  assert.notEqual(
    result.status,
    0,
    `${args.join(" ")} unexpectedly passed\n${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(result.stderr);
}

try {
  const before = path.join(temporary, "before.json");
  const after = path.join(temporary, "after.json");
  const mutation = path.join(temporary, "mutation.json");
  const delta = path.join(temporary, "delta.json");
  writeJson(before, {
    visual: {
      overlays: [{ id: "card-1", x: 10, y: 20 }],
    },
    untouched: Array.from({ length: 600 }, (_, index) => ({
      id: `frozen-${index}`,
      value: `稳定内容-${index}`,
    })),
  });
  writeJson(mutation, {
    schemaVersion: "1.0",
    baseSha256: sha256File(before),
    operations: [{ op: "replace", path: "/visual/overlays/0/x", value: 24 }],
  });
  const applied = run([
    "delta", "apply", before, mutation,
    "--write", after,
    "--output", delta,
  ]);
  assert.equal(JSON.parse(fs.readFileSync(after, "utf8")).visual.overlays[0].x, 24);
  assert.equal(applied.summary.changed, 1);
  assert.ok(applied.tokenBudget.estimatedReductionRatio > 0.8);
  assert.equal(JSON.parse(fs.readFileSync(delta, "utf8")).changes[0].objectRef, "@overlay:card-1");
  const reordered = path.join(temporary, "reordered.json");
  const reorderedValue = JSON.parse(fs.readFileSync(after, "utf8"));
  reorderedValue.visual.overlays.push({ id: "card-2", x: 50, y: 60 });
  writeJson(after, reorderedValue);
  reorderedValue.visual.overlays.reverse();
  writeJson(reordered, reorderedValue);
  const reorderedDelta = run(["delta", "diff", after, reordered]);
  assert.equal(reorderedDelta.summary.moved, 2);
  assert.equal(reorderedDelta.summary.added, 0);
  assert.equal(reorderedDelta.summary.removed, 0);
  const manyBefore = path.join(temporary, "many-before.json");
  const manyAfter = path.join(temporary, "many-after.json");
  writeJson(manyBefore, {
    items: Array.from({ length: 95 }, (_, index) => ({
      id: `item-${index}`,
      value: 0,
    })),
  });
  writeJson(manyAfter, {
    items: Array.from({ length: 95 }, (_, index) => ({
      id: `item-${index}`,
      value: 1,
    })),
  });
  const windowedDelta = run(["delta", "diff", manyBefore, manyAfter]);
  assert.equal(windowedDelta.summary.changed, 95);
  assert.equal(windowedDelta.changes.length, 20);
  assert.equal(windowedDelta.responseWindow.truncated, true);
  assert.equal(windowedDelta.responseWindow.omittedChanges, 75);
  assert.ok(windowedDelta.fullReport);
  assert.equal(readJson(windowedDelta.fullReport).changes.length, 95);

  const mediaRoot = path.join(temporary, "media");
  fs.mkdirSync(mediaRoot);
  const pearl = path.join(mediaRoot, "pearl.jpg");
  const runClip = path.join(mediaRoot, "running.mp4");
  fs.writeFileSync(pearl, "fixture");
  fs.writeFileSync(runClip, "fixture");
  const catalog = path.join(temporary, "catalog.json");
  writeJson(catalog, {
    entries: [
      {
        id: "pearl-night",
        path: pearl,
        kind: "image",
        description: "上海城市地标 东方明珠 建筑 夜景",
        tags: ["城市", "灯光"],
        license: "project_licensed",
      },
      {
        id: "running-track",
        path: runClip,
        kind: "video",
        description: "操场跑步 疲惫",
        tags: ["运动"],
        license: "project_licensed",
      },
    ],
  });
  const mediaIndex = path.join(temporary, "media-index.json");
  run([
    "media", "index",
    "--root", mediaRoot,
    "--catalog", catalog,
    "--no-scan",
    "--output", mediaIndex,
  ]);
  const search = run([
    "media", "search", mediaIndex,
    "--query", "都市建筑夜景",
    "--limit", "2",
  ]);
  assert.equal(search.results[0].ref, "@asset:pearl-night");
  assert.equal(search.privacy.externalUpload, false);
  const cappedIndex = path.join(temporary, "media-index-capped.json");
  const capped = run([
    "media", "index",
    "--root", mediaRoot,
    "--max-files", "1",
    "--output", cappedIndex,
  ]);
  assert.equal(capped.summary.scan.truncated, true);
  assert.ok(capped.limitations.some((item) => item.includes("--max-files=1")));

  const thinking = path.join(mediaRoot, "thinking.jpg");
  const dog = path.join(mediaRoot, "dog.jpg");
  fs.writeFileSync(thinking, "fixture");
  fs.writeFileSync(dog, "fixture");
  const semanticCatalog = path.join(temporary, "semantic-catalog.json");
  writeJson(semanticCatalog, {
    entries: [
      {
        id: "thoughtful-reader",
        path: thinking,
        kind: "image",
        description: "Thoughtful man seated before books considering his future direction",
        license: "project_licensed",
      },
      {
        id: "playful-dog",
        path: dog,
        kind: "image",
        description: "A playful dog sprints across a grassy field",
        license: "project_licensed",
      },
    ],
  });
  const semanticIndex = path.join(temporary, "semantic-index.json");
  run([
    "media", "index",
    "--root", mediaRoot,
    "--catalog", semanticCatalog,
    "--no-scan",
    "--output", semanticIndex,
  ]);
  const semanticSearch = run([
    "media", "search", semanticIndex,
    "--query", "A calm professional contemplates what comes next",
    "--limit", "2",
  ]);
  if (process.platform === "darwin") {
    assert.equal(semanticSearch.semantic.available, true);
    assert.equal(semanticSearch.results[0].ref, "@asset:thoughtful-reader");
    assert.ok(
      semanticSearch.results[0].whyMatched.some(
        (item) => item.field === "local_semantic_embedding",
      ),
    );
  } else {
    assert.equal(semanticSearch.semantic.available, false);
    assert.ok(semanticSearch.semantic.limitation);
  }

  const project = path.join(temporary, "project");
  fs.mkdirSync(project);
  const jobOutput = path.join(project, "generated.txt");
  const job = run([
    "jobs", "submit",
    "--project-root", project,
    "--kind", "generated-media",
    "--expected-output", jobOutput,
    "--foreground",
    "--",
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(jobOutput)},"ready")`,
  ]);
  assert.equal(job.status, "succeeded");
  const jobStatus = run([
    "jobs", "status", job.ref,
    "--project-root", project,
  ]);
  assert.equal(jobStatus.job.status, "succeeded");
  assert.equal(
    JSON.parse(fs.readFileSync(job.placeholder, "utf8")).state,
    "ready",
  );
  const asyncOutput = path.join(project, "async-generated.txt");
  const asyncJob = run([
    "jobs", "submit",
    "--project-root", project,
    "--kind", "async-render",
    "--expected-output", asyncOutput,
    "--",
    process.execPath,
    "-e",
    `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(asyncOutput)},"ready"),150)`,
  ]);
  assert.equal(asyncJob.status, "submitted");
  let asyncStatus = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    asyncStatus = run([
      "jobs", "status", asyncJob.ref,
      "--project-root", project,
    ]);
    if (["succeeded", "failed"].includes(asyncStatus.job.status)) break;
  }
  assert.equal(asyncStatus?.job.status, "succeeded");
  assert.equal(
    JSON.parse(fs.readFileSync(asyncJob.placeholder, "utf8")).state,
    "ready",
  );

  blocked([
    "jobs", "submit",
    "--project-root", project,
    "--kind", "secret-rejection",
    "--expected-output", path.join(project, "secret.txt"),
    "--",
    process.execPath,
    "-e",
    "",
    "Authorization: Bearer test-secret",
  ]);
  blocked([
    "jobs", "submit",
    "--project-root", project,
    "--kind", "inline-secret-rejection",
    "--expected-output", path.join(project, "inline-secret.txt"),
    "--",
    process.execPath,
    "-e",
    "",
    "--api-key=test-redacted-value",
  ]);
  blocked([
    "jobs", "submit",
    "--project-root", project,
    "--kind", "missing-output-contract",
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const outside = path.join(temporary, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(project, "outside-link"));
  blocked([
    "jobs", "submit",
    "--project-root", project,
    "--kind", "boundary-rejection",
    "--expected-output", path.join(project, "outside-link", "escaped.txt"),
    "--foreground",
    "--",
    process.execPath,
    "-e",
    "",
  ]);

  const cancelledOutput = path.join(project, "cancelled-output.txt");
  const cancellable = run([
    "jobs", "submit",
    "--project-root", project,
    "--kind", "cancel-contract",
    "--expected-output", cancelledOutput,
    "--",
    process.execPath,
    "-e",
    `process.on("SIGTERM",()=>{});setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(cancelledOutput)},"late"),900)`,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const cancelled = run([
    "jobs", "cancel", cancellable.ref,
    "--project-root", project,
  ]);
  assert.equal(cancelled.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const cancelledStatus = run([
    "jobs", "status", cancellable.ref,
    "--project-root", project,
  ]);
  assert.equal(cancelledStatus.job.status, "cancelled");
  assert.equal(fs.existsSync(cancelledOutput), false);
  assert.equal(readJson(cancellable.placeholder).state, "cancelled");

  const resumableOutput = path.join(project, "resumable-output.txt");
  const resumableMarker = path.join(project, "resumable-marker.txt");
  const resumableCode = [
    "const fs=require('node:fs');",
    `const output=${JSON.stringify(resumableOutput)};`,
    `const marker=${JSON.stringify(resumableMarker)};`,
    "if(fs.existsSync(marker)){fs.writeFileSync(output,'ready');process.exit(0);}",
    "fs.writeFileSync(marker,'attempted');",
    "fs.writeFileSync(output,'partial');",
    "process.exit(5);",
  ].join("");
  const failedJob = run([
    "jobs", "submit",
    "--project-root", project,
    "--kind", "resume-contract",
    "--expected-output", resumableOutput,
    "--foreground",
    "--",
    process.execPath,
    "-e",
    resumableCode,
  ]);
  assert.equal(failedJob.status, "failed");
  assert.equal(fs.readFileSync(resumableOutput, "utf8"), "partial");
  const resumedJob = run([
    "jobs", "resume", failedJob.ref,
    "--project-root", project,
    "--foreground",
  ]);
  assert.equal(resumedJob.status, "succeeded");
  assert.equal(fs.readFileSync(resumableOutput, "utf8"), "ready");
  const resumedRecord = readJson(path.join(
    project,
    ".kacha",
    "jobs",
    failedJob.ref.split(":")[1],
    "job.json",
  ));
  assert.equal(resumedRecord.quarantinedOutputs.length, 1);
  assert.equal(
    fs.readFileSync(resumedRecord.quarantinedOutputs[0], "utf8"),
    "partial",
  );

  const objectIndex = path.join(temporary, "object-index.json");
  run(["refs", "index", after, mediaIndex, "--output", objectIndex]);
  const resolved = run([
    "refs", "resolve", "@overlay:card-1",
    "--index", objectIndex,
  ]);
  assert.equal(resolved.object.pointer, "/visual/overlays/0");
  assert.equal(resolved.object.readContract.wholeOwnerRequired, false);
  const parsed = run([
    "refs", "parse", "把 @overlay:card-1 往右移动",
    "--index", objectIndex,
  ]);
  assert.equal(parsed.resolved, 1);
  const parsedUnquoted = run([
    "refs", "parse", "把", "@overlay:card-1", "往右移动",
    "--index", objectIndex,
  ]);
  assert.equal(parsedUnquoted.resolved, 1);
  const afterValue = JSON.parse(fs.readFileSync(after, "utf8"));
  afterValue.untouched[0].value = "只改无关对象";
  writeJson(after, afterValue);
  const resolvedAfterUnrelatedChange = run([
    "refs", "resolve", "@overlay:card-1",
    "--index", objectIndex,
  ]);
  assert.equal(resolvedAfterUnrelatedChange.object.ownerChanged, true);

  const collisionA = path.join(temporary, "collision-a.json");
  const collisionB = path.join(temporary, "collision-b.json");
  writeJson(collisionA, { overlays: [{ id: "shared-card", owner: "a" }] });
  writeJson(collisionB, { overlays: [{ id: "shared-card", owner: "b" }] });
  const collisionIndexAB = path.join(temporary, "collision-ab.json");
  const collisionIndexBA = path.join(temporary, "collision-ba.json");
  run(["refs", "index", collisionA, collisionB, "--output", collisionIndexAB]);
  run(["refs", "index", collisionB, collisionA, "--output", collisionIndexBA]);
  const collisionRefs = (file) => readJson(file).objects
    .filter((item) => item.id.startsWith("shared-card"))
    .map((item) => ({ ref: item.ref, owner: item.owner }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  assert.deepEqual(collisionRefs(collisionIndexAB), collisionRefs(collisionIndexBA));
  assert.equal(
    collisionRefs(collisionIndexAB).some((item) => item.ref === "@overlay:shared-card"),
    false,
  );
  blocked([
    "refs", "resolve", "@overlay:shared-card",
    "--index", collisionIndexAB,
  ]);

  const ffmpeg = resolveRuntimeCommand("ffmpeg");
  const timelineProject = path.join(temporary, "timeline-project");
  fs.mkdirSync(timelineProject);
  const timelineSource = path.join(timelineProject, "source.mp4");
  const timelineOverlay = path.join(timelineProject, "overlay.png");
  assert.equal(spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1:r=25",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    timelineSource,
  ]).status, 0);
  assert.equal(spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=white:s=16x16:d=0.04",
    "-frames:v", "1",
    timelineOverlay,
  ]).status, 0);
  const placeholderDirectory = path.join(timelineProject, ".kacha", "placeholders");
  fs.mkdirSync(placeholderDirectory, { recursive: true });
  const timelinePlaceholder = path.join(placeholderDirectory, "overlay-job.json");
  writeJson(timelinePlaceholder, {
    schemaVersion: "1.0",
    ref: "@job:overlay-job",
    state: "failed",
    updatedAt: new Date().toISOString(),
    expectedOutputs: [timelineOverlay],
    outputs: [],
  });
  const timelinePlan = path.join(timelineProject, "timeline.json");
  writeJson(timelinePlan, {
    schemaVersion: "1.0",
    projectId: "placeholder-gate",
    mode: "preview",
    source: { path: timelineSource },
    edl: [{ id: "source", sourceStart: 0, sourceEnd: 1 }],
    visual: {
      overlays: [{
        id: "overlay",
        path: timelineOverlay,
        kind: "image",
        start: 0.1,
        end: 0.8,
        x: 0,
        y: 0,
        width: 16,
        height: 16,
        opacity: 1,
      }],
    },
    audio: { sfx: [] },
    output: {
      path: path.join(timelineProject, "preview.mp4"),
      width: 64,
      height: 64,
      fps: 25,
    },
  });
  const pendingTimeline = invoke([
    "timeline", "validate",
    "--plan", timelinePlan,
  ]);
  assert.notEqual(pendingTimeline.status, 0);
  assert.match(pendingTimeline.stderr, /placeholder 尚未 ready/);
  writeJson(timelinePlaceholder, {
    ...readJson(timelinePlaceholder),
    state: "ready",
    updatedAt: new Date(Date.now() + 1000).toISOString(),
    outputs: [fileIdentity(timelineOverlay)],
  });
  run(["timeline", "validate", "--plan", timelinePlan]);

  const install = run([
    "install", "status",
    "--source", root,
    "--home", path.join(temporary, "empty-home"),
    "--agent", "both",
  ]);
  assert.equal(install.status, "sync_required");
  assert.equal(install.mode, "read_only_status");
  assert.equal(install.targets.length, 2);

  console.log(JSON.stringify({
    status: "pass",
    tests: [
      "mutation_delta",
      "local_semantic_media_search",
      "async_job_placeholder",
      "async_job_cancellation_and_security",
      "object_mentions",
      "object_reference_collision_safety",
      "timeline_placeholder_gate",
      "install_sync_status",
    ],
  }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
