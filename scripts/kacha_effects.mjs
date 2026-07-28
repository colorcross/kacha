#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  applicableEditingDefaults,
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";
import {
  listStyleProfiles,
  loadEffectRegistry,
  loadStyleProfile,
  resolveTransition,
} from "./style_profile.mjs";

const args = process.argv.slice(2);
const action = args[0];
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const has = (name) => args.includes(name);

function fail(message, code = 1) {
  console.error(JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2));
  process.exit(code);
}

function commandExists(command) {
  return spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;
}

function run(command, commandArgs, cwd = process.cwd()) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} 失败\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function easeOutCubic(value) {
  return 1 - ((1 - Math.max(0, Math.min(1, value))) ** 3);
}

function openingSvg(effectId, frame, total, width, height, title, subtitle, style) {
  const p = total <= 1 ? 1 : frame / (total - 1);
  const palette = style.palette;
  const display = style.typography.display;
  const label = style.typography.label;
  const displaySize = Math.round(width * display.sizeRatio);
  const labelSize = Math.round(width * label.sizeRatio);
  const titleSafe = xml(title);
  const subtitleSafe = xml(subtitle);
  let content = "";
  if (effectId === "editorial_label_reveal") {
    const x = Math.round((-width * 0.72) + width * 0.78 * easeOutCubic(p / 0.58));
    const line = Math.round(width * 0.5 * easeOutCubic((p - 0.18) / 0.52));
    content = `<g transform="translate(${x} 0)">
      <rect x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.18)}" width="${Math.round(width * 0.66)}" height="${Math.round(height * 0.44)}" rx="${Math.round(width * 0.025)}" fill="${palette.surface}"/>
      <text x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.31)}" font-family="${xml(display.families.join(","))}" font-size="${displaySize}" font-weight="${display.weight}" fill="${palette.ink}">${titleSafe}</text>
      <text x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.43)}" font-family="${xml(label.families.join(","))}" font-size="${labelSize}" font-weight="${label.weight}" fill="${palette.inkSecondary}">${subtitleSafe}</text>
      <rect x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.5)}" width="${line}" height="${Math.max(3, Math.round(height * 0.012))}" rx="3" fill="${palette.accent}"/>
    </g>`;
  } else if (effectId === "kinetic_word_stack") {
    const words = title.split(/\s*[|/]\s*/).slice(0, 3);
    content = words.map((word, index) => {
      const local = easeOutCubic((p - index * 0.16) / 0.48);
      const y = Math.round(height * (0.32 + index * 0.18) + (1 - local) * height * 0.12);
      return `<text x="${Math.round(width * 0.08)}" y="${y}" opacity="${Math.max(0, Math.min(1, local)).toFixed(3)}" font-family="${xml(display.families.join(","))}" font-size="${displaySize}" font-weight="${display.weight}" fill="${index === words.length - 1 ? palette.accent : palette.ink}">${xml(word)}</text>`;
    }).join("");
  } else if (effectId === "typewriter_command") {
    const visible = Math.max(0, Math.min(title.length, Math.floor(p * (title.length + 3))));
    const cursor = frame % 8 < 5 ? "▌" : "";
    content = `<rect x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.3)}" width="${Math.round(width * 0.88)}" height="${Math.round(height * 0.3)}" rx="${Math.round(width * 0.024)}" fill="${palette.darkSurface}"/>
      <text x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.48)}" font-family="${xml(label.families.join(","))}" font-size="${Math.round(width * 0.045)}" font-weight="700" fill="${palette.textOnDark}">${xml(title.slice(0, visible))}${cursor}</text>`;
  } else if (effectId === "statement_punch") {
    const local = easeOutCubic(p / 0.55);
    const scale = 0.72 + local * (p < 0.55 ? 0.34 : 0.28);
    content = `<g transform="translate(${width / 2} ${height / 2}) scale(${scale.toFixed(4)}) translate(${-width / 2} ${-height / 2})">
      <text x="${width / 2}" y="${height * 0.48}" text-anchor="middle" font-family="${xml(display.families.join(","))}" font-size="${displaySize}" font-weight="${display.weight}" fill="${palette.ink}">${titleSafe}</text>
      <rect x="${width * 0.22}" y="${height * 0.56}" width="${width * 0.56}" height="${Math.max(3, height * 0.014)}" fill="${palette.accent}"/>
    </g>`;
  } else {
    const local = easeOutCubic(p / 0.48);
    content = `<g opacity="${Math.min(1, local).toFixed(3)}">
      <rect x="${width * 0.055}" y="${height * 0.08}" width="${width * 0.46 * local}" height="${Math.max(3, height * 0.012)}" fill="${palette.accent}"/>
      <text x="${width * 0.055}" y="${height * 0.2}" font-family="${xml(display.families.join(","))}" font-size="${displaySize}" font-weight="${display.weight}" fill="${palette.ink}">${titleSafe}</text>
      <text x="${width * 0.055}" y="${height * 0.29}" font-family="${xml(label.families.join(","))}" font-size="${labelSize}" font-weight="${label.weight}" fill="${palette.inkSecondary}">${subtitleSafe}</text>
    </g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${palette.canvas}"/>
    ${content}
  </svg>`;
}

function renderTransitionPreview(effect, style, output) {
  if (effect.engine !== "ffmpeg_xfade") {
    throw new Error(`${effect.id} 是时间线 overlay/cut，不使用 xfade 预览器`);
  }
  const width = Number(option("--width", 640));
  const height = Number(option("--height", 360));
  const fps = Number(option("--fps", 25));
  const duration = Number(option("--duration", Math.max(0.2, effect.durationFrames / fps)));
  const xfade = resolveTransition(effect, option("--direction"));
  const first = style.palette.darkSurface;
  const second = style.palette.accent;
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${first}:s=${width}x${height}:r=${fps}:d=1.6`,
    "-f", "lavfi", "-i", `color=c=${second}:s=${width}x${height}:r=${fps}:d=1.6`,
    "-filter_complex",
    `[0:v]format=yuv420p,settb=1/${fps}[a];[1:v]format=yuv420p,settb=1/${fps}[b];[a][b]xfade=transition=${xfade}:duration=${duration}:offset=${(1.6 - duration).toFixed(4)},format=yuv420p[v]`,
    "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", "-y", output,
  ]);
}

function renderOpeningPreview(effect, style, output) {
  if (!commandExists("rsvg-convert")) throw new Error("opening preview 需要 rsvg-convert");
  const width = Number(option("--width", 640));
  const height = Number(option("--height", 360));
  const fps = Number(option("--fps", 25));
  const frames = Number(option("--frames", effect.durationFrames));
  const title = option("--title", "AI EDITS. YOU DECIDE.");
  const subtitle = option("--subtitle", "DAHUI · TOOL SHARE");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-opening-"));
  try {
    for (let frame = 0; frame < frames; frame += 1) {
      const svg = path.join(temporary, `${String(frame).padStart(5, "0")}.svg`);
      const png = path.join(temporary, `${String(frame).padStart(5, "0")}.png`);
      fs.writeFileSync(svg, openingSvg(effect.id, frame, frames, width, height, title, subtitle, style));
      run("rsvg-convert", ["-o", png, svg]);
    }
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", String(fps),
      "-i", path.join(temporary, "%05d.png"),
      "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-y", output,
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (!["list", "show", "validate", "preview"].includes(action)) {
  fail("用法：kacha.mjs effects list|show|validate|preview [--kind transition|opening] [--id EFFECT]", 2);
}

const loaded = loadKachaConfig({
  args,
  anchorPath: option("--anchor"),
  includeSecrets: false,
});
const defaults = applicableEditingDefaults(loaded, {
  task: "local_optimization",
  modules: ["visual", "transitions", "openings"],
});
const style = loadStyleProfile(
  loaded.config.style.profile,
  loaded.config.style.overrides,
);
const kinds = option("--kind") ? [option("--kind")] : ["transition", "opening"];
const registries = kinds.map((kind) => loadEffectRegistry(kind));

if (action === "validate") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    style: { id: style.profile.id, digest: style.digest, source: style.source },
    registries: registries.map((item) => ({
      kind: item.registry.kind,
      count: item.registry.effects.length,
      digest: item.digest,
      source: item.source,
    })),
    availableStyleProfiles: listStyleProfiles(),
  }, null, 2));
  process.exit(0);
}

const effectEntries = registries.flatMap((item) => (
  item.registry.effects.map((effect) => ({
    kind: item.registry.kind,
    effect,
  }))
));
if (action === "list") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    style: style.profile.id,
    effects: effectEntries.map(({ kind, effect }) => ({
      kind,
      id: effect.id,
      label: effect.label,
      engine: effect.engine,
      status: effect.status,
      durationFrames: effect.durationFrames,
      useWhen: effect.useWhen,
      fallback: effect.fallback,
    })),
  }, null, 2));
  process.exit(0);
}

const id = option("--id") || firstPositional(args.slice(1), [
  "--anchor", "--config", "--secrets", "--kind", "--id", "--output",
  "--width", "--height", "--fps", "--duration", "--direction", "--frames",
  "--title", "--subtitle",
]);
const effectEntry = effectEntries.find((item) => item.effect.id === id);
if (!effectEntry) fail(`效果不存在：${id}`);
const { effect } = effectEntry;
if (action === "show") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    effect,
    style: style.profile,
    styleDigest: style.digest,
    defaultRequirements: defaults,
  }, null, 2));
  process.exit(0);
}

const output = path.resolve(option("--output", `${effect.id}-preview.mp4`));
if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖已有预览：${output}`);
fs.mkdirSync(path.dirname(output), { recursive: true });
if (effectEntry.kind === "transition") {
  renderTransitionPreview(effect, style.profile, output);
} else {
  renderOpeningPreview(effect, style.profile, output);
}
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: "pass",
  effectId: effect.id,
  styleId: style.profile.id,
  styleDigest: style.digest,
  output,
}, null, 2));
