# AI 生成镜头与第三方素材

## 使用边界

本页的 `generatedShotPlan` / `generated-cache` 只用于生成视频镜头。
BGM 与缺失音效须读取 `references/minimax-audio-fallback.md`，用
`--modules audio_generation` 获取合同；不得把音频塞进要求视频流的镜头缓存执行器。

生成视频和网络素材是可选插镜来源，不是默认升级。真实原片、补拍、项目截图、准确图解或许可明确的真实素材能完成表达时优先使用。

生成镜头不能充当新闻、历史、产品性能、人物经历、研究数据或其他事实证据。概念性画面和合成素材必须在项目记录中标为示意。

## generatedShotPlan

先建立模型无关计划，再编译平台提示词。每条至少包含：

- 对应的最终旁白、时间线区间和表达目的；
- 对象、动作、状态、角色和时态；
- 时长、画幅、分辨率和生成模式；
- 参考素材本地路径、真实哈希、来源、许可和唯一角色；
- 可见动作节拍；
- 景别、机位、构图、焦点、主要运镜和稳定要求；
- A-roll 风格基准；
- 进入与退出连续性；
- 音频策略；
- 少量可验证的负面约束；
- provider、model、transport、请求参数、付费尝试上限和 fallback；
- 完整 QC 目标。

预检：

```bash
node scripts/validate_generated_shot_plan.mjs PLAN.json
```

结构模板：

```bash
node scripts/validate_generated_shot_plan.mjs PLAN.json --template
```

真正付费执行：

```bash
node scripts/validate_generated_shot_plan.mjs PLAN.json --for-execution
```

显式采用命令行生成器时，通过门禁后从内容指纹缓存入口执行生成命令：

```bash
node scripts/kacha.mjs generated-cache run \
  --plan PLAN.json --shot SHOT_ID \
  --output PROJECT/assets/generated/SHOT_ID.mp4 \
  -- GENERATOR [ARGS...]
```

缓存键冻结镜头合同、编译提示词、参考素材与实现哈希、provider/model/transport
和生成器版本，但会把纯交付路径归一化。相同镜头即使换一个本地输出路径，也
应直接物化已验证的缓存文件，不再次提交付费任务。命中报告的
`paidCallExecuted` 必须为 `false`；缓存失效、产物哈希不一致或生成器实现
变化时才允许重新执行。凭证只能通过环境、钥匙串、secret manager 或 mmx
凭证库注入，不能出现在生成命令、计划、缓存键和日志中。

默认预检会检查参考文件、哈希、能力快照有效期、模型、transport、模式、时长、分辨率和画幅。只有 `--template` 可以跳过文件和时效检查；模板通过不代表可调用。

`--for-execution` 还要求 `executionAuthorization.status=authorized` 及证据。

## 能力快照

每次调用前以官方入口、实际 CLI/API 或网页/桌面当前界面为准，记录：

- 验证日期和来源；
- provider transport；
- 当前可用 model 列表；
- 支持模式、时长、分辨率、画幅；
- 暴露参数；
- 原生音频能力；
- 运行证据。

禁止把旧文档、第三方 Skill、曾经可用的模型 ID 或 prompt 中写的“9:16/8K/HDR”当成当前接口能力。

## 提示词编译

核心公式：

`参考素材角色 + 可见主体与状态 + 单一主要动作 + 镜头与构图 + 光线材质 + 动作节拍 + 进出连续性 + 少量禁项`

- 一条原子镜头通常只承担一个主要动作、一个主要运镜和一个情绪变化；
- 图生视频重点写首帧之后发生什么，不重复堆静态描述；
- 动作复杂时拆镜；
- 保持人物、服装、道具数量、空间方向和画幅稳定；
- 预留约 0.25–0.50 秒稳定入点和出点；
- 技术参数必须通过真实接口参数传递，不能用 prompt 口号冒充。

