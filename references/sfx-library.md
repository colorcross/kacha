# 音效库、精确选音与分发边界

## 本地库接入

咔嚓内置 12 个由行者大灰原创并确认可随仓库分发的音效，默认清单为：

```text
assets/sfx/manifest.json
```

咔嚓不内置第三方库存音效或用户私有音频。项目需要接入额外本地库时通过环境变量指定：

```bash
export KACHA_SFX_LIBRARY=/absolute/path/to/sfx-library  # 在本机设置，不要写进仓库
```

目录至少包含 `manifest.json` 和其中 `ready_file` 指向的工作副本。工作副本默认使用 48 kHz、双声道 WAV；原始来源、授权、SHA-256、时长和用途由 manifest 记录。

检查完整库：

```bash
node scripts/kacha.mjs sfx validate \
  "$KACHA_SFX_LIBRARY/manifest.json"
```

按用户指定名称精确选择：

```bash
node scripts/kacha.mjs sfx validate \
  "$KACHA_SFX_LIBRARY/manifest.json" \
  --title "单击键盘" \
  --output selected-sfx.json
```

## 选择顺序

1. 用户明确点名具体音效时，必须按 `assetId`、`title` 和哈希精确命中；
2. 没有点名时，按画面 trigger 选择本地优先候选；
3. 本地候选不匹配时，才使用许可清楚的 fallback；
4. 所有候选都不合适时不加音效；
5. 同一语义节拍通常只有一个主要声音事件。

“键盘声”不是一个可互换的类别。单次按键、连续打字、退格、提交确认和机械键盘循环必须分别选择。用户说“单击键盘”时，不得用另一段“听起来差不多”的键盘循环替代。

新增项目私有音效使用显式 mapping 导入：

```bash
node scripts/kacha.mjs sfx import \
  --library "$KACHA_SFX_LIBRARY" \
  --mapping /absolute/kacha-import.json
```

导入器复制原始来源，生成 48 kHz / 双声道 / 24-bit WAV 工作副本，记录两份
SHA、时长、精确语义路由与分发边界，并重建试听索引。字节完全相同的文件只
建立 `aliases`，不制造重复资产。来源与公开再分发许可未记录的文件统一标为
`project_private_only`。

## 时间与混音

- 文字逐字出现时，每个音效绑定字符实际落位帧；
- 同一批事件使用同一音色和同一基础增益，除非画面动作真的改变；
- 音效落点误差通常不超过 1–2 帧；
- 音效不能覆盖口播辅音、笑点尾字或章节结论；
- BGM 可为短促音效做轻微闪避，但不能降低完整母带冒充音效更清楚；
- 最终成片必须在手机扬声器和耳机中确认可感知、不刺耳、不抢人声。

## 整片音效调色板

单个素材校验通过不代表整片声音设计通过。使用任何 SFX 的剪辑方案必须建立
顶层 `sfxPlan`：

- `selectionPrinciple`：按动作、信息、情绪、连续性或安全功能选音；
- `palette`：记录 asset ID、title、category 和 `useFor`；
- `events`：按时间排序并映射到具体效果；
- `repetitionPolicy`：说明最大连续次数、最大占比和节奏例外；
- `dialogueProtection`：说明辅音、笑点、结论尾字和 BGM 闪避策略；
- `auditionEvidence`：至少包含 SFX stem、手机扬声器和耳机试听。

四个及以上事件至少使用三个真正不同的音效，单个音效不得超过 50%，同一音效
不得连续使用超过两次。逐字打字等单一连续动作允许使用统一音色，但在事件上记录
`patternException`；不能以此为由让整片信息卡、转场和结论全部共用同一音效。

“丰富”指功能和质感有区分，不是把更多声音叠在一起。每个语义节拍仍然通常只有
一个主要声音事件。

## 授权与 GitHub

“可用于成片”不等于“可把源音频放进公开仓库”。运行：

```bash
node scripts/kacha.mjs sfx validate \
  "$KACHA_SFX_LIBRARY/manifest.json" \
  --asset-id ASSET_ID \
  --require-public-distribution
```

只有 manifest 明确允许公开分发时才能把音频文件随仓库、Release、模板或安装包发布。本仓库的 12 个原创音效受 `assets/sfx/LICENSE.md` 约束：允许随咔嚓和视听作品使用，不允许脱离咔嚓或视听作品作为库存音效包重新销售或聚合分发。Mixkit 等库存音效通常允许用于成片，但禁止作为素材包再分发；没有公开授权的用户本地音效只能保留在私有项目中。

公开仓库可以提交：

- 音效库 schema；
- 选用规则和 trigger profile；
- 校验脚本；
- 授权说明和本地接入文档。

除已确认权属并具有明确资产许可的原创音效外，公开仓库不得提交：

- 无再分发权的第三方音频二进制；
- 来源或授权不明的用户音频；
- 带有本机绝对路径、账号、任务 ID 或凭据的私有 manifest。
