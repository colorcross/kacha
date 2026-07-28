# V4 工程化优化与低能力模型执行方案

## 目标

V4 在不降低内容、画面、声音和发布门槛的前提下，降低模型能力依赖、重复
推理、重复媒体分析、返工范围和长任务状态漂移。

## 问题—根因—落地—验收

| 维度 | 原问题/根因 | 已落地方案 | 可验证验收 |
|---|---|---|---|
| 稳定性 | 长任务中模型凭对话猜当前阶段 | `next` 只从当前合同、文件身份、QC 和 review 推导一个动作 | 中断后重跑得到同一合法动作；旧 QC 自动失效 |
| 并发 | 两个进程同时写版本或调用远程视觉 | 排他锁、死进程锁恢复、staging + 原子替换 | 活跃锁失败；死锁恢复；失败不覆盖可用结果 |
| 合同质量 | 弱模型手写 delta 容易漏层、漏验收、覆盖目录 | `compile-change` 稳定配方、版本 ID 白名单、独立目录 | dry-run、非法 ID、重复目录和缺区间均失败即停 |
| 证据身份 | 文件在哈希、探测或远程上传前后被替换 | size/mtime/ctime/inode + SHA；长操作前后再次核对 | 修改候选/封面/关键帧后 `next` 或上传门禁退回 |
| Token | 中文仍按字符/4 估算，且提前读 release 文档 | 多语言保守估算、模型档位、阶段路由、自动 support reference | 超预算阻塞；执行阶段不加载 release reference |
| 时间 | 每个命令重复 ffprobe，同一 QC 多次遍历整片 | 强身份跨进程 probe 缓存；解码/探测/响度合并 | 无 ffprobe 的第二进程仍命中；QC 单次媒体遍历 |
| 低能力模型 | 模型同时负责意图、状态、缓存和门禁 | packet + 配方编译器 + owner 边界 + 稳定错误码 | 每轮只执行一个动作，render/human 边界不可伪造 |
| Claude 视觉 | 无原生看图能力导致跳过画面检查 | FFmpeg 关键帧/接触表 + Apple Vision 人脸/人物/OCR | 本地 JSON/Markdown 带源/帧 SHA、时间码和风险 |
| 远程视觉 | 可能上传过多、重复计费或信任畸形 JSON | MiniMax 最少帧、三重授权、无代理直连、锁、缓存、schema 校验 | dry-run 零上传；整片/接触表永不上传；二次命中缓存 |
| 发布质量 | 自动通过被误写成全片通过 | candidate/release 分离，动态人工清单，release 强 SHA | 当前版本 11 项人工证据和完整门禁缺一不可 |

## 已解决的问题

### 稳定性

- 新增稳定错误码与可执行 remediation，避免模型根据自由文本猜修复方向；
- `next` 从当前真实文件、哈希、plan、候选、QC 和 review 推导唯一下一步；
- 编译器拒绝覆盖已有版本目录，所有返工输出独立；
- Claude 视觉链默认本地，MiniMax 同时要求外传、付费服务和显式上传授权；
- 远程视觉上传前复核帧 SHA，并用进程锁和结果缓存防止并发重复计费；
- 崩溃进程遗留的同机锁可立即安全回收，活跃锁继续失败即停。

### 质量

- 视觉证据绑定源 SHA、时间码、帧 SHA、人脸/人物/OCR 和本地技术指标；
- 低能力模型仍必须读取任务 reference，不能用紧凑 packet 替代质量合同；
- 常见返工配方内置专项验收标准；
- 自动状态机明确区分 agent、render engine 和 human，gate 不再被误当成渲染
  或人工审片。

### 流程与返工

- `prepare` 生成小型执行包，锁定主路径、按需 reference、硬合同和视觉策略；
- `prepare` 自动补入弱模型/Claude 支持 reference，并按模型档位阻止上下文
  超预算；
- `compile-change` 从小合同生成 delta、manifest、plan 和版本目录；
- `next` 每次只返回一个动作，适合模型降级、任务中断和跨会话续跑；
- v3 继续只失效变化层，冻结层由流哈希证明。

### Token 与时间

- reference router 保持按任务/模块/阶段加载，release reference 只在最终阶段
  加载；
- 中文/非 ASCII token 改用保守估算，避免“字符数/4”严重低报；
- packet 不复制 reference 正文；
- 同一 Node 进程复用文件哈希和 elementary-stream 哈希；ffprobe 结果还按
  path/size/mtime/ctime/inode 强身份跨进程缓存，文件变化即失效；
- 视觉证据分 `fast/review/release`，方案阶段不做全片场景扫描；
- 关键帧并发提取，本地 Apple Vision 分析器按源码和 Swift 版本编译缓存；
- MiniMax 先分析本地 findings 命中的帧，再均匀补足有限帧，并按帧 SHA、
  提示词 SHA 和 mmx 版本缓存；
- 完整 QC 把解码、黑/冻帧、静音和响度合并为一次媒体遍历；增量 QC 也按
  实际变化层复用同一次遍历。

### 工程化与性能

- 统一入口承载 doctor、prepare、next、compile-change、visual-evidence 和
  vision-enrich；
- doctor 对核心工具、FFmpeg 过滤器、Apple Vision、mmx vision、认证状态和
  安装身份给出机器可读报告；
- 新能力都有 dry-run、失败即停、原子写入、来源哈希和回归入口；
- 私有美颜 overlay 仍与公开 core 隔离，不因本轮改造泄露。

## 较弱模型的黄金路径

```text
doctor
  → prepare
  → 完整读取 readOrder
  → compile-change（常见增量任务）
  → next
  → 只执行一个 nextAction
  → 再次 next
  → 当前版本 QC / 人工审片 / gate
```

模型只负责理解用户意图、选择稳定配方、完成无法自动化的创意判断和解释
证据。文件身份、影响级别、状态推进、缓存失效和门禁由代码负责。

## Claude Code 黄金路径

```text
prepare --agent claude
  → visual-evidence fast/review
  → 先读 Markdown，再按需读 JSON
  → 本地证据足够：继续
  → 本地语义不足且获授权：vision-enrich 最少关键帧
  → 人工动态检查
```

不通过上传整个视频补能力，也不把 MiniMax 分析写成全片人工通过。

## 保留风险

- FFmpeg 场景检测只是抽样线索，不能替代真实 cutSheet；
- Apple Vision 对侧脸、遮挡、小脸和复杂中文 OCR 可能漏检；
- MiniMax 单帧无法判断运动连续、口型、闪烁和音画同步；
- 完整首剪的创意结构仍需要较强判断，V4 降低的是执行错误，不会把审美问题
  伪装成完全确定性；
- 跨进程持久媒体缓存只用于证据产物，没有让 release gate 依赖易失的
  stat-only 缓存。

## 深度 review 清单

每轮修改后至少验证：

1. 新入口语法与 `doctor core/claude-vision`；
2. 低能力 packet 的 readOrder、token 预算和唯一 nextAction；
3. change request dry-run、编译、拒绝覆盖和版本身份；
4. 本地视觉证据的缓存命中、源变化失效、关键帧和 contact sheet；
5. MiniMax 未授权拒绝、dry-run 零上传、已授权有限帧和缓存；
6. 公开 core 回归、私有 overlay 回归、installer 和 secret scan；
7. Codex/Claude bundle hash 与 `.kacha-version` 一致；
8. Git local/tracking/remote commit 一致。
