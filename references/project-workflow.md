# 项目合同与执行工作流

## 四条路径

每个任务只选一条主路径：

1. `proposal_review`：只分析和给方案，不修改文件；
2. `source_edit`：精剪现有音视频；
3. `content_generation`：从文稿、书籍、笔记或主题生成内容；
4. `local_optimization`：只改已指定的字幕、声音、封面、插镜或版本。

双语、书籍编号、AI 镜头、第三方素材、归档、上传和发布都是条件模块，不随主路径自动启用。

`local_optimization` 还要按风险分流：

- 已有真实基线，且只改一个交付层或局部区间：使用 v3
  `project-context + version-delta + artifact-index`；
- 删除、重排、补录、改画幅、改变时长或整体创意方向：回到 v2 完整方案；
- 没有可验证基线、旧文件身份不明或 artifact 依赖不可信：先重建基线，
  不凭文件名猜测可复用范围。

## 方案先行

整支剪辑、跨版本重做和内容生成必须先创建 `editProposal`。方案要具体说明：

- 输入素材、哈希、规格、时长、音轨、转写和代表帧；
- 目标平台、受众、语言、视频画幅、封面画幅、时长和输出格式；
- 内容主问题、开头承诺、必要论点、回报点和结尾；
- 保留、删除、重排和待核验内容；
- 留存、节奏、切镜、景别、画面、字幕、人声、最终混音、调色、美颜/蒙版、生成媒体、封面、输出和 QC；
- 授权范围、假设、风险回退、交付物和允许偏差。

不能只写“优化节奏”“提升画面”或“加入合适素材”。每个启用模块都要有理由、动作和成功条件；不适用模块写 `not_applicable` 及理由。

在任何粗剪、改画幅、生成素材或效果设计前，必须填写 `creativeLock`：源/输出画幅、是否保持源格式、前台主体、AI 角色、冻结决定和重新授权条件。偏离锁定项时停止执行并重新确认，不能在后续“尽量修回去”。

`creativeLock` 还必须记录源与输出的宽、高、宽高比，以及用户是否明确要求改变输出几何。用户没有说明时，`preserveSourceDimensions=true`、`preserveSourceAspectRatio=true`，输出宽、高、宽高比分别等于源文件探测值。封面画幅是独立合同，不能反向改变视频画幅。

inventory 阶段同时建立 `seriesIdentity`。检查用户说明、项目目录、既有成片、封面、标题和品牌配置；只有证据确认属于系列时才设置 `status=detected`。一旦检测到系列，视频和封面两处系列标识都必须启用并提供安全区证据。执行方案不得保持 `undetermined`。

先运行：

```bash
node scripts/validate_edit_proposal.mjs edit-proposal.json
```

`proposal_only` 必须停止在方案。`plan_then_execute`、`approved_plan` 和 `local_change` 只有在任务路径、授权证据、真实输入文件和哈希全部匹配时才能执行。

## v2 十三阶段

1. `inventory`：只读盘点、技术诊断、能力探测；
2. `transcript_structure`：最终音频转写、语义校准、内容骨架；
3. `rough_cut`：完整语义粗剪；
4. `dialogue_preprocess`：只处理 dialogue stem，保留时长和声道；
5. `connection_qc`：逐连接点正常速度试听和音画同步检查；
6. `fine_cut`：景别、节奏、重构图、切点和转场精修；
7. `visual_packaging`：先完成高影响模块 `designPreflight`，再实施插镜、图解、跟踪、蒙版、调色和动效；
8. `subtitles`：按冻结后的最终音频生成、校准和排版；
9. `final_mix`：视觉时序冻结后，按自适应 BGM 计划完成分段音乐、留白、SFX、闪避和母带；
10. `cover`：独立制作并核验各封面画幅；
11. `preview_render`：关键段、A/B、代表帧和设备试听；
12. `final_qc`：一次高质量正式渲染、完整解码和全片检查；
13. `release_package`：文件哈希、自动技术 QC、人工审片证据和本地交付包。

`visual_packaging` 进入实施前还必须通过 `visualCapabilityPlan`：按当前
style profile 和成片时长计算能力家族配额，检查素材/蒙版资源任务、PIP
信息差、实现多样性与正常速度可感知性。计划写了效果但未绑定 Timeline IR，
或只用重复小字达到数量，不得进入正式渲染。

开场不是可选包装。规划阶段必须从核心开场库或 `z-en-netstyle` 开场族中
冻结一个主开场；自定义方案必须带完整动效合同。短于能力配额阈值的视频仍需
保留一个开场事件：0.5 秒内开始可见变化，3 秒内兑现内容承诺，并在正式渲染前
提供真实画幅、真实字体、真人/素材安全区和项目声音下的正常速度动态预览。
缺开场、重复主开场、开场过晚或只有静态效果图时，`gate-plan` 直接阻断。

同一时刻最多一个阶段为 `in_progress`。前置阶段未通过，后续阶段不能写 `passed`。`not_applicable` 必须记录理由，`passed` 必须记录真实证据。

## 处理后的中间产物

