# Palmier Pro 启发的咔嚓专业工作台 V3

## 结论

V3 借鉴 Palmier Pro 的核心产品方法：项目、媒体、智能能力、节目监看、Inspector、时间线和交付围绕同一个编辑域模型，UI 与 Agent 调用同一套可撤销命令。咔嚓不复制 Palmier Pro 的 GPLv3 实现，也不把未完成的专业 NLE 功能包装成已可用能力。

## 产品信息架构

`/editor` 保持 Program 和 Timeline 为视觉中心，新增三个次级可折叠面板：

- Professional Capability Map：列出 `available / partial / planned / blocked`、证据、局限和实际入口。
- Delivery Center：创建编码交付计划、NLE 交换候选和自包含工程包。
- Agent Activity：读取 digest-chained Command Journal，显示 actor、operation 和 required QC。

工作台不把完成按钮藏在聊天里；Agent 与人工编辑的结果都回到同一 Timeline IR、SHA 锁和 Journal。

## 多时间线与版本

`kacha-editor-workspace 1.0` 是只引用多个 Timeline IR 的项目注册表，不保存第二份时间线内容。

```bash
node scripts/kacha.mjs workspace create \
  --timeline /project/timeline.json \
  --output /project/editor-workspace.json \
  --label "行者大灰第 1 期"

node scripts/kacha.mjs workspace duplicate \
  --workspace /project/editor-workspace.json \
  --expected-sha CURRENT_WORKSPACE_SHA \
  --source main --id vertical-v1 --label "竖屏 V1" \
  --output versions/vertical-v1.json --width 1080 --height 1920 --role aspect
```

复制使用 Workspace SHA 乐观锁、文件锁和独占目标；新时间线不覆盖基线，不继承已渲染候选或人工批准。工程目录内的 symlink 也不能把读写引向工程外。

## 专业时间线操作

V2 的 trim、split、move、reorder 保持兼容。V3 新增：

- `ripple_trim`：限单源主画面 EDL，修剪后下游主画面自动紧跟；定时图形/音频轨不被暗中移动，需重跑 connection QC。
- `overwrite`：用同一已绑定源片中的等长整帧区间覆盖工作区；保留前后 EDL 片段，新片段显式保存 decision/semantic ID。

两者均经过 Editor Command allowlist、Timeline 当前 SHA、原子验证写入、inverse mutation、Journal 与 undo/redo。已执行转场时结构操作失败关闭。

`sync / multicam / nested timeline` 仍是 `planned`：当前没有多源时钟、角度切换和嵌套终渲染语义，因此不提供可点击的伪入口。

## 智能与图像能力边界

能力地图把已有转写/字幕、静音候选、节拍、media/corpus 搜索、生成费用与素材入箱映射到当前真实 CLI。调色、LUT、抠像、Beauty 和降噪底层能力被标为 `partial`：存在生产合同或 FFmpeg 过滤器不等于已经拥有专业色轮/曲线节点 UI。

## 交付中心

```bash
node scripts/kacha.mjs delivery profiles
node scripts/kacha.mjs delivery plan \
  --timeline timeline.json --profile h265-master --output /deliver/final.mp4
node scripts/kacha.mjs delivery bundle \
  --timeline timeline.json --output /deliver/KachaProject
```

编码 profile 是封闭白名单：`h264-master`、`h265-master`、`prores-422-hq`。每个 profile 都按当前 FFmpeg 视频/音频 encoder、muxer 和 pixel format 四项探测决定 `available / blocked`。`delivery plan` 只写计划 sidecar，不创建假成片。

NLE 支持 OTIO、FCPXML、CMX3600，以及 Final Cut Pro 7 XML（`xmeml v5`）结构的 `premiere-xml` 交换候选。导出与回导都会绑定稳定的 Timeline、交换文件和源媒体身份，拒绝超出真实源媒体时长的区间；跨目录回导会重写相对输入和候选输出路径，报告失败时不留下孤儿候选。字幕、蒙版、Beauty、混音和复杂动效仍以 Timeline IR 为准；Premiere 导入仍需在目标应用中验证。

工程包默认是 `contract_only`：媒体使用 `./Missing/` 占位，manifest 不泄露本机绝对路径。只有显式 `--include-media`，且每个媒体引用都具备当前 SHA、许可白名单（owned/project-owned/original/public-domain/CC/明确 licensed/generated）及有证据的 provenance 时才复制媒体；`pending-review`、`fair-use-review`、`restricted` 和任意自造状态失败关闭。打包前再次验证 Timeline 和全部素材身份，并以独占目标、manifest-last 方式发布。项目专用 SFX 源文件、Command Journal 和 AppCreate 证据不进入工程包。

移动端的 Capability、Delivery 与 Activity 抽屉在视口内独立滚动，不能用超长列表把 Program 和 Timeline 推离当前工作上下文。

## 验收与证据边界

```bash
node tests/run_tests.mjs --suite editor
node tests/run_tests.mjs
make check-static
git diff --check
```

本地测试可证明命令、路径、摘要、撤销、页面和导出合同；不能证明真实创作者效率提升、最终成片更好，也不能代替 Premiere / Final Cut Pro / Resolve 的真实导入验证。
