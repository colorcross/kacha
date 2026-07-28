# Beauty v2：本地自然美颜

Beauty v2 是咔嚓唯一的美颜后端。它完全在本地运行，只处理四件事：

1. 磨皮；
2. 美白；
3. 匀肤；
4. 法令纹弱化。

默认关闭。项目只有在 `editingDefaults.parameters.beauty.enabled=true`、当前
change request 明确启用，或用户明确要求时才进入美颜链路。不能因为检测到
人脸就自动处理。

## 能力边界

Beauty v2 不做瘦脸、大眼、改鼻形、妆容、牙齿美白、发色、身体塑形或身份
修复。法令纹处理是降低局部纹理和明暗对比，不是删除皱纹，更不能保证所有
角度、遮挡和光线下都有效。

核心实现：

- Apple Vision 检测人脸、五官关键点和人物；
- 按 IoU、位置和尺度连续性锁定一个主讲人；多人歧义帧输出空 Beauty 蒙版；
- 皮肤蒙版覆盖脸、耳和颈部，保护眼睛、眉毛、嘴唇和眼镜附近；
- 法令纹蒙版由鼻部和嘴唇关键点保守推导；
- FFmpeg 在蒙版内执行亮度保边平滑、色度匀化、轻微亮度/伽马调整和纹理回补；
- 默认不做有时间延迟的因果帧混合；用主脸身份锁定、逐帧关键点和空间羽化
  保持稳定，避免效果落后于表情；
- 灰度蒙版显式复制到 Y/U/V 三个平面，避免遮罩外背景发生色度污染；
- 全程保持原始几何，不移动五官和脸部轮廓。

## 默认关闭

内置配置：

```json
{
  "editingDefaults": {
    "parameters": {
      "beauty": {
        "enabled": false,
        "engine": "beauty-v2",
        "profile": "natural"
      }
    }
  }
}
```

显式启用示例：

```json
{
  "editingDefaults": {
    "parameters": {
      "beauty": {
        "enabled": true,
        "engine": "beauty-v2",
        "profile": "natural"
      }
    }
  }
}
```

`visible` 只有用户明确要求更明显，并且短段 A/B 通过时使用。不得把
`visible` 设为全局默认。

## 正式链路

```bash
scripts/generate_vision_masks.swift SOURCE.mov MASK_DIR SOURCE_FPS accurate
node scripts/build_mask_video.mjs MASK_DIR/manifest.json skin MASK_DIR/skin.mkv
node scripts/build_mask_video.mjs \
  MASK_DIR/manifest.json nasolabial MASK_DIR/nasolabial.mkv
scripts/apply_beauty_v2.sh \
  SOURCE.mov MASK_DIR/skin.mkv MASK_DIR/nasolabial.mkv OUTPUT.mov natural \
  --vision-manifest MASK_DIR/manifest.json \
  --config /path/to/beauty-enabled.json \
  --report /path/to/beauty-technical-report.json \
  --ab-dir /path/to/same-frame-ab
```

正式蒙版采样率必须等于源帧率。所有输入必须从零 PTS 开始，时长、有效帧率和
帧数在一帧容差内匹配；任何蒙版缺失或错位都失败，不允许回退成整脸模糊。
脚本会再次读取合并后的项目配置；没有显式 `enabled=true`、档位不一致或没有
逐帧 Vision manifest 时，渲染不会开始。

## 四项处理的设计原则

### 磨皮

- 只在皮肤蒙版内降低亮度纹理的高频粗糙；
- 保留毛孔、眉毛、眼睛、嘴唇、发丝、眼镜和脸部轮廓；
- 不通过全局模糊制造“美颜感”；
- 说话、眨眼和转头时出现蜡感或拖影就减弱或关闭。

### 美白

- 通过非常轻的亮度和伽马提升完成；
- 不改变族群肤色，不把皮肤推成灰白或粉白；
- 面部、颈部、耳朵和手臂不能出现明显色阶断裂；
- 白平衡错误应先调色，不能靠美白补救。

### 匀肤

- 主要平滑皮肤区域的低频色差；
- 不抹掉真实光影和脸部立体感；
- 眼镜反光、阴影边界和胡茬区域必须单独复核；
- 局部色偏来自灯光时，优先修正灯光或一级调色。

