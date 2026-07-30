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
[生产台 Figma 设计稿](https://www.figma.com/design/uXfiviOI5rgi56awnD3Iut?node-id=1-2) ·
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
  全输入哈希、最终混音和人工审片分别留证，不把技术通过冒充可发布。

它不是新的剪辑软件，而是协调 FFmpeg、NLE、Remotion、HyperFrames 或项目
指定引擎的专业工作流层。

## 核心特点

| 能力 | 价值 |
| --- | --- |
| 本地优先 | 默认不上传素材；外传、付费生成和发布需要单独授权 |
| 本地生产台 | 选素材、风格、开场和指定效果，生成可交给 Agent 执行的项目合同 |
| 完整工作流 | 从方案、精剪、声音、视觉、字幕一直走到候选版与发布门禁 |
| 增量返工 | 通过依赖图、产物指纹和冻结流哈希减少重复渲染 |
| 一次正式编码 | EDL、动效、字幕和混音编译成统一 Render Graph，并冻结所有输入内容身份 |
| 高成本复用 | ASR、人声分离、蒙版、Beauty、样式帧和生成素材按模型/实现强指纹缓存 |
| 弱模型稳定生产 | 五种紧凑 packet + 十三阶段文件证据状态机，减少上下文与临场猜测 |
| Agent 对话控制面 | 自然语言仍是主入口；Mutation Delta、确定性对象 `@` 引用、本地句向量素材搜索和终态受保护的异步任务在后台运行 |
| 可观测性能 | 自动采集耗时、Token 来源、缓存和编码次数；重型资源跨项目共享主机锁 |
| BGM 成片证明 | 测量可听性、重建组件混音，并验证最终视频没有漏混音乐 |
| 视频设计系统 | 统一栏目、画幅、语言、字幕、卡片、PIP、流程图、封面和运动语言 |
| 预制效果与资源 | 60 个模板统一解析开场、转场、语义画面、贴纸、纵深、关键帧、并列句、字幕和呼吸；附原创视觉资源与许可路由 |
| 画面呼吸 | 用语义驱动的推近、停稳、释放、横移和重音冲击改善节奏，避免全片持续缩放 |
| 口播字幕编排 | 普通单行优先，按真实信息关系使用左右、上下或人物前后景排版并联动功能音效 |
| 项目字体路由 | 行者风默认使用已授权的真正金陵体；读取真实文件、字符覆盖、授权与哈希，不静默换字体 |
| 有理由的剪辑 | 切镜、转场、蒙版、音效和 33 种语义网感机制都由带时间文稿触发并写入正式时间线 |
| 本地 Beauty v2 | 只做磨皮、美白、匀肤和法令纹弱化；默认关闭，不改变五官和身份 |
| FaceFusion 候选处理 | 按项目授权接入换脸、口型同步、人脸修复和后期增强；冻结模型许可、输入哈希并强制专项人工 QC |
| 双 Agent 支持 | 同一套 skill、安装器、配置和门禁同时支持 Codex 与 Claude Code |
| 失败即停 | 输入、授权、能力或 QC 不满足时停止，不用预览伪装最终成片 |

当前版本包含 52 个设计组件、69 个复用场景、60 个预制效果模板、18 个公共
核心资源、10 种转场、5 种开场、5 种画面呼吸运动、7 种口播字幕布局，以及
从 6 条参考视频中验证出的 33 种语义网感机制。机制可从最终带时间文稿生成
帧级计划、进入完整视频渲染，并通过摘要、资源、时序与媒体保真门禁。
详细能力边界见
[网感剪辑系统](references/z-en-editing-system.md)、
[画面呼吸与字幕字体系统](references/visual-breathing-caption-typography.md)、
[效果模板与资源目录](references/effect-templates-resources.md)、
[架构说明](docs/ARCHITECTURE.md)与
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

不想手写配置时，先启动本地生产台：

```bash
node scripts/kacha.mjs studio serve
```

页面只读取本机路径，支持四套内置风格、自建风格、开场选择和多组
“自然语言位置 + 指定效果”。五步流程会分别处理素材、风格、声音、效果和
交付；129 个注册效果支持搜索，生成前必须通过视频、输出目录、授权字体、
设计系统与效果解析预检。它不会上传素材、覆盖源片或跳过质量门禁。详见
[本地视频生产台](references/production-studio.md)。

<p align="center">
  <a href="https://www.figma.com/design/uXfiviOI5rgi56awnD3Iut?node-id=1-2">
    <img src="docs/assets/kacha-production-studio.png" alt="咔嚓本地视频生产台" width="100%">
  </a>
</p>

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
node scripts/kacha.mjs render PROJECT.json

node scripts/kacha.mjs qc PROJECT.json
node scripts/kacha.mjs gate-release PROJECT.json
```

登记了 `plans.timeline` 的项目可由 `render` 在一个执行图中完成真实渲染；
`gate-render` 本身仍只证明具备执行条件。`qc` 是自动技术检查，不能代替
人工通看。

已有成片的局部返工从
[v3 增量工作流](docs/INCREMENTAL_WORKFLOW_V3.md)开始。较弱模型或
Claude Code 可使用 `prepare → next` 确定性执行协议，详见
[V4 工程化优化](docs/ENGINEERING_OPTIMIZATION_V4.md)与
[V5 性能、Token 和弱模型稳定生产](docs/PERFORMANCE_TOKEN_STABILITY_V5.md)。
日常仍可直接在 Agent 中聊天；操作级 Delta、本地素材索引、后台任务、
placeholder、对象短引用和双端安装状态见
[Agent 对话控制面](docs/AGENT_CHAT_CONTROL_PLANE.md)。

## 配置与依赖

```bash
node scripts/kacha.mjs config init --scope user
node scripts/kacha.mjs config show --anchor /path/to/project
node scripts/kacha.mjs doctor --profile core
```

- 核心门禁需要 Node.js 20+；
- 媒体链路需要 FFmpeg 与 FFprobe；
- 本地字体索引与字幕图层渲染需要 Python 3、Pillow 和 fontTools；
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
- 本地字体文件不会进入公开仓库；项目授权记录只用于当前本地制作范围；
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
| [本地视频生产台](references/production-studio.md) | 五步配置、预检、项目生成与信任边界 |
| [生产台深度 review](docs/STUDIO_REVIEW.md) | 功能、流程、UI、安全与验证结论 |
| [安装与依赖](docs/INSTALLATION.md) | 环境、平台与可选能力 |
| [配置说明](docs/CONFIGURATION.md) | 用户、项目、本机和密钥配置 |
| [架构说明](docs/ARCHITECTURE.md) | 工作流、证据链与模块边界 |
| [性能与弱模型稳定生产](docs/PERFORMANCE_TOKEN_STABILITY_V5.md) | 一次编码、局部预览、缓存、Token 和审计 |
| [视频设计系统](docs/VIDEO_DESIGN_SYSTEM_V1.md) | 视觉 token、组件、场景和 QC |
| [Beauty v2](references/beauty-v2.md) | 本地美颜能力、门禁与人工复核 |
| [FaceFusion](references/facefusion.md) | 换脸、口型同步、人脸修复、模型许可与专项 QC |
| [效果模板与资源](references/effect-templates-resources.md) | 60 个模板、原创资源、字体/SFX 与素材路由 |
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
