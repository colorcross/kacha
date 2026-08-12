import { resolveFallback } from "./design_system.mjs";

const DEFAULT_DATA = {
  brand: "行者大灰",
  show: "工具分享",
  issue: "第1期",
  series: "20年人生实验",
  source: "SOURCE · 2026",
  status: "已核验",
  disclosure: "AI辅助剪辑",
  primary: "让每一次变化都有理由",
  secondary: "Every change needs a reason",
  emphasis: "有理由",
  quote: "工具降低门槛，品味决定上限。",
  speaker: "DAHUI",
  wrong: "让剪辑占据我的 hole life",
  correct: "让剪辑占据我的 whole life",
  index: "01",
  title: "先把内容做对",
  subtitle: "再做视觉包装",
  text: "AI EDITS. YOU DECIDE.",
  phrases: ["信息变化", "情绪变化", "视角变化"],
  value: "3",
  unit: "个理由",
  label: "切镜依据",
  term: "切镜",
  definition: "信息、情绪或视角发生变化时，镜头才有切换的理由。",
  boundary: "特效不能掩盖错误切点",
  body: "内容、人物、证据与声音共用同一条时间线。",
  items: ["信息变化", "情绪变化", "视角变化"],
  date: "2026-07-28",
  scope: "本地验证",
  left: "BEFORE",
  right: "AFTER",
  criteria: "同源 · 同帧 · 同裁切",
  before: "原始",
  after: "优化",
  subject: "当前方案",
  dimensions: ["清晰", "一致", "可复核"],
  score: "92",
  media: "MEDIA",
  mask: "MASK",
  screen: "TOOL SCREEN",
  target: "CLICK",
  nodes: ["原片", "精剪", "声音", "画面", "字幕", "QC", "发布"],
  events: ["开始", "验证", "交付"],
  seriesData: [72, 48, 86, 64],
  segments: [46, 32, 22],
  metrics: ["清晰度 96", "同步 98", "一致性 94", "安全区 100"],
  question: "为什么要切？",
  branches: ["信息", "情绪", "视角"],
  causes: ["内容变化", "动作变化"],
  effect: "自然切换",
  caveat: "没有理由就保持镜头",
  levels: ["推测", "线索", "证据", "复核"],
  current: "复核",
};

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizedList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return fallback;
}

function lineText(value, maximum = 22) {
  const text = String(value ?? "");
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function font(resolved, role) {
  return resolved.fonts?.roles?.[role]?.resolved
    ?? resolved.style.typography?.[role]?.families?.[0]
    ?? "sans-serif";
}

function textNode({
  x,
  y,
  text,
  size,
  fill,
  family,
  weight = 500,
  anchor = "start",
  opacity = 1,
  letterSpacing = 0,
}) {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" `
    + `font-family="${xml(family)}" font-size="${size}" font-weight="${weight}" `
    + `letter-spacing="${letterSpacing}em" fill="${fill}" opacity="${opacity}">`
    + `${xml(text)}</text>`;
}

function roundedRect(x, y, width, height, radius, fill, stroke = "none", strokeWidth = 0) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" `
    + `rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function mediaPlaceholder(x, y, width, height, palette, label = "MEDIA") {
  const spacing = Math.max(12, Math.round(Math.min(width, height) * 0.12));
  const lines = [];
  for (let offset = -height; offset < width + height; offset += spacing) {
    lines.push(
      `<line x1="${x + offset}" y1="${y + height}" x2="${x + offset + height}" `
      + `y2="${y}" stroke="${palette.inkSecondary}" stroke-opacity="0.14" `
      + `stroke-width="${Math.max(1, spacing * 0.08)}"/>`,
    );
  }
  return `<g>${roundedRect(x, y, width, height, Math.min(width, height) * 0.04, palette.surface)}`
    + `<clipPath id="media-${Math.round(x)}-${Math.round(y)}"><rect x="${x}" y="${y}" `
    + `width="${width}" height="${height}" rx="${Math.min(width, height) * 0.04}"/></clipPath>`
    + `<g clip-path="url(#media-${Math.round(x)}-${Math.round(y)})">${lines.join("")}</g>`
    + textNode({
      x: x + width / 2,
      y: y + height / 2 + Math.min(width, height) * 0.04,
      text: label,
      size: Math.max(12, Math.min(width, height) * 0.1),
      fill: palette.inkSecondary,
      family: "Avenir Next",
      weight: 700,
      anchor: "middle",
      letterSpacing: 0.08,
    })
    + "</g>";
}

function subjectPlaceholder(x, y, width, height, palette, surface = "footage") {
  const headRadius = Math.min(width * 0.22, height * 0.15);
  const cx = x + width / 2;
  const cy = y + height * 0.27;
  return `<g data-role="subject-placeholder" opacity="0.92">`
    + `<ellipse cx="${cx}" cy="${cy}" rx="${headRadius}" ry="${headRadius * 1.08}" `
    + `fill="${palette.accentSecondary}"/>`
    + `<path d="M ${x + width * 0.16} ${y + height * 0.94} `
    + `Q ${cx} ${y + height * 0.46} ${x + width * 0.84} ${y + height * 0.94} Z" `
    + `fill="${surface === "dark" ? palette.surfaceElevated : palette.darkSurface}"/>`
    + "</g>";
}

function editorialFootageBackdrop(width, height, palette) {
  const shelfX = width * 0.56;
  const shelfWidth = width * 0.42;
  const shelfTop = height * 0.08;
  const shelfHeight = height * 0.66;
  const rowHeight = shelfHeight / 4;
  const books = [];
  for (let row = 0; row < 4; row += 1) {
    const y = shelfTop + row * rowHeight;
    books.push(`<line x1="${shelfX}" y1="${y + rowHeight * 0.82}" `
      + `x2="${shelfX + shelfWidth}" y2="${y + rowHeight * 0.82}" `
      + `stroke="${palette.ink}" stroke-opacity="0.16" stroke-width="${Math.max(2, height * 0.006)}"/>`);
    let cursor = shelfX + shelfWidth * 0.04;
    for (let index = 0; index < 12; index += 1) {
      const bookWidth = shelfWidth * (0.035 + ((index + row) % 4) * 0.006);
      const bookHeight = rowHeight * (0.34 + ((index * 3 + row) % 5) * 0.07);
      const color = [
        palette.accentSecondary,
        palette.accent,
        palette.accentInsight ?? palette.accentSecondary,
        palette.accentVerified ?? palette.accentSecondary,
        palette.inkSecondary,
      ][(index + row * 2) % 5];
      books.push(`<rect x="${cursor}" y="${y + rowHeight * 0.79 - bookHeight}" `
        + `width="${bookWidth}" height="${bookHeight}" fill="${color}" opacity="0.2"/>`);
      cursor += bookWidth + shelfWidth * 0.012;
    }
  }
  return `<g data-role="editorial-footage-backdrop">`
    + `<rect width="${width}" height="${height}" fill="${palette.canvas}"/>`
    + `<ellipse cx="${width * 0.27}" cy="${height * 0.33}" rx="${width * 0.38}" `
    + `ry="${height * 0.46}" fill="${palette.surfaceElevated}" opacity="0.58"/>`
    + `<rect x="${shelfX}" y="${shelfTop}" width="${shelfWidth}" height="${shelfHeight}" `
    + `fill="${palette.surface}" opacity="0.42"/>`
    + books.join("")
    + `<path d="M 0 ${height * 0.78} H ${width} V ${height} H 0 Z" `
    + `fill="${palette.surfaceElevated}" opacity="0.82"/>`
    + `<path d="M 0 ${height * 0.78} H ${width}" stroke="${palette.ink}" `
    + `stroke-opacity="0.08" stroke-width="${Math.max(1, height * 0.004)}"/>`
    + `</g>`;
}

