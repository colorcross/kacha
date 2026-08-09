# 架构与设计边界

## 设计目标

咔嚓把容易混在一起的五件事拆开：

1. 方案是否完整；
2. 当前机器是否具备能力；
3. 时间线是否真的执行；
4. 自动技术检查是否通过；
5. 人工审片和本地交付是否完成。

前一阶段不能冒充后一阶段。

## 主要数据对象

### `.kacha/orchestration.json + workflow-recipes`

V7 顶层编排状态冻结运行版本、Codex/Claude 双安装摘要、输入身份、执行授权、
V6 开关、项目文件和唯一下一步。`config/workflow-recipes.json` 把十三个专业阶段
映射为“方案确认、首剪确认、成片审阅、交付与返工”四个用户里程碑。
`start/run/resume/status` 是同一状态机入口；对话中断不能靠模型记忆重建进度。

V8 在项目状态旁维护 `.kacha/efficiency-plan.json` 与
`.kacha/cache-audit.json`。它从当前 cues/version delta 生成实际代表区间，
把十三阶段编译为带资源容量的 DAG 波次，并将自动任务包在主机资源锁和遥测内。
效率计划不是质量豁免：完整候选通看、一次最高质量终编和发布门禁保持强制。

### `contentProject + content package`

没有视频时先建立 `content-spine`、`fact-check-tasks`、`recording-plan`、
`asset-inbox` 和 `source-edit-handoff`。事实与素材未逐项解决、内容未人工批准时，
不能把录制或生成媒体交接为正式 `source_edit` 项目。

### `assetInbox`

从当前 `assetGapPlan` 生成的人机协作清单。提交项必须绑定当前文件身份、许可与
来源；提交后状态只是 `pending_reindex`，必须重建 media index 和 asset gap
plan 才能解除生产 blocker。说明性生成候选不能冒充事实证据。

### `editProposal`

定义目标、输入、内容结构、模块、授权、回退和 13 阶段。它回答“为什么做、允许做什么、成功是什么”。

### `editPlan`

定义切点、主体、景别、切镜理由、连续性和效果合同。它回答“时间线上具体怎么做”。
高影响视觉模块还必须引用当前视频设计系统的真实样式帧、实施清单、文件 hash、
字体选择和 token 路径。

### `projectManifest`

把 proposal、plan、能力快照、输入、输出和 QC 报告连接起来，是统一门禁入口。

### `Timeline IR + Render Graph`

`timeline.ir.json` 是正式时间线唯一事实源，记录源 SHA、EDL、画面呼吸、叠加
层、字幕、人声、BGM、SFX 和输出合同。`render-graph.json` 是从它确定性编译
的执行图，冻结配置、事件、几何、编码器、decision digest，以及 proposal /
edit plan、overlay、字幕、dialogue、BGM、SFX 与字体目录的真实内容身份。
正式视觉版本在一个 FFmpeg filter graph 内最多完成一次视频编码；只有 graph、
所有输入身份、输出及全部声明 stem 同时匹配时才复用。同路径素材原地替换会
改变 graph digest；已有正式输出不会被失效 graph 静默覆盖。

### `.kacha/metrics + cache + project-state`

- `metrics/events.jsonl`：逐阶段墙钟时间、真实/估算 Token 来源、缓存、编码
  次数、产物和日志；
- `cache/`：源 SHA、实现 SHA、模型权重/服务 SHA、参数、操作版本与输出
  schema 的内容指纹产物；
- `project-state.json`：v2 十三阶段、决定、问题、当前文件证据哈希与唯一
  下一步；五种 packet 只负责上下文路由，不冒充执行状态。

三者都是执行证据，不由对话历史代替。

### `.kacha` Agent 对话控制面

- `mutation-delta.json`：一次 JSON 合同操作的紧凑变化证据，只返回变化路径、
  对象与受影响层，不复制完整 snapshot；
- `media-index.json`：本机素材的描述、标签、转写、OCR、Apple Vision 分类、
  许可和区间索引；
- `jobs/ + placeholders/`：可恢复后台任务、日志和 ready 产物身份；
- `object-index.json`：绑定 owner SHA、JSON Pointer 与 object digest 的
  `@type:id` 短引用；
- `install status`：源码 bundle 与 Codex/Claude 用户级安装的只读摘要比较。

控制面服务 Agent 聊天，不是第二套编辑器。它缩小模型读取和等待范围，正式
版本仍进入 Timeline IR、Render Graph、v3 依赖失效和发布门禁。

