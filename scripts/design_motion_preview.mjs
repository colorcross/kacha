import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { renderSceneArtifact, validateRenderArtifact } from "./design_renderers.mjs";
import { sha256File, sha256Value } from "./kacha_utils.mjs";

const DEFAULT_SCENES = [
  "info_single",
  "info_bullets",
  "narrative_quote",
  "compare_two",
  "ai_response_popup",
  "ending_summary",
];

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function easeOutCubic(value) {
  return 1 - (1 - value) ** 3;
}

function animatedSvg(svg, scene, componentIds, frame, fps, durationSeconds) {
  const time = frame / fps;
  const exitStart = durationSeconds - 0.42;
  const directionX = /direction|slide|spatial|response|quote/.test(scene.entry) ? 34 : 0;
  const directionY = directionX === 0 ? 24 : 7;
  const rules = componentIds.map((id, index) => {
    const entry = easeOutCubic(clamp((time - index * 0.1) / 0.38));
    const exit = easeOutCubic(clamp((time - exitStart) / 0.32));
    const opacity = Math.max(0, entry * (1 - exit));
    const x = (1 - entry) * directionX + exit * -12;
    const y = (1 - entry) * directionY + exit * -8;
    return `[data-component-id="${id}"]{opacity:${opacity.toFixed(4)};transform:translate(${x.toFixed(2)}px,${y.toFixed(2)}px)}`;
  }).join("");
  return svg.replace(/(<svg\b[^>]*>)/, `$1<style>${rules}</style>`);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function generateDesignMotionPreviews({
  resolved,
  outputDirectory,
  sceneIds = DEFAULT_SCENES,
  overwrite = false,
  fps = 25,
  durationSeconds = 3.2,
} = {}) {
  const output = path.resolve(outputDirectory);
  if (fs.existsSync(output) && !overwrite) {
    throw new Error(`动态参考目录已存在：${output}；显式使用 --overwrite`);
  }
  fs.mkdirSync(output, { recursive: true });
  const sceneMap = new Map(resolved.scenes.map((scene) => [scene.id, scene]));
  const scenes = sceneIds.map((id) => {
    const scene = sceneMap.get(id);
    if (!scene) throw new Error(`未找到场景：${id}`);
    return scene;
  });
  const entries = [];
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-design-motion-"));
  try {
    for (const scene of scenes) {
      const sceneRoot = path.join(temporaryRoot, scene.id);
      const frameRoot = path.join(sceneRoot, "frames");
      fs.mkdirSync(frameRoot, { recursive: true });
      const artifact = renderSceneArtifact(scene, resolved, {
        width: 1280,
        height: 720,
        state: "peak",
        showGuides: false,
      });
      const errors = validateRenderArtifact(artifact, [scene.id, ...scene.components]);
      if (errors.length > 0) throw new Error(`${scene.id}: ${errors.join("; ")}`);
      const frameCount = Math.round(durationSeconds * fps);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const svgFile = path.join(sceneRoot, `${String(frame).padStart(4, "0")}.svg`);
        const pngFile = path.join(frameRoot, `${String(frame).padStart(4, "0")}.png`);
        fs.writeFileSync(
          svgFile,
          animatedSvg(artifact.svg, scene, scene.components, frame, fps, durationSeconds),
        );
        execFileSync("rsvg-convert", ["-w", "1280", "-h", "720", svgFile, "-o", pngFile], {
          stdio: "ignore",
        });
      }
      const video = path.join(output, `${scene.id}.mp4`);
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", String(fps),
        "-i", path.join(frameRoot, "%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        video,
      ], { stdio: "ignore" });
      entries.push({
        sceneId: scene.id,
        trigger: scene.trigger,
        entry: scene.entry,
        exit: scene.exit,
        fps,
        durationSeconds,
        file: path.basename(video),
        sha256: sha256File(video),
        reviewContract: {
          playbackSpeed: 1,
          purpose: "representative_motion_and_clearance_review",
          staticPeakFrameIsNotAcceptance: true,
          finalTimelineHumanReviewStillRequired: true,
        },
      });
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  const manifest = {
    schemaVersion: "1.0",
    kind: "kacha-design-normal-speed-reference-previews",
    designSystem: {
      id: resolved.system.id,
      version: resolved.system.version,
      digest: resolved.digest,
    },
    rendering: { width: 1280, height: 720, fps, durationSeconds },
    previewCount: entries.length,
    previews: entries,
    entries,
    reviewContract: {
      normalSpeedRequired: true,
      staticPeakFrameIsNotAcceptance: true,
      finalTimelineHumanReviewStillRequired: true,
    },
  };
  manifest.digest = sha256Value(manifest);
  writeJsonAtomic(path.join(output, "manifest.json"), manifest);
  return {
    status: "pass",
    outputDirectory: output,
    previews: entries.length,
    manifest: path.join(output, "manifest.json"),
    digest: manifest.digest,
  };
}
