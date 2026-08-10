# 可感知能力覆盖与返工渲染预算

## 为什么需要这一层

“实现了效果”不等于观众能看到效果。小号顶部文字、重复的橙色标签、极短淡化
和普通裁切，即使技术清单有记录，也可能在正常速度下几乎不可感知。完整剪辑
必须同时通过三层检查：

1. `availability`：引擎、模板、素材和蒙版真实可用；
2. `execution`：事件已经绑定 Timeline IR，并在 render manifest 中执行；
3. `perception`：手机尺寸、正常速度下能看出层级、面积、时长和信息差。

## 行者风能力配额

默认 `config/capability-usage/xingzhe.json` 使用行者风 2.0 的栏目级
`showProfiles`。
它与视觉 token 配置分离，避免仅调整使用频率就让全部视觉证据失效。配额按真实
成片时长计算，覆盖开场、可感知转场、支撑素材、画中画、蒙版纵深、语义动效、贴纸/视线
引导、空间分层、关键帧变化、并列排版、关系字幕、超大背景词、人物前后景
文字和呼吸运镜。

五个栏目分别使用不同的最低覆盖和长视频多样性门禁：工具分享侧重界面、证据
和结果；解读好书降低 PIP、蒙版与强转场配额；有限的无限游戏让真实现场和
过程素材优先；灰常AI允许更活跃的语义动效，但事实核验段自动收稳；闲聊以
人物、语气和留白为主，降低画中画、蒙版、强转场与连续音乐覆盖，只在观点、
笑点和情绪拐点使用可感知变化。模板必须显式写入 `showId`，策略摘要或栏目变化
后需要重新规划。

这不是“每隔几秒随机加效果”。每个事件仍须写出真实语义触发、机制、最简
替代、失败条件、进入/峰值/退出、声音功能和动态 QC。硬门禁包括：

- 开场配额不受 `minimumDurationSeconds` 影响：任何时长都必须且只能有一个
  主开场，0.5 秒内开始可见变化，3 秒内兑现内容承诺；注册效果或完整自定义
  合同二选一；
- 语义动效和空间层次必须绑定
  `config/effects/production-motion-policy.json` 中的决策路由，或提交字段等价的
  自定义专业动效合同；
- `supporting_media` 至少来自外部真实素材、AI 生成素材、HyperFrames 中的
  两类；每个素材都要有来源、许可/生成记录和 SHA-256；
- PIP 必须与主画面形成信息差，不能把同一 A-roll 缩小后叠在自己身上；
- 两分钟以上口播默认规划逐帧人物蒙版，支持人物后文字或真实空间分层；
- 超大背景词至少为普通字幕的 3 倍，并占据足够可见面积；
- 人物前后景文字至少为普通字幕的 1.8 倍，可读字形面积不低于 65%；
- 单一实现不得超过全部事件的 35%，不能用同一种小字弹出反复充数。

生成与验证：

```bash
node scripts/kacha.mjs visual-capabilities template \
  --duration 399.28 --style xingzhe --show book-talk \
  --opening hook_title_behind_subject \
  --output visual-capability-plan.json
node scripts/kacha.mjs visual-capabilities validate \
  --plan visual-capability-plan.json
node scripts/kacha.mjs visual-capabilities validate \
  --plan visual-capability-plan.json --for-execution \
  --timeline timeline-ir.json
```

模板只给配额和结构。执行前必须把占位触发替换为真实语义，把素材、逐帧蒙版和
Timeline ID 绑定到当前版本，并为每个能力事件提交动态短片、代表帧及其
SHA-256。模板占位符、缺文件、失效哈希或只写计划未落到时间线，都会在整片
渲染前阻断。全流程执行项目把计划登记到
`plans.visualCapabilityPlan`；`gate-plan` 检查覆盖，`gate-render` 检查真实
资源与时间线绑定。

## 返工渲染预算

返工最浪费时间的模式是：每调整一次参数就整片低清导出，随后又整片正式
编码，再重复完整 QC。v3 默认预算改为：

- 参数探索：只允许 1–3 个代表区间，每段带连接 handle；
- 整片代理：代表区间批准且 EDL、style、capability、audio digest 冻结后，
  每个版本最多一次；
- 正式视频编码：每个版本最多一次；相同 Render Graph 必须零编码复用；
- 完整 QC：只在 `release_candidate` 做一次；普通 `candidate` 只做变化层、
  同类回归、连接 handle 和冻结流检查；
- L0–L2 不允许手工请求 `full_rebuild`；只有结构、顺序、时长、几何或完整
  风格系统变化才能进入 L3 完整重建。

遥测命令会在执行前消费预算，超限直接阻断：

```bash
node scripts/kacha.mjs metrics run \
  --project-root PROJECT \
  --workflow incremental --version-id v8 \
  --stage representative_range --mode preview \
  --render-scope range --video-encodes 1 -- COMMAND

node scripts/kacha.mjs metrics run \
  --project-root PROJECT \
  --workflow incremental --version-id v8 \
  --stage full_preview_after_approval --mode preview \
  --render-scope full --video-encodes 1 \
  --approval-evidence representative-preview-approved.json -- COMMAND

node scripts/kacha.mjs metrics run \
  --project-root PROJECT \
  --workflow incremental --version-id v8 \
  --stage final_render --mode final \
  --render-scope full --video-encodes 1 -- COMMAND
```

整片代理、正式编码或完整 QC 预算已经使用时，不能在同一版本中继续重跑。
如果真实依赖变化，先创建新的 `version-delta`，让失效原因、变化层和新预算
可审计；不能靠改文件名绕过。

## 推荐返工顺序

1. 反馈归类并做同类全片扫描；
2. 冻结新的结构/EDL；结构不变时保持原 EDL；
3. 生成能力覆盖差异，只改缺失或表现不足的家族；
4. 每个变化家族选一个最难代表区间，合计不超过三个；
5. 样例批准后冻结四类 digest；
6. 只重建失效层和区间；
7. 生成一次整片代理并正常速度通看；
8. 一次正式编码；
9. 一次完整发布 QC。

这套预算防止重复高成本工作，但不允许跳过当前版本的内容、连接、音画、
字幕、素材、蒙版、混音和正常速度人工通看。
