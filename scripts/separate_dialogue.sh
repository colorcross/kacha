#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  separate_dialogue.sh INPUT OUTPUT_DIR [选项]

选项：
  --model NAME                 Demucs 模型，默认读取咔嚓配置
  --device DEVICE              auto/cpu/cuda/mps，默认读取咔嚓配置
  --max-duration-diff SECONDS  分离前后允许的最大时长差，默认读取咔嚓配置
  --project-root DIR           内容指纹缓存根目录，默认 OUTPUT_DIR 的上一级
  --no-cache                   内部/诊断用：绕过内容指纹缓存
  --config FILE                显式咔嚓配置；默认读取用户/项目配置
  -h, --help

输出：
  original_reference.wav
  dialogue_isolated.wav
  non_dialogue_residual.wav
  separation-report.json

本脚本只生成需要同响度 A/B 的分离候选，不自动宣告人声验收通过。
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi
if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -lt 2 ]]; then
  usage >&2
  exit 2
fi

input=$1
output_dir=$2
shift 2

model=""
device=""
max_duration_diff=""
config_file=""
project_root=""
no_cache=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      model=${2:?--model 缺少参数}
      shift 2
      ;;
    --device)
      device=${2:?--device 缺少参数}
      shift 2
      ;;
    --max-duration-diff)
      max_duration_diff=${2:?--max-duration-diff 缺少参数}
      shift 2
      ;;
    --config)
      config_file=${2:?--config 缺少参数}
      shift 2
      ;;
    --project-root)
      project_root=${2:?--project-root 缺少参数}
      shift 2
      ;;
    --no-cache)
      no_cache=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ffmpeg_bin=${KACHA_FFMPEG_BIN:-}
if [[ -z "$ffmpeg_bin" && -x /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg ]]; then
  ffmpeg_bin=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
fi
if [[ -z "$ffmpeg_bin" ]]; then ffmpeg_bin=$(command -v ffmpeg || true); fi
ffprobe_bin=${KACHA_FFPROBE_BIN:-}
if [[ -z "$ffprobe_bin" && -n "$ffmpeg_bin" && -x "$(dirname "$ffmpeg_bin")/ffprobe" ]]; then
  ffprobe_bin="$(dirname "$ffmpeg_bin")/ffprobe"
fi
if [[ -z "$ffprobe_bin" ]]; then ffprobe_bin=$(command -v ffprobe || true); fi
if [[ -z "$ffmpeg_bin" || ! -x "$ffmpeg_bin" ]]; then
  echo "缺少可执行的 ffmpeg 运行时。" >&2
  exit 3
fi
if ! "$ffmpeg_bin" -version >/dev/null 2>&1; then
  echo "ffmpeg 运行时存在但无法启动。" >&2
  exit 3
fi
if [[ -z "$ffprobe_bin" || ! -x "$ffprobe_bin" ]]; then
  echo "缺少可执行的 ffprobe 运行时。" >&2
  exit 3
fi
if ! "$ffprobe_bin" -version >/dev/null 2>&1; then
  echo "ffprobe 运行时存在但无法启动。" >&2
  exit 3
fi
export KACHA_FFMPEG_BIN="$ffmpeg_bin"
export KACHA_FFPROBE_BIN="$ffprobe_bin"
export PATH="$(dirname "$ffmpeg_bin"):$PATH"

for command_name in node jq shasum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少必需命令：$command_name" >&2
    exit 3
  fi
done

if [[ ! -f "$input" ]]; then
  echo "输入文件不存在：$input" >&2
  exit 4
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
config_args=(
  "$script_dir/kacha_config.mjs"
  get
  --key execution.sourceSeparation
  --anchor "$input"
  --output json
  --no-secrets
)
if [[ -n "$config_file" ]]; then
  config_args+=(--config "$config_file")
fi
if ! separation_config=$(node "${config_args[@]}"); then
  echo "无法读取咔嚓人声分离配置。" >&2
  exit 2
fi
model=${model:-$(printf '%s' "$separation_config" | jq -er '.model')}
device=${device:-$(printf '%s' "$separation_config" | jq -er '.device')}
max_duration_diff=${max_duration_diff:-$(printf '%s' "$separation_config" | jq -er '.maxDurationDiffSeconds')}

