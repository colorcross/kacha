---
name: kacha
description: |
  “咔嚓”本地专业视频策划、精剪、包装、增量返工与验收 Skill。用于真人口播、字幕、音频、BGM/SFX、插镜、画中画、美颜、FaceFusion、蒙版、信息图、效果模板、生成镜头、封面和完整 QC。先锁定内容与输出合同，再按变化范围渲染和验收；默认本地处理，不上传、不发布。
---

# 咔嚓

先把内容、切点和同步做对，再做视觉包装。首剪使用完整工作流；已有基线的
局部返工使用增量工作流，只重做受影响层，但最终发布仍必须完整验收。

## 默认交互：在 Agent 中聊天

默认由用户在 Codex 或 Claude Code 中用自然语言操作咔嚓，不要求打开生产台、
记命令或手工维护工程对象。Agent 必须在后台使用 operation-level mutation
delta、本地素材索引、异步任务、placeholder、对象级 `@` 引用和安装状态，
只把必要结论、候选和阻塞项返回用户。

小修改不得重写或重新载入整份 timeline/manifest：先用 `refs` 解析对象，
再用 `delta apply` 应用 1–200 个最小 JSON Pointer 操作。需要本机素材时用
`media search` 返回少量带许可证据的 `@asset`；耗时生成、分离、跟踪、渲染
和 QC 用 `jobs submit`，只有 placeholder 为 `ready` 才可接入正式时间线。
macOS 素材搜索优先使用本地 NaturalLanguage 句向量，回退关键词时必须明示；
后台任务取消要确认进程退出，失败产物恢复前先隔离。Timeline IR 会核对
Placeholder 的 ready 状态与产物 SHA；重复对象 ID 必须使用确定性后缀，
不能依赖索引输入顺序。
源码开发态先用 `install status` 检查 Codex/Claude 安装，但通过测试前不得
同步。完整规则见 `references/agent-chat-control-plane.md`。

## V7 默认生产入口

新项目必须先进入可恢复编排器，不再只生成 brief 后把十三阶段留给对话记忆：

```bash
node scripts/kacha.mjs start --source /path/to/source.mov \
  --project-root /path/to/project
node scripts/kacha.mjs status /path/to/project
node scripts/kacha.mjs run /path/to/project --confirm-execute
node scripts/kacha.mjs resume /path/to/project --confirm-execute
```

编排器把十三个专业阶段收束为“方案确认、首剪确认、成片审阅、交付与返工”
四个用户里程碑，冻结源码版本、双端安装摘要、输入身份、V6 证据和唯一下一步。
新建视频项目默认 `intelligenceV6.required=true`；运行时 dirty、Codex/Claude
安装不同步、输入内容变化或版本锁变化时必须停止。`--development` 只用于仓库
测试，不得作为真实生产放行。

没有源视频时可以从脚本或选题开始：

```bash
node scripts/kacha.mjs start --script /path/to/script.md \
  --task content_generation --project-root /path/to/content-project
node scripts/kacha.mjs run /path/to/content-project --confirm-execute
```

它会建立内容主线、待核事实、录制方案、内容素材清单和 source-edit 交接；
事实或素材未解决、内容未人工批准时，`handoff` 不得建立正式视频项目。完整
合同见 `docs/PRODUCTION_ORCHESTRATION_V7.md`。

## V8 质量不降级效率合同

每个视频项目在 `start` 时自动建立 `.kacha/efficiency-plan.json` 和
`.kacha/efficiency-inputs.json`、`.kacha/cache-audit.json`。输入登记独立保存当前
cues/delta 身份和缓存适用种类/预期 key，计划与登记同时损坏时必须补证据或显式
清除，不能静默降级。
Agent 不得只写“先看几个片段”或“可并行处理”，
必须把区间、风险、依赖、资源和证据落成可执行合同：

```bash
node scripts/kacha.mjs efficiency plan PROJECT \
  --cues CURRENT_CUES.json \
  --applicable-cache-kinds asr,mask \
  --expected-cache-keys asr:<sha256>,mask:<sha256>
node scripts/kacha.mjs efficiency validate PROJECT/.kacha/efficiency-plan.json
node scripts/kacha.mjs efficiency schedule
node scripts/kacha.mjs efficiency cache-audit PROJECT \
  --applicable-cache-kinds asr,mask \
  --expected-cache-keys asr:<sha256>,mask:<sha256>
```

