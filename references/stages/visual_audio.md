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
- BGM 先从最终语义 cues 生成自适应计划，按说话节奏、情绪、内容和信息密度
  决定段落、编配、留白、频段与动态；禁止单一循环铺满全片。正式交付必须有
  专业提示词、`audio.bgm.segments[]`、组件/mix stems、计划区间相对人声差、
  组件重建和最终成片匹配证据。SFX 必须语义匹配、峰值对齐、丰富但不盖人声。
- Demucs、ASR、蒙版、跟踪、Beauty、样式帧和生成素材一律使用内容指纹缓存；
  Demucs/ASR 额外冻结真实模型内容与服务实现 SHA。

稳定入口：

```bash
node scripts/kacha.mjs timeline validate --plan timeline-ir.json
node scripts/kacha.mjs render project-manifest.json
```
