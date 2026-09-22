> 政策版本说明：narrative-v1 的需求分层与已实现手法以 `references/optimization-execution.md` 为准；下文通用数量下限仅适用于 legacy 工程。

# visual-execution

本文件中的 scripts/、references/、docs/、config/ 均相对咔嚓根目录。按当前任务读取；新旧政策由项目合同决定。

## 统一配置与默认剪辑要求

运行参数、用户偏好和密钥使用分层配置，不再散落在命令或文档中：

```bash
node scripts/kacha.mjs config validate
node scripts/kacha.mjs config show --anchor PROJECT_DIR
node scripts/kacha.mjs config init --scope user
node scripts/kacha.mjs design validate
node scripts/kacha.mjs design list --kind scene
node scripts/kacha.mjs contracts validate
node scripts/kacha.mjs effects validate
node scripts/kacha.mjs effects list --kind transition
node scripts/kacha.mjs netstyle validate
node scripts/kacha.mjs netstyle list
node scripts/kacha.mjs fonts validate --registry LOCAL_AUTHORIZED_FONTS.json
node scripts/kacha.mjs breathing validate --plan BREATHING_PLAN.json
node scripts/kacha.mjs captions validate --plan CAPTION_PLAN.json
node scripts/kacha.mjs visual-capabilities validate --plan VISUAL_CAPABILITY_PLAN.json
node scripts/kacha.mjs production-quality validate \
  --contract PRODUCTION_QUALITY.json --stage plan
node scripts/kacha.mjs studio validate
node scripts/kacha.mjs studio serve
```

优先级为：内置默认值 < 用户配置 < 项目 `kacha.config.json` <
本机 `kacha.local.json` < `--config` < 命令行。`editingDefaults` 同时支持
结构化 `parameters`、自然语言 `instructions` 和增量配方
`recipeParameters`；`prepare` 与 `compile-change` 会把适用要求编入当前合同。

密钥单独放在权限为 `0600` 的 `~/.config/kacha/secrets.json`，也可继续使用
环境变量和 mmx 自身凭证库。密钥值不得进入 agent packet、QC、缓存、日志或
Git。默认要求只表示偏好，不构成上传、付费、发布、覆盖源文件或跳过门禁的
授权。自动发现的项目配置不得设置 provider、凭证入口或本机工具路径；这些
敏感项只接受用户配置或显式 `--config`。完整说明见
`docs/CONFIGURATION.md`。

视觉必须从 `style.system + style.profile + style.modes + style.overrides`
解析，默认使用 `dahui-video-system` 与 `xingzhe`（行者风）。行者风的
默认口播字幕必须从本地授权注册表解析真正的金陵体，无底色、无描边、阴影 60%，不得静默换回替代字体。
字体查找顺序为显式/用户注册表、项目授权注册表、项目字体目录，最后才是咔嚓
本地私有字体目录；命中私有目录时必须按当前安装位置重定位并复核文件哈希，
不能继承开发机绝对路径。
在“浅暖轻浮层”“空间光路”“幽默漫画”“像素风”和“暗黑科技风”中，视频标题、术语、金句和大号字只用华光标题黑，封面主标题只用封神榜书，其他文字只用细体；除非缺字或用户显式指定，否则禁止其他字体。漫画字形、像素字形只允许作为图形材质，不得替代可读正文。
五个正式栏目的封面人物统一采用原创的高品质院线级 3D 动画电影语言。用户
口语中的“皮克斯风格”只解析为温暖、圆润但不幼龄化、可按叙事夸张、精细
材质与电影级灯光；不得复制或近似 Pixar、Disney 或其他具体角色、影片造型、
Logo 与 IP。必须保留大灰本人可识别的成年脸型、黑框矩形眼镜、短刺黑发和
深藏蓝运动服。3D 只升级人物，不替代封面的高密度语义编辑拼贴、前中后景、
遮挡、尺度反差和印刷质感；普通单人物 3D 动画海报不得进入正式交付。
设计系统包含基础
令牌、栏目/画幅/语言/明暗/密度模式、组件库和场景库。字幕、弹窗、信息卡、
画中画、品牌、封面、开场和转场只读取解析后的设计合同与 digest，不在时间
区间实现中写死字体、颜色、圆角、阴影、边框或缓动。更换模式或风格走
`style` 增量配方并按依赖失效重建。
系统规范、组件与场景选择见 `docs/VIDEO_DESIGN_SYSTEM_V1.md`。
行者风 3.0 的电影化画面选择顺序、栏目占比预算、反网页禁用模式和镜头事件
合同见 `docs/XINGZHE_STYLE_V3.md`；幽默漫画与像素风的完整母合同分别见
`docs/HUMOR_COMIC_VISUAL_LANGUAGE.md` 和 `docs/PIXEL_EDITORIAL_VISUAL_LANGUAGE.md`。高影响视觉在正式制作前应先从
`design/reference-gallery/xingzhe-v3/index.html` 查看当前设计摘要对应的
参考效果；图库缺失或摘要过期时运行 `design gallery` 重新生成，不能只凭
效果名称和文字描述猜实现。
高频场景还必须运行 `design motion-preview` 生成正常速度短片，检查进入、
停稳、清场和阅读时间；该预览只是设计系统代表证据，不得代替当期成片的正常速度人工审片。

