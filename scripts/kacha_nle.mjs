#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  fileIdentity,
  readJson,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function ensureFile(file, label) {
  const resolved = path.resolve(file ?? "");
  if (!file || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label}不存在：${resolved}`);
  }
  return resolved;
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function stableDigest(value) {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  delete copy.digest;
  return sha256Value(copy);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(value) {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function frames(seconds, fps) {
  return Math.round(Number(seconds) * fps);
}

function rational(frameCount, fps) {
  return `${frameCount}/${fps}s`;
}

function timecode(frameCount, fps) {
  const roundedFps = Math.round(fps);
  const totalSeconds = Math.floor(frameCount / roundedFps);
  const ff = frameCount % roundedFps;
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return [hh, mm, ss, ff].map((value) => String(value).padStart(2, "0")).join(":");
}

function clipRows(timeline) {
  const fps = Number(timeline.output?.fps ?? 25);
  if (!(fps > 0)) throw new Error("Timeline output.fps 无效");
  let outputFrame = 0;
  return {
    fps,
    clips: (timeline.edl ?? []).map((clip, index) => {
      const sourceStartFrame = frames(clip.sourceStart, fps);
      const sourceEndFrame = frames(clip.sourceEnd, fps);
      if (sourceEndFrame <= sourceStartFrame) throw new Error(`edl[${index}] 区间无效`);
      const durationFrames = sourceEndFrame - sourceStartFrame;
      const result = {
        id: String(clip.id ?? `clip-${String(index + 1).padStart(4, "0")}`),
        sourceStartFrame,
        durationFrames,
        outputStartFrame: outputFrame,
        metadata: {
          kachaId: String(clip.id ?? `clip-${index + 1}`),
          sourceDecisionId: clip.sourceDecisionId ?? null,
          semanticBeatId: clip.semanticBeatId ?? null,
          reason: clip.reason ?? null,
        },
      };
      outputFrame += durationFrames;
      return result;
    }),
    durationFrames: outputFrame,
  };
}

function timelineSource(timelineFile, timeline) {
  const candidate = typeof timeline.source === "string" ? timeline.source : timeline.source?.path;
  const source = path.resolve(path.dirname(timelineFile), candidate ?? "");
  if (!candidate || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Timeline source 不存在：${source}`);
  }
  return source;
}

function otioExport(timelineFile, timeline) {
  const source = timelineSource(timelineFile, timeline);
  const { fps, clips, durationFrames } = clipRows(timeline);
  const sourceFrames = Math.max(...clips.map((clip) => clip.sourceStartFrame + clip.durationFrames));
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: timeline.projectId ?? "Kacha Timeline",
    global_start_time: null,
    metadata: {
      kacha: {
        schemaVersion: "1.0",
        timelineSha256: fileIdentity(timelineFile).sha256,
        semanticIdsPreserved: true,
        importCreatesCandidateOnly: true,
      },
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      metadata: {},
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          name: "Kacha V1",
          kind: "Video",
          metadata: {},
          children: clips.map((clip) => ({
            OTIO_SCHEMA: "Clip.2",
            name: clip.id,
            metadata: { kacha: clip.metadata },
            source_range: {
              OTIO_SCHEMA: "TimeRange.1",
              start_time: { OTIO_SCHEMA: "RationalTime.1", value: clip.sourceStartFrame, rate: fps },
              duration: { OTIO_SCHEMA: "RationalTime.1", value: clip.durationFrames, rate: fps },
            },
            media_reference: {
              OTIO_SCHEMA: "ExternalReference.1",
              name: path.basename(source),
              target_url: pathToFileURL(source).href,
              available_range: {
                OTIO_SCHEMA: "TimeRange.1",
                start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: fps },
                duration: { OTIO_SCHEMA: "RationalTime.1", value: sourceFrames, rate: fps },
              },
              metadata: { kachaSourceSha256: timeline.source?.sha256 ?? null },
            },
          })),
        },
      ],
    },
    duration: { value: durationFrames, rate: fps },
  };
}

