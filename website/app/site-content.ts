type Feature = {
  kicker: string;
  title: string;
  body: string;
};

type WorkflowStep = {
  title: string;
  body: string;
};

export type SiteContent = {
  brandHome: string;
  navLabel: string;
  nav: {
    system: string;
    workflow: string;
    principles: string;
    install: string;
  };
  hero: {
    eyebrow: string;
    titleLead: string;
    titleAccent: string;
    summary: string;
    primaryCta: string;
    secondaryCta: string;
    contracts: string[];
    visualLabel: string;
    caption: string;
  };
  proofLabel: string;
  proof: Array<{ value: string; label: string }>;
  system: {
    title: string;
    intro: string;
    features: Feature[];
  };
  workflow: {
    title: string;
    intro: string;
    steps: WorkflowStep[];
    resultLabel: string;
    result: string;
  };
  principles: {
    quoteLead: string;
    quoteAccent: string;
    body: string;
    items: Array<{ title: string; body: string }>;
  };
  beauty: {
    title: string;
    body: string;
    items: string[];
    meterLabel: string;
    defaultNote: string;
  };
  install: {
    title: string;
    body: string;
    agentLabel: string;
    copy: string;
    copied: string;
    note: string;
  };
  footer: {
    tagline: string;
    docs: string;
    credit: string;
  };
};

