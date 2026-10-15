# wise-motion 动效接入

将 [WiseWong6/wise-motion](https://github.com/WiseWong6/wise-motion) 的原始 Remotion 组件渲染为素材，再进入咔嚓 Timeline IR。不是重写近似动画，也不是仅安装提示词。通用工程与 `dahui-ai` 共用渲染能力，各自保留节目风格、事实核查及终审合同。

## 能力与选择

固定使用 npm 已发布版本 **0.1.16**，Remotion **4.0.532**，React **19.3.0**。2026-10-15 核查时 GitHub 主分支为 0.1.17，尚不能将其当作 npm 已发布版本。完整目录可检索 438 项；当前只接入 12 个原创、可替换内容的效果：

| 效果 | 使用场景 |
|---|---|
| `type-reveal` / `word-focus` / `word-slam` | 短标题、关键词、观点落点 |
| `stagger-in` / `title-content` | 分步骤说明、章节信息、四项并列 |
| `count-up` / `bar-growth` / `timeline-progress` | 经核实的数字、对比、进度 |
| `terminal-code` | 实际命令或明确标注的演示代码 |
| `interface-feedback` / `button-press-status` | 操作状态示意，不冒充真实产品录屏 |
| `particle-word` | 有叙事需要的短字标，不用于密集正文 |

先 `show` 看实际 `content_slots`，按其类型、长度和数量配置。文字溢出、未知字段及不支持的效果直接失败，不截断、不静默换效果。上游固定 640×360 逻辑画板等比放大，支持 16:9 输出；竖屏节目以局部卡片加入，不能声称已重新排版。透明 ProRes 4444 只开放 `type-reveal`、`count-up`、`word-focus`，并仍由上游当前源码透明审计控制。其余使用完整背景的 H.264 MP4。

默认保留上游字体与 dark/light 配色，不声称自动继承咔嚓字体合同。大灰AI按栏目选择：实践/测评用步骤与真实数字，读书用论点层级，产品用实际流程，辩论用实录关键词；不增加动效数量配额。不能以动效遮盖证据或把演示数值当作事实。

## 安装和运行

可选运行环境独立于咔嚓核心，无需为普通剪辑安装约 200 MB 的上游库。使用含 npm 的 Node 26；`setup` 按仓库锁文件安装，关闭安装脚本，不改已有环境。目录已存在会拒绝覆盖；失败时保留诊断，改用新目录。

```bash
node scripts/kacha.mjs wise-motion setup
node scripts/kacha.mjs wise-motion doctor
node scripts/kacha.mjs wise-motion search --query '逐字'
node scripts/kacha.mjs wise-motion show --effect type-reveal
```

默认运行环境：`~/.cache/kacha/wise-motion/0.1.16`。可用 `--runtime /absolute/runtime` 或 `KACHA_WISE_MOTION_RUNTIME` 指定。macOS 默认使用已安装的 Google Chrome，以独立无头会话渲染，不读取现有浏览器登录状态。可用 `--browser /absolute/executable` 或 `KACHA_WISE_MOTION_BROWSER` 指定并绑定浏览器文件身份；未找到本机浏览器时，由 Remotion 在共享运行环境下载匹配的浏览器，下载最长等待五分钟且不占编码资源锁。依赖、浏览器准备好后动效无外部生成 API 费用，仍消耗本机计算和存储。Remotion 遵循其自己的许可证，不能将上游的 Apache-2.0 扩展到所有依赖。

创建参数 `motion-spec.json`：

```json
{
  "effectId": "type-reveal",
  "content": {"text": "从问题到交付"},
  "width": 1280,
  "height": 720,
  "fps": 25,
  "speed": 1,
  "theme": "dark",
  "transparent": true
}
```

```bash
node scripts/kacha.mjs wise-motion render --spec motion-spec.json --output /absolute/project/motion/title-v1
node scripts/kacha.mjs wise-motion status --package /absolute/project/motion/title-v1
node scripts/kacha.mjs jobs cancel @job:wise-render --project-root /absolute/project/motion/title-v1
```

后台作业受 CPU/视频编码资源锁限制；参数、依赖锁及上游源码/素材摘要绑定到任务。实际解码、尺寸、帧数、无音轨检查通过后才写入 `receipt.json`。失败、取消或返工均保留原包，新建 `title-v2`；不盲目复用半成品。成功状态是 `rendered_requires_review`，不是终审通过。

每个渲染包只复制已选效果声明的脚本、共用样式、字体及 Anime.js，避免反复携带上游的无关音乐、录像和参考素材；原始上游包在独立运行环境保留。未采用强行缩减汉字字库的方式换取体积，以免新文案缺字。

## 加入节目

先查看渲染视频，再按当前时间线 SHA 和明确的叙事触发生成候选。候选必须与原时间线在同一目录，保留已有相对素材路径；所有原有 EDL、字幕、声音及视觉层均保留。原时间线不改写，旧审批不迁移；新候选强制 preview。

```bash
node scripts/kacha.mjs wise-motion attach \
  --package /absolute/project/motion/title-v1 \
  --timeline /absolute/project/timeline.json \
  --expected-sha CURRENT_TIMELINE_SHA256 \
  --start 2 --x 0 --y 0 --width 1280 --height 720 \
  --reason '在口播提出本期问题后显示章节标题' \
  --output /absolute/project/timeline.motion-v1.json
node scripts/kacha.mjs timeline render --plan /absolute/project/timeline.motion-v1.json
```

时间边界按帧对齐，包含上游精确结束帧；不允许跨越节目末尾、拉伸画面、隐式改帧率或截断文字。竖屏例：在 1080×1920 工程中放 960×540 卡片，`--x 60 --y 690 --width 960 --height 540`，动效 fps 与工程一致。效果插入后仍需完整带声正常速度审片，检查遮挡、读字时间、事实、字体、音画节奏以及当前 episode 合同；随后才可进入既有正式交付流程。

## 来源、声音和授权

效果源记录为 `generated_motion`，不能充当实测证据。每个包附上游 LICENSE、NOTICE、ASSET-MANIFEST，媒体文件和合同分别绑定 SHA。代码 Apache-2.0 不代表所有图片、参考视频、字体、音乐都同权；目录中的其他资源只作发现候选，未自动开放渲染。

上游音频始终关闭，且成品实际验证为无音轨。咔嚓人声、项目音效库和背景音乐策略不变；大灰AI优先检查本地音效库，背景音乐默认 MiniMax Audio 网页，音视频生成默认 MiniMax Design 桌面。不得把项目私有音效或字体上传、打包进公开仓库。

公开仓库只保存桥接代码和依赖锁，不收录整个上游素材库。不得把目录下载完成、技术检查或示例视频当作 438 项效果全部验证通过。
