# 咔嚓 V6：智能剪辑评测、审片与学习闭环

## 结论

V6 不再把“效果数量”当成智能程度。它在 V5 的 Timeline IR、Render Graph、
Mutation Delta、Jobs、缓存和发布门禁之上，新增一条可验证的智能性证据链：

```text
带时间语义 cues
      ↓
全片导演计划：主线、强调预算、留白与唯一开场
      ↓
素材缺口计划：本地候选 / 生成候选 / 必须补真实证据
      ↓
Timeline IR + 局部正常速度预览
      ↓
时序感知审计 + 语义审片台
      ↓
接受 / 调整 / 拒绝 + 解决证据
      ↓
可审查偏好候选 → 显式激活 / 版本回滚
      ↓
真实项目编辑评测与同源版本比较
```

V6 不建立第二套渲染器，不自动发布，不用综合“神奇分数”掩盖具体问题，也不
把自动 QC 冒充人工正常速度审片。

## 一、已经实施的模块

### 1. 全片导演计划

入口：

```bash
node scripts/kacha.mjs intelligence director \
  --cues semantic-cues.json \
  --show tool-share \
  --style light-warm-overlay \
  --output director-plan.json
```

导演编译器为每个语义拍记录：

- `narrativeRole`：hook、premise、evidence、contrast、explanation、conclusion；
- `contentPriority`：必须保留、可压缩、压缩候选或需要人工复核；
- `attentionClass`：高影响或安静；
- `visualIntent` 与四风格专属 `styleMechanism`；
- 使用效果或刻意不用效果的理由；
- 最简回退、素材需求、置信度和人工复核要求。

全片级硬约束包括唯一主开场、高影响决策上限、连续强拍上限和最低安静比例。
“不用效果”是正式决策，不是能力缺失。

四套风格使用不同导演语法：

| 风格 | 全片语法 | 强拍机制 | 安静机制 |
| --- | --- | --- | --- |
| 浅暖轻浮层 | 编辑连续性 | 边缘旁注 | 干净真人画面 |
| 空间光路 | 纵深导航 | 固定世界坐标中的光路 | 稳定空间 |
| 幽默漫画 | 喜剧节拍 | 铺垫—停顿—反应 | 干净分格停稳 |
| 像素风 | 状态机 | 可验证状态提交 | 高清真人与稳定图形层 |

### 2. 主动素材缺口计划

```bash
node scripts/kacha.mjs intelligence assets \
  --director director-plan.json \
  --media-index .kacha/media-index.json \
  --output asset-gap-plan.json
```

每个缺口只允许三类结果：

1. `local_candidate`：本地语义与许可均满足的候选；
2. `generated_visual_candidate`：只可补抽象说明，不能冒充事实；
3. `user_or_source_evidence_required`：真实人物、官方数据、研究、产品实拍等
   必须补来源证据。

素材索引截断、许可未知或真实证据未补齐时，`--for-execution` 失败。生成候选
不会预授权外传或付费调用。

### 3. 时序感知审计

```bash
node scripts/kacha.mjs intelligence perception \
  --timeline timeline.json \
  --output temporal-perception-audit.json
```

当前自动检查覆盖：

- 同时出现多个主效果；
- 文字展示过短或手机尺寸字号过小；
- 短时高不透明全屏闪烁风险；
- 人物分层效果缺少蒙版证据；
- 声音峰值与可见落位超过一帧；
- 运动覆盖率过高、安静比例不足；
- 时间区间无效。

没有真实动态像素证据时，报告只能是 `pass_with_human_review`。蒙版边缘抖动、
真实闪烁、观感层级和手机实际阅读仍要正常速度人工确认。

### 4. 语义审片台

先建立审片包：

```bash
node scripts/kacha.mjs review build \
  --timeline timeline.json \
  --director director-plan.json \
  --preview-dir preview/ \
  --output-dir .kacha/review

node scripts/kacha.mjs studio serve
```

浏览器打开 `http://127.0.0.1:4179/review`。审片台以视频和剪辑决定为中心，
显示：

- 区间、类别、理由、置信度、建议机制和最简回退；
- 正常速度带声音的前后预览；
- `accept / adjust / reject` 三种明确结果；
- 调整或拒绝后的解决证据；
- 全部决策覆盖数、未解决修改数和候选就绪状态；
- 项目 Jobs、遥测、缓存、编码、磁盘、ETA 与费用证据状态。

视频通过受 SHA-256 约束的本地 Range 接口播放，服务仍只监听 loopback。接受
不等于发布；调整和拒绝没有当前解决证据时不能成为候选就绪状态。

命令行等价入口：

```bash
node scripts/kacha.mjs review record \
  --bundle .kacha/review/review-bundle.json \
  --decision DECISION_ID --outcome adjust \
  --note "卡片遮住人物手势，移到右上安全区" \
  --resolution-evidence preview/fixed-card.mp4

node scripts/kacha.mjs review validate \
  --session .kacha/review/review-session.json --for-candidate
```

### 5. 可解释偏好学习与回滚

```bash
node scripts/kacha.mjs review learn \
  --session .kacha/review/review-session.json \
  --output preference-candidate.json

node scripts/kacha.mjs review activate \
  --candidate preference-candidate.json \
  --profile ~/.config/kacha/preferences-v6.json \
  --confirm
```

