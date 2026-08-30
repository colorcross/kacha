# Adoption and value measurement

> 状态：度量合同已定义，真实基线尚未采集。本文不授权外部分析服务、上传项目内容
> 或建立用户画像。

## 目标与原则

咔嚓要回答的不是“仓库又多了多少功能”，而是创作者能否更快、更稳地得到一个
可验证候选，并且人工正常速度审片不退化。度量遵循四条规则：显式同意、默认本地、
只留最小结构化事实、工程证据与用户结果分层。脚本、转写、媒体路径、自由文本反馈、
人脸和音频不得进入采用指标。

## 最小事件字典

| 事件 | 必需字段 | 禁止字段 | 证据层 |
| --- | --- | --- | --- |
| `install_attempted` | channel、agent、result、匿名 session id | HOME、用户名、IP、路径 | 激活 |
| `skill_verified` | source ref、bundle digest、gate result | 安装目录绝对路径 | 工程 |
| `project_initialized` | project pseudonym、task type、timestamp | 标题、脚本、素材名 | 激活 |
| `candidate_verified` | project pseudonym、candidate digest、QC result | 视频内容与媒体路径 | 价值 |
| `human_review_completed` | six-guardrail result、review duration bucket | 自由文本、人物身份 | 质量 |
| `revision_completed` | affected layers、active time bucket、result | 原始反馈内容 | 效率 |
| `return_project_verified` | creator pseudonym、day bucket、result | 联系方式与平台账号 | 留存 |

事件默认只保存在项目 `.kacha` 或用户明确指定的本地汇总目录。跨项目汇总必须再次
获得授权；对外发送需要单独选择服务、披露字段、保留期和退出方式，本轮不执行。

## 指标口径

- `install success`：明确安装尝试中，目标未被覆盖且 skill 校验通过的比例。
- `install-to-first-project`：安装成功到首个 `project_initialized` 的中位时长。
- `first verified candidate rate`：创建项目中在七天内得到 `candidate_verified` 且
  `human_review_completed` 的比例；只有自动 QC 不算。
- `active editing time`：排除下载、渲染和等待后的主动操作分钟数；仅做同源、同目标、
  同质量护栏的配对比较。
- `guardrail pass`：语义、连接、字幕、视觉、声音、完整通看六项全部通过的比例。
- `four-week return`：首次验证候选后 28 天内再次完成验证候选的创作者比例。
- `support cost`：每名月活创作者的人工支持分钟与已授权外部服务成本。

分母必须同时记录，不能只报成功次数。缺失事件、退出采集和失败项目不能静默从分母
删除。样本量不足时只报告原始计数和区间，不写“显著提升”。

## 小规模真实项目协议

第一阶段只邀请明确同意的真实项目。每个项目冻结源身份、目标、质量护栏、版本和
审片人；先记录现有流程基线，再使用咔嚓完成同源任务。效率整体提升声明继续遵守
至少 8 个同源、人工审阅配对且关键护栏无退化的既有规则。采用/留存只在自然时间窗
结束后报告，不用模拟数据填补。

每次发布前复核工程和安装证据；每月复核采用与支持数据；每季度决定是否继续当前
方向、调整 onboarding 或提出新的分析服务方案。任何外部分析方案都必须单独列出
字段、处理者、位置、费用、删除机制和用户同意文案。

## 当前基线与决策门槛

当前所有采用、价值、留存和经营指标均为 `unknown`。下一步只建立真实基线，不预设
增长结论。若安装成功率或首次候选率暴露明显失败，优先修复 activation；若效率变快
但任一质量护栏退化，停止效率推广；若用户价值成立但支持成本过高，再评估自动化或
商业模式，而不是先扩张功能面。
