# 四套创作工具接入验证记录

日期：2026-10-23。范围为本机工程与原生渲染适配，不是正式节目的创作或发布验收。

本记录为首次接入验收；之后的深度审查、11 项专项回归、CLI 环境修复和最新双安装证据见 [深度审查与修复](CREATIVE_SKILLS_REVIEW_20261023.md)。

## 已完成实现

- `creative catalog/doctor/template/validate/render/ingest/status/attach` 已进入咔嚓 CLI；SKILL、阶段参考路由、专业能力表与安装验证同步接入。
- 三个模块分别负责合同/文件身份、原生提供者、任务与回收；复用现有 jobs、资源锁与 Timeline IR。
- 完整方案在 `docs/CREATIVE_SKILLS_INTEGRATION.md`，自然语言使用方式和操作命令在 `references/creative-skills.md`。

## 实测

| 后端 | 调用链 | 实际产物 |
|---|---|---|
| huashu-motion | check → render → qa | 1280×720、25 fps、100 帧，解码成功，无声画面 |
| huashu-art-motion | clip lint → layout audit → spec render | 同规格，中文合成数据图表，解码成功 |
| huashu-design | seek renderer；最终适配器另加 design lint | 同规格，确定时间的几何运动，解码成功 |
| lemo-opuscar | readcheck → video | 同规格，屏上 TEST 的阅读时间检查通过，解码成功 |

初次样片与回执位于 `output/creative-integration-20261023/`，Lemo 修正后的样片位于 `output/creative-integration-20261023-lemo-v2/`。最终代码的四后端重跑位于 `output/creative-integration-final-20261023/`，以 `summary.json` 和各 `packages/*/receipt.json` 为当前实测证据。样片为合成测试，不是风格作品，不进入节目时间线。

已查看四条初次成功样片的 2 秒关键帧，图表中文及数值显示正常，三个几何测试的运动位置与画幅正确；关键帧总览为 `output/creative-integration-20261023/contact-sheet.png`。没有把抽帧检查写成正常速度全片人工审阅。

新增自动回归 **7 项通过**，含真实 FFmpeg 素材与 Timeline IR 合成：

- 媒体回收保留原有声文件，生成无声工作画面，检查真实帧数与尺寸。
- 候选在指定区间显示插镜，区间前后恢复源画面，原音频轨与 EDL 保留，原时间线 SHA 不变。
- 竖屏 ProRes alpha 回收通过；原生艺术 scenes 可作为 external-output 回收，不伪称经过参数化 spec 检查。
- 非整帧、越界、比例错误、旧 SHA、重复输出、源目录嵌套、符号链接别名、未绑定素材被拒绝。
- 原件、工作画面、许可证据和冻结创作源被改动时，旧回执失效；技术 fixture 不能剪入节目。
- 精简阶段包仍包含 creative 和生成素材边界合同。

全量命令 `TMPDIR=/private/tmp make check-full` 通过：主套件 **171 项通过，0 失败**，专业套件、MCP、工作台分发和安装器测试均通过。新增模块在后续小修后再次执行专门回归；安装器还会对最终安装快照执行现有完整验证。日志见 `output/creative-integration-20261023/check-full.log` 与 `targeted-tests.log`。

## 发现并处理的问题

1. 本机 OM 启动器会回退在线 npx；接入改用明确的本机 npm 包路径并绑定实现身份，不静默下载/升级。
2. art 的 uv 离线缓存没有 Playwright；检测并复用了本机已安装 Playwright 的 Python，不额外安装。
3. Lemo 初次无文字 fixture 被 readcheck 判为 NOT CHECKED；未记通过，新增真实文字后重跑通过。正式纯画面任务可明确声明无文字，回执记录“不适用声明”，不伪称阅读通过。
4. 首次全量检查遇到既有 narrative 测试的 macOS `/var` 与 `/private/var` 路径别名问题；改用规范化 TMPDIR 后全量通过。新增桥接也对输出父目录进行规范化，且不会为失败检查在源目录内新建目录。
5. 上游存在只警告缺失图片的路径；桥接会拒绝日志中报告的缺失素材，保留失败日志供修复。

## 安装与验收边界

采用现有 `sync_skill_installs.mjs --agent both --apply` 原子同步 Codex / Claude；备份、安装摘要与最终回读以 `output/creative-integration-20261023/install-report.json` 和 `installed-readback.json` 为准。第三方 skill、私人字体、音效及样片输出不打包进咔嚓。

四套原生调用与媒体闭环已实测；未逐项创作和验收目录中的所有风格，未完成正式节目的正常速度审片。声音仍按咔嚓工程选择与混音，完整成片沿用现有发布门禁；本次无付费生成或对外发布。
