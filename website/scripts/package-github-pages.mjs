import {
  access,
  cp,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const clientRoot = path.join(websiteRoot, "dist", "client");
const prerenderRoot = path.join(
  websiteRoot,
  "dist",
  "server",
  "prerendered-routes",
);
const outputRoot = path.join(websiteRoot, "pages-dist");
const basePath = (process.env.GITHUB_PAGES_BASE_PATH ?? "").replace(
  /\/+$/,
  "",
);

if (!basePath.startsWith("/") || basePath === "/") {
  throw new Error(
    "GITHUB_PAGES_BASE_PATH must be a non-root path such as /kacha",
  );
}

await Promise.all([
  access(path.join(prerenderRoot, "index.html")),
  access(path.join(prerenderRoot, "en.html")),
  access(path.join(prerenderRoot, "404.html")),
]);

await rm(outputRoot, { recursive: true, force: true });
await cp(clientRoot, outputRoot, { recursive: true });
await Promise.all([
  rm(path.join(outputRoot, ".vite"), { recursive: true, force: true }),
  unlink(path.join(outputRoot, ".assetsignore")).catch(() => {}),
  unlink(path.join(outputRoot, "_headers")).catch(() => {}),
]);

await mkdir(path.join(outputRoot, "en"), { recursive: true });
const pageCopies = [
  ["index.html", "index.html"],
  ["en.html", "en/index.html"],
  ["index.html", "404.html"],
];

await Promise.all(
  pageCopies.map(async ([source, destination]) => {
    const html = await readFile(path.join(prerenderRoot, source), "utf8");
    let rewritten = html;
    for (const [rootPath, marker] of [
      ["/assets/", "__KACHA_ASSET_PREFIX__"],
      ["/brand/", "__KACHA_BRAND_PREFIX__"],
      ["/og.png", "__KACHA_OG_IMAGE__"],
    ]) {
      const deployedPath = `${basePath}${rootPath}`;
      rewritten = rewritten
        .replaceAll(deployedPath, marker)
        .replaceAll(rootPath, deployedPath)
        .replaceAll(marker, deployedPath);
    }
    await writeFile(path.join(outputRoot, destination), rewritten);
  }),
);
await writeFile(path.join(outputRoot, ".nojekyll"), "");

for (const relativePath of ["index.html", "en/index.html", "404.html"]) {
  const html = await readFile(path.join(outputRoot, relativePath), "utf8");
  if (!html.includes(`${basePath}/assets/`)) {
    throw new Error(`${relativePath} is missing the GitHub Pages asset prefix`);
  }
  if (html.includes('href="/assets/') || html.includes('src="/assets/')) {
    throw new Error(`${relativePath} contains a root-relative asset URL`);
  }
  if (html.includes('import("/assets/')) {
    throw new Error(`${relativePath} contains a root-relative module import`);
  }
}

process.stdout.write(`${outputRoot}\n`);