function componentData(component, supplied, resolved) {
  const data = { ...DEFAULT_DATA, ...(supplied ?? {}) };
  data.show = supplied?.show ?? resolved.style.brand.label;
  return Object.fromEntries(
    component.slots.map((slot) => [slot, data[slot] ?? slot.toUpperCase()]),
  );
}

function brandComponent(component, data, box, resolved) {
  const { x, y, width, height } = box;
  const p = resolved.style.palette;
  const value = data[component.slots[0]];
  const visualHeight = Math.min(height, width * 0.075);
  if (component.id === "source_tag") {
    const lineWidth = Math.min(width * 0.34, Math.max(visualHeight * 1.4, String(value).length * visualHeight * 0.1));
    return `<line x1="${x}" y1="${y + visualHeight * 0.42}" x2="${x + lineWidth}" `
      + `y2="${y + visualHeight * 0.42}" stroke="${p.accentInsight}" `
      + `stroke-width="${Math.max(2, visualHeight * 0.012)}"/>`
      + textNode({
        x,
        y: y + visualHeight * 0.88,
        text: value,
        size: visualHeight * 0.34,
        fill: p.inkSecondary,
        family: font(resolved, "label"),
        weight: resolved.style.typography.label.weight,
        letterSpacing: 0.04,
      });
  }
  const badge = component.id === "issue_badge";
  const warning = component.id === "disclosure_tag";
  const fill = warning ? p.accentSecondary : badge ? p.accent : p.darkSurface;
  const textColor = warning ? p.textOnDark : badge ? p.textOnAccent : p.textOnDark;
  const chipWidth = Math.min(width, Math.max(visualHeight * 1.8, String(value).length * visualHeight * 0.56));
  return roundedRect(x, y, chipWidth, visualHeight, visualHeight * 0.28, fill)
    + textNode({
      x: x + chipWidth / 2,
      y: y + visualHeight * 0.65,
      text: value,
      size: visualHeight * 0.34,
      fill: textColor,
      family: font(resolved, "label"),
      weight: resolved.style.typography.label.weight,
      anchor: "middle",
      letterSpacing: 0.04,
    });
}

function subtitleComponent(component, data, box, resolved) {
  const { x, y, width, height } = box;
  const p = resolved.style.palette;
  const s = resolved.style.subtitles;
  const light = resolved.selectedModes.surface === "light"
    || component.id === "subtitle_light_surface";
  const primaryColor = light
    ? s.lightSurfaceVariant?.primaryColor ?? p.textOnLight
    : s.primaryColor ?? p.textOnDark;
  const secondaryColor = light
    ? s.lightSurfaceVariant?.secondaryColor ?? p.secondaryTextOnLight
    : s.secondaryColor ?? p.textOnDark;
  const familyPrimary = font(resolved, "subtitlePrimary");
  const familySecondary = font(resolved, "subtitleSecondary");
  const primary = component.id === "subtitle_correction"
    ? data.correct
    : data.primary ?? data.quote;
  const emphasis = data.emphasis;
  const shadowId = `subtitle-shadow-${component.id}`;
  const shadow = `<filter id="${shadowId}"><feDropShadow dx="0" `
    + `dy="${Math.max(1, height * 0.025)}" stdDeviation="${Math.max(1, height * 0.025)}" `
    + `flood-color="${s.shadow?.color ?? p.shadow}" `
    + `flood-opacity="${s.shadow?.opacity ?? 0.6}"/></filter>`;
  const primarySize = Math.max(
    18,
    Math.min(
      height * (component.id === "subtitle_bilingual" ? 0.31 : 0.38),
      width * 0.058,
    ),
  );
  const content = [];
  if (component.id === "subtitle_speaker") {
    content.push(roundedRect(x, y + height * 0.12, width * 0.18, height * 0.3, height * 0.08, p.accent));
    content.push(textNode({
      x: x + width * 0.09,
      y: y + height * 0.33,
      text: data.speaker,
      size: height * 0.16,
      fill: p.textOnAccent,
      family: font(resolved, "label"),
      weight: 700,
      anchor: "middle",
    }));
  }
  if (component.id === "subtitle_correction") {
    content.push(textNode({
      x: x + width / 2,
      y: y + height * 0.28,
      text: lineText(data.wrong, 34),
      size: height * 0.22,
      fill: p.accentSecondary,
      family: familyPrimary,
      anchor: "middle",
      opacity: 0.68,
    }));
    content.push(`<line x1="${x + width * 0.22}" y1="${y + height * 0.23}" `
      + `x2="${x + width * 0.78}" y2="${y + height * 0.23}" `
      + `stroke="${p.accentSecondary}" stroke-width="${Math.max(2, height * 0.025)}"/>`);
  }
  content.push(`<g filter="url(#${shadowId})">`
    + textNode({
      x: x + width / 2,
      y: y + height * (component.id === "subtitle_bilingual" ? 0.46 : 0.62),
      text: lineText(primary, 38),
      size: primarySize,
      fill: primaryColor,
      family: familyPrimary,
      weight: component.id === "subtitle_emphasis" ? 650 : 400,
      anchor: "middle",
    })
    + "</g>");
  if (component.id === "subtitle_emphasis") {
    content.push(roundedRect(
      x + width * 0.42,
      y + height * 0.7,
      width * 0.16,
      Math.max(4, height * 0.04),
      2,
      p.accent,
    ));
    content.push(textNode({
      x: x + width * 0.5,
      y: y + height * 0.92,
      text: emphasis,
      size: height * 0.18,
      fill: p.accent,
      family: familyPrimary,
      weight: 650,
      anchor: "middle",
    }));
  }
  if (["subtitle_bilingual", "subtitle_light_surface"].includes(component.id)) {
    content.push(textNode({
      x: x + width / 2,
      y: y + height * 0.79,
      text: lineText(data.secondary, 42),
      size: height * 0.21,
      fill: secondaryColor,
      family: familySecondary,
      weight: 400,
      anchor: "middle",
    }));
  }
  if (component.id === "subtitle_quote") {
    content.push(textNode({
      x: x + width * 0.82,
      y: y + height * 0.88,
      text: data.source,
      size: height * 0.15,
      fill: secondaryColor,
      family: font(resolved, "label"),
      anchor: "end",
    }));
  }
  return `<defs>${shadow}</defs>${content.join("")}`;
}

