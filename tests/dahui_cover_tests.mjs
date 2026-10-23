import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileIdentity, writeJsonAtomic } from "../scripts/kacha_utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dahui-cover-"));
let checks = 0;
function cli(args, ok = true) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/kacha.mjs"), "cover", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status === 0, ok, result.stderr || result.stdout);
  checks++;
  return ok ? JSON.parse(result.stdout) : result;
}
try {
  const proof = path.join(dir, "actual-source.txt");
  fs.writeFileSync(proof, "Synthetic regression fixture; not production evidence.");
  const file = path.join(dir, "cover.json");
  cli(["template", "--pack", "dahui-ai", "--project-id", "fixture", "--show", "ai-reading", "--aspect-ratio", "3:4", "--evidence", proof, "--output", file]);
  const cover = JSON.parse(fs.readFileSync(file));
  assert.equal(cover.design.variant, "scene-poster");
  assert.equal(cover.design.aspectRatio, "3:4");
  cli(["validate", "--contract", file], false); // Empty template cannot masquerade as ready.
  Object.assign(cover, { question: "AI能帮我读懂什么？", headline: "读书，AI能帮多少？", composition: "真实主书与本人，标题在左侧负空间" });
  writeJsonAtomic(file, cover);
  const prompt = cli(["prompt", "--contract", file]).prompt;
  assert.equal(prompt.design.showId, "ai-reading");
  assert(prompt.layoutBrief.includes("一本真实主书"));
  const styleProfile = JSON.parse(fs.readFileSync(path.join(root, "config/cover-profiles/dahui-ai.json")));
  assert.equal(prompt.palette.emphasis, styleProfile.palette.emphasis);
  assert(prompt.backgroundPrompt.includes("不要生成任何人物"));
  assert.equal(prompt.formalText.headline, cover.headline);
  assert.equal(prompt.generationRequired, false);
  assert.deepEqual(prompt.generationInputReferences, []);
  assert.equal(prompt.compositingSources[0].sha256, cover.sources[0].sha256);
  cover.illustrations = [{ ...fileIdentity(proof), role: "real_evidence", purpose: "辅助示意" }];
  writeJsonAtomic(file, cover);
  cli(["validate", "--contract", file], false);
  cover.illustrations[0].role = "generated_illustration";
  writeJsonAtomic(file, cover);
  assert.equal(cli(["prompt", "--contract", file]).prompt.illustrationLayers[0].role, "generated_illustration");
  cover.illustrations[0].sha256 = "0".repeat(64);
  writeJsonAtomic(file, cover);
  cli(["validate", "--contract", file], false);
  cover.illustrations = [];
  writeJsonAtomic(file, cover);
  cli(["validate", "--contract", file, "--require-qc-pass"], false);
  const originalDesign = structuredClone(cover.design);
  for (const [key, value] of [["variant", "unknown"], ["showId", "legacy-show"], ["aspectRatio", "7:2"], ["profileSha256", "0".repeat(64)], ["profileId", "other-profile"]]) {
    cover.design = { ...originalDesign, [key]: value };
    writeJsonAtomic(file, cover);
    cli(["prompt", "--contract", file], false);
  }
  // No-design contracts remain on their frozen legacy brief; no silent migration.
  delete cover.design;
  writeJsonAtomic(file, cover);
  assert.equal(cli(["prompt", "--contract", file]).prompt.design, undefined);
  cover.sources = [{ ...fileIdentity(proof), role: "generated_evidence" }];
  writeJsonAtomic(file, cover);
  cli(["validate", "--contract", file], false);
  for (const [show, variant] of [["ai-practice", "tech-interface"], ["ai-review", "tech-interface"], ["ai-interview", "scene-poster"], ["ai-news", "tech-interface"], ["ai-debate", "scene-poster"], ["product-practice", "scene-poster"], ["life-iteration", "scene-poster"]]) {
    const target = path.join(dir, `${show}.json`);
    cli(["template", "--pack", "dahui-ai", "--project-id", "fixture", "--show", show, "--output", target]);
    const data = JSON.parse(fs.readFileSync(target));
    assert.equal(data.design.variant, variant);
    Object.assign(data, { question: "真实问题？", headline: "真实问题", composition: "本人和一组实际来源", sources: [{ ...fileIdentity(proof), role: "real_evidence" }] });
    writeJsonAtomic(target, data);
    assert.equal(cli(["prompt", "--contract", target]).prompt.design.variant, variant);
  }
  cli(["template", "--pack", "dahui-ai", "--project-id", "fixture", "--show", "product-practice", "--variant", "tech-interface", "--aspect-ratio", "16:9", "--output", path.join(dir, "override.json")]);
  cli(["template", "--pack", "dahui-ai", "--project-id", "fixture", "--show", "missing", "--output", path.join(dir, "invalid.json")], false);
  console.log(`PASS 大灰AI封面CLI：${checks}项调用；八栏目、变体、画幅、风格摘要、旧合同与证据/QC边界。`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