偏好只从明确的接受、调整和拒绝建立；同一规则至少需要两条证据。候选不保存
自由文本备注，不保存人物或内容身份，不自动激活。激活前会复核来源 session 的
SHA-256；激活后形成单调递增的版本号和不可冲突历史目录。回滚不会把版本号倒退，
而是以目标规则建立一个新的可审计版本：

```bash
node scripts/kacha.mjs review rollback \
  --profile ~/.config/kacha/preferences-v6.json \
  --version 1 --confirm
```

### 6. 真实编辑质量评测

```bash
node scripts/kacha.mjs eval template --output eval-dataset.json
node scripts/kacha.mjs eval validate --dataset eval-dataset.json
node scripts/kacha.mjs eval score \
  --dataset eval-dataset.json --output eval-report.json
node scripts/kacha.mjs eval compare \
  --baseline baseline-report.json \
  --candidate candidate-report.json \
  --output comparison.json
```

评测必须由人类明确复核，逐项目记录：

- 首稿可用率与平均首稿可用度；
- 高影响决策接受、调整和拒绝率；
- 语义损坏率；
- 每分钟成片需要的人工干预分钟；
- 连接点拒绝率；
- 字幕修正率；
- 风格语法违规率。

单份报告只能建立基线，不能宣称提升。同源成对比较至少需要 8 个来源组；比较
前会复核数据集 SHA-256，并且所有差值只计算双方真实共有的配对来源，不让未配对
样本污染结论。报告保留所有维度，不生成可掩盖退化的综合虚荣分数。

### 7. 专业 NLE 交换

```bash
node scripts/kacha.mjs nle export \
  --timeline timeline.json --format otio --output timeline.otio
node scripts/kacha.mjs nle export \
  --timeline timeline.json --format fcpxml --output timeline.fcpxml
node scripts/kacha.mjs nle export \
  --timeline timeline.json --format cmx3600 --output timeline.edl
```

OTIO 与 FCPXML 保留咔嚓 clip ID、semantic beat ID 和 decision ID。人工在 NLE
修改后，只能导入为独立候选：

```bash
node scripts/kacha.mjs nle import \
  --input timeline.otio --format otio \
  --base-timeline timeline.json \
  --output timeline.nle-candidate.json
```

导入不覆盖基线，强制 `mode=preview`，并要求 Timeline validate、Delta、变化层
QC 和人工正常速度复核。CMX3600 因语义承载能力有限，目前只用于兼容导出。
复杂字幕、蒙版、Beauty、混音和动效仍以 Timeline IR 为唯一事实源。

### 8. 项目可观测性

```bash
node scripts/kacha.mjs intelligence observe \
  --project-root PROJECT_DIR --output observability.json
```

报告汇总：后台任务状态、失败/中断、阶段历史耗时、Token 证据、缓存命中、
视频编码次数和磁盘空间。没有可靠进度分母时不猜 ETA；没有 provider 真实费用
时不按 Token 猜价格。

## 二、与现有项目门禁的连接

旧项目保持兼容。需要启用完整 V6 门禁时，在项目 manifest 增加：

```json
{
  "intelligenceV6": { "required": true },
  "plans": {
    "directorPlan": "./director-plan.json",
    "assetGapPlan": "./asset-gap-plan.json",
    "temporalPerceptionAudit": "./temporal-perception-audit.json",
    "semanticReviewSession": "./.kacha/review/review-session.json"
  }
}
```

门禁行为：

- `gate-plan`：校验导演计划和素材缺口计划的 schema、digest 与全片预算；
- `gate-render`：素材索引截断或真实证据缺口未解决时停止；
- `gate-release`：时序审计有 blocker、人工动态审片被取消、审片决策未覆盖或
  调整/拒绝没有解决证据时停止；
- V6 证据不能降低 proposal、Timeline IR、QC、release report 的既有要求。

## 三、验证策略

仓库回归同时覆盖通过和失败路径：

- 全片导演唯一开场、安静比例和四风格语法；
- 许可素材命中与真实证据阻断；
- 主效果冲突、闪烁、字号和声音落点阻断；
- 审片全覆盖、偏好候选、未确认激活失败；
- 8 组同源人工评测才允许提升声明；
- OTIO/FCPXML 语义 ID 往返和 candidate-only；
- 审片台 loopback、CSP 与本地视频播放边界。

运行：

```bash
node tests/run_tests.mjs --match V6
node tests/run_tests.mjs
```

## 四、不能伪造的剩余证据

代码完成不等于已经证明真实成片更好。以下工作只能随着真实项目积累：

1. 用至少 8 个同源项目建立首个真实人工基线；
2. 用四栏目、四风格、不同画幅和片长扩展评测覆盖；
3. 在 Final Cut Pro、Premiere、DaVinci Resolve 的真实工程中复核交换结果；
4. 对真实 4K 成片补充像素级时域检测并继续人工手机/耳机审片；
5. 只有同源评测报告满足最小样本政策后，才对外宣称首稿可用率或节省时间。

这些是生产证据任务，不是代码缺口；仓库不得用合成 fixture 冒充真实效果。
