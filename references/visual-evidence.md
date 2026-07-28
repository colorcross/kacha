# Claude Code 视觉证据与 MiniMax 条件增强

Claude Code 没有原生图片/视频识别时，不能把“无法直接看画面”变成跳过视觉
QC。咔嚓把视频先转换成 Claude 可消费的本地证据，再按需补语义。

## 三层证据

1. **本地技术证据**：媒体规格、时间码、代表帧、亮度、黑帧线索、contact
   sheet、源和帧 SHA-256；
2. **本地语义证据**：macOS Apple Vision 的人脸、人物、头顶余量和 OCR；
3. **远程语义增强**：MiniMax 只分析经授权的少量关键帧，返回场景、主体、
   动作、构图和风险的结构化结果。

前两层默认本地完成。第三层不是默认依赖，也不替代人工通看。

## 生成本地证据

方案阶段用 `fast`，候选审片用 `review`，最终视觉变化较大时用 `release`：

```bash
node scripts/kacha.mjs visual-evidence INPUT.mov \
  --output-dir output/visual-evidence \
  --mode review
```

输出：

- `visual-evidence.json`：机器可读完整证据；
- `visual-evidence.md`：Claude Code 的低 token 摘要；
- `contact-sheet.jpg`：供具备视觉能力的代理和人工快速总览；
- `frames/`：带精确时间码映射的有限关键帧。

相同源 SHA、模式和参数会复用证据。源身份变化、采样策略变化或显式
`--force` 才重建。`fast` 不扫全片场景变化；`review/release` 会做低分辨率
场景检测，但仍需把真实 cutSheet 时间码通过 `--timestamp` 补入。

## Claude Code 消费顺序

1. 读 `visual-evidence.md`；
2. 对问题时间码查 `visual-evidence.json.frames`；
3. 根据 `faces/humans/recognizedText/technical/findings` 做确定性判断；
4. 语义仍不足时，先确认外传授权，再选择最少关键帧做 MiniMax 增强；
5. 最终结论仍绑定时间码、帧哈希、人工证据和当前输出哈希。

禁止仅凭文稿推断画面里出现了什么，也禁止把“未发现”写成“确认不存在”。

## MiniMax 条件增强

官方 `mmx vision describe` 支持本地图片。执行必须同时满足：

- 官方能力说明：
  [MiniMax CLI（中国区）](https://platform.minimaxi.com/docs/token-plan/minimax-cli)、
  [Image Understanding MCP（国际区）](https://platform.minimax.io/docs/token-plan/mcp-guide)；

- `project-context.authorization.externalUploadAllowed=true`；
- `project-context.authorization.paidGenerationAllowed=true`；
- 命令行显式提供 `--allow-external-upload`；
- 只选择 1–12 张关键帧，默认最多 6 张；
- 未显式指定 frame ID 时，优先选择本地 findings 命中的帧，其余名额再均匀
  覆盖时间线；
- 不上传整段视频，不上传 contact sheet；
- 报告记录 frame ID、时间码、帧 SHA、提示词 SHA、mmx 版本和授权上下文。
- 上传前重新计算关键帧 SHA；证据后被改动的帧直接拒绝。

```bash
node scripts/kacha.mjs vision-enrich \
  output/visual-evidence/visual-evidence.json \
  --context project-context.json \
  --allow-external-upload \
  --max-frames 6
```

默认移除代理环境并对中国区/国际区官方域名直连；只有明确需要保留现有网络
配置时使用 `--use-configured-network`。调用失败不自动重试，避免重复上传和
重复消耗；进程锁避免并发重复计费；相同帧 SHA、提示词 SHA、mmx 版本命中
本地结果缓存。返回 JSON 还要通过字段和置信度结构校验，结构异常会保留原始
结果但标记为 gap。

`--dry-run` 只列出将上传的帧和策略，不发生外传，也不需要项目授权。

## 证据能做什么、不能做什么

可用于：

- 检查普通人物镜头是否切头、人物大致位置和头顶余量；
- 找画面文字、字幕/卡片潜在冲突和亮暗底；
- 给 Claude 提供场景、对象、动作和构图的有限语义；
- 在返工时只复核受影响时间码。

不能独立证明：

- 转场是否丝滑；
- 口型、音画同步、蒙版闪烁和美颜时域稳定；
- 插镜前后动作是否连续；
- 全片没有漏检。

这些仍需短片段、cut handle、同帧 A/B、正常速度通看和最终 release 清单。
