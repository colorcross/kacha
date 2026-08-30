# 咔嚓全产品优化实施记录（2026-08-30）

## 执行合同

- 基线提交：`51e0e782ec2554e0e070a3d3c779a58f55cb48a3`，`main` 与 `origin/main` 一致，工作区干净。
- 审计：`quality/product-audit-2026-08-30.json`，七个专业域完成；8 条建议进入本轮，1 条开发依赖升级建议延期，真实用户与经营结果保持未知。
- 最终方案：`quality/implementation-plan.json`，revision `kacha-product-optimization-final-r1`，冻结摘要 `sha256:87cba15b18ff14d4cf1600397314f44af26311c564e9d7d969f26c7d66f4c6a2`。
- 授权：用户明确要求按最终方案全面实施，并在完成后提交、推送和部署到本机 Codex、Claude Code。
- 不在本轮：创建 GitHub Release/tag、引入第三方分析、声称真实项目成片质量或用户/商业结果。

## 基线复现

1. 完整回归 159/159 通过，说明以下问题不在既有回归边界内。
2. 官方 `curl ... install.sh | bash` 在 stdin 模式退出 2，checkout dry-run 正常。
3. macOS smoke run `32688630776` 在 Homebrew Python 的 `pip --user` 阶段失败，未进入测试。
4. Studio `/api/bootstrap` 三次为 8.524、11.585、10.571 秒；静态首页约 1 ms。
5. 大于 1 MB 的流式 JSON 会被断开连接；`null` 和数组可穿过解析边界。
6. 当前产品数字在测试、README 与官网之间漂移；英文页面的 document lang 为 `zh-CN`。
7. 官网未说明默认安装 canary，而 stable 仍为 `v1.1.0`；采用、首次候选、留存和经营指标没有真实基线。

## 已实施切片

| 切片 | 实施结果 | 主要文件 |
| --- | --- | --- |
| INSTALL | stdin/checkout 共用经校验的 release-channel 合同；固定 HTTPS、失败关闭、ref 字符集限制、临时文件清理；显式 custom ref 不再无谓依赖 channel 网络请求 | `scripts/install.sh`、`tests/test_installer.sh`、安装文案 |
| STUDIO-RUNTIME | 内置生产目录按进程构建一次、返回深拷贝；自定义风格仍逐次读取；服务 ready 前预热；字体探针增加有界缓存和项目字体文件指纹 | `scripts/kacha_studio.mjs`、`scripts/kacha_studio_server.mjs`、`scripts/design_system.mjs` |
| STUDIO-BOUNDARY | object 根合同、声明/流式 1 MB 门禁、结构化 400/413、有限 HTTP timeout，错误后健康检查可继续 | `scripts/kacha_studio_server.mjs`、`tests/run_tests.mjs` |
| MACOS-CI | runner 临时 venv 安装 Pillow/fonttools，并将 venv bin 传给后续步骤 | `.github/workflows/macos-smoke.yml` |
| PRODUCT-TRUTH | 从实际测试/目录推导 159、65、69、23、132，并在 `check-static` 对账 README、官网与产品文档 | `scripts/verify_product_truth.mjs`、`website/app/product-truth.json`、`Makefile` |
| LOCALE-ACCESSIBILITY | 中英文静态根布局分别输出 `zh-CN` 与 `en`；普通构建和 Pages 打包均覆盖两条路由 | `website/app/(zh)`、`website/app/(en)`、官网测试 |
| METRICS-DOCS | 工程、激活、价值、效率、质量、留存、经营证据分层；只定义本地优先的最小事件合同，不接入外部分析 | `docs/product/*` |

## 实施中 Review 与修复

1. **官网复制操作无失败闭环**：真实浏览器中 Clipboard API 可持续 pending，按钮没有反馈。修复为 800 ms 有界尝试、legacy 本地回退、中英文成功/失败状态；正常和 timeout 回退路径均在 Chromium 验证。
2. **Editor 空状态 resize 异常**：尚未打开 Timeline 时 `renderOverlayProjection()` 读取不存在的 `projection.output`。增加空状态保护并并入既有 workbench 回归；重开浏览器后五个 Studio 页面在桌面/390 px 均无 console error。
3. **设计证据随实现摘要失效**：字体缓存改变 `design_system.mjs` 后，代码绑定的已批准样式帧按设计失败。使用当前实现重新生成 SVG/manifest，更新 `examples/edit-plan.json` 的 design/artifact/manifest SHA；四个受影响正例恢复通过。
4. **缓存失效键不足**：目录时间戳不足以识别同名字体文件替换。缓存键补入排序后的字体文件名、size、mtime、ctime，并限制进程内历史 key 为 8 个。