首剪代表区间至少覆盖开场、典型信息段、复杂视觉段和结尾；当前 cues 中出现
连接点、密集字幕、事实证据、蒙版/跟踪或音频转折时，必须并入代表区间理由。
没有 cues 时可以用结构位置生成待确认区间，但不得把该 fallback 写成当前画面
证据。增量返工从 version delta 自动生成最多三段区间，必须覆盖全部变化点和
handle；使用最小总覆盖跨度分组，只有最优结果仍过长时才披露预算例外。全局变化
固定生成开场、复杂视觉和结尾三段待确认样本；只有 `no_timeline` 可以零段。
旧 cues/delta 丢失时 fail closed，只有显式 `--clear-cues/--clear-delta` 才能放弃。

十三阶段按 prerequisites、资源和输出组生成波次。真正自动并行只能使用
`efficiency execute` 读取 `kacha-efficiency-execution-plan`：每个任务必须声明
`safeToAutoExecute=true`、脚本 SHA、本地输出、依赖、资源与只在本地执行的授权；
只运行策略登记且具有参数级校验器的确定性 Node 脚本。当前命令输出必须与声明
输出完全一致，执行前后都拒绝越界或符号链接。执行经过主机资源锁和
`metrics run`，共享输出、网络资源、内联命令、未登记脚本、依赖环、未授权任务
或已有输出直接阻断。MPS 与视频编码仍各为单槽，不为了“并行”抢资源。

高成本缓存只有同时具备源/输入 SHA、实现或模型 SHA、操作版本、参数、输出
schema、contract 内容键和当前输出 SHA 才算 ready；缓存路径中的符号链接不构成
证据。阶段计划必须同时声明适用种类和本次任务预期的内容键；只声明种类不能用
任意旧条目计算预热，覆盖率按当前预期 key 计算。`status/observe` 必须按当前输入
重验计划和缓存，不得信任旧报告中的 pass。

```bash
node scripts/kacha.mjs efficiency compare BASELINE-COHORT.json CANDIDATE-COHORT.json
```

“效率提升”必须来自至少 8 个同源成对项目；两套 cohort ID 必须完全一致，源片、
审片输出、指标、人审和六项护栏都要绑定当前文件身份，输出不可复用。基线和候选
都有人审，并且语义、连接、字幕、视觉、声音和完整通看护栏全部通过；否则返回
`insufficient_evidence`。完整合同见
`docs/QUALITY_PRESERVING_EFFICIENCY_V8.md`。

## 先选路径

只选一条主路径：

1. `proposal_review`：只分析或给方案；不改文件。
2. `source_edit`：从原素材完成整支精剪。
3. `content_generation`：从文稿、书籍、笔记或主题生成内容。
4. `local_optimization`：在已批准基线上局部返工。

首剪、结构重排、改时长、改画幅或跨版本重做走 v2 完整流程。已有基线上的
字幕、声音、封面、美颜、调色、插镜或局部效果调整优先走 v3 增量流程。

## 按需读取

主代理必须完整读本文件，并按任务读取以下 reference；不要一次加载全部：

- 首剪/结构重做：先读 `references/project-workflow.md`、
  `references/editing-theory.md`；进入最终 QC/release 阶段再读
  `references/qc-release.md`
- 局部返工：`references/incremental-workflow.md`；涉及最终交付时再读
  `references/qc-release.md`
- 人声/BGM/SFX/同步：`references/audio.md`；本地音效库另读
  `references/sfx-library.md`
- 插镜/PIP/蒙版/人物后文字/调色：`references/visuals-masks.md`
- 美颜：`references/beauty-v2.md`；默认关闭，只在明确启用时读取并执行
- 换脸、口型同步、人脸修复和后期增强：`references/facefusion.md`；
  只生成授权门禁后的候选，不自动执行身份处理
- 信息卡/流程图/弹窗/复杂动效：`references/visual-design-preflight.md`
- 统一风格、开场和转场库：`references/style-effects-library.md`
- 四风格互斥剪辑语法与换皮失败门禁：`docs/FOUR_STYLE_EDITING_GRAMMARS.md`
- 预制效果合同、原创资源、字体、音效和按镜头素材路由：
  `references/effect-templates-resources.md`
- 语义拍、空间变化、贴纸引导、关键帧和并列句网感机制：
  `references/z-en-editing-system.md`
- 画面呼吸、左右/上下/前后口播字幕排版和项目字体路由：
  `references/visual-breathing-caption-typography.md`
- 本地页面选素材、建基础风格、选择四套剪辑视觉语言、指定开场/效果并生成项目配置：
  `references/production-studio.md`
- 字幕/封面/品牌/系列：`references/subtitles-covers-brand.md`
- MiniMax/Seedance/网络素材：`references/generated-media-assets.md`
- 较弱模型/低推理强度/长任务续跑：`references/agent-execution.md`
- Agent 对话、Mutation Delta、本机素材搜索、异步任务、对象引用与双端同步：
  `references/agent-chat-control-plane.md`