静态参考图只约束峰值构图，不能替代时间行为。可复用高影响效果必须通过
`templates resolve` 取得 `motionContract`，并执行其中的 invariants、
parameters、adaptationRules、timing、audioContract 和 qualityGates。
模板允许按人物位置、画幅、语速、字幕区和信息密度调参，但不得破坏人物安全、
逐项建立、局部更新、音画峰值和提前退场等硬约束。流程内容可在
`effect-process_spatial_nodes`（空间光路）、
`effect-process_light_overlay`（浅暖轻浮层）、
`xingzhe-humor-comic`（幽默漫画）与
`xingzhe-pixel-editorial`（像素风）、
`xingzhe-dark-tech`（暗黑科技风）之间按真实触发选择；不得把大面积
不透明白卡或整屏仪表盘伪装成“视频动效”。所有文字、卡片和常驻品牌模块在渲染前必须输入人物/头部边界、字幕安全区、平台 UI、局部亮度图和真实文字度量；先调颜色与位置，再缩小或分时展示，不能遮头或在低对比背景上硬放。
“空间光路”必须保留同一张原实拍底图，以局部径向景深场、深中性玻璃节点、蓝/橙红曲线光路和少量粒子建立空间，禁止矩形黑块、全屏暗罩和节点同时弹出。

“幽默漫画”只在真实反差、误会、预期落差、尺度错位、反应或回扣成立时使用；保留实拍人物和事实证据，只以局部墨线、分格、网点、反应特写或短气泡增强节拍，禁止笑声罐头、表情包墙和持续抖动。“像素风”只像素化图形层，不降低人物、证据和文字清晰度；在 1080p 以 6–12 px 基础网格、最多 8 个强调色和每步 2–4 帧的量化运动建立秩序，禁止全屏低清、持续故障闪烁和无叙事的游戏 HUD。

“暗黑科技风”只在异常、风险、冲突证据、隐性机制、真伪核验或系统边界成立时使用；先保持正常曝光，再用局部观察孔锁定证据并落一次裁决。暗场覆盖不超过 42%，人物亮度至少保留 82%，证据至少保留 90%；禁止整屏黑化、通用赛博 HUD、霓虹网格、数据雨、连续扫描与随机 glitch。

全部 240 个注册效果均提供上述五套风格的横竖峰值帧和可执行合同。正式计划
必须通过 `contracts resolve --id <effect-id> --style <style-id>` 取得对应
合同，把其时序、调参范围、人物/字幕适配、音频、回退和质量门禁写入时间线；
不能把参考图当作静态插图，也不能仅复制参考图的固定坐标。每次选择还必须记录
`matchedSignal`、`semanticBeatId` 和 `sourceRange`；未应用时记录
`fallbackReasonWhenNotApplied`，禁止只凭“科技”“轻松”等笼统题材套风格。
图库交付前必须运行 `design library-qc --light <浅暖目录> --spatial <空间目录>
--comic <漫画目录> --pixel <像素目录> --dark <暗黑目录> --contracts <合同注册表> --output <报告>`，同时检查 2400 张图片的唯一性、人物头部碰撞、金陵体
像素证据、字幕阴影、文字对比度、空间黑块、漫画/像素/暗黑材质边界、旧版与孤儿产物，
并逐字段核对 1200 份独立合同、manifest 内嵌合同和对应高保真图的执行计划。

完整首剪与结构重做必须先生成 `plans.visualCapabilityPlan`。默认行者风按
当前栏目对应的 `showProfiles` 计算可感知配额；工具分享、解读好书、有限的
无限游戏、灰常AI和闲聊不得使用同一套强制密度。要求开场、可感知转场、项目/外部/
AI/HyperFrames
支撑素材、PIP、蒙版纵深、语义动效、视线引导、空间层次、关键帧、并列排版、
关系字幕、超大背景词、人物前后景文字和呼吸运镜形成足够覆盖与变化。配额不是
随机堆效果：每项仍需真实语义触发；但素材或蒙版缺失不能静默变成零使用，
必须建立资源任务或明确阻断。`gate-plan` 检查覆盖，`gate-render` 检查素材
SHA、蒙版 ready 状态和 Timeline IR 绑定。完整合同见
`references/capability-coverage-and-rework-budget.md`。

