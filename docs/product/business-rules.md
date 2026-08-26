# Business rules

> 对账修订：`opencut-informed-editor-core-2026-08-26`。

## 角色、权限与权益

用户拥有内容、版权、付费、外传、正式执行、审片和发布决定。Agent 可在明确范围内
修改本地代码和项目文件；外部上传、付费调用、生产部署、发布及不可逆操作必须另有授权。

## 核心规则与状态机

能力选择先执行可用性、必需能力、模式、隐私、许可和费用硬门禁，再排名。
费用按 `reserve → pending_approval/approved → reconciliation_required → reconcile
→ refund` 迁移；每条预占只允许一次执行意图消费，调用成功或失败都按真实账单
对账，未知费用不按 0 处理。参考片版权为 `unknown`、用途为 `analysis-only`，或
许可/合理使用审查缺少证据时禁止派生。制作引擎不可静默替换。

## 边界、数据与集成约束

素材默认本地；外部上传必须显式允许。参考片只作为分析输入，不自动进入正式资产。
所有产物绑定 SHA-256 或内容摘要。工作流包只生成现有 Kacha 命令清单，不持有
执行状态；变量只接受单行标量，命令只允许已登记 Kacha 子命令。飞行记录拒绝
项目外 realpath 和符号链接源，并对敏感字段脱敏。OpenMontage 仅作 clean-room
架构参考，不复制 AGPL 实现。

Timeline 时间以整数 tick 和有理帧率为 canonical；兼容 seconds 与 tick 相差超过半帧
即拒绝。Editor Command 只能命中 projection 给出的字段 allowlist，并同时校验 session
SHA、调用方 base SHA、唯一 command ID、画布/时序合同和 journal 摘要链。undo/redo
同样进入 journal。`studio-canvas` 只能预览，任何 final 请求只允许明确登记且
`finalEligible=true` 的 provider。

Editor 文件身份绑定 realpath；浏览器 session 不能把写入路径带回服务端。恢复和
重开都必须命中调用时的当前 SHA，恢复只信任 snapshots 目录内摘要匹配的快照，
重开只接受可通过 Projection 合同的当前 Timeline。FFmpeg 的静态登记不等于本机
可用，final eligibility 还必须通过当前 runtime probe。
