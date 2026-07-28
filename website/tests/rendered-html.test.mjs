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
  assert.match(html, /把视频工作流做完/);
  assert.match(html, /本地优先/);
  assert.match(html, /Beauty v2/);
  assert.match(html, /colorcross\/kacha/);
  assert.doesNotMatch(html, /Your site is taking shape|SkeletonPreview/);
});

test("server-renders the English product page", async () => {
  const response = await render("/en");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Finish the workflow/);
  assert.match(html, /Local first/);
  assert.match(html, /Automation never impersonates review/);
});

test("ships the brand and social-card assets", async () => {
  await access(new URL("../public/brand/kacha-logo.png", import.meta.url));
  await access(new URL("../public/og.png", import.meta.url));
});

test("uses the local logo without the incompatible vinext image shim", async () => {
  const logoComponent = await readFile(
    new URL("../app/components/LogoMark.tsx", import.meta.url),
    "utf8",
  );
  assert.match(logoComponent, /<img/);
  assert.doesNotMatch(logoComponent, /from ["']next\/image["']/);
});
