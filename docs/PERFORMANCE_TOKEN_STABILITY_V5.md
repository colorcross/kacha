# 性能、Token 与弱模型稳定生产（V5）

本轮优化的目标不是用更快的参数换取更差的成片，而是减少重复分析、重复推理
和重复编码。所有收益必须来自运行指标、缓存证据和当前输出 QC，不能凭感觉
宣称。

V8 已把本章原则升级为可执行的风险、区间、DAG、缓存审计和效率声明合同。
新项目应同时使用
[V8 质量不降级效率](QUALITY_PRESERVING_EFFICIENCY_V8.md)，不要只手工挑区间。

## 时间主要花在哪里

每个项目的占比不同，咔嚓不写死虚假的百分比。按实际工作流，耗时来源通常按
以下顺序出现：

1. **正式视频编码**：4K、复杂蒙版、Beauty、多个动效和长时长会放大成本；
2. **高成本分析**：Demucs、人声处理、Whisper、Apple Vision 蒙版/跟踪；
3. **生成或下载素材**：受模型排队、网络、付费重试和人工筛选影响；
4. **重复探索渲染**：每改一个参数就整片导出，是最容易消除的浪费；
5. **串行等待和 I/O**：多个 4K 编码或 MPS 任务互相争抢，往往比并行更慢；
6. **模型反复重建上下文**：对话过长、整份逐词转写和全部 reference 重复
   进入提示词，会增加等待但不增加质量。

用真实项目测量：

```bash
node scripts/kacha.mjs metrics run \
  --stage preview_render --project-root PROJECT_DIR \
  --model-tier economy --reference-tokens 402 -- \
  COMMAND ARGS...

node scripts/kacha.mjs metrics summarize --project-root PROJECT_DIR
```

报告写入 `.kacha/metrics/`，按阶段统计墙钟时间、Token、缓存命中、渲染秒数、
视频编码次数和产物，并列出时间与 Token 主导阶段。完整 stdout/stderr 留在
文件中，agent 只接收紧凑摘要；命令中的 key/token/password 会脱敏。Token
优先从子进程 JSON 的 `usage`/`metrics` 等标准字段自动提取；只有无法取得
真实计量时才使用 packet/reference 估算，并明确标注 `estimated` 或
`unavailable`，不能把人工参数当成唯一统计来源。

## 提速方案

### 统一时间线，一次正式编码

`timeline.ir.json` 是编辑事实源，`render-graph.json` 是确定性执行图。EDL、
画面呼吸、叠加层、字幕、人声、BGM、SFX 和 stems 在一个 FFmpeg filter
graph 中完成。

```bash
node scripts/kacha.mjs timeline validate --plan timeline.json
node scripts/kacha.mjs timeline compile --plan timeline.json
node scripts/kacha.mjs render PROJECT.json
```

正式视觉版本最多一次完整视频编码；输出与 graph digest 完全一致时直接复用，
视频编码数为 0。最终渲染从最高质量源构建，不从代理放大。graph digest 不只
包含 source 和参数，还冻结 proposal/edit plan、overlay、字幕、dialogue、
BGM、SFX 与字体目录的真实内容 SHA；素材在同一路径原地替换也会失效。

### 代理和局部预览

探索阶段显式使用独立输出：

```bash
node scripts/kacha.mjs timeline render \
  --plan timeline.json --mode preview \
  --range-start 42.5 --range-end 49.0 \
  --output preview/42.5-49.0.mp4
```

局部预览会把 EDL、画面事件、字幕层、外部 dialogue、BGM 和 SFX 一起裁到
同一区间，重置 PTS，并按 `preview.maxWidth` 限制代理分辨率。局部预览不生成
正式 stems，也不能占用正式成片路径。代理缩放时，覆盖层的位置和尺寸必须
随画布等比缩放；任何越出正式画布的覆盖层都在编译阶段失败。

v3 的 L2 修改继续由 `handleFrames` 自动扩展前后检查范围；纯音频修改
stream-copy 视频，封面修改不处理视频。

### 内容指纹缓存

缓存键包含源文件 SHA-256、实现文件 SHA-256、操作版本、参数和输出 schema。
命中后仍验证文件/目录大小与 SHA-256，已有不一致输出不会被覆盖。

```bash
node scripts/kacha.mjs cache inspect --project-root PROJECT_DIR
node scripts/kacha.mjs transcribe INPUT.mov --output transcript.json
node scripts/kacha.mjs masks INPUT.mov --output-dir masks
node scripts/kacha.mjs beauty render INPUT.mov ... --output beauty.mov
node scripts/kacha.mjs styleframe render --scene info_single --output frame.svg
node scripts/kacha.mjs generated-cache run \
  --plan generated.json --shot SHOT_ID --output shot.mp4 -- GENERATOR...
```

Demucs、ASR、蒙版/跟踪、Beauty、样式帧和生成素材都接入同一缓存。Demucs
与 ASR 键额外冻结真实模型权重/模型目录内容 SHA、运行时版本、启动器和服务
实现 SHA；指纹无法解析时绕过缓存，升级权重或服务后不会误用旧 stem/转写。
生成素材
命中时不会再次执行付费命令；纯本地交付路径会被归一化，因此同一镜头换输出
目录也能复用。缓存总量受 `maximumBytes` 约束；容量不足时明确停止，不静默
删除高价值返工资产。

### 资源调度

