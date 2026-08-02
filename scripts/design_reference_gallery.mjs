import fs from "node:fs";
import path from "node:path";
import {
  renderComponentArtifact,
  renderSceneArtifact,
  validateRenderArtifact,
} from "./design_renderers.mjs";
import { sha256File, sha256Value } from "./kacha_utils.mjs";

const BOARD_WIDTH = 1280;
const BOARD_HEIGHT = 720;

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeHtml(value) {
  return escapeXml(value);
}

function dataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function gradientStops(resolved, id = "brandWarm") {
  const gradient = resolved.style.gradients?.[id]
    ?? { from: "#F5B544", to: "#E66A32", angle: 18 };
  return {
    from: gradient.from,
    to: gradient.to,
    angle: Number(gradient.angle ?? 18),
  };
}

function referenceShell(resolved, {
  eyebrow,
  title,
  subtitle,
  body,
  note = "ENTRY · PEAK · EXIT",
}) {
  const palette = resolved.style.palette;
  const secondary = palette.inkSecondary
    ?? palette.secondaryTextOnLight
    ?? palette.ink;
  const gradient = gradientStops(resolved);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}">
  <defs>
    <linearGradient id="brand-warm" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${gradient.from}"/>
      <stop offset="1" stop-color="${gradient.to}"/>
    </linearGradient>
    <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="24" flood-color="#16181B" flood-opacity=".14"/>
    </filter>
  </defs>
  <rect width="1280" height="720" fill="${palette.canvas}"/>
  <circle cx="1168" cy="86" r="170" fill="${palette.accentSecondary}" opacity=".07"/>
  <circle cx="84" cy="670" r="190" fill="${palette.accentSignal ?? "#F05A47"}" opacity=".045"/>
  <text x="72" y="60" font-family="Avenir Next, PingFang SC, sans-serif" font-size="16" font-weight="700" letter-spacing="3" fill="${palette.accent}">${escapeXml(eyebrow)}</text>
  <text x="72" y="102" font-family="PingFang SC, sans-serif" font-size="34" font-weight="650" fill="${palette.ink}">${escapeXml(title)}</text>
  <text x="72" y="132" font-family="Avenir Next, PingFang SC, sans-serif" font-size="15" fill="${secondary}">${escapeXml(subtitle)}</text>
  <rect x="72" y="156" width="1136" height="492" rx="28" fill="${palette.surface}" filter="url(#soft-shadow)"/>
  ${body}
  <text x="72" y="686" font-family="Avenir Next, sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="${secondary}" opacity=".8">${escapeXml(note)}</text>
  <rect x="1110" y="674" width="98" height="5" rx="2.5" fill="url(#brand-warm)"/>
</svg>`;
}

function embeddedPreview(svg, x, y, width, height, radius = 18) {
  const clipId = `clip-${x}-${y}-${width}-${height}`.replaceAll(".", "-");
  return `<defs><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/></clipPath></defs>
  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="#E8E4DB"/>
  <image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" href="${dataUri(svg)}"/>`;
}

function componentReference(component, resolved) {
  const state = component.states.includes("peak")
    ? "peak"
    : component.states.includes("visible")
      ? "visible"
      : component.states.at(-1);
  const artifact = renderComponentArtifact(component, resolved, {
    width: 1120,
    height: 510,
    state,
  });
  const errors = validateRenderArtifact(artifact, [component.id]);
  if (errors.length > 0) throw new Error(`${component.id}: ${errors.join("; ")}`);
  const body = `${embeddedPreview(artifact.svg, 94, 178, 1092, 446, 20)}
    <rect x="110" y="194" width="146" height="28" rx="14" fill="${resolved.style.palette.darkSurface}" opacity=".82"/>
    <text x="183" y="213" text-anchor="middle" font-family="Avenir Next, sans-serif" font-size="12" font-weight="700" fill="#FFFFFF">${escapeXml(component.renderer.toUpperCase())}</text>`;
  return referenceShell(resolved, {
    eyebrow: `COMPONENT · ${component.category.toUpperCase()}`,
    title: component.label,
    subtitle: `${component.id} · 状态 ${state} · fallback ${component.fallback}`,
    body,
    note: "真实组件渲染 · 尺寸与色彩受当前模式配置约束",
  });
}

