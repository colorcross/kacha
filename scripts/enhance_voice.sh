#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  enhance_voice.sh INPUT OUTPUT.wav [options]

Options:
  --preset natural|warm|warm-soft|clear
                                  Voice tone preset (default: Kacha config)
  --denoise off|light|medium     Spectral denoise strength (default: Kacha config)
  --declick                      Enable conservative click/mouth-noise repair
  --neural-model PATH            Optional trusted FFmpeg arnndn model
  --target-lufs NUMBER           Integrated loudness target (default: Kacha config)
  --true-peak NUMBER             True-peak ceiling in dBTP (default: Kacha config)
  --channel-mode preserve|mono|stereo
                                  Preserve source channels by default
  --config FILE                   Explicit Kacha config; user/project config by default

  The output is 48 kHz, 24-bit PCM WAV. Channel layout is preserved unless
  --channel-mode explicitly requests mono or stereo. This script is for a
  dialogue stem, not an already mixed voice/BGM/SFX master, and never changes
  timing.
EOF
}

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

input=$1
output=$2
shift 2

preset=""
denoise=""
declick=""
neural_model=""
target_lufs=""
true_peak=""
channel_mode=""
config_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)
      preset=${2:?missing preset}
      shift 2
      ;;
    --denoise)
      denoise=${2:?missing denoise mode}
      shift 2
      ;;
    --declick)
      declick="true"
      shift
      ;;
    --neural-model)
      neural_model=${2:?missing model path}
      shift 2
      ;;
    --target-lufs)
      target_lufs=${2:?missing LUFS target}
      shift 2
      ;;
    --true-peak)
      true_peak=${2:?missing true-peak target}
      shift 2
      ;;
    --channel-mode)
      channel_mode=${2:?missing channel mode}
      shift 2
      ;;
    --config)
      config_file=${2:?missing config path}
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -f "$input" ]] || { printf 'Input not found: %s\n' "$input" >&2; exit 2; }
[[ ! -e "$output" ]] || { printf 'Output already exists: %s\n' "$output" >&2; exit 2; }
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
[[ -n "$ffmpeg_bin" ]] || { printf 'ffmpeg is required\n' >&2; exit 2; }
[[ -n "$ffprobe_bin" ]] || { printf 'ffprobe is required\n' >&2; exit 2; }
command -v jq >/dev/null || { printf 'jq is required\n' >&2; exit 2; }
command -v node >/dev/null || { printf 'node is required\n' >&2; exit 2; }
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
config_args=(
  "$script_dir/kacha_config.mjs"
  get
  --key execution.voiceEnhancement
  --anchor "$input"
  --output json
  --no-secrets
)
if [[ -n "$config_file" ]]; then
  config_args+=(--config "$config_file")
fi
if ! voice_config=$(node "${config_args[@]}"); then
  printf '%s\n' "Could not load Kacha voice configuration" >&2
  exit 2
fi
preset=${preset:-$(printf '%s' "$voice_config" | jq -er '.preset')}
denoise=${denoise:-$(printf '%s' "$voice_config" | jq -er '.denoise')}
declick=${declick:-$(printf '%s' "$voice_config" | jq -r '.declick')}
target_lufs=${target_lufs:-$(printf '%s' "$voice_config" | jq -er '.targetLufs')}
true_peak=${true_peak:-$(printf '%s' "$voice_config" | jq -er '.truePeakDbtp')}
channel_mode=${channel_mode:-$(printf '%s' "$voice_config" | jq -er '.channelMode')}
input_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$input")
output_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$output")
[[ "$input_resolved" != "$output_resolved" ]] || {
  printf '%s\n' "Refusing to overwrite the input audio" >&2
  exit 2
}

case "$channel_mode" in
  preserve|mono|stereo) ;;
  *)
    printf 'Unsupported channel mode: %s\n' "$channel_mode" >&2
    exit 2
    ;;
esac

input_channels=$("$ffprobe_bin" -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$input" | head -n 1)
[[ "$input_channels" =~ ^[1-9][0-9]*$ ]] || {
  printf 'Could not determine input channel count\n' >&2
  exit 2
}
input_channel_layout=$("$ffprobe_bin" -v error -select_streams a:0 -show_entries stream=channel_layout -of csv=p=0 "$input" | head -n 1)

input_duration=$("$ffprobe_bin" -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "$input" | head -n 1)
if [[ ! "$input_duration" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  input_duration=$("$ffprobe_bin" -v error -show_entries format=duration -of csv=p=0 "$input" | head -n 1)
fi
[[ "$input_duration" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
  printf 'Could not determine input audio duration\n' >&2
  exit 2
}
duration_args=(-t "$input_duration")

deesser_filter="deesser=i=0.12:m=0.5:f=0.5"
compressor_filter="acompressor=threshold=0.12:ratio=1.8:attack=18:release=200:makeup=1"

case "$preset" in
  natural)
    tone_filters="equalizer=f=180:t=q:w=1:g=-1.0,equalizer=f=3200:t=q:w=1.2:g=0.8"
    ;;
  warm)
    tone_filters="equalizer=f=180:t=q:w=1:g=0.7,equalizer=f=3200:t=q:w=1.2:g=0.4,equalizer=f=7600:t=q:w=1.1:g=-0.6"
    ;;
  warm-soft)
    tone_filters="lowshelf=f=160:g=1.4,equalizer=f=280:t=q:w=0.8:g=2.0,equalizer=f=850:t=q:w=1.0:g=-1.5,equalizer=f=2500:t=q:w=1.05:g=-2.0,equalizer=f=3800:t=q:w=1.15:g=-1.5,highshelf=f=6500:g=-1.0"
    deesser_filter="deesser=i=0.14:m=0.35:f=0.5"
    compressor_filter="acompressor=threshold=0.10:ratio=1.5:attack=8:release=160:knee=4:makeup=1:mix=0.9"
    ;;
  clear)
    tone_filters="equalizer=f=180:t=q:w=1:g=-1.0,equalizer=f=420:t=q:w=0.85:g=-1.2,equalizer=f=3200:t=q:w=1.0:g=1.4,highshelf=f=7000:t=s:w=0.7:g=0.8"
    ;;
  *)
    printf 'Unsupported preset: %s\n' "$preset" >&2
    exit 2
    ;;
