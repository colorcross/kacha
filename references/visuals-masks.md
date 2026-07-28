# 画面、插镜、美颜、蒙版与重构图

## 插镜语义与风格

图片、B-roll、生成镜头、截图和图解必须用于解释、举证、具体化或连接镜头。每段外部画面逐项核验：

- `object`：对象一致；
- `action`：动作一致；
- `state`：状态一致；
- `role`：人物或主体角色一致；
- `tense`：叙事时态一致。

“有人拿着书”不能替代“把书放进打开的书包”。候选素材代表帧、对应旁白和最终素材首/中/尾帧必须并排检查。

视觉风格以 A-roll 代表帧为基准，至少匹配色温、曝光、对比、饱和度、景深、纹理/锐度、颗粒、边框、阴影和运动速度。语义正确但风格跳脱仍然拒收。

## 插镜动态化

每段插镜先定义 `motionPurpose`：引导视线、解释结构、展示过程、连接镜头或维持节奏。可使用克制推拉、平移、2.5D 视差、分层构建、遮罩揭示、局部高亮和图表生长。

- 运动采用“进入—停留—退出”；
- 长于约 1.5–2 秒的静态素材默认需要轻微而可感知的运动；
- 单张素材连续超过约 8 秒必须有不可替代的阅读或叙事理由；
- 不从头到尾匀速漂移，不拉伸人物、文档和数据；
- 卡片、画中画、文字、蒙版和装饰共享 `visualExit`，切回 A-roll 前完成退场。

## 信息卡、流程图与弹窗

正式实现前先按 `visual-design-preflight.md` 建立展示、动效和声音设计包。
简单模块使用本地样式帧；多状态流程、多画幅组件或品牌级模块可使用 Figma，
但 Figma 不可用时回退本地设计，不得跳过设计。

这三类模块只有两种合法布局：

1. `full_screen`：真正替换 A-roll，覆盖至少 95% 的有效画布。人物不在模块下方若隐若现；内容按口播逐项建立，完整退出后再恢复人物。
2. `subject_safe`：保留人物时，先从代表帧或人脸轨迹取得每个人的
   `subjectHeadBounds`，再给头像四周增加 1%–15% 画幅的安全余量。模块
   `moduleBounds` 不得与任何扩张后的头像安全区相交。

选型原则：

- 节点多、文字多、需要读顺序或比较关系时用全屏；
- 只有 1–3 个短信息且人物表情仍有价值时用人物安全布局；
- 没有足够负空间时，不强塞人物旁侧卡片，直接全屏；
- 模块出现前检查字幕、品牌、来源和平台 UI；优先移动或缩小模块，不能用缩小人物头像来给卡片让路；
- 半透明卡片、弹窗阴影、装饰线和箭头也算模块边界，全部纳入碰撞检查；
- 流程图随口播逐节点生长，不一次把全部内容扔到屏幕上。
- 多状态点亮保持同一底图，只更新当前节点或连线；节点切换禁止整屏淡入淡出、闪白或全图亮度跳变。

剪辑计划必须记录 `layoutMode` 和 `layoutEvidence`。`full_screen` 还要记录
`subjectVisibilityPolicy=replace_a_roll` 与 `fullScreenCoverage`；
`subject_safe` 记录归一化 `moduleBounds`、`subjectHeadBounds` 和
`headSafetyMargin`。代表帧至少覆盖进入后、信息最满时和退出前。

## 真人画中画

只有主素材需要占据主画面，同时人物表情、手势或信任关系仍有价值时才保留画中画。

- 默认 `sourceComposition=full_frame_fit`：先把原始完整画面等比缩小并
  `contain` 到画中画内容框，再套圆形、方形、不规则蒙版、边框与阴影；
  不得先用固定像素矩形裁掉人物头顶、下巴、肩部或关键手势。
- 圆形/方形与源画幅不一致时，使用项目 surface 色填充剩余区域，或在
  `pipContentSpec` 中提供经人物跟踪验证的主体感知裁切；“为了铺满形状”不是
  允许裁头的理由。
- 外部插镜上的真人画中画同样执行完整画面缩小规则，不能另写一套硬裁参数。
- `activeInterval` 必须与主素材真实可见区间一致；
- 主画面恢复 A-roll 后，禁止继续显示同源 A-roll 画中画；
- 进入、停留、退出分别检查；
- 保持原始口型和 PTS，不单独变速；
- 避开字幕、品牌、来源、平台 UI 和关键证据；
- 主素材被人物挡住时，先换角、缩小或短暂隐藏，并记录恢复点；
- 画中画默认使用项目一致的精细边框，不做直播间式粗框或廉价发光框；
- 边框使用 1–2 层，推荐“暖白外层 + 项目强调色内层”或相反组合；每层视觉粗细约为最终画布短边的 0.4%–1.2%，小尺寸画中画不得因缩放变成粗框；
- 圆角必须跟随画中画形状：圆形不再套方形外框，方形/长方形的边框半径与内容裁切半径一致；
- 阴影只用于从背景中分离，默认不透明度 20%–35%，方向、柔化和色相沿用项目视觉系统；
- 边框、阴影和外发光全部计入画中画实际边界，并参与人物头像、字幕、品牌、来源和平台 UI 的碰撞检查；
- 剪辑计划必须提供 `pipBorderSpec`：`shape`、`strokes`、`cornerRadius`、`shadow`、`boundsIncluded`、`stateFrames`、`collisionEvidence` 和 `rationale`；
- 剪辑计划必须提供 `pipContentSpec`：`sourceComposition`、
  `fitMode`、`subjectAnchor`、`headTopMarginRatio`、
  `gestureVisibilityPolicy` 和 `stateFrames`。默认值分别为
  `full_frame_fit`、`contain`、当前主体轨迹中心、至少 `0.04`、保留关键手势，
  以及进入/停稳/退出三态。