### 法令纹弱化

- 只在鼻翼至嘴角附近的保守窄区进行；
- 使用轻微保边柔化和提亮降低对比；
- 侧脸、遮挡、夸张表情和跟踪不稳时局部禁用；
- 不承诺“祛除”，不扩大到嘴唇或鼻孔。

## 验收

每次至少生成同源、同帧、同裁切、同显示尺寸的关闭/开启 A/B，覆盖：

- 正脸静止；
- 正脸说话；
- 转头；
- 眨眼；
- 眼镜反光；
- 手接近脸部。

人工检查：

- 皮肤仍有纹理，不像蜡或塑料；
- 眼睛、眉毛、嘴唇、头发和眼镜没有被软化；
- 面部、颈部和手臂的亮度与色相连续；
- 法令纹区域没有亮斑、灰边或随表情漂移；
- 连续播放没有蒙版闪烁、呼吸和边缘抖动；
- 关闭美颜时视频流不应发生任何无意义重编码。

技术报告必须记录：

- Beauty v2 配置 digest；
- 遮罩生成、遮罩视频、合成、对齐和 QC 实现文件的逐文件 hash 与实现链 digest；
- Vision manifest 中的源视频路径与 SHA-256；
- profile；
- 皮肤和法令纹蒙版 hash；
- 输入/输出帧数、FPS、时长和色彩标记；
- A/B 代表帧；
- 人工检查结论与禁用区间。

`apply_beauty_v2.sh` 自动执行技术 QC，并以 `pass_with_review` 标记仍缺人工
动态检查的结果。正式交付还要提供复核记录：

```json
{
  "schemaVersion": "1.0",
  "reviewer": "复核人或复核角色",
  "reviewedAt": "2026-07-28T12:00:00.000Z",
  "outputSha256": "<当前Beauty输出SHA-256>",
  "visionManifestSha256": "<当前Vision manifest SHA-256>",
  "profile": "natural",
  "sameFrameAB": true,
  "temporalFlickerReviewed": true,
  "skinNeckContinuityReviewed": true,
  "dynamicReviewRef": "review/beauty-motion-check.mov",
  "dynamicReviewSha256": "<64位SHA-256>",
  "requiredFrames": {
    "front_neutral": {
      "status": "pass",
      "timeSeconds": 1.25,
      "evidenceRef": "review/front-neutral.png",
      "evidenceSha256": "<64位SHA-256>"
    },
    "front_speaking": {"status": "pass", "timeSeconds": 3.4, "evidenceRef": "review/front-speaking.png", "evidenceSha256": "<64位SHA-256>"},
    "head_turn": {"status": "pass", "timeSeconds": 5.2, "evidenceRef": "review/head-turn.png", "evidenceSha256": "<64位SHA-256>"},
    "blink": {"status": "pass", "timeSeconds": 7.1, "evidenceRef": "review/blink.png", "evidenceSha256": "<64位SHA-256>"},
    "glasses_reflection": {"status": "pass", "timeSeconds": 9.0, "evidenceRef": "review/glasses.png", "evidenceSha256": "<64位SHA-256>"},
    "hand_near_face": {"status": "pass", "timeSeconds": 10.8, "evidenceRef": "review/hand-near-face.png", "evidenceSha256": "<64位SHA-256>"}
  }
}
```

```bash
node scripts/kacha.mjs beauty qc SOURCE.mov OUTPUT.mov \
  --skin-mask MASK_DIR/skin.mkv \
  --nasolabial-mask MASK_DIR/nasolabial.mkv \
  --vision-manifest MASK_DIR/manifest.json \
  --profile natural \
  --manual-review /path/to/beauty-manual-review.json \
  --ab-dir /path/to/release-same-frame-ab
```

主脸覆盖率、关键点覆盖率、多人歧义帧、跟踪跳变、逐帧采样、尺寸、帧率、
帧数、时长、色彩标记和轨道数量任一不合格都会失败。缺人工复核时不得把
技术通过写成最终通过。

## 失败回退

失败回退顺序：

1. 减弱 `visible` 到 `natural`；
2. 局部禁用法令纹处理；
3. 局部禁用全部美颜；
4. 全片保持原画。

禁止回退到 GPUPixel、全局模糊、生成式人脸修复或未经批准的云端服务。
