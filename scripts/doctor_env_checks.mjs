#!/usr/bin/env node

// doctor 环境深度检查的纯判定逻辑。与 kacha_doctor.mjs 分离，使判定可以
// 用合成的 ffmpeg 输出做单元测试，不依赖本机环境状态。

// ffmpeg -encoders 输出 → 编码器检查。渲染/音频链缺编码器时会在成片
// 最后一步才失败，这里把缺口提前到体检。
// 正则锚定 flags 列之后的名称列，避免命中描述文本或同前缀变体
// （如 libx264rgb、aac_at 的描述列都含 "aac"/"libx264" 字样）。
export function checkEncoders(encodersText) {
  const encoders = String(encodersText ?? "");
  const wanted = [
    { id: "encoder:libx264", codec: "libx264", impact: "成片 H.264 视频编码" },
    { id: "encoder:aac", codec: "aac", impact: "成片 AAC 音频编码" },
    { id: "encoder:libmp3lame", codec: "libmp3lame", impact: "BGM/中间件 MP3 编码" },
  ];
  return wanted.map(({ id, codec, impact }) => {
    const available = new RegExp(`^[ .A-Z*]+\\s+${codec}\\s`, "m").test(encoders);
    return {
      id,
      required: true,
      available,
      evidence: available
        ? `ffmpeg -encoders contains ${codec}`
        : `缺少 ${codec}（${impact}）；conda/精简版 ffmpeg 常见，渲染到最后一步才失败`,
    };
  });
}

// ASS 字幕烧录能力（libass 的 subtitles/ass 滤镜）。PNG 叠加字幕主路径
// （caption_layout + overlay）不依赖它，所以 required:false——缺失只降级为
// pass_with_optional_gaps，但 evidence 必须把影响说透。正则同样锚定名称列。
export function checkAssBurn(filtersText) {
  const filters = String(filtersText ?? "");
  const hasFilter = (name) => new RegExp(`^[ .A-Z*]+\\s+${name}\\s`, "m").test(filters);
  const available = hasFilter("subtitles") && hasFilter("ass");
  return {
    id: "ass-subtitle-burn",
    required: false,
    available,
    evidence: available
      ? "ffmpeg filters 包含 subtitles/ass（libass），ASS 字幕可烧录"
      : "缺少 libass（subtitles/ass 滤镜）：ASS 字幕烧录将失败（timeline_ir subtitles 滤镜路径）；PNG 叠加字幕路径不受影响。需要时 brew reinstall ffmpeg 或安装带 libass 的 ffmpeg",
  };
}

const DEFAULT_COVERAGE_SAMPLE = "行者大灰第期栏目更新工具分享解读好书有限的无限游戏灰常AI闲聊，。！？；：0123456789";

// coverageEntries: [{font, covered, total}] 或 [{font, probeFailed, detail}]。
// 前者由调用方用 fontTools 探测后传入；probeFailed 表示探测本身失败
// （依赖缺失、文件不可读），与"覆盖不足"是两种不同的诊断。
export function summarizeFontCoverage(coverageEntries, {
  sample = DEFAULT_COVERAGE_SAMPLE,
  minimumRatio = 0.98,
} = {}) {
  if (!Array.isArray(coverageEntries) || coverageEntries.length === 0) {
    return {
      id: "font:cjk-coverage",
      required: false,
      available: true,
      evidence: "没有注册项目字体，跳过覆盖探测（字幕将回退到系统字体路由）",
    };
  }
  const probeFailures = coverageEntries.filter((entry) => entry?.probeFailed);
  if (probeFailures.length > 0) {
    // fontTools 是字幕链路的必需能力：探测失败意味着无法证明字体可安全
    // 用于中文渲染，必须阻断，而不是降级为可选警告。
    return {
      id: "font:cjk-coverage",
      required: true,
      available: false,
      evidence: `字体覆盖探测失败（必需能力 fontTools 不可用或字体不可读）：${probeFailures
        .map((entry) => `${entry.font}：${entry.detail ?? "未知原因"}`)
        .join("；")}。先安装 fonttools / 修复字体文件，不要据此更换字体`,
    };
  }
  const expected = new Set([...sample]);
  const failing = coverageEntries.filter((entry) => {
    if (!entry || entry.total === 0) return true;
    const inSample = Math.min(entry.covered, expected.size);
    return inSample / Math.max(expected.size, 1) < minimumRatio;
  });
  return {
    id: "font:cjk-coverage",
    required: false,
    available: failing.length === 0,
    evidence: failing.length === 0
      ? `${coverageEntries.length} 个注册字体对样例字符集覆盖率 ≥ ${minimumRatio * 100}%`
      : `以下字体对样例字符集覆盖不足：${failing.map((entry) => entry.font).join(", ")}——缺字会渲染成豆腐块而 ffmpeg 退出码为 0`,
  };
}