- `strokes` 只允许 1–2 层，每层记录颜色及相对画布短边的 `widthRatio`（0.004–0.012）；`stateFrames` 至少检查进入、停稳和退出；
- 若纪实证据、原始界面或特殊视觉系统确实需要无框，必须在 `pipBorderSpec.rationale` 中说明，且用克制阴影或明度分离替代。

## 双屏与多窗格构图

左右或上下双屏不是把源画面机械切成两半。每个窗格都要独立建立
`paneCompositionSpec`：

- `sourceComposition` 默认 `subject_aware_reframe`；
- `subjectAnchor` 来自该窗格真实时间段的人脸/人物轨迹，不复用另一个窗格的
  固定裁切；
- `verticalSubjectPosition` 默认落在窗格高度的 45%–55%，让两个人物视觉上
  向分隔线和画面中心聚拢；
- `headTopMarginRatio` 至少 0.04，普通人像必须保留完整头顶；
- `fitMode` 优先 `contain` 或人物感知裁切；若裁切，必须保留脸、下巴、肩部
  和叙事相关手势；
- 进入、停稳、退出各抽一帧，并以双屏整体预览核对两侧/上下人物的视觉重心，
  不能只检查单个窗格。

计划还必须记录 `paneGap`、分隔线、字幕归属和碰撞证据。任何窗格出现裁头、
人物贴边或上下两屏视觉重心明显错位时，必须重构图，不得靠加边框掩盖。

## 人物美化

美颜默认关闭。明确启用后只使用 `references/beauty-v2.md` 定义的本地
Beauty v2，并且只处理磨皮、美白、匀肤和法令纹弱化。

`natural` 是显式启用后的起始档；`visible` 只有用户明确要求、人物跟踪稳定
且同源同帧 A/B 通过时启用。它们是最终观感档位，不是允许绕过检查的参数档位。

禁止默认瘦脸、大眼、改鼻形、改变族群肤色或删除永久特征。所谓“祛法令纹”只能在稳定正脸中用极轻局部提亮和纹理柔化降低对比，不能承诺语义级删除。

比较美颜时必须：

- 从各自完整后期链路的最终输出提取；
- 使用同源、同帧、同裁切、同显示尺寸；
- 覆盖正脸、转头、说话嘴型、眨眼、眼镜反光和手遮脸；
- 区分局部美颜与全局模糊、重编码柔化或锐化差异；
- 脸、颈部和手臂质感保持连续。

## Vision 蒙版闭环

正式链路：

```bash
scripts/generate_vision_masks.swift SOURCE.mov MASK_DIR SOURCE_FPS accurate
node scripts/build_mask_video.mjs MASK_DIR/manifest.json person MASK_DIR/person.mkv
node scripts/build_mask_video.mjs MASK_DIR/manifest.json face MASK_DIR/face.mkv
node scripts/build_mask_video.mjs MASK_DIR/manifest.json skin MASK_DIR/skin.mkv
node scripts/build_mask_video.mjs \
  MASK_DIR/manifest.json nasolabial MASK_DIR/nasolabial.mkv
scripts/apply_beauty_v2.sh \
  SOURCE.mov MASK_DIR/skin.mkv MASK_DIR/nasolabial.mkv OUTPUT.mov natural \
  --vision-manifest MASK_DIR/manifest.json \
  --config /path/to/beauty-enabled.json \
  --report /path/to/beauty-technical-report.json
scripts/compose_text_behind_person.sh SOURCE.mov MASK_DIR/person.mkv TEXT.mov OUTPUT.mov
```

关键约束：

