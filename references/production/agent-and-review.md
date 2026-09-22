> 政策版本说明：narrative-v1 的需求分层与已实现手法以 `references/optimization-execution.md` 为准；下文通用数量下限仅适用于 legacy 工程。

# agent-and-review

本文件中的 scripts/、references/、docs/、config/ 均相对咔嚓根目录。按当前任务读取；新旧政策由项目合同决定。

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

需要对 AI 成片做精确、可撤销的人工校正时，Agent 使用 Editor API 或打开本机
`/editor` 工作台。Timeline 内部时间优先使用 120000 tick/s 与有理帧率；旧版秒数
只在兼容边界保留。工作台是同一 Timeline IR 的 projection，不拥有第二份状态：

```bash
node scripts/kacha.mjs editor inspect --timeline TIMELINE.json
node scripts/kacha.mjs editor project --timeline TIMELINE.json
node scripts/kacha.mjs editor command apply --timeline TIMELINE.json \
  --command COMMAND.json
node scripts/kacha.mjs editor command undo --timeline TIMELINE.json --expected-sha CURRENT_SHA
node scripts/kacha.mjs editor command redo --timeline TIMELINE.json --expected-sha CURRENT_SHA
node scripts/kacha.mjs editor recover --timeline TIMELINE.json --expected-sha CURRENT_SHA
node scripts/kacha.mjs editor reopen --timeline TIMELINE.json --expected-sha CURRENT_SHA
node scripts/kacha.mjs mcp-config show --client codex --root /absolute/project
node scripts/kacha.mjs mcp-config show --client claude --root /absolute/project
```

每次写入必须命中 item allowlist、当前 base SHA 和 Command Journal；journal 保存
forward/inverse mutation、快照、影响轨道与所需 QC。`recover` 只恢复最后有效
快照，`reopen` 只接受合法外部修改；两者都要求当前 SHA 并归档旧状态。浏览器按
EDL 映射源时间但不合成转场 overlap，只提供 `approximate_preview`，不能替代
FFmpeg Render Graph 或发布审片。

Workbench V3 可做多选吸附、timed-item move、trim、ripple trim、split、overwrite、
EDL 显式重排、Marker、工作区、多画幅安全框、异步波形、Project Bin 替换和 overlay
`x/y` 键帧。Workspace 把同一项目内的主版本、候选版本和不同画幅注册为多条独立
Timeline IR，并用 digest、当前 Workspace SHA 和 Timeline SHA 失败关闭：

```bash
node scripts/kacha.mjs workspace create --output WORKSPACE.json --timeline TIMELINE.json
node scripts/kacha.mjs workspace show --workspace WORKSPACE.json
node scripts/kacha.mjs workspace duplicate --workspace WORKSPACE.json \
  --expected-sha WORKSPACE_SHA --source main --id vertical-v1 \
  --output versions/vertical-v1.json --width 1080 --height 1920 --role aspect
node scripts/kacha.mjs pro-capabilities
node scripts/kacha.mjs delivery profiles
node scripts/kacha.mjs delivery plan --timeline TIMELINE.json --profile h264-master --output FINAL.mp4
node scripts/kacha.mjs delivery bundle --timeline TIMELINE.json --output PROJECT_BUNDLE
node scripts/kacha.mjs nle export --timeline TIMELINE.json --format premiere-xml --output TIMELINE.xml
```

Marker、工作区和交付画幅是非渲染 editor metadata；键帧会进入 FFmpeg final。媒体
替换只接受当前项目索引中强身份、许可和来源仍有效的适配素材；转场已执行时结构
编辑失败关闭。交付 profile 必须同时验证视频/音频 encoder、muxer 和 pixel format；
交付计划不是成片。自包含工程默认不复制媒体，显式包含时逐引用执行许可白名单、
provenance、证据和当前 SHA 门禁。NLE 交换拒绝超出真实源媒体时长的区间并绑定稳定
Timeline/source 快照；Premiere XML 是 xmeml v5 候选。H.264/H.265/ProRes 仍必须经过
正式 Render Graph、QC、正常速度人工审片和目标 NLE 实机导入验证，不能因本机存在
encoder 或生成了交换文件就宣称交付完成。

Codex/Claude Code 可选用根目录受限的本地 stdio MCP。所有路径必须位于启动时
指定的绝对 `--root`，写工具仍要求 Timeline SHA 并走同一 journal。MCP 接入不授予
上传、付费、正式渲染、发布、force mutation 或整项目覆盖权限。首次验证可运行
`node examples/first-run/demo.mjs`；90 秒目标仅表示离线首次可验证编辑，不是成片验收。

这些命令默认由 Agent 自动调用；不要把内部命令选择、索引建立或对象标注工作
推给用户。mutation delta 是单次操作证据，v3 version delta 仍负责版本级
失效、渲染和 QC，两者不能混用。

## V6：智能剪辑证据闭环

完整首剪在最终带时间语义 cues 稳定后，先编译全片导演计划与素材缺口，不得
继续只按局部 cue 堆效果：

导演计划会按显式内容信号选择实验与证据、操作演示、现场记录或观点留白模板；
需要指定时使用 `--recipe evidence-story|product-demo|field-journal|reflective-talk`。
每拍的 `craft` 标注真实证据与画面文字，详见专业剪辑 reference。阅读不足不自动
延长原片，动作/声音 handle 不足不假装执行匹配切或 J/L-cut；先补源段或回退。
`editingCraft` 的候选手法必须通过当前素材预览并编入 Timeline IR 才算实际使用。

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

当前 `kacha start` 创建的源视频项目还必须设置
`productionQualityV1.required=true` 并登记 `plans.productionQuality`。这份统一
质量合同吸收真实返工中的高频缺陷：半句话、遗漏连接点、无开场、清单一次全出、
伪多行字幕、长段人物身后文字、自 PIP/遮头、语义不符的外部素材、固定或断续
BGM、粗描边、3D 封面身份漂移，以及用静态证据代替正常速度审片。
`gate-plan / gate-render / gate-release` 分别验证 `plan / execution / release`，
不得把计划占位值当执行或发布证据。完整说明见 `docs/PRODUCTION_HARDENING.md`。
品牌字体、封面身份与栏目节奏不再写死在通用验证器中；新合同必须记录
`productionProfile.packId / showId / packSha256`。行者大灰使用
`xingzhe-dahui` production pack，其他项目可使用不含行者品牌资产的包。
