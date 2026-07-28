# 低能力模型的确定性执行协议

本协议用于较低能力模型、较低推理强度和长任务续跑。目标不是降低质量门槛，
而是把“选流程、拼合同、判断下一步、解释错误”从模型临场推理下沉到脚本。

## 一次只做一个动作

先生成紧凑执行包：

```bash
node scripts/kacha.mjs prepare \
  --task local_optimization \
  --modules beauty,audio \
  --agent claude \
  --model-tier economy \
  --source BASE.mov \
  --project PROJECT.json \
  --output agent-packet.json
```

代理必须完整读取 `agent-packet.json.readOrder` 指定的文件，但不加载无关
reference。已有项目随后只运行：

```bash
node scripts/kacha.mjs next PROJECT.json
```

只执行 `nextAction`，完成后重新运行 `next`。禁止凭经验跳过 plan、render、
QC 或人工审片，禁止一次自行推进多个不可逆阶段。

`prepare` 支持 `economy / balanced / frontier` 三档 reference 预算。
`economy` 会自动加入本协议；Claude 遇到视觉模块会自动加入视觉证据协议。
若路由结果超过预算，命令直接阻塞，要求拆分阶段/模块，不能靠截断 reference
强行执行。`--max-reference-tokens` 只用于明确知道模型上下文上限时覆盖。

执行包同时携带当前安全配置 digest，以及按 task/module 过滤后的结构化参数和
自然语言默认要求。默认要求来自用户/项目配置，不需要模型从历史对话重建；
但它们不构成上传、付费、发布、覆盖源文件或跳过门禁的授权。

## 增量需求编译

常见返工不要手写 `version-delta.json`。只写
`examples/change-request.json` 这种小合同，再运行：

```bash
node scripts/kacha.mjs compile-change change-request.json --dry-run
node scripts/kacha.mjs compile-change change-request.json
```

稳定配方：

- `beauty`：自然美颜；
- `color`：调色；
- `visual_interval`：局部画面；
- `insert_replace`：插镜替换；
- `dialogue`：人声；
- `bgm`：背景音乐；
- `sfx`：音效；
- `subtitles`：字幕；
- `covers`：封面；
- `metadata`：无重编码重封装；
- `remove`：删段；
- `reorder`：重排；
- `geometry`：画幅变化。

编译器推导 change type、变化层、scope、输出时长、默认验收条件、独立版本
目录和增量 manifest。配方的 `parameters` 会原样进入 delta 作为实施合同，
但仍须由真实后端执行；编译成功不等于已经渲染。

## 错误码

新执行工具输出稳定错误码和 remediation：

- `KACHA-E100`：输入/项目文件缺失；
- `KACHA-E110`：文件身份或哈希失配；
- `KACHA-E120`：授权不足；
- `KACHA-E130`：运行能力缺失；
- `KACHA-E140`：项目合同无效；
- `KACHA-E200`：候选尚未渲染；
- `KACHA-E210`：QC 缺失或过期；
- `KACHA-E300`：人工审片未完成；
- `KACHA-E400`：视觉证据不足；
- `KACHA-E410`：外部视觉分析未授权；
- `KACHA-E500`：工具执行失败。

低能力模型只处理当前错误码，不重写整份合同，不用自然语言猜测缺失证据。

## 状态与责任

`nextAction.owner` 决定谁能推进：

- `agent`：可确定性执行验证、计划、QC 和门禁；
- `render_engine`：必须由真实时间线/渲染后端执行，不能把 gate 当渲染；
- `human`：必须由用户或人工正常速度审片、试听、批准。

`safeToAutoExecute=true` 只表示动作本身是本地、确定性且在现有授权内，不表示
可以跳过动作后的输出核验。

## Token 与时间纪律

- 主入口只负责选路，任务 reference 由 router 精确选择；
- token 预算对非 ASCII 字符按 1 token、ASCII 按约 4 字符/token 保守估算，
  不再用会严重低估中文的总字符/4；
- 首剪执行阶段不提前加载 release reference，进入最终 QC/release 时再用
  `prepare --release` 生成新 packet；
- `prepare` 只携带事实、引用路径、硬合同和一个下一步，不复制整套文档；
- 局部反馈只写变化，不复制旧 proposal、edit plan 和 release report；
- 代表帧、短片、同源 A/B 先冻结参数，再做完整渲染；
- 媒体哈希、ffprobe 和流哈希在同一进程按文件身份复用；
- Claude Code 只先读取视觉证据 JSON/Markdown，不把整批图片内容塞进上下文；
- 远程视觉只对少量关键帧按需调用，并缓存相同帧、提示词和运行时的结果。

## 失败边界

- `next` 无法确认文件身份时必须阻塞，不按文件名猜版本；
- `compile-change` 拒绝覆盖已有版本目录；
- 视觉证据缺失时不能由模型凭文稿代替画面检查；
- `pass_with_review` 继续进入人工处置，不能自动改写为 `pass`；
- 较弱模型无法完成复杂创意判断时，交给样式帧、短预览或人工批准，不降低
  合同要求。
