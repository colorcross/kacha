---
name: kacha
description: |
  “咔嚓”本地专业视频策划、精剪、包装与验收 Skill。适用于先制定并验证详细剪辑方案，再处理真人口播、文稿内容视频、字幕、音频、BGM/SFX、插镜、画中画、美颜、人物/局部蒙版、主体感知重构图、调色、Seedance/MiniMax 生成镜头、封面及完整 QC。强调语义完整、音画同切、切镜有信息/情绪/视角依据、效果有理论合同、生成与素材可追溯、能力按项目探测、自动技术检查和人工审片共同放行。默认本地处理，不上传、不发布。
---

# 咔嚓

把视频剪得更清楚、更顺、更像同一支作品。先解决内容、连接和同步，再做包装；不用转场或特效掩盖错误切点。

## Agent 兼容性

本 Skill 遵循 Agent Skills 的 `SKILL.md` 结构，同时支持 Codex 和 Claude Code。两者共用本文件、`references/`、`examples/`、`scripts/` 和测试；`agents/openai.yaml` 只提供 OpenAI/Codex 展示元数据，不改变核心工作流，也不影响 Claude Code 加载。

## 必须先读

主代理必须完整读完本文件，再按任务读取对应 reference：

- 所有整支剪辑、跨版本重做或内容生成：
  `references/project-workflow.md`、`references/editing-theory.md`、`references/qc-release.md`；复盘生产缺陷或修改流程门禁时再读 `docs/PRODUCTION_HARDENING.md`
- 人声、BGM、SFX、响度或同步：
  `references/audio.md`；使用本地音效库时再读 `references/sfx-library.md`
- 插镜、画中画、美颜、蒙版、人物后文字、重构图、调色：
  `references/visuals-masks.md`
- 字幕、封面、品牌、系列名、开头和结尾：
  `references/subtitles-covers-brand.md`
- MiniMax、Seedance、网络素材、图标或 Lottie：
  `references/generated-media-assets.md`

不要只读主文件后凭印象执行条件模块。reference 中的具体合同优先于简要说明。

## 任务路径

只选一条主路径：

1. `proposal_review`：只给方案或 review；未获授权不修改文件。
2. `source_edit`：精剪现有音视频。
3. `content_generation`：从文稿、书籍、笔记或主题生成内容。
4. `local_optimization`：只改用户指定的字幕、声音、封面、插镜或版本。

双语、书籍编号、AI 镜头、第三方素材、专用人像模型、归档、上传和发布都是按需模块，不自动启用。

## 不可降低的原则

- 原始素材只读；输出进入独立版本目录，不静默覆盖正式成片。
- 句子、数字、专名、否定、条件、因果和结论必须完整。
- 音频和视频使用同一组帧边界、时间线和 PTS；不能分别剪完再对齐。
- 每个切点至少由信息、情绪或视角变化中的一项驱动。
- 同一主体、同一连续语义段的相邻镜头必须形成手机尺寸可感知的景别变化；不同主体或不同视角可以保持相同景别。
- 每个蒙版、SFX、字幕强调、转场、画中画、插镜和运镜都要有触发条件、机制、简单替代方案、失败条件和 QC 证据。
- 插镜同时满足对象、动作、状态、角色、时态和整片视觉风格。
- 人声自然、清楚、不过响；BGM 克制；SFX 可感知但不盖人声。
- 真实文件、完整解码、自动技术 QC 和人工审片全部通过后，才能称为本地成片完成。
- 上传、发布、付费生成、购买授权和不可逆操作必须在明确授权范围内。

## 先方案、后执行

除纯问答外，整支剪辑和跨版本重做必须先建立 `editProposal`，不能边试剪边临时决定结构。方案至少包含：

- 真实输入清单、规格、哈希和诊断证据；
- 受众、平台、语言、时长、视频画幅、封面画幅和输出格式；
- 内容主问题、开头承诺、必要论点、回报点和结尾；
- 具体保留、删除、重排和待核验项；
- 切镜/景别、留存/节奏、画面、字幕、dialogue、人声后期、最终混音、调色、美颜/蒙版、生成媒体、封面、输出和 QC；
- 授权、冻结范围、假设、风险回退、交付物和偏差。

使用 v2 示例：

- `examples/edit-proposal.json`
- `examples/edit-plan.json`
- `examples/project-manifest.json`
- `examples/generated-shot-plan.json`
- `examples/local-change-plan.json`
- `examples/release-report.template.json`

方案门禁：

