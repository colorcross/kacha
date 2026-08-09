# 咔嚓官网

咔嚓（Kacha）的中英文官网源码。视觉、文案和组件依据
[`docs/PRODUCT_BRAND_AND_WEBSITE.md`](../docs/PRODUCT_BRAND_AND_WEBSITE.md)，
运行在 vinext / React / Cloudflare Workers 兼容链路上。

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm ci --ignore-scripts
npm run dev
```

默认地址为 `http://localhost:3000/`，英文页面为
`http://localhost:3000/en`。

## GitHub Pages

公开官网：

- 中文：[https://colorcross.github.io/kacha/](https://colorcross.github.io/kacha/)
- 英文：[https://colorcross.github.io/kacha/en/](https://colorcross.github.io/kacha/en/)

GitHub Pages 使用仓库子路径 `/kacha/`。本地执行：

```bash
npm run test:pages
```

命令会完成预渲染、为 GitHub Pages 写入正确的资源前缀、打包
`pages-dist/`，并检查双语路由、Logo、脚本、样式和 404 回退。构建目录被
忽略，不提交到 Git；`.github/workflows/pages.yml` 在 `main` 的官网源码
变化后自动上传并发布该目录，也支持手动触发。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run test:pages
npm run audit:dependencies
```

`npm test` 会重新构建并验证中英文服务端渲染内容、Logo 和社交分享图。官网
通过不代表咔嚓 skill 本体通过；正式提交仍需在仓库根目录运行完整回归、安装器
测试与隐私扫描。当前 lint 使用 Oxlint；生产依赖必须保持 `0 vulnerabilities`。
开发链只允许 `scripts/audit-dependencies.mjs` 中登记的 vinext/image-size 精确
例外；包版本、依赖路径、GHSA 或修复状态发生任何变化都会重新阻断。

首页的“四种剪辑语法”区块直接对应
[`docs/FOUR_STYLE_EDITING_GRAMMARS.md`](../docs/FOUR_STYLE_EDITING_GRAMMARS.md)：
四张卡必须分别表现连续旁注、纵深导航、喜剧节拍和状态机，不能退化为同一组件
只换颜色或材质。中英文内容、127 项回归口径、1920 张峰值帧和 960 份合同数量
需要同步更新并由页面测试锁定。

页面采用持续可见的浮动章节导航；窄屏下导航转为可横向浏览的紧凑章节条，
不会直接隐藏。能力区使用不同跨度的 Bento 栅格区分主能力、常规能力与最终审片，
避免长页退化为同尺寸卡片目录。固定导航、章节锚点与键盘“跳到主要内容”入口需要
一起验收。

## 目录

```text
app/components/          官网组件
app/site-content.ts      中英文内容
app/globals.css          产品 token、布局与动效
public/brand/            Logo
public/og.png            社交分享图
.github/workflows/       GitHub Pages 自动发布（仓库根目录）
.openai/hosting.json     Sites 项目标识与绑定
```

## 内容与品牌边界

- “咔嚓”是工具产品品牌，不是“行者大灰”的新栏目；
- 不使用“一键出片”“完全替代人工”等无法证明的承诺；
- 能力数字必须带当前版本口径，并与 README 和真实测试一致；
- 不把技术通过写成人工审片通过；
- 社交分享图和 Logo 是项目资产，不得从官网源码中单独拆出另作品牌。
