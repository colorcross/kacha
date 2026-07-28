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
- 插镜/PIP/美颜/蒙版/人物后文字/调色：`references/visuals-masks.md`
- 信息卡/流程图/弹窗/复杂动效：`references/visual-design-preflight.md`
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

## 不可降低的合同

- 源素材只读；新版本独立输出，不覆盖基线。
- 用户未明确要求时，视频保持源像素尺寸、宽高比、有效帧率和色彩合同。
- 半句话、数字、专名、否定、条件、因果和结论不得被切断或改义。
- 画面、dialogue、BGM、SFX、字幕共用同一组帧边界和 PTS。
- 切镜必须由信息、情绪或视角变化驱动；同一主体相邻镜头形成可感知景别
  变化，普通人物镜头不得切掉头顶。
- 转场、字幕强调、SFX、插镜、PIP、蒙版和人物后文字都必须有触发理由、
  最简替代、失败条件与 QC 证据；不能用特效掩盖错误切点。
- 信息卡/流程图/弹窗要么全屏，要么避开人物头脸与字幕安全区；高影响模块
  先做样式帧、进入/停稳/退出和声音设计。
- 插镜同时匹配对象、动作、角色、状态、时态、方向和全片风格。
- 含口播且需要音频处理时，先做人声/非人声分离；只有验收通过的 dialogue
  stem 可进入降噪、美化和混音，residual 不回混。
- SFX 按功能建立调色板并与事件逐一映射；禁止整片反复套一个声音。
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