### `generatedShotPlan`

描述生成镜头的参考素材、哈希、provider/model/transport、能力快照、动作节拍、规格、授权和 QC 目标。

### v3 `projectContext + versionDelta + artifactIndex`

`projectContext` 保存项目与基线的稳定事实；`versionDelta` 只记录本轮变化；
`artifactIndex` 保存产物内容指纹、依赖和重建成本。三者生成
`incrementalPlan`，推导 L0–L3 风险、失效/复用产物、最小渲染范围和动态 QC。
旧 `localChangePlan` 只服务尚未迁移的 v2 项目。

### `releaseReport`

记录最终文件哈希、限制和人工审片证据。自动报告不能自行生成“人工通过”。
统一审片中心按当前最终视频 SHA-256 初始化十一项检查；任一检查失败只创建
待 Agent 编译的返工请求，十一项都通过后才能显式批准本地成片。

### `deltaQc + incrementalReview`

`deltaQc` 记录变化层检查与冻结流 SHA-256；`incrementalReview` 记录当前候选
版本的动态人工检查。候选报告不能冒充最终 `releaseReport`。

## 门禁

```text
editProposal + editPlan + inputs
                │
                ▼
            gate-plan
                │
      capability snapshot
                │
                ▼
           gate-render
                │
       external render engine
                │
                ▼
               qc
                │
       human review evidence
                │
                ▼
          gate-release
```

顶层用户路径为：

```text
start ──► 方案确认 ──► 首剪确认 ──► 成片审阅 ──► 交付与返工
           │              │             │              │
        内容/V6证据     连接与精剪    统一审片/QC    当前哈希发布清单
           └──────────── status / resume ──────────────┘
```

### `gate-plan`

检查 proposal、任务路径、授权、真实输入、SHA-256 和计划一致性。

### `gate-render`

检查阶段、输入、能力与输出合同是否具备执行条件。它不是渲染命令。

### `qc`

对最终媒体执行自动技术分析，输出可追溯报告。

### `gate-release`

核对最终视频、封面、字幕、技术报告、SHA-256 和人工检查证据。

### `gate-candidate`

只用于 v3。核对当前输出、增量技术报告、冻结层证明和变化层人工证据。
`candidate` 通过后仍可返工；只有 `release_candidate` 能进入
`gate-release`。

## V4 确定性执行层

模型不再直接控制状态机，而是通过八个稳定入口工作：

- `doctor`：运行环境和视觉补偿能力；
- `prepare`：按任务/模型档位生成受预算约束的执行包与 readOrder；
- `next`：从真实文件和哈希推导唯一下一步；
- `compile-change`：把常见返工小合同编译成 v3 delta/manifest/plan；
- `effects`：校验、枚举和真实预览统一风格下的开场/转场；
- `design`：解析视频设计系统，使用注册 renderer 生成 SVG/PNG/ASS 与实施
  清单，并对全部 mode/状态运行矩阵 QC；
- `beauty`：验证默认关闭与本地作用域、执行项目级启用授权，并把自动技术
  QC 与人工动态复核分开；
- `studio`：在只监听本机的五步生产页面中配置素材、风格、声音、效果和
  交付；长期风格与当前项目覆盖分离，生成前校验源片、可写输出、授权字体、
  设计系统和注册效果，再编译为 brief、项目配置和 Agent 执行入口，不直接
  渲染或授予发布权限；
- `fonts`：扫描真实字体元数据、字符覆盖、文件 hash 与项目授权，按场景角色
  解析本地字体但不再分发字体文件；
- `breathing`：把带时间口播编译为“收紧—停稳—释放”的镜头运动计划；
- `captions`：把普通单行、左右、上下和前后景排版编译为可审计字幕时间线；
- `connections`：合并最终时间线切点与场景变化候选，生成逐点复核 handle；
- `visual-evidence`：本地关键帧、人物、OCR 和技术证据；
- `vision-enrich`：外传、付费服务和显式命令授权后，以 MiniMax 增强有限
  关键帧语义。
- `delta / media / jobs / refs / install`：Agent 对话控制面，分别处理操作级
  变化、本地语义素材、后台任务与 placeholder、对象短引用和双端同步状态；
  不改变既有项目状态机或授权边界。

