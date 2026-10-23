# 代码动效与风格视频：四套 skill 桥接

Agent 在咔嚓中按叙事任务调用专业创作工具。用户说“这里解释原理”“把实际操作做成产品演示”“做某种风格短片”时，Agent 先判断有没有真实素材可以直接使用，再选下表路径；不要默认加动画，不让用户填写工程合同。

| 需求 | 主工具 | 原生必读 |
|---|---|---|
| 产品功能演示、UI 状态连续变化、可编辑标题、透明包装 | huashu-motion | SKILL.md、director.md、contract.md、product-demo-continuity.md；按需 rhythm/sound |
| 口播里的图表、白板、原理解释、艺术化镜头 | huashu-art-motion | SKILL.md、09-视频动画语法.md、选中语法卡、镜头语言.md；场景创作再读风格卡 |
| 品牌资产、信息结构、方向板、精细版式 | huashu-design | SKILL.md、modules/motion.md 或 infographic.md；保留品牌事实与方向选择 |
| 完整风格短片、真实数据/扫描/档案解释、材质和 3D | lemo-opuscar | 库 AGENTS.md、选中 STYLE.md、DIRECTOR.md、TECHNIQUE.md；先 TREATMENT 后 demo |

这些工具提供方法、参考和渲染器，Agent 仍要根据当前内容编写画面与时序。没有“输入题目就自动生成所有风格”的承诺。`catalog` 中 `authoring-required` 是需要创作的参考卡；研究配方不是已验证 renderer。

## 在剪辑中怎样主动用

- 用户说“这段口播讲三个步骤，看不明白”：先找对应转写区间及真实操作录屏；需要解释关系时用 art 的白板/步骤语法做短镜头，按口播逐项出现，原声不重做。
- 用户说“把我的产品实际流程做成演示”：取当前真实截图或录屏，让 motion 串联同一对象的状态变化；不把重建 UI 当已经上线的功能证据。design 负责品牌资产和关键帧，motion 负责时序。
- 用户说“读书视频这里补一个概念场景”：先核对原书论证及实际引用，用 art/Lemo 画示意；旁白、原文和合成画面在工程里分别标识，不能让艺术镜头替代原文证据。
- 用户说“从稿子生成一支风格短片”：先建立内容/事实合同，选一套主风格，由 Lemo 或 motion 做完整可编辑画面；人声、音乐、音效按原生工具或咔嚓既有声音流程制作，再进入普通媒体与终审流程。
- 用户只说“更好看”：先找具体问题（信息读不清、空间关系难懂、连续性断开、重点出现不对时），再选工具；没有叙事触发不加效果。

同一支片可组合 design 的方向设计、motion 的产品演示和 art 的解释镜头，但共享色板、字体、主体比例、字幕安全区与声音策略。完整风格短片以一个主工具为主，避免按镜头轮流展示工具。

## 发现与诊断

```bash
node scripts/kacha.mjs creative doctor
node scripts/kacha.mjs creative catalog --query whiteboard
node scripts/kacha.mjs creative catalog --query lemo-opuscar
node scripts/kacha.mjs prepare --task content_generation --modules creative
```

默认找本机 Codex/Claude skill。huashu-motion 找已安装 npm 缓存中的具体包，不执行会隐式下载的 `bin/om`；如有多个版本请显式指定 `KACHA_HUASHU_MOTION_RUNTIME`。Lemo 默认 `~/lemo-opuscar`，可设 `LEMO_OPUSCAR_HOME`。其余 skill 可设 `KACHA_HUASHU_ART_MOTION_HOME`、`KACHA_HUASHU_DESIGN_HOME`；OM 方法文档路径可设 `KACHA_HUASHU_MOTION_HOME`。

huashu-design 用 `KACHA_CREATIVE_NODE_MODULES` 指向含 playwright 与 playwright-core 的 node_modules；本机 npm 缓存可自动发现。art/design 检测带 playwright 的 Python，design 还需 pillow，可用 `KACHA_CREATIVE_PYTHON` 指定；缺依赖在建包前明确失败，按原 skill 安装后重试。Lemo 检查本地 playwright-core 与 three。doctor 的 installed 仅为入口存在，missing 会报告已知缺失依赖；浏览器启动、字体与实际渲染仍须实测。

不静默更新第三方库，不将它们的整库或私人资产打入咔嚓包。绑定渲染器源码、已声明的 Python/Node 依赖与适配器实现身份；这不等于浏览器、系统字体、GPU 和动态网络资源全部被隔离或冻结。生产使用本地随工程素材并核查当前原 skill，字体和素材必须有许可。

## 创作、合同与原生渲染

为每段画面建独立目录。目录内包括可编辑源、素材、导演/镜头说明、方向记录和许可记录；相对路径引用本地资产。输出包放在该目录之外。源目录里的 `out/`、`output/`、`.om/` 一并冻结，避免漏掉已创作资产；依赖/缓存目录 `.git`、`node_modules`、`.venv`、`__pycache__` 不复制，入口、证据和 art 素材不得放在这些目录中。

```bash
node scripts/kacha.mjs creative template --provider huashu-art-motion \
  --project /absolute/project/art-clip --output /absolute/project/art-plan.json
node scripts/kacha.mjs creative validate --plan /absolute/project/art-plan.json
node scripts/kacha.mjs creative render --plan /absolute/project/art-plan.json \
  --output /absolute/project/generated/art-v1
node scripts/kacha.mjs creative status --package /absolute/project/generated/art-v1
```

Agent 完成模板的 `reason`、`entry`、`output` 和证据路径后才执行。`output.frames` 是精确帧数，不能把时长近似或输出提示当成实际规格。新方向的选择记录必须来自真实用户决定；已有方向迭代可写 `existing-direction` 并引用已有依据。`technical-fixture` / `mechanical-test` 只用于合成技术测试，禁止 attach 到节目。

