#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const routingFile = path.join(skillDirectory, "config", "font-routing.json");
const helperFile = path.join(scriptDirectory, "font_metadata.py");
const previewHelperFile = path.join(scriptDirectory, "render_font_preview.py");
const args = process.argv.slice(2);
const action = args[0];

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(name) {
  return args.includes(name);
}

function fail(message, code = 1) {
  console.error(JSON.stringify({
    schemaVersion: "1.0",
    status: "blocked",
    error: message,
  }, null, 2));
  process.exit(code);
}

function fontFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ttf|otf|ttc)$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function classify(record, routing) {
  const haystack = [
    record.fileName,
    ...record.families,
    ...record.fullNames,
    ...record.postscriptNames,
  ].join(" ").toLowerCase();
  const classes = Object.entries(routing.classificationHints ?? {})
    .filter(([, hints]) => hints.some((hint) => haystack.includes(hint.toLowerCase())))
    .map(([id]) => id);
  if (classes.length === 0) classes.push("unclassified");
  return classes;
}

function readMetadata(files) {
  const result = run("python3", [helperFile, ...files]);
  if (result.status !== 0) {
    throw new Error(`字体元数据读取失败：${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function scan(directory) {
  const files = fontFiles(directory);
  if (files.length === 0) throw new Error(`没有找到 TTF/OTF/TTC：${directory}`);
  const routing = readJson(routingFile);
  const metadata = readMetadata(files);
  const firstByHash = new Map();
  const records = metadata.records.map((record) => {
    const digest = sha256File(record.file);
    const licenseStatus = record.license.status;
    const duplicateOf = firstByHash.get(digest) ?? null;
    if (!duplicateOf) firstByHash.set(digest, record.fileName);
    return {
      ...record,
      sha256: digest,
      bytes: fs.statSync(record.file).size,
      classes: classify(record, routing),
      localUse: {
        status: licenseStatus === "open" ? "allowed_by_embedded_license" : "index_only",
        requiresProjectAuthorization:
          !routing.distributionPolicy.automaticSelectionStatuses.includes(licenseStatus),
      },
      duplicateOf,
      redistributionAllowed: licenseStatus === "open",
    };
  });
  const registry = {
    schemaVersion: "1.0",
    kind: "kacha_local_font_registry",
    generatedAt: new Date().toISOString(),
    source: {
      directory: path.resolve(directory),
      fileCount: records.length,
    },
    policy: routing.distributionPolicy,
    records,
    errors: metadata.errors,
  };
  registry.digest = sha256Value({ ...registry, digest: undefined });
  return registry;
}

function aliases(record) {
  return new Set([
    ...record.families,
    ...record.fullNames,
    ...record.postscriptNames,
  ].map((value) => value.toLowerCase()));
}

function supportsSceneText(record, text) {
  if (!text) return true;
  const hasCjk = /[\u3400-\u9fff]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  const hasDigits = /\d/.test(text);
  if (
    hasCjk
    && (record.coverage?.simplifiedChinese?.ratio ?? 0) < 0.9
    && (record.coverage?.traditionalChinese?.ratio ?? 0) < 0.9
  ) return false;
  if (hasLatin && (record.coverage?.latin?.ratio ?? 0) < 0.9) return false;
  if (hasDigits && (record.coverage?.digits?.ratio ?? 0) < 0.9) return false;
  return true;
}

function materializeRegistryPaths(registry, registryFile) {
  const baseDirectory = path.dirname(path.resolve(registryFile));
  return {
    ...registry,
    records: (registry.records ?? []).map((record) => ({
      ...record,
      file: path.isAbsolute(record.file)
        ? record.file
        : path.resolve(baseDirectory, record.file),
    })),
  };
}

function routeFont(registry, roleId, text, allowRestricted) {
  const routing = readJson(routingFile);
  const role = routing.roles[roleId];
  if (!role) throw new Error(`字体角色不存在：${roleId}`);
  const allowedStatuses = new Set(routing.distributionPolicy.automaticSelectionStatuses);
  const eligible = registry.records.filter((record) => (
    supportsSceneText(record, text)
    && (
      allowRestricted
      || allowedStatuses.has(record.license.status)
      || record.projectAuthorization?.status === "authorized"
    )
    && (role.allowDecorative || !record.classes.includes("fantasy_decorative"))
  ));
  const ranked = eligible.map((record) => {
    const names = aliases(record);
    const preferredFamilyIndex = (role.preferredFamilies ?? []).findIndex((family) => {
      const requested = family.toLowerCase();
      return [...names].some(
        (name) => name === requested || name.includes(requested) || requested.includes(name),
      );
    });
    const preferredClassIndex = (role.preferredClasses ?? []).findIndex(
      (fontClass) => record.classes.includes(fontClass),
    );
    const weight = Number(record.weightClass ?? 400);
    const weightPenalty = weight > role.maximumWeight
      ? 40
      : Math.abs(weight - Number(role.targetWeight ?? 500)) / 100;
    const licensePenalty = (
      record.license.status === "open"
      || record.projectAuthorization?.status === "authorized"
    ) ? 0 : 20;
    const duplicatePenalty = record.duplicateOf ? 2 : 0;
    return {
      record,
      score: (preferredFamilyIndex < 0 ? 100 : preferredFamilyIndex * 5)
        + (preferredClassIndex < 0 ? 30 : preferredClassIndex * 3)
        + weightPenalty
        + licensePenalty
        + duplicatePenalty,
    };
  }).sort((left, right) => left.score - right.score);
  if (ranked.length === 0) {
    throw new Error(
      `角色 ${roleId} 没有覆盖当前文本且授权状态可用的字体`
      + (allowRestricted ? "" : "；可在确认项目字体授权后显式使用 --allow-restricted"),
    );
  }
  const selected = ranked[0].record;
  return {
    schemaVersion: "1.0",
    status: (
      selected.license.status === "open"
      || selected.projectAuthorization?.status === "authorized"
    ) ? "pass" : "pass_with_project_license_review",
    roleId,
    role,
    textClass: {
      cjk: /[\u3400-\u9fff]/.test(text),
      latin: /[A-Za-z]/.test(text),
      digits: /\d/.test(text),
    },
    selected: {
      file: selected.file,
      fileName: selected.fileName,
      family: selected.families[0] ?? selected.postscriptNames[0],
      aliases: [...aliases(selected)],
      sha256: selected.sha256,
      classes: selected.classes,
      license: selected.license,
      localUse: selected.localUse,
      projectAuthorization: selected.projectAuthorization ?? null,
      redistributionAllowed: selected.redistributionAllowed,
    },
    alternatives: ranked.slice(1, 4).map(({ record, score }) => ({
      fileName: record.fileName,
      family: record.families[0] ?? record.postscriptNames[0],
      classes: record.classes,
      licenseStatus: record.license.status,
      score,
    })),
    publicRepositorySafe: false,
  };
}

function validateRegistry(registry, registryFile) {
  const errors = [];
  if (registry.schemaVersion !== "1.0") errors.push("schemaVersion 必须为 1.0");
  if (registry.kind !== "kacha_local_font_registry") {
    errors.push("kind 必须为 kacha_local_font_registry");
  }
  if (!Array.isArray(registry.records) || registry.records.length === 0) {
    errors.push("records 必须是非空数组");
  }
  for (const [index, record] of (registry.records ?? []).entries()) {
    const label = `records[${index}]`;
    const resolvedFile = record.file && (
      path.isAbsolute(record.file)
        ? record.file
        : path.resolve(path.dirname(path.resolve(registryFile)), record.file)
    );
    if (!resolvedFile || !fs.existsSync(resolvedFile)) {
      errors.push(`${label}.file 不存在：${record.file ?? "missing"}`);
      continue;
    }
    if (sha256File(resolvedFile) !== record.sha256) errors.push(`${label}.sha256 已失效`);
    if (!["open", "authorization_required", "unverified", "unknown"].includes(
      record.license?.status,
    )) {
      errors.push(`${label}.license.status 无效`);
    }
    if (record.redistributionAllowed && record.license.status !== "open") {
      errors.push(`${label} 未确认开放许可却标记可再分发`);
    }
  }
  const expectedDigest = sha256Value({ ...registry, digest: undefined });
  if (expectedDigest !== registry.digest) errors.push("registry digest 不一致");
  return errors;
}

if (!["scan", "authorize", "validate", "resolve", "preview"].includes(action)) {
  fail(
    "用法：kacha.mjs fonts scan --directory DIR --output registry.json\n"
    + "  kacha.mjs fonts authorize --registry registry.json --output authorized.json "
    + "--statement TEXT [--scope local_video_production|video_production_and_published_outputs]\n"
    + "  kacha.mjs fonts validate --registry registry.json\n"
    + "  kacha.mjs fonts resolve --registry registry.json --role ROLE --text TEXT\n"
    + "  kacha.mjs fonts preview --font FILE --output preview.png [--text TEXT]",
    2,
  );
}

try {
  if (action === "scan") {
    const directory = path.resolve(option("--directory", ""));
    if (!fs.existsSync(directory)) fail(`字体目录不存在：${directory}`, 2);
    const registry = scan(directory);
    const output = option("--output");
    if (output) {
      const destination = path.resolve(output);
      if (fs.existsSync(destination) && !has("--overwrite")) {
        fail(`拒绝覆盖字体清单：${destination}`, 2);
      }
      writeJsonAtomic(destination, registry);
    }
    console.log(JSON.stringify({
      ...registry,
      records: registry.records.map((record) => ({
        fileName: record.fileName,
        families: record.families,
        classes: record.classes,
        sha256: record.sha256,
        license: record.license,
        localUse: record.localUse,
        redistributionAllowed: record.redistributionAllowed,
      })),
    }, null, 2));
  } else if (action === "authorize") {
    const registryFile = path.resolve(option("--registry", ""));
    const output = path.resolve(option("--output", ""));
    const statement = option("--statement");
    const authorizationScope = option("--scope", "local_video_production");
    const allowedAuthorizationScopes = new Set([
      "local_video_production",
      "video_production_and_published_outputs",
    ]);
    if (!fs.existsSync(registryFile)) fail(`字体清单不存在：${registryFile}`, 2);
    if (!statement) fail("项目字体授权需要 --statement", 2);
    if (!allowedAuthorizationScopes.has(authorizationScope)) {
      fail(`不支持的字体授权范围：${authorizationScope}`, 2);
    }
    if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖：${output}`, 2);
    const registry = readJson(registryFile);
    const errors = validateRegistry(registry, registryFile);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    const authorizedAt = new Date().toISOString();
    const authorized = {
      ...registry,
      generatedAt: authorizedAt,
      projectAuthorization: {
        status: "authorized",
        scope: authorizationScope,
        source: "user_explicit_statement",
        statement,
        authorizedAt,
        publicRedistributionAllowed: false,
      },
      records: registry.records.map((record) => {
        const resolvedFile = path.isAbsolute(record.file)
          ? record.file
          : path.resolve(path.dirname(registryFile), record.file);
        const relativeFile = path.relative(path.dirname(output), resolvedFile);
        return ({
        ...record,
        file: !path.isAbsolute(relativeFile) && !relativeFile.startsWith(`..${path.sep}`)
          ? relativeFile
          : resolvedFile,
        localUse: {
          status: "project_authorized",
          requiresProjectAuthorization: false,
        },
        projectAuthorization: {
          status: "authorized",
          scope: authorizationScope,
          source: "user_explicit_statement",
          authorizedAt,
          publicRedistributionAllowed: false,
        },
      });
      }),
    };
    const portable = authorized.records.every((record) => !path.isAbsolute(record.file));
    if (portable) {
      authorized.source = {
        ...authorized.source,
        directory: ".",
      };
    }
    authorized.digest = sha256Value({ ...authorized, digest: undefined });
    writeJsonAtomic(output, authorized);
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      output,
      fontCount: authorized.records.length,
      localUse: "project_authorized",
      publicRedistributionAllowed: false,
      digest: authorized.digest,
    }, null, 2));
  } else if (action === "validate") {
    const registryFile = path.resolve(option("--registry", ""));
    if (!fs.existsSync(registryFile)) fail(`字体清单不存在：${registryFile}`, 2);
    const registry = readJson(registryFile);
    const errors = validateRegistry(registry, registryFile);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      registry: registryFile,
      fontCount: registry.records.length,
      openLicenseCount: registry.records.filter(
        (record) => record.license.status === "open",
      ).length,
      restrictedOrUnknownCount: registry.records.filter(
        (record) => record.license.status !== "open",
      ).length,
      duplicateFileCount: registry.records.filter((record) => record.duplicateOf).length,
      digest: registry.digest,
    }, null, 2));
  } else if (action === "resolve") {
    const registryFile = path.resolve(option("--registry", ""));
    if (!fs.existsSync(registryFile)) fail(`字体清单不存在：${registryFile}`, 2);
    const registry = readJson(registryFile);
    const errors = validateRegistry(registry, registryFile);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    const result = routeFont(
      materializeRegistryPaths(registry, registryFile),
      option("--role", "subtitle_primary"),
      option("--text", "字幕设计"),
      has("--allow-restricted"),
    );
    console.log(JSON.stringify(result, null, 2));
  } else {
    const fontFile = path.resolve(option("--font", ""));
    const output = path.resolve(option("--output", ""));
    if (!fs.existsSync(fontFile)) fail(`字体文件不存在：${fontFile}`, 2);
    if (fs.existsSync(output) && !has("--overwrite")) fail(`拒绝覆盖：${output}`, 2);
    const text = option("--text", "字幕设计 · Aa 123");
    const result = run("python3", [
      previewHelperFile,
      "--font", fontFile,
      "--output", output,
      "--text", text,
    ]);
    if (result.status !== 0) throw new Error(`字体预览失败：${result.stderr}`);
    console.log(JSON.stringify({
      schemaVersion: "1.0",
      status: "pass",
      output,
      sha256: sha256File(output),
      font: fontFile,
      fontSha256: sha256File(fontFile),
      text,
    }, null, 2));
  }
} catch (error) {
  fail(error.message);
}