function fcpxmlExport(timelineFile, timeline) {
  const source = timelineSource(timelineFile, timeline);
  const { fps, clips, durationFrames } = clipRows(timeline);
  const formatId = "r1";
  const assetId = "r2";
  const clipXml = clips.map((clip) => {
    const metadata = Buffer.from(JSON.stringify(clip.metadata), "utf8").toString("base64");
    return [
      `            <asset-clip name="${xmlEscape(clip.id)}" ref="${assetId}"`,
      ` offset="${rational(clip.outputStartFrame, fps)}"`,
      ` start="${rational(clip.sourceStartFrame, fps)}"`,
      ` duration="${rational(clip.durationFrames, fps)}">`,
      `              <metadata><md key="com.kacha.clip" value="${metadata}"/></metadata>`,
      "            </asset-clip>",
    ].join("");
  }).join("\n");
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE fcpxml>",
    "<fcpxml version=\"1.11\">",
    "  <resources>",
    `    <format id="${formatId}" name="Kacha ${timeline.output?.width ?? 1920}x${timeline.output?.height ?? 1080}" frameDuration="1/${fps}s" width="${timeline.output?.width ?? 1920}" height="${timeline.output?.height ?? 1080}"/>`,
    `    <asset id="${assetId}" name="${xmlEscape(path.basename(source))}" src="${xmlEscape(pathToFileURL(source).href)}" start="0s" hasVideo="1" hasAudio="1"/>`,
    "  </resources>",
    "  <library>",
    "    <event name=\"Kacha Interchange\">",
    `      <project name="${xmlEscape(timeline.projectId ?? "Kacha Timeline")}">`,
    `        <sequence format="${formatId}" duration="${rational(durationFrames, fps)}" tcStart="0s" tcFormat="NDF">`,
    "          <spine>",
    clipXml,
    "          </spine>",
    "        </sequence>",
    "      </project>",
    "    </event>",
    "  </library>",
    "</fcpxml>",
    "",
  ].join("\n");
}

function cmxExport(timelineFile, timeline) {
  const { fps, clips } = clipRows(timeline);
  const source = timelineSource(timelineFile, timeline);
  const rows = [
    `TITLE: ${timeline.projectId ?? "KACHA-TIMELINE"}`,
    "FCM: NON-DROP FRAME",
    `* SOURCE FILE: ${source}`,
  ];
  for (const [index, clip] of clips.entries()) {
    rows.push(
      `${String(index + 1).padStart(3, "0")}  AX       V     C        `
        + `${timecode(clip.sourceStartFrame, fps)} ${timecode(clip.sourceStartFrame + clip.durationFrames, fps)} `
        + `${timecode(clip.outputStartFrame, fps)} ${timecode(clip.outputStartFrame + clip.durationFrames, fps)}`,
      `* KACHA CLIP ID: ${clip.id}`,
      `* KACHA METADATA: ${Buffer.from(JSON.stringify(clip.metadata), "utf8").toString("base64")}`,
    );
  }
  rows.push("");
  return rows.join("\n");
}

