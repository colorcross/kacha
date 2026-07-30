#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileIdentity,
  readJson,
  run,
  sha256File,
  sha256Value,
  writeJsonAtomic,
} from "./kacha_utils.mjs";
import { loadKachaConfig } from "./kacha_config.mjs";
import { fingerprintPath } from "./model_fingerprint.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const args = process.argv.slice(2);
const worker = args.includes("--worker");
const positional = args.filter((item, index) => (
  !item.startsWith("--")
  && (index === 0 || !args[index - 1]?.startsWith("--"))
));

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function endpointHealth(endpoint) {
  const url = new URL(endpoint);
  url.pathname = "/health";
  url.search = "";
  const result = run("curl", [
    "-sS",
    "--fail-with-body",
    "--max-time",
    "5",
    url.toString(),
  ]);
  if (result.status !== 0) {
    throw new Error(
      `本地 Whisper 服务不可用：${
        [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
      }`,
    );
  }
  const health = JSON.parse(result.stdout);
  if (health.ffmpeg_available === false) {
    throw new Error(
      `本地 Whisper 服务的 FFmpeg 运行时不可用：${
        (health.ffmpeg_attempted ?? []).join(", ") || "未返回候选路径"
      }`,
    );
  }
  return health;
}

function collectPythonSources(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__pycache__") visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        files.push(absolute);
      }
    }
  };
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) visit(root);
  return files.sort();
}

function asrRuntimeIdentity(endpoint, health) {
  const modelPath = health.model_path ?? health.model;
  let model = null;
  try {
    if (modelPath && fs.existsSync(modelPath)) model = fingerprintPath(modelPath);
  } catch {
    model = null;
  }
  const url = new URL(endpoint);
  let service = null;
  if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    const listener = run("lsof", [
      "-tiTCP:" + (url.port || "80"),
      "-sTCP:LISTEN",
    ]);
    const pid = Number(listener.stdout.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) {
      const cwdProbe = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const cwd = cwdProbe.stdout.split(/\r?\n/)
        .find((line) => line.startsWith("n"))?.slice(1);
      const command = run("ps", ["-p", String(pid), "-o", "command="]).stdout.trim();
      if (cwd && fs.existsSync(cwd)) {
        const implementationFiles = [
          ...collectPythonSources(path.join(cwd, "src")),
          ...["pyproject.toml", "uv.lock"]
            .map((name) => path.join(cwd, name))
            .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile()),
        ];
        if (implementationFiles.length > 0) {
          const identities = implementationFiles.map((file) => ({
            path: file,
            sha256: sha256File(file),
          }));
          service = {
            pid,
            cwd,
            command,
            files: identities.length,
            sha256: sha256Value(identities),
            implementationFiles,
            implementationIdentities: identities,
          };
        }
      }
    }
  }
  if (!service && health.build_sha) {
    service = { sha256: String(health.build_sha), implementationFiles: [] };
  }
  return {
    model: model
      ? {
          path: model.path,
          kind: model.kind,
          files: model.files ?? 1,
          bytes: model.bytes ?? model.sizeBytes,
          sha256: model.sha256,
        }
      : null,
    service,
    healthSha256: sha256Value(health),
    cacheSafe: Boolean(model?.sha256 && service?.sha256),
  };
}

