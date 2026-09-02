# 白板手绘动画（Whiteboard Animation）

咔嚓的 `whiteboard` 能力把 **SRT 字幕驱动的线稿**渲染成按叙事顺序逐步绘制的
"暖纸底 + 流式笔迹"白板动画：每个元素跟随字幕依次出场，笔尖在区域内连续落墨
（先 `ink` 铺线稿、再 `color` 添彩），最终导出 H.264 MP4。适合把知识讲解、
故事口播、课程字幕或短视频文案制作成整幕手绘动画。

引擎 vendored 自
[`geeklee/srt-whiteboard-animation`](https://github.com/geeklee/srt-whiteboard-animation)
（MIT 许可），来源、版本锚点与本地补丁清单见
[scripts/whiteboard_engine/README.md](../scripts/whiteboard_engine/README.md)。
能力合同（视觉规范、默认参数、标注合同、QC 门禁）定义在
`config/effects/whiteboard-animation.json`。

## 与咔嚓体系的边界

白板动画是**整幕能力**，不进入 Render Graph，也不替代字幕层：

- 它的输入是"一张统一风格的线稿 + 一份标注 JSON"，输出是独立成片；
- 成片仍要走咔嚓的正常速度人工审片与发布门禁才能对外；
- 字幕烧录、BGM、混音等继续用既有能力（`captions`、`bgm`、`qc`）在
  时间线上完成，白板成片作为源片段参与后续工程。

## 工作流（字幕驱动、逐步确认）

1. **解析字幕**：`parse-srt` 把 SRT 解析成字幕条，并按每幕 25–35 秒的
   建议分组成场景（末幕可短于下限；超过上限会强制断幕），输出
   `kacha_whiteboard_storyboard_plan`（绑定源 SRT 的 SHA-256）。分镜时长
   就是每幕标注 `sceneDurationMs` 的来源。
2. **线稿**：按分镜策略为每一幕生成一张统一风格的线稿图（图片生成需各自的
   授权与记录）；每一幕只表达一个核心意思。
3. **标注**：`scaffold` 读取线稿真实尺寸生成标注骨架；为每个元素填写区域
   矩形、叙事顺序（`sequence`）、时序（`reveal.startMs/durationMs`）和字幕
   关联。相互遮挡的物体在较早元素的 `protectedRegions` 中标出需延后显示的
   区域。
4. **校验**：`validate` 失败关闭地检查标注合同（画布与图片一致、整数像素
   区域不越界、sequence 连续、按 sequence 排序后 startMs 非递减、时序不超出
   sceneDurationMs 等）。
5. **检查图**：`preview` 把区域、顺序方向和手部路径叠加到线稿上，供人工
   核对；也可以用引擎自带的本地编辑台
   `scripts/whiteboard_engine/preview.html`（浏览器直接打开，只读本机文件，
   无网络请求）。
6. **渲染**：`render` 调用 vendored 引擎做流式笔迹渲染，默认先跑标注校验；
   成功后写入 `<输出>.whiteboard-evidence.json`，绑定线稿、标注、手部素材、
   引擎脚本与成片文件的真实 SHA-256。
7. **QC**：`qc` 做技术检查——容器可解码、偶数尺寸、首帧纯纸底、末元素开始
   前无提前露线（保护区不变量）、收尾帧每个区域都有笔迹（墨迹像素占比）。
8. **合并**：多幕项目用 `merge` 按顺序拼接（ffmpeg 无损 concat 优先），
   证据保留双输入身份。

人工门禁：线稿确认 → 标注确认 → 成片正常速度审片。以上步骤已编排为
`srt-whiteboard` 工作流包（`kacha.mjs workflows list`）。

## 命令

```bash
node scripts/kacha.mjs whiteboard parse-srt --srt 字幕.srt \
  --target-sec 30 --min-sec 25 --max-sec 35 --output plan.json

node scripts/kacha.mjs whiteboard scaffold --image scene-01.png \
  --scene-id scene-01 --story-basis "一句话故事基础" \
  --duration-ms 30000 --output scene-01.annotation.json

node scripts/kacha.mjs whiteboard validate --image scene-01.png \
  --annotation scene-01.annotation.json

node scripts/kacha.mjs whiteboard preview --image scene-01.png \
  --annotation scene-01.annotation.json --output scene-01.check.png

node scripts/kacha.mjs whiteboard render --image scene-01.png \
  --annotation scene-01.annotation.json --output scene-01-whiteboard.mp4 \
  --ink-path grid --color-fill contour-wipe --pause heavy \
  --fps 60 --cap-long-edge 1080

node scripts/kacha.mjs whiteboard qc --video scene-01-whiteboard.mp4 \
  --annotation scene-01.annotation.json --image scene-01.png \
  [--paper #F6F1E3] [--tolerance 28] [--ink-threshold 40]

node scripts/kacha.mjs whiteboard merge \
  --inputs 幕1.mp4,幕2.mp4,幕3.mp4 --output final.mp4
```

`--skip-validate` 仅限已人工确认的返工；`--bare-tip` 不叠加笔尖手部；
`--ink-path skeleton` 在线稿骨架清晰时笔迹更贴合原画。

## 环境准备

渲染引擎需要独立 Python 环境（首次自动创建于
`scripts/whiteboard_engine/.venv/`，已被 git 忽略）：

```bash
node scripts/kacha.mjs whiteboard env-check     # 仅探测
node scripts/kacha.mjs whiteboard env-prepare   # 建环境 + 补依赖
```

依赖：`opencv-python-headless`、`numpy`、`av`、`Pillow`。系统 ffmpeg 可用时
优先用于 H.264 转码与无损拼接；缺失时引擎回退 PyAV。也可用
`--engine-python` 或环境变量 `KACHA_WHITEBOARD_PYTHON` 指定现成解释器。

## 标注合同（摘要）

引擎真正消费的字段是硬合同；其余为创作元数据，缺失只产生警告：

| 字段 | 级别 | 要求 |
| --- | --- | --- |
| `canvas` | 硬合同 | 与线稿图实际尺寸一致 |
| `elements[].region` | 硬合同 | 画布内非负整数像素矩形，宽高为正 |
| `elements[].reveal.startMs/durationMs` | 硬合同 | 非负/正整数，不超出 `sceneDurationMs` |
| `elements[].reveal.protectedRegions` | 可选 | 同区域约束；遮住后续元素防提前露线 |
| `sceneDurationMs` | 硬合同 | 正整数 |
| `sequence` | 硬合同 | 从 1 连续递增；按 sequence 排序后 startMs 非递减 |
| `narrativeRole` / `subtitle` | 元数据 | 把区域与字幕事件对齐，审片时证明对齐依据 |
| `label` / `handPath` / `direction` / `type` | 元数据 | 检查图与预览台展示 |

坐标使用原图整数像素；渲染时引擎按输出尺寸自动缩放，QC 的区域级检查用同一
比例换算。

## 质量边界

- `qc` 是单幕场景的自动技术检查，不替代正常速度人工通看；成片时长与标注
  `sceneDurationMs` 明显不符时（合并片或其他剪辑），区域级检查会以
  `duration-match` 失败项明确拒绝，不会碰巧通过；
- 首帧纸底与墨迹占比阈值可在合同 `qc` 段调整（`paperColorTolerance`、
  `inkPixelDistanceThreshold`、`minRegionInkRatio`、`noEarlyInkRatio`）；
- 渲染不会覆盖已存在的输出文件；合并与渲染都留下可追溯的 SHA-256 证据；
- 上传、付费生成与发布不在本能力默认授权范围内。
