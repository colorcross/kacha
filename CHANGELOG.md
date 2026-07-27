# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构。

## [Unreleased]

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