## 当前验证记录

- `make check-static`：通过；语法、Python 编译、secret/private-path scan 与产品事实对账通过。
- `make check-website`：通过；lint、typecheck、Pages 构建、两条 locale 路由和精确依赖例外门禁通过；生产依赖漏洞为 0。
- Studio ready 后 `/api/bootstrap`：0.0145、0.0083、0.0079 秒（仅代表本机）。
- Playwright：官网 `/`、`/en` 与 Studio `/`、`/project`、`/content`、`/review`、`/editor` 在 1440×1000 和 390×844 无横向溢出；locale、159、canary 文案和复制回退通过；修复后 console error 为 0。
- 第一轮全量回归：155/159；唯一失败族为代码绑定样式帧摘要过期，已修复并由四个针对性正例验证。
- 第二轮全量回归：159/159 通过；机器报告为
  `quality/evidence/product-optimization-full-tests-2026-08-30.json`。
- 最终 installer、官网普通/Pages 构建、依赖门禁、产品文档、方案授权、workflow YAML、
  diff 与 secret/private-path scan：全部通过，汇总见
  `quality/evidence/product-optimization-local-verification-2026-08-30.json`。
- 远端 workflow、push 回读与双 Agent 最终部署：在提交后的交付阶段补写或由远端回读留证。

## 收口复审与完成契约

- 深度制作者复审：`quality/deep-multidisciplinary-review-2026-08-30.md`，覆盖产品、设计、交互、业务、数据/API、架构、实现、安全、无障碍、性能、测试、运维和市场运营。
- 结构化审查：`quality/post-iteration-review.json` 通过 `review-structured`；高风险修复保持 `fixed_unverified`，独立最终审查保持 `not_reviewed`。
- 完成契约：`quality/completion-contract.json` 按冻结方案七个 vertical slice 逐条绑定实现、验收、交付物、变更集和证据；`honest-status` 推导为 `partial`。
- 已完成切片：`STUDIO-RUNTIME`、`PRODUCT-TRUTH`、`LOCALE-ACCESSIBILITY`。
- 待提交后证据或独立复审的切片：`INSTALL`、`STUDIO-BOUNDARY`、`MACOS-CI`、`VERIFY-DEPLOY`。
- 最后一次本地收口重跑通过：静态/密钥/产品事实、installer 全路径、product-truth 负向自测、产品文档、方案授权、审查结构、完成完整性、JSON 解析、diff 以及官网 lint/type/build/普通渲染/Pages 打包/依赖门禁。

## 首个推送候选的远端交付

- 代码候选 `aafadca8ace659b49096e505d08063481b7abb2b` 已推送，`git ls-remote origin refs/heads/main` 精确一致。
- 官方 raw-GitHub 管道在 `pipefail` 下分别完成 stable/Codex 与 canary/Claude dry-run，解析为 `v1.1.0` 与 `main`。期间 raw GitHub 有瞬时超时，安装器的有界重试恢复，严格管道最终退出 0。
- CI run `33313856384` 与 Pages run `33313856317` 成功。
- 手动 macOS native smoke run `33313972056` 成功；原始失败点“依赖安装”已通过，后续静态/核心与 installer 步骤均通过。Homebrew 只产生了与本仓库无关的 `aws/tap` 信任提示。
- Pages 公网回读：`/` 为 `zh-CN`，`/en/` 为 `en`，两者均显示 159 和显式 `--channel canary`。
- 机器证据：`quality/evidence/product-optimization-remote-delivery-2026-08-30.json`。本次证据收口提交不修改产品代码；该提交推送与回读后才同步本机双 Agent。

## 证据边界

生产者复审可以确认修复与回归证据，但不能冒充独立最终 Review。真实项目的正式渲染、正常速度人工通看、首次候选成功率、四周留存、创作者时间和经营结果均没有本轮证据；这些边界不会被本地测试、Pages 发布或 Agent 安装替代。
