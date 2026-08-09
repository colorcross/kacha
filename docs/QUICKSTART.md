# 快速开始

推荐先用 V7 编排器建立一个本地、可恢复的项目。后文的手工模板路径仍用于
调试和理解底层合同，模板不是已授权的真实项目。

需要长期复用字幕、声音、美颜或节奏偏好时，先按
[配置说明](CONFIGURATION.md)创建用户/项目配置。`prepare` 会把适用的结构化
参数和自然语言要求带入当前执行包。

## 先用本地生产台创建项目（推荐）

不想手写配置时，启动只监听本机的生产页面：

```bash
node scripts/kacha.mjs studio serve
```

从顶部选择“剪辑视频”或“从脚本开始”。视频路径按“素材 → 风格 → 声音 →
效果 → 交付”完成配置；内容路径先生成主线、待核事实、录制方案和素材清单。
项目建立后进入 `/project` 查看四个里程碑与唯一下一步，进入 `/review` 完成
语义决策和十一项发布审片。效果目录支持搜索，
当前项目的人声、BGM、Beauty v2 与效果密度可以独立覆盖，不会污染可复用
风格。点击“检查配置”确认源视频、输出目录、授权字体、设计系统和效果均可
执行后，页面会生成独立项目目录及
`production-brief.json`、`kacha.config.json`、`AGENT_INSTRUCTIONS.md` 和
`.kacha/orchestration.json`。
默认“行者风”使用已授权的真正金陵体、`warm-soft` 人声和克制的暖色视觉；
Beauty v2 默认关闭。页面不上传素材、不覆盖源文件，也不代表已经完成剪辑。
完整说明见[本地视频生产台](../references/production-studio.md)。

## 最短可恢复入口

已有视频：

```bash
node scripts/kacha.mjs start --source /path/to/source.mov \
  --project-root /path/to/project
node scripts/kacha.mjs status /path/to/project
node scripts/kacha.mjs run /path/to/project --confirm-execute
# 退出或中断后
node scripts/kacha.mjs resume /path/to/project --confirm-execute
```

项目创建后会同时生成 V8 效率合同。完成当前转写/cues 后刷新代表区间和高成本
缓存适用项：

```bash
node scripts/kacha.mjs efficiency plan /path/to/project \
  --cues /path/to/current-cues.json \
  --applicable-cache-kinds asr,source_separation,mask
node scripts/kacha.mjs efficiency validate \
  /path/to/project/.kacha/efficiency-plan.json
```

首剪先审开场、典型信息、复杂视觉和结尾；这些区间只用于减少试错，最终候选
仍需完整正常速度通看。详见
[V8 质量不降级效率](QUALITY_PRESERVING_EFFICIENCY_V8.md)。

只有脚本或选题：

```bash
node scripts/kacha.mjs start --script /path/to/script.md \
  --task content_generation --show book-talk \
  --project-root /path/to/content-project
node scripts/kacha.mjs run /path/to/content-project --confirm-execute
node scripts/kacha.mjs content status /path/to/content-project
```

内容项目会产生 `content-spine`、`fact-check-tasks`、`recording-plan`、
`asset-inbox` 和 `source-edit-handoff`。只有事实、素材和内容批准全部有证据后，
才可用 `handoff --source ... --confirm-content-approved` 建立默认启用 V6 的视频
项目。生产模式同时要求源码工作树干净、Codex/Claude 安装同步；开发态绕过
只用于测试。

## 0. 先让代理进入确定性模式

较弱模型、低推理强度或 Claude Code 先运行：

```bash
node scripts/kacha.mjs doctor --profile claude-vision
node scripts/kacha.mjs prepare \
  --task source_edit --modules audio,subtitles \
  --agent claude --model-tier economy --source /path/to/source.mov \
  --output my-video-project/agent-packet.json
```

