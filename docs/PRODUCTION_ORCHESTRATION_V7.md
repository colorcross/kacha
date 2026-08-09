# 咔嚓 V7：可恢复生产编排与真实质量闭环

## 结论

V7 不增加一套剪辑理论，也不把咔嚓包装成完整 NLE。它把已经存在的 V2
十三阶段、V3 增量、V6 全片导演、Jobs、Timeline IR、Render Graph、技术 QC
和人工审片收束成一条用户可连续完成、失败后可恢复、版本可证明的生产链。

V8 在该编排线上增加质量不降级效率合同：`start` 自动生成风险、代表区间、
依赖波次和缓存证据；`run/resume` 刷新当前证据。V8 不改变 V7 的人工里程碑和
完整发布验收，详见
[QUALITY_PRESERVING_EFFICIENCY_V8.md](QUALITY_PRESERVING_EFFICIENCY_V8.md)。

用户只面对四个里程碑：`方案确认 → 首剪确认 → 成片审阅 → 交付与返工`。
十三个内部阶段、文件哈希、缓存、任务和质量证据继续保留，但由编排器维护，
不再要求用户手写 manifest 或依赖对话历史恢复项目。

## 一、范围与完成定义

V7 完成需要同时满足以下证据，不能以其中一项代替其他项：

| 范围 | 完成证据 |
| --- | --- |
| 运行版本 | 项目冻结源码/安装 bundle 身份；生产运行时不一致直接阻断 |
| 新项目 | 生产台或 CLI 能建立独立、可恢复项目；新项目默认启用 V6 |
| 内容生成 | 文稿、书籍、笔记或主题可以在没有源视频时建立项目 |
| 编排 | `start/run/resume/status` 使用同一状态文件，安全步骤可自动推进 |
| 阶段 | 十三阶段均有 owner、输入、输出、执行方式、失败和恢复合同 |
| 素材 | asset gap 转为可分配、可回填、可重建的素材待办 |
| 审片 | 语义决策和十一项 release review 在同一工作台完成 |
| 返工 | `adjust/reject` 可生成受控 change request/V3 delta，不覆盖基线 |
| 指标 | 每个项目自动记录真实耗时、编码、缓存和人工修正指标 |
| NLE | 导出/导入继续 candidate-only，并有实机验收记录模板与门禁 |
| 交付 | 只有当前媒体、自动 QC、人工证据与 release gate 同时通过才完成 |
| 发布 | 上传、平台发布和不可逆操作继续需要独立明确授权 |

## 二、目标生产链

```text
自然语言 / 生产台 / CLI
  → start：冻结输入、栏目、风格、运行版本与授权边界
  → planning：proposal、edit plan、V6 director、素材待办
  → first_cut：结构粗剪、连接、精剪和代表区间
  → finishing：视觉、字幕、混音、封面和统一时间线
  → review：正常速度语义审片 + 十一项发布审片
  → delivery：当前版本 gate-release + 本地交付包
  → change request：自然语言反馈编译为 V3 增量
```

`run` 只自动执行 `safeToAutoExecute=true` 的确定性步骤。Agent、render engine、
human 或 external NLE 任务必须保持明确 owner；缺少真实证据时停在当前步骤，
不能写成完成。

## 三、项目目录和唯一状态

```text
PROJECT/
├── production-brief.json
├── kacha.config.json
├── contracts/
│   ├── project-manifest.json
│   ├── edit-proposal.json
│   ├── edit-plan.json
│   ├── director-plan.json
│   ├── asset-gap-plan.json
│   └── timeline-ir.json
├── .kacha/
│   ├── orchestration.json
│   ├── project-state.json
│   ├── project-events.jsonl
│   ├── asset-inbox.json
│   ├── jobs/
│   ├── review/
│   └── metrics/
├── previews/
└── output/
```

`.kacha/orchestration.json` 只保存编排视图和引用；V2 状态、V6 证据、Timeline
和交付文件继续各自保存真实合同。状态由文件推导并绑定 digest，不复制一套可与
事实分叉的“完成百分比”。

## 四、运行版本门禁

项目启动时记录：

- 当前执行目录、Git ref、dirty 状态；
- 公开 bundle digest；
- Codex/Claude 安装 ref 和 digest；
- 项目配置 digest；
- `development` 或 `production` 运行模式。

生产模式要求源码 clean，且目标安装与当前 bundle 一致。开发模式允许 dirty 或
未同步安装，但只能生成 preview/scaffold，不能进入 `gate-release`。运行版本发生
变化后，`resume` 先重新验证合同和受影响证据，不能静默沿用旧实现结论。

## 五、四个用户里程碑

### 1. 方案确认

内部覆盖 `inventory / transcript_structure`，并冻结栏目、期号、内容主问题、
真实输入、唯一开场、四风格语法、V6 导演预算和素材待办。脚本起步项目在此阶段
生成内容结构、真人录制/配音与拍摄任务，不伪造已经存在的视频。

### 2. 首剪确认

