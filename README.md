# 咔嚓（Kacha）

[![CI](https://github.com/colorcross/kacha/actions/workflows/ci.yml/badge.svg)](https://github.com/colorcross/kacha/actions/workflows/ci.yml)
[![Website](https://github.com/colorcross/kacha/actions/workflows/pages.yml/badge.svg)](https://colorcross.github.io/kacha/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<p align="center">
  <img src="assets/brand/kacha-og.png" alt="咔嚓 Kacha：本地专业 AI 视频工作流" width="100%">
</p>

**咔嚓是一套支持 Codex 与 Claude Code 的本地专业视频工作流 skill。**

它把策划、精剪、声音、视觉包装、字幕、增量返工和质量检查组织成一条
可执行、可审计、可复现的流程。

[官网](https://colorcross.github.io/kacha/) ·
[English site](https://colorcross.github.io/kacha/en/) ·
[English README](README.en.md) ·
[快速开始](docs/QUICKSTART.md) ·
[安装说明](docs/INSTALLATION.md)

<p align="center">
  <a href="https://colorcross.github.io/kacha/">
    <img src="assets/screenshots/kacha-official-site.png" alt="咔嚓官网桌面端首页" width="100%">
  </a>
</p>

## 它解决什么问题

很多 AI 剪辑方案只会生成效果，缺少完整工程闭环。咔嚓关注的是：

- **先把内容剪对**：删除无效停顿、口误和重复，同时保住完整语义与自然强弱；
- **再把声音和画面做好**：人声分离、降噪、增强、BGM/SFX、字幕、信息卡、
  PIP、蒙版、转场和主体感知重构图按同一套合同执行；
- **返工只动该动的部分**：冻结无关音视频流，复用已有产物，只重渲染受影响层；
- **结果必须可验证**：媒体解码、轨道、尺寸、响度、黑帧、冻帧、静音、
  资源哈希和人工审片分别留证，不把技术通过冒充可发布。

它不是新的剪辑软件，而是协调 FFmpeg、NLE、Remotion、HyperFrames 或项目
指定引擎的专业工作流层。

## 核心特点

| 能力 | 价值 |
| --- | --- |
| 本地优先 | 默认不上传素材；外传、付费生成和发布需要单独授权 |
| 完整工作流 | 从方案、精剪、声音、视觉、字幕一直走到候选版与发布门禁 |
| 增量返工 | 通过依赖图、产物指纹和冻结流哈希减少重复渲染 |
| 视频设计系统 | 统一栏目、画幅、语言、字幕、卡片、PIP、流程图、封面和运动语言 |
| 有理由的剪辑 | 切镜、转场、蒙版、音效和强调效果都必须对应信息、情绪或视角变化 |
| 本地 Beauty v2 | 只做磨皮、美白、匀肤和法令纹弱化；默认关闭，不改变五官和身份 |
| 双 Agent 支持 | 同一套 skill、安装器、配置和门禁同时支持 Codex 与 Claude Code |
| 失败即停 | 输入、授权、能力或 QC 不满足时停止，不用预览伪装最终成片 |

当前版本包含 52 个设计组件、63 个复用场景、10 种转场、5 种开场和
73 项回归检查。详细能力边界见[架构说明](docs/ARCHITECTURE.md)与
[视频设计系统](docs/VIDEO_DESIGN_SYSTEM_V1.md)。

## 最快安装

把下面这段话复制给 Codex 或 Claude Code：

```text
请从 https://github.com/colorcross/kacha.git 安装最新版“咔嚓”skill。
先识别当前 Agent，再检查并运行 scripts/install.sh，安装到对应的用户级
skills 目录；不要覆盖已有安装，不上传或提交我的本地文件、密钥和素材。
安装后运行隐私扫描与回归测试，读取已安装的 SKILL.md，并报告安装路径、
版本和验证结果。
```

也可以直接安装：

```bash
# Codex
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent codex

# Claude Code
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent claude
```

安装位置分别为 `~/.codex/skills/kacha` 和 `~/.claude/skills/kacha`。安装器
不会覆盖已有目标。详见[一句话安装](docs/AGENT_INSTALL.md)。

## 工作方式

```text
任务与授权
   ↓
方案与输入哈希
   ↓
结构精剪 → 声音处理 → 视觉包装 → 字幕校准
   ↓
自动技术 QC
   ↓
候选版与同源人工审片
   ↓
发布门禁
```

四条任务路径：

| 路径 | 适用情况 | 停止条件 |
| --- | --- | --- |
| `proposal_review` | 只要剪辑方案 | `gate-plan` 后停止 |
| `source_edit` | 从原片剪出成片 | 继续到候选版、QC 与人工审片 |
| `content_generation` | 从文稿和素材生成新视频 | 逐项记录素材来源、授权与验收 |
| `local_optimization` | 修改已有版本的指定层或区间 | 冻结无关层，只重建受影响部分 |

最短命令路径：

```bash
node scripts/kacha.mjs gate-plan PROJECT.json
scripts/capability_probe.sh --profile core --output capabilities.json
node scripts/kacha.mjs gate-render PROJECT.json

# 由项目选定的引擎完成真实渲染后
node scripts/kacha.mjs qc PROJECT.json
node scripts/kacha.mjs gate-release PROJECT.json
```

`gate-render` 只证明具备执行条件，不会替你渲染视频；`qc` 是自动技术检查，
不能代替人工通看。

已有成片的局部返工从
[v3 增量工作流](docs/INCREMENTAL_WORKFLOW_V3.md)开始。较弱模型或
Claude Code 可使用 `prepare → next` 确定性执行协议，详见
[V4 工程化优化](docs/ENGINEERING_OPTIMIZATION_V4.md)。

## 配置与依赖

```bash
node scripts/kacha.mjs config init --scope user
node scripts/kacha.mjs config show --anchor /path/to/project
node scripts/kacha.mjs doctor --profile core
```

- 核心门禁需要 Node.js 20+；
- 媒体链路需要 FFmpeg 与 FFprobe；
- 用户配置位于 `~/.config/kacha/config.json`；
- 项目配置使用 `kacha.config.json`，本机覆盖使用已忽略的
  `kacha.local.json`；
- 密钥可放在权限为 `0600` 的 `~/.config/kacha/secrets.json`；
- 配置不能授予上传、付费、发布、覆盖文件或跳过门禁的权限。

完整字段和优先级见[配置说明](docs/CONFIGURATION.md)与
[隐私安全](docs/PRIVACY_SECURITY.md)。

## 质量与安全

- 默认保持原视频像素尺寸和宽高比；
- 含口播的音频先做人声/非人声分离，只让验收通过的人声进入后续处理；
- 自动发现的项目配置不能改写 provider、凭证入口或本机工具路径；
- 网络素材、生成镜头、字体、音乐和音效必须记录来源、授权与哈希；
- Beauty v2 默认关闭，启用后仍需同源同帧动态 A/B 人工复核；
- 只有自动技术 QC、人工审片证据与 release gate 全部通过，才可标记为可交付；
- 仓库不包含用户密钥、第三方库存素材、模型权重或项目私有音效库。

## 查看实际效果

官网展示产品能力和工作流；「行者大灰」账号发布真实剪辑效果、前后对比和
使用演示。使用问题、合作或反馈也可以发邮件至
[dodofun@126.com](mailto:dodofun@126.com)。

<details>
  <summary>展开视频号、抖音和小红书二维码</summary>

  <table>
    <tr>
      <th align="center">视频号</th>
      <th align="center">抖音</th>
      <th align="center">小红书</th>
    </tr>
    <tr>
      <td align="center" valign="top">
        <a href="assets/social/wechat-channels.jpg">
          <img src="assets/social/wechat-channels.jpg" alt="行者大灰视频号二维码" width="220">
        </a>
      </td>
      <td align="center" valign="top">
        <a href="assets/social/douyin.png">
          <img src="assets/social/douyin.png" alt="行者大灰抖音二维码" width="220">
        </a>
      </td>
      <td align="center" valign="top">
        <a href="assets/social/xiaohongshu.jpg">
          <img src="assets/social/xiaohongshu.jpg" alt="行者大灰小红书二维码" width="220">
        </a>
      </td>
    </tr>
  </table>
</details>

## 文档与验证

| 文档 | 用途 |
| --- | --- |
| [快速开始](docs/QUICKSTART.md) | 从模板到门禁的完整示例 |
| [安装与依赖](docs/INSTALLATION.md) | 环境、平台与可选能力 |
| [配置说明](docs/CONFIGURATION.md) | 用户、项目、本机和密钥配置 |
| [架构说明](docs/ARCHITECTURE.md) | 工作流、证据链与模块边界 |
| [视频设计系统](docs/VIDEO_DESIGN_SYSTEM_V1.md) | 视觉 token、组件、场景和 QC |
| [Beauty v2](docs/BEAUTY_V2.md) | 本地美颜能力、门禁与人工复核 |
| [增量返工](docs/INCREMENTAL_WORKFLOW_V3.md) | 依赖复用与冻结流证明 |
| [隐私安全](docs/PRIVACY_SECURITY.md) | 上传、付费、发布与凭证边界 |

仓库验证：

```bash
node tests/run_tests.mjs
bash tests/test_installer.sh
python3 scripts/scan_secrets.py
```

官网验证：

```bash
cd website
npm ci
npm run lint
npm run typecheck
npm test
npm run test:pages
npm audit --audit-level=high
```

## 贡献与许可

提交问题或改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和
[SECURITY.md](SECURITY.md)。代码使用 [MIT License](LICENSE)；仓库内原创
音效适用独立的 [Kacha SFX Asset License](assets/sfx/LICENSE.md)。
