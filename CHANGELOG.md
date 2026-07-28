# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构。

## [Unreleased]

### Added

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
- 增加 Apple Vision 人脸关键点保护皮肤蒙版、`beauty-light` 与 `beauty-plus`。
- 增加 12 个由行者大灰原创的音效、精确 title/ID/hash 验证和独立资产许可。
- 增加生产流程加固文档，把打字、画中画、分屏、插镜、生成镜头和 2.5D 的失败条件写入门禁。

### Changed

- `SKILL.md` 改为按任务路由的精简入口，详细规则下沉到 reference，减少局部
  返工时的重复上下文。
- Skill 名称由 `kacha-kacha` / “咔嚓咔嚓”统一为 `kacha` / “咔嚓”。
- Codex 默认安装目录改为 `~/.codex/skills/kacha`，并保留 Demucs 与媒体配置的旧路径读取兼容。

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
