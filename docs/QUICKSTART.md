# 快速开始

下面演示如何从模板建立一个本地 `source_edit` 项目。模板不是已授权的真实项目，必须填写实际信息。

## 1. 创建项目目录

```bash
mkdir -p my-video-project/contracts
cp examples/edit-proposal.json my-video-project/contracts/
cp examples/edit-plan.json my-video-project/contracts/
cp examples/project-manifest.json my-video-project/contracts/
```

不要把原始素材复制进 skill 仓库。真实项目应位于独立目录，并保持原始素材只读。

## 2. 填写方案

至少替换以下内容：

- `taskPath`；
- 真实输入文件路径、角色、规格和 SHA-256；
- 平台、受众、语言、时长、视频与封面画幅；
- 内容保留、删除、重排和待核验项；
- 启用模块、成功条件、失败回退；
- `authorization` 与证据；
- 13 个阶段的初始状态；
- 输出路径和允许偏差。

计算 SHA-256：

```bash
shasum -a 256 /path/to/source.mov
```

Linux 可使用：

```bash
sha256sum /path/to/source.mov
```

## 3. 通过方案门禁

```bash
node scripts/validate_edit_proposal.mjs my-video-project/contracts/edit-proposal.json
node scripts/validate_edit_plan.mjs my-video-project/contracts/edit-plan.json
node scripts/kacha.mjs gate-plan my-video-project/contracts/project-manifest.json
```

如果任务是 `proposal_review` 或授权模式是 `proposal_only`，到这里停止。

## 4. 探测当前机器

```bash
scripts/capability_probe.sh \
  --profile core \
  --output my-video-project/contracts/capabilities.json
```

项目需要蒙版、人声分离、HDR 或 AI 视频时，使用对应 profile 或追加 `--require`。不要把旧能力快照当成当前可用证据。

## 5. 检查执行条件

```bash
node scripts/kacha.mjs gate-render my-video-project/contracts/project-manifest.json
```

通过后，使用项目选定的 FFmpeg、NLE、Remotion、HyperFrames 或其他时间线引擎执行。咔嚓咔嚓负责合同和门禁，不会自动生成通用时间线。

## 6. 执行 v2 阶段

顺序不可颠倒：

1. `inventory`
2. `transcript_structure`
3. `rough_cut`
4. `dialogue_preprocess`
5. `connection_qc`
6. `fine_cut`
7. `visual_packaging`
8. `subtitles`
9. `final_mix`
10. `cover`
11. `preview_render`
12. `final_qc`
13. `release_package`

同一时刻最多一个阶段为 `in_progress`。`passed` 必须附真实证据，`not_applicable` 必须说明原因。

## 7. 自动技术 QC

```bash
node scripts/kacha.mjs qc my-video-project/contracts/project-manifest.json
```

自动 QC 会输出技术报告并检查解码、轨道、尺寸、画幅、帧率、音频、A/V 时长差、响度和黑/冻/静音线索。`pass_with_review` 仍表示存在需要人工处置的线索。

## 8. 人工审片与 release gate

复制 `examples/release-report.template.json`，记录完整通看、字幕、连接点、素材许可、蒙版/美颜/画中画、人声与设备试听、封面、开头结尾和技术线索处置证据。

```bash
node scripts/kacha.mjs gate-release my-video-project/contracts/project-manifest.json
```

只有真实文件、哈希、自动技术 QC 和全部人工检查同时通过，才可称为“本地完整 QC 通过”。上传和平台发布是另一个授权与验证阶段。
