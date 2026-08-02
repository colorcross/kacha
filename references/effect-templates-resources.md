# 效果模板与资源目录

## 结论

咔嚓的效果不能只停留在名称列表。模板解析器把内置视觉系统、场景、组件、动效、字体、音效角色、资源槽位、安全区、时序、回退和失败条件合成一份可执行合同。

名称与合同仍不足以约束视觉预期。行者风同时维护自动生成的参考图库：

```bash
node scripts/kacha.mjs design gallery \
  --output design/reference-gallery/xingzhe-v2 --overwrite
```

图库覆盖全部 52 个组件、69 个场景、8 个渲染器、36 个布局和 75 个动效。
设计预检应先查看对应参考图，再结合真实人物、画幅和素材做代表区间预览；
参考图、效果计划和正式渲染必须使用同一 design digest。

项目内另有四套全量高保真峰值帧库，均覆盖 240 个效果的横版与竖版：

- `设计参考/行者风高保真样板/全量效果库_v3_浅暖轻浮层/`
- `设计参考/行者风高保真样板/全量效果库_v3_空间光路/`
- `设计参考/行者风高保真样板/全量效果库_v4_幽默漫画/`
- `设计参考/行者风高保真样板/全量效果库_v4_像素风/`

四套库共 1920 张参考图。对应的 960 份可执行合同统一登记在
`config/effects/motion-contracts/design-effect-library-v3.json`，可直接检查
和解析：

```bash
node scripts/kacha.mjs templates validate
node scripts/kacha.mjs templates list
node scripts/kacha.mjs templates list --category transition
node scripts/kacha.mjs templates resolve --template effect-semantic_evidence_insert
node scripts/kacha.mjs templates resolve --signal logical_emphasis --output /absolute/effect-plan.json
node scripts/kacha.mjs contracts validate
node scripts/kacha.mjs contracts list --kind scene --style xingzhe-light-overlay
node scripts/kacha.mjs contracts resolve \
  --id process_progressive \
  --style xingzhe-humor-comic
```

当前提供 62 个解析后模板，覆盖：

- 10 个开场模板；
- 10 个转场模板；
- 7 个语义画面模板；
- 4 个贴纸与视线引导模板；
- 6 个空间分层与纵深模板；
- 4 个关键帧参数模板；
- 9 个并列句排版模板；
- 7 个口播字幕布局模板；
- 5 个画面呼吸模板。

模板使用“家族合同 + 具体绑定”。公共参数只在家族中定义，具体效果只写差异，禁止把颜色、字体、时序和安全区散落到项目时间线。

### 四套流程动效风格

流程、阶段和清单类内容默认从四套独立视觉语言中选择，不再把一个视觉样式硬套到
所有内容：

- `effect-process_spatial_nodes`：空间光路。小体积玻璃节点、理性蓝连接线、
  橙红当前节点、景深和少量粒子；适合 AI、工具、技术流程和强调空间关系的内容。
- `effect-process_light_overlay`：浅暖轻浮层。透明暖白小卡、可见实拍背景、
  当前与相邻节点窗口、轻微漂移和局部高亮；适合知识、方法、清单和更亲和的
  叙述。
- `xingzhe-humor-comic`：幽默漫画。用成人编辑漫画的分格、墨线、克制网点、
  反应特写与短气泡放大真实反差；适合预期落差、误会、尺度错位和回扣，不适合
  严肃证据、哀伤或没有笑点的普通信息。
- `xingzhe-pixel-editorial`：像素风。以 6–12 px 基础网格、有限强调色、硬边图形
  和 2–4 帧步进运动组织状态与流程；适合 AI、工具、规则、计数、系统状态和
  复盘，不像素化人物、事实证据和可读文字。

四者都必须解析对应 `motionContract`。合同不是参考文案，而是正式执行输入，
至少包含：

- 不可破坏的叙事、安全区、局部更新和退场约束；
- 节点数、标签、尺度、路径/窗口、透明度、节奏、景深和粒子等可调参数；
- 人物左/右/居中、横/竖版、语速、长标签和拥挤画面的适配规则；
- 进入、停稳、推进、退出的帧数与缓动；
- 音效功能、视觉峰值、增益起点、最大使用次数和人声闪避；
- 正常速度预览、横竖版独立构图和碰撞检查。

