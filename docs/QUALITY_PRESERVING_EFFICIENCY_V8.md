# 咔嚓 V8：质量不降级效率优化方案

## 1. 结论

咔嚓的效率优化不以减少质量检查、降低终片规格或增加模型自由发挥为代价。
V8 把效率提升限定为五件可执行、可验证的事：

1. 用当前项目证据计算风险，而不是所有项目一律走同样深度；
2. 参数试错只渲染实际代表区间，而不是反复整片导出；
3. 只并行依赖独立、资源不冲突、输出不重叠的任务；
4. 高成本产物只有强指纹完整时才复用；
5. 没有同源成对项目和质量护栏，就不宣称提速。

最终候选仍从最高质量源构建，完整正常速度通看、一次正式视频编码、语义完整、
素材许可和当前产物证据都是不可关闭的质量不变量。

## 2. 生产流程中的位置

```text
start
  → 冻结源文件、运行版本和授权
  → 生成 V8 风险与效率计划
  → 当前 cues / version delta 选择代表区间
  → 代表区间渲染与人工确认
  → 按 DAG 波次执行独立任务
  → 强指纹缓存复用或明确 miss
  → 一次整片代理（需要时）
  → 一次最高质量终编
  → 完整自动 QC + 正常速度人工通看
  → 成对项目效率比较
```

V8 是 V7 编排器的一层合同，不替代 V2 十三阶段、V3 增量、V6 全片导演或发布
审片。`.kacha/orchestration.json` 仍是可恢复状态源；V8 新增：

- `.kacha/efficiency-plan.json`
- `.kacha/efficiency-inputs.json`
- `.kacha/cache-audit.json`
- `.kacha/efficiency-execution-report.json`
- `.kacha/metrics/events.jsonl`

## 3. 风险预算

风险分数只来自当前可定位证据。当前策略检查：

| 信号 | 处理 |
| --- | --- |
| 首剪 | 增加基础风险；必须覆盖四类代表区间 |
| 20/45 分钟以上 | 增加长片风险，避免只看头尾 |
| 删除、重排、几何变化 | 结构风险；保留连接点与边界检查 |
| 全局换风格 | 提高为高风险，不允许局部假复用 |
| 连接、密集字幕、事实、蒙版/跟踪、音频转折 | 加入对应代表区间理由 |
| 没有当前 cues | 标记 `unknownEvidence`，结构区间只是待确认 fallback |

风险等级为 `low / standard / high / critical`。它决定审阅深度和区间理由，不得
关闭完整候选通看、正式编码预算或发布门禁。

## 4. 代表区间合同

### 4.1 首剪

首剪至少有四类：

- `opening`：开场承诺、人物进入或唯一主开场；
- `typical_information`：占比最高的正常讲述或信息节奏；
- `complex_visual`：蒙版、证据、PIP、跟踪、关系字幕或多层合成；
- `ending`：结论、回扣、行动建议或系列收束。

当前 cues 出现连接、密集字幕、事实证据、蒙版/跟踪或音频转折时，可合并到同一
物理区间的 `categories`，避免为一个镜头重复渲染。没有 cues 时使用结构位置产生
待人工确认区间，并记录
`structural_fallback_requires_human_confirmation`，不冒充画面分析结果。

### 4.2 增量返工

V3 `incremental-plan.json` 直接写入 `renderPlan.representativeRanges`。所有 delta
区间先加 handle、合并相邻点，再用最小总覆盖跨度分组压缩到最多三组。每个原始
变化区间必须被至少一组完整包含。变化过于分散、最优分组仍超出时才写入
`durationBudgetException`；系统不得为了满足“短预览”而漏掉变化点。`full`
范围变化固定生成开场、复杂视觉和结尾三段待人工确认样本，不能出现“全局变化、
零段预览”。`no_timeline` 才允许零段。

### 4.3 不可替代的完整检查

代表区间只用于调参和早期否决。它不能替代：