function sceneReference(scene, resolved) {
  const states = ["entry", "peak", "exit"];
  const frames = states.map((state) => {
    const artifact = renderSceneArtifact(scene, resolved, {
      width: 960,
      height: 540,
      state,
      showGuides: false,
    });
    const errors = validateRenderArtifact(
      artifact,
      [scene.id, ...scene.components],
    );
    if (errors.length > 0) throw new Error(`${scene.id}.${state}: ${errors.join("; ")}`);
    return artifact.svg;
  });
  const xPositions = [94, 464, 834];
  const body = frames.map((svg, index) => `
    ${embeddedPreview(svg, xPositions[index], 226, 352, 198, 16)}
    <circle cx="${xPositions[index] + 18}" cy="202" r="5" fill="${[
      resolved.style.palette.accentSecondary,
      resolved.style.palette.accent,
      resolved.style.palette.accentSignal ?? "#F05A47",
    ][index]}"/>
    <text x="${xPositions[index] + 32}" y="208" font-family="Avenir Next, sans-serif" font-size="14" font-weight="700" letter-spacing="2" fill="${resolved.style.palette.ink}">${states[index].toUpperCase()}</text>
  `).join("");
  const detail = `<text x="94" y="476" font-family="PingFang SC, sans-serif" font-size="18" font-weight="600" fill="${resolved.style.palette.ink}">${escapeXml(scene.trigger)}</text>
    <text x="94" y="515" font-family="Avenir Next, PingFang SC, sans-serif" font-size="14" fill="${resolved.style.palette.inkSecondary ?? resolved.style.palette.secondaryTextOnLight ?? resolved.style.palette.ink}">布局 ${escapeXml(scene.layout)}　·　进入 ${escapeXml(scene.entry)}　·　退出 ${escapeXml(scene.exit)}</text>
    <text x="94" y="550" font-family="Avenir Next, PingFang SC, sans-serif" font-size="14" fill="${resolved.style.palette.inkSecondary ?? resolved.style.palette.secondaryTextOnLight ?? resolved.style.palette.ink}">组件 ${escapeXml(scene.components.join("  /  "))}</text>`;
  return referenceShell(resolved, {
    eyebrow: `SCENE · ${scene.category.toUpperCase()}`,
    title: scene.label,
    subtitle: `${scene.id} · fallback ${scene.fallback}`,
    body: `${body}${detail}`,
    note: "场景分镜参考 · 真实执行仍必须由语义、节奏与安全区触发",
  });
}

