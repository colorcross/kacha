# 叙事配方、候选比较与代码音效

适用于表达方向未确定、首次建立一种局部包装时。已有明确且适用的风格直接沿用，不强制每条视频生成候选。Agent 根据用户文案与实际证据填写结构；不要把工程 JSON 表单交给用户。

## 三种配方

| 配方 | 内容合同 | 通用用途 | 大灰AI应用与限制 |
| --- | --- | --- | --- |
| steps | 2–4 步，每步动作、结果；保持真实顺序 | 操作教学、流程解释 | AI实践的输入→执行→核验；AI共读须保留书本论证 |
| comparison | 2 项，统一条件与单位；证据说明必填 | 方案取舍、结果比较 | 测评保留条件、失败和局限；不从描述杜撰柱高或胜负 |
| timeline | 2–4 个真实时间节点，日期写入标签 | 事件脉络、迭代过程 | 产品实践、访谈或资讯；先后不自动代表因果 |

三者是局部信息卡，不替代真实口播、录屏、书本原文或实验素材。通用包为浅色内容卡；显式 `dahui-ai` 使用克制的深色科技表达，不自动给通用视频加个人品牌。复杂数据几何、等距三维和任意自然语言拟真音效不在此渲染器的能力范围；已有 Wise Motion、专业工具可继续按各自合同使用。

每份输入生成两个方向：全局并列、逐项聚焦。文字完全相同，后者先完成入场，再移动一个焦点；不会把“删掉信息”当作优化。固定整数帧，输出真实无声 MP4。横屏 1280×720、竖屏 720×1280 分别排版；不支持透明画布，不自动拉伸。生成前检查字体授权、SHA、完整字符覆盖和实际排版；超长内容报错，改为分段或适当延长，不能静默裁字。时长 4–16 秒，按文字量限定下限。

## 操作

Studio `/samples` 可输入内容、生成、读取状态、正常速度比较、保存方向选择，再插入时间线。任务在后台运行，重开页面后按原目录恢复；不自动重试写操作。失败保留任务和日志，使用 `jobs status` 核对，按任务恢复合同隔离部分产物，或明确使用新包。

```bash
node scripts/kacha.mjs samples recipes
node scripts/kacha.mjs samples render --spec /absolute/spec.json --output /absolute/new-samples
node scripts/kacha.mjs samples status --package /absolute/new-samples
node scripts/kacha.mjs samples select --package /absolute/new-samples --variant guided \
  --expected-digest MANIFEST_DIGEST --reason '逐项聚焦对应这段操作讲解'
# 改选还须 --expected-selection CURRENT_SELECTION_DIGEST，防止覆盖另一个窗口的选择。
node scripts/kacha.mjs samples attach --package /absolute/new-samples \
  --expected-selection SELECTION_DIGEST --timeline /absolute/timeline.json \
  --expected-sha TIMELINE_SHA256 --output /absolute/new-timeline.json \
  --start 4 --reason '解释核验流程，保持原口播'
```

最小 `spec`（示例文本不是实测事实）：

```json
{
  "recipe": "steps",
  "pack": "generic",
  "title": "怎样核对 AI 的回答？",
  "items": [
    {"label": "明确问题", "detail": "写下输入条件和验收标准"},
    {"label": "核对来源", "detail": "对照原文检查关键判断"}
  ],
  "evidence": "示例流程，非实测结果",
  "durationSeconds": 8,
  "fps": 25,
  "width": 1280,
  "height": 720
}
```

可用 `fontFile` 指定注册表中的授权字体，省略时优先 Noto Sans / 思源黑体，然后检查完整字符覆盖。不会复制或公开本地字体。选择绑定 spec、字体及授权注册表、生成实现、依赖版本和两份 MP4 摘要；输入、实现或产物改变后失效。选择代表表达方向，不能作为审片通过。插入要求当前时间线 SHA 和选择摘要相符，画幅/帧率一致、整帧定位、不越界，输出同目录新候选，清除旧审批状态。全屏信息卡会覆盖原画面，但不改源音频政策；必须检查原字幕、脸部与其他叠层的关系。

## 本地代码音效

先检查用户音效库与项目 profile。大灰AI默认先读项目的 `assets/audio/sfx-library/manifest.json`、`kacha-profile.json`、试听索引。语义不匹配时才生成。`libraryCheck` 是 Agent 对检查过程的记录，不冒称系统已自动判断音效库是否合适。

可生成 click、pop、chime、whoosh、impact 五类抽象短音效。采用振荡器、固定种子噪声、包络与淡入淡出；无外部音频、无模型请求、无 API 费用。输出 48 kHz 双声道 16-bit PCM WAV；种子相同参数相同则字节一致。时长 0.08–3 秒，峰值 -36 至 -6 dBFS，默认 -15 dBFS；这只是样本峰值保护，不能代替混音响度和真实听感验收。

```json
{
  "type": "pop",
  "durationSeconds": 0.3,
  "peakDb": -15,
  "pitchHz": 700,
  "seed": 1,
  "trigger": "步骤卡完成勾选时轻提示一次",
  "libraryCheck": "已试听项目库中的弹出音，尾音过长，需要更短的抽象提示"
}
```

```bash
node scripts/kacha.mjs sfx synth --spec /absolute/sound.json --output /absolute/new-sound
node scripts/kacha.mjs sfx status --package /absolute/new-sound
node scripts/kacha.mjs sfx attach --package /absolute/new-sound \
  --timeline /absolute/timeline.json --expected-sha TIMELINE_SHA256 \
  --output /absolute/new-timeline.json --target 4
```

`--target` 是叙事/画面峰值落点，不是音频文件起点。合成后使用现有 FFmpeg 解码测量 20 ms RMS 峰值，插入调用既有对齐逻辑；尾音越界拒绝，开头不足可按既有规则裁去前导。新候选保留人声/BGM，清除旧审阅。按 `sfx-library.md` 建立整片 `sfxPlan`，保持每个语义节拍单一主声事件，用手机扬声器和耳机审听。该模块不生成语音、拟真人物/现场声或完整背景音乐；BGM 仍默认 MiniMax Audio 网页版，含音频视频仍默认本机 MiniMax Design。

## 来源与实现边界

候选筛选工作方式参考成峰的 [chengfeng-video-styles](https://github.com/Agentchengfeng/chengfeng-video-styles)（核查快照 `b9afa09d0733f8ac8998b0b5e3630f14cdd0eb83`，Apache-2.0）。咔嚓的渲染器、比较界面、版本绑定和 DSP 为独立实现，未复制上游代码或素材、未运行上游安装器，也未将其宣传中的 16 种效果当作已经接入。这里只交付上述可验证的三类配方和五类抽象音效。