- 性能、Token、统一渲染与弱模型稳定生产：
  `docs/PERFORMANCE_TOKEN_STABILITY_V5.md`
- 全片导演、素材缺口、语义审片、偏好学习、编辑评测与 NLE 交换：
  `docs/INTELLIGENT_EDITING_V6.md`
- 可恢复项目、四里程碑、内容优先、素材收件箱与统一审片：
  `docs/PRODUCTION_ORCHESTRATION_V7.md`
- 风险预算、代表区间、依赖波次、强指纹缓存和效率证据：
  `docs/QUALITY_PRESERVING_EFFICIENCY_V8.md`
- Claude Code 视觉补偿/关键帧证据：`references/visual-evidence.md`
- 缓存与清理：`references/cleanup-retention.md`
- 复盘生产缺陷或改门禁：`docs/PRODUCTION_HARDENING.md`

不确定应加载哪些文件时先运行：

```bash
node scripts/route_references.mjs \
  --task local_optimization --modules audio,beauty,covers
```

如果本机存在私有能力 reference，只有任务实际使用该能力时才读取；私有
overlay 缺失或探测失败时必须失败或明确降级，不能悄悄换算法后声称等效。

## 较弱模型的确定性入口

较低能力模型、较低推理强度和 Claude Code 使用确定性入口，不手写复杂状态：

```bash
node scripts/kacha.mjs doctor --profile core
node scripts/kacha.mjs prepare --task local_optimization \
  --modules beauty,audio --agent claude --model-tier economy \
  --project PROJECT.json
node scripts/kacha.mjs next PROJECT.json
node scripts/kacha.mjs compile-change change-request.json
node scripts/kacha.mjs state snapshot PROJECT.json
node scripts/kacha.mjs visual-evidence INPUT.mov \
  --output-dir output/visual-evidence --mode review
```

完整读取 packet 的 `readOrder`，每次只执行一个 `nextAction`。Claude 先读
本地视觉 JSON/Markdown；只有明确允许外传时才用 MiniMax 增强最多 6 张
关键帧。`prepare` 会自动补入弱模型执行协议和 Claude 视觉 reference，并
阻止 reference 超过所选模型档位预算。详细配方、错误码和授权见对应
reference。

弱模型的上下文按 `inventory / content / edit / visual_audio / release`
五种 packet 路由；这只是省 Token 的读取边界，不替代 v2 十三阶段执行状态。
每个 packet 只读一个紧凑合同。完整转写和逐词 JSON 不进入 packet，使用
`transcript index` 与最多 180 秒的 `transcript slice` 按需读取。剪辑与效果
先用 `rules query` 取 1–3 个候选；相同 cues、配置、规则和 seed 必须得到
相同 decision digest。低置信度或规则冲突只能生成局部预览并升级给强模型或
人工，不能直接 final。项目状态、证据和决定写入 `.kacha/project-state.json`，
长任务不得依赖对话历史重建。

对话控制面内部入口：

```bash
node scripts/kacha.mjs delta apply TARGET.json MUTATION.json --write NEXT.json
node scripts/kacha.mjs media search .kacha/media-index.json --query "语义描述"
node scripts/kacha.mjs jobs status @job:ID --project-root PROJECT_DIR
node scripts/kacha.mjs refs resolve @overlay:ID --index .kacha/object-index.json
node scripts/kacha.mjs install status --agent both
```

这些命令默认由 Agent 自动调用；不要把内部命令选择、索引建立或对象标注工作
推给用户。mutation delta 是单次操作证据，v3 version delta 仍负责版本级
失效、渲染和 QC，两者不能混用。

## V6：智能剪辑证据闭环

完整首剪在最终带时间语义 cues 稳定后，先编译全片导演计划与素材缺口，不得
继续只按局部 cue 堆效果：

```bash
node scripts/kacha.mjs intelligence director \
  --cues SEMANTIC_CUES.json --show SHOW --style STYLE \
  --output DIRECTOR_PLAN.json
node scripts/kacha.mjs intelligence assets \
  --director DIRECTOR_PLAN.json --media-index .kacha/media-index.json \
  --output ASSET_GAP_PLAN.json
```

导演计划必须且只能有一个主开场，限制高影响决策与连续强拍，保留最低安静
比例，并把“刻意不用效果”写成正式决定。事实、真实人物、官方数据和产品实拍
缺口不能由生成媒体冒充；素材索引截断或证据未补齐时不得执行。
`generated_visual_candidate` 只是待生产路线，不是已经可用的素材；生成结果必须
先回填本地素材索引，具备当前文件 SHA-256、许可和来源，再重新编译素材缺口计划，
否则 `gate-render` 继续阻断。素材索引本身使用 digest v2 冻结完整文件身份、许可、
来源和语义字段；索引或文件发生变化后，旧搜索结果与旧缺口计划都不能继续执行。

