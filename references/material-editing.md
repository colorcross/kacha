# 多素材按要求成片

适用：用户提供若干本地视频、图片或目录，以及自然语言剪辑要求。任务类型为
`material_edit`。用户在聊天中提供这些信息即可；Agent 负责查看素材、形成分镜、
运行和交付候选，不得把编写 JSON、执行命令或管理后台任务转交用户。

## 从意图到候选

1. 读取用户要求，确定主题、观众、平台、时长、画幅、必用/禁用素材、声音、
   字幕与节奏。已有明确要求就是相应本地剪辑的授权，不重复确认。未指定时长
   和画幅时按内容做合理判断并简述；CLI 缺省为 60 秒、16:9、25 fps。
2. 用 `start --materials` 冻结实际文件身份和原始要求，读取返回的
   `agentPacket` 与 `storyboardTemplate`。递归导入目录，路径去重；隐藏项和
   符号链接不跟随，非媒体条目记入 skipped。损坏或不可探测素材明确报错，
   不能无声跳过用户可能要求保留的关键镜头。
3. 对候选素材用 `materials inspect` 提取代表帧，**实际打开这些帧查看**。
   默认视频取 10%、50%、90% 位置，图片取原图预览；按选段补充时间点。
   涉及对白先按 `references/audio.md` 转写和核对选段完整语义；动作、表情、
   镜头运动、转场和环境声音仍需查看连续片段或试听。抽帧记录不是已审片证明，
   不以文件名、时长、三张帧或画面模型输出冒充整段理解。
   重复抽取相同帧保持记录不变；补抽帧生成新快照，已有分镜继续使用冻结快照。
   被修改、无归属或空的审阅记录会阻断使用，不能重新抽帧后静默接纳。
4. 先组织明确的叙事主线：开场问题/结果 → 必要背景 → 具体过程/证据 →
   收束。按实际素材选择适用结构，避免为了凑时长把全部文件顺次拼接。
   使用 `references/professional-editing-craft.md` 的阅读、反应、环境声保护原则，
   让每个镜头有内容作用。纯说明图片留足阅读时间；对白保留否定、因果和句尾。
5. Agent 填写分镜并执行 `materials compose`。每条要求要有对应镜头，
   裁切须有主体安全依据，静音须有理由。以动作为切点、用景别变化和内容关联
   组织节奏；缺少适合素材时保留简洁硬切，不强行添加装饰。
6. 用 `run PROJECT --include-render --confirm-execute` 提交后台渲染，跟踪返回
   `@job`。仍在运行时重复 run 会返回同一任务；取消/失败后查日志，再用
   `resume PROJECT --include-render --confirm-execute` 恢复。Agent 持续推进到
   候选可用，不能在“已提交”处声称完成。
7. 检查实际候选：完整解码、尺寸、时长、音轨自动检查之外，抽查每个连接点、
   图片文字可读性、裁切主体与字幕，试听音量切换并正常速度审片。修正选段、
   顺序或字幕后重新 compose/run，保留旧候选并复用未变化的无损片段。

```bash
node scripts/kacha.mjs start \
  --materials /path/to/videos --materials /path/to/photos \
  --requirements '剪成60秒竖屏产品短片，先展示结果，再解释过程，保留演示原声' \
  --duration 60 --aspect 9:16 --project-root /path/to/new-project \
  --confirm-execute
node scripts/kacha.mjs materials inspect --project-root /path/to/new-project \
  --asset asset-ID --timestamp 3.2 --timestamp 5.6
node scripts/kacha.mjs materials compose --project-root /path/to/new-project \
  --storyboard /path/to/storyboard.json
node scripts/kacha.mjs run /path/to/new-project --include-render --confirm-execute
node scripts/kacha.mjs status /path/to/new-project --summary
```

`--requirements-file UTF8.txt` 可以替代 `--requirements`；不能同时使用。
支持 16:9、9:16、1:1、4:5，24/25/30/50/60 fps，目标 1–3600 秒，
最多 500 个素材、500 个镜头。可重复选择同一视频的不同区间；不要求用完所有素材。
`--width` 为 160–1920 的偶数，按画幅确定高度。默认横屏 1920×1080、
竖屏 1080×1920。此入口输出本地候选，尚无 4K、自动变速、HDR 色彩管理或
跨镜头 J/L 音频重叠合同。检测到 PQ/HLG HDR 会阻断导入，
需先明确转换为 SDR，避免直接降到 8 位导致错误观感。需要这些能力时回到相应专业模块，不能声称已经执行。

