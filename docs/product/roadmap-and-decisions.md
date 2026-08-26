# Roadmap and decisions

> 对账修订：`opencut-informed-editor-core-2026-08-26`。

## 当前路线与优先级

当前优先级依次为：完成 Editor 本地回归与双 Agent 同步；在真实但不付费的项目中
试运行专业调整、参考片、clip factory 和飞行记录；独立复核中高风险改动；最后才
决定候选发布、外部提供者接入和真实运营实验。

## 重要产品决定

1. 保留咔嚓确定性本地生产内核，不改造成 Agent 自由编排器。
2. 采用 hard-gate-first Capability Broker，综合分不能绕过红线。
3. 未知费用不等于免费；付费执行前必须预占、审批并一次性消费，随后必须对账。
4. 参考片只提炼抽象原则，派生用途与权利证据必须明确，禁止逐镜、原文和源资产复制。
5. 飞行记录只读、限量、脱敏且不越过项目边界；工作流包不拥有第二套状态机。
6. OpenMontage 使用 clean-room 借鉴边界。
7. Timeline IR 仍是唯一事实源；Workbench 是 projection/command 客户端，不拥有第二套状态。
8. 用 120000 ticks/s 与有理帧率解决长时间线和分数帧率漂移；旧 seconds 继续兼容。
9. Studio Canvas 永不进入 final；Rust/WGPU 在 current parity 与发布资格成立前保持不可用。
10. Journal recovery 与接受外部修改是两个显式动作；前者恢复最后有效快照，后者重开
    session，均要求当前 SHA、保留旧状态归档，不做静默 rebase。

## 被替代的产品定义

- “只在文档中列提供者即算具备能力”被真实 runtime probe 与决策摘要替代。
- “未知价格可按本地/免费继续”被费用失败关闭规则替代。
- “一条预占可支持多次外部调用”被执行意图绑定的一次性原子消费替代。
- “参考片靠对话描述后直接进入计划”被版权状态与原创派生合同替代。
- “项目状态仅显示阶段结果”扩展为可回看多个证据源的只读制作飞行记录。
- “必须依赖外部 NLE 才能做基础精调”扩展为本地类型化轨道、Inspector 和可恢复
  Command Journal；复杂 NLE 功能和正式渲染边界不变。
