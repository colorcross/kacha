# 第三方依赖维护

最近核验：2026-10-15。以 npm/PyPI 官方 registry、项目官方仓库和 Homebrew formula 为版本来源；升级后必须验证实际运行环境，不能只修改版本声明。

## 当前锁定版本

| 范围 | 版本 / 入口 |
| --- | --- |
| Node.js | `.nvmrc`：26.12.0；开发、CI、发布构建使用同一版本 |
| 网站 | Next 16.4.1、React 19.3.1、Vinext 1.2.0、Vite 8.3.4、TypeScript 7.0.2 |
| 网站样式与工具 | Tailwind 4.3.3、Oxlint 1.88.0、Wrangler 4.151.0；完整清单与传递依赖见 `website/package-lock.json` |
| 字体、字幕 | Pillow 12.3.0、fonttools 4.67.0：`scripts/requirements-render.txt` |
| 白板渲染 | OpenCV headless 5.0.0.93、NumPy 2.5.4、PyAV 19.0.1：`scripts/whiteboard_engine/requirements.txt` |
| 浏览器回归 | Playwright 1.64.1，见 CI workflow |
| 本机媒体工具核验 | FFmpeg full 9.0.2、librsvg 2.63.2、jq 1.8.2 |
| 本机渲染解释器 | Python 3.14.8；旧解释器和更新前的渲染环境保留用于回退 |
| 白板上游 | `geeklee/srt-whiteboard-animation` @ `696a7243c0e6ffb6827676e539c2ca5ebae2bf6b`；核验时仍为上游 HEAD，本地补丁见引擎 README |

语言运行时、操作系统工具和独立模型服务不进入网站 lockfile。发行版为兼容性固定的传递依赖应单独记录；不能强制突破 NumPy、Python、ONNX 或模型的兼容约束，也不能把“最新可兼容”写成“所有包绝对最新”。CI 的系统媒体工具来自 runner 的软件源，与本机 Homebrew 验证是不同环境。

## 渲染环境

Python 渲染依赖要求 Python 3.12+。执行：

```bash
node scripts/kacha.mjs whiteboard env-prepare
node scripts/kacha.mjs whiteboard env-check
```

默认位置为 `${XDG_DATA_HOME:-~/.local/share}/kacha/render-envs/<依赖锁摘要>`。相同依赖在源仓库与安装副本之间共享，升级使用新目录，旧工程可继续指定旧解释器。只有版本、导入与 `pip check` 全部通过并写入匹配的 `.kacha-ready` 后，咔嚓才自动使用该环境。环境准备由 OS 文件锁串行化；`env-check` 只读，不创建或升级依赖。

- `KACHA_RENDER_VENV`：覆盖共享渲染环境目录。
- `KACHA_PYTHON_BIN`：覆盖通用 Python 命令；子任务自己的环境配置优先。
- `--engine-python` / `KACHA_WHITEBOARD_PYTHON`：覆盖白板解释器。
- `KACHA_WHITEBOARD_VENV`：保留原有白板专用环境覆盖行为。

仅当共享新环境尚未准备时，白板保留旧引擎 `.venv` 回退。显式冻结解释器不会被自动迁移。不要在共享系统 Python 中直接覆盖其他项目使用的库。

## 网站升级与验证

```bash
nvm install
nvm use
cd website
npm ci
npm outdated
npm run lint
npm run typecheck
npm test
npm run test:pages
npm run audit:dependencies
```

Vinext 1.2 使用 Vite 的 `dev/build` 入口；Pages 全路由预渲染通过 Vite 配置中的 `prerender.routes` 开启。Worker 产物引用 `cloudflare:`，本地 `npm start` 和 SSR 测试必须使用 workerd，不能直接在 Node 中 import Worker。

`allowScripts` 只允许已审阅版本的 esbuild、workerd 安装脚本；不用的 FSEvents 保持禁用。更改这些包后同步审阅并更新精确允许项。

保留的依赖覆盖：

- `fast-glob` 使用仓库内 tinyglobby 适配器；其构建接口有回归，避免重新带入不需要的旧依赖链。
- `postcss`、`sharp` 锁到已核验版本。
- `fflate` 0.8.3 修复 [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98)。新版 Vinext 的传递依赖仍可能选择受影响的 0.7.x，必须继续保留覆盖，直到上游修复。
- `ws` 8.22.0、Next 内部的 `styled-jsx` 5.1.7：覆盖上游固定的旧小版本，保留同一主版本 API，并验证真实 WebSocket 连接、关闭和网站 SSR。
- `@cspotcode/source-map-support` 内部的 `@jridgewell/trace-mapping` 0.3.31：验证实际 source map 解析及调用方使用的 `resolvedSources` 接口。
- `@tailwindcss/node` 内部的 `lightningcss` 1.33.0：与 Vite 的较新版本合并；必须验证 CSS 构建和实际页面渲染，不能只检查安装成功。

这些覆盖应随上游更新复核；上游采用同版或更高兼容版本后移除多余覆盖。`npm outdated --all` 同时显示平台可选包和版本标签差异，需要查看调用方的约束，不能把全部输出机械变成升级列表。

仍需随上游成套升级的典型依赖：

| 依赖 | 保留原因 |
| --- | --- |
| Cloudflare 的 `workerd` / `miniflare` / `unenv` | Wrangler 与 Vite 插件精确选择配套版本；部分预发布版本比 registry 的 `latest` 稳定标签更新，不能反向降级 |
| `undici-types` | 遵循 `@types/node` 的版本约束，避免类型声明承诺当前运行时尚未支持的接口 |
| `magic-string`、`path-to-regexp`、`nanoid` 等跨主版本项 | 上游调用方仍依赖旧 API；需先升级调用方或完成针对性迁移 |
| FaceFusion 的 Gradio / NumPy / ONNX Runtime | 使用 FaceFusion 3.9.1 官方支持组合；Gradio 6.x、ONNX Runtime 1.31 等独立最新版不等于已获该应用支持 |

不使用 `npm audit fix --force` 自动降级主框架。生产和完整依赖审计均要求零漏洞。

网站既有 `.npmrc` 使用 `legacy-peer-deps=true`：Vinext 使用 React Server Components 接口，构建由 Vite 执行，不安装未使用的 webpack 构建链。因此 `npm ls --all` 会报告 `react-server-dom-webpack` 的 webpack peer 缺失；该已知项不等于实际运行依赖缺失。保留干净 `npm ci`、真实 workerd SSR 与 Pages 构建验证，其他 invalid/missing 项仍需逐项解决。

## 独立服务与发布

Whisper ASR、FaceFusion、Demucs 各自独立管理 Python 与模型。升级应先保存当前来源、dirty diff、配置、依赖和服务身份，在隔离副本测试后切换本机连接；不要把本机绝对路径、令牌、模型或私有素材提交到公共仓库。

FaceFusion 的 `output_video_scale` 是倍率，范围 0.25–8.0、步长 0.25，原尺寸为 1.0。已有工程若保存百分比 100，必须明确修改；咔嚓拒绝该值而不隐式改变工程。

交付分别记录源码 SHA、远端 SHA、CI、Pages 制品与线上哈希、已安装 skill 的来源/摘要，以及当前服务实际版本。依赖测试与合成媒体回归不代替真人节目正常速度审片。
