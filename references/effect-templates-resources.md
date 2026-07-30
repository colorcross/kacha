# 效果模板与资源目录

## 结论

咔嚓的效果不能只停留在名称列表。模板解析器把内置视觉系统、场景、组件、动效、字体、音效角色、资源槽位、安全区、时序、回退和失败条件合成一份可执行合同。

```bash
node scripts/kacha.mjs templates validate
node scripts/kacha.mjs templates list
node scripts/kacha.mjs templates list --category transition
node scripts/kacha.mjs templates resolve --template effect-semantic_evidence_insert
node scripts/kacha.mjs templates resolve --signal logical_emphasis --output /absolute/effect-plan.json
```

当前提供 60 个解析后模板，覆盖：

- 10 个开场模板；
- 10 个转场模板；
- 7 个语义画面模板；
- 4 个贴纸与视线引导模板；
- 4 个空间分层与纵深模板；
- 4 个关键帧参数模板；
- 9 个并列句排版模板；
- 7 个口播字幕布局模板；
- 5 个画面呼吸模板。

模板使用“家族合同 + 具体绑定”。公共参数只在家族中定义，具体效果只写差异，禁止把颜色、字体、时序和安全区散落到项目时间线。

## 选择顺序

1. 用户明确指定的效果；
2. 文稿或画面中的真实触发：信息、情绪、视角、时间、空间、动作；
3. 匹配该触发的模板；
4. 检查资源、人物头脸、字幕、品牌和平台 UI；
5. 资源或安全区不满足时走模板 fallback；
6. 没有叙事理由时保持原镜头。

同一时刻只允许一个主效果。同一主模板建议至少间隔 6 秒；10 秒内主效果不超过 2.5 个。普通连接默认干净切，普通口播默认单行金陵体字幕。

## 资源层级

核心目录 `config/resources/core-catalog.json` 包含原创 SVG、品牌资源、原创音效入口、运行时动态背景和逻辑槽位。用户目录 `tools.resourceCatalog` 可增加项目私有字体、音效和素材，但不能覆盖核心资源 ID 或改变核心许可。

真实世界图片和视频不做无语义的批量预装。每个镜头按以下顺序选择：

1. 项目真实证据或用户素材；
2. 官方来源；
3. 逐文件核验许可与署名的 Wikimedia Commons；
4. 项目私有下载的 Pexels/Pixabay；
5. 获授权后生成并记录披露决策；
6. 设计系统信息卡或不用插镜。

下载素材必须记录 source URL、作者、许可页面、文件格式、尺寸/时长和 SHA。素材必须匹配对象、动作、人物、状态、方向和时态；仅“关键词相近”不合格。Pexels/Pixabay 原文件不得随公开咔嚓仓库作为库存素材再分发。

## 字体

模板不写字体文件名，只写语义角色。项目私有目录把角色解析为已授权字体并校验 SHA：

- 主字幕和逻辑重音：真正的方正粗金陵简体；
- 中文主标题与章节题：华光标题黑；
- 数据、工具与正文：思源黑体；
- 英文标题与数字：Alegreya Sans；
- 幽默、文化题眼：只在短句与匹配场景中使用对应授权字体。

主字幕金陵体缺失、SHA 改变或缺字时阻断，不静默退回宋体。

## 音效

模板只声明 `trigger` 和声音功能，最终文件由私有 `kacha-profile.json` 精确路由。每个音效必须有可见动作、文字落位、转折或叙事落点；普通字幕、慢推、慢移和静止不配音效。视觉停稳与音效峰值误差不超过 1–2 帧。

## 资源缺失

- 图标：优先原创资源；必要时按需取得 MIT 许可的 Tabler 图标并保留许可记录。
- 纹理：优先原创 SVG；必要时按需取得 ambientCG 的 CC0 纹理并记录 source URL 和 SHA。
- 照片/视频：使用 `scripts/fetch_stock_media.py` 小批量按镜头搜索，不建泛化库存。
- 找不到语义准确且许可明确的素材时，使用信息卡、屏幕录制、项目实拍，或把需求列为人工补充项。