候选版用 Timeline IR 与导演计划建立语义审片包。每个高影响决定显示理由、
置信度、最简回退和正常速度预览，并记录 `accept / adjust / reject`。调整或拒绝
没有当前解决证据时不能进入候选就绪：

```bash
node scripts/kacha.mjs review build \
  --timeline TIMELINE.json --director DIRECTOR_PLAN.json \
  --preview-dir PREVIEW_DIR --output-dir .kacha/review
node scripts/kacha.mjs studio serve
node scripts/kacha.mjs review validate \
  --session .kacha/review/review-session.json --for-candidate
node scripts/kacha.mjs release-review init contracts/project-manifest.json \
  --reviewer REVIEWER
```

每个决策的正常速度预览必须是可解码、有动态视频、有可试听音轨且达到最小代表
时长的真实媒体；只有路径或扩展名不算证据。任一决策缺失时，即使全部点击
`accept`，`readyForCandidate` 仍为 false。项目、栏目、风格和平台 scope 必须由
当前 Timeline 与 director 确定，CLI 不能把审片结果改挂到其他 scope；调整/拒绝的
解决证据也必须通过同一真实媒体门禁。

同一 `/review` 页面还包含十一项发布审片。发布报告绑定当前最终视频 SHA-256；
成片变化会使旧批准失效，未通过项会生成 `pending_agent_compilation` 返工请求。
素材缺口使用 `asset-inbox build/attach/refresh`；提交素材只记录许可、来源与当前
文件身份，必须重新建立 media index 和 asset gap plan 后才能解除 blocker。

长期偏好只从明确审片结果生成候选，同一规则至少两条证据；不保存自由文本备注，
不自动激活，激活和回滚都要求 `--confirm`。激活时必须从当前 source session
重建学习结果；新候选按栏目、风格、平台和项目 scope 合并，不得清空其他 scope
或本轮未再次出现的既有规则。真实质量用 `eval score/compare` 逐项测量；至少
8 个同源人工复核项目只是提升声明的必要条件，还必须关键护栏全部可测且无退化，
并至少有一个主要质量指标改善。禁止用单一综合分掩盖语义、连接、字幕、风格或
人工干预退化。评测的 source 必须是可解码动态视频，reviewed output 必须是带
音轨视频并与申报时长一致；同一源片不能换 group 重复计数，源片错配或候选输出
与基线完全相同都不得支持“版本提升”。偏好激活/回滚使用同一 profile 文件锁，
且只有候选就绪的完整 session 才能学习。

专业 NLE 交换使用 `nle export/import`。真实应用往返另用 `nle-app
detect/session/record/validate` 绑定应用版本、导入/导出报告、应用证据和人工正常
速度复核；本机没有 Final Cut Pro、Premiere 或 Resolve 时必须报告 unavailable，
不能用纯代码 round-trip 冒充真实应用验证。OTIO/FCPXML 保留语义 ID，CMX3600
只做兼容导出；交换文件必须绑定当前基线 Timeline 与源片 SHA，FCPXML 的小数
帧率使用标准有理数时间。任何导入都只生成 preview candidate，不能跨项目套用、
覆盖既有输出或基线；导入 clip ID 必须来自基线，decision/semantic ID 必须保持
一致，空时间线和小于一帧的区间直接失败。项目需完整执行 V6 门禁时，在 manifest 设置
`intelligenceV6.required=true` 并登记 director、asset gap、perception audit 与
semantic review session；v2 首剪和 v3 增量 manifest 使用同一开关，均不得忽略。
门禁还会交叉核对 director、asset plan、Timeline、perception audit 与 review bundle
是否属于同一证据集，单个文件各自有效仍不能跨项目拼装。
完整合同见 `docs/INTELLIGENT_EDITING_V6.md`。

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
在“浅暖轻浮层”“空间光路”“幽默漫画”和“像素风”中，视频标题、术语、金句和大号字只用华光标题黑，封面主标题只用封神榜书，其他文字只用细体；除非缺字或用户显式指定，否则禁止其他字体。漫画字形、像素字形只允许作为图形材质，不得替代可读正文。
四个正式栏目的封面人物统一采用原创的高品质院线级 3D 动画电影语言。用户
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
行者风 2.0 的拍摄基线、语义色、渐变、栏目差异、封面人物比例和人物后文字
合同见 `docs/XINGZHE_STYLE_V2.md`；幽默漫画与像素风的完整母合同分别见
`docs/HUMOR_COMIC_VISUAL_LANGUAGE.md` 和 `docs/PIXEL_EDITORIAL_VISUAL_LANGUAGE.md`。高影响视觉在正式制作前应先从
`design/reference-gallery/xingzhe-v2/index.html` 查看当前设计摘要对应的
参考效果；图库缺失或摘要过期时运行 `design gallery` 重新生成，不能只凭
效果名称和文字描述猜实现。

