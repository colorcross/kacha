# Palmier Pro 启发的咔嚓工作台 V3 实施日志

- Iteration: `kacha-palmier-workspace-v3-2026-09-01`
- Baseline: `2c09208c29dbd8d44340b2ca286fd24882464b21`
- Scope: 仅本地代码、文档、测试和浏览器验收；不含发布、commit、push 或付费调用。

## 固化记录

1. 基线工作区 clean，`main == origin/main`。
2. 两轮方案复审已完成；共关闭 7 个方案问题。
3. 最终方案冻结为 `kacha-palmier-workspace-v3-final-r2`。
4. 不复制 Palmier Pro GPLv3 源码；只实现已记录的产品与交互模式。

## 执行状态

| Slice | Status | Evidence |
| --- | --- | --- |
| CAPABILITY-MAP | completed | `scripts/professional_capabilities.mjs`; 18 项能力按 available/partial/planned/blocked 和运行时证据呈现 |
| MULTI-TIMELINE | completed | `scripts/editor_workspace.mjs`; create/show/duplicate、SHA 锁、文件锁、相对路径和 symlink 边界 |
| PRO-OPERATIONS | completed | `ripple_trim` / `overwrite` 进入 Command Journal、undo/redo、整帧与转场失败关闭 |
| DELIVERY-HUB | completed | H.264/H.265/ProRes 封闭 profile 计划、OTIO/FCPXML/xmeml v5/CMX3600、自包含工程包 |
| WORKBENCH-V3 | completed | `/editor` 多时间线切换、复制候选、能力地图、交付中心、Agent Activity；桌面和 390px 浏览器旅程通过 |
| INTELLIGENCE-SURFACE | completed | 已有字幕/转写/静音候选/节拍/搜索/生成入口映射到能力地图，未实现项无伪入口 |
| DOCS-QC | completed | 162/162 回归、Editor 8/8、静态/秘密/产品事实、MCP、分发、安装器、网站和 Chromium 旅程通过 |

## 实施中复审与修复

1. Workspace 未知 role 会被静默归一化：改为严格拒绝，并校验唯一 primary、aspect、createdFrom 和循环关系。
2. Workspace 复制可被 symlink 父目录引向工程外：增加 realpath 祖先约束和回归用例。
3. 自包含包可能通过嵌套 provenance 或 output 元数据泄漏绝对路径：增加递归便携性门禁，manifest 只保留 provenance 摘要与 digest。
4. Studio revision 轮询每秒重复读取全部 Timeline：revision 路径不再展开 Workspace，完整 Workspace 只在显式 project 读取时加载。
5. `Premiere XML` 曾错误复用 FCPXML：改为独立生成 Final Cut Pro 7 XML（`xmeml v5`）交换候选。
6. 编码 profile 曾可能因 encoder 齐全而显示 `available`：能力地图改为 `partial`，明确当前交付中心只生成计划，不冒充已终渲染。
7. 旧 Command Journal 若缺少 `requiredQc` 会导致 Agent Activity 报错：界面改为兼容缺省字段。
8. 浏览器脚本把 `<option>` 的“可见”当成挂载条件：改为 `attached`，避免测试工具自身误报失败。
9. Workspace 主体先于能力数据渲染，可能短暂打开空抽屉：入口增加明确加载禁用态，数据就绪后再开放。

## 验证结果

- `node tests/run_tests.mjs --report /tmp/kacha-palmier-v3-full-report.json`：162/162 pass。
- `node tests/run_tests.mjs --suite editor`：8/8 pass；覆盖多时间线、ripple、overwrite、工程包与 xmeml v5。
- `make check-static`：syntax、Python compile、secret scan、product truth 全部 pass。
- `node tests/mcp_server_tests.mjs`、`node tests/workbench_distribution_tests.mjs`、`bash tests/test_installer.sh`：pass。
- Website `lint`、`typecheck`、`test:pages`：pass；生产依赖漏洞 0，保留 2 个已登记的构建期开发依赖例外。
- Headless Chrome 桌面/390px 旅程：6/6 pass，390px 横向溢出 0，console/page errors 0。
- Premiere XML 实际候选：`xmeml v5`、关联 video/audio clipitem 和 file URL 均存在，`xmllint --nonet --noout` pass；目标 Premiere 导入仍是外部条件。
- `git diff --check`：pass。

## 当前完成边界

本轮代码、文档和本地候选证据完成。`sync groups`、`multicam`、可终渲染 nested timeline、专业色轮/曲线节点和通用降噪仍保持 planned/partial；未执行 commit、push、安装到真实用户目录、目标 NLE 实机导入或真实创作者正常速度验收。

## 恢复方法

上下文丢失时，按以下顺序恢复：

1. 读取本文件和 `quality/palmier-pro-iteration-final-plan-2026-09-01.json`。
2. 运行 `git status --short` 盘点未提交改动，不重置或清理。
3. 若继续处理外部条件，读取 `quality/palmier-pro-iteration-external-conditions-2026-09-01.json`，不得把外部未验证项改写为本地已完成。
4. 任何后续改动先重跑相关专项；触及时间线/交付事实源时再跑完整回归。

## Producer 深度复审 R2（2026-09-01）

- 复审记录：`quality/palmier-pro-iteration-deep-review-r2-2026-09-01.json`。
- 关闭 11 项后续 finding：Workspace digest/校验顺序、64 条上限事务、源 Timeline 与源媒体身份、相对路径与输出碰撞、overwrite 源时长、NLE 失败回滚、同 SHA 许可绕过、跨项目/祖先/时间戳约束、能力证据、互斥抽屉、移动端完整工作台验收和 SKILL V3 漂移。
- Editor 专项继续为 8/8；浏览器 6/6，移动端用例已改为实际打开 Workspace 后检查完整工作台，390px 横向溢出 0。
- 该复审由实现生产者执行。按照 AppCreate 的职责分离要求，独立终审登记为 `PAL-EXT-007`，不得把本记录描述为独立 deep-review complete。
- 最终树重新通过 162/162 全量回归、8/8 Editor 专项、静态/秘密/产品事实、MCP、分发、隔离安装器和网站门禁；最终浏览器证据为 6/6，Premiere xmeml v5 候选通过 `xmllint --nonet --noout`。哈希和边界见 `quality/evidence/palmier-pro-workbench-v3-r2-local-verification-2026-09-01.json`。

## Producer 深度复审 R3（2026-09-01）

- 复审记录：`quality/palmier-pro-iteration-deep-review-r3-2026-09-01.json`。
- 新关闭 10 项 finding：NLE 稳定快照与真实源时长、回导孤儿回滚及跨目录路径、交付 profile 四项运行时门禁、媒体许可白名单、工程包并发发布、64 版本共享源校验、Workspace/打包/计划整体身份复验、移动端抽屉上下文、可用 profile 选择和旧假媒体测试夹具。
- 390×844 能力抽屉改为视口内滚动；浏览器断言同时检查完整 Workbench、零横向溢出和抽屉高度上限。
- 本记录仍是实现生产者自审。独立终审继续登记为 `PAL-EXT-007`，不得描述为独立 deep-review complete。
- 最终验证与产物哈希写入 `quality/evidence/palmier-pro-workbench-v3-r3-local-verification-2026-09-01.json`；若该文件仍标记某项未运行，以该文件为准，不得从本段推断通过。
