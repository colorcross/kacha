# 架构与设计边界

## 设计目标

咔嚓咔嚓把容易混在一起的五件事拆开：

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

### `projectManifest`

把 proposal、plan、能力快照、输入、输出和 QC 报告连接起来，是统一门禁入口。

### `generatedShotPlan`

描述生成镜头的参考素材、哈希、provider/model/transport、能力快照、动作节拍、规格、授权和 QC 目标。

### `releaseReport`

记录最终文件哈希、限制和人工审片证据。自动报告不能自行生成“人工通过”。

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

## 失败即停

- 输入缺失或哈希不符：停止；
- 授权与任务路径冲突：停止；
- 必需能力缺失：降级或停止；
- 蒙版、文字层和源视频 PTS 不一致：停止；
- 生成任务状态未知：查询，不自动重提；
- 自动 QC 有线索：人工处置后再继续；
- 人工审片证据缺失：不得 release。

## 扩展方式

新增能力时优先：

1. 在 reference 中定义触发条件、机制、简单替代、失败条件和 QC；
2. 在 capability probe 中增加真实探测；
3. 在 JSON 合同中增加可验证字段；
4. 在测试中同时覆盖通过与失败路径；
5. 不把平台专有能力写成跨平台稳定能力。
