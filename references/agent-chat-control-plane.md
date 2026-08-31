# Agent 对话控制面

咔嚓默认由 Codex 或 Claude Code 在聊天中操作。用户说自然语言，Agent 在后台
维护项目合同、短引用、增量、素材索引和任务状态；命令是 Agent 的内部执行
接口，不要求用户记忆，也不把工作重心转移到生产台。

## 对话优先原则

1. 用户先描述目标、时间位置、对象或结果，不要求填写工程表单。
2. Agent 把描述解析为已存在的项目对象；存在歧义时才请求最小确认。
3. 修改 JSON 合同优先提交小 mutation，不重写整份 timeline 或 manifest。
4. 搜索本机素材只返回前几个有证据候选，不把完整目录和索引塞进上下文。
5. 长耗时工作提交后台任务并创建 placeholder；Agent 可以继续完成不依赖该
   结果的工作。
6. 用户看到的是自然语言进展和必要的短引用，不是内部命令日志。
7. 生产台仍可用于集中配置，但不是默认入口，也不是完成剪辑的必要条件。

## 1. Mutation Delta

用户说“把 2:10 的卡片往右移”“只降低 BGM”时，Agent 先解析对象引用，
再建立最小 mutation：

```json
{
  "schemaVersion": "1.0",
  "baseSha256": "当前合同真实 SHA-256",
  "operations": [
    {
      "op": "replace",
      "path": "/visual/overlays/3/x",
      "value": 1240
    }
  ]
}
```

支持 `add / replace / remove / merge`；单次最多 200 个操作。应用前核对
`baseSha256`，默认写入新文件，覆盖当前合同必须显式 `--in-place`：

```bash
node scripts/kacha.mjs delta apply timeline.json mutation.json \
  --write timeline.next.json --output mutation-delta.json
```

命令只把变化摘要、对象短引用、受影响层和下一批 JSON Pointer 返回给 Agent。
完整 after snapshot 保存在文件中，但不回填提示词。`delta diff` 可比较任意
两个 JSON 合同；它是操作级变化证据，不替代 v3 的版本级
`version-delta.json`。版本 delta 决定重建和 QC；mutation delta 降低单次
工具交互和上下文 Token。

终端默认只返回前 20 个变化，并通过 `responseWindow` 明确报告返回数、遗漏
数和是否截断。只要终端窗口发生截断，脚本会自动把完整变化报告写在 after
合同旁边并返回 `fullReport`；不得出现“实际有更多变化但 `truncated=false`”
或没有完整报告的静默截断。

## 2. 本地语义素材搜索

素材索引只使用本机路径、sidecar、文稿、OCR、Apple Vision 标签和显式
catalog，不上传原始图片或视频：

```bash
node scripts/kacha.mjs media index \
  --root /absolute/path/assets \
  --catalog media-catalog.json \
  --visual-evidence visual-evidence.json \
  --output .kacha/media-index.json

node scripts/kacha.mjs media search .kacha/media-index.json \
  --query "城市夜景中的地标建筑" --limit 5
```

`hybrid_local_v2` 使用中英文分词、同义概念扩展、字段权重和证据等级排序；
macOS 还会调用本地 Apple NaturalLanguage sentence embedding，对没有共同
关键词但语义接近的描述做句向量排序。句向量模型、查询和素材文本都留在
本机。非 macOS、Swift 编译器或句向量不可用时，输出必须明确标记
`lexical_fallback` 和 limitation，不能把回退结果描述成向量语义命中。
描述、标签、转写和本地视觉证据权重高于文件名；只有文件名的素材会明确标记
`filename_only`，不能冒充可靠画面语义。搜索结果返回 `@asset:ID`、路径、
区间、许可和匹配理由。插镜前仍要检查语义、构图、运动方向、许可与前后
handle；搜索命中不等于已授权使用。

索引达到 `--max-files` 时，`summary.scan.truncated=true` 并返回未完成扫描
提示。Agent 必须提高上限或缩小 root；不完整索引不能静默当作全量素材库。

Apple Vision 视觉证据现在额外记录置信度达标的画面分类标签。非 macOS 环境
或分类器不可用时，索引继续使用已有文本证据并公开 evidence gap，不调用云端
兜底。

## 3. 异步任务与 Placeholder

ASR、人声分离、蒙版、生成镜头、Beauty、FaceFusion、长区间渲染和全片 QC
可作为后台任务：

```bash
node scripts/kacha.mjs jobs submit \
  --project-root PROJECT_DIR \
  --kind generated-media \
  --expected-output output/shot-03.mp4 \
  -- GENERATOR ARG...
```