export function exportNle(timelineFile, format, outputFile) {
  const file = ensureFile(timelineFile, "Timeline IR");
  const timeline = readJson(file);
  const output = path.resolve(outputFile ?? "");
  if (!outputFile) throw new Error("nle export 需要 --output FILE");
  if (fs.existsSync(output)) throw new Error(`拒绝覆盖 NLE 文件：${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  let body;
  if (format === "otio") body = `${JSON.stringify(otioExport(file, timeline), null, 2)}\n`;
  else if (format === "fcpxml") body = fcpxmlExport(file, timeline);
  else if (format === "cmx3600") body = cmxExport(file, timeline);
  else throw new Error(`不支持 NLE 格式：${format}`);
  fs.writeFileSync(output, body);
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_nle_export_report",
    generatedAt: new Date().toISOString(),
    status: "pass_with_limitations",
    format,
    timeline: fileIdentity(file),
    output: fileIdentity(output),
    clips: (timeline.edl ?? []).length,
    semanticIdsPreserved: true,
    limitations: [
      "交换文件主要承载剪辑区间、源素材和语义 ID",
      "咔嚓字幕、蒙版、Beauty、混音和复杂动效仍以 Timeline IR 为事实源",
      "NLE 中的人工修改必须重新导入为候选并经过变化层 QC"
    ],
  };
  report.digest = stableDigest(report);
  const reportFile = `${output}.kacha-report.json`;
  writeJsonAtomic(reportFile, report);
  return { ...report, report: fileIdentity(reportFile) };
}

function otioClips(value) {
  if (value.OTIO_SCHEMA !== "Timeline.1" || value.metadata?.kacha?.semanticIdsPreserved !== true) {
    throw new Error("只导入由咔嚓导出且保留语义 ID 的 OTIO");
  }
  const track = value.tracks?.children?.find((item) => item.OTIO_SCHEMA === "Track.1");
  if (!track) throw new Error("OTIO 缺少视频 Track");
  return (track.children ?? []).filter((item) => item.OTIO_SCHEMA === "Clip.2").map((clip, index) => {
    const rate = Number(clip.source_range?.start_time?.rate);
    const start = Number(clip.source_range?.start_time?.value) / rate;
    const duration = Number(clip.source_range?.duration?.value) / rate;
    if (!(rate > 0 && start >= 0 && duration > 0)) throw new Error(`OTIO clip[${index}] 时间无效`);
    return {
      id: clip.metadata?.kacha?.kachaId ?? clip.name ?? `clip-${index + 1}`,
      sourceStart: round(start),
      sourceEnd: round(start + duration),
      sourceDecisionId: clip.metadata?.kacha?.sourceDecisionId ?? null,
      semanticBeatId: clip.metadata?.kacha?.semanticBeatId ?? null,
    };
  });
}

function attribute(tag, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? xmlUnescape(match[1]) : null;
}

function rationalSeconds(value) {
  const match = /^(\d+)(?:\/(\d+))?s$/.exec(String(value ?? ""));
  if (!match) throw new Error(`FCPXML 时间值无效：${value}`);
  return Number(match[1]) / Number(match[2] ?? 1);
}

function fcpxmlClips(xml) {
  if (!/<fcpxml version="1\.11">/.test(xml) || !/com\.kacha\.clip/.test(xml)) {
    throw new Error("只导入由咔嚓导出且带 com.kacha.clip 元数据的 FCPXML");
  }
  const clips = [];
  const expression = /<asset-clip\b([^>]*)>([\s\S]*?)<\/asset-clip>/g;
  let match;
  while ((match = expression.exec(xml)) !== null) {
    const tag = match[1];
    const body = match[2];
    const start = rationalSeconds(attribute(tag, "start"));
    const duration = rationalSeconds(attribute(tag, "duration"));
    const md = /<md key="com\.kacha\.clip" value="([^"]+)"\/>/.exec(body);
    const metadata = md ? JSON.parse(Buffer.from(md[1], "base64").toString("utf8")) : {};
    clips.push({
      id: metadata.kachaId ?? attribute(tag, "name") ?? `clip-${clips.length + 1}`,
      sourceStart: round(start),
      sourceEnd: round(start + duration),
      sourceDecisionId: metadata.sourceDecisionId ?? null,
      semanticBeatId: metadata.semanticBeatId ?? null,
    });
  }
  if (clips.length === 0) throw new Error("FCPXML 未找到可导入的 asset-clip");
  return clips;
}

export function importNle(inputFile, format, baseTimelineFile, outputFile) {
  const input = ensureFile(inputFile, "NLE 交换文件");
  const baseFile = ensureFile(baseTimelineFile, "基线 Timeline IR");
  const output = path.resolve(outputFile ?? "");
  if (!outputFile) throw new Error("nle import 需要 --output FILE");
  if (output === baseFile) throw new Error("NLE 导入不得覆盖基线 Timeline IR");
  if (fs.existsSync(output)) throw new Error(`拒绝覆盖候选时间线：${output}`);
  const base = readJson(baseFile);
  let clips;
  if (format === "otio") clips = otioClips(readJson(input));
  else if (format === "fcpxml") clips = fcpxmlClips(fs.readFileSync(input, "utf8"));
  else throw new Error("NLE 导入当前支持 otio 或 fcpxml；CMX3600 只用于兼容导出");
  const candidate = structuredClone(base);
  candidate.mode = "preview";
  candidate.edl = clips;
  candidate.output = {
    ...candidate.output,
    path: candidate.output?.path
      ? `${candidate.output.path}.nle-candidate.mp4`
      : "./output/nle-candidate.mp4",
  };
  candidate.interchangeCandidate = {
    schemaVersion: "1.0",
    format,
    importedAt: new Date().toISOString(),
    input: fileIdentity(input),
    baseTimeline: fileIdentity(baseFile),
    candidateOnly: true,
    semanticIdsPreserved: true,
    requires: ["timeline validate", "delta diff", "变化层 QC", "人工正常速度审片"],
  };
  candidate.interchangeCandidate.digest = sha256Value(candidate.interchangeCandidate);
  writeJsonAtomic(output, candidate);
  const report = {
    schemaVersion: "1.0",
    kind: "kacha_nle_import_report",
    generatedAt: new Date().toISOString(),
    status: "candidate_only",
    format,
    input: fileIdentity(input),
    baseTimeline: fileIdentity(baseFile),
    candidateTimeline: fileIdentity(output),
    clips: clips.length,
    nextActions: [
      "校验候选 Timeline IR",
      "与基线生成 mutation/version delta",
      "只重建受影响层并执行动态 QC",
      "人工正常速度批准后才可进入发布候选"
    ],
  };
  report.digest = stableDigest(report);
  const reportFile = `${output}.nle-import-report.json`;
  writeJsonAtomic(reportFile, report);
  return { ...report, report: fileIdentity(reportFile) };
}

export function runNleCli(args = process.argv.slice(2)) {
  const action = args[0];
  if (action === "export") {
    const result = exportNle(option(args, "--timeline"), option(args, "--format"), option(args, "--output"));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (action === "import") {
    const result = importNle(
      option(args, "--input"),
      option(args, "--format"),
      option(args, "--base-timeline"),
      option(args, "--output"),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error("用法：kacha.mjs nle export|import --format otio|fcpxml|cmx3600 [options]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runNleCli();
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: "1.0",
      status: "blocked",
      diagnostics: [{ code: "KACHA-E190", detail: error.message }],
    }, null, 2));
    process.exit(1);
  }
}
