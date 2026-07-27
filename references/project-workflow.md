# 项目合同与执行工作流

## 四条路径

每个任务只选一条主路径：

1. `proposal_review`：只分析和给方案，不修改文件；
2. `source_edit`：精剪现有音视频；
3. `content_generation`：从文稿、书籍、笔记或主题生成内容；
4. `local_optimization`：只改已指定的字幕、声音、封面、插镜或版本。

双语、书籍编号、AI 镜头、第三方素材、归档、上传和发布都是条件模块，不随主路径自动启用。

## 方案先行

整支剪辑、跨版本重做和内容生成必须先创建 `editProposal`。方案要具体说明：

- 输入素材、哈希、规格、时长、音轨、转写和代表帧；
- 目标平台、受众、语言、视频画幅、封面画幅、时长和输出格式；
- 内容主问题、开头承诺、必要论点、回报点和结尾；
- 保留、删除、重排和待核验内容；
- 留存、节奏、切镜、景别、画面、字幕、人声、最终混音、调色、美颜/蒙版、生成媒体、封面、输出和 QC；
- 授权范围、假设、风险回退、交付物和允许偏差。

不能只写“优化节奏”“提升画面”或“加入合适素材”。每个启用模块都要有理由、动作和成功条件；不适用模块写 `not_applicable` 及理由。

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
7. `visual_packaging`：插镜、图解、跟踪、蒙版、调色、动效；
8. `subtitles`：按冻结后的最终音频生成、校准和排版；
9. `final_mix`：视觉时序冻结后完成 BGM、SFX、闪避和母带；
10. `cover`：独立制作并核验各封面画幅；
11. `preview_render`：关键段、A/B、代表帧和设备试听；
12. `final_qc`：一次高质量正式渲染、完整解码和全片检查；
13. `release_package`：文件哈希、自动技术 QC、人工审片证据和本地交付包。

同一时刻最多一个阶段为 `in_progress`。前置阶段未通过，后续阶段不能写 `passed`。`not_applicable` 必须记录理由，`passed` 必须记录真实证据。

## 项目 manifest 与统一入口

以 `examples/project-manifest.json` 为结构模板。它集中记录：

- proposal、edit plan、generated shot plan；
- 能力探测 manifest 和项目所需能力；
- 最终视频的尺寸、画幅、帧率、声道、采样率、响度和 true peak 合同；
- 视频、封面、字幕、技术 QC 和 release report 路径。

统一入口：

```bash
node scripts/kacha.mjs gate-plan PROJECT.json
node scripts/kacha.mjs gate-render PROJECT.json
node scripts/kacha.mjs qc PROJECT.json
node scripts/kacha.mjs gate-release PROJECT.json
```

`gate-render` 只表示具备渲染条件，不冒充已经渲染。`qc` 只完成可自动化的技术检查，不能替代正常速度通看。`gate-release` 同时要求真实文件哈希、技术 QC 和人工审片清单。

## 局部迭代

用户提出局部反馈时：

- 每条反馈绑定具体时间段、视觉层或音频 stem；
- 明确 `changed / frozen / affectedIntervals / qcPlan`；
- 默认冻结无关内容；
- 同一轮反馈只生成一个新版本；
- 先做最小预览，再完整渲染；
- 修复一处同类缺陷后，对全片同类位置做规则化回归。

调整人声时使用同源、同响度 A/B；调整美颜时使用同源、同帧、同裁切脸部 A/B；字幕至少检查亮底、暗底和最长一条；画中画检查进入前、停留中和退出后。

## 输出合同

- 原始素材只读，输出进入独立版本目录；
- “保持原格式”分别锁定容器、视频编码、音频编码、分辨率、帧率和色彩元数据；
- 默认继承有效源帧率和 48 kHz 音频；
- 从最高质量源素材直接构建最终时间线；
- 尽量只做一次最终编码，不从低清中间片放大；
- 禁止静默覆盖正式成片、降低分辨率、改帧率或改变声道；
- 付费、上传、发布和不可逆操作需要明确授权。