function layoutGeometry(template, resolved) {
  const palette = resolved.style.palette;
  const ink = palette.ink;
  const accent = palette.accent;
  const cool = palette.accentInsight ?? "#5577B8";
  const signal = palette.accentSignal ?? "#F05A47";
  const panel = (x, y, w, h, fill, opacity = 1, rx = 14) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" opacity="${opacity}"/>`;
  const subject = (cx, cy, scale = 1) => `
    <circle cx="${cx}" cy="${cy - 75 * scale}" r="${34 * scale}" fill="${ink}" opacity=".88"/>
    <rect x="${cx - 58 * scale}" y="${cy - 35 * scale}" width="${116 * scale}" height="${148 * scale}" rx="${52 * scale}" fill="${ink}" opacity=".88"/>`;
  const words = (x, y, width, count = 3, color = ink) =>
    Array.from({ length: count }, (_, index) => panel(
      x,
      y + index * 36,
      width * (1 - index * 0.12),
      11,
      color,
      index === 0 ? .78 : .38,
      5,
    )).join("");
  let body = "";
  if (/split|left_right|top_bottom|dual/.test(template)) {
    const vertical = /top_bottom|vertical/.test(template);
    body = vertical
      ? `${panel(108, 216, 1064, 170, cool, .14)}${panel(108, 406, 1064, 170, accent, .16)}${subject(280, 310, .72)}${words(590, 258, 380)}${words(590, 448, 380)}`
      : `${panel(108, 216, 512, 360, cool, .14)}${panel(640, 216, 532, 360, accent, .16)}${subject(338, 405, .9)}${words(720, 298, 320, 4)}`;
  } else if (/pip|corner|circle|square|rounded/.test(template)) {
    body = `${panel(108, 216, 1064, 360, palette.darkSurface, .9)}${subject(390, 405, 1.1)}${panel(846, 252, 258, 164, palette.surface, 1, 22)}${panel(864, 270, 222, 128, cool, .18, 16)}${words(846, 456, 258, 3, "#FFFFFF")}`;
  } else if (/subject_right|right|negative_space/.test(template)) {
    body = `${panel(108, 216, 1064, 360, palette.canvas)}${words(172, 302, 440, 4)}${panel(172, 466, 124, 8, signal, .95, 4)}${subject(940, 410, 1.08)}`;
  } else if (/subject_left|editorial_left|left/.test(template)) {
    body = `${panel(108, 216, 1064, 360, palette.canvas)}${subject(326, 410, 1.08)}${words(606, 302, 390, 4)}${panel(606, 466, 124, 8, accent, .95, 4)}`;
  } else if (/terminal|workflow|flow|process|timeline|node/.test(template)) {
    body = `${panel(108, 216, 1064, 360, palette.darkSurface, .96)}${[0, 1, 2, 3].map((i) => `${panel(176 + i * 240, 344, 146, 70, i === 3 ? accent : cool, i === 3 ? .95 : .45, 18)}${i < 3 ? `<path d="M ${322 + i * 240} 379 H ${398 + i * 240}" stroke="#FFFFFF" stroke-width="3" opacity=".45"/>` : ""}`).join("")}`;
  } else if (/full|screen|bleed|background|subject_full/.test(template)) {
    body = `${panel(108, 216, 1064, 360, palette.darkSurface, .94)}${subject(640, 414, 1.25)}${panel(250, 286, 780, 94, signal, .18, 18)}${words(378, 302, 524, 2, "#FFFFFF")}`;
  } else if (/subtitle|caption|logic|hierarchy|contrast|inline/.test(template)) {
    body = `${panel(108, 216, 1064, 360, palette.canvas)}${subject(640, 384, 1.05)}${panel(256, 480, 768, 62, palette.darkSurface, .75, 14)}${panel(472, 501, 184, 18, accent, 1, 5)}${panel(672, 501, 132, 18, "#FFFFFF", .88, 5)}`;
  } else if (/scale|bridge|detail|focus|depth/.test(template)) {
    body = `${panel(108, 216, 1064, 360, palette.canvas)}${subject(360, 414, .76)}<path d="M 510 397 C 620 330 690 330 770 397" stroke="${accent}" stroke-width="5" fill="none" stroke-dasharray="10 12"/><circle cx="886" cy="397" r="112" fill="${cool}" opacity=".14"/>${subject(886, 414, 1.25)}`;
  } else {
    body = `${panel(108, 216, 1064, 360, palette.canvas)}${subject(380, 408, 1)}${words(610, 310, 356, 4)}${panel(610, 470, 120, 8, accent, 1, 4)}`;
  }
  return body;
}

function layoutReference(layout, resolved) {
  return referenceShell(resolved, {
    eyebrow: "LAYOUT · SAFE COMPOSITION",
    title: layout.id,
    subtitle: `模板 ${layout.template} · 构图只表达信息层级，不替代真人抽帧验收`,
    body: layoutGeometry(layout.template, resolved),
    note: "人物头部、主字幕、平台控件和主要信息必须互不冲突",
  });
}

function rendererReference(renderer, resolved) {
  const palette = resolved.style.palette;
  const outputLabels = renderer.outputs.map((output, index) => `
    <rect x="${850}" y="${264 + index * 74}" width="232" height="50" rx="15" fill="${index === 0 ? palette.accent : palette.accentSecondary}" opacity="${index === 0 ? .95 : .7}"/>
    <text x="966" y="${295 + index * 74}" text-anchor="middle" font-family="Avenir Next, sans-serif" font-size="15" font-weight="700" fill="#FFFFFF">${escapeXml(output.toUpperCase())}</text>`).join("");
  const body = `
    <rect x="142" y="292" width="236" height="132" rx="24" fill="${palette.canvas}"/>
    <text x="260" y="348" text-anchor="middle" font-family="Avenir Next, sans-serif" font-size="14" font-weight="700" fill="${palette.inkSecondary ?? palette.secondaryTextOnLight ?? palette.ink}">DESIGN CONTRACT</text>
    <text x="260" y="382" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="20" font-weight="650" fill="${palette.ink}">组件 / 场景 / 模式</text>
    <path d="M 394 358 H 514" stroke="${palette.accent}" stroke-width="6" stroke-linecap="round"/>
    <path d="M 498 344 L 518 358 L 498 372" fill="none" stroke="${palette.accent}" stroke-width="5"/>
    <rect x="532" y="264" width="236" height="188" rx="28" fill="${palette.darkSurface}"/>
    <text x="650" y="334" text-anchor="middle" font-family="Avenir Next, sans-serif" font-size="15" font-weight="700" letter-spacing="2" fill="#FFFFFF" opacity=".62">${escapeXml(renderer.adapter.toUpperCase())}</text>
    <text x="650" y="378" text-anchor="middle" font-family="Avenir Next, sans-serif" font-size="28" font-weight="750" fill="#FFFFFF">${escapeXml(renderer.id)}</text>
    <text x="650" y="414" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="14" fill="#FFFFFF" opacity=".7">${renderer.requiresMedia ? "需要真实媒体" : "纯设计资产可渲染"}</text>
    <path d="M 786 358 H 824" stroke="${palette.accentSecondary}" stroke-width="6" stroke-linecap="round"/>
    ${outputLabels}`;
  return referenceShell(resolved, {
    eyebrow: "RENDERER · PRODUCTION ADAPTER",
    title: renderer.id,
    subtitle: `${renderer.adapter} · ${renderer.status} · ${renderer.requiresMedia ? "requires media" : "media independent"}`,
    body,
    note: "渲染器是执行能力，不代表任意素材都能得到同样质量",
  });
}

