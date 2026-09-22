# control-and-orchestration

本文件中的 scripts/、references/、docs/、config/ 均相对咔嚓根目录。按当前任务读取；新旧政策由项目合同决定。

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
后台任务取消要确认进程退出，失败产物恢复前先隔离。任务列表默认限量，
用 `jobs list --status failed` 查看恢复建议；输出必须是新路径，`--foreground`
失败会返回非零退出码。Timeline IR 会核对
Placeholder 的 ready 状态与产物 SHA；重复对象 ID 必须使用确定性后缀，
不能依赖索引输入顺序。
源码开发态先用 `install status` 检查 Codex/Claude 安装，但通过测试前不得
同步。完整规则见 `references/agent-chat-control-plane.md`。

### 治理式生产控制面

涉及多引擎、外部模型、参考视频、费用或高价值复用工作流时，Agent 必须先使用
下列代码合同，不能只在回复中声称已经比较或控费：

- `capabilities rank`：可用性、必需能力、模式、隐私、许可和已知费用是硬门禁；
  只有通过硬门禁的候选才允许按质量、可控性、可靠性、成本、延迟和连续性排名。
- `cost init/reserve/approve/consume/reconcile/refund`：付费执行前必须存在项目账本和预占；
  未知单价不得填成 0，超过审批阈值不得在批准前对账为已执行。
  `vision-enrich` 的真实 cache miss 还必须显式传入 `--cost-ledger` 与
  `--cost-entry`；执行前会将预占原子消费为 `reconciliation_required`，同一预占
  不得跨调用复用。缓存命中不新增付费预占；调用失败也保留待对账状态，必须按
  真实账单将实际金额（包括 0）对账。
- `reference analyze/derive`：只接收本地、已确认来源的参考文件；版权为 `unknown`
  或仅允许 `analysis-only` 时禁止派生；`licensed`/`fair-use-review` 要求权利证据。
  派生物必须保留 `keep/change/doNotCopy` 和禁止逐镜复制合同，源文件变化后旧分析失效。
- `rhythm analyze/validate`：只生成绑定本地源文件强身份的场景变化、能量、起音、
  下降和 BPM 技术候选；必须保留“无语义理解、非权威 beat grid”声明。要把证据带入
  原创方案，必须先由 `reference analyze --rhythm-evidence` 绑定，且权利允许原则派生。
- `composition route`：`series` 与 `hero` 的必需能力和选中引擎必须落盘；引擎
  不可用时阻断并重新决策，禁止静默替换。
- `corpus build/search`：片段必须绑定当前索引、源 SHA 和有效时间范围；源文件或
  索引变化后旧 corpus 失效。没有真实向量证据时输出
  `keyword_fallback`，不能把文件名或关键词命中表述为视觉语义理解。
- `flight snapshot/replay`：只读、限量、脱敏地汇总项目事件、遥测、后台任务、
  费用和决策；拒绝项目外链接源。它是观察器，不得承担状态迁移。
- `workflows validate/resolve`：工作流包只生成现有 Kacha 命令清单。执行仍回到
  V7/V8、Timeline IR、Render Graph、QC 和人工门禁。

默认工作流包为 `reference-to-original`、`clip-factory`、`screen-demo` 和
`localization-dub`。完整实施边界见
`docs/OPENMONTAGE_OPTIMIZATION_IMPLEMENTATION_2026-08-26.md`。

## V7 默认生产入口

新项目必须先进入可恢复编排器，不再只生成 brief 后把十三阶段留给对话记忆：

```bash
node scripts/kacha.mjs start --source /path/to/source.mov \
  --project-root /path/to/project
node scripts/kacha.mjs status /path/to/project --summary
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

## 多素材按要求成片

用户提供一批视频、图片和剪辑要求时，使用 `material_edit` 流程。先读
`references/material-editing.md`，再用 `start --materials DIR --requirements TEXT
--duration SEC --aspect 9:16 --project-root DIR --confirm-execute` 建立项目。
Agent 负责实际查看素材、按需转写、拆解要求和编排分镜，通过 `materials
inspect/compose` 与 `run --include-render` 完成候选。不能让用户写 JSON，
不能在建立项目或提交任务后停止，也不能把文件名匹配当成画面理解。

此流程使用四个素材生产里程碑、独立的版本化素材合同和片段缓存；下述 V8
十三阶段及 efficiency 文件自动建立规则适用于单源视频入口。多素材候选经
Timeline IR 统一渲染，技术通过后仍需正常速度审片与正式发布验收。

## V8 质量不降级效率合同

单源视频项目在 `start` 时自动建立 `.kacha/efficiency-plan.json` 和
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