静态参考图只约束峰值构图，不能替代时间行为。可复用高影响效果必须通过
`templates resolve` 取得 `motionContract`，并执行其中的 invariants、
parameters、adaptationRules、timing、audioContract 和 qualityGates。
模板允许按人物位置、画幅、语速、字幕区和信息密度调参，但不得破坏人物安全、
逐项建立、局部更新、音画峰值和提前退场等硬约束。流程内容可在
`effect-process_spatial_nodes`（空间光路）、
`effect-process_light_overlay`（浅暖轻浮层）、
`xingzhe-humor-comic`（幽默漫画）与
`xingzhe-pixel-editorial`（像素风）之间按气质选择；不得把大面积
不透明白卡或整屏仪表盘伪装成“视频动效”。所有文字、卡片和常驻品牌模块在渲染前必须输入人物/头部边界、字幕安全区、平台 UI、局部亮度图和真实文字度量；先调颜色与位置，再缩小或分时展示，不能遮头或在低对比背景上硬放。
“空间光路”必须保留同一张原实拍底图，以局部径向景深场、深中性玻璃节点、蓝/橙红曲线光路和少量粒子建立空间，禁止矩形黑块、全屏暗罩和节点同时弹出。

“幽默漫画”只在真实反差、误会、预期落差、尺度错位、反应或回扣成立时使用；保留实拍人物和事实证据，只以局部墨线、分格、网点、反应特写或短气泡增强节拍，禁止笑声罐头、表情包墙和持续抖动。“像素风”只像素化图形层，不降低人物、证据和文字清晰度；在 1080p 以 6–12 px 基础网格、最多 8 个强调色和每步 2–4 帧的量化运动建立秩序，禁止全屏低清、持续故障闪烁和无叙事的游戏 HUD。

全部 240 个注册效果均提供上述四套风格的横竖峰值帧和可执行合同。正式计划
必须通过 `contracts resolve --id <effect-id> --style <style-id>` 取得对应
合同，把其时序、调参范围、人物/字幕适配、音频、回退和质量门禁写入时间线；
不能把参考图当作静态插图，也不能仅复制参考图的固定坐标。每次选择还必须记录
`matchedSignal`、`semanticBeatId` 和 `sourceRange`；未应用时记录
`fallbackReasonWhenNotApplied`，禁止只凭“科技”“轻松”等笼统题材套风格。
图库交付前必须运行 `design library-qc --light <浅暖目录> --spatial <空间目录>
--comic <漫画目录> --pixel <像素目录> --contracts <合同注册表> --output <报告>`，同时检查 1920 张图片的唯一性、人物头部碰撞、金陵体
像素证据、字幕阴影、文字对比度、空间黑块、漫画/像素材质边界和 960 份独立动效核心。

完整首剪与结构重做必须先生成 `plans.visualCapabilityPlan`。默认行者风按
当前栏目对应的 `showProfiles` 计算可感知配额；工具分享、解读好书、有限的
无限游戏和灰常AI不得使用同一套强制密度。要求开场、可感知转场、项目/外部/
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
单行为默认，只在对照、层级或空间关系明确时升级为左右、上下或前后景布局。
项目字体通过本地注册表按角色、字符覆盖和授权状态解析，不把字体文件写进
公开 skill。完整命令、路由和 QC 见
`references/visual-breathing-caption-typography.md`。正式项目把计划分别登记
在 `plans.visualBreathingTimelines` 和 `plans.captionTimelines`，
`gate-plan` 会验证计划。

## 不可降低的合同

- 源素材只读；新版本独立输出，不覆盖基线。
- 用户未明确要求时，视频保持源像素尺寸、宽高比、有效帧率和色彩合同。
- 半句话、数字、专名、否定、条件、因果和结论不得被切断或改义。
- 画面、dialogue、BGM、SFX、字幕共用同一组帧边界和 PTS。
- 切镜必须由信息、情绪或视角变化驱动；同一主体相邻镜头形成可感知景别
  变化，普通人物镜头不得切掉头顶。
- 转场、字幕强调、SFX、插镜、PIP、蒙版和人物后文字都必须有触发理由、
  最简替代、失败条件与 QC 证据；不能用特效掩盖错误切点。
- 计划中写了转场不等于执行了转场。最终 Timeline IR 必须为每个真实边界
  编译 `transitions`，画面执行对应 overlap/xfade，源人声或 dialogue
  预处理时间线执行等长 crossfade；render manifest 的
  `execution.transitions.executedCount` 必须与计划执行数一致。