仅当工程显式使用历史 `xingzhe-dahui` 生产包时，行者大灰五栏目封面生成才采用以下既有规则；新 `dahui-ai` 使用真实人物/证据与单问题封面，不继承3D、拼贴或服装要求。历史包封面生成还必须把人物身份、栏目表演和背景编辑语言拆开写入
提示词。共同正向约束为：原创高品质院线级 3D 动画电影人物、温暖圆润但不
幼龄化、本人可识别的成年脸型、黑框矩形眼镜、短刺黑发、深藏蓝运动服、
精细皮肤/发束/眼镜/布料材质、电影级主光与轮廓光。共同负向约束为：幼童脸、
塑料娃娃皮肤、普通单人物 3D 海报，以及复制或近似 Pixar、Disney 或其他
具体角色、影片造型、Logo 与 IP。

提示词还必须明确保留三至五个同主关系的语义场景碎片、前中后景、至少两层
遮挡、尺度反差和纸张/油墨/网点印刷质感；至少一个主题元素位于人物前景，
一个位于人物后景。五栏目分别追加任务推进、沉静思考、真实运动重量、人机
冲突和成年交流感的表演/灯光段落，不得用同一人物姿势批量换标题。

## MiniMax Design：含音频视频的默认入口

生成时明确需要视频内含声音，默认使用本机 **MiniMax Design** 桌面应用；BGM 单独生成默认走
<https://www.minimax.cn/audio>。此选择适用于通用工程、大灰AI和历史包的新生成需求；
既有冻结任务继续其原路由，最新明确要求可覆盖 `config/generation-routing.json`。

1. 定位已安装应用并读取当前界面，使用独立创作页，保留其他项目和输入草稿。核实当前模型、
   音画联合生成开关、规格与下载能力；不根据固定模型名推定能力，也不把“本机桌面版”写成离线生成。
2. 按上面的镜头合同填写画面和声音：旁白/对白、环境声、动作声、音乐分别明确；已有口播不重复生成。
   `audioPolicy=model_audio`，能力快照的 transport 使用 `desktop`，nativeAudio 以当次界面证据填写。
3. 先查项目缓存和应用已有任务，沿用已有需求与预算；每个镜头提交一次并立即记录任务标识或可定位结果。
   状态未知先查询原任务，不因等待而再交给 mmx/API 提交。桌面版不支持要求时保留缺口，不能交付静音视频冒充含音频生成。
4. 下载原件到项目私有目录，保存 SHA、实际渠道/模型、提示词摘要、任务/结果标识、费用与许可记录；
   用 ffprobe 确认视频和音频流均存在，再完整解码、检查两条流的时长与起点并实际试听对应声音。
   音轨存在不等于有声或语义正确；按要求检查静音、同步、对白准确度、口型和人声保护。
5. 原件只读，工作副本导入现有媒体索引/素材工程，并沿用普通素材匹配、剪入、撤销和终审流程。
   应用的生成成功不等于咔嚓成片通过，也不自动触发公开发布。

网页/桌面是 Agent 操作入口，当前没有后台无人值守生成器。UI 下载结果直接按上述流程接回，
不为进入 CLI 缓存而再次生成，不用 `cp` 命令伪装远端生成。`generated-cache run` 只适用于下面显式选择的命令行执行器。

## MiniMax CLI：显式选择或已确认的备用入口

- 每次运行 `mmx --version`、`mmx video generate --help` 和必要预检；
- 竖屏口播插镜优先用真实 9:16 首帧做 I2V；
- 精确首尾构图使用 start/end frame；
- 人物身份连续使用 subject reference；
- Fast 模型只做方向预览，不能自动成为正式素材；
- transport 未暴露的时长、分辨率或 prompt optimizer 不得声称已生效；
- 默认中国区无代理直连；
- provider 区域、base URL、超时和密钥来源由咔嚓配置解析；环境变量优先，
  其次是权限受控的 `secrets.json`，再使用 mmx 自身凭证库；