## 分镜合同（由 Agent 维护）

从项目返回的模板创建工作分镜文件，保持 `schemaVersion`、`kind`、
`projectDigest` 与 `briefDigest`；不要手改冻结的项目或 brief。

- `interpretation`：对原始要求的具体理解。
- `requirements[]`：`id`、`text`、`check`、`assetIds`。
  `check` 为 `semantic`、`include_assets` 或 `exclude_assets`。
  后两种必须列出有效素材 ID。语义要求的“已覆盖”是 Agent 声明，技术检查
  只能确保引用关系，不能证明画面真的符合“高级感”等审美要求。
- `segments[]`：顺序就是成片顺序；每段必须有唯一 `id`、`assetId`、
  `sourceIn`（源秒数，图片为 0）、`duration`（0.2–600 秒）、`fit`、`audio`、
  `observation`（实际观察）、`role`、`reason` 和 `satisfies`（要求 ID 数组）。
  各镜头按目标帧率舍入后，总帧数须与目标完全一致，不允许一帧短尾或超长；
  视频区间不能超出源时长。未实现的 `speed`、`transition`、`motion` 等字段以及
  拼错的参数会明确报错，不能把未执行的效果留在分镜里。
- `fit: contain` 保留完整画面并适配留边；`cover` 居中裁切并要求
  `cropReason`。没有主体观察依据不要选择 cover。
- `audio: source` 保留存在的原声；`mute` 对有声音素材必须给出
  `muteReason`。图片和无声视频补齐静音轨，不把缺失音轨当作失败。
- 可选 `caption` 为该镜头全段显示的短说明（1–60 字），需要满足阅读时长。
  它不是自动逐字 ASR 字幕；对白字幕要先转写并按语义分段对齐，再生成相应
  镜头字幕。不要把一句长对白压到短镜头，也不要伪造未转写的台词。
- 可选 `soundtrack`：`path`、`reason`、`levelBelowDialogueDb`（8–30）。
  只引用当前可用、有使用依据的本地音频；统一渲染器负责循环和人声侧链压低。
  “行者大灰”音效继续遵守项目私有音效库规则，不把源音频加入公开工具包。

## 可恢复性与质量边界

所有源素材只读。非方形像素先按显示宽高比转换为方形像素，再完整适配或裁切，
避免横向拉伸。选段归一化到一致几何、帧率、48 kHz 双声道，以 FFV1/PCM
无损保存，然后无损拼接，通过已有 Timeline IR 做一次有损成片编码；字幕和配乐
进入统一渲染。字幕在 compose 时冻结字体文件身份和字号；配置了字体文件时
检查 SHA-256 与字体内部名称，并在渲染前放入工程的版本字体目录，直接交给
libass，不要求先在操作系统中注册。缺失或错误字体在耗时转码前阻断。
无损中间文件可能较大，保留以支持返工，不能自动删除用户源文件。

每个分镜版本保存在 `contracts/edit-<digest>/`，每份候选保存在对应
`output/edit-<digest>/`。分镜计划、逐镜源时间映射、审阅帧身份、渲染合同、
候选 SHA 和 QC 分开保留。成片全量解码后检查实际视频帧数；状态读取还检查
QC 标记、帧数和工程字体，不能靠重算记录摘要把失败或人工未验收变成通过。director.json 是阅读/节奏建议，不能冒充已经执行的
特效。修改字幕、叙事备注或镜头顺序可复用内容未变化的归一化片段。

源素材、要求、配乐、分镜或成片身份失效会阻断复用。排队期间更换分镜时旧任务
拒绝渲染新版本；新版本需要重新提交。运行版本变化时重新建立项目，保留旧项目。
`--development` 仅用于仓库测试，不能作为真实剪辑绕过运行版本检查的手段。

状态为 `candidate_ready` 只表示当前候选及技术检查可用；
`humanReviewComplete` 始终为 false，发布仍须回到正式 QC/release 和实际审阅。
不能把合成素材回归、代表帧或可解码文件表述为真人素材剪辑质量验收。
