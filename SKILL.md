---
name: kacha
description: |
  “咔嚓”本地视频策划、精剪、包装、增量返工与验收。用于真人口播、多素材成片、字幕、声画、效果、封面及项目恢复；按任务加载合同，默认本地处理，不上传、不发布。
---

# 咔嚓

先把内容、切点与同步做对，再做视觉包装。用户在 Agent 中用自然语言操作，Agent 负责命令、素材索引、最小 delta、任务执行与证据回读，不让用户填写工程 JSON。

## 任务入口

| 用户目标 | 路径与必读材料 |
| --- | --- |
| 分析、方案、审查 | `proposal_review`；读取相关源码/合同，按用户范围输出方案或方案文档，不擅自开始剪片 |
| 单源首剪或结构重做 | `source_edit`；`references/project-workflow.md`、`references/editing-theory.md` |
| 多视频/图片成片 | `material_edit`；`references/material-editing.md` |
| 从书籍、文稿或选题开始 | `content_generation`；`references/production/control-and-orchestration.md` 的内容入口 |
| 已批准基线的局部返工 | `local_optimization`；`references/incremental-workflow.md` |
| 当前候选最终验收 | `references/qc-release.md`、`references/production/quality-contracts.md` |

改结构、顺序、时长、画幅走完整重建；局部字幕、声音、封面或效果优先走增量。保留现有工程和批准版本。

```bash
node scripts/kacha.mjs start --source SOURCE --project-root PROJECT
node scripts/kacha.mjs observe PROJECT
node scripts/kacha.mjs run PROJECT --confirm-execute
node scripts/kacha.mjs resume PROJECT --confirm-execute
```

`observe` / `status --quick` 只读进度，不能用于放行执行；`status --summary` 保留完整验证语义。唯一下一步由当前工程推导，不能根据对话记忆跳阶段。初始化、提交 job、自动 QC 都不等于完成。

## 所有任务保留的边界

- 源素材只读，新版本独立输出；用户未要求时保持源几何、有效帧率与色彩合同。不得把低清代理放大成正式片。
- 保留完整句意、条件、否定、数字、专名、因果与真实时序；切镜由信息、情绪或视角变化驱动。内容与事实先于效果。
- Timeline IR 是唯一正式时间线事实源；画面、人声、字幕、BGM/SFX 共用帧/PTS 合同。Studio Canvas 是近似预览，不能代替真实声画审片。
- 字体、素材、蒙版、模型、配置与实现按当前身份验证；未知许可、缺字、缺失证据不静默替换。不得把生成素材冒充真实事实依据。
- 用户点名及叙事必需的表达不能为省成本删除。条件增强须有真实触发；可选装饰只按项目已允许的回退执行。政策切换绑定项目版本，旧工程不自动降门槛。
- 普通字幕不配音效；同屏最多一个主焦点，保护人物头脸、字幕、安全区和阅读时间。真实反应、留白与现场声不能被配额挤掉。
- 音频处理前按合同分离人声，residual 不回混；现场声需来自真实源录音。BGM 按段落功能与留白编排，SFX 峰值对齐真实落位，不盖人声。
- 美颜默认关闭；明确启用只用本地 Beauty v2。FaceFusion、身份/声音处理读取专门合同，保留授权和逐镜复核。
- 缓存须匹配源、实现/模型、参数、schema 及产物 SHA。付费结果状态未知时先查询对账，不重复提交或把未知金额记 0。
- 重任务使用已有 jobs、主机资源锁与 telemetry；MPS、视频编码默认各单槽。取消先确认进程树退出，失败产物隔离后才恢复。
- 返工先做覆盖变化及 handle 的代表预览；同图复用，纯音频改动 stream-copy 视频，封面返工不动视频。一次成功终编预算与失败尝试成本分别记录，不能靠换版本掩盖试错。
- 自动技术检查、当前候选正常速度完整通看和发布门禁分别留证；人工证据未完成时只能称候选。
- 上传、公开发布、付费、购买授权和不可逆删除须在用户授权内。源、批准 stem、工程、许可、最终片及高价值缓存不自动清理。

## 按需能力合同

新旧政策与执行边界先读 `references/optimization-execution.md`；只读取实际涉及的模块，不一次加载全部。材料中的路径相对 skill 根目录。

