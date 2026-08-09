import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Chinese Kacha product page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /咔嚓 Kacha/);
  assert.match(html, /跳到主要内容/);
  assert.match(html, /从原始素材/);
  assert.match(html, /真正耗时间的/);
  assert.match(html, /先看变化，再看功能/);
  assert.match(html, /四种风格，不是同一套卡片换颜色/);
  assert.match(html, /1920 张峰值帧/);
  assert.match(html, />127</);
  assert.match(html, /全片导演与留白预算/);
  assert.match(html, /语义审片与反馈/);
  assert.match(html, /绑定真实源片\/输出/);
  assert.match(html, /未声明近似构图 0 组/);
  assert.match(html, /本地优先/);
  assert.match(html, /Beauty v2/);
  assert.match(html, /dodofun@126\.com/);
  assert.match(html, /扫码查看真实视频效果/);
  assert.match(html, /colorcross\/kacha/);
  assert.doesNotMatch(html, /Your site is taking shape|SkeletonPreview/);
});

test("server-renders the English product page", async () => {
  const response = await render("/en");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /From raw footage/);
  assert.match(html, /Skip to main content/);
  assert.match(html, /See the change before the feature list/);
  assert.match(html, /Four styles, four editing grammars/);
  assert.match(html, /1,920 peak frames/);
  assert.match(html, />127</);
  assert.match(html, /bound to real source\/output media/);
  assert.match(html, /0 undeclared near-duplicate compositions/);
  assert.match(html, /Local first/);
  assert.match(html, /You keep the final judgment/);
  assert.match(html, /dodofun@126\.com/);
});

test("ships brand, social-card, and contact QR assets", async () => {
  await Promise.all([
    access(new URL("../public/brand/kacha-logo.png", import.meta.url)),
    access(new URL("../public/og.png", import.meta.url)),
    access(new URL("../public/social/wechat-channels.jpg", import.meta.url)),
    access(new URL("../public/social/douyin.png", import.meta.url)),
    access(new URL("../public/social/xiaohongshu.jpg", import.meta.url)),
  ]);
});

test("uses the local logo without the incompatible vinext image shim", async () => {
  const logoComponent = await readFile(
    new URL("../app/components/LogoMark.tsx", import.meta.url),
    "utf8",
  );
  assert.match(logoComponent, /<img/);
  assert.doesNotMatch(logoComponent, /from ["']next\/image["']/);
});

test("internal anchors bypass the static host router and keep scrolling", async () => {
  const scrollLink = await readFile(
    new URL("../app/components/ScrollLink.tsx", import.meta.url),
    "utf8",
  );

  assert.match(scrollLink, /event\.preventDefault\(\)/);
  assert.match(scrollLink, /event\.stopPropagation\(\)/);
  assert.match(scrollLink, /window\.history\.pushState/);
  assert.match(scrollLink, /window\.scrollTo/);
  assert.match(scrollLink, /getBoundingClientRect\(\)\.bottom/);
  assert.match(scrollLink, /fixedBottom/);
});