每条视频无论长短都必须且只能选择一个主开场动画。可从核心开场库或
`z-en-netstyle` 的五种开场机制中选择；确有更合适方案时允许自定义，但必须
提交完整动效合同，写清触发、叙事功能、机制、进入/峰值/停稳/退出、最简替代、
失败条件、回退、声音功能和 QC。开场从首个有效声音或动作开始建立可见变化，
最迟 3 秒兑现问题、冲突、收益或主题。`visualCapabilityPlan` 对短于 45 秒的
视频也强制检查这一项，并要求正常速度动态预览和代表帧，不能用静态效果图
替代动效验收。生产规则见 `config/effects/production-motion-policy.json`。

常用画面处理按语义而不是按固定时间路由：重点放大、负面缩小、突出用蒙版、
多观点用抠像、事实加可核验插图、移动用关键帧、创意用有共同结构的变形。
空间变化优先使用蒙版视线轨迹、背景与人物间插框、文字纵深或人物抠像演示
舞台。任何选择仍须满足同时最多一个主效果、语义峰值对齐、完整退出、安全区、
音效绑定可见落位、干净方案回退，以及效果图、动作、声音、语音和画面意图统一。

口播需要更强的语义动效、空间变化、贴纸引导、关键帧或并列句排版时，先从
`z-en-netstyle` 注册表选择机制。注册表中的 33 个手法只保存触发、功能、
运动关系、声音功能、失败模式和 QC；真实颜色、字体、边框与安全区仍由当前
设计系统解析。正式项目在画面锁定后、字幕和最终混音前，把最终带时间文稿
编译成可审计时间线，再渲染到完整视频：

```bash
node scripts/kacha.mjs netstyle plan \
  --input PICTURE_LOCK.mov \
  --transcript FINAL_TIMED_TRANSCRIPT.json \
  --output NETSTYLE_PLAN.json \
  [--mask PERSON_MASK.mkv]
node scripts/kacha.mjs netstyle validate-plan --plan NETSTYLE_PLAN.json
node scripts/kacha.mjs netstyle render-plan \
  --plan NETSTYLE_PLAN.json \
  --output VISUAL_PACKAGED.mov
```

带时间文稿可用 `effectId` 明确调用全部 33 个机制，也可让确定性规则按开场、
否定、并列、证据、观点、结论和聚焦等语义自动选择。正式计划必须冻结源片、
文稿、人物蒙版、外部素材、设计系统和效果注册表摘要；每个事件写明触发、
功能、机制、进入/峰值/退出、最简替代、失败条件、音效和 QC。人物分层效果
没有逐帧蒙版、证据卡没有真实素材时直接阻断；同一时刻最多一个主效果。
正式渲染不显示演示标签，保留源尺寸、有效帧率、时长和人声，并输出 manifest。
项目把计划登记在 `plans.netstyleTimelines`，`gate-plan` 会验证计划。

具体效果不手写散落参数。先把已注册效果解析为当前行者风、资源、字体、
音效、安全区和回退都完整的执行合同：

```bash
node scripts/kacha.mjs templates validate
node scripts/kacha.mjs templates resolve \
  --template effect-semantic_evidence_insert \
  --output EFFECT_PLAN.json
```

资源解析优先项目真实证据和官方素材，再按单镜头取得许可明确的网络素材；
不存在语义准确的照片或视频时使用信息卡或不用插镜，不用泛化库存凑画面。

`netstyle preview` 只用于单项代表样例；需要回归机制实现时才使用
`netstyle showcase`。showcase 不能替代正式时间线方案。

picture lock 后先编译画面呼吸，再编译口播字幕排版；两者共享同一份最终带
时间文稿和帧边界。画面呼吸只在语义、情绪或真实空间变化成立时使用，默认
运动覆盖不超过 55%、静止不少于 45%，缓慢推拉和横移不配音效。字幕以普通
单行为默认，只在对照、层级、定义、引语或空间关系明确时升级为语义字景或
前后景空间字景；正式交付使用 `captions validate --strict-text-scenes` 阻断
字景过密。歌词或精确节奏口播只有在逐字时间存在时才能使用 `micro_rail`，
正文不得整行卡拉 OK 变色。
项目字体通过本地注册表按角色、字符覆盖和授权状态解析，不把字体文件写进
公开 skill。完整命令、路由和 QC 见
`references/visual-breathing-caption-typography.md` 和
`docs/CINEMATIC_TEXT_SCENES_V1.md`。正式项目把计划分别登记
在 `plans.visualBreathingTimelines` 和 `plans.captionTimelines`，
`gate-plan` 会验证计划。