function textComponent(component, data, box, resolved) {
  const { x, y, width, height } = box;
  const p = resolved.style.palette;
  const display = font(resolved, "display");
  const body = font(resolved, "body");
  if (component.id === "chapter_title") {
    return textNode({
      x,
      y: y + height * 0.42,
      text: data.index,
      size: height * 0.34,
      fill: p.accent,
      family: display,
      weight: 800,
    })
      + textNode({
        x: x + width * 0.16,
        y: y + height * 0.46,
        text: lineText(data.title, 16),
        size: height * 0.28,
        fill: p.ink,
        family: display,
        weight: 800,
      })
      + roundedRect(x + width * 0.16, y + height * 0.57, width * 0.28, height * 0.035, 2, p.accent)
      + textNode({
        x: x + width * 0.16,
        y: y + height * 0.82,
        text: lineText(data.subtitle, 24),
        size: height * 0.16,
        fill: p.inkSecondary,
        family: body,
      });
  }
  if (component.id === "numeric_punch") {
    return textNode({
      x: x + width * 0.04,
      y: y + height * 0.72,
      text: data.value,
      size: height * 0.72,
      fill: p.accent,
      family: display,
      weight: 800,
    })
      + textNode({
        x: x + width * 0.38,
        y: y + height * 0.48,
        text: data.unit,
        size: height * 0.2,
        fill: p.ink,
        family: display,
        weight: 700,
      })
      + textNode({
        x: x + width * 0.38,
        y: y + height * 0.72,
        text: data.label,
        size: height * 0.13,
        fill: p.inkSecondary,
        family: body,
      });
  }
  if (component.id === "typewriter_text") {
    const visible = lineText(data.text, 28);
    return roundedRect(x, y + height * 0.18, width, height * 0.64, height * 0.08, p.darkSurface)
      + textNode({
        x: x + width * 0.06,
        y: y + height * 0.59,
        text: visible,
        size: height * 0.22,
        fill: p.textOnDark,
        family: "Menlo",
        weight: 600,
        letterSpacing: 0.02,
      })
      + roundedRect(
        x + width * 0.06 + visible.length * height * 0.135,
        y + height * 0.37,
        Math.max(3, height * 0.018),
        height * 0.28,
        1,
        p.accent,
      );
  }
  if (component.id === "text_behind_subject") {
    const phrases = normalizedList(data.phrases, DEFAULT_DATA.phrases);
    const gradient = resolved.style.gradients?.[
      resolved.style.emphasis?.personDepthGradient ?? "signalWarm"
    ] ?? {
      from: p.accent,
      to: p.accentSignal ?? p.accentSecondary,
    };
    const gradientId = `person-depth-${component.id}`;
    const shadowId = `person-depth-shadow-${component.id}`;
    return `<defs>`
      + `<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">`
      + `<stop offset="0%" stop-color="${gradient.from}"/>`
      + `<stop offset="100%" stop-color="${gradient.to}"/>`
      + `</linearGradient>`
      + `<filter id="${shadowId}" x="-20%" y="-20%" width="140%" height="140%">`
      + `<feDropShadow dx="0" dy="${Math.max(2, height * 0.012)}" `
      + `stdDeviation="${Math.max(2, height * 0.014)}" `
      + `flood-color="${p.shadow}" flood-opacity="0.24"/>`
      + `</filter>`
      + `</defs>`
      + `<g filter="url(#${shadowId})">`
      + phrases.slice(0, 3).map((phrase, index) => textNode({
        x: x + width * (index % 2 === 0 ? 0.02 : 0.3),
        y: y + height * (0.26 + index * 0.28),
        text: lineText(phrase, 9),
        size: height * (index === 1 ? 0.27 : 0.24),
        fill: index === 1
          ? p.accentInsight ?? p.accentSecondary
          : `url(#${gradientId})`,
        family: display,
        weight: 800,
        opacity: 0.98,
        letterSpacing: -0.025,
      })).join("")
      + `</g>`;
  }
  if (component.id === "definition_term") {
    return textNode({
      x,
      y: y + height * 0.38,
      text: data.term,
      size: height * 0.32,
      fill: p.accentSecondary,
      family: display,
      weight: 800,
    })
      + textNode({
        x,
        y: y + height * 0.72,
        text: lineText(data.definition, 30),
        size: height * 0.14,
        fill: p.ink,
        family: body,
      });
  }
  const title = component.id === "quote_pull" ? `“${data.quote}”` : data.title;
  return roundedRect(x, y + height * 0.18, width * 0.035, height * 0.64, width * 0.012, p.accent)
    + textNode({
      x: x + width * 0.08,
      y: y + height * 0.53,
      text: lineText(title, 22),
      size: height * 0.28,
      fill: p.ink,
      family: display,
      weight: 800,
    })
    + (component.id === "quote_pull"
      ? textNode({
        x: x + width * 0.92,
        y: y + height * 0.78,
        text: data.source,
        size: height * 0.12,
        fill: p.inkSecondary,
        family: body,
        anchor: "end",
      })
      : "");
}

function cardRows(items, x, y, width, rowHeight, resolved, checklist = false) {
  const p = resolved.style.palette;
  return items.slice(0, 4).map((item, index) => {
    const cy = y + rowHeight * index;
    return roundedRect(x, cy, width, rowHeight * 0.78, rowHeight * 0.18, index === 0 ? p.accent : p.surface)
      + roundedRect(
        x + rowHeight * 0.18,
        cy + rowHeight * 0.21,
        rowHeight * 0.34,
        rowHeight * 0.34,
        checklist ? rowHeight * 0.17 : rowHeight * 0.08,
        checklist ? p.darkSurface : p.accentSecondary,
      )
      + textNode({
        x: x + rowHeight * 0.72,
        y: cy + rowHeight * 0.52,
        text: lineText(item, 18),
        size: rowHeight * 0.26,
        fill: index === 0 ? p.textOnAccent : p.ink,
        family: font(resolved, "body"),
        weight: index === 0 ? 700 : 500,
      });
  }).join("");
}

function editorialRows(items, x, y, width, rowHeight, resolved, checklist = false) {
  const p = resolved.style.palette;
  return items.slice(0, 4).map((item, index) => {
    const cy = y + rowHeight * index;
    const active = index === 0;
    const marker = checklist ? (active ? "✓" : "○") : String(index + 1).padStart(2, "0");
    return textNode({
      x,
      y: cy + rowHeight * 0.48,
      text: marker,
      size: rowHeight * 0.24,
      fill: active ? p.accentSignal : p.accentInsight,
      family: font(resolved, "label"),
      weight: 700,
    })
      + `<line x1="${x + rowHeight * 0.62}" y1="${cy + rowHeight * 0.52}" `
      + `x2="${x + width}" y2="${cy + rowHeight * 0.52}" stroke="${p.ink}" `
      + `stroke-opacity="${active ? 0.42 : 0.16}" stroke-width="${Math.max(1, rowHeight * 0.012)}"/>`
      + textNode({
        x: x + rowHeight * 0.74,
        y: cy + rowHeight * 0.43,
        text: lineText(item, 18),
        size: rowHeight * 0.28,
        fill: p.ink,
        family: font(resolved, "body"),
        weight: active ? 650 : 420,
      });
  }).join("");
}