function prepareAsrAudio(input, config, audioStreamIndex) {
  const probe = run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index,channels,sample_rate",
    "-of",
    "json",
    input,
  ]);
  if (probe.status !== 0) {
    throw new Error(probe.stderr.trim() || "无法探测 ASR 输入音轨");
  }
  let audioStreams;
  try {
    audioStreams = JSON.parse(probe.stdout).streams ?? [];
  } catch (error) {
    throw new Error(`ASR 音轨探测结果无效：${error.message}`);
  }
  if (!Number.isInteger(audioStreamIndex) || !audioStreams[audioStreamIndex]) {
    throw new Error(
      `ASR 音轨 ${audioStreamIndex} 不存在；输入共有 ${audioStreams.length} 条音轨`,
    );
  }
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "kacha-asr-audio-"),
  );
  const normalizedAudio = path.join(temporaryDirectory, "normalized.wav");
  const extraction = run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    `0:a:${audioStreamIndex}`,
    "-vn",
    "-ac",
    String(config.normalizationChannels),
    "-ar",
    String(config.normalizationSampleRate),
    "-c:a",
    "pcm_s16le",
    normalizedAudio,
  ]);
  if (extraction.status !== 0) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new Error(extraction.stderr.trim() || "无法规范化 ASR 音轨");
  }
  const normalizedIdentity = fileIdentity(normalizedAudio);
  return {
    path: normalizedAudio,
    temporaryDirectory,
    evidence: {
      audioStreamIndex,
      sourceStreamIndex: audioStreams[audioStreamIndex].index,
      sourceChannels: Number(audioStreams[audioStreamIndex].channels ?? 0),
      sourceSampleRate: Number(audioStreams[audioStreamIndex].sample_rate ?? 0),
      outputChannels: config.normalizationChannels,
      outputSampleRate: config.normalizationSampleRate,
      codec: "pcm_s16le",
      sha256: normalizedIdentity.sha256,
      sizeBytes: normalizedIdentity.sizeBytes,
    },
  };
}

function normalizeResult(
  raw,
  input,
  health,
  config,
  runtimeIdentity,
  audioPreparation,
) {
  const thresholds = config.lowConfidence;
  const segments = (raw.segments ?? []).map((segment, index) => {
    const averageLogProbability = Number(segment.avg_logprob);
    const noSpeechProbability = Number(segment.no_speech_prob);
    const compressionRatio = Number(segment.compression_ratio);
    const reasons = [];
    if (
      Number.isFinite(averageLogProbability)
      && averageLogProbability < thresholds.averageLogProbabilityBelow
    ) {
      reasons.push("low_average_log_probability");
    }
    if (
      Number.isFinite(noSpeechProbability)
      && noSpeechProbability > thresholds.noSpeechProbabilityAbove
    ) {
      reasons.push("high_no_speech_probability");
    }
    if (
      Number.isFinite(compressionRatio)
      && compressionRatio > thresholds.compressionRatioAbove
    ) {
      reasons.push("high_compression_ratio");
    }
    return {
      id: `segment-${String(index + 1).padStart(4, "0")}`,
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? 0),
      text: String(segment.text ?? "").trim(),
      averageLogProbability: Number.isFinite(averageLogProbability)
        ? averageLogProbability
        : null,
      noSpeechProbability: Number.isFinite(noSpeechProbability)
        ? noSpeechProbability
        : null,
      compressionRatio: Number.isFinite(compressionRatio)
        ? compressionRatio
        : null,
      confidence: reasons.length === 0 ? "normal" : "low",
      reasons,
      words: (segment.words ?? []).map((word) => ({
        start: Number(word.start ?? 0),
        end: Number(word.end ?? 0),
        word: String(word.word ?? ""),
        probability: Number.isFinite(Number(word.probability))
          ? Number(word.probability)
          : null,
      })),
    };
  });
  const lowConfidenceSegmentIds = segments
    .filter((segment) => segment.confidence === "low")
    .map((segment) => segment.id);
  const report = {
    schemaVersion: "1.0",
    status: lowConfidenceSegmentIds.length > 0 ? "pass_with_review" : "pass",
    generatedAt: new Date().toISOString(),
    provider: "local_whisper_mlx",
    model: {
      repository: health.model_repo ?? null,
      reference: health.model ?? null,
      contentSha256: runtimeIdentity.model?.sha256 ?? null,
      serviceSha256: runtimeIdentity.service?.sha256 ?? null,
    },
    input: fileIdentity(input),
    language: raw.language ?? null,
    durationSeconds: Number(raw.duration ?? segments.at(-1)?.end ?? 0),
    text: String(raw.text ?? "").trim(),
    segments,
    review: {
      lowConfidenceSegmentIds,
      lowConfidenceCount: lowConfidenceSegmentIds.length,
      policy: "模型只读取低置信度片段和语义 cue；完整逐词数据留在本文件",
    },
    provenance: {
      externalUpload: false,
      endpointScope: "loopback_only",
      wordTimestamps: config.wordTimestamps,
      conditionOnPreviousText: config.conditionOnPreviousText,
      audioPreparation,
      implementation: {
        client: fileIdentity(scriptFile),
        healthSha256: runtimeIdentity.healthSha256,
        model: runtimeIdentity.model,
        service: runtimeIdentity.service
          ? {
              cwd: runtimeIdentity.service.cwd ?? null,
              sha256: runtimeIdentity.service.sha256,
              files: runtimeIdentity.service.implementationIdentities ?? [],
            }
          : null,
      },
    },
  };
  report.digest = sha256Value({ ...report, digest: undefined });
  return report;
}

