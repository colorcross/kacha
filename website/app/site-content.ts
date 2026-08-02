type Feature = {
  kicker: string;
  title: string;
  body: string;
};

type WorkflowStep = {
  title: string;
  body: string;
};

type Challenge = {
  number: string;
  title: string;
  body: string;
};

type Outcome = {
  kicker: string;
  title: string;
  body: string;
  proof: string;
};

type FaqItem = {
  question: string;
  answer: string;
};

type StyleGrammar = {
  id: "light" | "spatial" | "comic" | "pixel";
  kicker: string;
  title: string;
  body: string;
  sequence: string;
  sound: string;
};

export type SiteContent = {
  brandHome: string;
  navLabel: string;
  nav: {
    problems: string;
    outcomes: string;
    styles: string;
    workflow: string;
    install: string;
    contact: string;
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
  problems: {
    title: string;
    intro: string;
    items: Challenge[];
  };
  outcomes: {
    title: string;
    intro: string;
    demoNote: string;
    beforeLabel: string;
    afterLabel: string;
    items: Outcome[];
  };
  styles: {
    title: string;
    intro: string;
    auditLabel: string;
    auditValue: string;
    items: StyleGrammar[];
  };
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
  fit: {
    title: string;
    intro: string;
    items: Array<{ title: string; body: string }>;
  };
  faq: {
    title: string;
    intro: string;
    items: FaqItem[];
  };
  install: {
    title: string;
    body: string;
    agentLabel: string;
    copy: string;
    copied: string;
    note: string;
  };
  contact: {
    title: string;
    body: string;
    emailLabel: string;
    channelsLabel: string;
    channels: Array<{ id: "wechat" | "douyin" | "xiaohongshu"; name: string; note: string }>;
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
    problems: "痛点",
    outcomes: "效果",
    styles: "四种语法",
    workflow: "流程",
    install: "安装",
    contact: "联系",
  },
  hero: {
    eyebrow: "面向真人口播与内容视频的本地 AI 剪辑工作流",
    titleLead: "从原始素材，",
    titleAccent: "到可以发布的成片。",
    summary:
      "咔嚓让 Codex 或 Claude Code 按专业流程完成结构精剪、人声处理、字幕校准、视觉包装、增量返工与质量检查。AI 负责执行，你保留最后的判断。",
    primaryCta: "看看能解决什么",
    secondaryCta: "快速安装",
    contracts: ["素材优先留在本地", "不剪断完整语义", "每次修改可追踪"],
    visualLabel: "咔嚓从原片到发布候选版的工作流示意",
    caption: "不是一次生成，而是一条可以检查、返工和交付的流程",
  },
  proofLabel: "咔嚓的核心工作方式",
  proof: [
    { value: "LOCAL", label: "默认本地处理素材" },
    { value: "FULL", label: "覆盖完整后期流程" },
    { value: "DELTA", label: "返工只改受影响层" },
    { value: "118", label: "自动回归检查" },
  ],
  problems: {
    title: "真正耗时间的，不只是拖动时间线。",
    intro:
      "关注 AI 剪辑的人通常不是缺少一个特效，而是担心自动化把内容剪错、声音做坏、字幕做乱，最后还要自己从头返工。",
    items: [
      {
        number: "01",
        title: "停顿删了，半句话也被删了",
        body: "单纯按静音切割容易破坏否定、条件、因果和结论。精剪必须先理解语义，再决定切点。",
      },
      {
        number: "02",
        title: "声音、字幕和画面对不上",
        body: "多工具串联后最容易发生时间漂移。对白、BGM、音效、字幕和画面需要共享同一组帧边界。",
      },
      {
        number: "03",
        title: "效果很多，但风格越来越乱",
        body: "字幕、信息卡、画中画和转场如果各做各的，成片会像素材拼盘。它们需要同一套设计系统。",
      },
      {
        number: "04",
        title: "改一个地方，却要重新做整条",
        body: "字幕、音频或局部画面返工不该拖累全部流程。系统应该知道哪些层要重建，哪些必须保持不变。",
      },
    ],
  },
  outcomes: {
    title: "先看变化，再看功能。",
    intro:
      "咔嚓把观众真正能感受到的结果，拆成可以执行和验收的编辑合同。",
    demoNote: "以下为能力示意；真实成片与持续演示可在页面底部联系“行者大灰”查看。",
    beforeLabel: "常见问题",
    afterLabel: "咔嚓处理",
    items: [
      {
        kicker: "STRUCTURE",
        title: "说完整，也更紧凑",
        body: "删除无效停顿、口误和重复，同时保留完整句义、自然强弱和幽默节奏。",
        proof: "切点检查语义、呼吸、画面连续性与前后余量。",
      },
      {
        kicker: "AUDIO + CAPTIONS",
        title: "听得清，也看得懂",
        body: "先分离人声，再处理噪声、齿音与动态；字幕以口播为主、文稿校准，并服从平台安全区。",
        proof: "对白、字幕、BGM 与 SFX 使用同一时间合同。",
      },
      {
        kicker: "VISUAL SYSTEM",
        title: "效果有理由，画面有秩序",
        body: "信息卡、PIP、蒙版、字幕强调和转场只在信息、情绪或视角变化时出现。",
        proof: "统一字体、颜色、圆角、阴影、运动和版面避让。",
      },
      {
        kicker: "INCREMENTAL REWORK",
        title: "反馈来了，不必推倒重来",
        body: "把“字幕上移”“BGM 再低一点”这类反馈编译成差异，只重建真正受影响的层。",
        proof: "冻结无关音视频流，并用摘要证明它们没有变化。",
      },
    ],
  },
  styles: {
    title: "四种风格，不是同一套卡片换颜色。",
    intro:
      "它们共享人物保护、字幕可读性和品牌规范，但使用不同的时间单位、空间拓扑、转场与声音逻辑。系统会逐对比较七个语法轴，发现换皮就停止。",
    auditLabel: "PRODUCTION EVIDENCE",
    auditValue: "4 套语法 · 240 个效果 · 1920 张横竖峰值帧 · 960 份动效合同",
    items: [
      {
        id: "light",
        kicker: "EDITORIAL CONTINUITY",
        title: "浅暖轻浮层",
        body: "保持真人口播连续，用画面边缘旁注和负空间补充信息；完整观点优先于热闹切换。",
        sequence: "完整意思 → 边缘旁注 → 证据区 → 回到真人",
        sound: "默认安静；重大旁注最多一枚轻纸张或空气声。",
      },
      {
        id: "spatial",
        kicker: "DEPTH NAVIGATION",
        title: "空间光路",
        body: "先建立固定世界坐标，再让光路、焦点与镜头沿真实关系移动；文字属于景深，而不是漂浮网页卡。",
        sequence: "建立空间 → 路径到达 → 焦点移动 → 终点停稳",
        sound: "起点和终点共用一条方向性 tonal phrase。",
      },
      {
        id: "comic",
        kicker: "COMEDIC TIMING",
        title: "幽默漫画",
        body: "只有真实反差成立时才分格；铺垫、停顿、反应与回扣共同完成包袱，不把漫画材质当滤镜。",
        sequence: "铺垫 → 半拍停顿 → 反应 → 包袱 → 回扣",
        sound: "沉默也是节奏；动作后最多一枚干燥短音。",
      },
      {
        id: "pixel",
        kicker: "STATE MACHINE",
        title: "像素风",
        body: "像素只组织图形状态，人物、证据和正文保持高清；每次只提交一个可验证的真实变化。",
        sequence: "输入 → 处理规则 → 状态提交 → 结果验证",
        sound: "只有真实状态改变时，才触发对应 UI 声。",
      },
    ],
  },
  system: {
    title: "把一条视频真正做完，需要这些能力一起工作。",
    intro:
      "咔嚓不是单项 AI 功能集合，而是让内容、声音、画面、字幕和质量检查共享上下文的执行系统。",
    features: [
      {
        kicker: "CONTENT EDIT",
        title: "结构精剪",
        body: "识别口误、重复、废话和无效停顿；切点不能损坏完整语义与自然表达。",
      },
      {
        kicker: "VOICE & SOUND",
        title: "人声与混音",
        body: "人声分离、降噪、增强、BGM、SFX 与响度控制围绕长时间听感共同完成。",
      },
      {
        kicker: "CAPTIONS",
        title: "字幕校准",
        body: "语音为主、文稿补充；校正专名、数字和语境，并处理单行长度、意群与双语层级。",
      },
      {
        kicker: "VIDEO DESIGN SYSTEM",
        title: "视觉包装",
        body: "统一驱动字幕、信息卡、PIP、流程图、蒙版、开场、转场、封面和运动语言。",
      },
      {
        kicker: "OPTIONAL PORTRAIT",
        title: "克制的人像优化",
        body: "Beauty v2 默认关闭；明确启用后只做磨皮、美白、匀肤和法令纹弱化，不改变身份。",
      },
      {
        kicker: "FAIL-CLOSED QC",
        title: "质量门禁",
        body: "先检查解码、轨道、尺寸、响度、同步、黑帧与静音线索，再交给人完成最终通看。",
      },
    ],
  },
  workflow: {
    title: "一条素材，六个阶段，直到可以交付。",
    intro:
      "每一步都记录输入、输出、授权、失败条件和返工范围。做到了什么、为什么这样做、怎样确认，都能被追溯。",
    steps: [
      { title: "理解任务", body: "锁定内容目标、受众、平台、尺寸、授权与成功标准。" },
      { title: "结构精剪", body: "删除无效内容，校验每个切点的句义、节奏与连接。" },
      { title: "处理声音", body: "分离并优化人声，再安排音乐、音效和最终响度。" },
      { title: "包装画面", body: "按统一设计系统加入字幕、素材、PIP、蒙版与转场。" },
      { title: "响应反馈", body: "把修改要求编译成差异，只重渲染受影响部分。" },
      { title: "检查交付", body: "自动技术 QC、同源 A/B 与人工审片共同决定是否发布。" },
    ],
    resultLabel: "DELIVERY STATE",
    result: "READY FOR HUMAN APPROVAL",
  },
  principles: {
    quoteLead: "AI 负责重复劳动，",
    quoteAccent: "你保留最后判断。",
    body:
      "咔嚓不把一次生成叫作最终成片，也不把技术通过冒充人工认可。它的优势不是替你决定品味，而是让每个决定都更容易执行、验证和修改。",
    items: [
      {
        title: "本地优先",
        body: "默认不上传素材；外传、付费生成与发布都需要单独明确授权。",
      },
      {
        title: "过程可控",
        body: "计划、配置、素材来源、变化范围和 QC 证据都保留，出现问题可以定位。",
      },
      {
        title: "质量可证",
        body: "预览、候选版、自动检查、人工通看和正式发布是不同状态，不混为一谈。",
      },
    ],
  },
  fit: {
    title: "尤其适合这些视频和创作者。",
    intro:
      "咔嚓当前优先服务需要保留真人表达、又希望显著减少重复后期工作的内容生产者。",
    items: [
      {
        title: "真人口播与知识视频",
        body: "需要删除口误和停顿，同时保住语气、逻辑、表情和自然节奏。",
      },
      {
        title: "教程、访谈与播客视频",
        body: "需要长内容结构、清晰人声、准确字幕、信息图和多平台版本。",
      },
      {
        title: "持续更新的个人 IP",
        body: "需要统一视觉风格、可复用场景、稳定封面，以及低成本的长期返工。",
      },
      {
        title: "使用 Codex 或 Claude Code 的团队",
        body: "希望 Agent 不只给建议，而是按明确合同完成本地制作、检查和交付。",
      },
    ],
  },
  faq: {
    title: "开始之前，通常会问这些。",
    intro: "把隐私、控制权、画质和能力边界先说清楚，比承诺“一键完成”更重要。",
    items: [
      {
        question: "素材会上传到云端吗？",
        answer:
          "默认不会。咔嚓优先使用本地工具处理；只有网络素材、云端生成或发布确有需要，并且获得明确授权时，相关文件才会离开本机。",
      },
      {
        question: "会不会把一句话剪断，或者把节奏剪得很假？",
        answer:
          "结构精剪不能只按静音阈值执行。咔嚓会检查完整语义、呼吸、表情、画面连续性和连接余量；自动结果仍需当前版本人工通看。",
      },
      {
        question: "能尽量保持原画质和原尺寸吗？",
        answer:
          "默认保持源像素尺寸、宽高比、有效帧率和色彩合同。局部返工会尽量冻结或复制无关媒体流；具体是否重编码取决于实际修改内容。",
      },
      {
        question: "我还可以继续自己修改吗？",
        answer:
          "可以。咔嚓保存计划、配置、差异和中间资产，既可以让 Agent 继续增量返工，也可以把结果交给现有 NLE 或项目指定引擎继续处理。",
      },
    ],
  },
  install: {
    title: "把咔嚓交给你的 Agent。",
    body:
      "支持 Codex 与 Claude Code。安装后用自然语言说明素材、目标和限制，咔嚓会先建立方案与边界，再进入实际制作。",
    agentLabel: "支持的运行环境",
    copy: "复制安装命令",
    copied: "已复制",
    note: "需要 Node.js 20+；完整媒体链路还需要 FFmpeg 与 FFprobe。安装器不会覆盖已有版本。",
  },
  contact: {
    title: "看真实效果，或者直接联系我。",
    body:
      "“行者大灰”持续发布咔嚓的真实剪辑、前后对比和制作复盘。欢迎通过常用平台关注，也可以直接发邮件交流使用问题、合作或反馈。",
    emailLabel: "邮箱",
    channelsLabel: "扫码查看真实视频效果",
    channels: [
      { id: "wechat", name: "视频号", note: "行者大灰" },
      { id: "douyin", name: "抖音", note: "行者大灰" },
      { id: "xiaohongshu", name: "小红书", note: "行者大灰" },
    ],
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
    problems: "Problems",
    outcomes: "Results",
    styles: "Four grammars",
    workflow: "Workflow",
    install: "Install",
    contact: "Contact",
  },
  hero: {
    eyebrow: "A local-first AI editing workflow for talking-head and content videos",
    titleLead: "From raw footage",
    titleAccent: "to a publishable cut.",
    summary:
      "Kacha lets Codex or Claude Code run structure edits, dialogue cleanup, caption calibration, visual packaging, incremental revisions, and QC as one professional workflow. AI executes; you keep the final judgment.",
    primaryCta: "See what it solves",
    secondaryCta: "Install Kacha",
    contracts: ["Media stays local by default", "Complete meaning stays intact", "Every change is traceable"],
    visualLabel: "Kacha workflow from raw footage to a publishable candidate",
    caption: "Not a one-shot generation—a workflow you can inspect, revise, and deliver",
  },
  proofLabel: "How Kacha works",
  proof: [
    { value: "LOCAL", label: "local-first media handling" },
    { value: "FULL", label: "end-to-end post workflow" },
    { value: "DELTA", label: "affected layers only" },
    { value: "118", label: "regression checks" },
  ],
  problems: {
    title: "The timeline is not the only expensive part.",
    intro:
      "People looking at AI editing are rarely missing another effect. They worry that automation will cut the meaning, damage the voice, scramble captions, and still leave them rebuilding the video by hand.",
    items: [
      {
        number: "01",
        title: "The pause is gone—and so is half the sentence",
        body: "Silence-only cutting can damage negation, conditions, causality, and conclusions. Meaning must lead every cut.",
      },
      {
        number: "02",
        title: "Voice, captions, and visuals drift apart",
        body: "Tool chains create timing drift. Dialogue, music, SFX, captions, and picture need the same frame boundaries.",
      },
      {
        number: "03",
        title: "More effects, less visual coherence",
        body: "Captions, cards, PIP, and transitions become a collage unless one design system governs them.",
      },
      {
        number: "04",
        title: "One small change triggers a full rebuild",
        body: "A caption, mix, or local visual revision should not invalidate the whole project. The workflow must know what changed.",
      },
    ],
  },
  outcomes: {
    title: "See the change before the feature list.",
    intro:
      "Kacha turns the results viewers actually notice into editing contracts that can be executed and checked.",
    demoNote: "These are capability diagrams. See the 行者大灰 channels below for real videos and ongoing demonstrations.",
    beforeLabel: "Common failure",
    afterLabel: "Kacha treatment",
    items: [
      {
        kicker: "STRUCTURE",
        title: "Tighter, without cutting the thought",
        body: "Remove dead pauses, mistakes, and repetition while preserving complete meaning, natural emphasis, and comic timing.",
        proof: "Every cut checks semantics, breath, picture continuity, and handles.",
      },
      {
        kicker: "AUDIO + CAPTIONS",
        title: "Clear to hear and easy to read",
        body: "Separate dialogue before cleanup. Speech leads caption timing while the script calibrates names, numbers, and context.",
        proof: "Dialogue, captions, music, and SFX share one timing contract.",
      },
      {
        kicker: "VISUAL SYSTEM",
        title: "Motivated effects, coherent frames",
        body: "Cards, PIP, masks, emphasis, and transitions appear only when information, emotion, or viewpoint changes.",
        proof: "Typography, color, radius, shadow, motion, and avoidance share one system.",
      },
      {
        kicker: "INCREMENTAL REWORK",
        title: "Feedback without a full rebuild",
        body: "Compile notes such as “raise the captions” or “lower the music” into a delta and rebuild only the affected layer.",
        proof: "Freeze unrelated streams and prove they did not change.",
      },
    ],
  },
  styles: {
    title: "Four styles, four editing grammars—not one card system reskinned.",
    intro:
      "They share subject safety, caption legibility, and brand rules, but differ in time unit, spatial topology, transitions, and sound. Kacha compares seven grammar axes pairwise and fails a cosmetic reskin.",
    auditLabel: "PRODUCTION EVIDENCE",
    auditValue: "4 grammars · 240 effects · 1,920 landscape/vertical peak frames · 960 motion contracts",
    items: [
      {
        id: "light",
        kicker: "EDITORIAL CONTINUITY",
        title: "Light Warm Overlay",
        body: "Keep the talking-head thought continuous. Add one edge note and a restrained evidence zone instead of interrupting the speaker with a dashboard.",
        sequence: "complete thought → margin note → evidence → clean A-roll",
        sound: "Quiet by default; one soft paper or air cue for a major note.",
      },
      {
        id: "spatial",
        kicker: "DEPTH NAVIGATION",
        title: "Spatial Light Path",
        body: "Establish world coordinates first, then move the path, focus, and camera through a real relationship. Text belongs to depth, not floating web cards.",
        sequence: "establish space → route arrives → focus travels → destination holds",
        sound: "Origin and destination share one directional tonal phrase.",
      },
      {
        id: "comic",
        kicker: "COMEDIC TIMING",
        title: "Humor Comic",
        body: "Panels appear only when a real contrast exists. Setup, silence, reaction, punchline, and callback create the joke—not a comic filter.",
        sequence: "setup → half-beat hold → reaction → punchline → callback",
        sound: "Silence carries timing; at most one dry cue after the action.",
      },
      {
        id: "pixel",
        kicker: "STATE MACHINE",
        title: "Pixel Editorial",
        body: "Pixels organize graphic state while people, evidence, and readable copy stay sharp. Each beat commits one verifiable state change.",
        sequence: "input → rule → state commit → verified result",
        sound: "A UI cue fires only when the underlying state actually changes.",
      },
    ],
  },
  system: {
    title: "Finishing a video takes these capabilities working together.",
    intro:
      "Kacha is not a collection of isolated AI features. It keeps content, sound, visuals, captions, and quality checks in one shared context.",
    features: [
      {
        kicker: "CONTENT EDIT",
        title: "Structure and fine cut",
        body: "Find mistakes, repetition, rambling, and dead pauses without damaging meaning or natural delivery.",
      },
      {
        kicker: "VOICE & SOUND",
        title: "Dialogue and mix",
        body: "Dialogue separation, cleanup, enhancement, music, SFX, and loudness serve long-listening comfort.",
      },
      {
        kicker: "CAPTIONS",
        title: "Caption calibration",
        body: "Speech leads, scripts calibrate, and names, numbers, semantic breaks, line length, and bilingual hierarchy are checked.",
      },
      {
        kicker: "VIDEO DESIGN SYSTEM",
        title: "Visual packaging",
        body: "One system drives captions, cards, PIP, diagrams, masks, openings, transitions, covers, and motion.",
      },
      {
        kicker: "OPTIONAL PORTRAIT",
        title: "Restrained portrait polish",
        body: "Beauty v2 is off by default and limited to smoothing, whitening, tone evening, and fold softening without changing identity.",
      },
      {
        kicker: "FAIL-CLOSED QC",
        title: "Quality gates",
        body: "Check decode, tracks, geometry, loudness, sync, black frames, and silence clues before the human watch-through.",
      },
    ],
  },
  workflow: {
    title: "One source, six stages, until it is deliverable.",
    intro:
      "Each stage records inputs, outputs, authorization, failure conditions, and revision scope. What changed, why, and how it was checked remain traceable.",
    steps: [
      { title: "Understand the job", body: "Lock the goal, audience, platform, format, authorization, and success criteria." },
      { title: "Edit the structure", body: "Remove waste and check every cut for meaning, rhythm, and continuity." },
      { title: "Process the sound", body: "Separate and polish dialogue, then place music, SFX, and final loudness." },
      { title: "Package the picture", body: "Use the design system for captions, media, PIP, masks, and transitions." },
      { title: "Respond to feedback", body: "Compile revision notes into a delta and render only affected work." },
      { title: "Check delivery", body: "Technical QC, same-source A/B, and human review decide release status." },
    ],
    resultLabel: "DELIVERY STATE",
    result: "READY FOR HUMAN APPROVAL",
  },
  principles: {
    quoteLead: "AI handles repetition. ",
    quoteAccent: "You keep the final judgment.",
    body:
      "Kacha does not call one generation a final video or a technical pass a human approval. Its advantage is not choosing taste for you—it makes each decision easier to execute, verify, and revise.",
    items: [
      {
        title: "Local first",
        body: "Media stays local by default. External transfer, paid generation, and publishing need explicit authorization.",
      },
      {
        title: "Controllable process",
        body: "Plans, configuration, asset provenance, change scope, and QC evidence remain available when something goes wrong.",
      },
      {
        title: "Verifiable quality",
        body: "Preview, candidate, automated checks, human review, and publication are separate states.",
      },
    ],
  },
  fit: {
    title: "Built first for these videos and creators.",
    intro:
      "Kacha prioritizes people who need to preserve real human delivery while reducing repetitive post-production work.",
    items: [
      {
        title: "Talking-head and knowledge videos",
        body: "Remove mistakes and pauses while protecting logic, tone, expression, and natural rhythm.",
      },
      {
        title: "Tutorials, interviews, and video podcasts",
        body: "Long-form structure, clean dialogue, accurate captions, information graphics, and platform versions.",
      },
      {
        title: "Consistent personal brands",
        body: "A reusable visual system, scenes, covers, and lower-cost revisions for ongoing publishing.",
      },
      {
        title: "Codex or Claude Code teams",
        body: "Use an Agent to execute a local production, inspection, and delivery contract—not just offer suggestions.",
      },
    ],
  },
  faq: {
    title: "What people usually ask before they start.",
    intro: "Privacy, control, quality, and limits deserve a clear answer before any “one-click” promise.",
    items: [
      {
        question: "Will Kacha upload my footage?",
        answer:
          "Not by default. Kacha prefers local tools. Files leave the machine only when external media, cloud generation, or publishing is necessary and explicitly authorized.",
      },
      {
        question: "Will it cut a sentence in half or make the pacing feel fake?",
        answer:
          "Fine cuts cannot rely on silence thresholds alone. Kacha checks complete meaning, breath, expression, picture continuity, and handles; the current candidate still requires a human watch-through.",
      },
      {
        question: "Can it preserve source quality and geometry?",
        answer:
          "By default it preserves pixel dimensions, aspect ratio, effective frame rate, and the color contract. Incremental work freezes or copies unrelated streams where possible; re-encoding depends on the requested change.",
      },
      {
        question: "Can I keep editing the result myself?",
        answer:
          "Yes. Kacha keeps plans, configuration, deltas, and intermediate assets so an Agent can continue incrementally or an existing NLE can take over.",
      },
    ],
  },
  install: {
    title: "Give Kacha to your Agent.",
    body:
      "Kacha supports Codex and Claude Code. Describe your media, goal, and constraints in plain language; Kacha establishes the plan and boundaries before production starts.",
    agentLabel: "Supported Agent environments",
    copy: "Copy install command",
    copied: "Copied",
    note: "Requires Node.js 20+; the full media workflow also needs FFmpeg and FFprobe. The installer will not overwrite an existing version.",
  },
  contact: {
    title: "See real results or contact me directly.",
    body:
      "行者大灰 publishes real Kacha edits, before-and-after comparisons, and production reviews. Follow on the platform you use, or email questions, collaboration ideas, and feedback.",
    emailLabel: "Email",
    channelsLabel: "Scan to see real video results",
    channels: [
      { id: "wechat", name: "WeChat Channels", note: "行者大灰" },
      { id: "douyin", name: "Douyin", note: "行者大灰" },
      { id: "xiaohongshu", name: "Xiaohongshu", note: "行者大灰" },
    ],
  },
  footer: {
    tagline: "Plan · Cut · Polish · Verify",
    docs: "Docs",
    credit: "Built by 行者大灰",
  },
};
