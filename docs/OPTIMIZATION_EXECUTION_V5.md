# V5 工程执行与恢复说明

本版把叙事判断、实际媒体执行和验收证据分开。工程/媒体回归通过仍不等于生产验收。2026-09-22 用户明确要求先不做生产验收，8 个同源项目队列和人工成片评审暂不执行。

## 入口与版本

- `kacha observe PROJECT` 或 `status PROJECT --quick`：只读观察；不计算素材 SHA，不修改项目，不签发执行许可。
- `status PROJECT --summary`：仍执行完整检查，旧调用方语义不变。
- `runtime create --source SOURCE --output NEW_BUNDLE`：导出干净源码/已验证安装的固定包；包内容改变即失效。新生产工程自动缓存并绑定此包；开发工程仍可使用开发模式。
- `runtime bind PROJECT --bundle BUNDLE`：旧项目显式绑定。不同版本必须另存旧工程后使用 `--accept-runtime-update` 并通过现有合同重验；绑定本身不重写原批准文件。历史绑定保存在项目目录。
- 固定包不内嵌外部模型、私有字体或素材；这些资产按现有合同核验。缺旧包必须恢复旧包，不静默换引擎。
- 绑定同时写入本机信任记录，项目自带 JSON 不能自行指定任意可执行包。迁移到另一台机器须重新显式绑定；Node/FFmpeg/ffprobe 工具链变化会阻断旧包，需建立新运行版本。Studio 通过绑定包生成和查询真实预览。

## 叙事需求

新项目质量合同采用 `narrative-v1`。直接模板命令默认 legacy，便于恢复原合同；新策略须显式选择并提供需求文件：

```json
{
  "version": "narrative-v1",
  "requirements": [
    {"id":"opening","priority":"required","origin":"editorial","reason":"用真实操作提出问题","timelineIds":["clip-opening"]},
    {"id":"proof","priority":"required","origin":"fact","reason":"展示同条件测试结果","timelineIds":["proof-overlay"]},
    {"id":"depth","priority":"conditional","origin":"editorial","condition":"存在前后景关系","triggered":false,"reason":"为观点分层","dispositionReason":"当前画面没有前后景关系"}
  ]
}
```

`origin=user|fact` 必须为 required；必需与已触发需求必须映射到实际 EDL/overlay/breathing/SFX 对象。事实对象须保留真实来源，不允许 illustration。执行质量合同绑定当前 `execution.timeline.path/sha256`，仍要求当前动态预览和最终审片证据。能力模板可用 `--opening natural` 选择真实开场；质量执行记录使用 `execution.opening.mode=natural`、`primaryNarrativeCount=1`、`primaryEffectCount=0` 和 `narrativeReason`，并保留时间与预览约束。

## 手法编译

```text
kacha craft compile --timeline timeline.json --operations decisions.json --output next-timeline.json
```

决定文件为 `version=craft-v1`，绑定 `timelineSha256`、`sourceSha256` 和非空 operations。每项共有 `id`、`type`、`cueId`、`reason`、`evidence:{path,sha256}`。路径相对于决定文件；源路径与其他原时间线资产在新时间线内变为绝对路径。

| type | 专属字段 | 实际行为 |
| --- | --- | --- |
| reading-hold | clipId, sourceStart, sourceEnd, readingUnits | 只延长真实源片段；按现有阅读速度/引导时间配置检查，重排后续事件 |
| reaction-hold | clipId, sourceStart, sourceEnd | 延长并保留真实反应，禁止冻结帧伪造 |
| proof-reveal | asset 身份及 provenance, kind=image/video, start/end, readingUnits, x/y/width/height | 写入真实叠加层；检查最短阅读时间 |
| natural-sound | start/end, recordingSha256 | 保留源录音并为 BGM 生成留白窗口；不回混分离 residual |
| j-cut / l-cut | afterClipId, offsetSeconds, coverId | 分别改变两侧音频源区间；缓存生成 48 kHz / PCM 24-bit stem |

J/L 自动编译范围：单源、明确硬切、无已有独立 dialogue stem。正偏移不超过 2 秒，源 handle 必须足够；音画分离区间须由已定义的全画面 overlay 覆盖以避免口型冲突。邻接桥接导致负时长时阻断。复杂转场、已有独立 stem 等组合不自动猜测映射。