```bash
node scripts/kacha.mjs gate-plan PROJECT.json
```

`proposal_only` 到此停止。可执行方案会额外验证源文件存在、SHA-256、任务路径和授权模式，不接受占位路径或互相矛盾的授权。

## v2 执行顺序

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

音频拆成前期 dialogue 分离/清理和后期 final mix。`dialogue_preprocess` 默认先从粗剪后的原始音轨生成独立人声候选，验收通过后剔除非人声 residual，再做降噪和人声增强。BGM/SFX 必须等视觉时序冻结后完成，避免重复处理人声或让音效错位。

执行前：

```bash
scripts/capability_probe.sh --profile core --output capabilities.json
node scripts/kacha.mjs gate-render PROJECT.json
```

项目使用蒙版、HDR、AI 视频或其他条件能力时，在能力探测中明确 `--profile` 或 `--require`。所需能力缺失时脚本返回非零状态，方案必须降级，不能只打印提示后继续。

`gate-render` 表示具备渲染条件，不是通用渲染器，也不表示已经产生视频。实际时间线可由项目现有 FFmpeg、NLE、HyperFrames、Remotion 或其他已验证引擎实现，但必须遵守同一项目合同。

## 核心检查

### 切镜和效果

```bash
node scripts/validate_edit_plan.mjs edit-plan.json
```

- timecode 与秒数会交叉验证；
- 切点必须严格递增；
- 同一主体相邻同景别被拒绝；
- 不同主体相同景别不误杀；
- 外部插镜、画中画、蒙版和生成镜头启用各自条件合同。

### 局部优化

```bash
node scripts/validate_local_change_plan.mjs local-change-plan.json
```

- 每项修改必须显式列出 `changedLayers` 与 `frozenLayers`；
- 纯音效替换必须复用原视频流，禁止无意义重编码画面；
- 完整删段必须让画面、dialogue、BGM、SFX 与字幕共用帧边界；
- 字幕和临时元素要在新连接点前 1–4 帧退出；
- 新版本必须重建 proposal、edit plan、project manifest、technical QC 与 release report，禁止继承旧版本身份和证据。

### 本地音效库

```bash
node scripts/validate_sfx_library.mjs \
  "$KACHA_SFX_LIBRARY/manifest.json" \
  --title "单击键盘"
```

用户点名音效时按 title、asset ID 和哈希精确命中，不能用“听起来差不多”的素材替代。音频文件是否可用于成片和是否允许随公开仓库再分发必须分开判断。

### 蒙版

```bash
scripts/generate_vision_masks.swift SOURCE.mov MASK_DIR SOURCE_FPS accurate
node scripts/build_mask_video.mjs MASK_DIR/manifest.json person MASK_DIR/person.mkv
node scripts/build_mask_video.mjs MASK_DIR/manifest.json face MASK_DIR/face.mkv
node scripts/build_mask_video.mjs MASK_DIR/manifest.json skin MASK_DIR/skin.mkv
scripts/apply_mask_effect.sh SOURCE.mov MASK_DIR/skin.mkv OUTPUT.mov beauty-light
scripts/compose_text_behind_person.sh SOURCE.mov MASK_DIR/person.mkv TEXT.mov OUTPUT.mov
```

PNG 蒙版必须按 manifest 的 PTS 组装为无损视频。源、蒙版和文字层在时长、帧率或起始 PTS 上相差超过一帧时失败，禁止末帧复制和 `-shortest` 静默截短。皮肤蒙版保护眼睛、眉毛、嘴唇和眼镜附近；`beauty-plus` 仅在同源、同帧、同裁切 A/B 通过时启用，不做脸型几何重塑。

### 人声

```bash
scripts/separate_dialogue.sh INPUT.wav SEPARATION_DIR

scripts/enhance_voice.sh INPUT.wav OUTPUT.wav \
  --preset natural --denoise light --channel-mode preserve
```

先运行人声分离，保留原始参考、独立人声候选、非人声 residual 和报告；只有同响度 A/B 无吞字、金属声、抽吸、呼吸断裂或明显语音漏入 residual 时，才把独立人声候选作为 dialogue stem，并在最终混音中排除 residual。分离失败或损伤人声时不得强行使用，必须回退原始参考并记录原因。

人声增强脚本默认保留输入 dialogue stem 的声道和时长。不能对完整 voice/BGM/SFX 母带执行人声增强，也不能把真立体声无条件压成伪立体声。

### 主体重构图

```bash
node scripts/plan_subject_reframe.mjs manifest.json 9:16 reframe.json
```

