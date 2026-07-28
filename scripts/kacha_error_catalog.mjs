export const ERROR_CATALOG = {
  "KACHA-E100": {
    title: "输入或项目文件缺失",
    remediation: "核对绝对路径、文件权限和当前项目目录，不要凭文件名猜测。",
  },
  "KACHA-E110": {
    title: "文件身份或哈希失配",
    remediation: "重新盘点当前真实文件，重建依赖它的 plan/QC，禁止继承旧结论。",
  },
  "KACHA-E120": {
    title: "授权不足",
    remediation: "保持只读并停止；只有用户明确授权后才能上传、付费生成或发布。",
  },
  "KACHA-E130": {
    title: "运行能力缺失",
    remediation: "运行 doctor 获取缺失能力和修复建议；禁止静默替换算法。",
  },
  "KACHA-E140": {
    title: "项目合同无效",
    remediation: "按验证器逐条修正合同；不要跳过字段或把占位文字当证据。",
  },
  "KACHA-E200": {
    title: "候选输出尚未生成",
    remediation: "按 incrementalPlan/editPlan 渲染独立新版本，源和基线保持只读。",
  },
  "KACHA-E210": {
    title: "自动 QC 尚未执行或已过期",
    remediation: "对当前输出重新执行 QC；旧版本报告不能复制。",
  },
  "KACHA-E300": {
    title: "人工审片未完成",
    remediation: "按动态清单正常速度通看并提供真实时间码、代表帧或试听证据。",
  },
  "KACHA-E400": {
    title: "视觉证据不足",
    remediation: "生成本地 visual-evidence；需要语义增强时仅上传经授权的少量关键帧。",
  },
  "KACHA-E410": {
    title: "外部视觉分析未授权",
    remediation: "保持本地分析；需要 MiniMax 时同时提供项目授权和显式上传开关。",
  },
  "KACHA-E500": {
    title: "工具执行失败",
    remediation: "保留原始 stderr 和任务状态，修复根因后从当前安全阶段重试。",
  },
};

export function diagnostic(code, detail, extra = {}) {
  const known = ERROR_CATALOG[code] ?? ERROR_CATALOG["KACHA-E500"];
  return {
    code,
    title: known.title,
    detail,
    remediation: known.remediation,
    ...extra,
  };
}

export function classifyFailure(message = "") {
  const text = String(message);
  if (/授权|authorized|externalUploadAllowed|paidGenerationAllowed/i.test(text)) {
    return "KACHA-E120";
  }
  if (/sha256|哈希|identity|fingerprint|不一致|失配/i.test(text)) {
    return "KACHA-E110";
  }
  if (/不存在|缺少 path|ENOENT|no such file|无法读取/i.test(text)) {
    return "KACHA-E100";
  }
  if (/能力|capabilit|command .* unavailable|not found/i.test(text)) {
    return "KACHA-E130";
  }
  if (/schema|合同|manifest|plan|必须|无效|未知/i.test(text)) {
    return "KACHA-E140";
  }
  return "KACHA-E500";
}
