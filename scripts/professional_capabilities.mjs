#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256Value } from "./kacha_utils.mjs";
import { listDeliveryProfiles } from "./kacha_delivery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let ffmpegEvidence = null;

function ffmpegInventory() {
  if (ffmpegEvidence) return ffmpegEvidence;
  const encoders = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const filters = spawnSync("ffmpeg", ["-hide_banner", "-filters"], {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  });
  ffmpegEvidence = {
    available: encoders.status === 0 && filters.status === 0,
    encoders: `${encoders.stdout ?? ""}\n${encoders.stderr ?? ""}`,
    filters: `${filters.stdout ?? ""}\n${filters.stderr ?? ""}`,
  };
  return ffmpegEvidence;
}

function scriptExists(name) {
  return fs.existsSync(path.join(root, "scripts", name));
}

function hasFilter(name) {
  return ffmpegInventory().available && new RegExp(`\\b${name}\\b`).test(ffmpegInventory().filters);
}

function capability(id, category, label, status, evidence, limitations, entryPoints = []) {
  return { id, category, label, status, evidence, limitations, entryPoints };
}

export function professionalCapabilityMap() {
  const deliveryProfiles = listDeliveryProfiles().profiles;
  const deliveryEvidence = deliveryProfiles
    .filter((profile) => profile.status === "available")
    .map((profile) => `${profile.id}: ${profile.selectedEncoder} + ${profile.selectedAudioEncoder} + ${profile.container} + ${profile.pixelFormat}`);
  const capabilities = [
    capability("timeline.multitrack", "timeline", "多轨视频、音频和文字投影", "available", ["Timeline IR", "scripts/timeline_projection.mjs", "studio/editor.js"], ["当前主画面为单视频轨 EDL；字幕已渲染层的正文需回到字幕计划修改"], ["kacha editor project", "/editor"]),
    capability("timeline.operations", "timeline", "trim / split / move / reorder", "available", ["scripts/editor_operations.mjs", "Command Journal"], ["主画面不允许任意留白移动；已执行转场时结构修改失败关闭"], ["kacha editor command apply", "/editor"]),
    capability("timeline.ripple-overwrite", "timeline", "ripple trim / overwrite", "available", ["scripts/editor_operations.mjs", "tests/run_tests.mjs"], ["仅支持单源主画面 EDL；需整帧边界且重新执行 connection QC"], ["kacha editor command apply", "/editor"]),
    capability("timeline.sync", "timeline", "sync groups", "planned", [], ["尚无多源时钟与最终渲染语义"], []),
    capability("timeline.multicam", "timeline", "multicam", "planned", [], ["尚无多角度源注册、同步证据和 angle switch 终渲染"], []),
    capability("timeline.nested", "timeline", "nested timeline", "planned", ["workspace 支持多时间线注册"], ["本轮不支持把另一 Timeline IR 作为可渲染 clip 嵌套"], []),
    capability("motion.keyframes", "picture", "位置关键帧", "partial", ["overlay x/y keyframes", "FFmpeg expression render"], ["暂不支持速度曲线、贝塞尔控制柄和任意属性"], ["/editor"]),
    capability("picture.crop-blend", "picture", "裁剪、混合与图层几何", "partial", ["overlay geometry/opacity", hasFilter("blend") ? "FFmpeg blend filter" : ""].filter(Boolean), ["工作台尚无通用 crop 和 blend-mode inspector"], ["/editor", "kacha timeline compile"]),
    capability("picture.color", "picture", "LUT / 色轮 / 曲线 / 抠像 / 降噪", "partial", [hasFilter("lut3d") ? "FFmpeg lut3d" : "", hasFilter("chromakey") ? "FFmpeg chromakey" : "", hasFilter("hqdn3d") ? "FFmpeg hqdn3d" : "", "Kacha Beauty/Mask contracts"].filter(Boolean), ["底层滤镜或生产合同存在不等于已有完整调色节点 UI；本轮不声称专业调色对等"], ["kacha beauty", "kacha masks", "kacha timeline compile"]),
    capability("speech.transcript", "intelligence", "字幕、逐字转写与窗口索引", scriptExists("transcribe_local.mjs") ? "available" : "blocked", ["scripts/transcribe_local.mjs", "scripts/transcript_window.mjs", "caption contracts"], ["识别质量依赖当前本地模型与人工校对"], ["kacha transcribe", "kacha transcript", "kacha captions"]),
    capability("speech.cleanup", "intelligence", "静音检测与口误候选", "partial", [hasFilter("silencedetect") ? "FFmpeg silencedetect" : "", "transcript cues", "connection scanner"].filter(Boolean), ["自动删除仍需保留语义和连接点 QC；不以文本匹配直接删片"], ["kacha connections", "kacha transcript"]),
    capability("intelligence.rhythm", "intelligence", "节拍与能量分析", scriptExists("rhythm_analysis.mjs") ? "available" : "blocked", ["scripts/rhythm_analysis.mjs"], ["技术节拍证据不等于创作授权或语义理解"], ["kacha rhythm analyze"]),
    capability("intelligence.search", "intelligence", "媒体检查与视觉语义搜索", "partial", ["media index", "media corpus", "Project Bin"], ["无视觉 embedding 时回退为本地关键词/证据搜索"], ["kacha media search", "kacha corpus search", "/editor"]),
    capability("generation.media", "generation", "图片、视频、TTS、音乐、音效与升格生成路由", "partial", ["capability broker", "cost ledger", "generated cache", "asset inbox"], ["外部提供者需显式授权、费用预占、来源/许可和候选审片"], ["kacha capabilities", "kacha cost", "kacha generated-cache", "kacha asset-inbox"]),
    capability("delivery.codecs", "delivery", "H.264 / H.265 / ProRes", deliveryEvidence.length ? "partial" : "blocked", deliveryEvidence, ["available profile 已同时验证视频/音频 encoder、muxer 与 pixel format；尚未把三种 profile 全部接入一键终渲染，正式交付仍需 Timeline/QC/review 门禁"], ["kacha delivery profiles", "kacha delivery plan"]),
    capability("delivery.interchange", "delivery", "OTIO / FCPXML / Premiere XML / CMX3600", "available", ["scripts/kacha_nle.mjs"], ["Premiere XML 使用 xmeml v5 交换候选；复杂字幕、蒙版、Beauty、混音和动效仍以 Timeline IR 为准，且需目标 NLE 实机导入验证"], ["kacha nle export"]),
    capability("delivery.bundle", "delivery", "自包含工程包", "partial", ["scripts/kacha_delivery.mjs"], ["默认仅包合同与强身份清单；媒体只在显式 --include-media 且当前 SHA/许可通过时复制"], ["kacha delivery bundle"]),
    capability("workspace.versions", "project", "项目内多时间线、版本和画幅复制", "available", ["scripts/editor_workspace.mjs", "Workbench timeline switcher"], ["复制会建立新 Timeline IR 文件，不自动继承已渲染候选或审片批准"], ["kacha workspace", "/editor"]),
  ];
  const counts = capabilities.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  const result = {
    schemaVersion: "1.0",
    kind: "kacha-professional-capability-map",
    status: "pass_with_limitations",
    localRuntime: { ffmpeg: ffmpegInventory().available },
    counts,
    capabilities,
    truthBoundary: "available 表示存在本地实现与验证入口，不表示与专用 NLE 全功能对等。",
  };
  result.digest = sha256Value(result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(professionalCapabilityMap(), null, 2)}\n`);
}