function cardComponent(component, data, box, resolved) {
  const { x, y, width, height } = box;
  const p = resolved.style.palette;
  const radius = Math.min(width, height) * resolved.style.cards.cornerRadiusRatio;
  const pad = Math.min(width, height) * resolved.style.cards.paddingRatio;
  const base = roundedRect(x, y, width, height, radius, p.surfaceElevated, p.accent, Math.max(1, width * 0.003));
  const title = data.title ?? component.label;
  const heading = textNode({
    x: x + pad,
    y: y + pad + height * 0.1,
    text: lineText(title, 22),
    size: height * 0.11,
    fill: component.id === "caution_card" ? p.accentSecondary : p.ink,
    family: font(resolved, "display"),
    weight: 800,
  });
  if (component.presentation === "boundaryless_progressive") {
    return roundedRect(x, y + pad * 0.2, width * 0.012, height * 0.22, width * 0.006, p.accentSignal)
      + heading
      + editorialRows(
        normalizedList(data.items, DEFAULT_DATA.items),
        x + pad,
        y + height * 0.27,
        width - pad * 2,
        height * 0.16,
        resolved,
        component.id === "checklist_card",
      );
  }
  if (component.presentation === "full_bleed_editorial") {
    return textNode({
      x: x + pad,
      y: y + height * 0.18,
      text: "“",
      size: height * 0.38,
      fill: p.accentSignal,
      family: font(resolved, "display"),
      weight: 800,
    })
      + textNode({
        x: x + pad * 1.8,
        y: y + height * 0.52,
        text: lineText(data.quote, 26),
        size: height * 0.18,
        fill: p.ink,
        family: font(resolved, "display"),
        weight: 760,
      })
      + `<line x1="${x + pad * 1.8}" y1="${y + height * 0.7}" `
      + `x2="${x + width * 0.72}" y2="${y + height * 0.7}" stroke="${p.accentInsight}" `
      + `stroke-width="${Math.max(2, height * 0.012)}"/>`
      + textNode({
        x: x + width - pad,
        y: y + height * 0.82,
        text: data.source,
        size: height * 0.08,
        fill: p.inkSecondary,
        family: font(resolved, "label"),
        anchor: "end",
      });
  }
  if (["boundaryless_editorial", "edge_warning"].includes(component.presentation)) {
    const accent = component.presentation === "edge_warning" ? p.accentSignal : p.accentInsight;
    const main = component.id === "definition_card" ? data.term : title;
    const body = component.id === "definition_card" ? data.definition : data.body;
    return `<line x1="${x + pad * 0.4}" y1="${y + height * 0.14}" `
      + `x2="${x + pad * 0.4}" y2="${y + height * 0.78}" stroke="${accent}" `
      + `stroke-width="${Math.max(3, width * 0.008)}"/>`
      + textNode({
        x: x + pad * 1.35,
        y: y + height * 0.35,
        text: lineText(main, 20),
        size: height * 0.16,
        fill: p.ink,
        family: font(resolved, "display"),
        weight: 780,
      })
      + textNode({
        x: x + pad * 1.35,
        y: y + height * 0.58,
        text: lineText(body, 34),
        size: height * 0.095,
        fill: p.inkSecondary,
        family: font(resolved, "body"),
      })
      + (component.id === "definition_card" && data.boundary
        ? textNode({
          x: x + pad * 1.35,
          y: y + height * 0.76,
          text: `边界：${lineText(data.boundary, 26)}`,
          size: height * 0.07,
          fill: accent,
          family: font(resolved, "label"),
        })
        : "");
  }
  if (component.presentation === "split_evidence") {
    const left = data.left ?? data.before;
    const right = data.right ?? data.after;
    return heading
      + `<line x1="${x + width * 0.5}" y1="${y + height * 0.3}" `
      + `x2="${x + width * 0.5}" y2="${y + height * 0.76}" stroke="${p.ink}" `
      + `stroke-opacity="0.2" stroke-width="${Math.max(1, width * 0.002)}"/>`
      + textNode({
        x: x + width * 0.24,
        y: y + height * 0.58,
        text: left,
        size: height * 0.18,
        fill: p.inkSecondary,
        family: font(resolved, "display"),
        weight: 650,
        anchor: "middle",
      })
      + textNode({
        x: x + width * 0.76,
        y: y + height * 0.58,
        text: right,
        size: height * 0.18,
        fill: p.accentSignal,
        family: font(resolved, "display"),
        weight: 780,
        anchor: "middle",
      })
      + textNode({
        x: x + width * 0.5,
        y: y + height * 0.88,
        text: data.criteria,
        size: height * 0.075,
        fill: p.inkSecondary,
        family: font(resolved, "label"),
        anchor: "middle",
      });
  }
  if (component.presentation === "boundaryless_metric") {
    return heading
      + textNode({
        x: x + width * 0.72,
        y: y + height * 0.58,
        text: data.score,
        size: height * 0.36,
        fill: p.accentSignal,
        family: font(resolved, "display"),
        weight: 800,
        anchor: "middle",
      })
      + editorialRows(
        normalizedList(data.dimensions),
        x + pad,
        y + height * 0.28,
        width * 0.45,
        height * 0.15,
        resolved,
      );
  }
  if (component.presentation === "bounded_source") {
    const plateX = x + pad;
    const plateY = y + height * 0.49;
    const plateWidth = width * 0.62;
    const plateHeight = height * 0.27;
    return textNode({
      x: x + pad,
      y: y + height * 0.28,
      text: lineText(title, 22),
      size: height * 0.105,
      fill: p.ink,
      family: font(resolved, "display"),
      weight: 780,
    })
      + `<rect x="${plateX}" y="${plateY}" width="${plateWidth}" height="${plateHeight}" `
      + `rx="${Math.max(2, height * 0.012)}" fill="${p.surface}" fill-opacity="0.92"/>`
      + `<line x1="${plateX}" y1="${plateY}" x2="${plateX + plateWidth * 0.22}" `
      + `y2="${plateY}" stroke="${p.accentInsight}" stroke-width="${Math.max(3, height * 0.012)}"/>`
      + textNode({
        x: plateX + pad * 0.7,
        y: plateY + plateHeight * 0.43,
        text: lineText(data.source, 30),
        size: height * 0.07,
        fill: p.ink,
        family: font(resolved, "body"),
      })
      + textNode({
        x: plateX + pad * 0.7,
        y: plateY + plateHeight * 0.76,
        text: `${data.date} · ${data.scope}`,
        size: height * 0.052,
        fill: p.inkSecondary,
        family: font(resolved, "label"),
      });
  }
  if (["comparison_card", "before_after_card"].includes(component.id)) {
    const left = data.left ?? data.before;
    const right = data.right ?? data.after;
    const top = y + height * 0.28;
    const paneWidth = (width - pad * 3) / 2;
    return base + heading
      + roundedRect(x + pad, top, paneWidth, height * 0.48, radius * 0.65, p.surface)
      + roundedRect(x + pad * 2 + paneWidth, top, paneWidth, height * 0.48, radius * 0.65, p.accent)
      + textNode({
        x: x + pad + paneWidth / 2,
        y: top + height * 0.28,
        text: left,
        size: height * 0.16,
        fill: p.inkSecondary,
        family: font(resolved, "label"),
        weight: 700,
        anchor: "middle",
      })
      + textNode({
        x: x + pad * 2 + paneWidth * 1.5,
        y: top + height * 0.28,
        text: right,
        size: height * 0.16,
        fill: p.textOnAccent,
        family: font(resolved, "label"),
        weight: 800,
        anchor: "middle",
      })
      + textNode({
        x: x + width / 2,
        y: y + height * 0.9,
        text: data.criteria,
        size: height * 0.075,
        fill: p.inkSecondary,
        family: font(resolved, "body"),
        anchor: "middle",
      });
  }
  if (component.id === "score_card") {
    return base + heading
      + textNode({
        x: x + width * 0.76,
        y: y + height * 0.57,
        text: data.score,
        size: height * 0.34,
        fill: p.accent,
        family: font(resolved, "display"),
        weight: 800,
        anchor: "middle",
      })
      + cardRows(normalizedList(data.dimensions), x + pad, y + height * 0.28, width * 0.48, height * 0.15, resolved);
  }
  if (["quote_card", "definition_card"].includes(component.id)) {
    const main = component.id === "quote_card" ? `“${data.quote}”` : data.term;
    const sub = component.id === "quote_card" ? data.source : data.definition;
    return base + heading
      + textNode({
        x: x + pad,
        y: y + height * 0.5,
        text: lineText(main, 24),
        size: height * 0.16,
        fill: p.ink,
        family: font(resolved, "display"),
        weight: 700,
      })
      + textNode({
        x: x + pad,
        y: y + height * 0.72,
        text: lineText(sub, 34),
        size: height * 0.09,
        fill: p.inkSecondary,
        family: font(resolved, "body"),
      });
  }
  if (["bullet_card", "three_reason_card", "checklist_card"].includes(component.id)) {
    return base + heading + cardRows(
      normalizedList(data.items, DEFAULT_DATA.items),
      x + pad,
      y + height * 0.27,
      width - pad * 2,
      height * 0.16,
      resolved,
      component.id === "checklist_card",
    );
  }
  return base + heading
    + textNode({
      x: x + pad,
      y: y + height * 0.48,
      text: lineText(data.body, 36),
      size: height * 0.115,
      fill: p.ink,
      family: font(resolved, "body"),
      weight: 500,
    })
    + roundedRect(x + pad, y + height * 0.68, width * 0.32, height * 0.045, 2, p.accent);
}