参考实现：

- `videos/workflow-spatial-motion` / `videos/workflow-spatial-motion-vertical`
- `videos/workflow-light-overlay` / `videos/workflow-light-overlay-vertical`

这些实现用于证明模板确实能动、能调、能按画幅重排。正式项目仍需换成当前
视频帧、真实人物位置和口播时间，不得把样板 MP4 或峰值帧直接贴进成片。

## 选择顺序

1. 用户明确指定的效果；
2. 文稿或画面中的真实触发：信息、情绪、视角、时间、空间、动作；
3. 匹配该触发的模板；
4. 检查资源、人物头脸、字幕、品牌和平台 UI；
5. 资源或安全区不满足时走模板 fallback；
6. 没有叙事理由时保持原镜头。

同一时刻只允许一个主效果。同一主模板建议至少间隔 6 秒；10 秒内主效果不超过 2.5 个。普通连接默认干净切，普通口播默认单行金陵体字幕。

## 资源层级

核心目录 `config/resources/core-catalog.json` 包含原创 SVG、品牌资源、原创音效入口、运行时动态背景和逻辑槽位。用户目录 `tools.resourceCatalog` 可增加项目私有字体、音效和素材，但不能覆盖核心资源 ID 或改变核心许可。

真实世界图片和视频不做无语义的批量预装。每个镜头按以下顺序选择：

1. 项目真实证据或用户素材；
2. 官方来源；
3. 逐文件核验许可与署名的 Wikimedia Commons；
4. 项目私有下载的 Pexels/Pixabay；
5. 获授权后生成并记录披露决策；
6. 设计系统信息卡或不用插镜。

下载素材必须记录 source URL、作者、许可页面、文件格式、尺寸/时长和 SHA。素材必须匹配对象、动作、人物、状态、方向和时态；仅“关键词相近”不合格。Pexels/Pixabay 原文件不得随公开咔嚓仓库作为库存素材再分发。

## 字体

模板不写字体文件名，只写语义角色。项目私有目录把角色解析为已授权字体并校验 SHA：

- 主字幕和逻辑重音：真正的方正粗金陵简体，无底板、无描边、阴影 60%；
- 中文视频标题、术语、金句和大号字：华光标题黑，可使用受控透明渐变；
- 封面主标题：封神榜书；
- 数据辅助文字、工具标识、英文、来源、栏目、期号、系列与封面其他文字：思源黑体细体。

以上四套风格不得使用其他字体。任一字体缺失、SHA 改变或缺字时阻断；确需例外时必须记录原因并通过可见预检，不静默回退。漫画和像素材质只能作用于图形层，不能把字幕替换成漫画字或点阵字。

## 音效

模板只声明 `trigger` 和声音功能，最终文件由私有 `kacha-profile.json` 精确路由。每个音效必须有可见动作、文字落位、转折或叙事落点；普通字幕、慢推、慢移和静止不配音效。视觉停稳与音效峰值误差不超过 1–2 帧。

幽默漫画优先使用干燥短促的 `pop`、`paper_flick`、`sweep`、`awkward`、转折和反应类角色，禁止罐头笑声与连续轰炸；像素风优先使用 `ui`、`typing`、`timer`、`reward`、`error` 等状态音，但只有真实输入、确认、奖励或失败发生时才能触发，禁止用复古音乐循环把整段伪装成游戏。

## 资源缺失

- 图标：优先原创资源；必要时按需取得 MIT 许可的 Tabler 图标并保留许可记录。
- 纹理：优先原创 SVG；必要时按需取得 ambientCG 的 CC0 纹理并记录 source URL 和 SHA。
- 照片/视频：使用 `scripts/fetch_stock_media.py` 小批量按镜头搜索，不建泛化库存。
- 找不到语义准确且许可明确的素材时，使用信息卡、屏幕录制、项目实拍，或把需求列为人工补充项。
