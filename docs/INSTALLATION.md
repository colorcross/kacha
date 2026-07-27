# 安装与依赖

## 基础环境

最低建议：

- Git
- Node.js 20 或更高版本
- Python 3.10 或更高版本
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

## 安装 skill

Codex 默认示例：

```bash
git clone https://github.com/colorcross/kacha.git ~/.codex/skills/kacha-kacha
```

若已经存在旧版本：

```bash
cd ~/.codex/skills/kacha-kacha
git pull --ff-only
```

其他代理只需把仓库放进其可发现的 skill 目录，并确保仓库根目录的 `SKILL.md` 保持原位。

## 能力探测

核心能力：

```bash
cd ~/.codex/skills/kacha-kacha
scripts/capability_probe.sh --profile core --output capabilities.json
```

条件能力 profile：

- `voice`：`jq`、Demucs 和音频 filters；
- `masks`：macOS Apple Vision 与蒙版 filters；
- `motion`：稳定、补帧和混帧 filters；
- `geometry`：镜头和几何修正 filters；
- `hdr`：`zscale` 与 `tonemap`；
- `ai-video`：当前可用的 `mmx` 接口；
- `full`：检查所有已声明能力。

能力缺失时脚本返回非零状态。请降级方案或安装明确需要的依赖，不要绕过门禁。

## 可选依赖

### Demucs

用于生成 dialogue 与 residual 候选。建议使用独立虚拟环境，避免污染系统 Python。脚本按以下顺序查找：

1. `KACHA_DEMUCS_BIN`；
2. `$XDG_DATA_HOME/kacha-kacha/demucs-venv/bin/demucs`；
3. `demucs` 命令；
4. `python3 -m demucs`。

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
python3 scripts/scan_secrets.py
```

回归测试通过只证明仓库自带门禁和媒体夹具工作正常，不证明某个真实项目已经完成渲染或审片。
