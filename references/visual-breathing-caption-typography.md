# 画面呼吸、口播字幕编排与字体路由

本页定义三套必须协同工作的能力：画面呼吸、口播字幕编排、字体场景路由。
它们都在 picture lock 之后、最终混音之前执行；不得用运动或大字掩盖错误
切点、字幕错误、人物遮挡或内容结构问题。

## 1. 画面呼吸

画面呼吸不是持续缩放。它是“收紧—停稳—释放”的注意力曲线：

- 收紧：问题、判断或情绪逐渐明确时缓慢推近；
- 停稳：事实密集、字幕需要阅读、笑点落下后保持静止；
- 释放：反思、总结或章节结束后缓慢拉远；
- 横移：只有画面中存在真实方向、对照或留白时才横向漂移；
- 冲击后停稳：极短结论、数字或笑点与口播重音同时成立时，快速放大后
  回落到稳定景别。

默认注册表是 `config/effects/visual-breathing.json`，时间线编译和渲染入口：

```bash
node scripts/kacha.mjs breathing plan \
  --input PICTURE_LOCK.mov \
  --transcript FINAL_TIMED_TRANSCRIPT.json \
  --output BREATHING_PLAN.json
node scripts/kacha.mjs breathing validate --plan BREATHING_PLAN.json
node scripts/kacha.mjs breathing render \
  --plan BREATHING_PLAN.json \
  --output BREATHING.mov
```

### 1.1 密度合同

- 运动覆盖不超过全片 55%，静止覆盖不少于 45%；
- 默认每 10 秒不超过 1.5 个主运动事件；
- 两个运动区间至少相隔 1.2 秒；
- 单次持续 1.8–4.5 秒，最大缩放不超过 1.08；
- 同一主体相邻运动不连续同向；推近后必须停稳或释放；
- 缩放焦点使用人物眼睛/主体中心，不使用画面几何中心猜测；
- 头顶、手势、字幕和平台安全区不能因为缩放被裁掉。

缓慢推近、拉远和横移默认不配音效。只有
`emphasis_punch_settle` 这类可见重音才允许短促音效；动作在口播重音前
0–2 帧启动，音效能量峰值和视觉峰值对齐到 2 帧以内。

### 1.2 失败与回退

- 源画面已经太近、头顶余量不足：回退 `still_hold`；
- 事实密集、观众正在读字：停止运动；
- 人物有明显身体动作：优先动作连续性，不叠加抢戏运镜；
- 连接点本身错误：先改剪点、景别或转场，不用缩放遮掩；
- 运动导致画面抖、锐度下降或插帧伪影：减弱或关闭。

## 2. 口播字幕编排

参考公开视频
`https://www.douyin.com/video/7659640195897268724` 的信息关系，咔嚓只提炼
“左右、上下、前后”三类排版机制，不复制参考作者的字体、素材、音效和完整
视觉样式。

普通口播仍以 `plain_single` 为默认。只有信息关系明确时才升级：

| 信息关系 | 布局 | 适用条件 | 最简回退 |
| --- | --- | --- | --- |
| 对照、并列、前后变化 | `left_right_contrast` | 两组短语能各自成立 | 单行逻辑重音 |
| 主标题与补充、问题与回答 | `top_bottom_hierarchy` | 上下两层有真实层级 | 单行逻辑重音 |
| 空间、人物与观点形成层次 | `oversize_background_word` / `front_back_phrase` | 有逐帧人物蒙版和足够可见面积 | 普通前景大字 |
| 简短逻辑重音 | `logic_emphasis_inline` | 只有一个主重音 | 普通单行字幕 |
| 无特殊关系 | `plain_single` | 默认 | 无 |

`side_vertical_labels` 只用于两侧都有稳定负空间、词组很短且手机端可读的
情况。竖排标签不得承担完整句子。

### 2.1 排版合同

- 字幕以音频为准，原稿只做专名、数字、否定、条件和语境校准；
- 普通字幕单行、无底色，语义切分，不按固定字数机械分段；
- 同一时刻最多三个阅读区，且只能有一个主重音；
- 主字幕、展示文字、品牌和信息卡必须共用安全区碰撞检查；
- 所有文字在切回主画面前完整退出，不拖尾到下一镜头；
- 人物头脸为最高避让区；上方文字必须确认头顶仍有完整呼吸空间；
- 亮底使用深色字，暗底使用浅色字；不能在暖黄卡片上继续使用白字；
- 前后景文字必须有逐帧人物蒙版；蒙版缺失时直接回退，不伪造景深。

