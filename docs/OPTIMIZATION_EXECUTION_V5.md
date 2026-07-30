# 咔嚓 V5 全流程性能、Token 与弱模型稳定性升级

## 目标

本轮升级不降低内容、画面、声音和发布门槛，完成以下生产级闭环：

1. 所有执行阶段自动记录耗时、Token、编码次数、缓存和产物；
2. 将剪辑、动效、呼吸、字幕和混音编译为统一 Timeline IR 与 Render Graph；
3. 探索阶段只使用代理或局部预览，正式画面最多一次高质量整片编码；
4. 转写、源分离、蒙版、跟踪和生成素材按内容指纹复用；
5. 弱模型只处理意图、配方和候选选择，状态、计划、执行、缓存和 QC 交给代码；
6. 用真实/合成黄金项目证明速度、Token、媒体保真和已知缺陷门禁。

## 执行顺序

### P0 可观测性

- `kacha metrics run` 包装真实命令，自动写 JSONL 事件、日志和聚合报告；
- 每次记录阶段、模型档位、估算/实际 Token、缓存、渲染范围、视频编码次数、
  墙钟时间、退出状态和产物；
- 工具只向模型返回紧凑摘要，完整日志写文件；
- 正式工作流缺少运行指标时不得声明性能收益。

### P1 统一渲染

- `timeline.ir.json` 是唯一时间线事实源；
- `render-graph.json` 是确定性执行图；
- graph 冻结合同、全部媒体层、字幕与字体的真实内容身份，同路径替换会失效；
- 代理预览使用低分辨率快速编码；
- 正式输出从最高质量源一次编码；
- 纯音频变化 stream-copy 视频，纯封面变化不渲染视频；
- L2 只重建变化区间与前后 handle。

### P2 高价值缓存和资源调度

- 产物缓存键至少包含源 SHA、区间、工具/模型内容 SHA、服务实现、参数、
  几何和 FPS；
- Demucs、ASR、蒙版、跟踪、Beauty、样式帧和付费生成默认进入缓存；
- CPU、GPU/MPS、视频编码、网络和 I/O 使用主机级共享资源配额；
- 不同时运行多个 4K 编码或多个重型 MPS 任务。

### P3 低 Token 执行

- 主 Skill 只保留路由、不可降低合同和稳定入口；
- 按 `inventory / content / edit / visual_audio / release` 生成上下文 packet；
- v2 十三阶段状态按真实 `{path, sha256}` 证据顺序推进；
- 模型只读取语义 cue 和低置信度转写片段，不读取完整逐词 JSON；
- 效果库先由规则检索 1–3 个候选；
- 项目状态、决定、问题和下一步写文件，不依赖长对话重建。

### P4 弱模型稳定生产

- 使用结构化信号、候选评分、失败条件和 fallback 编译剪辑决策；
- 相同输入、配置、实现和随机种子得到相同计划 digest；
- 低置信度创意判断生成短预览或升级给强模型/人工，不降低合同；
- `nextAction.owner` 继续严格区分 agent、render engine 和 human。

### P5 黄金回归

- 合成 fixture 验证确定性、媒体合同和失败路径；
- 本地真实黄金项目覆盖 EDL、运镜、overlay、字幕、BGM、SFX、组件/mix
  stems 和最终成片漏混证明；
- 每次 Skill 更新先跑受影响套件，再跑黄金 canary 和完整回归。

## 验收目标

以下均为完成本轮实现后需要实测的目标，不是预先声明的收益：

- 正式 4K 整片视频编码最多 1 次；
- 纯音频返工视频编码 0 次；
- 纯封面返工视频处理 0 次；
- 首次基线后高价值 artifact 缓存命中率不低于 80%；
- 单阶段路由 reference 目标不超过 12,000 tokens；
- 相同输入和配置的计划 digest 100% 一致；
- economy 档黄金项目确定性任务通过率不低于 95%；
- 弱模型合同违规、静默 fallback 和旧证据冒充新版本均为 0；
- 最终 A/V 漂移不超过 1 帧，完整技术 QC 和人工通看不减少。

## 完成定义

只有代码、配置、文档、自动测试、真实代表性 E2E、双端安装和逐项审计全部
通过，才可把 V5 标记为完成。组件存在、命令可运行或合成 fixture 通过都不能
单独证明真实视频生产闭环。

## 已实现映射

| 目标 | 实现 |
| --- | --- |
| 自动观测 | `run_telemetry.mjs`：阶段、真实/估算 Token 来源、缓存、编码、产物、瓶颈与脱敏日志 |
| 一次正式编码 | `timeline_ir.mjs` + `render_project.mjs` |
| 局部代理 | `timeline render --range-start/--range-end` |
| 高价值缓存 | `artifact_cache.mjs` 及 ASR、Demucs、mask、Beauty、styleframe、generated wrappers |
| 资源调度 | `resource_pool.mjs` + `resource_scheduler.mjs` |
| 转写分窗 | `transcript_window.mjs` + `prepare --transcript-window` |
| 确定性规则 | `decision_rules.mjs` + `config/decision-rules.json` |
| 状态持久化 | `workflow_state.mjs` + `project_state.mjs` + `next_action.mjs` |
| 真实黄金回归 | `golden_regression.mjs` |
| 完成审计 | `optimization_audit.mjs` |

当前自动回归、真实媒体 canary 和双端安装仍须在每次发布候选上重新运行；历史
报告不能证明新提交。运行命令与证据边界见
`docs/PERFORMANCE_TOKEN_STABILITY_V5.md`。