runner=()
engine=""
runtime_launcher=""
runtime_python=""
managed_data_root=${XDG_DATA_HOME:-"${HOME}/.local/share"}
tool_config_args=(
  "$script_dir/kacha_config.mjs"
  get
  --key tools.demucsBin
  --anchor "$input"
  --no-secrets
)
if [[ -n "$config_file" ]]; then
  tool_config_args+=(--config "$config_file")
fi
configured_demucs_bin=$(node "${tool_config_args[@]}" 2>/dev/null || true)
managed_demucs_bin=${KACHA_DEMUCS_BIN:-${configured_demucs_bin:-"$managed_data_root/kacha/demucs-venv/bin/demucs"}}
legacy_managed_demucs_bin="$managed_data_root/kacha-kacha/demucs-venv/bin/demucs"
if [[ -x "$managed_demucs_bin" ]] && "$managed_demucs_bin" --help >/dev/null 2>&1; then
  runner=("$managed_demucs_bin")
  engine="kacha-managed-demucs"
  runtime_launcher="$managed_demucs_bin"
  runtime_python="$(dirname "$managed_demucs_bin")/python"
elif [[ -z "${KACHA_DEMUCS_BIN:-}" ]] \
  && [[ -x "$legacy_managed_demucs_bin" ]] \
  && "$legacy_managed_demucs_bin" --help >/dev/null 2>&1; then
  runner=("$legacy_managed_demucs_bin")
  managed_demucs_bin="$legacy_managed_demucs_bin"
  engine="kacha-managed-demucs-legacy-path"
  runtime_launcher="$legacy_managed_demucs_bin"
  runtime_python="$(dirname "$legacy_managed_demucs_bin")/python"
elif command -v demucs >/dev/null 2>&1 && demucs --help >/dev/null 2>&1; then
  runtime_launcher=$(command -v demucs)
  runner=("$runtime_launcher")
  engine="demucs-command"
  runtime_python="$(dirname "$runtime_launcher")/python"
elif command -v python3 >/dev/null 2>&1 \
  && python3 -m demucs --help >/dev/null 2>&1; then
  runtime_python=$(command -v python3)
  runner=("$runtime_python" -m demucs)
  engine="python3-module-demucs"
else
  echo "缺少真实人声分离引擎 Demucs。请先通过 capability_probe.sh --profile voice。" >&2
  echo "FFmpeg dialoguenhance、中心声道提取和普通降噪不能冒充人声分离。" >&2
  exit 5
fi

if [[ ! -x "$runtime_python" ]] && command -v python3 >/dev/null 2>&1; then
  runtime_python=$(command -v python3)
fi
runtime_demucs_version="unknown"
runtime_torch_version="unknown"
runtime_demucs_module=""
runtime_demucs_entry_module=""
if [[ -x "$runtime_python" ]]; then
  runtime_probe=$(
    "$runtime_python" -c \
      'import importlib.metadata as m, demucs, demucs.separate, torch; print("\t".join((m.version("demucs"), str(getattr(torch, "__version__", "unknown")), str(demucs.__file__ or ""), str(demucs.separate.__file__ or ""))))' \
      2>/dev/null || true
  )
  if [[ -n "$runtime_probe" ]]; then
    IFS=$'\t' read -r runtime_demucs_version runtime_torch_version \
      runtime_demucs_module runtime_demucs_entry_module <<< "$runtime_probe"
  fi
fi
runtime_fingerprint="demucs=${runtime_demucs_version};torch=${runtime_torch_version}"
model_cache_root=""
model_cache_base=${XDG_CACHE_HOME:-"${HOME}/.cache"}
if [[ -d "$model_cache_base/huggingface/hub/models--adefossez--HTDemucs" ]]; then
  model_cache_root="$model_cache_base/huggingface/hub/models--adefossez--HTDemucs"
elif [[ -d "$model_cache_base/torch/hub/checkpoints" ]]; then
  model_cache_root="$model_cache_base/torch/hub/checkpoints"
fi
runtime_model_sha=""
if [[ -n "$model_cache_root" ]]; then
  runtime_model_sha=$(
    node "$script_dir/model_fingerprint.mjs" "$model_cache_root" \
      | jq -er '.sha256' 2>/dev/null || true
  )
fi
if [[ -z "$runtime_model_sha" && "$no_cache" != true ]]; then
  echo "无法冻结 Demucs 权重内容指纹，本次分离将绕过缓存。" >&2
  no_cache=true