完整读取 packet 的 `readOrder`。已有 manifest 时运行
`node scripts/kacha.mjs next PROJECT.json`，一次只执行一个 `nextAction`。
涉及画面时先生成本地 `visual-evidence`；MiniMax 必须同时获得外传、付费服务
和命令行显式上传授权。

长转写不要整份放进 packet：

```bash
node scripts/kacha.mjs transcript index transcript.json
node scripts/kacha.mjs transcript slice transcript.json \
  --start 0 --end 90
```

## 1. 创建项目目录

```bash
mkdir -p my-video-project/contracts
cp examples/edit-proposal.json my-video-project/contracts/
cp examples/edit-plan.json my-video-project/contracts/
cp examples/project-manifest.json my-video-project/contracts/
```

不要把原始素材复制进 skill 仓库。真实项目应位于独立目录，并保持原始素材只读。

## 2. 填写方案

至少替换以下内容：

- `taskPath`；
- 真实输入文件路径、角色、规格和 SHA-256；
- `creativeLock` 中的源/输出画幅、格式、前台主体、AI 角色与冻结决定；
- 平台、受众、语言、时长、视频与封面画幅；
- 内容保留、删除、重排和待核验项；
- 启用模块、成功条件、失败回退；
- `authorization` 与证据；
- 13 个阶段的初始状态；
- 输出路径和允许偏差。

计算 SHA-256：

```bash
shasum -a 256 /path/to/source.mov
```

Linux 可使用：

```bash
sha256sum /path/to/source.mov
```

## 3. 通过方案门禁

```bash
node scripts/validate_edit_proposal.mjs my-video-project/contracts/edit-proposal.json
node scripts/validate_edit_plan.mjs my-video-project/contracts/edit-plan.json
node scripts/kacha.mjs gate-plan my-video-project/contracts/project-manifest.json
```

如果任务是 `proposal_review` 或授权模式是 `proposal_only`，到这里停止。

## 4. 探测当前机器

```bash
scripts/capability_probe.sh \
  --profile core \
  --output my-video-project/contracts/capabilities.json
```

项目需要蒙版、人声分离、HDR 或 AI 视频时，使用对应 profile 或追加 `--require`。不要把旧能力快照当成当前可用证据。

## 5. 检查执行条件

```bash
node scripts/kacha.mjs gate-render my-video-project/contracts/project-manifest.json
```

通过后可继续使用项目选定的 NLE/Remotion/HyperFrames；如果项目登记了
`plans.timeline`，咔嚓可直接执行统一时间线：

```bash
node scripts/kacha.mjs timeline validate \
  --plan my-video-project/contracts/timeline.json
node scripts/kacha.mjs render \
  my-video-project/contracts/project-manifest.json
```

EDL、画面呼吸、叠加层、字幕、dialogue、BGM 和 SFX 会在一个 Render Graph
中完成，正式视觉版本最多一次完整视频编码。

参数探索先做局部代理：

```bash
node scripts/kacha.mjs timeline render \
  --plan my-video-project/contracts/timeline.json \
  --mode preview --range-start 42 --range-end 50 \
  --output my-video-project/preview/42-50.mp4
```

## 6. 执行 v2 阶段

顺序不可颠倒：

1. `inventory`
2. `transcript_structure`
3. `rough_cut`
4. `dialogue_preprocess`
5. `connection_qc`
6. `fine_cut`
7. `visual_packaging`
8. `subtitles`
9. `final_mix`
10. `cover`
11. `preview_render`
12. `final_qc`
13. `release_package`

同一时刻最多一个阶段为 `in_progress`。`passed` 必须附真实证据，`not_applicable` 必须说明原因。

### 在 visual_packaging 阶段应用语义网感机制

画面锁定后，用最终带时间文稿建立并渲染正式效果时间线：