默认布局注册表是 `config/effects/spoken-caption-layouts.json`：

```bash
node scripts/kacha.mjs captions plan \
  --input PICTURE_LOCK.mov \
  --transcript FINAL_TIMED_TRANSCRIPT.json \
  --font-registry LOCAL_AUTHORIZED_FONTS.json \
  --output CAPTION_PLAN.json \
  [--mask PERSON_MASK.mkv]
node scripts/kacha.mjs captions validate --plan CAPTION_PLAN.json
node scripts/kacha.mjs captions render \
  --plan CAPTION_PLAN.json \
  --output CAPTIONED.mov
```

转写 cue 可用 `captionLayout` 明确指定布局，也可由确定性语义规则选择。前后
景布局只有在 cue 提供 `display.background` / `display.foreground` 且计划
冻结人物蒙版时才允许进入正式渲染。

## 3. 字体场景路由

字体不是按文件名随机挑选，而是先解析元数据、字符覆盖、字重、气质和项目
授权，再按角色选择。路由配置在 `config/font-routing.json`，默认角色包括：

- `subtitle_primary`：长时间阅读的主字幕，优先中性、清晰的中文无衬线；
- `subtitle_emphasis`：逻辑重音，和主字幕同家族或同气质，不跳风格；
- `caption_editorial`：观点、文化和思考类展示字，可使用金陵体一类书写感字体；
- `caption_humor`：自嘲、反转和轻喜剧短字，允许略强个性但不能影响识别；
- `caption_cultural`：书籍、历史和人文内容；
- `caption_tech`：工具、数据和流程内容；
- `display_title_zh`：中文封面/章节标题，可使用华光标题黑一类标题字体；
- `display_title_en` / `body_en`：英文标题与正文。

普通主字幕和逻辑重音保持同一阅读家族，不因句子主题频繁换字。展示型布局
才按语义自动路由：自嘲/反转可选 `caption_humor`，书籍/历史/哲学可选
`caption_cultural`，AI/工具/数据/流程可选 `caption_tech`；无法可靠判断时
回到布局默认角色。cue 可用 `fontRole` 显式覆盖，但必须是已注册角色。

本项目 `Fonts` 目录的文件先生成本地注册表，再记录用户对当前项目制作范围
的授权。授权记录不改变字体内嵌许可，也不意味着允许把字体文件提交到公开
仓库：

```bash
node scripts/kacha.mjs fonts scan \
  --directory /ABSOLUTE/PATH/Fonts \
  --output LOCAL_FONTS.json
node scripts/kacha.mjs fonts authorize \
  --registry LOCAL_FONTS.json \
  --output LOCAL_AUTHORIZED_FONTS.json \
  --statement "用户确认这些字体已获得当前项目使用授权"
node scripts/kacha.mjs fonts validate \
  --registry LOCAL_AUTHORIZED_FONTS.json
node scripts/kacha.mjs fonts resolve \
  --registry LOCAL_AUTHORIZED_FONTS.json \
  --role caption_editorial \
  --text "工具降低门槛，品味决定上限"
```

每次解析都必须记录命中的真实字体文件、family、SHA-256、字符覆盖、授权状态
和 fallback。字体缺字、路径丢失、hash 改变或授权记录缺失时，不得静默换字。

## 4. 字幕、字体、排版与音效协同

- 普通字幕不加音效；
- 逻辑重音只在一个关键词落位时使用轻点音；
- 左右/上下布局的每个信息组只在首次落位时发声，不逐字轰炸；
- 前后景大字在文字穿过人物层级的主峰使用一次短促强调音；
- 键盘音只用于真实逐字打字，不用于普通字幕出现；
- 所有 SFX 先从项目音效库按已命名触发选择，并测量源音效能量峰值；
- 视觉峰值、文字落位峰值和 SFX 能量峰值对齐到 2 帧以内；
- 音效不能盖住人声尾字，不能用更大音量补偿错误的动画节奏。

## 5. QC

必须检查：

1. 源尺寸、宽高比、有效帧率、时长和人声保持；
2. 运动覆盖率、静止比例、事件密度和相邻方向；
3. 每个布局的触发理由、最简回退和蒙版要求；
4. 字幕文本准确、语义切分、手机端读速和最长单行；
5. 头脸、手势、平台按钮、品牌、PIP 和信息卡碰撞；
6. 字体真实命中、缺字、fallback、文件 hash 和授权范围；
7. SFX 源峰值、事件峰值和实际放置偏移；
8. 100% 原尺寸帧、手机缩略帧和正常速度连续播放。

自动解码和静态截图不能替代正常速度人工通看。