const inputValue = worker ? option("--input") : positional[0];
const outputValue = option("--output");
if (!inputValue || !outputValue) {
  fail(
    "用法：kacha.mjs transcribe INPUT --output TRANSCRIPT.json "
      + "[--language auto|zh|en] [--audio-stream N] "
      + "[--prompt MANUSCRIPT.txt] [--project-root DIR]",
    2,
  );
}
const input = path.resolve(inputValue);
const output = path.resolve(outputValue);
if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
  fail(`转写输入不存在：${input}`, 2);
}
const promptFile = option("--prompt");
if (
  promptFile
  && (!fs.existsSync(path.resolve(promptFile)) || !fs.statSync(path.resolve(promptFile)).isFile())
) {
  fail(`原始文稿不存在：${path.resolve(promptFile)}`, 2);
}
let loaded;
try {
  loaded = loadKachaConfig({
    args,
    anchorPath: input,
    includeSecrets: false,
  });
} catch (error) {
  fail(`配置无效：${error.message}`, 2);
}
const asr = loaded.config.execution.asr;
const audioStreamIndex = Number(option("--audio-stream", asr.audioStreamIndex));
if (!Number.isInteger(audioStreamIndex) || audioStreamIndex < 0) {
  fail("--audio-stream 必须是非负整数", 2);
}
const endpoint = loaded.config.tools.whisperEndpoint;
let health;
try {
  health = endpointHealth(endpoint);
} catch (error) {
  fail(error.message, 3);
}
const runtimeIdentity = asrRuntimeIdentity(endpoint, health);