function layoutComponent(component, data, box, resolved) {
  const { x, y, width, height } = box;
  const p = resolved.style.palette;
  const gap = Math.min(width, height) * 0.035;
  if (component.id.startsWith("pip_")) {
    const shape = component.id.slice(4);
    const base = mediaPlaceholder(x, y, width, height, p, "A-ROLL");
    const pipW = width * 0.38;
    const pipH = shape === "rect" ? height * 0.38 : Math.min(pipW, height * 0.48);
    const px = x + width - pipW - gap;
    const py = y + gap;
    const radius = shape === "circle"
      ? pipH / 2
      : shape === "square"
        ? resolved.style.pip.cornerRadiusRatio * width
        : shape === "irregular"
          ? pipH * 0.24
          : resolved.style.pip.cornerRadiusRatio * width;
    return base
      + roundedRect(px - gap * 0.22, py - gap * 0.22, pipW + gap * 0.44, pipH + gap * 0.44, radius, p.surfaceElevated)
      + mediaPlaceholder(px, py, pipW, pipH, p, shape.toUpperCase());
  }
  if (component.id === "split_vertical") {
    return mediaPlaceholder(x, y, width / 2 - gap / 2, height, p, "LEFT")
      + mediaPlaceholder(x + width / 2 + gap / 2, y, width / 2 - gap / 2, height, p, "RIGHT");
  }
  if (component.id === "split_horizontal") {
    return mediaPlaceholder(x, y, width, height / 2 - gap / 2, p, "TOP")
      + mediaPlaceholder(x, y + height / 2 + gap / 2, width, height / 2 - gap / 2, p, "BOTTOM");
  }
  if (component.id === "grid_2x2") {
    return [0, 1, 2, 3].map((index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      return mediaPlaceholder(
        x + column * (width / 2 + gap / 2),
        y + row * (height / 2 + gap / 2),
        width / 2 - gap / 2,
        height / 2 - gap / 2,
        p,
        String(index + 1),
      );
    }).join("");
  }
  if (component.id === "subject_safe_popup") {
    return subjectPlaceholder(
      x,
      y,
      width * 0.42,
      height,
      p,
      resolved.selectedModes.surface,
    )
      + `<line x1="${x + width * 0.5}" y1="${y + height * 0.18}" `
      + `x2="${x + width * 0.5}" y2="${y + height * 0.68}" stroke="${p.accentInsight}" `
      + `stroke-width="${Math.max(3, width * 0.006)}"/>`
      + textNode({
        x: x + width * 0.53,
        y: y + height * 0.34,
        text: lineText(data.title, 12),
        size: height * 0.13,
        fill: p.ink,
        family: font(resolved, "display"),
        weight: 800,
      })
      + textNode({
        x: x + width * 0.53,
        y: y + height * 0.52,
        text: lineText(data.body, 24),
        size: height * 0.08,
        fill: p.inkSecondary,
        family: font(resolved, "body"),
      });
  }
  if (component.id === "screen_focus_callout") {
    return mediaPlaceholder(x, y, width, height, p, data.screen)
      + `<circle cx="${x + width * 0.68}" cy="${y + height * 0.42}" `
      + `r="${Math.min(width, height) * 0.13}" fill="none" stroke="${p.accent}" `
      + `stroke-width="${Math.max(3, width * 0.008)}"/>`
      + textNode({
        x: x + width * 0.68,
        y: y + height * 0.46,
        text: data.label,
        size: height * 0.1,
        fill: p.ink,
        family: font(resolved, "label"),
        weight: 800,
        anchor: "middle",
      });
  }
  return mediaPlaceholder(x, y, width, height, p, data.media ?? "FULL SCREEN");
}

