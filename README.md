# 咔嚓（Kacha）

[![CI](https://github.com/colorcross/kacha/actions/workflows/ci.yml/badge.svg)](https://github.com/colorcross/kacha/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个同时支持 **Codex** 和 **Claude Code** 的本地专业视频工作流 skill。它不承诺“一键出片”，而是把视频策划、精剪、包装、技术检查和人工审片组织成可验证的流程。

核心原则很简单：先解决内容、连接和同步，再做包装；每个效果都要有理由；自动检查不能代替人工通看。

> English documentation starts at [README.en.md](README.en.md).

## 看看实际剪辑效果

扫码关注「行者大灰」，查看咔嚓的视频剪辑效果、前后对比和工作流演示。点击图片可以打开原图扫码。

<table>
  <tr>
    <th align="center">视频号</th>
    <th align="center">抖音</th>
    <th align="center">小红书</th>
  </tr>
  <tr>
    <td align="center" valign="top">
      <a href="assets/social/wechat-channels.jpg">
        <img src="assets/social/wechat-channels.jpg" alt="行者大灰视频号二维码" width="240">
      </a>
    </td>
    <td align="center" valign="top">
      <a href="assets/social/douyin.png">
        <img src="assets/social/douyin.png" alt="行者大灰抖音二维码" width="240">
      </a>
    </td>
    <td align="center" valign="top">
      <a href="assets/social/xiaohongshu.jpg">
        <img src="assets/social/xiaohongshu.jpg" alt="行者大灰小红书二维码" width="240">
      </a>
    </td>
  </tr>
</table>

## 它能做什么

- 在执行前建立可审计的剪辑方案、输入清单、授权边界和回退路径；
- 对已有成片使用 v3 增量返工：只记录本轮差异，按依赖图复用产物，只渲染
  受影响层，并用冻结流哈希证明无关层没有变化；
- 为较低能力模型提供 `prepare → next` 确定性执行协议和稳定错误码，避免依赖
  高推理强度临场拼合同、猜状态；
- 统一管理可版本化参数、用户/项目默认剪辑要求和本机密钥；默认要求同时支持
  结构化参数与自然语言，密钥值不进入工程产物或日志；
- 通过一份可切换的 style profile 统一字幕、字体、色板、弹窗、信息卡、
  画中画边框、品牌和运动语言，默认提供明亮克制的暖色编辑风格；
- 内置可执行的开场与转场效果库，每个效果都带适用理由、handle、声音功能、
  fallback 和真实本地预览，不把“酷炫”当作使用理由；
- 为 Claude Code 生成本地关键帧、人物、人脸、OCR、亮度和时间码证据；只有
  外传、付费服务和显式命令均获授权后，才用 MiniMax 增强少量关键帧语义，
  不上传整段视频；
- 检查内容完整性、切点顺序、同一主体的景别变化和效果合同；
- 处理 dialogue 分离、人声增强、BGM/SFX、响度与音画同步；
- 支持字幕、封面、插镜、画中画、蒙版、人物后文字和主体感知重构图；
- 信息卡、流程图、弹窗、风格化转场和蒙版先做本地样式帧或条件式 Figma 设计预检，再进入实现；
- 对整片 SFX 建立功能调色板和事件审计，拒绝从头到尾反复套用一个音效；
- 含口播的音频处理先做人声/非人声源分离，只让验收通过的独立人声进入后续链路；
- 自动识别项目是否属于既有系列；系列视频的封面和正片共同继承系列标识；
- 用户未明确要求改画幅时，默认保持原视频像素尺寸和宽高比；
- 出片后提供两级中间产物清理：例行阶段只删除用户不需要且可快速重建的缓存；最终清理必须得到“不再修改”的明确确认；
- 对 MiniMax、Seedance 等生成镜头建立能力快照、素材哈希、付费授权和失败回退；
- 对最终媒体执行解码、轨道、尺寸、帧率、响度、黑帧、冻帧和静音线索检查；
- 内置 12 个由行者大灰原创并确认可分发的音效，按标题、ID 和哈希精确选择；
- 只有自动技术 QC、人工审片证据和 release gate 全部通过，才把本地成片标记为可交付。

## 不是什么

- 不是通用视频渲染器，也不替代 Premiere、Resolve、FFmpeg、Remotion 或其他时间线引擎；
- 不会在没有授权时上传素材、调用付费模型或发布内容；
- 不承诺修复严重失焦、削波、运动模糊等源素材缺陷；
- 不承诺流量、完播率或“爆款”；
- 不包含音乐、字体、模型权重、API 密钥或第三方库存素材。

## 最简单的安装方法

把下面这句话复制给你正在使用的 Codex 或 Claude Code：

```text
请帮我安装“咔嚓”skill：从 https://github.com/colorcross/kacha.git 获取最新版；先判断你当前是 Codex 还是 Claude Code，再检查并运行仓库的 scripts/install.sh，安装到对应的用户级 skills 目录。不要覆盖已有安装或修改，不要上传或提交我的任何本地文件、密钥和素材；如果目标已经存在，只报告现状，不做覆盖。安装后运行隐私扫描与回归测试，立即完整读取已安装的 SKILL.md 和任务所需 references，然后告诉我安装路径、版本、验证结果以及现在是否可以直接使用。
```

Agent 会自动下载、安装、验证，并在当前会话直接读取 skill。完整说明见[一句话安装](docs/AGENT_INSTALL.md)。

## 命令行安装

安装器只需要 `curl`、`tar` 和 Python 3；实际运行门禁需要 Node.js 20+，核心媒体检查还需要 FFmpeg。完整依赖见[安装说明](docs/INSTALLATION.md)。

Codex：

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent codex
```

Claude Code：

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent claude
```

安装位置分别为 `~/.codex/skills/kacha` 和 `~/.claude/skills/kacha`。仓库根目录的 `SKILL.md` 是两个 Agent 共用的入口。

## 配置默认剪辑要求

```bash
node scripts/kacha.mjs config init --scope user
node scripts/kacha.mjs config show --anchor /path/to/project
node scripts/kacha.mjs effects validate
node scripts/kacha.mjs effects list --kind transition
```

用户配置位于 `~/.config/kacha/config.json`，项目可提交
`kacha.config.json`，本机覆盖使用已忽略的 `kacha.local.json`。默认剪辑要求
同时支持结构化 `parameters`、自然语言 `instructions` 和增量配方
`recipeParameters`。MiniMax、Pixabay 和 Pexels 密钥放在权限为 `0600` 的
`~/.config/kacha/secrets.json`，环境变量和现有 mmx 凭证仍可继续使用。
自动发现的项目配置不能改写 provider 地址、凭证环境名或本机工具路径；这些
敏感连接项只接受用户配置或显式 `--config`。

视觉风格使用 `style.profile + style.overrides`。默认 profile 是
`warm-editorial`；解析后的 digest 会进入设计和增量返工合同，变更后只让
依赖旧 digest 的视觉产物失效。开场/转场列表与本地预览见
`references/style-effects-library.md`。

配置不能授予上传、付费、发布或跳过门禁的权限。完整字段、优先级和示例见
[配置说明](docs/CONFIGURATION.md)。

## 最短使用路径

### 较弱模型或 Claude Code

```bash
node scripts/kacha.mjs doctor --profile claude-vision
node scripts/kacha.mjs prepare \
  --task local_optimization --modules beauty \
  --agent claude --model-tier economy --project /path/to/project.json \
  --output /path/to/agent-packet.json
node scripts/kacha.mjs next /path/to/project.json
```

代理完整读取 packet 的 `readOrder`，但每次只执行一个 `nextAction`。常见返工
可用 `examples/change-request.json` 和 `compile-change` 编译成增量项目。
Claude Code 先读本地 `visual-evidence.md/.json`；MiniMax 是条件增强，不是
默认依赖。`prepare` 会自动补齐弱模型/Claude 支持 reference，并对中文友好
的 token 预算做超限阻断。详见
[V4 工程化优化](docs/ENGINEERING_OPTIMIZATION_V4.md)。

### 首剪或结构重做

1. 让代理完整读取 `SKILL.md`，并按任务读取对应 `references/`。
2. 从 `examples/edit-proposal.json`、`examples/edit-plan.json` 和 `examples/project-manifest.json` 复制项目文件。
3. 将模板中的占位值替换为真实文件、SHA-256、目标规格和授权证据。
4. 依次运行门禁：

```bash
node scripts/kacha.mjs gate-plan PROJECT.json
scripts/capability_probe.sh --profile core --output capabilities.json
node scripts/kacha.mjs gate-render PROJECT.json
node scripts/kacha.mjs qc PROJECT.json
node scripts/kacha.mjs gate-release PROJECT.json
```

`gate-render` 只表示项目具备执行条件，不会替你渲染视频。`qc` 只做自动技术检查，不等于人工审片完成。

可先用 `route_references.mjs` 根据任务和模块生成最小 reference 清单，避免把
所有文档一次性放进上下文。

### 已有基线上的局部返工

```bash
node scripts/init_incremental_project.mjs BASE.mov \
  --project-id my-video --output-dir /path/to/project

node scripts/create_version_delta.mjs /path/to/project/project-context.json \
  --write /path/to/project/v2-delta.json --new-version v2 \
  --type beauty_adjust --output-video /path/to/project/v2.mov

node scripts/create_incremental_manifest.mjs \
  /path/to/project/project-context.json /path/to/project/v2-delta.json \
  /path/to/project/artifact-index.json \
  --output /path/to/project/v2-project.json

node scripts/kacha.mjs gate-plan /path/to/project/v2-project.json
node scripts/kacha.mjs qc /path/to/project/v2-project.json
node scripts/create_incremental_review.mjs /path/to/project/v2-project.json
node scripts/kacha.mjs gate-candidate /path/to/project/v2-project.json
```

只改画面时会校验音频流 SHA-256 未变；只改声音时会校验视频流未变。候选版
不能冒充最终版，只有 `release_candidate` 完成全量人工审片后才能通过
`gate-release`。完整说明见
[v3 增量工作流](docs/INCREMENTAL_WORKFLOW_V3.md)。

用户反馈涉及风格不统一、动效抢跑、弹窗遮挡或连接生硬时，优先用
`compile-change` 的 `style`、`timing_sync`、`popup_layout`、`connections`
配方。配方会要求扫描全片同类问题；连接候选还可以先用：

```bash
node scripts/kacha.mjs connections FINAL.mov \
  --output connection-candidates.json --cut-list timeline-cuts.json
```

完整示例见[快速开始](docs/QUICKSTART.md)。

真实生产中反复出现的问题与对应门禁见[生产流程加固](docs/PRODUCTION_HARDENING.md)。

## 四条任务路径

| 路径 | 用途 | 是否修改文件 |
| --- | --- | --- |
| `proposal_review` | 只给方案或 review | 否 |
| `source_edit` | 精剪现有音视频 | 是 |
| `content_generation` | 从文稿、书籍、笔记或主题生成内容 | 是 |
| `local_optimization` | 只改指定字幕、声音、封面、插镜或版本 | 是 |

双语、AI 镜头、第三方素材、专用人像模型、上传和发布都是按需模块，不自动启用。

## 仓库结构

```text
.
├── SKILL.md                 # skill 入口与不可降低的原则
├── agents/openai.yaml       # OpenAI/Codex 展示配置
├── references/              # 按任务加载的详细合同
├── assets/sfx/              # 12 个原创音效、工作副本、哈希与资产许可
├── config/                  # 无密钥的内置运行默认值
├── examples/                # v2 首剪与 v3 增量 JSON 模板
├── scripts/                 # 确定性状态机、视觉证据、门禁、媒体处理与 QC
├── tests/run_tests.mjs      # 无第三方 npm 依赖的回归测试
└── docs/                    # 安装、快速开始、架构和安全文档
```

设计与数据流见[架构说明](docs/ARCHITECTURE.md)。

## 隐私与安全

咔嚓默认本地处理。仓库不需要、也不应提交任何真实密钥。

- 安装器通过 GitHub 公开源码归档下载，不读取 Git 凭据；
- API 凭据只通过环境变量、mmx 凭证库或权限受控的本机密钥文件提供；
- `.env`、私钥、素材、模型、输出和本机能力快照已加入 `.gitignore`；
- 发布前运行 `python3 scripts/scan_secrets.py`；
- 示例中的 `PIXABAY_API_KEY`、`PEXELS_API_KEY` 只是变量名，不是密钥值；
- 生成、上传、购买授权和发布仍需单独授权。

详见[配置说明](docs/CONFIGURATION.md)、[隐私与安全](docs/PRIVACY_SECURITY.md)
和[安全政策](SECURITY.md)。

## 测试

```bash
node tests/run_tests.mjs --suite incremental
node tests/run_tests.mjs --suite audio
node tests/run_tests.mjs --suite visual
node tests/run_tests.mjs
bash tests/test_installer.sh
python3 scripts/scan_secrets.py
```

分层测试只生成当前套件需要的媒体夹具；全量测试不会读取或修改你的真实项目
素材。运行 `node tests/run_tests.mjs --list` 可查看套件归属。

## 平台说明

- 核心 JSON 门禁和多数 FFmpeg 流程可在 macOS/Linux 使用；
- `generate_vision_masks.swift` 依赖 macOS 的 Vision、AVFoundation 和 CoreImage；
- Claude Code 可通过 `visual-evidence` 使用 Apple Vision 本地语义证据；Apple
  Vision 不可用时可在明确授权后使用 `mmx vision describe`；
- Demucs、MiniMax/mmx、素材平台 API、Resolve 等均为可选能力，必须在当前机器上真实探测；
- 不同 FFmpeg 构建包含的 filter 不同，应以 `capability_probe.sh` 的结果为准。

## 贡献

欢迎提交 issue 和 pull request。修改媒体链路时必须保留“失败即停”、源素材只读、输出不覆盖和自动 QC 不冒充人工审片这些边界。详见[贡献指南](CONTRIBUTING.md)。

## 许可证

代码与文档采用 [MIT License](LICENSE)。`assets/sfx` 中的原创音效采用其目录内的[音频资产许可](assets/sfx/LICENSE.md)。第三方素材、字体、模型和平台内容不随本仓库授权。
