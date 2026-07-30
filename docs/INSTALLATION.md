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

使用本地字体索引、字体预览和口播字幕图层时，还需要：

```bash
python3 -m pip install --user Pillow fonttools
```

安装后先确认版本：

```bash
node --version
ffmpeg -version
ffprobe -version
jq --version
python3 --version
python3 -c "from PIL import Image; from fontTools.ttLib import TTFont"
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

用户配置和密钥不放在 Skill 安装目录，所以更新 Codex/Claude 安装不会覆盖：

```text
~/.config/kacha/config.json
~/.config/kacha/secrets.json
```

安装后可运行 `node scripts/kacha.mjs config validate`。字段与初始化方式见
[配置说明](CONFIGURATION.md)。

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
2. 配置中的 `tools.demucsBin`；
3. `$XDG_DATA_HOME/kacha/demucs-venv/bin/demucs`；
4. 旧版迁移期间的 `$XDG_DATA_HOME/kacha-kacha/demucs-venv/bin/demucs`；
5. `demucs` 命令；
6. `python3 -m demucs`。

源分离属于有损推断，安装成功不等于结果可直接使用，仍需同响度 A/B 和 residual 泄漏检查。

### Apple Vision

`scripts/generate_vision_masks.swift` 仅支持 macOS，需要 Swift、Vision、AVFoundation、CoreImage 和 AppKit。Linux 用户应把蒙版能力标为不可用，或替换为经过验证的其他引擎。

### FaceFusion

换脸、口型同步、人脸修复和帧后处理是可选能力。咔嚓不安装或修改
FaceFusion，只连接用户已经配置好的本机 Agent API。用户配置中设置：

```json
{
  "schemaVersion": "1.0",
  "tools": {
    "faceFusionEndpoint": "http://127.0.0.1:8765",
    "faceFusionTokenFile": "/absolute/path/to/api-token"
  }
}
```

token 文件必须是 `0600`。用 `node scripts/kacha.mjs facefusion probe`
验证服务版本、认证、处理器和许可 profile。probe 通过不授权身份操作；
每次实际处理仍需单独的授权计划和专项人工 QC。

### 素材平台

`scripts/fetch_stock_media.py` 支持 Pixabay/Pexels。凭据优先从环境变量读取，
也可放入权限为 `0600` 的 `~/.config/kacha/secrets.json`：

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
