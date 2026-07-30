# 配置、默认剪辑要求与密钥

咔嚓把三类内容分开：

1. 仓库可管理的安全默认值；
2. 用户或项目的默认剪辑偏好；
3. 只保存在本机的 API 密钥。

配置可以改变工作参数和默认偏好，不能赋予上传、付费、发布、覆盖源文件或
跳过 QC/人工审片的权限。逐项目 manifest/context 中的授权仍是唯一执行依据。

## 配置层与优先级

从低到高依次为：

1. `config/defaults.json`：随 Skill 发布的安全默认值；
2. `~/.config/kacha/config.json`：当前用户的长期默认值；
3. 从项目锚点向上找到的 `kacha.config.json`：可提交的项目配置；
4. `kacha.local.json`：项目本机覆盖，已加入 `.gitignore`；
5. `--config FILE` 或 `KACHA_CONFIG`：显式配置；
6. 当前命令行参数。

对象字段做深度合并。自然语言要求按 `id` 合并并去重；更高层的同名 `id`
覆盖低层。命令行参数始终优先，例如 `--model-tier`、`--max-frames` 和
`--handle-frames`。

`style.system` 选择视频设计系统，`style.profile` 选择基础视觉风格，
`style.modes` 选择栏目、画幅、语言、表面和密度，`style.overrides` 只覆盖
必要的风格令牌。默认是 `dahui-video-system + xingzhe`（行者风）。解析结果统一
控制字幕、字体、弹窗、信息卡、画中画、品牌、封面、开场、转场、布局与运动
参数，不再散落到时间区间实现中。

`KACHA_CONFIG_HOME` 可以改变用户配置目录；`XDG_CONFIG_HOME` 也受支持。
测试或隔离运行可设置 `KACHA_DISABLE_USER_CONFIG=1`。

### 自动项目配置的信任边界

`kacha.config.json` 和 `kacha.local.json` 会被自动发现，因此不能设置
`providers` 或 `tools`。这样，项目文件不能改写凭证环境变量、MiniMax API
地址或本机可执行程序路径。下列内容只允许放在用户配置，或由用户通过
`--config FILE` 显式选择的配置中：

- `providers.*`；
- `tools.demucsBin`；
- `tools.sfxLibrary`；
- `tools.fontRegistry`。

项目配置仍可设置 `editingDefaults` 和经过范围校验的 `execution` 参数。
显式配置与自动发现文件指向同一路径时，以显式配置身份读取。

## 初始化与检查

创建用户配置和权限为 `0600` 的空密钥文件：

```bash
node scripts/kacha.mjs config init --scope user
```

重复执行是幂等的：已有且有效的文件保持不变，缺少的密钥文件会补建，不会
覆盖用户内容。

创建当前项目的 `kacha.config.json`：

```bash
node scripts/kacha.mjs config init --scope project
```

查看合并后的安全配置和密钥来源状态：

```bash
node scripts/kacha.mjs config show --anchor /path/to/project
```

输出只显示“来自环境、密钥文件、mmx 凭证库或未配置”，不会输出密钥值。

只做校验：

```bash
node scripts/kacha.mjs config validate --anchor /path/to/project
```

密钥文件在 POSIX 系统上只允许当前用户访问。权限过宽时会失败：

```bash
chmod 600 ~/.config/kacha/secrets.json
```

## 参数与自然语言要求

`editingDefaults` 同时支持结构化参数和自然语言：

```json
{
  "schemaVersion": "1.0",
  "editingDefaults": {
    "parameters": {
      "subtitle": {
        "singleLine": true,
        "safeAreaBottomRatio": 0.18
      },
      "beauty": {
        "enabled": false,
        "engine": "beauty-v2",
        "profile": "natural",
        "tuning": {
          "smoothing": 35,
          "whitening": 22,
          "toneEvening": 30,
          "nasolabialSoftening": 24
        }
      }
    },
    "instructions": [
      {
        "id": "calm-delivery",
        "text": "保留淡定、幽默、娓娓道来的表达，不要把自然停顿全部剪掉。",
        "appliesTo": ["source_edit", "local_optimization"],
        "modules": ["dialogue", "bgm", "sfx"],
        "priority": "high"
      },
      "外加画面必须匹配当前视频的对象、动作、角色、时态和整体风格。"
    ],
    "recipeParameters": {
      "beauty": {
        "profile": "natural"
      }
    }
  }
}
```