fi
runtime_fingerprint="${runtime_fingerprint};model_sha=${runtime_model_sha:-unresolved}"
cache_implementation_args=(--implementation "${BASH_SOURCE[0]}")
if [[ -f "$runtime_launcher" ]]; then
  cache_implementation_args+=(--implementation "$runtime_launcher")
fi
if [[ -f "$runtime_demucs_module" ]]; then
  cache_implementation_args+=(--implementation "$runtime_demucs_module")
fi
if [[ -f "$runtime_demucs_entry_module" ]]; then
  cache_implementation_args+=(--implementation "$runtime_demucs_entry_module")
fi

if [[ "$no_cache" != true ]]; then
  project_root=${project_root:-$(dirname "$output_dir")}
  separation_resource=mps
  if [[ "$device" == "cpu" ]]; then
    separation_resource=cpuHeavy
  fi
  cache_parameters=$(jq -cn \
    --arg model "$model" \
    --arg device "$device" \
    --arg maxDurationDiffSeconds "$max_duration_diff" \
    --arg engine "$engine" \
    --arg runtimeFingerprint "$runtime_fingerprint" \
    --arg modelContentSha256 "$runtime_model_sha" \
    '{
      model:$model,
      device:$device,
      maxDurationDiffSeconds:($maxDurationDiffSeconds|tonumber),
      engine:$engine,
      runtimeFingerprint:$runtimeFingerprint,
      modelContentSha256:$modelContentSha256
    }')
  cache_command=(
    node "$script_dir/artifact_cache.mjs" run
    --project-root "$project_root"
    --kind source_separation
    --input "$input"
    "${cache_implementation_args[@]}"
    --operation-version "demucs-two-stems-v2"
    --parameters "$cache_parameters"
    --output "reference=$output_dir/original_reference.wav"
    --output "dialogue=$output_dir/dialogue_isolated.wav"
    --output "residual=$output_dir/non_dialogue_residual.wav"
    --output "report=$output_dir/separation-report.json"
    --resource "$separation_resource"
    --
    bash "${BASH_SOURCE[0]}" "$input" "$output_dir"
    --model "$model"
    --device "$device"
    --max-duration-diff "$max_duration_diff"
    --no-cache
  )
  if [[ -n "$config_file" ]]; then
    cache_command=(node "$script_dir/artifact_cache.mjs" run
      --project-root "$project_root"
      --config "$config_file"
      --kind source_separation
      --input "$input"
      "${cache_implementation_args[@]}"
      --operation-version "demucs-two-stems-v2"
      --parameters "$cache_parameters"
      --output "reference=$output_dir/original_reference.wav"
      --output "dialogue=$output_dir/dialogue_isolated.wav"
      --output "residual=$output_dir/non_dialogue_residual.wav"
      --output "report=$output_dir/separation-report.json"
      --resource "$separation_resource"
      --
      bash "${BASH_SOURCE[0]}" "$input" "$output_dir"
      --model "$model"
      --device "$device"
      --max-duration-diff "$max_duration_diff"
      --config "$config_file"
      --no-cache)
  fi
  "${cache_command[@]}"
  exit $?
fi

mkdir -p "$output_dir"
original_output="$output_dir/original_reference.wav"
dialogue_output="$output_dir/dialogue_isolated.wav"
residual_output="$output_dir/non_dialogue_residual.wav"
report_output="$output_dir/separation-report.json"

for target in "$original_output" "$dialogue_output" "$residual_output" "$report_output"; do
  if [[ -e "$target" ]]; then
    echo "拒绝覆盖已有文件：$target" >&2
    exit 6
  fi
done

work_dir=$(mktemp -d)
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

demucs_args=(--two-stems vocals -n "$model" -o "$work_dir" --float32)
resolved_device=$device
if [[ "$resolved_device" == "auto" && "$engine" == kacha-managed-demucs* ]]; then
  managed_python="$(dirname "$managed_demucs_bin")/python"
  if [[ -x "$managed_python" ]] \
    && "$managed_python" -c "import torch,sys; sys.exit(0 if torch.backends.mps.is_available() else 1)"; then
    resolved_device="mps"
  fi
fi
if [[ "$resolved_device" != "auto" ]]; then
  demucs_args+=(-d "$resolved_device")
fi
"${runner[@]}" "${demucs_args[@]}" "$input"