- 密钥只通过子进程环境注入，不写进命令行、计划、缓存或报告；
- 提交后网络失败先查询任务状态，状态不明不得自动重提。

## Seedance

- 只有当前官方入口真实支持时才使用多模态 `@素材`；
- 每个参考素材绑定唯一角色；
- 默认拆成约 4–6 秒原子镜头；
- 参考视频只明确参考动作、运镜或节奏中的指定项；
- 模型原生音频只在声音本身属于叙事且不与人声冲突时保留；
- 口播 B-roll 默认使用本地后期音频。

## 付费调用

1. 冻结并哈希参考素材；
2. 审首帧、尾帧和角色卡；
3. 确认模型、区域、额度、路由、输出和计费；
4. 用户授权后才提交；
5. CLI 通过 `generated-cache run` 提交；网页/桌面先查项目和应用已有结果，复用命中不得再次付费；
6. 先用最低充分规格；
7. 记录任务 ID、请求摘要和计费不确定性；
8. 下载后本地冻结并 ffprobe；
9. 失败按语义、身份、几何、物理、镜头、时间、风格、构图、音频或 transport 分类；
10. 一次只改变一个主变量；
11. 达到 `maxPaidAttempts` 后停止并走 fallback。

错误人物、物体、动作、身份、关键几何或事实边界必须拒收，不能通过裁切、调色或变速勉强放行。

## 网络素材

完整的当前视频匹配、候选搜索与下载、看图/选段、可撤销剪入流程见 [网络素材工作流](network-materials.md)。Commons 无需 API key；Pixabay/Pexels 继续使用项目凭据。其他网站从已核对的原始来源页建立明确下载列表，不抓取搜索缩略图冒充素材。


优先官方页面、原始发布者、公共领域、Wikimedia Commons 和授权清楚的平台。搜索结果页不能替代来源页。

使用 `scripts/fetch_stock_media.py` 小批量下载 Pixabay/Pexels 素材：

- 查询词包含对象、动作、构图、画幅、年代/地点和风格；
- 每次 1–5 个候选，不囤库；
- 凭据优先从环境变量或 `~/.config/kacha/secrets.json` 读取，旧
  `~/.config/kacha/media.env` 只作兼容；
- 下载使用临时文件和原子落盘；
- 校验 Content-Type、非空文件、实际解码、尺寸、编码和 SHA-256；
- 已存在文件和 manifest 不静默覆盖；
- 保留来源页、作者、许可、检索词、时间和哈希；
- 正式工程只引用本地冻结文件，不使用热链。

`--orientation landscape|portrait|square` 会转换成供应商支持的参数，并复核返回尺寸；
Pexels 视频版本优先选择长边不超过 1920 的最大版本，仅有更大版本时选择其中最小的；
Pixabay 视频沿用 medium 优先、small 备用，并检查实际画幅。
成功搜索在本机缓存 24 小时。`--max-bytes` 默认限制每个文件 512 MiB；下载完成后
真实解码，再以不可覆盖的方式落盘。每个成功素材立即写入来源清单，中途失败保留
`partial` 清单和剩余 `pending` 项，不把未完成项当成可用素材。

下载清单可直接进入本地搜索：

```bash
node scripts/kacha.mjs media index --root PROJECT/assets \
  --catalog PROJECT/assets/manifest.pixabay.photo.TIMESTAMP.ID.json --output media-index.json
node scripts/kacha.mjs media search media-index.json --query '需要的画面'
```

索引会校验清单中的实际 SHA，并保留作者、来源页、许可链接和检索时间。搜索词只记
为 `search_query_unreviewed`，不能冒充实际看过画面的描述；进入时间线前仍须核对素材
内容和具体使用条件。清单的 `pending` 项不会被导入。

IconScout、Lordicon 和 LottieFiles 资源也必须保留来源、许可和哈希。平台允许下载不等于所有叙事用途都安全。