`nextAction.owner` 把 `agent`、`render_engine` 和 `human` 分开，防止验证命令
冒充渲染、自动 QC 冒充审片。详细合同见
`references/agent-execution.md` 和 `references/visual-evidence.md`。

## V5 性能与弱模型执行层

V5 在 V4 状态机之上增加四个确定性边界：

1. **阶段 packet**：`inventory / content / edit / visual_audio / release`
   分开路由；每阶段 reference 不超过 12k tokens，完整 packet 不超过 16k；
2. **转写分窗**：完整逐词 JSON 留在文件，agent 用 `transcript index/slice`
   按 90 秒窗口读取，单次上限 180 秒；
3. **规则与升级**：`rules query/compile/apply` 只返回 1–3 个候选；低置信度
   或冲突只能做局部预览并升级，不能 final；
4. **统一执行**：`timeline` 编译、`render` 一次正式编码、`cache` 内容复用、
   `resources` 主机级跨项目调度、`metrics` 自动观测。

```text
stage packet + transcript window + semantic cues
                         │
                         ▼
              deterministic rules
                         │
                  Timeline IR
                         │
                  Render Graph
                         │
       cache + resource leases + telemetry
                         │
             preview / one final encode
                         │
                    QC + human
```

模型只负责意图、内容结构、候选选择和短预览比较；文件身份、状态、依赖、编码、
缓存和技术 QC 由代码负责。实现和运维命令见
`docs/PERFORMANCE_TOKEN_STABILITY_V5.md`。

## V8 质量不降级效率层

`quality_efficiency.mjs` 提供六类动作：

- `plan/validate`：风险、首剪/增量代表区间和不可关闭质量不变量；
- `schedule/execute`：依赖、资源、输出冲突和本地执行授权；
- `cache-audit`：输入、实现、参数、输出 schema 与产物 SHA 的强指纹证据；
- `compare`：至少八个同源成对真人项目的效率声明门禁。

V3 增量计划复用同一选择器，因此 CLI 独立计划和生产增量计划不会出现两套区间
逻辑。项目页与统一审片观察区读取同一摘要。完整合同见
[V8 质量不降级效率](QUALITY_PRESERVING_EFFICIENCY_V8.md)。

要求 BGM 的最终 QC 不止检查独立 stem：它先用 dialogue/BGM/SFX 重建 mix，
再比较最终视频解码音频与 mix stem 的残差信噪比。因此“组件文件正确但最终
成片漏混”会被阻断。

## V6 智能剪辑证据层

V6 不改变 Timeline IR 与 Render Graph 的事实源地位，在其前后增加八个可审计
对象：

- `globalDirectorPlan`：全片主线、内容优先级、唯一开场、强调预算和安静比例；
- `assetGapPlan`：许可本地候选、尚未物化的非事实生成候选和必须补真实证据的阻断项；
- `temporalPerceptionAudit`：主效果并发、阅读时间、闪烁、字号、蒙版、声音
  落点、运动覆盖和人工动态复核要求；
- `semanticReviewBundle / Session`：高影响决策的理由、置信度、经解码/视频/音轨/
  代表时长验证的 1× 正常速度预览、接受/调整/拒绝和解决证据；
- `preferenceCandidate / Profile`：显式反馈的证据计数、版本激活与回滚；
- `editorialEvalDataset / Report / Comparison`：人工评测基线和同源成对比较；
- `nleExport / ImportReport`：OTIO/FCPXML/CMX3600 交换与 candidate-only 边界；
- `projectObservability`：Jobs、遥测、缓存、编码和磁盘的用户可见摘要。

```text
semantic cues → director → asset gaps → Timeline IR / Render Graph
                                          │
                               perception + review session
                                          │
                         preference candidate + paired evaluation
```

`intelligenceV6.required=true` 时，v2 与 v3 的 `gate-plan`、`gate-render` 和
`gate-release` 分别验证上述计划、执行缺口和审片证据，并交叉核对 director、
asset plan、Timeline、perception 与 review 是否属于同一 project/SHA 证据集。
旧项目默认兼容。素材索引 digest v2 冻结许可、来源和强文件身份；NLE 交换绑定
基线与源片 SHA，导入只接受基线已知语义 ID 并建立独立 preview candidate；
偏好候选只从 candidate-ready session 重建并按 scope 加锁合并；自动审计永远
保留人工正常速度通看。完整命令与证据边界见 `docs/INTELLIGENT_EDITING_V6.md`。

## 配置边界

