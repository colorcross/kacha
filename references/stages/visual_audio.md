# Visual + Audio 阶段紧凑合同

目标：把冻结计划编译为统一时间线，不制造多次整片转码。

- 所有画面、字幕、呼吸、叠加层、人声、BGM 和 SFX 进入一个 Timeline IR；
  Render Graph 决定执行，正式画面最多一次完整高质量编码。
- 预览最多 1920 宽并使用快速编码；返工只重建变化区间及 handle。纯音频返工
  stream-copy 视频，纯封面返工不处理视频。
- 字幕单行、不中断语义、不出安全区；普通字幕无音效，逻辑重音才允许强调与
  对应音效。黄色/明亮卡片必须切换深色字幕或增加可读阴影。
- 弹窗、卡片、PIP 和分屏不得遮挡头部；PIP 必须完整适配并带设计系统边框。
- Beauty v2 默认关闭；启用时只做磨皮、美白、匀肤、法令纹，必须同帧 A/B 和
  时序闪烁检查。
- BGM 按工程声音合同选用；通用工程可不配乐或使用简单配乐。要求自适应 BGM 时，
  从最终语义 cues 按说话节奏、情绪与信息密度安排段落、编配和留白，并提供专业提示词、
  `audio.bgm.segments[]` 与计划区间相对人声差。所有启用的音乐/SFX仍需适用的组件/mix
  stems、组件重建与最终成片匹配证据；SFX语义匹配、峰值对齐、不盖人声。
- 生成 BGM 或本地库缺失的 SFX，必读 `references/minimax-audio-fallback.md`：
  BGM 默认已登录 MiniMax Audio 网页版；不可用时再考虑 MiniMax Design 和 mmx。
  含音频的视频默认本机 MiniMax Design，读取 `references/generated-media-assets.md`。
  提交结果未知先对账，不跨渠道重复提交；本地音效库仍优先。
- Demucs、ASR、蒙版、跟踪、Beauty、样式帧和生成素材一律使用内容指纹缓存；
  Demucs/ASR 额外冻结真实模型内容与服务实现 SHA。
- `production-quality` execution 门禁按项目政策版本执行：legacy 保留原主开场与逐项 SFX 要求；
  narrative-v1 允许真实叙事开场，清单按口播逐项出现，音效按实际语义触发；同屏最多一个主效果；多行字幕只表达对比/因果/层级/
  递进并逐行出；人物身后文字不超过 7 字；PIP 有信息差和三态避碰；外部素材
  有对象/动作/状态/角色/时态与来源；BGM 提示词覆盖乐器、风格、节奏、音色、
  和弦与高低频控制。以下电影级 3D 封面规则仅适用于历史 xingzhe-dahui 包：只用获批三视图作为生成身份锚点，真人
  正面照只做生成后辨识 QC，禁止进入生成或混合输入。人物动作、表情和服装必须
  按当期场景适配，任何模式都不得直接把三视图站姿作为正式海报姿态。
- 前 60 秒数量下限只适用于 legacy 工程，按其 production pack 的栏目规则校验。新版
  narrative-v1 检查必需表达、触发理由与实际执行，不凑效果/机制/SFX 数。两版均保留
  密度上限、人物在场、呼吸空间及正常速度代表预览，静态帧不能放行。
- 复杂效果允许带完整依赖身份的局部合成缓存；普通间隙不重复编码。高位深/HDR
  未验证组合必须阻断，不以 yuv420p 默默替换源规格。
- 真实局部预览使用 `real-preview request` 或 Studio 按钮；Canvas 只辅助定位。

稳定入口：

```bash
node scripts/kacha.mjs timeline validate --plan timeline-ir.json
node scripts/kacha.mjs render project-manifest.json
```

新版能力按项目 `editorialPolicy.version` 选择，细节按需读 `references/optimization-execution.md`。legacy 工程不自动改政策。