跨进程资源槽把 CPU、MPS、视频编码、网络和 I/O 分开。默认锁池位于用户级
runtime/cache 目录，同一台主机上的不同项目也共享容量；同一时间只允许一个
重型 MPS 任务和一个视频编码，避免 4K 编码或模型互相抢内存：

```bash
node scripts/kacha.mjs resources status --project-root PROJECT_DIR
node scripts/kacha.mjs resources run \
  --project-root PROJECT_DIR --resource mps -- COMMAND
```

`--project-root` 用于指标归属，不再创建彼此隔离、可以互相抢 GPU 的项目锁池。

## Token 主要花在哪里

1. 主 `SKILL.md` 与多个大 reference 被重复加载；
2. 完整 ASR 文本、逐词时间戳和原始文稿一起进入上下文；
3. 每轮返工复制旧 proposal、edit plan、报告和长对话；
4. 为每个效果让模型从完整效果库重新搜索；
5. 工具把 FFmpeg/模型完整日志返回给模型；
6. 失败后从头分析，而不是从项目状态和错误码继续。

## 降低 Token 而不降低质量

### 阶段 packet

上下文读取拆为 `inventory / content / edit / visual_audio / release` 五种
packet。它们只负责路由信息，不替代 v2 的十三阶段状态机。每个 packet 只读取
一个紧凑合同，reference 目标不超过 12,000 tokens，完整 packet 不超过
16,000 tokens：

```bash
node scripts/kacha.mjs prepare \
  --task source_edit --stage edit --model-tier economy \
  --project PROJECT.json --output edit-packet.json
```

硬合同仍在代码和门禁中，不靠截断文本省 Token。

### 转写窗口

完整逐词 JSON 留在文件，不进入 packet。先取无正文索引，再按 90 秒窗口读取：

```bash
node scripts/kacha.mjs transcript index transcript.json
node scripts/kacha.mjs transcript slice transcript.json \
  --start 90 --end 180
```

单次最多 180 秒。`prepare --transcript` 只内联最多 20 个低置信度片段；
需要正文时用 `--transcript-window START:END`。字幕仍以音频为主、文稿校准，
只是把处理改为可审计分窗，不删除内容证据。

### 规则检索和状态持久化

模型不读取完整效果库，只给结构化信号，脚本返回每条规则 1–3 个候选：

```bash
node scripts/kacha.mjs rules query \
  --stage edit --modules cut,transition \
  --signals '["information_change","connection"]' --limit 3
```

项目状态、决策、问题、证据哈希和下一步写入 `.kacha/project-state.json`：

```bash
node scripts/kacha.mjs state snapshot PROJECT.json
node scripts/kacha.mjs state record .kacha/project-state.json \
  --stage fine_cut --status complete --evidence fine-cut-evidence.json
```

v2 的十三阶段按顺序推进，每个完成项都绑定当前文件 `{path, sha256}`。方案、
时间线、能力或媒体合同变化会重置旧证据；只回填输出 SHA 不会误重置。长任务
恢复时读取状态文件，不从整段对话重建。

## 弱模型如何稳定生产

弱模型只负责它擅长的部分：

- 解释用户意图、内容重心和创意理由；
- 从 1–3 个已筛选配方中选择；
- 比较短预览或样式帧；
- 解释证据并提出最小修改。

代码负责：

- 文件身份、媒体规格、缓存、状态和依赖；
- 切镜理由、相邻景别、字幕/头部安全区等硬规则；
- Timeline IR、Render Graph、编码和资源锁；
- 技术 QC、版本证据和 release gate。

相同 cues、规则版本、配置和 seed 会生成相同 decision digest。低置信度、
规则冲突或复杂创意判断只允许局部预览，并升级给更强模型或人工；不得直接
进入 final，也不得静默换后端。

```bash
node scripts/kacha.mjs rules compile \
  --cues semantic-cues.json --model-tier economy \
  --seed 7 --output decision-plan.json
node scripts/kacha.mjs rules apply \
  --decision-plan decision-plan.json \
  --timeline timeline.json --output preview-timeline.json --preview-only
```

## 验收

```bash
node tests/run_tests.mjs --report /tmp/kacha-tests.json
node scripts/kacha.mjs golden real \
  --video REAL_VIDEO --output-dir /tmp/kacha-golden \
  --start 15 --duration 6 --mode final
node scripts/kacha.mjs optimization-audit run \
  --test-report /tmp/kacha-tests.json \
  --golden-report /tmp/kacha-golden/golden-report.json \
  --asr-report /tmp/kacha-asr-canary.json \
  --install-report /tmp/kacha-install-verification.json \
  --output /tmp/kacha-optimization-audit.json
```

真实 Golden 在真人媒体上同时执行 EDL、运镜、overlay、字幕、BGM、SFX 和
dialogue/BGM/SFX/mix stems。QC 除响度和覆盖率外，还重建组件混音，并验证
最终视频解码音频确实匹配 mix stem，专门阻断“stem 有音乐、成片漏混”。

审计不相信外部 JSON 自报的 `pass`：先核对 Golden 源/输出/graph/manifest/QC
哈希、真实 ASR 输入与模型/服务指纹、Codex/Claude 当前安装 digest，再自行
重跑仓库当前完整回归。随后检查一次正式编码、精确复用零编码、源几何、A/V
一帧内漂移、无静默 fallback、五种 packet Token、预热高价值缓存命中率、
economy 决策、主机级资源串行化和 Beauty 默认关闭。四份当前证据缺一不可。
工程审计通过仍不替代每条正式成片的正常速度通看、耳机/手机试听与发布批准。
