#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mediaSummary,
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { resolveDesignSystem } from "./design_system.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const registryFile = path.join(
  skillDirectory,
  "config",
  "effects",
  "z-en-netstyle.json",
);
const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(name) {
  return args.includes(name);
}

function fail(message, code = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    error: message,
  }, null, 2));
  process.exit(code);
}

function mustRun(command, commandArgs) {
  const result = run(command, commandArgs);
  if (result.status !== 0) {
    throw new Error(
      `${command} 失败\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
  return result;
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function easeOut(value) {
  const p = clamp(value);
  return 1 - ((1 - p) ** 3);
}

function easeInOut(value) {
  const p = clamp(value);
  return p < 0.5
    ? 4 * p * p * p
    : 1 - ((-2 * p + 2) ** 3) / 2;
}

function rgba(hex, opacity = 1) {
  const value = String(hex).replace("#", "");
  const normalized = value.length === 3
    ? value.split("").map((char) => char + char).join("")
    : value.padEnd(6, "0").slice(0, 6);
  const number = Number.parseInt(normalized, 16);
  return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${opacity})`;
}

function displayText(payload, key, fallback, maximumLength = 18) {
  const value = String(payload?.display?.[key] ?? payload?.[key] ?? fallback ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.slice(0, maximumLength);
}

function displayItems(payload, fallback = []) {
  const items = Array.isArray(payload?.display?.items)
    ? payload.display.items
    : Array.isArray(payload?.items)
      ? payload.items
      : fallback;
  return items
    .map((item) => String(item).replace(/\s+/g, " ").trim().slice(0, 10))
    .filter(Boolean)
    .slice(0, 5);
}

function displayItemCues(payload, fallback = []) {
  const raw = Array.isArray(payload?.display?.itemCues)
    ? payload.display.itemCues
    : Array.isArray(payload?.itemCues)
      ? payload.itemCues
      : [];
  if (raw.length > 0) {
    return raw
      .map((item, index) => ({
        text: String(item?.text ?? item?.label ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 10),
        revealAt: clamp(Number(item?.revealAt ?? item?.progress ?? index * 0.26), 0, 0.92),
      }))
      .filter((item) => item.text)
      .slice(0, 5);
  }
  const labels = displayItems(payload, fallback);
  return labels.map((text, index) => ({
    text,
    revealAt: [0.12, 0.42, 0.72, 0.82, 0.88][index] ?? 0.88,
  }));
}

function productionPayloadErrors(effect, payload) {
  const errors = [];
  if (effect.id === "parallel_progressive_row") {
    const rawCues = Array.isArray(payload?.display?.itemCues)
      ? payload.display.itemCues
      : [];
    const cues = displayItemCues(payload, []);
    if (cues.length < 2) {
      errors.push("parallel_progressive_row 正式渲染至少需要两个 display.itemCues");
    }
    if (rawCues.length === 0) {
      errors.push("parallel_progressive_row 正式渲染必须提供 display.itemCues，不能按模块时长平均猜测");
    }
    let previousRevealAt = -1;
    for (let index = 0; index < rawCues.length; index += 1) {
      const revealAt = Number(rawCues[index]?.revealAt);
      if (!Number.isFinite(revealAt) || revealAt < 0 || revealAt > 0.92) {
        errors.push(`display.itemCues[${index}].revealAt 必须是 0–0.92 的语义触发进度`);
        continue;
      }
      if (revealAt <= previousRevealAt) {
        errors.push("display.itemCues.revealAt 必须严格递增");
        break;
      }
      previousRevealAt = revealAt;
    }
  }
  return errors;
}

function estimatedTextUnits(value) {
  return [...String(value ?? "")].reduce((total, character) => {
    if (/[\u3400-\u9fff\uff00-\uffef]/u.test(character)) return total + 1;
    if (/\s/u.test(character)) return total + 0.32;
    if (/[A-Z0-9]/u.test(character)) return total + 0.68;
    return total + 0.56;
  }, 0);
}

function fittedFontSize(value, preferred, maximumWidth, minimum) {
  const units = Math.max(1, estimatedTextUnits(value));
  return Math.max(minimum, Math.min(preferred, maximumWidth / units));
}

function commonOverlay(effect, width, height, style, alpha) {
  const p = style.palette;
  const labelFont = xml(style.typography.label.families.join(","));
  const badgeSize = Math.round(width * 0.031);
  const titleSize = Math.round(width * 0.052);
  const family = effect.family.replaceAll("_", " ").toUpperCase();
  return `
    <g opacity="${alpha.toFixed(3)}">
      <rect x="${width * 0.055}" y="${height * 0.055}" width="${width * 0.36}"
        height="${height * 0.044}" rx="${height * 0.022}"
        fill="${rgba(p.darkSurface, 0.88)}"/>
      <circle cx="${width * 0.079}" cy="${height * 0.077}" r="${width * 0.009}"
        fill="${p.accent}"/>
      <text x="${width * 0.099}" y="${height * 0.084}"
        font-family="${labelFont}" font-size="${badgeSize}" font-weight="700"
        fill="${p.textOnDark}">${xml(family)}</text>
      <rect x="${width * 0.055}" y="${height * 0.112}" width="${width * 0.82}"
        height="${height * 0.066}" rx="${height * 0.018}"
        fill="${rgba(p.darkSurface, 0.84)}"/>
      <rect x="${width * 0.055}" y="${height * 0.112}" width="${width * 0.013}"
        height="${height * 0.066}" rx="${height * 0.006}" fill="${p.accent}"/>
      <text x="${width * 0.092}" y="${height * 0.155}"
        font-family="${labelFont}" font-size="${titleSize}" font-weight="700"
        fill="${p.textOnDark}">${xml(effect.label)}</text>
    </g>`;
}

function matteHole(width, height, x, y, radius, opacity, style, extra = "") {
  return `
    <defs>
      <mask id="focus-hole">
        <rect width="${width}" height="${height}" fill="white"/>
        <circle cx="${x}" cy="${y}" r="${radius}" fill="black"/>
      </mask>
    </defs>
    <rect width="${width}" height="${height}" fill="${style.palette.darkSurface}"
      opacity="${opacity}" mask="url(#focus-hole)"/>
    <circle cx="${x}" cy="${y}" r="${radius}" fill="none"
      stroke="${style.palette.surface}" stroke-width="${Math.max(4, width * 0.008)}"/>
    ${extra}`;
}

function paperTexture(width, height, style, offset = 0) {
  const p = style.palette;
  return `
    <rect x="${-width * 0.08 + offset}" y="${height * 0.12}" width="${width * 1.16}"
      height="${height * 0.76}" rx="${width * 0.025}" fill="${p.canvas}"
      transform="rotate(-2 ${width / 2} ${height / 2})"/>
    <path d="M0 ${height * 0.19} Q ${width * 0.18} ${height * 0.15},
      ${width * 0.36} ${height * 0.19} T ${width * 0.72} ${height * 0.19}
      T ${width * 1.08} ${height * 0.19}"
      fill="none" stroke="${p.accentSecondary}" stroke-width="${width * 0.01}"
      stroke-dasharray="${width * 0.028} ${width * 0.018}" opacity="0.48"/>
    <g opacity="0.18" stroke="${p.inkSecondary}" stroke-width="1">
      ${Array.from({ length: 17 }, (_, index) => (
        `<line x1="${width * 0.06}" y1="${height * (0.27 + index * 0.026)}"
          x2="${width * 0.94}" y2="${height * (0.27 + index * 0.026)}"/>`
      )).join("")}
    </g>`;
}

function parallelOverlay(effect, p, width, height, style, entry, payload = null) {
  const palette = style.palette;
  const bodyFont = xml(style.typography.body.families.join(","));
  const displayFont = xml(style.typography.display.families.join(","));
  const fontSize = width * 0.052;
  const labels = displayItems(
    payload,
    ["第一项", "第二项", "第三项", "第四项", "第五项"],
  );
  while (labels.length < 5) labels.push(`第${labels.length + 1}项`);
  const visible = Math.max(1, Math.ceil(entry * 5));
  const cards = [];
  if (effect.id === "parallel_curved_wall") {
    const positions = [
      [0.05, 0.31, 0.16, -8],
      [0.22, 0.25, 0.18, -4],
      [0.41, 0.20, 0.2, 0],
      [0.62, 0.25, 0.18, 4],
      [0.8, 0.31, 0.16, 8],
    ];
    positions.forEach(([x, y, w, angle], index) => {
      const local = easeOut((entry - index * 0.11) / 0.45);
      cards.push(`<g opacity="${local}" transform="rotate(${angle} ${width * (x + w / 2)} ${height * (y + 0.15)})">
        <rect x="${width * x}" y="${height * (y + (1 - local) * 0.09)}"
          width="${width * w}" height="${height * 0.31}" rx="${width * 0.018}"
          fill="${index === 2 ? palette.accent : palette.surface}"
          stroke="${palette.ink}" stroke-width="${width * 0.004}"/>
        <text x="${width * (x + w / 2)}" y="${height * (y + 0.18)}"
          text-anchor="middle" font-family="${bodyFont}" font-size="${width * 0.04}"
          font-weight="700" fill="${palette.ink}">${index + 1}</text>
      </g>`);
    });
  } else if (effect.id === "parallel_progressive_row") {
    const landscape = width > height;
    const pixelEditorial = style.visualLanguageId === "xingzhe-pixel-editorial";
    const itemCues = displayItemCues(
      payload,
      ["第一项", "第二项", "第三项"],
    ).slice(0, 3);
    const activeIndex = itemCues.reduce(
      (latest, cue, index) => (p >= cue.revealAt ? index : latest),
      -1,
    );
    itemCues.forEach(({ text: label, revealAt }, index) => {
      const smoothLocal = easeOut((p - revealAt) / 0.075);
      const local = pixelEditorial
        ? Math.min(1, Math.floor(smoothLocal * 4) / 4)
        : smoothLocal;
      const cardX = landscape ? 0.715 : 0.08;
      const cardY = landscape ? 0.34 + index * 0.14 : 0.56 + index * 0.105;
      const cardWidth = landscape ? 0.245 : 0.84;
      const cardHeight = landscape ? 0.105 : 0.09;
      const labelSize = fittedFontSize(
        label,
        width * (landscape ? 0.029 : 0.052),
        width * cardWidth * 0.86,
        width * (landscape ? 0.019 : 0.03),
      );
      const active = index === activeIndex;
      cards.push(`<g opacity="${local}" transform="translate(${(1 - local) * width * 0.035} 0)"
        filter="url(#progressive-soft-shadow)">
        <rect x="${width * cardX}" y="${height * cardY}"
          width="${width * cardWidth}" height="${height * cardHeight}"
          rx="${pixelEditorial ? 0 : width * 0.014}"
          fill="${active ? rgba(palette.accent, 0.94) : rgba(palette.surface, 0.9)}"
          stroke="${rgba(active ? palette.accentSecondary : palette.inkSecondary, 0.46)}"
          stroke-width="${Math.max(1, width * 0.0007)}"/>
        ${pixelEditorial ? `
          <rect x="${width * (cardX - 0.025)}" y="${height * (cardY + 0.015)}"
            width="${width * 0.014}" height="${width * 0.014}"
            fill="${active ? palette.accent : palette.accentSecondary}"/>
          <rect x="${width * (cardX - 0.025)}" y="${height * (cardY + 0.056)}"
            width="${width * 0.009}" height="${width * 0.009}"
            fill="${palette.ink}"/>` : ""}
        <text x="${width * (cardX + cardWidth / 2)}" y="${height * (cardY + cardHeight * 0.67)}"
          text-anchor="middle" font-family="${displayFont}" font-size="${labelSize}"
          font-weight="800" fill="${palette.ink}">${xml(label)}</text>
      </g>`);
    });
    cards.unshift(`<defs>
      <filter id="progressive-soft-shadow" x="-20%" y="-25%" width="140%" height="160%">
        <feDropShadow dx="0" dy="${height * 0.009}" stdDeviation="${width * 0.004}"
          flood-color="${palette.ink}" flood-opacity="0.18"/>
      </filter>
    </defs>`);
  } else if (effect.id === "parallel_orbit_labels") {
    const positions = [[0.17, 0.37], [0.66, 0.34], [0.61, 0.63]];
    cards.push(`<circle cx="${width * 0.44}" cy="${height * 0.49}" r="${width * 0.19}"
      fill="none" stroke="${palette.surface}" stroke-width="${width * 0.008}"
      opacity="${entry}"/>`);
    positions.forEach(([x, y], index) => {
      const local = easeOut((entry - index * 0.15) / 0.5);
      cards.push(`<g opacity="${local}">
        <rect x="${width * x}" y="${height * y}" width="${width * 0.24}"
          height="${height * 0.062}" rx="${height * 0.031}" fill="${palette.accent}"/>
        <text x="${width * (x + 0.12)}" y="${height * (y + 0.041)}"
          text-anchor="middle" font-family="${bodyFont}" font-size="${fontSize * 0.65}"
          font-weight="700" fill="${palette.ink}">${labels[index]}</text>
      </g>`);
    });
  } else if (effect.id === "parallel_alternating_columns") {
    labels.slice(0, 4).forEach((label, index) => {
      const local = easeOut((entry - index * 0.13) / 0.5);
      const left = index % 2 === 0;
      cards.push(`<g opacity="${local}">
        <rect x="${width * (left ? 0.06 : 0.57)}" y="${height * (0.25 + index * 0.125)}"
          width="${width * 0.37}" height="${height * 0.088}" rx="${width * 0.018}"
          fill="${index === visible - 1 ? palette.accent : palette.surface}"
          stroke="${palette.inkSecondary}" stroke-width="${width * 0.003}"/>
        <text x="${width * (left ? 0.245 : 0.755)}" y="${height * (0.306 + index * 0.125)}"
          text-anchor="middle" font-family="${bodyFont}" font-size="${fontSize * 0.68}"
          font-weight="700" fill="${palette.ink}">${label}</text>
      </g>`);
    });
  } else if (effect.id === "parallel_filmstrip") {
    cards.push(`<rect x="${width * 0.03}" y="${height * 0.38}" width="${width * 0.94}"
      height="${height * 0.32}" rx="${width * 0.018}" fill="${rgba(palette.darkSurface, 0.88)}"/>
      <path d="M${width * 0.03} ${height * 0.405} H${width * 0.97}
        M${width * 0.03} ${height * 0.675} H${width * 0.97}"
        stroke="${palette.surface}" stroke-width="${width * 0.009}"
        stroke-dasharray="${width * 0.03} ${width * 0.02}"/>`);
  } else if (effect.id === "parallel_bubble_cluster") {
    const positions = [[0.13, 0.31, 0.16], [0.63, 0.3, 0.2], [0.1, 0.59, 0.2], [0.64, 0.6, 0.16]];
    positions.forEach(([x, y, r], index) => {
      const local = easeOut((entry - index * 0.12) / 0.48);
      const rr = width * r * (0.82 + local * 0.18);
      cards.push(`<g opacity="${local}">
        <circle cx="${width * x + rr}" cy="${height * y}" r="${rr}"
          fill="${index === visible - 1 ? palette.accent : palette.surface}"
          stroke="${palette.ink}" stroke-width="${width * 0.005}"/>
        <text x="${width * x + rr}" y="${height * y + fontSize * 0.22}"
          text-anchor="middle" font-family="${bodyFont}" font-size="${fontSize * 0.58}"
          font-weight="700" fill="${palette.ink}">${index + 1}</text>
      </g>`);
    });
  } else if (effect.id === "parallel_ribbon_staircase") {
    labels.slice(0, 4).forEach((label, index) => {
      const local = easeOut((entry - index * 0.13) / 0.45);
      const x = width * (0.07 + index * 0.08);
      const y = height * (0.3 + index * 0.115);
      const ww = width * (0.54 + index * 0.06) * local;
      cards.push(`<g opacity="${local}">
        <path d="M${x} ${y} H${x + ww} L${x + ww + width * 0.06} ${y + height * 0.045}
          L${x + ww} ${y + height * 0.09} H${x} Z"
          fill="${index % 2 ? palette.accentSecondary : palette.accent}"/>
        <text x="${x + width * 0.05}" y="${y + height * 0.06}"
          font-family="${bodyFont}" font-size="${fontSize * 0.63}" font-weight="700"
          fill="${palette.textOnAccent}">${label}</text>
      </g>`);
    });
  } else if (effect.id === "parallel_full_bleed_bands") {
    [palette.accent, palette.accentSecondary, palette.surface].forEach((color, index) => {
      const local = easeOut((entry - index * 0.15) / 0.5);
      cards.push(`<g opacity="${local}">
        <rect x="0" y="${height * (0.2 + index * 0.22)}" width="${width * local}"
          height="${height * 0.22}" fill="${color}"/>
        <text x="${width * 0.08}" y="${height * (0.335 + index * 0.22)}"
          font-family="${displayFont}" font-size="${fontSize * 1.12}" font-weight="800"
          fill="${index === 2 ? palette.ink : palette.textOnAccent}">${labels[index]}</text>
      </g>`);
    });
  } else {
    labels.slice(0, 3).forEach((label, index) => {
      const local = easeOut((entry - index * 0.17) / 0.48);
      const angle = [-6, 4, -2][index];
      const x = width * (0.12 + index * 0.08);
      const y = height * (0.28 + index * 0.13);
      cards.push(`<g opacity="${local}" transform="rotate(${angle} ${width / 2} ${y + height * 0.09})">
        <rect x="${x}" y="${y + (1 - local) * height * 0.06}" width="${width * 0.68}"
          height="${height * 0.18}" rx="${width * 0.02}" fill="${palette.surface}"
          stroke="${palette.ink}" stroke-width="${width * 0.004}"/>
        <rect x="${x}" y="${y}" width="${width * 0.06}" height="${height * 0.18}"
          fill="${index === 1 ? palette.accentSecondary : palette.accent}"/>
        <text x="${x + width * 0.1}" y="${y + height * 0.105}"
          font-family="${bodyFont}" font-size="${fontSize * 0.78}" font-weight="700"
          fill="${palette.ink}">${label}</text>
      </g>`);
    });
  }
  return cards.join("");
}

function overlaySvg(
  effect,
  frame,
  frames,
  width,
  height,
  style,
  payload = null,
  demo = true,
) {
  const progress = frames <= 1 ? 1 : frame / (frames - 1);
  const entry = easeOut(progress / 0.28);
  const exit = progress < 0.78 ? 1 : 1 - easeInOut((progress - 0.78) / 0.22);
  const alpha = clamp(entry * exit);
  const palette = style.palette;
  const displayFont = xml(style.typography.display.families.join(","));
  const bodyFont = xml(style.typography.body.families.join(","));
  const displaySize = width * 0.115;
  const bodySize = width * 0.052;
  const label = effect.label.replace(/开场|关键帧|并列句/g, "").slice(0, 9);
  const title = displayText(payload, "title", label, 12);
  const subtitle = displayText(payload, "subtitle", effect.function, 24);
  const items = displayItems(payload, ["观点 A", "观点 B", "观点 C"]);
  let content = "";

  switch (effect.renderer) {
    case "shape_matte": {
      const stage = Math.min(3, Math.floor(progress * 4));
      const radius = [width * 0.16, width * 0.28, width * 0.21, width * 0.38][stage];
      const cy = height * 0.44;
      if (stage === 0) {
        content = `<rect width="${width}" height="${height}" fill="${palette.darkSurface}" opacity="0.72"/>
          <rect x="${width * 0.18}" y="${height * 0.23}" width="${width * 0.64}"
            height="${height * 0.43}" rx="${width * 0.025}" fill="none"
            stroke="${palette.surface}" stroke-width="${width * 0.012}"/>`;
      } else {
        content = matteHole(
          width,
          height,
          width * 0.5,
          cy,
          radius,
          0.72,
          style,
          `<text x="${width * 0.5}" y="${height * 0.19}" text-anchor="middle"
            font-family="${displayFont}" font-size="${displaySize * 0.65}" font-weight="800"
            fill="${palette.accent}">${xml(title)}</text>`,
        );
      }
      break;
    }
    case "spotlight": {
      const route = effect.id === "space_focus_route" || effect.id === "keyframe_mask_follow";
      const x = route
        ? width * (0.34 + 0.24 * easeInOut(progress))
        : width * 0.5;
      const y = route
        ? height * (0.38 + 0.13 * Math.sin(progress * Math.PI))
        : height * 0.41;
      content = matteHole(
        width,
        height,
        x,
        y,
        width * (0.19 + entry * 0.03),
        0.68 * alpha,
        style,
        `<path d="M${x - width * 0.16} ${y + width * 0.24}
          Q ${x} ${y + width * 0.3} ${x + width * 0.16} ${y + width * 0.24}"
          fill="none" stroke="${palette.accent}" stroke-width="${width * 0.009}"
          stroke-dasharray="${width * 0.02} ${width * 0.015}"/>`,
      );
      break;
    }
    case "subject_layer": {
      if (effect.id === "hook_title_behind_subject") {
        const pixelEditorial = style.visualLanguageId === "xingzhe-pixel-editorial";
        const requestedPhrases = displayItems(payload, []);
        const hookPhrases = [];
        let remainingCharacters = 7;
        for (const requestedPhrase of requestedPhrases.length > 0 ? requestedPhrases : [title]) {
          if (remainingCharacters <= 0 || hookPhrases.length >= 2) break;
          const phrase = [...requestedPhrase].slice(0, Math.min(4, remainingCharacters)).join("");
          if (!phrase) continue;
          hookPhrases.push(phrase);
          remainingCharacters -= [...phrase].length;
        }
        const phrases = hookPhrases.length > 0 ? hookPhrases : ["旅行"];
        const phraseFontSize = Math.round(width * 0.078);
        const phrasePositions = phrases.length === 1
          ? [{ x: width * 0.28, anchor: "middle" }]
          : [
              { x: width * 0.33, anchor: "middle" },
              { x: width * 0.685, anchor: "middle" },
            ];
        const phraseNodes = phrases.map((phrase, index) => {
          const localEntry = easeOut((progress - index * 0.08) / 0.24);
          const localAlpha = clamp(localEntry * exit);
          const scale = 0.82 + 0.18 * localEntry;
          const position = phrasePositions[index] ?? phrasePositions[0];
          const fill = index === 1 ? "url(#hook-blue-gradient)" : "url(#hook-warm-gradient)";
          return `<g opacity="${localAlpha}" transform="translate(${position.x} ${height * 0.45})
            scale(${scale}) translate(${-position.x} ${-height * 0.45})">
            <text x="${position.x}" y="${height * 0.49}" text-anchor="${position.anchor}"
              font-family="${displayFont}" font-size="${phraseFontSize}" font-weight="900"
              letter-spacing="${-phraseFontSize * 0.025}" fill="${fill}"
              filter="url(#hook-title-shadow)">${xml(phrase)}</text>
          </g>`;
        }).join("");
        content = `<defs>
          <linearGradient id="hook-warm-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#FF8A3D"/>
            <stop offset="100%" stop-color="#F0445A"/>
          </linearGradient>
          <linearGradient id="hook-blue-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#8ED8FF"/>
            <stop offset="100%" stop-color="#3379D7"/>
          </linearGradient>
          <filter id="hook-title-shadow" x="-20%" y="-25%" width="140%" height="160%">
            <feDropShadow dx="0" dy="${height * 0.008}" stdDeviation="${width * 0.004}"
              flood-color="${palette.ink}" flood-opacity="0.42"/>
          </filter>
        </defs>
        ${pixelEditorial ? `<g opacity="${alpha * 0.78}">
          ${[0, 1, 2, 3].map((index) => `<rect
            x="${width * (0.205 + index * 0.018)}" y="${height * 0.315}"
            width="${width * 0.011}" height="${width * 0.011}"
            fill="${index < 3 ? palette.accent : palette.accentSecondary}"/>`).join("")}
          ${[0, 1, 2].map((index) => `<rect
            x="${width * (0.758 + index * 0.018)}" y="${height * 0.59}"
            width="${width * 0.011}" height="${width * 0.011}"
            fill="${index === 2 ? palette.accent : palette.accentSecondary}"/>`).join("")}
        </g>` : ""}
        ${phraseNodes}`;
      } else if (effect.id === "space_frame_between_layers") {
        const dx = (1 - entry) * width * 0.12;
        const frameRadius = style.visualLanguageId === "xingzhe-pixel-editorial" ? 0 : width * 0.03;
        content = `<rect x="${width * 0.13 + dx}" y="${height * 0.17}" width="${width * 0.72}"
          height="${height * 0.61}" rx="${frameRadius}" fill="${palette.accent}"
          transform="rotate(-4 ${width / 2} ${height / 2})" opacity="${alpha}"/>
          <rect x="${width * 0.17 - dx}" y="${height * 0.2}" width="${width * 0.68}"
          height="${height * 0.58}" rx="${frameRadius}" fill="none"
          stroke="${palette.surface}" stroke-width="${width * 0.014}"
          transform="rotate(3 ${width / 2} ${height / 2})" opacity="${alpha}"/>`;
      } else {
        content = `<g opacity="${alpha}">
          <rect x="${width * 0.08}" y="${height * 0.27}" width="${width * 0.38}"
            height="${height * 0.16}" rx="${width * 0.025}" fill="${palette.surface}"/>
          <text x="${width * 0.12}" y="${height * 0.34}" font-family="${bodyFont}"
            font-size="${bodySize}" font-weight="700" fill="${palette.ink}">${xml(title)}</text>
          <path d="M${width * 0.45} ${height * 0.36} H${width * 0.66}"
            stroke="${palette.accent}" stroke-width="${width * 0.014}"/>
        </g>`;
      }
      break;
    }
    case "text_then_reveal": {
      if (style.visualLanguageId === "xingzhe-pixel-editorial") {
        const typeProgress = easeOut(progress / 0.3);
        const shown = Math.max(1, Math.ceil(typeProgress * Math.max(1, title.length)));
        const text = title.slice(0, shown);
        const fullCoverUntil = clamp(Number(payload?.motion?.fullCoverUntil ?? 0.26), 0.08, 0.4);
        const revealDuration = clamp(Number(payload?.motion?.revealDuration ?? 0.48), 0.24, 0.7);
        const reveal = easeOut((progress - fullCoverUntil) / revealDuration);
        const titleAlpha = clamp((progress < 0.76 ? 1 : 1 - easeInOut((progress - 0.76) / 0.2)) * entry);
        // The first frame is a true full-cover state. A non-zero minimum hole
        // exposes an arbitrary part of the face before the reveal has begun.
        const windowWidth = reveal <= 0 ? 0 : width * (0.46 + reveal * 0.54);
        const windowHeight = reveal <= 0 ? 0 : height * (0.58 + reveal * 0.42);
        const windowX = (width - windowWidth) / 2;
        const windowY = height * 0.43 - windowHeight * 0.43;
        const pixelSize = Math.max(8, Math.round(width * 0.012));
        const accentItems = items.slice(0, 3);
        content = `<defs>
          <linearGradient id="pixel-hook-title" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#FF933E"/>
            <stop offset="58%" stop-color="#F05A3F"/>
            <stop offset="100%" stop-color="#E43E64"/>
          </linearGradient>
          <mask id="pixel-hook-reveal">
            <rect width="${width}" height="${height}" fill="white"/>
            <rect x="${windowX}" y="${windowY}" width="${windowWidth}" height="${windowHeight}" fill="black"/>
            ${Array.from({ length: 10 }, (_, index) => {
              const column = index % 5;
              const row = Math.floor(index / 5);
              const local = easeOut((reveal - index * 0.028) / 0.72);
              const block = pixelSize * (1 + (index % 3));
              const x = width * (0.1 + column * 0.2) - block / 2;
              const y = height * (0.18 + row * 0.48) - block / 2;
              return `<rect x="${x}" y="${y}" width="${block * local}" height="${block * local}" fill="black"/>`;
            }).join("")}
          </mask>
          <filter id="pixel-hook-shadow" x="-20%" y="-30%" width="140%" height="170%">
            <feDropShadow dx="0" dy="${height * 0.008}" stdDeviation="${width * 0.004}"
              flood-color="#111827" flood-opacity="0.48"/>
          </filter>
        </defs>
        <rect width="${width}" height="${height}" fill="${palette.darkSurface}" opacity="${1 - reveal * 0.48}"
          mask="url(#pixel-hook-reveal)"/>
        <g opacity="${titleAlpha}" filter="url(#pixel-hook-shadow)">
          <text x="${width * 0.5}" y="${height * 0.2}" text-anchor="middle"
            font-family="${displayFont}" font-size="${displaySize * 0.66}" font-weight="900"
            letter-spacing="${-displaySize * 0.025}" fill="url(#pixel-hook-title)">${xml(text)}${progress < 0.3 && frame % 10 < 6 ? "▌" : ""}</text>
          <rect x="${width * 0.32}" y="${height * 0.226}" width="${width * 0.36 * typeProgress}"
            height="${Math.max(3, height * 0.006)}" fill="${palette.accentSecondary}"/>
        </g>
        <g opacity="${clamp(reveal * exit)}">
          ${accentItems.map((item, index) => {
            const local = easeOut((reveal - index * 0.16) / 0.54);
            const x = width * (0.15 + index * 0.25);
            return `<g opacity="${local}">
              <rect x="${x}" y="${height * 0.7}" width="${pixelSize * 0.72}" height="${pixelSize * 0.72}"
                fill="${index === 1 ? palette.accentSecondary : palette.accent}"/>
              <text x="${x + pixelSize * 1.3}" y="${height * 0.714}" font-family="${bodyFont}"
                font-size="${bodySize * 0.46}" font-weight="700" fill="${palette.surface}">${xml(item)}</text>
            </g>`;
          }).join("")}
        </g>`;
        break;
      }
      const shown = Math.max(1, Math.floor(entry * Math.max(1, title.length)));
      const text = title.slice(0, shown);
      const reveal = easeOut((progress - 0.48) / 0.3);
      content = `<rect width="${width}" height="${height}" fill="${palette.darkSurface}"
          opacity="${Math.max(0, 1 - reveal * 0.94)}"/>
        <text x="${width * 0.5}" y="${height * 0.43}" text-anchor="middle"
          font-family="${displayFont}" font-size="${displaySize * 0.68}" font-weight="800"
          fill="${palette.surface}">${xml(text)}${frame % 10 < 6 ? "▌" : ""}</text>
        ${reveal > 0 ? matteHole(
          width,
          height,
          width * 0.5,
          height * 0.42,
          width * 0.34 * reveal,
          0.95,
          style,
        ) : ""}`;
      break;
    }
    case "shrink_stage": {
      const titleFontSize = fittedFontSize(
        title,
        displaySize * 0.7,
        width * 0.35,
        width * 0.035,
      );
      const subtitleFontSize = fittedFontSize(
        subtitle,
        bodySize,
        width * 0.35,
        width * 0.025,
      );
      content = `<g opacity="${alpha}">
        <text x="${width * 0.59}" y="${height * 0.35}" font-family="${displayFont}"
          font-size="${titleFontSize}" font-weight="900" fill="${palette.accent}">${xml(title)}</text>
        <text x="${width * 0.59}" y="${height * 0.43}" font-family="${bodyFont}"
          font-size="${subtitleFontSize}" font-weight="700" fill="${palette.surface}">${xml(subtitle)}</text>
      </g>`;
      break;
    }
    case "clone_layout": {
      content = `<g opacity="${alpha}">
        ${items.slice(0, 3).map((text, index) => `
          <rect x="${width * (0.08 + index * 0.3)}" y="${height * (0.66 - (index % 2) * 0.06)}"
            width="${width * 0.24}" height="${height * 0.07}" rx="${height * 0.035}"
            fill="${index === Math.min(2, Math.floor(entry * 3)) ? palette.accent : palette.surface}"/>
          <text x="${width * (0.2 + index * 0.3)}" y="${height * (0.706 - (index % 2) * 0.06)}"
            text-anchor="middle" font-family="${bodyFont}" font-size="${bodySize * 0.68}"
            font-weight="700" fill="${palette.ink}">${text}</text>`).join("")}
      </g>`;
      break;
    }
    case "evidence_card": {
      const landscape = width > height;
      const x = landscape
        ? width * (0.705 + (1 - entry) * 0.16)
        : width * (0.1 + (1 - entry) * 0.32);
      const y = landscape ? height * 0.51 : height * 0.19;
      const cardWidth = landscape ? width * 0.265 : width * 0.8;
      const cardHeight = landscape ? height * 0.34 : height * 0.52;
      const insetX = landscape ? width * 0.018 : width * 0.05;
      const insetY = landscape ? height * 0.045 : height * 0.06;
      const insetWidth = landscape ? width * 0.229 : width * 0.7;
      const insetHeight = landscape ? height * 0.15 : height * 0.25;
      const titleFontSize = fittedFontSize(
        title,
        displaySize * (landscape ? 0.28 : 0.52),
        insetWidth,
        width * (landscape ? 0.018 : 0.035),
      );
      const subtitleFontSize = fittedFontSize(
        subtitle,
        bodySize * (landscape ? 0.42 : 0.72),
        insetWidth,
        width * (landscape ? 0.014 : 0.024),
      );
      content = `<defs><filter id="evidence-soft-shadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="${height * 0.01}" stdDeviation="${width * 0.0045}"
            flood-color="${palette.ink}" flood-opacity="0.2"/>
        </filter></defs>
        <g opacity="${alpha}" filter="url(#evidence-soft-shadow)">
        <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}"
          rx="${width * 0.018}" fill="${rgba(palette.surface, 0.94)}"
          stroke="${rgba(palette.accentSecondary, 0.58)}"
          stroke-width="${Math.max(1, width * 0.0008)}"/>
        <rect x="${x + insetX}" y="${y + insetY}" width="${insetWidth}"
          height="${insetHeight}" rx="${width * 0.018}" fill="${palette.canvas}"/>
        <path d="M${x + insetX * 1.25} ${y + insetY + insetHeight * 0.82}
          L${x + insetX + insetWidth * 0.28} ${y + insetY + insetHeight * 0.28}
          L${x + insetX + insetWidth * 0.48} ${y + insetY + insetHeight * 0.66}
          L${x + insetX + insetWidth * 0.72} ${y + insetY + insetHeight * 0.22}
          L${x + insetX + insetWidth * 0.94} ${y + insetY + insetHeight * 0.82} Z"
          fill="${palette.accentSecondary}" opacity="0.72"/>
        <text x="${x + insetX}" y="${y + cardHeight * 0.73}" font-family="${displayFont}"
          font-size="${titleFontSize}" font-weight="800" fill="${palette.ink}">${xml(title)}</text>
        <text x="${x + insetX}" y="${y + cardHeight * 0.88}" font-family="${bodyFont}"
          font-size="${subtitleFontSize}" fill="${palette.inkSecondary}">${xml(subtitle)}</text>
      </g>`;
      break;
    }
    case "paper_stage": {
      content = `<g opacity="${alpha}">
        ${paperTexture(width, height, style, (1 - entry) * width * 0.18)}
        ${effect.id === "space_paper_demo_stage" ? `
          ${items.slice(0, 3).map((text, index) => `
            <g transform="rotate(${[-7, 2, 7][index]} ${width * (0.28 + index * 0.22)} ${height * 0.36})">
              <rect x="${width * (0.12 + index * 0.22)}" y="${height * (0.25 + index * 0.02)}"
                width="${width * 0.27}" height="${height * 0.21}" rx="${width * 0.015}"
                fill="${index === 1 ? palette.accent : palette.surface}"
                stroke="${palette.ink}" stroke-width="${width * 0.004}"/>
              <text x="${width * (0.255 + index * 0.22)}" y="${height * (0.38 + index * 0.02)}"
                text-anchor="middle" font-family="${displayFont}" font-size="${displaySize * 0.45}"
                font-weight="800" fill="${palette.ink}">${text}</text>
            </g>`).join("")}` : ""}
      </g>`;
      break;
    }
    case "arrow_overlay": {
      const arrows = [[0.12, 0.28, 0.38, 0.41], [0.86, 0.3, 0.62, 0.42], [0.15, 0.66, 0.37, 0.55]];
      content = arrows.map(([x1, y1, x2, y2], index) => {
        const local = easeOut((entry - index * 0.14) / 0.5);
        return `<g opacity="${local}">
          <path d="M${width * x1} ${height * y1} Q${width * ((x1 + x2) / 2)}
            ${height * (Math.min(y1, y2) - 0.06)} ${width * x2} ${height * y2}"
            fill="none" stroke="${palette.accent}" stroke-width="${width * 0.018}"
            stroke-linecap="round"/>
          <path d="M${width * (x2 - 0.04)} ${height * (y2 - 0.015)}
            L${width * x2} ${height * y2} L${width * (x2 - 0.015)} ${height * (y2 - 0.045)}"
            fill="none" stroke="${palette.accent}" stroke-width="${width * 0.018}"
            stroke-linecap="round" stroke-linejoin="round"/>
        </g>`;
      }).join("");
      break;
    }
    case "nested_frames": {
      content = [0, 1, 2].map((index) => {
        const local = easeOut((entry - index * 0.16) / 0.5);
        return `<rect x="${width * (0.1 + index * 0.035)}"
          y="${height * (0.14 + index * 0.03)}" width="${width * (0.8 - index * 0.07)}"
          height="${height * (0.62 - index * 0.06)}" rx="${width * (0.03 - index * 0.004)}"
          fill="none" stroke="${[palette.accent, palette.surface, palette.accentSecondary][index]}"
          stroke-width="${width * (0.015 - index * 0.003)}" opacity="${local}"/>`;
      }).join("");
      break;
    }
    case "doodle_orbit": {
      const cx = width * 0.5;
      const cy = height * 0.43;
      const r = width * 0.26;
      const circumference = 2 * Math.PI * r;
      content = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${palette.accent}" stroke-width="${width * 0.012}" stroke-linecap="round"
        stroke-dasharray="${circumference * entry} ${circumference}"/>
        ${Array.from({ length: 10 }, (_, index) => {
          const angle = (index / 10) * Math.PI * 2 + progress * 0.12;
          const x1 = cx + Math.cos(angle) * r * 1.08;
          const y1 = cy + Math.sin(angle) * r * 1.08;
          const x2 = cx + Math.cos(angle) * r * 1.25;
          const y2 = cy + Math.sin(angle) * r * 1.25;
          return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
            stroke="${index % 2 ? palette.surface : palette.accentSecondary}"
            stroke-width="${width * 0.01}" stroke-linecap="round" opacity="${alpha}"/>`;
        }).join("")}`;
      break;
    }
    case "depth_text": {
      const words = [
        [items[0] ?? title, 0.08, 0.32, -12, 1.2],
        [items[1] ?? "主体", 0.62, 0.43, 8, 0.9],
        [items[2] ?? "背景", 0.17, 0.67, -4, 0.7],
      ];
      content = words.map(([text, x, y, angle, scale], index) => {
        const local = easeOut((entry - index * 0.14) / 0.5);
        return `<text x="${width * x}" y="${height * y}" font-family="${displayFont}"
          font-size="${displaySize * scale}" font-weight="900"
          fill="${index === 0 ? palette.accent : palette.surface}"
          stroke="${palette.ink}" stroke-width="${width * 0.006}"
          paint-order="stroke" opacity="${local}"
          transform="rotate(${angle} ${width * x} ${height * y})">${text}</text>`;
      }).join("");
      break;
    }
    case "parallel_layout":
      content = parallelOverlay(effect, progress, width, height, style, entry, payload);
      break;
    case "color_shift":
      content = `<g opacity="${alpha}">
        <rect x="${width * 0.08}" y="${height * 0.2}" width="${width * 0.84}"
          height="${height * 0.5}" rx="${width * 0.03}" fill="none"
          stroke="${palette.accent}" stroke-width="${width * 0.012}"/>
        <text x="${width * 0.5}" y="${height * 0.26}" text-anchor="middle"
          font-family="${bodyFont}" font-size="${bodySize}" font-weight="700"
          fill="${palette.surface}">${xml(title)}</text>
      </g>`;
      break;
    default: {
      const landscape = width > height;
      const localScale = 0.78 + entry * 0.22;
      const titleX = width * (landscape ? 0.22 : 0.5);
      const titleY = height * (landscape ? 0.2 : 0.25);
      const lineLeft = width * (landscape ? 0.08 : 0.25);
      const lineRight = width * (landscape ? 0.36 : 0.75);
      const lineY = height * (landscape ? 0.24 : 0.29);
      const titleSize = fittedFontSize(
        title,
        displaySize * (landscape ? 0.54 : 0.72),
        width * (landscape ? 0.34 : 0.5),
        width * 0.025,
      );
      content = `<defs><filter id="title-soft-shadow" x="-20%" y="-30%" width="140%" height="170%">
          <feDropShadow dx="0" dy="${height * 0.009}" stdDeviation="${width * 0.004}"
            flood-color="${palette.ink}" flood-opacity="0.38"/>
        </filter></defs>
        <g opacity="${alpha}" transform="translate(${titleX} ${titleY})
        scale(${localScale}) translate(${-titleX} ${-titleY})">
        <text x="${titleX}" y="${titleY}" text-anchor="middle"
          font-family="${displayFont}" font-size="${titleSize}" font-weight="900"
          fill="${palette.accent}" filter="url(#title-soft-shadow)">${xml(title)}</text>
        <path d="M${lineLeft} ${lineY} H${lineRight}"
          stroke="${palette.surface}" stroke-width="${Math.max(2, width * 0.0016)}"/>
      </g>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
    viewBox="0 0 ${width} ${height}">
    ${content}
    ${demo ? commonOverlay(effect, width, height, style, alpha) : ""}
  </svg>`;
}

function renderOverlayFrames(
  effect,
  frames,
  width,
  height,
  style,
  directory,
  payload = null,
  demo = true,
) {
  fs.mkdirSync(directory, { recursive: true });
  for (let frame = 0; frame < frames; frame += 1) {
    const stem = String(frame).padStart(5, "0");
    const svg = path.join(directory, `${stem}.svg`);
    const png = path.join(directory, `${stem}.png`);
    fs.writeFileSync(
      svg,
      overlaySvg(effect, frame, frames, width, height, style, payload, demo),
    );
    mustRun("rsvg-convert", ["-o", png, svg]);
    fs.unlinkSync(svg);
  }
}

function zoomFilter(width, height, fps, frames, amount) {
  const denominator = Math.max(1, frames - 1);
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,`
    + `crop=${width}:${height},setsar=1,`
    + `zoompan=z='1+${amount}*(3*(on/${denominator})^2-2*(on/${denominator})^3)':`
    + `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:`
    + `s=${width}x${height}:fps=${fps}`;
}

function clonePlacements(effectId, width, height) {
  if (effectId === "parallel_curved_wall") {
    return [
      [Math.round(width * 0.05), Math.round(height * 0.34), Math.round(width * 0.15), Math.round(height * 0.27)],
      [Math.round(width * 0.22), Math.round(height * 0.29), Math.round(width * 0.18), Math.round(height * 0.32)],
      [Math.round(width * 0.41), Math.round(height * 0.25), Math.round(width * 0.2), Math.round(height * 0.36)],
      [Math.round(width * 0.62), Math.round(height * 0.29), Math.round(width * 0.18), Math.round(height * 0.32)],
      [Math.round(width * 0.8), Math.round(height * 0.34), Math.round(width * 0.15), Math.round(height * 0.27)],
    ];
  }
  if (effectId === "parallel_filmstrip") {
    return [
      [Math.round(width * 0.045), Math.round(height * 0.41), Math.round(width * 0.27), Math.round(height * 0.24)],
      [Math.round(width * 0.365), Math.round(height * 0.41), Math.round(width * 0.27), Math.round(height * 0.24)],
      [Math.round(width * 0.685), Math.round(height * 0.41), Math.round(width * 0.27), Math.round(height * 0.24)],
    ];
  }
  if (effectId === "parallel_alternating_columns") {
    return [
      [Math.round(width * 0.08), Math.round(height * 0.23), Math.round(width * 0.22), Math.round(height * 0.26)],
      [Math.round(width * 0.7), Math.round(height * 0.4), Math.round(width * 0.22), Math.round(height * 0.26)],
      [Math.round(width * 0.08), Math.round(height * 0.57), Math.round(width * 0.22), Math.round(height * 0.26)],
    ];
  }
  return [
    [Math.round(width * 0.08), Math.round(height * 0.34), Math.round(width * 0.22), Math.round(height * 0.31)],
    [Math.round(width * 0.39), Math.round(height * 0.27), Math.round(width * 0.22), Math.round(height * 0.31)],
    [Math.round(width * 0.7), Math.round(height * 0.34), Math.round(width * 0.22), Math.round(height * 0.31)],
  ];
}

function buildVisualFilter(
  effect,
  width,
  height,
  fps,
  frames,
  hasMask,
  hasAsset = false,
  assetInputIndex = 2,
) {
  const base = `scale=${width}:${height}:force_original_aspect_ratio=increase,`
    + `crop=${width}:${height},setsar=1,fps=${fps}`;
  if (effect.id === "semantic_evidence_insert" && hasAsset) {
    const landscape = width > height;
    const assetWidth = Math.round(width * (landscape ? 0.229 : 0.7));
    const assetHeight = Math.round(height * (landscape ? 0.15 : 0.25));
    const assetX = Math.round(width * (landscape ? 0.723 : 0.15));
    const assetY = Math.round(height * (landscape ? 0.555 : 0.25));
    return `[0:v]${base},format=yuv420p[base];`
      + `[1:v]format=rgba[ov];[base][ov]overlay=0:0:shortest=1[mid];`
      + `[${assetInputIndex}:v]scale=${assetWidth}:${assetHeight}:`
      + `force_original_aspect_ratio=increase,crop=${assetWidth}:${assetHeight},`
      + `fps=${fps},setsar=1[asset];`
      + `[mid][asset]overlay=${assetX}:${assetY}:shortest=1,format=yuv420p[outv]`;
  }
  if (["hook_suspense_push", "semantic_importance_zoom", "keyframe_scale"].includes(effect.id)) {
    const amount = effect.id === "keyframe_scale" ? 0.18 : effect.id === "semantic_importance_zoom" ? 0.14 : 0.09;
    return `[0:v]${zoomFilter(width, height, fps, frames, amount)},format=yuv420p[base];`
      + `[1:v]format=rgba[ov];[base][ov]overlay=0:0:shortest=1,format=yuv420p[outv]`;
  }
  if (effect.id === "semantic_negative_shrink") {
    return `[0:v]${base},split=2[bg0][fg0];`
      + `[bg0]boxblur=18:2,eq=brightness=-0.12[bg];`
      + `[fg0]scale=${Math.round(width * 0.48)}:${Math.round(height * 0.48)}[fg];`
      + `[bg][fg]overlay=x='(W-w)/2-W*0.28*(3*(min(t/0.55,1))^2-2*(min(t/0.55,1))^3)':`
      + `y='(H-h)/2+H*0.1':shortest=1[mid];`
      + `[1:v]format=rgba[ov];[mid][ov]overlay=0:0:shortest=1,format=yuv420p[outv]`;
  }
  if (effect.id === "keyframe_color") {
    return `[0:v]${base},eq=saturation='1+0.42*(3*(min(n/${Math.max(1, frames - 1)},1))^2`
      + `-2*(min(n/${Math.max(1, frames - 1)},1))^3)':brightness=0.018:eval=frame[base];`
      + `[1:v]format=rgba[ov];[base][ov]overlay=0:0:shortest=1,format=yuv420p[outv]`;
  }
  const cloneIds = new Set([
    "semantic_viewpoint_clones",
    "parallel_curved_wall",
    "parallel_alternating_columns",
    "parallel_filmstrip",
  ]);
  if (cloneIds.has(effect.id)) {
    const placements = clonePlacements(effect.id, width, height);
    const splitOutputs = ["base0", ...placements.map((_, index) => `clone${index}`)];
    const parts = [
      `[0:v]${base},split=${splitOutputs.length}${splitOutputs.map((name) => `[${name}]`).join("")}`,
      `[base0]boxblur=12:1,eq=brightness=-0.14[stage0]`,
    ];
    placements.forEach(([, , w, h], index) => {
      parts.push(`[clone${index}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[c${index}]`);
    });
    placements.forEach(([x, y], index) => {
      const input = index === 0 ? "stage0" : `stage${index}`;
      const output = `stage${index + 1}`;
      parts.push(`[${input}][c${index}]overlay=${x}:${y}:shortest=1[${output}]`);
    });
    parts.push(`[1:v]format=rgba[ov]`);
    parts.push(`[stage${placements.length}][ov]overlay=0:0:shortest=1,format=yuv420p[outv]`);
    return parts.join(";");
  }
  const subjectIds = new Set([
    "hook_title_behind_subject",
    "semantic_keyframe_reposition",
    "space_frame_between_layers",
    "space_paper_demo_stage",
    "sticker_torn_paper_stage",
    "keyframe_position",
  ]);
  if (subjectIds.has(effect.id) && hasMask) {
    const move = ["semantic_keyframe_reposition", "keyframe_position"].includes(effect.id);
    const paper = ["space_paper_demo_stage", "sticker_torn_paper_stage"].includes(effect.id);
    const parts = [
      `[0:v]${base},split=2[base0][fg0]`,
      `[2:v]scale=${width}:${height},fps=${fps},format=gray[mask0]`,
      `[fg0]format=rgba[fg1]`,
      `[fg1][mask0]alphamerge[cut0]`,
      `[1:v]format=rgba[ov]`,
      `[base0][ov]overlay=0:0:shortest=1[mid0]`,
    ];
    if (move) {
      parts.push(`[cut0]scale=${Math.round(width * 0.82)}:${Math.round(height * 0.82)}[cut1]`);
      parts.push(`[mid0][cut1]overlay=x='W*0.08+W*0.18*(3*(min(t/0.6,1))^2-2*(min(t/0.6,1))^3)':`
        + `y='H*0.16':shortest=1,format=yuv420p[outv]`);
    } else {
      parts.push(`[mid0][cut0]overlay=0:0:shortest=1,format=yuv420p[outv]`);
    }
    if (paper) {
      // The SVG overlay itself supplies the paper stage; the cutout remains foreground.
    }
    return parts.join(";");
  }
  return `[0:v]${base},format=yuv420p[base];[1:v]format=rgba[ov];`
    + `[base][ov]overlay=0:0:shortest=1,format=yuv420p[outv]`;
}

const sfxByTrigger = {
  hook: "01_hook/hook-fast-whoosh.wav",
  emphasis: "02_emphasis/emphasis-quick-zoom-hit.wav",
  motion: "14_motion/motion-small-sweep.wav",
  pop: "13_pop/pop-bubble-alert.wav",
  page: "18_page/page-turn.wav",
  info: "05_info/info-interface-select.wav",
  reversal: "07_reversal/reversal-vacuum-swoosh.wav",
  typing: "10_typing/typing-keyboard-full.wav",
  transition: "11_transition/transition-local.wav",
  turn: "04_turn/turn-vinyl-stop.wav",
};

function resolveSfx(effect, root) {
  if (!root) return null;
  const relative = sfxByTrigger[effect.soundTrigger];
  if (!relative) return null;
  const candidates = [
    path.resolve(root, "ready", relative),
    path.resolve(root, relative),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function renderClip({
  effect,
  input,
  mask,
  start,
  duration,
  output,
  style,
  sfxRoot,
  keepFrames = false,
  payload = null,
  demo = true,
  videoOnly = false,
  asset = null,
}) {
  const summary = mediaSummary(input);
  const width = summary.width;
  const height = summary.height;
  const fpsValue = Math.max(1, summary.averageFps || summary.declaredFps || summary.fps);
  const fps = summary.video?.avg_frame_rate
    && summary.video.avg_frame_rate !== "0/0"
    ? summary.video.avg_frame_rate
    : String(fpsValue);
  const frames = Math.max(12, Math.round(duration * fpsValue));
  const actualDuration = frames / fpsValue;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-netstyle-"));
  const overlays = path.join(temporary, "overlays");
  const visualOnlyFile = path.join(temporary, "visual.mp4");
  const finalOutput = path.resolve(output);
  try {
    renderOverlayFrames(
      effect,
      frames,
      width,
      height,
      style,
      overlays,
      payload,
      demo,
    );
    const hasMask = Boolean(mask && fs.existsSync(mask));
    const hasAsset = Boolean(asset && fs.existsSync(asset));
    const ffArgs = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-ss", start.toFixed(6), "-t", actualDuration.toFixed(6), "-i", input,
      "-framerate", String(fps), "-i", path.join(overlays, "%05d.png"),
    ];
    if (hasMask) {
      ffArgs.push("-ss", start.toFixed(6), "-t", actualDuration.toFixed(6), "-i", mask);
    }
    if (hasAsset) {
      const imageAsset = /\.(?:png|jpe?g|webp|bmp|tiff?)$/i.test(asset);
      if (imageAsset) {
        ffArgs.push(
          "-loop", "1", "-framerate", String(fps),
          "-t", actualDuration.toFixed(6), "-i", asset,
        );
      } else {
        ffArgs.push(
          "-stream_loop", "-1", "-t", actualDuration.toFixed(6), "-i", asset,
        );
      }
    }
    const assetInputIndex = 2 + (hasMask ? 1 : 0);
    const productionIntermediate = !demo && videoOnly;
    ffArgs.push(
      "-filter_complex",
      buildVisualFilter(
        effect,
        width,
        height,
        fps,
        frames,
        hasMask,
        hasAsset,
        assetInputIndex,
      ),
      "-map", "[outv]", "-an",
      "-frames:v", String(frames),
      "-r", String(fps),
      "-c:v", "libx264",
      "-preset", productionIntermediate ? "ultrafast" : "medium",
      "-crf", productionIntermediate ? "0" : "17",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      visualOnlyFile,
    );
    mustRun("ffmpeg", ffArgs);

    fs.mkdirSync(path.dirname(finalOutput), { recursive: true });
    if (videoOnly) {
      fs.copyFileSync(visualOnlyFile, finalOutput);
      const outputSummary = mediaSummary(finalOutput);
      return {
        effectId: effect.id,
        output: finalOutput,
        sha256: sha256File(finalOutput),
        width: outputSummary.width,
        height: outputSummary.height,
        fps: outputSummary.fps,
        duration: outputSummary.duration,
        requestedFrames: frames,
        maskUsed: hasMask,
        assetUsed: hasAsset ? path.resolve(asset) : null,
        sfx: null,
        mode: demo ? "demo" : "production",
        videoOnly: true,
      };
    }

    const sfx = resolveSfx(effect, sfxRoot);
    const audioArgs = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-ss", start.toFixed(6), "-t", actualDuration.toFixed(6), "-i", input,
      "-i", visualOnlyFile,
    ];
    let audioFilter;
    if (sfx) {
      audioArgs.push("-i", sfx);
      const delay = effect.soundTrigger === "typing"
        ? 0
        : Math.round(actualDuration * 0.22 * 1000);
      audioFilter = `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,`
        + `volume=0.72,afade=t=in:st=0:d=0.06,`
        + `afade=t=out:st=${Math.max(0, actualDuration - 0.12).toFixed(4)}:d=0.12,`
        + `apad,atrim=0:${actualDuration.toFixed(6)}[voice];`
        + `[2:a]aformat=sample_rates=48000:channel_layouts=stereo,`
        + `atrim=0:${actualDuration.toFixed(6)},adelay=${delay}|${delay},volume=0.32[sfx];`
        + `[voice][sfx]amix=inputs=2:normalize=0:dropout_transition=0,`
        + `alimiter=limit=0.88,atrim=0:${actualDuration.toFixed(6)}[outa]`;
    } else {
      audioFilter = `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,`
        + `volume=0.72,afade=t=in:st=0:d=0.06,`
        + `afade=t=out:st=${Math.max(0, actualDuration - 0.12).toFixed(4)}:d=0.12,`
        + `apad,atrim=0:${actualDuration.toFixed(6)}[outa]`;
    }
    audioArgs.push(
      "-filter_complex", audioFilter,
      "-map", "1:v:0", "-map", "[outa]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", actualDuration.toFixed(6), "-movflags", "+faststart",
      finalOutput,
    );
    mustRun("ffmpeg", audioArgs);
    if (keepFrames) {
      const evidenceDir = `${finalOutput}.frames`;
      fs.cpSync(overlays, evidenceDir, { recursive: true });
    }
    const outputSummary = mediaSummary(finalOutput);
    return {
      effectId: effect.id,
      output: finalOutput,
      sha256: sha256File(finalOutput),
      width: outputSummary.width,
      height: outputSummary.height,
      fps: outputSummary.fps,
      duration: outputSummary.duration,
      requestedFrames: frames,
      maskUsed: hasMask,
      assetUsed: hasAsset ? path.resolve(asset) : null,
      sfx: sfx ? path.relative(process.cwd(), sfx) : null,
      mode: demo ? "demo" : "production",
      videoOnly: false,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function validateRegistry(registry) {
  const errors = [];
  if (registry.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (registry.id !== "z-en-netstyle") errors.push("id 必须为 z-en-netstyle");
  if (!Array.isArray(registry.effects) || registry.effects.length !== 33) {
    errors.push(`必须注册 33 个参考手法，当前 ${registry.effects?.length ?? 0}`);
  }
  const ids = new Set();
  const allowedRenderers = new Set([
    "zoom_overlay",
    "shape_matte",
    "spotlight",
    "subject_layer",
    "text_then_reveal",
    "shrink_stage",
    "clone_layout",
    "evidence_card",
    "paper_stage",
    "arrow_overlay",
    "nested_frames",
    "doodle_orbit",
    "depth_text",
    "color_shift",
    "parallel_layout",
  ]);
  const required = [
    "id", "family", "label", "referenceVideo", "trigger", "function",
    "mechanism", "soundTrigger", "fallback", "failureModes", "qc", "renderer",
  ];
  for (const [index, effect] of (registry.effects ?? []).entries()) {
    for (const key of required) {
      if (
        effect[key] === undefined
        || effect[key] === null
        || effect[key] === ""
        || (Array.isArray(effect[key]) && effect[key].length === 0)
      ) {
        errors.push(`effects[${index}].${key} 缺失`);
      }
    }
    if (ids.has(effect.id)) errors.push(`effect id 重复：${effect.id}`);
    ids.add(effect.id);
    if (!allowedRenderers.has(effect.renderer)) {
      errors.push(`effects[${index}].renderer 未实现：${effect.renderer}`);
    }
    if (!/^\d{19}$/.test(String(effect.referenceVideo))) {
      errors.push(`effects[${index}].referenceVideo 格式错误`);
    }
  }
  const sourceVideos = new Set((registry.effects ?? []).map((effect) => effect.referenceVideo));
  if (sourceVideos.size !== 6) errors.push(`必须覆盖 6 条参考视频，当前 ${sourceVideos.size}`);
  return errors;
}

if (!["list", "validate", "preview", "showcase"].includes(action)) {
  fail(
    "用法：kacha_netstyle.mjs list|validate|preview|showcase "
      + "[--input FILE --effect ID --mask FILE --output FILE --sfx-root DIR] "
      + "[--visual-language ID --production --payload JSON --video-only]",
    2,
  );
}

const registry = readJson(registryFile);
const errors = validateRegistry(registry);
if (errors.length > 0) fail(errors.join("\n"));
const design = resolveDesignSystem({
  modes: {
    show: "tool-share",
    aspectRatio: "portrait-9x16",
    language: "zh",
    surface: "footage",
    density: "standard",
  },
});
const visualLanguageId = option("--visual-language");
let visualLanguage = null;
if (visualLanguageId) {
  const visualLanguagesFile = path.join(
    skillDirectory,
    "config",
    "design-system",
    "visual-languages.json",
  );
  const visualLanguages = readJson(visualLanguagesFile);
  visualLanguage = visualLanguages.languages?.[visualLanguageId] ?? null;
  if (!visualLanguage) fail(`视觉语言不存在：${visualLanguageId}`, 2);
}
const style = {
  ...design.style,
  visualLanguageId: visualLanguageId ?? null,
  visualLanguage,
};

if (action === "validate") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    registry: registry.id,
    effectCount: registry.effects.length,
    sourceVideoCount: new Set(registry.effects.map((effect) => effect.referenceVideo)).size,
    registrySha256: sha256File(registryFile),
    designSystemId: design.system.id,
    designSystemVersion: design.system.version,
    designDigest: design.digest,
    renderers: [...new Set(registry.effects.map((effect) => effect.renderer))].sort(),
  }, null, 2));
  process.exit(0);
}

if (action === "list") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    registry: registry.id,
    effects: registry.effects.map((effect) => ({
      id: effect.id,
      family: effect.family,
      label: effect.label,
      trigger: effect.trigger,
      renderer: effect.renderer,
      soundTrigger: effect.soundTrigger,
      fallback: effect.fallback,
    })),
  }, null, 2));
  process.exit(0);
}

const input = path.resolve(option("--input", ""));
const output = path.resolve(option("--output", ""));
const mask = option("--mask") ? path.resolve(option("--mask")) : null;
const asset = option("--asset") ? path.resolve(option("--asset")) : null;
const sfxRoot = option("--sfx-root") ? path.resolve(option("--sfx-root")) : null;
if (!fs.existsSync(input)) fail(`输入不存在：${input}`, 2);
if (!output || output === path.resolve("")) fail("--output 必填", 2);
if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖已有文件：${output}`, 2);
if (mask && !fs.existsSync(mask)) fail(`人物蒙版不存在：${mask}`, 2);
if (asset && !fs.existsSync(asset)) fail(`插入素材不存在：${asset}`, 2);

const inputSummary = mediaSummary(input);
if (!(inputSummary.width > 0 && inputSummary.height > 0 && inputSummary.duration > 0)) {
  fail("无法探测输入视频", 2);
}

if (action === "preview") {
  const effectId = option("--effect");
  const effect = registry.effects.find((item) => item.id === effectId);
  if (!effect) fail(`效果不存在：${effectId}`, 2);
  const duration = Number(option("--duration", registry.defaults.durationSeconds));
  const maxStart = Math.max(0, inputSummary.duration - duration - 0.02);
  const start = clamp(Number(option("--start", 0)), 0, maxStart);
  const production = has("--production");
  const payloadFile = option("--payload");
  if (production && !payloadFile) fail("--production 必须提供 --payload JSON", 2);
  if (payloadFile && !fs.existsSync(path.resolve(payloadFile))) {
    fail(`payload 不存在：${path.resolve(payloadFile)}`, 2);
  }
  const payload = payloadFile ? readJson(path.resolve(payloadFile)) : null;
  if (production) {
    const payloadErrors = productionPayloadErrors(effect, payload);
    if (payloadErrors.length > 0) fail(payloadErrors.join("\n"), 2);
  }
  const result = renderClip({
    effect,
    input,
    mask,
    start,
    duration,
    output,
    style,
    sfxRoot,
    keepFrames: has("--keep-frames"),
    payload,
    demo: !production,
    videoOnly: has("--video-only"),
    asset,
  });
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    registry: registry.id,
    designDigest: design.digest,
    visualLanguageId: style.visualLanguageId,
    result,
  }, null, 2));
  process.exit(0);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-netstyle-showcase-"));
try {
  const duration = Number(option("--duration", registry.defaults.durationSeconds));
  const maxEffects = Math.min(
    registry.effects.length,
    Math.max(1, Number(option("--max-effects", registry.effects.length))),
  );
  const selected = registry.effects.slice(0, maxEffects);
  const clips = [];
  for (const [index, effect] of selected.entries()) {
    const maxStart = Math.max(0, inputSummary.duration - duration - 0.02);
    const start = maxStart > 0 ? (index * 0.71) % maxStart : 0;
    const clip = path.join(temporary, `${String(index).padStart(3, "0")}-${effect.id}.mp4`);
    const result = renderClip({
      effect,
      input,
      mask,
      start,
      duration,
      output: clip,
      style,
      sfxRoot,
    });
    clips.push(result);
  }
  const concatFile = path.join(temporary, "clips.ffconcat");
  fs.writeFileSync(
    concatFile,
    `ffconcat version 1.0\n${clips.map((clip) => (
      `file '${clip.output.replaceAll("'", "'\\''")}'`
    )).join("\n")}\n`,
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const showcaseFps = inputSummary.video?.avg_frame_rate
    && inputSummary.video.avg_frame_rate !== "0/0"
    ? inputSummary.video.avg_frame_rate
    : String(Math.max(1, inputSummary.fps));
  mustRun("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-fflags", "+genpts",
    "-f", "concat", "-safe", "0", "-i", concatFile,
    "-vf", `fps=${showcaseFps},setpts=N/(${showcaseFps}*TB)`,
    "-af", "aresample=async=1:first_pts=0",
    "-c:v", "libx264", "-preset", "fast", "-crf", "16",
    "-pix_fmt", "yuv420p", "-fps_mode", "cfr",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart", output,
  ]);
  const summary = mediaSummary(output);
  const manifest = {
    schemaVersion: "1.0",
    status: "pass",
    registry: registry.id,
    registrySha256: sha256File(registryFile),
    input: {
      path: input,
      sha256: sha256File(input),
      width: inputSummary.width,
      height: inputSummary.height,
      fps: inputSummary.fps,
      duration: inputSummary.duration,
    },
    mask: mask ? { path: mask, sha256: sha256File(mask) } : null,
    design: {
      id: design.system.id,
      version: design.system.version,
      digest: design.digest,
      modes: design.selectedModes,
    },
    output: {
      path: output,
      sha256: sha256File(output),
      width: summary.width,
      height: summary.height,
      fps: summary.fps,
      duration: summary.duration,
    },
    effectCount: clips.length,
    effects: clips,
    digest: sha256Value(clips.map((clip) => ({
      effectId: clip.effectId,
      sha256: clip.sha256,
      maskUsed: clip.maskUsed,
      sfx: clip.sfx,
    }))),
  };
  const manifestOutput = option("--manifest")
    ? path.resolve(option("--manifest"))
    : `${output}.manifest.json`;
  writeJsonAtomic(manifestOutput, manifest);
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    output,
    manifest: manifestOutput,
    effectCount: clips.length,
    duration: summary.duration,
    width: summary.width,
    height: summary.height,
    fps: summary.fps,
    sha256: manifest.output.sha256,
  }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
