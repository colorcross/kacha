# Production pack：通用引擎与项目规则分层

咔嚓核心负责语义完整、证据身份、时间线、音画对齐、正常速度审片和发布门禁；
字体、封面身份、栏目节奏和电影化镜头预算等项目规则由版本化 production pack 提供。这样既不把
“行者大灰”私有规则扩散到所有用户，也不允许项目临时降低质量合同。

## 当前生产包

| Pack | Show ID | 用途 |
| --- | --- | --- |
| `xingzhe-dahui` | `tool-share` | 工具分享：任务与操作证据快速推进 |
| `xingzhe-dahui` | `book-talk` | 解读好书：观点、文本证据和思考停顿优先 |
| `xingzhe-dahui` | `infinite-game` | 有限的无限游戏：事件、自然声和人物反应优先 |
| `xingzhe-dahui` | `very-ai` | 灰常AI：概念、案例和实测证据快速交替 |
| `xingzhe-dahui` | `casual-chat` | 闲聊：关系感、表情与口语节奏优先 |
| `clean-editorial` | `talking-head` | 不含行者品牌资产的通用克制型口播 |

## 生成和验证

```bash
node scripts/kacha.mjs production-quality template \
  --project-id demo-book \
  --pack xingzhe-dahui \
  --show book-talk \
  --output PRODUCTION_QUALITY.json

node scripts/kacha.mjs production-quality validate \
  --contract PRODUCTION_QUALITY.json \
  --stage plan
```

合同会冻结 `packId`、`packVersion`、`packSha256`、`showId` 和栏目编辑意图。
同时冻结 pack 所引用的电影化策略 ID、版本、SHA-256、当前栏目预算和可用视觉
语法；执行阶段的 `showId` 必须与 production profile 完全一致。
配置变化后旧合同不会静默继承新规则，必须重新生成或明确迁移并重做验证。

pack 在合并前做 fail-closed schema 校验。字体、封面、首分钟整数/比例/布尔字段、
栏目意图和电影化策略引用只要缺失、越界或相互矛盾，模板生成即失败，不允许用
`NaN` 或默认值绕过质量底线。

## 质量底线与差异

所有包继续要求语义触发、单一主效果、证据来源、峰值对齐、人物/字幕安全区、
正常速度预览与真人审片。可因栏目调整的是效果数量、机制数量、峰值 SFX、人物
在场比例、全屏接管比例、呼吸空间和反应窗口数量。

“更安静”不等于降低质量。解读好书与有限的无限游戏允许更少包装，是因为人物、
事件、自然声和停顿本身承担叙事功能；若没有这些真实内容，也不能用少效果掩盖脚本问题。
