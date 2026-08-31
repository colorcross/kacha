#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./kacha_utils.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  process.stderr.write(`${JSON.stringify({ schemaVersion: "1.0", status: "blocked", error: message }, null, 2)}\n`);
  process.exit(code);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function commandOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function missingServer(result, name) {
  if (result.status === 0) return false;
  const output = commandOutput(result);
  return output.includes("No MCP server named") && output.includes(name);
}

function verifyReadback(value, output) {
  const requiredBindings = {
    name: value.name,
    executable: value.executable,
    serverScript: value.serverScript,
    rootFlag: "--root",
    projectRoot: value.projectRoot,
  };
  const containsBinding = (binding) => {
    const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s:=,\\[\\]'\"])${escaped}(?=$|[\\s,\\[\\]'\"])`, "m").test(output);
  };
  const missing = Object.entries(requiredBindings)
    .filter(([, binding]) => !containsBinding(binding))
    .map(([field]) => field);
  if (missing.length > 0) {
    throw new Error(`${value.client} MCP readback does not match requested registration (${missing.join(", ")})`);
  }
  const expectedArguments = `${value.serverScript} --root ${value.projectRoot}`;
  if (!output.includes(expectedArguments)) {
    throw new Error(`${value.client} MCP readback does not preserve the requested server argument order`);
  }
  return requiredBindings;
}

function rollbackRegistration(value, cause) {
  const removeArguments = value.client === "claude"
    ? ["mcp", "remove", value.name, "--scope", "user"]
    : ["mcp", "remove", value.name];
  const removed = run(value.client, removeArguments);
  const readback = run(value.client, ["mcp", "get", value.name]);
  if (removed.status === 0 && missingServer(readback, value.name)) {
    throw new Error(`${cause}; newly registered server was rolled back and absence was verified`);
  }
  const evidence = [
    `remove=${commandOutput(removed) || `exit ${removed.status}`}`,
    `readback=${commandOutput(readback) || `exit ${readback.status}`}`,
  ].join("; ");
  throw new Error(`${cause}; rollback could not be verified (${evidence})`);
}

function build(client, root, script, name) {
  if (!new Set(["codex", "claude"]).has(client)) throw new Error("--client must be codex|claude");
  const command = client === "codex"
    ? ["codex", "mcp", "add", name, "--", process.execPath, script, "--root", root]
    : ["claude", "mcp", "add", "--scope", "user", name, "--", process.execPath, script, "--root", root];
  return {
    schemaVersion: "1.0",
    status: "ready",
    client,
    name,
    transport: "stdio",
    projectRoot: root,
    executable: process.execPath,
    serverScript: script,
    command,
    shellCommand: command.map(shellQuote).join(" "),
    mutationBoundary: "The command only registers the local stdio server; Kacha mutations remain SHA-locked and root-confined.",
  };
}

const args = process.argv.slice(2);
const action = args[0];
if (!new Set(["show", "validate", "install"]).has(action)) fail("usage: kacha.mjs mcp-config show|validate|install --client codex|claude --root /absolute/project [--apply]", 2);
try {
  const client = option(args, "--client");
  const rootInput = option(args, "--root");
  const name = option(args, "--name", "kacha-local");
  const scriptInput = option(args, "--server-script", path.join(repositoryRoot, "scripts", "kacha_mcp_server.mjs"));
  if (!client || !rootInput) throw new Error("--client and --root are required");
  if (!path.isAbsolute(rootInput) || !fs.existsSync(rootInput) || !fs.statSync(rootInput).isDirectory()) throw new Error("--root must be an existing absolute directory");
  if (!path.isAbsolute(scriptInput) || !fs.existsSync(scriptInput) || !fs.statSync(scriptInput).isFile()) throw new Error("--server-script must be an existing absolute file");
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) throw new Error("--name must use 1-64 letters, digits, dot, underscore or hyphen");
  const value = build(client, fs.realpathSync(rootInput), fs.realpathSync(scriptInput), name);
  if (action === "validate") {
    const help = run(client, ["mcp", "add", "--help"]);
    if (help.status !== 0 || !`${help.stdout}\n${help.stderr}`.includes("mcp add")) throw new Error(`${client} mcp add is unavailable`);
    value.status = "pass";
    value.clientCliVerified = true;
  }
  if (action === "install") {
    if (!args.includes("--apply")) throw new Error("install requires explicit --apply; use show for a dry run");
    const existing = run(client, ["mcp", "get", name]);
    if (existing.status === 0) throw new Error(`${client} already has MCP server ${name}; refusing to overwrite it implicitly`);
    if (!missingServer(existing, name)) {
      throw new Error(`${client} MCP preflight failed; server absence was not proven: ${commandOutput(existing) || `exit ${existing.status}`}`);
    }
    const installed = run(value.command[0], value.command.slice(1));
    if (installed.status !== 0) throw new Error(installed.stderr.trim() || `${client} MCP registration failed`);
    const readback = run(client, ["mcp", "get", name]);
    if (readback.status !== 0) {
      rollbackRegistration(value, `${client} MCP registration command succeeded but readback failed: ${commandOutput(readback) || `exit ${readback.status}`}`);
    }
    const readbackOutput = commandOutput(readback);
    try {
      value.readbackBindings = verifyReadback(value, readbackOutput);
    } catch (error) {
      rollbackRegistration(value, error.message);
    }
    value.status = "installed";
    value.clientOutput = installed.stdout.trim();
    value.readbackVerified = true;
    value.readback = readbackOutput;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
} catch (error) {
  fail(error.message);
}