- 一次整片代理的节奏、信息密度和整体声音检查；
- 最高质量源生成的正式候选；
- 当前完整候选的正常速度、开启声音通看；
- 十一项发布审片和当前视频 SHA-256 绑定。

## 5. 依赖与资源并行

`config/workflow-recipes.json` 为每个阶段声明：

- `prerequisites`
- `resources`
- `parallelSafe`
- `outputGroups`

当前十三阶段生成十个波次，其中两组具有并行价值：

1. `rough_cut + dialogue_preprocess`
2. `visual_packaging + subtitles + cover`

这只是依赖许可，不等于无条件同时启动。MPS 和视频编码容量都为 1；任何共享
输出组、串行阶段或资源超额都会拆到后续波次。

实际自动并行使用执行合同：

```json
{
  "schemaVersion": "1.0",
  "kind": "kacha-efficiency-execution-plan",
  "projectRoot": "/absolute/project",
  "authorization": {
    "localExecution": true,
    "upload": false,
    "paidGeneration": false,
    "publish": false,
    "overwriteSource": false
  },
  "tasks": [
    {
      "id": "route-inventory-references",
      "argv": [
        "/absolute/path/to/node",
        "/absolute/kacha/scripts/route_references.mjs",
        "--task", "source_edit",
        "--stage", "inventory",
        "--output", "/absolute/project/work/inventory-references.json"
      ],
      "commandSha256": "sha256-of-current-route_references.mjs",
      "prerequisites": [],
      "resources": ["cpuHeavy"],
      "outputs": ["work/inventory-references.json"],
      "safeToAutoExecute": true,
      "allowParallel": true
    }
  ]
}
```

```bash
node scripts/kacha.mjs efficiency execute execution-plan.json
```

执行器不用 shell 拼接命令。它只运行策略中登记、具有参数级校验器的确定性 Node
脚本；当前只登记 `route_references.mjs`。脚本 SHA、执行计划 SHA 和声明输出必须
保持当前，命令中的 `--output` 必须与唯一声明输出完全一致。依赖环、共享输出、
网络资源、内联代码、未登记脚本、项目外路径、符号链接、越权外部动作和覆盖既有
输出都会被拒绝；任务结束后还会再次检查输出边界。每个任务先取得主机级资源
租约，再由 `metrics run` 记录耗时、缓存、编码、产物和脱敏日志。一个波次有任一
失败，后续波次停止。新增可执行脚本必须同时增加策略登记、参数校验和回归测试，
不能只因为脚本位于仓库内就获得执行权。

## 6. 高成本缓存

适用种类不是固定全开。当前阶段计划必须明确声明本项目实际使用哪些类型，以及
本次任务按源、实现、版本、参数和输出 schema 计算出的预期内容键：

- `source_separation`
- `asr`
- `mask`
- `tracking`
- `beauty`
- `styleframe`
- `generated_media`

一个条目要成为 `ready`，必须同时有：

- 至少一个输入文件 SHA-256；
- 至少一个实现、脚本、模型或服务 SHA-256；
- 操作版本与参数；
- 输出名称/类型 schema；
- manifest key 与完整 contract 内容摘要一致；
- 当前缓存产物的 SHA-256、尺寸，目录产物还要有文件数。

目录有文件、同种类存在旧条目或模型名字相同都不够。只声明种类、没有预期 key
时报告 `expected_keys_missing`；未声明适用种类时报告 `unknown_applicability`，
两者都不计算虚假的预热覆盖率。覆盖率按“当前预期 key 中 ready 的比例”计算，
不是按目录或种类计数。80% 是需要真实项目验证的目标，不是默认事实。缓存根、
种类目录、条目或产物只要经过符号链接就不能成为 ready 证据。

## 7. 命令

