---
name: kacha
description: |
  “咔嚓”本地专业视频策划、精剪、包装、增量返工与验收 Skill。用于真人口播、字幕、音频、BGM/SFX、插镜、画中画、美颜、蒙版、信息图、生成镜头、封面和完整 QC。先锁定内容与输出合同，再按变化范围渲染和验收；默认本地处理，不上传、不发布。
---

# 咔嚓

先把内容、切点和同步做对，再做视觉包装。首剪使用完整工作流；已有基线的
局部返工使用增量工作流，只重做受影响层，但最终发布仍必须完整验收。

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
- 信息卡/流程图/弹窗/复杂动效：`references/visual-design-preflight.md`
- 统一风格、开场和转场库：`references/style-effects-library.md`
- 语义拍、空间变化、贴纸引导、关键帧和并列句网感机制：
  `references/z-en-editing-system.md`
- 画面呼吸、左右/上下/前后口播字幕排版和项目字体路由：
  `references/visual-breathing-caption-typography.md`
- 本地页面选素材、建风格、指定开场/效果并生成项目配置：
  `references/production-studio.md`
- 字幕/封面/品牌/系列：`references/subtitles-covers-brand.md`
- MiniMax/Seedance/网络素材：`references/generated-media-assets.md`
- 较弱模型/低推理强度/长任务续跑：`references/agent-execution.md`
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
node scripts/kacha.mjs visual-evidence INPUT.mov \
  --output-dir output/visual-evidence --mode review
```

完整读取 packet 的 `readOrder`，每次只执行一个 `nextAction`。Claude 先读
本地视觉 JSON/Markdown；只有明确允许外传时才用 MiniMax 增强最多 6 张
关键帧。`prepare` 会自动补入弱模型执行协议和 Claude 视觉 reference，并
阻止 reference 超过所选模型档位预算。详细配方、错误码和授权见对应
reference。

## 统一配置与默认剪辑要求

运行参数、用户偏好和密钥使用分层配置，不再散落在命令或文档中：

```bash
node scripts/kacha.mjs config validate
node scripts/kacha.mjs config show --anchor PROJECT_DIR
node scripts/kacha.mjs config init --scope user
node scripts/kacha.mjs design validate
node scripts/kacha.mjs design list --kind scene
node scripts/kacha.mjs effects validate
node scripts/kacha.mjs effects list --kind transition
node scripts/kacha.mjs netstyle validate
node scripts/kacha.mjs netstyle list
node scripts/kacha.mjs fonts validate --registry LOCAL_AUTHORIZED_FONTS.json
node scripts/kacha.mjs breathing validate --plan BREATHING_PLAN.json
node scripts/kacha.mjs captions validate --plan CAPTION_PLAN.json
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
默认口播字幕必须从本地授权注册表解析真正的金陵体，不得静默换回替代字体。
设计系统包含基础
令牌、栏目/画幅/语言/明暗/密度模式、组件库和场景库。字幕、弹窗、信息卡、
画中画、品牌、封面、开场和转场只读取解析后的设计合同与 digest，不在时间
区间实现中写死字体、颜色、圆角、阴影、边框或缓动。更换模式或风格走
`style` 增量配方并按依赖失效重建。
系统规范、组件与场景选择见 `docs/VIDEO_DESIGN_SYSTEM_V1.md`。

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
- 画面运动遵守“收紧—停稳—释放”：推近、拉远、横移和冲击必须有语义或
  空间理由；全片持续运动、连续同向缩放、无重音音效和裁头都不允许。
- 普通口播字幕不加音效；左右/上下/前后排版只表达真实对照、层级或空间
  关系，同一时刻最多三个阅读区和一个主重音，人物后文字必须有逐帧蒙版。
- 字体按场景角色、字符覆盖、真实文件 hash 和授权状态解析；缺字、路径变化
  或授权缺失时阻断，不静默 fallback，不把本地字体二进制提交到公开仓库。
- 语义动效以短语义拍为单位：动作在重读词前 0–2 帧启动，在重音帧到达
  峰值，并在下一事件前完整退出；不得按固定秒数随机套“网感”效果。
- 正式语义动效只从已验证 timeline plan 渲染；展示模式标签、固定示例文案
  和 showcase 音轨不得进入成片。
- 信息卡/流程图/弹窗要么全屏，要么避开人物头脸与字幕安全区；高影响模块
  先做样式帧、进入/停稳/退出和声音设计。
- 真人画中画默认把原始完整画面按比例缩小后再套形状和边框，不得先用固定
  矩形硬裁人物；双屏的每个窗格必须按人物锚点居中并保留完整头顶。
- 插镜同时匹配对象、动作、角色、状态、时态、方向和全片风格。
- 含口播且需要音频处理时，先做人声/非人声分离；只有验收通过的 dialogue
  stem 可进入降噪、美化和混音，residual 不回混。
- 匹配已认可的人声参考时，必须同时比较同响度听感、LRA/峰均动态、频谱、
  声像和语气强弱；只对齐 LUFS 不算完成。知识口播默认采用
  `references/audio.md` 的“自然口播参考基准”和 `warm-soft` 长听感预设。
- SFX 按功能建立调色板并与事件逐一映射；禁止整片反复套一个声音。
- 美颜默认关闭。明确启用时只使用本地 Beauty v2，并且只做磨皮、美白、匀肤
  和法令纹弱化；不得回退 GPUPixel、生成式人脸修复或云端美颜。
- Beauty v2 渲染必须由当前项目配置显式 `enabled=true`，携带逐帧 Vision
  manifest，并通过主脸跟踪、媒体保真、同帧 A/B 和人工动态复核；仅指定
  profile 不构成启用授权。QC 报告必须冻结配置与完整实现链 digest。
- 高影响视觉模块使用 `design render` 生成真实样式帧与实施清单；预检必须
  校验文件 hash、当前 design digest、实现 digest、组件、字体与 token
  路径。发布前运行 `design qc --matrix` 覆盖全部 mode 取值和组件/场景状态。
- 检测到系列时，视频和封面使用同一系列标识、层级和安全区。
- 自动技术 QC、当前版本人工审片和对应门禁全部通过前，不能称为可发布成片。
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
```

十三阶段为：`inventory → transcript_structure → rough_cut →
dialogue_preprocess → connection_qc → fine_cut → visual_packaging →
subtitles → final_mix → cover → preview_render → final_qc →
release_package`。前一阶段没有证据，不得把后一阶段写成完成。

方案模板见 `examples/edit-proposal.json`、`examples/edit-plan.json` 和
`examples/project-manifest.json`。具体合同以 `references/project-workflow.md`
为准。

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
node tests/run_tests.mjs
```

可用套件见 `node tests/run_tests.mjs --list`；也可用 `--match 关键词`。
公开 core 与机器专属 overlay 必须分别测试，组合通过后再原子同步到 Codex
和 Claude，不能直接覆盖当前可用安装。
