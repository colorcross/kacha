# 视频设计系统、开场与转场效果库

视频展现必须先解析“设计系统 + style profile + 五组 mode”，再由已注册的
组件、场景、开场和转场共同消费。禁止在单个时间区间的渲染代码中重新写字体、
颜色、圆角、阴影、边框、缓动或安全区。完整可执行规范见
`docs/VIDEO_DESIGN_SYSTEM_V1.md`；电影化选择顺序、栏目预算和反网页门禁见
`docs/XINGZHE_STYLE_V3.md`。

可直接解析执行的 62 个预制模板、原创资源、字体和按镜头素材路由见
`references/effect-templates-resources.md`。实际项目应先运行
`kacha templates resolve`，不要只凭效果名称手写参数。

## 风格配置入口

内置默认风格：

```text
config/styles/xingzhe.json
```

配置：

```json
{
  "schemaVersion": "1.0",
  "style": {
    "system": "dahui-video-system",
    "profile": "xingzhe",
    "modes": {
      "show": "tool-share",
      "aspectRatio": "landscape-16x9",
      "language": "zh",
      "surface": "footage",
      "density": "standard"
    },
    "overrides": {
      "palette": {
        "accent": "#E98A2B"
      }
    }
  }
}
```

解析与检查：

```bash
node scripts/kacha.mjs config validate
node scripts/kacha.mjs design validate
node scripts/kacha.mjs design list --kind scene
node scripts/kacha.mjs design preview --scene process_progressive \
  --output /tmp/process-progressive.svg
node scripts/kacha.mjs design gallery \
  --output design/reference-gallery/xingzhe-v3 --overwrite
node scripts/kacha.mjs design motion-preview \
  --output design/reference-gallery/xingzhe-v3/normal-speed-previews --overwrite
node scripts/kacha.mjs production-quality anti-web-audit \
  --contract PROJECT/contracts/production-quality-contract.json --write
node scripts/kacha.mjs effects validate
node scripts/kacha.mjs effects show --kind opening --id editorial_label_reveal
```

解析后的 design digest 必须写入设计预检、版本 delta 和相关 artifact fingerprint。
更换 profile 或 override 后，所有依赖旧 digest 的字幕层、弹窗、信息卡、画中画、
品牌、封面和视觉母版失效；不能只改一处颜色后继续继承旧风格结论。

## 设计模式、组件、场景与风格令牌

设计系统注册表位于 `config/design-system/`。当前提供 5 个 mode 维度、52 个
组件与 69 个场景；项目优先选择场景，再由场景组合组件，不在时间线上直接
拼装一套新视觉语言。

默认 profile 统一管理：

- `palette`：暖灰画布、表面、正文，以及品牌暖橙、信号珊瑚、理性蓝、验证绿；
- `gradients` / `emphasis`：限制渐变面积，并按品牌、冲突、AI 和验证语义分配
  强调色；普通字幕和普通卡片不得滥用；
- `typography`：标题、主字幕、辅字幕、标签和正文的字体 fallback、字重、
  相对字号和字距；
- `subtitles`：位置、宽度、行距、阴影以及亮底深色变体；
- `popups`：填充、文字、圆角、边框、内边距、阴影和人物/字幕安全余量；
- `pip`：圆角、双层边框、阴影和平台安全边距；
- `cards`：普通、当前、已完成节点状态以及禁止整屏闪烁；
- `brand`：栏目标签的位置、颜色和安全边距；
- `cover`：人物高度/宽度、标题宽度和安全区；默认人物不再铺满封面；
- `shooting`：负空间构图、眼睛高度、背景与人物的对比关系；
- `motion`：进入、退出、错峰、缓动、超调和运动模糊规则；
- `defaults`：默认开场、转场、弹窗进入/退出和强调方式。

