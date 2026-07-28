# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构。

## [Unreleased]

### Added

- 增加咔嚓独立产品品牌规范与中英文官网：从用户提供的剪刀/播放 Logo 建立
  暖白、石墨黑和橙色切点视觉系统，覆盖 Logo、安全留白、色彩、字体、栅格、
  组件、动效、无障碍、文案边界与社交分享图；官网提供真实安装命令、能力
  证据、工作流、默认关闭 Beauty v2 和人工审片边界。
- 将经同响度 A/B 确认的 `warm-soft` 设为默认知识口播预设：固化低中频厚度、
  2–5 kHz 柔化、轻度去齿音与瞬态控制，并加入 `-21 LUFS / -4 dBTP`、
  BGM/SFX 相对人声关系和立体声宽度默认值。
- 人声目标响度改为测量后使用常量增益，只在峰值越界时限幅，避免最终动态
  loudnorm 抹平已认可的长听感强弱。
- 增加 `dahui-video-system` 视频设计系统：5 个可组合模式、52 个组件和
  63 个场景统一覆盖栏目、画幅、语言、明暗、密度、字幕、卡片、PIP、分屏、
  流程、数据、连接、封面与结尾；提供 8 个真实 renderer、36 个 layout、
  75 个 motion、字体探测、实施清单和全模式状态矩阵 QC。
- 增加本地 Beauty v2：Apple Vision 皮肤与法令纹区域追踪结合 FFmpeg
  主讲人身份锁定与局部处理，只支持磨皮、美白、匀肤和法令纹弱化，并提供
  自然/可见两档、默认关闭执行门禁、逐帧跟踪报告和同帧 A/B。
- 设计样式帧与 Beauty v2 技术报告新增实现链 digest；解析器、渲染器、遮罩
  或合成算法变化会自动使旧证据失效。
- 增加“中文版自然口播”参考合同：同响度下同时约束 LRA、峰均动态、频谱、
  声像和语气强弱；支持固定机位单人口播的 `centered_dialogue` 决策，并禁止
  用末端动态 loudnorm 抹平已经确认的人声起伏。
- 增加统一 `style.system + style.profile + style.modes + style.overrides`
  视觉配置，集中管理色板、字体、字幕、弹窗、信息卡、PIP、品牌、布局和运动
  令牌；默认提供 `dahui-video-system + warm-editorial`，并用 design digest
  驱动依赖失效。
- 增加 10 种生产级转场与 5 种开场的本地效果注册表、理论适用条件、声音
  功能、fallback 和可执行 FFmpeg/SVG 预览器。
- 增加最终时间线连接候选扫描器，合并编辑切点与像素场景变化候选，生成逐点
  handle 和正常速度复核清单。
- 增加 `style`、`timing_sync`、`popup_layout`、`connections` 返工配方和
  `full_timeline_same_signature` 同类问题回归扫描。
- 增加统一分层配置：内置、用户、项目、本机和显式配置按优先级深度合并；
  默认剪辑要求同时支持结构化参数、自然语言和增量配方参数。
- 增加独立 `0600` 密钥文件、环境变量/mmx 凭证兼容、provider 子进程私密
  注入、脱敏配置报告，以及 MiniMax/Pixabay/Pexels 凭证入口。
- 把模型预算、增量 handle、视觉证据、MiniMax、技术 QC、Demucs、人声美化、
  音效库和网络素材参数接入统一配置，并记录无密钥配置 digest。
- 自动发现的项目配置禁止改写 provider/凭证入口和本机工具路径；这些敏感项
  只接受用户配置或显式配置，避免项目文件劫持用户级密钥与可执行程序。
- 增加 V4 确定性执行层：`doctor`、`prepare`、`next`、`compile-change`、
  `visual-evidence` 与 `vision-enrich` 统一入口。
- 增加较弱模型执行包、唯一下一步状态机、稳定 `KACHA-E100`–`E500` 错误码
  和常见增量返工配方编译器。
- 增加 Claude Code 本地视觉证据：关键帧、contact sheet、时间码、亮度、
  Apple Vision 人脸/人物/OCR 与低 token Markdown 摘要。
- 增加外传/付费服务/显式命令三重授权的 MiniMax 关键帧语义增强、无代理
  直连、帧哈希复核、并发锁、结构校验、有限帧上传、结果缓存和零上传
  dry-run。
- 增加项目/视觉构建互斥锁、进程内媒体探测与哈希复用，以及候选阶段快速文件
  身份复核；最终 release 仍强制完整 SHA-256。
- 增加基于 path/size/mtime/ctime/inode 强身份的跨进程 ffprobe 缓存，文件
  变化自动失效，缓存失败不阻断主流程。
- 增加 v3 增量返工架构：稳定项目上下文、版本差异、产物依赖索引、L0–L3
  影响推导、最小渲染计划和运行指标。
- 增加分层 QC：只改画面时证明音频 elementary stream 未变，只改声音时证明
  视频流未变；封面专项版本不触发视频渲染。
