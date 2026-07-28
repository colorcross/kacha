# 安装与依赖

## 基础环境

安装器最低需要：

- Python 3.10 或更高版本
- `curl`
- `tar`

运行完整工作流建议：

- Git
- Node.js 20 或更高版本
- FFmpeg 与 FFprobe
- `jq`

macOS 可使用 Homebrew：

```bash
brew install node ffmpeg jq
```

Ubuntu/Debian：

```bash
sudo apt-get update
sudo apt-get install -y nodejs ffmpeg jq python3
```

安装后先确认版本：

```bash
node --version
ffmpeg -version
ffprobe -version
jq --version
python3 --version
```

## 推荐：让 Agent 自动安装

把下面这句话发给当前 Codex 或 Claude Code：

```text
请从 https://github.com/colorcross/kacha.git 安装“咔嚓”skill。判断你当前是 Codex 还是 Claude Code，检查并运行 scripts/install.sh，完成隐私扫描和测试，然后立即读取安装后的 SKILL.md，让它在当前会话可直接使用。不要覆盖已有修改，不要上传我的本地文件。
```

完整提示、安全行为和命令行方式见[一句话安装](AGENT_INSTALL.md)。

## Codex

当前用户级目录：

```text
~/.codex/skills/kacha
```

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent codex
```

## Claude Code

个人 skills 目录：

```text
~/.claude/skills/kacha
```

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent claude
```

Claude Code 会监控已经存在的 skills 目录；如果安装器首次创建了顶层 `~/.claude/skills`，可能需要重启 Claude Code 才能进入自动发现列表。当前会话仍可以让 Claude 直接读取安装后的 `SKILL.md` 并立即使用。

两个 Agent 都读取同一个标准 `SKILL.md` 和 supporting files，不需要维护两套内容。

## 能力探测

核心能力：

```bash
cd ~/.codex/skills/kacha
scripts/capability_probe.sh --profile core --output capabilities.json
```

条件能力 profile：

- `voice`：`jq`、Demucs 和音频 filters；
- `masks`：macOS Apple Vision 与蒙版 filters；
- `motion`：稳定、补帧和混帧 filters；
- `geometry`：镜头和几何修正 filters；
- `hdr`：`zscale` 与 `tonemap`；
- `ai-video`：当前可用的 `mmx` 接口；
- `claude-vision`：本地视觉证据，以及 Apple Vision 或已认证 MiniMax 视觉
  中至少一个语义后端；
- `full`：检查所有已声明能力。

能力缺失时脚本返回非零状态。请降级方案或安装明确需要的依赖，不要绕过门禁。

## 可选依赖

### Demucs

用于生成 dialogue 与 residual 候选。建议使用独立虚拟环境，避免污染系统 Python。脚本按以下顺序查找：

1. `KACHA_DEMUCS_BIN`；
2. `$XDG_DATA_HOME/kacha/demucs-venv/bin/demucs`；
3. 旧版迁移期间的 `$XDG_DATA_HOME/kacha-kacha/demucs-venv/bin/demucs`；
4. `demucs` 命令；
5. `python3 -m demucs`。

源分离属于有损推断，安装成功不等于结果可直接使用，仍需同响度 A/B 和 residual 泄漏检查。

### Apple Vision

`scripts/generate_vision_masks.swift` 仅支持 macOS，需要 Swift、Vision、AVFoundation、CoreImage 和 AppKit。Linux 用户应把蒙版能力标为不可用，或替换为经过验证的其他引擎。

### 素材平台

`scripts/fetch_stock_media.py` 支持 Pixabay/Pexels。凭据只从环境变量读取：

```bash
export PIXABAY_API_KEY="在本机设置，不要写进仓库"
export PEXELS_API_KEY="在本机设置，不要写进仓库"
```

不要把以上命令连同真实值保存到项目文档或 shell 历史共享文件中。

## 验证安装

```bash
node tests/run_tests.mjs
bash tests/test_installer.sh
python3 scripts/scan_secrets.py
```

回归测试通过只证明仓库自带门禁和媒体夹具工作正常，不证明某个真实项目已经完成渲染或审片。