- 画面运动遵守“收紧—停稳—释放”：推近、拉远、横移和冲击必须有语义或
  空间理由；全片持续运动、连续同向缩放、无重音音效和裁头都不允许。
- 普通口播字幕不加音效；左右/上下/前后排版只表达真实对照、层级或空间
  关系，同一时刻最多三个阅读区和一个主重音，人物后文字必须有逐帧蒙版。
- 字体按场景角色、字符覆盖、真实文件 hash 和授权状态解析；缺字、路径变化
  或授权缺失时阻断，不静默 fallback，不把本地字体二进制提交到公开仓库。
- 语义动效以短语义拍为单位：入场可在重读词前 4–10 帧启动，但在触发词前
  不得提前形成可读结论；可见落位与声音峰值必须在重音帧 `±1` 帧内，并在
  下一事件或切回主画面前完整退出。不得把动画起始帧当成 SFX 落点，也不得
  按固定秒数随机套“网感”效果。
- 正式语义动效只从已验证 timeline plan 渲染；展示模式标签、固定示例文案
  和 showcase 音轨不得进入成片。
- 信息卡/流程图/弹窗要么全屏，要么避开人物头脸与字幕安全区；高影响模块
  先做样式帧、进入/停稳/退出和声音设计。
- 真人画中画默认把原始完整画面按比例缩小后再套形状和边框，不得先用固定
  矩形硬裁人物；双屏的每个窗格必须按人物锚点居中并保留完整头顶。
- 画中画若承担“细节视角”可裁手部、物件、界面或证据，但必须与主画面形成
  明确的信息差，记录裁切对象与语义理由，并配置统一边框/阴影和进入退出。
  把同一 A-roll 原样缩小后叠在自己身上、或主画面与 PIP 同时展示同一信息，
  视为错误；优先改为虚拟机位变化、局部特写或真实证据卡。
- 插镜同时匹配对象、动作、角色、状态、时态、方向和全片风格。
- 含口播且需要音频处理时，先做人声/非人声分离；只有验收通过的 dialogue
  stem 可进入降噪、美化和混音，residual 不回混。
- 匹配已认可的人声参考时，必须同时比较同响度听感、LRA/峰均动态、频谱、
  声像和语气强弱；只对齐 LUFS 不算完成。知识口播默认采用
  `references/audio.md` 的“自然口播参考基准”和 `warm-soft` 长听感预设。
- SFX 按功能建立调色板并与事件逐一映射；禁止整片反复套一个声音。
- 新增本地音效必须先转为 48 kHz 双声道工作副本，冻结源/工作副本 SHA、
  许可与分发边界，并为每个资产写精确 `use_when / placement /
  do_not_use_when`；重复文件只建 alias。来源未记录的项目音效永不进入公开包。
- 用户要求 BGM 时，最终混音必须保留闪避后的 dialogue/BGM/SFX 组件 stem
  和最终 mix stem，并在项目 manifest 声明 `outputs.audioStems` 与
  `expectedMedia.audioMix.bgmRequired=true`。最终 `qc` 直接测量 BGM 相对
  dialogue 的响度差和时长覆盖，重建组件混音，并把最终视频解码音频与 mix
  stem 做残差信噪比比对；只检查音乐文件存在、轨道已连接或母带总响度不算
  完成。默认 12–18 dB，超过上限或成片漏混都直接阻断。
- 增量音频返工创建 manifest 时传入 `--dialogue-stem`、`--bgm-stem` 与
  `--mix-stem`（有 SFX 时再传 `--sfx-stem`），沿用相同 BGM 可感知和成片
  漏混门禁，不能把局部返工当成例外。
- 美颜默认关闭。明确启用时只使用本地 Beauty v2，并且只做磨皮、美白、匀肤
  和法令纹弱化；不得回退 GPUPixel、生成式人脸修复或云端美颜。
- Beauty v2 渲染必须由当前项目配置显式 `enabled=true`，携带逐帧 Vision
  manifest，并通过主脸跟踪、媒体保真、同帧 A/B 和人工动态复核；仅指定
  profile 不构成启用授权。QC 报告必须冻结配置与完整实现链 digest。
- FaceFusion 默认不执行。换脸、口型同步、人脸修复或后期增强必须绑定冻结
  输入哈希、逐项目人物/素材/声音授权、模型许可和单独输出；API 只允许本机
  loopback，token 不进日志。自动媒体检查通过后仍是候选，必须正常速度逐镜
  复核身份、边缘、遮挡、口型、时序稳定与纹理，未复核不得发布。