- 增加 `preview`、`candidate`、`release_candidate` 三级版本意图和独立
  candidate/release 门禁。
- 增加内容指纹缓存复用、依赖传播失效和从 artifact index 推导的安全清理
  候选；显式复用请求不能绕过失效规则。
- 增加可按 `incremental`、`audio`、`visual`、`qc` 等范围运行的分层回归测试，
  媒体夹具改为按需生成。
- 增加中间产物两级清理合同、dry-run 清单、安全删除脚本和保护路径门禁；例行清理只处理用户不需要且可快速重建的缓存，最终清理要求明确的不再修改确认。
- 增加口播音频源分离硬门禁，只允许验收通过的独立人声进入后续处理，非人声 residual 禁止回混。
- 增加系列身份检测合同；检测到系列时，视频和封面必须同时继承系列标识。
- 增加默认原画幅门禁；用户未明确指定时保持源视频尺寸和宽高比。
- 明确每次 Skill 更新后立即同步 Codex/ChatGPT 与 Claude Code 并做一致性验证。
- 增加高影响视觉模块的设计预检合同，支持本地样式帧与条件式 Figma 交接。
- 增加整片 SFX 调色板、逐事件映射、重复率和功能多样性门禁。
- 增加人物头部完整性、切镜/转场决策、信息模块头像避让和人物后文字设计门禁。
- README 增加视频号、抖音和小红书二维码，引导用户查看实际剪辑演示。
- 扩充独立英文 README，并增加英文的一句话安装、依赖、快速开始、架构与隐私安全文档。
- 增加创意锁、局部优化计划、declared/average FPS 双检查和 MOV 时间基安全重封装。
- 增加 Apple Vision 人脸关键点保护皮肤蒙版和法令纹区域蒙版。
- 增加 12 个由行者大灰原创的音效、精确 title/ID/hash 验证和独立资产许可。
- 增加生产流程加固文档，把打字、画中画、分屏、插镜、生成镜头和 2.5D 的失败条件写入门禁。

### Changed

- 官网依赖升级到已修复的 Next/React/Vite/Cloudflare 版本，改用 Oxlint，
  并通过生产与完整开发依赖的零漏洞审计。
- GitHub 归档安装器现在和本地同步器一样排除 `website/`，安装器测试同时
  断言 Codex/Claude skill 目录不包含官网源码和构建依赖。
- 美颜默认改为关闭；明确启用时只允许 Beauty v2，禁止改变脸型、五官或身份。
- 高影响视觉设计预检现在强制记录设计系统、版本、摘要、场景、组件和五组
  模式，并核对真实样式帧/实施清单 hash、字体和 token，避免伪造证据或局部
  参数绕过统一视觉规范。
- Beauty v2 改为只处理持续锁定的主讲人；多人歧义帧使用空蒙版，皮肤范围
  扩展到耳和颈部，Y/U/V 遮罩平面显式隔离，默认关闭不能被脚本 profile
  参数绕过。
- 信息卡逐项点亮改为持久底图和局部状态更新；弹窗碰撞按阴影、装饰和运动
  超调后的完整边界检查；亮底字幕使用统一深色变体。
- 风格变更强制失效视觉母版、字幕叠层、布局和封面缓存；口播触发动效改为
  每事件帧级 cue，不再允许未经复核的整片统一偏移。
- 完整 QC 把解码、black/freeze/silence 和 loudness 合并为一次媒体遍历；
  增量 QC 也按实际变化层复用同一次遍历，移除重复全片解码。
- reference token 预算改为中文友好的保守估算；`prepare` 增加
  economy/balanced/frontier 档位、自动支持 reference 和超预算阻断。
- `SKILL.md` 改为按任务路由的精简入口，详细规则下沉到 reference，减少局部
  返工时的重复上下文。
- Skill 名称由 `kacha-kacha` / “咔嚓咔嚓”统一为 `kacha` / “咔嚓”。
- Codex 默认安装目录改为 `~/.codex/skills/kacha`，并保留 Demucs 与媒体配置的旧路径读取兼容。

### Removed

- 废弃 GPUPixel 与旧 `beauty-light` / `beauty-plus` 路由；不再把私有后端、
  云端服务或生成式人脸修复作为美颜 fallback。

## [1.1.0] - 2026-07-27

### Added

- 支持通过一句自然语言提示让 Codex 或 Claude Code 自动安装、验证并在当前会话加载；
- 增加安全、幂等的 `scripts/install.sh`；
- 增加 Codex 与 Claude Code 双平台安装文档和安装器回归测试。

## [1.0.0] - 2026-07-27

### Added

- 首次公开发布；
- v2 十三阶段视频工作流；
- `gate-plan`、`gate-render`、`qc`、`gate-release` 统一入口；
- 方案、剪辑、生成镜头和 release report 模板；
- 能力探测、媒体对齐、蒙版、人声、自动技术 QC 等脚本；
- 19 项回归测试；
- 安装、快速开始、架构、隐私、安全和贡献文档。

### Changed

- 移除作者专属品牌和商业字体硬编码，改为项目可配置的创作者 profile。