- `parameters`：供完整流程和代理读取的通用结构化要求；
- `instructions`：字符串或对象数组；对象可限定任务、模块和优先级；
- `recipeParameters`：为 `compile-change` 的稳定配方提供默认参数；
- 当前 change request 的 `parameters` 会覆盖配方默认值。

`editingDefaults.parameters.beauty` 是严格结构，只允许：

- `enabled`: boolean；
- `engine`: 固定为 `beauty-v2`；
- `profile`: `natural` 或 `visible`；
- `tuning`: 可选的四项 0–100 数值：`smoothing`、`whitening`、
  `toneEvening`、`nasolabialSoftening`。

未知字段、字符串形式的真假值、GPUPixel 或未注册档位都会使配置校验失败。
内置值始终为 `enabled=false`；运行 Beauty 渲染时会再次读取当前项目/显式
配置，不能靠命令行 profile 绕过默认关闭。存在 `tuning` 时，本地 Beauty v2
会把四项强度解析到档位参数，并受亮度、gamma、平滑和时间窗口硬上限约束。
可用 `node scripts/kacha.mjs beauty parameters --profile natural
--config FILE` 检查实际解析结果。

`prepare` 把适用于当前任务/模块的要求写入 `agent-packet.json`。
`compile-change` 把配方默认参数、自然语言要求和配置摘要写入当前 delta，
因此较弱模型和长任务续跑不需要重新从对话中猜测用户习惯。

### 默认长听感音频

默认 `execution.voiceEnhancement.preset` 是 `warm-soft`，目标为
`-21 LUFS / -4 dBTP`。对应的结构化混音偏好位于
`editingDefaults.parameters.audio`：

- 人声使用更暖、更柔、不过分强调 2–5 kHz 的知识口播音色；
- 最终 LRA 从 `4.5–5.5 LU` 起步；
- 连续口播 BGM 默认在人声下约 `18 dB`，立体声宽度约 `0.5`；
- 要求 BGM 的正式项目在 `outputs.audioStems` 声明闪避后的
  dialogue/BGM/SFX 组件 stem 与 mix stem，并在 `expectedMedia.audioMix`
  声明可听性合同。自动 QC 默认要求 BGM 低于 dialogue `12–18 dB` 且覆盖
  至少 85% 成片时长，同时要求组件重建 mix 的残差信噪比不低于 `70 dB`、
  最终视频解码音频匹配 mix stem 不低于 `24 dB`；音乐过低或成片漏混都会
  失败；
- SFX 默认在人声下约 `12 dB`，并轻收 `4.5 kHz` 以上高频。

这是经同响度 A/B 批准的默认起点，不替代具体录音的人声诊断。人声已经处理
过时不得重复整链；源声音偏闷、女声、儿童声或音乐主导内容需要项目级覆盖。

增量音频返工可在创建项目时登记最终混音分轨：

```bash
node scripts/create_incremental_manifest.mjs \
  project-context.json version-delta.json artifact-index.json \
  --output incremental-project.json \
  --dialogue-stem output/dialogue-post-mix.wav \
  --bgm-stem output/bgm-post-sidechain.wav \
  --sfx-stem output/sfx-post-mix.wav \
  --mix-stem output/final-mix-stem.wav
```

提供 `--bgm-stem` 会自动启用 `bgmRequired`，并强制同时提供 dialogue 与
mix stem。后续 `qc incremental` 会测量闪避后的实际分轨、重建组件混音并
核对候选成片，拒绝“轨道存在但听不见”或“stem 有音乐、成片漏混”。

## 风格配置

