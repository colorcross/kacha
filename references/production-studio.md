# 本地视频生产台

`studio/` 是咔嚓的本地生产入口。它不接收上传文件，只读取用户明确选择的
本机视频绝对路径，并把风格、开场、指定效果、平台和输出要求编译为可审计的
项目配置。页面不是通用时间线编辑器，也不会跳过方案、能力、渲染和发布门禁。

## 启动与停止

在咔嚓源码或已安装 Skill 目录运行：

```bash
node scripts/kacha.mjs studio serve
```

默认只监听 `127.0.0.1:4179` 并打开浏览器。指定端口或不自动打开：

```bash
node scripts/kacha.mjs studio serve --port 4187 --no-open
```

终端按 `Ctrl+C` 停止。服务不监听局域网地址；所有写请求都校验同源、
`application/json` 和本地请求标记。

## 默认“行者风”

默认已升级为行者风 2.0：暖灰中性色承担大面积，暖橙只做品牌和一般强调；
冲突/笑点使用信号珊瑚，AI/系统使用理性蓝，完成/证据使用验证绿。封面人物
默认约占高度 38%–44%，给标题和内容证据留出更完整的负空间。

`config/production-studio.json` 的 `defaultStyleId` 固定指向 `xingzhe`。
它来自当前已验证的运行参数：

- 明亮暖色、克制的编辑感和自然画面呼吸；
- 默认人声 `warm-soft`，目标 `-21 LUFS / -4 dBTP`；
- BGM 默认在人声下约 `18 dB`，功能音效默认在人声下约 `12 dB`；
- Beauty v2 默认关闭；
- 默认开场 `editorial_label_reveal`；
- 普通字幕单行、无底色、60% 阴影；
- 默认字幕使用已授权的真正金陵体
  `方正粗金陵简体 / FZJinLS-B-GB`。

真正金陵体只从本地字体注册表解析。编译项目时必须同时通过字体名称、真实
文件、SHA-256 与授权状态校验；缺失或变化会停止，不会静默退回旧替代字体。
字体文件和授权记录不得进入公开仓库。

## 页面能力

页面按五个连续步骤组织：

1. **素材**：选择或粘贴视频绝对路径，读取尺寸、宽高比、帧率、时长和
   音视频编码；
2. **风格**：选择 `行者风`、`清朗知识`、`现代科技`、`沉静纪录`，或基于
   现有风格另存本地自定义风格；
3. **声音**：为当前项目独立覆盖人声、BGM、Beauty v2 和效果密度，不必
   为一次性调整创建永久风格；
4. **效果**：选择注册开场，在 129 个生产效果中搜索，并添加任意多组
   “自然语言位置 + 已注册效果”；
5. **交付**：设置任务、栏目、平台、语言、输出规格、目标时长、项目输出
   目录和补充要求。

右侧“当前剪辑合同”实时显示所选风格、字幕字体、声音、BGM、美颜、开场、
效果数量和输出目标。步骤状态表示当前合同是否已有可执行配置；不是渲染进度。

生产配置完成后，可从顶部进入 `/review` 语义审片台。它不是第六个配置表单，
而是候选片阶段的正常速度决策界面：按高影响语义拍显示视频、剪辑理由、置信度、
最简回退和接受/调整/拒绝结果。审片台只读取 `review build` 生成的审片包，
每项预览必须通过真实媒体解码、视频帧、音轨和最小代表时长检查，播放器固定为
正常速度 1×。缺预览，或调整/拒绝缺少当前解决证据时，不会显示候选就绪。
偏好学习只生成候选，不会从页面自动激活长期配置。

自定义风格保存到 `~/.config/kacha/studio/styles/`，只保存偏好，不得包含上传、
付费、发布、覆盖源文件、跳过 QC 等授权字段。同名自定义风格不会被静默
覆盖；要保留新版本必须修改名称后另存。

## 生成前预检

点击“检查配置”后，生产台使用与 CLI 相同的解析器核对：