function motionState(motion, state, index, resolved) {
  const { family, id } = motion;
  const palette = resolved.style.palette;
  const t = [0.18, 0.62, 1][index];
  const seed = [...id].reduce(
    (sum, character) => (sum + character.charCodeAt(0)) % 97,
    0,
  );
  const xBase = 136 + index * 370;
  const yBase = 236;
  const width = 330;
  const isExit = /exit|end|clear|return|fade/.test(id);
  const isVertical = /up|step|grow|collapse|converge/.test(id);
  const direction = /return|collapse|converge/.test(id) ? -1 : 1;
  const progress = isExit ? 1 - t : t;
  const opacity = family === "hold" || family === "none"
    ? 1
    : Math.max(.2, Math.min(1, progress * 1.4));
  const xOffset = /stagger|draw|reveal|timed_entry|timed_exit/.test(family)
    && !isVertical
    ? direction * (1 - progress) * (56 + seed % 38)
    : 0;
  const yOffset = isVertical ? direction * (1 - progress) * 64 : 0;
  let scale = /scale/.test(family) ? .62 + .38 * progress : 1;
  if (/soft_pop|task_card/.test(id)) scale = .72 + .28 * progress;
  if (/collapse|converge|merge/.test(id) && isExit) scale = .52 + .48 * progress;
  const rotation = /arc|morph|time_jump/.test(id)
    ? (1 - progress) * (direction * (8 + seed % 8))
    : 0;
  const revealWidth = /type|reveal|draw/.test(family) ? 142 * t : 142;
  const accentRoles = [
    palette.accent,
    palette.accentSignal ?? "#F05A47",
    palette.accentInsight ?? "#5577B8",
    palette.accentVerified ?? "#3F8A78",
  ];
  const accent = index === 1
    ? accentRoles[(seed % (accentRoles.length - 1)) + 1]
    : palette.accent;
  const special = family === "draw"
    ? `<path d="M ${xBase + 54} ${yBase + 252} Q ${xBase + 166} ${yBase + 190 - seed % 24} ${xBase + 282} ${yBase + 248}" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${Math.round(250 * progress)} 260"/>`
    : family === "highlight"
      ? `<circle cx="${xBase + 230}" cy="${yBase + 121}" r="${32 + 18 * progress}" fill="none" stroke="${accent}" stroke-width="5" opacity="${.3 + .7 * progress}"/>`
      : family === "type"
        ? `<rect x="${xBase + 158 + revealWidth + 8}" y="${yBase + 108}" width="4" height="28" rx="2" fill="${accent}" opacity="${index === 2 ? .25 : 1}"/>`
        : family === "cut"
          ? `<path d="M ${xBase + 165} ${yBase + 66} V ${yBase + 258}" stroke="${accent}" stroke-width="${index === 1 ? 8 : 2}" opacity="${index === 1 ? .95 : .28}"/>`
          : /timed/.test(family)
            ? `<circle cx="${xBase + 278}" cy="${yBase + 54}" r="18" fill="none" stroke="${accent}" stroke-width="3" opacity=".7"/><path d="M ${xBase + 278} ${yBase + 54} L ${xBase + 278 + 12 * progress} ${yBase + 54 - 10 * (1 - progress)}" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>`
            : "";
  return `
    <rect x="${xBase}" y="${yBase}" width="${width}" height="298" rx="22" fill="${palette.canvas}"/>
    <text x="${xBase + 24}" y="${yBase + 38}" font-family="Avenir Next, sans-serif" font-size="13" font-weight="700" letter-spacing="2" fill="${palette.inkSecondary ?? palette.secondaryTextOnLight ?? palette.ink}">${state.toUpperCase()}</text>
    <g transform="translate(${xOffset} ${yOffset}) translate(${xBase + width / 2} ${yBase + 162}) rotate(${rotation}) scale(${scale}) translate(${-xBase - width / 2} ${-yBase - 162})" opacity="${opacity}">
      <circle cx="${xBase + 90}" cy="${yBase + 130}" r="42" fill="${palette.darkSurface}"/>
      <rect x="${xBase + 52}" y="${yBase + 174}" width="76" height="84" rx="32" fill="${palette.darkSurface}"/>
      <rect x="${xBase + 158}" y="${yBase + 112}" width="${revealWidth}" height="18" rx="9" fill="${accent}"/>
      <rect x="${xBase + 158}" y="${yBase + 154}" width="${132 * t}" height="12" rx="6" fill="${palette.ink}" opacity=".66"/>
      <rect x="${xBase + 158}" y="${yBase + 184}" width="${108 * t}" height="12" rx="6" fill="${palette.ink}" opacity=".34"/>
    </g>
    ${special}
    ${index < 2 ? `<path d="M ${xBase + 336} ${yBase + 149} H ${xBase + 358}" stroke="${palette.accentSecondary}" stroke-width="4" stroke-linecap="round"/><path d="M ${xBase + 350} ${yBase + 141} L ${xBase + 360} ${yBase + 149} L ${xBase + 350} ${yBase + 157}" fill="none" stroke="${palette.accentSecondary}" stroke-width="3"/>` : ""}`;
}

