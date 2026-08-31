#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kacha = path.join(repositoryRoot, "scripts", "kacha.mjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kacha-distribution-"));

function execute(args, { expectStatus = 0, timeout = 90_000, env = process.env } = {}) {
  const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024, env });
  assert.equal(result.status, expectStatus, result.stderr || result.stdout);
  return result;
}

try {
  for (const client of ["codex", "claude"]) {
    const shown = JSON.parse(execute([kacha, "mcp-config", "show", "--client", client, "--root", temporary]).stdout);
    assert.equal(shown.transport, "stdio");
    assert.equal(shown.projectRoot, fs.realpathSync(temporary));
    assert.equal(shown.command.includes("--root"), true);
    assert.equal(shown.command.includes(fs.realpathSync(temporary)), true);
    assert.match(shown.serverScript, /kacha_mcp_server\.mjs$/);
  }
  const relativeRoot = execute([kacha, "mcp-config", "show", "--client", "codex", "--root", "."], { expectStatus: 1 });
  assert.match(relativeRoot.stderr, /existing absolute directory/);

  const fakeBin = path.join(temporary, "fake-bin");
  const fakeState = path.join(temporary, "fake-mcp-state");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeCodex = path.join(fakeBin, "codex");
  fs.writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" != "mcp" ]; then exit 2; fi
if [ "$2" = "get" ]; then
  if [ "$KACHA_FAKE_GET_ERROR" = "1" ]; then echo "authentication failed" >&2; exit 2; fi
  if [ "$KACHA_FAKE_POST_ADD_GET_ERROR" = "1" ] && [ -f "$KACHA_FAKE_MCP_STATE" ]; then echo "readback failed" >&2; exit 2; fi
  if [ -f "$KACHA_FAKE_MCP_STATE" ]; then
    if [ "$KACHA_FAKE_WRONG_ROOT" = "1" ]; then root="$KACHA_FAKE_PROJECT_ROOT-other"; else root="$KACHA_FAKE_PROJECT_ROOT"; fi
    printf '%s\n' "$3 enabled" "command: $KACHA_FAKE_EXECUTABLE" "args: $KACHA_FAKE_SERVER_SCRIPT --root $root"
    exit 0
  fi
  echo "No MCP server named \"$3\"." >&2; exit 1
fi
if [ "$2" = "add" ]; then : > "$KACHA_FAKE_MCP_STATE"; echo "Added $3"; exit 0; fi
if [ "$2" = "remove" ]; then rm -f "$KACHA_FAKE_MCP_STATE"; echo "Removed $3"; exit 0; fi
exit 2
`);
  fs.chmodSync(fakeCodex, 0o755);
  const fakeEnv = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    KACHA_FAKE_MCP_STATE: fakeState,
    KACHA_FAKE_PROJECT_ROOT: fs.realpathSync(temporary),
    KACHA_FAKE_EXECUTABLE: process.execPath,
    KACHA_FAKE_SERVER_SCRIPT: fs.realpathSync(path.join(repositoryRoot, "scripts", "kacha_mcp_server.mjs")),
  };
  const uncertainPreflight = execute([kacha, "mcp-config", "install", "--client", "codex", "--root", temporary, "--apply"], {
    expectStatus: 1,
    env: { ...fakeEnv, KACHA_FAKE_GET_ERROR: "1" },
  });
  assert.match(uncertainPreflight.stderr, /absence was not proven/);
  assert.equal(fs.existsSync(fakeState), false, "uncertain preflight must not register a server");
  const installed = JSON.parse(execute([kacha, "mcp-config", "install", "--client", "codex", "--root", temporary, "--apply"], { env: fakeEnv }).stdout);
  assert.equal(installed.status, "installed");
  assert.equal(installed.readbackVerified, true);
  assert.equal(installed.readbackBindings.projectRoot, fs.realpathSync(temporary));
  assert.match(installed.readback, /kacha-local enabled/);
  const duplicateInstall = execute([kacha, "mcp-config", "install", "--client", "codex", "--root", temporary, "--apply"], { expectStatus: 1, env: fakeEnv });
  assert.match(duplicateInstall.stderr, /refusing to overwrite/);

  fs.unlinkSync(fakeState);
  const mismatchedReadback = execute([kacha, "mcp-config", "install", "--client", "codex", "--root", temporary, "--apply"], {
    expectStatus: 1,
    env: { ...fakeEnv, KACHA_FAKE_WRONG_ROOT: "1" },
  });
  assert.match(mismatchedReadback.stderr, /readback does not match requested registration.*rolled back/s);
  assert.equal(fs.existsSync(fakeState), false, "mismatched readback must roll back the new registration");
  const failedReadback = execute([kacha, "mcp-config", "install", "--client", "codex", "--root", temporary, "--apply"], {
    expectStatus: 1,
    env: { ...fakeEnv, KACHA_FAKE_POST_ADD_GET_ERROR: "1" },
  });
  assert.match(failedReadback.stderr, /readback failed.*rolled back/s);
  assert.equal(fs.existsSync(fakeState), false, "failed post-add readback must roll back the new registration");

  const demoRoot = path.join(temporary, "demo");
  const demo = JSON.parse(execute([path.join(repositoryRoot, "examples", "first-run", "demo.mjs"), "--output-dir", demoRoot]).stdout);
  assert.equal(demo.status, "pass");
  assert.equal(demo.withinActivationTarget, true);
  assert.ok(fs.statSync(demo.output.path).size > 0);
  assert.match(demo.boundaries.join(" "), /Human visual acceptance/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(demoRoot, "demo-summary.json"), "utf8")).output.sha256, demo.output.sha256);

  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "config", "mcp", "kacha.json"), "utf8"));
  assert.equal(manifest.security.rootConfined, true);
  assert.equal(manifest.security.wholeProjectOverwrite, false);
  assert.equal(manifest.renderBoundary.final, "ffmpeg-render-graph-only");
  const studioServer = fs.readFileSync(path.join(repositoryRoot, "scripts", "kacha_studio_server.mjs"), "utf8");
  const workbenchClient = fs.readFileSync(path.join(repositoryRoot, "studio", "editor.js"), "utf8");
  assert.match(studioServer, /"assets", "brand", "kacha-logo\.png"/);
  assert.doesNotMatch(studioServer, /"website", "public", "brand"/);
  assert.match(workbenchClient, /renderSelection\(\); seekOutputTick\(state\.outputTick\)/, "project refresh must remap output time to source media");
  assert.match(workbenchClient, /input\.required = true/);
  assert.match(workbenchClient, /Number\.isFinite\(input\.valueAsNumber\)/);
  assert.match(workbenchClient, /revision\.status === "expired"[\s\S]*source\.close\(\)/, "terminal SSE expiry must stop reconnecting");
  assert.match(workbenchClient, /asset\.replacementEligible === true/, "Project Bin authorization must come from audited server evidence");
  assert.equal(fs.existsSync(path.join(repositoryRoot, "assets", "brand", "kacha-logo.png")), true);
  process.stdout.write("Workbench distribution tests passed: client configs, 90-second demo, MCP security manifest.\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