命令立即返回 `@job:ID` 和 `.kacha/placeholders/ID.json`。任务使用参数数组和
`shell=false`，不会把持久化命令解释为 shell；包含 API key、token、password、
Authorization header、Bearer/Basic token、URL userinfo 或常见凭证前缀的
参数会被拒绝。密钥只从受控环境或权限正确的 secrets 文件读取，不能进入
`job.json`。项目 root、cwd 和预期产物使用真实路径边界校验，项目内符号链接
不得把产物或 cwd 引到项目外。任务默认至少声明一个 `--expected-output`；
纯状态任务必须显式使用 `--allow-no-output`。任务状态为：

```text
queued → running → succeeded
              ├→ failed → resume
              ├→ interrupted → resume
              ├→ cancelling → cancelled
              └→ cancellation_failed
```

只有进程成功、全部 `expectedOutputs` 存在并记录真实文件身份后，placeholder
才从 `pending/running` 变为 `ready`。正式时间线不能引用未 ready 的
placeholder。stdout/stderr 写入任务目录，不回填上下文；Agent 只读取
`jobs status` 的紧凑状态。取消任务是显式操作，不能因对话结束自动取消。

取消采用两阶段协议：先把当前 run 标记为 `cancelling`，再发送 SIGTERM，
宽限期后对仍存活进程发送 SIGKILL，确认进程退出后才能落 `cancelled`。Worker
的完成写入绑定 `activeRunId`，不得覆盖 `cancelled` 等终态。恢复失败任务时，
旧的部分产物先移动到任务目录的 `partial/attempt-*` 留证，再启动新 attempt，
不能让旧文件冒充新任务产物。

提交时还会冻结 `submissionDigest`：job id/ref、命令 argv 与 argvDigest、cwd、
预期产物、placeholder、日志和 pid 路径必须与 `.kacha/jobs/ID/` 目录合同一致。
`status/list/cancel/resume`、worker 启动、每次 worker 状态写入和生产台观察都会
重新验证；持久化后改命令或把路径指向项目外会阻断执行，而不是按新内容续跑。

Timeline IR 会自动发现项目 `.kacha/placeholders` 中对输入素材的声明，也支持
素材显式携带 `placeholder.path/ref`。只要匹配到后台任务，编译前必须验证
`state=ready`、outputs 中存在当前真实路径和 SHA-256；pending、failed、
cancelled、缺少产物身份或 hash 失效均直接阻断。

## 4. 对象级 `@` 引用

Agent 从 timeline、media index、artifact index、job 和其他 JSON 合同建立
短引用：

```bash
node scripts/kacha.mjs refs index timeline.json media-index.json \
  --output .kacha/object-index.json
node scripts/kacha.mjs refs resolve @overlay:card-1 \
  --index .kacha/object-index.json
```

支持的常见类型包括 `asset / clip / range / caption / overlay / sfx / effect /
artifact / version / job`。解析结果返回 owner、真实 SHA、JSON Pointer、
对象 digest 和小摘要，默认不返回完整 value。owner 中其他对象变化但当前
pointer 的 object digest 未变时仍可解析，并标记 `ownerChanged=true`；当前
对象或 pointer 变化后旧索引会变为 `stale_object`，必须重建，不能按名称
猜测。

不同 owner 或 pointer 产生相同基础引用时，所有冲突对象都使用
`owner + pointer` 的确定性后缀；基础引用本身不再分配给“第一个输入”。
因此交换索引输入顺序不会改变引用指向，歧义基础引用会返回 `not_found`，
Agent 必须使用带后缀的唯一引用。

用户可以直接说“把 `@overlay:card-1` 往右移”，也可以继续使用自然语言；
Agent 负责将“刚才的城市镜头”“第 3 个弹窗”“2:10 那句字幕”映射为引用。
短引用用于消歧和缩小读取范围，不要求用户了解内部对象类型。

## 5. Skill 安装与同步状态

源码仓库与 Codex/Claude Code 用户级安装是独立副本，不会自动传播。Agent
使用只读状态检查：

```bash
node scripts/kacha.mjs install status --agent both
```

状态只构建公开 bundle、执行隐私扫描并比较摘要，不运行完整回归，也不修改
安装。输出为 `current / out_of_sync`，同时报告 source ref、dirty 状态、
bundle digest 和目标路径。

修改完成后必须先跑受影响测试和全量门禁，再由 Agent 显式同步：

