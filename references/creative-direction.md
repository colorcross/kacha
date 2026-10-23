# 开放创作方向

新项目先决定内容目标，再组织叙事方法、画面形式和执行工具。不要要求用户先从五种画风中选一种，也不要把全部片段统一包装成一种模板。

## 四层决策

1. **内容目标**：这段要让观众理解、看见、比较、感受或核实什么？素材和事实能否支持？
2. **叙事方法**：连续表达、重点旁注、关系与机制、操作演示、比较与数据、证据揭示、喜剧节拍、状态变化、蒙太奇与声音桥、情绪与艺术场景。可组合，也可自定义。这是可扩展的起点，不是完整电影语言分类。
3. **画面形式**：从题材、品牌、实拍素材与参考决定字体、色彩、构图、材质、二维/三维、镜头与声音。允许手绘、纸艺、实拍拼贴、编辑式排版、摄影、抽象、定格等；不能把新外观伪称为已有可执行模板。
4. **执行工具**：普通精剪、声音桥和字幕优先现有剪辑能力；运动排版/产品演示可选 huashu-motion；关系、数据和艺术动画可选 huashu-art-motion；图解与交互原型可选 huashu-design；具有主题、镜头及声音结构的短片可选 lemo-opuscar。工具候选不代表安装、可用或已授权生成；先 `creative doctor`。

每个方法必须说明：真实触发、观众获得什么、使用哪些素材、如何进入/退出、何时回退。素材不足时回到原画面、真实证据与必要字幕。不能为了“丰富风格”强加喜剧、危机感、状态条或科技光路。

## 使用

```bash
node scripts/kacha.mjs direction catalog
node scripts/kacha.mjs direction plan --intent explain --brief '解释两种方案的取舍' --art-direction '实拍、白底黑字、少量手绘，不使用科技光路'
node scripts/kacha.mjs direction plan --request direction-request.json
node scripts/kacha.mjs start --script script.md --project-root project --creative-direction direction-request.json
node scripts/kacha.mjs start --materials clips --requirements "按真实内容编排" --project-root film --creative-direction direction-request.json
```

请求字段为 `intent`、`brief`、`artDirection`、`pacing`、`techniques`、`customMethod`、`providerPreference`。枚举以 `config/creative-direction.json` 为准。`custom` 必须描述目的、动作与回退。品牌包继续控制来源、字幕、logo、字体授权和栏目规则。

默认 `auto` 从十种内置方法中按当前镜头信号提出候选；没有匹配信号时只保留连续表达。显式填写 `techniques` 仍限定候选范围，不因自动目标扩展。只有匹配当前方向且未被保护的镜头才参与强调预算分配；候选仍须核对实际素材，不自动渲染。

工作台的视频入口和文稿/选题入口保存开放方向；方案写入 production brief 和项目配置。它只产生 proposal，不替代素材制作、原生工具检查、候选回收、时间线绑定或全片审阅。多素材入口也保存方向，并把显式要求写进分镜模板；分镜遗漏该要求或没有镜头覆盖时拒绝编排。导演计划按当前 cues 的内容信号提出方法候选，不再先套旧外观；自定义方法须经人工素材判断。CLI 导演入口自动读取所属项目方向，也可显式传 `--creative-direction` 请求文件。

## 旧配置处理

- 五套行者风全部退出普通新建选择；工作台和内容页只有主动展开“恢复历史配方/栏目”才能访问。旧文件仅保留兼容解析，不作为新建自定义风格的基础。
- 通用项目不强制三秒可见变化、固定秒数承诺、真人/真实画面占比或统一留白占比，允许完整动画与自定义镜头机制；开场仍须说明叙事理由、处于真实片长内并审阅。大灰AI节目约定保持独立。
- 浅暖轻浮层 → 重点旁注；空间光路 → 关系与机制；幽默漫画 → 喜剧节拍；像素风 → 状态变化；暗黑科技 → 证据揭示。旧外观均为可选实现，不是方法定义。
- 行者风生产包及五套效果的历史合同、帧校验和渲染器保持可重现。其固定数量校验只约束旧资产库，不能限制开放注册表。
- 新项目不继承旧项目的审阅状态，旧项目不自动更换画风或重写时间线。

外部创作候选的接入与质量链见 [creative-skills.md](creative-skills.md)。评估与迁移说明见 [CREATIVE_DIRECTION_V2.md](../docs/CREATIVE_DIRECTION_V2.md)。