- 高影响视觉模块使用 `design render` 生成真实样式帧与实施清单；预检必须
  校验文件 hash、当前 design digest、实现 digest、组件、字体与 token
  路径。发布前运行 `design qc --matrix` 覆盖全部 mode 取值和组件/场景状态。
- 检测到系列时，视频和封面使用同一系列标识、层级和安全区。
- 工具分享、解读好书、有限的无限游戏和灰常AI都必须执行同一院线级 3D
  大灰身份合同，但分别使用任务推进、沉静思考、真实运动重量和人机冲突的
  表演/灯光语言；同批不得复用同一姿势或用具体动画角色套型区分栏目。
- 自动技术 QC、当前版本人工审片和对应门禁全部通过前，不能称为可发布成片。
- 正式视觉时间线必须编译为统一 Timeline IR/Render Graph，从最高质量源最多
  一次完整视频编码；局部探索只渲染独立代理/区间。相同 graph 与输出哈希
  命中时编码数为 0，禁止用低清代理放大成正式版本。graph 必须冻结 source、
  合同、overlay、字幕、dialogue、BGM、SFX 和字体目录的真实内容身份；同一路径
  文件原地替换后必须失效，不能按路径误复用。
- 首剪试错只看当前证据选择的开场、典型信息、复杂视觉和结尾代表区间；增量
  最多三段且覆盖全部变化。代表区间批准后才允许一次整片代理，最终候选仍须
  完整正常速度通看；不得用局部通过替代完整验收。
- 只有依赖、资源、输出组和本地执行授权都明确的任务可以进入 V8 并行波次；
  自动执行必须同时经过主机资源锁和遥测，不直接并发调用重型工具。
- Demucs、ASR、蒙版、跟踪、Beauty、样式帧和生成素材必须使用源 SHA、实现
  SHA、参数和输出 schema 构成的内容指纹缓存；缓存命中仍校验产物 SHA。
  Demucs 和 ASR 还必须冻结真实模型权重/目录内容 SHA、运行时版本与服务实现
  SHA；替换权重、升级服务或无法取得强指纹时不得命中旧 stem/转写。
  付费生成命中时不得再次调用，容量不足时停止而不是静默清理高价值资产。
- 所有真实执行阶段用 `metrics run` 记录墙钟时间、Token、缓存、渲染范围、
  视频编码数和产物；优先从子进程 JSON 的 usage 字段自动采集 Token，无真实
  usage 时必须标记 estimated/unavailable，不能把估算伪装成实测。完整日志写
  文件并脱敏，不把大日志返回给模型。
- 重型 MPS 和视频编码在同一台主机上默认各只运行一个，多个项目也共享锁池。
  资源不足时等待/阻断，不能并发抢占导致换页、掉帧或静默 fallback。
- 上传、发布、付费生成、购买授权与不可逆删除必须在明确授权内。

## v2：首剪与结构重做

先建立真实 `editProposal`，至少锁定：

- 输入路径、媒体规格、哈希、只读状态和授权；
- 平台、受众、语言、时长、输出几何、格式、系列身份和交付物；
- 内容骨架、保留/删除/重排、切镜与连接策略；
- dialogue、字幕、视觉、BGM/SFX、封面、生成媒体、fallback 和 QC。

使用：

```bash
node scripts/kacha.mjs gate-plan project-manifest.json
scripts/capability_probe.sh --profile core --output capabilities.json
node scripts/kacha.mjs gate-render project-manifest.json
node scripts/kacha.mjs render project-manifest.json
```

十三阶段为：`inventory → transcript_structure → rough_cut →
dialogue_preprocess → connection_qc → fine_cut → visual_packaging →
subtitles → final_mix → cover → preview_render → final_qc →
release_package`。前一阶段没有证据，不得把后一阶段写成完成。
阶段完成证据必须是当前真实文件的 `{path, sha256}`；`next` 与
`.kacha/project-state.json` 共用这套状态机。proposal/edit plan/timeline、
能力合同或媒体合同变化时重置失效阶段；仅回填成片 SHA 不得误清空进度。

方案模板见 `examples/edit-proposal.json`、`examples/edit-plan.json` 和
`examples/project-manifest.json`。具体合同以 `references/project-workflow.md`
为准。

完整项目必须把 `plans.timeline` 登记为唯一时间线事实源。预览显式使用独立
输出，可加 `--range-start/--range-end`；正式 `render` 先通过
`gate-render`，再在一个 filter graph 中完成 EDL、画面、字幕和混音。纯音频
与封面返工继续走 v3 零视频编码路径。

## v3：增量返工

第一次进入增量模式时初始化稳定 context 和 artifact index：

```bash
node scripts/init_incremental_project.mjs BASE.mov \
  --project-id PROJECT --output-dir PROJECT_DIR
```