if (worker) {
  let preparedAudio;
  try {
    preparedAudio = prepareAsrAudio(input, asr, audioStreamIndex);
  } catch (error) {
    fail(error.message);
  }
  const curlArgs = [
    "-sS",
    "--fail-with-body",
    "--max-time",
    String(asr.timeoutSeconds),
    "-F",
    `file=@${preparedAudio.path}`,
    "-F",
    `response_format=${asr.responseFormat}`,
    "-F",
    `word_timestamps=${asr.wordTimestamps}`,
    "-F",
    "timestamp_granularities[]=word",
    "-F",
    `temperature=${asr.temperature}`,
    "-F",
    `condition_on_previous_text=${asr.conditionOnPreviousText}`,
  ];
  const language = option("--language", asr.language);
  if (language !== "auto") curlArgs.push("-F", `language=${language}`);
  if (promptFile) {
    const prompt = fs.readFileSync(path.resolve(promptFile), "utf8").slice(0, 4000);
    if (prompt.trim()) curlArgs.push("-F", `prompt=${prompt}`);
  }
  curlArgs.push(endpoint);
  const result = run("curl", curlArgs);
  const audioPreparation = preparedAudio.evidence;
  fs.rmSync(preparedAudio.temporaryDirectory, { recursive: true, force: true });
  if (result.status !== 0) {
    fail(
      [result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join("\n")
      || "本地 Whisper 转写失败",
    );
  }
  let raw;
  try {
    raw = JSON.parse(result.stdout);
  } catch (error) {
    fail(`Whisper 响应不是有效 JSON：${error.message}`);
  }
  const normalized = normalizeResult(
    raw,
    input,
    health,
    asr,
    runtimeIdentity,
    audioPreparation,
  );
  writeJsonAtomic(output, normalized);
  console.log(JSON.stringify({
    status: normalized.status,
    output,
    segments: normalized.segments.length,
    lowConfidenceSegments: normalized.review.lowConfidenceCount,
  }, null, 2));
  process.exit(0);
}

const projectRoot = path.resolve(option("--project-root", path.dirname(output)));
const workerConfigurationArguments = [
  ...(option("--config")
    ? ["--config", path.resolve(option("--config"))]
    : []),
  ...(option("--secrets")
    ? ["--secrets", path.resolve(option("--secrets"))]
    : []),
];
const parameters = {
  provider: asr.provider,
  model: health.model_repo ?? health.model,
  modelContentSha256: runtimeIdentity.model?.sha256 ?? null,
  serviceImplementationSha256: runtimeIdentity.service?.sha256 ?? null,
  healthSha256: runtimeIdentity.healthSha256,
  language: option("--language", asr.language),
  responseFormat: asr.responseFormat,
  wordTimestamps: asr.wordTimestamps,
  temperature: asr.temperature,
  conditionOnPreviousText: asr.conditionOnPreviousText,
  audioStreamIndex,
  normalizationSampleRate: asr.normalizationSampleRate,
  normalizationChannels: asr.normalizationChannels,
  lowConfidence: asr.lowConfidence,
  promptSha256: promptFile ? sha256File(path.resolve(promptFile)) : null,
};
const cacheArguments = [
  path.join(scriptDirectory, "artifact_cache.mjs"),
  "run",
  "--project-root",
  projectRoot,
  "--kind",
  "asr",
  "--input",
  input,
  ...(promptFile ? ["--input", path.resolve(promptFile)] : []),
  "--implementation", scriptFile,
  ...((runtimeIdentity.service?.implementationFiles ?? [])
    .flatMap((file) => ["--implementation", file])),
  "--operation-version",
  "local-whisper-mlx-v3-normalized-audio",
  "--parameters",
  JSON.stringify(parameters),
  "--output",
  `transcript=${output}`,
  "--resource",
  "mps",
  "--",
  process.execPath,
  scriptFile,
  "--worker",
  "--input",
  input,
  "--output",
  output,
  "--language",
  option("--language", asr.language),
  "--audio-stream",
  String(audioStreamIndex),
  ...workerConfigurationArguments,
  ...(promptFile ? ["--prompt", path.resolve(promptFile)] : []),
];
const executionArguments = runtimeIdentity.cacheSafe
  ? cacheArguments
  : [
      scriptFile,
      "--worker",
      "--input",
      input,
      "--output",
      output,
      "--language",
      option("--language", asr.language),
      "--audio-stream",
      String(audioStreamIndex),
      ...workerConfigurationArguments,
      ...(promptFile ? ["--prompt", path.resolve(promptFile)] : []),
    ];
const cached = run(process.execPath, executionArguments);
if (cached.status !== 0) {
  fail(cached.stderr.trim() || cached.stdout.trim() || "缓存转写执行失败", cached.status);
}
const cacheResult = runtimeIdentity.cacheSafe
  ? JSON.parse(cached.stdout)
  : { cache: { status: "bypass", reason: "runtime_fingerprint_unresolved" } };
const transcript = readJson(output);
console.log(JSON.stringify({
  schemaVersion: "1.0",
  status: transcript.status,
  output,
  cache: cacheResult.cache,
  input: transcript.input,
  segments: transcript.segments.length,
  lowConfidenceSegments: transcript.review.lowConfidenceCount,
  textCharacters: [...transcript.text].length,
}, null, 2));