```bash
node scripts/kacha.mjs install sync --agent both
node scripts/kacha.mjs install sync --agent both --apply
```

`sync` 默认 dry-run；`--apply` 才会备份旧目录、原子替换并核对 Codex/Claude
bundle hash。项目配置、用户配置、私有素材和密钥不进入安装 bundle，也不能
被同步覆盖。当前安装已经包含私有 overlay 时，未传同一 `--overlay` 的 apply
会直接阻断，不能用公开 core 静默抹掉本机能力。同一台机器的 apply 使用
`~/.kacha-install.lock` 互斥；第二个并发同步必须失败，不能让两个备份/替换流程
交错后留下来源 ref 与 bundle 不一致的安装。

## 6. 精确时间、Command Journal 与调整工作台

Timeline IR 的编辑边界使用 `Timebase V2`：默认每秒 120000 个整数 tick，帧率
使用分子/分母。旧版秒数字段继续兼容；同一字段同时存在 tick 和 seconds 时，
tick 权威，二者相差超过半帧会失败关闭。迁移默认写入新文件：

```bash
node scripts/kacha.mjs timeline migrate-timebase \
  --plan timeline.json --output timeline.v2.json
```

需要人工精调时可打开本地 `/editor`，或由 Agent 使用稳定 Editor API：

```bash
node scripts/kacha.mjs editor inspect --timeline timeline.json
node scripts/kacha.mjs editor project --timeline timeline.json
node scripts/kacha.mjs editor query --timeline timeline.json --track overlays
node scripts/kacha.mjs editor command apply --timeline timeline.json \
  --command command.json
node scripts/kacha.mjs editor command undo --timeline timeline.json --expected-sha CURRENT_SHA
node scripts/kacha.mjs editor command redo --timeline timeline.json --expected-sha CURRENT_SHA
node scripts/kacha.mjs editor recover --timeline timeline.json --expected-sha CURRENT_SHA
node scripts/kacha.mjs editor reopen --timeline timeline.json --expected-sha CURRENT_SHA
```

工作台只读取 Timeline Projection；它没有第二份时间线模型。每个可编辑条目都
保留 source JSON Pointer 和字段 allowlist。写操作绑定当前 Timeline SHA，编译
为共享 Mutation 原语，写前保存内容寻址 snapshot，并把 forward/inverse
operation、影响轨道、所需 QC 和摘要链写入 `.kacha/editor/`。外部修改导致 SHA
变化时立即阻断。journal 被篡改或截断时先输出 recovery contract；只有显式
`recover + expected-sha` 才恢复最后有效 snapshot 并归档原状态。合法外部修改使用
`reopen + expected-sha` 建立新 session，不能让调用者传入当前 SHA 绕过旧 session。

Studio Canvas 按 EDL 把成片播放头映射到源片，并显示图层投影；转场 overlap 只
选一个主画面，固定为 `approximate_preview`，不能导出正式成片。
`ffmpeg-render-graph` 仍是 canonical final provider，但 final eligibility 还要
通过当前 FFmpeg runtime probe。WebGPU 在没有 current golden parity 之前保持
`not_implemented/finalEligible=false`。

## MCP 客户端接入

Codex 与 Claude Code 可通过本地 `stdio` MCP 使用同一控制面：

```bash
node scripts/kacha.mjs mcp-config show --client codex --root /absolute/project
node scripts/kacha.mjs mcp-config show --client claude --root /absolute/project
node scripts/kacha.mjs mcp serve --root /absolute/project
```

MCP tool 只返回紧凑 projection、状态和证据，不读取项目根目录外的路径。任何
写操作都要求当前 Timeline SHA，并继续进入 Command Journal、快照、undo/redo 和
required QC。MCP 注册不授予上传、付费、正式渲染或发布权限。

## Agent 默认编排

一次典型对话任务按需执行：

```text
自然语言需求
  → install status（只在开发态或怀疑版本漂移时）
  → refs index / parse（已有项目）
  → media search（需要本机素材时）
  → mutation → delta apply（小合同修改）
  → editor command journal（需要可撤销的 Timeline 调整时）
  → jobs submit（耗时任务）
  → 继续处理无依赖步骤
  → jobs status → placeholder ready
  → compile-change / Timeline IR / Render Graph
  → 变化层 QC + 最终完整 QC + 人工审片
```

Agent 每次只在聊天中汇报：做了什么、影响哪些对象/层、后台任务状态、需要
用户判断的最小问题。不要粘贴完整索引、完整 timeline、后台日志或未变化的
合同。
