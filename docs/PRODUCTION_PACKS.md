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
| `clean-editorial` | `talking-head` | 默认通用口播，不含个人品牌 |
| `clean-editorial` | `screen-demo` | 录屏与步骤演示，不要求人物出镜 |
| `clean-editorial` | `montage` | 多素材剪辑，不要求对白或词级转写 |

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

## 当前大灰AI生产包

`dahui-ai` 1.2.0 对齐大灰AI V6.4 的八栏目。工作台选择对应预设；CLI 用 `--pack dahui-ai --show ai-reading` 等显式选择，新栏目 ID 也会自动路由。

新建 CLI 与工作台统一默认 `clean-editorial` 1.1.0（单源/文稿为 `talking-head`，素材批量为 `montage`）。旧工程与冻结运行时不自动迁移；新建历史工程须显式 `--pack xingzhe-dahui --show book-talk` 等。所有新建工程写入自己的 profile/show，遇到矛盾配置会在写入前拒绝，避免品牌串入。

新包使用 narrative-v1、真人与证据、可读中文字体、真实二维封面、自然开场。节目证据合同须绑定 production-quality；其草稿不能通过计划门禁。详见 [大灰AI剪辑系统](DAHUI_AI_EDITING_SYSTEM_V1.md)。旧包、旧私有素材与冻结工程不被新包覆盖。

## 通用工程的声音与终审

通用与大灰AI工程均按实际时间线决定 BGM、SFX 检查；不配乐需说明声音选择，无 BGM 不要求伪造配乐计划或 95% 音乐覆盖。选用音乐后需绑定实际配乐计划、覆盖区间及有意留白，用户明确要求的音乐不能被省略。多素材类型可以只交付混音而没有对白分轨；口播仍保留语义审阅。字幕字体以实际文件摘要冻结，避免渲染机器静默替换字体。

通用 release 检查同时绑定项目时间线、执行时间线摘要、成片身份、时长、帧率与连接点数量。终审记录必须来自当前剪辑合同、当前时间线和当前产物，修改后旧记录失效。创建待审记录：

```bash
node scripts/kacha.mjs production-quality review-template \
  --contract /PROJECT/contracts/production-quality-contract.json \
  --output /PROJECT/contracts/production-review.json
```

先完善执行证据并绑定 `release.finalVideo`。命令只生成 `pending` 草稿，不自动通过。实际完成代表片段正常速度审阅、完整播放和设备听音后，由审阅者记录姓名、时间与各项结果；Agent 将该记录的 path/sha256 绑定到 release 的三项检查。大灰AI继续使用 `episode review-template` 的节目事实与内容审阅，封面逐张单独审阅。普通通用片不要求大灰AI问句、读书母片或栏目证据。

无源音轨的通用 `montage` 工程默认不声明对白分轨与字幕文件；真实添加后再登记对应产物。数字静音仅在声音合同明确允许、实际测量确认后通过，仍须交付完整混音并核对最终视频音轨；有声音却缺组件分轨不能借此通过。已有成片进入增量返工时，`init_incremental_project.mjs SOURCE --project-id ID --output-dir DIR --project-manifest FILE` 冻结同项目当前成片及声音政策；增量 manifest 与 QC 继承该已绑定合同。