function motionReference(motion, resolved) {
  const body = ["entry", "peak", "exit"]
    .map((state, index) => motionState(motion, state, index, resolved))
    .join("");
  return referenceShell(resolved, {
    eyebrow: `MOTION · ${motion.family.toUpperCase()}`,
    title: motion.id,
    subtitle: "参考帧描述运动意图；正式执行还需绑定时长、缓动、声音落点和真实对象",
    body,
    note: "运动必须解释信息、情绪或视角变化；无理由则停稳",
  });
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const normalized = contents.replace(/[ \t]+$/gm, "").replace(/\n?$/, "\n");
  fs.writeFileSync(file, normalized);
}

function galleryHtml(manifest) {
  const entriesJson = JSON.stringify(manifest.entries);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>行者风 2.0 · 效果参考图库</title>
<style>
:root{--bg:#f2efe8;--surface:#fbf8f1;--ink:#25282b;--muted:#6b7175;--accent:#e98a2b;--signal:#f05a47;--line:#ddd7cd}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Avenir Next","PingFang SC",sans-serif}
header{padding:72px max(5vw,32px) 36px;max-width:1500px;margin:auto}header p{color:var(--muted);max-width:760px;line-height:1.8}h1{font-size:clamp(36px,5vw,72px);letter-spacing:-.04em;margin:.15em 0}.mark{width:96px;height:6px;border-radius:3px;background:linear-gradient(90deg,#f5b544,#e66a32)}
.tools{position:sticky;top:0;z-index:5;padding:16px max(5vw,32px);background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(18px);border-block:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap}
button,input{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:10px 16px;font:inherit}button.active{background:var(--ink);color:white;border-color:var(--ink)}input{min-width:260px}
main{max-width:1500px;margin:auto;padding:36px max(5vw,32px) 100px}.count{color:var(--muted);margin-bottom:26px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:22px}.card{background:var(--surface);border:1px solid var(--line);border-radius:22px;overflow:hidden;box-shadow:0 12px 30px rgba(28,30,32,.06)}.card img{width:100%;display:block;aspect-ratio:16/9;object-fit:cover;background:#ebe7df}.meta{padding:16px 18px 18px}.kind{font-size:11px;letter-spacing:.14em;color:var(--accent);font-weight:800}.meta h2{font-size:18px;margin:8px 0 4px}.meta p{font-size:13px;color:var(--muted);margin:0;word-break:break-all}
@media(max-width:680px){header{padding-top:46px}.grid{grid-template-columns:1fr}.tools{position:static}input{width:100%}}
</style></head>
<body><header><div class="mark"></div><h1>行者风 2.0<br/>效果参考图库</h1><p>不是一套“随便挑效果”的模板墙，而是咔嚓策划、执行和返工共同使用的视觉合同。每张图都来自当前设计注册表，并锁定当前设计摘要。</p></header>
<div class="tools"><button class="active" data-kind="all">全部</button><button data-kind="component">组件</button><button data-kind="scene">场景</button><button data-kind="renderer">渲染器</button><button data-kind="layout">布局</button><button data-kind="motion">动效</button><input id="search" placeholder="搜索名称、ID、分类"/></div>
<main><div class="count" id="count"></div><div class="grid" id="grid"></div></main>
<script>
const entries=${entriesJson};let kind="all";const grid=document.querySelector("#grid"),count=document.querySelector("#count"),search=document.querySelector("#search");
function render(){const q=search.value.trim().toLowerCase();const list=entries.filter(e=>(kind==="all"||e.kind===kind)&&(!q||JSON.stringify(e).toLowerCase().includes(q)));count.textContent=\`显示 \${list.length} / \${entries.length} 张参考图\`;grid.innerHTML=list.map(e=>\`<article class="card"><img loading="lazy" src="\${e.path}"/><div class="meta"><span class="kind">\${e.kind.toUpperCase()}</span><h2>\${e.label||e.id}</h2><p>\${e.id}</p></div></article>\`).join("")}
document.querySelectorAll("button").forEach(b=>b.onclick=()=>{document.querySelectorAll("button").forEach(x=>x.classList.remove("active"));b.classList.add("active");kind=b.dataset.kind;render()});search.oninput=render;render();
</script></body></html>`;
}

export function generateDesignReferenceGallery({
  resolved,
  outputDirectory,
  overwrite = false,
}) {
  const destination = path.resolve(outputDirectory);
  if (fs.existsSync(destination) && !overwrite) {
    throw new Error(`参考图库已存在，使用 --overwrite 明确覆盖：${destination}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  const entries = [];
  const groups = [
    ["component", resolved.components, componentReference],
    ["scene", resolved.scenes, sceneReference],
    ["renderer", resolved.implementations.renderers, rendererReference],
    ["layout", resolved.implementations.layouts, layoutReference],
    ["motion", resolved.implementations.motions, motionReference],
  ];
  for (const [kind, items, render] of groups) {
    for (const item of items) {
      const relativePath = `${kind}s/${item.id}.svg`;
      const file = path.join(destination, relativePath);
      writeFile(file, render(item, resolved));
      entries.push({
        kind,
        id: item.id,
        label: item.label ?? item.id,
        category: item.category ?? item.family ?? item.adapter ?? null,
        path: relativePath,
        sha256: sha256File(file),
      });
    }
  }
  const counts = Object.fromEntries(
    groups.map(([kind, items]) => [kind, items.length]),
  );
  const manifest = {
    schemaVersion: "1.0",
    kind: "kacha_design_reference_gallery",
    designSystem: {
      id: resolved.system.id,
      version: resolved.system.version,
      digest: resolved.digest,
      implementationDigest: resolved.implementationDigest,
      selectedModes: resolved.selectedModes,
    },
    counts: {
      ...counts,
      total: entries.length,
    },
    entries,
  };
  manifest.digest = sha256Value({ ...manifest, digest: undefined });
  writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFile(path.join(destination, "index.html"), galleryHtml(manifest));
  writeFile(
    path.join(destination, "README.md"),
    `# 行者风 2.0 效果参考图库

本目录由当前咔嚓设计系统自动生成，用于策划、执行、返工和验收共同对齐，不是可脱离语义随意套用的模板包。

- 组件：${counts.component}
- 场景：${counts.scene}
- 渲染器：${counts.renderer}
- 布局：${counts.layout}
- 动效：${counts.motion}
- 合计：${entries.length}

打开 \`index.html\` 可搜索和分类浏览。每个 SVG 都可独立缩放查看；\`manifest.json\` 锁定设计摘要与文件 SHA-256。

生成命令：

\`\`\`bash
node scripts/kacha.mjs design gallery \\
  --output design/reference-gallery/xingzhe-v2 \\
  --overwrite
\`\`\`
`,
  );
  return {
    status: "pass",
    outputDirectory: destination,
    index: path.join(destination, "index.html"),
    manifest: path.join(destination, "manifest.json"),
    counts: manifest.counts,
    designDigest: resolved.digest,
    digest: manifest.digest,
  };
}