`release_package` 后可以建立 `cleanup-plan.json`，但默认先 dry-run，不自动删除：

- `routine`：仅处理用户确认不需要、已验证可快速重建、且下一轮返工不依赖的缓存；
- `final`：只有用户明确说明视频已经完成且不会再修改后启用；
- 原始素材、当前/基线成片、工程、方案、manifest、许可、最终 QC/release 证据和批准的人声 stem 始终保护；
- 重建需要长时间、付费生成、重新下载、重新人工校准或重新审核的产物不属于例行缓存。

清理报告必须进入 release package，记录候选路径、文件数、预计/实际释放空间、重建成本、用户保留偏好和失败项。

## 项目 manifest 与统一入口

以 `examples/project-manifest.json` 为结构模板。它集中记录：

- proposal、edit plan、generated shot plan；
- 唯一 `timeline.ir.json` 与确定性 Render Graph；
- 能力探测 manifest 和项目所需能力；
- 最终视频的尺寸、画幅、帧率、声道、采样率、响度和 true peak 合同；
- 视频、封面、字幕、技术 QC 和 release report 路径。

统一入口：

```bash
node scripts/kacha.mjs gate-plan PROJECT.json
node scripts/kacha.mjs gate-render PROJECT.json
node scripts/kacha.mjs render PROJECT.json
node scripts/kacha.mjs qc PROJECT.json
node scripts/kacha.mjs gate-release PROJECT.json
```

`gate-render` 只表示具备渲染条件，不冒充已经渲染。`render` 会再次执行门禁，
把 EDL、画面、字幕与混音编译为同一个 Render Graph，并最多完成一次正式
视频编码。`qc` 只完成可自动化的技术检查，不能替代正常速度通看。
`gate-release` 同时要求真实文件哈希、技术 QC 和人工审片清单。

当前 `kacha start` 还会生成 `production-quality-contract.json`。它把多轮返工中
最容易反复出现的问题合并为一份跨阶段合同：禁止半句话、枚举全部最终连接点、
强制唯一开场、清单逐项随口播和独立 SFX、多行字幕按语义逐行出现、人物身后
仅用短词、PIP 必须有信息差并做进入/停稳/退出三态避碰、外部素材记录语义与
来源、BGM 随节奏情绪内容变化、电影级 3D 封面使用真人脸与三视图双锚点，发布
前必须正常速度全片通看。`gate-plan`、`gate-render`、`gate-release` 分别调用
`plan`、`execution`、`release` 验证，不能用后阶段占位值提前通过。

探索阶段只做独立局部代理：

```bash
node scripts/kacha.mjs timeline render \
  --plan timeline.ir.json --mode preview \
  --range-start 42 --range-end 50 \
  --output preview/42-50.mp4
```

区间、叠加层、字幕、dialogue、BGM 和 SFX 共用偏移后的 PTS；局部预览不写
正式 stems，也不得占用正式成片路径。

## 局部迭代

v3 是默认路径，具体合同见 `references/incremental-workflow.md`。每轮反馈只写
相对基线的 `version-delta.json`；脚本推导冻结层、失效产物、最小渲染范围和
专项 QC。旧的 `local-change-plan.json` 只保留给尚未迁移的 v2 项目，不再要求
局部返工复制完整 proposal、edit plan 和 release report。

局部反馈必须绑定具体层或时间区间；同一轮只产生一个新版本。先做代表帧、
短片段或同源 A/B，参数冻结后再完整渲染。修复一处规则性缺陷后，对全片同类
位置做专项回归。

纯音频改动优先 stream-copy 原视频流；纯画面改动保留原音频流；封面专项
版本不渲染视频。删除、重排和改时长必须让所有时间层共用帧边界并升级为 L3。
旧报告不能复制为新报告；冻结结论只能由 elementary-stream SHA-256 和依赖
指纹证明。

调整人声时使用同源、同响度 A/B；调整美颜时使用同源、同帧、同裁切脸部 A/B；字幕至少检查亮底、暗底和最长一条；画中画检查进入前、停留中和退出后。每个切点检查切前/切后人物头部完整性；信息卡、流程图和弹窗检查信息最满帧的头像安全区；人物后文字检查字体、字号层级、可见面积、字幕避让和 SFX 同步。信息模块、风格化转场和蒙版先冻结本地样式帧或 Figma 设计交接，再做最小动效预览；使用 SFX 时对整片 `sfxPlan` 做重复率、类别和事件映射审计。

## 输出合同

- 原始素材只读，输出进入独立版本目录；
- “保持原格式”分别锁定容器、视频编码、音频编码、分辨率、帧率和色彩元数据；
- 默认继承有效源帧率和 48 kHz 音频；
- 用户未明确指定新尺寸或画幅时，默认继承源宽度、源高度和源宽高比；
- 从最高质量源素材直接构建最终时间线；
- 正式视觉时间线最多一次最终编码，不从低清中间片放大；
- 完全相同的 Render Graph 与输出哈希直接复用，编码次数为 0；
- 禁止静默覆盖正式成片、降低分辨率、改帧率或改变声道；
- 付费、上传、发布和不可逆操作需要明确授权。