字体列表不是授权。正式实施前仍需检查真实字体文件、字符覆盖、SHA-256 和
授权。行者风的主/辅字幕默认锁定已授权的真正金陵体
`方正粗金陵简体 / FZJinLS-B-GB`；不存在时阻断，不得静默退回旧替代字体。
其他字体角色只有在风格合同明确允许时才可按顺序降级，并把最终命中字体写入
handoff 和 QC。

全部注册项的当前参考图位于 `design/reference-gallery/xingzhe-v3/`。浏览入口
是 `index.html`；每张图和 `manifest.json` 都锁定 design digest。参考图库
覆盖 52 个组件、69 个场景、8 个 renderer、36 个 layout 和 75 个 motion，
用于统一策划、实现与返工的视觉预期。场景参考必须是全画幅视频峰值帧，
不得再用标题、标签和三态缩略图组成的网页外壳替代真实构图；静态图也不替代正常速度动效验收。

项目高保真层为每个注册效果提供浅暖轻浮层、空间光路、幽默漫画、像素风与暗黑科技风五种
视觉语言的 16:9 / 9:16 独立峰值帧，共 2400 张，并在
`config/effects/motion-contracts/design-effect-library-v3.json` 登记 1200 份
seek-safe 动效合同。幽默漫画必须由真实反差、误会、尺度错位、反应或回扣触发；
像素风必须由系统、规则、计数、状态或量化流程触发。两者都不得把材质偏好变成
全片滤镜，也不得降低人物、事实证据和文字清晰度。声音只声明功能和触发，文件
继续由项目私有 `kacha-profile.json` 精确解析。五套风格的每次正式选择都至少
命中一个注册信号，并记录 `matchedSignal`、`semanticBeatId`、`sourceRange`；
没有命中时记录 `fallbackReasonWhenNotApplied` 并执行合同回退。

五套风格在场景级分别执行“连续编辑旁注”“单次空间导航”
“铺垫—反应—包袱—回扣”“输入—处理—状态—结果”和“异常—证据—裁决—恢复”五种时间与空间语法；
完整决策表、禁用模式、原创母件和生产门禁见
`docs/FIVE_STYLE_EDITING_GRAMMARS.md`。`config/design-system/visual-languages.json`
中的 `grammarSignature` 是机器权威值，效果合同中的 `editingGrammarContract` 必须
与之同源。组件、布局、renderer 和 motion 必须保留注册效果的功能拓扑；只有列入
风格场景白名单的效果允许完整替换叙事构图。只更换卡片材质、颜色、网点、像素边或
玻璃光效不能冒充场景级风格切换，但也不能为了差异化牺牲效果名称与画面的一致性。
生产库还必须通过同风格近似构图零容忍门禁；当前
`docs/generated/five-style-library-qc.json` 记录五套 `nearDuplicatePairCount`、
`orphanAssetCount` 均为 0，同时确认旧版产物、基础图库孤儿文件、跨风格完全重复均为 0。

## 转场库

注册表：

```text
config/effects/transitions.json
```

查看：

```bash
node scripts/kacha.mjs effects list --kind transition
node scripts/kacha.mjs effects show --kind transition --id directional_smooth
```

当前生产级效果：

- `clean_cut`：语义、主体或视角变化，或动作/声音已经连续；
- `soft_dissolve`：时间、空间或情绪的柔和变化；
- `directional_smooth`：有明确运动方向的短柔推；
- `push_slide`：同层级信息页或有空间关系的换页；
- `iris_reveal`：从局部中心进入完整场景；
- `radial_clock`：时间、步骤或循环变化；
- `focus_blur`：注意对象或景深关系变化；
- `zoom_punch`：结论、尺度变化或喜剧落点。景别推进由相邻镜头尺度/关键帧完成，
  连接阶段使用短时 `dissolve`；禁止直接用 FFmpeg `xfade=zoomin` 做 2–4 帧短转场，
  避免人脸瞬间极端放大和高饱和闪帧；
