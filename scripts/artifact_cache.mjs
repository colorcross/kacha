#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquireFileLock,
  fileIdentity,
  readJson,
  resolveRuntimeCommand,
  runtimeEnvironment,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import {
  firstPositional,
  loadKachaConfig,
} from "./kacha_config.mjs";
import { acquireResourceLeases } from "./resource_pool.mjs";

const args = process.argv.slice(2);
const delimiter = args.indexOf("--");
const action = firstPositional(args, [
  "--project-root",
  "--kind",
  "--input",
  "--implementation",
  "--parameters",
  "--operation-version",
  "--output",
  "--output-dir",
  "--resource",
  "--config",
  "--secrets",
]) ?? "help";

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function repeated(name) {
  const values = [];
  const limit = delimiter >= 0 ? delimiter : args.length;
  for (let index = 0; index < limit; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function usage() {
  console.error(
    "用法：\n"
      + "  kacha.mjs cache key --kind KIND --input FILE [可重复] "
      + "[--implementation FILE] [--parameters JSON|FILE]\n"
      + "  kacha.mjs cache run --project-root DIR --kind KIND --input FILE "
      + "--output NAME=DEST 或 --output-dir NAME=DEST [可重复] "
      + "[--resource RESOURCE] -- COMMAND [ARGS...]\n"
      + "  kacha.mjs cache inspect --project-root DIR",
  );
}

function parseParameters(value) {
  if (!value) return {};
  if (fs.existsSync(path.resolve(value)) && fs.statSync(path.resolve(value)).isFile()) {
    return readJson(path.resolve(value));
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`--parameters 不是 JSON 或 JSON 文件：${error.message}`);
  }
}

function rejectSensitive(value, label = "parameters") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitive(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:api.?key|token|secret|password|authorization|credential)/i.test(key)) {
      throw new Error(`${label}.${key} 可能包含密钥，禁止进入缓存键或 manifest`);
    }
    rejectSensitive(child, `${label}.${key}`);
  }
}

function requireFiles(values, label) {
  return values.map((candidate, index) => {
    const file = path.resolve(candidate);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`${label}[${index}] 不存在：${file}`);
    }
    return file;
  });
}

function buildKey(
  kind,
  inputs,
  implementations,
  parameters,
  operationVersion,
  outputs = [],
) {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(kind)) {
    throw new Error("--kind 必须是小写 snake_case 标识");
  }
  rejectSensitive(parameters);
  const contract = {
    schemaVersion: "1.0",
    kind,
    operationVersion,
    inputs: inputs.map((file, index) => ({
      index,
      sha256: sha256File(file),
      sizeBytes: fs.statSync(file).size,
    })),
    implementation: implementations.map((file) => ({
      name: path.basename(file),
      sha256: sha256File(file),
    })).sort((left, right) => left.name.localeCompare(right.name)),
    parameters,
    outputs: outputs.map((output) => ({
      name: output.name,
      type: output.type,
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
  return { key: sha256Value(contract), contract };
}

function parseOutputs(fileValues, directoryValues, projectRoot) {
  const names = new Set();
  return [
    ...fileValues.map((value) => ({ value, type: "file" })),
    ...directoryValues.map((value) => ({ value, type: "directory" })),
  ].map(({ value, type }) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error("--output 必须使用 NAME=DEST");
    }
    const name = value.slice(0, separator);
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name) || names.has(name)) {
      throw new Error(`输出名称无效或重复：${name}`);
    }
    names.add(name);
    const destinationValue = value.slice(separator + 1);
    const destination = path.isAbsolute(destinationValue)
      ? path.normalize(destinationValue)
      : path.resolve(projectRoot, destinationValue);
    return { name, destination, type };
  });
}

function directoryIdentity(directory) {
  const files = [];
  const walk = (current, relative = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`缓存目录不接受符号链接：${absolute}`);
      }
      if (entry.isDirectory()) walk(absolute, child);
      else if (entry.isFile()) {
        files.push({
          path: child,
          sizeBytes: fs.statSync(absolute).size,
          sha256: sha256File(absolute),
        });
      }
    }
  };
  walk(directory);
  return {
    type: "directory",
    files,
    fileCount: files.length,
    sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    sha256: sha256Value(files),
  };
}

function outputIdentity(output) {
  return output.type === "directory"
    ? { path: output.destination, ...directoryIdentity(output.destination) }
    : { type: "file", ...fileIdentity(output.destination) };
}

function entryValid(entryDirectory, manifest, verifySha256) {
  if (
    manifest?.schemaVersion !== "1.0"
    || manifest?.status !== "ready"
    || !Array.isArray(manifest.outputs)
  ) {
    return false;
  }
  return manifest.outputs.every((output) => {
    const file = path.join(entryDirectory, output.cacheFile);
    if (!fs.existsSync(file)) return false;
    if (output.type === "directory") {
      if (!fs.statSync(file).isDirectory()) return false;
      const identity = directoryIdentity(file);
      return identity.sizeBytes === output.sizeBytes
        && identity.fileCount === output.fileCount
        && (!verifySha256 || identity.sha256 === output.sha256);
    }
    if (!fs.statSync(file).isFile() || fs.statSync(file).size !== output.sizeBytes) {
      return false;
    }
    return !verifySha256 || sha256File(file) === output.sha256;
  });
}

function cacheUsageBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let sizeBytes = 0;
  for (const kind of fs.readdirSync(root, { withFileTypes: true })) {
    if (!kind.isDirectory()) continue;
    const kindDirectory = path.join(root, kind.name);
    for (const entry of fs.readdirSync(kindDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.includes(".tmp-")) continue;
      const manifestFile = path.join(kindDirectory, entry.name, "manifest.json");
      if (!fs.existsSync(manifestFile)) continue;
      try {
        const manifest = readJson(manifestFile);
        sizeBytes += (manifest.outputs ?? [])
          .reduce((sum, output) => sum + Number(output.sizeBytes ?? 0), 0);
      } catch {
        // Invalid entries are not counted as reusable capacity.
      }
    }
  }
  return sizeBytes;
}

function materialize(entryDirectory, manifest, outputs, method) {
  const byName = new Map(manifest.outputs.map((output) => [output.name, output]));
  for (const output of outputs) {
    const cached = byName.get(output.name);
    if (!cached) throw new Error(`缓存条目缺少输出：${output.name}`);
    const source = path.join(entryDirectory, cached.cacheFile);
    if (fs.existsSync(output.destination)) {
      const existing = output.type === "directory"
        && fs.statSync(output.destination).isDirectory()
        ? directoryIdentity(output.destination)
        : output.type === "file" && fs.statSync(output.destination).isFile()
          ? fileIdentity(output.destination)
          : null;
      if (existing?.sizeBytes === cached.sizeBytes && existing?.sha256 === cached.sha256) {
        continue;
      }
      throw new Error(`拒绝覆盖与缓存不一致的已有输出：${output.destination}`);
    }
    fs.mkdirSync(path.dirname(output.destination), { recursive: true });
    if (output.type === "directory") {
      fs.cpSync(source, output.destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      continue;
    }
    if (method === "hardlink") {
      try {
        fs.linkSync(source, output.destination);
        continue;
      } catch {
        // Cross-device or permission failures safely fall back to copy.
      }
    }
    fs.copyFileSync(source, output.destination, fs.constants.COPYFILE_EXCL);
  }
}

const projectRoot = path.resolve(option("--project-root", process.cwd()));
if (action === "run") fs.mkdirSync(projectRoot, { recursive: true });
let loaded;
try {
  loaded = loadKachaConfig({
    args,
    anchorPath: projectRoot,
    includeSecrets: false,
  });
} catch (error) {
  fail(`配置无效：${error.message}`, 2);
}
const cacheConfig = loaded.config.execution.artifactCache;
const cacheRoot = path.resolve(projectRoot, cacheConfig.directory);

if (action === "inspect") {
  const kinds = fs.existsSync(cacheRoot)
    ? fs.readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    : [];
  let entries = 0;
  const sizeBytes = cacheUsageBytes(cacheRoot);
  for (const kind of kinds) {
    for (const entry of fs.readdirSync(path.join(cacheRoot, kind), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.includes(".tmp-")) continue;
      const manifestFile = path.join(cacheRoot, kind, entry.name, "manifest.json");
      if (!fs.existsSync(manifestFile)) continue;
      try {
        const manifest = readJson(manifestFile);
        entries += 1;
      } catch {
        // Corrupt entries are reported by count omission and never reused.
      }
    }
  }
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    root: cacheRoot,
    kinds,
    entries,
    sizeBytes,
    maximumBytes: cacheConfig.maximumBytes,
  }, null, 2));
  process.exit(0);
}

if (!["key", "run"].includes(action)) {
  usage();
  process.exit(2);
}
const kind = option("--kind");
const inputFiles = requireFiles(repeated("--input"), "input");
const implementationFiles = requireFiles(
  repeated("--implementation"),
  "implementation",
);
if (!kind || inputFiles.length === 0) {
  usage();
  process.exit(2);
}
let parameters;
let built;
try {
  parameters = parseParameters(option("--parameters"));
  built = buildKey(
    kind,
    inputFiles,
    implementationFiles,
    parameters,
    option("--operation-version", "1"),
  );
} catch (error) {
  fail(error.message, 2);
}
if (action === "key") {
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    kind,
    key: built.key,
    contract: built.contract,
  }, null, 2));
  process.exit(0);
}