- 输出蒙版目录必须为空，防止混入旧帧；
- 源素材必须先规范成无旋转、镜像或平移 metadata 的正向中间片；
- 正式蒙版采样率等于源帧率，低帧率只做预检；
- PNG 必须通过 manifest 的真实时间戳组装成无损 FFV1 蒙版视频；
- 蒙版视频、文字层和源视频的时长、帧率、起始 PTS 不匹配时直接失败；
- 禁止末帧无限复制、`-shortest` 静默截短或低帧率预检蒙版进入 4K 正式渲染；
- 逐段检查头发、眼镜、手指、肩部、遮挡、快速运动和边缘帧；
- 皮肤蒙版必须保护眼睛、眉毛、嘴唇和眼镜附近；
- Beauty 只处理持续锁定的主讲人；多人歧义帧必须输出空蒙版并进入 QC；
- 脸、耳和颈部需要连续，手和手臂不进入 Beauty 蒙版；
- 灰度蒙版必须显式覆盖 Y/U/V 三个平面，遮罩外背景色度不得变化；
- 法令纹蒙版只允许覆盖鼻翼至嘴角附近的保守窄区，跟踪不稳时局部禁用；
- 漏抠、误抠、白边、黑边、抖动或跟踪丢失时减弱、局部禁用或回退。

## 2.5D 与分层效果预检

2.5D 只在前景、中景、背景能可靠分离时启用。正式进入时间线前必须生成短预览并检查：

- 每层 alpha 非空且没有反相；
- 源、各层和合成输出 PTS 从 0 开始并严格对齐；
- 首帧、中间帧和尾帧无黑底、透明空洞、拉伸和边缘穿帮；
- 人物与背景运动方向、速度差和景深差克制；
- 进出段有完整 handle，不用失败合成硬接主画面。

任何一项失败，回退为普通推拉、平移或静态信息卡；不在正式成片中试错。

## 人物后置文字

合成结构是“原画背景 → 重点文字/图形 → 人物前景”。只用于章节题眼、关键数字、核心判断和少量记忆点，不能把普通字幕伪装成蒙版特效。

正式制作蒙版和文字层前，必须先冻结 `entry / peak / exit` 三态样式帧、
动效帧数、声音功能和实现交接；不能在渲染时临时挑字体、颜色或音效。

### 设计合同

- `content`：只保留题眼，优先拆成每组 2–7 个汉字的语义短语；
- `fontFamily`：继承项目字幕字体家族或选择气质一致、已经授权的展示字体；
- `fontWeight`：使用 600–800 的 SemiBold/Bold，拒绝廉价的超粗黑体和随意卡通字体；
- `fontSizeRatioToSubtitle`：普通字幕的 1.35–3 倍，在手机尺寸上形成明确层级；
- `positionRationale`：优先人物头顶上方或视线反方向的负空间，不与脸、眼睛、字幕、品牌和平台 UI 争抢；
- `color`：从项目主色/强调色中选一个主色，最多加一个强调色；可见区域对比度至少 4.5:1；
- `visibleAreaRatio`：至少 65% 字形保持可读，人物遮挡只负责制造景深，不能把关键词遮得只剩边角；
- `phraseGrouping`：多短语按口播和逻辑重音分批出现，不整句一起弹出；
- `textBounds/subtitleBounds`：使用归一化坐标记录，二者不得相交；
- `layoutEvidence`：检查人物蒙版、亮底/暗底、手机尺寸、进入、停稳和退出代表帧。

### 动效与声音

- 入场 6–12 帧，使用与文字方向一致的遮罩揭示、轻推或缩放，不使用默认弹跳模板；
- 每组短语之间保留 2–6 帧层次差，最后一组负责视觉落点；
- 停留时间足以读完，退出在下个主要视觉事件前完成；
- 音效按真实功能选 whoosh、tick、tonal hit 或知识点落位声，不能所有文字共用同一个声音；
- `soundDesign` 必须写明 asset ID、title、hash、entry cue、motion match、同步容差和相对人声音量；
- 音效峰值与文字停稳误差不超过 1–2 帧，建议从人声下方约 8 dB 起试听，并根据素材在 -18 至 -3 dB 范围内校准。

计划缺少字体、字号比例、位置理由、颜色、对比度、可见面积或音效同步参数时，不允许进入正式渲染。人物边缘不稳、发丝穿帮或文字位置没有足够负空间时，回退为项目统一的信息卡或普通字幕强调。

## 主体感知重构图

```bash
node scripts/plan_subject_reframe.mjs manifest.json 9:16 reframe.json
node scripts/plan_subject_reframe.mjs manifest.json 9:16 reframe.json \
  --subject-anchor 0.50,0.35
```

脚本会锁定首个主体并按人脸轨迹关联，不再逐帧选择最大人脸。多人且未提供主体锚点、轨迹关联含糊、主体跳变或长时间丢失时，结果必须标记为手工关键帧或安全 fallback。

自动轨迹只作为预览候选。正式渲染仍检查头顶、眼睛、手势、证据物、字幕区、最大移动速度和多人身份。

## 调色、稳定与跟踪

- 先确认色彩空间、gamma、bit depth、range 和 HDR/SDR；
- Log/HDR 不用普通对比滤镜直接拉正常；
- 调色先修曝光、白平衡和肤色，再做跨素材匹配；
- 稳定不能以大幅裁切、背景液化或主体截断为代价；
- 光流、运动模糊和速度变化只用于短段非口型画面；
- 专业平面/3D 跟踪、复杂转描和运动镜头物体移除只有相应引擎真实可用并通过短段预检时启用。