export const zhContent: SiteContent = {
  brandHome: "返回咔嚓首页",
  navLabel: "主导航",
  nav: {
    system: "能力",
    workflow: "流程",
    principles: "原则",
    install: "安装",
  },
  hero: {
    eyebrow: "本地专业 AI 视频工作流",
    titleLead: "不只会加效果。",
    titleAccent: "把视频工作流做完。",
    summary:
      "咔嚓把策划、精剪、声音、画面、字幕、增量返工与质量检查，组织成一套可审计、可复现、失败即停的本地流程。",
    primaryCta: "开始使用",
    secondaryCta: "查看源码",
    contracts: ["本地优先", "效果有理由", "结果可验证"],
    visualLabel: "咔嚓剪辑工作流时间线示意",
    caption: "从原片到可交付候选版，每一步都有状态",
  },
  proofLabel: "当前版本能力数据",
  proof: [
    { value: "52", label: "设计组件" },
    { value: "63", label: "复用场景" },
    { value: "73", label: "回归检查" },
    { value: "4", label: "任务路径" },
  ],
  system: {
    title: "一套系统，不是一袋特效。",
    intro:
      "画面风格、时间逻辑、声音功能和质量门禁共享同一份合同。效果不是越多越好，而是在正确时刻解决正确问题。",
    features: [
      {
        kicker: "VIDEO DESIGN SYSTEM",
        title: "完整视频设计系统",
        body: "栏目、画幅、语言、明暗与密度模式统一驱动字幕、信息卡、PIP、流程图、弹窗和运动语言。",
      },
      {
        kicker: "EDITING LOGIC",
        title: "有理由的切镜与连接",
        body: "信息、情绪或视角变化才切镜；连接点按内容连续性选择硬切、重构图、动效或声音桥。",
      },
      {
        kicker: "VOICE & SOUND",
        title: "先把话听清楚",
        body: "先分离人声与非人声，再处理噪声、齿音、爆音和口水音；BGM 与音效按叙事功能进入混音。",
      },
      {
        kicker: "INCREMENTAL REWORK",
        title: "返工只动该动的层",
        body: "冻结无关音视频流，用摘要证明它们没有变化，只重建受影响的字幕、声音、画面或包装层。",
      },
      {
        kicker: "BILINGUAL CAPTIONS",
        title: "字幕服从语言与安全区",
        body: "以口播为主、文稿校准，控制单行长度、意群切分、双语层级与平台遮挡安全区。",
      },
      {
        kicker: "FAIL-CLOSED QC",
        title: "自动检查不冒充人工审片",
        body: "解码、轨道、尺寸、响度、黑帧与静音线索先过技术门禁，最终仍要求同源人工通看。",
      },
    ],
  },
  workflow: {
    title: "先判断，再动时间线。",
    intro:
      "每一步都留下输入、输出、授权和失败回退。不是“看起来做了”，而是能够说明做了什么、为什么做、如何验收。",
    steps: [
      { title: "策划与边界", body: "锁定任务、受众、尺寸、授权与成功标准。" },
      { title: "结构与精剪", body: "删除无效停顿、口误和重复，保住完整语义与自然强弱。" },
      { title: "声音处理", body: "人声分离、清理、增强、BGM、SFX 与响度控制。" },
      { title: "视觉包装", body: "按设计系统调用字幕、信息卡、PIP、蒙版和转场。" },
      { title: "增量返工", body: "把反馈编译成差异，只重渲染受影响的部分。" },
      { title: "质量门禁", body: "机器检查、同源 A/B 与人工审片共同决定是否可交付。" },
    ],
    resultLabel: "LOCAL RELEASE STATE",
    result: "READY FOR HUMAN APPROVAL",
  },
  principles: {
    quoteLead: "AI 降低门槛，",
    quoteAccent: "判断决定上限。",
    body:
      "咔嚓不会把一个 preview 写成最终成片，也不会把一次技术通过写成人工认可。它负责把复杂步骤组织好，把最终判断留给人。",
    items: [
      {
        title: "默认不上传",
        body: "素材本地处理；外传、付费生成与发布都需要单独明确授权。",
      },
      {
        title: "默认不美颜",
        body: "Beauty v2 只有在项目明确启用并具备逐帧人物证据时才进入链路。",
      },
      {
        title: "默认不夸大",
        body: "能力、限制、成本与人工参与都写进交付记录，不用演示替代证据。",
      },
    ],
  },
  beauty: {
    title: "只做四件事，而且保持克制。",
    body:
      "Beauty v2 是本地、非生成式的人像优化链。它专注日常真人口播最常用的四项处理，不换脸、不改五官、不制造塑料皮肤。",
    items: ["磨皮保留纹理", "自然美白", "匀肤不改背景", "法令纹局部弱化"],
    meterLabel: "Beauty v2 默认状态",
    defaultNote: "只有明确启用、检测稳定并完成人工动态 A/B 后，才允许进入候选版。",
  },
  install: {
    title: "交给你的 Agent 安装。",
    body:
      "支持 Codex 与 Claude Code。安装器不会覆盖已有版本；正式工作前会先做依赖、隐私和回归检查。",
    agentLabel: "支持的运行环境",
    copy: "复制命令",
    copied: "已复制",
    note: "需要 Node.js 20+；完整媒体链路还需要 FFmpeg 与 FFprobe。",
  },
  footer: {
    tagline: "Plan · Cut · Polish · Verify",
    docs: "文档",
    credit: "由行者大灰构建",
  },
};