esac

case "$denoise" in
  off)
    denoise_filters=""
    ;;
  light)
    denoise_filters="afftdn=nr=5:nf=-28:tn=1:gs=6,"
    ;;
  medium)
    denoise_filters="afftdn=nr=9:nf=-32:tn=1:gs=10,"
    ;;
  *)
    printf 'Unsupported denoise mode: %s\n' "$denoise" >&2
    exit 2
    ;;
esac

neural_filter=""
if [[ -n "$neural_model" ]]; then
  [[ -f "$neural_model" ]] || { printf 'Neural model not found: %s\n' "$neural_model" >&2; exit 2; }
  # The model path is embedded into an ffmpeg filter string; characters with
  # filter-graph meaning (':' option separator, ',' chain separator, quotes and
  # escapes) would alter the filter, so reject them explicitly.
  case "$neural_model" in
    *:*|*,*|*\'*|*\"*|*\\*)
      printf 'Neural model path contains characters that are unsafe for ffmpeg filters: %s\n' "$neural_model" >&2
      exit 2
      ;;
  esac
  neural_filter="arnndn=m=${neural_model}:mix=0.88,"
fi

declick_filter=""
if [[ "$declick" == "true" ]]; then
  declick_filter="adeclick=window=55:overlap=75:arorder=2:threshold=2:burst=2:method=add,"
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/kacha-voice.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT

pre_master="$work_dir/pre-master.wav"
loudness_log="$work_dir/loudness.log"
loudness_json="$work_dir/loudness.json"
final_output="$work_dir/final.wav"

voice_chain="aformat=sample_fmts=fltp:sample_rates=48000,highpass=f=70,lowpass=f=15500,${neural_filter}${denoise_filters}${declick_filter}${tone_filters},${deesser_filter},${compressor_filter}"

channel_args=(-ac "$input_channels")
if [[ -n "$input_channel_layout" && "$input_channel_layout" != "unknown" ]]; then
  channel_args+=(-channel_layout "$input_channel_layout")
fi
expected_channels=$input_channels
case "$channel_mode" in
  mono)
    channel_args=(-ac 1 -channel_layout mono)
    expected_channels=1
    ;;
  stereo)
    channel_args=(-ac 2 -channel_layout stereo)
    expected_channels=2
    ;;
esac

"$ffmpeg_bin" -hide_banner -loglevel error -nostdin -y \
  -i "$input" \
  -map 0:a:0 \
  -af "$voice_chain" \
  "${duration_args[@]}" \
  -c:a pcm_s24le -ar 48000 "${channel_args[@]}" \
  "$pre_master"

"$ffmpeg_bin" -hide_banner -nostats -nostdin \
  -i "$pre_master" \
  -af "loudnorm=I=${target_lufs}:TP=${true_peak}:LRA=6:print_format=json" \
  -f null - 2>"$loudness_log"

sed -n '/^{/,/^}/p' "$loudness_log" >"$loudness_json"

measured_i=$(jq -r '.input_i' "$loudness_json")
gain_db=$(awk -v target="$target_lufs" -v measured="$measured_i" \
  'BEGIN { printf "%.6f", target - measured }')
limiter_linear=$(awk -v peak="$true_peak" \
  'BEGIN { printf "%.8f", exp(log(10) * peak / 20) }')

"$ffmpeg_bin" -hide_banner -loglevel error -nostdin -y \
  -i "$pre_master" \
  -af "volume=${gain_db}dB,alimiter=limit=${limiter_linear}:attack=5:release=80:level=false" \
  "${duration_args[@]}" \
  -c:a pcm_s24le -ar 48000 "${channel_args[@]}" \
  "$final_output"

output_duration=$("$ffprobe_bin" -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "$final_output" | head -n 1)
output_channels=$("$ffprobe_bin" -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$final_output" | head -n 1)
duration_delta=$(awk -v a="$input_duration" -v b="$output_duration" 'BEGIN { d=a-b; if (d<0) d=-d; print d }')
awk -v d="$duration_delta" 'BEGIN { exit !(d <= 0.0025) }' || {
  printf 'Output duration drifted by %ss\n' "$duration_delta" >&2
  exit 1
}
[[ "$output_channels" == "$expected_channels" ]] || {
  printf 'Output channels %s did not match expected %s\n' "$output_channels" "$expected_channels" >&2
  exit 1
}

mkdir -p "$(dirname "$output")"
mv -f "$final_output" "$output"

printf '%s\n' "$output"