项目可统一换色、字体或动效参数：

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
        "accent": "#E9A92F"
      },
      "motion": {
        "standardFrames": 12
      }
    }
  }
}
```

检查解析结果和效果库：

```bash
node scripts/kacha.mjs config validate --anchor PROJECT_DIR
node scripts/kacha.mjs design validate --anchor PROJECT_DIR
node scripts/kacha.mjs design resolve --show very-ai \
  --aspect portrait-9x16 --language bilingual --anchor PROJECT_DIR
node scripts/kacha.mjs design qc --matrix \
  --output /tmp/design-system-qc.json --anchor PROJECT_DIR
node scripts/kacha.mjs effects validate --anchor PROJECT_DIR
node scripts/kacha.mjs effects show --kind opening \
  --id editorial_label_reveal --anchor PROJECT_DIR
```

`style.overrides` 不能写授权或绕过门禁字段。解析后的 design digest 会进入返工
合同和 artifact fingerprint；digest 变化时依赖旧风格的产物不能继续复用。
完整字段与默认效果见 `references/style-effects-library.md` 和
`docs/VIDEO_DESIGN_SYSTEM_V1.md`。

### 本地生产台

`node scripts/kacha.mjs studio serve` 提供本机生产页面。内置风格、字幕、
声音、BGM、Beauty v2、开场、效果目录和专业自动判断规则统一来自
`config/production-studio.json`。自定义风格只保存在
`~/.config/kacha/studio/styles/`。

页面把长期复用的 `style` 和只影响当前项目的 `projectOverrides` 分开。
`projectOverrides` 可覆盖 `audioPresetId`、`bgmPresetId`、`effectDensity`
与 Beauty v2 的启用、档位和四项参数，不会自动保存为新的永久风格。
同名自定义风格禁止覆盖；需要新版本时必须修改名称。

行者风默认字幕字体是已授权的真正金陵体
`方正粗金陵简体 / FZJinLS-B-GB`。生成项目时会读取 `tools.fontRegistry`
并验证字体文件 SHA-256 和授权状态；失败时停止，不静默换字体。生产台的
字段、生成产物与信任边界见
[`references/production-studio.md`](../references/production-studio.md)。

完整结构示例见
[`examples/kacha.config.json`](../examples/kacha.config.json)。用户级敏感连接项
示例见
[`examples/kacha-user.config.json`](../examples/kacha-user.config.json)。

## 可配置的运行参数

`execution` 当前覆盖：

- 模型档位和 reference token 预算；
- 自动遥测目录、紧凑输出、完整日志上限、失败摘要长度和 usage 自动采集；
- 统一 Timeline IR 的代理/正式编码器、代理最大宽度、CRF 和一次正式编码；
- 内容指纹缓存目录、SHA 校验、物化方式、总容量和高价值产物类型；
- CPU、MPS、视频编码、网络和 I/O 的主机级跨进程资源槽；
- 本地 Whisper MLX 的语言、逐词时间戳、超时、低置信度阈值、模型/服务强
  指纹和缓存；
- 增量返工的默认 handle 帧数；
- 语义网感规划开关、每 10 秒主效果密度、最小间隔、并发主效果数、代表验证
  次数与正式渲染 CRF；
- 画面呼吸的事件密度、最小间隔、运动/静止覆盖率和正式渲染 CRF；
- 口播字幕自动排版、默认布局、同时阅读区上限、普通字幕音效策略和渲染 CRF；
- 项目字体目录自动发现、字体角色路由、限制许可默认策略和公开再分发禁用；
- 视觉证据的模式、帧数、场景阈值、并发数和图片边长；
- MiniMax 关键帧上限、超时、图片大小和网络方式；
- black/freeze/silence 探测与响度测量参数；
- Demucs 模型、设备和时长容差；
- 人声美化 preset、降噪、declick、目标响度、true peak 和声道策略；
- 网络素材的候选数量与超时。

用户配置或显式配置中的 `tools.demucsBin`、`tools.sfxLibrary` 和
`tools.fontRegistry` 可保存
本机绝对路径。环境变量
`KACHA_DEMUCS_BIN`、`KACHA_SFX_LIBRARY` 仍可用于临时覆盖。

HDR/广色域链需要 `zscale`。运行时依次使用 `KACHA_FFMPEG_BIN` /
`KACHA_FFPROBE_BIN`、Homebrew keg-only `ffmpeg-full`，最后才回退 PATH 中的
FFmpeg。`doctor --profile full` 缺少 `filter:zscale` 时必须阻断 HDR 任务，
不能静默按 SDR 处理后宣称等效。
解析后的 FFmpeg/FFprobe 目录会传递给缓存任务、资源调度、遥测、异步抽帧和
Python/Shell 子渲染器；能力探测会实际运行 `-version`，不能只凭文件存在或
`command -v` 判定可用。

口播字幕计划未显式提供 `--font-registry` 时，先读取
`tools.fontRegistry`，再从素材路径向上查找
`.kacha/fonts/authorized.json` 或 `.work/kacha-font-registry-authorized.json`；
仍未找到时，才扫描项目 `Fonts`、`fonts` 或 `assets/fonts`。自动扫描不等于
自动获得商业授权，未开放字体只有存在项目授权记录时才会自动命中。

安全合同、授权、源文件只读、输出不覆盖、完整语义、PTS 共边界和 release
门禁不是可调参数。

以下性能合同也不可通过项目配置关闭：

- `unifiedRender.singleFinalVideoEncode=true`；
- `artifactCache` 必须包含 source separation、ASR、mask、tracking、Beauty、
  styleframe 和 generated media；
- `artifactCache.verifySha256=true`，缓存命中不能退化为只看文件名或大小；
- `telemetry.enabled=true` 且 `telemetry.compactToolOutput=true`，真实执行必须留下
  可审计指标，同时不能把完整日志灌入 agent 上下文；
- `resourceScheduling.scope=host`，且 `capacities.mps=1` 与
  `videoEncode=1`；
- Whisper endpoint 只能指向 loopback；
- Beauty v2 仍默认关闭。

运行和审计方法见
[`PERFORMANCE_TOKEN_STABILITY_V5.md`](PERFORMANCE_TOKEN_STABILITY_V5.md)。

`execution.netstyle` 的默认值会限制正式时间线密度和并发，但不能绕过内容
触发、人物蒙版、真实证据素材或计划摘要门禁。代表验证次数固定为每个效果
一条合适素材；需要验证跨构图或跨帧率时才额外增加样本。

## 密钥

密钥文件默认位于：

```text
~/.config/kacha/secrets.json
```

结构：

```json
{
  "schemaVersion": "1.0",
  "providers": {
    "minimax": { "apiKey": "" },
    "pixabay": { "apiKey": "" },
    "pexels": { "apiKey": "" }
  }
}
```

也可通过 `--secrets FILE` 或 `KACHA_SECRETS_FILE` 指定其他位置。

凭证优先级：

1. provider 对应的环境变量；
2. `secrets.json`；
3. MiniMax 的 `~/.mmx/config.json`/OAuth 凭证库；
4. 网络素材下载器兼容的旧 `media.env`。

默认环境变量名为 `MINIMAX_API_KEY`、`PIXABAY_API_KEY` 和
`PEXELS_API_KEY`，可以在安全配置的 `providers.*.credentialEnv` 中改名。
咔嚓只把密钥注入需要它的子进程，不把值写入执行包、QC、缓存、日志或
Git。MiniMax 密钥通过子进程环境传入，不作为命令行参数暴露在进程列表。

MiniMax 默认 `cn` 区域和无代理直连；可把
`execution.minimaxVision.networkMode` 设置为 `configured_environment`，
或在单次命令中使用 `--use-configured-network`。网络配置不等于外传授权。

## 版本控制建议

- 可以提交：`kacha.config.json`；
- 不要提交：`kacha.local.json`、`secrets.json`、`.env`、真实素材与输出；
- 发布前运行 `python3 scripts/scan_secrets.py`；
- 不要把真实密钥复制到 issue、日志、agent packet 或 project manifest。
