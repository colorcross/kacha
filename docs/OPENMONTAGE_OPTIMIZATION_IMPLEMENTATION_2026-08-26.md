# 咔嚓 OpenMontage 差距优化实施记录

## 当前结论

本轮已获得用户授权，目标是在不替换咔嚃确定性本地制作内核的前提下，完成 Capability Broker、费用账本、参考视频工作流、制作飞行记录器、素材语料检索、制作模式路由和高价值工作流包。

实施采用 clean-room 边界：只借鉴架构思想，不复制 OpenMontage AGPL 源码、素材或实现细节。

## 事实源

- 差距审查：`quality/change-review.json`
- 批准计划：`quality/implementation-plan.json`
- 验收矩阵：`quality/verification-matrix.json`
- 界面与旅程：`quality/page-delivery.json`
- 本实施日志：本文档

## 基线与保护边界

- 基线 revision：`0e4cda8f6615d186caa25e382ff620e182472369`
- 已跟踪脏差异 SHA-256：`f9f808ce0275923b89f83aeac887f0a6108a6cd889f731dd5c8415d12c164448`
- 基线时间：`2026-08-26T09:30:07+08:00`
- 开工前存在未提交的电影化字景改动。本轮不回退，对 `README.md`、`SKILL.md`和 `tests/run_tests.mjs` 的重叠区仅做增量合并。

## 实施状态

| ID | 能力 | 状态 | 产物 | 验收 |
| --- | --- | --- | --- | --- |
| CAP | 能力与提供者路由 | 本地完成 | 注册表、探测、硬门禁、逐维排名 | 专项与全量通过 |
| COST | 费用账本 | 本地完成 | 估算、预占、审批、对账、退款、执行器门禁 | 专项与全量通过；未发起付费调用 |
| REF | 参考视频智能 | 本地完成 | 技术分析、版权边界、原创派生 | 专项与全量通过 |
| FLIGHT | 制作飞行记录 | 本地完成 | 事件归一、快照/回放、Studio 只读界面 | 专项与 Studio API 回归通过 |
| CORPUS | 片段级素材检索 | 本地完成 | clip corpus、运动测量、MMR、回退披露 | 专项、真实 FFmpeg 测量通过 |
| COMPOSITION | 制作模式路由 | 本地完成 | Series/Hero 请求与决策 | 专项与全量通过 |
| PACKS | 高价值工作流包 | 本地完成 | 四套包、校验、安全变量解析 | 专项与全量通过 |
| UXDOC | CLI、Studio、文档与测试 | 本地完成、待独立终审 | CLI、README、SKILL、架构、产品文档、154 项测试 | 深审专项通过；最终全量与双 Agent 摘要以本轮证据文件为准 |

## 执行日志

### 2026-08-26 09:30 +08:00

- 确认用户授权为全面实施，不含外部发布、付费调用和生产部署。
- 记录 Git 基线、脏差异摘要和开工前未跟踪文件哈希。
- 启用 AppCreate project-native 控制面并完成非源码迁移。
- AppCreate `discover_project.py` 因其上游 `locate_state` 未定义而失败；本轮不修改外部 AppCreate，改用已成功的 `status_project.py` 和项目内状态文件继续。
- 完成 8 项差距的正式审查记录、实施切片、架构决策和验收矩阵。

### 2026-08-26 10:00 +08:00

- 完成七个产品切片及 CLI 路由；MiniMax `vision-enrich` 的真实 cache miss 已
  强制绑定费用账本预占，未执行任何真实付费调用。
- Studio 项目状态台增加只读制作飞行记录；自定义 provider/workflow registry
  只能校验或查看，不能触发本机探测和命令解析。
- 完成 154/154 全量回归；最终专项回归 5/5；`make check-static`、密钥扫描、
  安装器测试、Studio JS 语法和真实 FFmpeg 运动测量通过。
- 当前本地证据：`quality/evidence/openmontage-local-verification.json`。
- Codex/Claude 安装在同步前均为 `out_of_sync`，已启动原子同步及 bundle 内完整
  回归；初轮同步完成，两端在深审改动前均已回读为 `current`。

### 2026-08-26 深度多专业复核

- 从产品、架构、实现、安全与隐私、费用治理、数据完整性、可靠性、Studio 交互、
  可访问性和测试质量复核本轮切片，记录见
  `quality/deep-multidisciplinary-review-2026-08-26.md`。
- 费用预占改为与执行意图绑定的一次性原子消费；消费后必须对账，重复使用失败关闭。
- 参考片派生增加明确用途和权利证据；源文件或分析摘要漂移后旧派生计划失效。
- media corpus 在构建和校验时重验索引摘要、源 SHA、时长与片段范围。
- 飞行记录增加敏感字段脱敏、输入上限、项目 realpath 边界与符号链接拒绝；Studio
  使用显式本地读请求头和安全 DOM 构造。
- provider、composition 和 workflow 配置增加结构、语义、命令模板与路径约束。
- 专项回归已通过；全量、静态、安装器、产品文档、审查合同和双端同步的最终结果
  统一写入 `quality/evidence/openmontage-local-verification.json`，不复用初轮结果
  冒充深审后验证。

## 诚实完成边界

本地代码和回归通过，不等于外部提供者真实调用、发布候选、部署成功或真实运营结果。中高风险改动的最终独立审查必须由与实施者独立的复核者完成；在没有该证据前，不宣称发布就绪。
