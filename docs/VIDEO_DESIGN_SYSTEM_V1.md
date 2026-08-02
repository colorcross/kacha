# 咔嚓视频设计系统 V1.5

> 本文定义“成片内部”的视频设计系统。官网、GitHub、文档和产品界面的品牌
> 规范另见[产品品牌与官网设计规范](PRODUCT_BRAND_AND_WEBSITE.md)，两者共享
> 真实、克制和可验证原则，但不共享全部色板和组件。

## 1. 目标

视频设计系统把栏目身份、视觉令牌、画幅适配、组件、场景、动效、声音功能、
安全区、设计预检和质量检查连接成一份可执行合同。它解决以下问题：

- 字体、颜色、圆角、阴影、边框和缓动散落在时间线各处；
- 同一类信息卡、弹窗、画中画和转场在不同视频中长得不一样；
- 横版、竖版、中文、英文、双语和亮/暗底需要重复手调；
- 设计稿与实际渲染之间没有稳定的组件和场景映射；
- 返工时无法判断哪些视觉层可以复用、哪些必须失效重建。

系统不替代内容判断。只有信息、情绪、视角、证据或任务状态发生真实变化时，
才选择相应场景；不能因为库里有某个组件就强行使用。

## 2. 系统结构

```text
栏目与品牌
    ↓
Style Profile
    ↓
五组 Mode（栏目 / 画幅 / 语言 / 表面 / 密度）
    ↓
52 个 Component
    ↓
69 个 Scene
    +
33 个语义网感机制
    +
62 个预制效果模板 / 22 个公共核心资源
    ↓
8 个生产 Renderer / 36 个 Layout / 75 个 Motion
    ↓
240 张带摘要的参考效果图

项目内高保真层另外提供 `浅暖轻浮层`、`空间光路`、`幽默漫画` 与 `像素风`
四套风格。每套为全部 240 个效果分别设计 16:9 与 9:16 峰值帧，共 1920 张；同时由
`design-effect-library-v3.json` 提供 960 份可执行动效合同。基础 SVG 图库用于
快速检索，项目内高保真图库用于构图对齐，合同用于正式时间行为，三者不能互相
替代。两套新增视觉语言的完整叙事边界、材质、动态、声音与 QC 规则见
`docs/HUMOR_COMIC_VISUAL_LANGUAGE.md` 和 `docs/PIXEL_EDITORIAL_VISUAL_LANGUAGE.md`。
四套风格的镜头组织、时间单位、空间拓扑、转场和声音必须按
`docs/FOUR_STYLE_EDITING_GRAMMARS.md` 分离；不得只更换表面材质。
    ↓
Design Preflight
    ↓
本地渲染 / 条件 Figma 交接
    ↓
视觉与时间线 QC
```

唯一事实源位于：

```text
config/design-system/system.json
config/design-system/modes.json
config/design-system/components.json
config/design-system/scenes.json
config/design-system/implementations.json
config/styles/xingzhe.json
config/effects/z-en-netstyle.json
config/effects/templates.json
config/resources/core-catalog.json
```

渲染代码只能消费解析后的令牌、组件 ID、场景 ID 和设计摘要。禁止在单个时间
区间重新发明字体、色值、圆角、阴影、边框、安全区或缓动。

默认 profile 是 `xingzhe`（行者风）。其主字幕与辅字幕使用本地已授权的
真正金陵体 `方正粗金陵简体 / FZJinLS-B-GB`；正式项目必须冻结字体文件
SHA-256 与授权证据，不能静默换回替代字体。字体二进制不属于公开设计系统。
行者风 2.0 的拍摄画面、语义色、渐变、封面人物比例与栏目差异见
[行者风 2.0 完整实施规范](XINGZHE_STYLE_V2.md)。

## 3. 五组模式

### 3.1 栏目 `show`

- `tool-share`：工具分享；界面、流程和证据优先；
- `book-talk`：解读好书；引用、章节和来源优先；
- `infinite-game`：有限的无限游戏；纪录片、时间线和长期关系优先；
- `very-ai`：灰常AI；人与 AI 的互动、任务和核验优先。

正式封面和栏目标签必须遵守项目当前栏目名与独立期号规则。

