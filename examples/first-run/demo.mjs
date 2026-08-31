#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEditorCommand, openEditorProject, redoEditorCommand, undoEditorCommand } from "../../scripts/editor_command_journal.mjs";
import { run, sha256File, writeJsonAtomic } from "../../scripts/kacha_utils.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-dir");
const requestedOutput = outputIndex >= 0 ? args[outputIndex + 1] : null;
const root = requestedOutput ? path.resolve(requestedOutput) : fs.mkdtempSync(path.join(os.tmpdir(), "kacha-first-run-"));
if (requestedOutput && fs.existsSync(root) && fs.readdirSync(root).length > 0) {
  throw new Error(`--output-dir must be empty: ${root}`);
}
fs.mkdirSync(root, { recursive: true });

function execute(command, commandArgs) {
  const result = run(command, commandArgs, { cwd: repositoryRoot, timeout: 45_000 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} failed`);
  return result;
}

const startedAt = Date.now();
const source = path.join(root, "source.mp4");
const overlay = path.join(root, "card.png");
const timeline = path.join(root, "timeline.json");
const output = path.join(root, "verified-edit.mp4");
execute("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=0x18212b:s=640x360:r=25:d=3",
  "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=3",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
]);
execute("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=0xe0a35a:s=120x60:d=0.1", "-frames:v", "1", overlay,
]);
writeJsonAtomic(timeline, {
  schemaVersion: "1.0",
  projectId: "kacha-first-run",
  mode: "preview",
  source: { path: source, sha256: sha256File(source) },
  edl: [{ id: "main", sourceStart: 0, sourceEnd: 3 }],
  visual: {
    breathing: [],
    overlays: [{ id: "card", kind: "image", path: overlay, start: 0.4, end: 2.4, x: 40, y: 60, width: 120, height: 60, opacity: 0.95 }],
  },
  audio: { sfx: [] },
  output: { path: output, width: 640, height: 360, fps: 25 },
});
let project = openEditorProject(timeline);
for (const command of [
  { itemId: "overlay:card", operation: "keyframe_set", arguments: { property: "x", tick: 48000, value: 40 } },
  { itemId: "overlay:card", operation: "keyframe_set", arguments: { property: "x", tick: 288000, value: 460 } },
  { operation: "marker_set", arguments: { marker: { id: "review", tick: 168000, label: "人工复看片段" } } },
]) {
  const result = applyEditorCommand(timeline, {
    schemaVersion: "1.0",
    kind: "kacha-editor-command",
    baseSha256: project.session.currentSha256,
    actor: "first-run-demo",
    reason: "demonstrate a reversible SHA-locked edit",
    ...command,
  });
  project = result.project;
}
const undone = undoEditorCommand(timeline, project.session.currentSha256);
project = redoEditorCommand(timeline, undone.timelineSha256).project;
execute(process.execPath, [path.join(repositoryRoot, "scripts", "kacha.mjs"), "timeline", "validate", "--plan", timeline]);
execute(process.execPath, [path.join(repositoryRoot, "scripts", "kacha.mjs"), "timeline", "render", "--plan", timeline, "--output", output, "--mode", "preview"]);
const elapsedSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(2));
const summary = {
  schemaVersion: "1.0",
  status: "pass",
  elapsedSeconds,
  activationTargetSeconds: 90,
  withinActivationTarget: elapsedSeconds <= 90,
  projectRoot: root,
  timeline: { path: timeline, sha256: project.session.currentSha256 },
  output: { path: output, sha256: sha256File(output), sizeBytes: fs.statSync(output).size },
  demonstrated: ["SHA-locked typed keyframes", "marker metadata", "undo/redo", "Timeline validation", "FFmpeg preview render"],
  boundaries: ["Canvas is approximate; this artifact was rendered through the canonical FFmpeg Render Graph.", "Human visual acceptance is still required."],
};
writeJsonAtomic(path.join(root, "demo-summary.json"), summary);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