内部覆盖 `rough_cut / dialogue_preprocess / connection_qc / fine_cut`。先提交开场、
典型信息段、复杂视觉段和结尾等代表区间，正常速度确认后才冻结 picture lock。

### 3. 成片审阅

内部覆盖 `visual_packaging / subtitles / final_mix / cover / preview_render / final_qc`。
语义决定、自动技术线索和十一项人工检查进入统一 Review Hub；每条调整或拒绝都
要求解决证据，并可编译为最小增量。

### 4. 交付与返工

内部覆盖 `release_package`。完整 gate 通过后生成本地交付包；后续反馈进入 V3，
纯音频、纯画面和封面修改继续遵守 stream-copy/零视频编码边界。

## 六、阶段 recipe 合同

每个阶段 recipe 至少包含：

```json
{
  "id": "transcript_structure",
  "milestone": "proposal",
  "owner": "agent",
  "execution": "command|agent_task|render_engine|human|external_nle",
  "prerequisites": [],
  "inputs": [],
  "outputs": [],
  "command": null,
  "safeToAutoExecute": false,
  "failurePolicy": "fail_closed",
  "resumePolicy": "reuse_current_evidence",
  "qc": [],
  "evidenceRequired": true
}
```

编排器不得为 `agent_task`、`human` 或 `external_nle` 伪造 command；它只生成紧凑
任务包和预期证据。确定性命令失败时保留 stderr 路径、错误码和重试边界。

## 七、素材待办箱

`asset-inbox.json` 从当前 director/asset gap 确定性生成，每项显示：

- 语义拍、使用区间和叙事职责；
- `local_candidate / generated_visual_candidate /
  user_or_source_evidence_required`；
- 所需规格、许可、来源和真实/示意边界；
- owner、状态、当前候选和阻断原因；
- 回填文件身份；
- 受影响的 Timeline 对象与重建范围。

生成候选不代表已授权外传或付费。回填后必须重建媒体索引和 asset gap plan，
不能直接把文件路径写进 Timeline 绕过许可证据。

## 八、统一 Review Hub

Review Hub 同时展示：

1. V6 高影响语义决定；
2. 自动技术 QC 线索；
3. 十一项 release review；
4. 当前 Jobs、编码、缓存、磁盘和证据完整性；
5. 调整/拒绝产生的 change request 与候选版本。

播放器固定正常速度并带声音。语义 `accept` 只证明该决定可进入候选，不等于
release pass；十一项人工检查只有当前媒体、reviewer、时间和证据齐全时才通过。

## 九、内容生成路径

`content_generation` 接受 `--script`（脚本、书稿、笔记或其他文本文件）或
`--topic`，不要求源视频。启动结果是内容/拍摄项目，不是假成片：

```text
内容输入 → 内容结构/事实任务 → 真人表达与镜头计划 → 素材待办
         → 录制/生成结果回填 → source_edit
```

四栏目分别采用项目级 IP 方案规定的栏目结构、时长、证据和镜头语言；栏目名与
期号属于交付合同，旧栏目名不得恢复。

## 十、指标和真实评测

项目默认采集：

- 首个可播放预览耗时；
- 首稿可用度与候选接受率；
- 每成片分钟人工修正分钟数；
- cut/insert/effect/subtitle/BGM/SFX 的接受、调整和拒绝；
- 严重语义损坏、连接拒绝、字幕修正和风格违规；
- 完整视频编码次数、渲染范围和高成本缓存命中；
- 人工审片耗时和阻塞停留时间。

建议验收目标需先建立真实基线：完整视觉版本最多一次编码；预热高价值缓存复用
不低于 80%；严重语义损坏、无授权素材和源文件覆盖为零；其余质量目标只以至少
8 个同源人工复核项目的成对结果判断，不预先宣称提升。

评测矩阵至少覆盖四栏目、四风格、横竖画幅、长短视频和手机/耳机审片。合成
fixture 只证明代码，不进入真实质量样本。

## 十一、NLE 实机验收

OTIO/FCPXML/CMX 合同保持不变，新增实机验收记录：应用与版本、导入时间线、
clip/semantic/decision ID、帧率、源片绑定、往返候选、差异、reviewer 和证据。
Final Cut Pro、Premiere、DaVinci Resolve 未分别完成真实工程往返前，只能说
“交换合同通过”，不能说“三大 NLE 已验证”。

当前工具入口为 `nle-app detect/session/record/validate`。在本机未检测到受支持
应用时，状态为 `unavailable`，实机通过证据保持未完成。

## 十二、实施顺序

1. 版本锁、V6 默认和项目 scaffold；
2. `start/run/resume/status` 与阶段 recipes；
3. 生产台项目页、Jobs 和里程碑；
4. 统一 Review Hub 与 release evidence；
5. script-first content generation；
6. 素材待办箱；
7. 指标、真人评测队列和 NLE 实机记录；
8. 中英文文档、官网、安装同步与真实项目验证。

任何阶段的代码、测试或页面通过，都不能替代剩余阶段的真实证据。
