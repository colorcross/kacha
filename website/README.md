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

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm audit --audit-level=high
```

`npm test` 会重新构建并验证中英文服务端渲染内容、Logo 和社交分享图。官网
通过不代表咔嚓 skill 本体通过；正式提交仍需在仓库根目录运行完整回归、安装器
测试与隐私扫描。当前 lint 使用 Oxlint；生产依赖与完整开发依赖都必须保持
`0 vulnerabilities`。

## 目录

```text
app/components/          官网组件
app/site-content.ts      中英文内容
app/globals.css          产品 token、布局与动效
public/brand/            Logo
public/og.png            社交分享图
.openai/hosting.json     Sites 项目标识与绑定
```

## 内容与品牌边界

- “咔嚓”是工具产品品牌，不是“行者大灰”的新栏目；
- 不使用“一键出片”“完全替代人工”等无法证明的承诺；
- 能力数字必须带当前版本口径，并与 README 和真实测试一致；
- 不把技术通过写成人工审片通过；
- 社交分享图和 Logo 是项目资产，不得从官网源码中单独拆出另作品牌。
