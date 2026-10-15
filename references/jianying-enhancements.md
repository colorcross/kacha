# 剪映专业版增强工作流

用户允许后，咔嚓 Agent 可以自动操作本机剪映完成更合适的处理。咔嚓负责内容、时间线、选择能力、交接、技术验收和版本；剪映负责具体增强，保存独立原生工程。没有公开稳定的自动化 API 接入承诺：执行器是有当前屏幕观察能力的 Agent，命令行只负责交接和验证。

## 按任务选择

`node scripts/kacha.mjs pro-tools capabilities` 输出能力目录及逐项验收标准。目录是候选能力，不代表本机已验证。

- 源片阶段：自然美颜、降噪、人声美化、画质提升、防抖、去闪烁、抠像、镜头调色匹配。优先在最终精剪、字幕、BGM 和 SFX 之前，处理同源连续片段，避免每个切点产生不同强度或噪声门跳变。
- 装配阶段：转场、画面/人物特效、关键帧与跟踪。需要叙事触发，保护真人、证据、字幕与声音；一般硬切、基础淡入淡出、字幕及已有 wise-motion 能满足时不增加应用往返。
- 没有问题就直通；有问题先短段 A/B，确认收益后再批量应用同设置。内置 Beauty v2 已移除；美颜使用剪映专业版，保持自然身份，不默认瘦脸、改五官或换声。人声处理避免与咔嚓降噪再次叠加。
- 会员不代表全部功能免费或均在本地执行。检查当前账号权益、功能标识、导出限制、额外积分与上传提示；已授权且权益包含的功能直接执行，新增费用或未授权上传才停下处理。不要把登录、会员、能力可见、处理成功、效果合格混为一谈。

## 执行顺序

1. 读取基础 `professional-tools.md`。`pro-tools detect` 得到准确应用路径和版本；有多个同 bundle ID 的 helper 时用主应用绝对路径绑定。观察登录和会员状态，无证据记 unknown。
2. 保存当前用户工程，在独立验证/工作工程中处理。按实际画面/声音诊断命名问题，选择片段与能力；不盲目开全套。小样须有真实目标内容：色块测试不证明美颜，纯音不证明人声降噪。
3. 通过 `pro-tools prepare --tool jianying` 创建基础片段包并等 `status` 完成，再创建增强计划。原 Timeline 只读，复杂图层仍不能悄悄剥除。源片增强可做独立单段基础工程，回收后由 Agent 在原项目创建最小 delta，并重建字幕/切点映射所依赖的下游。
4. 按当前 UI 导入、选择正确片段、逐项设置、等待完成并观察效果；记录实际设置和界面证据。每次失败先重新观察，不能重复点击排队昂贵任务。无法控制窗口时保留计划与工程、记录 blocker，不标 applied。
5. 先源增强后装配增强。转场指定相邻片段，不能改变总时长、吞掉原句或自动挪动声音。需要额外 handles 时先回咔嚓重新准备素材包，不将错时长结果强制裁切。当前回收合同不允许偷偷升分辨率/帧率，超分辨率另立经批准的输出合同；“画质提升”可在原几何下检查去噪等。
6. 保存原生工程，按包的几何/帧率/音轨导出唯一新文件；下载或导出未完成不能接回。记录当前导出 SHA，再执行带增强记录的 `receive`。回收只生成新候选，不替换批准片，不写人工通过。
7. 同源同帧 A/B、同响度听对比、正常速度声画复核。短段成立后再处理全片；保留原片、剪映工程、参数和失败尝试。最终正常速度完整审片仍绑定当前产物。

```bash
node scripts/kacha.mjs pro-tools capabilities
node scripts/kacha.mjs pro-tools enhance-plan --package HANDOFF --request request.json --output enhancement-plan.json
node scripts/kacha.mjs pro-tools receive --package HANDOFF --media exported.mov --output candidate \
  --enhancement-plan enhancement-plan.json --enhancement-record enhancement-record.json
```

`request.json` 由 Agent 生成，用户不需要填写 JSON：

```json
{"operations":[{"capability":"denoise","reason":"持续底噪影响口播可懂度","clipIds":["实际包中的片段ID"]}]}
```

操作记录必须来自本次实际 UI，不从模板填成通过。`planDigest` 来自计划，`exportSha256` 来自实际导出；`operations` ID 与计划对应，必须全部 applied。以下仅说明结构：

```json
{
  "planDigest":"计划摘要", "exportSha256":"导出摘要",
  "applicationVersion":"实际版本", "projectName":"独立工程名称", "membership":"active",
  "membershipEvidence":{"path":"当前权益截图路径", "sha256":"该文件摘要"},
  "operations":[{"id":"op-1","status":"applied","entitlement":"included","settings":"实际选择的模式与数值",
    "evidence":[{"path":"本次操作证据路径", "sha256":"该文件摘要"}]}]
}
```

权益只接受 `free` / `included`；后者须 active 及权益证据。涉及额外积分的操作走单独费用授权，不套 included。记录证据可为本次截图、观察记录或录屏，保留日期、当前项目、功能和设置；不得记录密码/令牌。回收校验计划、包、输出和所有证据文件身份，快照计划和记录，标记 `operator_recorded_requires_review`，不会自动证明截图语义或效果质量。回收后证据源文件也应保留。

批量任务若某项失败，不伪造完成记录或默默省略：先恢复该项，或按原允许的回退新建删去失败项的计划并重做 A/B；未被执行的请求仍在原计划留痕。修改源、EDL、计划、输出后原记录失效。

## 本机核验边界（2026-10-15）

检测到 `/Applications/VideoFusion-macOS.app` 11.4.0，当前窗口是既有“咔嚓专业工具验证”工程，可见特效与转场入口。页面出现“现在开通”，本次未证实有效会员。UI 自动化可读 AX/截图，但坐标输入返回 `noWindowsAvailable`，重连及 Raise 后仍失败。因此本轮增强功能没有执行或导出成功证据，不能把此前标题/淡入导出当作美颜/降噪验证。待窗口控制恢复且权益核实后，按本合同逐项实测；无需重做已实现的包交接与回收逻辑。