### 3.2 画幅 `aspectRatio`

- `landscape-16x9`
- `portrait-9x16`
- `square-1x1`

画幅模式同时改变网格、安全边距、平台 UI 排除区和字幕位置。适配不是简单
缩放；人物、标题、字幕、品牌和弹窗都要重新流动。

### 3.3 语言 `language`

- `zh`
- `en`
- `bilingual`

双语模式中英文为主、中文为辅时，由字幕组件控制字号、行距和信息密度，
不能把两个独立字幕层随意叠在一起。

### 3.4 表面 `surface`

- `footage`：真人或实拍画面；
- `light`：明亮暖色信息画布；
- `dark`：深色情绪或技术画布。

字幕和文字颜色必须由表面模式决定。亮底白字、暗底深字均视为失败。

### 3.5 密度 `density`

- `compact`
- `standard`
- `spacious`

密度只改变信息间距和组件容量，不改变字号下限、人物安全区或平台安全区。

## 4. 组件库

V1 注册 52 个组件，覆盖以下类别：

- 品牌：栏目标签、期号、常驻品牌角标、来源、披露和状态；
- 字幕：单行、双语、逻辑重音、引用、角色和修正；
- 文字：章节标题、核心判断、数字冲击、定义、逐字打字、人物后文字；
- 卡片：信息、要点、三项理由、定义、引用、来源、警示、对比、前后对比、
  评分和检查清单；
- 画面：全屏插镜、矩形/圆形/方形/不规则画中画、横纵分屏、人物安全弹窗、
  屏幕焦点标注；
- 数据与流程：指标网格、条形图、折线图、占比图、时间线、渐进流程、
  决策树、证据阶梯和进度节点。

每个组件必须具备 `slots`、`states`、`renderer`、`tokenRefs`、`safety` 和
`fallback`。实现或构图失败时，必须走注册的降级组件。

## 5. 场景库

V1.2 注册 69 个场景，覆盖：

- 开场：冷开场、标题、逐字命令、关键词、结果先行、问题、人机对话和纪录片；
- 叙事：章节、核心判断、普通/强调/双语字幕、引用、定义、修正和不确定性；
- 解释：信息卡、要点、三项理由、来源、警示、工作流、时间线和决策路径；
- 比较与数据：双项、前后、美颜、音频 A/B、指标、数字、图表和证据等级；
- 工具与 AI：全屏操作、操作加 PIP、点击放大、形状 PIP、上下/左右分屏、
  AI 幕后回应和事实核验；
- 连接：插镜回真人、声音桥、景别变化、局部遮切、人物后文字和时间跳跃；
- 结尾与封面：判断收束、自然结束、行动导流、编辑部/对比/人机/纪录片封面。

场景定义 `trigger`、`layout`、`entry`、`exit`、组件组合和 `fallback`。时间线
优先引用场景；只有场景无法表达时才新增组件或新场景。

六个 `netstyle_*` 场景把语义动效、空间舞台、贴纸引导、关键帧和并列句
接入设计系统。33 个具体机制位于 `config/effects/z-en-netstyle.json`；
机制注册表不保存字体、颜色或素材，只保存触发、功能、运动、声音、失败和
QC，避免把参考风格写死到时间线。

正式应用由 `netstyle plan → validate-plan → render-plan` 完成。时间线事件
只保存当前内容、机制 ID、帧边界、真实资源引用与设计摘要；渲染时重新解析
当前设计令牌，并按人物蒙版、证据素材和安全区条件执行或阻断。输出不含
showcase 的家族标签、效果名称和固定示例文字。项目在
`plans.netstyleTimelines` 中登记计划，设计或机制 digest 变化会使旧计划
失效。

画面呼吸与口播字幕排版使用独立能力注册表：

- `config/effects/visual-breathing.json`：慢推、慢拉、横移、重音冲击和停稳；
- `config/effects/spoken-caption-layouts.json`：普通单行、逻辑重音、左右、
  侧边、上下和前后景布局；
- `config/font-routing.json`：金陵体字幕、华光标题黑展示字、封神榜书封面标题和细体辅助文字的限定角色。
- `config/design-system/visual-languages.json`：四套高保真视觉语言的材质、布局、碰撞、对比度、品牌、动态和声音母合同。

