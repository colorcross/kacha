# 咔嚓精确时间与专业调整工作台最终实施方案

## 1. 最终结论

本轮建立四个相互约束的生产能力：`Timebase V2`、`Typed Timeline Projection`、`Command Journal`、`Kacha Edit Workbench`。同时把它们收敛到稳定的本地 `Editor API`，并建立 Preview Provider 的最终渲染资格门禁。

咔嚓仍是 Agent 优先的专业生产系统；Workbench 只承担“看见、校正、撤销、批准”，不承担第二套策划、渲染、QC 或发布状态机。

## 2. 冻结范围

### 必须交付

| ID | 交付 | 完成定义 |
| --- | --- | --- |
| TB | Timebase V2 | 整数 tick、有理帧率、兼容/迁移、Timeline IR 接入、边界测试 |
| PROJ | Timeline Projection | 类型化轨道、稳定 item ID、source pointer、可编辑字段 allowlist |
| CMD | Command Journal | apply/undo/redo/history、inverse、摘要链、快照、恢复、并发保护 |
| API | Editor API | inspect/project/query/command/preview-capabilities，CLI 与 Studio 共用 |
| UI | Edit Workbench | `/editor`、视频预览、轨道、播放头、Inspector、apply/undo/redo |
| PREVIEW | Preview Provider Gate | approximate/final 明确分层，未知 provider fail closed |
| GOV | 治理与交付 | 方案追踪、文档、测试、review、修复、双端同步 |

### 明确不做

- Rust/WGPU 实现：只有 provider 合同、能力探测和准入门禁；没有 golden parity 前不引入依赖。
- 浏览器正式导出。
- 通用 NLE 全功能，包括任意剪切、调色节点、插件市场和复杂曲线编辑。
- 将旧全仓库所有 seconds 字段一次性迁移。本轮只在 Timeline IR/Editor 边界建立 canonical time，并提供后续迁移接口。

## 3. 不变量

1. Timeline IR 唯一事实源；projection、UI state 和 journal 都不是第二事实源。
2. `timebase + tick` 存在时 tick 权威；兼容秒数必须与 tick 相差不超过半帧。
3. 旧 Timeline 可继续工作；迁移默认写新文件，不能覆盖源文件。
4. 正式成片仍走 FFmpeg Render Graph；Studio Canvas 永远显示近似预览标识。
5. Command 只能修改 projection 返回的 allowlisted pointer。
6. 每次写入核对 session 打开时或上一次 command 后的 SHA；并发变化直接阻断。
7. 每次写前保存内容寻址 snapshot；journal 使用前后摘要链并原子追加。
8. undo/redo 也是 Command，不直接篡改历史。
9. Editor API 不授予上传、付费、发布、任意 shell、工程外路径或跳过 QC 权限。
10. V3 version delta 继续决定重建/QC；Command Journal 只描述操作级历史。

## 4. 详细设计

### 4.1 Timebase V2

- 默认 `ticksPerSecond=120000`。
- 帧率结构为 `{numerator, denominator}`，拒绝非正值并约分。
- 支持标准 rate：24、25、30、50、60、24000/1001、30000/1001、60000/1001。
- 所有转换使用整数或有理计算；需要从秒数导入时只在边界舍入一次。
- Timeline compile 输出 canonical timebase、EDL/event tick 和由 tick 派生的 FFmpeg 秒数。

### 4.2 Projection

轨道顺序固定为：

```text
effect/adjustment
caption/spatial-text
overlay/graphic
picture-main
dialogue
bgm
sfx
```

每个 item 至少包含 `id/type/trackId/startTick/endTick/sourcePointer/editableFields/readOnlyReasons`。没有稳定源 pointer 的 item 不允许编辑。

首版允许修改：

- overlay：`start/end/x/y/width/height/opacity`；
- caption：当前已渲染 ASS/视频层整体只读；cue 时序和正文回到字幕计划修改；
- EDL：只允许 `sourceStart/sourceEnd` 且必须通过持续时间与 transition 校验；
- audio event：`time/start/end`，文件、gain、routing 首版只读。

### 4.3 Command Journal

Journal 位于与 Timeline 相邻的 `.kacha/editor/<timeline-digest>/`，包含：

- `session.json`：目标 realpath、打开身份、当前身份、timebase；
- `journal.jsonl`：append-only command 记录；
- `snapshots/<sha256>.json`：写前/写后快照；
- `recovery.json`：最后完整记录、当前文件身份和建议动作。

