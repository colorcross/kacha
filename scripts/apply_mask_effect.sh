#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  apply_mask_effect.sh INPUT_VIDEO MASK_VIDEO OUTPUT.mov MODE

MODE:
  face-light     Mild local face brightening and gamma lift
  skin-soften    Mild luma-only bilateral smoothing inside the mask
  privacy-blur   Strong Gaussian blur inside the mask

The mask must match the input duration, frame rate and start PTS within one
frame. White applies the effect; black preserves the original. Any mismatch
fails closed. The output is a high-quality ProRes 422 HQ intermediate.
Use apply_beauty_v2.sh for beauty processing.
EOF
}

[[ $# -eq 4 ]] || { usage >&2; exit 2; }

input=$1
mask=$2
output=$3
mode=$4

[[ -f "$input" ]] || { printf 'Input not found: %s\n' "$input" >&2; exit 2; }
[[ -f "$mask" ]] || { printf 'Mask not found: %s\n' "$mask" >&2; exit 2; }
[[ ! -e "$output" ]] || { printf 'Output already exists: %s\n' "$output" >&2; exit 2; }
command -v ffmpeg >/dev/null || { printf '%s\n' "ffmpeg is required" >&2; exit 2; }
command -v ffprobe >/dev/null || { printf '%s\n' "ffprobe is required" >&2; exit 2; }
command -v node >/dev/null || { printf '%s\n' "node is required" >&2; exit 2; }

input_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$input")
mask_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$mask")
output_resolved=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$output")
[[ "$output_resolved" != "$input_resolved" && "$output_resolved" != "$mask_resolved" ]] || {
  printf '%s\n' "Refusing to overwrite an input file" >&2
  exit 2
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node "$script_dir/assert_media_alignment.mjs" \
  "$input" "$mask" \
  --allow-size-mismatch \
  --duration-tolerance-frames 1 >/dev/null

width=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$input")
height=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$input")
duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$input")
[[ "$duration" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
  printf '%s\n' "Could not determine input duration" >&2
  exit 2
}

case "$mode" in
  face-light)
    effect="eq=brightness=0.018:gamma=1.025:saturation=1.01"
    mask_blur="gblur=sigma=18"
    ;;
  skin-soften)
    effect="bilateral=sigmaS=1.6:sigmaR=0.035:planes=1"
    mask_blur="gblur=sigma=14"
    ;;
  privacy-blur)
    effect="gblur=sigma=28"
    mask_blur="gblur=sigma=8"
    ;;
  *)
    printf 'Unsupported mode: %s\n' "$mode" >&2
    usage >&2
    exit 2
    ;;
esac

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/kacha-mask-effect.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
temporary_output="$work_dir/output.mov"

ffmpeg -hide_banner -loglevel error -nostdin -y \
  -i "$input" \
  -i "$mask" \
  -filter_complex "
    [0:v]setpts=PTS-STARTPTS,split=2[base][effect_source];
    [effect_source]${effect}[effected];
    [1:v]setpts=PTS-STARTPTS,scale=${width}:${height}:flags=bilinear,format=gray,${mask_blur}[soft_mask];
    [base][effected][soft_mask]maskedmerge[outv]
  " \
  -map "[outv]" -map 0:a? \
  -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le \
  -c:a copy -t "$duration" \
  "$temporary_output"

node "$script_dir/assert_media_alignment.mjs" \
  "$input" "$temporary_output" \
  --duration-tolerance-frames 1 >/dev/null
mkdir -p "$(dirname "$output")"
mv -f "$temporary_output" "$output"

printf '%s\n' "$output"