```bash
# 首剪：使用当前 cues 生成计划
node scripts/kacha.mjs efficiency plan /path/to/project \
  --cues /path/to/current-cues.json \
  --applicable-cache-kinds asr,mask \
  --expected-cache-keys asr:<sha256>,mask:<sha256>

# 增量：使用当前 version delta 生成最多三段全覆盖计划
node scripts/kacha.mjs efficiency plan /path/to/project \
  --delta /path/to/version-delta.json

# 只有明确放弃旧证据时才能清除；旧文件丢失会 fail closed
node scripts/kacha.mjs efficiency plan /path/to/project --clear-cues
node scripts/kacha.mjs efficiency plan /path/to/project --clear-delta

# 合同与波次
node scripts/kacha.mjs efficiency validate \
  /path/to/project/.kacha/efficiency-plan.json
node scripts/kacha.mjs efficiency schedule

# 强指纹缓存证据
node scripts/kacha.mjs efficiency cache-audit /path/to/project \
  --applicable-cache-kinds asr,mask \
  --expected-cache-keys asr:<sha256>,mask:<sha256>

# 同源成对效率证据
node scripts/kacha.mjs efficiency compare baseline-cohort.json candidate-cohort.json
```

`start/run/resume/status` 自动创建、刷新并展示效率计划。旧 cues/delta 默认延续；
独立的 `efficiency-inputs.json` 保存当前 cues/delta 身份和缓存适用种类/预期 key，
计划损坏时仍可安全恢复；计划与
登记同时损坏则必须补替代证据或显式清除两类输入，不能静默降级。`status`、Studio 和
统一审片观察区会重新核对当前计划输入、策略、配方和缓存内容，不信任磁盘上的
旧 `status` 字段；损坏计划显示为 `refresh_efficiency_evidence` 阻断，`run` 从
当前输入安全重建。

## 8. 效率声明门禁

比较文件必须是 `kacha-efficiency-evidence-cohort`，分别声明 `variant=baseline`
和 `variant=candidate`，两边 `projectId` 集合必须完全一致且不可重复。每个项目
至少记录：

- 当前可解码源视频的 `{path, sha256}`，且成对 `sourceSha256` 相同；
- 当前可解码、含音轨、基线与候选不同且跨项目不复用的审片输出身份；
- `wallSeconds` 和非负整数 `videoEncodes`；
- `humanReview.status=pass`、非空 reviewer、时间戳及当前人审 JSON 文件身份；
- 当前指标 JSON 文件身份与六个 guardrail 的逐项 JSON 文件身份；
- 六个 guardrail：`semanticIntegrity`、`connectionPlayback`、
  `subtitleAccuracy`、`visualContinuity`、`audioQuality`、
  `fullCandidatePlayback`

只有同时满足以下条件，`supportsEfficiencyClaim` 才为 `true`：

1. 至少 8 个同源成对项目；
2. 基线与候选都有人审；
3. 六个关键护栏逐项通过；
4. 候选正式视频编码不超过一次；
5. 可比项目实测总墙钟时间改善。

即使通过，也只支持当前样本、机器和项目类型，不外推到未测场景。

## 9. 验收矩阵

| 层级 | 完成条件 | 不能替代 |
| --- | --- | --- |
| 静态合同 | policy、DAG、schema、CLI 可验证 | 真实任务执行 |
| 定向回归 | 代表区间、增量覆盖、缓存、并行、声明门禁通过 | 真实视频质量 |
| 全量回归 | 137 项仓库测试、doctor、lint/typecheck/site 测试通过 | NLE 和人审 |
| 真实项目 | 至少 8 个同源成对项目，有完整指标与人工审片 | 未测项目 |
| 真实 NLE | Final Cut/Premiere/Resolve 实际导入、播放、导出与复核 | 代码 round-trip |
| 发布 | 当前 4K 候选完整通看、发布检查、CI/Pages/安装一致 | 测试 fixture |

## 10. 当前证据边界

V8 的实现和自动回归可以证明：区间选择、变化覆盖、DAG、资源锁、遥测、缓存审计
和声明门禁按合同工作。它不能单独证明某类 30 分钟视频已经缩短多少时间，也不能
证明审美质量提升。实际效率数字必须由后续 8 个真实项目采集；真实 NLE 往返、
4K 正常速度通看和发布平台结果仍需外部证据。
