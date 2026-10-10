import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { activateInstallations } from "../scripts/install_transaction.mjs";
import { acquireFileLock, sha256File } from "../scripts/kacha_utils.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-audio-review-"));
const passed = [];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const invoke = (script, args = [], options = {}) => spawnSync(process.execPath,
  [path.join(repo, "scripts", script), ...args], { encoding: "utf8", cwd: repo, ...options });
const ok = result => { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); };
const blocked = (result, pattern) => { assert.notEqual(result.status, 0); assert.match(result.stderr, pattern); };
const check = (name, fn) => { fn(); passed.push(name); console.log(`PASS ${name}`); };
const fallback = "references/minimax-audio-fallback.md";

try {
  check("audio contracts survive full and compact routing", () => {
    for (const module of ["bgm", "sfx", "minimax", "audio_generation"]) {
      for (const stage of [null, "content", "visual_audio"]) {
        const report = ok(invoke("route_references.mjs", ["--task", "local_optimization", "--modules", module,
          ...(stage ? ["--stage", stage] : [])]));
        assert.ok(report.files.some(file => file.path === fallback));
      }
    }
    const packet = ok(invoke("prepare_agent_packet.mjs", ["--task", "local_optimization", "--stage", "visual_audio",
      "--modules", "audio_generation", "--model-tier", "economy"]));
    assert.ok(packet.readOrder.some(file => file.endsWith(fallback)));
    assert.ok(packet.contextBudget.withinBudget);
    const dialogue = ok(invoke("route_references.mjs", ["--task", "local_optimization", "--modules", "dialogue"]));
    assert.ok(!dialogue.files.some(file => file.path === fallback));
  });
  check("BGM web and audiovisual desktop defaults survive compact agent routing", () => {
    const routing = JSON.parse(fs.readFileSync(path.join(repo, "config/generation-routing.json")));
    assert.equal(routing.defaults.bgm.transport, "web");
    assert.equal(routing.defaults.bgm.url, "https://www.minimax.cn/audio");
    assert.equal(routing.defaults.video_with_audio.transport, "desktop");
    assert.equal(routing.defaults.video_with_audio.requireDecodedAudio, true);
    for (const module of ["bgm", "audio_generation", "minimax", "generated", "video_generation"]) {
      for (const stage of [null, "content", "visual_audio"]) {
        const report = ok(invoke("route_references.mjs", ["--task", "local_optimization", "--modules", module,
          ...(stage ? ["--stage", stage] : [])]));
        assert.ok(report.files.some(file => file.path === "config/generation-routing.json"));
        if (["generated", "video_generation", "minimax"].includes(module)) assert.ok(report.files.some(file => file.path === "references/generated-media-assets.md"));
      }
    }
    const rules = ok(invoke("decision_rules.mjs", ["query", "--stage", "visual_audio", "--modules", "video_generation"])).rules;
    assert.ok(rules.some(rule => rule.id === "video-with-audio-generation-default"));
  });
  check("rules retrieve fallback and protect required sound", () => {
    const rules = ok(invoke("decision_rules.mjs", ["query", "--stage", "visual_audio", "--modules", "audio_generation"])).rules;
    assert.ok(rules.some(rule => rule.id === "audio-generation-fallback"));
    const sound = ok(invoke("decision_rules.mjs", ["query", "--stage", "visual_audio", "--modules", "sfx",
      "--signals", '["effect_peak"]'])).rules.find(rule => rule.id === "sfx-semantic");
    assert.match(sound.fallback, /otherwise_block/);
  });
  check("verify-only cannot mutate installations", () => {
    const home = path.join(root, "invalid-flags-home");
    blocked(invoke("sync_skill_installs.mjs", ["--verify-only", "--apply", "--home", home]), /不能与 --apply/);
    assert.ok(!fs.existsSync(home));
  });
  check("direct sync cannot erase or replace private overlay", () => {
    const source = path.join(root, "core"), home = path.join(root, "overlay-home");
    fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "# Fixture\n");
    fs.copyFileSync(path.join(repo, "scripts/scan_secrets.py"), path.join(source, "scripts/scan_secrets.py"));
    const target = path.join(home, ".codex/skills/kacha");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, ".kacha-version"), "overlay=private-a\n");
    const overlay = path.join(root, "overlay");
    write(path.join(overlay, "manifest.json"), { schemaVersion: "1.0", id: "private-b", files: [] });
    for (const extra of [[], ["--overlay", overlay]]) {
      blocked(invoke("sync_skill_installs.mjs", ["--source", source, "--home", home, "--agent", "codex", "--apply", ...extra]), /同一 --overlay/);
      assert.equal(fs.readFileSync(path.join(target, ".kacha-version"), "utf8"), "overlay=private-a\n");
    }
  });

  const transaction = (name, { failAgent = null, readbackFailure = false, initiallyEmpty = false } = {}) => {
    const base = path.join(root, name), backupRoot = path.join(base, "backup");
    const staged = ["codex", "claude"].map(agent => {
      const target = { agent, path: path.join(base, agent), stage: path.join(base, `${agent}-next`), exists: !initiallyEmpty };
      if (target.exists) { fs.mkdirSync(target.path, { recursive: true }); fs.writeFileSync(path.join(target.path, "content"), `old-${agent}`); }
      fs.mkdirSync(target.stage, { recursive: true }); fs.writeFileSync(path.join(target.stage, "content"), "new");
      return target;
    });
    let failed = false;
    const io = { ...fs, renameSync(from, to) {
      if (!failed && failAgent && from === staged.find(target => target.agent === failAgent).stage) {
        failed = true; throw new Error("injected activation failure");
      }
      fs.renameSync(from, to);
    } };
    const action = () => activateInstallations({ staged, targets: staged, backupRoot, bundleDigest: "new", io,
      treeDigest: target => readbackFailure ? "mismatch" : fs.readFileSync(path.join(target, "content"), "utf8") });
    if (failAgent || readbackFailure) {
      assert.throws(action, /injected|hash 不一致/);
      for (const target of staged) {
        if (target.exists) assert.equal(fs.readFileSync(path.join(target.path, "content"), "utf8"), `old-${target.agent}`);
        else assert.ok(!fs.existsSync(target.path));
      }
    } else {
      assert.equal(action().length, 2);
      for (const target of staged) {
        assert.equal(fs.readFileSync(path.join(target.path, "content"), "utf8"), "new");
        assert.equal(fs.readFileSync(path.join(backupRoot, target.agent, "content"), "utf8"), `old-${target.agent}`);
      }
    }
  };
  check("first activation failure restores already moved old directory", () => transaction("first-fail", { failAgent: "codex" }));
  check("second activation failure restores both agents", () => transaction("second-fail", { failAgent: "claude" }));
  check("readback mismatch restores both agents", () => transaction("readback-fail", { readbackFailure: true }));
  check("failed initial install leaves no partial active installation", () => transaction("empty-fail", { failAgent: "claude", initiallyEmpty: true }));
  check("successful activation preserves both backups", () => transaction("success"));

  const library = path.join(root, "sfx"), mappingFile = path.join(root, "mapping.json"), source = path.join(root, "source.wav");
  write(path.join(library, "manifest.json"), { schemaVersion: "1.0", assets: [] });
  write(path.join(library, "kacha-profile.json"), { rules: [] });
  const tone = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=400:duration=0.2", source], { encoding: "utf8" });
  assert.equal(tone.status, 0, tone.stderr);
  const item = { id: "generated-click", title: "Generated click fixture", category: "ui", source, readyFile: "ready/click.wav",
    use: "confirmed interface action", route: { trigger: "confirmation", useWhen: "button lands", placement: "peak", doNotUseWhen: "ordinary speech" },
    provenance: { provider: "minimax", transport: "web", logicalAssetId: "sfx-confirmation", promptSha256: "a".repeat(64), taskId: "fixture-task", licenseEvidence: "fixture-only" } };
  const importItem = (value, extra = [], options = {}) => {
    write(mappingFile, { schemaVersion: "1.0", assets: Array.isArray(value) ? value : [value] });
    return invoke("import_private_sfx.mjs", ["--library", library, "--mapping", mappingFile, ...extra], options);
  };
  check("SFX rejects traversal and symlink destinations before copying", () => {
    blocked(importItem({ ...item, id: "../escape" }), /id 无效/);
    blocked(importItem({ ...item, readyFile: "../escape.wav" }), /库内相对路径/);
    fs.symlinkSync(root, path.join(library, "outside"));
    blocked(importItem({ ...item, readyFile: "outside/escape.wav" }), /符号链接/);
    fs.symlinkSync(path.join(root, "missing"), path.join(library, "dangling"));
    blocked(importItem({ ...item, readyFile: "dangling/escape.wav" }), /符号链接/);
    assert.ok(!fs.existsSync(path.join(root, "escape.wav")));
    assert.ok(!fs.existsSync(path.join(library, "_source")));
  });
  check("SFX locks the complete manifest transaction", () => {
    const release = acquireFileLock(path.join(library, ".kacha-sfx-import.lock"));
    try { blocked(importItem(item), /operation lock is active/); } finally { release(); }
  });
  check("SFX batch rejects duplicate identities", () => blocked(importItem([item, { ...item, title: "different title" }]), /id 无效或重复/));
  check("SFX preserves generated provenance and immutable source hash", () => {
    assert.equal(ok(importItem(item)).imported, 1);
    const asset = JSON.parse(fs.readFileSync(path.join(library, "manifest.json"))).assets[0];
    assert.deepEqual(asset.provenance, item.provenance);
    assert.equal(asset.source_sha256, sha256File(source));
    assert.equal(asset.ready_sha256, sha256File(path.join(library, asset.ready_file)));
    assert.equal(asset.distribution, "project_private_only");
    assert.equal(ok(importItem(item)).reused, 1);
    blocked(importItem({ ...item, provenance: { ...item.provenance, transport: "desktop" } }), /provenance 与待导入记录不同/);
  });
  check("SFX metadata failure restores originals and removes only new audio", () => {
    const metadata = ["manifest.json", "kacha-profile.json", "试听索引.html"].map(name => path.join(library, name));
    const before = metadata.map(file => fs.readFileSync(file));
    const injection = path.join(root, "fail-profile.mjs");
    fs.writeFileSync(injection, `import fs from 'node:fs';\nconst rename=fs.renameSync;\nlet failed=false;\nfs.renameSync=(from,to)=>{if(!failed&&to.endsWith('kacha-profile.json')){failed=true;throw new Error('injected metadata failure');}return rename(from,to);};\n`);
    write(mappingFile, { schemaVersion: "1.0", assets: [{ ...item, id: "second", title: "Second", readyFile: "ready/second.wav" }] });
    const result = spawnSync(process.execPath, ["--import", injection, path.join(repo, "scripts/import_private_sfx.mjs"),
      "--library", library, "--mapping", mappingFile], { encoding: "utf8" });
    blocked(result, /injected metadata failure/);
    metadata.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    assert.ok(!fs.existsSync(path.join(library, "ready/second.wav")));
    assert.ok(!fs.existsSync(path.join(library, "_source/project-private/second.wav")));
    assert.ok(fs.existsSync(path.join(library, "ready/click.wav")));
  });
  check("unknown paid submission stays reserved and cannot be consumed twice", () => {
    const project = path.join(root, "budget"), ledgerArgs = ["--project-root", project];
    ok(invoke("cost_ledger.mjs", ["init", ...ledgerArgs, "--budget", "10"]));
    ok(invoke("cost_ledger.mjs", ["reserve", ...ledgerArgs, "--id", "audio-attempt-1", "--provider", "minimax", "--capability", "music", "--amount", "1"]));
    const consume = ["consume", ...ledgerArgs, "--id", "audio-attempt-1", "--provider", "minimax", "--capability", "music", "--execution-id", "bgm-1-mmx", "--intent-digest", "b".repeat(64)];
    ok(invoke("cost_ledger.mjs", consume));
    blocked(invoke("cost_ledger.mjs", consume), /unused reserved or approved/);
    const status = ok(invoke("cost_ledger.mjs", ["status", ...ledgerArgs]));
    assert.equal(status.entries[0].actualAmount, null);
    assert.equal(status.entries[0].status, "reconciliation_required");
    assert.equal(status.totals.reserved, 1);
  });
  console.log(JSON.stringify({ status: "pass", count: passed.length, checks: passed, externalGeneration: false }, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