vocal_candidates=()
residual_candidates=()
while IFS= read -r -d '' candidate; do
  vocal_candidates+=("$candidate")
done < <(find "$work_dir" -type f -name vocals.wav -print0)
while IFS= read -r -d '' candidate; do
  residual_candidates+=("$candidate")
done < <(find "$work_dir" -type f -name no_vocals.wav -print0)

if [[ ${#vocal_candidates[@]} -ne 1 || ${#residual_candidates[@]} -ne 1 ]]; then
  echo "分离引擎没有生成唯一的 vocals/no_vocals 结果。" >&2
  exit 7
fi

source_duration=$("$ffprobe_bin" -v error -show_entries format=duration -of default=nw=1:nk=1 "$input")
dialogue_duration=$("$ffprobe_bin" -v error -show_entries format=duration -of default=nw=1:nk=1 "${vocal_candidates[0]}")
residual_duration=$("$ffprobe_bin" -v error -show_entries format=duration -of default=nw=1:nk=1 "${residual_candidates[0]}")

duration_check=$(awk -v source="$source_duration" -v dialogue="$dialogue_duration" \
  -v residual="$residual_duration" -v tolerance="$max_duration_diff" \
  'BEGIN {
    d1 = source - dialogue; if (d1 < 0) d1 = -d1;
    d2 = source - residual; if (d2 < 0) d2 = -d2;
    print (d1 <= tolerance && d2 <= tolerance) ? "pass" : "fail";
  }')
if [[ "$duration_check" != "pass" ]]; then
  echo "分离前后时长差超过允许值 ${max_duration_diff}s。" >&2
  exit 8
fi

normalize_audio() {
  local source_file=$1
  local output_file=$2
  "$ffmpeg_bin" -v error -i "$source_file" -map 0:a:0 \
    -af "aresample=48000:async=0:first_pts=0,apad=whole_dur=${source_duration},atrim=0:${source_duration}" \
    -c:a pcm_s24le "$output_file"
}

normalize_audio "$input" "$original_output"
normalize_audio "${vocal_candidates[0]}" "$dialogue_output"
normalize_audio "${residual_candidates[0]}" "$residual_output"

input_hash=$(shasum -a 256 "$input" | awk '{print $1}')
dialogue_hash=$(shasum -a 256 "$dialogue_output" | awk '{print $1}')
residual_hash=$(shasum -a 256 "$residual_output" | awk '{print $1}')

jq -n \
  --arg schemaVersion "1.0" \
  --arg status "candidate_requires_ab" \
  --arg engine "$engine" \
  --arg model "$model" \
  --arg runtimeFingerprint "$runtime_fingerprint" \
  --arg modelContentSha256 "$runtime_model_sha" \
  --arg device "$resolved_device" \
  --arg input "$input" \
  --arg inputSha256 "$input_hash" \
  --arg dialogueSha256 "$dialogue_hash" \
  --arg residualSha256 "$residual_hash" \
  --argjson durationSeconds "$source_duration" \
  --argjson sampleRate 48000 \
  --arg maxDurationDiffSeconds "$max_duration_diff" \
  '{
    schemaVersion: $schemaVersion,
    status: $status,
    engine: $engine,
    model: $model,
    runtime: {
      fingerprint: $runtimeFingerprint,
      modelContentSha256: $modelContentSha256
    },
    device: $device,
    input: {
      path: $input,
      sha256: $inputSha256,
      durationSeconds: $durationSeconds
    },
    outputs: {
      originalReference: "original_reference.wav",
      dialogueIsolated: {
        path: "dialogue_isolated.wav",
        sha256: $dialogueSha256
      },
      nonDialogueResidual: {
        path: "non_dialogue_residual.wav",
        sha256: $residualSha256
      },
      sampleRate: $sampleRate
    },
    alignment: {
      maxDurationDiffSeconds: ($maxDurationDiffSeconds | tonumber),
      status: "pass"
    },
    acceptance: {
      requiresLoudnessMatchedAB: true,
      requiresResidualSpeechLeakCheck: true,
      approved: false
    }
  }' > "$report_output"

printf 'CANDIDATE %s\n' "$dialogue_output"
printf 'RESIDUAL  %s\n' "$residual_output"
printf 'REFERENCE %s\n' "$original_output"
printf 'REPORT    %s\n' "$report_output"