| 涉及内容 | 读取 |
| --- | --- |
| Agent 控制、对象引用、mutation、异步任务 | `references/agent-chat-control-plane.md` |
| 开场、导演、专业剪辑与 J/L-cut | `references/professional-editing-craft.md`、`references/production/agent-and-review.md` |
| 人声、BGM、SFX、同步 | `references/audio.md`；SFX 另读 `references/sfx-library.md`；生成 BGM/缺失音效按 `references/minimax-audio-fallback.md` 执行 mmx → 已登录默认浏览器 → MiniMax Design |
| 视觉、PIP、蒙版、调色 | `references/visuals-masks.md` |
| 信息图、空间/语义动效、字景 | `references/visual-design-preflight.md`、`references/production/visual-execution.md` |
| 风格、效果合同 | `references/style-effects-library.md`、`references/effect-templates-resources.md` |
| 字幕、封面、系列身份 | `references/subtitles-covers-brand.md`；复杂身份/布局另读 `references/production/quality-contracts.md` |
| 美颜 / FaceFusion | `references/beauty-v2.md` / `references/facefusion.md` |
| 从网络找图片/视频并匹配当前片段 | `references/network-materials.md`；搜索→下载→实际观察/选段→许可→可撤销剪入，不用检索命中冒充事实证据 |
| 生成或外部素材 | `references/generated-media-assets.md`；费用、许可及参考派生另读 `references/production/control-and-orchestration.md` |
| 模型能力较弱、低推理强度、长任务续跑 | `references/agent-execution.md`；视觉证据另读 `references/visual-evidence.md` |
| 节目文稿 | `references/shows/README.md` 和本栏目风格卡；大灰AI遵守调用项目当前V6.1与 `docs/DAHUI_AI_EDITING_SYSTEM_V1.md`，旧V3.3仅用于明确指定的历史作品 |
| 资源/渲染效率、缓存、量化比较 | `docs/QUALITY_PRESERVING_EFFICIENCY_V8.md`、`references/production/control-and-orchestration.md` |
| 清理与保留 | `references/cleanup-retention.md` |
| 白板视频 | `docs/WHITEBOARD_ANIMATION.md` |

原入口的条件细节已分拆到 `references/production/`；首剪/返工详细命令见 `first-edit-and-rework.md`，只在对应步骤读取。

## 紧凑执行

不确定路由时用 `route_references.mjs --task TASK --modules ...`；阶段包用 `prepare --task TASK --stage inventory|content|edit|visual_audio|release`。按返回的 readOrder 阅读；高风险模块的必需合同不能因 Token 预算省略。缺能力时明确升级或阻断。

小改动先 `refs` 定位，再用 `delta apply` 的最小 JSON Pointer 操作；不要重写整份 timeline。完整转写按 `transcript index/slice` 获取必要区间。确定性规则用 `rules query`，低置信度只生成局部候选，不直接 final。

固定项目运行包使用 `runtime create|inspect|bind`；绑定不代表接受新合同。跨版本迁移保留旧工程，使用明确的运行更新入口重验。在制项目不因其他 Agent 更新自动改用新包。

## 开发与验证

改动前读工作树和受影响入口。源码开发期间保留当前可用安装；先受影响行为回归，再按仓库要求执行 `make check-full`，通过后原子同步并回读双 Agent 安装。MCP、工作台分发与安装器有独立套件；改相关模块须覆盖。

真实素材、正常速度审片与同源队列才能证明成片质量和生产收益。至少 8 个独立同源成对项目是整体效率声明条件，不妨碍先交付已验证的局部修复。公开包不包含项目私有字体、人物资产与源音效。

## 大灰AI新节目

先按调用项目最终方案选择 `dahui-ai` 生产包与八类 show ID。读 `docs/DAHUI_AI_EDITING_SYSTEM_V1.md` 和对应风格卡；使用 `episode template/validate` 与 production-quality 合同绑定实际材料。工作台默认新包，CLI 单源工程显式 `--pack dahui-ai --show ...`，或由新 show ID 自动路由。读书母片30–60分钟，辩论保存完整会话与双方发言索引；运动不强制AI关联。默认真人与证据、自然开场、可读字幕、按需声音，不继承旧3D封面、固定服装、期号或动效配额。用户/事实必需及已触发增强仍必须执行。旧工程及冻结运行时不自动迁移。