`scripts/kacha_config.mjs` 把内置、用户、项目、本机和显式配置合并成一份
经过 schema/range 校验的安全快照。`prepare`、`compile-change`、视觉证据、
MiniMax、QC、音频和素材工具只读取这份快照，并记录无密钥 digest。

密钥由独立 `secrets.json` 或环境变量提供，值通过非枚举内部状态和子进程环境
传递，不能进入序列化报告。默认要求进入执行合同，但不能覆盖项目
authorization 或不可降低的安全门禁。

### 风格与效果边界

`config/design-system/` 保存系统、五组模式、组件和场景注册表；
`config/styles/` 保存统一 style profile，`config/effects/` 保存开场、转场与
33 个语义网感机制注册表。项目时间区间只引用
design system/style/scene/component/effect ID
与 digest，不复制字体、颜色、阴影、边框和缓动。设计系统由
`scripts/design_system.mjs` 解析，`scripts/kacha_design.mjs` 提供验证、枚举、
解析和样式帧预览。每个本地实施清单同时冻结解析器、风格解析器与渲染器代码
摘要，防止旧样式帧在实现变化后继续被当作当前证据。语义网感注册表也进入
design digest，机制或 QC 合同变化时会使依赖它的视觉证据失效。效果注册表定义实现、
handle、声音功能、失败条件与 fallback；具体是否使用仍由内容、情绪、视角
和连续性判断。

`config/production-studio.json` 是生产页面的模板与专业自动判断注册表。
`scripts/kacha_studio.mjs` 与 `studio/` 共用同一校验和编译入口；页面不能
形成第二套风格 schema。生成的项目配置只保存偏好与执行意图，继续受统一
配置、方案、能力、渲染、QC 和人工审片门禁约束。

`scripts/netstyle_timeline.mjs` 是机制注册表与正式时间线之间的执行层。它
读取最终带时间文稿，把显式 `effectId` 或确定性语义触发编译为帧级事件，
冻结源片、文稿、蒙版、素材、设计系统和注册表摘要，再由
`netstyle render-plan` 对锁画后的完整视频执行区间渲染。项目通过
`plans.netstyleTimelines` 把计划接入 `gate-plan` 与 `next`；正式输出
manifest 证明演示标签未进入成片，并检查解码、尺寸、有效帧率、时长、人声
与音效峰值。`preview/showcase` 仍只负责能力开发和回归。

`scripts/visual_breathing.mjs` 与 `scripts/caption_layout.mjs` 使用同一份最终
带时间文稿。前者限制运动密度和覆盖率，后者限制阅读区、人物遮挡、字体真实
命中和蒙版依赖；两者都冻结源媒体、配置和注册表摘要，并在 SFX 混音前测量
源音效能量峰值。项目分别通过 `plans.visualBreathingTimelines` 与
`plans.captionTimelines` 接入 `gate-plan`。`scripts/kacha_fonts.mjs` 只索引
本地字体，项目授权记录不改变字体内嵌许可，也不允许公开分发字体文件。

FFmpeg/SVG 预览证明实现可运行，不证明效果适合当前内容。正式渲染前仍需用
真实前后片段和真实声音做最小 A/B。

## 失败即停

- 输入缺失或哈希不符：停止；
- 授权与任务路径冲突：停止；
- 必需能力缺失：降级或停止；
- 蒙版、文字层和源视频 PTS 不一致：停止；
- 生成任务状态未知：查询，不自动重提；
- declared FPS 与 average FPS 不一致或不符合合同：先安全重封装或回到时间线修复；
- 自动 QC 有线索：人工处置后再继续；
- 人工审片证据缺失：不得 release。
- 显式缓存请求与依赖失效冲突：拒绝复用；
- `candidate` 试图进入最终发布：停止；
- 局部预览试图占用正式输出、final 带未解决升级项或正式编码超过一次：停止；
- 缓存键已存在但内容/哈希失效、缓存超过容量或凭证试图进入缓存：停止；
- 多个重型 MPS/视频编码任务争用资源：等待或停止，不静默并行；

## 扩展方式

新增能力时优先：

1. 在 reference 中定义触发条件、机制、简单替代、失败条件和 QC；
2. 在 capability probe 中增加真实探测；
3. 在 JSON 合同中增加可验证字段；
4. 在测试中同时覆盖通过与失败路径；
5. 不把平台专有能力写成跨平台稳定能力。
