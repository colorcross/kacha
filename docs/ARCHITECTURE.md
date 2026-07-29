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

### `editProposal`

定义目标、输入、内容结构、模块、授权、回退和 13 阶段。它回答“为什么做、允许做什么、成功是什么”。

### `editPlan`

定义切点、主体、景别、切镜理由、连续性和效果合同。它回答“时间线上具体怎么做”。
高影响视觉模块还必须引用当前视频设计系统的真实样式帧、实施清单、文件 hash、
字体选择和 token 路径。

### `projectManifest`

把 proposal、plan、能力快照、输入、输出和 QC 报告连接起来，是统一门禁入口。

### `generatedShotPlan`

描述生成镜头的参考素材、哈希、provider/model/transport、能力快照、动作节拍、规格、授权和 QC 目标。

### v3 `projectContext + versionDelta + artifactIndex`

`projectContext` 保存项目与基线的稳定事实；`versionDelta` 只记录本轮变化；
`artifactIndex` 保存产物内容指纹、依赖和重建成本。三者生成
`incrementalPlan`，推导 L0–L3 风险、失效/复用产物、最小渲染范围和动态 QC。
旧 `localChangePlan` 只服务尚未迁移的 v2 项目。

### `releaseReport`

记录最终文件哈希、限制和人工审片证据。自动报告不能自行生成“人工通过”。

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

`nextAction.owner` 把 `agent`、`render_engine` 和 `human` 分开，防止验证命令
冒充渲染、自动 QC 冒充审片。详细合同见
`references/agent-execution.md` 和 `references/visual-evidence.md`。

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

## 扩展方式

新增能力时优先：

1. 在 reference 中定义触发条件、机制、简单替代、失败条件和 QC；
2. 在 capability probe 中增加真实探测；
3. 在 JSON 合同中增加可验证字段；
4. 在测试中同时覆盖通过与失败路径；
5. 不把平台专有能力写成跨平台稳定能力。