它们进入 design digest，但不把本地字体文件写进系统。正式应用分别走
`breathing plan → validate → render` 和
`captions plan → validate → render`；排版计划冻结实际字体文件 hash 与项目
授权记录，前后景布局同时冻结逐帧人物蒙版。

V1.5 把注册表进一步编译为 62 个预制效果模板。模板覆盖开场、转场、语义
画面、贴纸/视线、空间纵深、关键帧、并列句、字幕布局和画面呼吸；每个模板
统一声明场景、组件、进入/停稳/退出、字体角色、音效触发、人物/字幕/品牌
安全区、资源槽位、失败条件和回退。22 个公共核心资源包括原创 SVG、品牌、
原创音效入口和字体路由；其中四个剪辑语法母件分别对应边缘旁注、空间路径、
漫画节拍和像素状态。项目私有目录只扩展授权字体、私有音效和按镜头取得的
素材，不能覆盖核心许可。

## 6. 解析与检查

```bash
node scripts/kacha.mjs design validate
node scripts/kacha.mjs design list --kind component
node scripts/kacha.mjs design list --kind scene
node scripts/kacha.mjs design show --kind scene --id process_progressive
node scripts/kacha.mjs design resolve \
  --show very-ai \
  --aspect portrait-9x16 \
  --language bilingual \
  --surface footage \
  --density standard
node scripts/kacha.mjs design preview \
  --scene process_progressive \
  --aspect portrait-9x16 \
  --output /tmp/process-progressive.svg
node scripts/kacha.mjs design render \
  --scene process_progressive \
  --aspect portrait-9x16 \
  --output /tmp/process-progressive.svg \
  --manifest /tmp/process-progressive.manifest.json
node scripts/kacha.mjs design qc \
  --matrix \
  --output /tmp/design-system-qc.json
node scripts/kacha.mjs design gallery \
  --output design/reference-gallery/xingzhe-v2 \
  --overwrite
node scripts/kacha.mjs design library-qc \
  --light /path/to/全量效果库_v3_浅暖轻浮层 \
  --spatial /path/to/全量效果库_v3_空间光路 \
  --comic /path/to/全量效果库_v4_幽默漫画 \
  --pixel /path/to/全量效果库_v4_像素风 \
  --contracts config/effects/motion-contracts/design-effect-library-v3.json \
  --output /path/to/four-style-qc-report.json
```

效果与资源解析：

```bash
node scripts/kacha.mjs templates validate
node scripts/kacha.mjs templates list --category transition
node scripts/kacha.mjs templates resolve \
  --template effect-space_text_depth_wrap \
  --output /tmp/effect-plan.json
```

`design validate` 会检查注册表、ID、组件/场景降级链、令牌引用、默认模式和
最低覆盖数量，同时探测实际安装字体并记录每个角色的回退选择。`design
resolve` 生成最终样式、布局、字体证据与 SHA-256。`design render` 使用注册
renderer 生成 SVG/PNG/ASS 和实施清单，不再输出与组件无关的通用占位图。
`design qc --matrix` 覆盖每一个 mode 取值、关键组合、全部组件状态、场景
entry/peak/exit、重复 SVG ID 和文字对比度。任一输入变化，最终摘要变化，
依赖旧摘要的视觉产物必须失效。

`design gallery` 为注册表中每个 component、scene、renderer、layout 和
motion 生成独立 SVG 参考图、可搜索 `index.html` 与带 SHA-256 的
`manifest.json`。图库是策划、执行与返工的共同视觉合同；注册表或渲染实现
变化后必须重新生成。

## 7. 设计预检合同

所有高影响视觉模块必须在 `designPreflight` 记录：

- `designSystemId`、`designSystemVersion`、`designDigest`；
- `sceneId`、`componentIds`、`modeSelection`；
- `artifactMode` 与 `artifactRef`；
- `artifactSha256`、`implementationManifestRef` 和
  `implementationManifestSha256`；
- `layoutSpec`、`motionSpec`、`soundSpec`；
- `stateFrames`：进入、峰值/停稳、退出；
- `implementationHandoff`：五类实际字体、字体选择摘要和组件 token 路径；
- `qcEvidence`。