- `diagonal_reveal`：构图或视线本身具有斜向依据；
- `narrow_band_wipe`：固定机位微跳或配对短跳，局部遮切但不整屏闪烁。

`ffmpeg_xfade` 效果必须先把两侧片段规范为相同分辨率、像素格式、帧率和
timebase，并保留不少于注册表 `minHandleFrames` 的真实 handle。transition
会让两段重叠并缩短总时长；`overlay_at_cut` 不改变时间线长度。两者不能互换。

每个转场仍需填写：

- 具体触发理由和连续性基础；
- 运动方向、时长和 handle；
- 是否改变总时长；
- 匹配的声音功能和峰值；
- 干净切 A/B；
- 失败条件和 fallback。

不能因为效果存在于库中就自动使用。注册表解决一致实现和复用，不替代剪辑
判断。

## 开场库

注册表：

```text
config/effects/openings.json
```

当前生产级效果：

- `editorial_label_reveal`：栏目标签、标题和强调线依次建立；
- `kinetic_word_stack`：最多三组关键词分层落位；
- `typewriter_command`：命令、搜索、消息或 AI 输入逐字符出现；
- `statement_punch`：强判断或反差短句的克制冲击；
- `cold_open_marker`：首帧开始说话，只叠加轻量栏目与题眼标记。

Studio 同时把 `z-en-netstyle` 中五种已实现机制列为可选开场：

- `hook_suspense_push`：慢推建立悬念，重读帧揭示；
- `hook_beat_shape_switch`：按 2–4 个真实重拍切换容器形状；
- `hook_spotlight_circle`：圆形蒙版从环境收束到主题；
- `hook_title_behind_subject`：人物抠像在前，大标题在后，副标题补充；
- `hook_text_first_face_reveal`：短判断先建立节奏，再揭示人物。

开场默认从有效声音或动作开始，不生成静态封面视频，不留无意静音。打字开场
的每个可见字符必须与单击键盘音效一一对应；普通标题不得为了“酷炫”使用逐字
打字。`config/effects/production-motion-policy.json` 规定每条视频恰好一个
主开场、0.5 秒内开始变化、3 秒内兑现内容承诺；自定义开场必须提交等价完整
合同，不能以“自定义”为由绕过门禁。

## 可执行预览

FFmpeg 转场和 SVG 序列开场都有本地预览器：

```bash
node scripts/kacha.mjs effects preview \
  --kind transition --id directional_smooth --direction left \
  --output preview-transition.mp4

node scripts/kacha.mjs effects preview \
  --kind opening --id typewriter_command \
  --title "AI EDITS. YOU DECIDE." \
  --output preview-opening.mp4
```

预览只证明效果实现可运行，不证明适合当前内容。正式使用仍需用真实前后片段、
真实画幅、真实字体和项目声音做 1–2 秒 A/B。

## 设计来源与本地化原则

- FFmpeg `xfade` 提供经过验证的 dissolve、wipe、slide、radial、circle、
  blur、zoom 和 reveal 基础实现；咔嚓只保留能对应明确连续性理由的子集。
- Remotion 把 `presentation` 与 `timing` 分开，并区分会缩短时间线的
  transition 与不改变时长的 overlay；咔嚓沿用这一数据边界，但使用本地
  FFmpeg/SVG 实现，不依赖其运行时或付费效果。
- PySceneDetect 的 AdaptiveDetector 通过相邻帧差异的滚动平均降低快速运动
  误报；咔嚓把它作为可选连接候选扫描器，真实连接仍以最终编辑时间线为准。
- OpenTimelineIO 把 clips、tracks、transitions、markers 和 metadata 分层；
  咔嚓沿用“编辑事实与媒体文件分离”的思想管理增量失效和缓存，不自行声称
  兼容全部 OTIO 适配器。

不复制第三方专有视觉资产、模板或付费 shader。这里只积累可解释的机制、
参数合同和原创本地实现。
