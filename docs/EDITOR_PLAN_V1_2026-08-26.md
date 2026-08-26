# OpenCut 启发的咔嚓编辑内核方案 V1

## 1. 目标

在不改变咔嚓“Agent 优先、Timeline IR 唯一事实源、FFmpeg 正式成片、QC 与人工审片分层”定位的前提下，补齐专业剪辑器应具备的精确时间、可撤销编辑、可视化调整和稳定 API。

本轮成功不是做出另一个通用 NLE，而是让用户和 Agent 能对同一份 Timeline IR 进行精确、可恢复、可追溯的调整。

## 2. 基线与事实

- 基线 commit：`432809035127e0aae6926a496964f89fca28c797`。
- 基线工作区：clean，`main` 与 `origin/main` 同步。
- Codex/Claude 安装：基线均为 `current`。
- Timeline IR 已是正式时间线唯一事实源，FFmpeg Render Graph 是正式执行路径。
- Studio 当前提供素材、内容、项目、审片和发布检查，不提供时间线调整工作台。
- Timeline IR 及周边合同仍大量使用浮点秒数。
- Mutation Delta 已提供最小 JSON Pointer 修改，但没有统一 Command、inverse delta、undo/redo 和持久历史。

## 3. 范围

### 范围内

1. Timeline Timebase V2：整数 tick、有理帧率、旧秒数兼容和迁移。
2. Typed Track Projection：从 Timeline IR 派生主画面、叠加、字幕、dialogue、BGM、SFX 和效果轨。
3. Command Journal：apply、undo、redo、历史、恢复、base SHA 并发保护和原子快照。
4. Editor API：稳定、最小、默认只读，写操作必须经过 Command。
5. Kacha Edit Workbench：打开时间线、轨道浏览、播放头、Inspector、基础位置/尺寸/时序调整、undo/redo。
6. Preview Provider 合同：明确浏览器预览与 FFmpeg 正式渲染的能力边界；没有 parity 证据时禁止成为 final provider。
7. Schema/CLI/Studio/文档/测试/安装同步。

### 范围外

- 将咔嚓改造成通用剪映或 Premiere 替代品。
- 本轮引入 Rust/WGPU 正式渲染依赖。
- 替换 FFmpeg Render Graph。
- 浏览器 IndexedDB/OPFS 成为工程事实源。
- 自动发布、上传、付费调用或真实视频生产。
- 直接复制 OpenCut Classic 代码。

## 4. 架构决定 V1

### AD-V1-01：120000 tick/s

内部时间使用整数 tick，默认 `ticksPerSecond=120000`；帧率使用 `{numerator, denominator}`。秒数只作为 UI/CLI 兼容边界。

### AD-V1-02：Timeline IR 仍是唯一事实源

轨道、片段和 Inspector 数据都是 projection，不保存第二份项目模型。所有写操作编译成现有 Mutation Delta，再通过 Command Journal 落盘。

### AD-V1-03：命令日志拥有撤销语义，不拥有业务状态机

Command Journal 保存 command、forward mutation、inverse mutation、before/after SHA、影响层、执行主体和时间。它不替代 V3 version delta、V7 orchestration、QC 或 release state。

### AD-V1-04：Studio 编辑会话使用文件和原子快照

不采用 IndexedDB/OPFS。编辑会话位于项目 `.kacha/editor/`，保存 append-only journal 和版本快照；每次写入核对 base SHA，失败时不覆盖新版本。

### AD-V1-05：浏览器预览是近似预览

Workbench 第一版使用源视频加可视化图层投影。界面必须明确标记 `approximate_preview`。正式候选仍由 FFmpeg Render Graph 生成。

## 5. 纵向切片

### S1 Timebase V2

- 新建时间核心模块和 schema。
- 支持秒、帧、tick 双向精确转换。
- Timeline IR validate/compile 生成 canonical timebase 和 tick 字段。
- 提供 `timeline migrate-timebase`，默认写新文件。
- 对 23.976/29.97/59.94、长时长、帧边界、负数和溢出做测试。

### S2 Projection 与类型系统

- 规范化 track ontology。
- 将 EDL、overlay、caption、dialogue、BGM、SFX、effect 映射为稳定 item。
- 每个 item 保留 source pointer，不产生无法回写的匿名对象。
- 无法安全编辑的对象标记 read-only 和原因。

### S3 Command Journal

- 支持 `replace/add/remove/merge`。
- 编译 inverse operation。
- apply/undo/redo 均进行 SHA 乐观锁。
- 写前建立快照，原子替换目标文件。
- 崩溃恢复通过 journal 与当前 SHA 判断，不猜测状态。

### S4 Editor API

- `editor inspect`
- `editor project`
- `editor query`
- `editor command apply|undo|redo|history`
- `editor preview-capabilities`
- CLI 与 Studio 使用同一实现。

### S5 Edit Workbench

- `/editor` 页面。
- 通过绝对路径打开本机 Timeline IR。
- 视频、播放头、时间尺和多轨投影。
- 选择 item 后显示 Inspector。
- 对允许字段生成 command；支持 undo/redo 与刷新。
- 不提供上传、发布、任意文件浏览或绕过 QC 的能力。

### S6 Preview 合同与门禁

- Provider 声明功能覆盖、确定性、许可、最终渲染资格和限制。
- `studio-canvas` 固定为 approximate、finalEligible=false。
- `ffmpeg-render-graph` 为 canonical final provider。
- 未来 WGPU provider 必须通过 golden parity 后才能提升资格。

## 6. 验收

1. 非整数帧率在 6 小时项目中帧/tick 往返无漂移。
2. 旧 Timeline 不迁移也能 validate/compile；迁移后语义不变。
3. 每条 projection item 都能追溯到 Timeline IR pointer。
4. apply → undo → redo 的文件摘要符合预期；过期 base SHA 必须阻断。
5. 编辑器不能写入当前会话之外的任意文件。
6. Workbench 页面能打开测试时间线、选择条目、修改、撤销和恢复。
7. 浏览器预览不得被宣称为正式渲染。
8. focused、full、installer、secret scan、syntax、Studio HTTP smoke 全部通过。

## 7. 回滚

- Timebase V2 是兼容扩展，删除新 timebase/tick 字段后旧路径仍可运行。
- Command 写入前保存 snapshot；失败保留 journal 与错误状态，不替换当前文件。
- Workbench 是新增 surface，可单独移除，不影响 Studio 原有页面。
- Editor API 是新增 CLI namespace，可单独回滚。
- FFmpeg 正式渲染路径不变。

## 8. 完成边界

本轮最多声明本地 `code-done` 和在全部页面/安装验证后声明 `candidate-ready`。没有真实项目长期编辑、人类正常速度成片审看和生产指标时，不声明生产效果或编辑效率提升。