验证器会读取真实样式帧和实施清单，核对 hash、当前 design digest、场景、
组件和字体选择。手写一个看似合法的摘要、renderer 名称或不存在的设计文件
不能通过。预检通过只说明方案可以实施，不说明正式时间线已经通过。

## 8. 本地样式帧与 Figma

本地 JSON、SVG/PNG 样式帧是运行时事实源。多画幅、多状态、品牌组件、复杂
图表或多人协作时可使用 Figma。Figma 只能作为设计与交接后端，不能替代运行
时注册表；组件必须回写对应 ID、mode、node ID、导出证据和实现参数。未授权
真人素材或项目截图不得为了设计便利上传。

## 9. 渲染合同

- 字幕：语音为时间基准，文稿只校准；单行、不越界、避开平台 UI；
- 弹窗/卡片：在切回真人前提前完整退出，不能挡脸或侵占字幕；
- 渐进流程：持久底图只更新当前节点，禁止整屏闪烁；
- PIP：默认使用统一边框、阴影和安全边距，主体头像始终完整；
- 分屏：每一格先按主体重新构图，不得直接裁掉头部；
- 插镜：对象、动作、角色、时态、方向与当前口播一致；
- 连接：有信息、情绪或视角变化才切；优先声音桥、动作匹配或景别变化；
- 声音：每个视觉动作只绑定有叙事功能的 SFX，不连续轰炸、不盖人声。
- 呼吸：全片必须有停稳区；运动覆盖不超过 55%，连续同向缩放和无理由运镜
  不允许；
- 字幕排版：普通单行优先，左右/上下/前后只表达真实关系，同一时刻最多三个
  阅读区和一个主重音；
- 字体：按角色、字符覆盖、真实文件和项目授权路由，缺字或 hash 变化时阻断。

## 10. 视觉质量门禁

至少检查：

- 文字不溢出、字幕切分合理；
- 亮/暗底对比符合模式；
- 人脸、头顶、眼镜、手部和平台 UI 不被遮挡；
- 进入和退出严格跟随语义节拍；
- 插镜、弹窗和字幕在返回真人前清理完成；
- 渐进模块活动区域外没有亮度跳变；
- PIP、分屏和蒙版边缘无穿帮；
- 同类组件在整片中样式一致；
- 手机尺寸代表帧可读；
- 无效复杂效果能回退为简单场景。

系统级自动检查不能替代真人画面碰撞和正常速度动效复核。自动矩阵通过后，
每个正式项目仍需用真实代表帧检查人物头顶、字幕、平台 UI、遮罩边缘和声音
落点。

## 11. 增量返工

视觉产物指纹必须包含设计系统摘要、解析器/风格解析器/渲染器实现摘要、场景
与组件 ID、模式选择、素材哈希、字幕/文案版本、渲染参数与帧区间。只改 SFX
不应重渲视频；只改一个组件文案只失效该组件区间；改变风格、模式、系统摘要
或实现摘要会失效所有相关视觉层。最终候选仍需复核连接点和全片一致性。

## 12. 完成标准

1. 注册表与引用验证通过；
2. 配置可解析出稳定摘要；
3. 设计预检记录系统、场景、组件和模式；
4. 8 个 renderer、36 个 layout 和 75 个 motion 均由独立注册表验证，33 个
   语义网感机制也必须通过独立注册表与真实视频预览验证；
5. 52 个组件、69 个场景、8 个 renderer、36 个 layout 和 75 个 motion
   均有当前设计摘要对应的参考图，图库合计 240 张；
6. 所有组件状态与场景 entry/peak/exit 都能本地生成真实 SVG；字幕组件还能
   生成 ASS；
7. 样式帧实施清单包含当前解析器、风格解析器和渲染器实现摘要，旧代码生成的
   证据不能冒充当前设计系统产物；
8. `design qc --matrix` 覆盖全部 mode 取值和关键跨模式组合，字体与对比度
   门禁通过；
9. 样式帧和实施清单具备可复核 hash，伪造或过期证据被拒绝；
10. 示例配置、文档和测试与运行时一致；
11. 旧的散落配置不能绕过设计系统；
12. 正式视频仍通过自动 QC 和人工逐段审片。
