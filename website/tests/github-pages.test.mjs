import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputRoot = path.join(websiteRoot, "pages-dist");
const basePath = "/kacha";

async function readPage(relativePath) {
  return readFile(path.join(outputRoot, relativePath), "utf8");
}

test("packages Chinese and English GitHub Pages routes", async () => {
  const [chinese, english] = await Promise.all([
    readPage("index.html"),
    readPage("en/index.html"),
  ]);

  assert.match(chinese, /从原始素材/);
  assert.match(english, /From raw footage/);
  assert.match(chinese, /dodofun@126\.com/);
  assert.match(chinese, /href="\/kacha\/en\/"/);
  assert.match(english, /href="\/kacha\/"/);
  assert.match(
    chinese,
    /rel="canonical" href="https:\/\/colorcross\.github\.io\/kacha\/"/,
  );
  assert.match(
    english,
    /rel="canonical" href="https:\/\/colorcross\.github\.io\/kacha\/en\/"/,
  );
  assert.match(
    chinese,
    /property="og:image" content="https:\/\/colorcross\.github\.io\/kacha\/og\.png"/,
  );
});

test("prefixes every deployed asset with the repository base path", async () => {
  for (const relativePath of ["index.html", "en/index.html", "404.html"]) {
    const html = await readPage(relativePath);
    assert.doesNotMatch(html, /(?:href|src)="\/(?:assets|brand|social)\//);
    assert.doesNotMatch(html, /(?<!\/kacha)\/(?:assets|brand|social)\//);
    assert.doesNotMatch(html, /(?<!\/kacha)\/og\.png/);

    const matches = html.matchAll(
      /(?:href|src)="(\/kacha\/(?:assets|brand|social)\/[^"#?]+)"/g,
    );
    const urls = [...matches].map((match) => match[1]);
    assert.ok(urls.length > 0, `${relativePath} must reference local assets`);

    for (const url of urls) {
      await access(path.join(outputRoot, url.slice(`${basePath}/`.length)));
    }
  }
});

test("ships Pages metadata and public assets without server files", async () => {
  await Promise.all([
    access(path.join(outputRoot, ".nojekyll")),
    access(path.join(outputRoot, "404.html")),
    access(path.join(outputRoot, "brand", "kacha-logo.png")),
    access(path.join(outputRoot, "social", "wechat-channels.jpg")),
    access(path.join(outputRoot, "social", "douyin.png")),
    access(path.join(outputRoot, "social", "xiaohongshu.jpg")),
    access(path.join(outputRoot, "og.png")),
  ]);

  await assert.rejects(access(path.join(outputRoot, "server")));
  await assert.rejects(access(path.join(outputRoot, ".vite")));
});
