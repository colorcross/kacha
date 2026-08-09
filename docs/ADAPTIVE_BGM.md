# 自适应背景音乐生产合同

## 目标

背景音乐随说话节奏、情绪、内容、信息密度和环境声价值变化，为理解、节奏和
情绪层次增益；不使用固定循环、固定配器和固定响度填满全片。

增益优先级固定为：

1. 保护对白清晰、停顿、呼吸和事实边界；
2. 帮助观众感知开场、推进、转折、举例、结果、反思和结尾；
3. 通过共同动机下的编配变化维持连续性与新鲜感；
4. 最后才考虑音乐本身是否“好听”。

## 生产链

```text
最终对白 cues
  → 叙事功能 / 情绪 / 语速 / 信息密度分析
  → 栏目级音乐语法
  → 音乐、变奏或留白段落
  → 专业生成提示词
  → 素材生成或选择 + 许可与 SHA-256
  → Timeline audio.bgm.segments[]
  → 分段 fade / 增益 / program mix / dialogue sidechain
  → dialogue / BGM / SFX / mix stems
  → 计划重叠区间技术 QC + 三设备正常速度人工听审
```

动态不等于换歌。全片必须保留共同的二至四音动机、调性中心和至少一个核心
音色家族。优先改变音符密度、乐器层数、节奏细分、音区、和声色彩、频段和
空间；只有章节世界真正变化时才更换主音色。

## 命令

```bash
node scripts/kacha.mjs bgm plan \
  --cues semantic-cues.json \
  --show tool-share \
  --style xingzhe \
  --output contracts/adaptive-bgm-plan.json

node scripts/kacha.mjs bgm validate \
  --plan contracts/adaptive-bgm-plan.json
```

支持的正式栏目 ID 为 `tool-share`、`book-talk`、`infinite-game` 和 `very-ai`。
唯一策略源为 `config/audio/adaptive-bgm-policy.json`。

## 生成提示词

每个音乐段输出以下字段：

- 叙事目的与时长；
- BPM、拍号和 groove；
- 具体乐器与编配状态；
- 音色、和声与共同主题动机；
- sub、low、speech band 和 high 的频率策略；
- 宏观动态、相对人声音量、sidechain 目标；
- stereo/mono-compatible 声像；
- 四/八小节结构、fade handle、中点和干净尾音；
- 无人声、无抢对白主旋律、无轰鸣/高频常亮/预告片冲击等负面约束。

提示词可交给授权的音乐生成服务，也可作为人工选曲、编曲和再制作 brief。
生成完成不代表可用：必须绑定真实文件、许可、SHA-256，完成内容匹配、音质和
三设备实听后才能进入 final Timeline。

## Timeline 合同

自适应项目在 manifest 中声明：

```json
{
  "plans": {"adaptiveBgm": "./adaptive-bgm-plan.json"},
  "expectedMedia": {
    "audioMix": {
      "bgmRequired": true,
      "adaptiveBgmRequired": true,
      "bgmBelowDialogueDbMin": 12,
      "bgmBelowDialogueDbMax": 24
    }
  }
}
```

Timeline 的 `audio.bgm.adaptivePlan` 必须绑定计划真实 SHA-256；
`audio.bgm.segments[]` 逐段记录 `path / start / end / sourceStart /
levelBelowDialogueDb / fadeInSeconds / fadeOutSeconds / sha256 / provenance`。
段落之间可以留空，留空就是有意的环境声或纯人声，不是缺素材。

## 门禁

自动门禁拒绝：

- 长视频近乎全片单一音乐；
- 超过栏目配乐覆盖率或最大连续音乐时长；
- 事实核查、不确定性段落仍使用音乐；
- 缺 BPM、乐器、音色、和声、频段、动态、声像或编辑点的空泛提示词；
- 没有无歌词/无人声和负面约束；
- 高密度对白音乐过响；
- Timeline 未绑定计划、真实素材身份或 provenance；
- BGM stem、mix stem、组件重建或最终成片音轨不一致。

人工听审必须覆盖开场、密集事实、轻声、一次音乐退出、一次编配变化、结论和
结尾，并分别使用监听、耳机和手机扬声器。技术通过不能替代正常速度人工判断。

## 当前实施状态

已实现：四栏目策略、确定性段落规划、专业提示词、覆盖率与语义门禁、多段 BGM
Timeline 渲染、fade、分段增益、统一 sidechain、完整 BGM stem，以及计划区间
相对响度 QC。自动测试已验证两段音乐之间的真实静音和长视频固定铺底拒绝。

未由本次代码验证：任何具体项目的正式音乐生成、授权、真实大灰人声下的三设备
听审和完整 30 分钟成片。它们必须随项目素材单独闭环，不能由合成测试替代。