```bash
node scripts/kacha.mjs netstyle plan \
  --input my-video-project/picture-lock.mov \
  --transcript my-video-project/final-timed-transcript.json \
  --output my-video-project/contracts/netstyle-plan.json \
  [--mask my-video-project/person-mask.mkv]
node scripts/kacha.mjs netstyle validate-plan \
  --plan my-video-project/contracts/netstyle-plan.json
node scripts/kacha.mjs netstyle render-plan \
  --plan my-video-project/contracts/netstyle-plan.json \
  --output my-video-project/visual-packaged.mov
```

同一份最终带时间文稿还可以生成画面呼吸和口播字幕计划：

```bash
node scripts/kacha.mjs breathing plan \
  --input my-video-project/picture-lock.mov \
  --transcript my-video-project/final-timed-transcript.json \
  --output my-video-project/contracts/breathing-plan.json
node scripts/kacha.mjs captions plan \
  --input my-video-project/picture-lock.mov \
  --transcript my-video-project/final-timed-transcript.json \
  --output my-video-project/contracts/caption-plan.json
```

把两个计划分别登记到 `project-manifest.json` 的
`plans.visualBreathingTimelines` 和 `plans.captionTimelines`，再运行
`gate-plan`。字幕计划会优先使用项目已授权字体注册表；未授权或缺字时不会
静默替换。

把计划加入项目 manifest 的 `plans.netstyleTimelines`。字幕与最终混音必须在
这个输出之后执行。cue 字段和全部门禁见
[`references/z-en-editing-system.md`](../references/z-en-editing-system.md)。

高成本分析和素材生成使用统一缓存入口：

```bash
node scripts/kacha.mjs transcribe source.mov --output transcript.json
node scripts/kacha.mjs masks source.mov --output-dir masks
node scripts/kacha.mjs styleframe render \
  --scene process_progressive --output design/process.svg
node scripts/kacha.mjs cache inspect --project-root my-video-project
```

## 7. 自动技术 QC

```bash
node scripts/kacha.mjs qc my-video-project/contracts/project-manifest.json
```

自动 QC 会输出技术报告并检查解码、轨道、尺寸、画幅、帧率、音频、A/V 时长差、响度和黑/冻/静音线索。`pass_with_review` 仍表示存在需要人工处置的线索。

已有可验证基线的局部优化不要复制整套 v2 方案，改用下面的 v3 增量路径。

## 8. 人工审片与 release gate

可以在本地 `/review` 统一审片中心完成，也可以使用 CLI。十一项检查必须绑定
当前最终视频哈希；未通过项会产生待编译返工请求：

```bash
node scripts/kacha.mjs release-review init \
  my-video-project/contracts/project-manifest.json --reviewer NAME
node scripts/kacha.mjs release-review record \
  my-video-project/contracts/project-manifest.json \
  --check contentIntegrity --outcome pass \
  --evidence "normal-speed-review:content" --reviewer NAME
node scripts/kacha.mjs release-review approve \
  my-video-project/contracts/project-manifest.json \
  --reviewer NAME --limitations none
```

也可复制 `examples/release-report.template.json` 手工记录完整通看、字幕、连接点、
素材许可、蒙版/美颜/画中画、人声与设备试听、封面、开头结尾和技术线索证据。

```bash
node scripts/kacha.mjs gate-release my-video-project/contracts/project-manifest.json
```

只有真实文件、哈希、自动技术 QC 和全部人工检查同时通过，才可称为“本地完整 QC 通过”。上传和平台发布是另一个授权与验证阶段。

## 9. v3 局部返工

初始化一次：

```bash
node scripts/init_incremental_project.mjs /path/to/base.mov \
  --project-id my-video --output-dir my-video-project/incremental
```

每轮反馈建立 delta 与统一入口：