脚本锁定并关联主体，不逐帧追逐最大人脸。多人未指定主体、关联含糊、身份跳变或长时间丢失时，自动结果降级为手工关键帧或安全 fallback。

### AI 生成

```bash
node scripts/validate_generated_shot_plan.mjs PLAN.json
node scripts/validate_generated_shot_plan.mjs PLAN.json --for-execution
```

默认检查真实参考文件和哈希、能力快照时效、model、transport、模式、时长、分辨率和画幅。付费执行还要求明确授权。网络失败发生在提交后时先查询任务状态，禁止状态不明自动重提。

### 自动技术 QC 与发布门禁

```bash
node scripts/kacha.mjs qc PROJECT.json
node scripts/kacha.mjs gate-release PROJECT.json
```

自动 QC 检查解码、轨道、尺寸、画幅、帧率、采样率、声道、A/V 时长差、响度、true peak，以及 black/freeze/silence 线索。内容、字幕、插镜、蒙版、美颜、设备试听和全片通看必须记录在 release report 中，不能被自动脚本替代。

## 项目默认值

这些是可覆盖 profile，不是全局强制常量：

- 真人口播人声：`natural + light denoise`，A/B 损伤时减弱或关闭；
- 原始或来源不明的混合音轨：先生成 `dialogue_isolated` 与 `non_dialogue_residual`，分离候选通过听审后只让 `dialogue_isolated` 进入降噪/增强；残余轨保留用于审计但不混回成片；
- 人物美化：默认只尝试 `light`；`light_plus` 需用户明确要求和同源同帧 A/B；
- 竖版短视频字幕：每种语言单行、无底板、主动上移、真实字体测宽；
- 创作者字幕 profile：项目字体 Regular、无描边、60% 柔和阴影；
- 创作者封面 profile：竖版 3:4、横版 4:3、明亮暖色、人物独立构图；
- 品牌层由 `brand.enabled/name/interval` 控制；可以关闭、替换或只在指定区间出现；
- 知识口播响度可从约 -18 LUFS 开始；用户要求平台适配后再低一点时可从约 -20 至 -21 LUFS 开始，再以设备试听校准；
- BGM 调整只改 BGM stem；SFX 调整只改 SFX stem；冻结其他层。

## 能力成熟度

### 稳定本地

- 方案、内容骨架、语义完整剪切、J/L-cut、声音桥、动作切和景别变化；
- 基础重构图、几何蒙版、隐私遮挡、画中画、分屏和条件式人物后文字；
- 基础稳定、SDR 调色和跨镜头匹配；
- 单人口播降噪、人声整形、stem 混音、BGM 闪避、SFX 和响度 QC；
- 12 个经作者确认的原创音效及精确 title/ID/hash 清单；
- 单/双语字幕校准、封面、多画幅和技术 QC；
- 有来源和许可记录的网络素材；
- 经过当前能力快照、授权和 QC 的 MiniMax/Seedance 插镜。

### 有条件

- 基于 Demucs 或其他经验证模型的人声/非人声源分离；必须先通过 `voice` capability probe 和短段 A/B，不能把 FFmpeg `dialoguenhance` 或普通降噪冒充人声分离；
- 多人或遮挡下的主体跟踪、美颜和发丝级抠像；
- 光流慢动作、平面跟踪、屏幕替换和复杂物体移除；
- 专用语义祛纹、去混响、多人分离和 Dialogue Match；
- 生成式补帧、延展和复杂多模态视频。

必须在相应引擎、模型、许可、隐私和短段预检真实通过时启用。

### 不承诺

- 瘦脸、大眼、改鼻形等人脸几何重塑；
- 严重失焦、削波、滚动快门、运动模糊或低码率压缩的无损恢复；
- 与剪映、Premiere、Resolve 等未公开商业模型在所有素材上的一键等价；
- 无专业引擎的稳定 3D 跟踪、复杂长发转描和运动镜头物体移除；
- 未授权字体、模板、音乐、素材和平台专有滤镜；
- 仅凭剪辑保证流量、完播或爆款。

## 完成表述

最终回复必须明确区分：

- 已分析/已给方案；
- 已修改但未渲染；
- 已渲染但未完整 QC；
- 自动技术 QC 通过或 `pass_with_review`；
- 本地完整 QC 和 release gate 通过；
- 已上传；
- 已发布且平台端复核。

存在人工未试听、未通看、平台未验证或外部任务状态不明时，直接写明，不把前一阶段冒充后一阶段。