- OM：项目根 `index.html`，原生 `check → render → qa`。读取 QA JSON，单帧闪跳阻止回收，停留与硬切留给语义审阅，不能仅凭 CLI 返回码判通过。保留变量与对象 ID，Studio 评论继续按原 `inbox/look/done` 工作流；时序改动创建新回收包。
- art：`clip.json`，运行 `clip_lint → --audit → --spec render`。spec 使用当前 grammar 字段，素材须在项目内；几何、fps、duration 与合同一致。单个版式通常 ≤8 秒，长讲解拆镜，按口播切点组织。艺术 scenes/整片和原生 deliver 使用原工具后走 ingest。
  支持原生 `cues[].frames` 图片路径数组或帧目录，以及 `data.character` 帧目录、`{frames: 目录}`、`{frames: {姿势名: 图片路径}}`。目录仅取当前层 PNG/JPG/JPEG/WebP，所有帧都须随源工程冻结；空目录、目录外素材、符号链接及依赖/缓存排除目录中的素材不能回收。
- design：确定性 Stage/自研 seek 页面，必须有 `window.__ready`、`window.__seek(t)`；先按合同画幅跑 `design_lint.py check`，再用原生 `render-video-seek.js --keep-chrome`，避免默认规则误删 `.title`、`.footer` 等正文。创作源自己明确隐藏播放器控件；不要依赖上游按通用类名删元素。其它 HyperFrames/解说后端走原 skill 后 ingest；不能声称 bridge 原生支持全部设计后端。
- Lemo：根 `index.html` 暴露 READY/render(t)/DUR/TEXTS(t)，运行 `readcheck → video`；STYLE 与 TREATMENT 留在工程。纯画面无屏上文字时显式填 `textPolicy: "no-screen-text"` 和 `textCheckOmissionReason`，回执记录“不适用的声明”而非阅读检查通过，审片仍需核对。画面必须为用户题材创作，不换字套 demo。

渲染作业使用现有 jobs、CPU/编码资源锁；原源只读，`source/` 是冻结副本，`work/` 接收上游写入。失败/取消保留日志，不覆盖半成品：先检查任务树退出，再新建 `v2`。提交/渲染/回收失败记录 `failure.json`；`creative status` 能查询外部回收失败，无回执也无失败记录的导入包只报告未完成待检查，不虚报成功。不自动重试付费、下载模型或上传素材。

```bash
node scripts/kacha.mjs jobs cancel @job:creative-render --project-root /absolute/project/generated/art-v1
```

## 原生完整工程/其它后端回收

```bash
node scripts/kacha.mjs creative ingest --plan /absolute/project/art-plan.json \
  --media /absolute/native-output/shot.mp4 --output /absolute/project/generated/art-v2
```

艺术 scenes 或其它原生后端在合同中写 `renderMode: "external-output"`，`entry` 指向真实项目入口（HTML/JS/MJS/JSON）。该模式只能 ingest，不能假称参数化 render。

ingest 真实核验媒体并冻结源与证据；回执明确 `external-native-output`、`nativeChecks=not_attested`，不能假称跑过原生全部 QA。原生交付说明和审阅报告可以作为项目证据保留。现有图像/音视频模型生成仍走 generated-media-assets 合同，不借此绕过模型、预算、授权和缓存管理。

所有回收都保留 `original.*`，工作画面 `visual.*` 为无声视频。即使原件有音轨也只剥离工作副本；原音频必须在媒体/混音流程中另行选择，不能把插镜音轨自动混到节目。透明只在 OM 和 art 的对应后端开放并实际检查 alpha。整片音乐、人声、音效继续咔嚓政策，大灰AI优先本地库；不继承外部 skill 的固定音效配额。

媒体验收逐包核对视频 PTS 与精确帧数，拒绝平均帧率相同但实际 VFR、旋转标记、非方形像素和时长偏移。WebM 未声明 `nb_frames` 时使用实际视频包计数。工作副本采用无损重封装：非透明支持 H.264/HEVC/AV1/VP9/MPEG-4，透明支持 ProRes/QTRLE/PNG；其它编码请由原工具明确导出兼容格式，桥接不会悄悄有损转码。原件与工作副本完整解码后再次核对身份。

## 加入时间线

看过实际画面、明确对应口播及摆位后执行：

```bash
node scripts/kacha.mjs creative attach --package /absolute/project/generated/art-v1 \
  --timeline /absolute/project/timeline.json --expected-sha CURRENT_SHA256 \
  --start 4 --x 0 --y 0 --width 1920 --height 1080 \
  --reason '此处解释口播的三步处理过程' --output /absolute/project/timeline.art-v1.json
node scripts/kacha.mjs timeline render --plan /absolute/project/timeline.art-v1.json
```

原 EDL、源、字幕、声音和视觉层保留；候选同目录、清除旧通过记录并强制 preview。严格拒绝帧率不一致、非整帧落点、越界、拉伸、截断和过期 SHA；竖屏可使用同画幅源或等比例局部卡片。生成素材永远标 `factualEvidence=false`。叠层遮挡人物、字幕与证据、文字准确性、阅读时间、声画节奏仍须审片，技术回执不代替节目终审。

## 验证

自动行为回归：`node --test tests/creative_skills_tests.mjs`。四原生后端可选烟测：`node tests/creative_native_smoke.mjs /absolute/new-smoke-dir`，使用合成数据与几何图形，失败留证；已有目录不可覆盖。后者证明连接和格式能力，不证明所有风格观感或真实节目质量。