export const enContent: SiteContent = {
  brandHome: "Back to Kacha home",
  navLabel: "Primary navigation",
  nav: {
    system: "System",
    workflow: "Workflow",
    principles: "Principles",
    install: "Install",
  },
  hero: {
    eyebrow: "Local-first professional AI video workflow",
    titleLead: "More than effects.",
    titleAccent: "Finish the workflow.",
    summary:
      "Kacha turns planning, fine cuts, sound, visuals, captions, revisions, and QC into an auditable, reproducible, fail-closed local workflow.",
    primaryCta: "Get started",
    secondaryCta: "View source",
    contracts: ["Local first", "Every effect has a reason", "Results are verifiable"],
    visualLabel: "Kacha editing workflow timeline",
    caption: "Every step has a state, from raw footage to delivery candidate",
  },
  proofLabel: "Current version capability counts",
  proof: [
    { value: "52", label: "design components" },
    { value: "63", label: "reusable scenes" },
    { value: "73", label: "regression checks" },
    { value: "4", label: "task paths" },
  ],
  system: {
    title: "A system, not a bag of tricks.",
    intro:
      "Visual style, timing, sound function, and quality gates share one contract. Effects exist to solve a specific problem at the right moment.",
    features: [
      {
        kicker: "VIDEO DESIGN SYSTEM",
        title: "One coherent design system",
        body: "Show, aspect, language, surface, and density modes drive captions, cards, PIP, diagrams, popups, and motion.",
      },
      {
        kicker: "EDITING LOGIC",
        title: "Motivated cuts and connections",
        body: "Cut only when information, emotion, or viewpoint changes; choose each connection from continuity evidence.",
      },
      {
        kicker: "VOICE & SOUND",
        title: "Make the voice intelligible first",
        body: "Separate dialogue before cleanup. Add music and SFX by narrative function, then mix around the speaker.",
      },
      {
        kicker: "INCREMENTAL REWORK",
        title: "Change only the affected layer",
        body: "Freeze unrelated streams, prove they did not change, and rebuild only the impacted caption, audio, visual, or package layer.",
      },
      {
        kicker: "BILINGUAL CAPTIONS",
        title: "Captions follow language and safe zones",
        body: "Speech leads and scripts calibrate. Line length, semantic breaks, bilingual hierarchy, and platform occlusion are explicit.",
      },
      {
        kicker: "FAIL-CLOSED QC",
        title: "Automation never impersonates review",
        body: "Technical gates check media evidence; a same-source human watch-through still decides whether the result is deliverable.",
      },
    ],
  },
  workflow: {
    title: "Decide before touching the timeline.",
    intro:
      "Every stage records inputs, outputs, authorization, and fallback. The workflow can explain what changed, why it changed, and how it was checked.",
    steps: [
      { title: "Plan & boundaries", body: "Lock the task, audience, format, authorization, and success criteria." },
      { title: "Structure & fine cut", body: "Remove waste while preserving complete meaning and natural emphasis." },
      { title: "Audio", body: "Dialogue separation, cleanup, enhancement, music, SFX, and loudness." },
      { title: "Visual polish", body: "Apply captions, cards, PIP, masks, and transitions through the design system." },
      { title: "Incremental rework", body: "Compile feedback into a delta and render only what it affects." },
      { title: "Quality gates", body: "Machine checks, same-source A/B, and human review determine delivery status." },
    ],
    resultLabel: "LOCAL RELEASE STATE",
    result: "READY FOR HUMAN APPROVAL",
  },
  principles: {
    quoteLead: "AI lowers the barrier. ",
    quoteAccent: "Judgment sets the ceiling.",
    body:
      "Kacha does not call a preview a final video or a technical pass a human approval. It organizes the complexity and leaves the final judgment to a person.",
    items: [
      {
        title: "No upload by default",
        body: "Media stays local. External transfer, paid generation, and publishing need separate explicit authorization.",
      },
      {
        title: "Beauty off by default",
        body: "Beauty v2 enters the pipeline only when explicitly enabled with frame-accurate subject evidence.",
      },
      {
        title: "No inflated claims",
        body: "Capabilities, limits, cost, and human work stay visible in the delivery record.",
      },
    ],
  },
  beauty: {
    title: "Four focused treatments. Nothing theatrical.",
    body:
      "Beauty v2 is a local, non-generative portrait pipeline for talking-head footage. It does not swap faces, reshape features, or erase natural skin texture.",
    items: ["texture-preserving smoothing", "restrained whitening", "skin-only tone evening", "local fold softening"],
    meterLabel: "Beauty v2 default state",
    defaultNote: "It can enter a candidate only after explicit enablement, stable detection, and a dynamic human A/B review.",
  },
  install: {
    title: "Let your Agent install it.",
    body:
      "Kacha supports Codex and Claude Code. The installer refuses to overwrite an existing version and runs dependency, privacy, and regression checks.",
    agentLabel: "Supported Agent environments",
    copy: "Copy command",
    copied: "Copied",
    note: "Requires Node.js 20+; the full media workflow also needs FFmpeg and FFprobe.",
  },
  footer: {
    tagline: "Plan · Cut · Polish · Verify",
    docs: "Docs",
    credit: "Built by 行者大灰",
  },
};
