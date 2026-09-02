# Roadmap and decisions

> 对账修订：`kacha-palmier-workspace-v3-2026-09-01`。

## 当前路线与优先级

当前优先级依次为：修复官方安装、macOS smoke、Studio 启动性能和 HTTP 边界；
建立机器可检的产品事实与真实 channel 文案；完成双语可访问性、完整回归、远程
工作流回读和双 Agent 同步；随后才在用户授权的小规模真实项目中建立激活、首次
候选、人工质量与返工时间基线。候选 Release、外部分析 SDK、付费提供者和广义 NLE
扩张仍需新的明确决定。

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
11. checkout 与 stdin 安装共用一份 release-channel 合同；官网命令显式选择 canary，
    stable 当前为 `v1.2.0`，在新 tag/Release 完成前保持不变。
12. 内置 Studio 目录按进程缓存并在 ready 前预热；自定义风格保持动态读取，不能用
    缓存换取陈旧的用户配置。
13. 当前产品数字由静态门禁推导；采用指标遵循本地优先、最小化、显式同意和证据分层。
14. 对 OpenCut/OpenMontage 继续只借鉴任务编排、可恢复性和可解释交互原则，不追求
    全功能 NLE 同质化，也不复制 AGPL 实现。
15. FableCut 的可取方向落实为人机共编工作台、Project Bin、技术节奏证据和 MCP
    接入；不复制第三方实现，也不把自动分析包装成创意语义。
16. Marker/工作区/交付画幅是 editor metadata，不改变正式 Render Graph；overlay
    `x/y` 键帧是正式画面状态，必须进入 FFmpeg 终渲染和视觉动态复核。
17. MCP 使用根目录受限的 stdio 工具面；它复用 Timeline IR 与 Command Journal，
    不建立第二套工程状态或权限系统。
18. Palmier Pro 的可取之处是统一专业工作面、多时间线版本和 UI/Agent 共用编辑域；
    咔嚓采用 clean-room 产品模式，不复制 GPLv3 实现。
19. Workspace 只注册多个独立 Timeline IR；nested timeline 在终渲染语义完成前保持 planned。
20. H.264/H.265/ProRes 使用封闭 profile 和运行时 encoder 探测；交付计划不冒充已渲染成片。
21. 工程包默认 contract-only，不泄露绝对路径；只有显式授权且 license/provenance/SHA
    完整的媒体才允许复制。

## 被替代的产品定义

- “只在文档中列提供者即算具备能力”被真实 runtime probe 与决策摘要替代。
- “未知价格可按本地/免费继续”被费用失败关闭规则替代。
- “一条预占可支持多次外部调用”被执行意图绑定的一次性原子消费替代。
- “参考片靠对话描述后直接进入计划”被版权状态与原创派生合同替代。
- “项目状态仅显示阶段结果”扩展为可回看多个证据源的只读制作飞行记录。
- “必须依赖外部 NLE 才能做基础精调”扩展为本地类型化轨道、Inspector 和可恢复
  Command Journal；复杂 NLE 功能和正式渲染边界不变。
- “官网默认命令无需说明渠道”被显式 canary/stable 选择替代。
- “手工同步当前能力数字”被可执行 product-truth gate 替代。
- “GitHub 流量可以代表采用”被工程、激活、价值、质量、留存和经营分层替代。