每轮反馈只创建一个 `version-delta.json`，记录版本意图、变化类型、变化层、
区间、验收条件和输出；冻结层由脚本推导，不复制整套旧方案：

```bash
node scripts/create_version_delta.mjs PROJECT_DIR/project-context.json \
  --write PROJECT_DIR/v2-delta.json --new-version v2 \
  --type beauty_adjust --output-video PROJECT_DIR/v2.mov

node scripts/create_incremental_manifest.mjs \
  PROJECT_DIR/project-context.json PROJECT_DIR/v2-delta.json \
  PROJECT_DIR/artifact-index.json --output PROJECT_DIR/v2-project.json

node scripts/kacha.mjs gate-plan PROJECT_DIR/v2-project.json
node scripts/kacha.mjs gate-render PROJECT_DIR/v2-project.json
```

影响级别由脚本推导，只能升级不能手工降级：

- `L0`：元数据/容器；
- `L1`：单层变化；
- `L2`：局部多层、切点或连接变化；
- `L3`：结构、顺序、时长或几何变化。

缓存复用必须同时匹配 artifact ID、内容指纹和依赖；显式复用请求不能绕过
本轮失效规则。`preview` 只用于样例，`candidate` 用于返工验收，
`release_candidate` 才能进入最终发布门禁。

返工禁止边试边整片导出。L0–L2 只允许 1–3 个代表区间探索，代表样例批准并
冻结 EDL/style/capability/audio digest 后，每个版本最多一次整片代理、一次
正式视频编码和一次完整 QC；完整 QC 只在 `release_candidate` 执行。同一
Render Graph 必须零编码复用，L0–L2 手工请求 `full_rebuild` 直接阻断。
所有返工渲染必须通过 `metrics run --workflow incremental --version-id ...`
记录 `render-scope`/`qc-scope` 并在执行前消费预算。

## 最小实现与验证闭环

1. 先做最小代表性预览：样式帧、1–2 秒跟踪片段、含 handle 的连接点或
   同源同响度音频 A/B。
2. 用户反馈参数冻结后再渲染受影响层；冻结层优先 stream-copy 或复用已验证
   artifact，禁止无意义重编码。
3. 完整候选视频始终检查存在性、哈希、完整解码、几何、FPS、时长和
   A/V 漂移。
4. 只改画面时比较基线与候选的音频 elementary-stream SHA-256；只改音频
   时比较视频流 SHA-256。哈希不一致就重新检查，不能继承旧结论。
5. 变化层执行专项探测和人工检查；L2 检查全部连接点及前后 handle；
   L3 执行完整重建与完整 QC。

```bash
node scripts/kacha.mjs qc PROJECT_DIR/v2-project.json
node scripts/create_incremental_review.mjs PROJECT_DIR/v2-project.json
node scripts/kacha.mjs gate-candidate PROJECT_DIR/v2-project.json
```

最终版本必须把 intent 设为 `release_candidate`，完成十一项当前版本人工证据：

```bash
node scripts/kacha.mjs gate-release PROJECT_DIR/final-project.json
```

自动报告中的 `pass_with_review` 不是全片通过；预览、候选、已渲染、自动 QC、
本地完整 QC、已上传和已发布必须分别表述。

## 缓存、指标与清理

高价值返工资产（校准字幕、dialogue stem、蒙版/跟踪、设计预检、付费生成）
进入 `artifact-index.json`。每轮可写运行指标：

```bash
node scripts/write_run_metrics.mjs PROJECT_DIR/v2-project.json \
  --output PROJECT_DIR/output/run-metrics.json
```

清理只先生成 dry-run：

```bash
node scripts/generate_cleanup_plan.mjs \
  PROJECT_DIR/project-context.json PROJECT_DIR/artifact-index.json \
  --output PROJECT_DIR/cleanup-plan.json
node scripts/cleanup_project.mjs PROJECT_DIR/cleanup-plan.json
```

例行清理只允许处理“用户不需要、当前无引用、已验证可快速重建”的产物。
最终清理还要用户明确确认项目完成且不再修改。源素材、基线/最终成片、工程、
方案、许可、QC/release 证据和批准 stem 始终保护。

## 分层回归

开发或修改 Skill 时先跑受影响套件，再跑全量：

```bash
node tests/run_tests.mjs --suite incremental
node tests/run_tests.mjs --suite audio
node tests/run_tests.mjs --suite visual
node tests/run_tests.mjs --match "V8 "
node tests/run_tests.mjs
```

可用套件见 `node tests/run_tests.mjs --list`；也可用 `--match 关键词`。
公开 core 与机器专属 overlay 必须分别测试，组合通过后再原子同步到 Codex
和 Claude，不能直接覆盖当前可用安装。