const command = delimiter >= 0 ? args.slice(delimiter + 1) : [];
let outputs;
try {
  outputs = parseOutputs(
    repeated("--output"),
    repeated("--output-dir"),
    projectRoot,
  );
  built = buildKey(
    kind,
    inputFiles,
    implementationFiles,
    parameters,
    option("--operation-version", "1"),
    outputs,
  );
} catch (error) {
  fail(error.message, 2);
}
if (outputs.length === 0 || command.length === 0) {
  usage();
  process.exit(2);
}
const entryDirectory = path.join(cacheRoot, kind, built.key);
const manifestFile = path.join(entryDirectory, "manifest.json");
if (fs.existsSync(manifestFile)) {
  try {
    const manifest = readJson(manifestFile);
    if (
      manifest.key === built.key
      && entryValid(entryDirectory, manifest, cacheConfig.verifySha256)
    ) {
      materialize(entryDirectory, manifest, outputs, cacheConfig.materialization);
      console.log(JSON.stringify({
        schemaVersion: "1.0",
        status: "pass",
        cache: { status: "hit", key: built.key, entry: entryDirectory },
        outputs: outputs.map(outputIdentity),
        videoEncodes: 0,
      }, null, 2));
      process.exit(0);
    }
  } catch {
    // Invalid cache entries are never reused and are handled as collisions below.
  }
  fail(`缓存键已存在但内容无效；请隔离检查，禁止静默覆盖：${entryDirectory}`);
}
for (const output of outputs) {
  if (fs.existsSync(output.destination)) {
    fail(`缓存 miss 时拒绝覆盖已有输出：${output.destination}`);
  }
  fs.mkdirSync(path.dirname(output.destination), { recursive: true });
}

let resources;
let startedNs;
try {
  resources = acquireResourceLeases({
    config: loaded.config,
    projectRoot,
    resources: repeated("--resource"),
    purpose: `cache:${kind}:${built.key.slice(0, 12)}`,
  });
  startedNs = process.hrtime.bigint();
  const result = spawnSync(resolveRuntimeCommand(command[0]), command.slice(1), {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: runtimeEnvironment(),
  });
  if (result.status !== 0) {
    const error = new Error(
      String(result.stderr || result.stdout || result.error?.message || "缓存任务失败").trim(),
    );
    error.exitCode = result.status ?? 1;
    throw error;
  }
  const missing = outputs.filter(
    (output) => !fs.existsSync(output.destination)
      || (
        output.type === "file"
          ? !fs.statSync(output.destination).isFile()
          : !fs.statSync(output.destination).isDirectory()
      ),
  );
  if (missing.length > 0) {
    throw new Error(
      `命令成功但缺少声明输出：${missing.map((item) => item.name).join(", ")}`,
    );
  }
  const staging = `${entryDirectory}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(staging, { recursive: true });
  const manifestOutputs = [];
  let entryBytes = 0;
  for (const output of outputs) {
    const cacheFile = output.type === "directory"
      ? `payload-${output.name}.dir`
      : `payload-${output.name}${path.extname(output.destination) || ".bin"}`;
    const cached = path.join(staging, cacheFile);
    if (output.type === "directory") {
      fs.cpSync(output.destination, cached, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    } else {
      fs.copyFileSync(output.destination, cached, fs.constants.COPYFILE_EXCL);
    }
    const identity = output.type === "directory"
      ? directoryIdentity(cached)
      : { type: "file", ...fileIdentity(cached) };
    entryBytes += identity.sizeBytes;
    manifestOutputs.push({
      name: output.name,
      type: output.type,
      cacheFile,
      sha256: identity.sha256,
      sizeBytes: identity.sizeBytes,
      ...(output.type === "directory" ? { fileCount: identity.fileCount } : {}),
    });
  }
  if (entryBytes > cacheConfig.maximumBytes) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`单个缓存条目 ${entryBytes} bytes 超过 maximumBytes`);
  }
  const manifest = {
    schemaVersion: "1.0",
    status: "ready",
    createdAt: new Date().toISOString(),
    kind,
    key: built.key,
    contract: built.contract,
    outputs: manifestOutputs,
    execution: {
      commandDigest: sha256Value(command),
      wallSeconds: Number(
        (Number(process.hrtime.bigint() - startedNs) / 1e9).toFixed(6),
      ),
      resources: resources.leases.map((lease) => ({
        resource: lease.resource,
        slot: lease.slot,
      })),
      resourceWaitSeconds: resources.waitedSeconds,
    },
    configurationDigest: loaded.digest,
  };
  writeJsonAtomic(path.join(staging, "manifest.json"), manifest);
  const releaseCapacityLock = acquireFileLock(
    path.join(cacheRoot, ".capacity.lock"),
    { purpose: `cache-capacity:${kind}:${built.key.slice(0, 12)}` },
  );
  try {
    const existingBytes = cacheUsageBytes(cacheRoot);
    if (existingBytes + entryBytes > cacheConfig.maximumBytes) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(
        `缓存容量不足：current=${existingBytes}, new=${entryBytes}, `
          + `maximum=${cacheConfig.maximumBytes}；请先检查或清理项目缓存`,
      );
    }
    fs.mkdirSync(path.dirname(entryDirectory), { recursive: true });
    fs.renameSync(staging, entryDirectory);
  } finally {
    releaseCapacityLock();
  }
  console.log(JSON.stringify({
    schemaVersion: "1.0",
    status: "pass",
    cache: { status: "miss", key: built.key, entry: entryDirectory },
    outputs: outputs.map(outputIdentity),
    wallSeconds: manifest.execution.wallSeconds,
    videoEncodes: 0,
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
} finally {
  resources?.release();
}