function dataComponent(component, data, box, resolved) {
  const { x, y, width, height } = box;
  const p = resolved.style.palette;
  const title = component.id === "progress_node" ? "" : textNode({
    x,
    y: y + height * 0.11,
    text: lineText(data.title ?? component.label, 22),
    size: height * 0.1,
    fill: p.ink,
    family: font(resolved, "display"),
    weight: 800,
  });
  if (component.id === "progress_node") {
    const nodes = normalizedList(data.nodes, DEFAULT_DATA.nodes).slice(0, 7);
    const activeIndex = Math.min(3, nodes.length - 1);
    return roundedRect(
      x + width * 0.08,
      y + height * 0.2,
      width * 0.84,
      height * 0.56,
      height * 0.09,
      p.surfaceElevated,
      p.accent,
      Math.max(2, height * 0.012),
    )
      + roundedRect(
        x + width * 0.12,
        y + height * 0.3,
        height * 0.34,
        height * 0.34,
        height * 0.17,
        p.accent,
      )
      + textNode({
        x: x + width * 0.12 + height * 0.17,
        y: y + height * 0.515,
        text: String(activeIndex + 1).padStart(2, "0"),
        size: height * 0.17,
        fill: p.textOnAccent,
        family: font(resolved, "display"),
        weight: 800,
        anchor: "middle",
      })
      + textNode({
        x: x + width * 0.12 + height * 0.42,
        y: y + height * 0.43,
        text: nodes[activeIndex],
        size: height * 0.15,
        fill: p.ink,
        family: font(resolved, "display"),
        weight: 800,
      })
      + textNode({
        x: x + width * 0.12 + height * 0.42,
        y: y + height * 0.59,
        text: `${activeIndex + 1} / ${nodes.length} · 当前节点`,
        size: height * 0.075,
        fill: p.inkSecondary,
        family: font(resolved, "label"),
        weight: 600,
      });
  }
  if (component.id === "process_flow") {
    const nodes = normalizedList(data.nodes, DEFAULT_DATA.nodes).slice(0, 7);
    const gap = width / nodes.length;
    return title + nodes.map((node, index) => {
      const cx = x + gap * (index + 0.5);
      const cy = y + height * 0.55;
      const active = index === Math.min(3, nodes.length - 1);
      const previous = index < Math.min(3, nodes.length - 1);
      return (index > 0
        ? `<line x1="${cx - gap * 0.72}" y1="${cy}" x2="${cx - gap * 0.28}" y2="${cy}" `
          + `stroke="${previous ? p.darkSurface : p.inkSecondary}" stroke-width="${Math.max(2, height * 0.015)}"/>`
        : "")
        + `<circle cx="${cx}" cy="${cy}" r="${height * 0.1}" `
        + `fill="${active ? p.accent : previous ? p.darkSurface : p.surface}" `
        + `stroke="${p.accent}" stroke-width="${Math.max(1, height * 0.01)}"/>`
        + textNode({
          x: cx,
          y: cy + height * 0.25,
          text: node,
          size: height * 0.07,
          fill: p.ink,
          family: font(resolved, "label"),
          weight: active ? 800 : 500,
          anchor: "middle",
        });
    }).join("");
  }
  if (component.id === "timeline") {
    const events = normalizedList(data.events, DEFAULT_DATA.events);
    return title
      + `<line x1="${x + width * 0.08}" y1="${y + height * 0.58}" `
      + `x2="${x + width * 0.92}" y2="${y + height * 0.58}" stroke="${p.inkSecondary}" `
      + `stroke-width="${Math.max(2, height * 0.018)}"/>`
      + events.map((event, index) => {
        const cx = x + width * (0.16 + index * 0.34);
        return `<circle cx="${cx}" cy="${y + height * 0.58}" r="${height * 0.07}" fill="${index === 1 ? p.accent : p.darkSurface}"/>`
          + textNode({
            x: cx,
            y: y + height * 0.78,
            text: event,
            size: height * 0.075,
            fill: p.ink,
            family: font(resolved, "label"),
            anchor: "middle",
          });
      }).join("");
  }
  if (component.id === "bar_chart") {
    const values = normalizedList(data.seriesData, DEFAULT_DATA.seriesData).map(Number);
    return title + values.map((value, index) => {
      const barWidth = width * 0.12;
      const barHeight = height * 0.56 * Math.max(0.05, value / 100);
      const bx = x + width * 0.12 + index * width * 0.2;
      const by = y + height * 0.82 - barHeight;
      return roundedRect(bx, by, barWidth, barHeight, barWidth * 0.18, index === 2 ? p.accent : p.accentSecondary)
        + textNode({
          x: bx + barWidth / 2,
          y: by - height * 0.035,
          text: `${value}`,
          size: height * 0.065,
          fill: p.ink,
          family: font(resolved, "label"),
          anchor: "middle",
        });
    }).join("");
  }
  if (component.id === "line_chart") {
    const values = normalizedList(data.seriesData, DEFAULT_DATA.seriesData).map(Number);
    const points = values.map((value, index) => (
      `${x + width * (0.12 + index * 0.24)},${y + height * (0.8 - value / 145)}`
    )).join(" ");
    return title + `<polyline points="${points}" fill="none" stroke="${p.accent}" `
      + `stroke-width="${Math.max(3, height * 0.025)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (component.id === "donut_chart") {
    const radius = Math.min(width, height) * 0.23;
    const circumference = 2 * Math.PI * radius;
    return title
      + `<circle cx="${x + width * 0.35}" cy="${y + height * 0.55}" r="${radius}" `
      + `fill="none" stroke="${p.surface}" stroke-width="${radius * 0.42}"/>`
      + `<circle cx="${x + width * 0.35}" cy="${y + height * 0.55}" r="${radius}" `
      + `fill="none" stroke="${p.accent}" stroke-width="${radius * 0.42}" `
      + `stroke-dasharray="${circumference * 0.68} ${circumference}" transform="rotate(-90 ${x + width * 0.35} ${y + height * 0.55})"/>`
      + textNode({
        x: x + width * 0.72,
        y: y + height * 0.58,
        text: "68%",
        size: height * 0.25,
        fill: p.ink,
        family: font(resolved, "display"),
        weight: 800,
        anchor: "middle",
      });
  }
  if (component.id === "metric_grid") {
    const metrics = normalizedList(data.metrics, DEFAULT_DATA.metrics).slice(0, 4);
    return title + metrics.map((metric, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const bx = x + column * width * 0.5;
      const by = y + height * (0.24 + row * 0.34);
      return roundedRect(bx, by, width * 0.44, height * 0.25, height * 0.04, index === 0 ? p.accent : p.surface)
        + textNode({
          x: bx + width * 0.22,
          y: by + height * 0.15,
          text: metric,
          size: height * 0.09,
          fill: index === 0 ? p.textOnAccent : p.ink,
          family: font(resolved, "label"),
          weight: 700,
          anchor: "middle",
        });
    }).join("");
  }
  if (component.id === "evidence_ladder") {
    const levels = normalizedList(data.levels, DEFAULT_DATA.levels);
    return title + levels.map((level, index) => roundedRect(
      x + width * (0.08 + index * 0.2),
      y + height * (0.72 - index * 0.12),
      width * 0.16,
      height * (0.12 + index * 0.12),
      height * 0.025,
      index === levels.length - 1 ? p.accent : p.surface,
    ) + textNode({
      x: x + width * (0.16 + index * 0.2),
      y: y + height * 0.84,
      text: level,
      size: height * 0.065,
      fill: index === levels.length - 1 ? p.textOnAccent : p.ink,
      family: font(resolved, "label"),
      anchor: "middle",
    })).join("");
  }
  if (component.id === "decision_tree") {
    const branches = normalizedList(data.branches, DEFAULT_DATA.branches);
    const rootX = x + width / 2;
    const rootY = y + height * 0.3;
    return title
      + roundedRect(rootX - width * 0.15, rootY, width * 0.3, height * 0.16, height * 0.04, p.accent)
      + textNode({
        x: rootX,
        y: rootY + height * 0.105,
        text: data.question,
        size: height * 0.07,
        fill: p.textOnAccent,
        family: font(resolved, "label"),
        weight: 700,
        anchor: "middle",
      })
      + branches.map((branch, index) => {
        const cx = x + width * (0.18 + index * 0.32);
        const cy = y + height * 0.72;
        return `<line x1="${rootX}" y1="${rootY + height * 0.16}" x2="${cx}" y2="${cy}" stroke="${p.inkSecondary}" stroke-width="${Math.max(2, height * 0.012)}"/>`
          + roundedRect(cx - width * 0.1, cy, width * 0.2, height * 0.13, height * 0.03, p.surface)
          + textNode({
            x: cx,
            y: cy + height * 0.09,
            text: branch,
            size: height * 0.065,
            fill: p.ink,
            family: font(resolved, "label"),
            anchor: "middle",
          });
      }).join("");
  }
  const causes = normalizedList(data.causes, DEFAULT_DATA.causes);
  return title + causes.map((cause, index) => roundedRect(
    x + width * 0.03,
    y + height * (0.3 + index * 0.25),
    width * 0.3,
    height * 0.16,
    height * 0.04,
    p.surface,
  ) + textNode({
    x: x + width * 0.18,
    y: y + height * (0.4 + index * 0.25),
    text: cause,
    size: height * 0.07,
    fill: p.ink,
    family: font(resolved, "label"),
    anchor: "middle",
  })).join("")
    + `<path d="M ${x + width * 0.36} ${y + height * 0.51} L ${x + width * 0.64} ${y + height * 0.51}" stroke="${p.accent}" stroke-width="${Math.max(3, height * 0.02)}"/>`
    + roundedRect(x + width * 0.67, y + height * 0.36, width * 0.28, height * 0.3, height * 0.05, p.accent)
    + textNode({
      x: x + width * 0.81,
      y: y + height * 0.53,
      text: data.effect,
      size: height * 0.1,
      fill: p.textOnAccent,
      family: font(resolved, "display"),
      weight: 800,
      anchor: "middle",
    });
}

export function renderComponentFragment(component, resolved, {
  box,
  data = {},
  state = null,
} = {}) {
  const safeBox = {
    x: number(box?.x),
    y: number(box?.y),
    width: Math.max(1, number(box?.width, 640)),
    height: Math.max(1, number(box?.height, 240)),
  };
  const merged = componentData(component, data, resolved);
  const body = component.category === "brand"
    ? brandComponent(component, merged, safeBox, resolved)
    : component.category === "subtitle"
      ? subtitleComponent(component, merged, safeBox, resolved)
      : component.category === "text"
        ? textComponent(component, merged, safeBox, resolved)
        : component.category === "card"
          ? cardComponent(component, merged, safeBox, resolved)
          : component.category === "layout"
            ? layoutComponent(component, merged, safeBox, resolved)
            : dataComponent(component, merged, safeBox, resolved);
  return `<g data-component-id="${xml(component.id)}" `
    + `data-renderer="${xml(component.renderer)}" `
    + `data-state="${xml(state ?? component.states[0])}">${body}</g>`;
}

function sceneBoxes(scene, resolved, width, height) {
  const margin = width * (resolved.layout.outerMarginRatio ?? 0.05);
  const top = height * (resolved.layout.platformUiExclusion?.top ?? 0.04);
  const bottom = height * (resolved.layout.platformUiExclusion?.bottom ?? 0.1);
  const available = {
    x: margin,
    y: Math.max(margin, top),
    width: width - margin * 2,
    height: height - Math.max(margin, top) - Math.max(margin, bottom),
  };
  const template = resolved.implementations.layouts.find(
    (item) => item.id === scene.layout,
  )?.template;
  const subjectLeft = [
    "subject_left",
    "subject_safe_right",
    "subject_safe_side",
    "subject_meter",
    "subject_top_label",
  ].includes(template);
  const subjectRight = ["subject_right", "editorial_left"].includes(template);
  const fullScreen = [
    "full_screen",
    "full_bleed",
    "terminal",
    "screen_focus",
  ].includes(template);
  let subject = null;
  let content = { ...available };
  const coverScene = scene.category === "cover";
  const cover = resolved.style.cover ?? {};
  if (
    coverScene
    && !fullScreen
    && !["split", "split_subject_aware"].includes(template)
  ) {
    const subjectHeightRatio = Math.min(
      Number(cover.subjectMaximumHeightRatio ?? 0.48),
      Math.max(
        Number(cover.subjectMinimumHeightRatio ?? 0.32),
        Number(cover.subjectHeightRatio ?? 0.44),
      ),
    );
    const subjectWidthRatio = Number(cover.subjectWidthRatio ?? 0.27);
    subject = {
      x: available.x + available.width * (1 - subjectWidthRatio),
      y: available.y + available.height * (1 - subjectHeightRatio),
      width: available.width * subjectWidthRatio,
      height: available.height * subjectHeightRatio,
    };
    content = {
      x: available.x,
      y: available.y,
      width: available.width * Number(cover.titleMaximumWidthRatio ?? 0.56),
      height: available.height,
    };
  } else if (!fullScreen && subjectLeft) {
    subject = {
      x: available.x,
      y: available.y + available.height * 0.08,
      width: available.width * 0.34,
      height: available.height * 0.84,
    };
    content = {
      x: available.x + available.width * 0.4,
      y: available.y,
      width: available.width * 0.6,
      height: available.height,
    };
  } else if (!fullScreen && subjectRight) {
    subject = {
      x: available.x + available.width * 0.64,
      y: available.y + available.height * 0.08,
      width: available.width * 0.34,
      height: available.height * 0.84,
    };
    content = {
      x: available.x,
      y: available.y,
      width: available.width * 0.58,
      height: available.height,
    };
  } else if (!fullScreen && !["split", "split_subject_aware", "screen_pip"].includes(template)) {
    subject = {
      x: available.x + available.width * 0.66,
      y: available.y + available.height * 0.12,
      width: available.width * 0.3,
      height: available.height * 0.74,
    };
    content = {
      x: available.x,
      y: available.y,
      width: available.width * 0.6,
      height: available.height,
    };
  }
  return { available, subject, content, template };
}

function implementationPlan(component, resolved) {
  const renderer = resolved.implementations.renderers.find(
    (item) => item.id === component.renderer,
  );
  const plan = {
    componentId: component.id,
    rendererId: component.renderer,
    adapter: renderer.adapter,
    requiresMedia: renderer.requiresMedia,
    outputs: renderer.outputs,
    states: component.states,
    safety: component.safety,
    tokenRefs: component.tokenRefs,
    fallbackChain: resolveFallback(resolved.components, component.id),
  };
  if (renderer.adapter === "overlay") {
    plan.filtergraphTemplate = "[pip]scale={w}:{h}:force_original_aspect_ratio=decrease[p];[base][p]overlay={x}:{y}";
  } else if (renderer.adapter === "xstack") {
    plan.filtergraphTemplate = "xstack=inputs={count}:layout={subject_aware_layout}:fill={surface}";
  } else if (renderer.adapter === "mask_composite") {
    plan.filtergraphTemplate = "[layer][mask]alphamerge[masked];[base][masked]overlay={x}:{y}";
  } else if (renderer.adapter === "timeline") {
    plan.timelineTemplate = "replace A-roll for activeInterval; clear overlays before return";
  }
  return plan;
}

export function renderSceneArtifact(scene, resolved, {
  width = 1280,
  height = 720,
  state = "peak",
  data = {},
  showGuides = true,
} = {}) {
  const p = resolved.style.palette;
  const { available, subject, content, template } = sceneBoxes(
    scene,
    resolved,
    width,
    height,
  );
  const componentGap = Math.max(10, content.height * 0.025);
  const components = scene.components.map(
    (id) => resolved.components.find((item) => item.id === id),
  );
  const componentHeight = Math.max(
    56,
    (content.height - componentGap * Math.max(0, components.length - 1))
      / Math.max(1, components.length),
  );
  const fragments = components.map((component, index) => renderComponentFragment(
    component,
    resolved,
    {
      box: {
        x: content.x,
        y: content.y + index * (componentHeight + componentGap),
        width: content.width,
        height: componentHeight,
      },
      data: data[component.id] ?? data,
      state,
    },
  )).join("");
  const guide = showGuides
    ? `<g data-role="guides" opacity="0.35">`
      + `<rect x="${available.x}" y="${available.y}" width="${available.width}" `
      + `height="${available.height}" fill="none" stroke="${p.inkSecondary}" `
      + `stroke-dasharray="8 8"/>`
      + `<line x1="0" y1="${height * resolved.style.subtitles.baselineYRatio}" `
      + `x2="${width}" y2="${height * resolved.style.subtitles.baselineYRatio}" `
      + `stroke="${p.accent}" stroke-dasharray="6 8"/>`
      + "</g>"
    : "";
  const metadata = {
    designSystemId: resolved.system.id,
    designSystemVersion: resolved.system.version,
    designDigest: resolved.digest,
    implementationDigest: resolved.implementationDigest,
    rendererCodeSha256: resolved.rendererCodeSha256,
    sceneId: scene.id,
    layoutId: scene.layout,
    layoutTemplate: template,
    componentIds: scene.components,
    modeSelection: resolved.selectedModes,
    state,
    resolvedFonts: Object.fromEntries(
      Object.entries(resolved.fonts.roles).map(([role, value]) => [role, value.resolved]),
    ),
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}" data-scene-id="${xml(scene.id)}">`
    + `<metadata>${xml(JSON.stringify(metadata))}</metadata>`
    + (resolved.selectedModes.surface === "footage"
      ? editorialFootageBackdrop(width, height, p)
      : roundedRect(0, 0, width, height, 0, p.canvas))
    + (["full_bleed", "screen_pip", "screen_focus"].includes(template)
      ? mediaPlaceholder(0, 0, width, height, p, "PRIMARY MEDIA")
      : "")
    + guide
    + fragments
    + (
      subject
        ? subjectPlaceholder(
          subject.x,
          subject.y,
          subject.width,
          subject.height,
          p,
          resolved.selectedModes.surface,
        )
        : ""
    )
    + "</svg>";
  return {
    svg,
    manifest: {
      schemaVersion: "1.0",
      status: "rendered",
      ...metadata,
      fontResolution: resolved.fonts,
      scene: {
        trigger: scene.trigger,
        entry: scene.entry,
        exit: scene.exit,
        fallbackChain: resolveFallback(resolved.scenes, scene.id),
      },
      components: components.map((component) => implementationPlan(component, resolved)),
      qc: {
        stateRendered: state,
        guidesRendered: showGuides,
        textOverflowPolicy: "truncate_with_ellipsis",
        fullFrameFlashPolicy: resolved.style.motion.fullScreenFlashPolicy,
      },
    },
  };
}

export function renderComponentArtifact(component, resolved, {
  width = 960,
  height = 540,
  state = null,
  data = {},
} = {}) {
  const p = resolved.style.palette;
  const margin = Math.min(width, height) * 0.08;
  const actualState = state ?? component.states[Math.min(1, component.states.length - 1)];
  const fragment = renderComponentFragment(component, resolved, {
    box: {
      x: margin,
      y: margin,
      width: width - margin * 2,
      height: height - margin * 2,
    },
    data,
    state: actualState,
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}" data-component-preview="${xml(component.id)}">`
    + roundedRect(0, 0, width, height, 0, p.canvas)
    + fragment
    + "</svg>";
  return {
    svg,
    manifest: {
      schemaVersion: "1.0",
      status: "rendered",
      designSystemId: resolved.system.id,
      designSystemVersion: resolved.system.version,
      designDigest: resolved.digest,
      implementationDigest: resolved.implementationDigest,
      rendererCodeSha256: resolved.rendererCodeSha256,
      componentId: component.id,
      state: actualState,
      modeSelection: resolved.selectedModes,
      resolvedFonts: Object.fromEntries(
        Object.entries(resolved.fonts.roles).map(([role, value]) => [role, value.resolved]),
      ),
      implementation: implementationPlan(component, resolved),
    },
  };
}

function assColor(hex, alpha = "00") {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return `&H${alpha}FFFFFF`;
  return `&H${alpha}${match[3]}${match[2]}${match[1]}`;
}

export function renderAssSubtitle(component, resolved, {
  width = 1920,
  height = 1080,
  data = {},
  start = "0:00:00.00",
  end = "0:00:04.00",
} = {}) {
  if (component.renderer !== "ass_svg") {
    throw new Error(`${component.id} 不是 ASS 字幕组件`);
  }
  const values = componentData(component, data, resolved);
  const style = resolved.style;
  const light = resolved.selectedModes.surface === "light";
  const primary = light
    ? style.subtitles.lightSurfaceVariant.primaryColor
    : style.subtitles.primaryColor ?? style.palette.textOnDark;
  const fontName = resolved.fonts.roles.subtitlePrimary.resolved;
  const fontSize = Math.round(width * style.typography.subtitlePrimary.sizeRatio);
  const marginV = Math.max(20, Math.round(height * (1 - style.subtitles.baselineYRatio)));
  const primaryText = component.id === "subtitle_quote"
    ? values.quote
    : values.primary;
  const secondary = component.id === "subtitle_bilingual"
    ? `\\N{\\fs${Math.round(fontSize * 0.72)}}${values.secondary}`
    : "";
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: KachaPrimary,${fontName},${fontSize},${assColor(primary)},${assColor(primary)},${assColor(style.subtitles.shadow.color, "66")},${assColor(style.subtitles.shadow.color, "66")},0,0,0,0,100,100,0,0,1,0,2,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${start},${end},KachaPrimary,,0,0,0,,${primaryText}${secondary}
`;
}

export function validateRenderArtifact(artifact, expectedIds = []) {
  const errors = [];
  if (!artifact?.svg?.includes("<svg")) errors.push("渲染结果缺少 SVG");
  if (artifact?.manifest?.status !== "rendered") {
    errors.push("渲染清单状态不是 rendered");
  }
  if (/undefined|null<\/text>/.test(artifact?.svg ?? "")) {
    errors.push("渲染结果包含未解析值");
  }
  for (const id of expectedIds) {
    if (!artifact.svg.includes(id)) errors.push(`渲染结果缺少 ${id}`);
  }
  if (!artifact?.manifest?.designDigest) errors.push("渲染清单缺少 designDigest");
  if (!artifact?.manifest?.implementationDigest) {
    errors.push("渲染清单缺少 implementationDigest");
  }
  if (!artifact?.manifest?.rendererCodeSha256) {
    errors.push("渲染清单缺少 rendererCodeSha256");
  }
  if (!artifact?.manifest?.resolvedFonts) errors.push("渲染清单缺少 resolvedFonts");
  if (
    artifact?.manifest?.implementation
    && !artifact.manifest.implementation.adapter
  ) {
    errors.push("组件实施清单缺少 adapter");
  }
  const ids = [...String(artifact?.svg ?? "").matchAll(/\sid="([^"]+)"/g)]
    .map((match) => match[1]);
  if (new Set(ids).size !== ids.length) {
    errors.push("SVG 包含重复 id，组合渲染会产生定义冲突");
  }
  return errors;
}

function srgbLuminance(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return null;
  const channels = match.slice(1).map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrastRatio(foreground, background) {
  const left = srgbLuminance(foreground);
  const right = srgbLuminance(background);
  if (left === null || right === null) return null;
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

export function validateDesignContrast(resolved) {
  const p = resolved.style.palette;
  const checks = [
    ["palette.ink", p.ink, "palette.canvas", p.canvas, 4.5],
    ["palette.inkSecondary", p.inkSecondary, "palette.surface", p.surface, 4.5],
    ["palette.textOnDark", p.textOnDark, "palette.darkSurface", p.darkSurface, 4.5],
    ["palette.textOnAccent", p.textOnAccent, "palette.accent", p.accent, 4.5],
  ];
  if (resolved.selectedModes.surface !== "dark") {
    checks.push(
      ["palette.textOnLight", p.textOnLight, "palette.surface", p.surface, 4.5],
      [
        "palette.secondaryTextOnLight",
        p.secondaryTextOnLight,
        "palette.surface",
        p.surface,
        4.5,
      ],
    );
  }
  const results = checks.map(([foregroundName, foreground, backgroundName, background, minimum]) => {
    const ratio = contrastRatio(foreground, background);
    return {
      foregroundName,
      foreground,
      backgroundName,
      background,
      ratio,
      minimum,
      status: ratio !== null && ratio >= minimum ? "pass" : "fail",
    };
  });
  return {
    status: results.every((item) => item.status === "pass") ? "pass" : "fail",
    checks: results,
    errors: results
      .filter((item) => item.status === "fail")
      .map(
        (item) =>
          `${item.foregroundName}/${item.backgroundName} 对比度 `
            + `${item.ratio?.toFixed(2) ?? "invalid"} 低于 ${item.minimum}`,
      ),
  };
}