Journal 记录 command ID、actor、reason、base/after SHA、forward/inverse operations、affected tracks/items、required QC、previous record digest 和 record digest。

### 4.4 Editor API

CLI：

```bash
kacha editor inspect --timeline TIMELINE.json
kacha editor project --timeline TIMELINE.json
kacha editor query --timeline TIMELINE.json --track caption
kacha editor command apply --timeline TIMELINE.json --command COMMAND.json
kacha editor command undo --timeline TIMELINE.json --expected-sha CURRENT_SHA
kacha editor command redo --timeline TIMELINE.json --expected-sha CURRENT_SHA
kacha editor history --timeline TIMELINE.json
kacha editor recover --timeline TIMELINE.json --expected-sha CURRENT_SHA
kacha editor reopen --timeline TIMELINE.json --expected-sha CURRENT_SHA
kacha editor preview-capabilities
```

Studio 使用 session ID；浏览器不提交任意写入路径。服务端 session 绑定文件 realpath、文件身份和允许媒体身份。

### 4.5 Workbench

- 顶部保留 Agent 优先和 approximate preview 提示。
- 顶部打开本机 Timeline 路径；下方按固定语义顺序呈现非空轨道。
- 中央显示源视频、时间尺、播放头和轨道条目。
- 成片播放头按 EDL 映射到源视频区间；转场 overlap 只显示一个主画面并明确标为近似。
- 右侧 Inspector 显示对象类型、时间、位置、尺寸、只读原因和影响层。
- 修改后显示 required QC，不宣称成片已更新。
- undo/redo 后重新读取 current SHA 和 projection。
- 页面支持原生键盘焦点、清晰焦点、减少动效和窄屏单列编辑。

### 4.6 Preview Provider Gate

- `ffmpeg-render-graph`：`kind=canonical`、`finalEligible=true`。
- `studio-canvas`：`kind=approximate`、`finalEligible=false`。
- `webgpu`：本轮 `status=not_implemented`、`finalEligible=false`。
- 未注册 provider、能力覆盖不完整、无 current golden/parity 证据时拒绝 final。

## 5. 验证矩阵

### 静态与单元

- Node syntax、secret scan、JSON/schema、timebase 算术、pointer allowlist。

### 契约与集成

- V1/V2 Timeline 兼容；迁移幂等；compile digest 稳定。
- projection 完整且 source pointer 可解析。
- command apply/undo/redo、journal digest chain、过期 base、篡改、截断恢复。
- Studio session 不能越界读写；未知 provider 不能 final。

### 页面与目标环境

- 本机 loopback Studio HTTP smoke。
- `/editor` 静态资源、安全头、打开、修改、撤销、重做 journey。
- 键盘焦点、窄屏布局和 reduced-motion 检查。

### 全量门禁

- `node tests/run_tests.mjs --suite editor`
- `node tests/run_tests.mjs`
- `bash tests/test_installer.sh`
- `make check-static`
- `git diff --check`
- `node scripts/kacha.mjs install status --agent both`

## 6. 风险与回滚

| 风险 | 控制 | 回滚 |
| --- | --- | --- |
| Tick/秒数冲突 | 半帧一致性校验，旧格式兼容 | 去掉 V2 字段继续走旧入口 |
| 并发覆盖 | base SHA + session identity | 阻断并要求重新打开 |
| Journal 损坏 | digest chain + snapshot + expected current SHA | 归档原状态后从最后有效 snapshot 恢复 |
| UI 形成第二状态 | projection-only，无独立保存模型 | 移除 `/editor` 不影响 Timeline |
| 预览误导 | 强制 approximate 标签和 provider gate | 回退 FFmpeg 区间预览 |
| 范围膨胀 | 只开放 allowlisted 基础字段 | 未支持字段保持只读 |

## 7. 完成声明

代码、测试、页面 journey、文档、复审和双端安装全部通过后，可以声明本地候选完成。没有真实视频项目的长期人工编辑对比与最终成片正常速度审看时，不声明工作效率或成片质量已提升；Rust/WGPU 仍是后续独立候选。

## 8. 交付范围修订（2026-08-26）

用户在完成本地实施后明确追加授权：重新 review、修复全部发现、提交并 push 当前
`main` 到已配置 GitHub origin。该修订只扩大 Git 交付范围，不授权创建 GitHub
Release、正式发布成片、付费调用或生产结果声明。提交前必须重跑本方案验证矩阵；
push 后必须回读远端 commit，并以远端 identity 而不是命令退出码作为完成证据。