源字幕输入可用 `transcript:{path,sha256}`，文件含 `sourceSha256`、`cues:[{id,start,end,text}]`；`captionStyle:{font,fontSize}` 必须由已批准样式提供。编译产生新 cue 映射与 ASS 并接入时间线；剪口截断一句 cue 会阻断，须先按词/语义边界修订。延长源区间时，已有预烘焙字幕需要先重建。输出为新预览时间线，新结构不继承旧 proposal/editPlan 的批准状态。

`.craft.json` 记录原时间线、决定文件、新时间线、stem 身份和音频映射。正式 Render Graph/manifest 继续携带这些身份与执行状态；`compiled_requires_render_and_review` 和 `rendered_requires_review` 均不是人工验收。

## 真实局部预览

```text
kacha real-preview request --timeline FILE --expected-sha SHA --start SEC --end SEC
kacha real-preview status --timeline FILE --key KEY
```

单请求最长 60 秒；默认 UI 取播放头前 2 秒至后 6 秒。共用 Timeline IR 渲染、现有 jobs、资源池与遥测。相同 timeline/源/资产/实现/配置/范围请求去重。Studio 连续点击防抖；修改或切换项目后旧结果不显示为当前结果。后台任务失败通过 `jobs status` 获取日志和恢复指令，产物哈希验证前不提供播放。

范围闭包保留跨剪口的相邻片段、转场相位、SFX 尾音、移动叠加层和 BGM 淡变过程。有状态 sidechain 尚不能缩小时明确扩大到片首并报告 `stateful_audio_history`；不伪称所有局部预览都只解码指定几秒。

## 渲染收敛覆盖

| 路径 | 本版状态 | 边界 |
| --- | --- | --- |
| EDL、转场、ASS/字幕视频、呼吸、overlay、BGM、SFX | Timeline IR 直接编译 | 现有支持项共用终编 |
| 已注册网感效果 | `netstyle compile-unified --plan FILE --output NEW_TIMELINE --no-sfx` 或项目库已选 SFX | 仅效果区间经旧局部渲染器加工并缓存；普通间隙不单独编码 |
| 网感原 render-plan | 保留旧执行入口 | 原工程可回退；不声称全库均已原生编译 |
| 简单 10-bit 时间线 | libx265 保留像素格式与源颜色标签 | 实测 yuv420p10le + BT.709；仍由输出探测约束 |
| 复杂高位深、HDR、源 alpha | 明确阻断尚未验证组合 | 不能暗中降为 yuv420p 或改标签冒充保真 |

网感局部合成当前只验证 SDR 8-bit 4:2:0、方形像素、无旋转。缓存键包含素材、事件参数、脚本与配置身份；产物 SHA 失效则不复用。每个事件的迁移报告显示路径和 cache hit/miss。--no-sfx 是显式不配音效；有已计划声音但缺项目库选择时阻断，不能默默省略。私有音效不进入公共包。

## 确定性任务与遥测

`deterministic_task.mjs --spec FILE --spec-sha SHA --output NEW_FILE` 仅在受控 efficiency 计划中注册，不接受任意 shell。spec：

```json
{"version":"deterministic-v1","adapter":"styleframe","input":{"path":"/absolute/source.mp4","sha256":"SOURCE_SHA"},"parameters":{"timeSeconds":1.2,"width":1280}}
```

首批：media_probe、transcript_index、audio_analysis、styleframe。非 styleframe 参数为空；styleframe 仅 PNG，宽度 64–3840，时间必须在源视频内。音频分析报告 mean/max dB，不把它标成 LUFS。输入/spec 执行前后核验，输出独占且不覆盖，FFmpeg 300 秒超时，按既有 jobs 保留退出/取消/恢复记录。资源不增槽，失败先查原因再显式恢复，不自动重复付费生成。

遥测新增 operationId、parentEventId、attempt 和 per-field usage 来源。null/空串/布尔值不再当 0，父子包装不重复计算，真实零保留；工作耗时允许并行重叠，项目历时单列。现金通过 `--cost-ledger` / `--cost-entry` 引用既有账本，同条目只汇总一次，未对账为 unavailable。没有提供人工时薪、电价或完整生产队列时，不合成“总成本节省百分比”。