- 源视频存在、可读，并以只读身份进入 brief；
- 项目输出目录可创建、可写；
- 真正金陵体的本地文件、SHA-256、字符覆盖和授权状态有效；
- 风格和视频设计系统能解析为稳定 digest；
- 所有指定效果均来自注册表；
- 输出平台、容器、画质、尺寸、宽高比和帧率保护进入 delivery contract。

任何会改变合同的操作都会立即清除旧预检和旧生成结果。生成按钮会在需要时
重新预检，不能复用过期检查。

## Beauty v2 参数

页面支持磨皮、美白、匀肤、法令纹弱化四个 0–100 参数。参数进入
`editingDefaults.parameters.beauty.tuning`，由本地 Beauty v2 在
`natural` 或 `visible` 档位内解析到受硬上限约束的 FFmpeg 参数。它们不会
启用云端处理、脸型或五官调整。

即使风格中保存了参数，Beauty v2 仍默认关闭。只有当前项目明确设置
`enabled=true` 才能授权本地渲染，并且仍需人物跟踪、同帧 A/B、动态闪烁、
皮肤与颈部连续性人工复核。

可检查最终解析参数：

```bash
node scripts/kacha.mjs beauty parameters \
  --profile natural --config /absolute/path/kacha.config.json
```

## 专业自动判断

页面只对用户未指定的区间启用自动判断。顺序不可改变：

1. 先确认内容、语义边界、切点和音画同步；
2. 判断信息、情绪或视角是否真的变化；
3. 再选择景别、布局、组件、字体、颜色、动效、音效和 BGM；
4. 检查头脸、字幕、品牌和平台 UI 安全区；
5. 高影响模块先做样式帧和进入、峰值、退出预检；
6. 失败时回退到注册的最简安全效果。

`config/production-studio.json` 保存默认规则和内置模板；真正颜色、字幕、
组件、场景和运动仍由视频设计系统解析，效果实现不得在时间区间内另写一套
风格常量。

## 生成结果

每次生成使用独立目录，不覆盖已有项目：

```text
PROJECT-kacha-TIMESTAMP/
├── production-brief.json
├── kacha.config.json
└── AGENT_INSTRUCTIONS.md
```

- `production-brief.json`：源素材只读身份、SHA-256、风格、字体证据、开场、
  指定效果、自动导演规则和配置摘要；
- `kacha.config.json`：当前项目的可执行风格与运行参数；
- `AGENT_INSTRUCTIONS.md`：交给 Codex 或 Claude Code 的最短执行入口。

生成配置不等于已经剪辑，更不等于可发布。代理必须继续按 `source_edit` 或
`local_optimization` 工作流完成方案、能力探测、真实渲染、自动 QC 和人工
正常速度通看。

## 命令行等价入口

```bash
node scripts/kacha.mjs studio catalog
node scripts/kacha.mjs studio validate
node scripts/kacha.mjs studio probe --video /absolute/path/source.mov
node scripts/kacha.mjs studio preview --request production-request.json
node scripts/kacha.mjs studio save-style --input custom-style.json
node scripts/kacha.mjs studio compile --request production-request.json

node scripts/kacha.mjs review build \
  --timeline TIMELINE.json --director DIRECTOR_PLAN.json \
  --preview-dir PREVIEW_DIR --output-dir .kacha/review
node scripts/kacha.mjs review validate \
  --session .kacha/review/review-session.json --for-candidate
```

请求示例见 `examples/production-request.json`。CLI 与页面使用同一校验器，
不存在“页面能保存但命令行不能执行”的第二套格式。

审片预览通过 loopback Range 接口按审片包内 SHA-256 身份读取，不开放任意媒体
目录，并支持 GET/HEAD 与单区间 Range。页面仍不能授予上传、付费、发布、覆盖源片或跳过人工审片的权限。完整
V6 合同见 `docs/INTELLIGENT_EDITING_V6.md`。

## 设计与验收

- [Figma 可编辑设计稿](https://www.figma.com/design/uXfiviOI5rgi56awnD3Iut?node-id=1-2)
- [生产台深度 review](../docs/STUDIO_REVIEW.md)
- [桌面端实现截图](../docs/assets/kacha-production-studio.png)
