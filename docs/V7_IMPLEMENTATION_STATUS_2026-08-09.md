# 咔嚓 V7 生产编排实施状态（2026-08-09）

本文记录 V7 生产流程优化的工程完成度与真实证据边界。它不把自动测试、演示页面或协议模板冒充真人项目成片验收。

## 结论

- 工程实现状态：`implemented_and_regression_verified`
- 默认生产入口：`kacha start` / `kacha run` / `kacha resume`
- 用户流程：方案确认 → 首剪确认 → 成片审阅 → 交付与返工
- 专业阶段：13 个，全部保留独立证据合同
- 自动回归：131 / 131 通过
- 官网：中英文构建、GitHub Pages 打包、桌面端与 390 px 移动端真实浏览器检查通过
- 本地 Studio：视频项目、内容项目、项目状态、统一审片四个入口真实浏览器检查通过
- 真人成片结论：未由本文件声明；必须在具体项目中完成正常速度人工通看
- NLE 应用验证：当前机器未安装 Final Cut Pro、Adobe Premiere Pro 2026 或 DaVinci Resolve，因此真实应用导入、回写与重开验证尚未完成

## 已落实的生产闭环

### 1. 输入与运行时冻结

- 视频、脚本或选题都能建立可恢复项目。
- 生产模式锁定源码 Git ref、工作树状态、Codex/Claude 安装 ref 与 bundle digest。
- 输入使用强文件身份；源文件变化、安装漂移或工作树变脏时 fail closed。
- 视频项目默认强制 `intelligenceV6.required=true`，不允许兼容模式绕过。

### 2. 内容先行

- 没有视频时先生成内容主线、事实核验任务、录制方案、素材缺口与录制交接合同。
- 事实、素材和内容主线未经有证据的批准，不得交接到正式剪辑。
- 录制媒体回填后生成新的 source-edit 子项目，再启用 V6 媒体门禁。

### 3. 统一编排与恢复

- 四个用户里程碑映射到 13 个专业阶段。
- 每个阶段保存状态、输入摘要、证据和下一动作。
- `run` 只执行当前安全动作；渲染引擎步骤需要显式开关。
- `resume` 重新核对运行版本和输入身份，不从聊天记忆猜测进度。

### 4. 素材收件箱

- 逐项区分真实事实证据、用户提供素材、说明性生成候选和可省略项。
- 回填素材必须记录来源、许可和文件身份。
- 新素材只进入 `pending_reindex`，不能绕过 media index、asset gap plan 或 V6 重新编译。

### 5. 统一审片与发布检查

- 语义审片继续使用绑定当前项目的正常速度音视频预览。
- 发布审片包含 11 项人工检查，并绑定当前完整成片 SHA-256。
- 成片改变会自动让旧审片失效。
- 未通过项生成待 Agent 编译的返工请求，不在审片页面直接改片。
- 接受剪辑决策、批准本地候选、授权上传和正式发布仍是四个不同状态。

### 6. 评测与 NLE 证据

- 真人评测使用至少 8 个配对案例，覆盖五栏目与五风格；记录首版接受、人工修改分钟数、总周转时间和逐项偏好。
- 不生成综合“虚荣分数”，缺少真人、真实输入输出媒体或修改证据时验证失败。
- NLE 会话绑定应用、版本、导出报告、导入结果、回写报告、应用内截图/记录和审片人。
- XML/OTIO 结构 round-trip 只证明交换结构，不证明某个 NLE 应用真实可用。

## 本次验证证据

| 门禁 | 结果 |
|---|---|
| `node tests/run_tests.mjs` | 131 / 131 pass |
| `node scripts/kacha.mjs doctor --profile core` | 44 项 required checks pass |
| `node scripts/kacha.mjs studio validate` | 5 内置风格、10 开场、129 可指定效果，pass |
| Website `npm test` | 5 / 5 pass |
| Website `npm run test:pages` | 3 / 3 pass；中文、英文静态路由打包通过 |
| Website `npm run lint` | pass |
| Website `npm run typecheck` | pass |
| Website dependency audit | 生产依赖漏洞 0；仅保留精确列名的静态构建期开发例外 |
| Playwright | 官网中英文、1440 px 桌面、390 px 移动端、Studio 四入口，无 console warning/error |
| `node scripts/kacha.mjs nle-app detect` | `unavailable`；三种受支持 NLE 均未安装 |

## 尚未完成、不能虚报的证据

1. 尚未用 8 个真实“行者大灰”项目填满真人评测队列，因此不能宣称首版接受率或人工修改时长已经提升到某个数值。
2. 当前机器缺少受支持 NLE，尚未完成 Final Cut Pro / Premiere / Resolve 的真实导入、重开、修改和回写。
3. 131 项回归包含真实可解码媒体与受控 fixture，但不替代用户本人对 4K、正常速度、全长成片的审美批准。
4. 网站通过浏览器与静态部署构建，只证明产品说明和交互可用；不证明任一具体视频已发布。

这些缺口已经被做成 fail-closed 的评测和 NLE 会话协议。拿到真人项目与 NLE 环境后，可以补证据，而不需要再次改写验收标准。