```bash
node scripts/create_version_delta.mjs \
  my-video-project/incremental/project-context.json \
  --write my-video-project/incremental/v2-delta.json \
  --new-version v2 --type sfx_adjust \
  --output-video my-video-project/incremental/v2.mov

node scripts/create_incremental_manifest.mjs \
  my-video-project/incremental/project-context.json \
  my-video-project/incremental/v2-delta.json \
  my-video-project/incremental/artifact-index.json \
  --output my-video-project/incremental/v2-project.json

node scripts/kacha.mjs gate-plan my-video-project/incremental/v2-project.json
# 使用计划中的 stream-copy / layer / segment 策略实际生成 v2.mov
node scripts/kacha.mjs qc my-video-project/incremental/v2-project.json
node scripts/create_incremental_review.mjs \
  my-video-project/incremental/v2-project.json
node scripts/kacha.mjs gate-candidate \
  my-video-project/incremental/v2-project.json
```

纯声音修改应保留原视频流，纯画面修改应保留原音频流；QC 会比较对应
elementary-stream SHA-256。需要最终交付时新建 intent 为
`release_candidate` 的 delta，完成完整人工清单后再运行 `gate-release`。

常见返工可从 `examples/change-request.json` 编译，避免手写复杂 delta：

```bash
node scripts/kacha.mjs compile-change change-request.json --dry-run
node scripts/kacha.mjs compile-change change-request.json
node scripts/kacha.mjs next /path/to/compiled/incremental-project.json
```

性能、Token、缓存和弱模型完整说明见
[V5 性能与稳定生产](PERFORMANCE_TOKEN_STABILITY_V5.md)。
风险预算、代表区间、并行波次、强指纹缓存和成对效率证据见
[V8 质量不降级效率](QUALITY_PRESERVING_EFFICIENCY_V8.md)。

## V6 全片导演与语义审片

最终带时间语义 cues 完成后，先建立全片约束和素材缺口：

```bash
node scripts/kacha.mjs intelligence director \
  --cues semantic-cues.json --show tool-share \
  --style light-warm-overlay --output director-plan.json
node scripts/kacha.mjs intelligence assets \
  --director director-plan.json --media-index .kacha/media-index.json \
  --output asset-gap-plan.json
```

候选 Timeline 完成后运行时序审计并建立审片包：

```bash
node scripts/kacha.mjs intelligence perception \
  --timeline timeline.json --output perception-audit.json
node scripts/kacha.mjs review build \
  --timeline timeline.json --director director-plan.json \
  --preview-dir preview --output-dir .kacha/review
node scripts/kacha.mjs studio serve
```

浏览器进入 `/review`，用真实可解码、带音轨、达到代表时长的 1× 预览逐项接受、
调整或拒绝。缺少任何一项预览时，即使全部接受也不能进入候选就绪。调整与拒绝
的解决证据同样必须是带音轨动态视频；项目/栏目/风格/平台 scope 从当前
Timeline 与 director 确定，不能在审片命令中改挂。解决后运行：

```bash
node scripts/kacha.mjs review validate \
  --session .kacha/review/review-session.json --for-candidate
```

完整评测、偏好学习、NLE 交换和门禁见
[V6 智能剪辑证据闭环](INTELLIGENT_EDITING_V6.md)。

## 10. Agent 对话式操作

用户继续直接在 Codex/Claude Code 中描述目标。Agent 内部用以下能力减少整份
合同回读、素材翻找和长任务阻塞：

```bash
node scripts/kacha.mjs delta apply timeline.json mutation.json \
  --write timeline.next.json
node scripts/kacha.mjs media search .kacha/media-index.json \
  --query "城市夜景地标"
node scripts/kacha.mjs jobs status @job:ID --project-root PROJECT_DIR
node scripts/kacha.mjs refs resolve @overlay:card-1 \
  --index .kacha/object-index.json
node scripts/kacha.mjs install status --agent both
```

这些不是要求用户学习的新操作方式。自然语言仍是主入口，命令只负责把结果
变成确定性、低 Token、可续跑的本地证据。详见
[Agent 对话控制面](AGENT_CHAT_CONTROL_PLANE.md)。
